#!/usr/bin/env bash
#
# scripts/uninstall.sh
# ------------------------------------------------------------------
# Completely remove Two Way Flow and ALL of its data from this Mac.
#
# Dragging the app to the Trash leaves data behind — your rubrics +
# settings (in Application Support), the macOS Microphone / Screen
# Recording permission rows, and assorted Chromium caches/prefs. This
# script removes all of it, in one go. It is the deliberate "wipe
# everything" path — the opposite of an update, which preserves your
# data on purpose.
#
# USAGE
#   bash scripts/uninstall.sh          # asks for confirmation first
#   bash scripts/uninstall.sh --yes    # skip the prompt (scripted use)
#
# This script is self-contained (no repo / Node required), so it can be
# shipped standalone in the public releases repo and run by recipients.
# ------------------------------------------------------------------

set -euo pipefail

PRODUCT_NAME="Two Way Flow"
BUNDLE_ID="com.tunedautomation.twowayflow"

ASSUME_YES="no"
if [ "${1:-}" = "--yes" ] || [ "${1:-}" = "-y" ]; then
  ASSUME_YES="yes"
fi

echo "This will PERMANENTLY remove ${PRODUCT_NAME} and all of its data:"
echo "  • the app in /Applications"
echo "  • your rubrics + settings (Application Support)"
echo "  • the Microphone + Screen Recording permission entries"
echo "  • caches / preferences / saved state"
echo
if [ "$ASSUME_YES" != "yes" ]; then
  printf "Continue? [y/N] "
  read -r REPLY < /dev/tty || REPLY="n"
  case "$REPLY" in
    y|Y|yes|YES) ;;
    *) echo "Aborted. Nothing was removed."; exit 0 ;;
  esac
fi

# Guard: never let an unset HOME turn a path into a root-relative rm.
if [ -z "${HOME:-}" ]; then
  echo "ERROR: \$HOME is not set; refusing to run." >&2
  exit 1
fi

# Helper: remove a path only if it's a non-empty, existing target.
remove_path() {
  local p="$1"
  if [ -n "$p" ] && [ -e "$p" ]; then
    echo "  removing: $p"
    rm -rf "$p"
  fi
}

echo "==> 1/6: quitting running ${PRODUCT_NAME} processes"
pkill -f "${PRODUCT_NAME}" 2>/dev/null || true
sleep 2

echo "==> 2/6: removing the app bundle(s) from /Applications"
# Glob covers the versioned bundle names (e.g. "Two Way Flow 1.5.0.app")
# and any legacy un-versioned bundle.
shopt -s nullglob
for app in "/Applications/${PRODUCT_NAME}"*.app; do
  remove_path "$app"
done
shopt -u nullglob

echo "==> 3/6: removing user data"
remove_path "$HOME/Library/Application Support/${PRODUCT_NAME}"

echo "==> 4/6: removing caches / preferences / saved state"
remove_path "$HOME/Library/Caches/${PRODUCT_NAME}"
remove_path "$HOME/Library/Caches/${BUNDLE_ID}"
remove_path "$HOME/Library/Preferences/${BUNDLE_ID}.plist"
remove_path "$HOME/Library/Saved Application State/${BUNDLE_ID}.savedState"
remove_path "$HOME/Library/WebKit/${BUNDLE_ID}"
shopt -s nullglob
for p in "$HOME/Library/HTTPStorages/${BUNDLE_ID}"*; do
  remove_path "$p"
done
shopt -u nullglob

echo "==> 5/6: resetting macOS permissions (Microphone + Screen Recording)"
tccutil reset Microphone "${BUNDLE_ID}" 2>/dev/null \
  || echo "    (Microphone: nothing to reset)"
tccutil reset ScreenCapture "${BUNDLE_ID}" 2>/dev/null \
  || echo "    (ScreenCapture: nothing to reset)"

echo "==> 6/6: refreshing Launchpad / LaunchServices"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
if [ -x "$LSREGISTER" ]; then
  "$LSREGISTER" -gc 2>/dev/null || true
fi
killall Dock 2>/dev/null || true

echo
echo "================================================================"
echo "  ${PRODUCT_NAME} has been fully removed."
echo "  (Any update DMGs you downloaded remain in your Downloads"
echo "   folder — delete those manually if you want.)"
echo "================================================================"
