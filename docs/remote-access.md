# 远程访问与邀请码中继

更新日期：2026-10-23。邀请码是推荐开通方式，SSH 是高级选项。需要自己的可信服务器、域名、TLS 和 Dili 所有者密码；项目不承诺提供公共免费中继服务。自定义域名修复已有本地回归，但部署后的完整验证仍见[发布清单](releasing.md)。

## 从邀请码开始

管理员打开自己中继的 `/connect/` 管理页（默认配置示例为 `https://discoverpaw.com/connect/`），使用服务器上的管理密钥生成一次性邀请码。生成时可选择中继白名单中的访问域名，默认是 `discoverpaw.com`。本机 Dili 在“连接与能力 → 远程访问”粘贴邀请码并填写设备名称，服务会自动安装并启动官方 frp 客户端，生成可复制的设备链接。手机打开设备链接后使用 Dili 所有者密码登录。支持从其他网站点击设备链接进入登录页；仅对工作台入口的顶层页面跳转放行，跨站 API、iframe、终端连接和修改请求仍受到来源校验。

已有 `paw` 部署记录采用 `sessiondeck-relay.service` 和 `sessiondeck-frps.service`，数据目录 `/var/lib/sessiondeck-relay`；这不是新安装的固定目录，也不表示本文重新验证了该服务器。服务与 frps 只监听回环地址，Caddy 通过 `/connect/` 和 `/~!frp` 转发。管理密钥不会写入仓库或 URL。可通过 `SESSIONDECK_RELAY_DOMAINS=discoverpaw.com,example.com` 配置额外域名白名单；这些域名必须在 Caddy／DNS 中指向同一个中继服务。现有 SSH 远程方式仍可在高级设置中使用。

邀请码可选 1 小时、24 小时、7 天或永不过期，每个邀请码只能开通一台设备。有效期只限制首次兑换，已配对设备不会在邀请码到期后断开；需要停用时撤销设备。同一次配对遇到网络错误可用原邀请码重试，保存的兑换标识防止重复创建设备。

首次配对依次显示准备客户端、兑换邀请码和启动连接。客户端下载优先使用管理员指定的镜像、邀请码所在中继提供的安装包，再回退到官方 GitHub 与备用镜像；每个源最多等待 30 秒，所有源合计最多 90 秒，安装包必须通过固定 SHA-256 校验。安装失败不消耗邀请码，失败后显示错误并允许重试。已有配对显示远程连接状态，连接失败时可保存并重连。也可通过 `SESSIONDECK_FRPC_PATH` 指定本机已有客户端。

源码构建更新中继时，在独立 checkout 中运行 `npm run build:relay` 和 `npm run prepare:relay-clients`，将 `dist/relay/relay.mjs`、`dist/relay/index.html` 及 `dist/relay/clients/` 同步到服务器安装目录。客户端安装包目录默认位于管理页面文件旁的 `clients/`，可通过 `SESSIONDECK_RELAY_CLIENTS_DIR` 覆盖。在安排好的维护窗口重启中继服务（上述部署的单元为 `sessiondeck-relay.service`）；保留数据目录中的 SQLite、管理密钥及插件密钥，FRP 配置未变时无需重启 `sessiondeck-frps.service`。

转发配置见 `relay/public.caddy`：设备路径必须使用 `route` 保持先鉴权、后路径改写的顺序，否则 Caddy 默认排序可能让有效链接返回 410。已有站点若启用全站 `encode`，需将响应类型限制为 HTML/CSS/JavaScript/JSON/SVG，排除 `text/event-stream`，避免实时状态被压缩缓冲。修改后用 `caddy validate` 检查，再 reload Caddy。

## 实现与密码设置

- 工作台：`server/remote.ts` 及配对相关模块，管理安装客户端、兑换、隧道和状态。
- 配对服务：`server/relay-main.ts`、`server/relay-service.ts`、`server/relay-store.ts`；管理页面 `relay/index.html`；Caddy 示例 [relay/public.caddy](../relay/public.caddy)。隧道复用 frp，不自行实现转发协议。
- 中继管理密码是数据目录中的 **`admin.token` 文件内容**，与 Dili 所有者密码不同。首次启动自动生成，权限为 0600；不会默认打印密码。管理员在服务器上私下读取，勿粘贴到反馈、聊天或日志。
- 自设密码：启动前，在中继数据目录写入高强度随机 `admin.token` 并设为仅当前用户可读写；已有服务在维护窗口修改后重启以重新读取。当前没有网页修改密码入口。保留 `plugin.token` 和 `relay.sqlite`，不要通过清空目录来改密码。

源码运行中继（先完成 DNS、Caddy 和 frps 部署）：

```sh
SESSIONDECK_RELAY_URL=https://example.com/connect \
SESSIONDECK_RELAY_DATA_DIR=/path/to/private-relay-data npm run relay
```

| 配置 | 默认值与作用 |
| --- | --- |
| `SESSIONDECK_RELAY_DATA_DIR` | `~/.local/share/sessiondeck-relay`，SQLite、管理员密钥、插件密钥及生成的 frps 配置 |
| `SESSIONDECK_RELAY_URL` | `https://discoverpaw.com/connect`，应改为实际公网 HTTPS 入口 |
| `SESSIONDECK_RELAY_DOMAINS` | 逗号分隔的额外域名／地址白名单；DNS、证书与代理配置需另外完成 |
| `SESSIONDECK_RELAY_PORT` | `18501`，管理服务回环端口 |
| `SESSIONDECK_FRPS_PORT` | `18502`，frps 回环端口 |
| `SESSIONDECK_RELAY_FIRST_PORT` / `SESSIONDECK_RELAY_LAST_PORT` | `18700` / `18799`，设备回环端口池 |

中继包与下载归档的构建方式见[发布清单](releasing.md)。压缩包不自动安装 frps、Caddy 或配置 systemd。撤销设备不立即回收端口，避免旧连接占用时分配给其他设备；安全回收仍是待办。

## 权限与传输边界

邀请码只开通连接，不代替所有者登录，也不赋予共享权限。TLS 在可信中继终止，中继能接触经其转发的内容；这不是端到端加密。语音同样经过中继再由主机识别，详见[语音输入](installation.md#可选语音输入funasr)。

本地访问时网页预览仍由浏览器直连目标地址。公网访问时，浏览器不能直连主机的回环或私网地址，Dili 会改用主机侧 `/web-proxy/<token>/` 转发：dsh 原生界面自动使用，普通网页服务需在主机设置 `SESSIONDECK_WEB_PROXY_TARGETS` 显式允许。手机上的 `localhost` 仍不是服务主机；路径代理与独立预览子域名的边界见 [TODO 23](../TODO.md#23-网页服务远程预览与端口转发2026-10-23)。

## SSH 高级方式

```
浏览器 ──HTTPS──▶ 服务器 Caddy（自动证书）──▶ 服务器 127.0.0.1:17317
                                                ▲ SSH 反向隧道（由电脑主动发起、断线自动重连）
                                     电脑 127.0.0.1:<远程端口>（必须登录）
```

1. 在本机打开「连接与能力 → 远程访问与安全」，先设置所有者密码。
2. 服务器：把域名解析到服务器 IP，安装 Caddy，写入页面上生成的配置并 `sudo systemctl reload caddy`。
3. 电脑：确认可以免密 `ssh 用户@服务器` 登录（隧道使用 BatchMode，不会弹出密码输入）。
4. 填写公开地址、服务器地址、SSH 用户，点「启用远程访问」，状态变为「已连接」即可。

- 远程请求使用独立的监听端口（默认 Web 端口 + 1，可用 `SESSIONDECK_REMOTE_PORT` 指定），默认只绑定 `127.0.0.1`；可用 `SESSIONDECK_REMOTE_BIND` 绑定固定私网地址，并用 `SESSIONDECK_REMOTE_ALLOW` 限制来源 IP/CIDR；还必须用防火墙限制来源。隧道只转发这个端口，因此"来自 127.0.0.1"不会被当作本机所有者。
- 服务器端隧道只绑定 `127.0.0.1`，外网只能经过 Caddy 的 HTTPS 访问；TLS 在你的服务器上解密。
- 公网访问 dsh 原生网页界面时，Dili 会经主机侧 `/web-proxy/` 转发并隐藏启动令牌；本地仍直连。普通网页服务需在主机设置 `SESSIONDECK_WEB_PROXY_TARGETS`。链路部署见 [remote-network.md](agents/remote-network.md)。

### PWA 同域入口与服务依赖

同域静态 PWA 与中继路由见 [PWA 部署说明](pwa.md) 和 `relay/pwa.caddy`。现有中继域名继续保留。中继数据库备份使用 SQLite online backup，不能只复制活跃 WAL 数据库的主文件。

frps 的 systemd 单元应使用 `After=sessiondeck-relay.service` 和 `Wants=sessiondeck-relay.service`，不要使用 `Requires=`：后者会在更新中继管理服务时连带停止隧道。调整单元后仅执行 `systemctl daemon-reload` 即可更新依赖，无需重启 frps。管理服务不可用的短暂窗口仍可能使插件验证失败，应选择低流量维护时间并检查客户端恢复。

## 管理员带宽仪表盘

登录中继控制台后，可查看服务器入站/出站速率、最近 30 分钟趋势、窗口单方向峰值和带宽利用率。Linux 服务每 5 秒读取 `/proc/net/dev`，只在内存保留最多 360 点，重启清空；没有采样时显示等待或不可用，不以零流量掩盖失败。指标接口 `/connect/api/admin/bandwidth` 仅对持有管理密钥者开放，不缓存，不采集消息或网络载荷。

这是**整台服务器的网卡流量**，包含其他服务，不是 Dili 专属或每台设备流量。默认汇总除 `lo` 外所有网卡；有容器、网桥、VPN 时请明确指定公网网卡，避免重复计数：

- `SESSIONDECK_RELAY_NETWORK_INTERFACES=eth0`（多个以逗号分隔；按服务器实际网卡名填写）。
- `SESSIONDECK_RELAY_BANDWIDTH_MBPS=100`（可选，填写实际购买的带宽上限，单位 Mbps；不配置则不显示利用率）。

利用率采用入站、出站较高方向除以上限，达到 80% 显示红色；若供应商仅按出站计费，请结合出站读数判断。部署时将这两个环境变量加入中继服务配置，在维护窗口仅重启中继管理服务，不需修改 FRP 协议或重启 frps。非 Linux 环境显示指标不可用。浏览器隐藏后暂停刷新；回到页面自动恢复。
