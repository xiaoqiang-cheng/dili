import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, exportFileName, renderConversationHtml } from './export.ts';
import type { ConversationTranscript } from '../shared/types.ts';

const session = { title: '登录 <实现>', backend: 'codex' as const, cwd: '/repo/<script>', nativeSessionId: 'abc-123' };

test('escapeHtml neutralizes every HTML metacharacter', () => {
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
});

test('export renders messages, metadata and usage', () => {
  const transcript: ConversationTranscript = {
    truncated: false,
    messages: [
      { id: '1', role: 'user', text: '帮我修\n登录', createdAt: '2026-10-31T09:00:00.000Z' },
      { id: '2', role: 'assistant', text: '<img src=x onerror=alert(1)>' },
    ],
    usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1500, lastTurnInputTokens: 900, lastTurnOutputTokens: 300, turns: 2, model: 'm', partial: true },
  };
  const html = renderConversationHtml({ session, transcript, exportedAt: new Date('2026-10-31T12:00:00.000Z') });
  assert.match(html, /<title>登录 &lt;实现&gt; · Dili 对话导出<\/title>/);
  assert.match(html, /\/repo\/&lt;script&gt;/);
  assert.ok(!html.includes('<img src=x'));
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /帮我修\n登录/);
  assert.match(html, /2 轮 · 输入 1\.2k · 输出 300 · 最近窗口/);
  assert.match(html, /Content-Security-Policy" content="default-src 'none'/);
  assert.ok(!/<script/i.test(html));
});

test('an empty transcript keeps the notice instead of a blank page', () => {
  const html = renderConversationHtml({ session: { ...session, nativeSessionId: null }, transcript: { messages: [], truncated: false, notice: '原生历史尚未落盘' } });
  assert.match(html, /原生历史尚未落盘/);
  assert.match(html, /未识别/);
});

test('export file names are filesystem-safe', () => {
  assert.equal(exportFileName('a/b:c*d?', new Date('2026-10-31T00:00:00Z')), 'a-b-c-d-2026-10-31.html');
  assert.equal(exportFileName('   ', new Date('2026-10-31T00:00:00Z')), 'conversation-2026-10-31.html');
  assert.ok(exportFileName('名字'.repeat(60), new Date('2026-10-31T00:00:00Z')).length < 90);
});
