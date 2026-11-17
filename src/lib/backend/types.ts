import type { Entrant, FinishRecord, TacticOrder, TacticType } from '../../engine';

export type Phase = 'lobby' | 'closed' | 'countdown' | 'racing' | 'paused' | 'finished';
export type RaceStatus = 'racing' | 'paused' | 'finished' | 'aborted';

/** 경주 진행 상태 (가벼움: 3초마다 조회) */
export interface RaceMeta {
  id: string;
  roundNo: number;
  status: RaceStatus;
  startAtMs: number;
  pausedAtMs: number | null;
  pausedMs: number;
  published: boolean;
}

export interface Lobby {
  phase: Phase;
  count: number;
  maxPlayers: number;
  raceSeconds: number;
  roundNo: number;
  /** 응답 시점의 서버 시각 (ms) */
  serverMs: number;
  race: RaceMeta | null;
}

/** 경주 전체 정보 (경주가 바뀔 때 한 번만 받음) */
export interface RaceInfo extends RaceMeta {
  seed: number;
  entrants: Entrant[];
  raceSeconds: number;
  engineVersion: number;
  resultHash: string | null;
  standings: FinishRecord[] | null;
}

/** 마감된 창의 작전 기록 (모든 화면 공통) */
export interface RaceTactics {
  closed: number[];
  tactics: TacticOrder[];
}

export interface MyTactic {
  window: number;
  tactic: TacticType;
}

export interface MyEntry {
  id: string;
  horseNo: number;
  nickname: string;
  recoveryCode: string;
  renamed: boolean;
}

export interface PublicParticipant {
  id: string;
  horseNo: number;
  nickname: string;
  createdAt: string;
}

export interface RaceReport {
  entrants: number;
  reports: number;
  officialHash: string | null;
  matching: number;
  hashes: Record<string, number>;
}

export interface RaceHistoryItem {
  id: string;
  roundNo: number;
  status: RaceStatus;
  seed: number;
  raceSeconds: number;
  resultHash: string | null;
  entrantCount: number;
  winner: string | null;
  runnerUp: string | null;
  createdAt: string;
  /** 전원 테스트봇 = 리허설 */
  isTest: boolean;
}

/** 관리자용 참가자 정보 */
export interface AdminPerson {
  id: string;
  horseNo: number;
  nickname: string;
  isTest: boolean;
  online: boolean;
  recoveryCode: string;
  recoveryFails: number;
  lastSeenMs: number;
}

export interface RaceDetail {
  race: RaceInfo;
  isTest: boolean;
  createdMs: number;
  publishedMs: number | null;
  reports: number;
  matching: number;
}

export type ErrorCode =
  | 'INVALID_TOKEN'
  | 'INVALID_NICKNAME'
  | 'REGISTRATION_CLOSED'
  | 'FULL'
  | 'RECOVERY_FAILED'
  | 'RECOVERY_LOCKED'
  | 'ALREADY_JOINED'
  | 'ADMIN_AUTH'
  | 'ADMIN_BAD_PASSWORD'
  | 'ADMIN_LOCKED'
  | 'ADMIN_NOT_CONFIGURED'
  | 'ALREADY_CONFIGURED'
  | 'WEAK_PASSWORD'
  | 'BAD_SETTINGS'
  | 'BELOW_COUNT'
  | 'BAD_STATE'
  | 'RACE_ACTIVE'
  | 'NO_RACE'
  | 'NO_PARTICIPANTS'
  | 'RACE_NOT_FINISHED'
  | 'ENGINE_MISMATCH'
  | 'NAME_LOCKED'
  | 'NOT_JOINED'
  | 'TACTIC_CLOSED'
  | 'BAD_TACTIC'
  | 'INVALID_STANDINGS'
  | 'NETWORK'
  | 'UNKNOWN';

export const KNOWN_CODES: readonly ErrorCode[] = [
  // 긴 이름을 먼저 (ADMIN_BAD_PASSWORD 가 ADMIN_AUTH 등과 헷갈리지 않게 정확히 비교하지만 안전하게)
  'ADMIN_NOT_CONFIGURED',
  'ADMIN_BAD_PASSWORD',
  'ALREADY_CONFIGURED',
  'REGISTRATION_CLOSED',
  'RACE_NOT_FINISHED',
  'INVALID_STANDINGS',
  'INVALID_NICKNAME',
  'RECOVERY_FAILED',
  'RECOVERY_LOCKED',
  'ENGINE_MISMATCH',
  'NO_PARTICIPANTS',
  'TACTIC_CLOSED',
  'NAME_LOCKED',
  'NOT_JOINED',
  'BAD_TACTIC',
  'ALREADY_JOINED',
  'INVALID_TOKEN',
  'WEAK_PASSWORD',
  'ADMIN_LOCKED',
  'BAD_SETTINGS',
  'BELOW_COUNT',
  'RACE_ACTIVE',
  'ADMIN_AUTH',
  'BAD_STATE',
  'NO_RACE',
  'FULL',
];

export class BackendError extends Error {
  constructor(
    public readonly code: ErrorCode,
    detail?: string,
    public readonly retryMs?: number,
  ) {
    super(detail ?? code);
    this.name = 'BackendError';
  }
}

export const ERROR_TEXT: Record<ErrorCode, string> = {
  INVALID_TOKEN: '기기 정보가 올바르지 않아요. 새로고침해 주세요.',
  INVALID_NICKNAME: '닉네임을 확인해 주세요 (한글·영문·숫자, 10자 이내).',
  REGISTRATION_CLOSED: '참가 접수가 마감되었어요.',
  FULL: '정원이 다 찼어요.',
  RECOVERY_FAILED: '번호 또는 복구코드가 맞지 않아요.',
  RECOVERY_LOCKED: '복구 시도가 너무 많아 잠겼어요. 진행자에게 문의해 주세요.',
  ALREADY_JOINED: '이 기기는 이미 다른 말로 참가 중이에요.',
  ADMIN_AUTH: '관리자 로그인이 만료되었어요. 다시 로그인해 주세요.',
  ADMIN_BAD_PASSWORD: '비밀번호가 틀렸어요.',
  ADMIN_LOCKED: '5번 틀려서 잠시 잠겼어요. 1분 뒤 다시 시도해 주세요.',
  ADMIN_NOT_CONFIGURED: '관리자 비밀번호가 아직 설정되지 않았어요.',
  ALREADY_CONFIGURED: '관리자 비밀번호가 이미 설정되어 있어요. 로그인해 주세요.',
  WEAK_PASSWORD: '비밀번호는 8~64자로 정해 주세요.',
  BAD_SETTINGS: '설정 값을 확인해 주세요 (정원 1~20명, 경주 30~180초).',
  BELOW_COUNT: '현재 참가 인원보다 정원을 작게 할 수 없어요.',
  BAD_STATE: '지금 상태에서는 할 수 없는 작업이에요.',
  RACE_ACTIVE: '경주가 진행 중이거나 결과 표시 중이에요. 먼저 "다음 라운드"를 눌러 주세요.',
  NO_RACE: '진행 중인 경주가 없어요.',
  NO_PARTICIPANTS: '참가자가 최소 1명은 있어야 해요.',
  RACE_NOT_FINISHED: '아직 경주가 끝나지 않았어요.',
  ENGINE_MISMATCH: '경주 엔진 버전이 달라요. 새로고침 후 다시 시도해 주세요.',
  INVALID_STANDINGS: '결과 데이터가 올바르지 않아요.',
  NAME_LOCKED: '경주가 진행 중이라 지금은 닉네임을 바꿀 수 없어요. 경주가 끝난 뒤 바꿔 주세요.',
  NOT_JOINED: '참가 정보가 없어요. 다시 참가해 주세요.',
  TACTIC_CLOSED: '작전 선택 시간이 끝났어요.',
  BAD_TACTIC: '작전을 다시 골라 주세요.',
  NETWORK: '서버에 연결할 수 없어요. 잠시 후 다시 시도해 주세요.',
  UNKNOWN: '알 수 없는 오류가 발생했어요.',
};

export function errorText(e: unknown): string {
  if (!(e instanceof BackendError)) return ERROR_TEXT.UNKNOWN;
  // 알 수 없는 오류는 원인 메시지를 함께 보여줌 (현장에서 문제 파악용)
  if (e.code === 'UNKNOWN' && e.message && e.message !== 'UNKNOWN') return `${ERROR_TEXT.UNKNOWN} (${e.message})`;
  return ERROR_TEXT[e.code];
}

export type Table = 'participants' | 'game_state';
export type LiveStatus = 'connecting' | 'live' | 'down';
