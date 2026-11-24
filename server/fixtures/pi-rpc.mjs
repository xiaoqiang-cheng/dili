#!/usr/bin/env node
// Deterministic Pi RPC fixture for Dili's contract tests. It speaks the public
// JSONL protocol only; it is never used by a production launch.
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('fixture-pi 1.0.0'); process.exit(0); }
if (args.includes('--help')) { console.log('Usage: pi [--mode rpc] [--session-id <id>] [--fork <id>] [--name <name>]'); process.exit(0); }
const value = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const fork = value('--fork');
let sessionId = value('--session-id') ?? value('--session') ?? randomUUID();
if (fork && !value('--session-id')) sessionId = randomUUID();
const sessionName = value('--name') ?? 'Fixture Pi';
const sessionDir = process.env.PI_CODING_AGENT_SESSION_DIR ?? join(process.env.PI_CODING_AGENT_DIR ?? process.cwd(), 'sessions');
const sessionFile = join(sessionDir, `2026-01-02T03-04-05-000Z_${sessionId}.jsonl`);
let entries = [];
try {
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(sessionFile, JSON.stringify({ type: 'session', version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: process.cwd() }) + '\n');
} catch { /* the fixture still speaks RPC when its temp directory is read-only */ }
let model = { id: 'fixture-model', name: 'Fixture Model', provider: 'fixture', reasoning: true };
let thinkingLevel = 'off';
let active = false;
let waitForUi = null;
let turnTimer = null;
const queuedPrompts = [];
let counter = 0;

function send(message) { process.stdout.write(JSON.stringify(message) + '\n'); }
function respond(id, command, data) { send({ id, type: 'response', command, success: true, ...(data !== undefined ? { data } : {}) }); }
function fail(id, command, error) { send({ id, type: 'response', command, success: false, error }); }
function entry(message) {
  const item = { type: 'message', id: randomUUID().slice(0, 8), parentId: entries.at(-1)?.id ?? null, timestamp: new Date().toISOString(), message };
  entries.push(item);
  return item;
}
function append(line) { try { writeFileSync(sessionFile, JSON.stringify(line) + '\n', { flag: 'a' }); } catch { /* test temp dir */ } }
function event(type, extra = {}) { send({ type, ...extra }); }
function finish(aborted = false, text = 'Hello world') {
  if (!active) return;
  if (turnTimer) { clearTimeout(turnTimer); turnTimer = null; }
  active = false;
  event('turn_end');
  if (aborted) queuedPrompts.length = 0;
  // Pi follow-ups start another turn in the same agent run. Keep the final
  // agent_end/agent_settled for the last queued prompt only.
  if (!aborted && queuedPrompts.length) { startTurn(queuedPrompts.shift()); return; }
  event('agent_end');
  event('agent_settled', { aborted });
}
function startTurn(text) {
  active = true;
  const user = entry({ role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() });
  append(user);
  event('agent_start'); event('turn_start');
  event('message_start', { message: { role: 'user', content: [{ type: 'text', text }] } });
  event('message_end', { message: { role: 'user', content: [{ type: 'text', text }] } });
  event('message_start', { message: { role: 'assistant', content: [] } });
  const reply = text === 'ask' ? 'confirmed' : text === 'slow' ? 'Slow reply' : 'Hello world';
  if (text === 'ask') {
    event('extension_ui_request', { id: `ui-${++counter}`, method: 'confirm', title: 'Fixture confirmation', message: 'Proceed?' });
    waitForUi = (answer) => {
      const replyText = `confirmed:${answer}`;
      const assistant = entry({ role: 'assistant', content: [{ type: 'text', text: replyText }], usage: { input: 3, output: 2 }, model: model.id });
      append(assistant);
      event('message_update', { assistantMessageEvent: { type: 'text_delta', delta: replyText } });
      event('message_end', { message: { role: 'assistant', content: [{ type: 'text', text: replyText }] } });
      finish(false, replyText);
    };
    return;
  }
  turnTimer = setTimeout(() => {
    turnTimer = null;
    if (!active) return;
    event('message_update', { assistantMessageEvent: { type: 'text_delta', delta: 'Hello ' } });
    event('message_update', { assistantMessageEvent: { type: 'text_delta', delta: 'world' } });
    const assistant = entry({ role: 'assistant', content: [{ type: 'text', text: reply }], usage: { input: 3, output: 2 }, model: model.id });
    append(assistant);
    event('message_end', { message: { role: 'assistant', content: [{ type: 'text', text: reply }] } });
    finish(false, reply);
  }, text === 'slow' ? 500 : 5);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).replace(/\r$/, '');
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    let command;
    try { command = JSON.parse(line); } catch { continue; }
    if (command.type === 'extension_ui_response') { const callback = waitForUi; waitForUi = null; callback?.(command.confirmed === true); continue; }
    const id = command.id;
    switch (command.type) {
      case 'get_state': respond(id, 'get_state', { model, thinkingLevel, isStreaming: active, sessionFile, sessionId, sessionName, messageCount: entries.length }); break;
      case 'get_entries': {
        let list = entries;
        if (typeof command.since === 'string') { const index = entries.findIndex(entry => entry.id === command.since); list = index >= 0 ? entries.slice(index + 1) : []; }
        respond(id, 'get_entries', { entries: list }); break;
      }
      case 'get_available_models': respond(id, 'get_available_models', { models: [model] }); break;
      case 'get_available_thinking_levels': respond(id, 'get_available_thinking_levels', { levels: ['off', 'high'] }); break;
      case 'set_model': model = { ...model, id: command.modelId ?? model.id, provider: command.provider ?? model.provider }; respond(id, 'set_model', model); break;
      case 'set_thinking_level': thinkingLevel = command.level; respond(id, 'set_thinking_level'); break;
      case 'set_session_name': respond(id, 'set_session_name'); break;
      case 'prompt': {
        respond(id, 'prompt', { disposition: 'started' });
        const message = String(command.message ?? '');
        if (active) queuedPrompts.push(message); else startTurn(message);
        break;
      }
      case 'abort': respond(id, 'abort'); finish(true); break;
      case 'clear_queue': respond(id, 'clear_queue'); break;
      default: fail(id, command.type, `unsupported ${command.type}`);
    }
  }
});
process.stdin.on('end', () => process.exit(0));
