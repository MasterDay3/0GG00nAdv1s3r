// Dueboard Prep: the paywall, the demo checkout and the package in Settings.
import { act, api, appState, h, request, setView } from './core.js';
import { refreshMe, render, stale } from './router.js';

export const needsPremium = () => Boolean(appState.me?.premium?.required && !appState.me.premium.active);
const fmtDay2 = (ms) => new Date(ms).toLocaleDateString('uk-UA', { day: 'numeric', month: 'long', year: 'numeric' });
const PREP_FEATURES = [
  ['AI-тест з ваших слайдів', 'Питання тільки з ваших матеріалів, біля кожного видно слайд, з якого воно взяте.'],
  ['Діагностика слабких тем', 'Тест показує, які теми ви знаєте, а які варто підтягнути.'],
  ['План по днях до екзамену', 'Слабкі теми першими, повторення перед екзаменом.'],
  ['Пояснення помилок', 'Після неправильної відповіді видно, чому правильна саме вона.'],
];

// The exam prep section for a student without the package: what it gives and the way to get it.
export function showPaywall() {
  setView(
    h('div', { class: 'page-head' },
      h('h1', {}, 'Підготовка до екзаменів'),
      h('p', { class: 'muted' }, 'Входить у Dueboard Prep. Дошка дедлайнів, нагадування в Telegram і синхронізація з Moodle лишаються безкоштовними.')),
    h('section', { class: 'panel plan-card' },
      h('div', { class: 'plan-head' },
        h('div', {}, h('p', { class: 'plan-name' }, 'Dueboard Prep'), h('p', { class: 'muted small' }, 'Усе для тижня перед екзаменом')),
        h('p', { class: 'plan-price' }, h('span', { class: 'num' }, String(appState.me.premium.price)), ' грн', h('span', { class: 'muted small' }, ` / ${appState.me.premium.days} днів`))),
      h('ul', { class: 'plan-features' }, PREP_FEATURES.map(([title, text]) => h('li', {}, h('strong', {}, title), h('span', { class: 'muted small' }, text)))),
      h('div', { class: 'row plan-actions' },
        h('a', { class: 'button primary', href: '#/pay' }, `Оформити за ${appState.me.premium.price} грн`),
        h('span', { class: 'muted small' }, 'Без автоматичного продовження: через 30 днів просто оформіть знову.')),
      appState.me.premium.until ? h('p', { class: 'muted small' }, `Попередній пакет діяв до ${fmtDay2(appState.me.premium.until)}`) : null));
}

// Test cards of the demo checkout. The page turns a typed number into one of these names; the number itself never leaves it.
const DEMO_CARDS = [
  { number: '4242 4242 4242 4242', card: 'success', label: 'Успішна оплата' },
  { number: '4000 0000 0000 0002', card: 'declined', label: 'Банк відхиляє' },
  { number: '4000 0000 0000 9995', card: 'funds', label: 'Недостатньо коштів' },
];
const digitsOnly = (v) => v.replace(/\D/g, '');

export async function showCheckout(seq) {
  if (!appState.me.premium?.required) { location.hash = '#/prep'; return; }
  const order = await api('POST', '/api/payments', {});
  if (stale(seq)) return;
  const number = h('input', { name: 'number', inputmode: 'numeric', autocomplete: 'off', placeholder: '4242 4242 4242 4242', maxlength: 19, required: true });
  const expiry = h('input', { name: 'expiry', inputmode: 'numeric', autocomplete: 'off', placeholder: 'ММ/РР', maxlength: 5, required: true });
  const cvc = h('input', { name: 'cvc', inputmode: 'numeric', autocomplete: 'off', placeholder: '123', maxlength: 3, required: true });
  const error = h('p', { class: 'pay-error', role: 'alert', hidden: true });
  number.addEventListener('input', () => { number.value = digitsOnly(number.value).slice(0, 16).replace(/(\d{4})(?=\d)/g, '$1 '); });
  expiry.addEventListener('input', () => { const d = digitsOnly(expiry.value).slice(0, 4); expiry.value = d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d; });
  cvc.addEventListener('input', () => { cvc.value = digitsOnly(cvc.value).slice(0, 3); });
  const nextYear = String((new Date().getFullYear() + 1) % 100).padStart(2, '0');
  const useCard = (c) => { number.value = c.number; expiry.value = `12/${nextYear}`; cvc.value = '123'; error.hidden = true; number.focus(); };

  const fail = (text) => { error.textContent = text; error.hidden = false; };
  let paying = false;
  const submit = h('button', { type: 'submit', class: 'pay-submit' }, `Сплатити ${order.amount} грн`);
  const form = h('form', {
    class: 'pay-form', novalidate: true,
    onsubmit: async (e) => {
      e.preventDefault();
      // The pause below runs before any request, so the shared form lock would let a second click through.
      if (paying) return;
      error.hidden = true;
      const test = DEMO_CARDS.find((c) => digitsOnly(c.number) === digitsOnly(number.value));
      if (!test) return fail('Це демо-оплата: введіть одну з тестових карток нижче. Справжні картки тут не приймаються.');
      const [mm, yy] = expiry.value.split('/').map(Number);
      const expired = !mm || mm > 12 || yy === undefined || new Date(2000 + yy, mm) <= new Date();
      if (expired) return fail('Перевірте строк дії картки: ММ/РР, не в минулому.');
      if (cvc.value.length !== 3) return fail('CVC — три цифри зі звороту картки.');
      paying = true;
      submit.disabled = true;
      submit.textContent = 'Обробляємо платіж…';
      form.classList.add('busy');
      await new Promise((r) => setTimeout(r, 1200)); // the pause a real bank takes, so the flow reads as one
      const result = await act(() => api('POST', `/api/payments/${order.id}/pay`, { card: test.card }));
      if (!result) { paying = false; submit.disabled = false; submit.textContent = `Сплатити ${order.amount} грн`; form.classList.remove('busy'); return; }
      await refreshMe();
      showPaymentResult(result);
    },
  },
  h('label', {}, 'Номер картки', number),
  h('div', { class: 'row' }, h('label', {}, 'Строк дії', expiry), h('label', {}, 'CVC', cvc)),
  error,
  submit,
  h('div', { class: 'demo-cards' },
    h('p', { class: 'muted small' }, 'Тестові картки. Строк дії будь-який у майбутньому, CVC будь-які 3 цифри.'),
    DEMO_CARDS.map((c) => h('button', { type: 'button', class: 'demo-card', onclick: () => useCard(c) },
      h('span', { class: 'num' }, c.number), h('span', { class: 'muted small' }, c.label)))));

  setView(
    h('a', { class: 'back', href: '#/prep' }, 'Назад'),
    h('div', { class: 'page-head' }, h('h1', {}, 'Оплата')),
    h('p', { class: 'demo-banner', role: 'note' }, h('strong', {}, 'Демо-режим. '), 'Гроші не списуються, це показ того, як працюватиме оплата. Не вводьте справжню картку.'),
    h('div', { class: 'pay-layout' },
      h('section', { class: 'panel pay-summary' },
        h('p', { class: 'muted small' }, `Замовлення ${order.orderRef}`),
        h('p', { class: 'plan-name' }, 'Dueboard Prep'),
        h('p', { class: 'muted' }, `Підготовка до екзаменів на ${appState.me.premium.days} днів`),
        h('dl', { class: 'pay-lines' },
          h('div', {}, h('dt', {}, 'Діятиме до'), h('dd', {}, fmtDay2(Math.max(Date.now(), appState.me.premium.until || 0) + appState.me.premium.days * 86_400_000))),
          h('div', { class: 'total' }, h('dt', {}, 'До сплати'), h('dd', { class: 'num' }, `${order.amount} грн`)))),
      h('section', { class: 'panel' }, form)));
  number.focus();
}

function showPaymentResult(p) {
  const ok = p.status === 'paid';
  setView(
    h('section', { class: `panel pay-result ${ok ? 'ok' : 'bad'}`, role: 'status' },
      h('div', { class: 'pay-mark', 'aria-hidden': 'true' }, ok ? '✓' : '✗'),
      h('h1', {}, ok ? 'Оплату прийнято' : 'Оплата не пройшла'),
      h('p', { class: 'muted' }, ok ? `Dueboard Prep активний до ${fmtDay2(p.activeUntil)}` : p.reason),
      h('dl', { class: 'pay-lines' },
        h('div', {}, h('dt', {}, 'Замовлення'), h('dd', { class: 'num' }, p.orderRef)),
        h('div', {}, h('dt', {}, 'Картка'), h('dd', { class: 'num' }, `•••• ${p.cardLast4}`)),
        h('div', {}, h('dt', {}, 'Сума'), h('dd', { class: 'num' }, `${p.amount} грн`))),
      h('div', { class: 'row pay-result-actions' },
        ok ? h('a', { class: 'button primary', href: '#/prep' }, 'До підготовки') : h('a', { class: 'button primary', href: '#/pay', onclick: (e) => { e.preventDefault(); if (location.hash === '#/pay') render(); else location.hash = '#/pay'; } }, 'Спробувати ще раз'),
        h('a', { class: 'button secondary', href: '#/settings' }, 'Історія оплат'))));
  window.scrollTo(0, 0);
}

// Settings: the package's state, how to get or extend it, and past payments.
export function subscriptionCard() {
  const box = h('div', {},
    appState.me.premium.active
      ? h('p', {}, h('span', { class: 'status-ok' }, 'Активний'), ` до ${fmtDay2(appState.me.premium.until)}; продовження додасть ще ${appState.me.premium.days} днів до цієї дати.`)
      : h('p', {}, `Не активний. ${appState.me.premium.price} грн на ${appState.me.premium.days} днів відкривають підготовку до екзаменів.`),
    h('a', { class: 'button secondary', href: '#/pay' }, appState.me.premium.active ? 'Продовжити' : `Оформити за ${appState.me.premium.price} грн`));
  const history = h('div', {});
  request('GET', '/api/payments').then((list) => {
    const done = list.filter((p) => p.status !== 'pending');
    if (!done.length) return;
    history.replaceChildren(h('details', {}, h('summary', {}, `Історія оплат (${done.length})`),
      h('ul', { class: 'pay-history' }, done.map((p) => h('li', {},
        h('span', { class: 'num' }, new Date(p.paidAt || p.createdAt).toLocaleDateString('uk-UA')),
        h('span', {}, `${p.amount} грн · •••• ${p.cardLast4}`),
        h('span', { class: `chip ${p.status === 'paid' ? 'strong' : 'weak'}` }, p.status === 'paid' ? 'оплачено' : 'відхилено'))))));
  }).catch(() => {});
  return [box, history];
}
