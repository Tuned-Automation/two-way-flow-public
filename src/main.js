import 'dotenv/config';
import { app, BrowserWindow, globalShortcut, ipcMain, Menu, screen, session, systemPreferences } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { GeminiSession } from './gemini-session.js';
import { Coach } from './coach.js';

if (started) {
  app.quit();
}

// Single-instance lock: a second `npm start` (or running build) should focus
// the existing overlay instead of opening another window on top of it.
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

const WINDOW_WIDTH = 720;
const WINDOW_HEIGHT = 440;
const EDGE_MARGIN = 20;

/**
 * Single in-flight Gemini Live session + its sibling text-coach session.
 * The overlay only ever captures from one mic at a time, so we keep both
 * as module-level singletons instead of per-window state.
 *
 * Extension point: when adding multi-call support, key these by
 * webContents.id and route IPC events back to the correct sender.
 */
let liveSession = null;
let coachSession = null;
let mainWindowRef = null;

/**
 * Rolling state the coach reads each tick. Lives in main (not the
 * renderer) so the coach has zero-IPC access to it. The renderer mirrors
 * the same scoring state via `scoring:item` / `scoring:field` events,
 * but main is the source of truth for the coach's context.
 *
 * Reset on every `gemini:start` so a fresh call doesn't inherit stale
 * coverage.
 */
const coachContext = {
  /** @type {string[]} */
  transcriptLines: [],     // committed turns, oldest first
  pendingTranscript: '',   // current in-flight partial
  coveredItemIds: new Set(),
  /** @type {Record<string, { value: string, at: number }>} */
  capturedFields: {},
};

const COACH_TRANSCRIPT_WINDOW_LINES = 40; // cap context size
const COACH_RECENT_TURNS = 3;

function resetCoachContext() {
  coachContext.transcriptLines = [];
  coachContext.pendingTranscript = '';
  coachContext.coveredItemIds = new Set();
  coachContext.capturedFields = {};
}

function buildCoachContextSnapshot() {
  const lines = coachContext.transcriptLines.slice(-COACH_TRANSCRIPT_WINDOW_LINES);
  if (coachContext.pendingTranscript) lines.push(coachContext.pendingTranscript);
  return {
    transcriptWindow: lines.join('\n'),
    coveredItemIds: [...coachContext.coveredItemIds],
    capturedFields: coachContext.capturedFields,
    recentSellerTurns: coachContext.transcriptLines.slice(-COACH_RECENT_TURNS),
  };
}

const createWindow = () => {
  const { workArea } = screen.getPrimaryDisplay();
  const x = workArea.x + workArea.width - WINDOW_WIDTH - EDGE_MARGIN;
  const y = workArea.y + EDGE_MARGIN;

  const mainWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    x,
    y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    hasShadow: false,
    skipTaskbar: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.setAlwaysOnTop(true, 'floating');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    // Open DevTools in a detached window so it doesn't shove the overlay around.
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }

  mainWindow.on('closed', () => {
    if (mainWindowRef === mainWindow) mainWindowRef = null;
  });

  mainWindowRef = mainWindow;
  return mainWindow;
};

function send(channel, payload) {
  const w = mainWindowRef;
  if (!w || w.isDestroyed()) return;
  w.webContents.send(channel, payload);
}

async function teardownSession() {
  const c = coachSession;
  coachSession = null;
  if (c) {
    try { c.stop(); } catch { /* ignore */ }
  }

  const s = liveSession;
  liveSession = null;
  if (s) {
    try {
      await s.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Handle a transcript chunk from the live session.
 *
 * Behaviour:
 *   - Forward to the renderer untouched (it owns the ticker / drawer view).
 *   - Mirror into coachContext: append to `pendingTranscript`, commit a
 *     line on `finished: true`. The coach reads from this buffer.
 *
 * The coach's tick is independent of this function — it'll pick up any
 * committed lines on its next interval.
 */
function handleTranscript(payload) {
  send('gemini:transcript', payload);
  const text = typeof payload?.text === 'string' ? payload.text : '';
  if (!text) return;
  coachContext.pendingTranscript += text;
  if (payload?.finished) {
    const committed = coachContext.pendingTranscript.trim();
    if (committed) coachContext.transcriptLines.push(committed);
    coachContext.pendingTranscript = '';
  }
}

function handleTurnComplete() {
  send('gemini:turn-complete', null);
  const pending = coachContext.pendingTranscript.trim();
  if (pending) {
    coachContext.transcriptLines.push(pending);
    coachContext.pendingTranscript = '';
  }
}

function registerIpcHandlers() {
  ipcMain.handle('gemini:start', async () => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      // Treat missing key the same as a connection error from the renderer's
      // perspective so it lands in the "Connection lost" UI path.
      send('gemini:error', { message: 'GEMINI_API_KEY missing in .env' });
      return { ok: false, error: 'missing_api_key' };
    }

    // If a previous session is still hanging around (e.g. user double-clicked),
    // tear it down before opening a new one.
    await teardownSession();
    resetCoachContext();

    const next = new GeminiSession({
      apiKey,
      onTranscript: handleTranscript,
      onTurnComplete: handleTurnComplete,
      onFlag: (payload) => {
        console.log('[scoring] flag:', payload.id, '—', payload.evidence);
        send('scoring:flag', payload);
      },
      onError: (message) => {
        console.error('[gemini] session error:', message);
        send('gemini:error', { message });
        // The session is already in 'closed' state; clear our reference.
        if (liveSession === next) liveSession = null;
      },
      onClose: (reason) => {
        console.log('[gemini] session closed:', reason);
        send('gemini:closed', { reason });
        if (liveSession === next) liveSession = null;
      },
    });

    try {
      await next.open();
      liveSession = next;
      console.log('[gemini] session opened');
      send('gemini:opened', null);
    } catch (err) {
      const message = err?.message || 'Failed to open Gemini session';
      console.error('[gemini] failed to open session:', err);
      send('gemini:error', { message });
      return { ok: false, error: message };
    }

    // Spin up the text coach alongside the live session. The coach reads
    // coachContext on its own schedule and emits the structured scoring
    // events the renderer expects.
    coachSession = new Coach({
      apiKey,
      getContext: buildCoachContextSnapshot,
      onItemCovered: (payload) => {
        if (coachContext.coveredItemIds.has(payload.itemId)) return;
        coachContext.coveredItemIds.add(payload.itemId);
        console.log('[coach] item:', payload.itemId, '—', payload.evidence);
        send('scoring:item', payload);
      },
      onFieldCaptured: (payload) => {
        coachContext.capturedFields[payload.fieldId] = {
          value: payload.value,
          at: Date.now(),
        };
        console.log(
          '[coach] field:',
          payload.fieldId,
          '=',
          payload.value,
          '—',
          payload.evidence,
        );
        send('scoring:field', payload);
      },
      onSuggestion: (payload) => {
        console.log('[coach] suggest:', payload.itemId, '→', payload.question);
        send('coach:suggestion', payload);
      },
      onError: (message) => {
        // Coach errors are non-fatal — log only, don't surface to UI.
        console.warn('[coach] error:', message);
      },
    });
    coachSession.start();

    return { ok: true };
  });

  ipcMain.handle('gemini:stop', async () => {
    await teardownSession();
    return { ok: true };
  });

  // Renderer asks the coach for a fresh suggestion (seller pressed → at
  // the live edge of suggestion history). Cheap call — the coach handles
  // its own in-flight guard, so this is safe to fire repeatedly.
  ipcMain.handle('coach:skip', () => {
    coachSession?.skip();
    return { ok: true };
  });

  // Audio chunks are high-frequency and fire-and-forget — use `send` not `invoke`.
  ipcMain.on('gemini:audio', (_event, chunk) => {
    if (!liveSession) return;
    liveSession.sendAudio(chunk);
  });
}

app.whenReady().then(async () => {
  // Auto-grant media (mic/camera) permission requests from the renderer.
  // The OS-level prompt still gates real access on macOS/Windows.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    if (permission === 'media' || permission === 'audioCapture' || permission === 'microphone') {
      return callback(true);
    }
    callback(false);
  });

  if (process.platform === 'darwin') {
    try {
      await systemPreferences.askForMediaAccess('microphone');
    } catch {
      // Non-fatal: the renderer will surface "Mic blocked" if denied.
    }
  }

  registerIpcHandlers();

  // Standard macOS menu so Cmd+W / Cmd+Q work on the frameless window.
  // (Without an app menu, accelerators don't get a hosting menu item and the
  // window can't be closed except via Activity Monitor — exactly what we
  // just hit.)
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu' },
      {
        label: 'Window',
        submenu: [
          { role: 'minimize' },
          { role: 'close', accelerator: 'Cmd+W' },
        ],
      },
    ]));
  } else {
    Menu.setApplicationMenu(null);
  }

  // Belt-and-braces global shortcut for hiding the overlay even when it
  // doesn't have keyboard focus (frameless windows often don't).
  globalShortcut.register('CommandOrControl+Shift+H', () => {
    const w = mainWindowRef;
    if (!w || w.isDestroyed()) return;
    if (w.isVisible()) w.hide();
    else w.show();
  });

  createWindow();

  app.on('second-instance', () => {
    if (mainWindowRef && !mainWindowRef.isDestroyed()) {
      if (mainWindowRef.isMinimized()) mainWindowRef.restore();
      mainWindowRef.show();
      mainWindowRef.focus();
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  // For an overlay/tool app we want closing the window to actually exit the
  // process — on macOS the default behaviour is to keep the app alive in the
  // dock, which would leave the single-instance lock held and confuse the
  // next launch.
  teardownSession();
  app.quit();
});

app.on('before-quit', () => {
  teardownSession();
});
