import { mutationHeaders, test } from './fixtures';
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import type { AppState, ConversationTranscript, Session } from '../shared/types';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

async function createSession(request: APIRequestContext, title: string): Promise<Session> {
  const state = await (await request.get('/api/state')).json() as AppState;
  const headers = await mutationHeaders(request);
  const response = await request.post('/api/sessions', { data: { backend: 'codex', title, cwd: state.defaultCwd }, headers });
  expect(response.ok(), 'create a demo contact').toBeTruthy();
  return await response.json() as Session;
}

async function startSession(request: APIRequestContext, id: string) {
  const headers = await mutationHeaders(request);
  const response = await request.post(`/api/sessions/${id}/start`, { data: {}, headers });
  expect(response.ok(), 'start the demo agent process').toBeTruthy();
}

async function openTerminal(page: Page, request: APIRequestContext, session: Session) {
  await startSession(request, session.id);
  await page.goto(`/#/contacts?session=${session.id}`);
  await expect(page.locator('.terminal-connection')).toHaveText('已连接');
  await expect(page.getByRole('button', { name: '停止进程', exact: true })).toBeVisible();
}

test('touch screens keep every editable field at 16px so iOS never zooms on focus', async ({ page }) => {
  await page.goto('/#/contacts');
  const search = page.getByLabel('搜索联系人');
  await search.focus();
  expect(await search.evaluate(node => parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(16);
  await page.getByRole('button', { name: '新建', exact: true }).click();
  await page.getByRole('menuitem', { name: '新建联系人', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建会话联系人' });
  const name = dialog.getByLabel('联系人名称');
  await name.focus();
  const sizes = await dialog.locator('input:visible, textarea:visible, select:visible').evaluateAll(nodes => nodes.map(node => ({
    tag: node.tagName.toLowerCase(),
    type: (node as HTMLInputElement).type,
    size: parseFloat(getComputedStyle(node).fontSize),
  })));
  expect(sizes.length).toBeGreaterThan(1);
  for (const field of sizes) {
    if (['checkbox', 'radio', 'range'].includes(field.type)) continue;
    expect(field.size, `${field.tag}[${field.type}] must not trigger iOS focus zoom`).toBeGreaterThanOrEqual(16);
  }
});

test('a hidden page pauses conversation polling and resumes on return', async ({ page }) => {
  const session = await createSession(page.request, '隐藏页轮询边界');
  const transcript: ConversationTranscript = { messages: [{ id: 'user-1', role: 'user', text: '移动端轮询检查' }], truncated: false };
  await page.route(`**/api/sessions/${session.id}/conversation`, route => route.fulfill({ json: transcript }));
  let requests = 0;
  page.on('request', request => { if (request.url().includes(`/sessions/${session.id}/conversation`)) requests++; });
  await openTerminal(page, page.request, session);
  await page.getByRole('button', { name: '对话记录', exact: true }).click();
  await expect(page.locator('.conversation-text')).toHaveText('移动端轮询检查');
  await expect.poll(() => requests).toBeGreaterThan(0);

  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(400);
  const hidden = requests;
  await page.waitForTimeout(4000);
  expect(requests, 'no conversation poll while the tab is hidden').toBe(hidden);

  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => requests, { timeout: 5000 }).toBeGreaterThan(hidden);
});

test('the terminal exposes its extra keys as real touch buttons', async ({ page }) => {
  const session = await createSession(page.request, '移动端终端附加键');
  const sent: string[] = [];
  page.on('websocket', socket => {
    if (!socket.url().includes('/api/terminal/')) return;
    socket.on('framesent', ({ payload }) => {
      try { const message = JSON.parse(String(payload)); if (message.type === 'input') sent.push(message.data); } catch { /* binary frame */ }
    });
  });
  await openTerminal(page, page.request, session);
  const keys = page.getByRole('group', { name: '快捷按键' });
  await expect(keys).toBeVisible();
  // The terminal connects before the agent process announces running; the keys
  // must enable on their own once both gates are open.
  await expect(keys.getByRole('button', { name: '发送 Esc', exact: true })).toBeEnabled({ timeout: 15_000 });
  for (const name of ['发送 Tab', '上一条', '下一条', '发送 Ctrl+C', '发送回车']) {
    await expect(keys.getByRole('button', { name, exact: true })).toBeEnabled();
  }
  await keys.getByRole('button', { name: '发送 Esc', exact: true }).click();
  await expect.poll(() => sent).toContain('\u001b');
  // The keys are inside the viewport, not clipped below the keyboard-sized shell.
  const bounds = await keys.boundingBox();
  expect(bounds!.y).toBeGreaterThan(0);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(846);
});

test('pulling the contact list down refreshes it and shows a spinner', async ({ page }) => {
  await page.goto('/#/contacts');
  await expect(page.locator('.contact-grid')).toBeVisible();
  let reads = 0, release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/state', async route => { reads++; await held; await route.continue(); });
  const touch = await page.context().newCDPSession(page);
  const send = (type: string, y?: number) => touch.send('Input.dispatchTouchEvent', { type: type as 'touchStart', touchPoints: y === undefined ? [] : [{ x: 195, y }] });
  const box = (await page.locator('.contact-grid').boundingBox())!;
  const pull = async (to: number) => {
    await send('touchStart', box.y + 10);
    for (let y = box.y + 10; y <= box.y + to; y += 20) await send('touchMove', y);
  };
  // Too short a pull springs back without reading anything.
  await pull(60);
  await expect(page.locator('.pull-refresh')).toContainText('下拉刷新');
  await send('touchEnd');
  await expect(page.locator('.pull-refresh svg')).toHaveCount(0);
  expect(reads).toBe(0);
  await pull(200);
  await expect(page.locator('.pull-refresh')).toContainText('松开刷新');
  await send('touchEnd');
  await expect(page.locator('.pull-refresh[role="status"]')).toContainText('正在刷新');
  await expect(page.locator('.pull-refresh .spin')).toBeVisible();
  expect(reads).toBe(1);
  release();
  await expect(page.locator('.pull-refresh svg')).toHaveCount(0);
});
