// ボットの道案内。地面を0.5m四方の格子に区切り、目的地からの歩く距離を全マスに書き込んでおく（距離場）。
// ボットは自分のマスから、距離が一番小さい隣のマスへ向かうだけで、家や壁を回り込んで目的地へ着く。
// 地形は戦ごとにしか変わらないので、目的地ごとに一度だけ計算して使い回す。

import { ARENA_HALF } from './map';
import { PLAYER_RADIUS, closestOnWall, type Wall } from './sim';

const CELL = 0.5;
const N = Math.round((ARENA_HALF * 2) / CELL);
const SQRT2 = Math.SQRT2;

export class Nav {
  /** 体が壁にめり込むマス */
  private readonly blocked: Uint8Array;
  private readonly fields = new Map<string, Float64Array>();

  constructor(walls: Wall[]) {
    this.blocked = new Uint8Array(N * N);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const [x, y] = center(i, j);
        for (const w of walls) {
          const c = closestOnWall(w, x, y);
          // 少しだけ甘く取る。格子の粗さで、人なら通れる路地が塞がって見えないように
          if (Math.hypot(x - c.x, y - c.y) < PLAYER_RADIUS + w.r - 0.12) {
            this.blocked[j * N + i] = 1;
            break;
          }
        }
      }
    }
  }

  /** (x, y) から目的地までの歩く距離（m）。たどり着けなければ Infinity */
  distance(tx: number, ty: number, x: number, y: number): number {
    const field = this.field(tx, ty);
    const [i, j] = cellOf(x, y);
    return field[this.nearestOpen(i, j)] * CELL;
  }

  /** 次に向かう点。目的地が見えるほど近ければ目的地そのもの */
  nextPoint(tx: number, ty: number, x: number, y: number): { x: number; y: number } {
    const field = this.field(tx, ty);
    const [i0, j0] = cellOf(x, y);
    const here = this.nearestOpen(i0, j0);
    if (field[here] <= 2) return { x: tx, y: ty };
    let best = here;
    const hi = here % N;
    const hj = Math.floor(here / N);
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const i = hi + di;
        const j = hj + dj;
        if (i < 0 || j < 0 || i >= N || j >= N) continue;
        if (field[j * N + i] < field[best]) best = j * N + i;
      }
    }
    // 自分のマスが塞がっていた（壁に押し付けられている）ときは、空いたマスへ戻るのが先
    if (best === here && here !== i0 + j0 * N) {
      const [x2, y2] = center(hi, hj);
      return { x: x2, y: y2 };
    }
    const [bx, by] = center(best % N, Math.floor(best / N));
    return { x: bx, y: by };
  }

  private nearestOpen(i: number, j: number): number {
    const ci = clampCell(i);
    const cj = clampCell(j);
    if (!this.blocked[cj * N + ci]) return cj * N + ci;
    for (let r = 1; r < 6; r++) {
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          const ii = ci + di;
          const jj = cj + dj;
          if (ii < 0 || jj < 0 || ii >= N || jj >= N) continue;
          if (!this.blocked[jj * N + ii]) return jj * N + ii;
        }
      }
    }
    return cj * N + ci;
  }

  private field(tx: number, ty: number): Float64Array {
    const key = `${tx.toFixed(1)},${ty.toFixed(1)}`;
    const cached = this.fields.get(key);
    if (cached) return cached;
    const field = this.dijkstra(tx, ty);
    this.fields.set(key, field);
    return field;
  }

  /** 8近傍のダイクストラ。斜めは、両脇のマスが空いているときだけ通れる（角をすり抜けない） */
  private dijkstra(tx: number, ty: number): Float64Array {
    const dist = new Float64Array(N * N).fill(Infinity);
    const [ti, tj] = cellOf(tx, ty);
    const start = this.nearestOpen(ti, tj);
    dist[start] = 0;
    const heap = new MinHeap();
    heap.push(start, 0);
    while (heap.size > 0) {
      const [cur, d] = heap.pop();
      if (d > dist[cur]) continue;
      const ci = cur % N;
      const cj = Math.floor(cur / N);
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (di === 0 && dj === 0) continue;
          const i = ci + di;
          const j = cj + dj;
          if (i < 0 || j < 0 || i >= N || j >= N) continue;
          const k = j * N + i;
          if (this.blocked[k]) continue;
          const diagonal = di !== 0 && dj !== 0;
          if (diagonal && (this.blocked[cj * N + i] || this.blocked[j * N + ci])) continue;
          const nd = d + (diagonal ? SQRT2 : 1);
          if (nd < dist[k]) {
            dist[k] = nd;
            heap.push(k, nd);
          }
        }
      }
    }
    return dist;
  }
}

function clampCell(v: number): number {
  return Math.max(0, Math.min(N - 1, v));
}

function cellOf(x: number, y: number): [number, number] {
  return [clampCell(Math.floor((x + ARENA_HALF) / CELL)), clampCell(Math.floor((y + ARENA_HALF) / CELL))];
}

function center(i: number, j: number): [number, number] {
  return [-ARENA_HALF + (i + 0.5) * CELL, -ARENA_HALF + (j + 0.5) * CELL];
}

class MinHeap {
  private keys: number[] = [];
  private prios: number[] = [];

  get size(): number {
    return this.keys.length;
  }

  push(key: number, prio: number): void {
    this.keys.push(key);
    this.prios.push(prio);
    let i = this.keys.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.prios[parent] <= this.prios[i]) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): [number, number] {
    const top: [number, number] = [this.keys[0], this.prios[0]];
    const lastKey = this.keys.pop()!;
    const lastPrio = this.prios.pop()!;
    if (this.keys.length > 0) {
      this.keys[0] = lastKey;
      this.prios[0] = lastPrio;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < this.keys.length && this.prios[l] < this.prios[m]) m = l;
        if (r < this.keys.length && this.prios[r] < this.prios[m]) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    [this.keys[a], this.keys[b]] = [this.keys[b], this.keys[a]];
    [this.prios[a], this.prios[b]] = [this.prios[b], this.prios[a]];
  }
}
