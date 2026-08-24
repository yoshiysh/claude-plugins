# Plan 雛形（起点別）

共通の契約: 事実と目標を分ける／分析（機序・制約・前提）／選択肢 2 案以上、各案に機序／採用基準と棄却理由／成功基準と測定方法を実行前に固定／停止条件／使ったオペレータ。

## 問題起点
```
origin_mode: problem
facts: [出典付き。数字が無いなら「数字無し」と書く]
goal: [何がどうなれば解決か。観測できる形で]
analysis: [なぜ今そうなっているか。機序 → 制約 → 前提]
options:
  - option / mechanism（なぜ効くか） / counter_conditions（効かないとしたら）
  - ...
chosen: [案] / basis: [採用基準]
rejected: [案 / 理由]
success_criteria: { text, metric, higher_is_better, provisional: false }
measurement: [何を固定し何を変えるか。対制御が組めないなら施策前後の同一指標]
stop_conditions: { maxRuns, cycles, 達成条件 }
operators_used: [...]
```

## 動機起点
```
origin_mode: motivation
facts: []            ← 空でよい。捏造しない
goal: [「できたと分かる状態」。1 周目は仮]
analysis: [動機の言い換え（何が・何に対して・どうなる）と、類推の写像表]
options: [最小試作の範囲の候補。各案に「これで現状が作れる理由」]
chosen / rejected
success_criteria: { text, metric, higher_is_better, provisional: true }   ← Check で確定
measurement: [1 周目は単一条件。観測点だけ決める]
stop_conditions
operators_used: [類推, 反証, 較正, ...]
```

## 主張検証起点
```
origin_mode: claim_check
facts: [主張の一次情報。数字・条件・出典]
unverified: [裏が取れなかった主張]
goal: [主張のどの部分を、どの観測で検証するか]
analysis: [逆算: 数字 → 制約 → 候補構造 → 予測される観測]
options: [候補構造ごとの条件設計]
chosen / rejected
success_criteria: { text, metric, higher_is_better, provisional: false }
measurement: { conditions[], fixed, runsPerCondition }
stop_conditions
operators_used: [事実確認, 逆算, 反証, 対制御比較, 較正]
```
逆算の材料（数字・制約）が無い場合は Plan を書かず `status: unverifiable` を返す。
