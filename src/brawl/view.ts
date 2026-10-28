// Three.js による描画。円柱の吸血鬼と箱の壁だけの、グレーボックスの見た目。
// 判定の平面 (x, y) は、3D空間の地面 (x, z) にそのまま写す。カメラは自分を追う（プレイヤーは操作しない）。

import * as THREE from 'three';
import { ARENA_HALF, VILLAGE_RADIUS, type Wall } from './map';
import { BLOOD_MAX, PLAYER_RADIUS, refugeOf, type Params, type World } from './sim';

export const PLAYER_COLORS = [0xe8e2f4, 0x6fa8ff, 0x7be08a, 0xffb347];
const BODY_HEIGHT = 1.4;
/** 画面の狭いほうの辺に収める半径（m）。自分のまわりがこれだけ見える */
const VIEW_RADIUS = 9;
/** 地面から見下ろす角度 */
const CAMERA_TILT = THREE.MathUtils.degToRad(62);

const WALL_HEIGHT: Record<Wall['kind'], number> = { outer: 0.5, house: 2.4, ruin: 1.6, castle: 2.6, tree: 2.2 };

const SHADE_COLOR = 0x2a8fc4;
const RUIN_FLOOR = 0x3a3644;

interface PlayerMesh {
  group: THREE.Group;
  body: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshStandardMaterial>;
  blood: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>;
  dot: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>;
  nose: THREE.Mesh;
  ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
}

export function colorOf(id: number): number {
  return PLAYER_COLORS[id % PLAYER_COLORS.length];
}

export class BrawlView {
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(40, 1, 0.1, 200);
  private camDist = 20;
  private camTarget = new THREE.Vector3();
  private sun = new THREE.DirectionalLight(0xffffff, 0.6);
  private ambient = new THREE.AmbientLight(0x8080b0, 0.7);
  private ground: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>;
  private terrain = new THREE.Group();
  private terrainKey = '';
  private ruinFloors: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>[] = [];
  private clouds: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>[] = [];
  private players: PlayerMesh[] = [];

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x0d0c12);
    this.scene.add(this.ambient, this.sun, this.sun.target, this.terrain);

    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(ARENA_HALF * 2, ARENA_HALF * 2),
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

  resize(): void {
    const el = this.renderer.domElement.parentElement!;
    const w = el.clientWidth;
    const h = el.clientHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    // 狭いほうの画角で、自分のまわり VIEW_RADIUS が収まる距離まで引く
    const half = THREE.MathUtils.degToRad(this.camera.fov / 2);
    const halfH = Math.atan(Math.tan(half) * this.camera.aspect);
    this.camDist = VIEW_RADIUS / Math.sin(Math.min(half, halfH));
    this.camera.updateProjectionMatrix();
  }

  render(world: World, params: Params, meId: number): void {
    this.syncTerrain(world);
    this.syncPlayers(world);

    // カメラは自分を追う。ただし闘技場の外は映しすぎないよう少し内側へ寄せる
    const me = world.players[meId];
    const limit = ARENA_HALF - VIEW_RADIUS * 0.6;
    const tx = THREE.MathUtils.clamp(me.x, -limit, limit);
    const tz = THREE.MathUtils.clamp(me.y, -limit, limit);
    this.camTarget.lerp(new THREE.Vector3(tx, 0, tz), world.phase === 'ready' ? 1 : 0.12);
    this.camera.position.set(
      this.camTarget.x,
      Math.sin(CAMERA_TILT) * this.camDist,
      this.camTarget.z + Math.cos(CAMERA_TILT) * this.camDist,
    );
    this.camera.lookAt(this.camTarget.x, 0, this.camTarget.z - 0.6);

    // 夜明けが近づくほど、地面が朝焼けに染まっていく
    const left = world.phase === 'run' ? world.phaseLeft / params.runTime : world.phase === 'ready' ? 1 : 0;
    const dawn = 1 - Math.max(0, Math.min(1, left));
    this.ground.material.color.setRGB(0.16 + dawn * 0.75, 0.15 + dawn * 0.45, 0.2 + dawn * 0.05);
    this.sun.intensity = 0.6 + dawn * 1.4;
    this.sun.color.setRGB(1, 0.8 + dawn * 0.2, 0.7 + dawn * 0.3);
    this.sun.position.set(this.camTarget.x - 8, 20, this.camTarget.z + 6);
    this.sun.target.position.copy(this.camTarget);

    world.ruins.forEach((r, i) => {
      this.ruinFloors[i].material.color.setHex(r.shaded ? SHADE_COLOR : RUIN_FLOOR);
      this.clouds[i].visible = r.shaded;
    });

    for (const p of world.players) {
      const m = this.players[p.id];
      m.group.position.set(p.x, 0, p.y);
      m.group.rotation.y = Math.atan2(p.fx, p.fy);

      const burnt = world.phase === 'result' && !p.alive;
      m.body.material.color.setHex(burnt ? 0x3a3a3a : colorOf(p.id));
      m.body.scale.y = burnt ? 0.2 : 1;
      m.body.position.y = (BODY_HEIGHT * m.body.scale.y) / 2;

      // 抱えた血は頭の上の赤い円盤の大きさで見せる
      const b = p.blood / BLOOD_MAX;
      m.blood.visible = !burnt && b > 0;
      m.blood.scale.set(0.2 + b * 0.8, 1, 0.2 + b * 0.8);
      m.blood.position.y = BODY_HEIGHT + 0.05;

      // 足元の点：体の中心が安全な場所なら青、外なら赤。生死はこの一点で決まる
      m.dot.material.color.setHex(refugeOf(p, world) ? 0x35d0f5 : 0xff4040);
      m.ring.visible = p.id === meId;

      const shoved = world.shoves.some((s) => s.from === p.id && world.tick - s.tick < 8);
      m.nose.scale.setScalar(shoved ? 1.8 : 1);
    }

    this.renderer.render(this.scene, this.camera);
  }

  /** 地形は廃墟の広さが変わったときだけ組み直す（影の落ち方は毎フレーム色で変える） */
  private syncTerrain(world: World): void {
    const key = `${world.ruins[0]?.half}`;
    if (key === this.terrainKey) return;
    this.terrainKey = key;
    for (const child of [...this.terrain.children]) {
      this.terrain.remove(child);
      (child as THREE.Mesh).geometry.dispose();
    }
    this.ruinFloors = [];
    this.clouds = [];

    const floor = (x: number, z: number, size: number, color: number, y = 0.01) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ color }));
      m.rotation.x = -Math.PI / 2;
      m.position.set(x, y, z);
      this.terrain.add(m);
      return m;
    };

    for (const r of world.ruins) {
      // 雲の影は廃墟より一回り大きく、ぼんやりと地面を暗くする（判定は廃墟の床だけ）
      const cloud = new THREE.Mesh(
        new THREE.CircleGeometry(r.half * 2.6, 32),
        new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35 }),
      );
      cloud.rotation.x = -Math.PI / 2;
      cloud.position.set(r.cx, 0.006, r.cy);
      this.terrain.add(cloud);
      this.clouds.push(cloud);
      this.ruinFloors.push(floor(r.cx, r.cy, r.half * 2, RUIN_FLOOR));
    }
    for (const c of world.castles) {
      const color = new THREE.Color(colorOf(c.owner)).multiplyScalar(0.35);
      floor(c.cx, c.cy, c.half * 2, color.getHex());
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
    // 家は入れない塊なので、4枚の壁の上に屋根をかぶせて廃墟と見分けられるようにする
    const houseWalls = world.walls.filter((w) => w.kind === 'house');
    for (let i = 0; i + 3 < houseWalls.length; i += 4) {
      const shape = new THREE.Shape(houseWalls.slice(i, i + 4).map((w) => new THREE.Vector2(w.ax, -w.ay)));
      const roof = new THREE.Mesh(
        new THREE.ExtrudeGeometry(shape, { depth: WALL_HEIGHT.house + 0.05, bevelEnabled: false }),
        mat('roof', 0x6b3a3a),
      );
      roof.rotation.x = -Math.PI / 2;
      this.terrain.add(roof);
    }

    for (const w of world.walls) {
      const height = WALL_HEIGHT[w.kind];
      const color =
        w.kind === 'castle'
          ? new THREE.Color(colorOf(w.owner ?? 0)).multiplyScalar(0.55).getHex()
          : w.kind === 'house'
            ? 0x5a4f63
            : w.kind === 'tree'
              ? 0x2f5d3a
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

/** 画面の隅の全体図。影の落ちた廃墟・自分の城・全員の位置だけを描く */
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
}
