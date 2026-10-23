import { mutationHeaders, test } from './fixtures';
import { expect, type APIRequestContext, type Locator } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppState, Session } from '../shared/types';

async function mutate<T>(request: APIRequestContext, path: string, body: unknown = {}, method = 'POST'): Promise<T> {
  const headers = await mutationHeaders(request);
  const response = await request.fetch(`/api${path}`, { method, data: body, headers });
  expect(response.ok()).toBeTruthy();
  return response.json() as Promise<T>;
}
async function command(pane: Locator, text: string) {
  const input = pane.locator('textarea.xterm-helper-textarea');
  await input.focus();
  await input.pressSequentially(text);
  await input.press('Enter');
}

test('bottom terminal runs real shell commands, isolates split shells and survives hide/reload', async ({ page, request }) => {
  const initial = await (await request.get('/api/shells')).json() as { id: string }[];
  const existing = new Set(initial.map(item => item.id));
  try {
    await page.goto('/');
    await page.getByRole('button', { name: '打开终端', exact: true }).click();
    const dock = page.getByRole('region', { name: '底部终端面板' });
    await expect(dock).toBeVisible();
    await expect(dock.locator('.terminal-connection.connected')).toHaveCount(1);
    await command(dock, `SD_TEST_VALUE=first; printf 'SHELL_RESULT:%s\\n' "$((6 * 7))"`);
    await expect(dock.locator('.xterm-rows')).toContainText('SHELL_RESULT:42');
    await dock.getByRole('button', { name: '终端分屏', exact: true }).click();
    await expect(dock.locator('.terminal-dock-pane')).toHaveCount(2);
    await expect(dock.locator('.terminal-connection.connected')).toHaveCount(2);
    await command(dock.locator('.terminal-dock-pane').first(), `printf 'SECOND_VALUE:%s\\n' "\${SD_TEST_VALUE:-empty}"`);
    await expect(dock.locator('.terminal-dock-pane').first().locator('.xterm-rows')).toContainText('SECOND_VALUE:empty');
    await dock.getByRole('button', { name: '关闭终端分屏', exact: true }).click();
    await dock.getByRole('button', { name: '隐藏终端面板', exact: true }).click();
    await expect(dock).not.toBeVisible();
    await page.reload();
    await page.getByRole('button', { name: '打开终端', exact: true }).click();
    await expect(dock.locator('.terminal-dock-tab')).toHaveCount(2);
    await dock.getByRole('tab').first().click();
    await expect(dock.locator('.terminal-connection.connected')).toHaveCount(1);
    await command(dock, `printf 'RESTORED:%s\\n' "$SD_TEST_VALUE"`);
    await expect(dock.locator('.xterm-rows')).toContainText('RESTORED:first');
    await command(dock, 'sleep 30');
    await dock.locator('textarea.xterm-helper-textarea').press('Control+c');
    await command(dock, `printf 'INTERRUPTED:%s\\n' "$((2 + 3))"`);
    await expect(dock.locator('.xterm-rows')).toContainText('INTERRUPTED:5');
    await page.screenshot({ path: 'artifacts/shell-terminal.png' });
    await dock.locator('.terminal-dock-tab-close').first().click();
    await expect(dock.locator('.terminal-dock-tab')).toHaveCount(1);
    await expect.poll(async () => ((await (await request.get('/api/shells')).json()) as { id: string }[]).filter(item => !existing.has(item.id)).length).toBe(1);
  } finally {
    const shells = await (await request.get('/api/shells')).json() as { id: string }[];
    for (const shell of shells.filter(item => !existing.has(item.id))) await mutate(request, `/shells/${shell.id}`, undefined, 'DELETE');
  }
});

test('workspace keeps its tree beside files and diffs with a collapsible resizable directory', async ({ page, request }) => {
  const root = await mkdtemp(join(tmpdir(), 'sessiondeck-panels-'));
  const git = (args: string[]) => promisify(execFile)('git', args, { cwd: root });
  try {
    await mkdir(join(root, 'docs'));
    await writeFile(join(root, 'README.md'), '# Sidebar preview\n\n**Rendered text**\n');
    await writeFile(join(root, 'docs', 'note.md'), '# Note\n');
    await git(['init', '-q']); await git(['add', '.']);
    await git(['-c', 'user.name=Panel test', '-c', 'user.email=panel@example.invalid', 'commit', '-qm', 'Initial']);
    await writeFile(join(root, 'README.md'), '# Sidebar preview\n\n**Updated content**\n');
    const session = await mutate<Session>(request, '/sessions', { backend: 'codex', title: '文件侧栏验收', cwd: root });
    await page.goto('/');
    await page.getByRole('button', { name: `进入 ${session.title} 的会话`, exact: true }).click();
    const drawer = page.getByRole('dialog', { name: `${session.title} 的私聊` });
    await expect(page.getByRole('complementary', { name: '资源管理器' })).toHaveCount(0);
    await page.getByRole('button', { name: '打开资源管理器', exact: true }).click();
    const panel = page.getByRole('complementary', { name: '统一预览面板' });
    const explorer = page.getByRole('complementary', { name: '资源管理器' });
    await expect(panel).toBeVisible();
    await explorer.getByRole('button', { name: /README\.md/ }).click();
    await expect(panel.getByRole('heading', { name: 'Sidebar preview' })).toBeVisible();
    await expect(panel.getByRole('tab', { name: `文件 · ${session.title}`, exact: true })).toHaveAttribute('aria-selected', 'true');
    const tree = explorer.locator('.workspace-list-pane');
    const preview = explorer.locator('.workspace-combined-preview');
    expect((await tree.boundingBox())!.x + (await tree.boundingBox())!.width).toBeLessThanOrEqual((await preview.boundingBox())!.x);
    const rendered = await panel.getByRole('heading', { name: 'Sidebar preview' }).elementHandle();
    await explorer.getByRole('button', { name: '收起目录', exact: true }).click();
    await expect(tree).toBeHidden();
    await expect(panel.getByRole('heading', { name: 'Sidebar preview' })).toBeVisible();
    await explorer.getByRole('button', { name: '展开目录', exact: true }).click();
    await expect(tree).toBeVisible();
    expect(await rendered!.evaluate(element => element.isConnected)).toBe(true);
    const treeSplitter = explorer.getByRole('separator', { name: '调整文件树宽度', exact: true });
    const treeInitial = Number(await treeSplitter.getAttribute('aria-valuenow'));
    await treeSplitter.press('ArrowRight');
    await expect(treeSplitter).toHaveAttribute('aria-valuenow', String(treeInitial + 24));
    expect((await panel.boundingBox())!.x).toBeGreaterThanOrEqual((await drawer.boundingBox())!.x + (await drawer.boundingBox())!.width - 1);
    await panel.getByRole('tab', { name: `文件 · ${session.title}`, exact: true }).click();
    await explorer.getByRole('button', { name: /README\.md/ }).click();
    await expect(panel.getByRole('tab')).toHaveCount(1);
    await panel.getByRole('tab', { name: `文件 · ${session.title}`, exact: true }).click();
    await explorer.getByRole('button', { name: /^Git diff/ }).click();
    await explorer.getByRole('button', { name: /README\.md/ }).click();
    const diff = panel.locator('.workspace-diff');
    await expect(diff.getByRole('table', { name: '并排差异' })).toBeVisible();
    await expect(diff.locator('.diff-stats')).toHaveText('+1−1');
    await expect(diff.locator('td.diff-code.diff-added')).toHaveText('**Updated content**');
    await expect(diff.locator('td.diff-code.diff-removed')).toHaveText('**Rendered text**');
    await diff.getByRole('button', { name: '内联显示', exact: true }).click();
    await expect(diff.getByRole('table', { name: '内联差异' })).toBeVisible();
    const panelHeight = (await panel.boundingBox())!.height;
    await page.getByRole('button', { name: '打开终端', exact: true }).click();
    const dock = page.getByRole('region', { name: '底部终端面板' });
    await expect(dock).toBeVisible();
    expect(Math.abs((await panel.boundingBox())!.height - panelHeight)).toBeLessThan(2);
    expect((await dock.boundingBox())!.x + (await dock.boundingBox())!.width).toBeLessThanOrEqual((await panel.boundingBox())!.x + 1);
    await dock.getByRole('button', { name: '隐藏终端面板', exact: true }).click();
    const splitter = panel.getByRole('separator', { name: '调整预览面板宽度' });
    const initial = Number(await splitter.getAttribute('aria-valuenow'));
    await splitter.focus(); await splitter.press('ArrowLeft');
    await expect(splitter).toHaveAttribute('aria-valuenow', String(initial + 24));
    await page.reload();
    await expect(panel.getByRole('tab')).toHaveCount(1);
    await expect(treeSplitter).toHaveAttribute('aria-valuenow', String(treeInitial + 24));
    await expect(splitter).toHaveAttribute('aria-valuenow', String(initial + 24));
    await expect(diff.getByRole('table', { name: '内联差异' })).toBeVisible();
    await page.getByRole('button', { name: '隐藏预览面板' }).click();
    await expect(panel).toBeHidden();
    await page.getByRole('button', { name: '打开预览面板' }).click();
    await expect(panel.getByRole('tab')).toHaveCount(1);
    await expect(treeSplitter).toHaveAttribute('aria-valuenow', String(treeInitial + 24));
    await page.screenshot({ path: 'artifacts/unified-preview-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(panel.getByRole('button', { name: '返回工作台' })).toBeInViewport();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await explorer.getByRole('button', { name: '收起目录', exact: true }).click();
    await expect(diff).toBeVisible();
    await explorer.getByRole('button', { name: '展开目录', exact: true }).click();
    await explorer.getByRole('button', { name: '文件', exact: true }).click();
    await explorer.getByRole('button', { name: /README\.md/ }).click();
    await expect(tree).toBeHidden();
    await expect(panel.getByRole('heading', { name: 'Sidebar preview' })).toBeVisible();
    await page.screenshot({ path: 'artifacts/unified-preview-mobile.png' });
    await panel.getByRole('button', { name: '返回工作台' }).click();
    await expect(panel).toBeHidden();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('workspace sidebar previews HTML in a sandbox and plays local media', async ({ page, request }) => {
  const root = await mkdtemp(join(tmpdir(), 'sessiondeck-preview-'));
  try {
    await mkdir(join(root, 'site'));
    await writeFile(join(root, 'site', 'index.html'), '<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><h1 id="title">Codex site</h1><script>document.title="preview-ok"</script></body></html>');
    await writeFile(join(root, 'site', 'style.css'), '#title{color:#0a7;font-family:sans-serif}');
    // 1x1 PNG
    await writeFile(join(root, 'dot.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
    const session = await mutate<Session>(request, '/sessions', { backend: 'codex', title: '成果预览验收', cwd: root });
    const raw = await request.get(`/api/sessions/${session.id}/workspace/raw/site/index.html`);
    expect(raw.ok()).toBeTruthy();
    expect(raw.headers()['content-type']).toMatch(/text\/html/);
    expect(raw.headers()['content-security-policy']).toContain("frame-ancestors 'self'");
    expect(await raw.text()).toContain('Codex site');
    const css = await request.get(`/api/sessions/${session.id}/workspace/raw/site/style.css`);
    expect(css.ok()).toBeTruthy();
    expect(await css.text()).toContain('#title');
    const png = await request.get(`/api/sessions/${session.id}/workspace/raw/dot.png`);
    expect(png.ok()).toBeTruthy();
    expect(png.headers()['content-type']).toBe('image/png');
    expect(png.headers()['accept-ranges']).toBe('bytes');

    await page.goto('/');
    await page.getByRole('button', { name: `进入 ${session.title} 的会话`, exact: true }).click();
    await page.getByRole('button', { name: '打开资源管理器', exact: true }).click();
    const explorer = page.getByRole('complementary', { name: '资源管理器' });
    await explorer.getByRole('button', { name: /^site$/ }).click();
    await explorer.getByRole('button', { name: /index\.html/ }).click();
    const panel = page.getByRole('complementary', { name: '统一预览面板' });
    const frame = panel.frameLocator('iframe[title="预览 site/index.html"]');
    await expect(frame.locator('#title')).toHaveText('Codex site');
    const iframe = await panel.locator('iframe').elementHandle();
    await explorer.getByRole('button', { name: '收起目录', exact: true }).click();
    await explorer.getByRole('button', { name: '展开目录', exact: true }).click();
    expect(await iframe!.evaluate(element => element.isConnected)).toBe(true);
    await expect(panel.locator('iframe[title="预览 site/index.html"]')).toHaveAttribute('sandbox', 'allow-scripts allow-forms');
    await panel.getByRole('button', { name: '查看源码', exact: true }).click();
    await expect(panel.locator('.workspace-html-preview pre')).toContainText('Codex site');
    await panel.getByRole('button', { name: '预览网页', exact: true }).click();
    await expect(frame.locator('#title')).toHaveText('Codex site');

    await panel.getByRole('tab', { name: `文件 · ${session.title}`, exact: true }).click();
    await explorer.getByRole('button', { name: /dot\.png/ }).click();
    await expect(panel.locator('.workspace-media-stage img')).toHaveAttribute('src', new RegExp(`/api/sessions/${session.id}/workspace/raw/dot\\.png$`));
    await expect(panel.locator('.workspace-media-stage img')).toBeVisible();
    await page.screenshot({ path: 'artifacts/workspace-html-preview.png' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('opening a shell from a contact uses its directory and is immediately interactive', async ({ page, request }) => {
  const root = await mkdtemp(join(tmpdir(), 'sessiondeck-shell-cwd-'));
  const initial = await (await request.get('/api/shells')).json() as { id: string }[];
  const existing = new Set(initial.map(item => item.id));
  try {
    const session = await mutate<Session>(request, '/sessions', { backend: 'codex', title: '独立 Shell 验收', cwd: root });
    await page.goto('/');
    await page.getByRole('button', { name: '打开终端', exact: true }).click();
    await expect(page.locator('.terminal-connection.connected')).toHaveCount(1);
    await page.getByRole('button', { name: '隐藏终端面板', exact: true }).click();
    await page.getByRole('button', { name: `进入 ${session.title} 的会话`, exact: true }).click();
    await page.getByRole('button', { name: '打开终端', exact: true }).click();
    // The session remains in the main workbench while the shared terminal dock
    // opens below it, matching VS Code's panel behavior.
    await expect(page.getByRole('dialog', { name: `${session.title} 的私聊` })).toBeVisible();
    const dock = page.getByRole('region', { name: '底部终端面板' });
    await expect(dock.locator('.terminal-connection.connected')).toHaveCount(1);
    await expect(dock.locator('.terminal-dock-tab')).toHaveCount(2);
    await expect(page.getByRole('dialog', { name: `${session.title} 的私聊` }).locator('.session-conversation')).toBeVisible();
    await page.screenshot({ path: 'artifacts/workbench-terminal.png' });
    await command(dock, 'pwd');
    await expect(dock.locator('.xterm-rows')).toContainText(root);
    await command(dock, 'exit');
    await expect(dock).toContainText('已退出');
  } finally {
    const shells = await (await request.get('/api/shells')).json() as { id: string }[];
    for (const shell of shells.filter(item => !existing.has(item.id))) await mutate(request, `/shells/${shell.id}`, undefined, 'DELETE');
    await rm(root, { recursive: true, force: true });
  }
});


test('notification sounds work without system notification permission and respect mute', async ({ page, request }) => {
  const state = await (await request.get('/api/state')).json() as AppState;
  const session = state.sessions.find(item => !item.archived)!;
  await page.addInitScript(() => {
    const target = window as unknown as { panelSource: EventTarget; tones: number; resumes: number };
    target.tones = 0; target.resumes = 0;
    class AudioStub {
      state = 'suspended'; currentTime = 0; destination = {};
      resume() { this.state = 'running'; target.resumes++; return Promise.resolve(); }
      close() { return Promise.resolve(); }
      createOscillator() { const parameter = { setValueAtTime() {}, exponentialRampToValueAtTime() {} }; return { frequency: parameter, connect() {}, disconnect() {}, start() { target.tones++; }, stop() {} }; }
      createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
    }
    class StateSource extends EventTarget {
      onopen: (() => void) | null = null;
      constructor() { super(); target.panelSource = this; queueMicrotask(() => this.onopen?.()); }
      close() {}
    }
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: AudioStub });
    Object.defineProperty(window, 'Notification', { configurable: true, value: undefined });
    Object.defineProperty(window, 'EventSource', { configurable: true, value: StateSource });
  });
  await page.route('**/api/state', route => route.fulfill({ json: state }));
  // Sound and notification toggles live in settings; reminders still fire from any view.
  await page.goto('/#/backends');
  await expect(page.getByRole('button', { name: '关闭提示音', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '关闭提示音', exact: true }).focus();
  session.status = 'waiting_input'; session.unread++;
  const publish = () => page.evaluate(snapshot => (window as unknown as { panelSource: EventTarget }).panelSource.dispatchEvent(new MessageEvent('state', { data: JSON.stringify(snapshot) })), state);
  await publish(); await publish();
  await expect.poll(() => page.evaluate(() => (window as unknown as { tones: number }).tones)).toBe(1);
  await page.getByRole('button', { name: '关闭提示音', exact: true }).click();
  session.unread++;
  await publish();
  expect(await page.evaluate(() => (window as unknown as { tones: number }).tones)).toBe(1);
  await page.reload();
  await expect(page.getByRole('button', { name: '开启提示音', exact: true })).toBeVisible();
});

test('a slow shell creation follows the latest contact directory and reconnect preserves typing focus', async ({ page, request }) => {
  const root = await mkdtemp(join(tmpdir(), 'sessiondeck-shell-race-'));
  const initial = await (await request.get('/api/shells')).json() as { id: string }[];
  const existing = new Set(initial.map(item => item.id));
  let releaseFirst = () => {};
  const firstResponse = new Promise<void>(resolve => { releaseFirst = resolve; });
  let firstSpawned = false;
  try {
    const secondCwd = join(root, 'second'); await mkdir(secondCwd);
    const first = await mutate<Session>(request, '/sessions', { backend: 'codex', title: '迟到 Shell 来源', cwd: root });
    const second = await mutate<Session>(request, '/sessions', { backend: 'codex', title: '最新 Shell 工作区', cwd: secondCwd });
    await page.addInitScript(() => {
      const Native = window.WebSocket;
      const sockets: WebSocket[] = [];
      Object.assign(window, { panelSockets: sockets });
      window.WebSocket = class extends Native {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          if (String(url).includes('/api/shells/')) sockets.push(this);
        }
      };
    });
    await page.route('**/api/shells', async route => {
      if (route.request().method() !== 'POST' || route.request().postDataJSON()?.sessionId !== first.id) return route.continue();
      const response = await route.fetch(); firstSpawned = true;
      await firstResponse;
      await route.fulfill({ response });
    });
    await page.goto('/');
    await page.getByRole('button', { name: `进入 ${first.title} 的会话`, exact: true }).click();
    await page.getByRole('button', { name: '打开终端', exact: true }).click();
    await expect.poll(() => firstSpawned).toBe(true);
    await page.getByRole('button', { name: '关闭会话', exact: true }).click();
    await page.getByRole('button', { name: `进入 ${second.title} 的会话`, exact: true }).click();
    await page.getByRole('button', { name: '打开终端', exact: true }).click();
    releaseFirst();
    const dock = page.getByRole('region', { name: '底部终端面板' });
    await expect(dock.locator('.terminal-dock-pane-heading')).toHaveCount(0);
    await expect(dock.getByRole('tab', { selected: true })).toHaveAttribute('title', new RegExp(secondCwd));
    await expect(dock.locator('.terminal-connection.connected')).toHaveCount(1);
    await command(dock, `printf 'CWD_RESULT:%s\\n' "$PWD"`);
    await expect(dock.locator('.xterm-rows')).toContainText(`CWD_RESULT:${secondCwd}`);
    const search = page.getByLabel('搜索联系人', { exact: true });
    await search.fill('正在编辑');
    const count = await page.evaluate(() => {
      const sockets = (window as unknown as { panelSockets: WebSocket[] }).panelSockets;
      for (const socket of sockets) if (socket.readyState === WebSocket.OPEN) socket.close(4001, 'reconnect test');
      return sockets.length;
    });
    await expect.poll(() => page.evaluate(() => (window as unknown as { panelSockets: WebSocket[] }).panelSockets.length)).toBeGreaterThan(count);
    await expect(dock.locator('.terminal-connection.connected')).toHaveCount(1);
    await expect(search).toBeFocused();
    await expect(search).toHaveValue('正在编辑');
  } finally {
    releaseFirst();
    const shells = await (await request.get('/api/shells')).json() as { id: string }[];
    for (const shell of shells.filter(item => !existing.has(item.id))) await mutate(request, `/shells/${shell.id}`, undefined, 'DELETE');
    await rm(root, { recursive: true, force: true });
  }
});
