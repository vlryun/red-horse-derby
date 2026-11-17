/** 테마 색상 */
export const THEME = {
  red: 0xc8102e,
  redDark: 0x7a0f12,
  redDeep: 0x3d0709,
  gold: 0xf5c542,
  goldDark: 0xb8860b,
  cream: 0xfff6e0,
  ink: 0x1a0a0a,
  grass: 0x2f7d32,
  grassAlt: 0x2a7230,
  dirt: 0xc68a4e,
  dirtDark: 0xb07a42,
  rail: 0xfff6e0,
} as const;

export const hex = (c: number) => '#' + c.toString(16).padStart(6, '0');

function hslToInt(h: number, s: number, l: number): number {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return (f(0) << 16) | (f(8) << 8) | f(4);
}

/** 번호별 고유 색상 (황금각 분할로 이웃 번호끼리 색이 확연히 다름) */
export function horseColor(id: number): number {
  const h = ((id - 1) * 137.508) % 360;
  const l = id % 3 === 0 ? 0.42 : id % 3 === 1 ? 0.55 : 0.66;
  return hslToInt(h, 0.78, l);
}

/** 배경색 위 글자색 (명도 기준 흑/백) */
export function textOn(color: number): string {
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#1a0a0a' : '#ffffff';
}

/** 말 털색 (자연색 6종) */
const COATS = [0x8b4513, 0x5c3317, 0x2b1d14, 0xd2a26b, 0xb0b0b0, 0xa0522d];
export function coatColor(id: number): number {
  return COATS[(id * 7) % COATS.length]!;
}
