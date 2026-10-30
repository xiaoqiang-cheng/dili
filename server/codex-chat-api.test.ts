import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { copyFile, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import type { AppState, Delivery, Group, GroupDirectoryResponse, GroupDetail, GroupMessage, Session } from '../shared/types.ts';
import type { CodexChatSnapshot, CodexChatSubmission, AgentChatSettings } from '../shared/chat.ts';

async function freePort() {
  const probe = createServer();
  await new Promise<void>(accept => probe.listen(0, '127.0.0.1', accept));
  const address = probe.address(); assert.ok(address && typeof address === 'object');
  await new Promise<void>(accept => probe.close(() => accept()));
  return address.port;
}
async function until(check: () => Promise<boolean>, description: string, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(25); }
  throw new Error(description);
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(accept => child.once('exit', () => accept()));
  const kill = setTimeout(() => child.kill('SIGKILL'), 4000);
  child.kill('SIGTERM');
  try { await exited; } finally { clearTimeout(kill); }
}
type Call = { method?: string; event?: string; nativeId?: string; id?: string; params?: { threadId?: string; input?: unknown[] }; result?: unknown };

async function launch(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'sessiondeck-codex-chat-api-'));
  const executable = join(directory, 'codex.cjs');
  await copyFile(resolve('scripts/fixtures/codex-chat-protocol.cjs'), executable); await chmod(executable, 0o700);
  const claude = join(directory,'claude.cjs');
  await copyFile(resolve('scripts/fixtures/claude-chat-protocol.cjs'), claude); await chmod(claude, 0o700);
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'TZ']) if (process.env[key]) env[key] = process.env[key];
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: resolve('.'), env: { ...env, SESSIONDECK_PORT: String(port), SESSIONDECK_DEMO: '0', SESSIONDECK_DATA_DIR: join(directory, 'data'), SESSIONDECK_CODEX_PORT: '0', SESSIONDECK_CODEX_BIN: executable, SESSIONDECK_CLAUDE_BIN: claude, SESSIONDECK_DSH_BIN: '/missing-dsh-fixture', SESSIONDECK_FIXTURE_DIR: directory, SESSIONDECK_FIXTURE_WS: createRequire(import.meta.url).resolve('ws'), CODEX_HOME: join(directory, 'codex-home'), CLAUDE_CONFIG_DIR: join(directory, 'claude-home') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout?.on('data', data => { logs = (logs + data).slice(-8000); }); child.stderr?.on('data', data => { logs = (logs + data).slice(-8000); });
  const streams = new Set<AbortController>();
  t.after(async () => { for (const stream of streams) stream.abort(); await stop(child); await rm(directory, { recursive: true, force: true }); });
  await until(async () => { if (child.exitCode !== null) throw new Error(logs); try { return (await fetch(base + '/api/config')).ok; } catch { return false; } }, 'Fixture HTTP service did not start');
  const { csrfToken } = await (await fetch(base + '/api/config')).json() as { csrfToken: string };
  const request = async <T>(path: string, method = 'GET', data?: unknown, expected: number | number[] = 200): Promise<T> => {
    const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-sessiondeck-token': csrfToken }, ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal: AbortSignal.timeout(12_000) });
    const result = await response.json();
    assert.ok((Array.isArray(expected) ? expected : [expected]).includes(response.status), `${path} returned ${response.status}: ${JSON.stringify(result)}`);
    return result as T;
  };
  const calls = async (): Promise<Call[]> => (await readFile(join(directory, 'calls.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  const stream = async (id: string) => {
    const controller = new AbortController(); streams.add(controller);
    const response = await fetch(`${base}/api/sessions/${id}/chat/events`, { signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /text\/event-stream/);
    const result = { text: '' };
    void (async () => { const reader = response.body!.getReader(); try { for (;;) { const data = await reader.read(); if (data.done) break; result.text += new TextDecoder().decode(data.value); } } catch { /* Test cleanup aborts open SSE. */ } finally { reader.releaseLock(); } })();
    return result;
  };
  const create = (title: string) => request<Session>('/api/sessions', 'POST', { backend: 'codex', title, cwd: directory }, 201);
  const snapshot = (id: string) => request<CodexChatSnapshot>(`/api/sessions/${id}/chat`);
  const current = async (id: string) => (await request<AppState>('/api/state')).sessions.find(session => session.id === id)!;
  return { directory, request, calls, stream, create, snapshot, current, base, csrfToken };
}

test('archive stops a graphical Codex turn, preserves history, and leaves other threads running', { timeout: 30_000 }, async t => {
  const f = await launch(t), { request, snapshot, current, calls } = f;
  const source = await f.create('Archive target'), other = await f.create('Keep running');
  const started = await request<Session>(`/api/sessions/${source.id}/start`, 'POST', { mode: 'chat' });
  await request(`/api/sessions/${other.id}/start`, 'POST', { mode: 'chat' });
  await request(`/api/sessions/${source.id}/chat/messages`, 'POST', { requestId: randomUUID(), text: 'HOLD archive context' });
  await until(async () => !!(await snapshot(source.id)).activeTurnId, 'Target turn did not start');
  const archived = await request<Session>(`/api/sessions/${source.id}`, 'PATCH', { archived: true });
  assert.equal(archived.archived, true); assert.equal(archived.running, false); assert.equal(archived.status, 'stopped');
  assert.equal(archived.nativeSessionId, started.nativeSessionId);
  assert.equal((await current(other.id)).running, true);
  assert.ok((await calls()).some(call => call.method === 'turn/interrupt' && call.params?.threadId === started.nativeSessionId));
  assert.ok((await snapshot(source.id)).items.some(item => item.text.includes('HOLD archive context')));
  await request(`/api/sessions/${source.id}/start`, 'POST', { mode: 'chat' }, 400);
  const restored = await request<Session>(`/api/sessions/${source.id}`, 'PATCH', { archived: false });
  assert.equal(restored.running, false); assert.equal(restored.nativeSessionId, started.nativeSessionId);
  const resumed = await request<Session>(`/api/sessions/${source.id}/start`, 'POST', { mode: 'chat' });
  assert.equal(resumed.nativeSessionId, started.nativeSessionId);
  assert.ok((await snapshot(source.id)).items.some(item => item.text.includes('HOLD archive context')));
});

test('archive failure keeps the contact visible and shutdown locks out concurrent lifecycle changes', { timeout: 30_000 }, async t => {
  const f = await launch(t), { request, snapshot, current } = f;
  const source = await f.create('Archive interruption failure');
  await request(`/api/sessions/${source.id}/start`, 'POST', { mode: 'chat' });
  await request(`/api/sessions/${source.id}/chat/messages`, 'POST', { requestId: randomUUID(), text: 'HOLD' });
  await until(async () => !!(await snapshot(source.id)).activeTurnId, 'Target turn did not start');
  await writeFile(join(f.directory, 'fail-interrupt'), '1');
  await request(`/api/sessions/${source.id}`, 'PATCH', { archived: true }, 400);
  const failed = await current(source.id);
  assert.equal(failed.archived, false); assert.equal(failed.running, true);
  assert.match(failed.statusDetail, /停止未完成.*Fixture interrupt rejected/);
  await rm(join(f.directory, 'fail-interrupt'));
  await writeFile(join(f.directory, 'hold-interrupt'), '1');
  const archiving = request<Session>(`/api/sessions/${source.id}`, 'PATCH', { archived: true });
  // Consume a possible rejection immediately, while still checking its result below.
  void archiving.catch(() => {});
  try {
    await until(async () => (await f.calls()).some(call => call.event === 'interrupt-held'), 'Archive did not enter native shutdown');
    const stopping = await current(source.id);
    assert.equal(stopping.archived, false, 'Do not hide a contact before shutdown completes');
    await request(`/api/sessions/${source.id}/start`, 'POST', { mode: 'chat' }, 409);
    await request(`/api/sessions/${source.id}`, 'PATCH', { archived: false }, 409);
    await request(`/api/sessions/${source.id}`, 'PATCH', { archived: true }, 409);
  } finally { await rm(join(f.directory, 'hold-interrupt')); }
  const archived = await archiving;
  assert.equal(archived.archived, true); assert.equal(archived.running, false);
});

test('archive closes a graphical Claude process without losing its saved native history', { timeout: 30_000 }, async t => {
  const f = await launch(t), { request, snapshot } = f;
  const source = await request<Session>('/api/sessions', 'POST', { backend: 'claude', title: 'Claude archive', cwd: f.directory }, 201);
  const started = await request<Session>(`/api/sessions/${source.id}/start`, 'POST', { mode: 'chat' });
  await request(`/api/sessions/${source.id}/chat/messages`, 'POST', { requestId: randomUUID(), text: 'HOLD' });
  await until(async () => !!(await snapshot(source.id)).activeTurnId, 'Claude turn did not start');
  const archived = await request<Session>(`/api/sessions/${source.id}`, 'PATCH', { archived: true });
  assert.equal(archived.archived, true); assert.equal(archived.running, false); assert.equal(archived.status, 'stopped');
  assert.equal(archived.nativeSessionId, started.nativeSessionId);
  const saved = await readFile(join(f.directory, 'claude-home', 'projects', 'fixture', `${started.nativeSessionId}.jsonl`), 'utf8');
  assert.match(saved, /HOLD/);
  const launches = (await readFile(join(f.directory, 'claude-print-launches.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { pid: number; args: string[] });
  const native = launches.find(launch => launch.args.includes(started.nativeSessionId!));
  assert.ok(native);
  assert.throws(() => process.kill(native.pid, 0), { code: 'ESRCH' }, 'Archive must wait for the Claude process to exit');
  const restored = await request<Session>(`/api/sessions/${source.id}`, 'PATCH', { archived: false });
  assert.equal(restored.running, false);
  const resumed = await request<Session>(`/api/sessions/${source.id}/start`, 'POST', { mode: 'chat' });
  assert.equal(resumed.nativeSessionId, started.nativeSessionId);
  assert.ok((await snapshot(source.id)).items.some(item => item.text.includes('HOLD')));
});

test('graphical Codex starts without a TUI, streams once per request ID, and attaches the exact native thread', { timeout: 30_000 }, async t => {
  const fixture = await launch(t), { request, calls, snapshot } = fixture;
  const source = await fixture.create('Graphical native source');
  assert.equal((await snapshot(source.id)).connected, false);
  const events = await fixture.stream(source.id);
  assert.equal((await calls()).filter(call => call.method === 'thread/start').length, 0, 'Reading the panel must not start an agent');
  const started = await request<Session>(`/api/sessions/${source.id}/start`, 'POST', { mode: 'chat' });
  assert.ok(started.nativeSessionId); assert.equal(started.running, true);
  assert.equal((await calls()).filter(call => call.event === 'tui').length, 0);
  const requestId = randomUUID(), text = 'Verify exact native graphical thread';
  const simultaneous = await Promise.all([1, 2].map(() => request<CodexChatSubmission>(`/api/sessions/${source.id}/chat/messages`, 'POST', { requestId, text }, [200, 202])));
  const submitted = simultaneous.find(result => result.status === 'accepted');
  assert.ok(submitted?.turnId);
  assert.ok(simultaneous.every(result => result.status === 'accepted' || result.status === 'sending'));
  assert.deepEqual(await request(`/api/sessions/${source.id}/chat/messages`, 'POST', { requestId, text }), submitted);
  await request(`/api/sessions/${source.id}/chat/messages`, 'POST', { requestId, text: 'Conflicting retry must not execute' }, 409);
  await until(async () => (await snapshot(source.id)).items.some(item => item.type === 'assistant' && item.text.includes(text)), 'Assistant stream did not reach graphical snapshot');
  await until(async () => events.text.includes('Reply: ' + text), 'Assistant stream did not reach SSE');
  assert.equal((await calls()).filter(call => call.method === 'turn/start').length, 1);
  assert.equal((await request<CodexChatSubmission>(`/api/sessions/${source.id}/chat/submissions/${requestId}`)).status, 'accepted');
  assert.equal((await fixture.current(source.id)).lastUserInput, text);
  const inputAt = (await fixture.current(source.id)).lastUserInputAt;
  assert.ok(inputAt && Number.isFinite(Date.parse(inputAt)), 'Accepted graphical input must record its time');
  const logs = join(fixture.directory, 'codex-home', 'sessions', '2026', '09', '29');
  await mkdir(logs, { recursive: true });
  await writeFile(join(logs, `rollout-${started.nativeSessionId}.jsonl`), [
    { type: 'session_meta', payload: { id: started.nativeSessionId } },
    { type: 'event_msg', timestamp: '2026-09-29T08:00:00.000Z', payload: { type: 'user_message', message: 'Older saved prompt must not replace a just accepted input' } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  await request(`/api/sessions/${source.id}/conversation`);
  assert.equal((await fixture.current(source.id)).lastUserInput, text);
  assert.equal((await fixture.current(source.id)).lastUserInputAt, inputAt);
  const attached = await request<Session>(`/api/sessions/${source.id}/start`, 'POST', { mode: 'terminal' });
  assert.equal(attached.nativeSessionId, started.nativeSessionId);
  await until(async () => (await calls()).some(call => call.event === 'tui' && call.nativeId === started.nativeSessionId), 'TUI did not attach the graphical native thread');
  assert.equal((await calls()).filter(call => call.method === 'thread/start').length, 1);
  const sourceHistory = (await snapshot(source.id)).items;
  const child = await request<Session>(`/api/sessions/${source.id}/fork`, 'POST', { title: 'Graphical child' }, 201);
  assert.notEqual(child.nativeSessionId, started.nativeSessionId);
  await request(`/api/sessions/${child.id}/start`, 'POST', { mode: 'chat' });
  assert.ok((await snapshot(child.id)).items.some(item => item.text.includes(text)), 'Fork must inherit the native context');
  await request(`/api/sessions/${child.id}/chat/messages`, 'POST', { requestId: randomUUID(), text: 'Child correction' });
  await until(async () => (await snapshot(child.id)).items.some(item => item.text === 'Reply: Child correction'), 'Fork could not continue in graphical mode');
  assert.deepEqual((await snapshot(source.id)).items, sourceHistory);
});

test('graphical approvals and questions validate opaque handles; interrupt keeps the native session available', { timeout: 30_000 }, async t => {
  const fixture = await launch(t), { request, calls, snapshot } = fixture;
  const source = await fixture.create('Graphical approval source');
  await request(`/api/sessions/${source.id}/start`, 'POST', { mode: 'chat' });
  await request(`/api/sessions/${source.id}/chat/messages`, 'POST', { requestId: randomUUID(), text: 'APPROVAL' });
  await until(async () => (await snapshot(source.id)).requests.length === 1, 'Native approval did not reach the panel');
  const approval = (await snapshot(source.id)).requests[0];
  assert.equal(approval.kind, 'approval');
  await request(`/api/sessions/${source.id}/chat/requests/${approval.id}`, 'POST', { decision: 'invented-permission' }, [400, 409]);
  assert.equal((await calls()).filter(call => call.event === 'answer').length, 0);
  const decline = approval.options?.find(option => /拒绝|decline|deny/i.test(option.label)); assert.ok(decline);
  await request(`/api/sessions/${source.id}/chat/requests/${approval.id}`, 'POST', { decision: decline.id });
  await until(async () => (await snapshot(source.id)).activeTurnId === null, 'Approval response did not finish its native turn');
  assert.deepEqual((await calls()).find(call => call.event === 'answer')?.result, { decision: 'decline' });
  await request(`/api/sessions/${source.id}/chat/requests/${approval.id}`, 'POST', { decision: decline.id }, [400, 404, 409]);
  assert.equal((await calls()).filter(call => call.event === 'answer').length, 1);
  await request(`/api/sessions/${source.id}/chat/messages`, 'POST', { requestId: randomUUID(), text: 'QUESTION' });
  await until(async () => (await snapshot(source.id)).requests.some(request => request.kind === 'question'), 'Native question did not reach the panel');
  const question = (await snapshot(source.id)).requests[0];
  await request(`/api/sessions/${source.id}/chat/requests/${question.id}`, 'POST', { answers: { other: ['One'] } }, [400, 409]);
  await request(`/api/sessions/${source.id}/chat/requests/${question.id}`, 'POST', { answers: { choice: ['Two'] } });
  await until(async () => (await snapshot(source.id)).activeTurnId === null, 'Question response did not finish');
  assert.deepEqual((await calls()).filter(call => call.event === 'answer').at(-1)?.result, { answers: { choice: { answers: ['Two'] } } });
  await request(`/api/sessions/${source.id}/chat/messages`, 'POST', { requestId: randomUUID(), text: 'HOLD' });
  assert.ok((await snapshot(source.id)).activeTurnId);
  const busyRequest = { requestId: randomUUID(), text: 'Must not overtake the active native turn' };
  const busyReply = await request<CodexChatSubmission & { code: string }>(`/api/sessions/${source.id}/chat/messages`, 'POST', busyRequest, 409);
  assert.equal(busyReply.code, 'CHAT_REJECTED');
  assert.equal((await request<CodexChatSubmission>(`/api/sessions/${source.id}/chat/submissions/${busyRequest.requestId}`)).status, 'rejected');
  const turnsBeforeRetry = (await calls()).filter(call => call.method === 'turn/start').length;
  assert.equal((await request<CodexChatSubmission>(`/api/sessions/${source.id}/chat/messages`, 'POST', busyRequest)).status, 'rejected');
  assert.equal((await calls()).filter(call => call.method === 'turn/start').length, turnsBeforeRetry);
  const activeTurn = (await snapshot(source.id)).activeTurnId!;
  const supplemental = { requestId: randomUUID(), text: 'Supplement while running', expectedTurnId: activeTurn };
  const acceptedSupplement = await request<CodexChatSubmission>(`/api/sessions/${source.id}/chat/messages`, 'POST', supplemental);
  assert.equal(acceptedSupplement.status, 'accepted'); assert.equal(acceptedSupplement.turnId, activeTurn);
  assert.deepEqual(await request(`/api/sessions/${source.id}/chat/messages`, 'POST', supplemental), acceptedSupplement);
  assert.equal((await calls()).filter(call => call.method === 'turn/steer').length, 1, 'Retry must not steer twice');
  assert.equal((await calls()).filter(call => call.method === 'turn/start').length, turnsBeforeRetry);
  assert.equal((await snapshot(source.id)).activeTurnId, activeTurn);
  assert.ok((await snapshot(source.id)).items.some(item => item.text === supplemental.text));
  await request(`/api/sessions/${source.id}/chat/messages`, 'POST', { requestId: randomUUID(), text: 'stale', expectedTurnId: randomUUID() }, 409);
  await request(`/api/sessions/${source.id}/chat/interrupt`, 'POST', {});
  await until(async () => (await snapshot(source.id)).activeTurnId === null, 'Interrupt did not end the turn');
  assert.equal((await fixture.current(source.id)).running, true, 'Interrupt must retain the connected session');
  await request(`/api/sessions/${source.id}/chat/messages`, 'POST', { requestId: randomUUID(), text: 'Continue after interrupt' });
  await until(async () => (await snapshot(source.id)).items.some(item => item.text === 'Reply: Continue after interrupt'), 'Session was not usable after interrupt');
});

test('a lost native submit response stays unknown and the same request ID never resends', { timeout: 30_000 }, async t => {
  const fixture = await launch(t), { request, calls } = fixture;
  const source = await fixture.create('Ambiguous graphical submission');
  await request(`/api/sessions/${source.id}/start`, 'POST', { mode: 'chat' });
  const body = { requestId: randomUUID(), text: 'DROP_RESPONSE' };
  const result = await request<CodexChatSubmission>(`/api/sessions/${source.id}/chat/messages`, 'POST', body, 202);
  assert.equal(result.status, 'unknown');
  assert.equal((await request<CodexChatSubmission>(`/api/sessions/${source.id}/chat/submissions/${body.requestId}`)).status, 'unknown');
  const retried = await request<CodexChatSubmission>(`/api/sessions/${source.id}/chat/messages`, 'POST', body, 202);
  assert.equal(retried.status, 'unknown');
  assert.equal((await calls()).filter(call => call.method === 'turn/start').length, 1);
});

test('a graphical group member stops and resumes its exact history, then receives a task without terminal staging', { timeout: 30_000 }, async t => {
  const fixture = await launch(t), { request, calls, snapshot, current } = fixture;
  const group = await request<Group>('/api/groups', 'POST', { title: 'Graphical group lifecycle', goal: 'Preserve native context and deliver directly' }, 201);
  const member = await request<Session>('/api/sessions', 'POST', { backend: 'codex', title: 'Graphical group member', cwd: fixture.directory, groupId: group.id, briefing: false }, 201);
  const started = await request<Session>(`/api/sessions/${member.id}/start`, 'POST', { mode: 'chat' });
  assert.ok(started.nativeSessionId);
  await request(`/api/sessions/${member.id}/chat/messages`, 'POST', { requestId: randomUUID(), text: 'Remember the original graphical context' });
  await until(async () => !(await snapshot(member.id)).activeTurnId && (await snapshot(member.id)).items.some(item => item.text === 'Reply: Remember the original graphical context'), 'Original native history did not finish');
  const original = (await snapshot(member.id)).items;
  const stopped = await request<Session>(`/api/sessions/${member.id}/stop`, 'POST', {});
  assert.equal(stopped.running, false); assert.equal(stopped.nativeSessionId, started.nativeSessionId);
  assert.equal((await current(member.id)).running, false);
  assert.equal((await snapshot(member.id)).connected, false);
  const turnsBefore = (await calls()).filter(call => call.method === 'turn/start').length;
  await request(`/api/sessions/${member.id}/chat/messages`, 'POST', { requestId: randomUUID(), text: 'Stopped sessions must not receive prompts' }, 409);
  assert.equal((await calls()).filter(call => call.method === 'turn/start').length, turnsBefore);

  const resumed = await request<Session>(`/api/sessions/${member.id}/start`, 'POST', { mode: 'chat' });
  assert.equal(resumed.running, true); assert.equal(resumed.nativeSessionId, started.nativeSessionId);
  assert.deepEqual((await snapshot(member.id)).items, original);
  await request(`/api/sessions/${member.id}/chat/messages`, 'POST', { requestId: randomUUID(), text: 'Continue the same graphical context' });
  await until(async () => !(await snapshot(member.id)).activeTurnId && (await snapshot(member.id)).items.some(item => item.text === 'Reply: Continue the same graphical context'), 'Resumed session could not continue');
  const task = await request<GroupMessage>(`/api/groups/${group.id}/messages`, 'POST', { kind: 'task', text: 'Please verify the shared task in graphical mode', recipientIds: [member.id] }, 201);
  const detail = await request<GroupDetail>(`/api/groups/${group.id}`);
  const delivery = detail.deliveries.find(delivery => delivery.messageId === task.id && delivery.sessionId === member.id)!;
  assert.ok(delivery); assert.equal(delivery.status, 'pending');
  const sent = await request<Delivery>(`/api/deliveries/${delivery.id}/send`, 'POST', {});
  assert.equal(sent.status, 'sent');
  await until(async () => !(await snapshot(member.id)).activeTurnId && (await snapshot(member.id)).items.some(item => item.type === 'assistant' && item.text.includes(task.text)), 'Group task did not complete through the native graphical turn');
  const nativeCalls = await calls();
  assert.equal(nativeCalls.filter(call => call.event === 'tui').length, 0, 'Graphical group delivery unexpectedly launched a terminal');
  assert.equal(nativeCalls.filter(call => call.method === 'thread/start').length, 1, 'Stop/resume or group delivery created a replacement native thread');
  assert.equal(nativeCalls.filter(call => call.method === 'turn/start').length, turnsBefore + 2);
  assert.ok(nativeCalls.filter(call => call.method === 'turn/start').every(call => call.params?.threadId === started.nativeSessionId));
  const after = await request<GroupDetail>(`/api/groups/${group.id}`);
  assert.equal(after.deliveries.find(item => item.id === delivery.id)?.status, 'sent');
  await request(`/api/deliveries/${delivery.id}/send`, 'POST', {}, 400);
  assert.equal((await calls()).filter(call => call.method === 'turn/start').length, turnsBefore + 2, 'Already delivered group task executed twice');

  const terminal = await request<Session>(`/api/sessions/${member.id}/start`, 'POST', { mode: 'terminal' });
  assert.equal(terminal.interactionMode, 'terminal'); assert.equal(terminal.nativeSessionId, started.nativeSessionId);
  await until(async () => (await calls()).filter(call => call.event === 'tui').length === 1, 'TUI did not attach before returning to chat');
  const graphical = await request<Session>(`/api/sessions/${member.id}/start`, 'POST', { mode: 'chat' });
  assert.equal(graphical.interactionMode, 'chat'); assert.equal(graphical.nativeSessionId, started.nativeSessionId);
  const secondTask = await request<GroupMessage>(`/api/groups/${group.id}/messages`, 'POST', { kind: 'task', text: 'Returning to chat must send directly even while a TUI is attached', recipientIds: [member.id] }, 201);
  const secondDetail = await request<GroupDetail>(`/api/groups/${group.id}`);
  const secondDelivery = secondDetail.deliveries.find(delivery => delivery.messageId === secondTask.id)!;
  assert.equal((await request<Delivery>(`/api/deliveries/${secondDelivery.id}/send`, 'POST', {})).status, 'sent');
  await until(async () => !(await snapshot(member.id)).activeTurnId && (await snapshot(member.id)).items.some(item => item.type === 'assistant' && item.text.includes(secondTask.text)), 'Returning to chat incorrectly staged the group task in the existing TUI');
  assert.equal((await calls()).filter(call => call.method === 'turn/start').length, turnsBefore + 3);
  assert.equal((await calls()).filter(call => call.method === 'thread/start').length, 1);
  assert.equal((await calls()).filter(call => call.event === 'tui').length, 1);
});

test('HTTP history loads only recent turns, exposes an older cursor and keeps old pages out of the live snapshot', { timeout: 30_000 }, async t => {
  const fixture = await launch(t), { request } = fixture;
  const source = await fixture.create('Paginated source');
  const started = await request<Session>(`/api/sessions/${source.id}/start`, 'POST', { mode: 'chat' });
  for (let i = 0; i < 23; i++) {
    await request(`/api/sessions/${source.id}/chat/messages`, 'POST', { requestId: randomUUID(), text: `History request ${i}` });
    await until(async () => (await fixture.current(source.id)).status === 'waiting_input', `Turn ${i} did not complete`);
  }
  const recent = await fixture.snapshot(source.id);
  assert.equal(recent.items.filter(item => item.type === 'user').length, 20);
  assert.ok(recent.historyCursor);
  assert.equal(recent.items[0].text, 'History request 3');
  const path = `/api/sessions/${source.id}/chat/history`;
  await request(path, 'GET', undefined, 400);
  await request(path + '?cursor=%00bad', 'GET', undefined, 400);
  const page = await request<import('../shared/chat.ts').CodexChatHistoryPage>(path + '?cursor=' + encodeURIComponent(recent.historyCursor));
  assert.equal(page.nativeSessionId, started.nativeSessionId);
  assert.deepEqual(page.items.filter(item => item.type === 'user').map(item => item.text), ['History request 0', 'History request 1', 'History request 2']);
  assert.equal(page.nextCursor, null);
  assert.deepEqual((await fixture.snapshot(source.id)).items, recent.items);
  assert.equal((await fixture.calls()).some(call => call.method === 'thread/read' && (call.params as Record<string, unknown>)?.includeTurns === true), false);
});


test('raw graphical uploads enforce image type and session ownership, then native image-only sends deduplicate', {timeout:30000}, async t => {
  const f = await launch(t);
  const source = await f.create('Image source'), other = await f.create('Image isolation');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const upload = (body: Buffer, type = 'image/png', token = f.csrfToken) => fetch(`${f.base}/api/sessions/${source.id}/attachments`, {method:'POST',headers:{'content-type':type,'x-sessiondeck-token':token,'x-dili-filename':encodeURIComponent('截图.png')},body:new Uint8Array(body)});
  assert.equal((await upload(png,'image/png','invalid-token')).status,403);
  assert.equal((await upload(png,'text/plain')).status,415);
  assert.equal((await upload(Buffer.from('<svg/>'))).status,415);
  const response = await upload(png); assert.equal(response.status,201);
  const item = await response.json() as {id:string;name:string};
  assert.equal(item.name,'截图.png'); assert.equal('path' in item,false);
  const saved = await fetch(`${f.base}/api/sessions/${source.id}/attachments/${item.id}`);
  assert.equal(saved.status,200); assert.deepEqual(Buffer.from(await saved.arrayBuffer()),png);
  assert.equal((await fetch(`${f.base}/api/sessions/${other.id}/attachments/${item.id}`)).status,404);
  await f.request(`/api/sessions/${other.id}/start`,'POST',{mode:'chat'});
  await f.request(`/api/sessions/${other.id}/chat/messages`,'POST',{text:'',requestId:randomUUID(),attachments:[item.id]},404);
  await f.request(`/api/sessions/${source.id}/start`,'POST',{mode:'chat'});
  const payload = {text:'',requestId:randomUUID(),attachments:[item.id]};
  await f.request(`/api/sessions/${source.id}/chat/messages`,'POST',payload);
  await f.request(`/api/sessions/${source.id}/chat/messages`,'POST',payload);
  const turns = (await f.calls()).filter(call=>call.method === 'turn/start');
  assert.equal(turns.length,1);
  const input = turns[0].params?.input as {type:string;path?:string}[];
  assert.equal(input.length,1); assert.equal(input[0].type,'localImage');
  assert.ok(input[0].path?.startsWith(join(f.directory,'data','chat-images')));
  assert.deepEqual(await readFile(input[0].path!),png);
});


test('Claude terminal staging uses separate native image pastes, no Enter, and rejects stale or repeated changes', {timeout:30000}, async t => {
  const f=await launch(t);
  const contact=await f.request<Session>('/api/sessions','POST',{backend:'claude',title:'Native staging',cwd:f.directory},201);
  await f.request('/api/sessions/'+contact.id+'/start','POST',{mode:'terminal'});
  await delay(150);
  const native=await f.request<{generation:string}>('/api/sessions/'+contact.id+'/input');
  assert.ok(native.generation);
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
  const response=await fetch(f.base+'/api/sessions/'+contact.id+'/attachments',{method:'POST',headers:{'content-type':'image/png','x-sessiondeck-token':f.csrfToken},body:new Uint8Array(png)});
  assert.equal(response.status,201); const item=await response.json() as {id:string};
  const payload={text:'检查图片\n并解释',attachments:[item.id],requestId:randomUUID(),generation:native.generation};
  await f.request('/api/sessions/'+contact.id+'/input','POST',payload);
  await f.request('/api/sessions/'+contact.id+'/input','POST',payload);
  await until(async()=> (await readFile(join(f.directory,'native-input.log'),'utf8').catch(()=>'' )).includes('并解释'), 'Native staging did not reach PTY');
  const input=await readFile(join(f.directory,'native-input.log'),'utf8');
  assert.equal(input.split('\x1b[200~').length,3);
  assert.ok(input.includes(JSON.stringify(join(f.directory,'data','chat-images',item.id+'.png'))));
  assert.ok(input.endsWith(' 检查图片  并解释\x1b[201~'));
  assert.ok(!input.includes('\r')&&!input.includes('\n'));
  await f.request('/api/sessions/'+contact.id+'/input','POST',{...payload,text:'Different'},409);
  await f.request('/api/sessions/'+contact.id+'/input','POST',{...payload,requestId:randomUUID(),generation:'stale-generation'},409);
  const terminal=await fetch(f.base+'/api/sessions/'+contact.id+'/terminal/image',{method:'POST',headers:{'content-type':'image/png','x-sessiondeck-token':f.csrfToken,'x-sessiondeck-terminal':native.generation},body:new Uint8Array(png)});
  assert.equal(terminal.status,200);
});

test('Claude terminal compatibility submits multiline text and images once, exposes recovery, and leaves approvals native', {timeout:30000}, async t => {
  const f=await launch(t);
  const contact=await f.request<Session>('/api/sessions','POST',{backend:'claude',title:'Direct graphical send',cwd:f.directory},201);
  await f.request('/api/sessions/'+contact.id+'/start','POST',{mode:'terminal'}); await delay(150);
  const native=await f.request<{generation:string;directSubmit:boolean}>('/api/sessions/'+contact.id+'/input');
  assert.equal(native.directSubmit,true);
  const path='/api/sessions/'+contact.id+'/input';
  const payload={text:'检查任务\n保留换行🙂',generation:native.generation,requestId:randomUUID(),submit:true};
  const results=await Promise.all([1,2].map(()=>f.request<{status:string;submitted:boolean}>(path,'POST',payload)));
  assert.ok(results.some(result=>result.status==='accepted'&&result.submitted));
  const recovered=await f.request<{submission:CodexChatSubmission}>(path+'?requestId='+payload.requestId);
  assert.equal(recovered.submission.status,'accepted');
  await until(async()=> (await readFile(join(f.directory,'native-input.log'),'utf8').catch(()=>'' )).endsWith('\r'),'Native send did not submit');
  assert.equal(await readFile(join(f.directory,'native-input.log'),'utf8'),'\x1b[200~检查任务\n保留换行🙂\x1b[201~\r');
  await f.request(path,'POST',{...payload,submit:false},409);
  await f.request(path,'POST',{...payload,requestId:randomUUID(),generation:'old-generation'},409);
  await f.request('/api/sessions/'+contact.id,'PATCH',{status:'waiting_approval'});
  await f.request(path,'POST',{...payload,requestId:randomUUID()},409);
  await f.request('/api/sessions/'+contact.id,'PATCH',{status:'waiting_input'});
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
  const uploaded=await fetch(f.base+'/api/sessions/'+contact.id+'/attachments',{method:'POST',headers:{'content-type':'image/png','x-sessiondeck-token':f.csrfToken},body:new Uint8Array(png)});
  assert.equal(uploaded.status,201); const image=await uploaded.json() as {id:string};
  const imagePayload={...payload,text:'',attachments:[image.id],requestId:randomUUID()};
  await f.request(path,'POST',imagePayload); await f.request(path,'POST',imagePayload);
  await until(async()=> (await readFile(join(f.directory,'native-input.log'),'utf8')).split('\r').length===3,'Image-only message did not submit exactly once');
  const input=await readFile(join(f.directory,'native-input.log'),'utf8');
  assert.equal(input.split('\x1b[200~').length,3);
  assert.ok(input.endsWith(JSON.stringify(join(f.directory,'data','chat-images',image.id+'.png'))+'\x1b[201~\r'));
});


test('Claude graphical execution streams once, handles approvals/questions, and rejects concurrent writers', { timeout: 30_000 }, async t => {
  const f = await launch(t), { request, snapshot } = f;
  const source = await request<Session>('/api/sessions', 'POST', { backend: 'claude', title: 'Structured Claude', cwd: f.directory }, 201);
  const path = `/api/sessions/${source.id}`;
  const started = await request<Session>(path + '/start', 'POST', { mode: 'chat' });
  assert.ok(started.nativeSessionId);
  assert.equal(started.executionTransport, 'structured');
  assert.equal((await request<{ generation: string | null }>(path + '/input')).generation, null);
  const events = await f.stream(source.id);
  const payload = { requestId: randomUUID(), text: '检查任务\n保留换行🙂' };
  await Promise.all([1, 2].map(() => request(path + '/chat/messages', 'POST', payload, [200, 202])));
  await until(async () => (await snapshot(source.id)).items.some(item => item.text === '第一段 **'), 'Partial text not visible');
  assert.ok((await snapshot(source.id)).activeTurnId);
  await until(async () => events.text.includes('第一段 **'), 'No partial SSE text');
  // A display status is editable; it must not override the native writer lock.
  await request(path, 'PATCH', { status: 'waiting_input' });
  await request(path + '/start', 'POST', { mode: 'terminal', handoff: true }, 409);
  await until(async () => !(await snapshot(source.id)).activeTurnId, 'Turn did not finish');
  assert.equal((await snapshot(source.id)).items.filter(item => item.type === 'assistant').length, 1);
  assert.equal((await snapshot(source.id)).items.filter(item => item.type === 'user').length, 1);
  assert.equal((await f.current(source.id)).lastUserInput, payload.text.replace(/\s+/g, ' '));
  const calls = async () => (await readFile(join(f.directory, 'claude-calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal((await calls()).filter(row => row.type === 'user').length, 1);
  for (const text of ['APPROVAL', 'QUESTION']) {
    await request(path + '/chat/messages', 'POST', { requestId: randomUUID(), text });
    await until(async () => !!(await snapshot(source.id)).requests.length, 'Request did not arrive');
    const pending = (await snapshot(source.id)).requests[0];
    assert.equal(pending.kind, text === 'QUESTION' ? 'question' : 'approval');
    await request(path + '/start', 'POST', { mode: 'terminal', handoff: true }, 409);
    const answer = text === 'QUESTION' ? { answers: { '0': ['二'] } } : { decision: 'deny' };
    await request(path + '/chat/requests/' + pending.id, 'POST', answer);
    await request(path + '/chat/requests/' + pending.id, 'POST', answer, 409);
    await until(async () => !(await snapshot(source.id)).activeTurnId, 'Answer did not finish turn');
  }
  await request(path + '/chat/messages', 'POST', { requestId: randomUUID(), text: 'HOLD' });
  await request(path + '/chat/interrupt', 'POST', {});
  await until(async () => !(await snapshot(source.id)).activeTurnId, 'Interrupt did not finish');
  // Interrupt reports an error result; the next normal turn restores idle status.
  await request(path + '/chat/messages', 'POST', { requestId: randomUUID(), text: 'Resume' });
  await until(async () => !(await snapshot(source.id)).activeTurnId, 'Resume did not finish');
  await request(path + '/start', 'POST', { mode: 'terminal' }, 409);
  const terminal = await request<Session>(path + '/start', 'POST', { mode: 'terminal', handoff: true });
  assert.equal(terminal.nativeSessionId, started.nativeSessionId);
  assert.equal(terminal.executionTransport, 'pty');
  // Wait for the child to start before handing off and terminating its PTY.
  await until(async () => !!(await readFile(join(f.directory, 'claude-launches.jsonl'), 'utf8').catch(() => '')), 'Claude terminal launch was not recorded');
  assert.equal((await snapshot(source.id)).connected, false);
  await request(path + '/chat/messages', 'POST', { requestId: randomUUID(), text: 'Must not write' }, 409);
  await request(path, 'PATCH', { status: 'waiting_input' });
  await request(path + '/start', 'POST', { mode: 'chat' }, 409);
  const restored = await request<Session>(path + '/start', 'POST', { mode: 'chat', handoff: true });
  assert.equal(restored.nativeSessionId, started.nativeSessionId);
  assert.equal((await snapshot(source.id)).connected, true);
  assert.ok((await snapshot(source.id)).items.some(item => item.text === payload.text));
  assert.equal((await readFile(join(f.directory, 'claude-launches.jsonl'), 'utf8')).trim().split('\n').length, 1);
});

test('Claude graphical starts preserve empty-session and fork identities across real stop/resume', { timeout: 30_000 }, async t => {
  const f = await launch(t), { request } = f;
  const source = await request<Session>('/api/sessions', 'POST', { backend: 'claude', title: 'Empty Claude', cwd: f.directory }, 201);
  const start = (id: string) => request<Session>(`/api/sessions/${id}/start`, 'POST', { mode: 'chat' });
  const stop = (id: string) => request(`/api/sessions/${id}/stop`, 'POST', {});
  const blank = await start(source.id);
  assert.deepEqual(blank.claudeUnwritten, { sourceId: null });
  await stop(source.id);
  const resumed = await start(source.id);
  assert.equal(resumed.nativeSessionId, blank.nativeSessionId);
  assert.deepEqual(resumed.claudeUnwritten, blank.claudeUnwritten);
  const fork = await request<Session>(`/api/sessions/${source.id}/fork`, 'POST', { title: 'Claude child' }, 201);
  const child = await start(fork.id);
  assert.notEqual(child.nativeSessionId, blank.nativeSessionId);
  assert.equal(child.forkPending, false);
  assert.deepEqual(child.claudeUnwritten, { sourceId: blank.nativeSessionId });
  await stop(fork.id);
  const reopened = await start(fork.id);
  assert.equal(reopened.nativeSessionId, child.nativeSessionId);
  assert.deepEqual(reopened.claudeUnwritten, child.claudeUnwritten);
  await request(`/api/sessions/${source.id}/chat/messages`, 'POST', { text: 'Continue the original', requestId: randomUUID() });
  await until(async () => !(await f.snapshot(source.id)).activeTurnId, 'Original did not finish');
  await stop(source.id);
  const written = await start(source.id);
  assert.equal(written.nativeSessionId, blank.nativeSessionId);
  assert.equal(written.claudeUnwritten, undefined);
});

for (const backend of ['codex', 'claude'] as const) test(`${backend} settings use native choices, confirmed changes, version and busy guards`, { timeout: 30_000 }, async t => {
  const fixture = await launch(t), { request, snapshot } = fixture;
  const contact = await request<Session>('/api/sessions', 'POST', { backend, title: 'Settings contract', cwd: fixture.directory }, 201);
  const path = `/api/sessions/${contact.id}/chat/settings`;
  await request(path, 'GET', undefined, 409);
  const started = await request<Session>(`/api/sessions/${contact.id}/start`, 'POST', { mode: 'chat' });
  let settings = await request<AgentChatSettings>(path);
  assert.equal(settings.nativeSessionId, started.nativeSessionId);
  assert.ok(settings.models.some(choice => choice.id === 'fixture-alternative'));
  assert.ok(!settings.disabledReason);
  const old = settings.version;
  settings = await request<AgentChatSettings>(path, 'POST', { version: old, field: 'model', value: 'fixture-alternative' });
  assert.equal(settings.model, 'fixture-alternative');
  assert.notEqual(settings.version, old);
  await request(path, 'POST', { version: old, field: 'model', value: settings.models[0].id }, 409);
  await request(path, 'POST', { version: settings.version, field: 'model', value: 'invented-model' }, 409);
  await request(path, 'POST', { version: settings.version, field: 'model', value: 'fixture-denied' }, 409);
  const afterRejection = await request<AgentChatSettings>(path);
  assert.equal(afterRejection.model, 'fixture-alternative', 'Native rejection must not update displayed state');
  assert.equal(afterRejection.version, settings.version);
  settings = await request<AgentChatSettings>(path, 'POST', { version: settings.version, field: 'permission', value: backend === 'claude' ? 'plan' : 'untrusted' });
  assert.equal(settings.permission, backend === 'claude' ? 'plan' : 'untrusted');
  await request(`/api/sessions/${contact.id}/chat/messages`, 'POST', { requestId: randomUUID(), text: 'HOLD', model: 'ignored-value' }, 400);
  await request(`/api/sessions/${contact.id}/chat/messages`, 'POST', { requestId: randomUUID(), text: 'HOLD' });
  await until(async () => !!(await snapshot(contact.id)).activeTurnId, 'Native HOLD did not start');
  assert.ok((await request<AgentChatSettings>(path)).disabledReason);
  await request(path, 'POST', { version: settings.version, field: 'permission', value: backend === 'claude' ? 'default' : 'on-request' }, 409);
  await request(`/api/sessions/${contact.id}/chat/interrupt`, 'POST', {});
  await until(async () => !(await snapshot(contact.id)).activeTurnId, 'Interrupt did not release setting guard');
  if (backend === 'codex') {
    const calls = (await fixture.calls()) as { method: string; params: Record<string, unknown> }[];
    const updates = calls.filter(call => call.method === 'thread/settings/update');
    assert.equal(updates.length, 3, 'Rejected local settings must never reach native mutation');
    assert.ok(updates.every(call => call.params.sandbox === undefined && call.params.sandboxPolicy === undefined && call.params.permissions === undefined));
    assert.ok(updates.some(call => call.params.approvalPolicy === 'untrusted'));
  } else {
    const calls = (await readFile(join(fixture.directory, 'claude-calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(calls.filter(call => call.request?.subtype === 'set_model').length, 2);
    assert.ok(calls.some(call => call.request?.subtype === 'set_permission_mode' && call.request.mode === 'plan'));
    await request(path, 'POST', { version: settings.version, field: 'model', value: 'fixture-no-ack' }, 409);
    const uncertain = await request<AgentChatSettings>(path);
    assert.equal(uncertain.model, null, 'An empty native success envelope cannot confirm the effective model');
    assert.notEqual(uncertain.version, settings.version);
    settings = uncertain;
  }
  const beforeRestart = settings.version;
  await request(`/api/sessions/${contact.id}/stop`, 'POST', {});
  const reopened = await request<Session>(`/api/sessions/${contact.id}/start`, 'POST', { mode: 'chat' });
  assert.equal(reopened.nativeSessionId, started.nativeSessionId);
  const fresh = await request<AgentChatSettings>(path);
  assert.notEqual(fresh.version, beforeRestart, 'Reopening an executor must invalidate old settings forms');
  await request(path, 'POST', { version: beforeRestart, field: 'model', value: 'fixture-alternative' }, 409);
  const competing = await Promise.all((backend === 'claude' ? ['plan', 'acceptEdits'] : ['on-request', 'never']).map(value => request<AgentChatSettings | { error: string }>(path, 'POST', { version: fresh.version, field: 'permission', value }, [200, 409])));
  assert.equal(competing.filter(result => 'version' in result).length, 1, 'Only one mutation from the same settings version may succeed');
  const confirmed = await request<AgentChatSettings>(path);
  assert.equal(confirmed.permission, (competing.find(result => 'version' in result) as AgentChatSettings).permission);
});

test('Claude contact settings align graphical and terminal executors, including every native permission mode', { timeout: 40_000 }, async t => {
  const f = await launch(t), { request } = f;
  const launches = async (name: string) => (await readFile(join(f.directory, name), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line).args as string[]);
  const state = () => request<{ backends: { id: string; capabilities: { permissionModes?: string[]; bypassOption?: boolean } }[]; sessions: Session[] }>('/api/state');
  const current = async (id: string) => (await state()).sessions.find(item => item.id === id)!;
  const claude = (await state()).backends.find(item => item.id === 'claude')!;
  assert.deepEqual(claude.capabilities.permissionModes, ['default', 'acceptEdits', 'auto', 'bypassPermissions', 'dontAsk', 'plan']);
  assert.equal(claude.capabilities.bypassOption, true);
  await request('/api/sessions', 'POST', { backend: 'claude', title: 'Unknown mode', cwd: f.directory, nativeSettings: { permission: 'invented' } }, 400);
  const contact = await request<Session>('/api/sessions', 'POST', { backend: 'claude', title: 'Bypass contact', cwd: f.directory, nativeSettings: { permission: 'bypassPermissions' } }, 201);
  assert.deepEqual(contact.nativeSettings, { permission: 'bypassPermissions' });
  const path = `/api/sessions/${contact.id}`, settingsPath = path + '/chat/settings';

  // Graphical executor: launched with the contact mode, every CLI mode offered, live changes persist.
  await request<Session>(path + '/start', 'POST', { mode: 'chat' });
  let printArgs = (await launches('claude-print-launches.jsonl')).at(-1)!;
  assert.deepEqual(printArgs.slice(printArgs.indexOf('--permission-mode'), printArgs.indexOf('--permission-mode') + 2), ['--permission-mode', 'bypassPermissions']);
  assert.ok(printArgs.includes('--allow-dangerously-skip-permissions'));
  let settings = await request<AgentChatSettings>(settingsPath);
  assert.equal(settings.apply, 'live');
  assert.equal(settings.permission, 'bypassPermissions');
  assert.deepEqual(settings.permissions.map(choice => choice.id), claude.capabilities.permissionModes);
  settings = await request<AgentChatSettings>(settingsPath, 'POST', { version: settings.version, field: 'permission', value: 'auto' });
  settings = await request<AgentChatSettings>(settingsPath, 'POST', { version: settings.version, field: 'model', value: 'fixture-alternative' });
  settings = await request<AgentChatSettings>(settingsPath, 'POST', { version: settings.version, field: 'permission', value: 'bypassPermissions' });
  assert.equal(settings.permission, 'bypassPermissions', 'The allow flag keeps bypass switchable without a restart');
  settings = await request<AgentChatSettings>(settingsPath, 'POST', { version: settings.version, field: 'permission', value: 'manual' });
  assert.equal(settings.permission, 'default', 'manual is the CLI alias of default');
  settings = await request<AgentChatSettings>(settingsPath, 'POST', { version: settings.version, field: 'permission', value: 'auto' });
  assert.deepEqual((await current(contact.id)).nativeSettings, { permission: 'auto', model: 'fixture-alternative' });

  // Terminal executor: resumes with the same settings and serves the same settings API.
  await request(path, 'PATCH', { status: 'waiting_input' });
  const terminal = await request<Session>(path + '/start', 'POST', { mode: 'terminal', handoff: true });
  assert.equal(terminal.executionTransport, 'pty');
  const ptyLaunch = async (count: number) => { await until(async () => (await launches('claude-launches.jsonl')).length >= count, 'Claude terminal did not launch', 30_000); return (await launches('claude-launches.jsonl')).at(-1)!; };
  let ptyArgs = await ptyLaunch(1);
  for (const pair of [['--permission-mode', 'auto'], ['--model', 'fixture-alternative']]) assert.equal(ptyArgs[ptyArgs.indexOf(pair[0]) + 1], pair[1]);
  assert.ok(ptyArgs.includes('--allow-dangerously-skip-permissions'));
  settings = await request<AgentChatSettings>(settingsPath);
  assert.equal(settings.apply, 'restart');
  assert.equal(settings.restartRequired, false);
  assert.equal(settings.permission, 'auto');
  assert.equal(settings.model, 'fixture-alternative');
  assert.deepEqual(settings.permissions.map(choice => choice.id), claude.capabilities.permissionModes);
  assert.ok(settings.models.some(choice => choice.id === 'fixture-claude'), 'Terminal mode reads the native model list too');
  await request(settingsPath, 'POST', { version: settings.version, field: 'permission', value: 'invented' }, 409);
  settings = await request<AgentChatSettings>(settingsPath, 'POST', { version: settings.version, field: 'permission', value: 'plan' });
  assert.equal(settings.permission, 'plan');
  assert.equal(settings.restartRequired, true, 'A running terminal keeps its launch settings until restarted');
  await request(path + '/start', 'POST', { mode: 'terminal', restart: true }, 409);
  await request(path, 'PATCH', { status: 'waiting_input' });
  await request<Session>(path + '/start', 'POST', { mode: 'terminal', restart: true, handoff: true });
  ptyArgs = await ptyLaunch(2);
  assert.equal(ptyArgs[ptyArgs.indexOf('--permission-mode') + 1], 'plan');
  assert.equal((await request<AgentChatSettings>(settingsPath)).restartRequired, false);

  // Shift+Tab inside the TUI reports its live mode through the launch hook; the contact follows it.
  const hook = JSON.parse(ptyArgs[ptyArgs.indexOf('--settings') + 1]).hooks.UserPromptSubmit[0].hooks[0].command as string;
  const [hookUrl, hookToken] = [...hook.matchAll(/'([^']*)'/g)].map(match => match[1]).slice(2, 4);
  const reported = await fetch(hookUrl, { method: 'POST', headers: { 'content-type': 'application/json', 'x-sessiondeck-token': hookToken }, body: JSON.stringify({ source: 'claude', payload: { session_id: terminal.nativeSessionId, hook_event_name: 'UserPromptSubmit', permission_mode: 'acceptEdits' } }) });
  assert.equal(reported.status, 200);
  await until(async () => (await current(contact.id)).nativeSettings?.permission === 'acceptEdits', 'TUI permission change did not reach the contact');
  settings = await request<AgentChatSettings>(settingsPath);
  assert.equal(settings.permission, 'acceptEdits');
  assert.equal(settings.restartRequired, false, 'The running terminal already uses the reported mode');

  // Stopped: still the same contact settings, applied by whichever executor starts next.
  await request(path + '/stop', 'POST', {});
  settings = await request<AgentChatSettings>(settingsPath);
  assert.equal(settings.apply, 'restart');
  settings = await request<AgentChatSettings>(settingsPath, 'POST', { version: settings.version, field: 'permission', value: 'dontAsk' });
  await request<Session>(path + '/start', 'POST', { mode: 'chat' });
  printArgs = (await launches('claude-print-launches.jsonl')).filter(args => args.includes('--session-id') || args.includes('--resume')).at(-1)!;
  assert.equal(printArgs[printArgs.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal((await request<AgentChatSettings>(settingsPath)).permission, 'dontAsk');

  // Forks inherit the contact settings.
  const fork = await request<Session>(path + '/fork', 'POST', { title: 'Fork keeps settings' }, 201);
  assert.deepEqual(fork.nativeSettings, { permission: 'dontAsk', model: 'fixture-alternative' });
});

test('members get the rules once on join and greet; tasks carry a short header; the final answer flows back', { timeout: 60_000 }, async t => {
  const f = await launch(t), { request, snapshot } = f;
  const group = await request<{ id: string }>('/api/groups', 'POST', { title: '登录协作', goal: '完成登录页' }, 201);
  const earlier = await request<Session>('/api/sessions', 'POST', { backend: 'claude', title: '老成员', cwd: f.directory, groupId: group.id, briefing: false }, 201);
  await request(`/api/groups/${group.id}/messages`, 'POST', { kind: 'result', text: '老成员此前完成了接口设计', senderId: earlier.id }, 201);
  type Message = { id: string; kind: string; senderId: string | null; text: string; sourceMessageId?: string | null; failed?: boolean; pending?: boolean; briefing?: boolean };
  const detail = () => request<{ group: { unread?: number; lastMessage?: { text: string } }; messages: Message[]; deliveries: { status: string; replyMessageId?: string; tag?: string; briefing?: boolean }[] }>(`/api/groups/${group.id}`);
  const replies = async () => (await detail()).messages.filter(message => message.kind === 'reply' && !message.briefing);
  const sentTexts = async () => (await readFile(join(f.directory, 'claude-calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(row => row.type === 'user').map(row => row.message.content.map((block: { text?: string }) => block.text ?? '').join(''));

  // Joining starts the member, sends the full briefing once, and the greeting flows back.
  const member = await request<Session>('/api/sessions', 'POST', { backend: 'claude', title: '验证员', cwd: f.directory, groupId: group.id }, 201);
  await until(async () => (await detail()).messages.some(message => message.briefing), 'Join greeting did not flow back');
  const greeting = (await detail()).messages.find(message => message.briefing)!;
  assert.equal(greeting.senderId, member.id);
  assert.equal(greeting.text, '大家好，我是验证员，负责验证。');
  const briefing = (await sentTexts()).at(-1)!;
  assert.match(briefing, /^【群聊入群说明】任务编号：T-/);
  assert.match(briefing, /群聊「登录协作」中的成员「验证员」/);
  assert.match(briefing, /- 老成员（claude/);
  assert.match(briefing, /以下是其他成员对他们各自任务的回答，\*\*不是给你的任务，不需要你执行\*\*/);
  assert.match(briefing, /老成员此前完成了接口设计/);
  assert.match(briefing, /打个招呼/);
  await until(async () => !(await snapshot(member.id)).activeTurnId, 'Greeting turn did not finish');

  // A task now carries only a short header, and the final answer (not the interim note) flows back.
  const task = await request<{ id: string; deliveryErrors?: unknown }>(`/api/groups/${group.id}/messages`, 'POST', { kind: 'task', text: '检查登录页', recipientIds: [member.id], deliverNow: true }, 201);
  assert.equal(task.deliveryErrors, undefined);
  await until(async () => (await replies()).length === 1, 'Member reply did not flow back to the group');
  let state = await detail();
  const reply = state.messages.filter(message => message.kind === 'reply' && !message.briefing)[0];
  assert.equal(reply.senderId, member.id);
  assert.equal(reply.sourceMessageId, task.id);
  assert.equal(reply.text, '登录页通过验证（独立完成）。', 'Only the final answer is shown, not the interim progress message');
  assert.equal(reply.pending, undefined);
  const header = (await sentTexts()).at(-1)!;
  assert.match(header, /^【群聊任务】任务编号：T-[0-9a-f]{6} · 群「登录协作」\n\n## 你的任务\n\n检查登录页$/);
  assert.doesNotMatch(header, /协作规则/);
  assert.match(state.group.lastMessage?.text ?? '', /登录页通过验证/);
  await request(`/api/groups/${group.id}/read`, 'POST', {});
  assert.equal((await detail()).group.unread, 0);

  // A private correction is not a group task: it never reaches the group, and it closes the task.
  await request(`/api/sessions/${member.id}/chat/messages`, 'POST', { requestId: randomUUID(), text: '私聊补充' });
  await until(async () => !(await snapshot(member.id)).activeTurnId, 'Private turn did not finish');
  await delay(1500);
  assert.equal((await replies()).length, 1);

  // A quoted answer travels with the next task, and only that.
  await request(`/api/groups/${group.id}/messages`, 'POST', { kind: 'task', text: '基于回答继续', recipientIds: [member.id], references: [reply.id], deliverNow: true }, 201);
  await until(async () => (await replies()).length === 2, 'Second reply did not flow back');
  assert.equal((await replies()).at(-1)!.text, '登录页通过验证（参考了引用）。');
  const second = (await sentTexts()).at(-1)!;
  assert.match(second, /## 引用的回答\n\n### 验证员 的回答\n登录页通过验证（独立完成）。/);
  assert.doesNotMatch(second, /私聊补充/);

  // Changed group settings resend the full rules once, marked as updated.
  await request(`/api/groups/${group.id}`, 'PATCH', { goal: '完成登录页与注册页' });
  await request(`/api/groups/${group.id}/messages`, 'POST', { kind: 'task', text: '再看注册页', recipientIds: [member.id], deliverNow: true }, 201);
  await until(async () => (await replies()).length === 3, 'Third reply did not flow back');
  const updated = (await sentTexts()).at(-1)!;
  assert.match(updated, /## 群说明（已更新）\n\n你是群聊「登录协作」中的成员「验证员」。群目标：完成登录页与注册页/);
  await request(`/api/groups/${group.id}/messages`, 'POST', { kind: 'task', text: '最后一项', recipientIds: [member.id], deliverNow: true }, 201);
  await until(async () => (await replies()).length === 4, 'Fourth reply did not flow back');
  assert.doesNotMatch((await sentTexts()).at(-1)!, /群说明/);

  // A turn that fails without an answer is reported in the group once, with the native reason.
  await request(`/api/groups/${group.id}/messages`, 'POST', { kind: 'task', text: 'FAIL-TURN 请处理', recipientIds: [member.id], deliverNow: true }, 201);
  await until(async () => (await replies()).length === 5, 'Failed turn was not reported in the group');
  const failure = (await replies()).at(-1)!;
  assert.equal(failure.failed, true);
  assert.match(failure.text, /^回复失败：本轮任务未完成：unexpected status 526/);
  assert.match(failure.text, /原任务不会自动重发/);
  await delay(1500);
  assert.equal((await replies()).length, 5, 'A failure is reported once');

  // Leaving the group keeps the contact.
  await request(`/api/sessions/${member.id}`, 'PATCH', { groupId: null });
});

test('group workspace is shared by default; a worktree member branches, merges back on request and cleans up', { timeout: 60_000 }, async t => {
  const f = await launch(t), { request } = f;
  const repo = join(f.directory, 'repo');
  await mkdir(repo, { recursive: true });
  const run = (cwd: string, ...args: string[]) => new Promise<string>((resolve, reject) => { const child = spawn('git', args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }); let out = ''; child.stdout.on('data', d => { out += d; }); child.on('close', code => code === 0 ? resolve(out.trim()) : reject(new Error(`git ${args.join(' ')} failed`))); });
  await run(repo, 'init', '-q', '-b', 'main'); await run(repo, 'config', 'user.name', 't'); await run(repo, 'config', 'user.email', 't@t'); await writeFile(join(repo, 'README.md'), 'base\n'); await run(repo, 'add', '.'); await run(repo, 'commit', '-qm', 'base');
  const group = await request<{ id: string; workspace?: string }>('/api/groups', 'POST', { title: '工作区群', goal: 'g', workspace: repo }, 201);
  assert.equal(group.workspace, repo);
  const shared = await request<Session>('/api/sessions', 'POST', { backend: 'claude', title: '共享成员', groupId: group.id, briefing: false }, 201);
  assert.equal(shared.cwd, repo, 'Members default to the group workspace');
  assert.equal(shared.worktree, undefined);
  const isolated = await request<Session>('/api/sessions', 'POST', { backend: 'claude', title: '独立成员', groupId: group.id, placement: 'worktree', briefing: false }, 201);
  assert.ok(isolated.worktree);
  assert.match(isolated.worktree!.branch, /^dili\/工作区群\/独立成员-[0-9a-f]{6}$/);
  assert.ok(isolated.cwd.startsWith(join(f.directory, 'data', 'worktrees')));
  assert.equal(await run(isolated.cwd, 'rev-parse', '--abbrev-ref', 'HEAD'), isolated.worktree!.branch);
  await request('/api/sessions', 'POST', { backend: 'claude', title: '无群', placement: 'worktree', cwd: repo }, 400);

  // Each member is told where it works.
  await request(`/api/groups/${group.id}/messages`, 'POST', { kind: 'task', text: '看看', recipientIds: [shared.id, isolated.id] }, 201);
  const deliveries = (await request<{ deliveries: { sessionId: string; id: string }[] }>(`/api/groups/${group.id}`)).deliveries;
  assert.equal(deliveries.length, 2);
  const texts = (await import('node:sqlite')).DatabaseSync;
  const db = new texts(join(f.directory, 'data', 'sessiondeck.sqlite'), { readOnly: true });
  const text = (sessionId: string) => (db.prepare('SELECT data FROM deliveries').all().map(row => JSON.parse(String(row.data))) as Delivery[]).find(item => item.sessionId === sessionId)!.text;
  assert.match(text(shared.id), /所有成员共用工作目录/);
  assert.match(text(isolated.id), new RegExp(`独立的 Git 工作树中工作.*分支 ${isolated.worktree!.branch.replace(/[/]/g, '\\/')}`));
  db.close();

  // Merge only on request, only with committed work, never touching a dirty workspace.
  await request(`/api/sessions/${isolated.id}/worktree/merge`, 'POST', {}, 409);
  await writeFile(join(isolated.cwd, 'feature.txt'), 'member work\n');
  assert.equal((await request<{ uncommitted: number }>(`/api/sessions/${isolated.id}/worktree`)).uncommitted, 1);
  await request(`/api/sessions/${isolated.id}/worktree/merge`, 'POST', {}, 409);
  await run(isolated.cwd, 'add', '.'); await run(isolated.cwd, 'commit', '-qm', 'member');
  await writeFile(join(repo, 'README.md'), 'dirty\n');
  await request(`/api/sessions/${isolated.id}/worktree/merge`, 'POST', {}, 409);
  await run(repo, 'checkout', '--', 'README.md');
  const merged = await request<{ merged: boolean; ahead: number }>(`/api/sessions/${isolated.id}/worktree/merge`, 'POST', {});
  assert.equal(merged.merged, true);
  assert.equal(await readFile(join(repo, 'feature.txt'), 'utf8'), 'member work\n');

  // A conflicting branch is aborted and the workspace stays exactly as it was.
  const rival = await request<Session>('/api/sessions', 'POST', { backend: 'claude', title: '冲突成员', groupId: group.id, placement: 'worktree', briefing: false }, 201);
  await writeFile(join(rival.cwd, 'README.md'), 'rival\n'); await run(rival.cwd, 'add', '.'); await run(rival.cwd, 'commit', '-qm', 'rival');
  await writeFile(join(repo, 'README.md'), 'mainline\n'); await run(repo, 'commit', '-qam', 'mainline');
  const head = await run(repo, 'rev-parse', 'HEAD');
  const conflict = await request<{ error: string }>(`/api/sessions/${rival.id}/worktree/merge`, 'POST', {}, 409);
  assert.match(conflict.error, /合并冲突（1 个文件），已撤销/);
  assert.equal(await run(repo, 'rev-parse', 'HEAD'), head);
  assert.equal(await run(repo, 'status', '--porcelain'), '');
  assert.equal(await readFile(join(repo, 'README.md'), 'utf8'), 'mainline\n');

  // Cleanup archives the member and keeps the branch.
  const removed = await request<Session>(`/api/sessions/${isolated.id}/worktree/remove`, 'POST', {});
  assert.equal(removed.archived, true); assert.equal(removed.worktree, undefined);
  await assert.rejects(readFile(join(isolated.cwd, 'feature.txt')));
  assert.match(await run(repo, 'branch', '--list', isolated.worktree!.branch), /dili\//);
});

test('Claude stopped history pages never launch a CLI; live and restored IDs agree and evicted messages stay reachable', { timeout: 30_000 }, async t => {
  const f = await launch(t), { request, snapshot } = f;
  const contact = await request<Session>('/api/sessions', 'POST', { backend: 'claude', title: 'Claude long history', cwd: f.directory }, 201);
  const path = `/api/sessions/${contact.id}`;
  const started = await request<Session>(path + '/start', 'POST', { mode: 'chat' });
  await request(path + '/stop', 'POST', {});
  const nativeId = started.nativeSessionId!;
  const folder = join(f.directory, 'claude-home/projects/fixture');
  await mkdir(folder, { recursive: true });
  const file = join(folder, nativeId + '.jsonl');
  const records = Array.from({ length: 106 }, (_, i) => ({ type: i % 2 ? 'assistant' : 'user', uuid: randomUUID(), sessionId: nativeId, message: { role: i % 2 ? 'assistant' : 'user', content: `history ${i}` } }));
  await writeFile(file, records.map(row => JSON.stringify(row)).join('\n') + '\n');
  const callsBefore = await readFile(join(f.directory, 'claude-calls.jsonl'), 'utf8');
  let recent = await snapshot(contact.id);
  assert.equal(recent.connected, false);
  assert.equal(recent.items.length, 40);
  assert.equal(recent.items[0].text, 'history 66');
  let cursor = recent.historyCursor, items = [...recent.items];
  while (cursor) {
    const page = await request<import('../shared/chat.ts').AgentChatHistoryPage>(path + '/chat/history?cursor=' + encodeURIComponent(cursor));
    items.unshift(...page.items); cursor = page.nextCursor;
  }
  assert.deepEqual(items.map(item => item.text), records.map(row => row.message.content));
  assert.equal(await readFile(join(f.directory, 'claude-calls.jsonl'), 'utf8'), callsBefore);
  assert.equal((await f.current(contact.id)).running, false);
  await request(path + '/chat/history?cursor=' + encodeURIComponent(recent.historyCursor! + 'tampered'), 'GET', undefined, 409);
  await request(path + '/start', 'POST', { mode: 'chat' });
  const payload = { requestId: randomUUID(), text: 'identity check' };
  await request(path + '/chat/messages', 'POST', payload);
  await until(async () => !(await snapshot(contact.id)).activeTurnId, 'Claude native result missing');
  const live = (await snapshot(contact.id)).items.slice(-2);
  assert.ok(live.every(item => item.id.startsWith(`claude:${nativeId}:`)));
  assert.equal(live[1].replaces?.length, 1);
  await request(path + '/stop', 'POST', {});
  const restored = (await snapshot(contact.id)).items.slice(-2);
  assert.deepEqual(restored.map(item => [item.id, item.text]), live.map(item => [item.id, item.text]));
  const fork = await request<Session>(path + '/fork', 'POST', { title: 'Paged Claude child' }, 201);
  const forkPath = `/api/sessions/${fork.id}`;
  const child = await request<Session>(forkPath + '/start', 'POST', { mode: 'chat' });
  const inherited = await snapshot(fork.id);
  assert.equal(inherited.items.length, 40, 'A not-yet-saved fork must show a bounded inherited page');
  assert.ok(inherited.items.every(item => item.id.startsWith(`claude:${child.nativeSessionId}:`)));
  assert.equal(inherited.historyCursor, null, 'A source cursor cannot page the child log');
  await request(forkPath + '/stop', 'POST', {});
  assert.deepEqual((await snapshot(fork.id)).items, inherited.items);
  await request(forkPath + '/start', 'POST', { mode: 'chat' });
  await request(forkPath + '/chat/messages', 'POST', { requestId: randomUUID(), text: 'fork identity' });
  await until(async () => !(await snapshot(fork.id)).activeTurnId && !!(await snapshot(fork.id)).historyCursor, 'Saved fork cursor missing');
  const forkSeen = new Map((await snapshot(fork.id)).items.map(item => [item.id, item]));
  cursor = (await snapshot(fork.id)).historyCursor;
  while (cursor) {
    const page = await request<import('../shared/chat.ts').AgentChatHistoryPage>(forkPath + '/chat/history?cursor=' + encodeURIComponent(cursor));
    for (const item of page.items) forkSeen.set(item.id, item);
    cursor = page.nextCursor;
  }
  assert.equal([...forkSeen.values()].filter(item => item.text.startsWith('history ')).length, 106);
  assert.equal(forkSeen.size, 110, 'Native fork history must reconcile with the inherited page without duplicates');
  await request(forkPath + '/stop', 'POST', {});
  await request(path + '/start', 'POST', { mode: 'chat' });
  await request(path + '/chat/messages', 'POST', { requestId: randomUUID(), text: 'BURST' });
  await until(async () => !(await snapshot(contact.id)).activeTurnId && !!(await snapshot(contact.id)).historyCursor, 'Burst history cursor missing');
  recent = await snapshot(contact.id);
  assert.ok(recent.items.length <= 200);
  const seen = new Map(recent.items.map(item => [item.id, item]));
  cursor = recent.historyCursor;
  while (cursor) {
    const page = await request<import('../shared/chat.ts').AgentChatHistoryPage>(path + '/chat/history?cursor=' + encodeURIComponent(cursor));
    for (const item of page.items) seen.set(item.id, item);
    cursor = page.nextCursor;
  }
  assert.equal([...seen.values()].filter(item => item.text.startsWith('progress ')).length, 240);
  assert.equal([...seen.values()].filter(item => item.text === 'history 0').length, 1);
  assert.equal((await snapshot(contact.id)).items.length, recent.items.length, 'Paging must not mutate the live snapshot');
});

test('failed terminal attachment leaves the graphical Codex turn running', { timeout: 30_000 }, async t => {
  const f = await launch(t), source = await f.create('Viewer failure');
  const path = `/api/sessions/${source.id}`;
  await f.request(path + '/start', 'POST', { mode: 'chat' });
  await f.request(path + '/chat/messages', 'POST', { requestId: randomUUID(), text: 'HOLD live task' });
  await until(async () => !!(await f.snapshot(source.id)).activeTurnId, 'Turn did not start');
  const active = (await f.snapshot(source.id)).activeTurnId;
  await writeFile(join(f.directory, 'fail-tui'), '1');
  await f.request(path + '/start', 'POST', { mode: 'terminal' });
  await until(async () => (await f.calls()).some(call => call.event === 'tui'), 'TUI did not launch');
  await until(async () => (await f.current(source.id)).interactionMode === 'chat', 'Did not return to graphical executor');
  assert.equal((await f.current(source.id)).running, true);
  assert.equal((await f.snapshot(source.id)).activeTurnId, active);
  assert.equal((await f.calls()).filter(call => call.method === 'turn/interrupt').length, 0);
});

test('group image-only tasks persist server metadata and deliver native images to Codex', { timeout: 30000 }, async t => {
  const f = await launch(t);
  const group = await f.request<Group>('/api/groups', 'POST', { title: 'Image tasks' }, 201);
  const member = await f.request<Session>('/api/sessions', 'POST', { backend: 'codex', title: 'Image receiver', cwd: f.directory, groupId: group.id, briefing: false }, 201);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const upload = await fetch(`${f.base}/api/groups/${group.id}/attachments`, { method: 'POST', headers: { 'content-type': 'image/png', 'x-sessiondeck-token': f.csrfToken }, body: png });
  assert.equal(upload.status, 201);
  const image = await upload.json() as { id: string };
  const message = await f.request<GroupMessage & { deliveryErrors?: unknown[] }>(`/api/groups/${group.id}/messages`, 'POST', { text: '', kind: 'task', recipientIds: [member.id], attachments: [image.id], deliverNow: true }, 201);
  assert.equal(message.text, '');
  assert.equal(message.attachments?.[0].id, image.id);
  assert.equal(message.deliveryErrors, undefined);
  const input = (await f.calls()).filter(call => call.method === 'turn/start').at(-1)?.params?.input as { type: string; path?: string }[];
  const nativeImage = input.find(item => item.type === 'localImage');
  assert.ok(nativeImage?.path);
  assert.deepEqual(await readFile(nativeImage.path), png);
  const detail = await f.request<GroupDetail>(`/api/groups/${group.id}`);
  assert.equal(detail.messages.find(item => item.id === message.id)?.attachments?.[0].id, image.id);
  await f.request(`/api/groups/${group.id}/messages`, 'POST', { text: '', attachments: [] }, 400);
  await f.request(`/api/groups/${group.id}/messages`, 'POST', { attachments: [image.id, image.id] }, 400);
});

for (const backend of ['codex', 'claude'] as const) test(`${backend} appends native workspace permissions without changing cwd or interrupting tasks`, { timeout: 30_000 }, async t => {
  const f = await launch(t), { request } = f;
  const extra = join(f.directory, '额外 项目'), other = join(f.directory, 'other'), alias = join(f.directory, 'alias');
  await mkdir(extra); await mkdir(other); await symlink(extra, alias);
  const contact = await request<Session>('/api/sessions', 'POST', { backend, title: 'Additional workspace', cwd: f.directory, ...(backend === 'codex' ? { executionMode: 'auto' } : {}) }, 201);
  const route = `/api/sessions/${contact.id}/directories`;
  await request(route, 'POST', { path: join(f.directory, 'missing') }, 400);
  const staged = await request<Session>(route, 'POST', { path: extra });
  assert.deepEqual(staged.additionalDirectories, [extra]);
  assert.equal(staged.cwd, contact.cwd); assert.equal(staged.running, false); assert.equal(staged.directoriesPending, true);
  assert.deepEqual((await request<Session>(route, 'POST', { path: alias })).additionalDirectories, [extra]);
  const started = await request<Session>(`/api/sessions/${contact.id}/start`, 'POST', { mode: 'chat' });
  assert.equal(started.directoriesPending, false);
  if (backend === 'codex') {
    const updates = (await f.calls()).filter(call => call.method === 'thread/settings/update') as { params: Record<string, unknown> }[];
    assert.deepEqual(updates[0].params, { threadId: started.nativeSessionId, sandboxPolicy: { type: 'workspaceWrite', writableRoots: [f.directory, extra], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: false } });
    await writeFile(join(f.directory, 'deny-workspace-update'), '1');
    await request(route, 'POST', { path: other }, 400);
    assert.deepEqual((await f.current(contact.id)).additionalDirectories, [extra], 'native rejection must not record granted access');
    await rm(join(f.directory, 'deny-workspace-update'));
    await request(`/api/sessions/${contact.id}/chat/messages`, 'POST', { text: 'HOLD', requestId: randomUUID() });
    await request(route, 'POST', { path: other }, 409);
    assert.deepEqual((await f.current(contact.id)).additionalDirectories, [extra]);
    await request(`/api/sessions/${contact.id}/chat/interrupt`, 'POST', {});
    await until(async () => !(await f.snapshot(contact.id)).activeTurnId, 'Interrupt did not release workspace guard');
    const updated = await request<Session>(route, 'POST', { path: other });
    assert.deepEqual(updated.additionalDirectories, [extra, other]); assert.equal(updated.directoriesPending, false);
    assert.equal(updated.nativeSessionId, started.nativeSessionId); assert.equal(updated.running, true);
    const resumeCount = (await f.calls()).filter(call => call.method === 'thread/resume').length;
    await writeFile(join(f.directory, 'drop-workspace-observer'), '1');
    await until(async () => (await f.calls()).filter(call => call.method === 'thread/resume').length > resumeCount && (await f.snapshot(contact.id)).connected, 'Workspace observer did not reconnect');
    const reconnects = (await f.calls()).filter(call => call.method === 'thread/resume').slice(resumeCount) as { params: Record<string, unknown> }[];
    assert.ok(reconnects.every(call => call.params.sandbox === undefined), 'Auto observer reconnect must preserve appended native sandbox roots');
    const child = await request<Session>(`/api/sessions/${contact.id}/fork`, 'POST', {}, 201);
    assert.deepEqual(child.additionalDirectories, updated.additionalDirectories);
  } else {
    await request(`/api/sessions/${contact.id}/chat/messages`, 'POST', { text: 'HOLD', requestId: randomUUID() });
    const updated = await request<Session>(route, 'POST', { path: other });
    assert.equal(updated.directoriesPending, true); assert.equal(updated.running, true);
    assert.equal(updated.nativeSessionId, started.nativeSessionId);
    assert.ok((await f.snapshot(contact.id)).activeTurnId, 'saving a pending directory must not stop Claude');
    await request(`/api/sessions/${contact.id}/chat/interrupt`, 'POST', {});
    await request(`/api/sessions/${contact.id}/stop`, 'POST', {});
    const resumed = await request<Session>(`/api/sessions/${contact.id}/start`, 'POST', { mode: 'chat' });
    assert.equal(resumed.directoriesPending, false); assert.equal(resumed.nativeSessionId, started.nativeSessionId);
    const launches = (await readFile(join(f.directory, 'claude-print-launches.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(launches.at(-1).args.filter((_: string, index: number, args: string[]) => args[index - 1] === '--add-dir'), [extra, other]);
  }
  await request(`/api/sessions/${contact.id}/stop`, 'POST', {});
  await request(`/api/sessions/${contact.id}`, 'PATCH', { archived: true });
  await request(route, 'POST', { path: f.directory }, 409);
});


test('group directory grants validate the whole selection and return per-member idempotent results', { timeout: 30_000 }, async t => {
  const f = await launch(t), { request } = f;
  const extra = join(f.directory, 'group extra'), alias = join(f.directory, 'group alias');
  await mkdir(extra); await symlink(extra, alias);
  const group = await request<Group>('/api/groups', 'POST', { title: 'Batch workspace', workspace: f.directory }, 201);
  const members: Session[] = [];
  for (const backend of ['codex', 'claude', 'dsh']) members.push(await request<Session>('/api/sessions', 'POST', { backend, title: backend, groupId: group.id, briefing: false }, 201));
  const outsider = await f.create('Outside group');
  const route = `/api/groups/${group.id}/directories`, ids = members.map(member => member.id);
  for (const sessionIds of [undefined, [], 'all', [ids[0], null], new Array(101).fill(ids[0])]) await request(route, 'POST', { path: extra, sessionIds }, 400);
  await request(route, 'POST', { path: extra, sessionIds: [ids[0], outsider.id] }, 409);
  await request(route, 'POST', { path: join(f.directory, 'missing'), sessionIds: ids }, 400);
  assert.equal((await f.current(ids[0])).additionalDirectories, undefined, 'invalid batches must not partially grant');
  const response = await request<GroupDirectoryResponse>(route, 'POST', { path: extra, sessionIds: [...ids, ids[0]] });
  assert.equal(response.path, extra);
  assert.deepEqual(response.results.map(result => result.status), ['pending', 'pending', 'failed']);
  assert.match(response.results[2].error!, /单工作区/);
  for (const member of members.slice(0, 2)) {
    const current = await f.current(member.id);
    assert.deepEqual(current.additionalDirectories, [extra]); assert.equal(current.cwd, member.cwd); assert.equal(current.running, false);
  }
  assert.equal((await f.current(outsider.id)).additionalDirectories, undefined);
  assert.equal((await request<GroupDetail>(`/api/groups/${group.id}`)).group.workspace, f.directory);
  const repeated = await request<GroupDirectoryResponse>(route, 'POST', { path: alias, sessionIds: ids.slice(0, 2) });
  assert.deepEqual(repeated.results.map(result => result.status), ['unchanged', 'unchanged']);
  assert.deepEqual((await f.current(ids[0])).additionalDirectories, [extra]);
  await request(`/api/sessions/${ids[1]}`, 'PATCH', { archived: true });
  const archived = await request<GroupDirectoryResponse>(route, 'POST', { path: f.directory, sessionIds: ids.slice(0, 2) });
  assert.deepEqual(archived.results.map(result => result.status), ['unchanged', 'failed']);
  assert.match(archived.results[1].error!, /归档/);
  await request(`/api/groups/${group.id}`, 'PATCH', { archived: true });
  await request(route, 'POST', { path: extra, sessionIds: [ids[0]] }, 409);
  await request('/api/groups/missing/directories', 'POST', { path: extra, sessionIds: [ids[0]] }, 404);
});

test('group directory grants keep successful members when native members are busy or reject access', { timeout: 30_000 }, async t => {
  const f = await launch(t), { request } = f;
  const extra = join(f.directory, 'extra'), denied = join(f.directory, 'denied'); await mkdir(extra); await mkdir(denied);
  const group = await request<Group>('/api/groups', 'POST', { title: 'Live batch', workspace: f.directory }, 201);
  const members: Session[] = [];
  for (const backend of ['codex', 'claude']) members.push(await request<Session>('/api/sessions', 'POST', { backend, title: backend, groupId: group.id, briefing: false }, 201));
  const [codex, claude] = members, route = `/api/groups/${group.id}/directories`;
  for (const member of members) await request(`/api/sessions/${member.id}/start`, 'POST', { mode: 'chat' });
  await request(`/api/sessions/${codex.id}/chat/messages`, 'POST', { text: 'HOLD', requestId: randomUUID() });
  const partial = await request<GroupDirectoryResponse>(route, 'POST', { path: extra, sessionIds: members.map(member => member.id) });
  assert.deepEqual(partial.results.map(result => result.status), ['failed', 'pending']);
  assert.equal((await f.current(codex.id)).additionalDirectories, undefined);
  assert.deepEqual((await f.current(claude.id)).additionalDirectories, [extra]);
  assert.ok((await f.snapshot(codex.id)).activeTurnId, 'failed grant must not interrupt running work');
  await request(`/api/sessions/${codex.id}/chat/interrupt`, 'POST', {});
  await until(async () => !(await f.snapshot(codex.id)).activeTurnId, 'Interrupt did not release group grant guard');
  const retry = await request<GroupDirectoryResponse>(route, 'POST', { path: extra, sessionIds: [codex.id] });
  assert.deepEqual(retry.results, [{ sessionId: codex.id, status: 'applied' }]);
  assert.equal((await f.current(codex.id)).directoriesPending, false);
  await writeFile(join(f.directory, 'deny-workspace-update'), '1');
  const rejected = await request<GroupDirectoryResponse>(route, 'POST', { path: denied, sessionIds: members.map(member => member.id) });
  assert.deepEqual(rejected.results.map(result => result.status), ['failed', 'pending']);
  assert.deepEqual((await f.current(codex.id)).additionalDirectories, [extra]);
  assert.deepEqual((await f.current(claude.id)).additionalDirectories, [extra, denied]);
  for (const member of members) assert.equal((await f.current(member.id)).running, true);
});
