# 安全边界

## 访问登记

- 每个 API 必须在 `server/access.ts` 的 `ROUTES` 登记；未登记一律 404。
- `server/auth.test.ts` 会枚举 Express 已注册路由，漏登记会让测试失败；`server/access.test.ts` 覆盖未登记 404、分享读写、群组隔离与 local/remote 边界。新增路由先登记再实现。
- 等级：
  - `public`：登录、分享兑换、认证状态；
  - `owner`：工作区数据、Shell、目录浏览、分享与远程设置；
  - `read`/`write`：会话分享的只读／可协作；
  - `local`：只允许本机回环（原生 hook、密码修改、远程配置）。
- 群组分享只能访问 `/api/groups/:id` 及其附件／语音／消息；会话分享只能访问 `params.id === principal.sessionId`。

## 请求来源

- `server/security.ts` 校验 `Origin`（HTTP 与 WebSocket 都校验）。没有 Origin 的本机工具请求可放行，跨站必须拒绝。
- 远程入口与本地入口共用路由，但 `remote` 参数会拒绝 `local` 级操作。
- CSRF 令牌由 `/api/config` 下发，写操作要求 `X-SessionDeck-Token`。

## 凭据

- 所有者密码用 `scrypt` 加盐保存；设备凭证、分享令牌只存哈希。
- 令牌放在分享链接 `#` 之后，避免进入服务器访问日志；打开后立刻从地址栏移除。
- 更换密码会使所有远程设备失效；撤销分享/设备会立即断开对应终端与 SSE。
- 错误信息、日志和诊断接口不得输出密码、令牌、原生 CLI 的环境变量。新增诊断字段前先问“这会不会帮助别人接管这台机器”。

## 路径与上传

- 文件预览限制在会话工作目录内；符号链接按真实路径检查（`server/workspace.ts`、`server/paths.ts`）。
- 目录选择器（`server/directories.ts`）只列目录，不读文件内容。
- 上传大小在服务端限制（图片 10 MiB、每消息 8 张）；不要只依赖前端校验。
- 追加目录权限只追加、不放宽审批或沙箱；dsh 不支持时明确报错。

## 命令行参数

- 启动原生 CLI 一律使用参数数组（`execFile`/spawn 无 shell），不拼接命令字符串。
- 来自用户的工作目录、会话名、群消息不得进入 shell；需要展示命令时只做转义显示。
- `scripts/*.test.ts` 与 `server/adapters.test.ts` 覆盖“参数数组、无 shell、无注入”的回归；`server/shell-quote.ts` 的引号函数由 `server/security-boundaries.test.ts` 通过真实 `sh` 验证。

## 远程与中继

- HTTPS 在中继终止，不是端到端加密；文档和界面都必须这样说明。
- 中继管理密钥是数据目录中的 `admin.token`，不打印、不进仓库、不进 URL。
- frp 与中继服务只监听回环，由 Caddy 对外。

### 主机网页代理

- 只有所有者可登记和访问 `/api/web-proxy`；普通网页目标还必须在 `SESSIONDECK_WEB_PROXY_TARGETS` 中，避免把远程入口变成任意私网地址的开放代理。
- 代理令牌随机、短期、只存在内存；浏览器 URL 不携带 dsh 启动令牌。上游地址只允许回环/私网，拒绝账号密码、非 HTTP(S) 和公网目标。
- 转发前剔除 Dili 的设备 Cookie；上游 `Set-Cookie` 的 `Domain` 被移除、`Path` 收窄到代理前缀。`/web-proxy` 不经过 API 路由表，因此单独执行所有者检查，并依赖现有 Host/Origin 校验拒绝跨站请求。
- 远程监听在用 `SESSIONDECK_REMOTE_BIND` 绑定非回环地址时，另用 `SESSIONDECK_REMOTE_ALLOW`（IP/CIDR）限制 socket 来源；只默认信任回环。Host/Origin 与来源地址是两道独立检查，不能互相替代。
- 代理保留上游的 `X-Frame-Options`/CSP；站点自行禁止嵌入时不能假装成功。路径代理不重写 HTML/JS，绝对根路径资源可能失效。
- **路径代理与 Dili 同源**：被允许的网页可以携带 Dili 的设备 Cookie 调用同源 API，因此它只应加入可信服务，不能把 `SESSIONDECK_WEB_PROXY_TARGETS` 当成隔离边界。独立预览子域名（每服务独立 origin）实现前，不要宣称已解决该风险。dsh 原生界面是 Dili 自己管理的目标，仍按可信原生路径处理。

## 评审清单

1. 新路由登记了吗？测试能枚举到吗？
2. 分享访问能拿到不属于自己的会话／群组／终端吗？
3. 输入进入文件路径、命令行或 HTML 时被处理了吗？
4. 失败信息会泄露路径、令牌或凭据吗？
