# 嘀哩协调员（话题 Router）

嘀哩是 Dili 自己维护的一个轻量 Agent，只在**话题**里出现。干活的仍是参与者（Claude、Codex、dsh、Pi 的原生会话）；嘀哩只做对话、上下文管理和分派。

## 组成

| 文件 | 作用 |
| --- | --- |
| `server/coordinator.ts` | 工具调用循环、话题工具、批处理队列、回复到齐后的汇总 |
| `server/coordinator-context.ts` | 系统规则与话题快照（纯函数） |
| `server/llm.ts` | OpenAI 兼容 chat completions 客户端（含工具调用、重试、超时） |
| `server/agent-setup.ts` `managedApi()` | 复用设置页给 dsh（优先）或 Pi 配置的 API 地址与 Key |
| `client/GroupChat.tsx` | 嘀哩消息、“正在思考”、提议卡片的展示 |

## 行为

- 话题里一条**不 @ 任何人**的消息（`kind: note`，无收件人，来自所有者）触发嘀哩；@ 参与者的消息只发给参与者，嘀哩不介入。群聊（非话题）没有嘀哩。
- 每次运行都是无状态的：系统规则 + 话题快照（标题、原帖、参与者状态、最近 20 条消息，每条截断 500 字）+ 本次触发。**话题本身就是记忆**；更早或更长的内容用 `[#n]`（消息 rowid）引用，按需用工具展开。
- 运行期间到达的触发会合并到下一次运行（批处理），不会一条消息一次调用。
- 嘀哩的回答是 `kind: reply`、`agent: 'coordinator'`、`senderId: null` 的消息。思考中的占位消息（`pending`）不计未读、不更新预览；落定时才计一次未读。

## 工具（只有这些）

`read_messages`、`read_message`、`read_participant_history`、`list_topics`、`list_contacts`、`dispatch_task`、`propose_participant`。没有命令行、文件或网络工具；这是安全边界，**不要给它加执行能力**，否则就是在重写一个编码 Agent。

- `dispatch_task`：只能派给当前话题的参与者，单次运行最多 2 次；生成 `agent: 'coordinator'` 的任务并立即投递（复用 `deliverNow`）。任务带 `awaitSummary`，全部收件人都有落定的回复后，`repliesChanged()` 触发一次“请汇总”事件。
- `propose_participant`：只生成提议（`proposal`，`P-xxxx`），由用户在话题里点“同意”，或在 IM 里回复“同意 P-xxxx”。批准走 `decideProposal()`，内部复用 `forkContact()` / `createContact()`，并给新成员发一条补课消息。模型不能自己批准。

## 模型与配置

- 默认模型 `deepseek-v4-flash`（`COORDINATOR_MODEL`），可用 `SESSIONDECK_COORDINATOR_MODEL` 覆盖。地址和 Key 来自设置页的 dsh/Pi 托管 API；没有配置时嘀哩回复一条说明，不报错。
- DeepSeek 的 `reasoning_content` 只在同一次工具循环内回传，不写入话题。
- 演示模式不调用模型（`api()` 返回 null）。

## 陷阱

- 不要在嘀哩里缓存对话历史：一旦有第二份记忆，就会和话题里的真实消息不一致。需要更多上下文时改快照或加读取工具。
- `[#n]` 是全局 rowid，跨话题唯一但不连续；`read_message` 只返回当前话题的消息。
- 测试用脚本化的假模型（`server/coordinator.test.ts`），不要在单测里调用真实接口。
