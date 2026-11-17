import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ConnBanner } from '../components/ConnBanner';
import { HorseBadge } from '../components/HorseBadge';
import { RacePanel } from '../components/RacePanel';
import { hex, horseColor } from '../game/palette';
import { BackendError, errorText, getBackend, type Lobby, type MyEntry } from '../lib/backend';
import { getToken, loadCachedMe, saveCachedMe, storagePersistent } from '../lib/identity';
import { NICKNAME_MAX, nicknameProblem } from '../lib/nickname';
import { useLobby } from '../lib/useLive';
import { useAutoReloadOnEngineMismatch, useRaceSync, useServerTimeSync, useWakeLock, type RaceSync } from '../lib/useRace';

const isInApp = /KAKAOTALK|Instagram|FBAN|FBAV|NAVER|Line\//i.test(navigator.userAgent);

/**
 * 참가자 화면 (QR 코드 도착지).
 * 새로고침해도: 기기 토큰으로 서버에서 내 정보를 다시 받아옴.
 * 서버 응답 전/오프라인: 마지막으로 확인된 정보(캐시)를 먼저 보여줌.
 */
export function Play() {
  const backend = getBackend();
  const token = useMemo(() => getToken(), []);
  const [me, setMe] = useState<MyEntry | null>(() => loadCachedMe());
  const [verified, setVerified] = useState(false);
  const [bootError, setBootError] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /** 진행자에게 내보내진 기기 → 접수 마감 중에도 다시 참가 가능 */
  const [rejoin, setRejoin] = useState(false);
  const { data: lobby, status } = useLobby();
  const sync = useRaceSync(lobby);
  useServerTimeSync();
  useAutoReloadOnEngineMismatch(sync);
  // 참가했으면 화면이 꺼지지 않게 (경주를 놓치지 않도록)
  useWakeLock(!!me);

  const meRef = useRef(me);
  const applyMe = useCallback((m: MyEntry | null) => {
    meRef.current = m;
    setMe(m);
    saveCachedMe(m);
  }, []);

  const verify = useCallback(async () => {
    try {
      const m = await backend.me(token);
      const canRejoin = m ? false : await backend.canRejoin(token).catch(() => false);
      setRejoin(canRejoin);
      if (meRef.current && !m) {
        setNotice(
          canRejoin
            ? '진행자가 참가 목록에서 정리했어요. 아래에서 다시 참가할 수 있어요 (다음 경주부터 출전).'
            : '이 기기의 참가 정보가 없어졌어요. (다른 기기로 옮겼거나 진행자가 초기화했어요) 다시 참가해 주세요.',
        );
      }
      applyMe(m);
      setVerified(true);
      setBootError(false);
    } catch {
      setBootError(true);
    }
  }, [backend, token, applyMe]);

  // 첫 확인 + 30초마다 재확인(진행자 초기화 반영) + 화면 복귀 시 재확인
  useEffect(() => {
    void verify();
    const id = setInterval(() => void verify(), 30_000 + Math.random() * 5000);
    const onVis = () => document.visibilityState === 'visible' && void verify();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [verify]);

  let body;
  if (me) {
    body = (
      <MyCard
        me={me}
        lobby={lobby}
        onLeft={() => {
          applyMe(null);
          setNotice('참가를 취소했어요. 다시 참가할 수 있어요.');
        }}
        token={token}
        verified={verified}
        sync={sync}
        onUpdated={applyMe}
      />
    );
  } else if (!verified) {
    body = (
      <div className="play-card center">
        {bootError ? (
          <>
            <p>서버에 연결하지 못했어요.</p>
            <button onClick={() => void verify()}>다시 시도</button>
          </>
        ) : (
          <p className="pulse">연결 중…</p>
        )}
      </div>
    );
  } else {
    body = (
      <JoinForm
        token={token}
        lobby={lobby}
        rejoin={rejoin}
        onJoined={(m) => {
          setNotice(null);
          setRejoin(false);
          applyMe(m);
        }}
      />
    );
  }

  return (
    <main className="play">
      <ConnBanner status={status} />
      <header className="play-head">
        <h1>붉은 말의 대질주</h1>
        {lobby && (
          <div className="play-count" aria-live="polite">
            🐎 <b>{lobby.count}</b> / {lobby.maxPlayers}명 참가 중
          </div>
        )}
      </header>
      {notice && (
        <div className="play-notice" role="alert">
          {notice}
          <button className="ghost small" onClick={() => setNotice(null)}>
            닫기
          </button>
        </div>
      )}
      {body}
    </main>
  );
}

// ─────────────────────────────── 참가 신청 ───────────────────────────────

function JoinForm({
  token,
  lobby,
  rejoin,
  onJoined,
}: {
  token: string;
  lobby: Lobby | null;
  rejoin: boolean;
  onJoined: (m: MyEntry) => void;
}) {
  const [nick, setNick] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recoverMode, setRecoverMode] = useState(false);
  const busyRef = useRef(false);
  const problem = nicknameProblem(nick);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (problem || busyRef.current) return; // 연타 방지
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      onJoined(await getBackend().join(token, nick));
    } catch (err) {
      setError(errorText(err));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  if (recoverMode) return <RecoverForm token={token} onDone={onJoined} onCancel={() => setRecoverMode(false)} />;

  // 내보내진 기기는 접수가 마감돼도 다시 참가 가능 (정원은 지킴)
  const closed = lobby && lobby.phase !== 'lobby' && !rejoin;
  const full = lobby && !closed && lobby.count >= lobby.maxPlayers;

  return (
    <section className="play-card">
      {closed ? (
        <div className="center">
          <div className="big-emoji">🚧</div>
          <h2>지금은 참가 접수 중이 아니에요</h2>
          <p className="muted">
            {lobby && lobby.phase !== 'closed'
              ? '경주가 진행 중이에요. 진행자가 접수를 다시 열면 이 화면에서 바로 참가할 수 있어요 (새로고침 안 해도 돼요).'
              : '진행자가 접수를 열면 이 화면에서 바로 참가할 수 있어요 (새로고침 안 해도 돼요).'}
          </p>
        </div>
      ) : full ? (
        <div className="center">
          <div className="big-emoji">🈵</div>
          <h2>정원({lobby.maxPlayers}명)이 다 찼어요</h2>
          <p className="muted">대형 화면에서 경주를 함께 즐겨 주세요!</p>
        </div>
      ) : (
        <form onSubmit={submit} noValidate>
          <h2>{rejoin ? '다시 참가하기' : '내 말 등록하기'}</h2>
          {rejoin && lobby && lobby.phase !== 'lobby' && (
            <p className="muted small">지금 경주가 진행 중이면 다음 경주부터 함께 달려요.</p>
          )}
          <label htmlFor="nick" className="muted">
            닉네임 (경주 화면에 표시돼요)
          </label>
          <input
            id="nick"
            className="nick-input"
            value={nick}
            onChange={(e) => setNick(e.target.value)}
            onBlur={() => setTouched(true)}
            maxLength={NICKNAME_MAX + 6 /* 앞뒤 공백 여유. 실제 제한은 검증에서 */}
            autoComplete="off"
            autoCapitalize="off"
            enterKeyHint="go"
            placeholder="예: 번개돌이"
            aria-invalid={touched && !!problem}
            disabled={busy}
          />
          <div className="field-hint">
            {touched && problem ? <span className="err">{problem}</span> : <span>한글·영문·숫자 {NICKNAME_MAX}자 이내</span>}
          </div>
          {error && <p className="err">{error}</p>}
          <button type="submit" className="cta" disabled={busy || (touched && !!problem)}>
            {busy ? '등록 중…' : '🐎 참가하기'}
          </button>
        </form>
      )}
      <button className="link" onClick={() => setRecoverMode(true)}>
        이미 참가했는데 다른 브라우저로 열렸나요?
      </button>
      {isInApp && (
        <p className="muted small">
          💡 카카오톡 등 앱 안의 브라우저에서도 잘 작동해요. 같은 창에서 계속 이용해 주세요.
        </p>
      )}
    </section>
  );
}

function RecoverForm({ token, onDone, onCancel }: { token: string; onDone: (m: MyEntry) => void; onCancel: () => void }) {
  const [no, setNo] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const n = Number(no);
    if (!Number.isInteger(n) || n < 1 || n > 50 || code.trim().length !== 6) {
      setError('번호(1~50)와 6자리 복구코드를 입력해 주세요.');
      return;
    }
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      onDone(await getBackend().recover(n, code, token));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="play-card" onSubmit={submit}>
      <h2>다른 브라우저에서 이어하기</h2>
      <p className="muted small">처음 참가했던 화면에 있던 내 말 번호와 복구코드를 입력하세요.</p>
      <label className="muted">
        말 번호
        <input inputMode="numeric" value={no} onChange={(e) => setNo(e.target.value.replace(/\D/g, '').slice(0, 2))} />
      </label>
      <label className="muted">
        복구코드 (6자리)
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6))}
          autoCapitalize="characters"
          autoComplete="off"
          className="code-input"
        />
      </label>
      {error && <p className="err">{error}</p>}
      <button type="submit" className="cta" disabled={busy}>
        {busy ? '확인 중…' : '이 기기로 가져오기'}
      </button>
      <button type="button" className="link" onClick={onCancel}>
        ← 새로 참가하기
      </button>
    </form>
  );
}

// ─────────────────────────────── 내 말 / 대기실 ───────────────────────────────

const PHASE_TEXT: Record<string, { emoji: string; title: string; desc: string }> = {
  lobby: { emoji: '⏳', title: '참가 완료!', desc: '경주가 시작될 때까지 기다려 주세요. 이 화면을 켜 두세요.' },
  closed: { emoji: '🔒', title: '참가 마감', desc: '곧 경주가 시작돼요! 대형 화면을 봐 주세요.' },
  countdown: { emoji: '🚦', title: '곧 출발!', desc: '대형 화면을 봐 주세요!' },
  racing: { emoji: '🏇', title: '경주 중!', desc: '대형 화면에서 내 말을 응원하세요!' },
  paused: { emoji: '⏸', title: '잠시 멈춤', desc: '곧 다시 시작해요.' },
  finished: { emoji: '🏁', title: '경주 종료', desc: '대형 화면에서 결과를 확인하세요!' },
};

function MyCard({
  me,
  lobby,
  token,
  verified,
  onLeft,
  sync,
  onUpdated,
}: {
  me: MyEntry;
  lobby: Lobby | null;
  token: string;
  verified: boolean;
  onLeft: () => void;
  sync: RaceSync;
  onUpdated: (m: MyEntry) => void;
}) {
  const [leaving, setLeaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const phase = PHASE_TEXT[lobby?.phase ?? 'lobby']!;
  const color = hex(horseColor(me.horseNo));

  const leave = async () => {
    if (!confirm(`${me.horseNo}번 ${me.nickname} 참가를 취소할까요?`)) return;
    setLeaving(true);
    setError(null);
    try {
      await getBackend().leave(token);
      onLeft();
    } catch (err) {
      setError(err instanceof BackendError && err.code === 'REGISTRATION_CLOSED' ? '이미 마감되어 취소할 수 없어요.' : errorText(err));
    } finally {
      setLeaving(false);
    }
  };

  return (
    <section className="play-card my-card" style={{ ['--horse' as string]: color }}>
      {me.renamed && (
        <p className="play-notice small">같은 닉네임이 있어서 <b>{me.nickname}</b>(으)로 등록했어요.</p>
      )}
      <div className="my-horse">
        <HorseBadge no={me.horseNo} size={180} />
      </div>
      <div className="my-no">{me.horseNo}번</div>
      <div className="my-name">{me.nickname}</div>

      {sync.meta && sync.meta.status !== 'aborted' ? (
        <RacePanel sync={sync} myNo={me.horseNo} token={token} />
      ) : (
        <div className={`phase-box phase-${lobby?.phase ?? 'lobby'}`}>
          <div className="phase-emoji">{phase.emoji}</div>
          <div>
            <b>{phase.title}</b>
            <div className="small">{phase.desc}</div>
          </div>
        </div>
      )}

      <details className="recovery">
        <summary>🔑 복구코드 {storagePersistent ? '' : '(꼭 저장하세요!)'}</summary>
        <p className="small muted">
          다른 브라우저/기기로 옮길 때 필요해요. 화면을 캡처해 두세요.
        </p>
        <div className="code-box">
          {me.horseNo}번 · <b>{me.recoveryCode}</b>
        </div>
      </details>

      {!verified && <p className="small muted">마지막으로 확인된 정보를 보여주는 중이에요.</p>}
      {error && <p className="err">{error}</p>}
      {/* 경주 시작 전(대기실·마감·라운드 사이)에는 언제든 닉네임 변경 */}
      {(lobby?.phase === 'lobby' || lobby?.phase === 'closed') &&
        (editing ? (
          <RenameForm
            token={token}
            current={me.nickname}
            onDone={(m) => {
              setEditing(false);
              onUpdated(m);
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <button className="link" onClick={() => setEditing(true)}>
            ✏️ 닉네임 바꾸기
          </button>
        ))}
      {lobby?.phase === 'lobby' && !editing && (
        <button className="link danger" onClick={leave} disabled={leaving}>
          {leaving ? '취소 중…' : '참가 취소'}
        </button>
      )}
    </section>
  );
}

function RenameForm({
  token,
  current,
  onDone,
  onCancel,
}: {
  token: string;
  current: string;
  onDone: (m: MyEntry) => void;
  onCancel: () => void;
}) {
  const [nick, setNick] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = nicknameProblem(nick);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (problem || busy) return;
    if (nick.trim() === current) return onCancel();
    setBusy(true);
    setError(null);
    try {
      onDone(await getBackend().rename(token, nick));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="rename-form" onSubmit={submit} noValidate>
      <input
        className="nick-input"
        value={nick}
        onChange={(e) => setNick(e.target.value)}
        maxLength={NICKNAME_MAX + 6}
        autoComplete="off"
        autoCapitalize="off"
        enterKeyHint="done"
        aria-label="새 닉네임"
        aria-invalid={!!problem}
        disabled={busy}
        autoFocus
      />
      <div className="field-hint">{problem ? <span className="err">{problem}</span> : <span>한글·영문·숫자 {NICKNAME_MAX}자 이내</span>}</div>
      {error && <p className="err">{error}</p>}
      <div className="rename-actions">
        <button type="submit" className="cta" disabled={busy || !!problem}>
          {busy ? '바꾸는 중…' : '저장'}
        </button>
        <button type="button" className="ghost" onClick={onCancel} disabled={busy}>
          취소
        </button>
      </div>
    </form>
  );
}
