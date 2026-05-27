# Save-Plan Prompt — paste into each chat thread that has a plan ready

> **Purpose:** Get the in-thread implementation plan captured as a standalone markdown file in `docs/superpowers/plans/` so the coordinator (a separate chat thread) can run overlap triage across all ~10 plans before any of them launch.
>
> **Run this in every chat thread that has a plan ready.** One thread at a time is fine; the threads still in main workspace cannot conflict because each plan goes to a unique filename.
>
> **Do NOT run this in a worktree** — plans live on `main`. Worktrees come *after* triage.

---

## The prompt to paste

```text
You and I have been designing an implementation plan in this conversation. I now need that plan captured as a standalone markdown file so a coordinator (separate chat thread) can run overlap triage across ~10 parallel plans before launching any of them.

### Your task

Write a self-contained implementation plan to:

  docs/superpowers/plans/2026-05-27-<short-kebab-topic>.md

Before you write, run `ls docs/superpowers/plans/` to see what already exists and pick a UNIQUE kebab-case topic that clearly identifies this feature (e.g. summary-redesign, provider-fallback, tray-context-menu). If a file with your slug already exists at today's date, pick a more specific slug.

### Required structure

Mirror the structure of the existing reference plan:
  docs/superpowers/plans/2026-05-18-liquid-glass-overlay-polish.md

Your plan MUST include these sections, in order:

  1. Title + one-line goal
  2. **Goal** — 1–3 sentences on what shipping this achieves
  3. **Architecture** — 2–4 sentences on the technical shape
  4. **Tech Stack** — one line; call out any new dependencies
  5. **Spec** — link a spec doc if one exists at docs/superpowers/specs/, otherwise write "n/a — plan is self-contained"
  6. **Pre-flight** — quick checks before starting (clean tree, env vars, etc.)
  7. **File map** — CRITICAL. Three sub-headings: NEW (created), MODIFIED (edited), DELETED (removed). Use exact repo-relative paths. The coordinator uses this to detect overlap with other parallel plans, so be thorough — every file you'd touch, even briefly, must be listed.
  8. **Public / shared interface impact** — list every function signature, IPC channel, event name, persisted schema, or broadly-used CSS class this plan will change. If none, write "None — purely internal to the files listed above."
  9. **Potential overlaps with other in-flight plans** — based on what you remember from our discussion or general knowledge of the codebase, name any modules or behaviours where another parallel plan is likely to also be working. If you don't know, write "Coordinator should check."
  10. **Architecture invariants** — rules that must hold across all tasks
  11. **Task 1, Task 2, …** — each task with: Goal, Files affected, and `- [ ]` checkbox steps

### Hard constraints

- Do NOT start implementing anything. This is plan-capture ONLY.
- Do NOT modify any source files. The only file you create is your plan doc.
- Do NOT touch ~/.cursor/parallel-coordination/2-Way-Flow/ACTIVE.md — that's for *after* worktrees are created.
- Do NOT modify any other plan in docs/superpowers/plans/.

### When done

1. Commit only your plan doc to main:

     git add docs/superpowers/plans/2026-05-27-<topic>.md
     git commit -m "docs: add plan for <topic>"

2. Report back to me:
   - The exact filename you committed
   - One sentence summarising the feature
   - The MODIFIED list from your File map (comma-separated paths)

Then stop. Do not proceed to implementation in this thread.
```

---

## Fill-in checklist (none required — the prompt is fully self-contained)

The agent picks its own slug and writes the plan from in-thread context. You don't need to substitute anything before pasting.

---

## What to expect back from each thread

Each thread should respond with something like:

```
Saved: docs/superpowers/plans/2026-05-27-summary-redesign.md
Summary: Replace ad-hoc summary generation with structured per-turn synthesis and inline copy controls.
Modified files: src/summary.js, src/renderer.js, src/index.css, src/main.js
```

Collect those three pieces from all ~10 threads (or just let them land as commits — the triage step reads the plans directly).

---

## After all plans are saved

Come back to the coordinator chat and say **"all plans saved, run the triage"**.

The coordinator will:
1. Read every new file in `docs/superpowers/plans/`.
2. Build a file-overlap matrix.
3. Group the plans into:
   - **Parallel clusters** (no shared files — launch concurrently)
   - **Sequential chains** (shared files — must merge in dependency order)
4. Propose a launch order and recommended worktree slugs.
5. Wait for your approval before creating any worktrees.
