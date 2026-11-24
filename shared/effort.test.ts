import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultEffortLabel, effortChoices, effortLabel } from './effort.ts';

test('known effort ids keep the native id beside a readable label', () => {
  assert.equal(effortLabel('xhigh'), '超高（xhigh）');
  assert.equal(effortLabel('HIGH'), '高（HIGH）');
  assert.equal(effortLabel('turbo'), 'turbo', 'Unknown native ids are shown as reported');
});

test('effort choices keep native order and drop duplicates and invalid ids', () => {
  const choices = effortChoices([
    { id: 'low', description: 'Fast' }, { id: 'high' }, { id: 'low' }, { id: '' }, { id: 'x'.repeat(65) }, { id: 'think', name: 'Deep think' },
  ]);
  assert.deepEqual(choices, [
    { id: 'low', label: '低（low）', description: 'Fast' },
    { id: 'high', label: '高（high）' },
    { id: 'think', label: 'Deep think' },
  ]);
});

test('the default label names a default only when the native catalog reported one', () => {
  assert.equal(defaultEffortLabel('medium'), '模型默认：中（medium）');
  assert.equal(defaultEffortLabel(undefined), '模型默认');
});
