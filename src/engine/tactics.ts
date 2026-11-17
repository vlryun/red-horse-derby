import { TICK_MS } from './config';

/**
 * 참가자 작전 (엔진 v4).
 *
 * 경주 중 세 번(초반 직선 · 코너 진입 · 마지막 직선 직전) 작전 선택 창이 열린다.
 * 창 시간·적용 시각은 경주 시간 설정만으로 정해지는 정수 값 → 서버(SQL)와 모든 화면이 똑같이 계산한다.
 * ⚠️ 여기 숫자를 바꾸면 SQL(…0006_tactics.sql 의 _tactic_window)도 같이 바꾸고 ENGINE_VERSION 을 올릴 것.
 */
export type TacticType = 'SAVE' | 'CHASE' | 'SPRINT';
export const TACTIC_TYPES: readonly TacticType[] = ['SAVE', 'CHASE', 'SPRINT'];

export interface TacticSpec {
  label: string;
  emoji: string;
  /** 폰에 보여줄 한 줄 설명 */
  desc: string;
  /** 속도 배율(천분율) */
  mult: number;
  /** 체력 변화 */
  stamina: number;
}

/** 화면 표시용 (현재 엔진 v6 기준 설명). 실제 수치는 tacticParams(엔진 버전) 로 */
export const TACTIC_SPECS: Record<TacticType, TacticSpec> = {
  SAVE: { label: '체력 아끼기', emoji: '🌿', desc: '잠깐 천천히 · 체력 +30', mult: 970, stamina: 30 },
  CHASE: { label: '따라잡기', emoji: '🎯', desc: '앞말에 바짝 붙기 · 체력 −10', mult: 1090, stamina: -10 },
  SPRINT: { label: '전력 질주', emoji: '⚡', desc: '지금 크게 가속 · 체력 −30', mult: 1150, stamina: -30 },
};

export interface TacticParams {
  /** 속도 배율(천분율) */
  mult: number;
  /** 따라잡기: 가까운 앞말이 없을 때 배율 (null = 적용 안 됨) */
  multNoTarget: number | null;
  stamina: number;
  /** 효과 시간 (70초 경주 기준 틱) */
  refTicks: number;
}

/**
 * 엔진 버전별 작전 수치.
 *  v4·v5: 체력 아끼기 −4%·+20 · 따라잡기 +6%(앞말 없으면 불발)·−10 · 전력 질주 +11%·−30, 모두 5초
 *  v6   : 체력 아끼기 4초 −3%·+30 · 따라잡기 6초 +9%(앞말 없으면 +4%)·−10 · 전력 질주 6초 +15%·−30
 */
export function tacticParams(version: number, t: TacticType): TacticParams {
  if (version >= 6) {
    if (t === 'SAVE') return { mult: 970, multNoTarget: null, stamina: 30, refTicks: 80 };
    if (t === 'CHASE') return { mult: 1090, multNoTarget: 1040, stamina: -10, refTicks: 120 };
    return { mult: 1150, multNoTarget: null, stamina: -30, refTicks: 120 };
  }
  if (t === 'SAVE') return { mult: 960, multNoTarget: null, stamina: 20, refTicks: 100 };
  if (t === 'CHASE') return { mult: 1060, multNoTarget: null, stamina: -10, refTicks: 100 };
  return { mult: 1110, multNoTarget: null, stamina: -30, refTicks: 100 };
}

/** 작전 효과 틱 수: 경주 시간에 비례하되 짧은 경기에서도 60% 는 보장 (v4·v5 는 예전 규칙 그대로) */
export function tacticTicks(version: number, t: TacticType, raceSeconds: number): number {
  if (version < 6) return Math.min(100, Math.max(60, Math.floor((100 * raceSeconds) / 70)));
  const ref = tacticParams(version, t).refTicks;
  return Math.min(ref, Math.max(Math.floor((ref * 6) / 10), Math.floor((ref * raceSeconds) / 70)));
}

export const STAMINA_START = 60;
export const STAMINA_MAX = 100;
/** "가까운 앞말": 바로 앞 25m 이내에 달리는 말이 있어야 따라잡기 가능 */
export const CHASE_GAP = 25_000;

export const TACTIC_WINDOW_COUNT = 3;
/** 창이 닫히는 시각 (경주 시간의 천분율): 초반 직선 · 코너 진입 · 마지막 직선 직전 */
const CLOSE_PERMILLE = [170, 360, 600] as const;
/** 마감 → 적용까지 (서버에서 선택을 받아 모든 화면에 퍼지는 시간) */
export const APPLY_DELAY_TICKS = 20;
/** 서버가 마감 후 이만큼 지나야 그 창의 선택을 공개 (마지막 요청이 확실히 저장된 뒤) */
export const REVEAL_GRACE_MS = 300;

export interface TacticWindow {
  /** 1..3 */
  no: number;
  openMs: number;
  closeMs: number;
  /** 효과가 시작되는 틱 */
  applyTick: number;
  /** 효과가 끝나는 틱 (이 틱부터 원래 속도) */
  endTick: number;
}

/** 경주 시간(초) → 세 번의 작전 창. 짧은 경기에서도 겹치지 않고 결승 전에 끝난다 (endTick = 가장 긴 작전 효과 끝) */
export function tacticWindows(raceSeconds: number, version = 6): TacticWindow[] {
  const s = raceSeconds;
  const len = Math.min(6000, Math.max(3500, s * 130));
  const dur = Math.max(...TACTIC_TYPES.map((t) => tacticTicks(version, t, s)));
  return CLOSE_PERMILLE.map((pm, i) => {
    const closeMs = s * pm;
    const applyTick = Math.floor(closeMs / TICK_MS) + APPLY_DELAY_TICKS;
    return { no: i + 1, openMs: closeMs - len, closeMs, applyTick, endTick: applyTick + dur };
  });
}

/** 참가자가 고른 작전 (서버 기록) */
export interface TacticOrder {
  /** 말 번호 (entrant id) */
  id: number;
  window: number;
  tactic: TacticType;
}

export type TacticFailReason = 'NO_TARGET' | 'NO_STAMINA' | 'FINISHED';

/** 엔진이 실제로 처리한 작전 (적용 여부 포함) */
export interface TacticRecord {
  window: number;
  lane: number;
  id: number;
  tactic: TacticType;
  tick: number;
  endTick: number;
  applied: boolean;
  reason: TacticFailReason | null;
  /** v6 따라잡기: 가까운 앞말이 없어 약하게(+4%) 적용됨 */
  weak?: boolean;
  staminaBefore: number;
  staminaAfter: number;
}

export const TACTIC_FAIL_TEXT: Record<TacticFailReason, string> = {
  NO_TARGET: '가까운 앞말이 없어 적용 안 됨',
  NO_STAMINA: '체력이 부족해 적용 안 됨',
  FINISHED: '이미 결승 통과',
};

export function isTacticType(v: unknown): v is TacticType {
  return v === 'SAVE' || v === 'CHASE' || v === 'SPRINT';
}
