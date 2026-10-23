/** Real installed Claude CLI against a disposable loopback provider. No paid
 * model calls or writes to the user's Claude profile/workspace. */
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ClaudeChatBridge } from '../server/claude-chat.ts';
import { ConversationReader } from '../server/conversation.ts';
import { buildLaunch, findExecutable } from '../server/adapters.ts';
import type { Session } from '../shared/types.ts';

const executable = await findExecutable('claude'); assert.ok(executable, 'Install Claude before running this optional smoke check');
const root = await mkdtemp(join(tmpdir(), 'dili-claude-stream-')), home = join(root, 'claude'), cwd = join(root, 'workspace');
await mkdir(home); await mkdir(cwd);
await writeFile(join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }));
const reader = new ConversationReader({ claudeHome: home, cacheMs: 0 });
const bridge = new ClaudeChatBridge((id, cursor) => reader.readClaudePage(id, cursor));
let release: (() => void) | undefined, failure: Error | undefined;
const held = new Set<ServerResponse>();
const requests: string[] = [];
const requestedModels: string[] = [];
const provider = createServer(async (req, res) => {
  try {
    let body = ''; for await (const data of req) body += data;
    if (req.method === 'HEAD') { res.end(); return; }
    if (req.url?.includes('count_tokens')) { res.setHeader('content-type', 'application/json'); res.end('{"input_tokens":10}'); return; }
    assert.equal(new URL(req.url!, 'http://localhost').pathname, '/v1/messages'); assert.equal(req.headers['x-api-key'], 'dili-loopback-fixture');
    const input = JSON.parse(body); requests.push(JSON.stringify(input.messages)); requestedModels.push(input.model);
    res.writeHead(200, { 'content-type': 'text/event-stream' }); held.add(res); res.once('close', () => held.delete(res));
    const event = (type: string, fields: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
    event('message_start', { message: { id: `msg_fixture_${requests.length}`, type: 'message', role: 'assistant', model: input.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
    if (requests.at(-1)!.includes('DILI_STREAM_APPROVAL') && !requests.at(-1)!.includes('dili-tool-permission')) {
      event('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'dili-tool-permission', name: 'Bash', input: {} } });
      event('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command: `printf dili > ${join(root, 'native-approved.txt')}`, description: 'Dili fixture: request approval for a temporary file write' }) } });
      event('content_block_stop', { index: 0 });
      event('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 4 } });
      event('message_stop', {}); res.end(); return;
    }
    event('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } });
    event('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'fixture reasoning should stay hidden' } });
    event('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'fixture-signature' } });
    event('content_block_stop', { index: 0 });
    event('content_block_start', { index: 1, content_block: { type: 'text', text: '' } });
    event('content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'Hello **' } });
    release = () => {
      event('content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'world**' } });
      event('content_block_stop', { index: 1 });
      event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 8 } });
      event('message_stop', {}); res.end(); release = undefined;
    };
  } catch (error) { failure = error as Error; res.destroy(); }
});
async function until(check: () => boolean, why: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) { if (failure) throw failure; if (check()) return; await delay(25); }
  throw new Error(why);
}
try {
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert.ok(address && typeof address === 'object');
  // Remove inherited provider credentials only in this smoke-test process.
  for (const key of Object.keys(process.env)) if (/^(ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CONFIG_DIR)/.test(key)) delete process.env[key];
  const env = { CLAUDE_CONFIG_DIR: home, ANTHROPIC_API_KEY: 'dili-loopback-fixture', ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1' };
  const args = ['--model', 'claude-sonnet-4-6', '--setting-sources', '', '--strict-mcp-config', '--no-chrome', '--tools', ''];
  const id = randomUUID();
  await bridge.start(id, cwd, { file: executable, args: ['--session-id', id, ...args], env }, { messages: [], truncated: false });
  let settings = await bridge.readChatSettings(id);
  assert.ok(settings.models.length, 'Native initialize did not supply model choices');
  settings = await bridge.updateChatSettings(id, { version: settings.version, field: 'permission', value: 'plan' });
  assert.equal(settings.permission, 'plan');
  settings = await bridge.updateChatSettings(id, { version: settings.version, field: 'permission', value: 'default' });
  settings = await bridge.updateChatSettings(id, { version: settings.version, field: 'model', value: settings.models.find(model => model.id !== 'default')!.id });
  await bridge.sendPrompt(id, 'DILI_STREAM_FIRST');
  await until(() => bridge.chatSnapshot(id)?.items.some(item => item.text === 'Hello **') === true, 'No real native partial text');
  assert.ok(bridge.chatSnapshot(id)?.activeTurnId, 'Partial must be visible while the turn is active');
  assert.equal(requestedModels.at(-1), settings.model, 'Next real provider request must use the native model selection');
  await assert.rejects(bridge.updateChatSettings(id, { version: settings.version, field: 'permission', value: 'plan' }), /任务|审批/);
  assert.ok(release); release();
  await until(() => bridge.chatSnapshot(id)?.activeTurnId === null, 'Native turn did not finish');
  assert.deepEqual(bridge.chatSnapshot(id)?.items.filter(item => item.type === 'assistant').map(item => item.text), ['Hello **world**']);
  const history = await reader.readLatest({ backend: 'claude', nativeSessionId: id, cwd, forkPending: false });
  assert.ok(history.messages.some(item => item.text === 'DILI_STREAM_FIRST'));
  const stableIds = bridge.chatSnapshot(id)!.items.filter(item => ['user', 'assistant'].includes(item.type)).map(item => item.id);
  assert.deepEqual(stableIds, history.messages.map(item => item.id), 'Native stream UUIDs must match persisted history');
  await bridge.closeSession(id);
  assert.deepEqual((await bridge.readChat(id)).items.map(item => item.id), stableIds, 'Stopped read must preserve message identity without launching a CLI');
  await bridge.start(id, cwd, { file: executable, args: ['--resume', id, ...args], env }, history);
  const image = join(root, 'image.png');
  await writeFile(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
  await bridge.sendPrompt(id, 'DILI_STREAM_SECOND', undefined, [image]);
  await until(() => !!release, 'Resumed Claude did not reach the provider');
  assert.ok(requests.at(-1)?.includes('DILI_STREAM_FIRST'), 'Resume lost native context');
  assert.ok(requests.at(-1)?.includes('image/png'), 'Native image input was not forwarded');
  release!(); await until(() => bridge.chatSnapshot(id)?.activeTurnId === null, 'Resumed turn did not finish');
  await bridge.closeSession(id);
  const child = randomUUID(), parentHistory = await reader.readLatest({ backend: 'claude', nativeSessionId: id, cwd, forkPending: false });
  await bridge.start(child, cwd, { file: executable, args: ['--resume', id, '--fork-session', '--session-id', child, ...args], env }, parentHistory);
  assert.ok(bridge.chatSnapshot(child)?.items.some(item => item.text === 'DILI_STREAM_FIRST'), 'Forked GUI must show inherited history before the first new prompt');
  const inheritedIds = bridge.chatSnapshot(child)!.items.map(item => item.id);
  await bridge.closeSession(child);
  assert.deepEqual((await bridge.readChat(child)).items.map(item => item.id), inheritedIds, 'An unused stopped fork must retain its bounded inherited view');
  await bridge.start(child, cwd, { file: executable, args: ['--resume', id, '--fork-session', '--session-id', child, ...args], env });
  await bridge.sendPrompt(child, 'DILI_STREAM_FORK');
  await until(() => !!release, 'Forked Claude did not reach the provider');
  assert.ok(requests.at(-1)?.includes('DILI_STREAM_FIRST'), 'Fork lost source context');
  release!(); await until(() => bridge.chatSnapshot(child)?.activeTurnId === null, 'Forked turn did not finish');
  await bridge.closeSession(child);
  const childHistory = await reader.readLatest({ backend: 'claude', nativeSessionId: child, cwd, forkPending: false });
  assert.ok(childHistory.messages.some(item => item.text === 'DILI_STREAM_FORK'));
  assert.deepEqual(childHistory.messages.slice(0, inheritedIds.length).map(item => item.id), inheritedIds, 'Inherited GUI IDs must match the native fork log once saved');
  const blank = randomUUID();
  await bridge.start(blank, cwd, { file: executable, args: ['--session-id', blank, ...args], env }, { messages: [], truncated: false });
  await bridge.closeSession(blank);
  const blankCommand = await buildLaunch({ backend: 'claude', nativeSessionId: blank, forkPending: false, claudeUnwritten: { sourceId: null }, title: 'Blank chat', cwd } as Session);
  await bridge.start(blank, cwd, { ...blankCommand, args: [...blankCommand.args, ...args], env }, { messages: [], truncated: false });
  await bridge.sendPrompt(blank, 'DILI_STREAM_BLANK_RESUME');
  await until(() => !!release, 'An unused session could not resume');
  release!(); await until(() => bridge.chatSnapshot(blank)?.activeTurnId === null, 'Unused resumed turn did not finish');
  await bridge.closeSession(blank);
  const approvalId = randomUUID();
  await bridge.start(approvalId, cwd, { file: executable, args: ['--session-id', approvalId, ...args.slice(0, -2), '--tools', 'Bash'], env }, { messages: [], truncated: false });
  await bridge.sendPrompt(approvalId, 'DILI_STREAM_APPROVAL');
  await until(() => !!bridge.chatSnapshot(approvalId)?.requests.length, 'Native permission request did not reach the GUI bridge');
  const approval = bridge.chatSnapshot(approvalId)!.requests[0];
  assert.equal(approval.kind, 'approval');
  await bridge.answerChatRequest(approvalId, approval.id, { decision: 'deny' });
  await until(() => !!release, 'Native tool denial did not return to the model');
  release!(); await until(() => bridge.chatSnapshot(approvalId)?.activeTurnId === null, 'Approval turn did not finish');
  await bridge.sendPrompt(approvalId, 'DILI_STREAM_INTERRUPT');
  await until(() => !!release, 'Interrupt fixture did not start');
  await bridge.stopSession(approvalId);
  await until(() => bridge.chatSnapshot(approvalId)?.activeTurnId === null, 'Native interrupt did not finish');
  release = undefined;
  console.log('Real Claude stream-json: native model list/switch and next-request effect, permission switch, busy guard, streaming, Markdown, images, resume, fork, empty-chat reopening, tool approval and interrupt passed.');
} finally {
  await bridge.close(); for (const res of held) res.destroy();
  await new Promise<void>(resolve => provider.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
}
