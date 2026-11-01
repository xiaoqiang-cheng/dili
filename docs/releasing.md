# 正式版发布清单

当前代码版本：0.5.4。通过 GitHub Release 分发安装包；未发布到 npm registry。发布记录不代表下面未勾选的真机或生产环境验收已经完成。

## 发布范围与承诺

首个正式版优先支持 Linux x86_64 / WSL2 x86_64，Node.js 24+；工作台浏览器以当前 Chromium 为主。0.5.2 新增电脑、Android Chromium 与 iPhone WebKit 的 PWA 入口自动化验证；手机安装和系统权限仍需真机验收。WSL2 沿用 Linux 运行方式，但需要在真实 Windows + WSL2 环境补做安装、中文输入、目录访问和启动验收。Windows 原生、macOS、ARM64 不在本轮正式发行保证内。

Dili 是本地 Web 工作台；工作目录、会话和笔记留在服务主机。Claude / Codex / Harness 仍独立负责认证、付费、模型执行与权限。API 配置保存时不产生模型请求，也不保证账号或服务商兼容。

## 发布前必须完成

- [ ] **包名和发布账号**：确认 npm 包名。暂定 `dili-workbench`，可用性查询不是预留；确认 npm 所有者、2FA 或可信发布身份。命令保持 `dili`。
- [ ] **许可证**：由项目所有者决定许可证，加入 LICENSE 和第三方声明。当前 `UNLICENSED` 是保留权利的占位，不代表已经选定开源许可证。
- [x] **安装制品验证**：`npm run test:package` 生成 tarball，以独立全局前缀安装，仅安装生产依赖，在其他工作目录实际执行 `dili`、`--version`、`doctor`，验收 PTY、网页资源和独立数据目录。
- [x] **自动化回归**：`npm run verify` 类型、服务端和隔离浏览器测试；`npm run test:package` 验证可安装性。CI 已接入这些检查，尚需在云端实际运行通过。
- [ ] **真实 Agent 验收**：记录准确版本，逐一验证创建、输入、中文输入法、恢复、Fork、审批、通知及跨工具交接。DeepSeek CLI / dsh-tui 分别记录版本；不能以无模型演示替代真实协议兼容性。
- [ ] **原生配置验收**：在干净账号测试 Claude 账号/API 登录、Codex 账号/API 登录及兼容 Responses 的自定义服务、Harness 原生 Web API 设置。确认原生终端独立使用；检查已有 OAuth、API Key、env 配置冲突。配置文件有备份，Codex TOML 重写会规范化格式并移除注释。
- [ ] **自动启动验收**：真实 Linux 用户会话与 WSL2 systemd 下测试登录后启动；验证端口和数据路径。新服务不会自动接管当前前台进程，需要安排一次关闭前台再启动用户服务。检查 npm 包升级路径变化，不自动覆盖其他安装的服务。
- [ ] **升级、回退与备份**：v0.3.0 数据备份后升级，联系人、原生身份、笔记、群组和远程设置保持；验证新数据能否安全回退。不要在运行中替换依赖或删除锁。
- [ ] **远程发布门槛**：公网 TLS、所有者登录、读写分享、断线恢复、静态资源懒加载、中文输入与手机浏览器验收。自定义域名兑换已修复并通过本地端到端回归，仍需部署后的 DNS、TLS、Caddy/frp 全链路验收。
- [ ] **中继独立部署验收**：在干净服务器安装 Node24、frps 和 Caddy，验证管理员密钥自设/保存、1小时/24小时/7天/永久邀请码、撤销和恢复。中继压缩包包含服务和客户端下载归档，不会自动安装或启动 frps/Caddy；需要完成部署文档或完善整包。
- [ ] **发布内容**：CHANGELOG / release notes、安装指南、支持矩阵、截图、已知限制、问题反馈入口；校验版本号与 tag 相同，核对包内容无密钥、用户数据和本机路径。
- [ ] **用户批准具体发布**：本地开发和提交不能推断为 npm publish、Git push、创建 tag 或修改云端仓库的授权。

## 本地制作与验证

```sh
npm ci
npm run verify
npm run test:package
npm run build:relay
SESSIONDECK_FRP_PLATFORMS=linux_amd64 npm run prepare:relay-clients
npm run package:release
```

本地 `npm pack` 会先原子构建网页；得到 `dili-workbench-0.5.4.tgz`。流水线保存 npm tarball、Linux 工作台/中继 tar.gz 和 SHA256SUMS；此阶段不自动发布 npm。

发布脚本不会为你创建 tag 或上传。收到针对目标仓库、版本和 npm 包的具体授权后，再推送版本 tag 触发 GitHub Release；npm 发布单独执行/配置可信发布。正式版的准入条件是制品、真实 Agent 和远程工作流全部通过，而不是仅有一个版本标签。

服务端测试文件按顺序运行：现有子进程集成测试先探测空闲端口再启动服务，并行运行会产生端口复用竞争。保留所有权限、隔离与协议回归，后续统一改为原子分配端口的测试启动器后再恢复文件级并行。
