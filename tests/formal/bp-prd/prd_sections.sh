#!/bin/sh
set -eu
tab=$(printf '\t')
self=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/$(basename -- "$0")

usage() {
  echo 'usage: prd_sections.sh check ROOT MANIFEST | print ROOT MANIFEST | affected MANIFEST PREFIX... < CHANGED_FILES' >&2
  exit 2
}

quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

extract() {
  target=$3 LC_ALL=C awk '
    /^(```|~~~)/ { fence = !fence }
    {
      level = 0
      if (!fence && match($0, /^#+ /)) level = RLENGTH - 1
      if (level > 0 && inside && level <= depth) inside = 0
      if (level > 0 && $0 == ENVIRON["target"]) { count++; inside = 1; depth = level }
      if (inside) print
    }
    END { exit count == 1 ? 0 : (count == 0 ? 3 : 4) }' "$1/$2" > "$4"
}

each_section() {
  mode=$1 root=$2 manifest=$3
  [ -s "$manifest" ] || { echo "Empty section manifest: $manifest" >&2; exit 1; }
  work=$(mktemp -d "${TMPDIR:-/tmp}/bp-prd-sections.XXXXXX")
  trap 'rm -rf "$work"' EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  failed=0 changed=0 line=0
  while IFS= read -r entry || [ -n "$entry" ]; do
    line=$((line + 1))
    expected=${entry%%"$tab"*}; rest=${entry#*"$tab"}
    path=${rest%%"$tab"*}; heading=${rest#*"$tab"}
    case $expected in
      *[!0-9a-f]* | '') bad=1 ;;
      *) [ "${#expected}" -eq 64 ] && bad=0 || bad=1 ;;
    esac
    case $heading in '#'*) ;; *) bad=1 ;; esac
    case $path in '' | *"$tab"*) bad=1 ;; esac
    if [ "$bad" -ne 0 ]; then
      echo "$manifest:$line: expected SHA-256<TAB>path<TAB>heading" >&2; failed=1; continue
    fi
    status=0
    extract "$root" "$path" "$heading" "$work/section" || status=$?
    case $status in
      0) ;;
      3) echo "$path: heading not found: $heading" >&2; failed=1; continue ;;
      4) echo "$path: heading appears more than once: $heading" >&2; failed=1; continue ;;
      *) echo "$path: cannot read section: $heading" >&2; failed=1; continue ;;
    esac
    actual=$(shasum -a 256 < "$work/section" | cut -d ' ' -f 1)
    if [ "$mode" = print ]; then
      printf '%s\t%s\t%s\n' "$actual" "$path" "$heading"
    elif [ "$actual" = "$expected" ]; then
      echo "$path: $heading: OK"
    else
      echo "$path: $heading: CHANGED" >&2; changed=1
    fi
  done < "$manifest"
  if [ "$failed" -ne 0 ]; then
    echo "Section manifest $manifest cannot be resolved; fix the manifest or the headings first." >&2
    exit 1
  fi
  if [ "$changed" -ne 0 ]; then
    pinned=$(CDPATH= cd -- "$(dirname -- "$manifest")" && pwd)/$(basename -- "$manifest")
    regenerate="sh $(quote "$self") print $(quote "$(CDPATH= cd -- "$root" && pwd)") $(quote "$pinned") > $(quote "$pinned.new") && mv $(quote "$pinned.new") $(quote "$pinned")"
    cat >&2 <<EOF
Requirement or design sections pinned by $manifest changed.
Re-verify the model before updating the pins:
  1. Read each CHANGED section and compare it with BP.tla and README.md (the properties-to-requirements table, the row-by-row mapping of pinned sections, and the scope limits).
  2. Change the model, its properties, mutations, and README where they no longer match, then run check.sh until it passes.
  3. Only then regenerate the pins with the command below. It writes next to the manifest first, because redirecting onto the manifest empties it before it is read.
     $regenerate
EOF
    exit 1
  fi
}

affected() {
  manifest=$1; shift
  [ "$#" -ge 1 ] || usage
  docs=$(cut -f 2 "$manifest" | sort -u)
  [ -n "$docs" ] || { echo "Empty section manifest: $manifest" >&2; exit 1; }
  hit=false
  while IFS= read -r file || [ -n "$file" ]; do
    for prefix in "$@"; do
      case $file in "$prefix"*) hit=true ;; esac
    done
    if printf '%s\n' "$docs" | grep -Fx -e "$file" > /dev/null; then hit=true; fi
  done
  echo "$hit"
}

[ "$#" -ge 1 ] || usage
command=$1; shift
case $command in
  check | print) [ "$#" -eq 2 ] || usage; each_section "$command" "$@" ;;
  affected) [ "$#" -ge 2 ] || usage; affected "$@" ;;
  *) usage ;;
esac
