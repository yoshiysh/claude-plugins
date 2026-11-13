# 56要求のsource table（未承認草稿）

正本・hash・完全な照合用メタデータは coverage.json。Dはbp-designed-skill、Oはbp-operations。原文行は同JSONのsource内。F=有限形式化候補、M=独立意味確認、R=参照先制約。IDの記載・原文抽出・欄存在は要求の意味の合格ではない。全56件の形式検証・独立意味確認は未実施。

| ID / 原文行 | 主体 / 操作 | 条件 → 義務・禁止の要約 | 方法・例外 |
|---|---|---|---|
| D001 / 40 | definition / create,update | 形選択時 → 軽い形から選択; ターン指揮にWorkflow禁止; Workflow部品; 資産台帳適用条件; 記録台帳免除禁止 | R,F,M; なし |
| D002 / 43 | definition / target | 固定集合反復/探索グラフ/複数run → 選択条件を設計説明へ; 各runの条件と必要性 | M,R; 軽い形には重い形の根拠要求なし |
| D006 / 46 | target-run / target | 入口 → 成果物/範囲/禁止/数値/指示語を固定 | R,F,M; なし |
| D007 / 49 | target-run / target | Workflowあり/人間入力境界 → 停止; 判断材料と再開情報; 新run続行; 中断≠完了 | R,F,M; 非Workflowは本項対象外 |
| D008 / 52 | target-run / target | Workflowあり → 必要項目保持; 同時実行制限 | R,F; なし |
| D009 / 55 | definition / target | Workflowあり → 全役model/effort明示; 必要prompt | R,F,M; 値/初期値表/変更時effort再測定/xhigh-max役限定を適合判定に使わない |
| D010 / 58 | definition / target | Workflowあり → 役の許可/禁止を分離 | R,F,M; なし |
| D011 / 61 | target-run / target | 探索グラフ型 → 探索原則; 実行役時間上限決定/明示; Codex強制; Claude強制不能開示 | R,F,M; 値の明示だけでは強制証拠にならない |
| D012 / 64 | target-run / target | 探索グラフまたは資産台帳あり → 検証更新; 再送/競合/中断で意味不変; CLIのみ共有状態更新; 運搬/受理分離; 追記/決定的照合 | R,F,M; なし |
| D013 / 67 | target-run / target | 資産台帳あり → 対象と結果対応; 確認/未確認分離; 件数を判断正しさの証拠にしない | R,F,M; なし |
| D051 / 70 | definition / target,create,update,review | AI判断層に判断点あり/なし → 判断点と理由または不存在; 機械対応だけで適合; create/update設計説明を照合; review全ファイル照合; 列挙網羅未確認開示 | R,F,M; 最硬層/理由意味/他層理由を適合条件にしない;create/update残危険/review未検査 |
| D024 / 75 | operation / create,update | 対象検証時 → 要求/状態/遷移/入出力/制約から性質抽出; 非形式化理由と別確認または未確認理由 | M,F; 形式化困難でも必要確認を落とさない |
| D025 / 78 | operation / create,update | 形式検証適用可能 → 性質に必要な手法/道具で検証 | M,F; TLA+/SMTは例で一律必須ではない |
| D026 / 81 | operation / create,update | 形式検証時 → 対象/手法/道具/前提/探索範囲/結果/未検証/非形式化確認を記録 | F,M; 記録欄存在は内容妥当性の保証ではない |
| D027 / 84 | operation / create,update | 必要形式検証不能または性質不成立 → 当run停止; 対象/理由報告; 同run修正続行禁止 | F,M; 修正/環境復旧/再検証は別runで可;非形式失敗はO011 |
| D028 / 89 | target-run / target | 各担当/各run → 担当/段/対象/入力/実行/結果/根拠/失敗/未確認を後追跡; 段なしを明示 | F,M; 段境界なしの場合も記録不要ではない |
| D029 / 92 | target-run / target | 各run → 作業記録/証拠を環境保存; 記録台帳から到達; 担当共有台帳直書き禁止 | F,M; 資産台帳だけで代替不可 |
| D032 / 95 | target-run / target | 同一内容を複数記録で使用 → 正本一つ; 分割時も同内容は正本参照 | F,M; 責務/対象による記録分割は可 |
| D034 / 98 | target-run / target | 保存成功後/新run → 保存済作業/証拠/台帳/過去判断を保持; 更新後も過去到達 | F,M; 利用者削除指示まで |
| D035 / 101 | target-run / target | 記録/証拠/台帳の保存不能 → 停止; 保存済保持; 未保存範囲/理由報告; 完了禁止 | F,M; 一部保存済でも失敗停止 |
| D036 / 104 | target-run / target | 各run → 所要時間/人介入/再試行/取得費用を記録; 未取得区別 | F,M; 取得できない費用を既知扱いしない |
| D040 / 107 | target-run / target | 作業記録作成 → 文書一般規約適用; 実行先参照; 各run適用版を不変参照特定 | R,F,M; 参照の存在だけでは遵守を保証しない |
| D014 / 112 | operation / create,update | host別実効性確認。Claudeは名前付き無視一覧を照合。文書不可/該当記述なしの場合だけ一覧不可 → Claude全役制限未確認、その未確認だけで不合格禁止 | R,F,M; Claude一覧古化受容。全役未確認は一覧不可の場合だけ |
| D015 / 115 | operation / create,update | host制限確認不能 → 範囲/理由を残危険表示; Claude照合済を未確認扱い禁止; Codex別表示 | F,M; Claude一覧照合とCodex確認を混同しない |
| D046 / 118 | operation / create,update | hostで効かないと確認 → 不適合; 修正し効くまで検証合格禁止 | F,M; 未確認と既知不適合を区別 |
| D016 / 123 | target-run / target | fan-outあり → 起動総数上限入力受取/遵守; 結果なし呼出も起動計数 | F,M; 任意件数の実host計数は有限boolでは保証不可 |
| D019 / 126 | target-run / target | 起動上限で未処理あり → 順位付き未着手保持; 停止; 新run残り続行; 切捨/確認済誤認禁止 | R,F,M; 未処理と打切りと結果なしを区別 |
| D021 / 129 | target-run / target | 上限入力なし → 項目数/総起動数に入力非依存固定上限禁止 | F,M; 同時実行/反復/周/試行上限は対象外 |
| D022 / 132 | target-run / target | fan-outあり → Codexは起動上限授受; nativeは上限を渡さない | F,M; host判別/実APIは別確認 |
| O001 / 64 | operation / create,review,update,audit | 依頼分類 → 4機能提供/該当実行; 非該当不実行/理由返却 | F,M; 非該当を機能実行に変えない |
| O038 / 67 | operation-chain / all | 複数機能依頼 → 指定順優先; 未指定は依存順; 未決/矛盾は確認; 前結果受渡; 不十分必須入力禁止; 途中停止後続禁止; 連鎖に停止報告 | F,M; 順は好みで補完しない |
| O051 / 70 | operation-run / all | 4機能の各run → D028/029/032/034/035/036/040の記録要求を適用 | F,M; target-run一般契約との明示bridgeは記録だけ |
| O052 / 73 | operation-run / all | needs_input → 理由/決める事/検証結果/影響/残作業の5材料; 未存在欄は不存在明示; 目標前は結果/残作業なし; 目標固定時は残作業/既得結果 | F,M; 材料の不存在と未記載を区別 |
| O003 / 78 | operation / create,update | 書込前/目標固定 → create依頼/回答; update目的/修正根拠から固定; 依頼外目標/制約禁止 | R,F,M; updateは対象目的を出発点にする |
| O005 / 81 | operation-run / create,update | 目標に必要承認/回答不足 → needs_input/判断材料/停止; Workflow内待機禁止 | F,M; 待たれないヒントとは別 |
| O008 / 84 | operation-output / create,update | 成果提供 → 全D要求を満たすスキル提供; 単体1回で解ける課題の探索グラフ禁止 | R,F,M; 対象定義の適合とBP自身runを同一視しない |
| O037 / 87 | operation-run / create,update | 書換時 → 対象外の変更禁止 | F,M; run作業記録/証拠/記録台帳は範囲例外 |
| O009 / 90 | operation / create,update | 生成後検証 → 生成と別context; 生成者説明/自己評価を合格根拠にしない | F,M; 別IDだけでcontext非継承や独立性は保証不可 |
| O010 / 93 | operation-run / create,update | 完了判定/検証未達停止 → 必要検証通過前完了禁止; 停止時未達/理由 | F,M; 必要検証の十分性をbool宣言で代替しない |
| O011 / 96 | operation-run / create,update | 非形式失敗または形式不能/不成立 → 非形式失敗は書直/独立再検証可; 形式失敗はD027停止/同run続行禁止 | F,M; 非形式失敗後の修正は必須ではなく許容 |
| O013 / 99 | operation-run / all | 4機能で続行不能失敗 → BLOCKED/理由で停止し段報告。別guard: review/auditの完了前の全停止 → 段/理由報告 | F,M; review/auditの非失敗停止にBLOCKEDを強制しない |
| O014 / 102 | operation-output / create,update | 完了時 → スキル/設計説明/検証結果; 指摘状態/skip/残危険 | F,M; 成果欄存在だけでは完了を許さない |
| O015 / 105 | operation-input / update | 入力受理 → 対象全体/根拠1件以上; 目標出発点; 根拠無上限/全件受理; 件数拒否/切詰禁止 | F,M; 任意件数無上限性は有限サンプルで証明不可 |
| O018 / 108 | operation / update | 全体作直時 → 根拠未言及部含む全体作直許容; 目標/範囲/独立検証/完了の要求保持 | F,M; 作直許容は範囲外変更許可ではない |
| O019 / 111 | operation / update | 作直後 → 既存動作保持を後検証のみから判定; 検証未対応を保持済禁止; 判定不能範囲 | F,M; 実際の意味保持は後検証の質の確認要 |
| O021 / 114 | operation-run / create,update | 同run指摘後の書換 → 修正/再発追跡; 結果状態; 資産台帳原則 | R,F,M; runまたぎ追跡はO022 |
| O022 / 117 | operation-run / update | 裁定前/旧run指摘入力 → 旧指摘resolved/regressed禁止; 現run状態のみ; 旧根拠受理可/追跡継承不可 | F,M; 新runの新指摘を付けること自体は禁じない |
| O040 / 120 | operation-run / create,update | 完了前停止 → 書込済file保持; 検証済/未検証/段/理由; 戻す判断は利用者 | F,M; 失敗で自動rollbackしない |
| O024 / 125 | operation / review | フロー評価 → D要求を評価基準にする | R,M; Dの定義/実行適用条件を失わない |
| O025 / 128 | operation / review | 仕様逸脱評価 → 仕様確定値/規則; Dモデルeffort例外; 対応仕様なし未検査; 部分仕様を全検査済禁止 | F,M; 要求整合のoracleに仕様を逆流させない |
| O028 / 131 | operation / audit | 監査/監査基準なし → 現prompt-audit使用; 形/台帳/証拠原則; 後run照会; 未決を裁定しない; 基準なし不実行/停止/段/理由 | R,F,M; 監査基準内容は別確認待ち |
| O030 / 134 | operation-run / review,audit | 評価時 → 対象書換禁止; 修正主体update | F,M; O051の作業記録保存は対象書換とは別 |
| O031 / 137 | operation / review,audit | 指摘候補返却 → 独立反証後に含む; 却下も理由付返却 | F,M; reviewのD051機械決定指摘だけは反証なし必須;auditに拡張禁止 |
| O032 / 140 | operation-output / review,audit | 結果返却 → open/dismissedのみ; 不変更runでresolved/regressed禁止 | F,M; 却下を結果から落とさない |
| O033 / 143 | operation-output / review,audit | 確認結果返却 → 指摘/問題なしを資産結付; coverage/skip/未検査; 結果なし問題なし禁止 | R,F,M; 見た結付は正しさを保証しない |
| O036 / 146 | operation-output / review,audit | updateへ受渡 → 根拠として受け取れる形; 内容/根拠/判断状態保持 | F,M; 形式だけで意味の無欠損を保証不可 |
