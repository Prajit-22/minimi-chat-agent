import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDateHints, formatDateHints } from '../src/dates.js';

// Tuesday, November 10, 2026, noon local time.
const NOW = new Date(2026, 10, 10, 12, 0, 0);

function hintFor(text: string, phrase: string) {
  return resolveDateHints(text, NOW).find((h) => h.phrase.toLowerCase().includes(phrase));
}

test('resolves yesterday and today', () => {
  const hints = resolveDateHints('Is my answer from yesterday still correct today?', NOW);
  assert.equal(hintFor('yesterday', 'yesterday')?.iso, '2026-11-09');
  assert.equal(hintFor('today', 'today')?.iso, '2026-11-10');
});

test('last Tuesday is the Tuesday strictly before today', () => {
  // Today is Tuesday 2026-11-10, so "last Tuesday" = 2026-11-03.
  const h = hintFor('Last Tuesday I asked about Postgres hosting', 'last tuesday');
  assert.equal(h?.iso, '2026-11-03');
  assert.equal(h?.weekday, 'Tuesday');
});

test('bare weekday is the most recent one, including today', () => {
  assert.equal(hintFor('On Monday we shortlisted 5 CRM tools', 'monday')?.iso, '2026-11-09');
  assert.equal(hintFor('Tuesday morning I ran the tests', 'tuesday')?.iso, '2026-11-10');
});

test('explicit month-day without year means the most recent occurrence', () => {
  assert.equal(hintFor('What did I ask you on 3 November?', '3 november')?.iso, '2026-11-03');
  // December 25 is in the future relative to Nov 10, so it resolves to last year.
  assert.equal(hintFor('the deal we discussed on 25 December', '25 december')?.iso, '2025-12-25');
  assert.equal(hintFor('the launch on November 2, 2026', 'november 2, 2026')?.iso, '2026-11-02');
});

test('N days/weeks ago', () => {
  assert.equal(hintFor('two days ago', 'two days ago')?.iso, '2026-11-08');
  assert.equal(hintFor('1 week ago', '1 week ago')?.iso, '2026-11-03');
});

test('no dates means no hints', () => {
  assert.deepEqual(resolveDateHints('What is the capital of France?', NOW), []);
  assert.equal(formatDateHints([]), '');
});

test('formatDateHints renders a context block', () => {
  const out = formatDateHints(resolveDateHints('last Tuesday', NOW));
  assert.match(out, /"last Tuesday" = Tuesday, 2026-11-03/);
});
