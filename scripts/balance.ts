/**
 * 경주 밸런스 측정 (npm run balance [-- 버전])
 *  - 구간별 1~3위 격차 (출발 직선 끝 280m · 마지막 직선 진입 620m · 잔여 200m 800m)
 *  - 그 지점의 선두가 우승한 비율 (= 언제 승부가 굳는지)
 *  - 마지막 직선(620m~) 선두 교체 횟수 (0.5초 이상 유지된 교체만)
 *  - 1·2위 결승 기록 차이, 3차 작전 효과가 끝난 뒤 1등 도착까지 남은 시간
 * 참가자 작전은 몇 가지 성향을 섞어 흉내 냄 (같은 시드·같은 작전이면 결과가 같음)
 */
import { demoEntrants } from '../src/data/demo';
import { Rng, TACTIC_TYPES, TICK_MS, TRACK_LENGTH, simulateRaceVersion, tacticWindowCount, tacticWindows, type TacticOrder } from '../src/engine';

const VERSION = Number(process.argv[2] ?? 8);
const WN = tacticWindowCount(VERSION);
const ONLY_MIXED = process.argv[3] === 'mixed';
const SEEDS = 150;
const seedOf = (k: number) => (Math.imul(k + 1, 2654435761) ^ 0x5eed) >>> 0;

type Policy = 'none' | 'mixed';
const STYLE_NAMES = ['아끼고 막판', '초반 질주', '따라잡기만', '무작위'];
let styleOf = new Map<number, number>();
function tactics(seed: number, n: number, policy: Policy): TacticOrder[] | undefined {
  styleOf = new Map();
  if (policy === 'none') return undefined;
  const rng = new Rng((seed ^ 0xa11ce) >>> 0);
  const out: TacticOrder[] = [];
  for (let id = 1; id <= n; id++) {
    const style = rng.int(4);
    styleOf.set(id, style); // 0 아끼고 막판 · 1 초반 질주 · 2 따라잡기 위주 · 3 무작위/안 고름
    for (let w = 1; w <= WN; w++) {
      let t: (typeof TACTIC_TYPES)[number] | null;
      if (style === 0) t = w < WN - 1 ? 'SAVE' : 'SPRINT';
      else if (style === 1) t = w === 1 ? 'SPRINT' : w === 2 ? 'SAVE' : 'SPRINT';
      else if (style === 2) t = 'CHASE';
      else t = rng.chance(1, 3) ? null : TACTIC_TYPES[rng.int(3)]!;
      if (t) out.push({ id, window: w, tactic: t });
    }
  }
  return out;
}

function pct(a: number[], p: number) {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]!;
}
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;

for (const policy of (ONLY_MIXED ? ['mixed'] : ['none', 'mixed']) as Policy[]) {
  console.log(`\n=== 엔진 v${VERSION} · 작전: ${policy === 'none' ? '없음' : '섞어서'} ===`);
  console.log('말 초 | 280m 1-3위격차 · 선두우승 | 620m 1-2격차 1-3격차 · 선두우승 | 800m 선두우승 | 막판 선두교체 평균(0회비율) | 1-2위 기록차 중앙값(0.3초내) | 3차작전 후 남은시간');
  for (const n of [10, 20]) {
    for (const s of [30, 70]) {
      const g280: number[] = [];
      const g12: number[] = [];
      const g13: number[] = [];
      let lead280 = 0;
      let lead620 = 0;
      let lead800 = 0;
      const changes: number[] = [];
      const finGap: number[] = [];
      const left: number[] = [];
      const winners = new Map<number, number>();
      const styleWins = [0, 0, 0, 0];
      const styleCount = [0, 0, 0, 0];
      for (let k = 0; k < SEEDS; k++) {
        const seed = seedOf(k);
        const r = simulateRaceVersion(VERSION, { seed, entrants: demoEntrants(n), raceSeconds: s, tactics: tactics(seed, n, policy) });
        const N = r.entrants.length;
        const winLane = r.standings[0]!.lane;
        winners.set(r.standings[0]!.id, (winners.get(r.standings[0]!.id) ?? 0) + 1);
        if (styleOf.size) {
          for (const st of styleOf.values()) styleCount[st]!++;
          styleWins[styleOf.get(r.standings[0]!.id)!]!++;
        }
        const at = (mark: number) => {
          for (let t = 0; t <= r.totalTicks; t++) {
            let best = -1;
            let bp = -1;
            for (let i = 0; i < N; i++) if (r.positions[t * N + i]! > bp) [bp, best] = [r.positions[t * N + i]!, i];
            if (bp >= mark) {
              const ps = Array.from({ length: N }, (_, i) => r.positions[t * N + i]!).sort((a, b) => b - a);
              return { t, leader: best, gap2: (ps[0]! - (ps[1] ?? ps[0]!)) / 1000, gap3: (ps[0]! - (ps[2] ?? ps[1] ?? ps[0]!)) / 1000 };
            }
          }
          return null;
        };
        const a280 = at(TRACK_LENGTH * 0.28)!;
        const a620 = at(TRACK_LENGTH * 0.62)!;
        const a800 = at(TRACK_LENGTH * 0.8)!;
        g280.push(a280.gap3);
        g12.push(a620.gap2);
        g13.push(a620.gap3);
        if (a280.leader === winLane) lead280++;
        if (a620.leader === winLane) lead620++;
        if (a800.leader === winLane) lead800++;
        // 마지막 직선 선두 교체 (10틱 이상 유지)
        let cur = a620.leader;
        let cand = cur;
        let since = a620.t;
        let c = 0;
        const firstFin = Math.min(...Array.from(r.finishTick).filter((x) => x >= 0));
        for (let t = a620.t; t <= firstFin; t++) {
          let best = 0;
          for (let i = 1; i < N; i++) if (r.positions[t * N + i]! > r.positions[t * N + best]!) best = i;
          if (best !== cand) {
            cand = best;
            since = t;
          }
          if (cand !== cur && t - since >= 10) {
            cur = cand;
            c++;
          }
        }
        changes.push(c);
        finGap.push(((r.standings[1]?.finishMs ?? 0) - r.standings[0]!.finishMs!) / 1000);
        const w3 = tacticWindows(s)[2]!;
        left.push((r.standings[0]!.finishMs! - w3.endTick * TICK_MS) / 1000);
      }
      const f = (x: number) => x.toFixed(1).padStart(5);
      console.log(
        (styleOf.size || policy === 'mixed' ? '' : '') + `${String(n).padStart(2)} ${String(s).padStart(2)} | ${f(mean(g280))}m · ${String(Math.round((lead280 / SEEDS) * 100)).padStart(3)}% | ${f(mean(g12))} ${f(mean(g13))}m · ${String(Math.round((lead620 / SEEDS) * 100)).padStart(3)}% | ${String(Math.round((lead800 / SEEDS) * 100)).padStart(3)}% | ${mean(changes).toFixed(2)} (${Math.round((changes.filter((x) => x === 0).length / SEEDS) * 100)}%) | ${pct(finGap, 0.5).toFixed(2)}s (${Math.round((finGap.filter((x) => x <= 0.3).length / SEEDS) * 100)}%) | ${pct(left, 0).toFixed(1)}~${pct(left, 0.5).toFixed(1)}s` +
          (policy === 'mixed'
            ? ' | 우승 배율 ' + STYLE_NAMES.map((nm, i) => `${nm} ${((styleWins[i]! / SEEDS) / (styleCount[i]! / SEEDS / n) / n * n).toFixed(2)}`).join(' · ')
            : ''),
      );
    }
  }
}
