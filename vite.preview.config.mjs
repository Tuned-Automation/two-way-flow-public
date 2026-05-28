import { defineConfig } from 'vite';

// https://vitejs.dev/config
//
// Preview-window renderer. Loads preview.html at the project root.
// Kept separate from vite.renderer.config.mjs so the bundles are
// fully isolated — the preview never imports the main renderer's
// heavyweight modules (coach.js, deepgram-session.js, etc.). The
// preview window is a styling sandbox only; it subscribes to the
// settings:changed broadcast over the preload bridge and mirrors
// the per-surface alpha CSS variables. See
// docs/superpowers/plans/2026-05-27-per-surface-transparency-settings.md
// for the full lifecycle (Task 3 + Task 5).
export default defineConfig({
  build: {
    rollupOptions: {
      input: 'preview.html',
    },
  },
});
