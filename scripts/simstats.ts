/**
 * 경주 엔진 통계 점검 (밸런스/시간 보정용)
 *   npm run sim                 → 1000경기 통계
 *   npm run sim -- 5000         → 5000경기
 *   npm run sim -- 1000 40      → 경주시간 40초 설정으로 1000경기
 *   npm run sim -- seed 12345   → 특정 시드 1경기 상세 결과
 */
import { EVENT_SPECS, TICK_MS, demoEntrantsForSim, simulateRace, type EventType } from './simlib';

const args = process.argv.slice(2);

if (args[0] === 'seed') {
  const seed = Number(args[1]);
  const r = simulateRace({ seed, entrants: demoEntrantsForSim(Number(args[2] ?? 50)) });
  console.log(`seed=${seed} hash=${r.hash} 경주시간=${((r.totalTicks * TICK_MS) / 1000).toFixed(1)}s 이벤트=${r.events.length}건`);
  for (const s of r.standings.slice(0, 10)) {
    console.log(`${String(s.rank).padStart(2)}위  #${String(s.id).padStart(2)} ${s.name.padEnd(8)} ${s.finishMs === null ? '미완주' : (s.finishMs / 1000).toFixed(3) + 's'}`);
  }
  for (const e of r.events) {
    console.log(`  ${((e.tick * TICK_MS) / 1000).toFixed(1)}s  #${r.entrants[e.horse]!.id} ${EVENT_SPECS[e.type].label}`);
  }
  process.exit(0);
}

const races = Number(args[0] ?? 1000);
const raceSeconds = args[1] !== undefined ? Number(args[1]) : undefined;
const n = 50;
const entrants = demoEntrantsForSim(n);
const wins = new Array<number>(n).fill(0);
const firstTimes: number[] = [];
const lastTimes: number[] = [];
const totalTimes: number[] = [];
const eventCounts: number[] = [];
const typeCounts: Partial<Record<EventType, number>> = {};
let unfinished = 0;
let comebacks = 0; // 70% 지점에서 하위 절반이었던 말이 우승한 횟수
const started = performance.now();

for (let k = 0; k < races; k++) {
  const seed = (Math.imul(k + 1, 2654435761) ^ 0x5eed) >>> 0;
  const r = simulateRace({ seed, entrants, raceSeconds });
  wins[r.standings[0]!.lane]!++;
  firstTimes.push(r.standings[0]!.finishMs ?? NaN);
  const last = r.standings[n - 1]!;
  if (last.finishMs === null) unfinished++;
  else lastTimes.push(last.finishMs);
  totalTimes.push(r.totalTicks * TICK_MS);
  eventCounts.push(r.events.length);
  for (const e of r.events) typeCounts[e.type] = (typeCounts[e.type] ?? 0) + 1;

  const t70 = Math.floor(r.standings[0]!.finishMs! / TICK_MS * 0.7);
  const winner = r.standings[0]!.lane;
  const wp = r.positions[t70 * n + winner]!;
  let ahead = 0;
  for (let i = 0; i < n; i++) if (r.positions[t70 * n + i]! > wp) ahead++;
  if (ahead >= n / 2) comebacks++;
}

const elapsed = performance.now() - started;
const stat = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  const avg = s.reduce((p, c) => p + c, 0) / s.length;
  return `평균 ${(avg / 1000).toFixed(1)}s  최소 ${(s[0]! / 1000).toFixed(1)}s  최대 ${(s[s.length - 1]! / 1000).toFixed(1)}s`;
};

console.log(`[설정 ${raceSeconds ?? 70}초] ${races}경기 시뮬레이션 (${(elapsed / races).toFixed(2)}ms/경기)`);
console.log(`1등 도착   : ${stat(firstTimes)}`);
console.log(`꼴등 도착  : ${stat(lastTimes)}`);
console.log(`전체 경주  : ${stat(totalTimes)}`);
console.log(`미완주 경기: ${unfinished}`);
console.log(`이벤트/경기: 평균 ${(eventCounts.reduce((a, b) => a + b, 0) / races).toFixed(1)}건`);
console.log(`이벤트 분포: ${Object.entries(typeCounts).map(([k, v]) => `${k}=${v}`).join(' ')}`);
console.log(`게이트별 우승: 최소 ${Math.min(...wins)}  최대 ${Math.max(...wins)}  (기대값 ${(races / n).toFixed(1)})`);
console.log(`대역전 우승(70% 지점 하위권→1등): ${comebacks}회 (${((comebacks / races) * 100).toFixed(1)}%)`);
