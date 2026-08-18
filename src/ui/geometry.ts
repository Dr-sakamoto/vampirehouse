import { CASTLE_RING } from '../game/board';
import type { Cell } from '../game/types';

/**
 * すべての座標は、あなたがくれた盤面写真そのものの画素空間で定義する。
 * SVG の viewBox をこの写真の実寸に合わせ、写真を背景に敷いた上へ
 * 透明な当たり判定だけを重ねる。数値はすべて写真から実測した値。
 */
export const IMAGE_WIDTH = 896;
export const IMAGE_HEIGHT = 1195;
export const CENTER = { x: IMAGE_WIDTH / 2, y: IMAGE_HEIGHT / 2 };

/**
 * 同心円の境界半径（村の外周から、リング4の外周まで）。
 * 写真を極座標で走査して検出した実測値: 42 / 95 / 198 / 300 / 410 px
 */
export const RING_RADII = [42, 95, 198, 300, 410];
export const VILLAGE_RADIUS = RING_RADII[0];

/** セクター1つぶんの角度（8分割）。放射線は写真上で真上・真右…の45度刻み */
export const SECTOR_ANGLE = (Math.PI * 2) / 8;

/** セクター中心の角度。sector 0 が真上、時計回りに増える */
export function sectorAngle(sector: number): number {
  return sector * SECTOR_ANGLE - Math.PI / 2;
}

export interface Point {
  x: number;
  y: number;
}

export function polar(radius: number, angle: number): Point {
  return { x: CENTER.x + radius * Math.cos(angle), y: CENTER.y + radius * Math.sin(angle) };
}

function ringBounds(ring: number): { inner: number; outer: number } {
  return { inner: RING_RADII[ring - 1], outer: RING_RADII[ring] };
}

/**
 * 四隅の城は、写真の額縁ぎりぎりで切れている青い紋章の位置に実測で合わせてある。
 * board.ts の CASTLE_SECTORS = [1, 3, 5, 7] の並び（右上・右下・左下・左上）と対応する。
 */
const CASTLE_POINTS: Record<number, Point> = {
  1: { x: 830, y: 59 }, // 右上
  3: { x: 834, y: 1137 }, // 右下
  5: { x: 60, y: 1137 }, // 左下
  7: { x: 65, y: 59 }, // 左上
};
export const CASTLE_HIT_RADIUS = 92;

/** マスの中心座標（当たり判定・コマ配置に使う） */
export function cellCenter(cell: Cell): Point {
  if (cell.ring === 0) return { ...CENTER };
  if (cell.ring === CASTLE_RING) return CASTLE_POINTS[cell.sector];
  const { inner, outer } = ringBounds(cell.ring);
  return polar((inner + outer) / 2, sectorAngle(cell.sector));
}

/** 扇形の当たり判定（同心円と放射線で区切られた1マス分） */
export function sectorPath(ring: number, sector: number): string {
  const { inner, outer } = ringBounds(ring);
  const half = SECTOR_ANGLE / 2;
  const mid = sectorAngle(sector);
  const o0 = polar(outer, mid - half);
  const o1 = polar(outer, mid + half);
  const i1 = polar(inner, mid + half);
  const i0 = polar(inner, mid - half);
  return [
    `M ${o0.x.toFixed(2)} ${o0.y.toFixed(2)}`,
    `A ${outer} ${outer} 0 0 1 ${o1.x.toFixed(2)} ${o1.y.toFixed(2)}`,
    `L ${i1.x.toFixed(2)} ${i1.y.toFixed(2)}`,
    `A ${inner} ${inner} 0 0 0 ${i0.x.toFixed(2)} ${i0.y.toFixed(2)}`,
    'Z',
  ].join(' ');
}

/** ハンター・移動予告に使う小さな三角 */
export function trianglePath(center: Point, size: number, angle: number): string {
  const pts = [0, (Math.PI * 2) / 3, (Math.PI * 4) / 3].map((offset) => {
    const a = angle + offset - Math.PI / 2;
    return `${(center.x + size * Math.cos(a)).toFixed(2)},${(center.y + size * Math.sin(a)).toFixed(2)}`;
  });
  return `M ${pts.join(' L ')} Z`;
}

export { CASTLE_RING };
