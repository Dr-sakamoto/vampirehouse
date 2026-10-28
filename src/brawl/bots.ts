// ボット。人が集まらなくても押し合いの手触りを試せるように、
// 「影へ走る → 中に入ったら近くの相手を外へ押し出す」だけを素直にやる。

import { PLAYER_RADIUS, isInShelter, type Input, type Params, type World } from './sim';

/** 乱数の状態を持たずに揺らぎを出すための、tick と id からのハッシュ */
function jitter(tick: number, id: number): number {
  let h = Math.imul(tick ^ (id * 0x9e3779b1), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** 体の幅ぶん太らせた壁に、線分が触れずに通れるか（0.25m刻みで調べる） */
function lineClear(world: World, ax: number, ay: number, bx: number, by: number): boolean {
  const len = Math.hypot(bx - ax, by - ay);
  const n = Math.max(1, Math.ceil(len / 0.25));
  for (let i = 1; i <= n; i++) {
    const x = ax + ((bx - ax) * i) / n;
    const y = ay + ((by - ay) * i) / n;
    for (const w of world.walls) {
      const vx = w.bx - w.ax;
      const vy = w.by - w.ay;
      const len2 = vx * vx + vy * vy;
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - w.ax) * vx + (y - w.ay) * vy) / len2)) : 0;
      if (Math.hypot(x - (w.ax + vx * t), y - (w.ay + vy * t)) < PLAYER_RADIUS + w.r - 0.05) return false;
    }
  }
  return true;
}

/**
 * 壁で塞がれていれば、避難所を囲む8点（四隅と各辺の外）を経由して回り込む。
 * 点の数が少ないので、毎tick幅優先で引き直しても軽い。
 */
function nextWaypoint(world: World, x: number, y: number, tx: number, ty: number, h: number): { x: number; y: number } {
  if (lineClear(world, x, y, tx, ty)) return { x: tx, y: ty };
  const d = h + 1.3;
  const nodes = [
    { x: -d, y: -d }, { x: 0, y: -d }, { x: d, y: -d }, { x: d, y: 0 },
    { x: d, y: d }, { x: 0, y: d }, { x: -d, y: d }, { x: -d, y: 0 },
    { x: tx, y: ty },
  ];
  const goal = nodes.length - 1;
  const prev = new Map<number, number>();
  const queue: number[] = [];
  for (let i = 0; i < goal; i++) {
    if (lineClear(world, x, y, nodes[i].x, nodes[i].y)) {
      prev.set(i, -1);
      queue.push(i);
    }
  }
  while (queue.length > 0) {
    const i = queue.shift()!;
    if (i === goal) {
      let first = i;
      while (prev.get(first)! !== -1) first = prev.get(first)!;
      return nodes[first];
    }
    for (let j = 0; j < nodes.length; j++) {
      if (prev.has(j) || !lineClear(world, nodes[i].x, nodes[i].y, nodes[j].x, nodes[j].y)) continue;
      prev.set(j, i);
      queue.push(j);
    }
  }
  return { x: tx, y: ty };
}

export function botInput(world: World, id: number, params: Params, seq: number): Input {
  const me = world.players[id];
  if (world.phase !== 'run') return { seq, mx: 0, my: 0, shove: false };

  // 影の中の、少し散らした目標点を狙う（全員が真ん中一点に集まらないように）
  const h = params.shelterSize / 2;
  const tx = (jitter(world.round, id) - 0.5) * h;
  const ty = (jitter(world.round, id + 17) - 0.5) * h;
  const way = nextWaypoint(world, me.x, me.y, tx, ty, h);
  let mx = way.x - me.x;
  let my = way.y - me.y;

  // 影の中にいる一番近い相手へ向き直り、外へ押し出しにかかる
  let target = null as (typeof world.players)[number] | null;
  let best = Infinity;
  for (const q of world.players) {
    if (q.id === id) continue;
    const d = Math.hypot(q.x - me.x, q.y - me.y);
    if (d < best && d < PLAYER_RADIUS * 2 + params.shoveReach + 1.2) {
      best = d;
      target = q;
    }
  }
  if (target && (isInShelter(target, params) || isInShelter(me, params))) {
    // 相手の位置から影の外側へ抜ける向きで押せるよう、相手の「内側」へ回り込む
    mx = target.x - me.x - target.x * 0.3;
    my = target.y - me.y - target.y * 0.3;
  }

  const len = Math.hypot(mx, my);
  if (len < 0.15) return { seq, mx: 0, my: 0, shove: false };
  // 人間らしい反応の遅さ：毎回は押さない
  const shove = target !== null && best < PLAYER_RADIUS * 2 + params.shoveReach && jitter(world.tick, id) < 0.35;
  return { seq, mx: mx / len, my: my / len, shove };
}
