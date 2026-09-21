#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
runtime_dir="$repo_root/.agents/skills/dynamic-workflow-runner/scripts/runtime"

if [[ ! -f "$runtime_dir/package-lock.json" ]]; then
  echo "worktree setup: runtime package-lock.json is missing" >&2
  exit 1
fi

if [[ -d "$runtime_dir/node_modules" && "${CODEX_SETUP_FORCE_NPM_CI:-0}" != "1" ]]; then
  echo "worktree setup: runtime dependencies already exist; skipping npm ci"
  exit 0
fi

command -v npm >/dev/null || {
  echo "worktree setup: npm is required to install runtime dependencies" >&2
  exit 1
}

echo "worktree setup: installing packages subject to runtime/.npmrc min-release-age=7"
npm ci --ignore-scripts --no-fund --prefix "$runtime_dir"
