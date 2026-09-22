import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  // `port` and `strictPort` are pinned rather than left to Vite's default
  // because the root `dev:host` script names this origin verbatim in
  // `PICKARR_PUBLIC_URL`, and that is the origin Better Auth trusts. Letting
  // Vite pick -- either by changing its own default, or by stepping to 5174
  // when 5173 is busy -- would leave the app loading and browsing normally
  // while every sign-in is refused. `strictPort` turns that into a refusal to
  // start, which is the failure you can read.
  //
  // `7676` is the host's `DEFAULT_PORT`, and it is a literal here on purpose:
  // `packages/web` does not import from `packages/host`. The two are held
  // together by `scripts/check-dev-scripts.test.ts` instead.
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': 'http://localhost:7676' },
  },
});
