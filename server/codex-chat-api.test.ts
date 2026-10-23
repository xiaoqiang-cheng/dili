import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { copyFile, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import type { AppState, Delivery, Group, GroupDetail, GroupMessage, Session } from '../shared/types.ts';
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
  const member = await request<Session>('/api/sessions', 'POST', { backend: 'codex', title: 'Graphical group member', cwd: fixture.directory, groupId: group.id }, 201);
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
