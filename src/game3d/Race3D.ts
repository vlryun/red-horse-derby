import * as THREE from 'three';
import type { EventType, RaceEvent, TacticType } from '../engine';
import { coatColor, horseColor } from '../game/palette';

/**
 * 캐주얼 3D 경마 중계 렌더러 (three.js, 앱에 번들 → 외부 다운로드 없음).
 *
 * 엔진이 계산한 진행률(0..1.07)과 이벤트를 그대로 받아 3D 트랙 위에 그릴 뿐이다.
 * 카메라·애니메이션·몸개그는 순수 연출 → 속도·순위·결과에 영향 없음.
 *
 * 트랙 (단위 m, 1000m): 출발 직선 280m (+X 방향) → 왼쪽으로 크게 도는 반원 코너 340m → 결승 직선 380m (−X 방향)
 * 레인 0 = 안쪽 난간. 화면 HUD(등번호·TOP 5·자막)는 Phaser 가 이 렌더러가 알려 주는 화면 좌표에 그린다.
 */

export const VIEW_W = 1920;
export const VIEW_H = 1080;

const S1 = 280; // 출발 직선 끝
const S2 = 620; // 코너 끝
const R = (S2 - S1) / Math.PI; // 안쪽 난간 반지름 ≈ 108m
const LANE_W = 1.75;
const HS = 1.35; // 말·기수 크기 배율 (빔 뒷자리에서도 보이게 실제보다 큼)

/**
 * 갤럽 (말 로컬 단위, HS 배율 전): 다리 = 윗다리 L1 + 아랫다리·발굽 L2, 엉덩이 높이 HIP_H.
 * 걸음 위상은 "실제로 이동한 거리 ÷ 보폭" 으로만 진행 → 발굽이 땅을 딛는 동안 트랙 위에서 미끄러지지 않고,
 * 부스터·감속이 와도 동작을 처음부터 다시 틀지 않고 같은 걸음을 이어 가며 빨라지거나 느려진다.
 * 다리 순서(회전 갤럽): 뒷다리 둘 → 앞다리 둘 → 네 발이 모두 뜨는 순간. STANCE = 한 걸음 중 발굽이 땅에 붙어 있는 비율.
 */
const L1 = 0.72;
const L2 = 0.69;
const HIP_H = 1.3;
const STANCE = 0.4;

export interface Frame3D {
  /** 레인별 진행률 (보간값) */
  prog: Float64Array;
  /** 표시 중인 경주 시각(ms, 리플레이면 과거) · 서버 기준 경과(ms) */
  showMs: number;
  elapsed: number;
  dt: number;
  /** 레인 → 진행 중 이벤트 */
  events: Map<number, RaceEvent>;
  /** 레인 → 진행 중 작전 */
  tactics: Map<number, TacticType>;
  /** 순위 (레인 배열, 앞쪽부터) */
  ranking: number[];
  mode: 'live' | 'replay' | 'over';
  /** 선두가 결승선 가까이 → 결승선 고정 카메라 */
  finishLock: boolean;
  paused: boolean;
}

export interface Anchor {
  x: number;
  y: number;
  /** 화면 배율 (1 = 보통 거리) */
  k: number;
  visible: boolean;
}

interface Leg {
  hip: THREE.Group;
  knee: THREE.Group;
  /** 걸음 안에서의 시작 위치 (0..1) */
  off: number;
  front: boolean;
  hipX: number;
}

interface Rig {
  root: THREE.Group; // 트랙 위치·방향
  horse: THREE.Group; // 몸통 흔들림·기울기
  legs: Leg[];
  neck: THREE.Group;
  tail: THREE.Mesh;
  jockey: THREE.Group;
  torso: THREE.Group;
  armL: THREE.Group;
  armR: THREE.Group;
  shadow: THREE.Mesh;
  coatMat: THREE.MeshLambertMaterial;
  chase: THREE.Mesh;
  streaks: THREE.Group;
  lane: number;
  d: number; // 안쪽 난간에서 떨어진 거리
  /** 걸음 위상 (걸음 수, 이동 거리로만 증가) */
  gait: number;
  /** 질주 정도 0(서 있음)..1(전력) — 부드럽게 변함 */
  run: number;
  prevX: number;
  prevZ: number;
  prevShow: number;
  ring: THREE.Mesh;
  /** 출발 순간 뒷발 흙먼지 */
  dust: THREE.Sprite[];
  /** 몸개그 자세 (부드럽게 따라감) */
  pose: { lean: number; lift: number; arms: number; yaw: number; side: number; slump: number };
}

// ───────────────────────── 트랙 좌표 ─────────────────────────

const tmpP = new THREE.Vector3();
/** 거리 s(m), 안쪽 난간에서 바깥으로 d(m) → 월드 좌표 (y=0) */
export function trackPoint(s: number, d: number, out = new THREE.Vector3()): THREE.Vector3 {
  if (s <= S1) return out.set(s, 0, d);
  if (s <= S2) {
    const a = (s - S1) / R;
    const r = R + d;
    return out.set(S1 + r * Math.sin(a), 0, -R + r * Math.cos(a));
  }
  return out.set(S1 - (s - S2), 0, -2 * R - d);
}

/** 진행 방향(라디안, 월드 Y축 회전: 0 = +X) */
export function trackHeading(s: number): number {
  if (s <= S1) return 0;
  if (s <= S2) return (s - S1) / R; // 왼쪽(+Y 회전)으로 돔
  return Math.PI;
}

function smooth(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
}

/**
 * 출발 대기 중 말마다 다른 박자의 짧은 동작 (0..1 진행, 동작 중이 아니면 -1).
 * 순수 연출: 벽시계 기준이라 경주 기록과 무관.
 */
function fidget(now: number, lane: number, kind: number, period: number, dur: number): number {
  const seed = (lane * 7919 + kind * 104729) % 1000;
  const per = period * (0.8 + (seed % 400) / 1000);
  const t = (now + seed * 13) % per;
  return t < dur ? t / dur : -1;
}

function approach(cur: number, target: number, dt: number, ms: number): number {
  return cur + (target - cur) * (1 - Math.exp(-dt / ms));
}

// ───────────────────────── 렌더러 ─────────────────────────

export class Race3D {
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(34, VIEW_W / VIEW_H, 0.5, 2500);
  private rigs: Rig[] = [];
  private gate = new THREE.Group();
  private gateDoors: THREE.Mesh[] = [];
  private camPos = new THREE.Vector3(60, 30, 80);
  private camLook = new THREE.Vector3(0, 0, 0);
  private focus = { lane: -1, until: 0, w: 0 };
  /** 코너 진입 때 2~3초 낮게 따라가는 장면 (가까운 말은 크게, 먼 말은 작게) */
  private corner = { done: false, until: 0, w: 0 };
  private now = 0;
  private trackW = 30;
  private n = 0;
  private numberTex = new Map<number, THREE.CanvasTexture>();
  private v = new THREE.Vector3();
  /** setRace 이후 실제로 그린 프레임 수 (0 이면 아직 이 경주의 첫 화면을 못 그림) */
  private framesSinceSet = 0;

  /** 이 경주의 첫 3D 화면을 그렸는가 */
  get ready(): boolean {
    return this.framesSinceSet > 0;
  }

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(VIEW_W, VIEW_H, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    const sky = new THREE.Color(0x9fd3f0);
    this.scene.background = sky;
    this.scene.fog = new THREE.Fog(sky, 260, 900);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x4a7a3a, 1.6));
    const sun = new THREE.DirectionalLight(0xfff2d8, 1.9);
    sun.position.set(-120, 220, 160);
    this.scene.add(sun);
    this.buildWorld(30);
  }

  dispose(): void {
    this.renderer.dispose();
  }

  // ───────── 경주 교체 ─────────
  /** 보폭(m): 평균 속도에서 초당 약 2.3걸음이 되게 (짧은 경주는 보폭이 길어짐) */
  private stride = 6.5;

  setRace(entrants: { id: number }[], raceSeconds = 70): void {
    this.stride = Math.min(8.4, Math.max(5.2, 1000 / raceSeconds / 2.3));
    for (const r of this.rigs) {
      this.scene.remove(r.root);
      this.scene.remove(r.chase);
      r.dust.forEach((d) => this.scene.remove(d));
    }
    this.rigs = [];
    this.n = entrants.length;
    const w = Math.max(14, this.n * LANE_W + 4);
    if (Math.abs(w - this.trackW) > 0.5) this.buildWorld(w);
    entrants.forEach((e, lane) => {
      const rig = this.buildHorse(e.id, lane);
      this.rigs.push(rig);
      this.scene.add(rig.root);
    });
    this.buildGate();
    this.focus = { lane: -1, until: 0, w: 0 };
    this.framesSinceSet = 0;
    // 출발선 고정 구도로 카메라를 바로 옮기고(이전 경주의 결승선 구도에서 날아오지 않게), 셰이더를 미리 준비
    this.startView(this.camPos, this.camLook);
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);
    try {
      this.renderer.compile(this.scene, this.camera);
    } catch {
      /* 첫 렌더에서 다시 시도됨 */
    }
    this.corner = { done: false, until: 0, w: 0 };
  }

  /** 추월·각성 순간 해당 말을 짧게 가까이 */
  focusOn(lane: number, ms: number): void {
    if (lane < 0 || lane >= this.rigs.length) return;
    this.focus.lane = lane;
    this.focus.until = this.now + ms;
  }

  // ───────── 월드 ─────────
  private world = new THREE.Group();

  private buildWorld(trackW: number): void {
    this.trackW = trackW;
    this.scene.remove(this.world);
    this.world = new THREE.Group();
    this.scene.add(this.world);
    const W = trackW;

    // 바깥 잔디
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), new THREE.MeshLambertMaterial({ color: 0x3f8f3a }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(100, -0.05, -100);
    this.world.add(ground);

    // 안쪽 잔디 (더 진하게, 줄무늬)
    const inner: THREE.Vector2[] = [];
    for (let s = 0; s <= 1060; s += 4) {
      const p = trackPoint(s, -1.5, tmpP);
      inner.push(new THREE.Vector2(p.x, -p.z));
    }
    const infield = new THREE.Mesh(new THREE.ShapeGeometry(new THREE.Shape(inner)), new THREE.MeshLambertMaterial({ color: 0x2f7a33 }));
    infield.rotation.x = -Math.PI / 2;
    infield.position.y = -0.02;
    this.world.add(infield);
    for (let k = 0; k < 7; k++) {
      const stripe = new THREE.Mesh(new THREE.PlaneGeometry(250, 12), new THREE.MeshLambertMaterial({ color: 0x35853a }));
      stripe.rotation.x = -Math.PI / 2;
      stripe.position.set(150, -0.01, -30 - k * 26);
      this.world.add(stripe);
    }

    // 흙 트랙 (10m 마다 색이 살짝 다른 띠 → 속도감)
    const pos: number[] = [];
    const col: number[] = [];
    const idx: number[] = [];
    const cA = new THREE.Color(0xc98d52);
    const cB = new THREE.Color(0xb97d45);
    let vi = 0;
    for (let s = -80; s <= 1090; s += 2) {
      const a = trackPoint(s, -1.5, new THREE.Vector3());
      const b = trackPoint(s, W + 1.5, new THREE.Vector3());
      const c = Math.floor(s / 10) % 2 === 0 ? cA : cB;
      pos.push(a.x, 0, a.z, b.x, 0, b.z);
      col.push(c.r, c.g, c.b, c.r, c.g, c.b);
      if (vi > 0) idx.push(vi - 2, vi - 1, vi, vi - 1, vi + 1, vi);
      vi += 2;
    }
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    tg.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    tg.setIndex(idx);
    tg.computeVertexNormals();
    const trackMesh = new THREE.Mesh(tg, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    this.world.add(trackMesh);

    // 흰 난간 (안쪽·바깥쪽): 기둥 + 위 레일
    const white = new THREE.MeshLambertMaterial({ color: 0xffffff });
    for (const d of [-1.6, W + 1.6]) {
      const posts: THREE.Vector3[] = [];
      for (let s = -60; s <= 1080; s += 5) posts.push(trackPoint(s, d, new THREE.Vector3()));
      const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(0.18, 1.2, 0.18), white, posts.length);
      const m = new THREE.Matrix4();
      posts.forEach((p, i) => inst.setMatrixAt(i, m.makeTranslation(p.x, 0.6, p.z)));
      this.world.add(inst);
      const railPos: number[] = [];
      const railIdx: number[] = [];
      let ri = 0;
      for (let s = -60; s <= 1080; s += 2) {
        const p = trackPoint(s, d, tmpP);
        railPos.push(p.x, 1.05, p.z, p.x, 1.3, p.z);
        if (ri > 0) railIdx.push(ri - 2, ri - 1, ri, ri - 1, ri + 1, ri);
        ri += 2;
      }
      const rg = new THREE.BufferGeometry();
      rg.setAttribute('position', new THREE.Float32BufferAttribute(railPos, 3));
      rg.setIndex(railIdx);
      rg.computeVertexNormals();
      this.world.add(new THREE.Mesh(rg, new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide })));
    }

    // 거리 표지 (남은 거리, 안쪽 난간)
    for (let m = 100; m < 1000; m += 100) {
      const p = trackPoint(m, -3.2, new THREE.Vector3());
      const pole = new THREE.Mesh(new THREE.BoxGeometry(0.35, 4, 0.35), new THREE.MeshLambertMaterial({ color: 0xc8102e }));
      pole.position.set(p.x, 2, p.z);
      this.world.add(pole);
      const sign = this.textSprite(`${1000 - m}m`, '#c8102e', '#ffffff', 2.6);
      sign.position.set(p.x, 4.6, p.z);
      this.world.add(sign);
    }

    // 결승선: 바둑판 띠 + 기둥 + 아치
    const checker = document.createElement('canvas');
    checker.width = 64;
    checker.height = 512;
    const cx = checker.getContext('2d')!;
    for (let y = 0; y < 32; y++) for (let x = 0; x < 4; x++) {
      cx.fillStyle = (x + y) % 2 ? '#111' : '#fff';
      cx.fillRect(x * 16, y * 16, 16, 16);
    }
    const ct = new THREE.CanvasTexture(checker);
    ct.colorSpace = THREE.SRGBColorSpace;
    const fl = new THREE.Mesh(new THREE.PlaneGeometry(2.4, W + 3), new THREE.MeshBasicMaterial({ map: ct }));
    fl.rotation.x = -Math.PI / 2;
    const fp = trackPoint(1000, W / 2, new THREE.Vector3());
    fl.position.set(fp.x, 0.03, fp.z);
    this.world.add(fl);
    const gold = new THREE.MeshLambertMaterial({ color: 0xf5c542 });
    for (const d of [-2.6, W + 2.6]) {
      const p = trackPoint(1000, d, new THREE.Vector3());
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.7, 11, 0.7), gold);
      post.position.set(p.x, 5.5, p.z);
      this.world.add(post);
    }
    // 결승 표지: 건너편(안쪽) 기둥 위 → 카메라(바깥)에서 말 뒤로 보이고 말을 가리지 않음
    const fin = this.textSprite('FINISH', '#7a0f12', '#f5c542', 4.2);
    const fq = trackPoint(1000, -2.6, new THREE.Vector3());
    fin.position.set(fq.x, 12.5, fq.z);
    this.world.add(fin);

    // 관중석: 결승 직선 바깥 (큰 것) · 출발 직선 바깥 (작은 것) → 카메라가 움직일 때 깊이감
    // 카메라는 트랙 바깥에서 비스듬히 보므로, 관중석은 트랙 건너편(안쪽)에 두어 말 뒤 배경으로 보이게
    this.addStand(640, 1090, -12, 7);
    this.addStand(-30, 250, -12, 5);
    // 안쪽 나무 몇 그루 (멀리 있는 기준점)
    const trunk = new THREE.MeshLambertMaterial({ color: 0x6b4423 });
    const leaf = new THREE.MeshLambertMaterial({ color: 0x2c6e2f, flatShading: true });
    for (let k = 0; k < 14; k++) {
      const s = 60 + k * 70;
      const p = trackPoint(s, -36 - (k % 3) * 16, new THREE.Vector3());
      const t = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.7, 4, 6), trunk);
      t.position.set(p.x, 2, p.z);
      const c = new THREE.Mesh(new THREE.ConeGeometry(3.4, 8, 7), leaf);
      c.position.set(p.x, 7.5, p.z);
      this.world.add(t, c);
    }
  }

  /** 트랙 바깥쪽 관중석 (계단 + 지붕 + 관중) */
  private addStand(s0: number, s1: number, d0: number, rows: number): void {
    const stepMat = new THREE.MeshLambertMaterial({ color: 0xd8d0c0 });
    const roofMat = new THREE.MeshLambertMaterial({ color: 0x7a0f12 });
    const people: THREE.Matrix4[] = [];
    const colors: THREE.Color[] = [];
    const palette = [0xc8102e, 0xf5c542, 0xffffff, 0x2a6fdb, 0x1a1a1a, 0xff8a3a, 0x7be495];
    for (let s = s0; s < s1; s += 12) {
      const h0 = trackHeading(s + 6);
      for (let r = 0; r < rows; r++) {
        const p = trackPoint(s + 6, d0 - r * 2.4, new THREE.Vector3());
        const step = new THREE.Mesh(new THREE.BoxGeometry(12.2, 1.1 + r * 1.2, 2.4), stepMat);
        step.position.set(p.x, (1.1 + r * 1.2) / 2, p.z);
        step.rotation.y = h0;
        this.world.add(step);
        for (let k = 0; k < 9; k++) {
          const q = trackPoint(s + 0.8 + k * 1.3, d0 - r * 2.4, new THREE.Vector3());
          const m = new THREE.Matrix4().makeTranslation(q.x, 1.1 + r * 1.2 + 0.55, q.z);
          people.push(m);
          colors.push(new THREE.Color(palette[(k * 7 + r * 3 + Math.floor(s)) % palette.length]!));
        }
      }
      const pr = trackPoint(s + 6, d0 - rows * 1.2, new THREE.Vector3());
      const roof = new THREE.Mesh(new THREE.BoxGeometry(12.2, 0.5, rows * 2.4 + 3), roofMat);
      roof.position.set(pr.x, rows * 1.2 + 6, pr.z);
      roof.rotation.y = h0;
      this.world.add(roof);
    }
    const crowd = new THREE.InstancedMesh(new THREE.BoxGeometry(0.7, 1.1, 0.6), new THREE.MeshLambertMaterial({ color: 0xffffff }), people.length);
    people.forEach((m, i) => {
      crowd.setMatrixAt(i, m);
      crowd.setColorAt(i, colors[i]!);
    });
    this.world.add(crowd);
  }

  private textSprite(text: string, bg: string, fg: string, height: number): THREE.Sprite {
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d')!;
    ctx.font = '900 96px "Black Han Sans", "Noto Sans KR", sans-serif';
    const w = Math.ceil(ctx.measureText(text).width) + 60;
    c.width = w;
    c.height = 140;
    ctx.font = '900 96px "Black Han Sans", "Noto Sans KR", sans-serif';
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, 140);
    ctx.fillStyle = fg;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, w / 2, 76);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t }));
    sp.scale.set((height * w) / 140, height, 1);
    return sp;
  }

  /** 안장 천 번호 (양옆) */
  private numberTexture(id: number): THREE.CanvasTexture {
    const hit = this.numberTex.get(id);
    if (hit) return hit;
    const c = document.createElement('canvas');
    c.width = 128;
    c.height = 128;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#' + horseColor(id).toString(16).padStart(6, '0');
    ctx.fillRect(0, 0, 128, 128);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(64, 64, 52, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#1a0a0a';
    ctx.font = `900 ${id >= 10 ? 70 : 84}px "Black Han Sans", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(id), 64, 70);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    this.numberTex.set(id, t);
    return t;
  }

  // ───────── 말 + 기수 (로우폴리) ─────────
  private buildHorse(id: number, lane: number): Rig {
    const coat = new THREE.MeshLambertMaterial({ color: coatColor(id), flatShading: true });
    const dark = new THREE.MeshLambertMaterial({ color: 0x2a1a10, flatShading: true });
    const silk = new THREE.MeshLambertMaterial({ color: horseColor(id), flatShading: true });
    const white = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });
    const skin = new THREE.MeshLambertMaterial({ color: 0xf1c7a0, flatShading: true });
    const box = (w: number, h: number, d: number, m: THREE.Material) => new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);

    const root = new THREE.Group();
    const horse = new THREE.Group();
    root.add(horse);

    // 몸통 (앞쪽이 약간 높고 굵게)
    const body = box(2.1, 0.95, 0.8, coat);
    body.position.set(0, 1.6, 0);
    const chest = box(0.7, 1.0, 0.82, coat);
    chest.position.set(0.95, 1.65, 0);
    const rump = box(0.7, 0.95, 0.84, coat);
    rump.position.set(-0.9, 1.68, 0);
    horse.add(body, chest, rump);

    // 목·머리 (목 관절 그룹)
    const neck = new THREE.Group();
    neck.position.set(1.15, 1.95, 0);
    const nk = box(0.45, 1.15, 0.46, coat);
    nk.position.set(0.15, 0.45, 0);
    nk.rotation.z = -0.55;
    const mane = box(0.14, 1.1, 0.2, dark);
    mane.position.set(-0.08, 0.55, 0);
    mane.rotation.z = -0.55;
    const head = box(0.85, 0.4, 0.42, coat);
    head.position.set(0.72, 0.95, 0);
    head.rotation.z = -0.45;
    const nose = box(0.3, 0.32, 0.38, dark);
    nose.position.set(1.08, 0.77, 0);
    nose.rotation.z = -0.45;
    const earL = box(0.1, 0.25, 0.08, coat);
    earL.position.set(0.45, 1.25, 0.12);
    const earR = earL.clone();
    earR.position.z = -0.12;
    const blaze = box(0.5, 0.06, 0.12, white);
    blaze.position.set(0.8, 1.13, 0);
    blaze.rotation.z = -0.45;
    neck.add(nk, mane, head, nose, earL, earR, blaze);
    horse.add(neck);

    const tail = box(0.18, 1.0, 0.2, dark);
    tail.geometry.translate(0, -0.5, 0);
    tail.position.set(-1.25, 1.95, 0);
    tail.rotation.z = -0.6;
    horse.add(tail);

    // 다리 4개 (엉덩이·무릎 관절)
    const legs: Leg[] = [];
    const legDef: [number, number, number, boolean][] = [
      [0.85, 0.27, 0.5, true],
      [0.85, -0.27, 0.6, true],
      [-0.85, 0.27, 0.0, false],
      [-0.85, -0.27, 0.1, false],
    ];
    for (const [x, z, off, front] of legDef) {
      const hip = new THREE.Group();
      hip.position.set(x, 1.3, z);
      const upper = box(0.24, 0.72, 0.24, coat);
      upper.position.y = -0.36;
      const knee = new THREE.Group();
      knee.position.y = -0.72;
      const lower = box(0.16, 0.62, 0.16, coat);
      lower.position.y = -0.31;
      const hoof = box(0.22, 0.14, 0.22, dark);
      hoof.position.y = -0.62;
      knee.add(lower, hoof);
      hip.add(upper, knee);
      horse.add(hip);
      legs.push({ hip, knee, off, front, hipX: x });
    }

    // 안장 천 + 등번호 (양옆) — 뒷자리에서도 보이게 크게
    const cloth = box(0.95, 0.62, 0.86, silk);
    cloth.position.set(-0.1, 1.82, 0);
    horse.add(cloth);
    const numMat = new THREE.MeshBasicMaterial({ map: this.numberTexture(id) });
    for (const side of [1, -1]) {
      const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.72, 0.72), numMat);
      plate.position.set(-0.1, 1.72, 0.44 * side);
      if (side < 0) plate.rotation.y = Math.PI;
      horse.add(plate);
    }
    const topPlate = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.6), numMat);
    topPlate.rotation.x = -Math.PI / 2;
    topPlate.rotation.z = -Math.PI / 2;
    topPlate.position.set(-0.6, 2.14, 0);
    horse.add(topPlate);

    // 기수 (안장 위, 엉덩이 관절에서 상체가 숙여지거나 일어남)
    const jockey = new THREE.Group();
    jockey.position.set(0.05, 2.12, 0);
    const thighL = box(0.5, 0.18, 0.18, white);
    thighL.position.set(0.15, 0, 0.28);
    thighL.rotation.z = -0.5;
    const thighR = thighL.clone();
    thighR.position.z = -0.28;
    const torso = new THREE.Group();
    const chestJ = box(0.36, 0.7, 0.48, silk);
    chestJ.position.y = 0.35;
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.24, 8, 6, 0, Math.PI * 2, 0, Math.PI / 2), silk);
    helmet.position.y = 0.88;
    const face = new THREE.Mesh(new THREE.SphereGeometry(0.2, 8, 6), skin);
    face.position.y = 0.84;
    const peak = box(0.18, 0.05, 0.3, silk);
    peak.position.set(0.2, 0.9, 0);
    torso.add(chestJ, face, helmet, peak);
    const arm = (side: number) => {
      const g = new THREE.Group();
      g.position.set(0.05, 0.62, 0.3 * side);
      const a = box(0.16, 0.62, 0.16, silk);
      a.position.y = -0.31;
      const hand = box(0.17, 0.17, 0.17, skin);
      hand.position.y = -0.64;
      g.add(a, hand);
      torso.add(g);
      return g;
    };
    const armL = arm(1);
    const armR = arm(-1);
    jockey.add(thighL, thighR, torso);
    horse.add(jockey);

    // 땅에 붙는 그림자
    const shadow = new THREE.Mesh(
      new THREE.CircleGeometry(1, 20),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32, depthWrite: false }),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.scale.set(1.7, 0.75, 1);
    shadow.position.y = 0.04;
    root.add(shadow);

    // 이벤트 표시 고리 (발밑): 금색 = 부스터, 붉은색 = 각성, 회색 = 방해 → 자막 없이도 어느 말인지 보임
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(1.25, 1.6, 28),
      new THREE.MeshBasicMaterial({ color: 0xf5c542, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.06;
    ring.scale.set(1.6, 1, 1);
    ring.visible = false;
    root.add(ring);

    // 따라잡기: 앞말까지 이어지는 빛줄 (월드 좌표로 그림)
    const chase = new THREE.Mesh(
      new THREE.BoxGeometry(1, 0.12, 0.12),
      new THREE.MeshBasicMaterial({ color: 0x4ad8ff, transparent: true, opacity: 0.85 }),
    );
    chase.visible = false;
    this.scene.add(chase);

    // 전력 질주·부스터: 뒤로 흐르는 속도선
    const streaks = new THREE.Group();
    const sm = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.75 });
    for (let k = 0; k < 5; k++) {
      const st = box(1.6 + k * 0.3, 0.06, 0.06, sm);
      st.position.set(-2.2 - k * 0.25, 1.2 + k * 0.28, (k % 2 ? 1 : -1) * 0.5);
      streaks.add(st);
    }
    streaks.visible = false;
    horse.add(streaks);

    root.scale.setScalar(HS);
    return {
      root, horse, legs, neck, tail, jockey, torso, armL, armR, shadow, coatMat: coat, chase, streaks,
      lane, d: 1.2 + lane * LANE_W, gait: (lane * 0.37) % 1, run: 0, prevX: NaN, prevZ: 0, prevShow: NaN, ring, dust: this.makeDust(),
      pose: { lean: 0.55, lift: 0, arms: 0, yaw: 0, side: 0, slump: 0 },
    };
  }

  private dustTex: THREE.CanvasTexture | null = null;

  /** 출발 흙먼지 (말마다 3개, 평소엔 숨김) */
  private makeDust(): THREE.Sprite[] {
    if (!this.dustTex) {
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const ctx = c.getContext('2d')!;
      const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 31);
      g.addColorStop(0, 'rgba(214,170,120,0.95)');
      g.addColorStop(1, 'rgba(214,170,120,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 64, 64);
      this.dustTex = new THREE.CanvasTexture(c);
      this.dustTex.colorSpace = THREE.SRGBColorSpace;
    }
    const out: THREE.Sprite[] = [];
    for (let k = 0; k < 3; k++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.dustTex, transparent: true, depthWrite: false }));
      sp.visible = false;
      this.scene.add(sp);
      out.push(sp);
    }
    return out;
  }

  // ───────── 출발 게이트 ─────────
  private buildGate(): void {
    this.scene.remove(this.gate);
    this.gate = new THREE.Group();
    this.gateDoors = [];
    const frame = new THREE.MeshLambertMaterial({ color: 0xeeeeee });
    const red = new THREE.MeshLambertMaterial({ color: 0xc8102e });
    const W = this.trackW;
    for (const x of [-2, 3.5]) {
      const beam = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.45, W + 2), red);
      beam.position.set(x, 4.8, W / 2);
      this.gate.add(beam);
    }
    for (let i = 0; i <= this.n; i++) {
      const z = 0.35 + i * LANE_W - 0.05;
      const bar = new THREE.Mesh(new THREE.BoxGeometry(5.6, 0.25, 0.12), frame);
      bar.position.set(0.7, 3.0, z);
      for (const x of [-2, 3.5]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.15, 4.8, 0.15), frame);
        post.position.set(x, 2.4, z);
        this.gate.add(post);
      }
      this.gate.add(bar);
      if (i < this.n) {
        // 앞문은 가슴 높이 → 카메라가 앞에서 봐도 말 머리와 기수가 문 위로 보임
        const door = new THREE.Mesh(new THREE.BoxGeometry(0.15, 1.7, LANE_W - 0.2), red);
        door.geometry.translate(0, 0, (LANE_W - 0.2) / 2);
        door.position.set(3.5, 1.2, z + 0.05);
        this.gate.add(door);
        this.gateDoors.push(door);
      }
    }
    this.scene.add(this.gate);
  }

  // ───────── 매 프레임 ─────────
  render(f: Frame3D): Anchor[] {
    this.now += f.dt;
    const n = this.rigs.length;
    const dt = Math.min(f.dt, 100);

    // 게이트: 0.24초에 문이 열리고 2.2초 뒤 사라짐
    const open = smooth(f.elapsed / 240);
    this.gateDoors.forEach((d) => (d.rotation.y = -open * 1.6));
    this.gate.visible = f.mode === 'live' && f.elapsed < 2600;

    // 따라잡기 목표: 바로 앞(25m 안)에서 가장 가까운 말
    const sOf = (i: number) => f.prog[i]! * 1000;

    for (let i = 0; i < n; i++) {
      const rig = this.rigs[i]!;
      const s = sOf(i);
      const ev = f.events.get(i);
      const tac = f.tactics.get(i);

      // 위치·방향 (코너에서는 몸 전체가 진행 방향으로 돎)
      let d = rig.d;
      let yaw = 0;
      if (ev?.type === 'RUNAWAY') {
        const k = Math.min(1, Math.max(0, (f.showMs / 50 - ev.tick) / (ev.endTick - ev.tick)));
        d += Math.sin(k * Math.PI) * 9;
        yaw = Math.cos(k * Math.PI) * -0.7;
      }
      trackPoint(s, d, rig.root.position);
      rig.root.rotation.y = trackHeading(s);
      const running = this.gaitStep(rig, f) > 0.05;
      const g = rig.gait;

      // ── 기수 몸개그 (이벤트·작전 → 큰 동작) ──
      const p = rig.pose;
      let lean = 0.55; // 앞으로 숙임
      let lift = 0; // 안장 위로 일어섬
      let arms = 0.25; // 팔 들기 (0 = 고삐, 1 = 만세)
      let slump = 0;
      let wob = 0;
      const type: EventType | undefined = ev?.type;
      // 큰 몸개그는 각성·강한 부스터(미친 질주)가 터지는 순간에만. 당근·방귀는 살짝 숙이는 정도
      const burst = ev ? (f.showMs / 50 - ev.tick) * 50 : 1e9; // 이벤트 시작 후 ms
      if (type === 'AWAKEN') {
        // 뒤로 확 젖혀졌다가 → 안장 위에서 벌떡 일어나 만세
        if (burst < 450) {
          lean = -0.95;
          arms = 1.3;
          lift = 0.2;
        } else {
          lean = -0.05;
          lift = 0.75;
          arms = 1.15;
        }
      } else if (type === 'CRAZY') {
        // 가속에 밀려 뒤로 확 젖혀졌다가 → 자세를 되찾음
        lean = burst < 600 ? -0.9 : 0.55 + 0.45 * smooth((burst - 600) / 500);
        arms = burst < 600 ? 1.3 : 0.45;
        lift = burst < 600 ? 0.2 : 0;
      } else if (type === 'CARROT' || type === 'FART') {
        lean = 0.8;
        arms = 0.45;
      } else if (type === 'SPURT') {
        lean = 1.15;
        arms = Math.abs(Math.sin(this.now * 0.02)) * 0.8;
      } else if (type === 'SLEEP') {
        lean = 1.3;
        slump = 1;
        arms = 0;
      } else if (type === 'BANANA') {
        wob = Math.sin(this.now * 0.03) * 0.45;
        arms = 1.3;
        lean = -0.3;
      } else if (type === 'TURTLE') {
        lean = 0.0;
        arms = 0.1;
      } else if (type === 'RUNAWAY') {
        lift = 0.6;
        lean = -0.1;
        arms = 1.2 + Math.sin(this.now * 0.025) * 0.4;
      }
      if (tac === 'SPRINT' && !type) {
        lean = 1.25; // 몸을 납작하게 낮춤
        lift = -0.12;
        arms = 0.7 + Math.abs(Math.sin(Math.PI * 2 * g)) * 0.4;
      } else if (tac === 'CHASE' && !type) {
        lean = 0.95;
        arms = 0.9; // 앞으로 손을 뻗음
      } else if (tac === 'SAVE' && !type) {
        lean = 0.15;
        arms = 0.1;
      }
      // 출발 대기: 3·2 는 고삐를 고쳐 잡으며 앉아 있다가, 1 에서 상체를 확 낮춤 → 출발! 과 함께 앞으로
      let snap = 110;
      if (f.mode === 'live' && f.elapsed < 600) {
        const rem = -f.elapsed;
        if (f.elapsed < 0 && rem > 1000) {
          lean = 0.3;
          lift = 0.05;
          const rein = fidget(this.now, i, 3, 2600 * (rem < 2000 ? 0.7 : 1), 600);
          arms = 0.2 + (rein >= 0 ? 0.45 * Math.sin(Math.PI * rein) : 0);
        } else {
          lean = 1.25;
          lift = -0.14;
          arms = 0.55;
          snap = 70;
        }
      }
      p.lean = approach(p.lean, lean, dt, snap);
      p.lift = approach(p.lift, lift, dt, snap);
      p.arms = approach(p.arms, arms, dt, 90);
      p.slump = approach(p.slump, slump, dt, 200);
      p.yaw = approach(p.yaw, yaw + wob, dt, 60);
      // 기수는 안장에 붙어 말의 오르내림을 무릎으로 받아냄 (같은 리듬, 작은 폭)
      const TAU = Math.PI * 2;
      rig.torso.rotation.z = -p.lean + rig.run * 0.05 * Math.sin(TAU * (g - 0.2));
      rig.jockey.position.y = 2.12 + p.lift - rig.horse.position.y * 0.45;
      rig.jockey.rotation.x = Math.sin(this.now * 0.03) * (type === 'BANANA' ? 0.3 : 0);
      rig.armL.rotation.z = p.arms * 2.4 + rig.run * 0.18 * Math.sin(TAU * g);
      rig.armR.rotation.z = p.arms * 2.4 + rig.run * 0.18 * Math.sin(TAU * g);
      rig.neck.rotation.z -= p.slump * 0.5;
      rig.root.rotation.y += p.yaw;
      rig.coatMat.emissive.setHex(type === 'AWAKEN' ? 0x661010 : 0x000000);
      // 발밑 고리: 이벤트 종류 색, 시작 순간 크게 → 작게
      if (type) {
        const good = type === 'CARROT' || type === 'FART' || type === 'CRAZY' || type === 'SPURT';
        const ringMat = rig.ring.material as THREE.MeshBasicMaterial;
        ringMat.color.setHex(type === 'AWAKEN' ? 0xff2a2a : good ? 0xf5c542 : 0x9a9a9a);
        const pop = 1 + 0.6 * Math.max(0, 1 - burst / 500);
        rig.ring.scale.set(1.6 * pop, pop, 1);
        ringMat.opacity = 0.65 + 0.3 * Math.abs(Math.sin(this.now * 0.008));
        rig.ring.visible = true;
      } else {
        rig.ring.visible = false;
      }
      rig.streaks.visible = running && (!!(type && ['CARROT', 'FART', 'CRAZY', 'AWAKEN', 'SPURT'].includes(type)) || tac === 'SPRINT');
      if (rig.streaks.visible) rig.streaks.children.forEach((c, j) => (c.position.x = -2.2 - j * 0.25 - ((this.now * 0.01 + j) % 1.2)));

      // 출발 흙먼지: 게이트가 열리는 순간 뒷발 쪽에서 짧게 (경주 시각 기준 → 새로고침해도 같은 장면)
      const dk = f.mode === 'live' && f.elapsed >= 0 && f.elapsed < 900 ? f.elapsed / 900 : -1;
      rig.dust.forEach((sp, j) => {
        if (dk < 0) {
          sp.visible = false;
          return;
        }
        const kk = Math.min(1, dk * (1 + j * 0.25));
        trackPoint(s - 1.6 * HS - kk * (2.5 + j), d + (j - 1) * 0.6, sp.position).setY(0.4 + kk * (1.2 + j * 0.3));
        const sc = (1.6 + kk * 3.4) * (1 - j * 0.15);
        sp.scale.set(sc, sc * 0.75, 1);
        (sp.material as THREE.SpriteMaterial).opacity = 0.75 * (1 - kk);
        sp.visible = kk < 1;
      });

      // 따라잡기 빛줄: 내 말 코 → 바로 앞 말 꼬리
      rig.chase.visible = false;
      if (tac === 'CHASE' && f.mode === 'live') {
        let best = -1;
        let bestGap = 25;
        for (let j = 0; j < n; j++) {
          const gap = sOf(j) - s;
          if (j !== i && gap > 0 && gap < bestGap) {
            bestGap = gap;
            best = j;
          }
        }
        if (best !== -1) {
          const a = trackPoint(s + 2.6 * HS, d, new THREE.Vector3()).setY(2.4 * HS);
          const b = trackPoint(sOf(best) - 1.6 * HS, this.rigs[best]!.d, new THREE.Vector3()).setY(2.4 * HS);
          const len = a.distanceTo(b);
          rig.chase.visible = len > 0.5;
          rig.chase.position.copy(a).add(b).multiplyScalar(0.5);
          rig.chase.scale.set(len, 1, 1);
          rig.chase.rotation.set(0, Math.atan2(-(b.z - a.z), b.x - a.x), 0);
          (rig.chase.material as THREE.MeshBasicMaterial).opacity = 0.55 + Math.abs(Math.sin(this.now * 0.012)) * 0.4;
        }
      }
    }

    this.updateCamera(f, dt);
    this.renderer.render(this.scene, this.camera);
    this.framesSinceSet++;

    // HUD 기준점 (기수 머리 위)
    const anchors: Anchor[] = [];
    const camPos = this.camera.position;
    for (const rig of this.rigs) {
      this.v.copy(rig.root.position).setY((3.6 + rig.pose.lift) * HS + rig.horse.position.y * HS);
      const dist = this.v.distanceTo(camPos);
      this.v.project(this.camera);
      const vis = this.v.z < 1 && Math.abs(this.v.x) < 1.1 && Math.abs(this.v.y) < 1.1;
      anchors.push({
        x: (this.v.x * 0.5 + 0.5) * VIEW_W,
        y: (-this.v.y * 0.5 + 0.5) * VIEW_H,
        k: Math.min(1.4, Math.max(0.55, 70 / dist)),
        visible: vis,
      });
    }
    return anchors;
  }

  /**
   * 걸음 한 프레임: 이동 거리로 위상을 진행하고, 발굽 목표 위치를 정해 두 마디 다리 IK 로 각도를 푼다.
   * 땅을 딛는 동안 발굽은 말 기준 뒤로 "말이 간 만큼" 움직임 → 화면에서 발굽이 제자리에 박힌 채 몸이 앞으로 나감.
   * @returns 현재 속도(m/s, 표시 시각 기준)
   */
  private gaitStep(rig: Rig, f: Frame3D): number {
    const pos = rig.root.position;
    const dShow = f.showMs - rig.prevShow;
    let dist = 0;
    if (Number.isFinite(rig.prevX)) dist = Math.hypot(pos.x - rig.prevX, pos.z - rig.prevZ);
    // 새로고침·리플레이 시작처럼 크게 건너뛰면 위상만 이어 붙이고 속도 계산에서는 제외
    const jump = !(dShow > 0) || dist > 6;
    const v = jump ? (Number.isFinite(rig.prevShow) && dShow === 0 ? 0 : rig.run * 14) : (dist / dShow) * 1000;
    rig.prevX = pos.x;
    rig.prevZ = pos.z;
    rig.prevShow = f.showMs;
    if (!jump) rig.gait = (rig.gait + dist / this.stride) % 1;
    if (!f.paused) rig.run = approach(rig.run, Math.min(1, v / 5), Math.min(f.dt, 100), 180);

    const run = rig.run;
    const TAU = Math.PI * 2;
    const g = rig.gait;
    // 몸통: 네 발이 모두 뜬 순간(위상 ~0.95) 가장 높고, 앞다리가 받을 때 낮아짐. 뒷다리가 밀 때 앞이 들림
    let bob = run * (0.07 + 0.07 * Math.cos(TAU * (g - 0.95)));
    let pitch = run * 0.05 * Math.sin(TAU * (g - 0.15));
    let neck = -run * 0.12 * Math.sin(TAU * (g - 0.1));
    // ── 출발 대기 연출 (순수 화면 연출: 위치·속도·순위와 무관) ──
    //  3·2: 고개를 들썩이고 앞발을 구름 (말마다 다른 박자, 2초 전부터는 더 자주)
    //  1  : 뒷다리에 무게를 싣고 몸을 낮춤 → 출발! 에 앞으로 튀어 나감
    let paw = -1;
    let pawLeg = -1;
    if (f.mode === 'live' && f.elapsed < 700) {
      const rem = -f.elapsed;
      const crouch = f.elapsed < 0 ? smooth((1000 - rem) / 450) : 1 - smooth(f.elapsed / 300);
      bob -= 0.17 * crouch;
      pitch += 0.05 * crouch;
      neck += -0.12 * crouch;
      if (f.elapsed >= 0) {
        // 박차고 나가는 순간: 앞이 살짝 들렸다가 머리를 앞으로 뻗음
        const k = f.elapsed / 700;
        pitch += 0.09 * Math.sin(Math.PI * Math.min(1, k * 1.6)) * (1 - k);
        neck -= 0.2 * Math.sin(Math.PI * k);
      } else if (rem > 1000) {
        const busy = rem < 2000 ? 0.7 : 1; // 2초 전부터는 더 자주
        const toss = fidget(this.now, rig.lane, 1, 2300 * busy, 520);
        if (toss >= 0) neck += 0.32 * Math.sin(Math.PI * toss);
        paw = fidget(this.now, rig.lane, 2, 2900 * busy, 650);
        pawLeg = rig.lane % 2;
        const shift = Math.sin(this.now * 0.0021 + rig.lane * 1.7);
        pitch += 0.015 * shift;
      }
    }
    rig.horse.position.y = bob;
    rig.horse.rotation.z = pitch;
    rig.neck.rotation.z = neck;
    rig.tail.rotation.z = -0.6 - run * 0.5 + Math.sin(TAU * (g - 0.3)) * 0.18 * run;
    rig.shadow.scale.set(1.7 - bob * 1.2, 0.75, 1);

    // 다리 IK
    const A = Math.min(1.0, (STANCE * (this.stride / HS)) / 2) * run; // 딛는 동안 발굽이 말 기준으로 움직이는 반폭
    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    for (let li = 0; li < rig.legs.length; li++) {
      const leg = rig.legs[li]!;
      const u = (g + leg.off) % 1;
      let fx: number;
      let fy = 0; // 땅 높이 (말 루트 기준)
      if (u < STANCE) {
        fx = A * (1 - (2 * u) / STANCE);
      } else {
        const w = (u - STANCE) / (1 - STANCE);
        fx = -A + 2 * A * (w - Math.sin(TAU * w) / TAU);
        fy = run * (leg.front ? 0.62 : 0.42) * Math.pow(Math.sin(Math.PI * w), 0.9);
      }
      // 앞발 구르기: 들어 올려 앞으로 긁듯이 내림
      if (li === pawLeg && paw >= 0) {
        fx += 0.28 * Math.sin(Math.PI * paw);
        fy += 0.42 * Math.sin(Math.PI * Math.min(1, paw * 1.3));
      }
      // 엉덩이(어깨) 위치 (몸통이 오르내리고 기울어진 것 반영) → 엉덩이 기준 발굽 목표
      const hx = leg.hipX * cp - HIP_H * sp;
      const hy = leg.hipX * sp + HIP_H * cp + bob;
      const tx = leg.hipX + fx - hx;
      const ty = fy - hy;
      // 몸통 기울기만큼 되돌려 엉덩이 그룹 좌표로
      const lx = tx * cp + ty * sp;
      const ly = -tx * sp + ty * cp;
      const dd = Math.min(L1 + L2 - 0.001, Math.max(0.35, Math.hypot(lx, ly)));
      const gamma = Math.atan2(lx, -ly);
      const a = Math.acos(Math.min(1, Math.max(-1, (L1 * L1 + dd * dd - L2 * L2) / (2 * L1 * dd))));
      const kIn = Math.acos(Math.min(1, Math.max(-1, (L1 * L1 + L2 * L2 - dd * dd) / (2 * L1 * L2))));
      const bend = Math.PI - kIn;
      if (leg.front) {
        leg.hip.rotation.z = gamma + a;
        leg.knee.rotation.z = -bend;
      } else {
        leg.hip.rotation.z = gamma - a;
        leg.knee.rotation.z = bend;
      }
    }
    return v;
  }

  /** 출발선 구도: 게이트와 모든 말이 보이게 바깥 앞쪽에서 비스듬히 (lead·go: 출발 후 따라가기 시작) */
  private startView(pos: THREE.Vector3, look: THREE.Vector3, lead = 0, go = 0): void {
    const W = this.trackW;
    trackPoint(18 + W * 0.3 + lead * 0.7, W * 1.3 + 10 + go * 8, pos).setY(9 + W * 0.4);
    trackPoint(1 + lead * 0.9, W * 0.42, look).setY(1.5);
  }

  /** 경주 정보가 오기 전·대기 중: 같은 경기장의 출발선 구도 (평면 트랙 대신) */
  renderIdle(): void {
    this.gate.visible = this.rigs.length > 0;
    this.startView(this.camPos, this.camLook);
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);
    if (this.camera.fov !== 34) {
      this.camera.fov = 34;
      this.camera.updateProjectionMatrix();
    }
    this.renderer.render(this.scene, this.camera);
  }

  // ───────── 중계 카메라 ─────────
  private wantPos = new THREE.Vector3();
  private wantLook = new THREE.Vector3();

  private updateCamera(f: Frame3D, dt: number): void {
    const n = this.rigs.length;
    if (n === 0) {
      this.camera.position.set(140, 70, 120);
      this.camera.lookAt(140, 0, 0);
      return;
    }
    const W = this.trackW;
    const s = (i: number) => f.prog[i]! * 1000;
    const order = f.ranking.length === n ? f.ranking : this.rigs.map((_, i) => i);
    const lead = s(order[0]!);
    // 선두권(앞쪽 절반, 선두와 70m 이내)의 범위
    let tail = lead;
    for (let r = 0; r < Math.max(1, Math.ceil(n * 0.6)); r++) tail = Math.min(tail, Math.max(lead - 70, s(order[r]!)));
    const spread = lead - tail;
    let speedK = 260; // 위치 따라가는 부드러움(ms)

    if (f.mode === 'replay' || f.mode === 'over' || f.finishLock) {
      // 결승선 고정 카메라: 결승선 바깥 옆에서, 말이 왼쪽에서 들어와 결승선(화면 오른쪽)을 통과
      const over = f.mode === 'over';
      const replay = f.mode === 'replay';
      // 전원 도착 후: 결승선을 지나 멈춘 말들 쪽으로 (결승선은 화면 왼쪽, 1~3위 표시가 잘 보이게)
      const dist = replay ? 34 : over ? 44 : 50;
      trackPoint(over ? 1030 : 982, W + dist, this.wantPos).setY(replay ? 13 : over ? 15 : 20);
      trackPoint(over ? 1030 + 2 : 988, W * 0.45, this.wantLook).setY(1);
      speedK = replay ? 120 : 600;
      // 접전: 선두가 결승선에 닿기 전, 2·3위가 선두와 12m 안이면 결승선과 경쟁 중인 말들만 함께 담도록 당겨 잡음
      if (!over && !replay && lead < 1000) {
        let tailS = lead;
        let close = 0;
        for (let r = 1; r < Math.min(3, n); r++) {
          const sr = s(order[r]!);
          if (lead - sr <= 12) {
            tailS = Math.min(tailS, sr);
            close++;
          }
        }
        if (close > 0) {
          const from = Math.min(tailS, lead) - 7; // 뒤쪽 경쟁 말의 꼬리까지
          const span = 1000 + 3 - from; // ~ 결승선 너머 조금
          const mid = (from + 1003) / 2;
          const d2 = Math.min(50, Math.max(24, span * 0.95 + 10));
          trackPoint(mid - 3, W + d2, this.wantPos).setY(8 + d2 * 0.22);
          trackPoint(mid + 2, W * 0.45, this.wantLook).setY(1.2);
          speedK = 380;
        }
      }
    } else if (f.elapsed < 0) {
      // 카운트다운: 3 게이트 전체(천천히 다가감) → 2 비스듬히 게이트 쪽으로 당김 → 1 게이트에 고정
      const rem = -f.elapsed;
      const drift = smooth((5000 - Math.min(5000, rem)) / 3000); // 5초 → 2초 동안 천천히
      this.startView(this.wantPos, this.wantLook, 0, 0);
      const wideP = this.wantPos.clone();
      const wideL = this.wantLook.clone();
      const close = smooth((2000 - rem) / 900); // 2 → 1 사이에 다가가서 1 에서는 고정
      const nearP = trackPoint(10 + W * 0.15, W * 0.95 + 10, new THREE.Vector3()).setY(6 + W * 0.16);
      const nearL = trackPoint(0, W * 0.55, new THREE.Vector3()).setY(2.6);
      // 3 구간의 느린 접근: 넓은 구도에서 가까운 구도 쪽으로 15% 까지
      const k = Math.max(close, drift * 0.15);
      this.wantPos.copy(wideP).lerp(nearP, k);
      this.wantLook.copy(wideL).lerp(nearL, k);
      speedK = rem > 4600 ? 1 : 220; // 카운트다운 시작 첫 순간엔 바로 그 구도
    } else if (f.elapsed < 2600) {
      // 출발: 게이트와 출전마 전체가 보이는 넓은 구도 (앞·옆이 함께 보이게 비스듬히)
      const go = smooth((f.elapsed - 300) / 2200);
      this.startView(this.wantPos, this.wantLook, lead, go);
      // 출발: 게이트에 고정됐던 가까운 구도에서 기존 주행 카메라로 부드럽게 넘어감
      speedK = 420;
    } else {
      // 주행: 무리의 옆뒤 바깥에서 비스듬히 따라감 (코너에서는 트랙 방향으로 돌아감)
      const focusS = (lead + tail) / 2 + 4;
      const dist = Math.min(92, Math.max(40, spread * 0.75 + 26 + W * 0.35));
      // 코너를 빠져나오면 앞쪽 결승 직선이 펼쳐지게 조금 더 앞을 봄
      const exitK = smooth((lead - S2) / 30) * (1 - smooth((lead - S2 - 120) / 60));
      trackPoint(focusS - dist * 0.22, W + dist * 0.82, this.wantPos).setY(dist * 0.4);
      trackPoint(focusS + 8 + exitK * 40, W * 0.45, this.wantLook).setY(1.5);
    }

    // 코너 진입: 선두가 코너에 들어서면 2.8초간 무리의 옆뒤 바깥에서 낮게 따라감 (광각 → 원근이 확실히 보임)
    const live = f.mode === 'live' && !f.finishLock && f.elapsed >= 2600;
    if (!live || lead < S1) this.corner.done = lead >= S1 + 60;
    if (live && !this.corner.done && lead >= S1 + 8) {
      this.corner.done = true;
      this.corner.until = this.now + 2800;
    }
    const cw = live && this.now < this.corner.until ? 1 : 0;
    this.corner.w = approach(this.corner.w, cw, dt, cw ? 260 : 520);
    if (this.corner.w > 0.01) {
      // 무리 가운데(앞쪽 절반의 중간)를 기준으로, 바깥 난간 바로 밖 낮은 위치에서 진행 방향 앞쪽을 봄
      const mid = (lead + s(order[Math.min(n - 1, Math.floor(n * 0.25))]!)) / 2;
      const cp = trackPoint(mid - 18, W + 8, new THREE.Vector3()).setY(5);
      const cl = trackPoint(mid + 16, W * 0.4, new THREE.Vector3()).setY(2.2);
      this.wantPos.lerp(cp, this.corner.w);
      this.wantLook.lerp(cl, this.corner.w);
    }

    // 추월·각성: 해당 말과 바로 앞뒤 말이 함께 보이게 짧게 당겨 잡음 → 다시 전체 구도로
    const fw = this.focus.lane >= 0 && this.now < this.focus.until && live && this.corner.w < 0.5 ? 1 : 0;
    this.focus.w = approach(this.focus.w, fw, dt, fw ? 220 : 380);
    if (this.focus.w > 0.01 && this.focus.lane >= 0) {
      const r = order.indexOf(this.focus.lane);
      const group = [order[r - 1], this.focus.lane, order[r + 1]].filter((x): x is number => x !== undefined);
      let lo = Infinity;
      let hi = -Infinity;
      let dl = 0;
      for (const g of group) {
        lo = Math.min(lo, s(g));
        hi = Math.max(hi, s(g));
        dl += this.rigs[g]!.d;
      }
      dl /= group.length;
      const span = Math.min(30, hi - lo + 6);
      const mid = (lo + hi) / 2;
      // 바깥 난간 밖에서 당겨 잡음 → 다른 말 사이로 카메라가 파고들지 않음
      const fp = trackPoint(mid - 5, W + 12 + span * 0.9, new THREE.Vector3()).setY(7 + span * 0.2);
      const fl = trackPoint(mid + 1, dl, new THREE.Vector3()).setY(2.6);
      this.wantPos.lerp(fp, this.focus.w);
      this.wantLook.lerp(fl, this.focus.w);
    }

    // 새로고침·탭 복귀로 멀리 건너뛰면 날아가지 않고 바로 그 구도로
    const jump = this.camPos.distanceTo(this.wantPos) > 120;
    const k = jump ? 1 : 1 - Math.exp(-dt / speedK);
    if (jump) this.camLook.copy(this.wantLook);
    this.camPos.lerp(this.wantPos, speedK <= 1 ? 1 : k);
    this.camLook.lerp(this.wantLook, speedK <= 1 ? 1 : Math.min(1, k * 1.6));
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);
    // 가까이 잡을 때는 화각을 좁혀(망원) 해당 말을 크게
    // 코너 낮은 장면은 광각(가까운 말 크게·먼 말 작게), 추월 장면은 살짝 망원
    const fov = 34 + this.corner.w * 16 - this.focus.w * 6;
    if (Math.abs(this.camera.fov - fov) > 0.05) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }
}

/** 이 환경에서 WebGL 3D 를 쓸 수 있는가 */
export function canUse3D(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}
