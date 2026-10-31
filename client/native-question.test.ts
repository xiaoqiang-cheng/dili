import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nativeQuestionPending } from './native-question.ts';
import type { ConversationMessage } from '../shared/types.ts';

const question: ConversationMessage = { id: 'q', role: 'assistant', text: '**需要你回答的问题**\n\n1. 采用哪种方案？' };
const answer: ConversationMessage = { id: 'a', role: 'assistant', text: '已按方案 A 继续。' };

test('dsh only reports a pending question while the native detail says it waits for an answer', () => {
  assert.equal(nativeQuestionPending({ backend: 'dsh', status: 'waiting_input', statusDetail: 'DeepSeek Harness 正在等待你的回答' }, [question]), true);
  assert.equal(nativeQuestionPending({ backend: 'dsh', status: 'waiting_input', statusDetail: 'DeepSeek Harness 本轮已结束，可以继续或验收' }, [question]), false);
  assert.equal(nativeQuestionPending({ backend: 'dsh', status: 'running', statusDetail: 'DeepSeek Harness 正在执行' }, [question]), false);
});

test('Claude require both a waiting status and the question at the transcript tail', () => {
  assert.equal(nativeQuestionPending({ backend: 'claude', status: 'waiting_input', statusDetail: '原生会话正在等待你的输入' }, [question]), true);
  assert.equal(nativeQuestionPending({ backend: 'claude', status: 'waiting_input', statusDetail: '本轮回复已结束，可以继续或验收' }, [question]), false);
  assert.equal(nativeQuestionPending({ backend: 'claude', status: 'waiting_input', statusDetail: '原生会话正在等待你的输入' }, [question, answer]), false);
  assert.equal(nativeQuestionPending({ backend: 'claude', status: 'waiting_input', statusDetail: '原生会话正在等待你的输入' }, []), false);
});

test('non-native backends never get the native handoff notice', () => {
  assert.equal(nativeQuestionPending({ backend: 'codex', status: 'waiting_input', statusDetail: 'Codex 正在等待你的回答' }, [question]), false);
});
