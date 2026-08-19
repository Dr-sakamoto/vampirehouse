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
  while (state.phase !== 'gameover' && guard++ < 5000) botTakeTurn(state);
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
  };
}

for (const playerCount of [2, 3, 4]) {
  const m = measure(playerCount);
  console.log(
    `${m.playerCount}人:  平均得点 ${f(m.avg)}  勝者 ${f(m.winner)}  最高 ${m.top}  最低 ${m.low}` +
      `  無得点率 ${f(m.shutout * 100, 0)}%  死亡 ${f(m.deaths)}` +
      `  奪った血 ${f(m.stolen)}  仕留め ${f(m.kills)}` +
      `  勝差 ${f(m.margin)}  村の残り血 ${f(m.leftover)}`,
  );
}
