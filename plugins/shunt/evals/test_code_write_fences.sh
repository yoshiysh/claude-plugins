#!/bin/bash
# Deterministic regression test for code-write's fence-stripping fix.
#
# Before the fix, `sed '/^```/d'` deleted every line starting with ``` in the
# model's answer unconditionally. That's correct for an outer fence wrapping
# the whole answer, but it also silently drops any fenced block that is
# legitimately part of the generated content (a markdown doc, a docstring
# with a fenced example, a test fixture containing another fence). The fix
# strips only a leading/trailing fence line, leaving interior fences intact.
#
# This test exercises the same awk one-liner code-write uses, in isolation,
# against three fixtures: an outer-fence-only answer, an answer with no
# fence at all, and an answer whose real content contains an interior fence
# that must survive.
#
# Usage: bash evals/test_code_write_fences.sh

set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

strip_outer_fences() {
  awk '
    { lines[NR] = $0 }
    END {
      start = 1; end = NR
      if (NR > 0 && lines[1] ~ /^```/) start = 2
      if (NR >= start && lines[NR] ~ /^```/) end = NR - 1
      for (i = start; i <= end; i++) print lines[i]
    }
  '
}

fail=0

check() {
  local name="$1" input="$2" expected="$3"
  local got
  got=$(printf '%s' "$input" | strip_outer_fences)
  if [ "$got" = "$expected" ]; then
    echo "PASS ($name)"
  else
    echo "FAIL ($name)"
    echo "  expected: $(printf '%q' "$expected")"
    echo "  got:      $(printf '%q' "$got")"
    fail=1
  fi
}

# Case 1: outer fence only — both fence lines are stripped, content kept.
check "outer-fence-only" \
$'```python\ndef f():\n    return 1\n```' \
$'def f():\n    return 1'

# Case 2: no fence at all — passthrough unchanged.
check "no-fence" \
$'def f():\n    return 1' \
$'def f():\n    return 1'

# Case 3: interior fence — content is a markdown doc containing its own
# fenced example. The outer wrapper fence must be stripped; the interior
# fence lines must survive.
check "interior-fence-preserved" \
$'```markdown\n# Title\n\nExample:\n\n```bash\necho hi\n```\n\nDone.\n```' \
$'# Title\n\nExample:\n\n```bash\necho hi\n```\n\nDone.'

exit "$fail"
