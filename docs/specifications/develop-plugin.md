# 仕様書: develop プラグイン共通アーキテクチャ・基盤契約

## 表記規約

仕様項目の語尾の区分は `docs/requirements/develop-plugin.md` の「表記規約」に従う（必須 = 〜しなければならない、推奨 = 〜することが望ましい、許容 = 〜してもよい、禁止 = 〜してはならない）。

## 対象範囲

本文書は、develop プラグイン（develop:implement, develop:review, develop:address-review）全体の共通基盤、呼び出し規約、実行環境適応、権限境界、状態・世代管理、および旧スキル移行を定める。

### 本文書が実現する要求
- 主担当: `docs/requirements/develop-plugin.md` の全要求（PR-DEVELOPPLUGIN-001 〜 PR-DEVELOPPLUGIN-088、欠番016を除く全87項目）。

## 用語定義

| 用語 | 意味 |
|---|---|
| develop | develop:implement, develop:review, develop:address-review の 3 スキルからなるプラグイン |
| 方針の版 | 利用側の宣言と方針文書を読む git commit ハッシュ（PR 対象時は PR 先頭 commit、作業ツリー時は HEAD） |
| 方針文書の束 | REVIEW.md およびその参照先から解決された文書集合 |
| 状態世代 (generation) | run の状態更新ごとに単調増加する整数。古い世代からの遅延書き込みを排斥する |
| 束予算 (budget) | 方針文書の合計行数/トークン量の上限。超過時は要約・切り詰めを行う |
| 票 (ticket) | 運搬役が引数として運ぶ最小メタデータ構造体。本文実体は含めない |
| 参照引き渡し (path/sum) | 本文実体をファイルに書き出し、パスと SHA-256 チェックサムで後続役に渡す方式 |

## データモデル・スキーマ仕様

### 1. 状態ヘッダスキーマ (`state.header.json`)
```json
{
  "": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["plugin", "skill", "run_id", "generation", "policy_commit", "created_at"],
  "properties": {
    "plugin": { "type": "string", "const": "develop" },
    "skill": { "type": "string", "enum": ["implement", "review", "address-review"] },
    "run_id": { "type": "string" },
    "generation": { "type": "integer", "minimum": 1 },
    "policy_commit": { "type": "string", "pattern": "^[0-9a-f]{40}$" },
    "created_at": { "type": "string", "format": "date-time" },
    "stopped_reason": { "type": ["string", "null"] }
  }
}
```

### 2. 票（Ticket）スキーマ
```json
{
  "type": "object",
  "required": ["ticket_id", "kind", "path", "sha256", "summary"],
  "properties": {
    "ticket_id": { "type": "string" },
    "kind": { "type": "string", "enum": ["plan", "review_findings", "patch", "test_verdict"] },
    "path": { "type": "string" },
    "sha256": { "type": "string", "pattern": "^[0-9a-f]{64}$" },
    "summary": { "type": "string", "maxLength": 200 }
  }
}
```

## 機能仕様

### 構成と呼び出し
#### SP-DEVELOPPLUGIN-001 呼び出し名規約
develop プラグインは、develop:implement, develop:review, develop:address-review の完全修飾名で各スキルをエクスポートしなければならない（対応: PR-DEVELOPPLUGIN-001）。

#### SP-DEVELOPPLUGIN-002 3スキルの版の一致
3 スキルは同一プラグインパッケージ内に配置し、package.json / plugin.json のバージョンを厳格に一致させなければならない（対応: PR-DEVELOPPLUGIN-002）。

#### SP-DEVELOPPLUGIN-003 呼び出しの向き
スキル間連携は address-review -> implement -> review の一方向とし、逆方向呼び出しや循環参照を禁止しなければならない（対応: PR-DEVELOPPLUGIN-003）。

#### SP-DEVELOPPLUGIN-004 実行環境欠如時の安全停止
Native Workflow および Codex runner の双方が利用できない場合、終了コード 2 で即座に安全停止し、不足環境を JSON で報告しなければならない（対応: PR-DEVELOPPLUGIN-004）。

#### SP-DEVELOPPLUGIN-005 Codex runner 実行アダプタ
Codex 環境下では dynamic-workflow-runner を介して各ステップを実行し、環境差分を抽象化しなければならない（対応: PR-DEVELOPPLUGIN-005）。

#### SP-DEVELOPPLUGIN-006 段の選択決定権
司令塔はスキルから返された next_args および status フィールドに従って次段の実行を決定しなければならない（対応: PR-DEVELOPPLUGIN-006）。

#### SP-DEVELOPPLUGIN-007 司令塔の成果物不介入
司令塔エージェントは自身でコード差分や計画本文を生成・捏造してはならず、必ず専用ロールに委任しなければならない（対応: PR-DEVELOPPLUGIN-007）。

#### SP-DEVELOPPLUGIN-008 固有値の外部化
特定リポジトリのブランチ名やパスをコード内にハードコードしてはならず、設定ファイルまたは git 検出から取得しなければならない（対応: PR-DEVELOPPLUGIN-008）。

#### SP-DEVELOPPLUGIN-009 再設計アーキテクチャの適用
根を探す役・抽出役の追加、変更分類（docs/spec/tests/impl）に基づく分岐、票と path/sum による参照渡し、および世代管理を実装しなければならない（対応: PR-DEVELOPPLUGIN-009）。

#### SP-DEVELOPPLUGIN-010 機能境界の限定
本設計で規定されていない新機能やプロトコルを無断で拡張してはならない（対応: PR-DEVELOPPLUGIN-010）。

### 方針文書と版の解決
#### SP-DEVELOPPLUGIN-011 宣言の形式検証
利用側の設定宣言ファイル（.develop.json 等）が存在する場合、スキーマに合致しているか検証し、不正な場合はエラー停止しなければならない（対応: PR-DEVELOPPLUGIN-011）。

#### SP-DEVELOPPLUGIN-012 PR 対象時の方針コミット解決
対象が PR の場合、PR の base commit または先頭 commit のツリーから方針文書を抽出しなければならない（対応: PR-DEVELOPPLUGIN-012）。

#### SP-DEVELOPPLUGIN-013 作業ツリー対象時の方針コミット解決
作業ツリーが対象の場合、最新の HEAD コミットから方針文書を抽出しなければならない（対応: PR-DEVELOPPLUGIN-013）。

#### SP-DEVELOPPLUGIN-080 外部指定コミットの優先解決
引数で明示的にコミットハッシュが渡された場合、そのコミットを方針の版として優先採用しなければならない（対応: PR-DEVELOPPLUGIN-080）。

#### SP-DEVELOPPLUGIN-014 方針コミット未解決時の停止
有効な git コミットが解決できない場合、エラーコード 3 で停止しなければならない（対応: PR-DEVELOPPLUGIN-014）。

#### SP-DEVELOPPLUGIN-015 版からの分離抽出
方針文書の束は、作業ツリーの一時的変更に影響されないよう git archive / show を用いて分離抽出ディレクトリに実体化しなければならない（対応: PR-DEVELOPPLUGIN-015）。

### 言語と出力規約
#### SP-DEVELOPPLUGIN-017 人間向け出力の言語
人間向けのレポート、要約、PR コメント本文は原則として日本語で出力しなければならない（対応: PR-DEVELOPPLUGIN-017）。

#### SP-DEVELOPPLUGIN-018 言語の既定値
言語設定が明示されない場合の既定値は ja-JP としなければならない（対応: PR-DEVELOPPLUGIN-018）。

#### SP-DEVELOPPLUGIN-019 言語非依存の境界
エラーコード、JSON キー、git commit コマンド、ファイルパスは言語翻訳を適用してはならない（対応: PR-DEVELOPPLUGIN-019）。

#### SP-DEVELOPPLUGIN-020 言語決定の優先順位
出力言語は、依頼者の明示指定 > リポジトリ設定 > 既定値（日本語）の順で決定しなければならない（対応: PR-DEVELOPPLUGIN-020）。

### 権限・書き込み保護
#### SP-DEVELOPPLUGIN-021 Codex runner における書き込み制限
Codex runner 実行時、明示された作業ディレクトリ外へのファイル書き込みを禁止しなければならない（対応: PR-DEVELOPPLUGIN-021）。

#### SP-DEVELOPPLUGIN-022 読み取り専用ステップの隔離
review および計画ステップではファイル変更権限を剥奪し、読み取り専用として実行しなければならない（対応: PR-DEVELOPPLUGIN-022）。

#### SP-DEVELOPPLUGIN-023 状態書き込みのアトミック性
状態ファイルの更新は一時ファイルへ書き出し後に rename を行うアトミック書き込みとしなければならない（対応: PR-DEVELOPPLUGIN-023）。

#### SP-DEVELOPPLUGIN-024 意図せぬ書き込みの事後検知
読み取り専用ステップ完了後、git status を実行して作業ツリーに差分が生じていないか事後検査しなければならない（対応: PR-DEVELOPPLUGIN-024）。

#### SP-DEVELOPPLUGIN-025 ツール制限と事後検査の二重防御
サンドボックス権限の制限と事後差分チェックの双重ゲートにより予期せぬ破壊を阻止しなければならない（対応: PR-DEVELOPPLUGIN-025）。

#### SP-DEVELOPPLUGIN-026 不正書き込み検知時の即時停止・ロールバック
読み取り専用ステップで変更が検知された場合、git checkout で作業ツリーを復元しエラー停止しなければならない（対応: PR-DEVELOPPLUGIN-026）。

#### SP-DEVELOPPLUGIN-027 変化の報告形式
復元または検知された変更内容は、パス一覧と SHA-256 チェックサムを付与して監査ログに記録しなければならない（対応: PR-DEVELOPPLUGIN-027）。

#### SP-DEVELOPPLUGIN-028 残留リスクの明示
ツール制限をすり抜ける可能性があるホスト依存のリスクは、完了レポートの「残る危険」節に明記しなければならない（対応: PR-DEVELOPPLUGIN-028）。

#### SP-DEVELOPPLUGIN-029 事前権限チェック
実行開始前に git, gh, node 等の実行権限を検査し、不足時は事前停止しなければならない（対応: PR-DEVELOPPLUGIN-029）。

### 前提の伝達と停止・再開
#### SP-DEVELOPPLUGIN-030 前提の安全配達
各ロールへのプロンプト投入時、方針文書の束とタスク前提を完全な形で付与しなければならない（対応: PR-DEVELOPPLUGIN-030）。

#### SP-DEVELOPPLUGIN-031 欠落前提の自己申告
予算上限等で前提が削られた場合、削られた項目一覧を結果 JSON に明記しなければならない（対応: PR-DEVELOPPLUGIN-031）。

#### SP-DEVELOPPLUGIN-032 停止時の返却構造体
停止時は status="stopped", reason, next_args, state_path を含む構造化 JSON を返さなければならない（対応: PR-DEVELOPPLUGIN-032）。

#### SP-DEVELOPPLUGIN-033 外部ツール障害のハンドリング
GitHub API や git のネットワーク失敗時はリトライを行い、回復不能な場合は transient_error として停止しなければならない（対応: PR-DEVELOPPLUGIN-033）。

#### SP-DEVELOPPLUGIN-034 失敗状態の記録
失敗理由と直前の状態世代は state.json に必ず永続化しなければならない（対応: PR-DEVELOPPLUGIN-034）。

#### SP-DEVELOPPLUGIN-035 再開トークンと状態照合
再開時は run_id と generation を照合し、不一致時は再開を拒絶しなければならない（対応: PR-DEVELOPPLUGIN-035）。

#### SP-DEVELOPPLUGIN-036 多重起動（Relaunch）の禁止
同一 run_id に対する並行実行を排他制御により阻止しなければならない（対応: PR-DEVELOPPLUGIN-036）。

#### SP-DEVELOPPLUGIN-037 対話型入力待ちの禁止
run ループの最中に人間からの標準入力を同期的に待ってはならず、停止して司令塔へ制御を戻さなければならない（対応: PR-DEVELOPPLUGIN-037）。

#### SP-DEVELOPPLUGIN-038 人間判断待ち停止
仕様曖昧等の判断が必要な場合、needs_input ステータスで停止し、選択肢を提示しなければならない（対応: PR-DEVELOPPLUGIN-038）。

#### SP-DEVELOPPLUGIN-039 遅延書き込みの排斥
前の run や非同期プロセスからの遅延書き込みは、世代番号の比較により破棄しなければならない（対応: PR-DEVELOPPLUGIN-039）。

#### SP-DEVELOPPLUGIN-040 サブエージェント失敗の捕捉
サブプロセスやエージェントの非ゼロ終了は即座に親ループで捕捉し、握りつぶしてはならない（対応: PR-DEVELOPPLUGIN-040）。

#### SP-DEVELOPPLUGIN-041 セッション跨ぎの永続化
再開に必要なコンテキストはメモリではなくファイルシステム上にのみ保存しなければならない（対応: PR-DEVELOPPLUGIN-041）。

#### SP-DEVELOPPLUGIN-042 転記ミスの自動検知
各ステップ間の入出力は SHA-256 ハッシュを照合し、改竄や破損を検出しなければならない（対応: PR-DEVELOPPLUGIN-042）。

### 監査と証拠性
#### SP-DEVELOPPLUGIN-075 外部入力の原典記録
GitHub から取得したコメントや PR 差分は未加工のまま raw ログに保存しなければならない（対応: PR-DEVELOPPLUGIN-075）。

#### SP-DEVELOPPLUGIN-076 証拠に基づく判定
レビュー指摘や合否判定は、必ず取得記録内の行番号と引用を根拠として添付しなければならない（対応: PR-DEVELOPPLUGIN-076）。

#### SP-DEVELOPPLUGIN-077 停止理由の証拠性
停止時の理由は、エラー出力の抜粋または未充足 criteria の ID を必須としなければならない（対応: PR-DEVELOPPLUGIN-077）。

#### SP-DEVELOPPLUGIN-078 停滞検知とエスカレーション
同一エラーまたは同一状態への再訪が 3 回発生した場合、詰まり（stuck）としてエスカレーションしなければならない（対応: PR-DEVELOPPLUGIN-078）。

#### SP-DEVELOPPLUGIN-079 自己書き換えの禁止
実行中のスキルコード自身を run 内で動的に書き換えてはならない（対応: PR-DEVELOPPLUGIN-079）。

### トークン予算とモデル制御
#### SP-DEVELOPPLUGIN-043 トークン予算の注入
CLI または環境変数からトークン上限（max_tokens）を受け取り、各ステップの呼び出しに配分しなければならない（対応: PR-DEVELOPPLUGIN-043）。

#### SP-DEVELOPPLUGIN-044 既定のトークン予算
指定がない場合、1 実行あたりの既定トークン予算を 200,000 トークンとしなければならない（対応: PR-DEVELOPPLUGIN-044）。

#### SP-DEVELOPPLUGIN-045 予算枯渇時の安全縮退
トークン予算の 90% を消費した場合、追加のレビューイテレーションを中断し安全停止しなければならない（対応: PR-DEVELOPPLUGIN-045）。

#### SP-DEVELOPPLUGIN-046 実行メトリクス記録
各ステップで消費したトークン数、起動モデル、所要時間を metrics.json に記録しなければならない（対応: PR-DEVELOPPLUGIN-046）。

#### SP-DEVELOPPLUGIN-071 モデル選択の根拠
検証役には推論能力の高いモデル、形式的なチェックには軽量モデルを割り当て、その根拠を明記しなければならない（対応: PR-DEVELOPPLUGIN-071）。

#### SP-DEVELOPPLUGIN-085 モデル指定のオーバーライド
CLI 引数 --model / --effort により、ステップごとの使用モデルを明示的に上書き可能としなければならない（対応: PR-DEVELOPPLUGIN-085）。

### 判定・永続化・GitHub 連携
#### SP-DEVELOPPLUGIN-047 形式判定のログ化
Lint、型検査、テストの各成否を machine-readable な boolean 行列として保存しなければならない（対応: PR-DEVELOPPLUGIN-047）。

#### SP-DEVELOPPLUGIN-048 全検証合格後の外部反映
全検証が合格（pass）するまで、git commit, git push, PR コメント投稿を行ってはならない（対応: PR-DEVELOPPLUGIN-048）。

#### SP-DEVELOPPLUGIN-049 外部副作用の不可逆性警告
PR コメント投稿や thread resolve は取り消し不能な操作として扱い、事後ログに記録しなければならない（対応: PR-DEVELOPPLUGIN-049）。

#### SP-DEVELOPPLUGIN-074 履歴書き換え push の禁止
git push は常に fast-forward または新規ブランチとし、--force による破壊的書き換えを禁止しなければならない（対応: PR-DEVELOPPLUGIN-074）。

### 移行・互換性・廃止
#### SP-DEVELOPPLUGIN-050 設定先行配備規約
develop プラグイン有効化前に、利用側リポジトリへの設定ファイル配備を先行完了させなければならない（対応: PR-DEVELOPPLUGIN-050）。

#### SP-DEVELOPPLUGIN-051 既存 CI/CD 非破壊性
claude-plugins への導入時、既存の GitHub Actions や Makefile ターゲットを破壊してはならない（対応: PR-DEVELOPPLUGIN-051）。

#### SP-DEVELOPPLUGIN-081 移行期間の縮退運転
設定ファイルが存在しない場合でも、最小限の安全なデフォルト値で動作可能としなければならない（対応: PR-DEVELOPPLUGIN-081）。

#### SP-DEVELOPPLUGIN-052 CLI オプションの後方互換
旧スキルと同一の基本引数（--pr, --branch 等）を互換オプションとして受け入れなければならない（対応: PR-DEVELOPPLUGIN-052）。

#### SP-DEVELOPPLUGIN-053 マーケットプレイス登録整合
.claude-plugin/marketplace.json と .agents/plugins/marketplace.json の登録情報を完全に同期させなければならない（対応: PR-DEVELOPPLUGIN-053）。

#### SP-DEVELOPPLUGIN-054 best-practices review 合格保証
develop プラグインの公開前に、skill-creator-best-practices による評価スコアを満たさなければならない（対応: PR-DEVELOPPLUGIN-054）。

#### SP-DEVELOPPLUGIN-055 形式検証モデルとの照合
tests/formal/develop/ の TLA+ モデルの全 invariant とアクションに対応付けられなければならない（対応: PR-DEVELOPPLUGIN-055）。

#### SP-DEVELOPPLUGIN-056 成果物の全数静的検査
全 SKILL.md, package.json, scripts がリンク切れやスキーマ不整合を持たないことを検証しなければならない（対応: PR-DEVELOPPLUGIN-056）。

#### SP-DEVELOPPLUGIN-057 実環境スモーク試走
実リポジトリのサンプル PR に対しスモークテストを実施し、正常完走を確認しなければならない（対応: PR-DEVELOPPLUGIN-057）。

#### SP-DEVELOPPLUGIN-082 完了判定基準
スモークテストにおいて、すべての検証ゲートを通過し終了コード 0 で完了することを完了条件としなければならない（対応: PR-DEVELOPPLUGIN-082）。

#### SP-DEVELOPPLUGIN-083 回帰評価 (evals)
evals.json に定義された全テストケースで合格判定を得なければならない（対応: PR-DEVELOPPLUGIN-083）。

#### SP-DEVELOPPLUGIN-073 仕様トレーサビリティ全数照合
全 PR 要求 ID に対し、本仕様書および各仕様書の SP 項目が 100% のカバー率を持つことをスクリプトで照合しなければならない（対応: PR-DEVELOPPLUGIN-073）。

#### SP-DEVELOPPLUGIN-058 スキル説明文の汎用性
SKILL.md の description は特定リポジトリに依存しない汎用的な表現で記述しなければならない（対応: PR-DEVELOPPLUGIN-058）。

#### SP-DEVELOPPLUGIN-059 発火トリガーの正確性
不要な質問に対してスキルが誤発火しないよう、否定条件（「質問のみには発火しない」等）を明記しなければならない（対応: PR-DEVELOPPLUGIN-059）。

#### SP-DEVELOPPLUGIN-060 旧ワークフロースキルの廃止
workflow:pr-review および workflow:pr-review-fix の登録を廃止マークしなければならない（対応: PR-DEVELOPPLUGIN-060）。

#### SP-DEVELOPPLUGIN-084 廃止スキルの安全撤去
旧スキルのファイルを削除する前に、依存関係が存在しないことを検査しなければならない（対応: PR-DEVELOPPLUGIN-084）。

#### SP-DEVELOPPLUGIN-061 廃止と削除の段階分離
旧スキルの完全削除は、新スキルの安定稼働確認後に別 PR で実施しなければならない（対応: PR-DEVELOPPLUGIN-061）。

#### SP-DEVELOPPLUGIN-062 dcf contextual-code-review の代替
dcf リポジトリの独自レビュースキルを develop:review の宣言設定で代替可能としなければならない（対応: PR-DEVELOPPLUGIN-062）。

#### SP-DEVELOPPLUGIN-063 外部リポジトリへの提供保証
外部リポジトリに対しては、公式ドキュメントで規定された入出力インターフェースのみを保証しなければならない（対応: PR-DEVELOPPLUGIN-063）。

#### SP-DEVELOPPLUGIN-064 撤去順序の規律
旧スキルの symlink 撤去 -> 設定移行 -> 本体コード削除の順序を遵守しなければならない（対応: PR-DEVELOPPLUGIN-064）。

#### SP-DEVELOPPLUGIN-065 機能等価性の維持
旧スキルで提供されていた分類、検証、自動修正の機能水準を損なってはならない（対応: PR-DEVELOPPLUGIN-065）。

#### SP-DEVELOPPLUGIN-066 廃止による非互換の文書化
旧スキルの廃止に伴う非互換な引数や挙動の差異を MIGRATION.md に文書化しなければならない（対応: PR-DEVELOPPLUGIN-066）。

#### SP-DEVELOPPLUGIN-072 外部リポジトリ固有機能の分離
リポジトリ固有のビジネスロジックは設定ファイルまたは外部スクリプトに分離し、プラグイン本体に含めてはならない（対応: PR-DEVELOPPLUGIN-072）。

#### SP-DEVELOPPLUGIN-067 旧名エイリアスの過渡的保持
旧コマンド名での呼び出しがあった場合、新コマンド名への移行を案内するメッセージを出力しなければならない（対応: PR-DEVELOPPLUGIN-067）。

#### SP-DEVELOPPLUGIN-068 利用者向け移行ガイダンス
旧スキル呼び出し時に、推奨される代替コマンドラインを stdout に出力しなければならない（対応: PR-DEVELOPPLUGIN-068）。

#### SP-DEVELOPPLUGIN-069 pk/dcf 移行完了検証
pk および dcf リポジトリにおいて、新プラグインでの CI およびテストが完走することを確認しなければならない（対応: PR-DEVELOPPLUGIN-069）。

#### SP-DEVELOPPLUGIN-070 ドメイン固有観点の外挿
dcf の金融ロジック等の特殊観点は、方針文書の「読むもの」に追加することでプラグイン本体を変更せず適用可能としなければならない（対応: PR-DEVELOPPLUGIN-070）。

### 再設計アーキテクチャ詳細仕様
#### SP-DEVELOPPLUGIN-086 変更種類による分類マトリクス
対象ファイルの拡張子およびパスパターンに基づき、docs, spec, test, impl の 4 種に分類しなければならない（対応: PR-DEVELOPPLUGIN-086）。

#### SP-DEVELOPPLUGIN-087 参照渡しとチェックサム検証
各ステップ間で引き渡される票は、ファイルパスとその SHA-256 チェックサムを含み、受領側でチェックサム再計算により整合性を検証しなければならない（対応: PR-DEVELOPPLUGIN-087）。

#### SP-DEVELOPPLUGIN-088 状態世代と遅延書き込み排斥
状態ファイル更新時は必ず generation を +1 インクリメントし、古い generation を持つプロセスの書き込みを拒絶（reject）しなければならない（対応: PR-DEVELOPPLUGIN-088）。

## 決定表（Decision Tables）

### 1. 実行環境判定表
| Native Workflow | Codex Runner | 判定結果 | アクション |
|---|---|---|---|
| 利用可能 | 任意 | Native 優先 | Native Workflow で実行 |
| 利用不可 | 利用可能 | Codex 代替 | Dynamic Workflow Runner で実行 |
| 利用不可 | 利用不可 | 実行不可 | SP-DEVELOPPLUGIN-004 に従い終了コード 2 で安全停止 |

### 2. 状態世代判定表
| 要求元の generation | 現在の state.generation | 判定結果 | アクション |
|---|---|---|---|
| == state.generation | 同一世代 | 許可 | 状態を更新し generation を +1 する |
| < state.generation | 古い遅延書き込み | 拒絶 | 書き込みを破棄し、遅延警告を記録する |
| > state.generation | 整合性破損 | 異常停止 | 不正世代エラーとして終了コード 4 で停止する |

### 3. 変更種類分類決定表
| パス / 拡張子パターン | 分類種別 | 後続パイプライン |
|---|---|---|
| `docs/requirements/**/*.md` | prd | prd-spec 整合性検査・形式検証 |
| `docs/specifications/**/*.md` | spec | トレーサビリティ照合・決定表網羅検査 |
| `tests/**/*.rs`, `**/*.test.*` | test | テストランナー実行・カバレッジ検証 |
| `src/**/*`, `plugins/**/*` | impl | コンパイラ・Lint・多角検証 |
