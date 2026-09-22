#!/usr/bin/env bash
# 为嵌入式 PostgreSQL（embedded-postgres 16）准备其链接的旧版 ICU 共享库。
# 仅在系统 libicu 版本与二进制不匹配时需要（例如 Debian 12 自带 ICU 72，
# 而 arm64/x64 的嵌入式 PG 链接 libicuuc.so.60）。
#
# 用法：
#   bash ops/e2e-fetch-icu60.sh [目标目录]
# 然后：
#   TEST_ICU_LIB_DIR=<目标目录>/usr/lib/<架构元组> pnpm --filter @handcraft/api test:e2e
set -euo pipefail

TARGET_DIR="${1:-$(cd "$(dirname "$0")/.." && pwd)/.e2e-native-libs}"
ARCH="$(dpkg --print-architecture 2>/dev/null || uname -m)"
mkdir -p "$TARGET_DIR"
cd "$TARGET_DIR"

case "$ARCH" in
  arm64|aarch64)
    PKG_URL="http://ports.ubuntu.com/pool/main/i/icu/libicu60_60.2-3ubuntu3.2_arm64.deb"
    LIBDIR="usr/lib/aarch64-linux-gnu"
    ;;
  amd64|x86_64)
    PKG_URL="http://archive.ubuntu.com/ubuntu/pool/main/i/icu/libicu60_60.2-3ubuntu3.2_amd64.deb"
    LIBDIR="usr/lib/x86_64-linux-gnu"
    ;;
  *)
    echo "不支持的架构: $ARCH，请手动提供 libicuuc.so.60 并设置 TEST_ICU_LIB_DIR" >&2
    exit 1
    ;;
esac

DEB="libicu60.deb"
if [ ! -f "$LIBDIR/libicuuc.so.60" ]; then
  echo "下载 $PKG_URL"
  curl -fsSL -o "$DEB" "$PKG_URL"
  ar x "$DEB"
  tar xf data.tar.*
  rm -f "$DEB" control.tar.* data.tar.* debian-binary 2>/dev/null || true
fi

echo "完成。运行 E2E 前请设置："
echo "  export TEST_ICU_LIB_DIR=\"$TARGET_DIR/$LIBDIR\""
