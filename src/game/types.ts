/** ヴァンパイア・ハウス — 型定義 */

/** マスの種類 */
export type CellKind =
  | 'village' // 村（中心・血の供給源）
  | 'castle' // 城（プレイヤーの拠点・血の換金所・常に安全）
  | 'cave' // 洞窟（コウモリを獲得）
  | 'shade' // 日陰（夜明けの避難所・定員1）
  | 'plain'; // 何もないマス

/** 盤面上の1マス */
export interface Cell {
  /** 一意なID。例: 'r2s5' / 'village' / 'castle0' */
  id: string;
  kind: CellKind;
  /** 同心円のリング番号。0=村, 1..RING_COUNT=通常リング, CASTLE_RING=城 */
  ring: number;
  /** リング内のセクター番号（0..SECTORS-1）。村は0 */
  sector: number;
  /** 城マスの場合、その所有プレイヤーのindex */
  castleOf?: number;
  /** 隣接マスID（同リング横移動＋放射方向の内外移動） */
  neighbors: string[];
}

export interface Board {
  cells: Record<string, Cell>;
  order: string[];
  sectors: number;
  ringCount: number;
  castleRing: number;
  castleCells: string[];
  shadeCells: string[];
  caveCells: string[];
}

/** 眷属（永続強化）の種類 */
export type ThrallKind =
  | 'swarm' // 群れ: 月潮が隣のリングを指したときも血を得る
  | 'fang' // 牙: 月潮の取り分が2つになる
  | 'vessel' // 器: 血の重さが3個ごとになる
  | 'wing'; // 翼: 基礎移動力 +1

/** コウモリ（発展カード）の種類 */
export type BatKind = 'dash' | 'lure' | 'steal' | 'shroud' | 'flight';

export interface BatCard {
  uid: string;
  kind: BatKind;
}

export interface Hunter {
  id: string;
  ring: number;
  sector: number;
  /** +1 = 時計回り, -1 = 反時計回り */
  dir: 1 | -1;
}

export interface Player {
  index: number;
  name: string;
  isBot: boolean;
  color: string;
  /** 現在地のセルID */
  at: string;
  /** 運搬中の血（持ち帰るまで得点にならない） */
  carrying: number;
  /** 城に持ち帰って確定した得点 */
  score: number;
  /** 手札のコウモリ（伏せ札） */
  bats: BatCard[];
  /** 今ターンの残り移動力 */
  movesLeft: number;
  /** 今ターンに使用したコウモリの枚数 */
  batsPlayedThisTurn: number;
  /** 今夜のうち、SHROUD で日陰扱いにしたセルID（夜明けで消滅） */
  shroudedCell: string | null;
  /** 今ターンに洞窟を訪れたか（1ターン1枚まで） */
  lootedCaveThisTurn: boolean;
  /** 通算の死亡回数（同点時のタイブレーク・統計用） */
  deaths: number;
  /** 通算で城に持ち帰った血の本数（得点とは別。最終夜ボーナスがあるため） */
  delivered: number;
  /** 雇った眷属（永続強化）。同じ種類は1つまで */
  thralls: ThrallKind[];
  /** 今夜すでに眷属を雇ったか（1夜1体まで） */
  hiredThisNight: boolean;
}

/** 月潮 ―― 全員に同時に降りかかる、1ラウンド1回のダイス */
export interface Tide {
  /** 4面ダイス2つの出目 */
  dice: [number, number];
  /** 合計（2〜8） */
  sum: number;
  /** 血脈が湧いたリング（1〜4） */
  ring: number;
  /** 実際に血を得たプレイヤーindex */
  fed: number[];
}

export type Phase = 'playing' | 'dawn' | 'gameover';

export interface LogEntry {
  round: number;
  night: number;
  text: string;
  tone: 'info' | 'good' | 'bad' | 'warn';
}

export interface GameConfig {
  playerCount: number;
  /** 各プレイヤーが人間かボットか */
  bots: boolean[];
  /** 基礎移動力 */
  baseMove: number;
  /** 1夜あたりのラウンド数（このラウンド数が終わると夜明け） */
  roundsPerNight: number;
  /** ゲーム全体の夜数 */
  totalNights: number;
  /** 村の血の総量 */
  bloodPool: number;
  /** 1ターンに使えるコウモリの最大枚数 */
  batsPerTurn: number;
  /** 乱数シード（デッキのシャッフル用。同じシード＝同じ配札） */
  seed: number;
}

export interface GameState {
  config: GameConfig;
  board: Board;
  players: Player[];
  hunters: Hunter[];
  deck: BatCard[];
  discard: BatCard[];
  /** 村に残っている血 */
  bloodPool: number;
  /** 今夜、既に採掘済みの洞窟（夜明けでリセット） */
  cavesLooted: string[];
  /** 1始まりの通算ラウンド数 */
  round: number;
  /** 1始まりの夜数 */
  night: number;
  /** 現在の手番プレイヤー */
  current: number;
  phase: Phase;
  log: LogEntry[];
  /** 直近の夜明けで焼かれたプレイヤーindex（演出用） */
  lastBurned: number[];
  /** 直近に振られた月潮。まだ1回も振っていなければ null */
  tide: Tide | null;
  rngState: number;
}
