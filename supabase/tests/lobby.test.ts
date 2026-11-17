/**
 * 실제 PostgreSQL 엔진(PGlite, WASM)에서 마이그레이션 SQL 을 실행해 서버 규칙을 검증한다.
 * Supabase 프로젝트 없이도 `npm test` 로 실행된다.
 * (동시성 잠금은 단일 연결이라 여기서 검증 불가 → 7단계 부하 테스트에서 실제 Supabase 로 검증)
 */
import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { simulateRace } from '../../src/engine';
import { nicknameProblem, normalizeNickname } from '../../src/lib/nickname';
import { MIGRATIONS, freshDb } from './db';


let db: PGlite;

interface Me {
  id: string;
  horse_no: number;
  nickname: string;
  recovery_code: string;
  renamed: boolean;
}

let tokenSeq = 0;
const newToken = () => (++tokenSeq).toString(16).padStart(64, '0');

async function rpc<T>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await db.query<{ v: T }>(`select ${sql} as v`, params);
  return r.rows[0]!.v;
}
const join_ = (token: string, nick: string) => rpc<Me>('public.join_game($1, $2)', [token, nick]);
const me = (token: string) => rpc<Me | null>('public.get_me($1)', [token]);
const lobby = () => rpc<{ phase: string; count: number; max_players: number }>('public.get_lobby()');
const setPhase = (p: string) => db.query(`update public.game_state set phase = $1 where id = 1`, [p]);

async function expectError(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toThrow(code);
}

beforeAll(async () => {
  db = await freshDb();
});

beforeEach(async () => {
  await db.exec(`truncate public.participants cascade; update public.game_state set phase = 'lobby', max_players = 20;`);
});

describe('마이그레이션', () => {
  it('여러 번 실행해도 안전 (멱등)', async () => {
    await db.exec(MIGRATIONS);
    await db.exec(MIGRATIONS);
    expect((await lobby()).phase).toBe('lobby');
  });
});

describe('참가 신청', () => {
  it('번호·닉네임·복구코드 발급', async () => {
    const r = await join_(newToken(), '번개');
    expect(r.horse_no).toBe(1);
    expect(r.nickname).toBe('번개');
    expect(r.recovery_code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    expect(r.renamed).toBe(false);
    expect((await lobby()).count).toBe(1);
  });

  it('같은 토큰으로 다시 호출 → 같은 참가자 (새로고침·연타·재시도 안전)', async () => {
    const t = newToken();
    const a = await join_(t, '번개');
    const b = await join_(t, '다른이름');
    const c = await join_(t, '또다른');
    expect(b.id).toBe(a.id);
    expect(c.nickname).toBe('번개');
    expect((await lobby()).count).toBe(1);
  });

  it('중복 닉네임 → 번호 붙여서 등록 (대소문자·공백 무시)', async () => {
    await join_(newToken(), 'Min Su');
    const b = await join_(newToken(), 'minsu');
    const c = await join_(newToken(), 'MINSU');
    expect(b.nickname).toBe('minsu2');
    expect(b.renamed).toBe(true);
    expect(c.nickname).toBe('MINSU3');
  });

  it('10자 닉네임 중복 시에도 12자 이내 + 경주 엔진이 받아들임', async () => {
    const base = '가나다라마바사아자차';
    const names: string[] = [];
    for (let i = 0; i < 12; i++) names.push((await join_(newToken(), base)).nickname);
    expect(names[1]).toBe(base + '2');
    expect(names[11]).toBe(base + '12');
    const { rows } = await db.query<{ horse_no: number; nickname: string }>(
      'select horse_no, nickname from public.participants order by horse_no',
    );
    // 서버가 만든 닉네임을 경주 엔진 입력 검증이 거부하지 않는지 교차 확인
    expect(() => simulateRace({ seed: 1, entrants: rows.map((r) => ({ id: r.horse_no, name: r.nickname })) })).not.toThrow();
  });

  it('닉네임 정규화: 앞뒤 공백 제거, 연속 공백 1칸', async () => {
    expect((await join_(newToken(), '   붉은   말  ')).nickname).toBe('붉은 말');
    expect((await join_(newToken(), 'a\n\tb')).nickname).toBe('a b'); // 줄바꿈·탭도 공백 1칸
  });

  it.each([
    ['빈 문자열', ''],
    ['공백만', '     '],
    ['11자', '가나다라마바사아자차카'],
    ['HTML', '<b>hi</b>'],
    ['이모지', '말🐎'],
    ['따옴표', "a'b"],
    ['제어문자', 'a\u0000b'.replace('\u0000', '\u0007')],
  ])('잘못된 닉네임 거부: %s', async (_, nick) => {
    await expectError(join_(newToken(), nick), 'INVALID_NICKNAME');
  });

  it('null 닉네임 거부', async () => {
    await expectError(rpc('public.join_game($1, null)', [newToken()]), 'INVALID_NICKNAME');
  });

  it.each([
    ['짧음', 'abc'],
    ['대문자', 'A'.repeat(64)],
    ['hex 아님', 'z'.repeat(64)],
    ['너무 김', '0'.repeat(65)],
  ])('잘못된 토큰 거부: %s', async (_, token) => {
    await expectError(join_(token, '번개'), 'INVALID_TOKEN');
  });

  it('20명 정원 → 21번째 FULL, 기존 참가자는 계속 조회 가능', async () => {
    const first = newToken();
    await join_(first, 'p0');
    for (let i = 1; i < 20; i++) await join_(newToken(), `p${i}`);
    expect((await lobby()).count).toBe(20);
    await expectError(join_(newToken(), 'late'), 'FULL');
    expect((await join_(first, 'x')).nickname).toBe('p0');
    const { rows } = await db.query<{ n: number }>('select count(distinct horse_no)::int as n from public.participants');
    expect(rows[0]!.n).toBe(20);
  });

  it('관리자가 정원을 줄이면 그 수에서 마감', async () => {
    await db.query('update public.game_state set max_players = 3');
    for (let i = 0; i < 3; i++) await join_(newToken(), `p${i}`);
    await expectError(join_(newToken(), 'p3'), 'FULL');
  });

  it('참가 마감 후 신규 참가 불가, 기존 참가자는 정상', async () => {
    const t = newToken();
    await join_(t, '번개');
    for (const phase of ['closed', 'countdown', 'racing', 'paused', 'finished']) {
      await setPhase(phase);
      await expectError(join_(newToken(), '늦음'), 'REGISTRATION_CLOSED');
      expect((await join_(t, '번개')).horse_no).toBe(1);
      expect((await me(t))?.nickname).toBe('번개');
    }
  });

  it('취소한 번호는 다음 참가자에게 재배정 (가장 작은 빈 번호)', async () => {
    const a = newToken();
    await join_(a, 'a');
    await join_(newToken(), 'b');
    await rpc('public.leave_game($1)', [a]);
    expect(await me(a)).toBeNull();
    expect((await join_(newToken(), 'c')).horse_no).toBe(1);
  });

  it('마감 후에는 참가 취소 불가', async () => {
    const t = newToken();
    await join_(t, 'a');
    await setPhase('closed');
    await expectError(rpc('public.leave_game($1)', [t]), 'REGISTRATION_CLOSED');
  });

  it('입력 퍼징: 어떤 문자열이 와도 정해진 오류 코드 외의 오류 없음', async () => {
    const samples = ['%', '\\', "'; drop table participants; --", 'ㅋ'.repeat(10), ' a ', '\t', '가​나', 'Ａ', '١٢٣'];
    for (const s of samples) {
      try {
        await join_(newToken(), s);
      } catch (e) {
        expect(String(e)).toMatch(/INVALID_NICKNAME/);
      }
    }
    const { rows } = await db.query('select 1 from public.participants');
    expect(rows.length).toBeGreaterThan(0); // 테이블 멀쩡
  });
});

describe('클라이언트·서버 닉네임 규칙 일치', () => {
  it('같은 입력에 대해 휴대폰 사전검사와 서버 판정이 항상 같다', async () => {
    const inputs = [
      '번개', '  번개  ', 'a  b', 'a\tb', 'ABC_def-1.!?~', '가나다라마바사아자차', '가나다라마바사아자차카',
      '', '   ', '말🐎', '<b>', "a'b", 'ㅋㅋㅋ', 'ㅏㅑ', 'é', 'Ａ', '١٢٣', '가​나', 'a,b', 'a@b', '#1', '한 글 이 름',
      '가', // 조합형(NFD) 가 → NFC 로 정규화되면 허용
    ];
    for (const s of inputs) {
      const clientOk = nicknameProblem(s) === null;
      let serverNick: string | null = null;
      try {
        serverNick = await rpc<string>('public._normalize_nickname($1)', [s]);
      } catch {
        serverNick = null;
      }
      expect({ s, ok: clientOk }).toEqual({ s, ok: serverNick !== null });
      if (serverNick !== null) expect(normalizeNickname(s)).toBe(serverNick);
    }
  });
});

describe('복구 코드 (다른 브라우저로 이동)', () => {
  it('번호 + 코드로 새 기기에 연결, 이전 기기는 연결 해제', async () => {
    const old = newToken();
    const r = await join_(old, '번개');
    const fresh = newToken();
    const rec = await rpc<Me>('public.recover_participant($1, $2, $3)', [r.horse_no, r.recovery_code.toLowerCase(), fresh]);
    expect(rec.id).toBe(r.id);
    expect(await me(old)).toBeNull();
    expect((await me(fresh))?.id).toBe(r.id);
  });

  it('5번 틀리면 잠김 (맞는 코드도 거부)', async () => {
    const r = await join_(newToken(), '번개');
    for (let i = 0; i < 5; i++) {
      const res = await rpc<{ error: string }>('public.recover_participant($1, $2, $3)', [r.horse_no, 'WRONG1', newToken()]);
      expect(res.error).toBe('RECOVERY_FAILED');
    }
    const locked = await rpc<{ error: string }>('public.recover_participant($1, $2, $3)', [
      r.horse_no,
      r.recovery_code,
      newToken(),
    ]);
    expect(locked.error).toBe('RECOVERY_LOCKED');
  });

  it('이미 다른 말로 참가한 기기는 복구 불가', async () => {
    const r = await join_(newToken(), 'a');
    const mine = newToken();
    await join_(mine, 'b');
    const res = await rpc<{ error: string }>('public.recover_participant($1, $2, $3)', [r.horse_no, r.recovery_code, mine]);
    expect(res.error).toBe('ALREADY_JOINED');
  });

  it('없는 번호/이상한 입력 → RECOVERY_FAILED', async () => {
    for (const [no, code] of [
      [7, 'ABCDEF'],
      [0, 'ABCDEF'],
      [99, 'ABCDEF'],
      [1, 'x'.repeat(100)],
    ] as const) {
      const res = await rpc<{ error: string }>('public.recover_participant($1, $2, $3)', [no, code, newToken()]);
      expect(res.error).toBe('RECOVERY_FAILED');
    }
  });
});

describe('권한 (anon = 일반 접속자)', () => {
  async function asAnon<T>(fn: () => Promise<T>): Promise<T> {
    await db.exec('set role anon');
    try {
      return await fn();
    } finally {
      await db.exec('reset role');
    }
  }

  it('공개 정보 조회와 공개 RPC 는 가능', async () => {
    await join_(newToken(), '번개');
    await asAnon(async () => {
      const { rows } = await db.query('select horse_no, nickname from public.participants');
      expect(rows.length).toBe(1);
      expect((await lobby()).count).toBe(1);
      expect((await join_(newToken(), '질풍')).horse_no).toBe(2);
    });
  });

  it.each([
    ['비밀 테이블 조회', 'select * from public.participant_secrets'],
    ['참가자 직접 추가', `insert into public.participants (horse_no, nickname, nickname_key) values (9, 'x', 'x')`],
    ['참가자 직접 수정', `update public.participants set nickname = 'hack'`],
    ['참가자 직접 삭제', `delete from public.participants`],
    ['게임 상태 변경', `update public.game_state set phase = 'racing'`],
    ['내부 함수 호출', `select public._new_recovery_code()`],
  ])('차단: %s', async (_, sql) => {
    await join_(newToken(), '번개');
    await asAnon(async () => {
      await expect(db.query(sql)).rejects.toThrow(/permission denied/);
    });
    expect((await lobby()).phase).toBe('lobby');
  });
});
