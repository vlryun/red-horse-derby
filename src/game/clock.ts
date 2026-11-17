/**
 * 경주 시계 추상화.
 * 화면은 "경주 시작 후 경과 ms" 만 알면 그릴 수 있다.
 *  - 1단계: LocalRaceClock (브라우저 로컬 시계, 데모용)
 *  - 3단계: ServerRaceClock (Supabase 서버 시각 기준 startAt / pause 누적치로 계산) 로 교체
 * 음수 = 출발 전 카운트다운.
 */
export interface RaceClock {
  elapsedMs(): number;
  isPaused(): boolean;
}

export class LocalRaceClock implements RaceClock {
  private startAt: number;
  private pausedAt: number | null = null;
  private pausedTotal = 0;

  /**
   * @param speed 데모/리허설용 배속 (1 = 실시간). 실제 행사에서는 항상 1.
   */
  constructor(
    countdownMs = 3000,
    private readonly speed = 1,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.startAt = this.now() + countdownMs / speed;
  }

  elapsedMs(): number {
    const t = this.pausedAt ?? this.now();
    return (t - this.startAt - this.pausedTotal) * this.speed;
  }

  isPaused(): boolean {
    return this.pausedAt !== null;
  }

  pause(): void {
    if (this.pausedAt === null) this.pausedAt = this.now();
  }

  resume(): void {
    if (this.pausedAt !== null) {
      this.pausedTotal += this.now() - this.pausedAt;
      this.pausedAt = null;
    }
  }
}
