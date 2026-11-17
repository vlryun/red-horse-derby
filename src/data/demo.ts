import type { Entrant } from '../engine';

const NAMES = [
  '번개', '질풍', '적토마', '흑룡', '금빛갈기', '새벽바람', '불꽃', '태풍', '은하수', '천둥',
  '무지개', '돌풍', '용감이', '느림보', '초코', '당근러버', '말랑이', '쾌속', '로켓', '해돋이',
  '단풍', '달빛', '별똥별', '호랑이', '바람돌이', '홍당무', '각설탕', '깡총', '뚜벅이', '불도저',
  '슈퍼노바', '파도', '모래폭풍', '고구마', '감자', '수박', '체리', '레몬', '망고', '자두',
  '루비', '가넷', '홍옥', '석류', '노을', '봉화', '횃불', '단심', '홍련', '적마',
];

/** 1단계 데모용 가상 참가자 (2단계부터는 Supabase 참가자 목록으로 대체) */
export function demoEntrants(count: number): { id: number; name: string }[] {
  const n = Math.max(1, Math.min(50, Math.floor(count) || 50));
  return Array.from({ length: n }, (_, i) => ({ id: i + 1, name: NAMES[i % NAMES.length]! }));
}

export type DemoEntrant = Entrant;
