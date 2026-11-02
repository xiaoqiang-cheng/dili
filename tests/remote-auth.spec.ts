import { mutationHeaders, test } from './fixtures';
import { expect } from '@playwright/test';
import type { AppState } from '../shared/types';
import type { RemoteStatus } from '../shared/auth';
import { remoteHtml } from '../server/remote-base';

const remoteOrigin = (baseURL: string) => { const url = new URL(baseURL); url.port = String(Number(url.port) + 1); return url.origin; };

for (const trailingSlash of ['', '/']) test(`device-prefixed remote links load the workspace and lazy assets (${trailingSlash ? 'with' : 'without'} trailing slash)`, async ({ page, baseURL, request }) => {
  const remote = remoteOrigin(baseURL!);
  const prefix = '/connect/d/browserfixture01';
  const headers = await mutationHeaders(request);
  const password = 'browser owner password';
  expect((await request.post('/api/auth/password', { headers, data: { password } })).ok()).toBe(true);
  const state = await (await request.get('/api/state')).json() as AppState;
  const target = state.sessions.find(item => item.title === 'Dili · 开发笔记')!;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const apiPaths: string[] = [];
  const assetPaths: string[] = [];
  const escapedAssets: string[] = [];
  // The public host serves its own website at /assets, not SessionDeck.
  // Reject escaped requests instead of letting the fixture's root accidentally
  // serve them successfully and hide a broken runtime preload URL.
  await page.route(`${remote}/assets/**`, route => {
    escapedAssets.push(new URL(route.request().url()).pathname);
    return route.fulfill({ status: 404, body: 'Host website: asset not found' });
  });
  // Model the relay's prefix stripping and HTML rewriting using the isolated,
  // authenticated remote listener. This never contacts a production device.
  await page.route(url => url.origin === remote && (url.pathname === prefix || url.pathname.startsWith(`${prefix}/`)), async route => {
    const url = new URL(route.request().url());
    const path = url.pathname.slice(prefix.length) || '/';
    if (path.startsWith('/api/')) apiPaths.push(url.pathname);
    if (path.startsWith('/assets/')) assetPaths.push(url.pathname);
    // route.fetch waits for a finite body; SSE is intentionally never finite.
    if (path === '/api/sessions/' + target.id + '/conversation') return route.fulfill({json:{messages:[{id:'remote-diagram',role:'assistant',text:['~~~mermaid','flowchart LR',' A[Remote] --> B[Ready]','~~~'].join(String.fromCharCode(10))}],truncated:false}});
    if (path === '/api/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': relay fixture\n\n' });
    const response = await route.fetch({ url: `${remote}${path}${url.search}` });
    if (path === '/') {
      await route.fulfill({ response, body: remoteHtml(await response.text(), prefix) });
    } else await route.fulfill({ response });
  });
  // Route restoration is watch-only. The prefix test checks HTTP state and
  // rendering; the other remote test exercises the actual terminal transport.
  await page.routeWebSocket(`${remote.replace('http:', 'ws:')}${prefix}/**`, socket => socket.close());
  // Generated device links may omit the final slash.
  await page.goto(`${remote}${prefix}${trailingSlash}#/contacts?session=${target.id}`);
  await page.getByLabel('所有者密码').fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('dialog', { name: `${target.title} 的私聊` })).toBeVisible();
  await expect(page.getByRole('button', { name: `进入 ${target.title} 的会话`, exact: true })).toBeVisible();
  expect(apiPaths).toContain(`${prefix}/api/auth/status`);
  expect(apiPaths).toContain(`${prefix}/api/state`);
  // Unlike the initial HTML links, lazy imports preload their CSS from JS.
  // Opening the real editor exercises both CSS preloads and ?url scripts.
  await page.getByRole('button', { name: '打开随手记', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '随手记实时编辑' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('dialog', { name: `${target.title} 的私聊` })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '随手记实时编辑' })).toBeVisible();
  expect(assetPaths.some(path => /\/terminal-[\w-]+\.css$/.test(path))).toBe(true);
  expect(assetPaths.some(path => /\/LiveMarkdownEditor-[\w-]+\.css$/.test(path))).toBe(true);
  expect(assetPaths.some(path => /\/lute\.min-[\w-]+\.js$/.test(path))).toBe(true);
  await page.getByRole('button',{name:'对话记录',exact:true}).click();
  await expect(page.frameLocator('iframe[title="Mermaid 图表"]').locator('svg')).toBeVisible({timeout:15000});
  await page.getByRole('button', { name: '放大 Mermaid 图表', exact: true }).click();
  const viewer = page.getByRole('dialog', { name: 'Mermaid 图表预览', exact: true });
  await expect(viewer).toBeVisible();
  await expect.poll(() => viewer.locator('img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await viewer.getByRole('button', { name: '关闭图表预览' }).click();
  expect(assetPaths.some(path=>path.includes('/mermaid.min-'))).toBe(true);
  expect(escapedAssets).toEqual([]);
  expect(errors).toEqual([]);
});

test('an exception after workspace loading shows a recoverable error instead of a blank page', async ({ page, request }) => {
  const state = await (await request.get('/api/state')).json() as AppState;
  const target = state.sessions.find(item => item.title === 'Dili · 开发笔记')!;
  await page.addInitScript(() => {
    const NativeObserver = ResizeObserver;
    if (sessionStorage.getItem('test-render-failure') === null) sessionStorage.setItem('test-render-failure', 'on');
    window.ResizeObserver = class extends NativeObserver {
      observe(element: Element, options?: ResizeObserverOptions) {
        if (sessionStorage.getItem('test-render-failure') === 'on' && element.closest('.terminal-pane')) {
          throw new Error('Terminal observer unavailable in this browser');
        }
        super.observe(element, options);
      }
    };
  });
  await page.goto(`/#/contacts?session=${target.id}`);
  const error = page.getByRole('alert');
  await expect(error).toContainText('工作空间显示失败');
  // Diagnostics must be visible immediately, including on phones where a
  // collapsed detail can be mistaken for the full error message.
  await expect(error.locator('pre')).toBeVisible();
  await expect(error.locator('pre')).toHaveText('Terminal observer unavailable in this browser');
  await page.evaluate(() => sessionStorage.setItem('test-render-failure', 'off'));
  await error.getByRole('button', { name: '重新加载' }).click();
  await expect(page.getByRole('dialog', { name: `${target.title} 的私聊` })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`session=${target.id}$`));
});

test('invite pairing shows its stage, restores the button after failure and allows retry', async ({ page, request }) => {
  const headers = await mutationHeaders(request);
  expect((await request.post('/api/auth/password', { headers, data: { password: 'browser owner password' } })).ok()).toBeTruthy();
  let status = await (await request.get('/api/remote')).json() as RemoteStatus;
  let attempts = 0;
  let fail!: () => void;
  const failed = new Promise<void>(resolve => { fail = resolve; });
  await page.route('**/api/remote', route => route.fulfill({ json: status }));
  await page.route('**/api/remote/pair', async route => {
    attempts++;
    if (attempts === 1) {
      status = { ...status, pairingStage: 'redeeming' };
      await failed;
      status = { ...status, pairingStage: null };
      await route.fulfill({ status: 502, json: { error: '中继服务器连接失败或超时，请检查网络后重试' } });
    } else {
      status = { ...status, pairingStage: null, pairing: { deviceId: 'fixturedevice123', name: '测试电脑', serverUrl: 'https://relay.example/connect', pairedAt: new Date().toISOString() }, settings: { ...status.settings, mode: 'invite', enabled: true, publicUrl: 'https://relay.example/connect/d/fixturedevice123' }, tunnel: { state: 'connected', since: null, error: '', attempts: 0 } };
      await route.fulfill({ json: status });
    }
  });
  await page.goto('/#/backends');
  const security = page.getByRole('region', { name: '远程访问与安全' });
  await security.getByLabel('邀请码', { exact: true }).fill('SD1.browser-fixture');
  await security.getByRole('button', { name: '配对并生成链接', exact: true }).click();
  await expect(security.getByRole('button', { name: '正在配对…' })).toBeDisabled();
  await expect(security.getByRole('status')).toContainText('正在兑换邀请码', { timeout: 8000 });
  fail();
  await expect(security.getByRole('alert')).toContainText('连接失败或超时');
  await expect(security.getByRole('button', { name: '配对并生成链接', exact: true })).toBeEnabled();
  await security.getByRole('button', { name: '配对并生成链接', exact: true }).click();
  await expect(security).toContainText('测试电脑');
  await expect(security).toContainText('https://relay.example/connect/d/fixturedevice123');
  expect(attempts).toBe(2);
});

test('remote owner logs in, shares a session read-only, and revocation closes the colleague view', async ({ page, browser, baseURL, request }) => {
  const remote = remoteOrigin(baseURL!);
  const state = await (await request.get('/api/state')).json() as AppState;
  const target = state.sessions.find(item => item.title === 'Dili · 开发笔记')!;

  // Set the owner password on the owner's own machine.
  await page.goto('/#/backends');
  const security = page.getByRole('region', { name: '远程访问与安全' });
  const password = 'browser owner password';
  await expect(security).toBeVisible();
  if (await security.getByRole('button', { name: '设置密码', exact: true }).count()) {
    await security.getByLabel('新密码').fill(password);
    await security.getByLabel('确认密码').fill(password);
    await security.getByRole('button', { name: '设置密码', exact: true }).click();
    await expect(security.getByRole('button', { name: '更换密码', exact: true })).toBeVisible();
  }

  // The remote address needs that password; nothing leaks before login.
  const ownerRemote = await browser.newContext();
  const remotePage = await ownerRemote.newPage();
  expect((await remotePage.request.get(`${remote}/api/state`)).status()).toBe(401);
  // A copied device link can already contain the selected contact route.
  // The auth gate must keep it while the owner logs in.
  await remotePage.goto(`${remote}/#/contacts?session=${target.id}`);
  await remotePage.getByLabel('所有者密码').fill('not the password');
  await remotePage.getByRole('button', { name: '登录', exact: true }).click();
  await expect(remotePage.getByRole('alert')).toContainText('密码不正确');
  await remotePage.getByLabel('所有者密码').fill(password);
  await remotePage.getByRole('button', { name: '登录', exact: true }).click();
  // A manually opened remote listener has no paired device identity. The
  // contact-list title is intentionally empty until an invite device name is
  // available, so multiple device links remain distinguishable by name.
  await expect(remotePage.getByRole('heading', { name: '会话联系人', exact: true })).toBeHidden();
  await expect(remotePage.getByRole('dialog', { name: `${target.title} 的私聊` })).toBeVisible();
  await remotePage.goto(`${remote}/#/backends`);
  await expect(remotePage.getByRole('region', { name: '远程访问与安全' })).toContainText('只能在运行 Dili 的电脑上修改');

  // Share from the card menu on the local workbench.
  await page.goto('/');
  await page.getByRole('button', { name: `${target.title} 的更多操作`, exact: true }).click();
  await page.getByRole('button', { name: '分享会话', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '分享会话' });
  await dialog.getByRole('button', { name: '只读', exact: true }).click();
  await dialog.getByRole('button', { name: '生成并复制链接', exact: true }).click();
  const link = await dialog.locator('.share-created code').textContent();
  expect(link).toMatch(new RegExp(`^${remote}/#/share/[\\w-]+$`));

  const colleagueContext = await browser.newContext();
  const colleague = await colleagueContext.newPage();
  await colleague.goto(link!);
  await colleague.getByLabel('你的名字').fill('测试同事');
  await colleague.getByRole('button', { name: '进入会话', exact: true }).click();
  await expect(colleague.getByRole('heading', { name: target.title, exact: true })).toBeVisible();
  await expect(colleague.locator('.share-role')).toHaveText('只读 · 测试同事');
  await expect(colleague).toHaveURL(`${remote}/#/`);
  await expect(colleague.getByRole('button', { name: /启动|恢复|停止/ })).toHaveCount(0);
  await expect(colleague.getByRole('navigation', { name: '工作空间导航' })).toHaveCount(0);
  await expect(colleague.getByRole('button', { name: '原生终端', exact: true })).toHaveCount(0);
  await expect(colleague.getByRole('button', { name: '打开资源管理器', exact: true })).toHaveCount(0);
  expect((await colleague.request.get(`${remote}/api/sessions/${target.id}/workspace/tree`)).status()).toBe(403);
  const scoped = await (await colleague.request.get(`${remote}/api/state`)).json() as AppState;
  expect(scoped.sessions.map(item => item.id)).toEqual([target.id]);
  await colleague.screenshot({ path: 'artifacts/share-readonly.png' });
  await colleague.reload();
  await expect(colleague.getByRole('heading', { name: target.title, exact: true })).toBeVisible();

  // The owner sees who opened the link, then revokes it.
  await expect(dialog.locator('.share-list')).toContainText('测试同事', { timeout: 1000 }).catch(async () => {
    await dialog.getByRole('button', { name: '完成', exact: true }).click();
    await page.getByRole('button', { name: `${target.title} 的更多操作`, exact: true }).click();
    await page.getByRole('button', { name: '分享会话', exact: true }).click();
  });
  const reopened = page.getByRole('dialog', { name: '分享会话' });
  await expect(reopened.locator('.share-list')).toContainText('测试同事');
  await reopened.getByRole('button', { name: '撤销', exact: true }).first().click();
  await expect(colleague.getByRole('button', { name: '登录', exact: true })).toBeVisible();
  expect((await colleague.request.get(`${remote}/api/state`)).status()).toBe(401);

  // Clean up: revoke any remaining shares for this session.
  const headers = await mutationHeaders(request);
  for (const share of await (await request.get(`/api/sessions/${target.id}/shares`)).json() as { id: string }[]) await request.delete(`/api/shares/${share.id}`, { headers, data: {} });
  await ownerRemote.close(); await colleagueContext.close();
});

test('opening a remote link from another website reaches the login page and permits same-origin login', async ({ page, baseURL, request }) => {
  const remote = remoteOrigin(baseURL!);
  const headers = await mutationHeaders(request);
  const password = 'cross-site remote link password';
  expect((await request.post('/api/auth/password', { headers, data: { password } })).ok()).toBe(true);
  const source = 'http://localhost:39999/shared-device-link';
  await page.route(source, route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<a href="${remote}/#/contacts">打开我的 Dili</a>` }));
  let navigations = 0;
  // Chromium can omit Fetch Metadata for a route-fulfilled source document.
  // Supply the real production link-click headers only on the initial entry;
  // assets, API requests and the following login use their own browser headers.
  await page.route(`${remote}/`, route => {
    if (!route.request().isNavigationRequest()) return route.continue();
    navigations++;
    return route.continue({ headers: { ...route.request().headers(), 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } });
  });
  await page.goto(source);
  await page.getByRole('link', { name: '打开我的 Dili' }).click();
  await expect(page.getByLabel('所有者密码')).toBeVisible();
  expect(navigations).toBe(1);
  await page.getByLabel('所有者密码').fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('button', { name: '打开随手记', exact: true })).toBeVisible();
  expect(await page.locator('body').innerText()).not.toContain('请求来源不被允许');
});
