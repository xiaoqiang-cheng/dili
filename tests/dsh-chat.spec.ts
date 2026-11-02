import { test, expect, type Page } from '@playwright/test';
import type { AppState, Session } from '../shared/types';
import type { AgentChatSnapshot } from '../shared/chat';

const id = 'dsh-chat-contact';
const native = 'session-22222222-2222-4222-8222-222222222222';

async function fixture(page: Page, initial?: Partial<AgentChatSnapshot>, contactOverrides: Partial<Session> = {}, extraTitles: string[] = []) {
  const seed = await (await page.request.get('/api/state')).json() as AppState;
  const contact: Session = { ...seed.sessions[0], id, backend: 'dsh', title: 'DeepSeek 图形对话', cwd: '/workspace/demo', running: true, status: 'idle', statusSource: 'native', nativeSessionId: native, forkPending: false, interactionMode: 'terminal', executionTransport: 'web', ...contactOverrides };
  const extras: Session[] = extraTitles.map((title, index) => ({ ...contact, id: `dsh-chat-extra-${index}`, title, nativeSessionId: `session-3333333${index}-3333-4333-8333-333333333333` }));
  const state: AppState = { ...seed, demo: false, sessions: [contact, ...extras], groups: [], activities: [], backends: seed.backends.map(item => item.id === 'dsh' ? { ...item, installed: true, version: '0.2.0-rc.2', capabilities: { ...item.capabilities, terminal: true, graphicalChat: true } } : item) };
  let snapshot: AgentChatSnapshot = {
    instanceId: 'fixture-instance', nativeSessionId: native, revision: 1, connected: true, activeTurnId: null,
    items: [{ id: 'u1', type: 'user', text: '检查登录', status: 'completed' }, { id: 'a1', type: 'assistant', text: '登录流程已经检查。', status: 'completed' }],
    requests: [], truncated: false, historyCursor: null, ...initial,
  };
  const starts: Record<string, unknown>[] = [], sends: Record<string, unknown>[] = [], answers: Record<string, unknown>[] = [], settingUpdates: Record<string, unknown>[] = [];
  await page.addInitScript(() => {
    const sources: EventTarget[] = [];
    Object.assign(window, { dshChatSources: sources });
    class Source extends EventTarget { onopen: (() => void) | null = null; onerror: (() => void) | null = null; constructor() { super(); sources.push(this); queueMicrotask(() => this.onopen?.()); } close() { sources.splice(sources.indexOf(this), 1); } }
    Object.defineProperty(window, 'EventSource', { value: Source });
  });
  await page.route('**/api/state', route => route.fulfill({ json: state }));
  await page.route('**/api/config', route => route.fulfill({ json: { csrfToken: 'test-token' } }));
  await page.route('**/api/sessions/' + id + '/read', route => route.fulfill({ json: contact }));
  await page.route('**/api/sessions/' + id + '/start', async route => {
    starts.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ json: { ...contact, interactionMode: 'chat', executionTransport: 'web' } });
  });
  const nativeSettings = { nativeSessionId: native, version: 'settings-1', model: 'discover/deepseek-v4-flash', models: [{ id: 'discover/deepseek-v4-flash', label: 'deepseek-v4-flash' }, { id: 'discover/deepseek-v4-pro', label: 'deepseek-v4-pro' }], permission: 'workspace-write', permissions: [{ id: 'read-only', label: 'read-only' }, { id: 'workspace-write', label: 'workspace-write' }, { id: 'danger-full-access', label: 'danger-full-access' }], scope: '作用于当前原生 dsh 会话；通过原生 Session API 修改。' };
  await page.route('**/api/sessions/' + id + '/chat/settings', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: contact.executionTransport === 'web' ? nativeSettings : { ...nativeSettings, disabledReason: '当前输入由 dsh-tui 持有；先接管图形对话，再修改原生模型和权限' } });
    settingUpdates.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ json: { ...nativeSettings, version: 'settings-2' } });
  });
  await page.route('**/api/sessions/' + id + '/chat/messages', async route => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    sends.push(body);
    snapshot = { ...snapshot, revision: snapshot.revision + 1, items: [...snapshot.items, { id: 'u2', type: 'user', text: String(body.text ?? ''), status: 'completed' }] };
    return route.fulfill({ json: { requestId: body.requestId, status: 'accepted', turnId: 'turn-1' } });
  });
  await page.route('**/api/sessions/' + id + '/chat/requests/*', async route => {
    answers.push(route.request().postDataJSON() as Record<string, unknown>);
    snapshot = { ...snapshot, revision: snapshot.revision + 1, requests: [] };
    return route.fulfill({ json: { ok: true } });
  });
  await page.route('**/api/sessions/' + id + '/chat{,?*}', route => route.fulfill({ json: snapshot }));
  for (const extra of extras) {
    await page.route('**/api/sessions/' + extra.id + '/read', route => route.fulfill({ json: extra }));
    await page.route('**/api/sessions/' + extra.id + '/chat{,?*}', route => route.fulfill({ json: { ...snapshot, nativeSessionId: extra.nativeSessionId } }));
    await page.route('**/api/sessions/' + extra.id + '/chat/settings', route => route.fulfill({ json: { ...nativeSettings, nativeSessionId: extra.nativeSessionId } }));
  }
  await page.goto('/#/contacts?session=' + id);
  await expect(page.getByRole('region', { name: 'DeepSeek 图形会话' })).toBeVisible();
  return { contact, extras, snapshot: () => snapshot, starts, sends, answers, settingUpdates };
}

test('dsh opens the shared structured chat with native history and no fake native composer', async ({ page }) => {
  await fixture(page);
  await expect(page.getByText('登录流程已经检查。')).toBeVisible();
  await expect(page.getByLabel('给 DeepSeek 发送消息')).toBeVisible();
  await expect(page.getByLabel('原生会话消息草稿')).toHaveCount(0);
  // The structured dsh prompt is text-only; do not offer an image button that drops files.
  await expect(page.getByText('添加图片', { exact: true })).toHaveCount(0);
  await expect(page.locator('.private-view-switch button').first()).toHaveAttribute('aria-pressed', 'true');
});

test('dsh send enters chat mode and acknowledges through the native message API', async ({ page }) => {
  const app = await fixture(page);
  await page.getByLabel('给 DeepSeek 发送消息').fill('继续修复');
  await page.getByRole('button', { name: '发送', exact: true }).first().click();
  await expect.poll(() => app.sends.length).toBe(1);
  expect(app.starts).toEqual([{ mode: 'chat' }]);
  expect(app.sends[0]).toMatchObject({ text: '继续修复' });
  await expect(page.getByText('继续修复')).toBeVisible();
});

test('dsh question cards submit through the structured endpoint instead of the native terminal', async ({ page }) => {
  const app = await fixture(page, { requests: [{ id: 'call-q', kind: 'question', title: '接口', questions: [{ id: 'q1', header: '接口', question: '保留旧接口吗？', isOther: true, options: [{ label: '保留' }, { label: '删除' }] }] }] });
  await expect(page.getByRole('heading', { name: '接口' })).toBeVisible();
  await page.getByRole('radio', { name: /保留/ }).check();
  await page.getByRole('button', { name: '提交回答', exact: true }).click();
  await expect.poll(() => app.answers.length).toBe(1);
  expect(app.answers[0]).toEqual({ answers: { q1: ['保留'] } });
  await expect(page.getByRole('button', { name: '提交回答', exact: true })).toHaveCount(0);
});

test('dsh-tui-owned sessions stay read-only until an explicit handoff', async ({ page }) => {
  const app = await fixture(page, undefined, { executionTransport: 'pty' });
  await expect(page.getByText(/当前输入由 dsh-tui 持有/).first()).toBeVisible();
  await page.getByLabel('给 DeepSeek 发送消息').fill('继续修复');
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
  page.once('dialog', dialog => void dialog.accept());
  await page.getByRole('button', { name: '接管图形对话' }).click();
  await expect.poll(() => app.starts.length).toBe(1);
  expect(app.starts[0]).toEqual({ mode: 'chat', handoff: true });
  expect(app.sends).toHaveLength(0);
});

test('dsh native model and permission choices are selectable', async ({ page }) => {
  const app = await fixture(page);
  await page.getByRole('button', { name: '选择原生模型' }).click();
  const model = page.getByLabel('原生模型', { exact: true });
  await expect(model).toBeEnabled();
  await expect(model).toContainText('deepseek-v4-pro');
  await model.selectOption('discover/deepseek-v4-pro');
  await page.getByRole('button', { name: '应用模型' }).click();
  await expect.poll(() => app.settingUpdates.length).toBe(1);
  expect(app.settingUpdates[0]).toMatchObject({ version: 'settings-1', field: 'model', value: 'discover/deepseek-v4-pro' });

  await page.getByRole('button', { name: '选择原生权限' }).click();
  const permission = page.getByLabel('原生权限', { exact: true });
  await expect(permission).toBeEnabled();
  await permission.selectOption('read-only');
  await page.getByRole('button', { name: '应用权限' }).click();
  await expect.poll(() => app.settingUpdates.length).toBe(2);
  expect(app.settingUpdates[1]).toMatchObject({ field: 'permission', value: 'read-only' });
});

test('dsh takeover stays disabled while the TUI task is running', async ({ page }) => {
  await fixture(page, undefined, { status: 'running', executionTransport: 'pty' });
  const button = page.getByRole('button', { name: '任务结束后可接管' });
  await expect(button).toBeDisabled();
  await expect(page.getByRole('button', { name: '接管图形对话' })).toHaveCount(0);
});

test('a new contact opens in the graphical view while a native click stays with that contact', async ({ page }) => {
  const app = await fixture(page, undefined, {}, ['第二个 DeepSeek']);
  const second = app.extras[0]!;
  const graphical = page.getByRole('button', { name: '图形对话', exact: true });
  // This fixture has no nativeUrl, so the native view is labelled as the terminal.
  const nativeView = page.getByRole('button', { name: '原生终端', exact: true });
  await expect(graphical).toHaveAttribute('aria-pressed', 'true');
  await nativeView.click();
  await expect(nativeView).toHaveAttribute('aria-pressed', 'true');
  // The explicit choice belongs to this contact and survives a reload.
  await page.reload();
  await expect(nativeView).toHaveAttribute('aria-pressed', 'true');
  // A different contact on the same backend still starts graphical.
  await page.evaluate(id => { location.hash = `#/contacts?session=${id}`; }, second.id);
  await expect(page.getByRole('heading', { name: '第二个 DeepSeek', exact: true }).last()).toBeVisible();
  await expect(page.getByRole('button', { name: '图形对话', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: '原生终端', exact: true })).toHaveAttribute('aria-pressed', 'false');
});
