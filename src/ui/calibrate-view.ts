import { CASTLE_RING, CASTLE_SECTORS, createBoard } from '../game/board';
import type { Cell, CellKind } from '../game/types';
import boardUrl from '../assets/board.png';
import {
  DEFAULT_CALIBRATION,
  getCalibration,
  setCalibration,
} from './calibration';
import type { Calibration, Point } from './calibration';
import { IMAGE_HEIGHT, IMAGE_WIDTH } from './geometry';

const SVG_NS = 'http://www.w3.org/2000/svg';

function el<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

function clone(cal: Calibration): Calibration {
  return JSON.parse(JSON.stringify(cal)) as Calibration;
}

const KIND_COLOR: Record<CellKind, string> = {
  village: '#e63946',
  castle: '#3d7fb3',
  cave: '#a15fc4',
  shade: '#35c2e6',
  plain: '#e8e2d0',
};

const KIND_LABEL: Record<CellKind, string> = {
  village: '村',
  castle: '城',
  cave: '洞窟',
  shade: '日陰',
  plain: '通常マス',
};

/**
 * 盤面写真の上に、役割ごとに色分けしたポインター（点）を重ねて表示し、
 * ドラッグでその位置を調整できる画面。
 *
 * 動かせるハンドルは4種類だけ:
 *  - 中心（村） ...... 全体の基準点
 *  - リング半径×5 .... 真上方向のハンドルを外へ/内へ動かして各同心円の半径を決める
 *  - 回転 ............ 右方向のハンドルを回して、盤全体の向きを合わせる
 *  - 四隅の城×4 ...... 同心円の外にあるので自由に置く
 *
 * この5種類・11個のハンドルから、32マス＋村＋4城ぶんの当たり判定の
 * 位置がすべて計算で決まる。写真を差し替えたときも、この画面で
 * ハンドルを合わせ直すだけでよい。
 */
export function renderCalibrateView(root: HTMLElement, onClose: () => void): void {
  root.className = 'calibrate';
  root.replaceChildren();

  let cal: Calibration = clone(getCalibration());
  const board = createBoard();

  const wrap = document.createElement('div');
  wrap.className = 'calibrate-wrap';

  const stage = document.createElement('div');
  stage.className = 'calibrate-stage';

  const svg = el('svg', {
    viewBox: `0 0 ${IMAGE_WIDTH} ${IMAGE_HEIGHT}`,
    class: 'calibrate-board',
  });
  const image = el('image', {
    href: boardUrl,
    x: 0,
    y: 0,
    width: IMAGE_WIDTH,
    height: IMAGE_HEIGHT,
  });
  const ringLayer = el('g', { class: 'calibrate-rings' });
  const dotLayer = el('g', { class: 'calibrate-dots' });
  const handleLayer = el('g', { class: 'calibrate-handles' });
  svg.append(image, ringLayer, dotLayer, handleLayer);
  stage.append(svg);

  const side = document.createElement('aside');
  side.className = 'calibrate-side';
  side.innerHTML = `
    <h1>盤面のポインターを調整</h1>
    <p class="calibrate-help">
      ● 印をドラッグすると、写真の上の色つきの点がすべて連動して動く。
      それぞれの点が対応するマスの絵に重なるまで合わせてほしい。
    </p>
    <ul class="calibrate-legend">
      ${(Object.keys(KIND_COLOR) as CellKind[])
        .map((kind) => `<li><i style="--dot: ${KIND_COLOR[kind]}"></i>${KIND_LABEL[kind]}</li>`)
        .join('')}
    </ul>
    <p class="calibrate-help">
      内側から3本目の輪（金色）はハンターが周回するリング。
      特にこの輪の半径と回転が合っているか確認してほしい。
    </p>
    <dl class="calibrate-handles-help">
      <dt>大きな white の点</dt><dd>中心（村の位置）をドラッグ</dd>
      <dt>白い点×5（真上に並ぶ）</dt><dd>各同心円の半径。外へ/内へドラッグ</dd>
      <dt>白い点×1（右側）</dt><dd>盤全体の回転。円を描くようにドラッグ</dd>
      <dt>青い点×4（四隅）</dt><dd>城の位置。自由にドラッグ</dd>
    </dl>
    <p class="calibrate-help calibrate-saved">変更はこの端末に自動的に保存される。</p>
    <div class="calibrate-actions">
      <button class="ghost" id="cal-reset">既定値に戻す</button>
      <button class="ghost" id="cal-copy">設定をコピー</button>
      <button class="primary" id="cal-done">完了してゲームへ</button>
    </div>
    <details class="calibrate-raw">
      <summary>現在の数値（コピー用）</summary>
      <pre id="cal-json"></pre>
    </details>
  `;

  wrap.append(stage, side);
  root.append(wrap);

  function toSvgPoint(evt: PointerEvent): Point {
    const pt = svg.createSVGPoint();
    pt.x = evt.clientX;
    pt.y = evt.clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const p = pt.matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  }

  function makeHandle(cls: string, onDrag: (p: Point) => void): SVGCircleElement {
    const handle = el('circle', { r: 13, class: `handle ${cls}` });
    handle.addEventListener('pointerdown', (evt) => {
      evt.preventDefault();
      handle.setPointerCapture(evt.pointerId);
      const move = (moveEvt: PointerEvent) => {
        onDrag(toSvgPoint(moveEvt));
        update();
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        commit();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
    return handle;
  }

  const centerHandle = makeHandle('handle-center', (p) => {
    cal.center = p;
  });

  const ringHandles = cal.ringRadii.map((_, i) =>
    makeHandle('handle-ring', (p) => {
      const dx = p.x - cal.center.x;
      const dy = p.y - cal.center.y;
      const r = Math.hypot(dx, dy);
      const prev = i > 0 ? cal.ringRadii[i - 1] + 8 : 8;
      const next = i < 4 ? cal.ringRadii[i + 1] - 8 : Math.max(prev + 20, IMAGE_WIDTH);
      cal.ringRadii[i] = Math.min(Math.max(r, prev), next);
    }),
  );

  const rotationHandle = makeHandle('handle-rotation', (p) => {
    const dx = p.x - cal.center.x;
    const dy = p.y - cal.center.y;
    cal.rotationDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
  });

  const castleHandles = cal.castles.map((_, i) =>
    makeHandle('handle-castle', (p) => {
      cal.castles[i] = p;
    }),
  );

  handleLayer.append(centerHandle, ...ringHandles, rotationHandle, ...castleHandles);

  /** sector 0（真上方向のハンドル列）の角度 */
  function angle0(): number {
    return ((-90 + cal.rotationDeg) * Math.PI) / 180;
  }
  /** sector 2（回転ハンドルの角度） */
  function angle2(): number {
    return angle0() + Math.PI / 2;
  }
  function polar(r: number, a: number): Point {
    return { x: cal.center.x + r * Math.cos(a), y: cal.center.y + r * Math.sin(a) };
  }

  function cellPoint(cell: Cell): Point {
    if (cell.ring === 0) return cal.center;
    if (cell.ring === CASTLE_RING) return cal.castles[CASTLE_SECTORS.indexOf(cell.sector)];
    const inner = cal.ringRadii[cell.ring - 1];
    const outer = cal.ringRadii[cell.ring];
    const a = (cell.sector * ((Math.PI * 2) / 8)) + angle0();
    return polar((inner + outer) / 2, a);
  }

  const jsonBox = side.querySelector<HTMLElement>('#cal-json')!;

  function update(): void {
    // 同心円（内側から3本目＝リング2をハンター巡回路として金色で強調）
    ringLayer.replaceChildren();
    cal.ringRadii.forEach((r, i) => {
      ringLayer.append(
        el('circle', {
          cx: cal.center.x,
          cy: cal.center.y,
          r,
          class: `ring-line${i === 2 ? ' ring-hunter' : ''}`,
        }),
      );
    });

    // 役割ごとのポインター
    dotLayer.replaceChildren();
    for (const id of board.order) {
      const cell = board.cells[id];
      const p = cellPoint(cell);
      dotLayer.append(
        el('circle', { cx: p.x, cy: p.y, r: 8, class: `role-dot role-${cell.kind}` }),
      );
    }

    // ハンドルの見た目上の位置
    centerHandle.setAttribute('cx', String(cal.center.x));
    centerHandle.setAttribute('cy', String(cal.center.y));
    cal.ringRadii.forEach((r, i) => {
      const p = polar(r, angle0());
      ringHandles[i].setAttribute('cx', String(p.x));
      ringHandles[i].setAttribute('cy', String(p.y));
    });
    const rp = polar(cal.ringRadii[4] + 44, angle2());
    rotationHandle.setAttribute('cx', String(rp.x));
    rotationHandle.setAttribute('cy', String(rp.y));
    cal.castles.forEach((c, i) => {
      castleHandles[i].setAttribute('cx', String(c.x));
      castleHandles[i].setAttribute('cy', String(c.y));
    });

    jsonBox.textContent = JSON.stringify(cal, null, 2);
  }

  function commit(): void {
    setCalibration(clone(cal));
  }

  side.querySelector('#cal-reset')!.addEventListener('click', () => {
    cal = clone(DEFAULT_CALIBRATION);
    commit();
    update();
  });

  const copyButton = side.querySelector<HTMLButtonElement>('#cal-copy')!;
  copyButton.addEventListener('click', () => {
    const text = JSON.stringify(cal, null, 2);
    navigator.clipboard
      .writeText(text)
      .then(() => {
        const original = copyButton.textContent;
        copyButton.textContent = 'コピーしました';
        window.setTimeout(() => (copyButton.textContent = original), 1500);
      })
      .catch(() => {
        // クリップボードAPIが使えない環境では、下の「現在の数値」から手動でコピーできる
      });
  });

  side.querySelector('#cal-done')!.addEventListener('click', () => {
    commit();
    onClose();
  });

  update();
}
