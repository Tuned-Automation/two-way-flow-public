/**
 * In-app updater (main process only).
 *
 * Because distribution builds are UNSIGNED, we cannot use Squirrel.Mac /
 * Electron's autoUpdater (it refuses to apply updates to an unsigned
 * app). Instead this module implements a check -> notify -> in-app
 * download -> guided-install flow:
 *
 *   1. checkForUpdate()  — fetch updates.json from the PUBLIC releases
 *                          repo (no token, no GitHub API rate limit),
 *                          compare semver to the running version, and
 *                          report whether an update is available and
 *                          whether the running version is below
 *                          minSupported (force-update).
 *   2. downloadUpdate()  — stream the DMG to ~/Downloads with progress,
 *                          then verify its SHA-256 against the manifest.
 *                          A mismatch aborts (integrity guard — matters
 *                          precisely because the build is unsigned).
 *   3. revealDownload()  — show the verified DMG in Finder so the user
 *                          drags the new app to /Applications.
 *
 * RENDERER SAFETY: this module is main-process only (node:https / fs /
 * crypto + electron app/shell). Never import it from the renderer.
 *
 * Manifest shape (written by scripts/release.sh, committed to the
 * releases repo's main branch):
 *   {
 *     "latest": {
 *       "version": "1.4.6",
 *       "notes": "human-readable release notes",
 *       "assets": [
 *         { "name": "...dmg", "url": "https://.../x.dmg", "sha256": "<hex>", "kind": "dmg" }
 *       ]
 *     },
 *     "minSupported": "1.0.0"
 *   }
 */

import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { app, shell } from 'electron';

const execFileP = promisify(execFile);

/** App bundles in /Applications whose name starts with this are treated as
 *  prior installs of this product and cleaned up on a successful install. */
const PRODUCT_BUNDLE_PREFIX = 'Two Way Flow';

/** Raw URL of the manifest on the public releases repo's main branch.
 *  raw.githubusercontent.com serves the file directly with no auth and
 *  no API rate limit. If the releases repo is ever renamed, this is the
 *  ONE place to change. */
const MANIFEST_URL =
  'https://raw.githubusercontent.com/Tuned-Automation/two-way-flow-releases/main/updates.json';

/** GET a URL following redirects (GitHub release assets 302 to an S3
 *  object host), returning a Promise of the raw response stream. */
function httpsGet(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { 'User-Agent': 'TwoWayFlow-Updater', Accept: '*/*' } },
      (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) {
            reject(new Error('Too many redirects'));
            return;
          }
          const next = new URL(res.headers.location, url).toString();
          resolve(httpsGet(next, redirectsLeft - 1));
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          reject(new Error(`HTTP ${status} for ${url}`));
          return;
        }
        resolve(res);
      },
    );
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('Request timed out')));
  });
}

/** Read an entire URL into a string. */
async function fetchText(url) {
  const res = await httpsGet(url);
  return new Promise((resolve, reject) => {
    let data = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => resolve(data));
    res.on('error', reject);
  });
}

/** Parse "1.4.6" into [1,4,6]; tolerates a leading "v" and pre-release
 *  suffixes (which it strips for comparison). Returns [0,0,0] on junk. */
function parseSemver(v) {
  if (typeof v !== 'string') return [0, 0, 0];
  const core = v.trim().replace(/^v/i, '').split(/[-+]/)[0];
  const parts = core.split('.').map((n) => parseInt(n, 10));
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

/** -1 if a<b, 0 if equal, 1 if a>b (major.minor.patch). */
function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] < pb[i]) return -1;
    if (pa[i] > pb[i]) return 1;
  }
  return 0;
}

/** Pick the best downloadable asset for this platform (prefer .dmg). */
function pickAsset(assets) {
  if (!Array.isArray(assets)) return null;
  const dmg = assets.find((a) => a && /\.dmg$/i.test(a.name || a.url || ''));
  if (dmg) return dmg;
  const zip = assets.find((a) => a && /\.zip$/i.test(a.name || a.url || ''));
  return zip || assets[0] || null;
}

/**
 * Check the manifest. Resolves to a result object (never throws):
 *   { ok, currentVersion, latestVersion, updateAvailable, mustUpdate,
 *     notes, asset }  on success
 *   { ok: false, reason }                                  on failure
 */
export async function checkForUpdate() {
  const currentVersion = app.getVersion();
  try {
    const text = await fetchText(MANIFEST_URL);
    const manifest = JSON.parse(text);
    const latest = manifest?.latest || {};
    const latestVersion = typeof latest.version === 'string' ? latest.version : null;
    if (!latestVersion) {
      return { ok: false, reason: 'malformed_manifest', currentVersion };
    }
    const minSupported = typeof manifest.minSupported === 'string' ? manifest.minSupported : null;
    const updateAvailable = compareSemver(latestVersion, currentVersion) > 0;
    const mustUpdate = !!minSupported && compareSemver(currentVersion, minSupported) < 0;
    return {
      ok: true,
      currentVersion,
      latestVersion,
      updateAvailable,
      mustUpdate,
      notes: typeof latest.notes === 'string' ? latest.notes : '',
      asset: updateAvailable ? pickAsset(latest.assets) : null,
    };
  } catch (err) {
    return { ok: false, reason: err?.message || 'check_failed', currentVersion };
  }
}

/**
 * Download `asset` to ~/Downloads, reporting progress via onProgress
 * ({ receivedBytes, totalBytes, percent }), then verify SHA-256 against
 * the manifest. Resolves { ok: true, filePath } or { ok: false, reason }.
 * A hash mismatch deletes the partial file and fails — never opens an
 * unverified artifact.
 */
export async function downloadUpdate(asset, onProgress) {
  if (!asset || typeof asset.url !== 'string') {
    return { ok: false, reason: 'no_asset' };
  }
  const fileName = asset.name || path.basename(new URL(asset.url).pathname) || 'two-way-flow-update.dmg';
  const destDir = app.getPath('downloads');
  const filePath = path.join(destDir, fileName);
  try {
    const res = await httpsGet(asset.url);
    const totalBytes = parseInt(res.headers['content-length'] || '0', 10) || 0;
    const hash = crypto.createHash('sha256');
    let received = 0;
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(filePath);
      res.on('data', (chunk) => {
        received += chunk.length;
        hash.update(chunk);
        if (typeof onProgress === 'function') {
          onProgress({
            receivedBytes: received,
            totalBytes,
            percent: totalBytes ? Math.round((received / totalBytes) * 100) : 0,
          });
        }
      });
      res.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
      res.pipe(out);
    });

    const digest = hash.digest('hex');
    const expected = typeof asset.sha256 === 'string' ? asset.sha256.trim().toLowerCase() : '';
    if (expected && digest !== expected) {
      try { fs.unlinkSync(filePath); } catch { /* best effort */ }
      return { ok: false, reason: 'integrity_mismatch' };
    }
    return { ok: true, filePath, verified: !!expected };
  } catch (err) {
    try { fs.unlinkSync(filePath); } catch { /* best effort */ }
    return { ok: false, reason: err?.message || 'download_failed' };
  }
}

/** Reveal the downloaded file in Finder so the user can drag the new
 *  app to /Applications. Used as the fallback when auto-install can't run. */
export function revealDownload(filePath) {
  if (typeof filePath === 'string' && filePath) {
    try { shell.showItemInFolder(filePath); return { ok: true }; } catch (err) {
      return { ok: false, reason: err?.message || 'reveal_failed' };
    }
  }
  return { ok: false, reason: 'no_path' };
}

/**
 * Auto-install a downloaded .dmg into /Applications and report the bundle to
 * relaunch. Mirrors the proven routine in scripts/install.sh (mount → copy →
 * de-quarantine), but driven from inside the running app so the user gets a
 * true one-click update instead of a manual drag.
 *
 * SAFETY: the existing install is moved aside (not deleted) before the new
 * copy lands, and restored if anything fails — so a failed update never leaves
 * the user without a working app. Any failure (e.g. /Applications not
 * writable, or running on Windows/Linux) returns `{ ok:false, fallback:true }`
 * so the caller can fall back to revealDownload() + manual drag.
 *
 * Resolves { ok:true, installedAppPath, execPath } on success, or
 * { ok:false, fallback:true, reason } when the caller should fall back.
 */
export async function installUpdate(filePath) {
  if (process.platform !== 'darwin') {
    return { ok: false, fallback: true, reason: 'unsupported_platform' };
  }
  if (typeof filePath !== 'string' || !/\.dmg$/i.test(filePath)) {
    return { ok: false, fallback: true, reason: 'not_a_dmg' };
  }
  const appsDir = '/Applications';
  // Without write access we'd need admin — fall back to the guided drag.
  try {
    fs.accessSync(appsDir, fs.constants.W_OK);
  } catch {
    return { ok: false, fallback: true, reason: 'applications_not_writable' };
  }

  const mountPoint = fs.mkdtempSync(path.join(os.tmpdir(), 'twf-mnt-'));
  let mounted = false;
  let backupPath = null;
  let destApp = null;
  try {
    await execFileP('hdiutil', ['attach', filePath, '-nobrowse', '-noautoopen', '-mountpoint', mountPoint]);
    mounted = true;

    const appName = fs.readdirSync(mountPoint).find((n) => /\.app$/i.test(n));
    if (!appName) {
      return { ok: false, fallback: true, reason: 'no_app_in_dmg' };
    }
    const srcApp = path.join(mountPoint, appName);
    destApp = path.join(appsDir, appName);

    // Move any existing copy aside first — renaming a running .app bundle is
    // safe on macOS (the live process keeps running from the moved inode).
    if (fs.existsSync(destApp)) {
      backupPath = `${destApp}.old-${Date.now()}`;
      fs.renameSync(destApp, backupPath);
    }

    // ditto preserves symlinks / resource forks / code-sign metadata better
    // than a plain recursive copy.
    await execFileP('ditto', [srcApp, destApp]);

    // Strip the quarantine flag so the unsigned app reopens without Gatekeeper
    // blocking it ("unidentified developer"). Best-effort.
    try { await execFileP('xattr', ['-dr', 'com.apple.quarantine', destApp]); } catch { /* best effort */ }

    // Clean up other old-versioned bundles sharing the product name so the
    // user doesn't accumulate "Two Way Flow 1.5.0.app" etc.
    try {
      for (const n of fs.readdirSync(appsDir)) {
        const full = path.join(appsDir, n);
        if (/\.app$/i.test(n) && n.startsWith(PRODUCT_BUNDLE_PREFIX) && full !== destApp) {
          fs.rmSync(full, { recursive: true, force: true });
        }
      }
    } catch { /* best effort */ }

    // Success — discard the moved-aside previous version.
    if (backupPath) { try { fs.rmSync(backupPath, { recursive: true, force: true }); } catch { /* best effort */ } }

    // Resolve the launch binary inside the new bundle for the relaunch.
    let execPath = null;
    try {
      const macosDir = path.join(destApp, 'Contents', 'MacOS');
      const bin = fs.readdirSync(macosDir).find((n) => !n.startsWith('.'));
      if (bin) execPath = path.join(macosDir, bin);
    } catch { /* non-fatal — caller can relaunch via the .app path */ }

    return { ok: true, installedAppPath: destApp, execPath };
  } catch (err) {
    // Restore the previous version so the user is never left without an app.
    if (backupPath && destApp && !fs.existsSync(destApp)) {
      try { fs.renameSync(backupPath, destApp); } catch { /* best effort */ }
    }
    return { ok: false, fallback: true, reason: err?.message || 'install_failed' };
  } finally {
    if (mounted) {
      try { await execFileP('hdiutil', ['detach', mountPoint, '-quiet']); } catch { /* best effort */ }
    }
    try { fs.rmSync(mountPoint, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
