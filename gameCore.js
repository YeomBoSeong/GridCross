const EMPTY = 0, P1 = 1, P2 = 2;
const N = 12;

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

function emptyBoard() {
    return Array.from({ length: N }, () => new Array(N).fill(EMPTY));
}

module.exports = { EMPTY, P1, P2, N, pts, cnt, applyEnclosures, emptyBoard };
