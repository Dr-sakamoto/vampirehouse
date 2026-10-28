// Three.js による描画。円柱の吸血鬼と箱の壁だけの、グレーボックスの見た目。
// 判定の平面 (x, y) は、3D空間の地面 (x, z) にそのまま写す。

import * as THREE from 'three';
import { ARENA_HALF, BLOOD_MAX, PLAYER_RADIUS, isInShelter, type Params, type World } from './sim';

export const PLAYER_COLORS = [0xe8e2f4, 0x6fa8ff, 0x7be08a, 0xffb347];
const BODY_HEIGHT = 1.4;
/** 画面に収める半径（走り出しの円＋体ひとつぶん） */
const FIT_RADIUS = 10.8;
/** 地面から見下ろす角度 */
const CAMERA_TILT = THREE.MathUtils.degToRad(62);

interface PlayerMesh {
  group: THREE.Group;
  body: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshStandardMaterial>;
  blood: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>;
  dot: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>;
  nose: THREE.Mesh;
  ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
}

export class BrawlView {
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(40, 1, 0.1, 200);
  private sun = new THREE.DirectionalLight(0xffffff, 0.6);
  private ambient = new THREE.AmbientLight(0x8080b0, 0.7);
  private ground: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>;
  private shade: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private wallGroup = new THREE.Group();
  private wallKey = '';
  private players: PlayerMesh[] = [];

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x0d0c12);
    this.scene.add(this.ambient, this.sun, this.wallGroup);
    this.sun.position.set(-8, 20, 6);

    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(ARENA_HALF * 2, ARENA_HALF * 2),
      new THREE.MeshStandardMaterial({ color: 0x2a2734 }),
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.scene.add(this.ground);

    this.shade = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0x163a52 }));
    this.shade.rotation.x = -Math.PI / 2;
    this.shade.position.y = 0.01;
    this.scene.add(this.shade);

    this.resize();
  }

  resize(): void {
    const el = this.renderer.domElement.parentElement!;
    const w = el.clientWidth;
    const h = el.clientHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    // 縦持ちでも横持ちでも、走り出しの円（半径 FIT_RADIUS）がまるごと収まる距離まで引く。
    // 狭いほうの画角で決めるので、画面の向きが変わっても避難所は常に真ん中
    const half = THREE.MathUtils.degToRad(this.camera.fov / 2);
    const halfH = Math.atan(Math.tan(half) * this.camera.aspect);
    const dist = FIT_RADIUS / Math.sin(Math.min(half, halfH));
    this.camera.position.set(0, Math.sin(CAMERA_TILT) * dist, Math.cos(CAMERA_TILT) * dist);
    // 上端は名札が覆うので、見る点を少し手前（画面の下）へずらして奥側に余白を作る
    this.camera.lookAt(0, 0, -0.6);
    this.camera.updateProjectionMatrix();
  }

  render(world: World, params: Params, meId: number): void {
    this.syncWalls(world);
    this.syncPlayers(world);

    this.shade.scale.set(params.shelterSize, params.shelterSize, 1);

    // 夜明けが近づくほど、影の外の地面が朝焼けに染まっていく
    const left = world.phase === 'run' ? world.phaseLeft / params.runTime : world.phase === 'ready' ? 1 : 0;
    const dawn = 1 - Math.max(0, Math.min(1, left));
    this.ground.material.color.setRGB(0.16 + dawn * 0.75, 0.15 + dawn * 0.45, 0.2 + dawn * 0.05);
    this.sun.intensity = 0.6 + dawn * 1.4;
    this.sun.color.setRGB(1, 0.8 + dawn * 0.2, 0.7 + dawn * 0.3);

    for (const p of world.players) {
      const m = this.players[p.id];
      m.group.position.set(p.x, 0, p.y);
      m.group.rotation.y = Math.atan2(p.fx, p.fy);

      const burnt = world.phase === 'result' && !p.alive;
      m.body.material.color.setHex(burnt ? 0x3a3a3a : PLAYER_COLORS[p.id % PLAYER_COLORS.length]);
      m.body.scale.y = burnt ? 0.2 : 1;
      m.body.position.y = (BODY_HEIGHT * m.body.scale.y) / 2;

      // 抱えた血は頭の上の赤い円盤の大きさで見せる
      const b = p.blood / BLOOD_MAX;
      m.blood.visible = !burnt && b > 0;
      m.blood.scale.set(0.2 + b * 0.8, 1, 0.2 + b * 0.8);
      m.blood.position.y = BODY_HEIGHT + 0.05;

      // 足元の点：体の中心が影の中なら青、外なら赤。生死はこの一点で決まる
      m.dot.material.color.setHex(isInShelter(p, params) ? 0x35d0f5 : 0xff4040);
      m.ring.visible = p.id === meId;

      const shoved = world.shoves.some((s) => s.from === p.id && world.tick - s.tick < 8);
      m.nose.scale.setScalar(shoved ? 1.8 : 1);
    }

    this.renderer.render(this.scene, this.camera);
  }

  private syncWalls(world: World): void {
    const key = `${world.round}`;
    if (key === this.wallKey) return;
    this.wallKey = key;
    for (const child of [...this.wallGroup.children]) {
      this.wallGroup.remove(child);
      (child as THREE.Mesh).geometry.dispose();
    }
    const mat = new THREE.MeshStandardMaterial({ color: 0x8a8296 });
    const outer = new THREE.MeshStandardMaterial({ color: 0x3b3748 });
    for (const w of world.walls) {
      const len = Math.hypot(w.bx - w.ax, w.by - w.ay);
      const isOuter = Math.max(Math.abs(w.ax), Math.abs(w.ay)) >= ARENA_HALF - 0.01;
      const height = isOuter ? 0.4 : 1.6;
      const mesh =
        len < 1e-6
          ? new THREE.Mesh(new THREE.CylinderGeometry(w.r, w.r, height, 16), mat)
          : new THREE.Mesh(new THREE.BoxGeometry(len + w.r * 2, height, w.r * 2), isOuter ? outer : mat);
      mesh.position.set((w.ax + w.bx) / 2, height / 2, (w.ay + w.by) / 2);
      mesh.rotation.y = -Math.atan2(w.by - w.ay, w.bx - w.ax);
      this.wallGroup.add(mesh);
    }
  }

  private syncPlayers(world: World): void {
    while (this.players.length < world.players.length) {
      const id = this.players.length;
      const group = new THREE.Group();
      const body = new THREE.Mesh(
        new THREE.CylinderGeometry(PLAYER_RADIUS, PLAYER_RADIUS, BODY_HEIGHT, 24),
        new THREE.MeshStandardMaterial({ color: PLAYER_COLORS[id % PLAYER_COLORS.length] }),
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
