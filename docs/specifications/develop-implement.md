# 仕様書: develop:implement の詳細仕様・経路・制御

## 表記規約

仕様項目の語尾の区分は `docs/requirements/develop-implement.md` の「表記規約」に従う（必須 = 〜しなければならない、推奨 = 〜することが望ましい、許容 = 〜してもよい、禁止 = 〜してはならない）。主体「implement」「利用者」「CLI」の意味も同文書に従う。

## 対象範囲

本文書は、`develop:implement` の詳細仕様を定める。本文書は `####` 見出し 1 つを 1 仕様項目とする。扱うのは次のとおり。

- 入口での依頼文の保存と目標の固定、人の回答の追記
- 変更の種類（code / design / document）に応じた経路分岐
- 計画の run（code 経路）とケース計画の作成・審査
- 洗い出しの段（design 経路の `implement-scope` 抽出役）
- 作業ファイルの読み手限定（生成役のみ）と同一 run 内・run 跨ぎ受け渡し
- 実装役（implementer）の起動、開始時・変更後 check の照合
- review 呼び出し、上限付き修正、根を探す段（`implement-scope` 根を探す役）
- 範囲拡大の人間ゲート（needs_input）
- プロセス停止と前提・環境障害の即時停止の区分
- 最終照合、commit、push、再開位置の記録

### 本文書が実現する要求

- 主担当: `docs/requirements/develop-implement.md` の PR-DEVELOPIMPLEMENT-001〜085

## 用語定義

| 用語 | 意味 |
|---|---|
| implement | `develop:implement` スキルの CLI およびオーケストレーション |
| 計画の run | planner と plan-reviewer が反復する読み取り専用 Workflow |
| implement-scope | 洗い出しの段（抽出役）および根を探す段（根を探す役）を担う Workflow |
| 洗い出しの束 | design 経路において抽出役が変更概念の関連箇所を列挙した参照集合 |
| 根を探す役 | 指摘が当初スコープ外を指した際に真の原因箇所を特定する agent |
| 人間ゲート | スコープ変更や未確定事項が発生した際に needs_input で人に指示を仰ぐ停止点 |

## 機能仕様

### 入口と目標の固定

#### SP-DEVELOPIMPLEMENT-001 目標の不変固定と回答の追記
implement は、呼び出し時に渡された依頼文から目的と範囲を抽出し、自己完結した目標文として状態に固定しなければならない。固定した目標文および元の依頼文は後から書き換えてはならない。人の追加回答が得られた場合は、目標文を書き換えるのではなく、独立した回答記録として状態に追加しなければならない。

#### SP-DEVELOPIMPLEMENT-002 方針の版と照合先ブランチの特定
implement は、渡された方針の版（commit SHA）が照合先ブランチ（PR の base branch、名指しされた base branch、または既定ブランチ）の先端の祖先であることを検証しなければならない。祖先関係が確認できない場合は受け取りを拒否して停止しなければならない。

### 経路の分岐と計画

#### SP-DEVELOPIMPLEMENT-003 対象の種類に応じた経路分岐
CLI は、変更対象ファイルの分類結果（`SP-DEVELOPPLUGIN-009`）に応じて実行経路を次のとおり分岐しなければならない。
1. `code`: 計画の run（`SP-DEVELOPIMPLEMENT-004`）を実行し、ケース計画を課す。
2. `document`: 計画の run を省略し、CLI が対象パスから自動的に計画オブジェクトを生成する。ケース計画は要求しない。
3. `design`: 計画の前に洗い出しの段（`SP-DEVELOPIMPLEMENT-005`）を必ず実行する。

#### SP-DEVELOPIMPLEMENT-004 計画の run とケース計画
`code` 経路において、implement は planner と plan-reviewer による読み取り専用 run を実行しなければならない。計画には条件ごとのケース計画を含めなければならない。plan-reviewer の承認が得られるか作り直し上限に達するまで反復し、上限到達時は停止しなければならない。

#### SP-DEVELOPIMPLEMENT-005 規範文書の洗い出し段（implement-scope）
`design` 経路において、implement は `implement-scope` の抽出役を起動し、変更対象の概念や規約に触れている文書内の箇所を洗い出し、洗い出しの束を作成しなければならない。抽出された束は次段の計画および review に引き渡さなければならない。

### 作業ファイルの受け渡しと独立性

#### SP-DEVELOPIMPLEMENT-006 作業ファイルの読み手制限
前回の作業ファイル（前回の planner や implementer の出力）を読める者は、生成役（次回の planner または implementer）の再開時のみに限定しなければならない。検証役（plan-reviewer および verifier）には前回の作業ファイル全文を渡してはならず、検証の客観的独立性を保たなければならない。

#### SP-DEVELOPIMPLEMENT-007 同一 run 内と run 跨ぎのコンテキスト引き渡し
同一 run 内の作り直しループでは、Workflow script が前回の出力をメモリ内に保持して次の prompt に引き渡さなければならない。run をまたぐ再開においては、CLI が状態ディレクトリに保存した作業ファイルを読み出して次回の生成役に渡さなければならない。

### 実装・check・修正ループ

#### SP-DEVELOPIMPLEMENT-008 開始時 check と差分比較
実装役（implementer）の起動前に、CLI は利用側の宣言で指定された開始時 check コマンドを実行し結果を記録しなければならない。実装完了後の check 結果は開始時の結果と比較し、新たな失敗が導入されていないことを検証しなければならない。

#### SP-DEVELOPIMPLEMENT-009 review の呼び出しと修正ループ
変更後 check を通過した変更に対し、implement は `develop:review` を呼び出さなければならない。確定した指摘（fix）が返された場合、上限回数の範囲内で実装役による修正ループを回さなければならない。

#### SP-DEVELOPIMPLEMENT-010 範囲外指摘の検出と根を探す段
review から返された指摘が当初の変更計画の範囲（`affected_paths`）の外を指している場合、implement は直ちに修正を行ってはならず、`implement-scope` の根を探す役を起動して原因箇所を特定しなければならない。

#### SP-DEVELOPIMPLEMENT-011 範囲拡大の人間ゲート
根を探す役が範囲拡大を推奨した場合、implement は自動的に範囲を変更してはならず、判断材料（影響範囲、理由、未着手一覧）を添えて `needs_input` で停止し、人の承認を求めなければならない。

### 停止と再開・完了

#### SP-DEVELOPIMPLEMENT-012 前提・環境障害の即時停止
implement は、プロセスの停止（乾き、反復上限、needs_input 等）と前提・環境障害（`E_PIN`, `E_POLICY`, `implementer-failed` 等の BLOCKED）を区別しなければならない。前提・環境障害が発生した場合は、反復やリカバリを試みず直ちに BLOCKED で停止しなければならない。

#### SP-DEVELOPIMPLEMENT-013 最終照合・commit・push
修正が完了し、最終の review で未解決の指摘が 0 件となった場合、implement は最終照合を実施しなければならない。最終照合を通過した変更のみを commit し、利用側の宣言に従って push を行わなければならない。ただし、`develop:address-review` から PR 修正として呼ばれた場合は commit までを行い、push は `develop:address-review` に委ねなければならない。

## トレーサビリティ表

| 要求 ID | 仕様項目 ID | 状態 |
|---|---|---|
| PR-DEVELOPIMPLEMENT-001 | SP-DEVELOPIMPLEMENT-001 | 完了 |
| PR-DEVELOPIMPLEMENT-002 | SP-DEVELOPIMPLEMENT-001 | 完了 |
| PR-DEVELOPIMPLEMENT-003 | SP-DEVELOPIMPLEMENT-002 | 完了 |
| PR-DEVELOPIMPLEMENT-004 | SP-DEVELOPIMPLEMENT-002 | 完了 |
| PR-DEVELOPIMPLEMENT-005 | SP-DEVELOPIMPLEMENT-002 | 完了 |
| PR-DEVELOPIMPLEMENT-006 | SP-DEVELOPIMPLEMENT-003, SP-DEVELOPIMPLEMENT-004 | 完了 |
| PR-DEVELOPIMPLEMENT-007 | SP-DEVELOPIMPLEMENT-004 | 完了 |
| PR-DEVELOPIMPLEMENT-008 | SP-DEVELOPIMPLEMENT-011 | 完了 |
| PR-DEVELOPIMPLEMENT-009 | SP-DEVELOPIMPLEMENT-012 | 完了 |
| PR-DEVELOPIMPLEMENT-010 | SP-DEVELOPIMPLEMENT-008 | 完了 |
| PR-DEVELOPIMPLEMENT-011 | SP-DEVELOPIMPLEMENT-008 | 完了 |
| PR-DEVELOPIMPLEMENT-012 | SP-DEVELOPIMPLEMENT-008 | 完了 |
| PR-DEVELOPIMPLEMENT-013 | SP-DEVELOPIMPLEMENT-008 | 完了 |
| PR-DEVELOPIMPLEMENT-014 | SP-DEVELOPIMPLEMENT-008 | 完了 |
| PR-DEVELOPIMPLEMENT-015 | SP-DEVELOPIMPLEMENT-008 | 完了 |
| PR-DEVELOPIMPLEMENT-016 | SP-DEVELOPIMPLEMENT-008 | 完了 |
| PR-DEVELOPIMPLEMENT-017 | SP-DEVELOPIMPLEMENT-008 | 完了 |
| PR-DEVELOPIMPLEMENT-018 | SP-DEVELOPIMPLEMENT-008 | 完了 |
| PR-DEVELOPIMPLEMENT-019 | SP-DEVELOPIMPLEMENT-008 | 完了 |
| PR-DEVELOPIMPLEMENT-020 | SP-DEVELOPIMPLEMENT-008 | 完了 |
| PR-DEVELOPIMPLEMENT-021 | SP-DEVELOPIMPLEMENT-008 | 完了 |
| PR-DEVELOPIMPLEMENT-022 | SP-DEVELOPIMPLEMENT-008 | 完了 |
| PR-DEVELOPIMPLEMENT-023 | SP-DEVELOPIMPLEMENT-008 | 完了 |
| PR-DEVELOPIMPLEMENT-024 | SP-DEVELOPIMPLEMENT-008 | 完了 |
| PR-DEVELOPIMPLEMENT-025 | SP-DEVELOPIMPLEMENT-008 | 完了 |
| PR-DEVELOPIMPLEMENT-026 | SP-DEVELOPIMPLEMENT-009 | 完了 |
| PR-DEVELOPIMPLEMENT-027 | SP-DEVELOPIMPLEMENT-009 | 完了 |
| PR-DEVELOPIMPLEMENT-028 | SP-DEVELOPIMPLEMENT-009 | 完了 |
| PR-DEVELOPIMPLEMENT-029 | SP-DEVELOPIMPLEMENT-009 | 完了 |
| PR-DEVELOPIMPLEMENT-030 | SP-DEVELOPIMPLEMENT-009 | 完了 |
| PR-DEVELOPIMPLEMENT-031 | SP-DEVELOPIMPLEMENT-009 | 完了 |
| PR-DEVELOPIMPLEMENT-032 | SP-DEVELOPIMPLEMENT-009 | 完了 |
| PR-DEVELOPIMPLEMENT-033 | SP-DEVELOPIMPLEMENT-013 | 完了 |
| PR-DEVELOPIMPLEMENT-034 | SP-DEVELOPIMPLEMENT-013 | 完了 |
| PR-DEVELOPIMPLEMENT-035 | SP-DEVELOPIMPLEMENT-013 | 完了 |
| PR-DEVELOPIMPLEMENT-036 | SP-DEVELOPIMPLEMENT-001 | 完了 |
| PR-DEVELOPIMPLEMENT-037 | SP-DEVELOPIMPLEMENT-001 | 完了 |
| PR-DEVELOPIMPLEMENT-038 | SP-DEVELOPIMPLEMENT-001 | 完了 |
| PR-DEVELOPIMPLEMENT-039 | SP-DEVELOPIMPLEMENT-001 | 完了 |
| PR-DEVELOPIMPLEMENT-040 | SP-DEVELOPIMPLEMENT-004 | 完了 |
| PR-DEVELOPIMPLEMENT-041 | SP-DEVELOPIMPLEMENT-004 | 完了 |
| PR-DEVELOPIMPLEMENT-042 | SP-DEVELOPIMPLEMENT-004 | 完了 |
| PR-DEVELOPIMPLEMENT-043 | SP-DEVELOPIMPLEMENT-004 | 完了 |
| PR-DEVELOPIMPLEMENT-044 | SP-DEVELOPIMPLEMENT-013 | 完了 |
| PR-DEVELOPIMPLEMENT-045 | SP-DEVELOPIMPLEMENT-013 | 完了 |
| PR-DEVELOPIMPLEMENT-046 | SP-DEVELOPIMPLEMENT-008 | 完了 |
| PR-DEVELOPIMPLEMENT-047 | SP-DEVELOPIMPLEMENT-008 | 完了 |
| PR-DEVELOPIMPLEMENT-048 | SP-DEVELOPIMPLEMENT-008 | 完了 |
| PR-DEVELOPIMPLEMENT-049 | SP-DEVELOPIMPLEMENT-013 | 完了 |
| PR-DEVELOPIMPLEMENT-050 | SP-DEVELOPIMPLEMENT-013 | 完了 |
| PR-DEVELOPIMPLEMENT-051 | SP-DEVELOPIMPLEMENT-013 | 完了 |
| PR-DEVELOPIMPLEMENT-052 | SP-DEVELOPIMPLEMENT-001 | 完了 |
| PR-DEVELOPIMPLEMENT-053 | SP-DEVELOPIMPLEMENT-002 | 完了 |
| PR-DEVELOPIMPLEMENT-054 | SP-DEVELOPIMPLEMENT-004 | 完了 |
| PR-DEVELOPIMPLEMENT-055 | SP-DEVELOPIMPLEMENT-004 | 完了 |
| PR-DEVELOPIMPLEMENT-056 | SP-DEVELOPIMPLEMENT-004 | 完了 |
| PR-DEVELOPIMPLEMENT-057 | SP-DEVELOPIMPLEMENT-013 | 完了 |
| PR-DEVELOPIMPLEMENT-058 | SP-DEVELOPIMPLEMENT-013 | 完了 |
| PR-DEVELOPIMPLEMENT-059 | SP-DEVELOPIMPLEMENT-013 | 完了 |
| PR-DEVELOPIMPLEMENT-060 | SP-DEVELOPIMPLEMENT-013 | 完了 |
| PR-DEVELOPIMPLEMENT-061 | SP-DEVELOPIMPLEMENT-013 | 完了 |
| PR-DEVELOPIMPLEMENT-062 | SP-DEVELOPIMPLEMENT-013 | 完了 |
| PR-DEVELOPIMPLEMENT-063 | SP-DEVELOPIMPLEMENT-009 | 完了 |
| PR-DEVELOPIMPLEMENT-064 | SP-DEVELOPIMPLEMENT-009 | 完了 |
| PR-DEVELOPIMPLEMENT-065 | SP-DEVELOPIMPLEMENT-008 | 完了 |
| PR-DEVELOPIMPLEMENT-066 | SP-DEVELOPIMPLEMENT-008 | 完了 |
| PR-DEVELOPIMPLEMENT-067 | SP-DEVELOPIMPLEMENT-008 | 完了 |
| PR-DEVELOPIMPLEMENT-068 | SP-DEVELOPIMPLEMENT-012 | 完了 |
| PR-DEVELOPIMPLEMENT-069 | SP-DEVELOPIMPLEMENT-012 | 完了 |
| PR-DEVELOPIMPLEMENT-070 | SP-DEVELOPIMPLEMENT-013 | 完了 |
| PR-DEVELOPIMPLEMENT-071 | SP-DEVELOPIMPLEMENT-013 | 完了 |
| PR-DEVELOPIMPLEMENT-072 | SP-DEVELOPIMPLEMENT-004 | 完了 |
| PR-DEVELOPIMPLEMENT-073 | SP-DEVELOPIMPLEMENT-004 | 完了 |
| PR-DEVELOPIMPLEMENT-074 | SP-DEVELOPIMPLEMENT-004 | 完了 |
| PR-DEVELOPIMPLEMENT-075 | SP-DEVELOPIMPLEMENT-004 | 完了 |
| PR-DEVELOPIMPLEMENT-076 | SP-DEVELOPIMPLEMENT-012 | 完了 |
| PR-DEVELOPIMPLEMENT-077 | SP-DEVELOPIMPLEMENT-008 | 完了 |
| PR-DEVELOPIMPLEMENT-078 | SP-DEVELOPIMPLEMENT-012 | 完了 |
| PR-DEVELOPIMPLEMENT-079 | SP-DEVELOPIMPLEMENT-005 | 完了 |
| PR-DEVELOPIMPLEMENT-080 | SP-DEVELOPIMPLEMENT-004 | 完了 |
| PR-DEVELOPIMPLEMENT-081 | SP-DEVELOPIMPLEMENT-006 | 完了 |
| PR-DEVELOPIMPLEMENT-082 | SP-DEVELOPIMPLEMENT-007 | 完了 |
| PR-DEVELOPIMPLEMENT-083 | SP-DEVELOPIMPLEMENT-010 | 完了 |
| PR-DEVELOPIMPLEMENT-084 | SP-DEVELOPIMPLEMENT-011 | 完了 |
| PR-DEVELOPIMPLEMENT-085 | SP-DEVELOPIMPLEMENT-012 | 完了 |
