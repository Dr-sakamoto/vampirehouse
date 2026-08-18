import { CASTLE_RING, CASTLE_SECTORS } from '../game/board';
import type { Cell } from '../game/types';
import { getCalibration } from './calibration';
import type { Point } from './calibration';

export type { Point };

/**
 * 盤面写真そのものの画素サイズ。写真を差し替える場合はここも合わせる。
 * それ以外の座標（中心・リング半径・回転・四隅）はすべて calibration.ts の
 * 実行時データから取る ―― 盤面調整モードでドラッグした値が、次の描画から
 * そのまま使われる。
 */
export const IMAGE_WIDTH = 896;
export const IMAGE_HEIGHT = 1195;

export const SECTOR_ANGLE = (Math.PI * 2) / 8;

/** セクター中心の角度。sector 0 が盤面調整モードの回転値ぶん真上から回った位置 */
export function sectorAngle(sector: number): number {
  const { rotationDeg } = getCalibration();
  return sector * SECTOR_ANGLE - Math.PI / 2 + (rotationDeg * Math.PI) / 180;
}

export function polar(radius: number, angle: number): Point {
  const { center } = getCalibration();
  return { x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) };
}

function ringBounds(ring: number): { inner: number; outer: number } {
  const { ringRadii } = getCalibration();
  return { inner: ringRadii[ring - 1], outer: ringRadii[ring] };
}

function castlePoint(sector: number): Point {
  const { castles } = getCalibration();
  return castles[CASTLE_SECTORS.indexOf(sector)];
}

/** マスの中心座標（当たり判定・コマ配置に使う） */
export function cellCenter(cell: Cell): Point {
  if (cell.ring === 0) return { ...getCalibration().center };
  if (cell.ring === CASTLE_RING) return castlePoint(cell.sector);
  const { inner, outer } = ringBounds(cell.ring);
  return polar((inner + outer) / 2, sectorAngle(cell.sector));
}

/**
 * 当たり判定の半径。マスの中心に置いた「点」を、押せる大きさに太らせる。
 * リング幅と弧の長さの狭い方から自動で決めるので、盤面調整でリングの
 * 間隔を詰めても隣のマスと重なりにくい。
 */
export function cellHitRadius(cell: Cell): number {
  const { ringRadii } = getCalibration();
  if (cell.ring === 0) return ringRadii[0] * 0.9;
  if (cell.ring === CASTLE_RING) return 92;
  const { inner, outer } = ringBounds(cell.ring);
  const mid = (inner + outer) / 2;
  const radialGap = outer - inner;
  const arcGap = mid * SECTOR_ANGLE;
  return Math.max(18, Math.min(radialGap, arcGap) * 0.42);
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
