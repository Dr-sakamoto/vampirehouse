// Three.js による描画。円柱の吸血鬼と箱の壁だけの、グレーボックスの見た目。
// 判定の平面 (x, y) は、3D空間の地面 (x, z) にそのまま写す。
// 視点は2つ: 自分を追う見下ろし（top）と、吸血鬼の目線（fps）。どちらもカメラは自分に付いて回る。
// 一人称では盤面を俯瞰できないぶん、空の白み方・雲・光の柱・城の旗で、時間と行き先を読ませる。

import * as THREE from 'three';
import { ARENA_HALF, VILLAGE_RADIUS, type Wall } from './map';
import { BLOOD_MAX, PLAYER_RADIUS, refugeOf, type Params, type World } from './sim';

export type ViewMode = 'top' | 'fps';

export const PLAYER_COLORS = [0xe8e2f4, 0x6fa8ff, 0x7be08a, 0xffb347];
const BODY_HEIGHT = 1.4;
/** 一人称の目の高さ。廃墟の壁も岩もこれより低い */
const EYE_HEIGHT = 1.3;
/** 見下ろし視点で、画面の狭いほうの辺に収める半径（m） */
const VIEW_RADIUS = 9;
/** 見下ろし視点の、地面から見下ろす角度 */
const CAMERA_TILT = THREE.MathUtils.degToRad(62);
/** 影を落とす雲の高さ */
const CLOUD_HEIGHT = 8;

// 空が見えるよう、廃墟の壁は目線より低くしてある（中で押し合う相手も見える）
// 岩も目線より低い。障害物で視界が塞がらないようにしてある
const WALL_HEIGHT: Record<Wall['kind'], number> = { outer: 0.5, rock: 1.0, ruin: 1.1, castle: 2.4, tree: 2.0 };

const SHADE_COLOR = 0x2a8fc4;
const RUIN_FLOOR = 0x3a3644;

/** 夜と、日の出直前の空。dawn（0〜1）で補間する */
const SKY = {
  nightTop: new THREE.Color(0.02, 0.03, 0.08),
  nightHorizon: new THREE.Color(0.08, 0.08, 0.18),
  dawnTop: new THREE.Color(0.28, 0.48, 0.78),
  dawnHorizon: new THREE.Color(1.0, 0.6, 0.32),
};

const SKY_VERTEX = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SKY_FRAGMENT = /* glsl */ `
  uniform vec3 top;
  uniform vec3 horizon;
  uniform vec3 sunColor;
  uniform vec3 sunDir;
  uniform float glow;
  varying vec3 vDir;
  void main() {
    vec3 d = normalize(vDir);
    vec3 c = mix(horizon, top, smoothstep(-0.02, 0.45, d.y));
    float s = max(dot(d, sunDir), 0.0);
    // 東の地平線がにじむ光と、昇ってくる日の玉
    c += sunColor * (pow(s, 6.0) * glow * 0.7 + pow(s, 600.0) * 3.0 * glow);
    // 地平線より下は暗く沈める
    c = mix(horizon * 0.3, c, smoothstep(-0.08, 0.0, d.y));
    gl_FragColor = vec4(c, 1.0);
  }
`;

interface PlayerMesh {
  group: THREE.Group;
  body: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshStandardMaterial>;
  blood: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>;
  dot: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>;
  nose: THREE.Mesh;
  ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
}

/** 一人称の視線。yaw は北（-y）を0として右回り、pitch は上向きが正 */
export interface Look {
  yaw: number;
  pitch: number;
}

export function lookForward(look: Look): { x: number; y: number } {
  return { x: Math.sin(look.yaw), y: -Math.cos(look.yaw) };
}

export function colorOf(id: number): number {
  return PLAYER_COLORS[id % PLAYER_COLORS.length];
}

/** 0〜1。空が白んでから朝までの進み具合。夜の村では0（いつ白むかは空を見ても分からない） */
export function dawnOf(world: World, params: Params): number {
  const left = world.phase === 'run' ? world.phaseLeft / params.runTime : world.phase === 'village' ? 1 : 0;
  return 1 - Math.max(0, Math.min(1, left));
}

export class BrawlView {
  readonly renderer: THREE.WebGLRenderer;
  private mode: ViewMode = 'fps';
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(40, 1, 0.05, 300);
  private camDist = 20;
  private camTarget = new THREE.Vector3();
  private sun = new THREE.DirectionalLight(0xffffff, 0.6);
  private ambient = new THREE.AmbientLight(0x8080b0, 0.7);
  private fog = new THREE.Fog(0x000000, 14, 60);
  private sky: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  private ground: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>;
  private terrain = new THREE.Group();
  private terrainKey = '';
  private ruinFloors: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>[] = [];
  private skyClouds: THREE.Mesh[] = [];
  private beams: THREE.Mesh[] = [];
  private players: PlayerMesh[] = [];
  private villagers: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshStandardMaterial>[] = [];
  /** 吸っている者と村人を結ぶ赤い筋（吸血鬼ごとに1本） */
  private suckLines: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>[] = [];

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);

    this.scene.fog = this.fog;
    this.scene.add(this.ambient, this.sun, this.sun.target, this.terrain);

    this.sky = new THREE.Mesh(
      new THREE.SphereGeometry(150, 32, 16),
      new THREE.ShaderMaterial({
        vertexShader: SKY_VERTEX,
        fragmentShader: SKY_FRAGMENT,
        uniforms: {
          top: { value: new THREE.Color() },
          horizon: { value: new THREE.Color() },
          sunColor: { value: new THREE.Color(1, 0.6, 0.3) },
          sunDir: { value: new THREE.Vector3(1, 0, 0) },
          glow: { value: 0 },
        },
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
      }),
    );
    this.sky.renderOrder = -1;
    this.scene.add(this.sky);

    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(ARENA_HALF * 6, ARENA_HALF * 6),
      new THREE.MeshStandardMaterial({ color: 0x2a2734 }),
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.scene.add(this.ground);

    const plaza = new THREE.Mesh(
      new THREE.CircleGeometry(VILLAGE_RADIUS, 48),
      new THREE.MeshBasicMaterial({ color: 0x4a1f26, transparent: true, opacity: 0.6 }),
    );
    plaza.rotation.x = -Math.PI / 2;
    plaza.position.y = 0.005;
    this.scene.add(plaza);

    this.resize();
  }

  setMode(mode: ViewMode): void {
    this.mode = mode;
    this.resize();
  }

  resize(): void {
    const el = this.renderer.domElement.parentElement!;
    const w = el.clientWidth;
    const h = el.clientHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    if (this.mode === 'fps') {
      // 縦持ちでも左右が見えるよう、狭い画面ほど縦の画角を広げる
      this.camera.fov = w < h ? 90 : 70;
    } else {
      // 狭いほうの画角で、自分のまわり VIEW_RADIUS が収まる距離まで引く
      this.camera.fov = 40;
      const half = THREE.MathUtils.degToRad(this.camera.fov / 2);
      const halfH = Math.atan(Math.tan(half) * this.camera.aspect);
      this.camDist = VIEW_RADIUS / Math.sin(Math.min(half, halfH));
    }
    this.camera.updateProjectionMatrix();
  }

  render(world: World, params: Params, meId: number, look: Look): void {
    this.syncTerrain(world);
    this.syncPlayers(world);
    this.syncVillagers(world);
    const me = world.players[meId];
    const fps = this.mode === 'fps';

    if (fps) {
      // 弾き飛ばされている間は視界が揺れる
      const knock = Math.min(1, Math.hypot(me.kx, me.ky) / 8);
      const shake = knock * 0.12;
      const f = lookForward(look);
      const eye = new THREE.Vector3(
        me.x + (Math.random() - 0.5) * shake,
        EYE_HEIGHT + (Math.random() - 0.5) * shake,
        me.y + (Math.random() - 0.5) * shake,
      );
      this.camera.position.copy(eye);
      this.camTarget.set(me.x, 0, me.y);
      const cp = Math.cos(look.pitch);
      this.camera.lookAt(eye.x + f.x * cp, eye.y + Math.sin(look.pitch), eye.z + f.y * cp);
    } else {
      // 自分を追う。ただし闘技場の外は映しすぎないよう少し内側へ寄せる
      const limit = ARENA_HALF - VIEW_RADIUS * 0.6;
      const tx = THREE.MathUtils.clamp(me.x, -limit, limit);
      const tz = THREE.MathUtils.clamp(me.y, -limit, limit);
      this.camTarget.lerp(new THREE.Vector3(tx, 0, tz), world.phase === 'village' ? 0.3 : 0.12);
      this.camera.position.set(
        this.camTarget.x,
        Math.sin(CAMERA_TILT) * this.camDist,
        this.camTarget.z + Math.cos(CAMERA_TILT) * this.camDist,
      );
      this.camera.lookAt(this.camTarget.x, 0, this.camTarget.z - 0.6);
    }

    this.updateSky(dawnOf(world, params), fps);

    world.ruins.forEach((r, i) => {
      this.ruinFloors[i].material.color.setHex(r.shaded ? SHADE_COLOR : RUIN_FLOOR);
      // 空の雲と光の柱は一人称でだけ見せる（見下ろしでは画面を塞いでしまう）
      this.skyClouds[i].visible = r.shaded && fps;
      this.beams[i].visible = r.shaded && fps;
    });

    for (const p of world.players) {
      const m = this.players[p.id];
      // 一人称では自分の体は描かない（目の中に円柱が入ってしまう）
      m.group.visible = !(fps && p.id === meId);
      m.group.position.set(p.x, 0, p.y);
      m.group.rotation.y = Math.atan2(p.fx, p.fy);

      const burnt = world.phase === 'result' && !p.alive;
      m.body.material.color.setHex(burnt ? 0x3a3a3a : colorOf(p.id));
      m.body.scale.y = burnt ? 0.2 : 1;
      m.body.position.y = (BODY_HEIGHT * m.body.scale.y) / 2;

      // 抱えた血は頭の上の赤い円盤の大きさで見せる（満タンを超えると体よりはみ出す）
      const b = Math.min(1.6, p.blood / BLOOD_MAX);
      m.blood.visible = !burnt && b > 0;
      m.blood.scale.set(0.2 + b * 0.8, 1, 0.2 + b * 0.8);
      m.blood.position.y = BODY_HEIGHT * m.body.scale.y + 0.05;

      // 足元の点：体の中心が安全な場所なら青、外なら赤。生死はこの一点で決まる
      m.dot.material.color.setHex(refugeOf(p, world) ? 0x35d0f5 : 0xff4040);
      m.ring.visible = p.id === meId;

      const shoved = world.shoves.some((s) => s.from === p.id && world.tick - s.tick < 8);
      m.nose.scale.setScalar(shoved ? 1.8 : 1);

      // 吸っている間は、村人との間に赤い筋を張る。誰がどれだけ欲張っているかが見える
      const line = this.suckLines[p.id];
      const v = p.sucking >= 0 ? world.villagers[p.sucking] : undefined;
      line.visible = !!v;
      if (v) {
        const from = new THREE.Vector3(p.x, 1.0, p.y);
        const to = new THREE.Vector3(v.x, 1.1, v.y);
        line.position.copy(from).lerp(to, 0.5);
        line.lookAt(to);
        line.scale.set(1, 1, Math.max(0.01, from.distanceTo(to)));
      }
    }

    // 村人は吸われるほど青ざめ、吸い尽くされると倒れる
    world.villagers.forEach((v, i) => {
      const m = this.villagers[i];
      m.visible = true;
      const left = Math.max(0, Math.min(1, v.blood / Math.max(1, params.villagerBlood)));
      m.material.color.setRGB(0.55 + left * 0.3, 0.55 + left * 0.21, 0.6 + left * 0.04);
      if (v.blood <= 0) {
        m.rotation.set(0, 0, Math.PI / 2);
        m.position.set(v.x, 0.28, v.y);
      } else {
        m.rotation.set(0, 0, 0);
        m.position.set(v.x, 0.8, v.y);
      }
    });
    for (let i = world.villagers.length; i < this.villagers.length; i++) this.villagers[i].visible = false;

    this.renderer.render(this.scene, this.camera);
  }

  private syncVillagers(world: World): void {
    while (this.villagers.length < world.villagers.length) {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.3, 1.6, 12), new THREE.MeshStandardMaterial({ color: 0xd9c2a3 }));
      this.scene.add(m);
      this.villagers.push(m);
    }
    while (this.suckLines.length < world.players.length) {
      const geo = new THREE.CylinderGeometry(0.05, 0.05, 1, 6);
      // 筒の向きを z 軸に寝かせておき、lookAt で村人へ向ける
      geo.rotateX(Math.PI / 2);
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xff2a3a }));
      m.visible = false;
      this.scene.add(m);
      this.suckLines.push(m);
    }
  }

  /** 夜空から、東（+x）の地平線が白んで日が昇るまで。地面の明るさと霧の色も空に合わせる */
  private updateSky(dawn: number, fps: boolean): void {
    const u = this.sky.material.uniforms;
    const top = (u.top.value as THREE.Color).copy(SKY.nightTop).lerp(SKY.dawnTop, dawn);
    const horizon = (u.horizon.value as THREE.Color).copy(SKY.nightHorizon).lerp(SKY.dawnHorizon, dawn);
    const sunDir = (u.sunDir.value as THREE.Vector3).set(1, -0.1 + dawn * 0.22, 0.15).normalize();
    (u.sunColor.value as THREE.Color).setRGB(1, 0.55 + dawn * 0.35, 0.25 + dawn * 0.45);
    u.glow.value = 0.15 + dawn * 1.1;
    this.sky.position.copy(this.camera.position);

    this.scene.background = top;
    this.fog.color.copy(horizon).multiplyScalar(0.55);
    this.fog.near = fps ? 14 : 80;
    this.fog.far = fps ? 60 : 160;

    this.ground.material.color.setRGB(0.16 + dawn * 0.75, 0.15 + dawn * 0.45, 0.2 + dawn * 0.05);
    this.sun.intensity = 0.4 + dawn * 1.6;
    this.sun.color.setRGB(1, 0.7 + dawn * 0.25, 0.55 + dawn * 0.4);
    this.sun.target.position.copy(this.camTarget);
    this.sun.position.copy(this.camTarget).addScaledVector(new THREE.Vector3(sunDir.x, Math.max(0.35, sunDir.y), sunDir.z), 30);
    this.ambient.intensity = 0.55 + dawn * 0.3;
  }

  /** 地形は廃墟の広さが変わったときだけ組み直す（影の落ち方は毎フレーム表示を切り替える） */
  private syncTerrain(world: World): void {
    const key = `${world.ruins[0]?.half}`;
    if (key === this.terrainKey) return;
    this.terrainKey = key;
    for (const child of [...this.terrain.children]) {
      this.terrain.remove(child);
      (child as THREE.Mesh).geometry?.dispose();
    }
    this.ruinFloors = [];
    this.skyClouds = [];
    this.beams = [];

    const floor = (x: number, z: number, size: number, color: number, y = 0.01) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ color }));
      m.rotation.x = -Math.PI / 2;
      m.position.set(x, y, z);
      this.terrain.add(m);
      return m;
    };

    const cloudMat = new THREE.MeshStandardMaterial({ color: 0x5a5868, roughness: 1 });
    const beamMat = new THREE.MeshBasicMaterial({
      color: 0x35d0f5,
      transparent: true,
      opacity: 0.35,
      // 足し合わせて光らせる。朝焼けの赤い色被せの上でも青が残るように
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    for (const r of world.ruins) {
      // 影として見せるのは廃墟の床そのもの。見えている影と、助かる範囲がぴったり一致する
      this.ruinFloors.push(floor(r.cx, r.cy, r.half * 2, RUIN_FLOOR));

      // 真上に浮かぶ雲と、そこから廃墟へ降りる青い光の柱。遠くからでも見える
      const cloud = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 12), cloudMat);
      cloud.scale.set(r.half * 3.2, 1.3, r.half * 2.6);
      cloud.position.set(r.cx, CLOUD_HEIGHT, r.cy);
      this.terrain.add(cloud);
      this.skyClouds.push(cloud);
      // 光の柱も床と同じ四角（4面の筒を45度回す）。柱の中にいれば助かる
      const side = r.half * Math.SQRT2;
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(side, side, CLOUD_HEIGHT, 4, 1, true), beamMat);
      beam.rotation.y = Math.PI / 4;
      beam.position.set(r.cx, CLOUD_HEIGHT / 2, r.cy);
      this.terrain.add(beam);
      this.beams.push(beam);
    }

    for (const c of world.castles) {
      const color = new THREE.Color(colorOf(c.owner)).multiplyScalar(0.35);
      floor(c.cx, c.cy, c.half * 2, color.getHex());
      // 城の旗。持ち主の色で、遠くからでも自分の城の方角が分かる
      const poleX = c.cx + Math.sign(c.cx) * (c.half + 0.3);
      const poleZ = c.cy + Math.sign(c.cy) * (c.half + 0.3);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 7, 8), new THREE.MeshStandardMaterial({ color: 0x9a94ac }));
      pole.position.set(poleX, 3.5, poleZ);
      const flag = new THREE.Mesh(
        new THREE.BoxGeometry(1.6, 0.9, 0.06),
        new THREE.MeshBasicMaterial({ color: colorOf(c.owner), fog: false }),
      );
      flag.position.set(poleX - Math.sign(c.cx) * 0.85, 6.5, poleZ);
      this.terrain.add(pole, flag);
    }

    const mats = new Map<string, THREE.Material>();
    const mat = (key: string, color: number): THREE.Material => {
      let m = mats.get(key);
      if (!m) {
        m = new THREE.MeshStandardMaterial({ color });
        mats.set(key, m);
      }
      return m;
    };
    for (const w of world.walls) {
      if (w.kind === 'rock') {
        // 低く平たい岩。上から向こうが見える
        const rock = new THREE.Mesh(new THREE.IcosahedronGeometry(w.r, 0), mat('rock', 0x6e6878));
        rock.scale.y = WALL_HEIGHT.rock / (w.r * 1.6);
        rock.position.set(w.ax, WALL_HEIGHT.rock * 0.4, w.ay);
        rock.rotation.y = w.ax * 1.7 + w.ay;
        this.terrain.add(rock);
        continue;
      }
      if (w.kind === 'tree') {
        // 細い幹と、頭より上の葉。目線の高さはほとんど塞がない
        const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.24, WALL_HEIGHT.tree, 8), mat('trunk', 0x4a3a2c));
        trunk.position.set(w.ax, WALL_HEIGHT.tree / 2, w.ay);
        // 葉は小さめに。大きいと見下ろしでは下にいる者を隠し、一人称では空を塞ぐ
        const leaves = new THREE.Mesh(new THREE.ConeGeometry(0.8, 1.8, 8), mat('leaves', 0x2f5d3a));
        leaves.position.set(w.ax, WALL_HEIGHT.tree + 0.8, w.ay);
        this.terrain.add(trunk, leaves);
        continue;
      }
      const height = WALL_HEIGHT[w.kind];
      const color =
        w.kind === 'castle'
          ? new THREE.Color(colorOf(w.owner ?? 0)).multiplyScalar(0.55).getHex()
          : w.kind === 'outer'
            ? 0x3b3748
            : 0x8a8296;
      const material = mat(`${w.kind}:${w.owner ?? ''}`, color);
      const len = Math.hypot(w.bx - w.ax, w.by - w.ay);
      const mesh =
        len < 1e-6
          ? new THREE.Mesh(new THREE.CylinderGeometry(w.r, w.r, height, 12), material)
          : new THREE.Mesh(new THREE.BoxGeometry(len + w.r * 2, height, w.r * 2), material);
      mesh.position.set((w.ax + w.bx) / 2, height / 2, (w.ay + w.by) / 2);
      mesh.rotation.y = -Math.atan2(w.by - w.ay, w.bx - w.ax);
      this.terrain.add(mesh);
    }
  }

  private syncPlayers(world: World): void {
    while (this.players.length < world.players.length) {
      const id = this.players.length;
      const group = new THREE.Group();
      const body = new THREE.Mesh(
        new THREE.CylinderGeometry(PLAYER_RADIUS, PLAYER_RADIUS, BODY_HEIGHT, 24),
        new THREE.MeshStandardMaterial({ color: colorOf(id) }),
      );
      const blood = new THREE.Mesh(
        new THREE.CylinderGeometry(PLAYER_RADIUS, PLAYER_RADIUS, 0.1, 24),
        new THREE.MeshBasicMaterial({ color: 0xe63946 }),
      );
      const dot = new THREE.Mesh(new THREE.CircleGeometry(0.14, 16), new THREE.MeshBasicMaterial());
      dot.rotation.x = -Math.PI / 2;
      dot.position.y = 0.03;
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(PLAYER_RADIUS + 0.08, PLAYER_RADIUS + 0.2, 32),
        new THREE.MeshBasicMaterial({ color: 0xffffff }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.02;
      // 向きを示す鼻先。突き飛ばした瞬間だけ膨らむ
      const nose = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.25, 0.35), new THREE.MeshStandardMaterial({ color: 0x222222 }));
      nose.position.set(0, 0.9, PLAYER_RADIUS + 0.1);
      group.add(body, blood, dot, ring, nose);
      this.scene.add(group);
      this.players.push({ group, body, blood, dot, nose, ring });
    }
  }
}

/** 画面の隅の全体図。影の落ちた廃墟・自分の城・全員の位置と、自分の向きだけを描く */
export function drawMinimap(canvas: HTMLCanvasElement, world: World, meId: number): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = Math.min(window.devicePixelRatio, 2);
  const size = canvas.clientWidth;
  if (canvas.width !== size * dpr) {
    canvas.width = size * dpr;
    canvas.height = size * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const s = size / (ARENA_HALF * 2);
  const X = (x: number): number => (x + ARENA_HALF) * s;

  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = 'rgba(20, 19, 26, 0.8)';
  ctx.fillRect(0, 0, size, size);

  ctx.strokeStyle = 'rgba(154, 148, 172, 0.45)';
  ctx.lineWidth = 1;
  for (const w of world.walls) {
    if (w.kind === 'tree' || w.kind === 'outer') continue;
    ctx.beginPath();
    ctx.moveTo(X(w.ax), X(w.ay));
    ctx.lineTo(X(w.bx) + 0.01, X(w.by));
    ctx.stroke();
  }
  for (const r of world.ruins) {
    if (!r.shaded) continue;
    ctx.fillStyle = '#35d0f5';
    ctx.fillRect(X(r.cx - r.half), X(r.cy - r.half), r.half * 2 * s, r.half * 2 * s);
  }
  const own = world.castles[meId];
  if (own) {
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(X(own.cx - own.half), X(own.cy - own.half), own.half * 2 * s, own.half * 2 * s);
  }
  for (const p of world.players) {
    ctx.fillStyle = `#${colorOf(p.id).toString(16).padStart(6, '0')}`;
    ctx.beginPath();
    ctx.arc(X(p.x), X(p.y), p.id === meId ? 3.5 : 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
  // 自分の向き
  const me = world.players[meId];
  if (me) {
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(X(me.x), X(me.y));
    ctx.lineTo(X(me.x + me.fx * 3), X(me.y + me.fy * 3));
    ctx.stroke();
  }
}
