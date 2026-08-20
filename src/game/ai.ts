import { VILLAGE, cellId } from './board';
import { HAND_LIMIT } from './bats';
import {
  batPlayError,
  dawnRisk,
  currentPlayer,
  dawnAnnounced,
  endTurn,
  hunterCells,
  hunterNextCell,
  isFinalNight,
  isSafeCell,
  legalMoves,
  moveAllowance,
  moveTo,
  playBat,
  plannedRoundsLeft,
  suckRange,
  swapTargets,
  trapAt,
  castleOf,
} from './rules';
import type { BatKind, GameState, Player } from './types';

/**
 * 欲張りの上限。これ以上抱えたら、次の一口より持ち帰りを優先する。
 * 血が点そのものになったので、単位も点（＝村の一口の平均のおよそ5回ぶん）。
 * 低すぎると帰りが早すぎて損をする（`npm run balance` で計測して調整）。
 */
const GREED_CAP = 220;

function findBat(player: Player, kind: BatKind): string | null {
  return player.bats.find((b) => b.kind === kind)?.uid ?? null;
}

/** 今このラウンドでハンターが居る／来るマス */
function dangerCells(state: GameState): Set<string> {
  const set = new Set<string>();
  for (const h of state.hunters) {
    set.add(cellId(h.ring, h.sector));
    set.add(hunterNextCell(h));
  }
  return set;
}

/** 他人の城。誰がどこに立っていようと、ここだけは永久に通れない */
function foreignCastles(state: GameState, me: Player): Set<string> {
  const set = new Set<string>();
  for (const id of state.board.castleCells) {
    if (state.board.cells[id].castleOf !== me.index) set.add(id);
  }
  return set;
}

/**
 * 侵入できない／踏みたくないマス（他人の城・埋まった避難所・他人の罠）。
 * 罠は伏せずに盤上へ出ているので、踏むのは読み違えたときだけ ―― 経路からは外す。
 */
function blockedCells(state: GameState, me: Player): Set<string> {
  const set = foreignCastles(state, me);
  for (const p of state.players) {
    if (p.index !== me.index && state.board.cells[p.at].kind === 'shade') set.add(p.at);
  }
  for (const t of state.traps) {
    if (t.owner !== me.index) set.add(t.cell);
  }
  return set;
}

/** avoid を避けた最短経路（from を含む）。無ければ null */
function safePath(
  state: GameState,
  from: string,
  to: string,
  avoid: Set<string>,
): string[] | null {
  if (from === to) return [from];
  const prev: Record<string, string> = {};
  const seen = new Set([from]);
  const queue = [from];
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head];
    for (const n of state.board.cells[id].neighbors) {
      if (seen.has(n) || avoid.has(n)) continue;
      seen.add(n);
      prev[n] = id;
      if (n === to) {
        const path = [to];
        let cur = to;
        while (cur !== from) {
          cur = prev[cur];
          path.unshift(cur);
        }
        return path;
      }
      queue.push(n);
    }
  }
  return null;
}

/** ハンターを避けた経路を優先し、無ければ現在位置のハンターだけ避ける */
function routeFrom(state: GameState, me: Player, from: string, target: string): string[] | null {
  const blocked = blockedCells(state, me);
  const cautious = new Set([...blocked, ...dangerCells(state)]);
  const path = safePath(state, from, target, cautious);
  if (path) return path;
  // どう通ってもハンターの進路をかすめるなら、せめて今いるマスだけは踏まない
  const minimal = new Set([...blocked, ...hunterCells(state)]);
  return safePath(state, from, target, minimal);
}

function routeTo(state: GameState, me: Player, target: string): string[] | null {
  return routeFrom(state, me, me.at, target);
}

function pathCost(path: string[] | null): number {
  return path === null ? Number.POSITIVE_INFINITY : path.length - 1;
}

/**
 * 血を抱えたまま朝を迎えられる、最も近いマス。避難所は洞窟＋テントの6マスだけで、
 * どれも定員1。深部のテントはハンターの巡回路と重なっているので、
 * 次のラウンドに踏まれるマスは避難先から除外する。
 */
function nearestRefuge(
  state: GameState,
  me: Player,
  from: string = me.at,
  /**
   * 何ターンも先の避難を見積もるときは、今そこに誰が座っているかを無視する。
   * 避難所は6マスしかないので、現在の埋まり具合をそのまま未来に投影すると
   * 「どうせ逃げ込めない」と結論して村へ出発すらしなくなる。
   */
  ignoreOccupancy = false,
): { cell: string; cost: number } | null {
  const danger = dangerCells(state);
  const blocked = ignoreOccupancy ? foreignCastles(state, me) : blockedCells(state, me);
  const candidates = [castleOf(state.board, me.index), ...state.board.refugeCells];
  let best: { cell: string; cost: number } | null = null;
  for (const cell of candidates) {
    if (!isSafeCell(state, me, cell)) continue;
    if (blocked.has(cell)) continue;
    if (from === me.at && danger.has(cell)) continue;
    const cost =
      from === me.at
        ? pathCost(routeTo(state, me, cell))
        : pathCost(safePath(state, from, cell, blocked));
    if (cost === Number.POSITIVE_INFINITY) continue;
    if (!best || cost < best.cost) best = { cell, cost };
  }
  return best;
}

/** steps 歩を、今の残り移動力とその後の移動力で何ターンかけて踏破できるか */
function turnsToCover(steps: number, movesNow: number, allowance: number): number {
  if (steps <= movesNow) return 1;
  return 1 + Math.ceil((steps - movesNow) / Math.max(1, allowance));
}

/** まだ採られていない洞窟のうち、村への道からの寄り道が1歩で済むもの */
function cheapCaveDetour(state: GameState, me: Player, directCost: number): string | null {
  let best: { cell: string; extra: number } | null = null;
  for (const cave of state.board.caveCells) {
    const toCave = pathCost(routeTo(state, me, cave));
    if (toCave === Number.POSITIVE_INFINITY) continue;
    const caveToVillage = pathCost(safePath(state, cave, VILLAGE, blockedCells(state, me)));
    const extra = toCave + caveToVillage - directCost;
    if (extra > 1) continue;
    if (!best || extra < best.extra) best = { cell: cave, extra };
  }
  return best?.cell ?? null;
}

/**
 * 血を抱えた相手のマスを通ってから目的地へ向かう経路。
 * 通りすがりに1本奪えるなら、寄り道2歩ぶんまでは払う価値がある。
 */
function biteDetour(
  state: GameState,
  me: Player,
  target: string | null,
  mustArriveThisTurn: boolean,
  /** 強襲で足を止めに行くときは、血を持っていない相手も獲物になる */
  includeEmptyHanded = false,
): string[] | null {
  if (me.movesLeft <= 0) return null;
  if (me.bitThisTurn && !includeEmptyHanded) return null;
  const danger = dangerCells(state);
  const direct = target === null ? 0 : pathCost(routeTo(state, me, target));
  let best: { path: string[]; extra: number } | null = null;

  for (const prey of state.players) {
    if (prey.index === me.index) continue;
    if (prey.carrying <= 0 && !includeEmptyHanded) continue;
    // 既に安全な場所に座っている相手を止めても、朝は押しつけられない
    if (includeEmptyHanded && isSafeCell(state, prey, prey.at)) continue;
    if (state.board.cells[prey.at].kind === 'castle') continue;
    // 噛みに行って轢かれては元も子もない
    if (danger.has(prey.at)) continue;
    const toPrey = routeTo(state, me, prey.at);
    if (!toPrey || pathCost(toPrey) > me.movesLeft) continue;

    const rest =
      target === null || target === prey.at
        ? [prey.at]
        : routeFrom(state, me, prey.at, target);
    if (!rest) continue;
    const total = pathCost(toPrey) + pathCost(rest);
    if (mustArriveThisTurn && total > me.movesLeft) continue;
    const extra = total - direct;
    if (extra > 2) continue;
    if (!best || extra < best.extra) best = { path: [...toPrey, ...rest.slice(1)], extra };
  }
  return best?.path ?? null;
}

/** 経路に沿って、進めるところまで進む */
function walk(state: GameState, path: string[]): void {
  for (const step of path.slice(1)) {
    const me = currentPlayer(state);
    if (me.movesLeft <= 0) break;
    if (!legalMoves(state).includes(step)) break;
    const before = me.at;
    moveTo(state, step);
    // ハンターに討たれて城へ戻された
    if (currentPlayer(state).at !== step && currentPlayer(state).at !== before) break;
  }
}

/**
 * 立ち止まる場所がハンターの進路上なら、余った移動力で一歩ずらす。
 * ハンターは自分の手番のあとに動くので、居座りは轢かれることを意味する。
 */
function stepOffPatrolPath(state: GameState): void {
  const me = currentPlayer(state);
  if (me.movesLeft <= 0) return;
  const danger = dangerCells(state);
  if (!danger.has(me.at)) return;
  const escapes = legalMoves(state).filter((id) => !danger.has(id));
  if (escapes.length === 0) return;
  // 逃げ先は「安全なマス」を優先する
  const refuge = escapes.find((id) => isSafeCell(state, me, id));
  moveTo(state, refuge ?? escapes[0]);
}

/**
 * 村から1ラウンド（移動力1回ぶん）で滑り込める避難所の数。
 * ハンターが今いる／次に踏むマスは椅子として数えない。
 *
 * 避難所はテント2＋洞窟2の4マスしかなく、村から届くのはテント2マスだけ。
 * さらにハンター2体は常に4セクター離れて回り、テントの間隔もちょうど4なので、
 * 8ラウンドに2回この数は0になる ―― そのラウンドの村は死地になる。
 */
function villageSeats(state: GameState, me: Player): number {
  const allowance = moveAllowance(state, me);
  const danger = dangerCells(state);
  const blocked = foreignCastles(state, me);
  return state.board.refugeCells.filter((id) => {
    if (danger.has(id)) return false;
    return pathCost(safePath(state, VILLAGE, id, blocked)) <= allowance;
  }).length;
}

/** 同じ椅子を争うことになる相手 ―― 村に居座っている他プレイヤー */
function villageRivals(state: GameState, me: Player): number {
  return state.players.filter((p) => p.index !== me.index && p.at === VILLAGE).length;
}

/**
 * ここに罠を仕掛ける価値があるか。
 *
 * 締め出しが起きるのは避難所の手前なので、避難所に隣接するマスに置く。
 * 罠は見えているので相手は迂回できるが、予告ラウンドの移動力3で
 * 村→テントの2歩を迂回させられれば、それだけで間に合わなくなることがある。
 */
function worthSnaring(state: GameState, me: Player): boolean {
  const cell = state.board.cells[me.at];
  if (cell.kind === 'village' || cell.kind === 'castle') return false;
  if (trapAt(state, me.at)) return false;
  // 効くのはテントの上か、その手前。洞窟は城の劣化版なので誰も命綱にしない。
  // テントそのものに置ければ最良 ―― その椅子は自分だけのものになる
  const onTent = cell.kind === 'shade';
  if (!onTent && !cell.neighbors.some((id) => state.board.cells[id].kind === 'shade')) {
    return false;
  }
  // 外に出ている相手がいるときだけ意味がある
  return state.players.some(
    (p) => p.index !== me.index && state.board.cells[p.at].kind !== 'castle',
  );
}

/** いま立っている場所に置く価値があるなら罠を置く */
function trySnare(state: GameState): void {
  const me = currentPlayer(state);
  const uid = findBat(me, 'snare');
  if (!uid) return;
  if (!worthSnaring(state, me)) return;
  if (batPlayError(state, 'snare') !== null) return;
  playBat(state, uid);
}

/** ボット1人ぶんの手番をすべて処理し、ターンを終える */
export function botTakeTurn(state: GameState): void {
  if (state.phase !== 'playing') return;
  const me = currentPlayer(state);
  // 夜明けが予告された ＝ このラウンドの終わりに必ず朝が来る。
  // 全員が同時に椅子へ走る、この盤面で唯一の場面
  const escapeNow = dawnAnnounced(state);

  // --- テントの手前に罠を置いておく。夜明けまで残るので、早いほど効く ---
  trySnare(state);

  // --- 行き先を決める ---
  const target = chooseTarget(state, escapeNow);

  // --- 予告ラウンドなら、逃げる途中で誰かを踏み潰せないか探す ---
  // 強襲は「構え」なので、動き出す前に切っておく必要がある
  let path = target === null ? null : routeTo(state, me, target);
  if (escapeNow) {
    const rushUid = findBat(me, 'rush');
    if (rushUid && batPlayError(state, 'rush') === null) {
      const hunt = biteDetour(state, me, target, true, true);
      if (hunt) {
        playBat(state, rushUid);
        path = hunt;
      }
    }
  }

  if (path === null && target !== null) path = routeTo(state, me, target);
  const detour = biteDetour(state, currentPlayer(state), target, escapeNow);
  if (detour && !currentPlayer(state).rushing) path = detour;
  if (path) walk(state, path);
  stepOffPatrolPath(state);
  // 歩いた先がテントの手前だったなら、そこにも置いていく。
  // 手番の初めだけを見ていると、罠を置ける位置に立っている場面をほとんど拾えない
  trySnare(state);

  // --- 朝が来る前の保険（最終夜は隠れても加点されないので使わない） ---
  if (escapeNow && !isFinalNight(state)) {
    const now = currentPlayer(state);
    // 傘は「どこにも間に合わなかった」ときの最後の手段。差せばその場で朝を越せる
    const parasolUid = findBat(now, 'parasol');
    if (!isSafeCell(state, now, now.at) && parasolUid && batPlayError(state, 'parasol') === null) {
      playBat(state, parasolUid);
    }
    // 傘も無いなら、避難所に座っている相手と入れ替わって朝を押しつける
    const swapper = currentPlayer(state);
    const swapUid = findBat(swapper, 'swap');
    if (
      !isSafeCell(state, swapper, swapper.at) &&
      !swapper.parasol &&
      swapUid &&
      batPlayError(state, 'swap') === null
    ) {
      const hunters = new Set(hunterCells(state));
      const candidates = swapTargets(state).filter(
        (i) =>
          isSafeCell(state, swapper, state.players[i].at) && !hunters.has(state.players[i].at),
      );
      // 押しつけるなら、朝を失って一番痛い（血を一番積んだ）相手を選ぶ
      const victim = candidates.reduce<number | null>((acc, i) => {
        const p = state.players[i];
        return acc === null || p.carrying > state.players[acc].carrying ? i : acc;
      }, null);
      if (victim !== null) playBat(state, swapUid, { player: victim });
    }
  }

  endTurn(state);
}

function chooseTarget(state: GameState, escapeNow: boolean): string | null {
  const me = currentPlayer(state);
  const home = castleOf(state.board, me.index);
  const allowance = moveAllowance(state, me);
  const turnsAfterThis = Math.max(0, plannedRoundsLeft(state) - 1);
  const nightBudget = me.movesLeft + turnsAfterThis * allowance;

  // 最終夜の夜明けを越えても得点は増えない。日陰に隠れる意味はもう無い
  const finalDawn = escapeNow && isFinalNight(state);

  // 予告ラウンド: 今このターンで安全圏に入らないと灰になる。粘る余地はもう無い
  if (escapeNow) {
    if (me.at === home) return null;
    const homeCost = pathCost(routeTo(state, me, home));
    if (homeCost <= me.movesLeft) return home;
    if (finalDawn) return home; // 届かなくても構わない。持ったままでは0点なのだから
    const refuge = nearestRefuge(state, me);
    if (refuge && refuge.cost <= me.movesLeft) return refuge.cell;
    // どこにも間に合わない。せめて城に近づいておく（傘と影渡りが最後の手段）
    return home;
  }

  // 村に立っている: もう一口吸うか、引き上げるか
  if (me.at === VILLAGE) {
    const futureCarry = me.carrying + suckRange(state).mean;
    const budgetAfterStaying = turnsAfterThis * allowance;
    const homeCost = pathCost(routeTo(state, me, home));
    const refuge = nearestRefuge(state, me);
    // 最終夜は「生き延びる」では足りない。城まで戻れる見込みが要る
    const canEscapeLater = isFinalNight(state)
      ? homeCost <= budgetAfterStaying
      : homeCost <= budgetAfterStaying ||
        (refuge !== null && refuge.cost <= budgetAfterStaying);

    // もう1ターン粘ると、このラウンドの終わりに空が白むかもしれない。
    // 白んだら猶予は1ラウンド ―― 村から届く椅子が、争う相手より多いうちだけ粘る
    const contested =
      dawnRisk(state) > 0 && villageSeats(state, me) <= villageRivals(state, me);

    if (state.bloodPool > 0 && futureCarry <= GREED_CAP && canEscapeLater && !contested) {
      return null;
    }
    return home;
  }

  // 血を抱えている: 帰れるうちに帰る
  if (me.carrying > 0) {
    const homeCost = pathCost(routeTo(state, me, home));
    if (homeCost <= nightBudget) return home;
    if (isFinalNight(state)) return home; // 夜を越す先がもう無い
    const refuge = nearestRefuge(state, me);
    if (refuge && refuge.cost <= nightBudget) return refuge.cell;
    return home;
  }

  // 手ぶら: 村を目指す。ただし朝までに逃げ込める見込みがある時だけ
  const villageCost = pathCost(routeTo(state, me, VILLAGE));
  if (villageCost === Number.POSITIVE_INFINITY) return home;
  if (state.bloodPool <= 0) {
    // 血が尽きているなら安全に朝を待つ
    const refuge = nearestRefuge(state, me);
    return refuge ? refuge.cell : home;
  }
  if (villageCost > nightBudget) {
    // 今夜は村まで届かない。日陰で夜を越して次の夜に賭ける
    const refuge = nearestRefuge(state, me);
    if (refuge && refuge.cost <= nightBudget) return refuge.cell;
  }
  // 村へ着いてから朝までに逃げ切れないなら、そもそも行かない
  const turnsToVillage = turnsToCover(villageCost, me.movesLeft, allowance);
  const turnsAfterVillage = plannedRoundsLeft(state) - turnsToVillage;
  const escape = nearestRefuge(state, me, VILLAGE, true);
  const canEscapeFromVillage =
    turnsAfterVillage >= 0 &&
    escape !== null &&
    escape.cost <= turnsAfterVillage * allowance;
  if (!canEscapeFromVillage) {
    const refuge = nearestRefuge(state, me);
    if (refuge && refuge.cost <= nightBudget) return refuge.cell;
    return home;
  }

  const cave = cheapCaveDetour(state, me, villageCost);
  if (cave && me.bats.length < HAND_LIMIT) return cave;
  return VILLAGE;
}
