#!/usr/bin/env bash
#
# scripts/release.sh
# ------------------------------------------------------------------
# Cut a public release of Two Way Flow and update the in-app update feed.
#
# WHAT IT DOES
#   1. Optionally bumps package.json to a version you pass in.
#   2. Builds a CLEAN distribution bundle (DMG + zip). It deliberately
#      does NOT set TWF_BUNDLE_ENV, so the build contains NO API keys —
#      every user enters their own in Settings (see forge.config.js).
#   3. Stages the artifacts under space-free slug names, computes each
#      file's SHA-256, and uploads them to a GitHub Release on the
#      PUBLIC releases repo.
#   4. Writes updates.json (version, notes, assets[].sha256, minSupported)
#      to the releases repo's main branch — this is the feed the in-app
#      updater (src/updater.js) reads.
#
# USAGE
#   npm run release -- <version> ["release notes"]
#   # e.g. npm run release -- 1.4.6 "Adds the walkthrough helper."
#   # If <version> is omitted, the current package.json version is used.
#   # If notes are omitted, RELEASE_NOTES.md (if present) or a default
#   # message is used.
#
# REQUIREMENTS
#   - gh CLI authenticated with repo scope on the releases repo
#     (verify: gh auth status). NO token is ever embedded in the app.
#   - Run on the dev's mac (unsigned local build; no notarization).
#
# FORCING AN UPDATE
#   Bump MIN_SUPPORTED below to the lowest version users may keep
#   running. Anyone below it gets the non-dismissible force-update gate.
# ------------------------------------------------------------------

set -euo pipefail

# ── Config ──────────────────────────────────────────────────────────
RELEASES_REPO="Tuned-Automation/two-way-flow-releases"
# Lowest version allowed to keep running. Bump this only when you must
# retire older builds (it triggers the in-app force-update gate).
MIN_SUPPORTED="1.0.0"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

PRODUCT_NAME=$(node -p "require('$REPO_ROOT/package.json').productName")

# ── 1. Resolve / bump version ───────────────────────────────────────
ARG_VERSION="${1:-}"
if [ -n "$ARG_VERSION" ]; then
  node -e "const fs=require('fs');const p=require('$REPO_ROOT/package.json');p.version='$ARG_VERSION';fs.writeFileSync('$REPO_ROOT/package.json', JSON.stringify(p,null,2)+'\n');"
  echo "==> Set package.json version to $ARG_VERSION"
fi
VERSION=$(node -p "require('$REPO_ROOT/package.json').version")
TAG="v${VERSION}"
APP_NAME="${PRODUCT_NAME} ${VERSION}"

# Release notes: $2 wins, else RELEASE_NOTES.md, else a default.
NOTES="${2:-}"
if [ -z "$NOTES" ] && [ -f "$REPO_ROOT/RELEASE_NOTES.md" ]; then
  NOTES="$(cat "$REPO_ROOT/RELEASE_NOTES.md")"
fi
if [ -z "$NOTES" ]; then
  NOTES="Two Way Flow ${VERSION}."
fi

echo "==> Releasing ${APP_NAME}  (tag ${TAG})  ->  ${RELEASES_REPO}"

# ── 2. Clean build (NO bundled keys) ────────────────────────────────
echo "==> Building distribution bundle (DMG + zip, no API keys)"
npm run make

# ── 3. Locate + stage artifacts, compute SHA-256 ────────────────────
DMG_SRC=$(find "$REPO_ROOT/out/make" -maxdepth 4 -name "*.dmg" | head -1 || true)
ZIP_SRC=$(find "$REPO_ROOT/out/make" -maxdepth 5 -name "*.zip" | head -1 || true)
if [ -z "$DMG_SRC" ]; then
  echo "ERROR: no .dmg found under out/make — did 'npm run make' succeed?" >&2
  exit 1
fi

STAGE="$(mktemp -d)"
# Space-free slug names so GitHub asset download URLs are unambiguous.
DMG_NAME="Two-Way-Flow-${VERSION}.dmg"
cp "$DMG_SRC" "$STAGE/$DMG_NAME"
ASSETS=("$STAGE/$DMG_NAME")
ZIP_NAME=""
if [ -n "$ZIP_SRC" ]; then
  ZIP_NAME="Two-Way-Flow-${VERSION}-darwin-arm64.zip"
  cp "$ZIP_SRC" "$STAGE/$ZIP_NAME"
  ASSETS+=("$STAGE/$ZIP_NAME")
fi

DMG_SHA=$(shasum -a 256 "$STAGE/$DMG_NAME" | awk '{print $1}')
ZIP_SHA=""
if [ -n "$ZIP_NAME" ]; then
  ZIP_SHA=$(shasum -a 256 "$STAGE/$ZIP_NAME" | awk '{print $1}')
fi
echo "==> DMG sha256: $DMG_SHA"

# ── 4. Create the GitHub Release (published, so assets are downloadable)
echo "==> Creating GitHub release $TAG on $RELEASES_REPO"
gh release create "$TAG" "${ASSETS[@]}" \
  --repo "$RELEASES_REPO" \
  --title "$APP_NAME" \
  --notes "$NOTES"

BASE="https://github.com/${RELEASES_REPO}/releases/download/${TAG}"

# ── 5. Write updates.json to the releases repo main branch ──────────
echo "==> Updating updates.json feed"
FEED_DIR="$(mktemp -d)"
git clone --depth 1 "https://github.com/${RELEASES_REPO}.git" "$FEED_DIR" >/dev/null 2>&1

# Pass every value via the environment (never string-interpolated into
# the JS) so release notes with quotes / newlines can't corrupt the JSON.
DMG_NAME="$DMG_NAME" DMG_URL="$BASE/$DMG_NAME" DMG_SHA="$DMG_SHA" \
ZIP_NAME="$ZIP_NAME" ZIP_URL="$BASE/$ZIP_NAME" ZIP_SHA="$ZIP_SHA" \
FEED_VERSION="$VERSION" FEED_NOTES="$NOTES" FEED_MIN="$MIN_SUPPORTED" \
FEED_DIR="$FEED_DIR" node -e '
const fs = require("fs");
const e = process.env;
const assets = [
  { name: e.DMG_NAME, url: e.DMG_URL, sha256: e.DMG_SHA, kind: "dmg", arch: "arm64" },
];
if (e.ZIP_NAME) {
  assets.push({ name: e.ZIP_NAME, url: e.ZIP_URL, sha256: e.ZIP_SHA, kind: "zip", arch: "arm64" });
}
const manifest = {
  latest: { version: e.FEED_VERSION, notes: e.FEED_NOTES, assets },
  minSupported: e.FEED_MIN,
  updatedAt: new Date().toISOString(),
};
fs.writeFileSync(e.FEED_DIR + "/updates.json", JSON.stringify(manifest, null, 2) + "\n");
'

(
  cd "$FEED_DIR"
  git add updates.json
  git commit -m "release: ${VERSION}" >/dev/null
  git push origin HEAD:main
)

rm -rf "$STAGE" "$FEED_DIR"

echo
echo "================================================================"
echo "  Released ${APP_NAME}"
echo "  Release:    https://github.com/${RELEASES_REPO}/releases/tag/${TAG}"
echo "  Feed:       https://github.com/${RELEASES_REPO}/blob/main/updates.json"
echo "  Installed apps below v${MIN_SUPPORTED} will be force-updated."
echo "================================================================"
echo
echo "Tip: commit the package.json version bump in the SOURCE repo too:"
echo "  git add package.json && git commit -m 'chore: bump version to ${VERSION}'"
