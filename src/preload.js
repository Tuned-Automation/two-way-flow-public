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
 *     coach:skip         — seller pressed → on a live suggestion; ask
 *                          the text coach for a fresh one
 *   main → renderer:
 *     gemini:opened          — session established
 *     gemini:transcript      — { text, finished } incremental partials
 *     gemini:turn-complete   — server marked the current turn complete
 *     gemini:error           — { message } connection/api error
 *     gemini:closed          — session closed (reason)
 *     scoring:flag           — { id, evidence } live coaching flag fired
 *                              by the audio Live session.
 *     scoring:item           — { itemId, evidence } rubric checklist item
 *                              marked as covered (fired by the text
 *                              coach).
 *     scoring:field          — { fieldId, value, evidence } structured
 *                              key/value pair extracted by the text
 *                              coach.
 *     coach:suggestion       — { itemId, question, rationale } the text
 *                              coach's most recent "ask this next"
 *                              recommendation.
 *
 * `scoring:*` carries the structured-rubric pipeline; `coach:*` carries
 * the next-question advisory output. They share a producer (the text
 * coach in src/coach.js) but are split so the renderer can subscribe to
 * each surface independently.
 */

const RENDERER_EVENTS = [
  'gemini:opened',
  'gemini:transcript',
  'gemini:turn-complete',
  'gemini:error',
  'gemini:closed',
  'scoring:flag',
  'scoring:item',
  'scoring:field',
  'coach:suggestion',
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
  skipCoachSuggestion: () => ipcRenderer.invoke('coach:skip'),
  // ArrayBuffer / Uint8Array survives structured clone across the bridge.
  sendAudio: (pcmChunk) => ipcRenderer.send('gemini:audio', pcmChunk),

  onOpened: subscribe('gemini:opened'),
  onTranscript: subscribe('gemini:transcript'),
  onTurnComplete: subscribe('gemini:turn-complete'),
  onError: subscribe('gemini:error'),
  onClosed: subscribe('gemini:closed'),
  onScoringFlag: subscribe('scoring:flag'),
  onScoringItem: subscribe('scoring:item'),
  onScoringField: subscribe('scoring:field'),
  onCoachSuggestion: subscribe('coach:suggestion'),

  // Escape hatch for renderer-side teardown / hot reload.
  _events: RENDERER_EVENTS,
});
