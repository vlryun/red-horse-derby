/**
 * 실제 Supabase 에 동시 참가 부하 테스트.
 *   npm run loadtest            → 60명 동시 참가 (정원 50 초과 상황 포함)
 * 검증: 정확히 정원만큼만 성공, 번호 중복 없음, 같은 기기 중복 요청은 같은 결과, 나머지는 FULL
 * ⚠️ 테스트 후 SQL Editor 에서:  truncate participants cascade;
 */
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
);
const URL = env.VITE_SUPABASE_URL!;
const KEY = env.VITE_SUPABASE_ANON_KEY!;
const N = Number(process.argv[2] ?? 60);

async function rpc(fn: string, body: object) {
  const t0 = performance.now();
  const res = await fetch(`${URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return { ok: res.ok, json, ms: performance.now() - t0 };
}

const lobby0 = (await rpc('get_lobby', {})).json;
console.log(`시작 상태: ${JSON.stringify(lobby0)}`);

const tokens = Array.from({ length: N }, () => randomBytes(32).toString('hex'));
// 같은 기기가 버튼을 연타한 상황: 앞 5명은 같은 토큰으로 3번씩 동시에 요청
const reqs = tokens.flatMap((t, i) => {
  const nick = i % 4 === 0 ? '동시참가' : `봇${i}`; // 중복 닉네임 다수
  return i < 5 ? [{ t, nick }, { t, nick }, { t, nick }] : [{ t, nick }];
});

const started = performance.now();
const results = await Promise.all(reqs.map((r) => rpc('join_game', { p_token: r.t, p_nickname: r.nick }).then((x) => ({ ...x, t: r.t }))));
const elapsed = performance.now() - started;

const ok = results.filter((r) => r.ok);
const errs = results.filter((r) => !r.ok).map((r) => r.json.message);
const byToken = new Map<string, Set<string>>();
for (const r of ok) {
  if (!byToken.has(r.t)) byToken.set(r.t, new Set());
  byToken.get(r.t)!.add(r.json.id);
}
const nos = [...new Set(ok.map((r) => `${r.json.id}:${r.json.horse_no}`))].map((s) => Number(s.split(':')[1]));
const nicks = [...new Set(ok.map((r) => `${r.json.id}:${r.json.nickname}`))].map((s) => s.split(':')[1]!);
const lat = results.map((r) => r.ms).sort((a, b) => a - b);

const max = lobby0.max_players - lobby0.count;
const checks: [string, boolean][] = [
  [`성공한 참가자 수 = 남은 정원 ${max}`, byToken.size === Math.min(max, N)],
  ['말 번호 중복 없음', new Set(nos).size === nos.length],
  ['닉네임 중복 없음', new Set(nicks.map((n) => n.toLowerCase())).size === nicks.length],
  ['같은 기기 중복 요청 → 항상 같은 참가자', [...byToken.values()].every((s) => s.size === 1)],
  ['실패는 전부 FULL', errs.every((e) => e === 'FULL')],
];

console.log(`\n요청 ${reqs.length}건 (기기 ${N}대) 동시 전송 → ${elapsed.toFixed(0)}ms`);
console.log(`응답시간 중앙값 ${lat[Math.floor(lat.length / 2)]!.toFixed(0)}ms, 최대 ${lat[lat.length - 1]!.toFixed(0)}ms`);
console.log(`성공 ${ok.length}건 / 실패 ${errs.length}건 (${[...new Set(errs)].join(', ') || '-'})`);
console.log(`중복 닉네임 처리 예: ${nicks.filter((n) => n.startsWith('동시참가')).sort().join(', ')}`);
for (const [name, pass] of checks) console.log(`${pass ? '✅' : '❌'} ${name}`);
console.log(`\n최종 상태: ${JSON.stringify((await rpc('get_lobby', {})).json)}`);
process.exit(checks.every(([, p]) => p) ? 0 : 1);
