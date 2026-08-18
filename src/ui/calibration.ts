/**
 * 盤面写真の上に置く「役割ごとのポインター」の座標データ。
 *
 * ここに書く数値は当てずっぽうの初期値でしかない。実際の当たり判定は
 * この値をもとに描かれるので、写真とずれていたら盤面調整モード
 * （setup画面の「盤面のずれを調整」）でハンドルをドラッグして直す ――
 * 変更はこの端末に自動保存され、盤面写真を差し替えたときも同じ手順で
 * 調整し直せる。
 */

export interface Point {
  x: number;
  y: number;
}

export interface Calibration {
  /** 盤面の中心（村の位置）。写真のピクセル座標 */
  center: Point;
  /** 同心円の境界半径。[村の外周, リング1外周, リング2外周, リング3外周, リング4外周] */
  ringRadii: [number, number, number, number, number];
  /** 全体の回転（度）。0でセクター0の中心が写真の真上を向く */
  rotationDeg: number;
  /**
   * 四隅の城の座標。board.ts の CASTLE_SECTORS = [1, 3, 5, 7]
   * （右上・右下・左下・左上）の順に対応する。
   * 城は同心円の外側にあり写真の額縁で切れていることが多いため、
   * 同心円の計算に乗せず個別に置く。
   */
  castles: [Point, Point, Point, Point];
}

/** 実測に基づく初期値。盤面調整モードの「既定値に戻す」もこの値を使う */
export const DEFAULT_CALIBRATION: Calibration = {
  center: { x: 448, y: 597.5 },
  ringRadii: [42, 95, 198, 300, 410],
  rotationDeg: 0,
  castles: [
    { x: 830, y: 59 }, // 右上（セクター1）
    { x: 834, y: 1137 }, // 右下（セクター3）
    { x: 60, y: 1137 }, // 左下（セクター5）
    { x: 65, y: 59 }, // 左上（セクター7）
  ],
};

const STORAGE_KEY = 'vampirehouse:calibration:v1';

function clone(cal: Calibration): Calibration {
  return JSON.parse(JSON.stringify(cal)) as Calibration;
}

function isValid(value: unknown): value is Calibration {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<Calibration>;
  return (
    !!v.center &&
    Array.isArray(v.ringRadii) &&
    v.ringRadii.length === 5 &&
    Array.isArray(v.castles) &&
    v.castles.length === 4
  );
}

function load(): Calibration {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return clone(DEFAULT_CALIBRATION);
    const parsed: unknown = JSON.parse(raw);
    return isValid(parsed) ? parsed : clone(DEFAULT_CALIBRATION);
  } catch {
    return clone(DEFAULT_CALIBRATION);
  }
}

let current: Calibration = load();
const listeners = new Set<() => void>();

export function getCalibration(): Calibration {
  return current;
}

export function setCalibration(next: Calibration): void {
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    // プライベートモードなどで保存できなくても、今のセッションは続けられる
  }
  for (const fn of listeners) fn();
}

export function resetCalibration(): void {
  setCalibration(clone(DEFAULT_CALIBRATION));
}

/** 盤面調整モードが値を書き換えるたびに、対局中の盤面を再描画するための購読 */
export function onCalibrationChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
