/**
 * 경주 중 작전 선택 서버 규칙 (엔진 v4)
 *  - 창이 열려 있을 때만 · 본인 말만 · 마지막 선택 하나 · 마감 후 거부
 *  - 마감(+0.3초)된 창의 선택만 공개 → 모든 화면이 같은 기록으로 같은 경주를 계산
 */
import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ENGINE_VERSION, simulateRace, tacticWindows, type TacticOrder } from '../../src/engine';
import { freshDb, makeRpc, newToken } from './db';

let db: PGlite;
let rpc: ReturnType<typeof makeRpc>;
let admin: string;

interface RaceFull {
  id: string;
  seed: number;
  entrants: { id: number; name: string }[];
  race_seconds: number;
}
interface Revealed {
  closed: number[];
  tactics: TacticOrder[];
}

const join = (t: string, n: string) => rpc<{ horse_no: number }>('public.join_game($1, $2)', [t, n]);
const start = (v = ENGINE_VERSION) => rpc<RaceFull>('public.admin_start_race($1, $2, $3)', [admin, v, 3000]);
const submit = (t: string, race: string, w: number, tac: string) =>
  rpc<{ window: number; tactic: string }>('public.submit_tactic($1, $2, $3, $4)', [t, race, w, tac]);
const reveal = (race: string) => rpc<Revealed>('public.get_race_tactics($1)', [race]);
/** 경과 시간을 정확히 ms 로 맞춤 (경주 시작 시각을 옮김) */
const setElapsed = (ms: number) =>
  db.query(`update public.races set start_at = clock_timestamp() - make_interval(secs => $1::float8 / 1000), paused_ms = 0, paused_at = null`, [ms]);

beforeAll(async () => {
  db = await freshDb();
  rpc = makeRpc(db);
});

beforeEach(async () => {
  await db.exec(`
    update public.game_state set phase = 'lobby', current_race_id = null, round_no = 1, max_players = 20, race_seconds = 70;
    delete from public.races; delete from public.participants; delete from public.admin_sessions; delete from public.admin_config;`);
  admin = (await rpc<{ token: string }>('public.admin_bootstrap($1)', ['test-password-123'])).token;
});

describe('작전 선택 (서버)', () => {
  it('SQL 창 시각 = 엔진 창 시각 (v4 3회 · 30~180초 전부)', async () => {
    for (let s = 30; s <= 180; s++) {
      const w = tacticWindows(s, 4);
      const r = await db.query<{ o: string; c: string }>(
        `select public._tactic_open_ms($1, g) as o, public._tactic_close_ms($1, g) as c from generate_series(1,3) g order by g`,
        [s],
      );
      expect(r.rows.map((x) => [Number(x.o), Number(x.c)])).toEqual(w.map((x) => [x.openMs, x.closeMs]));
    }
  });

  it('열린 창에서만 · 바꾸면 마지막 선택만 · 마감 후 거부 · 마감된 창만 공개', async () => {
    const a = newToken();
    const b = newToken();
    const na = (await join(a, '가나')).horse_no;
    const nb = (await join(b, '다라')).horse_no;
    const race = await start();
    const w = tacticWindows(race.race_seconds);

    // 출발 전 · 창 열리기 전
    await expect(submit(a, race.id, 1, 'SAVE')).rejects.toThrow('TACTIC_CLOSED');
    await setElapsed(w[0]!.openMs - 200);
    await expect(submit(a, race.id, 1, 'SAVE')).rejects.toThrow('TACTIC_CLOSED');

    await setElapsed(w[0]!.openMs + 500);
    await submit(a, race.id, 1, 'SAVE');
    await submit(a, race.id, 1, 'CHASE'); // 바꾸기
    await submit(a, race.id, 1, 'CHASE'); // 중복 요청
    await submit(b, race.id, 1, 'SPRINT');
    // 아직 열린 창의 선택은 공개되지 않음 · 다른 창(2) 선택도 지금은 불가
    expect(await reveal(race.id)).toEqual({ closed: [], tactics: [] });
    await expect(submit(a, race.id, 2, 'SPRINT')).rejects.toThrow('TACTIC_CLOSED');
    // 내 선택 복원
    expect(await rpc('public.get_my_tactics($1, $2)', [a, race.id])).toEqual([{ window: 1, tactic: 'CHASE' }]);

    // 마감 직후: 입력 거부, 0.3초 지나기 전엔 비공개
    await setElapsed(w[0]!.closeMs + 50);
    await expect(submit(a, race.id, 1, 'SPRINT')).rejects.toThrow('TACTIC_CLOSED');
    expect((await reveal(race.id)).closed).toEqual([]);
    await setElapsed(w[0]!.closeMs + 400);
    const rv = await reveal(race.id);
    expect(rv.closed).toEqual([1]);
    expect(rv.tactics).toEqual([
      { id: Math.min(na, nb), window: 1, tactic: na < nb ? 'CHASE' : 'SPRINT' },
      { id: Math.max(na, nb), window: 1, tactic: na < nb ? 'SPRINT' : 'CHASE' },
    ]);

    // 같은 기록 → 모든 화면에서 같은 결과
    const h1 = simulateRace({ seed: race.seed, entrants: race.entrants, raceSeconds: race.race_seconds, tactics: rv.tactics }).hash;
    const h2 = simulateRace({ seed: race.seed, entrants: race.entrants, raceSeconds: race.race_seconds, tactics: [...rv.tactics].reverse() }).hash;
    expect(h1).toBe(h2);

    // 3차까지 지나면 전부 공개
    await setElapsed(w[2]!.closeMs + 400);
    expect((await reveal(race.id)).closed).toEqual([1, 2, 3]);
  });

  it('참가하지 않은 기기 · 잘못된 작전 · v3 경주는 거부', async () => {
    const a = newToken();
    await join(a, '가나');
    const race = await start(3);
    await setElapsed(tacticWindows(70)[0]!.openMs + 500);
    await expect(submit(a, race.id, 1, 'SAVE')).rejects.toThrow('TACTIC_CLOSED');
    await expect(submit(newToken(), race.id, 1, 'SAVE')).rejects.toThrow('NOT_JOINED');
    await expect(submit(a, race.id, 1, 'TELEPORT')).rejects.toThrow('BAD_TACTIC');
    await expect(submit(a, race.id, 6, 'SAVE')).rejects.toThrow('BAD_TACTIC');
    expect((await reveal(race.id)).closed).toEqual([]);
  });

  it('작전 기록 테이블은 외부에서 직접 읽을 수 없다', async () => {
    await expect(db.query(`set role anon; select * from public.race_tactics;`)).rejects.toThrow();
    await db.query('reset role');
  });

  it('v8: SQL 창 시각 = 엔진 창 시각 (5회 · 30~180초 전부)', async () => {
    for (let s = 30; s <= 180; s++) {
      const w = tacticWindows(s, 8);
      const r = await db.query<{ o: string; c: string }>(
        `select public._tactic_open_ms_v($1, g, 8) as o, public._tactic_close_ms_v($1, g, 8) as c from generate_series(1,5) g order by g`,
        [s],
      );
      expect(r.rows.map((x) => [Number(x.o), Number(x.c)])).toEqual(w.map((x) => [x.openMs, x.closeMs]));
    }
  });

  it('v8 경주: 4·5번째 창에서도 선택 · 5개 모두 공개 / v7 경주는 4번째 창 거부', async () => {
    const a = newToken();
    await join(a, '가나');
    const race = await start(8);
    const w = tacticWindows(race.race_seconds, 8);
    for (const k of [3, 4]) {
      await setElapsed(w[k]!.openMs + 300);
      await submit(a, race.id, k + 1, 'CHASE');
    }
    await setElapsed(w[4]!.closeMs + 400);
    const rv = await reveal(race.id);
    expect(rv.closed).toEqual([1, 2, 3, 4, 5]);
    expect(rv.tactics.map((t) => t.window)).toEqual([4, 5]);

    await db.exec(`update public.game_state set phase = 'lobby', current_race_id = null; delete from public.races;`);
    const old = await start(7);
    await setElapsed(tacticWindows(70, 7)[2]!.openMs + 300);
    await expect(submit(a, old.id, 4, 'CHASE')).rejects.toThrow('BAD_TACTIC');
  });
});
