const fs = require('node:fs');
const path = require('node:path');
const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');

// Versioned bundle name = `${productName} ${version}` from package.json.
// This is baked into the .app filename, CFBundleName (visible in
// System Settings → Privacy & Security), and the electron-packager
// output dir name (out/...-darwin-arm64/).
//
// Why version-in-name: ad-hoc signing makes every rebuild a new code
// identity (cdhash). TCC binds permission grants to the cdhash, but
// System Settings groups rows by name+bundleID for display only -- so
// the user can see "Two Way Flow" listed as granted but the freshly
// rebuilt binary is unknown to TCC and prompts from scratch. Embedding
// the version in the user-facing name lets the user identify WHICH
// build the Settings row is bound to; the matching `tccutil reset`
// phase in scripts/install-local.sh prevents stale rows from
// accumulating.
const pkg = require('./package.json');
const VERSIONED_APP_NAME = `${pkg.productName} ${pkg.version}`;

module.exports = {
  packagerConfig: {
    name: VERSIONED_APP_NAME,
    appBundleId: 'com.tunedautomation.twowayflow',
    asar: true,
    // electron-packager auto-appends the platform extension:
    //   macOS   -> assets/icon.icns
    //   Windows -> assets/icon.ico  (not yet produced; see assets/icon.svg)
    //   Linux   -> assets/icon.png
    // The .icns is generated from assets/icon.svg via the iconset workflow
    // described at the top of assets/icon.svg. To re-theme: edit icon.svg,
    // then re-run the rasterise + iconutil pipeline.
    icon: 'assets/icon',
    // macOS TCC (Transparency / Consent / Control) requires every app that
    // touches mic / camera / screen-recording to declare WHY in Info.plist.
    // Without the matching NS*UsageDescription key, macOS Sequoia silently
    // denies the request — the user never sees the OS-level "Allow?" prompt
    // and the renderer just gets `NotAllowedError`, surfacing as the
    // "Microphone blocked" toast in src/renderer.js -> startCapture().
    //
    // electron-packager injects generic placeholders by default ("This app
    // needs access to the microphone"), which is enough to unblock the
    // prompt but looks unprofessional. We override with honest, product-
    // specific wording. We also add NSScreenCaptureUsageDescription, which
    // electron-packager does NOT inject by default — the system-audio
    // loopback path (`getDisplayMedia` in src/renderer.js) needs it.
    extendInfo: {
      NSMicrophoneUsageDescription:
        'Two Way Flow needs your microphone to capture your side of the sales call for live AI coaching and transcription.',
      NSCameraUsageDescription:
        'Two Way Flow does not use the camera.',
      NSScreenCaptureUsageDescription:
        "Two Way Flow needs Screen Recording permission to capture the prospect's audio from the other side of the call (system audio loopback).",
    },
    // Bundle the project-root .env into the packaged app at
    // `Contents/Resources/.env` so src/main.js's loadPackagedEnv() can
    // find GEMINI_API_KEY / DEEPGRAM_API_KEY at runtime. In dev mode
    // (npm start) cwd-relative .env is loaded directly; in a .app the
    // cwd is `/` and the cwd lookup silently no-ops — without this
    // bundling, the packaged app boots with empty API keys and the
    // renderer shows "Missing Gemini API key".
    //
    // SECURITY: this embeds whatever secrets are in .env at build time
    // into the .app bundle. That's fine for personal-use installs on
    // the developer's own machine but DO NOT distribute the resulting
    // .app to other users without first stripping or replacing the
    // bundled keys. If/when we ship to others, the right answer is to
    // (a) leave .env out of the bundle, (b) require users to enter
    // keys via Settings → Providers (which writes to userData/
    // settings.json), and (c) for Deepgram, add a Settings UI slot.
    //
    // `existsSync` guards against a fresh checkout that doesn't have a
    // .env yet — without the guard, electron-packager throws and the
    // whole build fails. The empty fallback is just a missing-key
    // problem at runtime, which is recoverable via Settings.
    // Only bundle the developer's .env into the build when TWF_BUNDLE_ENV=1
    // is set (scripts/install-local.sh sets it for the dev's own local
    // install). Distribution builds (npm run publish / release) leave it
    // OFF, so the shipped app contains NO API keys — each end user enters
    // their own in Settings → Providers (Gemini / Deepgram / etc.). This
    // is the distribution-safety gate referenced in the security note above.
    extraResource: (process.env.TWF_BUNDLE_ENV === '1'
      && fs.existsSync(path.resolve(__dirname, '.env')))
      ? ['.env']
      : [],
    // NOTE on macOS signing: we *deliberately* don't set `osxSign` here.
    //
    // electron-forge JSON-serialises `packagerConfig` before forwarding it to
    // electron-packager, which silently strips function values from the
    // config. `@electron/osx-sign` v1.x requires the `optionsForFile`
    // *callback* to set per-file entitlements + hardened runtime — and since
    // that callback gets dropped during serialisation, the only field that
    // survives is `identity: '-'`. The default `identityValidation: true`
    // then rejects `-` (because `security find-identity -v` doesn't list
    // ad-hoc), signing is skipped under electron-packager's
    // `continueOnError: true`, and the resulting bundle is just a
    // *linker-signed* binary (no _CodeSignature dir, no entitlements,
    // identifier defaults to `com.github.Electron` / `Electron`). That
    // mismatch is what macOS Sequoia's TCC silently rejects, so the app
    // never appears in Privacy & Security.
    //
    // Workaround: do the signing ourselves in the `postPackage` hook below,
    // where the callback isn't serialised.
  },
  hooks: {
    /**
     * @electron-forge/plugin-vite's own packageAfterCopy hook wipes the
     * build directory and replaces it with just the Vite outputs +
     * package.json, so anything that isn't a Vite build artefact (e.g.
     * runtime assets in assets/) gets dropped from the asar.
     *
     * This hook runs AFTER the plugin's (Forge invokes plugin hooks
     * first, then top-level config.hooks) so we can re-add the small
     * set of runtime files that the main process actually loads from
     * disk. Right now that's just the tray-icon PNGs — src/main.js
     * resolves them via `path.join(app.getAppPath(), 'assets', '...')`,
     * which inside a packaged build maps to the asar root.
     *
     * NOTE: we intentionally do NOT copy icon.svg, icon.iconset/,
     * icon.icns or logo-source.png into the asar — they're build-time
     * sources, not runtime assets, and bloating the asar with them
     * would slow startup for no benefit.
     */
    packageAfterCopy: async (_forgeConfig, buildPath) => {
      const srcDir = path.resolve(__dirname, 'assets');
      const dstDir = path.join(buildPath, 'assets');
      fs.mkdirSync(dstDir, { recursive: true });
      for (const file of ['tray-icon.png', 'tray-icon@2x.png']) {
        const src = path.join(srcDir, file);
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, path.join(dstDir, file));
        }
      }
    },
    /**
     * Sign the macOS bundle ourselves, after electron-packager has
     * finished assembling it. See the long comment in `packagerConfig`
     * above for why we can't use `packagerConfig.osxSign` directly.
     *
     * We invoke @electron/osx-sign's programmatic API with the full
     * config — including the `optionsForFile` callback that would
     * otherwise be stripped by Forge's JSON serialisation — and we
     * disable identity validation so the `-` (ad-hoc) identity is
     * accepted without checking the user's keychain.
     *
     * Result: a properly sealed bundle whose code-signature identifier
     * matches CFBundleIdentifier (`com.tunedautomation.twowayflow`),
     * with mic / JIT / library-validation entitlements embedded.
     */
    postPackage: async (_forgeConfig, options) => {
      if (options.platform !== 'darwin') return;
      const { signAsync } = require('@electron/osx-sign');
      const entitlementsPath = path.resolve(
        __dirname,
        'build',
        'entitlements.mac.plist',
      );
      for (const outDir of options.outputPaths) {
        const appPath = path.join(outDir, `${VERSIONED_APP_NAME}.app`);
        if (!fs.existsSync(appPath)) continue;
        await signAsync({
          app: appPath,
          identity: '-',
          identityValidation: false,
          preAutoEntitlements: false,
          preEmbedProvisioningProfile: false,
          optionsForFile: () => ({
            entitlements: entitlementsPath,
            hardenedRuntime: true,
          }),
        });
      }
    },
    /**
     * Delete the unpackaged build artefact in `out/Two Way Flow-darwin-
     * arm64/` once the zip maker has finished writing
     * `out/make/zip/darwin/arm64/*.zip`. Without this cleanup, the
     * artefact .app sits at a path Spotlight/Launchpad happily indexes
     * AS A SEPARATE APP from the installed `/Applications/Two Way
     * Flow.app` — same codesign identity, same icon, but a duplicate
     * tile in Launchpad with no obvious way for the user to remove it.
     *
     * We deliberately delete only the platform-named directory (not
     * the whole `out/`) so `out/make/` (which contains the distributable
     * zip we actually want to keep) survives. To install locally after
     * a build, unzip the .zip from out/make/zip/.../*.zip into
     * /Applications, OR extract the same artefact path before the
     * hook ran — but the standard path is now zip-only.
     *
     * darwin-only because Linux/Windows makers don't leave a stray
     * .app behind in the same way.
     */
    postMake: async (_forgeConfig, makeResults) => {
      if (!Array.isArray(makeResults)) return;
      const isDarwin = makeResults.some((r) => r?.platform === 'darwin');
      if (!isDarwin) return;
      const stragglers = [
        path.resolve(__dirname, 'out', `${VERSIONED_APP_NAME}-darwin-arm64`),
        path.resolve(__dirname, 'out', `${VERSIONED_APP_NAME}-darwin-x64`),
      ];
      for (const dir of stragglers) {
        if (fs.existsSync(dir)) {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      }
    },
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {},
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin'],
    },
    {
      name: '@electron-forge/maker-deb',
      config: {},
    },
    {
      name: '@electron-forge/maker-rpm',
      config: {},
    },
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-vite',
      config: {
        // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
        // If you are familiar with Vite configuration, it will look really familiar.
        build: [
          {
            // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
            entry: 'src/main.js',
            config: 'vite.main.config.mjs',
            target: 'main',
          },
          {
            entry: 'src/preload.js',
            config: 'vite.preload.config.mjs',
            target: 'preload',
          },
        ],
        renderer: [
          {
            name: 'main_window',
            config: 'vite.renderer.config.mjs',
          },
          // Preview window — a second BrowserWindow that lives next to
          // the main overlay and mirrors the per-surface alpha CSS
          // variables driven by the Appearance tab's transparency
          // editor. plugin-vite injects PREVIEW_WINDOW_VITE_DEV_SERVER_URL
          // (dev / HMR) and PREVIEW_WINDOW_VITE_NAME (packaged build)
          // constants which src/main.js → createPreviewWindow() reads to
          // load preview.html in either environment.
          {
            name: 'preview_window',
            config: 'vite.preview.config.mjs',
          },
        ],
      },
    },
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};
