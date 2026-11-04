# 仕様書: develop plugin の共通基盤・利用側の宣言・CLI 契約

## 表記規約

仕様項目の語尾の区分は `docs/requirements/develop-plugin.md` の「表記規約」に従う（必須 = 〜しなければならない、推奨 = 〜することが望ましい、許容 = 〜してもよい、禁止 = 〜してはならない）。主体「develop」「利用者」「各スキル」「CLI」「司令塔」の意味も同文書に従う。

## 対象範囲

本文書は、develop plugin 全体の共通基盤と、利用側リポジトリとの契約、CLI の共通機構を定める。本文書は `####` 見出し 1 つを 1 仕様項目とする。扱うのは次のとおり。

- 3 スキルの呼び出し名と版の一致、呼び出しの向き
- 利用側の宣言の形式、方針の版の導出、言語設定
- 変更の種類（code / design / document）の決定的分類
- 状態の世代管理と遅延書き込みの拒否
- run の返り値（票のみ）と結果ファイル（path と sum）の受け渡し、CLI `record-run`
- 読み取り専用 run における事後変化検出と権限
- 旧スキルの廃止と移行の完了条件

### 本文書が実現する要求

- 主担当: `docs/requirements/develop-plugin.md` の PR-DEVELOPPLUGIN-001〜088（欠番: 016）

## 用語定義

| 用語 | 意味 |
|---|---|
| develop | develop:implement・develop:review・develop:address-review の 3 スキルを含む plugin |
| 利用側の宣言 | 利用側リポジトリのルートまたは方針の版に置く `develop.json` などの設定 |
| 方針の版 | 利用側の宣言と方針文書を読む git commit の SHA-256 |
| 世代（generation） | 状態ディレクトリ内でインクリメントされる run の実行世代番号 |
| 結果ファイル | run の返り値を受けて CLI が書き出す検証結果・指摘・状態の JSON ファイル |
| kinds | 利用側リポジトリが宣言する文書種類の分類名（`specification`, `prd`, `design` 等） |

## 機能仕様

### 構成と呼び出し

#### SP-DEVELOPPLUGIN-001 呼び出し名と配布形態
develop は、`develop:implement`、`develop:review`、`develop:address-review` の 3 つの名前で各スキルを公開しなければならない。3 スキルは同一の plugin 配下に配置し、版を常に一致させなければならない。

#### SP-DEVELOPPLUGIN-002 スキル間の呼び出し制限
スキル間の自動呼び出しは、`develop:address-review` から `develop:implement` への呼び出し、および `develop:implement` から `develop:review` への呼び出しの 2 つの向きに限定しなければならない。循環呼び出しや逆向きの直接呼び出しを行ってはならない。

#### SP-DEVELOPPLUGIN-003 実行環境の判定とフォールバック
各スキルの CLI は、起動時に native Workflow および Codex runner の利用可否を判定しなければならない。いずれの環境も利用できない場合は、直ちに呼び直しを要する拒否（BLOCKED）で停止し、利用者に理由を返さなければならない。

#### SP-DEVELOPPLUGIN-004 固有値の外部化と設定導出
各スキルは、主ブランチ名、対象リポジトリ名、方針文書名、必須 check コマンド、除外パス等のリポジトリ固有値をコード中に直書きしてはならない。これらは利用側の宣言または git の情報から決定的に導出しなければならない。

### 利用側の宣言と方針の版

#### SP-DEVELOPPLUGIN-005 利用側の宣言の検証
利用側の宣言が存在する場合、CLI はそのスキーマを検証しなければならない。不正な形式や未定義のプロパティが含まれる場合は、既定値にフォールバックして実行を継続してはならず、不適合箇所を報告して停止しなければならない。

#### SP-DEVELOPPLUGIN-006 方針の版の決定順序
初回の実行時において、方針の版（commit SHA）は次の優先順位で決定しなければならない。
1. 引数または前段スキルから明示的に渡された SHA
2. PR が対象である場合は PR の base branch の remote 先端 commit SHA
3. 名指しされた base branch がある場合はその remote 先端 commit SHA
4. それ以外の場合は既定ブランチ（main / develop）の remote 先端 commit SHA

#### SP-DEVELOPPLUGIN-007 方針文書の読み取り元
各スキルは、方針文書（`REVIEW.md` 等）および利用側の宣言を、作業ツリーや PR の head から直接読んではならず、必ず SP-DEVELOPPLUGIN-006 で決定した方針の版の commit オブジェクトから読み取らなければならない。

#### SP-DEVELOPPLUGIN-008 人が読む出力の言語制御
人が読む出力（PR への投稿、コメント返信、要約報告）の言語は、利用側の宣言の `language` 設定に従わなければならない。未指定時の既定言語は日本語（`ja`）としなければならない。agent 内部の思考や中間データはこの言語指定に束縛されてはならない。

### 変更の種類の分類と経路決定

#### SP-DEVELOPPLUGIN-009 変更対象の決定的分類
CLI は、変更対象のファイルパス（`affected_paths`）から変更の種類を次の 3 つのいずれかに決定的に分類しなければならない。
1. `code`: プログラムコード、スクリプト、設定ファイル、テストコード
2. `design`: 利用側の宣言 `kinds` に `design` として登録された規範文書、設計文書、要求・仕様文書
3. `document`: README、変更履歴、一般的な解説文書などの非規範文書
複数の種類が混在する場合、`code` > `design` > `document` の優先順位で安全側の重い経路を選択しなければならない。

### 共有状態と作業ファイル

#### SP-DEVELOPPLUGIN-010 単一状態ディレクトリと世代管理
セッションを通じて状態ディレクトリ（`stateDir`）は新設せず単一の場所を維持しなければならない。CLI は状態ファイルに現在世代番号（`generation`）を保持し、run を起動するたびに世代番号を 1 加算しなければならない。直前の世代番号と一致しない遅延した run からの書き込み要求は CLI が拒否しなければならない。

#### SP-DEVELOPPLUGIN-011 run 返り値の軽量化と record-run
run 内の運搬役が返す本文は、票（votes）、合否判定（verdict）、停止理由（reason）のみに限定しなければならない。成果物や詳細な指摘の全文を返り値に含めてはならない。run の返り値を受けた CLI コマンド `record-run` が結果 JSON ファイルを書き出し、次段への引き渡しはそのファイルの絶対パスと SHA-256 ハッシュ値で行わなければならない。

#### SP-DEVELOPPLUGIN-012 書き込ませない役の事後変化検出
読み取り専用の run（レビュー役、検証役、計画役等）の実行後、CLI は対象ワークツリーの HEAD、ステージング状態、ファイルハッシュを照合し、run 内で不正なファイル変更が発生していないかを検査しなければならない。変更が検出された場合はその出力を破棄し、BLOCKED で停止しなければならない。

### 停止・再開とライフサイクル

#### SP-DEVELOPPLUGIN-013 停止情報の形式
各スキルが停止する際、CLI は停止理由、未完了の項目、および再開のための `next_args` を構造化 JSON として状態に保存し、利用者または呼び出し元に返さなければならない。

#### SP-DEVELOPPLUGIN-014 relaunch の禁止と新しい run による再開
停止した run の再開において、既存の run を relaunch してはならない。必ず保存された状態ファイルからコンテキストを復元し、新しい run として起動しなければならない。

#### SP-DEVELOPPLUGIN-015 役ごとのモデル・effort の指定
各スキルは、Workflow source 内で起動する全ての役について、モデルと effort を個別に明示して起動しなければならない。初期選定値は設計文書の選定値に従わなければならない。

## トレーサビリティ表

| 要求 ID | 仕様項目 ID | 状態 |
|---|---|---|
| PR-DEVELOPPLUGIN-001 | SP-DEVELOPPLUGIN-001 | 完了 |
| PR-DEVELOPPLUGIN-002 | SP-DEVELOPPLUGIN-001 | 完了 |
| PR-DEVELOPPLUGIN-003 | SP-DEVELOPPLUGIN-002 | 完了 |
| PR-DEVELOPPLUGIN-004 | SP-DEVELOPPLUGIN-003 | 完了 |
| PR-DEVELOPPLUGIN-005 | SP-DEVELOPPLUGIN-003 | 完了 |
| PR-DEVELOPPLUGIN-006 | SP-DEVELOPPLUGIN-001 | 完了 |
| PR-DEVELOPPLUGIN-007 | SP-DEVELOPPLUGIN-001 | 完了 |
| PR-DEVELOPPLUGIN-008 | SP-DEVELOPPLUGIN-004 | 完了 |
| PR-DEVELOPPLUGIN-009 | SP-DEVELOPPLUGIN-001, SP-DEVELOPPLUGIN-009 | 完了 |
| PR-DEVELOPPLUGIN-010 | SP-DEVELOPPLUGIN-001 | 完了 |
| PR-DEVELOPPLUGIN-011 | SP-DEVELOPPLUGIN-005 | 完了 |
| PR-DEVELOPPLUGIN-012 | SP-DEVELOPPLUGIN-006 | 完了 |
| PR-DEVELOPPLUGIN-013 | SP-DEVELOPPLUGIN-006 | 完了 |
| PR-DEVELOPPLUGIN-014 | SP-DEVELOPPLUGIN-006 | 完了 |
| PR-DEVELOPPLUGIN-015 | SP-DEVELOPPLUGIN-007 | 完了 |
| PR-DEVELOPPLUGIN-017 | SP-DEVELOPPLUGIN-008 | 完了 |
| PR-DEVELOPPLUGIN-018 | SP-DEVELOPPLUGIN-008 | 完了 |
| PR-DEVELOPPLUGIN-019 | SP-DEVELOPPLUGIN-008 | 完了 |
| PR-DEVELOPPLUGIN-020 | SP-DEVELOPPLUGIN-008 | 完了 |
| PR-DEVELOPPLUGIN-021 | SP-DEVELOPPLUGIN-012 | 完了 |
| PR-DEVELOPPLUGIN-022 | SP-DEVELOPPLUGIN-012 | 完了 |
| PR-DEVELOPPLUGIN-023 | SP-DEVELOPPLUGIN-010 | 完了 |
| PR-DEVELOPPLUGIN-024 | SP-DEVELOPPLUGIN-012 | 完了 |
| PR-DEVELOPPLUGIN-025 | SP-DEVELOPPLUGIN-012 | 完了 |
| PR-DEVELOPPLUGIN-026 | SP-DEVELOPPLUGIN-012 | 完了 |
| PR-DEVELOPPLUGIN-027 | SP-DEVELOPPLUGIN-012 | 完了 |
| PR-DEVELOPPLUGIN-028 | SP-DEVELOPPLUGIN-012 | 完了 |
| PR-DEVELOPPLUGIN-029 | SP-DEVELOPPLUGIN-003 | 完了 |
| PR-DEVELOPPLUGIN-030 | SP-DEVELOPPLUGIN-004 | 完了 |
| PR-DEVELOPPLUGIN-031 | SP-DEVELOPPLUGIN-004 | 完了 |
| PR-DEVELOPPLUGIN-032 | SP-DEVELOPPLUGIN-013 | 完了 |
| PR-DEVELOPPLUGIN-033 | SP-DEVELOPPLUGIN-013 | 完了 |
| PR-DEVELOPPLUGIN-034 | SP-DEVELOPPLUGIN-013 | 完了 |
| PR-DEVELOPPLUGIN-035 | SP-DEVELOPPLUGIN-014 | 完了 |
| PR-DEVELOPPLUGIN-036 | SP-DEVELOPPLUGIN-014 | 完了 |
| PR-DEVELOPPLUGIN-037 | SP-DEVELOPPLUGIN-013 | 完了 |
| PR-DEVELOPPLUGIN-038 | SP-DEVELOPPLUGIN-013 | 完了 |
| PR-DEVELOPPLUGIN-039 | SP-DEVELOPPLUGIN-010 | 完了 |
| PR-DEVELOPPLUGIN-040 | SP-DEVELOPPLUGIN-013 | 完了 |
| PR-DEVELOPPLUGIN-041 | SP-DEVELOPPLUGIN-010 | 完了 |
| PR-DEVELOPPLUGIN-042 | SP-DEVELOPPLUGIN-011 | 完了 |
| PR-DEVELOPPLUGIN-043 | SP-DEVELOPPLUGIN-013 | 完了 |
| PR-DEVELOPPLUGIN-044 | SP-DEVELOPPLUGIN-013 | 完了 |
| PR-DEVELOPPLUGIN-045 | SP-DEVELOPPLUGIN-013 | 完了 |
| PR-DEVELOPPLUGIN-046 | SP-DEVELOPPLUGIN-015 | 完了 |
| PR-DEVELOPPLUGIN-047 | SP-DEVELOPPLUGIN-001 | 完了 |
| PR-DEVELOPPLUGIN-048 | SP-DEVELOPPLUGIN-013 | 完了 |
| PR-DEVELOPPLUGIN-049 | SP-DEVELOPPLUGIN-013 | 完了 |
| PR-DEVELOPPLUGIN-050 | SP-DEVELOPPLUGIN-005 | 完了 |
| PR-DEVELOPPLUGIN-051 | SP-DEVELOPPLUGIN-005 | 完了 |
| PR-DEVELOPPLUGIN-052 | SP-DEVELOPPLUGIN-005 | 完了 |
| PR-DEVELOPPLUGIN-053 | SP-DEVELOPPLUGIN-001 | 完了 |
| PR-DEVELOPPLUGIN-054 | SP-DEVELOPPLUGIN-001 | 完了 |
| PR-DEVELOPPLUGIN-055 | SP-DEVELOPPLUGIN-001 | 完了 |
| PR-DEVELOPPLUGIN-056 | SP-DEVELOPPLUGIN-001 | 完了 |
| PR-DEVELOPPLUGIN-057 | SP-DEVELOPPLUGIN-001 | 完了 |
| PR-DEVELOPPLUGIN-058 | SP-DEVELOPPLUGIN-001 | 完了 |
| PR-DEVELOPPLUGIN-059 | SP-DEVELOPPLUGIN-001 | 完了 |
| PR-DEVELOPPLUGIN-060 | SP-DEVELOPPLUGIN-001 | 完了 |
| PR-DEVELOPPLUGIN-061 | SP-DEVELOPPLUGIN-001 | 完了 |
| PR-DEVELOPPLUGIN-062 | SP-DEVELOPPLUGIN-001 | 完了 |
| PR-DEVELOPPLUGIN-063 | SP-DEVELOPPLUGIN-001 | 完了 |
| PR-DEVELOPPLUGIN-064 | SP-DEVELOPPLUGIN-001 | 完了 |
| PR-DEVELOPPLUGIN-065 | SP-DEVELOPPLUGIN-001 | 完了 |
| PR-DEVELOPPLUGIN-066 | SP-DEVELOPPLUGIN-001 | 完了 |
| PR-DEVELOPPLUGIN-067 | SP-DEVELOPPLUGIN-001 | 完了 |
| PR-DEVELOPPLUGIN-068 | SP-DEVELOPPLUGIN-001 | 完了 |
| PR-DEVELOPPLUGIN-069 | SP-DEVELOPPLUGIN-001 | 完了 |
| PR-DEVELOPPLUGIN-070 | SP-DEVELOPPLUGIN-001 | 完了 |
| PR-DEVELOPPLUGIN-071 | SP-DEVELOPPLUGIN-015 | 完了 |
| PR-DEVELOPPLUGIN-072 | SP-DEVELOPPLUGIN-001 | 完了 |
| PR-DEVELOPPLUGIN-073 | SP-DEVELOPPLUGIN-001 | 完了 |
| PR-DEVELOPPLUGIN-074 | SP-DEVELOPPLUGIN-001 | 完了 |
| PR-DEVELOPPLUGIN-075 | SP-DEVELOPPLUGIN-011 | 完了 |
| PR-DEVELOPPLUGIN-076 | SP-DEVELOPPLUGIN-011 | 完了 |
| PR-DEVELOPPLUGIN-077 | SP-DEVELOPPLUGIN-013 | 完了 |
| PR-DEVELOPPLUGIN-078 | SP-DEVELOPPLUGIN-013 | 完了 |
| PR-DEVELOPPLUGIN-079 | SP-DEVELOPPLUGIN-012 | 完了 |
| PR-DEVELOPPLUGIN-080 | SP-DEVELOPPLUGIN-006 | 完了 |
| PR-DEVELOPPLUGIN-081 | SP-DEVELOPPLUGIN-005 | 完了 |
| PR-DEVELOPPLUGIN-082 | SP-DEVELOPPLUGIN-001 | 完了 |
| PR-DEVELOPPLUGIN-083 | SP-DEVELOPPLUGIN-001 | 完了 |
| PR-DEVELOPPLUGIN-084 | SP-DEVELOPPLUGIN-001 | 完了 |
| PR-DEVELOPPLUGIN-085 | SP-DEVELOPPLUGIN-015 | 完了 |
| PR-DEVELOPPLUGIN-086 | SP-DEVELOPPLUGIN-009 | 完了 |
| PR-DEVELOPPLUGIN-087 | SP-DEVELOPPLUGIN-011 | 完了 |
| PR-DEVELOPPLUGIN-088 | SP-DEVELOPPLUGIN-010 | 完了 |
