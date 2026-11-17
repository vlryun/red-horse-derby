import type { EventType } from './types';

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
  'SPURT',
];

/** v3: 가속(부스터)과 감속(방해) 이벤트를 따로 뽑는다 (등록 순서 = 가중치 선택 순서) */
export const BOOST_ORDER: readonly EventType[] = ['CARROT', 'FART', 'CRAZY'];
export const SETBACK_ORDER: readonly EventType[] = ['BANANA', 'SLEEP', 'TURTLE', 'RUNAWAY'];

export const EVENT_SPECS: Record<EventType, EventSpec> = {
  // 짧은 순간 가속 (자주, 짧게, 한 번에 약 10m)
  CARROT: { mult: 1450, minTicks: 28, maxTicks: 38, weight: 18, label: '당근 부스터', emoji: '🥕', good: true },
  BANANA: { mult: 400, minTicks: 25, maxTicks: 35, weight: 16, label: '바나나 슬립', emoji: '🍌', good: false },
  SLEEP: { mult: 0, minTicks: 30, maxTicks: 50, weight: 12, label: '갑자기 졸음', emoji: '💤', good: false },
  CRAZY: { mult: 1550, minTicks: 36, maxTicks: 50, weight: 10, label: '미친 질주', emoji: '🔥', good: true },
  TURTLE: { mult: 550, minTicks: 60, maxTicks: 90, weight: 12, label: '거북이 모드', emoji: '🐢', good: false },
  FART: { mult: 1700, minTicks: 18, maxTicks: 26, weight: 14, label: '방귀 부스터', emoji: '💨', good: true },
  RUNAWAY: { mult: 0, minTicks: 50, maxTicks: 70, weight: 8, label: '탈주 선언', emoji: '🏃', good: false },
  AWAKEN: { mult: 1500, minTicks: 80, maxTicks: 110, weight: 0, label: '붉은 말 각성', emoji: '🐎', good: true },
  // 마지막 직선 스퍼트: 잔여 200m 부터 선두권 말마다 한 번씩 기회 (순위·번호와 무관한 확률)
  SPURT: { mult: 1450, minTicks: 30, maxTicks: 44, weight: 0, label: '막판 스퍼트', emoji: '⚡', good: true },
};

export const BOOST_TOTAL_WEIGHT = BOOST_ORDER.reduce((s, t) => s + EVENT_SPECS[t].weight, 0);
export const SETBACK_TOTAL_WEIGHT = SETBACK_ORDER.reduce((s, t) => s + EVENT_SPECS[t].weight, 0);
