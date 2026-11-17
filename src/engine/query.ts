import { TICK_MS, TRACK_LENGTH } from './config';
import type { RaceEvent, RaceResult } from './types';

/**
 * 미리 계산된 RaceResult 를 "경과 시간" 기준으로 조회하는 함수들.
 * 순위/이벤트 판정은 정수 틱 기준 → 모든 기기에서 동일하게 표시.
 * 보간 위치는 화면 렌더링에만 사용.
 */

export function raceDurationMs(r: RaceResult): number {
  return r.totalTicks * TICK_MS;
}

/** 경과 ms → 정수 틱 (0..totalTicks). NaN/음수 방어 */
export function tickAt(r: RaceResult, elapsedMs: number): number {
  if (!(elapsedMs > 0)) return 0;
  return Math.min(r.totalTicks, Math.floor(elapsedMs / TICK_MS));
}

export function positionAtTick(r: RaceResult, tick: number, lane: number): number {
  const n = r.entrants.length;
  const t = Math.max(0, Math.min(r.totalTicks, tick));
  return r.positions[t * n + lane]!;
}

/** 렌더링용 보간 진행률 (0..1.05) — out 배열 재사용으로 GC 최소화 */
export function sampleProgress(r: RaceResult, elapsedMs: number, out: Float64Array): Float64Array {
  const n = r.entrants.length;
  const ms = Math.max(0, Math.min(Number.isFinite(elapsedMs) ? elapsedMs : 0, r.totalTicks * TICK_MS));
  const f = ms / TICK_MS;
  const t0 = Math.min(r.totalTicks, Math.floor(f));
  const t1 = Math.min(r.totalTicks, t0 + 1);
  const a = f - t0;
  for (let i = 0; i < n; i++) {
    const p0 = r.positions[t0 * n + i]!;
    const p1 = r.positions[t1 * n + i]!;
    out[i] = (p0 + (p1 - p0) * a) / TRACK_LENGTH;
  }
  return out;
}

/** 해당 틱의 순위 (레인 인덱스 배열). 완주한 말은 최종 순위 고정, 나머지는 위치순. */
export function rankingAtTick(r: RaceResult, tick: number): number[] {
  const n = r.entrants.length;
  const t = Math.max(0, Math.min(r.totalTicks, tick));
  if (t >= r.totalTicks) return r.standings.map((s) => s.lane);
  const finalRank = new Int32Array(n);
  for (const s of r.standings) finalRank[s.lane] = s.rank;
  const done = (lane: number) => r.finishTick[lane]! !== -1 && r.finishTick[lane]! <= t;
  const lanes = Array.from({ length: n }, (_, i) => i);
  lanes.sort((a, b) => {
    const fa = done(a);
    const fb = done(b);
    if (fa && fb) return finalRank[a]! - finalRank[b]!;
    if (fa) return -1;
    if (fb) return 1;
    const pa = r.positions[t * n + a]!;
    const pb = r.positions[t * n + b]!;
    if (pa !== pb) return pb - pa;
    return a - b;
  });
  return lanes;
}

/** 해당 틱에 진행 중인 이벤트 (레인 → 이벤트) */
export function activeEventsAtTick(r: RaceResult, tick: number): Map<number, RaceEvent> {
  const map = new Map<number, RaceEvent>();
  for (const e of r.events) {
    if (e.tick > tick) break; // 시간순 정렬
    const ft = r.finishTick[e.horse]!;
    const finished = ft !== -1 && ft <= tick;
    if (tick < e.endTick && !finished) map.set(e.horse, e);
  }
  return map;
}

/** (fromTick, toTick] 구간에 새로 시작된 이벤트 */
export function eventsBetween(r: RaceResult, fromTick: number, toTick: number): RaceEvent[] {
  return r.events.filter((e) => e.tick > fromTick && e.tick <= toTick);
}

export function finishedCountAtTick(r: RaceResult, tick: number): number {
  let c = 0;
  for (let i = 0; i < r.finishTick.length; i++) {
    const ft = r.finishTick[i]!;
    if (ft !== -1 && ft <= tick) c++;
  }
  return c;
}
