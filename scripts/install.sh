#!/bin/sh
# Specseal CLI 安装脚本（cli-distribution spec「安装脚本一行安装对应平台 CLI」，
# design D3／release-assets-trim D6）。侦测平台、自 npm registry 取得对应平台子套件的
# tgz、验证 sha512 integrity 后安装——服务没有 Node、没有 brew 的机器（服务器、WSL、CI）。
# binary 的唯一来源是 npm：这里抓的 tgz 就是 npm i -g @specseal/cli 会装到的那一份。
#
# 用法：
#   curl -fsSL https://raw.githubusercontent.com/MomoChenisMe/speclink/main/scripts/install.sh | sh
#   sh scripts/install.sh --dry-run
#
# 环境变量：
#   SPECSEAL_INSTALL_VERSION   钉选版本（0.5.0 或 v0.5.0）；未设置时查 registry 的 latest
#   SPECSEAL_INSTALL_DIR       安装目录；缺省 ~/.local/bin
#   SPECSEAL_INSTALL_REGISTRY  npm registry；缺省 https://registry.npmjs.org
#
# 一律先验 integrity 再落档：验证在暂存目录完成，不符即中止，安装目录不会出现半份
# 或损毁的 binary。Windows 没有脚本：有图形接口就用桌面安装器（内含同版 CLI 并管 PATH），
# 有 Node 就 npm i -g @specseal/cli。
set -eu

REGISTRY="${SPECSEAL_INSTALL_REGISTRY:-https://registry.npmjs.org}"
REGISTRY="${REGISTRY%/}"
INSTALL_DIR="${SPECSEAL_INSTALL_DIR:-$HOME/.local/bin}"
BIN=specseal
SCOPE=@specseal

die() {
  echo "install.sh: $1" >&2
  exit 1
}

# integrity 也是向同一个 registry 问来的：走明文等于没验，所以只接受 https。
case "$REGISTRY" in
  https://*) ;;
  *) die "SPECSEAL_INSTALL_REGISTRY 必须是 https:// 开头（目前为 ${REGISTRY}）" ;;
esac

usage() {
  cat <<'USAGE'
用法：sh install.sh [--dry-run]

  --dry-run   只印出解析结果（平台、版本、下载网址、安装目录），不连网、不写档
  --help      显示本说明

环境变量：SPECSEAL_INSTALL_VERSION／SPECSEAL_INSTALL_DIR／SPECSEAL_INSTALL_REGISTRY
USAGE
}

dry_run=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=1 ;;
    --help|-h) usage; exit 0 ;;
    *) die "未知参数：$arg" ;;
  esac
done

# --- 平台侦测 ---
#
# 映射到 npm 平台子套件名（os-cpu），与 scripts/npm/npm-platform-package.mjs 的 TARGETS 一致。
detect_platform() {
  uname_s="$(uname -s)"
  uname_m="$(uname -m)"
  case "$uname_s" in
    Darwin)
      case "$uname_m" in
        arm64|aarch64) echo darwin-arm64 ;;
        x86_64) echo darwin-x64 ;;
        *) die "macOS 上不支持的架构：$uname_m" ;;
      esac
      ;;
    Linux)
      case "$uname_m" in
        x86_64|amd64) echo linux-x64 ;;
        aarch64|arm64) echo linux-arm64 ;;
        *) die "Linux 上不支持的架构：$uname_m" ;;
      esac
      ;;
    MINGW*|MSYS*|CYGWIN*|Windows*)
      die "此脚本支持 macOS 与 Linux；Windows 请运行 npm i -g @specseal/cli，或安装桌面版 Specseal_<版本>_x64-setup.exe（内含 CLI）"
      ;;
    *)
      die "不支持的操作系统：$uname_s"
      ;;
  esac
}

PLATFORM="$(detect_platform)"
PKG="${SCOPE}/cli-${PLATFORM}"

# Linux 的 binary 是 glibc 动态链接：musl（Alpine 等）装进去也跑不起来（loader 缺席只印一句
# not found），在这里就讲清楚。ldd --version 在 musl 印 "musl libc (…)"；没有 ldd 就不挡。
case "$PLATFORM" in
  linux-*)
    if command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; then
      die "侦测到 musl libc；目前的 Linux binary 只支持 glibc（Debian／Ubuntu／Fedora 等），Alpine 请改用容器内的 glibc 环境或自行建置"
    fi
    ;;
esac

# registry 的 tgz 路径：<registry>/@scope/name/-/name-<版本>.tgz（文件名不带 scope）。
tgz_url() {
  echo "${REGISTRY}/${PKG}/-/cli-${PLATFORM}-$1.tgz"
}

# --- 版本解析 ---
#
# 钉选值接受带或不带 v 前缀，去前缀后必须是 X.Y.Z（可带 -pre 尾）——版本会拼进网址
# 与暂存盘名，不合形的值（例如带 ../）不能往下走。dry-run 不连网，未钉选时只标示为
# latest 并在网址中保留占位。
VERSION="${SPECSEAL_INSTALL_VERSION:-}"
VERSION="${VERSION#v}"
if [ -n "$VERSION" ]; then
  printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' \
    || die "SPECSEAL_INSTALL_VERSION 必须是 X.Y.Z（可带 v 前缀），目前为 $VERSION"
fi
if [ "$dry_run" -eq 1 ]; then
  if [ -z "$VERSION" ]; then
    version_label="latest（安装时查找 ${REGISTRY}/${SCOPE}/cli/latest）"
    version_in_url="<version>"
  else
    version_label="$VERSION"
    version_in_url="$VERSION"
  fi
  cat <<EOF
平台：      $PLATFORM
套件：      $PKG
版本：      $version_label
下载网址：  $(tgz_url "$version_in_url")
安装目录：  $INSTALL_DIR
EOF
  exit 0
fi

command -v curl >/dev/null 2>&1 || die "找不到 curl，请先安装后重试"
command -v openssl >/dev/null 2>&1 || die "找不到 openssl，无法验证 integrity；请先安装后重试"

# 取 JSON 里第一个出现的 "<key>":"<value>"——registry 的回应是单行 JSON；version 在顶层、
# integrity 在 dist 之内，两者在各自的回应里都只出现一次。
json_field() {
  grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -n 1 | sed 's/.*:[[:space:]]*"\(.*\)"$/\1/'
}

if [ -z "$VERSION" ]; then
  latest="${REGISTRY}/${SCOPE}/cli/latest"
  body="$(curl -fsSL "$latest")" || die "查找最新版本失败：$latest"
  VERSION="$(printf '%s' "$body" | json_field version)"
  [ -n "$VERSION" ] || die "无法从 $latest 的回应解析出 version"
fi

TGZ_URL="$(tgz_url "$VERSION")"
TGZ_NAME="cli-${PLATFORM}-${VERSION}.tgz"

# --- 下载与验证 ---
#
# 全程在暂存目录进行；trap 涵盖正常结束与中断，不留残档——包括落档阶段写在安装目录
# 的暂存名档（chmod／mv 失败或中途 Ctrl-C 时它会留成一个隐藏档）。
tmp="$(mktemp -d)"
staging=""
# 明确把离开码带过 trap：只写 rm 的话，清理指令的成功状态会盖掉失败的离开码，
# 让 integrity 不符这类中止对调用端看起来像成功。
cleanup() {
  rc=$?
  rm -rf "$tmp"
  if [ -n "$staging" ]; then rm -f "$staging"; fi
  exit "$rc"
}
trap cleanup EXIT INT TERM

echo "下载 ${PKG}@${VERSION}…"
manifest_url="${REGISTRY}/${PKG}/${VERSION}"
manifest="$(curl -fsSL "$manifest_url")" || die "查找 ${PKG}@${VERSION} 失败：$manifest_url"
expected="$(printf '%s' "$manifest" | json_field integrity)"
case "$expected" in
  sha512-*) ;;
  *) die "registry 未提供 ${PKG}@${VERSION} 的 sha512 integrity，已中止安装" ;;
esac

curl -fsSL -o "$tmp/$TGZ_NAME" "$TGZ_URL" || die "下载失败：$TGZ_URL"

actual="sha512-$(openssl dgst -sha512 -binary "$tmp/$TGZ_NAME" | openssl base64 -A)"
[ "$actual" = "$expected" ] || die "integrity 不符（预期 ${expected}，实得 ${actual}），已中止安装"

# --- 安装 ---
#
# npm 的 tgz 内容在 package/ 之下；验证通过才碰安装目录——失败路径不会在此留下任何文件。
mkdir -p "$tmp/extract"
tar xzf "$tmp/$TGZ_NAME" -C "$tmp/extract" --strip-components=1 "package/$BIN" || die "解压 $TGZ_NAME 失败"
[ -f "$tmp/extract/$BIN" ] || die "tgz 中找不到 package/$BIN"

# 先写到同目录暂存名再 mv 覆盖：安装目录里可能是桌面 app 留下的 symlink（macOS 指向
# app bundle 内的 CLI），cp 会写穿到它指的档；mv 换掉的是链接本身。
mkdir -p "$INSTALL_DIR"
staging="$INSTALL_DIR/.$BIN.tmp.$$"
cp "$tmp/extract/$BIN" "$staging"
chmod 755 "$staging"
mv -f "$staging" "$INSTALL_DIR/$BIN"

echo "已安装 $BIN $VERSION 至 $INSTALL_DIR/$BIN"

case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) ;;
  *) echo "提醒：$INSTALL_DIR 不在 PATH 中，请将它加入 shell 设置档后重开终端机" ;;
esac
