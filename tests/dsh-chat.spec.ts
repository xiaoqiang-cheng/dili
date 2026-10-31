import { test, expect, type Page } from '@playwright/test';
import type { AppState, Session } from '../shared/types';
import type { AgentChatSnapshot } from '../shared/chat';

const id = 'dsh-chat-contact';
const native = 'session-22222222-2222-4222-8222-222222222222';

async function fixture(page: Page, initial?: Partial<AgentChatSnapshot>) {
  const seed = await (await page.request.get('/api/state')).json() as AppState;
  const contact: Session = { ...seed.sessions[0], id, backend: 'dsh', title: 'DeepSeek 图形对话', cwd: '/workspace/demo', running: true, status: 'idle', statusSource: 'native', nativeSessionId: native, forkPending: false, interactionMode: 'terminal', executionTransport: 'web' };
  const state: AppState = { ...seed, demo: false, sessions: [contact], groups: [], activities: [], backends: seed.backends.map(item => item.id === 'dsh' ? { ...item, installed: true, version: '0.2.0-rc.2', capabilities: { ...item.capabilities, terminal: true, graphicalChat: true } } : item) };
  let snapshot: AgentChatSnapshot = {
    instanceId: 'fixture-instance', nativeSessionId: native, revision: 1, connected: true, activeTurnId: null,
    items: [{ id: 'u1', type: 'user', text: '检查登录', status: 'completed' }, { id: 'a1', type: 'assistant', text: '登录流程已经检查。', status: 'completed' }],
    requests: [], truncated: false, historyCursor: null, ...initial,
  };
  const starts: string[] = [], sends: Record<string, unknown>[] = [], answers: Record<string, unknown>[] = [];
  await page.addInitScript(() => {
    localStorage.setItem('sessiondeck.private-view.dsh', 'chat');
    const sources: EventTarget[] = [];
    Object.assign(window, { dshChatSources: sources });
    class Source extends EventTarget { onopen: (() => void) | null = null; onerror: (() => void) | null = null; constructor() { super(); sources.push(this); queueMicrotask(() => this.onopen?.()); } close() { sources.splice(sources.indexOf(this), 1); } }
    Object.defineProperty(window, 'EventSource', { value: Source });
  });
  await page.route('**/api/state', route => route.fulfill({ json: state }));
  await page.route('**/api/config', route => route.fulfill({ json: { csrfToken: 'test-token' } }));
  await page.route('**/api/sessions/' + id + '/read', route => route.fulfill({ json: contact }));
  await page.route('**/api/sessions/' + id + '/start', async route => {
    starts.push((route.request().postDataJSON() as { mode?: string }).mode ?? 'terminal');
    return route.fulfill({ json: { ...contact, interactionMode: 'chat', executionTransport: 'web' } });
  });
  await page.route('**/api/sessions/' + id + '/chat/settings', route => route.fulfill({ json: { nativeSessionId: native, version: 'dsh', model: null, models: [], permission: null, permissions: [], disabledReason: '由原生界面管理', scope: '原生界面' } }));
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
  await page.route('**/api/sessions/' + id + '/chat', route => route.fulfill({ json: snapshot }));
  await page.goto('/#/contacts?session=' + id);
  await expect(page.getByRole('region', { name: 'DeepSeek 图形会话' })).toBeVisible();
  return { contact, snapshot: () => snapshot, starts, sends, answers };
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
  expect(app.starts).toEqual(['chat']);
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
