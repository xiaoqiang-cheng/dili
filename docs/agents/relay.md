# 远程访问与中继

## 组成

| 文件 | 作用 |
| --- | --- |
| `server/relay-main.ts` | 中继管理服务入口（默认 18501，仅回环） |
| `server/relay-service.ts` | 管理页、设备、邀请码、通知、带宽与限速 |
| `server/relay-store.ts` | 中继自己的 SQLite（数据目录） |
| `server/frp.ts` / `server/frp-install.ts` | 本机 frp 客户端与安装校验 |
| `server/invite.ts` / `server/pairing.ts` | 邀请码解码、一次性兑换与设备配对 |
| `server/remote.ts` | 远程设置、隧道与 SecretBox |
| `relay/public.caddy` | Caddy 示例（`route` 保证先鉴权后改写） |

## 邀请码流程

1. 管理员在 `https://dili.discoverpaw.com/connect/` 用管理密钥生成一次性邀请码（默认 1 小时／24 小时／7 天／永不过期）。
2. 本机粘贴邀请码 + 设备名；服务安装并启动官方 frp 客户端，生成设备链接。
3. 手机打开设备链接，用所有者密码登录。
4. 邀请码只限制首次兑换；已配对设备不受邀请码过期影响，撤销设备才会断开。

失败处理：安装失败不消耗邀请码；同一邀请码遇到网络错误可重试；保存兑换标识防止重复创建设备。

## 权限

- 远程所有者：除修改密码、远程配置和原生回调（仅本机）外的全部功能。
- 分享（只读／可协作／群组）：见 `server/access.ts` 与 `docs/agents/security.md`。
- 设备按来源限速；撤销设备立即断开其 SSE 与终端。

## 部署要点

- 只承诺“自建可信中继”。HTTPS 在中继终止，不是端到端加密。
- 中继数据目录保留 `relay.sqlite`、`admin.token`、`plugin.token`；不要清空目录来改密码。
- Caddy 若启用全站 `encode`，必须排除 `text/event-stream`，否则实时状态被缓冲。
- 设备路径必须用 `route`，否则 Caddy 默认排序可能先改写路径再鉴权。
- frps 与中继服务只监听回环，公网暴露交给 Caddy/DNS。

## A 方案链路（2026-11-01）

浏览器 origin 始终保持公网域名。家用网络通过 split-horizon DNS 让同一域名解析到主机 LAN IP；外网走公网 Caddy + 中继 + 按设备分配的 FRP 端口。详细部署、Caddy 片段和验收见 [remote-network.md](remote-network.md)。

- 主机远程监听默认 `127.0.0.1`；需要绑定固定私网地址时用 `SESSIONDECK_REMOTE_BIND`，并用 `SESSIONDECK_REMOTE_ALLOW` 限制来源。
- `/internal/route` 对每个设备只返回它自己的 `127.0.0.1:<设备端口>`。曾经的主机 P2P 上游已移除：一个裸地址会对所有设备生效，导致三个不同的设备链接打开同一台机器，详见 [remote-network.md](remote-network.md)。
- 公网网页服务由主机侧 `/web-proxy/<token>/` 转发；dsh 原生界面自动使用，普通服务需 `SESSIONDECK_WEB_PROXY_TARGETS` 显式允许。路径代理的绝对资源路径边界见 TODO 23。

## 常见坑

1. 中继管理页与工作台登录是两套密码：`admin.token` ≠ Dili 所有者密码。
2. 邀请码默认带域名白名单；新增域名要同时改 DNS、证书、Caddy 与 `SESSIONDECK_RELAY_DOMAINS`。
3. 设备链接的令牌在 `#` 之后，服务端日志不应出现；发现出现在日志里要当事故处理。
4. 远程网页服务不再默认直连：公网页面会经主机代理，目标必须在 `SESSIONDECK_WEB_PROXY_TARGETS` 中；dsh 原生界面不需要额外配置。绝对根路径的站点仍可能不完整，见 TODO 23。

## 官方域名

唯一浏览器入口为 `https://dili.discoverpaw.com`，管理页为 `/connect/`。新邀请默认仅提供该域名。旧 `discoverpaw.com/connect/...` 与 `:8443` 网页入口返回 410，不跳转。

`relay/pwa.caddy` 用于新域名；`relay/retired-origin.caddy` 用于旧域名，仅保留既有已配对设备的认证传输接口，避免改变签名绑定。`shared/relay-public-url.ts` 只规范展示/分享地址，不改设备传输身份。旧域名 PWA 需从新域名重新安装。
