/** ❄️ 엔진 v2 원본 보관본 — 수정 금지 (v2 로 시작된 경주를 그대로 재생하기 위해 유지) */
/**
 * 경주 엔진 상수.
 * ⚠️ 이 값을 하나라도 바꾸면 같은 시드라도 결과가 달라진다.
 *    반드시 ENGINE_VERSION 을 올리고 golden 테스트를 갱신할 것.
 *    (3단계부터 서버와 클라이언트가 이 버전으로 일치 여부를 검증한다)
 */
export const ENGINE_VERSION = 2;

export const MAX_ENTRANTS = 50;

/** 시뮬레이션 틱 길이(ms). 20Hz. */
export const TICK_MS = 50;

/** 트랙 길이 (정수 단위). 화면 픽셀과 무관한 논리 단위. */
export const TRACK_LENGTH = 1_000_000;

/** 출발 직후 이벤트 금지 구간 (틱) */
export const EVENT_GRACE_TICKS = 60;

export const SPEED = {
  /** 기본 속도(단위/틱) 평균. 1등 ≈ 69초 */
  base: 700,
  /** 말마다 고정 능력치 편차 ±(단위/틱) */
  baseSpread: 18,
  /** 목표 속도 배율 범위(천분율) */
  paceMin: 860,
  paceMax: 1140,
  /** 목표 속도 재설정 주기(틱) */
  paceIntervalMin: 16,
  paceIntervalMax: 40,
  /** 틱당 최대 가속/감속량 */
  accel: 14,
  decel: 22,
} as const;

/** 매 틱 이벤트 발생 확률 = num/den  (≈ 경주당 25회) */
export const EVENT_CHANCE = { num: 1, den: 58 } as const;

/** 붉은 말 각성: 선두 진행률이 이 비율(천분율) 이상일 때부터 가능 */
export const AWAKEN_MIN_PROGRESS = 600;

/** 붉은 말 각성 전용 판정: 후반부 매 틱 확률 num/den 으로 하위 절반 중 한 마리가 각성 */
export const AWAKEN_CHANCE = { num: 1, den: 260 } as const;

/**
 * 경주 시간 설정 (관리자가 조정 가능).
 * raceSeconds ≈ 1등 도착 시간. 전체 종료는 보통 +10~15%.
 */
export const RACE_SECONDS = { min: 30, max: 180, default: 70 } as const;

export interface Tuning {
  raceSeconds: number;
  base: number;
  baseSpread: number;
  accel: number;
  decel: number;
  eventDen: number;
  awakenDen: number;
  /** 틱 길이 환산: 기준(70초)용 틱 수 → 이 경주의 틱 수 */
  ticks: (refTicks: number) => number;
  /** 안전장치: 이 틱 수를 넘기면 강제 종료하고 위치 기준으로 순위 확정 (목표 시간의 2배) */
  maxTicks: number;
}

/**
 * 경주 시간에 맞춰 모든 값을 정수로 환산 (70초 = 기준값 그대로).
 * "같은 경주를 빨리/느리게 재생"하는 것과 같도록 시간 축 전체를 늘이고 줄인다:
 * 속도 ∝ 1/k, 지속시간 ∝ k, 가속도 ∝ 1/k²  (k = 설정초/70)
 */
export function tuningFor(raceSeconds: number): Tuning {
  const s = raceSeconds;
  const d = RACE_SECONDS.default;
  const base = Math.floor((SPEED.base * d) / s);
  return {
    raceSeconds: s,
    base,
    baseSpread: Math.floor((base * SPEED.baseSpread) / SPEED.base),
    accel: Math.max(1, Math.floor((SPEED.accel * d * d) / (s * s))),
    decel: Math.max(1, Math.floor((SPEED.decel * d * d) / (s * s))),
    ticks: (refTicks: number) => Math.max(1, Math.floor((refTicks * s) / d)),
    eventDen: Math.max(10, Math.floor((EVENT_CHANCE.den * s) / RACE_SECONDS.default)),
    awakenDen: Math.max(20, Math.floor((AWAKEN_CHANCE.den * s) / RACE_SECONDS.default)),
    maxTicks: Math.floor((s * 2 * 1000) / TICK_MS),
  };
}
