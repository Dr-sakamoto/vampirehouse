import { CASTLE_RING } from '../game/board';
import type { Cell, Hunter } from '../game/types';

export interface Point {
  x: number;
  y: number;
}

/**
 * 盤面はルール（`docs/design.md` §1）そのものを描いた図形。
 * 同心円4リング＋放射線8本、というルールの構造を、そのまま等間隔の
 * 幾何学図形として描く。写真に合わせて座標をドラッグで調整するような
 * 手順は要らない ―― ルールが決まれば座標も決まる。
 */
export const VIEW_SIZE = 900;
export const CENTER: Point = { x: VIEW_SIZE / 2, y: VIEW_SIZE / 2 };

/** リング境界の半径。[村の外周, リング1外周, リング2外周, リング3外周, リング4外周] */
export const RING_RADII: [number, number, number, number, number] = [58, 148, 238, 328, 418];
/** 城は最外リングのさらに外側、等間隔に離してぶら下げる */
export const CASTLE_DISTANCE = RING_RADII[4] + 74;

export const SECTOR_ANGLE = (Math.PI * 2) / 8;

/** セクター中心の角度。sector 0 を真上に固定する */
export function sectorAngle(sector: number): number {
  return sector * SECTOR_ANGLE - Math.PI / 2;
}

export function polar(radius: number, angle: number): Point {
  return { x: CENTER.x + radius * Math.cos(angle), y: CENTER.y + radius * Math.sin(angle) };
}

function ringBounds(ring: number): { inner: number; outer: number } {
  return { inner: RING_RADII[ring - 1], outer: RING_RADII[ring] };
}

function castlePoint(sector: number): Point {
  return polar(CASTLE_DISTANCE, sectorAngle(sector));
}

/** マスの中心座標（当たり判定・コマ配置に使う） */
export function cellCenter(cell: Cell): Point {
  if (cell.ring === 0) return { ...CENTER };
  if (cell.ring === CASTLE_RING) return castlePoint(cell.sector);
  const { inner, outer } = ringBounds(cell.ring);
  return polar((inner + outer) / 2, sectorAngle(cell.sector));
}

/**
 * 当たり判定の半径。マスの中心に置いた「点」を、押せる大きさに太らせる。
 * リング幅と弧の長さの狭い方から自動で決める。
 */
export function cellHitRadius(cell: Cell): number {
  if (cell.ring === 0) return RING_RADII[0] * 0.9;
  if (cell.ring === CASTLE_RING) return 46;
  const { inner, outer } = ringBounds(cell.ring);
  const mid = (inner + outer) / 2;
  const radialGap = outer - inner;
  const arcGap = mid * SECTOR_ANGLE;
  return Math.max(18, Math.min(radialGap, arcGap) * 0.42);
}

/** ハンター・移動予告に使う小さな三角。先端が angle の方向を向く */
export function trianglePath(center: Point, size: number, angle: number): string {
  const pts = [0, (Math.PI * 2) / 3, (Math.PI * 4) / 3].map((offset) => {
    const a = angle + offset;
    return `${(center.x + size * Math.cos(a)).toFixed(2)},${(center.y + size * Math.sin(a)).toFixed(2)}`;
  });
  return `M ${pts.join(' L ')} Z`;
}

/** ハンターの進行方向（次のセクターへ向かう接線方向）の角度。三角の先端をこれに合わせる */
export function hunterFacingAngle(hunter: Pick<Hunter, 'sector' | 'dir'>): number {
  return sectorAngle(hunter.sector) + hunter.dir * (Math.PI / 2);
}

/** ring/sector 1マスぶんの扇形（ドーナツ片）。盤面の下敷きを描くのに使う */
export function ringSectorPath(ring: number, sector: number): string {
  const { inner, outer } = ringBounds(ring);
  const start = sectorAngle(sector) - SECTOR_ANGLE / 2;
  const end = sectorAngle(sector) + SECTOR_ANGLE / 2;
  const p1 = polar(inner, start);
  const p2 = polar(outer, start);
  const p3 = polar(outer, end);
  const p4 = polar(inner, end);
  return [
    `M ${p1.x.toFixed(2)},${p1.y.toFixed(2)}`,
    `L ${p2.x.toFixed(2)},${p2.y.toFixed(2)}`,
    `A ${outer.toFixed(2)},${outer.toFixed(2)} 0 0 1 ${p3.x.toFixed(2)},${p3.y.toFixed(2)}`,
    `L ${p4.x.toFixed(2)},${p4.y.toFixed(2)}`,
    `A ${inner.toFixed(2)},${inner.toFixed(2)} 0 0 0 ${p1.x.toFixed(2)},${p1.y.toFixed(2)}`,
    'Z',
  ].join(' ');
}

export { CASTLE_RING };
