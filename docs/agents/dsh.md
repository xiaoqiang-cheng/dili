# DeepSeek Harness（dsh）

## 两条路径

1. **dsh-tui 存在**：`server/terminal.ts` 托管原生 PTY，输入、图片、审批都在原生 TUI 里完成；Dili 提供联系人、状态和对话记录。
2. **没有 dsh-tui**：`server/dsh.ts` 启动 Harness 自己的 Web 服务，页面用 iframe 打开原生界面；对话记录走原生 session 历史 API 或压缩日志。

用 `SESSIONDECK_DSH_PREFER_WEB=1` 可强制走 Web 桥（TUI 挂起但收不到输入时的退路）。

## 身份与服务

- dsh 0.1 的会话 ID 是 `session-<uuid>`，0.2 / dsh-tui 是裸 UUID；`DSH_ID` 两者都接受。
- 原生 Web 服务按需启动，端口由 `SESSIONDECK_DSH_PORT` 指定；未指定时每次选空闲端口。
- 服务只监听本机；不要把它当成可远程访问的入口。
- `server/dsh-auto.ts` 会在 dsh 配置目录写一个自动模式插件；写入使用 0600，失败不应阻止会话启动。

## 能力边界

- 多工作区／`--add-dir`：**不支持**，界面必须解释原因，不能假装成功。
- 统一模型与权限面板：**未接入**，沿用原生设置。
- 审批与提问：仍在原生 TUI/Web 处理；Dili 只显示“等待审批/等待输入”。
- 停止：通过原生接口取消任务，不要关闭共享 Web 服务或影响其他成员。
- Fork：保留原目录；不支持改目录。
- 使用量（token/费用）：原生历史未提供稳定字段时显示“原生未提供”，不要估算。

## 常见坑

1. 压缩日志是多个 zstd frame，不能只用一次 `zstdDecompressSync`；用 `decodeDshFrames` 并按字节推进。
2. 压缩日志有大小上限；超出时回退到原生分页 API，不整文件解码。
3. 事件 `seq` 用于消息 ID；没有 `seq` 的旧版本要显式降级，不能生成会碰撞的 ID。
4. 停止空闲且尚未附着页面的会话是幂等操作；不要报错。
5. 不要把“支持 DeepSeek 模型”当成“支持 DeepSeek Harness”。
