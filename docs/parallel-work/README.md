# Parallel Work — Workflow

This repo runs multiple feature branches in parallel using **git worktrees + a shared coordination log**, so several Cursor chat threads can implement different plans concurrently without stomping on each other.

If you're an AI agent starting work in this repo, **read this file first**, then read the coordination log.

---

## Locations at a glance

| Thing | Path |
|---|---|
| Repo root (main workspace) | `/Users/taylor/OLC CRM/2-Way-Flow` |
| Worktree parent dir (git-ignored) | `.worktrees/` |
| Plan docs | `docs/superpowers/plans/` |
| Spec docs | `docs/superpowers/specs/` |
| **Live coordination log (outside repo)** | `~/.cursor/parallel-coordination/2-Way-Flow/ACTIVE.md` |
| Kickoff prompt template (for spawning new threads) | `docs/parallel-work/KICKOFF-PROMPT.md` |

> The coordination log lives **outside the repo on purpose** so every worktree reads/writes the same file in real time, without needing a git sync.

---

## The model (mental picture)

```
                       main (shared baseline)
                        │
        ┌────────┬──────┼──────┬────────┐
        │        │      │      │        │
    feature/A  feature/B  feature/C  feature/D  ...
        │        │      │      │        │
   .worktrees/A   ...   ...   ...    .worktrees/D
        │        │      │      │        │
   Cursor       Cursor  Cursor Cursor  Cursor
   window A     window B ...           window D

All threads read/write the same:
   ~/.cursor/parallel-coordination/2-Way-Flow/ACTIVE.md
```

Each feature branch:
1. Forks from `main`.
2. Lives in its own `.worktrees/<slug>` directory.
3. Has its own Cursor window with its own chat thread.
4. Writes to its own files only — never the other worktrees.
5. Coordinates intent via `ACTIVE.md` (outside the repo).

---

## Standard procedure — starting a new parallel branch

1. **Pick a short slug** for the branch (e.g. `summary-redesign`, `provider-fallback`, `tray-context-menu`).
2. **From the main workspace** (this directory), run:
   ```bash
   git worktree add .worktrees/<slug> -b feature/<slug>
   cd .worktrees/<slug> && npm install
   ```
3. **Open the worktree as a Cursor workspace:**
   - File → Open Folder → select `.worktrees/<slug>`
4. **In the new Cursor window, start a chat** and paste the contents of `docs/parallel-work/KICKOFF-PROMPT.md`, filling in the `<...>` placeholders.
5. **The kickoff prompt instructs the agent to register itself in `ACTIVE.md` before doing anything.** Verify it did, then let it run.

---

## Standard procedure — finishing a parallel branch

When a parallel branch is done and ready to merge:

1. **In the worktree:** commit and push if remote-tracked.
2. **In the main workspace:**
   ```bash
   git checkout main
   git merge feature/<slug>            # or open a PR if you prefer review
   ```
3. **Resolve conflicts** using the agents' notes in `ACTIVE.md` as context — they should have flagged anything that touches shared interfaces.
4. **Move the entry** in `ACTIVE.md` from "Active branches" to "Completed branches" with status `done` and the merge date.
5. **Clean up the worktree:**
   ```bash
   git worktree remove .worktrees/<slug>
   ```

---

## Merge order — when plans overlap

If two branches touched the same file:

- **Merge the foundational one first** (the one that changes the shared interface, e.g. provider abstraction).
- **Merge dependents second** and resolve textual conflicts.
- If both made *behavioural* changes that conflict (not just textual), the second branch needs a re-plan; the agent that did it should review the merged baseline and adapt.

When in doubt: dependency direction (provider/utility layer < feature layer < UI layer).

---

## Coordination log — what to write, when

See `~/.cursor/parallel-coordination/2-Way-Flow/ACTIVE.md` for the entry template.

**Write to the log:**
- Once at start (register your branch, claim your rough file scope).
- Whenever you change a *shared interface* (function signature, IPC channel, persisted schema, broadly-used CSS class).
- Once at finish (mark `done`, list final public changes, move to "Completed").

**Don't write to the log for:**
- Internal refactors no other plan would notice.
- Comment-only edits.
- Test-only edits inside files no one else is touching.

---

## Conflict avoidance heuristics

These files in the current architecture are **hot spots** — multiple plans are likely to touch them. Watch the log carefully if your plan involves:

- `src/main.js` — Electron main process, central wiring
- `src/renderer.js` — central UI controller
- `src/preload.js` — IPC bridge contract
- `src/index.css` — global styles
- `src/coach.js` — coaching pipeline
- `src/providers/index.js` — provider router
- `index.html` — DOM structure

If your plan must edit one of these and another branch has it listed too, ping the user before pushing through — sequencing one ahead of the other is almost always cheaper than a 3-way merge later.

---

## Troubleshooting

- **"My agent didn't write to ACTIVE.md"** — the kickoff prompt requires it. If skipped, ask the agent to register itself before continuing.
- **"Two worktrees both think they own `src/coach.js`"** — pick a winner; the loser pauses (Status: `blocked`) until the winner merges, then rebases.
- **"npm install fails in a worktree"** — each worktree gets its own `node_modules`. If the install fails, copy `node_modules` from the main workspace as a starting point, then `npm install` again.
- **"I want to delete an experimental worktree"** — `git worktree remove .worktrees/<slug>` then `git branch -D feature/<slug>`.
