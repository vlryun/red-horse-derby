import { ENGINE_VERSION } from './config';
import { simulateRace, simulateRaceV3, simulateRaceV4, simulateRaceV5 } from './simulate';
import type { RaceInput, RaceResult } from './types';
import { simulateRace as simulateRaceV2 } from './v2/simulate';

/**
 * 엔진 버전별 계산기.
 * 경주는 "시작할 때의 엔진 버전"으로 서버에 기록된다. 배포 직후 예전 화면(관리자 등)에서 경주가 시작돼도
 * 모든 화면이 그 경주의 버전으로 똑같이 계산하도록, 이전 버전 엔진을 그대로 보관해 둔다.
 */
export const SUPPORTED_ENGINE_VERSIONS: readonly number[] = [2, 3, 4, 5, ENGINE_VERSION];

export function isSupportedEngine(version: number): boolean {
  return SUPPORTED_ENGINE_VERSIONS.includes(version);
}

export function simulateRaceVersion(version: number, input: RaceInput): RaceResult {
  if (version === ENGINE_VERSION) return simulateRace(input);
  if (version === 5) return simulateRaceV5(input);
  if (version === 4) return simulateRaceV4(input);
  if (version === 3) return simulateRaceV3(input);
  if (version === 2) return simulateRaceV2(input);
  throw new Error(`지원하지 않는 엔진 버전: v${version}`);
}
