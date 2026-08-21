import { botTakeTurn } from '../game/ai';
import { BAT_ORDER, BAT_SPECS } from '../game/bats';
import {
  batPlayError,
  createGame,
  currentPlayer,
  dawnAnnounced,
  defaultConfig,
  endTurn,
  endTurnError,
  isFinalNight,
  isSafeCell,
  legalMoves,
  moveTo,
  playBat,
  dawnRisk,
  safeRoundsLeft,
  suckRange,
  swapTargets,
  winnerIndices,
} from '../game/rules';
import type { BatCard, BatKind, GameConfig, GameState, Player } from '../game/types';
import { BoardView } from './board-view';

type Targeting =
  | { kind: 'none' }
  | { kind: 'simple'; card: BatCard }
  | { kind: 'swap'; card: BatCard };

const BOT_STEP_MS = 420;
/** カットインが画面に留まる時間 */
const CUTIN_MS = 1900;

/**
 * HUDの語彙。文章の代わりにこの記号だけで状況を伝える。
 * 盤面に描いてある記号（🦇=洞窟＝日陰兼用 / ⛺=テント）とわざと同じものを使い、
 * 「盤の上で見た形」がそのまま脇のパネルの意味になるようにする。
 * 言葉は消さずに title 属性へ落とす ―― 読みたい人だけが読めばいい。
 */
const ICON = {
  night: '🌙',
  /** 欠けゆく月＝確定の夜が尽き、毎ラウンド賭けに入った状態 */
  waning: '🌘',
  /**
   * 太陽。1夜のサイクルでは「空が白んだ／明けた」、プレイヤー欄では「陽の下」。
   * どちらも意味は同じ ―― 陽が出れば焼ける。
   * （日の出の絵文字 🌅 は16pxだと潰れて月と見分けがつかないので使わない）
   */
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
  help: '?',
} as const;

/** 数を「点いた粒」で見せる。読まずに残量が分かる */
function pips(total: number, on: number): string {
  return Array.from({ length: total }, (_, i) => `<i class="${i < on ? 'on' : ''}"></i>`).join('');
}

/**
 * ゲーム全体の進捗＝消化した夜のチェックボックス。
 *
 * ここに月や太陽を出さない ―― 天体のアイコンは「1夜の中のいま」を指すものと
 * 決めてあり、同じ絵で違うスケール（全4夜 / この夜の残り）を測ると必ず混ざる。
 * 全体の進行はただの消化数なので、数字と☑だけで足りる。
 */
function boxes(total: number, done: number, current: number): string {
  return Array.from({ length: total }, (_, i) => {
    const cls = i < done ? 'is-done' : i === current ? 'is-current' : '';
    return `<i class="box ${cls}">${i < done ? '✓' : ''}</i>`;
  }).join('');
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
  private helpOpen = false;
  /** まだカットインに反映していない batPlays の先頭。BatPlayEvent.seq と比較する */
  private nextBatPlaySeq = 0;
  private cutinQueue: { player: Player; kind: BatKind }[] = [];
  private cutinBusy = false;

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
    const cutin = document.createElement('div');
    cutin.className = 'cutin';
    cutin.id = 'cutin';
    stage.append(cutin);

    const helpToggle = document.createElement('button');
    helpToggle.className = 'help-toggle';
    helpToggle.title = 'ルールを見る';
    helpToggle.textContent = ICON.help;
    helpToggle.addEventListener('click', () => {
      this.helpOpen = !this.helpOpen;
      this.renderHelp();
    });
    stage.append(helpToggle);
    stage.append(this.buildHelpModal());

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

  /**
   * HUDは記号だけで進行を伝える設計にしているぶん、初見では読み解けない。
   * その裏付けとなる文章のルールを、いつでも呼び出せる場所に1つだけ置く。
   */
  private buildHelpModal(): HTMLElement {
    const modal = document.createElement('div');
    modal.className = 'help-modal';
    modal.id = 'help-modal';
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        this.helpOpen = false;
        this.renderHelp();
      }
    });

    const panel = document.createElement('div');
    panel.className = 'help-panel';
    panel.innerHTML = `
      <button class="help-close" title="閉じる">${ICON.cancel}</button>
      <h2>遊びかた</h2>
      <ul>
        <li><b>目的</b> 中心の村（${ICON.blood}）で血を吸い、四隅の自分の城（${ICON.castle}）へ持ち帰る。抱えた血の数字がそのまま得点 ―― <b>持ち帰るまでは0点</b>。</li>
        <li><b>移動</b> 毎ターン ${this.state.config.baseMove} 歩。同心円に沿って横へ、放射線に沿って内外へ。</li>
        <li><b>吸血</b> 村でターンを終えるたびに血を吸える。いくつ出るかは振ってみるまで分からない。抱えても足は鈍らない。</li>
        <li><b>${ICON.dawn} 夜明け</b> 1つの夜は <b>${ICON.night} → ${ICON.waning} → ${ICON.dawn}</b> と移る。最初の数ラウンドは必ず夜（${ICON.night}）、それを過ぎると空が白む可能性が出てきて（${ICON.waning}）、白んだら（${ICON.dawn}）そのラウンドの終わりに必ず朝が来る。避難所（${ICON.shade}/${ICON.bat}）か城にいない者は焼かれ、抱えた血をすべて失う。</li>
        <li><b>${ICON.hunter} ハンター</b> リング2を周回する。触れれば即死。次の一歩は盤面に予告される。</li>
        <li><b>${ICON.bat} 洞窟</b> 最外リングの左右だけ。通るとコウモリ（発展カード）を引ける。</li>
        <li><b>決着</b> 全 ${this.state.config.totalNights} 夜が明けたら終わり。最終夜は村の血が濃くなる。</li>
      </ul>
      <h3>${ICON.bat} コウモリ</h3>
      <ul class="bat-list">
        ${BAT_ORDER.map((kind) => {
          const spec = BAT_SPECS[kind];
          return `<li><b>${spec.icon} ${spec.name}</b> — ${spec.text}</li>`;
        }).join('')}
      </ul>
      <h3>HUDの記号</h3>
      <ul class="legend-list">
        <li><span class="legend-boxes">${boxes(4, 1, 1)}</span> ゲーム全体の進捗 ―― 消化した夜の数</li>
        <li><span class="stat">${ICON.night}</span> この夜はまだ確定で夜（残りラウンド数を表示）</li>
        <li><span class="stat">${ICON.waning}</span> 確定の夜は尽きた ―― いつ空が白んでもおかしくない</li>
        <li><span class="stat">${ICON.dawn}</span> 空が白んだ ―― このラウンドの終わりに必ず朝</li>
        <li><span class="stat safe">${ICON.shade}</span> 夜明けが来ても安全</li>
        <li><span class="stat exposed">${ICON.dawn}</span> 陽の下 ―― 夜明けが来れば灰になる</li>
        <li><span class="stat">☂</span> 蝙蝠傘を差している（即死を1回肩代わり）</li>
        <li><span class="stat">✳</span> スタン中（次の手番は動けない）</li>
        <li><span class="stat">${ICON.step}</span> このターンの残り移動力</li>
      </ul>
    `;
    modal.append(panel);
    panel.querySelector('.help-close')!.addEventListener('click', () => {
      this.helpOpen = false;
      this.renderHelp();
    });
    return modal;
  }

  private renderHelp(): void {
    const modal = this.q<HTMLElement>('help-modal');
    modal.classList.toggle('is-open', this.helpOpen);
  }

  // -------------------------------------------------------------- 入力

  private get humanTurn(): boolean {
    return this.state.phase === 'playing' && !currentPlayer(this.state).isBot;
  }

  private handleCellClick(id: string): void {
    if (!this.humanTurn) return;

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

    // どのカードも、まず効果の説明を出す。即座には撃たない
    const kind = card.kind === 'swap' ? 'swap' : 'simple';
    this.targeting =
      this.targeting.kind !== 'none' && this.targeting.card.uid === card.uid
        ? { kind: 'none' }
        : ({ kind, card } as Targeting);
    this.render();
  }

  private scheduleBot(delayMs: number = BOT_STEP_MS): void {
    if (this.botTimer !== null) window.clearTimeout(this.botTimer);
    if (this.state.phase !== 'playing' || !currentPlayer(this.state).isBot) return;
    this.botTimer = window.setTimeout(() => {
      this.botTimer = null;
      if (this.state.phase !== 'playing') return;
      botTakeTurn(this.state);
      const animMs = this.render();
      // 何手も指した手番ほど、盤面が動き終わるまで次の手番を待たせる
      // ―― CPUが一瞬で打ち終えても、足取りを目で追えるようにする
      this.scheduleBot(Math.max(BOT_STEP_MS, animMs + 150));
    }, delayMs);
  }

  // -------------------------------------------------------------- 描画

  private render(): number {
    if (this.state.night !== this.lastNight || this.state.phase === 'gameover') {
      if (this.state.lastBurned.length > 0 || this.state.night !== this.lastNight) {
        this.board.flashDawn();
      }
      this.lastNight = this.state.night;
    }

    const showMoves = this.humanTurn && this.targeting.kind === 'none';
    const animMs = this.board.render(
      this.state,
      showMoves ? legalMoves(this.state) : [],
      this.targetCells(),
    );
    this.queueCutins();
    this.renderStatus();
    this.renderPlayers();
    this.renderHand();
    this.renderControls();
    this.renderLog();
    return animMs;
  }

  private targetCells(): string[] {
    return [];
  }

  /**
   * コウモリ使用のカットイン。「誰が何を使ったか」は手札のチップやログにも
   * 出ているが、それだけだと人間もCPUも見落とす ―― 画面中央を横切る帯で
   * 一度は必ず目に入るようにする。何枚も続けて使われたら、順番に1枚ずつ見せる。
   */
  private queueCutins(): void {
    const events = this.state.batPlays.filter((e) => e.seq >= this.nextBatPlaySeq);
    this.nextBatPlaySeq = this.state.batPlaySeq;
    for (const event of events) {
      this.cutinQueue.push({ player: this.state.players[event.player], kind: event.kind });
    }
    if (!this.cutinBusy) this.showNextCutin();
  }

  private showNextCutin(): void {
    const next = this.cutinQueue.shift();
    if (!next) {
      this.cutinBusy = false;
      return;
    }
    this.cutinBusy = true;
    const { player, kind } = next;
    const spec = BAT_SPECS[kind];
    const node = this.q('cutin');
    node.style.setProperty('--player-color', player.color);
    node.innerHTML = `
      <span class="cutin-bar">
        ${disc(player)}
        <span class="cutin-name">${player.name}</span>
        <span class="cutin-verb">が</span>
        <span class="cutin-bat"><span class="bat-icon">${spec.icon}</span>${spec.name}</span>
        <span class="cutin-verb">を使った！</span>
      </span>
    `;
    // クラスを一度外して再度付け直すことで、連続使用でもアニメーションを毎回頭から流す
    node.classList.remove('is-visible');
    void node.offsetWidth;
    node.classList.add('is-visible');
    window.setTimeout(() => {
      node.classList.remove('is-visible');
      window.setTimeout(() => this.showNextCutin(), 200);
    }, CUTIN_MS);
  }

  /**
   * 状況は「別々のスケール」を別々の形で見せる。
   *
   * - **全体の進捗**（第何夜 / 全何夜）は ☑ ボックス。天体は使わない。
   * - **この夜のいま**（昼夜のサイクル）は月と太陽のモチーフ。
   *   🌙 満ちた月＝まだ確定で夜 → 🌘 欠けた月＝毎ラウンドの賭け → 🌅 空が白んだ。
   *
   * 以前はどちらも天体アイコン（🌙と☀）で、しかも片方が全4夜、片方が
   * この夜の残りを指していた ―― 同じ絵で違う物差しを測っていたので、
   * どちらがゲーム全体の進行なのか読み取れなかった。
   */
  private renderStatus(): void {
    const s = this.state;
    const node = this.q('status');
    const over = s.phase === 'gameover';
    const safeLeft = over ? 0 : safeRoundsLeft(s);
    const risk = over ? 0 : dawnRisk(s);
    const announced = !over && dawnAnnounced(s);
    const finale = isFinalNight(s);
    const total = s.config.totalNights;
    const pct = Math.round(risk * 100);

    // 1夜の中のどこにいるか。月が満ちている間は安全、欠ければ賭け、陽が覗けば終わり
    const cycle = over
      ? { icon: ICON.dawn, cls: 'is-day', text: '明けた', title: '陽が昇りきった' }
      : announced
        ? {
            icon: ICON.dawn,
            cls: 'is-dawn',
            text: 'このRの終わりに朝',
            title: '空が白んだ ―― このラウンドの終わりに必ず朝が来る。避難所か城へ',
          }
        : risk > 0
          ? {
              icon: ICON.waning,
              cls: 'is-waning',
              text: '夜明けが近い',
              title: `確定の夜は尽きた。このラウンドの終わりに ${pct}% で空が白む`,
            }
          : {
              icon: ICON.night,
              cls: 'is-night',
              text: `あと${safeLeft}Rは夜`,
              title: `あと ${safeLeft} ラウンドは朝の兆しも出ない。そのあとは毎ラウンド ${Math.round(
                s.config.dawnChance * 100,
              )}%`,
            };

    // 空が白んだら急ぐどころではない ―― このラウンドの終わりに必ず朝が来る
    node.className = `status${over ? ' is-over' : announced ? ' is-dawn' : risk > 0 ? ' is-urgent' : ''}`;
    node.innerHTML = `
      <span class="progress" title="${
        over ? `全 ${total} 夜が明けた` : `第 ${s.night} 夜 / 全 ${total} 夜`
      }">
        <b class="progress-count">${over ? total : s.night}<span class="progress-max">/${total}</span></b>
        <span class="progress-unit">夜</span>
        <span class="boxes">${boxes(total, over ? total : s.night - 1, over ? -1 : s.night - 1)}</span>
      </span>
      <span class="cycle ${cycle.cls}" title="${cycle.title}">
        <span class="cycle-icon">${cycle.icon}</span>
        <b class="cycle-text">${cycle.text}</b>
        ${safeLeft > 0 && !over ? `<span class="pips">${pips(s.config.safeRounds, safeLeft)}</span>` : ''}
      </span>
      <span class="stat stat-blood" title="${over ? '村に残った血' : '村に残っている血'} ${s.bloodPool}">
        <span class="stat-icon">${ICON.blood}</span><b>${s.bloodPool}</b>
      </span>
      ${
        finale && !over
          ? `<em class="mult" title="最終夜 ―― 持ち帰った血は 3 倍">${ICON.blood}×3</em>`
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
          ${p.parasol ? `<span class="stat" title="蝙蝠傘を差している ―― 次の即死を1回肩代わりする">☂</span>` : ''}
          ${p.stunned ? `<span class="stat" title="スタン ―― 次の手番は動けない">✳</span>` : ''}
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
      hand.innerHTML = `<p class="empty" title="洞窟（${ICON.bat}）を通るたびに1枚引ける">${ICON.bat}<b>0</b></p>`;
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
    // 腰を据えられるのは村と自分の城だけ。それ以外では1歩は動く（§足跡）
    const squatting = endTurnError(s);

    const info = document.createElement('div');
    info.className = 'turn-info';
    info.innerHTML = `
      <span class="stat" title="残り移動力 ${me.movesLeft} ―― 光ったマスへ進める">${
        ICON.step
      }<b>${me.movesLeft}</b></span>
      ${
        me.carrying > 0
          ? `<span class="stat" title="運搬中の血 ${me.carrying} ―― 血はそのまま点。城まで運べば ${me.carrying} 点になる">${
              ICON.blood
            }<b>${me.carrying}</b><span class="to">→</span>${ICON.castle}<b>${me.carrying}</b></span>`
          : ''
      }
    `;
    node.append(info);

    const suck = suckRange(s);
    const end = document.createElement('button');
    end.className = 'primary';
    end.disabled = squatting !== null;
    // 何本吸えるかは振ってみるまで分からない。幅だけ見せて、残るかどうかを選ばせる
    end.title =
      squatting ??
      (gain
        ? `ここでターンを終えると血を ${suck.min}〜${suck.max} 吸える（平均 ${suck.mean.toFixed(1)}）`
        : 'ターン終了');
    // 動かずには終われない手番では、⏭ ではなく 👣 を出す ―― 「まず歩け」を絵で言う
    end.innerHTML = squatting
      ? `<span class="btn-icon">${ICON.step}</span>`
      : `${
          gain ? `<span class="btn-gain">${ICON.blood}+${suck.min}〜${suck.max}</span>` : ''
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

    // 効果はここに常に文字で出す。手札のチップはアイコンと名前だけなので、
    // 実際に何が起きるかはここでしか読めない
    const desc = document.createElement('p');
    desc.className = 'targeting-desc';
    desc.textContent = spec!.text;
    panel.append(desc);

    if (this.targeting.kind === 'simple') {
      const use = document.createElement('button');
      use.className = 'primary use-bat';
      use.title = `${spec!.name}を使う`;
      use.innerHTML = `<span class="bat-icon">${spec!.icon}</span>使う`;
      use.addEventListener('click', () => {
        playBat(s, card!.uid);
        this.targeting = { kind: 'none' };
        this.render();
      });
      panel.append(use);
    } else if (this.targeting.kind === 'swap') {
      title.title = `${spec!.name} — 位置を入れ替える相手を選ぶ`;
      const row = document.createElement('div');
      row.className = 'targeting-options';
      for (const index of swapTargets(s)) {
        const other = s.players[index];
        const kind = s.board.cells[other.at].kind;
        // 相手がいま何の上に立っているか ―― 横取りする価値があるのはここ
        const spot = kind === 'shade' ? ICON.shade : kind === 'cave' ? ICON.bat : ICON.dawn;
        const where = kind === 'shade' ? 'テント' : kind === 'cave' ? '洞窟' : '陽の下';
        const button = document.createElement('button');
        button.title = `${other.name}（${where}・運搬中 ${other.carrying}）と位置を入れ替える`;
        button.innerHTML = `${disc(other)}<span class="stat">${spot}</span><span class="stat">${
          ICON.blood
        }<b>${other.carrying}</b></span>`;
        button.addEventListener('click', () => {
          playBat(s, card!.uid, { player: index });
          this.targeting = { kind: 'none' };
          this.render();
        });
        row.append(button);
      }
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
