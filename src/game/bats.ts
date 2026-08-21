import type { BatCard, BatKind } from './types';

export interface BatSpec {
  kind: BatKind;
  name: string;
  copies: number;
  /** UI 用の短い説明 */
  text: string;
  icon: string;
}

/**
 * 手札の上限。これを超えて拾うことはできない。
 *
 * スタン系の札は夜明けの予告ラウンドに撃ってこそ効くので、放っておけば
 * 「強いが、抱え続けると席を埋めて腐る」札になる。上限があって初めて
 * 「今使うか、次の予告まで持つか」が判断になる。
 */
export const HAND_LIMIT = 3;

/**
 * コウモリはすべて「締め出し」の札に絞ってある。
 *
 * 疾走（移動力+2）や強奪のような自己完結の札を置くと、干渉の総量が薄まるうえ、
 * 夜明けが予告制になった今は「予告ラウンドに何を撃つか」がこのゲームの
 * PVP そのものになる。そこへ効かない札は、引いた瞬間に外れ札になる。
 */
export const BAT_SPECS: Record<BatKind, BatSpec> = {
  snare: {
    kind: 'snare',
    name: 'スタン罠',
    copies: 3,
    text: '今いるマスに罠を仕掛ける。全員に見える。踏んだ他プレイヤーはそのマスに捕まり、その手番の足が止まる。城の門に張れば迂回路は無い。夜明けで消える。',
    icon: '✳',
  },
  rush: {
    kind: 'rush',
    name: '強襲',
    copies: 3,
    text: 'このターン、通り抜けたマスにいる他プレイヤーを組み伏せる。抱えていた血をすべて奪い、その手番の足を止める。仕留めはしないので蝙蝠傘では防げない。',
    icon: '»',
  },
  swap: {
    kind: 'swap',
    name: '影渡り',
    copies: 6,
    text: '城の外にいる他プレイヤー1人と位置を入れ替える。移動は終了。避難所を横取りできる。',
    icon: '⇄',
  },
  parasol: {
    kind: 'parasol',
    name: '蝙蝠傘',
    copies: 6,
    text: '宣言して差す。次の即死（陽光・ハンター）を1回だけ肩代わりして消える。夜が明ければ失効する。',
    icon: '☂',
  },
};

export const BAT_ORDER: BatKind[] = ['snare', 'rush', 'swap', 'parasol'];

/**
 * 枚数の根拠（`npm run balance` ボット60戦 × 各人数）。
 *
 * 罠と強襲はどちらも決まれば相手の一夜を丸ごと奪う札なので、**濃くすると壊れる**。
 * 5枚ずつ入れた構成では3人戦の無得点率が 13%、平均得点が 91 まで落ちた
 * （どちらか片方だけなら 169／119 で健全なので、重ねすぎが原因）。
 * 3枚ずつに薄め、空いた枠を受け側（影渡り・傘）へ回すと、
 * 得点 157/130/136・無得点 2〜5% と、干渉を厚くしたまま元の水準へ戻る。
 */

export function buildDeck(): BatCard[] {
  const deck: BatCard[] = [];
  for (const kind of BAT_ORDER) {
    const spec = BAT_SPECS[kind];
    for (let i = 0; i < spec.copies; i++) {
      deck.push({ uid: `${kind}-${i}`, kind });
    }
  }
  return deck;
}
