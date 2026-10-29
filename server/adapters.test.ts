import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, open, writeFile, rm, symlink, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { runInNewContext } from 'node:vm';
import { dshAutoPlugin } from './dsh-auto.ts';
import { buildLaunch, discoverSessions, resolveNativeSessionId, validateNativeId } from './adapters.js';
import { zstdCompressSync } from 'node:zlib';
import { DshBridge, dshDeepLinkClient } from './dsh.js';
import type { Session } from '../shared/types.js';
import { claudePermissionChoices, normalizeClaudePermission, parseClaudePermissionModes } from '../shared/permissions.ts';

const makeSession = (patch: Partial<Session> = {}): Session => ({ id: randomUUID(), backend: 'codex', title: 'test', cwd: '/tmp', nativeSessionId: null, groupId: null, parentId: null, forkPending: false, status: 'idle', statusSource: 'process', statusDetail: '', lastActivity: new Date().toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), archived: false, pinned: false, unread: 0, running: false, origin: 'created', ...patch });

test('native launch uses argument arrays, preserves fork source, rejects option injection', async () => {
  const saved = { codex: process.env.SESSIONDECK_CODEX_BIN, claude: process.env.SESSIONDECK_CLAUDE_BIN };
  process.env.SESSIONDECK_CODEX_BIN = process.execPath;
  process.env.SESSIONDECK_CLAUDE_BIN = process.execPath;
  try {
    const source = randomUUID();
    const fork = await buildLaunch(makeSession({ nativeSessionId: source, forkPending: true, cwd: '/tmp/path with spaces' }));
    assert.deepEqual(fork.args, ['fork', source, '--cd', '/tmp/path with spaces']);
    assert.equal(fork.nativeSessionId, undefined);
    const claude = await buildLaunch(makeSession({ backend: 'claude', nativeSessionId: source, forkPending: true, title: '$(touch /tmp/nope)' }));
    assert.deepEqual(claude.args.slice(0, 3), ['--resume', source, '--fork-session']);
    assert.notEqual(claude.nativeSessionId, source);
    assert.equal(claude.args.at(-1), '$(touch /tmp/nope)');
    const unwritten = await buildLaunch(makeSession({ backend: 'claude', nativeSessionId: source, claudeUnwritten: { sourceId: null } }));
    assert.equal(unwritten.nativeSessionId, source);
    assert.deepEqual(unwritten.args.slice(0, 2), ['--session-id', source]);
    const emptyFork = await buildLaunch(makeSession({ backend: 'claude', nativeSessionId: claude.nativeSessionId, claudeUnwritten: { sourceId: source } }));
    assert.deepEqual(emptyFork.args.slice(0, 5), ['--resume', source, '--fork-session', '--session-id', claude.nativeSessionId]);
    await assert.rejects(buildLaunch(makeSession({ nativeSessionId: '--dangerously-bypass-approvals-and-sandbox' })), /无效/);
    assert.throws(() => validateNativeId('dsh', '../session-id'), /无效/);
    assert.throws(() => validateNativeId('dsh', `session-${'-'.repeat(36)}`), /无效/);
  } finally {
    for (const [backend, value] of Object.entries(saved)) { const key = `SESSIONDECK_${backend.toUpperCase()}_BIN`; if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test('Claude permission modes come from the installed CLI and launch args are shared by every executor', async t => {
  // Wrapped exactly like `claude --help` 2.1.280 prints it.
  const help = `  --permission-mode <mode>              Permission mode to use for the session
                                        (choices: "acceptEdits", "auto",
                                        "bypassPermissions", "manual",
                                        "dontAsk", "plan")
  --permission-prompts <target>         Who answers permission prompts with
                                        (choices: "host", "none", default:
                                        "host")`;
  assert.deepEqual(parseClaudePermissionModes(help), ['default', 'acceptEdits', 'auto', 'bypassPermissions', 'dontAsk', 'plan']);
  assert.deepEqual(parseClaudePermissionModes('--resume --print'), []);
  assert.equal(normalizeClaudePermission('manual'), 'default');
  assert.ok(claudePermissionChoices(['bypassPermissions'])[0].description!.includes('不再请求任何确认'));
  assert.deepEqual(claudePermissionChoices(['futureMode']), [{ id: 'futureMode', label: 'futureMode' }]);

  const saved = process.env.SESSIONDECK_CLAUDE_BIN;
  process.env.SESSIONDECK_CLAUDE_BIN = process.execPath;
  t.after(() => { if (saved === undefined) delete process.env.SESSIONDECK_CLAUDE_BIN; else process.env.SESSIONDECK_CLAUDE_BIN = saved; });
  const caps = { terminal: true, resume: true, fork: true, discovery: true, bypassOption: true };
  const contact = makeSession({ backend: 'claude', nativeSessionId: randomUUID(), nativeSettings: { permission: 'plan', model: 'opus' } });
  const args = (await buildLaunch(contact, undefined, caps)).args;
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'plan');
  assert.equal(args[args.indexOf('--model') + 1], 'opus');
  assert.ok(args.includes('--allow-dangerously-skip-permissions'), 'bypass stays switchable when the CLI offers it');
  assert.ok(!args.includes('--dangerously-skip-permissions'), 'the allow flag never enables bypass by itself');
  // Contact settings override the legacy Auto preset; `default` model is the native alias and is omitted.
  const legacy = (await buildLaunch({ ...contact, executionMode: 'auto', nativeSettings: { model: 'default' } }, undefined, caps)).args;
  assert.equal(legacy[legacy.indexOf('--permission-mode') + 1], 'auto');
  assert.ok(!legacy.includes('--model'));
  const bypass = (await buildLaunch({ ...contact, nativeSettings: { permission: 'bypassPermissions' } })).args;
  assert.ok(bypass.includes('--allow-dangerously-skip-permissions'), 'a bypass contact can launch even before capability detection');
  const plain = (await buildLaunch({ ...contact, nativeSettings: undefined })).args;
  assert.ok(!plain.includes('--permission-mode') && !plain.includes('--model') && !plain.includes('--allow-dangerously-skip-permissions'));
});

test('Auto launch keeps native defaults intact and opts in per contact for Claude, Codex and Harness', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dili-auto-launch-'));
  const names = ['SESSIONDECK_CLAUDE_BIN', 'SESSIONDECK_CODEX_BIN', 'SESSIONDECK_DSH_TUI_BIN'];
  const saved = names.map(name => process.env[name]);
  for (const name of names) process.env[name] = process.execPath;
  t.after(async () => { names.forEach((name, i) => { if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i]; }); await rm(directory, { recursive: true, force: true }); });
  for (const backend of ['claude', 'codex', 'dsh'] as const) {
    const contact = makeSession({ backend, executionMode: 'auto' });
    const launch = await buildLaunch(contact, directory);
    if (backend === 'claude') assert.deepEqual(launch.args.slice(0, 2), ['--permission-mode', 'auto']);
    if (backend === 'codex') { assert.ok(launch.args.includes('--approve-for-me')); assert.ok(!launch.args.includes('--dangerously-bypass-approvals-and-sandbox')); }
    if (backend === 'dsh') { assert.equal(launch.args[0], '--patch'); assert.match(launch.env!.NODE_OPTIONS!, /--import/); }
    const normal = await buildLaunch({ ...contact, executionMode: 'default' }, directory);
    assert.ok(!normal.args.includes('--permission-mode')); assert.ok(!normal.args.includes('--approve-for-me')); assert.ok(!normal.args.includes('--patch'));
    const resumed = await buildLaunch({ ...contact, nativeSessionId: randomUUID() }, directory);
    assert.ok(resumed.args.includes('--resume') || resumed.args.includes('resume'));
  }
  // Native preset changes are scoped to the intended main session, never subagents.
  const target = randomUUID(); let listener: (input: { agent: { id: string; session: object } }) => void = () => {};
  const changed: object[] = [];
  const ctx = { inject: (_: string[], apply: (ctx: unknown) => void) => apply(ctx), on: (_: string, apply: typeof listener) => { listener = apply; }, permissionPresets: { set: (session: object, mode: string) => { assert.equal(mode, 'auto'); changed.push(session); } } };
  Object.assign(ctx, { get: () => ctx.permissionPresets });
  runInNewContext(dshAutoPlugin(target).replace('export default ', '') + '\ndiliAuto(ctx);', { ctx });
  listener({ agent: { id: randomUUID(), session: {} } });
  const session = {}; listener({ agent: { id: target, session } }); listener({ agent: { id: target, session } });
  assert.deepEqual(changed, [session]);
  Object.assign(ctx, { get: () => undefined });
  runInNewContext(dshAutoPlugin(target).replace('export default ', '') + '\ndiliAuto(ctx);', { ctx });
  assert.throws(() => listener({ agent: { id: target, session: {} } }), /原生 Auto 权限服务未安装/);
});

test('discovery tolerates millisecond-only creation metadata and invalid native timestamps', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'deck-discovery-schema-'));
  const db = new DatabaseSync(join(dir, 'state_6.sqlite'));
  try {
    db.exec('CREATE TABLE threads(id TEXT, cwd TEXT, title TEXT, created_at_ms INTEGER, updated_at INTEGER, updated_at_ms INTEGER)');
    const id = randomUUID(), timestamp = Date.now();
    db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?)').run(id, dir, 'Compatible metadata', timestamp, 1e25, null);
    const rows = await discoverSessions('codex', { codexHome: dir });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.nativeSessionId, id);
    assert.ok(Number.isFinite(Date.parse(rows[0]!.lastActivity)));
    assert.equal(await resolveNativeSessionId(makeSession({ cwd: dir }), new Date(timestamp).toISOString(), [], { codexHome: dir }), id);
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});

test('discovery reads heterogeneous native metadata and avoids ambiguous new-session binding', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'deck-adapters-'));
  try {
    const codexHome = join(dir, 'codex'), claudeHome = join(dir, 'claude'), dshHome = join(dir, 'dsh');
    await Promise.all([mkdir(codexHome), mkdir(join(claudeHome, 'projects', 'project'), { recursive: true }), mkdir(join(dshHome, 'storages'), { recursive: true })]);
    const id = randomUUID(), second = randomUUID(), claudeId = randomUUID(), dshId = `session-${randomUUID()}`;
    const timestamp = Date.now();
    const db = new DatabaseSync(join(codexHome, 'state_5.sqlite'));
    db.exec('CREATE TABLE threads(id TEXT, cwd TEXT, title TEXT, name TEXT, created_at INTEGER, updated_at INTEGER, archived INTEGER)');
    const insert = db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?)');
    insert.run(id, dir, 'original title', 'Renamed', Math.floor(timestamp / 1000), Math.floor(timestamp / 1000), 0);
    insert.run(randomUUID(), dir, 'archived', null, 1, 1, 1);
    await writeFile(join(claudeHome, 'projects', 'project', `${claudeId}.jsonl`), [JSON.stringify({type:'user',cwd:dir,timestamp:new Date(timestamp).toISOString(),message:{content:'First request'}}), JSON.stringify({type:'custom-title',customTitle:'Custom Claude title'})].join('\n'));
    await writeFile(join(dshHome, 'storages', 'session_projcache.json'), JSON.stringify({tables:{sessions:{[dshId]:{identity:{cwd:dir,createdAt:timestamp},rows:{title:{val:'DeepSeek title'},sessionListMetadata:{val:{lastPromptAt:timestamp}}}}}}}));
    const paths = {codexHome,claudeHome,dshHome};
    const rows = await discoverSessions(undefined,paths);
    assert.equal(rows.length,3);
    assert.equal(rows.find(row=>row.backend==='codex')?.title,'Renamed');
    assert.equal(rows.find(row=>row.backend==='claude')?.title,'Custom Claude title');
    assert.equal(rows.find(row=>row.backend==='dsh')?.nativeSessionId,dshId);
    assert.ok(rows.every(row=>!('createdAt' in row) && !('message' in row)));
    assert.equal(await resolveNativeSessionId(makeSession({cwd:dir}),new Date(timestamp).toISOString(),[],paths),id);
    insert.run(second,dir,'another session',null,Math.floor(timestamp/1000),Math.floor(timestamp/1000),0);
    assert.equal(await resolveNativeSessionId(makeSession({cwd:dir}),new Date(timestamp).toISOString(),[],paths),null);
    assert.equal(await resolveNativeSessionId(makeSession({cwd:dir}),new Date(timestamp).toISOString(),[second],paths),id);
    db.close();
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('DSH native API uses precise identity and refuses fork cwd mismatch', async () => {
  const id=`session-${randomUUID()}`, child=`session-${randomUUID()}`;
  const calls: {method:string;payload:Record<string,unknown>}[]=[];
  let mismatch=false;
  const server=createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    const message=JSON.parse(body);calls.push(message);
    let value:unknown={accepted:true};
    if(message.method==='commands.execute')value={commandId:'native-command',result:{kind:'success',text:'preset auto'}};
    if(message.method==='session.create')value={sessionId:id};
    if(message.method==='session.fork')value={sessionId:child};
    if(message.method==='session.list')value={items:[{sessionId:id,cwd:'/tmp',running:true}]};
    res.setHeader('content-type','application/json');res.end(JSON.stringify({type:'server-response',rpcId:mismatch?'wrong':message.rpcId,result:{ok:true,value}}));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address && typeof address==='object');
  const bridge=new DshBridge({port:address.port,manageProcess:false});
  try {
    const session=await bridge.createSession('/tmp','Local name');
    assert.equal(session.nativeSessionId,id);assert.ok(session.nativeUrl.endsWith(id));
    assert.ok(!calls.some(call=>call.method==='session.prompt'));
    await assert.rejects(bridge.forkSession(id,'/different'),/工作目录/);
    assert.ok(!calls.some(call=>call.method==='session.fork'));
    assert.equal((await bridge.forkSession(id,'/tmp')).nativeSessionId,child);
    await bridge.setAutoMode(id);
    assert.equal(calls.at(-1)?.method,'commands.execute');
    assert.deepEqual(calls.at(-1)?.payload,{agentId:id,line:'/permission auto',submittedAttachments:[]});
    await bridge.prompt(id,'group handoff');
    assert.deepEqual(calls.at(-1)?.payload,{sessionId:id,mode:'queue',content:[{type:'text',text:'group handoff'}]});
    await bridge.stopSession(id);assert.equal(calls.at(-1)?.method,'session.cancel');
    mismatch=true;await assert.rejects(bridge.openSession(id),/请求 ID/);
  } finally {await bridge.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

for (const fragment of [false, true]) for (const prefix of ['session-', '']) test(`DSH deep link ${fragment ? 'fragment' : 'query'} supports ${prefix ? 'legacy' : 'current'} session IDs and opens only the specified contact once`, () => {
  const id=`${prefix}${randomUUID()}`;let plugin: {apply:(ctx:unknown)=>void}|undefined;
  let change=()=>{};const opened:string[]=[];const state:{byId:Record<string,unknown>}={byId:{}};
  runInNewContext(dshDeepLinkClient('test-link'),{URLSearchParams,location:{search:fragment ? '' : `?sessiondeckSession=${id}`,hash:fragment ? `#sessiondeckSession=${id}` : ''},window:{__ModuleLoader__:{load:({factory}:{factory:()=>typeof plugin})=>{plugin=factory();}}}});
  plugin!.apply({sessions:{list:{getSnapshot:()=>state,subscribe:(listener:()=>void)=>{change=listener;return()=>{};}},open:(value:string)=>opened.push(value)},effect:(effect:()=>unknown)=>effect()});
  assert.deepEqual(opened,[]);
  state.byId[id]={};change();change();assert.deepEqual(opened,[id]);
});

test('thousands of native logs return the newest 250 by modification time without blocking the event loop', { timeout: 20_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'deck-large-discovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const codexHome = join(root, 'codex'), claudeHome = join(root, 'claude');
  const count = 2100;
  const idAt = (index: number) => `${index.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
  await Promise.all([
    mkdir(join(codexHome, 'sessions', '2026', '09', '01'), { recursive: true }),
    ...Array.from({ length: 4 }, (_, index) => mkdir(join(claudeHome, 'projects', `project-${index}`), { recursive: true })),
  ]);
  const base = new Date('2026-01-01T00:00:00.000Z').valueOf();
  // The newest file is lexically first: taking the final filenames or stopping
  // after 1500 entries cannot accidentally satisfy this assertion.
  for (let batch = 0; batch < count; batch += 40) {
    await Promise.all(Array.from({ length: Math.min(40, count - batch) }, async (_, offset) => {
      const index = batch + offset, id = idAt(index), date = new Date(base + (count - index) * 1000);
      const codex = join(codexHome, 'sessions', '2026', '09', '01', `rollout-${id}.jsonl`);
      const claude = join(claudeHome, 'projects', `project-${index % 4}`, `${id}.jsonl`);
      await Promise.all([
        writeFile(codex, JSON.stringify({ type: 'session_meta', payload: { id, cwd: root, timestamp: date.toISOString() } }) + '\n'),
        writeFile(claude, JSON.stringify({ cwd: root, timestamp: date.toISOString(), customTitle: `Contact ${index}` }) + '\n'),
      ]);
      await Promise.all([utimes(codex, date, date), utimes(claude, date, date)]);
    }));
  }
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  const started = performance.now();
  let rows;
  try {
    rows = await Promise.all([
      discoverSessions('codex', { codexHome }),
      discoverSessions('claude', { claudeHome }),
      // Concurrent refreshes reuse the in-flight scan, while preserving the
      // caller's own result array and the same newest-first ordering.
      discoverSessions('claude', { claudeHome }),
    ]);
  } finally { clearInterval(timer); }
  t.diagnostic(`Scanned ${count * 2} synthetic native logs in ${Math.round(performance.now() - started)} ms; event loop advanced ${ticks} times`);
  assert.ok(ticks > 0, 'Metadata discovery monopolized the event loop');
  const expected = Array.from({ length: 250 }, (_, index) => idAt(index));
  for (const list of rows) assert.deepEqual(list.map(row => row.nativeSessionId), expected);
  assert.notEqual(rows[1], rows[2]);
});

test('Claude discovery uses bounded log edges and metadata titles, rejecting malformed paths and symlinks', async t => {
  const home = await mkdtemp(join(tmpdir(), 'deck-edge-discovery-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const project = join(home, 'projects', 'project');
  await mkdir(project, { recursive: true });
  const id = randomUUID(), unnamedId = randomUUID();
  const file = await open(join(project, `${id}.jsonl`), 'w');
  const size = 512 * 1024 * 1024;
  try {
    await file.write(JSON.stringify({ cwd: home, timestamp: new Date().toISOString() }) + '\n');
    await file.truncate(size);
    const tail = Buffer.from('\nnull\n' + JSON.stringify({ customTitle: 'Native\u001b title', message: { content: 'PRIVATE_MESSAGE_MUST_NOT_LEAVE' } }) + '\n{"partial":');
    await file.write(tail, 0, tail.length, size - tail.length);
  } finally { await file.close(); }
  await writeFile(join(project, `${unnamedId}.jsonl`), Buffer.concat([
    Buffer.from([0xff, 0xfe, 0x0a]),
    Buffer.from(JSON.stringify({ cwd: home, type: 'user', message: { content: 'PRIVATE_MESSAGE_MUST_NOT_LEAVE' } }) + '\n'),
  ]));
  await writeFile(join(project, `${randomUUID()}.jsonl`), JSON.stringify({ cwd: '/bad\u0000path', customTitle: 'Invalid path' }));
  await writeFile(join(project, `${randomUUID()}.jsonl`), JSON.stringify({ cwd: 'relative/path', customTitle: 'Relative path' }));
  await writeFile(join(project, `${randomUUID()}.jsonl`), JSON.stringify({ cwd: '/' + 'a'.repeat(5000), customTitle: 'Oversized path' }));
  await symlink(join(project, `${id}.jsonl`), join(project, `${randomUUID()}.jsonl`));
  const rows = await discoverSessions('claude', { claudeHome: home });
  assert.equal(rows.length, 2);
  assert.equal(rows.find(row => row.nativeSessionId === id)?.title, 'Native  title');
  assert.equal(rows.find(row => row.nativeSessionId === unnamedId)?.title, 'Claude Code 会话');
  assert.ok(!JSON.stringify(rows).includes('PRIVATE_MESSAGE_MUST_NOT_LEAVE'));
});

test('Codex discovery accepts current millisecond columns without legacy title or seconds fields', async t => {
  const home = await mkdtemp(join(tmpdir(), 'deck-new-schema-discovery-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const db = new DatabaseSync(join(home, 'state_99.sqlite'));
  const id = randomUUID();
  try {
    db.exec('CREATE TABLE threads (id TEXT, cwd TEXT, name TEXT, updated_at_ms INTEGER)');
    db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?)').run(id, home, 'New schema title', Date.now());
  } finally { db.close(); }
  const rows = await discoverSessions('codex', { codexHome: home });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.nativeSessionId, id);
  assert.equal(rows[0]?.title, 'New schema title');
});

test('one damaged dsh cache row cannot hide healthy metadata, and oversized caches are skipped', async t => {
  const home = await mkdtemp(join(tmpdir(), 'deck-dsh-cache-discovery-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, 'storages'));
  const path = join(home, 'storages', 'session_projcache.json'), id = `session-${randomUUID()}`;
  await writeFile(path, JSON.stringify({ tables: { sessions: {
    [`session-${randomUUID()}`]: null,
    [`session-${randomUUID()}`]: { identity: { cwd: ['invalid'] } },
    [id]: { identity: { cwd: home, createdAt: Date.now() }, rows: { title: { val: 'Healthy contact' }, sessionListMetadata: { val: null } } },
  } } }));
  assert.deepEqual((await discoverSessions('dsh', { dshHome: home })).map(row => row.nativeSessionId), [id]);
  const file = await open(path, 'w');
  try { await file.truncate(17 * 1024 * 1024); } finally { await file.close(); }
  assert.deepEqual(await discoverSessions('dsh', { dshHome: home }), []);
});

test('DSH discovery reads per-session projcache titles used by current Harness builds', async t => {
  const home = await mkdtemp(join(tmpdir(), 'deck-dsh-projcache-files-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const cwd = join(home, 'work'), id = `session-${randomUUID()}`, stale = `session-${randomUUID()}`;
  await mkdir(join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true });
  await mkdir(join(home, 'sessions', '--work--', id), { recursive: true });
  // Legacy monolithic cache is stale / wrong; the per-session file must win.
  await writeFile(join(home, 'storages', 'session_projcache.json'), JSON.stringify({ tables: { sessions: {
    [id]: { identity: { cwd, createdAt: Date.now() - 60_000 }, rows: { title: { val: '过期标题' } } },
    [stale]: { identity: { cwd, createdAt: Date.now() - 120_000 }, rows: { title: { val: '仅旧缓存' } } },
  } } }));
  await writeFile(join(home, 'storages', 'session_projcache', 'sessions', `${id}.json`), JSON.stringify({
    version: 1,
    record: {
      identity: { cwd, createdAt: Date.now() },
      rows: {
        title: { ver: 1, seq: 3, val: '定位回放工作区' },
        sessionListMetadata: { val: { lastPromptAt: Date.now() } },
      },
    },
  }));
  // Session log header has no title; without projcache files this would be the default label.
  await writeFile(join(home, 'sessions', '--work--', id, 'session.v4.jsonl'), JSON.stringify({ type: 'session', version: 4, id, createdAt: Date.now(), cwd }) + '\n');
  const rows = await discoverSessions('dsh', { dshHome: home });
  assert.equal(rows.find(row => row.nativeSessionId === id)?.title, '定位回放工作区');
  assert.equal(rows.find(row => row.nativeSessionId === stale)?.title, '仅旧缓存');
  assert.ok(!rows.some(row => row.title === 'DeepSeek Harness 会话' && row.nativeSessionId === id));
});

test('DSH accepts both id forms, launches dsh-tui in a PTY, and discovers 0.2 session logs by header', async t => {
  assert.equal(validateNativeId('dsh', `session-${randomUUID()}`).startsWith('session-'), true);
  const bare = randomUUID();
  assert.equal(validateNativeId('dsh', bare), bare);
  assert.throws(() => validateNativeId('dsh', `${bare}x`), /无效/);

  const dir = await mkdtemp(join(tmpdir(), 'deck-dsh-tui-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tui = join(dir, 'dsh-tui');
  await writeFile(tui, '#!/bin/sh\n', { mode: 0o700 });
  const previous = process.env.SESSIONDECK_DSH_TUI_BIN;
  process.env.SESSIONDECK_DSH_TUI_BIN = tui;
  t.after(() => { if (previous === undefined) delete process.env.SESSIONDECK_DSH_TUI_BIN; else process.env.SESSIONDECK_DSH_TUI_BIN = previous; });
  const base = { id: 'card', backend: 'dsh', title: 't', cwd: dir, groupId: null, parentId: null, forkPending: false } as unknown as Session;
  // A new session: the workspace is the only positional argument; no id is chosen up front.
  assert.deepEqual(await buildLaunch({ ...base, nativeSessionId: null }), { file: tui, args: [dir] });
  // Resume keeps the exact id; a pending fork resumes the parent without claiming its id.
  assert.deepEqual(await buildLaunch({ ...base, nativeSessionId: bare }), { file: tui, args: ['--resume', bare], nativeSessionId: bare });
  assert.deepEqual(await buildLaunch({ ...base, nativeSessionId: bare, forkPending: true }), { file: tui, args: ['--resume', bare] });

  // dsh 0.2 writes sessions/<slug>/<uuid>/session.v4.jsonl.zstd and no projcache.
  // The header frame is the authority for cwd and creation time; the slug is lossy.
  const home = join(dir, 'home'), cwd = join(dir, 'work-a'), other = join(dir, 'work-b');
  const log = async (id: string, at: number, where: string, version = 4) => {
    const folder = join(home, 'sessions', `--${where.replace(/\//g, '-')}--`, id);
    await mkdir(folder, { recursive: true });
    const header = JSON.stringify({ type: 'session', version, id, createdAt: at, cwd: where }) + '\n';
    const name = version === 0 ? 'session.jsonl.zstd' : `session.v${version}.jsonl.zstd`;
    await writeFile(join(folder, name), Buffer.concat([zstdCompressSync(Buffer.from(header)), zstdCompressSync(Buffer.from(JSON.stringify({ type: 'turn/start', seq: 1, time: at + 5 }) + '\n'))]));
  };
  const started = Date.now();
  const fresh = randomUUID(), legacy = `session-${randomUUID()}`, elsewhere = randomUUID();
  await log(fresh, started + 1000, cwd);
  await log(legacy, started - 600_000, cwd, 0);
  await log(elsewhere, started + 1000, other);
  const rows = await discoverSessions('dsh', { dshHome: home });
  assert.deepEqual(rows.map(r => r.nativeSessionId).sort(), [elsewhere, fresh, legacy].sort());
  assert.equal(rows.find(r => r.nativeSessionId === fresh)?.cwd, cwd);
  // The public listing strips createdAt; resolveNativeSessionId below proves it is read.
  // Identity: only the one new log in this contact's directory counts.
  assert.equal(await resolveNativeSessionId({ ...base, nativeSessionId: null, cwd }, new Date(started).toISOString(), [], { dshHome: home }), fresh);
  assert.equal(await resolveNativeSessionId({ ...base, nativeSessionId: null, cwd: other }, new Date(started).toISOString(), [elsewhere], { dshHome: home }), null);
});
