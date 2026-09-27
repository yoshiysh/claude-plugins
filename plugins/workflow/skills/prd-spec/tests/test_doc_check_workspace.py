"""scripts/doc_check.mjs の workspace モード（W を直接読む）のテスト。

文書は W/<kind>-<topic>.md の 1 本を Edit で更新し、変更範囲は版のコピーとの差分ではなく、doc_check が
W/checks/<label>.snapshot.json に書く項目ごとの hash と比べて出す。押さえるのは次のとおり。

1. snapshot → Edit → diff で、変えた項目 ID だけが出る。2 パス目の diff に 1 パス目で監査済みの変更は出ない
2. --expect の digest が違えば（snapshot の items を書き換えた場合も）失敗し、古い diff の結果も残さない
3. audited- のラベルは --role auditor が無ければ保存しない。snapshot の digest と tree-digest は同じ木で一致する
4. doc は曖昧語・開いた TBD の断定・参照先の実在を拾い、複合語や保持規則は拾わない
5. flow は出典の欠落と実在しない出典を拾い、conflicts は同じ target の組を列挙する
6. stdout には件数・digest・パスだけを出す
"""

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

SKILL = Path(__file__).resolve().parents[1]
DOC_CHECK = SKILL / "scripts" / "doc_check.mjs"
FIXTURE = Path(__file__).resolve().parent / "fixtures" / "workspace"


def _run(ws, *args):
    return subprocess.run(["node", str(DOC_CHECK), *args, "--workspace", str(ws)], capture_output=True, text=True)


def _ok(ws, *args):
    r = _run(ws, *args)
    if r.returncode != 0:
        raise AssertionError(r.stderr)
    return json.loads(r.stdout)


def _edit(ws, name, old, new):
    p = Path(ws) / name
    text = p.read_text()
    assert old in text, old
    p.write_text(text.replace(old, new, 1))


def _findings(ws, name="doc.json"):
    return [f["id"] for f in json.loads((Path(ws) / "checks" / name).read_text())["findings"]]


class _Workspace(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.ws = Path(self._tmp.name) / "W"
        shutil.copytree(FIXTURE, self.ws)

    def tearDown(self):
        self._tmp.cleanup()


@unittest.skipUnless(shutil.which("node"), "node が無い環境ではスキップ")
class SnapshotAndDiff(_Workspace):
    def _save(self, label):
        return _ok(self.ws, "snapshot", "--save", label, "--role", "auditor")["digest"]

    def _diff(self, label, digest):
        out = _ok(self.ws, "diff", "--against", label, "--expect", digest)
        body = json.loads((self.ws / out["path"]).read_text())
        return out, body

    def test_変えた項目_ID_だけが出る(self):
        d1 = self._save("audited-1")
        _edit(self.ws, "requirements-auth.md", "3 秒まで待たされてもよい", "3 秒以内に応答を受けなければならない")
        out, body = self._diff("audited-1", d1)
        self.assertEqual((body["changed"], body["added"], body["removed"]), (["PR-AUTH-001"], [], []))
        self.assertEqual((out["changed"], out["added"], out["removed"]), (1, 0, 0))
        self.assertEqual(body["by_doc"], {"requirements/auth": {"changed": ["PR-AUTH-001"], "added": [], "removed": []}})

    def test_2_パス目の_diff_に_1_パス目の監査済み変更は出ない(self):
        d1 = self._save("audited-1")
        _edit(self.ws, "requirements-auth.md", "3 秒まで待たされてもよい", "3 秒以内に応答を受けなければならない")
        _, first = self._diff("audited-1", d1)
        self.assertEqual(first["changed"], ["PR-AUTH-001"])
        d2 = self._save("audited-2")
        _edit(self.ws, "specifications-auth.md", "応答を返さなければならない", "応答を 1 回だけ返さなければならない")
        _, second = self._diff("audited-2", d2)
        self.assertEqual((second["changed"], second["added"], second["removed"]), (["SP-AUTH-001"], [], []))
        # 基準を取り直さなければ、1 パス目の変更も出る（比べる相手が違うことの対照）
        _, stale = self._diff("audited-1", d1)
        self.assertEqual(stale["changed"], ["PR-AUTH-001", "SP-AUTH-001"])

    def test_expect_の_digest_が違えば失敗し_diff_を残さない(self):
        d1 = self._save("audited-1")
        self._diff("audited-1", d1)
        self.assertTrue((self.ws / "checks" / "diff-audited-1.json").exists())
        r = _run(self.ws, "diff", "--against", "audited-1", "--expect", "0" * 64)
        self.assertEqual(r.returncode, 3, r.stderr)
        self.assertEqual(r.stdout, "")
        self.assertFalse((self.ws / "checks" / "diff-audited-1.json").exists())

    def test_items_を書き換えた_snapshot_は記録の_digest_を渡しても失敗する(self):
        d1 = self._save("audited-1")
        p = self.ws / "checks" / "audited-1.snapshot.json"
        snap = json.loads(p.read_text())
        snap["docs"]["requirements/auth"]["items"]["PR-AUTH-001"] = "0" * 64
        p.write_text(json.dumps(snap))
        self.assertEqual(_run(self.ws, "diff", "--against", "audited-1", "--expect", d1).returncode, 3)

    def test_trace_だけの変更と項目の追加と削除も出る(self):
        d1 = self._save("audited-1")
        meta = json.loads((self.ws / "requirements-auth.meta.json").read_text())
        meta["trace"][0]["quote"] = "ログインする"
        (self.ws / "requirements-auth.meta.json").write_text(json.dumps(meta, ensure_ascii=False))
        _edit(self.ws, "requirements-auth.md", "#### PR-AUTH-003 通知", "#### PR-AUTH-004 監査\n\nシステムは監査ログを記録しなければならない。\n\n#### PR-AUTH-003 通知")
        _edit(self.ws, "specifications-auth.md", "#### SP-AUTH-002 承認処理\n\nPR-AUTH-002 と PR-AUTH-009 を実現する。\n", "")
        _, body = self._diff("audited-1", d1)
        self.assertEqual(body["changed"], ["PR-AUTH-001", "specifications/auth§(meta)"])
        self.assertEqual(body["added"], ["PR-AUTH-004"])
        self.assertEqual(body["removed"], ["SP-AUTH-002"])

    def test_変更が無ければ空で_tree_digest_は保存時と同じ(self):
        d1 = self._save("audited-1")
        out, body = self._diff("audited-1", d1)
        self.assertEqual((body["changed"], body["added"], body["removed"]), ([], [], []))
        self.assertEqual(out["tree_digest"], d1)

    def test_snapshot_の_digest_は同じ木の_tree_digest_と一致する(self):
        tree = _ok(self.ws, "tree-digest")
        self.assertEqual(self._save("audited-1"), tree["digest"])
        self.assertEqual(_ok(self.ws, "snapshot", "--save", "writer-pre")["digest"], tree["digest"])
        snap = json.loads((self.ws / "checks" / "audited-1.snapshot.json").read_text())
        one = _ok(self.ws, "tree-digest", "--doc", "requirements/auth")
        self.assertEqual(snap["docs"]["requirements/auth"]["digest"], one["digest"])
        self.assertNotEqual(one["digest"], tree["digest"])

    def test_audited_のラベルは_role_auditor_が無ければ保存しない(self):
        r = _run(self.ws, "snapshot", "--save", "audited-1")
        self.assertEqual(r.returncode, 1)
        self.assertFalse((self.ws / "checks" / "audited-1.snapshot.json").exists())
        self.assertEqual(_run(self.ws, "diff", "--against", "audited-1", "--expect", "x").returncode, 1)

    def test_stdout_は件数と_digest_とパスだけ(self):
        out = _ok(self.ws, "snapshot", "--save", "audited-1", "--role", "auditor")
        self.assertEqual(set(out), {"label", "docs", "items", "path", "digest"})
        out = _ok(self.ws, "diff", "--against", "audited-1", "--expect", out["digest"])
        self.assertEqual(set(out), {"changed", "added", "removed", "path", "tree_digest"})
        r = _run(self.ws, "doc")
        self.assertEqual(set(json.loads(r.stdout)), {"findings", "blocking", "degraded", "not_checked", "path", "digest", "tree_digest"})
        self.assertNotIn("issue", r.stdout)
        self.assertNotIn("PR-AUTH", r.stdout)


@unittest.skipUnless(shutil.which("node"), "node が無い環境ではスキップ")
class DocChecks(_Workspace):
    def test_既定の_fixture_で拾うものと拾わないもの(self):
        out = _ok(self.ws, "doc")
        ids = _findings(self.ws)
        self.assertEqual(
            sorted(ids),
            sorted([
                "ST-AMBIGUOUS-requirements/auth-PR-AUTH-001-まで",
                "ST-TBD-ASSERT-requirements/auth-TBD-RAUTH-001-PR-AUTH-002",
                "ST-TBD-ASSERT-requirements/auth-TBD-RAUTH-002-PR-AUTH-003",
                "ST-REF-UNDEFINED-specifications/auth-PR-AUTH-009",
            ]),
        )
        self.assertEqual((out["findings"], out["blocking"]), (4, 4))
        body = json.loads((self.ws / "checks" / "doc.json").read_text())
        self.assertEqual(body["open_tbd"], {"source": "meta", "ids": ["TBD-RAUTH-001", "TBD-RAUTH-002"]})
        self.assertEqual(body["documents"][0]["ids"], ["PR-AUTH-001", "PR-AUTH-002", "PR-AUTH-003"])

    def test_曖昧語は複合語と数量に付かない_まで_を拾わない(self):
        _edit(self.ws, "requirements-auth.md", "システムは同等の結果を返さなければならない。",
              "システムは等しい値と平等な順序を返さなければならない。システムは適切にログを残さなければならない。ログは 30 日程度保存しなければならない。")
        _ok(self.ws, "doc")
        amb = sorted(i for i in _findings(self.ws) if i.startswith("ST-AMBIGUOUS-"))
        self.assertEqual(amb, [f"ST-AMBIGUOUS-requirements/auth-PR-AUTH-001-{w}" for w in ("まで", "程度", "適切")])

    def test_解消済みの_TBD_は_open_tbd_で外れる(self):
        _ok(self.ws, "doc", "--open-tbd", "TBD-RAUTH-001")
        ids = _findings(self.ws)
        self.assertIn("ST-TBD-ASSERT-requirements/auth-TBD-RAUTH-001-PR-AUTH-002", ids)
        self.assertFalse(any("TBD-RAUTH-002" in i for i in ids))

    def test_保持規則と名詞止めは断定として拾わない(self):
        _edit(self.ws, "requirements-auth.md", "承認された操作は pdca が実行しなければならない（TBD-RAUTH-001）。", "実行主体は TBD-RAUTH-001 を参照。")
        _ok(self.ws, "doc")
        self.assertFalse(any("TBD-RAUTH-001" in i for i in _findings(self.ws)))

    def test_判定表の宣言外の値は同じ値が何行あっても_1_件(self):
        table = "\n".join([
            "## 判定",
            "",
            "> 条件の値: 呼び手 = 司令塔 / 人間",
            "",
            "| 条件: 呼び手 | 結果 |",
            "|---|---|",
            "| 司令塔 | 承認を求めない |",
            "| 機械 | 承認を求める |",
            "| 機械 | 承認を求める |",
            "| 機械 | 承認を求める |",
            "| 上記以外 | 承認を求める |",
            "",
        ])
        _edit(self.ws, "specifications-auth.md", "## トレーサビリティ表", table + "\n## トレーサビリティ表")
        _ok(self.ws, "doc")
        self.assertEqual([i for i in _findings(self.ws) if i.startswith("ST-DT-VALUE-")], ["ST-DT-VALUE-specifications/auth-判定-呼び手-機械"])

    def test_doc_を指定するとその文書の指摘だけを別のファイルに書く(self):
        out = _ok(self.ws, "doc", "--doc", "specifications/auth")
        self.assertEqual(out["path"], "checks/doc.specifications__auth.json")
        self.assertEqual(_findings(self.ws, "doc.specifications__auth.json"), ["ST-REF-UNDEFINED-specifications/auth-PR-AUTH-009"])
        self.assertEqual(_run(self.ws, "doc", "--doc", "specifications/none").returncode, 1)

    def test_要求文書が無ければ要求_ID_の参照は検査しない(self):
        (self.ws / "requirements-auth.md").unlink()
        (self.ws / "requirements-auth.meta.json").unlink()
        _ok(self.ws, "doc")
        self.assertFalse(any(i.startswith("ST-REF-UNDEFINED-") for i in _findings(self.ws)))

    def test_meta_が無ければ根拠は未検査として返す(self):
        (self.ws / "specifications-auth.meta.json").unlink()
        _ok(self.ws, "doc")
        body = json.loads((self.ws / "checks" / "doc.json").read_text())
        self.assertIn("ST-NOTCHECKED-TRACE-specifications/auth", [n["id"] for n in body["not_checked"]])

    def test_壊れた_meta_は非ゼロで終わる(self):
        (self.ws / "requirements-auth.meta.json").write_text("{")
        r = _run(self.ws, "doc")
        self.assertEqual(r.returncode, 1)
        self.assertIn("requirements-auth.meta.json", r.stderr)


@unittest.skipUnless(shutil.which("node"), "node が無い環境ではスキップ")
class FlowAndConflicts(_Workspace):
    def test_出典の揃った流れは指摘なし(self):
        self.assertEqual(_ok(self.ws, "flow")["findings"], 0)

    def test_出典の欠落と実在しない出典と形の崩れを拾う(self):
        flow = json.loads((self.ws / "flow.json").read_text())
        del flow["elements"][0]["source"]
        flow["elements"][1]["source"] = {"decision": "D-099"}
        flow["elements"][2]["source"] = [{"open": "O-001", "input": "結果"}]
        (self.ws / "flow.json").write_text(json.dumps(flow, ensure_ascii=False))
        self.assertEqual(_ok(self.ws, "flow")["findings"], 3)
        self.assertEqual(
            _findings(self.ws, "flow.json"),
            ["ST-FLOW-NOSOURCE-F-001", "ST-FLOW-SOURCE-UNKNOWN-F-002-D-099", "ST-FLOW-SOURCE-SHAPE-F-003"],
        )

    def test_resolutions_の_ID_も出典として数える(self):
        flow = json.loads((self.ws / "flow.json").read_text())
        flow["elements"][1]["source"] = {"decision": "R-001"}
        (self.ws / "flow.json").write_text(json.dumps(flow, ensure_ascii=False))
        (self.ws / "resolutions.json").write_text(json.dumps({"resolutions": [{"id": "R-001"}]}))
        self.assertEqual(_ok(self.ws, "flow")["findings"], 0)

    def test_閉包の崩れも拾う(self):
        flow = json.loads((self.ws / "flow.json").read_text())
        flow["elements"][1]["next"] = ["F-404"]
        (self.ws / "flow.json").write_text(json.dumps(flow, ensure_ascii=False))
        _ok(self.ws, "flow")
        self.assertIn("ST-FLOW-DANGLING-F-002-F-404", _findings(self.ws, "flow.json"))

    def test_同じ_target_を持つ組を列挙し_target_の無い決定を宣言する(self):
        out = _ok(self.ws, "conflicts")
        self.assertEqual((out["pairs"], out["decision_pairs"], out["flow_pairs"], out["untargeted"]), (2, 1, 1, 1))
        body = json.loads((self.ws / "checks" / "conflicts.json").read_text())
        self.assertEqual(
            body["pairs"],
            [
                {"kind": "decision-decision", "a": "D-001", "b": "D-002", "targets": ["承認の主体"]},
                {"kind": "decision-flow", "a": "D-001", "b": "F-002", "targets": ["F-002"]},
            ],
        )
        self.assertEqual(body["untargeted"], ["D-003"])

    def test_decisions_が無ければ失敗する(self):
        (self.ws / "decisions.json").unlink()
        self.assertEqual(_run(self.ws, "conflicts").returncode, 1)


if __name__ == "__main__":
    unittest.main()
