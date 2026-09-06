const express  = require('express');
const http      = require('http');
const WebSocket = require('ws');
const crypto    = require('crypto');
const path      = require('path');
const { MongoClient } = require('mongodb');
const { EMPTY, P1, P2, N, pts, cnt, applyEnclosures, emptyBoard } = require('./gameCore');
const bots   = require('./bots');
const botAI  = require('./botAI');

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
    await seedBots();
    return usersCol;
}

// ── 봇 계정 시딩 ──────────────────────────────
// 기존 유저 데이터를 절대 건드리지 않도록 $setOnInsert로만 최초 생성 시 채움
async function seedBots() {
    try {
        for (const bot of bots.ALL_BOTS) {
            await usersCol.updateOne(
                { username: bot.username },
                {
                    $setOnInsert: {
                        password: hashPw(crypto.randomBytes(16).toString('hex')),
                        rating: 1000, wins: 0, losses: 0, draws: 0, aiWins: [],
                    },
                    $set: {
                        isBot: true,
                        botMode: bots.BOT_MODE_MAP.get(bot.username),
                        botLevel: bot.level,
                    },
                },
                { upsert: true }
            );
        }
    } catch (e) { console.error('seedBots error', e); }
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

function genToken() {
    return crypto.randomBytes(24).toString('hex');
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
            const token = genToken();
            const newUser = { username, password: hash, rating: 1000, wins: 0, losses: 0, draws: 0, aiWins: [], sessionToken: token };
            await col.insertOne(newUser);
            return res.json({ ok: true, created: true, token,
                user: { username, rating: 1000, wins: 0, losses: 0, draws: 0, aiWins: [] } });
        }

        if (existing.isBot)
            return res.json({ ok: false, msg: tr('wrongCreds', lang) });

        if (existing.password !== hash)
            return res.json({ ok: false, msg: tr('wrongCreds', lang) });

        let token = existing.sessionToken;
        if (!token) {
            token = genToken();
            await col.updateOne({ username }, { $set: { sessionToken: token } });
        }

        return res.json({ ok: true, created: false, token,
            user: { username, rating: existing.rating, wins: existing.wins,
                    losses: existing.losses, draws: existing.draws, aiWins: existing.aiWins || [] } });
    } catch (e) {
        console.error(e);
        return res.json({ ok: false, msg: tr('serverError', lang) });
    }
});

app.post('/api/session/resume', async (req, res) => {
    const { token } = req.body || {};
    if (!token) return res.json({ ok: false });
    try {
        const col = await connectDB();
        const u = await col.findOne({ sessionToken: token, isBot: { $ne: true } });
        if (!u) return res.json({ ok: false });
        res.json({ ok: true,
            user: { username: u.username, rating: u.rating, wins: u.wins,
                    losses: u.losses, draws: u.draws, aiWins: u.aiWins || [] } });
    } catch (e) {
        res.json({ ok: false });
    }
});

app.get('/api/leaderboard', async (req, res) => {
    try {
        const col  = await connectDB();
        const list = await col
            .find({}, { projection: { password: 0, _id: 0, sessionToken: 0 } })
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
            .find({ aiWins: lv }, { projection: { password: 0, _id: 0, sessionToken: 0 } })
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

const TURN_TIME  = 20;
const REALTIME_BOT_MIN_DELAY_MS = 2000;
const REALTIME_BOT_MAX_DELAY_MS = 18000;
const QUEUE_BOT_FALLBACK_MS     = 10000;

const waitingQueue        = [];
const games               = new Map();
const onlineUsers         = new Map();   // username → ws
const pendingChallenges   = new Map();   // `${from}->${to}` → { fromWs, timer }
const recentlyEndedGames  = new Map();   // gameId → { msg, p1name, p2name } (60초간 재접속 결과 조회용)
const busyBots            = new Set();   // 현재 실시간 대전 중인 봇 유저네임 (중복 매칭 방지)

function makeBotPseudoWs(username, rating, level) {
    return { username, rating, isBot: true, botLevel: level, gameId: null, lang: 'ko', readyState: null };
}

// 사용 가능한(대전 중이 아닌) 실시간 봇 하나를 무작위로 골라 최신 레이팅과 함께 반환
async function pickFreeBot() {
    const free = bots.REALTIME_BOTS.filter(b => !busyBots.has(b.username));
    if (!free.length) return null;
    const pick = free[Math.floor(Math.random() * free.length)];
    try {
        const col  = await connectDB();
        const user = await col.findOne({ username: pick.username });
        return { username: pick.username, level: pick.level, rating: (user && user.rating) || 1000 };
    } catch (e) {
        return { username: pick.username, level: pick.level, rating: 1000 };
    }
}

function send(ws, data) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function notifyDaily(username, gameId, ended) {
    const tws = onlineUsers.get(username);
    if (tws) send(tws, { type: 'daily_notify', gameId, ended: !!ended });
}

function eloCalc(ra, rb, s) {
    return Math.round(ra + 32 * (s - 1 / (1 + Math.pow(10, (rb - ra) / 400))));
}

function genId() {
    return Math.random().toString(36).substr(2, 8);
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
const DAILY_BOT_DELAY_MIN_MS = 5 * 60 * 1000;
const DAILY_BOT_DELAY_MAX_MS = 120 * 60 * 1000;

function randomDailyDelay() {
    return DAILY_BOT_DELAY_MIN_MS + Math.random() * (DAILY_BOT_DELAY_MAX_MS - DAILY_BOT_DELAY_MIN_MS);
}

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
        // P1(창설자)이 항상 먼저 두므로, 창설자가 봇이면 첫 수를 지연 예약
        botTurnAt: bots.isBotUsername(room.creator) ? now + randomDailyDelay() : null,
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

// 사람(HTTP 핸들러)과 봇(sweepBotDailyMoves) 공용 착수 처리
async function performDailyMove(gameId, username, r, c) {
    const game = await dailyCol.findOne({ _id: gameId });
    if (!game || game.status !== 'active') return { ok: false, code: 'notActiveGame' };
    const myNum = game.p1 === username ? P1 : game.p2 === username ? P2 : 0;
    if (!myNum) return { ok: false, code: 'notParticipant' };
    if (game.turn !== myNum) return { ok: false, code: 'notYourTurn' };
    if (typeof r !== 'number' || typeof c !== 'number' || r < 0 || r >= N || c < 0 || c >= N)
        return { ok: false, code: 'invalidCoords' };
    if (game.board[r][c] !== EMPTY) return { ok: false, code: 'cellFilled' };

    const board = game.board.map(row => [...row]);
    pts(board, r, c).forEach(([ar, ac]) => { board[ar][ac] = myNum; });
    const captured  = applyEnclosures(board, myNum);
    const nextTurn  = myNum === P1 ? P2 : P1;
    const { p1, p2, em } = cnt(board);
    const nextUsername = nextTurn === P1 ? game.p1 : game.p2;
    const botTurnAt = em > 0 && bots.isBotUsername(nextUsername) ? Date.now() + randomDailyDelay() : null;

    const upd = await dailyCol.updateOne(
        { _id: gameId, status: 'active', turn: myNum },
        { $set: { board, turn: nextTurn, deadline: Date.now() + DAILY_TURN_MS, lastMoveAt: Date.now(), botTurnAt } });
    if (upd.matchedCount === 0) return { ok: false, code: 'staleRequest' };

    let finalDoc = await dailyCol.findOne({ _id: gameId });
    if (em === 0) {
        finalDoc = await endDailyGame(finalDoc, p1 > p2 ? 'p1' : p2 > p1 ? 'p2' : 'draw', 'normal');
    } else {
        const nextEmail = myNum === P1 ? finalDoc.p2Email : finalDoc.p1Email;
        notifyDaily(nextUsername, gameId);
        if (nextEmail) sendTurnEmail(nextEmail, username);
    }
    return { ok: true, game: finalDoc, captured, r, c, player: myNum };
}

app.post('/api/daily/games/:id/move', async (req, res) => {
    const lang = reqLang(req);
    const { username, r, c } = req.body || {};
    if (!username) return res.json({ ok: false, msg: tr('loginRequired', lang) });
    try {
        await connectDB();
        const result = await performDailyMove(req.params.id, username, r, c);
        if (!result.ok) return res.json({ ok: false, msg: tr(result.code, lang) });
        res.json({ ok: true, game: dailyFull(result.game), captured: result.captured,
            r: result.r, c: result.c, player: result.player });
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

// 현재 턴 보유자가 봇이면 2~18초 랜덤 지연 후 봇의 수를 자동으로 둠
function maybeScheduleBotMove(game) {
    const botWs = game.turn === P1 ? game.p1ws : game.p2ws;
    if (!botWs || !botWs.isBot) return;
    const delay = REALTIME_BOT_MIN_DELAY_MS + Math.random() * (REALTIME_BOT_MAX_DELAY_MS - REALTIME_BOT_MIN_DELAY_MS);
    setTimeout(() => {
        if (game.ended || games.get(game.id) !== game) return;
        if (game.turn !== (botWs === game.p1ws ? P1 : P2)) return;
        const move = botAI.chooseMove(game.board, game.turn, botWs.botLevel);
        if (!move) return;
        applyMoveOnGame(game, game.turn, move[0], move[1]);
    }, delay);
}

// 사람(make_move 메시지)과 봇(maybeScheduleBotMove) 공용 착수 처리
async function applyMoveOnGame(game, myNum, r, c) {
    if (!game || game.ended) return;
    if (game.turn !== myNum) return;
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
        maybeScheduleBotMove(game);
    }
}

async function endGame(game, result, reason) {
    if (game.ended) return;
    game.ended = true;
    clearTimer(game);
    [game.p1ws, game.p2ws].forEach(w => { if (w.isBot) busyBots.delete(w.username); });

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
        clearTimeout(w._botFallbackTimer);
        if (w.isBot) busyBots.add(w.username);
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
    maybeScheduleBotMove(game);
}

// 매칭 큐에서 10초간 사람 상대를 못 찾으면 대기 중인 실시간 봇과 자동 매칭
function scheduleBotFallback(ws) {
    ws._botFallbackTimer = setTimeout(async () => {
        if (ws.gameId || !waitingQueue.includes(ws)) return;
        const bot = await pickFreeBot();
        if (!bot) { scheduleBotFallback(ws); return; } // 봇이 전부 사용 중이면 재시도
        const idx = waitingQueue.indexOf(ws);
        if (idx === -1 || ws.gameId) return; // 그 사이 다른 곳에서 매칭/이탈됨
        waitingQueue.splice(idx, 1);
        const botWs = makeBotPseudoWs(bot.username, bot.rating, bot.level);
        startGame(ws, botWs, 'bot');
    }, QUEUE_BOT_FALLBACK_MS);
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
            clearTimeout(ws._botFallbackTimer);
            const i = waitingQueue.indexOf(ws);
            if (i !== -1) waitingQueue.splice(i, 1);
            const oppIdx = waitingQueue.findIndex(w => w.username !== ws.username);
            if (oppIdx !== -1) {
                const opp = waitingQueue.splice(oppIdx, 1)[0];
                clearTimeout(opp._botFallbackTimer);
                startGame(ws, opp, 'random');
            } else {
                waitingQueue.push(ws);
                send(ws, { type: 'waiting' });
                scheduleBotFallback(ws);
            }
            return;
        }

        if (m.type === 'leave_queue') {
            clearTimeout(ws._botFallbackTimer);
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
            await applyMoveOnGame(game, myNum, m.r, m.c);
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
        clearTimeout(ws._botFallbackTimer);
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

// ── 일일 대전 봇: 항상 대기방 하나씩 열어두기 ──
async function ensureBotDailyRooms() {
    try {
        await connectDB();
        for (const bot of bots.DAILY_BOTS) {
            const existing = await dailyCol.findOne({ creator: bot.username, status: 'waiting' });
            if (existing) continue;
            const activeCount = await dailyCol.countDocuments(
                { status: 'active', $or: [{ p1: bot.username }, { p2: bot.username }] });
            if (activeCount >= MAX_DAILY_PER_USER) continue;
            const botUser = await usersCol.findOne({ username: bot.username });
            if (!botUser) continue;
            await dailyCol.insertOne({
                _id: genId(), creator: bot.username, creatorRating: botUser.rating || 1000,
                creatorEmail: null, status: 'waiting', createdAt: Date.now(),
            });
        }
    } catch (e) { console.error('ensureBotDailyRooms error', e); }
}
setInterval(ensureBotDailyRooms, 60 * 1000);

// ── 일일 대전 봇: 지연된 착수 처리 (30초마다 확인) ──
async function sweepBotDailyMoves() {
    try {
        await connectDB();
        const due = await dailyCol.find(
            { status: 'active', botTurnAt: { $ne: null, $lte: Date.now() } }).toArray();
        for (const doc of due) {
            const botUsername = doc.turn === P1 ? doc.p1 : doc.p2;
            const level = bots.BOT_LEVEL_MAP.get(botUsername);
            if (!level) continue; // 안전장치: 실제로 봇 차례가 아니면 건너뜀
            const move = botAI.chooseMove(doc.board, doc.turn, level);
            if (!move) continue;
            await performDailyMove(doc._id, botUsername, move[0], move[1]);
        }
    } catch (e) { console.error('sweepBotDailyMoves error', e); }
}
setInterval(sweepBotDailyMoves, 30 * 1000);

// 포트 먼저 열고 DB는 백그라운드 연결 (Render 포트 스캔 타임아웃 방지)
server.listen(PORT, () => console.log(`✅ 서버 실행 중: http://localhost:${PORT}`));
connectDB()
    .then(() => { ensureBotDailyRooms(); })
    .catch(err => console.error('MongoDB 연결 실패:', err.message));
