import { describe, expect, it } from 'vitest';
import { ServerTime } from '../serverTime';
import { SyncedRaceClock } from '../raceClock';

/** 가짜 네트워크: 기기 시계가 serverAhead 만큼 늦고, 요청마다 지연이 다름 */
function fakeNet(serverAheadMs: number, delays: number[]) {
  let local = 1_000_000;
  let i = 0;
  const localNow = () => local;
  const fetchServerMs = async () => {
    const d = delays[i++ % delays.length]!;
    local += d / 2; // 요청이 서버에 도착
    const s = local + serverAheadMs;
    local += d / 2; // 응답이 돌아옴
    return s;
  };
  return { localNow, fetchServerMs, advance: (ms: number) => (local += ms) };
}

describe('서버 시각 동기화', () => {
  it('기기 시계가 3분 틀려도 서버 시각을 정확히 추정', async () => {
    const net = fakeNet(180_000, [40, 60, 30, 50, 45]);
    const st = new ServerTime(net.fetchServerMs, net.localNow);
    await st.sync();
    expect(Math.abs(st.getOffset() - 180_000)).toBeLessThan(1);
  });

  it('비대칭 지연이 섞여도 가장 빠른 표본 기준으로 오차가 작다', async () => {
    let local = 0;
    const ahead = -5000;
    // 응답 경로만 느린 표본(오차 유발)을 섞음
    const legs = [
      [20, 20],
      [20, 400],
      [15, 15],
      [300, 20],
      [25, 25],
    ];
    let k = 0;
    const st = new ServerTime(
      async () => {
        const [up, down] = legs[k++]!;
        local += up!;
        const s = local + ahead;
        local += down!;
        return s;
      },
      () => local,
    );
    await st.sync(5);
    expect(Math.abs(st.getOffset() - ahead)).toBeLessThan(15);
    expect(st.lastRtt).toBe(30);
  });

  it('일부 요청 실패해도 동작, 전부 실패하면 이전 값 유지', async () => {
    const net = fakeNet(1000, [50]);
    let fail = false;
    let n = 0;
    const st = new ServerTime(async () => {
      if (fail || n++ % 2 === 0) throw new Error('net');
      return net.fetchServerMs();
    }, net.localNow);
    await st.sync(6);
    expect(st.isReady()).toBe(true);
    const before = st.getOffset();
    fail = true;
    await st.sync(3);
    expect(st.getOffset()).toBe(before);
  });

  it('작은 오차는 천천히(절반씩), 큰 오차는 즉시 반영', async () => {
    let ahead = 0;
    let local = 0;
    const st = new ServerTime(
      async () => {
        local += 10;
        const s = local + ahead;
        local += 10;
        return s;
      },
      () => local,
    );
    await st.sync(3);
    expect(st.getOffset()).toBeCloseTo(0, 5);
    ahead = 200;
    await st.sync(3);
    expect(st.getOffset()).toBeCloseTo(100, 5);
    ahead = 10_000;
    await st.sync(3);
    expect(st.getOffset()).toBeCloseTo(10_000, 5);
  });

  it('동시에 여러 번 sync 해도 요청은 한 번만', async () => {
    let calls = 0;
    const st = new ServerTime(async () => {
      calls++;
      return 0;
    }, () => 0);
    await Promise.all([st.sync(3), st.sync(3), st.sync(3)]);
    expect(calls).toBe(3);
  });
});

describe('경주 시계 (서버 기준)', () => {
  it('출발 전 음수, 출발 후 경과, 일시정지 중 고정, 재개 후 이어짐', () => {
    let serverNow = 10_000;
    const time = { now: () => serverNow };
    let meta = { startAtMs: 15_000, pausedAtMs: null as number | null, pausedMs: 0 };
    const clock = new SyncedRaceClock(() => meta, time);
    expect(clock.elapsedMs()).toBe(-5000);
    serverNow = 20_000;
    expect(clock.elapsedMs()).toBe(5000);
    meta = { ...meta, pausedAtMs: 21_000 };
    serverNow = 30_000;
    expect(clock.isPaused()).toBe(true);
    expect(clock.elapsedMs()).toBe(6000);
    meta = { startAtMs: 15_000, pausedAtMs: null, pausedMs: 9000 }; // 30초에 재개
    expect(clock.elapsedMs()).toBe(6000);
    serverNow = 31_000;
    expect(clock.elapsedMs()).toBe(7000);
  });

  it('두 기기 시계가 달라도 같은 서버 시각이면 같은 경과 시간', async () => {
    const meta = { startAtMs: 1_000_000, pausedAtMs: null, pausedMs: 0 };
    const devA = fakeNet(+90_000, [40]);
    const devB = fakeNet(-30_000, [120]);
    const a = new ServerTime(devA.fetchServerMs, devA.localNow);
    const b = new ServerTime(devB.fetchServerMs, devB.localNow);
    await Promise.all([a.sync(), b.sync()]);
    // 두 기기 모두 "서버 기준 1,010,000ms" 시점으로 맞춘다
    devA.advance(1_010_000 - a.now());
    devB.advance(1_010_000 - b.now());
    const ca = new SyncedRaceClock(() => meta, a);
    const cb = new SyncedRaceClock(() => meta, b);
    expect(Math.abs(ca.elapsedMs() - cb.elapsedMs())).toBeLessThan(1);
    expect(ca.elapsedMs()).toBeCloseTo(10_000, 0);
  });
});
