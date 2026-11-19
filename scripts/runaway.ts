/**
 * 선두 독주 측정 (npm run runaway [-- 엔진버전]): 마지막 직선 전 최대 선두-2위 격차, 20m 이상 독주한 경기 비율,
 * 500m 지점 1~5위 격차, 800m 지점 선두 10m 안에 있는 말 수, 800m 선두의 우승률. 참가자 작전은 네 가지 성향을 섞음
 */
import { demoEntrants } from '../src/data/demo';
import { Rng, TACTIC_TYPES, simulateRaceVersion, tacticWindowCount, type TacticOrder } from '../src/engine';

const V = Number(process.argv[2] ?? 8);
const WN = tacticWindowCount(V);
const SEEDS = 150;
const seedOf = (k: number) => (Math.imul(k + 1, 2654435761) ^ 0x5eed) >>> 0;
function mixed(seed: number, n: number): TacticOrder[] {
  const rng = new Rng((seed ^ 0xa11ce) >>> 0);
  const out: TacticOrder[] = [];
  for (let id = 1; id <= n; id++) {
    const st = rng.int(4);
    for (let w = 1; w <= WN; w++) {
      const t = st === 0 ? (w < WN - 1 ? 'SAVE' : 'SPRINT') : st === 1 ? (w === 1 ? 'SPRINT' : 'CHASE') : st === 2 ? 'CHASE' : rng.chance(1, 3) ? null : TACTIC_TYPES[rng.int(3)]!;
      if (t) out.push({ id, window: w, tactic: t as TacticOrder['tactic'] });
    }
  }
  return out;
}
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.floor(a.length * p)]!;
console.log(`v${V} | 말 초 | 620m 전 최대 선두-2위 격차 평균/90% | 선두 20m+ 독주 경기 | 중간(500m) 1-5위 격차 | 800m 선두 10m 안 말 수 평균 | 800m 선두 우승률`);
for (const n of [10, 20]) for (const s of [30, 70, 120]) {
  const maxLead: number[] = [];
  const mid15: number[] = [];
  const near800: number[] = [];
  let runaway = 0;
  let lead800win = 0;
  for (let k = 0; k < SEEDS; k++) {
    const seed = seedOf(k);
    const r = simulateRaceVersion(V, { seed, entrants: demoEntrants(n), raceSeconds: s, tactics: mixed(seed, n) });
    let ml = 0;
    let gotMid = false;
    for (let t = 1; t <= r.totalTicks; t++) {
      const ps = Array.from({ length: n }, (_, i) => r.positions[t * n + i]!);
      const sorted = [...ps].sort((a, b) => b - a);
      if (sorted[0]! >= 620_000) break;
      ml = Math.max(ml, sorted[0]! - sorted[1]!);
      if (!gotMid && sorted[0]! >= 500_000) {
        gotMid = true;
        mid15.push((sorted[0]! - sorted[Math.min(4, n - 1)]!) / 1000);
      }
    }
    maxLead.push(ml / 1000);
    if (ml >= 20_000) runaway++;
    for (let t = 1; t <= r.totalTicks; t++) {
      const ps = Array.from({ length: n }, (_, i) => r.positions[t * n + i]!);
      const lead = Math.max(...ps);
      if (lead >= 800_000) {
        near800.push(ps.filter((p) => lead - p <= 10_000).length);
        if (ps.indexOf(lead) === r.standings[0]!.lane) lead800win++;
        break;
      }
    }
  }
  console.log(`   | ${n} ${s} | ${mean(maxLead).toFixed(1)} / ${pct(maxLead, 0.9).toFixed(1)}m | ${Math.round((runaway / SEEDS) * 100)}% | ${mean(mid15).toFixed(1)}m | ${mean(near800).toFixed(1)} | ${Math.round((lead800win / SEEDS) * 100)}%`);
}
