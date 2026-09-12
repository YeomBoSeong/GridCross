// ── 봇 명단 ────────────────────────────────────
// 봇이름.txt 1~14번 → 실시간 대전 봇, 15~28번 → 일일 대전 봇
const REALTIME_BOT_NAMES = [
    '얄루', '앙휘모릿', 'king2003', '깨불이', '많이답답할끼야', '야무띠', 'sui',
    'jack0528', '불닭펀치', '오늘도지각', '마라탕러버', 'windbreaker', '시크한감자', '정체불명의고수',
];
const DAILY_BOT_NAMES = [
    '우당탕탕', '밤샘개발자', '으랏차차꾀돌이네', '떡볶이덕후', '졸린판다', '드가자', '지나가는나그네',
    '커피한잔의여유', 'min0210', 'leo_kim', 'yuna1004', 'david99', 'ella0815', 'messi',
];

// 각 14개 그룹 내 순서대로 LV.3×3, LV.4×4, LV.5×4, LV.6×3
const LEVEL_PATTERN = [3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 6, 6, 6];

function buildRoster(names) {
    return names.map((username, i) => ({ username, level: LEVEL_PATTERN[i] }));
}

const REALTIME_BOTS = buildRoster(REALTIME_BOT_NAMES);
const DAILY_BOTS    = buildRoster(DAILY_BOT_NAMES);
const ALL_BOTS       = [...REALTIME_BOTS, ...DAILY_BOTS];

const BOT_LEVEL_MAP = new Map(ALL_BOTS.map(b => [b.username, b.level]));
const BOT_MODE_MAP  = new Map([
    ...REALTIME_BOTS.map(b => [b.username, 'realtime']),
    ...DAILY_BOTS.map(b => [b.username, 'daily']),
]);

function isBotUsername(username) {
    return BOT_LEVEL_MAP.has(username);
}

// ── 봇 닉네임 색 & AI 정복자 노출 ──────────────
// 실유저의 "AI 정복자" 닉네임 색(territory_game_online.html의 AI_LEVEL_CFG)과 같은 팔레트에서
// 유저명 해시로 LV.1~7 중 하나를 고정 배정 — 모든 봇이 흰색으로 보여 봇임이 쉽게 티나는 문제 방지.
// 배정된 레벨을 aiWins에도 심어서(seedBots) 해당 레벨의 "AI 정복자" 목록에 실제로 노출되게 함.
// 서버 재시작/배포와 무관하게 항상 같은 봇에 같은 레벨/색이 나오도록 랜덤 대신 결정적 해시 사용.
const AI_LEVEL_COLORS = { 1: '#8b5a2b', 2: '#d4b106', 3: '#ff8c00', 4: '#2ea043', 5: '#3b82f6', 6: '#9b59b6', 7: '#e74c3c' };
function hashStr(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(h);
}
const AI_LEVELS = Object.keys(AI_LEVEL_COLORS).map(Number);
const BOT_CONQ_LEVEL_MAP = new Map(ALL_BOTS.map(b => [b.username, AI_LEVELS[hashStr(b.username) % AI_LEVELS.length]]));
const BOT_COLOR_MAP = new Map(ALL_BOTS.map(b => [b.username, AI_LEVEL_COLORS[BOT_CONQ_LEVEL_MAP.get(b.username)]]));

module.exports = {
    REALTIME_BOTS, DAILY_BOTS, ALL_BOTS,
    BOT_LEVEL_MAP, BOT_MODE_MAP, BOT_COLOR_MAP, BOT_CONQ_LEVEL_MAP,
    isBotUsername,
};
