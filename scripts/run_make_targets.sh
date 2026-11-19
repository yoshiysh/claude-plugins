#!/bin/sh
# 使い方: run_make_targets.sh <make> <target>...
#
# make の target をサブ make として同時に走らせ、全ての終了を待ってから、
# target の順にログを出す。1 つでも失敗すれば 1 で終わる（他の target は最後まで走らせる）。
# GNU Make 3.81（macOS の /usr/bin/make）に --output-sync が無いので、出力はログに取ってから出す。
# POSIX sh で書く（CI の /bin/sh は dash）。dash は tty の無い set -m を拒むので、
# 中断時はプロセスグループではなく、ps で集めた子孫の木に TERM を送る。
# HUP は trap しない: 端末が切れた後に出力の行き先は無い。ジョブ制御の無い sh の子は同じ
# プロセスグループにいるので、端末の切断ではカーネルがジョブにも HUP を送る。
set -u

mk=$1
shift
tail_lines=${RUN_MAKE_TARGETS_TAIL_LINES:-30}

dir=$(mktemp -d "${TMPDIR:-/tmp}/make-targets.XXXXXX") || exit 2
trap 'rm -rf "$dir"' EXIT

# root を含む子孫の pid を列挙する。
descendants() {
  ps -A -o pid= -o ppid= | awk -v root="$1" '
    { parent[$1] = $2 }
    END {
      keep[root] = 1
      changed = 1
      while (changed) {
        changed = 0
        for (p in parent) if (!(p in keep) && (parent[p] in keep)) { keep[p] = 1; changed = 1 }
      }
      for (p in keep) print p
    }'
}

# 中断: まだ status を書いていない（＝生きている）ジョブの木だけに TERM を送る。
# 終わったジョブの pid は再利用され得るので、kill の宛先にしない。
stop() {
  for t in "$@"; do
    [ -f "$dir/$t.pid" ] && [ ! -f "$dir/$t.status" ] || continue
    kill -TERM $(descendants "$(cat "$dir/$t.pid")") 2>/dev/null
  done
  wait
  exit "$sig_rc"
}
# 起動の途中（`&` と pid の記録の間）に届いた signal は、記録が揃ってから処理する。
# その間に stop すると、pid の無いジョブを止められない。
sig_rc=
trap 'sig_rc=130' INT
trap 'sig_rc=143' TERM

pids=
for t in "$@"; do
  (
    s=$(date +%s)
    "$mk" --no-print-directory "$t" </dev/null >"$dir/$t.log" 2>&1
    rc=$?
    echo "$rc $(($(date +%s) - s))" >"$dir/$t.status"
  ) &
  echo $! >"$dir/$t.pid"
  pids="$pids $!"
done
trap 'sig_rc=130; stop "$@"' INT
trap 'sig_rc=143; stop "$@"' TERM
[ -n "$sig_rc" ] && stop "$@"
for p in $pids; do
  wait "$p"
done

failed=
summary=
for t in "$@"; do
  rc=?
  sec=?
  [ -f "$dir/$t.status" ] && read -r rc sec <"$dir/$t.status"
  if [ "$rc" = 0 ]; then res=PASS; else res=FAIL; failed="$failed $t"; fi
  echo "==== $t: $res (${sec}s) ===="
  cat "$dir/$t.log" 2>/dev/null
  summary="$summary
$res  $t  ${sec}s"
done
for t in $failed; do
  echo "==== FAIL $t (last $tail_lines lines) ===="
  tail -n "$tail_lines" "$dir/$t.log" 2>/dev/null
done
echo "==== make test summary ===="
printf '%s\n' "${summary#?}"
[ -z "$failed" ]
