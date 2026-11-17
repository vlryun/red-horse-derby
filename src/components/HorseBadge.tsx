import { hex, horseColor } from '../game/palette';

/** 번호별 고유색 말 아이콘 + 번호 (경주 화면과 같은 색) */
export function HorseBadge({ no, size = 120 }: { no: number; size?: number }) {
  const c = hex(horseColor(no));
  return (
    <svg width={size} height={size * 0.8} viewBox="0 0 100 80" role="img" aria-label={`${no}번 말`}>
      <g stroke="#1a0a0a" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round">
        {/* 다리 */}
        <path d="M30 48 L24 74 M38 48 L40 74 M64 48 L60 74 M72 46 L80 72" fill="none" />
        {/* 꼬리 */}
        <path d="M18 34 Q6 40 8 56" fill="none" stroke="#2a1408" strokeWidth="6" />
        {/* 몸통 + 목 + 머리 */}
        <path
          d="M20 32 Q22 22 40 22 L62 22 Q70 20 74 10 L80 4 L84 10 Q94 12 96 22 Q92 28 84 26 L80 34 Q78 50 62 50 L34 50 Q18 50 20 32 Z"
          fill={c}
        />
        {/* 갈기 */}
        <path d="M66 20 Q72 12 78 6" fill="none" stroke="#2a1408" strokeWidth="5" />
      </g>
      <circle cx="88" cy="16" r="2" fill="#000" />
      {/* 등번호 천 */}
      <rect x="34" y="26" width="26" height="20" rx="4" fill="#fff6e0" stroke="#1a0a0a" strokeWidth="2" />
      <text x="47" y="41.5" textAnchor="middle" fontFamily="'Black Han Sans', sans-serif" fontSize="16" fill="#1a0a0a">
        {no}
      </text>
    </svg>
  );
}
