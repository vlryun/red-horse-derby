import type { MyEntry } from './backend/types';

/**
 * 기기 식별 토큰 (비밀값). 서버엔 해시만 저장된다.
 * localStorage → sessionStorage → 메모리 순으로 저장 시도.
 * 저장소가 막힌 브라우저에서도 동작은 하되, 새로고침 시 복구코드가 필요할 수 있다.
 */
const TOKEN_KEY = 'rhd.token.v1';
const ME_KEY = 'rhd.me.v1';
const TOKEN_RE = /^[0-9a-f]{64}$/;

let memoryToken: string | null = null;
let memoryMe: string | null = null;

function read(key: string): string | null {
  for (const s of [safeStorage('local'), safeStorage('session')]) {
    try {
      const v = s?.getItem(key);
      if (v) return v;
    } catch {
      /* 차단된 저장소 */
    }
  }
  return null;
}

function write(key: string, value: string | null): boolean {
  let ok = false;
  for (const s of [safeStorage('local'), safeStorage('session')]) {
    try {
      if (!s) continue;
      if (value === null) s.removeItem(key);
      else s.setItem(key, value);
      ok = true;
    } catch {
      /* 용량 초과/차단 */
    }
  }
  return ok;
}

function safeStorage(kind: 'local' | 'session'): Storage | null {
  try {
    return kind === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

function randomToken(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** 저장소가 정상인지 (아니면 화면에 복구코드 안내를 강조) */
export let storagePersistent = true;

export function getToken(): string {
  const stored = read(TOKEN_KEY) ?? memoryToken;
  if (stored && TOKEN_RE.test(stored)) return stored;
  const t = randomToken();
  memoryToken = t;
  storagePersistent = write(TOKEN_KEY, t);
  return t;
}

/** 마지막으로 확인된 내 참가 정보 (오프라인일 때도 화면을 그리기 위한 캐시) */
export function loadCachedMe(): MyEntry | null {
  const raw = read(ME_KEY) ?? memoryMe;
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as MyEntry;
    return typeof v?.horseNo === 'number' && typeof v.nickname === 'string' ? v : null;
  } catch {
    return null;
  }
}

export function saveCachedMe(me: MyEntry | null): void {
  const raw = me ? JSON.stringify(me) : null;
  memoryMe = raw;
  write(ME_KEY, raw);
}
