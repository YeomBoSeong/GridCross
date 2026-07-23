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

// ── 이메일 알림 (일일 게임 차례 알림) ──
// Render 무료 플랜은 아웃바운드 SMTP 포트(25/465/587)를 차단하므로 Brevo HTTP API(HTTPS) 사용
const BREVO_API_KEY = process.env.BREVO_API_KEY;
const SENDER_EMAIL  = 'byeom059@gmail.com';
const SENDER_NAME   = '십자 땅따먹기';
const SITE_URL      = 'https://gridcrossgame.onrender.com/';
const EMAIL_RE      = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

if (!BREVO_API_KEY) {
    console.warn('⚠️ BREVO_API_KEY 미설정 — 일일 게임 이메일 알림 비활성화');
}

function normalizeEmail(email) {
    if (typeof email !== 'string') return null;
    const trimmed = email.trim();
    return EMAIL_RE.test(trimmed) ? trimmed : null;
}

async function sendTurnEmail(to, opponent) {
    if (!BREVO_API_KEY || !to) return;
    try {
        const res = await fetch('https://api.brevo.com/v3/smtp/email', {
            method: 'POST',
            headers: {
                'api-key': BREVO_API_KEY,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
            },
            body: JSON.stringify({
                sender: { name: SENDER_NAME, email: SENDER_EMAIL },
                to: [{ email: to }],
                subject: '⏳ 십자 땅따먹기 - 일일 게임 내 차례입니다',
                textContent: `${opponent}님과의 일일 게임에서 당신의 차례가 되었습니다.\n\n게임 확인하기: ${SITE_URL}`,
            }),
        });
        if (!res.ok) console.error('sendTurnEmail error:', res.status, await res.text());
    } catch (e) {
        console.error('sendTurnEmail error:', e.message);
    }
}

// ── MongoDB 연결 ──────────────────────────────
let usersCol   = null;   // users 컬렉션
let dailyCol   = null;   // dailyGames 컬렉션 (일일 게임 방 · 대국)
let historyCol = null;   // gameHistory 컬렉션 (게임 기록)

async function connectDB() {
    if (usersCol) return usersCol;
    const client = new MongoClient(MONGO_URI);
    await client.connect();
    usersCol   = client.db('십자게임').collection('users');
    dailyCol   = client.db('십자게임').collection('dailyGames');
    historyCol = client.db('십자게임').collection('gameHistory');
    // 유저네임에 고유 인덱스
    await usersCol.createIndex({ username: 1 }, { unique: true });
    await dailyCol.createIndex({ status: 1 });
    await historyCol.createIndex({ username: 1, createdAt: -1 });
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

// ── 서버 메시지 i18n ───────────────────────────
const MSG = {
    ko: {
        invalidInput: '입력값을 확인해주세요',
        usernameLen: '유저네임은 2~20자여야 합니다',
        passwordLen: '비밀번호는 4~20자여야 합니다',
        wrongCreds: '유저네임이 이미 존재하거나 비밀번호가 틀렸습니다',
        serverError: '서버 오류가 발생했습니다',
        badRequest: '잘못된 요청입니다',
        userNotFound: '유저를 찾을 수 없습니다',
        loginRequired: '로그인이 필요합니다',
        noPermission: '권한이 없습니다',
        alreadyWaitingRoom: '이미 대기 중인 방이 있습니다',
        maxActiveGames: n => `진행 중인 일일 게임은 최대 ${n}개까지 가능합니다`,
        cannotCancelRoom: '취소할 수 없는 방입니다',
        cannotJoinRoom: '참가할 수 없는 방입니다',
        cannotJoinOwnRoom: '자신이 만든 방에는 참가할 수 없습니다',
        alreadyJoinedByOther: '다른 사용자가 먼저 참가했습니다',
        noJoinableRooms: '참가할 수 있는 방이 없습니다',
        gameNotFound: '게임을 찾을 수 없습니다',
        notActiveGame: '진행 중인 게임이 아닙니다',
        notParticipant: '참가자가 아닙니다',
        notYourTurn: '내 차례가 아닙니다',
        invalidCoords: '잘못된 좌표입니다',
        cellFilled: '이미 채워진 칸입니다',
        staleRequest: '이미 처리된 요청입니다. 새로고침 해주세요',
        sameAccount: '같은 계정끼리는 대전할 수 없습니다',
        inGameCannotInvite: '게임 중에는 초대할 수 없습니다',
        cannotInviteSelf: '자기 자신에게는 초대할 수 없습니다',
        userNotOnline: '해당 유저가 온라인 상태가 아닙니다',
        userInGame: '해당 유저가 현재 게임 중입니다',
        inviteExpired: '초대가 만료되었습니다',
        alreadyInGame: '이미 게임 중입니다',
    },
    en: {
        invalidInput: 'Please check your input',
        usernameLen: 'Username must be 2-20 characters',
        passwordLen: 'Password must be 4-20 characters',
        wrongCreds: 'Username already exists or password is incorrect',
        serverError: 'A server error occurred',
        badRequest: 'Invalid request',
        userNotFound: 'User not found',
        loginRequired: 'Login required',
        noPermission: 'You do not have permission',
        alreadyWaitingRoom: 'You already have a room waiting',
        maxActiveGames: n => `You can have at most ${n} daily games in progress`,
        cannotCancelRoom: 'This room cannot be canceled',
        cannotJoinRoom: 'This room cannot be joined',
        cannotJoinOwnRoom: 'You cannot join a room you created',
        alreadyJoinedByOther: 'Another user already joined first',
        noJoinableRooms: 'No rooms available to join',
        gameNotFound: 'Game not found',
        notActiveGame: 'This game is not active',
        notParticipant: 'You are not a participant',
        notYourTurn: 'It is not your turn',
        invalidCoords: 'Invalid coordinates',
        cellFilled: 'This cell is already filled',
        staleRequest: 'This request was already processed. Please refresh',
        sameAccount: 'You cannot play against the same account',
        inGameCannotInvite: 'You cannot invite while in a game',
        cannotInviteSelf: 'You cannot invite yourself',
        userNotOnline: 'That user is not online',
        userInGame: 'That user is currently in a game',
        inviteExpired: 'The invite has expired',
        alreadyInGame: 'Already in a game',
    },
};
function tr(key, lang, ...args) {
    const dict = MSG[lang] || MSG.ko;
    const entry = dict[key] !== undefined ? dict[key] : MSG.ko[key];
    return typeof entry === 'function' ? entry(...args) : entry;
}
function reqLang(req) {
    return (req.body && req.body.lang === 'en') || req.query.lang === 'en' ? 'en' : 'ko';
}

// ── HTTP API ──────────────────────────────────

app.post('/api/auth', async (req, res) => {
    const lang = reqLang(req);
    const { username, password } = req.body || {};
    if (!username || !password)
        return res.json({ ok: false, msg: tr('invalidInput', lang) });
    if (username.length < 2 || username.length > 20)
        return res.json({ ok: false, msg: tr('usernameLen', lang) });
    if (password.length < 4 || password.length > 20)
        return res.json({ ok: false, msg: tr('passwordLen', lang) });

    try {
        const col  = await connectDB();
        const hash = hashPw(password);
        const existing = await col.findOne({ username });

        if (!existing) {
            const newUser = { username, password: hash, rating: 1000, wins: 0, losses: 0, draws: 0, aiWins: [] };
            await col.insertOne(newUser);
            return res.json({ ok: true, created: true,
                user: { username, rating: 1000, wins: 0, losses: 0, draws: 0, aiWins: [] } });
        }

        if (existing.password !== hash)
            return res.json({ ok: false, msg: tr('wrongCreds', lang) });

        return res.json({ ok: true, created: false,
            user: { username, rating: existing.rating, wins: existing.wins,
                    losses: existing.losses, draws: existing.draws, aiWins: existing.aiWins || [] } });
    } catch (e) {
        console.error(e);
        return res.json({ ok: false, msg: tr('serverError', lang) });
    }
});

app.get('/api/leaderboard', async (req, res) => {
    try {
        const col  = await connectDB();
        const list = await col
            .find({}, { projection: { password: 0, _id: 0 } })
            .sort({ rating: -1 })
            .toArray();
        res.json(list);
    } catch (e) {
        res.json([]);
    }
});

// ── AI 난이도 정복 기록 (LV.1~LV.7) ────────────
app.post('/api/ai/win', async (req, res) => {
    const lang = reqLang(req);
    const { username, level } = req.body || {};
    const lv = parseInt(level);
    if (!username || !Number.isInteger(lv) || lv < 1 || lv > 7)
        return res.json({ ok: false, msg: tr('badRequest', lang) });
    try {
        const col    = await connectDB();
        const result = await col.findOneAndUpdate(
            { username },
            { $addToSet: { aiWins: lv } },
            { returnDocument: 'after' }
        );
        if (!result) return res.json({ ok: false, msg: tr('userNotFound', lang) });
        res.json({ ok: true, aiWins: result.aiWins || [] });
    } catch (e) {
        console.error(e);
        res.json({ ok: false, msg: tr('serverError', lang) });
    }
});

app.get('/api/ai/conquerors', async (req, res) => {
    const lv = parseInt(req.query.level);
    if (!Number.isInteger(lv) || lv < 1 || lv > 7) return res.json([]);
    try {
        const col  = await connectDB();
        const list = await col
            .find({ aiWins: lv }, { projection: { password: 0, _id: 0 } })
            .sort({ rating: -1 })
            .toArray();
        // 유저가 정복한 가장 높은 난이도에서만 표시 (낮은 난이도 목록에는 중복 노출 안 함)
        const topOnly = list.filter(u => Math.max(...(u.aiWins || [lv])) === lv);
        res.json(topOnly);
    } catch (e) {
        res.json([]);
    }
});

// ── WebSocket 게임 서버 ───────────────────────

const EMPTY = 0, P1 = 1, P2 = 2;
const N          = 12;
const TURN_TIME  = 20;

const waitingQueue        = [];
const games               = new Map();
const onlineUsers         = new Map();   // username → ws
const pendingChallenges   = new Map();   // `${from}->${to}` → { fromWs, timer }
const recentlyEndedGames  = new Map();   // gameId → { msg, p1name, p2name } (60초간 재접속 결과 조회용)

function send(ws, data) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function notifyDaily(username, gameId, ended) {
    const tws = onlineUsers.get(username);
    if (tws) send(tws, { type: 'daily_notify', gameId, ended: !!ended });
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

// ── 포위 포획 (siege capture) ───────────────────
// board를 직접 변형하며, 뒤집힌 [r,c] 좌표 배열을 반환
function applyEnclosures(board, p) {
    const enemy = p === P1 ? P2 : P1;
    const visited = Array.from({ length: N }, () => new Array(N).fill(false));
    const toFlip = [];

    for (let r = 0; r < N; r++) {
        for (let c = 0; c < N; c++) {
            if (board[r][c] !== enemy || visited[r][c]) continue;

            const group = [];
            const queue = [[r, c]];
            let enclosed = true;
            const wallsHit = new Set();

            while (queue.length) {
                const [cr, cc] = queue.shift();
                if (visited[cr][cc]) continue;
                visited[cr][cc] = true;
                group.push([cr, cc]);

                for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]]) {
                    const nr = cr+dr, nc = cc+dc;
                    if (nr < 0)  { wallsHit.add('top');    continue; }
                    if (nr >= N) { wallsHit.add('bottom'); continue; }
                    if (nc < 0)  { wallsHit.add('left');   continue; }
                    if (nc >= N) { wallsHit.add('right');  continue; }
                    if (board[nr][nc] === EMPTY) enclosed = false;
                    if (board[nr][nc] === enemy && !visited[nr][nc]) queue.push([nr, nc]);
                }
            }

            if (enclosed && wallsHit.size <= 2) group.forEach(cell => toFlip.push(cell));
        }
    }

    toFlip.forEach(([fr, fc]) => { board[fr][fc] = p; });
    return toFlip;
}

function eloCalc(ra, rb, s) {
    return Math.round(ra + 32 * (s - 1 / (1 + Math.pow(10, (rb - ra) / 400))));
}

function genId() {
    return Math.random().toString(36).substr(2, 8);
}

function emptyBoard() {
    return Array.from({ length: N }, () => new Array(N).fill(EMPTY));
}

async function applyEloResult(p1name, p2name, result) {
    const col = await connectDB();
    const u1  = await col.findOne({ username: p1name });
    const u2  = await col.findOne({ username: p2name });
    if (!u1 || !u2) return {};

    const r1o = u1.rating || 1000, r2o = u2.rating || 1000;
    const [s1, s2] = result === 'p1' ? [1, 0] : result === 'p2' ? [0, 1] : [0.5, 0.5];
    const r1n = eloCalc(r1o, r2o, s1), r2n = eloCalc(r2o, r1o, s2);

    const inc1 = result === 'p1' ? { wins: 1 } : result === 'p2' ? { losses: 1 } : { draws: 1 };
    const inc2 = result === 'p2' ? { wins: 1 } : result === 'p1' ? { losses: 1 } : { draws: 1 };

    await col.updateOne({ username: p1name }, { $set: { rating: r1n }, $inc: inc1 });
    await col.updateOne({ username: p2name }, { $set: { rating: r2n }, $inc: inc2 });

    return { r1old: r1o, r2old: r2o, r1new: r1n, r2new: r2n };
}

// ── 게임 기록 ──────────────────────────────────
async function recordHistory(p1name, p2name, result, mode, reason, ratings, p1Score, p2Score) {
    const mk = (me, opponent, myScore, oppScore, myResult, rBefore, rAfter) => ({
        username: me, opponent, result: myResult, mode, reason,
        myScore, oppScore,
        ratingBefore: rBefore != null ? rBefore : null,
        ratingAfter:  rAfter  != null ? rAfter  : null,
        delta: (rBefore != null && rAfter != null) ? rAfter - rBefore : null,
        createdAt: Date.now(),
    });
    const r1 = result === 'p1' ? 'win' : result === 'p2' ? 'loss' : 'draw';
    const r2 = result === 'p2' ? 'win' : result === 'p1' ? 'loss' : 'draw';
    try {
        await historyCol.insertMany([
            mk(p1name, p2name, p1Score, p2Score, r1, ratings.r1old, ratings.r1new),
            mk(p2name, p1name, p2Score, p1Score, r2, ratings.r2old, ratings.r2new),
        ]);
    } catch (e) { console.error('recordHistory error', e); }
}

app.get('/api/history', async (req, res) => {
    const { username } = req.query;
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    if (!username) return res.json([]);
    try {
        await connectDB();
        const docs = await historyCol.find({ username }).sort({ createdAt: -1 }).limit(limit).toArray();
        res.json(docs.map(d => ({
            opponent: d.opponent, result: d.result, mode: d.mode, reason: d.reason,
            myScore: d.myScore, oppScore: d.oppScore, delta: d.delta, createdAt: d.createdAt,
        })));
    } catch (e) { res.json([]); }
});

// ── 일일 게임 (Daily Game: 수 제한 1일, 비동기, 방 목록) ──────
const DAILY_TURN_MS      = 24 * 60 * 60 * 1000;
const MAX_DAILY_PER_USER = 5;

function dailySummary(doc, username) {
    const isP1 = doc.p1 === username;
    const opponent       = doc.status === 'waiting' ? null : (isP1 ? doc.p2 : doc.p1);
    const opponentRating = doc.status === 'waiting' ? null : (isP1 ? doc.p2Rating : doc.p1Rating);
    const myTurn = doc.status === 'active' && ((doc.turn === P1 && isP1) || (doc.turn === P2 && !isP1));
    const { p1: p1Score, p2: p2Score } = doc.board ? cnt(doc.board) : { p1: 0, p2: 0 };
    return {
        id: doc._id, status: doc.status, opponent, opponentRating, myTurn,
        isCreator: doc.creator === username, deadline: doc.deadline || null,
        createdAt: doc.createdAt, p1Score, p2Score,
        result: doc.result || null, reason: doc.reason || null,
    };
}

function dailyFull(doc) {
    return {
        id: doc._id, status: doc.status,
        p1: doc.p1, p2: doc.p2, p1Rating: doc.p1Rating, p2Rating: doc.p2Rating,
        board: doc.board, turn: doc.turn, deadline: doc.deadline || null, N,
        result: doc.result || null, reason: doc.reason || null, ratings: doc.ratings || {},
        createdAt: doc.createdAt, startedAt: doc.startedAt || null, finishedAt: doc.finishedAt || null,
    };
}

async function endDailyGame(doc, result, reason) {
    if (doc.status === 'finished') return doc;
    let ratings = {};
    try { ratings = await applyEloResult(doc.p1, doc.p2, result); }
    catch (e) { console.error('endDailyGame elo error', e); }

    const { p1: p1Score, p2: p2Score } = cnt(doc.board);
    await recordHistory(doc.p1, doc.p2, result, 'daily', reason, ratings, p1Score, p2Score);

    const update = { status: 'finished', result, reason, ratings, finishedAt: Date.now() };
    await dailyCol.updateOne({ _id: doc._id }, { $set: update });
    notifyDaily(doc.p1, doc._id, true);
    notifyDaily(doc.p2, doc._id, true);
    return { ...doc, ...update };
}

async function joinDailyRoom(roomId, username, email, res, lang) {
    const room = await dailyCol.findOne({ _id: roomId });
    if (!room || room.status !== 'waiting')
        return res.json({ ok: false, msg: tr('cannotJoinRoom', lang) });
    if (room.creator === username)
        return res.json({ ok: false, msg: tr('cannotJoinOwnRoom', lang) });

    const user = await usersCol.findOne({ username });
    if (!user) return res.json({ ok: false, msg: tr('userNotFound', lang) });

    const activeCount = await dailyCol.countDocuments(
        { status: 'active', $or: [{ p1: username }, { p2: username }] });
    if (activeCount >= MAX_DAILY_PER_USER)
        return res.json({ ok: false, msg: tr('maxActiveGames', lang, MAX_DAILY_PER_USER) });

    const now = Date.now();
    const update = {
        status: 'active', p1: room.creator, p1Rating: room.creatorRating,
        p1Email: room.creatorEmail || null,
        p2: username, p2Rating: user.rating || 1000,
        p2Email: normalizeEmail(email),
        board: emptyBoard(), turn: P1, deadline: now + DAILY_TURN_MS, startedAt: now,
    };
    const upd = await dailyCol.updateOne({ _id: roomId, status: 'waiting' }, { $set: update });
    if (upd.matchedCount === 0)
        return res.json({ ok: false, msg: tr('alreadyJoinedByOther', lang) });

    const full = { ...room, ...update };
    notifyDaily(full.creator, roomId);
    notifyDaily(username, roomId);
    if (full.p1Email) sendTurnEmail(full.p1Email, full.p2); // 방장(p1) 차례로 시작됨
    res.json({ ok: true, game: dailyFull(full) });
}

app.post('/api/daily/rooms', async (req, res) => {
    const lang = reqLang(req);
    const { username, email } = req.body || {};
    if (!username) return res.json({ ok: false, msg: tr('loginRequired', lang) });
    try {
        await connectDB();
        const user = await usersCol.findOne({ username });
        if (!user) return res.json({ ok: false, msg: tr('userNotFound', lang) });

        const existing = await dailyCol.findOne({ creator: username, status: 'waiting' });
        if (existing) return res.json({ ok: false, msg: tr('alreadyWaitingRoom', lang) });

        const activeCount = await dailyCol.countDocuments(
            { status: 'active', $or: [{ p1: username }, { p2: username }] });
        if (activeCount >= MAX_DAILY_PER_USER)
            return res.json({ ok: false, msg: tr('maxActiveGames', lang, MAX_DAILY_PER_USER) });

        const room = {
            _id: genId(), creator: username, creatorRating: user.rating || 1000,
            creatorEmail: normalizeEmail(email),
            status: 'waiting', createdAt: Date.now(),
        };
        await dailyCol.insertOne(room);
        res.json({ ok: true, room: { id: room._id, creator: room.creator,
            creatorRating: room.creatorRating, createdAt: room.createdAt } });
    } catch (e) { console.error(e); res.json({ ok: false, msg: tr('serverError', lang) }); }
});

app.get('/api/daily/rooms', async (req, res) => {
    try {
        await connectDB();
        const rooms = await dailyCol.find({ status: 'waiting' }).sort({ createdAt: -1 }).limit(50).toArray();
        res.json(rooms.map(r => ({ id: r._id, creator: r.creator,
            creatorRating: r.creatorRating, createdAt: r.createdAt })));
    } catch (e) { res.json([]); }
});

app.post('/api/daily/rooms/:id/cancel', async (req, res) => {
    const lang = reqLang(req);
    const { username } = req.body || {};
    try {
        await connectDB();
        const room = await dailyCol.findOne({ _id: req.params.id });
        if (!room || room.status !== 'waiting') return res.json({ ok: false, msg: tr('cannotCancelRoom', lang) });
        if (room.creator !== username) return res.json({ ok: false, msg: tr('noPermission', lang) });
        await dailyCol.deleteOne({ _id: req.params.id });
        res.json({ ok: true });
    } catch (e) { console.error(e); res.json({ ok: false, msg: tr('serverError', lang) }); }
});

app.post('/api/daily/rooms/:id/join', async (req, res) => {
    const lang = reqLang(req);
    const { username, email } = req.body || {};
    if (!username) return res.json({ ok: false, msg: tr('loginRequired', lang) });
    try { await connectDB(); await joinDailyRoom(req.params.id, username, email, res, lang); }
    catch (e) { console.error(e); res.json({ ok: false, msg: tr('serverError', lang) }); }
});

app.post('/api/daily/rooms/random-join', async (req, res) => {
    const lang = reqLang(req);
    const { username, email } = req.body || {};
    if (!username) return res.json({ ok: false, msg: tr('loginRequired', lang) });
    try {
        await connectDB();
        const rooms = await dailyCol.find({ status: 'waiting', creator: { $ne: username } }).toArray();
        if (!rooms.length) return res.json({ ok: false, msg: tr('noJoinableRooms', lang) });
        const room = rooms[Math.floor(Math.random() * rooms.length)];
        await joinDailyRoom(room._id, username, email, res, lang);
    } catch (e) { console.error(e); res.json({ ok: false, msg: tr('serverError', lang) }); }
});

app.get('/api/daily/games', async (req, res) => {
    const { username } = req.query;
    if (!username) return res.json([]);
    try {
        await connectDB();
        const docs = await dailyCol.find({ $or: [
            { status: 'waiting', creator: username },
            { status: 'active', p1: username },
            { status: 'active', p2: username },
        ] }).sort({ createdAt: -1 }).toArray();
        res.json(docs.map(d => dailySummary(d, username)));
    } catch (e) { res.json([]); }
});

app.get('/api/daily/games/:id', async (req, res) => {
    const lang = reqLang(req);
    const { username } = req.query;
    try {
        await connectDB();
        const doc = await dailyCol.findOne({ _id: req.params.id });
        if (!doc) return res.json({ ok: false, msg: tr('gameNotFound', lang) });
        if (doc.p1 !== username && doc.p2 !== username) return res.json({ ok: false, msg: tr('noPermission', lang) });
        res.json({ ok: true, game: dailyFull(doc) });
    } catch (e) { console.error(e); res.json({ ok: false, msg: tr('serverError', lang) }); }
});

app.post('/api/daily/games/:id/move', async (req, res) => {
    const lang = reqLang(req);
    const { username, r, c } = req.body || {};
    if (!username) return res.json({ ok: false, msg: tr('loginRequired', lang) });
    try {
        await connectDB();
        const game = await dailyCol.findOne({ _id: req.params.id });
        if (!game || game.status !== 'active') return res.json({ ok: false, msg: tr('notActiveGame', lang) });
        const myNum = game.p1 === username ? P1 : game.p2 === username ? P2 : 0;
        if (!myNum) return res.json({ ok: false, msg: tr('notParticipant', lang) });
        if (game.turn !== myNum) return res.json({ ok: false, msg: tr('notYourTurn', lang) });
        if (typeof r !== 'number' || typeof c !== 'number' || r < 0 || r >= N || c < 0 || c >= N)
            return res.json({ ok: false, msg: tr('invalidCoords', lang) });
        if (game.board[r][c] !== EMPTY) return res.json({ ok: false, msg: tr('cellFilled', lang) });

        const board = game.board.map(row => [...row]);
        pts(board, r, c).forEach(([ar, ac]) => { board[ar][ac] = myNum; });
        const captured  = applyEnclosures(board, myNum);
        const nextTurn  = myNum === P1 ? P2 : P1;
        const { p1, p2, em } = cnt(board);

        const upd = await dailyCol.updateOne(
            { _id: req.params.id, status: 'active', turn: myNum },
            { $set: { board, turn: nextTurn, deadline: Date.now() + DAILY_TURN_MS, lastMoveAt: Date.now() } });
        if (upd.matchedCount === 0) return res.json({ ok: false, msg: tr('staleRequest', lang) });

        let finalDoc = await dailyCol.findOne({ _id: req.params.id });
        if (em === 0) {
            finalDoc = await endDailyGame(finalDoc, p1 > p2 ? 'p1' : p2 > p1 ? 'p2' : 'draw', 'normal');
        } else {
            const nextUsername = myNum === P1 ? finalDoc.p2 : finalDoc.p1;
            const nextEmail    = myNum === P1 ? finalDoc.p2Email : finalDoc.p1Email;
            notifyDaily(nextUsername, req.params.id);
            if (nextEmail) sendTurnEmail(nextEmail, username);
        }
        res.json({ ok: true, game: dailyFull(finalDoc), captured, r, c, player: myNum });
    } catch (e) { console.error(e); res.json({ ok: false, msg: tr('serverError', lang) }); }
});

app.post('/api/daily/games/:id/forfeit', async (req, res) => {
    const lang = reqLang(req);
    const { username } = req.body || {};
    try {
        await connectDB();
        const game = await dailyCol.findOne({ _id: req.params.id });
        if (!game || game.status !== 'active') return res.json({ ok: false, msg: tr('notActiveGame', lang) });
        const myNum = game.p1 === username ? P1 : game.p2 === username ? P2 : 0;
        if (!myNum) return res.json({ ok: false, msg: tr('notParticipant', lang) });
        const finalDoc = await endDailyGame(game, myNum === P1 ? 'p2' : 'p1', 'forfeit');
        res.json({ ok: true, game: dailyFull(finalDoc) });
    } catch (e) { console.error(e); res.json({ ok: false, msg: tr('serverError', lang) }); }
});

function clearTimer(game) {
    if (game.turnTimer) { clearTimeout(game.turnTimer); game.turnTimer = null; }
}

function startTimer(game) {
    clearTimer(game);
    game.turnDeadline = Date.now() + TURN_TIME * 1000;
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
        ratings = await applyEloResult(game.p1name, game.p2name, result);
        if (ratings.r1new !== undefined) {
            // WS 캐시도 즉시 갱신 — 다음 매치에서 올바른 레이팅 표시
            game.p1ws.rating = ratings.r1new;
            game.p2ws.rating = ratings.r2new;
        }
        await recordHistory(game.p1name, game.p2name, result, game.mode, reason, ratings, p1, p2);
    } catch (e) { console.error('endGame DB error', e); }

    const msg = { type: 'game_over', result, reason, p1, p2, ratings };
    send(game.p1ws, msg);
    send(game.p2ws, msg);
    game.p1ws.gameId = null;
    game.p2ws.gameId = null;
    games.delete(game.id);

    // 끊긴 동안 게임이 끝나버린 경우, 뒤늦게 재접속한 쪽도 결과를 볼 수 있도록 잠시 보관
    recentlyEndedGames.set(game.id, { msg, p1name: game.p1name, p2name: game.p2name });
    setTimeout(() => recentlyEndedGames.delete(game.id), 60000);
}

function startGame(p1ws, p2ws, mode) {
    if (p1ws.username === p2ws.username) {
        send(p1ws, { type: 'error', msg: tr('sameAccount', p1ws.lang) });
        if (p2ws !== p1ws) send(p2ws, { type: 'error', msg: tr('sameAccount', p2ws.lang) });
        return;
    }
    [p1ws, p2ws].forEach(w => {
        const i = waitingQueue.indexOf(w);
        if (i !== -1) waitingQueue.splice(i, 1);
    });

    const gid   = genId();
    const board = emptyBoard();
    const game  = { id: gid, board, turn: P1, ended: false, mode,
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
    ws.lang     = 'ko';
    ws.isAlive  = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', async raw => {
        let m; try { m = JSON.parse(raw); } catch { return; }

        if (m.type === 'auth') {
            ws.username = m.username;
            ws.rating   = m.rating || 1000;
            ws.lang     = m.lang === 'en' ? 'en' : 'ko';
            onlineUsers.set(m.username, ws);
            return send(ws, { type: 'auth_ok' });
        }
        if (m.type === 'set_lang') {
            ws.lang = m.lang === 'en' ? 'en' : 'ko';
            return;
        }
        if (!ws.username) return;

        if (m.type === 'rejoin_game') {
            const game = games.get(m.gameId);
            if (!game || game.ended || (game.p1name !== ws.username && game.p2name !== ws.username)) {
                const ended = recentlyEndedGames.get(m.gameId);
                if (ended && (ended.p1name === ws.username || ended.p2name === ws.username)) {
                    const endedPlayerNum = ended.p1name === ws.username ? P1 : P2;
                    return send(ws, { ...ended.msg, playerNum: endedPlayerNum });
                }
                return send(ws, { type: 'rejoin_failed' });
            }

            const myNum = game.p1name === ws.username ? P1 : P2;
            if (myNum === P1) game.p1ws = ws; else game.p2ws = ws;
            ws.gameId = game.id;

            const { p1, p2 } = cnt(game.board);
            send(ws, { type: 'rejoin_ok', gameId: game.id, playerNum: myNum, N,
                opponent: myNum === P1 ? game.p2name : game.p1name,
                opponentRating: myNum === P1 ? game.p2ws.rating : game.p1ws.rating,
                board: game.board, turn: game.turn, p1, p2 });

            const remainMs = game.turnDeadline ? Math.max(1000, game.turnDeadline - Date.now()) : TURN_TIME * 1000;
            send(ws, { type: 'turn_timer', seconds: Math.ceil(remainMs / 1000), forPlayer: game.turn });
            return;
        }

        if (m.type === 'join_queue') {
            if (ws.gameId) return;
            const i = waitingQueue.indexOf(ws);
            if (i !== -1) waitingQueue.splice(i, 1);
            const oppIdx = waitingQueue.findIndex(w => w.username !== ws.username);
            if (oppIdx !== -1) {
                const opp = waitingQueue.splice(oppIdx, 1)[0];
                startGame(ws, opp, 'random');
            } else {
                waitingQueue.push(ws);
                send(ws, { type: 'waiting' });
            }
            return;
        }

        if (m.type === 'leave_queue') {
            const i = waitingQueue.indexOf(ws);
            if (i !== -1) waitingQueue.splice(i, 1);
            return;
        }

        if (m.type === 'send_challenge') {
            if (ws.gameId)
                return send(ws, { type: 'challenge_result', ok: false, msg: tr('inGameCannotInvite', ws.lang) });
            if (m.to === ws.username)
                return send(ws, { type: 'challenge_result', ok: false, msg: tr('cannotInviteSelf', ws.lang) });
            const tws = onlineUsers.get(m.to);
            if (!tws)
                return send(ws, { type: 'challenge_result', ok: false, msg: tr('userNotOnline', ws.lang) });
            if (tws.gameId)
                return send(ws, { type: 'challenge_result', ok: false, msg: tr('userInGame', ws.lang) });

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
            if (!ch) return send(ws, { type: 'error', msg: tr('inviteExpired', ws.lang) });
            clearTimeout(ch.timer);
            pendingChallenges.delete(key);
            if (!m.accept) { send(ch.fromWs, { type: 'challenge_declined', by: ws.username }); return; }
            if (ws.gameId || ch.fromWs.gameId) {
                send(ws, { type: 'error', msg: tr('alreadyInGame', ws.lang) });
                send(ch.fromWs, { type: 'challenge_declined', by: ws.username });
                return;
            }
            startGame(ch.fromWs, ws, 'invite');
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
            const captured = applyEnclosures(game.board, myNum);
            game.turn = myNum === P1 ? P2 : P1;

            const { p1, p2, em } = cnt(game.board);
            const mv = { type: 'move_made', r, c, player: myNum,
                board: game.board, turn: game.turn, p1, p2, em, captured };
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
        if (ws.username && onlineUsers.get(ws.username) === ws) {
            onlineUsers.delete(ws.username);
            cleanChallengesFor(ws.username);
        }
        const i = waitingQueue.indexOf(ws);
        if (i !== -1) waitingQueue.splice(i, 1);

        if (ws.gameId) {
            const game = games.get(ws.gameId);
            // rejoin_game으로 이미 다른 소켓이 이 게임을 대체했다면 무시
            // (재접속 전 죽은 소켓의 close 이벤트가 뒤늦게 도착하는 경우)
            if (game && !game.ended && (game.p1ws === ws || game.p2ws === ws)) {
                const myNum = game.p1ws === ws ? P1 : P2;
                endGame(game, myNum === P1 ? 'p2' : 'p1', 'disconnect');
            }
        }
    });
});

// ── 하트비트: 응답 없는 소켓을 감지해 정리 (모바일 네트워크 전환 등으로 인한
//    "좀비 연결"을 빠르게 걸러내 재접속/종료 처리가 지연 없이 이뤄지게 함) ──
const heartbeatTimer = setInterval(() => {
    wss.clients.forEach(ws => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 10000);

// ── 일일 게임 타임아웃 정리 (5분마다 마감 지난 게임 자동 처리) ──
setInterval(async () => {
    try {
        await connectDB();
        const expired = await dailyCol.find({ status: 'active', deadline: { $lt: Date.now() } }).toArray();
        for (const g of expired) {
            await endDailyGame(g, g.turn === P1 ? 'p2' : 'p1', 'timeout');
        }
    } catch (e) { console.error('daily sweep error', e); }
}, 5 * 60 * 1000);

// 포트 먼저 열고 DB는 백그라운드 연결 (Render 포트 스캔 타임아웃 방지)
server.listen(PORT, () => console.log(`✅ 서버 실행 중: http://localhost:${PORT}`));
connectDB()
    .catch(err => console.error('MongoDB 연결 실패:', err.message));
