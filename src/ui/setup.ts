import { BAT_ORDER, BAT_SPECS } from '../game/bats';
import { PLAYER_COLORS, PLAYER_NAMES, defaultConfig } from '../game/rules';
import type { GameConfig } from '../game/types';

export function renderSetup(root: HTMLElement, onStart: (config: GameConfig) => void): void {
  let playerCount = 2;
  let humanCount = 1;

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

    const countRow = panel.querySelector('#count')!;
    for (const n of [2, 3, 4]) {
      const button = document.createElement('button');
      button.className = `chip${n === playerCount ? ' is-on' : ''}`;
      button.textContent = `${n} 人`;
      button.addEventListener('click', () => {
        playerCount = n;
        humanCount = Math.min(humanCount, n);
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

    panel.querySelector('#start')!.addEventListener('click', () => {
      const bots = Array.from({ length: playerCount }, (_, i) => i >= humanCount);
      const config = defaultConfig(playerCount, bots);
      config.seed = Math.floor(Math.random() * 1_000_000);
      onStart(config);
    });
  };

  draw();
}
