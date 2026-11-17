import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(__dirname, '../migrations');

/** supabase/migrations 의 모든 SQL 을 파일명 순서대로 이어붙인 것 (Supabase 에 적용하는 순서와 동일) */
export const MIGRATIONS = readdirSync(DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(join(DIR, f), 'utf8'))
  .join('\n');

/** Supabase 와 같은 역할(anon, authenticated)을 만든 새 PostgreSQL + 전체 마이그레이션 */
export async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`create role anon nologin; create role authenticated nologin;`);
  await db.exec(MIGRATIONS);
  return db;
}

export function makeRpc(db: PGlite) {
  return async function rpc<T>(sql: string, params: unknown[] = []): Promise<T> {
    const r = await db.query<{ v: T }>(`select ${sql} as v`, params);
    return r.rows[0]!.v;
  };
}

let seq = 0;
export const newToken = () => (++seq).toString(16).padStart(64, '0');
