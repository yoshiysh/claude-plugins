# 仕様書: develop:review スキル詳細仕様

## 表記規約

仕様項目の語尾の区分は `docs/requirements/develop-review.md` の「表記規約」に従う（必須 = 〜しなければならない、推奨 = 〜することが望ましい、許容 = 〜してもよい、禁止 = 〜してはならない）。

## 対象範囲

本文書は、develop:review スキルの観点選定、二段検証（レビュー役と検証役の分離）、指摘の確定と格付け、未読資産管理、および GitHub PR コメント投稿の仕様を定める。

### 本文書が実現する要求
- 主担当: `docs/requirements/develop-review.md` の全要求（PR-DEVELOPREVIEW-001 〜 PR-DEVELOPREVIEW-080、全80項目）。

## 機能仕様

### 目標と対象の固定
#### SP-DEVELOPREVIEW-001 目標の不変固定
run 開始時のレビュー対象（PR番号、コミットハッシュ、パス一覧）は固定し、run の途中で動的に変更してはならない（対応: PR-DEVELOPREVIEW-001）。

#### SP-DEVELOPREVIEW-002 非チェックアウトPRの安全取得
PR を作業ツリーに checkout せずにレビューする場合、gh pr diff または git fetch で一時参照を取得しなければならない（対応: PR-DEVELOPREVIEW-002）。

#### SP-DEVELOPREVIEW-003 pin 値（固定ハッシュ）の照合
対象 PR の最新コミットハッシュ（pin）を取得・記録し、run 終了まで pin が動いていないことを検証しなければならない（対応: PR-DEVELOPREVIEW-003）。

### 観点の閉集合と方針文書
#### SP-DEVELOPREVIEW-004 観点の閉集合原則
適用するレビュー観点は、方針文書および組み込み観点の定義から静的に定まる閉集合とし、run の途中で恣意的に増やしてはならない（対応: PR-DEVELOPREVIEW-004）。

#### SP-DEVELOPREVIEW-005 方針文書未存在時の既定観点
方針文書が存在しない場合、core-correctness, core-security, core-maintainability の 3 つの既定観点を閉集合としなければならない（対応: PR-DEVELOPREVIEW-005）。

#### SP-DEVELOPREVIEW-006 必須適用観点（Mandatory Viewpoints）
アーキテクチャ規約およびテスト基準の観点は、変更内容に関わらず必ず評価しなければならない（対応: PR-DEVELOPREVIEW-006）。

#### SP-DEVELOPREVIEW-007 必須観点の出所明記
各観点がどの文書（REVIEW.md、AGENTS.md、公式ガイドライン等）に由来するかを出典として記録しなければならない（対応: PR-DEVELOPREVIEW-007）。

#### SP-DEVELOPREVIEW-008 方針文書欠落時の必須観点
方針文書が読めない場合でも、静的解析エラー・テスト不通過・機密情報漏洩の検査は必須としなければならない（対応: PR-DEVELOPREVIEW-008）。

#### SP-DEVELOPREVIEW-009 方針文書に基づく観点の動的導出
REVIEW.md に記載された「読むもの」テーブルから、対象ファイル種別に応じた専用観点を抽出しなければならない（対応: PR-DEVELOPREVIEW-009）。

#### SP-DEVELOPREVIEW-068 未定義ファイル種別のフォールバック観点
「読むもの」テーブルに定義がない拡張子のファイルには、汎用のコード整合性観点を適用しなければならない（対応: PR-DEVELOPREVIEW-068）。

#### SP-DEVELOPREVIEW-010 計画審査による不正観点の排除
レビュー計画（どのファイルにどの観点を当てるか）を作成し、過不足がないか検証ゲートで審査しなければならない（対応: PR-DEVELOPREVIEW-010）。

#### SP-DEVELOPREVIEW-011 スキルファイル固有の観点割り当て
SKILL.md や agent 定義ファイルには、best-practices 規約準拠の観点を必ず割り当てなければならない（対応: PR-DEVELOPREVIEW-011）。

#### SP-DEVELOPREVIEW-012 スキル観点における規則参照
スキルをレビューする際は、docs/guidelines/ および skill-design-patterns.md の規則を照合基準としなければならない（対応: PR-DEVELOPREVIEW-012）。

#### SP-DEVELOPREVIEW-013 「読むもの」参照の完全解決
方針文書内の相対リンクやファイル参照をリポジトリルート基準で完全に解決しなければならない（対応: PR-DEVELOPREVIEW-013）。

#### SP-DEVELOPREVIEW-061 基点ディレクトリ未宣言時のルート適用
基点ディレクトリの宣言がない場合、リポジトリのルート（.git の親）を基点として解決しなければならない（対応: PR-DEVELOPREVIEW-061）。

#### SP-DEVELOPREVIEW-062 未解決参照の透明性記録
存在しないファイルへの参照があった場合、missing_policy_doc として記録し、スキップ理由を明記しなければならない（対応: PR-DEVELOPREVIEW-062）。

#### SP-DEVELOPREVIEW-014 方針文書未配置の報告
方針文書が存在しないリポジトリの場合、標準規約のみでレビューした旨をサマリに明記しなければならない（対応: PR-DEVELOPREVIEW-014）。

#### SP-DEVELOPREVIEW-015 構文不正方針文書の処理
REVIEW.md の構文が破損している場合、警告を記録した上でフォールバック規約を適用しなければならない（対応: PR-DEVELOPREVIEW-015）。

#### SP-DEVELOPREVIEW-063 参照先文書読取不能時の扱い
参照先ファイルが読み取り権限不足等の場合、当該観点のみ unverified として扱わなければならない（対応: PR-DEVELOPREVIEW-063）。

#### SP-DEVELOPREVIEW-064 読取不能文書の構造化申告
読めなかった文書パスの一覧を unreadable_docs 配列として結果 JSON に含めなければならない（対応: PR-DEVELOPREVIEW-064）。

### 対象分類と重大度
#### SP-DEVELOPREVIEW-016 ファイル種別の 4 分類
全対象差分を docs, spec, test, impl の 4 種に分類し、各ロールへ提示しなければならない（対応: PR-DEVELOPREVIEW-016）。

#### SP-DEVELOPREVIEW-017 spec/prd 宣言未存在時の判定
spec/prd ディレクトリが宣言されていない場合、docs/requirements/ および docs/specifications/ を既定パスとしなければならない（対応: PR-DEVELOPREVIEW-017）。

#### SP-DEVELOPREVIEW-059 除外宣言未存在時のデフォルト除外
除外設定がない場合、node_modules/, target/, dist/, .git/ を自動除外しなければならない（対応: PR-DEVELOPREVIEW-059）。

#### SP-DEVELOPREVIEW-060 自動生成物の除外
package-lock.json, Cargo.lock, 自動生成コード等の差分はノイズ防止のためレビュー対象から除外しなければならない（対応: PR-DEVELOPREVIEW-060）。

#### SP-DEVELOPREVIEW-018 指摘重大度の語彙統一
指摘の重大度（severity）は blocking, non-blocking, suggestion の 3 レベルに厳格統制しなければならない（対応: PR-DEVELOPREVIEW-018）。

### Focus（注目点・引用）と独立二段検証
#### SP-DEVELOPREVIEW-019 Focus 作成役の責務
一次レビュアーは、指摘箇所を示すファイルパス、行番号、および該当コードの引用（focus）を作成しなければならない（対応: PR-DEVELOPREVIEW-019）。

#### SP-DEVELOPREVIEW-020 Focus の完全引用規約
focus に含めるコード片は、実際の対象ファイルの内容と完全一致（whitespace 含む）させなければならない（対応: PR-DEVELOPREVIEW-020）。

#### SP-DEVELOPREVIEW-065 方針文書未存在時の Focus 生成
方針文書がない場合でも、違反とみなした客観的なコード断片を必ず focus として引用しなければならない（対応: PR-DEVELOPREVIEW-065）。

#### SP-DEVELOPREVIEW-021 Focus 作成時の対象コード不変性
Focus 作成役はいかなるファイルも編集してはならない（対応: PR-DEVELOPREVIEW-021）。

#### SP-DEVELOPREVIEW-022 不整合 Focus の棄却
実在しない行番号や不一致の引用を持つ指摘は、構文検証ゲートで棄却しなければならない（対応: PR-DEVELOPREVIEW-022）。

#### SP-DEVELOPREVIEW-023 Focus の省略禁止
行を特定できる指摘について、focus の記述を省略してはならない（対応: PR-DEVELOPREVIEW-023）。

#### SP-DEVELOPREVIEW-024 二段検証による指摘の確定
一次レビュアーの作成した指摘は、独立した検証役（verifier）が成果物と criteria だけを見て追認して初めて確定（confirmed）としなければならない（対応: PR-DEVELOPREVIEW-024）。

#### SP-DEVELOPREVIEW-025 確定に必要な検証票
確定には、verifier ロールが発行した合格署名（vote: confirm）を含む検証票が必須でなければならない（対応: PR-DEVELOPREVIEW-025）。

### 資産台帳と未読検出
#### SP-DEVELOPREVIEW-026 レビュー資産台帳
対象ファイルごとに sha256 チェックサムを計算し、レビュー資産台帳（asset_ledger.json）に登録しなければならない（対応: PR-DEVELOPREVIEW-026）。

#### SP-DEVELOPREVIEW-027 閲覧履歴の記録
各レビュアーが実際に読み込んだファイルと行範囲を view_logs に記録しなければならない（対応: PR-DEVELOPREVIEW-027）。

#### SP-DEVELOPREVIEW-028 未読資産の追加レビュー起動
差分に含まれるファイルで一度もレビュアーに読まれていないものがある場合、追加のレビューイテレーションを起動しなければならない（対応: PR-DEVELOPREVIEW-028）。

#### SP-DEVELOPREVIEW-029 追加起動の上限回数
未読回収のための追加起動は最大 2 回までとし、残存分は未検証として報告しなければならない（対応: PR-DEVELOPREVIEW-029）。

### 結果返却とステータス
#### SP-DEVELOPREVIEW-030 レビュー結果ステータス
総合結果ステータスを pass, fail, unverified, stopped のいずれかとして出力しなければならない（対応: PR-DEVELOPREVIEW-030）。

#### SP-DEVELOPREVIEW-031 棄却指摘の記録
検証役によって反証・棄却された指摘は、棄却理由を添えて rejected_findings に保存しなければならない（対応: PR-DEVELOPREVIEW-031）。

#### SP-DEVELOPREVIEW-032 確定指摘の返却
二段検証を通った指摘のみを confirmed_findings 配列に格納して返却しなければならない（対応: PR-DEVELOPREVIEW-032）。

#### SP-DEVELOPREVIEW-069 未検証指摘の分離返却
検証役が判断不能とした指摘は unverified_findings に分離して返却しなければならない（対応: PR-DEVELOPREVIEW-069）。

#### SP-DEVELOPREVIEW-033 未審査範囲の申告
時間・予算制約で審査できなかったファイル一覧を unreviewed_files として必ず明記しなければならない（対応: PR-DEVELOPREVIEW-033）。

#### SP-DEVELOPREVIEW-034 意図せぬ書き込み検知時の停止
レビュー実行中に作業ツリーへの変更を検知した場合、全結果を破棄してエラー停止しなければならない（対応: PR-DEVELOPREVIEW-034）。

#### SP-DEVELOPREVIEW-074 レビュー完了条件
全対象ファイルの審査が完了し、未読資産 0 件、かつ全指摘の二段検証が終了したときのみ完了としなければならない（対応: PR-DEVELOPREVIEW-074）。

### 予算と停止・再開制御
#### SP-DEVELOPREVIEW-035 起動数上限の受領
呼び出し引数または環境変数から最大エージェント起動数（max_subagents）を受け取らなければならない（対応: PR-DEVELOPREVIEW-035）。

#### SP-DEVELOPREVIEW-071 Codex runner 起動数上限
Codex 環境では起動数上限を既定値 10 回として枠を管理しなければならない（対応: PR-DEVELOPREVIEW-071）。

#### SP-DEVELOPREVIEW-036 上限未指定時の安全既定値
上限が渡されない場合、最大起動数を 8 回として初期化しなければならない（対応: PR-DEVELOPREVIEW-036）。

#### SP-DEVELOPREVIEW-070 枠不足時の項目分割
1 回の実行枠で全観点を処理できない場合、優先度の高い必須観点から順に枠を消費しなければならない（対応: PR-DEVELOPREVIEW-070）。

#### SP-DEVELOPREVIEW-037 枠の事前予約
検証役の起動枠をあらかじめ確保（リザーブ）し、一次レビューだけで枠を使い果たさないようにしなければならない（対応: PR-DEVELOPREVIEW-037）。

#### SP-DEVELOPREVIEW-038 起動数の厳密計測
サブプロセス起動、LLM API 呼び出し、外部スクリプト実行を 1 回の起動数として漏れなくインクリメントしなければならない（対応: PR-DEVELOPREVIEW-038）。

#### SP-DEVELOPREVIEW-066 上限到達時の返却構造体
枠上限に達した場合、status="limit_reached" と未着手項目一覧を返さなければならない（対応: PR-DEVELOPREVIEW-066）。

#### SP-DEVELOPREVIEW-039 枠超過項目の未着手登録
処理できなかったファイル・観点のペアを pending_queue に順序を維持して格納しなければならない（対応: PR-DEVELOPREVIEW-039）。

#### SP-DEVELOPREVIEW-040 未着手項目の優先順位付け
pending_queue 内の項目は、セキュリティ > 正確性 > 保守性の順でソートしなければならない（対応: PR-DEVELOPREVIEW-040）。

#### SP-DEVELOPREVIEW-041 停止時の中間結果永続化
停止時、確定済み指摘と未着手キューを state.json に保存しなければならない（対応: PR-DEVELOPREVIEW-041）。

#### SP-DEVELOPREVIEW-042 再開時の未着手キュー消化
再開時、前回の pending_queue の先頭から順に処理を再開しなければならない（対応: PR-DEVELOPREVIEW-042）。

#### SP-DEVELOPREVIEW-043 再開前 pin 不変照合
再開時に対象 PR の最新コミットを再取得し、保存された pin と完全一致することを保証しなければならない（対応: PR-DEVELOPREVIEW-043）。

#### SP-DEVELOPREVIEW-072 停止状態の命名
停止状態名を stopped_limit, stopped_unverified, stopped_pin_drift に分類しなければならない（対応: PR-DEVELOPREVIEW-072）。

#### SP-DEVELOPREVIEW-073 停止状態からの再開遷移
各停止状態からの再開遷移表に従って正しく状態を復元しなければならない（対応: PR-DEVELOPREVIEW-073）。

#### SP-DEVELOPREVIEW-077 停止中外部変更の遮断
停止中に PR に新しいコミットが push された場合、既存 run を再開せず破棄しなければならない（対応: PR-DEVELOPREVIEW-077）。

#### SP-DEVELOPREVIEW-044 再開セッションの権限継承
再開された run も初回実行と同一の読み取り専用権限を維持しなければならない（対応: PR-DEVELOPREVIEW-044）。

#### SP-DEVELOPREVIEW-045 並行エージェント数制御
同時に実行するサブエージェント数を最大 3 並列までに制限し、リソース枯渇を防がなければならない（対応: PR-DEVELOPREVIEW-045）。

#### SP-DEVELOPREVIEW-046 同種指摘の統合
LLM レビュー結果から重複する指摘をファイル・行番号・ルールのキーで名寄せ（dedup）しなければならない（対応: PR-DEVELOPREVIEW-046）。

### GitHub PR コメント投稿
#### SP-DEVELOPREVIEW-047 投稿条件の充足
--post フラグが有効、かつ呼び出し元が親スキルでない単独起動の場合のみ PR への投稿を許可しなければならない（対応: PR-DEVELOPREVIEW-047）。

#### SP-DEVELOPREVIEW-048 呼び出し元存在時の投稿抑止
develop:implement 等の親スキルから呼び出された場合、PR コメント投稿を行わず親へ返却しなければならない（対応: PR-DEVELOPREVIEW-048）。

#### SP-DEVELOPREVIEW-049 行不解決指摘のサマリ投稿
差分外の指摘や行が特定できない指摘は、インラインではなく PR 本文コメント（Review Summary）に集約して投稿しなければならない（対応: PR-DEVELOPREVIEW-049）。

#### SP-DEVELOPREVIEW-050 投稿前内容確認
投稿するコメントの内容（本文、行、パス）をログに出力し確認可能としなければならない（対応: PR-DEVELOPREVIEW-050）。

#### SP-DEVELOPREVIEW-051 投稿内容の不一致防止
二段検証で確定した内容と完全に同一のテキストのみを投稿しなければならない（対応: PR-DEVELOPREVIEW-051）。

#### SP-DEVELOPREVIEW-052 gh CLI 欠如時のフォールバック
gh コマンドが利用できない環境では、投稿をスキップして標準出力に投稿用 Markdown を出力しなければならない（対応: PR-DEVELOPREVIEW-052）。

#### SP-DEVELOPREVIEW-067 投稿失敗時の安全終了
GitHub API エラー等で投稿が失敗した場合でも、ローカルのレビュー結果は正常に保存して終了しなければならない（対応: PR-DEVELOPREVIEW-067）。

#### SP-DEVELOPREVIEW-075 同一 pin での二重投稿防止
同一コミットハッシュに対して既に投稿済みの指摘を重複投稿してはならない（対応: PR-DEVELOPREVIEW-075）。

#### SP-DEVELOPREVIEW-076 pin 変更後の旧指摘無効化
PR のコミットが進んだ場合、古いコミットに対するインラインコメント投稿を中止しなければならない（対応: PR-DEVELOPREVIEW-076）。

### Git 外対象・アーキテクチャ詳細
#### SP-DEVELOPREVIEW-053 Git 外対象の入力検証
git 管理外のテキストやファイルが渡された場合、対象パスの実在を確認しなければならない（対応: PR-DEVELOPREVIEW-053）。

#### SP-DEVELOPREVIEW-054 貼り付けテキストの隔離保存
プロンプトに直接貼り付けられたテキストは snippet_<id>.txt として一時保存し、対象化しなければならない（対応: PR-DEVELOPREVIEW-054）。

#### SP-DEVELOPREVIEW-055 Git 外対象の目標設定
貼り付けテキストに対するレビュー目標を明示的に設定しなければならない（対応: PR-DEVELOPREVIEW-055）。

#### SP-DEVELOPREVIEW-056 Git 外対象の観点限定
git 外のテキストには、一般的な文面品質、論理性、命名規則の観点のみを適用しなければならない（対応: PR-DEVELOPREVIEW-056）。

#### SP-DEVELOPREVIEW-057 Git 外対象の台帳管理
一時保存テキストのハッシュを台帳に記録し、同一テキストの二重審査を防がなければならない（対応: PR-DEVELOPREVIEW-057）。

#### SP-DEVELOPREVIEW-058 Git 外対象の範囲外明記
git 履歴やブランチコンテキストが存在しない旨をレポートに明記しなければならない（対応: PR-DEVELOPREVIEW-058）。

#### SP-DEVELOPREVIEW-078 洗い出し束の効率的配分
方針文書の束は、各レビュアーに必要な節のみをフィルタリングしてプロンプトサイズを圧縮しなければならない（対応: PR-DEVELOPREVIEW-078）。

#### SP-DEVELOPREVIEW-079 運搬役の軽量化と path/sum 照合
レビュアーから検証役への結果引き渡しは票（パスとハッシュ）で行い、本文の丸ごとコピーを禁止しなければならない（対応: PR-DEVELOPREVIEW-079）。

#### SP-DEVELOPREVIEW-080 前段指摘構造の厳格継承
前段のレビュアーが出力した指摘の JSON スキーマを検証役がそのまま引き継ぎ、欠落を防がなければならない（対応: PR-DEVELOPREVIEW-080）。

## 決定表（Decision Tables）

### 1. 二段検証指摘確定決定表
| 一次レビュー判定 | 検証役（Verifier）判定 | 指摘の確定ステータス | 後続処理 |
|---|---|---|---|
| 指摘あり (finding) | 追認 (confirm) | 確定 (confirmed) | confirmed_findings に格納 |
| 指摘あり (finding) | 反証・誤謬 (reject) | 棄却 (rejected) | rejected_findings に格納 |
| 指摘あり (finding) | 判断不能 (undetermined) | 未検証 (unverified) | unverified_findings に格納 |
| 指摘なし (no finding) | - | なし (none) | 次の観点へ進む |

### 2. PR コメント投稿決定表
| --post フラグ | 親スキルからの呼び出し | gh CLI 利用可能 | pin 一致 | アクション |
|---|---|---|---|---|
| true | false (単独起動) | true | true | GitHub PR へインライン/サマリ投稿 |
| true | false (単独起動) | false | 任意 | 標準出力に投稿用 Markdown 出力 |
| true | false (単独起動) | true | false | pin 不一致のため投稿中止 |
| 任意 | true (親経由) | 任意 | 任意 | 投稿抑止、親スキルへ結果返却 |
| false | 任意 | 任意 | 任意 | 投稿せずローカル結果ファイルに保存 |
