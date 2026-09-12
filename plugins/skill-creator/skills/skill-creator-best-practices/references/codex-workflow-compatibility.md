# Codex Workflow 実行契約

create / review / update の active `Workflow(...)` callsite に到達した場合だけ読む。

## 共通 route

1. native `Workflow` が現在の tool inventory にあり、この call が未試行なら1回だけ使う。
2. native が無い Codex では `workflow:dynamic-workflow-runner` を内部利用する。ユーザーに runner の指定を求めない。
3. 同じ `scriptPath` と `args` を JavaScript runtime へ渡す。source の実行意味を維持するため、中間契約への翻訳は挟まない。
4. native 試行後の error / timeout / invalid result を runner で再実行しない。
5. source が指定する役割・reference・schema を維持し、必要なモデルラベルを host の `modelMap` に明示する。
   固定の Codex モデル ID をこの契約に埋め込まず、現在利用できるモデルから役割に応じて選ぶ。
   モデル指定を黙って削除せず、対応表は実行記録に残す。品質や provider の同一性は保証しない。
6. 読取対象・書込先・実行上限・必要機能を確認する。review は読取、update の staging 書込には
   承認された範囲の workspace-write を設定する。worktree は標準の必須条件ではない。
7. runtime の完了と source の返り値を区別する。CLI の completed だけでは合格にせず、
   SKILL.md が定める verdict と検証の充足を確認して成功後 phase へ進む。
   未導入、実際の機能不足、権限不足、実行失敗は具体的な結果を報告し、成功を合成しない。

## caller が所有する前後処理

- create: 前処理は Phase 1、成功後は Phase 5。ペルソナと保存の承認は維持する。
- review / update: 前処理は Phase 1、成功後は Phase 3。対象・範囲・意図の確認と適用承認を維持する。
- update は staging の改稿と再検証までを workflow が行い、本体への反映は承認後に司令塔が行う。
  staging の実在と changed_files を確認し、承認されたファイルだけ反映して読み戻す。
- caller の承認境界を runtime 内へ移さず、未検証の結果を確定した成果物として扱わない。
