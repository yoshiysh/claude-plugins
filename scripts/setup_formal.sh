#!/bin/sh
# 形式検証の道具（TLA+ の tla2tools.jar と Z3）を versions.mk の版で tools/formal/ に置く。
# sha256 が合わなければ置かずに止まる。既に置いてあり版が合えば何もしない（流し直してよい）。
# 置いた z3 が動かなければ止まる。tools/formal/ は git 管理外で、.worktreeinclude が worktree へ写す。
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
versions="$root/versions.mk"
dest="$root/tools/formal"
work="$dest/.work.$$"
trap 'rm -rf "$work"' EXIT INT TERM

val() {
  v=$(sed -n "s/^$1 := //p" "$versions")
  [ -n "$v" ] || { echo "setup-formal: versions.mk に $1 がありません" >&2; exit 1; }
  printf '%s' "$v"
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d ' ' -f 1
  else echo "setup-formal: sha256sum も shasum もありません" >&2; exit 1
  fi
}

# fetch <url> <sha256> <出力先>: 作業の場所に落とし、sha256 が合ったときだけ出力先へ置く。
fetch() {
  tmp="$work/$(basename -- "$3")"
  curl -sSfL --retry 3 -o "$tmp" "$1"
  got=$(sha256_of "$tmp")
  if [ "$got" != "$2" ]; then
    echo "setup-formal: $1 の sha256 が versions.mk と違います（${got}）。置かずに止めます" >&2
    exit 1
  fi
  mv "$tmp" "$3"
}

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) key=DARWIN_ARM64 ;;
  Darwin-x86_64) key=DARWIN_X64 ;;
  Linux-x86_64) key=LINUX_X64 ;;
  Linux-aarch64 | Linux-arm64) key=LINUX_ARM64 ;;
  *) echo "setup-formal: $(uname -s)-$(uname -m) 向けの Z3 は versions.mk にありません" >&2; exit 1 ;;
esac

# versions.mk の値は先に変数へ読む（fetch の引数の中で読むと、値が無いときに set -e で止まらない）。
tla_url=$(val TLA2TOOLS_URL)
tla_sha=$(val TLA2TOOLS_SHA256)
z3_base=$(val Z3_URL_BASE)
z3_asset=$(val "Z3_ASSET_$key")
z3_sha=$(val "Z3_SHA256_$key")

mkdir -p "$dest" "$work"

jar="$dest/tla2tools.jar"
if [ ! -f "$jar" ] || [ "$(sha256_of "$jar")" != "$tla_sha" ]; then
  fetch "$tla_url" "$tla_sha" "$work/tla2tools.jar"
  mv "$work/tla2tools.jar" "$jar"
fi

# z3 は zip を残さず、展開した実行ファイルと、それを取り出した資産の sha256（z3/ASSET_SHA256）だけを置く。
# 印が合えば落とし直さない。新しい z3 は作業の場所で用意し、動くことを確かめてから置き換える。
mark="$dest/z3/ASSET_SHA256"
if [ ! -x "$dest/z3/bin/z3" ] || [ ! -f "$mark" ] || [ "$(cat "$mark")" != "$z3_sha" ]; then
  fetch "$z3_base/$z3_asset" "$z3_sha" "$work/z3.zip"
  unzip -q -o "$work/z3.zip" -d "$work/unpack"
  bin=$(find "$work/unpack" -type f -name z3 -path '*/bin/z3' | head -n 1)
  [ -n "$bin" ] || { echo "setup-formal: $z3_asset に bin/z3 がありません" >&2; exit 1; }
  mkdir -p "$work/z3/bin"
  mv "$bin" "$work/z3/bin/z3"
  chmod +x "$work/z3/bin/z3"
  "$work/z3/bin/z3" --version >/dev/null || { echo "setup-formal: $z3_asset の z3 が動きません" >&2; exit 1; }
  printf '%s\n' "$z3_sha" > "$work/z3/ASSET_SHA256"
  rm -rf "$dest/z3"
  mv "$work/z3" "$dest/z3"
fi

z3_version=$("$dest/z3/bin/z3" --version)
echo "setup-formal: TLA2TOOLS=$jar"
echo "setup-formal: Z3=${dest}/z3/bin/z3（${z3_version}）"
echo "setup-formal: formal-method は PATH から z3 を探すので、使うときは PATH=\"$dest/z3/bin:\$PATH\" とする"
