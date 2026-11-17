import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { FinishRecord, TacticType } from '../../engine';
import { withRetry } from './retry';
import {
  BackendError,
  type AdminPerson,
  type RaceDetail,
  KNOWN_CODES,
  type ErrorCode,
  type Lobby,
  type LiveStatus,
  type MyEntry,
  type MyTactic,
  type RaceTactics,
  type Phase,
  type PublicParticipant,
  type RaceHistoryItem,
  type RaceInfo,
  type RaceMeta,
  type RaceReport,
  type RaceStatus,
  type Table,
} from './types';

const TIMEOUT_MS = 8000;

interface RawMe {
  id: string;
  horse_no: number;
  nickname: string;
  recovery_code: string;
  renamed: boolean;
}
interface RawMeta {
  id: string;
  round_no: number;
  status: RaceStatus;
  start_at_ms: number;
  paused_at_ms: number | null;
  paused_ms: number;
  published?: boolean;
}
interface RawRace extends RawMeta {
  seed: number;
  entrants: { id: number; name: string }[];
  race_seconds: number;
  engine_version: number;
  result_hash: string | null;
  standings: FinishRecord[] | null;
  server_ms: number;
}

const toMe = (r: RawMe): MyEntry => ({
  id: r.id,
  horseNo: r.horse_no,
  nickname: r.nickname,
  recoveryCode: r.recovery_code,
  renamed: !!r.renamed,
});

const toMeta = (r: RawMeta): RaceMeta => ({
  id: r.id,
  roundNo: r.round_no,
  status: r.status,
  startAtMs: Number(r.start_at_ms),
  pausedAtMs: r.paused_at_ms === null ? null : Number(r.paused_at_ms),
  pausedMs: Number(r.paused_ms),
  published: r.published ?? r.status === 'finished',
});

const toRace = (r: RawRace): RaceInfo => ({
  ...toMeta({ ...r, published: r.standings !== null }),
  seed: Number(r.seed),
  entrants: r.entrants,
  raceSeconds: r.race_seconds,
  engineVersion: r.engine_version,
  resultHash: r.result_hash,
  standings: r.standings,
});

function classify(err: { message?: string; code?: string } | null | undefined): ErrorCode {
  const msg = err?.message ?? '';
  const exact = KNOWN_CODES.find((c) => msg === c);
  if (exact) return exact;
  const partial = KNOWN_CODES.find((c) => msg.includes(c));
  if (partial) return partial;
  const code = err?.code ?? '';
  // PostgreSQL 오류 코드(SQLSTATE 5자리) 중 일시적인 것만 재시도:
  //   08 연결 문제 · 40 직렬화 실패/교착 · 53 자원 부족(연결 수 초과 등) · 57 서버 재시작/쿼리 취소
  // 나머지(21 규칙 위반, 22 잘못된 데이터, 23 제약 위반, 42 권한·문법 …)는 재시도해도 소용없음
  if (/^[0-9A-Z]{5}$/.test(code)) return /^(08|40|53|57)/.test(code) ? 'NETWORK' : 'UNKNOWN';
  if (/^PGRST1/.test(code)) return 'UNKNOWN'; // 요청 형식 오류
  return 'NETWORK'; // fetch 실패, 타임아웃, 5xx 등 → 재시도 대상
}

/**
 * 서버 통신 전부.
 * 참가자/조회용 호출은 네트워크 오류 시 자동 재시도(서버에서 멱등).
 * 관리자 "동작" 호출(시작·일시정지 등)은 재시도하지 않는다: 응답만 유실된 경우
 * 두 번 실행될 수 있으므로, 실패하면 화면이 상태를 다시 읽어 관리자가 판단하게 한다.
 */
export class Api {
  private client: SupabaseClient;

  constructor(url: string, anonKey: string) {
    this.client = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      realtime: { params: { eventsPerSecond: 5 } },
    });
  }

  private async rpc<T>(fn: string, args: Record<string, unknown> = {}, retries = 3): Promise<T> {
    return withRetry(async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      try {
        const { data, error } = await this.client.rpc(fn, args).abortSignal(ctrl.signal);
        if (error) throw new BackendError(classify(error), error.message);
        return data as T;
      } catch (e) {
        if (e instanceof BackendError) throw e;
        throw new BackendError('NETWORK', String(e));
      } finally {
        clearTimeout(timer);
      }
    }, retries);
  }

  // ─── 참가자 ───
  async join(token: string, nickname: string): Promise<MyEntry> {
    return toMe(await this.rpc<RawMe>('join_game', { p_token: token, p_nickname: nickname }));
  }
  async me(token: string): Promise<MyEntry | null> {
    const r = await this.rpc<RawMe | null>('get_me', { p_token: token });
    return r ? toMe(r) : null;
  }
  /** 닉네임 변경 (경주 진행 중이 아닐 때만). 번호·복구코드는 그대로 */
  async rename(token: string, nickname: string): Promise<MyEntry> {
    return toMe(await this.rpc<RawMe>('rename_participant', { p_token: token, p_nickname: nickname }, 0));
  }
  /** 진행자에게 내보내진 기기인지 (접수 마감 중에도 다시 참가 가능) */
  async canRejoin(token: string): Promise<boolean> {
    return (await this.rpc<boolean>('can_rejoin', { p_token: token })) === true;
  }
  async leave(token: string): Promise<void> {
    await this.rpc('leave_game', { p_token: token });
  }
  async recover(horseNo: number, code: string, token: string): Promise<MyEntry> {
    const r = await this.rpc<RawMe | { error: ErrorCode }>('recover_participant', {
      p_horse_no: horseNo,
      p_code: code,
      p_token: token,
    });
    if ('error' in r) throw new BackendError(r.error);
    return toMe(r);
  }
  async reportResult(token: string, raceId: string, hash: string, engineVersion: number): Promise<void> {
    await this.rpc('report_result', { p_token: token, p_race_id: raceId, p_hash: hash, p_engine_version: engineVersion }, 1);
  }

  // ─── 경주 중 작전 ───
  /** 작전 선택 (창이 열려 있을 때만, 같은 창에서 다시 고르면 바꿈 → 재시도해도 안전) */
  async submitTactic(token: string, raceId: string, window: number, tactic: TacticType): Promise<MyTactic> {
    return this.rpc<MyTactic>('submit_tactic', { p_token: token, p_race_id: raceId, p_window: window, p_tactic: tactic }, 1);
  }
  async myTactics(token: string, raceId: string): Promise<MyTactic[]> {
    return (await this.rpc<MyTactic[] | null>('get_my_tactics', { p_token: token, p_race_id: raceId })) ?? [];
  }
  /** 마감된 창의 작전 전체 */
  async raceTactics(raceId: string): Promise<RaceTactics> {
    const r = await this.rpc<RaceTactics | null>('get_race_tactics', { p_race_id: raceId }, 1);
    return r ?? { closed: [], tactics: [] };
  }

  // ─── 조회 ───
  async lobby(): Promise<Lobby> {
    const r = await this.rpc<{
      phase: Phase;
      count: number;
      max_players: number;
      race_seconds: number;
      round_no: number;
      server_ms: number;
      race: RawMeta | null;
    }>('get_lobby');
    return {
      phase: r.phase,
      count: r.count,
      maxPlayers: r.max_players,
      raceSeconds: r.race_seconds,
      roundNo: r.round_no,
      serverMs: Number(r.server_ms),
      race: r.race ? toMeta(r.race) : null,
    };
  }
  async race(id: string): Promise<RaceInfo | null> {
    const r = await this.rpc<RawRace | null>('get_race', { p_race_id: id });
    return r ? toRace(r) : null;
  }
  async serverTime(): Promise<number> {
    return Number(await this.rpc<number>('server_time', {}, 0));
  }
  async participants(): Promise<PublicParticipant[]> {
    return withRetry(async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      try {
        const { data, error } = await this.client
          .from('participants')
          .select('id, horse_no, nickname, created_at')
          .order('horse_no')
          .abortSignal(ctrl.signal);
        if (error) throw new BackendError(classify(error), error.message);
        return (data ?? []).map((r) => ({
          id: r.id as string,
          horseNo: r.horse_no as number,
          nickname: r.nickname as string,
          createdAt: r.created_at as string,
        }));
      } catch (e) {
        if (e instanceof BackendError) throw e;
        throw new BackendError('NETWORK', String(e));
      } finally {
        clearTimeout(timer);
      }
    });
  }

  // ─── 관리자 ───
  async adminStatus(): Promise<{ configured: boolean }> {
    return this.rpc('admin_status');
  }
  async adminBootstrap(password: string): Promise<string> {
    return (await this.rpc<{ token: string }>('admin_bootstrap', { p_password: password }, 0)).token;
  }
  async adminLogin(password: string): Promise<string> {
    const r = await this.rpc<{ token?: string; error?: ErrorCode; retry_ms?: number }>(
      'admin_login',
      { p_password: password },
      1,
    );
    if (r.error || !r.token) throw new BackendError(r.error ?? 'UNKNOWN', undefined, r.retry_ms);
    return r.token;
  }
  async adminLogout(t: string) {
    await this.rpc('admin_logout', { p_token: t }, 0);
  }
  async adminChangePassword(t: string, pw: string) {
    await this.rpc('admin_change_password', { p_token: t, p_new_password: pw }, 0);
  }
  async adminSetPhase(t: string, phase: 'lobby' | 'closed') {
    await this.rpc('admin_set_phase', { p_token: t, p_phase: phase }, 0);
  }
  async adminUpdateSettings(t: string, maxPlayers: number | null, raceSeconds: number | null) {
    await this.rpc('admin_update_settings', { p_token: t, p_max_players: maxPlayers, p_race_seconds: raceSeconds }, 0);
  }
  async adminAddBots(t: string, n: number): Promise<number> {
    return this.rpc('admin_add_bots', { p_token: t, p_count: n }, 0);
  }
  async adminRemoveParticipant(t: string, horseNo: number) {
    await this.rpc('admin_remove_participant', { p_token: t, p_horse_no: horseNo }, 0);
  }
  async adminStartRace(t: string, engineVersion: number, countdownMs: number): Promise<RaceInfo> {
    return toRace(
      await this.rpc<RawRace>('admin_start_race', { p_token: t, p_engine_version: engineVersion, p_countdown_ms: countdownMs }, 0),
    );
  }
  async adminPause(t: string) {
    await this.rpc('admin_pause_race', { p_token: t }, 0);
  }
  async adminResume(t: string) {
    await this.rpc('admin_resume_race', { p_token: t }, 0);
  }
  /** 공개는 서버에서 멱등(같은 해시 재요청 OK)이라 재시도 허용 */
  async adminPublish(t: string, raceId: string, engineVersion: number, hash: string, standings: FinishRecord[]) {
    await this.rpc('admin_publish_result', {
      p_token: t,
      p_race_id: raceId,
      p_engine_version: engineVersion,
      p_hash: hash,
      p_standings: standings,
    });
  }
  async adminAbort(t: string) {
    await this.rpc('admin_abort_race', { p_token: t }, 0);
  }
  async adminNextRound(t: string) {
    await this.rpc('admin_next_round', { p_token: t }, 0);
  }
  async adminResetAll(t: string) {
    await this.rpc('admin_reset_all', { p_token: t }, 0);
  }
  async adminRaceReport(t: string): Promise<RaceReport | null> {
    const r = await this.rpc<{
      entrants: number;
      reports: number;
      official_hash: string | null;
      matching: number;
      hashes: Record<string, number>;
    } | null>('admin_race_report', { p_token: t }, 1);
    return r
      ? { entrants: r.entrants, reports: r.reports, officialHash: r.official_hash, matching: r.matching, hashes: r.hashes }
      : null;
  }
  async adminRaceHistory(t: string): Promise<RaceHistoryItem[]> {
    const r = await this.rpc<
      {
        id: string;
        round_no: number;
        status: RaceStatus;
        seed: number;
        race_seconds: number;
        result_hash: string | null;
        entrant_count: number;
        winner: string | null;
        runner_up: string | null;
        created_at: string;
        is_test?: boolean;
      }[]
    >('admin_race_history', { p_token: t }, 1);
    return r.map((x) => ({
      id: x.id,
      roundNo: x.round_no,
      status: x.status,
      seed: Number(x.seed),
      raceSeconds: x.race_seconds,
      resultHash: x.result_hash,
      entrantCount: x.entrant_count,
      winner: x.winner,
      runnerUp: x.runner_up,
      createdAt: x.created_at,
      isTest: !!x.is_test,
    }));
  }
  async adminParticipants(t: string): Promise<AdminPerson[]> {
    const r = await this.rpc<
      {
        id: string;
        horse_no: number;
        nickname: string;
        is_test: boolean;
        online: boolean;
        recovery_code: string;
        recovery_fails: number;
        last_seen_ms: number;
      }[]
    >('admin_participants', { p_token: t }, 1);
    return r.map((x) => ({
      id: x.id,
      horseNo: x.horse_no,
      nickname: x.nickname,
      isTest: x.is_test,
      online: x.online,
      recoveryCode: x.recovery_code,
      recoveryFails: x.recovery_fails,
      lastSeenMs: Number(x.last_seen_ms),
    }));
  }
  async adminRemoveBots(t: string): Promise<number> {
    return this.rpc('admin_remove_bots', { p_token: t }, 0);
  }
  async adminUnlockRecovery(t: string, horseNo: number) {
    await this.rpc('admin_unlock_recovery', { p_token: t, p_horse_no: horseNo }, 0);
  }
  async adminRaceDetail(t: string, raceId: string): Promise<RaceDetail> {
    const r = await this.rpc<{
      race: RawRace;
      is_test: boolean;
      created_ms: number;
      published_ms: number | null;
      reports: number;
      matching: number;
    }>('admin_race_detail', { p_token: t, p_race_id: raceId }, 1);
    return {
      race: toRace(r.race),
      isTest: r.is_test,
      createdMs: Number(r.created_ms),
      publishedMs: r.published_ms === null ? null : Number(r.published_ms),
      reports: r.reports,
      matching: r.matching,
    };
  }

  // ─── 실시간 ───
  subscribe(tables: Table[], onChange: () => void, onStatus?: (s: LiveStatus) => void): () => void {
    const name = `rhd-${tables.join('-')}-${Math.random().toString(36).slice(2, 8)}`;
    let channel = this.client.channel(name);
    for (const table of tables) {
      channel = channel.on('postgres_changes', { event: '*', schema: 'public', table }, () => onChange());
    }
    onStatus?.('connecting');
    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        onStatus?.('live');
        onChange(); // (재)연결 직후: 끊긴 동안 놓친 변경을 메우기 위해 전체 재조회
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        onStatus?.('down'); // supabase-js 가 자동 재연결. 그동안은 폴링이 대신함
      }
    });
    return () => {
      void this.client.removeChannel(channel);
    };
  }
}
