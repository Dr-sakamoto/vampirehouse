import { describe, expect, it } from 'vitest';
import { buildWalls, createCastles, createRuins, inZone } from './map';
import { DEFAULT_PARAMS, createWorld, massOf, refugeOf, speedOf, step, type Input, type World } from './sim';

const P = DEFAULT_PARAMS;
const DT = 1 / 60;

/** 走っている最中の世界。地形の壁は外して、押し合いだけを見られるようにする */
function running(playerCount = 2): World {
  const w = createWorld(playerCount, 1);
  w.phase = 'run';
  w.phaseLeft = 100;
  w.walls = [];
  return w;
}

function place(w: World, id: number, x: number, y: number, blood = 0): void {
  const p = w.players[id];
  p.x = x;
  p.y = y;
  p.kx = 0;
  p.ky = 0;
  p.blood = blood;
}

function input(seq: number, mx = 0, my = 0, shove = false, ax = 0, ay = 0): Input {
  return { seq, mx, my, ax, ay, shove };
}

describe('夜明けの乱闘', () => {
  it('突き飛ばしは向いている方向の相手を弾く', () => {
    const w = running();
    place(w, 0, 5, 5);
    place(w, 1, 6.1, 5);
    w.players[0].fx = 1;
    w.players[0].fy = 0;
    step(w, new Map([[0, input(1, 0, 0, true)]]), P, DT);
    for (let i = 0; i < 30; i++) step(w, new Map(), P, DT);
    expect(w.players[1].x).toBeGreaterThan(7);
  });

  it('背後の相手には届かない', () => {
    const w = running();
    place(w, 0, 5, 5);
    place(w, 1, 3.9, 5);
    w.players[0].fx = 1;
    w.players[0].fy = 0;
    step(w, new Map([[0, input(1, 0, 0, true)]]), P, DT);
    expect(w.shoves[0].hit).toEqual([]);
  });

  it('血を抱えた相手ほど弾かれにくく、足は遅い', () => {
    const light = { ...running().players[1], blood: 0 };
    const heavy = { ...light, blood: 100 };
    expect(massOf(heavy, P)).toBeGreaterThan(massOf(light, P));
    expect(speedOf(heavy, P)).toBeLessThan(speedOf(light, P));
    expect(speedOf(heavy, { ...P, bloodSlow: 1 })).toBe(P.minSpeed);

    const distAfterShove = (blood: number): number => {
      const w = running();
      place(w, 0, 5, 5);
      place(w, 1, 6.1, 5, blood);
      w.players[0].fx = 1;
      w.players[0].fy = 0;
      step(w, new Map([[0, input(1, 0, 0, true)]]), P, DT);
      for (let i = 0; i < 60; i++) step(w, new Map(), P, DT);
      return w.players[1].x - 6.1;
    };
    expect(distAfterShove(100)).toBeLessThan(distAfterShove(0) * 0.6);
  });

  it('向きを指定すれば、歩く方向ではなく見ている方向へ突き飛ばす', () => {
    const w = running();
    place(w, 0, 5, 5);
    place(w, 1, 5, 6.1);
    // 東へ歩きながら、南（+y）を見て押す
    step(w, new Map([[0, input(1, 1, 0, true, 0, 1)]]), P, DT);
    expect(w.players[0].fx).toBeCloseTo(0);
    expect(w.players[0].fy).toBeCloseTo(1);
    expect(w.shoves[0].hit).toEqual([1]);
  });

  it('弾かれている間は、自分の足ではほとんど踏ん張れない', () => {
    const w = running();
    place(w, 0, 5, 5);
    place(w, 1, 6.1, 5);
    w.players[0].fx = 1;
    w.players[0].fy = 0;
    step(w, new Map([[0, input(1, 0, 0, true)]]), P, DT);
    // 弾かれた側が全力で押し返そうとしても、押された方向へ流される
    for (let i = 2; i < 20; i++) step(w, new Map([[1, input(i, -1, 0)]]), P, DT);
    expect(w.players[1].x).toBeGreaterThan(7);
  });

  it('待ち時間が明けるまで、次の突き飛ばしは出ない', () => {
    const w = running();
    place(w, 0, 5, 5);
    place(w, 1, 6.1, 5);
    w.players[0].fx = 1;
    w.players[0].fy = 0;
    // 記録は少し経つと消えるので、出た瞬間を数える
    let count = 0;
    const press = (seq: number): void => {
      step(w, new Map([[0, input(seq, 0, 0, true)]]), P, DT);
      if (w.shoves.some((s) => s.from === 0 && s.tick === w.tick)) count++;
    };
    const ticks = Math.round(P.shoveCooldown / DT);
    for (let i = 1; i <= ticks; i++) press(i);
    expect(count).toBe(1);
    press(ticks + 1);
    expect(count).toBe(2);
  });

  it('壁に当たれば廃墟の中に残る', () => {
    const w = running();
    // 三方壁の廃墟（北向き）を原点に置き、中から北壁へ向けて強く弾く
    const ruin = { cx: 0, cy: 0, half: P.shelterSize / 2, layout: 'u' as const, rot: 0, shaded: true };
    w.ruins = [ruin];
    w.walls = buildWalls([ruin], [], ruin.half).filter((x) => x.kind === 'ruin');
    // 素の重さの者が、既定の強さで突き飛ばされたときの勢い
    place(w, 1, 0, -0.3);
    w.players[1].ky = -P.shoveForce;
    for (let i = 0; i < 60; i++) step(w, new Map(), P, DT);
    expect(inZone(w.players[1], ruin)).toBe(true);
  });

  it('時間切れの瞬間、体の中心が影の外にいる者だけが焼け、生き延びた者の血が得点になる', () => {
    const w = running();
    const ruin = { cx: 0, cy: 0, half: P.shelterSize / 2, layout: 'u' as const, rot: 0, shaded: true };
    w.ruins = [ruin];
    place(w, 0, 0, ruin.half - 0.6, 70);
    place(w, 1, 0, ruin.half + 0.05, 90);
    w.phaseLeft = DT / 2;
    step(w, new Map(), P, DT);
    expect(w.phase).toBe('result');
    expect(w.players[0].alive).toBe(true);
    expect(w.players[0].refuge).toBe('ruin');
    expect(w.players[0].score).toBe(70);
    expect(w.players[1].alive).toBe(false);
    expect(w.players[1].score).toBe(0);
  });

  it('影の落ちていない廃墟と、他人の城は守ってくれない', () => {
    const w = running(2);
    const ruin = w.ruins[0];
    ruin.shaded = false;
    place(w, 0, ruin.cx, ruin.cy);
    expect(refugeOf(w.players[0], w)).toBeNull();
    ruin.shaded = true;
    expect(refugeOf(w.players[0], w)).toBe('ruin');

    const other = w.castles[1];
    place(w, 0, other.cx, other.cy);
    expect(refugeOf(w.players[0], w)).toBeNull();
    place(w, 1, other.cx, other.cy);
    expect(refugeOf(w.players[1], w)).toBe('castle');
  });

  it('影が落ちる廃墟は人数より少なく、毎戦引き直される', () => {
    const w = createWorld(4, 7);
    const shaded = (): number[] => w.ruins.flatMap((r, i) => (r.shaded ? [i] : []));
    expect(shaded()).toHaveLength(2);
    const seen = new Set<string>();
    for (let round = 0; round < 10; round++) {
      seen.add(shaded().join(','));
      w.phase = 'result';
      w.phaseLeft = 0;
      step(w, new Map(), P, DT);
      expect(shaded()).toHaveLength(2);
    }
    expect(seen.size).toBeGreaterThan(3);
  });

  it('地形は毎回同じで、城の門は村の側に開いている', () => {
    const ruins = createRuins();
    const castles = createCastles();
    expect(buildWalls(ruins, castles, 1.2)).toEqual(buildWalls(createRuins(), createCastles(), 1.2));
    // 城の中心から村の方向へまっすぐ出ると、門を通って外へ出られる（壁と交わらない）
    const walls = buildWalls(ruins, castles, 1.2).filter((w) => w.kind === 'castle' && w.owner === 0);
    const c = castles[0];
    for (let x = c.cx; x <= c.cx + 4; x += 0.1) {
      for (const w of walls) {
        const vx = w.bx - w.ax;
        const vy = w.by - w.ay;
        const t = Math.max(0, Math.min(1, ((x - w.ax) * vx + (c.cy - w.ay) * vy) / (vx * vx + vy * vy)));
        expect(Math.hypot(x - (w.ax + vx * t), c.cy - (w.ay + vy * t))).toBeGreaterThan(0.5 + w.r - 0.01);
      }
    }
  });

  it('同じシードと入力なら同じ展開になる', () => {
    const a = createWorld(4, 42);
    const b = createWorld(4, 42);
    for (let i = 1; i < 400; i++) {
      const inputs = new Map([[0, input(i, Math.sin(i / 20), Math.cos(i / 30), i % 7 === 0)]]);
      step(a, inputs, P, DT);
      step(b, inputs, P, DT);
    }
    expect(a).toEqual(b);
  });
});
