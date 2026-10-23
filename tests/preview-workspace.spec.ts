import { expect } from '@playwright/test';
import { test, mutationHeaders } from './fixtures';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AppState, Session } from '../shared/types';

// HTML comes from a local route fixture; no external site or model is used.
test('web tabs preserve independent pages, note drafts and focus through hide, switch and close', async ({ page, request }) => {
  await page.route('**/preview-fixture/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><label>Page value<input aria-label="Page value"></label>' }));
  await page.goto('/');
  await page.getByRole('button', { name: '打开网页服务', exact: true }).click();
  const panel = page.getByRole('complementary', { name: '统一预览面板', exact: true });
  const tabs = panel.getByRole('tab');
  const website = page.getByRole('complementary', { name: '网页服务', exact: true });
  await website.getByRole('textbox', { name: '服务地址' }).fill(`${new URL(page.url()).origin}/preview-fixture/first`);
  await website.getByRole('button', { name: '打开', exact: true }).click();
  const firstFrame = panel.locator('iframe').first();
  const handle = await firstFrame.elementHandle();
  await firstFrame.contentFrame().getByRole('textbox').fill('first page state');
  await panel.locator('summary[aria-label="新建预览标签"]').click();
  await panel.getByRole('button', { name: '新网页', exact: true }).click();
  await website.getByRole('textbox', { name: '服务地址' }).fill(`${new URL(page.url()).origin}/preview-fixture/second`);
  await website.getByRole('button', { name: '打开', exact: true }).click();
  await panel.locator('iframe').last().contentFrame().getByRole('textbox').fill('second page state');
  await expect(tabs).toHaveCount(2);
  await tabs.first().click();
  await expect(firstFrame.contentFrame().getByRole('textbox')).toHaveValue('first page state');
  expect(await handle!.evaluate(element => element.isConnected)).toBe(true);
  await page.getByRole('button', { name: '打开随手记', exact: true }).click();
  const note = page.getByRole('complementary', { name: '随手记', exact: true });
  await note.getByRole('button', { name: '源码', exact: true }).click();
  await note.getByRole('textbox').fill('# 跨标签保存的笔记');
  const editor = await note.getByRole('textbox').elementHandle();
  await tabs.first().click();
  await expect.poll(async () => (await (await request.get('/api/scratchpad')).json()).content).toBe('# 跨标签保存的笔记');
  await panel.getByRole('tab', { name: '随手记', exact: true }).click();
  expect(await editor!.evaluate(element => element.isConnected)).toBe(true);
  await panel.getByRole('button', { name: '隐藏预览面板' }).click();
  await expect(panel).toBeHidden();
  await page.getByRole('button', { name: '打开预览面板' }).click();
  await expect(note.getByRole('textbox')).toHaveValue('# 跨标签保存的笔记');
  await tabs.first().focus(); await page.keyboard.press('End');
  await expect(panel.getByRole('tab', { name: '随手记', exact: true })).toBeFocused();
  await page.keyboard.press('Delete');
  await expect(tabs).toHaveCount(2);
  await expect(tabs.last()).toBeFocused();
  await expect(panel.locator('iframe').last().contentFrame().getByRole('textbox')).toHaveValue('second page state');
  await page.reload();
  await expect(tabs).toHaveCount(2);
  await expect(website.getByRole('textbox', { name: '服务地址' })).toHaveValue(/preview-fixture\/second$/);
  await tabs.last().focus(); await page.keyboard.press('Delete');
  await expect(tabs).toHaveCount(1);
  await expect(tabs.first()).toBeFocused();
  await page.keyboard.press('Delete');
  await expect(panel).toBeHidden();
  await expect(page.getByRole('button', { name: '打开预览面板' })).toBeFocused();
});

test('files stay bound to their original workspace and stale workspaces cannot read a changed directory', async ({ page, request }) => {
  const directories = await Promise.all([mkdtemp(join(tmpdir(), 'dili-source-a-')), mkdtemp(join(tmpdir(), 'dili-source-b-'))]);
  try {
    const sessions: Session[] = [];
    for (const [index, cwd] of directories.entries()) {
      await writeFile(join(cwd, 'same.md'), `# Workspace ${index + 1}`);
      const response = await request.post('/api/sessions', { headers: await mutationHeaders(request), data: { backend: 'codex', title: `固定工作区 ${index + 1}`, cwd } });
      expect(response.ok()).toBe(true); sessions.push(await response.json());
    }
    await page.goto('/');
    const panel = page.getByRole('complementary', { name: '统一预览面板', exact: true });
    for (const [index, session] of sessions.entries()) {
      await page.getByRole('button', { name: `进入 ${session.title} 的会话`, exact: true }).click();
      await page.getByRole('button', { name: '打开资源管理器', exact: true }).click();
      await panel.getByRole('complementary', { name: '资源管理器', exact: true }).getByRole('button', { name: /same\.md/ }).click();
      await expect(panel.getByRole('heading', { name: `Workspace ${index + 1}`, exact: true })).toBeVisible();
    }
    await expect(panel.getByRole('tab', { name: /^文件 · 固定工作区/ })).toHaveCount(2);
    await panel.getByRole('tab', { name: /^文件 · 固定工作区/ }).first().click();
    await expect(panel.getByRole('heading', { name: 'Workspace 1', exact: true })).toBeVisible();
    await page.reload();
    await expect(panel.getByRole('heading', { name: 'Workspace 1', exact: true })).toBeVisible();
    // cwd is immutable through today's UI. Replay a future/imported state
    // change to verify that restored tabs still reject a mismatched source.
    const state = await (await request.get('/api/state')).json() as AppState;
    state.sessions.find(item => item.id === sessions[0].id)!.cwd = directories[1];
    await page.route('**/api/state', route => route.fulfill({ json: state }));
    await page.route('**/api/events', route => route.fulfill({ contentType: 'text/event-stream', body: `retry: 60000\nevent: state\ndata: ${JSON.stringify(state)}\n\n` }));
    await page.reload();
    await expect(panel.getByRole('tabpanel').getByText('原工作区已移除或目录已改变。')).toBeVisible();
    await expect(panel.getByRole('heading', { name: 'Workspace 2', exact: true })).toBeHidden();
    await panel.getByRole('tab', { name: /^文件 · 固定工作区/ }).last().click();
    await expect(panel.getByRole('heading', { name: 'Workspace 2', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '切换主题', exact: true }).click();
    const appearance = page.getByRole('dialog', { name: '外观主题', exact: true });
    await appearance.getByRole('slider', { name: '界面缩放', exact: true }).fill('200');
    await appearance.getByRole('button', { name: '完成', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(panel.getByRole('button', { name: '返回工作台' })).toBeInViewport();
    await expect(panel.getByRole('tab').last()).toBeInViewport();
    await panel.getByRole('tab').first().focus(); await page.keyboard.press('End');
    await expect(panel.getByRole('tab').last()).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  } finally { await Promise.all(directories.map(path => rm(path, { recursive: true, force: true }))); }
});

test('switching from a pending file and retrying another file cannot mix their results', async ({ page, request }) => {
  const cwd = await mkdtemp(join(tmpdir(), 'dili-preview-requests-'));
  let finishFirst: () => void = () => {};
  const releaseFirst = new Promise<void>(resolve => { finishFirst = resolve; });
  let firstStarted: () => void = () => {};
  const requestedFirst = new Promise<void>(resolve => { firstStarted = resolve; });
  try {
    await writeFile(join(cwd, 'a.md'), '# First');
    await writeFile(join(cwd, 'b.md'), '# Second');
    const response = await request.post('/api/sessions', { headers: await mutationHeaders(request), data: { backend: 'codex', title: '独立文件请求', cwd } });
    expect(response.ok()).toBe(true);
    const session = await response.json() as Session;
    let secondAttempts = 0;
    await page.route(`**/api/sessions/${session.id}/workspace/file?*`, async route => {
      const path = new URL(route.request().url()).searchParams.get('path');
      if (path === 'a.md') {
        firstStarted(); await releaseFirst;
        await route.fulfill({ json: { path, content: '# First', binary: false, truncated: false, size: 7 } });
      } else if (++secondAttempts === 1) await route.fulfill({ status: 503, json: { error: '暂时读取失败' } });
      else await route.fulfill({ json: { path, content: '# Second', binary: false, truncated: false, size: 8 } });
    });
    await page.goto('/');
    await page.getByRole('button', { name: `进入 ${session.title} 的会话`, exact: true }).click();
    await page.getByRole('button', { name: '打开资源管理器', exact: true }).click();
    const panel = page.getByRole('complementary', { name: '统一预览面板', exact: true });
    const explorer = panel.getByRole('complementary', { name: '资源管理器', exact: true });
    await explorer.getByRole('button', { name: /^a\.md/ }).click();
    await requestedFirst;
    await explorer.getByRole('button', { name: /^b\.md/ }).click();
    await expect(panel.getByRole('alert')).toContainText('暂时读取失败');
    await panel.getByRole('button', { name: '重试', exact: true }).click();
    await expect(panel.getByRole('heading', { name: 'Second', exact: true })).toBeVisible();
    const firstFinished = page.waitForResponse(response => response.url().includes('path=a.md'));
    finishFirst(); await firstFinished;
    await expect(panel.getByRole('heading', { name: 'First', exact: true })).toHaveCount(0);
    await expect(panel.getByRole('heading', { name: 'Second', exact: true })).toBeVisible();
    await expect(panel.getByRole('tab')).toHaveCount(1);
  } finally { finishFirst(); await rm(cwd, { recursive: true, force: true }); }
});

test('previous standalone file tabs migrate into one workspace and retain the active file', async ({ page, request }) => {
  const cwd = await mkdtemp(join(tmpdir(), 'dili-preview-migration-'));
  try {
    await writeFile(join(cwd, 'first.md'), '# Earlier file');
    await writeFile(join(cwd, 'active.md'), '# Active migrated file');
    const response = await request.post('/api/sessions', { headers: await mutationHeaders(request), data: { backend: 'codex', title: '旧标签迁移', cwd } });
    expect(response.ok()).toBe(true);
    const session = await response.json() as Session;
    await page.addInitScript(({ sessionId, cwd }) => {
      if (localStorage.getItem('migration-seeded')) return;
      const source = { sessionId, cwd };
      localStorage.setItem('dili.preview-workspace:/', JSON.stringify({ tabs: [
        { ...source, id: 'old-explorer', kind: 'explorer' },
        { ...source, id: 'old-first', kind: 'file', path: 'first.md' },
        { id: 'scratchpad', kind: 'note' },
        { ...source, id: 'old-active', kind: 'file', path: 'active.md' },
        { id: 'web:old', kind: 'web', url: '' },
      ], activeId: 'old-active', open: true }));
      localStorage.setItem('migration-seeded', 'true');
    }, { sessionId: session.id, cwd });
    await page.goto('/');
    const panel = page.getByRole('complementary', { name: '统一预览面板', exact: true });
    await expect(panel.getByRole('tab')).toHaveCount(3);
    await expect(panel.getByRole('heading', { name: 'Active migrated file', exact: true })).toBeVisible();
    await expect(panel.locator('.workspace-list-pane')).toBeVisible();
    await panel.getByRole('button', { name: '收起目录', exact: true }).click();
    await page.reload();
    await expect(panel.locator('.workspace-list-pane')).toBeHidden();
    await expect(panel.getByRole('heading', { name: 'Active migrated file', exact: true })).toBeVisible();
    await panel.getByRole('button', { name: '展开目录', exact: true }).click();
    await panel.getByRole('button', { name: '关闭文件预览', exact: true }).click();
    await expect(panel.getByText('选择文件以预览内容')).toBeVisible();
    await expect(panel.locator('.workspace-list-pane')).toBeVisible();
    await expect(panel.getByRole('tab')).toHaveCount(3);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
