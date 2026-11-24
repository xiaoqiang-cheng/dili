# Pi coding agent（pi）

## 结论

Pi 是第四个一等后端，但不是第二套网页。Dili 是唯一的 UI 和控制平面，Pi 是可替换的原生执行器：`server/pi.ts` 用 Pi 官方的 `pi --mode rpc` JSONL 协议连接原生进程，`server/agents/pi-chat.ts` 把它映射到共享的 `AgentChatAdapter`，与 Claude/Codex/dsh 共用会话、`AgentChatPane`、群聊投递、原生终端、历史、导出和设置入口。

不嵌入 iframe，不复用 `@earendil-works/pi-web-ui` 组件，也不启动另一份 Pi Web UI。pi-web 只作为能力对照；未对齐的能力见下方“能力边界”。

## 进程与会话身份

- 每个图形会话对应一个独立的 `pi` 子进程（stdio JSONL），由 `OwnedProcess` 托管；停止/关闭只结束本轮确认拥有的进程，不按端口或宽泛进程名清理。
- 新建使用 `--session-id <uuid> --name <title>`；恢复使用 `--session-id <uuid>`。**不要用 `--session <file>` 恢复空会话**：Pi 在第一条消息前不会创建 session 文件，`--session` 会报 `No session found`；`--session-id` 在当前目录复用已有会话，否则创建同 ID 的新会话。
- Pi 新建会话使用 UUIDv7；接受所有 UUID 版本，不要退回 v4-only 正则。
- session 文件位于 `$PI_CODING_AGENT_SESSION_DIR`（若设置）或 `$PI_CODING_AGENT_DIR/sessions`；不同 Pi 版本可能在根目录或项目子目录下写成 `<ISO>_<uuid>.jsonl`。文件头 `{type:'session', version:3, id, timestamp, cwd}` 是身份与 cwd 的权威来源；`session_info` 标题只用于显示。
- Fork 走原生 `--fork <parent-id> --session-id <new-id>`。**来源会话还没有产生 session 文件时无法原生 Fork**；先发一条消息，或使用跨平台交接。
- 图形对话的“停止生成”发送 `abort`，只结束当前轮次并保留 RPC 进程；会话“停止/移入垃圾桶”才关闭进程。关闭 Pi 进程不会删除原生会话；下一次 `--session-id` 可恢复。
- “转向”：生成中继续发送会带 `streamingBehavior:'followUp'`，由 Pi 排到当前轮次之后，不打断正在生成的回答；合并后的 follow-up 会在下一个 `turn_start` 绑定自己的原生 turn id。需要立即中断时用“停止生成”，不要假装 follow-up 会改写当前回答。

## 图形对话映射

- `get_state` 校验返回的 `sessionId` 与期望一致；不一致时拒绝启动，不能把另一个会话当成当前会话。
- 初次加载优先读取 session 文件尾部（最多 2 MiB、1000 条），避免长会话的 `get_entries` 单帧过大；之后用 `get_entries {since: lastId}` 增量刷新。文件头 `id` 是 session UUID，**不能作为 `since` 游标**。
- 用户文本、assistant 文本、`toolCall` + `toolResult` 合并为共享的 user/assistant/tool 卡；工具参数和结果显示在折叠卡中。历史最多 250 项，超出时明确标记“只显示最近窗口”，完整历史留在原生会话/终端。
- 用量读取 `message.usage` 的 `input`/`output`/`cacheRead`/`cacheWrite`/`totalTokens` 和 `message.model`；没有上下文窗口或压缩信息时保持“原生未提供”，不估算。
- Pi 的阻塞式扩展 UI（`extension_ui_request` 的 `select`/`confirm`/`input`/`editor`）映射为共享的审批/问题卡；`confirm` 只有允许/拒绝，其余方法用文本回答。`notify`/`setStatus`/`setWidget`/`set_editor_text` 是显示型请求，当前只忽略，不伪造系统级弹窗。
- `readChatHistory` 目前没有游标分页，返回明确错误；界面提供“完整历史在原生终端”的出口，不能返回空数组假装历史为空。

## 设置与能力边界

- 模型来自 `get_available_models`，使用 `provider/id` 作为选择值；思考强度来自 `get_available_thinking_levels`，通过 `set_thinking_level` 生效；写入后重新读取。
- **Pi 没有统一的权限/审批预设**。`AgentChatSettings.permission` 为 `null`，`permissions` 为空，并带 `permissionReason`。不能把 Pi 原生工具策略映射成 Claude/Codex 的允许/拒绝，也不能伪造审批卡。
- 只有扩展主动发起 `confirm` 时才出现审批 UI；普通工具执行没有逐次审批。用户在 Pi 原生配置/扩展中管理工具策略。
- 设置页的「配置 API」可保存一个 Dili 托管的 `dili` provider：地址、模型写入 `$PI_CODING_AGENT_DIR/models.json`，密钥写入 `auth.json`；`dili` 固定使用 `openai-completions`。地址和模型需同时填写，清空二者移除该 provider，密钥保留。其他原生 provider、MCP/扩展和内置账号/OAuth 仍由 Pi 原生配置维护；Dili 不读取或回显已保存的密钥。
- 原生终端通过 `--session-id` 恢复；Pi TUI 没有可验证的状态通道，因此终端状态通常是“未知”。从终端切回图形对话（或在图形视图发送并触发交接）都需要用户显式确认，服务端会记录“终端没有报告任务状态”的活动；从图形对话切到终端仍要求 RPC 快照 idle 且无待回答请求。
- 工作区附加目录：Pi 当前没有接入 `--add-dir`，能力报告为 `additionalDirectories: false`，不假装支持。
- Auto 审批：Pi 没有统一 Auto 预设，`autoMode: false`；创建/启动时不能注入 Auto。

## 与 pi-web 的差距（当前未授权）

已对齐或超过：会话/群聊/多会话管理、流式文本与工具卡、原生会话恢复/Fork/导入、原生终端交接、图片输入、模型/思考强度、扩展确认与问题、用量、导出、远程/移动端沿用 Dili 外壳。

尚未对齐：网页内维护内置 provider 的 OAuth/账号（当前只保存 Dili 托管的 OpenAI 兼容 provider）、会话树按消息分支/切换分支、PDF/DOCX/XLSX 预览、Pi 插件/技能专用面板、Pi 的 widget/status 组件、Pi Web 的完整 slash 命令面板。缺口不应通过 iframe 或复制一套 Pi Web 来掩盖；优先按共享适配器能力逐步补齐。

## 常见坑

1. Pi 空会话没有文件；`--session` 会失败，统一用 `--session-id`。
2. 文件头 `id` 是 session UUID，不是 entry 游标；`since` 必须用最后一条真实 entry 的 `id`。
3. `get_entries` 全量返回可能很大；先读文件尾，再用 `since` 增量；尾读不到且文件超过 8 MiB 时放弃全量加载并标记截断，不能把整份历史塞进一帧。
4. 单个工具结果可能超过 4 MiB；RPC 读取器必须有上限，但**不能截断后继续拼 JSON**。
5. 关闭时先结束 stdin、等待退出，再走 `OwnedProcess`；不要 `pkill pi`。
6. Pi 子进程不能继承 `SESSIONDECK_TOKEN`；原生 Agent 不需要 Dili 所有者令牌。
7. 原生 TUI 启动时也会打印 `escape interrupt`，不能仅凭这行推断正在执行；Dili 对 Pi 终端忽略这些终端提示，始终保留“未知”，否则会把空闲终端标成 running 并卡住交接。

## 测试

- `server/pi-session.test.ts`：entry 解析、工具合并、图片计数、截断、标题、用量、文件名。
- `server/setup.test.ts`：验证 `models.json`/`auth.json` 的托管 provider、密钥保留、备份和 0600 权限，不调用模型。
- `server/pi.test.ts`：启动 `server/fixtures/pi-rpc.mjs`，验证 `get_state`、prompt 往返、follow-up 转向、工具事件、设置、extension confirm、abort、Fork 新建和关闭后恢复；不调用真实模型。
- `server/adapters.test.ts`：Pi 发现、标题、cwd、`--session-id`/`--fork` 启动参数。
- 真实原生烟测需要本机安装 Pi；设置 `SESSIONDECK_PI_BIN` 指向 CLI，使用独立 `PI_CODING_AGENT_DIR`/`PI_CODING_AGENT_SESSION_DIR`。没有真实账号时只能用本地 mock provider 验证 RPC 链路，不代表云端模型行为。
- 当前发行目标仍是 Linux；Windows 原生进程路径、PTY 和 systemd 相关能力未随 Pi 一起验收。
