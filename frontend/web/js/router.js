// Which screen to show for the address, guarding a running test, logging out.
import { showAuth } from './auth.js';
import { showBoard } from './board.js';
import { act, api, appState, forgetSavedData, h, main, nav, setView } from './core.js';
import { needsPremium, showCheckout, showPaywall } from './payments.js';
import { showExam, showPrep } from './prep.js';
import { showPrivacy } from './privacy.js';
import { showSettings } from './settings.js';

// The last route drawn: a new route moves the focus to its heading.
let lastRoute = null;

export async function render() {
  const seq = ++appState.renderSeq;
  nav.hidden = !appState.me;
  const route = location.hash || '#/board';
  const [, view = 'board', id] = route.split('/');
  for (const a of nav.querySelectorAll('a')) a.classList.toggle('active', a.dataset.view === view);
  // Readable without an account: a student should know what happens to their data before signing up.
  if (view === 'privacy') return showPrivacy(seq).catch((err) => setView(h('div', { class: 'panel empty' }, err.message)));
  if (!appState.me) return showAuth();
  try {
    if (view === 'pay') await showCheckout(seq);
    else if (view === 'prep' && needsPremium()) showPaywall();
    else if (view === 'prep' && id) await showExam(Number(id), seq);
    else if (view === 'prep') await showPrep(seq);
    else if (view === 'settings') await showSettings(seq);
    else await showBoard(seq);
  } catch (err) {
    if (appState.me && seq === appState.renderSeq) setView(h('div', { class: 'panel empty' }, h('p', {}, err.message), h('p', {}, h('a', { href: '#/board' }, 'На дошку'))));
  }
  // A new screen: move focus to its heading so keyboard and screen-reader users start there.
  if (seq === appState.renderSeq && route !== lastRoute) {
    lastRoute = route;
    const head = main.querySelector('h1');
    if (head) { head.tabIndex = -1; head.focus({ preventScroll: true }); }
  }
}

// True when a newer screen load started after this one.
export const stale = (seq) => seq !== undefined && seq !== appState.renderSeq;

// A running test may block leaving it (Back, the menu, a link) until the student confirms.
let skipHashchange = false;
export function setHashQuietly(hash) {
  if (location.hash === hash) return;
  skipHashchange = true;
  location.hash = hash;
}
window.addEventListener('hashchange', () => {
  if (skipHashchange) { skipHashchange = false; return; }
  if (appState.leaveGuard) {
    if (!appState.leaveGuard()) { setHashQuietly(appState.guardHash); return; }
    appState.leaveGuard = null;
  }
  render();
});
window.addEventListener('beforeunload', (e) => {
  if (appState.leaveGuard && !appState.leaveGuard(true)) e.preventDefault();
});
document.getElementById('logout').addEventListener('click', async () => {
  // Offline the session stays valid on the server: say so instead of only looking logged out.
  if (!(await act(() => api('POST', '/api/logout', {})))) return;
  forgetSavedData();
  appState.me = null;
  location.hash = '#/board';
  render();
});

export async function refreshMe() {
  appState.me = await api('GET', '/api/me');
}
