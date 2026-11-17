const main = document.getElementById('main');
const nav = document.getElementById('nav');
const toastEl = document.getElementById('toast');
let me = null;

// ---------- helpers ----------

function h(tag, attrs = {}, ...children) {
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

function safeHref(url) {
  return /^https?:\/\//i.test(url || '') ? url : null;
}

let toastTimer;
function toast(message, isError = false) {
  toastEl.textContent = message;
  toastEl.className = isError ? 'error' : '';
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, Math.max(3500, message.length * 60));
}

const offlineEl = document.getElementById('offline');

async function api(method, path, body) {
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
    if (res.status === 401 && me) { me = null; forgetSavedData(); render(); }
    throw new Error(data?.error || `Запит не вдався (${res.status})`);
  }
  return data;
}

// Saved offline copies of the board belong to the signed-in account: drop them on log out.
function forgetSavedData() {
  if ('caches' in window) caches.delete('dueboard-data').catch(() => {});
}

// Run an action from a button/form; show errors as a toast.
async function act(fn, success) {
  try {
    const result = await fn();
    if (success) toast(success);
    return result;
  } catch (err) {
    toast(err.message, true);
    return undefined;
  }
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function localInputValue(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function parseLocalInput(value) {
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : NaN;
}

function fmtDate(ms) {
  return new Date(ms).toLocaleString('uk-UA', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function fmtDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('uk-UA', { weekday: 'short', day: 'numeric', month: 'short' });
}

function relative(ms, now = Date.now()) {
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

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`;
  return `${String(Number((bytes / 1024 / 1024).toFixed(1))).replace('.', ',')} МБ`;
}

// Ukrainian plural: forms = [1 питання, 2 питання, 5 питань].
function plural(n, [one, few, many]) {
  const tens = n % 100;
  const units = n % 10;
  if (tens >= 11 && tens <= 14) return `${n} ${many}`;
  if (units === 1) return `${n} ${one}`;
  if (units >= 2 && units <= 4) return `${n} ${few}`;
  return `${n} ${many}`;
}
const QUESTIONS = ['питання', 'питання', 'питань'];
const PROBLEMS = ['задача', 'задачі', 'задач'];

function dateOf(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function todayStr() {
  return dateOf(Date.now());
}

function setView(...nodes) {
  main.replaceChildren(...nodes.flat(Infinity).filter(Boolean));
}

// ---------- routing ----------

async function render() {
  nav.hidden = !me;
  const [, view = 'board', id] = (location.hash || '#/board').split('/');
  for (const a of nav.querySelectorAll('a')) a.classList.toggle('active', a.dataset.view === view);
  if (!me) return showAuth();
  try {
    if (view === 'prep' && id) await showExam(Number(id));
    else if (view === 'prep') await showPrep();
    else if (view === 'settings') await showSettings();
    else await showBoard();
  } catch (err) {
    if (me) setView(h('div', { class: 'panel empty' }, h('p', {}, err.message), h('p', {}, h('a', { href: '#/board' }, 'На дошку'))));
  }
}

window.addEventListener('hashchange', render);
document.getElementById('logout').addEventListener('click', async () => {
  await act(() => api('POST', '/api/logout', {}));
  forgetSavedData();
  me = null;
  location.hash = '#/board';
  render();
});

async function refreshMe() {
  me = await api('GET', '/api/me');
}

// ---------- auth ----------

function showAuth() {
  let mode = 'login';
  const error = h('p', { class: 'small', role: 'alert' });
  const submit = h('button', { type: 'submit' }, 'Увійти');
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      error.textContent = '';
      try {
        await api('POST', mode === 'login' ? '/api/login' : '/api/register', formData(form));
        await refreshMe();
        render();
      } catch (err) {
        error.textContent = err.message;
      }
    },
  },
  h('label', {}, 'Логін', h('input', { name: 'username', autocomplete: 'username', required: true })),
  h('label', {}, 'Пароль', h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true, minlength: 8 })),
  error,
  submit);

  const tabs = ['login', 'register'].map((m) => h('button', {
    type: 'button',
    class: m === mode ? '' : 'secondary',
    onclick: () => {
      mode = m;
      submit.textContent = m === 'login' ? 'Увійти' : 'Створити акаунт';
      form.password.autocomplete = m === 'login' ? 'current-password' : 'new-password';
      tabs.forEach((t, i) => { t.className = ['login', 'register'][i] === m ? '' : 'secondary'; });
    },
  }, m === 'login' ? 'Вхід' : 'Реєстрація'));

  const forgot = h('button', { type: 'button', class: 'link small', onclick: () => showReset(form.username.value) }, 'Забули пароль?');

  setView(h('div', { class: 'auth' },
    h('h1', {}, 'Dueboard'),
    h('p', { class: 'tagline' }, 'Усі дедлайни курсів в одному списку і помічник для підготовки до екзамену.'),
    h('div', { class: 'panel' }, h('div', { class: 'tabs' }, tabs), form, h('p', { class: 'auth-foot' }, forgot))));
}

// Forgotten password: a code comes to the Telegram chat linked to the account.
function showReset(username = '') {
  const error = h('p', { class: 'small', role: 'alert' });
  const fail = (err) => { error.textContent = err.message; };
  const back = h('button', { type: 'button', class: 'link small', onclick: showAuth }, 'Назад до входу');
  const panel = h('div', { class: 'panel' });

  const askForm = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      error.textContent = '';
      try {
        await api('POST', '/api/password-reset', { username: askForm.username.value });
        showCodeForm(askForm.username.value.trim());
      } catch (err) { fail(err); }
    },
  },
  h('p', { class: 'muted small' }, 'Якщо акаунт прив’язаний до Telegram, бот Dueboard надішле туди код. Без Telegram відновити пароль не вийде: вхід тільки за логіном і паролем.'),
  h('label', {}, 'Логін', h('input', { name: 'username', autocomplete: 'username', required: true, value: username })),
  error,
  h('button', { type: 'submit' }, 'Надіслати код'));

  function showCodeForm(name) {
    error.textContent = '';
    const codeForm = h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        error.textContent = '';
        try {
          await api('POST', '/api/password-reset/confirm', { username: name, code: codeForm.code.value, password: codeForm.password.value });
          await refreshMe();
          toast('Пароль змінено');
          location.hash = '#/board';
          render();
        } catch (err) { fail(err); }
      },
    },
    h('p', { class: 'muted small' }, `Якщо акаунт ${name} прив’язаний до Telegram, код уже в чаті з ботом. Він діє 15 хвилин.`),
    h('label', {}, 'Код із Telegram', h('input', { name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', required: true, maxlength: 12 })),
    h('label', {}, 'Новий пароль', h('input', { name: 'password', type: 'password', autocomplete: 'new-password', required: true, minlength: 8 })),
    error,
    h('button', { type: 'submit' }, 'Змінити пароль'));
    panel.replaceChildren(h('h2', {}, 'Новий пароль'), codeForm, h('p', { class: 'auth-foot' }, back));
    codeForm.code.focus();
  }

  panel.replaceChildren(h('h2', {}, 'Відновлення пароля'), askForm, h('p', { class: 'auth-foot' }, back));
  setView(h('div', { class: 'auth' }, h('h1', {}, 'Dueboard'), panel));
  askForm.username.focus();
}

// ---------- board ----------

const SOURCE_LABEL = { moodle: 'Moodle', personal: 'Особистий', group: 'Група', exam: 'Екзамен' };

function noteEditor(item, onSaved) {
  const box = h('div', { class: 'note' });
  const showText = () => {
    box.replaceChildren(...[
      item.note ? h('p', { class: 'note-text' }, item.note) : null,
      h('button', { type: 'button', class: 'link small', onclick: edit }, item.note ? 'Змінити нотатку' : '+ Нотатка'),
    ].filter(Boolean));
  };
  function edit() {
    const area = h('textarea', { maxlength: 2000, 'aria-label': `Нотатка до «${item.title}»` });
    area.value = item.note;
    box.replaceChildren(area, h('div', { class: 'row' },
      h('button', {
        type: 'button', class: 'shrink',
        onclick: async () => {
          const saved = await act(() => api('PUT', '/api/notes', { key: item.key, text: area.value }));
          if (saved) { item.note = area.value.trim(); onSaved?.(); showText(); }
        },
      }, 'Зберегти'),
      h('button', { type: 'button', class: 'secondary shrink', onclick: showText }, 'Скасувати')));
    area.focus();
  }
  showText();
  return box;
}

function deadlineRow(item, now, reload) {
  const href = safeHref(item.url);
  const titleNode = item.source === 'exam'
    ? h('a', { href: `#/prep/${item.id}`, class: 'title' }, `Екзамен: ${item.title}`)
    : href ? h('a', { href, class: 'title', target: '_blank', rel: 'noopener noreferrer' }, item.title)
      : h('span', { class: 'title' }, item.title);
  return h('li', { class: `item ${item.urgency}${item.done ? ' done' : ''}` },
    h('div', { class: 'due' },
      h('time', { class: 'num', datetime: new Date(item.dueAt).toISOString(), title: fmtDate(item.dueAt) }, fmtTime(item.dueAt)),
      h('span', { class: `chip ${item.urgency}` }, item.urgency === 'overdue' ? 'Прострочено' : relative(item.dueAt, now))),
    h('div', { class: 'what' },
      titleNode,
      h('div', { class: 'meta' }, item.course ? h('span', {}, item.course) : null, h('span', { class: 'tag' }, SOURCE_LABEL[item.source]))),
    h('div', { class: 'item-actions' },
      item.key.startsWith('d') ? h('button', {
        type: 'button', class: 'secondary small', 'aria-pressed': String(item.done),
        title: item.done ? 'Повернути на дошку' : 'Позначити виконаним: дедлайн зникне з дошки й більше не нагадуватиме',
        onclick: async () => {
          if (await act(() => api('PUT', '/api/done', { key: item.key, done: !item.done }))) reload();
        },
      }, item.done ? 'Повернути' : 'Виконано') : null,
      item.canDelete ? h('button', {
        type: 'button', class: 'secondary small',
        onclick: (e) => {
          const row = e.currentTarget.closest('li');
          row.classList.add('editing');
          row.replaceChildren(deadlineEditForm(item, reload));
          row.querySelector('input').focus();
        },
      }, 'Змінити') : null,
      item.canDelete ? h('button', {
        type: 'button', class: 'danger small',
        onclick: async () => {
          if (!confirm(`Видалити «${item.title}»?`)) return;
          if (await act(() => api('DELETE', `/api/deadlines/${item.id}`))) reload();
        },
      }, 'Видалити') : null),
    noteEditor(item));
}

// Edit a deadline the user added (Moodle ones change in Moodle).
function deadlineEditForm(item, reload) {
  const form = h('form', {
    class: 'edit-form',
    onsubmit: async (e) => {
      e.preventDefault();
      const f = formData(form);
      const ok = await act(() => api('PUT', `/api/deadlines/${item.id}`, {
        title: f.title, course: f.course, url: f.url, dueAt: parseLocalInput(f.dueAt),
      }));
      if (ok) reload();
    },
  },
  h('div', { class: 'row' },
    h('label', { class: 'grow' }, 'Що здати', h('input', { name: 'title', required: true, maxlength: 200, value: item.title })),
    h('label', {}, 'Курс', h('input', { name: 'course', maxlength: 100, value: item.course }))),
  h('div', { class: 'row' },
    h('label', {}, 'Термін', h('input', { name: 'dueAt', type: 'datetime-local', required: true, value: localInputValue(item.dueAt) })),
    h('label', { class: 'grow' }, 'Посилання (необов’язково)', h('input', { name: 'url', type: 'url', value: item.url, placeholder: 'https://' }))),
  saveCancel(reload));
  return form;
}

function saveCancel(onCancel) {
  return h('div', { class: 'row' },
    h('button', { type: 'submit', class: 'shrink' }, 'Зберегти'),
    h('button', { type: 'button', class: 'secondary shrink', onclick: onCancel }, 'Скасувати'));
}

function fmtTime(ms) {
  return new Date(ms).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
}

function dayLabel(dateStr) {
  const today = todayStr();
  if (dateStr === today) return 'Сьогодні';
  const [y, m, d] = today.split('-').map(Number);
  const tomorrow = new Date(y, m - 1, d + 1);
  if (dateStr === dateOf(tomorrow.getTime())) return 'Завтра';
  const weekday = new Date(dateStr.replace(/-/g, '/')).toLocaleDateString('uk-UA', { weekday: 'long' });
  return weekday.charAt(0).toUpperCase() + weekday.slice(1);
}

// The next deadline, open as a notebook card.
function nextCard(item, now) {
  const href = item.source === 'exam' ? `#/prep/${item.id}` : safeHref(item.url);
  const title = item.source === 'exam' ? `Екзамен: ${item.title}` : item.title;
  return h('aside', { class: 'next', 'aria-label': 'Найближчий дедлайн' },
    h('div', { class: 'next-head' }, h('span', {}, 'Далі'), h('span', { class: 'num' }, fmtDay(dateOf(item.dueAt)))),
    h('div', { class: 'next-time' }, fmtTime(item.dueAt)),
    h('dl', { class: 'next-cells' },
      h('div', { class: 'wide' }, h('dt', {}, 'Що'), h('dd', {}, href
        ? h('a', item.source === 'exam' ? { href } : { href, target: '_blank', rel: 'noopener noreferrer' }, title)
        : title)),
      h('div', {}, h('dt', {}, 'Коли'), h('dd', {}, relative(item.dueAt, now))),
      h('div', {}, h('dt', {}, item.course ? 'Курс' : 'Звідки'), h('dd', {}, item.course || SOURCE_LABEL[item.source]))));
}

function addDeadlineForm(reload) {
  const defaultDue = new Date();
  defaultDue.setDate(defaultDue.getDate() + 7);
  defaultDue.setHours(23, 59, 0, 0);
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      const f = formData(form);
      const ok = await act(() => api('POST', '/api/deadlines', {
        title: f.title, course: f.course, url: f.url, dueAt: parseLocalInput(f.dueAt), shared: f.shared === 'on',
      }));
      if (ok) reload();
    },
  },
  h('div', { class: 'row' },
    h('label', { class: 'grow' }, 'Що здати', h('input', { name: 'title', required: true, maxlength: 200, placeholder: 'напр. есей, який задали на парі' })),
    h('label', {}, 'Курс', h('input', { name: 'course', maxlength: 100 }))),
  h('div', { class: 'row' },
    h('label', {}, 'Термін', h('input', { name: 'dueAt', type: 'datetime-local', required: true, value: localInputValue(defaultDue.getTime()) })),
    h('label', { class: 'grow' }, 'Посилання (необов’язково)', h('input', { name: 'url', type: 'url', placeholder: 'https://' }))),
  h('div', { class: 'row' },
    me.group
      ? h('label', { class: 'inline' }, h('input', { type: 'checkbox', name: 'shared' }), `Поділитися з групою (${me.group.name})`)
      : h('span', { class: 'muted small' }, 'Приєднайтеся до групи в Налаштуваннях, щоб ділитися дедлайнами з одногрупниками.'),
    h('button', { type: 'submit', class: 'shrink' }, 'Додати дедлайн')));
  return h('details', { class: 'panel compact add-deadline' }, h('summary', {}, 'Додати дедлайн, якого немає в Moodle'), form);
}

async function showBoard() {
  const [{ items, now }] = await Promise.all([api('GET', '/api/deadlines'), refreshMe()]);
  const showPast = sessionStorageGet('showPast') === '1';
  const showDone = sessionStorageGet('showDone') === '1';
  const open = items.filter((i) => !i.done);
  const doneItems = items.filter((i) => i.done).sort((a, b) => b.dueAt - a.dueAt);
  const upcoming = open.filter((i) => i.urgency !== 'overdue');
  const past = open.filter((i) => i.urgency === 'overdue');
  const counts = { red: 0, amber: 0 };
  for (const i of upcoming) if (i.urgency in counts) counts[i.urgency]++;

  const pastToggle = h('label', { class: 'inline small' },
    h('input', {
      type: 'checkbox', checked: showPast,
      onchange: (e) => { sessionStorageSet('showPast', e.target.checked ? '1' : '0'); render(); },
    }), `Минулі (${past.length})`);

  const doneToggle = doneItems.length ? h('label', { class: 'inline small' },
    h('input', {
      type: 'checkbox', checked: showDone,
      onchange: (e) => { sessionStorageSet('showDone', e.target.checked ? '1' : '0'); render(); },
    }), `Виконані (${doneItems.length})`) : null;

  // Search and course filter work on the page only, so typing never waits for the server.
  const courses = [...new Set(items.map((i) => i.course).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'uk'));
  let query = sessionStorageGet('boardQuery') || '';
  let course = sessionStorageGet('boardCourse') || '';
  if (course && !courses.includes(course)) course = '';
  const listBox = h('div', { class: 'board-list' });

  function drawList() {
    const words = query.toLocaleLowerCase('uk').split(/\s+/).filter(Boolean);
    const matches = (item) => (!course || item.course === course)
      && words.every((w) => `${item.title} ${item.course} ${item.note}`.toLocaleLowerCase('uk').includes(w));
    const filtering = Boolean(course || words.length);
    // While searching, past deadlines are searched too: the one you look for may be overdue.
    const list = [...(showPast || filtering ? past : []), ...upcoming].filter(matches);
    const doneShown = showDone || filtering ? doneItems.filter(matches) : [];

    // Rule the ledger by day; everything past due sits in one group at the top.
    const groups = [];
    for (const item of list) {
      const key = item.urgency === 'overdue' ? 'past' : dateOf(item.dueAt);
      if (groups.at(-1)?.key !== key) groups.push({ key, items: [] });
      groups.at(-1).items.push(item);
    }

    let empty = null;
    if (!list.length && filtering) {
      empty = h('div', { class: 'panel empty' }, h('p', {}, doneShown.length ? 'Серед відкритих дедлайнів нічого не знайдено.' : 'Нічого не знайдено.'));
    } else if (!list.length) {
      empty = h('div', { class: 'panel empty' },
        h('p', {}, doneItems.length ? 'Усе зроблено. На дошці порожньо.' : 'Дедлайнів поки немає.'),
        doneItems.length ? null : h('p', {}, h('a', { href: '#/settings' }, 'Під’єднайте календар Moodle'), ' або додайте дедлайн вище.'));
    }

    listBox.replaceChildren(...[
      ...groups.map((g) => h('section', { class: 'day' },
        h('div', { class: 'day-head' },
          h('h2', {}, g.key === 'past' ? 'Прострочено' : dayLabel(g.key)),
          g.key === 'past' ? null : h('span', { class: 'num' }, new Date(g.key.replace(/-/g, '/')).toLocaleDateString('uk-UA', { day: 'numeric', month: 'short' }))),
        h('ul', { class: 'ledger' }, g.items.map((item) => deadlineRow(item, now, render))))),
      empty,
      doneShown.length
        ? h('section', { class: 'day done-list' },
          h('div', { class: 'day-head' }, h('h2', {}, 'Виконані'), h('span', { class: 'num' }, String(doneShown.length))),
          h('ul', { class: 'ledger' }, doneShown.map((item) => deadlineRow(item, now, render))))
        : null,
    ].filter(Boolean));
  }

  const filterBar = items.length ? h('div', { class: 'filter-bar', role: 'search' },
    h('label', { class: 'grow' }, h('span', { class: 'visually-hidden' }, 'Пошук'),
      h('input', {
        type: 'search', placeholder: 'Пошук за назвою, курсом чи нотаткою', value: query, 'aria-label': 'Пошук дедлайнів',
        oninput: (e) => { query = e.target.value; sessionStorageSet('boardQuery', query); drawList(); },
      })),
    courses.length > 1 ? h('label', {}, h('span', { class: 'visually-hidden' }, 'Курс'),
      h('select', {
        'aria-label': 'Фільтр за курсом',
        onchange: (e) => { course = e.target.value; sessionStorageSet('boardCourse', course); drawList(); },
      },
      h('option', { value: '' }, 'Усі курси'),
      courses.map((c) => h('option', { value: c, selected: c === course }, c)))) : null) : null;
  drawList();

  const syncButton = me.icsUrl ? h('button', {
    type: 'button', class: 'secondary',
    onclick: async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.setAttribute('aria-busy', 'true');
      btn.textContent = 'Синхронізую…';
      const r = await act(syncMoodle);
      btn.disabled = false;
      btn.removeAttribute('aria-busy');
      btn.textContent = 'Оновити з Moodle';
      if (r) { toast(`Синхронізовано подій Moodle: ${r.imported}`); render(); }
    },
  }, 'Оновити з Moodle') : null;

  const syncWarning = me.syncError ? h('div', { class: 'panel warning', role: 'alert' },
    h('strong', {}, 'Дедлайни з Moodle не оновлюються. '), me.syncError.replace(/[.!]?$/, '. '),
    h('a', { href: '#/settings' }, 'Перевірити посилання')) : null;

  setView(
    syncWarning,
    h('div', { class: 'board-head' },
      h('div', {},
        h('h1', {}, 'Ваші дедлайни'),
        h('dl', { class: 'counts' },
          h('div', { class: 'red' }, h('dt', {}, 'за 48 год'), h('dd', {}, counts.red)),
          h('div', { class: 'amber' }, h('dt', {}, 'цього тижня'), h('dd', {}, counts.amber))),
        h('div', { class: 'board-actions' },
          syncButton,
          me.icsUrl ? null : h('a', { href: '#/settings' }, 'Під’єднати Moodle'),
          pastToggle,
          doneToggle)),
      upcoming.length ? nextCard(upcoming[0], now) : null),
    addDeadlineForm(render),
    filterBar,
    listBox,
  );
}

function sessionStorageGet(key) {
  try { return sessionStorage.getItem(key); } catch { return null; }
}
function sessionStorageSet(key, value) {
  try { sessionStorage.setItem(key, value); } catch { /* storage unavailable */ }
}

// ---------- browser extension ----------

// The Dueboard Sync extension marks the page when installed and answers window messages.
const extensionInstalled = () => Boolean(document.documentElement.dataset.dueboardExtension);

let extensionCallId = 0;
function extensionCall(type, extra = {}) {
  return new Promise((resolve, reject) => {
    const id = ++extensionCallId;
    const done = () => { clearTimeout(timer); window.removeEventListener('message', onMessage); };
    const timer = setTimeout(() => {
      done();
      reject(new Error('Розширення Dueboard Sync не відповіло. Перезавантажте сторінку й спробуйте ще раз.'));
    }, 30_000);
    function onMessage(event) {
      if (event.source !== window || event.data?.source !== 'dueboard-extension' || event.data.id !== id) return;
      done();
      const result = event.data.result;
      if (!result) reject(new Error('Розширення не відповіло. Перезавантажте розширення й цю сторінку.'));
      else if (result.ok) resolve(result);
      else reject(new Error(result.error));
    }
    window.addEventListener('message', onMessage);
    window.postMessage({ source: 'dueboard-page', type, id, ...extra }, location.origin);
  });
}

// Sync through the extension when it is connected (needed for Moodles behind a bot check), else via the server.
function syncMoodle() {
  if (me.extension.connected && extensionInstalled()) return extensionCall('sync');
  return api('POST', '/api/sync', {});
}

function extensionCard() {
  const steps = h('ol', { class: 'small' },
    h('li', {}, 'Відкрийте ', h('span', { class: 'code' }, 'chrome://extensions'), ' і ввімкніть режим розробника (праворуч угорі).'),
    h('li', {}, 'Натисніть «Load unpacked» і виберіть папку ', h('span', { class: 'code' }, 'extension'), ' цього проєкту.'),
    h('li', {}, 'Перезавантажте цю сторінку й натисніть «Під’єднати розширення».'));
  const intro = h('p', { class: 'muted small' },
    'Moodle УКУ блокує сервери перевіркою на бота, тож Dueboard не може сам завантажити ваш календар. '
    + 'Розширення Dueboard Sync завантажує його з вашого браузера щогодини й щоразу, коли ви відкриваєте Moodle.');

  if (!extensionInstalled()) {
    return [intro, steps, me.extension.connected
      ? h('p', { class: 'small' }, 'Під’єднано в іншому браузері. Встановіть розширення і тут, щоб синхронізувати з цього.')
      : null];
  }
  if (!me.extension.connected) {
    return [intro, h('button', {
      type: 'button',
      onclick: async (e) => {
        e.target.disabled = true;
        const { key } = (await act(() => api('POST', '/api/extension/key', {}))) || {};
        if (key) {
          const r = await act(() => extensionCall('connect', { key }));
          toast(r ? `Розширення під’єднано, синхронізовано подій Moodle: ${r.imported}` : 'Розширення під’єднано. Воно синхронізує календар, щойно ви відкриєте Moodle.');
        }
        render();
      },
    }, 'Під’єднати розширення')];
  }
  return [
    h('p', {}, h('span', { class: 'status-ok' }, 'Під’єднано'), ' Дедлайни оновлюються щогодини й щоразу, коли ви відкриваєте Moodle.'),
    h('div', { class: 'row' },
      h('button', {
        type: 'button', class: 'shrink',
        onclick: async (e) => {
          e.target.disabled = true;
          const r = await act(() => extensionCall('sync'));
          if (r) toast(`Синхронізовано подій Moodle: ${r.imported}`);
          render();
        },
      }, 'Синхронізувати'),
      h('button', {
        type: 'button', class: 'secondary shrink',
        onclick: async () => {
          if (await act(() => api('DELETE', '/api/extension/key'))) render();
        },
      }, 'Від’єднати')),
  ];
}

// ---------- settings ----------

async function showSettings() {
  await refreshMe();

  const moodleForm = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      const saved = await act(() => api('PUT', '/api/settings', { icsUrl: moodleForm.icsUrl.value }));
      if (!saved) return;
      me = saved;
      if (!saved.icsUrl) { toast('Посилання на Moodle видалено'); return render(); }
      const r = await act(syncMoodle);
      if (r) { toast(`Збережено, синхронізовано подій Moodle: ${r.imported}`); return render(); }
      // Sync failed (e.g. a bot check in front of Moodle): point to the extension.
      extensionSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
    },
  },
  h('label', {}, 'Посилання на календар Moodle',
    h('input', { name: 'icsUrl', type: 'text', value: me.icsUrl, placeholder: 'https://moodle.ucu.edu.ua/calendar/export_execute.php?…' })),
  h('div', { class: 'row' },
    h('span', { class: 'muted small' }, me.lastSyncAt ? `Остання синхронізація: ${fmtDate(me.lastSyncAt)}.` : 'Ще не синхронізовано.',
      me.syncError ? h('span', { class: 'sync-error' }, ` Остання спроба не вдалася: ${me.syncError}`) : null),
    h('button', { type: 'submit', class: 'shrink' }, 'Зберегти й оновити')));

  const pasteForm = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      const file = pasteForm.file.files[0];
      const ics = file ? await file.text() : pasteForm.ics.value;
      const r = await act(() => api('POST', '/api/import-ics', { ics }));
      if (r) { toast(`Імпортовано подій: ${r.imported}`); pasteForm.reset(); pasteForm.file.dispatchEvent(new Event('change')); }
    },
  },
  h('div', {}, h('span', { class: 'field-label' }, 'Файл .ics'), filePicker(h('input', { name: 'file', type: 'file', accept: '.ics,text/calendar' }))),
  h('label', {}, '…або вставте його вміст', h('textarea', { name: 'ics', placeholder: 'BEGIN:VCALENDAR…' })),
  h('button', { type: 'submit' }, 'Імпортувати'));

  const importBox = h('details', {},
    h('summary', {}, 'Імпортувати файл .ics'),
    h('p', { class: 'muted small spaced' }, 'У Moodle: Календар → Імпорт або експорт календарів → Експорт календаря → «Експортувати». Завантажте отриманий файл сюди. Щоб оновити, імпортуйте його ще раз.'),
    pasteForm);

  const groupCard = me.group
    ? h('div', {},
      h('p', {}, 'Ви в групі ', h('strong', {}, me.group.name), '. Одногрупники приєднуються з цим кодом:'),
      h('p', { class: 'code' }, me.group.code),
      h('button', {
        type: 'button', class: 'secondary',
        onclick: async () => {
          if (!confirm('Вийти з групи? Ви перестанете бачити її спільні дедлайни.')) return;
          if (await act(() => api('POST', '/api/group/leave', {}))) render();
        },
      }, 'Вийти з групи'))
    : h('div', {},
      h('form', {
        class: 'row',
        onsubmit: async (e) => {
          e.preventDefault();
          if (await act(() => api('POST', '/api/group/join', formData(e.target)))) render();
        },
      }, h('label', {}, 'Приєднатися за кодом', h('input', { name: 'code', required: true, maxlength: 16 })), h('button', { type: 'submit', class: 'secondary shrink' }, 'Приєднатися')),
      h('form', {
        class: 'row',
        onsubmit: async (e) => {
          e.preventDefault();
          if (await act(() => api('POST', '/api/group', formData(e.target)))) render();
        },
      }, h('label', {}, '…або створіть свою', h('input', { name: 'name', required: true, maxlength: 80, placeholder: 'напр. КН-2, 2 курс' })), h('button', { type: 'submit', class: 'shrink secondary' }, 'Створити')));

  const setting = (title, ...body) => h('section', { class: 'setting' }, h('h2', {}, title), h('div', { class: 'setting-body' }, body));
  const extensionSection = setting('Автосинхронізація (розширення Chrome)', extensionCard());

  const tgBox = h('div', {});
  const renderTelegram = () => {
    if (!me.telegram.enabled) {
      tgBox.replaceChildren(h('p', { class: 'muted small' }, 'Telegram-бот на цьому сервері вимкнений. Щоб увімкнути нагадування, запустіть сервер із TELEGRAM_BOT_TOKEN.'));
    } else if (me.telegram.linked) {
      tgBox.replaceChildren(
        h('p', {}, h('span', { class: 'status-ok' }, 'Прив’язано'), ' Бот нагадує про кожен дедлайн, а зранку надсилає дайджест: що здавати цього тижня і що вчити сьогодні.'),
        reminderChoice(),
        h('p', { class: 'muted' }, 'Команди бота: /deadlines показує дедлайни, /digest вмикає чи вимикає дайджест, /stop відв’язує чат.'),
        h('button', {
          type: 'button', class: 'secondary',
          onclick: async () => { if (await act(() => api('DELETE', '/api/telegram'))) render(); },
        }, 'Відв’язати'));
    } else {
      tgBox.replaceChildren(
        h('p', {}, 'Отримуйте нагадування за 3 дні й за 1 день до кожного дедлайну.'),
        h('button', {
          type: 'button',
          onclick: async () => {
            const r = await act(() => api('POST', '/api/telegram/link', {}));
            if (!r) return;
            const deepLink = `https://t.me/${encodeURIComponent(r.botName)}?start=${r.code}`;
            tgBox.replaceChildren(
              h('p', {}, 'Відкрийте ', h('a', { href: deepLink, target: '_blank', rel: 'noopener noreferrer' }, `@${r.botName}`), ' і натисніть Start або надішліть боту:'),
              h('p', { class: 'code' }, `/start ${r.code}`),
              h('button', { type: 'button', class: 'secondary', onclick: render }, 'Готово, оновити'));
          },
        }, 'Під’єднати Telegram'));
    }
  };
  renderTelegram();

  setView(
    h('div', { class: 'page-head' },
      h('h1', {}, 'Налаштування'),
      h('p', { class: 'muted' }, 'Ви ввійшли як ', h('strong', {}, me.username))),
    setting('Під’єднати Moodle',
      h('p', { class: 'muted small' }, 'У Moodle відкрийте Календар → Імпорт або експорт календарів → Експорт календаря, виберіть «Усі події» та «Нещодавні й наступні 60 днів», потім «Отримати URL календаря». Це посилання лише для читання: без пароля й без повного доступу.'),
      moodleForm),
    extensionSection,
    setting('Ваша група', groupCard),
    setting('Нагадування в Telegram', tgBox),
    setting('Google чи Apple Календар', calendarCard()),
    setting('Імпорт файлу', importBox),
    setting('Акаунт', accountCard()));
}

// The board as a calendar feed: the secret link is shown once, right after it is made.
// When the Telegram reminders come; saved on every change.
function reminderChoice() {
  const options = [['3d', 'За 3 дні'], ['1d', 'За 1 день'], ['3h', 'За 3 години']];
  const boxes = options.map(([kind, label]) => h('label', { class: 'inline' },
    h('input', {
      type: 'checkbox', value: kind, checked: me.telegram.reminders.includes(kind),
      onchange: async () => {
        const kinds = boxes.filter((b) => b.querySelector('input').checked).map((b) => b.querySelector('input').value);
        const r = await act(() => api('PUT', '/api/telegram/reminders', { kinds }), kinds.length ? 'Збережено' : 'Нагадування вимкнено, дайджест лишається');
        if (r) me.telegram.reminders = r.reminders;
      },
    }), label));
  return h('fieldset', { class: 'reminder-choice' }, h('legend', { class: 'small muted' }, 'Коли нагадувати'), boxes);
}

function calendarCard() {
  const box = h('div', {});
  const intro = h('p', { class: 'muted small' }, 'Дедлайни й екзамени з’являться у вашому календарі на телефоні й оновлюватимуться самі. Виконані зникають. Google оновлює підписані календарі раз на кілька годин.');

  const create = async () => {
    if (me.calendarFeed && !confirm('Створити нове посилання? Старе перестане працювати, і календар, підписаний на нього, перестане оновлюватися.')) return;
    const r = await act(() => api('POST', '/api/calendar-feed', {}));
    if (!r) return;
    me.calendarFeed = true;
    showLink(`${location.origin}${r.path}`);
  };
  const turnOff = async () => {
    if (!confirm('Вимкнути посилання? Календарі, підписані на нього, перестануть оновлюватися.')) return;
    if (await act(() => api('DELETE', '/api/calendar-feed'))) { me.calendarFeed = false; draw(); }
  };

  function showLink(url) {
    const webcal = url.replace(/^https?:/, 'webcal:');
    const input = h('input', { type: 'text', readonly: true, value: url, 'aria-label': 'Посилання на календар', onfocus: (e) => e.target.select() });
    box.replaceChildren(
      intro,
      h('p', { class: 'small' }, h('strong', {}, 'Збережіть посилання зараз: ми покажемо його лише раз.'), ' Воно секретне, як пароль: хто його має, бачить ваші дедлайни.'),
      h('div', { class: 'row' }, h('label', { class: 'grow' }, input),
        h('button', {
          type: 'button', class: 'secondary shrink',
          onclick: async () => {
            try { await navigator.clipboard.writeText(url); toast('Скопійовано'); } catch { input.focus(); toast('Скопіюйте посилання вручну', true); }
          },
        }, 'Копіювати')),
      h('ul', { class: 'small calendar-how' },
        h('li', {}, h('a', { href: `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal)}`, target: '_blank', rel: 'noopener noreferrer' }, 'Додати в Google Календар'), ' (або Google Календар → Інші календарі → + → З URL-адреси).'),
        h('li', {}, h('a', { href: webcal }, 'Відкрити в Apple Календарі'), ' на iPhone чи Mac.'),
        h('li', {}, 'Outlook: Додати календар → Підписатися з Інтернету.')));
  }

  function draw() {
    box.replaceChildren(intro, me.calendarFeed
      ? h('div', {},
        h('p', {}, h('span', { class: 'status-ok' }, 'Увімкнено'), ' Загубили посилання? Створіть нове: старе вимкнеться.'),
        h('div', { class: 'row' },
          h('button', { type: 'button', class: 'secondary shrink', onclick: create }, 'Нове посилання'),
          h('button', { type: 'button', class: 'secondary shrink', onclick: turnOff }, 'Вимкнути')))
      : h('button', { type: 'button', class: 'secondary', onclick: create }, 'Створити посилання'));
  }
  draw();
  return box;
}

// Fetched first, so an expired session shows an error instead of saving the error as the "data" file.
async function downloadExport() {
  const res = await fetch('/api/export').catch(() => null);
  if (!res) return toast('Немає з’єднання з інтернетом', true);
  if (!res.ok) {
    if (res.status === 401) { me = null; forgetSavedData(); render(); }
    return toast(res.status === 401 ? 'Сесія закінчилася. Увійдіть знову.' : 'Не вдалося підготувати файл', true);
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || 'dueboard.json';
  const url = URL.createObjectURL(await res.blob());
  const a = h('a', { href: url, download: name, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function accountCard() {
  const signedOut = () => { me = null; forgetSavedData(); location.hash = '#/board'; render(); };

  const passwordForm = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      const f = formData(passwordForm);
      if (await act(() => api('PUT', '/api/password', { current: f.current, password: f.password }), 'Пароль змінено. Інші пристрої вийшли з акаунта.')) passwordForm.reset();
    },
  },
  h('input', { type: 'text', name: 'username', autocomplete: 'username', value: me.username, hidden: true }),
  h('div', { class: 'row' },
    h('label', { class: 'grow' }, 'Поточний пароль', h('input', { name: 'current', type: 'password', autocomplete: 'current-password', required: true })),
    h('label', { class: 'grow' }, 'Новий пароль', h('input', { name: 'password', type: 'password', autocomplete: 'new-password', required: true, minlength: 8 }))),
  h('button', { type: 'submit', class: 'secondary' }, 'Змінити пароль'));

  const deleteForm = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      const f = formData(deleteForm);
      if (!confirm('Видалити акаунт назавжди? Дедлайни, нотатки, екзамени й файли зникнуть, і повернути їх не вийде.')) return;
      if (await act(() => api('DELETE', '/api/account', { confirm: f.confirm, password: f.password }), 'Акаунт видалено')) signedOut();
    },
  },
  h('p', { class: 'muted small' }, 'Зникнуть ваші дедлайни, нотатки, екзамени, питання й файли. Дедлайни, якими ви поділилися з групою, залишаться в групі.'),
  h('div', { class: 'row' },
    h('label', { class: 'grow' }, `Введіть свій логін (${me.username})`, h('input', { name: 'confirm', required: true, autocomplete: 'off' })),
    h('label', { class: 'grow' }, 'Пароль', h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true }))),
  h('button', { type: 'submit', class: 'danger' }, 'Видалити акаунт'));

  return [
    h('p', { class: 'small' },
      h('button', { type: 'button', class: 'link', onclick: downloadExport }, 'Завантажити всі мої дані'),
      h('span', { class: 'muted' }, ': дедлайни, нотатки, екзамени, питання й результати тестів одним файлом JSON.')),
    h('details', {}, h('summary', {}, 'Змінити пароль'), passwordForm),
    h('details', {},
      h('summary', {}, 'Вийти на всіх пристроях'),
      h('p', { class: 'muted small spaced' }, 'Знадобиться, якщо ви входили на чужому комп’ютері. Вийде й цей браузер.'),
      h('button', {
        type: 'button', class: 'secondary',
        onclick: async () => { if (await act(() => api('POST', '/api/logout-all', {}), 'Ви вийшли на всіх пристроях')) signedOut(); },
      }, 'Вийти всюди')),
    h('details', {}, h('summary', {}, 'Видалити акаунт'), deleteForm),
    me.telegram.linked ? null : h('p', { class: 'muted small spaced' }, 'Порада: прив’яжіть Telegram, щоб мати змогу відновити пароль, якщо забудете.'),
  ];
}

// ---------- exam prep ----------

async function showPrep() {
  const exams = await api('GET', '/api/exams');
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      const f = formData(form);
      const r = await act(() => api('POST', '/api/exams', { title: f.title, course: f.course, examAt: parseLocalInput(f.examAt) }));
      if (r) location.hash = `#/prep/${r.id}`;
    },
  },
  h('div', { class: 'row' },
    h('label', { class: 'grow' }, 'Екзамен', h('input', { name: 'title', required: true, maxlength: 200, placeholder: 'напр. Матаналіз, підсумковий' })),
    h('label', {}, 'Курс', h('input', { name: 'course', maxlength: 100 }))),
  h('div', { class: 'row' },
    h('label', {}, 'Дата й час', h('input', { name: 'examAt', type: 'datetime-local', required: true })),
    h('button', { type: 'submit', class: 'shrink' }, 'Додати екзамен')));

  setView(
    h('div', { class: 'page-head' },
      h('h1', {}, 'Підготовка до екзаменів'),
      h('p', { class: 'muted' }, 'Додайте екзамен, його теми й кілька питань. Діагностичний тест покаже слабкі теми і складе план по днях аж до екзамену. Лише для тренування, не для оцінюваних тестів у Moodle.')),
    exams.length
      ? h('ul', { class: 'exam-list' }, exams.map((ex) => h('li', {}, h('a', { class: 'exam-link', href: `#/prep/${ex.id}` },
        h('span', { class: 'num' }, fmtDate(ex.examAt)),
        h('div', {}, h('h3', {}, ex.title), ex.course ? h('div', { class: 'muted small' }, ex.course) : null),
        h('span', { class: `chip ${ex.examAt - Date.now() < 7 * 86_400_000 ? 'amber' : ''}` }, relative(ex.examAt))))))
      : h('div', { class: 'panel empty' }, 'Екзаменів поки немає.'),
    h('section', { class: 'panel spaced' }, h('h2', {}, 'Новий екзамен'), form),
  );
}

function questionForm(topic, reload) {
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      const options = form.options.value.split('\n').map((s) => s.trim()).filter(Boolean);
      const answerIndex = Number(form.correct.value) - 1;
      const ok = await act(() => api('POST', `/api/topics/${topic.id}/questions`, { prompt: form.prompt.value, options, answerIndex }));
      if (ok) reload();
    },
  },
  h('label', {}, 'Питання', h('textarea', { name: 'prompt', required: true, maxlength: 1000 })),
  h('div', { class: 'row' },
    h('label', { class: 'grow' }, 'Варіанти відповіді, кожен з нового рядка (від 2 до 6)', h('textarea', { name: 'options', required: true })),
    h('label', {}, '№ правильного', h('input', { name: 'correct', type: 'number', min: 1, max: 6, value: '1', required: true }))),
  h('button', { type: 'submit' }, 'Додати питання'));
  return h('details', {}, h('summary', {}, 'Додати питання'), form);
}

function problemForm(topic, reload) {
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      if (await act(() => api('POST', `/api/topics/${topic.id}/problems`, { text: form.text.value }))) reload();
    },
  },
  h('label', {}, 'Задача', h('textarea', { name: 'text', required: true, maxlength: 4000 })),
  h('button', { type: 'submit' }, 'Додати задачу'));
  return h('details', {}, h('summary', {}, 'Додати задачу'), form);
}

// Replaces a block with its edit form; Cancel reloads the page section.
function editButton(makeForm) {
  return h('button', {
    type: 'button', class: 'secondary small',
    onclick: (e) => {
      const block = e.currentTarget.closest('[data-edit]');
      block.replaceChildren(makeForm());
      block.querySelector('input, textarea')?.focus();
    },
  }, 'Змінити');
}

function topicBlock(topic, reload, topics) {
  const del = (path, what) => async () => {
    if (!confirm(`Видалити ${what}?`)) return;
    if (await act(() => api('DELETE', path))) reload();
  };
  const save = (path, body) => async (e) => {
    e.preventDefault();
    if (await act(() => api('PUT', path, body(formData(e.target))))) reload();
  };

  const renameForm = () => h('form', { class: 'edit-form', onsubmit: save(`/api/topics/${topic.id}`, (f) => ({ name: f.name })) },
    h('label', {}, 'Назва теми', h('input', { name: 'name', required: true, maxlength: 120, value: topic.name })),
    saveCancel(reload));

  const questionEdit = (q) => () => h('form', {
    class: 'edit-form',
    onsubmit: save(`/api/questions/${q.id}`, (f) => ({
      prompt: f.prompt,
      options: f.options.split('\n').map((s) => s.trim()).filter(Boolean),
      answerIndex: Number(f.correct) - 1,
      topicId: Number(f.topicId),
    })),
  },
  h('label', {}, 'Питання', h('textarea', { name: 'prompt', required: true, maxlength: 1000 }, q.prompt)),
  h('div', { class: 'row' },
    h('label', { class: 'grow' }, 'Варіанти відповіді, кожен з нового рядка (від 2 до 6)', h('textarea', { name: 'options', required: true }, q.options.join('\n'))),
    h('label', {}, '№ правильного', h('input', { name: 'correct', type: 'number', min: 1, max: 6, value: String(q.answerIndex + 1), required: true }))),
  h('label', {}, 'Тема', h('select', { name: 'topicId' },
    topics.map((t) => h('option', { value: String(t.id), selected: t.id === topic.id }, t.name)))),
  saveCancel(reload));

  const problemEdit = (p) => () => h('form', { class: 'edit-form', onsubmit: save(`/api/problems/${p.id}`, (f) => ({ text: f.text })) },
    h('label', {}, 'Задача', h('textarea', { name: 'text', required: true, maxlength: 4000 }, p.text)),
    saveCancel(reload));

  return h('div', { class: 'topic' },
    h('div', { class: 'head', 'data-edit': '' },
      h('h3', {}, topic.name),
      h('div', { class: 'tools' },
        h('span', { class: 'chip' }, plural(topic.questions.length, QUESTIONS)),
        h('span', { class: 'chip' }, plural(topic.problems.length, PROBLEMS)),
        editButton(renameForm),
        h('button', { type: 'button', class: 'danger small', onclick: del(`/api/topics/${topic.id}`, 'тему з усіма її питаннями') }, 'Видалити тему'))),
    // Collapsed, so the answers are not seen before taking the test.
    topic.questions.length ? h('details', { class: 'qlist' },
      h('summary', {}, `Показати питання й відповіді (${topic.questions.length})`),
      topic.questions.map((q) => h('div', { class: 'q', 'data-edit': '' },
        h('div', { class: 'head' }, h('span', { class: 'pre' }, q.prompt),
          h('div', { class: 'tools' },
            editButton(questionEdit(q)),
            h('button', { type: 'button', class: 'danger small', onclick: del(`/api/questions/${q.id}`, 'питання') }, 'Видалити'))),
        h('ol', {}, q.options.map((o, i) => h('li', { class: i === q.answerIndex ? 'correct' : '' }, o))),
        sourceLine(q)))) : null,
    topic.problems.map((p) => h('div', { class: 'q', 'data-edit': '' },
      h('div', { class: 'head' }, h('span', { class: 'pre' }, h('span', { class: 'kind' }, 'Задача'), p.text),
        h('div', { class: 'tools' },
          editButton(problemEdit(p)),
          h('button', { type: 'button', class: 'danger small', onclick: del(`/api/problems/${p.id}`, 'задачу') }, 'Видалити'))))),
    questionForm(topic, reload),
    problemForm(topic, reload));
}

// Where an AI-generated question comes from: the file, the slide and a short quote.
function sourceLine(q) {
  if (!q.source) return null;
  const { materialId, filename, slide, quote } = q.source;
  const where = `${filename}${slide ? `, слайд ${slide}` : ''}`;
  return h('p', { class: 'source muted small' },
    h('span', { class: 'tag' }, 'AI'), ' Джерело: ',
    materialId ? h('a', { href: `/api/materials/${materialId}` }, where) : where,
    quote ? `: «${quote}»` : '');
}

function aiBlock(exam, reload) {
  const readable = exam.materials.filter((m) => /\.(pdf|pptx|docx|txt|md)$/i.test(m.filename));
  let hint = `${exam.ai.label || 'AI'} читає завантажені слайди й пише стільки тренувальних питань, скільки попросите, розкладає їх за темами й позначає слайд, з якого взято кожне. Лише питання на застосування ідей до нових випадків, тож для оцінюваних тестів у Moodle вони не придатні.`;
  if (!exam.ai.enabled) hint = 'AI-питання на цьому сервері ще не налаштовані.';
  else if (!readable.length) hint = 'Спершу завантажте слайди лекцій нижче (PDF або PPTX).';
  const ready = exam.ai.enabled && readable.length > 0;
  const count = h('input', {
    type: 'number', name: 'count', min: 1, max: 30, value: '10', required: true, disabled: !ready,
    'aria-label': 'Скільки питань', class: 'count-input',
  });
  const button = h('button', { type: 'submit', class: 'secondary', disabled: !ready }, 'Згенерувати питання');
  const form = h('form', {
    class: 'generate-form',
    onsubmit: async (e) => {
      e.preventDefault();
      const n = Number(count.value);
      button.disabled = true;
      count.disabled = true;
      button.textContent = 'Генерую… (зазвичай до хвилини)';
      const r = await act(() => api('POST', `/api/exams/${exam.id}/generate`, { count: n }));
      if (r) {
        const skipped = r.skipped.map((s) => ` Пропущено ${s.filename}: ${s.reason}.`).join('');
        toast((r.added ? `Додано ${plural(r.added, QUESTIONS)} зі слайдів.` : 'Нових питань немає: у слайдах замало матеріалу.') + skipped, !r.added);
        reload();
      } else {
        button.disabled = false;
        count.disabled = false;
        button.textContent = 'Згенерувати питання';
      }
    },
  }, h('label', { class: 'inline' }, count, 'питань'), button);
  return h('section', { class: 'panel' },
    h('div', { class: 'head' }, h('h2', {}, 'Питання з ваших слайдів'), form),
    h('p', { class: 'muted small' }, hint));
}

// The native file input shows the browser's own language ("Choose files"); this wraps it in a Ukrainian label.
function filePicker(input, label = 'Вибрати файл') {
  input.classList.add('visually-hidden');
  const chosen = h('span', { class: 'muted small file-chosen' }, 'Файл не вибрано');
  input.addEventListener('change', () => {
    const names = [...input.files].map((f) => f.name);
    chosen.textContent = names.length ? names.join(', ') : 'Файл не вибрано';
  });
  return h('label', { class: 'file-pick' }, input, h('span', { class: 'file-button' }, label), chosen);
}

function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error(`Не вдалося прочитати ${file.name}`));
    reader.readAsDataURL(file);
  });
}

function materialsBlock(exam, reload) {
  const input = h('input', { type: 'file', multiple: true, accept: '.pdf,.ppt,.pptx,.doc,.docx,.txt,.md,image/*' });
  return h('section', { class: 'panel' },
    h('h2', {}, 'Слайди й матеріали'),
    exam.materials.length
      ? h('ul', { class: 'files' }, exam.materials.map((m) => h('li', {},
        h('a', { href: `/api/materials/${m.id}` }, m.filename),
        h('span', { class: 'muted small' }, fmtSize(m.size),
          h('button', {
            type: 'button', class: 'danger small',
            onclick: async () => {
              if (!confirm(`Видалити ${m.filename}?`)) return;
              if (await act(() => api('DELETE', `/api/materials/${m.id}`))) reload();
            },
          }, 'Видалити')))))
      : h('p', { class: 'muted' }, 'Тримайте слайди й задачники поруч з екзаменом (до 10 МБ на файл).'),
      exam.storage ? h('div', { class: 'storage' },
        h('p', { class: 'muted small' }, `Зайнято ${fmtSize(exam.storage.used)} з ${fmtSize(exam.storage.limit)} на всі ваші екзамени.`),
        bar(exam.storage.used / exam.storage.limit, exam.storage.used / exam.storage.limit > 0.9 ? 'weak' : '')) : null,
    h('div', { class: 'row' }, filePicker(input, 'Вибрати файли'), h('button', {
      type: 'button', class: 'secondary shrink',
      onclick: async (e) => {
        if (!input.files.length) return toast('Спершу виберіть файл', true);
        e.target.disabled = true;
        for (const file of input.files) {
          if (file.size > 10 * 1024 * 1024) { toast(`${file.name} більший за 10 МБ`, true); continue; }
          if (exam.storage && exam.storage.used + file.size > exam.storage.limit) { toast(`Для ${file.name} не вистачає місця: видаліть старі файли`, true); continue; }
          await act(async () => api('POST', `/api/exams/${exam.id}/materials`, { filename: file.name, data: await readAsBase64(file) }));
        }
        e.target.disabled = false;
        reload();
      },
    }, 'Завантажити')));
}

function resultBlock(exam) {
  if (!exam.result) return null;
  const byName = new Map(exam.topics.map((t) => [t.name, t]));
  const weak = exam.result.topics.filter((r) => r.status === 'weak');
  return h('section', { class: 'panel' },
    h('h2', {}, 'Результат діагностики'),
    h('p', { class: 'muted small' }, `Пройдено ${fmtDate(exam.result.takenAt)}`),
    h('div', { class: 'chips' }, exam.result.topics.map((r) => h('span', { class: `chip ${r.status}` },
      `${r.name}: ${r.total ? `${r.correct}/${r.total}` : 'немає питань'}, ${STATUS[r.status]}`))),
    weak.length
      ? h('div', {},
        h('h3', { class: 'spaced' }, 'Потренуйте ці теми'),
        weak.map((r) => {
          const problems = byName.get(r.name)?.problems || [];
          return h('div', { class: 'topic' },
            h('strong', {}, r.name),
            problems.length
              ? problems.map((p) => h('div', { class: 'q pre' }, p.text))
              : h('p', { class: 'muted small' }, 'Задач до цієї теми ще немає. Додайте їх вище.'));
        }))
      : h('p', { class: 'spaced' }, 'Слабких тем немає. Просто повторюйте.'));
}

// Progress over attempts: overall score per attempt, and each topic first vs. last.
function historyBlock(exam) {
  if (exam.history.length < 2) return null;
  const pct = (a) => (a.total ? Math.round((a.correct / a.total) * 100) : 0);
  const recent = exam.history.slice(-10);
  const first = exam.history[0];
  const last = exam.history.at(-1);
  const topicPct = (attempt, name) => {
    const t = attempt.topics.find((x) => x.name === name && x.total);
    return t ? Math.round((t.correct / t.total) * 100) : null;
  };
  const delta = (from, to) => {
    if (from === null || to === null) return 'немає';
    const d = to - from;
    return d > 0 ? `+${d}` : String(d);
  };
  return h('section', { class: 'panel' },
    h('h2', {}, 'Прогрес'),
    h('p', { class: 'muted small' }, `${plural(exam.history.length, ['спроба', 'спроби', 'спроб'])}: було ${pct(first)} %, зараз ${pct(last)} %.`),
    h('ol', { class: 'progress-chart', 'aria-label': 'Результати останніх спроб' },
      recent.map((a) => {
        const column = h('span', { class: `progress-bar ${pct(a) >= 70 ? 'good' : 'weak'}` });
        column.style.height = `${Math.max(4, pct(a))}%`;
        return h('li', { title: `${fmtDate(a.takenAt)}: ${a.correct}/${a.total}` },
          h('span', { class: 'progress-value num' }, `${pct(a)}%`),
          h('span', { class: 'progress-track' }, column),
          h('span', { class: 'progress-date small muted' }, new Date(a.takenAt).toLocaleDateString('uk-UA', { day: 'numeric', month: 'numeric' })));
      })),
    h('table', { class: 'plan progress-topics' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Тема'), h('th', {}, 'Перша'), h('th', {}, 'Остання'), h('th', {}, 'Зміна'))),
      h('tbody', {}, last.topics.filter((t) => t.total).map((t) => {
        const a = topicPct(first, t.name);
        const b = topicPct(last, t.name);
        const d = delta(a, b);
        return h('tr', {},
          h('td', {}, t.name),
          h('td', { class: 'num' }, a === null ? 'немає' : `${a}%`),
          h('td', { class: 'num' }, `${b}%`),
          h('td', { class: `num ${d.startsWith('+') ? 'up' : d.startsWith('-') ? 'down' : ''}` }, d));
      }))));
}

function planBlock(exam) {
  const today = todayStr();
  const label = { practice: 'Тренування (слабкі)', refresh: 'Повторення', review: 'Загальне повторення' };
  return h('section', { class: 'panel' },
    h('h2', {}, 'План по днях'),
    exam.plan.length
      ? h('table', { class: 'plan' },
        h('thead', {}, h('tr', {}, h('th', {}, 'День'), h('th', {}, 'Що робити'), h('th', {}, 'Теми'))),
        h('tbody', {}, exam.plan.map((d) => h('tr', { class: d.date === today ? 'today' : '' },
          h('td', {}, fmtDay(d.date)),
          h('td', {}, label[d.focus]),
          h('td', {}, d.focus === 'review' ? 'Усі теми, задачі впереміш' : d.topics.join(', '))))))
      : h('p', { class: 'muted' }, 'Екзамен сьогодні або вже минув.'),
    exam.result ? null : h('p', { class: 'muted small' }, 'Пройдіть діагностичний тест, щоб план поставив слабкі теми першими.'));
}

async function showExam(id) {
  const exam = await api('GET', `/api/exams/${id}`);
  const reload = () => render();
  const questionCount = exam.topics.reduce((n, t) => n + t.questions.length, 0);

  const topicForm = h('form', {
    class: 'row',
    onsubmit: async (e) => {
      e.preventDefault();
      if (await act(() => api('POST', `/api/exams/${id}/topics`, { name: e.target.name.value }))) reload();
    },
  }, h('label', { class: 'grow' }, 'Нова тема', h('input', { name: 'name', required: true, maxlength: 120, placeholder: 'напр. Границі' })),
  h('button', { type: 'submit', class: 'secondary shrink' }, 'Додати тему'));

  setView(
    h('a', { class: 'back', href: '#/prep' }, 'Усі екзамени'),
    h('div', { class: 'head page-head', 'data-edit': '' },
      h('div', {},
        exam.course ? h('p', { class: 'muted' }, exam.course) : null,
        h('h1', {}, exam.title),
        h('div', { class: 'exam-meta' },
          h('time', { class: 'num', datetime: new Date(exam.examAt).toISOString() }, fmtDate(exam.examAt)),
          h('span', { class: 'chip amber' }, relative(exam.examAt)))),
      h('div', { class: 'tools' }, 
        editButton(() => h('form', {
        class: 'edit-form grow',
        onsubmit: async (e) => {
          e.preventDefault();
          const f = formData(e.target);
          if (await act(() => api('PUT', `/api/exams/${id}`, { title: f.title, course: f.course, examAt: parseLocalInput(f.examAt) }))) reload();
        },
      },
      h('div', { class: 'row' },
        h('label', { class: 'grow' }, 'Екзамен', h('input', { name: 'title', required: true, maxlength: 200, value: exam.title })),
        h('label', {}, 'Курс', h('input', { name: 'course', maxlength: 100, value: exam.course }))),
      h('label', {}, 'Дата й час', h('input', { name: 'examAt', type: 'datetime-local', required: true, value: localInputValue(exam.examAt) })),saveCancel(reload))),
        h('button', {
        type: 'button', class: 'danger',
        onclick: async () => {
          if (!confirm(`Видалити екзамен «${exam.title}» з усіма темами й файлами?`)) return;
          if (await act(() => api('DELETE', `/api/exams/${id}`))) location.hash = '#/prep';
        },
      }, 'Видалити екзамен'))),
    h('section', { class: 'panel' },
      h('div', { class: 'head' },
        h('h2', {}, 'Діагностичний тест'),
        h('div', { class: 'tools' },
          exam.mistakes.length ? h('button', { type: 'button', class: 'secondary', onclick: () => showTest(exam, exam.mistakes) }, `Повторити помилки (${exam.mistakes.length})`) : null,
          h('button', { type: 'button', disabled: !questionCount, onclick: () => showTest(exam) }, exam.result ? 'Пройти ще раз' : 'Пройти тест'))),
      h('p', { class: 'muted small' }, questionCount
        ? `${plural(questionCount, QUESTIONS)} у ${plural(exam.topics.length, ['темі', 'темах', 'темах'])}. Від 70 % правильних тема вважається сильною.`
        : 'Додайте нижче теми й кілька питань, а потім пройдіть тест.')),
    resultBlock(exam),
    historyBlock(exam),
    planBlock(exam),
    aiBlock(exam, reload),
    h('section', { class: 'panel' },
      h('h2', {}, 'Теми й питання'),
      exam.topics.map((t) => topicBlock(t, reload, exam.topics)),
      h('div', { class: 'topic' }, topicForm)),
    materialsBlock(exam, reload),
  );
}

const LETTERS = 'ABCDEF';
const STATUS = { strong: 'сильна', weak: 'слабка', untested: 'не перевірена' };

function shuffled(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// A bar whose fill is set through the style property (inline style attributes are blocked by the CSP).
function bar(fraction, cls = '') {
  const fill = h('span', {});
  fill.style.transform = `scaleX(${Math.max(0, Math.min(1, fraction)).toFixed(3)})`;
  return h('div', { class: `bar ${cls}` }, fill);
}

// One option button; after answering, the right one turns green and a wrong pick red.
function optionButton(q, i, chosen, onPick) {
  const answered = chosen !== undefined;
  let state = '';
  if (answered && i === q.answerIndex) state = 'right';
  else if (answered && i === chosen) state = 'wrong';
  else if (answered) state = 'dim';
  return h('button', {
    type: 'button', class: `quiz-opt ${state}`, disabled: answered,
    'aria-pressed': String(i === chosen),
    onclick: () => onPick(i),
  },
  h('span', { class: 'letter' }, state === 'right' ? '✓' : state === 'wrong' ? '✗' : LETTERS[i]),
  h('span', { class: 'text' }, q.options[i]));
}

function sourceHint(source) {
  if (!source) return null;
  const where = `${source.filename}${source.slide ? `, слайд ${source.slide}` : ''}`;
  return h('p', { class: 'quiz-hint' }, h('span', { class: 'tag' }, 'З ваших слайдів'), ` ${where}`, source.quote ? `: «${source.quote}»` : '');
}

// The diagnostic test, one question at a time with instant feedback. Scored on the server at the end.
// only: question ids for a practice round on mistakes; it is not saved and does not change the diagnostic.
async function showTest(exam, only = null) {
  const { questions } = await api('GET', `/api/exams/${exam.id}/test`);
  const practice = Array.isArray(only);
  const order = shuffled(practice ? questions.filter((q) => only.includes(q.id)) : questions);
  const answers = {};
  let index = 0;
  const root = h('div', { class: 'quiz' });
  const correctCount = () => order.filter((q) => answers[q.id] === q.answerIndex).length;
  const answeredCount = () => Object.keys(answers).length;
  const backToExam = () => { location.hash = `#/prep/${exam.id}`; render(); };

  function pick(i) {
    const q = order[index];
    if (q.id in answers) return;
    answers[q.id] = i;
    draw();
    root.querySelector('.quiz-next')?.focus();
  }

  function next() {
    index++;
    if (index < order.length) draw(); else finish();
  }

  function onKey(e) {
    if (!document.body.contains(root)) { document.removeEventListener('keydown', onKey); return; }
    const q = order[index];
    if (!q || e.metaKey || e.ctrlKey || e.altKey) return;
    if (!(q.id in answers)) {
      let n = '123456'.indexOf(e.key);
      if (n < 0 && e.key.length === 1) n = 'abcdef'.indexOf(e.key.toLowerCase());
      if (n >= 0 && n < q.options.length) { e.preventDefault(); pick(n); }
    } else if (e.key === 'Enter' || e.key === 'ArrowRight') {
      e.preventDefault();
      next();
    }
  }
  document.addEventListener('keydown', onKey);

  function draw() {
    const q = order[index];
    const chosen = answers[q.id];
    const answered = chosen !== undefined;
    const right = correctCount();
    const last = index === order.length - 1;
    root.replaceChildren(
      h('div', { class: 'quiz-top' },
        h('span', { class: 'num' }, `Питання ${index + 1} з ${order.length}`),
        h('span', { class: 'quiz-tally' },
          h('span', { class: 'ok', title: 'Правильно' }, `✓ ${right}`),
          h('span', { class: 'bad', title: 'Неправильно' }, `✗ ${answeredCount() - right}`))),
      bar((index + (answered ? 1 : 0)) / order.length, 'quiz-progress'),
      h('div', { class: 'quiz-card' },
        h('span', { class: 'chip' }, q.topic),
        h('p', { class: 'quiz-prompt pre' }, q.prompt),
        h('div', { class: 'quiz-options', role: 'group', 'aria-label': 'Варіанти відповіді' },
          q.options.map((_, i) => optionButton(q, i, chosen, pick))),
        answered
          ? h('div', { class: `quiz-feedback ${chosen === q.answerIndex ? 'ok' : 'bad'}`, role: 'status' },
            h('strong', {}, chosen === q.answerIndex ? 'Правильно!' : 'Не зовсім.'),
            chosen === q.answerIndex ? null : ` Правильна відповідь ${LETTERS[q.answerIndex]}: ${q.options[q.answerIndex]}`,
            sourceHint(q.source))
          : h('p', { class: 'muted small quiz-keys' }, 'Виберіть відповідь або натисніть клавішу від 1 до ', String(q.options.length), '.')),
      h('div', { class: 'quiz-actions' },
        h('button', {
          type: 'button', class: 'link',
          onclick: () => { if (!answeredCount() || confirm('Вийти з тесту? Відповіді не збережуться.')) backToExam(); },
        }, 'Вийти'),
        answered ? h('button', { type: 'button', class: 'quiz-next', onclick: next }, last ? 'Результати' : 'Наступне питання') : null));
  }

  async function finish() {
    const detail = practice ? null : await act(() => api('POST', `/api/exams/${exam.id}/test`, { answers }));
    const right = correctCount();
    const pct = order.length ? Math.round((right / order.length) * 100) : 0;
    const mistakes = order.filter((q) => answers[q.id] !== q.answerIndex);
    const topics = detail?.result?.topics || [];
    // h() skips null children, replaceChildren() would print "null": go through a wrapper.
    root.replaceChildren(...h('div', {},
      h('div', { class: 'quiz-card quiz-summary' },
        h('p', { class: 'muted' }, 'Ваш результат'),
        h('p', { class: 'score-big num' }, `${right} / ${order.length}`),
        h('p', { class: 'muted' }, `${pct} % правильних${detail || practice ? '' : ' (не збережено, спробуйте ще раз)'}`),
        practice ? h('p', { class: 'muted small' }, 'Тренування на помилках не змінює результат діагностики.') : null,
        bar(right / (order.length || 1), pct >= 70 ? 'good' : 'weak')),
      topics.length ? h('section', { class: 'quiz-topics' },
        h('h2', {}, 'За темами'),
        topics.filter((t) => t.total).map((t) => h('div', { class: 'quiz-topic' },
          h('div', { class: 'quiz-topic-head' },
            h('span', {}, t.name),
            h('span', { class: `chip ${t.status}` }, `${t.correct} з ${t.total}, ${STATUS[t.status]}`)),
          bar(t.correct / t.total, t.status === 'strong' ? 'good' : 'weak')))) : null,
      mistakes.length ? h('section', { class: 'quiz-review' },
        h('h2', {}, `Розбір помилок (${mistakes.length})`),
        mistakes.map((q) => h('div', { class: 'quiz-card' },
          h('span', { class: 'chip' }, q.topic),
          h('p', { class: 'quiz-prompt pre' }, q.prompt),
          h('div', { class: 'quiz-options' }, q.options.map((_, i) => optionButton(q, i, answers[q.id] ?? -1, () => {}))),
          answers[q.id] === undefined ? h('p', { class: 'muted small' }, 'Без відповіді.') : null,
          sourceHint(q.source)))) : h('p', { class: 'quiz-perfect' }, 'Жодної помилки.'),
      h('div', { class: 'quiz-actions' },
        mistakes.length ? h('button', { type: 'button', class: 'secondary', onclick: () => showTest(exam, mistakes.map((q) => q.id)) }, `Повторити помилки (${mistakes.length})`) : null,
        practice ? null : h('button', { type: 'button', class: 'secondary', onclick: () => showTest(exam) }, 'Пройти ще раз'),
        h('button', { type: 'button', onclick: backToExam }, 'До плану підготовки'))).childNodes);
    window.scrollTo(0, 0);
  }

  setView(
    h('a', { class: 'back', href: `#/prep/${exam.id}` }, exam.title),
    h('div', { class: 'page-head' },
      h('h1', {}, practice ? 'Робота над помилками' : 'Діагностичний тест'),
      h('p', { class: 'muted' }, practice
        ? 'Лише питання, на які ви відповіли неправильно. Результат не зберігається.'
        : 'Відповідайте чесно: мета в тому, щоб знайти, чого ви ще не знаєте.')),
    root);
  if (order.length) draw();
  else root.replaceChildren(h('p', { class: 'muted' }, 'У цього екзамену ще немає питань.'));
  window.scrollTo(0, 0);
}

// ---------- start ----------

(async () => {
  try { await refreshMe(); } catch { me = null; }
  render();
})();

// Install as an app and open offline. Not on plain http hosts other than localhost (browsers refuse there anyway).
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('Service worker:', err.message));
}
window.addEventListener('online', () => { if (me) render(); });
