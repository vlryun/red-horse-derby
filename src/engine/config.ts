/**
 * 경주 엔진 상수.
 * ⚠️ 이 값을 하나라도 바꾸면 같은 시드라도 결과가 달라진다.
 *    반드시 ENGINE_VERSION 을 올리고 golden 테스트를 갱신할 것.
 *    (3단계부터 서버와 클라이언트가 이 버전으로 일치 여부를 검증한다)
 */
export const ENGINE_VERSION = 6;

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
  baseSpread: 10, // v2: 18 → 선두 독주 줄이기
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

/**
 * v3 이벤트 판정 (70초 기준 틱 단위, 경주 시간에 비례해 환산)
 *  - 부스터: 매 틱 1/BOOST_DEN 확률. 같은 말은 끝난 뒤 쿨다운 동안 다시 안 걸리고,
 *    다른 말의 부스터 시작 직후(STAGGER)에는 새 부스터를 막아 "동시에 가속해서 추월이 안 보이는" 상황을 줄임.
 *    대상은 뒤쪽 순위일수록 조금 더 잘 뽑힘(따라잡을 기회). 선두도 뽑힐 수 있음.
 *  - 방해(바나나·졸음·거북이·탈주): 매 틱 1/SETBACK_DEN
 *  - 막판 스퍼트: 선두가 잔여 200m 에 들어오면, 그 순간 앞에서 SPURT_TOP 마리 중 선두와 SPURT_PACK 이내인 말마다
 *    한 번씩 매 틱 1/SPURT_DEN (선두 포함, 순위·번호와 무관한 같은 확률)
 */
export const BOOST_DEN = 52;
export const SETBACK_DEN = 120;
export const BOOST_COOLDOWN_TICKS = 100;
export const BOOST_STAGGER_TICKS = 16;
export const SPURT_FROM = 800; // 천분율 (= 잔여 200m)
export const SPURT_PACK = 45_000; // 선두와 45m 이내
export const SPURT_DEN = 30;
export const SPURT_TOP = 5; // 앞에서 5마리까지
export const SPURT_MAX = 5; // 경주당 스퍼트 최대 5번 (막판 볼거리가 되도록 희소하게)
export const SPURT_STAGGER_TICKS = 12;
/** v5: 말마다 고정 능력치 편차 (v2~v4: 10) */
/**
 * v5 밸런스 (순위 보정 없이 접전 유지 · scripts/balance.ts 로 측정해 정함)
 *  - BASE_SPREAD_V5: 말마다 고정 능력치 편차 (v2~v4: 10) → 초반 선두가 혼자 달아나지 않게
 *  - 막판 체력: 잔여 200m(FATIGUE_FROM_PERMIL)부터 남은 체력만큼 버팀. 체력 10 당 속도 FATIGUE_PER_10 천분율 (60 기준)
 *    → 작전이 없으면 모두 60 이라 영향 없음. 아낀 말은 막판에 덜 지치고, 다 쓴 말은 조금 지침
 *  - 바람막이: 바로 앞 6m 안에 달리는 말이 있으면 +2.5% (거리 기준이라 선두도 앞말을 따라잡으면 똑같음)
 */
export const BASE_SPREAD_V5 = 4;
export const FATIGUE_FROM_PERMIL = 800;
export const FATIGUE_PER_10 = 8;
/** v6: 막판 체력 효과를 키워 "아껴서 막판" 전략도 통하게 (체력 10 당 1.2%) */
export const FATIGUE_PER_10_V6 = 12;
export const DRAFT_BONUS = 25;
export const DRAFT_GAP_UNITS = 6_000;

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
  boostDen: number;
  setbackDen: number;
  spurtDen: number;
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
    boostDen: Math.max(8, Math.floor((BOOST_DEN * s) / d)),
    setbackDen: Math.max(10, Math.floor((SETBACK_DEN * s) / d)),
    spurtDen: Math.max(6, Math.floor((SPURT_DEN * s) / d)),
    awakenDen: Math.max(20, Math.floor((AWAKEN_CHANCE.den * s) / RACE_SECONDS.default)),
    maxTicks: Math.floor((s * 2 * 1000) / TICK_MS),
  };
}
