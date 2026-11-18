// AI: questions from slides and explanations of questions.
import { COUNT } from '../clients/ai.js';
import { AI_RUNS_PER_DAY, AI_EXPLAINS_PER_DAY } from '../constants.js';
import { DAY } from '../lib/urgency.js';
import { HttpError } from '../lib/validate.js';

export function aiRoutes(ctx) {
  const { db, now, ai, route, one, all, run } = ctx;

  // Why the right answer is right, for a question without an explanation: the AI writes one once, then it is kept.
  const explainingNow = new Map(); // user id -> AI explanations being written right now
  route('POST', '/api/questions/:id/explain', async ({ user, params }) => {
    const question = ctx.ownItem(user, 'questions', params.id, 'Питання не знайдено');
    if (question.explanation) return { explanation: question.explanation };
    if (!ai.enabled) throw new HttpError(503, 'AI-пояснення на цьому сервері не налаштовані');
    const busy = explainingNow.get(user.id) || 0;
    if (busy >= 3) throw new HttpError(429, 'Пояснення пишуться для кількох питань одразу. Спробуйте за хвилину.');
    explainingNow.set(user.id, busy + 1);
    try {
      return await writeExplanation(user, question);
    } finally {
      const left = (explainingNow.get(user.id) || 1) - 1;
      if (left > 0) explainingNow.set(user.id, left); else explainingNow.delete(user.id);
    }
  });

  async function writeExplanation(user, question) {
    const { used } = one('SELECT COUNT(*) AS used FROM ai_explains WHERE user_id = ? AND created_at > ?', user.id, now() - DAY);
    if (used >= AI_EXPLAINS_PER_DAY) throw new HttpError(429, `Пояснень можна отримати ${AI_EXPLAINS_PER_DAY} на день. Спробуйте завтра.`);
    run('INSERT INTO ai_explains (user_id, created_at) VALUES (?, ?)', user.id, now());
    const quote = one('SELECT quote FROM question_sources WHERE question_id = ?', question.id)?.quote || '';
    const explanation = await ai.explainQuestion({
      prompt: question.prompt, options: JSON.parse(question.options), answerIndex: question.answer_index, quote,
    });
    // The question may have been edited while the AI was writing; keep the explanation only if it still fits.
    run('UPDATE questions SET explanation = ? WHERE id = ? AND explanation IS NULL AND prompt = ? AND options = ? AND answer_index = ?',
      explanation, question.id, question.prompt, question.options, question.answer_index);
    return { explanation };
  }

  const generating = new Set();

  route('POST', '/api/exams/:id/generate', async ({ user, params, body }) => {
    const exam = ctx.ownExam(user, params.id);
    const count = body.count === undefined ? COUNT.default : body.count;
    if (!Number.isInteger(count) || count < COUNT.min || count > COUNT.max) {
      throw new HttpError(400, `За раз можна згенерувати від ${COUNT.min} до ${COUNT.max} питань`);
    }
    const topics = all('SELECT id, name FROM topics WHERE exam_id = ? ORDER BY id', exam.id);
    const materials = all('SELECT id, filename, data FROM materials WHERE exam_id = ? ORDER BY id', exam.id);
    if (!materials.length) throw new HttpError(400, 'Спершу завантажте слайди лекцій');
    if (generating.has(user.id)) throw new HttpError(409, 'Питання вже генеруються. Зачекайте, доки закінчиться.');
    const { runs } = one('SELECT COUNT(*) AS runs FROM ai_runs WHERE user_id = ? AND created_at > ?', user.id, now() - DAY);
    if (runs >= AI_RUNS_PER_DAY) throw new HttpError(429, `Генерувати питання можна ${AI_RUNS_PER_DAY} разів на день. Спробуйте завтра.`);

    const existing = ctx.examQuestions(exam.id);
    // Counted before the call: a run that fails (timeout, refusal) still costs the provider, so it counts too.
    run('INSERT INTO ai_runs (user_id, created_at) VALUES (?, ?)', user.id, now());
    generating.add(user.id);
    let result;
    try {
      result = await ai.generateQuestions({
        examTitle: exam.title,
        examTheme: exam.theme,
        count,
        topics: topics.map((t) => ({ ...t, existing: existing.filter((q) => q.topicId === t.id).map((q) => q.prompt) })),
        materials,
      });
    } finally {
      generating.delete(user.id);
    }

    const filenames = new Map(materials.map((m) => [m.id, m.filename]));
    // The model names the topics; a name the exam does not have yet becomes a new topic.
    const topicIds = new Map(topics.map((t) => [t.name.toLowerCase(), t.id]));
    const topicFor = (name) => {
      const key = name.toLowerCase();
      if (!topicIds.has(key)) {
        topicIds.set(key, Number(run('INSERT INTO topics (exam_id, name) VALUES (?, ?)', exam.id, name).lastInsertRowid));
      }
      return topicIds.get(key);
    };
    db.exec('BEGIN');
    try {
      for (const q of result.questions) {
        const { lastInsertRowid } = run(
          'INSERT INTO questions (topic_id, prompt, options, answer_index, explanation) VALUES (?, ?, ?, ?, ?)',
          topicFor(q.topic), q.prompt, JSON.stringify(q.options), q.answerIndex, q.explanation || null,
        );
        run(
          'INSERT INTO question_sources (question_id, material_id, filename, slide, quote) VALUES (?, ?, ?, ?, ?)',
          lastInsertRowid, q.materialId, filenames.get(q.materialId), q.slide, q.quote,
        );
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return { ...ctx.withAi(ctx.examDetail(exam)), added: result.questions.length, skipped: result.skipped };
  });
}
