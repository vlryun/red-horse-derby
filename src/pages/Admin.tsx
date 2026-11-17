import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { fetchLatestVersion, isOutdated, reloadToLatest } from '../lib/appUpdate';
import { ConnBanner } from '../components/ConnBanner';
import { useDialog } from '../components/Dialog';
import { ENGINE_VERSION, TICK_MS, type FinishRecord } from '../engine';
import { formatTime } from '../game/RaceScene';
import { hex, horseColor, textOn } from '../game/palette';
import {
  BackendError,
  errorText,
  getBackend,
  type AdminPerson,
  type Phase,
  type RaceDetail,
  type RaceHistoryItem,
  type RaceReport,
} from '../lib/backend';
import { useLive, useLobby } from '../lib/useLive';
import { serverTime, useAutoReloadOnEngineMismatch, useRaceSync, useServerTimeSync } from '../lib/useRace';

const TOKEN_KEY = 'rhd.admin.v1';
const loadToken = () => {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
};
const saveToken = (t: string | null) => {
  try {
    if (t) sessionStorage.setItem(TOKEN_KEY, t);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
};

/**
 * 관리자 화면.
 * 세션 토큰은 이 탭(sessionStorage)에만 저장 → 탭을 닫으면 다시 로그인.
 * 휴대폰으로도 진행할 수 있게 경주 조작 버튼은 화면 위쪽에 고정.
 */
export function Admin() {
  const [token, setToken] = useState<string | null>(() => loadToken());
  const logout = useCallback(() => {
    if (token) void getBackend().adminLogout(token).catch(() => {});
    saveToken(null);
    setToken(null);
  }, [token]);

  return (
    <main className="admin">
      {token ? (
        <Dashboard token={token} onAuthLost={() => (saveToken(null), setToken(null))} onLogout={logout} />
      ) : (
        <Login
          onToken={(t) => {
            saveToken(t);
            setToken(t);
          }}
        />
      )}
    </main>
  );
}

// ─────────────────────────────── 로그인 ───────────────────────────────

function Login({ onToken }: { onToken: (t: string) => void }) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getBackend()
      .adminStatus()
      .then((s) => setConfigured(s.configured))
      .catch(() => setError('서버에 연결할 수 없어요.'));
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    if (!configured && pw !== pw2) {
      setError('두 비밀번호가 달라요.');
      return;
    }
    setBusy(true);
    try {
      onToken(configured ? await getBackend().adminLogin(pw) : await getBackend().adminBootstrap(pw));
    } catch (err) {
      if (err instanceof BackendError && err.code === 'ADMIN_LOCKED' && err.retryMs) {
        setError(`5번 틀려서 잠겼어요. ${Math.ceil(err.retryMs / 1000)}초 뒤 다시 시도해 주세요.`);
      } else setError(errorText(err));
      if (err instanceof BackendError && err.code === 'ALREADY_CONFIGURED') setConfigured(true);
    } finally {
      setBusy(false);
    }
  };

  if (configured === null) return <p className="pulse center">{error ?? '확인 중…'}</p>;

  return (
    <form className="admin-card admin-login" onSubmit={submit}>
      <h1>🔐 관리자</h1>
      {!configured && <p className="muted">처음이에요. 행사 진행에 쓸 관리자 비밀번호를 정해 주세요 (8자 이상).</p>}
      <label>
        비밀번호
        <input
          type="password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          autoComplete={configured ? 'current-password' : 'new-password'}
          autoFocus
        />
      </label>
      {!configured && (
        <label>
          비밀번호 확인
          <input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" />
        </label>
      )}
      {error && <p className="err">{error}</p>}
      <button className="cta" disabled={busy || pw.length < (configured ? 1 : 8)}>
        {busy ? '확인 중…' : configured ? '로그인' : '비밀번호 정하고 시작'}
      </button>
    </form>
  );
}

// ─────────────────────────────── 대시보드 ───────────────────────────────

const PHASE_LABEL: Record<Phase, string> = {
  lobby: '🟢 참가 접수 중',
  closed: '🔒 참가 마감',
  countdown: '🚦 출발 준비',
  racing: '🏇 경주 중',
  paused: '⏸ 일시정지',
  finished: '🏁 결과 공개됨',
};

function Dashboard({ token, onAuthLost, onLogout }: { token: string; onAuthLost: () => void; onLogout: () => void }) {
  const api = getBackend();
  const dialog = useDialog();
  const { data: lobby, status, refresh } = useLobby();
  const { data: people, refresh: refreshPeople } = useLive<AdminPerson[]>(() => api.adminParticipants(token), {
    tables: ['participants'],
    slowMs: 5000, // 접속 상태 표시를 위해 실시간이어도 5초마다
    fastMs: 3000,
  });
  const sync = useRaceSync(lobby);
  useAutoReloadOnEngineMismatch(sync);
  useServerTimeSync();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [now, setNow] = useState(() => serverTime.now());
  const [report, setReport] = useState<RaceReport | null>(null);

  useEffect(() => {
    const id = setInterval(() => setNow(serverTime.now()), 250);
    return () => clearInterval(id);
  }, []);

  const run = useCallback(
    async (label: string, fn: () => Promise<unknown>, okText?: string) => {
      if (busy) return;
      setBusy(label);
      setMsg(null);
      try {
        await fn();
        if (okText) setMsg({ ok: true, text: okText });
      } catch (e) {
        if (e instanceof BackendError && e.code === 'ADMIN_AUTH') return onAuthLost();
        setMsg({ ok: false, text: errorText(e) });
      } finally {
        setBusy(null);
        void refresh();
        void refreshPeople();
      }
    },
    [busy, onAuthLost, refresh, refreshPeople],
  );

  // 결과 일치 현황 (경주가 있을 때 3초마다)
  const raceId = sync.meta?.id;
  useEffect(() => {
    if (!raceId) {
      setReport(null);
      return;
    }
    let alive = true;
    const load = () =>
      api
        .adminRaceReport(token)
        .then((r) => alive && setReport(r))
        .catch((e) => e instanceof BackendError && e.code === 'ADMIN_AUTH' && onAuthLost());
    void load();
    const id = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [raceId, api, token, onAuthLost]);

  if (!lobby) return <p className="pulse center">불러오는 중…</p>;

  const race = sync.meta && sync.meta.status !== 'aborted' ? sync.meta : null;
  const count = people?.length ?? lobby.count;
  const online = people?.filter((p) => p.online).length ?? 0;
  const bots = people?.filter((p) => p.isTest).length ?? 0;
  const humans = count - bots;

  return (
    <div className="admin-grid">
      <ConnBanner status={status} />
      {dialog.node}
      <header className="admin-head">
        <h1>🔐 관리자</h1>
        <span className="admin-phase">{PHASE_LABEL[lobby.phase]}</span>
        <span className="muted">
          {lobby.roundNo}라운드 · 참가 <b>{count}</b>/{lobby.maxPlayers}
          {humans > 0 && (
            <>
              {' '}
              · 📱 접속 중 <b className={online < humans ? 'warn' : 'ok'}>{online}</b>/{humans}
            </>
          )}
          {bots > 0 && <> · 🤖 봇 {bots}</>} · 경주 {lobby.raceSeconds}초
        </span>
        <span className="spacer" />
        <a href="/screen" target="_blank" rel="noreferrer">
          대형 화면 ↗
        </a>
        <button className="ghost small" onClick={onLogout}>
          로그아웃
        </button>
      </header>

      {msg && (
        <div className={`admin-msg ${msg.ok ? 'ok' : 'bad'}`} role="status">
          {msg.text}
        </div>
      )}

      <RaceControl
        sync={sync}
        race={race}
        now={now}
        count={count}
        humans={humans}
        online={online}
        report={report}
        busy={!!busy}
        run={run}
        token={token}
        dialog={dialog}
      />

      <RegistrationCard lobby={lobby} raceActive={!!race} busy={!!busy} run={run} token={token} />
      <RehearsalCard raceActive={!!race} bots={bots} busy={!!busy} run={run} token={token} dialog={dialog} />
      <StatusCard liveStatus={status} />

      <PeopleCard people={people} raceActive={!!race} busy={!!busy} run={run} token={token} dialog={dialog} />
      <HistoryCard token={token} onAuthLost={onAuthLost} />
      <DangerCard busy={!!busy} run={run} token={token} dialog={dialog} />
    </div>
  );
}

type Run = (label: string, fn: () => Promise<unknown>, okText?: string) => Promise<void>;
type Dialog = ReturnType<typeof useDialog>;

// ─────────────────────────────── 경주 진행 ───────────────────────────────

function RaceControl({
  sync,
  race,
  now,
  count,
  humans,
  online,
  report,
  busy,
  run,
  token,
  dialog,
}: {
  sync: ReturnType<typeof useRaceSync>;
  race: ReturnType<typeof useRaceSync>['meta'];
  now: number;
  count: number;
  humans: number;
  online: number;
  report: RaceReport | null;
  busy: boolean;
  run: Run;
  token: string;
  dialog: Dialog;
}) {
  const api = getBackend();
  const elapsed = race ? (race.pausedAtMs ?? now) - race.startAtMs - race.pausedMs : 0;
  const totalMs = sync.result ? sync.result.totalTicks * TICK_MS : null;
  const raceOver = totalMs !== null && elapsed >= totalMs;

  const start = async () => {
    const offline = humans - online;
    const ok = await dialog.confirm(
      `${count}명으로 경주를 시작할까요?`,
      <>
        <p>참가 접수는 자동으로 마감되고, 5초 카운트다운 후 출발해요.</p>
        {offline > 0 && (
          <p className="warn">
            ⚠️ 참가자 {offline}명의 휴대폰이 지금 연결되어 있지 않아요. (화면이 꺼졌거나 앱을 닫았을 수 있어요. 경주에는
            그대로 출전해요.)
          </p>
        )}
      </>,
      { confirmLabel: '🏁 출발!' },
    );
    if (!ok) return;
    // 배포 직후 예전 관리자 화면에서 시작하지 않도록: 새 버전이 있으면 먼저 최신 화면으로 바꿈 (로그인 유지됨)
    if (isOutdated(await fetchLatestVersion())) {
      reloadToLatest();
      return;
    }
    await run('start', () => api.adminStartRace(token, ENGINE_VERSION, 5000), '경주를 시작했어요!');
  };

  const publish = () =>
    run(
      'publish',
      async () => {
        if (!sync.result || !sync.info) throw new BackendError('UNKNOWN', '경주 계산 결과가 없어요. 새로고침해 주세요.');
        if (!sync.tacticsComplete) throw new BackendError('UNKNOWN', '작전 기록을 받는 중이에요. 잠시 후 다시 눌러 주세요.');
        // 경주가 시작될 때의 엔진 버전 그대로 (서버가 경주 기록과 같은지 확인함)
        await api.adminPublish(token, sync.info.id, sync.info.engineVersion, sync.result.hash, sync.result.standings);
      },
      '결과를 공개했어요.',
    );

  const abort = async () => {
    if (
      await dialog.confirm('경주를 중단할까요?', '결과 없이 대기실로 돌아가요. (기록에는 "중단"으로 남아요)', {
        confirmLabel: '⛔ 중단',
        danger: true,
      })
    )
      await run('abort', () => api.adminAbort(token), '경주를 중단했어요.');
  };

  return (
    <section className="admin-card wide race-control">
      <h2>경주 진행</h2>
      {!race ? (
        <div className="row">
          <button className="cta big-btn" disabled={busy || count === 0} onClick={start}>
            🏁 경주 시작 ({count}명)
          </button>
          {count === 0 && <span className="muted">참가자가 최소 1명 있어야 해요.</span>}
        </div>
      ) : (
        <>
          <div className="race-status">
            <span className="big">
              {elapsed < 0 ? `출발 ${Math.ceil(-elapsed / 1000)}초 전` : formatTime(Math.min(elapsed, totalMs ?? elapsed))}
            </span>
            {totalMs !== null && <span className="muted">/ {formatTime(totalMs)}</span>}
            <span>
              {race.status === 'paused'
                ? raceOver
                  ? '⏸ 일시정지 중 — 결과를 공개하려면 먼저 ▶ 재개를 누르세요'
                  : '⏸ 일시정지 중'
                : race.status === 'finished'
                  ? '🏁 결과 공개됨'
                  : raceOver
                    ? '🏁 결승 완료 — 결과를 공개하세요'
                    : '🏇 진행 중'}
            </span>
          </div>
          <div className="row">
            {/* 결승 후엔 일시정지 버튼 숨김: 멈추면 결과 공개가 막혀서 헷갈림 */}
            {race.status === 'racing' && !raceOver && (
              <button className="big-btn" disabled={busy} onClick={() => run('pause', () => api.adminPause(token))}>
                ⏸ 일시정지
              </button>
            )}
            {race.status === 'paused' && (
              <button className="cta big-btn" disabled={busy} onClick={() => run('resume', () => api.adminResume(token))}>
                ▶ 재개
              </button>
            )}
            {race.status === 'racing' && (
              <button className={`big-btn ${raceOver ? 'cta pulse-btn' : ''}`} disabled={busy || !raceOver || !sync.result || !sync.tacticsComplete} onClick={publish}>
                📣 결과 공개
              </button>
            )}
            {race.status === 'finished' && (
              <button
                className="cta big-btn"
                disabled={busy}
                onClick={() => run('next', () => api.adminNextRound(token), '다음 라운드 준비 완료 (같은 참가자, 접수는 마감 상태)')}
              >
                ➡ 다음 라운드
              </button>
            )}
            {race.status !== 'finished' && (
              <button className="danger" disabled={busy} onClick={abort}>
                ⛔ 비상 중단
              </button>
            )}
          </div>
          {sync.engineMismatch && <p className="muted pulse">최신 화면 불러오는 중…</p>}
          {report && (
            <p className="muted">
              결과 일치 확인: 휴대폰 <b>{report.reports}</b>/{humans}대 보고
              {report.officialHash && (
                <>
                  {' '}
                  · 공식 결과와 일치 <b className={report.matching === report.reports ? 'ok' : 'err'}>{report.matching}</b>대
                  {report.matching < report.reports && ' ⚠️ 일부 기기 계산이 달라요 (그 기기들도 공식 결과로 표시됨)'}
                </>
              )}
            </p>
          )}
        </>
      )}
    </section>
  );
}

// ─────────────────────────────── 접수 · 설정 ───────────────────────────────

function RegistrationCard({
  lobby,
  raceActive,
  busy,
  run,
  token,
}: {
  lobby: NonNullable<ReturnType<typeof useLobby>['data']>;
  raceActive: boolean;
  busy: boolean;
  run: Run;
  token: string;
}) {
  const api = getBackend();
  const [maxIn, setMaxIn] = useState(String(lobby.maxPlayers));
  const [secIn, setSecIn] = useState(String(lobby.raceSeconds));
  const dirty = maxIn !== String(lobby.maxPlayers) || secIn !== String(lobby.raceSeconds);

  return (
    <section className="admin-card">
      <h2>참가 접수</h2>
      <div className="row">
        <button
          disabled={busy || raceActive || lobby.phase === 'lobby'}
          onClick={() => run('open', () => api.adminSetPhase(token, 'lobby'), '참가 접수를 열었어요.')}
        >
          🔓 접수 열기
        </button>
        <button
          disabled={busy || raceActive || lobby.phase !== 'lobby'}
          onClick={() => run('close', () => api.adminSetPhase(token, 'closed'), '참가를 마감했어요.')}
        >
          🔒 참가 마감
        </button>
      </div>
      {raceActive && <p className="small muted">경주 중에는 바꿀 수 없어요.</p>}
      <h2>설정</h2>
      <div className="row">
        <label>
          정원
          <input type="number" inputMode="numeric" min={1} max={20} value={maxIn} onChange={(e) => setMaxIn(e.target.value)} />명
        </label>
        <label>
          경주
          <input type="number" inputMode="numeric" min={30} max={180} step={5} value={secIn} onChange={(e) => setSecIn(e.target.value)} />초
        </label>
        <button
          className={dirty ? 'cta' : ''}
          disabled={busy || !dirty}
          onClick={() => run('settings', () => api.adminUpdateSettings(token, Number(maxIn) || null, Number(secIn) || null), '설정을 저장했어요.')}
        >
          저장
        </button>
      </div>
      <p className="small muted">정원 1~20명 · 경주 30~180초 (1등 도착 기준). 다음 경주부터 적용.</p>
    </section>
  );
}

// ─────────────────────────────── 리허설 ───────────────────────────────

function RehearsalCard({
  raceActive,
  bots,
  busy,
  run,
  token,
  dialog,
}: {
  raceActive: boolean;
  bots: number;
  busy: boolean;
  run: Run;
  token: string;
  dialog: Dialog;
}) {
  const api = getBackend();
  return (
    <section className="admin-card">
      <h2>🤖 리허설 (테스트봇)</h2>
      <p className="small muted">
        가상 참가자로 행사 전 점검. 전원 봇인 경주는 기록에 "리허설"로 표시돼요. 실제 참가자와 섞어서 써도 돼요.
      </p>
      <div className="row">
        {[1, 10].map((n) => (
          <button key={n} disabled={busy || raceActive} onClick={() => run('bots', () => api.adminAddBots(token, n), `테스트봇을 추가했어요.`)}>
            +{n}
          </button>
        ))}
        <button disabled={busy || raceActive} onClick={() => run('bots', () => api.adminAddBots(token, 50), '정원까지 채웠어요.')}>
          정원까지 채우기
        </button>
      </div>
      <div className="row">
        <button
          disabled={busy || raceActive || bots === 0}
          onClick={async () => {
            if (await dialog.confirm(`테스트봇 ${bots}명을 삭제할까요?`, '실제 참가자는 그대로 남아요.', { confirmLabel: '봇 삭제' }))
              await run('rmbots', async () => {
                const n = await api.adminRemoveBots(token);
                return n;
              }, '테스트봇을 삭제했어요.');
          }}
        >
          🧹 테스트봇만 삭제 ({bots})
        </button>
      </div>
    </section>
  );
}

// ─────────────────────────────── 상태 점검 ───────────────────────────────

function StatusCard({ liveStatus }: { liveStatus: string }) {
  const [check, setCheck] = useState<{ ms: number[]; at: number } | null>(null);
  const [checking, setChecking] = useState(false);

  const measure = async () => {
    setChecking(true);
    const ms: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      try {
        await getBackend().serverTime();
        ms.push(performance.now() - t0);
      } catch {
        ms.push(Number.NaN);
      }
    }
    await serverTime.sync();
    setCheck({ ms, at: Date.now() });
    setChecking(false);
  };

  const ok = check?.ms.filter((x) => Number.isFinite(x)) ?? [];
  const median = ok.length ? [...ok].sort((a, b) => a - b)[Math.floor(ok.length / 2)]! : null;
  const failed = check ? check.ms.length - ok.length : 0;

  return (
    <section className="admin-card">
      <h2>🩺 상태 점검</h2>
      <ul className="status-list">
        <li>
          서버 연결: <b className={liveStatus === 'ok' ? 'ok' : 'err'}>{liveStatus === 'ok' ? '정상' : liveStatus === 'offline' ? '인터넷 끊김' : '재연결 중'}</b>
        </li>
        <li>
          시계 보정: {serverTime.isReady() ? `${Math.round(serverTime.getOffset())}ms (왕복 ${Math.round(serverTime.lastRtt)}ms)` : '측정 중'}
        </li>
        {check && (
          <li>
            서버 응답: {median !== null ? <b className={median < 300 ? 'ok' : 'warn'}>{Math.round(median)}ms</b> : '—'}
            {failed > 0 && <b className="err"> · 실패 {failed}/5</b>}
          </li>
        )}
      </ul>
      <button className="ghost" disabled={checking} onClick={measure}>
        {checking ? '측정 중…' : '지금 점검'}
      </button>
      <div className="emergency-tip">
        <b>🚨 비상 대비 (행사 시작 전에 꼭)</b>
        <p className="small">
          인터넷이 끊기면 비상 페이지를 <b>새로 열 수 없어요</b>. 프로젝터 PC에서 대형 화면(/screen)을 띄운 뒤, 같은 브라우저에서 비상 페이지를
          <b> 새 탭으로 미리 열어 두세요</b>. 그 탭은 대형 화면이 저장한 최신 참가자 명단을 자동으로 받아 둬요.
        </p>
        <p className="small muted">
          · 경주 도중 끊기면: 대형 화면이 이미 받은 경주를 끝까지 재생해요 (비상 모드 불필요).
          <br />· 경주 전에 서버가 멈추면: 비상 탭에서 "시작" → 저장된 명단으로 새 경주 (휴대폰 연동·결과 저장 없음).
        </p>
        <a className="btn-like" href="/demo?cached=1" target="_blank" rel="noreferrer">
          비상 페이지 새 탭으로 열기 ↗
        </a>
      </div>
    </section>
  );
}

// ─────────────────────────────── 참가자 ───────────────────────────────

function PeopleCard({
  people,
  raceActive,
  busy,
  run,
  token,
  dialog,
}: {
  people: AdminPerson[] | null;
  raceActive: boolean;
  busy: boolean;
  run: Run;
  token: string;
  dialog: Dialog;
}) {
  const api = getBackend();
  const [shown, setShown] = useState<number | null>(null);
  const [filter, setFilter] = useState<'all' | 'offline' | 'bots'>('all');
  const list = (people ?? []).filter((p) => (filter === 'offline' ? !p.isTest && !p.online : filter === 'bots' ? p.isTest : true));

  return (
    <section className="admin-card wide">
      <h2>
        참가자 {people?.length ?? 0}명
        <span className="seg">
          {(
            [
              ['all', '전체'],
              ['offline', '연결 끊김'],
              ['bots', '봇'],
            ] as const
          ).map(([k, label]) => (
            <button key={k} className={`small ${filter === k ? 'cta' : 'ghost'}`} onClick={() => setFilter(k)}>
              {label}
            </button>
          ))}
        </span>
      </h2>
      <p className="small muted">🟢 접속 중 · ⚪ 최근 75초간 연결 없음 · 🤖 테스트봇. 복구코드는 다른 브라우저로 옮기려는 참가자에게 알려 주세요.</p>
      <div className="admin-people">
        {list.map((p) => {
          const c = horseColor(p.horseNo);
          return (
            <div key={p.id} className={`person ${p.isTest ? 'bot' : ''}`}>
              <span className="chip" style={{ background: hex(c), color: textOn(c) }}>
                {p.horseNo}
              </span>
              <span className="dot" title={p.isTest ? '테스트봇' : p.online ? '접속 중' : '연결 없음'}>
                {p.isTest ? '🤖' : p.online ? '🟢' : '⚪'}
              </span>
              <span className="pname">{p.nickname}</span>
              {!p.isTest && (
                <button className="link small" onClick={() => setShown(shown === p.horseNo ? null : p.horseNo)}>
                  {shown === p.horseNo ? <span className="mono">{p.recoveryCode}</span> : '코드'}
                </button>
              )}
              {p.recoveryFails >= 5 && (
                <button
                  className="link small"
                  disabled={busy}
                  onClick={() => run('unlock', () => api.adminUnlockRecovery(token, p.horseNo), `${p.horseNo}번 복구 잠금을 풀었어요.`)}
                >
                  🔓잠금해제
                </button>
              )}
              {!raceActive && (
                <button
                  className="link danger small"
                  disabled={busy}
                  aria-label={`${p.horseNo}번 내보내기`}
                  onClick={async () => {
                    if (
                      await dialog.confirm(`${p.horseNo}번 ${p.nickname}을(를) 내보낼까요?`, '중복 참가·부적절한 닉네임 정리용이에요. 내보낸 사람도 그 휴대폰으로 다시 참가할 수 있어요 (접수 마감 중에도, 정원 안에서).', {
                        confirmLabel: '내보내기',
                        danger: true,
                      })
                    )
                      await run('kick', () => api.adminRemoveParticipant(token, p.horseNo), `${p.horseNo}번을 내보냈어요.`);
                  }}
                >
                  ✕
                </button>
              )}
            </div>
          );
        })}
        {people && list.length === 0 && <p className="muted">해당하는 참가자가 없어요.</p>}
      </div>
    </section>
  );
}

// ─────────────────────────────── 기록 ───────────────────────────────

function toCsv(standings: FinishRecord[]): string {
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const rows = [...standings]
    .sort((a, b) => a.rank - b.rank)
    .map((s) => [s.rank, s.id, esc(s.name), s.finishMs === null ? '' : (s.finishMs / 1000).toFixed(2)].join(','));
  return '﻿' + ['순위,말번호,닉네임,기록(초)', ...rows].join('\r\n'); // BOM: 엑셀 한글 깨짐 방지
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function HistoryCard({ token, onAuthLost }: { token: string; onAuthLost: () => void }) {
  const api = getBackend();
  const [history, setHistory] = useState<RaceHistoryItem[] | null>(null);
  const [detail, setDetail] = useState<RaceDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const handle = (e: unknown) => {
    if (e instanceof BackendError && e.code === 'ADMIN_AUTH') onAuthLost();
    else setErr(errorText(e));
  };
  const load = () => api.adminRaceHistory(token).then(setHistory, handle);
  const open = (id: string) => api.adminRaceDetail(token, id).then(setDetail, handle);

  return (
    <section className="admin-card wide">
      <h2>
        📜 경주 기록
        <button className="ghost small" onClick={load}>
          {history ? '새로고침' : '불러오기'}
        </button>
      </h2>
      {err && <p className="err">{err}</p>}
      {history && history.length === 0 && <p className="muted">아직 경주 기록이 없어요.</p>}
      {history && history.length > 0 && (
        <table className="history">
          <thead>
            <tr>
              <th>시각</th>
              <th>라운드</th>
              <th>상태</th>
              <th>인원</th>
              <th>🏆 1등</th>
              <th>🥈 2등</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {history.map((h) => (
              <tr key={h.id} className={h.isTest ? 'test-row' : ''}>
                <td>{new Date(h.createdAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}</td>
                <td>
                  {h.roundNo}
                  {h.isTest && <span className="tag">리허설</span>}
                </td>
                <td>{{ racing: '진행', paused: '정지', finished: '완료', aborted: '중단' }[h.status]}</td>
                <td>{h.entrantCount}</td>
                <td>{h.winner ?? '—'}</td>
                <td>{h.runnerUp ?? '—'}</td>
                <td>
                  <button className="link small" onClick={() => open(h.id)}>
                    상세
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {detail && (
        <div className="dialog-backdrop" onClick={() => setDetail(null)}>
          <div className="dialog wide-dialog" role="dialog" aria-label="경주 상세" onClick={(e) => e.stopPropagation()}>
            <h2>
              {detail.race.roundNo}라운드 {detail.isTest && <span className="tag">리허설</span>}
            </h2>
            <p className="small muted">
              {new Date(detail.createdMs).toLocaleString('ko-KR')} · {detail.race.entrants.length}명 · 경주 {detail.race.raceSeconds}초 · 시드{' '}
              {detail.race.seed}
              {detail.race.resultHash && (
                <>
                  {' '}
                  · 해시 <span className="mono">{detail.race.resultHash}</span> · 휴대폰 일치 {detail.matching}/{detail.reports}
                </>
              )}
            </p>
            {detail.race.standings ? (
              <>
                <ol className="detail-list">
                  {[...detail.race.standings]
                    .sort((a, b) => a.rank - b.rank)
                    .map((s) => (
                      <li key={s.id} className={s.rank <= 2 ? `top${s.rank}` : ''}>
                        <span className="r">{s.rank}</span>
                        <span className="chip" style={{ background: hex(horseColor(s.id)), color: textOn(horseColor(s.id)) }}>
                          {s.id}
                        </span>
                        <span className="n">{s.name}</span>
                        <span className="t">{s.finishMs === null ? '—' : `${(s.finishMs / 1000).toFixed(2)}초`}</span>
                      </li>
                    ))}
                </ol>
                <div className="row">
                  <button
                    className="cta"
                    onClick={() =>
                      download(
                        `붉은말_${detail.race.roundNo}라운드_${new Date(detail.createdMs).toISOString().slice(0, 16).replace(/[:T]/g, '')}.csv`,
                        toCsv(detail.race.standings!),
                      )
                    }
                  >
                    ⬇ 순위표 CSV
                  </button>
                  <button className="ghost" onClick={() => setDetail(null)}>
                    닫기
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="muted">공개된 결과가 없는 경주예요 ({detail.race.status === 'aborted' ? '중단됨' : '진행 중'}).</p>
                <button className="ghost" onClick={() => setDetail(null)}>
                  닫기
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

// ─────────────────────────────── 위험 구역 ───────────────────────────────

function DangerCard({ busy, run, token, dialog }: { busy: boolean; run: Run; token: string; dialog: Dialog }) {
  const api = getBackend();
  return (
    <section className="admin-card wide danger-zone">
      <h2>⚠️ 위험 구역</h2>
      <div className="row">
        <button
          className="danger"
          disabled={busy}
          onClick={async () => {
            if (
              await dialog.confirm(
                '전체 초기화',
                '참가자(실제 참가자 포함)를 모두 지우고 1라운드·접수 시작 상태로 돌아가요. 지난 경주 기록은 남아요. 되돌릴 수 없어요.',
                { confirmLabel: '🧨 전체 초기화', danger: true, requireText: '초기화' },
              )
            )
              await run('reset', () => api.adminResetAll(token), '전체 초기화했어요.');
          }}
        >
          🧨 전체 초기화
        </button>
        <button
          className="ghost"
          disabled={busy}
          onClick={async () => {
            const pw = await dialog.prompt('새 관리자 비밀번호', { type: 'password', placeholder: '8자 이상', minLength: 8 }, '바꾸면 다른 기기의 관리자 로그인은 모두 끊겨요.', '변경');
            if (pw) await run('pw', () => api.adminChangePassword(token, pw), '비밀번호를 바꿨어요.');
          }}
        >
          🔑 비밀번호 변경
        </button>
      </div>
    </section>
  );
}
