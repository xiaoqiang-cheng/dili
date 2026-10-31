import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { shellQuote } from './shell-quote.ts';
import { hasImageSignature } from './attachments.ts';
import { MAX_CHAT_ATTACHMENTS } from '../shared/attachments.ts';
import { MAX_TERMINAL_IMAGE_BYTES, TERMINAL_IMAGE_TYPES } from '../shared/terminal-images.ts';

const throughShell = (value: string) => execFileSync('sh', ['-c', `printf '%s' ${shellQuote(value)}`], { encoding: 'utf8' });

test('shell quoting keeps every metacharacter inside a single argv entry', () => {
  const payloads = [
    'plain-token',
    "it's fine",
    '$(touch /tmp/pwned)',
    '`id`; rm -rf /',
    'a && b || c | d > e < f',
    'line\nbreak\tand spaces',
    '"double" \'single\' \\backslash',
    '中文 与 emoji 🚀',
    '',
  ];
  for (const payload of payloads) assert.equal(throughShell(payload), payload);
});

test('shell quoting cannot be escaped by a quote inside the value', () => {
  const hostile = `'; touch /tmp/dili-injection-proof; echo '`;
  const output = throughShell(hostile);
  assert.equal(output, hostile);
  assert.equal(output.includes('\n'), false);
});

test('terminal image signatures reject a declared format mismatch', () => {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  const jpeg = Buffer.from([255, 216, 255, 0]);
  const gif = Buffer.from('GIF89a.......', 'ascii');
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP')]);
  assert.equal(hasImageSignature(png, 'image/png'), true);
  assert.equal(hasImageSignature(jpeg, 'image/jpeg'), true);
  assert.equal(hasImageSignature(gif, 'image/gif'), true);
  assert.equal(hasImageSignature(webp, 'image/webp'), true);
  assert.equal(hasImageSignature(jpeg, 'image/png'), false);
  assert.equal(hasImageSignature(png, 'image/gif'), false);
  assert.equal(hasImageSignature(Buffer.from('<svg onload=alert(1)>'), 'image/webp'), false);
  for (const type of TERMINAL_IMAGE_TYPES) assert.equal(hasImageSignature(Buffer.alloc(0), type), false);
});

test('upload limits stay explicit and small enough to bound memory', () => {
  assert.equal(MAX_CHAT_ATTACHMENTS, 8);
  assert.equal(MAX_TERMINAL_IMAGE_BYTES, 10 * 1024 * 1024);
  assert.deepEqual([...TERMINAL_IMAGE_TYPES], ['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
});
