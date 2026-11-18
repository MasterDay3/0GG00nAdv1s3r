// Login, registration and password reset, with the guest page around them.
import { api, forgetSavedData, formData, h, request, setView, toast } from './core.js';
import { refreshMe, render } from './router.js';

export function showAuth() {
  let mode = 'login';
  const error = h('p', { class: 'small', role: 'alert' });
  const submit = h('button', { type: 'submit' }, 'Увійти');
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      error.textContent = '';
      try {
        await api('POST', mode === 'login' ? '/api/login' : '/api/register', formData(form));
        forgetSavedData();
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

  // The Telegram button appears once the server says which bot it is.
  const tgSlot = h('div', { class: 'landing-tg' });
  request('GET', '/api/public').then(({ bot }) => {
    if (!bot) return;
    tgSlot.replaceChildren(h('a', {
      class: 'button secondary', href: `https://t.me/${encodeURIComponent(bot)}`, target: '_blank', rel: 'noopener noreferrer',
    }, `Бот у Telegram: @${bot}`));
  }).catch(() => {});

  setView(h('div', { class: 'landing' },
    h('section', { class: 'landing-intro' },
      h('img', { src: '/favicon.svg', alt: '', width: 72, height: 72, class: 'landing-logo' }),
      h('h1', {}, 'Dueboard'),
      h('p', { class: 'tagline' }, 'Усі дедлайни курсів в одному списку і помічник для підготовки до екзамену.'),
      h('ul', { class: 'landing-points' },
        h('li', {}, 'Дедлайни з Moodle і з чатів групи разом'),
        h('li', {}, 'Нагадування в Telegram, поки ще не пізно'),
        h('li', {}, 'AI-тест з ваших слайдів показує слабкі теми')),
      tgSlot),
    h('div', { class: 'auth' },
      h('div', { class: 'panel' }, h('div', { class: 'tabs' }, tabs), form, h('p', { class: 'auth-foot' }, forgot),
        h('p', { class: 'auth-privacy muted small' }, 'Що ми зберігаємо і як усе видалити: ', h('a', { href: '#/privacy' }, 'конфіденційність'), '.')))));
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
          forgetSavedData();
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
