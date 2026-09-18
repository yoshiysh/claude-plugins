# kaizen 統合 — 品質 telemetry と使用量 ledger の突合規約

「質を維持したままチューニングする」は、コスト側（この plugin の ledger）と品質側
（対象スキル自身の telemetry・監査産物）の**両方**が揃って初めて判定できる。この文書は、
skill-kaizen 型の改善運転（対象スキルの実行記録を telemetry として残し、fresh 監査者の
検証を経て改稿する運転）から `proposals.py` の comparison 入力を組み立てるときの規約を
定める。この plugin は他スキルのファイルを参照せず、規約はここで自立して読める。

## group 5 条件の作り方

5 条件はいずれも「同一条件を表す資料」の SHA-256。資料は比較の当事者が保存し、digest から
遡れる状態を維持する（digest だけ合わせて資料を捨てると、後から比較の意味を検証できない）。

| キー | 資料（digest の対象） | 例 |
|---|---|---|
| project | リポジトリと対象範囲を固定する記述（remote URL + サブツリー） | `plugins/<plugin>/skills/<skill>` を含む 1 行テキスト |
| task_class | **再現入力そのもの**。同一入力で再実行できる wrapper / 固定 args ファイル | kaizen 運転で保存している run wrapper script |
| model | 実行に使ったモデル・推論設定の列挙 | workflow が起動する agent の model 指定を列挙した資料 |
| settings | 実装以外の実行条件（権限・runtime・cache 条件・背景コンテキスト） | 実行環境の条件を列挙した 1 行テキスト |
| quality_contract | 品質判定の成文基準ファイル | 対象スキルの監査チェックリスト・成功基準文書 |

task_class に「スキル名」のような緩い資料を使わない — 入力が違えば比較にならないことは
kaizen 運転の対照測定（同一入力・独立ドラフト・対発行）と同じ理屈で、ここでも入力の同一性が
比較可能性の土台になる。

**settings に実装の版（commit SHA）を入れない。** 比較器は group の完全一致を要求するので、
実装版を group に混ぜると「改修前後の比較」が定義上 not_comparable になる（旧形式の矛盾）。
変更する実装版は `mode: "variant"` 比較の cohort ごとの `variant`（実装 fingerprint:
`{digest, computed_at, drift}`、`run_schema.validate_fingerprint` が形の正本）として渡す。
group = 固定するもの、variant = 変えるもの、の分離が比較の前提になる（#60 §4）。
model の資料には alias ではなく**実際に解決されたモデル**を記録する — alias の解決先が
変わると、同じ資料のまま別条件を比べてしまう。

`mode: "drift"`（settings に実装版を含む固定条件の完全一致で、同一実装の経時劣化を見る比較）は残るが、
改修前後の比較には使えない。session を推測で skill run に変換して variant 比較に持ち込むことも
しない（帰属証拠が無い観測は unknown のまま）。

## sample の作り方

- **id**: 対象 run の telemetry 記録（run 単位 JSON）の SHA-256。
- **usage / usage_evidence**: この plugin の ledger から当該 session の観測を**単一観測として
  切り出した JSON** を保存し、その SHA-256 を usage_evidence に、値を usage に写す。
  run（telemetry のラベル）と session（ledger のキー）の対応表は比較の当事者が別途保存する
  （ledger は本文・生 ID を持たないため、対応は ledger からは復元できない）。
- **quality / quality_source / quality_evidence**: 下記。
- **duration_ms**: run の実測時間。取れないなら null（null の sample は候補の前提を満たさない）。

## quality を independent にする条件

quality_source を independent と宣言できるのは、品質値が次のいずれかの**検証側産物**から
機械的に導かれ、その産物ファイルの SHA-256 を quality_evidence にしているときだけ:

- 対象スキルの run 返り値のうち、**writer と別 agent（監査者・verifier・裁定器）が出した
  判定部分**（例: 監査 verdict、fabrication 件数、裁定内訳）。writer の自己申告値
  （item_delta 等）だけから quality を組んだら、それは producer である。
- fresh context の適合監査・品質採点の結果ファイル。

導出規則は**比較の前に成文化して固定**し、quality_contract の資料に含める。例:

```
quality = passed  ⇔  verdict ∈ {clean, tbd_remaining}
                     ∧ fabrication_findings == 0
                     ∧ audit_incomplete == false
それ以外で判定材料が揃っている → failed / 材料が欠測 → unmeasured（passed に丸めない）
```

規則を結果を見てから書くと、出た結果に通る品質定義を後付けできる（コスト削減案が品質を
落としていても「その品質は定義に入っていなかった」ことにできてしまう）。

## 判定の分担

- `proposals.py` が出すのは「コスト差の調査/検証候補」まで。品質の維持そのものの認定は
  しない（quality passed は入力であり、その真正性は quality_evidence の産物側にある）。
- 候補を改修に進めるかは kaizen 運転側の判断で、そこでは通常の contract
  （成功基準の事前固定・生成と検証の分離・standardize の人間ゲート）に従う。
- 分析自身の使用量は別 capture で測る（proposals.md と同じ。分析コスト 0 とはしない）。
- report の `censored_sessions` が 0 でない期間の ledger 合計は下方に偏っている。打ち切りが
  出ている条件でのコスト比較は、その事実を比較資料に明記してから行う。
