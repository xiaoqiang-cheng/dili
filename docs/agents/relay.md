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

1. 管理员在 `/connect/` 用管理密钥生成一次性邀请码（默认 1 小时／24 小时／7 天／永不过期）。
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

## 常见坑

1. 中继管理页与工作台登录是两套密码：`admin.token` ≠ Dili 所有者密码。
2. 邀请码默认带域名白名单；新增域名要同时改 DNS、证书、Caddy 与 `SESSIONDECK_RELAY_DOMAINS`。
3. 设备链接的令牌在 `#` 之后，服务端日志不应出现；发现出现在日志里要当事故处理。
4. 远程打开工作台不会自动转发主机上的开发端口，见 TODO 23。
