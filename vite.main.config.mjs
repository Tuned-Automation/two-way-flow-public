import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';

/**
 * Main-process Vite build.
 *
 * `bufferutil` and `utf-8-validate` are *optional* native deps of `ws` (used by
 * `@google/genai` for the Live API WebSocket). When they're absent, `ws` falls
 * back to a pure-JS implementation via a try/catch around `require()`. We tell
 * Rollup to keep them as external `require()` calls so the build doesn't fail
 * on the missing dep, and so the try/catch in `ws` can do its thing at runtime.
 *
 * ── Build-time version constants (version-badge feature) ────────────
 *
 * We bake the current git SHA / dirty-flag / build timestamp into the
 * main bundle as compile-time constants so the packaged .app — which
 * ships without a `.git` directory and can't run `git` at runtime —
 * still knows which commit it was built from. The renderer's
 * `#versionBadge` reads these via the `app:version` IPC channel.
 *
 * In dev mode (`npm start`) main.js still prefers a runtime `git
 * rev-parse` so the badge tracks the working-tree state across
 * commits without a Vite restart (see the `app.isPackaged` branch in
 * src/main.js's computeAppVersion). The defines below act as the
 * fallback when the runtime call fails (rare in dev, expected in
 * packaged builds).
 *
 * Each helper is wrapped in try/catch so a fresh checkout without git
 * — or a build run in a sandbox where `git` isn't on PATH — degrades
 * to placeholder values rather than failing the whole Vite build.
 */
function readGitSha() {
  try {
    return execSync('git rev-parse --short HEAD', {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    return '';
  }
}

function readGitDirty() {
  try {
    return (
      execSync('git status --porcelain', {
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .toString()
        .trim().length > 0
    );
  } catch {
    return false;
  }
}

export default defineConfig({
  define: {
    __APP_GIT_SHA__: JSON.stringify(readGitSha()),
    __APP_GIT_DIRTY__: JSON.stringify(readGitDirty()),
    __APP_BUILT_AT__: JSON.stringify(Date.now()),
  },
  build: {
    rollupOptions: {
      external: ['bufferutil', 'utf-8-validate'],
    },
  },
});
