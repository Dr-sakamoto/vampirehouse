import { botTakeTurn } from '../game/ai';
import { BAT_SPECS } from '../game/bats';
import { cellId } from '../game/board';
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
  roundsUntilDawn,
  stealTargets,
  winnerIndices,
} from '../game/rules';
import type { BatCard, GameConfig, GameState, Player } from '../game/types';
import { BoardView } from './board-view';

type Targeting =
  | { kind: 'none' }
  | { kind: 'flight'; card: BatCard }
  | { kind: 'steal'; card: BatCard }
  | { kind: 'lure'; card: BatCard };

const BOT_STEP_MS = 420;

/**
 * HUDの語彙。文章の代わりにこの記号だけで状況を伝える。
 * 盤面に描いてある記号（🦇=洞窟 / ⛺=日陰）とわざと同じものを使い、
 * 「盤の上で見た形」がそのまま脇のパネルの意味になるようにする。
 * 言葉は消さずに title 属性へ落とす ―― 読みたい人だけが読めばいい。
 */
const ICON = {
  night: '🌙',
  dawn: '☀',
  blood: '🩸',
  bat: '🦇',
  step: '👣',
  shade: '⛺',
  castle: '🏰',
  hunter: '▲',
  human: '👤',
  bot: '🤖',
  dead: '☠',
  crown: '🏆',
  end: '⏭',
  again: '↻',
  cancel: '✕',
  cw: '↻',
  ccw: '↺',
  aim: '🎯',
} as const;

/** 数を「点いた粒」で見せる。読まずに残量が分かる */
function pips(total: number, on: number): string {
  return Array.from({ length: total }, (_, i) => `<i class="${i < on ? 'on' : ''}"></i>`).join('');
}

/** プレイヤーの識別子は盤面のコマと同じ「色つきの番号」 */
function disc(player: Player): string {
  return `<span class="disc" style="--player-color:${player.color}">${player.index + 1}</span>`;
}

function who(player: Player): string {
  return player.isBot ? ICON.bot : ICON.human;
}

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

  /**
   * 画面は1枚きり。盤面を中央に最大まで広げ、その余白（横長なら左右、
   * 縦長なら上下）にHUDを敷く。ページはスクロールしない ―― 溢れるのは
   * ログや手札といった各パネルの内側だけ。
   */
  private mount(): void {
    this.root.replaceChildren();
    this.root.className = 'game';

    const stage = document.createElement('div');
    stage.className = 'stage';
    stage.append(this.board.svg);

    const left = document.createElement('aside');
    left.className = 'hud hud-left';
    left.innerHTML = `
      <div class="status" id="status"></div>
      <div class="players" id="players"></div>
      <details class="log-block" id="log-block">
        <summary title="記録">📜</summary>
        <ol class="log" id="log"></ol>
      </details>
    `;

    const right = document.createElement('aside');
    right.className = 'hud hud-right';
    right.innerHTML = `
      <div class="hand-block" id="hand-block">
        <h2 title="手札のコウモリ">
          <span class="head-icon">${ICON.bat}</span>
          <span class="pips pips-bat" id="hand-hint"></span>
        </h2>
        <div class="hand" id="hand"></div>
      </div>
      <div class="controls" id="controls"></div>
    `;

    this.root.append(left, stage, right);
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

    if (card.kind === 'flight' || card.kind === 'steal' || card.kind === 'lure') {
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

  /**
   * 夜・夜明け・血の3つのゲージだけ。数えるのは粒であって文字ではない。
   * 「あと1ラウンドで夜明け」は文章ではなく、☀ゲージの点滅で伝わる。
   */
  private renderStatus(): void {
    const s = this.state;
    const node = this.q('status');
    const over = s.phase === 'gameover';
    const untilDawn = over ? 0 : roundsUntilDawn(s);
    const finale = isFinalNight(s);

    node.className = `status${over ? ' is-over' : untilDawn === 1 ? ' is-urgent' : ''}`;
    node.innerHTML = `
      <span class="gauge gauge-night" title="${
        over ? `全 ${s.config.totalNights} 夜が明けた` : `第 ${s.night} 夜 / 全 ${s.config.totalNights} 夜`
      }">
        <span class="gauge-icon">${ICON.night}</span>
        <span class="pips">${pips(s.config.totalNights, over ? s.config.totalNights : s.night)}</span>
      </span>
      <span class="gauge gauge-dawn" title="${
        over ? '陽が昇りきった' : `夜明けまで ${untilDawn} ラウンド`
      }">
        <span class="gauge-icon">${ICON.dawn}</span>
        <span class="pips">${pips(s.config.roundsPerNight, untilDawn)}</span>
      </span>
      <span class="stat stat-blood" title="${over ? '村に残った血' : '村に残っている血'} ${s.bloodPool}">
        <span class="stat-icon">${ICON.blood}</span><b>${s.bloodPool}</b>
      </span>
      ${
        finale && !over
          ? `<em class="mult" title="最終夜 ―― 持ち帰った血は 2 点">${ICON.blood}×2</em>`
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
      card.title = `${p.name}（${p.isBot ? 'CPU' : 'あなた'}） ${p.score}点`;
      card.innerHTML = `
        <div class="player-head">
          ${disc(p)}
          <span class="player-tag">${who(p)}</span>
          <span class="player-score">${p.score}</span>
        </div>
        <div class="player-stats">
          <span class="stat" title="運搬中の血">${ICON.blood}<b>${p.carrying}</b></span>
          <span class="stat" title="手札のコウモリ">${ICON.bat}<b>${p.bats.length}</b></span>
          ${
            isCurrent
              ? `<span class="stat" title="このターンの残り移動力">${ICON.step}<b>${p.movesLeft}</b></span>`
              : ''
          }
          <span class="stat ${safe ? 'safe' : 'exposed'}" title="${
            safe ? '夜明けが来ても安全' : '陽の下 ―― 夜明けが来れば灰になる'
          }">${safe ? ICON.shade : ICON.dawn}</span>
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

    // 自分の番でなければ手札の枠ごと消す。空の箱を置いておく意味はない
    this.q('hand-block').hidden = me.isBot || s.phase !== 'playing';
    if (me.isBot || s.phase !== 'playing') {
      hint.innerHTML = '';
      hand.innerHTML = '';
      return;
    }

    const playsLeft = Math.max(0, s.config.batsPerTurn - me.batsPlayedThisTurn);
    hint.innerHTML = pips(s.config.batsPerTurn, playsLeft);
    hint.title = `このターンあと ${playsLeft} 枚まで使える`;

    if (me.bats.length === 0) {
      hand.innerHTML = `<p class="empty" title="洞窟（${ICON.bat}）を通れば1枚引ける">${ICON.bat}<b>0</b></p>`;
      return;
    }

    // 説明文はチップから外し、title に預ける ―― 絵と名前だけが並ぶ
    for (const card of me.bats) {
      const spec = BAT_SPECS[card.kind];
      const error = batPlayError(s, card.kind);
      const button = document.createElement('button');
      const selected = this.targeting.kind !== 'none' && this.targeting.card.uid === card.uid;
      button.className = `bat${error ? ' is-disabled' : ''}${selected ? ' is-selected' : ''}`;
      button.disabled = error !== null;
      button.title = `${spec.name} — ${spec.text}${error ? `\n（${error}）` : ''}`;
      button.innerHTML = `
        <span class="bat-icon">${spec.icon}</span>
        <span class="bat-name">${spec.name}</span>
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
        <p class="winner" title="${winners.map((w) => w.name).join(' と ')} の勝利">
          <span class="crown">${ICON.crown}</span>${winners.map(disc).join('')}
        </p>
        <ol class="ranking">
          ${[...s.players]
            .sort((a, b) => b.score - a.score || a.deaths - b.deaths)
            .map(
              (p) =>
                `<li title="${p.name}（${p.isBot ? 'CPU' : 'あなた'}）">
                  ${disc(p)}
                  <b class="rank-score">${p.score}</b>
                  <span class="stat" title="城へ持ち帰った血">${ICON.blood}<b>${p.delivered}</b></span>
                  <span class="stat" title="灰になった回数">${ICON.dead}<b>${p.deaths}</b></span>
                </li>`,
            )
            .join('')}
        </ol>
      `;
      const again = document.createElement('button');
      again.className = 'primary';
      again.title = 'もう一晩';
      again.innerHTML = `<span class="btn-icon">${ICON.again}</span>`;
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
      const waiting = document.createElement('div');
      waiting.className = 'thinking';
      waiting.title = `${me.name}（CPU）が考えている`;
      waiting.innerHTML = `${disc(me)}<span class="dots"><i></i><i></i><i></i></span>`;
      node.append(waiting);
      return;
    }

    const atVillage = s.board.cells[me.at].kind === 'village';
    const gain = atVillage && s.bloodPool > 0;

    const info = document.createElement('div');
    info.className = 'turn-info';
    info.innerHTML = `
      <span class="stat" title="残り移動力 ${me.movesLeft} ―― 光ったマスへ進める">${
        ICON.step
      }<b>${me.movesLeft}</b></span>
      ${
        me.carrying > 0
          ? `<span class="stat" title="運搬中の血 ${me.carrying} ―― 城まで運べば ${
              me.carrying * deliveryValue(s)
            } 点">${ICON.blood}<b>${me.carrying}</b><span class="to">→</span>${ICON.castle}<b>${
              me.carrying * deliveryValue(s)
            }</b></span>`
          : ''
      }
    `;
    node.append(info);

    const end = document.createElement('button');
    end.className = 'primary';
    end.title = gain ? '血を1つ吸ってターン終了' : 'ターン終了';
    end.innerHTML = `${
      gain ? `<span class="btn-gain">${ICON.blood}+1</span>` : ''
    }<span class="btn-icon">${ICON.end}</span>`;
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
    title.innerHTML = `<span class="bat-icon">${spec!.icon}</span><span class="bat-name">${spec!.name}</span>`;
    panel.append(title);

    if (this.targeting.kind === 'flight') {
      // 行き先は盤面が光って示す。ここでは「盤を狙え」とだけ見せる
      title.title = `${spec!.name} — 降り立つ日陰を盤面から選ぶ`;
      title.insertAdjacentHTML(
        'beforeend',
        `<span class="aim" title="盤面の光った日陰を選ぶ">${ICON.aim}${ICON.shade}</span>`,
      );
    } else if (this.targeting.kind === 'steal') {
      title.title = `${spec!.name} — 血を奪う相手を選ぶ`;
      const row = document.createElement('div');
      row.className = 'targeting-options';
      for (const index of stealTargets(s)) {
        const victim = s.players[index];
        const button = document.createElement('button');
        button.title = `${victim.name} から血を1つ奪う（運搬中 ${victim.carrying}）`;
        button.innerHTML = `${disc(victim)}<span class="stat">${ICON.blood}<b>${victim.carrying}</b></span>`;
        button.addEventListener('click', () => {
          playBat(s, card!.uid, { player: index });
          this.targeting = { kind: 'none' };
          this.render();
        });
        row.append(button);
      }
      panel.append(row);
    } else if (this.targeting.kind === 'lure') {
      title.title = `${spec!.name} — 動かすハンターと向きを選ぶ`;
      const row = document.createElement('div');
      row.className = 'targeting-options targeting-lure';
      s.hunters.forEach((hunter, i) => {
        for (const dir of [1, -1] as const) {
          const dest = cellId(hunter.ring, ((hunter.sector + dir) % 8 + 8) % 8);
          const victim = s.players.find((p) => p.at === dest);
          const button = document.createElement('button');
          button.title = `ハンター${i + 1} を${dir === 1 ? '時計回り' : '反時計回り'}へ1歩${
            victim ? ` ―― ${victim.name} を討つ` : ''
          }`;
          button.innerHTML = `
            <span class="hunter-mark">${ICON.hunter}<b>${i + 1}</b></span>
            <span class="dir">${dir === 1 ? ICON.cw : ICON.ccw}</span>
            ${victim ? `<span class="kill">${disc(victim)}${ICON.dead}</span>` : ''}
          `;
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
    cancel.className = 'ghost cancel';
    cancel.title = 'やめる';
    cancel.textContent = ICON.cancel;
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
