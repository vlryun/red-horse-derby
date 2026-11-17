import { env } from '../env';
import { Api } from './supabase';

export * from './types';
export type { Api };

let instance: Api | null = null;

/** 앱 전체에서 하나의 연결만 사용 (Realtime 소켓 중복 방지) */
export function getBackend(): Api {
  if (!instance) instance = new Api(env.supabaseUrl, env.supabaseAnonKey);
  return instance;
}
