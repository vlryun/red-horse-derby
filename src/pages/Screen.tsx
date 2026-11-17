import QRCode from 'qrcode';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ConnBanner } from '../components/ConnBanner';
import { ResultsBoard } from '../components/ResultsBoard';
import { SoundToggle } from '../components/SoundToggle';
import { Stage16x9 } from '../components/Stage16x9';
import { hex, horseColor, textOn } from '../game/palette';
import { PhaserRace } from '../game/PhaserRace';
import { sfx } from '../game/sfx';
import type { Phase } from '../lib/backend';
import { isLocalhost, joinUrl } from '../lib/env';
import { useBlockAutoUpdate } from '../lib/appUpdate';
import { saveRoster } from '../lib/rosterCache';
import { useLobby, useParticipants, type ConnStatus } from '../lib/useLive';
import { useAutoReloadOnEngineMismatch, useRaceSync, useServerTimeSync, useWakeLock } from '../lib/useRace';

const PHASE_LABEL: Record<Phase, string> = {
  lobby: '참가 접수 중',
  closed: '참가 마감',
  countdown: '출발 준비',
  racing: '경주 중',
  paused: '일시정지',
  finished: '경주 종료',
};

/** 아직 서버 값을 못 받았을 때: 숫자(0명·정원)를 지어내지 않고 상태만 보여준다 */
function ScreenMessage({ status }: { status: ConnStatus }) {
  const text = status === 'offline' ? '📵 연결이 끊겼습니다' : status === 'reconnecting' ? '🔄 다시 연결 중…' : '참가 정보 불러오는 중…';
  return (
    <Stage16x9>
      <div className="lobby screen-msg">
        <header className="lobby-head">
          <h1>붉은 말의 대질주</h1>
        </header>
        <div className="screen-msg-body">
          <div className={status === 'ok' ? 'pulse' : ''}>{text}</div>
          {status !== 'ok' && (
            <div className="screen-msg-hint">
              연결이 계속 안 되면: 미리 열어 둔 <b>비상 모드 탭</b>(/demo?cached=1)으로 전환해 저장된 명단으로 경주하세요.
            </div>
          )}
        </div>
      </div>
    </Stage16x9>
  );
}

/**
 * 행사장 대형 화면.
 *  - 서버 값 받기 전: "참가 정보 불러오는 중…" / 연결 실패 시 "연결이 끊겼습니다"·"다시 연결 중…"
 *  - 경주 없음: QR + 실시간 참가자 판 (정원·인원은 서버 설정 기준)
 *  - 경주 있음: 서버 시각에 맞춰 경주 재생 (새로고침해도 현재 장면에서 이어짐,
 *    도중에 인터넷이 끊겨도 이미 받은 경주는 끝까지 재생)
 *  - 결과 공개됨: 서버의 공식 결과표
 * 조작은 /admin 에서. 이 화면은 보여주기만 한다.
 */
export function Screen() {
  const { data: lobby, status: lobbyStatus } = useLobby();
  const sync = useRaceSync(lobby);
  useServerTimeSync();
  useAutoReloadOnEngineMismatch(sync);
  useWakeLock(true);

  const raceVisible = !!sync.meta && sync.meta.status !== 'aborted';
  // 경주 화면(Phaser + 3D)은 처음부터 한 번만 만들어 대기 화면 뒤에 숨겨 둠 →
  // 경주가 시작되면 준비 시간 없이 카운트다운 첫 순간부터 같은 3D 경기장이 보임
  const showRace = raceVisible && !sync.engineMismatch;
  const [presentedFor, setPresentedFor] = useState<string | null>(null);
  const raceIdRef = useRef<string | null>(null);
  raceIdRef.current = sync.info?.id ?? null;

  // 비상 대비: 경주 출전 명단을 이 PC 에 저장
  useEffect(() => {
    if (sync.info) saveRoster(sync.info.entrants, sync.info.raceSeconds, { kind: 'race', roundNo: sync.info.roundNo });
  }, [sync.info]);

  return (
    <>
      <div className="screen-page" style={{ visibility: showRace ? 'visible' : 'hidden' }} aria-hidden={!showRace}>
        <PhaserRace
          race={showRace ? sync.result : null}
          clock={showRace ? sync.clock : null}
          tactics={sync.tacticsOn}
          onPresentationDone={() => setPresentedFor(raceIdRef.current)}
        />
      </div>
      {!lobby ? (
        <ScreenMessage status={lobbyStatus} />
      ) : raceVisible ? (
        <RaceView sync={sync} conn={lobbyStatus} presented={!!sync.info && presentedFor === sync.info.id} />
      ) : (
        <LobbyView phase={lobby.phase} max={lobby.maxPlayers} raceSeconds={lobby.raceSeconds} lobbyStatus={lobbyStatus} />
      )}
      {lobby && <ConnBanner status={lobbyStatus} />}
      <SoundToggle />
    </>
  );
}

/** 경주 중 위에 덮는 것들 (불러오는 중 안내 · 결과표). 경주 그림 자체는 Screen 의 상시 PhaserRace 가 그림 */
function RaceView({ sync, conn, presented }: { sync: ReturnType<typeof useRaceSync>; conn: ConnStatus; presented: boolean }) {
  const [showBoard, setShowBoard] = useState(false);
  const [showLocalBoard, setShowLocalBoard] = useState(false);
  const raceId = sync.info?.id;

  // 공식 결과표는 "결과 공개" + 결승 연출(리플레이·세리머니)이 끝난 뒤 1.5초에.
  // 연출 완료 신호가 오지 않는 예외 상황(엔진 문제 등)에도 공개 후 15초면 반드시 표시.
  useEffect(() => {
    setShowBoard(false);
    setShowLocalBoard(false);
  }, [raceId]);
  // 타이머는 바뀌지 않는 값(결과 해시·참/거짓)에만 의존 → 3초마다 오는 상태 조회에 초기화되지 않음
  const officialHash = sync.official?.hash ?? null;
  const hasResult = !!sync.result;
  useEffect(() => {
    if (!officialHash) return;
    const t = setTimeout(() => setShowBoard(true), presented || !hasResult ? 1500 : 15000);
    return () => clearTimeout(t);
  }, [officialHash, presented, hasResult]);

  // 서버 연결이 끊긴 채 경주가 끝나면: 이 화면이 계산한 결과를 "연결 끊김" 표시와 함께 보여준다
  // (서버 공식 결과와 같은 시드·명단·엔진으로 계산한 것이라 순위는 동일. 연결이 돌아오면 공식 결과표로 바뀜)
  const disconnected = conn !== 'ok';
  // 경주 재생 중에는 자동 업데이트를 미룸 (결승 연출이 끝나면 반영)
  useBlockAutoUpdate(!!sync.result && !presented);
  useEffect(() => {
    if (officialHash || !presented || !disconnected) {
      setShowLocalBoard(false);
      return;
    }
    const t = setTimeout(() => setShowLocalBoard(true), 3000);
    return () => clearTimeout(t);
  }, [officialHash, presented, disconnected]);

  if (sync.engineMismatch) {
    // 자동으로 최신 화면으로 바뀌는 중 (useAutoReloadOnEngineMismatch). 사람이 할 일 없음
    return (
      <div className="screen-page">
        <div className="screen-loading pulse">최신 화면 불러오는 중…</div>
        {sync.official && <ResultsBoard standings={sync.official.standings} hash={sync.official.hash} official />}
      </div>
    );
  }

  return (
    <div className="screen-overlay">
      {!sync.result && <div className="screen-loading pulse">경주 정보를 받는 중…</div>}
      {showBoard && sync.official && (
        <ResultsBoard standings={sync.official.standings} hash={sync.official.hash} official onClose={() => setShowBoard(false)} />
      )}
      {!showBoard && showLocalBoard && sync.result && (
        <ResultsBoard
          standings={sync.result.standings}
          hash={sync.result.hash}
          note="📡 서버 연결이 끊겨 이 화면에서 계산한 결과예요. 서버와 같은 시드·명단·규칙으로 계산해 순위는 같고, 연결이 돌아오면 공식 결과표로 바뀌어요."
        />
      )}
    </div>
  );
}

function LobbyView({ phase, max, raceSeconds, lobbyStatus }: { phase: Phase; max: number; raceSeconds: number; lobbyStatus: ConnStatus }) {
  const { data: list, status: listStatus } = useParticipants();

  // 비상 대비: 참가자 명단을 이 PC 에 저장 (서버가 멈추면 /demo?cached=1 에서 사용)
  useEffect(() => {
    if (list) saveRoster(list.map((p) => ({ id: p.horseNo, name: p.nickname })), raceSeconds, { kind: 'lobby' });
  }, [list, raceSeconds]);
  const [qrSvg, setQrSvg] = useState('');
  const url = useMemo(() => joinUrl(), []);

  useEffect(() => {
    QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#1a0a0a', light: '#ffffff' } })
      .then(setQrSvg)
      .catch(() => setQrSvg(''));
  }, [url]);

  // 새로 들어온 참가자 강조
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!list) return;
    const ids = new Set(list.map((p) => p.id));
    if (seen.current) {
      const added = list.filter((p) => !seen.current!.has(p.id)).map((p) => p.id);
      if (added.length) {
        sfx.play('join');
        setFresh((f) => new Set([...f, ...added]));
        setTimeout(() => setFresh((f) => new Set([...f].filter((id) => !added.includes(id)))), 2500);
      }
    }
    seen.current = ids;
  }, [list]);

  // 명단을 아직 못 받았으면 숫자를 보여주지 않는다 ("0명"으로 오해 방지)
  if (!list) return <ScreenMessage status={listStatus !== 'ok' ? listStatus : lobbyStatus} />;

  const byNo = new Map(list.map((p) => [p.horseNo, p]));
  const count = list.length;
  // 정원(슬롯 수)은 서버 설정 기준. 정원이 줄었는데 기존 참가자 번호가 더 크면 그 번호까지 표시
  const slots = Math.max(max, ...list.map((p) => p.horseNo));

  return (
    <>
      <Stage16x9>
        <div className={`lobby ${slots <= 20 ? 'lobby-20' : ''}`}>
          <header className="lobby-head">
            <h1>붉은 말의 대질주</h1>
            <span className={`lobby-phase phase-${phase}`}>{PHASE_LABEL[phase]}</span>
          </header>

          <aside className="lobby-left">
            <div className="qr" dangerouslySetInnerHTML={{ __html: qrSvg }} aria-label="참가 QR 코드" />
            <div className="qr-caption">📱 카메라로 찍고 참가!</div>
            <div className="qr-url">{url.replace(/^https?:\/\//, '')}</div>
            <div className="lobby-count">
              <b>{count}</b>
              <span> / {max}명</span>
            </div>
            <div className="lobby-bar">
              <div style={{ width: `${Math.min(100, (count / max) * 100)}%` }} />
            </div>
          </aside>

          <section className="lobby-grid">
            {Array.from({ length: slots }, (_, i) => i + 1).map((no) => {
              const p = byNo.get(no);
              const c = horseColor(no);
              return (
                <div key={no} className={`slot ${p ? 'filled' : ''} ${p && fresh.has(p.id) ? 'pop' : ''}`}>
                  <span className="slot-no" style={p ? { background: hex(c), color: textOn(c) } : undefined}>
                    {no}
                  </span>
                  <span className="slot-name">{p?.nickname ?? ''}</span>
                </div>
              );
            })}
          </section>
        </div>
      </Stage16x9>
      {isLocalhost() && (
        <div className="warn-strip">
          ⚠️ 지금 주소가 localhost 라서 휴대폰이 QR로 접속할 수 없어요. PC의 네트워크 주소(npm run dev 출력의 Network)로 이 화면을 여세요.
        </div>
      )}
    </>
  );
}
