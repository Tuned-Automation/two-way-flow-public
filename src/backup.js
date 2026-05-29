/**
 * Local userData backups (main process only).
 *
 * A safety net for a distributed app you can't reach: on launch we keep
 * a rolling set of timestamped snapshots of the user's irreplaceable
 * data — their rubrics and settings — under `<userData>/backups/`. If a
 * future migration bug, bad import, or disk hiccup ever corrupts the
 * live files, the user (or you, walking them through it) can restore a
 * recent snapshot.
 *
 * Properties:
 *   - Best-effort: any failure is logged and swallowed; it never blocks
 *     boot.
 *   - Throttled to at most once per BACKUP_INTERVAL_MS so launching the
 *     app repeatedly doesn't churn snapshots.
 *   - Pruned to the most recent KEEP snapshots.
 *
 * What's backed up: settings.json + the whole rubrics/ folder
 * (index.json + every <id>.json). Sessions/usage history is excluded —
 * it's regenerated data, not user-authored configuration.
 */

import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

const KEEP = 5;
const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // at most once/day

function listSnapshots(backupRoot) {
  if (!fs.existsSync(backupRoot)) return [];
  return fs.readdirSync(backupRoot)
    .filter((n) => {
      try { return fs.statSync(path.join(backupRoot, n)).isDirectory(); } catch { return false; }
    })
    .sort(); // ISO-ish timestamp names sort chronologically
}

/**
 * Snapshot rubrics + settings into <userData>/backups/<timestamp>/.
 * Skips if the most recent snapshot is younger than BACKUP_INTERVAL_MS.
 * Returns { ok, skipped?, dest? }.
 */
export function backupUserData() {
  try {
    const userData = app.getPath('userData');
    const backupRoot = path.join(userData, 'backups');

    // Throttle: skip if we already snapshotted recently.
    const existing = listSnapshots(backupRoot);
    const newest = existing[existing.length - 1];
    if (newest) {
      try {
        const ageMs = Date.now() - fs.statSync(path.join(backupRoot, newest)).mtimeMs;
        if (ageMs < BACKUP_INTERVAL_MS) {
          return { ok: true, skipped: 'recent' };
        }
      } catch { /* fall through and back up */ }
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(backupRoot, stamp);
    fs.mkdirSync(dest, { recursive: true });

    const settingsSrc = path.join(userData, 'settings.json');
    if (fs.existsSync(settingsSrc)) {
      fs.copyFileSync(settingsSrc, path.join(dest, 'settings.json'));
    }
    const rubricsSrc = path.join(userData, 'rubrics');
    if (fs.existsSync(rubricsSrc)) {
      fs.cpSync(rubricsSrc, path.join(dest, 'rubrics'), { recursive: true });
    }

    // Prune oldest beyond KEEP (count includes the one we just wrote).
    const all = listSnapshots(backupRoot);
    const excess = all.length - KEEP;
    for (let i = 0; i < excess; i++) {
      try {
        fs.rmSync(path.join(backupRoot, all[i]), { recursive: true, force: true });
      } catch { /* best effort */ }
    }

    return { ok: true, dest };
  } catch (err) {
    console.warn('[backup] userData backup failed:', err?.message || err);
    return { ok: false, reason: err?.message || 'backup_failed' };
  }
}
