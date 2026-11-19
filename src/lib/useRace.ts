import { useEffect, useMemo, useRef, useState } from 'react';
import { reloadToLatest } from './appUpdate';
import {
  REVEAL_GRACE_MS,
  isSupportedEngine,
  simulateRaceVersion,
  tacticWindowCount,
  tacticWindows,
  type FinishRecord,
  type RaceResult,
  type TacticOrder,
} from '../engine';
import { getBackend, type Lobby, type RaceInfo, type RaceMeta } from './backend';
import { SyncedRaceClock } from './raceClock';
import { ServerTime } from './serverTime';

/** 앱 전체에서 하나의 서버 시계 */
export const serverTime = new ServerTime(() => getBackend().serverTime());
if (import.meta.env.DEV) (window as unknown as { __serverTime: ServerTime }).__serverTime = serverTime;

/** 서버 시계 동기화 유지: 처음 + 30초마다 + 화면 복귀/네트워크 복구 시 */
export function useServerTimeSync(): boolean {
  const [ready, setReady] = useState(serverTime.isReady());
  useEffect(() => {
    let alive = true;
    const run = () => serverTime.sync().then(() => alive && setReady(serverTime.isReady()));
    void run();
    const id = setInterval(run, 30_000);
    const onVis = () => document.visibilityState === 'visible' && void run();
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('online', run);
    return () => {
      alive = false;
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('online', run);
    };
  }, []);
  return ready;
}

export interface Official {
  hash: string;
  standings: FinishRecord[];
}

export interface RaceSync {
  /** 최신 진행 상태 (대기실 조회에서 옴) */
  meta: RaceMeta | null;
  /** 시드·명단 등 전체 정보 */
  info: RaceInfo | null;
  /** 이 기기에서 계산한 경주 (서버 값 기반, 결정론적) */
  result: RaceResult | null;
  clock: SyncedRaceClock | null;
  /** 서버가 공개한 공식 결과 */
  official: Official | null;
  /** 이 기기의 엔진이 서버 경주와 버전이 다름 → 새로고침 필요 */
  engineMismatch: boolean;
  /** 이 기기 계산 결과가 공식 결과와 다름 (발생하면 공식 결과를 표시) */
  hashMismatch: boolean;
  /** 작전 경주(v4)인가 */
  tacticsOn: boolean;
  /** 서버에서 받은 "마감된 창" 번호들 */
  tacticsClosed: number[];
  /** 세 창의 작전 기록을 모두 받음 (작전 없는 경주는 항상 true) → 결과 공개 가능 */
  tacticsComplete: boolean;
}

/**
 * 서버의 현재 경주를 이 기기에서 재현.
 * 1) 대기실 조회(3초 폴링 + 실시간)로 경주 id·진행 상태를 받음
 * 2) 경주 id 가 바뀌면 시드·명단을 한 번 받아 결정론적 엔진으로 전체 경주를 미리 계산(수 ms)
 * 3) 서버 시계 기준 경과 시간으로 어느 순간이든 같은 장면을 그림
 * 4) 공식 결과가 공개되면 받아서 내 계산과 해시 비교
 */
export function useRaceSync(lobby: Lobby | null): RaceSync {
  const meta = lobby?.race ?? null;
  const [info, setInfo] = useState<RaceInfo | null>(null);
  const metaRef = useRef<RaceMeta | null>(meta);
  metaRef.current = meta;
  const id = meta?.id ?? null;
  const published = meta?.published ?? false;

  // 경주가 바뀌거나 결과가 공개되면 전체 정보 다시 받기 (실패 시 2초마다 재시도)
  useEffect(() => {
    if (!id) {
      setInfo(null);
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const r = await getBackend().race(id);
        if (!alive) return;
        if (r) setInfo(r);
        if (!r || (published && !r.standings)) timer = setTimeout(load, 2000);
      } catch {
        if (alive) timer = setTimeout(load, 2000);
      }
    };
    void load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [id, published]);

  const current = info && info.id === id ? info : null;

  // ── 작전 기록: 창이 마감(+0.3초)될 때마다 서버에서 받아 경주를 다시 계산 ──
  // 작전은 적용 틱(마감 1초 뒤) 이후에만 영향 → 이미 보여준 장면은 그대로
  const tacticsOn = !!current && current.engineVersion >= 4;
  const [tac, setTac] = useState<{ raceId: string; closed: number[]; list: TacticOrder[] } | null>(null);
  const tacRef = useRef(tac);
  tacRef.current = tac;
  useEffect(() => {
    if (!current || current.engineVersion < 4) return;
    const raceId = current.id;
    const windows = tacticWindows(current.raceSeconds, current.engineVersion);
    let alive = true;
    let busy = false;
    const tickFn = async () => {
      const m = metaRef.current;
      if (!m || m.id !== raceId || busy) return;
      const el = (m.pausedAtMs ?? serverTime.now()) - m.startAtMs - m.pausedMs;
      const have = tacRef.current?.raceId === raceId ? tacRef.current.closed : [];
      const ended = m.status === 'finished' || m.status === 'aborted';
      const due = windows.filter((w) => (ended || el >= w.closeMs + REVEAL_GRACE_MS) && !have.includes(w.no));
      if (due.length === 0) return;
      busy = true;
      try {
        const r = await getBackend().raceTactics(raceId);
        if (alive && r.closed.length >= have.length) setTac({ raceId, closed: r.closed, list: r.tactics });
      } catch {
        /* 다음 주기에 다시 */
      } finally {
        busy = false;
      }
    };
    void tickFn();
    const t = setInterval(() => void tickFn(), 400);
    return () => {
      alive = false;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, current?.engineVersion, current?.raceSeconds]);
  const tacNow = tacticsOn && tac && current && tac.raceId === current.id ? tac : null;
  const tacticsClosed = tacNow?.closed ?? [];
  const tacticsKey = tacNow ? JSON.stringify(tacNow.list) : '';
  const tacticsComplete = !tacticsOn || tacticsClosed.length >= tacticWindowCount(current?.engineVersion ?? 0);
  // 이 앱이 가진 엔진(현재 + 이전 버전 보관본)으로 계산할 수 없는 경주일 때만 "업데이트 필요"
  const engineMismatch = !!current && !isSupportedEngine(current.engineVersion);

  const result = useMemo(() => {
    if (!current || engineMismatch) return null;
    try {
      // 경주를 시작할 때 기록된 엔진 버전으로 계산 → 배포 직후 예전 화면에서 시작된 경주도 모든 기기에서 동일
      return simulateRaceVersion(current.engineVersion, {
        seed: current.seed,
        entrants: current.entrants,
        raceSeconds: current.raceSeconds,
        tactics: tacNow ? tacNow.list : undefined,
      });
    } catch (e) {
      console.error('[race] 시뮬레이션 실패', e);
      return null;
    }
    // 시드·명단·시간이 같으면 다시 계산할 필요 없음
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, current?.seed, current?.raceSeconds, current?.engineVersion, engineMismatch, tacticsKey]);

  const clock = useMemo(
    () => (current ? new SyncedRaceClock(() => metaRef.current ?? current, serverTime) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [current?.id],
  );

  // 공식 결과는 해시가 바뀔 때만 새 객체 (3초마다 새로 만들면 이걸 기다리는 타이머가 계속 초기화됨)
  const officialHash = current?.standings && current.resultHash ? current.resultHash : null;
  const official = useMemo(
    () => (officialHash && current?.standings ? { hash: officialHash, standings: current.standings } : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [current?.id, officialHash],
  );
  // 작전 경주는 작전 기록을 다 받은 뒤에만 비교 (받기 전 잠깐의 계산 차이를 "불일치"로 보지 않음)
  const hashMismatch = !!official && !!result && tacticsComplete && official.hash !== result.hash;
  if (hashMismatch) console.warn('[race] 이 기기 계산과 공식 결과가 다름 → 공식 결과 표시', result?.hash, official?.hash);

  return { meta, info: current, result, clock, official, engineMismatch, hashMismatch, tacticsOn, tacticsClosed, tacticsComplete };
}

/**
 * 이 화면이 모르는 (더 새로운) 엔진 버전의 경주면: 안내 화면 없이 최신 버전으로 바꿈.
 * 캐시 우회 주소로 바로 이동하고, 그래도 안 되면 10초마다 다시 시도.
 */
export function useAutoReloadOnEngineMismatch(sync: RaceSync) {
  useEffect(() => {
    if (!sync.engineMismatch) return;
    reloadToLatest();
    const id = setInterval(reloadToLatest, 10_000);
    return () => clearInterval(id);
  }, [sync.engineMismatch]);
}

/** 화면 꺼짐 방지 (지원 브라우저만, 실패해도 무시) */
export function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) return;
    let lock: { release(): Promise<void> } | null = null;
    let alive = true;
    const req = async () => {
      try {
        const l = await (navigator as unknown as { wakeLock: { request(t: string): Promise<{ release(): Promise<void> }> } }).wakeLock.request('screen');
        if (alive) lock = l;
        else void l.release();
      } catch {
        /* 저전력 모드 등 */
      }
    };
    void req();
    const onVis = () => document.visibilityState === 'visible' && void req();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', onVis);
      void lock?.release().catch(() => {});
    };
  }, [active]);
}
