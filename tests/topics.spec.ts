import { mutationHeaders, test } from './fixtures';
import { expect, type APIRequestContext } from '@playwright/test';
import type { AppState, Group, Session } from '../shared/types';

async function seedTopic(request: APIRequestContext, title: string) {
  const headers = await mutationHeaders(request);
  const topic = await (await request.post('/api/groups', { data: { kind: 'topic', title, goal: '原帖：要讨论的事' }, headers })).json() as Group;
  const state = await (await request.get('/api/state')).json() as AppState;
  const source = state.sessions.find(session => session.nativeSessionId && !session.groupId && !session.archived)!;
  const response = await request.post(`/api/sessions/${source.id}/fork`, { data: { title: `${title} 参与者`, groupId: topic.id, placement: 'directory', briefing: 'none' }, headers });
  expect(response.ok(), 'fork a demo contact into the topic').toBeTruthy();
  const member = await response.json() as Session;
  await request.post(`/api/groups/${topic.id}/messages`, { data: { text: '原帖：要讨论的事', kind: 'task', recipientIds: [member.id] }, headers });
  // A note naming nobody would wake 嘀哩; address the participant instead.
  await request.post(`/api/groups/${topic.id}/messages`, { data: { text: '第一条想法', kind: 'task', recipientIds: [member.id] }, headers });
  // Two shared results from one participant within five minutes merge.
  for (const text of ['参与者的结论', '紧接着补充一句']) await request.post(`/api/groups/${topic.id}/messages`, { data: { text, kind: 'result', senderId: member.id, recipientIds: [] }, headers });
  return { topic, member };
}

test('topics read like channels: categories, flat merged messages, pinned post and a member column', async ({ page, request }) => {
  const { topic, member } = await seedTopic(request, `频道-${Date.now()}`);
  await page.goto('/#/topics');
  const channel = page.locator('.topic-channel', { hasText: topic.title });
  await expect(channel).toBeVisible();
  // Grouped under the participant's working directory.
  const category = page.locator('.topic-category', { has: channel });
  await expect(category.locator('.topic-category-head')).toHaveAttribute('title', member.cwd);
  await channel.locator('.topic-channel-main').click();
  await expect(page).toHaveURL(new RegExp(`#/topics/${topic.id}$`));
  const view = page.locator('.topic-channel-view');
  await expect(view.locator('.topic-opening-row')).toContainText('发布了话题');
  // One sender within five minutes: the second note continues the first.
  await expect(view.locator('.group-message.continued')).toHaveCount(1);
  // Flat flow: my messages are left aligned like everyone else's.
  const mine = view.locator('.group-message.mine').first();
  expect(await mine.evaluate(element => getComputedStyle(element).flexDirection)).toBe('row');
  await view.getByRole('button', { name: '展开原帖' }).click();
  await expect(view.locator('.topic-pinned-post')).toContainText('原帖：要讨论的事');
  await expect(view.locator('.topic-members')).toContainText(member.title);
  // The member column folds and stays folded.
  await view.getByRole('button', { name: '显示或隐藏参与者栏' }).click();
  await expect(view.locator('.topic-members')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.topic-channel-view .topic-members')).toHaveCount(0);
  await page.locator('.topic-channel-view').getByRole('button', { name: '显示或隐藏参与者栏' }).click();
  // Participants are also contacts.
  await page.goto('/#/contacts');
  await expect(page.locator('.session-card', { hasText: member.title })).toBeVisible();
});

test('a topic message that names nobody is answered by 嘀哩; without a model it says how to set one up', async ({ page, request }) => {
  const { topic } = await seedTopic(request, `嘀哩-${Date.now()}`);
  await page.goto(`/#/topics/${topic.id}`);
  const view = page.locator('.topic-channel-view');
  await expect(view.locator('.group-message.mine').first()).toBeVisible();
  await view.getByRole('textbox', { name: '回复话题' }).fill('嘀哩，现在进展如何？');
  await view.getByRole('textbox', { name: '回复话题' }).press('Enter');
  const answer = view.locator('.group-message.coordinator').last();
  await expect(answer).toContainText('嘀哩');
  await expect(answer).toContainText('配置 API');
  await expect(answer.locator('.coordinator-avatar')).toBeVisible();
  // It is not addressed to the participant.
  await expect(view.locator('.group-message.mine', { hasText: '嘀哩，现在进展如何？' }).locator('.message-recipients')).toHaveCount(0);
});

test('IM settings show both channels; Feishu credentials are validated locally', async ({ page }) => {
  await page.goto('/#/backends');
  const card = page.getByRole('region', { name: 'IM 接入：在微信、飞书里找嘀哩' });
  await expect(card).toContainText('微信 ClawBot');
  await expect(card).toContainText('飞书机器人');
  await expect(card).toContainText('嘀哩还没有可用的模型');
  await card.getByLabel('App ID').fill('not-an-id');
  await card.getByLabel('App Secret').fill('secret');
  await card.getByRole('button', { name: '保存并连接' }).click();
  await expect(card.getByRole('alert')).toContainText(/演示模式不连接 IM|App ID 应以 cli_ 开头/);
  await page.screenshot({ path: 'artifacts/im-settings.png', fullPage: true });
});
