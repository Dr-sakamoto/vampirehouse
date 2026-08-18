import { CASTLE_RING, RING_COUNT, SECTORS } from '../game/board';
import type { Cell } from '../game/types';

export const VIEW = 1000;
export const CENTER = VIEW / 2;

/** 村の半径。ここから外へリングが広がる */
export const VILLAGE_RADIUS = 58;
/** 各リングの外周半径（index 0 = 村の外周） */
export const RING_RADII = [VILLAGE_RADIUS, 148, 238, 328, 418];
export const CASTLE_RADIUS = 472;
export const CASTLE_SIZE = 52;

export interface Point {
  x: number;
  y: number;
}

/** セクター1つぶんの角度（ラジアン） */
export const SECTOR_ANGLE = (Math.PI * 2) / SECTORS;

/** セクター中心の角度。sector 0 が真上、時計回りに増える */
export function sectorAngle(sector: number): number {
  return sector * SECTOR_ANGLE - Math.PI / 2;
}

export function polar(radius: number, angle: number): Point {
  return { x: CENTER + radius * Math.cos(angle), y: CENTER + radius * Math.sin(angle) };
}

/** リング ring（1始まり）の内外半径 */
export function ringBounds(ring: number): { inner: number; outer: number } {
  return { inner: RING_RADII[ring - 1], outer: RING_RADII[ring] };
}

/** マスの中心座標 */
export function cellCenter(cell: Cell): Point {
  if (cell.ring === 0) return { x: CENTER, y: CENTER };
  if (cell.ring === CASTLE_RING) return polar(CASTLE_RADIUS, sectorAngle(cell.sector));
  const { inner, outer } = ringBounds(cell.ring);
  return polar((inner + outer) / 2, sectorAngle(cell.sector));
}

/** 扇形（同心円と放射線で切り取られた1マス）のパス */
export function sectorPath(ring: number, sector: number): string {
  const { inner, outer } = ringBounds(ring);
  const half = SECTOR_ANGLE / 2;
  const a0 = sectorAngle(sector) - half;
  const a1 = sectorAngle(sector) + half;
  const o0 = polar(outer, a0);
  const o1 = polar(outer, a1);
  const i1 = polar(inner, a1);
  const i0 = polar(inner, a0);
  return [
    `M ${o0.x.toFixed(2)} ${o0.y.toFixed(2)}`,
    `A ${outer} ${outer} 0 0 1 ${o1.x.toFixed(2)} ${o1.y.toFixed(2)}`,
    `L ${i1.x.toFixed(2)} ${i1.y.toFixed(2)}`,
    `A ${inner} ${inner} 0 0 0 ${i0.x.toFixed(2)} ${i0.y.toFixed(2)}`,
    'Z',
  ].join(' ');
}

/** 城の輪郭。四隅に置かれた角丸の塊 */
export function castlePath(sector: number): string {
  const c = polar(CASTLE_RADIUS, sectorAngle(sector));
  const s = CASTLE_SIZE;
  const r = 14;
  return [
    `M ${c.x - s + r} ${c.y - s}`,
    `H ${c.x + s - r}`,
    `A ${r} ${r} 0 0 1 ${c.x + s} ${c.y - s + r}`,
    `V ${c.y + s - r}`,
    `A ${r} ${r} 0 0 1 ${c.x + s - r} ${c.y + s}`,
    `H ${c.x - s + r}`,
    `A ${r} ${r} 0 0 1 ${c.x - s} ${c.y + s - r}`,
    `V ${c.y - s + r}`,
    `A ${r} ${r} 0 0 1 ${c.x - s + r} ${c.y - s}`,
    'Z',
  ].join(' ');
}

/** 城と最外リングを繋ぐ通路 */
export function castleBridge(sector: number): { from: Point; to: Point } {
  const angle = sectorAngle(sector);
  return {
    from: polar(RING_RADII[RING_COUNT], angle),
    to: polar(CASTLE_RADIUS - CASTLE_SIZE, angle),
  };
}

/** ハンターを表す三角形。半径方向に尖らせる */
export function trianglePath(center: Point, size: number, angle: number): string {
  const pts = [0, (Math.PI * 2) / 3, (Math.PI * 4) / 3].map((offset) => {
    const a = angle + offset - Math.PI / 2;
    return `${(center.x + size * Math.cos(a)).toFixed(2)},${(center.y + size * Math.sin(a)).toFixed(2)}`;
  });
  return `M ${pts.join(' L ')} Z`;
}
