# 远程网络：同网直连、P2P 与 FRP 回退

## 目标与约束

远程访问必须同时满足：

- 手机/PWA 的 **origin 不变**（PWA 安装后不能换域名），所以不能把公网页面直接改成 `http://192.168.x.x:4317`。
- 客户端不安装任何东西；主机和公网服务器可以安装组件。
- 同一局域网内优先走局域网直连，不绕公网；外网优先走主机与服务器之间的 P2P，P2P 不可用时自动回退 FRP。
- Dili 的所有鉴权、Origin、设备撤销语义继续生效，不能因为换了链路而绕过。

## 链路分层

```
手机/PWA ──HTTPS──> discoverpaw.com
                      │
                      ├─ 在家：DNS 返回主机 LAN IP，Caddy 直连主机 4318
                      └─ 在外：Caddy ──> 中继 18501 ──> X-SessionDeck-Upstream
                                              ├─ EasyTier/WireGuard 虚拟 IP:4318（优先）
                                              └─ 127.0.0.1:<frp 端口>:4318（回退）
```

浏览器看到的始终是 `https://discoverpaw.com/connect/d/<id>/`，Dili 的 `remoteBase` 和 Cookie 路径不变。

## 一、同一局域网直连

### DNS

在家庭路由器的 DNS（dnsmasq、AdGuard Home、Pi-hole 或企业 DNS）中做 split-horizon：

- `discoverpaw.com` A → 主机 LAN IP（例如 `192.168.1.10`）
- 如果公网有 AAAA，必须同时覆盖 AAAA；否则浏览器可能优先走 IPv6 到公网。
- 不要改写 `/etc/hosts` 之外的全局 DNS；只影响家庭网络。

### 主机 Caddy

主机需要为同一个域名提供可信 HTTPS。证书用 DNS-01 申请（需要带对应 DNS provider 插件的 Caddy 构建），公网服务器和主机可以各自持有同一域名的证书；不要把服务器私钥复制到不受信任的位置。

示例（放在主机 Caddy 的站点块中）：

```caddyfile
discoverpaw.com {
  tls {
    dns cloudflare {env.CLOUDFLARE_API_TOKEN}
  }
  handle /connect/d/* {
    route {
      # 与 relay/public.caddy 一样：先鉴权/保留前缀语义，再剥掉设备前缀。
      # 家庭直连没有中继 forward_auth，但 Dili 仍会在 4318 校验登录 Cookie。
      uri path_regexp ^/connect/d/[a-z0-9]{16}(/|$) /
      reverse_proxy 127.0.0.1:4318 {
        header_up Host {host}
        flush_interval -1
      }
    }
  }
}
```

要点：

- 主机 Caddy 必须把 `/connect/d/<id>/...` 剥成 `/...` 再交给 4318；否则 Dili 的 `remoteBase` 会与请求路径重复。
- 家庭直连没有中继的 `forward_auth`，但 4318 仍要求登录 Cookie；未登录会被 Dili 拒绝，不是公开入口。
- 如果家里使用公网服务器的证书文件，注意证书续期和私钥权限；更推荐主机自己用 DNS-01。
- Caddy 的 `encode` 必须排除 `text/event-stream`。

### 验证

在家庭网络内：

```bash
curl -I https://discoverpaw.com/connect/d/<id>/
# 证书、Host、Origin 正常；响应来自主机而不是公网服务器
```

手机 PWA 不重新安装，直接打开原图标；地址栏 origin 不变。

## 二、主机与公网服务器的 P2P

推荐 EasyTier（也可用 WireGuard/Tailscale，只要主机和服务器能互相访问一个私有地址）。

### 主机

安装 EasyTier 后加入同一个网络，给主机一个稳定虚拟 IP，例如 `10.144.0.2`。如果云安全组只开放 443，不要让 EasyTier 直接监听 11010；用 Caddy 把一条 WebSocket 路径反代到 EasyTier 的本机 WS 监听（本仓库实测 `wss` 可用）。主机示例配置（按实际网络替换）：

```toml
instance_name = "dili-host"
hostname = "dili-host"
ipv4 = "10.144.0.2/24"

[[peer]]
uri = "wss://<公网域名>/dili-p2p"

[network_identity]
network_name = "<随机网络名>"
network_secret = "<与服务器相同的随机密钥>"
```

主机只做客户端，用 `--no-listener` 启动；启动后确认 `ping -c 3 10.144.0.1`。不要把 `network_secret` 放进仓库、URL 或可被普通用户读取的文件。

### 公网服务器的 Caddy 与 EasyTier

EasyTier 只监听回环 WS，不新增公网端口：

```toml
instance_name = "dili-relay"
hostname = "dili-relay"
ipv4 = "10.144.0.1/24"
listeners = ["ws://127.0.0.1:11011"]

[network_identity]
network_name = "<随机网络名>"
network_secret = "<同一随机密钥>"
```

在已有 TLS 站点的 Caddyfile 中加入（`/dili-p2p*` 不需要登录，靠 EasyTier 网络密钥鉴别）：

```caddyfile
handle /dili-p2p* {
  reverse_proxy 127.0.0.1:11011
}
```

然后 `caddy validate`、`systemctl reload caddy`。如果安全组允许额外的 TCP/UDP 端口，也可以让 EasyTier 直接监听 `tcp://0.0.0.0:11010` 并让主机用 `tcp://<公网地址>:11010`；但必须真正限制该端口，不能把 EasyTier 控制面暴露成开放中继。

### 主机 Dili

FRP 仍从回环连 4318，P2P 从虚拟网卡连 4318，所以监听地址要同时覆盖两者：

```bash
SESSIONDECK_REMOTE_BIND=0.0.0.0
SESSIONDECK_REMOTE_ALLOW=10.144.0.1
```

`SESSIONDECK_REMOTE_ALLOW` 是**来源地址**限制，不是 Host/Origin 的替代：默认只允许回环（FRP、本机 Caddy、SSH 转发）；绑定 `0.0.0.0` 时必须把 P2P 服务器地址加入，否则来自虚拟网卡的请求会被 403。主机没有额外防火墙时，这一层仍会拒绝同一网段的其他设备。若主机有 nftables/Windows 防火墙，再只放行 `127.0.0.1`、EasyTier 虚拟网段和管理网段。

`SESSIONDECK_REMOTE_BIND` 与 `SESSIONDECK_REMOTE_ALLOW` 都只接受 IP/CIDR；默认 `127.0.0.1` 且无额外来源，保持原行为。

### 公网中继

中继仍负责设备鉴权和路径剥离，只在选择上游时优先 P2P：

```bash
SESSIONDECK_RELAY_P2P_UPSTREAM=10.144.0.2:4318
```

中继服务是独立的打包进程（`/opt/sessiondeck-relay/relay.mjs`），要先把包含 P2P 探测的 `npm run build:relay` 产物同步过去再重启；只改环境变量而用旧 relay.mjs 不会生效。

重启中继后，`/internal/route` 会先探测 `http://10.144.0.2:4318/api/auth/status`（Host 为公网域名），成功才返回 P2P 上游；探测失败或超时自动返回原来的 `127.0.0.1:<frp 端口>`。探测结果缓存 5 秒，不会给每个请求增加一次握手。

多个主机时用设备 id 覆盖：

```bash
SESSIONDECK_RELAY_P2P_UPSTREAM='10.144.0.2:4318,<deviceId>=10.144.0.3:4318'
```

注意：

- 中继到主机的 P2P 是**服务器到主机**的链路；浏览器到服务器仍是 HTTPS，不改变现有信任边界。
- P2P 健康探测只代表 Dili 可达；实际 HTTP 失败仍由 Caddy 返回错误，不会静默伪造成功。
- FRP 配置、设备端口和 `X-SessionDeck-Upstream` 都保留，P2P 挂掉不需要重新配对。

## 三、主机网页服务转发

公网 PWA 不能直接访问主机的 `127.0.0.1` 或 LAN 地址（混合内容 + Private Network Access）。Dili 增加了主机侧 HTTP/WebSocket 代理：

- dsh 原生界面在远程访问时自动经 `/web-proxy/<token>/` 转发，浏览器地址栏不出现 dsh 启动令牌。
- 普通网页服务必须由主机显式允许来源：

```bash
SESSIONDECK_WEB_PROXY_TARGETS='http://127.0.0.1:5173,http://10.11.1.111:3000'
```

- 代理只接受所有者、只连接回环/私网地址、令牌短期有效；Dili 的登录 Cookie 不会转发给上游服务。
- 路径代理对使用相对路径的应用（包括 dsh）有效；使用根路径绝对资源（`/assets/...`）的站点可能不完整，这是当前阶段边界，不能承诺任意网站可嵌入。
- **路径代理与 Dili 同源**：被允许的网页可以携带 Dili 的设备 Cookie 调用同源 API。只允许可信服务，不要把该允许列表当作隔离边界；独立预览子域名（每服务一个 origin）仍待排期，见 TODO 23。

## 验收清单

1. 在家：`curl` 域名解析到 LAN IP，PWA 打开不经过公网。
2. 在外：P2P 探活成功时中继上游为虚拟 IP；停掉 EasyTier 后 5 秒内回退 FRP。
3. 两种链路都能登录、看状态、打开原生 dsh 界面和允许列表中的网页服务。
4. 撤销设备后，两条链路都立即失效。
5. 主机 4318 没有公网监听；公网只开 443（和既有 FRP 端口）。
