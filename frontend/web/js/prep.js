// Exam prep: the list of exams and one exam with its topics, questions, materials, results and plan.
import { saveCancel } from './board.js';
import { PROBLEMS, QUESTIONS, act, api, fmtDate, fmtDay, fmtSize, formData, h, localInputValue, parseLocalInput, plural, relative, setView, toast, todayStr } from './core.js';
import { courseField, themeField } from './courses.js';
import { render, stale } from './router.js';
import { STATUS, bar, showTest } from './quiz.js';

export async function showPrep(seq) {
  const [exams, courses] = await Promise.all([api('GET', '/api/exams'), api('GET', '/api/courses')]);
  const titleInput = h('input', { name: 'title', required: true, maxlength: 200, placeholder: 'напр. Матаналіз, підсумковий' });
  const form = h('form', {
    class: 'stack',
    onsubmit: async (e) => {
      e.preventDefault();
      const f = formData(form);
      const r = await act(() => api('POST', '/api/exams', { title: f.title, course: f.course, theme: f.theme, examAt: parseLocalInput(f.examAt) }));
      if (r) location.hash = `#/prep/${r.id}`;
    },
  },
  h('div', { class: 'row' },
    h('label', { class: 'grow' }, 'Екзамен', titleInput),
    courseField(titleInput, courses)),
  themeField(),
  h('div', { class: 'row' },
    h('label', {}, 'Дата й час', h('input', { name: 'examAt', type: 'datetime-local', required: true })),
    h('button', { type: 'submit', class: 'shrink' }, 'Додати екзамен')));

  if (stale(seq)) return;
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
      const ok = await act(() => api('POST', `/api/topics/${topic.id}/questions`, {
        prompt: form.prompt.value, options, answerIndex, explanation: form.explanation.value,
      }));
      if (ok) reload();
    },
  },
  h('label', {}, 'Питання', h('textarea', { name: 'prompt', required: true, maxlength: 1000 })),
  h('div', { class: 'row' },
    h('label', { class: 'grow' }, 'Варіанти відповіді, кожен з нового рядка (від 2 до 6)', h('textarea', { name: 'options', required: true })),
    h('label', {}, '№ правильного', h('input', { name: 'correct', type: 'number', min: 1, max: 6, value: '1', required: true }))),
  explanationField(''),
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
      explanation: f.explanation,
      topicId: Number(f.topicId),
    })),
  },
  h('label', {}, 'Питання', h('textarea', { name: 'prompt', required: true, maxlength: 1000 }, q.prompt)),
  h('div', { class: 'row' },
    h('label', { class: 'grow' }, 'Варіанти відповіді, кожен з нового рядка (від 2 до 6)', h('textarea', { name: 'options', required: true }, q.options.join('\n'))),
    h('label', {}, '№ правильного', h('input', { name: 'correct', type: 'number', min: 1, max: 6, value: String(q.answerIndex + 1), required: true }))),
  explanationField(q.explanation),
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
        sourceLine(q),
        q.explanation ? h('p', { class: 'muted small why-line' }, h('strong', {}, 'Чому так: '), q.explanation) : null))) : null,
    topic.problems.map((p) => h('div', { class: 'q', 'data-edit': '' },
      h('div', { class: 'head' }, h('span', { class: 'pre' }, h('span', { class: 'kind' }, 'Задача'), p.text),
        h('div', { class: 'tools' },
          editButton(problemEdit(p)),
          h('button', { type: 'button', class: 'danger small', onclick: del(`/api/problems/${p.id}`, 'задачу') }, 'Видалити'))))),
    questionForm(topic, reload),
    problemForm(topic, reload));
}

// Where an AI-generated question comes from: the file, the slide and a short quote.
function explanationField(value) {
  return h('label', {}, 'Пояснення, чому правильна саме ця відповідь (необов’язково)',
    h('textarea', { name: 'explanation', maxlength: 1000, placeholder: 'Без нього AI напише пояснення сам, коли хтось помилиться' }, value || ''));
}

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
export function filePicker(input, label = 'Вибрати файл') {
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

export async function showExam(id, seq) {
  const [exam, courses] = await Promise.all([api('GET', `/api/exams/${id}`), api('GET', '/api/courses')]);
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

  if (stale(seq)) return;
  setView(
    h('a', { class: 'back', href: '#/prep' }, 'Усі екзамени'),
    h('div', { class: 'head page-head', 'data-edit': '' },
      h('div', {},
        exam.course ? h('p', { class: 'muted' }, exam.course) : null,
        h('h1', {}, exam.title),
        h('div', { class: 'exam-meta' },
          h('time', { class: 'num', datetime: new Date(exam.examAt).toISOString() }, fmtDate(exam.examAt)),
          h('span', { class: 'chip amber' }, relative(exam.examAt))),
        exam.theme ? h('p', { class: 'exam-theme pre' }, h('span', { class: 'muted' }, 'Тема: '), exam.theme) : null),
      h('div', { class: 'tools' },
        editButton(() => {
        const titleInput = h('input', { name: 'title', required: true, maxlength: 200, value: exam.title });
        return h('form', {
        class: 'edit-form grow',
        onsubmit: async (e) => {
          e.preventDefault();
          const f = formData(e.target);
          if (await act(() => api('PUT', `/api/exams/${id}`, { title: f.title, course: f.course, theme: f.theme, examAt: parseLocalInput(f.examAt) }))) reload();
        },
      },
      h('div', { class: 'row' },
        h('label', { class: 'grow' }, 'Екзамен', titleInput),
        courseField(titleInput, courses, exam.course)),
      themeField(exam.theme),
      h('label', {}, 'Дата й час', h('input', { name: 'examAt', type: 'datetime-local', required: true, value: localInputValue(exam.examAt) })),saveCancel(reload));
        }),
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
          exam.mistakes.length ? h('button', { type: 'button', class: 'secondary', onclick: () => act(() => showTest(exam, exam.mistakes)) }, `Повторити помилки (${exam.mistakes.length})`) : null,
          h('button', { type: 'button', disabled: !questionCount, onclick: () => act(() => showTest(exam)) }, exam.result ? 'Пройти ще раз' : 'Пройти тест'))),
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
