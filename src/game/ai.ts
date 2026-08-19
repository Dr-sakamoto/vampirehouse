import { VILLAGE, cellId, wrapSector } from './board';
import {
  allowanceFor,
  batPlayError,
  currentPlayer,
  endTurn,
  hasThrall,
  hireThrall,
  hunterCells,
  hunterNextCell,
  isFinalNight,
  isSafeCell,
  legalMoves,
  moveAllowance,
  moveTo,
  playBat,
  roundsUntilDawn,
  stealTargets,
  thrallError,
  tideChance,
  flightTargets,
  castleOf,
} from './rules';
import { THRALL_SPECS } from './thralls';
import type { BatKind, GameState, Player, ThrallKind } from './types';

/**
 * 欲張りの上限。《器》は重さの刻みを緩めるので、抱えたまま帰れる量そのものが増える。
 * 実際に引き際を決めるのは下の「帰り道が残っているか」の判定で、これはその外枠。
 */
function greedCap(me: Player): number {
  return hasThrall(me, 'vessel') ? 6 : 3;
}

/**
 * 雇う順番。ボット同士の総当たりで測った効き目の強い順
 * （牙 +8.9pt / 群れ +4.6pt / 翼 +4.4pt / 器 +0.2pt、2人戦の勝率差）。
 * 月潮に効く2体が先に来るのは、効き目を出す機会が1ラウンドに1回あるから。
 */
const HIRE_ORDER: ThrallKind[] = ['fang', 'swarm', 'wing', 'vessel'];

/** そのマスで月潮を待ったときに得られる血の期待値 */
function tideValue(state: GameState, me: Player, cell: string): number {
  const c = state.board.cells[cell];
  // 城と村は血脈の外（村はターン終了時に確実に1つ吸える別枠）
  if (c.ring === 0 || c.ring === state.board.castleRing) return 0;
  const payout = hasThrall(me, 'fang') ? 2 : 1;
  let chance = tideChance(c.ring);
  // 《群れ》は隣のリングの出目まで拾う
  if (hasThrall(me, 'swarm')) chance += tideChance(c.ring - 1) + tideChance(c.ring + 1);
  return chance * payout;
}

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

/** 侵入できないマス（他人の城・埋まった日陰） */
function blockedCells(state: GameState, me: Player): Set<string> {
  const set = new Set<string>();
  for (const id of state.board.order) {
    const cell = state.board.cells[id];
    if (cell.kind === 'castle' && cell.castleOf !== me.index) set.add(id);
  }
  for (const p of state.players) {
    if (p.index !== me.index && state.board.cells[p.at].kind === 'shade') set.add(p.at);
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
function routeTo(state: GameState, me: Player, target: string): string[] | null {
  const blocked = blockedCells(state, me);
  const cautious = new Set([...blocked, ...dangerCells(state)]);
  const path = safePath(state, me.at, target, cautious);
  if (path) return path;
  const minimal = new Set([...blocked, ...hunterCells(state)]);
  return safePath(state, me.at, target, minimal);
}

function pathCost(path: string[] | null): number {
  return path === null ? Number.POSITIVE_INFINITY : path.length - 1;
}

/**
 * 血を抱えたまま朝を迎えられる、最も近いマス。
 * 深部リングの日陰はハンターの巡回路と重なっているので、
 * 次のラウンドに踏まれるマスは避難先から除外する。
 */
function nearestRefuge(
  state: GameState,
  me: Player,
  from: string = me.at,
): { cell: string; cost: number } | null {
  const danger = dangerCells(state);
  const blocked = blockedCells(state, me);
  const candidates = [castleOf(state.board, me.index), ...state.board.shadeCells];
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
    if (state.cavesLooted.includes(cave)) continue;
    const toCave = pathCost(routeTo(state, me, cave));
    if (toCave === Number.POSITIVE_INFINITY) continue;
    const caveToVillage = pathCost(safePath(state, cave, VILLAGE, blockedCells(state, me)));
    const extra = toCave + caveToVillage - directCost;
    if (extra > 1) continue;
    if (!best || extra < best.extra) best = { cell: cave, extra };
  }
  return best?.cell ?? null;
}

/** 誘導カードで血を持った相手を仕留められるなら、その手を返す */
function findLureKill(state: GameState): { hunter: string; dir: 1 | -1 } | null {
  const me = currentPlayer(state);
  for (const hunter of state.hunters) {
    for (const dir of [1, -1] as const) {
      const cell = cellId(hunter.ring, wrapSector(hunter.sector + dir));
      const victim = state.players.find((p) => p.index !== me.index && p.at === cell);
      if (victim && victim.carrying > 0) return { hunter: hunter.id, dir };
    }
  }
  return null;
}

/** 経路に沿って、limit 歩ぶんだけ進む */
function walk(state: GameState, path: string[], limit = Number.POSITIVE_INFINITY): void {
  let taken = 0;
  for (const step of path.slice(1)) {
    if (taken >= limit) break;
    const me = currentPlayer(state);
    if (me.movesLeft <= 0) break;
    if (!legalMoves(state).includes(step)) break;
    const before = me.at;
    moveTo(state, step);
    taken += 1;
    // ハンターに討たれて城へ戻された
    if (currentPlayer(state).at !== step && currentPlayer(state).at !== before) break;
  }
}

/**
 * 経路のどこで足を止めるか。
 *
 * 目的地に着くまでの「ターン数」が変わらないなら、あと1歩ぶん手前で止まっても
 * 損はしない ―― その1歩の差が、月潮の当たりやすいリングかどうかを決める。
 * 予定を1ターンも遅らせない範囲でだけ、出目の期待値を拾いにいく。
 */
function tideAwareStop(state: GameState, path: string[]): number {
  const me = currentPlayer(state);
  const reach = Math.min(me.movesLeft, path.length - 1);
  if (reach <= 0) return 0;

  const danger = dangerCells(state);
  const allowanceNext = moveAllowance(state, me);
  const turnsLeftFrom = (k: number) =>
    Math.ceil(Math.max(0, path.length - 1 - k) / Math.max(1, allowanceNext));

  let best = reach;
  let bestValue = tideValue(state, me, path[reach]);
  const bestTurns = turnsLeftFrom(reach);

  for (let k = reach - 1; k >= 1; k--) {
    // 予定が1ターンでも遅れるなら、そこから先の手前止まりは検討しない
    if (turnsLeftFrom(k) > bestTurns) break;
    if (danger.has(path[k])) continue;
    const value = tideValue(state, me, path[k]);
    if (value > bestValue) {
      best = k;
      bestValue = value;
    }
  }
  return best;
}

/**
 * 眷属に切るコウモリの順番。夜明けから自分を救う札（影紡ぎ・飛翔・疾走）は最後まで残し、
 * 相手を狙うだけの札から先に手放す。
 */
const SPEND_ORDER: BatKind[] = ['lure', 'steal', 'dash', 'flight', 'shroud'];

function cardsToSpend(me: Player, count: number): string[] {
  return [...me.bats]
    .sort((a, b) => SPEND_ORDER.indexOf(a.kind) - SPEND_ORDER.indexOf(b.kind))
    .slice(0, count)
    .map((c) => c.uid);
}

/** 自分の城に立っているうちに、集めたコウモリを永続の力に変えておく */
function hireIfWorthIt(state: GameState): void {
  // 最終夜に雇っても、効き目を出す夜がもう残っていない
  if (isFinalNight(state)) return;
  for (const kind of HIRE_ORDER) {
    const me = currentPlayer(state);
    if (thrallError(state, me, kind) !== null) continue;
    hireThrall(state, kind, cardsToSpend(me, THRALL_SPECS[kind].cost));
    return;
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

/** ボット1人ぶんの手番をすべて処理し、ターンを終える */
export function botTakeTurn(state: GameState): void {
  if (state.phase !== 'playing') return;
  const me = currentPlayer(state);
  const lastRoundOfNight = roundsUntilDawn(state) === 1;

  // --- 手番開始時のカード ---
  const lure = findLureKill(state);
  if (lure && findBat(me, 'lure') && batPlayError(state, 'lure') === null) {
    playBat(state, findBat(me, 'lure')!, lure);
  }

  const homeCost = pathCost(routeTo(state, me, castleOf(state.board, me.index)));
  const stealUid = findBat(me, 'steal');
  if (
    stealUid &&
    batPlayError(state, 'steal') === null &&
    stealTargets(state).length > 0 &&
    homeCost <= me.movesLeft
  ) {
    // このターンで持ち帰れるなら、奪った血はそのまま得点になる
    playBat(state, stealUid, { player: stealTargets(state)[0] });
  }

  // --- 行き先を決める ---
  const target = chooseTarget(state, lastRoundOfNight);

  if (target !== null) {
    let path = routeTo(state, me, target);
    const dashUid = findBat(me, 'dash');
    // あと2歩で届くなら疾走を切る価値がある
    if (
      dashUid &&
      batPlayError(state, 'dash') === null &&
      path &&
      pathCost(path) > me.movesLeft &&
      pathCost(path) <= me.movesLeft + 2 &&
      (me.carrying > 0 || lastRoundOfNight)
    ) {
      playBat(state, dashUid);
      path = routeTo(state, currentPlayer(state), target);
    }
    if (path) {
      // 夜明け前の最後のラウンドだけは、月潮より先に屋根の下へ入る
      const limit = lastRoundOfNight ? Number.POSITIVE_INFINITY : tideAwareStop(state, path);
      walk(state, path, limit);
    }
  }
  stepOffPatrolPath(state);
  hireIfWorthIt(state);

  // --- 朝が来る前の保険（最終夜は隠れても加点されないので使わない） ---
  if (lastRoundOfNight && !isFinalNight(state)) {
    const now = currentPlayer(state);
    if (!isSafeCell(state, now, now.at)) {
      const flightUid = findBat(now, 'flight');
      if (flightUid && batPlayError(state, 'flight') === null && flightTargets(state).length > 0) {
        playBat(state, flightUid, { cell: flightTargets(state)[0] });
      }
    }
    const after = currentPlayer(state);
    const shroudUid = findBat(after, 'shroud');
    if (!isSafeCell(state, after, after.at) && shroudUid && batPlayError(state, 'shroud') === null) {
      playBat(state, shroudUid);
    }
  }

  endTurn(state);
}

function chooseTarget(state: GameState, lastRoundOfNight: boolean): string | null {
  const me = currentPlayer(state);
  const home = castleOf(state.board, me.index);
  const allowance = moveAllowance(state, me);
  const turnsAfterThis = Math.max(0, roundsUntilDawn(state) - 1);
  const nightBudget = me.movesLeft + turnsAfterThis * allowance;

  // 最終夜の夜明けを越えても得点は増えない。日陰に隠れる意味はもう無い
  const finalDawn = lastRoundOfNight && isFinalNight(state);

  // 最後のラウンド: 今このターンで安全圏に入らないと灰になる
  if (lastRoundOfNight) {
    if (me.at === home) return null;
    const homeCost = pathCost(routeTo(state, me, home));
    if (homeCost <= me.movesLeft) return home;
    if (finalDawn) return home; // 届かなくても構わない。持ったままでは0点なのだから
    const refuge = nearestRefuge(state, me);
    if (refuge && refuge.cost <= me.movesLeft) return refuge.cell;
    // どこにも間に合わない。せめて城に近づいておく
    return home;
  }

  // 村に立っている: もう1つ吸うか、引き上げるか
  if (me.at === VILLAGE) {
    const futureCarry = me.carrying + (state.bloodPool > 0 ? 1 : 0);
    const futureAllowance = allowanceFor(state, me, futureCarry);
    const budgetAfterStaying = turnsAfterThis * futureAllowance;
    const homeCost = pathCost(routeTo(state, me, home));
    const refuge = nearestRefuge(state, me);
    // 最終夜は「生き延びる」では足りない。城まで戻れる見込みが要る
    const canEscapeLater = isFinalNight(state)
      ? homeCost <= budgetAfterStaying
      : homeCost <= budgetAfterStaying ||
        (refuge !== null && refuge.cost <= budgetAfterStaying);
    if (state.bloodPool > 0 && futureCarry <= greedCap(me) && canEscapeLater) return null;
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
  //
  // 月潮の当たりリングに居座って待つ手も試したが、測ってみると常に村への往復に負けた。
  // 村は「立っていれば毎ターン確実に1つ」、血脈は最良でも1ラウンドあたり1つ弱。
  // 月潮は狙って待つものではなく、行き帰りの途中で拾うもの ―― それが tideAwareStop。
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
  // 村へ着いてから朝までに逃げ切れないなら、そもそも行かない。
  // 「欲張るほど帰りが遠い」を、出発の時点で計算しておく。
  const turnsToVillage = turnsToCover(villageCost, me.movesLeft, allowance);
  const turnsAfterVillage = roundsUntilDawn(state) - turnsToVillage;
  const carryAllowance = allowanceFor(state, me, 1);
  const escape = nearestRefuge(state, me, VILLAGE);
  const canEscapeFromVillage =
    turnsAfterVillage >= 0 &&
    escape !== null &&
    escape.cost <= turnsAfterVillage * carryAllowance;
  if (!canEscapeFromVillage) {
    const refuge = nearestRefuge(state, me);
    if (refuge && refuge.cost <= nightBudget) return refuge.cell;
    return home;
  }

  const cave = cheapCaveDetour(state, me, villageCost);
  if (cave && me.bats.length < 3) return cave;
  return VILLAGE;
}
