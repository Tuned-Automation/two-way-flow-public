import 'dotenv/config';
import { app, BrowserWindow, globalShortcut, ipcMain, Menu, screen, session, systemPreferences } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { GeminiSession } from './gemini-session.js';

if (started) {
  app.quit();
}

// Single-instance lock: a second `npm start` (or running build) should focus
// the existing overlay instead of opening another window on top of it.
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

const WINDOW_WIDTH = 380;
const WINDOW_HEIGHT = 600;
const EDGE_MARGIN = 20;

/**
 * Single in-flight Gemini Live session. The overlay only ever captures from
 * one mic at a time, so we keep this as a module-level singleton instead of
 * per-window state.
 *
 * Extension point: when adding multi-call support, key this by webContents.id
 * and route IPC events back to the correct sender.
 */
let liveSession = null;
let mainWindowRef = null;

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

    const next = new GeminiSession({
      apiKey,
      onTranscript: (payload) => send('gemini:transcript', payload),
      onTurnComplete: () => send('gemini:turn-complete', null),
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
      return { ok: true };
    } catch (err) {
      const message = err?.message || 'Failed to open Gemini session';
      console.error('[gemini] failed to open session:', err);
      send('gemini:error', { message });
      return { ok: false, error: message };
    }
  });

  ipcMain.handle('gemini:stop', async () => {
    await teardownSession();
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
