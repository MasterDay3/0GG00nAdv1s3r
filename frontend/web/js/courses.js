// The course field: full course names suggested and guessed from the exam name; the exam theme field.
import { h } from './core.js';

// Words that say what kind of exam it is, not which course.
const EXAM_WORDS = new Set(['екзамен', 'іспит', 'залік', 'підсумковий', 'підсумкова', 'проміжний', 'проміжна', 'фінальний', 'модуль',
  'контрольна', 'тест', 'колоквіум', 'exam', 'final', 'midterm', 'test', 'quiz']);
const SMALL_WORDS = new Set(['та', 'і', 'й', 'в', 'у', 'з', 'до', 'на', 'and', 'of', 'the', 'in']);
const words = (s) => (s.toLowerCase().replace(/[ʼ'’`]/g, '').match(/[\p{L}\p{N}]+/gu) || []);

// Does one word of the exam name point to this course? Handles "алгоритми", "матан"/"матаналіз" and "ООП".
function wordMatchesCourse(word, raw, courseWords) {
  const long = courseWords.filter((w) => w.length >= 3 && !SMALL_WORDS.has(w));
  if (word.length >= 3 && long.some((w) => w.startsWith(word.slice(0, 5)) || word.startsWith(w.slice(0, 5)))) return true;
  // Glued abbreviations: "матаналіз" = "мат" + "аналіз" from two words that follow each other.
  for (let i = 3; i <= word.length - 3; i++) {
    const [left, right] = [word.slice(0, i), word.slice(i)];
    for (let k = 0; k < long.length - 1; k++) {
      if (long[k].startsWith(left) && long[k + 1].startsWith(right.slice(0, 4))) return true;
    }
  }
  // Abbreviations: "ООП", "ТЙМС", typed in capitals or not ("асд" is "АСД").
  if (/^\p{L}{2,6}$/u.test(raw) && !SMALL_WORDS.has(word)) {
    const initials = long.map((w) => w[0]).join('');
    if (initials.startsWith(word)) return true;
  }
  return false;
}

// The full course name the exam title most likely belongs to, or '' when no single course stands out.
function guessCourse(title, courses) {
  const raws = (title.replace(/[ʼ'’`]/g, '').match(/[\p{L}\p{N}]+/gu) || []).filter((w) => !EXAM_WORDS.has(w.toLowerCase()));
  if (!raws.length) return '';
  const scored = courses.map((course) => {
    const courseWords = words(course);
    return { course, score: raws.filter((raw) => wordMatchesCourse(raw.toLowerCase(), raw, courseWords)).length };
  }).filter((c) => c.score > 0).sort((a, b) => b.score - a.score);
  if (!scored.length || scored[1]?.score === scored[0].score) return '';
  return scored[0].course;
}

// Course input with the student's full course names as suggestions; fills itself from the exam name until the student types in it.
// Course names compared the way a student types them: any case, any apostrophe, words in any order and anywhere.
const courseKey = (s) => s.toLowerCase().replace(/[ʼ'’`ʹ]/g, '').replace(/\s+/g, ' ').trim();
function matchCourses(query, courses) {
  const parts = courseKey(query).split(' ').filter(Boolean);
  if (!parts.length) return courses;
  return courses.filter((c) => parts.every((p) => courseKey(c).includes(p)));
}

// Our own suggestion list instead of <datalist>: Safari filters a datalist case-sensitively and only from the start.
function courseSuggestions(input, courses) {
  const list = h('div', { class: 'course-suggest', role: 'listbox', hidden: true });
  let items = [];
  let active = -1;
  const choose = (c) => {
    input.value = c;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    close();
  };
  const close = () => { list.hidden = true; active = -1; };
  const show = () => {
    items = matchCourses(input.value, courses).filter((c) => c !== input.value).slice(0, 8);
    active = -1;
    list.replaceChildren(...items.map((c, i) => h('button', {
      type: 'button', class: 'course-suggest-item', role: 'option', tabindex: '-1',
      onmousedown: (e) => e.preventDefault(), // keep the focus in the field, so blur does not close the list first
      onclick: () => choose(c), 'data-i': String(i),
    }, c)));
    list.hidden = !items.length;
  };
  const mark = () => list.querySelectorAll('.course-suggest-item').forEach((b, i) => b.classList.toggle('active', i === active));
  input.addEventListener('focus', show);
  input.addEventListener('input', (e) => { if (e.isTrusted) show(); });
  input.addEventListener('blur', close);
  input.addEventListener('keydown', (e) => {
    if (list.hidden) { if (e.key === 'ArrowDown') { show(); e.preventDefault(); } return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      mark();
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      choose(items[active]);
    } else if (e.key === 'Escape') {
      close();
    }
  });
  return list;
}

export function courseField(titleInput, courses, value = '') {
  const input = h('input', { name: 'course', maxlength: 100, value, autocomplete: 'off', placeholder: courses.length ? 'почніть вводити або оберіть' : '' });
  const hint = h('span', { class: 'muted small', hidden: true }, 'Підказано за назвою екзамену, можна змінити');
  let guessed = value ? null : '';
  titleInput.addEventListener('input', () => {
    if (guessed === null || input.value !== guessed) return;
    guessed = guessCourse(titleInput.value, courses);
    input.value = guessed;
    hint.hidden = !guessed;
  });
  input.addEventListener('input', () => { guessed = null; hint.hidden = true; });
  return h('label', { class: 'course-field' }, 'Курс', input, courseSuggestions(input, courses), hint);
}

export function themeField(value = '') {
  return h('label', {}, 'Тема екзамену (необов’язково)',
    h('textarea', { name: 'theme', maxlength: 1000, rows: 2, value, placeholder: 'напр. Ряди, визначені інтеграли, диференціальні рівняння' }),
    h('span', { class: 'muted small' }, 'Що буде на екзамені. AI складатиме питання саме з цього.'));
}
