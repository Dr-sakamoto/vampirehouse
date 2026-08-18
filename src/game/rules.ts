import {
  CASTLE_SECTORS,
  RING_COUNT,
  VILLAGE,
  castleOf,
  cellId,
  createBoard,
  wrapSector,
} from './board';
import { BAT_SPECS, buildDeck } from './bats';
import { shuffle } from './rng';
import type {
  BatKind,
  Board,
  GameConfig,
  GameState,
  Hunter,
  LogEntry,
  Player,
} from './types';

export const PLAYER_COLORS = ['#e63946', '#4361ee', '#2a9d3f', '#f4a300'];
export const PLAYER_NAMES = ['紅の城', '蒼の城', '翠の城', '金の城'];

/**
 * すべての公開関数は state を破壊的に更新する。
 * UI 側は呼び出し後に再描画するだけでよい。
 */

export function defaultConfig(playerCount = 2, bots?: boolean[]): GameConfig {
  return {
    playerCount,
    bots: bots ?? Array.from({ length: playerCount }, (_, i) => i > 0),
    baseMove: 3,
    roundsPerNight: 4,
    totalNights: 4,
    bloodPool: 5 * playerCount,
    batsPerTurn: 2,
    seed: 1,
  };
}

/**
 * ハンターは2体。城から村へ向かう放射線（斜め4方向）をまたぐように
 * リング2を同じ向きに周回し、常に盤面の反対側に位置する。
 * 位置も進路も完全に読めるので、轢かれるのは計算違いのときだけ。
 */
function initialHunters(): Hunter[] {
  return [
    { id: 'h1', ring: 2, sector: 1, dir: 1 },
    { id: 'h2', ring: 2, sector: 5, dir: 1 },
  ];
}

export function createGame(config: GameConfig): GameState {
  const board = createBoard();
  const shuffled = shuffle(buildDeck(), config.seed);

  const players: Player[] = Array.from({ length: config.playerCount }, (_, i) => ({
    index: i,
    name: PLAYER_NAMES[i],
    isBot: config.bots[i] ?? false,
    color: PLAYER_COLORS[i],
    at: castleOf(board, i),
    carrying: 0,
    score: 0,
    bats: [],
    movesLeft: 0,
    batsPlayedThisTurn: 0,
    shroudedCell: null,
    lootedCaveThisTurn: false,
    deaths: 0,
    delivered: 0,
  }));

  const state: GameState = {
    config,
    board,
    players,
    hunters: initialHunters(),
    deck: shuffled.items,
    discard: [],
    bloodPool: config.bloodPool,
    cavesLooted: [],
    round: 1,
    night: 1,
    current: 0,
    phase: 'playing',
    log: [],
    lastBurned: [],
    rngState: shuffled.state,
  };

  pushLog(state, `第1夜。夜明けまであと ${config.roundsPerNight} ラウンド。`, 'info');
  beginTurn(state);
  return state;
}

// ---------------------------------------------------------------- ログ

function pushLog(state: GameState, text: string, tone: LogEntry['tone'] = 'info'): void {
  state.log.push({ round: state.round, night: state.night, text, tone });
  if (state.log.length > 200) state.log.splice(0, state.log.length - 200);
}

// ---------------------------------------------------------------- 参照系

export function currentPlayer(state: GameState): Player {
  return state.players[state.current];
}

/** 血を多く抱えるほど鈍重になる。ターン開始時に確定し、ターン中は変化しない */
export function moveAllowance(state: GameState, player: Player): number {
  return Math.max(1, state.config.baseMove - Math.floor(player.carrying / 2));
}

export function hunterAt(state: GameState, id: string): Hunter | undefined {
  return state.hunters.find((h) => cellId(h.ring, h.sector) === id);
}

export function hunterCells(state: GameState): string[] {
  return state.hunters.map((h) => cellId(h.ring, h.sector));
}

/** そのハンターが次のラウンド終了時に進むマス */
export function hunterNextCell(hunter: Hunter): string {
  return cellId(hunter.ring, wrapSector(hunter.sector + hunter.dir));
}

/** 夜明けを生き延びられるマスか */
export function isSafeCell(state: GameState, player: Player, id: string): boolean {
  const cell = state.board.cells[id];
  if (!cell) return false;
  if (cell.kind === 'castle') return true;
  if (cell.kind === 'shade') return true;
  return player.shroudedCell === id;
}

/** 日陰は定員1。他プレイヤーが立っていれば入れない */
function shadeBlocked(state: GameState, id: string, moverIndex: number): boolean {
  if (state.board.cells[id].kind !== 'shade') return false;
  return state.players.some((p) => p.index !== moverIndex && p.at === id);
}

/** 現在の手番プレイヤーが1歩で移動できるマス */
export function legalMoves(state: GameState): string[] {
  if (state.phase !== 'playing') return [];
  const player = currentPlayer(state);
  if (player.movesLeft <= 0) return [];
  return state.board.cells[player.at].neighbors.filter((id) => {
    const cell = state.board.cells[id];
    if (cell.kind === 'castle' && cell.castleOf !== player.index) return false;
    if (shadeBlocked(state, id, player.index)) return false;
    return true;
  });
}

export function roundsUntilDawn(state: GameState): number {
  const perNight = state.config.roundsPerNight;
  const intoNight = (state.round - 1) % perNight;
  return perNight - intoNight;
}

export function isFinalNight(state: GameState): boolean {
  return state.night >= state.config.totalNights;
}

/** 最終夜は持ち帰りが2点。逆転の余地を残すための倍率 */
export function deliveryValue(state: GameState): number {
  return isFinalNight(state) ? 2 : 1;
}

// ---------------------------------------------------------------- ターン進行

export function beginTurn(state: GameState): void {
  const player = currentPlayer(state);
  player.movesLeft = moveAllowance(state, player);
  player.batsPlayedThisTurn = 0;
  player.lootedCaveThisTurn = false;
}

function drawBat(state: GameState, player: Player): boolean {
  if (state.deck.length === 0) {
    if (state.discard.length === 0) return false;
    const reshuffled = shuffle(state.discard, state.rngState);
    state.deck = reshuffled.items;
    state.rngState = reshuffled.state;
    state.discard = [];
    pushLog(state, 'コウモリの山札を切り直した。', 'info');
  }
  const card = state.deck.pop();
  if (!card) return false;
  player.bats.push(card);
  return true;
}

/**
 * 自分の城にいる血は、その場で得点になる。
 * 城へ踏み込んだ瞬間だけでなくターン終了時にも通すことで、
 * 城の中で《強奪》した血が宙に浮いたままにならない。
 */
function bankBlood(state: GameState, player: Player): void {
  if (player.carrying <= 0) return;
  const cell = state.board.cells[player.at];
  if (cell.kind !== 'castle' || cell.castleOf !== player.index) return;

  const carried = player.carrying;
  const gained = carried * deliveryValue(state);
  player.score += gained;
  player.delivered += carried;
  player.carrying = 0;
  pushLog(state, `${player.name} が血 ${carried} を持ち帰った（+${gained}点）。`, 'good');
}

/** ハンターに触れた／太陽に焼かれたときの共通処理。血は村へ還る */
function killPlayer(state: GameState, player: Player, reason: string): void {
  const lost = player.carrying;
  state.bloodPool += lost;
  player.carrying = 0;
  player.deaths += 1;
  player.shroudedCell = null;
  player.at = castleOf(state.board, player.index);
  player.movesLeft = 0;
  pushLog(
    state,
    `${player.name} は${reason}。${lost > 0 ? `血 ${lost} を落とし、` : ''}城へ引き戻された。`,
    'bad',
  );
}

/** 1マス移動する。移動できたら true */
export function moveTo(state: GameState, target: string): boolean {
  if (state.phase !== 'playing') return false;
  if (!legalMoves(state).includes(target)) return false;

  const player = currentPlayer(state);
  player.at = target;
  player.movesLeft -= 1;

  // ハンターに触れたら即死
  if (hunterCells(state).includes(target)) {
    killPlayer(state, player, 'ハンターに討たれた');
    return true;
  }

  const cell = state.board.cells[target];

  // 自分の城に入ったら血が得点になる
  bankBlood(state, player);

  // 洞窟でコウモリを拾う（1つの洞窟は一夜に1回、1ターンに1枚まで）
  if (
    cell.kind === 'cave' &&
    !player.lootedCaveThisTurn &&
    !state.cavesLooted.includes(target)
  ) {
    if (drawBat(state, player)) {
      state.cavesLooted.push(target);
      player.lootedCaveThisTurn = true;
      pushLog(state, `${player.name} が洞窟でコウモリを1枚得た。`, 'good');
    }
  }

  return true;
}

export function endTurn(state: GameState): void {
  if (state.phase !== 'playing') return;
  const player = currentPlayer(state);

  // 村に留まって夜を明かすほど血が採れる ―― それが引き際の賭け
  if (state.board.cells[player.at].kind === 'village') {
    if (state.bloodPool > 0) {
      state.bloodPool -= 1;
      player.carrying += 1;
      pushLog(state, `${player.name} が村で血を1つ吸った（運搬中 ${player.carrying}）。`, 'good');
    } else {
      pushLog(state, `${player.name} は村に入ったが、血はもう残っていない。`, 'warn');
    }
  }

  bankBlood(state, player);
  player.movesLeft = 0;

  const isLastPlayer = state.current === state.players.length - 1;
  if (!isLastPlayer) {
    state.current += 1;
    beginTurn(state);
    return;
  }

  endRound(state);
}

function endRound(state: GameState): void {
  moveHunters(state);

  const dawnNow = state.round % state.config.roundsPerNight === 0;
  if (dawnNow) {
    resolveDawn(state);
    if (state.phase === 'gameover') return;
  }

  if (checkBloodExhausted(state)) return;

  state.round += 1;
  state.current = 0;
  if (!dawnNow) {
    pushLog(state, `夜明けまであと ${roundsUntilDawn(state)} ラウンド。`, 'warn');
  }
  beginTurn(state);
}

function moveHunters(state: GameState): void {
  for (const hunter of state.hunters) {
    hunter.sector = wrapSector(hunter.sector + hunter.dir);
    const id = cellId(hunter.ring, hunter.sector);
    for (const p of state.players) {
      if (p.at === id) killPlayer(state, p, 'ハンターに踏み込まれた');
    }
  }
}

function resolveDawn(state: GameState): void {
  state.phase = 'dawn';
  state.lastBurned = [];
  pushLog(state, `☀ 第${state.night}夜が明ける。日陰にいない者は灰になる。`, 'warn');

  for (const p of state.players) {
    if (isSafeCell(state, p, p.at)) {
      const where = state.board.cells[p.at].kind === 'castle' ? '城' : '日陰';
      pushLog(state, `${p.name} は${where}で朝をやり過ごした。`, 'good');
    } else {
      state.lastBurned.push(p.index);
      killPlayer(state, p, '陽光に焼かれた');
    }
    p.shroudedCell = null;
  }

  state.cavesLooted = [];

  if (state.night >= state.config.totalNights) {
    finishGame(state, '規定の夜数が終わった');
    return;
  }

  state.night += 1;
  state.phase = 'playing';
  pushLog(
    state,
    `第${state.night}夜が始まる。${isFinalNight(state) ? '最終夜 ―― 持ち帰る血は2点。' : `夜明けまで ${state.config.roundsPerNight} ラウンド。`}`,
    'info',
  );
}

function checkBloodExhausted(state: GameState): boolean {
  if (state.bloodPool > 0) return false;
  if (state.players.some((p) => p.carrying > 0)) return false;
  finishGame(state, '村の血が尽きた');
  return true;
}

function finishGame(state: GameState, reason: string): void {
  state.phase = 'gameover';
  const winners = winnerIndices(state);
  const names = winners.map((i) => state.players[i].name).join('・');
  pushLog(state, `${reason}。勝者は ${names}。`, 'good');
}

/** 得点が最大の者。同点なら死亡回数が少ない方。それも同じなら引き分け */
export function winnerIndices(state: GameState): number[] {
  const best = Math.max(...state.players.map((p) => p.score));
  const tied = state.players.filter((p) => p.score === best);
  const fewestDeaths = Math.min(...tied.map((p) => p.deaths));
  return tied.filter((p) => p.deaths === fewestDeaths).map((p) => p.index);
}

// ---------------------------------------------------------------- コウモリ

export interface BatTarget {
  /** steal: 対象プレイヤーの index */
  player?: number;
  /** lure: 動かすハンターの id */
  hunter?: string;
  /** lure: 動かす向き */
  dir?: 1 | -1;
  /** flight: 行き先の日陰マス */
  cell?: string;
}

/** そのカードを今この瞬間に使えるか（使えない理由を返す） */
export function batPlayError(state: GameState, kind: BatKind): string | null {
  if (state.phase !== 'playing') return 'いま使えない';
  const player = currentPlayer(state);
  if (player.batsPlayedThisTurn >= state.config.batsPerTurn) {
    return `1ターンに使えるのは ${state.config.batsPerTurn} 枚まで`;
  }
  switch (kind) {
    case 'steal':
      return stealTargets(state).length > 0 ? null : '奪える相手がいない';
    case 'flight':
      return flightTargets(state).length > 0 ? null : '空いている日陰がない';
    case 'shroud':
      return player.shroudedCell === player.at ? 'このマスは既に影の中' : null;
    default:
      return null;
  }
}

export function stealTargets(state: GameState): number[] {
  const me = currentPlayer(state);
  return state.players
    .filter(
      (p) =>
        p.index !== me.index &&
        p.carrying > 0 &&
        state.board.cells[p.at].kind !== 'castle',
    )
    .map((p) => p.index);
}

export function flightTargets(state: GameState): string[] {
  const me = currentPlayer(state);
  return state.board.shadeCells.filter(
    (id) => id !== me.at && !state.players.some((p) => p.index !== me.index && p.at === id),
  );
}

export function playBat(state: GameState, uid: string, target: BatTarget = {}): boolean {
  if (state.phase !== 'playing') return false;
  const player = currentPlayer(state);
  const idx = player.bats.findIndex((b) => b.uid === uid);
  if (idx === -1) return false;
  const card = player.bats[idx];
  if (batPlayError(state, card.kind) !== null) return false;

  const spec = BAT_SPECS[card.kind];

  switch (card.kind) {
    case 'dash': {
      player.movesLeft += 2;
      pushLog(state, `${player.name} が《${spec.name}》を使った。移動力 +2。`, 'info');
      break;
    }
    case 'lure': {
      const hunter = state.hunters.find((h) => h.id === target.hunter) ?? state.hunters[0];
      const dir = target.dir ?? 1;
      hunter.sector = wrapSector(hunter.sector + dir);
      const id = cellId(hunter.ring, hunter.sector);
      pushLog(state, `${player.name} が《${spec.name}》でハンターを動かした。`, 'info');
      for (const p of state.players) {
        if (p.at === id) killPlayer(state, p, 'ハンターを差し向けられた');
      }
      break;
    }
    case 'steal': {
      const targets = stealTargets(state);
      const victimIndex = target.player !== undefined && targets.includes(target.player)
        ? target.player
        : targets[0];
      const victim = state.players[victimIndex];
      victim.carrying -= 1;
      player.carrying += 1;
      pushLog(state, `${player.name} が《${spec.name}》で ${victim.name} の血を1つ奪った。`, 'bad');
      break;
    }
    case 'shroud': {
      player.shroudedCell = player.at;
      pushLog(state, `${player.name} が《${spec.name}》で足元を影に沈めた。`, 'info');
      break;
    }
    case 'flight': {
      const options = flightTargets(state);
      const dest = target.cell && options.includes(target.cell) ? target.cell : options[0];
      player.at = dest;
      player.movesLeft = 0;
      pushLog(state, `${player.name} が《${spec.name}》で日陰へ舞い降りた。`, 'info');
      if (hunterCells(state).includes(dest)) {
        killPlayer(state, player, 'ハンターの真上に降りてしまった');
      }
      break;
    }
  }

  player.bats.splice(idx, 1);
  state.discard.push(card);
  player.batsPlayedThisTurn += 1;
  return true;
}

// ---------------------------------------------------------------- 盤面情報

/** 城 → 村 → 城 の最短往復歩数。UI のヒント表示用 */
export function roundTripCost(): number {
  return (RING_COUNT + 1) * 2;
}

export { CASTLE_SECTORS, VILLAGE, castleOf, cellId };
export type { Board };
