import { useEffect, useState } from 'react';
import { sfx } from '../game/sfx';

/**
 * 대형 화면 소리 켜기/끄기.
 * 브라우저는 사용자가 한 번 클릭해야 소리를 허용 → 아직 잠겨 있으면 눈에 띄는 버튼으로 안내.
 * 화면 아무 곳이나 클릭해도 소리가 풀린다. M 키로 켜기/끄기.
 */
export function SoundToggle() {
  const [s, setS] = useState({ enabled: sfx.isEnabled, unlocked: sfx.isUnlocked });

  useEffect(() => {
    const off = sfx.subscribe(setS);
    const unlock = () => {
      if (sfx.isEnabled) sfx.unlock();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === 'm' || e.key === 'M') sfx.setEnabled(!sfx.isEnabled);
      else unlock();
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', onKey);
    return () => {
      off();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  if (s.enabled && !s.unlocked) {
    return (
      <button className="sound-toggle locked" onClick={() => sfx.unlock()}>
        🔊 클릭해서 소리 켜기
      </button>
    );
  }
  return (
    <button
      className="sound-toggle"
      onClick={() => sfx.setEnabled(!s.enabled)}
      title={s.enabled ? '소리 끄기 (M)' : '소리 켜기 (M)'}
      aria-label={s.enabled ? '소리 끄기' : '소리 켜기'}
    >
      {s.enabled ? '🔊' : '🔇'}
    </button>
  );
}
