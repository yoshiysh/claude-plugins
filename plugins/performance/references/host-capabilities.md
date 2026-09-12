# ホスト能力の対応状況（skill 実行単位の計測）

skill 実行単位の計測（#60）が各ホストから何を取得できるかの正本。
証拠 tier の定義: **a** = 本ホストでの実捕捉（実行 transcript / hook 入力の実測）、
**b** = 合成 fixture のみ（パーサ・投影がその形状を処理できることの確認であって、
ホストがその形状を出すことの証明ではない）、**c** = 取得経路なし（帰属は unknown）。

tier b を「実証」と呼ばない。宣言された境界と実測は区別する（SKILL.md の Read・
文中のスキル名・時刻の重なり・LLM の自己申告は実行証拠にしない）。

## 能力 6 区分

| 能力 | 意味 | Claude Code | Codex CLI |
|---|---|---|---|
| skill_boundary | skill 実行の開始・終了をホストが通知する | b（明示入口イベントの投影のみ。自動 dispatch 通知の実捕捉は未実証 = C1） | c |
| call_linkage | model call が invocation に紐づく | b（`claimed_by` 申告の投影のみ） | c |
| child_linkage | 子実行（subagent・子 skill）が親に紐づく | b（`parent_invocation_id` 申告の投影のみ） | c |
| terminal_event | 実行の終了と status が観測できる | b（`skill_end` イベントの投影のみ） | b（codex-exec-v1 adapter の turn 終端） |
| usage | call 単位の usage delta が取れる | a（native transcript の実捕捉 — 既存 ledger） | a（cumulative snapshot の delta 化 — 既存 ledger） |
| notification | 改善候補をホストの応答境界で提示できる | b（queue に残す。応答境界への表示は未実装） | c（queue に残すのみ） |

## 帰属の縮退規則

- 自動境界（tier a の skill_boundary）が無いホストでは、**明示実行入口**
  （`skill_events.py` の閉じたイベント集合）を使う
- それも不可能なら session 観測（既存 v1 ledger）を維持し、skill 帰属は
  **unknown のまま**にする。session を推測で skill run に変換しない

## 未実証のまま残っているもの（censored）

| ID | 内容 | 状態 |
|---|---|---|
| C1 | 実ホスト（Claude Code / Codex）の skill dispatch 能力の実捕捉（tier a 化） | 未実証。実ホスト実行での probe が必要 |
| C2 | 軽量スキルの実モデル before/after 対照実験の実行 | awaiting_budget_approval（承認記録なしでは `experiment.authorize_execution` が拒否する） |

## opt-in と限界

- 収集は明示 enable（`native_hook.py enable`）まで一切始まらない。既定 off
- hook は bounded な収集・集計・重複排除まで。**hook から新規モデル実行・
  スキル編集・外部送信は発生しない**
- 計測が止まっても対象作業は止まらない。計測の成功を偽らない（欠測は
  coverage の unknown / 観測下限ラベルとして残る）
- 課金額推定・未観測 usage の補完は行わない
