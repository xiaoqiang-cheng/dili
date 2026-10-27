import { readFileSync } from 'node:fs';
import { expect } from '@playwright/test';
import { test } from './fixtures';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';

// PWA assertions require actual workers even in the standard UI regression run.
test.use({ serviceWorkers: 'allow' });

for (const width of [1440, 412, 390]) test(`machine launcher pairs, persists and opens contacts at ${width}px`, async ({ page, baseURL }) => {
  await page.setViewportSize({ width, height: 844 });
  await page.goto('/#/machines');
  await expect(page.getByRole('heading', { name: '我的机器' })).toBeVisible();
  await expect(page.locator('.machine-card')).toHaveCount(0);
  await page.getByRole('button', { name: '添加机器', exact: true }).click();
  await page.getByLabel('机器链接').fill(baseURL!);
  await page.getByLabel('名称（可选）').fill('工作电脑');
  await page.getByRole('button', { name: '下一步：验证机器' }).click();
  await expect(page.getByRole('main', { name: '联系人列表' })).toBeVisible();
  await page.getByRole('link', { name: '返回机器列表', exact: true }).click();
  await expect(page.locator('.machine-card')).toContainText('工作电脑');
  await page.reload();
  await expect(page.locator('.machine-card')).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('link', { name: /工作电脑/ }).click();
  await expect(page.getByRole('main', { name: '联系人列表' })).toBeVisible();
  await page.getByRole('link', { name: '返回机器列表', exact: true }).click();
  await expect(page.locator('.machine-card')).toHaveCount(1);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '移除 工作电脑' }).click();
  await expect(page.locator('.machine-card')).toHaveCount(0);
});

test('launcher rejects credential URLs and unsolicited pairing callbacks', async ({ page }) => {
  await page.goto('/#/machines?paired=https%3A%2F%2Fevil.example%2F');
  await expect(page.locator('.machine-card')).toHaveCount(0);
  await page.getByRole('button', { name: '添加机器' }).click();
  await page.getByLabel('机器链接').fill('https://user:password@example.com/');
  await page.getByRole('button', { name: '下一步：验证机器' }).click();
  await expect(page.getByRole('alert')).toContainText('不含密码');
  expect(await page.evaluate(() => localStorage.getItem('dili.machines.v1'))).toBeNull();
});

test('installed shell opens offline and never caches APIs', async ({ page, baseURL }) => {
  // Cut a real network connection: WebKit's emulated offline mode can fail
  // navigation before dispatching the Service Worker fetch event.
  const proxy = createServer((incoming, outgoing) => {
    const upstream = httpRequest(new URL(incoming.url!, baseURL), response => {
      outgoing.writeHead(response.statusCode!, response.headers); response.pipe(outgoing);
    });
    upstream.on('error', () => { outgoing.writeHead(502); outgoing.end(); });
    incoming.pipe(upstream);
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  try {
  await page.goto(`${origin}/#/machines`);
  const manifest = await (await page.request.get('/manifest.webmanifest')).json();
  expect(manifest.start_url).toContain('#/machines');
  expect(manifest.icons.some((icon: { sizes: string }) => icon.sizes === '512x512')).toBe(true);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await page.evaluate(async () => { await fetch('/api/state'); });
  const cached = await page.evaluate(async () => (await Promise.all((await caches.keys()).map(async key => (await (await caches.open(key)).keys()).map(request => request.url)))).flat());
  expect(cached.some(url => url.includes('/api/'))).toBe(false);
  proxy.closeAllConnections();
  await new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve()));
  await page.reload();
  await expect(page.getByRole('heading', { name: '我的机器' })).toBeVisible();
  } finally { if (proxy.listening) { proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve())); } }
});

test.describe('password flow with deterministic authentication responses', () => {
  test.use({ serviceWorkers: 'block' });
test('pairing prompts for the target password without persisting it and supports multiple machines', async ({ page, baseURL }) => {
  const owner = await (await page.request.get('/api/auth/status')).json();
  await page.addInitScript(() => { if (!localStorage.getItem('dili.machines.v1')) localStorage.setItem('dili.machines.v1', JSON.stringify([{ name: '另一台机器', url: 'https://second.example/' }])); });
  let password = '';
  await page.route('**/api/auth/status', route => route.fulfill({ json: password ? owner : { kind: 'anonymous', passwordSet: true } }));
  await page.route('**/api/auth/login', route => {
    password = route.request().postDataJSON().password;
    return route.fulfill({ json: owner });
  });
  await page.goto('/#/machines');
  await page.getByRole('button', { name: '添加机器' }).click();
  await page.getByLabel('机器链接').fill(baseURL!);
  await page.getByRole('button', { name: '下一步：验证机器' }).click();
  await page.getByLabel('所有者密码').fill('test-only-machine-secret');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  expect(password).toBe('test-only-machine-secret');
  await expect(page.getByRole('main', { name: '联系人列表' })).toBeVisible();
  await page.getByRole('link', { name: '返回机器列表', exact: true }).click();
  await expect(page.locator('.machine-card')).toHaveCount(2);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain(password);
});

});

test('a machine on another origin returns to the launcher and opens its own contacts', async ({ page, baseURL }) => {
  const proxy = createServer((incoming, outgoing) => {
    const upstream = httpRequest(new URL(incoming.url!, baseURL), response => {
      outgoing.writeHead(response.statusCode!, response.headers); response.pipe(outgoing);
    });
    upstream.on('error', () => { outgoing.writeHead(502); outgoing.end(); });
    incoming.pipe(upstream);
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const target = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}/`;
  try {
    await page.goto('/#/machines');
    await page.getByRole('button', { name: '添加机器' }).click();
    await page.getByLabel('机器链接').fill(target);
    await page.getByLabel('名称（可选）').fill('远程机器');
    await page.getByRole('button', { name: '下一步：验证机器' }).click();
    await expect(page.getByRole('main', { name: '联系人列表' })).toBeVisible();
    await page.getByRole('link', { name: '返回机器列表', exact: true }).click();
    await expect(page.locator('.machine-card')).toContainText('远程机器');
    expect(new URL(page.url()).origin).toBe(new URL(baseURL!).origin);
    await page.getByRole('link', { name: /远程机器/ }).click();
    await expect(page.getByRole('main', { name: '联系人列表' })).toBeVisible();
    expect(new URL(page.url()).origin).toBe(new URL(target).origin);
  } finally { proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve())); }
});

test('install entry explains platform steps and return uses existing workspace navigation', async ({ page, baseURL }) => {
  await page.goto('/#/machines');
  await page.getByRole('button', { name: '安装到桌面' }).click();
  await expect(page.getByRole('status')).toContainText('主屏幕');
  await page.goto(`/?machineHome=${encodeURIComponent(baseURL + '/#/machines')}#/contacts`);
  await expect(page.getByRole('navigation', { name: '机器导航' })).toHaveCount(0);
  const navigation = page.getByRole('navigation', { name: '工作空间导航' });
  await expect(navigation.getByRole('link', { name: '返回机器列表' })).toBeVisible();
  await expect(page.getByRole('main', { name: '联系人列表' })).toBeVisible();
});

test.describe('machine card remote pairing', () => {
  test.use({ serviceWorkers: 'block' });
  test('redeems a card invite once, replaces the local URL and opens remote contacts', async ({ page, baseURL }) => {
    const proxy = createServer((incoming, outgoing) => {
      const upstream = httpRequest(new URL(incoming.url!, baseURL), response => { outgoing.writeHead(response.statusCode!, response.headers); response.pipe(outgoing); });
      upstream.on('error', () => { outgoing.writeHead(502); outgoing.end(); }); incoming.pipe(upstream);
    });
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const remote = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}/`;
    const invite = `SD1.aHR0cHM6Ly9yZWxheS5leGFtcGxlL2Nvbm5lY3Q.${'a'.repeat(43)}`;
    let calls = 0;
    await page.route('**/api/remote/pair', async route => {
      calls++;
      expect(route.request().postDataJSON().invite).toBe(invite);
      expect(page.url()).not.toContain('SD1.');
      await route.fulfill({ json: { settings: { publicUrl: remote }, tunnel: { state: 'connected' } } });
    });
    try {
      await page.goto('/#/machines');
      await page.locator('.machine-current-card').getByLabel('远程连接邀请码').fill(invite);
      await page.locator('.machine-current-card').getByRole('button', { name: '转为远程连接' }).click();
      await expect(page.getByRole('main', { name: '联系人列表' })).toBeVisible();
      expect(new URL(page.url()).origin).toBe(new URL(remote).origin);
      await page.getByRole('link', { name: '返回机器列表' }).click();
      await expect(page.locator('.machine-card')).toHaveCount(1);
      expect(await page.evaluate(() => localStorage.getItem('dili.machines.v1'))).toContain(remote);
      expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain(invite);
      expect(calls).toBe(1);
    } finally { proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve())); }
  });
  test('pairing failure keeps the machine and allows retry without saving the invite', async ({ page }) => {
    await page.route('**/api/remote/pair', route => route.fulfill({ status: 409, json: { error: '邀请码已被使用' } }));
    await page.goto('/#/machines');
    await page.locator('.machine-current-card').getByLabel('远程连接邀请码').fill(`SD1.YQ.${'a'.repeat(43)}`);
    await page.locator('.machine-current-card').getByRole('button', { name: '转为远程连接' }).click();
    await expect(page.getByRole('alert')).toContainText('邀请码已被使用');
    expect(page.url()).not.toContain('SD1.');
    await expect(page.getByRole('button', { name: '重试连接' })).toBeVisible();
    await page.getByRole('link', { name: '返回机器列表' }).click();
    await expect(page.locator('.machine-current-card')).toBeVisible();
  });
});

test.describe('device QR and invite applications', () => {
  test.use({ serviceWorkers: 'block' });
  test('QR link prefills a canonical machine without silently adding it', async ({ page }) => {
    const target = 'https://discoverpaw.com/connect/d/abcdefghijklmnop/';
    await page.goto('/#/machines?add=' + encodeURIComponent(target) + '&name=' + encodeURIComponent('工作电脑'));
    await expect(page.getByLabel('机器链接')).toHaveValue('https://dili.discoverpaw.com/connect/d/abcdefghijklmnop/');
    await expect(page.getByLabel('名称（可选）')).toHaveValue('工作电脑');
    await expect(page.locator('.machine-card')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
  test('QR links reject executable URLs', async ({ page }) => {
    await page.goto('/#/machines?add=' + encodeURIComponent('javascript:alert(1)'));
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.locator('.machine-card')).toHaveCount(0);
  });
  test('email application keeps a private receipt and retrieves approval', async ({ page }) => {
    let approved = false;
    await page.route('**/connect/api/requests', async route => {
      const body = route.request().postDataJSON();
      expect(body.email).toBe('reader@example.com');
      expect(body.claim).toMatch(/^[A-Za-z0-9_-]{43}$/);
      await route.fulfill({ status: 201, json: { id: 'test-request' } });
    });
    await page.route('**/connect/api/requests/test-request/status', route => route.fulfill({ json: approved ? { status: 'approved', inviteStatus: 'ready', invite: 'SD1.test.private-code' } : { status: 'pending' } }));
    await page.goto('/#/machines?apply=1');
    await page.getByLabel('称呼').fill('申请人');
    await page.getByLabel('电子邮箱').fill('reader@example.com');
    await page.getByRole('button', { name: '提交申请' }).click();
    await expect(page.getByRole('status')).toContainText('等待管理员审核');
    approved = true;
    await page.getByRole('button', { name: '刷新申请状态' }).click();
    await expect(page.locator('.invite-request textarea')).toHaveValue('SD1.test.private-code');
    expect(await page.evaluate(() => localStorage.getItem('dili.invite-request'))).not.toContain('private-code');
    expect(page.url()).not.toContain('claim');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
});


test.describe('relay console layout', () => {
  test.use({ serviceWorkers: 'block' });
  test('administrator reviews email requests and manages invites on mobile and desktop', async ({ page }) => {
    let reviewed = false;
    await page.route('**/connect/', route => route.fulfill({ contentType: 'text/html', body: readFileSync('relay/index.html', 'utf8') }));
    await page.route('**/connect/api/admin/state', route => route.fulfill({ json: { domains: ['discoverpaw.com'], devices: [], invites: [], requests: [{ id: 'request-1', name: '<script>alert(1)</script>', email: 'reader@example.com', createdAt: new Date().toISOString(), status: reviewed ? 'approved' : 'pending' }] } }));
    await page.route('**/connect/api/admin/requests/request-1/review', route => {
      expect(route.request().headers().authorization).toBe('Bearer test-admin');
      expect(route.request().postDataJSON().approve).toBe(true);
      expect(route.request().postDataJSON().permanent).toBe(true);
      reviewed = true; return route.fulfill({ json: { ok: true } });
    });
    await page.goto('/connect/');
    await page.getByLabel('管理密钥').fill('test-admin');
    await page.getByRole('button', { name: '进入管理' }).click();
    await expect(page.locator('#pendingCount')).toHaveText('1');
    await expect(page.locator('#requests')).toContainText('<script>alert(1)</script>');
    await page.getByLabel('reader@example.com 的邀请码有效期').selectOption('permanent');
    await page.getByRole('button', { name: '通过', exact: true }).click();
    await expect(page.locator('#requests')).toContainText('已通过');
    await expect(page.locator('#pendingCount')).toHaveText('0');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('button', { name: '退出', exact: true }).click();
    await expect(page.getByLabel('管理密钥')).toHaveValue('');
    await expect(page.locator('#management')).toBeHidden();
  });
});

test.describe('version notifications', () => {
  test.use({ serviceWorkers: 'block' });

test('permanent installation guide and tag/build update prompts preserve the current page', async ({ page }) => {
  await page.route('https://api.github.com/repos/xiaoqiang-cheng/dili/tags?per_page=100', route => route.fulfill({ json: [{ name: 'v99.0.0-beta' }, { name: 'v10.0.0' }, { name: 'v9.0.0' }] }));
  await page.route('**/build-info.json', route => route.fulfill({ json: { build: 'a-new-deployment' } }));
  await page.goto('/#/machines');
  await expect(page.getByRole('button', { name: 'Dili 版本与更新' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: '电脑安装指南' })).toBeVisible();
  await page.goto('/');
  await page.getByRole('button', { name: 'Dili 版本与更新' }).click();
  const version = page.getByRole('region', { name: 'Dili 版本与更新' });
  await expect(version.getByRole('link', { name: '电脑安装指南' })).toHaveAttribute('href', 'https://github.com/xiaoqiang-cheng/dili/blob/main/docs/installation.md');
  await expect(version).toContainText('Dili 界面 v');
  await expect(version.getByRole('link', { name: '发现新版 v10.0.0' })).toHaveAttribute('href', 'https://github.com/xiaoqiang-cheng/dili/tree/v10.0.0');
  await expect(version.getByRole('button', { name: '加载新版界面' })).toBeVisible();
  page.once('dialog', dialog => dialog.dismiss());
  await version.getByRole('button', { name: '加载新版界面' }).click();
  await expect(page.getByRole('main', { name: '联系人列表' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.route('https://api.github.com/repos/xiaoqiang-cheng/dili/tags?per_page=100', route => route.fulfill({ status: 429, headers: { 'Access-Control-Allow-Origin': '*' }, json: {} }));
  await version.getByRole('button', { name: '检查更新', exact: true }).click();
  await expect(version).toContainText('仓库查询限流');
});

});

test('compact machine tabs retain return navigation and restore a saved workspace', async ({ page, baseURL }) => {
  const home = `${baseURL}/#/machines`;
  await page.goto('/#/machines');
  await page.evaluate(({ base, home }) => {
    localStorage.setItem('dili.machines.v1', JSON.stringify([{ url: `${base}/`, name: '工作电脑' }, { url: `${base}/other/`, name: '测试电脑' }]));
    sessionStorage.setItem('dili.machine-visits.v1', JSON.stringify({ [`${base}/other/`]: { hash: '#/contacts?session=last-session', time: 1 } }));
    location.href = `${base}/?machineHome=${encodeURIComponent(home)}#/contacts`;
  }, { base: baseURL!, home });
  const toggle = page.getByRole('button', { name: '切换机器', exact: true });
  await expect(toggle).toContainText('工作电脑');
  await expect(page.getByRole('link', { name: '返回机器列表', exact: true })).toHaveAttribute('href', home);
  await expect(page.getByRole('navigation', { name: '切换已添加机器' })).toHaveCount(0);
  await toggle.click();
  const tabs = page.getByRole('navigation', { name: '切换已添加机器' });
  await expect(tabs.getByRole('link', { name: '工作电脑', exact: true })).toHaveAttribute('aria-current', 'page');
  const target = new URL((await tabs.getByRole('link', { name: '测试电脑', exact: true }).getAttribute('href'))!);
  expect(target.hash).toBe('#/contacts?session=last-session');
  expect(target.searchParams.get('machineHome')).toBe(home);
  await tabs.getByRole('link', { name: '工作电脑', exact: true }).click();
  await expect(tabs).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});
