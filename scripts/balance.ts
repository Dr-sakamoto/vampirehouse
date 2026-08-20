/** バランス確認用のシミュレーション。`npm run balance` で回す（すべてボットの自動対戦） */
import { botTakeTurn } from '../src/game/ai';
import { createGame, defaultConfig } from '../src/game/rules';
import type { GameConfig } from '../src/game/types';

function run(playerCount: number, seed: number, tweak?: (c: GameConfig) => void) {
  const config = defaultConfig(playerCount, Array(playerCount).fill(true));
  config.seed = seed;
  tweak?.(config);
  const state = createGame(config);
  let guard = 0;
  while (state.phase !== 'gameover' && guard++ < 20000) botTakeTurn(state);
  return state;
}

const GAMES = 60;
const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const f = (x: number, digits = 2) => x.toFixed(digits);

function measure(playerCount: number, tweak?: (c: GameConfig) => void) {
  const scores: number[] = [];
  const winning: number[] = [];
  const deaths: number[] = [];
  const margins: number[] = [];
  const leftover: number[] = [];
  const stolen: number[] = [];
  const kills: number[] = [];
  const rounds: number[] = [];
  const hauls: number[] = [];
  let shutout = 0;
  let seats = 0;

  for (let seed = 1; seed <= GAMES; seed++) {
    const s = run(playerCount, seed, tweak);
    const round = s.players.map((p) => p.score);
    scores.push(...round);
    seats += round.length;
    shutout += round.filter((x) => x === 0).length;
    const sorted = [...round].sort((a, b) => b - a);
    winning.push(sorted[0]);
    margins.push(sorted[0] - sorted[1]);
    deaths.push(s.players.reduce((a, p) => a + p.deaths, 0));
    stolen.push(s.players.reduce((a, p) => a + p.stolen, 0));
    kills.push(s.players.reduce((a, p) => a + p.kills, 0));
    leftover.push(s.bloodPool);
    rounds.push(s.round);
    for (const e of s.log) {
      const m = e.text.match(/血 (\d+) を持ち帰った/);
      if (m) hauls.push(Number(m[1]));
    }
  }

  return {
    playerCount,
    avg: avg(scores),
    top: Math.max(...scores),
    low: Math.min(...scores),
    winner: avg(winning),
    shutout: shutout / seats,
    deaths: avg(deaths),
    margin: avg(margins),
    stolen: avg(stolen),
    kills: avg(kills),
    leftover: avg(leftover),
    rounds: avg(rounds),
    haul: avg(hauls),
    bigHaul: hauls.filter((h) => h >= 100).length / (hauls.length || 1),
    hauls,
  };
}

for (const playerCount of [2, 3, 4]) {
  const m = measure(playerCount);
  console.log(
    `${m.playerCount}人:  平均得点 ${f(m.avg)}  勝者 ${f(m.winner)}  最高 ${m.top}  最低 ${m.low}` +
      `  無得点率 ${f(m.shutout * 100, 0)}%  死亡 ${f(m.deaths)}` +
      `  奪った血 ${f(m.stolen)}  仕留め ${f(m.kills)}` +
      `  勝差 ${f(m.margin)}  村の残り血 ${f(m.leftover)}` +
      `  全${f(m.rounds, 1)}R  1回の持ち帰り ${f(m.haul, 0)}  100以上 ${f(m.bigHaul * 100, 0)}%`,
  );
}


// 持ち帰り1回ぶんの当たりの散らばり ―― ここが「ドーパミンの出方」そのもの
console.log('\n1回の持ち帰りの分布（2人戦）');
const bands: Array<[string, (h: number) => boolean]> = [
  ['〜30', (h) => h <= 30],
  ['40〜60', (h) => h > 30 && h <= 60],
  ['70〜100', (h) => h > 60 && h <= 100],
  ['110〜200', (h) => h > 100 && h <= 200],
  ['201〜', (h) => h > 200],
];
const all = measure(2).hauls;
for (const [label, hit] of bands) {
  const n = all.filter(hit).length;
  const pct = (n / all.length) * 100;
  console.log(`  ${label.padStart(8)}  ${'█'.repeat(Math.round(pct / 2)).padEnd(30)} ${f(pct, 0)}%`);
}
