import re
from pathlib import Path

OUT = Path(__file__).resolve().parent
ROOT = OUT.parents[2]
TABLE = OUT.parent / "flow-model-3" / "table.tsv"
res = []


def add(c, t, r, m):
    res.append((c, t, r, m))


def read(n):
    ls = (OUT / n).read_text(encoding="utf-8").splitlines()
    h = ls[0].split("\t")
    return [dict(zip(h, l.split("\t"))) for l in ls[1:]]


rules, files, refs, agents = read("rules.tsv"), read("files.tsv"), read("refs.tsv"), read("agents.tsv")

# rules <-> table
tk = {}
for i, l in enumerate(TABLE.read_text(encoding="utf-8").splitlines()[1:], start=2):
    c = l.split("\t")
    tk[i] = (c[0], c[1], c[2])
used = set()
for r in rules:
    segs = re.findall(r"L(\d+) ([^/]+)", r["model_transition"])
    if not segs:
        add("rules: 模型の外と書かれている", r["rule"][:24], "書かれている" if r["model_transition"].startswith("模型の外") else "どちらでもない", "先頭の文字列")
    for n, body in segs:
        n = int(n)
        used.add(n)
        st, ev, gd = tk.get(n, ("?",) * 3)
        add("rules: model_transition が table.tsv の行と逐語で一致", f"L{n} {r['rule'][:20]}", "一致" if body.strip().startswith(f"{st}・{ev}・{gd}") else f"不一致（{st}・{ev}・{gd}）", "L の後が state・event・guard で始まるか")
for n in tk:
    add("table: 行が rules.tsv に現れる", f"L{n} {tk[n][1]}", "現れる" if n in used else "現れない", "L 番号の集合")

# WF ids sequential and workflow gist covers
ids = sorted({m for r in rules for m in re.findall(r"^WF-(\d+)", r["rule"])})
add("rules: WF の番号", "rules.tsv", ",".join(ids), "rule の先頭の WF-nn")

# actors
names = {a["agent"].split("（")[0] for a in agents}
allowed = {"builder", "orch", "reviewer", "sevagent", "human", "bot", "script", "-", "make", "test"} | names
for r in rules:
    bad = [t for t in re.findall(r"[a-z][a-z\-]+", re.sub(r"（[^）]*）", "", r["actor"])) if t not in allowed]
    add("rules: actor が担い手の集合にある", r["rule"][:24], "ある" if not bad else "無い: " + ",".join(bad), "英字の語の照合")

# existing AGENTS.md text the design quotes for rewriting
ag = (ROOT / "AGENTS.md").read_text(encoding="utf-8")
flat = re.sub(r"\n\s*", "", ag)
quotes = [
    "途中で止めず完了まで実行する。人間ゲート（マージ・公開）以外では止めない。",
    "検証は決定的テスト + 生成者と別の fresh 監査 +PR レビュー（人間）が持つ",
    "（観点を分けるかは差分の大きさと種類で呼び出し側が決め、分けるときは検証役を観点ごとに立てる）",
    "`.codex/hooks.json` の PostToolUse hook（matcher `Edit|Write|MultiEdit`）からも呼ばれる。",
    "`.codex/hooks.json` の PostToolUse hook（matcher `Edit|Write|MultiEdit`）は編集のたびに `make test` を実行する。",
    "- 検証は単一視点にしない。",
    "- 同じ値・列挙・上限を 2 箇所に書かない。",
    "- 解決は常に根本原因の除去を目指す。",
    "- fan-out する workflow は agent ごとにモデルと effort を明示指定する。",
    "コード・テスト・文書の変更では [ガイドライン](docs/guidelines/README.md) を参照する。",
]
for q in quotes:
    add("AGENTS.md: 書き換える既存の文が実在する", q[:40], "ある" if q.replace("\n", "") in flat else "無い", "改行と行頭の空白を除いた本文の部分文字列")
s = ag.splitlines()
fan_start = next(i for i, l in enumerate(s) if l.startswith("- fan-out する workflow"))
fan_end = next(i for i in range(fan_start + 1, len(s)) if s[i].startswith("- "))
fan = fan_end - fan_start
est = len(s) + 3 + 1 - (fan - 1) - 2 - 2
add("AGENTS.md の行数の見込み", "AGENTS.md", f"main {len(s)} 行 + 抜粋 3 + 止まってよい場所の行の折り返しの増分 1 − fan-out の {fan} 行を 1 行に（−{fan - 1}）− hook の 2 行とその後の空行 2 = 約 {est} 行", "現行の行数から差分を数える（足す句は既存の行の折り返しで吸収できない分を各 0〜1 行と見て、止まってよい場所だけ 1 と数えた）")

# content_gist refs
pat = re.compile(r"(?<![A-Za-z§])[DQVXYZ]\d+\b|(?<![A-Za-z])W\d+\b|\.work/|AA\d")
n = sum(len(pat.findall(f["content_gist"])) for f in files)
add("files: content_gist の作業用の参照の件数", "files.tsv", str(n), pat.pattern)

# refs
fp = [f["path"] for f in files]
for r in refs:
    if r["referrer"].startswith("検索語"):
        continue
    m = re.match(r"(.+):(\d+)$", r["referrer"])
    ok = (ROOT / m.group(1)).is_file() and len((ROOT / m.group(1)).read_text(encoding="utf-8").splitlines()) >= int(m.group(2))
    add("refs: referrer が実在する", r["referrer"], "実在する" if ok else "実在しない", "ファイルと行数")
    nt = r["new_target"]
    if not (nt.startswith("変更なし") or nt.startswith("消える")):
        p = re.split(r"[「（:]", nt, maxsplit=1)[0].strip()
        add("refs: new_target が files.tsv にある", r["referrer"] + " → " + p, "ある" if p in fp else "無い", "先頭のパスの照合")

# files
for f in files:
    p = f["path"]
    if p.startswith("（"):
        continue
    if f["action"] == "create":
        add("files: create の対象がまだ無い", p, "無い" if not (ROOT / p).exists() else "既にある", "パスの有無")
    else:
        add("files: modify・delete の対象が実在する", p, "実在する" if (ROOT / p).exists() else "実在しない", "パスの有無")

# headings
BP = ROOT / "plugins/skill-creator/skills/skill-creator-best-practices/references/best-practices.md"
for p, hs in {BP: ["model と effort は役割ごとに組で選ぶ", "体数は測れる値から段階的に決める（作るスキル向けの設計指針）"], ROOT / "REVIEW.md": ["重大度", "観点"]}.items():
    t = p.read_text(encoding="utf-8")
    for h in hs:
        add("名指す見出しが完全一致で実在する", h, "ある" if re.search(r"^#{1,6}\s+" + re.escape(h) + r"\s*$", t, re.M) else "無い", "見出しの完全一致")
rv = (ROOT / "REVIEW.md").read_text(encoding="utf-8")
for q in ["同じ値・列挙・上限が 2 箇所に書かれていないか", "単一視点だけの検証になっていないか"]:
    add("REVIEW.md: 書き換える文が実在する", q, "ある" if q in rv else "無い", "部分文字列")
cr = (ROOT / ".github/workflows/claude_review.yml").read_text(encoding="utf-8")
add("bot の発火条件", "claude_review.yml", "opened・reopened・ready_for_review" if "types: [opened, reopened, ready_for_review]" in cr else "違う", "types の行")

# excerpts
src = (OUT / "gen_v6.py").read_text(encoding="utf-8")
ga = next(f for f in files if f["path"] == "AGENTS.md")["content_gist"]
for k in ("EXA", "EXB", "EXC"):
    t = re.search(rf'^{k} = "(.*)"$', src, re.M).group(1)
    add("抜粋が AGENTS.md の行の内容に逐語である", k, "ある" if t in ga else "無い", "部分文字列")
    add("抜粋の句点の数", k, str(t.count("。")), "C は 1 文の決定")

(OUT / "selfcheck.tsv").write_text("check\ttarget\tresult\tmethod\n" + "".join("\t".join(x) + "\n" for x in res), encoding="utf-8")
print(len(res))
