import { describe, expect, it } from 'vitest';
import {
  CASTLE_RING,
  RING_COUNT,
  SECTORS,
  VILLAGE,
  cellId,
  createBoard,
  distancesFrom,
  CAVE_COUNT,
  SHADE_COUNT,
  shortestPath,
} from './board';

describe('盤面の構造', () => {
  it('村・通常リング・城がすべて生成される', () => {
    const board = createBoard();
    expect(board.order.length).toBe(1 + RING_COUNT * SECTORS + 4);
    expect(board.cells[VILLAGE].kind).toBe('village');
    expect(board.castleCells).toHaveLength(4);
  });

  it('村は最内リングのすべてのセクターに繋がるハブ', () => {
    const board = createBoard();
    expect(board.cells[VILLAGE].neighbors.sort()).toEqual(
      Array.from({ length: SECTORS }, (_, s) => cellId(1, s)).sort(),
    );
  });

  it('通常リングのマスは横2＋内外に繋がる', () => {
    const board = createBoard();
    // 中間リングは 横2 + 内1 + 外1 = 4
    expect(board.cells[cellId(2, 0)].neighbors).toHaveLength(4);
    // 最外リングの城が付かないセクターは 横2 + 内1 = 3
    expect(board.cells[cellId(RING_COUNT, 0)].neighbors).toHaveLength(3);
    // 城が付くセクターは +1
    expect(board.cells[cellId(RING_COUNT, 1)].neighbors).toHaveLength(4);
  });

  it('隣接は必ず双方向', () => {
    const board = createBoard();
    for (const cell of Object.values(board.cells)) {
      for (const n of cell.neighbors) {
        expect(board.cells[n].neighbors).toContain(cell.id);
      }
    }
  });

  it('城から村までは5歩、往復10歩', () => {
    const board = createBoard();
    const dist = distancesFrom(board, board.castleCells[0]);
    expect(dist[VILLAGE]).toBe(RING_COUNT + 1);
    expect(dist[VILLAGE]).toBe(5);
  });

  it('4つの城はすべて村から等距離', () => {
    const board = createBoard();
    const fromVillage = distancesFrom(board, VILLAGE);
    const dists = board.castleCells.map((c) => fromVillage[c]);
    expect(new Set(dists).size).toBe(1);
  });

  it('全マスが村から到達可能', () => {
    const board = createBoard();
    const dist = distancesFrom(board, VILLAGE);
    for (const id of board.order) expect(dist[id]).toBeDefined();
  });

  it('最短経路は連続した隣接マスの列になる', () => {
    const board = createBoard();
    const path = shortestPath(board, board.castleCells[0], VILLAGE);
    expect(path).not.toBeNull();
    expect(path![0]).toBe(board.castleCells[0]);
    expect(path![path!.length - 1]).toBe(VILLAGE);
    for (let i = 1; i < path!.length; i++) {
      expect(board.cells[path![i - 1]].neighbors).toContain(path![i]);
    }
  });

  it('テントはリング2の対角2マスだけ', () => {
    const board = createBoard();
    expect(SHADE_COUNT).toBe(2);
    expect(board.shadeCells).toHaveLength(SHADE_COUNT);
    // どちらもハンターの巡回リング（リング2）の上にある ―― 命綱と死の罠が同じマス
    expect(board.shadeCells.map((id) => board.cells[id].ring)).toEqual([2, 2]);
    // 盤面の反対側同士
    const sectors = board.shadeCells.map((id) => board.cells[id].sector).sort();
    expect(Math.abs(sectors[0] - sectors[1])).toBe(SECTORS / 2);
  });

  it('テントの間隔はハンター2体の間隔と同じ ―― 8ラウンドに2回、同時に塞がる', () => {
    const board = createBoard();
    const [a, b] = board.shadeCells.map((id) => board.cells[id].sector);
    // ハンターは常に SECTORS/2 離れて同じ向きに回る（rules.ts の initialHunters）
    const hunterGap = SECTORS / 2;
    expect(Math.abs(a - b)).toBe(hunterGap);

    // 実際に一周させて、両方同時に踏まれるラウンドを数える
    let both = 0;
    for (let t = 0; t < SECTORS; t++) {
      const cells = [1, 5].map((start) => `r2s${(start + t) % SECTORS}`);
      if (board.shadeCells.every((id) => cells.includes(id))) both++;
    }
    expect(both).toBe(2);
  });

  it('避難所はテント2＋洞窟2の4マス。村から間に合うのはテントだけ', () => {
    const board = createBoard();
    expect(board.refugeCells).toHaveLength(CAVE_COUNT + SHADE_COUNT);
    expect(board.refugeCells).toHaveLength(4);
    expect(board.refugeCells).toEqual(
      expect.arrayContaining([...board.caveCells, ...board.shadeCells]),
    );
    // 夜明けは1ラウンド前に予告され、移動力は3。村から3歩以内に届くのは
    // テント2マスだけで、洞窟（4歩）にも城（5歩）にも間に合わない ――
    // 村で粘った者だけが、2つしかない椅子を奪い合うことになる
    const reachable = board.refugeCells.filter(
      (id) => shortestPath(board, VILLAGE, id)!.length - 1 <= 3,
    );
    expect(reachable.sort()).toEqual([...board.shadeCells].sort());
    for (const id of board.caveCells) {
      expect(shortestPath(board, VILLAGE, id)!.length - 1).toBeGreaterThan(3);
    }
    // 城も届かない
    for (const id of board.castleCells) {
      expect(shortestPath(board, VILLAGE, id)!.length - 1).toBeGreaterThan(3);
    }
    const inner = board.refugeCells.filter((id) => board.cells[id].ring < RING_COUNT);
    expect(inner).toHaveLength(2);
  });

  it('洞窟は最外リングの左右2つ。城の直通ルートから1歩ずれている', () => {
    const board = createBoard();
    expect(board.caveCells).toHaveLength(2);
    for (const cave of board.caveCells) {
      expect(board.cells[cave].ring).toBe(RING_COUNT);
    }
    // 東西の2マス ＝ 盤面の反対側同士
    const sectors = board.caveCells.map((id) => board.cells[id].sector).sort();
    expect(Math.abs(sectors[0] - sectors[1])).toBe(SECTORS / 2);
    const castleSectors = board.castleCells.map((c) => board.cells[c].sector);
    for (const cave of board.caveCells) {
      expect(castleSectors).not.toContain(board.cells[cave].sector);
    }
  });

  it('城は最外リングのさらに外側にある', () => {
    const board = createBoard();
    for (const c of board.castleCells) expect(board.cells[c].ring).toBe(CASTLE_RING);
  });
});
