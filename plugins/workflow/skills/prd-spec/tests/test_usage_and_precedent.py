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
