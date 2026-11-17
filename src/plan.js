// Dates are calendar days as 'YYYY-MM-DD' strings.
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function toUtc(date) {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

export function addDays(date, n) {
  return new Date(toUtc(date) + n * MS_PER_DAY).toISOString().slice(0, 10);
}

export function daysBetween(from, to) {
  return Math.round((toUtc(to) - toUtc(from)) / MS_PER_DAY);
}

// The calendar day in Kyiv, whatever time zone the process runs in (the digest uses the same rule).
const KYIV_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' });
export function localDate(ms) {
  return KYIV_DAY.format(new Date(ms));
}

// topics: [{ name, status: 'weak' | 'strong' | 'untested' }]. Untested topics count as weak.
// Days from today up to the day before the exam; that last day is a full review.
export function buildPlan({ today, examDate, topics }) {
  const available = daysBetween(today, examDate);
  if (available <= 0) return [];
  const weak = topics.filter((t) => t.status !== 'strong').map((t) => t.name);
  const strong = topics.filter((t) => t.status === 'strong').map((t) => t.name);
  const review = { date: addDays(today, available - 1), topics: [], focus: 'review' };

  let queue = [...weak, ...strong, ...weak];
  const studyDays = available - 1;
  if (studyDays === 0 || queue.length === 0) return [review];

  const filler = weak.length ? weak : strong;
  while (queue.length < studyDays) queue = queue.concat(filler);

  const plan = [];
  for (let i = 0; i < studyDays; i++) {
    const start = Math.floor((i * queue.length) / studyDays);
    const end = Math.floor(((i + 1) * queue.length) / studyDays);
    const dayTopics = [...new Set(queue.slice(start, end))];
    plan.push({
      date: addDays(today, i),
      topics: dayTopics,
      focus: dayTopics.some((t) => weak.includes(t)) ? 'practice' : 'refresh',
    });
  }
  plan.push(review);
  return plan;
}
