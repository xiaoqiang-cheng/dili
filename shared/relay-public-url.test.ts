import assert from 'node:assert/strict';
import test from 'node:test';
import { relayPublicUrl } from './relay-public-url';

test('official browser links use the canonical origin and preserve share fragments and queries', () => {
  assert.equal(relayPublicUrl('https://discoverpaw.com/connect/d/abcdefghijklmnop/#/share/secret'), 'https://dili.discoverpaw.com/connect/d/abcdefghijklmnop/#/share/secret');
  assert.equal(relayPublicUrl('https://discoverpaw.com/connect/d/abcdefghijklmnop?machineHome=x#/contacts'), 'https://dili.discoverpaw.com/connect/d/abcdefghijklmnop?machineHome=x#/contacts');
  for (const value of ['https://custom.example/connect/d/abcdefghijklmnop/', 'http://127.0.0.1:4317/', 'https://discoverpaw.com/', 'https://discoverpaw.com/connect', 'https://discoverpaw.com/connect/d/invalid/', 'https://discoverpaw.com.evil.example/connect/d/abcdefghijklmnop/']) assert.equal(relayPublicUrl(value), value);
});
