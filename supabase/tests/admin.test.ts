/**
 * 4단계 관리자 기능: 테스트봇 구분 · 접속 상태 · 복구 지원 · 기록 상세
 */
import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ENGINE_VERSION, simulateRace } from '../../src/engine';
import { freshDb, makeRpc, newToken } from './db';

let db: PGlite;
let rpc: ReturnType<typeof makeRpc>;
let admin: string;

interface AdminPerson {
  horse_no: number;
  nickname: string;
  is_test: boolean;
  online: boolean;
  recovery_code: string;
  recovery_fails: number;
  last_seen_ms: number;
}

const people = () => rpc<AdminPerson[]>('public.admin_participants($1)', [admin]);
const join = (t: string, n: string) => rpc<{ recovery_code: string; horse_no: number }>('public.join_game($1, $2)', [t, n]);

beforeAll(async () => {
  db = await freshDb();
  rpc = makeRpc(db);
});

beforeEach(async () => {
  await db.exec(`
    update public.game_state set phase = 'lobby', current_race_id = null, round_no = 1, max_players = 20, race_seconds = 30;
    delete from public.races; delete from public.participants; delete from public.admin_sessions; delete from public.admin_config; delete from public.kicked_tokens;`);
  admin = (await rpc<{ token: string }>('public.admin_bootstrap($1)', ['admin-pass-1234'])).token;
});

describe('행사 기본 설정', () => {
  it('새 서버의 기본 정원은 20명 (관리자가 1~20으로 변경 가능)', async () => {
    const fresh = await freshDb();
    const lobby = await makeRpc(fresh)<{ max_players: number }>('public.get_lobby()');
    expect(lobby.max_players).toBe(20);
    await fresh.close();
  });

  it('관리자가 정한 정원은 마이그레이션을 다시 실행해도 유지', async () => {
    const fresh = await freshDb();
    await fresh.exec('update public.game_state set max_players = 15');
    const { MIGRATIONS } = await import('./db');
    await fresh.exec(MIGRATIONS);
    expect((await makeRpc(fresh)<{ max_players: number }>('public.get_lobby()')).max_players).toBe(15);
    await fresh.close();
  });
});

describe('정원 상한 20명', () => {
  it('관리자 설정은 1~20명만 허용', async () => {
    await expect(rpc('public.admin_update_settings($1, $2, $3)', [admin, 21, null])).rejects.toThrow('BAD_SETTINGS');
    await expect(rpc('public.admin_update_settings($1, $2, $3)', [admin, 50, null])).rejects.toThrow('BAD_SETTINGS');
    await rpc('public.admin_update_settings($1, $2, $3)', [admin, 20, null]);
    await rpc('public.admin_update_settings($1, $2, $3)', [admin, 1, null]);
  });

  it('DB 규칙: SQL 로 직접 21명 이상으로 바꿔도 거부', async () => {
    await expect(db.exec('update public.game_state set max_players = 21')).rejects.toThrow(/game_state_max_players_20/);
  });

  it('봇으로 채워도 20명에서 멈춤', async () => {
    expect(await rpc<number>('public.admin_add_bots($1, $2)', [admin, 50])).toBe(20);
    await expect(join(newToken(), '21번째')).rejects.toThrow('FULL');
  });
});

describe('테스트봇 / 리허설', () => {
  it('봇은 is_test 로 표시되고, "테스트봇만 삭제"는 실제 참가자를 남긴다', async () => {
    await join(newToken(), '진짜사람');
    await rpc('public.admin_add_bots($1, $2)', [admin, 5]);
    let list = await people();
    expect(list.filter((p) => p.is_test).length).toBe(5);
    expect(list.find((p) => p.nickname === '진짜사람')!.is_test).toBe(false);
    expect(await rpc<number>('public.admin_remove_bots($1)', [admin])).toBe(5);
    list = await people();
    expect(list.map((p) => p.nickname)).toEqual(['진짜사람']);
  });

  it('경주 중엔 봇 삭제 불가', async () => {
    await rpc('public.admin_add_bots($1, $2)', [admin, 2]);
    await rpc('public.admin_start_race($1, $2, $3)', [admin, ENGINE_VERSION, 3000]);
    await expect(rpc('public.admin_remove_bots($1)', [admin])).rejects.toThrow('RACE_ACTIVE');
  });

  it('전원 봇이면 리허설 경주로 기록, 사람이 섞이면 실제 경주', async () => {
    await rpc('public.admin_add_bots($1, $2)', [admin, 3]);
    await rpc('public.admin_start_race($1, $2, $3)', [admin, ENGINE_VERSION, 3000]);
    await rpc('public.admin_abort_race($1)', [admin]);
    await rpc('public.admin_set_phase($1, $2)', [admin, 'lobby']); // 중단 후엔 접수가 닫혀 있음
    await join(newToken(), '사람');
    await rpc('public.admin_start_race($1, $2, $3)', [admin, ENGINE_VERSION, 3000]);
    const hist = await rpc<{ is_test: boolean; entrant_count: number }[]>('public.admin_race_history($1)', [admin]);
    expect(hist.map((h) => [h.entrant_count, h.is_test])).toEqual([
      [4, false],
      [3, true],
    ]);
  });
});

describe('접속 상태', () => {
  it('최근 75초 안에 확인한 사람만 접속 중, 봇은 항상 접속 아님', async () => {
    const a = newToken();
    const b = newToken();
    await join(a, '접속중');
    await join(b, '자리비움');
    await rpc('public.admin_add_bots($1, $2)', [admin, 1]);
    await db.query(
      `update public.participant_secrets s set last_seen_at = now() - interval '5 minutes'
         from public.participants p where p.id = s.participant_id and p.nickname = '자리비움'`,
    );
    await rpc('public.get_me($1)', [a]);
    const list = await people();
    expect(Object.fromEntries(list.map((p) => [p.nickname, p.online]))).toEqual({
      접속중: true,
      자리비움: false,
      테스트봇1: false,
    });
    // 다시 확인 요청을 보내면 접속 중으로
    await rpc('public.get_me($1)', [b]);
    expect((await people()).find((p) => p.nickname === '자리비움')!.online).toBe(true);
  });
});

describe('현장 지원', () => {
  it('관리자는 복구코드를 볼 수 있고, 잠긴 복구를 풀 수 있다', async () => {
    const r = await join(newToken(), '분실자');
    expect((await people())[0]!.recovery_code).toBe(r.recovery_code);
    for (let i = 0; i < 5; i++) await rpc('public.recover_participant($1, $2, $3)', [r.horse_no, 'WRONG1', newToken()]);
    expect((await people())[0]!.recovery_fails).toBe(5);
    const locked = await rpc<{ error: string }>('public.recover_participant($1, $2, $3)', [r.horse_no, r.recovery_code, newToken()]);
    expect(locked.error).toBe('RECOVERY_LOCKED');
    await rpc('public.admin_unlock_recovery($1, $2)', [admin, r.horse_no]);
    const ok = await rpc<{ horse_no: number }>('public.recover_participant($1, $2, $3)', [r.horse_no, r.recovery_code, newToken()]);
    expect(ok.horse_no).toBe(r.horse_no);
  });

  it('관리자 아니면 참가자 목록(복구코드 포함) 조회 불가', async () => {
    await expect(rpc('public.admin_participants($1)', [newToken()])).rejects.toThrow('ADMIN_AUTH');
    await expect(rpc('public.admin_unlock_recovery($1, $2)', [null, 1])).rejects.toThrow('ADMIN_AUTH');
  });
});

describe('기록 상세', () => {
  it('지난 경주의 전체 순위와 결과 일치 현황', async () => {
    const t = newToken();
    await join(t, '사람');
    await rpc('public.admin_add_bots($1, $2)', [admin, 4]);
    const race = await rpc<{ id: string; seed: number; entrants: { id: number; name: string }[]; race_seconds: number }>(
      'public.admin_start_race($1, $2, $3)',
      [admin, ENGINE_VERSION, 3000],
    );
    await db.query(`update public.races set start_at = start_at - interval '60 seconds'`);
    const local = simulateRace({ seed: race.seed, entrants: race.entrants, raceSeconds: race.race_seconds });
    await rpc('public.admin_publish_result($1, $2, $3, $4, $5)', [admin, race.id, ENGINE_VERSION, local.hash, JSON.stringify(local.standings)]);
    await rpc('public.report_result($1, $2, $3, $4)', [t, race.id, local.hash, ENGINE_VERSION]);
    await rpc('public.admin_next_round($1)', [admin]);

    const d = await rpc<{ race: { standings: { rank: number; id: number }[]; result_hash: string }; reports: number; matching: number; is_test: boolean }>(
      'public.admin_race_detail($1, $2)',
      [admin, race.id],
    );
    expect(d.race.standings.length).toBe(5);
    expect(d.race.result_hash).toBe(local.hash);
    expect(d).toMatchObject({ reports: 1, matching: 1, is_test: false });
  });

  it('없는 경주 → NO_RACE', async () => {
    await expect(rpc('public.admin_race_detail($1, $2)', [admin, '00000000-0000-0000-0000-000000000000'])).rejects.toThrow('NO_RACE');
  });
});

describe('내보낸 참가자 재참가 · 닉네임 변경', () => {
  const me = (t: string) => rpc<{ horse_no: number; nickname: string; renamed: boolean } | null>('public.get_me($1)', [t]);

  it('내보내진 기기는 접수 마감 중에도 다시 참가 가능 (다른 기기는 여전히 마감)', async () => {
    const a = newToken();
    const other = newToken();
    const j = await join(a, '민수');
    await rpc('public.admin_set_phase($1, $2)', [admin, 'closed']);
    await rpc('public.admin_remove_participant($1, $2)', [admin, j.horse_no]);
    expect(await me(a)).toBeNull();
    expect(await rpc<boolean>('public.can_rejoin($1)', [a])).toBe(true);
    expect(await rpc<boolean>('public.can_rejoin($1)', [other])).toBe(false);
    await expect(join(other, '영희')).rejects.toThrow('REGISTRATION_CLOSED');
    const again = await join(a, '민수새');
    expect(again.horse_no).toBeGreaterThan(0);
    expect(await rpc<boolean>('public.can_rejoin($1)', [a])).toBe(false); // 한 번 재참가하면 기록 삭제
  });

  it('재참가도 정원은 지킨다 · 전체 초기화하면 내보내기 기록도 사라짐', async () => {
    await rpc('public.admin_update_settings($1, $2, $3)', [admin, 1, null]);
    const a = newToken();
    const j = await join(a, '하나');
    await rpc('public.admin_remove_participant($1, $2)', [admin, j.horse_no]);
    await join(newToken(), '둘');
    await expect(join(a, '하나')).rejects.toThrow('FULL');
    await rpc('public.admin_reset_all($1)', [admin]);
    expect(await rpc<boolean>('public.can_rejoin($1)', [a])).toBe(false);
  });

  it('경주 전(대기실·마감)에는 닉네임 변경 가능, 번호는 그대로, 중복이면 숫자 붙임', async () => {
    const a = newToken();
    const b = newToken();
    const ja = await join(a, '번개');
    await join(b, '질풍');
    const r1 = await rpc<{ horse_no: number; nickname: string; renamed: boolean }>('public.rename_participant($1, $2)', [a, '천둥']);
    expect(r1).toMatchObject({ horse_no: ja.horse_no, nickname: '천둥', renamed: false });
    await rpc('public.admin_set_phase($1, $2)', [admin, 'closed']);
    const r2 = await rpc<{ nickname: string; renamed: boolean }>('public.rename_participant($1, $2)', [a, '질풍']);
    expect(r2).toMatchObject({ nickname: '질풍2', renamed: true });
    // 자기 이름 그대로 다시 저장해도 숫자가 붙지 않음
    expect((await rpc<{ nickname: string }>('public.rename_participant($1, $2)', [a, '질풍2'])).nickname).toBe('질풍2');
    await expect(rpc('public.rename_participant($1, $2)', [a, '   '])).rejects.toThrow('INVALID_NICKNAME');
    await expect(rpc('public.rename_participant($1, $2)', [newToken(), '아무개'])).rejects.toThrow('NOT_JOINED');
  });

  it('경주가 시작되면 닉네임 변경 불가 (경주가 정리되면 다시 가능)', async () => {
    const a = newToken();
    await join(a, '번개');
    await rpc('public.admin_start_race($1, $2, $3)', [admin, ENGINE_VERSION, 3000]);
    await expect(rpc('public.rename_participant($1, $2)', [a, '천둥'])).rejects.toThrow('NAME_LOCKED');
    await rpc('public.admin_abort_race($1)', [admin]); // 비상 중단하면 경주 정리 → 다시 변경 가능
    expect((await rpc<{ nickname: string }>('public.rename_participant($1, $2)', [a, '천둥'])).nickname).toBe('천둥');
  });
});
