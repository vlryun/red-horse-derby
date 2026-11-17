import { MAX_ENTRANTS, RACE_SECONDS } from './config';
import { TACTIC_WINDOW_COUNT, isTacticType } from './tactics';
import type { RaceInput } from './types';

export class RaceInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RaceInputError';
  }
}

export const MAX_NAME_LENGTH = 12;

/** 엔진 입력 검증 — 잘못된 입력은 시뮬레이션 전에 거부한다. */
export function validateRaceInput(input: unknown): asserts input is RaceInput {
  if (typeof input !== 'object' || input === null) throw new RaceInputError('입력이 객체가 아닙니다');
  const { seed, entrants, raceSeconds, tactics } = input as Partial<RaceInput>;
  if (
    raceSeconds !== undefined &&
    (typeof raceSeconds !== 'number' ||
      !Number.isInteger(raceSeconds) ||
      raceSeconds < RACE_SECONDS.min ||
      raceSeconds > RACE_SECONDS.max)
  ) {
    throw new RaceInputError(
      `경주 시간은 ${RACE_SECONDS.min}~${RACE_SECONDS.max}초 정수여야 합니다 (받은 값: ${String(raceSeconds)})`,
    );
  }
  if (typeof seed !== 'number' || !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new RaceInputError(`seed 는 0 ~ 4294967295 정수여야 합니다 (받은 값: ${String(seed)})`);
  }
  if (!Array.isArray(entrants)) throw new RaceInputError('entrants 가 배열이 아닙니다');
  if (entrants.length < 1 || entrants.length > MAX_ENTRANTS) {
    throw new RaceInputError(`참가자는 1 ~ ${MAX_ENTRANTS}명이어야 합니다 (받은 값: ${entrants.length})`);
  }
  const ids = new Set<number>();
  for (const e of entrants) {
    if (typeof e !== 'object' || e === null) throw new RaceInputError('참가자 항목이 올바르지 않습니다');
    if (typeof e.id !== 'number' || !Number.isInteger(e.id) || e.id < 1 || e.id > 999) {
      throw new RaceInputError(`참가 번호가 올바르지 않습니다: ${String(e.id)}`);
    }
    if (ids.has(e.id)) throw new RaceInputError(`참가 번호 중복: ${e.id}`);
    ids.add(e.id);
    if (typeof e.name !== 'string' || e.name.trim().length === 0 || [...e.name].length > MAX_NAME_LENGTH) {
      throw new RaceInputError(`닉네임이 올바르지 않습니다: ${String(e.name)}`);
    }
  }
  if (tactics !== undefined) {
    if (!Array.isArray(tactics)) throw new RaceInputError('tactics 가 배열이 아닙니다');
    const seen = new Set<string>();
    for (const o of tactics) {
      if (
        typeof o !== 'object' || o === null ||
        !ids.has(o.id) ||
        !Number.isInteger(o.window) || o.window < 1 || o.window > TACTIC_WINDOW_COUNT ||
        !isTacticType(o.tactic)
      ) {
        throw new RaceInputError(`작전 기록이 올바르지 않습니다: ${JSON.stringify(o)}`);
      }
      const key = `${o.id}:${o.window}`;
      if (seen.has(key)) throw new RaceInputError(`같은 말·같은 작전 타임 중복: ${key}`);
      seen.add(key);
    }
  }
}
