import test from 'node:test';
import assert from 'node:assert/strict';
import { historyEntries, historyKey, historyStep, idleCursor, type HistoryCursor } from './input-history.ts';

const press = (entries: string[], cursor: HistoryCursor, direction: 'up' | 'down', text: string) => {
  const step = historyStep(entries, cursor, direction, text);
  assert.ok(step, `${direction} from ${JSON.stringify(text)}`);
  return step;
};

test('↑/↓ walk sent messages like a shell and give the draft back at the end', () => {
  const entries = ['first', 'second', 'third'];
  let step = press(entries, idleCursor, 'up', 'draft');
  assert.equal(step.text, 'third');
  step = press(entries, step.cursor, 'up', step.text);
  assert.equal(step.text, 'second');
  step = press(entries, step.cursor, 'up', step.text);
  assert.equal(step.text, 'first');
  // The oldest entry stops there; the key keeps its normal meaning.
  assert.equal(historyStep(entries, step.cursor, 'up', step.text), null);
  step = press(entries, step.cursor, 'down', step.text);
  assert.equal(step.text, 'second');
  step = press(entries, step.cursor, 'down', step.text);
  assert.equal(step.text, 'third');
  step = press(entries, step.cursor, 'down', step.text);
  assert.deepEqual([step.text, step.cursor], ['draft', idleCursor]);
  assert.equal(historyStep(entries, idleCursor, 'down', 'draft'), null);
  assert.equal(historyStep([], idleCursor, 'up', ''), null);
});

test('editing a recalled message makes it the new draft', () => {
  const entries = ['one', 'two'];
  const recalled = press(entries, idleCursor, 'up', '');
  assert.equal(historyStep(entries, recalled.cursor, 'down', 'two, edited'), null);
  const again = press(entries, recalled.cursor, 'up', 'two, edited');
  assert.equal(again.text, 'two');
  assert.equal(press(entries, again.cursor, 'down', 'two').text, 'two, edited');
});

test('only the first line recalls with ↑ and only the last with ↓', () => {
  const key = (key: string, value: string, caret: number, extra = {}) => historyKey({ key, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...extra }, value, caret, caret);
  assert.equal(key('ArrowUp', 'a\nb', 1), 'up');
  assert.equal(key('ArrowUp', 'a\nb', 3), null);
  assert.equal(key('ArrowDown', 'a\nb', 3), 'down');
  assert.equal(key('ArrowDown', 'a\nb', 1), null);
  assert.equal(key('ArrowUp', 'abc', 2, { shiftKey: true }), null);
  assert.equal(key('ArrowUp', 'abc', 2, { isComposing: true }), null);
  assert.equal(historyKey({ key: 'ArrowUp', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false }, 'abc', 0, 2), null);
  assert.equal(key('Enter', 'abc', 0), null);
});

test('history drops blanks and consecutive repeats and keeps the latest entries', () => {
  assert.deepEqual(historyEntries([' a ', '', 'a', 'b', 'a']), ['a', 'b', 'a']);
  assert.deepEqual(historyEntries(['1', '2', '3'], 2), ['2', '3']);
});
