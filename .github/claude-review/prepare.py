"""Claude レビューの 1 ジョブ分の入力を作る。

PR の差分を変更ファイルごとに書き出し、このジョブが照合するファイルの一覧と、
既存のレビュースレッド・このジョブの前回の総括を用意する。PR 由来の文字列は
ファイルにだけ書き、ワークフローの式には展開しない。
"""

import json
import os
import re
import subprocess
import sys
from pathlib import Path

LOCKFILE = re.compile(
  r"(^|/)(.*\.lock|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|uv\.lock|poetry\.lock)$"
)
SUBMODULE_MODE = "160000"
SYMLINK_MODE = "120000"
DOC_SUFFIXES = (".md", ".markdown", ".mdx")
FAILURE_MARK = "**レビューの失敗**"
THREADS_QUERY = """
query($owner: String!, $name: String!, $n: Int!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $n) {
      reviewThreads(first: 100, after: $endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          isResolved path line originalLine
          first: comments(first: 1) { nodes { author { login } body } }
          last: comments(last: 1) { totalCount nodes { author { login } body } }
        }
      }
    }
  }
}
"""


def run(*args: str) -> str:
  """コマンドを実行し、失敗したら標準エラーを添えて止まる。"""
  result = subprocess.run(
    args, capture_output=True, encoding="utf-8", errors="replace", check=False
  )
  if result.returncode != 0:
    sys.exit(f"{' '.join(args[:3])} failed: {result.stderr.strip()}")
  return result.stdout


def changed_files(diff_range: str) -> list[tuple[str, str, list[str], tuple[str, str]]]:
  """変更ファイルを (表示パス, 状態, git diff に渡すパス, (変更前の mode, 変更後の mode)) で返す。"""
  raw = run(
    "git", "-c", "core.quotePath=false", "diff", "--raw", "-z", "-M", diff_range
  )
  fields = raw.split("\0")
  entries = []
  i = 0
  while i < len(fields) and fields[i].startswith(":"):
    meta = fields[i][1:].split()
    old_mode, new_mode, status = meta[0], meta[1], meta[4]
    if status[0] in "RC":
      old, new = fields[i + 1], fields[i + 2]
      entries.append((new, status[0], [old, new], (old_mode, new_mode)))
      i += 3
    else:
      path = fields[i + 1]
      entries.append((path, status[0], [path], (old_mode, new_mode)))
      i += 2
  return entries


def file_diff(
  diff_range: str, paths: list[str], *, whole_sections: bool, attributes: Path
) -> str:
  """1 ファイルの差分を返す。文書は見出しから次の見出しまでを丸ごと含める。"""
  config = ["--literal-pathspecs", "-c", "core.quotePath=false"]
  options = ["--no-color", "--no-ext-diff", "-M"]
  if whole_sections:
    config += ["-c", f"core.attributesFile={attributes}"]
    options.append("-W")
  return run("git", *config, "diff", *options, diff_range, "--", *paths)


def prior_reviews(repo: str, pr: str, paths: set[str], header: str) -> str:
  """このジョブのファイルに付いたスレッドと、このジョブの前回の総括を文章にする。"""
  owner, name = repo.split("/", 1)
  pages = json_values(
    run(
      "gh",
      "api",
      "graphql",
      "--paginate",
      "-f",
      f"owner={owner}",
      "-f",
      f"name={name}",
      "-F",
      f"n={pr}",
      "-f",
      f"query={THREADS_QUERY}",
    )
  )
  threads = [
    node
    for page in pages
    for node in page["data"]["repository"]["pullRequest"]["reviewThreads"]["nodes"]
  ]
  lines = []
  for thread in threads:
    if thread["path"] not in paths or not thread["first"]["nodes"]:
      continue
    head = thread["first"]["nodes"][0]
    state = "解決済み" if thread["isResolved"] else "未解決"
    entry = f"- {thread['path']}:{thread['line'] or thread['originalLine']} ({state}) {short(head['body'])}"
    if thread["last"]["totalCount"] > 1:
      last = thread["last"]["nodes"][0]
      author = (last["author"] or {}).get("login")
      entry += f" ／ 最後の返信 ({author}): {short(last['body'])}"
    lines.append(entry)
  comments = run(
    "gh",
    "api",
    f"repos/{repo}/issues/{pr}/comments",
    "--paginate",
    "--jq",
    '[.[] | select(.user.login == "github-actions[bot]") | .body]',
  )
  previous = [
    c
    for c in [c for page in json_values(comments) for c in page]
    if c.lstrip().startswith(header) and FAILURE_MARK not in c
  ]
  out = [
    "スレッド:",
    "\n".join(lines) if lines else "(このジョブのファイルに付いたスレッドは無い)",
  ]
  out += ["", "前回の総括:", previous[-1] if previous else "(無い)"]
  return "\n".join(out) + "\n"


def json_values(text: str) -> list:
  """--paginate がページごとに出す JSON を順に読み、ページの一覧にする。"""
  decoder = json.JSONDecoder()
  pages, index = [], 0
  while True:
    while index < len(text) and text[index].isspace():
      index += 1
    if index >= len(text):
      return pages
    page, index = decoder.raw_decode(text, index)
    pages.append(page)


def short(text: str, limit: int = 200) -> str:
  """改行を詰めて limit 文字に切る。"""
  text = " ".join((text or "").split())
  return text if len(text) <= limit else text[:limit] + "…"


def collect(
  kind: str, diff_range: str, diff_dir: Path, attributes: Path
) -> tuple[list[str], list[str], list[str]]:
  """このジョブのファイルの差分を書き出し、一覧の行・除外の行・変更後に symlink のパスを返す。"""
  rows, excluded, symlinks = [], [], []
  for path, status, paths, modes in changed_files(diff_range):
    if path.lower().endswith(DOC_SUFFIXES) != (kind == "docs"):
      continue
    if SUBMODULE_MODE in modes:
      excluded.append(f"{path}\tsubmodule")
      continue
    if LOCKFILE.search(path):
      excluded.append(f"{path}\tlockfile")
      continue
    text = file_diff(
      diff_range, paths, whole_sections=kind == "docs", attributes=attributes
    )
    if re.search(r"^Binary files ", text, re.MULTILINE):
      excluded.append(f"{path}\tbinary")
      continue
    diff_file = diff_dir / f"{len(rows) + 1:04d}.diff"
    diff_file.write_text(text)
    rows.append(f"{path}\t{status}\t{diff_file}\t{len(text.encode())}")
    if modes[1] == SYMLINK_MODE:
      symlinks.append(path)
  return rows, excluded, symlinks


def main() -> None:
  """ジョブの入力を書き出し、件数を GITHUB_OUTPUT に書く。"""
  env = os.environ
  kind = env["KIND"]
  out = Path(env["OUT"])
  diff_dir = out / "diff"
  diff_dir.mkdir(parents=True, exist_ok=True)
  attributes = Path(env["RUNNER_TEMP"]) / "markdown.attributes"
  attributes.write_text(
    "".join(f"*{suffix} diff=markdown\n" for suffix in DOC_SUFFIXES)
  )
  run(
    "git",
    "fetch",
    "--no-tags",
    "--quiet",
    "origin",
    f"+refs/heads/{env['BASE_REF']}:refs/remotes/origin/pr-base",
  )
  rows, excluded, symlinks = collect(
    kind, f"origin/pr-base...{env['HEAD_SHA']}", diff_dir, attributes
  )
  (out / "files.tsv").write_text("".join(f"{r}\n" for r in rows))
  (out / "excluded.tsv").write_text("".join(f"{e}\n" for e in excluded))
  (out / "symlinks.txt").write_text("".join(f"{s}\n" for s in symlinks))
  paths = {r.split("\t", 1)[0] for r in rows}
  if rows:
    (out / "prior.md").write_text(
      prior_reviews(env["REPO"], env["PR"], paths, env["HEADER"])
    )
  with open(env["GITHUB_OUTPUT"], "a") as output:
    output.write(f"count={len(rows)}\n")
  print(f"kind={kind} files={len(rows)} excluded={len(excluded)}")


if __name__ == "__main__":
  main()
