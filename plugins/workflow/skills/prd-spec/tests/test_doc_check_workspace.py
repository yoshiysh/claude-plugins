"""scripts/doc_check.mjs の workspace モード（W を直接読む）のテスト。

文書は W/<kind>-<topic>.md の 1 本を Edit で更新し、変更範囲は版のコピーとの差分ではなく、doc_check が
W/checks/<label>.snapshot.json に書く項目ごとの hash と比べて出す。押さえるのは次のとおり。

1. snapshot → Edit → diff で、変えた項目 ID だけが出る。2 パス目の diff に 1 パス目で監査済みの変更は出ない
2. --expect の digest が違えば（snapshot の items を書き換えた場合も）失敗し、古い diff の結果も残さない
3. audited- のラベルは --role auditor が無ければ保存しない。snapshot の digest と tree-digest は同じ木で一致する
4. doc は曖昧語・開いた TBD の断定・参照先の実在を拾い、複合語や保持規則は拾わない
5. flow は出典の欠落と実在しない出典を拾い、flow.json の内容の sha256 を出す。conflicts は同じ target の組を列挙する
6. stdout には本文を出さず、件数・digest・パスと ID（doc の flow_refs）だけを出す
7. index は保存先の 2 つの INDEX を文書から導出し、開いている TBD だけを未解決に並べる
"""

import hashlib
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


def _put(ws, ledger, body, *args):
    r = subprocess.run(
        ["node", str(DOC_CHECK), "put", "--ledger", ledger, *args, "--workspace", str(ws)],
        input=json.dumps(body, ensure_ascii=False), capture_output=True, text=True,
    )
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
        _put(self.ws, "meta", {"trace": [{"item_id": "PR-AUTH-001", "kind": "input", "quote": "ログインする"}]}, "--doc", "requirements/auth")
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

    def test_stdout_は本文を出さず件数_digest_パス_IDだけ(self):
        out = _ok(self.ws, "snapshot", "--save", "audited-1", "--role", "auditor")
        self.assertEqual(set(out), {"label", "docs", "items", "path", "digest", "stray", "sizes", "size_over"})
        self.assertEqual(set(out["stray"]), {"count", "path"})
        self.assertEqual(set(out["size_over"]), {"count", "path"})
        out = _ok(self.ws, "diff", "--against", "audited-1", "--expect", out["digest"])
        self.assertEqual(set(out), {"changed", "added", "removed", "path", "tree_digest"})
        r = _run(self.ws, "doc")
        doc = json.loads(r.stdout)
        self.assertEqual(set(doc), {"findings", "blocking", "degraded", "not_checked", "path", "digest", "tree_digest", "flow_refs"})
        self.assertNotIn("issue", r.stdout)
        del doc["flow_refs"]
        self.assertNotIn("PR-AUTH", json.dumps(doc))

    def test_docのstdoutは項目ごとにtraceが指すflow要素を出す(self):
        self.assertEqual(_ok(self.ws, "doc")["flow_refs"], {
            "requirements/auth": {"PR-AUTH-002": ["F-002"]},
            "specifications/auth": {"SP-AUTH-001": ["F-001"], "SP-AUTH-002": ["F-003", "F-004", "F-005"]},
        })
        self.assertEqual(_ok(self.ws, "doc", "--doc", "requirements/auth")["flow_refs"], {"requirements/auth": {"PR-AUTH-002": ["F-002"]}})


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

    def test_指摘0件で中身の違うflowはcontent_sha256で区別できる(self):
        before = _ok(self.ws, "flow")
        el = json.loads((self.ws / "flow.json").read_text())["elements"][1]
        _put(self.ws, "flow", {"elements": [{"id": el["id"], "label": el["label"] + "（別の名前）"}]})
        after = _ok(self.ws, "flow")
        self.assertEqual((before["findings"], after["findings"]), (0, 0))
        self.assertEqual(before["digest"], after["digest"])
        self.assertNotEqual(before["content_sha256"], after["content_sha256"])
        self.assertEqual(after["content_sha256"], hashlib.sha256((self.ws / "flow.json").read_bytes()).hexdigest())
        self.assertEqual(after["open"], len(json.loads((self.ws / "open.json").read_text())["open"]))
        self.assertEqual(after["open_ids"], sorted(o["id"] for o in json.loads((self.ws / "open.json").read_text())["open"]))

    def test_出典の欠落と実在しない出典と形の崩れを拾う(self):
        els = json.loads((self.ws / "flow.json").read_text())["elements"]
        els[0]["source"] = None
        els[1]["source"] = {"decision": "D-099"}
        els[2]["source"] = [{"open": "O-001", "input": "結果"}]
        _put(self.ws, "flow", {"elements": els})
        self.assertEqual(_ok(self.ws, "flow")["findings"], 3)
        self.assertEqual(
            _findings(self.ws, "flow.json"),
            ["ST-FLOW-NOSOURCE-F-001", "ST-FLOW-SOURCE-UNKNOWN-F-002-D-099", "ST-FLOW-SOURCE-SHAPE-F-003"],
        )

    def test_resolutions_の_ID_も出典として数える(self):
        el = json.loads((self.ws / "flow.json").read_text())["elements"][1]
        _put(self.ws, "flow", {"elements": [{**el, "source": {"decision": "R-001"}}]})
        _put(self.ws, "resolutions", {"resolutions": [{"id": "R-001"}]})
        self.assertEqual(_ok(self.ws, "flow")["findings"], 0)

    def test_閉包の崩れも拾う(self):
        el = json.loads((self.ws / "flow.json").read_text())["elements"][1]
        _put(self.ws, "flow", {"elements": [{**el, "next": ["F-404"]}]})
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

    def test_constrained_byが挙げた決定と要素を組にする(self):
        # 前回の RS-028: D-010（不可逆な操作）と reset の工程は名前が違い、target の一致では組にならなかった形。
        _put(self.ws, "resolutions", {"resolutions": [{"id": "RS-001"}]})
        _put(self.ws, "flow", {"elements": [{"id": "F-002", "constrained_by": ["D-001"]}, {"id": "F-003", "constrained_by": ["D-003", "RS-001"]}]})
        self.assertEqual(_ok(self.ws, "flow")["findings"], 0)
        out = _ok(self.ws, "conflicts")
        self.assertEqual((out["pairs"], out["flow_pairs"], out["constraint_pairs"]), (4, 1, 2), "target でも組になる D-001|F-002 は重ねない")
        self.assertEqual(len(out["pair_keys"]), len(set(out["pair_keys"])))
        self.assertLessEqual({"pair:D-003|F-003", "pair:F-003|RS-001"}, set(out["pair_keys"]))

    def test_constrained_byの実在しない決定はputが拒否し_後で消えた決定はflowの指摘になる(self):
        before = (self.ws / "flow.json").read_bytes()
        r = subprocess.run(["node", str(DOC_CHECK), "put", "--ledger", "flow", "--workspace", str(self.ws)],
                           input=json.dumps({"elements": [{"id": "F-003", "constrained_by": ["D-099"]}]}), capture_output=True, text=True)
        self.assertEqual(r.returncode, 1)
        self.assertIn("D-099", r.stderr)
        self.assertEqual((self.ws / "flow.json").read_bytes(), before)
        _put(self.ws, "flow", {"elements": [{"id": "F-003", "constrained_by": ["D-003"]}]})
        _ok(self.ws, "del", "--ledger", "decisions", "--ids", "D-003")
        self.assertEqual(_ok(self.ws, "flow")["findings"], 1)
        self.assertEqual(_findings(self.ws, "flow.json"), ["ST-FLOW-CONSTRAINT-UNKNOWN-F-003-D-003"])

    def test_前回と同じ形の経緯の入ったclosureはFLOW_HISTORYになる(self):
        # 2026-09-27 の試走の closure（1,229 字）の最小の再現。put は経緯の印を拒否するので、put 以外で書かれた形を置く。
        flow = json.loads((self.ws / "flow.json").read_text())
        flow["closure"] = ("確かめたこと: 種類は type と 1 対 1 に対応する。 回答の反映（段 3a）: O-011 は回答（RS-011）で行き先が"
                           "決まったので、未決の終端 F-092 を除いた。 回答の反映（段 3a'）: F-014 の失敗の枝を F-029 へ向けた。")
        flow["elements"][1]["label"] = "承認（段 3a で足した）"
        (self.ws / "flow.json").write_text(json.dumps(flow, ensure_ascii=False, indent=1, sort_keys=True) + "\n")
        out = _ok(self.ws, "flow")
        ids = _findings(self.ws, "flow.json")
        self.assertIn("ST-FLOW-HISTORY-closure", ids)
        self.assertIn("ST-FLOW-HISTORY-F-002.label", ids)
        self.assertEqual(out["findings"], 2)

    def _verify(self, *ids):
        sha = lambda ledger: _ok(self.ws, "sha", "--ledger", ledger)["sha256"]
        _put(self.ws, "verifications", {"items": [{"id": i, "verdict": "pass", "reason": "r"} for i in ids]},
             "--expect-resolutions", sha("resolutions"), "--expect-decisions", sha("decisions"))

    def test_出典がopenだけの要素とそのopenの組を出す(self):
        # 前回の F-090・F-091（measured で閉じた O- だけを出典に持つ未決の終端）の形。裁定済みかは script が決める。
        out = _ok(self.ws, "flow")
        self.assertEqual(out["open_only"], [{"el": "F-003", "open": "O-001"}])
        el = json.loads((self.ws / "flow.json").read_text())["elements"][2]
        _put(self.ws, "flow", {"elements": [{**el, "source": [{"open": "O-001"}, {"input": "結果"}]}]})
        self.assertEqual(_ok(self.ws, "flow")["open_only"], [])

    def test_合格した版のままの要素だけがunverifiedから外れる(self):
        self.assertEqual(_ok(self.ws, "flow")["unverified"], ["F-001", "F-002", "F-003", "F-004", "F-005"])
        self._verify("F-001", "F-004")
        self.assertEqual(_ok(self.ws, "flow")["unverified"], ["F-002", "F-003", "F-005"])
        f4 = next(e for e in json.loads((self.ws / "flow.json").read_text())["elements"] if e["id"] == "F-004")
        f4["cases"][1]["source"] = {"open": "O-001"}
        _put(self.ws, "flow", {"elements": [{"id": "F-004", "cases": f4["cases"]}]})
        self.assertEqual(_ok(self.ws, "flow")["unverified"], ["F-002", "F-003", "F-004", "F-005"], "マスの出典を変えた要素は unverified に戻る")

    def test_不合格の要素はunverifiedに残り続ける(self):
        # prd.js はこの要素を検証の対象から除く（tests/test_prd_stages.py の FlowRecheck）。doc_check は pass だけを見る。
        sha = lambda ledger: _ok(self.ws, "sha", "--ledger", ledger)["sha256"]
        _put(self.ws, "verifications", {"items": [{"id": "F-002", "verdict": "fail", "fail_kind": "insufficient_grounds", "reason": "r"}]},
             "--expect-resolutions", sha("resolutions"), "--expect-decisions", sha("decisions"))
        self.assertIn("F-002", _ok(self.ws, "flow")["unverified"])

    def test_caseの出典がopenだけならそのマスもopen_onlyに出す(self):
        f4 = next(e for e in json.loads((self.ws / "flow.json").read_text())["elements"] if e["id"] == "F-004")
        f4["cases"][1]["source"] = [{"open": "O-001"}]
        _put(self.ws, "flow", {"elements": [{"id": "F-004", "cases": f4["cases"]}]})
        self.assertEqual(_ok(self.ws, "flow")["open_only"], [{"el": "F-003", "open": "O-001"}, {"el": "F-004", "case": 2, "open": "O-001"}])
        f4["cases"][1]["source"] = [{"open": "O-001"}, {"input": "通知する"}]
        _put(self.ws, "flow", {"elements": [{"id": "F-004", "cases": f4["cases"]}]})
        self.assertEqual(_ok(self.ws, "flow")["open_only"], [{"el": "F-003", "open": "O-001"}])

    def test_出典の無いcaseと実在しないcaseの出典を拾う(self):
        f4 = next(e for e in json.loads((self.ws / "flow.json").read_text())["elements"] if e["id"] == "F-004")
        f4["cases"][0].pop("source")
        f4["cases"][1]["source"] = {"open": "O-404"}
        _put(self.ws, "flow", {"elements": [{"id": "F-004", "cases": f4["cases"]}]})
        self.assertEqual(_ok(self.ws, "flow")["findings"], 2)
        self.assertEqual(_findings(self.ws, "flow.json"), ["ST-FLOW-CASE-NOSOURCE-F-004-1", "ST-FLOW-SOURCE-UNKNOWN-F-004.case2-O-404"])

    def test_caseの出典の引用もinputに逐語で無ければputが拒否する(self):
        f4 = next(e for e in json.loads((self.ws / "flow.json").read_text())["elements"] if e["id"] == "F-004")
        f4["cases"][1]["source"] = {"input": "依頼文に無い文"}
        before = (self.ws / "flow.json").read_bytes()
        r = subprocess.run(["node", str(DOC_CHECK), "put", "--ledger", "flow", "--workspace", str(self.ws)],
                           input=json.dumps({"elements": [{"id": "F-004", "cases": f4["cases"]}]}, ensure_ascii=False), capture_output=True, text=True)
        self.assertEqual(r.returncode, 1)
        self.assertIn("F-004 cases[1]", r.stderr)
        self.assertEqual((self.ws / "flow.json").read_bytes(), before)

    def test_flowモードは判断の判定表の欠けを拾う(self):
        f4 = next(e for e in json.loads((self.ws / "flow.json").read_text())["elements"] if e["id"] == "F-004")
        _put(self.ws, "flow", {"elements": [{"id": "F-004", "cases": f4["cases"][:1]}]})
        self.assertEqual(_ok(self.ws, "flow")["findings"], 2)
        self.assertEqual(_findings(self.ws, "flow.json"), ["ST-FLOW-BRANCH-UNUSED-F-004-通知する", "ST-FLOW-DT-GAP-F-004-承認=否認"])

    def test_conflictsは組をaboutと同じ形のキーで出す(self):
        self.assertEqual(_ok(self.ws, "conflicts")["pair_keys"], ["pair:D-001|D-002", "pair:D-001|F-002"])

    def test_decisions_が無ければ失敗する(self):
        (self.ws / "decisions.json").unlink()
        self.assertEqual(_run(self.ws, "conflicts").returncode, 1)


@unittest.skipUnless(shutil.which("node"), "node が無い環境ではスキップ")
class TreeFindings(_Workspace):
    """snapshot・tree-digest の所見（stray と分量）。一覧は checks/ に書き、stdout は件数とパスだけにする。"""

    def _plan_docs(self, *keys):
        plan = json.loads((self.ws / "plan.json").read_text())
        plan["docs"] = [{"key": k, "concern": "c", "covers": [], "fixed": False} for k in keys]
        (self.ws / "plan.json").write_text(json.dumps(plan, ensure_ascii=False))

    def _stray(self, *args):
        out = _ok(self.ws, "tree-digest", *args)
        return out["stray"], json.loads((self.ws / out["stray"]["path"]).read_text())["stray"]

    def test_planに無い文書はstrayで_topicに点を含むplanの文書は出ない(self):
        shutil.copy(self.ws / "requirements-auth.md", self.ws / "requirements-auth.v1.md")
        shutil.copy(self.ws / "requirements-auth.meta.json", self.ws / "requirements-auth.v1.meta.json")
        shutil.copy(self.ws / "requirements-auth.md", self.ws / "requirements-auth-v2.md")
        self._plan_docs("requirements/auth", "specifications/auth", "requirements/auth.v1")
        count, listed = self._stray()
        self.assertEqual(listed, ["requirements-auth-v2.md"])
        self.assertEqual(count["count"], 1)

    def test_planから外した文書とそのmetaはstrayになる(self):
        self._plan_docs("requirements/auth")
        self.assertEqual(self._stray()[1], ["specifications-auth.md", "specifications-auth.meta.json"])

    def test_strayが100件でもstdoutは件数とパスだけ(self):
        (self.ws / "tmp" / "resolver__3a").mkdir(parents=True)
        for i in range(100):
            (self.ws / "tmp" / "resolver__3a" / f"gen{i:03}.py").write_text("x")
        r = _run(self.ws, "tree-digest")
        out = json.loads(r.stdout)
        self.assertEqual(out["stray"], {"count": 100, "path": "checks/tree-digest.stray.json"})
        self.assertNotIn("gen0", r.stdout)
        self.assertEqual(len(json.loads((self.ws / "checks" / "tree-digest.stray.json").read_text())["stray"]), 100)

    def test_後のsnapshotは先のsnapshotの一覧を上書きしない(self):
        (self.ws / "tmp" / "x").mkdir(parents=True)
        (self.ws / "tmp" / "x" / "a.py").write_text("x")
        first = _ok(self.ws, "snapshot", "--save", "audited-1", "--role", "auditor")
        (self.ws / "resolutions.pre6.json").write_text("{}")
        second = _ok(self.ws, "snapshot", "--save", "audited-2", "--role", "auditor")
        _ok(self.ws, "tree-digest")
        for out, n, label in ((first, 1, "audited-1"), (second, 2, "audited-2")):
            self.assertEqual(out["stray"]["path"], f"checks/{label}.stray.json")
            self.assertEqual(out["size_over"]["path"], f"checks/{label}.sizes.json")
            listed = json.loads((self.ws / out["stray"]["path"]).read_text())["stray"]
            self.assertEqual((len(listed), out["stray"]["count"]), (n, n))

    def test_planが無ければ止まる(self):
        (self.ws / "plan.json").unlink()
        for mode in (("tree-digest",), ("snapshot", "--save", "x")):
            with self.subTest(mode=mode[0]):
                r = _run(self.ws, *mode)
                self.assertEqual(r.returncode, 1)
                self.assertIn("plan.json", r.stderr)
        self.assertFalse((self.ws / "checks" / "x.snapshot.json").exists())

    def test_SIZE_BUDGETを超えるファイルはSIZE_OVERに出る(self):
        code = f"import {{ SIZE_BUDGET }} from {json.dumps(DOC_CHECK.as_uri())}; console.log(SIZE_BUDGET.document)"
        budget = int(subprocess.run(["node", "--input-type=module", "-e", code], capture_output=True, text=True, check=True).stdout)
        out = _ok(self.ws, "snapshot", "--save", "x")
        self.assertEqual(out["size_over"]["count"], 0)
        self.assertIn("decisions.json", out["sizes"])
        with (self.ws / "requirements-auth.md").open("a") as f:
            f.write("あ" * budget)
        out = _ok(self.ws, "snapshot", "--save", "x")
        self.assertEqual(out["size_over"], {"count": 1, "path": "checks/x.sizes.json"})
        over = json.loads((self.ws / "checks" / "x.sizes.json").read_text())["over"]
        self.assertEqual([o["file"] for o in over], ["requirements-auth.md"])
        self.assertEqual(over[0]["budget"], budget)


@unittest.skipUnless(shutil.which("node"), "node が無い環境ではスキップ")
class Report(_Workspace):
    HOLD = {"rule": "上限の裁定が下るまで、自動承認を設けてはならない", "issue_draft": "## 裁定してほしいこと\n上限を決める。\n\n```\n例\n```", "item_ids": ["PR-AUTH-002"]}

    def _resolutions(self):
        _put(self.ws, "resolutions", {"resolutions": [
            {"id": "RS-001", "ruling": "method", "value": "文書を 1 つにまとめる", "why": "関心事が分かれていない"},
            {"id": "RS-002", "ruling": "hold", "hold": self.HOLD, "upstream_revision": "基盤の要求の PR-BASE-001 に上限を足す"},
            {"id": "RS-003", "ruling": "internal", "value": "F-002 に揃える"},
        ]})

    def test_同じresolutionsから同じバイト列を出す(self):
        self._resolutions()
        out = _ok(self.ws, "report")
        first = (self.ws / "report.md").read_bytes()
        self.assertEqual((out["method"], out["holds"], out["upstream_revisions"]), (1, 1, 1))
        _ok(self.ws, "report")
        self.assertEqual((self.ws / "report.md").read_bytes(), first)
        text = first.decode()
        for part in ("RS-001: 文書を 1 つにまとめる（関心事が分かれていない）", self.HOLD["rule"], "PR-AUTH-002", "````markdown\n## 裁定してほしいこと", "基盤の要求の PR-BASE-001 に上限を足す"):
            self.assertIn(part, text)
        self.assertNotIn("F-002 に揃える", text)

    def test_resolutionsが無くても型どおりに0件を書く(self):
        out = _ok(self.ws, "report")
        self.assertEqual((out["method"], out["holds"], out["upstream_revisions"]), (0, 0, 0))
        self.assertEqual((self.ws / "report.md").read_text().count("0 件。"), 3)


@unittest.skipUnless(shutil.which("node"), "node が無い環境ではスキップ")
class Index(_Workspace):
    def test_2_つの_INDEX_を文書から導出する(self):
        out = _ok(self.ws, "index", "--req-dir", "docs/req")
        self.assertEqual(set(out["indexes"]), {"requirements", "specifications"})
        self.assertEqual(out["indexes"]["requirements"]["save_to"], "docs/req/INDEX.md")
        req = (self.ws / out["indexes"]["requirements"]["path"]).read_text()
        self.assertIn("| PR-AUTH-001 | ログイン | `docs/req/auth.md` |", req)
        self.assertIn("| `docs/req/auth.md` | `docs/specifications/auth.md` |", req)
        self.assertIn("実現する仕様項目が無い要求: 0 件", req)
        spec = (self.ws / out["indexes"]["specifications"]["path"]).read_text()
        self.assertIn("| SP-AUTH-001 |", spec)
        self.assertNotIn("関連する仕様文書", spec)

    def test_未解決には開いている_TBD_だけを並べる(self):
        _ok(self.ws, "index", "--open-tbd", "TBD-RAUTH-002")
        req = (self.ws / "checks" / "INDEX.requirements.md").read_text()
        self.assertIn("TBD-RAUTH-002", req)
        self.assertNotIn("TBD-RAUTH-001", req)
        _ok(self.ws, "index", "--open-tbd", "")
        self.assertIn("着手を止める未確定事項は 0 件", (self.ws / "checks" / "INDEX.requirements.md").read_text())

    def test_同じ文書からは同じ_INDEX_になる(self):
        a = _ok(self.ws, "index")["indexes"]["requirements"]["digest"]
        b = _ok(self.ws, "index")["indexes"]["requirements"]["digest"]
        self.assertEqual(a, b)


if __name__ == "__main__":
    unittest.main()
