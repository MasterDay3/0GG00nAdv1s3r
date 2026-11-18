// The basics every screen uses: the DOM helper, API calls, form locking, dates and plurals, shared state.
import { render } from './router.js';

// Changed by several modules (an imported binding cannot be assigned), so it lives in one object.
// me: the signed-in account. renderSeq: each screen load gets a number, so a slow load that finishes
// after a newer one does not draw over it. leaveGuard, guardHash: a running test that asks before it is left.
export const appState = { me: null, renderSeq: 0, leaveGuard: null, guardHash: '' };

export const main = document.getElementById('main');
export const nav = document.getElementById('nav');
const toastEl = document.getElementById('toast');


export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.className = value;
    else if (key === 'value') el.value = value;
    else if (key === 'checked') el.checked = Boolean(value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

export function safeHref(url) {
  return /^https?:\/\//i.test(url || '') ? url : null;
}

let toastTimer;
export function toast(message, isError = false) {
  toastEl.textContent = message;
  toastEl.className = isError ? 'error' : '';
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, Math.max(3500, message.length * 60));
}

export const offlineEl = document.getElementById('offline');

// Forms are locked from submit until their requests finish, so a double Enter does not create two deadlines.
let inFlight = 0;
function releaseForms() {
  for (const form of document.querySelectorAll('form[data-busy]')) {
    delete form.dataset.busy;
    for (const b of form.querySelectorAll('button[type=submit]')) b.disabled = false;
  }
}
document.addEventListener('submit', (e) => {
  const form = e.target;
  if (form.dataset.busy) { e.preventDefault(); e.stopImmediatePropagation(); return; }
  form.dataset.busy = '1';
  for (const b of form.querySelectorAll('button[type=submit]')) b.disabled = true;
  // A handler that stops before any request (a cancelled confirm) frees the form again.
  setTimeout(() => { if (!inFlight) releaseForms(); }, 50);
}, true);

export async function api(method, path, body) {
  inFlight++;
  try {
    return await request(method, path, body);
  } finally {
    inFlight--;
    if (!inFlight) setTimeout(() => { if (!inFlight) releaseForms(); }, 0);
  }
}

export async function request(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    offlineEl.hidden = false;
    throw new Error('Немає з’єднання з інтернетом');
  }
  // The service worker answers from saved data when offline and marks it.
  offlineEl.hidden = !res.headers.get('x-dueboard-offline');
  const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : null;
  if (!res.ok) {
    if (res.status === 401) forgetSavedData();
    if (res.status === 401 && appState.me) { appState.me = null; render(); }
    throw new Error(data?.error || `Запит не вдався (${res.status})`);
  }
  return data;
}

// Saved offline copies of the board belong to the signed-in account: drop them on log out.
export function forgetSavedData() {
  if ('caches' in window) caches.delete('dueboard-data').catch(() => {});
}

// Run an action from a button/form; show errors as a toast.
export async function act(fn, success) {
  try {
    const result = await fn();
    if (success) toast(success);
    return result;
  } catch (err) {
    toast(err.message, true);
    return undefined;
  }
}

export function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

export function localInputValue(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function parseLocalInput(value) {
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : NaN;
}

export function fmtDate(ms) {
  return new Date(ms).toLocaleString('uk-UA', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function fmtDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('uk-UA', { weekday: 'short', day: 'numeric', month: 'short' });
}

export function relative(ms, now = Date.now()) {
  const diff = ms - now;
  const abs = Math.abs(diff);
  const hours = Math.floor(abs / 3_600_000);
  const days = Math.floor(hours / 24);
  let span;
  if (abs < 3_600_000) span = `${Math.max(1, Math.round(abs / 60_000))} хв`;
  else if (days < 2) span = `${hours} год`;
  else span = plural(Math.round(abs / 86_400_000), ['день', 'дні', 'днів']);
  return diff < 0 ? `${span} тому` : `через ${span}`;
}

export function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`;
  return `${String(Number((bytes / 1024 / 1024).toFixed(1))).replace('.', ',')} МБ`;
}

// Ukrainian plural: forms = [1 питання, 2 питання, 5 питань].
export function plural(n, [one, few, many]) {
  const tens = n % 100;
  const units = n % 10;
  if (tens >= 11 && tens <= 14) return `${n} ${many}`;
  if (units === 1) return `${n} ${one}`;
  if (units >= 2 && units <= 4) return `${n} ${few}`;
  return `${n} ${many}`;
}
export const QUESTIONS = ['питання', 'питання', 'питань'];
export const PROBLEMS = ['задача', 'задачі', 'задач'];

export function dateOf(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function todayStr() {
  return dateOf(Date.now());
}

export function setView(...nodes) {
  main.replaceChildren(...nodes.flat(Infinity).filter(Boolean));
}
