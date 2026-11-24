import { test, mutationHeaders } from './fixtures';
import { expect } from '@playwright/test';
import type { AgentSetupInfo } from '../shared/setup';

const agents: AgentSetupInfo[] = [
  { id: 'claude', executable: null, configPath: '/home/test/.claude/settings.json', credentialPresent: false, baseUrl: '', model: '', installCommand: 'npm install -g @anthropic-ai/claude-code', loginCommand: 'claude auth login', nativeCommand: 'claude', docsUrl: 'https://code.claude.com/docs/en/setup', note: '使用原生配置，其他终端也能运行。' },
  { id: 'codex', executable: '/usr/bin/codex', configPath: '/home/test/.codex/config.toml', credentialPresent: true, baseUrl: 'https://example.com/v1', model: 'model-a', installCommand: 'npm install -g @openai/codex', loginCommand: 'codex login --device-auth', nativeCommand: 'codex', docsUrl: 'https://developers.openai.com/codex/cli/', note: '使用原生配置，其他终端也能运行。' },
  { id: 'dsh', executable: '/usr/bin/dsh', configPath: '/home/test/.dsh/profiles/web/cordis.patch.yml', credentialPath: '/home/test/.dsh/.credentials.yaml', credentialPresent: false, baseUrl: '', model: '', installCommand: 'npm install -g @deepseek-ai/dsh @deepseek-harness-tui/dsh-tui', loginCommand: 'dsh web', nativeCommand: 'dsh web', docsUrl: 'https://github.com/deepseek-ai/deepseek-harness', note: '在原生 Web 设置中配置 API Key。' },
  { id: 'pi', executable: '/usr/bin/pi', configPath: '/home/test/.pi/agent/models.json', credentialPath: '/home/test/.pi/agent/auth.json', credentialPresent: false, baseUrl: '', model: '', installCommand: 'npm install -g @earendil-works/pi-coding-agent', loginCommand: 'pi', nativeCommand: 'pi', docsUrl: 'https://github.com/earendil-works/pi', note: '使用 Pi 原生配置。' },
];

test('native API setup keeps keys out of browser storage, preserves empty keys, and configures dsh/Pi managed APIs', async ({ page }) => {
  await page.route('**/api/setup/agents', route => route.fulfill({ json: agents }));
  let saved: unknown;
  await page.route('**/api/setup/agents/codex/config', route => { saved = route.request().postDataJSON(); return route.fulfill({ json: { note: '已保存原生配置并备份原文件' } }); });
  await page.goto('/#/backends');
  const codex = page.locator('.backend-setting-card').filter({ has: page.getByRole('heading', { name: 'Codex', exact: true }) });
  await codex.getByRole('button', { name: '配置 API', exact: true }).click();
  await expect(codex.getByLabel('API 地址', { exact: true })).toHaveValue('https://example.com/v1');
  await codex.getByLabel('API Key', { exact: true }).fill('never-store-this-key');
  await codex.getByLabel('模型', { exact: true }).fill('new-model');
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain('never-store-this-key');
  await codex.getByRole('button', { name: '保存原生配置' }).click();
  await expect(codex.getByRole('status')).toContainText('备份');
  expect(saved).toEqual({ apiKey: 'never-store-this-key', baseUrl: 'https://example.com/v1', model: 'new-model' });
  await codex.getByRole('button', { name: '配置 API', exact: true }).click();
  await expect(codex.getByLabel('API Key', { exact: true })).toHaveValue('');
  await codex.getByRole('button', { name: '保存原生配置' }).click();
  await expect(codex.getByRole('status')).toContainText('备份');
  expect(saved).toEqual({ baseUrl: 'https://example.com/v1', model: 'model-a' });
  const dsh = page.locator('.backend-setting-card').filter({ has: page.getByRole('heading', { name: 'DeepSeek Harness', exact: true }) });
  await expect(dsh.getByRole('button', { name: '原生配置引导' })).toBeEnabled();
  await expect(dsh.getByRole('button', { name: '配置 API', exact: true })).toBeEnabled();
  let dshSaved: unknown;
  await page.route('**/api/setup/agents/dsh/config', route => { dshSaved = route.request().postDataJSON(); return route.fulfill({ json: { note: '已写入 DSH profile 配置' } }); });
  await dsh.getByRole('button', { name: '配置 API', exact: true }).click();
  await expect(dsh.locator('.setup-form')).toBeVisible();
  await dsh.getByLabel('API Key', { exact: true }).fill('dsh-browser-key');
  await dsh.getByLabel('API 地址', { exact: true }).fill('https://dsh.example/v1');
  await dsh.getByLabel('模型', { exact: true }).fill('dsh-model');
  await dsh.getByRole('button', { name: '保存原生配置' }).click();
  await expect(dsh.getByRole('status')).toContainText('DSH profile');
  expect(dshSaved).toEqual({ apiKey: 'dsh-browser-key', baseUrl: 'https://dsh.example/v1', model: 'dsh-model' });
  const pi = page.locator('.backend-setting-card').filter({ has: page.getByRole('heading', { name: 'Pi', exact: true }) });
  await expect(pi.getByRole('button', { name: '配置 API', exact: true })).toBeEnabled();
});

test('auto-start toggle changes only future startup and mobile settings do not overflow', async ({ page }) => {
  await page.route('**/api/setup/agents', route => route.fulfill({ json: agents }));
  let enabled = false;
  const actions: unknown[] = [];
  await page.route('**/api/setup/startup', route => {
    if (route.request().method() === 'POST') { actions.push(route.request().postDataJSON()); enabled = true; }
    return route.fulfill({ json: { supported: true, enabled, active: true, linger: false, conflict: false, legacy: false, wsl: true, unitPath: '/home/test/.config/systemd/user/dili.service', note: '在 WSL 发行版启动后自动运行；不会停止当前会话。' } });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/backends');
  const startup = page.getByRole('region', { name: '自动启动', exact: true });
  await startup.getByRole('switch').click();
  await expect(startup.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  expect(actions).toEqual([{ enabled: true }]);
  await expect(startup).toContainText('用户服务正在运行');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: 'artifacts/setup-mobile.png', fullPage: true });
});

test('demo setup refuses installation/configuration/autostart and never exposes native files', async ({ request }) => {
  expect(await (await request.get('/api/setup/agents')).json()).toEqual([]);
  for (const [path, data] of [['/api/setup/agents/codex/config', { apiKey: 'fake' }], ['/api/setup/agents/claude/terminal', { action: 'install' }], ['/api/setup/startup', { enabled: true }]] as const) {
    const response = await request.post(path, { data, headers: await mutationHeaders(request) });
    expect(response.status()).toBe(409);
  }
});

test('installation guide opens the returned terminal and keeps it interactive without creating another shell', async ({ page, request }) => {
  const headers = await mutationHeaders(request);
  const response = await request.post('/api/shells', { headers, data: {} });
  const shell = await response.json() as { id: string; title: string };
  const before = await (await request.get('/api/shells')).json() as { id: string }[];
  try {
    await page.route('**/api/setup/agents', route => route.fulfill({ json: agents }));
    let action: unknown;
    await page.route('**/api/setup/agents/claude/terminal', route => { action = route.request().postDataJSON(); return route.fulfill({ status: 201, json: shell }); });
    page.once('dialog', dialog => dialog.accept());
    await page.goto('/#/backends');
    const claude = page.locator('.backend-setting-card').filter({ has: page.getByRole('heading', { name: 'Claude Code', exact: true }) });
    await claude.getByRole('button', { name: '安装后端', exact: true }).click();
    const dock = page.getByRole('region', { name: '终端面板' });
    await expect(dock.getByRole('tab', { name: shell.title, exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(dock.locator('.terminal-connection.connected')).toHaveCount(1);
    expect(action).toEqual({ action: 'install' });
    const input = dock.locator('textarea.xterm-helper-textarea');
    await expect(input).toBeFocused();
    await input.pressSequentially("printf 'SETUP_UI_%s\\n' 'OK'"); await input.press('Enter');
    await expect(dock.locator('.xterm-rows')).toContainText('SETUP_UI_OK');
    expect((await (await request.get('/api/shells')).json() as { id: string }[]).map(item => item.id)).toEqual(before.map(item => item.id));
    await page.screenshot({ path: 'artifacts/setup-terminal.png' });
  } finally { await request.delete(`/api/shells/${shell.id}`, { headers }); }
});
