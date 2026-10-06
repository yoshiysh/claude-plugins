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
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

SKILL = Path(__file__).resolve().parents[1]
DOC_CHECK = SKILL / "scripts" / "doc_check.mjs"
FIXTURE = Path(__file__).resolve().parent / "fixtures" / "workspace"


def _tx(args):
    """台帳を書くモード（put・del）には段の token を付ける（doc_check は token なしを拒否する）。"""
    return ("--token", "t1") if args and args[0] in ("put", "del") and "--token" not in args else ()


def _run(ws, *args):
    return subprocess.run(["node", str(DOC_CHECK), *args, *_tx(args), "--workspace", str(ws)], capture_output=True, text=True)


# STDOUT_FNV: doc_check が CLI の stdout に付ける digest の欄。中身の照合は test_prd_pure（prd-spec.js が計算し直して合う）が持つので、
# ここでは欄があることだけを確かめて外し、各テストは本体を比べる。
STDOUT_FNV = re.search(r"^const STDOUT_FNV = '(\w+)'$", DOC_CHECK.read_text(encoding="utf-8"), re.M).group(1)


def stdout_body(text):
    out = json.loads(text)
    if isinstance(out, dict):
        assert re.fullmatch(r"[0-9a-f]{8}", str(out.pop(STDOUT_FNV, ""))), f"stdout に {STDOUT_FNV} がありません: {text[:200]}"
    return out


def _ok(ws, *args):
    r = _run(ws, *args)
    if r.returncode != 0:
        raise AssertionError(r.stderr)
    return stdout_body(r.stdout)


def _rulings(ws):
    """doc_check flow --rulings の resolutions を、prd-spec.js が読む行の形（flowCheckOf が束ねを戻したもの）で返す。"""
    from test_prd_pure import value  # test_prd_pure がこの module を import するので、使うときに読む

    r = _run(ws, "flow", "--rulings")
    if r.returncode != 0:
        raise AssertionError(r.stderr)
    got = value(f"flowCheckOf({json.dumps(r.stdout)}, true)")
    assert got is not None, f"prd-spec.js が受け取らない stdout: {r.stdout[:300]}"
    return got["resolutions"]


def _put_run(ws, ledger, body, *args):
    return subprocess.run(
        ["node", str(DOC_CHECK), "put", "--ledger", ledger, *args, *_tx(("put", *args)), "--workspace", str(ws)],
        input=json.dumps(body, ensure_ascii=False), capture_output=True, text=True,
    )


def _put(ws, ledger, body, *args):
    r = _put_run(ws, ledger, body, *args)
    if r.returncode != 0:
        raise AssertionError(r.stderr)
    return stdout_body(r.stdout)


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
        self.assertEqual(set(out), {"label", "docs", "items", "path", "digest", "stray", "size_over"})
        self.assertEqual(set(out["stray"]), {"count", "path"})
        self.assertEqual(set(out["size_over"]), {"count", "path"})
        out = _ok(self.ws, "diff", "--against", "audited-1", "--expect", out["digest"])
        self.assertEqual(set(out), {"changed", "added", "removed", "path", "tree_digest"})
        r = _run(self.ws, "doc")
        doc = stdout_body(r.stdout)
        self.assertEqual(set(doc), {"findings", "blocking", "degraded", "fixed_findings", "not_checked", "path", "digest", "tree_digest", "flow_refs"})
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

    def test_固定の文書の指摘は_blocking_に数えない(self):
        (self.ws / "requirements-base.md").write_text("# base\n\n#### PR-BASE-001 上位\n\nDesign Input を満たさなければならない。\n")
        _put(self.ws, "meta", {"fixed": True}, "--doc", "requirements/base")
        out = _ok(self.ws, "doc")
        self.assertIn("ST-OBSOLETE-requirements/base-designinput", _findings(self.ws))
        self.assertEqual((out["findings"], out["blocking"], out["fixed_findings"]), (5, 4, 1))

    def test_書いている仕様書で直せる_ORPHAN_REQ_は固定の要求文書に付いても数える(self):
        _edit(self.ws, "requirements-auth.md", "#### PR-AUTH-003", "#### PR-AUTH-004 追加\n\nシステムは監査ログを残さなければならない。\n\n#### PR-AUTH-003")
        _put(self.ws, "meta", {"fixed": True}, "--doc", "requirements/auth")
        out = _ok(self.ws, "doc")
        self.assertIn("ST-ORPHAN-REQ-PR-AUTH-004", _findings(self.ws))
        self.assertEqual(out["fixed_findings"], 0)
        self.assertGreaterEqual(out["blocking"], 1)

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
        _put(self.ws, "flow", {"elements": [{**el, "source": {"decision": "RS-001"}}]})
        _put(self.ws, "resolutions", {"resolutions": [{"id": "RS-001"}]})
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
        self.assertEqual(out["self_sourced"], 0)

    def test_出典にもconstrained_byにも挙げたRSとは組にしない(self):
        # run4 の F-045|RS-055: settle が同じ裁定を出典と縛りの両方に入れ、resolver が「矛盾しない」と返すだけの組になった形。
        _put(self.ws, "resolutions", {"resolutions": [{"id": "RS-001"}, {"id": "RS-002"}]})
        _put(self.ws, "flow", {"elements": [{"id": "F-002", "source": [{"decision": "D-001"}, {"decision": "RS-001"}], "constrained_by": ["RS-001"]}]})
        out = _ok(self.ws, "conflicts")
        self.assertNotIn("pair:F-002|RS-001", out["pair_keys"])
        self.assertEqual(out["self_sourced"], 1)
        self.assertEqual(json.loads((self.ws / "checks" / "conflicts.json").read_text())["self_sourced"], [{"a": "RS-001", "b": "F-002"}])
        self.assertEqual(_ok(self.ws, "flow")["pair_keys"], out["pair_keys"], "flow の stdout の組も同じ")
        el = json.loads((self.ws / "flow.json").read_text())["elements"][3]
        cases = [{**el["cases"][0], "source": {"decision": "RS-002"}}, *el["cases"][1:]]
        _put(self.ws, "flow", {"elements": [{"id": "F-004", "cases": cases, "constrained_by": ["RS-002"]}]})
        out = _ok(self.ws, "conflicts")
        self.assertNotIn("pair:F-004|RS-002", out["pair_keys"], "decision の要素は case の出典も見る")
        self.assertEqual(out["self_sourced"], 2)

    def test_constrained_byだけに挙げたRSとは組にする(self):
        _put(self.ws, "resolutions", {"resolutions": [{"id": "RS-001"}]})
        _put(self.ws, "flow", {"elements": [{"id": "F-002", "constrained_by": ["RS-001"]}]})
        out = _ok(self.ws, "conflicts")
        self.assertIn("pair:F-002|RS-001", out["pair_keys"])
        self.assertEqual(out["self_sourced"], 0)

    def _invariant(self, id_="D-004"):
        with (self.ws / "input.md").open("a") as f:
            f.write("\n未コミットの作業を失ってはならない。\n")
        _put(self.ws, "decisions", {"decisions": [{"id": id_, "kind": "invariant", "quote": "未コミットの作業を失ってはならない。", "value": "未コミットの作業を失わない"}]})

    def test_effectの無い工程はFLOW_EFFECT_MISSING(self):
        _put(self.ws, "flow", {"elements": [{"id": "F-002", "effect": None}]})
        self.assertEqual(_ok(self.ws, "flow")["findings"], 1)
        self.assertEqual(_findings(self.ws, "flow.json"), ["ST-FLOW-EFFECT-MISSING-F-002"])

    def test_destructiveの工程はinvariantの決定をconstrained_byに持つ(self):
        # 再試走の F-053（mixed reset）: 名前が「削除」でない破壊的な工程に、縛る決定が無かった形。
        self._invariant()
        _put(self.ws, "flow", {"elements": [{"id": "F-002", "effect": "destructive"}]})
        _ok(self.ws, "flow")
        self.assertEqual(_findings(self.ws, "flow.json"), ["ST-FLOW-DESTRUCTIVE-UNCONSTRAINED-F-002"])
        _put(self.ws, "flow", {"elements": [{"id": "F-002", "next": ["F-404"]}]})
        out = _ok(self.ws, "flow")
        # prd-spec.js は codes で指摘を直し手ごとに分けるので、符号・場所と件数が stdout の中で食い違ってはならない。
        self.assertEqual(out["codes"], {"FLOW_DANGLING": ["F-002"], "FLOW_DESTRUCTIVE_UNCONSTRAINED": ["F-002"], "FLOW_UNREACHABLE": ["F-003", "F-004", "F-005"]})
        self.assertEqual(sum(len(v) for v in out["codes"].values()), out["findings"])
        _put(self.ws, "flow", {"elements": [{"id": "F-002", "next": ["F-004"]}]})
        _put(self.ws, "flow", {"elements": [{"id": "F-002", "constrained_by": ["D-001", "D-002"]}]})
        _ok(self.ws, "flow")
        self.assertEqual(_findings(self.ws, "flow.json"), ["ST-FLOW-DESTRUCTIVE-UNCONSTRAINED-F-002"], "invariant でない決定では縛りにならない")
        _put(self.ws, "flow", {"elements": [{"id": "F-002", "constrained_by": ["D-004"]}]})
        self.assertEqual(_ok(self.ws, "flow")["findings"], 0)
        self.assertIn("pair:D-004|F-002", _ok(self.ws, "conflicts")["pair_keys"])

    def test_破壊的な工程が出典にもconstrained_byにも挙げた不変条件とは組にする(self):
        # 契約「## flow.json の形」の conflicts の項。
        self._invariant()
        _put(self.ws, "flow", {"elements": [{"id": "F-002", "effect": "destructive", "source": {"decision": "D-004"}, "constrained_by": ["D-004"]}]})
        self.assertEqual(_ok(self.ws, "flow")["findings"], 0)
        out = _ok(self.ws, "conflicts")
        self.assertIn("pair:D-004|F-002", out["pair_keys"])
        self.assertEqual(out["self_sourced"], 0)

    def test_constrained_byの実在しない決定はputが拒否し_後で消えた決定はflowの指摘になる(self):
        before = (self.ws / "flow.json").read_bytes()
        r = subprocess.run(["node", str(DOC_CHECK), "put", "--ledger", "flow", *_tx(("put",)), "--workspace", str(self.ws)],
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

    def test_obtainを変えた要素はunverifiedに戻る(self):
        self._verify("F-002")
        self.assertNotIn("F-002", _ok(self.ws, "flow")["unverified"])
        _put(self.ws, "flow", {"elements": [{"id": "F-002", "obtain": "may_fail"}]})
        out = _ok(self.ws, "flow")
        self.assertIn("F-002", out["unverified"])
        self.assertEqual(_findings(self.ws, "flow.json"), ["ST-FLOW-FAIL-UNHANDLED-F-002"])

    def test_on_failの出典はinputかdecisionだけ(self):
        _put(self.ws, "flow", {"elements": [{"id": "F-002", "obtain": "may_fail", "on_fail": {"as": "承認なし", "source": {"open": "O-001"}}}]})
        _ok(self.ws, "flow")
        self.assertIn("ST-FLOW-SOURCE-SHAPE-F-002.on_fail", _findings(self.ws, "flow.json"))
        fix = next(f["fix"] for f in json.loads((self.ws / "checks" / "flow.json").read_text())["findings"] if f["id"] == "ST-FLOW-SOURCE-SHAPE-F-002.on_fail")
        self.assertNotIn('"open"', fix, "直し方が受けない形を勧めない")
        _put(self.ws, "flow", {"elements": [{"id": "F-002", "on_fail": {"as": "承認なし"}}]})
        _ok(self.ws, "flow")
        self.assertIn("ST-FLOW-NOSOURCE-F-002.on_fail", _findings(self.ws, "flow.json"))

    def test_不合格の要素は書き換えるまでfailed_currentに出る(self):
        sha = lambda ledger: _ok(self.ws, "sha", "--ledger", ledger)["sha256"]
        self.assertEqual(_ok(self.ws, "flow")["failed_current"], [])
        _put(self.ws, "verifications", {"items": [{"id": "F-002", "verdict": "fail", "fail_kind": "insufficient_grounds", "reason": "r"}]},
             "--expect-resolutions", sha("resolutions"), "--expect-decisions", sha("decisions"))
        out = _ok(self.ws, "flow")
        self.assertEqual(out["failed_current"], ["F-002"])
        self.assertIn("F-002", out["unverified"])
        _put(self.ws, "flow", {"elements": [{"id": "F-002", "source": {"decision": "D-002"}}]})
        out = _ok(self.ws, "flow")
        self.assertEqual(out["failed_current"], [])
        self.assertIn("F-002", out["unverified"])

    def test_resolutionごとにaboutとrulingと合否をresolutionsに出す(self):
        _put(self.ws, "resolutions", {"resolutions": [
            {"id": "RS-001", "about": {"open": "O-001"}, "ruling": "internal", "value": "v", "why": "w"},
            {"id": "RS-002", "about": {"pair": ["D-001", "F-002"]}, "ruling": "internal", "value": "v", "why": "w"},
            {"id": "RS-003", "about": {"finding": "r1-cd-all-001"}, "ruling": "internal", "value": "v", "why": "w"},
            {"id": "RS-004", "about": {"tbd": "TBD-X-001"}, "ruling": "hold", "hold": {"rule": "r", "issue_draft": "d", "item_ids": []}},
        ]})
        self.assertEqual([x["verdict"] for x in _rulings(self.ws)], [None] * 4)
        self.assertNotIn("resolutions", _ok(self.ws, "flow"), "裁定と合否の一覧は --rulings のときだけ出す")
        sha = lambda ledger: _ok(self.ws, "sha", "--ledger", ledger)["sha256"]
        _put(self.ws, "verifications", {"items": [{"id": "RS-002", "verdict": "pass"}, {"id": "RS-003", "verdict": "fail", "fail_kind": "value_as_method", "reason": "r"},
                                                  {"id": "RS-004", "verdict": "fail", "fail_kind": "insufficient_grounds", "reason": "r"}]},
             "--expect-resolutions", sha("resolutions"), "--expect-decisions", sha("decisions"))
        got = _rulings(self.ws)
        want = [
            {"id": "RS-001", "about": {"open": "O-001"}, "ruling": "internal", "has_answer": False, "verdict": None},
            {"id": "RS-002", "about": {"pair": ["D-001", "F-002"]}, "ruling": "internal", "has_answer": False, "verdict": "pass"},
            {"id": "RS-003", "about": {"finding": "r1-cd-all-001"}, "ruling": "internal", "has_answer": False, "verdict": "fail", "fail_kind": "value_as_method"},
            {"id": "RS-004", "about": {"tbd": "TBD-X-001"}, "ruling": "hold", "has_answer": False, "verdict": "fail", "fail_kind": "insufficient_grounds"},
        ]
        self.assertEqual(got, want)
        # prd-spec.js のテストの stub（test_prd_stages の HARNESS）は同じ世界から同じ行を出す。stub の形がずれると、stub で通る再実行が実物で通らない。
        import test_prd_stages as stages  # test_prd_stages が test_prd_pure 経由でこの module を import するので、ここで読む
        with tempfile.TemporaryDirectory() as tmp:
            world = Path(tmp) / "w.json"
            world.write_text(json.dumps({"flow": "f", "els": {}, "rs": {x["id"]: {"about": x["about"], "ruling": x["ruling"]} for x in want},
                                         "verdicts": {x["id"]: {"verdict": x["verdict"], **({"kind": x["fail_kind"]} if "fail_kind" in x else {})} for x in want if x["verdict"]}}))
            state = {"units": [{"id": "U-1", "docs": ["requirements/x"], "depends_on": []}], "tree_digest": "t"}
            stub = stages.run({"args": stages.args(**{"from": "9", "state": state}), "world": str(world)})
        self.assertEqual(stub["disk"]["resolutions"], want)
        # 合否は検証した版に付く。値を書き換えた裁定は合否を失い、question・hold への書き換え（変換）は合否を持ち越す。
        _put(self.ws, "resolutions", {"resolutions": [{"id": "RS-002", "value": "書き換えた値"},
                                                      {"id": "RS-003", "ruling": "hold", "value": None, "hold": {"rule": "r", "issue_draft": "d", "item_ids": []}}]})
        rewritten = [want[0], {**want[1], "verdict": None}, {**want[2], "ruling": "hold"}, want[3]]
        self.assertEqual(_rulings(self.ws), rewritten)
        with tempfile.TemporaryDirectory() as tmp:
            world = Path(tmp) / "w.json"
            versions = {"RS-002": 1, "RS-003": 1}
            world.write_text(json.dumps({"flow": "f", "els": {}, "rs": {x["id"]: {"about": x["about"], "ruling": x["ruling"], "v": versions.get(x["id"], 0)} for x in rewritten},
                                         "verdicts": {x["id"]: {"verdict": x["verdict"], "v": 0, **({"kind": x["fail_kind"]} if "fail_kind" in x else {})} for x in want if x["verdict"]}}))
            stub = stages.run({"args": stages.args(**{"from": "9", "state": state}), "world": str(world)})
        self.assertEqual(stub["disk"]["resolutions"], rewritten)

    def _verdict(self, rs_id):
        return next(x for x in _rulings(self.ws) if x["id"] == rs_id)["verdict"]

    def _judge(self, items):
        sha = lambda ledger: _ok(self.ws, "sha", "--ledger", ledger)["sha256"]
        _put(self.ws, "verifications", {"items": items}, "--expect-resolutions", sha("resolutions"), "--expect-decisions", sha("decisions"))

    def test_問いの合格を持ち越すのは検証した候補を選んだ回答だけ(self):
        (self.ws / "answers").mkdir()
        (self.ws / "answers" / "g1.md").write_text("RS-005: 画面に出してください\n")
        options = [{"label": "画面", "description": "画面に出す", "flow_effect": "F-003 が画面表示になる", "decision_text": "結果は画面に出す"},
                   {"label": "メール", "description": "メールで送る", "flow_effect": "F-003 がメール送信になる", "decision_text": "結果はメールで送る"}]
        _put(self.ws, "resolutions", {"resolutions": [{"id": "RS-005", "about": {"open": "O-001"}, "ruling": "question", "options": options,
                                                       "question": {"header": "返し方", "text": "結果をどう返しますか", "searched": "依頼文に無い"}}]})
        self._judge([{"id": "RS-005", "verdict": "pass"}])
        _put(self.ws, "resolutions", {"resolutions": [{"id": "RS-005", "value": "結果は画面に出す", "answer": {"path": "answers/g1.md", "quote": "画面に出して"}}]})
        self.assertEqual(self._verdict("RS-005"), "pass", "候補の選択は検証した decision_text を写すだけ")
        _put(self.ws, "resolutions", {"resolutions": [{"id": "RS-005", "value": "結果は画面とメールの両方に出す"}]})
        self.assertIsNone(self._verdict("RS-005"), "候補の外の value は検証していない")
        _put(self.ws, "resolutions", {"resolutions": [{"id": "RS-005", "value": None, "answer": None}]})
        self.assertEqual(self._verdict("RS-005"), "pass")
        _put(self.ws, "resolutions", {"resolutions": [{"id": "RS-005", "options": [{**options[0], "decision_text": "結果は画面に常に出す"}, options[1]]}]})
        self.assertIsNone(self._verdict("RS-005"), "問いの形の修正で変わった候補の文は検証していない")
        _put(self.ws, "resolutions", {"resolutions": [{"id": "RS-006", "about": {"tbd": "TBD-X-001"}, "ruling": "internal", "value": "v", "why": "w"}]})
        self._judge([{"id": "RS-006", "verdict": "fail", "fail_kind": "value_as_method", "reason": "r"}])
        _put(self.ws, "resolutions", {"resolutions": [{"id": "RS-006", "ruling": "question", "value": None, "options": options,
                                                       "question": {"header": "h", "text": "t", "searched": "s"}}]})
        self.assertEqual(self._verdict("RS-006"), "fail", "変換した問いは不合格を持ち越す（変換した分はもう検証しない）")

    def test_answered_byの合格は書き換えると持ち越さない(self):
        # answered_by は値の裁定なので、value を変えたら検証し直す（持ち越すと当てはめ直した値が検証されずに根拠になる）。
        (self.ws / "answers").mkdir()
        (self.ws / "answers" / "g1.md").write_text("RS-001: 画面\n")
        cite = {"file": str(self.ws / "answers" / "g1.md"), "line": 1, "quote": "RS-001: 画面"}
        _put(self.ws, "resolutions", {"resolutions": [{"id": "RS-008", "about": {"tbd": "TBD-X-001"}, "ruling": "answered_by", "value": "画面に出す", "why": "w", "evidence": [cite]}]})
        self._judge([{"id": "RS-008", "verdict": "pass"}])
        self.assertEqual(self._verdict("RS-008"), "pass")
        _put(self.ws, "resolutions", {"resolutions": [{"id": "RS-008", "value": "画面とメールに出す"}]})
        self.assertIsNone(self._verdict("RS-008"))

    def test_回答待ちの問いはanswered_byに変えられない(self):
        # 候補の選択として返されると検証を飛ばして回答済みになる。
        (self.ws / "answers").mkdir()
        (self.ws / "answers" / "g1.md").write_text("RS-001: 画面\n")
        cite = {"file": str(self.ws / "answers" / "g1.md"), "line": 1, "quote": "RS-001: 画面"}
        options = [{"label": "画面", "description": "d", "flow_effect": "e", "decision_text": "画面に出す"}, {"label": "メール", "description": "d", "flow_effect": "e", "decision_text": "メールで送る"}]
        _put(self.ws, "resolutions", {"resolutions": [{"id": "RS-009", "about": {"tbd": "TBD-X-001"}, "ruling": "question", "options": options,
                                                       "question": {"header": "h", "text": "t?", "searched": "s"}}]})
        before = (self.ws / "resolutions.json").read_bytes()
        r = _put_run(self.ws, "resolutions", {"resolutions": [{"id": "RS-009", "ruling": "answered_by", "value": "画面に出す", "evidence": [cite], "question": None, "options": None}]})
        self.assertEqual(r.returncode, 1, r.stderr)
        self.assertIn("回答待ちの問いは answered_by にできません", r.stderr)
        self.assertEqual((self.ws / "resolutions.json").read_bytes(), before)

    def test_保持規則への書き換えは不合格だけを持ち越す(self):
        # hold.rule は保持規則として writer に届く規範文なので、合格の後に書いた rule は検証していない。
        _put(self.ws, "resolutions", {"resolutions": [{"id": "RS-006", "about": {"open": "O-001"}, "ruling": "internal", "value": "v", "why": "w"},
                                                      {"id": "RS-007", "about": {"finding": "r1-cd-all-001"}, "ruling": "internal", "value": "v", "why": "w"}]})
        self._judge([{"id": "RS-006", "verdict": "pass"}, {"id": "RS-007", "verdict": "fail", "fail_kind": "insufficient_grounds", "reason": "r"}])
        held = lambda rule: {"ruling": "hold", "value": None, "hold": {"rule": rule, "issue_draft": "d", "item_ids": []}}
        _put(self.ws, "resolutions", {"resolutions": [{"id": "RS-006", **held("保持規則 A")}, {"id": "RS-007", **held("保持規則 B")}]})
        self.assertIsNone(self._verdict("RS-006"), "合格の後に書いた保持規則は検証していない")
        self.assertEqual(self._verdict("RS-007"), "fail", "変換した不合格はもう検証しない")
        self._judge([{"id": "RS-006", "verdict": "pass"}])
        self.assertEqual(self._verdict("RS-006"), "pass")
        _put(self.ws, "resolutions", {"resolutions": [{"id": "RS-006", **held("保持規則 A を書き換えた")}]})
        self.assertIsNone(self._verdict("RS-006"), "検証した保持規則を書き換えれば合格を失う")

    def test_覆されていない裁定のある論点に別のIDの裁定を足さない(self):
        rs = lambda i, about, **kw: {"id": i, "about": about, "ruling": "internal", "value": "v", "why": "w", **kw}
        _put(self.ws, "resolutions", {"resolutions": [rs("RS-001", {"open": "O-001"}), rs("RS-003", {"pair": ["D-001", "F-002"]})]})
        before = (self.ws / "resolutions.json").read_bytes()
        for dup in (rs("RS-002", {"open": "O-001"}), rs("RS-004", {"pair": ["F-002", "D-001"]})):
            with self.subTest(dup=dup["id"]):
                r = _put_run(self.ws, "resolutions", {"resolutions": [dup]})
                self.assertEqual(r.returncode, 1, r.stderr)
                self.assertIn("同じ論点", r.stderr)
                self.assertEqual((self.ws / "resolutions.json").read_bytes(), before)
        _put(self.ws, "resolutions", {"resolutions": [{"id": "RS-001", "why": "言い直した根拠"}]})
        _put(self.ws, "resolutions", {"resolutions": [rs("RS-002", {"open": "O-001"}, supersedes="RS-001")]})
        r = _put_run(self.ws, "resolutions", {"resolutions": [rs("RS-007", {"open": "O-001"})]})
        self.assertEqual(r.returncode, 1, "覆した RS-002 が今の裁定なので、3 つ目は足せない")
        self.assertIn("RS-002", r.stderr)

    def test_覆された決定を出典かconstrained_byに持つ要素はstale_refsに出る(self):
        self.assertEqual(_ok(self.ws, "flow")["stale_refs"], [])
        _put(self.ws, "resolutions", {"resolutions": [{"id": "RS-001", "ruling": "internal", "value": "v", "supersedes": "D-001"}]})
        out = _ok(self.ws, "flow")
        self.assertEqual(out["stale_refs"], [{"el": "F-002", "ref": "D-001"}, {"el": "F-004", "ref": "D-001"}])
        self.assertEqual(out["findings"], 0, "覆された ID も実在するので出典の検査は通る")
        _put(self.ws, "resolutions", {"resolutions": [{"id": "RS-001", "supersedes": ["D-002"]}]})
        _put(self.ws, "flow", {"elements": [{"id": "F-005", "constrained_by": ["D-002"]}]})
        self.assertEqual(_ok(self.ws, "flow")["stale_refs"], [{"el": "F-005", "ref": "D-002"}])

    def test_caseの出典だけが覆された決定を引く要素もstale_refsに出る(self):
        _put(self.ws, "flow", {"elements": [{"id": "F-002", "source": {"input": "ログイン"}}, {"id": "F-004", "source": {"input": "通知する"}}]})
        _put(self.ws, "resolutions", {"resolutions": [{"id": "RS-001", "ruling": "internal", "value": "v", "supersedes": ["D-001"]}]})
        self.assertEqual(_ok(self.ws, "flow")["stale_refs"], [{"el": "F-004", "ref": "D-001"}])

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
        r = subprocess.run(["node", str(DOC_CHECK), "put", "--ledger", "flow", *_tx(("put",)), "--workspace", str(self.ws)],
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

    def test_flowのstdoutもconflictsと同じ組を出す(self):
        # verifier と flow-check は flow だけを実行する。組を申告した生成者と別に数えるため、同じ組が flow の stdout にも要る。
        self.assertEqual(_ok(self.ws, "flow")["pair_keys"], _ok(self.ws, "conflicts")["pair_keys"])
        _invariant_open(self.ws)
        _put(self.ws, "flow", {"elements": [{"id": "F-002", "effect": "destructive", "constrained_by": ["O-009", "D-002"]}]})
        self.assertEqual(_ok(self.ws, "flow")["pair_keys"], _ok(self.ws, "conflicts")["pair_keys"])

    def test_decisions_が無ければ失敗する(self):
        (self.ws / "decisions.json").unlink()
        self.assertEqual(_run(self.ws, "conflicts").returncode, 1)


INVARIANT_QUOTE = "未コミットの作業を失ってはならない。"


def _sha(ws, ledger):
    return _ok(ws, "sha", "--ledger", ledger)["sha256"]


def _verdict(ws, id_, verdict):
    item = {"id": id_, "verdict": verdict, "reason": "r", "fail_kind": "insufficient_grounds" if verdict == "fail" else None}
    _put(ws, "verifications", {"items": [item]}, "--expect-resolutions", _sha(ws, "resolutions"), "--expect-decisions", _sha(ws, "decisions"))


def _invariant_decision(ws, id_="D-004"):
    with (Path(ws) / "input.md").open("a") as f:
        f.write(f"\n{INVARIANT_QUOTE}\n")
    _put(ws, "decisions", {"decisions": [{"id": id_, "kind": "invariant", "quote": INVARIANT_QUOTE, "value": "未コミットの作業を失わない"}]})


def _invariant_open(ws, id_="O-009"):
    _put(ws, "open", {"open": [{"id": id_, "text": "何を失ってはならないか", "kind": "invariant"}]})


@unittest.skipUnless(shutil.which("node"), "node が無い環境ではスキップ")
class InvariantBinding(_Workspace):
    def _destructive(self, *refs):
        _put(self.ws, "flow", {"elements": [{"id": "F-002", "effect": "destructive", "constrained_by": list(refs)}]})
        out = _ok(self.ws, "flow")
        return out, _findings(self.ws, "flow.json")

    def test_invariantのOを挙げた破壊的な工程は指摘にならずconstraintの行が出てconflictsの組にならない(self):
        _invariant_open(self.ws)
        out, ids = self._destructive("O-009")
        self.assertEqual(ids, [])
        self.assertIn({"el": "F-002", "constraint": "O-009"}, out["open_only"])
        self.assertFalse([k for k in _ok(self.ws, "conflicts")["pair_keys"] if "O-009" in k])

    def test_OをinvariantのRSに差し替えると行が消え指摘も無い(self):
        _invariant_open(self.ws)
        self._destructive("O-009")
        _put(self.ws, "resolutions", {"resolutions": [{"id": "RS-009", "about": {"open": "O-009"}, "ruling": "internal", "value": "未 push の commit を失わない", "why": "w", "kind": "invariant"}]})
        out, ids = self._destructive("RS-009")
        self.assertEqual(ids, [])
        self.assertFalse([x for x in out["open_only"] if "constraint" in x])
        self.assertIn("pair:F-002|RS-009", _ok(self.ws, "conflicts")["pair_keys"])
        _put(self.ws, "resolutions", {"resolutions": [{"id": "RS-010", "about": {"open": "O-001"}, "ruling": "internal", "value": "v", "why": "w"}]})
        self.assertEqual(self._destructive("RS-010")[1], ["ST-FLOW-DESTRUCTIVE-UNCONSTRAINED-F-002"], "invariant でない RS では縛りにならない")

    def test_覆された不変条件はstale_refsに出て縛りの指摘にならず_invariantのRSに差し替えれば消える(self):
        _invariant_decision(self.ws)
        self._destructive("D-004")
        _put(self.ws, "resolutions", {"resolutions": [{"id": "RS-001", "ruling": "internal", "value": "v", "why": "w", "supersedes": "D-004"}]})
        out, ids = self._destructive("D-004")
        self.assertEqual(ids, [], "verifier の flow の検査で段を止めず、settle に直させる")
        self.assertEqual(out["stale_refs"], [{"el": "F-002", "ref": "D-004"}])
        self.assertEqual(self._destructive("RS-001")[1], ["ST-FLOW-DESTRUCTIVE-UNCONSTRAINED-F-002"], "覆した RS が invariant でなければ縛りにならない")
        _put(self.ws, "resolutions", {"resolutions": [{"id": "RS-001", "kind": "invariant"}]})
        out, ids = self._destructive("RS-001")
        self.assertEqual((ids, out["stale_refs"]), ([], []))

    def _stale(self, mutate):
        flow = json.loads((self.ws / "flow.json").read_text())
        mutate({e["id"]: e for e in flow["elements"]})
        (self.ws / "flow.json").write_text(json.dumps(flow, ensure_ascii=False, indent=1, sort_keys=True) + "\n")

    def test_型の持てない欄や旧い欄を残したflowはどのコマンドも読まずにnullのputで消せる(self):
        cases = (
            ("型の持てない欄", lambda els: els["F-004"].update(effect="destructive"), {"id": "F-004", "effect": None}, "decision では effect を持てません"),
            ("型の外の欄", lambda els: els["F-002"].update(aggregates=["F-004"]), {"id": "F-002", "aggregates": None}, "aggregates は elements の欄ではありません"),
        )
        for name, mutate, fix, message in cases:
            with self.subTest(name):
                self._stale(mutate)
                for r in (_run(self.ws, "flow"), _run(self.ws, "conflicts"), _put_run(self.ws, "flow", {"elements": [{"id": "F-001", "label": "l"}]})):
                    self.assertNotEqual(r.returncode, 0)
                    self.assertIn(message, r.stderr)
                _put(self.ws, "flow", {"elements": [fix]})
                _ok(self.ws, "flow")

    def test_inputsの旧いキーを残したflowは読まずinputsを送り直せば消える(self):
        self._stale(lambda els: els["F-004"]["inputs"][0].update(branch_map={"a": "b"}))
        r = _run(self.ws, "flow")
        self.assertIn("inputs: branch_map は inputs の欄ではありません", r.stderr)
        flow = json.loads((self.ws / "flow.json").read_text())
        inputs = next(e for e in flow["elements"] if e["id"] == "F-004")["inputs"]
        r = _put_run(self.ws, "flow", {"elements": [{"id": "F-004", "inputs": inputs}]})
        self.assertIn("branch_map は inputs の欄ではありません", r.stderr, "put も inputs のキーを見る")
        _put(self.ws, "flow", {"elements": [{"id": "F-004", "inputs": [{k: v for k, v in i.items() if k != "branch_map"} for i in inputs]}]})
        _ok(self.ws, "flow")

    def test_検証に落ちた不変条件はstale_refsに出る(self):
        _invariant_decision(self.ws)
        self._destructive("D-004")
        _verdict(self.ws, "D-004", "fail")
        out, ids = self._destructive("D-004")
        self.assertEqual((ids, out["stale_refs"]), ([], [{"el": "F-002", "ref": "D-004"}]))
        _verdict(self.ws, "D-004", "pass")
        self.assertEqual(self._destructive("D-004")[0]["stale_refs"], [])


def _aspect_keys():
    text = (SKILL / "references" / "domain-analysis.md").read_text(encoding="utf-8")
    sec = text[text.index("\n## 2. "):text.index("\n## 3. ")]
    return re.findall(r"^\d+\. `([a-z_]+)`", sec, re.M)


@unittest.skipUnless(shutil.which("node"), "node が無い環境ではスキップ")
class PlanCheck(_Workspace):
    def _plan(self, domain):
        plan = json.loads((self.ws / "plan.json").read_text())
        (self.ws / "plan.json").write_text(json.dumps({**plan, "domain": domain}, ensure_ascii=False))
        out = _ok(self.ws, "plan")
        self.assertEqual(out["path"], "checks/plan.json")
        return sorted(_findings(self.ws, "plan.json"))

    def _all(self, **verdicts):
        return [{"aspect": k, **verdicts.get(k, {"verdict": "非該当", "decision": "D-003"})} for k in _aspect_keys()]

    def test_観点がすべてそろえば0件(self):
        self.assertEqual(len(_aspect_keys()), 10)
        self.assertEqual(self._plan(self._all()), [])

    def test_キーの欠け_重複_閉集合の外を拾う(self):
        keys = _aspect_keys()
        domain = self._all()[1:] + [self._all()[2], {"aspect": "不可逆な操作", "verdict": "非該当", "decision": "D-003"}]
        self.assertEqual(self._plan(domain), sorted([f"ST-PLAN-ASPECT-MISSING-{keys[0]}", f"ST-PLAN-ASPECT-DUP-{keys[2]}", "ST-PLAN-ASPECT-UNKNOWN-不可逆な操作"]))

    def test_verdictの外と根拠のIDの欠けを拾う(self):
        keys = _aspect_keys()
        domain = self._all(**{keys[0]: {"verdict": "たぶん"}, keys[1]: {"verdict": "不明", "open": "O-404"}, keys[2]: {"verdict": "該当", "decision": "D-404"}, keys[3]: {"verdict": "不明", "open": "O-001"}})
        self.assertEqual(self._plan(domain), sorted([f"ST-PLAN-VERDICT-{keys[0]}", f"ST-PLAN-REF-{keys[1]}", f"ST-PLAN-REF-{keys[2]}"]))

    def test_irreversibleが該当なら生きている不変条件の決定か未決が要る(self):
        domain = self._all(irreversible={"verdict": "該当", "decision": "D-003"})
        self.assertEqual(self._plan(domain), ["ST-PLAN-INVARIANT-MISSING-irreversible"])
        _invariant_decision(self.ws)
        self.assertEqual(self._plan(domain), [])
        _verdict(self.ws, "D-004", "fail")
        self.assertEqual(self._plan(domain), ["ST-PLAN-INVARIANT-MISSING-irreversible"], "検証に落ちた不変条件は数えない")
        _invariant_open(self.ws)
        self.assertEqual(self._plan(domain), [])

    def test_観点のキーはdomain_analysisにだけある(self):
        src = DOC_CHECK.read_text(encoding="utf-8")
        self.assertIn("irreversible", _aspect_keys())
        for key in (k for k in _aspect_keys() if k != "irreversible"):
            self.assertNotIn(f"'{key}'", src)
        for p in [SKILL / "schemas" / "agent-contracts.md", *SKILL.glob("agents/*.md")]:
            for key in (k for k in _aspect_keys() if k != "irreversible"):
                self.assertNotIn(f"`{key}`", p.read_text(encoding="utf-8"), p.name)


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
        self.assertIn("decisions.json", json.loads((self.ws / "checks" / "x.sizes.json").read_text())["sizes"])
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
        self.assertEqual((out["method"], out["answered_by"], out["holds"], out["drafts"], out["upstream_revisions"]), (0, 0, 0, 0, 0))
        self.assertEqual((self.ws / "report.md").read_text().count("0 件。"), 5)

    def test_既にある回答を別の論点に当てた裁定は依頼者に見せる(self):
        # answered_by は依頼者の回答を依頼者の知らない論点に広げる。事後報告に出さないと、依頼者は覆す機会を持てない。
        (self.ws / "answers").mkdir()
        (self.ws / "answers" / "g1.md").write_text("RS-001: 画面\n")
        cite = {"file": str(self.ws / "answers" / "g1.md"), "line": 1, "quote": "RS-001: 画面"}
        _put(self.ws, "resolutions", {"resolutions": [{"id": "RS-004", "ruling": "answered_by", "value": "通知も画面に出す", "why": "RS-001 の回答", "evidence": [cite]}]})
        out = _ok(self.ws, "report")
        self.assertEqual(out["answered_by"], 1)
        section = (self.ws / "report.md").read_text().split("## 既にある回答の当てはめ")[1].split("## ")[0]
        self.assertIn("- RS-004: 通知も画面に出す（RS-001 の回答。回答: answers/g1.md#L1「RS-001: 画面」）", section)

    def test_draftsに挙げたholdは本文に未反映の節に分ける(self):
        self._resolutions()
        out = _ok(self.ws, "report", "--drafts", "RS-002")
        self.assertEqual((out["holds"], out["drafts"]), (0, 1))
        text = (self.ws / "report.md").read_text()
        reflected, drafts = text.split("## 保持規則の文案（本文に未反映）")
        self.assertNotIn("RS-002", reflected)
        self.assertIn("### RS-002", drafts.split("## 上位文書の改訂の文案")[0])
        self.assertEqual(_ok(self.ws, "report", "--drafts", "")["holds"], 1)

    def test_draftsにholdでないIDがあれば何も書かない(self):
        self._resolutions()
        r = _run(self.ws, "report", "--drafts", "RS-003")
        self.assertNotEqual(r.returncode, 0)
        self.assertFalse((self.ws / "report.md").exists())


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

    def _rows(self, kind):
        out = _ok(self.ws, "index", "--req-dir", "docs/requirements")
        text = (self.ws / out["indexes"][kind]["path"]).read_text()
        return text.split("## 文書一覧")[1].split("\n## ")[0]

    def test_文書一覧は本文の見出し1と項目を含む節とIDの範囲を出す(self):
        rows = self._rows("requirements")
        self.assertIn("| パス | 扱う関心事 | どういう要求が書かれているか |", rows)
        self.assertIn("| `docs/requirements/auth.md` | 認証の要求 | 要求一覧（PR-AUTH-001〜003／3 件） |", rows)
        spec = self._rows("specifications")
        self.assertIn("| パス | 扱う関心事 | どういう仕様項目が書かれているか |", spec)
        self.assertIn("| `docs/specifications/auth.md` | 認証の仕様 | 仕様項目（SP-AUTH-001〜002／2 件） |", spec)

    def test_文書一覧の行はplanのconcernで変わらない(self):
        before = self._rows("requirements")
        plan = self.ws / "plan.json"
        plan.write_text(plan.read_text().replace('"concern": "認証と承認"', '"concern": "固定の入力"'))
        after = self._rows("requirements")
        self.assertEqual(after, before)
        self.assertNotIn("固定の入力", after)

    def test_振られていない番号を001から数えて欠番に出す(self):
        _edit(self.ws, "requirements-auth.md", "#### PR-AUTH-001 ログイン", "#### PR-AUTH-004 ログイン")
        self.assertIn("要求一覧（PR-AUTH-001〜004、欠番は 001／3 件）", self._rows("requirements"))

    def test_節の見出しは項目を含むものだけを並べ見出しの区切りと混ざらない(self):
        _edit(self.ws, "requirements-auth.md", "## 要求一覧\n", "## 背景\n\n説明。\n\n## 要求一覧\n\n### 入口・認証\n")
        _edit(self.ws, "requirements-auth.md", "#### PR-AUTH-003 通知", "### 通知\n\n#### PR-AUTH-003 通知")
        rows = self._rows("requirements")
        self.assertIn("| 入口・認証／通知（PR-AUTH-001〜003／3 件） |", rows)
        self.assertNotIn("背景", rows)

    def test_欠番は先頭の10件まで並べ残りは件数で示す(self):
        _edit(self.ws, "requirements-auth.md", "#### PR-AUTH-003 通知", "#### PR-AUTH-20260101 通知")
        rows = self._rows("requirements")
        self.assertIn("PR-AUTH-00000001〜20260101、欠番は 00000003・00000004・00000005・00000006・00000007・00000008・00000009・00000010・00000011・00000012 ほか 20260088 件／3 件", rows)

    def test_節に入っていない項目は節なしとして並べる(self):
        _edit(self.ws, "requirements-auth.md", "#### PR-AUTH-003 通知", "### 通知 ###\n\n#### PR-AUTH-003 通知")
        self.assertIn("要求一覧／通知（PR-AUTH-001〜003／3 件）", self._rows("requirements"))
        _edit(self.ws, "requirements-auth.md", "## 要求一覧\n", "")
        self.assertIn("| （節なし）／通知（PR-AUTH-001〜003／3 件） |", self._rows("requirements"))

    def test_見出し1が無い文書は無いことを出す(self):
        _edit(self.ws, "requirements-auth.md", "# 認証の要求\n", "")
        self.assertIn("| `docs/requirements/auth.md` | （見出し 1 なし） |", self._rows("requirements"))

    def test_同じ文書からは同じ_INDEX_になる(self):
        a = _ok(self.ws, "index")["indexes"]["requirements"]["digest"]
        b = _ok(self.ws, "index")["indexes"]["requirements"]["digest"]
        self.assertEqual(a, b)


if __name__ == "__main__":
    unittest.main()
