# DeepSeek Harness（dsh）

## 三条路径

1. **dsh 0.2+ 结构化图形对话**：`server/agents/dsh-chat.ts` 通过 `DshBridge` 复用 `AgentChatPane`；文本、工具、问题和停止都走原生 RPC，审批仍有独立的状态与原生入口。网页会话持有写锁时可直接发送；若当前由 dsh-tui 持有，图形对话只读，需先显式接管（会退出 TUI，并从同一份已保存会话恢复）。
2. **dsh-tui 存在**：`server/terminal.ts` 托管原生 PTY，输入、图片、审批都在原生 TUI 里完成；Dili 提供联系人、状态、工具卡和对话记录。
3. **没有 dsh-tui 或显式使用原生界面**：`server/dsh.ts` 启动 Harness 自己的 Web 服务，页面用 iframe 打开原生界面；对话记录走原生 session 历史 API 或压缩日志。

传输方式是**每个联系人**的属性，不是“装了 dsh-tui 就全走终端”：群聊投递、停止、Fork 和空闲观察都以 `executionTransport === 'web'` 判断，避免把网页会话误判成 PTY 而报“会话尚未启动”。

用 `SESSIONDECK_DSH_PREFER_WEB=1` 可强制走 Web 桥（TUI 挂起但收不到输入时的退路）。

## 身份与服务

- dsh 0.1 的会话 ID 是 `session-<uuid>`，0.2 / dsh-tui 是裸 UUID；`DSH_ID` 两者都接受，但**新建必须用裸 UUID**：带前缀的目录会让 dsh-tui `--resume` 报“log unreadable or corrupt”。
- 旧 `session-<uuid>` 联系人无法在当前 dsh 0.2 上恢复；`/start mode chat` 会新建一个裸 UUID 会话、写回联系人，并保留联系人本身。不要静默复用坏 ID。
- 原生 Web 服务按需启动，端口由 `SESSIONDECK_DSH_PORT` 指定；未指定时每次选空闲端口。
- 服务只监听本机；不要把它当成可远程访问的入口。
- dsh 0.2 的原生权限目录只有 `read-only`、`workspace-write`、`danger-full-access`，没有 `auto`。Dili 不再为 dsh 提供 Auto，也不注入启动覆盖层；历史 Auto 联系人在启动时归一为原生默认，并在状态里说明原因。

## 能力边界

- 多工作区／`--add-dir`：**不支持**，界面必须解释原因，不能假装成功。
- 统一模型与权限面板：**dsh 0.2 已接入原生目录**；只有网页会话持有写锁时可写，dsh-tui 持有期间只读并明确提示。
- 问题：dsh 0.2 的阻塞式 `ask_user_question` 通过转发 Remote Event 的 `$events` / `$events/result` 回答；timed 问题在 `userQuestions` 投影转为 `continued` 后走 `userQuestions/answer`。没有投影、也没有 `wait.callId` 的阻塞问题仍以实时 waterfall 为准。
- 审批：原生只提供 `approval/asked` / `approval/decided` 状态，没有可验证的远程 allow/deny 方法；Dili 只显示“等待审批”，并要求去原生 TUI/Web 处理。
- 停止：通过原生接口取消任务，不要关闭共享 Web 服务或影响其他成员。
- Fork：保留原目录；不支持改目录。
- 使用量（token/费用）：原生历史未提供稳定字段时显示“原生未提供”，不要估算。

## 常见坑

1. 压缩日志是多个 zstd frame，不能只用一次 `zstdDecompressSync`；用 `decodeDshFrames` 并按字节推进。
2. 压缩日志有大小上限；超出时回退到原生分页 API，不整文件解码。
3. 事件 `seq` 用于消息 ID；没有 `seq` 的旧版本要显式降级，不能生成会碰撞的 ID。
4. 停止空闲且尚未附着页面的会话是幂等操作；不要报错。
5. 不要把“支持 DeepSeek 模型”当成“支持 DeepSeek Harness”。

## 结构化图形对话（2026-10-31 实现）

结论：**可以做 dsh chat adapter，但不能把审批伪装成网页操作**。文本、工具、问题、停止已经接入；审批保留原生处理。

- 已确认可用：`session.prompt`、`session.cancel`、`session.history`、`session.page`，以及 `events.mux` / 现代 `session/follow` 中的 `session/event`。这些足以填充 `AgentChatPane` 的文本和工具卡。
- **阻塞式问题**：`ask_user_question` 在 dsh 0.2 中通过转发 Remote Event 的 `user-questions/request` waterfall 到达客户端；必须在 `/api/remote.mux` 上打开 `$events` 逻辑流，回答时向 `/api/$events/result` 提交 `{ clientId, eventId, outcome: { kind: 'result', value: { answers } } }`。这个请求通常没有 `wait.callId`，`eventId` 才是稳定句柄。
- **timed 问题**：`userQuestions` 投影只记录 timed 调用；调用变成 `continued` 后通过 `userQuestions/answer` 提交 `agentId`、`callId`、`answers`。不要把它当成所有 `ask_user_question` 的通用入口。
- 审批没有等价的远程应答：原生只暴露 `approval/asked` / `approval/decided` 状态，网页端没有可验证的 approve/reject RPC。审批卡只能在 Dili 显示“去原生界面处理”，不能伪造允许／拒绝。
- **模型、权限**：`session.modelCatalog` 和 `permissionPresets/catalog` 提供目录，`session.projections` 提供当前 `modelSelection` / `permissions`；选择模型走 `session.selectModel`，权限走 `/permission <preset>` 命令。写入后必须读回确认，不能把命令受理当成功。
- **写锁**：dsh 同一 session 只允许一个 writer。dsh-tui 持有写锁时，网页 `session.prompt` 会得到 `session/writer-held`；此时图形对话只读，`/start { mode:'chat', handoff:true }` 会先停止 TUI（要求原生状态 idle、没有待回答/审批），再从同一 session 恢复网页 writer。
- **模型投影延迟**：刚接受 `selectModel` 或 `/permission` 时，`session.projections` 可能晚一个事件；桥接层短暂保留已确认值，并在权限写入后轮询读回，避免界面回弹到旧值。
- `DshChatAdapter` 的 `sendPrompt` 先走原生 `session.prompt`，成功后返回合成 `turnId`，下一个原生 `turn/start` 会接管它；历史只读取最近窗口，不启动已停止会话。
- 当前 dsh 构建未稳定发送 `assistant/live-chunk`，所以实时气泡通常不会出现；收到时 adapter 会显示，最终 `assistant/message` 会替换它。没有收到时不能伪造流式文本。
- 重新评估的条件：原生协议提供稳定的审批应答接口，并有版本门槛；届时再把审批也收进网页，否则保持“问题可答、审批跳原生”。
