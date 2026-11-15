import { test } from 'node:test';
import assert from 'node:assert/strict';
import { urgency, HOUR, DAY } from '../src/urgency.js';
import { dueReminders } from '../src/reminders.js';
import { buildPlan, addDays, daysBetween } from '../src/plan.js';
import { scoreDiagnostic } from '../src/diagnostic.js';
import { formatDue, localParts, digestText } from '../src/bot.js';

const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);

test('urgency: red under 48 h, amber under 7 days, grey later, overdue in the past', () => {
  assert.equal(urgency(NOW - 1, NOW), 'overdue');
  assert.equal(urgency(NOW + 47 * HOUR, NOW), 'red');
  assert.equal(urgency(NOW + 48 * HOUR, NOW), 'amber');
  assert.equal(urgency(NOW + 7 * DAY - 1, NOW), 'amber');
  assert.equal(urgency(NOW + 7 * DAY, NOW), 'grey');
});

test('reminders: 3-day and 1-day reminders fire once each, never for past items', () => {
  const items = [
    { key: 'd1', dueAt: NOW + 2 * DAY },
    { key: 'd2', dueAt: NOW + 12 * HOUR },
    { key: 'd3', dueAt: NOW + 5 * DAY },
    { key: 'd4', dueAt: NOW - HOUR },
  ];
  assert.deepEqual(
    dueReminders(items, new Set(), NOW).map((r) => `${r.item.key}:${r.kind}`),
    ['d1:3d', 'd2:1d'],
  );
  assert.deepEqual(dueReminders(items, new Set(['d1:3d', 'd2:1d']), NOW), []);
});

test('plan helpers count calendar days', () => {
  assert.equal(addDays('2026-12-30', 3), '2027-01-02');
  assert.equal(daysBetween('2026-11-14', '2026-11-20'), 6);
});

test('plan: weak topics first and again before the final review day', () => {
  const plan = buildPlan({
    today: '2026-11-14',
    examDate: '2026-11-20',
    topics: [
      { name: 'Limits', status: 'weak' },
      { name: 'Series', status: 'strong' },
      { name: 'Integrals', status: 'untested' },
    ],
  });
  assert.deepEqual(plan.map((d) => d.date), [
    '2026-11-14', '2026-11-15', '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19',
  ]);
  assert.deepEqual(plan.map((d) => d.topics), [
    ['Limits'], ['Integrals'], ['Series'], ['Limits'], ['Integrals'], [],
  ]);
  assert.equal(plan.at(-1).focus, 'review');
  assert.equal(plan[0].focus, 'practice');
  assert.equal(plan[2].focus, 'refresh');
});

test('plan: squeezes several topics into a day when time is short', () => {
  const plan = buildPlan({
    today: '2026-11-14',
    examDate: '2026-11-16',
    topics: [{ name: 'A', status: 'weak' }, { name: 'B', status: 'weak' }],
  });
  assert.equal(plan.length, 2);
  assert.deepEqual(plan[0].topics, ['A', 'B']);
  assert.equal(plan[1].focus, 'review');
});

test('plan: fills spare days by cycling weak topics', () => {
  const plan = buildPlan({ today: '2026-11-01', examDate: '2026-11-08', topics: [{ name: 'A', status: 'weak' }] });
  assert.equal(plan.length, 7);
  assert.ok(plan.slice(0, 6).every((d) => d.topics.length === 1 && d.topics[0] === 'A'));
});

test('plan: empty when the exam is today or past, review-only without topics', () => {
  assert.deepEqual(buildPlan({ today: '2026-11-14', examDate: '2026-11-14', topics: [] }), []);
  const plan = buildPlan({ today: '2026-11-14', examDate: '2026-11-18', topics: [] });
  assert.deepEqual(plan, [{ date: '2026-11-17', topics: [], focus: 'review' }]);
});

test('diagnostic: 70% or more is strong, unanswered counts as wrong, no questions is untested', () => {
  const topics = [{ id: 1, name: 'Limits' }, { id: 2, name: 'Series' }, { id: 3, name: 'Integrals' }];
  const questions = [
    { id: 10, topicId: 1, answerIndex: 0 },
    { id: 11, topicId: 1, answerIndex: 1 },
    { id: 12, topicId: 1, answerIndex: 2 },
    { id: 20, topicId: 2, answerIndex: 0 },
    { id: 21, topicId: 2, answerIndex: 0 },
  ];
  const result = scoreDiagnostic(topics, questions, { 10: 0, 11: 1, 12: 2, 20: 0, 21: null });
  assert.deepEqual(result, [
    { topicId: 1, name: 'Limits', correct: 3, total: 3, status: 'strong' },
    { topicId: 2, name: 'Series', correct: 1, total: 2, status: 'weak' },
    { topicId: 3, name: 'Integrals', correct: 0, total: 0, status: 'untested' },
  ]);
});

test('bot: Kyiv time, including the summer/winter clock change', () => {
  assert.equal(formatDue(Date.UTC(2026, 10, 16, 21, 59)), 'Mon 16 Nov, 23:59');
  assert.equal(formatDue(Date.UTC(2026, 6, 1, 20, 59)), 'Wed 1 Jul, 23:59');
  assert.deepEqual(localParts(Date.UTC(2026, 10, 14, 22, 30)), { date: '2026-11-15', hour: 0 });
});

test('bot: digest covers only the next 7 days', () => {
  const items = [
    { key: 'd1', title: 'Soon', course: '', url: '', dueAt: NOW + DAY },
    { key: 'd2', title: 'Later', course: '', url: '', dueAt: NOW + 8 * DAY },
  ];
  assert.match(digestText(items, NOW), /Soon/);
  assert.doesNotMatch(digestText(items, NOW), /Later/);
  assert.equal(digestText([items[1]], NOW), null);
});
