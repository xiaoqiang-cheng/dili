# 开发与验证

更新日期：2026-10-23。首次运行见[安装指南](installation.md)，当前功能约定见[产品规格](product-spec.md)。仓库内开发以 [AGENTS.md](../AGENTS.md) 为准。

## 保护活动实例

Dili 可能承载你正在使用的 Agent。开始前检查现有实例，不停止或重启承载当前会话的服务，不按端口杀进程、不删除活动数据锁。前端修改使用 `npm run build` 原子发布：保留旧哈希资源，构建成功后才替换入口。不要直接执行会清空在线目录的 `vite build`。

并行开发使用独立 checkout / worktree 和独立依赖，避免 `npm ci` 替换活动实例的 `node_modules`。端口、数据目录和前端目录三项也必须隔离。在独立 checkout 中：

```sh
npm ci
dili_dev_root=$(mktemp -d /tmp/dili-dev.XXXXXX)
SESSIONDECK_PORT=4327 \
SESSIONDECK_DATA_DIR="$dili_dev_root/data" \
SESSIONDECK_CLIENT_DIR="$dili_dev_root/client" ./start.sh --dev
```

`--dev` 使用 `tsx watch`，后端文件变化会重启该开发实例并终止其 Agent / Shell；持续任务使用普通启动。遇到文件监听数量限制，可设置 `CHOKIDAR_USEPOLLING=1`。清理时只处理本轮启动且身份仍可确认的进程和临时目录。

## 自动化检查

```sh
npm test
npm run verify
```

`doctor` 检查 Node、PTY、目录权限与原生命令，不检查登录凭据或调用模型；`verify` 依次运行类型检查、后端测试和浏览器验收，前端生产构建由浏览器验收在独立目录完成。

浏览器验收使用独立端口、临时演示数据和临时前端构建目录，不复用或停止正在使用的服务，也不安装项目依赖。它会自行完成生产构建，无需提前执行 `npm run build`。首次需要安装 Chromium：

```sh
npx playwright install chromium
npm run test:web
```

默认测试端口为 `4337`；若被占用，可使用 `SESSIONDECK_TEST_PORT=4339 npm run test:web`。测试拒绝使用正式服务默认端口 `4317`。

可选原生启动检查使用临时配置和工作目录，不输入提示词，不执行模型任务：

```sh
npm exec tsx scripts/native-cli-smoke.ts
```

真实原生程序的隔离工作流验收使用确定性的本机模型服务，不消耗模型额度。dsh 使用独立配置与外网连接拦截；Claude 与 Codex 使用独立配置及 Linux 网络命名空间，因此需要 `unshare` 和可用的用户命名空间：

```sh
npm run test:smoke:dsh
npm run test:smoke:codex
npm run test:smoke:claude
npm run test:smoke:workspace
```

`test:smoke:workspace` 通过真实 HTTP / WebSocket 服务连接三个原生程序，验证建群、定向任务、原生确认执行、结果转交、Fork 入群、单独纠正，以及服务重启后的元数据和原生 ID 恢复。它同样使用临时配置及仅有 loopback 的网络命名空间；无需真实账号或 API Key。该检查验证本地接入链路，不代表真实云端模型质量或账号环境。

Codex／Claude 图形交互另有真实 CLI 的本地协议验收：

```sh
npm run test:smoke:codex-chat
npm run test:smoke:claude-chat
```

Codex 脚本使用临时 `CODEX_HOME`、精简环境和随机本机端口的模拟 Responses 服务；Claude 使用独立配置和 loopback Messages provider。不读取真实凭据，也不请求真实模型。它验证图形发送、流式事件、请求去重、原生审批拒绝、Fork 独立、中断及同一线程的终端连接；不依赖 `unshare`，不提供网络命名空间隔离，也不代表真实账号或云端任务质量验收。

可重复的长时间稳定性检查使用临时演示数据、三个真实 PTY 及循环重连／投递／停止恢复，将报告保存至 `artifacts/`：

```sh
npm run test:soak -- --minutes=45
npm run test:terminal-load -- --minutes=10
```

默认应用数据目录：`~/.local/share/sessiondeck`，可通过 `SESSIONDECK_DATA_DIR` 指定。数据目录使用独立 `instance-lock.sqlite` 的独占事务锁，进程退出后由操作系统释放；不要删除正在使用的锁文件。演示模式用于验证界面与组织流程，不能证明真实后端接入成功。在独立 checkout、空闲端口中，先创建新的临时目录：

```sh
dili_demo_root=$(mktemp -d /tmp/dili-demo.XXXXXX)
SESSIONDECK_DEMO=1 SESSIONDECK_PORT=4338 \
SESSIONDECK_DATA_DIR="$dili_demo_root/data" \
SESSIONDECK_CLIENT_DIR="$dili_demo_root/client" npm run dev
```

## 环境变量

| 变量 | 默认值与作用 |
|---|---|
| `SESSIONDECK_PORT` | `4317`，Web 应用端口（也接受 `PORT`） |
| `SESSIONDECK_HOST` | `127.0.0.1`，Web 监听地址（也接受 `HOST`）；设置为 `0.0.0.0` 或 `::` 可接受局域网访问 |
| `SESSIONDECK_DATA_DIR` | 本地元数据目录，同一目录只允许一个服务实例 |
| `SESSIONDECK_CLIENT_DIR` | 默认仓库下的 `dist/client`；前端构建输出及生产静态资源目录，构建与启动须使用同一值；浏览器测试自动使用临时目录 |
| `SESSIONDECK_TEST_PORT` | `4337`，仅用于浏览器验收；需为未占用端口，不能为 `4317` |
| `SESSIONDECK_DSH_PORT` | `4318`，按需启动的 dsh 原生 Web 服务 |
| `SESSIONDECK_CODEX_PORT` | `4319`，按需启动的 Codex app-server；`0` 自动选择空闲端口 |
| `SESSIONDECK_CLAUDE_BIN` / `SESSIONDECK_CODEX_BIN` / `SESSIONDECK_DSH_BIN` | 可选原生程序绝对路径，未设置则从 `PATH` 查找 |

Codex app-server 只监听本机并使用随机访问令牌。令牌文件仅当前用户可读，正常关闭后删除；令牌不会发送给网页或出现在命令参数中。

## 构建与 CI

`npm run check` 类型检查，`npm test` 服务端检查，`npm run test:web` 构建并验证隔离演示实例；`npm run verify` 串行执行三者。不要并行执行会共用测试产物的多轮浏览器检查。

当前 CI 配置为 Node.js 24、Linux 和 Chromium，不是 macOS / Windows 的发行保证。测试数据、协议 fixture、真实 CLI + loopback provider、真实云端账号、实际部署验收是不同的证据；每次在 WORKLOG 写清版本、命令、范围与未验证项，不把历史测试数量复制为当前承诺。

发布制品、版本一致性及云端发布授权要求见[发布清单](releasing.md)。本地开发、测试、提交不授权 push、创建 tag 或其他云端操作。
