import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitMarkdownBlocks } from './markdown-blocks.ts';

test('plain text stays one block', () => {
  assert.deepEqual(splitMarkdownBlocks('hello'), ['hello']);
  assert.deepEqual(splitMarkdownBlocks('line one\nline two'), ['line one\nline two']);
  assert.deepEqual(splitMarkdownBlocks('   '), []);
});

test('splits before a heading after a blank line', () => {
  const text = 'intro paragraph\n\n## 第二步\n\nmore text';
  const blocks = splitMarkdownBlocks(text);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0], 'intro paragraph');
  assert.match(blocks[1], /^## 第二步/);
});

test('does not split on blanks inside a fenced code block', () => {
  const text = 'intro\n\n```sh\n# not a heading\n\nls\n```\n\nafter';
  const blocks = splitMarkdownBlocks(text);
  assert.equal(blocks.length, 2);
  assert.ok(blocks[1].includes('# not a heading\n\nls'));
  assert.ok(blocks[1].endsWith('after'));
});

test('splits before a fence that follows a blank line', () => {
  const text = 'intro\n\n```ts\nconst x = 1;\n```';
  const blocks = splitMarkdownBlocks(text);
  assert.equal(blocks.length, 2);
  assert.match(blocks[1], /^```ts/);
});

test('an unclosed fence keeps its remaining lines in one block', () => {
  const text = 'intro\n\n## heading\n\n```ts\nconst x = 1;';
  const blocks = splitMarkdownBlocks(text);
  assert.equal(blocks.length, 3);
  assert.match(blocks[2], /^```ts\nconst x = 1;$/);
});

test('lists and tables are not split', () => {
  const text = '1. one\n\n2. two\n\n| a | b |\n| --- | --- |\n| 1 | 2 |';
  assert.equal(splitMarkdownBlocks(text).length, 1);
});

test('handles CRLF input', () => {
  const blocks = splitMarkdownBlocks('intro\r\n\r\n## next\r\nbody');
  assert.equal(blocks.length, 2);
  assert.match(blocks[1], /## next/);
});
