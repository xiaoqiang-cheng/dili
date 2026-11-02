import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasShareMention, shareMentionAt } from './share-mentions';
test('share mentions follow the caret and do not select partial or deleted names', () => {
  assert.deepEqual(shareMentionAt('任务@协 后文', 4), { query: '协', start: 2, end: 4 });
  assert.equal(shareMentionAt('任务@协 ', 5), null);
  assert.equal(hasShareMention('@协作成员2 任务', '协作成员'), false);
  assert.equal(hasShareMention('@Claude Code 任务', 'Claude Code'), true);
  assert.equal(hasShareMention('任务@协作成员', '协作成员'), true);
  assert.equal(hasShareMention('已删除', '协作成员'), false);
});
