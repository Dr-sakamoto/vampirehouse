/** バランス確認用のシミュレーション。`npm run balance` で回す（すべてボットの自動対戦） */
import { botTakeTurn } from '../src/game/ai';
import { createGame, defaultConfig } from '../src/game/rules';
import type { GameConfig, GameState } from '../src/game/types';
import { camperTakeTurn } from './camper';

/** camper に指定した席だけ「洞窟主」（篭り戦術）で打つ */
function run(playerCount: number, seed: number, tweak?: (c: GameConfig) => void, camper?: number) {
  const config = defaultConfig(playerCount, Array(playerCount).fill(true));
  config.seed = seed;
  tweak?.(config);
  const state = createGame(config);
  let guard = 0;
  while (state.phase !== 'gameover' && guard++ < 20000) {
    if (state.current === camper) camperTakeTurn(state);
    else botTakeTurn(state);
  }
  return state;
}

/** そのプレイヤーが洞窟で引いたコウモリの枚数（ログから数える） */
function batsDrawn(state: GameState, index: number): number {
  const name = state.players[index].name;
  return state.log.filter((e) => e.text === `${name} が洞窟でコウモリを1枚得た。`).length;
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
  const burned: number[] = [];
  const stuns: number[] = [];
  let shutout = 0;
  let seats = 0;
  // 夜明けを迎えた回数のうち、避難所（テント・洞窟）で迎えた割合
  let dawnsMet = 0;
  let dawnsInRefuge = 0;

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
    burned.push(s.players.reduce((a, p) => a + p.burned, 0));
    stuns.push(s.players.reduce((a, p) => a + p.stunsTaken, 0));
    for (const p of s.players) {
      dawnsMet += p.sheltered + p.burned;
      dawnsInRefuge += p.sheltered;
    }
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
    burned: avg(burned),
    stuns: avg(stuns),
    refuge: dawnsInRefuge / (dawnsMet || 1),
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
      `  無得点率 ${f(m.shutout * 100, 0)}%  死亡 ${f(m.deaths)}  焼死 ${f(m.burned)}` +
      `  日陰率 ${f(m.refuge * 100, 0)}%  スタン ${f(m.stuns)}` +
      `  奪った血 ${f(m.stolen)}  仕留め ${f(m.kills)}` +
      `  勝差 ${f(m.margin)}  村の残り血 ${f(m.leftover)}` +
      `  全${f(m.rounds, 1)}R  1回の持ち帰り ${f(m.haul, 0)}  100以上 ${f(m.bigHaul * 100, 0)}%`,
  );
}


/**
 * 篭り（洞窟主）の検算 ―― 席0だけが「村へ行かず、洞窟に籠って他人の稼ぎを刈る」戦術を打つ。
 * 洞窟は最外リングにあり、ハンターは来ず、陽光も届かない。
 * この席が普通のボットを上回るなら、盤面に**リスクを負わない稼ぎ方**が残っている。
 */
function measureCamp(playerCount: number, tweak?: (c: GameConfig) => void) {
  const camp: number[] = [];
  const rest: number[] = [];
  const campBats: number[] = [];
  const restBats: number[] = [];
  const campDeaths: number[] = [];
  let campWins = 0;

  for (let seed = 1; seed <= GAMES; seed++) {
    const s = run(playerCount, seed, tweak, 0);
    const scores = s.players.map((p) => p.score);
    camp.push(scores[0]);
    rest.push(...scores.slice(1));
    campBats.push(batsDrawn(s, 0));
    for (let i = 1; i < playerCount; i++) restBats.push(batsDrawn(s, i));
    campDeaths.push(s.players[0].deaths);
    if (Math.max(...scores) === scores[0]) campWins += 1;
  }

  return {
    playerCount,
    camp: avg(camp),
    rest: avg(rest),
    winRate: campWins / GAMES,
    campBats: avg(campBats),
    restBats: avg(restBats),
    deaths: avg(campDeaths),
  };
}

console.log('\n篭り戦術（洞窟主）を1人混ぜたとき');
for (const playerCount of [2, 3, 4]) {
  const m = measureCamp(playerCount);
  console.log(
    `${m.playerCount}人:  洞窟主 ${f(m.camp)}  他の席 ${f(m.rest)}` +
      `  洞窟主の勝率 ${f(m.winRate * 100, 0)}%  洞窟主の死亡 ${f(m.deaths)}` +
      `  引いた札 洞窟主 ${f(m.campBats, 1)} / 他 ${f(m.restBats, 1)}`,
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
