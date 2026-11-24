import { expect, type Page } from '@playwright/test';
import { mutationHeaders, test } from './fixtures';
import type { AppState, DiscoveredSession, Session } from '../shared/types';

async function openImport(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: '新建', exact: true }).click();
  await page.getByRole('menuitem', { name: '导入已有对话', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '导入已有对话', exact: true });
  await dialog.getByRole('button', { name: /Codex/ }).click();
  return dialog;
}

for (const availability of [false, undefined]) {
  test(`imports recover a removed directory (${availability === false ? 'discovery warning' : 'older server response'})`, async ({ page }) => {
    const state = await (await page.request.get('/api/state')).json() as AppState;
    const nativeSessionId = `demo-import-moved-${availability === false ? 'warning' : 'fallback'}`;
    const candidate: DiscoveredSession = {
      backend: 'codex', nativeSessionId, title: `迁移会话 ${nativeSessionId}`, cwd: `${state.defaultCwd}/missing-import-directory`,
      lastActivity: new Date().toISOString(), cwdAvailable: availability,
    };
    const imports: Record<string, unknown>[] = [];
    await page.route('**/api/discover?backend=*', route => route.fulfill({ json: { sessions: [candidate] } }));
    page.on('request', request => { if (request.url().endsWith('/api/import') && request.method() === 'POST') imports.push(request.postDataJSON()); });
    const dialog = await openImport(page);
    await dialog.getByLabel('搜索可导入对话').fill('迁移会话');
    await dialog.getByLabel('搜索可导入对话').press('Enter');
    expect(imports).toHaveLength(0);
    await dialog.getByRole('button', { name: availability === false ? '选择目录' : '添加', exact: true }).click();
    await expect(dialog.getByLabel('导入工作目录', { exact: true })).toBeVisible();
    if (availability === undefined) await expect(dialog.getByRole('alert')).toContainText('请选择现有目录');
    await dialog.getByLabel('导入工作目录', { exact: true }).fill(state.defaultCwd);
    await dialog.getByRole('button', { name: '添加', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole('dialog', { name: `${candidate.title} 的私聊` })).toBeVisible();
    await expect(page.getByRole('button', { name: '停止进程', exact: true })).toBeVisible();
    const imported = (await (await page.request.get('/api/state')).json() as AppState).sessions.filter(session => session.nativeSessionId === nativeSessionId);
    expect(imported).toHaveLength(1);
    expect(imported[0].cwd).toBe(state.defaultCwd);
    expect(imports.at(-1)?.nativeSessionId).toBe(nativeSessionId);
  });
}

test('discovery failures offer retry instead of claiming the native history is empty', async ({ page }) => {
  let attempts = 0;
  await page.route('**/api/discover?backend=codex', route => {
    attempts++;
    return attempts === 1
      ? route.fulfill({ status: 503, json: { error: '历史发现暂时不可用' } })
      : route.fulfill({ json: { sessions: [{ backend: 'codex', nativeSessionId: 'demo-retry-import', title: '重试后的历史', cwd: '/workspace', lastActivity: new Date().toISOString() }] } });
  });
  const dialog = await openImport(page);
  await expect(dialog.getByRole('alert')).toHaveText('历史发现暂时不可用');
  await expect(dialog.getByText('尚未发现 Codex 会话')).not.toBeVisible();
  await dialog.getByRole('button', { name: '重新发现' }).click();
  await expect(dialog.getByText('重试后的历史')).toBeVisible();
});

test('an imported Codex owned by another client offers native fork and resume retry', async ({ page }) => {
  const initial = await (await page.request.get('/api/state')).json() as AppState;
  const headers = await mutationHeaders(page.request);
  const response = await page.request.post('/api/import', { headers, data: {
    backend: 'codex', nativeSessionId: 'demo-busy-import', title: '被原生客户端占用的历史', cwd: initial.defaultCwd,
  } });
  expect(response.ok()).toBeTruthy();
  const original = await response.json() as Session;
  const busy: Session = { ...original, status: 'error', errorCode: 'NATIVE_SESSION_BUSY', statusDetail: '其他原生客户端占用', running: false };
  const state = { ...initial, sessions: [...initial.sessions, busy] };
  await page.route('**/api/state', route => route.fulfill({ json: state }));
  await page.route('**/api/events', route => route.fulfill({ contentType: 'text/event-stream', body: `retry: 60000\nevent: state\ndata: ${JSON.stringify(state)}\n\n` }));
  let retries = 0;
  await page.route(`**/api/sessions/${original.id}/start`, route => {
    retries++;
    return route.fulfill({ status: 409, json: { code: 'NATIVE_SESSION_BUSY', error: '其他原生客户端占用' } });
  });
  await page.route(`**/api/sessions/${original.id}/fork`, async route => {
    const result = await route.fetch();
    expect(result.ok()).toBeTruthy();
    state.sessions.push(await result.json() as Session);
    await route.fulfill({ response: result });
  });
  // A bookmarked view reads history without automatically retrying its owner.
  await page.goto(`/#/contacts?session=${original.id}`);
  const drawer = page.getByRole('dialog', { name: `${original.title} 的私聊` });
  await expect(drawer.getByRole('alert')).toContainText('正被其他原生客户端占用');
  expect(retries).toBe(0);
  await drawer.getByRole('button', { name: '重试恢复', exact: true }).click();
  await expect.poll(() => retries).toBe(1);
  await drawer.getByRole('button', { name: 'Fork 后继续', exact: true }).click();
  const fork = page.getByRole('dialog', { name: 'Fork 会话', exact: true });
  await fork.getByLabel('会话名称').fill('独立继续导入上下文');
  await fork.getByRole('button', { name: '创建 Fork', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '独立继续导入上下文 的私聊' })).toBeVisible();
  const after = (await (await page.request.get('/api/state')).json() as AppState).sessions;
  const child = after.find(session => session.parentId === original.id)!;
  expect(child.nativeSessionId).not.toBe(original.nativeSessionId);
  expect(after.find(session => session.id === original.id)?.nativeSessionId).toBe(original.nativeSessionId);
});
