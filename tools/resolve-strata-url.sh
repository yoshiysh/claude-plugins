#!/usr/bin/env bash
# Resolve the Strata base URL, prioritizing direct LAN over SSH tunnel.
set -euo pipefail

PORT="${STRATA_PORT:-8080}"
SSH_HOST="${STRATA_HOST:-winbox}"

if [ -n "${STRATA_BASE_URL:-}" ]; then
  printf '%s\n' "$STRATA_BASE_URL"
  exit 0
fi

is_reachable() {
  local url="$1"
  curl -sS -m 1 -o /dev/null "${url%/}/models" 2>/dev/null
}

candidates=()
if [ -n "${STRATA_LAN_HOST:-}" ]; then
  candidates+=("$STRATA_LAN_HOST")
fi
if [ "${STRATA_LAN_RESOLVE:-1}" != "0" ] && command -v ssh >/dev/null 2>&1; then
  ssh_ip="$(ssh -G "$SSH_HOST" 2>/dev/null | awk '/^hostname / {print $2; exit}' || true)"
  win_name="$(ssh -n -o ConnectTimeout=1 -o BatchMode=yes "$SSH_HOST" hostname 2>/dev/null | tr -d '\r\n' || true)"
  if [ -n "$win_name" ]; then
    candidates+=("${win_name}.local")
  fi
  if [ -n "$ssh_ip" ]; then
    candidates+=("$ssh_ip")
  fi
fi

for host in "${candidates[@]}"; do
  url="http://${host}:${PORT}/v1"
  if is_reachable "$url"; then
    printf '%s\n' "$url"
    exit 0
  fi
done

printf 'http://127.0.0.1:%s/v1\n' "$PORT"
