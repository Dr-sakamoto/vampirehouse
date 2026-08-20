import { VILLAGE, cellId, isRefugeKind, wrapSector } from './board';
import {
  batPlayError,
  currentPlayer,
  dawnRisk,
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
  safeRoundsLeft,
  suckRange,
  stealTargets,
  swapTargets,
  flightTargets,
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

/** 侵入できないマス（他人の城・埋まった避難所） */
function blockedCells(state: GameState, me: Player): Set<string> {
  const set = foreignCastles(state, me);
  for (const p of state.players) {
    if (p.index !== me.index && isRefugeKind(state.board.cells[p.at].kind)) set.add(p.at);
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

/**
 * 血を抱えた相手のマスを通ってから目的地へ向かう経路。
 * 通りすがりに1本奪えるなら、寄り道2歩ぶんまでは払う価値がある。
 */
function biteDetour(
  state: GameState,
  me: Player,
  target: string | null,
  mustArriveThisTurn: boolean,
): string[] | null {
  if (me.bitThisTurn || me.movesLeft <= 0) return null;
  const danger = dangerCells(state);
  const direct = target === null ? 0 : pathCost(routeTo(state, me, target));
  let best: { path: string[]; extra: number } | null = null;

  for (const prey of state.players) {
    if (prey.index === me.index || prey.carrying <= 0) continue;
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

/** 誘導カードで血を持った相手を仕留められるなら、その手を返す。狙えるなら最も血を積んだ相手を選ぶ */
function findLureKill(state: GameState): { hunter: string; dir: 1 | -1 } | null {
  const me = currentPlayer(state);
  let best: { hunter: string; dir: 1 | -1; carrying: number } | null = null;
  for (const hunter of state.hunters) {
    for (const dir of [1, -1] as const) {
      const cell = cellId(hunter.ring, wrapSector(hunter.sector + dir));
      const victim = state.players.find((p) => p.index !== me.index && p.at === cell);
      if (victim && victim.carrying > 0 && (!best || victim.carrying > best.carrying)) {
        best = { hunter: hunter.id, dir, carrying: victim.carrying };
      }
    }
  }
  return best ? { hunter: best.hunter, dir: best.dir } : null;
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

/** ボット1人ぶんの手番をすべて処理し、ターンを終える */
export function botTakeTurn(state: GameState): void {
  if (state.phase !== 'playing') return;
  const me = currentPlayer(state);
  // 確定の夜が尽きた ＝ このラウンドの終わりに朝が来るかもしれない。
  // 固定4ラウンドだった頃の「最後のラウンド」に相当する
  const lastRoundOfNight = safeRoundsLeft(state) <= 0;

  // --- 手番開始時のカード ---
  const lure = findLureKill(state);
  if (lure && findBat(me, 'lure') && batPlayError(state, 'lure') === null) {
    playBat(state, findBat(me, 'lure')!, lure);
  }

  const homeCost = pathCost(routeTo(state, me, castleOf(state.board, me.index)));
  const stealUid = findBat(me, 'steal');
  if (stealUid && batPlayError(state, 'steal') === null && homeCost <= me.movesLeft) {
    // このターンで持ち帰れるなら、奪った血はそのまま得点になる。狙うのは最も血を積んだ相手
    const targets = stealTargets(state);
    const best = targets.reduce<number | null>((acc, i) => {
      const p = state.players[i];
      return acc === null || p.carrying > state.players[acc].carrying ? i : acc;
    }, null);
    if (best !== null) playBat(state, stealUid, { player: best });
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
    const detour = biteDetour(state, currentPlayer(state), target, lastRoundOfNight);
    if (detour) path = detour;
    if (path) walk(state, path);
  } else {
    const detour = biteDetour(state, me, null, lastRoundOfNight);
    if (detour) walk(state, detour);
  }
  stepOffPatrolPath(state);

  // --- 朝が来る前の保険（最終夜は隠れても加点されないので使わない） ---
  if (lastRoundOfNight && !isFinalNight(state)) {
    const now = currentPlayer(state);
    if (!isSafeCell(state, now, now.at)) {
      const flightUid = findBat(now, 'flight');
      // 巡回路の上のテントへ降りては元も子もない。空いていて踏まれない避難所だけを選ぶ
      const danger = dangerCells(state);
      const perch = flightTargets(state).find((id) => !danger.has(id));
      if (flightUid && perch && batPlayError(state, 'flight') === null) {
        playBat(state, flightUid, { cell: perch });
      }
    }
    // 逃げ場が残っていないなら、避難所に座っている相手と入れ替わって朝を押しつける
    const swapper = currentPlayer(state);
    const swapUid = findBat(swapper, 'swap');
    if (!isSafeCell(state, swapper, swapper.at) && swapUid && batPlayError(state, 'swap') === null) {
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
  const turnsAfterThis = Math.max(0, plannedRoundsLeft(state) - 1);
  const nightBudget = me.movesLeft + turnsAfterThis * allowance;

  // 最終夜の夜明けを越えても得点は増えない。日陰に隠れる意味はもう無い
  const finalDawn = lastRoundOfNight && isFinalNight(state);

  // 最後のラウンド: 今このターンで安全圏に入らないと灰になる
  if (lastRoundOfNight) {
    if (me.at === home) return null;
    const homeCost = pathCost(routeTo(state, me, home));

    // 村にいて、今すぐ帰ろうと思えば帰れるなら「粘るか引くか」は賭けの計算次第。
    // 朝が来る確率 p に対して、今持っている分を失うリスクより
    // もう一口の期待値のほうが大きいうちは粘る（持っているほど、pが高いほど慎重になる）
    if (me.at === VILLAGE && !finalDawn && state.bloodPool > 0 && homeCost <= me.movesLeft) {
      const p = dawnRisk(state);
      const meanSuck = suckRange(state).mean;
      if (p > 0 && p < 1 && me.carrying < (meanSuck * (1 - p)) / p) return null;
    }

    if (homeCost <= me.movesLeft) return home;
    if (finalDawn) return home; // 届かなくても構わない。持ったままでは0点なのだから
    const refuge = nearestRefuge(state, me);
    if (refuge && refuge.cost <= me.movesLeft) return refuge.cell;
    // どこにも間に合わない。せめて城に近づいておく
    return home;
  }

  // 村に立っている: もう1つ吸うか、引き上げるか
  if (me.at === VILLAGE) {
    // 重さが無くなったので、何本抱えても足の速さは変わらない
    const futureCarry = me.carrying + suckRange(state).mean;
    const budgetAfterStaying = turnsAfterThis * allowance;
    const homeCost = pathCost(routeTo(state, me, home));
    const refuge = nearestRefuge(state, me);
    // 最終夜は「生き延びる」では足りない。城まで戻れる見込みが要る
    const canEscapeLater = isFinalNight(state)
      ? homeCost <= budgetAfterStaying
      : homeCost <= budgetAfterStaying ||
        (refuge !== null && refuge.cost <= budgetAfterStaying);
    if (state.bloodPool > 0 && futureCarry <= GREED_CAP && canEscapeLater) return null;
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
  // 村へ着いてから朝までに逃げ切れないなら、そもそも行かない。
  // 引き際のコストは足の重さではなく、夜が残っているかどうかで決まる
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
  if (cave && me.bats.length < 3) return cave;
  return VILLAGE;
}
