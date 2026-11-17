/**
 * 배포: 테스트 → 타입검사 → Vercel 운영 배포 → 공개 주소 점검
 *   npm run deploy
 * 컴퓨터 이름에 한글이 있으면 Vercel CLI 가 실패하므로 ascii-hostname.cjs 를 미리 불러온다.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const patch = fileURLToPath(new URL('./ascii-hostname.cjs', import.meta.url));
const env = { ...process.env, NODE_OPTIONS: `--require=${patch}` };
const run = (cmd, args, opts = {}) => {
  console.log(`\n▶ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: true, ...opts });
  if (r.status !== 0) {
    console.error(`\n✖ 실패: ${cmd} ${args.join(' ')} — 배포를 중단합니다.`);
    process.exit(r.status ?? 1);
  }
};

run('npm', ['test']);
run('npm', ['run', 'typecheck']);
run('npx', ['vercel', 'deploy', '--prod', '--yes'], { env });

const URL_ = 'https://red-horse-derby.vercel.app';
let ok = true;
for (const p of ['/', '/play', '/screen', '/admin']) {
  const res = await fetch(URL_ + p).catch(() => null);
  console.log(`${res?.ok ? '✅' : '❌'} ${URL_}${p} ${res?.status ?? '연결 실패'}`);
  ok &&= !!res?.ok;
}
console.log(ok ? '\n🎉 배포 완료' : '\n⚠️ 일부 주소가 열리지 않아요. 확인이 필요해요.');
process.exit(ok ? 0 : 1);
