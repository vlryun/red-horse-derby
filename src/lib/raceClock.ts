import type { RaceClock } from '../game/clock';

export interface TimingMeta {
  startAtMs: number;
  pausedAtMs: number | null;
  pausedMs: number;
}

/**
 * 서버 기준 경주 시계.
 * 경과 = (일시정지 시각 또는 서버 현재 시각) − 출발 시각 − 누적 정지 시간
 * meta 는 함수로 받는다 → 일시정지/재개 정보가 갱신되면 시계를 새로 만들지 않아도 즉시 반영.
 */
export class SyncedRaceClock implements RaceClock {
  constructor(
    private readonly meta: () => TimingMeta,
    private readonly time: { now(): number },
  ) {}

  elapsedMs(): number {
    const m = this.meta();
    const ref = m.pausedAtMs ?? this.time.now();
    return ref - m.startAtMs - m.pausedMs;
  }

  isPaused(): boolean {
    return this.meta().pausedAtMs !== null;
  }
}
