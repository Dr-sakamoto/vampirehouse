/** ヴァンパイア・ハウス — 型定義 */

/** マスの種類 */
export type CellKind =
  | 'village' // 村（中心・血の供給源）
  | 'castle' // 城（プレイヤーの拠点・血の換金所・常に安全）
  | 'cave' // 洞窟（コウモリを獲得。岩陰が陽を遮るので日陰も兼ねる・定員1）
  | 'shade' // 日陰＝テント（夜明けの避難所・定員1）
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
  /** 夜明けをやり過ごせるマス（日陰＋洞窟）。城は含まない */
  refugeCells: string[];
}

/** コウモリ（発展カード）の種類 */
export type BatKind = 'dash' | 'lure' | 'steal' | 'shroud' | 'flight' | 'swap';

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
  /** 運搬中の血（持ち帰るまで得点にならない）。何本抱えても足は鈍らない */
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
  /** 今ターンに噛みついたか（1ターン1回まで） */
  bitThisTurn: boolean;
  /** 通算の死亡回数（同点時のタイブレーク・統計用） */
  deaths: number;
  /** 通算で城に持ち帰った血の本数（得点とは別。まとめ持ち帰りボーナスと最終夜ボーナスがあるため） */
  delivered: number;
  /** 通算で他プレイヤーから奪った血の本数（噛みつき・強奪・仕留めの合計。統計用） */
  stolen: number;
  /** 通算で他プレイヤーを死なせた回数（統計用） */
  kills: number;
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
  /** 毎ターンの移動力。血を抱えていても変わらない */
  baseMove: number;
  /** 村でターンを終えたときに吸える血の目。この中から1つ出る */
  suckFaces: number[];
  /** 夜が必ず続くラウンド数。ここまでは朝が来ない */
  safeRounds: number;
  /** 安全ラウンドを過ぎたあと、1ラウンドごとに朝が来る確率（0〜1） */
  dawnChance: number;
  /** ゲーム全体の夜数 */
  totalNights: number;
  /** 村の血の総量 */
  bloodPool: number;
  /** 城に持ち帰った血1つぶんの基礎得点 */
  bloodValue: number;
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
  /** 今夜が始まってから経過したラウンド数（夜明けで0に戻る） */
  intoNight: number;
  /** 1始まりの夜数 */
  night: number;
  /** 現在の手番プレイヤー */
  current: number;
  /** 今夜の先手プレイヤー。夜ごとに1つずつ回る（席順の有利不利を均す） */
  startPlayer: number;
  phase: Phase;
  log: LogEntry[];
  /** 直近の夜明けで焼かれたプレイヤーindex（演出用） */
  lastBurned: number[];
  rngState: number;
}
