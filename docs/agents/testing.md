# 测试与验收分层

## 四层证据

| 层 | 命令 | 证明什么 | 不证明什么 |
| --- | --- | --- | --- |
| 纯逻辑单测 | `npm test` | 排序、协议、解析、用量、导出、安全边界函数 | 真实 IO、原生程序 |
| HTTP/WS 契约 | `npm test` 中的 `server/*.test.ts` | 路由、权限、持久化、状态机 | 浏览器渲染、真实 CLI |
| 浏览器验收 | `npm run test:web` | 隔离演示实例里的真实交互 | 原生 Agent 行为 |
| 原生烟测 | `npm run test:smoke:*` | 本机 CLI + 模拟服务的链路 | 真实账号、云端模型质量 |

另外：`npm run test:soak`、`npm run test:terminal-load` 验证长时间稳定性；`npm run test:package` 验证打包产物；`npm run doctor` 只检查环境，不调用模型、不读凭据。

## 隔离规则

- 浏览器验收自动使用临时 `SESSIONDECK_DATA_DIR`、`SESSIONDECK_CLIENT_DIR` 和测试端口（默认 4337），拒绝复用活动实例。
- `npm run test:web` 会先构建到临时目录；不要为了测试去覆盖正在服务的 `dist/client`。
- PWA 安装检查 `npm run test:pwa` 使用 Chromium 与 iPhone WebKit 项目，产物在 `artifacts/pwa/`；它独立于 `test:web`，需要 `npx playwright install chromium webkit`。
- 原生烟测使用临时配置目录；Claude/Codex 的隔离工作流还要求 `unshare` 与可用用户命名空间。
- 只清理本轮启动且身份可确认的进程；不要按端口杀进程。

## 原生契约夹具

- Codex app-server 在最后一个联系人停止后会被主动停掉，释放原生 writer；真实 Codex 会把 thread 持久化到磁盘。测试夹具也必须把 thread 存到临时目录并在新进程启动时读回，否则“停止再恢复”会得到 `Unknown fixture thread`，把产品回归误报成夹具失败。
- 停止接口返回时 PTY/native 清理可能仍在进行；`start` 返回“会话正在停止”是诚实的状态，不是竞态漏洞。契约测试应像真实客户端一样短暂重试启动，而不是在 `running=false` 后立即断言 200。
- 夹具收到 `SIGTERM` 时先记录 socket 关闭再退出，否则 app-server 被停掉后无法证明 TUI/observer 已释放。
- npm 的 `files` 白名单仍会把 `shared/` 下的 `*.test.ts` 打进包；`shared/.npmignore` 是必要保险。`server/.npmignore` 只排除真正的中继入口（`relay-main`、`relay-service`、`relay-store`、`relay-bandwidth`），不要用 `relay-*.ts` 误伤运行时导入的 `relay-notice-poller.ts`。

## 写测试的优先级

1. 能写成纯函数吗？能就放 `shared/`、`client/` 或 `server/` 的独立模块，同目录 `*.test.ts`。近期例子：`client/contact-order`、`client/markdown-blocks`、`server/sse-replay`、`server/idle-sleep`、`server/export`。
2. 需要真实 HTTP 吗？用 `server/*.test.ts` 的 app 实例，不启端口。
3. 只有浏览器能证明吗？写 `tests/*.spec.ts`，并复用 `tests/fixtures.ts`；移动端边界集中在 `tests/mobile-boundaries.spec.ts`。
4. 只有真实 CLI 能证明吗？写 smoke，并明确它使用模拟服务。

## 断言风格

- 断言“行为 + 可观察结果”，不断言内部实现细节。
- 安全测试要断言“拒绝 + 状态码/错误信息”，不只是“没抛异常”。
- 时间相关逻辑注入 `now()`，不要 `sleep` 等真实时钟。
- 新增能力时同时加失败路径（超时、拒绝、乱序、非法输入）。

## 提交前

```sh
npm run check
npm test
```

改了前端或交互再跑：

```sh
npm run test:web
```

`npm run verify` 串行跑三者；CI 拆成并行 job，失败会保留 Playwright 制品。
