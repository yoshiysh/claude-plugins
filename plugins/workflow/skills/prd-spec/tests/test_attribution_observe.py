"""attributionObserve（帰属の観測）の契約テスト。LLM 不関与・node 単体実行で決定的。

押さえる契約:
1. matched: 原本に実在する quote（正規化後）を持つ追加項目は matched
2. unattributed: 原本に無い quote は unattributed（捏造の観測点）
3. no_trace / too_short / kind_escape(recorded_only) の分類と exposure の定義
4. added の母集団 = 申告 ∪ ID 差分の和集合（申告を省略しても差分側で母集団に入る）
5. 複数 trace エントリは 1 件でも一致すれば matched
6. decision（オブジェクト原本）は文字列値の再帰収集で照合される（JSON エスケープに壊されない）
"""

import json
import subprocess
import unittest
from pathlib import Path

REFINE = (Path(__file__).resolve().parent.parent / "scripts" / "refine.js").read_text()


def _extract_function(source: str) -> str:
    lines = source.split("\n")
    s = next(i for i, l in enumerate(lines) if l.startswith("function attributionObserve"))
    e = next(i for i in range(s + 1, len(lines)) if lines[i] == "}")
    return "\n".join(lines[s : e + 1])


def run_gate(payload: dict) -> dict:
    js = (
        _extract_function(REFINE)
        + f"\nconsole.log(JSON.stringify(attributionObserve({json.dumps(payload, ensure_ascii=False)})))"
    )
    out = subprocess.run(["node", "-e", js], capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout)


LONG = "この上限金額の裁定が下るまで金額を伴う自動処理を新しい画面へ拡大してはならない"
ORIGINS = {
    "input": f"依頼文です。{LONG}。以上。",
    "answers": "",
    "tbd_answers": "",
    "decision": [{"id": "D-001", "value": 'テスト "引用符" を含む決定文。恒久化先はスキルのファイルとする規約である'}],
    "domain": [],
}


def item(i):
    return {"id": i}


class TestAttributionObserve(unittest.TestCase):
    def test_原本に実在するquoteはmatched(self):
        r = run_gate({
            "prev_ids": ["R-001"], "next_items": [item("R-001"), item("R-002")],
            "declared_added_ids": ["R-002"],
            "trace": [{"item_id": "R-002", "kind": "input", "quote": LONG}],
            "origins": ORIGINS,
        })
        self.assertEqual(r["counters"]["matched"], 1)
        self.assertEqual(r["counters"]["exposure"], 0)

    def test_原本に無いquoteはunattributed(self):
        r = run_gate({
            "prev_ids": [], "next_items": [item("R-010")], "declared_added_ids": ["R-010"],
            "trace": [{"item_id": "R-010", "kind": "input",
                       "quote": "業界標準に従い監査ログを 7 年間保持しなければならないという要求がある"}],
            "origins": ORIGINS,
        })
        self.assertEqual(r["counters"]["unattributed"], 1)
        self.assertEqual(r["counters"]["exposure"], 1)

    def test_申告を省略してもID差分で母集団に入る(self):
        r = run_gate({
            "prev_ids": ["R-001"], "next_items": [item("R-001"), item("R-003")],
            "declared_added_ids": [],  # writer が申告を省略
            "trace": [], "origins": ORIGINS,
        })
        self.assertEqual(r["counters"]["added_total"], 1)
        self.assertEqual(r["counters"]["no_trace"], 1)

    def test_premise申告は照合を回避するがkind_escapeに別掲される(self):
        r = run_gate({
            "prev_ids": [], "next_items": [item("R-020")], "declared_added_ids": ["R-020"],
            "trace": [{"item_id": "R-020", "kind": "premise", "quote": "存在しない前提文をここに書いても照合されない"}],
            "origins": ORIGINS,
        })
        self.assertEqual(r["counters"]["kind_escape"], 1)
        self.assertEqual(r["counters"]["exposure"], 0)  # 合否でなく別掲（観測で追う）

    def test_premise併記による遮蔽はshieldedで別掲される(self):
        r = run_gate({
            "prev_ids": [], "next_items": [item("R-025")], "declared_added_ids": ["R-025"],
            "trace": [
                {"item_id": "R-025", "kind": "premise", "quote": "前提由来と申告"},
                {"item_id": "R-025", "kind": "input", "quote": "原本に存在しない捏造の引用文をここに書いている状況"},
            ],
            "origins": ORIGINS,
        })
        self.assertEqual(r["counters"]["kind_escape"], 1)
        self.assertEqual(r["counters"]["kind_escape_shielded"], 1)
        self.assertEqual(r["counters"]["exposure"], 0)  # 分類は変えず、遮蔽の事実を別掲

    def test_短いquoteはtoo_short(self):
        r = run_gate({
            "prev_ids": [], "next_items": [item("R-030")], "declared_added_ids": ["R-030"],
            "trace": [{"item_id": "R-030", "kind": "input", "quote": "以上。"}],
            "origins": ORIGINS,
        })
        self.assertEqual(r["counters"]["too_short"], 1)
        self.assertEqual(r["counters"]["exposure"], 1)

    def test_複数エントリは1件一致でmatched(self):
        r = run_gate({
            "prev_ids": [], "next_items": [item("R-040")], "declared_added_ids": ["R-040"],
            "trace": [
                {"item_id": "R-040", "kind": "input", "quote": "原本に無い方の引用文がこちらに入っている場合の挙動"},
                {"item_id": "R-040", "kind": "input", "quote": LONG},
            ],
            "origins": ORIGINS,
        })
        self.assertEqual(r["counters"]["matched"], 1)

    def test_decisionのオブジェクト原本は文字列値の収集で照合される(self):
        r = run_gate({
            "prev_ids": [], "next_items": [item("R-050")], "declared_added_ids": ["R-050"],
            "trace": [{"item_id": "R-050", "kind": "decision",
                       "quote": 'テスト "引用符" を含む決定文。恒久化先はスキルのファイルとする規約である'}],
            "origins": ORIGINS,
        })
        self.assertEqual(r["counters"]["matched"], 1)

    def test_空白ゆれはmatchedのまま_行跨ぎ連結では一致しない(self):
        spaced = LONG[:20] + "　 \n" + LONG[20:]  # 正当な空白ゆれ
        r = run_gate({
            "prev_ids": [], "next_items": [item("R-060")], "declared_added_ids": ["R-060"],
            "trace": [{"item_id": "R-060", "kind": "input", "quote": spaced}],
            "origins": {**ORIGINS, "input": f"前段。{LONG[:20]} {LONG[20:]}。後段。"},
        })
        self.assertEqual(r["counters"]["matched"], 1)
        # 原本側で別々の行にある 2 断片を連結した quote は一致しない（空白は削除でなく単一空白化）
        r2 = run_gate({
            "prev_ids": [], "next_items": [item("R-061")], "declared_added_ids": ["R-061"],
            "trace": [{"item_id": "R-061", "kind": "input", "quote": "一行目の終わり二行目の頭を密着させた引用のつもり"}],
            "origins": {**ORIGINS, "input": "一行目の終わり\n二行目の頭を密着させた引用のつもり"},
        })
        self.assertEqual(r2["counters"]["unattributed"], 1)


if __name__ == "__main__":
    unittest.main()
