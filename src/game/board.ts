import type { Board, Cell, CellKind } from './types';

/** 放射線で区切られたセクター数（8方位） */
export const SECTORS = 8;
/** 村（ring 0）の外側にある通常リングの数 */
export const RING_COUNT = 4;
/** 城は最外リングのさらに外側にぶら下がる */
export const CASTLE_RING = RING_COUNT + 1;

export const VILLAGE = 'village';

/** 城が接続するセクター（斜め四隅: NE, NW, SW, SE） */
export const CASTLE_SECTORS = [1, 3, 5, 7];

/**
 * 洞窟は最外リング（リング4）の左右2つだけ。城の導線（斜め4方向）からは
 * 1マス横にずれた東西に置く。
 *
 * 外周に避難所を出すと「帰るか隠れるか」の判断が消える、というのが以前の
 * 判断だったが、実測は逆だった ―― 外周の避難所は自分の城とほぼ同じ距離に
 * あるので、椅子としては城の劣化版にしかならず（座っても得点にならない）、
 * 代わりに盤の中ほどから椅子が消える。洞窟をここへ出したぶん、
 * 内側の椅子はテントで補っている（SHADE_POSITIONS）。
 */
const CAVE_POSITIONS: Array<[number, number]> = [
  [4, 2],
  [4, 6],
];

/**
 * 日陰（テント）は4マス。リング2の対角2マス（南北）はハンターの巡回リング上
 * ＝ 命綱と死の罠が同じマス。リング3の2マス（東西）は洞窟の1つ内側にあり、
 * 洞窟が外周へ出たぶんの「盤の中ほどの椅子」を受け持つ。
 * 洞窟2つも日陰を兼ねるので、避難所は 4 + 2 の計6マス（すべて定員1）。
 */
const SHADE_POSITIONS: Array<[number, number]> = [
  [2, 0],
  [2, 4],
  [3, 2],
  [3, 6],
];

export function cellId(ring: number, sector: number): string {
  if (ring === 0) return VILLAGE;
  if (ring === CASTLE_RING) return `castle${CASTLE_SECTORS.indexOf(sector)}`;
  return `r${ring}s${sector}`;
}

export function wrapSector(sector: number): number {
  return ((sector % SECTORS) + SECTORS) % SECTORS;
}

/** 日陰（テント）の総数。定員1なので、実質的な数はハンターの位置で毎ラウンド変わる */
export const SHADE_COUNT = SHADE_POSITIONS.length;
/** 洞窟の総数。洞窟は日陰を兼ねる（岩陰が陽を遮る、という世界観のまま避難所になる） */
export const CAVE_COUNT = CAVE_POSITIONS.length;

/** 夜明けをやり過ごせるマスの種類。城は別枠（常に安全・所有者だけ入れる） */
export function isRefugeKind(kind: CellKind): boolean {
  return kind === 'shade' || kind === 'cave';
}

export function createBoard(): Board {
  const cells: Record<string, Cell> = {};
  const order: string[] = [];

  const shadeSet = new Set(SHADE_POSITIONS.map(([r, s]) => cellId(r, s)));
  const caveSet = new Set(CAVE_POSITIONS.map(([r, s]) => cellId(r, s)));

  const add = (cell: Cell) => {
    cells[cell.id] = cell;
    order.push(cell.id);
  };

  // 中心の村
  add({ id: VILLAGE, kind: 'village', ring: 0, sector: 0, neighbors: [] });

  // 通常リング
  for (let ring = 1; ring <= RING_COUNT; ring++) {
    for (let sector = 0; sector < SECTORS; sector++) {
      const id = cellId(ring, sector);
      let kind: CellKind = 'plain';
      if (shadeSet.has(id)) kind = 'shade';
      else if (caveSet.has(id)) kind = 'cave';
      add({ id, kind, ring, sector, neighbors: [] });
    }
  }

  // 四隅の城
  CASTLE_SECTORS.forEach((sector, i) => {
    add({
      id: cellId(CASTLE_RING, sector),
      kind: 'castle',
      ring: CASTLE_RING,
      sector,
      castleOf: i,
      neighbors: [],
    });
  });

  // 隣接関係を張る
  const link = (a: string, b: string) => {
    if (!cells[a].neighbors.includes(b)) cells[a].neighbors.push(b);
    if (!cells[b].neighbors.includes(a)) cells[b].neighbors.push(a);
  };

  for (let sector = 0; sector < SECTORS; sector++) {
    // 村 <-> リング1（村はハブ。全セクターに繋がる）
    link(VILLAGE, cellId(1, sector));

    for (let ring = 1; ring <= RING_COUNT; ring++) {
      // 同心円に沿った横移動
      link(cellId(ring, sector), cellId(ring, wrapSector(sector + 1)));
      // 放射線に沿った内外移動
      if (ring < RING_COUNT) link(cellId(ring, sector), cellId(ring + 1, sector));
    }
  }

  // 城 <-> 最外リング
  CASTLE_SECTORS.forEach((sector) => {
    link(cellId(CASTLE_RING, sector), cellId(RING_COUNT, sector));
  });

  return {
    cells,
    order,
    sectors: SECTORS,
    ringCount: RING_COUNT,
    castleRing: CASTLE_RING,
    castleCells: CASTLE_SECTORS.map((s) => cellId(CASTLE_RING, s)),
    shadeCells: order.filter((id) => cells[id].kind === 'shade'),
    caveCells: order.filter((id) => cells[id].kind === 'cave'),
    refugeCells: order.filter((id) => isRefugeKind(cells[id].kind)),
  };
}

export function castleOf(board: Board, playerIndex: number): string {
  return board.castleCells[playerIndex % board.castleCells.length];
}

/** 幅優先で全マスへの最短距離を返す */
export function distancesFrom(board: Board, from: string): Record<string, number> {
  const dist: Record<string, number> = { [from]: 0 };
  const queue: string[] = [from];
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head];
    for (const n of board.cells[id].neighbors) {
      if (dist[n] === undefined) {
        dist[n] = dist[id] + 1;
        queue.push(n);
      }
    }
  }
  return dist;
}

/** from から to への最短経路（from を含む）。到達不能なら null */
export function shortestPath(board: Board, from: string, to: string): string[] | null {
  if (from === to) return [from];
  const prev: Record<string, string> = {};
  const seen = new Set([from]);
  const queue = [from];
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head];
    for (const n of board.cells[id].neighbors) {
      if (seen.has(n)) continue;
      seen.add(n);
      prev[n] = id;
      if (n === to) {
        const path = [to];
        let cur = to;
        while (cur !== from) {
          cur = prev[cur];
          path.unshift(cur);
        }
        return path;
      }
      queue.push(n);
    }
  }
  return null;
}
