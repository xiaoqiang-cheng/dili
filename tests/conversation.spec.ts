import { mutationHeaders, test } from './fixtures';
import { expectUnifiedConversation } from './conversation-layout';
import { copyPrompt, expectMessageCopy } from './chat-copy';
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import type { AppState, ConversationTranscript, Group, Session } from '../shared/types';

for (const backend of ['claude', 'codex', 'dsh'] as const) test(`${backend} transcript user messages support selection and copy in standalone and mobile views`, async ({ page }) => {
  const seed = await (await page.request.get('/api/state')).json() as AppState;
  const contact = await mutate<Session>(page.request, '/sessions', { backend, title: backend + ' message copy', cwd: seed.defaultCwd });
  await page.route(`**/api/sessions/${contact.id}/conversation`, route => route.fulfill({ json: { messages: [{ id: 'copy-user', role: 'user', text: copyPrompt }], truncated: false } }));
  await openConversation(page, contact);
  await expectMessageCopy(page, page.locator('[data-message-id="copy-user"]'));
});

for (const backend of ['claude', 'codex', 'dsh'] as const) {
  test(`${backend} outline filters user inputs, jumps to exact duplicates and supports fullscreen`, async ({ page }) => {
    const seed = await (await page.request.get('/api/state')).json() as AppState;
    const contact = await mutate<Session>(page.request, '/sessions', { backend, title: backend + ' directory', cwd: seed.defaultCwd });
    const history: ConversationTranscript = { messages: Array.from({ length: 64 }, (_, index) => ({ id: 'entry-' + index, role: index % 2 ? 'assistant' : 'user', text: index % 2 ? 'assistant response ' + index : '重复需求 ' + (index % 4) })), truncated: true };
    await page.route(`**/api/sessions/${contact.id}/conversation`, route => route.fulfill({ json: history }));
    await openConversation(page, contact);
    await expectUnifiedConversation(page);
    await expect(page.locator('.backend-avatar svg').first()).toBeVisible();
    await page.getByRole('button', { name: '对话目录', exact: true }).click();
    const nav = page.getByRole('navigation', { name: '用户输入目录' });
    await expect(nav.getByRole('button')).toHaveCount(32);
    await page.getByRole('searchbox', { name: '筛选用户输入' }).fill('重复需求 0');
    await expect(nav.getByRole('button')).toHaveCount(16); await nav.getByRole('button').nth(2).click();
    const target = page.locator('[data-message-id=entry-8]'); await expect(target).toBeFocused();
    expect(await target.evaluate(element => Math.abs(element.getBoundingClientRect().top - element.closest('.conversation-scroller')!.getBoundingClientRect().top - 12))).toBeLessThan(2);
    await page.getByRole('button', { name: '关闭对话目录', exact: true }).click();
    await page.getByRole('button', { name: '全屏会话', exact: true }).click(); await expect(page.locator('.session-drawer')).toHaveClass(/session-fullscreen/);
    await page.keyboard.press('Escape'); await expect(page.locator('.session-drawer')).not.toHaveClass(/session-fullscreen/);
    await page.setViewportSize({ width: 390, height: 844 }); await page.getByRole('button', { name: '对话目录', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '对话目录', exact: true }); await expect(dialog).toBeVisible();
    await dialog.getByRole('navigation').getByRole('button').first().click(); await expect(dialog).toHaveCount(0);
    await expect(page.locator('.conversation-message.from-user').first()).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}

test('Harness without a TUI exposes its transcript directory and returns to its native web view', async ({ page }) => {
  const seed = await (await page.request.get('/api/state')).json() as AppState;
  const contact = await mutate<Session>(page.request, '/sessions', { backend: 'dsh', title: 'Harness Web directory', cwd: seed.defaultCwd });
  const state = { ...seed, demo: false, sessions: [contact], groups: [], activities: [], backends: seed.backends.map(item => item.id === 'dsh' ? { ...item, installed: true, capabilities: { ...item.capabilities, terminal: false } } : item) };
  // Keep the fixture state authoritative: the real demo SSE would replace it.
  await page.addInitScript(() => {
    class FixtureEvents extends EventTarget {
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() { super(); queueMicrotask(() => this.onopen?.()); }
      close() {}
    }
    Object.defineProperty(window, 'EventSource', { configurable: true, value: FixtureEvents });
  });
  await page.route('**/api/state', route => route.fulfill({ json: state }));
  await page.route(`**/api/sessions/${contact.id}/conversation`, route => route.fulfill({ json: { messages: [{ id: 'web-user', role: 'user', text: 'Harness 原生需求' }], truncated: false } }));
  await page.goto(`/#/contacts?session=${contact.id}`);
  await expect(page.getByRole('heading', { name: '直接使用 Harness 原生界面', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '对话记录', exact: true }).click();
  await page.getByRole('button', { name: '对话目录', exact: true }).click();
  await expect(page.getByRole('navigation', { name: '用户输入目录' }).getByRole('button')).toContainText('Harness 原生需求');
  await page.getByRole('button', { name: '关闭对话目录', exact: true }).click();
  await expect(page.getByLabel('原生会话消息草稿')).toHaveCount(0);
  await page.getByRole('button', { name: '原生界面', exact: true }).click();
  await expect(page.getByRole('heading', { name: '直接使用 Harness 原生界面', exact: true })).toBeVisible();
});

async function mutate<T>(request: APIRequestContext, path: string, body: unknown = {}): Promise<T> {
  const headers = await mutationHeaders(request);
  const response = await request.post(`/api${path}`, {
    data: body, headers,
  });
  expect(response.ok(), `${path} must succeed in the local demo fixture`).toBe(true);
  return await response.json() as T;
}

async function createSession(request: APIRequestContext, title: string, groupId?: string) {
  const state = await (await request.get('/api/state')).json() as AppState;
  expect(state.demo).toBe(true);
  return mutate<Session>(request, '/sessions', { backend: 'codex', title, cwd: state.defaultCwd, groupId });
}

async function openConversation(page: Page, session: Session) {
  await page.goto(`/#/contacts?session=${session.id}`);
  await page.getByRole('button', { name: '对话记录', exact: true }).click();
  await expect(page.getByRole('region', { name: '原生对话记录', exact: true })).toBeVisible();
}

test('conversation history is read-only, recovers from failed refresh and switches back to the same native terminal', async ({ page }) => {
  const session = await createSession(page.request, '真实历史界面回归');
  const history: ConversationTranscript = { messages: [
    { id: 'user-1', role: 'user', text: '请检查 workspace 中的登录流程。', createdAt: '2026-09-29T01:01:00Z' },
    { id: 'assistant-1', role: 'assistant', text: '已确认以下代码：\n```ts\nconst text = "<img src=x onerror=alert(1)>";\n```', createdAt: '2026-09-29T01:02:00Z' },
  ], truncated: true };
  let fail = false;
  const mutations: string[] = [];
  page.on('request', request => { if (request.method() === 'POST' && /\/(?:start|stop|input)$/.test(request.url())) mutations.push(request.url()); });
  await page.route(`**/api/sessions/${session.id}/conversation`, route => route.fulfill({
    status: fail ? 503 : 200, json: fail ? { error: '原生历史暂时无法读取' } : history,
  }));
  await openConversation(page, session);
  await expect(page.locator('.conversation-text').first()).toHaveText(history.messages[0].text);
  await expect(page.locator('.conversation-text').last().locator('pre')).toHaveText('const text = "<img src=x onerror=alert(1)>";\n');
  await expect(page.locator('.conversation-pane img')).toHaveCount(0);
  await expect(page.locator('.conversation-pane')).toContainText('最近部分，完整上下文请在原生终端中查看');
  await expect(page.locator('.conversation-source')).not.toContainText('最近部分');
  await page.getByRole('button', { name: '关闭此提示', exact: true }).click();
  await expect(page.locator('.conversation-notice-toast')).toHaveCount(0);
  await expect(page.locator('.conversation-pane textarea')).toHaveCount(0);
  await page.screenshot({ path: 'artifacts/conversation-desktop.png' });
  fail = true;
  await page.getByRole('button', { name: '刷新记录', exact: true }).click();
  await expect(page.locator('.conversation-error')).toContainText('原生历史暂时无法读取');
  await expect(page.locator('.conversation-text').first()).toHaveText(history.messages[0].text);
  fail = false;
  await page.getByRole('button', { name: '重试读取', exact: true }).click();
  await expect(page.locator('.conversation-error')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button', { name: '对话记录', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.conversation-text')).toHaveCount(2);
  await expect(page.locator('.conversation-notice-toast')).toHaveCount(0);
  await page.getByRole('button', { name: '原生终端', exact: true }).click();
  await expect(page.getByRole('dialog', { name: `${session.title} 的私聊` })).toBeVisible();
  await expect(page.locator('.terminal-connection')).toHaveText('已连接');
  await expect(page.getByRole('button', { name: '原生终端', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(mutations).toEqual([]);
});

test('conversation refresh follows the bottom but preserves older reading positions and selected text', async ({ page }) => {
  const session = await createSession(page.request, '对话滚动锚点回归');
  const history: ConversationTranscript = { messages: Array.from({ length: 60 }, (_, index) => ({
    id: `message-${index}`, role: index % 2 ? 'assistant' as const : 'user' as const,
    text: `第 ${index + 1} 条原生消息\n用于确认读取旧对话时不会被拉到底部。\nfunction run() { return ${index}; }`,
  })), truncated: false };
  let reads = 0;
  await page.route(`**/api/sessions/${session.id}/conversation`, route => { reads++; return route.fulfill({ json: history }); });
  await openConversation(page, session);
  const scroller = page.getByLabel('会话消息', { exact: true });
  await expect(page.locator('.conversation-message')).toHaveCount(60);
  await expect.poll(() => scroller.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(2);
  history.messages.push({ id: 'message-60', role: 'assistant', text: '底部追随的新回复' });
  await page.getByRole('button', { name: '刷新记录', exact: true }).click();
  await expect(page.locator('.conversation-message')).toHaveCount(61);
  await expect.poll(() => scroller.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(2);

  await scroller.evaluate(element => { element.scrollTop = 300; element.dispatchEvent(new Event('scroll', { bubbles: true })); });
  await expect(page.getByRole('button', { name: '回到最新消息', exact: true })).toBeVisible();
  const before = await scroller.evaluate(element => element.scrollTop);
  history.messages.push({ id: 'message-61', role: 'assistant', text: '不打断旧消息阅读的新回复' });
  await page.getByRole('button', { name: '刷新记录', exact: true }).click();
  await expect(page.locator('.conversation-message')).toHaveCount(62);
  expect(Math.abs(await scroller.evaluate(element => element.scrollTop) - before)).toBeLessThan(2);

  const selected = await page.locator('.conversation-text').nth(1).evaluate(element => {
    const selection = window.getSelection()!;
    const range = document.createRange(); range.selectNodeContents(element);
    selection.removeAllRanges(); selection.addRange(range); return selection.toString();
  });
  const beforeRead = reads;
  await page.getByRole('button', { name: '刷新记录', exact: true }).evaluate(button => (button as HTMLButtonElement).click());
  await expect.poll(() => reads).toBeGreaterThan(beforeRead);
  await expect(page.getByRole('button', { name: '刷新记录', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(selected);
  await page.getByRole('button', { name: '回到最新消息', exact: true }).click();
  await expect.poll(() => scroller.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(2);
});

test('late history responses stay with their own session and mobile records do not overflow', async ({ page }) => {
  const first = await createSession(page.request, '延迟对话一');
  const second = await createSession(page.request, '延迟对话二');
  let release!: () => void;
  let received = false;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/sessions/${first.id}/conversation`, async route => {
    received = true; await pending;
    await route.fulfill({ json: { messages: [{ id: 'old-user', role: 'user', text: '第一个会话的迟到记录' }], truncated: false } });
  });
  await page.route(`**/api/sessions/${second.id}/conversation`, route => route.fulfill({ json: {
    messages: [{ id: 'new-user', role: 'user', text: `第二个会话的记录\n${'very-long-path/'.repeat(30)}` }], truncated: false,
  } }));
  await openConversation(page, first);
  await expect.poll(() => received).toBe(true);
  await page.evaluate(id => { location.hash = `#/contacts?session=${id}`; }, second.id);
  await expect(page.getByRole('dialog', { name: `${second.title} 的私聊` })).toBeVisible();
  await expect(page.locator('.conversation-text')).toContainText('第二个会话的记录');
  const response = page.waitForResponse(`**/api/sessions/${first.id}/conversation`);
  release(); await response;
  await expect(page.locator('.conversation-text')).toContainText('第二个会话的记录');
  await expect(page.getByText('第一个会话的迟到记录', { exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.conversation-text')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await page.locator('.conversation-scroller').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/conversation-mobile.png' });
});

test('stopping during a delayed history read still fetches the final reply after polling stops', async ({ page }) => {
  const session = await createSession(page.request, '停止时刷新对话回归');
  await mutate(page.request, `/sessions/${session.id}/start`);
  let release!: () => void;
  let delayed = false;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const initial: ConversationTranscript = { messages: [{ id: 'question', role: 'user', text: '请保存最终结果' }], truncated: false };
  let latest = initial;
  await page.route(`**/api/sessions/${session.id}/conversation`, async route => {
    const snapshot = structuredClone(latest);
    if (!delayed) { delayed = true; await pending; }
    await route.fulfill({ json: snapshot });
  });
  await openConversation(page, session);
  await expect.poll(() => delayed).toBe(true);
  await page.getByRole('button', { name: '停止进程', exact: true }).click();
  await expect(page.getByRole('button', { name: /^(?:恢复|启动)原生会话$/ })).toBeVisible();
  latest = { ...initial, messages: [...initial.messages, { id: 'final', role: 'assistant', text: '退出前保存的最终回复' }] };
  release();
  await expect(page.locator('.conversation-text').last()).toHaveText('退出前保存的最终回复');
  await expect(page.locator('.conversation-text')).toHaveCount(2);
  const state = await (await page.request.get('/api/state')).json() as AppState;
  expect(state.sessions.find(item => item.id === session.id)?.running).toBe(false);
});

test('staging a group task overrides the read-only preference and opens the existing native input', async ({ page }) => {
  const group = await mutate<Group>(page.request, '/groups', { title: '对话模式任务投递回归', goal: '任务必须展示到可确认发送的原生输入区' });
  const session = await createSession(page.request, '对话偏好投递成员', group.id);
  const started = await mutate<Session>(page.request, `/sessions/${session.id}/start`);
  const prompt = 'conversation-stage-keeps-native-enter-confirmation';
  await mutate(page.request, `/groups/${group.id}/messages`, { kind: 'task', text: prompt, recipientIds: [session.id] });
  const frames: string[] = [];
  const launches: string[] = [];
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/start')) launches.push(request.url()); });
  page.on('websocket', socket => {
    if (!socket.url().includes(`/api/terminal/${session.id}`)) return;
    socket.on('framereceived', ({ payload }) => {
      const message = JSON.parse(String(payload)) as { type: string; data?: string };
      if (message.type === 'data' && message.data) frames.push(message.data);
    });
  });
  await page.goto(`/#/groups/${group.id}?session=${session.id}`);
  await page.getByRole('button', { name: '对话记录', exact: true }).click();
  await expect(page.getByRole('region', { name: '原生对话记录', exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('sessiondeck.private-view.codex'))).toBe('conversation');
  await page.getByRole('button', { name: '关闭会话', exact: true }).click();
  await page.locator('.group-message').filter({ hasText: prompt }).getByRole('button', { name: '填入会话', exact: true }).click();
  await expect(page.getByRole('dialog', { name: `${session.title} 的私聊` })).toBeVisible();
  await expect(page.getByRole('button', { name: '原生终端', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.terminal-connection')).toHaveText('已连接');
  await expect.poll(() => frames.join('')).toContain(prompt);
  expect(frames.join('')).not.toMatch(/已收到演示输入：[^\r\n]*conversation-stage-keeps-native-enter-confirmation/);

  // A user may browse history again before confirming a staged task. Its
  // explicit delivery entry must still return to native input, without restart.
  await page.getByRole('button', { name: '对话记录', exact: true }).click();
  await page.getByRole('button', { name: '关闭会话', exact: true }).click();
  await page.locator('.delivery-state').getByRole('button', { name: '进入', exact: true }).click();
  await expect(page.getByRole('button', { name: '原生终端', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.terminal-connection')).toHaveText('已连接');
  await page.getByLabel('原生会话终端输入').press('Enter');
  await expect.poll(() => frames.join('')).toMatch(/已收到演示输入：[^\r\n]*conversation-stage-keeps-native-enter-confirmation/);
  const state = await (await page.request.get('/api/state')).json() as AppState;
  expect(state.sessions.find(item => item.id === session.id)?.nativeSessionId).toBe(started.nativeSessionId);
  expect(launches).toEqual([]);
});

test('Mermaid flowcharts tolerate escaped code quotes while keeping the original source', async ({ page }) => {
  const state = await (await page.request.get('/api/state')).json() as AppState;
  const session = await mutate<Session>(page.request, '/sessions', { backend: 'claude', title: 'Mermaid 引号兼容', cwd: state.defaultCwd });
  const source = String.raw`flowchart TD
    A["caps/actions/arm/grasp_by_description.yaml<br/>runner.type: script"] --> B["对应的 logic/arm/grasp_by_description.py"]
    B --> C["扫描源码，找所有 context.call(\"xxx\", ...) 和 context.call_to_end(\"xxx\", ...)"]
    C --> D["basic.arm.get_id<br/>basic.arm.pick_by_track_id"]
    D --> E{"这两个能力<br/>这台车都有吗？"}
    E -- 都有 --> F["grasp_by_description 保留"]
    E -- 缺一个 --> G["grasp_by_description 自动消失<br/>日志记录缺了哪个"]`;
  await page.route(`**/api/sessions/${session.id}/conversation`, route => route.fulfill({ json: { messages: [{ id: 'escaped-code-diagram', role: 'assistant', text: '```mermaid\n' + source + '\n```' }], truncated: false } }));
  await page.goto(`/#/contacts?session=${session.id}`);
  await page.getByRole('button', { name: '对话记录', exact: true }).click();
  const svg = page.frameLocator('iframe[title="Mermaid 图表"]').locator('svg');
  await expect(svg).toBeVisible({ timeout: 20000 });
  await expect(svg).toContainText('context.call("xxx", ...)');
  await expect(svg).toContainText('context.call_to_end("xxx", ...)');
  await expect(svg).toContainText('runner.type: script');
  await expect(svg).toContainText('这台车都有吗？');
  await page.getByText('图表源码', { exact: true }).click();
  await expect(page.locator('.mermaid-diagram details pre')).toHaveText(source);
  await expect(page.locator('.mermaid-diagram>p[role=status]')).toHaveCount(0);
  await page.getByRole('button', { name: '放大 Mermaid 图表', exact: true }).click();
  const viewer = page.getByRole('dialog', { name: 'Mermaid 图表预览', exact: true });
  await expect(viewer).toBeVisible();
  await expect.poll(() => viewer.locator('img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await page.screenshot({ path: 'artifacts/mermaid-escaped-quotes.png' });
  await viewer.getByRole('button', { name: '关闭图表预览' }).click();
});

test('Claude history renders GFM and sandboxed Mermaid with a readable source fallback', async ({ page }) => {
  const state = await (await page.request.get('/api/state')).json() as AppState;
  const session = await mutate<Session>(page.request, '/sessions', { backend: 'claude', title: 'Claude Markdown 图表', cwd: state.defaultCwd });
  const text = '# 方案\n\n**重点**\n\n- [x] 完成\n\n|项目|状态|\n|---|---|\n|图表|正常|\n\n```ts\nconst safe = true;\n```\n\n```mermaid\nflowchart LR\n A[开始] --> B[完成]\n```';
  const history: ConversationTranscript = { messages: [{ id: 'assistant-diagram', role: 'assistant', text }], truncated: false };
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route(`**/api/sessions/${session.id}/conversation`, route => route.fulfill({ json: history }));
  await page.goto(`/#/contacts?session=${session.id}`);
  await page.getByRole('button', { name: '对话记录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '方案', exact: true })).toBeVisible();
  await expect(page.locator('.conversation-text table')).toBeVisible();
  await expect(page.locator('.conversation-text .hljs-keyword')).toHaveText('const');
  await expect(page.locator('.conversation-text input[type=checkbox]')).toBeChecked();
  const frame = page.frameLocator('iframe[title="Mermaid 图表"]');
  await expect(frame.locator('svg')).toBeVisible({ timeout: 20000 });
  await expect(frame.locator('svg')).toContainText('开始');
  await expect(page.locator('iframe[title="Mermaid 图表"]')).toHaveAttribute('sandbox', 'allow-scripts');
  await page.getByText('图表源码', { exact: true }).click();
  await expect(page.locator('.mermaid-diagram details pre')).toContainText('flowchart LR');
  await page.screenshot({ path: 'artifacts/claude-markdown-mermaid.png' });
  const expand = page.getByRole('button', { name: '放大 Mermaid 图表', exact: true });
  await expand.click();
  const viewer = page.getByRole('dialog', { name: 'Mermaid 图表预览', exact: true });
  await expect(viewer).toBeVisible();
  await expect(viewer.locator('img')).toHaveJSProperty('complete', true);
  expect(await viewer.locator('img').evaluate(node => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await viewer.getByRole('button', { name: '原始大小', exact: true }).click();
  await expect(viewer.getByRole('button', { name: '原始大小', exact: true })).toHaveText('100%');
  await viewer.getByRole('button', { name: '放大图表', exact: true }).click();
  await expect(viewer.getByRole('button', { name: '原始大小', exact: true })).toHaveText('125%');
  const canvas = viewer.getByLabel('图表画布');
  await canvas.hover();
  await page.mouse.wheel(0, -100);
  await expect(viewer.getByRole('button', { name: '原始大小', exact: true })).toHaveText('144%');
  await viewer.getByRole('button', { name: '适应窗口', exact: true }).click();
  await page.screenshot({ path: 'artifacts/mermaid-expanded-desktop.png' });
  await page.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);
  await expect(expand).toBeFocused();
  await expect(page.getByRole('dialog', { name: `${session.title} 的私聊` })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expand.click();
  await expect(viewer).toBeVisible();
  await expect(viewer.getByRole('button', { name: '关闭图表预览' })).toBeInViewport();
  await page.screenshot({ path: 'artifacts/mermaid-expanded-mobile.png' });
  await viewer.getByRole('button', { name: '原始大小', exact: true }).click();
  for (let index = 0; index < 10; index++) await viewer.getByRole('button', { name: '放大图表', exact: true }).click();
  expect(await canvas.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
  await canvas.evaluate(node => { node.scrollLeft = 0; });
  const canvasBox = (await canvas.boundingBox())!;
  await page.mouse.move(canvasBox.x + canvasBox.width - 30, canvasBox.y + 60);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 30, canvasBox.y + 60, { steps: 5 });
  await page.mouse.up();
  expect(await canvas.evaluate(node => node.scrollLeft)).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await viewer.getByRole('button', { name: '关闭图表预览' }).click();
  await expect(viewer).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 1000 });
  history.messages[0].text = '```mermaid\nthis is not a valid diagram\n```';
  await page.getByRole('button', { name: '刷新记录', exact: true }).click();
  await expect(page.locator('.mermaid-diagram')).toContainText('语法有误', { timeout: 20000 });
  expect(errors).toEqual([]);
});
