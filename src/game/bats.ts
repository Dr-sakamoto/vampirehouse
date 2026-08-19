import type { BatCard, BatKind } from './types';

export interface BatSpec {
  kind: BatKind;
  name: string;
  copies: number;
  /** UI 用の短い説明 */
  text: string;
  icon: string;
}

export const BAT_SPECS: Record<BatKind, BatSpec> = {
  dash: {
    kind: 'dash',
    name: '疾走',
    copies: 5,
    text: 'このターンの移動力 +2。',
    icon: '»',
  },
  lure: {
    kind: 'lure',
    name: '誘導',
    copies: 4,
    text: 'ハンター1体を隣のマスへ1歩動かす。踏まれたヴァンパイアは死に、その血は差し向けた者のものになる。',
    icon: '▲',
  },
  steal: {
    kind: 'steal',
    name: '強奪',
    copies: 4,
    text: '城の外にいる他プレイヤー1人から血を1つ奪う。距離は問わない。',
    icon: '✚',
  },
  shroud: {
    kind: 'shroud',
    name: '影紡ぎ',
    copies: 3,
    text: '今いるマスを今夜だけ日陰にする（夜明けで消滅）。',
    icon: '☂',
  },
  flight: {
    kind: 'flight',
    name: '飛翔',
    copies: 3,
    text: '空いている避難所（洞窟・テント）へワープする。移動は終了。',
    icon: '~',
  },
  swap: {
    kind: 'swap',
    name: '影渡り',
    copies: 3,
    text: '城の外にいる他プレイヤー1人と位置を入れ替える。移動は終了。避難所を横取りできる。',
    icon: '⇄',
  },
};

export const BAT_ORDER: BatKind[] = ['dash', 'lure', 'steal', 'swap', 'shroud', 'flight'];

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
