/**
 * 작전 영향 측정 (npm run tactics-impact [-- 엔진버전])
 * 같은 시드 · 다른 말들의 작전 그대로 두고, 한 말(시드마다 무작위로 고른 말)의 작전만 바꿔 비교:
 *   없음 / 따라잡기 3회 / 초반 질주(질주·따라잡기·따라잡기) / 아껴서 막판 질주(아끼기·아끼기·질주)
 *  - 그 말의 평균 순위·우승률, 작전 없음 대비 순위 변화
 *  - 시드마다 가장 좋은 결과를 낸 전략 비율 (한 전략이 독식하는지)
 *  - 박빙에서 "마지막 선택 하나"로 우승이 바뀌는 사례: 앞 두 번은 같고 3차만 (없음·아끼기·따라잡기·질주) 바꿨을 때
 *    그 말이 이기는 선택과 지는 선택이 함께 있는 시드 수
 */
import { demoEntrants } from '../src/data/demo';
import { Rng, TACTIC_TYPES, simulateRaceVersion, type TacticOrder, type TacticType } from '../src/engine';

const VERSION = Number(process.argv[2] ?? 6);
const SEEDS = 120;
const seedOf = (k: number) => (Math.imul(k + 1, 2654435761) ^ 0x5eed) >>> 0;

/** 다른 말들: 네 가지 성향을 섞음 (시드로 고정) */
function others(seed: number, n: number, skip: number): TacticOrder[] {
  const rng = new Rng((seed ^ 0xa11ce) >>> 0);
  const out: TacticOrder[] = [];
  for (let id = 1; id <= n; id++) {
    const style = rng.int(4);
    const picks: (TacticType | null)[] = [];
    for (let w = 1; w <= 3; w++) {
      if (style === 0) picks.push(w < 3 ? 'SAVE' : 'SPRINT');
      else if (style === 1) picks.push(w === 1 ? 'SPRINT' : 'CHASE');
      else if (style === 2) picks.push('CHASE');
      else picks.push(rng.chance(1, 3) ? null : TACTIC_TYPES[rng.int(3)]!);
    }
    if (id === skip) continue;
    picks.forEach((t, i) => t && out.push({ id, window: i + 1, tactic: t }));
  }
  return out;
}

const PLANS: Record<string, (TacticType | null)[]> = {
  '작전 없음': [null, null, null],
  '따라잡기 3회': ['CHASE', 'CHASE', 'CHASE'],
  '초반 질주': ['SPRINT', 'CHASE', 'CHASE'],
  '아껴서 막판 질주': ['SAVE', 'SAVE', 'SPRINT'],
};
const plan = (id: number, p: (TacticType | null)[]) =>
  p.flatMap((t, i) => (t ? [{ id, window: i + 1, tactic: t } as TacticOrder] : []));

console.log(`\n=== 엔진 v${VERSION} · 한 말의 작전만 바꿔 비교 (시드 ${SEEDS}개) ===`);
for (const n of [10, 20]) {
  for (const s of [30, 70]) {
    const names = Object.keys(PLANS);
    const rankSum = Object.fromEntries(names.map((k) => [k, 0]));
    const wins = Object.fromEntries(names.map((k) => [k, 0]));
    const best = Object.fromEntries(names.map((k) => [k, 0]));
    let flipSeeds = 0;
    let closeFlip = 0;
    const gapChange: number[] = [];
    for (let k = 0; k < SEEDS; k++) {
      const seed = seedOf(k);
      const entrants = demoEntrants(n);
      const lane = new Rng(seed ^ 0x77).int(n);
      const id = entrants[lane]!.id;
      const rest = others(seed, n, id);
      const res: Record<string, number> = {};
      let noneRank = 0;
      for (const nm of names) {
        const r = simulateRaceVersion(VERSION, { seed, entrants, raceSeconds: s, tactics: [...rest, ...plan(id, PLANS[nm]!)] });
        const rank = r.standings.find((x) => x.id === id)!.rank;
        res[nm] = rank;
        rankSum[nm]! += rank;
        if (rank === 1) wins[nm]!++;
        if (nm === '작전 없음') noneRank = rank;
      }
      const bestRank = Math.min(...Object.values(res));
      const bests = names.filter((nm) => res[nm] === bestRank);
      for (const b of bests) best[b]! += 1 / bests.length;
      gapChange.push(noneRank - Math.min(...names.filter((x) => x !== '작전 없음').map((x) => res[x]!)));

      // 마지막 선택 하나: 앞 두 번은 "따라잡기·따라잡기" 로 고정, 3차만 바꿈
      const last: Record<string, { rank: number; gap: number }> = {};
      for (const t3 of [null, 'SAVE', 'CHASE', 'SPRINT'] as (TacticType | null)[]) {
        const r = simulateRaceVersion(VERSION, { seed, entrants, raceSeconds: s, tactics: [...rest, ...plan(id, ['CHASE', 'CHASE', t3])] });
        const me = r.standings.find((x) => x.id === id)!;
        last[String(t3)] = { rank: me.rank, gap: Math.abs((r.standings[1]!.finishMs ?? 0) - r.standings[0]!.finishMs!) };
      }
      const ranks = Object.values(last).map((x) => x.rank);
      if (ranks.includes(1) && ranks.some((x) => x > 1)) {
        flipSeeds++;
        if (Object.values(last).some((x) => x.rank === 1 && x.gap < 300)) closeFlip++;
      }
    }
    const f = (x: number) => (x / SEEDS).toFixed(1);
    const pctS = (x: number) => `${Math.round((x / SEEDS) * 100)}%`;
    console.log(
      `${n}마리 ${s}초 | 평균 순위 ${names.map((nm) => `${nm} ${f(rankSum[nm]!)}`).join(' · ')}` +
        `\n          | 우승률 ${names.map((nm) => `${nm} ${pctS(wins[nm]!)}`).join(' · ')}` +
        `\n          | 가장 좋았던 전략 ${names.map((nm) => `${nm} ${pctS(best[nm]!)}`).join(' · ')}` +
        `\n          | 작전으로 오른 순위(최선-없음) 평균 ${(gapChange.reduce((a, b) => a + b, 0) / SEEDS).toFixed(1)}계단` +
        ` | 3차 선택 하나로 우승이 갈린 시드 ${flipSeeds}개 (그중 0.3초 안 박빙 ${closeFlip}개)`,
    );
  }
}
