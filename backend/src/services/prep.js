// Exam prep data: ownership checks and the full exam with its plan.
import { buildPlan, localDate } from '../lib/plan.js';
import { HttpError, text } from '../lib/validate.js';

export function createPrep(ctx) {
  const { now, ai, one, all } = ctx;

  const storageUsed = (user) => one(
    'SELECT COALESCE(SUM(m.size), 0) AS used FROM materials m JOIN exams e ON e.id = m.exam_id WHERE e.user_id = ?', user.id,
  ).used;

  function ownExam(user, id) {
    const exam = one('SELECT * FROM exams WHERE id = ? AND user_id = ?', id, user.id);
    if (!exam) throw new HttpError(404, 'Екзамен не знайдено');
    return exam;
  }

  function ownTopic(user, id) {
    const topic = one(
      'SELECT t.* FROM topics t JOIN exams e ON e.id = t.exam_id WHERE t.id = ? AND e.user_id = ?', id, user.id,
    );
    if (!topic) throw new HttpError(404, 'Тему не знайдено');
    return topic;
  }

  function examQuestions(examId) {
    return all(
      `SELECT q.* FROM questions q JOIN topics t ON t.id = q.topic_id WHERE t.exam_id = ? ORDER BY t.id, q.id`, examId,
    ).map((q) => ({
      id: q.id, topicId: q.topic_id, prompt: q.prompt, options: JSON.parse(q.options), answerIndex: q.answer_index,
      explanation: q.explanation || '',
    }));
  }

  function examDetail(exam) {
    const questions = examQuestions(exam.id);
    const problems = all(
      `SELECT p.* FROM problems p JOIN topics t ON t.id = p.topic_id WHERE t.exam_id = ? ORDER BY p.id`, exam.id,
    );
    const topics = all('SELECT * FROM topics WHERE exam_id = ? ORDER BY id', exam.id).map((t) => ({
      id: t.id,
      name: t.name,
      questions: questions.filter((q) => q.topicId === t.id),
      problems: problems.filter((p) => p.topic_id === t.id).map((p) => ({ id: p.id, text: p.text })),
    }));
    // Every attempt, oldest first, so the page can show the trend; the last one drives the plan.
    const attempts = all('SELECT * FROM attempts WHERE exam_id = ? ORDER BY id', exam.id).map((a) => {
      const byTopic = JSON.parse(a.result);
      return {
        takenAt: a.created_at,
        correct: byTopic.reduce((n, t) => n + t.correct, 0),
        total: byTopic.reduce((n, t) => n + t.total, 0),
        topics: byTopic,
        wrong: JSON.parse(a.wrong || '[]'),
      };
    });
    const last = attempts.at(-1);
    const result = last ? { takenAt: last.takenAt, topics: last.topics } : null;
    // Mistakes of the last attempt that are still in the exam (a question may have been deleted since).
    const questionIds = new Set(questions.map((q) => q.id));
    const mistakes = last ? last.wrong.filter((id) => questionIds.has(id)) : [];
    const statusOf = (topicId) => result?.topics.find((r) => r.topicId === topicId)?.status || 'untested';
    return {
      id: exam.id,
      title: exam.title,
      course: exam.course,
      examAt: exam.exam_at,
      topics,
      materials: all('SELECT id, filename, size, created_at FROM materials WHERE exam_id = ? ORDER BY id', exam.id)
        .map((m) => ({ id: m.id, filename: m.filename, size: m.size, createdAt: m.created_at })),
      result,
      history: attempts.map(({ takenAt, correct, total, topics: byTopic }) => ({ takenAt, correct, total, topics: byTopic })),
      mistakes,
      plan: buildPlan({
        today: localDate(now()),
        examDate: localDate(exam.exam_at),
        topics: topics.map((t) => ({ name: t.name, status: statusOf(t.id) })),
      }),
    };
  }

  // Adds the slide each AI-generated question comes from, and whether AI generation is available.
  function withAi(detail) {
    const sources = new Map(all(
      `SELECT s.* FROM question_sources s JOIN questions q ON q.id = s.question_id
       JOIN topics t ON t.id = q.topic_id WHERE t.exam_id = ?`, detail.id,
    ).map((s) => [s.question_id, { materialId: s.material_id, filename: s.filename, slide: s.slide, quote: s.quote }]));
    for (const topic of detail.topics) {
      for (const q of topic.questions) q.source = sources.get(q.id) || null;
    }
    return { ...detail, ai: { enabled: ai.enabled, model: ai.model, label: ai.label } };
  }

  // A question or problem of one of the user's exams.
  // table is one of two constants ('questions' | 'problems'), never user input.
  function ownItem(user, table, id, notFound) {
    const row = one(
      `SELECT x.* FROM ${table} x JOIN topics t ON t.id = x.topic_id JOIN exams e ON e.id = t.exam_id
       WHERE x.id = ? AND e.user_id = ?`, id, user.id,
    );
    if (!row) throw new HttpError(404, notFound);
    return row;
  }

  return { ownExam, ownTopic, examQuestions, examDetail, withAi, ownItem, storageUsed };
}
