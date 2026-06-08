const express  = require('express');
const http      = require('http');
const WebSocket = require('ws');
const crypto    = require('crypto');
const path      = require('path');
const { MongoClient } = require('mongodb');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

const PORT      = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGODB_URI;       // Render 환경변수로 주입

// ── MongoDB 연결 ──────────────────────────────
let usersCol = null;   // users 컬렉션

async function connectDB() {
    if (usersCol) return usersCol;
    const client = new MongoClient(MONGO_URI);
    await client.connect();
    usersCol = client.db('십자게임').collection('users');
    // 유저네임에 고유 인덱스
    await usersCol.createIndex({ username: 1 }, { unique: true });
    console.log('✅ MongoDB 연결 성공');
    return usersCol;
}

app.use(express.json());
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'territory_game_online.html'));
});

app.get('/ping', (req, res) => {
    res.send('ok');
});

function hashPw(pw) {
    return crypto.createHash('sha256').update(pw + 'xgame_십자').digest('hex');
}

// ── HTTP API ──────────────────────────────────

app.post('/api/auth', async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password)
        return res.json({ ok: false, msg: '입력값을 확인해주세요' });
    if (username.length < 2 || username.length > 16)
        return res.json({ ok: false, msg: '유저네임은 2~16자여야 합니다' });
    if (password.length < 4)
        return res.json({ ok: false, msg: '비밀번호는 4자 이상이어야 합니다' });

    try {
        const col  = await connectDB();
        const hash = hashPw(password);
        const existing = await col.findOne({ username });

        if (!existing) {
            const newUser = { username, password: hash, rating: 1000, wins: 0, losses: 0, draws: 0 };
            await col.insertOne(newUser);
            return res.json({ ok: true, created: true,
                user: { username, rating: 1000, wins: 0, losses: 0, draws: 0 } });
        }

        if (existing.password !== hash)
            return res.json({ ok: false, msg: '유저네임이 이미 존재하거나 비밀번호가 틀렸습니다' });

        return res.json({ ok: true, created: false,
            user: { username, rating: existing.rating, wins: existing.wins,
                    losses: existing.losses, draws: existing.draws } });
    } catch (e) {
        console.error(e);
        return res.json({ ok: false, msg: '서버 오류가 발생했습니다' });
    }
});

app.get('/api/leaderboard', async (req, res) => {
    try {
        const col  = await connectDB();
        const list = await col
            .find({}, { projection: { password: 0, _id: 0 } })
            .sort({ rating: -1 })
            .limit(50)
            .toArray();
        res.json(list);
    } catch (e) {
        res.json([]);
    }
});

// ── WebSocket 게임 서버 ───────────────────────

const EMPTY = 0, P1 = 1, P2 = 2;
const N          = 16;
const TURN_TIME  = 20;

const waitingQueue      = [];
const games             = new Map();
const onlineUsers       = new Map();   // username → ws
const pendingChallenges = new Map();   // `${from}->${to}` → { fromWs, timer }

function send(ws, data) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function pts(board, r, c) {
    return [[-1,0],[1,0],[0,-1],[0,1]]
        .map(([dr,dc]) => [r+dr, c+dc])
        .filter(([nr,nc]) => nr >= 0 && nr < N && nc >= 0 && nc < N)
        .concat([[r, c]]);
}

function cnt(board) {
    let p1=0, p2=0, em=0;
    board.forEach(row => row.forEach(v => { if(v===P1)p1++; else if(v===P2)p2++; else em++; }));
    return { p1, p2, em };
}

function eloCalc(ra, rb, s) {
    return Math.round(ra + 32 * (s - 1 / (1 + Math.pow(10, (rb - ra) / 400))));
}

function clearTimer(game) {
    if (game.turnTimer) { clearTimeout(game.turnTimer); game.turnTimer = null; }
}

function startTimer(game) {
    clearTimer(game);
    game.turnTimer = setTimeout(() => {
        if (!game.ended) endGame(game, game.turn === P1 ? 'p2' : 'p1', 'timeout');
    }, TURN_TIME * 1000);
}

function broadcastTimer(game) {
    const msg = { type: 'turn_timer', seconds: TURN_TIME, forPlayer: game.turn };
    send(game.p1ws, msg);
    send(game.p2ws, msg);
}

async function endGame(game, result, reason) {
    if (game.ended) return;
    game.ended = true;
    clearTimer(game);

    const { p1, p2 } = cnt(game.board);
    let ratings = {};

    try {
        const col = await connectDB();
        const u1  = await col.findOne({ username: game.p1name });
        const u2  = await col.findOne({ username: game.p2name });

        if (u1 && u2) {
            const r1o = u1.rating || 1000, r2o = u2.rating || 1000;
            const [s1, s2] = result === 'p1' ? [1, 0] : result === 'p2' ? [0, 1] : [0.5, 0.5];
            const r1n = eloCalc(r1o, r2o, s1), r2n = eloCalc(r2o, r1o, s2);

            const inc1 = result === 'p1' ? { wins: 1 } : result === 'p2' ? { losses: 1 } : { draws: 1 };
            const inc2 = result === 'p2' ? { wins: 1 } : result === 'p1' ? { losses: 1 } : { draws: 1 };

            await col.updateOne({ username: game.p1name },
                { $set: { rating: r1n }, $inc: inc1 });
            await col.updateOne({ username: game.p2name },
                { $set: { rating: r2n }, $inc: inc2 });

            ratings = { r1old: r1o, r2old: r2o, r1new: r1n, r2new: r2n };

            // WS 캐시도 즉시 갱신 — 다음 매치에서 올바른 레이팅 표시
            game.p1ws.rating = r1n;
            game.p2ws.rating = r2n;
        }
    } catch (e) { console.error('endGame DB error', e); }

    const msg = { type: 'game_over', result, reason, p1, p2, ratings };
    send(game.p1ws, msg);
    send(game.p2ws, msg);
    game.p1ws.gameId = null;
    game.p2ws.gameId = null;
    games.delete(game.id);
}

function startGame(p1ws, p2ws) {
    [p1ws, p2ws].forEach(w => {
        const i = waitingQueue.indexOf(w);
        if (i !== -1) waitingQueue.splice(i, 1);
    });

    const gid   = Math.random().toString(36).substr(2, 8);
    const board = Array.from({ length: N }, () => new Array(N).fill(EMPTY));
    const game  = { id: gid, board, turn: P1, ended: false,
        p1ws, p2ws, p1name: p1ws.username, p2name: p2ws.username, turnTimer: null };
    games.set(gid, game);
    p1ws.gameId = gid;
    p2ws.gameId = gid;

    send(p1ws, { type: 'match_found', gameId: gid, playerNum: 1, N,
        opponent: p2ws.username, opponentRating: p2ws.rating });
    send(p2ws, { type: 'match_found', gameId: gid, playerNum: 2, N,
        opponent: p1ws.username, opponentRating: p1ws.rating });

    startTimer(game);
    broadcastTimer(game);
}

function cleanChallengesFor(username) {
    [...pendingChallenges.keys()].forEach(k => {
        if (!k.startsWith(username + '->') && !k.endsWith('->' + username)) return;
        const ch = pendingChallenges.get(k);
        clearTimeout(ch.timer);
        pendingChallenges.delete(k);
        if (k.endsWith('->' + username))
            send(ch.fromWs, { type: 'challenge_expired', to: username });
    });
}

wss.on('connection', ws => {
    ws.username = null;
    ws.gameId   = null;
    ws.rating   = 1000;

    ws.on('message', async raw => {
        let m; try { m = JSON.parse(raw); } catch { return; }

        if (m.type === 'auth') {
            ws.username = m.username;
            ws.rating   = m.rating || 1000;
            onlineUsers.set(m.username, ws);
            return send(ws, { type: 'auth_ok' });
        }
        if (!ws.username) return;

        if (m.type === 'join_queue') {
            if (ws.gameId) return;
            const i = waitingQueue.indexOf(ws);
            if (i !== -1) waitingQueue.splice(i, 1);
            waitingQueue.push(ws);
            send(ws, { type: 'waiting' });
            if (waitingQueue.length >= 2) startGame(waitingQueue.shift(), waitingQueue.shift());
            return;
        }

        if (m.type === 'leave_queue') {
            const i = waitingQueue.indexOf(ws);
            if (i !== -1) waitingQueue.splice(i, 1);
            return;
        }

        if (m.type === 'send_challenge') {
            if (ws.gameId)
                return send(ws, { type: 'challenge_result', ok: false, msg: '게임 중에는 초대할 수 없습니다' });
            if (m.to === ws.username)
                return send(ws, { type: 'challenge_result', ok: false, msg: '자기 자신에게는 초대할 수 없습니다' });
            const tws = onlineUsers.get(m.to);
            if (!tws)
                return send(ws, { type: 'challenge_result', ok: false, msg: '해당 유저가 온라인 상태가 아닙니다' });
            if (tws.gameId)
                return send(ws, { type: 'challenge_result', ok: false, msg: '해당 유저가 현재 게임 중입니다' });

            [...pendingChallenges.keys()]
                .filter(k => k.startsWith(ws.username + '->'))
                .forEach(k => { clearTimeout(pendingChallenges.get(k).timer); pendingChallenges.delete(k); });

            const key   = `${ws.username}->${m.to}`;
            const timer = setTimeout(() => {
                pendingChallenges.delete(key);
                send(ws, { type: 'challenge_expired', to: m.to });
            }, 30000);
            pendingChallenges.set(key, { fromWs: ws, timer });
            send(tws, { type: 'challenge_received', from: ws.username, fromRating: ws.rating });
            send(ws,  { type: 'challenge_result', ok: true, to: m.to });
            return;
        }

        if (m.type === 'respond_challenge') {
            const key = `${m.from}->${ws.username}`;
            const ch  = pendingChallenges.get(key);
            if (!ch) return send(ws, { type: 'error', msg: '초대가 만료되었습니다' });
            clearTimeout(ch.timer);
            pendingChallenges.delete(key);
            if (!m.accept) { send(ch.fromWs, { type: 'challenge_declined', by: ws.username }); return; }
            if (ws.gameId || ch.fromWs.gameId) {
                send(ws, { type: 'error', msg: '이미 게임 중입니다' });
                send(ch.fromWs, { type: 'challenge_declined', by: ws.username });
                return;
            }
            startGame(ch.fromWs, ws);
            return;
        }

        if (m.type === 'make_move') {
            const game = games.get(ws.gameId);
            if (!game || game.ended) return;
            const myNum = game.p1ws === ws ? P1 : P2;
            if (game.turn !== myNum) return;
            const { r, c } = m;
            if (typeof r !== 'number' || r < 0 || r >= N || c < 0 || c >= N) return;
            if (game.board[r][c] !== EMPTY) return;

            pts(game.board, r, c).forEach(([ar,ac]) => { game.board[ar][ac] = myNum; });
            game.turn = myNum === P1 ? P2 : P1;

            const { p1, p2, em } = cnt(game.board);
            const mv = { type: 'move_made', r, c, player: myNum,
                board: game.board, turn: game.turn, p1, p2, em };
            send(game.p1ws, mv);
            send(game.p2ws, mv);

            if (em === 0) {
                await endGame(game, p1 > p2 ? 'p1' : p2 > p1 ? 'p2' : 'draw', 'normal');
            } else {
                startTimer(game);
                broadcastTimer(game);
            }
            return;
        }

        if (m.type === 'forfeit') {
            const game = games.get(ws.gameId);
            if (!game || game.ended) return;
            const myNum = game.p1ws === ws ? P1 : P2;
            await endGame(game, myNum === P1 ? 'p2' : 'p1', 'forfeit');
            return;
        }
    });

    ws.on('close', () => {
        if (ws.username) {
            onlineUsers.delete(ws.username);
            cleanChallengesFor(ws.username);
        }
        const i = waitingQueue.indexOf(ws);
        if (i !== -1) waitingQueue.splice(i, 1);

        if (ws.gameId) {
            const game = games.get(ws.gameId);
            if (game && !game.ended) {
                const myNum = game.p1ws === ws ? P1 : P2;
                endGame(game, myNum === P1 ? 'p2' : 'p1', 'disconnect');
            }
        }
    });
});

// 포트 먼저 열고 DB는 백그라운드 연결 (Render 포트 스캔 타임아웃 방지)
server.listen(PORT, () => console.log(`✅ 서버 실행 중: http://localhost:${PORT}`));
connectDB()
    .catch(err => console.error('MongoDB 연결 실패:', err.message));
