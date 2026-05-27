#!/usr/bin/env bash
#
# scripts/install-local.sh
# ------------------------------------------------------------------
# One-shot "build, reset TCC, replace, refresh" workflow for the
# macOS .app bundle.
#
# WHY THIS EXISTS
#   `npm run package` (electron-forge) drops a fresh `Two Way Flow
#   <version>.app` into `out/Two Way Flow <version>-darwin-arm64/`,
#   but it never touches the `/Applications/` copy that Launchpad
#   and Spotlight actually surface to the user. So if you build,
#   then click the Launchpad icon to test, you end up running
#   yesterday's bundle and chasing ghost bugs that were already
#   fixed three commits ago.
#
#   Worse, macOS's LaunchServices database caches every `.app` it
#   has ever seen by bundle ID -- even the stale ones sitting in
#   old `out/` checkouts, the Desktop, or wherever else past
#   `npm run package` invocations dumped them. Until that DB is
#   rebuilt, Launchpad will happily render two or three identical
#   "Two Way Flow" tiles, each pointing at a different stale
#   binary, and clicking one is a coin-flip for which version
#   actually launches.
#
#   And on top of THAT, the bundle is ad-hoc signed (see
#   forge.config.js for why), so every rebuild gets a brand-new
#   cdhash that macOS's TCC subsystem treats as a different app.
#   Without an explicit reset, you'd accumulate one ghost row per
#   build in System Settings -> Privacy & Security -> Screen
#   Recording, none of which are actually granted to the binary
#   you just installed.
#
# WHAT THIS DOES (in order)
#   1. Builds the latest bundle via `npm run package`.
#   2. Kills any running Two Way Flow processes so the next phase
#      can replace `/Applications/...` without macOS refusing to
#      overwrite mmap'd helper binaries.
#   3. Spotlight-greps every Two Way Flow bundle on disk by
#      `CFBundleIdentifier` (so we catch all versioned variants
#      AND the legacy un-versioned `Two Way Flow.app`).
#   4. Deletes all of them EXCEPT the freshly-built one inside this
#      repo's `out/`, which we still need as the source for the
#      copy.
#   5. Resets the relevant TCC buckets so the new bundle gets a
#      single clean prompt cycle instead of inheriting stale
#      grants from a different cdhash.
#   6. Copies the new bundle into `/Applications/`.
#   7. Forces LaunchServices to drop its cache and rescan from
#      scratch -- otherwise Launchpad keeps drawing tiles for the
#      .apps we just deleted.
#   8. Restarts the Dock so Launchpad actually reloads the new
#      tile list.
#
# VERSION IN THE BUNDLE NAME
#   We derive `APP_NAME="${productName} ${version}"` from
#   `package.json`, e.g. `Two Way Flow 1.1.1`. That value gets
#   baked into the .app filename AND into CFBundleName by
#   electron-packager (see forge.config.js for the matching
#   `packagerConfig.name`). System Settings displays CFBundleName
#   in the Privacy & Security row, so each install shows up as
#   "Two Way Flow <version>" -- making it obvious which row to
#   toggle when granting permissions.
#
# WHY `set -euo pipefail`
#   -e          : exit on first failing command. We do NOT want to
#                 silently install a half-built bundle if
#                 `npm run package` fails partway through.
#   -u          : treat unset variables as errors. Catches typos
#                 in REPO_ROOT / OLD_APPS / NEW_APP that would
#                 otherwise expand to empty strings and `rm -rf ""`
#                 our way into a bad day.
#   -o pipefail : a failing command anywhere in a pipeline fails
#                 the whole pipeline, so a broken `mdfind | head`
#                 doesn't silently look like success.
#
# USAGE
#   npm run install:local
#   # or, equivalently:
#   bash scripts/install-local.sh
#
# AFTER RUNNING
#   Fully quit any `npm start` dev-mode window before clicking the
#   new Launchpad icon. The dev instance and the packaged instance
#   share `userData`, and running both at once leads to "two app
#   icons in the menu bar, both half-broken" weirdness.
# ------------------------------------------------------------------

set -euo pipefail

# Resolve the repo root from this script's own location instead of
# trusting the caller's cwd. `npm run install:local` happens to cd
# into the repo before running us, but if someone bash-invokes this
# from a sibling directory the relative `out/` lookups would
# silently miss and we'd "succeed" while installing the wrong
# bundle (or no bundle at all).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Derive the versioned bundle name from package.json so the .app on
# disk encodes the build number. System Settings -> Privacy &
# Security displays CFBundleName in each row; electron-packager
# copies it from `packagerConfig.name` in forge.config.js, which
# itself is `${productName} ${version}` from package.json. By
# reading the same source here, we keep script + forge config in
# lockstep: bump `version` in package.json and EVERYTHING downstream
# picks up the new name automatically.
PRODUCT_NAME=$(node -p "require('$REPO_ROOT/package.json').productName")
VERSION=$(node -p "require('$REPO_ROOT/package.json').version")
APP_NAME="${PRODUCT_NAME} ${VERSION}"
APP_BUNDLE="${APP_NAME}.app"
INSTALL_DIR="/Applications"
INSTALLED_APP="${INSTALL_DIR}/${APP_BUNDLE}"
BUNDLE_ID="com.tunedautomation.twowayflow"
# `LEGACY_GLOB` is the wildcard sweep we use as a belt-and-braces
# in Phase 4 below. It catches both the un-versioned legacy bundle
# (`Two Way Flow.app`, from before this script started versioning
# names) and any previously-installed versioned bundle
# (`Two Way Flow 1.1.0.app`, etc.) regardless of whether Spotlight
# has indexed them.
LEGACY_GLOB="${PRODUCT_NAME}*"

echo "==> install-local: repo root = $REPO_ROOT"
echo "==> install-local: target bundle = $APP_BUNDLE"

# ----- Phase 1/8: build --------------------------------------------
# electron-forge's `package` target produces an
# unsigned-or-self-signed `${APP_BUNDLE}` under
# `out/${APP_NAME}-darwin-arm64/`. The `make` target wraps that in
# installer archives (.zip, .dmg, etc.) which we don't need for a
# local install -- `package` is faster and produces exactly the
# bundle we want to drop into /Applications.
echo "==> Phase 1/8: building bundle via 'npm run package'"
cd "$REPO_ROOT"
npm run package

# ----- Phase 2/8: terminate running instances ----------------------
# `cp -R` over a running .app on macOS will partially succeed
# (overwriting Resources/ and the asar) and then fail when it tries
# to replace the helper binaries that the live process has mmap'd.
# The half-overwritten bundle then crashes on next launch with
# obscure "code signature invalid" errors. Killing first is much
# cheaper than debugging that.
#
# `pkill -f` matches against the full command line, which catches
# both the main process and every "Two Way Flow Helper" variant
# (GPU, Renderer, Utility) regardless of the versioned product
# name suffix. `|| true` keeps the script alive when there is
# nothing to kill, which is the common case.
echo "==> Phase 2/8: terminating any running ${PRODUCT_NAME} processes"
pkill -f "${PRODUCT_NAME}" 2>/dev/null || true
sleep 2

# ----- Phase 3/8: discover every existing .app ---------------------
# `mdfind` against `CFBundleIdentifier` catches EVERY bundle that
# claims our bundle ID, regardless of its on-disk name. That's
# important now that bundles are versioned -- a query by name
# (`mdfind -name "Two Way Flow 1.1.1.app"`) would miss the old
# `Two Way Flow.app` from before versioning, or any
# `Two Way Flow 1.1.0.app` from a prior install, leaving them
# stranded in /Applications.
#
# If Spotlight has been disabled or the volume isn't indexed
# `mdfind` prints nothing; we fall back to "do nothing here" via
# `|| true` instead of aborting, because the more dangerous
# failure mode is to halt the install over an empty list. Phase 4
# has a belt-and-braces explicit sweep of `${INSTALL_DIR}` to cover
# the case where Spotlight missed an installed bundle.
echo "==> Phase 3/8: locating existing ${BUNDLE_ID} bundles on disk"
OLD_APPS=$(mdfind "kMDItemCFBundleIdentifier == '${BUNDLE_ID}'" 2>/dev/null || true)
if [ -n "$OLD_APPS" ]; then
  echo "    Spotlight reports the following bundles:"
  echo "$OLD_APPS" | sed 's/^/      /'
else
  echo "    Spotlight returned no results (index may be cold)."
fi

# ----- Phase 4/8: delete stale copies, keep our build source -------
# We must keep the freshly-built `out/.../${APP_BUNDLE}` because
# Phase 6 copies FROM it. Everything else -- including the previous
# `${INSTALL_DIR}/Two Way Flow*.app` -- needs to go so LaunchServices
# can't resurrect a duplicate Launchpad tile from it on the next
# rescan, AND so we don't end up with five "Two Way Flow X.Y.Z"
# rows in Privacy & Security from old installs.
#
# The `case` glob against `$REPO_ROOT/out/` is what tells us "this
# is our build artefact, don't touch it". Using a glob (rather than
# a string-prefix test) means the exact subdirectory name doesn't
# matter -- electron-forge versions its output dir by arch
# (`${APP_NAME}-darwin-arm64/`) and may change that scheme in
# future versions without breaking us.
echo "==> Phase 4/8: removing stale ${PRODUCT_NAME} bundles"
if [ -n "$OLD_APPS" ]; then
  while IFS= read -r app; do
    [ -z "$app" ] && continue
    case "$app" in
      "$REPO_ROOT/out/"*)
        echo "    keeping (build source): $app"
        ;;
      *)
        echo "    removing: $app"
        rm -rf "$app"
        ;;
    esac
  done <<< "$OLD_APPS"
fi

# Belt-and-braces: glob-sweep ALL ${PRODUCT_NAME}*.app bundles from
# ${INSTALL_DIR} in case Spotlight's index is cold. Catches both
# the legacy un-versioned bundle and any previous-version bundles
# that mdfind didn't surface. `nullglob` is needed because under
# `set -u` an unmatched glob expands to its literal pattern and
# the loop body would then try to rm a file that doesn't exist.
shopt -s nullglob
for f in "$INSTALL_DIR"/${LEGACY_GLOB}.app; do
  if [ -d "$f" ]; then
    echo "    removing (glob sweep): $f"
    rm -rf "$f"
  fi
done
shopt -u nullglob

# ----- Phase 5/8: reset stale TCC grants ---------------------------
# Ad-hoc signing makes every rebuild a new "app" to macOS's TCC
# subsystem -- the cdhash (a SHA-256 over the codesign hash table)
# IS the designated requirement that gates each permission row.
# So even though System Settings groups the visual entry by name
# + CFBundleIdentifier, the underlying grant binds to a specific
# cdhash. Replacing the bundle with a freshly-built one (different
# cdhash) makes TCC silently reject the existing grant and prompt
# again -- while leaving the stale row on display, so Settings
# ends up showing one ghost row per build over time.
#
# `tccutil reset <Service> <bundleID>` drops those rows so each
# install gets a single, clean prompt cycle. With versioned bundle
# names AND this reset, you get exactly one row per install,
# named to match the version.
#
# Buckets we touch:
#   Microphone     : the user's own side of the call (mic). Mostly
#                    auto-grants on launch via
#                    systemPreferences.askForMediaAccess() in
#                    src/main.js, but we reset anyway for hygiene.
#   ScreenCapture  : the prospect's side of the call (system audio
#                    loopback via getDisplayMedia in
#                    src/renderer.js -> tryOpenSystemAudioStream).
#                    This is the one that requires the user to
#                    click into System Settings and toggle ON.
#
# `2>/dev/null || true` because tccutil prints to stderr when the
# bundle isn't in the table yet (e.g. very first install ever),
# which is harmless and shouldn't abort us.
echo "==> Phase 5/8: resetting TCC permissions for ${BUNDLE_ID}"
tccutil reset Microphone "$BUNDLE_ID" 2>/dev/null \
  || echo "    (Microphone: no prior grant to reset)"
tccutil reset ScreenCapture "$BUNDLE_ID" 2>/dev/null \
  || echo "    (ScreenCapture: no prior grant to reset)"

# ----- Phase 6/8: locate and install the new bundle ----------------
# electron-forge nests the bundle one or two directories deep
# under `out/`, depending on platform and version (currently
# `out/${APP_NAME}-darwin-arm64/${APP_BUNDLE}`). `find -maxdepth
# 5` is generous enough for any reasonable forge layout while
# still bounding the walk -- we don't want this to wander into
# node_modules if the find target ever gets misconfigured.
#
# `head -1` picks the first match deterministically. In a clean
# repo there is only ever one match; if a multi-arch build ever
# leaves more than one, we install the first and you can re-run
# the script with a different arch selected later.
echo "==> Phase 6/8: locating freshly-built ${APP_BUNDLE} in out/"
NEW_APP=$(find "$REPO_ROOT/out" -maxdepth 5 -name "${APP_BUNDLE}" | head -1)
if [ -z "$NEW_APP" ] || [ ! -d "$NEW_APP" ]; then
  echo "ERROR: could not find a freshly-built ${APP_BUNDLE} under $REPO_ROOT/out" >&2
  echo "       Did 'npm run package' actually produce a bundle? Re-read the forge" >&2
  echo "       output above for the real failure." >&2
  exit 1
fi
echo "    source: $NEW_APP"
echo "    target: $INSTALLED_APP"
cp -R "$NEW_APP" "$INSTALL_DIR/"

# ----- Phase 7/8: rebuild LaunchServices ---------------------------
# LaunchServices keeps a per-user database of every `.app` bundle
# it has ever seen, keyed by bundle ID + version + path. Even
# after Phase 4 deletes the stale .apps from disk, Launchpad
# will keep drawing their tiles until we tell LaunchServices to
# drop the cache and rescan the filesystem from scratch.
#
# HISTORICAL NOTE
#   The classic "fix duplicate Launchpad icons" incantation was:
#       lsregister -kill -r -domain local -domain system -domain user
#   The `-kill` flag was removed on macOS 15+ (Sequoia / Tahoe) --
#   running it now prints "The -kill option has been removed
#   because it was dangerous and no longer useful." and exits
#   non-zero, which under `set -e` aborts this whole script.
#   Don't add `-kill` back.
#
# MODERN INVOCATION (what we actually do here)
#   -gc                  : garbage-collect database entries whose
#                          target bundles no longer exist on disk.
#                          This is the bit that removes "ghost"
#                          Launchpad tiles for the stale .apps we
#                          deleted in Phase 4.
#   -f "$INSTALLED_APP"  : force-register the freshly-installed
#                          bundle, even though its mtime would
#                          otherwise look identical to whatever
#                          LaunchServices already had cached.
#   -r -domain local ... : recursive scan of the standard domains
#                          as a belt-and-braces sweep, in case
#                          there's a stale .app somewhere we
#                          didn't catch in Phase 4.
#
# The `|| true` after each invocation is deliberate: a future
# macOS rev could deprecate one of these flags too, and we want
# the install to keep working (the .app is already in
# /Applications by this phase -- the worst case here is Launchpad
# takes an extra minute to refresh on its own).
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
echo "==> Phase 7/8: rebuilding LaunchServices database"
"$LSREGISTER" -gc 2>&1 || echo "    (lsregister -gc reported a warning; continuing)"
"$LSREGISTER" -f "$INSTALLED_APP" 2>&1 || echo "    (lsregister -f reported a warning; continuing)"
"$LSREGISTER" -r -domain local -domain system -domain user 2>&1 \
  || echo "    (lsregister -r reported a warning; continuing)"

# ----- Phase 8/8: restart Dock so Launchpad reloads ----------------
# Launchpad is a view inside the Dock process. The Dock caches the
# LaunchServices tile list in memory and won't notice the rebuild
# we just did until it relaunches. `killall Dock` is a hard restart
# -- launchd brings the Dock straight back up automatically. The
# `|| true` is just for rare minimal-shell sessions where Dock
# isn't running and we don't want that edge case to fail the
# whole install.
echo "==> Phase 8/8: restarting Dock to refresh Launchpad"
killall Dock 2>/dev/null || true

# ----- Confirmation ------------------------------------------------
# Read the version directly out of the installed bundle's
# Info.plist so the printed version is the same string macOS will
# show in "About Two Way Flow", not whatever happens to be in
# package.json at this moment. If those two ever disagree,
# something in the build pipeline is wrong and we want to surface
# it loudly here rather than discovering it three commits later.
INSTALLED_VERSION=$(defaults read "$INSTALLED_APP/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null || echo "unknown")
INSTALLED_NAME=$(defaults read "$INSTALLED_APP/Contents/Info.plist" CFBundleName 2>/dev/null || echo "unknown")

echo
echo "================================================================"
echo "  install-local: success"
echo "  installed at:                          $INSTALLED_APP"
echo "  version (CFBundleShortVersionString):  $INSTALLED_VERSION"
echo "  display name (CFBundleName):           $INSTALLED_NAME"
echo "================================================================"
echo
echo "GRANTING PERMISSIONS"
echo "  Open: System Settings -> Privacy & Security -> Screen Recording"
echo "        (on macOS 15+ this section may be labelled"
echo "         'Screen & System Audio Recording')"
echo "  Find the row labelled exactly:"
echo "        ${INSTALLED_NAME}"
echo "  Toggle it ON, then fully quit and relaunch the app -- Screen"
echo "  Recording grants do not apply to a process that was already"
echo "  running when you toggled the switch."
echo
echo "  Microphone permission will be requested at first launch and"
echo "  granted with a single click; no manual Settings trip needed."
echo
echo "Reminder: fully quit any 'npm start' dev window before clicking"
echo "the new Launchpad icon, otherwise you'll have two instances of"
echo "${PRODUCT_NAME} running side-by-side and they will fight over"
echo "menu-bar icon ownership."
