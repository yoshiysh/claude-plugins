#!/usr/bin/env bash
set -euo pipefail

if [ -n "${STRATA_BASE_URL:-}" ]; then
  printf '%s\n' "$STRATA_BASE_URL"
  exit 0
fi

port="${STRATA_PORT:-8080}"

if [ "${STRATA_LAN_RESOLVE:-}" = "0" ]; then
  printf 'http://127.0.0.1:%s/v1\n' "$port"
  exit 0
fi

if command -v curl >/dev/null 2>&1; then
  candidates=()
  if [ -n "${STRATA_LAN_HOST:-}" ]; then
    candidates+=("$STRATA_LAN_HOST")
  fi
  if [ "${STRATA_LAN_RESOLVE:-}" = "1" ] && command -v ssh >/dev/null 2>&1; then
    ssh_host="${STRATA_HOST:-winbox}"
    ssh_ip="$(ssh -G "$ssh_host" 2>/dev/null | awk '/^hostname / {print $2; exit}' || true)"
    win_name="$(ssh -n -o ConnectTimeout=1 -o BatchMode=yes "$ssh_host" hostname 2>/dev/null | tr -d '\r\n' || true)"
    if [ -n "$win_name" ]; then
      candidates+=("${win_name}.local")
    fi
    if [ -n "$ssh_ip" ]; then
      candidates+=("$ssh_ip")
    fi
  fi
  # bash 3.2 (macOS) raises unbound variable on empty "${candidates[@]}" under set -u.
  for host in ${candidates[@]+"${candidates[@]}"}; do
    url="http://${host}:${port}/v1"
    if curl -sS -m 1 -o /dev/null "${url}/models" 2>/dev/null; then
      printf '%s\n' "$url"
      exit 0
    fi
  done
fi

printf 'http://127.0.0.1:%s/v1\n' "$port"
