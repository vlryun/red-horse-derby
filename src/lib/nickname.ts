/**
 * 닉네임 규칙 — supabase/migrations/*_lobby.sql 의 _normalize_nickname 과 반드시 동일.
 * (서버가 최종 판정. 여기서는 입력 중 즉시 안내용)
 */
export const NICKNAME_MAX = 10;
const ALLOWED = /^[가-힣ㄱ-ㅎㅏ-ㅣA-Za-z0-9 _.!?~-]+$/;

export function normalizeNickname(raw: string): string {
  return raw.normalize('NFC').trim().replace(/\s+/g, ' ');
}

/** 문제 없으면 null, 있으면 사용자에게 보여줄 안내 문구 */
export function nicknameProblem(raw: string): string | null {
  const v = normalizeNickname(raw);
  const len = [...v].length;
  if (len === 0) return '닉네임을 입력해 주세요';
  if (len > NICKNAME_MAX) return `${NICKNAME_MAX}자 이내로 입력해 주세요`;
  if (!ALLOWED.test(v)) return '한글·영문·숫자와 _ . ! ? ~ - 만 쓸 수 있어요';
  return null;
}
