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

  it('日陰（テント）は4マス。リング2の南北とリング3の東西', () => {
    const board = createBoard();
    expect(SHADE_COUNT).toBe(4);
    expect(board.shadeCells).toHaveLength(SHADE_COUNT);
    // リング2の2マスはハンターの巡回リング上にあり、常に使えるとは限らない
    const rings = board.shadeCells.map((id) => board.cells[id].ring).sort();
    expect(rings).toEqual([2, 2, 3, 3]);
    // 同じリングの2マスは盤面の反対側同士。片方が塞がれても、もう片方は遠い
    for (const ring of [2, 3]) {
      const sectors = board.shadeCells
        .filter((id) => board.cells[id].ring === ring)
        .map((id) => board.cells[id].sector)
        .sort();
      expect(Math.abs(sectors[0] - sectors[1])).toBe(SECTORS / 2);
    }
  });

  it('避難所はテント4＋洞窟2の6マス。うち4マスは盤の内側に残る', () => {
    const board = createBoard();
    expect(board.refugeCells).toHaveLength(CAVE_COUNT + SHADE_COUNT);
    expect(board.refugeCells).toHaveLength(6);
    expect(board.refugeCells).toEqual(
      expect.arrayContaining([...board.caveCells, ...board.shadeCells]),
    );
    // 洞窟は最外リングへ出したが、内側の椅子（テント）は残す。
    // 盤の中ほどに避難所が1つも無いと、村で粘った者の逃げ場が城だけになる
    const inner = board.refugeCells.filter((id) => board.cells[id].ring < RING_COUNT);
    expect(inner).toHaveLength(4);
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
