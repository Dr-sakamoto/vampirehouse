// 夜明けの乱闘（試作3）の入口。操作・HUD・調整つまみと、サーバー／クライアントの時計を回す。

import { LagChannel, LocalServer, PredictingClient, DT, type Snapshot } from './net';
import { DEFAULT_PARAMS, refugeOf, shadeCountFor, villagerInReach, type Input, type Params } from './sim';
import { BrawlView, colorOf, dawnOf, drawMinimap, lookForward, type Look, type ViewMode } from './view';
import './brawl.css';

const ME = 0;

interface Settings {
  params: Params;
  latencyMs: number;
  players: number;
  view: ViewMode;
}

// 地形を作り直したので、古い調整値（夜明けまでの時間など）は持ち越さない
// 既定値（突き飛ばし・廃墟の広さ）を変えたので、古い調整値は持ち越さない
const SETTINGS_KEY = 'vampirehouse-brawl-settings-v5';

function loadSettings(): Settings {
  const base: Settings = { params: { ...DEFAULT_PARAMS }, latencyMs: 0, players: 4, view: 'fps' };
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
  <div class="filter"></div>
  <div class="crosshair"></div>
  <canvas class="minimap"></canvas>
  <div class="hud">
    <div class="top">
      <div class="layout"></div>
      <div class="board"></div>
      <button class="viewbtn"></button>
      <button class="gear" aria-label="調整">⚙</button>
    </div>
    <div class="center"><div class="count"></div><div class="msg"></div></div>
  </div>
  <div class="stick-zone"><div class="stick-base"><div class="stick-knob"></div></div></div>
  <div class="look-zone"></div>
  <button class="suck">吸う</button>
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
const filterEl = root.querySelector<HTMLElement>('.filter')!;
const viewBtn = root.querySelector<HTMLButtonElement>('.viewbtn')!;

const view = new BrawlView(stage);
window.addEventListener('resize', () => view.resize());

function applyViewMode(): void {
  view.setMode(settings.view);
  root.classList.toggle('fps', settings.view === 'fps');
  viewBtn.textContent = settings.view === 'fps' ? '見下ろしへ' : '一人称へ';
  if (settings.view !== 'fps' && document.pointerLockElement) document.exitPointerLock();
}
viewBtn.addEventListener('click', () => {
  settings.view = settings.view === 'fps' ? 'top' : 'fps';
  saveSettings(settings);
  applyViewMode();
});
applyViewMode();

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
  // 一人称では左右の矢印は「向きを変える」に使うので、横歩きは A／D だけ
  const fps = settings.view === 'fps';
  const right = keys.has('KeyD') || (!fps && keys.has('ArrowRight'));
  const left = keys.has('KeyA') || (!fps && keys.has('ArrowLeft'));
  const x = (right ? 1 : 0) - (left ? 1 : 0);
  const y = (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0) - (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0);
  return { x, y };
}

// ---- 一人称の視線 ----------------------------------------------------------

const look: Look = { yaw: 0, pitch: -0.08 };
const PITCH_MIN = -0.7;
const PITCH_MAX = 0.6;

function turn(dYaw: number, dPitch: number): void {
  look.yaw += dYaw;
  look.pitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, look.pitch + dPitch));
}

// 右側をドラッグすると視点が回る。動かさずに短く触れて離せば突き飛ばし
// （視点を回している親指のまま押せるように）
const lookZone = root.querySelector<HTMLElement>('.look-zone')!;
const LOOK_SPEED = 0.006;
let lookPointer: number | null = null;
let lookLast = { x: 0, y: 0 };
let lookStart = { x: 0, y: 0, t: 0 };

lookZone.addEventListener('pointerdown', (e) => {
  lookPointer = e.pointerId;
  lookZone.setPointerCapture(e.pointerId);
  lookLast = { x: e.clientX, y: e.clientY };
  lookStart = { x: e.clientX, y: e.clientY, t: performance.now() };
});
lookZone.addEventListener('pointermove', (e) => {
  if (e.pointerId !== lookPointer) return;
  turn((e.clientX - lookLast.x) * LOOK_SPEED, -(e.clientY - lookLast.y) * LOOK_SPEED * 0.7);
  lookLast = { x: e.clientX, y: e.clientY };
});
const releaseLook = (e: PointerEvent): void => {
  if (e.pointerId !== lookPointer) return;
  lookPointer = null;
  const moved = Math.hypot(e.clientX - lookStart.x, e.clientY - lookStart.y);
  if (e.type === 'pointerup' && moved < 12 && performance.now() - lookStart.t < 250) shoveQueued = true;
};
lookZone.addEventListener('pointerup', releaseLook);
lookZone.addEventListener('pointercancel', releaseLook);

// PC: 画面をクリックするとマウスで視点を回せる（Esc で解除）。捕まえている間はクリックで突き飛ばし
stage.addEventListener('click', () => {
  if (settings.view === 'fps' && !document.pointerLockElement) stage.requestPointerLock?.();
});
document.addEventListener('mousemove', (e) => {
  if (document.pointerLockElement === stage) turn(e.movementX * 0.0025, -e.movementY * 0.0025);
});
document.addEventListener('mousedown', (e) => {
  if (document.pointerLockElement === stage && e.button === 0) shoveQueued = true;
});

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

// 吸うボタンは押している間ずっと吸う（夜の村でだけ出る）
const suckBtn = root.querySelector<HTMLButtonElement>('.suck')!;
let suckHeld = false;
suckBtn.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  suckBtn.setPointerCapture(e.pointerId);
  suckHeld = true;
  suckBtn.classList.add('pressed');
});
for (const ev of ['pointerup', 'pointercancel']) {
  suckBtn.addEventListener(ev, () => {
    suckHeld = false;
    suckBtn.classList.remove('pressed');
  });
}

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
let lookRound = -1;

function frame(now: number): void {
  acc += Math.min(0.25, (now - last) / 1000);
  last = now;

  // 新しい戦が始まったら、走り出す向き（村の外側）へ視線を戻す
  const meNow = client.world.players[ME];
  if (client.world.round !== lookRound) {
    lookRound = client.world.round;
    look.yaw = Math.atan2(meNow.fx, -meNow.fy);
    look.pitch = -0.08;
  }

  while (acc >= DT) {
    acc -= DT;
    const fps = settings.view === 'fps';
    if (fps) turn(((keys.has('ArrowRight') || keys.has('KeyE') ? 1 : 0) - (keys.has('ArrowLeft') || keys.has('KeyQ') ? 1 : 0)) * 2.4 * DT, 0);
    const kb = keyboardMove();
    let sx = Math.max(-1, Math.min(1, move.x + kb.x));
    let sy = Math.max(-1, Math.min(1, move.y + kb.y));
    let ax = 0;
    let ay = 0;
    if (fps) {
      // スティックの上＝見ている方向。右＝その右手
      const f = lookForward(look);
      const mx = f.x * -sy + -f.y * sx;
      const my = f.y * -sy + f.x * sx;
      sx = mx;
      sy = my;
      ax = f.x;
      ay = f.y;
    }
    const suck = suckHeld || keys.has('KeyF');
    const input = client.advance(sx, sy, ax, ay, shoveQueued, suck, settings.params);
    shoveQueued = false;
    up.send(input, now);

    for (const i of up.receive(now)) server.receive(ME, i);
    const snap = server.tick();
    if (snap) down.send(snap, now);
    const snaps = down.receive(now);
    if (snaps.length > 0) client.reconcile(snaps[snaps.length - 1], settings.params);
  }

  const world = client.world;
  view.render(world, settings.params, ME, look);
  drawMinimap(minimap, world, ME);
  updateHud();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/**
 * 画面全体の色。フォートナイトのストームのように、日なたにいる間は朝焼けの色が濃く被さる。
 * 影の中・自分の城では青く落ち着く。生死を分けるのは体の中心なので、その一点で判定する
 */
function updateFilter(): void {
  const world = client.world;
  const me = world.players[ME];
  let state = '';
  if (world.phase === 'run') state = refugeOf(me, world) ? 'shade' : 'sun';
  else if (world.phase === 'result' && !me.alive) state = 'burnt';
  filterEl.className = `filter ${state}`;
  const k = state === 'sun' ? 0.35 + dawnOf(world, settings.params) * 0.65 : 1;
  filterEl.style.setProperty('--k', k.toFixed(2));
  filterEl.classList.toggle('urgent', state === 'sun' && world.phaseLeft <= 3);
}

const crosshairEl = root.querySelector<HTMLElement>('.crosshair')!;

/** 突き飛ばしの待ち時間。ボタンが時計回りに満ちていき、満ちきったら押せる */
function updateShoveReady(): void {
  const me = client.world.players[ME];
  const ready = 1 - Math.min(1, me.shoveCd / Math.max(0.01, settings.params.shoveCooldown));
  shoveBtn.style.setProperty('--ready', `${(ready * 360).toFixed(0)}deg`);
  shoveBtn.classList.toggle('cooling', ready < 1);
  crosshairEl.classList.toggle('cooling', ready < 1);
}

function updateHud(): void {
  updateShoveReady();
  updateFilter();
  const world = client.world;
  const me = world.players[ME];
  const shades = shadeCountFor(world, settings.params);
  const blood = Math.floor(me.blood);
  layoutEl.textContent = `第${world.round}戦 ・ 影${shades}か所${settings.latencyMs > 0 ? ` ・ 遅延${settings.latencyMs}ms` : ''}`;
  root.classList.toggle('night', world.phase === 'village');
  suckBtn.classList.toggle('can', villagerInReach(world, me) >= 0);

  if (world.phase === 'village') {
    countEl.textContent = '';
    countEl.classList.remove('urgent');
    msgEl.textContent =
      me.sucking >= 0
        ? `吸っている…… 血 ${blood}dL`
        : villagerInReach(world, me) >= 0
          ? `血 ${blood}dL ―― 「吸う」を長押し`
          : `血 ${blood}dL ―― 村人に近づいて吸え。夜明けはいつ来るか分からない`;
  } else if (world.phase === 'run') {
    const left = Math.ceil(world.phaseLeft);
    countEl.textContent = String(left);
    countEl.classList.toggle('urgent', left <= 3);
    // 白んだ直後だけ、どこへ逃げるかを大きく出す
    msgEl.textContent =
      world.phaseLeft > settings.params.runTime - 1.5 ? `空が白んだ！ 血 ${blood}dL ―― 青い廃墟か、白枠の自分の城へ` : '';
  } else {
    countEl.textContent = '';
    const burnt = world.players.filter((p) => !p.alive).map((p) => p.name);
    const where = me.refuge === 'castle' ? '城に帰り着いた' : '影の中で生き延びた';
    msgEl.textContent = me.alive
      ? `${where}！ ＋${blood}dL${burnt.length > 0 ? ` ・ 焼けたのは ${burnt.join('、')}` : ''}`
      : `焼けた…… 血 ${blood}dL を失った`;
  }

  boardEl.innerHTML = world.players
    .map((p) => {
      const color = `#${colorOf(p.id).toString(16).padStart(6, '0')}`;
      const safe = world.phase !== 'result' && refugeOf(p, world) !== null;
      return `<span class="chip" style="--c:${color}">${p.name} ${Math.floor(p.score)}<small>${Math.floor(p.blood)}dL${safe ? ' ・安全' : ''}</small></span>`;
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
  { key: 'shoveCooldown', label: '突き飛ばしの待ち時間（秒）', min: 0, max: 3, step: 0.1 },
  { key: 'shoveReach', label: '手の届く距離（m）', min: 0.1, max: 2, step: 0.1 },
  { key: 'knockFriction', label: '勢いの止まりやすさ', min: 0.5, max: 12, step: 0.5 },
  { key: 'knockControl', label: '弾かれ中の踏ん張り（小さいほど流される）', min: 0.5, max: 20, step: 0.5 },
  { key: 'wallBounce', label: '壁の跳ね返り', min: 0, max: 1, step: 0.05 },
  { key: 'bloodMass', label: '血の重さ（満タンで＋）', min: 0, max: 4, step: 0.1 },
  { key: 'bloodSlow', label: '血による遅さ（満タンで）', min: 0, max: 0.8, step: 0.05 },
  { key: 'baseSpeed', label: '素の速さ（m/s）', min: 2, max: 10, step: 0.5 },
  { key: 'minSpeed', label: '最低速度（m/s）', min: 1, max: 8, step: 0.5 },
  { key: 'shelterSize', label: '廃墟の広さ（m）', min: 1.4, max: 5, step: 0.1 },
  { key: 'runTime', label: '夜明けまでの時間（秒）', min: 3, max: 15, step: 0.5 },
  { key: 'shadeCount', label: '影の落ちる廃墟の数（0＝人数の半分）', min: 0, max: 4, step: 1 },
  { key: 'suckRate', label: '吸う速さ（dL/秒）', min: 2, max: 30, step: 1 },
  { key: 'villagerBlood', label: '村人ひとりの血（dL）', min: 10, max: 150, step: 10 },
  { key: 'dawnMin', label: '夜が必ず続く時間（秒）', min: 0, max: 20, step: 1 },
  { key: 'dawnMean', label: 'その先、夜明けまでの平均（秒）', min: 1, max: 20, step: 1 },
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
    <p class="note">遅延・人数・廃墟の広さを変えると対戦をやり直す。影の数は次の戦から、ほかのつまみは次の瞬間から効く。一人称では、右側をドラッグで視点、右側を短くタップでも突き飛ばし。夜の村では「吸う」を長押し（PCは F キー）。PCでは WASD で移動、←→／Q・E で向きを変える（画面をクリックするとマウスで視点、クリックで突き飛ばし）、スペースで突き飛ばし。</p>
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
