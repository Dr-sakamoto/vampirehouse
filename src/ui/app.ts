import { botTakeTurn } from '../game/ai';
import { BAT_SPECS } from '../game/bats';
import { cellId } from '../game/board';
import { THRALL_ORDER, THRALL_SPECS } from '../game/thralls';
import {
  batPlayError,
  createGame,
  currentPlayer,
  defaultConfig,
  deliveryValue,
  endTurn,
  flightTargets,
  isFinalNight,
  isSafeCell,
  legalMoves,
  moveTo,
  playBat,
  hireThrall,
  roundsUntilDawn,
  stealTargets,
  thrallError,
  tideChance,
  winnerIndices,
} from '../game/rules';
import type { BatCard, GameConfig, GameState, ThrallKind } from '../game/types';
import { BoardView } from './board-view';

type Targeting =
  | { kind: 'none' }
  | { kind: 'flight'; card: BatCard }
  | { kind: 'steal'; card: BatCard }
  | { kind: 'lure'; card: BatCard }
  /** 眷属を選んだあと、対価に切るコウモリを手札から指名している最中 */
  | { kind: 'thrall'; thrall: ThrallKind };

const BOT_STEP_MS = 420;

export class App {
  private state: GameState;
  private readonly board: BoardView;
  private targeting: Targeting = { kind: 'none' };
  private botTimer: number | null = null;
  private lastNight = 1;

  constructor(
    private readonly root: HTMLElement,
    config: GameConfig,
    private readonly onExit: () => void,
  ) {
    this.state = createGame(config);
    this.board = new BoardView({ onCellClick: (id) => this.handleCellClick(id) });
    this.mount();
    this.render();
    this.scheduleBot();
  }

  destroy(): void {
    if (this.botTimer !== null) window.clearTimeout(this.botTimer);
    this.botTimer = null;
  }

  // -------------------------------------------------------------- 組み立て

  private mount(): void {
    this.root.replaceChildren();
    this.root.className = 'game';

    const stage = document.createElement('div');
    stage.className = 'stage';
    stage.append(this.board.svg);

    const side = document.createElement('aside');
    side.className = 'side';
    side.innerHTML = `
      <div class="status" id="status"></div>
      <div class="players" id="players"></div>
      <div class="hand-block">
        <h2>手札のコウモリ <span class="hint" id="hand-hint"></span></h2>
        <div class="hand" id="hand"></div>
      </div>
      <div class="controls" id="controls"></div>
      <div class="log-block">
        <h2>記録</h2>
        <ol class="log" id="log"></ol>
      </div>
    `;

    this.root.append(stage, side);
  }

  private q<T extends HTMLElement>(id: string): T {
    return this.root.querySelector<T>(`#${id}`)!;
  }

  // -------------------------------------------------------------- 入力

  private get humanTurn(): boolean {
    return this.state.phase === 'playing' && !currentPlayer(this.state).isBot;
  }

  private handleCellClick(id: string): void {
    if (!this.humanTurn) return;

    if (this.targeting.kind === 'flight') {
      if (!flightTargets(this.state).includes(id)) return;
      playBat(this.state, this.targeting.card.uid, { cell: id });
      this.targeting = { kind: 'none' };
      this.render();
      return;
    }
    if (this.targeting.kind !== 'none') return;

    if (legalMoves(this.state).includes(id)) {
      moveTo(this.state, id);
      this.render();
    }
  }

  private handleEndTurn(): void {
    if (!this.humanTurn) return;
    this.targeting = { kind: 'none' };
    endTurn(this.state);
    this.render();
    this.scheduleBot();
  }

  private handleBatClick(card: BatCard): void {
    if (!this.humanTurn) return;

    // 眷属の対価を選んでいる最中は、クリックした札がそのまま支払いになる
    if (this.targeting.kind === 'thrall') {
      hireThrall(this.state, this.targeting.thrall, [card.uid]);
      this.targeting = { kind: 'none' };
      this.render();
      return;
    }

    if (batPlayError(this.state, card.kind) !== null) return;

    if (card.kind === 'flight' || card.kind === 'steal' || card.kind === 'lure') {
      const already =
        (this.targeting.kind === 'flight' ||
          this.targeting.kind === 'steal' ||
          this.targeting.kind === 'lure') &&
        this.targeting.card.uid === card.uid;
      this.targeting = already ? { kind: 'none' } : ({ kind: card.kind, card } as Targeting);
      this.render();
      return;
    }

    playBat(this.state, card.uid);
    this.render();
  }

  private scheduleBot(): void {
    if (this.botTimer !== null) window.clearTimeout(this.botTimer);
    if (this.state.phase !== 'playing' || !currentPlayer(this.state).isBot) return;
    this.botTimer = window.setTimeout(() => {
      this.botTimer = null;
      if (this.state.phase !== 'playing') return;
      botTakeTurn(this.state);
      this.render();
      this.scheduleBot();
    }, BOT_STEP_MS);
  }

  // -------------------------------------------------------------- 描画

  private render(): void {
    if (this.state.night !== this.lastNight || this.state.phase === 'gameover') {
      if (this.state.lastBurned.length > 0 || this.state.night !== this.lastNight) {
        this.board.flashDawn();
      }
      this.lastNight = this.state.night;
    }

    const showMoves = this.humanTurn && this.targeting.kind === 'none';
    this.board.render(this.state, showMoves ? legalMoves(this.state) : [], this.targetCells());
    this.renderStatus();
    this.renderPlayers();
    this.renderHand();
    this.renderControls();
    this.renderLog();
  }

  private targetCells(): string[] {
    if (this.targeting.kind === 'flight') return flightTargets(this.state);
    return [];
  }

  private renderStatus(): void {
    const s = this.state;
    const node = this.q('status');

    if (s.phase === 'gameover') {
      node.className = 'status is-over';
      node.innerHTML = `
        <div class="status-row">
          <span class="pill pill-night">全 ${s.config.totalNights} 夜 終了</span>
          <span class="pill pill-blood">村に残った血 ${s.bloodPool}</span>
        </div>
        <div class="dawn"><span class="dawn-label">☀</span><strong>陽が昇りきった</strong></div>
      `;
      return;
    }

    const untilDawn = roundsUntilDawn(s);
    const finale = isFinalNight(s);
    node.className = `status${untilDawn === 1 ? ' is-urgent' : ''}`;
    node.innerHTML = `
      <div class="status-row">
        <span class="pill pill-night">第 ${s.night} 夜 / ${s.config.totalNights}</span>
        <span class="pill pill-round">ラウンド ${((s.round - 1) % s.config.roundsPerNight) + 1} / ${s.config.roundsPerNight}</span>
        <span class="pill pill-blood">村の血 ${s.bloodPool}</span>
      </div>
      <div class="dawn">
        <span class="dawn-label">☀ 夜明けまで</span>
        <span class="dawn-pips">${Array.from({ length: s.config.roundsPerNight }, (_, i) =>
          `<i class="${i < untilDawn ? 'on' : 'off'}"></i>`).join('')}</span>
        <strong>${untilDawn} ラウンド</strong>
      </div>
      ${this.tideBlock()}
      ${finale ? '<div class="finale">最終夜 ―― 持ち帰った血は 2 点</div>' : ''}
      ${
        untilDawn === 1
          ? finale
            ? '<div class="warning">最後の夜明け。城に戻れなかった血は、すべて無に帰す。</div>'
            : '<div class="warning">このラウンドの終わりに陽が昇る。日陰か城にいない者は灰になる。</div>'
          : ''
      }
    `;
  }

  /**
   * 月潮は「振られるまで分からないが、確率は常に見えている」ダイス。
   * だから直近の出目と、リングごとの濃さを並べて出す。
   * 自分が今どのリングに立っているかも印を付ける ―― それが今夜の賭け。
   */
  private tideBlock(): string {
    const s = this.state;
    const me = currentPlayer(s);
    const myRing = s.board.cells[me.at].ring;
    const rings = [1, 2, 3, 4];
    const last = s.tide;

    const cells = rings
      .map((ring) => {
        const mine = ring === myRing ? ' is-mine' : '';
        const hit = last && last.ring === ring ? ' is-hit' : '';
        return `<span class="vein${mine}${hit}">
            <b>R${ring}</b>
            <i>${Math.round(tideChance(ring) * 100)}%</i>
          </span>`;
      })
      .join('');

    const roll = last
      ? `<span class="tide-dice">${last.dice[0]}+${last.dice[1]}=${last.sum}</span> → リング${last.ring}`
      : '<span class="tide-dice">—</span> まだ振られていない';

    return `
      <div class="tide">
        <div class="tide-head"><span class="tide-label">🌙 月潮</span>${roll}</div>
        <div class="tide-veins">${cells}</div>
        <p class="tide-note">ラウンドの終わりに 2d4。指されたリングに立つ者だけが血を吸える。</p>
      </div>
    `;
  }

  private renderPlayers(): void {
    const s = this.state;
    const node = this.q('players');
    node.replaceChildren();
    for (const p of s.players) {
      const card = document.createElement('div');
      const isCurrent = p.index === s.current && s.phase === 'playing';
      card.className = `player${isCurrent ? ' is-current' : ''}`;
      card.style.setProperty('--player-color', p.color);
      const safe = isSafeCell(s, p, p.at);
      card.innerHTML = `
        <div class="player-head">
          <span class="dot"></span>
          <span class="player-name">${p.name}</span>
          <span class="player-tag">${p.isBot ? 'CPU' : 'あなた'}</span>
          <span class="player-score">${p.score}<small>点</small></span>
        </div>
        <div class="player-stats">
          <span title="運搬中の血">血 ${p.carrying}</span>
          <span title="手札のコウモリ">蝠 ${p.bats.length}</span>
          <span title="このターンの残り移動力">歩 ${isCurrent ? p.movesLeft : '–'}</span>
          <span class="${safe ? 'safe' : 'exposed'}">${safe ? '安全' : '陽の下'}</span>
        </div>
        ${
          p.thralls.length > 0
            ? `<div class="player-thralls">${p.thralls
                .map((k) => {
                  const spec = THRALL_SPECS[k];
                  return `<span class="thrall-chip" title="${spec.name} — ${spec.text}">${spec.icon} ${spec.name}</span>`;
                })
                .join('')}</div>`
            : ''
        }
      `;
      node.append(card);
    }
  }

  private renderHand(): void {
    const s = this.state;
    const me = currentPlayer(s);
    const hand = this.q('hand');
    const hint = this.q('hand-hint');
    hand.replaceChildren();

    if (me.isBot || s.phase !== 'playing') {
      hint.textContent = '';
      hand.innerHTML = `<p class="empty">${
        s.phase === 'gameover' ? '' : `${me.name}（CPU）の手番`
      }</p>`;
      return;
    }

    hint.textContent =
      this.targeting.kind === 'thrall'
        ? `《${THRALL_SPECS[this.targeting.thrall].name}》の対価に切る札を選ぶ`
        : `このターンあと ${Math.max(0, s.config.batsPerTurn - me.batsPlayedThisTurn)} 枚`;

    if (me.bats.length === 0) {
      hand.innerHTML = '<p class="empty">まだ1枚も持っていない。洞窟へ寄り道すれば手に入る。</p>';
      return;
    }

    // 眷属の対価を選んでいる最中は、使えない札も「切る」ことはできる
    const paying = this.targeting.kind === 'thrall';

    for (const card of me.bats) {
      const spec = BAT_SPECS[card.kind];
      const error = paying ? null : batPlayError(s, card.kind);
      const button = document.createElement('button');
      const selected =
        (this.targeting.kind === 'flight' ||
          this.targeting.kind === 'steal' ||
          this.targeting.kind === 'lure') &&
        this.targeting.card.uid === card.uid;
      button.className = `bat${error ? ' is-disabled' : ''}${selected ? ' is-selected' : ''}${
        paying ? ' is-paying' : ''
      }`;
      button.disabled = error !== null;
      button.title = error ?? spec.text;
      button.innerHTML = `
        <span class="bat-icon">${spec.icon}</span>
        <span class="bat-name">${spec.name}</span>
        <span class="bat-text">${spec.text}</span>
        ${error ? `<span class="bat-error">${error}</span>` : ''}
      `;
      button.addEventListener('click', () => this.handleBatClick(card));
      hand.append(button);
    }
  }

  private renderControls(): void {
    const s = this.state;
    const node = this.q('controls');
    node.replaceChildren();

    if (s.phase === 'gameover') {
      const winners = winnerIndices(s).map((i) => s.players[i]);
      const panel = document.createElement('div');
      panel.className = 'gameover';
      panel.innerHTML = `
        <h2>夜が明けきった</h2>
        <p class="winner">${winners.map((w) => w.name).join(' と ')} の勝利</p>
        <ol class="ranking">
          ${[...s.players]
            .sort((a, b) => b.score - a.score || a.deaths - b.deaths)
            .map(
              (p) =>
                `<li><span class="dot" style="--player-color:${p.color}"></span>${p.name} — <strong>${p.score}点</strong>（持ち帰り ${p.delivered} / 死亡 ${p.deaths}）</li>`,
            )
            .join('')}
        </ol>
      `;
      const again = document.createElement('button');
      again.className = 'primary';
      again.textContent = 'もう一晩';
      again.addEventListener('click', () => this.onExit());
      panel.append(again);
      node.append(panel);
      return;
    }

    if (
      this.targeting.kind === 'flight' ||
      this.targeting.kind === 'steal' ||
      this.targeting.kind === 'lure'
    ) {
      node.append(this.targetingPanel());
      return;
    }

    const me = currentPlayer(s);
    if (me.isBot) {
      const waiting = document.createElement('p');
      waiting.className = 'waiting';
      waiting.textContent = `${me.name} が考えている…`;
      node.append(waiting);
      return;
    }

    const info = document.createElement('p');
    info.className = 'turn-info';
    const atVillage = s.board.cells[me.at].kind === 'village';
    info.innerHTML = atVillage
      ? `村にいる。<strong>ここでターンを終えれば血を1つ吸える</strong>（運搬中 ${me.carrying} → ${me.carrying + (s.bloodPool > 0 ? 1 : 0)}）。`
      : `残り移動力 <strong>${me.movesLeft}</strong>。光った隣のマスをクリックして進む。`;
    node.append(info);

    if (me.carrying > 0) {
      const carry = document.createElement('p');
      carry.className = 'turn-info subtle';
      carry.textContent = `血を ${me.carrying} 抱えている（城まで運べば ${
        me.carrying * deliveryValue(s)
      } 点）。重いぶん足は鈍い。`;
      node.append(carry);
    }

    const thralls = this.thrallPanel();
    if (thralls) node.append(thralls);

    const end = document.createElement('button');
    end.className = 'primary';
    end.textContent = atVillage ? '血を吸ってターン終了' : 'ターン終了';
    end.addEventListener('click', () => this.handleEndTurn());
    node.append(end);
  }

  /**
   * 自分の城に立っているあいだだけ開く、眷属の広間。
   * 対価はコウモリ ―― 血（＝得点）では買えない。
   */
  private thrallPanel(): HTMLElement | null {
    const s = this.state;
    const me = currentPlayer(s);
    if (s.board.cells[me.at].kind !== 'castle' || s.board.cells[me.at].castleOf !== me.index) {
      return null;
    }

    const panel = document.createElement('div');
    panel.className = 'thralls';
    const paying = this.targeting.kind === 'thrall';
    panel.innerHTML = `<h3>眷属を迎える <span class="hint">${
      paying ? '対価にするコウモリを手札から選ぶ' : '1夜に1体まで・対価はコウモリ'
    }</span></h3>`;

    const row = document.createElement('div');
    row.className = 'thrall-row';
    for (const kind of THRALL_ORDER) {
      const spec = THRALL_SPECS[kind];
      const error = thrallError(s, me, kind);
      const button = document.createElement('button');
      const selected = this.targeting.kind === 'thrall' && this.targeting.thrall === kind;
      button.className = `thrall${error ? ' is-disabled' : ''}${selected ? ' is-selected' : ''}`;
      button.disabled = error !== null;
      button.title = error ?? spec.text;
      button.innerHTML = `
        <span class="thrall-icon">${spec.icon}</span>
        <span class="thrall-name">${spec.name}<small>蝠 ${spec.cost}</small></span>
        <span class="thrall-text">${spec.text}</span>
        ${error ? `<span class="thrall-error">${error}</span>` : ''}
      `;
      button.addEventListener('click', () => {
        this.targeting = selected ? { kind: 'none' } : { kind: 'thrall', thrall: kind };
        this.render();
      });
      row.append(button);
    }
    panel.append(row);
    return panel;
  }

  private targetingPanel(): HTMLElement {
    const s = this.state;
    const panel = document.createElement('div');
    panel.className = 'targeting';
    const card =
      this.targeting.kind === 'flight' ||
      this.targeting.kind === 'steal' ||
      this.targeting.kind === 'lure'
        ? this.targeting.card
        : null;
    const spec = card ? BAT_SPECS[card.kind] : null;

    const title = document.createElement('p');
    title.className = 'targeting-title';
    panel.append(title);

    if (this.targeting.kind === 'flight') {
      title.textContent = `《${spec!.name}》 降り立つ日陰を盤面から選ぶ`;
    } else if (this.targeting.kind === 'steal') {
      title.textContent = `《${spec!.name}》 血を奪う相手を選ぶ`;
      const row = document.createElement('div');
      row.className = 'targeting-options';
      for (const index of stealTargets(s)) {
        const victim = s.players[index];
        const button = document.createElement('button');
        button.style.setProperty('--player-color', victim.color);
        button.innerHTML = `<span class="dot"></span>${victim.name}<small>血 ${victim.carrying}</small>`;
        button.addEventListener('click', () => {
          playBat(s, card!.uid, { player: index });
          this.targeting = { kind: 'none' };
          this.render();
        });
        row.append(button);
      }
      panel.append(row);
    } else if (this.targeting.kind === 'lure') {
      title.textContent = `《${spec!.name}》 動かすハンターと向きを選ぶ`;
      const row = document.createElement('div');
      row.className = 'targeting-options';
      s.hunters.forEach((hunter, i) => {
        for (const dir of [1, -1] as const) {
          const dest = cellId(hunter.ring, ((hunter.sector + dir) % 8 + 8) % 8);
          const victim = s.players.find((p) => p.at === dest);
          const button = document.createElement('button');
          button.innerHTML = `ハンター${i + 1} を ${dir === 1 ? '時計回り' : '反時計回り'}へ${
            victim ? `<small class="kill">${victim.name} を討つ</small>` : ''
          }`;
          button.addEventListener('click', () => {
            playBat(s, card!.uid, { hunter: hunter.id, dir });
            this.targeting = { kind: 'none' };
            this.render();
          });
          row.append(button);
        }
      });
      panel.append(row);
    }

    const cancel = document.createElement('button');
    cancel.className = 'ghost';
    cancel.textContent = 'やめる';
    cancel.addEventListener('click', () => {
      this.targeting = { kind: 'none' };
      this.render();
    });
    panel.append(cancel);
    return panel;
  }

  private renderLog(): void {
    const node = this.q<HTMLOListElement>('log');
    node.replaceChildren();
    for (const entry of this.state.log.slice(-40).reverse()) {
      const li = document.createElement('li');
      li.className = `log-${entry.tone}`;
      li.innerHTML = `<span class="log-when">${entry.night}夜${entry.round}R</span> ${entry.text}`;
      node.append(li);
    }
  }
}

export { defaultConfig };
