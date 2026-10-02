"""workflows/prd-spec.js の runEach() の回帰テスト。

runEach は並列の agent を 1 回ずつ起動し、返り値を項目の順に並べる。null（利用者が止めたか、runtime の出し直しの後も
API エラーだった）を出し直さない: 出し直すと利用者の停止を覆し、API エラーは runtime が既に出し直している。null を
「指摘 0 件」にしないのは呼び出した段の仕事で、test_prd_stages が押さえる。

押さえるのは 2 つ。

1. 各項目を 1 回だけ起動し、null を null のまま返す（出し直さない）
2. **返り値が入力順に並ばなくても、項目と結果を取り違えない。** pipeline の返り値の並びは Workflow の文書に
   保証が無い。位置から添字を逆算する実装だと、並びが変わったときに別の項目の結果を読む
"""

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from prd_script import PRD_PATH as PRD

FUNC_START = "const runEach = async"


def _extract_function(source: str) -> str:
    lines = source.split("\n")
    s = next(i for i, l in enumerate(lines) if l.startswith(FUNC_START))
    e = next(i for i in range(s + 1, len(lines)) if lines[i] == "}")
    return "\n".join(lines[s : e + 1])


# shuffle: pipeline の返り値を逆順にして返す。実装が添字を位置から逆算していると、ここで結果がずれる。
HARNESS = """
const spec = JSON.parse(process.argv[2])
const calls = []
const pipeline = async (items, stage) => {
  const out = await Promise.all(items.map((it, i) => stage(it, it, i)))
  return spec.shuffle ? out.slice().reverse() : out
}
const nulls = new Set(spec.nulls || [])
const results = await runEach(spec.items, async (item) => {
  calls.push(item)
  return nulls.has(item) ? null : { item }
})
console.log(JSON.stringify({ results, calls }))
"""


def run_each(items, nulls=(), shuffle=False):
    src = _extract_function(PRD.read_text(encoding="utf-8")) + "\n" + HARNESS
    spec = {"items": list(items), "nulls": list(nulls), "shuffle": shuffle}
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "each.mjs"
        path.write_text(src, encoding="utf-8")
        out = subprocess.run(["node", str(path), json.dumps(spec)], capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class RunEachTests(unittest.TestCase):
    def test_各項目を1回だけ起動し結果を項目の順に並べる(self):
        for shuffle in (False, True):
            with self.subTest(shuffle=shuffle):
                r = run_each(["a", "b", "c"], shuffle=shuffle)
                self.assertEqual(sorted(r["calls"]), ["a", "b", "c"])
                self.assertEqual([x["item"] for x in r["results"]], ["a", "b", "c"])

    def test_nullは出し直さずnullのまま返す(self):
        for items, nulls in ((["a"], ["a"]), (["a", "b", "c"], ["b"]), (["a", "b"], ["a", "b"])):
            for shuffle in (False, True):
                with self.subTest(items=items, nulls=nulls, shuffle=shuffle):
                    r = run_each(items, nulls, shuffle)
                    self.assertEqual(sorted(r["calls"]), sorted(items), "1 項目につき 1 回だけ起動する")
                    self.assertEqual([None if x is None else x["item"] for x in r["results"]], [None if i in nulls else i for i in items])


if __name__ == "__main__":
    unittest.main()
