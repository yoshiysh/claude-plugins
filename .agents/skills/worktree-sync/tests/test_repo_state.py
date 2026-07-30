"""worktree-sync の分類ロジックの回帰テスト。

固定したいのは実際に踏んだ失敗と、取り込み判定の 3 経路:

1. `git status --porcelain` の出力を行ごとに strip すると、先頭の状態フラグが
   パスの先頭文字と混ざる（` M .agent/x` が `M agent/x` になった）
2. squash merge されたブランチは `merge-base --is-ancestor` では取り込み済みと
   判定できず、PR の merged 状態を見ないと未取り込みに分類されてしまう
3. cherry-pick / rebase で取り込まれたブランチは履歴にも PR にも痕跡が無く、
   `git cherry` の patch-id 比較でしか拾えない

git のリポジトリ状態を作らずに検証するため、コマンド実行だけを差し替える。
"""

import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPT_PATH = Path(__file__).resolve().parents[1] / "scripts" / "repo_state.py"
SPEC = importlib.util.spec_from_file_location("repo_state", SCRIPT_PATH)
repo_state = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
# @dataclass は自分の module を sys.modules から引くため、exec 前に登録しておく。
sys.modules["repo_state"] = repo_state
SPEC.loader.exec_module(repo_state)


class WorkingStateTests(unittest.TestCase):
  def _run_with(self, outputs):
    return mock.patch.object(repo_state, "run", lambda cmd, **_: outputs[tuple(cmd)])

  def test_porcelain_status_keeps_leading_dot(self):
    """先頭が空白の status 行でもパスが欠けない。"""
    outputs = {
      ("git", "stash", "list"): "",
      ("git", "submodule", "status"): "",
      ("git", "status", "--porcelain"): " M .serena/project.yml\n?? .gitattributes",
    }
    report = repo_state.Report()
    with self._run_with(outputs):
      repo_state.collect_working_state(report)

    self.assertEqual(report.tracked_dirty, ["M .serena/project.yml"])
    self.assertEqual(report.untracked, [".gitattributes"])

  def test_submodule_pointer_drift_excluded_from_dirty(self):
    """submodule のポインタ差分は tracked_dirty ではなく drift に入る（削除対象にしない）。"""
    submodule = "+abc123 .agent/skills/riopon-rag/workspace (abc123)"
    outputs = {
      ("git", "stash", "list"): "",
      ("git", "submodule", "status"): submodule,
      ("git", "status", "--porcelain"): " M .agent/skills/riopon-rag/workspace",
    }
    report = repo_state.Report()
    with self._run_with(outputs):
      repo_state.collect_working_state(report)

    self.assertEqual(report.submodule_drift, [submodule])
    self.assertEqual(report.tracked_dirty, [])


class BranchClassificationTests(unittest.TestCase):
  def test_squash_merged_branch_is_auto_delete(self):
    """履歴に含まれなくても PR が merged なら自動削除対象。-D が必要な旨も記録する。"""
    report = repo_state.Report()
    with mock.patch.object(repo_state, "is_merged_into_main", return_value=False):
      repo_state.classify_one_local(report, "fix/squashed", "[gone]", {"fix/squashed"})

    self.assertEqual([b.name for b in report.local_auto], ["fix/squashed"])
    self.assertEqual(report.local_auto[0].merged_via, "pr")
    self.assertEqual(report.local_decide, [])

  def test_cherry_picked_branch_is_auto_delete(self):
    """履歴にも PR にも痕跡が無くても、パッチが main にあれば自動削除対象。"""
    report = repo_state.Report()
    with (
      mock.patch.object(repo_state, "is_merged_into_main", return_value=False),
      mock.patch.object(repo_state, "patches_all_in_main", return_value=True),
    ):
      repo_state.classify_one_local(report, "fix/cherry-picked", "", set())

    self.assertEqual([b.name for b in report.local_auto], ["fix/cherry-picked"])
    self.assertEqual(report.local_auto[0].merged_via, "pr")

  def test_gone_but_unmerged_needs_decision(self):
    """remote が消えていても未取り込みなら自動削除しない。判断材料を添える。"""
    report = repo_state.Report()
    with (
      mock.patch.object(repo_state, "is_merged_into_main", return_value=False),
      mock.patch.object(repo_state, "patches_all_in_main", return_value=False),
      mock.patch.object(repo_state, "branch_facts", return_value="独自 commit 3 本"),
    ):
      repo_state.classify_one_local(report, "fix/abandoned", "[gone]", set())

    self.assertEqual(report.local_auto, [])
    self.assertEqual([b.name for b in report.local_decide], ["fix/abandoned"])
    self.assertIn("独自 commit 3 本", report.local_decide[0].reason)

  def test_patches_all_in_main(self):
    """cherry-pick / rebase 経由の取り込みを patch-id で拾う。"""
    cases = [
      ("- abc111\n- abc222", True),  # 全 commit のパッチが main にある
      ("- abc111\n+ abc222", False),  # 一部だけ取り込まれている
      ("+ abc111", False),
      ("", False),  # 比較対象が無い場合は取り込み済みと見なさない
    ]
    for output, expected in cases:
      with self.subTest(output=output):
        with mock.patch.object(repo_state, "run", lambda *_a, **_k: output):
          self.assertIs(repo_state.patches_all_in_main("origin/x"), expected)

  def test_hold_reason_precedence(self):
    cases = [
      ("a", "a", set(), set(), "現在のブランチ"),
      ("a", "b", {"a"}, set(), "他の worktree で checkout 中"),
      ("a", "b", set(), {"a"}, "PR が open"),
      ("a", "b", set(), set(), ""),
    ]
    for name, current, worktrees, open_prs, expected in cases:
      with self.subTest(expected=expected):
        self.assertEqual(
          repo_state.hold_reason(name, current, worktrees, open_prs), expected
        )


class RemoteDeletionTests(unittest.TestCase):
  def test_without_names_targets_all_merged(self):
    """名前を渡さなければ merged 分類の全件が対象。確認を挟まず消せる形にする。"""
    pushed = []

    class Done:
      returncode = 0
      stderr = ""

    def fake_run(cmd, **_):
      pushed.append(cmd[-1])
      return Done()

    with mock.patch.object(repo_state.subprocess, "run", fake_run):
      results = repo_state.delete_remote([], allowed={"b/two", "a/one"})

    self.assertEqual(pushed, ["a/one", "b/two"])
    self.assertTrue(all(r.startswith("deleted:") for r in results))

  def test_refuses_unclassified(self):
    """merged と分類されていない remote ブランチは push --delete しない。"""

    def fake_run(cmd, **_):
      raise AssertionError("削除コマンドが実行された")

    with mock.patch.object(repo_state.subprocess, "run", fake_run):
      results = repo_state.delete_remote(["feature/unknown"], allowed={"feature/merged"})

    self.assertEqual(
      results, ["refused: origin/feature/unknown (merged と分類されていない)"]
    )


class WorkspaceTests(unittest.TestCase):
  def test_discovery_dedupes_symlinked_skill_dirs(self):
    """.claude/skills が .agent/skills への symlink でも同じ workspace を二重に数えない。"""
    with tempfile.TemporaryDirectory() as tmp:
      root = Path(tmp)
      (root / ".agent/skills/alpha/workspace").mkdir(parents=True)
      (root / ".claude").mkdir()
      (root / ".claude/skills").symlink_to(root / ".agent/skills")
      cwd = Path.cwd()
      try:
        os.chdir(root)
        found = repo_state.discover_workspaces("")
      finally:
        os.chdir(cwd)

    self.assertEqual([str(p) for p in found], [".agent/skills/alpha/workspace"])

  def test_sessions_are_qualified_by_skill(self):
    """workspace を持つスキルが複数あっても名前で取り違えない。"""
    with tempfile.TemporaryDirectory() as tmp:
      ws = Path(tmp) / "skills/magi/workspace"
      (ws / "done").mkdir(parents=True)
      (ws / "done/state.json").write_text('{"status": "completed"}', encoding="utf-8")
      (ws / "running").mkdir()
      (ws / "running/state.json").write_text('{"status": "in_progress"}', encoding="utf-8")

      report = repo_state.Report()
      repo_state.collect_workspace(report, [ws])

    self.assertEqual(report.workspace_done, ["magi/done"])
    self.assertEqual(report.workspace_active, ["magi/running (in_progress)"])

  def test_purge_rejects_unknown_skill_and_traversal(self):
    """workspace 直下以外は消さない（gitignore 対象で復元できないため）。"""
    with tempfile.TemporaryDirectory() as tmp:
      ws = Path(tmp) / "skills/magi/workspace"
      (ws / "session").mkdir(parents=True)
      outside = Path(tmp) / "outside"
      outside.mkdir()

      results = repo_state.purge_workspace([ws], ["other/session", "magi/../../outside"])

      self.assertTrue(outside.is_dir())
      self.assertTrue((ws / "session").is_dir())
    self.assertTrue(all(r.startswith("skipped:") for r in results))

  def test_purge_removes_named_session(self):
    with tempfile.TemporaryDirectory() as tmp:
      ws = Path(tmp) / "skills/magi/workspace"
      (ws / "done").mkdir(parents=True)

      results = repo_state.purge_workspace([ws], ["magi/done"])

      self.assertFalse((ws / "done").exists())
    self.assertEqual(results, ["purged: magi/done"])


if __name__ == "__main__":
  unittest.main()
