import {
  currentPlayer,
  hunterNextCell,
  isSafeCell,
  legalMoves,
  roundsUntilDawn,
} from '../game/rules';
import type { GameState } from '../game/types';
import {
  CASTLE_RING,
  CENTER,
  VIEW_SIZE,
  cellCenter,
  cellHitRadius,
  ringSectorPath,
  sectorAngle,
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
 * 盤面は写真ではなく、ルール（同心円4リング＋放射線8本）をそのまま描いた
 * 図形。マスの色分けも役割（村・洞窟・テント・城・通常）に沿って塗る
 * ―― ルールに書かれていない飾りは足さない。
 * その上に、当たり判定と状態表示を兼ねる円を重ねる（`geometry.ts` が座標計算）。
 */
export class BoardView {
  readonly svg: SVGSVGElement;
  private readonly boardLayer = el('g', { class: 'layer-board' });
  private readonly stateLayer = el('g', { class: 'layer-state' });
  private readonly ghostLayer = el('g', { class: 'layer-ghosts' });
  private readonly markerLayer = el('g', { class: 'layer-markers' });
  private readonly pieceLayer = el('g', { class: 'layer-pieces' });
  private readonly stateNodes = new Map<string, SVGCircleElement>();
  private built = false;

  constructor(private readonly options: BoardViewOptions) {
    this.svg = el('svg', {
      viewBox: `0 0 ${VIEW_SIZE} ${VIEW_SIZE}`,
      class: 'board',
      role: 'img',
      'aria-label': 'ヴァンパイア・ハウスの盤面',
    });
    this.svg.append(this.boardLayer, this.stateLayer, this.ghostLayer, this.markerLayer, this.pieceLayer);
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
      const node = el('circle', { cx: c.x, cy: c.y, r: cellHitRadius(cell) });
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

    // 三角に番号を振る。コウモリ《誘導》の選択肢と目で結びつけられるように
    state.hunters.forEach((hunter, i) => {
      const cell = state.board.cells[`r${hunter.ring}s${hunter.sector}`];
      const p = cellCenter(cell);
      const group = el('g', { class: 'hunter' });
      group.append(el('path', { d: trianglePath(p, 27, sectorAngle(cell.sector)), class: 'hunter-body' }));
      const label = el('text', {
        x: p.x,
        y: p.y + 5,
        class: 'hunter-label',
        'text-anchor': 'middle',
      });
      label.textContent = String(i + 1);
      group.append(label);
      this.markerLayer.append(group);
    });
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
