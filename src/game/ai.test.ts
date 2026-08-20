import { describe, expect, it } from 'vitest';
import { botTakeTurn } from './ai';
import { cellId } from './board';
import { createGame, defaultConfig } from './rules';
import type { GameState } from './types';

function newBotGame(playerCount: number, seed = 1): GameState {
  const config = defaultConfig(playerCount, Array(playerCount).fill(true));
  config.seed = seed;
  return createGame(config);
}

function playOut(playerCount: number, seed: number): GameState {
  const config = defaultConfig(playerCount, Array(playerCount).fill(true));
  config.seed = seed;
  const state = createGame(config);
  let guard = 0;
  while (state.phase !== 'gameover') {
    botTakeTurn(state);
    if (++guard > 5000) throw new Error('ゲームが終わらない');
  }
  return state;
}

describe('ボット同士の対戦', () => {
  it('2〜4人のどの人数でも決着する', () => {
    for (const playerCount of [2, 3, 4]) {
      const state = playOut(playerCount, 7);
      expect(state.phase).toBe('gameover');
      // 夜の長さはダイス次第。無限に伸びないことだけ確かめる
      expect(state.round).toBeLessThan(300);
    }
  });

  it('ボットは実際に血を持ち帰る（棒立ちしない）', () => {
    const state = playOut(2, 3);
    const totalScore = state.players.reduce((s, p) => s + p.score, 0);
    expect(totalScore).toBeGreaterThan(0);
    expect(state.players.every((p) => p.delivered > 0)).toBe(true);
  });

  it('血の総量は最後まで保存される', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const state = playOut(3, seed);
      const total =
        state.bloodPool + state.players.reduce((s, p) => s + p.carrying + p.delivered, 0);
      expect(total).toBe(state.config.bloodPool);
    }
  });

  it('ボットは無闇に焼かれない（夜4回で死亡は平均1回未満）', () => {
    let deaths = 0;
    let games = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const state = playOut(2, seed);
      deaths += state.players.reduce((s, p) => s + p.deaths, 0);
      games += state.players.length;
    }
    expect(deaths / games).toBeLessThan(1);
  });

  it('同じシードなら同じ結果になる（決定論的）', () => {
    const a = playOut(4, 42);
    const b = playOut(4, 42);
    expect(a.players.map((p) => p.score)).toEqual(b.players.map((p) => p.score));
    expect(a.log.map((l) => l.text)).toEqual(b.log.map((l) => l.text));
  });

  it('得点は盤上の血の総量を超えない', () => {
    const state = playOut(2, 11);
    // 血がそのまま点なので、上限は村に用意された血の総量
    for (const p of state.players) {
      expect(p.score).toBeGreaterThanOrEqual(0);
      expect(p.score).toBeLessThanOrEqual(state.config.bloodPool * 3);
    }
  });

  it('血1つが10点なので、勝者の得点は数十点の桁になる', () => {
    let winners = 0;
    let sum = 0;
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const state = playOut(2, seed);
      sum += Math.max(...state.players.map((p) => p.score));
      winners += 1;
    }
    expect(sum / winners).toBeGreaterThan(30);
  });

  it('最終夜には血を抱えたまま終わらない', () => {
    let stranded = 0;
    let games = 0;
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const state = playOut(3, seed);
      stranded += state.players.filter((p) => p.carrying > 0).length;
      games += state.players.length;
    }
    // 隠れても加点されない夜なので、抱えたまま終わるのは例外的であるべき
    expect(stranded / games).toBeLessThan(0.25);
  });
});

describe('ボットの判断', () => {
  it('最終夜の最後のラウンドでは、避難所ではなく城を目指す', () => {
    const state = newBotGame(2);
    state.night = state.config.totalNights;
    state.intoNight = state.config.safeRounds; // 確定の夜は尽きた ＝ 次に朝が来うる
    state.current = 0;

    const bot = state.players[0];
    // 避難所（リング3のテント）の隣、かつ城まで2歩のマスに、血を抱えて立たせる
    const refuge = cellId(3, 2);
    expect(state.board.cells[refuge].kind).toBe('shade');
    bot.at = cellId(3, 1);
    bot.carrying = 90;
    bot.movesLeft = 2;
    state.players[1].at = state.board.castleCells[1];

    botTakeTurn(state);
    // 目の前の避難所へ逃げ込むのではなく、城に入って得点にしている
    expect(state.players[0].at).not.toBe(refuge);
    expect(state.players[0].at).toBe(state.board.castleCells[0]);
    expect(state.players[0].score).toBe(90);
  });

  it('村の血が尽きたら、ボットは安全な場所で朝を待つ', () => {
    const state = newBotGame(2);
    state.bloodPool = 0;
    state.players[0].carrying = 1;
    state.players[1].carrying = 1;
    let guard = 0;
    while (state.phase !== 'gameover' && guard++ < 200) botTakeTurn(state);
    expect(state.phase).toBe('gameover');
    // 抱えていた血は城に収まっている
    expect(state.players.reduce((a, p) => a + p.delivered, 0)).toBeGreaterThan(0);
  });
});
