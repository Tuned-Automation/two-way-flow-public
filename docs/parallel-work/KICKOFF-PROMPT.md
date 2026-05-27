# Kickoff Prompt Template — Parallel Feature Branch

> **How to use this file:**
> 1. From the main workspace, create a worktree + branch: `git worktree add .worktrees/<slug> -b feature/<slug>` and `cd .worktrees/<slug> && npm install`.
> 2. Open `.worktrees/<slug>` as a new Cursor workspace (File → Open Folder).
> 3. In that new window, start a fresh chat.
> 4. Copy the prompt below, fill in the `<...>` placeholders, and paste it.

---

## The prompt to paste

```text
You are working on a parallel feature branch in this repo. There are other AI agents working concurrently on other branches in other worktrees. You MUST coordinate through the shared coordination log before you do anything.

### Your assignment

- **Branch:** feature/<slug>
- **Worktree (your workspace root):** /Users/taylor/OLC CRM/2-Way-Flow/.worktrees/<slug>
- **Plan doc:** docs/superpowers/plans/<plan-filename>.md
- **Baseline commit:** <commit-sha-from-main-after-setup>

### Required first actions (do these BEFORE editing any code)

1. Read /Users/taylor/.cursor/parallel-coordination/2-Way-Flow/ACTIVE.md in full. Note every other branch currently listed under "Active branches" — especially any that list files you also plan to touch.
2. Read docs/parallel-work/README.md for the full workflow.
3. Read your plan doc at docs/superpowers/plans/<plan-filename>.md.
4. Append a new entry to the "Active branches" section of ACTIVE.md using the template at the bottom of that file. Use Status: starting. Fill in your rough file scope based on the plan.
5. If your plan overlaps with another active branch on a hot file, STOP and report it to the user before continuing. Do not push through.

### While you work

- Update YOUR entry in ACTIVE.md whenever you change a SHARED INTERFACE that another branch could depend on (function signatures in shared modules, IPC channels, persisted schemas, broadly-used CSS classes). Internal-only changes do not need a log update.
- Commit your work to feature/<slug> only. Never touch main directly.
- If you discover your plan requires a change to a file another branch has claimed, set your Status to blocked, name the blocking branch in your Notes, and stop.

### When you finish

1. Run npm run build (or the project's build/test command) inside your worktree to verify the branch is green.
2. Mark your ACTIVE.md entry Status: review and list the final public/shared interface changes you made.
3. Tell the user the branch is ready to merge.

### Hard constraints

- Stay inside your worktree. Never edit files in /Users/taylor/OLC CRM/2-Way-Flow/ directly (only the .worktrees/<slug>/ copy of files).
- Never edit another worktree.
- Never modify ACTIVE.md sections outside your own entry.
- Never merge or rebase to main yourself. The user controls integration.

Confirm you've read ACTIVE.md, the workflow README, and your plan doc, and show me your registered entry before you begin implementation.
```

---

## Quick fill-in checklist

When you paste the prompt, replace:

- `<slug>` — short kebab-case branch name (e.g. `summary-redesign`)
- `<plan-filename>` — the filename inside `docs/superpowers/plans/` (without leading path)
- `<commit-sha-from-main-after-setup>` — the commit on `main` that the branch was forked from (run `git log -1 --format='%h' main` from the main workspace)

---

## Why this prompt is shaped the way it is

- **Front-loads coordination.** Reading `ACTIVE.md` *before* code is the only way the parallel model works.
- **Names the workspace root explicitly.** Agents otherwise sometimes use absolute paths into the wrong worktree.
- **Distinguishes shared vs. internal changes.** Logging *everything* drowns signal; logging *only shared* changes keeps the log skimmable.
- **No autonomous merging.** Integration is a human decision so we don't get drift or unintended overwrites.
