import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDeadlineSimply } from '../src/bot/simple-parse.js';

const THURSDAY = Date.UTC(2026, 10, 19, 10, 25); // Thu 19 Nov 2026, 12:25 in Kyiv
const read = (text) => parseDeadlineSimply(text, THURSDAY)[0];
const short = (d) => d && `${d.title} | ${d.date} ${d.time}${d.url ? ` | ${d.url}` : ''}`;

test('simple parse: the usual ways a course chat writes a deadline', () => {
  assert.equal(short(read('завтра урок з пробабіліті і статістіксі 8:00')), 'Урок з пробабіліті і статістіксі | 2026-11-20 08:00');
  assert.equal(short(read('Лаба 3 з ООП до 1 грудня 18:00')), 'Лаба 3 з ООП | 2026-12-01 18:00');
  assert.equal(short(read('лаба до 25.11 18:00')), 'Лаба | 2026-11-25 18:00');
  assert.equal(short(read('Курсова до 15.06.2027 23:59')), 'Курсова | 2027-06-15 23:59');
  assert.equal(short(read('Тест з матану 5.01 о 9.30')), 'Тест з матану | 2027-01-05 09:30', 'January, read in November, is next year');
  assert.equal(short(read('есе до 18.00 завтра')), 'Есе | 2026-11-20 18:00');
  assert.equal(short(read('контрольна післязавтра о 10')), 'Контрольна | 2026-11-21 10:00');
  assert.equal(short(read('проєкт через 3 дні')), 'Проєкт | 2026-11-22 ');
  assert.equal(short(read('Здати есей з етики до четверга')), 'Есей з етики | 2026-11-26 ', 'a Thursday on a Thursday is next week');
  assert.equal(short(read('ДЗ на пн')), 'ДЗ | 2026-11-23 ');
  assert.equal(short(read('Привіт! Нагадую:\nЛабораторна 4 з алгоритмів — до 27 листопада 23:59\nhttps://cms.ucu.edu.ua/mod/assign/view.php?id=5).')),
    'Лабораторна 4 з алгоритмів | 2026-11-27 23:59 | https://cms.ucu.edu.ua/mod/assign/view.php?id=5', 'title from the date line, link without the closing bracket');
  assert.equal(short(read('Есе з етики\nдо п’ятниці')), 'Есе з етики | 2026-11-20 ');
});

test('simple parse: no date, an impossible date, and an old one', () => {
  assert.deepEqual(parseDeadlineSimply('привіт як справи', THURSDAY), []);
  assert.deepEqual(parseDeadlineSimply('Звіт до 31.02', THURSDAY), []);
  assert.equal(read('дедлайн 10.11').date, '2026-11-10', 'a date a few days ago stays this year, so the bot says it has passed');
  assert.equal(read('до 12.12').title, 'Дедлайн');
});
