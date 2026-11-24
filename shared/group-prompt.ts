import type { Group, GroupMessage } from './types.ts';

/** Placeholders: {{group}} {{goal}} {{member}} {{workspace}}. Sent in full once,
 * when a member joins (and again after the group settings change). */
export const DEFAULT_GROUP_PROMPT = `你是群聊「{{group}}」中的成员「{{member}}」。群目标：{{goal}}

{{workspace}}

协作规则：
- 群聊里的消息以「【群聊任务】」开头时，就是用户在群里指派给你的任务；你在本会话中的其他上下文仍然有效。
- 群内只共享任务和回答。不要假设其他成员已经完成任务里没有写明的工作；需要依据时，以任务中引用的回答为准，并先核对当前文件状态。
- 不要尝试联系其他成员；需要协作时，在回答中写明需要谁做什么。
- 你对任务的最后回答会自动显示在群里。`;

/** A topic is one focused discussion; participants keep their own directories. */
export const DEFAULT_TOPIC_PROMPT = `你是话题「{{group}}」的参与者「{{member}}」。这个话题是 Dili 话题群里一条独立的讨论线。

{{workspace}}

协作规则：
- 以「【话题】」开头的消息来自这个话题；你在本会话中的其他上下文仍然有效。
- 你对每条话题消息的最后回答会自动显示在话题里。用户也可能直接在本会话里和你对话，这些对话同样会同步到话题。
- 话题里还有其他参与者；需要他们配合时，在回答中写明需要谁做什么，不要假设他们已经完成了没有写明的工作。`;

const TAG = /^T-[0-9a-f]{4,8}$/;
export const isTaskTag = (value: string) => TAG.test(value);
export const taskTagLine = (tag: string) => `任务编号：${tag}`;

/** Where this member works relative to the group workspace. */
export interface MemberWorkspace { shared?: string; cwd: string; branch?: string }

export function workspaceRule(workspace?: MemberWorkspace): string {
  if (!workspace) return '';
  if (workspace.branch) return `工作区：你在独立的 Git 工作树中工作（目录 ${workspace.cwd}，分支 ${workspace.branch}），从群工作区 ${workspace.shared ?? '当前仓库'} 分出。只修改这个工作树；完成后提交你的改动（git commit），由用户决定是否合并回群工作区。`;
  if (workspace.shared && workspace.shared !== workspace.cwd) return `工作区：你的工作目录 ${workspace.cwd} 与群工作区 ${workspace.shared} 不同，其他成员的改动不会出现在你的目录里。`;
  return `工作区：所有成员共用工作目录 ${workspace.cwd}。开始前先查看当前文件和 git 状态，其他成员可能已经修改了文件；不要覆盖或回退他人未提交的改动。`;
}

type GroupSettings = Pick<Group, 'title' | 'goal' | 'prompt'> & Partial<Pick<Group, 'kind'>>;

/** The group prompt with placeholders filled. A custom prompt without the
 * workspace placeholder still tells the member where it works. */
export function groupRules(group: GroupSettings, member: string, workspace?: MemberWorkspace): string {
  const topic = group.kind === 'topic';
  const template = group.prompt?.trim() || (topic ? DEFAULT_TOPIC_PROMPT : DEFAULT_GROUP_PROMPT);
  // Topic participants are forks that keep their own directories; only an
  // isolated worktree is worth pointing out.
  const rule = topic && !workspace?.branch ? '' : workspaceRule(workspace);
  return (template.includes('{{workspace}}') ? template : rule ? `${template}\n\n{{workspace}}` : template)
    .replaceAll('{{group}}', group.title).replaceAll('{{goal}}', group.goal.trim() || '见群聊讨论').replaceAll('{{member}}', member)
    .replaceAll('{{workspace}}', rule).replace(/\n{3,}/g, '\n\n');
}

/** Identifies the rules a member last received; a change triggers a full resend. */
export function briefingVersion(group: GroupSettings & Pick<Group, 'workspace'>, workspace?: MemberWorkspace): string {
  const value = JSON.stringify([group.title, group.goal, group.prompt ?? '', group.workspace ?? '', workspace?.cwd ?? '', workspace?.branch ?? '']);
  let hash = 0;
  for (let index = 0; index < value.length; index++) hash = (Math.imul(hash, 31) + value.charCodeAt(index)) | 0;
  return (hash >>> 0).toString(16);
}

export interface RosterEntry { name: string; backend: string; status: string }
export interface RecentAnswer { senderName: string; task: string; text: string }

const MAX_RECENT = 1200;
const clip = (text: string, max: number) => { const value = text.trim(); return value.length > max ? value.slice(0, max - 1) + '…' : value; };

/** The one-time join message: full rules, members, and recent answers that are
 * explicitly other members' finished work, not tasks for this member. */
export function buildJoinBriefing({ group, member, workspace, roster, recent, tag, greet }: {
  group: GroupSettings; member: string; workspace?: MemberWorkspace; roster: RosterEntry[]; recent: RecentAnswer[]; tag: string; greet: boolean;
}): string {
  const members = roster.length ? roster.map(entry => `- ${entry.name}（${entry.backend}，${entry.status}）`).join('\n') : '- 暂无其他成员';
  const history = recent.length
    ? ['## 群里最近的回答（仅供了解背景）', '以下是其他成员对他们各自任务的回答，**不是给你的任务，不需要你执行**。', ...recent.map(answer => `### ${answer.senderName} 回答了任务「${clip(answer.task, 80)}」\n${clip(answer.text, MAX_RECENT)}`)]
    : [];
  return [
    `【群聊入群说明】${taskTagLine(tag)}`,
    groupRules(group, member, workspace),
    '## 当前成员', members,
    ...history,
    '## 现在请你做的事',
    greet ? '通读以上信息，不要开始任何开发工作。用两三句话在群里打个招呼：说明你是谁、你在这个群里的定位，以及你擅长或能承担的工作。' : '通读以上信息，不要开始任何开发工作，简短确认你已了解。',
  ].join('\n\n');
}

export interface GroupTaskInput {
  group: GroupSettings & Pick<Group, 'workspace'>;
  member: string;
  workspace?: MemberWorkspace;
  task: string;
  tag: string;
  /** Referenced member answers, oldest first. */
  references?: Pick<GroupMessage, 'senderName' | 'text'>[];
  /** The member never received the current rules (new format, or settings changed). */
  includeRules?: boolean;
  /** Topic only, with the rules: the opening post and latest answers for a late joiner. */
  history?: Pick<GroupMessage, 'senderName' | 'text'>[];
}

const MAX_REFERENCE = 8000;

/** What a member receives when @-assigned: a short task header, the quoted
 * answers and the task. The full rules ride along only when they changed. */
export function buildGroupTask({ group, member, task, tag, references = [], workspace, includeRules = false, history = [] }: GroupTaskInput): string {
  const topic = group.kind === 'topic';
  const header = [topic ? `【话题】${taskTagLine(tag)} · 话题「${group.title}」` : `【群聊任务】${taskTagLine(tag)} · 群「${group.title}」`];
  // Members working outside the shared workspace get reminded every time.
  if (!includeRules && workspace && (workspace.branch || (!topic && workspace.shared && workspace.shared !== workspace.cwd))) header.push(workspaceRule(workspace));
  const quoted = references.map(reference => `### ${reference.senderName} 的回答\n${clip(reference.text, MAX_REFERENCE)}${reference.text.trim().length > MAX_REFERENCE ? '\n（内容过长已截断，完整回答见群聊）' : ''}`);
  const background = includeRules && topic && history.length
    ? ['## 话题至今的讨论（仅供了解背景，不是给你的任务）', ...history.map(entry => `### ${entry.senderName}\n${clip(entry.text, MAX_RECENT)}`)]
    : [];
  return [
    header.join('\n'),
    ...(includeRules ? [topic ? '## 话题说明' : '## 群说明（已更新）', groupRules(group, member, workspace)] : []),
    ...background,
    ...(quoted.length ? ['## 引用的回答', ...quoted] : []),
    topic ? '## 话题消息' : '## 你的任务', task.trim(),
  ].join('\n\n');
}

const MAX_PREVIEW = 160;
/** A one-line preview for the group card. */
export function replyPreview(text: string): string { return clip(text.replace(/\s+/g, ' '), MAX_PREVIEW); }
