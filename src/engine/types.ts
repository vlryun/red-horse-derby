import type { TacticOrder, TacticRecord } from './tactics';

export type EventType =
  | 'CARROT' // 당근 부스터: 순간 가속
  | 'BANANA' // 바나나 슬립: 감속
  | 'SLEEP' // 갑자기 졸음: 잠시 멈춤
  | 'CRAZY' // 미친 질주
  | 'TURTLE' // 거북이 모드
  | 'FART' // 방귀 부스터
  | 'RUNAWAY' // 탈주 선언: 트랙 이탈 후 복귀
  | 'AWAKEN' // 붉은 말 각성 (후반, 하위권 전용)
  | 'SPURT'; // 막판 스퍼트 (잔여 200m 부터, 선두권 전용)

export interface Entrant {
  /** 참가 번호(게이트 번호) 1..50, 유일 */
  id: number;
  name: string;
}

export interface RaceInput {
  seed: number; // uint32
  entrants: Entrant[];
  /** 목표 경주 시간(초, ≈1등 도착). 30~180, 기본 70 */
  raceSeconds?: number;
  /** 엔진 v4: 참가자 작전 (마감된 창의 것만). 없으면 기본 페이스 */
  tactics?: TacticOrder[];
}

export interface RaceEvent {
  tick: number;
  endTick: number;
  horse: number; // 레인 인덱스 (entrants 배열 인덱스)
  type: EventType;
}

export interface FinishRecord {
  lane: number;
  id: number;
  name: string;
  rank: number; // 1-based
  /** 결승 통과 시각(ms, 틱 내부 보간 포함) — 미완주 시 null */
  finishMs: number | null;
}

export interface RaceResult {
  engineVersion: number;
  seed: number;
  raceSeconds: number;
  /** 평균 기본 속도(단위/틱) — 화면 애니메이션 속도 정규화용 */
  baseSpeed: number;
  entrants: Entrant[];
  /** 마지막 시뮬레이션 틱 */
  totalTicks: number;
  /** positions[tick * n + lane] = 해당 틱 종료 시점 위치 (0..TRACK_LENGTH 로 clamp) */
  positions: Int32Array;
  /** 이벤트 발생 시간순 목록 */
  events: RaceEvent[];
  /** 최종 순위 (rank 오름차순) */
  standings: FinishRecord[];
  /** finishTick[lane] — 결승선을 통과한 틱 (미완주 -1) */
  finishTick: Int32Array;
  /** 엔진 v4: 처리된 작전 (적용 틱 순) — v3 이하는 빈 배열 */
  tactics?: TacticRecord[];
  /** 결과 무결성 해시: 서버/클라이언트 일치 검증용 */
  hash: string;
}
