import { CASTLE_RING, RING_COUNT, SECTORS } from '../game/board';
import {
  currentPlayer,
  hunterNextCell,
  isSafeCell,
  legalMoves,
  roundsUntilDawn,
} from '../game/rules';
import type { GameState } from '../game/types';
import {
  CASTLE_RADIUS,
  CASTLE_SIZE,
  CENTER,
  RING_RADII,
  SECTOR_ANGLE,
  VIEW,
  VILLAGE_RADIUS,
  castleBridge,
  castlePath,
  cellCenter,
  polar,
  sectorAngle,
  sectorPath,
  trianglePath,
} from './geometry';

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

/** 盤面の静的な部分は一度だけ組み立て、以降は状態依存の層だけ描き直す */
export class BoardView {
  readonly svg: SVGSVGElement;
  private readonly cellLayer = el('g', { class: 'layer-cells' });
  private readonly ghostLayer = el('g', { class: 'layer-ghosts' });
  private readonly inkLayer = el('g', { class: 'layer-ink' });
  private readonly markerLayer = el('g', { class: 'layer-markers' });
  private readonly pieceLayer = el('g', { class: 'layer-pieces' });
  private readonly cellNodes = new Map<string, SVGPathElement | SVGCircleElement>();
  private built = false;

  constructor(private readonly options: BoardViewOptions) {
    this.svg = el('svg', {
      viewBox: `0 0 ${VIEW} ${VIEW}`,
      class: 'board',
      role: 'img',
      'aria-label': 'ヴァンパイア・ハウスの盤面',
    });
    this.svg.append(
      this.defs(),
      this.cellLayer,
      this.ghostLayer,
      this.inkLayer,
      this.markerLayer,
      this.pieceLayer,
    );
  }

  private defs(): SVGDefsElement {
    const defs = el('defs');
    // 手描きの線に見せるための、ごく弱い歪み
    const filter = el('filter', { id: 'ink', x: '-5%', y: '-5%', width: '110%', height: '110%' });
    filter.append(
      el('feTurbulence', {
        type: 'fractalNoise',
        baseFrequency: '0.022',
        numOctaves: '3',
        seed: '7',
        result: 'noise',
      }),
      el('feDisplacementMap', {
        in: 'SourceGraphic',
        in2: 'noise',
        scale: '2.4',
        xChannelSelector: 'R',
        yChannelSelector: 'G',
      }),
    );
    const glow = el('filter', { id: 'sunglow', x: '-50%', y: '-50%', width: '200%', height: '200%' });
    glow.append(el('feGaussianBlur', { stdDeviation: '14', result: 'b' }));
    const merge = el('feMerge');
    merge.append(el('feMergeNode', { in: 'b' }), el('feMergeNode', { in: 'SourceGraphic' }));
    glow.append(merge);
    defs.append(filter, glow);
    return defs;
  }

  private build(state: GameState): void {
    const { board } = state;

    // --- クリック可能なマス ---
    for (const id of board.order) {
      const cell = board.cells[id];
      let node: SVGPathElement | SVGCircleElement;
      if (cell.ring === 0) {
        node = el('circle', { cx: CENTER, cy: CENTER, r: VILLAGE_RADIUS });
      } else if (cell.ring === CASTLE_RING) {
        node = el('path', { d: castlePath(cell.sector) });
      } else {
        node = el('path', { d: sectorPath(cell.ring, cell.sector) });
      }
      node.setAttribute('class', `cell cell-${cell.kind}`);
      node.dataset.cell = id;
      node.addEventListener('click', () => this.options.onCellClick(id));
      this.cellLayer.append(node);
      this.cellNodes.set(id, node);
    }

    // --- 同心円と放射線（インクの線） ---
    const ink = el('g', { filter: 'url(#ink)' });
    for (const radius of RING_RADII) {
      ink.append(
        el('circle', { cx: CENTER, cy: CENTER, r: radius, class: 'ink-ring' }),
      );
    }
    for (let sector = 0; sector < SECTORS; sector++) {
      const angle = sectorAngle(sector) - SECTOR_ANGLE / 2;
      const a = polar(VILLAGE_RADIUS, angle);
      const b = polar(RING_RADII[RING_COUNT], angle);
      ink.append(el('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'ink-spoke' }));
    }
    for (const castleId of board.castleCells) {
      const { from, to } = castleBridge(board.cells[castleId].sector);
      ink.append(el('line', { x1: from.x, y1: from.y, x2: to.x, y2: to.y, class: 'ink-bridge' }));
      ink.append(el('path', { d: castlePath(board.cells[castleId].sector), class: 'ink-castle' }));
    }
    this.inkLayer.append(ink);

    // --- マスのラベル ---
    for (const id of board.caveCells) {
      const p = cellCenter(board.cells[id]);
      this.inkLayer.append(this.glyph(p.x, p.y, '洞', 'glyph-cave'));
    }
    for (const id of board.shadeCells) {
      const p = cellCenter(board.cells[id]);
      this.inkLayer.append(this.glyph(p.x, p.y, '陰', 'glyph-shade'));
    }
    this.inkLayer.append(this.glyph(CENTER, CENTER + 6, '村', 'glyph-village'));
    for (const id of board.castleCells) {
      const cell = board.cells[id];
      const p = cellCenter(cell);
      this.inkLayer.append(this.glyph(p.x, p.y - CASTLE_SIZE + 22, '城', 'glyph-castle'));
    }

    this.built = true;
  }

  private glyph(x: number, y: number, text: string, cls: string): SVGTextElement {
    const node = el('text', { x, y, class: `glyph ${cls}`, 'text-anchor': 'middle' });
    node.textContent = text;
    return node;
  }

  render(state: GameState, highlight: string[], targeting: string[]): void {
    if (!this.built) this.build(state);

    const legal = new Set(highlight);
    const targets = new Set(targeting);
    const me = currentPlayer(state);
    const hunterNow = new Set(state.hunters.map((h) => `${h.ring}:${h.sector}`));
    const hunterSoon = new Set(state.hunters.map(hunterNextCell));
    const dawnNext = roundsUntilDawn(state) === 1;

    for (const [id, node] of this.cellNodes) {
      const cell = state.board.cells[id];
      node.classList.toggle('is-legal', legal.has(id));
      node.classList.toggle('is-target', targets.has(id));
      node.classList.toggle('is-danger', hunterSoon.has(id));
      node.classList.toggle('is-hunter', hunterNow.has(`${cell.ring}:${cell.sector}`));
      node.classList.toggle('is-shroud', me.shroudedCell === id);
      node.classList.toggle(
        'is-doomed',
        dawnNext && state.phase === 'playing' && !isSafeCell(state, me, id),
      );
      node.classList.toggle(
        'is-blocked',
        cell.kind === 'castle' && cell.castleOf !== undefined && cell.castleOf !== me.index,
      );
    }

    this.renderMarkers(state);
    this.renderPieces(state);
  }

  private renderMarkers(state: GameState): void {
    this.markerLayer.replaceChildren();
    this.ghostLayer.replaceChildren();
    // 次のラウンドにハンターが立つ場所。読めるから避けられる
    for (const hunter of state.hunters) {
      const cell = state.board.cells[hunterNextCell(hunter)];
      const ghost = cellCenter(cell);
      this.ghostLayer.append(
        el('path', {
          d: trianglePath(ghost, 24, sectorAngle(cell.sector)),
          class: 'hunter-ghost',
        }),
      );
    }
    for (const hunter of state.hunters) {
      const cell = state.board.cells[`r${hunter.ring}s${hunter.sector}`];
      const p = cellCenter(cell);
      const group = el('g', { class: 'hunter' });
      group.append(
        el('path', { d: trianglePath(p, 26, sectorAngle(cell.sector)), class: 'hunter-body' }),
        el('circle', { cx: p.x, cy: p.y + 4, r: 6, class: 'hunter-eye' }),
      );
      this.markerLayer.append(group);
    }
  }

  private renderPieces(state: GameState): void {
    this.pieceLayer.replaceChildren();
    // 同じマスに複数人いる場合はずらして描く
    const byCell = new Map<string, number[]>();
    for (const p of state.players) {
      const list = byCell.get(p.at) ?? [];
      list.push(p.index);
      byCell.set(p.at, list);
    }

    for (const [cellId, indices] of byCell) {
      const cell = state.board.cells[cellId];
      const base = cellCenter(cell);
      // 重なったときは小さな円周上に散らす。村には全員が同時に立ちうる
      const stacked = indices.length > 1;
      const spreadRadius = stacked ? 19 : 0;
      const pieceRadius = stacked ? 13 : 16;
      indices.forEach((index, slot) => {
        const player = state.players[index];
        const angle = (slot / indices.length) * Math.PI * 2 - Math.PI / 2;
        const x = base.x + spreadRadius * Math.cos(angle);
        const y = base.y + spreadRadius * Math.sin(angle);
        const group = el('g', {
          class: `piece ${index === state.current ? 'is-current' : ''}`,
        });
        group.append(
          el('circle', { cx: x, cy: y + 2, r: pieceRadius + 2, class: 'piece-shadow' }),
          el('circle', { cx: x, cy: y, r: pieceRadius, class: 'piece-body', fill: player.color }),
        );
        const label = el('text', {
          x,
          y: y + (stacked ? 5 : 6),
          class: `piece-label${stacked ? ' is-small' : ''}`,
          'text-anchor': 'middle',
        });
        label.textContent = String(index + 1);
        group.append(label);
        if (player.carrying > 0) {
          const badgeX = x + pieceRadius + 1;
          const badgeY = y - pieceRadius + 1;
          const badge = el('g', { class: 'piece-blood' });
          badge.append(el('circle', { cx: badgeX, cy: badgeY, r: 9 }));
          const count = el('text', {
            x: badgeX,
            y: badgeY + 4,
            'text-anchor': 'middle',
            class: 'piece-blood-count',
          });
          count.textContent = String(player.carrying);
          badge.append(count);
          group.append(badge);
        }
        this.pieceLayer.append(group);
      });
    }
  }

  /** 夜明けの閃光 */
  flashDawn(): void {
    const flash = el('circle', {
      cx: CENTER,
      cy: CENTER,
      r: CASTLE_RADIUS + CASTLE_SIZE,
      class: 'dawn-flash',
      filter: 'url(#sunglow)',
    });
    this.svg.append(flash);
    window.setTimeout(() => flash.remove(), 1200);
  }
}

export function highlightFor(state: GameState): string[] {
  return legalMoves(state);
}
