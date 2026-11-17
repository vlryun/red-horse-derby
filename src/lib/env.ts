/**
 * 환경 설정. .env.local (개발) / Vercel 환경변수 (배포)
 *  VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY 가 없으면 앱 대신 "서버 설정 없음" 화면.
 */
const url = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim() || '';
const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim() || '';

export const env = {
  supabaseUrl: url,
  supabaseAnonKey: anonKey,
  misconfigured: !(url && anonKey),
  /** QR 코드에 넣을 공개 주소. 비우면 현재 접속 주소 사용 */
  publicUrl: ((import.meta.env.VITE_PUBLIC_URL as string | undefined)?.trim() || '').replace(/\/+$/, ''),
};

export function joinUrl(): string {
  const base = env.publicUrl || window.location.origin;
  return `${base}/play`;
}

export function isLocalhost(): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
}
