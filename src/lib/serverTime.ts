/**
 * 서버 시각 동기화 (NTP 와 같은 원리).
 *  - 서버 시각을 여러 번 물어보고, 왕복 시간이 가장 짧은(=가장 정확한) 표본들로 기기 시계와의 차이를 추정
 *  - 휴대폰 시계가 몇 분씩 틀려 있어도 모든 기기가 같은 "경주 경과 시간"을 계산하게 됨
 *  - 기기 내부 시계는 performance.now() (단조 증가, 사용자가 시계를 바꿔도 안 튐) 사용
 *  - 재동기화 시 작은 차이는 절반씩 천천히 반영 → 화면이 덜컥거리지 않음, 큰 차이(1초+)는 즉시 반영
 */
export class ServerTime {
  private offset = 0;
  private ready = false;
  private syncing: Promise<void> | null = null;
  /** 마지막 동기화의 최소 왕복시간(ms) — 정확도 지표 (오차 ≈ 이 값의 절반 이하) */
  lastRtt = Infinity;

  constructor(
    private readonly fetchServerMs: () => Promise<number>,
    private readonly localNow: () => number = () => performance.timeOrigin + performance.now(),
  ) {}

  /** 서버 기준 현재 시각(ms) */
  now(): number {
    return this.localNow() + this.offset;
  }

  isReady(): boolean {
    return this.ready;
  }

  getOffset(): number {
    return this.offset;
  }

  /** 동시에 여러 번 호출돼도 한 번만 실행 */
  sync(samples = 5): Promise<void> {
    if (!this.syncing) {
      this.syncing = this.doSync(samples).finally(() => {
        this.syncing = null;
      });
    }
    return this.syncing;
  }

  private async doSync(samples: number): Promise<void> {
    const got: { rtt: number; off: number }[] = [];
    for (let i = 0; i < samples; i++) {
      try {
        const t0 = this.localNow();
        const s = await this.fetchServerMs();
        const t1 = this.localNow();
        if (!Number.isFinite(s)) continue;
        got.push({ rtt: t1 - t0, off: s - (t0 + t1) / 2 });
      } catch {
        /* 표본 하나 실패는 무시 */
      }
    }
    if (got.length === 0) return; // 전부 실패: 이전 값 유지
    got.sort((a, b) => a.rtt - b.rtt);
    const best = got.slice(0, Math.min(3, got.length)).map((g) => g.off).sort((a, b) => a - b);
    const off = best[Math.floor(best.length / 2)]!; // 가장 빠른 3개 표본의 중앙값 (튀는 값 제거)
    this.lastRtt = got[0]!.rtt;
    if (!this.ready || Math.abs(off - this.offset) > 1000) this.offset = off;
    else this.offset += (off - this.offset) * 0.5;
    this.ready = true;
  }
}
