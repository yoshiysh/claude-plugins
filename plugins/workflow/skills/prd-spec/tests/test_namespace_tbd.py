"""scripts/draft.js・refine.js の namespaceTbd() の回帰テスト。

分割文書は並列に書かれて互いの採番を知らないため、同じ `TBD-003` が別の論点に振られうる。
統合前に所属文書のコードを冠して衝突を防ぐのがこの関数である。

**これは保険ではなく前提条件である。** 統合先（`refine.js` の `rebuildTbd`）は ID をキーにした
Map で組み直すので、素の ID が 2 文書から来ると:

- 後勝ちに潰れるだけでなく、`{...base, ...item}` により両者のフィールドが混ざった項目ができる
- 前ラウンドが `TBD-RAUTH-001`、今回が素の `TBD-001` だと**同じ論点が別 ID として扱われ**、
  前者は resolved（解決した）に落ち、後者は presented を失って「未提示の新規」に化ける

後者は `unpresented_blocking`（完成条件そのもの）を壊す。壊れても例外は出ず、件数が変わるだけ
なので、人が気づく手立てが無い。

関数は 2 つの script に**逐語で複製**されている（workflow script は import を書けない）。
片方だけ直すと初稿と改稿で採番が食い違うので、一致することもテストする。
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

FUNC_START = "const namespaceTbd ="
# namespaceTbd は tbdPrefix / areaCode に依存する。両 script で同じ規約でなければならない。
DEPS = ["const areaCode =", "const tbdPrefix ="]

HARNESS = """
const spec = JSON.parse(process.argv[2])
console.log(JSON.stringify(namespaceTbd(spec.documents)))
"""


def _extract(source: str, start: str) -> str:
    lines = source.split("\n")
    s = next(i for i, l in enumerate(lines) if l.startswith(start))
    if lines[s].rstrip().endswith(("=>", "{")) and not lines[s].rstrip().endswith("`"):
        # 複数行の定義。トップレベルの閉じ括弧まで。
        try:
            e = next(i for i in range(s + 1, len(lines)) if lines[i] == "}")
            return "\n".join(lines[s : e + 1])
        except StopIteration:
            pass
    return lines[s]


def run_namespace(documents):
    src = DRAFT.read_text(encoding="utf-8")
    harness = "\n".join(_extract(src, d) for d in DEPS) + "\n" + _extract(src, FUNC_START) + "\n" + HARNESS
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "ns.mjs"
        path.write_text(harness, encoding="utf-8")
        out = subprocess.run(
            ["node", str(path), json.dumps({"documents": documents})],
            capture_output=True,
            text=True,
            check=True,
        )
    return json.loads(out.stdout)


def doc(kind, topic, tbd):
    return {"key": f"{kind}/{topic}", "kind": kind, "topic": topic, "tbd_items": tbd}


def ids(result):
    return [t["id"] for t in result["items"]]


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class NamespaceTbdTests(unittest.TestCase):
    def test_bare_ids_from_two_documents_do_not_collide(self):
        """ここが崩れると rebuildTbd で片方が黙って消える。"""
        r = run_namespace(
            [
                doc("requirements", "auth", [{"id": "TBD-001", "text": "A"}]),
                doc("specifications", "auth", [{"id": "TBD-001", "text": "B"}]),
            ]
        )
        self.assertEqual(len(set(ids(r))), 2, f"ID が衝突しています: {ids(r)}")
        self.assertEqual(sorted(t["text"] for t in r["items"]), ["A", "B"])

    def test_requirements_and_specifications_get_different_prefixes(self):
        r = run_namespace(
            [
                doc("requirements", "auth", [{"id": "TBD-001"}]),
                doc("specifications", "auth", [{"id": "TBD-001"}]),
            ]
        )
        self.assertTrue(any(i.startswith("TBD-R") for i in ids(r)), ids(r))
        self.assertTrue(any(i.startswith("TBD-S") for i in ids(r)), ids(r))

    def test_already_namespaced_ids_are_left_alone(self):
        r = run_namespace([doc("requirements", "auth", [{"id": "TBD-RAUTH-007"}])])
        self.assertEqual(ids(r), ["TBD-RAUTH-007"])
        self.assertEqual(r["findings"], [])

    def test_executability_ids_are_exempt(self):
        """TBD-EX- は script が起票したものなので、文書の接頭辞を冠さない。"""
        r = run_namespace([doc("requirements", "auth", [{"id": "TBD-EX-003"}])])
        self.assertEqual(ids(r), ["TBD-EX-003"])

    def test_collision_with_existing_id_is_parked_not_folded(self):
        """素朴に振り直すと 2 件が 1 件に畳まれ、この処理自身が防ぎたい事象を起こす。"""
        r = run_namespace(
            [
                doc(
                    "requirements",
                    "auth",
                    [{"id": "TBD-RAUTH-001", "text": "先客"}, {"id": "TBD-001", "text": "後から"}],
                )
            ]
        )
        self.assertEqual(len(set(ids(r))), 2, f"畳まれています: {ids(r)}")
        self.assertEqual(sorted(t["text"] for t in r["items"]), ["先客", "後から"])
        # 黙って退避しない。writer に採番を直させるための指摘を返す
        self.assertEqual([f["id"].split("-")[1] for f in r["findings"]], ["TBDRENUM"])

    def test_parking_does_not_depend_on_input_order(self):
        """接頭辞付きを先に席として確保しないと、振り直した側が正しい採番を追い出す。"""
        r = run_namespace(
            [
                doc(
                    "requirements",
                    "auth",
                    [{"id": "TBD-001", "text": "後から"}, {"id": "TBD-RAUTH-001", "text": "先客"}],
                )
            ]
        )
        held = next(t for t in r["items"] if t["id"] == "TBD-RAUTH-001")
        self.assertEqual(held["text"], "先客", "正しい採番の側が追い出されています")

    def test_by_key_groups_by_owning_document_not_by_stale_field(self):
        """前ラウンドから引き継がれた古い document 値で別文書へ紛れ込ませない。"""
        r = run_namespace(
            [doc("requirements", "auth", [{"id": "TBD-001", "document": "specifications/legacy"}])]
        )
        self.assertEqual(list(r["byKey"].keys()), ["requirements/auth"])
        self.assertEqual(len(r["byKey"]["requirements/auth"]), 1)

    def test_document_is_filled_in_when_absent(self):
        r = run_namespace([doc("requirements", "auth", [{"id": "TBD-001"}])])
        self.assertEqual(r["items"][0]["document"], "requirements/auth")

    def test_items_without_id_are_dropped(self):
        r = run_namespace([doc("requirements", "auth", [{"id": "TBD-001"}, {"text": "id 無し"}, None])])
        self.assertEqual(len(r["items"]), 1)

    def test_both_scripts_actually_call_it(self):
        """**今回のバグはこれだった** — 関数は draft.js にあり、refine.js は呼んでいなかった。

        定義の一致だけを見ると、呼ばれていない実装でも通る。呼び出し側を押さえる。
        """
        for path in (DRAFT, REFINE):
            with self.subTest(script=path.name):
                body = path.read_text(encoding="utf-8")
                calls = [l for l in body.split("\n") if "namespaceTbd(" in l and not l.startswith("const namespaceTbd")]
                self.assertTrue(calls, f"{path.name} が namespaceTbd を呼んでいません")

    def test_refine_normalizes_before_merging_by_id(self):
        """rebuildTbd は ID をキーに統合するので、その前に正規化されていなければ意味が無い。"""
        body = REFINE.read_text(encoding="utf-8")
        ns = body.index("namespaceTbd(documents)")
        merge_call = body.index("rebuildTbd(\n")
        self.assertLess(ns, merge_call, "正規化が rebuildTbd の呼び出しより後ろにあります")

    def test_draft_and_refine_share_the_same_implementation(self):
        for start in DEPS + [FUNC_START]:
            with self.subTest(part=start):
                self.assertEqual(
                    _extract(DRAFT.read_text(encoding="utf-8"), start),
                    _extract(REFINE.read_text(encoding="utf-8"), start),
                    f"{start} が draft.js と refine.js で食い違っています。"
                    "初稿と改稿で TBD の採番規約が変わると、同じ論点が別 ID として扱われます。",
                )


if __name__ == "__main__":
    unittest.main()
