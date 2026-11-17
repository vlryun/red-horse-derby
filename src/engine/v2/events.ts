/** ❄️ 엔진 v2 원본 보관본 — 수정 금지 (v2 로 시작된 경주를 그대로 재생하기 위해 유지) */
import type { EventType } from '../types';

export interface EventSpec {
  /** 속도 배율(천분율). 0 = 정지 */
  mult: number;
  minTicks: number;
  maxTicks: number;
  weight: number;
  /** 화면 표시용 */
  label: string;
  emoji: string;
  /** 긍정(가속) 이벤트 여부 */
  good: boolean;
}

/** 등록 순서 = 가중치 선택 순서 (변경 시 ENGINE_VERSION 증가) */
export const EVENT_ORDER: readonly EventType[] = [
  'CARROT',
  'BANANA',
  'SLEEP',
  'CRAZY',
  'TURTLE',
  'FART',
  'RUNAWAY',
  'AWAKEN',
];

export const EVENT_SPECS: Record<EventType, EventSpec> = {
  CARROT: { mult: 1600, minTicks: 30, maxTicks: 40, weight: 18, label: '당근 부스터', emoji: '🥕', good: true },
  BANANA: { mult: 400, minTicks: 25, maxTicks: 35, weight: 16, label: '바나나 슬립', emoji: '🍌', good: false },
  SLEEP: { mult: 0, minTicks: 30, maxTicks: 50, weight: 12, label: '갑자기 졸음', emoji: '💤', good: false },
  CRAZY: { mult: 1750, minTicks: 50, maxTicks: 70, weight: 10, label: '미친 질주', emoji: '🔥', good: true },
  TURTLE: { mult: 550, minTicks: 60, maxTicks: 90, weight: 12, label: '거북이 모드', emoji: '🐢', good: false },
  FART: { mult: 1900, minTicks: 20, maxTicks: 30, weight: 14, label: '방귀 부스터', emoji: '💨', good: true },
  RUNAWAY: { mult: 0, minTicks: 50, maxTicks: 70, weight: 8, label: '탈주 선언', emoji: '🏃', good: false },
  AWAKEN: { mult: 1550, minTicks: 90, maxTicks: 120, weight: 0, label: '붉은 말 각성', emoji: '🐎', good: true },
  // v3 에서 생긴 타입. v2 에서는 절대 발생하지 않음 (EVENT_ORDER 에 없음, 가중치 0)
  SPURT: { mult: 1000, minTicks: 1, maxTicks: 1, weight: 0, label: '막판 스퍼트', emoji: '⚡', good: true },
};

export const EVENT_TOTAL_WEIGHT = EVENT_ORDER.reduce((s, t) => s + EVENT_SPECS[t].weight, 0);
