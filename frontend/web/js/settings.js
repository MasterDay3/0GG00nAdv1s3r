// Settings: Moodle, extension, group, Telegram, calendar feed, import, account.
import { act, api, appState, fmtDate, forgetSavedData, formData, h, setView, toast } from './core.js';
import { extensionCard, syncMoodle } from './extension.js';
import { subscriptionCard } from './payments.js';
import { filePicker } from './prep.js';
import { refreshMe, render, stale } from './router.js';

export async function showSettings(seq) {
  await refreshMe();

  const moodleForm = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      const saved = await act(() => api('PUT', '/api/settings', { icsUrl: moodleForm.icsUrl.value }));
      if (!saved) return;
      appState.me = saved;
      if (!saved.icsUrl) { toast('Посилання на Moodle видалено'); return render(); }
      const r = await act(syncMoodle);
      if (r) { toast(`Збережено, синхронізовано подій Moodle: ${r.imported}`); return render(); }
      // Sync failed (e.g. a bot check in front of Moodle): point to the extension.
      extensionSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
    },
  },
  h('label', {}, 'Посилання на календар Moodle',
    h('input', { name: 'icsUrl', type: 'text', value: appState.me.icsUrl, placeholder: 'https://learn.ucu.edu.ua/calendar/export_execute.php?…' })),
  h('div', { class: 'row' },
    h('span', { class: 'muted small' }, appState.me.lastSyncAt ? `Остання синхронізація: ${fmtDate(appState.me.lastSyncAt)}.` : 'Ще не синхронізовано.',
      appState.me.syncError ? h('span', { class: 'sync-error' }, ` Остання спроба не вдалася: ${appState.me.syncError}`) : null),
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

  const groupCard = appState.me.group
    ? h('div', {},
      h('p', {}, 'Ви в групі ', h('strong', {}, appState.me.group.name), '. Одногрупники приєднуються з цим кодом:'),
      h('p', { class: 'code' }, appState.me.group.code),
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
    if (!appState.me.telegram.enabled) {
      tgBox.replaceChildren(h('p', { class: 'muted small' }, 'Telegram-бот на цьому сервері вимкнений. Щоб увімкнути нагадування, запустіть сервер із TELEGRAM_BOT_TOKEN.'));
    } else if (appState.me.telegram.linked) {
      tgBox.replaceChildren(
        h('p', {}, h('span', { class: 'status-ok' }, 'Прив’язано'), ' Бот нагадує про кожен дедлайн, а зранку надсилає дайджест: що здавати цього тижня і що вчити сьогодні.'),
        reminderChoice(),
        h('p', { class: 'muted' }, 'Перешліть боту повідомлення з дедлайном (наприклад, з чату групи), і він запропонує додати його на дошку. Команди бота: /deadlines показує дедлайни, /digest вмикає чи вимикає дайджест, /stop відв’язує чат.'),
        h('button', {
          type: 'button', class: 'secondary',
          onclick: async () => { if (await act(() => api('DELETE', '/api/telegram'))) render(); },
        }, 'Відв’язати'));
    } else {
      tgBox.replaceChildren(
        h('p', {}, 'Отримуйте нагадування про дедлайни в Telegram: за замовчуванням за 3 дні й за 1 день, час можна змінити після під’єднання.'),
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

  if (stale(seq)) return;
  setView(
    h('div', { class: 'page-head' },
      h('h1', {}, 'Налаштування'),
      h('p', { class: 'muted' }, 'Ви ввійшли як ', h('strong', {}, appState.me.username))),
    setting('Під’єднати Moodle',
      h('p', { class: 'muted small' }, 'У Moodle відкрийте Календар → Імпорт або експорт календарів → Експорт календаря, виберіть «Усі події» та «Нещодавні й наступні 60 днів», потім «Отримати URL календаря». Це посилання лише для читання: без пароля й без повного доступу.'),
      moodleForm),
    extensionSection,
    setting('Ваша група', groupCard),
    setting('Нагадування в Telegram', tgBox),
    setting('Google чи Apple Календар', calendarCard()),
    setting('Імпорт файлу', importBox),
    appState.me.premium?.required ? setting('Dueboard Prep', subscriptionCard()) : null,
    setting('Акаунт', accountCard()));
}

// The board as a calendar feed: the secret link is shown once, right after it is made.
// When the Telegram reminders come; saved on every change.
function reminderChoice() {
  const options = [['3d', 'За 3 дні'], ['1d', 'За 1 день'], ['3h', 'За 3 години']];
  const boxes = options.map(([kind, label]) => h('label', { class: 'inline' },
    h('input', {
      type: 'checkbox', value: kind, checked: appState.me.telegram.reminders.includes(kind),
      onchange: async () => {
        const kinds = boxes.filter((b) => b.querySelector('input').checked).map((b) => b.querySelector('input').value);
        const r = await act(() => api('PUT', '/api/telegram/reminders', { kinds }), kinds.length ? 'Збережено' : 'Нагадування вимкнено, дайджест лишається');
        if (r) appState.me.telegram.reminders = r.reminders;
        // Not saved: show what is really set.
        for (const b of boxes) { const input = b.querySelector('input'); input.checked = appState.me.telegram.reminders.includes(input.value); }
      },
    }), label));
  return h('fieldset', { class: 'reminder-choice' }, h('legend', { class: 'small muted' }, 'Коли нагадувати'), boxes);
}

function calendarCard() {
  const box = h('div', {});
  const intro = h('p', { class: 'muted small' }, 'Дедлайни й екзамени з’являться у вашому календарі на телефоні й оновлюватимуться самі. Виконані зникають. Google оновлює підписані календарі раз на кілька годин.');

  const create = async () => {
    if (appState.me.calendarFeed && !confirm('Створити нове посилання? Старе перестане працювати, і календар, підписаний на нього, перестане оновлюватися.')) return;
    const r = await act(() => api('POST', '/api/calendar-feed', {}));
    if (!r) return;
    appState.me.calendarFeed = true;
    showLink(`${location.origin}${r.path}`);
  };
  const turnOff = async () => {
    if (!confirm('Вимкнути посилання? Календарі, підписані на нього, перестануть оновлюватися.')) return;
    if (await act(() => api('DELETE', '/api/calendar-feed'))) { appState.me.calendarFeed = false; draw(); }
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
    box.replaceChildren(intro, appState.me.calendarFeed
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
    if (res.status === 401) { appState.me = null; forgetSavedData(); render(); }
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
  const signedOut = () => { appState.me = null; forgetSavedData(); location.hash = '#/board'; render(); };

  const passwordForm = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      const f = formData(passwordForm);
      if (await act(() => api('PUT', '/api/password', { current: f.current, password: f.password }), 'Пароль змінено. Інші пристрої вийшли з акаунта.')) passwordForm.reset();
    },
  },
  h('input', { type: 'text', name: 'username', autocomplete: 'username', value: appState.me.username, hidden: true }),
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
    h('label', { class: 'grow' }, `Введіть свій логін (${appState.me.username})`, h('input', { name: 'confirm', required: true, autocomplete: 'off' })),
    h('label', { class: 'grow' }, 'Пароль', h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true }))),
  h('button', { type: 'submit', class: 'danger' }, 'Видалити акаунт'));

  return [
    h('p', { class: 'muted small' }, 'Що Dueboard зберігає, кому передає і як усе видалити: ', h('a', { href: '#/privacy' }, 'конфіденційність'), '.'),
    h('div', { class: 'export' },
      h('button', { type: 'button', class: 'secondary', onclick: downloadExport }, 'Завантажити всі мої дані'),
      h('p', { class: 'muted small' }, 'Дедлайни, нотатки, екзамени, питання й результати тестів одним файлом JSON.')),
    h('details', {}, h('summary', {}, 'Змінити пароль'), passwordForm),
    h('details', {},
      h('summary', {}, 'Вийти на всіх пристроях'),
      h('p', { class: 'muted small spaced' }, 'Знадобиться, якщо ви входили на чужому комп’ютері. Вийде й цей браузер.'),
      h('button', {
        type: 'button', class: 'secondary',
        onclick: async () => { if (await act(() => api('POST', '/api/logout-all', {}), 'Ви вийшли на всіх пристроях')) signedOut(); },
      }, 'Вийти всюди')),
    h('details', {}, h('summary', {}, 'Видалити акаунт'), deleteForm),
    appState.me.telegram.linked ? null : h('p', { class: 'muted small spaced' }, 'Порада: прив’яжіть Telegram, щоб мати змогу відновити пароль, якщо забудете.'),
  ];
}
