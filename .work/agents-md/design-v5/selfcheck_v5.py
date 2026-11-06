import re
from pathlib import Path

OUT = Path(__file__).resolve().parent
ROOT = OUT.parents[2]
TABLE = OUT.parent / "flow-model-2" / "table.tsv"


def read(name):
    lines = (OUT / name).read_text(encoding="utf-8").splitlines()
    head = lines[0].split("\t")
    return [dict(zip(head, l.split("\t"))) for l in lines[1:]]


res = []


def add(check, target, result, method):
    res.append((check, target, result, method))


files = read("files.tsv")
fpaths = [f["path"] for f in files]
refs = read("refs.tsv")
rules = read("rules.tsv")
agents = read("agents.tsv")

# 1 refs new_target
for r in refs:
    nt = r["new_target"]
    if r["referrer"].startswith("検索語"):
        continue
    if nt.startswith("変更なし") or nt.startswith("消える"):
        m = re.match(r"(.+):(\d+)$", r["referrer"])
        p = ROOT / m.group(1)
        ok = p.is_file() and len(p.read_text(encoding="utf-8").splitlines()) >= int(m.group(2))
        add("refs: 変更なし・消えるの referrer が実在する", r["referrer"], "実在する" if ok else "実在しない", "ファイルの有無と行数")
        continue
    path = re.split(r"[「（:]", nt, maxsplit=1)[0].strip()
    hit = [f for f in fpaths if f == path or f.startswith(path + " ") or (f.endswith("/") and path.startswith(f))]
    if not hit:
        hit = [f for f in fpaths if f.split(" ")[0] == path]
    add("refs: new_target の先頭のパスが files.tsv にある", r["referrer"] + " → " + path, "ある" if hit else "無い", "new_target の「・（・: の前を files.tsv の path と照合（AGENTS.md は節の行の先頭語で一致）")

# 2 rules ↔ table
trows = (TABLE.read_text(encoding="utf-8")).splitlines()
tkeys = {}
for i, l in enumerate(trows[1:], start=2):
    c = l.split("\t")
    tkeys[i] = (c[0], c[1], c[2])
used = set()
for r in rules:
    mt = r["model_transition"]
    segs = re.findall(r"L(\d+) ([^/]+)", mt)
    if not segs:
        add("rules: model_transition が模型の外と書かれている", r["rule"][:30], "模型の外と書かれている" if mt.startswith("模型の外") else "どちらでもない", "先頭の文字列")
        continue
    for n, body in segs:
        n = int(n)
        st, ev, gd = tkeys.get(n, ("?", "?", "?"))
        ok = body.strip().startswith(f"{st}・{ev}・{gd}")
        used.add(n)
        add("rules: model_transition が table.tsv の行と逐語で一致する", f"L{n} {r['rule'][:24]}", "一致" if ok else f"不一致（table: {st}・{ev}・{gd}）", "L<行> の後が state・event・guard で始まるか")
for n in tkeys:
    add("table: 行が rules.tsv のどれかに写るか除かれている", f"L{n} {tkeys[n][0]}・{tkeys[n][1]}", "現れる" if n in used else "現れない", "rules.tsv の model_transition の L 番号の集合")

# 3 actors
names = {a["agent"].split("（")[0] for a in agents}
allowed = {"builder", "orch", "reviewer", "sevagent", "human", "bot", "script", "-"} | names
for r in rules:
    toks = re.split(r"[・（）\s]", r["actor"])
    head = [t for t in toks if t and re.match(r"^[a-z\-]+$", t)]
    bad = [t for t in head if t not in allowed and t not in {"make", "test"}]
    add("rules: actor が担い手の集合にある", r["rule"][:30], "ある" if not bad else "無い: " + ",".join(bad), "英字の語を {builder,orch,reviewer,sevagent,human,bot,script} と agents.tsv の名前に照合")

# 4 empty fields
for r in rules:
    empties = [k for k in ("input", "output", "place") if r[k].strip() in ("", "-")]
    if empties:
        add("rules: input・output・place が - の行", r["rule"][:30], "- の欄: " + ",".join(empties), "欄の値")

# 5 work refs in content_gist
pat = re.compile(r"(?<![A-Za-z§])[DQVWXYZ]\d+\b|\.work/|main-lines|main の L|L\d+-\d+")
n_hit = 0
for f in files:
    for m in pat.finditer(f["content_gist"]):
        n_hit += 1
        add("files: content_gist に作業用の参照", f["path"], m.group(0), "正規表現 " + pat.pattern)
add("files: content_gist の作業用の参照の件数", "files.tsv", str(n_hit), "正規表現 " + pat.pattern)

# 6 AGENTS.md lines
tot = 0
parts = []
for f in files:
    if f["path"].startswith("AGENTS.md 節"):
        m = re.search(r"（見込み (\d+) 行）", f["content_gist"])
        if m:
            tot += int(m.group(1))
            parts.append(m.group(1))
gaps = len(parts) - 1
add("AGENTS.md の行数の見込み", "files.tsv の AGENTS.md 節の行", f"節の見込みの合計 {tot}（{'+'.join(parts)}）と節の間の空行 {gaps} で {tot + gaps} 行", "content_gist の「（見込み N 行）」を合計。1 項目 1 行・折り返しなしの数え方。main は 235 行")

# 7 excerpts identical between AGENTS row and workflow row
import importlib.util
spec = importlib.util.spec_from_file_location("g", OUT / "gen_v5.py")
ga = next(f for f in files if f["path"] == "AGENTS.md 節「作業ルール」")["content_gist"]
gw = next(f for f in files if f["path"] == "docs/guidelines/workflow.md")["content_gist"]
src = (OUT / "gen_v5.py").read_text(encoding="utf-8")
for k in ("EXA", "EXB", "EXC"):
    t = re.search(rf'^{k} = "(.*)"$', src, re.M).group(1)
    add("抜粋の文が AGENTS.md の行に逐語である", k, "ある" if t in ga else "無い", "部分文字列の照合")
    add("抜粋の文の数", k, str(t.count("。")) + " 個の句点", "句点を数える（C は 1 文の決定）")
add("workflow.md の行が抜粋の行を逐語で置くと書く", "docs/guidelines/workflow.md", "書く" if gw.count("逐語で置き") == 3 else "書かない", "「逐語で置き」の数")

# 8 files that are modified must exist
for f in files:
    p = f["path"].split(" ")[0]
    if f["action"].startswith("modify") or f["action"] == "delete":
        if p.startswith("AGENTS.md") or p.startswith("（"):
            p = "AGENTS.md" if p.startswith("AGENTS.md") else None
        if p:
            add("files: modify・delete の対象が実在する", p, "実在する" if (ROOT / p).exists() else "実在しない", "パスの有無")
    if f["action"] == "create" and not f["path"].startswith("AGENTS.md 節"):
        add("files: create の対象がまだ無い", p, "無い" if not (ROOT / p).exists() else "既にある", "パスの有無")

# 9 paths named in AGENTS map exist
for p in ["docs/requirements/INDEX.md", "docs/specifications/INDEX.md", "plugins/workflow/skills/dynamic-workflow-runner/references/claude-workflow-compatibility.md", "skills-audit.md", "docs/specifications/formal-methods.md", "docs/design/skill-design-patterns.md", ".agents/skills/formal-methods/SKILL.md", ".agents/skills/manage-marketplace-plugin/SKILL.md", "tests/bp-criteria-copy.test.mjs", "scripts/worktree-setup.sh", "tools/update-plugins"]:
    add("本文が指すパスが実在する", p, "実在する" if (ROOT / p).exists() else "実在しない", "パスの有無")

# 10 headings named exist
BP = ROOT / "plugins/skill-creator/skills/skill-creator-best-practices/references/best-practices.md"
heads = {
    BP: ["model と effort は役割ごとに組で選ぶ", "体数は測れる値から段階的に決める（作るスキル向けの設計指針）", "解決は根本原因の除去に置く（防御パッチを解決と呼ばない）", "script の置き場", "3. Sub-agent 設計"],
    ROOT / ".agents/skills/manage-marketplace-plugin/SKILL.md": ["設計上の不変条件（守るべきルール）"],
    ROOT / "docs/design/skill-design-patterns.md": ["機械で確かめる"],
    ROOT / "README.md": ["インストール", "開発"],
    ROOT / "REVIEW.md": ["重大度", "観点", "読むもの"],
}
for p, hs in heads.items():
    txt = p.read_text(encoding="utf-8")
    for h in hs:
        ok = re.search(r"^#{1,6}\s+" + re.escape(h) + r"\s*$", txt, re.M) is not None
        add("本文が名指す見出しが完全一致で実在する", f"{p.relative_to(ROOT)}「{h}」", "ある" if ok else "無い", "見出し行の完全一致")

for name, keys in (("main-lines.tsv", ["L19 後半", "L21", "L23-27", "L29-31", "L33-37", "L59", "L62", "L70-71", "L79-81", "L101-107", "L108-117", "L118-127", "L176", "L204", "L205", "L207"]),):
    have = {l.split("\t")[0] for l in (OUT / name).read_text(encoding="utf-8").splitlines()}
    for k in keys:
        add("main-lines.tsv: 直した行の鍵が v4 の行にある", k, "ある" if k in have else "無い", "1 列目の照合")

# 11 finding section: every lens agent output has the 指摘 section that the sev-agent input names
sev = next(r for r in rules if r["rule"].startswith("重大度"))
need = "「指摘」の節" in sev["input"]
add("rules: 重大度の行の入力が「指摘」の節を名指す", sev["rule"][:20], "名指す" if need else "名指さない", "部分文字列")
for a in agents:
    if a["agent"].startswith(("severity-assigner", "make test")):
        continue
    ok = "「指摘」の節" in a["output"]
    add("agents: 観点の agent の output に「指摘」の節がある", a["agent"], "ある" if ok else "無い", "部分文字列")
dv = next(a for a in agents if a["agent"] == "decision-verifier")
add("agents: decision-verifier の output に作り手の検査の指摘の節と typo 級の判定の確かめがある", "decision-verifier", "ある" if ("作り手の検査の指摘" in dv["output"] and "typo 級" in dv["output"]) else "無い", "部分文字列")

# 12 stale words from v4 across v5 TSVs (counts; hits that are cut rows or old_target are expected)
import re as _re
stale = _re.compile(r"multi-agent\.md|distribution\.md|plugins/\*/skills/manage-marketplace-plugin|AGENTS\.md:25 を含む|除けない原因")
for t in sorted(OUT.glob("*.tsv")):
    if t.name == "selfcheck.tsv":
        continue
    for i, l in enumerate(t.read_text(encoding="utf-8").splitlines(), start=1):
        for m in stale.finditer(l):
            add("v4 から写った古い語の残り", f"{t.name}:{i}", m.group(0), "正規表現 " + stale.pattern + "（cut の行と old_target の列は意図した残り）")
lines = ["check\ttarget\tresult\tmethod"] + ["\t".join(x) for x in res]
(OUT / "selfcheck.tsv").write_text("\n".join(lines) + "\n", encoding="utf-8")
print(len(res))
