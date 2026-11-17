import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { demoEntrants } from '../data/demo';
import { ENGINE_VERSION, RACE_SECONDS, RaceInputError, Rng, TACTIC_TYPES, simulateRace, type Entrant, type RaceResult, type TacticOrder } from '../engine';
import { LocalRaceClock } from '../game/clock';
import { PhaserRace } from '../game/PhaserRace';
import { ResultsBoard } from '../components/ResultsBoard';
import { SoundToggle } from '../components/SoundToggle';
import { describeRoster, loadRoster, type CachedRoster } from '../lib/rosterCache';

/** 행사 정원과 같게 (서버도 20명 상한). 화면 한계 점검용 ?stress=1 일 때만 50마리까지 */
const DEMO_MAX = 20;
const STRESS_MAX = 50;

function randomSeed(): number {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0]!;
}

/** 데모 전용(?tactics=1): 가상 참가자들이 작전을 고른 것처럼 (시드로 정해짐, 일부는 고르지 않음) */
function demoTactics(seed: number, entrants: Entrant[]): TacticOrder[] {
  const rng = new Rng((seed ^ 0x7ac71c5) >>> 0);
  const out: TacticOrder[] = [];
  for (const e of entrants) {
    for (let window = 1; window <= 3; window++) {
      if (rng.chance(1, 4)) continue;
      out.push({ id: e.id, window, tactic: TACTIC_TYPES[rng.int(3)]! });
    }
  }
  return out;
}

function parseIntParam(v: string | null, fallback: number): number {
  const n = Number(v);
  return v !== null && Number.isInteger(n) ? n : fallback;
}

/**
 * 1단계 대형 스크린 데모.
 * 로컬 시계 + 가상 참가자로 경주를 돌려 본다. (3단계에서 서버 시계/실제 참가자로 교체)
 *
 * 단축키: Space 일시정지/재개 · R 같은 시드로 다시 · N 새 시드 · H 조작패널 숨김
 */
export function ScreenDemo() {
  const [params, setParams] = useSearchParams();
  // 비상 모드(/demo?cached=1): 대형 화면 PC 에 저장된 마지막 참가자 명단으로 "새 경주" (서버 없이)
  // 명단은 "경주 시작"을 누르는 순간 다시 읽는다 → 미리 열어 둔 탭도 항상 최신 명단 사용
  const emergency = params.get('cached') === '1';
  // 작전 연출 점검용 (비상 모드에서는 항상 끔 → 참가자 입력 없이 기존 방식)
  const demoTac = !emergency && params.get('tactics') === '1';
  const [roster, setRoster] = useState<CachedRoster | null>(() => (emergency ? loadRoster() : null));
  const [clockTick, setClockTick] = useState(0); // "몇 분 전" 표시 갱신용
  useEffect(() => {
    if (!emergency) return;
    const refresh = () => setRoster(loadRoster());
    // 같은 PC 의 다른 탭(/screen)이 명단을 저장하면 즉시 반영 + 혹시 몰라 10초마다 확인
    const onStorage = (e: StorageEvent) => e.key === 'rhd.roster.v1' && refresh();
    window.addEventListener('storage', onStorage);
    const id = setInterval(() => {
      refresh();
      setClockTick((x) => x + 1);
    }, 10_000);
    return () => {
      window.removeEventListener('storage', onStorage);
      clearInterval(id);
    };
  }, [emergency]);
  const maxCount = params.get('stress') === '1' ? STRESS_MAX : DEMO_MAX;
  const [count, setCount] = useState(() => Math.min(maxCount, Math.max(1, parseIntParam(params.get('n'), DEMO_MAX))));
  const [raceSeconds, setRaceSeconds] = useState(() =>
    Math.min(
      RACE_SECONDS.max,
      Math.max(RACE_SECONDS.min, parseIntParam(params.get('sec'), (params.get('cached') === '1' && loadRoster()?.raceSeconds) || RACE_SECONDS.default)),
    ),
  );
  const [seedText, setSeedText] = useState(() => params.get('seed') ?? String(randomSeed()));
  const [race, setRace] = useState<RaceResult | null>(null);
  const [clock, setClock] = useState<LocalRaceClock | null>(null);
  const [paused, setPaused] = useState(false);
  const [finished, setFinished] = useState(false);
  /** 결승 연출(리플레이·세리머니)이 끝났는지 */
  const [presented, setPresented] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [simMs, setSimMs] = useState(0);
  // 테스트용 배속 (?speed=4). 1~10 으로 제한
  const speed = Math.min(10, Math.max(1, parseIntParam(params.get('speed'), 1)));

  const start = useCallback(
    (seedOverride?: number) => {
      setError(null);
      const seed = seedOverride ?? Number(seedText);
      try {
        const t0 = performance.now();
        const fresh = emergency ? loadRoster() : null; // 시작하는 순간의 최신 저장본
        if (emergency) setRoster(fresh);
        const entrants = fresh ? fresh.entrants : demoEntrants(count);
        const r = simulateRace({ seed, entrants, raceSeconds, tactics: demoTac ? demoTactics(seed, entrants) : undefined });
        setSimMs(performance.now() - t0);
        setSeedText(String(seed));
        setParams(
          {
            seed: String(seed),
            n: String(count),
            sec: String(raceSeconds),
            ...(speed > 1 ? { speed: String(speed) } : {}),
            ...(emergency ? { cached: '1' } : {}),
            ...(maxCount > DEMO_MAX ? { stress: '1' } : {}),
            ...(demoTac ? { tactics: '1' } : {}),
            ...(params.get('view') === '2d' ? { view: '2d' } : {}),
          },
          { replace: true },
        );
        setRace(r);
        setClock(new LocalRaceClock(3000, speed));
        setPaused(false);
        setFinished(false);
        setPresented(false);
        setShowResults(false);
      } catch (e) {
        setError(e instanceof RaceInputError ? e.message : `알 수 없는 오류: ${String(e)}`);
      }
    },
    [count, seedText, setParams, speed, raceSeconds, emergency, maxCount, demoTac, params],
  );

  const togglePause = useCallback(() => {
    if (!clock || finished) return;
    if (clock.isPaused()) clock.resume();
    else clock.pause();
    setPaused(clock.isPaused());
  }, [clock, finished]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.repeat) return; // 키 누르고 있을 때 연타 방지
      // 마우스로 누른 버튼에 포커스가 남아 있으면 Space/Enter 가 그 버튼까지 눌러 이중 동작 → 포커스 해제
      if (document.activeElement instanceof HTMLButtonElement) document.activeElement.blur();
      if (e.code === 'Space') {
        e.preventDefault();
        togglePause();
      } else if (e.key === 'r' || e.key === 'R') start();
      else if (e.key === 'n' || e.key === 'N') start(randomSeed());
      else if (e.key === 'h' || e.key === 'H') setShowControls((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [start, togglePause]);

  const onPresentationDone = useCallback(() => setPresented(true), []);
  // 경주가 끝나고 결승 연출(리플레이·세리머니)까지 끝나면 1.5초 뒤 결과표
  useEffect(() => {
    if (!finished || !presented) return;
    const t = window.setTimeout(() => setShowResults(true), 1500);
    return () => window.clearTimeout(t);
  }, [finished, presented]);

  const onFinished = useCallback(() => setFinished(true), []);

  const info = useMemo(
    () =>
      race
        ? `엔진 v${ENGINE_VERSION} · ${race.raceSeconds}초 설정 · seed ${race.seed} · 해시 ${race.hash} · ${race.entrants.length}마리 · 이벤트 ${race.events.length}건 · 계산 ${simMs.toFixed(1)}ms`
        : '시작 버튼을 누르세요',
    [race, simMs],
  );

  return (
    <div className="screen-page">
      <PhaserRace race={race} clock={clock} tactics={demoTac} onFinished={onFinished} onPresentationDone={onPresentationDone} />
      <SoundToggle />

      {showResults && race && (
        <ResultsBoard
          standings={race.standings}
          hash={race.hash}
          note={emergency ? '🚨 비상 모드 결과예요. 서버에 저장되지 않으니 사진으로 남겨 주세요.' : undefined}
          onClose={() => setShowResults(false)}
        />
      )}

      {emergency && showControls && <EmergencyStrip roster={roster} racing={!!race} tick={clockTick} />}
      {showControls && (
        <div className="control-bar">
          <label style={emergency && roster ? { display: 'none' } : undefined}>
            인원
            <input
              type="number"
              min={1}
              max={maxCount}
              value={count}
              onChange={(e) => setCount(Math.min(maxCount, Math.max(1, Number(e.target.value) || 1)))}
            />
          </label>
          <label title={`1등 도착 기준 목표 시간 (${RACE_SECONDS.min}~${RACE_SECONDS.max}초)`}>
            경주 시간
            <input
              type="number"
              min={RACE_SECONDS.min}
              max={RACE_SECONDS.max}
              step={5}
              value={raceSeconds}
              onChange={(e) => setRaceSeconds(Number(e.target.value) || RACE_SECONDS.default)}
              onBlur={() =>
                setRaceSeconds((v) => Math.min(RACE_SECONDS.max, Math.max(RACE_SECONDS.min, Math.round(v))))
              }
            />
            초
          </label>
          <label>
            시드
            <input value={seedText} onChange={(e) => setSeedText(e.target.value.trim())} className="seed" />
          </label>
          <button onClick={() => start()}>▶ 시작 (R)</button>
          <button onClick={() => start(randomSeed())}>🎲 새 시드 (N)</button>
          <button onClick={togglePause} disabled={!race || finished}>
            {paused ? '⏵ 재개' : '⏸ 일시정지'} (Space)
          </button>
          <button onClick={() => setShowResults((v) => !v)} disabled={!finished}>
            🏁 순위표
          </button>
          <span className="info">{info}</span>
          <span className="hint">H: 패널 숨김</span>
          {error && <span className="error">⚠️ {error}</span>}
        </div>
      )}
    </div>
  );
}

/**
 * 비상 모드 안내 띠: 지금 무엇이 일어나는지 정확히 쓴다.
 *  - 서버 경주를 이어가지 않고, 저장된 명단으로 "새 경주"를 시작
 *  - 명단 출처(대기실/몇 라운드 경주) · 인원 · 저장 시각, 비어 있거나 오래됐으면 경고
 */
function EmergencyStrip({ roster, racing, tick }: { roster: CachedRoster | null; racing: boolean; tick: number }) {
  void tick;
  if (!roster) {
    return (
      <div className="emergency-strip bad">
        🚨 비상 모드 · 이 PC에 저장된 참가자 명단이 없어요. 대형 화면(/screen)을 이 PC·이 브라우저에서 한 번이라도 열어야 저장돼요. 지금
        시작하면 가상 참가자로 진행됩니다.
      </div>
    );
  }
  const d = describeRoster(roster);
  return (
    <div className={`emergency-strip ${d.stale ? 'bad' : ''}`}>
      🚨 비상 모드 · 서버 경주를 이어가지 않고 <b>저장된 명단으로 새 경주</b>를 {racing ? '진행 중' : '시작해요'} · {d.text}
      {d.stale && ' · ⚠️ 3시간 넘은 명단이에요 (이전 행사·리허설 명단일 수 있어요)'} · 서버·휴대폰 연동 없음
    </div>
  );
}
