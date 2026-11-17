import Phaser from 'phaser';
import { EVENT_SPECS, type EventType, type RaceEvent } from '../engine';

/**
 * 개그 이벤트 시각 효과 — "깔끔하게, 하지만 지루하지 않게"
 *  - 모든 이벤트: 말 머리 위에 작은 아이콘 하나 (살짝 통통)
 *  - 가속 이벤트(당근·방귀·미친 질주·각성): 말 뒤로 짧은 꼬리 효과 하나
 *  - 감속 이벤트(바나나·졸음·거북이·탈주): 색만 살짝 변함 (말 동작은 RaceScene 이 처리)
 *  - 화면 흔들림·트랙 위 소품 같은 산만한 연출은 넣지 않음
 *
 * 어떤 효과를 보여줄지는 "지금 틱에 진행 중인 이벤트"(결정론적)로만 정한다
 *  → 모든 화면이 같은 순간 같은 효과, 새로고침해도 진행 중 효과가 그대로 다시 나타남.
 * 효과는 순수 연출이고 경주 결과에는 영향이 없다.
 */

export interface HorseHandle {
  container: Phaser.GameObjects.Container;
  sprite: Phaser.GameObjects.Image;
  coat: number;
}

interface ActiveFx {
  type: EventType;
  startTick: number;
  children: Phaser.GameObjects.GameObject[];
  emitter: Phaser.GameObjects.Particles.ParticleEmitter | null;
}

/** 가속 이벤트의 꼬리 색 */
const TRAIL: Partial<Record<EventType, { tint: number[]; texture: 'fx-dot' | 'fx-puff' }>> = {
  CARROT: { tint: [0xff9a2e, 0xffd27a], texture: 'fx-dot' },
  CRAZY: { tint: [0xff4a26, 0xffb01a], texture: 'fx-dot' },
  AWAKEN: { tint: [0xf5c542, 0xff6a3a], texture: 'fx-dot' },
  FART: { tint: [0xa8c96a, 0xc2b47a], texture: 'fx-puff' },
  SPURT: { tint: [0xffffff, 0xf5c542], texture: 'fx-dot' },
};

/** 감속·정지 이벤트 동안 말 색 */
const TINT: Partial<Record<EventType, number>> = {
  TURTLE: 0x7fbf7f,
  SLEEP: 0x9aa6c8,
  CRAZY: 0xff7a5c,
  AWAKEN: 0xff7070,
};

export function createFxTextures(scene: Phaser.Scene): void {
  if (scene.textures.exists('fx-dot')) return;
  const g = scene.make.graphics({ x: 0, y: 0 }, false);
  g.fillStyle(0xffffff, 1);
  g.fillCircle(8, 8, 8);
  g.generateTexture('fx-dot', 16, 16);
  g.destroy();

  const radial = (key: string, size: number) => {
    const tex = scene.textures.createCanvas(key, size, size);
    if (!tex) return;
    const ctx = tex.getContext();
    const grd = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grd.addColorStop(0, 'rgba(255,255,255,0.95)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, size, size);
    tex.refresh();
  };
  radial('fx-puff', 64);
  radial('fx-aura', 160);
}

export class EventEffects {
  private active = new Map<number, ActiveFx>();

  /** @param trails false 면 꼬리·오라 효과 생략 (3D 중계에서는 3D 말이 직접 연출) */
  constructor(
    private readonly scene: Phaser.Scene,
    private readonly trails = true,
  ) {}

  /** 경주 교체·종료 시 전부 정리 */
  reset(horses: HorseHandle[]): void {
    for (const lane of [...this.active.keys()]) this.end(lane, horses[lane]);
  }

  /** 매 틱: 진행 중 이벤트와 현재 효과를 맞춘다 (바뀐 것만 만들고 지움) */
  sync(events: Map<number, RaceEvent>, horses: HorseHandle[]): void {
    for (const [lane, fx] of this.active) {
      const ev = events.get(lane);
      if (!ev || ev.type !== fx.type || ev.tick !== fx.startTick) this.end(lane, horses[lane]);
    }
    for (const [lane, ev] of events) {
      const h = horses[lane];
      if (h && !this.active.has(lane)) this.start(lane, ev, h);
    }
  }

  private start(lane: number, ev: RaceEvent, h: HorseHandle): void {
    const s = this.scene;
    const fx: ActiveFx = { type: ev.type, startTick: ev.tick, children: [], emitter: null };

    // 1) 아이콘 하나: 흰 원 배경 위 이모지 → 어떤 말 색 위에서도 잘 보임
    const badge = s.add.circle(0, 0, 22, 0xffffff, 0.92).setStrokeStyle(3, EVENT_SPECS[ev.type].good ? 0xf5c542 : 0x5a5a6a);
    const emoji = s.add.text(0, 1, EVENT_SPECS[ev.type].emoji, { fontSize: '26px' }).setOrigin(0.5);
    // 처음부터 읽을 수 있는 크기로 시작 (느린 PC 에서 애니메이션이 덜 진행돼도 아이콘이 작아지지 않게)
    const icon = s.add.container(-30, -104, [badge, emoji]).setScale(1.3); // 기수 머리 위
    h.container.add(icon);
    fx.children.push(icon);
    s.tweens.add({ targets: icon, scale: 1, duration: 220, ease: 'Quad.Out' });
    s.tweens.add({ targets: icon, y: -110, duration: 420, yoyo: true, repeat: -1, ease: 'Sine.InOut', delay: 260 });

    // 2) 각성만: 말 뒤 붉은 오라
    if (this.trails && ev.type === 'AWAKEN') {
      const aura = s.add.image(-48, -34, 'fx-aura').setTint(0xff2a2a).setBlendMode(Phaser.BlendModes.ADD).setScale(1.3, 0.8);
      h.container.addAt(aura, 0);
      fx.children.push(aura);
      s.tweens.add({ targets: aura, alpha: { from: 0.9, to: 0.5 }, scaleX: 1.6, duration: 420, yoyo: true, repeat: -1 });
    }

    // 3) 가속 이벤트: 꼬리 효과 하나
    const trail = this.trails ? TRAIL[ev.type] : undefined;
    if (trail) {
      const puff = trail.texture === 'fx-puff';
      const e = s.add
        .particles(0, 0, trail.texture, {
          tint: trail.tint,
          speed: puff ? { min: 15, max: 45 } : { min: 80, max: 170 },
          angle: { min: 168, max: 192 },
          lifespan: puff ? 800 : 380,
          scale: puff ? { start: 0.3, end: 1.1 } : { start: 0.8, end: 0 },
          alpha: puff ? { start: 0.6, end: 0 } : { start: 1, end: 0 },
          frequency: puff ? 90 : 30,
          blendMode: puff ? 'NORMAL' : 'ADD',
        })
        .setDepth(9);
      // 말 크기(배율)에 맞춰 엉덩이 뒤에서 나오게
      const k = h.container.scaleX || 1;
      e.startFollow(h.container, -88 * k, -30 * k);
      fx.emitter = e;
    }

    // 4) 색 변화
    const tint = TINT[ev.type];
    if (tint !== undefined) h.sprite.setTint(tint);

    this.active.set(lane, fx);
  }

  private end(lane: number, h: HorseHandle | undefined): void {
    const fx = this.active.get(lane);
    if (!fx) return;
    this.active.delete(lane);
    for (const c of fx.children) {
      this.scene.tweens.killTweensOf(c);
      c.destroy();
    }
    if (fx.emitter) {
      const e = fx.emitter;
      e.stop(); // 이미 나온 입자는 자연스럽게 사라지게
      this.scene.time.delayedCall(1000, () => e.destroy());
    }
    h?.sprite.setTint(h.coat).setAlpha(1);
  }
}
