import { beforeEach, describe, expect, it } from 'vitest';
import { RING_COUNT, VILLAGE, cellId, shortestPath } from './board';
import { BAT_SPECS } from './bats';
import {
  createGame,
  currentPlayer,
  defaultConfig,
  deliveryScore,
  deliveryValue,
  endTurn,
  hunterCells,
  isSafeCell,
  legalMoves,
  moveAllowance,
  moveTo,
  playBat,
  dawnRisk,
  safeRoundsLeft,
  suckRange,
  swapTargets,
  winnerIndices,
} from './rules';
import type { BatKind, GameState } from './types';

function newGame(playerCount = 2): GameState {
  const config = defaultConfig(playerCount, Array(playerCount).fill(false));
  return createGame(config);
}

/** テスト用に手札を差し込む */
function giveBat(state: GameState, playerIndex: number, kind: BatKind): string {
  const uid = `test-${kind}-${playerIndex}-${state.players[playerIndex].bats.length}`;
  state.players[playerIndex].bats.push({ uid, kind });
  return uid;
}

/** 手番プレイヤーを指定マスへ瞬間移動（移動力は消費しない） */
function teleport(state: GameState, playerIndex: number, cell: string): void {
  state.players[playerIndex].at = cell;
}

/** 全員がその場でターンを終える。1ラウンドぶん進む */
function passRound(state: GameState): void {
  const players = state.players.length;
  for (let i = 0; i < players; i++) endTurn(state);
}

describe('初期状態', () => {
  it('各プレイヤーは自分の城から始まる', () => {
    const state = newGame(4);
    state.players.forEach((p, i) => expect(p.at).toBe(state.board.castleCells[i]));
    expect(state.players.every((p) => p.score === 0 && p.carrying === 0)).toBe(true);
  });

  it('村の血はプレイヤー数に比例する', () => {
    expect(newGame(2).bloodPool).toBe(24);
    expect(newGame(4).bloodPool).toBe(48);
  });

  it('ハンターは人数によらず2体、リング2を同じ向きに周回する', () => {
    for (const n of [2, 3, 4]) {
      const state = newGame(n);
      expect(state.hunters).toHaveLength(2);
      expect(state.hunters.every((h) => h.ring === 2)).toBe(true);
      // 常に盤面の反対側にいる
      expect(Math.abs(state.hunters[0].sector - state.hunters[1].sector)).toBe(4);
    }
  });
});

describe('移動', () => {
  let state: GameState;
  beforeEach(() => {
    state = newGame(2);
  });

  it('基礎移動力は3', () => {
    expect(currentPlayer(state).movesLeft).toBe(3);
  });

  it('隣接マスにしか動けない', () => {
    const moves = legalMoves(state);
    expect(moves).toEqual(state.board.cells[currentPlayer(state).at].neighbors);
    expect(moveTo(state, VILLAGE)).toBe(false);
  });

  it('移動力を使い切ると動けなくなる', () => {
    for (let i = 0; i < 3; i++) {
      const moves = legalMoves(state);
      expect(moves.length).toBeGreaterThan(0);
      moveTo(state, moves[0]);
    }
    expect(currentPlayer(state).movesLeft).toBe(0);
    expect(legalMoves(state)).toEqual([]);
  });

  it('他プレイヤーの城には入れない', () => {
    const p0 = state.players[0];
    const enemyCastle = state.board.castleCells[1];
    teleport(state, 0, cellId(RING_COUNT, state.board.cells[enemyCastle].sector));
    expect(legalMoves(state)).not.toContain(enemyCastle);
    expect(p0.at).not.toBe(enemyCastle);
  });

  it('避難所（テント・洞窟）は定員1。埋まっていると入れない', () => {
    for (const refuge of [state.board.shadeCells[0], state.board.caveCells[0]]) {
      const neighbor = state.board.cells[refuge].neighbors[0];
      teleport(state, 1, refuge);
      teleport(state, 0, neighbor);
      expect(legalMoves(state)).not.toContain(refuge);
      teleport(state, 1, state.board.castleCells[1]);
      expect(legalMoves(state)).toContain(refuge);
    }
  });
});

describe('血の回収と持ち帰り', () => {
  it('村でターンを終えると血を1つ得る', () => {
    const state = newGame(2);
    teleport(state, 0, VILLAGE);
    const before = state.bloodPool;
    endTurn(state);
    expect(state.players[0].carrying).toBe(1);
    expect(state.bloodPool).toBe(before - 1);
  });

  it('村を通過しただけでは血は手に入らない', () => {
    const state = newGame(2);
    teleport(state, 0, cellId(1, 0));
    moveTo(state, VILLAGE);
    expect(state.players[0].carrying).toBe(0);
    moveTo(state, cellId(1, 1));
    endTurn(state);
    expect(state.players[0].carrying).toBe(0);
  });

  it('村の血が尽きたら空振りする', () => {
    const state = newGame(2);
    state.bloodPool = 0;
    teleport(state, 0, VILLAGE);
    endTurn(state);
    expect(state.players[0].carrying).toBe(0);
  });

  it('自分の城に入った瞬間に得点化される', () => {
    const state = newGame(2);
    const castle = state.board.castleCells[0];
    const gate = state.board.cells[castle].neighbors.find(
      (n) => state.board.cells[n].kind !== 'castle',
    )!;
    teleport(state, 0, gate);
    state.players[0].carrying = 3;
    moveTo(state, castle);
    // 1本目10点・2本目20点・3本目30点
    expect(state.players[0].score).toBe(60);
    expect(state.players[0].carrying).toBe(0);
    expect(state.players[0].delivered).toBe(3);
  });

  it('城の中で手に入れた血も、ターン終了時に得点になる', () => {
    const state = newGame(2);
    // 城に立ったまま《強奪》で血を得る
    state.players[1].carrying = 1;
    teleport(state, 1, VILLAGE);
    const uid = giveBat(state, 0, 'steal');
    expect(state.board.cells[state.players[0].at].kind).toBe('castle');
    playBat(state, uid, { player: 1 });
    expect(state.players[0].carrying).toBe(1);
    endTurn(state);
    expect(state.players[0].score).toBe(10);
    expect(state.players[0].carrying).toBe(0);
  });

  it('持ち帰るまでは得点にならない', () => {
    const state = newGame(2);
    teleport(state, 0, VILLAGE);
    endTurn(state);
    expect(state.players[0].carrying).toBe(1);
    expect(state.players[0].score).toBe(0);
  });
});

describe('吸血のダイス', () => {
  it('村でターンを終えると、目の範囲内の血が手に入る', () => {
    const seen = new Set<number>();
    for (let seed = 1; seed <= 60; seed++) {
      const config = defaultConfig(2, [false, false]);
      config.seed = seed;
      const state = createGame(config);
      teleport(state, 0, VILLAGE);
      endTurn(state);
      const got = state.players[0].carrying;
      expect(got).toBeGreaterThanOrEqual(suckRange(state).min);
      expect(got).toBeLessThanOrEqual(suckRange(state).max);
      seen.add(got);
    }
    // 出目が固定されていない（ちゃんと振れている）
    expect(seen.size).toBeGreaterThan(1);
  });

  it('目を1つだけにすれば固定歩数と同じになる', () => {
    const config = defaultConfig(2, [false, false]);
    config.suckFaces = [2];
    const state = createGame(config);
    teleport(state, 0, VILLAGE);
    endTurn(state);
    expect(state.players[0].carrying).toBe(2);
  });

  it('村に残っている血を超えては吸えない', () => {
    const config = defaultConfig(2, [false, false]);
    config.suckFaces = [3];
    const state = createGame(config);
    state.bloodPool = 1;
    teleport(state, 0, VILLAGE);
    endTurn(state);
    expect(state.players[0].carrying).toBe(1);
    expect(state.bloodPool).toBe(0);
  });

  it('村を通過しただけでは振られない ―― 残ると決めた者にだけダイスが回る', () => {
    const state = newGame(2);
    const before = state.bloodPool;
    teleport(state, 0, cellId(1, 0));
    moveTo(state, VILLAGE);
    moveTo(state, cellId(1, 1));
    endTurn(state);
    expect(state.players[0].carrying).toBe(0);
    expect(state.bloodPool).toBe(before);
  });
});

describe('移動力', () => {
  it('何本抱えても足は鈍らない（重さの規則は廃止した）', () => {
    const state = newGame(2);
    const p = state.players[0];
    for (const carrying of [0, 1, 2, 3, 4, 5, 10]) {
      p.carrying = carrying;
      expect(moveAllowance(state, p)).toBe(state.config.baseMove);
    }
  });

  it('移動力はターン開始時に確定し、ターン中に血を得ても変わらない', () => {
    const state = newGame(2);
    state.players[0].carrying = 0;
    const uid = giveBat(state, 0, 'steal');
    state.players[1].carrying = 4;
    teleport(state, 1, VILLAGE);
    expect(currentPlayer(state).movesLeft).toBe(3);
    playBat(state, uid, { player: 1 });
    expect(state.players[0].carrying).toBe(1);
    expect(currentPlayer(state).movesLeft).toBe(3);
  });
});

describe('太陽（夜明け）', () => {
  it('安全ラウンドのあいだは、どう転んでも朝が来ない', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const config = defaultConfig(2, [false, false]);
      config.seed = seed;
      const state = createGame(config);
      expect(safeRoundsLeft(state)).toBe(config.safeRounds);
      expect(dawnRisk(state)).toBe(0);
      for (let i = 0; i < config.safeRounds; i++) {
        passRound(state);
        expect(state.night).toBe(1);
      }
      // 使い切った時点で、毎ラウンドの賭けが始まる
      expect(safeRoundsLeft(state)).toBe(0);
      expect(dawnRisk(state)).toBe(config.dawnChance);
    }
  });

  it('安全ラウンドを過ぎれば、いつかは必ず朝が来る', () => {
    const config = defaultConfig(2, [false, false]);
    config.seed = 5;
    const state = createGame(config);
    for (let i = 0; i < 60 && state.night === 1; i++) passRound(state);
    expect(state.night).toBeGreaterThan(1);
    // 夜が明ければ安全ラウンドが戻る
    expect(safeRoundsLeft(state)).toBe(config.safeRounds);
  });

  it('夜明けの確率を0にすれば、夜は永遠に続く', () => {
    const config = defaultConfig(2, [false, false]);
    config.dawnChance = 0;
    const state = createGame(config);
    for (let i = 0; i < 30; i++) passRound(state);
    expect(state.night).toBe(1);
  });

  it('日陰以外にいると焼かれ、血は村へ還る', () => {
    const state = newGame(2);
    state.config.dawnChance = 1; // 次のラウンドで必ず朝にする
    for (let i = 0; i < state.config.safeRounds; i++) passRound(state);
    teleport(state, 0, VILLAGE);
    state.players[0].carrying = 3;
    state.bloodPool = 0;
    passRound(state);
    expect(state.players[0].carrying).toBe(0);
    expect(state.players[0].at).toBe(state.board.castleCells[0]);
    expect(state.players[0].deaths).toBe(1);
    expect(state.bloodPool).toBeGreaterThanOrEqual(3);
  });

  it('日陰にいれば血を抱えたまま生き延びる', () => {
    const state = newGame(2);
    passRound(state);
    passRound(state);
    passRound(state);
    const shade = state.board.shadeCells[0];
    teleport(state, 0, shade);
    state.players[0].carrying = 2;
    passRound(state);
    expect(state.players[0].carrying).toBe(2);
    expect(state.players[0].at).toBe(shade);
    expect(state.players[0].deaths).toBe(0);
  });

  it('城は常に安全、村と洞窟は安全でない', () => {
    const state = newGame(2);
    const p = state.players[0];
    expect(isSafeCell(state, p, state.board.castleCells[0])).toBe(true);
    expect(isSafeCell(state, p, state.board.shadeCells[0])).toBe(true);
    expect(isSafeCell(state, p, VILLAGE)).toBe(false);
    // 洞窟は岩陰が陽を遮る ―― 日陰を兼ねる
    expect(isSafeCell(state, p, state.board.caveCells[0])).toBe(true);
  });
});

describe('ハンター', () => {
  it('1ラウンドに1マスずつ、決まった向きに周回する', () => {
    const state = newGame(2);
    const before = state.hunters.map((h) => h.sector);
    passRound(state);
    state.hunters.forEach((h, i) => {
      expect(h.sector).toBe((before[i] + h.dir + 8) % 8);
    });
  });

  it('ハンターのいるマスに踏み込むと即死する', () => {
    const state = newGame(2);
    const hunterCell = hunterCells(state)[0];
    const approach = state.board.cells[hunterCell].neighbors[0];
    teleport(state, 0, approach);
    state.players[0].carrying = 2;
    moveTo(state, hunterCell);
    expect(state.players[0].at).toBe(state.board.castleCells[0]);
    expect(state.players[0].carrying).toBe(0);
    expect(state.players[0].deaths).toBe(1);
  });

  it('ハンターの方から踏み込まれても死ぬ', () => {
    const state = newGame(2);
    const hunter = state.hunters[0];
    const next = cellId(hunter.ring, (hunter.sector + hunter.dir + 8) % 8);
    teleport(state, 0, next);
    teleport(state, 1, state.board.castleCells[1]);
    passRound(state);
    expect(state.players[0].deaths).toBe(1);
  });
});

describe('洞窟とコウモリ', () => {
  it('洞窟に入るとコウモリを1枚引く', () => {
    const state = newGame(2);
    const cave = state.board.caveCells[0];
    teleport(state, 0, state.board.cells[cave].neighbors[0]);
    moveTo(state, cave);
    expect(state.players[0].bats).toHaveLength(1);
  });

  it('同じターン中に同じ洞窟を出入りしても2枚目は引けない', () => {
    const state = newGame(2);
    const cave = state.board.caveCells[0];
    const gate = state.board.cells[cave].neighbors[0];
    teleport(state, 0, gate);
    moveTo(state, cave);
    moveTo(state, gate);
    moveTo(state, cave);
    expect(state.players[0].bats).toHaveLength(1);
  });

  it('先に他プレイヤーが通った洞窟でも変わらず1枚引ける', () => {
    const state = newGame(2);
    const cave = state.board.caveCells[0];
    const gate = state.board.cells[cave].neighbors[0];
    teleport(state, 0, gate);
    moveTo(state, cave);
    moveTo(state, gate); // 洞窟は定員1人なので出ておく
    endTurn(state);
    teleport(state, 1, gate);
    moveTo(state, cave);
    expect(state.players[0].bats).toHaveLength(1);
    expect(state.players[1].bats).toHaveLength(1);
  });

  it('1ターンに拾える洞窟は1つまで', () => {
    const state = newGame(2);
    const [caveA, caveB] = state.board.caveCells;
    const path = shortestPath(state.board, caveA, caveB)!;
    teleport(state, 0, caveA);
    state.players[0].lootedCaveThisTurn = true;
    state.players[0].movesLeft = path.length;
    for (const step of path.slice(1)) moveTo(state, step);
    expect(state.players[0].bats).toHaveLength(0);
  });
});

describe('コウモリの効果', () => {
  it('疾走: 移動力+2', () => {
    const state = newGame(2);
    const uid = giveBat(state, 0, 'dash');
    expect(currentPlayer(state).movesLeft).toBe(3);
    playBat(state, uid);
    expect(currentPlayer(state).movesLeft).toBe(5);
  });

  it('誘導: ハンターを1マス動かし、踏まれた者は死ぬ', () => {
    const state = newGame(2);
    const uid = giveBat(state, 0, 'lure');
    const hunter = state.hunters[0];
    const victimCell = cellId(hunter.ring, (hunter.sector + 1) % 8);
    teleport(state, 1, victimCell);
    state.players[1].carrying = 2;
    playBat(state, uid, { hunter: hunter.id, dir: 1 });
    expect(state.players[1].deaths).toBe(1);
    expect(state.players[1].carrying).toBe(0);
  });

  it('強奪: 城の外にいる相手からのみ奪える', () => {
    const state = newGame(2);
    state.players[1].carrying = 2;
    // 城の中は安全
    teleport(state, 1, state.board.castleCells[1]);
    const uid = giveBat(state, 0, 'steal');
    expect(playBat(state, uid, { player: 1 })).toBe(false);
    // 外に出れば奪える
    teleport(state, 1, VILLAGE);
    expect(playBat(state, uid, { player: 1 })).toBe(true);
    expect(state.players[0].carrying).toBe(1);
    expect(state.players[1].carrying).toBe(1);
  });

  it('影紡ぎ: そのマスを今夜だけ日陰にする', () => {
    const state = newGame(2);
    const uid = giveBat(state, 0, 'shroud');
    // ハンターの巡回リングを避けた、何もないマス
    const spot = cellId(1, 0);
    teleport(state, 0, spot);
    expect(isSafeCell(state, state.players[0], spot)).toBe(false);
    playBat(state, uid);
    expect(isSafeCell(state, state.players[0], spot)).toBe(true);

    state.players[0].carrying = 2;
    for (let i = 0; i < 4; i++) passRound(state);
    // 夜明けを生き延び、効果は消えている
    expect(state.players[0].at).toBe(spot);
    expect(state.players[0].carrying).toBe(2);
    expect(state.players[0].deaths).toBe(0);
    expect(state.players[0].shroudedCell).toBeNull();
    // 次の夜はもう守ってくれない
    expect(isSafeCell(state, state.players[0], spot)).toBe(false);
  });

  it('飛翔: 空いている避難所へワープし、移動を終える', () => {
    const state = newGame(2);
    const uid = giveBat(state, 0, 'flight');
    const occupied = new Set(hunterCells(state));
    const dest = state.board.refugeCells.find((id) => !occupied.has(id))!;
    playBat(state, uid, { cell: dest });
    expect(state.players[0].at).toBe(dest);
    expect(state.players[0].movesLeft).toBe(0);
    expect(state.players[0].deaths).toBe(0);
  });

  it('飛翔: ハンターの真上に降りれば死ぬ（深部のテントは巡回路の上にある）', () => {
    const state = newGame(2);
    const uid = giveBat(state, 0, 'flight');
    // テントはリング2 ＝ ハンターの巡回リング。いずれ必ず重なる
    const trap = state.board.shadeCells.find((id) => state.board.cells[id].ring === 2)!;
    state.hunters[0].sector = state.board.cells[trap].sector;
    expect(hunterCells(state)).toContain(trap);
    state.players[0].carrying = 2;
    playBat(state, uid, { cell: trap });
    expect(state.players[0].at).toBe(state.board.castleCells[0]);
    expect(state.players[0].carrying).toBe(0);
    expect(state.players[0].deaths).toBe(1);
  });

  it('1ターンに使えるコウモリは2枚まで', () => {
    const state = newGame(2);
    const a = giveBat(state, 0, 'dash');
    const b = giveBat(state, 0, 'dash');
    const c = giveBat(state, 0, 'dash');
    expect(playBat(state, a)).toBe(true);
    expect(playBat(state, b)).toBe(true);
    expect(playBat(state, c)).toBe(false);
  });

  it('使ったコウモリは捨札に行く', () => {
    const state = newGame(2);
    const uid = giveBat(state, 0, 'dash');
    playBat(state, uid);
    expect(state.discard).toHaveLength(1);
    expect(state.players[0].bats).toHaveLength(0);
  });

  it('死んでも手札のコウモリは失わない', () => {
    const state = newGame(2);
    giveBat(state, 0, 'dash');
    const hunterCell = hunterCells(state)[0];
    teleport(state, 0, state.board.cells[hunterCell].neighbors[0]);
    moveTo(state, hunterCell);
    expect(state.players[0].bats).toHaveLength(1);
  });
});

describe('決着', () => {
  it('最終夜の持ち帰りは3倍', () => {
    const state = newGame(2);
    expect(deliveryValue(state)).toBe(1);
    state.night = state.config.totalNights;
    expect(deliveryValue(state)).toBe(3);

    const castle = state.board.castleCells[0];
    const gate = state.board.cells[castle].neighbors.find(
      (n) => state.board.cells[n].kind !== 'castle',
    )!;
    teleport(state, 0, gate);
    state.players[0].carrying = 2;
    moveTo(state, castle);
    // (10 + 20) × 3
    expect(state.players[0].score).toBe(90);
    expect(state.players[0].delivered).toBe(2);
  });

  it('規定の夜数を終えるとゲームが終わる', () => {
    const state = newGame(2);
    // 夜の長さはダイス次第なので、十分な回数だけ回して終わることを確かめる
    for (let i = 0; i < 500 && state.phase !== 'gameover'; i++) passRound(state);
    expect(state.phase).toBe('gameover');
    expect(state.night).toBe(state.config.totalNights);
    expect(legalMoves(state)).toEqual([]);
  });

  it('村の血が尽き、誰も運搬していなければ終わる', () => {
    const state = newGame(2);
    state.bloodPool = 0;
    passRound(state);
    expect(state.phase).toBe('gameover');
  });

  it('運搬中の血が残っていれば血が尽きても続く', () => {
    const state = newGame(2);
    state.bloodPool = 0;
    // 城の外で血を抱えている限り、まだ勝負はついていない
    teleport(state, 0, cellId(1, 0));
    state.players[0].carrying = 1;
    passRound(state);
    expect(state.phase).toBe('playing');
    expect(state.players[0].carrying).toBe(1);
  });

  it('勝者は最高得点。同点は死亡回数の少ない方', () => {
    const state = newGame(2);
    state.players[0].score = 50;
    state.players[1].score = 50;
    expect(winnerIndices(state)).toEqual([0, 1]);
    state.players[1].deaths = 2;
    expect(winnerIndices(state)).toEqual([0]);
    state.players[1].score = 60;
    expect(winnerIndices(state)).toEqual([1]);
  });
});

describe('得点の量', () => {
  it('同時に運んだ血は1本目10点・2本目20点・3本目30点と積み上がる', () => {
    const state = newGame(2);
    expect(state.config.bloodValue).toBe(10);
    expect(deliveryScore(state, 0)).toBe(0);
    expect(deliveryScore(state, 1)).toBe(10);
    expect(deliveryScore(state, 2)).toBe(30);
    expect(deliveryScore(state, 3)).toBe(60);
    expect(deliveryScore(state, 4)).toBe(100);
  });

  it('血1つの得点は設定で変えられる', () => {
    const config = defaultConfig(2, [false, false]);
    config.bloodValue = 1;
    const state = createGame(config);
    expect(deliveryScore(state, 1)).toBe(1);
    expect(deliveryScore(state, 2)).toBe(3);
  });
});

describe('噛みつき（PVP）', () => {
  it('相手のいるマスへ踏み込むと血を1つ奪う', () => {
    const state = newGame(2);
    const spot = cellId(1, 0);
    teleport(state, 1, spot);
    state.players[1].carrying = 2;
    teleport(state, 0, VILLAGE);
    moveTo(state, spot);
    expect(state.players[0].carrying).toBe(1);
    expect(state.players[0].stolen).toBe(1);
    expect(state.players[1].carrying).toBe(1);
  });

  it('噛みつけるのは1ターンに1回まで', () => {
    const state = newGame(3);
    const a = cellId(1, 0);
    const b = cellId(1, 1);
    teleport(state, 1, a);
    teleport(state, 2, b);
    state.players[1].carrying = 2;
    state.players[2].carrying = 2;
    teleport(state, 0, VILLAGE);
    moveTo(state, a);
    moveTo(state, b);
    expect(state.players[0].carrying).toBe(1);
    expect(state.players[2].carrying).toBe(2);
  });

  it('血を持たない相手には噛みついても何も起きない', () => {
    const state = newGame(2);
    const spot = cellId(1, 0);
    teleport(state, 1, spot);
    teleport(state, 0, VILLAGE);
    moveTo(state, spot);
    expect(state.players[0].carrying).toBe(0);
    expect(state.players[0].bitThisTurn).toBe(false);
  });

  it('城の中は噛みつかれない', () => {
    const state = newGame(2);
    // 自分の城には他人が入れないので、噛みつきの対象になり得るのは城の外だけ
    const castle = state.board.castleCells[0];
    state.players[1].carrying = 2;
    teleport(state, 1, castle);
    teleport(state, 0, state.board.cells[castle].neighbors[0]);
    moveTo(state, castle);
    expect(state.players[1].carrying).toBe(2);
    expect(state.players[0].carrying).toBe(0);
  });
});

describe('仕留めた相手の血（PVP）', () => {
  it('誘導でハンターに轢かせると、その血は差し向けた側に入る', () => {
    const state = newGame(2);
    const uid = giveBat(state, 0, 'lure');
    const hunter = state.hunters[0];
    const victimCell = cellId(hunter.ring, (hunter.sector + 1) % 8);
    teleport(state, 1, victimCell);
    state.players[1].carrying = 3;
    const poolBefore = state.bloodPool;
    playBat(state, uid, { hunter: hunter.id, dir: 1 });
    expect(state.players[1].carrying).toBe(0);
    expect(state.players[0].carrying).toBe(3);
    expect(state.players[0].kills).toBe(1);
    expect(state.bloodPool).toBe(poolBefore);
  });

  it('太陽やハンターに自滅した血は村へ還る（誰のものにもならない）', () => {
    const state = newGame(2);
    const hunterCell = hunterCells(state)[0];
    teleport(state, 0, state.board.cells[hunterCell].neighbors[0]);
    state.players[0].carrying = 2;
    const poolBefore = state.bloodPool;
    moveTo(state, hunterCell);
    expect(state.bloodPool).toBe(poolBefore + 2);
    expect(state.players[1].carrying).toBe(0);
    expect(state.players[1].kills).toBe(0);
  });
});

describe('影渡り（PVP）', () => {
  it('城の外にいる相手と位置を入れ替え、移動を終える', () => {
    const state = newGame(2);
    const uid = giveBat(state, 0, 'swap');
    const mine = cellId(4, 0);
    const theirs = state.board.shadeCells[0];
    teleport(state, 0, mine);
    teleport(state, 1, theirs);
    expect(swapTargets(state)).toEqual([1]);
    playBat(state, uid, { player: 1 });
    expect(state.players[0].at).toBe(theirs);
    expect(state.players[1].at).toBe(mine);
    expect(state.players[0].movesLeft).toBe(0);
  });

  it('城にいる相手とは入れ替われない。自分が城にいる間も使えない', () => {
    const state = newGame(2);
    const uid = giveBat(state, 0, 'swap');
    // 自分が城にいる
    expect(state.board.cells[state.players[0].at].kind).toBe('castle');
    expect(playBat(state, uid, { player: 1 })).toBe(false);
    // 相手が城にいる
    teleport(state, 0, cellId(4, 0));
    teleport(state, 1, state.board.castleCells[1]);
    expect(swapTargets(state)).toEqual([]);
    expect(playBat(state, uid, { player: 1 })).toBe(false);
  });

  it('相手をハンターの前へ突き出すと、その血は突き出した側に入る', () => {
    const state = newGame(2);
    const uid = giveBat(state, 0, 'swap');
    const hunterCell = hunterCells(state)[0];
    teleport(state, 0, hunterCell);
    teleport(state, 1, cellId(4, 0));
    state.players[1].carrying = 2;
    playBat(state, uid, { player: 1 });
    expect(state.players[1].at).toBe(state.board.castleCells[1]);
    expect(state.players[1].deaths).toBe(1);
    expect(state.players[0].carrying).toBe(2);
    expect(state.players[0].at).toBe(cellId(4, 0));
  });

  it('避難所を横取りできる ―― 朝は相手のものになる', () => {
    const state = newGame(2);
    const uid = giveBat(state, 0, 'swap');
    const refuge = state.board.caveCells[0];
    const exposed = cellId(1, 1);
    teleport(state, 0, exposed);
    teleport(state, 1, refuge);
    playBat(state, uid, { player: 1 });
    passRound(state);
    passRound(state);
    passRound(state);
    passRound(state);
    expect(state.players[0].deaths).toBe(0);
    expect(state.players[1].deaths).toBe(1);
  });
});

describe('コウモリの構成', () => {
  it('干渉カードが山札の半分を占める', () => {
    const pvp = BAT_SPECS.lure.copies + BAT_SPECS.steal.copies + BAT_SPECS.swap.copies;
    const total = Object.values(BAT_SPECS).reduce((sum, spec) => sum + spec.copies, 0);
    expect(pvp / total).toBeGreaterThanOrEqual(0.5);
  });
});

describe('血の総量は保存される', () => {
  it('村＋運搬中＋持ち帰り済み の合計は常に一定（奪い合っても増減しない）', () => {
    const state = newGame(3);
    const total = () =>
      state.bloodPool +
      state.players.reduce((sum, p) => sum + p.carrying + p.delivered, 0);
    const initial = total();
    for (let i = 0; i < 12; i++) {
      for (let j = 0; j < state.players.length; j++) {
        if (state.phase !== 'playing') break;
        const moves = legalMoves(state);
        if (moves.length > 0) moveTo(state, moves[i % moves.length]);
        endTurn(state);
      }
      if (state.phase === 'gameover') break;
      expect(total()).toBe(initial);
    }
    expect(total()).toBe(initial);
  });
});
