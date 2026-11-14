export const STRONG_THRESHOLD = 0.7;

// topics: [{ id, name }]; questions: [{ id, topicId, answerIndex }]; answers: { [questionId]: optionIndex }
export function scoreDiagnostic(topics, questions, answers) {
  return topics.map((topic) => {
    const asked = questions.filter((q) => q.topicId === topic.id);
    const correct = asked.filter((q) => {
      const given = answers[q.id];
      return Number.isInteger(given) && given === q.answerIndex;
    }).length;
    let status = 'untested';
    if (asked.length) status = correct / asked.length >= STRONG_THRESHOLD ? 'strong' : 'weak';
    return { topicId: topic.id, name: topic.name, correct, total: asked.length, status };
  });
}
