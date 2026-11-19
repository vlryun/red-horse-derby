import { describe, expect, it } from 'vitest';
import { demoEntrants } from '../../data/demo';
import {
  ENGINE_VERSION,
  RACE_SECONDS,
  RaceInputError,
  Rng,
  TICK_MS,
  TRACK_LENGTH,
  activeEventsAtTick,
  rankingAtTick,
  sampleProgress,
  simulateRace,
  tickAt,
  BOOST_COOLDOWN_TICKS,
  BOOST_STAGGER_TICKS,
  EVENT_SPECS,
  isSupportedEngine,
  simulateRaceVersion,
  tacticWindows,
  type RaceResult,
} from '..';

const fifty = demoEntrants(50);
const seedOf = (k: number) => (Math.imul(k + 1, 2654435761) ^ 0x5eed) >>> 0;

describe('Rng', () => {
  it('같은 시드 → 같은 수열', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    for (let i = 0; i < 1000; i++) expect(a.nextU32()).toBe(b.nextU32());
  });
  it('int(n) 은 항상 0..n-1', () => {
    const r = new Rng(7);
    for (let i = 0; i < 10000; i++) {
      const v = r.int(50);
      expect(v >= 0 && v < 50 && Number.isInteger(v)).toBe(true);
    }
  });
  it('잘못된 범위 거부', () => {
    expect(() => new Rng(1).int(0)).toThrow(RangeError);
  });
});

describe('결정론 (모든 기기에서 동일 결과)', () => {
  it('같은 입력을 여러 번 돌려도 위치/순위/이벤트/해시가 완전히 동일', () => {
    const a = simulateRace({ seed: 123456, entrants: fifty });
    const b = simulateRace({ seed: 123456, entrants: fifty });
    expect(a.hash).toBe(b.hash);
    expect(a.totalTicks).toBe(b.totalTicks);
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
    expect(a.events).toEqual(b.events);
    expect(a.standings).toEqual(b.standings);
  });

  it('GOLDEN: 엔진 로직이 바뀌면 실패 → ENGINE_VERSION 을 올리고 값 갱신할 것 (v3 = v4 작전 없음)', () => {
    const r = simulateRaceVersion(3, { seed: 20261127, entrants: fifty });
    expect(ENGINE_VERSION).toBe(8);
    expect(r.engineVersion).toBe(3);
    expect({
      hash: r.hash,
      totalTicks: r.totalTicks,
      top3: r.standings.slice(0, 3).map((s) => s.id),
      events: r.events.length,
    }).toMatchInlineSnapshot(`
      {
        "events": 33,
        "hash": "a11f1b68",
        "top3": [
          38,
          13,
          35,
        ],
        "totalTicks": 1561,
      }
    `);
  });

  it('입력 배열을 변경하지 않는다', () => {
    const input = { seed: 1, entrants: demoEntrants(10) };
    const copy = JSON.parse(JSON.stringify(input));
    simulateRace(input);
    expect(input).toEqual(copy);
  });

  it('시드가 다르면 결과가 다르다', () => {
    const hashes = new Set<string>();
    for (let k = 0; k < 50; k++) hashes.add(simulateRace({ seed: seedOf(k), entrants: fifty }).hash);
    expect(hashes.size).toBe(50);
  });
});

describe('경주 규칙', () => {
  const results = Array.from({ length: 300 }, (_, k) => simulateRace({ seed: seedOf(k), entrants: fifty }));

  it('모든 말이 완주하고 순위는 1..50 의 순열', () => {
    for (const r of results) {
      expect(r.standings.map((s) => s.rank)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
      expect(new Set(r.standings.map((s) => s.lane)).size).toBe(50);
      for (const s of r.standings) expect(s.finishMs).not.toBeNull();
    }
  });

  it('도착 시간은 순위 순서로 단조 증가(동착 허용)', () => {
    for (const r of results) {
      for (let i = 1; i < r.standings.length; i++) {
        expect(r.standings[i]!.finishMs!).toBeGreaterThanOrEqual(r.standings[i - 1]!.finishMs!);
      }
    }
  });

  it('경주 시간 60~90초', () => {
    for (const r of results) {
      const winner = r.standings[0]!.finishMs!;
      const total = r.totalTicks * TICK_MS;
      expect(winner).toBeGreaterThan(55_000);
      expect(total).toBeLessThan(90_000);
    }
  });

  it('위치는 절대 뒤로 가지 않는다', () => {
    const r = results[0]!;
    const n = 50;
    for (let t = 1; t <= r.totalTicks; t++) {
      for (let i = 0; i < n; i++) {
        expect(r.positions[t * n + i]!).toBeGreaterThanOrEqual(r.positions[(t - 1) * n + i]!);
      }
    }
  });

  it('이벤트는 경주당 적당히 발생하고, 결승 통과한 말에게는 새로 생기지 않는다', () => {
    for (const r of results) {
      expect(r.events.length).toBeGreaterThan(5);
      expect(r.events.length).toBeLessThan(70);
      for (const e of r.events) {
        const ft = r.finishTick[e.horse]!;
        expect(ft === -1 || e.tick <= ft).toBe(true);
      }
    }
  });

  it('1등은 실제로 가장 먼저 결승선(TRACK_LENGTH)을 넘은 말', () => {
    for (const r of results) {
      const w = r.standings[0]!.lane;
      const ft = r.finishTick[w]!;
      const n = 50;
      expect(r.positions[ft * n + w]!).toBeGreaterThanOrEqual(TRACK_LENGTH);
      for (let i = 0; i < n; i++) expect(r.positions[(ft - 1) * n + i]!).toBeLessThan(TRACK_LENGTH);
    }
  });
});

describe('경주 시간 설정', () => {
  it.each([30, 45, 90, 120, 180])('%i초 설정 → 1등 도착이 설정값 ±10%%, 전원 완주', (sec) => {
    for (let k = 0; k < 40; k++) {
      const r = simulateRace({ seed: seedOf(k + 500), entrants: fifty, raceSeconds: sec });
      const w = r.standings[0]!.finishMs! / 1000;
      expect(w).toBeGreaterThan(sec * 0.9);
      expect(w).toBeLessThan(sec * 1.1);
      for (const s of r.standings) expect(s.finishMs).not.toBeNull();
      expect(r.raceSeconds).toBe(sec);
    }
  });

  it('기본값(미지정) = 70초 설정과 완전히 동일', () => {
    const a = simulateRace({ seed: 42, entrants: fifty });
    const b = simulateRace({ seed: 42, entrants: fifty, raceSeconds: RACE_SECONDS.default });
    expect(a.hash).toBe(b.hash);
  });

  it('경주 시간이 다르면 해시가 다르다 (서버·클라이언트 설정 불일치 검출)', () => {
    const a = simulateRace({ seed: 42, entrants: fifty, raceSeconds: 60 });
    const b = simulateRace({ seed: 42, entrants: fifty, raceSeconds: 61 });
    expect(a.hash).not.toBe(b.hash);
  });
});

describe('공정성', () => {
  it('게이트 번호에 따른 유불리 없음 (1500경기)', () => {
    const wins = new Array<number>(50).fill(0);
    const N = 1500;
    for (let k = 0; k < N; k++) wins[simulateRace({ seed: seedOf(k + 10_000), entrants: fifty }).standings[0]!.lane]!++;
    // 기대값 30, 이항분포 표준편차 ≈5.4 → 매우 느슨한 경계 (±5σ)
    for (const w of wins) {
      expect(w).toBeGreaterThan(3);
      expect(w).toBeLessThan(58);
    }
    // 카이제곱 (자유도 49): 99.9% 임계값 ≈ 85.4
    const exp = N / 50;
    const chi = wins.reduce((s, w) => s + ((w - exp) * (w - exp)) / exp, 0);
    expect(chi).toBeLessThan(86);
  });
});

describe('입력 검증 (비정상 요청 차단)', () => {
  const bad: [string, unknown][] = [
    ['null', null],
    ['음수 시드', { seed: -1, entrants: fifty }],
    ['소수 시드', { seed: 1.5, entrants: fifty }],
    ['너무 큰 시드', { seed: 2 ** 32, entrants: fifty }],
    ['문자열 시드', { seed: '1', entrants: fifty }],
    ['참가자 0명', { seed: 1, entrants: [] }],
    ['참가자 51명', { seed: 1, entrants: Array.from({ length: 51 }, (_, i) => ({ id: i + 1, name: 'a' })) }],
    ['번호 중복', { seed: 1, entrants: [{ id: 1, name: 'a' }, { id: 1, name: 'b' }] }],
    ['번호 0', { seed: 1, entrants: [{ id: 0, name: 'a' }] }],
    ['빈 닉네임', { seed: 1, entrants: [{ id: 1, name: '   ' }] }],
    ['긴 닉네임', { seed: 1, entrants: [{ id: 1, name: '가'.repeat(13) }] }],
    ['경주시간 29초', { seed: 1, entrants: fifty, raceSeconds: 29 }],
    ['경주시간 181초', { seed: 1, entrants: fifty, raceSeconds: 181 }],
    ['경주시간 소수', { seed: 1, entrants: fifty, raceSeconds: 60.5 }],
    ['경주시간 문자열', { seed: 1, entrants: fifty, raceSeconds: '60' }],
  ];
  it.each(bad)('%s → RaceInputError', (_, input) => {
    expect(() => simulateRace(input as never)).toThrow(RaceInputError);
  });

  it('1명 경주도 정상 동작', () => {
    const r = simulateRace({ seed: 9, entrants: [{ id: 7, name: '혼자' }] });
    expect(r.standings[0]!.id).toBe(7);
  });
});

describe('조회 함수 (화면 표시)', () => {
  const r = simulateRace({ seed: 777, entrants: fifty });

  it('tickAt 은 범위를 벗어난 시간/NaN 을 안전하게 처리', () => {
    expect(tickAt(r, -500)).toBe(0);
    expect(tickAt(r, Number.NaN)).toBe(0);
    expect(tickAt(r, 1e12)).toBe(r.totalTicks);
  });

  it('종료 시점 순위 = 최종 순위', () => {
    expect(rankingAtTick(r, r.totalTicks)).toEqual(r.standings.map((s) => s.lane));
    expect(rankingAtTick(r, r.totalTicks - 1)).toEqual(r.standings.map((s) => s.lane));
  });

  it('보간 진행률은 0..1.05', () => {
    const out = new Float64Array(50);
    for (const ms of [0, 1234.5, 40_000, 1e9]) {
      sampleProgress(r, ms, out);
      for (const p of out) expect(p >= 0 && p <= 1.05).toBe(true);
    }
  });

  it('진행 중 이벤트 조회', () => {
    const e = r.events[0]!;
    expect(activeEventsAtTick(r, e.tick).get(e.horse)?.type).toBe(e.type);
    expect(activeEventsAtTick(r, e.tick - 1).get(e.horse)).toBeUndefined();
  });
});

describe('v3 부스터 분배 · 막판 스퍼트', () => {
  const BOOSTS = new Set(['CARROT', 'FART', 'CRAZY']);
  const cases = [
    [10, 30],
    [10, 70],
    [20, 30],
    [20, 70],
  ] as const;

  it('같은 말에게 부스터가 연속으로 몰리지 않는다 (끝난 뒤 쿨다운) · 부스터끼리 시작 시차', () => {
    for (const [n, sec] of cases) {
      const cd = Math.floor((BOOST_COOLDOWN_TICKS * sec) / 70);
      const st = Math.floor((BOOST_STAGGER_TICKS * sec) / 70);
      for (let k = 0; k < 40; k++) {
        const r = simulateRace({ seed: seedOf(k), entrants: demoEntrants(n), raceSeconds: sec });
        const lastEnd = new Map<number, number>();
        let lastStart = -1e9;
        for (const e of r.events) {
          if (!BOOSTS.has(e.type)) {
            if (EVENT_SPECS[e.type].good) lastEnd.set(e.horse, e.endTick);
            continue;
          }
          const prev = lastEnd.get(e.horse);
          if (prev !== undefined) expect(e.tick).toBeGreaterThanOrEqual(prev + cd);
          expect(e.tick - lastStart).toBeGreaterThanOrEqual(st);
          lastStart = e.tick;
          lastEnd.set(e.horse, e.endTick);
        }
      }
    }
  });

  it('막판 스퍼트는 선두가 잔여 200m 에 들어온 뒤에만, 경주당 최대 5번, 말마다 한 번', () => {
    for (const [n, sec] of cases) {
      for (let k = 0; k < 40; k++) {
        const r = simulateRace({ seed: seedOf(k), entrants: demoEntrants(n), raceSeconds: sec });
        const sp = r.events.filter((e) => e.type === 'SPURT');
        expect(sp.length).toBeLessThanOrEqual(5);
        expect(new Set(sp.map((e) => e.horse)).size).toBe(sp.length);
        for (const e of sp) {
          let lead = 0;
          for (let i = 0; i < n; i++) lead = Math.max(lead, r.positions[(e.tick - 1) * n + i]!);
          expect(lead).toBeGreaterThanOrEqual(TRACK_LENGTH * 0.8);
        }
      }
    }
  });

  it('부스터는 초반·중반·후반에 골고루 (각 구간 평균 4회 이상)', () => {
    let early = 0;
    let mid = 0;
    let late = 0;
    const N = 60;
    for (let k = 0; k < N; k++) {
      const r = simulateRace({ seed: seedOf(k), entrants: demoEntrants(20), raceSeconds: 70 });
      const wt = r.finishTick[r.standings[0]!.lane]!;
      for (const e of r.events) {
        if (!EVENT_SPECS[e.type].good) continue;
        if (e.tick < wt / 3) early++;
        else if (e.tick < (2 * wt) / 3) mid++;
        else late++;
      }
    }
    expect(early / N).toBeGreaterThan(4);
    expect(mid / N).toBeGreaterThan(4);
    expect(late / N).toBeGreaterThan(4);
  });
});

describe('이전 버전 엔진 보관 (배포 직후 예전 화면에서 시작된 경주 재생)', () => {
  it('v2 보관본은 v2 시절 GOLDEN 값을 그대로 재현한다', () => {
    const r = simulateRaceVersion(2, { seed: 20261127, entrants: fifty });
    expect(r.engineVersion).toBe(2);
    expect({ hash: r.hash, totalTicks: r.totalTicks, top3: r.standings.slice(0, 3).map((s) => s.id), events: r.events.length }).toEqual({
      hash: '33910588',
      totalTicks: 1529,
      top3: [16, 13, 11],
      events: 27,
    });
  });
  it('현재 버전은 simulateRace 와 같고, 모르는 버전은 거부', () => {
    const input = { seed: 77, entrants: demoEntrants(12), raceSeconds: 45 };
    expect(simulateRaceVersion(ENGINE_VERSION, input).hash).toBe(simulateRace(input).hash);
    expect(isSupportedEngine(2) && isSupportedEngine(3) && isSupportedEngine(4) && isSupportedEngine(5) && isSupportedEngine(6) && isSupportedEngine(7) && isSupportedEngine(ENGINE_VERSION)).toBe(true);
    expect(isSupportedEngine(1)).toBe(false);
    expect(() => simulateRaceVersion(99, input)).toThrow();
  });
});

describe('v4 참가자 작전', () => {
  const pos = (r: RaceResult, tick: number, lane: number) => r.positions[tick * r.entrants.length + lane]!;

  it('v4 는 작전이 없으면 v3 와 위치·이벤트·순위가 완전히 같다 (예전 경주 재생 보장)', () => {
    for (const n of [10, 20]) {
      const input = { seed: 4242 + n, entrants: demoEntrants(n), raceSeconds: 70 };
      const a = simulateRaceVersion(4, input);
      const b = simulateRaceVersion(3, input);
      expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
      expect(a.events).toEqual(b.events);
      expect(a.standings).toEqual(b.standings);
      expect(a.tactics).toEqual([]);
    }
  });

  it('작전 창: v7 3번 · v8 5번, 30~180초 모든 설정에서 겹치지 않고(앞 창 적용 뒤 열림), 효과는 1등 도착 전에 끝난다', () => {
    for (const [ver, cnt] of [[7, 3], [8, 5]] as const) {
      for (let s = RACE_SECONDS.min; s <= RACE_SECONDS.max; s++) {
        const w = tacticWindows(s, ver);
        expect(w).toHaveLength(cnt);
        expect(w[0]!.openMs).toBeGreaterThan(0);
        for (let k = 0; k < cnt; k++) {
          const x = w[k]!;
          expect(x.closeMs - x.openMs).toBeGreaterThanOrEqual(3000);
          expect(x.closeMs - x.openMs).toBeLessThanOrEqual(6000);
          expect(x.applyTick * TICK_MS).toBeGreaterThan(x.closeMs);
          if (k > 0) expect(x.openMs).toBeGreaterThan(w[k - 1]!.applyTick * TICK_MS);
        }
        // 마지막 효과 끝 → 1등 도착(≈ 설정 시간)까지 v7 20%·v8 10% 이상 여유 (30초 경기 v8: 약 4초)
        expect(w[cnt - 1]!.endTick * TICK_MS).toBeLessThan(s * 1000 * (ver >= 8 ? 0.9 : 0.8));
      }
    }
    expect(tacticWindows(70, 7).map((x) => x.closeMs - x.openMs)).toEqual([6000, 6000, 6000]);
  });

  it('10·20마리 실제 경주에서 세 창이 모두 1등 도착 전에 열리고 닫힌다', () => {
    for (const n of [10, 20]) {
      for (const s of [30, 70, 180]) {
        for (let k = 0; k < 20; k++) {
          const r = simulateRace({ seed: seedOf(k), entrants: demoEntrants(n), raceSeconds: s });
          const first = r.standings[0]!.finishMs!;
          for (const w of tacticWindows(s)) expect(w.endTick * TICK_MS).toBeLessThan(first);
        }
      }
    }
  });

  it('같은 시드에서 작전을 바꾸면 적용 틱 이후 주행만 달라진다 (이전 구간은 그대로)', () => {
    const entrants = demoEntrants(10);
    const base = simulateRace({ seed: 99, entrants });
    const w = tacticWindows(70);
    const id = entrants[4]!.id;
    const withT = simulateRace({ seed: 99, entrants, tactics: [{ id, window: 1, tactic: 'SPRINT' }] });
    const lane = 4;
    for (let t = 0; t < w[0]!.applyTick; t++) expect(pos(withT, t, lane)).toBe(pos(base, t, lane));
    expect(pos(withT, w[0]!.endTick, lane)).toBeGreaterThan(pos(base, w[0]!.endTick, lane));
    expect(withT.hash).not.toBe(base.hash);
    expect(withT.tactics).toHaveLength(1);
    expect(withT.tactics![0]).toMatchObject({ applied: true, staminaBefore: 60, staminaAfter: 30, tactic: 'SPRINT' });
    // 재현성: 같은 입력이면 같은 결과
    expect(simulateRace({ seed: 99, entrants, tactics: [{ id, window: 1, tactic: 'SPRINT' }] }).hash).toBe(withT.hash);
  });

  it('(v4) 체력 아끼기는 느려지고 체력 +20, 전력 질주는 체력 30 이 없으면 적용 안 됨', () => {
    const entrants = demoEntrants(10);
    const id = entrants[2]!.id;
    const base = simulateRaceVersion(4, { seed: 5, entrants });
    const w = tacticWindows(70);
    const save = simulateRaceVersion(4, { seed: 5, entrants, tactics: [{ id, window: 1, tactic: 'SAVE' }] });
    expect(pos(save, w[0]!.endTick, 2)).toBeLessThan(pos(base, w[0]!.endTick, 2));
    expect(save.tactics![0]).toMatchObject({ applied: true, staminaAfter: 80 });
    const three = simulateRaceVersion(4, {
      seed: 5,
      entrants,
      tactics: [1, 2, 3].map((window) => ({ id, window, tactic: 'SPRINT' as const })),
    });
    expect(three.tactics!.map((x) => [x.applied, x.staminaAfter, x.reason])).toEqual([
      [true, 30, null],
      [true, 0, null],
      [false, 0, 'NO_STAMINA'],
    ]);
  });

  it('조건이 되는 말은 따라잡기를 세 번 연속 적용할 수 있다', () => {
    let found = 0;
    for (let k = 0; k < 200 && found < 5; k++) {
      const entrants = demoEntrants(20);
      const seed = seedOf(k);
      // 맨 뒤쪽 말일수록 앞말이 가까울 가능성이 큼 → 가운데 말로 시험
      for (const lane of [8, 10, 12]) {
        const id = entrants[lane]!.id;
        const r = simulateRace({ seed, entrants, tactics: [1, 2, 3].map((window) => ({ id, window, tactic: 'CHASE' as const })) });
        const recs = r.tactics!.filter((x) => x.lane === lane);
        if (recs.every((x) => x.applied)) {
          expect(recs.map((x) => x.staminaAfter)).toEqual([50, 40, 30]);
          found++;
          break;
        }
      }
    }
    expect(found).toBe(5);
  });

  it('(v4) 앞말이 없으면(선두) 따라잡기는 적용되지 않고 체력도 그대로', () => {
    const entrants = demoEntrants(10);
    const base = simulateRaceVersion(4, { seed: 11, entrants });
    const w = tacticWindows(70);
    const leader = rankingAtTick(base, w[0]!.applyTick - 1)[0]!;
    const r = simulateRaceVersion(4, { seed: 11, entrants, tactics: [{ id: entrants[leader]!.id, window: 1, tactic: 'CHASE' }] });
    // 선두 바로 앞에는 말이 없음
    expect(r.tactics![0]).toMatchObject({ applied: false, reason: 'NO_TARGET', staminaAfter: 60 });
    expect(Array.from(r.positions)).toEqual(Array.from(base.positions));
  });

  it('작전 기록 검증: 중복·없는 번호·잘못된 창은 거부', () => {
    const entrants = demoEntrants(3);
    const id = entrants[0]!.id;
    expect(() => simulateRace({ seed: 1, entrants, tactics: [{ id, window: 1, tactic: 'SAVE' }, { id, window: 1, tactic: 'CHASE' }] })).toThrow(RaceInputError);
    expect(() => simulateRace({ seed: 1, entrants, tactics: [{ id: 999, window: 1, tactic: 'SAVE' }] })).toThrow(RaceInputError);
    expect(() => simulateRace({ seed: 1, entrants, tactics: [{ id, window: 6, tactic: 'SAVE' }] })).toThrow(RaceInputError);
  });

  it('작전이 있으면 경주마다 결과가 실제로 달라질 수 있다 (20마리 중 몇 경기는 우승자가 바뀜)', () => {
    let changed = 0;
    for (let k = 0; k < 40; k++) {
      const entrants = demoEntrants(20);
      const base = simulateRace({ seed: seedOf(k), entrants });
      const tactics = entrants.flatMap((e, i) => [1, 2, 3].map((window) => ({ id: e.id, window, tactic: (['SAVE', 'CHASE', 'SPRINT'] as const)[(i + window + k) % 3]! })));
      const r = simulateRace({ seed: seedOf(k), entrants, tactics });
      if (r.standings[0]!.id !== base.standings[0]!.id) changed++;
    }
    expect(changed).toBeGreaterThan(3);
  });
});

describe('v5 밸런스 (순위 보정 없음)', () => {
  it('작전이 없으면 막판 체력 효과는 모두 같고(60), 결과는 시드로 재현된다', () => {
    const input = { seed: 777, entrants: demoEntrants(20), raceSeconds: 70 };
    expect(simulateRace(input).hash).toBe(simulateRace(input).hash);
    expect(simulateRace(input).engineVersion).toBe(ENGINE_VERSION);
  });

  it('체력을 아낀 말은 막판(잔여 200m)에 덜 지친다: 같은 시드에서 SAVE 두 번 vs 작전 없음, 800m 이후 구간 속도가 빠름', () => {
    let faster = 0;
    for (let k = 0; k < 30; k++) {
      const entrants = demoEntrants(10);
      const seed = seedOf(k);
      const id = entrants[3]!.id;
      const base = simulateRace({ seed, entrants });
      const saved = simulateRace({ seed, entrants, tactics: [1, 2].map((window) => ({ id, window, tactic: 'SAVE' as const })) });
      const n = 10;
      const t800 = (r: RaceResult) => {
        for (let t = 0; t <= r.totalTicks; t++) if (r.positions[t * n + 3]! >= TRACK_LENGTH * 0.8) return t;
        return r.totalTicks;
      };
      const fin = (r: RaceResult) => r.finishTick[3]!;
      if (fin(saved) - t800(saved) <= fin(base) - t800(base)) faster++;
    }
    // 작전 뒤로는 부스터 등 무작위 사건이 달라지므로 "대부분" 기준
    expect(faster).toBeGreaterThanOrEqual(20);
  });

  it('부스터는 순위와 무관하게 고르게: 선두도 부스터를 받는다', () => {
    let leaderBoosts = 0;
    for (let k = 0; k < 60; k++) {
      const r = simulateRace({ seed: seedOf(k), entrants: demoEntrants(10) });
      for (const e of r.events) {
        if (!EVENT_SPECS[e.type].good || e.type === 'AWAKEN') continue;
        if (rankingAtTick(r, e.tick - 1)[0] === e.horse) leaderBoosts++;
      }
    }
    expect(leaderBoosts).toBeGreaterThan(20);
  });
});

describe('v6 작전 수치', () => {
  const pos = (r: RaceResult, tick: number, lane: number) => r.positions[tick * r.entrants.length + lane]!;

  it('체력 아끼기 +30 · 전력 질주 −30 · 체력 60 에서 질주 두 번 뒤 세 번째는 체력 부족', () => {
    const entrants = demoEntrants(10);
    const id = entrants[2]!.id;
    const save = simulateRace({ seed: 5, entrants, tactics: [{ id, window: 1, tactic: 'SAVE' }] });
    expect(save.tactics![0]).toMatchObject({ applied: true, staminaAfter: 90 });
    const three = simulateRace({ seed: 5, entrants, tactics: [1, 2, 3].map((window) => ({ id, window, tactic: 'SPRINT' as const })) });
    expect(three.tactics!.map((x) => [x.applied, x.staminaAfter, x.reason])).toEqual([
      [true, 30, null],
      [true, 0, null],
      [false, 0, 'NO_STAMINA'],
    ]);
  });

  it('효과 시간: 70초 기준 아끼기 4초 · 따라잡기/질주 6초, 30초 경기에서도 60% 이상', () => {
    const entrants = demoEntrants(10);
    const id = entrants[4]!.id;
    for (const [sec, save, sprint] of [[70, 80, 120], [30, 48, 72]] as const) {
      const r = simulateRace({ seed: 9, entrants, raceSeconds: sec, tactics: [{ id, window: 1, tactic: 'SAVE' }, { id, window: 2, tactic: 'SPRINT' }] });
      const [a, b] = r.tactics!;
      expect(a!.endTick - a!.tick).toBe(save);
      expect(b!.endTick - b!.tick).toBe(sprint);
    }
  });

  it('따라잡기는 앞말이 없어도(선두) 약하게 적용되고 체력 −10', () => {
    const entrants = demoEntrants(10);
    const base = simulateRace({ seed: 11, entrants });
    const w = tacticWindows(70);
    const leader = rankingAtTick(base, w[0]!.applyTick - 1)[0]!;
    const r = simulateRace({ seed: 11, entrants, tactics: [{ id: entrants[leader]!.id, window: 1, tactic: 'CHASE' }] });
    expect(r.tactics![0]).toMatchObject({ applied: true, weak: true, staminaAfter: 50 });
    expect(pos(r, w[0]!.applyTick + 60, leader)).toBeGreaterThan(pos(base, w[0]!.applyTick + 60, leader));
  });

  it('전력 질주는 같은 시드에서 질주 구간 동안 실제로 더 멀리 간다 (+15%)', () => {
    const entrants = demoEntrants(10);
    const id = entrants[6]!.id;
    const base = simulateRace({ seed: 21, entrants });
    const r = simulateRace({ seed: 21, entrants, tactics: [{ id, window: 1, tactic: 'SPRINT' }] });
    const rec = r.tactics![0]!;
    const gained = (pos(r, rec.endTick, 6) - pos(r, rec.tick, 6)) / (pos(base, rec.endTick, 6) - pos(base, rec.tick, 6));
    expect(gained).toBeGreaterThan(1.08);
  });

  it('v5 경주는 예전 수치(아끼기 +20)로 그대로 재생된다', () => {
    const entrants = demoEntrants(10);
    const id = entrants[2]!.id;
    const r = simulateRaceVersion(5, { seed: 5, entrants, tactics: [{ id, window: 1, tactic: 'SAVE' }] });
    expect(r.engineVersion).toBe(5);
    expect(r.tactics![0]).toMatchObject({ applied: true, staminaAfter: 80 });
  });
});

describe('v7 추격 보정 (선두 독주 완화)', () => {
  const runaway = (v: number) => {
    let c = 0;
    for (let k = 0; k < 80; k++) {
      const r = simulateRaceVersion(v, { seed: seedOf(k), entrants: demoEntrants(10) });
      const n = 10;
      for (let t = 1; t <= r.totalTicks; t++) {
        const ps = Array.from({ length: n }, (_, i) => r.positions[t * n + i]!).sort((a, b) => b - a);
        if (ps[0]! >= TRACK_LENGTH * 0.62) break;
        if (ps[0]! - ps[1]! >= 20_000) {
          c++;
          break;
        }
      }
    }
    return c;
  };

  it('선두가 20m 이상 혼자 달아나는 경기가 v6 보다 줄어든다', () => {
    expect(runaway(7)).toBeLessThan(runaway(6));
  });

  it('보정은 실제 주행에만 들어가고 틱마다 위치가 갑자기 튀지 않는다 (한 틱 이동량이 기본 속도의 2배를 넘지 않음, 이벤트 제외)', () => {
    const r = simulateRace({ seed: 31, entrants: demoEntrants(20) });
    const n = 20;
    const active = (t: number, lane: number) => r.events.some((e) => e.horse === lane && e.tick <= t && t < e.endTick);
    for (let t = 2; t < r.totalTicks; t++) {
      for (let i = 0; i < n; i++) {
        if (active(t, i) || (r.finishTick[i]! !== -1 && r.finishTick[i]! <= t)) continue;
        const step = r.positions[t * n + i]! - r.positions[(t - 1) * n + i]!;
        expect(step).toBeLessThanOrEqual(r.baseSpeed * 2);
      }
    }
  });

  it('결승 직전(선두 90% 이후)에는 보정이 없다: 같은 시드의 v6 와 그 구간 속도 규칙이 같음 → 결과는 시드로 재현', () => {
    const input = { seed: 77, entrants: demoEntrants(12), raceSeconds: 45 };
    expect(simulateRace(input).hash).toBe(simulateRace(input).hash);
    expect(simulateRaceVersion(6, input).engineVersion).toBe(6);
    expect(simulateRace(input).engineVersion).toBe(ENGINE_VERSION);
  });
});
