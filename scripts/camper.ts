/**
 * 「洞窟主」 ―― 篭り戦術だけを打つボット。バランスの物差しとして置いてある。
 *
 * 村へは一度も行かない。自分の城の門の隣にある洞窟を根城にして、
 *
 * - 洞窟を出入りしてコウモリを引く（通過するたび1枚）
 * - 隣り合う城の門に罠を張る
 * - 血を抱えて帰ってきた相手に噛みつく／強襲を当てる
 * - 夜明けは穴の中でやり過ごす（ハンターはリング2までしか来ない）
 *
 * 最外リングから一歩も出ないので、ハンターにも陽光にも当たらない。
 * つまり **一切のリスクを負わずに、他人の稼ぎだけで点を取る**。
 * この戦術が普通のボットに勝てるかどうかが、篭りが強すぎるかどうかの尺度になる。
 */
import { castleGate, castleOf, isRefugeKind } from '../src/game/board';
import { HAND_LIMIT } from '../src/game/bats';
import {
  batPlayError,
  currentPlayer,
  dawnAnnounced,
  endTurn,
  endTurnError,
  hunterCells,
  hunterNextCell,
  legalMoves,
  moveTo,
  playBat,
  swapTargets,
  trapAt,
} from '../src/game/rules';
import type { BatKind, GameState, Player } from '../src/game/types';

/** 罠を張りに行く価値があると見なす、相手の運搬量 */
const SNARE_WORTH = 60;

function findBat(player: Player, kind: BatKind): string | null {
  return player.bats.find((b) => b.kind === kind)?.uid ?? null;
}

/** 自分の城の門の隣にある洞窟。四隅どの城からも門の隣が洞窟になっている */
function homeCave(state: GameState, me: Player): string {
  const gate = castleGate(state.board, me.index);
  const next = state.board.cells[gate].neighbors.find(
    (id) => state.board.cells[id].kind === 'cave',
  );
  return next ?? state.board.caveCells[0];
}

/** 踏めないマス（他人の城・埋まった避難所・ハンターの現在地と次の一歩） */
function avoidCells(state: GameState, me: Player): Set<string> {
  const set = new Set<string>();
  for (const id of state.board.castleCells) {
    if (state.board.cells[id].castleOf !== me.index) set.add(id);
  }
  for (const p of state.players) {
    if (p.index !== me.index && isRefugeKind(state.board.cells[p.at].kind)) set.add(p.at);
  }
  for (const h of state.hunters) {
    set.add(hunterNextCell(h));
  }
  for (const id of hunterCells(state)) set.add(id);
  for (const t of state.traps) {
    if (t.owner !== me.index) set.add(t.cell);
  }
  return set;
}

function path(state: GameState, from: string, to: string, avoid: Set<string>): string[] | null {
  if (from === to) return [from];
  const prev: Record<string, string> = {};
  const seen = new Set([from]);
  const queue = [from];
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head];
    for (const n of state.board.cells[id].neighbors) {
      if (seen.has(n) || (avoid.has(n) && n !== to)) continue;
      seen.add(n);
      prev[n] = id;
      if (n === to) {
        const out = [to];
        let cur = to;
        while (cur !== from) {
          cur = prev[cur];
          out.unshift(cur);
        }
        return out;
      }
      queue.push(n);
    }
  }
  return null;
}

function cost(p: string[] | null): number {
  return p === null ? Number.POSITIVE_INFINITY : p.length - 1;
}

/**
 * 腰を据えられるのは村と自分の城だけ ―― 動かずに終えられないなら、
 * ハンターを避けていちばん近い1歩を踏む（洞窟主にとってはこれが「穴を出る」動き）
 */
function stepAsideIfSquatting(state: GameState): void {
  if (endTurnError(state) === null) return;
  const me = currentPlayer(state);
  const danger = avoidCells(state, me);
  const all = legalMoves(state);
  const options = all.filter((id) => !danger.has(id));
  const pick = (options.length > 0 ? options : all)[0];
  if (pick) moveTo(state, pick);
}

/** 経路に沿って進めるところまで進む。塞がれたらそこで止まる */
function walk(state: GameState, route: string[] | null): void {
  if (!route) return;
  for (const step of route.slice(1)) {
    const me = currentPlayer(state);
    if (me.movesLeft <= 0) break;
    if (!legalMoves(state).includes(step)) break;
    const before = me.at;
    moveTo(state, step);
    if (currentPlayer(state).at !== step && currentPlayer(state).at !== before) break;
  }
}

/** 血を抱えて外を歩いている相手のうち、この手番で踏めるいちばん太い獲物 */
function prey(state: GameState, me: Player): Player | null {
  const avoid = avoidCells(state, me);
  return state.players
    .filter((p) => p.index !== me.index && p.carrying > 0)
    .filter((p) => {
      const kind = state.board.cells[p.at].kind;
      return kind !== 'castle' && kind !== 'village';
    })
    .filter((p) => cost(path(state, me.at, p.at, avoid)) <= me.movesLeft)
    .sort((a, b) => b.carrying - a.carrying)[0] ?? null;
}

/** 罠を張る値打ちのある門 ―― 血を抱えた相手の帰り道 */
function snareGate(state: GameState, me: Player): string | null {
  const marks = state.players
    .filter((p) => p.index !== me.index && p.carrying >= SNARE_WORTH)
    .sort((a, b) => b.carrying - a.carrying);
  for (const mark of marks) {
    const gate = castleGate(state.board, mark.index);
    if (!trapAt(state, gate) && mark.at !== gate) return gate;
  }
  return null;
}

/** いま立っているマスで朝を越せるか */
function safeHere(state: GameState, p: Player): boolean {
  const kind = state.board.cells[p.at].kind;
  return kind === 'castle' || isRefugeKind(kind);
}

/** 予告ラウンド ―― 穴（か城）へ戻ることだけを考える */
function runHome(state: GameState, home: string, base: string): void {
  const me = currentPlayer(state);
  const avoid = avoidCells(state, me);
  // 血を抱えているなら城が最優先（座るだけでは1点にもならない）
  const goals = me.carrying > 0 ? [home, base] : [base, home];
  const reachable = goals
    .map((goal) => path(state, me.at, goal, avoid))
    .filter((route): route is string[] => route !== null && cost(route) <= me.movesLeft);
  walk(state, reachable[0] ?? path(state, me.at, goals[0], avoid));

  // 間に合わなかったときの保険 ―― 傘、それも無ければ椅子ごと横取りする
  const now = currentPlayer(state);
  if (safeHere(state, now)) return;
  const parasolUid = findBat(now, 'parasol');
  if (parasolUid && batPlayError(state, 'parasol') === null) {
    playBat(state, parasolUid);
    return;
  }
  const swapUid = findBat(now, 'swap');
  if (swapUid && batPlayError(state, 'swap') === null) {
    const hunters = new Set(hunterCells(state));
    const victim = swapTargets(state)
      .filter((i) => isRefugeKind(state.board.cells[state.players[i].at].kind))
      .filter((i) => !hunters.has(state.players[i].at))[0];
    if (victim !== undefined) playBat(state, swapUid, { player: victim });
  }
}

export function camperTakeTurn(state: GameState): void {
  if (state.phase !== 'playing') return;
  const me = currentPlayer(state);
  const home = castleOf(state.board, me.index);
  const base = homeCave(state, me);
  const avoid = avoidCells(state, me);

  // 門の上に立っているなら、動く前に張っておく
  const snareUid = findBat(me, 'snare');
  if (snareUid && snareGate(state, me) === me.at && batPlayError(state, 'snare') === null) {
    playBat(state, snareUid);
  }

  // 空が白んだラウンドは狩りをやめて穴へ帰る ―― 篭りの強みは「絶対に焼けない」こと
  if (dawnAnnounced(state)) {
    runHome(state, home, base);
    stepAsideIfSquatting(state);
    endTurn(state);
    return;
  }

  const mark = prey(state, me);
  if (mark) {
    // 太い相手なら強襲で丸ごと奪う。そうでなくても噛みつきで半分は取れる
    const rushUid = findBat(me, 'rush');
    if (rushUid && mark.carrying >= SNARE_WORTH && batPlayError(state, 'rush') === null) {
      playBat(state, rushUid);
    }
    walk(state, path(state, me.at, mark.at, avoid));
  } else if (me.carrying > 0) {
    walk(state, path(state, me.at, home, avoid));
  } else {
    const gate = findBat(me, 'snare') ? snareGate(state, me) : null;
    if (gate && cost(path(state, me.at, gate, avoid)) <= me.movesLeft) {
      walk(state, path(state, me.at, gate, avoid));
      const uid = findBat(currentPlayer(state), 'snare');
      if (uid && currentPlayer(state).at === gate && batPlayError(state, 'snare') === null) {
        playBat(state, uid);
      }
    } else if (me.bats.length < HAND_LIMIT && me.at === base) {
      // 穴の出入り ―― 通過するたびコウモリを1枚引ける
      const out = legalMoves(state).find((id) => state.board.cells[id].kind !== 'castle');
      if (out) moveTo(state, out);
    }
  }

  // 残った歩数はすべて根城へ戻すのに使う。血を抱えていれば城が優先
  const now = currentPlayer(state);
  if (now.movesLeft > 0) {
    const goal = now.carrying > 0 ? home : base;
    walk(state, path(state, now.at, goal, avoidCells(state, now)));
  }

  stepAsideIfSquatting(state);
  endTurn(state);
}
