/**
 * Supabase 실서버에만 있는 제약을 정적으로 검사 (PGlite 에는 없어서 일반 테스트로는 못 잡음)
 *  - pg_safeupdate: 함수 안이라도 WHERE 없는 DELETE/UPDATE 는 "DELETE requires a WHERE clause" 로 실패
 *    → 2026-11-12 실서버 리허설에서 "전체 초기화"가 이 문제로 실패한 것을 계기로 추가
 */
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from './db';

/** 주석 제거 후 세미콜론 단위 문장으로 나눔 */
function statements(sql: string): string[] {
  return sql
    .replace(/--[^\n]*/g, '')
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

describe('Supabase 호환성 정적 검사', () => {
  it('모든 DELETE/UPDATE 에 WHERE 가 있다 (pg_safeupdate)', () => {
    const offenders = statements(MIGRATIONS).filter((s) => {
      // 문장 안의 마지막 delete/update 부분만 본다 (plpgsql 블록 안 포함)
      const m = /\b(delete from|update) [\w.]+\b(.*)$/i.exec(s);
      if (!m) return false;
      // "update 테이블 [별칭] set" 만 검사 ("on conflict … do update set" 은 제외)
      if (/^update/i.test(m[0]) && !/^update [\w.]+( \w+)? set\b/i.test(m[0])) return false;
      return !/\bwhere\b/i.test(m[2] ?? '');
    });
    expect(offenders).toEqual([]);
  });

  it('검사기 자체 확인: WHERE 없는 문장을 잡아낸다', () => {
    const bad = statements('begin delete from public.x; update public.y set a = 1; end');
    const caught = bad.filter((s) => /\b(delete from|update) [\w.]+/i.test(s) && !/\bwhere\b/i.test(s));
    expect(caught.length).toBe(2);
  });
});
