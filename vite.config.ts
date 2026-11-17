/// <reference types="vitest" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { ENGINE_VERSION } from './src/engine/config';

/** 배포마다 바뀌는 빌드 번호. 앱이 /version.json 과 비교해 새 버전이면 알아서 최신 화면으로 바뀐다 */
const BUILD_ID = Date.now().toString(36);

function versionFile(): Plugin {
  return {
    name: 'rhd-version-file',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ build: BUILD_ID, engine: ENGINE_VERSION }) });
    },
  };
}

export default defineConfig({
  plugins: [react(), versionFile()],
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID),
  },
  build: {
    chunkSizeWarningLimit: 2000,
  },
  test: {
    include: ['src/**/*.test.ts', 'supabase/tests/**/*.test.ts'],
    environment: 'node',
  },
});
