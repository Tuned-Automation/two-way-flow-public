#!/usr/bin/env bash
#
# install.sh — recipient remote installer for Two Way Flow (macOS).
#
# Run with:
#   curl -fsSL https://raw.githubusercontent.com/Tuned-Automation/two-way-flow-releases/main/install.sh | bash
#
# It reads the release manifest, downloads the latest .dmg, mounts it,
# copies the app into /Applications, and clears quarantine. Because the
# download happens over curl (not a browser), macOS never quarantines
# the file — so this path SKIPS the unsigned-app Gatekeeper warning that
# the manual DMG download triggers.
#
# (This is the recipient-facing remote installer. scripts/install-local.sh
#  is the DEVELOPER's local build+install with bundled keys — different
#  thing.)
# ------------------------------------------------------------------

# Note: deliberately NOT using `pipefail` — `curl | grep | head` would
# abort on the harmless SIGPIPE when head closes the pipe early.
set -eu

PRODUCT_NAME="Two Way Flow"
MANIFEST="https://raw.githubusercontent.com/Tuned-Automation/two-way-flow-releases/main/updates.json"

echo "==> Finding the latest ${PRODUCT_NAME} build…"
DMG_URL="$(curl -fsSL "$MANIFEST" | grep -oE 'https://[^"]+\.dmg' | head -1 || true)"
if [ -z "${DMG_URL:-}" ]; then
  echo "ERROR: couldn't find a .dmg in the release manifest." >&2
  echo "       (Is there a published release yet at the releases repo?)" >&2
  exit 1
fi
echo "    $DMG_URL"

TMP="$(mktemp -d)"
MNT="$TMP/mnt"
mkdir -p "$MNT"
cleanup() { hdiutil detach "$MNT" -quiet 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT

echo "==> Downloading…"
curl -fsSL -o "$TMP/twf.dmg" "$DMG_URL"

echo "==> Mounting…"
hdiutil attach "$TMP/twf.dmg" -nobrowse -quiet -mountpoint "$MNT"

# -print -quit avoids a SIGPIPE from `| head` under set -e.
APP_SRC="$(find "$MNT" -maxdepth 1 -name "*.app" -print -quit)"
if [ -z "${APP_SRC:-}" ]; then
  echo "ERROR: no .app found inside the DMG." >&2
  exit 1
fi
APP_BASE="$(basename "$APP_SRC")"

echo "==> Removing any older ${PRODUCT_NAME} installs…"
pkill -f "${PRODUCT_NAME}" 2>/dev/null || true
sleep 1
shopt -s nullglob
for old in "/Applications/${PRODUCT_NAME}"*.app; do
  rm -rf "$old"
done
shopt -u nullglob

echo "==> Installing ${APP_BASE} to /Applications…"
cp -R "$APP_SRC" "/Applications/"
# curl downloads aren't quarantined, but clear it defensively so the
# first launch can never hit Gatekeeper.
xattr -dr com.apple.quarantine "/Applications/${APP_BASE}" 2>/dev/null || true

echo
echo "================================================================"
echo "  Installed: /Applications/${APP_BASE}"
echo "================================================================"
echo "Next steps:"
echo "  1. Open ${PRODUCT_NAME} from Launchpad or Applications."
echo "  2. The setup wizard asks for your Gemini key (and optional"
echo "     Deepgram key) — paste them in."
echo "  3. Grant Microphone when prompted, and turn ON Screen Recording"
echo "     in System Settings → Privacy & Security, then reopen the app."
