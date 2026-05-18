import { contextBridge, ipcRenderer } from 'electron';

/**
 * Preload bridge for the renderer.
 *
 * Audio capture stays in the renderer (Web Audio + AudioWorklet), but the
 * Gemini Live WebSocket lives in the main process so the API key never
 * touches the renderer. This bridge is the only surface between them.
 *
 * Channels:
 *   renderer → main:
 *     gemini:start       — open a Live session
 *     gemini:audio       — Int16 PCM 16kHz mono chunk (ArrayBuffer)
 *     gemini:stop        — close the Live session
 *   main → renderer:
 *     gemini:opened          — session established
 *     gemini:transcript      — { text, finished } incremental partials
 *     gemini:turn-complete   — server marked the current turn complete
 *     gemini:error           — { message } connection/api error
 *     gemini:closed          — session closed (reason)
 */

const RENDERER_EVENTS = [
  'gemini:opened',
  'gemini:transcript',
  'gemini:turn-complete',
  'gemini:error',
  'gemini:closed',
];

function subscribe(channel) {
  return (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld('gemini', {
  start: () => ipcRenderer.invoke('gemini:start'),
  stop: () => ipcRenderer.invoke('gemini:stop'),
  // ArrayBuffer / Uint8Array survives structured clone across the bridge.
  sendAudio: (pcmChunk) => ipcRenderer.send('gemini:audio', pcmChunk),

  onOpened: subscribe('gemini:opened'),
  onTranscript: subscribe('gemini:transcript'),
  onTurnComplete: subscribe('gemini:turn-complete'),
  onError: subscribe('gemini:error'),
  onClosed: subscribe('gemini:closed'),

  // Escape hatch for renderer-side teardown / hot reload.
  _events: RENDERER_EVENTS,
});
