# 安装与运行 Dili

更新日期：2026-10-23。当前正式发行验收目标为 Linux x86_64；WSL2 x86_64 沿用 Linux 运行方式，完整实机验收仍待完成。需要 Node.js 24+。Windows 原生和 macOS 暂未完成本版本发行验收。

## 源码运行（推荐起点）

```sh
git clone https://github.com/xiaoqiang-cheng/dili.git
cd dili
./start.sh
```

打开 `http://127.0.0.1:4317`。脚本会检查 Node.js 24+、npm、端口和数据锁，在依赖缺失或依赖清单更新时安装，再构建和启动。已有实例占用端口或数据目录时直接退出，不接管进程。没有适用的 `node-pty` 预编译包时需要系统编译工具。

默认只监听本机；局域网访问可使用 `SESSIONDECK_HOST=0.0.0.0 ./start.sh`，再打开主机的局域网 IP 和端口。远程访问推荐[邀请码配对](remote-access.md)，不要把本机免密码入口直接代理到公网。

也可在新 checkout 手动执行 `npm ci`、`npm run build`、`npm start`。并行开发及活动实例保护见[开发指南](development.md)。

## 安装本地 npm 包

包名暂定 `dili-workbench`，命令名为 `dili`。**本版本尚未发布到 npm**，目前请从源码或经过核对的发行制品安装。在独立 checkout 中制作本地包：

```sh
npm ci
npm pack
npm install -g ./dili-workbench-0.4.0-dev.0.tgz
dili
```

网页随包预构建；全局安装后的启动不需要 Vite、TypeScript 编译器或下载网页资源。Node.js 的原生终端依赖需要匹配本机平台。

```sh
dili --help
dili --version
dili --port 4327 --data-dir ~/.local/share/dili-test
dili doctor
```

默认浏览器地址为 `http://localhost:4317`。前台运行时 Ctrl+C 会停止 Dili 及其托管进程，保留原生历史、联系人、笔记和配置。程序安装目录与数据目录分离，兼容数据目录仍为 `~/.local/share/sessiondeck`。升级不应在仍有运行会话时覆盖服务依赖；安排停止服务后升级。

npm 包和源码启动使用同一数据格式，不能同时使用同一数据目录；服务端升级会中断托管进程，请按[操作指南](operations.md)安排维护。

## Agent

Claude Code、Codex、DeepSeek Harness 独立安装，使用原生登录和配置。Dili 只管理本机具体会话，不代替 Agent 的账号、付费和权限体系。在「连接与能力」可以点击安装、账号登录，在底部交互终端完成操作。安装需要网络和 npm 全局目录写权限；失败时在终端查看错误，不会自动提权。已有后端仍可以使用自己的官方安装方法。安装／登录后刷新检测；可在其他终端直接运行同名命令。

Claude 和 Codex 的「配置 API」将设置写到其用户原生配置路径（尊重 `CLAUDE_CONFIG_DIR` / `CODEX_HOME`），保存前备份已有文件，文件权限为 0600。密钥留空保留已有凭据，地址／模型留空恢复默认；新启动的会话读取。Codex API Key 通过原生登录命令的 stdin 保存，自定义地址需兼容 Responses API。TOML 会规范化格式，注释保存在备份中。已有 OAuth 和 API 认证的优先级遵循原生 Agent，请用原生登录状态检查。

DeepSeek Harness 点击「原生配置引导」启动 `dsh web`，按终端提示打开本机地址，在其设置中配置提供商、API Key 和模型。它的 Web 配置由 Harness 自己维护；安装引导会同时安装 `@deepseek-ai/dsh` 和 Dili 原生终端所需的 `@deepseek-harness-tui/dsh-tui`。远程页面只查看引导，安装和配置操作必须在本机完成。

## 自动启动

`dili service status` 检查用户服务；`dili service enable`／`disable` 只改变下次登录后的自动启动，不停止或重启当前实例。网页也提供同样设置。新服务使用当前工作目录、端口、数据目录和 PATH；保留已有兼容服务的自定义设置，拒绝覆盖其他安装或数据目录的服务。只启用下次自动启动：若需要现在接管前台进程，先安排停止前台，再在其他终端运行 `systemctl --user start dili`，避免中断本工具托管的会话。服务单元为 `dili.service`；旧版的 `sessiondeck.service` 在启用时迁移，只停用旧单元，不停止其实例。已有源码服务升级到 npm 安装，应在原安装禁用旧服务并确认会话已停止，再迁移服务文件。

无需登录持续运行另需用户明确执行 `loginctl enable-linger`。用户服务绑定 Node 和 npm 包的绝对路径；更换 Node/npm 安装位置后，需要在停机窗口更新服务路径。

WSL 内服务只会在发行版启动后运行。若需 Windows 开机后启动发行版，请自行配置 Windows 任务计划；Dili 不把启用 WSL 内 systemd 等同于 Windows 开机启动。

## 可选语音输入（FunASR）

默认不安装 Python 依赖或下载模型。在本机「设置 / 连接与能力 → 语音输入」点击「安装并启用 FunASR」即可开始后台安装；网页显示当前阶段，安装完会加载流式模型。需要 Python 3.10+ 和 `venv`，Linux / WSL2 或 macOS。Linux 缺少 venv 时请先安装发行版的 `python3-venv`；Dili 不自动执行 sudo。此版本固定使用 FunASR 1.3.14、PyTorch / torchaudio 2.8.0，Linux 使用 CPU wheels，不自动安装 CUDA。

依赖、模型缓存位于数据目录下 `plugins/funasr/`，独立于项目及用户其他 Python 环境。预留数 GB 空间，首次安装及模型下载需要访问 PyPI、PyTorch、ModelScope（可能涉及其模型下载源）。失败可按页面提示修复网络或 Python 环境后重试。主机不会因启动 Dili 或打开会话而自动安装插件；已启用的模型按需加载，空闲五分钟自动释放工作进程，下次使用需要重新加载。关闭语音开关会释放识别进程，保留已下载依赖和模型以便再次开启。

Codex、Claude 和 dsh-tui 的图形输入框均提供「语音输入」。点击开始收音，再次点击结束；实时文字出现在输入区上方，最终结果追加到最新草稿，用户确认后点击发送。录音期间可以编辑原有草稿；不会将中间结果重复追加。取消录音、关闭会话或切换视图会释放麦克风并丢弃迟到结果。识别失败不改写草稿，已识别片段可手动插入；输入长度或浏览器存储限制导致无法插入时，识别结果保留在提示中供选择复制。原生终端和 Harness 自有 iframe 不注入语音控件。

浏览器访问需要 HTTPS 或 localhost，并允许麦克风权限。优先通过 MediaRecorder 录制 Opus（WebM / Ogg）；Safari 不支持 Opus 时使用 MP4，由主机 FFmpeg 解码为 16 kHz 单声道 PCM。请求 24 kbps，实际码率由浏览器决定。音频以二进制分片经过独立、鉴权且有 CSRF 校验的 WebSocket 接口传输，复用现有中继，不修改中继服务。每段最长 120 秒 / 2 MiB，每帧最多 256 KiB，一台主机同时识别一段录音；网络或推理积压达到上限会停止本次识别。

手机音频通过可信中继到达 Dili 主机。公开 HTTPS 在中继终止，因此中继可以接触音频内容；这不是端到端加密。Dili 不落盘音频、不将录音或识别正文写入应用日志；最终文本按既有会话草稿规则保存在浏览器，用户发送后由原生 Agent 保存。第一版仅提供本地 FunASR 流式识别（中文为主，含英语词汇），未接入浏览器厂商或云端 ASR，也不做耳机按键和 AI 润色。

自动化覆盖浏览器录音协议、草稿保护、权限与真实 FFmpeg 三种容器解码；模拟识别器不代表模型准确率。本轮另在隔离临时目录完成了真实 CPU 依赖安装与 FunASR 流式模型加载检查，验收后清理该目录。真实麦克风、手机网络、识别准确率、推理延迟及内存占用仍需要在目标设备补充验收。
