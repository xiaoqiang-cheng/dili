import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { zstdCompressSync } from 'node:zlib';
import { ConversationReader, conversationPreview, handoffPrompt, type ConversationSession } from './conversation.ts';
import { DshBridge } from './dsh.ts';

const date = '2026-09-29T08:00:00.000Z';
function contact(backend: ConversationSession['backend'], id = randomUUID()): ConversationSession {
  return { backend, nativeSessionId: backend === 'dsh' ? `session-${id}` : id, forkPending: false, cwd: '/workspace/project' };
}
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'sessiondeck-conversation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = { claudeHome: join(root, 'claude'), codexHome: join(root, 'codex'), dshHome: join(root, 'dsh') };
  const file = async (session: ConversationSession, values: unknown[], compressed = false) => {
    const path = session.backend === 'claude' ? join(paths.claudeHome, 'projects', '-workspace-project', `${session.nativeSessionId}.jsonl`)
      : session.backend === 'codex' ? join(paths.codexHome, 'sessions', '2026', '09', '29', `rollout-${session.nativeSessionId}.jsonl`)
      : join(paths.dshHome, 'sessions', '--workspace-project--', session.nativeSessionId!, `session.jsonl${compressed ? '.zstd' : ''}`);
    await mkdir(join(path, '..'), { recursive: true });
    const content = values.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join('\n') + '\n';
    await writeFile(path, compressed ? Buffer.concat(content.trimEnd().split('\n').map(line => zstdCompressSync(Buffer.from(line + '\n')))) : content);
    return path;
  };
  return { root, paths, file, reader: new ConversationReader({ ...paths, cacheMs: 0 }) };
}
function claude(role: 'user' | 'assistant', content: unknown, extra = {}) { return { type: role, uuid: randomUUID(), timestamp: date, message: { role, content }, ...extra }; }
function codexHeader(id: string) { return { type: 'session_meta', payload: { id, cwd: '/workspace/project' } }; }
function dshMessage(seq: number, role: 'user' | 'assistant', text: string, source = role === 'user' ? 'user' : 'model') {
  const message = { role, source: { kind: source }, content: [{ type: 'text', text }] };
  return { type: `${role}/message`, seq, time: Date.parse(date) + seq, surfaceOp: 'append', data: role === 'user' ? message : { turn: 1, step: seq, message } };
}

test('Claude conversation reads only exact native file and human/assistant text', async t => {
  const { file, reader } = await fixture(t), a = contact('claude'), b = contact('claude');
  await file(a, [
    claude('user', '请修复登录按钮'),
    claude('assistant', [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: '我来检查。' }, { type: 'tool_use', input: { secret: 'hidden tool' } }]),
    claude('user', [{ type: 'tool_result', content: 'hidden result' }]),
    claude('user', 'hidden summary', { isCompactSummary: true }),
    claude('user', 'hidden meta', { isMeta: true }),
    claude('user', 'hidden agent', { isSidechain: true }),
    claude('user', 'hidden wrong identity', { sessionId: b.nativeSessionId }),
    claude('user', '<command-name>/clear</command-name>'),
    '{bad row',
    claude('user', [{ type: 'text', text: '然后增加键盘操作' }, { type: 'image', source: { data: 'hidden bytes' } }]),
    claude('assistant', '已完成。'),
  ]);
  await file(b, [claude('user', 'different session secret')]);
  const result = await reader.read(a);
  assert.deepEqual(result.messages.map(message => [message.role, message.text]), [['user', '请修复登录按钮'], ['assistant', '我来检查。'], ['user', '然后增加键盘操作'], ['assistant', '已完成。']]);
  assert.equal(result.truncated, false);
  assert.equal(result.messages[0].createdAt, date);
  assert.equal(await reader.preview(a), '然后增加键盘操作');
  assert.equal(JSON.stringify(result).includes('hidden'), false);
  assert.equal((await reader.read(b)).messages[0].text, 'different session secret');
});

test('Claude AskUserQuestion tool input is shown as readable conversation content', async t => {
  const { file, reader } = await fixture(t), a = contact('claude');
  await file(a, [claude('user', '请继续实现'), claude('assistant', [
    { type: 'text', text: '有一个实现选择需要确认。' },
    { type: 'tool_use', name: 'AskUserQuestion', input: { questions: [{ question: '使用哪种存储？', header: '持久化', options: [{ label: 'SQLite', description: '本地单文件' }, { label: 'JSON', description: '简单但并发较弱' }] }] } },
  ])]);
  const result = await reader.read(a);
  assert.equal(result.messages.at(-1)?.text, '有一个实现选择需要确认。\n\n**需要你回答的问题**\n\n1. **持久化**\n\n使用哪种存储？\n   - SQLite — 本地单文件\n   - JSON — 简单但并发较弱');
});

test('Codex uses native user events and excludes duplicate input, system, tools and model reasoning', async t => {
  const { file, reader } = await fixture(t), a = contact('codex');
  await file(a, [codexHeader(a.nativeSessionId!),
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for /workspace\nsecret instructions' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '真实用户问题' }] } },
    { type: 'event_msg', timestamp: date, payload: { type: 'user_message', message: '真实用户问题' } },
    { type: 'response_item', payload: { type: 'reasoning', summary: [{ text: 'hidden reasoning' }] } },
    { type: 'response_item', payload: { type: 'function_call_output', output: 'hidden output' } },
    { type: 'response_item', timestamp: date, payload: { id: 'answer-1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '已找到解决办法' }] } },
    { type: 'event_msg', payload: { type: 'agent_message', message: '已找到解决办法' } },
  ]);
  const result = await reader.read(a);
  assert.deepEqual(result.messages.map(message => message.text), ['真实用户问题', '已找到解决办法']);
  assert.equal(result.messages[0].role, 'user');
  assert.equal(result.messages[1].role, 'assistant');
});

test('legacy Codex user input fallback rejects AGENTS and environment context', async t => {
  const { file, reader } = await fixture(t), a = contact('codex');
  await file(a, [codexHeader(a.nativeSessionId!), ...['# AGENTS.md instructions for /tmp\nprivate', '<environment_context>private</environment_context>', '<permissions instructions>private</permissions instructions>', '实际用户输入'].map(text => ({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }))]);
  assert.deepEqual((await reader.read(a)).messages.map(message => message.text), ['实际用户输入']);
});

test('Codex rejects mismatched rollout identity even when its filename names the requested session', async t => {
  const { file, reader } = await fixture(t), a = contact('codex');
  await file(a, [codexHeader(randomUUID()), { type: 'event_msg', payload: { type: 'user_message', message: 'other session secret' } }]);
  const result = await reader.read(a);
  assert.equal(result.messages.length, 0);
  assert.match(result.notice!, /身份不匹配/);
});

test('Codex follows resumed rollout segments using the original thread ID, never the writer suffix', async t => {
  const { paths, file } = await fixture(t), a = contact('codex'), writerId = randomUUID();
  const original = await file(a, [codexHeader(a.nativeSessionId!), { type: 'event_msg', timestamp: date, payload: { type: 'user_message', message: 'old prompt' } }]);
  const oldPath = join(original, '..', `rollout-2026-09-29T08-00-00-${a.nativeSessionId}.jsonl`);
  await rename(original, oldPath);
  const reader = new ConversationReader({ ...paths, cacheMs: 0, indexMs: 0 });
  assert.equal(await reader.preview(a), 'old prompt');
  const resumed = join(original, '..', `rollout-2026-09-30T08-00-00-${a.nativeSessionId}_${writerId}.jsonl`);
  await writeFile(resumed, [codexHeader(a.nativeSessionId!), { type: 'response_item', timestamp: '2026-09-30T08:00:00.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'latest resumed prompt' }] } }].map(row => JSON.stringify(row)).join('\n') + '\n');
  assert.equal(await reader.preview(a), 'latest resumed prompt');
  assert.equal((await reader.read(contact('codex', writerId))).messages.length, 0);
});

test('Codex rechecks the native database rollout path after a resumed writer replaces it', async t => {
  const { paths, file, reader } = await fixture(t), a = contact('codex');
  const original = await file(a, [codexHeader(a.nativeSessionId!), { type: 'event_msg', payload: { type: 'user_message', message: 'old indexed prompt' } }]);
  const db = new DatabaseSync(join(paths.codexHome, 'state_5.sqlite'));
  t.after(() => db.close());
  db.exec('CREATE TABLE threads (id TEXT, rollout_path TEXT)');
  db.prepare('INSERT INTO threads VALUES (?, ?)').run(a.nativeSessionId, original);
  assert.equal(await reader.preview(a), 'old indexed prompt');
  const resumed = join(original, '..', `rollout-2026-09-30T08-00-00-${a.nativeSessionId}_${randomUUID()}.jsonl`);
  await writeFile(resumed, [codexHeader(a.nativeSessionId!), { type: 'event_msg', payload: { type: 'user_message', message: 'new database path prompt' } }].map(row => JSON.stringify(row)).join('\n') + '\n');
  db.prepare('UPDATE threads SET rollout_path = ? WHERE id = ?').run(resumed, a.nativeSessionId);
  assert.equal(await reader.preview(a), 'new database path prompt');
});

test('latest human input survives a tool-heavy turn that pushes it out of the tail byte window', async t => {
  const { paths, file } = await fixture(t);
  for (const backend of ['claude', 'codex'] as const) {
    const a = contact(backend);
    const prompt = backend === 'claude' ? claude('user', 'actual last human input') : { type: 'event_msg', timestamp: date, payload: { type: 'user_message', message: 'actual last human input' } };
    await file(a, [...(backend === 'codex' ? [codexHeader(a.nativeSessionId!)] : []), prompt,
      ...Array.from({ length: 12 }, () => ({ type: 'tool_output', data: 'x'.repeat(2000) })),
      ...(backend === 'claude' ? [claude('assistant', 'done')] : []),
    ]);
    const reader = new ConversationReader({ ...paths, cacheMs: 0, maxBytes: 1024 });
    assert.equal(await reader.preview(a), 'actual last human input');
  }
});

test('pending forks and malformed IDs cannot read their parent or arbitrary files', async t => {
  const { file, reader } = await fixture(t), a = contact('claude');
  await file(a, [claude('user', 'parent private request')]);
  assert.equal((await reader.read({ ...a, forkPending: true })).messages.length, 0);
  assert.equal((await reader.read({ ...a, nativeSessionId: '../../outside' })).messages.length, 0);
  assert.equal((await reader.read({ ...a, nativeSessionId: null })).messages.length, 0);
  assert.equal((await reader.read(a)).messages.length, 1);
});

test('native symlinks and Codex index paths outside its owned history are not followed', async t => {
  const { root, file, paths, reader } = await fixture(t), a = contact('claude'), codex = contact('codex');
  const outside = join(root, `${a.nativeSessionId}.jsonl`);
  await writeFile(outside, JSON.stringify(claude('user', 'outside secret')));
  const placeholder = await file(a, []);
  await rm(placeholder);
  await symlink(outside, placeholder);
  await mkdir(paths.codexHome, { recursive: true });
  const db = new DatabaseSync(join(paths.codexHome, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT, rollout_path TEXT)');
  db.prepare('INSERT INTO threads VALUES (?, ?)').run(codex.nativeSessionId, outside);
  db.close();
  assert.equal((await reader.read(a)).messages.length, 0);
  assert.equal((await reader.read(codex)).messages.length, 0);
});

test('bounded tail read skips partial and malformed records and caps message count/text', async t => {
  const { paths, file } = await fixture(t), a = contact('codex');
  await file(a, [codexHeader(a.nativeSessionId!), { type: 'unused', content: 'x'.repeat(4000) }, '{bad tail row',
    ...Array.from({ length: 8 }, (_, index) => ({ type: 'event_msg', payload: { type: 'user_message', message: `new message ${index}` } })),
  ]);
  const reader = new ConversationReader({ ...paths, maxBytes: 1024, maxMessages: 3 });
  const result = await reader.read(a);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.messages.map(message => message.text), ['new message 5', 'new message 6', 'new message 7']);
  assert.match(result.notice!, /部分对话/);
  const huge = contact('claude');
  await file(huge, [claude('user', '长'.repeat(50_000))]);
  const hugeResult = await new ConversationReader(paths).read(huge);
  assert.equal(hugeResult.truncated, true);
  assert.equal(hugeResult.messages[0].text.length, 24_000);
  assert.equal(Array.from(conversationPreview(hugeResult)!.text).length, 240);
});

test('unchanged files reuse a parsed result and appended records refresh previews', async t => {
  const { file, reader } = await fixture(t), a = contact('claude');
  const path = await file(a, [claude('user', 'first')]);
  const first = await reader.read(a);
  assert.equal(await reader.read(a), first);
  await appendFile(path, JSON.stringify(claude('user', 'second')) + '\n');
  const second = await reader.read(a);
  assert.notEqual(second, first);
  assert.equal(conversationPreview(second)?.text, 'second');
  assert.equal(await reader.read(a), second);
});

test('transport handoff bypasses stale transcript and missing-file caches', async t => {
  const { file, paths } = await fixture(t), a = contact('claude');
  const reader = new ConversationReader({ ...paths, cacheMs: 60_000, indexMs: 60_000 });
  assert.equal((await reader.read(a)).messages.length, 0);
  const path = await file(a, [claude('user', 'first')]);
  assert.equal((await reader.read(a)).messages.length, 0);
  assert.equal((await reader.readLatest(a)).messages[0].text, 'first');
  await appendFile(path, JSON.stringify(claude('assistant', 'saved after last poll')) + '\n');
  assert.equal((await reader.read(a)).messages.length, 1);
  assert.equal((await reader.readLatest(a)).messages.at(-1)?.text, 'saved after last poll');
});

test('large assistant turns retain the latest user preview within the total text and message budgets', async t => {
  const { paths, file } = await fixture(t), a = contact('claude');
  await file(a, [claude('user', 'Keep this actual latest request'), ...Array.from({ length: 30 }, (_, index) => claude('assistant', `${index}:` + 'a'.repeat(23_995)))]);
  const large = await new ConversationReader(paths).read(a);
  assert.equal(large.truncated, true);
  assert.ok(large.messages.reduce((total, message) => total + message.text.length, 0) <= 512_000);
  assert.equal(conversationPreview(large)?.text, 'Keep this actual latest request');
  const few = await new ConversationReader({ ...paths, maxMessages: 3 }).read(a);
  assert.equal(few.messages.length, 3);
  assert.equal(conversationPreview(few)?.text, 'Keep this actual latest request');
  assert.ok(few.messages.at(-1)?.text.startsWith('29:'));
});

test('a shared native index avoids rescanning for every missing card', async t => {
  const { file, reader } = await fixture(t), a = contact('claude'), b = contact('claude');
  await file(a, [claude('user', 'first')]);
  await reader.read(a);
  await file(b, [claude('user', 'new indexed later')]);
  assert.equal((await reader.read(b)).messages.length, 0);
});

test('DeepSeek offline plaintext and compressed histories exclude injected and replacement context', async t => {
  const { file, paths } = await fixture(t);
  for (const compressed of [false, true]) {
    const a = contact('dsh');
    await file(a, [{ type: 'session', id: a.nativeSessionId, cwd: a.cwd },
      dshMessage(1, 'user', 'direct human request'), dshMessage(2, 'user', 'hidden plugin instructions', 'plugin'),
      { ...dshMessage(3, 'user', 'hidden compact copy'), surfaceOp: { op: 'replace', start: 0, end: 1 } },
      { type: 'tool/result', seq: 4, data: { message: { role: 'user', content: [{ type: 'text', text: 'hidden tool result' }] } } },
      dshMessage(5, 'assistant', 'visible assistant reply'),
    ], compressed);
    const result = await new ConversationReader(paths).read(a);
    assert.deepEqual(result.messages.map(message => message.text), ['direct human request', 'visible assistant reply']);
  }
});

test('a compressed DeepSeek log past the old 2MB tail-window size still decodes whole, is cached, and only a truly oversized log is deferred to the native service', async t => {
  const { file, paths } = await fixture(t), a = contact('dsh');
  // Many ordinary-sized messages inflate the compressed file past the old
  // 2MB ceiling while staying a single-digit-megabyte log, like an actively
  // used real session; high-entropy text keeps it from compressing away.
  const values: unknown[] = [{ type: 'session', id: a.nativeSessionId, cwd: a.cwd }];
  for (let seq = 1; seq <= 400; seq++) values.push(dshMessage(seq, seq % 2 ? 'user' : 'assistant', `turn ${seq}: ${randomBytes(6_000).toString('base64')}`));
  values.push(dshMessage(401, 'assistant', 'visible assistant reply'));
  const path = await file(a, values, true);
  assert.ok((await stat(path)).size > 2 * 1024 * 1024, 'fixture did not exceed the old 2MB ceiling');
  const reader = new ConversationReader(paths);
  const result = await reader.read(a);
  assert.equal(result.messages.at(-1)?.text, 'visible assistant reply');
  // 400 generated turns exceed finish()'s own 200-message window; that is
  // its own, unrelated bound and is not what this test is about.
  assert.ok(result.messages.length > 1);
  assert.notEqual(result.notice, '原生压缩历史较大，请先打开 DeepSeek 原生界面，再刷新对话。');
  // Re-reading an unchanged file must reuse the cached transcript, not re-decode.
  const again = await reader.read(a);
  assert.equal(again, result);
  // A log past the generous hard ceiling still defers to the native service
  // instead of decoding an abnormally large file in the server process.
  const strict = new ConversationReader({ ...paths, maxCompressedBytes: 1024 });
  const deferred = await strict.read(a);
  assert.equal(deferred.messages.length, 0);
  assert.match(deferred.notice ?? '', /请先打开 DeepSeek 原生界面/);
});

test('DeepSeek ask_user_question tool calls appear in the conversation transcript', async t => {
  const { file, reader } = await fixture(t), a = contact('dsh');
  await file(a, [{ type: 'session', id: a.nativeSessionId, cwd: a.cwd },
    { type: 'tool/call', seq: 8, time: Date.parse(date) + 8, surfaceOp: 'append', data: { callId: 'question-1', name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'q1', question: '是否保留旧接口？', detail: '这会影响现有客户端。', options: [{ label: '保留' }, { label: '删除', description: '需要同步迁移' }] }] }) } },
  ]);
  const result = await reader.read(a);
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].role, 'assistant');
  assert.match(result.messages[0].text, /是否保留旧接口？/);
  assert.match(result.messages[0].text, /删除 — 需要同步迁移/);
});

test('DeepSeek live history is cached, bounded and never called for a pending fork', async t => {
  const { paths } = await fixture(t), a = contact('dsh');
  let calls = 0;
  const reader = new ConversationReader({ ...paths, dshHistory: async id => {
    assert.equal(id, a.nativeSessionId); calls++;
    return { events: [dshMessage(1, 'user', 'live request'), dshMessage(2, 'assistant', 'live answer')].map(event => ({ event })), hasMore: true };
  } });
  const result = await reader.read(a);
  assert.equal(result.truncated, true);
  assert.equal(await reader.preview(a), 'live request');
  assert.equal(calls, 1);
  assert.equal((await reader.read({ ...a, forkPending: true })).messages.length, 0);
  assert.equal(calls, 1);
});

test('reading DeepSeek history while stopped never starts its native service', async () => {
  const bridge = new DshBridge();
  let started = false;
  bridge.start = async () => { started = true; throw new Error('Must not start'); };
  assert.equal(await bridge.readHistory(`session-${randomUUID()}`), undefined);
  assert.equal(started, false);
  await bridge.close();
});

test('preview collapses whitespace and preserves whole Unicode characters', () => {
  const result = conversationPreview({ messages: [{ id: 'u', role: 'user', text: '\n\t' + '🙂'.repeat(250), createdAt: date }], truncated: false });
  assert.equal(Array.from(result!.text).length, 240);
  assert.equal(result!.text.endsWith('…'), true);
  assert.equal(result!.text.includes('\ufffd'), false);
  assert.equal(result!.createdAt, date);
});

test('handoff prompt carries bounded portable context and target platform', () => {
  const prompt = handoffPrompt({ id: 'source', backend: 'codex', title: '登录任务', cwd: '/work/app' }, {
    messages: [{ id: 'u', role: 'user', text: '请继续实现登录流程' }, { id: 'a', role: 'assistant', text: '已经完成接口草稿' }], truncated: false,
  }, 'claude', '先检查测试并继续实现');
  assert.match(prompt, /来源平台：Codex/);
  assert.match(prompt, /目标平台：Claude Code/);
  assert.match(prompt, /工作目录：\/work\/app/);
  assert.match(prompt, /先检查测试并继续实现/);
  assert.match(prompt, /请继续实现登录流程/);
});

test('Claude pages preserve exact IDs and Unicode in bounded chronological pages while new records append', async t => {
  const { file, reader } = await fixture(t), session = contact('claude');
  const records = Array.from({ length: 103 }, (_, i) => claude(i % 2 ? 'assistant' : 'user', `第 ${i} 条🙂`));
  const path = await file(session, records);
  let page = await reader.readClaudePage(session.nativeSessionId!);
  assert.equal(page.items.length, 40);
  assert.equal(page.items[0].text, '第 63 条🙂');
  assert.equal(page.truncated, false);
  const items = [...page.items];
  await appendFile(path, JSON.stringify(claude('user', 'new append')) + '\n');
  while (page.nextCursor) {
    page = await reader.readClaudePage(session.nativeSessionId!, page.nextCursor);
    assert.ok(page.items.length <= 40);
    items.unshift(...page.items);
  }
  assert.deepEqual(items.map(item => item.text), records.map(row => row.message.content));
  assert.equal(new Set(items.map(item => item.id)).size, 103);
  assert.equal(items[0].id, `claude:${session.nativeSessionId}:${records[0].uuid}`);
});

test('Claude cursor rejects tampering, other identities, restarts, truncation, replacement and symlinks', async t => {
  const { file, reader, paths } = await fixture(t), session = contact('claude'), other = contact('claude');
  const records = Array.from({ length: 45 }, () => claude('user', 'safe message'));
  const path = await file(session, records);
  await file(other, records);
  const cursor = (await reader.readClaudePage(session.nativeSessionId!)).nextCursor!;
  const stale = (job: Promise<unknown>) => assert.rejects(job, { status: 409 });
  await stale(reader.readClaudePage(other.nativeSessionId!, cursor));
  await stale(reader.readClaudePage(session.nativeSessionId!, cursor + 'x'));
  await stale(reader.readClaudePage(session.nativeSessionId!, cursor.split('.')[0] + '.' + '中'.repeat(43)));
  await stale(new ConversationReader(paths).readClaudePage(session.nativeSessionId!, cursor));
  await writeFile(path, '');
  await stale(reader.readClaudePage(session.nativeSessionId!, cursor));
  await file(session, records);
  const fresh = (await reader.readClaudePage(session.nativeSessionId!)).nextCursor!;
  await rename(path, path + '.old');
  await file(session, records);
  await stale(reader.readClaudePage(session.nativeSessionId!, fresh));
  await rm(path);
  await symlink(path + '.old', path);
  await stale(reader.readClaudePage(session.nativeSessionId!, fresh));
  assert.deepEqual((await reader.readClaudePage(session.nativeSessionId!)).items, []);
});

test('Claude byte-window pages skip giant tool records, progress through empty pages and ignore torn tails', async t => {
  const { file, paths } = await fixture(t), session = contact('claude');
  const reader = new ConversationReader({ ...paths, maxBytes: 1024 });
  const path = await file(session, [claude('user', '最早🙂'), { type: 'progress', data: 'X'.repeat(6000) }, claude('assistant', '最近🙂')]);
  await appendFile(path, JSON.stringify(claude('user', 'not committed yet'))); // no final newline
  let page = await reader.readClaudePage(session.nativeSessionId!);
  const texts = page.items.map(item => item.text);
  assert.equal(page.truncated, true);
  let calls = 1, emptyPages = 0;
  const cursors = new Set<string>();
  while (page.nextCursor) {
    assert.ok(!cursors.has(page.nextCursor)); cursors.add(page.nextCursor);
    page = await reader.readClaudePage(session.nativeSessionId!, page.nextCursor);
    texts.unshift(...page.items.map(item => item.text));
    if (!page.items.length) emptyPages++;
    assert.ok(++calls < 15);
  }
  assert.deepEqual(texts, ['最早🙂', '最近🙂']);
  assert.ok(emptyPages > 0);
});

test('Claude page text budgets do not lose the next message and image-only prompts survive restoration', async t => {
  const { file, reader } = await fixture(t), session = contact('claude');
  const records = Array.from({ length: 25 }, (_, i) => claude('user', `${i}:` + '文'.repeat(24001)));
  await file(session, [...records, claude('user', [{ type: 'image', source: { data: 'private image bytes' } }])]);
  let page = await reader.readClaudePage(session.nativeSessionId!);
  const items = [...page.items];
  assert.ok(page.truncated);
  assert.equal(items.at(-1)?.text, '[图片]');
  assert.equal(items.at(-1)?.imageCount, 1);
  while (page.nextCursor) {
    page = await reader.readClaudePage(session.nativeSessionId!, page.nextCursor);
    assert.ok(page.items.reduce((sum, item) => sum + item.text.length, 0) <= 512000);
    items.unshift(...page.items);
  }
  assert.equal(items.length, 26);
  assert.equal(new Set(items.map(item => item.id)).size, 26);
  assert.equal(JSON.stringify(items).includes('private image bytes'), false);
});

test('Claude fresh page handles empty history and discovers newly created exact logs', async t => {
  const { file, reader } = await fixture(t), session = contact('claude');
  assert.equal((await reader.readClaudePage(session.nativeSessionId!)).nextCursor, null);
  const path = await file(session, []);
  await writeFile(path, '');
  assert.equal((await reader.readClaudePage(session.nativeSessionId!)).items.length, 0);
  await file(session, [claude('user', 'just saved')]);
  assert.equal((await reader.readClaudePage(session.nativeSessionId!)).items[0].text, 'just saved');
});
