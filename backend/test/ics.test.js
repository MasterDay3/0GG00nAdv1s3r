import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIcs, parseIcsDate } from '../src/lib/ics.js';

const MOODLE_FEED = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Moodle Pty Ltd//NONSGML Moodle Version 2024100700//EN',
  'BEGIN:VEVENT',
  'UID:1234@moodle.ucu.edu.ua',
  'SUMMARY:Lab 3 is due',
  'DESCRIPTION:Submit the report.\\nSee https://moodle.ucu.edu.ua/mod/assign/v',
  ' iew.php?id=77 for details\\, please.',
  'CLASS:PUBLIC',
  'DTSTAMP:20261101T100000Z',
  'DTSTART:20261120T215900Z',
  'DTEND:20261120T215900Z',
  'CATEGORIES:OOP-2026',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:5678@moodle.ucu.edu.ua',
  'SUMMARY:Quiz closes',
  'URL:https://moodle.ucu.edu.ua/mod/quiz/view.php?id=9',
  'DTSTART;TZID=Europe/Kyiv:20261125T120000',
  'CATEGORIES:Calculus\\, Part 1,Extra',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

test('parses Moodle events with course, title, link and UTC due time', () => {
  const [lab, quiz] = parseIcs(MOODLE_FEED);
  assert.equal(lab.uid, '1234@moodle.ucu.edu.ua');
  assert.equal(lab.title, 'Lab 3 is due');
  assert.equal(lab.course, 'OOP-2026');
  assert.equal(lab.dueAt, Date.UTC(2026, 10, 20, 21, 59, 0));
  assert.equal(lab.description, 'Submit the report.\nSee https://moodle.ucu.edu.ua/mod/assign/view.php?id=77 for details, please.');
  assert.equal(lab.url, 'https://moodle.ucu.edu.ua/mod/assign/view.php?id=77');

  assert.equal(quiz.course, 'Calculus, Part 1');
  assert.equal(quiz.url, 'https://moodle.ucu.edu.ua/mod/quiz/view.php?id=9');
  // Kyiv is UTC+2 in November.
  assert.equal(quiz.dueAt, Date.UTC(2026, 10, 25, 10, 0, 0));
});

test('handles LF line endings, all-day dates and missing UID or link', () => {
  const ics = 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:Essay\nDTSTART;VALUE=DATE:20261201\nEND:VEVENT\nEND:VCALENDAR\n';
  const [essay] = parseIcs(ics);
  assert.equal(essay.dueAt, Date.UTC(2026, 11, 1, 21, 59, 0), 'end of that day in Kyiv (UTC+2 in December)');
  assert.equal(essay.url, '');
  assert.equal(essay.course, '');
  assert.ok(essay.uid.length > 0);
});

test('skips events without a usable start date and ignores non-http links', () => {
  const ics = [
    'BEGIN:VEVENT', 'UID:a', 'SUMMARY:No date', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:b', 'SUMMARY:Bad', 'DTSTART:garbage', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:c', 'SUMMARY:Ok', 'URL:javascript:alert(1)', 'DTSTART:20261120T100000Z', 'END:VEVENT',
  ].join('\n');
  const events = parseIcs(ics);
  assert.equal(events.length, 1);
  assert.equal(events[0].uid, 'c');
  assert.equal(events[0].url, '');
});

test('parseIcsDate falls back to Kyiv time for an unknown time zone', () => {
  assert.equal(
    parseIcsDate('20261120T100000', { TZID: 'Not/AZone' }),
    Date.UTC(2026, 10, 20, 8, 0, 0),
  );
  assert.equal(parseIcsDate('2026-11-20'), null);
});

test('ics: all-day and floating times are Kyiv time whatever the process time zone', async () => {
  const { parseIcsDate } = await import('../src/lib/ics.js');
  // 20 Nov 2026 is winter time in Kyiv (UTC+2); 1 Jul 2026 is summer time (UTC+3).
  assert.equal(parseIcsDate('20261120'), Date.UTC(2026, 10, 20, 21, 59));
  assert.equal(parseIcsDate('20260701T120000'), Date.UTC(2026, 6, 1, 9, 0));
  assert.equal(parseIcsDate('20261120T100000Z'), Date.UTC(2026, 10, 20, 10, 0));
});
