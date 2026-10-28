import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, createWorld, massOf, speedOf, step, type Input, type World } from './sim';

const P = DEFAULT_PARAMS;
const DT = 1 / 60;

function running(playerCount = 2): World {
  const w = createWorld(playerCount, 1, 'u');
  w.phase = 'run';
  w.phaseLeft = 100;
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

function input(seq: number, mx = 0, my = 0, shove = false): Input {
  return { seq, mx, my, shove };
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
    expect(w.players[0].shoveCd).toBe(0);
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
    const light = running().players[1];
    const heavy = { ...light, blood: 100 };
    expect(massOf(heavy, P)).toBeGreaterThan(massOf(light, P));
    expect(speedOf(heavy, P)).toBeLessThan(speedOf(light, P));
    expect(speedOf({ ...light, blood: 100 }, { ...P, bloodSlow: 1 })).toBe(P.minSpeed);

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

  it('連打は最短間隔より速くは効かない', () => {
    const w = running();
    place(w, 0, 5, 5);
    place(w, 1, 6.1, 5);
    w.players[0].fx = 1;
    w.players[0].fy = 0;
    for (let i = 1; i <= 6; i++) step(w, new Map([[0, input(i, 0, 0, true)]]), P, DT);
    expect(w.shoves.filter((s) => s.from === 0)).toHaveLength(1);
  });

  it('壁に当たれば避難所の中に残る', () => {
    const w = running();
    // 三方壁の北壁（y = -h）の内側から、北へ向けて強く弾く
    place(w, 1, 0, -0.3);
    w.players[1].ky = -30;
    for (let i = 0; i < 60; i++) step(w, new Map(), P, DT);
    expect(w.players[1].y).toBeGreaterThan(-P.shelterSize / 2);
  });

  it('時間切れの瞬間、体の中心が影の外にいる者だけが焼ける', () => {
    const w = running();
    const h = P.shelterSize / 2;
    place(w, 0, 0, h - 0.6);
    place(w, 1, 0, h + 0.05);
    w.phaseLeft = DT / 2;
    step(w, new Map(), P, DT);
    expect(w.phase).toBe('result');
    expect(w.players[0].alive).toBe(true);
    expect(w.players[1].alive).toBe(false);
    expect(w.players[0].survived).toBe(1);
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
