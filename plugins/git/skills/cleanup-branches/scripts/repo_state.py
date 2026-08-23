#!/usr/bin/env python3
"""cleanup-branches の状態検出と機械的な削除。

判定を SKILL.md の prose に置くと実行のたびに解釈が揺れる。実測で複数の取りこぼしが
起きていた:

- `git fetch origin main` は prune しないため、remote 削除済みブランチが `[gone]` に
  ならず検出対象から漏れる
- `git branch --merged` は merge commit しか辿れず squash merge を取りこぼす。
  MERGED な PR を持つ remote ブランチ 7 本のうち、検出できたのは 1 本だけだった
- 判定基準を `origin/main` 固定にすると、`develop` が主軸で `dev/{version}` のような
  並走ブランチを持つリポジトリ（本リポジトリの運用がこれに該当）で、実際には取り込み済みの
  ブランチを誤って「未マージ」と判定する

そこで「取り込まれたか」を、`main`/`develop`/`release/*`/`dev/*` のうち実在するもの全て
（primary refs）を対象に 3 経路で見る。履歴に含まれるか（`merge-base --is-ancestor`）、
PR が merged か、パッチが既に取り込まれているか（`git cherry` の patch-id 比較）。3 つ目は
cherry-pick / rebase で取り込まれ、履歴も PR も残らないブランチだけが該当する。

削除の安全性はコマンドではなく分類で担保する。auto は primary refs のいずれかに取り込み済みの
ものだけ、needs_decision は取り込まれていないものだけが入る。加えて、削除直前に退避タグ
（`deleted-branches/<branch>-<timestamp>`）を打ち、reflog に依存しない復元手段を残す。
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

# gh の 1 回の問い合わせで取得する PR 数。このリポジトリの総 PR 数（1000 未満）を
# 十分に上回る値にして、ページングによる取りこぼしを避ける。
PR_QUERY_LIMIT = 1000

FIXED_PRIMARY_NAMES = ("main", "develop")
WILDCARD_PRIMARY_PREFIXES = ("release/", "dev/")


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


def ref_exists(ref: str) -> bool:
  proc = subprocess.run(
    ["git", "rev-parse", "--verify", "--quiet", ref],
    capture_output=True, text=True, check=False,
  )
  return proc.returncode == 0


def primary_branch_names() -> list[str]:
  """main / develop / release/* / dev/* のうち、ローカルかリモートに実在するものを列挙する。

  release/* と dev/* はワイルドカードなので、存在しないパターンは自然にスキップされる。
  重複除去のうえ、決定的な順序（列挙順→アルファベット順）で返す。
  """
  names: list[str] = []
  seen: set[str] = set()

  def add(name: str) -> None:
    if name not in seen and (ref_exists(f"refs/heads/{name}") or ref_exists(f"refs/remotes/origin/{name}")):
      seen.add(name)
      names.append(name)

  for fixed in FIXED_PRIMARY_NAMES:
    add(fixed)

  wildcard_candidates: set[str] = set()
  for line in lines(run(["git", "for-each-ref", "--format=%(refname:short)", "refs/heads/"], check=False)):
    wildcard_candidates.add(line)
  for line in lines(run(["git", "for-each-ref", "--format=%(refname:short)", "refs/remotes/origin/"], check=False)):
    if line.startswith("origin/"):
      wildcard_candidates.add(line[len("origin/"):])

  for name in sorted(wildcard_candidates):
    if name.startswith(WILDCARD_PRIMARY_PREFIXES):
      add(name)

  return names


@dataclass
class BranchInfo:
  name: str
  reason: str
  pr: str = ""
  merged_into: str = ""
  # "ancestor": primary の履歴に含まれる → `git branch -d` が通る
  # "pr": squash 等で SHA は異なるが PR が merged → `-d` は拒否されるが削除は安全
  merged_via: str = ""


@dataclass
class Report:
  primary_branches: list[str] = field(default_factory=list)
  main_synced: bool = False
  sync_base: str = ""
  # detached HEAD では空文字。Step 5 の分岐はこの 2 つだけで決まる。
  current_branch: str = ""
  current_branch_open_pr: bool = False
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
        {"name": b.name, "reason": b.reason, "pr": b.pr, "merged_into": b.merged_into, "merged_via": b.merged_via}
        for b in items
      ]

    return json.dumps(
      {
        "primary_branches": self.primary_branches,
        "main_synced": self.main_synced,
        "sync_base": self.sync_base,
        "current_branch": self.current_branch,
        "current_branch_open_pr": self.current_branch_open_pr,
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


def detect_sync_base() -> str:
  """Step 5（新規ブランチ作成）の起点ブランチを決める。

  プロジェクト側に `.claude/detect-base-branch.sh`（現在のブランチから適切なベース
  ブランチを検出するスクリプト。resolve-conflict・create-pr スキルが既に使っている）が
  あれば優先する。無ければ origin の default branch（多くの場合 main）にフォールバックする。
  """
  local_script = Path(".claude/detect-base-branch.sh")
  if local_script.is_file():
    out = run(["bash", str(local_script)], check=False)
    if out.strip():
      return out.strip()

  head_ref = run(["git", "symbolic-ref", "refs/remotes/origin/HEAD"], check=False)
  if head_ref.startswith("refs/remotes/origin/"):
    return head_ref[len("refs/remotes/origin/"):]
  return "main"


def fetch_and_sync_base(base: str) -> bool:
  """origin を prune つきで fetch し、ローカルの起点ブランチを追従させる。

  prune を省くと remote 削除済みブランチが `[gone]` にならず、以降の分類が
  そのぶん取りこぼす。
  """
  run(["git", "fetch", "--prune", "origin"])
  base_ref = f"origin/{base}"
  current = run(["git", "branch", "--show-current"], check=False)
  if current == base:
    run(["git", "merge", "--ff-only", base_ref], check=False)
  else:
    # 起点ブランチが他の worktree で checkout 済みなら ref 更新は拒否される。
    # 判定は origin/<base> を基準にするため、ここが失敗しても分類の正しさは保たれる。
    run(["git", "fetch", "origin", f"{base}:{base}"], check=False)
  local = run(["git", "rev-parse", base], check=False)
  return bool(local) and local == run(["git", "rev-parse", base_ref], check=False)


def pr_states_per_primary(primaries: list[str]) -> tuple[set[str], set[str]]:
  """head ブランチ名を、いずれかの primary ref を base に持つ merged / open の集合に分ける。

  `--base` ごとに問い合わせると 1 回あたり数秒かかる `gh pr list` を primary 数ぶん
  （実測 38 本 × 2 state = 76 回、約 4-5 分）叩くことになる。base で絞り込まず全件を
  1 回ずつ（state ごと計 2 回）取得し、`baseRefName` で Python 側にフィルタする。
  base を無視すると無関係な feature 間 PR の headRefName まで拾ってしまうため、
  フィルタ自体は省略しない。
  """
  merged: set[str] = set()
  open_: set[str] = set()
  primary_set = set(primaries)
  for state, bucket in (("merged", merged), ("open", open_)):
    try:
      raw = run(
        ["gh", "pr", "list", "--state", state,
         "--limit", str(PR_QUERY_LIMIT), "--json", "headRefName,baseRefName"],
      )
    except GitError:
      # gh が使えない環境では PR 情報なしで続行する。取り込み判定は
      # merge-base / patch-id の側だけが効き、分類は安全側（needs_decision）に寄る。
      continue
    for item in json.loads(raw or "[]"):
      if item["baseRefName"] in primary_set:
        bucket.add(item["headRefName"])
  return merged, open_


def compute_merged_sets(primaries: list[str]) -> dict[str, tuple[set[str], set[str]]]:
  """primary ごとに「そこへ取り込み済みのローカル名・リモート名」を1回のgit呼び出しで集める。

  ブランチ本数 × primary 本数ぶん `git merge-base --is-ancestor` を個別に呼ぶと
  （実測 301 リモートブランチ × 38 primary ≈ 11,438 回、1回 0.04 秒でも計 7 分超）、
  ブランチ数に比例して重くなる。`git branch --merged` は対象 1 件につき 1 回の呼び出しで
  全ブランチの取り込み状況を返すため、primary の本数だけ（実測 38 回）で済む。
  """
  result: dict[str, tuple[set[str], set[str]]] = {}
  for base in primaries:
    ref = f"origin/{base}"
    local = set(lines(run(["git", "branch", "--merged", ref, "--format=%(refname:short)"], check=False)))
    remote_raw = lines(run(["git", "branch", "-r", "--merged", ref, "--format=%(refname:short)"], check=False))
    remote = {r[len("origin/"):] for r in remote_raw if r.startswith("origin/")}
    result[base] = (local, remote)
  return result


def is_merged_into_any_primary(
  name: str, primaries: list[str], merged_sets: dict[str, tuple[set[str], set[str]]], *, remote: bool
) -> str:
  """primary refs のいずれかに（`compute_merged_sets` の結果から）取り込み済みなら、その primary 名を返す。"""
  idx = 1 if remote else 0
  for base in primaries:
    if name in merged_sets[base][idx]:
      return base
  return ""


def patches_all_in_any_primary(ref: str, cherry_primaries: list[str]) -> str:
  """全 commit と同等のパッチが、いずれかの primary refs に既にあれば、その primary 名を返す。

  cherry-pick や rebase で取り込まれたブランチは、履歴も PR も残らないため
  `merge-base` でも PR 状態でも取り込み済みと判定できない。`git cherry` は
  patch-id で比較するので、この経路だけを拾える。

  `cherry_primaries` は `primaries`（release/* と dev/* を含む全 primary refs）の部分集合で
  なければならない。`git cherry` は対象範囲の全コミットの patch-id を計算するため、
  ブランチ数 × primary 数で呼び出すと重い履歴を持つリポジトリで実測 10 分超えの遅延が
  起きた（本リポジトリで実測: リモートブランチ301本 × primary 38本）。cherry-pick /
  rebase で紛れるのはほぼ必ず「現在アクティブな」統合先であり、何年も前に EOL した
  release ブランチに紛れる実例は考えにくいため、安価な ancestor/PR 判定は全 primary refs に
  対して行いつつ、高価な patch-id 比較だけを絞り込む。
  """
  for base in cherry_primaries:
    out = run(["git", "cherry", f"origin/{base}", ref], check=False)
    rows = lines(out)
    if rows and all(row.startswith("-") for row in rows):
      return base
  return ""


def branch_facts(ref: str, compare_bases: list[str]) -> str:
  """要判断ブランチに添える事実。捨てるか残すかの判断材料にする。

  `compare_bases` は全 primary refs ではなく、小さい代表集合（`cherry_check_primaries` と
  同じもの: main/develop/sync_base）を渡すこと。remote_decide に多数のブランチが残った
  場合（本リポジトリの実測で 250 本超）、全 primary（38本）と比較すると
  `git rev-list --count` の呼び出し数がブランチ数倍に膨らみ遅延の原因になる。"""
  best_base, best_count = "", None
  for base in compare_bases:
    count_str = run(["git", "rev-list", "--count", f"origin/{base}..{ref}"], check=False)
    try:
      count = int(count_str)
    except ValueError:
      continue
    if best_count is None or count < best_count:
      best_base, best_count = base, count
  last = run(["git", "log", "-1", "--format=%cs", ref], check=False)
  base_label = f"{best_base} からの独自 commit {best_count if best_count is not None else '?'} 本" if best_base else "独自 commit 数不明"
  return f"{base_label} / 最終 {last or '不明'}"


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


def has_unpushed_commits(track: str, upstream: str) -> bool:
  """upstream が無い（一度も push されていない）か、upstream より先行しているかを見る。

  `merged_prs`（PR履歴の名前ベース判定）だけは、この判定を経ない限り auto_delete に
  進んではいけない。ancestor 判定・patch-id 判定はブランチの現在の tip を直接比較するため
  未 push コミットがあれば自然に不一致になるが、PR履歴は過去に push された時点の名前で
  記録されており、「PRマージ後にユーザーがローカルへ追加コミットしたが push していない」
  状態を区別できない。
  """
  return upstream == "" or "ahead" in track


def classify_one_local(
  report: Report, name: str, track: str, upstream: str, primaries: list[str], cherry_primaries: list[str],
  merged_sets: dict[str, tuple[set[str], set[str]]], merged_prs: set[str],
) -> None:
  ancestor_of = is_merged_into_any_primary(name, primaries, merged_sets, remote=False)
  if ancestor_of:
    report.local_auto.append(
      BranchInfo(name, f"{ancestor_of} に取り込み済み", merged_into=ancestor_of, merged_via="ancestor")
    )
  elif name in merged_prs and not has_unpushed_commits(track, upstream):
    report.local_auto.append(
      BranchInfo(name, "PR が merged（squash 等で履歴が異なる）", merged_via="pr")
    )
  elif name in merged_prs:
    # PR は merged だが、push 済み時点より後にローカルで追加コミットがある。
    # そのコミットは PR にも remote にも存在しないため、自動削除の対象にしない。
    report.local_decide.append(
      BranchInfo(
        name, f"PR は merged だが、push 済み時点より後の未 push コミットがある。{branch_facts(name, cherry_primaries)}"
      )
    )
  elif (patch_base := patches_all_in_any_primary(name, cherry_primaries)):
    report.local_auto.append(
      BranchInfo(
        name, f"全 commit のパッチが {patch_base} にある（cherry-pick 等）",
        merged_into=patch_base, merged_via="pr",
      )
    )
  elif "gone" in track:
    report.local_decide.append(
      BranchInfo(
        name, f"remote 削除済みだが未取り込み。{branch_facts(name, cherry_primaries)}"
      )
    )
  else:
    report.local_keep.append(BranchInfo(name, "作業中"))


def classify_local(
  report: Report, primaries: list[str], cherry_primaries: list[str],
  merged_sets: dict[str, tuple[set[str], set[str]]], merged_prs: set[str], open_prs: set[str],
) -> None:
  current = run(["git", "branch", "--show-current"], check=False)
  in_worktrees = worktree_branches()
  out = run(
    ["git", "for-each-ref", "--format=%(refname:short)\t%(upstream:track)\t%(upstream)", "refs/heads"]
  )
  for row in lines(out):
    parts = row.split("\t")
    name = parts[0]
    track = parts[1] if len(parts) > 1 else ""
    upstream = parts[2] if len(parts) > 2 else ""
    if name in primaries:
      continue
    held = hold_reason(name, current, in_worktrees, open_prs)
    if held:
      report.local_keep.append(BranchInfo(name, held))
      continue
    classify_one_local(report, name, track, upstream, primaries, cherry_primaries, merged_sets, merged_prs)


def classify_remote(
  report: Report, primaries: list[str], cherry_primaries: list[str],
  merged_sets: dict[str, tuple[set[str], set[str]]], merged_prs: set[str], open_prs: set[str],
) -> None:
  out = run(["git", "branch", "-r", "--format=%(refname:short)"])
  for ref in lines(out):
    if not ref.startswith("origin/") or "HEAD" in ref:
      continue
    name = ref[len("origin/"):]
    if name in primaries or name in open_prs:
      continue
    if name in merged_prs:
      report.remote_merged.append(BranchInfo(name, "PR が merged", pr="merged"))
      continue
    ancestor_of = is_merged_into_any_primary(name, primaries, merged_sets, remote=True)
    if ancestor_of:
      report.remote_merged.append(BranchInfo(name, f"{ancestor_of} に取り込み済み", merged_into=ancestor_of))
      continue
    # patch-id 比較（git cherry）は remote には適用しない。ancestor 判定・PR 判定で
    # 拾えない「PRも経由せずcherry-pickされ、履歴にも残らない」remote ブランチは
    # サーバー側では稀なケースであり、本リポジトリの実測でリモート301本全てに
    # 適用すると数分単位で遅くなる。ローカル（開発者本人の手元操作でこそ起こりうる
    # ケース）にのみ適用し、remote は needs_decision に倒す（安全側）。
    report.remote_decide.append(
      BranchInfo(name, f"未取り込み。{branch_facts(ref, cherry_primaries)}")
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


def cherry_check_primaries(primaries: list[str], base: str) -> list[str]:
  """高価な patch-id 比較（`git cherry`）の対象を絞り込む。

  `main`・`develop`・現在の同期起点（`sync_base`）に限定する。cherry-pick / rebase で
  紛れるのはほぼ必ず現在アクティブな統合先であり、全 release/* / dev/* 分（本リポジトリの
  実測で 30 本超）を毎回 `git cherry` すると、ブランチ数との掛け算で実行時間が
  ブランチ本数 × primary 本数に比例して膨らむ。
  """
  candidates = [name for name in ("main", "develop", base) if name]
  return [name for name in dict.fromkeys(candidates) if name in primaries]


def build_report(roots: list[Path]) -> Report:
  report = Report()
  primaries = primary_branch_names()
  report.primary_branches = primaries
  base = detect_sync_base()
  report.sync_base = base
  cherry_primaries = cherry_check_primaries(primaries, base)
  report.main_synced = fetch_and_sync_base(base)
  merged_sets = compute_merged_sets(primaries)
  merged_prs, open_prs = pr_states_per_primary(primaries)
  # Step 5 の「reset してよいか」を agent の目分量ではなくレポートの値で決めるために残す。
  # hold_reason() は current を open_prs より先に判定するため、local.keep の reason には
  # 現在のブランチが open PR に乗っているかどうかが出てこない。ここで別に控える
  # （分類ロジックには触れない ＝ 既存の挙動は変えない）。detached HEAD では空文字になり、
  # その場合 current_branch_open_pr は必ず False。
  report.current_branch = run(["git", "branch", "--show-current"], check=False)
  report.current_branch_open_pr = (
    report.current_branch != "" and report.current_branch in open_prs
  )
  classify_local(report, primaries, cherry_primaries, merged_sets, merged_prs, open_prs)
  classify_remote(report, primaries, cherry_primaries, merged_sets, merged_prs, open_prs)
  collect_working_state(report)
  collect_workspace(report, roots)
  return report


def backup_tag_name(branch_name: str) -> str:
  safe = branch_name.replace("/", "-")
  ts = datetime.now().strftime("%Y%m%d-%H%M%S")
  return f"deleted-branches/{safe}-{ts}"


def delete_local(candidates: list[BranchInfo]) -> list[dict[str, str]]:
  """分類結果に紐づく削除方法をここで選ぶ。削除前に退避タグを打ち、reflog に依存しない
  復元手段を残す。失敗時は直前に作ったタグを消して参照を汚さない。

  呼び出し側にブランチ名だけを渡させると、`-d` で拒否された squash merge 済みを
  人手で `-D` し直す運用になり、未取り込みのものを巻き込む余地が生まれる。
  どちらの方法を使えるかは分類そのものが決めるので、対を崩さない。
  """
  results = []
  for branch in candidates:
    tag = backup_tag_name(branch.name)
    tag_proc = subprocess.run(
      ["git", "tag", tag, branch.name], capture_output=True, text=True, check=False
    )
    if tag_proc.returncode != 0:
      results.append({
        "branch": branch.name, "status": "skipped",
        "detail": f"退避タグ作成に失敗したため削除を中止: {tag_proc.stderr.strip()}",
      })
      continue

    flag = "-D" if branch.merged_via == "pr" else "-d"
    proc = subprocess.run(
      ["git", "branch", flag, branch.name], capture_output=True, text=True, check=False
    )
    if proc.returncode == 0:
      results.append({
        "branch": branch.name, "status": "deleted",
        "detail": branch.reason, "backup_tag": tag,
      })
    else:
      subprocess.run(["git", "tag", "-d", tag], capture_output=True, text=True, check=False)
      results.append({
        "branch": branch.name, "status": "skipped",
        "detail": f"{branch.reason} -> {proc.stderr.strip()}",
      })
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
      capture_output=True, text=True, check=False,
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
  parser.add_argument("--branches", default="", help="カンマ区切り。prune-remote で使う")
  parser.add_argument("--sessions", default="", help="カンマ区切り。purge-workspace で使う")
  parser.add_argument(
    "--workspace", default="",
    help="workspace のパス。省略時は {.agent,.claude}/skills/*/workspace を自動探索する",
  )
  return parser


def csv_arg(value: str) -> list[str]:
  return [item for item in (x.strip() for x in value.split(",")) if item]


def dispatch(command: str, roots: list[Path], branches: list[str], sessions: list[str]) -> str:
  if command == "report":
    return build_report(roots).to_json()
  if command == "prune-local":
    results = delete_local(build_report(roots).local_auto)
    return json.dumps(results, ensure_ascii=False, indent=2) if results else "対象なし"
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
