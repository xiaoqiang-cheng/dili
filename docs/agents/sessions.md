# 会话与联系人

## 两个身份，不能混

- `Session.id` 是 Dili 自己的联系人 ID，群组关系、分享、活动都指向它。
- `Session.nativeSessionId` 指向后端真正的会话（Claude/Codex UUID、dsh `session-<uuid>`），只有它可以传给原生 CLI 做恢复／Fork。
- `forkPending` 表示原生 Fork 已发出、但新身份尚未确认；此时不能继续 Fork，也不能展示为“分叉完成”。
- 入口：`server/adapters.ts`（发现、启动、`validateNativeId`）、`server/store.ts`（持久化）。

## 状态可信度

`Session.status` + `statusSource` 一起读，不能只看 status：

| source | 含义 | 谁能写 |
| --- | --- | --- |
| `native` | 结构化事件或原生生命周期 | `server/codex.ts`、`server/claude-chat.ts`、`server/native-status.ts`、`server/dsh.ts` |
| `process` | 托管进程的启动／停止 | `server/index.ts` 的 start/stop |
| `terminal` | 从 PTY 输出推断，界面标“估测” | `server/native-status.ts` |
| `manual` | 用户显式操作 | 设置路径 |

- 只根据“一段时间没有输出”不能判定完成、阻塞或审批；推断状态必须可核对。
- `lastAttentionKey` 防止同一次原生中断在重放事件时重复提醒；新 key 才增加 `unread`。
- 服务重启后 `Store` 构造函数把 `running` 会话改为 `unknown`，避免幽灵进程；不要删除这段逻辑。

## 发送幂等

- 图形发送先落到 `ChatSubmissions`（`server/chat-submissions.ts`），带客户端 `requestId`；同一 ID 不重复执行。
- 群投递先写 `Delivery`（`pending/sending/sent/unknown`）再调用原生接口；`unknown` 只能由用户核对后解决，禁止自动重发。
- `DeliveryNotAcceptedError` 表示原生明确拒绝；超时或断线是 `unknown`。

## Fork 与交接

- Fork 只调用后端原生能力；没有原生 Fork 时禁用并解释（`capabilities.fork`）。
- Fork 不自动创建 Git worktree；群组的独立 worktree 是另一条路径（`server/worktrees.ts`）。
- Claude 图形 Fork 在第一次输入前没有独立历史文件，使用 `claudeUnwritten` 保留 bootstrap；不要因为“读不到历史”就判定失败。
- 交接（`/api/sessions/:id/handoff`）只创建目标联系人和剪贴板文本，不自动发送。

## 常见坑

1. **Codex 写入锁**：外部客户端占用时 `thread/resume` 返回 `already has an active writer`；不要把联系人或历史删掉，给“重试恢复 / Fork 后继续”。
2. **历史预览倒退**：`updatePreview` 只接受不早于 `lastUserInputAt` 的记录，异步读完成顺序不可信。
3. **读历史不启动 CLI**：`ConversationReader` 只读文件，不拉起原生进程；需要实时状态时走事件桥。
4. **演示模式**：`demo` 下不要调用真实原生命令；演示数据与真实数据不能混合。
