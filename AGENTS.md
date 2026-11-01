# 本地开发约定

## 保护正在使用的实例

- Codex / Claude 会话可能由本项目自身托管。开始工作先辨认现有服务；不要在被托管的会话中停止或重启承载自己的服务，否则会同时终止用户会话。
- 开发和验收使用独立端口、`SESSIONDECK_DATA_DIR` 和 `SESSIONDECK_CLIENT_DIR`。`npm run test:web` 已自动隔离这三项，拒绝复用已有服务。
- 仅清理本轮测试启动且仍可确认身份的进程。不要按端口杀进程、使用宽泛 `pkill`，或删除正在使用的数据锁。
- 前端构建使用 `npm run build`：它在暂存目录构建，保留旧哈希资源，最后原子替换入口。不要直接运行会清空在线目录的 `vite build`，也不要删除正在服务的 `dist/client`。
- 活动服务使用稳定启动方式；`--dev` / `tsx watch` 修改后端会重启服务并中断其会话和终端。更新依赖时使用独立 checkout/worktree 和独立 `node_modules`，避免替换活动服务的依赖。

## 验证与版本管理

- `npm run check` 做类型检查，`npm test` 验证服务端、共享层、客户端与脚本的纯逻辑，`npm run test:web` 构建并测试隔离的演示实例；`npm run verify` 串行执行三者，CI 则拆成并行 job。PWA 安装检查单独运行 `npm run test:pwa`，需要 Chromium 与 WebKit。
- 可以使用 `SESSIONDECK_TEST_PORT` 避开占用的测试端口；默认 Web 端口 `4317` 不能用作浏览器测试端口。
- 本地开发、测试和提交不构成云端操作授权。未获得针对具体操作的明确授权，不创建、删除、推送或修改云端仓库；也不创建 Git tag。

## 改动前的三个问题

新增功能或改变行为前，先回答，并把答案写进提交说明或 WORKLOG：

1. **这会不会破坏跨后端中立？** Codex 专属的数据类型、事件名和界面分支不能进入公共契约；平台差异由适配器报告能力。
2. **这条能力在三个后端上都能诚实成立吗？** 只在 Codex 成立的能力必须显式标注平台与版本，或给出原生回退入口；不能把“看起来成功”当成成功。
3. **它会不会只是界面上的假象？** 状态、审批、发送结果和设置都必须有原生依据；未确认时显示“待确认/未知”，并提供核对入口。

## 工程约定

- **纯逻辑优先。** 排序、去重、路径解析、协议编解码、占位符渲染等不依赖 IO 的逻辑放在 `shared/` 或独立模块，同目录配 `*.test.ts`（`node --test`）。`npm test` 覆盖 `server/`、`shared/`、`client/` 与 `scripts/` 下的纯逻辑测试。
- **测试分层。** 纯函数走单测；HTTP/WS 契约走 `server/*.test.ts`；浏览器行为走 `tests/*.spec.ts`。新增 e2e 前先判断能否用纯函数覆盖。
- **安全边界要有测试。** 命令参数永不拼 shell、上传/请求体有上限、路径不越界、错误与日志不出现密码和令牌、Origin 与分享令牌校验——这些不能只写在规格里。
- **协议带修订号。** 状态事件带单调 `revision`，客户端拒绝乱序和跨实例数据；SSE 断线重连按 `Last-Event-ID` 补发，缺口回退到完整快照。不要新增不带身份或修订号的广播。
- **性能有上限。** 列表与消息不无限渲染 DOM；长文本、历史、附件和流式输出都要有界，并给出可读提示。页面隐藏时暂停非必要轮询。
- **文案先进 `shared/i18n.ts`。** 新界面字符串使用消息键；现有中文文案按区域逐步迁移，不做一次性大改。
- **浏览器基线为 Chrome/Edge/Firefox 111、Safari/iOS 16.2。** 客户端代码禁止正则后行断言（`(?<=`、`(?<!`）和该基线不支持的 API（如 `AbortSignal.timeout`，用 `client/timeout-signal.ts`）；`package.json` 的 `browserslist`、`vite.config.ts` 的 `build.target` 与 `scripts/browser-baseline.test.ts` 共同守住。

## 已知短板（持续改进）

2026-10-31 起按下列顺序补齐；完成后更新本节，不要只写进 WORKLOG。

| 优先级 | 短板 | 当前落点 | 状态 |
| --- | --- | --- | --- |
| P0 | 客户端与共享层缺纯函数单测 | `shared/`、`client/` | `npm test` 覆盖 `group-prompt`、`state`、`contact-order`、`format`、`markdown-blocks`、`usage`、`export`、`sse-replay`、`idle-sleep`、`access`、`shell-quote`；新增逻辑继续按此约定配测试 |
| P0 | 安全边界只写在规格里 | `server/security.ts`、`server/access.ts`、`attachments.ts`、`shell-quote.ts` | `security-boundaries.test.ts` 覆盖 shell 引号注入、图片签名/上限；`access.test.ts` 覆盖路由登记、分享权限、local/remote 边界；`security.test.ts` 覆盖 Host/Origin |
| P0 | 没有 token／上下文／压缩信息 | `server/usage.ts`、`shared/usage.ts`、`client/SessionUsage.tsx` | Claude/Codex 历史汇总显示在会话信息；截断窗口标“最近窗口”；dsh 仅在原生记录提供用量字段时显示，否则“原生未提供”，不按字数估算 |
| P0 | 对话不能导出 | `server/export.ts`、`client/export-session.ts` | `GET /api/sessions/:id/export` 输出转义、无脚本、带 CSP 的独立 HTML；会话信息中可下载 |
| P1 | WORKLOG 是时间线，不是领域陷阱 | `docs/agents/` | 已建立按领域笔记并在本文档路由 |
| P1 | 联系人/长对话无渲染上限 | `client/App.tsx`、`ConversationPane.tsx`、`client/Markdown.tsx` | 联系人每页 120 张卡片渐进加载；对话默认渲染最近 200 条并可加载更早；长 Markdown 分块，代码高亮按需加载；隐藏页暂停轮询 |
| P1 | 移动端边界缺浏览器验收 | `tests/mobile-boundaries.spec.ts` | 覆盖 16px 输入字号、隐藏页暂停/恢复、终端附加键点击与视口内可见 |
| P1 | SSE 重连只能整包重取 | `server/sse-replay.ts`、`server/index.ts` | 事件带 `id: revision`；`Last-Event-ID` 命中连续窗口时补发，缺口回退完整快照；窗口 200 条/4 MiB |
| P1 | 文案硬编码 | `shared/i18n.ts` | 已建立消息表、占位符与缺失键测试（`missingKeys`）；现有中文按区域逐步迁移，不做一次性大改 |
| P2 | 没有统一浏览器基线 | `package.json`、`vite.config.ts`、`scripts/browser-baseline.test.ts` | 已声明 `browserslist` 与 Vite `build.target`，静态扫描禁止 API |
| P1 | 远程网页服务路径代理不兼容根路径绝对资源 | `server/web-proxy.ts`、`docs/agents/remote-network.md` | 已支持 dsh 与 `SESSIONDECK_WEB_PROXY_TARGETS` 中的目标；独立预览子域名待排期（TODO 23） |
| P2 | 远程排障只能看日志 | `GET /api/debug`、`client/DebugPanel.tsx` | 只读快照：进程、修订、补发窗口、连接数、终端数、后端版本、数据目录；不返回正文、令牌或密钥 |
| P2 | 空闲会话长期占进程 | `server/idle-sleep.ts`、`SESSIONDECK_IDLE_SLEEP_MINUTES` | 默认关闭；仅 idle 且超过阈值的运行中会话经既有停止路径休眠，等待输入/审批/异常/Fork 中永不休眠 |
| P2 | CI 串行且失败无制品 | `.github/workflows/verify.yml` | 拆为 `unit`、`e2e`、`pwa`、`package` 四个并行 job；PWA job 安装 Chromium 与 WebKit，工作台回归使用 Chromium；失败分别上传日志、Playwright 与 PWA 制品 |

## 领域笔记

改到某个区域前，先读 `docs/agents/` 下对应笔记；它们记录“为什么会这样”和踩过的坑，而不是当前功能清单。

- [sessions.md](docs/agents/sessions.md)：联系人、原生身份、状态可信度、发送幂等、Fork。
- [protocol.md](docs/agents/protocol.md)：状态修订、SSE 补发、终端通道、分享视图。
- [security.md](docs/agents/security.md)：访问登记、Origin、路径与上传边界、密钥处理。
- [terminal.md](docs/agents/terminal.md)：PTY 生命周期、重连回放、图片与移动端输入。
- [dsh.md](docs/agents/dsh.md)：DeepSeek Harness 的原生 Web／TUI 路径与限制。
- [relay.md](docs/agents/relay.md)：邀请码、frp、设备与分享权限。
- [remote-network.md](docs/agents/remote-network.md)：同网直连、split-horizon DNS、EasyTier/WireGuard P2P 与 FRP 回退、主机网页代理部署。
- [testing.md](docs/agents/testing.md)：单测、契约测试、浏览器验收与原生烟测的边界。
- [performance.md](docs/agents/performance.md)：缓存、分页、渲染上限与隐藏页策略。
- [i18n.md](docs/agents/i18n.md)：消息表、占位符与迁移规则。
