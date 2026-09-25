# telemetry: スキル実行の実測を記録し、改善候補の選別と対照 run の判定に使う

配布スキル自身を改善の対象にするときの、実測の取り方と使い方。記録と判定は 2 本の script が
持ち、この文書はその呼び出し手順だけを書く。実測を会話ログや記憶から取ると、run の詳細が
session とともに消え、次の改善で同じ抽出を手でやり直すことになる。

## 前提

- 対象スキルの実行実測が `~/.claude/skill-telemetry/<skill>/` に 1 run 以上あること。
  無ければ、まず通常運転の run を `python3 [SKILL_DIR]/scripts/skill_telemetry.py record` で
  記録する。実測ゼロでは現状を事実として書けず、完了条件は現状を作る最小の試作から始まる。
- 記録と照合は `input_ref`（同一入力で再実行できる入力一式のパス）で結ぶ。これが無いと
  対照測定が組めない。

## 観測: 改善候補の選別

`python3 [SKILL_DIR]/scripts/goal_selector.py select --skill <対象>` で在庫から候補を選別し、
pending 全件を一括で依頼者に示して、裁定（approved / rejected / done / superseded と理由）を
`decide` で記録する。approved の statement を、そのまま改善の依頼として使う。selector は在庫の
決定的な関数で、候補を発明しない。傾向を目視したいだけなら `skill_telemetry.py summary` を使う。

## 対照 run の判定

control（本体版）と treatment（staging 版）を、同一入力・独立ドラフト・対で発行する。
互いの作業ファイルを共有させない（run 間の相互影響を断つため）。結果は両条件とも
`skill_telemetry.py record` で、同じ `--input-ref` を付けて記録する。判定は散文で読まず、
script に返させる:

```bash
python3 [SKILL_DIR]/scripts/skill_telemetry.py compare --skill <対象> \
  --control <本体版の label> --treatment <staging 版の label> \
  --criteria-file <run の前に固定した基準ファイル>
```

基準ファイルは `criteria{metric, higher_is_better, threshold}` を持つ JSON で、run の前に
固定し、改変されていないことを呼び出し側が digest で照合する。指標・向き・閾値を CLI に
手で書くと、差分を入れた本人が判定の時点で判定の仕方を選び直せてしまう。

`compare` は、対で記録されているか・`input_ref` が一致するか・指標が両条件で数値として
取れるかを検査し、どれかが欠けたら判定を返さず exit 2 で止まる。この 3 点を散文の手順に
しておくと、対発行・同一入力・事前固定の基準のどれも実行者の自己申告になる。exit 2 は
「差が無い」ではなく「測定が成立していない」なので、判定に進まず対照を組み直す。
