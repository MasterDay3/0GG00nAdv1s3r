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

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : null;
  if (!res.ok) {
    if (res.status === 401 && me) { me = null; render(); }
    throw new Error(data?.error || `Request failed (${res.status})`);
  }
  return data;
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
  return new Date(ms).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function fmtDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

function relative(ms, now = Date.now()) {
  const diff = ms - now;
  const abs = Math.abs(diff);
  const hours = Math.floor(abs / 3_600_000);
  const days = Math.floor(hours / 24);
  let span;
  if (abs < 3_600_000) span = `${Math.max(1, Math.round(abs / 60_000))} min`;
  else if (days < 2) span = `${hours} h`;
  else span = `${days} d${hours % 24 ? ` ${hours % 24} h` : ''}`;
  return diff < 0 ? `${span} ago` : `in ${span}`;
}

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function todayStr() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function setView(...nodes) {
  main.replaceChildren(...nodes.filter(Boolean));
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
    if (me) setView(h('div', { class: 'card' }, h('p', {}, err.message), h('a', { href: '#/board' }, 'Back to board')));
  }
}

window.addEventListener('hashchange', render);
document.getElementById('logout').addEventListener('click', async () => {
  await act(() => api('POST', '/api/logout', {}));
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
  const submit = h('button', { type: 'submit' }, 'Log in');
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
  h('label', {}, 'Username', h('input', { name: 'username', autocomplete: 'username', required: true })),
  h('label', {}, 'Password', h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true, minlength: 8 })),
  error,
  submit);

  const tabs = ['login', 'register'].map((m) => h('button', {
    type: 'button',
    class: m === mode ? '' : 'secondary',
    onclick: () => {
      mode = m;
      submit.textContent = m === 'login' ? 'Log in' : 'Create account';
      form.password.autocomplete = m === 'login' ? 'current-password' : 'new-password';
      tabs.forEach((t, i) => { t.className = ['login', 'register'][i] === m ? '' : 'secondary'; });
    },
  }, m === 'login' ? 'Log in' : 'Sign up'));

  setView(h('div', { class: 'auth' },
    h('h1', {}, 'Dueboard'),
    h('p', { class: 'tagline' }, 'Every course deadline in one list, and a study coach for the week before the exam.'),
    h('div', { class: 'card' }, h('div', { class: 'tabs' }, tabs), form)));
}

// ---------- board ----------

const SOURCE_LABEL = { moodle: 'Moodle', personal: 'Personal', group: 'Group', exam: 'Exam' };

function noteEditor(item, onSaved) {
  const box = h('div', { class: 'note' });
  const showText = () => {
    box.replaceChildren(...[
      item.note ? h('p', { class: 'note-text' }, item.note) : null,
      h('button', { type: 'button', class: 'link small', onclick: edit }, item.note ? 'Edit note' : '+ Add note'),
    ].filter(Boolean));
  };
  function edit() {
    const area = h('textarea', { maxlength: 2000, 'aria-label': `Note for ${item.title}` });
    area.value = item.note;
    box.replaceChildren(area, h('div', { class: 'row' },
      h('button', {
        type: 'button', class: 'shrink',
        onclick: async () => {
          const saved = await act(() => api('PUT', '/api/notes', { key: item.key, text: area.value }));
          if (saved) { item.note = area.value.trim(); onSaved?.(); showText(); }
        },
      }, 'Save note'),
      h('button', { type: 'button', class: 'secondary shrink', onclick: showText }, 'Cancel')));
    area.focus();
  }
  showText();
  return box;
}

function deadlineRow(item, now, reload) {
  const href = safeHref(item.url);
  const titleNode = item.source === 'exam'
    ? h('a', { href: `#/prep/${item.id}`, class: 'title' }, `Exam: ${item.title}`)
    : href ? h('a', { href, class: 'title', target: '_blank', rel: 'noopener noreferrer' }, item.title)
      : h('span', { class: 'title' }, item.title);
  return h('div', { class: `item ${item.urgency}` },
    h('div', { class: 'bar', 'aria-hidden': 'true' }),
    h('div', {},
      h('div', { class: 'meta' }, item.course ? h('strong', {}, item.course) : null, h('span', { class: 'badge' }, SOURCE_LABEL[item.source])),
      titleNode),
    h('div', { class: 'when' },
      h('strong', {}, item.urgency === 'overdue' ? 'Past due' : relative(item.dueAt, now)),
      h('span', { class: 'muted' }, fmtDate(item.dueAt)),
      item.canDelete ? h('div', {}, h('button', {
        type: 'button', class: 'danger small',
        onclick: async () => {
          if (!confirm(`Delete "${item.title}"?`)) return;
          if (await act(() => api('DELETE', `/api/deadlines/${item.id}`), 'Deleted')) reload();
        },
      }, 'Delete')) : null),
    noteEditor(item));
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
      }), f.shared === 'on' ? 'Added for your whole group' : 'Deadline added');
      if (ok) reload();
    },
  },
  h('div', { class: 'row' },
    h('label', { class: 'grow' }, 'What is due', h('input', { name: 'title', required: true, maxlength: 200, placeholder: 'e.g. Essay announced in class' })),
    h('label', {}, 'Course', h('input', { name: 'course', maxlength: 100 }))),
  h('div', { class: 'row' },
    h('label', {}, 'Due', h('input', { name: 'dueAt', type: 'datetime-local', required: true, value: localInputValue(defaultDue.getTime()) })),
    h('label', { class: 'grow' }, 'Link (optional)', h('input', { name: 'url', type: 'url', placeholder: 'https://' }))),
  h('div', { class: 'row' },
    me.group
      ? h('label', { class: 'inline' }, h('input', { type: 'checkbox', name: 'shared' }), `Share with my group (${me.group.name})`)
      : h('span', { class: 'muted small' }, 'Join a group in Settings to share deadlines with classmates.'),
    h('button', { type: 'submit', class: 'shrink' }, 'Add deadline')));
  return h('details', { class: 'card' }, h('summary', {}, '+ Add a deadline that is not in Moodle'), h('div', { class: 'spacer' }), form);
}

async function showBoard() {
  const [{ items, now }] = await Promise.all([api('GET', '/api/deadlines'), refreshMe()]);
  const showPast = sessionStorageGet('showPast') === '1';
  const upcoming = items.filter((i) => i.urgency !== 'overdue');
  const past = items.filter((i) => i.urgency === 'overdue');
  const counts = { red: 0, amber: 0 };
  for (const i of upcoming) if (i.urgency in counts) counts[i.urgency]++;

  const pastToggle = h('label', { class: 'inline small' },
    h('input', {
      type: 'checkbox', checked: showPast,
      onchange: (e) => { sessionStorageSet('showPast', e.target.checked ? '1' : '0'); render(); },
    }), `Show past (${past.length})`);

  const list = [...(showPast ? past : []), ...upcoming];
  setView(
    h('div', { class: 'toolbar' },
      h('div', {},
        h('h1', {}, 'Your deadlines'),
        h('p', { class: 'muted' },
          `${counts.red} due within 48 h · ${counts.amber} this week`,
          me.icsUrl ? null : [' · ', h('a', { href: '#/settings' }, 'Connect Moodle')])),
      h('div', { class: 'row' },
        me.icsUrl ? h('button', {
          type: 'button', class: 'secondary shrink',
          onclick: async (e) => {
            e.target.disabled = true;
            const r = await act(() => api('POST', '/api/sync', {}));
            e.target.disabled = false;
            if (r) { toast(`Synced ${r.imported} Moodle events`); render(); }
          },
        }, 'Sync Moodle') : null,
        pastToggle)),
    addDeadlineForm(render),
    list.length
      ? h('div', { class: 'list' }, list.map((item) => deadlineRow(item, now, render)))
      : h('div', { class: 'card empty' },
        h('p', {}, 'No deadlines yet.'),
        h('p', {}, h('a', { href: '#/settings' }, 'Connect your Moodle calendar'), ' or add one above.')),
  );
}

function sessionStorageGet(key) {
  try { return sessionStorage.getItem(key); } catch { return null; }
}
function sessionStorageSet(key, value) {
  try { sessionStorage.setItem(key, value); } catch { /* storage unavailable */ }
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
      if (!saved.icsUrl) { toast('Moodle link removed'); return render(); }
      const r = await act(() => api('POST', '/api/sync', {}));
      if (r) { toast(`Connected — imported ${r.imported} Moodle events`); return render(); }
      // Sync failed (e.g. a bot check in front of Moodle): offer the file import right here.
      importBox.open = true;
      importBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
    },
  },
  h('label', {}, 'Moodle calendar link',
    h('input', { name: 'icsUrl', type: 'text', value: me.icsUrl, placeholder: 'https://moodle.ucu.edu.ua/calendar/export_execute.php?…' })),
  h('div', { class: 'row' },
    h('span', { class: 'muted small' }, me.lastSyncAt ? `Last synced ${fmtDate(me.lastSyncAt)}. Re-syncs every 6 hours.` : 'Not synced yet.'),
    h('button', { type: 'submit', class: 'shrink' }, 'Save & sync')));

  const pasteForm = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      const file = pasteForm.file.files[0];
      const ics = file ? await file.text() : pasteForm.ics.value;
      const r = await act(() => api('POST', '/api/import-ics', { ics }));
      if (r) { toast(`Imported ${r.imported} events`); pasteForm.reset(); }
    },
  },
  h('label', {}, '.ics file', h('input', { name: 'file', type: 'file', accept: '.ics,text/calendar' })),
  h('label', {}, '…or paste its contents', h('textarea', { name: 'ics', placeholder: 'BEGIN:VCALENDAR…' })),
  h('button', { type: 'submit' }, 'Import'));

  const importBox = h('details', {},
    h('summary', {}, 'Import an .ics file instead'),
    h('p', { class: 'muted small spaced' }, 'In Moodle: Calendar → Import or export calendars → Export calendar → "Export". Upload the downloaded file here. Re-import it whenever you want to refresh.'),
    pasteForm);

  const groupCard = me.group
    ? h('div', {},
      h('p', {}, 'You are in ', h('strong', {}, me.group.name), '. Classmates join with this code:'),
      h('p', { class: 'code' }, me.group.code),
      h('button', {
        type: 'button', class: 'secondary',
        onclick: async () => {
          if (!confirm('Leave the group? You will stop seeing its shared deadlines.')) return;
          if (await act(() => api('POST', '/api/group/leave', {}), 'Left the group')) render();
        },
      }, 'Leave group'))
    : h('div', {},
      h('form', {
        class: 'row',
        onsubmit: async (e) => {
          e.preventDefault();
          if (await act(() => api('POST', '/api/group/join', formData(e.target)), 'Joined the group')) render();
        },
      }, h('label', {}, 'Join with a code', h('input', { name: 'code', required: true, maxlength: 16 })), h('button', { type: 'submit', class: 'shrink' }, 'Join')),
      h('form', {
        class: 'row',
        onsubmit: async (e) => {
          e.preventDefault();
          if (await act(() => api('POST', '/api/group', formData(e.target)), 'Group created')) render();
        },
      }, h('label', {}, '…or create one', h('input', { name: 'name', required: true, maxlength: 80, placeholder: 'e.g. CS-2, 2nd year' })), h('button', { type: 'submit', class: 'shrink secondary' }, 'Create')));

  const tgBox = h('div', {});
  const renderTelegram = () => {
    if (!me.telegram.enabled) {
      tgBox.replaceChildren(h('p', { class: 'muted' }, 'The Telegram bot is off on this server. Start it with TELEGRAM_BOT_TOKEN set to turn on reminders.'));
    } else if (me.telegram.linked) {
      tgBox.replaceChildren(
        h('p', {}, '✅ Linked. Reminders arrive 3 days and 1 day before each deadline.'),
        h('button', {
          type: 'button', class: 'secondary',
          onclick: async () => { if (await act(() => api('DELETE', '/api/telegram'), 'Telegram unlinked')) render(); },
        }, 'Unlink'));
    } else {
      tgBox.replaceChildren(
        h('p', {}, 'Get reminders 3 days and 1 day before each deadline.'),
        h('button', {
          type: 'button',
          onclick: async () => {
            const r = await act(() => api('POST', '/api/telegram/link', {}));
            if (!r) return;
            const deepLink = `https://t.me/${encodeURIComponent(r.botName)}?start=${r.code}`;
            tgBox.replaceChildren(
              h('p', {}, 'Open ', h('a', { href: deepLink, target: '_blank', rel: 'noopener noreferrer' }, `@${r.botName}`), ' and press Start, or send it:'),
              h('p', { class: 'code' }, `/start ${r.code}`),
              h('button', { type: 'button', class: 'secondary', onclick: render }, 'I did it — refresh'));
          },
        }, 'Connect Telegram'));
    }
  };
  renderTelegram();

  setView(
    h('h1', {}, 'Settings'),
    h('p', { class: 'muted' }, `Signed in as ${me.username}`),
    h('section', { class: 'card' },
      h('h2', {}, 'Connect Moodle'),
      h('p', { class: 'muted small' }, 'In Moodle open Calendar → Import or export calendars → Export calendar, choose "All events" and "Recent and next 60 days", then "Get calendar URL". It is a read-only link: no password, no full-access token.'),
      moodleForm),
    h('section', { class: 'card' }, h('h2', {}, 'Your group'), groupCard),
    h('section', { class: 'card' }, h('h2', {}, 'Telegram reminders'), tgBox),
    h('section', { class: 'card' }, importBox));
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
    h('label', { class: 'grow' }, 'Exam', h('input', { name: 'title', required: true, maxlength: 200, placeholder: 'e.g. Calculus final' })),
    h('label', {}, 'Course', h('input', { name: 'course', maxlength: 100 }))),
  h('div', { class: 'row' },
    h('label', {}, 'Date & time', h('input', { name: 'examAt', type: 'datetime-local', required: true })),
    h('button', { type: 'submit', class: 'shrink' }, 'Add exam')));

  setView(
    h('h1', {}, 'Exam prep'),
    h('p', { class: 'muted' }, 'Add your exam, its topics and some questions. A diagnostic test shows your weak topics and builds a day-by-day plan up to the exam. Practice only — never for graded Moodle quizzes.'),
    h('section', { class: 'card' }, h('h2', {}, 'New exam'), form),
    exams.length
      ? h('div', { class: 'list' }, exams.map((ex) => h('a', { class: 'card exam-link', href: `#/prep/${ex.id}` },
        h('div', {}, h('div', { class: 'muted small' }, ex.course || ' '), h('h3', {}, ex.title)),
        h('div', { class: 'when' }, h('strong', {}, relative(ex.examAt)), h('span', { class: 'muted' }, fmtDate(ex.examAt))))))
      : h('div', { class: 'card empty' }, 'No exams yet.'),
  );
}

function questionForm(topic, reload) {
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      const options = form.options.value.split('\n').map((s) => s.trim()).filter(Boolean);
      const answerIndex = Number(form.correct.value) - 1;
      const ok = await act(() => api('POST', `/api/topics/${topic.id}/questions`, { prompt: form.prompt.value, options, answerIndex }), 'Question added');
      if (ok) reload();
    },
  },
  h('label', {}, 'Question', h('textarea', { name: 'prompt', required: true, maxlength: 1000 })),
  h('div', { class: 'row' },
    h('label', { class: 'grow' }, 'Answer options, one per line (2–6)', h('textarea', { name: 'options', required: true })),
    h('label', {}, 'Correct option #', h('input', { name: 'correct', type: 'number', min: 1, max: 6, value: '1', required: true }))),
  h('button', { type: 'submit' }, 'Add question'));
  return h('details', {}, h('summary', {}, '+ Add a question'), form);
}

function problemForm(topic, reload) {
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      if (await act(() => api('POST', `/api/topics/${topic.id}/problems`, { text: form.text.value }), 'Practice problem added')) reload();
    },
  },
  h('label', {}, 'Practice problem', h('textarea', { name: 'text', required: true, maxlength: 4000 })),
  h('button', { type: 'submit' }, 'Add problem'));
  return h('details', {}, h('summary', {}, '+ Add a practice problem'), form);
}

function topicBlock(topic, reload) {
  const del = (path, what) => async () => {
    if (!confirm(`Delete this ${what}?`)) return;
    if (await act(() => api('DELETE', path), 'Deleted')) reload();
  };
  return h('div', { class: 'topic' },
    h('div', { class: 'head' },
      h('h3', {}, topic.name),
      h('span', { class: 'muted small' }, `${plural(topic.questions.length, 'question')} · ${plural(topic.problems.length, 'problem')}`,
        h('button', { type: 'button', class: 'danger small', onclick: del(`/api/topics/${topic.id}`, 'topic and all its questions') }, 'Delete topic'))),
    topic.questions.map((q) => h('div', { class: 'q' },
      h('div', { class: 'head' }, h('span', { class: 'pre' }, q.prompt),
        h('button', { type: 'button', class: 'danger small', onclick: del(`/api/questions/${q.id}`, 'question') }, 'Delete')),
      h('ol', {}, q.options.map((o, i) => h('li', { class: i === q.answerIndex ? 'correct' : '' }, o))))),
    topic.problems.map((p) => h('div', { class: 'q' },
      h('div', { class: 'head' }, h('span', { class: 'pre' }, `📝 ${p.text}`),
        h('button', { type: 'button', class: 'danger small', onclick: del(`/api/problems/${p.id}`, 'problem') }, 'Delete')))),
    questionForm(topic, reload),
    problemForm(topic, reload));
}

function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

function materialsBlock(exam, reload) {
  const input = h('input', { type: 'file', multiple: true, accept: '.pdf,.ppt,.pptx,.doc,.docx,.txt,.md,image/*' });
  return h('section', { class: 'card' },
    h('h2', {}, 'Lecture slides & materials'),
    exam.materials.length
      ? h('ul', { class: 'files' }, exam.materials.map((m) => h('li', {},
        h('a', { href: `/api/materials/${m.id}` }, m.filename),
        h('span', { class: 'muted small' }, fmtSize(m.size),
          h('button', {
            type: 'button', class: 'danger small',
            onclick: async () => {
              if (!confirm(`Delete ${m.filename}?`)) return;
              if (await act(() => api('DELETE', `/api/materials/${m.id}`), 'Deleted')) reload();
            },
          }, 'Delete')))))
      : h('p', { class: 'muted' }, 'Keep your slides and problem sets next to the exam. (Up to 10 MB per file.)'),
    h('div', { class: 'row' }, input, h('button', {
      type: 'button', class: 'shrink',
      onclick: async (e) => {
        if (!input.files.length) return toast('Choose a file first', true);
        e.target.disabled = true;
        for (const file of input.files) {
          if (file.size > 10 * 1024 * 1024) { toast(`${file.name} is over 10 MB`, true); continue; }
          await act(async () => api('POST', `/api/exams/${exam.id}/materials`, { filename: file.name, data: await readAsBase64(file) }));
        }
        e.target.disabled = false;
        reload();
      },
    }, 'Upload')));
}

function resultBlock(exam) {
  if (!exam.result) return null;
  const byName = new Map(exam.topics.map((t) => [t.name, t]));
  const weak = exam.result.topics.filter((r) => r.status === 'weak');
  return h('section', { class: 'card' },
    h('h2', {}, 'Diagnostic result'),
    h('p', { class: 'muted small' }, `Taken ${fmtDate(exam.result.takenAt)}`),
    h('div', { class: 'chips' }, exam.result.topics.map((r) => h('span', { class: `chip ${r.status}` },
      `${r.name}: ${r.total ? `${r.correct}/${r.total}` : 'no questions'} · ${r.status}`))),
    weak.length
      ? h('div', {},
        h('h3', { class: 'spaced' }, 'Practise these'),
        weak.map((r) => {
          const problems = byName.get(r.name)?.problems || [];
          return h('div', { class: 'topic' },
            h('strong', {}, r.name),
            problems.length
              ? problems.map((p) => h('div', { class: 'q pre' }, p.text))
              : h('p', { class: 'muted small' }, 'No practice problems for this topic yet — add some above.'));
        }))
      : h('p', {}, '🎉 No weak topics. Keep refreshing.'));
}

function planBlock(exam) {
  const today = todayStr();
  const label = { practice: 'Practise (weak)', refresh: 'Refresh', review: 'Full review' };
  return h('section', { class: 'card' },
    h('h2', {}, 'Day-by-day plan'),
    exam.plan.length
      ? h('table', { class: 'plan' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Day'), h('th', {}, 'Focus'), h('th', {}, 'Topics'))),
        h('tbody', {}, exam.plan.map((d) => h('tr', { class: d.date === today ? 'today' : '' },
          h('td', {}, fmtDay(d.date)),
          h('td', {}, label[d.focus]),
          h('td', {}, d.focus === 'review' ? 'All topics, mixed practice problems' : d.topics.join(', '))))))
      : h('p', { class: 'muted' }, 'The exam is today or already passed.'),
    exam.result ? null : h('p', { class: 'muted small' }, 'Take the diagnostic test so the plan puts your weak topics first.'));
}

async function showExam(id) {
  const exam = await api('GET', `/api/exams/${id}`);
  const reload = () => render();
  const questionCount = exam.topics.reduce((n, t) => n + t.questions.length, 0);

  const topicForm = h('form', {
    class: 'row',
    onsubmit: async (e) => {
      e.preventDefault();
      if (await act(() => api('POST', `/api/exams/${id}/topics`, { name: e.target.name.value }), 'Topic added')) reload();
    },
  }, h('label', { class: 'grow' }, 'New topic', h('input', { name: 'name', required: true, maxlength: 120, placeholder: 'e.g. Limits' })),
  h('button', { type: 'submit', class: 'shrink' }, 'Add topic'));

  setView(
    h('p', {}, h('a', { href: '#/prep' }, '← All exams')),
    h('div', { class: 'head' },
      h('div', {},
        h('div', { class: 'muted' }, exam.course),
        h('h1', {}, exam.title),
        h('p', {}, `${fmtDate(exam.examAt)} · ${relative(exam.examAt)}`)),
      h('button', {
        type: 'button', class: 'danger',
        onclick: async () => {
          if (!confirm(`Delete the exam "${exam.title}" with all its topics and files?`)) return;
          if (await act(() => api('DELETE', `/api/exams/${id}`), 'Exam deleted')) location.hash = '#/prep';
        },
      }, 'Delete exam')),
    h('section', { class: 'card' },
      h('div', { class: 'head' },
        h('h2', {}, 'Diagnostic test'),
        h('button', { type: 'button', disabled: !questionCount, onclick: () => showTest(exam) }, exam.result ? 'Retake test' : 'Take the test')),
      h('p', { class: 'muted small' }, questionCount
        ? `${questionCount} questions across ${exam.topics.length} topics. 70% or more on a topic counts as strong.`
        : 'Add topics and a few questions below, then take the test.')),
    resultBlock(exam),
    planBlock(exam),
    h('section', { class: 'card' },
      h('h2', {}, 'Topics & questions'),
      exam.topics.map((t) => topicBlock(t, reload)),
      h('div', { class: 'topic' }, topicForm)),
    materialsBlock(exam, reload),
  );
}

async function showTest(exam) {
  const { questions } = await api('GET', `/api/exams/${exam.id}/test`);
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      const answers = {};
      for (const q of questions) {
        const picked = form.querySelector(`input[name="q${q.id}"]:checked`);
        if (picked) answers[q.id] = Number(picked.value);
      }
      const unanswered = questions.length - Object.keys(answers).length;
      if (unanswered && !confirm(`${unanswered} question(s) unanswered — they count as wrong. Submit anyway?`)) return;
      if (await act(() => api('POST', `/api/exams/${exam.id}/test`, { answers }), 'Test scored')) render();
    },
  },
  questions.map((q, n) => h('div', { class: 'test-q' },
    h('fieldset', {},
      h('legend', {}, `${n + 1}. ${q.topic}`),
      h('p', { class: 'pre' }, q.prompt),
      q.options.map((o, i) => h('label', { class: 'inline' }, h('input', { type: 'radio', name: `q${q.id}`, value: String(i) }), o))))),
  h('div', { class: 'row' },
    h('button', { type: 'submit', class: 'shrink' }, 'Submit answers'),
    h('button', { type: 'button', class: 'secondary shrink', onclick: render }, 'Cancel')));

  setView(
    h('p', {}, h('a', { href: `#/prep/${exam.id}`, onclick: (e) => { e.preventDefault(); render(); } }, `← ${exam.title}`)),
    h('h1', {}, 'Diagnostic test'),
    h('p', { class: 'muted' }, 'Answer honestly — the goal is to find what you do not know yet.'),
    h('section', { class: 'card' }, form));
  window.scrollTo(0, 0);
}

// ---------- start ----------

(async () => {
  try { await refreshMe(); } catch { me = null; }
  render();
})();
