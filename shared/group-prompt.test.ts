import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_GROUP_PROMPT, briefingVersion, buildGroupTask, buildJoinBriefing, groupRules, replyPreview, workspaceRule } from '../shared/group-prompt.ts';
import type { Group } from '../shared/types.ts';

const group: Pick<Group, 'title' | 'goal' | 'prompt' | 'workspace'> = { title: '登录功能', goal: '完成登录', workspace: '/repo' };

test('groupRules fills every placeholder', () => {
  const text = groupRules(group, '实现者', { shared: '/repo', cwd: '/repo' });
  assert.match(text, /群聊「登录功能」/);
  assert.match(text, /成员「实现者」/);
  assert.match(text, /群目标：完成登录/);
  assert.match(text, /共用工作目录 \/repo/);
  assert.doesNotMatch(text, /\{\{(?:group|goal|member|workspace)\}\}/);
});

test('a custom prompt without {{workspace}} still gets the workspace rule', () => {
  const text = groupRules({ ...group, prompt: '只做审查。' }, '审查者', { shared: '/repo', cwd: '/wt', branch: 'dili/g/m-1' });
  assert.match(text, /^只做审查。/);
  assert.match(text, /独立的 Git 工作树/);
  assert.match(text, /分支 dili\/g\/m-1/);
});

test('empty goal falls back to the discussion', () => {
  assert.match(groupRules({ ...group, goal: '  ' }, '成员'), /见群聊讨论/);
});

test('workspaceRule distinguishes shared, separate and worktree members', () => {
  assert.equal(workspaceRule(undefined), '');
  assert.match(workspaceRule({ cwd: '/repo' }), /共用工作目录 \/repo/);
  assert.match(workspaceRule({ cwd: '/other', shared: '/repo' }), /与群工作区 \/repo 不同/);
  assert.match(workspaceRule({ cwd: '/wt', shared: '/repo', branch: 'b' }), /独立的 Git 工作树/);
});

test('briefingVersion changes with settings and workspace', () => {
  const base = briefingVersion(group);
  assert.notEqual(base, briefingVersion({ ...group, goal: '新目标' }));
  assert.notEqual(base, briefingVersion({ ...group, workspace: '/next' }));
  assert.notEqual(base, briefingVersion(group, { cwd: '/wt' }));
  assert.equal(base, briefingVersion({ ...group }));
});

test('buildJoinBriefing lists members and marks recent answers as other work', () => {
  const text = buildJoinBriefing({
    group, member: '实现者', workspace: { cwd: '/repo' }, tag: 'T-abc123', greet: true,
    roster: [{ name: '审查者', backend: 'Claude Code', status: '空闲' }],
    recent: [{ senderName: '审查者', task: '审查方案', text: '方案可行。' }],
  });
  assert.match(text, /【群聊入群说明】任务编号：T-abc123/);
  assert.match(text, /- 审查者（Claude Code，空闲）/);
  assert.match(text, /不是给你的任务/);
  assert.match(text, /打个招呼/);
});

test('buildGroupTask keeps the task header, quotes and full rules only when required', () => {
  const text = buildGroupTask({
    group, member: '实现者', task: '修登录', tag: 'T-abc123',
    references: [{ senderName: '审查者', text: '先加测试。' }],
    includeRules: true,
  });
  assert.match(text, /^【群聊任务】任务编号：T-abc123 · 群「登录功能」/);
  assert.match(text, /## 群说明（已更新）/);
  assert.match(text, /### 审查者 的回答\n先加测试。/);
  assert.match(text, /## 你的任务\n\n修登录$/);
});

test('buildGroupTask reminds worktree members on every task', () => {
  const text = buildGroupTask({ group, member: '实现者', task: 'x', tag: 'T-abc123', workspace: { cwd: '/wt', shared: '/repo', branch: 'b' } });
  assert.match(text, /独立的 Git 工作树/);
});

test('quoted answers are clipped with an explicit notice', () => {
  const text = buildGroupTask({ group, member: '成员', task: 't', tag: 'T-abc123', references: [{ senderName: 'a', text: 'x'.repeat(9000) }] });
  assert.match(text, /内容过长已截断/);
  assert.ok(text.length < 9000);
});

test('replyPreview collapses whitespace and clips', () => {
  assert.equal(replyPreview('a\n\n b\tc'), 'a b c');
  const preview = replyPreview('x'.repeat(500));
  assert.equal(preview.length, 160);
  assert.ok(preview.endsWith('…'));
});

test('default prompt keeps the workspace placeholder', () => {
  assert.ok(DEFAULT_GROUP_PROMPT.includes('{{workspace}}'));
});
