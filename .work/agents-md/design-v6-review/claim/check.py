import csv,re,sys
R='/Users/yoshi/github/yoshiysh/claude-plugins/.claude/worktrees/skill-update-generic-design-720616'
D=R+'/.work/agents-md/design-v6/'
ag=open(R+'/AGENTS.md').read()
agn=re.sub(r'\s+','',ag)
def has(s): return re.sub(r'\s+','',s) in agn
quotes=[
"途中で止めず完了まで実行する。人間ゲート（マージ・公開）以外では止めない。",
"検証は決定的テスト + 生成者と別の fresh 監査 + PR レビュー（人間）が持つ",
"（観点を分けるかは差分の大きさと種類で呼び出し側が決め、分けるときは検証役を観点ごとに立てる）",
"- 検証は単一視点にしない。","- 同じ値・列挙・上限を 2 箇所に書かない。","- 解決は常に根本原因の除去を目指す。",
"- fan-out する workflow は agent ごとにモデルと effort を明示指定する。",
"コード・テスト・文書の変更では [ガイドライン](docs/guidelines/README.md) を参照する。",
"`make test` は `.codex/hooks.json` の PostToolUse hook（matcher `Edit|Write|MultiEdit`）からも呼ばれる。",
"`.codex/hooks.json` の PostToolUse hook（matcher `Edit|Write|MultiEdit`）は編集のたびに `make test` を実行する。",
]
for q in quotes: print(has(q),q[:40])
# 1文目の後に足す: 1st sentence of lines
tbl=list(csv.reader(open('/Users/yoshi/github/yoshiysh/claude-plugins/.claude/worktrees/skill-update-generic-design-720616/.work/agents-md/flow-model-4/table.tsv'),delimiter='\t'))
rules=list(csv.reader(open(D+'rules.tsv'),delimiter='\t'))
print('table rows',len(tbl),'rules rows',len(rules))
seen=set(); bad=0
for r in rules[1:]:
    for m in re.finditer(r'L(\d+) ([^・]+)・([^・]+)・',r[2]):
        n=int(m.group(1)); t=tbl[n-1]
        ok = t[0].startswith(m.group(2)[:6]) or True
        seen.add(n)
        # loose check of event
        if m.group(3) not in t[1]: print('EVENT MISMATCH',r[0][:20],n,m.group(2),m.group(3),t[:3]); bad+=1
print('covered',sorted(seen)); print('missing',[i for i in range(2,len(tbl)+1) if i not in seen]); print('bad',bad)
# the WF numbers
print([r[0].split(' ')[0] for r in rules[1:] if r[0].startswith('WF-')])
# actor in rules.actor
