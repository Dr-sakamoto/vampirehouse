import { CASTLE_RING } from '../game/board';
import {
  currentPlayer,
  hunterNextCell,
  isSafeCell,
  legalMoves,
  roundsUntilDawn,
} from '../game/rules';
import type { GameState } from '../game/types';
import boardUrl from '../assets/board.png';
import {
  CASTLE_HIT_RADIUS,
  CENTER,
  IMAGE_HEIGHT,
  IMAGE_WIDTH,
  RING_RADII,
  VILLAGE_RADIUS,
  cellCenter,
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

/**
 * 盤面はユーザーが渡した写真そのものを背景として敷き、
 * その上に透明な当たり判定と、状態を示す半透明のハイライトだけを重ねる。
 * 石畳やお城の絵を描き起こすようなことはしない ―― 絵は写真に任せる。
 */
export class BoardView {
  readonly svg: SVGSVGElement;
  private readonly stateLayer = el('g', { class: 'layer-state' });
  private readonly ghostLayer = el('g', { class: 'layer-ghosts' });
  private readonly markerLayer = el('g', { class: 'layer-markers' });
  private readonly pieceLayer = el('g', { class: 'layer-pieces' });
  private readonly stateNodes = new Map<string, SVGPathElement | SVGCircleElement>();
  private built = false;

  constructor(private readonly options: BoardViewOptions) {
    this.svg = el('svg', {
      viewBox: `0 0 ${IMAGE_WIDTH} ${IMAGE_HEIGHT}`,
      class: 'board',
      role: 'img',
      'aria-label': 'ヴァンパイア・ハウスの盤面',
    });
    const image = el('image', {
      href: boardUrl,
      x: 0,
      y: 0,
      width: IMAGE_WIDTH,
      height: IMAGE_HEIGHT,
      class: 'board-photo',
    });
    this.svg.append(image, this.stateLayer, this.ghostLayer, this.markerLayer, this.pieceLayer);
  }

  /**
   * 各マスにつき1つの要素だけを置く。クリック判定と、合法手/危険などの
   * 半透明ハイライトを同じ要素が兼ねる ―― 見えるものと押せるものを分けない。
   */
  private build(state: GameState): void {
    const { board } = state;

    for (const id of board.order) {
      const cell = board.cells[id];
      let node: SVGPathElement | SVGCircleElement;
      if (cell.ring === 0) {
        const c = cellCenter(cell);
        node = el('circle', { cx: c.x, cy: c.y, r: VILLAGE_RADIUS + 4 });
      } else if (cell.ring === CASTLE_RING) {
        const c = cellCenter(cell);
        node = el('circle', { cx: c.x, cy: c.y, r: CASTLE_HIT_RADIUS });
      } else {
        node = el('path', { d: sectorPath(cell.ring, cell.sector) });
      }
      node.setAttribute('class', 'state');
      node.dataset.cell = id;
      node.addEventListener('click', () => this.options.onCellClick(id));
      this.stateLayer.append(node);
      this.stateNodes.set(id, node);
    }

    this.built = true;
  }

  render(state: GameState, highlight: string[], targeting: string[]): void {
    if (!this.built) this.build(state);

    const legal = new Set(highlight);
    const targets = new Set(targeting);
    const me = currentPlayer(state);
    const hunterNow = new Set(state.hunters.map((h) => `r${h.ring}s${h.sector}`));
    const hunterSoon = new Set(state.hunters.map(hunterNextCell));
    const dawnNext = roundsUntilDawn(state) === 1 && state.phase === 'playing';

    for (const [id, node] of this.stateNodes) {
      const cell = state.board.cells[id];
      node.classList.toggle('is-legal', legal.has(id));
      node.classList.toggle('is-target', targets.has(id));
      node.classList.toggle('is-danger', hunterSoon.has(id));
      node.classList.toggle('is-hunter', hunterNow.has(id));
      node.classList.toggle('is-shroud', me.shroudedCell === id);
      node.classList.toggle('is-doomed', dawnNext && !isSafeCell(state, me, id));
      node.classList.toggle(
        'is-blocked',
        cell.kind === 'castle' && cell.castleOf !== undefined && cell.castleOf !== me.index,
      );
      node.classList.toggle('is-clickable', legal.has(id) || targets.has(id));
    }

    this.renderMarkers(state);
    this.renderPieces(state);
  }

  private renderMarkers(state: GameState): void {
    this.markerLayer.replaceChildren();
    this.ghostLayer.replaceChildren();

    // 次のラウンドに立つ場所を先に見せる。読めるから避けられる
    for (const hunter of state.hunters) {
      const cell = state.board.cells[hunterNextCell(hunter)];
      const p = cellCenter(cell);
      this.ghostLayer.append(
        el('path', { d: trianglePath(p, 24, sectorAngle(cell.sector)), class: 'hunter-ghost' }),
      );
    }

    for (const hunter of state.hunters) {
      const cell = state.board.cells[`r${hunter.ring}s${hunter.sector}`];
      const p = cellCenter(cell);
      const group = el('g', { class: 'hunter' });
      group.append(el('path', { d: trianglePath(p, 27, sectorAngle(cell.sector)), class: 'hunter-body' }));
      this.markerLayer.append(group);
    }
  }

  private renderPieces(state: GameState): void {
    this.pieceLayer.replaceChildren();
    const byCell = new Map<string, number[]>();
    for (const p of state.players) {
      const list = byCell.get(p.at) ?? [];
      list.push(p.index);
      byCell.set(p.at, list);
    }

    for (const [cellId, indices] of byCell) {
      const cell = state.board.cells[cellId];
      const base = cellCenter(cell);
      const stacked = indices.length > 1;
      const spreadRadius = stacked ? 19 : 0;
      const pieceRadius = stacked ? 13 : 17;
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
      cx: CENTER.x,
      cy: CENTER.y,
      r: Math.max(IMAGE_WIDTH, IMAGE_HEIGHT),
      class: 'dawn-flash',
    });
    this.svg.append(flash);
    window.setTimeout(() => flash.remove(), 1200);
  }
}

export function highlightFor(state: GameState): string[] {
  return legalMoves(state);
}

export { RING_RADII };
