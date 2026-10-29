// 夜明けの乱闘の地形。ボードゲーム版の盤面（中心の村・四隅の城・その間の避難所）を、
// 歩いて渡る広さの土地に置き直したもの。配置は毎回同じで、覚えるほど上手く走れる。
// 毎戦変わるのは「どの廃墟に雲の影が落ちるか」だけ（sim.ts の startRound）。

import { nextRandom } from '../game/rng';

/** 闘技場の外壁（正方形の半辺） */
export const ARENA_HALF = 20;
/** 村の広場の半径。全員ここから走り出す */
export const VILLAGE_RADIUS = 3.2;
/** 村を囲む岩の輪の半径 */
const ROCK_RING = 6.5;
/** 廃墟が並ぶ半径 */
const RUIN_RING = 12.5;
/** 城の中心（四隅） */
export const CASTLE_OFFSET = 16.5;
/** 城の中の安全な広さ（半辺） */
export const CASTLE_HALF = 2.2;

export type Layout = 'u' | 'l' | 'pillars' | 'broken';
export const LAYOUT_NAMES: Record<Layout, string> = {
  u: '三方壁',
  l: '二方壁',
  pillars: '柱だけ',
  broken: '崩れた四方壁',
};

// 障害物は岩と木だけ。どちらも目線（1.3m）を塞がないよう、岩は低く、木は幹が細い
export type WallKind = 'outer' | 'rock' | 'ruin' | 'castle' | 'tree';

/** 線分の壁。a===b なら柱や木（円） */
export interface Wall {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  r: number;
  kind: WallKind;
  /** 城の壁なら持ち主 */
  owner?: number;
}

/** 軸に沿った正方形の安全地帯 */
export interface Zone {
  cx: number;
  cy: number;
  half: number;
}

export interface Ruin extends Zone {
  layout: Layout;
  /** 90度単位の向き */
  rot: number;
  /** 今戦、雲の影が落ちているか */
  shaded: boolean;
  /** 雲の影の、廃墟の中心からのずれ（m）。雲が流れるにつれて変わる */
  ox: number;
  oy: number;
  /** 雲の流れる向き（単位ベクトル）。白んだ瞬間に決まる */
  vx: number;
  vy: number;
}

/** 雲の影が今落ちている四角。廃墟と同じ大きさで、雲の流れに合わせてずれていく */
export function shadeZone(r: Ruin): Zone {
  return { cx: r.cx + r.ox, cy: r.cy + r.oy, half: r.half };
}

export interface Castle extends Zone {
  owner: number;
}

const WALL_R = 0.15;
const PILLAR_R = 0.35;
const TREE_R = 0.45;

const seg = (ax: number, ay: number, bx: number, by: number, kind: WallKind, r = WALL_R): Wall => ({
  ax,
  ay,
  bx,
  by,
  r,
  kind,
});

/**
 * 4つの廃墟。村の東・南・西・北に1つずつ、城（四隅）とは違う方角に置く。
 * 城へ向かうか廃墟へ向かうかで、村を出た最初の一歩から道が分かれる。
 * 形は4種類を1つずつ。壁のある廃墟は、開いた口を村の側へ向けてある
 */
const RUIN_SPECS: { layout: Layout; rot: number }[] = [
  { layout: 'u', rot: 1 }, // 東。三方壁、口は西（村）向き
  { layout: 'broken', rot: 0 }, // 南
  { layout: 'l', rot: 0 }, // 西。北と西が壁、村の側は開いている
  { layout: 'pillars', rot: 0 }, // 北
];

export function createRuins(): Ruin[] {
  return RUIN_SPECS.map((spec, i) => {
    const angle = (i / RUIN_SPECS.length) * Math.PI * 2;
    return {
      cx: round1(Math.cos(angle) * RUIN_RING),
      cy: round1(Math.sin(angle) * RUIN_RING),
      half: 0,
      layout: spec.layout,
      rot: spec.rot,
      shaded: false,
      ox: 0,
      oy: 0,
      vx: 1,
      vy: 0,
    };
  });
}

/** 城は四隅に1つずつ。id 0 が左上（北西）、以降時計回り */
export function createCastles(): Castle[] {
  const corners = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];
  return corners.map(([sx, sy], owner) => ({
    cx: sx * CASTLE_OFFSET,
    cy: sy * CASTLE_OFFSET,
    half: CASTLE_HALF,
    owner,
  }));
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/** 廃墟の壁（中心原点・北向き）。y が負の側を「北（画面の奥）」とする */
function ruinShape(layout: Layout, h: number): Wall[] {
  const g = h * 0.35; // 崩れた壁の、残っている部分の長さ
  const pillar = (x: number, y: number): Wall => seg(x, y, x, y, 'ruin', PILLAR_R);
  const walls: Wall[] = [];
  switch (layout) {
    case 'u':
      walls.push(seg(-h, -h, h, -h, 'ruin'), seg(-h, -h, -h, h, 'ruin'), seg(h, -h, h, h, 'ruin'));
      break;
    case 'l':
      walls.push(seg(-h, -h, h, -h, 'ruin'), seg(-h, -h, -h, h, 'ruin'));
      break;
    case 'pillars':
      walls.push(pillar(-h, -h), pillar(h, -h), pillar(-h, h), pillar(h, h));
      break;
    case 'broken':
      // 四隅にだけ壁が残り、各辺の真ん中が崩れて開いている
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
        walls.push(
          seg(sx * h, sy * h, sx * (h - g), sy * h, 'ruin'),
          seg(sx * h, sy * h, sx * h, sy * (h - g), 'ruin'),
        );
      }
      break;
  }
  return walls;
}

function rotate(x: number, y: number, rot: number): [number, number] {
  switch (((rot % 4) + 4) % 4) {
    case 1:
      return [-y, x];
    case 2:
      return [-x, -y];
    case 3:
      return [y, -x];
    default:
      return [x, y];
  }
}

function place(w: Wall, cx: number, cy: number, rot: number): Wall {
  const [ax, ay] = rotate(w.ax, w.ay, rot);
  const [bx, by] = rotate(w.bx, w.by, rot);
  return { ...w, ax: ax + cx, ay: ay + cy, bx: bx + cx, by: by + cy };
}

function castleWalls(castle: Castle): Wall[] {
  const h = castle.half + 0.3;
  const { cx, cy, owner } = castle;
  // 入口（門）は村に面した横の辺にだけ開ける
  const sx = Math.sign(cx);
  // 体（直径1m）がすれ違えないくらいの幅。門の前は渋滞する
  const gate = 1.3;
  const doorX = cx - sx * h;
  const walls = [
    seg(cx - h, cy - h, cx + h, cy - h, 'castle', 0.25),
    seg(cx - h, cy + h, cx + h, cy + h, 'castle', 0.25),
    seg(cx + sx * h, cy - h, cx + sx * h, cy + h, 'castle', 0.25),
    seg(doorX, cy - h, doorX, cy - gate, 'castle', 0.25),
    seg(doorX, cy + gate, doorX, cy + h, 'castle', 0.25),
  ];
  return walls.map((w) => ({ ...w, owner }));
}

/** 村を囲む岩の輪。真っすぐは抜けられないが、すき間が広く、上から向こうが見える */
function rockRing(): Wall[] {
  const out: Wall[] = [];
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    const x = round1(Math.cos(angle) * ROCK_RING);
    const y = round1(Math.sin(angle) * ROCK_RING);
    out.push(seg(x, y, x, y, 'rock', 0.95));
  }
  return out;
}

/**
 * 岩と木を野に散らす。毎回同じ配置になるよう固定のシードで決め、
 * 村の広場・廃墟・城・村を囲む岩の上には置かない
 */
function scatter(ruins: Ruin[], castles: Castle[], placed: Wall[]): Wall[] {
  const out: Wall[] = [];
  let state = 0x5eed;
  const avoid: { x: number; y: number; r: number }[] = [
    { x: 0, y: 0, r: VILLAGE_RADIUS + 1.5 },
    ...ruins.map((r) => ({ x: r.cx, y: r.cy, r: 4.5 })),
    ...castles.map((c) => ({ x: c.cx, y: c.cy, r: 4.5 })),
    ...placed.map((w) => ({ x: w.ax, y: w.ay, r: w.r + 2 })),
  ];
  const next = (): number => {
    const r = nextRandom(state);
    state = r.state;
    return r.value;
  };
  let trees = 0;
  let rocks = 0;
  for (let tries = 0; (trees < 20 || rocks < 12) && tries < 2000; tries++) {
    const x = round1((next() * 2 - 1) * (ARENA_HALF - 1.5));
    const y = round1((next() * 2 - 1) * (ARENA_HALF - 1.5));
    const isRock = rocks < 12 && (trees >= 20 || next() < 0.4);
    const r = isRock ? round1(0.5 + next() * 0.5) : TREE_R;
    if (avoid.some((o) => Math.hypot(x - o.x, y - o.y) < o.r + r)) continue;
    if (out.some((t) => Math.hypot(x - t.ax, y - t.ay) < t.r + r + 2.2)) continue;
    out.push(seg(x, y, x, y, isRock ? 'rock' : 'tree', r));
    if (isRock) rocks++;
    else trees++;
  }
  return out;
}

/** 地形の壁をすべて組み立てる。廃墟の広さは調整つまみで変わるので、そのたびに組み直す */
export function buildWalls(ruins: Ruin[], castles: Castle[], ruinHalf: number): Wall[] {
  const walls: Wall[] = [];
  for (const ruin of ruins) {
    for (const w of ruinShape(ruin.layout, ruinHalf)) walls.push(place(w, ruin.cx, ruin.cy, ruin.rot));
  }
  const ring = rockRing();
  walls.push(...ring);
  for (const c of castles) walls.push(...castleWalls(c));
  walls.push(...scatter(ruins, castles, ring));
  const a = ARENA_HALF;
  walls.push(seg(-a, -a, a, -a, 'outer'), seg(a, -a, a, a, 'outer'), seg(a, a, -a, a, 'outer'), seg(-a, a, -a, -a, 'outer'));
  return walls;
}

export function inZone(p: { x: number; y: number }, z: Zone): boolean {
  return Math.abs(p.x - z.cx) <= z.half && Math.abs(p.y - z.cy) <= z.half;
}
