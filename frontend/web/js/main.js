// Start: load the account, draw the first screen, register the service worker.
import { appState, offlineEl } from './core.js';
import { refreshMe, render } from './router.js';

(async () => {
  try { await refreshMe(); } catch { appState.me = null; }
  render();
})();

// Install as an app and open offline. Not on plain http hosts other than localhost (browsers refuse there anyway).
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('Service worker:', err.message));
}
// Back online: hide the notice, but never redraw the screen (a test or a half-typed form would be lost).
window.addEventListener('online', () => { offlineEl.hidden = true; });
