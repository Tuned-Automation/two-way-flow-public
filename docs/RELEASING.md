# Releasing Two Way Flow

How to cut a public release that users can download and auto-update to.

## Repos

- **Source (private):** `Tuned-Automation/two-way-flow` — this repo.
- **Releases (public):** `Tuned-Automation/two-way-flow-releases` — holds the
  downloadable builds (GitHub Releases) and `updates.json` (the in-app
  update feed). No source code lives there.

## One-time setup

- `gh auth status` must show you logged in with `repo` scope.
- Builds are **unsigned** (no Apple Developer ID). That means:
  - Recipients hit Gatekeeper on first open (the releases README walks
    them through it).
  - There is **no silent auto-update** — the in-app updater downloads the
    new DMG and the user drags it into Applications. This is expected.

## Cut a release

```bash
npm run release -- <version> "Release notes here"
# e.g.
npm run release -- 1.4.6 "Adds the rubric walkthrough helper and a wider Settings layout."
```

This (`scripts/release.sh`):
1. Sets `package.json` to `<version>`.
2. Builds a **clean** DMG + zip (no API keys — `TWF_BUNDLE_ENV` is not set,
   so `forge.config.js` omits the bundled `.env`).
3. Computes each artifact's SHA-256.
4. Creates a published GitHub Release on the releases repo with the assets.
5. Writes `updates.json` (version, notes, asset URLs + sha256, minSupported)
   to the releases repo's `main` branch — the feed `src/updater.js` reads.

Afterwards, commit the version bump in this source repo:

```bash
git add package.json && git commit -m "chore: bump version to <version>" && git push
```

## Forcing an update

If you must retire older builds (a broken or insecure version), bump
`MIN_SUPPORTED` near the top of `scripts/release.sh` before releasing.
Any installed app below that version shows a non-dismissible
force-update screen on next launch/check.

## How the in-app updater works

- `src/updater.js` (main process) fetches
  `https://raw.githubusercontent.com/Tuned-Automation/two-way-flow-releases/main/updates.json`,
  compares semver to `app.getVersion()`, and reports `updateAvailable` /
  `mustUpdate`.
- Download streams the DMG to `~/Downloads`, verifies SHA-256 against the
  manifest (mismatch aborts), then reveals it in Finder.
- UI lives in **Settings → General → Updates**; the force-update gate is
  `#forceUpdateOverlay`.

## Local personal install (NOT distribution)

`npm run install:local` builds with `TWF_BUNDLE_ENV=1`, so it bundles your
own `.env` keys for your personal machine only. Never distribute that build.

## Upgrading to signed builds later (recommended)

Getting an Apple Developer ID (~$99/yr) removes the Gatekeeper friction and
enables true silent auto-update. It's additive: set `osxSign` +
notarization in `forge.config.js` and switch the updater to
`update-electron-app`/Squirrel. The current structure anticipates this.
