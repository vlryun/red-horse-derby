import type { EventType } from '../engine';

/**
 * 효과음 — 전부 Web Audio 로 즉석 합성. 소리 파일이 없어서 행사장에서 "로딩 실패"가 날 수 없다.
 *
 * 브라우저 정책상 사용자가 화면을 한 번 클릭해야 소리를 낼 수 있다 → unlock() 을 클릭 이벤트에서 호출.
 * 소리를 못 내는 상황(지원 안 함, 아직 잠김, 꺼짐)에서는 play() 가 조용히 아무것도 안 한다 (절대 예외 없음).
 */
export type SoundName =
  | EventType
  | 'countdown'
  | 'go'
  | 'finish'
  | 'join'
  | 'lead'
  | 'final'
  | 'tick'
  | 'crowd'
  | 'gate'
  | 'hooves';

const PREF_KEY = 'rhd.sound.v1';
const MAX_VOICES = 6;

type Listener = (s: { enabled: boolean; unlocked: boolean }) => void;

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private enabled: boolean;
  private lastPlayed = new Map<SoundName, number>();
  private voices = 0;
  private listeners = new Set<Listener>();

  constructor() {
    let pref = 'on';
    try {
      pref = localStorage.getItem(PREF_KEY) ?? 'on';
    } catch {
      /* ignore */
    }
    this.enabled = pref !== 'off';
  }

  /** 실제로 소리가 나는 상태인지 */
  get ready(): boolean {
    return this.enabled && !!this.ctx && this.ctx.state === 'running';
  }
  get isEnabled(): boolean {
    return this.enabled;
  }
  get isUnlocked(): boolean {
    return !!this.ctx && this.ctx.state === 'running';
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn({ enabled: this.enabled, unlocked: this.isUnlocked });
    return () => this.listeners.delete(fn);
  }
  private emit() {
    for (const l of this.listeners) l({ enabled: this.enabled, unlocked: this.isUnlocked });
  }

  /** 클릭/키 입력 이벤트 안에서 호출해야 함 */
  unlock(): void {
    try {
      if (!this.ctx) {
        const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.55;
        // 너무 큰 소리가 겹쳐도 찢어지지 않게 컴프레서
        const comp = this.ctx.createDynamicsCompressor();
        this.master.connect(comp).connect(this.ctx.destination);
        this.ctx.onstatechange = () => this.emit();
      }
      void this.ctx.resume().then(() => this.emit());
    } catch {
      /* 오디오 불가 환경 */
    }
    this.emit();
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    try {
      localStorage.setItem(PREF_KEY, on ? 'on' : 'off');
    } catch {
      /* ignore */
    }
    if (on) this.unlock();
    this.emit();
  }

  play(name: SoundName): void {
    if (!this.ready) return;
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    // 같은 소리 연타 방지 + 동시 재생 수 제한 (20마리 이벤트가 겹쳐도 귀가 아프지 않게)
    const last = this.lastPlayed.get(name) ?? -1;
    if (now - last < 0.15 || this.voices >= MAX_VOICES) return;
    this.lastPlayed.set(name, now);
    this.voices++;
    const dur = this.synth(name, now);
    setTimeout(() => (this.voices = Math.max(0, this.voices - 1)), dur * 1000 + 50);
  }

  // ───────────────────────── 합성 ─────────────────────────

  private noise(): AudioBuffer {
    if (!this.noiseBuf) {
      const ctx = this.ctx!;
      const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      this.noiseBuf = buf;
    }
    return this.noiseBuf;
  }

  /** 음량 엔벨로프가 달린 출력 노드 */
  private out(t: number, attack: number, hold: number, release: number, peak = 1): GainNode {
    const g = this.ctx!.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.setValueAtTime(peak, t + attack + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + hold + release);
    g.connect(this.master!);
    return g;
  }

  private osc(type: OscillatorType, f0: number, f1: number, t: number, dur: number, dest: AudioNode) {
    const o = this.ctx!.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    o.connect(dest);
    o.start(t);
    o.stop(t + dur + 0.05);
    return o;
  }

  private noiseBurst(t: number, dur: number, filter: BiquadFilterType, f0: number, f1: number, dest: AudioNode, q = 1) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise();
    const bq = ctx.createBiquadFilter();
    bq.type = filter;
    bq.Q.value = q;
    bq.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) bq.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    src.connect(bq).connect(dest);
    src.start(t);
    src.stop(t + dur + 0.05);
  }

  /** 소리를 만들고 대략의 길이(초)를 반환 */
  private synth(name: SoundName, t: number): number {
    switch (name) {
      case 'countdown': {
        this.osc('square', 660, 660, t, 0.15, this.out(t, 0.005, 0.1, 0.05, 0.25));
        return 0.2;
      }
      case 'go': {
        this.osc('square', 990, 990, t, 0.5, this.out(t, 0.005, 0.35, 0.15, 0.25));
        this.osc('square', 1320, 1320, t, 0.5, this.out(t, 0.005, 0.35, 0.15, 0.15));
        this.noiseBurst(t, 0.25, 'highpass', 800, 800, this.out(t, 0.002, 0.03, 0.2, 0.5));
        return 0.6;
      }
      case 'tick': {
        // 카운트다운 숫자: 짧은 타격음 (북 + 딸깍)
        this.osc('sine', 180, 70, t, 0.14, this.out(t, 0.002, 0.02, 0.12, 0.7));
        this.noiseBurst(t, 0.05, 'bandpass', 2500, 1800, this.out(t, 0.001, 0.01, 0.04, 0.35), 2);
        this.osc('square', 660, 660, t, 0.12, this.out(t, 0.005, 0.06, 0.05, 0.12));
        return 0.2;
      }
      case 'crowd': {
        // 관중 웅성임이 살짝 커짐 (1.8초)
        this.noiseBurst(t, 1.8, 'bandpass', 600, 1100, this.out(t, 0.6, 0.6, 0.6, 0.12), 0.6);
        this.noiseBurst(t, 1.8, 'bandpass', 1500, 2400, this.out(t, 0.7, 0.5, 0.6, 0.05), 0.8);
        return 1.9;
      }
      case 'gate': {
        // 게이트 걸쇠 철컥 + 발굽 구르는 소리
        this.noiseBurst(t, 0.06, 'highpass', 3000, 3000, this.out(t, 0.001, 0.01, 0.05, 0.45));
        this.osc('square', 1900, 1400, t, 0.05, this.out(t, 0.001, 0.01, 0.04, 0.12));
        this.noiseBurst(t + 0.07, 0.05, 'highpass', 2500, 2500, this.out(t + 0.07, 0.001, 0.01, 0.04, 0.3));
        for (const s of [0.25, 0.42, 0.62, 0.78]) {
          this.osc('sine', 120, 60, t + s, 0.08, this.out(t + s, 0.002, 0.01, 0.07, 0.4));
          this.noiseBurst(t + s, 0.05, 'lowpass', 700, 300, this.out(t + s, 0.001, 0.01, 0.04, 0.25));
        }
        return 0.9;
      }
      case 'hooves': {
        // 출발: 게이트 탕 + 발굽이 우르르
        this.noiseBurst(t, 0.12, 'highpass', 1500, 600, this.out(t, 0.001, 0.02, 0.1, 0.5));
        for (let k = 0; k < 10; k++) {
          const s = 0.05 + k * 0.07 + (k % 3) * 0.012;
          this.osc('sine', 110, 55, t + s, 0.07, this.out(t + s, 0.002, 0.01, 0.06, 0.35 - k * 0.02));
          this.noiseBurst(t + s, 0.05, 'lowpass', 900, 300, this.out(t + s, 0.001, 0.01, 0.04, 0.22));
        }
        return 0.9;
      }
      case 'join': {
        // 맑은 "띵동"
        this.osc('sine', 1318, 1318, t, 0.4, this.out(t, 0.005, 0.02, 0.35, 0.25));
        this.osc('sine', 1760, 1760, t + 0.12, 0.5, this.out(t + 0.12, 0.005, 0.02, 0.45, 0.2));
        return 0.7;
      }
      case 'lead': {
        // 선두 교체: 짧은 두 음 상승 (주의 환기, 과하지 않게)
        this.osc('triangle', 784, 784, t, 0.12, this.out(t, 0.005, 0.07, 0.05, 0.25));
        this.osc('triangle', 1175, 1175, t + 0.11, 0.18, this.out(t + 0.11, 0.005, 0.1, 0.08, 0.25));
        return 0.35;
      }
      case 'final': {
        // 마지막 직선: 북소리 세 번 + 상승음 (긴장감)
        for (const s of [0, 0.18, 0.36]) {
          this.osc('sine', 110, 55, t + s, 0.16, this.out(t + s, 0.003, 0.03, 0.13, 0.6));
          this.noiseBurst(t + s, 0.08, 'lowpass', 900, 300, this.out(t + s, 0.002, 0.02, 0.06, 0.3));
        }
        this.osc('sawtooth', 220, 880, t + 0.5, 0.7, this.out(t + 0.5, 0.05, 0.45, 0.2, 0.08));
        return 1.2;
      }
      case 'finish': {
        // 팡파레: 도-미-솔-도 + 화음
        const notes = [523.25, 659.25, 783.99, 1046.5];
        notes.forEach((f, i) => this.osc('triangle', f, f, t + i * 0.13, 0.18, this.out(t + i * 0.13, 0.005, 0.1, 0.08, 0.35)));
        const c = t + 0.55;
        for (const f of [523.25, 659.25, 783.99, 1046.5]) this.osc('sawtooth', f, f, c, 1.2, this.out(c, 0.02, 0.6, 0.6, 0.08));
        this.noiseBurst(c, 0.8, 'highpass', 4000, 4000, this.out(c, 0.01, 0.1, 0.7, 0.15));
        return 1.8;
      }
      case 'CARROT': {
        // 아삭 아삭 + 슝 상승
        this.noiseBurst(t, 0.06, 'bandpass', 2500, 2500, this.out(t, 0.002, 0.03, 0.03, 0.6), 3);
        this.noiseBurst(t + 0.09, 0.06, 'bandpass', 3000, 3000, this.out(t + 0.09, 0.002, 0.03, 0.03, 0.5), 3);
        this.osc('sine', 400, 1200, t + 0.15, 0.25, this.out(t + 0.15, 0.01, 0.15, 0.1, 0.3));
        return 0.45;
      }
      case 'BANANA': {
        // 미끄러지는 휘파람 (뾰로로롱↓)
        const g = this.out(t, 0.01, 0.5, 0.15, 0.3);
        const o = this.osc('sine', 1500, 220, t, 0.65, g);
        const lfo = this.ctx!.createOscillator();
        const lg = this.ctx!.createGain();
        lfo.frequency.value = 9;
        lg.gain.value = 40;
        lfo.connect(lg).connect(o.frequency);
        lfo.start(t);
        lfo.stop(t + 0.7);
        return 0.7;
      }
      case 'SLEEP': {
        // 드르렁~ 쿨
        for (const s of [0, 0.9]) {
          const g = this.out(t + s, 0.25, 0.25, 0.3, 0.25);
          const lp = this.ctx!.createBiquadFilter();
          lp.type = 'lowpass';
          lp.frequency.value = 500;
          lp.connect(g);
          this.osc('sawtooth', 70, 85, t + s, 0.8, lp);
          this.noiseBurst(t + s, 0.8, 'lowpass', 600, 300, this.out(t + s, 0.25, 0.25, 0.3, 0.15));
        }
        return 1.8;
      }
      case 'CRAZY': {
        // 부아아앙 엔진
        const g = this.out(t, 0.02, 0.6, 0.2, 0.22);
        const ws = this.ctx!.createWaveShaper();
        const curve = new Float32Array(256);
        for (let i = 0; i < 256; i++) {
          const x = (i / 128) - 1;
          curve[i] = Math.tanh(x * 4);
        }
        ws.curve = curve;
        ws.connect(g);
        this.osc('sawtooth', 70, 420, t, 0.8, ws);
        this.osc('sawtooth', 72, 430, t, 0.8, ws);
        return 0.85;
      }
      case 'TURTLE': {
        // 뿌우우웅 ↓ (느려짐)
        this.osc('triangle', 330, 70, t, 0.9, this.out(t, 0.02, 0.6, 0.3, 0.4));
        this.osc('sine', 165, 40, t, 0.9, this.out(t, 0.02, 0.6, 0.3, 0.3));
        return 1;
      }
      case 'FART': {
        // 뿌웅 + 휘익
        const g = this.out(t, 0.01, 0.4, 0.15, 0.5);
        const lp = this.ctx!.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 380;
        lp.Q.value = 6;
        lp.connect(g);
        const o = this.osc('square', 95, 70, t, 0.55, lp);
        const lfo = this.ctx!.createOscillator();
        const lg = this.ctx!.createGain();
        lfo.frequency.value = 23;
        lg.gain.value = 30;
        lfo.connect(lg).connect(o.frequency);
        lfo.start(t);
        lfo.stop(t + 0.6);
        this.noiseBurst(t, 0.5, 'lowpass', 400, 200, this.out(t, 0.01, 0.35, 0.15, 0.4), 2);
        this.osc('sine', 600, 1800, t + 0.55, 0.2, this.out(t + 0.55, 0.01, 0.1, 0.1, 0.2));
        return 0.8;
      }
      case 'RUNAWAY': {
        // 휘이익(바람) + 띠용
        this.noiseBurst(t, 0.5, 'bandpass', 300, 3000, this.out(t, 0.05, 0.3, 0.15, 0.6), 1.5);
        this.osc('sine', 220, 660, t + 0.45, 0.12, this.out(t + 0.45, 0.005, 0.08, 0.05, 0.3));
        this.osc('sine', 660, 330, t + 0.57, 0.2, this.out(t + 0.57, 0.005, 0.1, 0.1, 0.3));
        return 0.8;
      }
      case 'AWAKEN': {
        // 상승하는 파워 코드 + 징
        for (const [f, v] of [
          [110, 0.15],
          [164.8, 0.12],
          [220, 0.1],
        ] as const) {
          this.osc('sawtooth', f, f * 2, t, 1.1, this.out(t, 0.05, 0.8, 0.3, v));
        }
        const gong = t + 1.05;
        this.osc('sine', 196, 190, gong, 2, this.out(gong, 0.005, 0.1, 1.9, 0.4));
        this.osc('sine', 293.7, 290, gong, 2, this.out(gong, 0.005, 0.1, 1.6, 0.2));
        this.noiseBurst(gong, 1.2, 'bandpass', 1200, 600, this.out(gong, 0.005, 0.05, 1.1, 0.2));
        return 3;
      }
      case 'SPURT': {
        // 막판 스퍼트: 짧게 치솟는 휘슬 + 발굽 두 번
        this.osc('triangle', 520, 1560, t, 0.35, this.out(t, 0.01, 0.25, 0.1, 0.3));
        this.noiseBurst(t + 0.05, 0.12, 'lowpass', 500, 300, this.out(t + 0.05, 0.005, 0.06, 0.05, 0.35));
        this.noiseBurst(t + 0.2, 0.12, 'lowpass', 500, 300, this.out(t + 0.2, 0.005, 0.06, 0.05, 0.35));
        return 0.5;
      }
    }
  }
}

/** 앱 전체에서 하나 */
export const sfx = new Sfx();
