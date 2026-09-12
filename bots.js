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

// ── 봇 닉네임 색 ──────────────────────────────
// 실제 유저의 "AI 정복자" 닉네임 색(territory_game_online.html의 AI_LEVEL_CFG)과 같은 팔레트에서
// 유저명 해시로 고정 색을 골라줌 — 모든 봇이 흰색으로 보여 봇임이 쉽게 티나는 문제 방지.
// 서버 재시작/배포와 무관하게 항상 같은 봇에 같은 색이 나오도록 랜덤 대신 결정적 해시 사용.
const NICK_COLORS = ['#8b5a2b', '#d4b106', '#ff8c00', '#2ea043', '#3b82f6', '#9b59b6', '#e74c3c'];
function hashStr(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(h);
}
const BOT_COLOR_MAP = new Map(ALL_BOTS.map(b => [b.username, NICK_COLORS[hashStr(b.username) % NICK_COLORS.length]]));

module.exports = {
    REALTIME_BOTS, DAILY_BOTS, ALL_BOTS,
    BOT_LEVEL_MAP, BOT_MODE_MAP, BOT_COLOR_MAP,
    isBotUsername,
};
