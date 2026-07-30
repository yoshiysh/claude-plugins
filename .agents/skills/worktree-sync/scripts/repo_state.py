#!/usr/bin/env python3
"""worktree-sync の状態検出と機械的な削除。

判定を SKILL.md の prose に置くと実行のたびに解釈が揺れる。実測で 2 つの取りこぼしが
起きていた:

- `git fetch origin main` は prune しないため、remote 削除済みブランチが `[gone]` に
  ならず検出対象から漏れる
- `git branch --merged` は merge commit しか辿れず squash merge を取りこぼす。
  MERGED な PR を持つ remote ブランチ 7 本のうち、検出できたのは 1 本だけだった

そこで「取り込まれたか」を 3 経路で見る。履歴に含まれるか（`merge-base --is-ancestor`）、
PR が merged か、パッチが既に main にあるか（`git cherry` の patch-id 比較）。3 つ目は
cherry-pick / rebase で取り込まれ、履歴も PR も残らないブランチだけが該当する。
基準は常に origin/main（ローカル main は更新に失敗しても処理が続くため、基準に使うと
検出漏れが静かに起きる）。

削除の安全性はコマンドではなく分類で担保する。auto は origin/main に取り込み済みのものだけ、
needs_decision は取り込まれていないものだけが入る。
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

# gh の 1 回の問い合わせで取得する PR 数。このリポジトリの総 PR 数（1000 未満）を
# 十分に上回る値にして、ページングによる取りこぼしを避ける。
PR_QUERY_LIMIT = 1000

MAIN_REF = "origin/main"


class GitError(RuntimeError):
  """git / gh コマンドが失敗した。呼び出し側が理由を添えて報告する。"""


def run(cmd: list[str], *, check: bool = True) -> str:
  proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
  if check and proc.returncode != 0:
    raise GitError(f"{' '.join(cmd)} -> exit {proc.returncode}: {proc.stderr.strip()}")
  # 末尾改行だけを落とす。全体を strip すると porcelain 出力の 1 行目から
  # 先頭の状態フラグ（' M' の先頭空白など）が消え、パスと混ざる。
  return proc.stdout.rstrip("\n")


def lines(text: str) -> list[str]:
  return [ln for ln in (raw.strip() for raw in text.splitlines()) if ln]


def raw_lines(text: str) -> list[str]:
  """先頭の空白を保つ。`git status --porcelain` と `git submodule status` は
  先頭 1-2 文字が状態フラグで、strip するとパスの先頭文字と混ざる。"""
  return [ln for ln in text.splitlines() if ln.strip()]


@dataclass
class BranchInfo:
  name: str
  reason: str
  pr: str = ""
  # "ancestor": origin/main の履歴に含まれる → `git branch -d` が通る
  # "pr": squash 等で SHA は異なるが PR が merged → `-d` は拒否されるが削除は安全
  merged_via: str = ""


@dataclass
class Report:
  main_synced: bool = False
  local_auto: list[BranchInfo] = field(default_factory=list)
  local_decide: list[BranchInfo] = field(default_factory=list)
  local_keep: list[BranchInfo] = field(default_factory=list)
  remote_merged: list[BranchInfo] = field(default_factory=list)
  remote_decide: list[BranchInfo] = field(default_factory=list)
  stashes: list[str] = field(default_factory=list)
  submodule_drift: list[str] = field(default_factory=list)
  tracked_dirty: list[str] = field(default_factory=list)
  untracked: list[str] = field(default_factory=list)
  workspace_done: list[str] = field(default_factory=list)
  workspace_active: list[str] = field(default_factory=list)

  def to_json(self) -> str:
    def branches(items: list[BranchInfo]) -> list[dict[str, str]]:
      return [
        {"name": b.name, "reason": b.reason, "pr": b.pr, "merged_via": b.merged_via}
        for b in items
      ]

    return json.dumps(
      {
        "main_synced": self.main_synced,
        "local": {
          "auto_delete": branches(self.local_auto),
          "needs_decision": branches(self.local_decide),
          "keep": branches(self.local_keep),
        },
        "remote": {
          "merged": branches(self.remote_merged),
          "needs_decision": branches(self.remote_decide),
        },
        "stashes": self.stashes,
        "submodule_drift": self.submodule_drift,
        "tracked_dirty": self.tracked_dirty,
        "untracked": self.untracked,
        "workspace": {
          "finished": self.workspace_done,
          "active": self.workspace_active,
        },
      },
      ensure_ascii=False,
      indent=2,
    )


def fetch_and_sync_main() -> bool:
  """origin を prune つきで fetch し、ローカル main を origin/main に追従させる。

  prune を省くと remote 削除済みブランチが `[gone]` にならず、以降の分類が
  そのぶん取りこぼす。
  """
  run(["git", "fetch", "--prune", "origin"])
  current = run(["git", "branch", "--show-current"], check=False)
  if current == "main":
    run(["git", "merge", "--ff-only", MAIN_REF], check=False)
  else:
    # main が他の worktree で checkout 済みなら ref 更新は拒否される。
    # origin/main を基準に判定するため、ここが失敗しても分類の正しさは保たれる。
    run(["git", "fetch", "origin", "main:main"], check=False)
  local_main = run(["git", "rev-parse", "main"], check=False)
  return bool(local_main) and local_main == run(["git", "rev-parse", MAIN_REF])


def pr_states() -> tuple[set[str], set[str], set[str]]:
  """head ブランチ名を merged / open / closed の集合に分ける。

  state ごとに問い合わせるのは、1 本のブランチに CLOSED と MERGED の PR が両方
  ぶら下がる場合に、リスト先頭がどちらかで結果が変わるのを避けるため。
  """
  result: list[set[str]] = []
  for state in ("merged", "open", "closed"):
    try:
      raw = run(
        [
          "gh",
          "pr",
          "list",
          "--state",
          state,
          "--limit",
          str(PR_QUERY_LIMIT),
          "--json",
          "headRefName",
        ],
      )
    except GitError:
      # gh が使えない環境では PR 情報なしで続行する。取り込み判定は
      # merge-base の側だけが効き、分類は安全側（needs_decision）に寄る。
      result.append(set())
      continue
    result.append({item["headRefName"] for item in json.loads(raw or "[]")})
  return result[0], result[1], result[2]


def is_merged_into_main(ref: str) -> bool:
  proc = subprocess.run(
    ["git", "merge-base", "--is-ancestor", ref, MAIN_REF],
    capture_output=True,
    text=True,
    check=False,
  )
  return proc.returncode == 0


def patches_all_in_main(ref: str) -> bool:
  """全 commit と同等のパッチが既に main にあるか。

  cherry-pick や rebase で取り込まれたブランチは、履歴も PR も残らないため
  `merge-base` でも PR 状態でも取り込み済みと判定できない。`git cherry` は
  patch-id で比較するので、この経路だけを拾える。
  """
  out = run(["git", "cherry", MAIN_REF, ref], check=False)
  rows = lines(out)
  return bool(rows) and all(row.startswith("-") for row in rows)


def branch_facts(ref: str) -> str:
  """要判断ブランチに添える事実。捨てるか残すかの判断材料にする。"""
  unique = run(["git", "rev-list", "--count", f"{MAIN_REF}..{ref}"], check=False)
  last = run(["git", "log", "-1", "--format=%cs", ref], check=False)
  return f"独自 commit {unique or '?'} 本 / 最終 {last or '不明'}"


def worktree_branches() -> set[str]:
  out = run(["git", "worktree", "list", "--porcelain"])
  return {
    ln.split("refs/heads/", 1)[1]
    for ln in lines(out)
    if ln.startswith("branch refs/heads/")
  }


def hold_reason(
  name: str, current: str, in_worktrees: set[str], open_prs: set[str]
) -> str:
  """削除候補にしてはいけない理由。無ければ空文字を返す。"""
  if name == current:
    return "現在のブランチ"
  if name in in_worktrees:
    return "他の worktree で checkout 中"
  if name in open_prs:
    return "PR が open"
  return ""


def classify_one_local(
  report: Report, name: str, track: str, merged_prs: set[str]
) -> None:
  if is_merged_into_main(name):
    report.local_auto.append(
      BranchInfo(name, "origin/main に取り込み済み", merged_via="ancestor")
    )
  elif name in merged_prs:
    report.local_auto.append(
      BranchInfo(name, "PR が merged（squash 等で履歴が異なる）", merged_via="pr")
    )
  elif patches_all_in_main(name):
    report.local_auto.append(
      BranchInfo(
        name, "全 commit のパッチが main にある（cherry-pick 等）", merged_via="pr"
      )
    )
  elif "gone" in track:
    report.local_decide.append(
      BranchInfo(
        name, f"remote 削除済みだが origin/main に未取り込み。{branch_facts(name)}"
      )
    )
  else:
    report.local_keep.append(BranchInfo(name, "作業中"))


def classify_local(report: Report, merged_prs: set[str], open_prs: set[str]) -> None:
  current = run(["git", "branch", "--show-current"], check=False)
  in_worktrees = worktree_branches()
  out = run(
    [
      "git",
      "for-each-ref",
      "--format=%(refname:short)\t%(upstream:track)",
      "refs/heads",
    ]
  )
  for row in lines(out):
    name, _, track = row.partition("\t")
    if name == "main":
      continue
    held = hold_reason(name, current, in_worktrees, open_prs)
    if held:
      report.local_keep.append(BranchInfo(name, held))
      continue
    classify_one_local(report, name, track, merged_prs)


def classify_remote(report: Report, merged_prs: set[str], open_prs: set[str]) -> None:
  out = run(["git", "branch", "-r", "--format=%(refname:short)"])
  for ref in lines(out):
    if not ref.startswith("origin/") or "HEAD" in ref:
      continue
    name = ref[len("origin/") :]
    if name == "main":
      continue
    if name in open_prs:
      continue
    if name in merged_prs:
      report.remote_merged.append(BranchInfo(name, "PR が merged", pr="merged"))
    elif is_merged_into_main(ref):
      report.remote_merged.append(BranchInfo(name, "origin/main に取り込み済み"))
    elif patches_all_in_main(ref):
      report.remote_merged.append(
        BranchInfo(name, "全 commit のパッチが main にある（cherry-pick 等）")
      )
    else:
      report.remote_decide.append(
        BranchInfo(name, f"origin/main に未取り込み。{branch_facts(ref)}")
      )


def collect_working_state(report: Report) -> None:
  report.stashes = lines(run(["git", "stash", "list"], check=False))

  submodule_rows = raw_lines(run(["git", "submodule", "status"], check=False))
  submodule_paths = {
    row[1:].split()[1] for row in submodule_rows if len(row[1:].split()) > 1
  }
  for row in submodule_rows:
    # 先頭 '+' はポインタ差分（同期か commit で直す）。'-' は未初期化で、
    # 意図的に取得していない場合も含むため drift とは分けて扱う。
    if row[0] == "+":
      report.submodule_drift.append(row.strip())

  for row in raw_lines(run(["git", "status", "--porcelain"], check=False)):
    status, path = row[:2], row[3:]
    if path.rstrip("/") in submodule_paths:
      # submodule のポインタ差分は submodule_drift 側で扱う。
      continue
    if status == "??":
      report.untracked.append(path)
    else:
      report.tracked_dirty.append(f"{status.strip()} {path}")


def discover_workspaces(explicit: str) -> list[Path]:
  """スキルの workspace ディレクトリを探す。

  特定スキルに固定しないのは、workspace を持つスキルは複数あり、どれが溜まるかは
  リポジトリごとに違うため。`.claude/skills` が `.agent/skills` への symlink である
  構成では同じ実体を 2 回数えてしまうので、解決後のパスで重複を除く。
  """
  if explicit:
    return [Path(explicit)]
  roots: list[Path] = []
  seen: set[Path] = set()
  for base in (Path(".agent/skills"), Path(".claude/skills")):
    if not base.is_dir():
      continue
    for ws in sorted(base.glob("*/workspace")):
      if not ws.is_dir():
        continue
      resolved = ws.resolve()
      if resolved in seen:
        continue
      seen.add(resolved)
      roots.append(ws)
  return roots


def collect_workspace(report: Report, roots: list[Path]) -> None:
  """各 workspace の session を、終端済みと未終端に分ける。

  `state.json` に `status: completed` を書く規約を持つスキルだけが終端を判定できる。
  規約が無い（state.json が無い）ものは中身を判断できないので、削除候補にしない。
  """
  for root in roots:
    collect_one_workspace(report, root)


def collect_one_workspace(report: Report, workspace: Path) -> None:
  skill = workspace.parent.name
  if not workspace.is_dir():
    return
  for session in sorted(p for p in workspace.iterdir() if p.is_dir()):
    label = f"{skill}/{session.name}"
    state = session / "state.json"
    if not state.is_file():
      report.workspace_active.append(f"{label} (state.json なし)")
      continue
    try:
      data = json.loads(state.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
      report.workspace_active.append(f"{label} (state.json 読取不可)")
      continue
    status = data.get("status", "")
    if status == "completed":
      report.workspace_done.append(label)
    else:
      report.workspace_active.append(f"{label} ({status or '不明'})")


def build_report(roots: list[Path]) -> Report:
  report = Report()
  report.main_synced = fetch_and_sync_main()
  merged_prs, open_prs, _closed = pr_states()
  classify_local(report, merged_prs, open_prs)
  classify_remote(report, merged_prs, open_prs)
  collect_working_state(report)
  collect_workspace(report, roots)
  return report


def delete_local(candidates: list[BranchInfo]) -> list[str]:
  """分類結果に紐づく削除方法をここで選ぶ。

  呼び出し側にブランチ名だけを渡させると、`-d` で拒否された squash merge 済みを
  人手で `-D` し直す運用になり、未取り込みのものを巻き込む余地が生まれる。
  どちらの方法を使えるかは分類そのものが決めるので、対を崩さない。
  """
  results = []
  for branch in candidates:
    flag = "-D" if branch.merged_via == "pr" else "-d"
    proc = subprocess.run(
      ["git", "branch", flag, branch.name], capture_output=True, text=True, check=False
    )
    ok = proc.returncode == 0
    results.append(
      f"{'deleted' if ok else 'skipped'}: {branch.name} ({branch.reason})"
      + ("" if ok else f" -> {proc.stderr.strip()}")
    )
  return results


def delete_remote(names: list[str], allowed: set[str]) -> list[str]:
  """merged と分類された remote ブランチだけを消す。

  `names` が空なら `allowed` 全件を対象にする（分類がそのまま対象になる）。

  remote への削除は共有リポジトリへの変更なので、呼び出し側が渡した名前を
  そのまま信用せず、分類結果と照合してから実行する。
  """
  results = []
  for name in names or sorted(allowed):
    if name not in allowed:
      results.append(f"refused: origin/{name} (merged と分類されていない)")
      continue
    proc = subprocess.run(
      ["git", "push", "origin", "--delete", name],
      capture_output=True,
      text=True,
      check=False,
    )
    ok = proc.returncode == 0
    results.append(
      f"{'deleted' if ok else 'failed'}: origin/{name}"
      + ("" if ok else f" ({proc.stderr.strip()})")
    )
  return results


def purge_workspace(roots: list[Path], names: list[str]) -> list[str]:
  """workspace は gitignore 対象で復元できないため、名指しされたものだけを消す。

  名前は report と同じ `<skill>/<session>` 形式。skill 名を通すことで、workspace を
  持つスキルが複数あっても取り違えない。
  """
  import shutil

  by_skill = {root.parent.name: root for root in roots}
  results = []
  for name in names:
    skill, _, session = name.partition("/")
    root = by_skill.get(skill)
    if root is None or not session:
      results.append(f"skipped: {name} (<skill>/<session> 形式で既知の workspace を指していない)")
      continue
    target = root / session
    if not target.is_dir() or target.parent != root:
      results.append(f"skipped: {name} (対象外)")
      continue
    shutil.rmtree(target)
    results.append(f"purged: {name}")
  return results


def build_parser() -> argparse.ArgumentParser:
  parser = argparse.ArgumentParser(description=__doc__)
  parser.add_argument(
    "command", choices=["report", "prune-local", "prune-remote", "purge-workspace"]
  )
  parser.add_argument(
    "--branches", default="", help="カンマ区切り。prune-remote で使う"
  )
  parser.add_argument(
    "--sessions", default="", help="カンマ区切り。purge-workspace で使う"
  )
  parser.add_argument(
    "--workspace",
    default="",
    help="workspace のパス。省略時は {.agent,.claude}/skills/*/workspace を自動探索する",
  )
  return parser


def csv_arg(value: str) -> list[str]:
  return [item for item in (x.strip() for x in value.split(",")) if item]


def dispatch(
  command: str, roots: list[Path], branches: list[str], sessions: list[str]
) -> str:
  if command == "report":
    return build_report(roots).to_json()
  if command == "prune-local":
    # 対象は分類結果そのもの。呼び出し側が名前を選び直す余地を残さない。
    return "\n".join(delete_local(build_report(roots).local_auto)) or "対象なし"
  if command == "prune-remote":
    allowed = {b.name for b in build_report(roots).remote_merged}
    return "\n".join(delete_remote(branches, allowed)) or "対象なし"
  return "\n".join(purge_workspace(roots, sessions)) or "対象なし"


def main() -> int:
  args = build_parser().parse_args()
  try:
    print(
      dispatch(
        args.command,
        discover_workspaces(args.workspace),
        csv_arg(args.branches),
        csv_arg(args.sessions),
      )
    )
  except GitError as exc:
    print(f"error: {exc}", file=sys.stderr)
    return 1
  return 0


if __name__ == "__main__":
  sys.exit(main())
