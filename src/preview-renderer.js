// Preview window renderer.
//
// This file is a stub. Task 5 of the per-surface-transparency-settings
// plan replaces it with the real settings:changed subscriber that
// applies --surface-*-alpha CSS variables from
// appearance.transparency on every settings broadcast.
//
// Until Task 5 lands, the preview window opens empty and transparent
// (just so Task 4's createPreviewWindow + IPC handlers can be wired
// and verified). NEVER call window.api.settings.save from here — the
// preview window is one-way (reads settings, never writes) and adding
// writes would break invariant 5 in the plan.
console.log('[preview] renderer stub loaded — Task 5 will flesh this out');
