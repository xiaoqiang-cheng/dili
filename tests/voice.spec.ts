import { test, expect, type Page } from '@playwright/test';
import type { AppState, Session } from '../shared/types';

async function fixture(page: Page, backend: 'codex' | 'claude' | 'dsh', options: { installed?: boolean; holdReady?: boolean; deny?: boolean } = {}) {
  const seed = await (await page.request.get('/api/state')).json() as AppState;
  const contact: Session = { ...seed.sessions[0], id: 'voice-' + backend, backend, title: backend + ' 语音测试', running: true, status: 'waiting_input', statusSource: 'native', interactionMode: backend === 'dsh' ? 'terminal' : 'chat', executionTransport: backend === 'dsh' ? 'pty' : 'structured', nativeSessionId: 'voice-thread', forkPending: false };
  const snapshot = { nativeSessionId: contact.nativeSessionId, connected: true, activeTurnId: null, revision: 1, items: [], requests: [], truncated: false };
  await page.addInitScript(({ backend, snapshot, deny }) => {
    localStorage.setItem('sessiondeck.private-view.' + backend, backend === 'dsh' ? 'conversation' : 'chat');
    class Source extends EventTarget {
      onopen: (() => void) | null = null; onerror: (() => void) | null = null;
      constructor(url: string) { super(); setTimeout(() => { this.onopen?.(); if (url.includes('/chat/events')) this.dispatchEvent(new MessageEvent('state', { data: JSON.stringify(snapshot) })); }, 0); }
      close() {}
    }
    Object.defineProperty(window, 'EventSource', { value: Source });
    const stats = { opened: 0, stopped: 0, permission: undefined as (() => void) | undefined };
    (window as unknown as { voiceStats: typeof stats }).voiceStats = stats;
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => {
      if (deny) throw new DOMException('denied', 'NotAllowedError');
      stats.opened++;
      const track = { onended: null, stop() { stats.stopped++; } };
      return { getTracks: () => [track], getAudioTracks: () => [track] };
    } });
    class Recorder {
      static isTypeSupported() { return true; }
      state = 'inactive'; ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null; onerror: (() => void) | null = null;
      start() { this.state = 'recording'; this.ondataavailable?.({ data: new Blob(['first opus chunk']) }); }
      stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['last opus chunk']) }); const done = this.onstop; setTimeout(() => done?.(), 0); }
    }
    Object.defineProperty(window, 'MediaRecorder', { value: Recorder });
  }, { backend, snapshot, deny: options.deny });
  await page.route('**/api/state', route => route.fulfill({ json: { ...seed, demo: false, sessions: [contact], groups: [], activities: [], backends: seed.backends.map(item => ({ ...item, installed: true, capabilities: { ...item.capabilities, terminal: true, graphicalChat: true } })) } }));
  await page.route('**/api/config', route => route.fulfill({ json: { csrfToken: 'test-token' } }));
  await page.route('**/api/sessions/' + contact.id + '/read', route => route.fulfill({ json: contact }));
  await page.route('**/api/sessions/' + contact.id + '/conversation', route => route.fulfill({ json: { messages: [], truncated: false } }));
  await page.route('**/api/sessions/' + contact.id + '/chat', route => route.fulfill({ json: snapshot }));
  await page.route('**/api/sessions/' + contact.id + '/voice', route => route.fulfill({ json: { installed: options.installed !== false, enabled: options.installed !== false, phase: 'ready', maxSeconds: 120, message: '' } }));
  const traffic: { controls: string[]; audio: string[]; send?: (message: object) => void; disconnected: boolean } = { controls: [], audio: [], disconnected: false };
  await page.routeWebSocket(/\/api\/sessions\/[^/]+\/voice\?/, ws => {
    traffic.send = message => ws.send(JSON.stringify(message));
    ws.onClose(() => { traffic.disconnected = true; });
    ws.onMessage(message => {
      if (typeof message !== 'string') { traffic.audio.push(message.toString()); return; }
      const control = JSON.parse(message); traffic.controls.push(control.type);
      if (control.type === 'start' && !options.holdReady) ws.send(JSON.stringify({ type: 'ready' }));
      if (control.type === 'stop') ws.send(JSON.stringify({ type: 'transcript', text: '你好世界', final: true }));
    });
  });
  let sends = 0;
  await page.route(/\/api\/sessions\/[^/]+\/(input|chat\/messages)$/, route => { if (route.request().method() === 'POST') sends++; return route.fulfill({ json: { generation: 'voice-generation', directSubmit: true, status: 'accepted', submitted: true } }); });
  await page.goto('/#/contacts?session=' + contact.id);
  const input = page.getByLabel(backend === 'dsh' ? '原生会话消息草稿' : backend === 'claude' ? '给 Claude 发送消息' : '给 Codex 发送消息');
  await expect(input).toBeVisible();
  return { input, traffic, sends: () => sends, stats: () => page.evaluate(() => (window as unknown as { voiceStats: { opened: number; stopped: number } }).voiceStats) };
}

for (const backend of ['codex', 'claude', 'dsh'] as const) {
  test(`${backend} streams speech separately, preserves edits, appends once and never auto sends`, async ({ page }) => {
    const app = await fixture(page, backend);
    await app.input.fill('已有草稿');
    await page.getByRole('button', { name: '语音输入', exact: true }).click();
    await expect(page.getByRole('button', { name: '结束录音', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
    app.traffic.send!({ type: 'transcript', text: '你好', final: false });
    await expect(page.locator('.voice-transcript')).toHaveText('你好');
    await expect(app.input).toHaveValue('已有草稿');
    app.traffic.send!({ type: 'transcript', text: '你好世', final: false });
    await expect(page.locator('.voice-transcript')).toHaveText('你好世');
    await app.input.fill('录音期间修改后的草稿');
    await page.getByRole('button', { name: '结束录音', exact: true }).click();
    await expect(app.input).toHaveValue('录音期间修改后的草稿\n你好世界');
    expect(app.sends()).toBe(0);
    expect(app.traffic.audio).toEqual(['first opus chunk', 'last opus chunk']);
    expect(app.traffic.controls).toEqual(['start', 'stop']);
    expect((await app.stats()).stopped).toBeGreaterThan(0);
    await page.reload(); await expect(app.input).toHaveValue('录音期间修改后的草稿\n你好世界');
  });
}

test('canceling speech drops partial and late results and releases microphone on session exit', async ({ page }) => {
  const app = await fixture(page, 'claude'); await app.input.fill('保留我的草稿');
  await page.getByRole('button', { name: '语音输入', exact: true }).click();
  await expect(page.getByRole('button', { name: '结束录音', exact: true })).toBeVisible();
  app.traffic.send!({ type: 'transcript', text: '要取消的部分', final: false });
  await expect(page.locator('.voice-transcript')).toBeVisible();
  await page.getByRole('button', { name: '取消录音', exact: true }).click();
  app.traffic.send!({ type: 'transcript', text: '迟到的结果', final: true });
  await expect(app.input).toHaveValue('保留我的草稿'); await expect(page.locator('.voice-transcript')).toHaveCount(0);
  expect((await app.stats()).stopped).toBeGreaterThan(0);
  await page.getByRole('button', { name: '语音输入', exact: true }).click();
  await expect(page.getByRole('button', { name: '结束录音', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '关闭会话', exact: true }).click();
  await expect.poll(async () => (await app.stats()).stopped).toBeGreaterThan(1);
  expect(app.sends()).toBe(0);
});

test('uninstalled plugin and microphone denial show dismissible errors without losing drafts', async ({ page }) => {
  const app = await fixture(page, 'dsh', { installed: false }); await app.input.fill('不能丢');
  await page.getByRole('button', { name: '语音输入', exact: true }).click();
  await expect(page.locator('.voice-error')).toContainText('安装并启用');
  await expect(app.input).toHaveValue('不能丢'); expect((await app.stats()).opened).toBe(0);
  await page.getByRole('button', { name: '关闭语音提示', exact: true }).click(); await expect(page.locator('.voice-error')).toHaveCount(0);
});

test('permission denial leaves the composer usable and no microphone open', async ({ page }) => {
  const app = await fixture(page, 'codex', { deny: true }); await app.input.fill('拒绝权限也保留');
  await page.getByRole('button', { name: '语音输入', exact: true }).click();
  await expect(page.locator('.voice-error')).toContainText('麦克风权限被拒绝');
  await expect(app.input).toHaveValue('拒绝权限也保留');
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled();
});

test('mobile live transcript and recording controls fit and remain visible', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const app = await fixture(page, 'claude');
  await page.getByRole('button', { name: '语音输入', exact: true }).click();
  await expect(page.getByRole('button', { name: '结束录音', exact: true })).toBeVisible();
  app.traffic.send!({ type: 'transcript', text: '这是手机上的实时语音识别预览', final: false });
  await expect(page.locator('.voice-transcript')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/voice-mobile.png' });
  await page.getByRole('button', { name: '取消录音', exact: true }).click();
});

test('voice settings offer opt-in install and demo server refuses changes', async ({ page, request }) => {
  await page.goto('/#/backends');
  const settings = page.getByRole('region', { name: '语音输入设置' });
  await expect(settings).toContainText('默认不安装'); await expect(settings).toContainText('未安装');
  await expect(settings.getByRole('button', { name: '安装并启用 FunASR' })).toBeDisabled();
  const token = (await (await request.get('/api/config')).json()).csrfToken;
  for (const path of ['/api/voice', '/api/voice/install', '/api/voice/warmup']) {
    const response = await request.post(path, { data: { enabled: true }, headers: { 'X-SessionDeck-Token': token } });
    expect(response.status()).toBe(409);
  }
});

test('recognition errors preserve partial text for explicit recovery without changing the editor', async ({ page }) => {
  const app = await fixture(page, 'claude'); await app.input.fill('原有内容');
  await page.getByRole('button', { name: '语音输入', exact: true }).click();
  await expect(page.getByRole('button', { name: '结束录音', exact: true })).toBeVisible();
  app.traffic.send!({ type: 'transcript', text: '部分识别结果', final: false });
  app.traffic.send!({ type: 'error', error: '模拟连接失败' });
  await expect(page.locator('.voice-error')).toContainText('模拟连接失败');
  await expect(app.input).toHaveValue('原有内容');
  await page.getByRole('button', { name: '插入已识别文字', exact: true }).click();
  await expect(app.input).toHaveValue('原有内容\n部分识别结果');
  expect(app.sends()).toBe(0);
});

test('full drafts keep the final result recoverable instead of truncating either text', async ({ page }) => {
  const app = await fixture(page, 'codex'); const full = 'a'.repeat(30000); await app.input.fill(full);
  await page.getByRole('button', { name: '语音输入', exact: true }).click();
  await expect(page.getByRole('button', { name: '结束录音', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '结束录音', exact: true }).click();
  await expect(page.locator('.voice-error')).toContainText('输入框已满');
  await expect(page.locator('.voice-transcript')).toHaveText('你好世界');
  await expect(app.input).toHaveValue(full);
  await app.input.fill('腾出空间');
  await page.getByRole('button', { name: '插入已识别文字', exact: true }).click();
  await expect(app.input).toHaveValue('腾出空间\n你好世界'); expect(app.sends()).toBe(0);
});

test('canceling during model load closes the connection and microphone before any audio is sent', async ({ page }) => {
  const app = await fixture(page, 'dsh', { holdReady: true });
  await app.input.fill('加载时保留'); await page.getByRole('button', { name: '语音输入', exact: true }).click();
  await expect.poll(() => app.traffic.controls).toEqual(['start']);
  await page.getByRole('button', { name: '取消录音', exact: true }).click();
  await expect.poll(() => app.traffic.disconnected).toBe(true);
  expect(app.traffic.audio).toEqual([]); expect((await app.stats()).stopped).toBeGreaterThan(0);
  await expect(app.input).toHaveValue('加载时保留');
});

test('voice transcript respects interface zoom and stays above recording controls', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('dili.interface-zoom', '200'));
  await fixture(page, 'claude');
  await page.getByRole('button', { name: '语音输入', exact: true }).click();
  await expect(page.getByRole('button', { name: '结束录音', exact: true })).toBeVisible();
  const popup = page.locator('.voice-result'); await expect(popup).toBeVisible();
  const bounds = await popup.boundingBox(); expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(1440);
  await page.getByRole('button', { name: '取消录音', exact: true }).click();
});
