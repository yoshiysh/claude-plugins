# provision-gh-runner と gh-runner-ctl が共有する、手元側の接続処理。
# ターゲット側で動く処理は stdin の heredoc で送るので、関数としてここへは置けない。

SSH_OPTS="-o ConnectTimeout=8 -o BatchMode=yes -o IgnoreUnknown=WarnWeakCrypto -o WarnWeakCrypto=no"

set_target() { TARGET="$1"; KIND="${TARGET%%:*}"; HOST="${TARGET#*:}"; }

# 処理本体は常に stdin でターゲットの bash に流す。ssh → cmd.exe → wsl の多層クォートは
# cmd.exe がシングルクォートを剥がさず必ず壊れるため、クォートを一切経路に見せないことが
# 唯一の安全な渡し方（wsl 経路の実測で確認済み）。
run_target() {
  case "$KIND" in
    local)  bash -s ;;
    ssh)    ssh $SSH_OPTS "$HOST" "bash -s" ;;
    wsl)    ssh $SSH_OPTS "$HOST" "wsl --exec bash -s" ;;
    docker) docker exec -i "$HOST" bash -s ;;
    *) echo "未知の TARGET 種別: ${KIND}（local / ssh: / wsl: / docker: のいずれか）" >&2; exit 2 ;;
  esac
}

list_runners() { gh api "repos/$1/actions/runners" --jq '.runners[] | "\(.name): \(.status)"'; }

print_usage() { awk 'NR>1 && /^#/ {sub(/^# ?/,""); print; next} NR>1 {exit}' "$1"; }
