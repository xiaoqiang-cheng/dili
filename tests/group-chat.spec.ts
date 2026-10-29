import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, mutationHeaders } from './fixtures';
import { expect } from '@playwright/test';
import type { AppState, Group, Session } from '../shared/types';

async function createGroup(request: import('@playwright/test').APIRequestContext, title: string) {
  const headers = await mutationHeaders(request);
  const state = await (await request.get('/api/state')).json() as AppState;
  const group = await (await request.post('/api/groups', { data: { title, goal: '验证群聊体验' }, headers })).json() as Group;
  const members: Session[] = [];
  for (const [backend, name] of [['claude', '方案成员'], ['codex', '实现成员'], ['dsh', '验证成员']] as const) {
    members.push(await (await request.post('/api/sessions', { data: { backend, title: `${title}·${name}`, cwd: state.defaultCwd, groupId: group.id }, headers })).json() as Session);
  }
  await request.post(`/api/groups/${group.id}/messages`, { data: { kind: 'result', text: '方案成员的结论', senderId: members[0].id }, headers });
  await request.post(`/api/groups/${group.id}/messages`, { data: { kind: 'note', text: '我的记录' }, headers });
  return { group, members };
}

test('groups are contact-list cards with a tiled avatar; "+" starts a group chat with its prompt', async ({ page }) => {
  const { group } = await createGroup(page.request, '列表群聊');
  await page.goto('/#/contacts');
  const card = page.locator('.group-card').filter({ hasText: '列表群聊' });
  await expect(card).toBeVisible();
  await expect(card.locator('.group-avatar-grid .backend-avatar')).toHaveCount(3);
  await expect(card.locator('.group-avatar-mark')).toHaveText('群');
  await expect(card).toContainText('你：我的记录');
  await expect(page.getByRole('navigation', { name: '协作群组' })).toHaveCount(0);

  await card.getByRole('button', { name: '进入群聊 列表群聊' }).click();
  await expect(page).toHaveURL(new RegExp(`groups/${group.id}`));
  await expect(card).toBeVisible();
  await expect(page.getByLabel('群组消息')).toBeVisible();

  await page.getByRole('button', { name: '新建', exact: true }).click();
  await page.getByRole('menuitem', { name: '发起群聊', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '创建协作群组' });
  await expect(dialog.getByLabel('群 prompt')).toHaveValue(/你对任务的最后回答会自动显示在群里/);
  await dialog.getByLabel('群组名称').fill('新建群聊回归');
  await dialog.getByRole('button', { name: '创建群组', exact: true }).click();
  await expect(page.locator('.group-card').filter({ hasText: '新建群聊回归' })).toBeVisible();
  await page.getByRole('button', { name: '添加成员', exact: true }).first().click();
  const member = page.getByRole('dialog', { name: '添加群组成员' });
  // The new group took the default directory as its workspace: members share it by default.
  await expect(member.getByRole('radio', { name: /^群工作区/ })).toBeChecked();
  await expect(member.getByRole('radio', { name: /独立工作树/ })).toBeVisible();
  await expect(member.getByLabel('工作目录', { exact: true })).toBeHidden();
  await member.getByRole('radio', { name: /其他目录/ }).check();
  await expect(member.getByLabel('工作目录', { exact: true })).toBeVisible();
});

test('@ member picker supports keyboard navigation, filtering and confirmation without sending', async ({ page }) => {
  const { group } = await createGroup(page.request, '键盘群聊');
  await page.goto(`/#/groups/${group.id}`);
  const composer = page.getByLabel('群组消息');
  const menu = page.getByRole('listbox', { name: '选择要 @ 的成员' });
  await composer.fill('请@');
  const options = menu.getByRole('option');
  await expect(options).toHaveCount(3);
  await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
  await composer.press('ArrowUp');
  await expect(options.nth(2)).toHaveAttribute('aria-selected', 'true');
  await composer.press('ArrowDown');
  await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
  await composer.press('ArrowDown');
  const selectedName = await options.nth(1).innerText();
  await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
  await composer.press('Enter');
  await expect(menu).toBeHidden();
  await expect(composer).toHaveValue(`请@${selectedName.trim()} `);
  await composer.press('Backspace');
  await expect(composer).toHaveValue('请');
  await expect(page.locator('.recipient-picker').getByRole('button', { name: selectedName.trim() })).toHaveAttribute('aria-pressed', 'false');
  await composer.fill('请@');
  await composer.press('ArrowDown');
  await composer.press('Enter');
  await expect(page.locator('.recipient-picker').getByRole('button', { name: selectedName.trim() })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.group-message').filter({ hasText: '请' })).toHaveCount(0);
  await composer.fill('请@验证');
  await expect(menu.getByRole('option')).toHaveAttribute('aria-selected', 'true');
  await composer.press('Escape');
  await expect(menu).toBeHidden();
  await expect(composer).toHaveValue('请@验证');
});

test('inline @ survives draft reload and deleting it restores default routing while preserving text', async ({ page }) => {
  const { group, members } = await createGroup(page.request, '行内指派');
  await page.goto(`/#/groups/${group.id}`);
  const composer = page.getByLabel('群组消息');
  const recipient = page.locator('.recipient-picker').getByRole('button', { name: members[0].title });
  await composer.fill('保留正文');
  await recipient.click();
  await expect(composer).toHaveValue(`@${members[0].title} 保留正文`);
  await page.reload();
  await expect(composer).toHaveValue(`@${members[0].title} 保留正文`);
  await expect(recipient).toHaveAttribute('aria-pressed', 'true');
  await composer.focus();
  await composer.press('Home');
  await composer.press('Delete');
  await expect(composer).toHaveValue('保留正文');
  await expect(recipient).toHaveAttribute('aria-pressed', 'false');
  const sent = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith(`/groups/${group.id}/messages`));
  await composer.press('End');
  await composer.press('Enter');
  const body = (await sent).postDataJSON();
  expect(body.recipientIds).toEqual([members[0].id]);
  expect(body.kind).toBe('task');
  expect(body.text).toBe('保留正文');
});

test('only-one-member filter, @ mention, quote chips and split columns', async ({ page }) => {
  const { group, members } = await createGroup(page.request, '过滤群聊');
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(`/#/groups/${group.id}`);
  await expect(page.getByText('方案成员的结论')).toBeVisible();
  await expect(page.getByText('我的记录', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: `只看 ${members[0].title}` }).click();
  await expect(page.locator('.group-only-bar')).toContainText(members[0].title);
  await expect(page.getByText('方案成员的结论')).toBeVisible();
  await expect(page.getByText('我的记录', { exact: true })).toBeHidden();
  await page.getByRole('button', { name: '查看全部' }).click();
  await expect(page.getByText('我的记录', { exact: true })).toBeVisible();

  const composer = page.getByLabel('群组消息');
  // No space is needed before "@".
  await composer.fill('请@实现');
  await page.getByRole('listbox', { name: '选择要 @ 的成员' }).getByRole('option', { name: /实现成员/ }).click();
  await expect(composer).toHaveValue(`请@${members[1].title} `);
  await expect(page.locator('.recipient-picker').getByRole('button', { name: /实现成员/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: '发送任务', exact: true })).toBeVisible();
  await page.locator('.group-message.kind-result').getByRole('button', { name: '引用' }).click();
  await expect(page.locator('.composer-references')).toContainText('方案成员的结论');

  // Enter sends; Shift+Enter is a newline.
  await composer.fill('');
  await expect(page.locator('.recipient-picker').getByRole('button', { name: /实现成员/ })).toHaveAttribute('aria-pressed', 'false');
  await composer.pressSequentially('第一行');
  await composer.press('Shift+Enter');
  await composer.pressSequentially('第二行');
  await expect(composer).toHaveValue('第一行\n第二行');
  await page.locator('.recipient-picker').getByRole('button', { name: /实现成员/ }).click();
  await composer.fill('一条记录');
  await composer.press('Enter');
  await expect(page.getByText('一条记录', { exact: true })).toBeVisible();
  await expect(composer).toHaveValue('');
  await expect(page.locator('.toast')).toHaveCount(0);

  await page.getByRole('button', { name: '全屏群聊' }).click();
  await expect(page.locator('.group-chat.group-fullscreen')).toBeVisible();
  expect((await page.locator('.group-chat').boundingBox())!.width).toBe(1600);
  await composer.press('Escape');
  await expect(page.locator('.group-fullscreen')).toHaveCount(0);

  await page.getByRole('button', { name: '一键分栏' }).click();
  await expect(page.locator('.group-split-pane')).toHaveCount(3);
  await page.screenshot({ path: 'artifacts/group-split.png' });
  await page.getByRole('button', { name: '退出分栏' }).click();
  await expect(page.locator('.group-timeline')).toBeVisible();
});

test('reading a group clears reply and member badges through HTTP even while the live stream is stalled', async ({ page }) => {
  const { group, members } = await createGroup(page.request, '已读响应回归');
  const state = await (await page.request.get('/api/state')).json() as AppState;
  const current = state.groups.find(item => item.id === group.id)!;
  current.unread = 2;
  const member = state.sessions.find(item => item.id === members[0].id)!;
  member.status = 'waiting_input'; member.unread = 2;
  await page.addInitScript(() => {
    const visibility = { value: 'hidden' };
    Object.assign(window, { testGroupVisibility: visibility });
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility.value });
  });
  let holdRefresh = false;
  let releaseRefresh!: () => void;
  const refreshGate = new Promise<void>(resolve => { releaseRefresh = resolve; });
  await page.route('**/api/state', async route => {
    if (holdRefresh) await refreshGate;
    return route.fulfill({ json: state });
  });
  await page.route('**/api/events', route => route.fulfill({ contentType: 'text/event-stream', body: `retry: 60000\nevent: state\ndata: ${JSON.stringify(state)}\n\n` }));
  let reads = 0;
  await page.route(`**/api/groups/${group.id}/read`, route => {
    reads++;
    return route.fulfill({ json: { ...current, unread: 0, instanceId: state.instanceId, revision: state.revision,
      members: state.sessions.filter(item => item.groupId === group.id).map(item => ({ id: item.id, unread: 0, updatedAt: item.updatedAt })) } });
  });
  await page.goto('/#/contacts');
  const card = page.locator('.group-card').filter({ hasText: group.title });
  await expect(card.locator('.unread-badge')).toHaveText('2');
  await card.getByRole('button', { name: `进入群聊 ${group.title}` }).click();
  await expect(page.getByLabel('群组消息')).toBeVisible();
  await expect(card.locator('.unread-badge')).toHaveText('2');
  expect(reads).toBe(0);
  holdRefresh = true;
  const staleRefresh = page.waitForResponse(response => response.url().endsWith('/api/state'));
  await page.evaluate(() => {
    (window as unknown as { testGroupVisibility: { value: string } }).testGroupVisibility.value = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
  });
  try {
    await expect.poll(() => reads).toBeGreaterThan(0);
    await expect(card.locator('.unread-badge')).toHaveCount(0);
  } finally { releaseRefresh(); }
  await staleRefresh;
  // Let the stale snapshot finish applying; it must not resurrect the badge.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(card.locator('.unread-badge')).toHaveCount(0);
});

for (const phone of [false, true]) {
  for (const unread of [0, 2]) {
    test(`group message badge excludes member errors and approvals (${phone ? 'phone' : 'desktop'}, ${unread} unread)`, async ({ page }) => {
      if (phone) await page.setViewportSize({ width: 390, height: 844 });
      const { group, members } = await createGroup(page.request, `消息和状态分离-${phone ? '手机' : '桌面'}-${unread}`);
      const state = await (await page.request.get('/api/state')).json() as AppState;
      const current = state.groups.find(item => item.id === group.id)!;
      current.unread = unread;
      for (const member of state.sessions.filter(item => item.groupId === group.id)) {
        member.status = 'idle'; member.unread = 0;
      }
      const error = state.sessions.find(item => item.id === members[0].id)!;
      error.status = 'error'; error.unread = 1;
      const approval = state.sessions.find(item => item.id === members[1].id)!;
      approval.status = 'waiting_approval'; approval.unread = 1;
      await page.addInitScript(() => {
        Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true });
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      });
      // Freeze SSE to verify the read receipt updates the card on its own.
      await page.route('**/api/state', route => route.fulfill({ json: state }));
      await page.route('**/api/events', route => route.fulfill({ contentType: 'text/event-stream', body: `retry: 60000\nevent: state\ndata: ${JSON.stringify(state)}\n\n` }));
      let reads = 0;
      await page.route(`**/api/groups/${group.id}/read`, route => {
        reads++;
        return route.fulfill({ json: { ...current, unread: 0, instanceId: state.instanceId, revision: state.revision,
          members: state.sessions.filter(item => item.groupId === group.id).map(item => ({ id: item.id, unread: item.unread, updatedAt: item.updatedAt })) } });
      });
      await page.goto('/#/contacts');
      const card = page.locator('.group-card').filter({ hasText: group.title });
      const status = card.locator('.card-state');
      await expect(status).toHaveText('异常 1 · 待审批 1');
      if (unread) await expect(card.locator('.unread-badge')).toHaveText(String(unread));
      else await expect(card.locator('.unread-badge')).toHaveCount(0);
      await page.screenshot({ path: `artifacts/group-read-status-${phone ? 'phone' : 'desktop'}.png` });
      await card.getByRole('button', { name: `进入群聊 ${group.title}` }).click();
      await expect(page.getByLabel('群组消息')).toBeVisible();
      if (unread) await expect.poll(() => reads).toBeGreaterThan(0);
      if (phone) await page.getByRole('button', { name: '返回联系人列表', exact: true }).click();
      await expect(card.locator('.unread-badge')).toHaveCount(0);
      // Unresolved native actions remain visible as status, never as unread messages.
      await expect(status).toHaveText('异常 1 · 待审批 1');
    });
  }
}

test.describe('phone group chat', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test('opens full screen with a back button and splits into member tabs', async ({ page }) => {
    const { group } = await createGroup(page.request, '手机群聊');
    await page.goto('/#/contacts');
    await page.getByRole('button', { name: '进入群聊 手机群聊' }).click();
    await expect(page).toHaveURL(new RegExp(`groups/${group.id}`));
    await expect(page.locator('.contacts-pane')).toBeHidden();
    await expect(page.getByLabel('群组消息')).toBeInViewport();
    const toolbar = page.locator('.group-composer .attachment-actions');
    const imageButton = await toolbar.getByRole('button', { name: '添加图片', exact: true }).boundingBox();
    const voiceButton = await toolbar.getByRole('button', { name: '语音输入', exact: true }).boundingBox();
    const sendButton = await toolbar.getByRole('button', { name: '发送任务', exact: true }).boundingBox();
    expect(imageButton && voiceButton && sendButton).toBeTruthy();
    expect(Math.abs(imageButton!.y + imageButton!.height / 2 - voiceButton!.y - voiceButton!.height / 2)).toBeLessThan(2);
    expect(Math.abs(imageButton!.y + imageButton!.height / 2 - sendButton!.y - sendButton!.height / 2)).toBeLessThan(2);

    await page.getByRole('button', { name: '一键分栏' }).click();
    await expect(page.getByRole('tab')).toHaveCount(3);
    await expect(page.locator('.group-split-pane')).toHaveCount(1);
    await page.getByRole('button', { name: '返回联系人列表' }).click();
    await expect(page.locator('.group-card').filter({ hasText: '手机群聊' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});

test('confirmed inline @ is routing only and is excluded from submitted task text', async ({ page }) => {
  const { group, members } = await createGroup(page.request, '正文去除指派');
  await page.goto(`/#/groups/${group.id}`);
  const composer = page.getByLabel('群组消息');
  await composer.fill('检查接口');
  await page.locator('.recipient-picker').getByRole('button', { name: members[0].title }).click();
  await expect(composer).toHaveValue(`@${members[0].title} 检查接口`);
  let submitted: Record<string, unknown> | undefined;
  await page.route(`**/api/groups/${group.id}/messages`, async route => {
    if (route.request().method() !== 'POST') return route.continue();
    submitted = route.request().postDataJSON();
    await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'test interception' }) });
  });
  await composer.press('Enter');
  await expect.poll(() => submitted).toBeTruthy();
  expect(submitted!.text).toBe('检查接口');
  expect(submitted!.recipientIds).toEqual([members[0].id]);
  expect(submitted!.kind).toBe('task');
  await composer.fill(`@${members[0].title} `);
  submitted = undefined;
  await composer.press('Enter');
  await expect(page.getByRole('alert').filter({ hasText: '请输入任务正文' })).toBeVisible();
  expect(submitted).toBeUndefined();
});

test('group composer pastes images, restores drafts, sends image-only messages and enforces group scope', async ({ page }) => {
  const { group } = await createGroup(page.request, '图片群聊');
  const other = await createGroup(page.request, '隔离图片群聊');
  await page.goto(`/#/groups/${group.id}`);
  const input = page.getByLabel('群组消息');
  await input.evaluate(element => {
    const clipboardData = new DataTransfer();
    const data = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='), c => c.charCodeAt(0));
    clipboardData.items.add(new File([data], '截图.png', { type: 'image/png' }));
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  });
  await expect(page.getByLabel('待发送图片').locator('img')).toHaveCount(1);
  await page.reload();
  await expect(page.getByLabel('待发送图片').locator('img')).toHaveCount(1);
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.getByLabel('待发送图片')).toHaveCount(0);
  await expect(page.getByLabel('消息图片').locator('img')).toHaveCount(1);
  const detail = await (await page.request.get(`/api/groups/${group.id}`)).json();
  const message = detail.messages.find((item: { attachments?: unknown[] }) => item.attachments?.length);
  expect(message.text).toBe('');
  const id = message.attachments[0].id;
  expect((await page.request.get(`/api/groups/${group.id}/attachments/${id}`)).status()).toBe(200);
  expect((await page.request.get(`/api/groups/${other.group.id}/attachments/${id}`)).status()).toBe(404);
  const headers = await mutationHeaders(page.request);
  expect((await page.request.post(`/api/groups/${other.group.id}/messages`, { headers, data: { text: '不能跨群借用图片', attachments: [id] } })).status()).toBe(404);
  await page.getByRole('button', { name: '语音输入', exact: true }).click();
  await expect(page.locator('.voice-error')).toBeVisible();
  await expect(input).toHaveValue('');
});

test('member avatars open private chat and unmentioned messages follow the last replying member', async ({ page }) => {
  const { group, members } = await createGroup(page.request, '继续对话');
  await page.goto(`/#/groups/${group.id}`);
  await expect(page.getByLabel('群组消息')).toHaveAttribute('placeholder', new RegExp(members[0].title));
  let submitted: { recipientIds: string[]; text: string } | undefined;
  await page.route(`**/api/groups/${group.id}/messages`, async route => {
    if (route.request().method() === 'POST') submitted = route.request().postDataJSON();
    await route.continue();
  });
  await page.getByLabel('群组消息').fill('继续完成');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect.poll(() => submitted?.recipientIds).toEqual([members[0].id]);
  expect(submitted?.text).toBe('继续完成');
  await expect(page.getByLabel('群组消息')).toHaveValue('');
  await page.locator('.recipient-picker').getByRole('button', { name: members[1].title }).click();
  await page.getByLabel('群组消息').fill(`@${members[1].title} 改由你处理`);
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect.poll(() => submitted?.recipientIds).toEqual([members[1].id]);
  expect(submitted?.text).toBe('改由你处理');
  await page.getByRole('button', { name: `打开 ${members[0].title} 的私聊`, exact: true }).first().click();
  await expect(page.getByLabel('群组消息')).toBeHidden();
  await expect(page.locator('.session-drawer')).toBeVisible();
});

test('groups can be archived and restored without losing history or members', async ({ page, request }) => {
  const { group, members } = await createGroup(request, '归档群聊验收');
  await page.goto('/#/contacts');
  const card = page.locator('.group-card').filter({ hasText: group.title });
  await card.getByRole('button', { name: `${group.title} 的更多操作` }).click();
  await card.getByRole('button', { name: '归档群聊', exact: true }).click();
  await expect(card).toHaveCount(0);
  await page.goto('/#/archive');
  await expect(card).toBeVisible();
  await page.reload();
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: `${group.title} 的更多操作` }).click();
  await card.getByRole('button', { name: '恢复群聊', exact: true }).click();
  await expect(card).toHaveCount(0);
  await page.goto('/#/contacts');
  await card.getByRole('button', { name: `进入群聊 ${group.title}` }).click();
  await expect(page.locator('.group-timeline')).toContainText('我的记录');
  const detail = await (await request.get(`/api/groups/${group.id}`)).json();
  expect(detail.group.archived).toBe(false);
  const state = await (await request.get('/api/state')).json() as AppState;
  expect(state.sessions.filter(item => members.some(member => member.id === item.id)).every(item => !item.archived)).toBe(true);
  const headers = await mutationHeaders(request);
  expect((await request.patch(`/api/groups/${group.id}`, { headers, data: { archived: 'true' } })).ok()).toBe(false);
});

test('long group history scrolls independently with a visible scrollbar', async ({ page, request }) => {
  const { group } = await createGroup(request, '长记录滚动验收');
  const headers = await mutationHeaders(request);
  for (let i = 0; i < 24; i++) await request.post(`/api/groups/${group.id}/messages`, { headers, data: { kind: 'note', text: `滚动记录 ${i}\n${'长记录内容\n'.repeat(8)}` } });
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.goto(`/#/groups/${group.id}`);
    const timeline = page.locator('.group-timeline');
    await expect(timeline).toContainText('滚动记录 23');
    await expect.poll(() => timeline.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    await timeline.evaluate(element => { element.scrollTop = 0; });
    expect(await timeline.evaluate(element => ({ top: element.scrollTop, overflow: getComputedStyle(element).overflowY, width: getComputedStyle(element).scrollbarWidth }))).toEqual({ top: 0, overflow: 'scroll', width: 'auto' });
    const composer = await page.locator('.group-composer').boundingBox();
    expect(composer!.y + composer!.height).toBeLessThanOrEqual(viewport.height + 1);
  }
});

test('group questions can be answered inline and private questions stay private', async ({ page }) => {
  const { group, members } = await createGroup(page.request, '群内提问');
  const member = members[1];
  await page.route('**/api/state', async route => {
    const response = await route.fetch();
    const state = await response.json();
    state.sessions.find((item: Session) => item.id === member.id).interactionMode = 'chat';
    await route.fulfill({ response, json: state });
  });
  await page.route(`**/api/groups/${group.id}`, async route => {
    const response = await route.fetch();
    const detail = await response.json();
    detail.deliveries.push({ id: 'question-delivery', sessionId: member.id, messageId: detail.messages[0].id, status: 'sent', tag: 'T-question' });
    await route.fulfill({ response, json: detail });
  });
  let answered = false;
  let privateTurn = false;
  await page.route(`**/api/sessions/${member.id}/chat`, route => route.fulfill({ json: {
    connected: true, nativeSessionId: 'native', revision: 1, activeTurnId: 'turn', truncated: false,
    items: [{ id: 'user', turnId: 'turn', type: 'user', text: privateTurn ? '私聊问题' : '【群聊任务】任务编号：T-question', status: 'completed' }],
    requests: answered ? [] : [{ id: 'question', kind: 'question', title: '确认方案', questions: [{ id: 'choice', header: '方案', question: '选择哪种方案？', options: [{ label: '方案 A', description: '先完成核心功能' }] }] }],
  } }));
  await page.route(`**/api/sessions/${member.id}/chat/requests/question`, async route => {
    expect(route.request().postDataJSON()).toEqual({ answers: { choice: ['方案 A'] } });
    answered = true;
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto(`/#/groups/${group.id}`);
  const question = page.getByRole('region', { name: `${member.title} 提问` });
  await expect(question).toBeVisible();
  await question.getByRole('radio', { name: /方案 A/ }).check();
  await question.getByRole('button', { name: '提交回答' }).click();
  await expect(question).toHaveCount(0);
  privateTurn = true;
  answered = false;
  await page.reload();
  await expect(page.getByLabel('群组消息')).toBeVisible();
  await expect(question).toHaveCount(0);
});


for (const mobile of [false, true]) test(`group workspace bulk grants support partial failure and targeted retry on ${mobile ? 'mobile' : 'desktop'}`, async ({ page }) => {
  if (mobile) await page.setViewportSize({ width: 390, height: 844 });
  const extra = await mkdtemp(join(tmpdir(), 'dili-group-workspace-'));
  try {
    const { group, members } = await createGroup(page.request, `批量授权${mobile ? '手机' : '桌面'}`);
    const [claude, codex, dsh] = members;
    await page.goto(`/#/groups/${group.id}`);
    await page.getByRole('button', { name: '群成员', exact: true }).click();
    await page.getByRole('button', { name: '群工作区权限', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '群工作区权限', exact: true });
    await expect(dialog.getByRole('checkbox', { name: `授权 ${claude.title}`, exact: true })).toBeChecked();
    await expect(dialog.getByRole('checkbox', { name: `授权 ${codex.title}`, exact: true })).toBeChecked();
    await expect(dialog.getByRole('checkbox', { name: `授权 ${dsh.title}`, exact: true })).toBeDisabled();
    await expect(dialog).toContainText('DeepSeek 原生沙箱暂不支持追加目录');
    await dialog.getByRole('button', { name: '取消全选', exact: true }).click();
    await expect(dialog.getByRole('button', { name: /^授权所选成员/ })).toBeDisabled();
    await dialog.getByRole('button', { name: '全选可授权成员', exact: true }).click();
    await dialog.getByLabel('授权目录', { exact: true }).fill(pathToFileURL(extra).href);
    await dialog.getByRole('button', { name: '浏览授权目录', exact: true }).click();
    const picker = page.getByRole('dialog', { name: '选择工作目录', exact: true });
    await expect(picker).toBeVisible();
    await picker.getByRole('button', { name: '选择此目录', exact: true }).click();
    await expect(dialog.getByLabel('授权目录', { exact: true })).toHaveValue(extra);
    const calls: string[][] = [];
    await page.route(`**/api/groups/${group.id}/directories`, async route => {
      const body = route.request().postDataJSON() as { path: string; sessionIds: string[] };
      calls.push(body.sessionIds);
      if (calls.length !== 1) { await route.continue(); return; }
      // Apply Claude's grant on the isolated server; simulate a busy Codex.
      const response = await route.fetch({ postData: JSON.stringify({ ...body, sessionIds: [claude.id] }) });
      const result = await response.json();
      await route.fulfill({ response, json: { ...result, results: [...result.results, { sessionId: codex.id, status: 'failed', error: 'Codex 正在执行，请稍后重试' }] } });
    });
    await dialog.getByRole('button', { name: /^授权所选成员/ }).click();
    await expect(dialog).toContainText('1 位已处理，1 位失败');
    await expect(dialog).toContainText('Codex 正在执行，请稍后重试');
    await expect(dialog).toContainText('已保存，待恢复会话生效');
    await page.screenshot({ path: `artifacts/group-workspace-${mobile ? 'mobile' : 'desktop'}.png` });
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await dialog.getByRole('button', { name: '仅重试失败成员', exact: true }).click();
    await expect(dialog).toContainText('2 位已处理，0 位失败');
    await expect(dialog.getByRole('button', { name: '仅重试失败成员', exact: true })).toHaveCount(0);
    expect(calls).toEqual([[claude.id, codex.id], [codex.id]]);
    const state = await (await page.request.get('/api/state')).json() as AppState;
    for (const member of [claude, codex]) {
      const current = state.sessions.find(item => item.id === member.id)!;
      expect(current.additionalDirectories).toEqual([extra]);
      expect(current.cwd).toBe(member.cwd);
    }
    expect(state.sessions.find(item => item.id === dsh.id)!.additionalDirectories).toBeUndefined();
    await dialog.getByRole('button', { name: '完成', exact: true }).click();
    await expect(dialog).toHaveCount(0);
  } finally { await rm(extra, { recursive: true, force: true }); }
});
