import Phaser from 'phaser';
import { useEffect, useRef } from 'react';
import type { RaceResult } from '../engine';
import type { RaceClock } from './clock';
import { RaceScene, VIEW_H, VIEW_W } from './RaceScene';
import { Race3D, canUse3D } from '../game3d/Race3D';

interface Props {
  race: RaceResult | null;
  clock: RaceClock | null;
  onFinished?: (r: RaceResult) => void;
  onPresentationDone?: (r: RaceResult) => void;
  /** 참가자 작전 연출 (실제 경주 화면만, 비상 모드는 끔) */
  tactics?: boolean;
}

/** 웹폰트가 늦게 오거나 실패해도 게임은 반드시 시작 (최대 2.5초 대기) */
async function waitFonts(): Promise<void> {
  if (!('fonts' in document)) return;
  const load = Promise.all([
    document.fonts.load('60px "Black Han Sans"'),
    document.fonts.load('900 40px "Noto Sans KR"'),
  ]).catch(() => undefined);
  await Promise.race([load, new Promise((r) => setTimeout(r, 2500))]);
}

/**
 * Phaser 게임을 React 에 마운트.
 * 게임 인스턴스는 한 번만 만들고, 경주 데이터만 교체한다.
 */
export function PhaserRace({ race, clock, onFinished, onPresentationDone, tactics = false }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<RaceScene | null>(null);
  const latest = useRef({ race, clock, onFinished, onPresentationDone, tactics });
  latest.current = { race, clock, onFinished, onPresentationDone, tactics };
  const callbacks = {
    onFinished: (r: RaceResult) => latest.current.onFinished?.(r),
    onPresentationDone: (r: RaceResult) => latest.current.onPresentationDone?.(r),
  };

  useEffect(() => {
    let game: Phaser.Game | null = null;
    let cancelled = false;
    let view: Race3D | null = null;
    let threeCanvas: HTMLCanvasElement | null = null;
    let ro: ResizeObserver | null = null;

    void waitFonts().then(() => {
      if (cancelled || !hostRef.current) return;
      const scene = new RaceScene();
      sceneRef.current = scene;
      // 3D 중계 (WebGL 이 안 되거나 ?view=2d 면 기존 2D 트랙). 3D 캔버스는 Phaser(HUD) 캔버스 바로 아래에 같은 크기로
      const host = hostRef.current;
      if (!/[?&]view=2d(&|$)/.test(location.search) && canUse3D()) {
        try {
          threeCanvas = document.createElement('canvas');
          threeCanvas.className = 'three-layer';
          host.appendChild(threeCanvas);
          view = new Race3D(threeCanvas);
        } catch (e) {
          console.warn('[3d] 사용할 수 없어 2D 로 표시', e);
          threeCanvas?.remove();
          threeCanvas = null;
          view = null;
        }
      }
      scene.attach3d(view);
      game = new Phaser.Game({
        type: Phaser.AUTO, // WebGL 실패 시 Canvas 로 자동 대체
        parent: host,
        width: VIEW_W,
        height: VIEW_H,
        transparent: !!view,
        backgroundColor: view ? undefined : '#3d0709',
        scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
        render: { antialias: true, powerPreference: 'high-performance' },
        fps: { target: 60, smoothStep: true },
        banner: false,
        scene,
      });
      if (import.meta.env.DEV) (window as unknown as { __raceScene: RaceScene }).__raceScene = scene;
      // 3D 캔버스를 Phaser 캔버스와 같은 위치·크기로 (화면 크기가 바뀔 때마다)
      const sync = () => {
        const pc = game?.canvas;
        if (!pc || !threeCanvas) return;
        Object.assign(threeCanvas.style, {
          position: 'absolute',
          left: `${pc.offsetLeft}px`,
          top: `${pc.offsetTop}px`,
          width: pc.style.width,
          height: pc.style.height,
          margin: '0',
        });
        pc.style.position = 'relative';
        pc.style.zIndex = '1';
      };
      if (threeCanvas) {
        game.scale.on('resize', sync);
        ro = new ResizeObserver(() => requestAnimationFrame(sync));
        ro.observe(host);
        requestAnimationFrame(sync);
        setTimeout(sync, 300);
      }
      const l = latest.current;
      scene.setRace(l.race, l.clock, callbacks, { tactics: l.tactics });
    });

    return () => {
      cancelled = true;
      sceneRef.current = null;
      game?.destroy(true);
      ro?.disconnect();
      view?.dispose();
      threeCanvas?.remove();
    };
  }, []);

  useEffect(() => {
    sceneRef.current?.setRace(race, clock, callbacks, { tactics });
  }, [race, clock, tactics]);

  return <div ref={hostRef} className="phaser-host" />;
}
