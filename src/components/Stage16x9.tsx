import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * 1920×1080 고정 좌표로 디자인하고 화면 크기에 맞춰 통째로 확대/축소.
 * 프로젝터·TV 해상도가 무엇이든 레이아웃이 깨지지 않는다 (남는 공간은 레터박스).
 */
export function Stage16x9({ children }: { children: ReactNode }) {
  const [scale, setScale] = useState(1);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const fit = () => setScale(Math.min(window.innerWidth / 1920, window.innerHeight / 1080));
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);

  return (
    <div className="stage-outer">
      <div ref={ref} className="stage-inner" style={{ transform: `translate(-50%, -50%) scale(${scale})` }}>
        {children}
      </div>
    </div>
  );
}
