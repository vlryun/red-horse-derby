import { useEffect, useRef, useState } from 'react';
import {
  STAMINA_MAX,
  STAMINA_START,
  TACTIC_FAIL_TEXT,
  TACTIC_SPECS,
  TACTIC_TYPES,
  TICK_MS,
  hasCloseAhead,
  rankingAtTick,
  tacticWindows,
  tickAt,
  type RaceResult,
  type TacticType,
} from '../engine';
import { BackendError, errorText, getBackend } from '../lib/backend';
import type { RaceSync } from '../lib/useRace';

type Phase =
  | { kind: 'wait'; next: number; secs: number }
  | { kind: 'open'; no: number; secs: number; closing: boolean }
  | { kind: 'after'; no: number; tick: number }
  | { kind: 'done' };

interface Snap {
  phase: Phase;
  rank: number;
  total: number;
  stamina: number;
  /** 지금 바로 앞 25m 안에 달리는 말이 있는가 */
  chaseOk: boolean;
}

/** 이 틱까지 적용된 작전으로 계산한 체력 */
function staminaAt(r: RaceResult, lane: number, tick: number): number {
  let s = STAMINA_START;
  for (const x of r.tactics ?? []) if (x.lane === lane && x.tick <= tick) s = x.staminaAfter;
  return s;
}

/**
 * 경주 중 작전 선택 (세 번).
 * 창이 열리면 세 버튼을 모두 보여준다 — 같은 작전을 매번 골라도 됨. 마감 전에는 바꿀 수 있고,
 * 서버는 마지막 선택 하나만 저장 → 마감 1초 뒤 모든 화면에서 똑같이 적용.
 */
export function TacticBox({ sync, myNo, token }: { sync: RaceSync; myNo: number; token: string }) {
  const { result, clock, info } = sync;
  const raceId = info?.id ?? null;
  const [snap, setSnap] = useState<Snap | null>(null);
  /** 서버가 받은 내 선택 (창 → 작전) */
  const [picks, setPicks] = useState<Record<number, TacticType>>({});
  const [sending, setSending] = useState<{ no: number; tactic: TacticType } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const vibrated = useRef<Set<string>>(new Set());

  // 새로고침해도 내가 고른 작전이 그대로 보이게
  useEffect(() => {
    setPicks({});
    setError(null);
    if (!raceId) return;
    let alive = true;
    getBackend()
      .myTactics(token, raceId)
      .then((list) => alive && setPicks(Object.fromEntries(list.map((x) => [x.window, x.tactic]))))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [raceId, token]);

  const lane = result ? result.entrants.findIndex((e) => e.id === myNo) : -1;

  useEffect(() => {
    if (!result || !clock || lane < 0) return;
    const windows = tacticWindows(result.raceSeconds, result.engineVersion);
    const n = result.entrants.length;
    const pos = new Int32Array(n);
    const update = () => {
      const el = clock.elapsedMs();
      const tick = tickAt(result, el);
      let phase: Phase = { kind: 'done' };
      const open = windows.find((w) => el >= w.openMs && el < w.closeMs);
      if (open) {
        const left = open.closeMs - el;
        phase = { kind: 'open', no: open.no, secs: Math.ceil(left / 1000), closing: left < 250 };
        const key = `${raceId}:${open.no}`;
        if (!vibrated.current.has(key) && !clock.isPaused()) {
          vibrated.current.add(key);
          try {
            navigator.vibrate?.([80, 60, 80]);
          } catch {
            /* 진동 미지원 */
          }
        }
      } else {
        const next = windows.find((w) => el < w.openMs);
        const last = [...windows].reverse().find((w) => el >= w.closeMs);
        if (last && el < last.endTick * TICK_MS + 2500) phase = { kind: 'after', no: last.no, tick };
        else if (next) phase = { kind: 'wait', next: next.no, secs: Math.max(0, Math.ceil((next.openMs - Math.max(0, el)) / 1000)) };
      }
      for (let i = 0; i < n; i++) pos[i] = result.positions[tick * n + i]!;
      const done = Int32Array.from(result.finishTick, (f) => (f !== -1 && f <= tick ? f : -1));
      setSnap({
        phase,
        rank: rankingAtTick(result, tick).indexOf(lane) + 1,
        total: n,
        stamina: staminaAt(result, lane, tick),
        chaseOk: hasCloseAhead(pos, done, n, lane),
      });
    };
    update();
    const id = setInterval(update, 200);
    return () => clearInterval(id);
  }, [result, clock, lane, raceId]);

  if (!snap || !result || !raceId || lane < 0) return null;
  const { phase } = snap;

  const choose = async (no: number, tactic: TacticType) => {
    setError(null);
    setSending({ no, tactic });
    try {
      const r = await getBackend().submitTactic(token, raceId, no, tactic);
      setPicks((p) => ({ ...p, [r.window]: r.tactic }));
    } catch (e) {
      setError(e instanceof BackendError && e.code === 'TACTIC_CLOSED' ? '선택 시간이 끝나 접수되지 않았어요.' : errorText(e));
    } finally {
      setSending((s) => (s && s.no === no && s.tactic === tactic ? null : s));
    }
  };

  const staminaBar = (
    <div className="tac-stats">
      <span className="tac-no">{myNo}번</span>
      <span>
        현재 <b>{snap.rank}</b>위
      </span>
      <span className="tac-stamina" aria-label={`체력 ${snap.stamina}`}>
        체력
        <span className="tac-meter">
          <span style={{ width: `${(snap.stamina / STAMINA_MAX) * 100}%` }} />
        </span>
        <b>{snap.stamina}</b>
      </span>
    </div>
  );

  if (phase.kind === 'open') {
    const picked = picks[phase.no];
    return (
      <div className="tactic-box open">
        <div className="tac-head">
          <span>🎯 {phase.no}차 작전 타임</span>
          <span className="tac-secs">{phase.secs}초</span>
        </div>
        {staminaBar}
        {result.engineVersion >= 5 && <div className="tac-hint">💪 남은 체력이 많을수록 마지막 200m에서 덜 지쳐요</div>}
        <div className="tac-buttons">
          {TACTIC_TYPES.map((t) => {
            const spec = TACTIC_SPECS[t];
            const noStamina = snap.stamina + spec.stamina < 0;
            const noTarget = t === 'CHASE' && !snap.chaseOk;
            // v6: 앞말이 없어도 따라잡기는 약하게(+4%) 적용됨 → 막지 않고 이유만 표시
            const weakOk = result.engineVersion >= 6;
            const reason = noStamina
              ? `체력 부족 (${-spec.stamina} 필요)`
              : noTarget
                ? weakOk
                  ? '지금은 25m 안에 앞말 없음 → 약하게 적용'
                  : '가까운 앞말 없음 (25m 안)'
                : null;
            const isPicked = picked === t;
            const isSending = sending?.no === phase.no && sending.tactic === t;
            return (
              <button
                key={t}
                className={`tac-btn ${isPicked ? 'picked' : ''}`}
                disabled={phase.closing || noStamina || (noTarget && !weakOk && !isPicked)}
                onClick={() => void choose(phase.no, t)}
              >
                <span className="tac-label">
                  {spec.emoji} {spec.label}
                </span>
                <span className="tac-desc">{spec.desc}</span>
                {reason && <span className="tac-reason">{reason}</span>}
                {isPicked && <span className="tac-check">✓ 선택됨</span>}
                {isSending && !isPicked && <span className="tac-check">보내는 중…</span>}
              </button>
            );
          })}
        </div>
        <div className="tac-status">
          {picked ? (
            <>
              <b>{TACTIC_SPECS[picked].label}</b> 선택됨 · 마감 전까지 바꿀 수 있어요
            </>
          ) : (
            '고르지 않으면 기본 페이스로 달려요'
          )}
        </div>
        {error && <div className="tac-error">{error}</div>}
      </div>
    );
  }

  if (phase.kind === 'after') {
    const picked = picks[phase.no];
    const rec = result.tactics?.find((x) => x.window === phase.no && x.lane === lane);
    let text: React.ReactNode;
    let cls = '';
    if (rec && phase.tick >= rec.tick) {
      const spec = TACTIC_SPECS[rec.tactic];
      if (rec.applied) {
        cls = 'applied';
        text = (
          <>
            {spec.emoji} <b>{spec.label}</b> 적용 완료{rec.weak ? ' (앞말이 멀어 약하게)' : ''}
          </>
        );
      } else {
        cls = 'failed';
        text = (
          <>
            {spec.emoji} {spec.label} · {TACTIC_FAIL_TEXT[rec.reason!]}
          </>
        );
      }
    } else if (picked) {
      text = (
        <>
          {TACTIC_SPECS[picked].emoji} <b>{TACTIC_SPECS[picked].label}</b> 접수 마감 · 곧 적용
        </>
      );
    } else {
      text = <>{phase.no}차 작전 없음 · 기본 페이스</>;
    }
    return (
      <div className={`tactic-box ${cls}`}>
        {staminaBar}
        <div className="tac-status">{text}</div>
      </div>
    );
  }

  return (
    <div className="tactic-box">
      {staminaBar}
      <div className="tac-status muted">
        {phase.kind === 'wait' ? `${phase.next}차 작전 타임까지 ${phase.secs}초` : '작전 타임 끝 · 끝까지 달려요!'}
      </div>
    </div>
  );
}
