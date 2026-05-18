import { defineConfig } from 'vite';

/**
 * Main-process Vite build.
 *
 * `bufferutil` and `utf-8-validate` are *optional* native deps of `ws` (used by
 * `@google/genai` for the Live API WebSocket). When they're absent, `ws` falls
 * back to a pure-JS implementation via a try/catch around `require()`. We tell
 * Rollup to keep them as external `require()` calls so the build doesn't fail
 * on the missing dep, and so the try/catch in `ws` can do its thing at runtime.
 */
export default defineConfig({
  build: {
    rollupOptions: {
      external: ['bufferutil', 'utf-8-validate'],
    },
  },
});
