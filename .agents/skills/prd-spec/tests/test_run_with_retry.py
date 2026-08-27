"""scripts/draft.js・refine.js の runWithRetry() の回帰テスト。

この関数は「agent が応答しなかったときに出し直す」判断を一手に持つ。壊れても例外は出ず、
ログも普段と変わらないため、**リトライが黙って効かなくなる**のが失敗の形になる。
実行の見た目が同じまま「未検査を検査済みとして通す」ことになるので、機械で押さえる。

押さえるのは 3 つ。

1. 落ちた分だけを 1 回出し直す（成功した分を二重に出さない）
2. 複数件を出して全件が落ちたら出し直さない。ただし 1 件しか出していないときは出し直す
3. **返り値が入力順に並ばなくても、正しい項目を出し直す。** pipeline の返り値の並びは
   Workflow の文書に保証が無い。位置から添字を逆算する実装だと、並びが変わったときに
   成功した項目を出し直し、落ちた項目を永久に出し直さない

関数は 2 つの script に**逐語で複製**されている（workflow script は import を書けない）。
片方だけ直すと初稿と改稿で挙動が食い違うので、一致することもテストする。
"""

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
DRAFT = SCRIPTS / "draft.js"
REFINE = SCRIPTS / "refine.js"

FUNC_START = "const runWithRetry = async"


def _extract_function(source: str) -> str:
    lines = source.split("\n")
    s = next(i for i, l in enumerate(lines) if l.startswith(FUNC_START))
    e = next(i for i in range(s + 1, len(lines)) if lines[i] == "}")
    return "\n".join(lines[s : e + 1])


# pipeline / log / agent を差し替えて runWithRetry だけを駆動する。
# shuffle: pipeline の返り値を逆順にして返す。実装が添字を位置から逆算していると、ここで
# 「出し直す相手」がずれる。
HARNESS = """
const spec = JSON.parse(process.argv[2])
const calls = []
const logs = []
const log = (m) => logs.push(m)
const pipeline = async (items, stage) => {
  const out = await Promise.all(items.map((it, i) => stage(it, it, i)))
  return spec.shuffle ? out.slice().reverse() : out
}
const failFirst = new Set(spec.fail_first || [])
const failRetry = new Set(spec.fail_retry || [])
const issue = async (item, attempt) => {
  calls.push([item, attempt])
  const fails = attempt === 1 ? failFirst : failRetry
  // 実物と同じく、失敗しても器は返す（呼び出し側が doc / key を後段で読むため）。
  return { item, ok: !fails.has(item) }
}
const results = await runWithRetry('T', spec.items, issue, (r) => r && r.ok)
console.log(JSON.stringify({ results, calls, logs }))
"""


def run_retry(items, fail_first=(), fail_retry=(), shuffle=False):
    src = _extract_function(DRAFT.read_text(encoding="utf-8")) + "\n" + HARNESS
    spec = {
        "items": list(items),
        "fail_first": list(fail_first),
        "fail_retry": list(fail_retry),
        "shuffle": shuffle,
    }
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "retry.mjs"
        path.write_text(src, encoding="utf-8")
        out = subprocess.run(
            ["node", str(path), json.dumps(spec)], capture_output=True, text=True, check=True
        )
    return json.loads(out.stdout)


def attempts(result, attempt):
    return sorted(c[0] for c in result["calls"] if c[1] == attempt)


def aligned(result):
    """results[i] が items[i] に対応しているか（並びの取り違えを検出する）。"""
    return [r["item"] if r else None for r in result["results"]]


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class RunWithRetryTests(unittest.TestCase):
    # ------------------------------------------------ 全件成功

    def test_no_failure_issues_each_item_once(self):
        for shuffle in (False, True):
            with self.subTest(shuffle=shuffle):
                r = run_retry(["a", "b", "c"], shuffle=shuffle)
                self.assertEqual(attempts(r, 1), ["a", "b", "c"])
                self.assertEqual(attempts(r, 2), [])
                self.assertEqual(aligned(r), ["a", "b", "c"])
                self.assertEqual(r["logs"], [])

    # ------------------------------------------------ 部分失敗 → 出し直して成功

    def test_partial_failure_reissues_only_the_failed_item(self):
        for shuffle in (False, True):
            with self.subTest(shuffle=shuffle):
                r = run_retry(["a", "b", "c"], fail_first=["b"], shuffle=shuffle)
                # 成功した a / c を二重に出さない。
                self.assertEqual(attempts(r, 2), ["b"])
                self.assertEqual(aligned(r), ["a", "b", "c"])
                self.assertTrue(all(x["ok"] for x in r["results"]))
                self.assertTrue(any("再実行します" in m for m in r["logs"]))

    def test_partial_failure_reissues_every_failed_item(self):
        for shuffle in (False, True):
            with self.subTest(shuffle=shuffle):
                r = run_retry(["a", "b", "c", "d"], fail_first=["a", "d"], shuffle=shuffle)
                self.assertEqual(attempts(r, 2), ["a", "d"])
                self.assertEqual(aligned(r), ["a", "b", "c", "d"])
                self.assertTrue(all(x["ok"] for x in r["results"]))

    # ------------------------------------------------ 部分失敗 → 出し直しても失敗

    def test_failed_retry_keeps_the_missing_shell_and_reports_it(self):
        for shuffle in (False, True):
            with self.subTest(shuffle=shuffle):
                r = run_retry(["a", "b"], fail_first=["b"], fail_retry=["b"], shuffle=shuffle)
                self.assertEqual(attempts(r, 2), ["b"])
                # 欠測でも器は残る（None に潰すと後段が doc を読めない）。
                self.assertEqual(aligned(r), ["a", "b"])
                self.assertFalse(r["results"][1]["ok"])
                self.assertTrue(any("再実行後も 1 件" in m for m in r["logs"]))

    # ------------------------------------------------ 全滅は出し直さない

    def test_total_failure_of_multiple_items_is_not_reissued(self):
        for shuffle in (False, True):
            with self.subTest(shuffle=shuffle):
                r = run_retry(["a", "b", "c"], fail_first=["a", "b", "c"], shuffle=shuffle)
                self.assertEqual(attempts(r, 2), [])
                self.assertTrue(any("すべてが応答しませんでした" in m for m in r["logs"]))

    # ------------------------------------------------ 母数 1 の全滅は出し直す

    def test_single_item_failure_is_reissued(self):
        for shuffle in (False, True):
            with self.subTest(shuffle=shuffle):
                r = run_retry(["a"], fail_first=["a"], shuffle=shuffle)
                self.assertEqual(attempts(r, 2), ["a"])
                self.assertEqual(aligned(r), ["a"])
                self.assertTrue(r["results"][0]["ok"])

    def test_single_item_failure_that_stays_failed_is_reported(self):
        r = run_retry(["a"], fail_first=["a"], fail_retry=["a"])
        self.assertEqual(attempts(r, 2), ["a"])
        self.assertFalse(r["results"][0]["ok"])
        self.assertTrue(any("再実行後も 1 件" in m for m in r["logs"]))

    # ------------------------------------------------ 複製の一致

    def test_draft_and_refine_share_the_same_implementation(self):
        self.assertEqual(
            _extract_function(DRAFT.read_text(encoding="utf-8")),
            _extract_function(REFINE.read_text(encoding="utf-8")),
            "runWithRetry が draft.js と refine.js で食い違っています。"
            "初稿と改稿で欠測の扱いが変わるため、両方を同時に直すこと。",
        )


if __name__ == "__main__":
    unittest.main()
