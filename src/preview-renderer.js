/**
 * Transparency preview-window renderer.
 *
 * This file is the entire JS surface of the preview window. It does
 * three things and nothing else:
 *
 *   1. Imports src/index.css so the preview surfaces look pixel-
 *      identical to the live overlay. (The HTML re-uses the .coach,
 *      .transcript-pane, .captured, .suggestion class names.)
 *
 *   2. On first paint, reads the persisted settings via
 *      window.gemini.settings.load() and applies every
 *      `appearance.transparency.<surface>.<channel>` value to the
 *      matching --surface-<surface>-<channel>-alpha CSS variable on
 *      document.documentElement.
 *
 *   3. Subscribes to `settings:changed` (the same broadcast the main
 *      renderer uses) and re-applies the same writes on every
 *      payload. The main process's broadcastSettings() helper
 *      (src/main.js) fans the event out to both windows, so a slider
 *      nudge in the Appearance tab re-skins this window in lock-step.
 *
 * Invariants:
 *   - NEVER call window.gemini.settings.save (or any other mutating
 *     IPC). The preview is one-way; all edits flow FROM the main
 *     window. Adding writes here would break plan invariants 4 + 5.
 *   - NEVER touch live-session state (mic, deepgram, gemini, coach).
 *     The preview is a styling sandbox.
 */

import './index.css';

const SURFACES = ['coach', 'transcript', 'captured', 'suggestion'];
const CHANNELS = ['outline', 'body', 'text'];

/**
 * Write every numeric value in an `appearance.transparency` block
 * onto the documentElement as the corresponding --surface-*-alpha
 * CSS variable. Missing surfaces / channels are skipped — the :root
 * defaults in src/index.css then carry their own fallback values.
 *
 * Clamps each value to [0, 1] defensively in case a hand-edited
 * settings.json contains an out-of-range number. color-mix() with a
 * percentage > 100% behaves well in current browsers, but clamping
 * here keeps the slider UI / preview / persisted state all in
 * agreement.
 */
function applyTransparency(transparencyBlock) {
  if (!transparencyBlock || typeof transparencyBlock !== 'object') return;
  for (const surface of SURFACES) {
    const surfaceBlock = transparencyBlock[surface];
    if (!surfaceBlock || typeof surfaceBlock !== 'object') continue;
    for (const channel of CHANNELS) {
      const value = surfaceBlock[channel];
      if (typeof value !== 'number' || Number.isNaN(value)) continue;
      const clamped = Math.max(0, Math.min(1, value));
      document.documentElement.style.setProperty(
        `--surface-${surface}-${channel}-alpha`,
        String(clamped),
      );
    }
  }
}

async function bootstrap() {
  // First-paint hydration. If this fails (e.g. the preload bridge
  // hasn't initialised yet — shouldn't happen but be defensive) the
  // :root CSS defaults in src/index.css carry the live look until
  // the next settings:changed broadcast.
  try {
    const settings = await window.gemini?.settings?.load();
    applyTransparency(settings?.appearance?.transparency);
  } catch (err) {
    console.warn('[preview] initial settings load failed', err);
  }
}

// Subscribe BEFORE bootstrap so an immediate settings:changed
// broadcast between the windows opening can't race past us.
window.gemini?.onSettingsChanged?.((payload) => {
  applyTransparency(payload?.appearance?.transparency);
});

bootstrap();
