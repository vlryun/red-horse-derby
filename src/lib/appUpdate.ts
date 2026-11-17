import { useEffect } from 'react';

/**
 * 자동 업데이트: "새로고침해 주세요" 화면 없이 항상 최신 버전으로.
 *  - 1분마다(그리고 화면이 다시 보일 때) /version.json 을 캐시 없이 확인
 *  - 새 빌드가 있으면 알아서 새로고침 (캐시 우회 주소로). 경주 재생 중에는 끝날 때까지 미룸
 *  - 개발 서버처럼 version.json 이 없으면 아무것도 안 함
 */

interface VersionInfo {
  build: string;
  engine: number;
}

let blockers = 0;
let pending = false;

export async function fetchLatestVersion(): Promise<VersionInfo | null> {
  try {
    const res = await fetch(`/version.json?ts=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const v = (await res.json()) as Partial<VersionInfo>;
    return typeof v.build === 'string' && typeof v.engine === 'number' ? (v as VersionInfo) : null;
  } catch {
    return null;
  }
}

export function isOutdated(v: VersionInfo | null): boolean {
  return !!v && v.build !== __BUILD_ID__;
}

/** 캐시를 우회해 최신 화면 받기 (같은 주소 + 무시되는 파라미터). 10초 안에 반복하지 않음 */
export function reloadToLatest(): void {
  try {
    const last = Number(sessionStorage.getItem('rhd.update-reload') ?? 0);
    if (Date.now() - last < 10_000) return;
    sessionStorage.setItem('rhd.update-reload', String(Date.now()));
  } catch {
    /* 저장 불가여도 진행 */
  }
  const u = new URL(location.href);
  u.searchParams.set('_v', Date.now().toString(36));
  location.replace(u.toString());
}

/** 경주 재생 중에는 자동 새로고침을 미룸 (끝나면 바로 반영) */
export function useBlockAutoUpdate(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    blockers++;
    return () => {
      blockers--;
      if (blockers === 0 && pending) reloadToLatest();
    };
  }, [active]);
}

export function useAutoUpdate(): void {
  useEffect(() => {
    // 주소에 남은 _v 파라미터 정리 (보기 깔끔하게)
    try {
      const u = new URL(location.href);
      if (u.searchParams.has('_v')) {
        u.searchParams.delete('_v');
        history.replaceState(history.state, '', u.toString());
      }
    } catch {
      /* ignore */
    }
    let alive = true;
    const check = async () => {
      const v = await fetchLatestVersion();
      if (!alive || !isOutdated(v)) return;
      if (blockers > 0) pending = true;
      else reloadToLatest();
    };
    const id = setInterval(check, 60_000);
    const onVisible = () => document.visibilityState === 'visible' && void check();
    document.addEventListener('visibilitychange', onVisible);
    void check();
    return () => {
      alive = false;
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
}
