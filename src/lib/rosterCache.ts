import type { Entrant } from '../engine';

/**
 * 비상 대비: 대형 화면 PC 에 마지막으로 본 참가자 명단을 저장 (localStorage, 이 PC·이 주소에서만).
 *
 * 언제 저장되나 (src/pages/Screen.tsx)
 *  - 대기실 화면: 참가자 목록을 받을 때마다 (참가·취소 즉시 반영)
 *  - 경주 화면: 경주 정보를 받을 때 그 경주의 출전 명단으로
 * 비상 모드(/demo?cached=1)는 "경주 시작" 버튼을 누르는 순간의 최신 저장본을 읽어 **새 경주**를 연다.
 * (서버 경주를 이어가지 않음 — 서버 경주 도중 끊기면 /screen 자체가 이미 받은 경주를 끝까지 재생한다)
 */
const KEY = 'rhd.roster.v1';

export type RosterSource = { kind: 'lobby' } | { kind: 'race'; roundNo: number };

export interface CachedRoster {
  savedAt: number;
  raceSeconds: number;
  entrants: Entrant[];
  source?: RosterSource;
}

export function saveRoster(entrants: Entrant[], raceSeconds: number, source: RosterSource): void {
  if (entrants.length === 0) return; // 빈 명단으로 덮어쓰지 않음 (초기화 직후 등)
  try {
    localStorage.setItem(KEY, JSON.stringify({ savedAt: Date.now(), raceSeconds, entrants, source } satisfies CachedRoster));
  } catch {
    /* 저장 실패는 무시 */
  }
}

export function loadRoster(): CachedRoster | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as CachedRoster;
    if (!Array.isArray(v.entrants) || v.entrants.length === 0) return null;
    const entrants = v.entrants
      .filter((e) => Number.isInteger(e?.id) && typeof e?.name === 'string')
      .slice(0, 50);
    return entrants.length ? { ...v, entrants } : null;
  } catch {
    return null;
  }
}

/** 화면 표시용 설명: "12분 전 · 3라운드 경주 명단 · 7명" */
export function describeRoster(r: CachedRoster, now = Date.now()): { text: string; stale: boolean } {
  const minutes = Math.max(0, Math.round((now - r.savedAt) / 60000));
  const ago = minutes < 1 ? '방금' : minutes < 60 ? `${minutes}분 전` : `${Math.floor(minutes / 60)}시간 ${minutes % 60}분 전`;
  const src = r.source?.kind === 'race' ? `${r.source.roundNo}라운드 경주 출전 명단` : r.source?.kind === 'lobby' ? '대기실 참가자 명단' : '저장된 명단';
  return {
    text: `${src} · ${r.entrants.length}명 · ${new Date(r.savedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })} 저장 (${ago})`,
    stale: now - r.savedAt > 3 * 60 * 60 * 1000, // 3시간 넘으면 지난 행사/리허설 명단일 가능성
  };
}
