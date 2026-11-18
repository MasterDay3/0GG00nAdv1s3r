// Exams, topics, questions, problems, materials and the diagnostic test.
import { MAX_FILE, MAX_UPLOAD_BODY } from '../constants.js';
import { scoreDiagnostic } from '../lib/diagnostic.js';
import { HttpError, text, timestamp } from '../lib/validate.js';

export function examRoutes(ctx) {
  const { now, storageLimit, route, one, all, run } = ctx;

  route('GET', '/api/exams', ({ user }) =>
    all('SELECT id, title, course, exam_at FROM exams WHERE user_id = ? ORDER BY exam_at', user.id)
      .map((e) => ({ id: e.id, title: e.title, course: e.course, examAt: e.exam_at })));

  function examFields(body) {
    return {
      title: text(body.title, 'Назва екзамену'),
      course: text(body.course, 'Курс', { max: 100, required: false }),
      examAt: timestamp(body.examAt, 'Дата екзамену'),
    };
  }

  // The theme is optional and only changes when the request sends it, so older clients keep it as it was.
  const themeOf = (body) => (body.theme === undefined ? undefined : text(body.theme, 'Тема екзамену', { max: 1000, required: false }));
  function saveTheme(examId, theme) {
    if (theme !== undefined) run('UPDATE exams SET theme = ? WHERE id = ?', theme, examId);
  }

  // Full course names the student already has (Moodle, own and group deadlines, exams), for the course field hints.
  route('GET', '/api/courses', ({ user }) => all(
    `SELECT course FROM deadlines
     WHERE removed_at IS NULL AND course != '' AND (owner_user_id = ? OR (group_id IS NOT NULL AND group_id = ?))
     UNION SELECT course FROM exams WHERE user_id = ? AND course != ''
     ORDER BY course`,
    user.id, user.group_id ?? -1, user.id,
  ).map((r) => r.course));

  route('POST', '/api/exams', ({ user, body }) => {
    const { title, course, examAt } = examFields(body);
    const theme = themeOf(body);
    const { lastInsertRowid } = run('INSERT INTO exams (user_id, course, title, exam_at) VALUES (?, ?, ?, ?)', user.id, course, title, examAt);
    saveTheme(Number(lastInsertRowid), theme);
    return { id: Number(lastInsertRowid) };
  });

  route('GET', '/api/exams/:id', ({ user, params }) => {
    const exam = ctx.ownExam(user, params.id);
    return {
      ...ctx.withAi(ctx.examDetail(exam)),
      theme: exam.theme,
      storage: { used: ctx.storageUsed(user), limit: storageLimit },
    };
  });

  route('PUT', '/api/exams/:id', ({ user, params, body }) => {
    const exam = ctx.ownExam(user, params.id);
    const { title, course, examAt } = examFields(body);
    saveTheme(exam.id, themeOf(body));
    run('UPDATE exams SET title = ?, course = ?, exam_at = ? WHERE id = ?', title, course, examAt, exam.id);
    if (examAt !== exam.exam_at) run('DELETE FROM reminders_sent WHERE item_key = ?', `e${exam.id}`);
    return { ok: true };
  });

  route('DELETE', '/api/exams/:id', ({ user, params }) => {
    ctx.ownExam(user, params.id);
    run('DELETE FROM exams WHERE id = ?', params.id);
    for (const table of ['notes', 'reminders_sent']) run(`DELETE FROM ${table} WHERE item_key = ?`, `e${params.id}`);
    return { ok: true };
  });

  route('POST', '/api/exams/:id/topics', ({ user, params, body }) => {
    ctx.ownExam(user, params.id);
    const name = text(body.name, 'Тема', { max: 120 });
    const { lastInsertRowid } = run('INSERT INTO topics (exam_id, name) VALUES (?, ?)', params.id, name);
    return { id: Number(lastInsertRowid), name };
  });

  route('PUT', '/api/topics/:id', ({ user, params, body }) => {
    ctx.ownTopic(user, params.id);
    run('UPDATE topics SET name = ? WHERE id = ?', text(body.name, 'Тема', { max: 120 }), params.id);
    return { ok: true };
  });

  route('DELETE', '/api/topics/:id', ({ user, params }) => {
    ctx.ownTopic(user, params.id);
    run('DELETE FROM topics WHERE id = ?', params.id);
    return { ok: true };
  });

  function questionFields(body) {
    const prompt = text(body.prompt, 'Питання', { max: 1000 });
    if (!Array.isArray(body.options) || body.options.length < 2 || body.options.length > 6) {
      throw new HttpError(400, 'Питанню потрібно від 2 до 6 варіантів відповіді');
    }
    const options = body.options.map((o, i) => text(o, `Варіант ${i + 1}`, { max: 300 }));
    if (!Number.isInteger(body.answerIndex) || body.answerIndex < 0 || body.answerIndex >= options.length) {
      throw new HttpError(400, 'Вкажіть правильний варіант');
    }
    const explanation = text(body.explanation, 'Пояснення', { max: 1000, required: false });
    return { prompt, options, answerIndex: body.answerIndex, explanation };
  }

  route('POST', '/api/topics/:id/questions', ({ user, params, body }) => {
    ctx.ownTopic(user, params.id);
    const { prompt, options, answerIndex, explanation } = questionFields(body);
    const { lastInsertRowid } = run(
      'INSERT INTO questions (topic_id, prompt, options, answer_index, explanation) VALUES (?, ?, ?, ?, ?)',
      params.id, prompt, JSON.stringify(options), answerIndex, explanation || null,
    );
    return { id: Number(lastInsertRowid) };
  });

  // Editing keeps the question's topic; moving it is topicId (another topic of the same exam).
  route('PUT', '/api/questions/:id', ({ user, params, body }) => {
    const question = ctx.ownItem(user, 'questions', params.id, 'Питання не знайдено');
    const { prompt, options, answerIndex, explanation } = questionFields(body);
    // An explanation sent along is kept; otherwise one for a changed question or answer is dropped, as it may be wrong now.
    const changed = prompt !== question.prompt || JSON.stringify(options) !== question.options || answerIndex !== question.answer_index;
    const newExplanation = body.explanation !== undefined ? explanation || null : (changed ? null : question.explanation);
    let topicId = question.topic_id;
    if (body.topicId !== undefined && body.topicId !== topicId) {
      const target = Number.isInteger(body.topicId) && ctx.ownTopic(user, body.topicId);
      const current = one('SELECT exam_id FROM topics WHERE id = ?', topicId);
      if (!target || target.exam_id !== current.exam_id) throw new HttpError(400, 'Тему не знайдено');
      topicId = target.id;
    }
    run('UPDATE questions SET topic_id = ?, prompt = ?, options = ?, answer_index = ?, explanation = ? WHERE id = ?',
      topicId, prompt, JSON.stringify(options), answerIndex, newExplanation, params.id);
    return { ok: true };
  });



  route('DELETE', '/api/questions/:id', ({ user, params }) => {
    const { changes } = run(
      `DELETE FROM questions WHERE id = ? AND topic_id IN
         (SELECT t.id FROM topics t JOIN exams e ON e.id = t.exam_id WHERE e.user_id = ?)`, params.id, user.id,
    );
    if (!changes) throw new HttpError(404, 'Питання не знайдено');
    return { ok: true };
  });

  route('POST', '/api/topics/:id/problems', ({ user, params, body }) => {
    ctx.ownTopic(user, params.id);
    const problem = text(body.text, 'Задача', { max: 4000 });
    const { lastInsertRowid } = run('INSERT INTO problems (topic_id, text) VALUES (?, ?)', params.id, problem);
    return { id: Number(lastInsertRowid) };
  });

  route('PUT', '/api/problems/:id', ({ user, params, body }) => {
    ctx.ownItem(user, 'problems', params.id, 'Задачу не знайдено');
    run('UPDATE problems SET text = ? WHERE id = ?', text(body.text, 'Задача', { max: 4000 }), params.id);
    return { ok: true };
  });

  route('DELETE', '/api/problems/:id', ({ user, params }) => {
    const { changes } = run(
      `DELETE FROM problems WHERE id = ? AND topic_id IN
         (SELECT t.id FROM topics t JOIN exams e ON e.id = t.exam_id WHERE e.user_id = ?)`, params.id, user.id,
    );
    if (!changes) throw new HttpError(404, 'Задачу не знайдено');
    return { ok: true };
  });

  route('POST', '/api/exams/:id/materials', ({ user, params, body }) => {
    ctx.ownExam(user, params.id);
    const filename = text(body.filename, 'Назва файлу', { max: 200 }).replace(/[\r\n"\\/]/g, '_');
    if (typeof body.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.data)) {
      throw new HttpError(400, 'Дані файлу мають бути в base64');
    }
    const data = Buffer.from(body.data, 'base64');
    if (!data.length) throw new HttpError(400, 'Файл порожній');
    if (data.length > MAX_FILE) throw new HttpError(413, 'Файл не може бути більшим за 10 МБ');
    if (ctx.storageUsed(user) + data.length > storageLimit) {
      throw new HttpError(413, `Місце для файлів закінчилося (${Math.round(storageLimit / 1024 / 1024)} МБ на акаунт). Видаліть старі файли, які вже не потрібні.`);
    }
    const { lastInsertRowid } = run(
      'INSERT INTO materials (exam_id, filename, size, data, created_at) VALUES (?, ?, ?, ?, ?)',
      params.id, filename, data.length, data, now(),
    );
    return { id: Number(lastInsertRowid), filename, size: data.length };
  }, { limit: MAX_UPLOAD_BODY });

  route('GET', '/api/materials/:id', ({ user, params, res }) => {
    const material = one(
      `SELECT m.* FROM materials m JOIN exams e ON e.id = m.exam_id WHERE m.id = ? AND e.user_id = ?`, params.id, user.id,
    );
    if (!material) throw new HttpError(404, 'Файл не знайдено');
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(material.filename)}`,
      'cache-control': 'no-store',
    });
    res.end(Buffer.from(material.data));
  });

  route('DELETE', '/api/materials/:id', ({ user, params }) => {
    const { changes } = run(
      `DELETE FROM materials WHERE id = ? AND exam_id IN (SELECT id FROM exams WHERE user_id = ?)`, params.id, user.id,
    );
    if (!changes) throw new HttpError(404, 'Файл не знайдено');
    return { ok: true };
  });

  route('GET', '/api/exams/:id/test', ({ user, params }) => {
    ctx.ownExam(user, params.id);
    const topics = new Map(all('SELECT id, name FROM topics WHERE exam_id = ?', params.id).map((t) => [t.id, t.name]));
    const sources = new Map(all(
      `SELECT s.* FROM question_sources s JOIN questions q ON q.id = s.question_id
       JOIN topics t ON t.id = q.topic_id WHERE t.exam_id = ?`, params.id,
    ).map((s) => [s.question_id, { filename: s.filename, slide: s.slide, quote: s.quote }]));
    // Practice on the student's own questions, so the answer comes along: the page shows right/wrong at once.
    return {
      questions: ctx.examQuestions(params.id).map(({ id, topicId, prompt, options, answerIndex, explanation }) => ({
        id, topicId, topic: topics.get(topicId), prompt, options, answerIndex, explanation, source: sources.get(id) || null,
      })),
    };
  });

  route('POST', '/api/exams/:id/test', ({ user, params, body }) => {
    const exam = ctx.ownExam(user, params.id);
    const answers = body.answers && typeof body.answers === 'object' && !Array.isArray(body.answers) ? body.answers : {};
    const questions = ctx.examQuestions(exam.id);
    if (!questions.length) throw new HttpError(400, 'Спершу додайте питання');
    const topics = all('SELECT id, name FROM topics WHERE exam_id = ? ORDER BY id', exam.id);
    const result = scoreDiagnostic(topics, questions, answers);
    const wrong = questions.filter((q) => answers[q.id] !== q.answerIndex).map((q) => q.id);
    run('INSERT INTO attempts (exam_id, created_at, result, wrong) VALUES (?, ?, ?, ?)',
      exam.id, now(), JSON.stringify(result), JSON.stringify(wrong));
    return ctx.examDetail(exam);
  });
}
