import { useEffect, useMemo } from 'react';

/**
 * 휴대폰 입상 축하: 꽃가루(CSS 만 사용, 가벼움) + 진동 한 번.
 * 같은 경주에서 새로고침해도 진동은 한 번만.
 */
export function Celebrate({ raceId, rank }: { raceId: string; rank: 1 | 2 }) {
  const pieces = useMemo(
    () =>
      Array.from({ length: 36 }, (_, i) => ({
        left: Math.random() * 100,
        delay: Math.random() * 1.8,
        duration: 2.4 + Math.random() * 1.6,
        color: ['#c8102e', '#f5c542', '#ffffff', '#ff6a3a'][i % 4],
        rotate: Math.random() * 360,
        w: 6 + Math.random() * 6,
      })),
    [],
  );

  useEffect(() => {
    const key = `rhd.celebrated.${raceId}`;
    try {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, '1');
    } catch {
      /* ignore */
    }
    try {
      navigator.vibrate?.(rank === 1 ? [120, 60, 120, 60, 400] : [120, 60, 300]);
    } catch {
      /* 진동 미지원 */
    }
  }, [raceId, rank]);

  return (
    <div className="confetti" aria-hidden="true">
      {pieces.map((p, i) => (
        <span
          key={i}
          style={{
            left: `${p.left}%`,
            width: p.w,
            height: p.w * 0.45,
            background: p.color,
            animationDelay: `${p.delay}s`,
            animationDuration: `${p.duration}s`,
            transform: `rotate(${p.rotate}deg)`,
          }}
        />
      ))}
    </div>
  );
}
