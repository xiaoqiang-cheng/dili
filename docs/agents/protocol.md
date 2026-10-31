# 状态与事件协议

## 快照与补丁

- `AppState` 带 `instanceId` 和单调 `revision`；`StatePatch` 带 `baseRevision`/`revision`。
- 客户端规则（`client/state.ts`）：
  - 不同 `instanceId` 的补丁丢弃；同一实例倒退的 revision 丢弃。
  - `patch.baseRevision > 当前 revision` 说明漏了事件 → 返回 `null`，App 重新拉取完整快照。
  - `patch.revision <= 当前 revision` 视为重复，保留对象身份。
- 服务端 `StatePublisher` 只序列化变化实体；活动列表上限 100，超出时用 `remove` 通知客户端。
- 任何新增广播都必须走 `StatePublisher`/`broadcast()`，不要绕过 revision 直接 `res.write`。

## SSE 通道

- `GET /api/events` 先发完整 `state`，之后发 `patch`；每 20 秒发命名 `ping`（不是注释），让浏览器能发现被代理缓冲的死流。
- 客户端 45 秒无事件时主动 `refresh()`；`EventSource` 重连不额外刷新，交给补发或完整快照，避免与重放竞态。
- **断线补发**：事件带 `id: <revision>`。服务端保留最近 200 条补丁或 4 MiB（`server/sse-replay.ts`），浏览器重连时自动带 `Last-Event-ID`：
  - 能连续补上 → 只发缺失补丁；
  - 有缺口／超出缓冲／跨实例 → 回退到完整 `state`。
  - 补发按 `baseRevision` 链校验连续性；链断了就整包重发，不能把残缺补丁应用上去。
- 分享访问者收到的 `state` 是过滤后的视图（`viewState`），不得补发包含其他联系人／群组的补丁；他们的连接只发过滤快照。

## 终端通道

- 终端 WebSocket 按 `sessionId` 或 `shellId` 过滤，只有匹配的连接收到数据。
- 单连接积压超过 2 MiB 直接断开，重连时由终端快照重建，避免无限缓存 ANSI。
- `terminal-replay.ts` 保留最近 1000 行用于重连；快照只存内存，不进数据库。

## 身份与实例

- `instanceId` 每次进程启动重新生成；客户端记住最近 8 个实例，拒绝旧实例的晚到响应。
- 服务重启后旧 SSE 连接自然失效；不要把旧补丁应用到新实例。

## 新增事件检查表

1. 它属于会话、群组、活动还是终端？终端不要混进 `AppState`。
2. 是否幂等？重放同一事件不能重复计数、重复提醒或重复发送。
3. 是否需要清洗？分享视图不得泄露目录、原生 ID、群组 prompt 或令牌。
4. 是否有上限？字符串、条目数和连接积压都必须有界。
