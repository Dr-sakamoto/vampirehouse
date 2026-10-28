// 夜明けの乱闘（試作3）の入口。操作・HUD・調整つまみと、サーバー／クライアントの時計を回す。

import { LagChannel, LocalServer, PredictingClient, DT, type Snapshot } from './net';
import { DEFAULT_PARAMS, refugeOf, shadeCountFor, type Input, type Params } from './sim';
import { BrawlView, colorOf, drawMinimap } from './view';
import './brawl.css';

const ME = 0;

interface Settings {
  params: Params;
  latencyMs: number;
  players: number;
}

// 地形を作り直したので、古い調整値（夜明けまでの時間など）は持ち越さない
const SETTINGS_KEY = 'vampirehouse-brawl-settings-v2';

function loadSettings(): Settings {
  const base: Settings = { params: { ...DEFAULT_PARAMS }, latencyMs: 0, players: 4 };
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null') as Partial<Settings> | null;
    if (saved) return { ...base, ...saved, params: { ...base.params, ...saved.params } };
  } catch {
    // 保存できない環境でも既定値で遊べる
  }
  return base;
}

function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // 同上
  }
}

const settings = loadSettings();

const root = document.getElementById('brawl')!;
root.innerHTML = `
  <div class="stage"></div>
  <canvas class="minimap"></canvas>
  <div class="hud">
    <div class="top">
      <div class="layout"></div>
      <div class="board"></div>
      <button class="gear" aria-label="調整">⚙</button>
    </div>
    <div class="center"><div class="count"></div><div class="msg"></div></div>
  </div>
  <div class="stick-zone"><div class="stick-base"><div class="stick-knob"></div></div></div>
  <button class="shove">突き<br>飛ばし</button>
  <div class="panel" hidden></div>
`;

const stage = root.querySelector<HTMLElement>('.stage')!;
const countEl = root.querySelector<HTMLElement>('.count')!;
const msgEl = root.querySelector<HTMLElement>('.msg')!;
const boardEl = root.querySelector<HTMLElement>('.board')!;
const layoutEl = root.querySelector<HTMLElement>('.layout')!;
const panel = root.querySelector<HTMLElement>('.panel')!;
const minimap = root.querySelector<HTMLCanvasElement>('.minimap')!;

const view = new BrawlView(stage);
window.addEventListener('resize', () => view.resize());

// ---- 入力 ----------------------------------------------------------------

const move = { x: 0, y: 0 };
let shoveQueued = false;
const keys = new Set<string>();

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    if (!e.repeat) shoveQueued = true;
    e.preventDefault();
  }
  keys.add(e.code);
});
window.addEventListener('keyup', (e) => keys.delete(e.code));

function keyboardMove(): { x: number; y: number } {
  const x = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
  const y = (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0) - (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0);
  return { x, y };
}

// 左半分のどこに触れても、そこを中心にスティックが出る
const zone = root.querySelector<HTMLElement>('.stick-zone')!;
const base = root.querySelector<HTMLElement>('.stick-base')!;
const knob = root.querySelector<HTMLElement>('.stick-knob')!;
const STICK_RADIUS = 56;
let stickPointer: number | null = null;
let origin = { x: 0, y: 0 };

zone.addEventListener('pointerdown', (e) => {
  stickPointer = e.pointerId;
  zone.setPointerCapture(e.pointerId);
  origin = { x: e.clientX, y: e.clientY };
  base.style.left = `${e.clientX}px`;
  base.style.top = `${e.clientY}px`;
  base.classList.add('active');
  updateStick(e);
});
zone.addEventListener('pointermove', (e) => {
  if (e.pointerId === stickPointer) updateStick(e);
});
const releaseStick = (e: PointerEvent): void => {
  if (e.pointerId !== stickPointer) return;
  stickPointer = null;
  move.x = 0;
  move.y = 0;
  knob.style.transform = '';
  base.classList.remove('active');
};
zone.addEventListener('pointerup', releaseStick);
zone.addEventListener('pointercancel', releaseStick);

function updateStick(e: PointerEvent): void {
  const dx = e.clientX - origin.x;
  const dy = e.clientY - origin.y;
  const len = Math.hypot(dx, dy);
  const clamped = Math.min(len, STICK_RADIUS);
  const ux = len > 0 ? dx / len : 0;
  const uy = len > 0 ? dy / len : 0;
  knob.style.transform = `translate(${ux * clamped}px, ${uy * clamped}px)`;
  // 画面の上＝奥（-y）なので、そのまま写せばよい
  const strength = clamped < 8 ? 0 : clamped / STICK_RADIUS;
  move.x = ux * strength;
  move.y = uy * strength;
}

const shoveBtn = root.querySelector<HTMLButtonElement>('.shove')!;
shoveBtn.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  shoveQueued = true;
  shoveBtn.classList.add('pressed');
});
for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) {
  shoveBtn.addEventListener(ev, () => shoveBtn.classList.remove('pressed'));
}
document.addEventListener('contextmenu', (e) => e.preventDefault());

// ---- サーバーとクライアント ------------------------------------------------

let server!: LocalServer;
let client!: PredictingClient;
let up!: LagChannel<Input>;
let down!: LagChannel<Snapshot>;

function restart(): void {
  server = new LocalServer(settings.players, settings.params);
  client = new PredictingClient(ME, server.world);
  up = new LagChannel<Input>(settings.latencyMs / 2);
  down = new LagChannel<Snapshot>(settings.latencyMs / 2);
}
restart();

let last = performance.now();
let acc = 0;

function frame(now: number): void {
  acc += Math.min(0.25, (now - last) / 1000);
  last = now;

  while (acc >= DT) {
    acc -= DT;
    const kb = keyboardMove();
    const mx = Math.max(-1, Math.min(1, move.x + kb.x));
    const my = Math.max(-1, Math.min(1, move.y + kb.y));
    const input = client.advance(mx, my, shoveQueued, settings.params);
    shoveQueued = false;
    up.send(input, now);

    for (const i of up.receive(now)) server.receive(ME, i);
    const snap = server.tick();
    if (snap) down.send(snap, now);
    const snaps = down.receive(now);
    if (snaps.length > 0) client.reconcile(snaps[snaps.length - 1], settings.params);
  }

  const world = client.world;
  view.render(world, settings.params, ME);
  drawMinimap(minimap, world, ME);
  updateHud();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

function updateHud(): void {
  const world = client.world;
  const me = world.players[ME];
  const shades = shadeCountFor(world, settings.params);
  layoutEl.textContent = `第${world.round}戦 ・ 影${shades}か所${settings.latencyMs > 0 ? ` ・ 遅延${settings.latencyMs}ms` : ''}`;

  if (world.phase === 'ready') {
    countEl.textContent = '';
    msgEl.textContent = `血 ${me.blood}dL ―― 雲が切れた。青い廃墟か、白枠の自分の城へ`;
  } else if (world.phase === 'run') {
    const left = Math.ceil(world.phaseLeft);
    countEl.textContent = String(left);
    countEl.classList.toggle('urgent', left <= 3);
    msgEl.textContent = '';
  } else {
    countEl.textContent = '';
    const burnt = world.players.filter((p) => !p.alive).map((p) => p.name);
    const where = me.refuge === 'castle' ? '城に帰り着いた' : '影の中で生き延びた';
    msgEl.textContent = me.alive
      ? `${where}！ ＋${me.blood}dL${burnt.length > 0 ? ` ・ 焼けたのは ${burnt.join('、')}` : ''}`
      : `焼けた…… 血 ${me.blood}dL を失った`;
  }

  boardEl.innerHTML = world.players
    .map((p) => {
      const color = `#${colorOf(p.id).toString(16).padStart(6, '0')}`;
      const safe = world.phase !== 'result' && refugeOf(p, world) !== null;
      return `<span class="chip" style="--c:${color}">${p.name} ${p.score}<small>${p.blood}dL${safe ? ' ・安全' : ''}</small></span>`;
    })
    .join('');
}

// ---- 調整つまみ ------------------------------------------------------------

interface Knob {
  key: keyof Params;
  label: string;
  min: number;
  max: number;
  step: number;
}

const KNOBS: Knob[] = [
  { key: 'shoveForce', label: '突き飛ばしの強さ', min: 2, max: 25, step: 0.5 },
  { key: 'shoveCooldown', label: '連打の間隔（秒）', min: 0.05, max: 1, step: 0.05 },
  { key: 'shoveReach', label: '手の届く距離（m）', min: 0.1, max: 2, step: 0.1 },
  { key: 'knockFriction', label: '勢いの止まりやすさ', min: 0.5, max: 12, step: 0.5 },
  { key: 'wallBounce', label: '壁の跳ね返り', min: 0, max: 1, step: 0.05 },
  { key: 'bloodMass', label: '血の重さ（満タンで＋）', min: 0, max: 4, step: 0.1 },
  { key: 'bloodSlow', label: '血による遅さ（満タンで）', min: 0, max: 0.8, step: 0.05 },
  { key: 'baseSpeed', label: '素の速さ（m/s）', min: 2, max: 10, step: 0.5 },
  { key: 'minSpeed', label: '最低速度（m/s）', min: 1, max: 8, step: 0.5 },
  { key: 'shelterSize', label: '廃墟の広さ（m）', min: 1.4, max: 5, step: 0.1 },
  { key: 'runTime', label: '夜明けまでの時間（秒）', min: 3, max: 15, step: 0.5 },
  { key: 'shadeCount', label: '影の落ちる廃墟の数（0＝人数の半分）', min: 0, max: 8, step: 1 },
];

function renderPanel(): void {
  const row = (label: string, control: string, value: string): string =>
    `<label><span>${label}</span>${control}<output>${value}</output></label>`;
  panel.innerHTML = `
    <h2>調整</h2>
    ${row(
      '通信の遅延（往復）',
      `<input type="range" data-k="latency" min="0" max="400" step="50" value="${settings.latencyMs}">`,
      `${settings.latencyMs}ms`,
    )}
    ${row(
      '人数（あなた＋ボット）',
      `<input type="range" data-k="players" min="2" max="4" step="1" value="${settings.players}">`,
      `${settings.players}人`,
    )}
    ${KNOBS.map((k) =>
      row(
        k.label,
        `<input type="range" data-k="${k.key}" min="${k.min}" max="${k.max}" step="${k.step}" value="${settings.params[k.key]}">`,
        String(settings.params[k.key]),
      ),
    ).join('')}
    <div class="buttons">
      <button data-act="reset">既定値に戻す</button>
      <button data-act="close">閉じる</button>
    </div>
    <p class="note">遅延・人数・廃墟の広さを変えると対戦をやり直す。影の数は次の戦から、ほかのつまみは次の瞬間から効く。PCでは WASD／矢印キーで移動、スペースで突き飛ばし。</p>
  `;
}

panel.addEventListener('input', (e) => {
  const el = e.target as HTMLInputElement;
  const k = el.dataset.k;
  if (!k) return;
  if (k === 'latency') settings.latencyMs = Number(el.value);
  else if (k === 'players') settings.players = Number(el.value);
  else settings.params[k as keyof Params] = Number(el.value);

  const out = el.parentElement?.querySelector('output');
  if (out) out.textContent = k === 'latency' ? `${el.value}ms` : k === 'players' ? `${el.value}人` : el.value;
  if (k === 'latency' || k === 'players' || k === 'shelterSize') restart();
  saveSettings(settings);
});

panel.addEventListener('click', (e) => {
  const act = (e.target as HTMLElement).dataset.act;
  if (act === 'close') panel.hidden = true;
  if (act === 'reset') {
    settings.params = { ...DEFAULT_PARAMS };
    saveSettings(settings);
    renderPanel();
    restart();
  }
});

root.querySelector('.gear')!.addEventListener('click', () => {
  renderPanel();
  panel.hidden = !panel.hidden;
});
