# 仕様書: develop:address-review スキル詳細仕様

## 表記規約

仕様項目の語尾の区分は `docs/requirements/develop-address-review.md` の「表記規約」に従う（必須 = 〜しなければならない、推奨 = 〜することが望ましい、許容 = 〜してもよい、禁止 = 〜してはならない）。

## 対象範囲

本文書は、develop:address-review スキルのレビュー指摘収集・トリアージ分類、develop:implement への修正委託、push、CI/required checks 監視、GitHub thread への返信および resolve 制御の仕様を定める。

### 本文書が実現する要求
- 主担当: `docs/requirements/develop-address-review.md` の全要求（PR-DEVELOPADDRESSREVIEW-001 〜 PR-DEVELOPADDRESSREVIEW-068、全68項目）。

## 機能仕様

### 指摘収集と目標設定
#### SP-DEVELOPADDRESSREVIEW-001 入口における指摘受領
GitHub PR コメント、レビューサマリ、または外部レビュー結果 JSON から指摘一覧を収集しなければならない（対応: PR-DEVELOPADDRESSREVIEW-001）。

#### SP-DEVELOPADDRESSREVIEW-002 PR 存在時の目標設定
PR 番号が指定された場合、当該 PR の全未解決 thread を対象として目標を設定しなければならない（対応: PR-DEVELOPADDRESSREVIEW-002）。

#### SP-DEVELOPADDRESSREVIEW-003 PR 非存在時のローカル目標
PR が存在せず作業ツリーのみが対象の場合、指定されたレビュー結果ファイルを対象目標としなければならない（対応: PR-DEVELOPADDRESSREVIEW-003）。

#### SP-DEVELOPADDRESSREVIEW-004 PR 非存在時の作業ツリー整合
PR なしの場合、作業ツリーの最新ブランチに対して修正を適用しなければならない（対応: PR-DEVELOPADDRESSREVIEW-004）。

#### SP-DEVELOPADDRESSREVIEW-005 ブランチ指定時の方針版導出
指定されたブランチ名から最新コミットハッシュを取得し、方針の版としなければならない（対応: PR-DEVELOPADDRESSREVIEW-005）。

#### SP-DEVELOPADDRESSREVIEW-006 リモート未存在ブランチのエラー処理
指定されたブランチが remote に存在しない場合、エラーコード 2 で即時停止しなければならない（対応: PR-DEVELOPADDRESSREVIEW-006）。

#### SP-DEVELOPADDRESSREVIEW-007 外部レビュー結果のスキーマ検証
外部 JSON を入力とする場合、findings 配列の各要素が必須フィールド（id, path, line, body）を持つか検証しなければならない（対応: PR-DEVELOPADDRESSREVIEW-007）。

#### SP-DEVELOPADDRESSREVIEW-008 外部指摘 ID の一意性
各指摘に重複のない一意な ID（comment_id または c1, c2, ...）を付与しなければならない（対応: PR-DEVELOPADDRESSREVIEW-008）。

#### SP-DEVELOPADDRESSREVIEW-009 指摘本文の改竄禁止
収集した指摘の本文テキスト（body）は逐語のまま保持し、要約・改変してはならない（対応: PR-DEVELOPADDRESSREVIEW-009）。

#### SP-DEVELOPADDRESSREVIEW-010 事前 push 権限確認
PR ブランチへの git push 権限を有しているかを git push --dry-run で事前検査しなければならない（対応: PR-DEVELOPADDRESSREVIEW-010）。

#### SP-DEVELOPADDRESSREVIEW-011 push 不可時の早期停止
push 権限がない場合、修正作業を開始する前に permission_denied で停止しなければならない（対応: PR-DEVELOPADDRESSREVIEW-011）。

#### SP-DEVELOPADDRESSREVIEW-047 修正不要かつ push 不可時のハンドリング
直す変更が 0 件かつ push 不可の場合、エラーとせず返信のみ可能か判定して停止しなければならない（対応: PR-DEVELOPADDRESSREVIEW-047）。

#### SP-DEVELOPADDRESSREVIEW-012 指摘以降のコミット一覧取得
指摘が行われた時点以降に PR ブランチへ追加されたコミット一覧を git log で取得しなければならない（対応: PR-DEVELOPADDRESSREVIEW-012）。

### トリアージ分類（Triage）
#### SP-DEVELOPADDRESSREVIEW-013 分類ロールの二段実行
指摘分類役（triager）と分類検証役（triage-verifier）を分離し、独立して分類を行わせなければならない（対応: PR-DEVELOPADDRESSREVIEW-013）。

#### SP-DEVELOPADDRESSREVIEW-014 分類不一致時の安全エスカレーション
triager と triage-verifier の分類結果が食い違った場合、needs_decision で停止し、ユーザーの裁定を仰がなければならない（対応: PR-DEVELOPADDRESSREVIEW-014）。

#### SP-DEVELOPADDRESSREVIEW-015 分類実行時の作業ツリー不変性
トリアージ分類中は作業ツリーへのファイル書き込みを一切行ってはならない（対応: PR-DEVELOPADDRESSREVIEW-015）。

#### SP-DEVELOPADDRESSREVIEW-016 既修正（already_fixed）の判定
指摘内容が最新のコードで既に解消されているかを diff 照合で客観判定しなければならない（対応: PR-DEVELOPADDRESSREVIEW-016）。

#### SP-DEVELOPADDRESSREVIEW-017 修正コミットの照合
already_fixed と判定する場合、それを解消したコミットハッシュを証拠として特定しなければならない（対応: PR-DEVELOPADDRESSREVIEW-017）。

#### SP-DEVELOPADDRESSREVIEW-053 解消コミット特定不能時の差し戻し
解消コミットが特定できない場合、already_fixed 判定を棄却し、通常修正（fix）または要確認（discuss）としなければならない（対応: PR-DEVELOPADDRESSREVIEW-053）。

#### SP-DEVELOPADDRESSREVIEW-018 既修正指摘の除外
already_fixed と確定した指摘は、develop:implement の修正対象リストから除外しなければならない（対応: PR-DEVELOPADDRESSREVIEW-018）。

#### SP-DEVELOPADDRESSREVIEW-019 人間判断要（discuss / question）の抽出
設計方針の選択や意図確認が必要な指摘を discuss または question に分類しなければならない（対応: PR-DEVELOPADDRESSREVIEW-019）。

#### SP-DEVELOPADDRESSREVIEW-020 同一状態での二重分類抑止
同一コミットおよび同一コメント集合に対する重複分類をキャッシュでスキップしなければならない（対応: PR-DEVELOPADDRESSREVIEW-020）。

#### SP-DEVELOPADDRESSREVIEW-048 人間裁定値の注入
ユーザーから discuss 指摘に対する裁定（fix, reject, skip）を受け取り、分類を確定させなければならない（対応: PR-DEVELOPADDRESSREVIEW-048）。

#### SP-DEVELOPADDRESSREVIEW-061 人間判断の許容語彙
裁定値は fix, reject, skip, already_fixed の定義済み列挙子に限定しなければならない（対応: PR-DEVELOPADDRESSREVIEW-061）。

#### SP-DEVELOPADDRESSREVIEW-064 fix 裁定時の対象パス明記
ユーザーが fix を指示した場合、修正対象とすべきファイルパスを明示させなければならない（対応: PR-DEVELOPADDRESSREVIEW-064）。

#### SP-DEVELOPADDRESSREVIEW-062 裁定済み指摘の再審査抑止
人間が裁定した指摘について、再度同じ質問を発出して停止してはならない（対応: PR-DEVELOPADDRESSREVIEW-062）。

### 停止位置と develop:implement 連携
#### SP-DEVELOPADDRESSREVIEW-021 停止位置オプション（--stop-at）
CLI 引数 --stop-at により、triage, implement, push, ci, reply の各段で任意に停止可能としなければならない（対応: PR-DEVELOPADDRESSREVIEW-021）。

#### SP-DEVELOPADDRESSREVIEW-056 指定停止段の操作抑止
--stop-at で指定された段以降の操作（例: --stop-at implement の場合の push や返信）を実行してはならない（対応: PR-DEVELOPADDRESSREVIEW-056）。

#### SP-DEVELOPADDRESSREVIEW-022 develop:implement への修正委託
fix と分類された指摘一覧を票（ticket）にまとめ、develop:implement に引き渡さなければならない（対応: PR-DEVELOPADDRESSREVIEW-022）。

#### SP-DEVELOPADDRESSREVIEW-023 修正対象 0 件時のスキップ
fix 指摘が 0 件の場合、develop:implement を起動せず、直ちに返信・resolve 段へ進まなければならない（対応: PR-DEVELOPADDRESSREVIEW-023）。

#### SP-DEVELOPADDRESSREVIEW-024 develop:implement 停止時の連動停止
develop:implement が上限到達やエラーで停止した場合、address-review 自身も同理由で停止しなければならない（対応: PR-DEVELOPADDRESSREVIEW-024）。

#### SP-DEVELOPADDRESSREVIEW-066 子スキル停止情報の完全伝達
develop:implement の停止理由と next_args をそのまま上位へ返却しなければならない（対応: PR-DEVELOPADDRESSREVIEW-066）。

#### SP-DEVELOPADDRESSREVIEW-055 implement 段からの再開
develop:implement の修正完了後、--resume で push 段から処理を再開可能としなければならない（対応: PR-DEVELOPADDRESSREVIEW-055）。

#### SP-DEVELOPADDRESSREVIEW-049 コミットの委託
ファイル変更の git commit は develop:implement 側で完結させなければならない（対応: PR-DEVELOPADDRESSREVIEW-049）。

### Push と CI 監視
#### SP-DEVELOPADDRESSREVIEW-025 リモートへの Push 実行
develop:implement のコミットが成功した後、作業ブランチをリモートへ push しなければならない（対応: PR-DEVELOPADDRESSREVIEW-025）。

#### SP-DEVELOPADDRESSREVIEW-054 未コミット時の push 中止
develop:implement が新しいコミットを作らなかった場合、git push をスキップしなければならない（対応: PR-DEVELOPADDRESSREVIEW-054）。

#### SP-DEVELOPADDRESSREVIEW-057 push 抑止時のコミット保全
--stop-at implement により push を行わない場合でも、ローカルコミットは正常に保全しなければならない（対応: PR-DEVELOPADDRESSREVIEW-057）。

#### SP-DEVELOPADDRESSREVIEW-052 Push 拒絶時の安全停止
リモートの保護ルール等で push が拒否された場合、push_rejected で停止しなければならない（対応: PR-DEVELOPADDRESSREVIEW-052）。

#### SP-DEVELOPADDRESSREVIEW-026 PR 非存在時の CI/返信スキップ
PR なしのローカル実行の場合、push、CI 待ち、返信、resolve の全ステップをスキップして完了しなければならない（対応: PR-DEVELOPADDRESSREVIEW-026）。

#### SP-DEVELOPADDRESSREVIEW-027 監視対象 SHA の固定
push 完了時の最新コミット SHA を CI 監視対象として固定しなければならない（対応: PR-DEVELOPADDRESSREVIEW-027）。

#### SP-DEVELOPADDRESSREVIEW-028 push 済み SHA と PR head の一致検証
gh pr view で PR の headRefOid を取得し、push した SHA と一致しているか検証しなければならない（対応: PR-DEVELOPADDRESSREVIEW-028）。

#### SP-DEVELOPADDRESSREVIEW-029 required checks 監視ループ
GitHub Actions 等の required checks のステータスを定期ポーリングし、全件 SUCCESS を待機しなければならない（対応: PR-DEVELOPADDRESSREVIEW-029）。

#### SP-DEVELOPADDRESSREVIEW-030 CI 失敗時の不介入規約
required checks が FAILURE となった場合、勝手にコードを修正せず、ci_failed で停止しなければならない（対応: PR-DEVELOPADDRESSREVIEW-030）。

#### SP-DEVELOPADDRESSREVIEW-031 監視タイムアウト時の再開
ポーリングタイムアウト（既定 30 分）で停止した場合、--resume で CI 待ちから再開可能としなければならない（対応: PR-DEVELOPADDRESSREVIEW-031）。

#### SP-DEVELOPADDRESSREVIEW-032 再開時 head ドリフト検知
再開時に PR の head SHA が変わっていた場合、他者による更新とみなし再開を拒絶しなければならない（対応: PR-DEVELOPADDRESSREVIEW-032）。

#### SP-DEVELOPADDRESSREVIEW-033 待ち再開の上限回数
CI 待ちの再開は最大 3 回までとし、超過時は永続停止しなければならない（対応: PR-DEVELOPADDRESSREVIEW-033）。

#### SP-DEVELOPADDRESSREVIEW-034 待ち再開カウンタの記録
再開回数を state.ci_wait_count に永続化しなければならない（対応: PR-DEVELOPADDRESSREVIEW-034）。

### 返信と Thread Resolve
#### SP-DEVELOPADDRESSREVIEW-035 返信直前の PR 状態再照合
コメント投稿の直前に PR の最新状態を取得し、他者による追加プッシュがないか最終照合しなければならない（対応: PR-DEVELOPADDRESSREVIEW-035）。

#### SP-DEVELOPADDRESSREVIEW-036 外部プッシュ検知時の返信中止
外部プッシュが検知された場合、返信を中止し head_drifted で停止しなければならない（対応: PR-DEVELOPADDRESSREVIEW-036）。

#### SP-DEVELOPADDRESSREVIEW-050 thread 更新検知時の返信中止
対象 thread に新たな人間コメントが投稿されていた場合、返信を中止して停止しなければならない（対応: PR-DEVELOPADDRESSREVIEW-050）。

#### SP-DEVELOPADDRESSREVIEW-051 返信中止指摘の明記
返信を取りやめた指摘 ID 一覧をレポートに明記しなければならない（対応: PR-DEVELOPADDRESSREVIEW-051）。

#### SP-DEVELOPADDRESSREVIEW-037 メンション付き個別返信
各 thread への返信は、元のコメント投稿者（@login）をメンションし、対応内容（コミットハッシュ等）を明記しなければならない（対応: PR-DEVELOPADDRESSREVIEW-037）。

#### SP-DEVELOPADDRESSREVIEW-038 既修正指摘への返信フォーマット
already_fixed 指摘には、それを解消した既存コミットハッシュを添えて返信しなければならない（対応: PR-DEVELOPADDRESSREVIEW-038）。

#### SP-DEVELOPADDRESSREVIEW-039 返信内容の事前検証
返信文に空文字や不正なプレースホルダが含まれていないかを送信前に検査しなければならない（対応: PR-DEVELOPADDRESSREVIEW-039）。

#### SP-DEVELOPADDRESSREVIEW-040 不正返信文の送信抑止
検査に通らない返信文は GitHub API に送信してはならない（対応: PR-DEVELOPADDRESSREVIEW-040）。

#### SP-DEVELOPADDRESSREVIEW-041 Resolve 候補の条件
fix または already_fixed であり、CI が全件合格している thread のみを resolve 候補としなければならない（対応: PR-DEVELOPADDRESSREVIEW-041）。

#### SP-DEVELOPADDRESSREVIEW-042 分類別 Resolve 判定表
決定表に従い、reject や question の thread は自動 resolve してはならない（対応: PR-DEVELOPADDRESSREVIEW-042）。

#### SP-DEVELOPADDRESSREVIEW-043 Resolve 前の GraphQL 照合
GraphQL mutation 前に thread ID の実在を照合しなければならない（対応: PR-DEVELOPADDRESSREVIEW-043）。

#### SP-DEVELOPADDRESSREVIEW-044 不整合 thread の resolve 抑止
照合できない thread は resolve せずスキップしなければならない（対応: PR-DEVELOPADDRESSREVIEW-044）。

#### SP-DEVELOPADDRESSREVIEW-045 全 Resolve 候補の網羅性検査
未解決 thread のうち条件を満たすものが漏れなく resolve されたかを事後検証しなければならない（対応: PR-DEVELOPADDRESSREVIEW-045）。

#### SP-DEVELOPADDRESSREVIEW-046 最終完了結果の返却
対応指摘数、返信 thread 数、resolve 数、コミット SHA を含む完了 JSON を返却しなければならない（対応: PR-DEVELOPADDRESSREVIEW-046）。

### ライフサイクル・再設計アーキテクチャ詳細
#### SP-DEVELOPADDRESSREVIEW-058 停止状態名の統一
停止状態名を stopped_triage, stopped_implement, stopped_push, stopped_ci, stopped_drift に分類しなければならない（対応: PR-DEVELOPADDRESSREVIEW-058）。

#### SP-DEVELOPADDRESSREVIEW-059 停止からの再開決定表
停止状態に応じた再開ポイントを決定表で一意に決定しなければならない（対応: PR-DEVELOPADDRESSREVIEW-059）。

#### SP-DEVELOPADDRESSREVIEW-065 停止中の追加指示処理
停止中に投入された追加入力（answers）を検証して取り込まなければならない（対応: PR-DEVELOPADDRESSREVIEW-065）。

#### SP-DEVELOPADDRESSREVIEW-063 常時不変条件（Invariants）
未コミット差分が存在する状態での返信・resolve 実行を絶対禁止しなければならない（対応: PR-DEVELOPADDRESSREVIEW-063）。

#### SP-DEVELOPADDRESSREVIEW-060 全体完了の成立条件
全指摘の処理完了、CI グリーン、全対象 thread への返信および resolve 完了を全体完了条件としなければならない（対応: PR-DEVELOPADDRESSREVIEW-060）。

#### SP-DEVELOPADDRESSREVIEW-067 トリアージ構造の保持と引き渡し
triager が出力した構造化 JSON を変形せずそのまま implementer および返信役に渡さなければならない（対応: PR-DEVELOPADDRESSREVIEW-067）。

#### SP-DEVELOPADDRESSREVIEW-068 子スキル停止情報の継承
develop:implement から受領したチケット・世代情報を自 state に統合しなければならない（対応: PR-DEVELOPADDRESSREVIEW-068）。

## 決定表（Decision Tables）

### 1. トリアージ分類・対応決定表
| 分類結果 | 修正委託 (implement) | 返信内容 | 自動 Resolve |
|---|---|---|---|
| fix | 委託する | 修正コミットハッシュを添えて報告 | CI 合格後に resolve |
| already_fixed | 委託しない | 解消済みコミットハッシュを添えて報告 | CI 合格後に resolve |
| reject | 委託しない | 棄却の技術的根拠を添えて返信 | resolve しない (人間確認) |
| discuss | 委託しない | ユーザー判断待ちのため停止 | resolve しない |
| question | 委託しない | 回答または質問への返答を送信 | resolve しない |

### 2. CI ステータスと進行決定表
| required checks ステータス | アクション |
|---|---|
| 全件 SUCCESS | 返信・resolve 段へ進む |
| 1件以上 FAILURE / CANCELLED | ci_failed として停止（コード自動修正は禁止） |
| PENDING / IN_PROGRESS | ポーリング継続（タイムアウト時は stopped_ci） |

### 3. 停止段（--stop-at）決定表
| --stop-at 指定値 | 実行する段 | 停止する地点 |
|---|---|---|
| triage | 指摘収集・分類 | 分類完了後に停止 |
| implement | 分類・修正実装 | コミット完了後（push 前）に停止 |
| push | 分類・修正・push | push 完了後（CI 待ち前）に停止 |
| ci | 分類・修正・push・CI待ち | CI 完了後（返信前）に停止 |
| none (既定) | 全段完走 | 返信・resolve 完了後に正常終了 |
