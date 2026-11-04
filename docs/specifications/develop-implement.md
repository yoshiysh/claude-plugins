# 仕様書: develop:implement スキル詳細仕様

## 表記規約

仕様項目の語尾の区分は `docs/requirements/develop-implement.md` の「表記規約」に従う（必須 = 〜しなければならない、推奨 = 〜することが望ましい、許容 = 〜してもよい、禁止 = 〜してはならない）。

## 対象範囲

本文書は、develop:implement スキルの計画策定、実装ループ、テスト検証、レビュー委託、照合、コミット・プッシュ、および停止・再開制御の仕様を定める。

### 本文書が実現する要求
- 主担当: `docs/requirements/develop-implement.md` の全要求（PR-DEVELOPIMPLEMENT-001 〜 PR-DEVELOPIMPLEMENT-085、全85項目）。

## 機能仕様

### 目標と前提
#### SP-DEVELOPIMPLEMENT-001 目標の不変固定
run 開始時に設定された目標文（goal）は、run 完了または異常終了まで一切変更してはならない（対応: PR-DEVELOPIMPLEMENT-001）。

#### SP-DEVELOPIMPLEMENT-036 依頼文の完全保存
ユーザーの初期プロンプトは input.md に逐語で記録し、要約・改変してはならない（対応: PR-DEVELOPIMPLEMENT-036）。

#### SP-DEVELOPIMPLEMENT-037 目標への付加禁止
依頼文に含まれない推測や独自の目標を目標定義に追加してはならない（対応: PR-DEVELOPIMPLEMENT-037）。

#### SP-DEVELOPIMPLEMENT-038 依頼文と目標の改竄防止
実行中のいかなるエージェントも input.md および goal.txt を上書きしてはならない（対応: PR-DEVELOPIMPLEMENT-038）。

#### SP-DEVELOPIMPLEMENT-002 人間回答の履歴追記
ユーザーからの回答は answers.jsonl にタイムスタンプ付きで append-only で記録しなければならない（対応: PR-DEVELOPIMPLEMENT-002）。

#### SP-DEVELOPIMPLEMENT-052 記録回答のコンテキスト注入
後続の計画・実装ロールには answers.jsonl の全履歴を前提として注入しなければならない（対応: PR-DEVELOPIMPLEMENT-052）。

#### SP-DEVELOPIMPLEMENT-003 方針版の照合
渡された policy_commit がローカル git オブジェクトに実在することを git cat-file -e で照合しなければならない（対応: PR-DEVELOPIMPLEMENT-003）。

#### SP-DEVELOPIMPLEMENT-004 照合先ブランチの導出
PR 対象時は PR の baseRefName、それ以外は HEAD の追跡リモートブランチを照合先ブランチとして導出しなければならない（対応: PR-DEVELOPIMPLEMENT-004）。

#### SP-DEVELOPIMPLEMENT-053 未存在ブランチのエラー停止
名指しされたブランチが remote に存在しない場合、終了コード 2 で即座にエラー停止しなければならない（対応: PR-DEVELOPIMPLEMENT-053）。

#### SP-DEVELOPIMPLEMENT-005 SHA-1/SHA-256 検証
方針コミットハッシュが 40 桁または 64 桁の 16 進数であることを正規表現で検証しなければならない（対応: PR-DEVELOPIMPLEMENT-005）。

### 計画・適用・ヒント
#### SP-DEVELOPIMPLEMENT-006 計画実行の二重化
計画策定役（planner）と計画審査役（plan-reviewer）を分離し、双方が承認した計画のみを作業ツリーに適用しなければならない（対応: PR-DEVELOPIMPLEMENT-006）。

#### SP-DEVELOPIMPLEMENT-007 計画審査不合格時の差し戻し
審査役がリジェクトした場合、最大 3 回まで計画の修正ループを回し、超過時は停止しなければならない（対応: PR-DEVELOPIMPLEMENT-007）。

#### SP-DEVELOPIMPLEMENT-008 人間判断要求時の安全停止
計画策定で重大なトレードオフが生じた場合、needs_decision で停止し、ユーザーに選択肢を提示しなければならない（対応: PR-DEVELOPIMPLEMENT-008）。

#### SP-DEVELOPIMPLEMENT-009 計画段階での作業ツリー不変性
計画作成および審査中は、作業ツリー内のいかなるコードファイルも変更してはならない（対応: PR-DEVELOPIMPLEMENT-009）。

#### SP-DEVELOPIMPLEMENT-039 停止中のヒント受付口
停止中、ユーザーは hints.jsonl に追記することで外部から指示を補正できなければならない（対応: PR-DEVELOPIMPLEMENT-039）。

#### SP-DEVELOPIMPLEMENT-040 ヒントの取り込み
再開時、新しく追記されたヒントを読み込み、前提 snapshot を更新しなければならない（対応: PR-DEVELOPIMPLEMENT-040）。

#### SP-DEVELOPIMPLEMENT-065 ヒント反映後のベースライン再測定
ヒントによって計画が再作成された場合、変更適用前に初期 check を再実行しなければならない（対応: PR-DEVELOPIMPLEMENT-065）。

#### SP-DEVELOPIMPLEMENT-067 ベースライン結果欠如時の測定強制
開始時の check 結果が存在しない場合、直ちに check コマンドを実行して記録しなければならない（対応: PR-DEVELOPIMPLEMENT-067）。

#### SP-DEVELOPIMPLEMENT-066 ヒント反映計画の承認ゲート
ヒントにより改訂された計画は、再度 plan-reviewer の承認を通さなければならない（対応: PR-DEVELOPIMPLEMENT-066）。

#### SP-DEVELOPIMPLEMENT-041 ヒント入力ガイダンス提示
needs_input で停止する際、ヒントの投入方法とフォーマット例を提示しなければならない（対応: PR-DEVELOPIMPLEMENT-041）。

#### SP-DEVELOPIMPLEMENT-042 不正状態でのヒント拒否
実行中（running）の run に対して直接ヒントを投入することを排他ロックで拒絶しなければならない（対応: PR-DEVELOPIMPLEMENT-042）。

### Check と検証
#### SP-DEVELOPIMPLEMENT-010 Check 設定未宣言時の停止
.develop.json に check コマンドが宣言されていない場合、推測せずエラー停止しなければならない（対応: PR-DEVELOPIMPLEMENT-010）。

#### SP-DEVELOPIMPLEMENT-011 Check コマンド推測の禁止
「おそらく cargo test だろう」といった推測でコマンドを自動決定してはならない（対応: PR-DEVELOPIMPLEMENT-011）。

#### SP-DEVELOPIMPLEMENT-012 計画確認用停止オプション
CLI 引数 --plan-only が指定された場合、計画承認完了時点で status="planned" として停止しなければならない（対応: PR-DEVELOPIMPLEMENT-012）。

#### SP-DEVELOPIMPLEMENT-013 計画停止からの再開手順
--resume <run_id> 引数により、承認済み計画の適用ステップから再開可能としなければならない（対応: PR-DEVELOPIMPLEMENT-013）。

#### SP-DEVELOPIMPLEMENT-014 作業ツリー予期せぬ変更の検知
計画停止中に作業ツリーの git status が変化していた場合、安全のため再開を拒絶しなければならない（対応: PR-DEVELOPIMPLEMENT-014）。

#### SP-DEVELOPIMPLEMENT-015 差分検知時の上書き禁止
外部変更が検知された場合、既存の作業ツリーを上書き復元せずエラー終了しなければならない（対応: PR-DEVELOPIMPLEMENT-015）。

#### SP-DEVELOPIMPLEMENT-016 実装前ベースライン check
コード変更を行う直前に必ず宣言された check を実行し、baseline_check.json に保存しなければならない（対応: PR-DEVELOPIMPLEMENT-016）。

#### SP-DEVELOPIMPLEMENT-017 未定義 check の実行禁止
宣言された check コマンド以外の任意のシェルコマンドを実行してはならない（対応: PR-DEVELOPIMPLEMENT-017）。

### 実装と修正ループ
#### SP-DEVELOPIMPLEMENT-018 実装役（Implementer）の単独書き込み権
作業ツリーへのファイル書き込みは、implementer ロールのみに許可しなければならない（対応: PR-DEVELOPIMPLEMENT-018）。

#### SP-DEVELOPIMPLEMENT-043 計画外変更の拒否
計画書に記載されていないファイルの追加・変更・削除を検知した場合、変更をリジェクトしなければならない（対応: PR-DEVELOPIMPLEMENT-043）。

#### SP-DEVELOPIMPLEMENT-058 実装破棄とクリーンロールバック
実装役が失敗した場合、git reset --hard または git checkout で変更前の状態に完全に復元しなければならない（対応: PR-DEVELOPIMPLEMENT-058）。

#### SP-DEVELOPIMPLEMENT-059 修正後 check の差分比較
変更適用後の check 結果は、ベースライン check と比較し、新たな回帰（regression）がないことを判定しなければならない（対応: PR-DEVELOPIMPLEMENT-059）。

#### SP-DEVELOPIMPLEMENT-060 修正回数上限カウンタ
実装・修正の反復回数は run_state.iteration でカウントし、上限（既定 5 回）を厳格に管理しなければならない（対応: PR-DEVELOPIMPLEMENT-060）。

#### SP-DEVELOPIMPLEMENT-044 修正不要時の安全早期終了
指摘や要件に対し既存コードで既に満たされており変更不要と判定された場合、無駄なファイル変更を行わず終了しなければならない（対応: PR-DEVELOPIMPLEMENT-044）。

#### SP-DEVELOPIMPLEMENT-073 虚偽の変更不要報告の検出
要件が未達であるにもかかわらず「変更不要」と報告された場合、verifier がそれを検知して差し戻さなければならない（対応: PR-DEVELOPIMPLEMENT-073）。

#### SP-DEVELOPIMPLEMENT-061 変更不要時の結果明記
変更不要で終了した場合、その客観的根拠（既存テスト通過ログ等）を report に明記しなければならない（対応: PR-DEVELOPIMPLEMENT-061）。

#### SP-DEVELOPIMPLEMENT-019 変更後 check 必須合格
コード変更後の check が exit code 0 で通過しない限り、レビュー段へ進んではならない（対応: PR-DEVELOPIMPLEMENT-019）。

#### SP-DEVELOPIMPLEMENT-020 テストケース設計基準
テストコード作成時は、正常系・異常系・境界値のケースを網羅しなければならない（対応: PR-DEVELOPIMPLEMENT-020）。

#### SP-DEVELOPIMPLEMENT-054 不正テスト基準の拒絶
アサーションのない空のテストや常に pass するテストの作成をレビューで検知・拒絶しなければならない（対応: PR-DEVELOPIMPLEMENT-054）。

#### SP-DEVELOPIMPLEMENT-021 修正上限到達時の停止
修正ループが上限回数に達した場合、iteration_limit_reached で停止しなければならない（対応: PR-DEVELOPIMPLEMENT-021）。

#### SP-DEVELOPIMPLEMENT-022 上限到達時の作業ツリー保全
上限到達で停止する場合、最新の試行コードは破棄せず作業ツリーに残し、手動修正を可能にしなければならない（対応: PR-DEVELOPIMPLEMENT-022）。

#### SP-DEVELOPIMPLEMENT-055 手動修正後の再開
ユーザーが作業ツリーを手動修正した後、--resume でレビュー段から再開可能としなければならない（対応: PR-DEVELOPIMPLEMENT-055）。

#### SP-DEVELOPIMPLEMENT-072 上限到達からの計画改訂再開
手動修正ではなく方針変更による再開の場合、計画策定段へロールバックして再開しなければならない（対応: PR-DEVELOPIMPLEMENT-072）。

### レビュー委託と照合
#### SP-DEVELOPIMPLEMENT-023 develop:review スキル呼び出し
実装後のレビューは、同一プラグインの develop:review をスキル呼び出しで起動しなければならない（対応: PR-DEVELOPIMPLEMENT-023）。

#### SP-DEVELOPIMPLEMENT-024 review 上限停止の伝播
develop:review が上限停止した場合、その状態をそのまま implement 側の停止として上位に返さなければならない（対応: PR-DEVELOPIMPLEMENT-024）。

#### SP-DEVELOPIMPLEMENT-075 呼び直しデッドロック防止
develop:review の呼び出しが同じ状態で 3 回連続失敗した場合、巡回停止しなければならない（対応: PR-DEVELOPIMPLEMENT-075）。

#### SP-DEVELOPIMPLEMENT-025 レビュー結果の構造化記録
review が返した指摘一覧、合否ステータス、観点ログを review_result.json に保存しなければならない（対応: PR-DEVELOPIMPLEMENT-025）。

#### SP-DEVELOPIMPLEMENT-077 状態欠如レスポンスのエラー処理
review の返却値に status や findings が欠落していた場合、不正レスポンスとして停止しなければならない（対応: PR-DEVELOPIMPLEMENT-077）。

#### SP-DEVELOPIMPLEMENT-045 review failed 時の修正キューイング
review が failed を返した場合、含まれる確定指摘を implementer の修正キューに投入しなければならない（対応: PR-DEVELOPIMPLEMENT-045）。

#### SP-DEVELOPIMPLEMENT-026 返却値スキーマの機械照合
review の返却 JSON が review_schema.json に完全に適合しているかをバリデータで検証しなければならない（対応: PR-DEVELOPIMPLEMENT-026）。

#### SP-DEVELOPIMPLEMENT-056 不正形式の即時拒否
スキーマ不適合な返却値を受け取った場合、後続処理に流さずエラー停止しなければならない（対応: PR-DEVELOPIMPLEMENT-056）。

#### SP-DEVELOPIMPLEMENT-027 確定指摘のみの修正対象化
未検証（unverified）の指摘は修正対象から除外（または人間判断へ回し）、確定（confirmed）指摘のみを修正しなければならない（対応: PR-DEVELOPIMPLEMENT-027）。

#### SP-DEVELOPIMPLEMENT-028 未検証指摘の人間エスカレーション
未検証の指摘が残存する場合、自動で修正せず、人間確認用フラグを立てて停止しなければならない（対応: PR-DEVELOPIMPLEMENT-028）。

#### SP-DEVELOPIMPLEMENT-046 設計破綻時の断念 (abandon)
指摘の修正が根本的な仕様矛盾を引き起こす場合、status="abandoned" で停止しなければならない（対応: PR-DEVELOPIMPLEMENT-046）。

#### SP-DEVELOPIMPLEMENT-047 abandon 停止時の詳細報告
断念停止時、矛盾する要求 ID と設計上の理由を明記したレポートを出力しなければならない（対応: PR-DEVELOPIMPLEMENT-047）。

#### SP-DEVELOPIMPLEMENT-062 abandon 時の人間裁定
断念状態からの復帰には、ユーザーによる要求の修正または明示的な例外許可を必須としなければならない（対応: PR-DEVELOPIMPLEMENT-062）。

#### SP-DEVELOPIMPLEMENT-063 指摘数の正確な計量
confirmed, rejected, unverified の各件数を正確にカウントしてサマリに表示しなければならない（対応: PR-DEVELOPIMPLEMENT-063）。

#### SP-DEVELOPIMPLEMENT-064 同一指摘のループ防止
既に修正を試みて失敗した指摘 ID については、重複して同じ修正を適用してはならない（対応: PR-DEVELOPIMPLEMENT-064）。

#### SP-DEVELOPIMPLEMENT-048 abandon 時のコミット・プッシュ絶対禁止
断念状態で作業ツリーの変更をコミットまたはリモートへプッシュしてはならない（対応: PR-DEVELOPIMPLEMENT-048）。

#### SP-DEVELOPIMPLEMENT-029 レビュー合否判定の進行分岐
review が pass の場合は最終照合へ進み、fail の場合は修正段へループバックしなければならない（対応: PR-DEVELOPIMPLEMENT-029）。

#### SP-DEVELOPIMPLEMENT-074 修正対象件数のゼロ判定
未修正の確定指摘が 0 件になったことを確認して初めて完了判定へ進まなければならない（対応: PR-DEVELOPIMPLEMENT-074）。

#### SP-DEVELOPIMPLEMENT-030 未レビュー範囲の透明性報告
方針文書で除外されたファイルや閲覧不能だった範囲を report の「未検証範囲」に明記しなければならない（対応: PR-DEVELOPIMPLEMENT-030）。

### 最終照合・コミット・プッシュ
#### SP-DEVELOPIMPLEMENT-071 完了前の未読ヒント検査
完了処理に入る直前、hints.jsonl に未処理のヒントが残っていないかを再確認しなければならない（対応: PR-DEVELOPIMPLEMENT-071）。

#### SP-DEVELOPIMPLEMENT-057 最終照合の実行
コミット直前に、計画と実際の git diff、全 check コマンドの再実行、および review 合格証跡の 3 点を最終照合しなければならない（対応: PR-DEVELOPIMPLEMENT-057）。

#### SP-DEVELOPIMPLEMENT-031 最終照合不合格時のコミット阻止
最終照合の 1 項目でも失敗した場合、コミットを中止しエラー停止しなければならない（対応: PR-DEVELOPIMPLEMENT-031）。

#### SP-DEVELOPIMPLEMENT-032 最終照合不合格時の変更保全
最終照合失敗時、作業ツリーを消去せず、デバッグ用として残さなければならない（対応: PR-DEVELOPIMPLEMENT-032）。

#### SP-DEVELOPIMPLEMENT-033 コミットの実行規約
全照合通過後、Conventional Commits 規約に従ったメッセージで git commit を実行しなければならない（対応: PR-DEVELOPIMPLEMENT-033）。

#### SP-DEVELOPIMPLEMENT-034 プッシュの実行規約
--no-push 引数が指定されていない限り、コミット後に現在の作業ブランチをリモートへ push しなければならない（対応: PR-DEVELOPIMPLEMENT-034）。

#### SP-DEVELOPIMPLEMENT-049 address-review からの修正受託時
address-review から呼び出された場合、コミットのみを行い、プッシュは address-review 側に委ねなければならない（対応: PR-DEVELOPIMPLEMENT-049）。

#### SP-DEVELOPIMPLEMENT-051 PR 修正時の push 抑止
address-review 連携フラグが有効な場合、implement 単体でのリモート push を抑止しなければならない（対応: PR-DEVELOPIMPLEMENT-051）。

#### SP-DEVELOPIMPLEMENT-050 プッシュ拒絶時の安全停止
リモートの pre-push hook や権限不足で push が失敗した場合、コミットは維持したまま停止しなければならない（対応: PR-DEVELOPIMPLEMENT-050）。

#### SP-DEVELOPIMPLEMENT-035 最終成功結果の返却
コミットハッシュ、変更ファイル一覧、実行ログパスを含む成功 JSON を返却しなければならない（対応: PR-DEVELOPIMPLEMENT-035）。

### ライフサイクル・アーキテクチャ詳細
#### SP-DEVELOPIMPLEMENT-068 停止状態の標準分類
停止状態を stopped, needs_decision, needs_input, iteration_limit_reached, abandoned に厳格分類しなければならない（対応: PR-DEVELOPIMPLEMENT-068）。

#### SP-DEVELOPIMPLEMENT-069 再開マッピング決定表
停止分類に応じた適切な再開エントリーポイントを決定表に従って決定しなければならない（対応: PR-DEVELOPIMPLEMENT-069）。

#### SP-DEVELOPIMPLEMENT-076 停止中の不正追加入力拒絶
未定義の JSON 形式で入力が渡された場合、パースエラーとして再開を拒絶しなければならない（対応: PR-DEVELOPIMPLEMENT-076）。

#### SP-DEVELOPIMPLEMENT-078 実装後停止からの新規起動
完了後の run に対する再実行要求は、新しい run_id を採番して新規起動しなければならない（対応: PR-DEVELOPIMPLEMENT-078）。

#### SP-DEVELOPIMPLEMENT-070 完了の厳格定義
最終 check 成功、review pass、未解決指摘 0 件、コミット完了の 4 条件をすべて満たしたときのみ完了としなければならない（対応: PR-DEVELOPIMPLEMENT-070）。

#### SP-DEVELOPIMPLEMENT-079 規範文書洗い出し段
計画策定に先立ち、関連する要求仕様書・アーキテクチャ文書を grep/find してリストアップする「洗い出し段」を設けなければならない（対応: PR-DEVELOPIMPLEMENT-079）。

#### SP-DEVELOPIMPLEMENT-080 条件別ケース計画
計画書には、正常系だけでなく想定される境界条件と例外ケースをマトリクスで記述しなければならない（対応: PR-DEVELOPIMPLEMENT-080）。

#### SP-DEVELOPIMPLEMENT-081 作業ファイルの分離と独立性
各ロールの一時作業ファイルは .develop/run_<id>/ 配下に完全隔離して作成しなければならない（対応: PR-DEVELOPIMPLEMENT-081）。

#### SP-DEVELOPIMPLEMENT-082 同一 run 内再開の票引き渡し
同一 run 内での再開時、前回の最終承認票（ticket）を次のステップの入力として引き渡さなければならない（対応: PR-DEVELOPIMPLEMENT-082）。

#### SP-DEVELOPIMPLEMENT-083 範囲外指摘の根本原因探索
レビュー指摘が計画範囲外のファイルに起因する場合、「根を探す段（root-finder）」を起動して真の原因を特定しなければならない（対応: PR-DEVELOPIMPLEMENT-083）。

#### SP-DEVELOPIMPLEMENT-084 範囲拡大の人為的承認ゲート
計画外のファイルへ変更範囲を広げる必要がある場合、ユーザーの承認（yes/no）を必須としなければならない（対応: PR-DEVELOPIMPLEMENT-084）。

#### SP-DEVELOPIMPLEMENT-085 環境・前提障害の即時停止
ディスク容量不足や環境変数欠落を検知した場合、修正ループを回さず即座に停止しなければならない（対応: PR-DEVELOPIMPLEMENT-085）。

## 決定表（Decision Tables）

### 1. 計画策定・審査決定表
| Planner 出力 | Plan-Reviewer 判定 | 試行回数 | アクション |
|---|---|---|---|
| 計画策定完了 | 承認 (approved) | 任意 | 実装前ベースライン check へ進む |
| 計画策定完了 | 差し戻し (rejected) | < 3 回 | 指摘を反映して計画を再策定する |
| 計画策定完了 | 差し戻し (rejected) | >= 3 回 | 計画策定上限到達として needs_decision で停止 |
| 計画策定不能 | - | 任意 | 仕様曖昧として needs_input で停止 |

### 2. レビュー結果と進行決定表
| Review ステータス | 確定指摘件数 | 未検証指摘件数 | アクション |
|---|---|---|---|
| pass | 0 | 0 | 最終照合・コミット段へ進む |
| pass | 0 | > 0 | 未検証指摘の確認のため needs_decision で停止 |
| fail | > 0 | 任意 | 確定指摘を修正キューに入れ、実装ループへ |
| abandoned | 任意 | 任意 | 修正不能な仕様破綻として停止 |
| error / timeout | 任意 | 任意 | 一時エラーとして停止、リトライ可能にする |

### 3. コミット・プッシュ決定表
| 最終照合 | address-review 連携 | --no-push 引数 | コミット | プッシュ |
|---|---|---|---|---|
| 合格 | false | false | 実行 | 実行 |
| 合格 | false | true | 実行 | スキップ |
| 合格 | true | 任意 | 実行 | スキップ (親に委託) |
| 不合格 | 任意 | 任意 | 中止 | 中止 (エラー停止) |
