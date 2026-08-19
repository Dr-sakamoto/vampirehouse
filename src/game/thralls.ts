import type { ThrallKind } from './types';

export interface ThrallSpec {
  kind: ThrallKind;
  name: string;
  /** 自分の城で捨てるコウモリの枚数 */
  cost: number;
  text: string;
  icon: string;
}

/**
 * 眷属 ―― 月潮（ダイス）の当たり外れを、夜を重ねるごとに均していくための永続強化。
 *
 * 支払うのは血ではなく **コウモリ**。血は得点そのものなので、血で買うと
 * 「払った点を engine が取り返せるか」という話になり、1ゲームの総得点が
 * 5〜8点しかないこのゲームでは、どう値付けしても取り返せない
 * （カタンが資源と勝利点を別の通貨にしているのは、たぶんこのため）。
 *
 * コウモリなら得点を削らない。代わりに払うのは
 * ―― 洞窟へ寄り道する手数と、夜明けに自分を救ったはずの1枚。
 *
 * 4つのうち2つ（群れ・牙）は月潮そのものに効く。効き目が出る機会が
 * 「1ラウンドに1回」あるからで、夜に1回しか回ってこない城への帰還に効く
 * 翼・器より、投資を回収する回数がそもそも多い。
 *
 * 雇えるのは **1夜に1体**、自分の城にいるときだけ。4夜のうちに揃うのは
 * 多くて3体なので、どれを先に連れてくるかが技術になる。
 */
export const THRALL_SPECS: Record<ThrallKind, ThrallSpec> = {
  swarm: {
    kind: 'swarm',
    name: '群れ',
    cost: 1,
    text: '月潮が隣のリングを指したときも血を得る。当たり幅が3倍に広がる。',
    icon: '🦇',
  },
  fang: {
    kind: 'fang',
    name: '牙',
    cost: 1,
    text: '月潮が自分のリングちょうどを指したとき、血を2つ得る。当たりの厚み。',
    icon: '🦷',
  },
  vessel: {
    kind: 'vessel',
    name: '器',
    cost: 1,
    text: '血の重さによる減速を −1 までしか受けない。何個抱えても足は止まらない。',
    icon: '🏺',
  },
  wing: {
    kind: 'wing',
    name: '翼',
    cost: 1,
    text: '基礎移動力 +1。出目に合わせて立ち位置を作り直せる。',
    icon: '🪽',
  },
};

export const THRALL_ORDER: ThrallKind[] = ['swarm', 'fang', 'vessel', 'wing'];
