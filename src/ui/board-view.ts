import {
  currentPlayer,
  dawnAnnounced,
  hunterNextCell,
  isSafeCell,
  legalMoves,
  dawnRisk,
} from '../game/rules';
import type { Cell, GameState, Hunter, TrailStep } from '../game/types';
import {
  CASTLE_RING,
  CENTER,
  VIEW_SIZE,
  cellCenter,
  cellHitRadius,
  hunterFacingAngle,
  ringSectorPath,
  trianglePath,
} from './geometry';
import type { Point } from './geometry';

const SVG_NS = 'http://www.w3.org/2000/svg';

function el<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

export interface BoardViewOptions {
  onCellClick: (cellId: string) => void;
}

/**
 * 盤面は写真ではなく、ルール（同心円4リング＋放射線8本）をそのまま描いた
 * 図形。マスの色分けも役割（村・洞窟・テント・城・通常）に沿って塗る
 * ―― ルールに書かれていない飾りは足さない。
 * その上に、当たり判定と状態表示を兼ねる円を重ねる（`geometry.ts` が座標計算）。
 */
/** 1歩の移動アニメーションにかける時間と、次の一歩までの間 */
const WALK_MS = 380;
const WALK_GAP_MS = 140;
/** 瞬間移動（誘導・影渡り・死亡での帰還）の一時停止。軌跡は引かない */
const TELEPORT_PAUSE_MS = 320;
/** 軌跡が消えるまで */
const TRACE_FADE_MS = 1400;
/** セクター1つぶんの角度（度）。ハンターの向きの積み増しに使う */
const SECTOR_DEG = 45;

interface HunterRefs {
  group: SVGGElement;
  turn: SVGGElement;
  label: SVGTextElement;
  /** 表示に使う「巻き戻らない」角度（度）。セクター0↔7をまたいでも逆回転して見えないよう、
   * mod を取らずに dir 分だけ積み増していく */
  angleDeg: number;
  lastSector: number;
}

/** 血バッジ（携行血液数）の高さと、1桁あたりの目安幅。桁数が増えても数字が
 *  円のフチに迫らないよう、丸から横に伸びるピル型にして幅だけ増やす */
const BADGE_HEIGHT = 24;
const BADGE_PAD_X = 7;
const BADGE_DIGIT_WIDTH = 10;

function badgeWidthFor(digits: number): number {
  return Math.max(BADGE_HEIGHT, digits * BADGE_DIGIT_WIDTH + BADGE_PAD_X * 2);
}

interface PieceRefs {
  group: SVGGElement;
  shadow: SVGCircleElement;
  body: SVGCircleElement;
  label: SVGTextElement;
  badge: SVGGElement;
  badgeShape: SVGRectElement;
  badgeCount: SVGTextElement;
}

export class BoardView {
  readonly svg: SVGSVGElement;
  private readonly boardLayer = el('g', { class: 'layer-board' });
  private readonly glowLayer = el('g', { class: 'layer-glow' });
  private readonly stateLayer = el('g', { class: 'layer-state' });
  private readonly ghostLayer = el('g', { class: 'layer-ghosts' });
  private readonly markerLayer = el('g', { class: 'layer-markers' });
  private readonly hunterLayer = el('g', { class: 'layer-hunters' });
  private readonly traceLayer = el('g', { class: 'layer-trace' });
  private readonly pieceLayer = el('g', { class: 'layer-pieces' });
  private readonly stateNodes = new Map<string, SVGCircleElement>();
  private readonly glowNodes = new Map<string, SVGGraphicsElement>();
  private readonly pieces = new Map<number, PieceRefs>();
  private readonly hunters = new Map<number, HunterRefs>();
  /** 血バッジが今どれだけ表示中か。移動アニメの最中は実値と切り離し、着地までは持ち帰り前の値を見せ続ける */
  private readonly shownCarrying = new Map<number, number>();
  /** まだアニメーションに反映していない trail の先頭。TrailStep.seq と比較する */
  private nextTrailSeq = 0;
  private built = false;

  constructor(private readonly options: BoardViewOptions) {
    this.svg = el('svg', {
      viewBox: `0 0 ${VIEW_SIZE} ${VIEW_SIZE}`,
      class: 'board',
      role: 'img',
      'aria-label': 'ヴァンパイア・ハウスの盤面',
    });
    this.svg.append(
      this.boardLayer,
      this.glowLayer,
      this.stateLayer,
      this.ghostLayer,
      this.markerLayer,
      this.hunterLayer,
      this.traceLayer,
      this.pieceLayer,
    );
  }

  /**
   * マスの実形（扇形・村の円・城の四角）をそのままなぞる、状態表示専用の図形。
   * クリック判定は透明な当たり判定円（stateLayer）が別に持つ ―― この図形は
   * pointer-events: none で見た目だけを担当する。
   */
  private buildCellShape(cell: Cell): SVGGraphicsElement {
    if (cell.ring === 0) {
      return el('circle', { cx: CENTER.x, cy: CENTER.y, r: 58 });
    }
    if (cell.ring === CASTLE_RING) {
      const c = cellCenter(cell);
      return el('rect', {
        x: c.x - 30,
        y: c.y - 30,
        width: 60,
        height: 60,
        rx: 8,
        transform: `rotate(45 ${c.x} ${c.y})`,
      });
    }
    return el('path', { d: ringSectorPath(cell.ring, cell.sector) });
  }

  /**
   * 下敷きになる盤面図形（マス1つにつき扇形1枚 or 村の円 or 城の四角）を描く。
   * 色は役割ごとの塗り分けのみ。座標はすべて geometry.ts の幾何計算から出る。
   */
  private buildBoardShape(state: GameState): void {
    const { board } = state;

    this.boardLayer.append(el('circle', { cx: CENTER.x, cy: CENTER.y, r: 418, class: 'board-rings' }));

    for (const id of board.order) {
      const cell = board.cells[id];
      if (cell.ring === 0) {
        this.boardLayer.append(
          el('circle', { cx: CENTER.x, cy: CENTER.y, r: 58, class: 'cell-shape cell-village' }),
        );
        continue;
      }
      if (cell.ring === CASTLE_RING) {
        const c = cellCenter(cell);
        const owner = cell.castleOf !== undefined ? state.players[cell.castleOf] : undefined;
        const rect = el('rect', {
          x: c.x - 30,
          y: c.y - 30,
          width: 60,
          height: 60,
          rx: 8,
          transform: `rotate(45 ${c.x} ${c.y})`,
          class: 'cell-shape cell-castle',
        });
        if (owner) {
          rect.style.fill = owner.color;
          rect.style.fillOpacity = '0.38';
          rect.style.stroke = owner.color;
        }
        this.boardLayer.append(rect);
        continue;
      }
      this.boardLayer.append(
        el('path', { d: ringSectorPath(cell.ring, cell.sector), class: `cell-shape cell-${cell.kind}` }),
      );
      // 洞窟もテントも「陽を凌げるマス」。同じ縁取りで、避難所であることを示す
      if (cell.kind === 'cave' || cell.kind === 'shade') {
        const c = cellCenter(cell);
        this.boardLayer.append(
          el('path', {
            d: ringSectorPath(cell.ring, cell.sector),
            class: 'cell-refuge-edge',
          }),
        );
        const icon = el('text', {
          x: c.x,
          y: c.y,
          class: `cell-icon cell-icon-${cell.kind}`,
          'text-anchor': 'middle',
          'dominant-baseline': 'central',
        });
        icon.textContent = cell.kind === 'cave' ? '🦇' : '⛺';
        this.boardLayer.append(icon);
      }
    }
  }

  private build(state: GameState): void {
    const { board } = state;

    this.buildBoardShape(state);

    for (const id of board.order) {
      const cell = board.cells[id];
      const c = cellCenter(cell);

      const glow = this.buildCellShape(cell);
      glow.setAttribute('class', 'cell-glow');
      this.glowLayer.append(glow);
      this.glowNodes.set(id, glow);

      const node = el('circle', { cx: c.x, cy: c.y, r: cellHitRadius(cell) });
      node.setAttribute('class', 'state');
      node.dataset.cell = id;
      node.addEventListener('click', () => this.options.onCellClick(id));
      this.stateLayer.append(node);
      this.stateNodes.set(id, node);
    }

    this.built = true;
  }

  /** 戻り値はこのフレームで発生させたアニメーションの総所要時間（ms）。呼び出し側はこの分だけ次の操作を待てる */
  render(state: GameState, highlight: string[], targeting: string[]): number {
    if (!this.built) this.build(state);

    const legal = new Set(highlight);
    const targets = new Set(targeting);
    const me = currentPlayer(state);
    const hunterNow = new Set(state.hunters.map((h) => `r${h.ring}s${h.sector}`));
    const hunterSoon = new Set(state.hunters.map(hunterNextCell));
    // 空が白んだら（＝夜明けが予告されたら）、安全でないマスをはっきり塗る。
    // 賭けの段階（確定の夜が尽きただけ）でも薄く警告は出す
    const dawnNext = (dawnAnnounced(state) || dawnRisk(state) > 0) && state.phase === 'playing';
    const trapped = new Set(state.traps.map((t) => t.cell));

    for (const [id, node] of this.stateNodes) {
      const cell = state.board.cells[id];
      node.classList.toggle('is-danger', hunterSoon.has(id));
      node.classList.toggle('is-hunter', hunterNow.has(id));
      node.classList.toggle('is-trap', trapped.has(id));
      node.classList.toggle('is-doomed', dawnNext && !isSafeCell(state, me, id));
      node.classList.toggle(
        'is-blocked',
        cell.kind === 'castle' && cell.castleOf !== undefined && cell.castleOf !== me.index,
      );
      node.classList.toggle('is-clickable', legal.has(id) || targets.has(id));
    }

    // 移動できるマスは、丸いチェッカーではなくマス目自体を微発光させて示す
    for (const [id, glow] of this.glowNodes) {
      glow.classList.toggle('is-legal', legal.has(id));
      glow.classList.toggle('is-target', targets.has(id));
    }

    this.renderMarkers(state);
    return this.renderPieces(state);
  }

  private renderMarkers(state: GameState): void {
    this.markerLayer.replaceChildren();
    this.ghostLayer.replaceChildren();

    // 次のラウンドに立つ場所を先に見せる。読めるから避けられる
    for (const hunter of state.hunters) {
      const cell = state.board.cells[hunterNextCell(hunter)];
      const p = cellCenter(cell);
      this.ghostLayer.append(
        el('path', {
          d: trianglePath(p, 24, hunterFacingAngle(hunter, cell.sector)),
          class: 'hunter-ghost',
        }),
      );
    }

    // 仕掛けられた罠。伏せずに全員へ見せる ―― 踏むのは読み違えたときだけ、が原則
    for (const trap of state.traps) {
      const cell = state.board.cells[trap.cell];
      if (!cell) continue;
      const p = cellCenter(cell);
      const mark = el('text', {
        x: p.x,
        y: p.y + 7,
        class: 'trap-mark',
        'text-anchor': 'middle',
        fill: state.players[trap.owner]?.color ?? '#fff',
      });
      mark.textContent = '✳';
      this.markerLayer.append(mark);
    }

    this.renderHunters(state);
  }

  /**
   * ハンターの三角は使い回しの駒（`g.hunter`）として持ち、位置と向きを
   * transform で更新する。CSSの transition が滑りを作る ―― 駒（`.piece`）と同じ考え方。
   * 向きの角度は mod せずに積み増す。セクター0↔7の境で 315°→0° のような
   * 大きな戻り角にすると、逆回転しているように見えてしまうため
   */
  private renderHunters(state: GameState): void {
    state.hunters.forEach((hunter, i) => {
      const cell = state.board.cells[`r${hunter.ring}s${hunter.sector}`];
      const p = cellCenter(cell);
      const refs = this.ensureHunter(hunter, i, p);

      if (hunter.sector !== refs.lastSector) {
        refs.angleDeg += hunter.dir * SECTOR_DEG;
        refs.lastSector = hunter.sector;
      }

      refs.group.style.transform = `translate(${p.x}px, ${p.y}px)`;
      refs.turn.style.transform = `rotate(${refs.angleDeg}deg)`;
    });
  }

  private ensureHunter(hunter: Hunter, index: number, at: Point): HunterRefs {
    let refs = this.hunters.get(index);
    if (refs) return refs;

    const group = el('g', { class: 'hunter' });
    const turn = el('g', { class: 'hunter-turn' });
    turn.append(el('path', { d: trianglePath({ x: 0, y: 0 }, 27, 0), class: 'hunter-body' }));
    const label = el('text', { y: 5, class: 'hunter-label', 'text-anchor': 'middle' });
    label.textContent = String(index + 1);
    group.append(turn, label);
    this.hunterLayer.append(group);

    const angleDeg = (hunterFacingAngle(hunter, hunter.sector) * 180) / Math.PI;
    group.style.transform = `translate(${at.x}px, ${at.y}px)`;
    turn.style.transform = `rotate(${angleDeg}deg)`;

    refs = { group, turn, label, angleDeg, lastSector: hunter.sector };
    this.hunters.set(index, refs);
    return refs;
  }

  private ensurePiece(state: GameState, index: number): PieceRefs {
    let refs = this.pieces.get(index);
    if (refs) return refs;

    const player = state.players[index];
    const group = el('g', { class: 'piece' });
    const shadow = el('circle', { cx: 0, cy: 2, class: 'piece-shadow' });
    const body = el('circle', { cx: 0, cy: 0, class: 'piece-body', fill: player.color });
    const label = el('text', { x: 0, y: 6, class: 'piece-label', 'text-anchor': 'middle' });
    label.textContent = String(index + 1);
    const badgeShape = el('rect', { x: 0, y: 0, width: BADGE_HEIGHT, height: BADGE_HEIGHT, rx: BADGE_HEIGHT / 2 });
    const badgeCount = el('text', { x: 0, y: 4, 'text-anchor': 'middle', class: 'piece-blood-count' });
    const badge = el('g', { class: 'piece-blood' });
    badge.append(badgeShape, badgeCount);
    group.append(shadow, body, label, badge);
    this.pieceLayer.append(group);

    // 初回はそのマスへ、いきなり出す（滑らせない）
    const start = cellCenter(state.board.cells[player.at]);
    group.style.transform = `translate(${start.x}px, ${start.y}px)`;

    refs = { group, shadow, body, label, badge, badgeShape, badgeCount };
    this.pieces.set(index, refs);
    return refs;
  }

  /** transform（位置）だけを設定する。animate=false なら遷移させずに一瞬で置く */
  private placePiece(refs: PieceRefs, point: Point, animate: boolean): void {
    if (!animate) {
      refs.group.style.transition = 'none';
      refs.group.style.transform = `translate(${point.x}px, ${point.y}px)`;
      // 次にアニメーションさせたい変更まで transition: none が残らないよう、1フレーム後に戻す
      refs.group.getBoundingClientRect();
      refs.group.style.transition = '';
      return;
    }
    refs.group.style.transform = `translate(${point.x}px, ${point.y}px)`;
  }

  /**
   * ラベル・見た目（現在番・大きさ）は毎フレーム即座に反映する。位置だけは別扱い。
   * 血バッジだけは carrying を引数で受け取る ―― 城へ歩いて着くアニメの最中は
   * 呼び出し側が「まだ持ち帰る前」の値を渡し続け、着地した瞬間に実値へ切り替える。
   */
  private applyPieceLook(refs: PieceRefs, stacked: boolean, isCurrent: boolean, carrying: number): void {
    const pieceRadius = stacked ? 13 : 17;
    refs.group.classList.toggle('is-current', isCurrent);
    refs.shadow.setAttribute('r', String(pieceRadius + 2));
    refs.body.setAttribute('r', String(pieceRadius));
    refs.label.setAttribute('y', String(stacked ? 5 : 6));
    refs.label.classList.toggle('is-small', stacked);
    if (carrying > 0) {
      refs.badge.style.display = '';
      const text = String(carrying);
      const width = badgeWidthFor(text.length);
      const badgeX = pieceRadius + 1 + (width - BADGE_HEIGHT) / 2;
      const badgeY = -pieceRadius + 1;
      refs.badgeShape.setAttribute('x', String(badgeX - width / 2));
      refs.badgeShape.setAttribute('y', String(badgeY - BADGE_HEIGHT / 2));
      refs.badgeShape.setAttribute('width', String(width));
      refs.badgeCount.setAttribute('x', String(badgeX));
      refs.badgeCount.setAttribute('y', String(badgeY + 5));
      refs.badgeCount.textContent = text;
    } else {
      refs.badge.style.display = 'none';
    }
  }

  /** 駒が最終的に落ち着く場所（同じマスに複数いれば散らす） */
  private finalPositions(state: GameState): Map<number, Point> {
    const byCell = new Map<string, number[]>();
    for (const p of state.players) {
      const list = byCell.get(p.at) ?? [];
      list.push(p.index);
      byCell.set(p.at, list);
    }
    const positions = new Map<number, Point>();
    for (const [cellId, indices] of byCell) {
      const base = cellCenter(state.board.cells[cellId]);
      const spreadRadius = indices.length > 1 ? 19 : 0;
      indices.forEach((index, slot) => {
        const angle = (slot / indices.length) * Math.PI * 2 - Math.PI / 2;
        positions.set(index, {
          x: base.x + spreadRadius * Math.cos(angle),
          y: base.y + spreadRadius * Math.sin(angle),
        });
      });
    }
    return positions;
  }

  /** 通った道に、色つきの線を一瞬引いて消す ―― 何が起きたかを後からでも読めるように */
  private drawTraceSegment(state: GameState, from: string, to: string, player: number): void {
    const a = cellCenter(state.board.cells[from]);
    const b = cellCenter(state.board.cells[to]);
    const line = el('line', {
      x1: a.x,
      y1: a.y,
      x2: b.x,
      y2: b.y,
      class: 'trace-segment',
    });
    line.style.stroke = state.players[player].color;
    this.traceLayer.append(line);
    window.setTimeout(() => line.remove(), TRACE_FADE_MS);
  }

  /**
   * 1人ぶんの手番で起きた移動を、順番どおりに再生する。
   * CPUが何手も一気に済ませても、ここで1歩ずつ見せ直す。
   */
  private animateChain(state: GameState, index: number, steps: TrailStep[], finalPos: Point): number {
    const refs = this.ensurePiece(state, index);
    let elapsed = 0;

    const runStep = (i: number): void => {
      if (i >= steps.length) {
        this.placePiece(refs, finalPos, true);
        // 着地した瞬間に、見せていた血の量を実際の値（城なら持ち帰り済みで0）へ切り替える
        const player = state.players[index];
        const stackedNow = state.players.filter((p) => p.at === player.at).length > 1;
        this.shownCarrying.set(index, player.carrying);
        this.applyPieceLook(refs, stackedNow, index === state.current, player.carrying);
        return;
      }
      const step = steps[i];
      if (step.kind === 'walk') {
        this.drawTraceSegment(state, step.from, step.to, index);
        this.placePiece(refs, cellCenter(state.board.cells[step.to]), true);
      } else {
        this.placePiece(refs, cellCenter(state.board.cells[step.to]), false);
      }
      const gap = step.kind === 'walk' ? WALK_MS + WALK_GAP_MS : TELEPORT_PAUSE_MS;
      window.setTimeout(() => runStep(i + 1), gap);
    };

    for (const step of steps) {
      elapsed += step.kind === 'walk' ? WALK_MS + WALK_GAP_MS : TELEPORT_PAUSE_MS;
    }
    runStep(0);
    return elapsed;
  }

  private renderPieces(state: GameState): number {
    const finalPos = this.finalPositions(state);
    const byCell = new Map<string, number[]>();
    for (const p of state.players) {
      const list = byCell.get(p.at) ?? [];
      list.push(p.index);
      byCell.set(p.at, list);
    }

    const newSteps = state.trail.filter((t) => t.seq >= this.nextTrailSeq);
    this.nextTrailSeq = state.trailSeq;

    const chains = new Map<number, TrailStep[]>();
    for (const step of newSteps) {
      const list = chains.get(step.player) ?? [];
      list.push(step);
      chains.set(step.player, list);
    }

    for (const indices of byCell.values()) {
      for (const index of indices) {
        const refs = this.ensurePiece(state, index);
        const player = state.players[index];
        const stacked = indices.length > 1;
        const isCurrent = index === state.current;
        if (chains.has(index)) {
          // 歩いて城に着くまでは、持ち帰り前の血の量を見せ続ける
          this.applyPieceLook(refs, stacked, isCurrent, this.shownCarrying.get(index) ?? player.carrying);
        } else {
          this.shownCarrying.set(index, player.carrying);
          this.applyPieceLook(refs, stacked, isCurrent, player.carrying);
        }
      }
    }

    let totalMs = 0;
    for (const [index, steps] of chains) {
      const target = finalPos.get(index);
      if (!target) continue;
      totalMs = Math.max(totalMs, this.animateChain(state, index, steps, target));
    }

    // 動きが無かった駒も、詰め直された分（同じマスに集まった等）は滑らせて追従させる
    for (const [index, point] of finalPos) {
      if (chains.has(index)) continue;
      this.placePiece(this.ensurePiece(state, index), point, true);
    }

    return totalMs;
  }

  /** 夜明けの閃光 */
  flashDawn(): void {
    const flash = el('circle', {
      cx: CENTER.x,
      cy: CENTER.y,
      r: VIEW_SIZE,
      class: 'dawn-flash',
    });
    this.svg.append(flash);
    window.setTimeout(() => flash.remove(), 1200);
  }
}

export function highlightFor(state: GameState): string[] {
  return legalMoves(state);
}
