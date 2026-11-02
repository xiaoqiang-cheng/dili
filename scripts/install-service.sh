#!/usr/bin/env bash
# Installs Dili as a systemd --user service so it can be restarted from
# anywhere (including a Dili shell opened remotely) and comes back after
# a reboot. This never stops a running instance; see restart-service.sh.
# The unit records absolute paths, so re-run this after moving or renaming the
# checkout; restart-service.sh does that automatically when it finds the unit
# pointing somewhere else.
set -euo pipefail

project_dir="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
node_bin="$(dirname -- "$(command -v node)")"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$unit_dir"

cat > "$unit_dir/dili.service" <<EOF
[Unit]
Description=Dili (local-first home for coding agent sessions)
After=network.target

[Service]
Type=exec
WorkingDirectory=$project_dir
Environment=PATH=$node_bin:/usr/local/bin:/usr/bin:/bin
# start.sh installs missing deps, builds atomically, then execs the server so
# SIGTERM reaches Node and running agents are shut down cleanly.
ExecStart=$project_dir/start.sh
Restart=on-failure
RestartSec=3
TimeoutStopSec=30
KillMode=mixed

[Install]
WantedBy=default.target
EOF

if ! systemctl --user daemon-reload; then
  echo "已写入 $unit_dir/dili.service，但无法连接 systemd --user；请在可用的用户会话执行 systemctl --user daemon-reload。" >&2
  exit 1
fi
systemd-analyze --user verify "$unit_dir/dili.service" 2>&1 | grep -v '^$' || true
# Keep user services alive without an interactive login (needed after reboot).
if [[ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != yes ]]; then
  loginctl enable-linger "$USER" 2>/dev/null && echo "已启用 linger：重启电脑后服务会自动启动。" || echo "提示：loginctl enable-linger 需要权限，稍后可用 sudo loginctl enable-linger $USER。"
fi
# Units installed before the rename would start a second instance on boot.
# Disable only; a running legacy instance is moved over by restart-service.sh.
if [[ "$(systemctl --user is-enabled sessiondeck.service 2>/dev/null)" == enabled ]]; then
  systemctl --user disable sessiondeck.service && echo "已停用旧的 sessiondeck.service（未停止正在运行的实例）。"
fi
echo "已安装 dili.service（未启动）。迁移正在运行的实例：scripts/restart-service.sh"
