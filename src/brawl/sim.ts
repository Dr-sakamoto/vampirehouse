// 夜明けの乱闘 —— 試作3。避難所の押し合いだけを切り出したシミュレーション。
// 見た目は3Dだが、判定はすべて平面上の「円（吸血鬼）と線分（壁）」で行う。
// DOM にも通信にも依存しない純粋なロジックで、サーバーとクライアント予測の両方がこれを回す。

import { nextRandom } from '../game/rng';

export const PLAYER_RADIUS = 0.5;
/** 闘技場の外壁（正方形の半辺） */
export const ARENA_HALF = 13;
/** 同心円から放射状に走り出す位置 */
const START_RADIUS = 9;
/** 吸血鬼に持たせる血の上限（dL）。人ひとりがおよそ50dL */
export const BLOOD_MAX = 100;

export type Layout = 'u' | 'l' | 'pillars' | 'broken';
export const LAYOUTS: Layout[] = ['u', 'l', 'pillars', 'broken'];
export const LAYOUT_NAMES: Record<Layout, string> = {
  u: '三方壁',
  l: '二方壁',
  pillars: '柱だけ',
  broken: '崩れた四方壁',
};

/** 遊びながら動かす調整つまみ。サーバーとクライアントで同じ値を使う */
export interface Params {
  /** 走る時間（秒）。0になった瞬間に判定 */
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
  /** 連打の最短間隔（秒） */
  shoveCooldown: number;
  /** 体の縁からどこまで手が届くか（m） */
  shoveReach: number;
  /** 弾かれた勢いの減り方（大きいほどすぐ止まる） */
  knockFriction: number;
  /** 壁に当たったときの跳ね返り（0=吸い付く、1=完全に跳ね返る） */
  wallBounce: number;
  /** 避難所（影）の一辺（m） */
  shelterSize: number;
}

export const DEFAULT_PARAMS: Params = {
  runTime: 10,
  baseSpeed: 5.5,
  bloodSlow: 0.4,
  minSpeed: 3,
  bloodMass: 1.5,
  shoveForce: 9,
  shoveCooldown: 0.25,
  shoveReach: 0.7,
  knockFriction: 4,
  wallBounce: 0.5,
  shelterSize: 2.4,
};

export interface Input {
  /** 入力の通し番号。サーバーがどこまで処理したかを返すのに使う */
  seq: number;
  /** 移動方向（長さ1以下） */
  mx: number;
  my: number;
  /** この入力の瞬間に突き飛ばしボタンが押された */
  shove: boolean;
}

export const IDLE_INPUT: Input = { seq: 0, mx: 0, my: 0, shove: false };

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
  shoveCd: number;
  alive: boolean;
  /** 生き残った回数（試作の得点） */
  survived: number;
  /** サーバーが最後に処理した入力番号 */
  lastSeq: number;
  /** 最後に受け取った入力。予測で他人を動かすのに使う */
  lastInput: Input;
}

/** 線分の壁。a===b なら柱（円） */
export interface Wall {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  r: number;
}

export type Phase = 'ready' | 'run' | 'result';

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
  layout: Layout;
  /** 次のラウンドで使う配置。null なら毎回くじ引き */
  fixedLayout: Layout | null;
  walls: Wall[];
  players: Player[];
  rng: number;
  shoves: ShoveEvent[];
}

const READY_TIME = 2;
const RESULT_TIME = 3;
const WALL_R = 0.15;
const PILLAR_R = 0.35;
/** 突き飛ばしが届く向きの幅（正面から左右それぞれ） */
const SHOVE_CONE_COS = Math.cos((75 * Math.PI) / 180);

export const PLAYER_NAMES = ['あなた', 'ボットA', 'ボットB', 'ボットC'];

export function createWorld(playerCount: number, seed: number, fixedLayout: Layout | null = null): World {
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
      shoveCd: 0,
      alive: true,
      survived: 0,
      lastSeq: 0,
      lastInput: IDLE_INPUT,
    });
  }
  const world: World = {
    tick: 0,
    phase: 'ready',
    phaseLeft: READY_TIME,
    round: 0,
    layout: 'u',
    fixedLayout,
    walls: [],
    players,
    rng: seed >>> 0,
    shoves: [],
  };
  startRound(world, DEFAULT_PARAMS);
  return world;
}

function random(world: World): number {
  const r = nextRandom(world.rng);
  world.rng = r.state;
  return r.value;
}

/** 配置を引き、血を配り、全員を避難所を囲む円周に並べる */
export function startRound(world: World, params: Params): void {
  world.round += 1;
  world.phase = 'ready';
  world.phaseLeft = READY_TIME;
  world.layout = world.fixedLayout ?? LAYOUTS[Math.floor(random(world) * LAYOUTS.length)];
  world.walls = buildWalls(world.layout, params.shelterSize / 2);

  const n = world.players.length;
  const offset = random(world) * Math.PI * 2;
  for (const p of world.players) {
    const angle = offset + (p.id / n) * Math.PI * 2;
    p.x = Math.cos(angle) * START_RADIUS;
    p.y = Math.sin(angle) * START_RADIUS;
    p.kx = 0;
    p.ky = 0;
    p.fx = -Math.cos(angle);
    p.fy = -Math.sin(angle);
    p.blood = Math.round(random(world) * 10) * (BLOOD_MAX / 10);
    p.shoveCd = 0;
    p.alive = true;
  }
}

/** 避難所の壁。y が負の側を「北（画面の奥）」とする */
export function buildWalls(layout: Layout, h: number): Wall[] {
  const seg = (ax: number, ay: number, bx: number, by: number): Wall => ({ ax, ay, bx, by, r: WALL_R });
  const pillar = (x: number, y: number): Wall => ({ ax: x, ay: y, bx: x, by: y, r: PILLAR_R });
  const g = h * 0.35; // 崩れた壁の、残っている部分の長さ
  const walls: Wall[] = [];
  switch (layout) {
    case 'u':
      walls.push(seg(-h, -h, h, -h), seg(-h, -h, -h, h), seg(h, -h, h, h));
      break;
    case 'l':
      walls.push(seg(-h, -h, h, -h), seg(-h, -h, -h, h));
      break;
    case 'pillars':
      walls.push(pillar(-h, -h), pillar(h, -h), pillar(-h, h), pillar(h, h));
      break;
    case 'broken':
      // 四隅にだけ壁が残り、各辺の真ん中が崩れて開いている
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
        walls.push(seg(sx * h, sy * h, sx * (h - g), sy * h), seg(sx * h, sy * h, sx * h, sy * (h - g)));
      }
      break;
  }
  // 闘技場の外壁
  const a = ARENA_HALF;
  walls.push(seg(-a, -a, a, -a), seg(a, -a, a, a), seg(a, a, -a, a), seg(-a, a, -a, -a));
  return walls;
}

export function isInShelter(p: { x: number; y: number }, params: Params): boolean {
  const h = params.shelterSize / 2;
  return Math.abs(p.x) <= h && Math.abs(p.y) <= h;
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

  if (world.phase === 'ready') {
    if (world.phaseLeft <= 0) {
      world.phase = 'run';
      world.phaseLeft = params.runTime;
    }
    return;
  }

  if (world.phase === 'result') {
    if (world.phaseLeft <= 0) startRound(world, params);
    return;
  }

  for (const p of world.players) {
    const input = inputs.get(p.id) ?? IDLE_INPUT;
    p.shoveCd = Math.max(0, p.shoveCd - dt);

    const len = Math.hypot(input.mx, input.my);
    if (len > 0.05) {
      const scale = Math.min(1, len) / len;
      const speed = speedOf(p, params);
      p.x += input.mx * scale * speed * dt;
      p.y += input.my * scale * speed * dt;
      p.fx = input.mx / len;
      p.fy = input.my / len;
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
    for (const p of world.players) for (const w of world.walls) resolveWall(p, w, params);
  }

  if (world.phaseLeft <= 0) {
    for (const p of world.players) {
      p.alive = isInShelter(p, params);
      if (p.alive) p.survived += 1;
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

function resolveWall(p: Player, w: Wall, params: Params): void {
  const vx = w.bx - w.ax;
  const vy = w.by - w.ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - w.ax) * vx + (p.y - w.ay) * vy) / len2)) : 0;
  const cx = w.ax + vx * t;
  const cy = w.ay + vy * t;
  const dx = p.x - cx;
  const dy = p.y - cy;
  const dist = Math.hypot(dx, dy);
  const min = PLAYER_RADIUS + w.r;
  if (dist >= min) return;
  const nx = dist > 1e-6 ? dx / dist : 0;
  const ny = dist > 1e-6 ? dy / dist : -1;
  p.x = cx + nx * min;
  p.y = cy + ny * min;
  const kn = p.kx * nx + p.ky * ny;
  if (kn < 0) {
    p.kx -= (1 + params.wallBounce) * kn * nx;
    p.ky -= (1 + params.wallBounce) * kn * ny;
  }
}
