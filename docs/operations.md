# 使用、备份与故障处理

更新日期：2026-11-02。首次安装和自动启动见[安装指南](installation.md)；中继配对、域名和管理员密钥见[远程访问](remote-access.md)。

## 数据与备份

默认数据目录为 `~/.local/share/dili`（旧版本为 `~/.local/share/sessiondeck`，见下节自动迁移），可用 `SESSIONDECK_DATA_DIR` 指定。同一数据目录只允许一个实例，不能删除活动锁文件绕过保护。

### 数据目录更名（`sessiondeck` → `dili`）

旧版本把数据放在 `~/.local/share/sessiondeck`。新版本首次启动时会把整个目录原子重命名到 `~/.local/share/dili`，并在旧路径留下指向新目录的符号链接，因此旧服务单元、旧脚本和手工写的 `SESSIONDECK_DATA_DIR=~/.local/share/sessiondeck` 仍读写同一份数据，不会出现两个空库。

- 迁移前先取得旧目录 `instance-lock.sqlite` 的锁：若旧实例仍在运行，本次沿用旧目录，等它退出后的下一次启动再迁移，绝不重命名正在写入的目录。
- 只迁移旧默认路径；通过 `SESSIONDECK_DATA_DIR` 指定的其他目录不会被移动（值恰好是旧默认路径时例外）。
- 重命名失败时继续使用旧目录，启动日志会说明原因。
- 迁移后可以删除旧路径的符号链接；删除后旧版本 Dili 会新建空目录，因此只在确认不再回退旧版本时删除。

元数据可在线备份，不用停止正在运行的会话：

```sh
npm run backup
npm run backup -- --output /path/to/new-backup.sqlite
```

图片文件持久保存在数据目录的 `chat-images/`（图形附件）和 `terminal-images/`（原生终端附件），避免原生恢复引用失效。当前没有自动垃圾回收或磁盘配额，清理前应确认原生历史不再依赖文件。数据库备份不包含图片文件，迁移需另外备份这两个目录并保留原生历史中的路径关系。

默认写入当前数据目录的 `backups/`；备份包含联系人、群组、群消息、投递记录、随手记、远程配置和活动，**不包含三种原生工具自己的历史或凭据**。命令使用 SQLite 一致性备份，不会改变运行状态，现有目标文件不会被覆盖。

恢复时先停止 Dili，把备份文件放入一个新的空目录并命名为 `sessiondeck.sqlite`，再用 `SESSIONDECK_DATA_DIR=/path/to/restored npm start` 启动；这样保留现有数据目录供回退。原生会话仍需原有原生历史及可用的工作目录。服务恢复后所有托管进程均显示未运行，不会自动重新执行任务。

## Codex 沙箱在 Ubuntu 24.04 上无法启动

症状：Codex 的每条命令都在执行前失败，报 `bwrap: setting up uid map: Permission denied`。原因是 Ubuntu 23.10+ 默认 `kernel.apparmor_restrict_unprivileged_userns=1`，没有 AppArmor 配置文件的程序不能创建用户命名空间，在使用 bwrap 的 Codex 版本上可能触发。先在普通终端运行 Codex 并核对错误，确认是同一系统限制。确认后可在独立终端执行仓库中的修复脚本（需要 sudo）：

```bash
scripts/fix-codex-sandbox.sh
```

它给 bwrap 写入一个只授予 `userns` 的 AppArmor 配置文件并加载，沙箱本身保持开启；已打开的 Codex 会话直接恢复，不用重启任何服务。

## 重启服务与单元迁移

服务可以作为 `systemd --user` 单元运行，启用后可在用户登录时启动；无需登录持续运行还需 linger。WSL 内服务要先启动发行版，不等于 Windows 开机启动。重启会终止托管会话，应等任务结束后，从独立于该实例的终端操作：

```bash
scripts/install-service.sh    # 安装单元，尝试启用 linger；不启动或重启当前实例
scripts/restart-service.sh    # 从独立终端发起；会结束本实例托管的 Agent / Shell
```

重启会停止所有正在运行的 Agent 会话（它们是服务的子进程）；联系人保留原生会话 ID，可在原生历史及目录可用时手动恢复。脚本只会停止本项目、监听该端口的 Dili 进程，不会按端口误杀其他程序。手动查看：`systemctl --user status dili.service`，日志：`journalctl --user -u dili.service -f`。

用户服务名为 `dili.service`。旧版本安装的 `sessiondeck.service` 仍会被识别：设置页「迁移到 dili.service」、`dili service enable` 会启用新单元并停用旧单元；`scripts/install-service.sh` 仅安装新单元并停用旧单元的自动启动，不启动或重启实例；`scripts/restart-service.sh` 会把旧单元托管的实例切换到 `dili.service`。

### 改名或移动源码目录

单元文件记录的是绝对路径，联系人、群组和独立工作树也各自保存绝对工作目录。把 checkout 从 `~/Develop/sessiondeck` 改成 `~/Develop/dili` 这类操作只改变路径，不改内容，但两处记录需要各自跟上：

1. **单元文件**：直接在新目录运行 `scripts/restart-service.sh`。脚本按自身位置推导目录，发现 `dili.service` 的 `WorkingDirectory`／`ExecStart` 仍指向旧目录时，只改写这些含旧目录的行，保留自定义 `Environment=`（例如 `CODEX_HOME`、位于旧 checkout 内的 `SESSIONDECK_DATA_DIR`），然后 `daemon-reload`；只有单元不是本项目的启动命令时才按当前目录重装。它不会启动旧路径。校验失败会打印 `journalctl --user -u dili -n 50` 的提示，不会再“停掉旧实例但起不来”。
2. **工作目录**：启动时会自动处理最常见的改名场景——数据目录里的 `install-root.json` 记录 Dili 运行过的 checkout；若记录中的目录已经消失、其父目录仍在，就把该目录下的联系人／群组工作目录改写到当前 checkout（只在新位置确实存在时逐字段改写，附加目录、独立工作树与群工作区都覆盖）。换盘、同名重建、只改子目录等无法安全判断的情况不猜，先用工具预览，再备份并写入：

```bash
npm run repair:workspaces -- --from /home/me/Develop/sessiondeck --to /home/me/Develop/dili
npm run backup
npm run repair:workspaces -- --from /home/me/Develop/sessiondeck --to /home/me/Develop/dili --apply
```

工具只改写旧前缀下、且新目录确实存在的路径（普通目录、附加目录、独立工作树、群工作区），并列出被跳过的项。写入只改存储，**运行中的实例仍持有旧路径的内存快照，需要重启 Dili 后页面才显示新路径**；已经运行的进程继续使用启动时的目录。`npm run doctor` 会列出当前不存在的工作目录，便于确认修复是否完成。

Dili 只修复自己的记录。原生工具另有一套按绝对路径或会话 ID 保存的历史（例如 `~/.claude/projects/…-sessiondeck/`、`~/.codex/sessions`、`~/.dsh/storages`）：Dili 的对话面板按会话 ID 跨目录查找，不受改名影响；但原生 CLI 能否在旧目录之外恢复旧上下文由各后端决定，无法恢复时以原生提示为准，不要假定 Dili 已经修好原生侧。

## 日常工作流

**先创建一张联系人卡片。** 选择后端、名称，点击「浏览」选择已有工作目录，或粘贴路径／`file://` 链接，进入后启动原生会话。卡片显示最近输入，目录旁按钮可直接复制完整路径。Codex 默认打开「图形对话」，直接输入发送，回复支持 Markdown 和代码复制，审批及提问出现在对话中；随时可切换「原生终端」。Claude 结构化图形模式支持流式回复、文字／图片、审批与问题，生成中发送进入队列；切换原生终端需空闲并确认交接。已安装 dsh-tui 的 Harness 可在记录页直接发送文字或图片。无 dsh-tui 时使用 Harness 原生 Web。顶部「打开终端」会显示 VS Code 风格的底部终端，可添加多个独立 Shell 标签并左右分屏，同时保留当前会话。首次登录、Harness／PTY 兼容路径的审批及图形界面尚不支持的确认在原生终端处理。关闭详情只离开视图；Codex「停止生成」中断当前一轮并暂停队列，「停止会话」结束托管运行。

**使用终端。** 点击顶部终端图标启动底部 Shell，直接输入命令并回车。「＋」新增终端，分屏按钮并排显示两个终端，拖动上边缘调整高度。面板右上角「×」只隐藏面板，标签上的「×」结束该终端。

**查看工作区。** 点击顶部文件夹图标，在右侧统一预览面板展开文件树。点击 Markdown 文件或 Git 变更直接在目录旁预览，左上角可以收起／展开目录，两栏之间可拖动调整宽度；顶部标签切换其他工作区、随手记或网页，＋菜单可以新增网页。拖动面板左边缘调整宽度，隐藏面板保留标签，刷新恢复标签和尺寸。文件工作区固定来自打开时的联系人工作目录，资源管理器不会修改文件。

**让几个会话协作。** 创建群组并写下共同目标，添加新成员或 Fork 已有会话。写一条任务，选择收件人，再处理每个成员的待投递项。Codex／Claude 结构化图形成员和 dsh 的“发送到会话”通过原生接口执行；终端成员的“填入”只准备输入，需要进入该成员按回车。群内没有自动广播。

**共享结果并继续。** 在成员私聊中选中需要的输出，作为结果共享到群组；也可直接填写结果并标注来源成员。使用“转交为任务”修改说明、指定下一位成员，再确认投递。卡片仍可随时单独打开纠正；Fork 的会话上下文独立，但工作文件默认共享。

**处理连接问题。** 卡片状态代表 Agent 的执行状态，终端“已连接”只代表浏览器通道可用。浏览器断线后会自动恢复；服务重启后，卡片保留，但原生进程需要手动恢复。使用 `npm run doctor` 检查本地环境，进入“连接与能力”重新检测原生命令。端口冲突时设置对应的端口变量，不会接管或停止占用端口的其他服务。

**遇到请求超时。** 启动、停止或 Fork 需要等待原生程序响应，页面会保留更长的等待时间。若仍提示超时，先刷新状态并查看是否已经完成，再决定重试。投递显示“结果待确认”时，进入原生会话核对，再选择已收到或未收到；不要重复提交尚未核对的任务。

**保存数据。** 联系人名称、群组和投递记录保存在本机 SQLite；使用 `npm run backup` 生成一致性备份。后端自身的对话历史仍保存在各原生工具中。群组草稿保存在当前浏览器；图形私聊草稿、队列和待确认标识保存在当前标签页，均不包含在服务器数据库备份里。
