// ボット。人が集まらなくても押し合いと行き先の判断を試せるように、素直な方針で動く。
//   夜の村: 戦ごとに「これだけ吸ったら帰る」量（欲）を決め、近くの村人から吸う。
//           欲が満ちたら、夜明けを待たずに城へ帰り始める。吸っている相手が邪魔なら時々押しのける
//   夜明け:
//   1. 自分の城に余裕をもって間に合うなら城へ（遠いが確実）
//   2. 間に合わなければ、影の落ちた廃墟のうち一番早く着くところへ（近いが乱闘になる）
//   3. 着いたら、近くの相手を影の外へ押し出しにかかる

import { Nav } from './nav';
import {
  PLAYER_RADIUS,
  SUCK_RANGE,
  refugeOf,
  speedOf,
  villagerInReach,
  type Input,
  type Params,
  type Player,
  type World,
} from './sim';

const idle = (seq: number): Input => ({ seq, mx: 0, my: 0, ax: 0, ay: 0, shove: false, suck: false });

/** 戦ごとの、そのボットの欲（dL）。20〜120 */
function greedOf(round: number, id: number): number {
  return 20 + Math.round(jitter(round * 7 + 3, id) * 10) * 10;
}

/** 乱数の状態を持たずに揺らぎを出すための、tick と id からのハッシュ */
function jitter(tick: number, id: number): number {
  let h = Math.imul(tick ^ (id * 0x9e3779b1), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

interface Goal {
  /** 距離場を引く点（廃墟や城の中心）。12か所しかないので距離場を使い回せる */
  x: number;
  y: number;
  /** 最後の1mで向かう点。全員が中心一点に集まらないよう、少し散らしてある */
  fx: number;
  fy: number;
  kind: 'castle' | 'ruin';
}

/** 戦ごとの道案内と、各ボットの行き先を覚えておく */
export class BotBrain {
  private nav: Nav | null = null;
  /** 道案内を作ったときの廃墟の広さ。地形が変わるのはこれが変わったときだけ */
  private navHalf = -1;
  private round = -1;
  private goals = new Map<number, Goal>();
  private decidedAt = new Map<number, number>();

  input(world: World, id: number, params: Params, seq: number): Input {
    if (world.round !== this.round) {
      this.round = world.round;
      const half = world.ruins[0]?.half ?? 0;
      if (!this.nav || half !== this.navHalf) {
        this.nav = new Nav(world.walls);
        this.navHalf = half;
        // 走り出しの瞬間に計算が集中して画面が止まらないよう、行き先の候補はすべて先に引いておく
        for (const z of [...world.ruins, ...world.castles]) this.nav.distance(z.cx, z.cy, 0, 0);
      }
      this.goals.clear();
      this.decidedAt.clear();
    }
    const me = world.players[id];
    const nav = this.nav!;
    if (world.phase === 'village') return this.night(world, me, params, seq, nav);
    if (world.phase !== 'run') return idle(seq);

    // 行き先は0.5秒ごとに考え直す（押し出されて間に合わなくなったら乗り換える）
    if (!this.goals.has(id) || world.tick - (this.decidedAt.get(id) ?? 0) > 30) {
      this.goals.set(id, this.choose(world, me, params, nav));
      this.decidedAt.set(id, world.tick);
    }
    const goal = this.goals.get(id)!;

    const near = Math.hypot(goal.x - me.x, goal.y - me.y) < 1.5;
    const way = near ? { x: goal.fx, y: goal.fy } : nav.nextPoint(goal.x, goal.y, me.x, me.y);
    let mx = way.x - me.x;
    let my = way.y - me.y;

    // 廃墟の近くでは、一番近い相手の「内側」へ回り込んで外へ押し出しにかかる
    let target: Player | null = null;
    let best = Infinity;
    if (goal.kind === 'ruin' && Math.hypot(goal.x - me.x, goal.y - me.y) < 3) {
      for (const q of world.players) {
        if (q.id === id) continue;
        const d = Math.hypot(q.x - me.x, q.y - me.y);
        if (d < best && d < PLAYER_RADIUS * 2 + params.shoveReach + 1.2) {
          best = d;
          target = q;
        }
      }
      if (target) {
        mx = target.x - me.x - (target.x - goal.x) * 0.3;
        my = target.y - me.y - (target.y - goal.y) * 0.3;
      }
    }

    const len = Math.hypot(mx, my);
    if (len < 0.15) return idle(seq);
    // 人間らしい反応の遅さ：毎回は押さない
    const shove = target !== null && best < PLAYER_RADIUS * 2 + params.shoveReach && jitter(world.tick, id) < 0.35;
    return { seq, mx: mx / len, my: my / len, ax: 0, ay: 0, shove, suck: false };
  }

  /** 夜の村。欲が満ちるまで吸い、満ちたら（あるいは村人が尽きたら）城へ帰り始める */
  private night(world: World, me: Player, params: Params, seq: number, nav: Nav): Input {
    const castle = world.castles[me.id];
    const anyLeft = world.villagers.some((v) => v.blood > 0);
    if (me.blood >= greedOf(world.round, me.id) || !anyLeft) {
      if (!castle) return idle(seq);
      const near = Math.hypot(castle.cx - me.x, castle.cy - me.y) < 1.5;
      const way = near ? { x: castle.cx, y: castle.cy } : nav.nextPoint(castle.cx, castle.cy, me.x, me.y);
      const dx = way.x - me.x;
      const dy = way.y - me.y;
      const len = Math.hypot(dx, dy);
      return len < 0.15 ? idle(seq) : { ...idle(seq), mx: dx / len, my: dy / len };
    }

    // 手の届く村人がいれば吸う。同じ村人に誰かが張り付いていたら、時々押しのける
    const reach = villagerInReach(world, me);
    if (reach >= 0) {
      const rival = world.players.find(
        (q) => q.id !== me.id && q.sucking === reach && Math.hypot(q.x - me.x, q.y - me.y) < PLAYER_RADIUS * 2 + params.shoveReach,
      );
      if (rival && me.shoveCd <= 0 && jitter(world.tick, me.id + 5) < 0.03) {
        const dx = rival.x - me.x;
        const dy = rival.y - me.y;
        const len = Math.hypot(dx, dy) || 1;
        return { ...idle(seq), ax: dx / len, ay: dy / len, shove: true };
      }
      return { ...idle(seq), suck: true };
    }

    // 血の残っている一番近い村人へ歩く（広場には障害物が無いので真っすぐ）
    let target = -1;
    let bestD = Infinity;
    world.villagers.forEach((v, i) => {
      if (v.blood <= 0) return;
      const d = Math.hypot(v.x - me.x, v.y - me.y);
      if (d < bestD) {
        bestD = d;
        target = i;
      }
    });
    if (target < 0) return idle(seq);
    const v = world.villagers[target];
    const dx = v.x - me.x;
    const dy = v.y - me.y;
    const len = Math.hypot(dx, dy);
    if (len < SUCK_RANGE * 0.6) return { ...idle(seq), suck: true };
    return { ...idle(seq), mx: dx / len, my: dy / len };
  }

  private choose(world: World, me: Player, params: Params, nav: Nav): Goal {
    const speed = speedOf(me, params);
    const left = world.phaseLeft;

    // もう安全な場所にいるなら、そこに留まる
    const here = refugeOf(me, world);
    const castle = world.castles[me.id];
    const toCastle: Goal | null = castle
      ? { x: castle.cx, y: castle.cy, fx: castle.cx, fy: castle.cy, kind: 'castle' }
      : null;
    if (here === 'castle' && toCastle) return toCastle;

    if (castle && toCastle) {
      const t = nav.distance(castle.cx, castle.cy, me.x, me.y) / speed;
      if (t < left - 0.8) return toCastle;
    }

    // 影の落ちた廃墟の中で、着くまでの時間が一番短いところ。少しだけ散らす
    let goal: Goal | null = null;
    let bestT = Infinity;
    for (const r of world.ruins) {
      if (!r.shaded) continue;
      const t = nav.distance(r.cx, r.cy, me.x, me.y) / speed + jitter(world.round * 31 + r.cx, me.id) * 0.8;
      if (t < bestT) {
        bestT = t;
        const fx = r.cx + (jitter(world.round, me.id) - 0.5) * r.half;
        const fy = r.cy + (jitter(world.round, me.id + 17) - 0.5) * r.half;
        goal = { x: r.cx, y: r.cy, fx, fy, kind: 'ruin' };
      }
    }
    return goal ?? toCastle ?? { x: me.x, y: me.y, fx: me.x, fy: me.y, kind: 'ruin' };
  }
}
