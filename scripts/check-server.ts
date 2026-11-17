/**
 * 실서버 상태·권한 점검 (읽기 전용, 아무것도 바꾸지 않음)
 *   npm run check-server
 */
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
);
const URL = env.VITE_SUPABASE_URL!;
const KEY = env.VITE_SUPABASE_ANON_KEY!;
const headers = { apikey: KEY, 'Content-Type': 'application/json' };

async function rpc(fn: string, body: object = {}) {
  const r = await fetch(`${URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { ok: r.ok, body: await r.json() };
}
async function select(table: string) {
  const r = await fetch(`${URL}/rest/v1/${table}?select=*&limit=1`, { headers });
  return { ok: r.ok, body: await r.json() };
}

const checks: [string, boolean, string][] = [];
const t0 = Date.now();
const st = await rpc('server_time');
const t1 = Date.now();
checks.push(['서버 시각 조회 가능', st.ok && typeof st.body === 'number', `왕복 ${t1 - t0}ms, 이 PC와 차이 ${st.body - (t0 + t1) / 2}ms`]);
const lobby = await rpc('get_lobby');
checks.push(['대기실 조회 (경주 정보 포함)', lobby.ok && 'race' in lobby.body && 'server_ms' in lobby.body, JSON.stringify(lobby.body)]);
const status = await rpc('admin_status');
checks.push(['관리자 설정 상태 조회', status.ok, JSON.stringify(status.body)]);
const races = await select('races');
checks.push(['경주 기록 공개 조회 가능', races.ok, `${races.body.length}건`]);

const denied = (r: { ok: boolean; body: { message?: string } }) => !r.ok && /permission denied|ADMIN_AUTH/.test(r.body.message ?? '');
checks.push(['차단: 내부 함수 호출', denied(await rpc('_pw_hash', { p_salt: 'a', p_password: 'b' })), '']);
checks.push(['차단: 토큰 없이 경주 시작', denied(await rpc('admin_start_race', { p_token: 'abc', p_engine_version: 2, p_countdown_ms: 3000 })), '']);
checks.push(['차단: 가짜 토큰으로 초기화', denied(await rpc('admin_reset_all', { p_token: 'f'.repeat(64) })), '']);
checks.push(['차단: 관리자 설정 테이블', denied(await select('admin_config')), '']);
checks.push(['차단: 관리자 세션 테이블', denied(await select('admin_sessions')), '']);
checks.push(['차단: 결과 보고 테이블', denied(await select('race_reports')), '']);
checks.push(['차단: 참가자 비밀 테이블', denied(await select('participant_secrets')), '']);

for (const [name, pass, detail] of checks) console.log(`${pass ? '✅' : '❌'} ${name}${detail ? `  — ${detail}` : ''}`);
process.exit(checks.every(([, p]) => p) ? 0 : 1);
