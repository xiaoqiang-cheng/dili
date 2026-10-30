#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path'), readline = require('node:readline'), { randomUUID } = require('node:crypto');
if (process.argv.includes('--version')) { console.log('fixture-stream'); process.exit(0); }
if (process.argv.includes('--help')) { console.log('--add-dir --resume --fork-session --input-format --include-partial-messages\n  --allow-dangerously-skip-permissions  Enable bypassing all permission checks\n  --permission-mode <mode>              Permission mode to use for the session\n                                        (choices: "acceptEdits", "auto",\n                                        "bypassPermissions", "manual",\n                                        "dontAsk", "plan")\n  --print'); process.exit(0); }
const root = process.env.SESSIONDECK_FIXTURE_DIR;
if (!process.argv.includes('--print')) {
  fs.appendFileSync(path.join(root, 'claude-launches.jsonl'), JSON.stringify({ pid: process.pid, args: process.argv.slice(2) }) + '\n');
  process.stdin.setRawMode(true);
  process.stdin.on('data', data => fs.appendFileSync(path.join(root, 'native-input.log'), data));
  process.stdout.write('READY');
} else {
  const arg = flag => process.argv[process.argv.indexOf(flag) + 1];
  fs.appendFileSync(path.join(root, 'claude-print-launches.jsonl'), JSON.stringify({ pid: process.pid, args: process.argv.slice(2) }) + '\n');
  const id = process.argv.includes('--session-id') ? arg('--session-id') : arg('--resume');
  const folder = path.join(root, 'claude-home/projects/fixture'); fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, id + '.jsonl');
  let forkSource = process.argv.includes('--fork-session') ? path.join(folder, arg('--resume') + '.jsonl') : undefined;
  const out = row => process.stdout.write(JSON.stringify({ ...row, session_id: id }) + '\n');
  const saved = (role, content, uuid = randomUUID()) => fs.appendFileSync(file, JSON.stringify({ type: role, uuid, sessionId: id, timestamp: new Date().toISOString(), message: { role, content } }) + '\n');
  const event = payload => out({ type: 'stream_event', event: payload, parent_tool_use_id: null });
  let replyText = '第一段 **完成**', groupInterim = '', timer, messageId, active = false, pending, model = process.argv.includes('--model') ? arg('--model') : 'fixture-claude', mode = process.argv.includes('--permission-mode') ? arg('--permission-mode').replace(/^manual$/, 'default') : 'default';
  const bypassAllowed = process.argv.includes('--allow-dangerously-skip-permissions') || process.argv.includes('--dangerously-skip-permissions');
  function finish(error = false) {
    clearTimeout(timer);
    if (!active) return;
    active = false;
    if (!error) {
      if (groupInterim) { const uuid = randomUUID(), interim = [{ type: 'text', text: groupInterim }]; out({ type: 'assistant', uuid, message: { id: 'interim_' + uuid, role: 'assistant', content: interim } }); saved('assistant', interim, uuid); groupInterim = ''; }
      const content = [{ type: 'text', text: replyText }];
      const uuid = randomUUID();
      out({ type: 'assistant', uuid, message: { id: messageId, role: 'assistant', content } });
      saved('assistant', content, uuid);
    }
    out({ type: 'result', subtype: error ? 'error_during_execution' : 'success', is_error: error });
  }
  readline.createInterface({ input: process.stdin }).on('line', line => {
    const row = JSON.parse(line);
    fs.appendFileSync(path.join(root, 'claude-calls.jsonl'), JSON.stringify(row) + '\n');
    if (row.type === 'control_request') {
      let response = {};
      if (row.request.subtype === 'initialize') response = { current_permission_mode: mode, models: [{ value: 'fixture-claude', displayName: 'Claude Fixture' }, { value: 'fixture-alternative', displayName: 'Claude Alternative' }, { value: 'fixture-denied', displayName: 'Native denied' }, { value: 'fixture-no-ack', displayName: 'Missing confirmation' }] };
      if (row.request.subtype === 'set_model') {
        if (row.request.model === 'fixture-denied') { out({ type: 'control_response', response: { subtype: 'error', request_id: row.request_id, error: 'Native policy denied model' } }); return; }
        model = row.request.model; response = model === 'fixture-no-ack' ? {} : { model };
      }
      if (row.request.subtype === 'set_permission_mode') {
        // Mirrors the real CLI: bypass needs an allow flag at launch; manual reads back as default.
        if (row.request.mode === 'bypassPermissions' && !bypassAllowed) { out({ type: 'control_response', response: { subtype: 'error', request_id: row.request_id, error: 'Cannot set permission mode to bypassPermissions because the session was not launched with --dangerously-skip-permissions' } }); return; }
        mode = row.request.mode === 'manual' ? 'default' : row.request.mode; response = { mode };
      }
      out({ type: 'control_response', response: { subtype: 'success', request_id: row.request_id, response } });
      if (row.request.subtype === 'interrupt') finish(true);
    } else if (row.type === 'user') {
      // Real Claude delays creating the child's saved log until its first turn.
      if (forkSource && fs.existsSync(forkSource)) {
        const copied = fs.readFileSync(forkSource, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.stringify({ ...JSON.parse(line), sessionId: id })).join('\n');
        fs.writeFileSync(file, copied + '\n'); forkSource = undefined;
      }
      active = true; messageId = 'msg_' + randomUUID();
      saved('user', row.message.content, row.uuid);
      const text = row.message.content.filter(block => block.type === 'text').map(block => block.text).join('');
      // Group tasks get a reply with the conclusion section the group prompt asks for.
      // Group turns: a join greeting, or an interim note then (in the same turn) a final answer.
      replyText = text.includes('【群聊入群说明】') ? '大家好，我是验证员，负责验证。' : text.includes('【群聊任务】') ? `登录页通过验证（${text.includes('## 引用的回答') ? '参考了引用' : '独立完成'}）。` : '第一段 **完成**';
      groupInterim = text.includes('【群聊任务】') && !text.includes('PARTIAL') ? '正在检查…' : '';
      if (text === 'EXIT') process.exit(1);
      // A provider failure mid-turn: an error result with no assistant text.
      if (text.includes('FAIL-TURN')) { active = true; out({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['unexpected status 526: origin SSL certificate invalid'] }); active = false; return; }
      if (text === 'BURST') {
        for (let i = 0; i < 240; i++) {
          const uuid = randomUUID(), content = [{ type: 'text', text: `progress ${i}` }];
          saved('assistant', content, uuid);
          out({ type: 'assistant', uuid, message: { id: `burst_${i}`, role: 'assistant', content } });
        }
        finish(); return;
      }
      event({ type: 'message_start', message: { id: messageId, role: 'assistant' } });
      event({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
      event({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hidden reasoning' } });
      event({ type: 'content_block_stop', index: 0 });
      event({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
      event({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '第一段 **' } });
      // These unrelated subagent deltas must never enter the contact's reply.
      out({ type: 'stream_event', parent_tool_use_id: 'subagent', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'hidden child output' } } });
      if (text === 'APPROVAL' || text === 'QUESTION') {
        pending = randomUUID();
        out({ type: 'control_request', request_id: pending, request: { subtype: 'can_use_tool', tool_name: text === 'QUESTION' ? 'AskUserQuestion' : 'Bash', input: text === 'QUESTION' ? { questions: [{ header: '方向', question: '选择方向', options: [{ label: '一', description: '第一种' }, { label: '二', description: '第二种' }] }] } : { command: 'echo fixture' } } });
      } else if (text !== 'HOLD') timer = setTimeout(() => {
        event({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '完成**' } });
        finish();
      }, 800);
    } else if (row.type === 'control_response' && row.response.request_id === pending) { pending = undefined; finish(); }
  });
}
