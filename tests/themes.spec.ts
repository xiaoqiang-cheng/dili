import { expect } from '@playwright/test';
import { test, mutationHeaders } from './fixtures';
import type { Scratchpad } from '../shared/scratchpad';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session } from '../shared/types';

test('theme picker colors the entire workbench and native terminal live, with persistence', async ({ page, request }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  const initial = await (await request.get('/api/scratchpad')).json() as Scratchpad;
  expect((await request.patch('/api/scratchpad', { headers: await mutationHeaders(request), data: { ...initial, content: '# 工作清单\n\n- [ ] 验证新主题\n- [x] 随手记录想法\n\n```ts\nconst theme = "dark";\n```' } })).ok()).toBe(true);
  let connections = 0;
  page.on('websocket', socket => { if (socket.url().includes('/api/terminal/')) connections++; });
  await page.goto('/');
  await page.getByRole('button', { name: '进入 Dili · 开发笔记 的会话', exact: true }).click();
  await expect(page.locator('.terminal-connection.connected')).toHaveCount(1);
  const terminal = page.locator('.xterm');
  const handle = await terminal.elementHandle();
  const count = connections;
  await page.getByRole('button', { name: '打开随手记', exact: true }).click();
  const note = page.getByRole('complementary', { name: '随手记', exact: true });
  await expect(note.getByRole('textbox')).toBeEnabled();
  await note.getByRole('button', { name: '预览', exact: true }).click();
  for (const [name, theme, color] of [
    ['沉静深色', 'dark', 'rgb(25, 29, 36)'],
    ['午夜靛蓝', 'midnight', 'rgb(17, 24, 39)'],
    ['终端黑绿', 'terminal', 'rgb(11, 16, 13)'],
    ['高对比度', 'contrast', 'rgb(0, 0, 0)'],
    ['柔和暖色', 'warm', 'rgb(255, 253, 248)'],
    ['简洁浅色', 'light', 'rgb(255, 255, 255)'],
  ]) {
    await page.getByRole('button', { name: '切换主题', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '外观主题', exact: true });
    const option = dialog.getByRole('radio', { name: new RegExp(name) });
    await option.click();
    await expect(option).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(note).toHaveCSS('background-color', color);
    await expect(terminal.locator('.xterm-scrollable-element')).toHaveCSS('background-color', color);
    await dialog.getByRole('button', { name: '完成', exact: true }).click();
    await page.screenshot({ path: `artifacts/workbench-theme-${theme}.png` });
  }
  expect(connections).toBe(count);
  expect(await handle!.evaluate(element => element.isConnected)).toBe(true);
  await page.getByRole('button', { name: '切换主题', exact: true }).click();
  await page.getByRole('radio', { name: /沉静深色/ }).click();
  await page.getByRole('button', { name: '完成', exact: true }).click();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(note).toHaveCSS('background-color', 'rgb(25, 29, 36)');
  await note.getByRole('button', { name: '源码', exact: true }).click();
  await expect(note.getByRole('textbox')).toHaveValue(/工作清单/);
});

test('system preference follows OS changes; a manual choice stays fixed and synchronizes across tabs', async ({ page, context }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: '切换主题', exact: true }).click();
  await page.getByRole('radio', { name: /柔和暖色/ }).click();
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'warm');
  const second = await context.newPage();
  await second.goto('/');
  await expect(second.locator('html')).toHaveAttribute('data-theme', 'warm');
  await page.getByRole('radio', { name: /简洁浅色/ }).click();
  await expect(second.locator('html')).toHaveAttribute('data-theme', 'light');
  // Keyboard navigation selects the next radio and applies it immediately.
  await page.getByRole('radio', { name: /简洁浅色/ }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('radio', { name: /柔和暖色/ })).toHaveAttribute('aria-checked', 'true');
  await second.close();
});

test('mobile theme controls stay reachable from contacts and from a session', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: '更多', exact: true }).click();
  await page.getByRole('menuitem', { name: '外观主题' }).click();
  const dialog = page.getByRole('dialog', { name: '外观主题', exact: true });
  await dialog.getByRole('radio', { name: /沉静深色/ }).click();
  await page.screenshot({ path: 'artifacts/theme-picker-mobile.png' });
  await dialog.getByRole('button', { name: '完成', exact: true }).click();
  await page.getByRole('button', { name: '进入 Dili · 开发笔记 的会话', exact: true }).click();
  await page.locator('summary').filter({ hasText: '会话信息' }).click();
  await page.getByRole('button', { name: '随手记', exact: true }).click();
  const note = page.getByRole('complementary', { name: '随手记', exact: true });
  await expect(note).toBeVisible();
  await expect(note).toHaveCSS('background-color', 'rgb(25, 29, 36)');
  await note.getByRole('button', { name: '预览', exact: true }).click();
  await page.screenshot({ path: 'artifacts/scratchpad-mobile-dark.png' });
  await note.getByRole('button', { name: '关闭随手记' }).click();
  await page.getByRole('button', { name: '外观主题', exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('radio', { name: /沉静深色/ })).toHaveAttribute('aria-checked', 'true');
});

test('dark theme keeps file, Git and note tabs readable in one preview panel', async ({ page, request }) => {
  const directory = await mkdtemp(join(tmpdir(), 'sessiondeck-theme-preview-'));
  const git = (args: string[]) => promisify(execFile)('git', args, { cwd: directory });
  try {
    await writeFile(join(directory, 'README.md'), '# Theme preview\n\n```ts\nconst theme = "light";\n```\n');
    await git(['init', '-q']); await git(['add', '.']);
    await git(['-c', 'user.name=Theme test', '-c', 'user.email=theme@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'initial']);
    await writeFile(join(directory, 'README.md'), '# Theme preview\n\n```ts\nconst theme = "dark";\n```\n');
    const response = await request.post('/api/sessions', { headers: await mutationHeaders(request), data: { title: '主题预览验收', backend: 'codex', cwd: directory } });
    expect(response.ok()).toBe(true); const session = await response.json() as Session;
    await page.setViewportSize({ width: 1900, height: 1000 });
    await page.goto('/');
    await page.getByRole('button', { name: '切换主题', exact: true }).click();
    await page.getByRole('radio', { name: /沉静深色/ }).click();
    await page.getByRole('button', { name: '完成', exact: true }).click();
    await page.getByRole('button', { name: `进入 ${session.title} 的会话`, exact: true }).click();
    await page.getByRole('button', { name: '打开资源管理器', exact: true }).click();
    const explorer = page.getByRole('complementary', { name: '资源管理器', exact: true });
    await explorer.getByRole('button', { name: /README\.md/ }).click();
    const panel = page.getByRole('complementary', { name: '统一预览面板', exact: true });
    await expect(panel.getByRole('heading', { name: 'Theme preview' })).toBeVisible();
    await expect(panel.locator('.markdown-code')).toHaveCSS('background-color', 'rgb(32, 37, 46)');
    await expect(panel.locator('.hljs-keyword')).toHaveCSS('color', 'rgb(255, 172, 181)');
    await panel.getByRole('tab', { name: `文件 · ${session.title}`, exact: true }).click();
    await explorer.getByRole('button', { name: /^Git diff/ }).click();
    await explorer.getByRole('button', { name: /README\.md/ }).click();
    await expect(panel.locator('td.diff-code.diff-added')).toHaveCSS('background-color', 'rgb(30, 53, 40)');
    await expect(panel.locator('td.diff-code.diff-removed')).toHaveCSS('background-color', 'rgb(58, 37, 41)');
    await expect(panel.locator('td.diff-code.diff-added')).toHaveCSS('color', 'rgb(225, 231, 239)');
    await page.getByRole('button', { name: '打开随手记', exact: true }).click();
    const note = page.getByRole('complementary', { name: '随手记', exact: true });
    await expect(note).toBeVisible();
    await expect(explorer).toBeHidden();
    await expect(panel.getByRole('tab')).toHaveCount(2);
    await expect(note.getByRole('textbox')).toBeVisible();
    await page.screenshot({ path: 'artifacts/workbench-dark-explorer.png' });
    await page.setViewportSize({ width: 1440, height: 1000 });
    const main = page.locator('.app-main');
    const widthWithNote = (await main.boundingBox())!.width;
    await note.getByRole('button', { name: '关闭随手记' }).click();
    await expect(panel.getByRole('tab', { name: `文件 · ${session.title}`, exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(panel.locator('td.diff-code.diff-added')).toBeVisible();
    expect(Math.abs((await main.boundingBox())!.width - widthWithNote)).toBeLessThan(1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('interface zoom slider applies 100–200%, persists and synchronizes without reconnecting terminals', async ({ page, context }) => {
  let connections = 0;
  page.on('websocket', socket => { if (socket.url().includes('/api/terminal/')) connections++; });
  const seed = await (await page.request.get('/api/state')).json();
  const response = await page.request.post('/api/sessions', { headers: await mutationHeaders(page.request), data: { backend: 'codex', title: '缩放独立终端验收', cwd: seed.defaultCwd } });
  expect(response.ok()).toBe(true);
  await page.goto('/');
  await page.getByRole('button', { name: '进入 缩放独立终端验收 的会话', exact: true }).click();
  await expect(page.locator('.terminal-connection.connected')).toHaveCount(1);
  const terminal = await page.locator('.xterm').elementHandle();
  const count = connections;
  const originalWidth = (await page.locator('.xterm-screen').boundingBox())!.width;
  await page.getByRole('button', { name: '切换主题', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '外观主题', exact: true });
  const slider = dialog.getByRole('slider', { name: '界面缩放', exact: true });
  await expect(slider).toHaveValue('100');
  for (const value of [125, 150, 175, 200]) {
    await slider.fill(String(value));
    await expect(dialog.locator('output')).toHaveText(`${value}%`);
    await expect(page.locator('html')).toHaveAttribute('data-interface-zoom', String(value));
    await expect.poll(() => page.locator('.app-shell').evaluate(element => Math.abs(element.getBoundingClientRect().height - innerHeight))).toBeLessThan(2);
    await expect(slider).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  }
  await slider.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(slider).toHaveValue('199');
  await slider.fill('150');
  const second = await context.newPage();
  await second.goto('/');
  await expect(second.locator('html')).toHaveAttribute('data-interface-zoom', '150');
  await slider.fill('200');
  await expect(second.locator('html')).toHaveAttribute('data-interface-zoom', '200');
  await second.close();
  await dialog.getByRole('button', { name: '完成', exact: true }).click();
  await expect(page.locator('.terminal-connection.connected')).toHaveCount(1);
  expect(await terminal!.evaluate(element => element.isConnected)).toBe(true);
  expect(connections).toBe(count);
  expect((await page.locator('.xterm-screen').boundingBox())!.width).toBeLessThanOrEqual(originalWidth + 20);
  const separator = page.getByRole('separator', { name: '调整联系人列表宽度', exact: true });
  const beforeWidth = Number(await separator.getAttribute('aria-valuenow'));
  const bounds = (await separator.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 30);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 40, bounds.y + 30, { steps: 5 });
  await page.mouse.up();
  await expect(separator).toHaveAttribute('aria-valuenow', String(beforeWidth + 20));
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.insertText('ZOOM_COPY_CHECK');
  await page.keyboard.press('Enter');
  const targetRow = page.locator('.xterm-rows>div').filter({ hasText: 'ZOOM_COPY_CHECK' }).last();
  await expect(targetRow).toBeVisible();
  const row = (await targetRow.boundingBox())!;
  await page.mouse.click(row.x + 60, row.y + row.height / 2, { clickCount: 3 });
  await page.getByRole('button', { name: '会话工具', exact: true }).click();
  await page.getByRole('button', { name: '复制选中的终端内容', exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('ZOOM_COPY_CHECK');
  await page.screenshot({ path: 'artifacts/interface-zoom-200.png' });
  await page.getByRole('button', { name: '打开终端', exact: true }).click();
  const dock = page.getByRole('region', { name: '底部终端面板', exact: true });
  await expect(dock.locator('.terminal-connection.connected')).toHaveCount(1);
  const resizer = dock.getByRole('separator', { name: '调整终端面板高度', exact: true });
  const heightBefore = Number(await resizer.getAttribute('aria-valuenow'));
  const drag = (await resizer.boundingBox())!;
  await page.mouse.move(drag.x + drag.width / 2, drag.y + drag.height / 2);
  await page.mouse.down();
  await page.mouse.move(drag.x + drag.width / 2, drag.y + drag.height / 2 + 40, { steps: 5 });
  await page.mouse.up();
  await expect(resizer).toHaveAttribute('aria-valuenow', String(heightBefore - 20));
  const shellInput = dock.locator('.xterm-helper-textarea');
  await shellInput.focus(); await page.keyboard.insertText('printf ZOOM_SHELL_OK'); await page.keyboard.press('Enter');
  await expect(dock.locator('.xterm-rows')).toContainText('ZOOM_SHELL_OK');
  await dock.locator('.terminal-dock-tab-close').last().click();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-interface-zoom', '200');
  await page.getByRole('button', { name: '切换主题', exact: true }).click();
  await dialog.getByRole('button', { name: '恢复 100%', exact: true }).click();
  await expect(slider).toHaveValue('100');
  await expect(page.locator('html')).toHaveAttribute('data-interface-zoom', '100');
});

test('zoom is available in settings and remains adjustable at 200% on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/backends');
  const settings = page.getByRole('region', { name: '界面缩放设置', exact: true });
  const slider = settings.getByRole('slider', { name: '界面缩放', exact: true });
  await expect(slider).toHaveValue('100');
  await slider.fill('200');
  await expect(page.locator('html')).toHaveAttribute('data-interface-zoom', '200');
  await expect(slider).toBeInViewport();
  await settings.getByRole('button', { name: '恢复 100%', exact: true }).click();
  await expect(slider).toHaveValue('100');
  await page.getByRole('button', { name: '更多', exact: true }).click();
  await page.getByRole('menuitem', { name: '外观主题', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '外观主题', exact: true });
  await dialog.getByRole('slider', { name: '界面缩放', exact: true }).fill('200');
  await expect(dialog.getByRole('slider')).toBeInViewport();
  await expect(dialog.getByRole('button', { name: '恢复 100%', exact: true })).toBeInViewport();
  await page.screenshot({ path: 'artifacts/interface-zoom-mobile.png', animations: 'disabled' });
  await dialog.getByRole('button', { name: '恢复 100%', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-interface-zoom', '100');
});

test('invalid saved zoom falls back safely and valid scaling applies before the workspace mounts', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('dili.interface-zoom', '900'));
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-interface-zoom', '100');
  await page.evaluate(() => { localStorage.setItem('dili.interface-zoom', '175'); dispatchEvent(new StorageEvent('storage', { key: 'dili.interface-zoom' })); });
  await expect(page.locator('html')).toHaveAttribute('data-interface-zoom', '175');
  await page.evaluate(() => { localStorage.removeItem('dili.interface-zoom'); dispatchEvent(new StorageEvent('storage', { key: 'dili.interface-zoom' })); });
  await expect(page.locator('html')).toHaveAttribute('data-interface-zoom', '100');
});
