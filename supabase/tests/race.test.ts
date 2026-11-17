/**
 * 3단계 서버 규칙: 관리자 인증 · 경주 시작/일시정지/재개 · 결과 공개 검증 · 결과 일치 보고
 * 실제 PostgreSQL(PGlite)에서 마이그레이션 SQL 을 그대로 실행해 검증.
 */
import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ENGINE_VERSION, simulateRace } from '../../src/engine';
import { freshDb, makeRpc, newToken } from './db';

let db: PGlite;
let rpc: ReturnType<typeof makeRpc>;
let admin: string;
const PW = 'test-password-123';

interface RaceFull {
  id: string;
  seed: number;
  entrants: { id: number; name: string }[];
  race_seconds: number;
  engine_version: number;
  status: string;
  start_at_ms: number;
  paused_at_ms: number | null;
  paused_ms: number;
  result_hash: string | null;
  standings: unknown;
  server_ms: number;
}

const join = (t: string, n: string) => rpc('public.join_game($1, $2)', [t, n]);
const start = (cd = 3000) => rpc<RaceFull>('public.admin_start_race($1, $2, $3)', [admin, ENGINE_VERSION, cd]);
const getRace = (id: string) => rpc<RaceFull>('public.get_race($1)', [id]);
const lobby = () => rpc<{ phase: string; race: { id: string; status: string } | null; server_ms: number }>('public.get_lobby()');
/** 테스트용: 경주를 과거로 옮겨 "충분히 달린" 상태로 만든다 */
const fastForward = (sec: number) =>
  db.query(`update public.races set start_at = start_at - make_interval(secs => $1)`, [sec]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function computeLocally(r: RaceFull) {
  return simulateRace({ seed: r.seed, entrants: r.entrants, raceSeconds: r.race_seconds });
}

beforeAll(async () => {
  db = await freshDb();
  rpc = makeRpc(db);
});

beforeEach(async () => {
  await db.exec(`
    update public.game_state set phase = 'lobby', current_race_id = null, round_no = 1, max_players = 20, race_seconds = 70;
    delete from public.races; delete from public.participants; delete from public.admin_sessions; delete from public.admin_config;`);
  admin = (await rpc<{ token: string }>('public.admin_bootstrap($1)', [PW])).token;
});

describe('관리자 인증', () => {
  it('최초 설정은 한 번만', async () => {
    expect((await rpc<{ configured: boolean }>('public.admin_status()')).configured).toBe(true);
    await expect(rpc('public.admin_bootstrap($1)', ['another-password'])).rejects.toThrow('ALREADY_CONFIGURED');
  });

  it('짧은 비밀번호 거부', async () => {
    await db.exec('delete from public.admin_config');
    await expect(rpc('public.admin_bootstrap($1)', ['short'])).rejects.toThrow('WEAK_PASSWORD');
  });

  it('로그인 성공 → 토큰, 틀리면 오류, 5회 틀리면 60초 잠금(맞는 비번도 거부)', async () => {
    const ok = await rpc<{ token: string }>('public.admin_login($1)', [PW]);
    expect(ok.token).toMatch(/^[0-9a-f]{64}$/);
    for (let i = 0; i < 4; i++) {
      expect((await rpc<{ error: string }>('public.admin_login($1)', ['wrong'])).error).toBe('ADMIN_BAD_PASSWORD');
    }
    expect((await rpc<{ error: string }>('public.admin_login($1)', ['wrong'])).error).toBe('ADMIN_BAD_PASSWORD');
    const locked = await rpc<{ error: string; retry_ms: number }>('public.admin_login($1)', [PW]);
    expect(locked.error).toBe('ADMIN_LOCKED');
    expect(locked.retry_ms).toBeGreaterThan(50_000);
  });

  it('토큰 없거나 틀리거나 만료되면 모든 관리자 기능 거부', async () => {
    const bad = [null, 'abc', newToken()];
    for (const t of bad) {
      await expect(rpc('public.admin_set_phase($1, $2)', [t, 'closed'])).rejects.toThrow('ADMIN_AUTH');
      await expect(rpc('public.admin_start_race($1, $2, $3)', [t, ENGINE_VERSION, 3000])).rejects.toThrow('ADMIN_AUTH');
      await expect(rpc('public.admin_reset_all($1)', [t])).rejects.toThrow('ADMIN_AUTH');
    }
    await db.exec(`update public.admin_sessions set expires_at = now() - interval '1 second'`);
    await expect(rpc('public.admin_add_bots($1, $2)', [admin, 1])).rejects.toThrow('ADMIN_AUTH');
  });

  it('로그아웃하면 그 토큰은 끝', async () => {
    await rpc('public.admin_logout($1)', [admin]);
    await expect(rpc('public.admin_set_phase($1, $2)', [admin, 'closed'])).rejects.toThrow('ADMIN_AUTH');
  });

  it('비밀번호 변경 → 새 비번으로만 로그인, 다른 세션은 종료', async () => {
    const other = (await rpc<{ token: string }>('public.admin_login($1)', [PW])).token;
    await rpc('public.admin_change_password($1, $2)', [admin, 'brand-new-pass']);
    expect((await rpc<{ error?: string }>('public.admin_login($1)', [PW])).error).toBe('ADMIN_BAD_PASSWORD');
    expect((await rpc<{ token?: string }>('public.admin_login($1)', ['brand-new-pass'])).token).toBeTruthy();
    await expect(rpc('public.admin_set_phase($1, $2)', [other, 'closed'])).rejects.toThrow('ADMIN_AUTH');
  });
});

describe('대기실 관리', () => {
  it('접수 마감/재개, 정원·경주시간 설정, 정원은 현재 인원 밑으로 못 내림', async () => {
    await rpc('public.admin_set_phase($1, $2)', [admin, 'closed']);
    expect((await lobby()).phase).toBe('closed');
    await rpc('public.admin_set_phase($1, $2)', [admin, 'lobby']);
    await rpc('public.admin_add_bots($1, $2)', [admin, 5]);
    await expect(rpc('public.admin_update_settings($1, $2, $3)', [admin, 4, null])).rejects.toThrow('BELOW_COUNT');
    await expect(rpc('public.admin_update_settings($1, $2, $3)', [admin, 0, null])).rejects.toThrow('BAD_SETTINGS');
    await expect(rpc('public.admin_update_settings($1, $2, $3)', [admin, null, 29])).rejects.toThrow('BAD_SETTINGS');
    await rpc('public.admin_update_settings($1, $2, $3)', [admin, 5, 45]);
    const { rows } = await db.query<{ max_players: number; race_seconds: number }>('select * from public.game_state');
    expect(rows[0]).toMatchObject({ max_players: 5, race_seconds: 45 });
  });

  it('테스트봇: 정원까지만 추가, 닉네임 겹치지 않음', async () => {
    await join(newToken(), '테스트봇1');
    await rpc('public.admin_update_settings($1, $2, $3)', [admin, 10, null]);
    expect(await rpc<number>('public.admin_add_bots($1, $2)', [admin, 50])).toBe(9);
    const { rows } = await db.query<{ n: number }>('select count(distinct nickname_key)::int n from public.participants');
    expect(rows[0]!.n).toBe(10);
  });

  it('참가자 내보내기', async () => {
    await rpc('public.admin_add_bots($1, $2)', [admin, 3]);
    await rpc('public.admin_remove_participant($1, $2)', [admin, 2]);
    const { rows } = await db.query<{ horse_no: number }>('select horse_no from public.participants order by 1');
    expect(rows.map((r) => r.horse_no)).toEqual([1, 3]);
  });
});

describe('경주 진행', () => {
  it('참가자 0명이면 시작 불가 (최소 1명)', async () => {
    await expect(start()).rejects.toThrow('NO_PARTICIPANTS');
  });

  it('시작: 서버가 시드·명단·출발시각을 정하고, 접수가 막히고, 같은 경주 중복 시작 불가', async () => {
    await rpc('public.admin_add_bots($1, $2)', [admin, 7]);
    const r = await start(5000);
    expect(r.seed).toBeGreaterThanOrEqual(0);
    expect(r.seed).toBeLessThanOrEqual(4294967295);
    expect(r.entrants.map((e) => e.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(r.engine_version).toBe(ENGINE_VERSION);
    // 출발까지 약 5초 (카운트다운)
    expect(r.start_at_ms - r.server_ms).toBeGreaterThan(4800);
    expect(r.start_at_ms - r.server_ms).toBeLessThan(5200);
    expect((await lobby()).phase).toBe('racing');
    await expect(join(newToken(), '지각생')).rejects.toThrow('REGISTRATION_CLOSED');
    await expect(start()).rejects.toThrow('RACE_ACTIVE');
    await expect(rpc('public.admin_add_bots($1, $2)', [admin, 1])).rejects.toThrow('RACE_ACTIVE');
    await expect(rpc('public.admin_set_phase($1, $2)', [admin, 'lobby'])).rejects.toThrow('RACE_ACTIVE');
  });

  it('카운트다운은 3~15초로 제한', async () => {
    await rpc('public.admin_add_bots($1, $2)', [admin, 1]);
    const r = await start(0);
    expect(r.start_at_ms - r.server_ms).toBeGreaterThan(2800);
  });

  it('시작 후 참가 정보가 바뀌어도 출전 명단은 고정', async () => {
    await rpc('public.admin_add_bots($1, $2)', [admin, 3]);
    const r = await start();
    await db.exec(`update public.participants set nickname = '바뀜' where horse_no = 1`);
    expect((await getRace(r.id)).entrants[0]!.name).toBe('테스트봇1');
  });

  it('일시정지 → 경과 시간 멈춤 → 재개 → 멈춘 만큼 정확히 뒤로 밀림', async () => {
    await rpc('public.admin_add_bots($1, $2)', [admin, 3]);
    const r0 = await start(3000);
    await fastForward(10); // 출발 후 약 7초 지점
    const p = await rpc<RaceFull>('public.admin_pause_race($1)', [admin]);
    expect(p.status).toBe('paused');
    expect((await lobby()).phase).toBe('paused');
    const elapsedAtPause = p.paused_at_ms! - p.start_at_ms - p.paused_ms;
    await sleep(300);
    // 멈춘 동안 다시 조회해도 경과 시간 동일
    const p2 = await getRace(r0.id);
    expect(p2.paused_at_ms! - p2.start_at_ms - p2.paused_ms).toBe(elapsedAtPause);
    await expect(rpc('public.admin_pause_race($1)', [admin])).rejects.toThrow('BAD_STATE');

    const r = await rpc<RaceFull>('public.admin_resume_race($1)', [admin]);
    expect(r.status).toBe('racing');
    expect(r.paused_at_ms).toBeNull();
    expect(r.paused_ms).toBeGreaterThanOrEqual(290);
    const elapsedAfterResume = r.server_ms - r.start_at_ms - r.paused_ms;
    expect(elapsedAfterResume - elapsedAtPause).toBeGreaterThanOrEqual(0);
    expect(elapsedAfterResume - elapsedAtPause).toBeLessThan(100); // 재개 직후 = 멈춘 지점에서 이어짐
    await expect(rpc('public.admin_resume_race($1)', [admin])).rejects.toThrow('BAD_STATE');
  });
});

describe('결과 공개 (서버 검증)', () => {
  async function racedOut() {
    await rpc('public.admin_add_bots($1, $2)', [admin, 6]);
    await rpc('public.admin_update_settings($1, $2, $3)', [admin, null, 30]);
    const r = await start();
    await fastForward(60);
    return r;
  }
  const publish = (id: string, hash: string, standings: unknown, ev = ENGINE_VERSION) =>
    rpc<RaceFull>('public.admin_publish_result($1, $2, $3, $4, $5)', [admin, id, ev, hash, JSON.stringify(standings)]);

  it('서버가 준 값으로 계산한 결과를 공개 → 공식 기록, 모두에게 같은 결과', async () => {
    const r = await racedOut();
    const local = computeLocally(r);
    const pub = await publish(r.id, local.hash, local.standings);
    expect(pub.status).toBe('finished');
    expect(pub.result_hash).toBe(local.hash);
    expect((await lobby()).phase).toBe('finished');
    // 다른 기기가 같은 서버 값으로 계산하면 같은 해시
    expect(computeLocally(await getRace(r.id)).hash).toBe(pub.result_hash);
    // 재시도 안전 (같은 해시)
    expect((await publish(r.id, local.hash, local.standings)).status).toBe('finished');
    await expect(publish(r.id, 'deadbeef', local.standings)).rejects.toThrow('BAD_STATE');
  });

  it('경주가 덜 끝났으면 공개 불가', async () => {
    await rpc('public.admin_add_bots($1, $2)', [admin, 2]);
    const r = await start();
    const local = computeLocally(r);
    await expect(publish(r.id, local.hash, local.standings)).rejects.toThrow('RACE_NOT_FINISHED');
  });

  it('일시정지 중엔 공개 불가', async () => {
    const r = await racedOut();
    await rpc('public.admin_pause_race($1)', [admin]);
    const local = computeLocally(r);
    await expect(publish(r.id, local.hash, local.standings)).rejects.toThrow('BAD_STATE');
  });

  it('엔진 버전이 다르면 공개 불가', async () => {
    const r = await racedOut();
    const local = computeLocally(r);
    await expect(publish(r.id, local.hash, local.standings, ENGINE_VERSION + 1)).rejects.toThrow('ENGINE_MISMATCH');
  });

  it.each([
    ['빈 배열', () => []],
    ['한 명 빠짐', (s: { id: number; rank: number }[]) => s.slice(1)],
    ['없는 번호', (s: { id: number; rank: number }[]) => s.map((x, i) => (i === 0 ? { ...x, id: 99 } : x))],
    ['등수 중복', (s: { id: number; rank: number }[]) => s.map((x) => ({ ...x, rank: 1 }))],
    ['객체 아님', () => ({ hacked: true })],
    ['타입 이상', (s: { id: number; rank: number }[]) => s.map((x) => ({ ...x, id: 'abc' }))],
  ])('잘못된 순위표 거부: %s', async (_, mutate) => {
    const r = await racedOut();
    const local = computeLocally(r);
    await expect(publish(r.id, local.hash, mutate(local.standings as never))).rejects.toThrow('INVALID_STANDINGS');
    expect((await getRace(r.id)).status).toBe('racing');
  });

  it('잘못된 해시 형식 거부', async () => {
    const r = await racedOut();
    const local = computeLocally(r);
    await expect(publish(r.id, 'NOT-HEX!', local.standings)).rejects.toThrow('INVALID_STANDINGS');
  });

  it('다음 라운드 → 같은 참가자, 새 경주, 라운드 +1 · 경주 중엔 다음 라운드 불가', async () => {
    const r = await racedOut();
    await expect(rpc('public.admin_next_round($1)', [admin])).rejects.toThrow('RACE_ACTIVE');
    const local = computeLocally(r);
    await publish(r.id, local.hash, local.standings);
    await rpc('public.admin_next_round($1)', [admin]);
    const l = await lobby();
    expect(l.phase).toBe('closed');
    expect(l.race).toBeNull();
    const r2 = await start();
    expect(r2.id).not.toBe(r.id);
    expect(r2.entrants.length).toBe(6);
    const { rows } = await db.query<{ round_no: number }>('select round_no from public.races where id = $1', [r2.id]);
    expect(rows[0]!.round_no).toBe(2);
  });

  it('비상 중단 → 결과 없이 대기실로, 기록은 남음', async () => {
    const r = await racedOut();
    await rpc('public.admin_abort_race($1)', [admin]);
    expect((await lobby()).race).toBeNull();
    expect((await getRace(r.id)).status).toBe('aborted');
  });

  it('전체 초기화 → 참가자 0, 1라운드, 접수 시작, 기록은 보관', async () => {
    const r = await racedOut();
    await rpc('public.admin_reset_all($1)', [admin]);
    const l = await rpc<{ phase: string; count: number; round_no: number; race: unknown }>('public.get_lobby()');
    expect(l).toMatchObject({ phase: 'lobby', count: 0, round_no: 1, race: null });
    expect((await getRace(r.id)).status).toBe('aborted');
    const hist = await rpc<{ id: string }[]>('public.admin_race_history($1)', [admin]);
    expect(hist.map((h) => h.id)).toContain(r.id);
  });
});

describe('결과 일치 보고 (모든 기기가 같은 결과를 봤는지)', () => {
  it('참가자 기기가 해시를 보고 → 관리자가 일치 수 확인', async () => {
    const tokens = [newToken(), newToken(), newToken()];
    for (const [i, t] of tokens.entries()) await join(t, `p${i}`);
    await rpc('public.admin_update_settings($1, $2, $3)', [admin, null, 30]);
    const r = await start();
    await fastForward(60);
    const local = computeLocally(r);
    await rpc('public.admin_publish_result($1, $2, $3, $4, $5)', [admin, r.id, ENGINE_VERSION, local.hash, JSON.stringify(local.standings)]);

    await rpc('public.report_result($1, $2, $3, $4)', [tokens[0], r.id, local.hash, ENGINE_VERSION]);
    await rpc('public.report_result($1, $2, $3, $4)', [tokens[1], r.id, local.hash, ENGINE_VERSION]);
    await rpc('public.report_result($1, $2, $3, $4)', [tokens[2], r.id, 'abcdef12', ENGINE_VERSION]); // 다른 결과
    await rpc('public.report_result($1, $2, $3, $4)', [tokens[0], r.id, local.hash, ENGINE_VERSION]); // 중복 보고
    const rep = await rpc<{ entrants: number; reports: number; matching: number; hashes: Record<string, number> }>(
      'public.admin_race_report($1)',
      [admin],
    );
    expect(rep).toMatchObject({ entrants: 3, reports: 3, matching: 2 });
    expect(rep.hashes).toEqual({ [local.hash]: 2, abcdef12: 1 });
  });

  it('출전하지 않은 사람·이상한 값은 조용히 무시', async () => {
    await rpc('public.admin_add_bots($1, $2)', [admin, 1]);
    const r = await start();
    const outsider = newToken();
    await rpc('public.report_result($1, $2, $3, $4)', [outsider, r.id, 'abcdef12', 1]);
    await rpc('public.report_result($1, $2, $3, $4)', [outsider, r.id, 'not-a-hash', 1]);
    const { rows } = await db.query('select * from public.race_reports');
    expect(rows.length).toBe(0);
  });
});

describe('권한', () => {
  async function asAnon<T>(fn: () => Promise<T>): Promise<T> {
    await db.exec('set role anon');
    try {
      return await fn();
    } finally {
      await db.exec('reset role');
    }
  }
  it.each([
    ['관리자 설정 조회', 'select * from public.admin_config'],
    ['관리자 세션 조회', 'select * from public.admin_sessions'],
    ['결과 보고 조회', 'select * from public.race_reports'],
    ['경주 결과 조작', `update public.races set result_hash = 'deadbeef'`],
    ['경주 직접 생성', `insert into public.races (round_no, seed, entrants, race_seconds, engine_version, start_at) values (1,1,'[]',70,2,now())`],
    ['내부 함수', `select public._pw_hash('a','b')`],
  ])('일반 접속자 차단: %s', async (_, sql) => {
    await asAnon(async () => {
      await expect(db.query(sql)).rejects.toThrow(/permission denied/);
    });
  });

  it('일반 접속자도 공개 함수와 경주 조회는 가능', async () => {
    await rpc('public.admin_add_bots($1, $2)', [admin, 2]);
    const r = await start();
    await asAnon(async () => {
      expect((await getRace(r.id)).entrants.length).toBe(2);
      expect(typeof (await rpc<number>('public.server_time()'))).toBe('number');
      const { rows } = await db.query('select id from public.races');
      expect(rows.length).toBe(1);
    });
  });
});
