import Phaser from 'phaser';

/** 말 텍스처 크기 (기준 배율 1) */
export const HORSE_W = 100;
export const HORSE_H = 74;
/** 달리기 프레임 수 (한 걸음 주기) */
export const GALLOP_FRAMES = 8;

const OUTLINE = 0x1a0a0a;
const DARK = 0x2a1408; // 갈기·꼬리 (틴트해도 어둡게 유지)

/**
 * 말·기수 텍스처를 코드로 생성 (외부 이미지 로딩 실패 위험 없음).
 *  - 말: 흰색으로 그린 뒤 setTint 로 털색 → 외곽선·갈기·꼬리는 어두운 색이라 그대로 유지
 *  - 8프레임 갤럽: 다리마다 무릎/비절이 접히고, 뒷다리 → 앞다리 순서로 땅을 차는 실제 질주 리듬
 *  - 기수: 흰색으로 그려 참가자 색으로 틴트 (실크 셔츠)
 */
export function createHorseTextures(scene: Phaser.Scene): void {
  if (scene.textures.exists('horse-0')) return;

  for (let f = 0; f < GALLOP_FRAMES; f++) {
    const t = f / GALLOP_FRAMES; // 0..1 한 걸음
    const g = scene.make.graphics({ x: 0, y: 0 }, false);
    const wave = Math.sin(t * Math.PI * 2);
    const nod = Math.sin(t * Math.PI * 2 + 0.6) * 2.2; // 고개 끄덕임
    const lift = Math.max(0, Math.sin(t * Math.PI * 2 - 0.4)) * 2.5; // 공중 구간에 몸이 살짝 뜸
    const by = 34 - lift; // 몸통 중심 y

    // ── 다리 (몸통 뒤에 그려 자연스럽게) ──
    // [엉덩이 x, 위상, 앞다리?] — 뒷다리 두 개가 먼저, 앞다리 두 개가 반 박자 뒤 (회전 갤럽)
    const legs: [number, number, boolean, number][] = [
      [32, 0.0, false, 0.75], // 뒷다리(먼 쪽) — 어둡게
      [66, 0.48, true, 0.75], // 앞다리(먼 쪽)
      [36, 0.1, false, 1], // 뒷다리(가까운 쪽)
      [70, 0.58, true, 1], // 앞다리(가까운 쪽)
    ];
    for (const [hipX, ph, fore, shade] of legs) {
      const p = (t + ph) % 1;
      const swing = Math.sin(p * Math.PI * 2); // + 앞으로
      const upper = (swing * (fore ? 38 : 32) * Math.PI) / 180;
      const flex = Math.max(0, Math.cos(p * Math.PI * 2)) * (fore ? 70 : 45); // 다리를 앞으로 가져올 때 접힘
      const lower = upper + ((fore ? -flex : flex * 0.8) * Math.PI) / 180;
      const hipY = by + 6;
      const kx = hipX + Math.sin(upper) * 15;
      const ky = hipY + Math.cos(upper) * 15;
      const fx = kx + Math.sin(lower) * 16;
      const fy = Math.min(72, ky + Math.cos(lower) * 16);
      const col = shade < 1 ? 0xb8b8b8 : 0xffffff;
      g.lineStyle(8, OUTLINE, 1);
      g.lineBetween(hipX, hipY, kx, ky);
      g.lineBetween(kx, ky, fx, fy);
      g.lineStyle(5, col, 1);
      g.lineBetween(hipX, hipY, kx, ky);
      g.lineBetween(kx, ky, fx, fy);
      g.fillStyle(OUTLINE, 1);
      g.fillRoundedRect(fx - 3.5, fy - 3, 7, 4, 1.5); // 발굽
    }

    // ── 꼬리 (바람에 휘날림) ──
    g.lineStyle(6, DARK, 1);
    g.beginPath();
    g.moveTo(22, by - 6);
    g.lineTo(12, by - 3 + wave * 3);
    g.lineTo(4, by + 4 + wave * 5);
    g.lineTo(1, by + 12 + wave * 6);
    g.strokePath();

    // ── 몸통 · 목 · 머리 (외곽선 → 흰색) ──
    const body = (pad: number, color: number) => {
      g.fillStyle(color, 1);
      g.fillEllipse(48, by, 52 + pad * 2, 24 + pad * 2); // 몸통
      g.fillCircle(30, by - 2, 13 + pad); // 엉덩이
      g.fillCircle(66, by, 12 + pad); // 가슴
      // 목
      g.fillTriangle(60 - pad, by - 6, 82 + pad, by - 24 + nod - pad, 74 + pad, by + 6 + pad);
      g.fillTriangle(60 - pad, by - 6, 76 + pad, by - 26 + nod - pad, 82 + pad, by - 24 + nod - pad);
      // 머리 + 주둥이
      g.fillEllipse(86, by - 24 + nod, 22 + pad * 2, 12 + pad * 2);
      g.fillEllipse(94, by - 20 + nod, 10 + pad * 2, 9 + pad * 2);
      // 귀
      g.fillTriangle(79, by - 29 + nod, 82, by - 38 + nod - pad, 85, by - 29 + nod);
    };
    body(1.6, OUTLINE);
    body(0, 0xffffff);

    // 갈기 (목 위로 휘날림)
    g.lineStyle(5, DARK, 1);
    g.beginPath();
    g.moveTo(62, by - 10);
    g.lineTo(68, by - 18 + wave * 1.5 + nod * 0.5);
    g.lineTo(74, by - 24 + nod);
    g.lineTo(79, by - 29 + nod);
    g.strokePath();

    // 눈 · 콧구멍
    g.fillStyle(0x000000, 1);
    g.fillCircle(88, by - 27 + nod, 1.8);
    g.fillCircle(97, by - 19 + nod, 1.2);

    g.generateTexture(`horse-${f}`, HORSE_W, HORSE_H);
    g.destroy();
  }

  // ── 기수 (몸을 숙인 자세). 흰색 = 틴트로 참가자 색 실크 ──
  const j = scene.make.graphics({ x: 0, y: 0 }, false);
  const jockey = (pad: number, color: number) => {
    j.fillStyle(color, 1);
    j.fillEllipse(20, 20, 26 + pad * 2, 13 + pad * 2); // 숙인 몸통
    j.fillCircle(33, 9, 7 + pad); // 헬멧
    j.fillTriangle(16 - pad, 22, 26 + pad, 22, 21, 34 + pad); // 다리(무릎)
    j.lineStyle(5 + pad * 2, color, 1);
    j.lineBetween(28, 20, 40, 26); // 팔 (고삐)
  };
  jockey(1.6, OUTLINE);
  jockey(0, 0xffffff);
  j.fillStyle(0x1a0a0a, 1);
  j.fillRect(35, 7, 5, 3); // 고글
  j.generateTexture('jockey', 48, 38);
  j.destroy();

  // 결승 체커 패턴
  const c = scene.make.graphics({ x: 0, y: 0 }, false);
  const s = 10;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 2; x++) {
      c.fillStyle((x + y) % 2 === 0 ? 0xffffff : 0x111111, 1);
      c.fillRect(x * s, y * s, s, s);
    }
  }
  c.generateTexture('checker', s * 2, s * 8);
  c.destroy();
}
