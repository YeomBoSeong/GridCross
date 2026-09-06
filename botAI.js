// ── 봇 AI 엔진 (서버용) ─────────────────────────
// territory_game_online.html의 로컬 AI(미니맥스 + 알파-베타) 로직을 그대로 포팅하되,
// 클라이언트 버전은 항상 P2가 "나"였던 것을 me/enemy 파라미터로 일반화했다.
const { N, EMPTY, P1, P2, pts, applyEnclosures } = require('./gameCore');

const LEVEL_CFG = {
    3: { depth: 2, beam: 12 },
    4: { depth: 3, beam: 12 },
    5: { depth: 4, beam: 12 },
    6: { depth: 5, beam: 12 },
};

function opp(p) { return p === P1 ? P2 : P1; }

function applyMoveB(g, r, c, p) {
    const tmp = g.map(row => [...row]);
    pts(tmp, r, c).forEach(([ar, ac]) => { tmp[ar][ac] = p; });
    applyEnclosures(tmp, p);
    return tmp;
}

function scoreOn(g, r, c, p) {
    const e = opp(p);
    return pts(g, r, c).reduce((s, [ar, ac]) => {
        const v = g[ar][ac];
        return s + (v === EMPTY ? 1 : v === e ? 5 : 0);
    }, 0);
}

// 내부 노드 빠른 후보 정렬
function topMoves(g, p, k) {
    const moves = [];
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++)
        if (g[r][c] === EMPTY) moves.push([r, c, scoreOn(g, r, c, p)]);
    return moves.sort((a, b) => b[2] - a[2]).slice(0, k).map(([r, c]) => [r, c]);
}

// 루트 전용: 완전 시뮬레이션 결과로 수 정렬 (알파-베타 가지치기 효율 극대화)
function topMovesQ(g, p, me, enemy, k) {
    const moves = [];
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
        if (g[r][c] !== EMPTY) continue;
        const s = evalBoard(applyMoveB(g, r, c, p), me, enemy);
        moves.push([r, c, p === me ? s : -s]);
    }
    return moves.sort((a, b) => b[2] - a[2]).slice(0, k).map(([r, c]) => [r, c]);
}

// 한 색깔의 연결된 덩어리들을 한 번의 flood-fill로 모두 찾아
// {크기, 벽 개수, 빈 칸과 맞닿은 변의 수}를 반환
function analyzeGroups(g, color) {
    const vis = Array.from({ length: N }, () => new Array(N).fill(false));
    const groups = [];
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
        if (g[r][c] !== color || vis[r][c]) continue;
        const cells = []; const q = [[r, c]]; let emptyEdges = 0; const walls = new Set();
        while (q.length) {
            const [cr, cc] = q.shift();
            if (vis[cr][cc]) continue;
            vis[cr][cc] = true; cells.push([cr, cc]);
            if (cr === 0) walls.add('T');
            if (cr === N - 1) walls.add('B');
            if (cc === 0) walls.add('L');
            if (cc === N - 1) walls.add('R');
            for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]]) {
                const nr = cr+dr, nc = cc+dc;
                if (nr < 0 || nr >= N || nc < 0 || nc >= N) continue;
                if (g[nr][nc] === EMPTY) emptyEdges++;
                else if (g[nr][nc] === color && !vis[nr][nc]) q.push([nr, nc]);
            }
        }
        groups.push({ size: cells.length, walls: walls.size, emptyEdges });
    }
    return groups;
}

// 포위 위협 점수: 거의 포위되어 곧 포획당할 위험 (벽 3개 이상 붙으면 애초에 포획 불가하므로 대상에서 제외)
function threatScore(grp) {
    if (grp.walls >= 3) return 0;
    const w = grp.emptyEdges <= 1 ? 1.8 : grp.emptyEdges <= 3 ? 0.7 : grp.emptyEdges <= 5 ? 0.25 : 0;
    return grp.size * w;
}
// 벽 부착 점수: applyEnclosures의 포획 조건이 wallsHit.size<=2 이므로,
// 벽 3개 이상 붙은 그룹은 절대 포획되지 않음 -> 그 경계에서 보너스가 크게 도약
function wallTierScore(grp) {
    const w = grp.walls >= 3 ? 1.5 : grp.walls === 2 ? 0.35 : grp.walls === 1 ? 0.1 : 0;
    return grp.size * w;
}
// 응집도 점수: 같은 면적이라도 여러 조각보다 하나로 뭉쳐 있을수록 유리
function cohesionScore(grp) {
    return grp.size * grp.size * 0.01;
}

function evalBoard(g, me, enemy) {
    let mc = 0, ec = 0;
    g.forEach(row => row.forEach(v => { if (v === me) mc++; else if (v === enemy) ec++; }));
    let score = mc - ec;
    for (const grp of analyzeGroups(g, enemy)) score += threatScore(grp) - wallTierScore(grp) - cohesionScore(grp);
    for (const grp of analyzeGroups(g, me))    score += wallTierScore(grp) + cohesionScore(grp) - threatScore(grp);
    return score;
}

function minimax(g, depth, isMax, alpha, beta, me, enemy) {
    if (depth === 0) return evalBoard(g, me, enemy);
    const p = isMax ? me : enemy;
    const beam = 12;
    const cands = topMoves(g, p, beam);
    if (!cands.length) return evalBoard(g, me, enemy);
    if (isMax) {
        let val = -Infinity;
        for (const [r, c] of cands) {
            val = Math.max(val, minimax(applyMoveB(g, r, c, p), depth-1, false, alpha, beta, me, enemy));
            alpha = Math.max(alpha, val);
            if (beta <= alpha) break;
        }
        return val;
    } else {
        let val = Infinity;
        for (const [r, c] of cands) {
            val = Math.min(val, minimax(applyMoveB(g, r, c, p), depth-1, true, alpha, beta, me, enemy));
            beta = Math.min(beta, val);
            if (beta <= alpha) break;
        }
        return val;
    }
}

function minimaxRoot(board, depth, beam, me, enemy) {
    const cands = topMovesQ(board, me, me, enemy, beam);
    if (!cands.length) return null;
    let best = cands[0], bestVal = -Infinity;
    for (const [r, c] of cands) {
        const val = minimax(applyMoveB(board, r, c, me), depth-1, false, -Infinity, Infinity, me, enemy);
        if (val > bestVal) { bestVal = val; best = [r, c]; }
    }
    return best;
}

// board에서 me(P1/P2)가 level 난이도로 둘 수를 계산. 둘 곳이 없으면 null.
function chooseMove(board, me, level) {
    const cfg = LEVEL_CFG[level] || LEVEL_CFG[3];
    const enemy = opp(me);
    return minimaxRoot(board, cfg.depth, cfg.beam, me, enemy);
}

module.exports = { chooseMove };
