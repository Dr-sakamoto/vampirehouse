import {
  CASTLE_SECTORS,
  RING_COUNT,
  VILLAGE,
  castleGate,
  castleOf,
  cellId,
  createBoard,
  isRefugeKind,
  wrapSector,
} from './board';
import { BAT_SPECS, HAND_LIMIT, buildDeck } from './bats';
import { nextRandom, shuffle } from './rng';
import type {
  BatKind,
  Board,
  GameConfig,
  GameState,
  Hunter,
  LogEntry,
  Player,
  Trap,
  TrailStep,
} from './types';

export const PLAYER_COLORS = ['#e63946', '#4361ee', '#2a9d3f', '#f4a300'];
export const PLAYER_NAMES = ['紅の城', '蒼の城', '翠の城', '金の城'];

/**
 * すべての公開関数は state を破壊的に更新する。
 * UI 側は呼び出し後に再描画するだけでよい。
 */

/**
 * 村で一口に吸える血の目。
 *
 * 血そのものが点の単位になっている ―― 30 の血を持ち帰れば 30 点。
 * 「何本」と「何点」を別々に数えるのをやめたので、運搬中の数字を見れば
 * いま何点を抱えて歩いているかがそのまま分かる。
 *
 * 幅を 10〜100 と10倍に取ってあるのは、一口ごとの当たり外れを大きくして
 * 「もう一口いくか」の判断に重みを持たせるため。上振れ（100）を引いた者は
 * その場で帰りたくなり、下振れ（10）を引いた者はもう1ターン粘りたくなる。
 */
const DEFAULT_SUCK_FACES = [10, 30, 50, 100];

export function defaultConfig(playerCount = 2, bots?: boolean[]): GameConfig {
  return {
    playerCount,
    bots: bots ?? Array.from({ length: playerCount }, (_, i) => i > 0),
    baseMove: 3,
    suckFaces: [...DEFAULT_SUCK_FACES],
    safeRounds: 3,
    dawnChance: 1 / 3,
    totalNights: 4,
    bloodPool: 350 * playerCount,
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
    lootedCaveThisTurn: false,
    bitThisTurn: false,
    rushing: false,
    stunned: false,
    parasol: false,
    deaths: 0,
    delivered: 0,
    stolen: 0,
    kills: 0,
    burned: 0,
    sheltered: 0,
    stunsTaken: 0,
  }));

  const state: GameState = {
    config,
    board,
    players,
    hunters: initialHunters(),
    deck: shuffled.items,
    discard: [],
    bloodPool: config.bloodPool,
    traps: [],
    dawnPending: false,
    round: 1,
    intoNight: 0,
    night: 1,
    current: 0,
    startPlayer: 0,
    phase: 'playing',
    log: [],
    lastBurned: [],
    trail: [],
    trailSeq: 0,
    batPlays: [],
    batPlaySeq: 0,
    rngState: shuffled.state,
  };

  pushLog(state, `第1夜。${config.safeRounds} ラウンドは朝が来ない。`, 'info');
  beginTurn(state);
  return state;
}

// ---------------------------------------------------------------- ログ

/** 駒移動を1件記録する（UIのアニメーション・軌跡描画用）。ログと同じく直近のみ保つ */
function pushTrail(
  state: GameState,
  player: number,
  from: string,
  to: string,
  kind: TrailStep['kind'],
): void {
  if (from === to) return;
  state.trail.push({ seq: state.trailSeq++, player, from, to, kind });
  if (state.trail.length > 200) state.trail.splice(0, state.trail.length - 200);
}

function pushLog(state: GameState, text: string, tone: LogEntry['tone'] = 'info'): void {
  state.log.push({ round: state.round, night: state.night, text, tone });
  if (state.log.length > 200) state.log.splice(0, state.log.length - 200);
}

/** コウモリ使用を1件記録する（UIのカットイン演出用）。誰が何を使ったかだけを持つ */
function pushBatPlay(state: GameState, player: number, kind: BatKind): void {
  state.batPlays.push({ seq: state.batPlaySeq++, player, kind });
  if (state.batPlays.length > 200) state.batPlays.splice(0, state.batPlays.length - 200);
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

/**
 * 夜明けを生き延びられるマスか。洞窟は岩陰が陽を遮るので日陰を兼ねる。
 *
 * マスを日陰に変える札（旧《影紡ぎ》）は廃止した。「このマスは今夜だけ日陰」は
 * 他プレイヤーから見て日陰なのかどうかが分からず、盤面を読めなくする。
 * 陽光をしのぐ手段は、いま座っている場所か、差した傘（parasol）だけ。
 */
export function isSafeCell(state: GameState, _player: Player, id: string): boolean {
  const cell = state.board.cells[id];
  if (!cell) return false;
  if (cell.kind === 'castle') return true;
  return isRefugeKind(cell.kind);
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

/**
 * 最終夜は村が3倍濃い。差がついていても、最後の一往復で全部ひっくり返る。
 *
 * 「持ち帰りを3倍にする」のではなく**湧く血のほうを3倍**にしているのは、
 * 血と点を同じ数字に保つため ―― 抱えている 300 は、どの夜でも 300 点になる。
 */
export function villageRichness(state: GameState): number {
  return isFinalNight(state) ? 3 : 1;
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

/** 村で1ターン粘ったときに吸える血。最終夜は村が濃くなる */
function rollSuck(state: GameState): number {
  const faces = state.config.suckFaces;
  if (faces.length === 0) return 1;
  return faces[roll(state, faces.length)] * villageRichness(state);
}

/** 吸血の目の幅と期待値。UI とボットが同じ表を見る */
export function suckRange(state: GameState): { min: number; max: number; mean: number } {
  const faces = state.config.suckFaces;
  // 最終夜は村が濃くなるので、見せる幅もそのぶん広げる
  const rich = villageRichness(state);
  const mean = (faces.reduce((a, b) => a + b, 0) / faces.length) * rich;
  return { min: Math.min(...faces) * rich, max: Math.max(...faces) * rich, mean };
}

/**
 * 今夜が「必ず続く」残りラウンド数。ここまでは朝が来ないので、
 * この範囲の往復は完全に計算できる。
 */
export function safeRoundsLeft(state: GameState): number {
  return Math.max(0, state.config.safeRounds - state.intoNight);
}

/**
 * このラウンドの終わりに「夜明けが予告される」確率。安全ラウンドのうちは0。
 * 既に予告済みなら賭けは終わっているので0を返す（`dawnPending` を見ること）。
 */
export function dawnRisk(state: GameState): number {
  if (state.dawnPending) return 0;
  // 予告のダイスはラウンドの終わりに振られる。いま進行中のラウンドが
  // 確定夜の最後の1つなら、その終わりにはもう空が白みうる
  return safeRoundsLeft(state) > 1 ? 0 : state.config.dawnChance;
}

/**
 * このラウンドの終わりに朝が来ることが確定しているか。
 *
 * 予告されたラウンドが、この盤面で唯一「全員が同時に椅子へ走る」場面になる。
 * 締め出しの札（罠・強襲・影渡り）はここで撃ってこそ効く。
 */
export function dawnAnnounced(state: GameState): boolean {
  return state.dawnPending;
}

/** そのマスに仕掛けられている罠。伏せずに全員へ見えている */
export function trapAt(state: GameState, id: string): Trap | undefined {
  return state.traps.find((t) => t.cell === id);
}

// ---------------------------------------------------------------- ターン進行

export function beginTurn(state: GameState): void {
  const player = currentPlayer(state);
  if (player.stunned) {
    player.movesLeft = 0;
    player.stunned = false;
    pushLog(state, `${player.name} は痺れて動けない。`, 'bad');
  } else {
    player.movesLeft = moveAllowance(state, player);
  }
  player.batsPlayedThisTurn = 0;
  player.lootedCaveThisTurn = false;
  player.bitThisTurn = false;
  player.rushing = false;
}

/**
 * スタン ―― 移動力を0にする。相手が手番中なら今の手番、そうでなければ次の手番。
 *
 * どちらの場合も奪うのは「1手番ぶんの足」で、効き目は同じ。夜明けが予告された
 * ラウンドに当てれば、村から2歩のテントにすら届かなくなる ＝ 締め出しになる。
 * 逆にそれ以外のラウンドでは1手番の遠回りでしかない。
 * だからスタンの札は予告ラウンドまで温存される ―― ただし手札は3枚しかない。
 */
function stun(state: GameState, victim: Player, reason: string): void {
  victim.stunsTaken += 1;
  if (victim.index === state.current) {
    victim.movesLeft = 0;
  } else {
    victim.stunned = true;
  }
  pushLog(state, `${victim.name} は${reason}、動きを止められた。`, 'bad');
}

function drawBat(state: GameState, player: Player): boolean {
  if (player.bats.length >= HAND_LIMIT) return false;
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

  // 血がそのまま点。換算式は無い
  const carried = player.carrying;
  player.score += carried;
  player.delivered += carried;
  player.carrying = 0;
  pushLog(state, `${player.name} が血 ${carried} を持ち帰った。そのまま ${carried} 点。`, 'good');
}

/**
 * 一口ぶんの奪い高。相手が抱えている血の半分（10単位に丸める）。
 *
 * 血が「本数」だった頃、噛みつきは1本＝おおむね相手の持ち分の半分を奪っていた。
 * 血が点そのものになった今、固定額にすると相手の懐次第で無意味にも致命的にもなるので、
 * 当時の割合をそのまま規則にした。盤上の数字がいくつになっても効き目が変わらない。
 */
export function biteAmount(carrying: number): number {
  if (carrying <= 0) return 0;
  return Math.max(10, Math.round(carrying / 2 / 10) * 10);
}

/** 血を被害者から加害者へ移す。総量は変わらない */
function transferBlood(thief: Player, victim: Player, amount: number): void {
  const taken = Math.min(amount, victim.carrying);
  if (taken <= 0) return;
  victim.carrying -= taken;
  thief.carrying += taken;
  thief.stolen += taken;
}

/**
 * ハンターに触れた／太陽に焼かれたときの共通処理。血は村へ還る。
 * ただし killer が指定されているとき（影渡りで仕留めたとき）は、
 * 抱えていた血がそのまま仕留めた側の懐に入る ―― 盤上で一番大きな逆転手。
 *
 * 蝙蝠傘を差していれば、その1回だけを傘が肩代わりする。血も位置もそのまま残り、
 * 傘だけが消える。戻り値は「本当に死んだか」。
 */
function killPlayer(
  state: GameState,
  player: Player,
  reason: string,
  killer?: Player,
): boolean {
  if (player.parasol) {
    player.parasol = false;
    pushLog(state, `${player.name} は${reason}が、蝙蝠傘が身代わりになった。`, 'warn');
    return false;
  }
  const lost = player.carrying;
  if (killer && killer.index !== player.index && lost > 0) {
    transferBlood(killer, player, lost);
  } else {
    state.bloodPool += lost;
    player.carrying = 0;
  }
  player.deaths += 1;
  player.stunned = false;
  const origin = player.at;
  player.at = castleOf(state.board, player.index);
  player.movesLeft = 0;
  pushTrail(state, player.index, origin, player.at, 'teleport');
  if (killer && killer.index !== player.index) killer.kills += 1;
  const spoils =
    lost > 0
      ? killer && killer.index !== player.index
        ? `血 ${lost} は ${killer.name} が啜り、`
        : `血 ${lost} を落とし、`
      : '';
  pushLog(state, `${player.name} は${reason}。${spoils}城へ引き戻された。`, 'bad');
  return true;
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
  const taken = biteAmount(prey.carrying);
  transferBlood(attacker, prey, taken);
  attacker.bitThisTurn = true;
  pushLog(
    state,
    `${attacker.name} が ${prey.name} に噛みつき、血 ${taken} を奪った（運搬中 ${attacker.carrying}）。`,
    'bad',
  );
}

/**
 * 《強襲》が当たったときの処理 ―― 相手を組み伏せ、抱えていた血をすべて奪い、
 * その場に押さえて足を止める。仕留めはしない。
 *
 * 以前は「仕留める」（血を奪ったうえで城へ送り返す）だったが、ボット200戦で
 * 測ると**強襲が動かす血は仕留めても組み伏せても変わらなかった**
 * （48/106/149 → 52/107/156）。この札の重さは最初から積荷のほうにあって、
 * 城へ送り返す部分ではなかった ―― つまり仕留めを外しても札は弱くならず、
 * 「一夜の労働と盤上の位置を同時に消される」理不尽さだけが落ちる
 * （[`docs/balance.md`](../../docs/balance.md) §2）。
 *
 * 奪い高を半分にする案は落とした。噛みつきが無料で半分を取る以上
 * （§6）、札を1枚払って同じ額になり、**札が何もしない対照と得点も勝差も
 * 一致した**。カードは無料の手より重くなければ、置く意味が無い。
 *
 * 足を止めるほうは残す。コウモリは締め出しの札に絞ってあり、予告ラウンドに
 * 当てれば椅子に届かなくなる ―― 血を奪われたうえで日向に置き去りにされる、
 * というのが「組み伏せる」の素直な絵でもある。仕留めていた頃はここが逆で、
 * 城は日陰なので**送り返すことが助けになっていた**。
 *
 * 即死ではなくなったので、蝙蝠傘（陽光とハンターの肩代わり）では防げない。
 */
function pinDown(state: GameState, attacker: Player, victim: Player): void {
  const loot = victim.carrying;
  if (loot > 0) {
    transferBlood(attacker, victim, loot);
    pushLog(
      state,
      `${attacker.name} が ${victim.name} を組み伏せ、血 ${loot} を奪った（運搬中 ${attacker.carrying}）。`,
      'bad',
    );
  }
  stun(state, victim, `${attacker.name} に組み伏せられ`);
}

/** 1マス移動する。移動できたら true */
export function moveTo(state: GameState, target: string): boolean {
  if (state.phase !== 'playing') return false;
  if (!legalMoves(state).includes(target)) return false;

  const player = currentPlayer(state);
  const origin = player.at;
  player.at = target;
  player.movesLeft -= 1;
  pushTrail(state, player.index, origin, target, 'walk');

  // ハンターに触れたら即死（傘があれば1回だけ肩代わりして、その場で足が止まる）
  if (hunterCells(state).includes(target)) {
    if (killPlayer(state, player, 'ハンターに討たれた')) return true;
    player.movesLeft = 0;
    return true;
  }

  // 他人の罠に掛かった。そのマスに貼り付けられ、この手番の足はそこで終わる。
  //
  // 弾き返すのではなく吸着させる ―― 規則としては「移動力を失う」だけで済むし、
  // 罠を踏んだら捕まる、という絵のほうが素直。避難所に張った罠が相手を
  // 座らせてしまうのは弱点に見えるが、**最終夜は避難所に座っても0点**なので、
  // 血を抱えたまま椅子に貼り付けられるのはむしろ致命傷になる。
  const trap = state.traps.find((t) => t.cell === target && t.owner !== player.index);
  if (trap) {
    state.traps = state.traps.filter((t) => t !== trap);
    stun(state, player, `${state.players[trap.owner].name} の罠に捕まり`);
  }

  const cell = state.board.cells[target];

  // 《強襲》を切っていれば、通り抜けたマスにいる相手を組み伏せる。
  //
  // 当たる機会そのものが少ない札（相手のマスへちょうど乗る精度が要る）なので、
  // 当たり判定を広げるのではなく一撃を重くしてある ―― 決まれば相手の血は
  // すべて襲った側のものになる。狙って当てたときだけ盤面がひっくり返る。
  if (player.rushing) {
    for (const p of state.players) {
      if (p.index !== player.index && p.at === target) {
        pinDown(state, player, p);
      }
    }
  }

  // 先客がいれば噛みつく（1ターン1回）
  bite(state, player, target);

  // 自分の城に入ったら血が得点になる
  bankBlood(state, player);

  // 洞窟でコウモリを拾う（誰が先に通ったかは関係なく、通過するたびに1枚）。
  if (cell.kind === 'cave' && !player.lootedCaveThisTurn) {
    if (drawBat(state, player)) {
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

  // 予告されていたラウンドが終わった ―― 朝が来る
  const dawnNow = state.dawnPending;
  if (dawnNow) {
    resolveDawn(state);
    if (state.phase === 'gameover') return;
  } else if (
    // 最初の safeRounds ラウンドは必ず夜が続く。それを越えてから毎ラウンドの賭けになる。
    // 当たっても即座に朝にはせず、1ラウンドの猶予つきで予告する
    state.intoNight >= state.config.safeRounds &&
    roll(state, 10_000) / 10_000 < state.config.dawnChance
  ) {
    state.dawnPending = true;
  }

  if (checkBloodExhausted(state)) return;

  state.round += 1;
  state.current = state.startPlayer;
  if (state.dawnPending) {
    pushLog(state, '東の空が白んだ ―― このラウンドの終わりに朝が来る。', 'warn');
  } else if (!dawnNow) {
    const safe = safeRoundsLeft(state);
    pushLog(
      state,
      safe > 0
        ? `あと ${safe} ラウンドは朝の兆しも出ない。`
        : `いつ空が白んでもおかしくない（毎ラウンド ${Math.round(state.config.dawnChance * 100)}%）。`,
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
      const inRefuge = state.board.cells[p.at].kind !== 'castle';
      if (inRefuge) p.sheltered += 1;
      pushLog(state, `${p.name} は${inRefuge ? '日陰' : '城'}で朝をやり過ごした。`, 'good');
    } else if (killPlayer(state, p, '陽光に焼かれた')) {
      p.burned += 1;
      state.lastBurned.push(p.index);
    }
    // 傘は夜を越せない。罠も朝日で焼け落ちる
    p.parasol = false;
    p.stunned = false;
  }

  state.traps = [];
  state.intoNight = 0;
  state.dawnPending = false;

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
  /** swap: 入れ替わる相手の index */
  player?: number;
}

/** そのカードを今この瞬間に使えるか（使えない理由を返す） */
export function batPlayError(state: GameState, kind: BatKind): string | null {
  if (state.phase !== 'playing') return 'いま使えない';
  const player = currentPlayer(state);
  if (player.batsPlayedThisTurn >= state.config.batsPerTurn) {
    return `1ターンに使えるのは ${state.config.batsPerTurn} 枚まで`;
  }
  switch (kind) {
    case 'snare': {
      const kindHere = state.board.cells[player.at].kind;
      // 村と城には仕掛けられない。全員が必ず立ち寄る収穫地と、各自の聖域は狩り場にしない。
      // 避難所には置ける ―― 座っている椅子に罠を張って「ここは俺のだ」と主張できる
      if (kindHere === 'village' || kindHere === 'castle') return 'ここには仕掛けられない';
      return trapAt(state, player.at) ? 'ここには既に罠がある' : null;
    }
    case 'rush':
      return player.rushing ? 'もう強襲している' : null;
    case 'parasol':
      return player.parasol ? 'もう傘を差している' : null;
    case 'swap':
      if (state.board.cells[player.at].kind === 'castle') return '城の中からは使えない';
      return swapTargets(state).length > 0 ? null : '入れ替われる相手がいない';
  }
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
  pushBatPlay(state, player.index, card.kind);

  switch (card.kind) {
    case 'snare': {
      state.traps.push({ cell: player.at, owner: player.index });
      pushLog(state, `${player.name} が《${spec.name}》を足元に仕掛けた。`, 'info');
      break;
    }
    case 'rush': {
      player.rushing = true;
      // 既に同じマスに立っている相手は、踏み込み直すまでもなくその場で組み伏せる
      for (const p of state.players) {
        if (p.index !== player.index && p.at === player.at) {
          pinDown(state, player, p);
        }
      }
      pushLog(state, `${player.name} が《${spec.name}》の構えを取った。`, 'info');
      break;
    }
    case 'parasol': {
      player.parasol = true;
      pushLog(state, `${player.name} が《${spec.name}》を差した。`, 'info');
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
      const theirs = victim.at;
      player.at = theirs;
      victim.at = mine;
      player.movesLeft = 0;
      pushTrail(state, player.index, mine, theirs, 'teleport');
      pushTrail(state, victim.index, theirs, mine, 'teleport');
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

export { CASTLE_SECTORS, VILLAGE, castleGate, castleOf, cellId };
export type { Board };
