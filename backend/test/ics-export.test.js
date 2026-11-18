import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCalendar, escapeText, foldLine } from '../src/ics-export.js';
import { parseIcs } from '../src/ics.js';

const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);

test('ics export: text is escaped and long lines fold without splitting a letter', () => {
  assert.equal(escapeText('a,b;c\\d\ne'), 'a\\,b\\;c\\\\d\\ne');
  const line = `SUMMARY:${'Дедлайн '.repeat(20)}`;
  const folded = foldLine(line);
  for (const part of folded.split('\r\n')) assert.ok(Buffer.byteLength(part) <= 75);
  assert.equal(folded.split('\r\n').map((p, i) => (i ? p.slice(1) : p)).join(''), line);
});

test('ics export: deadlines and exams become events our own parser reads back', () => {
  const ics = buildCalendar([
    { key: 'd1', source: 'personal', course: 'Ethics', title: 'Essay, part 1', url: 'https://learn.example/e', dueAt: NOW + 86_400_000, note: 'Use 3 sources' },
    { key: 'e2', source: 'exam', course: '', title: 'Calculus', url: '', dueAt: NOW + 5 * 86_400_000, note: '' },
  ], NOW, 'dueboard.xyz');
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /UID:d1@dueboard\.xyz/);
  assert.match(ics, /SUMMARY:\[Ethics\] Essay\\, part 1/);
  assert.match(ics, /DESCRIPTION:Use 3 sources\\n\\nhttps:\/\/learn\.example\/e/);
  assert.match(ics, /SUMMARY:Екзамен: Calculus/);
  const events = parseIcs(ics);
  assert.equal(events.length, 2);
  assert.equal(events[0].dueAt, NOW + 86_400_000);
});
