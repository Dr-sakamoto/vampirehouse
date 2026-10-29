// 通信の模型。サーバー役はブラウザの中で動くが、クライアントとは遅延つきのチャンネル越しにしか話さない。
// 本番（友だちとの対戦）では LocalServer をネット越しのサーバーに差し替えるだけで済むよう、
// クライアントが受け取るのは「サーバーが決めた状態のスナップショット」だけにしてある。

import { BotBrain } from './bots';
import { IDLE_INPUT, createWorld, step, type Input, type Params, type World } from './sim';

export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;
/** スナップショットを送る間隔（tick）。30Hz */
const SNAPSHOT_EVERY = 2;

/** 片道 delay ミリ秒で届く郵便受け */
export class LagChannel<T> {
  private queue: { at: number; msg: T }[] = [];
  constructor(public delayMs: number) {}

  send(msg: T, now: number): void {
    this.queue.push({ at: now + this.delayMs, msg });
  }

  receive(now: number): T[] {
    const ready: T[] = [];
    while (this.queue.length > 0 && this.queue[0].at <= now) ready.push(this.queue.shift()!.msg);
    return ready;
  }
}

export interface Snapshot {
  world: World;
}

/** 状態を決める唯一の場所。クライアントの入力は届いた順に1tickに1つずつ消化する */
export class LocalServer {
  world: World;
  private queues = new Map<number, Input[]>();
  private botSeq = 0;
  private brain = new BotBrain();

  constructor(
    playerCount: number,
    public params: Params,
    private readonly humanIds: number[] = [0],
    seed = (Date.now() & 0x7fffffff) >>> 0,
  ) {
    this.world = createWorld(playerCount, seed, params);
    for (const p of this.world.players) p.bot = !humanIds.includes(p.id);
  }

  receive(id: number, input: Input): void {
    const q = this.queues.get(id) ?? [];
    q.push(input);
    this.queues.set(id, q);
  }

  tick(): Snapshot | null {
    const inputs = new Map<number, Input>();
    for (const p of this.world.players) {
      if (this.humanIds.includes(p.id)) {
        const q = this.queues.get(p.id);
        const next = q?.shift();
        // 入力が途切れたら、押しっぱなしの移動だけ引き継ぐ（突き飛ばしは二重に効かせない）
        inputs.set(p.id, next ?? { ...(p.lastInput ?? IDLE_INPUT), shove: false });
        // 遅延の揺れで溜まりすぎたら古いものを捨てて追いつく
        if (q && q.length > 6) q.splice(0, q.length - 2);
      } else {
        inputs.set(p.id, this.brain.input(this.world, p.id, this.params, ++this.botSeq));
      }
    }
    step(this.world, inputs, this.params, DT);
    return this.world.tick % SNAPSHOT_EVERY === 0 ? { world: structuredClone(this.world) } : null;
  }
}

/**
 * 自分の入力はすぐ画面に反映し（予測）、サーバーの答えが届いたらそこから巻き直す。
 * 他人の動きは最後に分かった入力が続いているものとして先読みする。
 */
export class PredictingClient {
  world: World;
  private pending: Input[] = [];
  private seq = 0;

  constructor(
    public readonly id: number,
    initial: World,
  ) {
    this.world = structuredClone(initial);
  }

  /** 1tick分の入力を作って予測を進め、サーバーへ送るべき入力を返す */
  advance(mx: number, my: number, ax: number, ay: number, shove: boolean, suck: boolean, params: Params): Input {
    const input: Input = { seq: ++this.seq, mx, my, ax, ay, shove, suck };
    this.pending.push(input);
    step(this.world, this.inputsFor(input), params, DT);
    return input;
  }

  reconcile(snapshot: Snapshot, params: Params): void {
    const world = structuredClone(snapshot.world);
    const acked = world.players[this.id]?.lastSeq ?? 0;
    this.pending = this.pending.filter((i) => i.seq > acked);
    for (const input of this.pending) step(world, this.inputsFor(input, world), params, DT);
    this.world = world;
  }

  private inputsFor(mine: Input, world: World = this.world): Map<number, Input> {
    const inputs = new Map<number, Input>();
    for (const p of world.players) {
      inputs.set(p.id, p.id === this.id ? mine : { ...p.lastInput, shove: false });
    }
    return inputs;
  }
}
