#!/usr/bin/env bash
# Unpacks the system libraries Playwright's Chromium needs into the user's home,
# for machines where `npx playwright install-deps` is not possible (no sudo).
# Debian/Ubuntu only. The browser tests pick the directory up automatically;
# nothing outside it is changed. Re-running replaces it.
set -euo pipefail

target="${DILI_BROWSER_LIBS_ROOT:-$HOME/.local/share/dili-browser-libs}"
browser="$(ls -d "$HOME"/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell 2>/dev/null | sort | tail -1 || true)"
if [[ -z "$browser" ]]; then
  echo "没有找到 Playwright 的 Chromium，请先运行 npx playwright install chromium" >&2
  exit 1
fi
command -v apt-get >/dev/null && command -v dpkg-deb >/dev/null || { echo "需要 apt-get 与 dpkg-deb（Debian/Ubuntu）" >&2; exit 1; }

missing="$(ldd "$browser" | awk '/not found/ { print $1 }' | sort -u)"
if [[ -z "$missing" ]]; then
  echo "Chromium 依赖已齐全，无需处理。"
  exit 0
fi
echo "缺少的库：$(echo $missing)"

# Ask dpkg which package ships each library (works without the package installed).
packages=()
for library in $missing; do
  package="$(apt-file search -l "/$library" 2>/dev/null | head -1 || true)"
  if [[ -z "$package" ]]; then
    case "$library" in
      libnspr4.so|libplc4.so|libplds4.so) package=libnspr4 ;;
      libnss3.so|libnssutil3.so|libsmime3.so|libssl3.so) package=libnss3 ;;
      libasound.so.2) package="$(apt-cache show libasound2t64 >/dev/null 2>&1 && echo libasound2t64 || echo libasound2)" ;;
      *) echo "不知道 $library 属于哪个包；可安装 apt-file 后重试，或用 sudo npx playwright install-deps" >&2; exit 1 ;;
    esac
  fi
  packages+=("$package")
done

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
(cd "$work" && apt-get download $(printf '%s\n' "${packages[@]}" | sort -u))
rm -rf "$target.new"
mkdir -p "$target.new"
for deb in "$work"/*.deb; do dpkg-deb -x "$deb" "$target.new"; done
rm -rf "$target"
mv "$target.new" "$target"

libs="$target/usr/lib/x86_64-linux-gnu"
still="$(LD_LIBRARY_PATH="$libs" ldd "$browser" | awk '/not found/ { print $1 }' | sort -u)"
if [[ -n "$still" ]]; then
  echo "仍缺少：$(echo $still)" >&2
  exit 1
fi
echo "已安装到 $target；浏览器测试会自动使用。"
