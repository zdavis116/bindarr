// TELL HIM WHEN A NEW VERSION IS READY, AND LET HIM TAKE IT.
//
// Zach debugs from the deployed artifact and has been caught by cached JS more
// than once -- "hard-refresh, your phone caches the build" has been a standing
// instruction in this project. An installed PWA makes that worse: there is no
// address bar to pull down on, so a stale bundle can persist indefinitely.
//
// registerType is 'prompt' rather than 'autoUpdate' on purpose. Auto-updating
// swaps the running bundle mid-session, which for someone recounting cardboard
// against a screen means the numbers can change under him without explanation.
// A visible prompt is slower and honest.
import { registerSW } from 'virtual:pwa-register';

export function initServiceWorker({ onUpdateReady } = {}) {
  // The demo build is served from GitHub Pages with a different base path and
  // a fixture-backed fetch shim; a service worker there would cache fixtures
  // and serve them as if they were real.
  if (import.meta.env.VITE_DEMO) return () => {};

  return registerSW({
    immediate: true,
    onNeedRefresh() {
      // A new build is waiting. The app keeps running the old one until he
      // chooses -- nothing changes under him mid-task.
      if (typeof onUpdateReady === 'function') onUpdateReady();
    },
    onRegisterError(err) {
      // Logged, never thrown: the app must work exactly as before if the
      // service worker fails to register. A PWA feature breaking the website
      // would be a bad trade.
      console.error('Service worker registration failed:', err);
    },
  });
}
