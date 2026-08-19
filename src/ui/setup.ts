import { BAT_ORDER, BAT_SPECS } from '../game/bats';
import { PLAYER_COLORS, PLAYER_NAMES, defaultConfig } from '../game/rules';
import type { GameConfig } from '../game/types';

interface ParamSpec {
  key: 'baseMove' | 'roundsPerNight' | 'totalNights' | 'bloodPool' | 'batsPerTurn';
  label: string;
  min: number;
  max: number;
  step: number;
  hint: (value: number) => string;
}

const PARAM_SPECS: ParamSpec[] = [
  {
    key: 'baseMove',
    label: '基礎移動力',
    min: 1,
    max: 6,
    step: 1,
    hint: (v) => `毎ターン ${v} 歩`,
  },
  {
    key: 'roundsPerNight',
    label: '1夜のラウンド数',
    min: 2,
    max: 8,
    step: 1,
    hint: (v) => `${v} ラウンドで夜明け`,
  },
  {
    key: 'totalNights',
    label: '夜の数',
    min: 1,
    max: 8,
    step: 1,
    hint: (v) => `全 ${v} 夜で決着`,
  },
  {
    key: 'bloodPool',
    label: '村の血の総量',
    min: 4,
    max: 60,
    step: 1,
    hint: (v) => `血 ${v} 個`,
  },
  {
    key: 'batsPerTurn',
    label: '1ターンのコウモリ上限',
    min: 1,
    max: 5,
    step: 1,
    hint: (v) => `${v} 枚まで`,
  },
];

export function renderSetup(
  root: HTMLElement,
  onStart: (config: GameConfig) => void,
): void {
  let playerCount = 2;
  let humanCount = 1;
  const base = defaultConfig(playerCount);
  const params: Record<ParamSpec['key'], number> = {
    baseMove: base.baseMove,
    roundsPerNight: base.roundsPerNight,
    totalNights: base.totalNights,
    bloodPool: base.bloodPool,
    batsPerTurn: base.batsPerTurn,
  };
  let bloodPoolTouched = false;
  let paramsOpen = false;

  root.className = 'setup';

  const draw = () => {
    root.replaceChildren();
    const panel = document.createElement('div');
    panel.className = 'setup-panel';
    panel.innerHTML = `
      <h1>ヴァンパイア・ハウス</h1>
      <p class="tagline">中心の村で血を吸い、四隅の城へ持ち帰る。<br>朝までに帰れなければ、すべて失う。</p>

      <div class="setup-field">
        <span class="setup-label">人数</span>
        <div class="chips" id="count"></div>
      </div>
      <div class="setup-field">
        <span class="setup-label">操作する城</span>
        <div class="chips" id="humans"></div>
      </div>

      <details class="params" id="params-block"${paramsOpen ? ' open' : ''}>
        <summary>詳細設定</summary>
        <div class="params-grid" id="params"></div>
        <button class="ghost params-reset" id="params-reset">既定値に戻す</button>
      </details>

      <button class="primary start" id="start">夜を始める</button>

      <details class="rules">
        <summary>遊びかた</summary>
        <ul>
          <li><b>移動</b> 毎ターン3歩。同心円に沿って横へ、放射線に沿って内外へ。</li>
          <li><b>血</b> 中心の村でターンを終えるたびに1つ吸える。自分の城に入った瞬間に得点になる。持ち帰るまでは0点。</li>
          <li><b>重さ</b> 血2つごとに移動力が1減る。欲張るほど帰り道は遠い。</li>
          <li><b>太陽</b> 4ラウンドごとに夜が明ける。日陰か城にいない者は焼かれ、抱えた血をすべて失う。</li>
          <li><b>ハンター</b> 黄色い三角。リング2を1ラウンドに1マスずつ周回する。触れれば即死。位置も進路も読める。</li>
          <li><b>洞窟</b> 通るとコウモリを1枚引ける。同じ洞窟は一夜に1回、1ターンに1枚まで。</li>
          <li><b>日陰</b> 定員1人。深部（リング2）の日陰はハンターの巡回路と重なっている。</li>
          <li><b>決着</b> 4夜が明けたら終わり。最終夜の持ち帰りは2点。</li>
        </ul>
        <h3>コウモリ</h3>
        <ul class="bat-list">
          ${BAT_ORDER.map((kind) => {
            const spec = BAT_SPECS[kind];
            return `<li><b>${spec.icon} ${spec.name}</b> ×${spec.copies} — ${spec.text}</li>`;
          }).join('')}
        </ul>
      </details>
    `;
    root.append(panel);

    const paramsBlock = panel.querySelector<HTMLDetailsElement>('#params-block')!;
    paramsBlock.addEventListener('toggle', () => {
      paramsOpen = paramsBlock.open;
    });

    const countRow = panel.querySelector('#count')!;
    for (const n of [2, 3, 4]) {
      const button = document.createElement('button');
      button.className = `chip${n === playerCount ? ' is-on' : ''}`;
      button.textContent = `${n} 人`;
      button.addEventListener('click', () => {
        playerCount = n;
        humanCount = Math.min(humanCount, n);
        if (!bloodPoolTouched) params.bloodPool = defaultConfig(playerCount).bloodPool;
        draw();
      });
      countRow.append(button);
    }

    const humanRow = panel.querySelector('#humans')!;
    for (let n = 0; n <= playerCount; n++) {
      const button = document.createElement('button');
      button.className = `chip${n === humanCount ? ' is-on' : ''}`;
      button.textContent = n === 0 ? 'すべてCPU（観戦）' : `${n} 人が操作`;
      if (n > 0) {
        button.style.setProperty('--player-color', PLAYER_COLORS[n - 1]);
        button.title = `${PLAYER_NAMES.slice(0, n).join('・')} を操作する`;
      }
      button.addEventListener('click', () => {
        humanCount = n;
        draw();
      });
      humanRow.append(button);
    }

    const paramsGrid = panel.querySelector('#params')!;
    for (const spec of PARAM_SPECS) {
      const field = document.createElement('div');
      field.className = 'param-field';
      field.innerHTML = `
        <div class="param-head">
          <span class="param-label">${spec.label}</span>
          <span class="param-value" id="param-value-${spec.key}">${spec.hint(params[spec.key])}</span>
        </div>
        <input type="range" id="param-${spec.key}" min="${spec.min}" max="${spec.max}" step="${spec.step}" value="${params[spec.key]}" />
      `;
      const input = field.querySelector<HTMLInputElement>(`#param-${spec.key}`)!;
      const valueLabel = field.querySelector<HTMLElement>(`#param-value-${spec.key}`)!;
      input.addEventListener('input', () => {
        const value = Number(input.value);
        params[spec.key] = value;
        if (spec.key === 'bloodPool') bloodPoolTouched = true;
        valueLabel.textContent = spec.hint(value);
      });
      paramsGrid.append(field);
    }

    panel.querySelector('#params-reset')!.addEventListener('click', () => {
      const defaults = defaultConfig(playerCount);
      params.baseMove = defaults.baseMove;
      params.roundsPerNight = defaults.roundsPerNight;
      params.totalNights = defaults.totalNights;
      params.bloodPool = defaults.bloodPool;
      params.batsPerTurn = defaults.batsPerTurn;
      bloodPoolTouched = false;
      paramsOpen = true;
      draw();
    });

    panel.querySelector('#start')!.addEventListener('click', () => {
      const bots = Array.from({ length: playerCount }, (_, i) => i >= humanCount);
      const config = defaultConfig(playerCount, bots);
      config.baseMove = params.baseMove;
      config.roundsPerNight = params.roundsPerNight;
      config.totalNights = params.totalNights;
      config.bloodPool = params.bloodPool;
      config.batsPerTurn = params.batsPerTurn;
      config.seed = Math.floor(Math.random() * 1_000_000);
      onStart(config);
    });
  };

  draw();
}
