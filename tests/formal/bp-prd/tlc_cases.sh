#!/bin/sh
set -eu
self=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/$(basename -- "$0")

usage() {
  echo 'usage: tlc_cases.sh jobs | run DIR LIST | verify DIR LIST' >&2
  exit 2
}

jobs_count() {
  jobs=${TLC_JOBS-$(getconf _NPROCESSORS_ONLN)}
  case $jobs in
    '' | *[!0-9]* | 0*) echo 'TLC_JOBS must be a positive integer' >&2; exit 1 ;;
  esac
  echo "$jobs"
}

read_case() {
  { read -r module; read -r code; read -r message; read -r label; read -r okline; read -r dump; } < "$1/$2.case"
}

run_one() {
  dir=$1; name=$2
  read_case "$dir" "$name"
  # TLC extracts the standard modules into java.io.tmpdir and parses them from there,
  # so concurrent cases sharing a directory read each other's half-written copies.
  work=$dir/work/$name
  if ! { mkdir -p "$work/tmp" && cp "$dir"/*.tla "$dir/$name.cfg" "$work/"; } > "$dir/$name.log" 2>&1; then
    echo setup-failed > "$dir/$name.status"
    return 0
  fi
  set -- -Djava.io.tmpdir="$work/tmp" -XX:+UseParallelGC -cp "$TLA2TOOLS" tlc2.TLC -workers 1 \
    -metadir "$work/states" -config "$work/$name.cfg"
  if [ -n "$dump" ]; then
    set -- "$@" -dump dot,actionlabels "$dir/$dump"
  fi
  status=0
  (cd "$work" && "$JAVA" "$@" "$module.tla") > "$dir/$name.log" 2>&1 || status=$?
  # xargs aborts the whole pool when a child exits 255, so the TLC status travels in a file.
  echo "$status" > "$dir/$name.status"
}

run_all() {
  jobs=$(jobs_count)
  : "${JAVA:?Set JAVA}" "${TLA2TOOLS:?Set TLA2TOOLS}"
  [ -s "$2" ] || { echo "No TLC cases in $2" >&2; exit 1; }
  duplicate=$(sort "$2" | uniq -d | head -n 1)
  [ -z "$duplicate" ] || { echo "Duplicate TLC case id: $duplicate" >&2; exit 1; }
  xargs -n 1 -P "$jobs" sh "$self" one "$1" < "$2"
}

verify_all() {
  while IFS= read -r name || [ -n "$name" ]; do
    read_case "$1" "$name"
    status=missing
    [ ! -f "$1/$name.status" ] || status=$(cat "$1/$name.status")
    if [ "$status" != "$code" ] || ! grep -F -e "$message" "$1/$name.log" > /dev/null 2>&1; then
      echo "$label; exit=$status" >&2
      cat "$1/$name.log" >&2 || true
      exit 1
    fi
    [ -z "$okline" ] || printf '%s\n' "$okline"
  done < "$2"
}

[ "$#" -ge 1 ] || usage
command=$1; shift
case $command in
  jobs) [ "$#" -eq 0 ] || usage; jobs_count ;;
  run) [ "$#" -eq 2 ] || usage; run_all "$@" ;;
  one) [ "$#" -eq 2 ] || usage; run_one "$@" ;;
  verify) [ "$#" -eq 2 ] || usage; verify_all "$@" ;;
  *) usage ;;
esac
