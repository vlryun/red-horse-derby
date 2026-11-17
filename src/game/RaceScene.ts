import Phaser from 'phaser';
import {
  EVENT_SPECS,
  TICK_MS,
  TRACK_LENGTH,
  activeEventsAtTick,
  eventsBetween,
  finishedCountAtTick,
  rankingAtTick,
  positionAtTick,
  sampleProgress,
  tickAt,
  TACTIC_SPECS,
  tacticWindows,
  type EventType,
  type RaceResult,
  type TacticType,
  type TacticWindow,
} from '../engine';
import type { RaceClock } from './clock';
import type { Anchor, Race3D } from '../game3d/Race3D';
import { EventEffects, createFxTextures } from './effects';
import { sfx } from './sfx';
import { THEME, coatColor, hex, horseColor } from './palette';
import { GALLOP_FRAMES, HORSE_H, HORSE_W, createHorseTextures } from './textures';

/** 16:9 행사장 화면 기준 좌표 */
export const VIEW_W = 1920;
export const VIEW_H = 1080;

const HEADER_H = 100;
const TRACK_TOP = 128;
const TRACK_BOTTOM = 984;
const TRACK_X0 = 30;
const PANEL_W = 340; // TOP 5 패널 (기존 TOP 10: 460) → 트랙 120px 넓어짐
const PANEL_X = VIEW_W - PANEL_W - 20;
const TRACK_X1 = PANEL_X - 30;
/** 경주 중 순위 패널에 보여줄 인원 (최종 결과표는 전체 순위) */
const TOP_N = 5;
const MINI_Y = 1032;

const FONT_TITLE = '"Black Han Sans", "Noto Sans KR", sans-serif';
const FONT_BODY = '"Noto Sans KR", sans-serif';

/** 배율 1 에서 말+기수의 화면 높이(px) */
const HORSE_VIS_H = 86;
/** 출발 게이트: 문 열림(ms) · 사라지기 시작 · 완전히 사라짐 (경주 시각 0 = 출발 기준, 서버 시계 그대로) */
const GATE_OPEN_MS = 240;
const GATE_FADE_FROM = 1300;
const GATE_GONE_AT = 2200;
/** 출발 후 게이트 배율 → 주행 배율로 커지는 구간 (ms) */
const GROW_FROM = 450;
const GROW_MS = 2000;
/** 결승선 고정 카메라: 결승선을 화면 폭의 이 위치에 고정 */
const FINISH_AT = 0.8;

/**
 * 2.5D 곡선 트랙: 출발 직선 → 크게 휘는 코너 → 긴 결승 직선 (진행률 기준 구간)
 * 엔진의 주행 거리(진행률)를 화면 좌표로 바꾸는 "보이는 모양"일 뿐 → 속도·순위와 무관.
 * 카메라는 트랙 바깥쪽에서 말을 따라가며 바라봄: 코너 구간은 화면 쪽으로 불룩한 호로 보이고(안쪽 레인이 멀리),
 * 말과 기수는 코너를 따라 기울어 달린다.
 */
const CORNER_FROM = 0.28;
const CORNER_TO = 0.62;
/** 코너가 화면에서 휘어 보이는 정도 (1 = 실제 반원) · 최대 기울기(라디안) */
const BEND_GAIN = 0.55;
const MAX_THETA = 0.45;
/** 코너를 볼 때 트랙 폭을 이만큼 눌러 비스듬한 카메라처럼 (원근감) */
const LAT_SQUASH = 0.2;
const BEND_N = 97;
const MID_Y = (TRACK_TOP + TRACK_BOTTOM) / 2;

interface GateLayout {
  bands: { top: number; bot: number }[];
  top: number;
  bottom: number;
  stallLen: number;
}


interface HorseView {
  container: Phaser.GameObjects.Container;
  sprite: Phaser.GameObjects.Image;
  jockey: Phaser.GameObjects.Image;
  badge: Phaser.GameObjects.Text;
  coat: number;
  /** 말 크기 배율 (참가 인원이 적을수록 크게) */
  scale: number;
  /** 출발 게이트 안에서의 배율 (위아래 말이 덜 겹치게 작게 → 출발 후 scale 로 커짐) */
  startScale: number;
  laneY: number;
  phase: number;
  prevP: number;
  /** 이번 프레임 등번호 위치 (겹침 정리용) · 부드럽게 비켜 선 거리 · 투명도 */
  bx: number;
  by: number;
  badgeDy: number;
  badgeA: number;
  /** 작전 아이콘 (등번호 왼쪽) */
  chip: Phaser.GameObjects.Text;
}

export interface RaceSceneOptions {
  /** 참가자 작전(v4) 연출 — 비상 모드·데모는 끔 */
  tactics?: boolean;
}

interface RankRow {
  bg: Phaser.GameObjects.Rectangle;
  rank: Phaser.GameObjects.Text;
  chip: Phaser.GameObjects.Arc;
  num: Phaser.GameObjects.Text;
  name: Phaser.GameObjects.Text;
}

export interface RaceSceneCallbacks {
  onFinished?: (r: RaceResult) => void;
  /** 결승 연출(리플레이·세리머니)이 끝나 결과표를 띄워도 되는 시점 */
  onPresentationDone?: (r: RaceResult) => void;
}

export class RaceScene extends Phaser.Scene {
  private race: RaceResult | null = null;
  private clock: RaceClock | null = null;
  private callbacks: RaceSceneCallbacks = {};
  private ready = false;
  private pending: { race: RaceResult | null; clock: RaceClock | null; opts: RaceSceneOptions } | null = null;

  private horses: HorseView[] = [];
  private progressBuf = new Float64Array(50);
  private camStart = -0.02;
  private camWidth = 0.16;
  private lastTick = -1;
  private finishedNotified = false;
  private winnerShown = false;
  private lastFrameAt = 0;
  private lastShowTick = -1;
  private effects!: EventEffects;
  private awakenBanner!: Phaser.GameObjects.Container;
  /** 연출 진행 상태 (경주마다 초기화) */
  private lastCountSec = -1;
  private lastLeader = -1;
  private lastLeadCallTick = -1000;
  private finalStretchShown = false;
  /** 출발 게이트 (경주마다 다시 그림) */
  private gate: GateLayout | null = null;
  private gateBack!: Phaser.GameObjects.Graphics;
  private gateFront!: Phaser.GameObjects.Graphics;
  private gateNums!: Phaser.GameObjects.Container;
  private gateDoorK = -1;
  /** 출발 직전 카메라 시작점 (게이트와 번호판이 화면 안에 다 들어오게) */
  private gateCam = -0.02;
  /** 결승선 고정 카메라 (선두가 결승선 가까이 오면 켜지고 그 경주 끝까지 유지) */
  private finishLock = false;
  /** 모든 말이 들어온 뒤: 결승선 너머에 멈춘 말들이 보이도록 카메라를 조금 넓게 · 1~3위 표시 */
  private raceOver = false;
  private podiumShown = false;
  /** 1~3위 순위 표시 (말 오른쪽, 맨 위 레이어) · 레인 → 순위(0..2) */
  private podiumTags: { lane: number; tag: Phaser.GameObjects.Text }[] = [];
  private podiumRank = new Map<number, number>();
  /** 등번호는 말 위 별도 레이어 → 말끼리 겹쳐도 번호는 가려지지 않음 */
  private badgeLayer!: Phaser.GameObjects.Container;
  private awakenGlow!: Phaser.GameObjects.Rectangle;
  private lockW = 0.2;
  private stretchCaption!: Phaser.GameObjects.Container;
  /** 작전 타임 안내 띠 (트랙 아래) */
  private tacticBar!: Phaser.GameObjects.Container;
  private tacticBarKey = '';
  private tacticsOn = false;
  private windows: TacticWindow[] = [];
  private lastRanking: number[] = [];
  /** 곡선 트랙 표 (매 프레임 카메라 기준으로 다시 계산) */
  private bend = {
    p0: 0,
    dp: 1,
    pxPerP: 1,
    theta: new Float64Array(BEND_N),
    y: new Float64Array(BEND_N),
    shift: 0,
    latK: 1,
    corner: 0,
  };
  /** sampleBend / project 결과 (GC 줄이려고 필드에) */
  private bt = 0;
  private by = 0;
  private px = 0;
  private py = 0;
  private pTheta = 0;
  private placed: number[] = [];
  /** 3D 첫 화면 전 가림막 */
  private prepCover!: Phaser.GameObjects.Container;
  private lastIdle3d = 0;
  /** 3D 중계 렌더러 (없으면 기존 2D 트랙). 말·트랙·카메라는 3D 가, 번호·자막·순위표는 이 장면이 그림 */
  private view3d: Race3D | null = null;
  private anchors: Anchor[] | null = null;

  /** Phaser 시작 전에 호출: 3D 렌더러 연결 */
  attach3d(view: Race3D | null): void {
    this.view3d = view;
  }

  /** 결승 연출 단계: live → replay(슬로모션 리플레이) → ceremony(우승 세리머니) → done */
  private show: 'live' | 'replay' | 'ceremony' | 'done' = 'live';
  private replay = { from: 0, to: 0, startedAt: 0, pausedAt: 0, pausedTotal: 0, winnerCrossed: false };
  private letterbox!: Phaser.GameObjects.Container;
  private ceremony: Phaser.GameObjects.Container | null = null;
  private confetti: Phaser.GameObjects.Particles.ParticleEmitter | null = null;
  private finishFlag!: Phaser.GameObjects.Text;
  /** 이벤트·중계를 크게 한 줄로 (동시에 여러 개면 짧은 대기열) */
  private eventLine!: Phaser.GameObjects.Container;
  private lineQueue: { label: string; style: 'good' | 'bad' | 'call'; prio: number }[] = [];
  private lineBusyUntil = 0;
  private linePrio = 0;
  private lineSeq = 0;
  /** 중계: 선두 탈환(0.5초 이상 유지된 새 선두) · 큰 추월 */
  private leadCand = -1;
  private leadCandSince = 0;
  /** 새 선두 후보가 이전 선두보다 가장 크게 앞선 거리 (실제 추월 판정) · 말별 마지막 자막 틱 */
  private leadCandMargin = 0;
  private leadCalledAt = new Map<number, number>();
  /** 작전 적용 순간 등번호 강조 (레인 → 끝나는 시각) */
  private badgeFlash = new Map<number, number>();
  private lastPassCallTick = -1000;
  private dust!: Phaser.GameObjects.Particles.ParticleEmitter;

  private trackGfx!: Phaser.GameObjects.Graphics;
  private miniGfx!: Phaser.GameObjects.Graphics;
  private finishLine!: Phaser.GameObjects.TileSprite;
  private markerTexts: Phaser.GameObjects.Text[] = [];
  private rows: RankRow[] = [];
  private timerText!: Phaser.GameObjects.Text;
  private statusText!: Phaser.GameObjects.Text;
  private bigText!: Phaser.GameObjects.Text;
  private pauseOverlay!: Phaser.GameObjects.Container;
  private winnerBanner!: Phaser.GameObjects.Container;
  private horseLayer!: Phaser.GameObjects.Container;

  constructor() {
    super('race');
  }

  /** React 에서 호출: 경주 교체 (null = 대기 화면) */
  setRace(race: RaceResult | null, clock: RaceClock | null, callbacks: RaceSceneCallbacks = {}, opts: RaceSceneOptions = {}): void {
    this.callbacks = callbacks;
    this.tacticsOn = !!opts.tactics && !!race && race.engineVersion >= 4;
    this.windows = race && this.tacticsOn ? tacticWindows(race.raceSeconds, race.engineVersion) : [];
    if (!this.ready) {
      this.pending = { race, clock, opts };
      return;
    }
    // 같은 경주에 마감된 작전이 더해져 다시 계산된 것: 화면 상태는 그대로 두고 데이터만 교체
    // (작전은 적용 틱 이후만 바꾸므로 이미 보여준 장면·이벤트는 같음)
    if (this.race && race && race !== this.race && clock === this.clock && sameRace(this.race, race)) {
      this.race = race;
      return;
    }
    this.race = race;
    this.clock = clock;
    this.lastTick = -1;
    this.finishedNotified = false;
    this.winnerShown = false;
    this.camStart = -0.02;
    this.camWidth = 0.16;
    this.winnerBanner.setVisible(false);
    this.awakenBanner.setVisible(false);
    this.clearLine();
    this.lastCountSec = -1;
    this.lastLeader = -1;
    this.lastLeadCallTick = -1000;
    this.leadCand = -1;
    this.leadCandSince = 0;
    this.leadCandMargin = 0;
    this.leadCalledAt.clear();
    this.badgeFlash.clear();
    this.lastPassCallTick = -1000;
    this.finalStretchShown = false;
    this.finishLock = false;
    this.raceOver = false;
    this.podiumShown = false;
    this.podiumTags.forEach((t) => t.tag.destroy());
    this.podiumTags = [];
    this.podiumRank.clear();
    this.tweens.killTweensOf(this.stretchCaption);
    this.stretchCaption.setVisible(false);
    this.tacticBar.setVisible(false);
    this.tacticBarKey = '';
    this.lastRanking = [];
    this.endCeremony(true);
    this.show = 'live';
    this.lastShowTick = -1;
    this.letterbox.setVisible(false);
    this.buildHorses();
    this.view3d?.setRace(race ? race.entrants : [], race?.raceSeconds ?? 70);
  }

  create(): void {
    createHorseTextures(this);
    createFxTextures(this);
    this.effects = new EventEffects(this, !this.view3d);
    if (!this.view3d) this.cameras.main.setBackgroundColor(THEME.redDeep);

    this.drawStatic();
    this.trackGfx = this.add.graphics().setDepth(1);
    for (let i = 0; i < 14; i++) {
      this.markerTexts.push(
        this.add
          .text(0, 0, '', {
            fontFamily: FONT_TITLE,
            fontSize: '26px',
            color: '#fff6e0',
            stroke: '#5a3a1a',
            strokeThickness: 5,
          })
          .setOrigin(0.5)
          .setDepth(2),
      );
    }
    this.finishLine = this.add
      .tileSprite(0, TRACK_TOP, 20, TRACK_BOTTOM - TRACK_TOP, 'checker')
      .setOrigin(0.5, 0)
      .setDepth(3);
    this.finishFlag = this.add
      .text(0, TRACK_TOP + 4, '🏁 FINISH', {
        fontFamily: FONT_TITLE,
        fontSize: '30px',
        color: hex(THEME.gold),
        backgroundColor: '#1a0505',
        padding: { x: 10, y: 4 },
      })
      .setOrigin(0.5, 0)
      .setDepth(4)
      .setVisible(false);
    // 출발 게이트: 칸 바닥(말 뒤) · 칸막이와 문(말 앞) · 번호판(가장 위 레이어 → 말이 겹쳐도 번호는 항상 보임)
    this.gateBack = this.add.graphics().setDepth(5).setVisible(false);
    this.gateFront = this.add.graphics().setDepth(11).setVisible(false);
    this.gateNums = this.add.container(0, 0).setDepth(12).setVisible(false);
    this.horseLayer = this.add.container(0, 0).setDepth(10);
    this.badgeLayer = this.add.container(0, 0).setDepth(11.5);
    // 달리는 말 발굽 흙먼지 (하나의 이미터를 모든 말이 공유 → 가벼움)
    this.dust = this.add
      .particles(0, 0, 'fx-puff', {
        emitting: false,
        lifespan: 550,
        speedX: { min: -110, max: -40 },
        speedY: { min: -30, max: -6 },
        scale: { start: 0.16, end: 0.5 },
        alpha: { start: 0.38, end: 0 },
        tint: [0xc8a070, 0xb08a5a, 0xd8b88a],
      })
      .setDepth(9);
    this.miniGfx = this.add.graphics().setDepth(20);

    this.buildHeader();
    this.buildPanel();
    this.buildOverlays();
    // 3D 중계: 카운트다운 숫자는 관중석 쪽(위)으로 → 게이트의 등번호를 가리지 않음
    if (this.view3d) this.bigText.setY(TRACK_TOP + 150).setFontSize(170);
    const coverBg = this.add.rectangle((PANEL_X - 10) / 2, (HEADER_H + VIEW_H) / 2, PANEL_X - 10, VIEW_H - HEADER_H, THEME.redDeep, 1);
    const coverText = this.add
      .text((PANEL_X - 10) / 2, (HEADER_H + VIEW_H) / 2, '🏇 경주 준비 중…', { fontFamily: FONT_TITLE, fontSize: '72px', color: hex(THEME.gold) })
      .setOrigin(0.5);
    this.prepCover = this.add.container(0, 0, [coverBg, coverText]).setDepth(29).setVisible(false);

    this.ready = true;
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      this.setRace(p.race, p.clock, this.callbacks, p.opts);
    }
  }

  // ───────────────────────── 정적 요소 ─────────────────────────

  private drawStatic(): void {
    const g = this.add.graphics().setDepth(0);
    // 잔디 (3D 중계면 3D 장면이 대신 그림)
    if (!this.view3d) {
      g.fillStyle(THEME.grass, 1);
      g.fillRect(0, HEADER_H, PANEL_X - 10, VIEW_H - HEADER_H);
    }
    // 흙 트랙·안쪽 잔디·난간은 곡선에 맞춰 매 프레임 drawTrack 에서
    // 미니맵 바탕
    g.fillStyle(0x000000, 0.35);
    g.fillRoundedRect(TRACK_X0, MINI_Y - 26, TRACK_X1 - TRACK_X0, 52, 14);
  }

  private buildHeader(): void {
    const g = this.add.graphics().setDepth(30);
    g.fillGradientStyle(THEME.redDark, THEME.redDark, THEME.red, THEME.red, 1);
    g.fillRect(0, 0, VIEW_W, HEADER_H);
    g.fillStyle(THEME.gold, 1);
    g.fillRect(0, HEADER_H - 6, VIEW_W, 6);

    this.add
      .text(36, HEADER_H / 2 - 3, '붉은 말의 대질주', {
        fontFamily: FONT_TITLE,
        fontSize: '60px',
        color: hex(THEME.gold),
        stroke: hex(THEME.redDeep),
        strokeThickness: 8,
      })
      .setOrigin(0, 0.5)
      .setDepth(31);

    this.timerText = this.add
      .text(VIEW_W / 2 + 120, HEADER_H / 2 - 3, '00:00.0', {
        fontFamily: FONT_TITLE,
        fontSize: '56px',
        color: '#ffffff',
        stroke: hex(THEME.redDeep),
        strokeThickness: 6,
      })
      .setOrigin(0.5)
      .setDepth(31);

    this.statusText = this.add
      .text(VIEW_W - 36, HEADER_H / 2 - 3, '대기 중', {
        fontFamily: FONT_TITLE,
        fontSize: '44px',
        color: hex(THEME.cream),
      })
      .setOrigin(1, 0.5)
      .setDepth(31);
  }

  private buildPanel(): void {
    const g = this.add.graphics().setDepth(30);
    g.fillStyle(0x1a0505, 0.92);
    g.fillRoundedRect(PANEL_X, TRACK_TOP - 12, PANEL_W, VIEW_H - TRACK_TOP - 12, 20);
    g.lineStyle(5, THEME.gold, 1);
    g.strokeRoundedRect(PANEL_X, TRACK_TOP - 12, PANEL_W, VIEW_H - TRACK_TOP - 12, 20);

    this.add
      .text(PANEL_X + PANEL_W / 2, TRACK_TOP + 34, `TOP ${TOP_N}`, {
        fontFamily: FONT_TITLE,
        fontSize: '52px',
        color: hex(THEME.gold),
      })
      .setOrigin(0.5)
      .setDepth(31);

    const y0 = TRACK_TOP + 80;
    const rowH = Math.floor((VIEW_H - 24 - y0) / TOP_N);
    for (let i = 0; i < TOP_N; i++) {
      const top = y0 + i * rowH;
      const bg = this.add
        .rectangle(PANEL_X + PANEL_W / 2, top + rowH / 2, PANEL_W - 24, rowH - 12, 0xffffff, i % 2 === 0 ? 0.07 : 0.03)
        .setDepth(31);
      const rank = this.add
        .text(PANEL_X + 46, top + rowH * 0.32, `${i + 1}`, { fontFamily: FONT_TITLE, fontSize: '60px', color: '#ffffff' })
        .setOrigin(0.5)
        .setDepth(32);
      const chip = this.add.circle(PANEL_X + 128, top + rowH * 0.32, 36, 0x888888).setStrokeStyle(5, 0xffffff).setDepth(32);
      const num = this.add
        .text(PANEL_X + 128, top + rowH * 0.32, '', {
          fontFamily: FONT_TITLE,
          fontSize: '40px',
          color: '#ffffff',
          stroke: '#1a0a0a',
          strokeThickness: 5,
        })
        .setOrigin(0.5)
        .setDepth(33);
      const name = this.add
        .text(PANEL_X + 24, top + rowH * 0.72, '', { fontFamily: FONT_BODY, fontSize: '42px', color: '#ffffff', fontStyle: '900' })
        .setOrigin(0, 0.5)
        .setDepth(32);
      this.rows.push({ bg, rank, chip, num, name });
    }
  }

  private buildOverlays(): void {
    this.bigText = this.add
      .text((TRACK_X0 + TRACK_X1) / 2, (TRACK_TOP + TRACK_BOTTOM) / 2, '', {
        fontFamily: FONT_TITLE,
        fontSize: '220px',
        color: hex(THEME.gold),
        stroke: hex(THEME.redDeep),
        strokeThickness: 18,
        align: 'center',
      })
      .setOrigin(0.5)
      .setDepth(50);

    const dim = this.add.rectangle(VIEW_W / 2, VIEW_H / 2, VIEW_W, VIEW_H, 0x000000, 0.55);
    const pt = this.add
      .text(VIEW_W / 2, VIEW_H / 2, '⏸ 일시정지', {
        fontFamily: FONT_TITLE,
        fontSize: '140px',
        color: '#ffffff',
        stroke: '#000000',
        strokeThickness: 12,
      })
      .setOrigin(0.5);
    this.pauseOverlay = this.add.container(0, 0, [dim, pt]).setDepth(80).setVisible(false);

    const bannerBg = this.add.rectangle(0, 0, 1000, 170, THEME.redDark, 0.95).setStrokeStyle(8, THEME.gold).setName('bg');
    const bannerText = this.add
      .text(0, 0, '', {
        fontFamily: FONT_TITLE,
        fontSize: '84px',
        color: hex(THEME.gold),
        stroke: hex(THEME.redDeep),
        strokeThickness: 10,
        align: 'center',
      })
      .setOrigin(0.5)
      .setName('text');
    // 우승 배너는 트랙 왼쪽에 → 결승선 너머의 1~3위 말을 가리지 않음
    this.winnerBanner = this.add
      .container(TRACK_X0 + (TRACK_X1 - TRACK_X0) * 0.37, TRACK_TOP + 150, [bannerBg, bannerText])
      .setDepth(60)
      .setVisible(false);

    // 이벤트 한 줄 (트랙 위쪽 가운데, 순위 패널은 가리지 않음)
    const lineBg = this.add.rectangle(0, 0, 400, 84, THEME.redDark, 0.95).setStrokeStyle(5, THEME.gold).setName('bg');
    const lineText = this.add
      .text(0, 0, '', { fontFamily: FONT_TITLE, fontSize: '54px', color: '#ffffff', stroke: '#1a0a0a', strokeThickness: 6 })
      .setOrigin(0.5)
      .setName('text');
    this.eventLine = this.add
      .container((TRACK_X0 + TRACK_X1) / 2, TRACK_TOP + 56, [lineBg, lineText])
      .setDepth(55)
      .setVisible(false);

    // 잔여 200m 자막: 트랙 아래 띠(미니맵 자리)에 → 말·등번호를 가리지 않음
    const capBg = this.add.rectangle(0, 0, TRACK_X1 - TRACK_X0, 86, 0x1a0505, 0.94).setStrokeStyle(4, THEME.gold);
    const capText = this.add
      .text(0, 0, '🏁 잔여 200m · 마지막 직선', {
        fontFamily: FONT_TITLE,
        fontSize: '64px',
        color: hex(THEME.gold),
        stroke: hex(THEME.redDeep),
        strokeThickness: 8,
      })
      .setOrigin(0.5);
    this.stretchCaption = this.add
      .container((TRACK_X0 + TRACK_X1) / 2, (TRACK_BOTTOM + VIEW_H) / 2 + 2, [capBg, capText])
      .setDepth(57)
      .setVisible(false);

    // 작전 타임 안내: 같은 아래 띠 (잔여 200m 자막보다 앞서 끝남 → 겹치지 않음)
    const tbBg = this.add.rectangle(0, 0, TRACK_X1 - TRACK_X0, 86, 0x1a0505, 0.94).setStrokeStyle(4, THEME.gold).setName('bg');
    const tbText = this.add
      .text(0, 0, '', { fontFamily: FONT_TITLE, fontSize: '50px', color: hex(THEME.gold), stroke: hex(THEME.redDeep), strokeThickness: 7 })
      .setOrigin(0.5)
      .setName('text');
    this.tacticBar = this.add
      .container((TRACK_X0 + TRACK_X1) / 2, (TRACK_BOTTOM + VIEW_H) / 2 + 2, [tbBg, tbText])
      .setDepth(56)
      .setVisible(false);

    // 각성 때 트랙에 은은한 붉은 빛 (전체 번쩍임 대신)
    this.awakenGlow = this.add
      .rectangle((PANEL_X - 10) / 2, (TRACK_TOP + TRACK_BOTTOM) / 2, PANEL_X - 10, TRACK_BOTTOM - TRACK_TOP, 0xff2a2a, 1)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(8)
      .setAlpha(0)
      .setVisible(false);

    // 슬로모션 리플레이 레터박스
    const lbW = PANEL_X - 10;
    const lbTop = this.add.rectangle(lbW / 2, HEADER_H + 40, lbW, 80, 0x000000, 0.85);
    const lbBot = this.add.rectangle(lbW / 2, VIEW_H - 40, lbW, 80, 0x000000, 0.85);
    const lbText = this.add
      .text(lbW / 2, HEADER_H + 40, '⏪  결승 리플레이 · 슬로모션', {
        fontFamily: FONT_TITLE,
        fontSize: '44px',
        color: hex(THEME.gold),
      })
      .setOrigin(0.5);
    this.letterbox = this.add.container(0, 0, [lbTop, lbBot, lbText]).setDepth(56).setVisible(false);

    // 붉은 말 각성 — 경주 중 유일한 "큰" 연출
    const awBg = this.add.rectangle(0, 0, 980, 130, 0x8a0a10, 0.94).setStrokeStyle(6, THEME.gold);
    const awText = this.add
      .text(0, 0, '', {
        fontFamily: FONT_TITLE,
        fontSize: '64px',
        color: '#ffffff',
        stroke: '#3d0709',
        strokeThickness: 8,
        align: 'center',
      })
      .setOrigin(0.5)
      .setName('text');
    this.awakenBanner = this.add
      .container((TRACK_X0 + TRACK_X1) / 2, (TRACK_TOP + TRACK_BOTTOM) / 2, [awBg, awText])
      .setDepth(58)
      .setVisible(false);
  }

  // ───────────────────────── 말 생성 ─────────────────────────

  private buildHorses(): void {
    this.effects.reset(this.horses);
    this.horses.forEach((h) => {
      h.container.destroy();
      h.badge.destroy();
      h.chip.destroy();
    });
    this.horses = [];
    this.gate = null;
    this.gateNums.removeAll(true);
    this.gateCam = -0.02;
    const race = this.race;
    if (!race) return;
    const n = race.entrants.length;
    this.progressBuf = new Float64Array(n);

    // 말 크기: 1마리 약 2.6배 · 10마리 1.8배 · 20마리 1.0배 (적을수록 크게, 많으면 덜 겹치게)
    const s = Math.min(2.6, Math.max(1.0, 2.65 - n * 0.0825));
    const hh = HORSE_H * s;
    // 레인 간격: 인원이 많으면 겹치되(아래 말이 앞) 최대 90px
    const usable = TRACK_BOTTOM - TRACK_TOP - hh - 12;
    const spacing = n > 1 ? Math.min(90, usable / (n - 1)) : 0;
    const totalH = spacing * (n - 1);
    const firstY = TRACK_TOP + hh + 8 + (usable - totalH) / 2;

    // 출발 게이트 안에서는 위아래 말이 덜 겹치도록 작게 (레인 간격 기준), 출발 후 원래 크기로
    const st = n === 1 ? s : clamp((spacing * 1.25) / HORSE_VIS_H, 0.42, s);
    this.buildGate(race, firstY, spacing, st);

    race.entrants.forEach((e, lane) => {
      const laneY = firstY + lane * spacing;
      const color = horseColor(e.id);
      const coat = coatColor(e.id);
      const sprite = this.add.image(0, 0, 'horse-0').setOrigin(0.97, 0.99).setTint(coat);
      // 기수: 참가자 색 실크
      const jockey = this.add.image(-50, -64, 'jockey').setOrigin(0.5).setTint(color);
      // 큰 번호 (안장 천): 참가자 색 배경 + 흰 글자 + 검은 외곽선 → 어떤 털색 위에서도 잘 보임
      const badge = this.add
        .text(-52, -38, String(e.id), {
          fontFamily: FONT_TITLE,
          fontSize: '28px',
          color: '#ffffff',
          stroke: '#1a0a0a',
          strokeThickness: 5,
          backgroundColor: hex(color),
          padding: { x: 7, y: 0 },
        })
        .setOrigin(0.5);
      const shadow = this.add.ellipse(-48, -2, 78, 14, 0x000000, 0.25);
      const container = this.add.container(TRACK_X0, laneY, [shadow, sprite, jockey]).setScale(s);
      if (this.view3d) [shadow, sprite, jockey].forEach((o) => o.setVisible(false));
      this.horseLayer.add(container);
      const chip = this.add
        .text(0, 0, '', { fontSize: '26px', backgroundColor: '#fff6e0', padding: { x: 3, y: 1 } })
        .setOrigin(1, 0.5)
        .setVisible(false);
      this.badgeLayer.add(chip);
      this.badgeLayer.add(badge); // 위치·크기는 매 프레임 말을 따라감 (레인 순서 = 아래 말 번호가 위에)
      this.horses.push({
        container, sprite, jockey, badge, coat, scale: s, startScale: st, laneY, phase: lane * 1.7, prevP: 0,
        bx: 0, by: 0, badgeDy: 0, badgeA: 1, chip,
      });
    });
    // y 가 큰(아래쪽) 말이 앞에 보이도록
    this.horseLayer.sort('y');
  }

  /**
   * 출발 게이트 배치. 레인마다 칸 하나 + 앞문, 칸 뒤쪽에 번호판.
   * 번호판은 별도 레이어(말보다 위)에 그리고, 레인 간격이 좁으면(40~50마리) 2~3열로 엇갈려 놓아
   * 두 자리 번호도 서로 겹치지 않게 한다.
   */
  private buildGate(race: RaceResult, firstY: number, spacing: number, st: number): void {
    this.gateNums.removeAll(true);
    const n = race.entrants.length;
    const bandH = n === 1 ? HORSE_VIS_H * st + 20 : spacing;
    const cols = n === 1 ? 1 : Math.max(1, Math.ceil(32 / spacing));
    const font = n === 1 ? 40 : clamp(Math.floor(cols * spacing - 8), 20, 34);
    const plateW = Math.ceil(font * 1.3 + 12);
    const stallLen = Math.round(HORSE_W * st + 24);
    const bands = race.entrants.map((_, i) => {
      const bot = firstY + i * spacing + 5;
      return { top: bot - bandH, bot };
    });
    const top = bands[0]!.top - 6;
    const bottom = bands[bands.length - 1]!.bot + 4;
    this.gate = { bands, top, bottom, stallLen };

    // 번호판 (게이트 앞면 x=0 기준 상대 좌표)
    race.entrants.forEach((e, i) => {
      const b = bands[i]!;
      const col = i % cols;
      const x = -stallLen - 12 - col * (plateW + 6);
      const plate = this.add
        .text(x, (b.top + b.bot) / 2, String(e.id), {
          fontFamily: FONT_TITLE,
          fontSize: `${font}px`,
          color: '#ffffff',
          stroke: '#1a0a0a',
          strokeThickness: Math.max(3, Math.round(font / 7)),
          backgroundColor: hex(horseColor(e.id)),
          fixedWidth: plateW,
          align: 'center',
        })
        .setOrigin(1, 0.5);
      this.gateNums.add(plate);
    });

    // 칸 바닥 그림자 (말 뒤)
    const g = this.gateBack;
    g.clear();
    g.fillStyle(0x000000, 0.22);
    g.fillRect(-stallLen, top, stallLen, bottom - top);

    // 카메라 시작점: 번호판 맨 왼쪽까지 화면 안에 들어오게
    const leftNeed = stallLen + 12 + cols * (plateW + 6) + 10;
    const gx = TRACK_X0 + leftNeed;
    this.gateCam = Math.min(-0.02, -((gx - TRACK_X0) / (TRACK_X1 - TRACK_X0)) * this.camWidth);
    this.camStart = this.gateCam;
    this.gateDoorK = -1;
  }

  /** 게이트 앞면(칸막이·기둥·문). k: 문 열림 0→1 */
  private drawGateFront(k: number): void {
    const gt = this.gate!;
    const g = this.gateFront;
    g.clear();
    const L = gt.stallLen;
    // 칸막이 (가는 크림색 선 — 말 위에 그려지지만 얇아서 말이 잘 보임)
    g.fillStyle(THEME.cream, 0.9);
    for (const b of gt.bands) g.fillRect(-L, b.bot - 1, L + 14, 3);
    g.fillRect(-L, gt.bands[0]!.top - 1, L + 14, 3);
    // 뒤·앞 기둥
    g.fillRect(-L - 6, gt.top - 4, 6, gt.bottom - gt.top + 8);
    g.fillRect(11, gt.top - 4, 5, gt.bottom - gt.top + 8);
    // 지붕
    g.fillStyle(THEME.redDark, 1);
    g.fillRect(-L - 8, gt.top - 26, L + 26, 22);
    g.fillStyle(THEME.gold, 1);
    g.fillRect(-L - 8, gt.top - 6, L + 26, 4);
    // 앞문: 위아래 두 짝이 접히며 열림
    if (k >= 1) return;
    for (const b of gt.bands) {
      const h = Math.max(0, ((b.bot - b.top - 4) / 2) * (1 - k));
      g.fillStyle(THEME.red, 1);
      g.fillRect(1, b.top + 2, 10, h);
      g.fillRect(1, b.bot - 2 - h, 10, h);
      g.fillStyle(THEME.gold, 1);
      g.fillRect(9, b.top + 2, 2, h);
      g.fillRect(9, b.bot - 2 - h, 2, h);
    }
  }

  /** 매 프레임: 게이트 위치(카메라 따라)·문 열림·사라짐. 모두 경주 시계 기준 → 모든 화면이 같은 순간 열림 */
  private updateGate(elapsed: number): void {
    const show = !!this.gate && elapsed < GATE_GONE_AT && this.show === 'live';
    this.gateBack.setVisible(show);
    this.gateFront.setVisible(show);
    this.gateNums.setVisible(show);
    if (!show) return;
    const k = clamp(elapsed / GATE_OPEN_MS, 0, 1);
    if (k !== this.gateDoorK) {
      this.gateDoorK = k;
      this.drawGateFront(k);
    }
    const a = elapsed < GATE_FADE_FROM ? 1 : 1 - (elapsed - GATE_FADE_FROM) / (GATE_GONE_AT - GATE_FADE_FROM);
    const x = this.xOf(0);
    this.sampleBend(0);
    const y = this.bend.shift + this.by;
    for (const o of [this.gateBack, this.gateFront, this.gateNums]) o.setPosition(x, y).setAlpha(a);
  }

  // ───────────────────────── 매 프레임 ─────────────────────────

  update(): void {
    const race = this.race;
    const clock = this.clock;
    // Phaser 의 delta 는 smoothStep 으로 보정돼 프레임 드랍 시 실제 경과시간보다 작아진다.
    // 카메라가 말을 놓치지 않도록 실제 벽시계 기준 dt 사용 (탭 복귀 시 튐 방지로 상한).
    const now = performance.now();
    const realDt = this.lastFrameAt === 0 ? 16 : now - this.lastFrameAt;
    this.lastFrameAt = now;
    const dt = Math.min(Math.max(realDt, 0), 1000);

    if (!race || !clock) {
      this.timerText.setText('00:00.0');
      this.statusText.setText('대기 중');
      this.bigText.setText('');
      this.pauseOverlay.setVisible(false);
      this.tacticBar.setVisible(false);
      this.updateGate(Infinity);
      this.miniGfx.clear();
      if (this.view3d) {
        // 3D 중계: 평면 트랙은 그리지 않고 같은 3D 경기장의 출발선 구도를 보여줌
        this.hide2dTrack();
        // 대기 화면 뒤에 숨어 있는 동안은 정지 장면이라 초당 4번만 다시 그림 (그래픽 부담 최소)
        if (now - this.lastIdle3d > 250) {
          this.lastIdle3d = now;
          this.view3d.renderIdle();
        }
        this.prepCover.setVisible(false);
      } else {
        this.computeBend();
        this.drawTrack();
      }
      return;
    }

    const elapsed = clock.elapsedMs();
    const paused = clock.isPaused();
    this.pauseOverlay.setVisible(paused);

    // 카운트다운 (3·2·1 타격음 · 2 에서 관중 웅성임 · 1 에서 게이트 철컥 → 출발! 게이트 탕 + 발굽)
    // 소리는 모두 sfx 를 거치므로 기존 소리 켜기/끄기 설정을 그대로 따름
    if (elapsed < 0) {
      const s = Math.ceil(-elapsed / 1000);
      if (s !== this.lastCountSec) {
        this.bigText.setText(s > 0 ? String(s) : '');
        // 숫자가 바뀔 때 툭 튀어나오게. 1 은 특히 크게
        const base = !this.view3d ? 1 : s === 1 ? 1.6 : s === 2 ? 1.15 : 1;
        this.tweens.killTweensOf(this.bigText);
        this.bigText.setScale(base * 1.35).setAlpha(1);
        this.tweens.add({ targets: this.bigText, scale: base, duration: 260, ease: 'Back.Out' });
        if (!paused && s <= 3) {
          sfx.play(this.view3d ? 'tick' : 'countdown');
          if (this.view3d && s === 2) sfx.play('crowd');
          if (this.view3d && s === 1) sfx.play('gate');
        }
      }
      this.lastCountSec = s;
    } else if (elapsed < 900) {
      if (!paused && this.lastCountSec > 0) {
        sfx.play('go');
        if (this.view3d) sfx.play('hooves');
        this.tweens.killTweensOf(this.bigText);
        this.bigText.setScale(this.view3d ? 1.25 : 1);
      }
      this.lastCountSec = 0;
      this.bigText.setText('출발!');
    } else {
      this.bigText.setText('');
    }

    // 실제(서버 기준) 시각 — 순위표·완주 수·경주 종료 판정은 항상 이것으로
    const ms = Math.min(Math.max(0, elapsed), race.totalTicks * TICK_MS);
    const tick = tickAt(race, ms);
    // 트랙에 그리는 시각 — 리플레이 중에는 과거 장면을 느리게 (서버 동기화와 무관한 순수 연출)
    const showMs = this.show === 'replay' ? this.replayMs(race, paused) : ms;
    const showTick = tickAt(race, showMs);
    const prog = sampleProgress(race, showMs, this.progressBuf);
    const n = race.entrants.length;

    if (this.show === 'replay') {
      // 결승선 근처 고정 확대
      this.camWidth = 0.11;
      this.camStart = 1 - this.camWidth * 0.7;
    } else {
      this.updateCamera(prog, dt);
    }
    this.computeBend();
    if (!this.view3d) {
      this.drawTrack();
      this.updateGate(elapsed);
    }

    // 출발 후 게이트 배율 → 주행 배율 (부드럽게). 경주 시계 기준이라 새로고침해도 같은 크기
    const grow = smooth(clamp((elapsed - GROW_FROM) / GROW_MS, 0, 1));

    // 말 위치/애니메이션
    const active = activeEventsAtTick(race, showTick);
    this.anchors = null;
    if (this.view3d) {
      this.hide2dTrack();
      const tac = new Map<number, TacticType>();
      if (this.tacticsOn) {
        for (const r of race.tactics ?? []) if (r.applied && r.tick <= showTick && showTick < r.endTick) tac.set(r.lane, r.tactic);
      }
      this.anchors = this.view3d.render({
        prog,
        showMs,
        elapsed,
        dt,
        events: active,
        tactics: tac,
        ranking: this.lastRanking,
        mode: this.show === 'replay' ? 'replay' : tick >= race.totalTicks ? 'over' : 'live',
        finishLock: this.finishLock,
        paused,
      });
      // 3D 첫 화면을 못 그렸으면(그래픽 준비 지연·오류) "경주 준비 중" 으로 가림. 경주 시계는 서버 기준 그대로
      this.prepCover.setVisible(!this.view3d.ready);
    }
    // 평균 진행속도(진행률/ms) — 경주 시간 설정과 무관하게 다리 움직임 속도를 일정하게
    const nominal = race.baseSpeed / TRACK_LENGTH / TICK_MS;
    for (let i = 0; i < n; i++) {
      const h = this.horses[i]!;
      const p = prog[i]!;
      const dp = Math.max(0, p - h.prevP);
      h.prevP = p;
      const speedNorm = dt > 0 ? dp / dt / nominal : 0;
      // 8프레임 갤럽: 보통 속도에서 초당 약 2걸음, 빨라지면 다리도 빨라짐
      h.phase += Math.min(dt, 100) * 0.017 * Math.min(speedNorm, 2.5);
      const frame = Math.floor(h.phase) % GALLOP_FRAMES;
      h.sprite.setTexture(`horse-${frame}`);
      const running = speedNorm > 0.05;
      const cyc = ((h.phase % GALLOP_FRAMES) / GALLOP_FRAMES) * Math.PI * 2;

      const sc = h.startScale + (h.scale - h.startScale) * grow;
      // 게이트 안에서는 작아진 말 등번호 대신 게이트 번호판을 보여줌 → 커지면서 등번호가 나타남

      // 공중에 뜨는 순간 몸이 살짝 오르고, 걸음마다 앞뒤로 기울어짐
      const bob = running ? -Math.max(0, Math.sin(cyc - 0.4)) * 4 * sc : 0;
      const pitch = running ? Math.sin(cyc) * 2.5 : 0;
      h.jockey.setY(-64 + (running ? Math.sin(cyc + 1.4) * 1.6 : 0));
      let lateral = h.laneY;
      let angle = 0;
      const ev = active.get(i);
      if (ev) {
        if (ev.type === 'RUNAWAY') {
          // 트랙 밖(바깥쪽 잔디)으로 나갔다 돌아옴 — 순수 연출
          const k = (showTick - ev.tick) / (ev.endTick - ev.tick);
          lateral += Math.sin(k * Math.PI) * 90;
          angle = Math.cos(k * Math.PI) * 25;
        } else if (ev.type === 'SLEEP') {
          angle = -8;
        } else if (ev.type === 'BANANA') {
          angle = Math.sin(this.time.now * 0.03) * 18;
        }
      }
      // 곡선 트랙 위 화면 좌표 (코너에서는 트랙 방향으로 기울고, 먼 안쪽 레인은 살짝 작게)
      this.project(p, lateral);
      let x = this.px;
      const theta = this.pTheta;
      const y = this.py + bob;
      const depth = 1 + ((this.py - MID_Y) / (TRACK_BOTTOM - TRACK_TOP)) * 0.22 * this.bend.corner;
      const dsc = sc * depth;
      if (h.container.scaleX !== dsc) h.container.setScale(dsc);
      let alpha = 1;
      const minX = TRACK_X0 + HORSE_W * dsc * 0.97 + 6; // 말 전체가 화면 안에 들어오게
      if (x < minX) {
        x = minX;
        alpha = 0.55; // 화면 밖 뒤처진 말: 왼쪽 끝에 반투명 표시
      }
      // 발굽 흙먼지 (빠르게 달릴 때만, 화면 안에서만)
      if (!this.view3d && running && speedNorm > 0.5 && alpha === 1 && Math.random() < Math.min(dt, 100) / 140) {
        this.dust.emitParticleAt(x - 62 * dsc * Math.cos(theta), y - 3 - 62 * dsc * Math.sin(theta), 1);
      }
      h.container.setPosition(x, y).setAlpha(alpha).setRotation(theta);
      h.sprite.setAngle(angle + pitch);
      // 전원 도착 후: 1~3위만 또렷하게, 나머지는 흐리게 (결승선에 몰려 있어도 메달 말이 바로 보임)
      if (this.podiumShown && !this.podiumRank.has(i)) alpha *= 0.35;
      h.container.setAlpha(alpha);
      // 등번호 (별도 레이어): 게이트 안에서는 게이트 번호판이 대신하고, 말이 커지면서 나타남
      const cs = Math.cos(theta);
      const sn = Math.sin(theta);
      h.bx = x + (-52 * cs + 38 * sn) * dsc;
      h.by = y + (-52 * sn - 38 * cs) * dsc;
      h.badge.setScale(dsc).setRotation(theta * 0.5);
      h.badge.setData('a', alpha * (h.startScale === h.scale ? 1 : grow));
      const an = this.anchors?.[i];
      if (an) {
        // 3D: 번호는 기수 머리 위, 이벤트 아이콘은 그 위 (말·기수 본체는 3D 가 그림)
        const k = an.k;
        h.container.setPosition(an.x + 30 * k, an.y + 58 * k).setScale(k).setRotation(0).setAlpha(an.visible ? 1 : 0);
        h.bx = an.x;
        h.by = an.y + 4;
        h.badge.setScale(Math.max(0.85, k)).setRotation(0);
        const fade = this.podiumShown && !this.podiumRank.has(i) ? 0.35 : 1;
        // 출발 게이트 안에서부터 등번호를 보여줌 (겹치면 layoutBadges 가 비켜 세움)
        h.badge.setData('a', an.visible ? fade : 0);
      }
    }
    this.layoutBadges(race, showTick, dt);

    // 순위 표시는 말 코 앞(오른쪽 빈 공간)에
    for (const { lane, tag } of this.podiumTags) {
      const h = this.horses[lane];
      if (h && this.anchors) tag.setPosition(h.bx + h.badge.displayWidth / 2 + 8, h.by + h.badgeDy);
      else if (h) tag.setPosition(h.container.x + 10, h.container.y - 44 * h.container.scaleX);
    }

    if (showTick !== this.lastShowTick) {
      this.lastShowTick = showTick;
      this.effects.sync(active, this.horses);
    }
    if (tick !== this.lastTick) this.onTick(race, tick);
    this.raceOver = tick >= race.totalTicks && this.show !== 'replay';
    if (this.raceOver && !this.podiumShown && this.show !== 'ceremony') this.showPodium(race);

    // 상단 정보
    this.timerText.setText(formatTime(ms));
    this.updateTacticBar(race, elapsed, tick);
    if (this.tacticBar.visible) this.miniGfx.clear();
    else this.drawMinimap(prog);

    if (!this.finishedNotified && tick >= race.totalTicks) {
      this.finishedNotified = true;
      this.callbacks.onFinished?.(race);
    }
  }

  private onTick(race: RaceResult, tick: number): void {
    const prev = this.lastTick;
    this.lastTick = tick;
    const n = race.entrants.length;

    // TOP 5 (경주 중). 최종 결과표에서는 전체 순위
    const ranking = rankingAtTick(race, tick);
    // 등번호 겹침 정리는 순위 순서로 (선두권 번호가 항상 맨 위·제자리)
    if (ranking.some((l, k) => this.lastRanking[k] !== l)) {
      for (let k = ranking.length - 1; k >= 0; k--) {
        const h = this.horses[ranking[k]!];
        if (h) {
          this.badgeLayer.bringToTop(h.chip);
          this.badgeLayer.bringToTop(h.badge);
        }
      }
      this.lastRanking = ranking;
    }
    for (let i = 0; i < TOP_N; i++) {
      const row = this.rows[i]!;
      const lane = ranking[i];
      if (lane === undefined) {
        row.num.setText('');
        row.name.setText('');
        row.chip.setVisible(false);
        continue;
      }
      const e = race.entrants[lane]!;
      const c = horseColor(e.id);
      row.chip.setVisible(true).setFillStyle(c);
      row.num.setText(String(e.id)).setColor('#ffffff');
      // 긴 닉네임은 잘리지 않게 패널 폭에 맞춰 줄임
      row.name.setText(e.name).setScale(1);
      const maxW = PANEL_W - 48;
      if (row.name.width > maxW) row.name.setScale(maxW / row.name.width);
      const medal = i === 0 ? hex(THEME.gold) : i === 1 ? '#d9d9d9' : i === 2 ? '#e3a06b' : '#ffffff';
      row.rank.setColor(medal);
      row.name.setColor(i < 2 ? medal : '#ffffff');
    }

    const done = finishedCountAtTick(race, tick);
    this.statusText.setText(tick >= race.totalTicks ? '경주 종료' : done > 0 ? `완주 ${done}/${n}` : `${n}마리 출전`);

    // 재접속·새로고침·탭 복귀로 시간이 크게(2초 넘게) 건너뛰면 지나간 알림·소리는 생략.
    // 2초 이내 버벅임(느린 PC, 잠깐 멈칫)은 정상으로 보고 알림을 그대로 낸다. 진행 중 효과는 어느 경우든 보임.
    const live = prev >= 0 && tick - prev <= 40;

    // 개그 이벤트: 소리 + 알림 (알림은 1.2초 간격으로만 → 화면이 글자로 덮이지 않게)
    // 리플레이·세리머니 중에는 생략 (연출을 가리지 않게)
    // 자막 우선순위: 3 선두 탈환 > 2 큰 추월·막판 스퍼트·각성 > 1 부스터 > 0 선두권 방해
    // (낮은 것은 줄이 비어 있을 때만 → 관객이 반응할 순간이 묻히지 않게)
    const rankOf = new Map<number, number>();
    ranking.forEach((lane, r) => rankOf.set(lane, r));
    if (live && this.show === 'live') {
      for (const e of eventsBetween(race, prev, tick)) {
        sfx.play(e.type);
        const who = race.entrants[e.horse]!;
        const r = rankOf.get(e.horse) ?? 99;
        if (e.type === 'AWAKEN') {
          this.showAwaken(`${who.id}번 ${who.name}`);
          this.view3d?.focusOn(e.horse, 1900);
        } else if (e.type === 'SPURT') {
          this.pushToast(this.eventLabel(e.type, who.id, who.name), 'good', 2);
        } else if (EVENT_SPECS[e.type].good) {
          this.pushToast(this.eventLabel(e.type, who.id, who.name), 'good', 1);
        } else if (r < 6) {
          this.pushToast(this.eventLabel(e.type, who.id, who.name), 'bad', 0);
        }
      }
    }

    // 작전이 적용된 순간: 그 말들의 등번호를 잠깐 강조
    if (live && this.show === 'live' && this.tacticsOn) {
      for (const w of this.windows) {
        if (!(prev < w.applyTick && w.applyTick <= tick)) continue;
        for (const x of race.tactics ?? []) if (x.window === w.no && x.applied) this.badgeFlash.set(x.lane, this.time.now + 1500);
      }
    }

    // 작전 효과가 끝난 순간: 실제로 순위가 오른 말만 "7번 컴파일중 · 5위 → 3위"
    if (live && this.show === 'live' && this.tacticsOn) {
      for (const w of this.windows) {
        if (!(prev < w.endTick && w.endTick <= tick)) continue;
        const recs = (race.tactics ?? []).filter((x) => x.window === w.no && x.applied);
        if (recs.length === 0) continue;
        const before = rankingAtTick(race, w.applyTick - 1);
        const gains = recs
          .map((x) => ({ x, a: before.indexOf(x.lane), b: rankOf.get(x.lane) ?? 99 }))
          .filter((g) => g.b < g.a)
          .sort((g1, g2) => g1.b - g2.b || g2.a - g2.b - (g1.a - g1.b));
        for (const g of gains.slice(0, 2)) {
          const e = race.entrants[g.x.lane]!;
          this.pushToast(`${TACTIC_SPECS[g.x.tactic].emoji} ${e.id}번 ${e.name} · ${g.a + 1}위 → ${g.b + 1}위`, 'call', 2);
        }
      }
    }

    const leaderLane = ranking[0]!;
    if (done === 0 && tick * TICK_MS > 5000) {
      // 선두 탈환: 실제 추월만 — 새 선두가 0.5초 이상 앞서 있고, 그동안 이전 선두보다 1m 이상 앞선 적이 있어야 함.
      // 거의 나란히 순서를 주고받는 경우(4초 안에 같은 말이 다시 선두)는 자막을 다시 띄우지 않음. 3초에 한 번까지
      if (leaderLane !== this.leadCand) {
        this.leadCand = leaderLane;
        this.leadCandSince = tick;
        this.leadCandMargin = 0;
      }
      if (this.lastLeader !== -1 && this.leadCand !== this.lastLeader) {
        const m = positionAtTick(race, tick, this.leadCand) - positionAtTick(race, tick, this.lastLeader);
        if (m > this.leadCandMargin) this.leadCandMargin = m;
      }
      const recentlyCalled = (this.leadCalledAt.get(this.leadCand) ?? -1e9) > tick - 80;
      if (
        live &&
        this.leadCand !== this.lastLeader &&
        this.lastLeader !== -1 &&
        tick - this.leadCandSince >= 10 &&
        this.leadCandMargin >= 1000 &&
        !recentlyCalled &&
        tick - this.lastLeadCallTick >= 60
      ) {
        this.leadCalledAt.set(leaderLane, tick);
        const l = race.entrants[leaderLane]!;
        this.lastLeadCallTick = tick;
        this.lastLeader = leaderLane;
        this.pushToast(`👑 ${l.id}번 ${l.name}, 선두 탈환!`, 'call', 3);
        sfx.play('lead');
      }
      // 새로고침·재접속 직후(시간 건너뜀)에는 지금 선두를 기준으로 삼고 알리지 않음
      if (this.lastLeader === -1 || !live) this.lastLeader = leaderLane;

      // 큰 추월: 1.5초 사이 2계단 이상 올라 5위 안에 든 말 (막판 200m 에선 3위 안으로 1계단도). 2.5초에 한 번까지
      if (live && tick % 10 === 0 && tick > 30 && tick - this.lastPassCallTick >= 50 && tick - this.lastLeadCallTick >= 30) {
        const before = rankingAtTick(race, tick - 30);
        const final = positionAtTick(race, tick, leaderLane) >= TRACK_LENGTH * 0.8;
        for (let r = 1; r < Math.min(5, n); r++) {
          const lane = ranking[r]!;
          const was = before.indexOf(lane);
          if (was - r >= 2 || (final && r < 3 && was - r >= 1)) {
            const passed = ranking[r + 1]!; // 바로 뒤로 밀려난 말 기준으로 안쪽/바깥쪽
            const side = passed !== undefined && lane > passed ? '바깥쪽에서' : '안쪽에서';
            const h = race.entrants[lane]!;
            this.lastPassCallTick = tick;
            this.pushToast(`🔀 ${h.id}번 ${h.name}, ${side} 추월! ${r + 1}위로`, 'call', 2);
            this.view3d?.focusOn(lane, 1700);
            break;
          }
        }
      }
      // 선두가 실제로 잔여 200m(트랙 1000m 중 800m 지점)에 도달한 틱에
      if (!this.finalStretchShown && positionAtTick(race, tick, leaderLane) >= TRACK_LENGTH * 0.8) {
        this.finalStretchShown = true;
        if (live && this.show === 'live') {
          this.showStretchCaption();
          sfx.play('final');
        }
      }
    }

    // 우승: 실시간으로 보고 있었다면 슬로모션 리플레이 → 세리머니, 나중에 들어왔다면 배너만
    if (!this.winnerShown && done > 0) {
      this.winnerShown = true;
      if (live) this.startReplay(race);
      else this.showWinnerBanner(race);
    }
  }

  // ───────────────────────── 결승 리플레이 · 세리머니 ─────────────────────────

  private startReplay(race: RaceResult): void {
    const [first, second] = race.standings;
    const firstMs = first!.finishMs ?? 0;
    // 2등이 1.5초 안에 들어왔으면 2등 도착까지 보여줌 (접전일수록 길게)
    const secondMs = second?.finishMs != null && second.finishMs - firstMs < 1500 ? second.finishMs : firstMs;
    this.replay = {
      from: Math.max(0, firstMs - 1600),
      to: Math.min(race.totalTicks * TICK_MS, secondMs + 350),
      startedAt: performance.now() + 700, // 결승 통과 장면을 잠깐 보여준 뒤 시작
      pausedAt: 0,
      pausedTotal: 0,
      winnerCrossed: false,
    };
    this.time.delayedCall(700, () => {
      if (this.show !== 'live' || this.race !== race) return;
      this.show = 'replay';
      this.lastShowTick = -1;
      this.letterbox.setVisible(true).setAlpha(0);
      this.tweens.add({ targets: this.letterbox, alpha: 1, duration: 250 });
      // 리플레이는 깨끗한 화면에서: 남아 있는 알림·각성 배너 정리
      this.clearLine();
      this.tweens.killTweensOf(this.stretchCaption);
      this.stretchCaption.setVisible(false);
      this.tweens.killTweensOf(this.awakenBanner);
      this.awakenBanner.setVisible(false);
      sfx.play('final');
    });
  }

  /** 리플레이 중 표시 시각 (0.35배속, 약 6초). 일시정지하면 리플레이도 멈춤 */
  private replayMs(race: RaceResult, paused: boolean): number {
    const r = this.replay;
    const now = performance.now();
    if (paused) {
      if (!r.pausedAt) r.pausedAt = now;
    } else if (r.pausedAt) {
      r.pausedTotal += now - r.pausedAt;
      r.pausedAt = 0;
    }
    const realNow = r.pausedAt || now;
    const t = r.from + Math.max(0, realNow - r.startedAt - r.pausedTotal) * 0.35;
    if (!r.winnerCrossed && t >= (race.standings[0]!.finishMs ?? 0)) {
      r.winnerCrossed = true;
      sfx.play('finish');
      this.cameras.main.flash(220, 255, 240, 200);
    }
    if (t >= r.to) {
      this.show = 'ceremony';
      this.lastShowTick = -1;
      this.tweens.add({ targets: this.letterbox, alpha: 0, duration: 250, onComplete: () => this.letterbox.setVisible(false) });
      this.startCeremony(race);
      return r.to;
    }
    return t;
  }

  private startCeremony(race: RaceResult): void {
    const [first, second] = race.standings;
    const w = first!;
    const cx = (PANEL_X - 10) / 2;
    const cy = (TRACK_TOP + TRACK_BOTTOM) / 2;
    const items: Phaser.GameObjects.GameObject[] = [];

    items.push(this.add.rectangle(cx, cy, PANEL_X - 10, TRACK_BOTTOM - TRACK_TOP + 40, 0x1a0505, 0.88));
    // 회전하는 빛줄기
    const rays = this.add.graphics({ x: cx, y: cy - 40 });
    rays.fillStyle(THEME.gold, 0.13);
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      rays.fillTriangle(0, 0, Math.cos(a - 0.09) * 900, Math.sin(a - 0.09) * 900, Math.cos(a + 0.09) * 900, Math.sin(a + 0.09) * 900);
    }
    items.push(rays);
    this.tweens.add({ targets: rays, angle: 360, duration: 24000, repeat: -1 });

    // 우승마: 크게 + 금빛 오라
    const aura = this.add.image(cx - 30, cy - 60, 'fx-aura').setTint(THEME.gold).setBlendMode(Phaser.BlendModes.ADD).setScale(3.4, 2.4);
    this.tweens.add({ targets: aura, alpha: { from: 0.95, to: 0.55 }, duration: 600, yoyo: true, repeat: -1 });
    const horse = this.add.image(cx + 70, cy + 20, 'horse-0').setOrigin(0.97, 0.99).setTint(coatColor(w.id)).setScale(3.2);
    let frame = 0;
    const gallop = this.time.addEvent({ delay: 110, loop: true, callback: () => horse.setTexture(`horse-${++frame % GALLOP_FRAMES}`) });
    const crown = this.add.text(cx - 20, cy - 205, '👑', { fontSize: '90px' }).setOrigin(0.5);
    this.tweens.add({ targets: crown, y: cy - 220, duration: 500, yoyo: true, repeat: -1, ease: 'Sine.InOut' });
    items.push(aura, horse, crown);

    const titleStyle = { fontFamily: FONT_TITLE, color: hex(THEME.gold), stroke: hex(THEME.redDeep), align: 'center' as const };
    const title = this.add.text(cx, TRACK_TOP + 70, '🏆 우승', { ...titleStyle, fontSize: '76px', strokeThickness: 10 }).setOrigin(0.5);
    const name = this.add
      .text(cx, cy + 120, `${w.id}번  ${w.name}`, { ...titleStyle, fontSize: '120px', color: '#ffffff', strokeThickness: 14 })
      .setOrigin(0.5);
    items.push(title, name);
    if (second) {
      items.push(
        this.add
          .text(cx, cy + 250, `🥈 2등  ${second.id}번 ${second.name}`, { ...titleStyle, fontSize: '56px', color: '#e6e6e6', strokeThickness: 8 })
          .setOrigin(0.5),
      );
    }

    const box = this.add.container(0, 0, items).setDepth(65).setAlpha(0);
    this.tweens.add({ targets: box, alpha: 1, duration: 350 });
    this.tweens.add({ targets: name, scale: { from: 0.4, to: 1 }, duration: 600, ease: 'Back.Out' });
    this.ceremony = box;
    box.setData('gallop', gallop);

    // 꽃가루 (붉은색·금색·흰색)
    this.confetti = this.add
      .particles(0, TRACK_TOP - 10, 'fx-dot', {
        x: { min: 0, max: PANEL_X - 10 },
        tint: [THEME.red, THEME.gold, 0xffffff, 0xff6a3a],
        speedY: { min: 120, max: 260 },
        speedX: { min: -60, max: 60 },
        gravityY: 120,
        rotate: { min: 0, max: 360 },
        scaleX: { min: 0.5, max: 0.9 },
        scaleY: { min: 0.25, max: 0.5 },
        lifespan: 4200,
        frequency: 22,
        quantity: 2,
      })
      .setDepth(66);

    sfx.play('finish');
    this.time.delayedCall(5500, () => {
      if (this.ceremony !== box) return;
      this.endCeremony(false);
      this.show = 'done';
      this.showWinnerBanner(race);
    });
  }

  /** 세리머니 정리. immediate=true 면 즉시 제거(경주 교체 등) */
  private endCeremony(immediate: boolean): void {
    const box = this.ceremony;
    const conf = this.confetti;
    this.ceremony = null;
    this.confetti = null;
    if (conf) {
      conf.stop();
      if (immediate) conf.destroy();
      else this.time.delayedCall(4500, () => conf.destroy());
    }
    if (!box) return;
    (box.getData('gallop') as Phaser.Time.TimerEvent | undefined)?.remove(false);
    if (immediate) {
      this.tweens.killTweensOf(box.list);
      box.destroy(true);
    } else {
      this.tweens.add({
        targets: box,
        alpha: 0,
        duration: 500,
        onComplete: () => {
          this.tweens.killTweensOf(box.list);
          box.destroy(true);
        },
      });
    }
  }

  private showWinnerBanner(race: RaceResult): void {
    this.callbacks.onPresentationDone?.(race);
    const w = race.standings[0]!;
    const t = this.winnerBanner.getByName('text') as Phaser.GameObjects.Text;
    t.setText(`🏆 우승  ${w.id}번 ${w.name}`).setScale(1);
    if (t.width > 920) t.setScale(920 / t.width);
    this.winnerBanner.setVisible(true).setScale(0.2).setAlpha(0);
    this.tweens.add({ targets: this.winnerBanner, scale: 1, alpha: 1, duration: 600, ease: 'Back.Out' });
  }

  /** 잔여 200m 자막: 트랙 아래 띠에 약 2.6초 */
  private showStretchCaption(): void {
    const c = this.stretchCaption;
    this.tweens.killTweensOf(c);
    c.setVisible(true).setAlpha(0).setScale(1, 0.5);
    this.tweens.add({ targets: c, alpha: 1, scaleY: 1, duration: 220, ease: 'Back.Out' });
    this.tweens.add({ targets: c, alpha: 0, delay: 2600, duration: 350, onComplete: () => c.setVisible(false) });
  }

  private eventLabel(type: EventType, id: number, name: string): string {
    const spec = EVENT_SPECS[type];
    return `${spec.emoji} ${id}번 ${name}, ${spec.label}!`;
  }

  /**
   * 붉은 말 각성: 위쪽 한 줄 자막(우선순위 높음) + 트랙에 은은한 붉은 빛 한 번.
   * 화면 전체 번쩍임·가운데 큰 배너는 말을 가려서 쓰지 않음 (말 뒤 붉은 오라는 effects 가 표시)
   */
  private showAwaken(who: string): void {
    this.pushToast(`🔥 ${who}, 붉은 말 각성!`, 'good', 2);
    const g = this.awakenGlow;
    this.tweens.killTweensOf(g);
    g.setVisible(true).setAlpha(0);
    this.tweens.add({ targets: g, alpha: 0.16, duration: 180, yoyo: true, hold: 120, onComplete: () => g.setVisible(false) });
  }

  /** 전원 도착 후 1~3위 말 머리 위에 순위 표시 (공식 순위 = 엔진 결승선 통과 기록) */
  private showPodium(race: RaceResult): void {
    this.podiumShown = true;
    const labels = ['🥇 1위', '🥈 2위', '🥉 3위'];
    const colors = [THEME.gold, 0xd9d9d9, 0xe3a06b];
    race.standings.slice(0, 3).forEach((s, i) => {
      const h = this.horses[s.lane];
      if (!h) return;
      this.podiumRank.set(s.lane, i);
      const tag = this.add
        .text(0, 0, `${labels[i]!}  ${s.id}번`, {
          fontFamily: FONT_TITLE,
          fontSize: '28px',
          color: '#1a0a0a',
          backgroundColor: hex(colors[i]!),
          padding: { x: 10, y: 1 },
        })
        .setOrigin(0, 0.5)
        .setDepth(13)
        .setAlpha(0);
      this.podiumTags.push({ lane: s.lane, tag });
      this.tweens.add({ targets: tag, alpha: 1, duration: 400, delay: i * 150 });
      // 메달 말은 다른 말보다 앞에 그리기
      this.horseLayer.bringToTop(h.container);
    });
  }

  /**
   * 이벤트·중계를 화면 위쪽에 "큰 한 줄"로. 동시에 여러 개가 오면 대기열(최대 2개, 오래된 것부터 버림)에
   * 넣고 한 줄당 최소 1.6초씩 차례로 → 화면이 글자로 도배되지 않고, 오른쪽 순위표도 가리지 않는다.
   * good=금색(좋은 일) · bad=회색(나쁜 일) · call=밝은색(중계 멘트)
   */
  private pushToast(label: string, style: 'good' | 'bad' | 'call', prio = 1): void {
    const busy = this.time.now < this.lineBusyUntil;
    // 부스터·방해(낮은 순위)는 줄이 비어 있을 때만. 중계(높은 순위)는 대기열 앞쪽으로, 낮은 것이 떠 있으면 바로 교체
    if (prio <= 1 && (busy || this.lineQueue.length)) return;
    if (prio >= 2) {
      this.lineQueue = this.lineQueue.filter((q) => q.prio >= prio);
      if (busy && this.linePrio < prio) this.lineBusyUntil = 0;
    }
    this.lineQueue.push({ label, style, prio });
    while (this.lineQueue.length > 2) this.lineQueue.shift();
    this.pumpLine();
  }

  private pumpLine(): void {
    if (this.time.now < this.lineBusyUntil || this.lineQueue.length === 0) return;
    const { label, style, prio } = this.lineQueue.shift()!;
    this.linePrio = prio;
    const seq = ++this.lineSeq;
    // 결승선 카메라 중에는 트랙 아래 띠로 → 결승선(FINISH 깃발)과 말을 가리지 않음
    if (this.finishLock) {
      this.tweens.killTweensOf(this.stretchCaption);
      this.stretchCaption.setVisible(false);
      this.eventLine.setY((TRACK_BOTTOM + VIEW_H) / 2 + 2);
    } else {
      this.eventLine.setY(TRACK_TOP + 56);
    }
    const bg = this.eventLine.getByName('bg') as Phaser.GameObjects.Rectangle;
    const text = this.eventLine.getByName('text') as Phaser.GameObjects.Text;
    text.setText(label).setScale(1).setColor(style === 'good' ? hex(THEME.gold) : style === 'call' ? '#1a0a0a' : '#ffffff');
    text.setStroke(style === 'call' ? '#fff6e0' : '#1a0a0a', 6);
    const maxW = TRACK_X1 - TRACK_X0 - 120;
    if (text.width > maxW) text.setScale(maxW / text.width);
    bg.setSize(Math.min(maxW + 80, text.displayWidth + 70), 84)
      .setFillStyle(style === 'good' ? THEME.redDark : style === 'call' ? 0xfff6e0 : 0x2a2a2a, 0.95)
      .setStrokeStyle(5, style === 'bad' ? 0x8a8a8a : THEME.gold);
    bg.setOrigin(0.5);
    this.tweens.killTweensOf(this.eventLine);
    this.eventLine.setVisible(true).setAlpha(0).setScale(0.92);
    this.tweens.add({ targets: this.eventLine, alpha: 1, scale: 1, duration: 160, ease: 'Quad.Out' });
    this.lineBusyUntil = this.time.now + 1600;
    this.time.delayedCall(1600, () => {
      if (seq !== this.lineSeq) return; // 더 중요한 자막으로 이미 교체됨
      this.linePrio = 0;
      if (this.lineQueue.length) return this.pumpLine();
      this.tweens.add({ targets: this.eventLine, alpha: 0, delay: 500, duration: 250, onComplete: () => this.eventLine.setVisible(false) });
    });
  }

  private clearLine(): void {
    this.lineQueue = [];
    this.lineBusyUntil = 0;
    this.linePrio = 0;
    this.lineSeq++;
    this.tweens.killTweensOf(this.eventLine);
    this.eventLine.setVisible(false);
  }

  // ───────────────────────── 카메라 & 트랙 ─────────────────────────

  private updateCamera(prog: Float64Array, dt: number): void {
    // 1·2·3위 진행률 (말 수 ≤ 50 이라 단순 비교로 충분)
    let leader = 0;
    let second = 0;
    let third = 0;
    let last = Infinity;
    for (let i = 0; i < prog.length; i++) {
      const p = prog[i]!;
      if (p > leader) [leader, second, third] = [p, leader, second];
      else if (p > second) [second, third] = [p, second];
      else if (p > third) third = p;
      last = Math.min(last, p);
    }
    if (prog.length < 3) third = prog.length === 1 ? leader : second;

    // 결승선 카메라: 선두가 결승선 가까이 오면 결승선을 화면 오른쪽(80%)에 고정한 구도로 전환.
    // 말이 왼쪽에서 들어와 결승선을 통과하는 모습을 보여줌. 폭은 선두권(1~3위)이 함께 들어오게.
    // 순수 연출: 말 위치·속도·결과는 엔진 값 그대로이고 카메라만 바뀐다.
    const packW = clamp((leader - third) * 1.3 + 0.07, 0.15, 0.3);
    if (!this.finishLock && leader >= 1 - packW * 0.6) {
      this.finishLock = true;
      this.lockW = packW;
    }
    if (this.finishLock || this.raceOver) {
      const k = 1 - Math.exp(-dt / 600);
      // 전원 도착 후: 결승선을 왼쪽으로 조금 옮겨 결승선 너머에 멈춘 말들까지 화면에 담음
      const w = this.raceOver ? 0.3 : this.lockW;
      const start = this.raceOver ? 1.07 - w : 1 - this.camWidth * FINISH_AT;
      this.camWidth += (w - this.camWidth) * k;
      this.camStart += (start - this.camStart) * k;
      return;
    }

    let wantW = clamp((leader - last) * 1.15 + 0.05, 0.16, 0.45);
    // 코너를 빠져나오면 긴 결승 직선이 넓게 펼쳐지도록 잠깐 넓게
    const exitK = smooth(clamp((leader - CORNER_TO) / 0.03, 0, 1)) * (1 - smooth(clamp((leader - CORNER_TO - 0.08) / 0.05, 0, 1)));
    wantW = Math.max(wantW, wantW + (0.3 - wantW) * exitK);
    let wantStart = leader - wantW * 0.86;
    wantStart = clamp(wantStart, this.gateCam, 1.07 - wantW);
    const kw = 1 - Math.exp(-dt / 700);
    const ks = 1 - Math.exp(-dt / 220);
    this.camWidth += (wantW - this.camWidth) * kw;
    this.camStart += (wantStart - this.camStart) * ks;
    // 안전장치: 어떤 상황에서도 선두가 화면 오른쪽 밖으로 나가지 않게
    const maxLeaderX = Math.min(leader, 1.07);
    if (maxLeaderX > this.camStart + this.camWidth * 0.95) this.camStart = maxLeaderX - this.camWidth * 0.95;
  }

  private xOf(p: number): number {
    return TRACK_X0 + ((p - this.camStart) / this.camWidth) * (TRACK_X1 - TRACK_X0);
  }

  /** 3D 중계일 때 2D 트랙 요소를 모두 숨김 (한 프레임도 보이지 않게) */
  private hide2dTrack(): void {
    this.trackGfx.clear();
    this.finishLine.setVisible(false);
    this.finishFlag.setVisible(false);
    this.markerTexts.forEach((t) => t.setVisible(false));
    for (const o of [this.gateBack, this.gateFront, this.gateNums]) o.setVisible(false);
  }

  // ───────────────────────── 2.5D 곡선 트랙 ─────────────────────────

  /**
   * 지금 카메라 기준 곡선 표: 진행률 p → 트랙 방향(기울기 θ)과 화면 세로 이동량.
   * 카메라 가운데에서 θ=0, 코너 구간을 지날수록 안쪽(화면 위)으로 휜다.
   * 직선 구간만 보이면 θ=0·이동 0 → 기존 직선 화면과 똑같다 (출발 게이트·결승선 카메라·리플레이 그대로).
   */
  private computeBend(): void {
    const b = this.bend;
    const w = this.camWidth;
    // 카메라가 바라보는 방향 = 선두권(화면 70% 지점)의 트랙 방향 → 코너를 빠져나오면 앞쪽 결승 직선이 곧게 펼쳐짐
    const pc = this.camStart + w * 0.7;
    b.pxPerP = (TRACK_X1 - TRACK_X0) / w;
    b.p0 = this.camStart - w * 0.7;
    b.dp = (w * 2.4) / (BEND_N - 1);
    const rate = (BEND_GAIN * Math.PI) / (CORNER_TO - CORNER_FROM);
    for (let i = 0; i < BEND_N; i++) {
      const p = b.p0 + i * b.dp;
      b.theta[i] = -clamp(rate * cornerOverlap(pc, p), -MAX_THETA, MAX_THETA);
    }
    const ic = clamp(Math.round((pc - b.p0) / b.dp), 0, BEND_N - 1);
    b.y[ic] = 0;
    const step = b.dp * b.pxPerP;
    for (let i = ic + 1; i < BEND_N; i++) b.y[i] = b.y[i - 1]! + Math.tan((b.theta[i - 1]! + b.theta[i]!) / 2) * step;
    for (let i = ic - 1; i >= 0; i--) b.y[i] = b.y[i + 1]! - Math.tan((b.theta[i]! + b.theta[i + 1]!) / 2) * step;
    // 화면에 보이는 구간 중 코너 비율 → 트랙 폭을 눌러 비스듬히 보는 느낌 + 위아래 가운데 맞춤
    const c = Math.abs(cornerOverlap(this.camStart, this.camStart + w)) / w;
    b.corner = smooth(clamp(c * 1.6, 0, 1));
    b.latK = 1 - LAT_SQUASH * b.corner;
    let lo = Infinity;
    let hi = -Infinity;
    const i0 = Math.max(0, Math.floor((this.camStart - b.p0) / b.dp));
    const i1 = Math.min(BEND_N - 1, Math.ceil((this.camStart + w - b.p0) / b.dp));
    for (let i = i0; i <= i1; i++) {
      lo = Math.min(lo, b.y[i]!);
      hi = Math.max(hi, b.y[i]!);
    }
    b.shift = Number.isFinite(lo) ? -(lo + hi) / 2 : 0;
  }

  /** 진행률 p 의 곡선 값 → this.bt(θ), this.by(세로 이동) */
  private sampleBend(p: number): void {
    const b = this.bend;
    const f = (p - b.p0) / b.dp;
    if (f <= 0) {
      this.bt = b.theta[0]!;
      this.by = b.y[0]! + Math.tan(this.bt) * f * b.dp * b.pxPerP;
      return;
    }
    if (f >= BEND_N - 1) {
      this.bt = b.theta[BEND_N - 1]!;
      this.by = b.y[BEND_N - 1]! + Math.tan(this.bt) * (f - (BEND_N - 1)) * b.dp * b.pxPerP;
      return;
    }
    const i = Math.floor(f);
    const a = f - i;
    this.bt = b.theta[i]! + (b.theta[i + 1]! - b.theta[i]!) * a;
    this.by = b.y[i]! + (b.y[i + 1]! - b.y[i]!) * a;
  }

  /** (진행률, 직선 화면 기준 세로 위치) → 곡선 트랙 화면 좌표 this.px/py, 방향 this.pTheta */
  private project(p: number, laneY: number): void {
    this.sampleBend(p);
    const l = (laneY - MID_Y) * this.bend.latK;
    this.px = this.xOf(p) - Math.sin(this.bt) * l;
    this.py = MID_Y + this.bend.shift + this.by + Math.cos(this.bt) * l;
    this.pTheta = this.bt;
  }

  private drawTrack(): void {
    const g = this.trackGfx;
    g.clear();
    const a = this.camStart;
    const b = this.camStart + this.camWidth;
    const inner = TRACK_TOP - 4;
    const outer = TRACK_BOTTOM + 4;
    const N = 48;
    const from = a - this.camWidth * 0.25;
    const to = b + this.camWidth * 0.25;
    const innerPts: { x: number; y: number }[] = [];
    const outerPts: { x: number; y: number }[] = [];
    for (let k = 0; k <= N; k++) {
      const p = from + ((to - from) * k) / N;
      this.project(p, inner);
      innerPts.push({ x: this.px, y: this.py });
      this.project(p, outer);
      outerPts.push({ x: this.px, y: this.py });
    }
    const left = innerPts[0]!;
    const right = innerPts[N]!;

    // 안쪽 잔디 (트랙 안쪽, 화면 위쪽 = 멀리) — 바깥 잔디보다 조금 진하게
    g.fillStyle(THEME.grassAlt, 1);
    g.fillPoints([...innerPts, { x: right.x, y: HEADER_H }, { x: left.x, y: HEADER_H }], true);
    // 흙 트랙
    g.fillStyle(THEME.dirt, 1);
    g.fillPoints([...innerPts, ...[...outerPts].reverse()], true);

    // 흙 줄무늬 (속도감) — 곡선을 따라 사다리꼴
    const stripe = 0.01;
    g.fillStyle(THEME.dirtDark, 1);
    for (let p = Math.floor(from / stripe) * stripe; p < to; p += stripe) {
      if (Math.round(p / stripe) % 2 === 0) continue;
      this.project(p, inner);
      const x0 = this.px, y0 = this.py;
      this.project(p + stripe, inner);
      const x1 = this.px, y1 = this.py;
      this.project(p + stripe, outer);
      const x2 = this.px, y2 = this.py;
      this.project(p, outer);
      g.fillPoints([{ x: x0, y: y0 }, { x: x1, y: y1 }, { x: x2, y: y2 }, { x: this.px, y: this.py }], true);
    }

    // 말 그림자가 떨어지는 안쪽 난간 그늘 (원근감)
    g.lineStyle(10, 0x000000, 0.12);
    g.strokePoints(innerPts.map((q) => ({ x: q.x, y: q.y + 8 })), false);
    // 흰 난간 (안쪽·바깥쪽) + 기둥
    g.lineStyle(6, THEME.rail, 1);
    g.strokePoints(innerPts, false);
    g.strokePoints(outerPts, false);
    g.fillStyle(THEME.rail, 1);
    const post = 0.005;
    for (let p = Math.floor(from / post) * post; p < to; p += post) {
      this.project(p, inner);
      g.fillRect(this.px - 3, this.py - 14, 6, 14);
      this.project(p, outer);
      g.fillRect(this.px - 3, this.py, 6, 16);
    }

    // 출발선
    if (a < 0.01) {
      this.project(0, TRACK_TOP);
      const sx = this.px, sy = this.py;
      this.project(0, TRACK_BOTTOM);
      g.lineStyle(6, 0xffffff, 1);
      g.lineBetween(sx, sy, this.px, this.py);
    }

    // 거리 표지 (트랙 1000m 가정, 100m 마다) — 바깥 난간 안쪽에
    const mark = 0.1;
    let k = 0;
    for (let p = Math.max(0, Math.ceil(a / mark) * mark); p <= Math.min(1, b) && k < this.markerTexts.length; p += mark) {
      const m = Math.round(p * 1000);
      if (m === 0 || m === 1000) continue;
      this.project(p, TRACK_BOTTOM - 16);
      this.markerTexts[k++]!.setPosition(this.px, this.py).setRotation(this.pTheta).setText(`${1000 - m}m`).setVisible(true);
    }
    for (; k < this.markerTexts.length; k++) this.markerTexts[k]!.setVisible(false);

    // 결승선 (결승 직선 위 → 기울기 0, 난간 사이 높이에 맞춤)
    this.project(1, TRACK_TOP);
    const fx = this.px;
    const fy = this.py;
    this.project(1, TRACK_BOTTOM);
    const fh = Math.max(10, this.py - fy);
    const finishVisible = fx > TRACK_X0 - 20 && fx < PANEL_X;
    this.finishLine.setVisible(finishVisible).setPosition(fx, fy).setRotation(this.pTheta);
    if (Math.abs(this.finishLine.height - fh) > 0.5) this.finishLine.setSize(20, fh);
    this.finishFlag.setVisible(finishVisible && fx < PANEL_X - 90).setPosition(fx, fy + 4);
  }

  /**
   * 등번호 겹침 정리: 순위 순서대로 자리를 잡고, 앞 순위 번호와 겹치면 위/아래로 살짝 비켜 서고,
   * 그래도 겹치면 흐리게 → 10~20마리가 코너에서 몰려도 선두권 번호는 항상 또렷하다.
   */
  private layoutBadges(race: RaceResult, showTick: number, dt: number): void {
    const n = this.horses.length;
    const order = this.lastRanking.length === n ? this.lastRanking : this.horses.map((_, i) => i);
    const placed = this.placed;
    placed.length = 0;
    const k = 1 - Math.exp(-Math.min(dt, 100) / 120);
    // 작전 효과 중인 말 (아이콘)
    const tac = new Map<number, string>();
    if (this.tacticsOn) {
      for (const r of race.tactics ?? []) {
        if (r.applied && r.tick <= showTick && showTick < r.endTick) tac.set(r.lane, TACTIC_SPECS[r.tactic].emoji);
      }
    }
    const fits = (x0: number, y0: number, x1: number, y1: number) => {
      for (let j = 0; j < placed.length; j += 4) {
        if (x0 < placed[j + 2]! && x1 > placed[j]! && y0 < placed[j + 3]! && y1 > placed[j + 1]!) return false;
      }
      return true;
    };
    for (const lane of order) {
      const h = this.horses[lane];
      if (!h) continue;
      const base = (h.badge.getData('a') as number | undefined) ?? 1;
      const w = h.badge.displayWidth * 0.92;
      const ht = h.badge.displayHeight * 0.86;
      let dy = 0;
      let ok = base < 0.2; // 안 보이는 번호(게이트 안)는 자리 차지 안 함
      if (!ok) {
        for (const cand of [0, -0.95, 0.95, -1.9]) {
          const y = h.by + cand * ht;
          if (fits(h.bx - w / 2, y - ht / 2, h.bx + w / 2, y + ht / 2)) {
            dy = cand * ht;
            ok = true;
            break;
          }
        }
      }
      h.badgeDy += (dy - h.badgeDy) * k;
      h.badgeA += ((ok ? 1 : 0.3) - h.badgeA) * k;
      const y = h.by + h.badgeDy;
      if (ok && base >= 0.2) placed.push(h.bx - w / 2, y - ht / 2, h.bx + w / 2, y + ht / 2);
      h.badge.setPosition(h.bx, y).setAlpha(base * h.badgeA);
      // 작전이 적용된 순간 1.5초 동안 등번호를 크게 두근두근 + 맨 위로 (빔에서 어느 말인지 바로 보이게)
      const flash = this.badgeFlash.get(lane);
      if (flash !== undefined && this.time.now < flash) {
        const k = 1 - (flash - this.time.now) / 1500;
        h.badge.setScale(h.badge.scaleX * (1.35 + 0.15 * Math.sin(k * Math.PI * 6))).setAlpha(Math.max(0.9, base));
        this.badgeLayer.bringToTop(h.badge);
      } else if (flash !== undefined) {
        this.badgeFlash.delete(lane);
      }
      const icon = tac.get(lane);
      if (icon) {
        if (h.chip.text !== icon) h.chip.setText(icon);
        h.chip
          .setVisible(true)
          .setScale(h.badge.scaleX)
          .setPosition(h.bx - h.badge.displayWidth / 2 - 3, y)
          .setAlpha(base * Math.max(0.5, h.badgeA));
      } else if (h.chip.visible) {
        h.chip.setVisible(false);
      }
    }
  }

  /**
   * 작전 타임 안내 (트랙 아래 띠): 열림 "2차 작전 타임 · 6초" → 마감 "곧 적용" → 적용된 말 번호·이름.
   * 결승선 장면 전에 끝나고, 리플레이·세리머니 중에는 숨김.
   */
  private updateTacticBar(race: RaceResult, elapsed: number, tick: number): void {
    let text = '';
    if (this.tacticsOn && this.show === 'live' && elapsed >= 0) {
      for (const w of this.windows) {
        if (elapsed >= w.openMs && elapsed < w.closeMs) {
          text = `🎯 ${w.no}차 작전 타임 · ${Math.ceil((w.closeMs - elapsed) / 1000)}초   📱 휴대폰에서 고르세요`;
          break;
        }
        if (elapsed >= w.closeMs && tick < w.applyTick) {
          text = `🎯 ${w.no}차 작전 마감 · 곧 적용!`;
          break;
        }
        if (tick >= w.applyTick && tick < w.applyTick + 70) {
          const rank = new Map(this.lastRanking.map((l, r) => [l, r]));
          const recs = (race.tactics ?? [])
            .filter((x) => x.window === w.no && x.applied)
            .sort((x, y) => (rank.get(x.lane) ?? 99) - (rank.get(y.lane) ?? 99));
          if (recs.length === 0) {
            text = `🎯 ${w.no}차 작전 · 모두 기본 페이스`;
          } else {
            const names = recs.slice(0, 4).map((x) => `${TACTIC_SPECS[x.tactic].emoji} ${x.id}번 · ${TACTIC_SPECS[x.tactic].label}`);
            text = `🎯 ${w.no}차 작전 적용  ${names.join('  ')}${recs.length > 4 ? `  외 ${recs.length - 4}마리` : ''}`;
          }
          break;
        }
      }
    }
    if (text === this.tacticBarKey) return;
    const wasHidden = this.tacticBarKey === '';
    this.tacticBarKey = text;
    if (!text) {
      this.tacticBar.setVisible(false);
      return;
    }
    const t = this.tacticBar.getByName('text') as Phaser.GameObjects.Text;
    t.setText(text).setScale(1);
    const maxW = TRACK_X1 - TRACK_X0 - 60;
    if (t.width > maxW) t.setScale(maxW / t.width);
    this.tacticBar.setVisible(true);
    if (wasHidden) {
      this.tweens.killTweensOf(this.tacticBar);
      this.tacticBar.setAlpha(0).setScale(1, 0.5);
      this.tweens.add({ targets: this.tacticBar, alpha: 1, scaleY: 1, duration: 200, ease: 'Back.Out' });
    }
  }

  private drawMinimap(prog: Float64Array): void {
    const g = this.miniGfx;
    g.clear();
    const x0 = TRACK_X0 + 30;
    const x1 = TRACK_X1 - 50;
    g.fillStyle(0xffffff, 0.25);
    g.fillRoundedRect(x0, MINI_Y - 4, x1 - x0, 8, 4);
    // 코너 구간 표시
    g.fillStyle(THEME.gold, 0.35);
    g.fillRoundedRect(x0 + CORNER_FROM * (x1 - x0), MINI_Y - 7, (CORNER_TO - CORNER_FROM) * (x1 - x0), 14, 7);
    // 결승
    g.fillStyle(THEME.gold, 1);
    g.fillRect(x1 - 2, MINI_Y - 18, 6, 36);
    for (let i = 0; i < prog.length; i++) {
      const id = this.race!.entrants[i]!.id;
      const x = x0 + Math.min(prog[i]!, 1) * (x1 - x0);
      g.fillStyle(horseColor(id), 1);
      g.fillCircle(x, MINI_Y + ((i % 3) - 1) * 6, 7);
    }
  }
}

/** a→c 구간 중 코너에 걸친 길이 (c<a 면 음수) */
function cornerOverlap(a: number, c: number): number {
  const lo = Math.min(a, c);
  const hi = Math.max(a, c);
  const o = Math.max(0, Math.min(hi, CORNER_TO) - Math.max(lo, CORNER_FROM));
  return c >= a ? o : -o;
}

/** 같은 경주(시드·명단·시간)를 작전만 더해 다시 계산한 결과인가 */
function sameRace(a: RaceResult, b: RaceResult): boolean {
  return (
    a.seed === b.seed &&
    a.raceSeconds === b.raceSeconds &&
    a.engineVersion === b.engineVersion &&
    a.entrants.length === b.entrants.length &&
    a.entrants.every((e, i) => e.id === b.entrants[i]!.id)
  );
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function formatTime(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
}
