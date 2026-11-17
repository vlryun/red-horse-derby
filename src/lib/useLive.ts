import { useCallback, useEffect, useRef, useState } from 'react';
import { getBackend, type Lobby, type LiveStatus, type PublicParticipant, type Table } from './backend';

export type ConnStatus = 'ok' | 'reconnecting' | 'offline';

interface Options {
  /** 실시간 구독할 테이블 (빈 배열 = 폴링만) */
  tables: Table[];
  /** 실시간이 살아있을 때 안전망 폴링 주기 */
  slowMs: number;
  /** 실시간이 죽었거나 미사용일 때 폴링 주기 */
  fastMs: number;
}

/**
 * "실시간 + 폴링 안전망" 데이터 훅.
 *  - 실시간 알림이 오면 0.25초 모아서 한 번 전체 재조회 (50명 동시 참가 시 요청 폭주 방지)
 *  - 실시간이 끊겨도 폴링으로 계속 갱신 → 화면이 멈추지 않음
 *  - 화면이 꺼졌다 켜지거나 네트워크가 돌아오면 즉시 재조회
 *  - 요청이 겹치지 않도록 한 번에 하나만 진행
 *  - 실패해도 마지막 성공 데이터는 계속 보여줌
 */
export function useLive<T>(fetcher: () => Promise<T>, { tables, slowMs, fastMs }: Options) {
  const [data, setData] = useState<T | null>(null);
  const [status, setStatus] = useState<ConnStatus>('ok');
  const live = useRef<LiveStatus>(tables.length ? 'connecting' : 'down');
  const inFlight = useRef(false);
  const queued = useRef(false);
  const fails = useRef(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const tablesKey = tables.join(',');

  const refresh = useCallback(async () => {
    if (inFlight.current) {
      queued.current = true;
      return;
    }
    inFlight.current = true;
    try {
      const v = await fetcherRef.current();
      setData(v);
      fails.current = 0;
      setStatus('ok');
    } catch {
      fails.current++;
      setStatus(navigator.onLine === false ? 'offline' : 'reconnecting');
    } finally {
      inFlight.current = false;
      if (queued.current) {
        queued.current = false;
        void refresh();
      }
    }
  }, []);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let debounce: ReturnType<typeof setTimeout> | undefined;

    const loop = async () => {
      if (!alive) return;
      if (document.visibilityState === 'visible') await refresh();
      const base = live.current === 'live' ? slowMs : fastMs;
      // 실패가 이어지면 간격을 조금씩 늘림(최대 3배) + 지터
      const backoff = Math.min(3, 1 + fails.current * 0.5);
      timer = setTimeout(loop, base * backoff * (0.85 + Math.random() * 0.3));
    };

    const kick = () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => void refresh(), 250);
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    const onOffline = () => setStatus('offline');

    const unsub = tables.length
      ? getBackend().subscribe(tables, kick, (s) => {
          live.current = s;
        })
      : () => {};

    void loop();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', kick);
    window.addEventListener('offline', onOffline);
    window.addEventListener('focus', kick);
    return () => {
      alive = false;
      clearTimeout(timer);
      clearTimeout(debounce);
      unsub();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', kick);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('focus', kick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh, tablesKey, slowMs, fastMs]);

  return { data, status, refresh };
}

/**
 * 대기실 요약 (단계, 인원, 정원, 경주시간).
 * 휴대폰 50대가 participants 변경을 각각 실시간 구독하면 참가 1건마다 메시지 50개가
 * 퍼져서 Supabase 무료 플랜 초당 메시지 한도에 걸릴 수 있다.
 * → 휴대폰은 게임 상태(game_state, 드물게 바뀜)만 구독하고 인원수는 3초 폴링.
 */
export function useLobby() {
  return useLive<Lobby>(() => getBackend().lobby(), { tables: ['game_state'], slowMs: 3000, fastMs: 3000 });
}

/** 참가자 전체 목록 — 대형 스크린/관리자 화면 전용 (구독자 1~2개) */
export function useParticipants() {
  return useLive<PublicParticipant[]>(() => getBackend().participants(), {
    tables: ['participants'],
    slowMs: 10_000,
    fastMs: 2_500,
  });
}
