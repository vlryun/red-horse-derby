import { useEffect, useRef, useState } from 'react';
import {
  EVENT_SPECS,
  TRACK_LENGTH,
  activeEventsAtTick,
  positionAtTick,
  rankingAtTick,
  tickAt,
  type EventType,
} from '../engine';
import { hex, horseColor } from '../game/palette';
import { useBlockAutoUpdate } from '../lib/appUpdate';
import { getBackend } from '../lib/backend';
import { Celebrate } from './Celebrate';
import { TacticBox } from './TacticBox';
import type { RaceSync } from '../lib/useRace';

interface View {
  kind: 'countdown' | 'running' | 'paused' | 'arrived' | 'over';
  secondsLeft: number;
  rank: number;
  total: number;
  progress: number;
  leaderProgress: number;
  leaderName: string;
  event: EventType | null;
  /** 이벤트 고유 키 (같은 종류가 다시 와도 구분) */
  eventKey: string | null;
}

/**
 * 휴대폰 경주 화면: 내 순위 · 진행률 · 내 말에게 일어난 이벤트 · 최종 결과
 * 모든 값은 서버 시각 기준으로 이 기기에서 계산 (대형 화면과 같은 순간 같은 순위)
 */
export function RacePanel({ sync, myNo, token }: { sync: RaceSync; myNo: number; token: string }) {
  const { result, clock, official, info } = sync;
  const [view, setView] = useState<View | null>(null);
  const reported = useRef<string | null>(null);
  /** undefined = 아직 한 번도 확인 안 함 (새로고침 직후엔 진동하지 않기 위해) */
  const lastEventKey = useRef<string | null | undefined>(undefined);

  // 경주 진행 중에는 자동 업데이트를 미룸
  useBlockAutoUpdate(!!view && (view.kind === 'countdown' || view.kind === 'running' || view.kind === 'paused'));

  const lane = result ? result.entrants.findIndex((e) => e.id === myNo) : -1;
  const inRace = !!info && info.entrants.some((e) => e.id === myNo);

  useEffect(() => {
    if (!result || !clock) return;
    const n = result.entrants.length;
    const update = () => {
      const el = clock.elapsedMs();
      const tick = tickAt(result, el);
      const ranking = rankingAtTick(result, tick);
      const leader = ranking[0]!;
      const over = tick >= result.totalTicks;
      const myFinish = lane >= 0 ? result.finishTick[lane]! : -1;
      let kind: View['kind'] = 'running';
      if (el < 0) kind = 'countdown';
      else if (clock.isPaused()) kind = 'paused';
      else if (over) kind = 'over';
      else if (myFinish !== -1 && myFinish <= tick) kind = 'arrived';
      const ev = lane >= 0 ? activeEventsAtTick(result, tick).get(lane) : undefined;
      const eventKey = ev ? `${ev.type}:${ev.tick}` : null;

      // 내 말에게 새 이벤트가 생긴 "그 순간"에만 진동 (휴대폰 소리는 끔: 20대가 동시에 울리면 시끄러움)
      // 새로고침 직후 첫 확인(lastEventKey 미정)에는 울리지 않음
      if (eventKey && lastEventKey.current !== undefined && eventKey !== lastEventKey.current && kind === 'running') {
        try {
          navigator.vibrate?.(EVENT_SPECS[ev!.type].good ? [60, 40, 60] : [180]);
        } catch {
          /* 진동 미지원 */
        }
      }
      lastEventKey.current = eventKey;

      setView({
        kind,
        secondsLeft: Math.ceil(-el / 1000),
        rank: lane >= 0 ? ranking.indexOf(lane) + 1 : 0,
        total: n,
        progress: lane >= 0 ? Math.min(1, positionAtTick(result, tick, lane) / TRACK_LENGTH) : 0,
        leaderProgress: Math.min(1, positionAtTick(result, tick, leader) / TRACK_LENGTH),
        leaderName: result.entrants[leader]!.name,
        event: ev?.type ?? null,
        eventKey,
      });

      // 경주가 끝나면 내 계산 결과 해시를 서버에 보고 (경주당 1회, 몰리지 않게 0~3초 분산)
      if (over && lane >= 0 && info && reported.current !== info.id) {
        reported.current = info.id;
        const raceId = info.id;
        setTimeout(() => {
          void getBackend()
            .reportResult(token, raceId, result.hash, result.engineVersion)
            .catch(() => {});
        }, Math.random() * 3000);
      }
    };
    update();
    const id = setInterval(update, 200);
    return () => clearInterval(id);
  }, [result, clock, lane, info, token]);

  // ── 공식 결과 ──
  if (official) {
    const mine = official.standings.find((s) => s.id === myNo);
    const [first, second] = [...official.standings].sort((a, b) => a.rank - b.rank);
    return (
      <div className="race-panel">
        {mine && mine.rank <= 2 && info && <Celebrate raceId={info.id} rank={mine.rank as 1 | 2} />}
        {mine ? (
          <div className={`final-rank ${mine.rank <= 2 ? 'winner' : ''}`}>
            {mine.rank === 1 ? '🏆' : mine.rank === 2 ? '🥈' : '🏁'}
            <div className="final-label">최종 순위</div>
            <div className="final-num">
              {mine.rank}
              <small>위 / {official.standings.length}</small>
            </div>
            {mine.rank === 1 && <div className="final-cheer">우승 축하해요!</div>}
            {mine.rank === 2 && <div className="final-cheer">준우승 축하해요!</div>}
          </div>
        ) : (
          <p className="muted">이번 경주에는 출전하지 않았어요.</p>
        )}
        <div className="podium-mini">
          {first && (
            <div className="gold">
              🏆 1등 <b>{first.name}</b> <span>{first.id}번</span>
            </div>
          )}
          {second && (
            <div className="silver">
              🥈 2등 <b>{second.name}</b> <span>{second.id}번</span>
            </div>
          )}
        </div>
        {sync.hashMismatch && <p className="small muted">※ 이 기기 계산과 달라 서버 공식 결과로 표시했어요.</p>}
      </div>
    );
  }

  if (sync.engineMismatch) {
    // 자동으로 최신 버전을 받는 중 (안내 버튼 없음)
    return (
      <div className="race-panel">
        <p className="pulse">최신 화면 불러오는 중…</p>
      </div>
    );
  }

  if (!view || !result) return <div className="race-panel pulse">경주 정보를 받는 중…</div>;

  if (!inRace) {
    return (
      <div className="race-panel">
        <p className="muted">이번 경주는 관전 중이에요 (경주 시작 후 참가).</p>
        <div className="leader-line">
          🏇 선두 <b>{view.leaderName}</b>
        </div>
      </div>
    );
  }

  const color = hex(horseColor(myNo));
  const ev = view.event ? EVENT_SPECS[view.event] : null;

  return (
    <div className="race-panel" style={{ ['--horse' as string]: color }}>
      {view.kind === 'countdown' ? (
        <div className="countdown">
          <div className="small">출발까지</div>
          <div className="countdown-num">{Math.max(0, view.secondsLeft)}</div>
          <div className="small">대형 화면을 봐 주세요!</div>
        </div>
      ) : (
        <>
          <div className="live-rank">
            {view.kind === 'paused' && <div className="paused-tag">⏸ 잠시 멈춤</div>}
            <span className="live-label">
              {view.kind === 'arrived' || view.kind === 'over' ? '도착! 잠정 순위' : '현재 순위'}
            </span>
            <span className="live-num">
              {view.rank}
              <small>위 / {view.total}</small>
            </span>
          </div>

          {sync.tacticsOn && (view.kind === 'running' || view.kind === 'paused') && (
            <TacticBox sync={sync} myNo={myNo} token={token} />
          )}

          <div className="track-bar" aria-label={`진행률 ${Math.round(view.progress * 100)}%`}>
            <div className="track-fill" style={{ width: `${view.progress * 100}%` }} />
            <div className="track-leader" style={{ left: `${view.leaderProgress * 100}%` }} title="선두" />
            <div className="track-me" style={{ left: `${view.progress * 100}%` }}>
              {myNo}
            </div>
            <div className="track-finish">🏁</div>
          </div>
          <div className="track-meta small">
            <span>{Math.round(view.progress * 100)}%</span>
            <span>
              {view.kind === 'over' ? '1위' : '선두'} <b>{view.leaderName}</b>
            </span>
          </div>

          <div key={view.eventKey ?? 'none'} className={`my-event ${ev ? (ev.good ? 'good' : 'bad') : ''} ${view.eventKey ? 'flash' : ''}`}>
            {view.kind === 'arrived' || view.kind === 'over' ? (
              <span>🏁 결승 통과!</span>
            ) : ev ? (
              <>
                <span className="ev-emoji">{ev.emoji}</span> {ev.label}!
              </>
            ) : (
              <span className="muted small">{view.kind === 'paused' ? '잠시 멈췄어요' : '달리는 중…'}</span>
            )}
          </div>

          {(view.kind === 'over' || view.kind === 'arrived') && (
            <p className="small muted center">공식 결과 발표를 기다리는 중…</p>
          )}
        </>
      )}
    </div>
  );
}
