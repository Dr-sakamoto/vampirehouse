import { beforeEach, describe, expect, it } from 'vitest';
import { RING_COUNT, VILLAGE, cellId, shortestPath } from './board';
import {
  createGame,
  currentPlayer,
  defaultConfig,
  deliveryValue,
  endTurn,
  hunterCells,
  isSafeCell,
  legalMoves,
  moveAllowance,
  moveTo,
  playBat,
  roundsUntilDawn,
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
    expect(newGame(2).bloodPool).toBe(10);
    expect(newGame(4).bloodPool).toBe(20);
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

  it('日陰は定員1。埋まっていると入れない', () => {
    const shade = state.board.shadeCells[0];
    const neighbor = state.board.cells[shade].neighbors[0];
    teleport(state, 1, shade);
    teleport(state, 0, neighbor);
    expect(legalMoves(state)).not.toContain(shade);
    teleport(state, 1, state.board.castleCells[1]);
    expect(legalMoves(state)).toContain(shade);
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
    expect(state.players[0].score).toBe(3);
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
    expect(state.players[0].score).toBe(1);
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

describe('血の重さ', () => {
  it('血2つごとに移動力が1減り、最低でも1は動ける', () => {
    const state = newGame(2);
    const p = state.players[0];
    const table: Array<[number, number]> = [
      [0, 3],
      [1, 3],
      [2, 2],
      [3, 2],
      [4, 1],
      [5, 1],
      [10, 1],
    ];
    for (const [carrying, expected] of table) {
      p.carrying = carrying;
      expect(moveAllowance(state, p)).toBe(expected);
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
  it('4ラウンドごとに夜明けが来る', () => {
    const state = newGame(2);
    expect(roundsUntilDawn(state)).toBe(4);
    passRound(state);
    expect(roundsUntilDawn(state)).toBe(3);
    passRound(state);
    passRound(state);
    expect(state.night).toBe(1);
    passRound(state);
    expect(state.night).toBe(2);
    expect(roundsUntilDawn(state)).toBe(4);
  });

  it('日陰以外にいると焼かれ、血は村へ還る', () => {
    const state = newGame(2);
    passRound(state);
    passRound(state);
    passRound(state);
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
    expect(isSafeCell(state, p, state.board.caveCells[0])).toBe(false);
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
    expect(state.cavesLooted).toContain(cave);
  });

  it('同じ洞窟は一夜に1回しか採れない', () => {
    const state = newGame(2);
    const cave = state.board.caveCells[0];
    const gate = state.board.cells[cave].neighbors[0];
    teleport(state, 0, gate);
    moveTo(state, cave);
    moveTo(state, gate);
    moveTo(state, cave);
    expect(state.players[0].bats).toHaveLength(1);
  });

  it('夜が明けると洞窟は復活する', () => {
    const state = newGame(2);
    const cave = state.board.caveCells[0];
    teleport(state, 0, state.board.cells[cave].neighbors[0]);
    moveTo(state, cave);
    expect(state.cavesLooted).toHaveLength(1);
    for (let i = 0; i < 4; i++) passRound(state);
    expect(state.cavesLooted).toHaveLength(0);
  });

  it('1ターンに拾えるコウモリは1枚まで', () => {
    const state = newGame(2);
    const [caveA, caveB] = state.board.caveCells;
    const path = shortestPath(state.board, caveA, caveB)!;
    teleport(state, 0, caveA);
    state.players[0].lootedCaveThisTurn = true;
    state.cavesLooted.push(caveA);
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

  it('飛翔: 空いている日陰へワープし、移動を終える', () => {
    const state = newGame(2);
    const uid = giveBat(state, 0, 'flight');
    const occupied = new Set(hunterCells(state));
    const dest = state.board.shadeCells.find((id) => !occupied.has(id))!;
    playBat(state, uid, { cell: dest });
    expect(state.players[0].at).toBe(dest);
    expect(state.players[0].movesLeft).toBe(0);
    expect(state.players[0].deaths).toBe(0);
  });

  it('飛翔: ハンターの真上に降りれば死ぬ（深部の日陰は巡回路の上にある）', () => {
    const state = newGame(2);
    const uid = giveBat(state, 0, 'flight');
    // 深部の日陰はリング2 ＝ ハンターの巡回リング。いずれ必ず重なる
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
  it('最終夜の持ち帰りは2点', () => {
    const state = newGame(2);
    expect(deliveryValue(state)).toBe(1);
    state.night = state.config.totalNights;
    expect(deliveryValue(state)).toBe(2);

    const castle = state.board.castleCells[0];
    const gate = state.board.cells[castle].neighbors.find(
      (n) => state.board.cells[n].kind !== 'castle',
    )!;
    teleport(state, 0, gate);
    state.players[0].carrying = 2;
    moveTo(state, castle);
    expect(state.players[0].score).toBe(4);
    expect(state.players[0].delivered).toBe(2);
  });

  it('規定の夜数を終えるとゲームが終わる', () => {
    const state = newGame(2);
    for (let i = 0; i < state.config.roundsPerNight * state.config.totalNights; i++) {
      passRound(state);
    }
    expect(state.phase).toBe('gameover');
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
    state.players[0].score = 5;
    state.players[1].score = 5;
    expect(winnerIndices(state)).toEqual([0, 1]);
    state.players[1].deaths = 2;
    expect(winnerIndices(state)).toEqual([0]);
    state.players[1].score = 6;
    expect(winnerIndices(state)).toEqual([1]);
  });
});

describe('血の総量は保存される', () => {
  it('村＋運搬中＋持ち帰り済み の合計は常に一定', () => {
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
