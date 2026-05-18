import './index.css';

// The PCM worklet lives in `public/` so Vite serves it untransformed in dev
// and copies it verbatim to the renderer output in production. AudioWorklet
// modules cannot go through Vite's JS pipeline (no HMR/ESM wrapping allowed).
const PCM_WORKLET_URL = './pcm-worklet.js';

/**
 * Renderer entry.
 *
 * Pipeline when "listening":
 *   getUserMedia → MediaStreamAudioSourceNode
 *     ├─ AnalyserNode  → meter (RMS, drawn via requestAnimationFrame)
 *     └─ AudioWorkletNode (pcm-worklet)
 *           └─ port.onmessage(Int16 PCM @ 16kHz mono, ~100ms frames)
 *                 └─ window.gemini.sendAudio(...) → main → Gemini Live
 *
 * Inbound: transcripts/errors arrive on the contextBridge subscriptions
 * (see `src/preload.js`) and update the scrollable transcript UI.
 *
 * Extension point: when adding rubric scoring, scoring events should arrive
 * on a new IPC channel and render into a *separate* panel below the
 * transcript — do not multiplex them into the transcript stream.
 */

const statusButton = document.getElementById('statusToggle');
const statusText = document.getElementById('statusText');
const meterFill = document.getElementById('meterFill');
const closeButton = document.getElementById('closeButton');
const transcriptEl = document.getElementById('transcript');
const transcriptListEl = document.getElementById('transcriptList');
const transcriptPendingEl = document.getElementById('transcriptPending');
const transcriptErrorEl = document.getElementById('transcriptError');

const LABELS = {
  idle: 'Ready',
  starting: 'Starting…',
  listening: 'Listening…',
  error: 'Mic blocked',
};

const LEVEL_GAIN = 3;

const state = {
  status: 'idle',
  stream: null,
  audioContext: null,
  source: null,
  analyser: null,
  workletNode: null,
  buffer: null,
  rafId: null,

  /** Finalised transcript lines (one per Gemini turn). */
  committed: [],
  /** Current in-progress turn text. */
  pending: '',
  /** When non-null, an error message is shown instead of the transcript. */
  errorMessage: null,
};

// ---------- UI ----------

function setStatus(next) {
  state.status = next;
  statusButton.dataset.state = next;
  statusButton.setAttribute('aria-pressed', String(next === 'listening'));
  statusText.textContent = LABELS[next] ?? LABELS.idle;
}

function renderMeterLevel(level) {
  meterFill.style.transform = `scaleX(${level})`;
}

function renderTranscript() {
  if (state.errorMessage) {
    transcriptErrorEl.textContent = state.errorMessage;
    transcriptErrorEl.hidden = false;
    transcriptListEl.hidden = true;
    transcriptPendingEl.hidden = true;
    transcriptEl.hidden = false;
    return;
  }

  const hasAny = state.committed.length > 0 || state.pending.length > 0;
  transcriptEl.hidden = !hasAny;
  transcriptErrorEl.hidden = true;

  transcriptListEl.hidden = state.committed.length === 0;
  transcriptListEl.replaceChildren(
    ...state.committed.map((line) => {
      const p = document.createElement('p');
      p.className = 'transcript__line';
      p.textContent = line;
      return p;
    }),
  );

  transcriptPendingEl.hidden = state.pending.length === 0;
  transcriptPendingEl.textContent = state.pending;

  // Auto-scroll to bottom on every update.
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function clearTranscript() {
  state.committed = [];
  state.pending = '';
  state.errorMessage = null;
  renderTranscript();
}

function showConnectionError(message) {
  state.errorMessage = message || 'Connection lost';
  renderTranscript();
}

// ---------- Mic capture + worklet ----------

function tickMeter() {
  if (!state.analyser || !state.buffer) return;
  state.analyser.getByteTimeDomainData(state.buffer);

  let sumSquares = 0;
  for (let i = 0; i < state.buffer.length; i++) {
    const sample = (state.buffer[i] - 128) / 128;
    sumSquares += sample * sample;
  }
  const rms = Math.sqrt(sumSquares / state.buffer.length);
  const level = Math.min(1, rms * LEVEL_GAIN);

  renderMeterLevel(level);
  state.rafId = requestAnimationFrame(tickMeter);
}

async function startCapture() {
  setStatus('starting');
  clearTranscript();

  // 1. Grab the mic first. If the user denies, we never open a Gemini session.
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
      video: false,
    });
  } catch (err) {
    console.error('[mic] getUserMedia failed:', err);
    setStatus('error');
    setTimeout(() => {
      if (state.status === 'error') setStatus('idle');
    }, 2000);
    return;
  }

  // 2. Open the Gemini session. Tear the mic down if it fails.
  const result = await window.gemini.start();
  if (!result?.ok) {
    stream.getTracks().forEach((t) => t.stop());
    // Missing-key is the one user-actionable error worth distinguishing in
    // the UI; everything else falls through to the generic message and the
    // real cause is in the main-process terminal log.
    showConnectionError(
      result?.error === 'missing_api_key'
        ? 'Missing GEMINI_API_KEY in .env'
        : 'Connection lost',
    );
    setStatus('idle');
    return;
  }

  // 3. Build the audio graph: source → [analyser, worklet].
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const audioContext = new AudioCtx();
  if (audioContext.state === 'suspended') {
    try {
      await audioContext.resume();
    } catch {
      /* ignore */
    }
  }

  try {
    await audioContext.audioWorklet.addModule(PCM_WORKLET_URL);
  } catch (err) {
    console.error('[mic] failed to load PCM worklet:', err);
    stream.getTracks().forEach((t) => t.stop());
    await audioContext.close().catch(() => {});
    await window.gemini.stop();
    showConnectionError('Audio worklet failed to load');
    setStatus('idle');
    return;
  }

  const source = audioContext.createMediaStreamSource(stream);

  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.7;
  source.connect(analyser);

  const workletNode = new AudioWorkletNode(audioContext, 'pcm-worklet', {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    channelCount: 1,
    processorOptions: { targetRate: 16000, frameSamples: 1600 },
  });
  workletNode.port.onmessage = (event) => {
    // event.data is an ArrayBuffer of Int16 PCM. Forward as-is; the preload
    // bridge structured-clones it across to the main process.
    const buffer = event.data;
    if (buffer && buffer.byteLength > 0) {
      window.gemini.sendAudio(new Uint8Array(buffer));
    }
  };
  source.connect(workletNode);

  state.stream = stream;
  state.audioContext = audioContext;
  state.source = source;
  state.analyser = analyser;
  state.workletNode = workletNode;
  state.buffer = new Uint8Array(analyser.fftSize);

  setStatus('listening');
  state.rafId = requestAnimationFrame(tickMeter);
}

async function stopCapture({ keepError = false } = {}) {
  if (state.rafId !== null) {
    cancelAnimationFrame(state.rafId);
    state.rafId = null;
  }

  if (state.workletNode) {
    try {
      state.workletNode.port.onmessage = null;
      state.workletNode.disconnect();
    } catch {
      /* ignore */
    }
  }
  if (state.source) {
    try {
      state.source.disconnect();
    } catch {
      /* ignore */
    }
  }
  if (state.stream) {
    for (const track of state.stream.getTracks()) track.stop();
  }
  if (state.audioContext) {
    try {
      await state.audioContext.close();
    } catch {
      /* ignore */
    }
  }

  state.stream = null;
  state.audioContext = null;
  state.source = null;
  state.analyser = null;
  state.workletNode = null;
  state.buffer = null;

  renderMeterLevel(0);

  try {
    await window.gemini.stop();
  } catch {
    /* ignore */
  }

  // Commit any in-flight partial as a final line so the user keeps the text.
  if (state.pending) {
    state.committed.push(state.pending);
    state.pending = '';
  }
  if (!keepError) {
    state.errorMessage = null;
  }
  renderTranscript();
  setStatus('idle');
}

// ---------- Main → renderer events ----------

window.gemini.onTranscript(({ text, finished }) => {
  state.pending += text;
  // Some servers send `finished: true` on the final partial of a turn — treat
  // that as a turn boundary too.
  if (finished) {
    if (state.pending) state.committed.push(state.pending);
    state.pending = '';
  }
  renderTranscript();
});

window.gemini.onTurnComplete(() => {
  if (state.pending) {
    state.committed.push(state.pending);
    state.pending = '';
    renderTranscript();
  }
});

window.gemini.onError(({ message }) => {
  console.error('[gemini] error:', message);
  // Surface only the user-actionable case (missing key) verbatim. For
  // everything else the real cause is logged to console + main-process
  // terminal so devs can diagnose; users just see "Connection lost".
  showConnectionError(message?.includes('GEMINI_API_KEY') ? message : 'Connection lost');
  if (state.status === 'listening' || state.status === 'starting') {
    stopCapture({ keepError: true });
  } else {
    setStatus('idle');
  }
});

window.gemini.onClosed(() => {
  // Server-initiated close while we still think we're listening counts as an error.
  if (state.status === 'listening' || state.status === 'starting') {
    showConnectionError('Connection lost');
    stopCapture({ keepError: true });
  }
});

// ---------- Toggle ----------

statusButton.addEventListener('click', () => {
  if (state.status === 'idle' || state.status === 'error') {
    startCapture();
  } else if (state.status === 'listening') {
    stopCapture();
  }
  // While 'starting', ignore clicks.
});

closeButton.addEventListener('click', async () => {
  // Make sure we tear down mic + Gemini cleanly before the window goes away.
  if (state.status === 'listening' || state.status === 'starting') {
    await stopCapture();
  }
  window.close();
});

window.addEventListener('beforeunload', () => {
  if (state.status === 'listening' || state.status === 'starting') {
    stopCapture();
  }
});
