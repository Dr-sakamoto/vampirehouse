// 夜明けの乱闘 —— 試作3。夜の村で血を吸い、いつ来るか分からない夜明けに、
// 影の落ちた廃墟か自分の城へ逃げ込むまでを切り出したシミュレーション。
// 見た目は3Dだが、判定はすべて平面上の「円（吸血鬼）と線分（壁）」で行う。
// DOM にも通信にも依存しない純粋なロジックで、サーバーとクライアント予測の両方がこれを回す。

import { nextRandom } from '../game/rng';
import { buildWalls, createCastles, createRuins, inZone, type Castle, type Ruin, type Wall } from './map';

export { LAYOUT_NAMES, type Layout, type Wall } from './map';

export const PLAYER_RADIUS = 0.5;
/** 「満タン」の目安（dL）。重さと遅さはこの量を基準に効く。人ひとりがおよそ50dL */
export const BLOOD_MAX = 100;
/** 抱えられる血の上限（dL）。これ以上は吸えない */
export const CARRY_MAX = 200;
/** 村人から吸える距離（体の中心どうし、m） */
export const SUCK_RANGE = 1.2;

/** 遊びながら動かす調整つまみ。サーバーとクライアントで同じ値を使う */
export interface Params {
  /** 影が落ちてから朝までの時間（秒）。0になった瞬間に判定 */
  runTime: number;
  /** 素の移動速度（m/s） */
  baseSpeed: number;
  /** 血を満タンに抱えたときに失う速さの割合 */
  bloodSlow: number;
  /** どれだけ抱えても、これより遅くはならない（m/s） */
  minSpeed: number;
  /** 血を満タンに抱えたときに増える重さ（素の重さ1に足す） */
  bloodMass: number;
  /** 突き飛ばしの強さ（衝撃量） */
  shoveForce: number;
  /** 突き飛ばしの待ち時間（秒）。一度押したら、これだけ経つまで次は押せない */
  shoveCooldown: number;
  /** 体の縁からどこまで手が届くか（m） */
  shoveReach: number;
  /** 弾かれた勢いの減り方（大きいほどすぐ止まる） */
  knockFriction: number;
  /**
   * 弾かれている間の、自分の足の効きにくさ。勢いがこの速さ（m/s）のとき足の効きが半分になる。
   * 小さいほど、弾かれた者は踏ん張れずに飛ばされる
   */
  knockControl: number;
  /** 壁に当たったときの跳ね返り（0=吸い付く、1=完全に跳ね返る） */
  wallBounce: number;
  /** 廃墟（影）の一辺（m） */
  shelterSize: number;
  /** 影が落ちる廃墟の数。0 なら人数から決める（人数の半分、最低1） */
  shadeCount: number;
  /** 吸う速さ（dL/秒） */
  suckRate: number;
  /** 村人ひとりが持っている血（dL） */
  villagerBlood: number;
  /** 夜が必ず続く時間（秒）。これを過ぎると、いつ白んでもおかしくない */
  dawnMin: number;
  /** その先、夜明けまでの平均の待ち時間（秒）。毎瞬同じ確率で白む（指数分布） */
  dawnMean: number;
}

export const DEFAULT_PARAMS: Params = {
  runTime: 6.5,
  baseSpeed: 5.5,
  bloodSlow: 0.5,
  minSpeed: 2.5,
  bloodMass: 1.5,
  shoveForce: 16,
  shoveCooldown: 1,
  shoveReach: 0.7,
  knockFriction: 3,
  knockControl: 3,
  // 強く弾かれても、壁が勢いを吸って中に留まれるように低めにしてある
  wallBounce: 0.2,
  // 3〜4人が入って押し合える広さ
  shelterSize: 3.6,
  shadeCount: 0,
  suckRate: 8,
  villagerBlood: 60,
  dawnMin: 5,
  dawnMean: 5,
};

export interface Input {
  /** 入力の通し番号。サーバーがどこまで処理したかを返すのに使う */
  seq: number;
  /** 移動方向（長さ1以下） */
  mx: number;
  my: number;
  /**
   * 向いている方向（長さ1、または 0,0）。一人称視点では視線がそのまま向きになり、
   * 突き飛ばしは歩く方向ではなく見ている方向へ出る。0,0 なら歩く方向を向く（見下ろし視点）
   */
  ax: number;
  ay: number;
  /** この入力の瞬間に突き飛ばしボタンが押された */
  shove: boolean;
  /** 吸うボタンを押し続けている */
  suck: boolean;
}

export const IDLE_INPUT: Input = { seq: 0, mx: 0, my: 0, ax: 0, ay: 0, shove: false, suck: false };

export interface Player {
  id: number;
  name: string;
  bot: boolean;
  x: number;
  y: number;
  /** 突き飛ばされた勢い。自分の足による速度とは別に持ち、時間で減衰する */
  kx: number;
  ky: number;
  /** 向いている方向（単位ベクトル）。突き飛ばしはこちらへ出る */
  fx: number;
  fy: number;
  blood: number;
  /** 今吸っている村人の番号。吸っていなければ -1 */
  sucking: number;
  shoveCd: number;
  alive: boolean;
  /** 生き延びて持ち帰った血の合計（試作の得点） */
  score: number;
  /** 前の戦でどこに逃げ込んだか（結果表示用） */
  refuge: 'castle' | 'ruin' | null;
  /** サーバーが最後に処理した入力番号 */
  lastSeq: number;
  /** 最後に受け取った入力。予測で他人を動かすのに使う */
  lastInput: Input;
}

/** 村の広場に立つ村人。吸い尽くされると倒れる。ぶつからない（吸血鬼は重なって立てる） */
export interface Villager {
  x: number;
  y: number;
  blood: number;
}

/** village: 夜の村で吸う（夜明けがいつ来るかは分からない） → run: 白んでから朝まで → result */
export type Phase = 'village' | 'run' | 'result';

export interface ShoveEvent {
  tick: number;
  from: number;
  hit: number[];
}

export interface World {
  tick: number;
  phase: Phase;
  /** 今のフェーズの残り秒 */
  phaseLeft: number;
  round: number;
  ruins: Ruin[];
  castles: Castle[];
  walls: Wall[];
  villagers: Villager[];
  players: Player[];
  rng: number;
  shoves: ShoveEvent[];
}

const RESULT_TIME = 3;
/** 夜がいくら長引いても、ここで打ち切る（秒） */
const NIGHT_MAX = 40;
/** 突き飛ばしが届く向きの幅（正面から左右それぞれ） */
const SHOVE_CONE_COS = Math.cos((75 * Math.PI) / 180);

export const PLAYER_NAMES = ['あなた', 'ボットA', 'ボットB', 'ボットC'];

export function createWorld(playerCount: number, seed: number, params: Params = DEFAULT_PARAMS): World {
  const players: Player[] = [];
  for (let id = 0; id < playerCount; id++) {
    players.push({
      id,
      name: PLAYER_NAMES[id] ?? `P${id + 1}`,
      bot: id !== 0,
      x: 0,
      y: 0,
      kx: 0,
      ky: 0,
      fx: 0,
      fy: -1,
      blood: 0,
      sucking: -1,
      shoveCd: 0,
      alive: true,
      score: 0,
      refuge: null,
      lastSeq: 0,
      lastInput: IDLE_INPUT,
    });
  }
  const world: World = {
    tick: 0,
    phase: 'village',
    phaseLeft: 0,
    round: 0,
    ruins: createRuins(),
    castles: createCastles(),
    walls: [],
    villagers: [],
    players,
    rng: seed >>> 0,
    shoves: [],
  };
  startRound(world, params);
  return world;
}

function random(world: World): number {
  const r = nextRandom(world.rng);
  world.rng = r.state;
  return r.value;
}

export function shadeCountFor(world: World, params: Params): number {
  const n = params.shadeCount > 0 ? params.shadeCount : Math.max(1, Math.floor(world.players.length / 2));
  return Math.min(n, world.ruins.length);
}

/**
 * 夜を始める。村人を広場に立たせ、全員を血0で広場の縁に並べる。
 * 夜明けの時刻はここで引くが、誰にも見せない（決めるのは「いつまで吸うか」で、振られるのはそのあと）
 */
export function startRound(world: World, params: Params): void {
  world.round += 1;
  world.phase = 'village';
  const wait = -Math.log(1 - random(world)) * params.dawnMean;
  world.phaseLeft = Math.min(NIGHT_MAX, params.dawnMin + wait);

  const half = params.shelterSize / 2;
  for (const r of world.ruins) {
    r.half = half;
    r.shaded = false;
  }
  world.walls = buildWalls(world.ruins, world.castles, half);

  // 村人は人数の倍。取り合いになるが、全員が吸い続けても数秒では尽きない
  const n = world.players.length;
  const count = n * 2;
  const vOffset = random(world) * Math.PI * 2;
  world.villagers = [];
  for (let i = 0; i < count; i++) {
    const angle = vOffset + (i / count) * Math.PI * 2;
    const r = i % 2 === 0 ? 1.0 : 2.0;
    world.villagers.push({ x: Math.cos(angle) * r, y: Math.sin(angle) * r, blood: params.villagerBlood });
  }

  const offset = random(world) * Math.PI * 2;
  for (const p of world.players) {
    const angle = offset + (p.id / n) * Math.PI * 2;
    p.x = Math.cos(angle) * 2.8;
    p.y = Math.sin(angle) * 2.8;
    p.kx = 0;
    p.ky = 0;
    // 広場の中（村人のほう）を向いて始まる
    p.fx = -Math.cos(angle);
    p.fy = -Math.sin(angle);
    p.blood = 0;
    p.sucking = -1;
    p.shoveCd = 0;
    p.alive = true;
    p.refuge = null;
  }
}

/** 空が白む。ここで初めて、雲の影が落ちる廃墟が決まる */
function dawn(world: World, params: Params): void {
  const order = world.ruins.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random(world) * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  for (const i of order.slice(0, shadeCountFor(world, params))) world.ruins[i].shaded = true;
  for (const p of world.players) p.sucking = -1;
  world.phase = 'run';
  world.phaseLeft = params.runTime;
}

/** 手の届く村人のうち、血の残っている一番近い者。いなければ -1 */
export function villagerInReach(world: World, p: { x: number; y: number }): number {
  let best = -1;
  let bestD = SUCK_RANGE;
  world.villagers.forEach((v, i) => {
    if (v.blood <= 0) return;
    const d = Math.hypot(v.x - p.x, v.y - p.y);
    if (d <= bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

/** 朝の光から身を守れる場所にいるか。自分の城か、影の落ちた廃墟だけ。体の中心で判定する */
export function refugeOf(p: Player, world: World): 'castle' | 'ruin' | null {
  const own = world.castles[p.id];
  if (own && inZone(p, own)) return 'castle';
  if (world.ruins.some((r) => r.shaded && inZone(p, r))) return 'ruin';
  return null;
}

export function speedOf(p: Player, params: Params): number {
  const slowed = params.baseSpeed * (1 - params.bloodSlow * (p.blood / BLOOD_MAX));
  return Math.max(params.minSpeed, slowed);
}

export function massOf(p: Player, params: Params): number {
  return 1 + params.bloodMass * (p.blood / BLOOD_MAX);
}

/** 1ステップ進める。world を破壊的に更新する（src/game/rules.ts と同じ流儀） */
export function step(world: World, inputs: ReadonlyMap<number, Input>, params: Params, dt: number): void {
  world.tick += 1;
  world.phaseLeft -= dt;
  world.shoves = world.shoves.filter((s) => world.tick - s.tick < 20);

  // 入力の受領はフェーズに関係なく記録する（止まっている間の入力も「処理済み」にしないと予測が溜まり続ける）
  for (const p of world.players) {
    const input = inputs.get(p.id);
    if (!input) continue;
    p.lastInput = input;
    if (input.seq > p.lastSeq) p.lastSeq = input.seq;
  }

  if (world.phase === 'result') {
    if (world.phaseLeft <= 0) startRound(world, params);
    return;
  }

  for (const p of world.players) {
    const input = inputs.get(p.id) ?? IDLE_INPUT;
    p.shoveCd = Math.max(0, p.shoveCd - dt);

    // 吸っている間は動けない。手の届く村人がいなければ吸えない
    p.sucking = world.phase === 'village' && input.suck && p.blood < CARRY_MAX ? villagerInReach(world, p) : -1;
    if (p.sucking >= 0) {
      const v = world.villagers[p.sucking];
      const take = Math.min(params.suckRate * dt, v.blood, CARRY_MAX - p.blood);
      v.blood -= take;
      p.blood += take;
      const d = Math.hypot(v.x - p.x, v.y - p.y);
      if (d > 1e-6) {
        p.fx = (v.x - p.x) / d;
        p.fy = (v.y - p.y) / d;
      }
      continue;
    }

    const len = Math.hypot(input.mx, input.my);
    if (len > 0.05) {
      // 弾かれている最中は足が効かない。すぐ歩いて押し戻せると、突き飛ばしが効いて見えない
      const control = 1 / (1 + Math.hypot(p.kx, p.ky) / params.knockControl);
      const scale = (Math.min(1, len) / len) * control;
      const speed = speedOf(p, params);
      p.x += input.mx * scale * speed * dt;
      p.y += input.my * scale * speed * dt;
      p.fx = input.mx / len;
      p.fy = input.my / len;
    }
    const aim = Math.hypot(input.ax, input.ay);
    if (aim > 0.05) {
      p.fx = input.ax / aim;
      p.fy = input.ay / aim;
    }
  }

  // 突き飛ばしは全員の移動が済んでから、同じ瞬間の位置で判定する
  for (const p of world.players) {
    const input = inputs.get(p.id) ?? IDLE_INPUT;
    if (input.shove && p.shoveCd <= 0) shove(world, p, params);
  }

  const decay = Math.exp(-params.knockFriction * dt);
  for (const p of world.players) {
    p.x += p.kx * dt;
    p.y += p.ky * dt;
    p.kx *= decay;
    p.ky *= decay;
  }

  // 押し合いは1回では解けきらないので数回まわす
  for (let i = 0; i < 3; i++) {
    resolvePlayers(world, params);
    for (const p of world.players) {
      for (const w of world.walls) {
        // 遠い壁は飛ばす（壁は100本ほどあるので、ここが一番重い）
        if (w.ax === w.bx && w.ay === w.by && Math.abs(p.x - w.ax) + Math.abs(p.y - w.ay) > 3) continue;
        resolveWall(p, w, params);
      }
    }
  }

  if (world.phase === 'village') {
    if (world.phaseLeft <= 0) dawn(world, params);
    return;
  }

  if (world.phaseLeft <= 0) {
    for (const p of world.players) {
      p.refuge = refugeOf(p, world);
      p.alive = p.refuge !== null;
      if (p.alive) p.score += p.blood;
    }
    world.phase = 'result';
    world.phaseLeft = RESULT_TIME;
  }
}

function shove(world: World, p: Player, params: Params): void {
  p.shoveCd = params.shoveCooldown;
  const hit: number[] = [];
  for (const q of world.players) {
    if (q === p) continue;
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const dist = Math.hypot(dx, dy);
    if (dist > PLAYER_RADIUS * 2 + params.shoveReach) continue;
    const nx = dist > 1e-6 ? dx / dist : p.fx;
    const ny = dist > 1e-6 ? dy / dist : p.fy;
    if (nx * p.fx + ny * p.fy < SHOVE_CONE_COS) continue;
    const impulse = params.shoveForce / massOf(q, params);
    q.kx += nx * impulse;
    q.ky += ny * impulse;
    hit.push(q.id);
  }
  world.shoves.push({ tick: world.tick, from: p.id, hit });
}

/** 重なった2人を、重さに反比例して押し分ける。弾かれた勢いは重さに応じてぶつかった相手へ移る */
function resolvePlayers(world: World, params: Params): void {
  const ps = world.players;
  for (let i = 0; i < ps.length; i++) {
    for (let j = i + 1; j < ps.length; j++) {
      const a = ps[i];
      const b = ps[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.hypot(dx, dy);
      const overlap = PLAYER_RADIUS * 2 - dist;
      if (overlap <= 0) continue;
      const nx = dist > 1e-6 ? dx / dist : 1;
      const ny = dist > 1e-6 ? dy / dist : 0;
      const ma = massOf(a, params);
      const mb = massOf(b, params);
      const wa = mb / (ma + mb);
      const wb = ma / (ma + mb);
      a.x -= nx * overlap * wa;
      a.y -= ny * overlap * wa;
      b.x += nx * overlap * wb;
      b.y += ny * overlap * wb;

      // 近づく向きの勢いだけを、運動量を保ったまま分け合う（完全非弾性）
      const rel = (b.kx - a.kx) * nx + (b.ky - a.ky) * ny;
      if (rel < 0) {
        const j2 = -rel / (1 / ma + 1 / mb);
        a.kx -= (nx * j2) / ma;
        a.ky -= (ny * j2) / ma;
        b.kx += (nx * j2) / mb;
        b.ky += (ny * j2) / mb;
      }
    }
  }
}

/** 線分（太さ r）上の、点に最も近い点 */
export function closestOnWall(w: Wall, x: number, y: number): { x: number; y: number } {
  const vx = w.bx - w.ax;
  const vy = w.by - w.ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - w.ax) * vx + (y - w.ay) * vy) / len2)) : 0;
  return { x: w.ax + vx * t, y: w.ay + vy * t };
}

function resolveWall(p: Player, w: Wall, params: Params): void {
  const c = closestOnWall(w, p.x, p.y);
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  const dist = Math.hypot(dx, dy);
  const min = PLAYER_RADIUS + w.r;
  if (dist >= min) return;
  const nx = dist > 1e-6 ? dx / dist : 0;
  const ny = dist > 1e-6 ? dy / dist : -1;
  p.x = c.x + nx * min;
  p.y = c.y + ny * min;
  const kn = p.kx * nx + p.ky * ny;
  if (kn < 0) {
    p.kx -= (1 + params.wallBounce) * kn * nx;
    p.ky -= (1 + params.wallBounce) * kn * ny;
  }
}
