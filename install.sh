#!/usr/bin/env bash
# DSH 插件「中转站用量」一键安装（macOS / Linux）
#
#   ./install.sh                                  # 自动探测 profile，装最新版
#   ./install.sh --profile desktop                # 指定 profile
#   ./install.sh --proxy http://192.168.31.9:7893 # 走代理下载
#   ./install.sh --tgz ./xxx.tgz                  # 用本地包
#   ./install.sh --uninstall
#
# 做的事：下载 release 包 → 解到 ~/.local/share/dsh-plugins →
# 在 profile 的 node_modules 建符号链接 → 往 profile 的 package.json 写入
# dependencies 与 dsh.profile.bundles（改前自动备份）。

set -euo pipefail

REPO="desstg/dsh-relay-usage"
PKG="@desstg/dsh-relay-usage"
REF="latest"
PROFILE=""
PROXY=""
TGZ=""
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
INSTALL_DIR=""
UNINSTALL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2 ;;
    --proxy) PROXY="$2"; shift 2 ;;
    --tgz) TGZ="$2"; shift 2 ;;
    --ref) REF="$2"; shift 2 ;;
    --dsh-home) DSH_HOME="$2"; shift 2 ;;
    --install-dir) INSTALL_DIR="$2"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

step() { printf '\033[36m→ %s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m%s\033[0m\n' "$1"; }

# 1) profile
PROFILES_ROOT="$DSH_HOME/profiles"
[[ -d "$PROFILES_ROOT" ]] || { echo "找不到 $PROFILES_ROOT（用 --dsh-home 指定）" >&2; exit 1; }
if [[ -z "$PROFILE" ]]; then
  mapfile -t dirs < <(find "$PROFILES_ROOT" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' 2>/dev/null || ls -1 "$PROFILES_ROOT")
  if [[ ${#dirs[@]} -eq 1 ]]; then PROFILE="${dirs[0]}"
  elif [[ " ${dirs[*]} " == *" desktop "* ]]; then PROFILE="desktop"
  else echo "检测到多个 profile：${dirs[*]}；用 --profile 指定" >&2; exit 1; fi
fi
PROFILE_DIR="$PROFILES_ROOT/$PROFILE"
[[ -d "$PROFILE_DIR" ]] || { echo "profile 不存在：$PROFILE_DIR" >&2; exit 1; }
PKG_JSON="$PROFILE_DIR/package.json"
[[ -f "$PKG_JSON" ]] || { echo "缺少 $PKG_JSON" >&2; exit 1; }
step "profile: $PROFILE_DIR"

[[ -n "$INSTALL_DIR" ]] || INSTALL_DIR="$HOME/.local/share/dsh-plugins/dsh-relay-usage"
LINK_PATH="$PROFILE_DIR/node_modules/$PKG"

# 2) 卸载
if [[ $UNINSTALL -eq 1 ]]; then
  step "卸载"
  [[ -e "$LINK_PATH" || -L "$LINK_PATH" ]] && rm -f "$LINK_PATH" && ok "已移除链接"
  cp "$PKG_JSON" "$PKG_JSON.bak-uninstall-$(date +%Y%m%d-%H%M%S)"
  node -e '
    const fs=require("fs"),p=process.argv[1],name=process.argv[2];
    const j=JSON.parse(fs.readFileSync(p,"utf8"));
    if(j.dependencies) delete j.dependencies[name];
    if(j.dsh&&j.dsh.profile&&Array.isArray(j.dsh.profile.bundles))
      j.dsh.profile.bundles=j.dsh.profile.bundles.filter(x=>x!==name);
    fs.writeFileSync(p,JSON.stringify(j,null,2)+"\n");
  ' "$PKG_JSON" "$PKG"
  ok "已从 package.json 移除"
  [[ -d "$INSTALL_DIR" ]] && rm -rf "$INSTALL_DIR" && ok "已删除 $INSTALL_DIR"
  echo; echo "重启 DSH 生效。"
  exit 0
fi

# 3) 取包
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
if [[ -n "$TGZ" && -f "$TGZ" ]]; then
  step "使用本地包 $TGZ"; TARBALL="$TGZ"
else
  CURL=(curl -sSL --retry 3 --max-time 180)
  [[ -n "$PROXY" ]] && CURL+=(-x "$PROXY")
  if [[ "$REF" == "latest" ]]; then
    step "查询最新 release"
    API=(curl -sS --max-time 60)
    [[ -n "$PROXY" ]] && API+=(-x "$PROXY")
    REF="$("${API[@]}" "https://api.github.com/repos/$REPO/releases/latest" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)"
    [[ -n "$REF" ]] || { echo "查询 latest 失败，可用 --ref v1.5.1" >&2; exit 1; }
  fi
  ASSET="$(echo "${PKG#@}" | tr '/' '-')-${REF#v}.tgz"
  URL="https://github.com/$REPO/releases/download/$REF/$ASSET"
  step "下载 $URL"
  TARBALL="$WORK/plugin.tgz"
  "${CURL[@]}" -o "$TARBALL" "$URL" || { echo "下载失败；github.com 不通时加 --proxy" >&2; exit 1; }
  ok "已下载 $(du -h "$TARBALL" | cut -f1)"
fi

# 4) 解包
rm -rf "$INSTALL_DIR"; mkdir -p "$INSTALL_DIR"
step "解包到 $INSTALL_DIR"
tar -xzf "$TARBALL" -C "$INSTALL_DIR"
if [[ -d "$INSTALL_DIR/package" ]]; then
  mv "$INSTALL_DIR/package/"* "$INSTALL_DIR/" 2>/dev/null || true
  rm -rf "$INSTALL_DIR/package"
fi
[[ -f "$INSTALL_DIR/package.json" ]] || { echo "解包后没有 package.json" >&2; exit 1; }
ok "解包完成"

# 5) 链接
mkdir -p "$(dirname "$LINK_PATH")"
[[ -e "$LINK_PATH" || -L "$LINK_PATH" ]] && rm -f "$LINK_PATH"
step "建立符号链接"
ln -s "$INSTALL_DIR" "$LINK_PATH"
ok "$LINK_PATH"

# 6) 写 package.json
step "更新 profile 配置"
cp "$PKG_JSON" "$PKG_JSON.bak-relay-$(date +%Y%m%d-%H%M%S)"
node -e '
  const fs=require("fs"),p=process.argv[1],name=process.argv[2],dir=process.argv[3];
  const j=JSON.parse(fs.readFileSync(p,"utf8"));
  j.dependencies=j.dependencies||{};
  j.dependencies[name]="link:"+dir;
  j.dsh=j.dsh||{}; j.dsh.profile=j.dsh.profile||{};
  const bundles=Array.isArray(j.dsh.profile.bundles)?j.dsh.profile.bundles:[];
  if(!bundles.includes(name)) bundles.push(name);
  j.dsh.profile.bundles=bundles;
  fs.writeFileSync(p,JSON.stringify(j,null,2)+"\n");
' "$PKG_JSON" "$PKG" "$INSTALL_DIR"
ok "已登记"

echo
printf '\033[32m安装完成：%s\033[0m\n' "$PKG"
echo "  1) 重启 DSH（或让插件管理器把 relay-usage 这行关掉再打开）"
echo "  2) 左侧栏出现「中转站」，点开登录你自己的站点账号"
echo "  3) 页面已开的话按 Ctrl+F5 / Cmd+R 刷新"
