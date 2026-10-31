import test from 'node:test';
import assert from 'node:assert/strict';
import { dshWebTransport, executionMode } from './execution.ts';

test('dsh web delivery follows the contact transport, not the installed terminal', () => {
  assert.equal(dshWebTransport({ backend: 'dsh', executionTransport: 'web' }), true);
  assert.equal(dshWebTransport({ backend: 'dsh', executionTransport: 'pty' }), false);
  assert.equal(dshWebTransport({ backend: 'dsh' }), false, 'missing transport must not be treated as native Web');
  assert.equal(dshWebTransport({ backend: 'claude', executionTransport: 'web' }), false);
  assert.equal(dshWebTransport({ backend: 'codex', executionTransport: 'web' }), false);
});

test('execution mode rejects anything outside default and auto', () => {
  assert.equal(executionMode(undefined), 'default');
  assert.equal(executionMode('auto'), 'auto');
  assert.throws(() => executionMode('danger'), /仅支持/);
});
