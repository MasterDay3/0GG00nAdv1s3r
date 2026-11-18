// The deadline board.
import { act, api, appState, dateOf, fmtDate, fmtDay, formData, h, localInputValue, parseLocalInput, relative, safeHref, setView, toast, todayStr } from './core.js';
import { syncMoodle } from './extension.js';
import { refreshMe, render, stale } from './router.js';

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
      item.canEdit ? h('button', {
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

export function saveCancel(onCancel) {
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
    appState.me.group
      ? h('label', { class: 'inline' }, h('input', { type: 'checkbox', name: 'shared' }), `Поділитися з групою (${appState.me.group.name})`)
      : h('span', { class: 'muted small' }, 'Приєднайтеся до групи в Налаштуваннях, щоб ділитися дедлайнами з одногрупниками.'),
    h('button', { type: 'submit', class: 'shrink' }, 'Додати дедлайн')));
  return h('details', { class: 'panel compact add-deadline' }, h('summary', {}, 'Додати дедлайн, якого немає в Moodle'), form);
}

export async function showBoard(seq) {
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

  const syncButton = appState.me.icsUrl ? h('button', {
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

  const syncWarning = appState.me.syncError ? h('div', { class: 'panel warning', role: 'alert' },
    h('strong', {}, 'Дедлайни з Moodle не оновлюються. '), appState.me.syncError.replace(/[.!]?$/, '. '),
    h('a', { href: '#/settings' }, 'Перевірити посилання')) : null;

  if (stale(seq)) return;
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
          appState.me.icsUrl ? null : h('a', { href: '#/settings' }, 'Під’єднати Moodle'),
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
