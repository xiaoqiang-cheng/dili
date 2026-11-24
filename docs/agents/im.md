# IM 接入：微信 ClawBot 与飞书

用户在 IM 里只面对嘀哩（见 `coordinator.md`）。IM 消息进入一个话题，由嘀哩回答，回答再发回 IM。

## 组成

| 文件 | 作用 |
| --- | --- |
| `server/im/hub.ts` | 渠道无关：主人绑定、去重、确定性指令、聊天 ↔ 话题、回答与审批提醒的回传 |
| `server/im/feishu.ts` | 飞书长连接（WebSocket）收事件、REST 发消息 |
| `server/im/pbbp2.ts` | 飞书长连接的 protobuf 帧，手写编解码（与 protobufjs 逐字节一致） |
| `server/im/weixin.ts` | 微信 ClawBot（iLink）扫码登录、长轮询收消息、发消息 |
| `client/ImSettings.tsx` | 设置页「IM 接入」卡片 |
| `shared/im.ts` | 设置页看到的状态（不含任何密钥） |

接口：`GET /api/im`（所有者），其余 `/api/im/*` 写操作仅本机（`access: 'local'`）。

## 安全边界

- 只有**主人**的消息会被处理。微信：扫码登录的人自动成为主人。飞书：设置页生成 6 位绑定码（10 分钟有效），第一个在飞书里发送它的人成为主人。陌生人的消息直接丢弃、不回复。
- 飞书群聊只处理 @ 机器人的消息。
- 指令由 Dili 确定性处理，不经过模型：`/话题`、`/切换`、`/新话题`、`/当前`、`/帮助`、`同意 P-xxxx`、`拒绝 P-xxxx`。批准提议只能走这条路径。
- 凭据（飞书 App Secret、微信 bot token、同步游标）与绑定都存为 SecretBox 加密的设置：`im-feishu`、`im-weixin`、`im-binding-<渠道>`。
- 嘀哩没有执行工具；IM 消息最多让它把活派给参与者，这与用户在话题里亲自 @ 等价。审批仍须在 Dili 里由用户完成，IM 只收到提醒。

## 飞书

协议对照 `@larksuiteoapi/node-sdk` 1.76 的 `WSClient`（没有引入这个 30 MB 的依赖）：

1. `POST https://open.feishu.cn/callback/ws/endpoint`，body `{AppID, AppSecret}`，返回 `data.URL`（含 `service_id`）和 `ClientConfig.PingInterval`（秒）。code `1`、`1000040343` 可重试，其他视为配置错误，不再重试。
2. 连接 `URL`；按 `PingInterval` 发 ping 帧（`method: 0`，`service` = `service_id`，header `type: ping`）；pong 帧里可能带新的 `PingInterval`。
3. 数据帧 `method: 1`、header `type: event`；`sum`/`seq` 分片按 `message_id` 拼接（10 秒过期）。处理后必须回 ACK：原帧 + header `biz_rt`，payload `{"code":200}`，否则飞书会重发。
4. 回复：`tenant_access_token/internal` 换 token（缓存到过期前 1 分钟），`POST /open-apis/im/v1/messages?receive_id_type=chat_id`，`msg_type: text`。机器人 open_id 用 `GET /open-apis/bot/v3/info` 取，用来判断群里是否 @ 了它。
5. 开放平台需要：企业自建应用、机器人能力、权限 `im:message`、`im:message:send_as_bot`、`im:message.p2p_msg:readonly`、`im:message.group_at_msg:readonly`，事件「使用长连接接收事件」+ `im.message.receive_v1`，然后发布版本。设置步骤也写在设置页里。

## 微信 ClawBot

协议对照官方插件 `@tencent-weixin/openclaw-weixin` 2.4.10（MIT）：

- 登录：`POST ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3` → `qrcode` 与 `qrcode_img_content`（二维码内容 URL，前端渲染）；`GET ilink/bot/get_qrcode_status?qrcode=` 长轮询，状态 `wait` / `scaned` / `need_verifycode`（带 `verify_code` 重试）/ `scaned_but_redirect`（换 `redirect_host`）/ `expired`（最多刷新 3 次）/ `binded_redirect` / `confirmed`（返回 `bot_token`、`ilink_bot_id`、`ilink_user_id`、`baseurl`）。
- 收消息：`POST ilink/bot/getupdates` `{get_updates_buf, base_info}` 长轮询（默认 35 秒，服务端可用 `longpolling_timeout_ms` 调整）；保存返回的 `get_updates_buf`。只处理 `message_type: 1` 的文本或语音转文字。`ret`/`errcode` 为 `-14` 表示登录失效：停下并提示重新扫码。
- 发消息：`POST ilink/bot/sendmessage`，`msg.message_type: 2`、`message_state: 2`、文本 item，并带上该用户最近一条消息的 `context_token`。
- 请求头：`AuthorizationType: ilink_bot_token`、`Authorization: Bearer <token>`、随机 `X-WECHAT-UIN`、`iLink-App-Id: bot`、`iLink-App-ClientVersion`（2.4.10 的编码）。`base_info.bot_agent` 如实填 `Dili/<版本>`。
- uint64 的 `message_id` 必须在 `JSON.parse` 前转成字符串（`parseLossless`）。

## 陷阱与未验证

- 两个渠道的单测都用本地假服务器（`server/im-channels.test.ts`）；**真实账号尚未端到端验证**。iLink 不是公开文档化的接口，官方插件升级可能改变字段，出问题时先对照新版插件源码。
- 微信 ClawBot 仍在灰度；同一个 ClawBot 只能连一个客户端（`binded_redirect`），用户需先断开 OpenClaw 等其他客户端。
- `context_token` 有时效（插件文档提到 24 小时回复窗口）；嘀哩的后台汇总超出窗口时可能发不出去，失败会被吞掉，不影响话题里的记录。
- 回复按段落拆成不超过 1800 字的多条，并去掉 Markdown 标记。
