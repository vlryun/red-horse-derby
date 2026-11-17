/** ❄️ 엔진 v2 원본 보관본 — 수정 금지 (v2 로 시작된 경주를 그대로 재생하기 위해 유지) */
import {
  AWAKEN_CHANCE,
  AWAKEN_MIN_PROGRESS,
  ENGINE_VERSION,
  EVENT_CHANCE,
  EVENT_GRACE_TICKS,
  RACE_SECONDS,
  SPEED,
  TICK_MS,
  TRACK_LENGTH,
  tuningFor,
} from './config';
import { EVENT_ORDER, EVENT_SPECS, EVENT_TOTAL_WEIGHT } from './events';
import { Rng, fnv1a } from '../rng';
import type { EventType, FinishRecord, RaceEvent, RaceInput, RaceResult } from '../types';
import { validateRaceInput } from '../validate';

/**
 * 결정론적 경주 시뮬레이션.
 *
 * 같은 (seed, entrants 순서) 입력이면 어떤 기기에서 실행해도 비트 단위로 같은 결과가 나온다.
 * - 모든 물리 연산은 정수(Math.floor 나눗셈 포함)만 사용
 * - Math.random / Date / 삼각함수 사용 금지
 * - 이벤트도 시뮬레이션 안에서 같은 RNG 로 발생 → 결과 조작 불가, 재현 가능
 *
 * 경주 전체(최대 2400틱 × 50마리)를 한 번에 미리 계산한다(수 ms).
 * 화면은 "서버 기준 경과 시간"만 알면 어느 시점이든 그릴 수 있으므로
 * 네트워크로는 seed + 참가자 + 시작 시각만 보내면 된다.
 */
export function simulateRace(input: RaceInput): RaceResult {
  validateRaceInput(input);
  const { seed } = input;
  const raceSeconds = input.raceSeconds ?? RACE_SECONDS.default;
  const tune = tuningFor(raceSeconds);
  const entrants = input.entrants.map((e) => ({ id: e.id, name: e.name }));
  const n = entrants.length;
  const rng = new Rng(seed);
  const L = TRACK_LENGTH;

  // 말별 상태
  const pos = new Int32Array(n); // 실제 위치 (L 초과 가능)
  const speed = new Int32Array(n);
  const target = new Int32Array(n);
  const base = new Int32Array(n);
  const nextPace = new Int32Array(n);
  const evType: (EventType | null)[] = new Array<EventType | null>(n).fill(null);
  const evEnd = new Int32Array(n);
  const finishTick = new Int32Array(n).fill(-1);
  // 결승 통과 틱 내 보간용 (정수 비교)
  const finishRemain = new Int32Array(n); // L - prevPos
  const finishStep = new Int32Array(n); // 그 틱의 이동량

  for (let i = 0; i < n; i++) {
    base[i] = tune.base + rng.range(-tune.baseSpread, tune.baseSpread);
    target[i] = base[i]!;
    nextPace[i] = rng.range(tune.ticks(SPEED.paceIntervalMin), tune.ticks(SPEED.paceIntervalMax));
  }

  const frames: Int32Array[] = [new Int32Array(n)]; // tick 0: 모두 0
  const events: RaceEvent[] = [];
  const overrun = Math.floor(L / 20); // 결승 후 5%까지만 기록 (연출용)
  let finishedCount = 0;
  let t = 0;

  while (finishedCount < n && t < tune.maxTicks) {
    t++;

    const startEvent = (lane: number, type: EventType) => {
      const spec = EVENT_SPECS[type];
      const dur = rng.range(tune.ticks(spec.minTicks), tune.ticks(spec.maxTicks));
      evType[lane] = type;
      evEnd[lane] = t + dur;
      events.push({ tick: t, endTick: t + dur, horse: lane, type });
    };

    // 1) 일반 개그 이벤트 판정 (틱당 최대 1건)
    if (t > tune.ticks(EVENT_GRACE_TICKS) && rng.chance(EVENT_CHANCE.num, tune.eventDen)) {
      const lane = rng.int(n);
      const type = pickEventType(rng);
      if (finishTick[lane] === -1 && evType[lane] === null) startEvent(lane, type);
    }

    // 1-b) 붉은 말 각성: 선두가 60% 이상 진행한 후, 하위 절반 말 중 한 마리
    if (leaderProgress(pos, n, L) >= AWAKEN_MIN_PROGRESS && rng.chance(AWAKEN_CHANCE.num, tune.awakenDen)) {
      const lane = pickBottomHalf(rng, pos, finishTick, n);
      if (lane !== -1 && evType[lane] === null) startEvent(lane, 'AWAKEN');
    }

    // 2) 이동
    for (let i = 0; i < n; i++) {
      if (finishTick[i] !== -1) {
        // 결승 후에는 감속하며 조금 더 달린다 (연출용, 순위 무관)
        speed[i] = Math.max(0, speed[i]! - tune.decel);
        pos[i] = pos[i]! + speed[i]!;
        continue;
      }

      // 목표 속도 갱신 (페이스 랜덤워크) → 자연스러운 추월
      if (t >= nextPace[i]!) {
        const pace = rng.range(SPEED.paceMin, SPEED.paceMax);
        target[i] = Math.floor((base[i]! * pace) / 1000);
        nextPace[i] = t + rng.range(tune.ticks(SPEED.paceIntervalMin), tune.ticks(SPEED.paceIntervalMax));
      }

      // 이벤트 만료
      if (evType[i] !== null && t >= evEnd[i]!) evType[i] = null;
      const ev = evType[i];
      const mult = ev === null || ev === undefined ? 1000 : EVENT_SPECS[ev].mult;

      // 현재 속도를 목표로 서서히 수렴 (정지 이벤트 중엔 실제로 멈춰서 재가속 필요)
      if (mult === 0) {
        speed[i] = Math.max(0, speed[i]! - tune.decel * 2);
      } else {
        const diff = target[i]! - speed[i]!;
        speed[i] = speed[i]! + (diff > 0 ? Math.min(diff, tune.accel) : Math.max(diff, -tune.decel));
      }

      const step = mult === 0 ? 0 : Math.floor((speed[i]! * mult) / 1000);
      const prev = pos[i]!;
      pos[i] = prev + step;

      if (pos[i]! >= L) {
        finishTick[i] = t;
        finishRemain[i] = L - prev;
        finishStep[i] = step;
        finishedCount++;
        evType[i] = null;
      }
    }

    const frame = new Int32Array(n);
    for (let i = 0; i < n; i++) frame[i] = Math.min(pos[i]!, L + overrun);
    frames.push(frame);
  }

  // 3) 최종 순위
  const lanes = Array.from({ length: n }, (_, i) => i);
  lanes.sort((a, b) => {
    const fa = finishTick[a]!;
    const fb = finishTick[b]!;
    if (fa !== -1 && fb !== -1) {
      if (fa !== fb) return fa - fb;
      // 같은 틱 안에서 누가 먼저 선을 넘었는가: remain/step 비교 (교차곱, 정수)
      const lhs = finishRemain[a]! * finishStep[b]!;
      const rhs = finishRemain[b]! * finishStep[a]!;
      if (lhs !== rhs) return lhs - rhs;
      return a - b; // 완전 동착: 낮은 게이트 우선 (결정론적 규칙)
    }
    if (fa !== -1) return -1;
    if (fb !== -1) return 1;
    if (pos[a] !== pos[b]) return pos[b]! - pos[a]!;
    return a - b;
  });

  const standings: FinishRecord[] = lanes.map((lane, idx) => {
    const ft = finishTick[lane]!;
    const finishMs =
      ft === -1
        ? null
        : (ft - 1) * TICK_MS + Math.floor((TICK_MS * finishRemain[lane]!) / Math.max(1, finishStep[lane]!));
    return { lane, id: entrants[lane]!.id, name: entrants[lane]!.name, rank: idx + 1, finishMs };
  });

  const totalTicks = t;
  const positions = new Int32Array((totalTicks + 1) * n);
  frames.forEach((f, k) => positions.set(f, k * n));

  const hashInput: number[] = [ENGINE_VERSION, seed | 0, raceSeconds, n, totalTicks, events.length];
  for (const s of standings) hashInput.push(s.lane, s.id, s.finishMs ?? -1);

  return {
    engineVersion: ENGINE_VERSION,
    seed,
    raceSeconds,
    baseSpeed: tune.base,
    entrants,
    totalTicks,
    positions,
    events,
    standings,
    finishTick,
    hash: fnv1a(hashInput),
  };
}

/** 가중치 기반 일반 이벤트 선택 (AWAKEN 은 weight 0 → 별도 판정) */
function pickEventType(rng: Rng): EventType {
  let r = rng.int(EVENT_TOTAL_WEIGHT);
  for (const type of EVENT_ORDER) {
    r -= EVENT_SPECS[type].weight;
    if (r < 0) return type;
  }
  return 'CARROT'; // 도달 불가
}

/** 선두 진행률 (천분율, 정수) */
function leaderProgress(pos: Int32Array, n: number, L: number): number {
  let leader = 0;
  for (let i = 0; i < n; i++) if (pos[i]! > leader) leader = pos[i]!;
  return Math.floor((Math.min(leader, L) * 1000) / L);
}

/** 미완주 말 중 위치 기준 하위 절반에서 하나를 고른다 (없으면 -1) */
function pickBottomHalf(rng: Rng, pos: Int32Array, finishTick: Int32Array, n: number): number {
  const running: number[] = [];
  for (let i = 0; i < n; i++) if (finishTick[i] === -1) running.push(i);
  if (running.length === 0) return -1;
  running.sort((a, b) => (pos[a] !== pos[b] ? pos[a]! - pos[b]! : a - b)); // 뒤쪽부터
  const half = Math.max(1, Math.floor(running.length / 2));
  return running[rng.int(half)]!;
}
