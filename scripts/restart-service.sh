#!/usr/bin/env bash
# Restarts Dili on this machine, safe to run from a shell that
# Dili itself hosts (the bottom terminal, even over remote access).
#
# The work runs in its own transient systemd unit. setsid is not enough: a process
# started from Dili's terminal stays in dili.service's cgroup whatever its session,
# and stopping the service kills that whole cgroup, so the restart would die before
# starting anything. Every running agent session is stopped with the service;
# contacts keep their native IDs and resume from their cards.
#
# Every path comes from this script's own location, so the checkout can be
# renamed or moved: the installed unit is rewritten for the current directory
# before anything is stopped.
set -euo pipefail

project_dir="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
self="$project_dir/scripts/restart-service.sh"
port="${SESSIONDECK_PORT:-${PORT:-4317}}"
log="${TMPDIR:-/tmp}/dili-restart.log"
default_unit="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/dili.service"

if ! load_state="$(systemctl --user show --property=LoadState --value dili 2>/dev/null)"; then
  echo "无法连接 systemd --user。请在能使用 systemctl --user 的终端执行，或先运行 scripts/install-service.sh。" >&2
  exit 1
fi
if [[ "$load_state" != loaded ]]; then
  echo "$(date '+%F %T') 未安装 dili.service，按当前目录安装"
  "$project_dir/scripts/install-service.sh"
fi

# A unit keeps absolute paths, so a renamed or moved checkout would restart the
# old directory (or fail to start). Rewrite only the paths it names, so custom
# Environment= lines survive; a foreign unit is reinstalled from scratch.
# Neither touches the running instance.
unit_path="$(systemctl --user show --property=FragmentPath --value dili 2>/dev/null || true)"
[[ -n "$unit_path" && -f "$unit_path" ]] || unit_path="$default_unit"
if [[ -f "$unit_path" ]]; then
  tsx="$project_dir/node_modules/.bin/tsx"
  [[ -x "$tsx" ]] || tsx="$(command -v tsx || true)"
  if [[ -n "$tsx" ]]; then
    relocation="$("$tsx" "$project_dir/scripts/unit-relocation.ts" --unit "$unit_path" --project "$project_dir" 2>&1)" \
      || relocation="reinstall 无法解析服务单元：${relocation:-未知错误}"
  else
    relocation="reinstall 没有可用的 tsx，无法改写服务单元"
  fi
  case "$relocation" in
    rewrite\ *)
      echo "$(date '+%F %T') dili.service 指向 ${relocation#rewrite }，改写为 $project_dir（保留其他设置）"
      # The running process is not touched; the reload applies to the restart below.
      systemctl --user daemon-reload
      ;;
    reinstall\ *)
      echo "$(date '+%F %T') dili.service 需要重装：${relocation#reinstall }"
      "$project_dir/scripts/install-service.sh"
      ;;
    none) ;;
    *) echo "无法检查 dili.service：$relocation" >&2; exit 1 ;;
  esac
fi

if [[ "${1:-}" != --detached ]]; then
  restart_unit=dili-restart
  if systemctl --user is-active --quiet "$restart_unit" 2>/dev/null; then
    echo "已有一次重启正在进行，日志：$log"
    exit 0
  fi
  # A transient unit starts from the manager's environment, not this shell's.
  # Do not fall back to a plain background job: inside Dili it would stop the
  # service and then die, leaving the machine without Dili or its remote link.
  run_env=(--setenv=PATH="$PATH")
  for name in SESSIONDECK_PORT PORT TMPDIR; do
    [[ -n "${!name:-}" ]] && run_env+=(--setenv="$name=${!name}")
  done
  if ! systemd-run --user --quiet --collect --unit="$restart_unit" "${run_env[@]}" \
    /usr/bin/env bash -c 'exec "$0" --detached >"$1" 2>&1 </dev/null' "$self" "$log"; then
    echo "无法用 systemd-run 启动重启任务，当前服务未改动。" >&2
    exit 1
  fi
  echo "正在后台重启 Dili，日志：$log"
  echo "这个终端会随旧服务一起关闭；十几秒后刷新页面即可。"
  exit 0
fi

# Build before touching the running instance: a failed build then just aborts
# the restart, and the atomic publish never empties assets it is still serving.
if [[ "$(cd "$project_dir" && npx tsx scripts/needs-build.ts)" == yes ]]; then
  echo "$(date '+%F %T') 前端代码已变化，重新构建"
  (cd "$project_dir" && npm run build)
fi

# Only stop a listener that is provably this project's server, never by port alone.
pid="$(lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | head -1 || true)"
if [[ -n "$pid" ]]; then
  cmd="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
  cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
  if [[ ("$cmd" != *server/index.ts* && "$cmd" != *bin/dili.mjs*) || "$cwd" != "$project_dir" ]]; then
    echo "端口 $port 上的进程 $pid 不是本项目的 Dili（$cmd，目录 $cwd），已放弃。" >&2
    exit 1
  fi
  unit_pid="$(systemctl --user show dili -p MainPID --value 2>/dev/null || echo 0)"
  if [[ "$unit_pid" == "$pid" ]]; then
    echo "$(date '+%F %T') 通过 systemd 重启"
    systemctl --user stop dili
  fi
  # Instance started by the pre-rename unit: stop it there, then start dili.
  legacy_pid="$(systemctl --user show sessiondeck -p MainPID --value 2>/dev/null || echo 0)"
  if [[ "$legacy_pid" == "$pid" ]]; then
    echo "$(date '+%F %T') 停止旧的 sessiondeck.service"
    systemctl --user stop sessiondeck
    systemctl --user disable sessiondeck 2>/dev/null || true
  fi
  if kill -0 "$pid" 2>/dev/null; then
    echo "$(date '+%F %T') 停止旧实例 $pid（$cmd）"
    kill -TERM "$pid"
  fi
  for _ in $(seq 1 60); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
  done
  if kill -0 "$pid" 2>/dev/null; then echo "旧实例 60 秒内未退出，放弃启动新实例。" >&2; exit 1; fi
fi
for _ in $(seq 1 20); do
  lsof -nP -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 || break
  sleep 1
done
echo "$(date '+%F %T') 启动 systemd 服务"
# Pick up a unit file that changed outside this script (a manual edit or a
# reinstall that could not reload) so the start below uses the current paths.
systemctl --user daemon-reload
if ! systemctl --user enable --now dili; then
  systemctl --user --no-pager --lines=20 status dili || true
  echo "dili.service 启动失败；查看 journalctl --user -u dili -n 50" >&2
  exit 1
fi
# start.sh installs dependencies and builds first, so the listener can take a
# while; report success only when the port really answers again.
up=0
for i in $(seq 1 180); do
  if lsof -nP -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then up=1; break; fi
  # A failed unit will never open the port; stop waiting instead of idling 3 minutes.
  if (( i % 5 == 0 )); then
    state="$(systemctl --user is-active dili 2>/dev/null || true)"
    [[ "$state" == failed || "$state" == inactive ]] && break
  fi
  sleep 1
done
systemctl --user --no-pager --lines=5 status dili || true
if [[ "$up" != 1 ]]; then
  echo "端口 $port 在 180 秒内没有监听，服务未就绪；查看 journalctl --user -u dili -n 50" >&2
  exit 1
fi
echo "$(date '+%F %T') Dili 已启动：http://127.0.0.1:$port"
