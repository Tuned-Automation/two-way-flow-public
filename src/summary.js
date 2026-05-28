import { Type } from '@google/genai';
import {
  PILLARS,
  ITEMS_BY_PILLAR,
  CAPTURED_FIELDS,
  FIELD_GROUPS,
} from './rubric.js';

/**
 * Post-call summary generator.
 *
 * Consumes the final coachContext snapshot from main.js and produces a
 * structured summary object plus JSON + Markdown serialisations for the
 * Phase 5 summary modal (Scorecard / Facts / Transcript / AI Debrief).
 *
 * Pipeline
 *   1. Derive a per-pillar scorecard from itemStates (counts of
 *      covered / in_progress / logged out of pillar total).
 *   2. Group capturedFields by their rubric group for the facts table.
 *   3. Stitch transcriptLines into a single string (speaker prefixes
 *      preserved as-supplied by main.js).
 *   4. Single Gemini Flash call with a strict JSON schema to produce
 *      the AI debrief (wentWell / missed / exactly-3 improvements).
 *   5. Serialise to JSON + Markdown for the export buttons.
 *
 * The debrief call is best-effort — if it fails, we return a fallback
 * debrief so the modal still renders the scorecard, facts, and
 * transcript. Never let a Gemini hiccup block the post-call summary.
 *
 * Inputs (coachContext) — design assumes Phase 4 has shipped:
 *   transcriptLines: string[]    committed turns prefixed by speaker
 *                                ("You: …" / "Prospect: …").
 *   itemStates:      Map<itemId, { state, evidence, confidence, at }>
 *                    state ∈ 'pending' | 'in_progress' | 'covered' | 'logged'.
 *   capturedFields:  Record<fieldId, { value: string, at: number }>.
 *   durationMs:      number      total session duration in ms.
 *
 * Extension point: to add more debrief sections (e.g. risk register,
 * recommended follow-up email), extend DEBRIEF_SCHEMA and the
 * post-processing in `generateDebrief()`. The Markdown builder already
 * iterates the debrief object's known keys.
 */

/**
 * Default debrief model. Today summary always runs on Gemini, so this
 * is the Gemini model name; main.js threads the actual configured
 * value through via getModelFor('summary') when it builds the provider
 * instance. Kept as a named export for back-compat.
 */
export const SUMMARY_MODEL = 'gemini-2.5-flash';

const DEBRIEF_SYSTEM_INSTRUCTION = [
  'You are a senior sales coach reviewing the transcript of a completed',
  'discovery call. Write a tight post-call debrief for the salesperson.',
  '',
  'Tone: direct, evidence-led, no fluff, no emojis. The salesperson is a',
  'working pro — skip generic platitudes and call out specific moments',
  'from the transcript when you can.',
  '',
  'You MUST return JSON matching the provided schema:',
  '  wentWell:     2-3 sentences identifying the strongest behaviours.',
  '  missed:       2-3 sentences identifying the most important things',
  '                that were skipped, mishandled, or under-explored.',
  '  improvements: EXACTLY 3 short strings. Each one sentence, in the',
  '                voice of advice ("Ask budget earlier when …").',
].join('\n');

const DEBRIEF_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    wentWell: {
      type: Type.STRING,
      description: '2-3 sentences on what went well in the call.',
    },
    missed: {
      type: Type.STRING,
      description: '2-3 sentences on what was missed or under-explored.',
    },
    improvements: {
      type: Type.ARRAY,
      description: 'Exactly 3 short, actionable improvement bullets.',
      items: { type: Type.STRING },
      minItems: 3,
      maxItems: 3,
    },
  },
  required: ['wentWell', 'missed', 'improvements'],
};

/**
 * @param {{
 *   provider: { generateContent: Function } | null,
 *   coachContext: {
 *     transcriptLines?: string[],
 *     itemStates?: Map<string, { state: string, evidence?: string, confidence?: number, at?: number }>
 *                | Record<string, { state: string, evidence?: string, confidence?: number, at?: number }>,
 *     capturedFields?: Record<string, { value: string, at?: number }>,
 *     durationMs?: number,
 *   },
 * }} args
 *
 * The `provider` is constructed in main.js via getProvider() — currently
 * always the Gemini provider because summary's structured-output
 * (responseSchema) feature is Gemini-specific. A null / missing
 * provider degrades gracefully into a transcript-only summary so a
 * misconfigured key doesn't block the Stop flow.
 */
export async function generateSummary({ provider, coachContext, usageAccumulator }) {
  const ctx = coachContext || {};
  const transcriptLines = Array.isArray(ctx.transcriptLines) ? ctx.transcriptLines : [];
  const itemStates = normaliseItemStates(ctx.itemStates);
  const capturedFields = ctx.capturedFields && typeof ctx.capturedFields === 'object'
    ? ctx.capturedFields
    : {};
  const durationMs = typeof ctx.durationMs === 'number' ? ctx.durationMs : 0;

  const scorecard = buildScorecard(itemStates);
  const factsTable = buildFactsTable(capturedFields);
  const transcript = transcriptLines.filter((line) => typeof line === 'string' && line.length > 0).join('\n');

  // `usageAccumulator` is optional and forwarded into the LLM call
  // path so the post-call debrief contributes to the per-session
  // cost record. Null-safe — a missing accumulator is silently
  // ignored (older test harnesses that call generateSummary without
  // wiring the accumulator still work).
  const debrief = await generateDebrief({ provider, transcript, scorecard, factsTable, usageAccumulator });

  const structured = { scorecard, factsTable, transcript, debrief, durationMs };
  const asJSON = JSON.stringify(structured, null, 2);
  const asMarkdown = buildMarkdown({ scorecard, factsTable, transcript, debrief, durationMs });

  return { ...structured, asJSON, asMarkdown };
}

/* ────────────────────────────────────────────────────────────────────────
 * Scorecard
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Accept Map<itemId, state> or plain object — main.js may serialise
 * either depending on the IPC path. Normalise to a plain lookup.
 */
function normaliseItemStates(itemStates) {
  if (!itemStates) return {};
  if (itemStates instanceof Map) return Object.fromEntries(itemStates);
  if (typeof itemStates === 'object') return itemStates;
  return {};
}

function buildScorecard(itemStateLookup) {
  /** @type {Record<string, { name: string, total: number, covered: number, inProgress: number, logged: number, percent: number }>} */
  const out = {};

  for (const pillar of PILLARS) {
    // Synthetic pillars (live_signals, logged_questions) are derived
    // views over flags / cross-pillar state. They don't own real items
    // to score so they're excluded from the scorecard.
    if (pillar.synthetic) continue;

    const items = ITEMS_BY_PILLAR[pillar.id] || [];
    let covered = 0;
    let inProgress = 0;
    let logged = 0;

    for (const item of items) {
      const entry = itemStateLookup[item.id];
      const state = entry && typeof entry === 'object' ? entry.state : null;
      if (state === 'covered') covered++;
      else if (state === 'in_progress') inProgress++;
      else if (state === 'logged') logged++;
    }

    const total = items.length;
    const percent = total === 0 ? 0 : Math.round((covered / total) * 100);

    out[pillar.id] = {
      name: pillar.name,
      total,
      covered,
      inProgress,
      logged,
      percent,
    };
  }

  return out;
}

/* ────────────────────────────────────────────────────────────────────────
 * Facts table
 * ──────────────────────────────────────────────────────────────────────── */

function buildFactsTable(capturedFields) {
  /** @type {Record<string, { name: string, fields: Array<{ id: string, label: string, value: string }> }>} */
  const out = {};

  // Seed groups in their canonical display order from the rubric.
  for (const groupName of FIELD_GROUPS) {
    out[groupName] = { name: groupName, fields: [] };
  }

  // Fields are namespaced as `<group>.<localId>` and rubric.js owns the
  // canonical group/label mapping. Iterate the rubric (not the input)
  // so we keep declaration order and skip unknown ids.
  for (const def of CAPTURED_FIELDS) {
    const entry = capturedFields[def.id];
    const value = entry && typeof entry === 'object' ? entry.value : null;
    if (!value) continue;
    const bucket = out[def.group];
    if (!bucket) continue;
    bucket.fields.push({ id: def.id, label: def.label, value: String(value) });
  }

  // Drop empty groups so consumers don't render empty sections.
  for (const groupName of Object.keys(out)) {
    if (out[groupName].fields.length === 0) delete out[groupName];
  }

  return out;
}

/* ────────────────────────────────────────────────────────────────────────
 * AI debrief
 * ──────────────────────────────────────────────────────────────────────── */

async function generateDebrief({ provider, transcript, scorecard, factsTable, usageAccumulator }) {
  const empty = { wentWell: '', missed: '', improvements: ['', '', ''] };

  if (!provider || typeof provider.generateContent !== 'function') {
    return { ...empty, wentWell: '(Debrief unavailable: no provider configured.)' };
  }
  if (!transcript || transcript.length < 50) {
    return { ...empty, wentWell: '(Call too short to generate a debrief.)' };
  }

  try {
    const scoreLines = Object.values(scorecard)
      .map((p) => `  - ${p.name}: ${p.covered}/${p.total} covered · ${p.inProgress} in-progress · ${p.logged} logged (${p.percent}%)`)
      .join('\n') || '  (no scorecard)';

    const factLines = Object.values(factsTable)
      .flatMap((g) => g.fields.map((f) => `  - ${g.name} · ${f.label}: ${f.value}`))
      .join('\n') || '  (no facts captured)';

    const userText = [
      'SCORECARD (per-pillar coverage):',
      scoreLines,
      '',
      'CAPTURED FACTS:',
      factLines,
      '',
      'TRANSCRIPT (speaker labels preserved):',
      transcript,
    ].join('\n');

    const result = await provider.generateContent({
      systemInstruction: DEBRIEF_SYSTEM_INSTRUCTION,
      userMessage: userText,
      // Gemini-specific structured-output flags. The provider
      // abstraction passes these through transparently; non-Gemini
      // providers ignore them (which is fine because summary is
      // pinned to Gemini for now).
      responseMimeType: 'application/json',
      responseSchema: DEBRIEF_SCHEMA,
    });

    // Forward token usage into the per-session accumulator (cost-
    // tracking feature). Null-safe in both directions per invariant #2.
    usageAccumulator?.recordLlmCall('summary', result?.usage);

    const raw = typeof result?.text === 'string' ? result.text : '';
    if (!raw) return { ...empty, wentWell: '(Debrief unavailable: empty response.)' };

    const parsed = JSON.parse(raw);
    return normaliseDebrief(parsed);
  } catch (err) {
    const message = err?.message || 'unknown error';
    console.warn('[summary] debrief generation failed:', message);
    return { ...empty, wentWell: `(Debrief unavailable: ${message}.)` };
  }
}

function normaliseDebrief(parsed) {
  const wentWell = typeof parsed?.wentWell === 'string' ? parsed.wentWell.trim() : '';
  const missed = typeof parsed?.missed === 'string' ? parsed.missed.trim() : '';
  const improvementsRaw = Array.isArray(parsed?.improvements) ? parsed.improvements : [];
  const improvements = improvementsRaw
    .map((s) => (typeof s === 'string' ? s.trim() : ''))
    .filter(Boolean)
    .slice(0, 3);
  while (improvements.length < 3) improvements.push('');
  return { wentWell, missed, improvements };
}

/* ────────────────────────────────────────────────────────────────────────
 * Markdown serialisation
 * ──────────────────────────────────────────────────────────────────────── */

function buildMarkdown({ scorecard, factsTable, transcript, debrief, durationMs }) {
  const lines = [];
  lines.push('# Discovery Call Summary');
  if (durationMs > 0) {
    lines.push('');
    lines.push(`_Duration: ${formatDuration(durationMs)}_`);
  }
  lines.push('');

  // Scorecard ----------------------------------------------------------
  lines.push('## Scorecard');
  lines.push('');
  const scorecardRows = Object.values(scorecard);
  if (scorecardRows.length === 0) {
    lines.push('_No scorecard available._');
  } else {
    lines.push('| Pillar | Covered | In progress | Logged | Total | % |');
    lines.push('| --- | ---: | ---: | ---: | ---: | ---: |');
    for (const p of scorecardRows) {
      lines.push(`| ${p.name} | ${p.covered} | ${p.inProgress} | ${p.logged} | ${p.total} | ${p.percent}% |`);
    }
  }
  lines.push('');

  // Captured facts -----------------------------------------------------
  lines.push('## Captured Facts');
  lines.push('');
  const groupNames = Object.keys(factsTable);
  if (groupNames.length === 0) {
    lines.push('_No facts captured._');
    lines.push('');
  } else {
    for (const groupName of groupNames) {
      const group = factsTable[groupName];
      lines.push(`### ${group.name}`);
      lines.push('');
      for (const f of group.fields) {
        lines.push(`- **${f.label}:** ${f.value}`);
      }
      lines.push('');
    }
  }

  // Transcript ---------------------------------------------------------
  lines.push('## Transcript');
  lines.push('');
  if (transcript) {
    // Code-fence so speaker prefixes ("You:", "Prospect:") don't get
    // misinterpreted as Markdown headings/lists, and so line breaks
    // are preserved without trailing-space tricks.
    lines.push('```');
    lines.push(transcript);
    lines.push('```');
  } else {
    lines.push('_No transcript captured._');
  }
  lines.push('');

  // AI debrief ---------------------------------------------------------
  lines.push('## AI Debrief');
  lines.push('');
  lines.push('### What went well');
  lines.push('');
  lines.push(debrief.wentWell || '_(not generated)_');
  lines.push('');
  lines.push('### What was missed');
  lines.push('');
  lines.push(debrief.missed || '_(not generated)_');
  lines.push('');
  lines.push('### Top 3 improvements');
  lines.push('');
  const improvements = (debrief.improvements || []).filter(Boolean);
  if (improvements.length === 0) {
    lines.push('_(not generated)_');
  } else {
    for (const imp of improvements) lines.push(`- ${imp}`);
  }
  lines.push('');

  return lines.join('\n');
}

function formatDuration(ms) {
  if (typeof ms !== 'number' || ms <= 0) return '0:00';
  const totalSec = Math.round(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${String(sec).padStart(2, '0')}`;
}
