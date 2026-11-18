// The diagnostic test and practice on mistakes, with AI explanations.
import { act, api, appState, h, request, setView } from './core.js';
import { render, setHashQuietly, stale } from './router.js';

const LETTERS = 'ABCDEF';
export const STATUS = { strong: 'сильна', weak: 'слабка', untested: 'не перевірена' };

function shuffled(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// A bar whose fill is set through the style property (inline style attributes are blocked by the CSP).
export function bar(fraction, cls = '') {
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

// "Why": the question's explanation, or one the AI writes the first time someone gets it wrong (then it is kept).
const explaining = new Map();
// Background requests (request, not api) so a slow AI answer never keeps a form locked; two at a time, the rest wait.
let explainSlots = 2;
const explainWaiting = [];
async function explainOne(id) {
  if (explainSlots > 0) explainSlots--; else await new Promise((resolve) => explainWaiting.push(resolve));
  try {
    return await request('POST', `/api/questions/${id}/explain`, {});
  } finally {
    const next = explainWaiting.shift();
    if (next) next(); else explainSlots++;
  }
}
function whyBox(q, aiEnabled) {
  const box = h('div', { class: 'quiz-why', 'aria-live': 'polite' });
  const show = (text) => box.replaceChildren(h('strong', {}, 'Чому так: '), text);
  if (q.explanation) { show(q.explanation); return box; }
  if (!aiEnabled) return null;
  box.replaceChildren(h('span', { class: 'muted' }, 'Готую пояснення…'));
  if (!explaining.has(q.id)) {
    explaining.set(q.id, explainOne(q.id)
      .then((r) => { q.explanation = r.explanation; return r.explanation; })
      .finally(() => explaining.delete(q.id)));
  }
  explaining.get(q.id).then(show, () => box.replaceChildren(h('span', { class: 'muted' }, 'Пояснення зараз недоступне. Спробуйте пізніше.')));
  return box;
}

// The diagnostic test, one question at a time with instant feedback. Scored on the server at the end.
// only: question ids for a practice round on mistakes; it is not saved and does not change the diagnostic.
export async function showTest(exam, only = null) {
  const seq = ++appState.renderSeq;
  const { questions } = await api('GET', `/api/exams/${exam.id}/test`);
  const practice = Array.isArray(only);
  const order = shuffled(practice ? questions.filter((q) => only.includes(q.id)) : questions);
  const answers = {};
  let index = 0;
  const root = h('div', { class: 'quiz' });
  const correctCount = () => order.filter((q) => answers[q.id] === q.answerIndex).length;
  const answeredCount = () => Object.keys(answers).length;
  let finished = false;
  const backToExam = () => {
    appState.leaveGuard = null;
    if (location.hash === `#/prep/${exam.id}`) render(); else location.hash = `#/prep/${exam.id}`;
  };

  function pick(i) {
    const q = order[index];
    if (q.id in answers) return;
    answers[q.id] = i;
    draw();
    root.querySelector('.quiz-next')?.focus();
  }

  let finishing = false;
  function next() {
    if (finishing) return;
    index++;
    if (index < order.length) return draw();
    // Saving takes a moment: a second click must not save the attempt twice.
    finishing = true;
    for (const b of root.querySelectorAll('button')) b.disabled = true;
    finish();
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
            chosen === q.answerIndex ? null : whyBox(q, exam.ai?.enabled),
            sourceHint(q.source))
          : h('p', { class: 'muted small quiz-keys' }, 'Виберіть відповідь або натисніть клавішу від 1 до ', String(q.options.length), '.')),
      h('div', { class: 'quiz-actions' },
        h('button', {
          type: 'button', class: 'link',
          onclick: () => { if (appState.leaveGuard()) backToExam(); },
        }, 'Вийти'),
        answered ? h('button', { type: 'button', class: 'quiz-next', onclick: next }, last ? 'Результати' : 'Наступне питання') : null));
  }

  async function finish() {
    finished = true;
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
          whyBox(q, exam.ai?.enabled),
          sourceHint(q.source)))) : h('p', { class: 'quiz-perfect' }, 'Жодної помилки.'),
      h('div', { class: 'quiz-actions' },
        mistakes.length ? h('button', { type: 'button', class: 'secondary', onclick: () => act(() => showTest(exam, mistakes.map((q) => q.id))) }, `Повторити помилки (${mistakes.length})`) : null,
        practice ? null : h('button', { type: 'button', class: 'secondary', onclick: () => act(() => showTest(exam)) }, 'Пройти ще раз'),
        h('button', { type: 'button', onclick: backToExam }, 'До плану підготовки'))).childNodes);
    window.scrollTo(0, 0);
  }

  if (stale(seq)) return;
  setView(
    h('a', { class: 'back', href: `#/prep/${exam.id}` }, exam.title),
    h('div', { class: 'page-head' },
      h('h1', {}, practice ? 'Робота над помилками' : 'Діагностичний тест'),
      h('p', { class: 'muted' }, practice
        ? 'Лише питання, на які ви відповіли неправильно. Результат не зберігається.'
        : 'Відповідайте чесно: мета в тому, щоб знайти, чого ви ще не знаєте.')),
    root);
  // The test has its own address, so Back leaves it through the guard instead of silently.
  appState.guardHash = `#/prep/${exam.id}/test`;
  setHashQuietly(appState.guardHash);
  // quiet: the browser asks on its own when the tab closes; a confirm() is not allowed there.
  appState.leaveGuard = (quiet) => finished || !answeredCount() || (!quiet && confirm('Вийти з тесту? Відповіді не збережуться.'));
  if (order.length) draw();
  else root.replaceChildren(h('p', { class: 'muted' }, 'У цього екзамену ще немає питань.'));
  window.scrollTo(0, 0);
}
