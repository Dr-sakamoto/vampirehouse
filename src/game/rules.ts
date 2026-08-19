import {
  CASTLE_SECTORS,
  RING_COUNT,
  VILLAGE,
  castleOf,
  cellId,
  createBoard,
  isRefugeKind,
  wrapSector,
} from './board';
import { BAT_SPECS, buildDeck } from './bats';
import { nextRandom, shuffle } from './rng';
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

/**
 * 血1つの基礎点。血の本数（＝盤面を流れるモノの量）はそのままに、
 * 1本あたりの価値を10倍にした。4点で勝つゲームは、勝っても手応えが薄い。
 */
const DEFAULT_BLOOD_VALUE = 10;

/**
 * 洞窟を1度訪れて引けるコウモリの枚数。洞窟を4つから2つへ減らしたぶん、
 * 盤面へ流れ込むカードの量が半分になるので、1つあたりの群れを倍にして
 * カードの総流量を元に戻している（`docs/design.md` §8）。
 */
export const CAVE_DRAW = 2;

export function defaultConfig(playerCount = 2, bots?: boolean[]): GameConfig {
  return {
    playerCount,
    bots: bots ?? Array.from({ length: playerCount }, (_, i) => i > 0),
    baseMove: 3,
    suckFaces: [1, 2, 3],
    safeRounds: 3,
    dawnChance: 1 / 3,
    totalNights: 4,
    bloodPool: 12 * playerCount,
    bloodValue: DEFAULT_BLOOD_VALUE,
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
    bitThisTurn: false,
    deaths: 0,
    delivered: 0,
    stolen: 0,
    kills: 0,
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
    intoNight: 0,
    night: 1,
    current: 0,
    startPlayer: 0,
    phase: 'playing',
    log: [],
    lastBurned: [],
    rngState: shuffled.state,
  };

  pushLog(state, `第1夜。${config.safeRounds} ラウンドは朝が来ない。`, 'info');
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

/**
 * 毎ターンの移動力。
 *
 * かつては「血2つごとに1歩遅くなる」重さの規則があったが、廃止した。
 * 吸える血の量がダイスになった以上、重さを残すと**上振れが事故死になる**
 * ―― 運良く3本引いた者が足を奪われて帰れず焼ける、という形で、
 * ダイスが収入ではなく生死を決めてしまう。実測でも、重さを残したまま
 * 吸血をダイスにすると死亡が 0.04 → 1.11 に跳ね上がった。
 * 引き際の緊張は、重さではなく夜明け（§太陽）が受け持つ。
 */
export function moveAllowance(state: GameState, _player: Player): number {
  return state.config.baseMove;
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

/** 夜明けを生き延びられるマスか。洞窟は岩陰が陽を遮るので日陰を兼ねる */
export function isSafeCell(state: GameState, player: Player, id: string): boolean {
  const cell = state.board.cells[id];
  if (!cell) return false;
  if (cell.kind === 'castle') return true;
  if (isRefugeKind(cell.kind)) return true;
  return player.shroudedCell === id;
}

/** 避難所（テント・洞窟）は定員1。他プレイヤーが立っていれば入れない */
function refugeBlocked(state: GameState, id: string, moverIndex: number): boolean {
  if (!isRefugeKind(state.board.cells[id].kind)) return false;
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
    if (refugeBlocked(state, id, player.index)) return false;
    return true;
  });
}

/**
 * 夜明けまで「あと何ラウンドあると見て動くか」。
 *
 * 安全ラウンドのぶんは確定だが、その先は毎ラウンドの賭けになるので、
 * 確定分に見込みを少し足した数を計画の基準にする。ボット同士で振って 2 に決めた:
 * 1 だと確定ラウンドの終わりで必ず引き上げてしまい取り分が減り（206点 → 185点）、
 * 2 以上は頭打ちになる（他の制約が先に効くため 2・3・4 で差が出ない）。
 */
export const DAWN_PLAN_HORIZON = 2;

export function plannedRoundsLeft(state: GameState): number {
  return Math.max(1, safeRoundsLeft(state) + DAWN_PLAN_HORIZON);
}

export function isFinalNight(state: GameState): boolean {
  return state.night >= state.config.totalNights;
}

/** 最終夜は持ち帰りが3倍。差がついていても、最後の一往復で全部ひっくり返る */
export function deliveryValue(state: GameState): number {
  return isFinalNight(state) ? 3 : 1;
}

/**
 * 血 count 本を「いま」城に収めたときの得点。
 *
 * 同時に運んでいる血は、1本目が10点・2本目が20点・3本目が30点 …… と積み上がる
 * （基礎点 × 1+2+…+count）。「欲張るほど帰りが遠い」の裏返しで、
 * 欲張ったまま帰り着いたときだけ、見返りが跳ね上がる。最終夜はさらに3倍。
 */
export function deliveryScore(state: GameState, count: number): number {
  if (count <= 0) return 0;
  const stacked = (count * (count + 1)) / 2;
  return state.config.bloodValue * stacked * deliveryValue(state);
}

// ---------------------------------------------------------------- ダイス

/**
 * このゲームのダイスは、すべて**プレイヤーが決めたあとに振られる**。
 *
 * 吸血のダイスは「村にもう1ターン残る」と決めた者にだけ振られ、
 * 夜明けのダイスは「まだ帰らない」と決めた盤面に対して振られる。
 * 決定の前に降ってくる乱数（＝天災）は置かない ―― それはただの理不尽で、
 * 判断の材料にならないため。
 */
function roll(state: GameState, faces: number): number {
  const r = nextRandom(state.rngState);
  state.rngState = r.state;
  return Math.floor(r.value * faces);
}

/** 村で1ターン粘ったときに吸える血。目は config で決まる（既定 1〜3） */
function rollSuck(state: GameState): number {
  const faces = state.config.suckFaces;
  if (faces.length === 0) return 1;
  return faces[roll(state, faces.length)];
}

/** 吸血の目の幅と期待値。UI とボットが同じ表を見る */
export function suckRange(state: GameState): { min: number; max: number; mean: number } {
  const faces = state.config.suckFaces;
  const mean = faces.reduce((a, b) => a + b, 0) / faces.length;
  return { min: Math.min(...faces), max: Math.max(...faces), mean };
}

/**
 * 今夜が「必ず続く」残りラウンド数。ここまでは朝が来ないので、
 * この範囲の往復は完全に計算できる。
 */
export function safeRoundsLeft(state: GameState): number {
  return Math.max(0, state.config.safeRounds - state.intoNight);
}

/** このラウンドの終わりに朝が来る確率。安全ラウンドのうちは0 */
export function dawnRisk(state: GameState): number {
  return safeRoundsLeft(state) > 0 ? 0 : state.config.dawnChance;
}

// ---------------------------------------------------------------- ターン進行

export function beginTurn(state: GameState): void {
  const player = currentPlayer(state);
  player.movesLeft = moveAllowance(state, player);
  player.batsPlayedThisTurn = 0;
  player.lootedCaveThisTurn = false;
  player.bitThisTurn = false;
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
  const gained = deliveryScore(state, carried);
  player.score += gained;
  player.delivered += carried;
  player.carrying = 0;
  pushLog(state, `${player.name} が血 ${carried} を持ち帰った（+${gained}点）。`, 'good');
}

/** 血を1本、被害者から加害者へ移す。総量は変わらない */
function transferBlood(thief: Player, victim: Player, amount: number): void {
  const taken = Math.min(amount, victim.carrying);
  if (taken <= 0) return;
  victim.carrying -= taken;
  thief.carrying += taken;
  thief.stolen += taken;
}

/**
 * ハンターに触れた／太陽に焼かれたときの共通処理。血は村へ還る。
 * ただし killer が指定されているとき（誘導・影渡りで仕留めたとき）は、
 * 抱えていた血がそのまま仕留めた側の懐に入る ―― 盤上で一番大きな逆転手。
 */
function killPlayer(
  state: GameState,
  player: Player,
  reason: string,
  killer?: Player,
): void {
  const lost = player.carrying;
  if (killer && killer.index !== player.index && lost > 0) {
    transferBlood(killer, player, lost);
  } else {
    state.bloodPool += lost;
    player.carrying = 0;
  }
  player.deaths += 1;
  player.shroudedCell = null;
  player.at = castleOf(state.board, player.index);
  player.movesLeft = 0;
  if (killer && killer.index !== player.index) killer.kills += 1;
  const spoils =
    lost > 0
      ? killer && killer.index !== player.index
        ? `血 ${lost} は ${killer.name} が啜り、`
        : `血 ${lost} を落とし、`
      : '';
  pushLog(state, `${player.name} は${reason}。${spoils}城へ引き戻された。`, 'bad');
}

/**
 * 他プレイヤーのいるマスへ踏み込んだときの噛みつき。血を1つ奪う。1ターンに1回まで。
 * 「盤上で相手と同じマスに立つ」こと自体に意味を持たせる、常時使える干渉手段
 * ―― 血を積んだ者を帰り道で待ち伏せる、という形の PVP。
 *
 * 城と村では起こらない。城は各プレイヤーの聖域であり、村は全員が必ず立ち寄る
 * 収穫地点なので、ここを狩り場にすると先に着いた者がただ搾取されるだけになる。
 */
function bite(state: GameState, attacker: Player, cellIdAt: string): void {
  if (attacker.bitThisTurn) return;
  const kind = state.board.cells[cellIdAt].kind;
  if (kind === 'castle' || kind === 'village') return;
  const prey = state.players
    .filter((p) => p.index !== attacker.index && p.at === cellIdAt && p.carrying > 0)
    .sort((a, b) => b.carrying - a.carrying)[0];
  if (!prey) return;
  transferBlood(attacker, prey, 1);
  attacker.bitThisTurn = true;
  pushLog(
    state,
    `${attacker.name} が ${prey.name} に噛みつき、血を1つ奪った（運搬中 ${attacker.carrying}）。`,
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

  // 先客がいれば噛みつく（1ターン1回）
  bite(state, player, target);

  // 自分の城に入ったら血が得点になる
  bankBlood(state, player);

  // 洞窟でコウモリを拾う（1つの洞窟は一夜に1回、1ターンに1度まで）。
  // 洞窟が2つしかないぶん、1度の訪問で CAVE_DRAW 枚が付いてくる
  if (
    cell.kind === 'cave' &&
    !player.lootedCaveThisTurn &&
    !state.cavesLooted.includes(target)
  ) {
    if (drawBat(state, player)) {
      let drawn = 1;
      while (drawn < CAVE_DRAW && drawBat(state, player)) drawn++;
      state.cavesLooted.push(target);
      player.lootedCaveThisTurn = true;
      pushLog(state, `${player.name} が洞窟でコウモリを${drawn}枚得た。`, 'good');
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
      const got = Math.min(rollSuck(state), state.bloodPool);
      state.bloodPool -= got;
      player.carrying += got;
      pushLog(state, `${player.name} が村で血を ${got} 吸った（運搬中 ${player.carrying}）。`, 'good');
    } else {
      pushLog(state, `${player.name} は村に入ったが、血はもう残っていない。`, 'warn');
    }
  }

  bankBlood(state, player);
  player.movesLeft = 0;

  const next = (state.current + 1) % state.players.length;
  if (next !== state.startPlayer) {
    state.current = next;
    beginTurn(state);
    return;
  }

  endRound(state);
}

function endRound(state: GameState): void {
  moveHunters(state);

  state.intoNight += 1;
  // 最初の safeRounds ラウンドは必ず夜が続く。それを越えてから毎ラウンドの賭けになる
  const dawnNow =
    state.intoNight > state.config.safeRounds &&
    roll(state, 10_000) / 10_000 < state.config.dawnChance;
  if (dawnNow) {
    resolveDawn(state);
    if (state.phase === 'gameover') return;
  }

  if (checkBloodExhausted(state)) return;

  state.round += 1;
  state.current = state.startPlayer;
  if (!dawnNow) {
    const safe = safeRoundsLeft(state);
    pushLog(
      state,
      safe > 0
        ? `あと ${safe} ラウンドは朝が来ない。`
        : `いつ朝が来てもおかしくない（毎ラウンド ${Math.round(state.config.dawnChance * 100)}%）。`,
      'warn',
    );
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
  state.intoNight = 0;

  if (state.night >= state.config.totalNights) {
    finishGame(state, '規定の夜数が終わった');
    return;
  }

  state.night += 1;
  state.phase = 'playing';
  // 先手は夜ごとに1つ回る。同じ席が毎晩「村に一番乗り」し続ける不公平を消す
  state.startPlayer = (state.night - 1) % state.players.length;
  pushLog(
    state,
    `第${state.night}夜が始まる。先手は ${state.players[state.startPlayer].name}。${
      isFinalNight(state)
        ? '最終夜 ―― 持ち帰った血は3倍。'
        : `${state.config.safeRounds} ラウンドは朝が来ない。`
    }`,
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
  /** steal / swap: 対象プレイヤーの index */
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
      return flightTargets(state).length > 0 ? null : '空いている避難所がない';
    case 'swap':
      if (state.board.cells[player.at].kind === 'castle') return '城の中からは使えない';
      return swapTargets(state).length > 0 ? null : '入れ替われる相手がいない';
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
  return state.board.refugeCells.filter(
    (id) => id !== me.at && !state.players.some((p) => p.index !== me.index && p.at === id),
  );
}

/** 影渡りの相手。城にいる者とは入れ替われない（城は各プレイヤーの聖域） */
export function swapTargets(state: GameState): number[] {
  const me = currentPlayer(state);
  if (state.board.cells[me.at].kind === 'castle') return [];
  return state.players
    .filter((p) => p.index !== me.index && state.board.cells[p.at].kind !== 'castle')
    .map((p) => p.index);
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
        if (p.at === id) killPlayer(state, p, 'ハンターを差し向けられた', player);
      }
      break;
    }
    case 'steal': {
      const targets = stealTargets(state);
      const victimIndex = target.player !== undefined && targets.includes(target.player)
        ? target.player
        : targets[0];
      const victim = state.players[victimIndex];
      transferBlood(player, victim, 1);
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
      pushLog(state, `${player.name} が《${spec.name}》で避難所へ舞い降りた。`, 'info');
      if (hunterCells(state).includes(dest)) {
        killPlayer(state, player, 'ハンターの真上に降りてしまった');
      }
      break;
    }
    case 'swap': {
      const targets = swapTargets(state);
      const victimIndex =
        target.player !== undefined && targets.includes(target.player)
          ? target.player
          : targets[0];
      const victim = state.players[victimIndex];
      const mine = player.at;
      player.at = victim.at;
      victim.at = mine;
      player.movesLeft = 0;
      // 影を渡った先が自分の影だったなら、その加護は置いてきたことになる
      if (player.shroudedCell !== null && player.shroudedCell !== player.at) {
        player.shroudedCell = null;
      }
      pushLog(
        state,
        `${player.name} が《${spec.name}》で ${victim.name} と位置を入れ替えた。`,
        'bad',
      );
      const hunters = hunterCells(state);
      // 相手をハンターの真上へ放り込んだなら、その血は放り込んだ側のもの
      if (hunters.includes(victim.at)) {
        killPlayer(state, victim, 'ハンターの前へ突き出された', player);
      }
      if (hunters.includes(player.at)) {
        killPlayer(state, player, 'ハンターの懐へ飛び込んでしまった');
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
