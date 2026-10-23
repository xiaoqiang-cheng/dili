import { mutationHeaders, test } from './fixtures';
import { expectUnifiedConversation } from './conversation-layout';
import { expect, type Page } from '@playwright/test';
import type { AppState, Session } from '../shared/types';
import type { CodexChatAnswer, CodexChatItem, CodexChatPatch, CodexChatSnapshot, CodexChatSubmission } from '../shared/chat';

test('Codex shows activity before the first token and follows tools, replies, approvals and completion', async ({ page }) => {
  const app = await fixture(page); await app.open();
  const activity = page.getByRole('status', { name: '会话响应状态' });
  const input = page.getByLabel('给 Codex 发送消息');
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/sessions/${app.contact.id}/chat/messages`, async route => {
    await wait;
    await route.fulfill({ json: { requestId: route.request().postDataJSON().requestId, status: 'accepted', turnId: 'slow-turn' } });
  });
  await input.fill('先思考，再回答'); await input.press('Enter');
  await expect(activity).toHaveText('正在发送…'); release();
  await expect(input).toHaveValue(''); await expect(activity).toContainText('正在等待后端响应');
  await app.patch({ activeTurnId: 'slow-turn', items: [{ id: 'slow-user', turnId: 'slow-turn', type: 'user', text: '先思考，再回答', status: 'completed' }] });
  await expect(activity).toHaveText('正在思考…');
  await page.screenshot({ path: 'artifacts/codex-chat-thinking.png' });
  await app.patch({ items: [...app.current.snapshot.items, { id: 'tool', turnId: 'slow-turn', type: 'command', text: 'pwd', status: 'inProgress' }] });
  await expect(activity).toHaveText('正在处理任务…');
  await app.patch({ items: [...app.current.snapshot.items, { id: 'reply', turnId: 'slow-turn', type: 'assistant', text: '正在回答', status: 'inProgress' }] });
  await expect(activity).toHaveText('正在回复…');
  await app.patch({ requests: [{ id: 'approval', kind: 'approval', title: '确认操作' }] });
  await expect(activity).toHaveCount(0);
  await app.patch({ requests: [], activeTurnId: null, items: app.current.snapshot.items.map(item => ({ ...item, status: 'completed' })) });
  await expect(activity).toHaveCount(0);
  await page.screenshot({ path: 'artifacts/chat-activity-completed.png' });
});
test('Codex chat shares message presentation and a single title row with the other platforms', async ({ page }) => {
  const app = await fixture(page); await app.open();
  await app.patch({ items: [{ id: 'layout-user', type: 'user', status: 'completed', text: '检查布局' }, { id: 'layout-assistant', type: 'assistant', status: 'completed', text: '## 检查结果\n\n排版一致。' }] });
  await expectUnifiedConversation(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '会话工具', exact: true }).click();
  await expect(page.getByRole('button', { name: '刷新对话', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '会话工具', exact: true })).toBeFocused();
  await expect(page.locator('.session-drawer')).toBeVisible();
  await page.screenshot({ path: 'artifacts/unified-codex-mobile.png' });
});

test('active Codex turns accept supplemental input and approval still blocks sending', async ({ page }) => {
  const app = await fixture(page); await app.open();
  const input = page.getByLabel('给 Codex 发送消息');
  await input.fill('initial task'); await input.press('Enter');
  await expect(input).toHaveValue(''); await input.fill('supplement current task');
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled(); await input.press('Enter');
  await expect.poll(() => app.requests.filter(item => item.path === 'messages').length).toBe(2);
  expect(app.requests.filter(item => item.path === 'messages').at(-1)?.body).toMatchObject({ text: 'supplement current task', expectedTurnId: 'turn-1' });
  expect(app.requests.filter(item => item.path === 'messages').every(item => !('model' in item.body))).toBe(true);
  expect(app.requests.filter(item => item.path === 'start')).toHaveLength(1);
  expect(app.requests.filter(item => item.path === 'interrupt')).toHaveLength(0);
  await expect(page.getByLabel('当前会话模型')).toHaveCount(0);
  await app.patch({ requests: [{ id: 'pending', kind: 'approval', title: '审批', options: [{ id: 'deny', label: '拒绝' }] }] });
  await input.fill('approval must stay explicit');
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
});

test('Codex queued messages can be edited, canceled and restored, and release once per completed turn', async ({page})=>{
  const app=await fixture(page); await app.open();
  const input=page.getByLabel('给 Codex 发送消息'),queue=page.getByRole('region',{name:'待发送消息'});
  await input.fill('initial');await input.press('Enter');await expect(input).toHaveValue('');
  await input.fill('queue one');await page.getByRole('button',{name:'加入队列',exact:true}).click();
  await expect(queue).toContainText('queue one');await expect(input).toHaveValue('');
  expect(app.requests.filter(item=>item.path==='messages')).toHaveLength(1);
  await queue.getByRole('button',{name:'编辑',exact:true}).click();await expect(input).toHaveValue('queue one');
  await input.fill('edited one');await page.getByRole('button',{name:'加入队列',exact:true}).click();
  await input.fill('queue two');await page.getByRole('button',{name:'加入队列',exact:true}).click();
  await input.fill('cancel me');await page.getByRole('button',{name:'加入队列',exact:true}).click();
  await queue.getByRole('button',{name:'取消排队：cancel me',exact:true}).click();
  await page.reload();await expect(queue).toContainText('edited one');await expect(queue).toContainText('queue two');
  await input.fill('a newer draft');
  await app.patch({activeTurnId:null});
  await expect.poll(()=>app.requests.filter(item=>item.path==='messages').length).toBe(2);
  await expect(queue).not.toContainText('edited one');await expect(queue).toContainText('queue two');
  await expect(input).toHaveValue('a newer draft');
  expect(app.requests.filter(item=>item.path==='messages').at(-1)?.body).toMatchObject({text:'edited one'});
  expect(app.requests.filter(item=>item.path==='messages').at(-1)?.body).not.toHaveProperty('expectedTurnId');
  await page.screenshot({path:'artifacts/codex-message-queue.png'});
  await app.patch({activeTurnId:null});await expect(queue).toHaveCount(0);
  expect(app.requests.filter(item=>item.path==='messages')).toHaveLength(3);
  expect(app.requests.filter(item=>item.path==='interrupt')).toHaveLength(0);
});

test('stopping a Codex turn pauses queued work until explicitly sent',async({page})=>{
  const app=await fixture(page);await app.open();
  const input=page.getByLabel('给 Codex 发送消息'),queue=page.getByRole('region',{name:'待发送消息'});
  await input.fill('initial');await input.press('Enter');await expect(input).toHaveValue('');
  await input.fill('wait for my review');await page.getByRole('button',{name:'加入队列',exact:true}).click();
  await page.getByRole('button',{name:'停止生成',exact:true}).click();
  await expect(queue).toContainText('已暂停');
  await expect.poll(()=>app.requests.filter(item=>item.path==='interrupt').length).toBe(1);
  await app.patch({activeTurnId:null});
  await page.reload();await expect(queue).toContainText('已暂停');
  expect(app.requests.filter(item=>item.path==='messages')).toHaveLength(1);
  await queue.getByRole('button',{name:'立即发送',exact:true}).click();
  await expect(queue).toHaveCount(0);
  expect(app.requests.filter(item=>item.path==='messages')).toHaveLength(2);
});

test('Codex queued work pauses across a native identity change and never auto retries rejection',async({page})=>{
  const app=await fixture(page);await app.open();
  const input=page.getByLabel('给 Codex 发送消息'),queue=page.getByRole('region',{name:'待发送消息'});
  await input.fill('initial');await input.press('Enter');await expect(input).toHaveValue('');
  await input.fill('bound queued task');await page.getByRole('button',{name:'加入队列',exact:true}).click();
  await app.patch({activeTurnId:null,instanceId:'replacement'});
  await expect(queue).toContainText('已暂停');expect(app.requests.filter(item=>item.path==='messages')).toHaveLength(1);
  await app.patch({activeTurnId:'replacement-turn'});await app.patch({activeTurnId:null});
  expect(app.requests.filter(item=>item.path==='messages')).toHaveLength(1);
  await queue.getByRole('button',{name:'编辑',exact:true}).click();
  await app.patch({activeTurnId:'replacement-turn'});
  await page.getByRole('button',{name:'加入队列',exact:true}).click();
  await page.route(`**/api/sessions/${app.contact.id}/chat/messages`,route=>route.fulfill({status:409,json:{error:'本轮已结束'}}));
  await queue.getByRole('button',{name:'立即发送',exact:true}).click();await expect(queue).toContainText('已暂停');
  await expect(input).toHaveValue('');await expect(page.locator('.codex-pending')).toHaveCount(0);
});

test('composer resizes both axes and fullscreen preserves the draft and connection', async ({ page }) => {
  const app = await fixture(page); await app.open();
  const input = page.getByLabel('给 Codex 发送消息'); await input.fill('resize keeps this draft');
  const connections = () => page.evaluate(() => (window as unknown as { codexSources: Source[] }).codexSources.filter(source => !source.closed).length);
  const before = await connections();
  const height = page.getByRole('separator', { name: '调整输入区高度', exact: true });
  const initial = Number(await height.getAttribute('aria-valuenow'));
  const box = (await height.boundingBox())!; await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down(); await page.mouse.move(box.x + box.width / 2, box.y - 50, { steps: 6 }); await page.mouse.up();
  expect(Number(await height.getAttribute('aria-valuenow'))).toBeGreaterThan(initial + 40);
  const width = page.getByRole('separator', { name: '调整输入区右侧宽度', exact: true });
  const previousWidth = Number(await width.getAttribute('aria-valuenow')); await width.focus(); await width.press('ArrowLeft');
  expect(Number(await width.getAttribute('aria-valuenow'))).toBe(previousWidth - 24);
  const adjustedHeight = await height.getAttribute('aria-valuenow');
  await page.getByRole('button', { name: '全屏会话', exact: true }).click();
  const drawer = page.locator('.session-drawer'); await expect(drawer).toHaveClass(/session-fullscreen/);
  expect((await drawer.boundingBox())!.width).toBe(1440);
  await expect(input).toHaveValue('resize keeps this draft'); expect(await connections()).toBe(before);
  await page.getByRole('button', { name: '对话目录', exact: true }).click();
  await page.keyboard.press('Escape'); await expect(drawer).toHaveClass(/session-fullscreen/);
  await input.focus(); await input.press('Escape'); await expect(drawer).not.toHaveClass(/session-fullscreen/);
  await expect(input).toHaveValue('resize keeps this draft');
  await input.press('Control+Shift+Enter'); await expect(drawer).toHaveClass(/session-fullscreen/);
  await input.press('Control+Shift+Enter'); await expect(drawer).not.toHaveClass(/session-fullscreen/);
  expect(app.requests).toEqual([]);
  await page.reload(); await expect(input).toHaveValue('resize keeps this draft');
  await expect(height).toHaveAttribute('aria-valuenow', adjustedHeight!);
  await page.screenshot({ path: 'artifacts/resizable-graphical-composer.png', animations: 'disabled' });
  await page.evaluate(() => { localStorage.setItem('dili.interface-zoom', '200'); });
  await page.reload(); await expect(input).toHaveValue('resize keeps this draft');
  const zoomedHeight = Number(await height.getAttribute('aria-valuenow'));
  const zoomedBox = (await height.boundingBox())!; await page.mouse.move(zoomedBox.x + zoomedBox.width / 2, zoomedBox.y + 3);
  await page.mouse.down(); await page.mouse.move(zoomedBox.x + zoomedBox.width / 2, zoomedBox.y + 43, { steps: 5 }); await page.mouse.up();
  expect(Number(await height.getAttribute('aria-valuenow'))).toBe(zoomedHeight - 20);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(input).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: '全屏会话', exact: true }).click();
  await expect(page.getByRole('button', { name: '退出会话全屏', exact: true })).toBeVisible();
  const narrowHeader = (await page.locator('.drawer-header').boundingBox())!;
  expect((await page.locator('.drawer-title h2').boundingBox())!.width).toBeGreaterThan(24);
  for (const label of ['对话目录', '会话工具', '退出会话全屏', '关闭会话']) {
    const bounds = (await page.getByRole('button', { name: label, exact: true }).boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(narrowHeader.x);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(narrowHeader.x + narrowHeader.width);
  }
  await page.screenshot({ path: 'artifacts/graphical-mobile-zoom.png', animations: 'disabled' });
});

type Source = EventTarget & { url: string; closed: boolean };
async function emit(page: Page, url: string, type: string, data?: unknown) {
  await page.evaluate(({ url, type, data }) => {
    const sources = (window as unknown as { codexSources: Source[] }).codexSources;
    for (const source of sources.filter(source => source.url === url && !source.closed)) source.dispatchEvent(data === undefined ? new Event(type) : new MessageEvent(type, { data: JSON.stringify(data) }));
  }, { url, type, data });
}

async function fixture(page: Page, agent: 'codex' | 'claude' = 'codex') {
  const name = agent === 'claude' ? 'Claude' : 'Codex';
  const seed = await (await page.request.get('/api/state')).json() as AppState;
  expect(seed.demo).toBe(true);
  const headers = await mutationHeaders(page.request);
  const created = await page.request.post('/api/sessions', { data: { backend: agent, title: name + ' 图形界面回归', cwd: seed.defaultCwd }, headers });
  expect(created.ok()).toBe(true);
  const contact = await created.json() as Session;
  const state: AppState = { ...seed, demo: false, sessions: [contact], groups: [], activities: [], revision: (seed.revision ?? 0) + 20,
    backends: seed.backends.map(backend => backend.id === agent ? { ...backend, installed: true, capabilities: { ...backend.capabilities, nativeControl: true, graphicalChat: true } } : backend) };
  const current: { snapshot: CodexChatSnapshot } = { snapshot: { instanceId: 'chat-test-instance', nativeSessionId: null, revision: 1, connected: false, activeTurnId: null, items: [], requests: [], truncated: false } };
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  const submissions = new Map<string, CodexChatSubmission>();
  let reads = 0;
  await page.addInitScript(() => {
    const target = window as unknown as { codexSources: Source[] };
    target.codexSources = [];
    class FakeSource extends EventTarget {
      url: string;
      closed = false;
      onopen: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      constructor(url: string | URL) {
        super(); this.url = String(url); target.codexSources.push(this);
        this.addEventListener('open', event => this.onopen?.(event));
        this.addEventListener('error', event => this.onerror?.(event));
        queueMicrotask(() => this.dispatchEvent(new Event('open')));
      }
      close() { this.closed = true; }
    }
    Object.defineProperty(window, 'EventSource', { configurable: true, value: FakeSource });
  });
  await page.route('**/api/state', route => route.fulfill({ json: state }));
  await page.route(`**/api/sessions/${contact.id}/chat`, route => { reads++; return route.fulfill({ json: current.snapshot }); });
  await page.route(`**/api/sessions/${contact.id}/start`, async route => {
    requests.push({ path: 'start', body: route.request().postDataJSON() });
    Object.assign(contact, { running: true, nativeSessionId: 'exact-native-thread', interactionMode: 'chat', executionTransport: 'structured' });
    current.snapshot = { ...current.snapshot, connected: true, nativeSessionId: contact.nativeSessionId, revision: current.snapshot.revision + 1 };
    state.revision = (state.revision ?? 0) + 1;
    await emit(page, '/api/events', 'state', state);
    await emit(page, `/api/sessions/${contact.id}/chat/events`, 'state', current.snapshot);
    await route.fulfill({ json: contact });
  });
  await page.route(`**/api/sessions/${contact.id}/chat/messages`, async route => {
    const body = route.request().postDataJSON() as { text: string; requestId: string };
    requests.push({ path: 'messages', body });
    const accepted: CodexChatSubmission = { requestId: body.requestId, status: 'accepted', turnId: 'turn-1' };
    submissions.set(body.requestId, accepted);
    current.snapshot = { ...current.snapshot, revision: current.snapshot.revision + 1, activeTurnId: 'turn-1', items: [
      ...current.snapshot.items, { id: 'user-1', turnId: 'turn-1', type: 'user', text: body.text, status: 'completed' },
      { id: 'answer-1', turnId: 'turn-1', type: 'assistant', text: '正在检查', status: 'inProgress' },
    ] };
    await route.fulfill({ json: accepted });
    await emit(page, `/api/sessions/${contact.id}/chat/events`, 'state', current.snapshot);
  });
  await page.route(`**/api/sessions/${contact.id}/chat/submissions/*`, route => {
    const id = route.request().url().split('/').at(-1)!;
    return route.fulfill(submissions.has(id) ? { json: submissions.get(id) } : { status: 404, json: { error: '本次发送记录不存在' } });
  });
  await page.route(`**/api/sessions/${contact.id}/chat/requests/*`, async route => {
    requests.push({ path: 'answer', body: route.request().postDataJSON() as CodexChatAnswer & Record<string, unknown> });
    current.snapshot = { ...current.snapshot, revision: current.snapshot.revision + 1, requests: [] };
    await route.fulfill({ json: { ok: true } });
    await emit(page, `/api/sessions/${contact.id}/chat/events`, 'state', current.snapshot);
  });
  await page.route(`**/api/sessions/${contact.id}/chat/interrupt`, async route => {
    requests.push({ path: 'interrupt', body: route.request().postDataJSON() });
    current.snapshot = { ...current.snapshot, revision: current.snapshot.revision + 1, activeTurnId: null, requests: [], items: current.snapshot.items.map(item => ({ ...item, status: 'completed' })) };
    await route.fulfill({ json: { ok: true } });
    await emit(page, `/api/sessions/${contact.id}/chat/events`, 'state', current.snapshot);
  });
  return {
    contact, state, current, requests, submissions, reads: () => reads,
    open: async () => { await page.goto(`/#/contacts?session=${contact.id}`); await expect(page.getByRole('region', { name: name + ' 图形会话' })).toBeVisible(); await expect(page.getByLabel('给 ' + name + ' 发送消息')).toBeVisible(); },
    patch: async (values: Partial<CodexChatSnapshot>) => {
      const previous = current.snapshot;
      current.snapshot = { ...previous, ...values, revision: previous.revision + 1 };
      const patch: CodexChatPatch = { ...current.snapshot, baseRevision: previous.revision, items: values.items ?? [], order: current.snapshot.items.map(item => item.id) };
      await emit(page, `/api/sessions/${contact.id}/chat/events`, 'patch', patch);
    },
  };
}

test('history notices float without taking reading space, deduplicate and stay dismissed after refresh or reopening', async ({ page }) => {
  const app = await fixture(page);
  const notice = '部分原生历史未加载；完整记录可在原生终端查看。';
  app.current.snapshot = { ...app.current.snapshot, nativeSessionId: 'notice-thread', notice, items: outlineHistory(), historyCursor: 'older-notices', truncated: true };
  await app.open();
  const toast = page.locator('.conversation-notice-toast');
  await expect(toast).toHaveCount(1);
  await expect(toast).toContainText(notice);
  await expect(page.locator('.codex-chat-notice')).toHaveCount(0);
  const scroller = page.getByLabel('Codex 消息记录', { exact: true });
  await scroller.evaluate(element => { element.scrollTop = 200; element.dispatchEvent(new Event('scroll', { bubbles: true })); });
  const before = await scroller.evaluate(element => ({ top: element.scrollTop, height: element.clientHeight }));
  await page.getByRole('button', { name: '关闭此提示', exact: true }).click();
  await expect(toast).toHaveCount(0);
  expect(await scroller.evaluate(element => ({ top: element.scrollTop, height: element.clientHeight }))).toEqual(before);
  await app.patch({ notice });
  const reads = app.reads();
  await page.getByRole('button', { name: '刷新对话', exact: true }).click();
  await expect.poll(() => app.reads()).toBeGreaterThan(reads);
  await expect(toast).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel('给 Codex 发送消息')).toBeVisible();
  await expect(toast).toHaveCount(0);
  // A different native conversation has an independent dismissal scope.
  await app.patch({ nativeSessionId: 'another-notice-thread', notice });
  await expect(toast).toHaveCount(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: '关闭此提示', exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/history-notice-mobile.png', animations: 'disabled' });
});

test('informational notices expire, pause for pointer or keyboard reading, and do not restart on live patches', async ({ page }) => {
  const app = await fixture(page);
  app.current.snapshot = { ...app.current.snapshot, nativeSessionId: 'timed-notices', truncated: true, historyCursor: 'older-notices' };
  await app.open();
  await page.clock.install();
  const toast = page.locator('.conversation-notice-toast');
  await expect(toast).toContainText('先展示最近的消息');
  await toast.hover();
  await page.clock.runFor(6500);
  await expect(toast).toBeVisible();
  await page.getByRole('button', { name: '关闭此提示', exact: true }).focus();
  await page.mouse.move(0, 0);
  await page.clock.runFor(6500);
  await expect(toast).toBeVisible();
  await page.getByLabel('给 Codex 发送消息').focus();
  await page.clock.runFor(3500);
  await app.patch({ revision: app.current.snapshot.revision + 1 });
  await page.clock.runFor(3000);
  await expect(toast).toHaveCount(0);
  await app.patch({ truncated: true });
  await expect(toast).toHaveCount(0);
  await app.patch({ notice: '新的独立提示' });
  await expect(toast).toContainText('新的独立提示');
});

for (const agent of ['codex', 'claude'] as const) {
  const name = agent === 'claude' ? 'Claude' : 'Codex';
  test(`${name} GUI sends to the native session, streams safe Markdown and handles tools, approval, questions and interruption`, async ({ page }) => {
  const app = await fixture(page, agent);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await app.open();
  await expect(page.getByText('在这里继续你的工作', { exact: true })).toBeVisible();
  expect(app.requests).toEqual([]);
  const input = page.getByLabel('给 ' + name + ' 发送消息');
  await input.fill('检查登录流程，并解释修改。');
  await input.press('Enter');
  await expect(page.locator('.codex-user')).toContainText('检查登录流程，并解释修改。');
  await expect(input).toHaveValue('');
  expect(app.requests.filter(item => item.path === 'start')).toEqual([{ path: 'start', body: { mode: 'chat' } }]);
  expect(app.requests.filter(item => item.path === 'messages')).toHaveLength(1);
  const markdown = '# 修复方案\n\n**已确认**登录入口。\n\n- [x] 检查焦点\n- [ ] 添加测试\n\n| 项目 | 状态 |\n| --- | --- |\n| 键盘 | 正常 |\n\n```js\nconst safe = true;\n```\n\n[官方文档](https://developers.openai.com/codex/) [危险链接](javascript:alert(1))\n\n<img src="https://invalid.example/tracker" onerror="alert(1)">';
  await app.patch({ items: [app.current.snapshot.items[0], { id: 'answer-1', turnId: 'turn-1', type: 'assistant', text: markdown, status: 'inProgress' }, { id: 'command-1', type: 'command', title: '检查 git diff', text: 'git diff --stat', output: '2 files changed', status: 'completed' }], requests: [{ id: 'approval-1', kind: 'approval', title: '允许修改登录组件？', details: 'src/login.tsx', options: [{ id: 'opaque-allow', label: '允许这次操作' }, { id: 'opaque-deny', label: '拒绝' }] }] });
  await page.locator('.codex-chat-scroll').evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')); });
  await expect(page.getByRole('alert')).toContainText('允许修改登录组件？');
  await page.getByRole('button', { name: '定位到请求' }).click();
  await expect(page.locator('.codex-request')).toBeInViewport();
  await expect(page.locator('.codex-chat-toolbar')).toContainText('需要你回复');
  await expect(page.locator('.codex-request pre')).toHaveText('src/login.tsx');
  await expect(page.getByRole('heading', { name: '修复方案', exact: true })).toBeVisible();
  await expect(page.locator('.codex-assistant table')).toBeVisible();
  await expect(page.locator('.codex-assistant .hljs-keyword').first()).toHaveText('const');
  await expect(page.locator('.codex-assistant img')).toHaveCount(0);
  await expect(page.getByRole('link', { name: '危险链接' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: '官方文档' })).toHaveAttribute('rel', 'noreferrer noopener');
  await page.locator('.codex-tool summary').click();
  await expect(page.locator('.codex-tool-output')).toHaveText('2 files changed');
  await page.getByRole('button', { name: '允许这次操作', exact: true }).click();
  await expect.poll(() => app.requests.filter(item => item.path === 'answer').map(item => item.body)).toEqual([{ decision: 'opaque-allow' }]);
  await app.patch({ requests: [{ id: 'question-1', kind: 'question', title: '选择验证方式', questions: [{ id: 'scope', header: '验证范围', question: '先检查哪一部分？', options: [{ label: '键盘操作', description: '优先覆盖可访问性' }, { label: '页面布局', description: '检查移动设备' }] }] }] });
  await page.getByRole('radio', { name: /键盘操作/ }).check();
  await page.getByRole('button', { name: '提交回答', exact: true }).click();
  await expect.poll(() => app.requests.filter(item => item.path === 'answer').at(-1)?.body).toEqual({ answers: { scope: ['键盘操作'] } });
  await page.getByRole('button', { name: '停止生成', exact: true }).click();
  await expect(page.getByRole('button', { name: /^(?:停止生成|正在停止…)$/ })).toHaveCount(0);
  expect(app.requests.filter(item => item.path === 'interrupt')).toHaveLength(1);
  expect(app.contact.running).toBe(true);
  await page.screenshot({ path: 'artifacts/' + agent + '-graphical-chat.png', animations: 'disabled' });
  expect(errors).toEqual([]);
});
}

test('uncertain submissions survive reload, keep edited drafts and are checked without another send', async ({ page }) => {
  const app = await fixture(page);
  let submitted = '';
  await page.route(`**/api/sessions/${app.contact.id}/chat/messages`, async route => {
    const body = route.request().postDataJSON() as { text: string; requestId: string };
    app.requests.push({ path: 'messages', body }); submitted = body.requestId;
    await route.abort('connectionreset');
  });
  await app.open();
  await page.getByLabel('给 Codex 发送消息').fill('这条消息只提交一次');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('发送结果待确认', { exact: true })).toBeVisible();
  expect(submitted).toMatch(/^[a-f0-9-]{36}$/);
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
  await page.getByLabel('给 Codex 发送消息').fill('保留正在编辑的下一条草稿');
  await page.reload();
  await expect(page.getByLabel('给 Codex 发送消息')).toHaveValue('保留正在编辑的下一条草稿');
  await expect(page.getByText('发送结果待确认', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '查询发送结果', exact: true }).click();
  await expect(page.locator('.codex-pending')).toContainText('服务可能已重启');
  await expect(page.getByRole('button', { name: '已核对未发送，恢复草稿', exact: true })).toBeVisible();
  app.submissions.set(submitted, { requestId: submitted, status: 'accepted', turnId: 'native-existing-turn' });
  await page.getByRole('button', { name: '查询发送结果', exact: true }).click();
  await expect(page.getByText('发送结果待确认', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('给 Codex 发送消息')).toHaveValue('保留正在编辑的下一条草稿');
  expect(app.requests.filter(item => item.path === 'messages')).toHaveLength(1);
  expect(app.requests.filter(item => item.path === 'start')).toHaveLength(1);
});

test('Codex drafts keep IME Enter and newlines, while disconnects disable sending', async ({ page }) => {
  const app = await fixture(page);
  await app.open();
  const input = page.getByLabel('给 Codex 发送消息');
  await input.fill('中文输入候选');
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, keyCode: 229 });
  expect(app.requests).toEqual([]);
  await input.press('End'); await input.press('Shift+Enter'); await input.pressSequentially('second line');
  await expect(input).toHaveValue('中文输入候选\nsecond line');
  await page.getByRole('button', { name: '关闭会话', exact: true }).click();
  await page.getByRole('button', { name: `进入 ${app.contact.title} 的会话`, exact: true }).click();
  await expect(input).toHaveValue('中文输入候选\nsecond line');
  await emit(page, `/api/sessions/${app.contact.id}/chat/events`, 'error');
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
  await expect(page.locator('.codex-chat-banner')).toContainText('草稿已保留');
  // Re-entering from the card starts the stopped contact; no draft is sent.
  expect(app.requests).toEqual([{ path: 'start', body: { mode: 'chat' } }]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(input).toBeVisible();
  await page.screenshot({ path: 'artifacts/codex-graphical-mobile.png', animations: 'disabled' });
});

test('Codex patch gaps reload history and server replacement may reset revisions without losing reading position', async ({ page }) => {
  const app = await fixture(page);
  app.current.snapshot = { ...app.current.snapshot, revision: 100, items: Array.from({ length: 45 }, (_, index) => ({ id: `message-${index}`, type: 'assistant' as const, text: `第 ${index} 条消息\n\n保留旧对话的阅读位置。\n\n第三段说明。`, status: 'completed' as const })) };
  await app.open();
  await expect(page.locator('.codex-message')).toHaveCount(45);
  const scroller = page.getByLabel('Codex 消息记录', { exact: true });
  await scroller.evaluate(element => { element.scrollTop = 240; element.dispatchEvent(new Event('scroll', { bubbles: true })); });
  await expect(page.getByRole('button', { name: '回到最新消息', exact: true })).toBeVisible();
  const before = await scroller.evaluate(element => element.scrollTop);
  await app.patch({ items: [...app.current.snapshot.items, { id: 'message-new', type: 'assistant', text: '新的回复不会打断阅读。', status: 'completed' }] });
  await expect(page.locator('.codex-message')).toHaveCount(46);
  expect(Math.abs(await scroller.evaluate(element => element.scrollTop) - before)).toBeLessThan(2);
  const reads = app.reads();
  app.current.snapshot = { ...app.current.snapshot, revision: 105, notice: '已补齐遗漏的事件' };
  await emit(page, `/api/sessions/${app.contact.id}/chat/events`, 'patch', { ...app.current.snapshot, baseRevision: 104, items: [], order: app.current.snapshot.items.map(item => item.id) });
  await expect.poll(() => app.reads()).toBeGreaterThan(reads);
  await expect(page.locator('.conversation-notice-toast')).toContainText('已补齐遗漏的事件');
  app.current.snapshot = { ...app.current.snapshot, instanceId: 'replacement-server', revision: 1, notice: '服务重启后的精确会话', items: [{ id: 'restored', type: 'assistant', text: '已恢复正确的原生历史', status: 'completed' }] };
  await emit(page, `/api/sessions/${app.contact.id}/chat/events`, 'state', app.current.snapshot);
  await expect(page.locator('.codex-assistant')).toContainText('已恢复正确的原生历史');
  await expect(page.locator('.codex-message')).toHaveCount(1);
  expect(app.requests).toEqual([]);
});

test('LAN browsers without randomUUID can send, and explicit native rejections preserve editable drafts', async ({ page }) => {
  const app = await fixture(page);
  await page.addInitScript(() => Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined }));
  const ids: string[] = [];
  await page.route(`**/api/sessions/${app.contact.id}/chat/messages`, async route => {
    const body = route.request().postDataJSON() as { text: string; requestId: string };
    ids.push(body.requestId);
    await route.fulfill(ids.length === 1 ? { status: 409, json: { error: '请先处理当前原生审批', code: 'CHAT_REJECTED' } } : { json: { requestId: body.requestId, status: 'accepted', turnId: 'accepted-after-correction' } });
  });
  await app.open();
  await page.getByLabel('给 Codex 发送消息').fill('保留被拒绝的任务草稿');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.codex-chat-error')).toContainText('请先处理当前原生审批');
  await expect(page.getByLabel('给 Codex 发送消息')).toHaveValue('保留被拒绝的任务草稿');
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled();
  await expect(page.getByText('发送结果待确认', { exact: true })).toHaveCount(0);
  await page.getByLabel('给 Codex 发送消息').fill('修改后由用户重新提交');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByLabel('给 Codex 发送消息')).toHaveValue('');
  expect(ids).toHaveLength(2);
  for (const id of ids) expect(id).toMatch(/^[a-f0-9]{32}$/);
  expect(ids[0]).not.toBe(ids[1]);
});

test('a late accepted response after reopening clears only its submitted draft snapshot', async ({ page }) => {
  const app = await fixture(page);
  let release!: () => void;
  let submitted = false;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/sessions/${app.contact.id}/chat/messages`, async route => {
    const body = route.request().postDataJSON() as { text: string; requestId: string };
    submitted = true; app.requests.push({ path: 'messages', body });
    await pending;
    await route.fulfill({ json: { requestId: body.requestId, status: 'accepted', turnId: 'late-accepted' } });
  });
  await app.open();
  await page.getByLabel('给 Codex 发送消息').fill('已经提交的原始任务');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(() => submitted).toBe(true);
  await page.getByRole('button', { name: '关闭会话', exact: true }).click();
  await page.getByRole('button', { name: `进入 ${app.contact.title} 的会话`, exact: true }).click();
  await expect(page.getByText('发送结果待确认', { exact: true })).toBeVisible();
  await page.getByLabel('给 Codex 发送消息').fill('重新打开后写下的新草稿');
  release();
  await expect(page.getByText('发送结果待确认', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('给 Codex 发送消息')).toHaveValue('重新打开后写下的新草稿');
  await page.reload();
  await expect(page.getByLabel('给 Codex 发送消息')).toHaveValue('重新打开后写下的新草稿');
  expect(app.requests.filter(item => item.path === 'messages')).toHaveLength(1);
});

test('sending from an existing terminal session selects native chat delivery without starting on view', async ({ page }) => {
  const app = await fixture(page);
  Object.assign(app.contact, { running: true, nativeSessionId: 'exact-native-thread', interactionMode: 'terminal' });
  app.current.snapshot = { ...app.current.snapshot, nativeSessionId: app.contact.nativeSessionId, connected: true };
  await app.open();
  expect(app.requests).toEqual([]);
  await page.getByLabel('给 Codex 发送消息').fill('在这个已有的原生会话中继续');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.codex-user')).toContainText('在这个已有的原生会话中继续');
  expect(app.requests.map(item => item.path)).toEqual(['start', 'messages']);
  expect(app.requests[0].body).toEqual({ mode: 'chat' });
  expect(app.contact.nativeSessionId).toBe('exact-native-thread');
  expect(app.contact.interactionMode).toBe('chat');
});

function outlineHistory(): CodexChatItem[] {
  return Array.from({ length: 24 }, (_, index): CodexChatItem[] => [
    { id: `input-${index}`, turnId: `turn-${index}`, type: 'user', text: index === 4 || index === 8 ? '配置发布\n\n增加按钮样式' : `需求 ${index + 1}：检查当前工作进展`, status: 'completed' },
    { id: `reply-${index}`, turnId: `turn-${index}`, type: 'assistant', text: `## 第 ${index + 1} 次回复\n\n检查工作目录与界面。\n\n保留历史阅读位置，新的回复不会打断查看。`, status: 'completed' },
  ]).flat();
}

test('Codex input outline filters only user messages, locates duplicate prompts by ID and preserves reading during live updates', async ({ page }) => {
  const app = await fixture(page);
  app.current.snapshot = { ...app.current.snapshot, items: outlineHistory(), truncated: true };
  await app.open();
  const toggle = page.getByRole('button', { name: '对话目录', exact: true });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  const directory = page.getByRole('complementary', { name: '对话目录', exact: true });
  const entries = directory.getByRole('navigation', { name: '用户输入目录' }).getByRole('button');
  await expect(entries).toHaveCount(24);
  await expect(directory).toContainText('仅列出当前已加载的输入');
  const input = page.getByRole('searchbox', { name: '筛选用户输入' });
  await expect(input).toBeFocused();
  await input.fill('配置发布 增加按钮');
  await expect(entries).toHaveCount(2);
  await expect(directory).toContainText('2 / 24 条输入');
  await entries.nth(1).click();
  const target = page.locator('[data-chat-item="input-8"]');
  await expect(target).toBeFocused();
  await expect(target).toHaveClass(/codex-message-highlighted/);
  await expect(entries.nth(1)).toHaveAttribute('aria-current', 'location');
  const scroller = page.getByLabel('Codex 消息记录', { exact: true });
  await expect.poll(() => target.evaluate(element => element.getBoundingClientRect().top - element.closest('.codex-chat-scroll')!.getBoundingClientRect().top)).toBeCloseTo(12, 0);
  const before = await scroller.evaluate(element => element.scrollTop);
  await app.patch({ items: [...app.current.snapshot.items,
    { id: 'input-live', type: 'user', text: '新需求：配置发布 增加按钮', status: 'completed' },
    { id: 'reply-live', type: 'assistant', text: '新的回复正在追加。', status: 'inProgress' },
  ] });
  await expect(entries).toHaveCount(3);
  expect(Math.abs(await scroller.evaluate(element => element.scrollTop) - before)).toBeLessThan(2);
  await input.fill('不存在的需求');
  await expect(entries).toHaveCount(0);
  await expect(directory.getByRole('status')).toHaveText('没有匹配的输入');
  await input.fill('');
  await expect(entries).toHaveCount(25);
  await page.screenshot({ path: 'artifacts/codex-input-outline-desktop.png', animations: 'disabled' });
  await page.getByRole('button', { name: '关闭对话目录' }).click();
  await expect(toggle).toBeFocused();
  await expect(directory).toHaveCount(0);
  await page.getByRole('button', { name: '回到最新消息', exact: true }).click();
  await expect.poll(() => scroller.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(2);
  expect(app.requests).toEqual([]);
});

test('Codex input outline uses a native drawer on mobile, keeps Escape local and closes after locating a message', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const app = await fixture(page);
  app.current.snapshot = { ...app.current.snapshot, items: outlineHistory() };
  await app.open();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const toggle = page.getByRole('button', { name: '对话目录', exact: true });
  await toggle.click();
  const drawer = page.getByRole('dialog', { name: '对话目录', exact: true });
  await expect(drawer).toBeVisible();
  const search = drawer.getByRole('searchbox', { name: '筛选用户输入' });
  await expect(search).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await expect(toggle).toBeFocused();
  await expect(page.getByRole('region', { name: 'Codex 图形会话' })).toBeVisible();
  await toggle.click();
  // Native modality prevents focus from reaching the background composer.
  expect(await drawer.evaluate(element => element.matches(':modal'))).toBe(true);
  expect(await page.getByLabel('给 Codex 发送消息').evaluate(element => { (element as HTMLElement).focus(); return document.activeElement === element; })).toBe(false);
  await search.fill('需求 3：');
  await page.screenshot({ path: 'artifacts/codex-input-outline-mobile.png', animations: 'disabled' });
  await drawer.getByRole('navigation').getByRole('button').click();
  await expect(drawer).toHaveCount(0);
  const target = page.locator('[data-chat-item="input-2"]');
  await expect(target).toBeFocused();
  await expect(target).toHaveClass(/codex-message-highlighted/);
  await expect(page.getByLabel('给 Codex 发送消息')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  // Search survives reopening; clicking the native backdrop closes the drawer.
  await toggle.click();
  await expect(search).toHaveValue('需求 3：');
  await page.mouse.click(5, 100);
  await expect(drawer).toHaveCount(0);
  await expect(toggle).toBeFocused();
  expect(errors).toEqual([]);
  expect(app.requests).toEqual([]);
});

test('Codex outline handles empty history, evicted prompts and a resized workspace without changing the conversation', async ({ page }) => {
  const app = await fixture(page);
  await app.open();
  const toggle = page.getByRole('button', { name: '对话目录', exact: true });
  await toggle.click();
  await expect(page.getByRole('navigation', { name: '用户输入目录' }).getByRole('status')).toHaveText('还没有用户输入');
  await app.patch({ items: outlineHistory() });
  const entries = page.getByRole('navigation', { name: '用户输入目录' }).getByRole('button');
  await entries.first().click();
  await expect(entries.first()).toHaveAttribute('aria-current', 'location');
  await app.patch({ items: app.current.snapshot.items.slice(2), truncated: true });
  await expect(entries).toHaveCount(23);
  await expect(page.locator('.conversation-outline-list [aria-current]')).toHaveCount(0);
  await page.setViewportSize({ width: 640, height: 844 });
  const drawer = page.getByRole('dialog', { name: '对话目录', exact: true });
  await expect(drawer).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(drawer).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: '对话目录' })).toBeVisible();
  await page.getByRole('searchbox', { name: '筛选用户输入' }).press('Escape');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('region', { name: 'Codex 图形会话' })).toBeVisible();
  expect(app.requests).toEqual([]);
});

for (const backend of ['codex', 'claude'] as const) test(`older ${backend} pages prepend without duplicate messages or scrolling away, and live patches keep the expanded history`, async ({ page }) => {
  const app = await fixture(page, backend);
  app.current.snapshot = { ...app.current.snapshot, nativeSessionId: 'history-thread', items: outlineHistory(), historyCursor: 'cursor-1', truncated: true };
  let release!: () => void;
  let calls = 0;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/sessions/${app.contact.id}/chat/history?*`, async route => {
    calls++;
    expect(new URL(route.request().url()).searchParams.get('cursor')).toBe('cursor-1');
    await pending;
    await route.fulfill({ json: { nativeSessionId: 'history-thread', items: [
      { id: 'old-user', type: 'user', text: '最早的一条需求', status: 'completed' },
      { id: 'old-reply', type: 'assistant', text: '## 历史回复\n\n这里是更早的工作结果。', status: 'completed' },
      app.current.snapshot.items[0],
    ], nextCursor: null, truncated: false } });
  });
  await app.open();
  const scroller = page.getByLabel(`${backend === 'claude' ? 'Claude' : 'Codex'} 消息记录`, { exact: true });
  await scroller.evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll', { bubbles: true })); });
  const target = page.locator('[data-chat-item="input-0"]');
  const offset = () => target.evaluate(element => element.getBoundingClientRect().top - element.closest('.codex-chat-scroll')!.getBoundingClientRect().top);
  const before = await offset();
  await page.getByRole('button', { name: '加载更早消息' }).click();
  await expect(page.getByRole('button', { name: '正在读取旧消息…' })).toBeDisabled();
  // An append during pagination must not be discarded by the late history page.
  await app.patch({ items: [...app.current.snapshot.items, { id: 'new-reply', type: 'assistant', text: '正在到达的新回复', status: 'inProgress' }] });
  release();
  await expect(page.locator('[data-chat-item="old-user"]')).toHaveCount(1);
  await expect(target).toHaveCount(1);
  await expect(page.locator('[data-chat-item="new-reply"]')).toHaveCount(1);
  await expect.poll(async () => Math.abs(await offset() - before)).toBeLessThan(2);
  await expect(page.getByRole('button', { name: '加载更早消息' })).toHaveCount(0);
  expect(calls).toBe(1);
  await page.getByRole('button', { name: '对话目录', exact: true }).click();
  const directory = page.getByRole('navigation', { name: '用户输入目录' });
  await expect(directory.getByRole('button')).toHaveCount(25);
  await directory.getByRole('button', { name: '1 最早的一条需求' }).click();
  await expect(page.locator('[data-chat-item="old-user"]')).toBeFocused();
  // The next live snapshot drops its oldest item; expanded history retains it.
  await app.patch({ items: app.current.snapshot.items.slice(1) });
  await expect(target).toHaveCount(1);
  await expect(directory.getByRole('button')).toHaveCount(25);
  expect(app.requests).toEqual([]);
});

test('failed older history requests preserve the current conversation and retry the same cursor', async ({ page }) => {
  const app = await fixture(page);
  app.current.snapshot = { ...app.current.snapshot, nativeSessionId: 'history-thread', items: outlineHistory(), historyCursor: 'retry-cursor', truncated: true };
  let requests = 0;
  await page.route(`**/api/sessions/${app.contact.id}/chat/history?*`, route => {
    expect(new URL(route.request().url()).searchParams.get('cursor')).toBe('retry-cursor');
    requests++;
    return requests === 1 ? route.fulfill({ status: 503, json: { error: '原生历史暂时不可用' } }) : route.fulfill({ json: { nativeSessionId: 'history-thread', items: [], nextCursor: null, truncated: false } });
  });
  await app.open();
  const button = page.getByRole('button', { name: '加载更早消息' });
  await button.click();
  await expect(page.getByRole('alert')).toContainText('原生历史暂时不可用');
  await expect(page.locator('.codex-message')).toHaveCount(48);
  await expect(button).toBeEnabled();
  await button.click();
  await expect(button).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(requests).toBe(2);
});

test('a disconnected native session can retry without losing its draft or sending it automatically', async ({ page }) => {
  const app = await fixture(page);
  Object.assign(app.contact, { running: true, nativeSessionId: 'exact-native-thread', interactionMode: 'chat' });
  app.current.snapshot = { ...app.current.snapshot, nativeSessionId: app.contact.nativeSessionId, items: outlineHistory() };
  let attempts = 0;
  await page.route(`**/api/sessions/${app.contact.id}/chat/connect`, async route => {
    attempts++;
    expect(route.request().method()).toBe('POST');
    if (attempts === 1) return route.fulfill({ status: 503, json: { error: '原生连接暂时不可用' } });
    await app.patch({ connected: true });
    await route.fulfill({ json: { connected: true } });
  });
  await app.open();
  const input = page.getByLabel('给 Codex 发送消息');
  await input.fill('保留的草稿，连接恢复后由我发送');
  const retry = page.getByRole('button', { name: '重新连接原生会话', exact: true });
  await expect(retry).toBeEnabled();
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
  await retry.click();
  await expect(page.getByRole('alert')).toContainText('原生连接暂时不可用');
  await expect(retry).toBeEnabled();
  await expect(input).toHaveValue('保留的草稿，连接恢复后由我发送');
  await retry.click();
  await expect(retry).toHaveCount(0);
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled();
  await expect(input).toHaveValue('保留的草稿，连接恢复后由我发送');
  await expect(page.locator('.codex-user')).toHaveCount(24);
  expect(app.requests).toEqual([]);
  expect(attempts).toBe(2);
});

test('the mobile input outline loads older inputs within its drawer and locates them', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const app = await fixture(page);
  app.current.snapshot = { ...app.current.snapshot, nativeSessionId: 'history-thread', items: outlineHistory().slice(-6), historyCursor: 'older-inputs', truncated: true };
  let calls = 0;
  await page.route(`**/api/sessions/${app.contact.id}/chat/history?*`, route => {
    calls++;
    expect(new URL(route.request().url()).searchParams.get('cursor')).toBe('older-inputs');
    return route.fulfill({ json: { nativeSessionId: 'history-thread', items: outlineHistory().slice(0, -6), nextCursor: null, truncated: false } });
  });
  await app.open();
  await page.getByRole('button', { name: '对话目录', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '对话目录', exact: true });
  await expect(drawer).toContainText('已加载 · 3 条输入');
  await drawer.getByRole('button', { name: '加载更早输入' }).click();
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText('已加载 · 24 条输入');
  await expect(drawer.getByRole('button', { name: '加载更早输入' })).toHaveCount(0);
  await drawer.getByRole('navigation').getByRole('button').first().click();
  await expect(drawer).toHaveCount(0);
  await expect(page.locator('[data-chat-item="input-0"]')).toBeFocused();
  expect(calls).toBe(1);
  expect(app.requests).toEqual([]);
});

test('graphical images survive reload and can be submitted without text', async ({ page }) => {
  const app = await fixture(page);
  const image = { id: 'b37fc923-bc83-467c-8259-79edf171ec64', name: '截图.png', type: 'image/png', size: 68 };
  let uploads = 0;
  await page.route(`**/api/sessions/${app.contact.id}/attachments`, async route => {
    uploads++; expect(route.request().headers()['content-type']).toBe('image/png');
    await route.fulfill({ status: 201, json: image });
  });
  await app.open();
  await page.locator('.image-composer input[type=file]').setInputFiles({ name: image.name, mimeType: image.type, buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB', 'base64') });
  await expect(page.getByLabel('待发送图片').locator('figure')).toHaveCount(1);
  await page.reload();
  await expect(page.getByLabel('待发送图片')).toContainText(image.name);
  await expect(page.getByLabel('给 Codex 发送消息')).toHaveValue('');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(() => app.requests.filter(item => item.path === 'messages')).toHaveLength(1);
  const sent = app.requests.find(item => item.path === 'messages')!.body;
  expect(sent.text).toBe(''); expect(sent.attachments).toEqual([image.id]); expect(uploads).toBe(1);
  await expect(page.getByLabel('待发送图片')).toHaveCount(0);
});

test('pasting rich clipboard preserves text and failed image upload keeps the draft', async ({ page }) => {
  const app = await fixture(page);
  await page.route(`**/api/sessions/${app.contact.id}/attachments`, route => route.fulfill({ status: 503, json: { error: '图片服务暂时不可用' } }));
  await app.open();
  const input = page.getByLabel('给 Codex 发送消息');
  await input.fill('现有草稿');
  await input.evaluate((field: HTMLTextAreaElement) => {
    field.setSelectionRange(field.value.length, field.value.length);
    const data = new DataTransfer();
    data.setData('text/plain', ' 和粘贴文字');
    data.items.add(new File([new Uint8Array([137,80,78,71])], 'clip.png', {type:'image/png'}));
    field.dispatchEvent(new ClipboardEvent('paste', { bubbles:true, cancelable:true, clipboardData:data }));
  });
  await expect(input).toHaveValue('现有草稿 和粘贴文字');
  await expect(page.locator('.attachment-error')).toContainText('图片服务暂时不可用');
  await page.reload();
  await expect(page.getByLabel('给 Codex 发送消息')).toHaveValue('现有草稿 和粘贴文字');
  expect(app.requests).toEqual([]);
});

test('a late image upload merges into a reopened draft without replacing new attachments or text', async ({page}) => {
  const app=await fixture(page);
  let release!:()=>void; const held=new Promise<void>(resolve=>{release=resolve;}); let began=false;
  const first={id:'a37fc923-bc83-467c-8259-79edf171ec64',name:'first.png',type:'image/png',size:12};
  const second={...first,id:'c37fc923-bc83-467c-8259-79edf171ec64',name:'second.png'};
  await page.route('**/api/sessions/'+app.contact.id+'/attachments',async route=>{
    if(!began){began=true;await held;await route.fulfill({status:201,json:first});}
    else await route.fulfill({status:201,json:second});
  });
  await app.open();
  const file={name:'first.png',mimeType:'image/png',buffer:Buffer.from([137,80,78,71])};
  await page.locator('.image-composer input[type=file]').setInputFiles(file);
  await expect.poll(()=>began).toBe(true);
  await page.getByRole('button',{name:'关闭会话',exact:true}).click();
  await page.getByRole('button',{name:'进入 '+app.contact.title+' 的会话',exact:true}).click();
  await page.getByLabel('给 Codex 发送消息').fill('新的草稿');
  await page.locator('.image-composer input[type=file]').setInputFiles({...file,name:'second.png'});
  await expect(page.getByLabel('待发送图片')).toContainText('second.png');
  release();
  await expect(page.getByLabel('待发送图片').locator('figure')).toHaveCount(2);
  await expect(page.getByLabel('给 Codex 发送消息')).toHaveValue('新的草稿');
  expect(app.requests.filter(item=>item.path === 'messages')).toEqual([]);
});

for (const backend of ['codex', 'claude'] as const) test(`${backend} unified native settings preserve drafts, confirm changes, handle rejection and fit mobile`, async ({ page }) => {
  const app = await fixture(page, backend);
  let nativeSettings = { nativeSessionId: 'exact-native-thread', version: 'settings-1', model: 'native-model', models: [{ id: 'native-model', label: 'Native Model' }, { id: 'native-other', label: 'Native Other', description: 'Native-provided choice' }], permission: 'native-default', permissions: [{ id: 'native-default', label: 'Native Default' }, { id: 'native-plan', label: 'Native Plan' }], scope: '当前原生执行器的设置' };
  const updates: unknown[] = [];
  let denied = false;
  await page.route(`**/api/sessions/${app.contact.id}/chat/settings`, async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: nativeSettings });
    const body = route.request().postDataJSON(); updates.push(body);
    if (denied) return route.fulfill({ status: 409, json: { error: 'Native policy denied model' } });
    nativeSettings = { ...nativeSettings, version: 'settings-2', [body.field]: body.value };
    await route.fulfill({ json: nativeSettings });
  });
  await app.open();
  const input = page.getByLabel(`给 ${backend === 'claude' ? 'Claude' : 'Codex'} 发送消息`);
  await input.fill('保留我的草稿');
  await page.getByRole('button', { name: '会话设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '会话设置', exact: true });
  await expect(dialog.getByLabel('模型', { exact: true })).toHaveValue('native-model');
  await dialog.getByLabel('模型', { exact: true }).selectOption('native-other');
  await dialog.getByRole('button', { name: '应用模型', exact: true }).click();
  await expect(dialog).toContainText('原生设置已确认');
  expect(updates).toEqual([{ version: 'settings-1', field: 'model', value: 'native-other' }]);
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(input).toHaveValue('保留我的草稿');
  await page.setViewportSize({ width: 390, height: 844 });
  await input.fill('/model'); await input.press('Enter');
  await expect(dialog).toBeVisible();
  await expect(input).toHaveValue('');
  expect(app.requests.filter(item => item.path === 'messages')).toHaveLength(0);
  denied = true;
  await dialog.getByLabel('模型', { exact: true }).selectOption('native-model');
  await dialog.getByRole('button', { name: '应用模型', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Native policy denied model');
  await expect(dialog.getByLabel('模型', { exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: '刷新原生设置', exact: true }).click();
  await expect(dialog.getByLabel('模型', { exact: true })).toHaveValue('native-other');
  const bounds = await dialog.boundingBox(); expect(bounds).toBeTruthy(); expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: `artifacts/${backend}-native-settings-mobile.png` });
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
  await app.patch({ activeTurnId: 'native-active-turn' });
  await page.getByRole('button', { name: '会话工具', exact: true }).click();
  await page.getByRole('button', { name: '会话设置', exact: true }).click();
  await expect(dialog.getByLabel('模型', { exact: true })).toBeDisabled();
});

for (const backend of ['codex', 'claude'] as const) test(`${backend} composer exposes independent native model and permission controls`, async ({ page }) => {
  const app = await fixture(page, backend);
  let nativeSettings = { nativeSessionId: 'exact-native-thread', version: 'quick-1', model: 'native-model', models: [{ id: 'native-model', label: 'Native Model' }, { id: 'native-other', label: 'Native Other' }], permission: 'native-default', permissions: [{ id: 'native-default', label: 'Native Default' }, { id: 'native-plan', label: 'Native Plan' }], scope: '当前原生执行器的设置' };
  const updates: { version: string; field: string; value: string }[] = [];
  await page.route(`**/api/sessions/${app.contact.id}/chat/settings`, async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: nativeSettings });
    const body = route.request().postDataJSON() as { version: string; field: 'model' | 'permission'; value: string };
    updates.push(body);
    nativeSettings = { ...nativeSettings, version: `quick-${updates.length + 1}`, [body.field]: body.value };
    return route.fulfill({ json: nativeSettings });
  });
  await app.open();
  const input = page.getByLabel(`给 ${backend === 'claude' ? 'Claude' : 'Codex'} 发送消息`);
  await input.fill('草稿需要完整保留');
  await page.getByRole('button', { name: /选择原生模型/ }).click();
  const modelPopover = page.getByRole('group', { name: '原生模型设置' });
  await expect(modelPopover.getByLabel('原生模型', { exact: true })).toHaveValue('native-model');
  await modelPopover.getByLabel('原生模型', { exact: true }).selectOption('native-other');
  await modelPopover.getByRole('button', { name: '应用模型' }).click();
  await expect(modelPopover).toContainText('原生设置已确认');
  expect(updates[0]).toEqual({ version: 'quick-1', field: 'model', value: 'native-other' });
  await page.getByRole('button', { name: /选择原生权限/ }).click();
  const permissionPopover = page.getByRole('group', { name: '原生权限设置' });
  await expect(permissionPopover.getByLabel('原生权限', { exact: true })).toHaveValue('native-default');
  await permissionPopover.getByLabel('原生权限', { exact: true }).selectOption('native-plan');
  await permissionPopover.getByRole('button', { name: '应用权限' }).click();
  await expect(permissionPopover).toContainText('原生设置已确认');
  expect(updates[1]).toEqual({ version: 'quick-2', field: 'permission', value: 'native-plan' });
  await expect(input).toHaveValue('草稿需要完整保留');
  await permissionPopover.getByRole('button', { name: '关闭快捷设置' }).click();
  await expect(page.getByRole('button', { name: '选择原生权限', exact: true })).toBeFocused();
  await page.getByRole('button', { name: '会话设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '会话设置', exact: true });
  await expect(dialog.getByLabel('模型', { exact: true })).toHaveValue('native-other');
  await dialog.getByLabel('模型', { exact: true }).selectOption('native-model');
  await dialog.getByRole('button', { name: '应用模型', exact: true }).click();
  await expect(dialog).toContainText('原生设置已确认');
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.getByRole('button', { name: '选择原生模型', exact: true })).toContainText('Native Model');
  await page.setViewportSize({ width: 390, height: 844 });
  const controls = page.getByLabel('原生模型和权限');
  const bounds = await controls.boundingBox(); expect(bounds).toBeTruthy(); expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  const expectSendInView = async () => {
    const button = await page.getByRole('button', { name: '发送', exact: true }).boundingBox();
    expect(button).toBeTruthy(); expect(button!.y + button!.height).toBeLessThanOrEqual(844);
    const form = await page.locator('.agent-chat-composer').boundingBox();
    expect(button!.y + button!.height).toBeLessThanOrEqual(form!.y + form!.height);
  };
  await expectSendInView();
  await app.patch({ activeTurnId: 'quick-active-turn' });
  await expectSendInView();
  await page.getByRole('button', { name: /选择原生模型/ }).click();
  await expect(page.getByLabel('原生模型', { exact: true })).toBeDisabled();
  await app.patch({ activeTurnId: null });
  await expect(page.getByLabel('原生模型', { exact: true })).toBeEnabled();
  await app.patch({ requests: [{ id: 'quick-approval', kind: 'approval', title: '待审批' }] });
  await expect(page.getByLabel('原生模型', { exact: true })).toBeDisabled();
  await app.patch({ requests: [] });
  await expect(page.getByLabel('原生模型', { exact: true })).toBeEnabled();
  await page.screenshot({ path: `artifacts/${backend}-composer-settings-mobile.png` });
  const popup = await modelPopover.boundingBox(); expect(popup).toBeTruthy(); expect(popup!.y).toBeGreaterThanOrEqual(0); expect(popup!.x + popup!.width).toBeLessThanOrEqual(390);
  await modelPopover.getByRole('button', { name: '刷新原生模型' }).press('Escape');
  await expect(modelPopover).toHaveCount(0);
  await expect(page.getByRole('button', { name: '选择原生模型', exact: true })).toBeFocused();
});

for (const backend of ['codex', 'claude'] as const) test(`${backend} slash command menu has native setup descriptions and preserves enter shortcuts`, async ({ page }) => {
  const app = await fixture(page, backend); await app.open();
  const input = page.getByLabel(`给 ${backend === 'claude' ? 'Claude' : 'Codex'} 发送消息`);
  await input.fill('/');
  const menu = page.getByRole('listbox', { name: '原生会话命令' });
  await expect(menu.getByRole('option')).toHaveCount(3);
  await expect(menu).toContainText('选择当前会话使用的模型');
  await input.press('ArrowDown');
  await expect(menu.getByRole('option', { selected: true })).toContainText('/model');
  await expect(input).toBeFocused();
  await input.press('Enter');
  await expect(page.getByRole('dialog', { name: '会话设置' })).toBeVisible();
  await page.keyboard.press('Escape');
  await input.fill('/'); await input.press('Escape');
  await expect(menu).toHaveCount(0); await expect(input).toHaveValue('/');
  await input.fill('/m');
  await expect(menu.getByRole('option')).toHaveCount(1);
  await expect(menu.getByRole('option')).toContainText('/model');
  await page.screenshot({ path: `artifacts/${backend}-slash-commands-desktop.png` });
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, keyCode: 229 });
  await expect(page.getByRole('dialog', { name: '会话设置' })).toHaveCount(0);
  await expect(input).toHaveValue('/m');
  await input.fill('/permissions'); await input.press('Enter');
  await expect(page.getByRole('dialog', { name: '会话设置' })).toBeVisible();
  await expect(input).toHaveValue('');
  expect(app.requests.filter(item => item.path === 'messages')).toHaveLength(0);
});

for (const backend of ['codex', 'claude'] as const) test(`${backend} composer invalidates rejected settings and ignores old connection readback`, async ({ page }) => {
  const app = await fixture(page, backend);
  let nativeSettings = { nativeSessionId: 'exact-native-thread', version: 'first', model: 'one', models: [{ id: 'one', label: 'Model One' }, { id: 'two', label: 'Model Two' }], permission: null, permissionLabel: '自定义原生策略', permissions: [], permissionReason: '此原生版本不支持修改权限', scope: '只影响当前会话' };
  let holdRead = false, reads = 0;
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const updates: unknown[] = [];
  await page.route(`**/api/sessions/${app.contact.id}/chat/settings`, async route => {
    if (route.request().method() === 'POST') { updates.push(route.request().postDataJSON()); return route.fulfill({ status: 409, json: { error: '原生拒绝修改，请刷新确认' } }); }
    reads++;
    const response = nativeSettings;
    if (holdRead) await wait;
    return route.fulfill({ json: response });
  });
  await app.open();
  const input = page.getByLabel(`给 ${backend === 'claude' ? 'Claude' : 'Codex'} 发送消息`);
  await input.fill('保留我的任务');
  await page.getByRole('button', { name: '选择原生模型', exact: true }).click();
  const model = page.getByRole('group', { name: '原生模型设置' });
  await model.getByLabel('原生模型', { exact: true }).selectOption('two');
  await model.getByRole('button', { name: '应用模型' }).click();
  await expect(model.getByRole('alert')).toContainText('原生拒绝修改');
  await expect(model.getByLabel('原生模型', { exact: true })).toHaveCount(0);
  await model.getByRole('button', { name: '刷新原生模型' }).click();
  await expect(model.getByLabel('原生模型', { exact: true })).toHaveValue('one');
  await page.getByRole('button', { name: '选择原生权限', exact: true }).click();
  const permissions = page.getByRole('group', { name: '原生权限设置' });
  await expect(permissions).toContainText('此原生版本不支持修改权限');
  await expect(permissions.getByRole('button', { name: '应用权限' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '选择原生权限', exact: true })).toContainText('自定义原生策略');
  const before = reads;
  holdRead = true;
  await page.getByRole('button', { name: '选择原生模型', exact: true }).click();
  await expect.poll(() => reads).toBe(before + 1);
  holdRead = false;
  nativeSettings = { ...nativeSettings, version: 'replacement', model: 'two' };
  app.current.snapshot = { ...app.current.snapshot, instanceId: 'replacement-instance', revision: 1 };
  await emit(page, `/api/sessions/${app.contact.id}/chat/events`, 'state', app.current.snapshot);
  await expect(model.getByLabel('原生模型', { exact: true })).toHaveValue('two');
  release();
  await expect(model.getByLabel('原生模型', { exact: true })).toHaveValue('two');
  await expect(input).toHaveValue('保留我的任务');
  expect(updates).toEqual([{ version: 'first', field: 'model', value: 'two' }]);
  expect(app.requests.filter(item => item.path === 'messages')).toHaveLength(0);
});

test('composer menus remain usable at 200 percent zoom on a small screen and in fullscreen', async ({ page }) => {
  const app = await fixture(page);
  await page.addInitScript(() => { localStorage.setItem('dili.interface-zoom', '200'); });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route(`**/api/sessions/${app.contact.id}/chat/settings`, route => route.fulfill({ json: { nativeSessionId: 'exact-native-thread', version: 'zoom', model: 'long', models: [{ id: 'long', label: '一个足够长的原生模型名称用于测试完整显示边界' }], permission: 'default', permissions: [{ id: 'default', label: '原生默认权限' }], scope: '当前会话' } }));
  await app.open();
  const input = page.getByLabel('给 Codex 发送消息');
  await input.fill('/');
  const menu = page.getByRole('listbox', { name: '原生会话命令' });
  let box = (await menu.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0); expect(box.y).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(390); expect(box.y + box.height).toBeLessThanOrEqual(844);
  await page.screenshot({ path: 'artifacts/composer-slash-mobile-200.png' });
  await input.fill('保留草稿');
  await page.getByRole('button', { name: '选择原生权限', exact: true }).click();
  const popup = page.getByRole('group', { name: '原生权限设置' });
  await expect(popup.getByLabel('原生权限', { exact: true })).toBeVisible();
  for (const label of ['选择原生模型', '选择原生权限']) {
    const control = (await page.getByRole('button', { name: label, exact: true }).boundingBox())!;
    expect(control.x).toBeGreaterThanOrEqual(0); expect(control.x + control.width).toBeLessThanOrEqual(390);
  }
  box = (await popup.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0); expect(box.y).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(390); expect(box.y + box.height).toBeLessThanOrEqual(844);
  await popup.getByRole('button', { name: '关闭快捷设置' }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: '全屏会话', exact: true }).click();
  await page.getByRole('button', { name: '选择原生模型', exact: true }).click();
  await expect(page.getByRole('group', { name: '原生模型设置' }).getByLabel('原生模型', { exact: true })).toBeVisible();
  await expect(input).toHaveValue('保留草稿');
  await page.screenshot({ path: 'artifacts/composer-settings-fullscreen-200.png' });
});

for (const backend of ['codex', 'claude'] as const) test(`${backend} discards pending old-instance pages and reloads with the replacement cursor`, async ({ page }) => {
  const app = await fixture(page, backend);
  app.current.snapshot = { ...app.current.snapshot, nativeSessionId: 'same-native-thread', items: outlineHistory(), historyCursor: 'old-cursor' };
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const cursors: string[] = [];
  let oldResponseDone = false;
  await page.route(`**/api/sessions/${app.contact.id}/chat/history?*`, async route => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor')!;
    cursors.push(cursor);
    if (cursor === 'old-cursor') await pending;
    await route.fulfill({ json: { nativeSessionId: 'same-native-thread', items: [{ id: cursor, type: 'user', text: cursor, status: 'completed' }], nextCursor: null, truncated: false } });
    if (cursor === 'old-cursor') oldResponseDone = true;
  });
  await app.open();
  await page.getByRole('button', { name: '加载更早消息' }).click();
  await expect.poll(() => cursors.length).toBe(1);
  app.current.snapshot = { ...app.current.snapshot, instanceId: 'replacement-server', revision: 1, historyCursor: 'new-cursor', items: [{ id: 'restored', type: 'user', text: '恢复后的消息', status: 'completed' }] };
  await emit(page, `/api/sessions/${app.contact.id}/chat/events`, 'state', app.current.snapshot);
  await expect(page.locator('[data-chat-item="restored"]')).toBeVisible();
  // A hung request from the replaced instance must not block the new one.
  await page.getByRole('button', { name: '加载更早消息' }).click();
  await expect(page.locator('[data-chat-item="new-cursor"]')).toHaveCount(1);
  release();
  await expect.poll(() => oldResponseDone).toBe(true);
  await expect(page.locator('[data-chat-item="old-cursor"]')).toHaveCount(0);
  await expect(page.locator('[data-chat-item="input-0"]')).toHaveCount(0);
  expect(cursors).toEqual(['old-cursor', 'new-cursor']);
});

test('Claude final saved messages replace provisional text even when older history was expanded', async ({ page }) => {
  const app = await fixture(page, 'claude');
  const provisional: CodexChatItem = { id: 'claude-live:thread:msg:1', type: 'assistant', text: '流式回复', status: 'inProgress' };
  app.current.snapshot = { ...app.current.snapshot, nativeSessionId: 'thread', items: [...outlineHistory(), provisional], historyCursor: 'older' };
  await page.route(`**/api/sessions/${app.contact.id}/chat/history?*`, route => route.fulfill({ json: { nativeSessionId: 'thread', items: [], nextCursor: null, truncated: false } }));
  await app.open();
  await page.getByRole('button', { name: '加载更早消息' }).click();
  await expect(page.getByRole('button', { name: '加载更早消息' })).toHaveCount(0);
  const saved: CodexChatItem = { id: 'claude:thread:saved-uuid', replaces: [provisional.id], type: 'assistant', text: '流式回复已完成', status: 'completed' };
  await app.patch({ items: [...app.current.snapshot.items.filter(item => item.id !== provisional.id), saved] });
  await expect(page.locator('[data-chat-item="claude:thread:saved-uuid"]')).toHaveCount(1);
  await expect(page.locator('[data-chat-item="claude-live:thread:msg:1"]')).toHaveCount(0);
  await app.patch({ items: app.current.snapshot.items.filter(item => item.id !== saved.id) });
  await expect(page.locator('[data-chat-item="claude:thread:saved-uuid"]')).toHaveCount(1);
  await expect(page.locator('[data-chat-item="claude-live:thread:msg:1"]')).toHaveCount(0);
});
