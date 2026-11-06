import re
from pathlib import Path
OUT = Path(__file__).resolve().parent
ROOT = OUT.parents[2]
res = []
ag = (ROOT / "AGENTS.md").read_text(encoding="utf-8")
flat = re.sub(r"\n\s*", "", ag)
for q in ["途中で止めず完了まで実行する。人間ゲート（マージ・公開）以外では止めない。", "検証は決定的テスト + 生成者と別の fresh 監査 +PR レビュー（人間）が持つ", "（観点を分けるかは差分の大きさと種類で呼び出し側が決め、分けるときは検証役を観点ごとに立てる）", "公開前にはそこを設計レビューで見る", "からも呼ばれる。", "は編集のたびに `make test` を実行する。", "- 検証は単一視点にしない。", "- 解決は常に根本原因の除去を目指す。", "- fan-out する workflow は agent ごとにモデルと effort を明示指定する。", "コード・テスト・文書の変更では [ガイドライン](docs/guidelines/README.md) を参照する。"]:
    res.append(("AGENTS.md: 書き換える既存の文が実在する", q[:40], "ある" if q in flat else "無い", "改行と行頭の空白を除いた部分文字列"))
ans = (OUT.parent / "design-review-1" / "answers.txt").read_text(encoding="utf-8")
ids = re.findall(r"^([DQVWXYZ]\d+|AA\d+|BB\d+) ", ans, re.M)
dm = (OUT / "decisions-map.tsv").read_text(encoding="utf-8")
mapped = set(re.findall(r"^([DQVWXYZ]\d+|AA\d+|BB\d+) ", dm, re.M))
for i in ids:
    res.append(("decisions-map: 利用者の決定が載っている", i, "ある" if i in mapped else "無い", "answers.txt の行頭の ID と map の行頭の ID"))
nxt = sum(1 for l in dm.splitlines()[1:] if l.endswith("次の PR（運用）"))
res.append(("decisions-map: 次の PR（運用）に回した決定の数", "decisions-map.tsv", str(nxt), "note の列"))
src = (OUT / "gen_v7.py").read_text(encoding="utf-8")
for k in ("A1", "B1", "B2", "C1", "STOP", "FAN"):
    t = re.search(rf'^{k} = "(.*)"$', src, re.M).group(1)
    res.append(("足す文の句点の数", k, str(t.count("。")), "C1 は 1 文の決定"))
s = ag.splitlines()
fs = next(i for i, l in enumerate(s) if l.startswith("- fan-out する workflow"))
fe = next(i for i in range(fs + 1, len(s)) if s[i].startswith("- "))
est = len(s) + 4 - (fe - fs - 1) - 2
res.append(("AGENTS.md の行数の見込み", "AGENTS.md", f"main {len(s)} + 足す 4 行 − fan-out {fe - fs} 行を 1 行に − hook の 2 行 = 約 {est} 行（足す句は既存の行に入るものとして数えた）", "現行の行数から差分を数える"))
for p in ["docs/guidelines/review-lenses.md", "tests/review-lenses-agents.test.mjs", ".claude/agents/severity-assigner.md", ".claude/agents/decision-verifier.md"]:
    res.append(("create の対象がまだ無い", p, "無い" if not (ROOT / p).exists() else "既にある", "パスの有無"))
for p in [".codex/hooks.json", "REVIEW.md", "docs/guidelines/README.md", ".claude/agents/diff-verifier.md", "../" * 0 + ".work/agents-md/design-v6/rules.tsv", ".work/agents-md/flow-model-4/Flow.tla", ".work/agents-md/design-v5/main-lines.tsv"]:
    res.append(("指す対象が実在する", p, "実在する" if (ROOT / p).exists() else "実在しない", "パスの有無"))
(OUT / "selfcheck.tsv").write_text("check\ttarget\tresult\tmethod\n" + "".join("\t".join(x) + "\n" for x in res), encoding="utf-8")
print(len(res))
