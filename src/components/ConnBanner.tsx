import type { ConnStatus } from '../lib/useLive';

/** 연결 상태 안내. 정상일 땐 아무것도 표시하지 않음 */
export function ConnBanner({ status }: { status: ConnStatus }) {
  if (status === 'ok') return null;
  return (
    <div className={`conn-banner ${status}`} role="status">
      {status === 'offline' ? '📵 인터넷 연결이 끊겼어요. 연결되면 자동으로 이어져요.' : '🔄 서버와 다시 연결하는 중…'}
    </div>
  );
}
