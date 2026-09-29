"""usage.py（ランの費用と時間の集計）と precedent.py（先例の入口）のテスト。

usage.py は母集団の定義を持つ。定義が揺れるとラン同士を比べられないので、除外の 2 種（空の transcript・
別の案件）がそれぞれ効くこと、除いたものが理由付きで出ること、同じ message id を 1 ターンに数えることを
押さえる。precedent.py は、W 自身を先例に入れないこと、旧いランの変換で検証結果を作らないことを押さえる。
"""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import precedent  # noqa: E402
import usage  # noqa: E402


def _line(ts, mid=None, usage_=None, text=""):
    d = {"type": "assistant" if usage_ else "user", "timestamp": ts, "message": {"content": text}}
    if usage_:
        d["message"].update({"id": mid, "model": "opus", "usage": usage_})
    return json.dumps(d, ensure_ascii=False)


U = {"input_tokens": 1, "cache_creation_input_tokens": 100, "cache_read_input_tokens": 1000, "output_tokens": 10}


class Usage(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        root = Path(self._tmp.name)
        self.ws = root / "W"
        (self.ws / "findings").mkdir(parents=True)
        self.tr = root / "tr"
        self.tr.mkdir()
        ws = str(self.ws)
        (self.tr / "agent-a.jsonl").write_text(
            "\n".join(
                [
                    _line("2026-01-01T00:00:00Z", text=f"Read {ws}/input.md"),
                    _line("2026-01-01T00:00:10Z", "m1", U),
                    _line("2026-01-01T00:00:10Z", "m1", {**U, "output_tokens": 30}),
                    _line("2026-01-01T00:01:00Z", "m2", U),
                ]
            )
        )
        (self.tr / "agent-b.jsonl").write_text(
            "\n".join([_line("2026-01-01T00:00:30Z", text=f"{ws}/flow.json"), _line("2026-01-01T00:02:00Z", "m3", U)])
        )
        (self.tr / "agent-other.jsonl").write_text(
            "\n".join([_line("2026-01-01T00:00:00Z", text="/elsewhere/W2/input.md"), _line("2026-01-01T00:00:05Z", "m9", U)])
        )
        (self.tr / "agent-empty.jsonl").write_text(_line("2026-01-01T00:00:00Z", text=f"{ws}/input.md"))
        (self.ws / "findings" / "r1-im-requirements__a.json").write_text(
            json.dumps({"findings": [{"doc": "d", "item_id": "PR-A-1", "blocking": True}, {"doc": "d", "item_id": "PR-A-1", "blocking": False}]})
        )
        (self.ws / "findings" / "r1-gr-requirements__a.json").write_text(json.dumps({"findings": [{"doc": "d", "item_id": "PR-A-2", "blocking": True}]}))

    def tearDown(self):
        self._tmp.cleanup()

    def test_母集団は空の_transcript_と別の案件を理由付きで除く(self):
        s = usage.summarize(str(self.ws), [str(self.tr)])
        self.assertEqual(s["agents"], 2)
        self.assertEqual(
            sorted((e["file"], e["reason"]) for e in s["excluded"]),
            [("agent-empty.jsonl", "empty"), ("agent-other.jsonl", "other_case")],
        )

    def test_同じ_message_id_は_1_ターンに数え欄ごとに最大値を取る(self):
        s = usage.summarize(str(self.ws), [str(self.tr)])
        a = next(r for r in s["per_agent"] if r["file"] == "agent-a.jsonl")
        self.assertEqual(a["turns"], 2)
        self.assertEqual(a["output"], 40)
        self.assertEqual(a["first_turn_input"], 1101)
        self.assertEqual(s["total"]["input_all"], 3 * 1101)

    def test_busy_seconds_は区間の和集合で待ちを数えない(self):
        s = usage.summarize(str(self.ws), [str(self.tr)])
        # a: 0〜60 秒、b: 30〜120 秒 → 和集合は 0〜120 秒
        self.assertEqual(s["busy_seconds"], 120.0)
        self.assertEqual(s["span_seconds"], 120.0)

    def test_指摘は周回ごとに件数と項目の数を出す(self):
        s = usage.summarize(str(self.ws), [str(self.tr)])
        self.assertEqual(s["findings"], {"r1": {"findings": 3, "blocking": 2, "items": 2}})


def _split(i, read, c5, c1, out, total=None):
    u = {"input_tokens": i, "cache_read_input_tokens": read, "cache_creation_input_tokens": c5 + c1 if total is None else total, "output_tokens": out}
    if c5 is not None:
        u["cache_creation"] = {"ephemeral_5m_input_tokens": c5, "ephemeral_1h_input_tokens": c1}
    return u


class UsageCache(unittest.TestCase):
    """prompt cache の実測（R16）: agent・run ごとの行、cache_creation の 5 分・1 時間の内訳、最初のターン、請求の重み。

    倍率はテスト用の合成の値（2・3・7）で、実際の料金表の値ではない（料金は試走の時点に司令塔が公式の表から渡す）。
    """

    W = (2.0, 3.0, 7.0)

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        root = Path(self._tmp.name)
        self.ws = root / "W"
        self.ws.mkdir()
        ws = str(self.ws)
        self.tr = root / "subagents"
        runs = {"wf_run1": [("a1", "resolver:3", "2026-01-01T00:00:00Z", [_split(2, 0, 60000, 0, 5), _split(1, 60000, 500, 0, 7)])],
                "wf_run2": [("b1", "resolver:3a", "2026-01-01T01:00:00Z", [_split(2, 40000, 20000, 100, 3)]),
                            ("b2", "verifier:3av", "2026-01-01T01:00:05Z", [_split(2, 0, None, None, 4, total=900), _split(1, 900, 30, 20, 1, total=80)])]}
        for run, agents in runs.items():
            d = self.tr / "workflows" / run
            d.mkdir(parents=True)
            for aid, label, ts, turns in agents:
                lines = [_line(ts, text=f"Read {ws}/input.md")] + [_line(ts, f"{aid}-m{i}", u) for i, u in enumerate(turns)]
                (d / f"agent-{aid}.jsonl").write_text("\n".join(lines))
                (d / f"agent-{aid}.meta.json").write_text(json.dumps({"description": label}))
        (self.tr / "agent-solo.jsonl").write_text("\n".join([_line("2026-01-01T02:00:00Z", text=ws), _line("2026-01-01T02:00:01Z", "s1", _split(1, 0, 0, 10, 1))]))

    def tearDown(self):
        self._tmp.cleanup()

    def _agent(self, s, label):
        return next(r for r in s["per_agent"] if r["label"] == label)

    def test_agent_ごとに_label_と_run_と_5分_1時間の内訳を出す(self):
        s = usage.summarize(str(self.ws), [str(self.tr)])
        a = self._agent(s, "resolver:3")
        self.assertEqual((a["run"], a["cache_creation"], a["cache_creation_5m"], a["cache_creation_1h"], a["cache_creation_unsplit"]), ("wf_run1", 60500, 60500, 0, 0))
        solo = next(r for r in s["per_agent"] if r["file"] == "agent-solo.jsonl")
        self.assertEqual((solo["label"], solo["run"], solo["cache_creation_1h"]), (None, None, 10), "meta も wf_ の親も無い transcript は null で数える")

    def test_最初のターンを同じ欄で分ける(self):
        s = usage.summarize(str(self.ws), [str(self.tr)])
        self.assertEqual(self._agent(s, "resolver:3")["first_turn"], {"input": 2, "cache_read": 0, "cache_creation": 60000, "cache_creation_5m": 60000, "cache_creation_1h": 0, "cache_creation_unsplit": 0, "output": 5})
        self.assertEqual(self._agent(s, "resolver:3a")["first_turn"]["cache_read"], 40000)

    def test_内訳が無いか足りない分は_unsplit_に出し_5分にも_1時間にも寄せない(self):
        s = usage.summarize(str(self.ws), [str(self.tr)])
        v = self._agent(s, "verifier:3av")
        self.assertEqual(v["first_turn"]["cache_creation_unsplit"], 900)
        self.assertEqual((v["cache_creation"], v["cache_creation_5m"], v["cache_creation_1h"], v["cache_creation_unsplit"]), (980, 30, 20, 930))
        t = s["total"]
        self.assertEqual(t["cache_creation"], t["cache_creation_5m"] + t["cache_creation_1h"] + t["cache_creation_unsplit"])

    def test_run_ごとの合計と最初の_agent(self):
        s = usage.summarize(str(self.ws), [str(self.tr)])
        self.assertEqual([r["run"] for r in s["per_run"]], ["wf_run1", "wf_run2", None], "最初の行の時刻の順")
        r2 = s["per_run"][1]
        self.assertEqual((r2["agents"], r2["turns"], r2["cache_read"], r2["cache_creation_5m"], r2["cache_creation_1h"]), (2, 3, 40900, 20030, 120))
        self.assertEqual((r2["first_agent"]["label"], r2["first_agent"]["first_turn"]["cache_creation_1h"]), ("resolver:3a", 100))
        self.assertEqual(sum(r["cache_read"] for r in s["per_run"]), s["total"]["cache_read"])

    def test_倍率を渡さなければ重みの欄を出さない(self):
        s = usage.summarize(str(self.ws), [str(self.tr)])
        self.assertNotIn("weighted_input", s["total"])
        self.assertNotIn("weights", s)
        self.assertFalse([r for r in s["per_agent"] + s["per_run"] if "weighted_input" in r])

    def test_倍率を渡すと通常の入力に換算し_unsplit_があれば_null(self):
        s = usage.summarize(str(self.ws), [str(self.tr)], self.W)
        a = self._agent(s, "resolver:3")
        self.assertEqual(a["weighted_input"], 3 + 60000 * 2.0 + 60500 * 3.0)
        self.assertEqual(a["first_turn"]["weighted_input"], 2 + 60000 * 3.0)
        self.assertEqual(self._agent(s, "resolver:3a")["weighted_input"], 2 + 40000 * 2.0 + 20000 * 3.0 + 100 * 7.0)
        self.assertIsNone(self._agent(s, "verifier:3av")["weighted_input"])
        self.assertIsNone(s["per_run"][1]["weighted_input"])
        self.assertEqual(s["per_run"][1]["first_agent"]["first_turn"]["weighted_input"], 2 + 40000 * 2.0 + 20000 * 3.0 + 100 * 7.0)
        self.assertIsNone(s["total"]["weighted_input"])

    def test_CLI_は_run_と_agent_の行を出し倍率の形を検査する(self):
        import contextlib
        import io
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            usage.main(["--workspace", str(self.ws), str(self.tr)])
        out = buf.getvalue()
        self.assertIn("run wf_run2  agents 2", out)
        self.assertIn("first_agent resolver:3a", out)
        self.assertIn("agent wf_run1 resolver:3 ", out)
        for bad in ("2,3", "a,b,c", "2,-1,3"):
            with self.subTest(bad=bad), self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
                usage.main(["--workspace", str(self.ws), "--weights", bad, str(self.tr)])


class Precedent(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(os.path.realpath(self._tmp.name))

    def tearDown(self):
        self._tmp.cleanup()

    def test_list_は_root_と_W_が別の_symlink_越しに来ても_W_を除く(self):
        real = self.root / "real" / "workspace"
        (real / "W").mkdir(parents=True)
        (real / "W" / "decisions.json").write_text("{}")
        (real / "case-a").mkdir()
        (real / "case-a" / "decisions.json").write_text("{}")
        (self.root / "link").symlink_to(self.root / "real")
        for root, ws in ((self.root / "link" / "workspace", real / "W"), (real, self.root / "link" / "workspace" / "W")):
            with self.subTest(root=str(root)):
                paths = precedent.list_precedents(str(root), str(ws))
                self.assertEqual(paths, [str(real / "case-a" / "decisions.json")], "今回のランの決定を先例として読むと、自分の決定を自分で追認する")

    def test_list_は_W_自身を除いて規則どおり全部並べる(self):
        for d in ("case-a", "case-b/sub", "W"):
            (self.root / d).mkdir(parents=True)
        (self.root / "case-a" / "decisions.json").write_text("{}")
        (self.root / "case-a" / "verifications.json").write_text("{}")
        (self.root / "case-b" / "sub" / "decisions.json").write_text("{}")
        (self.root / "W" / "decisions.json").write_text("{}")
        (self.root / "case-a" / "answers.md").write_text("回答")
        paths = precedent.list_precedents(str(self.root), str(self.root / "W"))
        rel = [str(Path(p).relative_to(self.root)) for p in paths]
        self.assertEqual(rel, ["case-a/decisions.json", "case-a/verifications.json", "case-b/sub/decisions.json"])

    def test_convert_は決定と回答を写し検証結果を作らない(self):
        src = self.root / "argsB1.json"
        answers = "TBD-X-001: 上限は 3 回（D-053）\n逐語のまま"
        src.write_text(json.dumps({"decisions": [{"id": "D-001", "value": "v", "source": "default"}], "tbd_answers": answers, "answers": ""}, ensure_ascii=False))
        out = self.root / "legacy" / "run1"
        r = precedent.convert(str(src), str(out))
        self.assertEqual(r["decisions"], 1)
        body = json.loads((out / "decisions.json").read_text())
        self.assertTrue(body["legacy"])
        self.assertEqual(body["decisions"], [{"id": "D-001", "value": "v", "source": "default"}])
        self.assertIn(answers, (out / "answers.md").read_text())
        self.assertFalse((out / "verifications.json").exists())
        (self.root / "W").mkdir()
        rel = [str(Path(p).relative_to(self.root)) for p in precedent.list_precedents(str(self.root), str(self.root / "W"))]
        self.assertEqual(rel, ["legacy/run1/answers.md", "legacy/run1/decisions.json"])

    def test_convert_は_decisions_の無い入力を止める(self):
        src = self.root / "x.json"
        src.write_text(json.dumps({"answers": "a"}))
        with self.assertRaises(ValueError):
            precedent.convert(str(src), str(self.root / "o"))


if __name__ == "__main__":
    unittest.main()
