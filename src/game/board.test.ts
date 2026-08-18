import { describe, expect, it } from 'vitest';
import {
  CASTLE_RING,
  RING_COUNT,
  SECTORS,
  VILLAGE,
  cellId,
  createBoard,
  distancesFrom,
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

  it('日陰は外周4＋深部4の計8マス', () => {
    const board = createBoard();
    expect(SHADE_COUNT).toBe(8);
    expect(board.shadeCells).toHaveLength(SHADE_COUNT);
    // 深部の日陰はハンターの巡回リング(2)上にあり、常に使えるとは限らない
    const rings = board.shadeCells.map((id) => board.cells[id].ring).sort();
    expect(rings).toEqual([2, 2, 2, 2, 4, 4, 4, 4]);
  });

  it('洞窟は4つあり、城の直通ルートから1歩ずれている', () => {
    const board = createBoard();
    expect(board.caveCells).toHaveLength(4);
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
