/**
 * 결정론적 PRNG (mulberry32).
 * - 정수 연산(Math.imul, >>>)만 사용 → 모든 JS 엔진/기기에서 비트 단위로 동일한 결과.
 * - Math.random() 은 엔진 내부에서 절대 사용하지 않는다.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** 0 ~ 2^32-1 정수 */
  nextU32(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** 0 ~ n-1 정수. u32*n < 2^53 이므로 부동소수 오차 없음. */
  int(n: number): number {
    if (!Number.isInteger(n) || n <= 0) throw new RangeError(`Rng.int: invalid n=${n}`);
    return Math.floor((this.nextU32() * n) / 4294967296);
  }

  /** 정수 범위 [min, max] */
  range(min: number, max: number): number {
    return min + this.int(max - min + 1);
  }

  /** 확률 num/den 으로 true */
  chance(num: number, den: number): boolean {
    return this.int(den) < num;
  }
}

/** 32비트 FNV-1a 해시 (결과 무결성 검증용) */
export function fnv1a(values: readonly number[]): string {
  let h = 0x811c9dc5;
  for (const v of values) {
    let x = v | 0;
    for (let i = 0; i < 4; i++) {
      h ^= x & 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
      x >>>= 8;
    }
  }
  return h.toString(16).padStart(8, '0');
}
