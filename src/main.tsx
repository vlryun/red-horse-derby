import { StrictMode, Suspense, lazy, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { ErrorBoundary } from './components/ErrorBoundary';
import { env } from './lib/env';
import { useAutoUpdate } from './lib/appUpdate';
import { Home } from './pages/Home';
import { Play } from './pages/Play';
import './styles.css';
import './styles-lobby.css';
import './styles-race.css';
import './styles-admin.css';

/**
 * 화면별 코드 분리: 휴대폰(/play)은 대형 화면용 게임 엔진(Phaser)·QR 라이브러리를 받지 않는다.
 * 코드 조각 로딩이 실패하면(일시적 네트워크 문제, 재배포 직후 옛 페이지) 한 번 더 시도하고,
 * 그래도 안 되면 페이지를 한 번만 새로고침해서 최신 버전을 받는다.
 */
function lazyPage<T extends ComponentType>(load: () => Promise<{ default: T }>) {
  return lazy(async () => {
    try {
      return await load();
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        return await load();
      } catch (e) {
        const key = 'rhd.chunk-reload';
        if (!sessionStorage.getItem(key)) {
          sessionStorage.setItem(key, '1');
          location.reload();
        }
        throw e;
      }
    }
  });
}

const Screen = lazyPage(() => import('./pages/Screen').then((m) => ({ default: m.Screen })));
const ScreenDemo = lazyPage(() => import('./pages/ScreenDemo').then((m) => ({ default: m.ScreenDemo })));
const Admin = lazyPage(() => import('./pages/Admin').then((m) => ({ default: m.Admin })));

function Misconfigured() {
  return (
    <div className="fatal">
      <h1>서버 설정이 없어요</h1>
      <p>환경변수 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY 를 설정해 주세요 (개발: .env.local, 배포: Vercel 환경변수).</p>
    </div>
  );
}

/** 새 버전이 배포되면 알아서 최신 화면으로 (새로고침 안내 없이) */
function AutoUpdate() {
  useAutoUpdate();
  return null;
}

const Loading = () => <p className="pulse center page-loading">불러오는 중…</p>;

// 정상적으로 열렸으면 다음 번 코드 조각 실패 때 다시 새로고침할 수 있게 표시 해제
window.addEventListener('load', () => {
  try {
    sessionStorage.removeItem('rhd.chunk-reload');
  } catch {
    /* ignore */
  }
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      {env.misconfigured ? (
        <Misconfigured />
      ) : (
        <BrowserRouter>
          <AutoUpdate />
          <Suspense fallback={<Loading />}>
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/play" element={<Play />} />
              <Route path="/join" element={<Navigate to="/play" replace />} />
              <Route path="/screen" element={<Screen />} />
              <Route path="/demo" element={<ScreenDemo />} />
              <Route path="/admin" element={<Admin />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </BrowserRouter>
      )}
    </ErrorBoundary>
  </StrictMode>,
);
