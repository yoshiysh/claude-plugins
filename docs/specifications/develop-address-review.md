# 仕様書: develop:address-review の詳細仕様・分類・返信

## 表記規約

仕様項目の語尾の区分は `docs/requirements/develop-address-review.md` の「表記規約」に従う（必須 = 〜しなければならない、推奨 = 〜することが望ましい、許容 = 〜してもよい、禁止 = 〜してはならない）。主体「address-review」「利用者」「CLI」の意味も同文書に従う。

## 対象範囲

本文書は、`develop:address-review` の詳細仕様を定める。本文書は `####` 見出し 1 つを 1 仕様項目とする。扱うのは次のとおり。

- PR コメント・スレッド・外部指摘の決定的な収集
- comment-triager による分類と triage-verifier による独立検証
- triage 構造（指摘、根拠、直す path、守る性質）の保持と `develop:implement` への path/sum 引き渡し
- 停止結果の引き継ぎと再開
- commit の作成および remote への push
- required checks の非同期待ち合わせ
- 指摘スレッドへの返信と投稿の再照合確認
- 条件付き resolve（条件を満たす fix 指摘のみ、decline や out_of_scope は閉じない）

### 本文書が実現する要求

- 主担当: `docs/requirements/develop-address-review.md` の PR-DEVELOPADDRESSREVIEW-001〜068

## 用語定義

| 用語 | 意味 |
|---|---|
| address-review | `develop:address-review` スキルの CLI およびオーケストレーション |
| triage | 各指摘を `fix`, `decline`, `out_of_scope`, `needs_decision`, `unverified` に分類する処理 |
| triage-result | 分類・根拠・対象 path・守る性質を記録した構造化 JSON ファイル |
| required checks | GitHub PR に設定された必須ステータスチェック・CI ワークフロー |
| 条件付き resolve | 自動修正と CI パス、返信確認が全て完了した fix スレッドのみを解決し、他は未解決で残す規約 |

## 機能仕様

### 指摘の収集と分類

#### SP-DEVELOPADDRESSREVIEW-001 指摘の全数収集
address-review は、GitHub API 経由で対象 PR の未解決スレッド（review comments）、PR 本文コメント（issue comments）、および指定された外部レビュー結果を全件取得し、状態ファイルに記録しなければならない。取得漏れや重複カウントを行ってはならない。

#### SP-DEVELOPADDRESSREVIEW-002 分類と独立検証
収集した指摘に対し、address-review は `comment-triager` を起動して分類（fix / decline / out_of_scope / needs_decision / unverified）を行わせなければならない。続いて別の独立した context で `triage-verifier` を起動し、分類の妥当性を照合しなければならない。両者の判定が一致した項目のみを確定分類とし、食い違いが生じた項目は `needs_decision` として扱わなければならない。

### triage 構造の維持と引き渡し

#### SP-DEVELOPADDRESSREVIEW-003 triage 構造の保持と path/sum 引き渡し
address-review は、確定した指摘の属性（指摘 ID、スレッド ID、対象 path、修正根拠、守るべき性質）を自然文に潰さず、構造化された JSON ファイル（`triage-result.json`）として書き出さなければならない。`develop:implement` を起動する際は、このファイルの絶対パスと SHA-256 ハッシュ値を引数として引き渡さなければならない。

#### SP-DEVELOPADDRESSREVIEW-004 停止結果の引き継ぎ
停止した run を再開する際、address-review は前回の実行で合意・確定した指摘の分類および修正状況を状態から引き継がなければならない。すでに検証が通った指摘について最初から分類や implement 呼び出しをやり直してはならない。

### 実装連携と push

#### SP-DEVELOPADDRESSREVIEW-005 implement 修正結果の検証
`develop:implement` の実行完了後、address-review は返された commit SHA を取得し、PR の base branch に対する祖先関係および修正コミットが対象パスを変更していることを検証しなければならない。

#### SP-DEVELOPIMPLEMENT-006 remote への push
修正コミットが確認された場合、address-review は PR の head branch に向けて remote へ push を実行しなければならない。push 後、remote の先端 commit SHA が一致することを照合しなければならない。

### CI 待ち・返信・resolve

#### SP-DEVELOPADDRESSREVIEW-007 required checks の非同期待ち合わせ
push 完了後、address-review は GitHub API で required checks の状態を定期監視しなければならない。全ての必須チェックが `success` になるまで待機し、いずれかが失敗した場合は `BLOCKED` で停止しなければならない。

#### SP-DEVELOPADDRESSREVIEW-008 返信の投稿と照合確認
required checks が通過した後、address-review は対象スレッドに対して修正内容または判断理由を返信として投稿しなければならない。投稿後、GitHub API で返信コメントが実在することを再照合して確認しなければならない。

#### SP-DEVELOPADDRESSREVIEW-009 条件付き resolve の執行
返信が確認されたスレッドのうち、分類が `fix` であり、修正コミットが含まれ、CI が全件通過したスレッドに限り、GraphQL API で resolve を実行しなければならない。`decline`、`out_of_scope`、`unverified` のスレッドは利用者の判断・合意を尊重するため、自動で resolve してはならず未解決のまま維持しなければならない。

## トレーサビリティ表

| 要求 ID | 仕様項目 ID | 状態 |
|---|---|---|
| PR-DEVELOPADDRESSREVIEW-001 | SP-DEVELOPADDRESSREVIEW-001 | 完了 |
| PR-DEVELOPADDRESSREVIEW-002 | SP-DEVELOPADDRESSREVIEW-001 | 完了 |
| PR-DEVELOPADDRESSREVIEW-003 | SP-DEVELOPADDRESSREVIEW-001 | 完了 |
| PR-DEVELOPADDRESSREVIEW-004 | SP-DEVELOPADDRESSREVIEW-001 | 完了 |
| PR-DEVELOPADDRESSREVIEW-005 | SP-DEVELOPADDRESSREVIEW-001 | 完了 |
| PR-DEVELOPADDRESSREVIEW-006 | SP-DEVELOPADDRESSREVIEW-001 | 完了 |
| PR-DEVELOPADDRESSREVIEW-007 | SP-DEVELOPADDRESSREVIEW-002 | 完了 |
| PR-DEVELOPADDRESSREVIEW-008 | SP-DEVELOPADDRESSREVIEW-002 | 完了 |
| PR-DEVELOPADDRESSREVIEW-009 | SP-DEVELOPADDRESSREVIEW-002 | 完了 |
| PR-DEVELOPADDRESSREVIEW-010 | SP-DEVELOPADDRESSREVIEW-002 | 完了 |
| PR-DEVELOPADDRESSREVIEW-011 | SP-DEVELOPADDRESSREVIEW-002 | 完了 |
| PR-DEVELOPADDRESSREVIEW-012 | SP-DEVELOPADDRESSREVIEW-002 | 完了 |
| PR-DEVELOPADDRESSREVIEW-013 | SP-DEVELOPADDRESSREVIEW-002 | 完了 |
| PR-DEVELOPADDRESSREVIEW-014 | SP-DEVELOPADDRESSREVIEW-002 | 完了 |
| PR-DEVELOPADDRESSREVIEW-015 | SP-DEVELOPADDRESSREVIEW-002 | 完了 |
| PR-DEVELOPADDRESSREVIEW-016 | SP-DEVELOPADDRESSREVIEW-002 | 完了 |
| PR-DEVELOPADDRESSREVIEW-017 | SP-DEVELOPADDRESSREVIEW-002 | 完了 |
| PR-DEVELOPADDRESSREVIEW-018 | SP-DEVELOPADDRESSREVIEW-002 | 完了 |
| PR-DEVELOPADDRESSREVIEW-019 | SP-DEVELOPADDRESSREVIEW-002 | 完了 |
| PR-DEVELOPADDRESSREVIEW-020 | SP-DEVELOPADDRESSREVIEW-002 | 完了 |
| PR-DEVELOPADDRESSREVIEW-021 | SP-DEVELOPADDRESSREVIEW-002 | 完了 |
| PR-DEVELOPADDRESSREVIEW-022 | SP-DEVELOPADDRESSREVIEW-003 | 完了 |
| PR-DEVELOPADDRESSREVIEW-023 | SP-DEVELOPADDRESSREVIEW-003 | 完了 |
| PR-DEVELOPADDRESSREVIEW-024 | SP-DEVELOPADDRESSREVIEW-005 | 完了 |
| PR-DEVELOPADDRESSREVIEW-025 | SP-DEVELOPADDRESSREVIEW-005 | 完了 |
| PR-DEVELOPADDRESSREVIEW-026 | SP-DEVELOPADDRESSREVIEW-005 | 完了 |
| PR-DEVELOPADDRESSREVIEW-027 | SP-DEVELOPADDRESSREVIEW-006 | 完了 |
| PR-DEVELOPADDRESSREVIEW-028 | SP-DEVELOPADDRESSREVIEW-006 | 完了 |
| PR-DEVELOPADDRESSREVIEW-029 | SP-DEVELOPADDRESSREVIEW-007 | 完了 |
| PR-DEVELOPADDRESSREVIEW-030 | SP-DEVELOPADDRESSREVIEW-007 | 完了 |
| PR-DEVELOPADDRESSREVIEW-031 | SP-DEVELOPADDRESSREVIEW-007 | 完了 |
| PR-DEVELOPADDRESSREVIEW-032 | SP-DEVELOPADDRESSREVIEW-007 | 完了 |
| PR-DEVELOPADDRESSREVIEW-033 | SP-DEVELOPADDRESSREVIEW-007 | 完了 |
| PR-DEVELOPADDRESSREVIEW-034 | SP-DEVELOPADDRESSREVIEW-007 | 完了 |
| PR-DEVELOPADDRESSREVIEW-035 | SP-DEVELOPADDRESSREVIEW-007 | 完了 |
| PR-DEVELOPADDRESSREVIEW-036 | SP-DEVELOPADDRESSREVIEW-007 | 完了 |
| PR-DEVELOPADDRESSREVIEW-037 | SP-DEVELOPADDRESSREVIEW-008 | 完了 |
| PR-DEVELOPADDRESSREVIEW-038 | SP-DEVELOPADDRESSREVIEW-008 | 完了 |
| PR-DEVELOPADDRESSREVIEW-039 | SP-DEVELOPADDRESSREVIEW-008 | 完了 |
| PR-DEVELOPADDRESSREVIEW-040 | SP-DEVELOPADDRESSREVIEW-008 | 完了 |
| PR-DEVELOPADDRESSREVIEW-041 | SP-DEVELOPADDRESSREVIEW-009 | 完了 |
| PR-DEVELOPADDRESSREVIEW-042 | SP-DEVELOPADDRESSREVIEW-009 | 完了 |
| PR-DEVELOPADDRESSREVIEW-043 | SP-DEVELOPADDRESSREVIEW-009 | 完了 |
| PR-DEVELOPADDRESSREVIEW-044 | SP-DEVELOPADDRESSREVIEW-009 | 完了 |
| PR-DEVELOPADDRESSREVIEW-045 | SP-DEVELOPADDRESSREVIEW-009 | 完了 |
| PR-DEVELOPADDRESSREVIEW-046 | SP-DEVELOPADDRESSREVIEW-009 | 完了 |
| PR-DEVELOPADDRESSREVIEW-047 | SP-DEVELOPADDRESSREVIEW-009 | 完了 |
| PR-DEVELOPADDRESSREVIEW-048 | SP-DEVELOPADDRESSREVIEW-009 | 完了 |
| PR-DEVELOPADDRESSREVIEW-049 | SP-DEVELOPADDRESSREVIEW-005 | 完了 |
| PR-DEVELOPADDRESSREVIEW-050 | SP-DEVELOPADDRESSREVIEW-008 | 完了 |
| PR-DEVELOPADDRESSREVIEW-051 | SP-DEVELOPADDRESSREVIEW-008 | 完了 |
| PR-DEVELOPADDRESSREVIEW-052 | SP-DEVELOPADDRESSREVIEW-008 | 完了 |
| PR-DEVELOPADDRESSREVIEW-053 | SP-DEVELOPADDRESSREVIEW-002 | 完了 |
| PR-DEVELOPADDRESSREVIEW-054 | SP-DEVELOPADDRESSREVIEW-005 | 完了 |
| PR-DEVELOPADDRESSREVIEW-055 | SP-DEVELOPADDRESSREVIEW-005 | 完了 |
| PR-DEVELOPADDRESSREVIEW-056 | SP-DEVELOPADDRESSREVIEW-005 | 完了 |
| PR-DEVELOPADDRESSREVIEW-057 | SP-DEVELOPADDRESSREVIEW-005 | 完了 |
| PR-DEVELOPADDRESSREVIEW-058 | SP-DEVELOPADDRESSREVIEW-004 | 完了 |
| PR-DEVELOPADDRESSREVIEW-059 | SP-DEVELOPADDRESSREVIEW-004 | 完了 |
| PR-DEVELOPADDRESSREVIEW-060 | SP-DEVELOPADDRESSREVIEW-009 | 完了 |
| PR-DEVELOPADDRESSREVIEW-061 | SP-DEVELOPADDRESSREVIEW-002 | 完了 |
| PR-DEVELOPADDRESSREVIEW-062 | SP-DEVELOPADDRESSREVIEW-002 | 完了 |
| PR-DEVELOPADDRESSREVIEW-063 | SP-DEVELOPADDRESSREVIEW-009 | 完了 |
| PR-DEVELOPADDRESSREVIEW-064 | SP-DEVELOPADDRESSREVIEW-009 | 完了 |
| PR-DEVELOPADDRESSREVIEW-065 | SP-DEVELOPADDRESSREVIEW-004 | 完了 |
| PR-DEVELOPADDRESSREVIEW-066 | SP-DEVELOPADDRESSREVIEW-004 | 完了 |
| PR-DEVELOPADDRESSREVIEW-067 | SP-DEVELOPADDRESSREVIEW-003 | 完了 |
| PR-DEVELOPADDRESSREVIEW-068 | SP-DEVELOPADDRESSREVIEW-004 | 完了 |
