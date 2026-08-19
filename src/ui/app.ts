import { botTakeTurn } from '../game/ai';
import { BAT_SPECS } from '../game/bats';
import { cellId } from '../game/board';
import {
  batPlayError,
  createGame,
  currentPlayer,
  defaultConfig,
  deliveryScore,
  endTurn,
  flightTargets,
  isFinalNight,
  isSafeCell,
  legalMoves,
  moveTo,
  playBat,
  roundsUntilDawn,
  stealTargets,
  swapTargets,
  winnerIndices,
} from '../game/rules';
import type { BatCard, GameConfig, GameState } from '../game/types';
import { BoardView } from './board-view';

type Targeting =
  | { kind: 'none' }
  | { kind: 'flight'; card: BatCard }
  | { kind: 'steal'; card: BatCard }
  | { kind: 'swap'; card: BatCard }
  | { kind: 'lure'; card: BatCard };

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
    if (batPlayError(this.state, card.kind) !== null) return;

    if (
      card.kind === 'flight' ||
      card.kind === 'steal' ||
      card.kind === 'swap' ||
      card.kind === 'lure'
    ) {
      this.targeting =
        this.targeting.kind !== 'none' && this.targeting.card.uid === card.uid
          ? { kind: 'none' }
          : ({ kind: card.kind, card } as Targeting);
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
      ${finale ? '<div class="finale">最終夜 ―― 持ち帰った血は 3 倍</div>' : ''}
      ${
        untilDawn === 1
          ? finale
            ? '<div class="warning">最後の夜明け。城に戻れなかった血は、すべて無に帰す。</div>'
            : '<div class="warning">このラウンドの終わりに陽が昇る。日陰か城にいない者は灰になる。</div>'
          : ''
      }
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

    hint.textContent = `このターンあと ${Math.max(0, s.config.batsPerTurn - me.batsPlayedThisTurn)} 枚`;

    if (me.bats.length === 0) {
      hand.innerHTML = '<p class="empty">まだ1枚も持っていない。洞窟へ寄り道すれば手に入る。</p>';
      return;
    }

    for (const card of me.bats) {
      const spec = BAT_SPECS[card.kind];
      const error = batPlayError(s, card.kind);
      const button = document.createElement('button');
      const selected = this.targeting.kind !== 'none' && this.targeting.card.uid === card.uid;
      button.className = `bat${error ? ' is-disabled' : ''}${selected ? ' is-selected' : ''}`;
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

    if (this.targeting.kind !== 'none') {
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
      : `残り移動力 <strong>${me.movesLeft}</strong>。光った隣のマスをクリックして進む。` +
        `${s.players.some((p) => p.index !== me.index && p.at !== me.at && p.carrying > 0) ? '血を積んだ相手のマスへ踏み込めば、1つ噛み取れる。' : ''}`;
    node.append(info);

    if (me.carrying > 0) {
      const carry = document.createElement('p');
      carry.className = 'turn-info subtle';
      const now = deliveryScore(s, me.carrying);
      const more = deliveryScore(s, me.carrying + 1) - now;
      carry.innerHTML =
        `血を ${me.carrying} 抱えている（いま城まで運べば <strong>${now} 点</strong>）。` +
        `重いぶん足は鈍いが、もう1つ増やせば次の1本は ${more} 点になる。`;
      node.append(carry);
    }

    const end = document.createElement('button');
    end.className = 'primary';
    end.textContent = atVillage ? '血を吸ってターン終了' : 'ターン終了';
    end.addEventListener('click', () => this.handleEndTurn());
    node.append(end);
  }

  private targetingPanel(): HTMLElement {
    const s = this.state;
    const panel = document.createElement('div');
    panel.className = 'targeting';
    const card = this.targeting.kind !== 'none' ? this.targeting.card : null;
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
    } else if (this.targeting.kind === 'swap') {
      title.textContent = `《${spec!.name}》 位置を入れ替える相手を選ぶ`;
      const row = document.createElement('div');
      row.className = 'targeting-options';
      for (const index of swapTargets(s)) {
        const other = s.players[index];
        const theirCell = s.board.cells[other.at];
        const button = document.createElement('button');
        button.style.setProperty('--player-color', other.color);
        button.innerHTML =
          `<span class="dot"></span>${other.name}` +
          `<small>${theirCell.kind === 'shade' ? 'テント' : theirCell.kind === 'cave' ? '洞窟' : '陽の下'}・血 ${other.carrying}</small>`;
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
