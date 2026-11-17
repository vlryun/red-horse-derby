/**
 * 행사 리허설: 가상 휴대폰 N대를 실서버에 붙여 실제 참가자와 똑같이 움직이게 한다.
 *   npm run rehearsal -- 45        (기본 20대)
 *
 * 각 가상 휴대폰은 앱의 실제 코드(Api·ServerTime·경주 엔진)를 쓰고, 기기마다 연결(실시간 소켓 포함)이 따로다.
 *  1) QR 찍는 사람처럼 약 10초에 걸쳐 차례로 참가
 *  2) 3초마다 대기실 조회 + 게임 상태 실시간 구독 + 30초마다 시계 재동기화·내 정보 확인
 *  3) 관리자가 경주를 시작하면 → 경주 정보를 받아 이 기기에서 계산 (얼마나 빨리 알아챘는지 측정)
 *  4) 경주가 끝나면 결과 해시 보고 (0~3초 분산)
 *  5) 관리자가 결과를 공개하면 → 내 계산과 공식 결과 비교
 * 관리자 동작(경주 시작·결과 공개)은 사람이 관리자 화면에서 한다. 이 스크립트는 기다리기만 한다.
 *
 * ⚠️ 끝나면 관리자 화면에서 "다음 라운드" → 참가자 목록에서 부하테스트 참가자 정리 (또는 전체 초기화)
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { ENGINE_VERSION, TICK_MS, simulateRace } from '../src/engine';
import { Api } from '../src/lib/backend/supabase';
import type { Lobby, RaceInfo } from '../src/lib/backend/types';
import { ServerTime } from '../src/lib/serverTime';

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
);
const N = Number(process.argv[2] ?? 20);
const TIMEOUT_MIN = Number(process.argv[3] ?? 10);
const OUT = process.argv[4] ?? 'rehearsal-result.json';

// ─── 측정 ───
const lat: Record<string, number[]> = {};
const errs: Record<string, number> = {};
const note = (kind: string, ms: number) => (lat[kind] ??= []).push(ms);
const fail = (kind: string) => (errs[kind] = (errs[kind] ?? 0) + 1);
async function timed<T>(kind: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  try {
    const v = await fn();
    note(kind, performance.now() - t0);
    return v;
  } catch (e) {
    fail(kind);
    throw e;
  }
}
const pct = (a: number[], p: number) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms: number) => ms * (0.85 + Math.random() * 0.3);

interface PhoneState {
  i: number;
  horseNo: number | null;
  joined: boolean;
  live: 'connecting' | 'live' | 'down';
  raceSeenServerMs: number | null; // 경주 시작을 알아챈 서버 기준 시각
  raceId: string | null;
  myHash: string | null;
  reported: boolean;
  officialMatch: boolean | null;
  offset: number;
  rtt: number;
}

const phones: PhoneState[] = [];
let stop = false;
let raceStartCallMs: number | null = null; // 관리자가 시작을 누른 서버 시각 ≈ start_at − 카운트다운
let officialHash: string | null = null;

async function runPhone(i: number): Promise<void> {
  const api = new Api(env.VITE_SUPABASE_URL!, env.VITE_SUPABASE_ANON_KEY!);
  const time = new ServerTime(() => timed('server_time', () => api.serverTime()));
  const token = randomBytes(32).toString('hex');
  const st: PhoneState = {
    i, horseNo: null, joined: false, live: 'connecting', raceSeenServerMs: null, raceId: null,
    myHash: null, reported: false, officialMatch: null, offset: 0, rtt: 0,
  };
  phones.push(st);

  // 1) QR 찍고 들어오는 시간 분산
  await sleep(Math.random() * 10_000);
  await time.sync().catch(() => {});
  try {
    const me = await timed('join', () => api.join(token, `부하테스트${i + 1}`));
    st.horseNo = me.horseNo;
    st.joined = true;
  } catch {
    return; // 참가 실패(정원 초과 등)는 errs 에 기록됨
  }

  // 비동기 콜백에서 바뀌는 값은 객체에 담는다 (타입 좁히기 문제 방지)
  const cur: { race: RaceInfo | null; result: ReturnType<typeof simulateRace> | null; lobby: Lobby | null } = {
    race: null,
    result: null,
    lobby: null,
  };

  const refresh = async () => {
    try {
      const l = await timed('get_lobby', () => api.lobby());
      cur.lobby = l;
      if (l.race && l.race.id !== st.raceId) {
        st.raceId = l.race.id;
        st.raceSeenServerMs = time.now();
        cur.race = await timed('get_race', () => api.race(l.race!.id));
        const r = cur.race;
        cur.result = r ? simulateRace({ seed: r.seed, entrants: r.entrants, raceSeconds: r.raceSeconds }) : null;
        st.myHash = cur.result?.hash ?? null;
      }
      if (l.race?.published && st.raceId && officialHash === null) {
        const r = await timed('get_race', () => api.race(st.raceId!));
        if (r?.resultHash) officialHash = r.resultHash;
      }
    } catch {
      /* 실패는 기록됨, 다음 폴링에서 다시 */
    }
  };

  // 2) 실시간 구독 (게임 상태만) + 폴링
  const unsub = api.subscribe(['game_state'], () => void refresh(), (s) => (st.live = s));
  let nextPoll = 0;
  let nextSync = Date.now() + jitter(30_000);
  let nextMe = Date.now() + jitter(30_000);

  while (!stop) {
    const now = Date.now();
    if (now >= nextPoll) {
      await refresh();
      nextPoll = Date.now() + jitter(3000);
    }
    if (now >= nextSync) {
      await time.sync().catch(() => {});
      nextSync = Date.now() + jitter(30_000);
    }
    if (now >= nextMe) {
      await timed('get_me', () => api.me(token)).catch(() => {});
      nextMe = Date.now() + jitter(30_000);
    }
    st.offset = time.getOffset();
    st.rtt = time.lastRtt;

    // 4) 경주 끝나면 결과 해시 보고
    const meta = cur.lobby?.race;
    const race = cur.race;
    const result = cur.result;
    if (race && result && meta && !st.reported) {
      const ref = meta.pausedAtMs ?? time.now();
      const elapsed = ref - meta.startAtMs - meta.pausedMs;
      if (elapsed >= result.totalTicks * TICK_MS) {
        st.reported = true;
        const id = race.id;
        const h = result.hash;
        setTimeout(() => void timed('report_result', () => api.reportResult(token, id, h, ENGINE_VERSION)).catch(() => {}), Math.random() * 3000);
      }
    }
    // 5) 공식 결과와 비교
    if (officialHash && st.myHash && st.officialMatch === null) st.officialMatch = st.myHash === officialHash;
    await sleep(250);
  }
  unsub();
}

function summary() {
  const joined = phones.filter((p) => p.joined).length;
  const live = phones.filter((p) => p.live === 'live').length;
  const saw = phones.filter((p) => p.raceSeenServerMs !== null);
  const detect = raceStartCallMs !== null ? saw.map((p) => p.raceSeenServerMs! - raceStartCallMs!) : [];
  const offsets = phones.filter((p) => p.joined).map((p) => p.offset);
  const rtts = phones.filter((p) => p.joined && Number.isFinite(p.rtt)).map((p) => p.rtt);
  const totalReq = Object.values(lat).reduce((s, a) => s + a.length, 0);
  const totalErr = Object.values(errs).reduce((s, n) => s + n, 0);
  return {
    phones: N,
    joined,
    realtimeLive: live,
    raceSeen: saw.length,
    reported: phones.filter((p) => p.reported).length,
    officialHash,
    matchOfficial: phones.filter((p) => p.officialMatch === true).length,
    mismatchOfficial: phones.filter((p) => p.officialMatch === false).length,
    detectRaceMs: detect.length ? { p50: Math.round(pct(detect, 50)), p95: Math.round(pct(detect, 95)), max: Math.round(Math.max(...detect)) } : null,
    clockOffsetSpreadMs: offsets.length ? Math.round(Math.max(...offsets) - Math.min(...offsets)) : null,
    syncRttMs: rtts.length ? { p50: Math.round(pct(rtts, 50)), max: Math.round(Math.max(...rtts)) } : null,
    requests: totalReq,
    errors: totalErr,
    errorRate: totalReq ? +((totalErr / (totalReq + totalErr)) * 100).toFixed(2) : 0,
    latencyMs: Object.fromEntries(
      Object.entries(lat).map(([k, a]) => [k, { n: a.length, p50: Math.round(pct(a, 50)), p95: Math.round(pct(a, 95)), max: Math.round(Math.max(...a)) }]),
    ),
    errorsByKind: errs,
  };
}

// ─── 실행 ───
console.log(`가상 휴대폰 ${N}대 시작 (최대 ${TIMEOUT_MIN}분). 관리자 화면에서 경주 시작 → 결과 공개를 해 주세요.`);
const started = Date.now();
const runs = Array.from({ length: N }, (_, i) => runPhone(i));

// 관리자 시작 시각 추적 + 진행 상황 출력
const observer = new Api(env.VITE_SUPABASE_URL!, env.VITE_SUPABASE_ANON_KEY!);
let lastPrint = 0;
while (!stop) {
  await sleep(1000);
  try {
    const l = await observer.lobby();
    if (l.race && raceStartCallMs === null) {
      const r = await observer.race(l.race.id);
      // 시작 요청 시각 ≈ 출발 시각 − 5초 카운트다운
      if (r) raceStartCallMs = r.startAtMs - 5000;
    }
  } catch {
    /* ignore */
  }
  const s = summary();
  if (Date.now() - lastPrint > 10_000) {
    lastPrint = Date.now();
    console.log(
      `[${Math.round((Date.now() - started) / 1000)}s] 참가 ${s.joined}/${N} · 실시간 ${s.realtimeLive} · 경주 인지 ${s.raceSeen} · 보고 ${s.reported} · 공식일치 ${s.matchOfficial} · 요청 ${s.requests} · 오류 ${s.errors}`,
    );
  }
  const allDone = s.joined > 0 && officialHash !== null && phones.filter((p) => p.joined).every((p) => p.officialMatch !== null);
  if (allDone || Date.now() - started > TIMEOUT_MIN * 60_000) stop = true;
}
await Promise.allSettled(runs);
const final = summary();
writeFileSync(OUT, JSON.stringify(final, null, 2));
console.log('\n===== 결과 =====');
console.log(JSON.stringify(final, null, 2));
process.exit(0);
