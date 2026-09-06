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

module.exports = {
    REALTIME_BOTS, DAILY_BOTS, ALL_BOTS,
    BOT_LEVEL_MAP, BOT_MODE_MAP,
    isBotUsername,
};
