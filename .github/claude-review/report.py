"""Claude レビューの総括を投稿し、読んだ範囲を実行ログから数えて書き足す。

読んだ範囲はモデルの申告ではなく、メインのセッションが呼んだ Read から数える。
確認用の Agent の読み取りは照合ではないので数えない。総括のファイルが無ければ
失敗を PR に書き、ジョブを失敗させる。
"""

import json
import os
import re
import subprocess
import sys
from collections import Counter
from pathlib import Path

from prepare import FAILURE_MARK

NUMBERED_LINE = re.compile(r"^\s*(\d+)[\t\u2192]", re.MULTILINE)
PR_SNAPSHOT = ".claude-pr"
LISTED_FILES = 30
COMMENT_LIMIT = 60000


def load_messages(path: str) -> list[dict]:
  """実行ログを読む。JSON の配列・messages を持つオブジェクト・JSON Lines のどれでも受ける。"""
  if not path or not Path(path).exists():
    return []
  text = Path(path).read_text()
  try:
    data = json.loads(text)
  except json.JSONDecodeError:
    return [json.loads(line) for line in text.splitlines() if line.strip()]
  return data if isinstance(data, list) else data.get("messages", [])


def main_thread_reads(messages: list[dict]) -> list[tuple[str, str]]:
  """メインのセッションの Read で、成功した呼び出しの (file_path, 返った本文) を返す。"""
  calls, results = {}, {}
  for message in messages:
    if message.get("parent_tool_use_id") or message.get("agent_id"):
      continue
    for block in message.get("message", {}).get("content") or []:
      if not isinstance(block, dict):
        continue
      if block.get("type") == "tool_use" and block.get("name") == "Read":
        calls[block.get("id")] = (block.get("input") or {}).get("file_path", "")
      elif block.get("type") == "tool_result" and not block.get("is_error"):
        results[block.get("tool_use_id")] = result_text(block.get("content"))
  return [
    (path, results[tool_id]) for tool_id, path in calls.items() if tool_id in results
  ]


def result_text(content: str | list | None) -> str:
  """tool_result の content を文字列にする。"""
  if isinstance(content, str):
    return content
  return "\n".join(c.get("text", "") for c in content or [] if isinstance(c, dict))


def line_count(path: Path) -> int:
  """ファイルの行数。読めなければ 0。"""
  try:
    return len(path.read_text(errors="replace").splitlines())
  except OSError:
    return 0


def coverage(lines: int, ranges: list[tuple[int, int]]) -> str:
  """読んだ行の範囲から、全体・一部・なしを返す。本文の無いファイルは読み終えたものとする。"""
  if lines == 0:
    return "full"
  if not ranges:
    return "none"
  covered = set()
  for start, end in ranges:
    covered.update(range(start, min(end, lines) + 1))
  return "full" if len(covered) >= lines else "partial"


def read_ranges(
  reads: list[tuple[str, str]], root: Path
) -> dict[str, list[tuple[int, int]]]:
  """作業ツリーからの相対パスごとに、Read が実際に返した行の範囲を集める。

  .claude-pr/ は action が PR 側の .claude/ や CLAUDE.md を退避した場所なので、元のパスとして数える。
  """
  ranges: dict[str, list[tuple[int, int]]] = {}
  for file_path, text in reads:
    target = Path(file_path).resolve()
    numbers = [int(n) for n in NUMBERED_LINE.findall(text)]
    if not numbers or not target.is_relative_to(root):
      continue
    rel = target.relative_to(root)
    if rel.parts[0] == PR_SNAPSHOT:
      rel = Path(*rel.parts[1:])
    ranges.setdefault(str(rel), []).append((min(numbers), max(numbers)))
  return ranges


def coverage_note(
  rows: list[list[str]],
  ranges: dict[str, list[tuple[int, int]]],
  root: Path,
  excluded: list[str],
  symlinks: set[str],
) -> list[str]:
  """読んだ範囲の節を組む。"""
  labels = {"full": "全部読んだ", "partial": "一部だけ読んだ", "none": "読んでいない"}
  status, body = {}, {}
  for path, state, diff_file, _size in rows:
    diff_rel = str((root / diff_file).resolve().relative_to(root))
    status[path] = coverage(line_count(root / diff_file), ranges.get(diff_rel, []))
    snapshot = root / PR_SNAPSHOT / path
    body_file = snapshot if snapshot.exists() else root / path
    if state == "D" or path in symlinks or not body_file.is_file():
      continue
    body[path] = coverage(line_count(body_file), ranges.get(path, []))
  counts, body_counts = Counter(status.values()), Counter(body.values())
  note = [
    "**読んだ範囲**（workflow が実行ログから数えたもの。Claude の申告ではない）",
    f"- 差分: {len(rows)} 件中 "
    + "・".join(f"{labels[k]} {counts[k]}" for k in labels),
    "- ファイル本文（削除したファイルと symlink を除く）: "
    + "・".join(f"{labels[k]} {body_counts[k]}" for k in labels),
  ]
  for key in ("none", "partial"):
    listed = [p for p, s in status.items() if s == key]
    if listed:
      more = " ほか" if len(listed) > LISTED_FILES else ""
      note.append(
        f"- 差分を{labels[key]}: "
        + ", ".join(f"`{p}`" for p in listed[:LISTED_FILES])
        + more
      )
  if excluded:
    shown = [e.split("\t") for e in excluded[:LISTED_FILES]]
    more = " ほか" if len(excluded) > LISTED_FILES else ""
    note.append(
      "- 照合から外したもの: " + ", ".join(f"`{p}`（{r}）" for p, r in shown) + more
    )
  return note


def gh(*args: str) -> None:
  """gh を実行し、失敗したら止まる。"""
  subprocess.run(["gh", *args], check=True)


def write_step_summary(env: os._Environ[str], result: dict, note: list[str]) -> None:
  """実行の概要と読んだ範囲を Actions の step summary に書く。"""
  denials = result.get("permission_denials") or []
  with open(env["GITHUB_STEP_SUMMARY"], "a") as summary:
    summary.write(f"### {env['NAME']}\n\n")
    summary.write(
      f"- Claude の step: {env['CLAUDE_OUTCOME']}・ターン: {result.get('num_turns')}"
      f"・費用: {result.get('total_cost_usd')}・拒否された呼び出し: {len(denials)}\n"
    )
    for denial in denials:
      summary.write(
        f"  - {denial.get('tool_name')}: {json.dumps(denial.get('tool_input'), ensure_ascii=False)[:200]}\n"
      )
    summary.write("\n".join(note) + "\n")


def post(env: os._Environ[str], out: Path, note: list[str]) -> None:
  """総括に見出しと読んだ範囲を付けて投稿する。総括が無ければ失敗を投稿して止まる。"""
  body_file = out / "comment.md"
  written = out / "summary.md"
  if not written.exists() or not written.read_text().strip():
    body_file.write_text(
      f"{env['HEADER']}\n\n{FAILURE_MARK}: 総括が書かれなかった。"
      f"Claude の step: {env['CLAUDE_OUTCOME']}。実行: {env['RUN_URL']}\n"
    )
    gh("pr", "comment", env["PR"], "--repo", env["REPO"], "--body-file", str(body_file))
    sys.exit(f"{env['HEADER']} の総括が書かれなかった")
  text = written.read_text().strip()
  if len(text) > COMMENT_LIMIT:
    text = text[:COMMENT_LIMIT] + "\n\n(長すぎるため切り詰めた)"
  body_file.write_text(f"{env['HEADER']}\n\n{text}\n\n" + "\n".join(note) + "\n")
  gh("pr", "comment", env["PR"], "--repo", env["REPO"], "--body-file", str(body_file))


def main() -> None:
  """実行ログから読んだ範囲を数え、総括と一緒に投稿する。"""
  env = os.environ
  root = Path(env["GITHUB_WORKSPACE"]).resolve()
  out = Path(env["OUT"])
  rows = [
    line.split("\t") for line in (out / "files.tsv").read_text().splitlines() if line
  ]
  excluded = [line for line in (out / "excluded.tsv").read_text().splitlines() if line]
  symlinks = set((out / "symlinks.txt").read_text().splitlines())
  messages = load_messages(env.get("EXECUTION_FILE", ""))
  result = next((m for m in reversed(messages) if m.get("type") == "result"), {})
  note = coverage_note(
    rows, read_ranges(main_thread_reads(messages), root), root, excluded, symlinks
  )
  write_step_summary(env, result, note)
  post(env, out, note)


if __name__ == "__main__":
  main()
