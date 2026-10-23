# Claude 图形会话：原生 stream-json

Dili 图形模式启动已安装 Claude CLI 的官方 stream-json 协议，复用原生认证、工具、权限和持久会话，不自建模型执行引擎。Codex 与 Claude 共用 `client/AgentChatPane.tsx`，正文、Markdown、工具结果、审批与用户问题统一呈现。

## 执行者与切换

图形模式由 `server/claude-chat.ts` 执行，原生终端由 PTY 执行。两者能够恢复同一个持久会话 ID，但不是同一个运行进程。每个联系人只允许一个执行者；当前轮及审批处理完毕后，界面明确确认交接，再退出旧执行者、恢复已保存上下文。执行中拒绝交接，不能把一个回合同时交给两个进程。

新安装且没有已保存显示偏好时，Claude 默认打开图形对话；已有偏好继续生效。已有 PTY 会话不会因刷新页面而被替换；用户仍可阅读历史，明确切换执行方式后才启动图形执行。若需要保留原生进程中的临时状态，请继续使用原生终端，待工作结束后再切换。切换不承诺保留仅存在于原进程内存中的设置。

## 代码路径

- `server/index.ts`：启动、停止、空会话恢复、Fork、交接、群组投递及异常退出。
- `server/claude-chat.ts`：流式正文、工具、原生审批、AskUserQuestion、图片、interrupt；子 Agent 输出不混入当前联系人的正文。
- `server/chat-api.ts`：平台无关 HTTP/SSE、快照与补丁、持久 request ID 去重、未知发送结果核对。
- `client/AgentChatPane.tsx`：草稿、图片、语音、队列、消息目录、审批与问题。兼容原有草稿键；升级的旧队列需核对连接身份，不自动重复发送。
- `client/NativeInputComposer.tsx` 和 `/input` 保留 PTY 兼容路径，供旧版本 Claude 及 Harness 使用。

## 当前边界

图形模式可以处理普通输入、图片、流式回复、工具审批、问题和停止。模型／权限配置尚待统一设置接口；Claude 当前只加载有界最近历史，完整历史仍保留在原生存储中。运行中补充输入先进入队列，本轮结束后发送。

CLI 不支持 stream-json 部分消息参数时不宣称支持结构化图形交互。原生 TUI 和图形模式继承的是原生持久配置，临时内存状态不能承诺跨进程继承。

## 验证

`server/codex-chat-api.test.ts` 使用隔离 CLI fixture 验证流式、Unicode、多行、去重、审批／提问、停止、交接、Fork 与恢复。

`npm run test:smoke:claude-chat` 使用真实已安装 Claude CLI 连接一次性 loopback provider，检查流式、图片、恢复、Fork、审批与停止，不访问付费模型或修改用户配置。完整验收还包括 `npm run check`、`npm test` 和隔离 `npm run test:web`。本轮结果写入架构文档；不能用 fixture 通过代替所有真实账号兼容性。
