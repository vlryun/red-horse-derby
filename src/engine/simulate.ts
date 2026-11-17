import {
  AWAKEN_CHANCE,
  AWAKEN_MIN_PROGRESS,
  BOOST_COOLDOWN_TICKS,
  BOOST_STAGGER_TICKS,
  ENGINE_VERSION,
  EVENT_GRACE_TICKS,
  RACE_SECONDS,
  SPEED,
  SPURT_FROM,
  SPURT_PACK,
  SPURT_STAGGER_TICKS,
  SPURT_MAX,
  SPURT_TOP,
  BASE_SPREAD_V5,
  DRAFT_BONUS,
  DRAFT_GAP_UNITS,
  FATIGUE_FROM_PERMIL,
  FATIGUE_PER_10,
  FATIGUE_PER_10_V6,
  TICK_MS,
  TRACK_LENGTH,
  tuningFor,
} from './config';
import { BOOST_ORDER, BOOST_TOTAL_WEIGHT, EVENT_SPECS, SETBACK_ORDER, SETBACK_TOTAL_WEIGHT } from './events';
import { Rng, fnv1a } from './rng';
import type { EventType, FinishRecord, RaceEvent, RaceInput, RaceResult } from './types';
import {
  CHASE_GAP,
  STAMINA_MAX,
  STAMINA_START,
  tacticParams,
  tacticTicks,
  tacticWindows,
  type TacticRecord,
  type TacticType,
} from './tactics';
import { validateRaceInput } from './validate';

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
  return simulateCore(input, ENGINE_VERSION);
}

/** v5 경주(이전 작전 수치) 재현용 */
export function simulateRaceV5(input: RaceInput): RaceResult {
  return simulateCore(input, 5);
}

/** v4 경주(순위 보정 있는 부스터·선두 제외 스퍼트) 재현용 */
export function simulateRaceV4(input: RaceInput): RaceResult {
  return simulateCore(input, 4);
}

/** v3 경주(작전 없음) 재현용: 같은 코드에서 작전만 끄고 해시에 v3 를 기록 */
export function simulateRaceV3(input: RaceInput): RaceResult {
  return simulateCore({ ...input, tactics: undefined }, 3);
}

/**
 * 작전(v4)은 정해진 적용 틱에만 끼어들고 난수를 쓰지 않는다
 *  → 작전이 없으면 v3 와 위치·이벤트가 완전히 같고, 작전이 있으면 "적용 틱 이후"만 달라진다
 *    (이미 화면에 보여준 구간은 그대로 → 마감된 작전을 받아 다시 계산해도 과거 장면이 바뀌지 않음)
 */
function simulateCore(input: RaceInput, version: number): RaceResult {
  validateRaceInput(input);
  const { seed } = input;
  const raceSeconds = input.raceSeconds ?? RACE_SECONDS.default;
  const tune = tuningFor(raceSeconds);
  /**
   * v5: 순위에 따른 보정 없음 — 부스터는 달리는 말 모두 같은 확률, 막판 스퍼트도 선두 포함.
   * 대신 말 능력치 편차를 줄여(BASE_SPREAD_V5) 초반 선두가 혼자 달아나지 않게 하고,
   * 승부는 페이스 변화·부스터·참가자 작전(힘을 쓰는 타이밍)으로 갈림.
   */
  const v5 = version >= 5;
  const FATIGUE_FROM = Math.floor((TRACK_LENGTH * FATIGUE_FROM_PERMIL) / 1000);
  if (v5) tune.baseSpread = Math.floor((tune.base * BASE_SPREAD_V5) / SPEED.base);
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
  // v3 부스터 분배: 말별 쿨다운 · 전체 시차 · 막판 스퍼트 1회
  const boostReadyAt = new Int32Array(n);
  const spurted = new Uint8Array(n);
  let lastBoostAt = -100000;
  let lastSpurtAt = -100000;
  let spurtCount = 0;
  const cooldown = tune.ticks(BOOST_COOLDOWN_TICKS);
  const stagger = tune.ticks(BOOST_STAGGER_TICKS);
  const spurtStagger = tune.ticks(SPURT_STAGGER_TICKS);

  // v4 작전: 말별 체력 · 진행 중 작전 배율 · 창별 주문 (말 번호 → 레인)
  const windows = version >= 4 ? tacticWindows(raceSeconds, version) : [];
  const v6 = version >= 6;
  const orders: (TacticType | undefined)[][] = windows.map(() => new Array<TacticType | undefined>(n));
  if (version >= 4 && input.tactics) {
    const laneOf = new Map(entrants.map((e, i) => [e.id, i]));
    for (const o of input.tactics) {
      const lane = laneOf.get(o.id);
      const w = windows[o.window - 1];
      if (lane === undefined || !w) continue;
      orders[o.window - 1]![lane] = o.tactic;
    }
  }
  const stamina = new Int32Array(n).fill(STAMINA_START);
  const tacMult = new Int32Array(n).fill(1000);
  const tacEnd = new Int32Array(n);
  const tacticLog: TacticRecord[] = [];

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

    // 0) 작전 적용 (마감된 창의 선택, 직전 틱 위치 기준으로 조건 판정 · 난수 사용 없음)
    for (let w = 0; w < windows.length; w++) {
      if (windows[w]!.applyTick !== t) continue;
      const win = windows[w]!;
      for (let i = 0; i < n; i++) {
        const tac = orders[w]![i];
        if (!tac) continue;
        const spec = tacticParams(version, tac);
        const dur = tacticTicks(version, tac, raceSeconds);
        const before = stamina[i]!;
        let reason: TacticRecord['reason'] = null;
        let mult = spec.mult;
        let weak = false;
        if (finishTick[i] !== -1) reason = 'FINISHED';
        else if (before + spec.stamina < 0) reason = 'NO_STAMINA';
        else if (tac === 'CHASE' && !hasCloseAhead(pos, finishTick, n, i)) {
          if (spec.multNoTarget === null) reason = 'NO_TARGET';
          else {
            mult = spec.multNoTarget;
            weak = true;
          }
        }
        if (reason === null) {
          stamina[i] = Math.min(STAMINA_MAX, before + spec.stamina);
          tacMult[i] = mult;
          tacEnd[i] = t + dur;
        }
        tacticLog.push({
          window: win.no,
          lane: i,
          id: entrants[i]!.id,
          tactic: tac,
          tick: t,
          endTick: reason === null ? t + dur : win.endTick,
          applied: reason === null,
          reason,
          ...(v6 ? { weak } : {}),
          staminaBefore: before,
          staminaAfter: stamina[i]!,
        });
      }
    }

    const startEvent = (lane: number, type: EventType) => {
      const spec = EVENT_SPECS[type];
      const dur = rng.range(tune.ticks(spec.minTicks), tune.ticks(spec.maxTicks));
      evType[lane] = type;
      evEnd[lane] = t + dur;
      events.push({ tick: t, endTick: t + dur, horse: lane, type });
      if (spec.good) {
        boostReadyAt[lane] = t + dur + cooldown; // 같은 말에게 연속으로 몰리지 않게
        lastBoostAt = t;
      }
    };

    const leadP = leaderProgress(pos, n, L);
    const afterGrace = t > tune.ticks(EVENT_GRACE_TICKS);

    // 1) 짧은 순간 부스터 (당근·방귀·미친 질주): 잔여 200m 전까지. 동시 가속 방지 시차 + 말별 쿨다운
    if (afterGrace && leadP < SPURT_FROM && rng.chance(1, tune.boostDen) && t - lastBoostAt >= stagger) {
      const lane = pickBoostLane(rng, pos, finishTick, evType, boostReadyAt, t, n, v5);
      if (lane !== -1) startEvent(lane, pickWeighted(rng, BOOST_ORDER, BOOST_TOTAL_WEIGHT));
    }

    // 1-b) 방해 이벤트 (바나나·졸음·거북이·탈주): 누구에게나 같은 확률
    if (afterGrace && rng.chance(1, tune.setbackDen)) {
      const lane = rng.int(n);
      const type = pickWeighted(rng, SETBACK_ORDER, SETBACK_TOTAL_WEIGHT);
      if (finishTick[lane] === -1 && evType[lane] === null) startEvent(lane, type);
    }

    // 1-c) 붉은 말 각성: 선두가 60% 이상 진행한 후, 하위 절반 말 중 한 마리
    if (leadP >= AWAKEN_MIN_PROGRESS && rng.chance(AWAKEN_CHANCE.num, tune.awakenDen)) {
      const lane = pickBottomHalf(rng, pos, finishTick, n);
      if (lane !== -1 && evType[lane] === null) startEvent(lane, 'AWAKEN');
    }

    // 1-d) 막판 스퍼트: 선두가 잔여 200m 에 들어오면 선두권(선두와 SPURT_PACK 이내) 말마다 한 번씩 기회.
    //      선두 자신도 대상 → 역전을 강제하지 않고, 결과는 실제 주행으로만 정해짐
    if (leadP >= SPURT_FROM && spurtCount < SPURT_MAX && t - lastSpurtAt >= spurtStagger) {
      // 선두권 = 달리는 말 중 앞에서 SPURT_TOP 마리, 그중 선두와 SPURT_PACK 이내
      const front: number[] = [];
      for (let i = 0; i < n; i++) if (finishTick[i] === -1) front.push(i);
      front.sort((a, b) => (pos[a] !== pos[b] ? pos[b]! - pos[a]! : a - b));
      const lead = front.length ? pos[front[0]!]! : 0;
      for (const i of front.slice(0, SPURT_TOP)) {
        // 지금 1위인 말은 쫓기는 입장 → 이 순간엔 건너뜀 (1위를 내주면 다시 기회가 생김)
        if ((!v5 && i === front[0]) || spurted[i] || evType[i] !== null || lead - pos[i]! > SPURT_PACK) continue;
        if (rng.chance(1, tune.spurtDen)) {
          spurted[i] = 1;
          spurtCount++;
          lastSpurtAt = t;
          startEvent(i, 'SPURT');
          break; // 틱당 한 마리 → 누가 스퍼트했는지 화면에서 구분됨
        }
      }
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

      let step = mult === 0 ? 0 : Math.floor((speed[i]! * mult) / 1000);
      if (t < tacEnd[i]!) {
        // v6: 랜덤 부스터와 작전 가속이 겹치면 곱하지 않고 "더 큰 쪽 + 작은 쪽의 절반" 까지만 → 부스터가 작전 효과를 집어삼키지 않게
        if (v6 && mult > 1000 && tacMult[i]! > 1000) {
          const hi = Math.max(mult, tacMult[i]!);
          const lo = Math.min(mult, tacMult[i]!);
          const capped = hi + Math.floor((lo - 1000) / 2);
          step = mult === 0 ? 0 : Math.floor((speed[i]! * capped) / 1000);
        } else {
          step = Math.floor((step * tacMult[i]!) / 1000);
        }
      }
      if (v5 && step > 0) {
        // 막판 체력: 마지막 20% 구간에서 남은 체력만큼 버팀(60 기준, 많으면 조금 빠르고 적으면 지침)
        // (체력은 항상 10 단위 → 정수 연산)
        if (pos[i]! >= FATIGUE_FROM) step = Math.floor((step * (1000 + ((stamina[i]! - STAMINA_START) * (v6 ? FATIGUE_PER_10_V6 : FATIGUE_PER_10)) / 10)) / 1000);
        // 바람막이: 바로 앞 DRAFT_GAP_UNITS 안에 달리는 말이 있으면 살짝 덜 힘듦 (순위가 아니라 거리 기준, 선두도 앞말을 따라잡으면 똑같이 받음)
        if (hasCloseAhead(pos, finishTick, n, i, DRAFT_GAP_UNITS)) step = Math.floor((step * (1000 + DRAFT_BONUS)) / 1000);
      }
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

  const hashInput: number[] = [version, seed | 0, raceSeconds, n, totalTicks, events.length];
  for (const s of standings) hashInput.push(s.lane, s.id, s.finishMs ?? -1);
  if (version >= 4) {
    hashInput.push(tacticLog.length);
    for (const r of tacticLog) hashInput.push(r.window, r.lane, TACTIC_CODE[r.tactic], r.applied ? (r.weak ? 2 : 1) : 0);
  }

  return {
    engineVersion: version,
    seed,
    raceSeconds,
    baseSpeed: tune.base,
    entrants,
    totalTicks,
    positions,
    events,
    standings,
    finishTick,
    tactics: tacticLog,
    hash: fnv1a(hashInput),
  };
}

const TACTIC_CODE: Record<TacticType, number> = { SAVE: 1, CHASE: 2, SPRINT: 3 };

/** 바로 앞 CHASE_GAP 이내에 달리는 말이 있는가 (따라잡기 조건) */
export function hasCloseAhead(pos: ArrayLike<number>, finishTick: ArrayLike<number>, n: number, lane: number, gap = CHASE_GAP): boolean {
  const me = pos[lane]!;
  for (let j = 0; j < n; j++) {
    if (j === lane || finishTick[j] !== -1) continue;
    const d = pos[j]! - me;
    if (d > 0 && d <= gap) return true;
  }
  return false;
}

/** 가중치 기반 이벤트 선택 */
function pickWeighted(rng: Rng, order: readonly EventType[], total: number): EventType {
  let r = rng.int(total);
  for (const type of order) {
    r -= EVENT_SPECS[type].weight;
    if (r < 0) return type;
  }
  return order[0]!; // 도달 불가
}

/**
 * 부스터 받을 말 선택: 달리는 중 · 다른 이벤트 없음 · 쿨다운 끝난 말 중에서
 * 뒤쪽 순위일수록 조금 더 높은 가중치 (선두 1 · 2위 4 · 3위 5 … 7위 이하 9). 번호(게이트)와는 무관.
 */
function pickBoostLane(
  rng: Rng,
  pos: Int32Array,
  finishTick: Int32Array,
  evType: (EventType | null)[],
  readyAt: Int32Array,
  t: number,
  n: number,
  flat = false,
): number {
  const running: number[] = [];
  for (let i = 0; i < n; i++) if (finishTick[i] === -1) running.push(i);
  running.sort((a, b) => (pos[a] !== pos[b] ? pos[b]! - pos[a]! : a - b)); // 앞쪽부터
  const cand: number[] = [];
  const weight: number[] = [];
  let total = 0;
  running.forEach((lane, rank) => {
    if (evType[lane] !== null || t < readyAt[lane]!) return;
    const w = flat ? 1 : rank === 0 ? 1 : 3 + Math.min(rank, 6);
    cand.push(lane);
    weight.push(w);
    total += w;
  });
  if (total === 0) return -1;
  let r = rng.int(total);
  for (let k = 0; k < cand.length; k++) {
    r -= weight[k]!;
    if (r < 0) return cand[k]!;
  }
  return -1;
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
