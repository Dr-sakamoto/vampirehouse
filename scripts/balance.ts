/** バランス確認用のシミュレーション。`npx vite-node scripts/balance.ts` 相当を vitest で回す */
import { botTakeTurn } from '../src/game/ai';
import { createGame, defaultConfig } from '../src/game/rules';

function run(playerCount: number, seed: number) {
  const config = defaultConfig(playerCount, Array(playerCount).fill(true));
  config.seed = seed;
  const state = createGame(config);
  let guard = 0;
  while (state.phase !== 'gameover' && guard++ < 5000) botTakeTurn(state);
  return state;
}

for (const playerCount of [2, 3, 4]) {
  const scores: number[][] = [];
  const deaths: number[] = [];
  const margins: number[] = [];
  const leftover: number[] = [];
  for (let seed = 1; seed <= 60; seed++) {
    const s = run(playerCount, seed);
    scores.push(s.players.map((p) => p.score));
    deaths.push(s.players.reduce((a, p) => a + p.deaths, 0));
    const sorted = s.players.map((p) => p.score).sort((a, b) => b - a);
    margins.push(sorted[0] - sorted[1]);
    leftover.push(s.bloodPool);
  }
  const flat = scores.flat();
  const avg = (xs: number[]) => (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2);
  console.log(
    `${playerCount}人:  平均得点 ${avg(flat)}  最高 ${Math.max(...flat)}  最低 ${Math.min(...flat)}` +
      `  1ゲームの死亡数 ${avg(deaths)}  勝差 ${avg(margins)}  村の残り血 ${avg(leftover)}`,
  );
}
