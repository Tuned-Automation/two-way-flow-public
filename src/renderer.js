import './index.css';
import {
  PILLARS,
  PILLARS_BY_ID,
  ITEMS_BY_PILLAR,
  ITEMS_BY_ID,
  FIELDS_BY_ID,
  CAPTURED_FIELDS,
  FIELD_GROUPS,
  FLAGS_BY_ID,
} from './rubric.js';

/* ── Coach ticker / history behaviour ──────────────────────────────── */
const TICKER_MAX_CHARS = 80;
const COACH_HISTORY_MAX = 50;

/**
 * Renderer entry — three-column rubric coach overlay.
 *
 * Pipeline when "listening":
 *   getUserMedia → MediaStreamAudioSourceNode
 *     ├─ AnalyserNode  → speaker-activity heuristic (RMS threshold)
 *     └─ AudioWorkletNode (pcm-worklet) → IPC → Gemini Live
 *
 * Inbound IPC:
 *   gemini:*  — transcripts (drawer), errors
 *   scoring:flag  → state.flags
 *   scoring:item  → state.coveredItems[pillarId]
 *   scoring:field → state.capturedFields[fieldId]
 *
 * Rendering is one-way: render functions are pure over `state`. Anything
 * that mutates `state` calls the relevant render fn at the end.
 *
 * Extension points:
 *   - To add a new column or pane, follow the same `state` + `renderXxx()`
 *     pattern. Pure render functions keep diffing trivial.
 *   - To add a new IPC scoring event (e.g. category scores), add the
 *     channel to preload.js, push a new state slot, and write a render
 *     fn. The pipeline below stays narrow.
 */

const PCM_WORKLET_URL = './pcm-worklet.js';

/** Default pillar shown on the right (synthetic — owns flag display). */
const DEFAULT_PILLAR_ID = 'live_signals';

/** RMS thresholds for "is the user speaking" — calibrated for normal voice. */
const SPEAKER_RMS_ON = 0.04;
const SPEAKER_RMS_OFF_AFTER_MS = 600;
const LEVEL_GAIN = 3;

/* ── DOM refs ──────────────────────────────────────────────────────── */

const coachEl = document.getElementById('coach');
const recIndicatorEl = document.getElementById('recIndicator'); // eslint-disable-line no-unused-vars
const recTimerEl = document.getElementById('recTimer');
const speakerEls = Array.from(document.querySelectorAll('.speaker'));
const recToggleEl = document.getElementById('recToggle');
const minButtonEl = document.getElementById('minButton');
const closeButtonEl = document.getElementById('closeButton');
const railEl = document.getElementById('pillarRail');
const activePillarEl = document.getElementById('activePillar'); // eslint-disable-line no-unused-vars
const activePillarHeaderEl = document.getElementById('activePillarHeader');
const activePillarBodyEl = document.getElementById('activePillarBody');
const tickerEl = document.getElementById('transcriptTicker');
const coachSuggestionEl = document.getElementById('coachSuggestion');
const capturedPaneEl = document.getElementById('capturedPane');
const transcriptToggleEl = document.getElementById('transcriptToggle');
const transcriptDrawerEl = document.getElementById('transcriptDrawer');
const transcriptListEl = document.getElementById('transcriptList');
const transcriptPendingEl = document.getElementById('transcriptPending');
const transcriptErrorEl = document.getElementById('transcriptError');
const bodyEl = document.querySelector('.coach__body');
const footerEl = document.querySelector('.coach__footer');

/* ── State ─────────────────────────────────────────────────────────── */

const state = {
  /** 'idle' | 'starting' | 'listening' | 'error' */
  status: 'idle',

  /* Audio pipeline */
  stream: null,
  audioContext: null,
  source: null,
  analyser: null,
  workletNode: null,
  analyserBuffer: null,
  rafId: null,

  /* Recording timer */
  recordingStartedAt: null,
  timerInterval: null,

  /* Active speaker (drives header pills) */
  activeSpeaker: null, // 'you' | 'other' | null
  speakerOnAt: 0,
  speakerOffTimer: null,

  /* Rubric UI */
  selectedPillarId: DEFAULT_PILLAR_ID,
  /** pillarId → 'idle' | 'in_progress' | 'complete' */
  pillarStatus: Object.fromEntries(PILLARS.map((p) => [p.id, 'idle'])),
  /** pillarId → Map<itemId, { evidence, at }> */
  coveredItems: Object.fromEntries(PILLARS.map((p) => [p.id, new Map()])),
  /** fieldId → { value, evidence, at } */
  capturedFields: {},
  /** Fired live flags in arrival order, deduped by id. */
  flags: [],

  /** Coach suggestion history in arrival order. Capped at COACH_HISTORY_MAX. */
  coachHistory: [], // SuggestionEntry[]
  /** Index into coachHistory of the displayed suggestion. -1 = none yet. */
  coachIndex: -1,

  /* Transcript drawer */
  transcript: { committed: [], pending: '' },
  transcriptOpen: false,
  errorMessage: null,
};

/* ── Helpers ───────────────────────────────────────────────────────── */

function setStatus(next) {
  state.status = next;
  coachEl.dataset.status = next;
  // Toggle the rec button label without re-creating it.
  if (next === 'listening') {
    recToggleEl.textContent = 'Stop';
    recToggleEl.setAttribute('aria-label', 'Stop recording');
  } else if (next === 'starting') {
    recToggleEl.textContent = 'Starting…';
    recToggleEl.setAttribute('aria-label', 'Starting');
  } else {
    recToggleEl.textContent = 'Start';
    recToggleEl.setAttribute('aria-label', 'Start recording');
  }
}

function formatTimer(ms) {
  if (!ms || ms < 0) ms = 0;
  const totalSec = Math.floor(ms / 1000);
  const m = String(Math.floor(totalSec / 60)).padStart(2, '0');
  const s = String(totalSec % 60).padStart(2, '0');
  return `${m}:${s}`;
}

/* ── Render fns (pure over state) ──────────────────────────────────── */

function renderTimer() {
  const ms = state.recordingStartedAt
    ? Date.now() - state.recordingStartedAt
    : 0;
  recTimerEl.textContent = formatTimer(ms);
}

function renderSpeakers() {
  for (const el of speakerEls) {
    el.dataset.active = String(el.dataset.id === state.activeSpeaker);
  }
}

function renderRail() {
  // Diff-render: build all buttons once on first call, then only update
  // data attributes on subsequent calls. Cheap enough at 14 buttons.
  if (railEl.children.length !== PILLARS.length) {
    railEl.replaceChildren(...PILLARS.map(makePillarButton));
  }
  for (const el of railEl.children) {
    const id = el.dataset.id;
    el.dataset.selected = String(id === state.selectedPillarId);
    el.dataset.status = state.pillarStatus[id] || 'idle';
  }
}

function makePillarButton(pillar) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'pillar';
  btn.dataset.id = pillar.id;
  btn.dataset.selected = String(pillar.id === state.selectedPillarId);
  btn.dataset.status = state.pillarStatus[pillar.id] || 'idle';
  btn.setAttribute('aria-label', pillar.name);
  btn.title = pillar.name;

  const glyph = document.createElement('span');
  glyph.className = 'pillar__glyph';
  glyph.textContent = pillar.glyph;
  btn.appendChild(glyph);

  const dot = document.createElement('span');
  dot.className = 'pillar__dot';
  dot.setAttribute('aria-hidden', 'true');
  btn.appendChild(dot);

  btn.addEventListener('click', () => selectPillar(pillar.id));
  return btn;
}

function selectPillar(id) {
  if (!PILLARS_BY_ID[id]) return;
  if (state.selectedPillarId === id) return;
  state.selectedPillarId = id;
  renderRail();
  renderActivePillar();
}

function renderActivePillar() {
  const pillar = PILLARS_BY_ID[state.selectedPillarId];
  if (!pillar) return;

  const header = document.createElement('div');
  header.className = 'active-pillar__header';

  const title = document.createElement('h2');
  title.className = 'active-pillar__title';
  title.textContent = pillar.name;
  header.appendChild(title);

  if (pillar.synthetic) {
    const counter = document.createElement('span');
    counter.className = 'active-pillar__counter';
    counter.textContent = `${state.flags.length} fired`;
    header.appendChild(counter);
  } else {
    const items = ITEMS_BY_PILLAR[pillar.id] || [];
    const covered = state.coveredItems[pillar.id]?.size || 0;
    const counter = document.createElement('span');
    counter.className = 'active-pillar__counter';
    counter.textContent = `${covered} of ${items.length}`;
    header.appendChild(counter);
  }

  const body = pillar.synthetic
    ? renderLiveSignalsBody()
    : renderChecklistBody(pillar);

  activePillarHeaderEl.replaceChildren(header);
  activePillarBodyEl.replaceChildren(body);
}

/**
 * Single-line transcript ticker pinned to the bottom of the active pillar.
 * Shows the latest committed turn followed by any in-flight partial,
 * trimmed to TICKER_MAX_CHARS from the right so the newest text is
 * always visible. CSS handles the (rare) overflow with ellipsis.
 */
function renderTicker() {
  const lastCommitted = state.transcript.committed[state.transcript.committed.length - 1] || '';
  const pending = state.transcript.pending || '';
  const combined = (lastCommitted + ' ' + pending).trim();

  if (!combined) {
    tickerEl.hidden = true;
    tickerEl.textContent = '';
    return;
  }

  const trimmed = combined.length > TICKER_MAX_CHARS
    ? '… ' + combined.slice(combined.length - TICKER_MAX_CHARS)
    : combined;

  tickerEl.textContent = trimmed;
  tickerEl.hidden = false;
}

/**
 * Render the suggestion at `state.coachIndex` (or hide the card if there
 * isn't one yet). Includes a bottom-row nav affordance so the seller knows
 * what ←/→ do without us writing it on the screen any louder.
 *
 * History semantics: `coachHistory[coachHistory.length - 1]` is the latest
 * "live" suggestion; lower indices are older ones we've stored. Pressing
 * ← walks back, → walks forward. At the live end, → escalates into a
 * `coach:skip` IPC so the coach picks a fresh item.
 */
function renderCoachSuggestion() {
  const history = state.coachHistory;
  const idx = state.coachIndex;
  if (idx < 0 || idx >= history.length) {
    coachSuggestionEl.hidden = true;
    coachSuggestionEl.replaceChildren();
    return;
  }

  const sug = history[idx];
  const item = sug.itemId ? ITEMS_BY_ID[sug.itemId] : null;
  const pillar = item ? PILLARS_BY_ID[item.pillarId] : null;

  // --- label row -----------------------------------------------------
  const label = document.createElement('div');
  label.className = 'suggestion__label';
  const labelKind = document.createElement('span');
  labelKind.textContent = 'Ask next';
  label.appendChild(labelKind);
  if (pillar) {
    const pillarLabel = document.createElement('span');
    pillarLabel.className = 'suggestion__pillar';
    pillarLabel.textContent = `· ${pillar.short}`;
    label.appendChild(pillarLabel);
  }

  // --- question + rationale -----------------------------------------
  const question = document.createElement('p');
  question.className = 'suggestion__question';
  question.textContent = sug.question;

  const children = [label, question];
  if (sug.rationale) {
    const rationale = document.createElement('span');
    rationale.className = 'suggestion__rationale';
    rationale.textContent = sug.rationale;
    children.push(rationale);
  }

  // --- nav row -------------------------------------------------------
  const nav = document.createElement('div');
  nav.className = 'suggestion__nav';

  const left = document.createElement('span');
  left.className = 'suggestion__nav-side';
  left.dataset.enabled = String(idx > 0);
  left.textContent = '← prev';
  nav.appendChild(left);

  const position = document.createElement('span');
  position.className = 'suggestion__nav-position';
  const isLive = idx === history.length - 1;
  position.textContent = isLive
    ? `${history.length} of ${history.length} · live`
    : `${idx + 1} of ${history.length}`;
  nav.appendChild(position);

  const right = document.createElement('span');
  right.className = 'suggestion__nav-side';
  // Right is always available — at the live edge it means "skip / get
  // me a new one"; mid-history it means "step forward".
  right.dataset.enabled = 'true';
  right.textContent = isLive ? 'skip →' : 'next →';
  nav.appendChild(right);

  children.push(nav);

  coachSuggestionEl.replaceChildren(...children);
  coachSuggestionEl.hidden = false;
}

/** Push a new live suggestion into history, optionally moving the
 *  viewing index forward if the user was already tracking the live end. */
function pushCoachSuggestion(entry) {
  const wasAtLive =
    state.coachHistory.length === 0 || state.coachIndex === state.coachHistory.length - 1;

  state.coachHistory.push(entry);
  if (state.coachHistory.length > COACH_HISTORY_MAX) {
    const overflow = state.coachHistory.length - COACH_HISTORY_MAX;
    state.coachHistory.splice(0, overflow);
    if (state.coachIndex >= 0) state.coachIndex = Math.max(0, state.coachIndex - overflow);
  }

  if (wasAtLive) state.coachIndex = state.coachHistory.length - 1;
  renderCoachSuggestion();
}

function renderChecklistBody(pillar) {
  const items = ITEMS_BY_PILLAR[pillar.id] || [];
  if (items.length === 0) {
    const p = document.createElement('p');
    p.className = 'active-pillar__empty';
    p.textContent = 'No checklist items for this pillar.';
    return p;
  }

  const ul = document.createElement('ul');
  ul.className = 'checklist';

  const coveredMap = state.coveredItems[pillar.id] || new Map();

  for (const it of items) {
    const li = document.createElement('li');
    li.className = 'item';
    const covered = coveredMap.has(it.id);
    li.dataset.covered = String(covered);
    if (covered) {
      const ev = coveredMap.get(it.id)?.evidence;
      if (ev) li.title = ev;
    }

    const tick = document.createElement('span');
    tick.className = 'item__tick';
    tick.setAttribute('aria-hidden', 'true');
    tick.textContent = '✓';
    li.appendChild(tick);

    const label = document.createElement('span');
    label.className = 'item__label';
    label.textContent = it.label;
    li.appendChild(label);

    ul.appendChild(li);
  }

  return ul;
}

function renderLiveSignalsBody() {
  if (state.flags.length === 0) {
    const p = document.createElement('p');
    p.className = 'active-pillar__empty';
    p.textContent = 'No flags yet. Keep going — the coach is listening.';
    return p;
  }

  const wrap = document.createElement('div');
  wrap.className = 'checklist';

  for (const f of state.flags) {
    const row = document.createElement('div');
    row.className = 'flag-row';
    row.dataset.severity = f.severity;

    const bar = document.createElement('span');
    bar.className = 'flag-row__bar';
    bar.setAttribute('aria-hidden', 'true');
    row.appendChild(bar);

    const body = document.createElement('div');
    body.className = 'flag-row__body';

    const titleLine = document.createElement('span');
    titleLine.className = 'flag-row__title';

    const kind = document.createElement('span');
    kind.className = 'flag-row__kind';
    kind.textContent = f.severity === 'red' ? 'Risk' : 'Bonus';
    titleLine.appendChild(kind);

    const name = document.createElement('span');
    name.textContent = f.short;
    titleLine.appendChild(name);

    body.appendChild(titleLine);
    if (f.evidence) {
      const ev = document.createElement('span');
      ev.className = 'flag-row__evidence';
      ev.textContent = `“${f.evidence}”`;
      body.appendChild(ev);
    }
    row.appendChild(body);
    wrap.appendChild(row);
  }

  return wrap;
}

function renderCaptured() {
  /** @type {Record<string, HTMLElement[]>} */
  const byGroup = {};
  for (const f of CAPTURED_FIELDS) {
    const captured = state.capturedFields[f.id];

    const pair = document.createElement('div');
    pair.className = 'captured__pair';

    const label = document.createElement('span');
    label.className = 'captured__label';
    label.textContent = f.label;
    pair.appendChild(label);

    const value = document.createElement('span');
    value.className = 'captured__value';
    if (captured?.value) {
      value.textContent = captured.value;
      if (captured.evidence) pair.title = captured.evidence;
    } else {
      value.classList.add('captured__value--empty');
      value.textContent = '—';
    }
    pair.appendChild(value);

    (byGroup[f.group] ||= []).push(pair);
  }

  const out = [];
  for (const groupName of FIELD_GROUPS) {
    const heading = document.createElement('h3');
    heading.className = 'captured__heading';
    heading.textContent = groupName;

    const group = document.createElement('section');
    group.className = 'captured__group';
    group.appendChild(heading);
    for (const pair of byGroup[groupName] || []) group.appendChild(pair);

    out.push(group);
  }

  capturedPaneEl.replaceChildren(...out);
}

function renderTranscriptDrawer() {
  // Visibility of the drawer container.
  transcriptDrawerEl.hidden = !state.transcriptOpen;
  transcriptToggleEl.setAttribute('aria-expanded', String(state.transcriptOpen));
  const labelSpan = transcriptToggleEl.querySelector('span:last-child');
  if (labelSpan) {
    labelSpan.textContent = state.transcriptOpen ? 'Hide transcript' : 'Show transcript';
  }

  if (!state.transcriptOpen) return;

  if (state.errorMessage) {
    transcriptErrorEl.textContent = state.errorMessage;
    transcriptErrorEl.hidden = false;
    transcriptListEl.hidden = true;
    transcriptPendingEl.hidden = true;
    return;
  }
  transcriptErrorEl.hidden = true;

  const hasCommitted = state.transcript.committed.length > 0;
  transcriptListEl.hidden = !hasCommitted;
  transcriptListEl.replaceChildren(
    ...state.transcript.committed.map((line) => {
      const p = document.createElement('p');
      p.className = 'drawer__line';
      p.textContent = line;
      return p;
    }),
  );

  const hasPending = state.transcript.pending.length > 0;
  transcriptPendingEl.hidden = !hasPending;
  transcriptPendingEl.textContent = state.transcript.pending;

  transcriptDrawerEl.scrollTop = transcriptDrawerEl.scrollHeight;
}

function showConnectionError(message) {
  state.errorMessage = message || 'Connection lost';
  // Auto-open the drawer so the error is visible immediately.
  state.transcriptOpen = true;
  renderTranscriptDrawer();
}

function clearScoringState() {
  state.flags = [];
  state.coveredItems = Object.fromEntries(PILLARS.map((p) => [p.id, new Map()]));
  state.capturedFields = {};
  state.pillarStatus = Object.fromEntries(PILLARS.map((p) => [p.id, 'idle']));
  state.transcript = { committed: [], pending: '' };
  state.coachHistory = [];
  state.coachIndex = -1;
  state.errorMessage = null;
  renderRail();
  renderActivePillar();
  renderCaptured();
  renderTicker();
  renderCoachSuggestion();
  renderTranscriptDrawer();
}

/* ── Status / pillar progression ──────────────────────────────────── */

function recomputePillarStatus(pillarId) {
  if (pillarId === 'live_signals') {
    state.pillarStatus.live_signals = state.flags.length === 0 ? 'idle' : 'in_progress';
    return;
  }
  const items = ITEMS_BY_PILLAR[pillarId] || [];
  const covered = state.coveredItems[pillarId]?.size || 0;
  if (covered === 0) state.pillarStatus[pillarId] = 'idle';
  else if (covered >= items.length) state.pillarStatus[pillarId] = 'complete';
  else state.pillarStatus[pillarId] = 'in_progress';
}

/* ── Scoring event handlers ────────────────────────────────────────── */

function applyFlag({ id, evidence }) {
  if (typeof id !== 'string') return;
  if (state.flags.some((f) => f.id === id)) return;
  const meta = FLAGS_BY_ID[id];
  if (!meta) {
    console.warn('[scoring] unknown flag id:', id);
    return;
  }
  state.flags.push({
    id,
    evidence: typeof evidence === 'string' ? evidence : '',
    severity: meta.severity,
    short: meta.short,
    desc: meta.desc,
    category: meta.category,
  });
  recomputePillarStatus('live_signals');
  renderRail();
  if (state.selectedPillarId === 'live_signals') renderActivePillar();
}

function applyItemCovered({ itemId, evidence }) {
  if (typeof itemId !== 'string') return;
  const meta = ITEMS_BY_ID[itemId];
  if (!meta) {
    console.warn('[scoring] unknown item id:', itemId);
    return;
  }
  const map = state.coveredItems[meta.pillarId];
  if (!map) return;
  if (map.has(itemId)) return; // already covered, ignore re-firing
  map.set(itemId, { evidence: typeof evidence === 'string' ? evidence : '', at: Date.now() });
  recomputePillarStatus(meta.pillarId);
  renderRail();
  if (state.selectedPillarId === meta.pillarId) renderActivePillar();
}

function applyFieldCaptured({ fieldId, value, evidence }) {
  if (typeof fieldId !== 'string' || typeof value !== 'string') return;
  if (!FIELDS_BY_ID[fieldId]) {
    console.warn('[scoring] unknown field id:', fieldId);
    return;
  }
  state.capturedFields[fieldId] = {
    value,
    evidence: typeof evidence === 'string' ? evidence : '',
    at: Date.now(),
  };
  renderCaptured();
}

/* ── Audio capture / speaker activity ──────────────────────────────── */

function tickAnalyser() {
  if (!state.analyser || !state.analyserBuffer) return;
  state.analyser.getByteTimeDomainData(state.analyserBuffer);

  let sumSquares = 0;
  for (let i = 0; i < state.analyserBuffer.length; i++) {
    const sample = (state.analyserBuffer[i] - 128) / 128;
    sumSquares += sample * sample;
  }
  const rms = Math.sqrt(sumSquares / state.analyserBuffer.length);
  const level = Math.min(1, rms * LEVEL_GAIN);

  // Speaker activity: if the user is speaking, mark 'you' active. We have
  // no real second-speaker source today, so 'other' never becomes active
  // from this signal. Treat as a placeholder — real diarization is the
  // next step (requires system-audio capture on macOS).
  if (level > SPEAKER_RMS_ON) {
    if (state.activeSpeaker !== 'you') {
      state.activeSpeaker = 'you';
      renderSpeakers();
    }
    state.speakerOnAt = performance.now();
    if (state.speakerOffTimer) {
      clearTimeout(state.speakerOffTimer);
      state.speakerOffTimer = null;
    }
  } else if (state.activeSpeaker === 'you' && !state.speakerOffTimer) {
    state.speakerOffTimer = setTimeout(() => {
      state.activeSpeaker = null;
      state.speakerOffTimer = null;
      renderSpeakers();
    }, SPEAKER_RMS_OFF_AFTER_MS);
  }

  state.rafId = requestAnimationFrame(tickAnalyser);
}

async function startCapture() {
  if (state.status === 'listening' || state.status === 'starting') return;
  setStatus('starting');
  clearScoringState();

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
    showConnectionError('Microphone blocked. Enable mic access in System Settings.');
    setStatus('idle');
    return;
  }

  const result = await window.gemini.start();
  if (!result?.ok) {
    stream.getTracks().forEach((t) => t.stop());
    showConnectionError(
      result?.error === 'missing_api_key'
        ? 'Missing GEMINI_API_KEY in .env'
        : 'Connection lost',
    );
    setStatus('idle');
    return;
  }

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const audioContext = new AudioCtx();
  if (audioContext.state === 'suspended') {
    try { await audioContext.resume(); } catch { /* ignore */ }
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
  state.analyserBuffer = new Uint8Array(analyser.fftSize);

  // Recording timer.
  state.recordingStartedAt = Date.now();
  renderTimer();
  state.timerInterval = setInterval(renderTimer, 250);

  setStatus('listening');
  state.rafId = requestAnimationFrame(tickAnalyser);
}

async function stopCapture({ keepError = false } = {}) {
  if (state.rafId !== null) {
    cancelAnimationFrame(state.rafId);
    state.rafId = null;
  }
  if (state.speakerOffTimer) {
    clearTimeout(state.speakerOffTimer);
    state.speakerOffTimer = null;
  }
  if (state.timerInterval) {
    clearInterval(state.timerInterval);
    state.timerInterval = null;
  }

  if (state.workletNode) {
    try {
      state.workletNode.port.onmessage = null;
      state.workletNode.disconnect();
    } catch { /* ignore */ }
  }
  if (state.source) {
    try { state.source.disconnect(); } catch { /* ignore */ }
  }
  if (state.stream) {
    for (const track of state.stream.getTracks()) track.stop();
  }
  if (state.audioContext) {
    try { await state.audioContext.close(); } catch { /* ignore */ }
  }

  state.stream = null;
  state.audioContext = null;
  state.source = null;
  state.analyser = null;
  state.workletNode = null;
  state.analyserBuffer = null;
  state.recordingStartedAt = null;
  state.activeSpeaker = null;

  renderSpeakers();
  renderTimer();

  try { await window.gemini.stop(); } catch { /* ignore */ }

  // Commit any in-flight partial transcript so the user keeps the text.
  if (state.transcript.pending) {
    state.transcript.committed.push(state.transcript.pending);
    state.transcript.pending = '';
  }
  if (!keepError) state.errorMessage = null;

  renderTranscriptDrawer();
  setStatus('idle');
}

/* ── IPC subscriptions ─────────────────────────────────────────────── */

window.gemini.onTranscript(({ text, finished }) => {
  state.transcript.pending += text;
  if (finished) {
    if (state.transcript.pending) state.transcript.committed.push(state.transcript.pending);
    state.transcript.pending = '';
  }
  renderTicker();
  if (state.transcriptOpen) renderTranscriptDrawer();
});

window.gemini.onTurnComplete(() => {
  if (state.transcript.pending) {
    state.transcript.committed.push(state.transcript.pending);
    state.transcript.pending = '';
    renderTicker();
    if (state.transcriptOpen) renderTranscriptDrawer();
  }
});

window.gemini.onError(({ message }) => {
  console.error('[gemini] error:', message);
  showConnectionError(message?.includes('GEMINI_API_KEY') ? message : 'Connection lost');
  if (state.status === 'listening' || state.status === 'starting') {
    stopCapture({ keepError: true });
  } else {
    setStatus('idle');
  }
});

window.gemini.onClosed(() => {
  if (state.status === 'listening' || state.status === 'starting') {
    showConnectionError('Connection lost');
    stopCapture({ keepError: true });
  }
});

window.gemini.onScoringFlag(({ id, evidence }) => {
  console.log('[scoring] flag:', id);
  applyFlag({ id, evidence });
});

window.gemini.onScoringItem(({ itemId, evidence }) => {
  console.log('[scoring] item:', itemId);
  applyItemCovered({ itemId, evidence });
});

window.gemini.onScoringField(({ fieldId, value, evidence }) => {
  console.log('[scoring] field:', fieldId, '=', value);
  applyFieldCaptured({ fieldId, value, evidence });
});

window.gemini.onCoachSuggestion(({ itemId, question, rationale }) => {
  console.log('[coach] suggest:', itemId, '→', question);
  pushCoachSuggestion({
    itemId: typeof itemId === 'string' ? itemId : null,
    question: typeof question === 'string' ? question : '',
    rationale: typeof rationale === 'string' ? rationale : '',
    at: Date.now(),
  });
});

/* ── User input ────────────────────────────────────────────────────── */

recToggleEl.addEventListener('click', () => {
  if (state.status === 'idle' || state.status === 'error') {
    startCapture();
  } else if (state.status === 'listening') {
    stopCapture();
  }
});

minButtonEl.addEventListener('click', () => {
  // Native minimize via the BrowserWindow. We don't have ipcMain wired
  // for an explicit "minimize", so just blur — designer pass owns the
  // real minimised-pill state. Keeping this as a no-op placeholder is
  // worse than wiring window.electron later, but the user explicitly
  // flagged minimised state as a designer-next item.
  console.log('[ui] minimise pressed (placeholder)');
});

closeButtonEl.addEventListener('click', async () => {
  if (state.status === 'listening' || state.status === 'starting') {
    await stopCapture();
  }
  window.close();
});

transcriptToggleEl.addEventListener('click', () => {
  state.transcriptOpen = !state.transcriptOpen;
  // Hide the body + footer behind the drawer; the drawer is absolutely
  // positioned over them already, but visually-hiding the body avoids
  // the rail showing through if the drawer ever becomes translucent.
  if (bodyEl) bodyEl.style.visibility = state.transcriptOpen ? 'hidden' : 'visible';
  if (footerEl) footerEl.style.opacity = state.transcriptOpen ? '0.5' : '1';
  renderTranscriptDrawer();
});

document.addEventListener('keydown', (e) => {
  // Don't interfere with typing into any future inputs.
  const target = e.target;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;

  if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    recToggleEl.click();
    return;
  }
  if (e.key === 'Escape') {
    if (state.transcriptOpen) {
      transcriptToggleEl.click();
      return;
    }
    if (state.selectedPillarId !== DEFAULT_PILLAR_ID) {
      selectPillar(DEFAULT_PILLAR_ID);
    }
    return;
  }

  // Coach history navigation. Ignored when the drawer is open so the
  // seller can scroll the transcript with arrows there if a future
  // version supports it.
  if (state.transcriptOpen) return;
  if (e.key === 'ArrowLeft') {
    if (state.coachIndex > 0) {
      e.preventDefault();
      state.coachIndex -= 1;
      renderCoachSuggestion();
    }
    return;
  }
  if (e.key === 'ArrowRight') {
    if (state.coachIndex < state.coachHistory.length - 1) {
      e.preventDefault();
      state.coachIndex += 1;
      renderCoachSuggestion();
    } else if (state.coachHistory.length > 0) {
      e.preventDefault();
      // At the live edge — ask the coach for a fresh suggestion. The
      // new suggestion arrives asynchronously via onCoachSuggestion.
      window.gemini.skipCoachSuggestion?.();
    }
    return;
  }
});

window.addEventListener('beforeunload', () => {
  if (state.status === 'listening' || state.status === 'starting') {
    stopCapture();
  }
});

/* ── Initial render ─────────────────────────────────────────────────── */

renderTimer();
renderSpeakers();
renderRail();
renderActivePillar();
renderCaptured();
renderTicker();
renderCoachSuggestion();
renderTranscriptDrawer();
