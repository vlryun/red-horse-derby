import { describe, expect, it } from 'vitest';
import { EVENT_ORDER } from '../../engine';
import { Sfx, type SoundName } from '../sfx';

describe('효과음 (오디오가 없는 환경에서도 안전)', () => {
  it('오디오 미지원·잠김 상태에서 어떤 소리를 불러도 예외가 나지 않는다', () => {
    const s = new Sfx();
    const all: SoundName[] = [...EVENT_ORDER, 'countdown', 'go', 'finish', 'join', 'lead', 'final', 'tick', 'crowd', 'gate', 'hooves'];
    expect(s.ready).toBe(false);
    for (const n of all) expect(() => s.play(n)).not.toThrow();
    expect(() => s.unlock()).not.toThrow(); // Node 에는 AudioContext 가 없음 → 조용히 무시
    expect(() => s.setEnabled(false)).not.toThrow();
    expect(s.isEnabled).toBe(false);
    expect(() => s.setEnabled(true)).not.toThrow();
  });

  it('모든 개그 이벤트에 소리가 있다 (타입 검사 + 런타임 확인)', () => {
    // SoundName 이 EventType 을 포함하므로 컴파일되면 OK. 런타임에서도 목록이 비어 있지 않은지 확인
    const names: SoundName[] = [...EVENT_ORDER];
    expect(names.length).toBe(9);
  });
});
