import { BackendError } from './types';

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 네트워크 오류만 재시도 (지수 백오프 + 랜덤 지터).
 * 지터가 없으면 50대가 동시에 실패→동시에 재시도해서 서버를 또 때린다.
 * 업무 오류(FULL, 마감 등)는 재시도하지 않는다.
 * 모든 RPC 는 서버에서 멱등하게 설계되어 있어 재시도가 안전하다.
 */
export async function withRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const retryable = e instanceof BackendError ? e.code === 'NETWORK' : true;
      if (!retryable || attempt === retries) break;
      await sleep(400 * 2 ** attempt + Math.random() * 600);
    }
  }
  throw lastErr instanceof BackendError ? lastErr : new BackendError('NETWORK', String(lastErr));
}
