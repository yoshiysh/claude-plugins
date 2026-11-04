# 仕様書: develop:review の詳細仕様・観点・2 段検証

## 表記規約

仕様項目の語尾の区分は `docs/requirements/develop-review.md` の「表記規約」に従う（必須 = 〜しなければならない、推奨 = 〜することが望ましい、許容 = 〜してもよい、禁止 = 〜してはならない）。主体「review」「利用者」「CLI」の意味も同文書に従う。

## 対象範囲

本文書は、`develop:review` の詳細仕様を定める。本文書は `####` 見出し 1 つを 1 仕様項目とする。扱うのは次のとおり。

- レビュー対象の特定（git diff または git 外対象）
- 観点の導出、`REVIEW.md` の必須観点、focus を書く段
- 規範文書における洗い出しの束の配り方と上限
- 観点別 reviewer による並列レビュー
- 2 段の検証役（verifier 1, verifier 2）による独立検証
- 運搬役の本文軽量化（票のみ）と結果ファイル（path と sum）の引き渡し
- 資産台帳の作成と未検証指摘の管理
- PR への投稿と投稿確認、git 外対象のレビュー

### 本文書が実現する要求

- 主担当: `docs/requirements/develop-review.md` の PR-DEVELOPREVIEW-001〜080

## 用語定義

| 用語 | 意味 |
|---|---|
| review | `develop:review` スキルの CLI およびオーケストレーション |
| focus | 観点ごとに「何をどこまで見るか」を決定する事前分析の段 |
| 洗い出しの束 | design 経路において抽出役が変更概念の関連箇所を列挙した参照集合 |
| 2 段検証 | reviewer の指摘に対し、証拠の有無（1段目）と反証・方針適合（2段目）を異なる context で検証する構造 |
| 確定指摘 | 2 段の検証を共に通過した客観的根拠のある指摘（fix / decline） |

## 機能仕様

### 対象の特定と focus

#### SP-DEVELOPREVIEW-001 レビュー対象と diff の導出
review は、指定された baseRef と headSha の間の git diff を決定的に抽出し、対象ファイル一覧を状態に記録しなければならない。利用者がファイルを直接名指した場合はそのファイルを対象とし、git 管理外のテキストが与えられた場合は `external` モードとして扱わなければならない。

#### SP-DEVELOPREVIEW-002 観点の導出と focus 段
review は、方針文書（`REVIEW.md`）に記載された必須観点および変更内容に応じた動的観点を導出しなければならない。各観点について reviewer を起動する前に、focus を書く段を実行し、その観点で着目すべき領域と検証境界を定義しなければならない。

### 束の配り方とコンテキスト制限

#### SP-DEVELOPREVIEW-003 洗い出しの束の配分とサイズ上限
変更の種類が `design` の場合、review は抽出役から渡された洗い出しの束を配分しなければならない。reviewer および 1 段目の検証役には束全体をコンテキストとして配り、2 段目の検証役には指摘が引用した行および該当節のみを配らなければならない。束の総行数には上限（1,000 行）を設け、上限を超える場合は分割して配らなければならない。

### 並列レビューと 2 段検証

#### SP-DEVELOPREVIEW-004 観点別 reviewer の並列起動
review は、定義された観点ごとに独立した reviewer agent を起動しなければならない。各 reviewer は与えられた diff、focus、方針文書、および洗い出しの束のみを参照し、他の reviewer の出力を参照してはならない。

#### SP-DEVELOPREVIEW-005 2 段の独立検証
各 reviewer が出した指摘に対し、review は 2 段の検証を実行しなければならない。
1. 第 1 検証役: 指摘が引用するコードや文書の事実関係、行番号の実在性を検証する。
2. 第 2 検証役: 指摘が方針文書や要求の原則に適合しているか、反証が存在しないかを別の新鮮な context で独立検証する。
両方の検証を通過した指摘のみを「確定指摘」として受理しなければならない。

#### SP-DEVELOPREVIEW-006 確定指摘の構造保持
review は、確定した指摘のデータ構造（指摘 ID、対象 path、行番号、根拠、守ろうとする性質、分類）を自然文に潰してはならず、構造化された JSON オブジェクトのまま維持しなければならない。前段から引き継いだ指摘情報もそのまま保持しなければならない。

### 運搬役と結果引き渡し

#### SP-DEVELOPREVIEW-007 運搬役の本文軽量化と path/sum 受け渡し
run 内の運搬役が返す本文は、各指摘に対する票（採否）と判定結果のみに限定しなければならない。指摘の全文や詳細解説を返り値に含めてはならない。CLI コマンド `record-run` は結果 JSON ファイル（`review-result.json`）を書き出し、次段への引き渡しはそのファイルの絶対パスと SHA-256 ハッシュ値で行わなければならない。

### 投稿と外部対象

#### SP-DEVELOPREVIEW-008 PR への投稿と投稿確認
PR が対象であり投稿が求められている場合、review は確定指摘を GitHub API 経由でインラインコメントおよび全体サマリーとして投稿しなければならない。投稿完了後、GitHub API でコメントが実在することを再照合して確かめなければならない。

#### SP-DEVELOPREVIEW-009 git 外対象のレビュー（external モード）
利用者が git 管理外のファイルまたはテキストを指定した場合、review は `external` モードとして起動しなければならない。方針文書の適用や PR 投稿は行わず、一般的な品質基準に基づくレビューを行い、結果をローカルファイルに出力しなければならない。

## トレーサビリティ表

| 要求 ID | 仕様項目 ID | 状態 |
|---|---|---|
| PR-DEVELOPREVIEW-001 | SP-DEVELOPREVIEW-001 | 完了 |
| PR-DEVELOPREVIEW-002 | SP-DEVELOPREVIEW-001 | 完了 |
| PR-DEVELOPREVIEW-003 | SP-DEVELOPREVIEW-001 | 完了 |
| PR-DEVELOPREVIEW-004 | SP-DEVELOPREVIEW-001 | 完了 |
| PR-DEVELOPREVIEW-005 | SP-DEVELOPREVIEW-001 | 完了 |
| PR-DEVELOPREVIEW-006 | SP-DEVELOPREVIEW-002 | 完了 |
| PR-DEVELOPREVIEW-007 | SP-DEVELOPREVIEW-002 | 完了 |
| PR-DEVELOPREVIEW-008 | SP-DEVELOPREVIEW-002 | 完了 |
| PR-DEVELOPREVIEW-009 | SP-DEVELOPREVIEW-002 | 完了 |
| PR-DEVELOPREVIEW-010 | SP-DEVELOPREVIEW-002 | 完了 |
| PR-DEVELOPREVIEW-011 | SP-DEVELOPREVIEW-002 | 完了 |
| PR-DEVELOPREVIEW-012 | SP-DEVELOPREVIEW-002 | 完了 |
| PR-DEVELOPREVIEW-013 | SP-DEVELOPREVIEW-002 | 完了 |
| PR-DEVELOPREVIEW-014 | SP-DEVELOPREVIEW-002 | 完了 |
| PR-DEVELOPREVIEW-015 | SP-DEVELOPREVIEW-002 | 完了 |
| PR-DEVELOPREVIEW-016 | SP-DEVELOPREVIEW-002 | 完了 |
| PR-DEVELOPREVIEW-017 | SP-DEVELOPREVIEW-002 | 完了 |
| PR-DEVELOPREVIEW-018 | SP-DEVELOPREVIEW-002 | 完了 |
| PR-DEVELOPREVIEW-019 | SP-DEVELOPREVIEW-002 | 完了 |
| PR-DEVELOPREVIEW-020 | SP-DEVELOPREVIEW-002 | 完了 |
| PR-DEVELOPREVIEW-021 | SP-DEVELOPREVIEW-002 | 完了 |
| PR-DEVELOPREVIEW-022 | SP-DEVELOPREVIEW-002 | 完了 |
| PR-DEVELOPREVIEW-023 | SP-DEVELOPREVIEW-002 | 完了 |
| PR-DEVELOPREVIEW-024 | SP-DEVELOPREVIEW-002 | 完了 |
| PR-DEVELOPREVIEW-025 | SP-DEVELOPREVIEW-002 | 完了 |
| PR-DEVELOPREVIEW-026 | SP-DEVELOPREVIEW-002 | 完了 |
| PR-DEVELOPREVIEW-027 | SP-DEVELOPREVIEW-002 | 完了 |
| PR-DEVELOPREVIEW-028 | SP-DEVELOPREVIEW-002 | 完了 |
| PR-DEVELOPREVIEW-029 | SP-DEVELOPREVIEW-002 | 完了 |
| PR-DEVELOPREVIEW-030 | SP-DEVELOPREVIEW-007 | 完了 |
| PR-DEVELOPREVIEW-031 | SP-DEVELOPREVIEW-007 | 完了 |
| PR-DEVELOPREVIEW-032 | SP-DEVELOPREVIEW-007 | 完了 |
| PR-DEVELOPREVIEW-033 | SP-DEVELOPREVIEW-007 | 完了 |
| PR-DEVELOPREVIEW-034 | SP-DEVELOPREVIEW-007 | 完了 |
| PR-DEVELOPREVIEW-035 | SP-DEVELOPREVIEW-007 | 完了 |
| PR-DEVELOPREVIEW-036 | SP-DEVELOPREVIEW-007 | 完了 |
| PR-DEVELOPREVIEW-037 | SP-DEVELOPREVIEW-007 | 完了 |
| PR-DEVELOPREVIEW-038 | SP-DEVELOPREVIEW-007 | 完了 |
| PR-DEVELOPREVIEW-039 | SP-DEVELOPREVIEW-007 | 完了 |
| PR-DEVELOPREVIEW-040 | SP-DEVELOPREVIEW-007 | 完了 |
| PR-DEVELOPREVIEW-041 | SP-DEVELOPREVIEW-007 | 完了 |
| PR-DEVELOPREVIEW-042 | SP-DEVELOPREVIEW-007 | 完了 |
| PR-DEVELOPREVIEW-043 | SP-DEVELOPREVIEW-007 | 完了 |
| PR-DEVELOPREVIEW-044 | SP-DEVELOPREVIEW-007 | 完了 |
| PR-DEVELOPREVIEW-045 | SP-DEVELOPREVIEW-007 | 完了 |
| PR-DEVELOPREVIEW-046 | SP-DEVELOPREVIEW-007 | 完了 |
| PR-DEVELOPREVIEW-047 | SP-DEVELOPREVIEW-008 | 完了 |
| PR-DEVELOPREVIEW-048 | SP-DEVELOPREVIEW-008 | 完了 |
| PR-DEVELOPREVIEW-049 | SP-DEVELOPREVIEW-008 | 完了 |
| PR-DEVELOPREVIEW-050 | SP-DEVELOPREVIEW-008 | 完了 |
| PR-DEVELOPREVIEW-051 | SP-DEVELOPREVIEW-008 | 完了 |
| PR-DEVELOPREVIEW-052 | SP-DEVELOPREVIEW-008 | 完了 |
| PR-DEVELOPREVIEW-053 | SP-DEVELOPREVIEW-009 | 完了 |
| PR-DEVELOPREVIEW-054 | SP-DEVELOPREVIEW-009 | 完了 |
| PR-DEVELOPREVIEW-055 | SP-DEVELOPREVIEW-009 | 完了 |
| PR-DEVELOPREVIEW-056 | SP-DEVELOPREVIEW-009 | 完了 |
| PR-DEVELOPREVIEW-057 | SP-DEVELOPREVIEW-009 | 完了 |
| PR-DEVELOPREVIEW-058 | SP-DEVELOPREVIEW-009 | 完了 |
| PR-DEVELOPREVIEW-059 | SP-DEVELOPREVIEW-004 | 完了 |
| PR-DEVELOPREVIEW-060 | SP-DEVELOPREVIEW-004 | 完了 |
| PR-DEVELOPREVIEW-061 | SP-DEVELOPREVIEW-004 | 完了 |
| PR-DEVELOPREVIEW-062 | SP-DEVELOPREVIEW-004 | 完了 |
| PR-DEVELOPREVIEW-063 | SP-DEVELOPREVIEW-004 | 完了 |
| PR-DEVELOPREVIEW-064 | SP-DEVELOPREVIEW-005 | 完了 |
| PR-DEVELOPREVIEW-065 | SP-DEVELOPREVIEW-005 | 完了 |
| PR-DEVELOPREVIEW-066 | SP-DEVELOPREVIEW-005 | 完了 |
| PR-DEVELOPREVIEW-067 | SP-DEVELOPREVIEW-005 | 完了 |
| PR-DEVELOPREVIEW-068 | SP-DEVELOPREVIEW-005 | 完了 |
| PR-DEVELOPREVIEW-069 | SP-DEVELOPREVIEW-005 | 完了 |
| PR-DEVELOPREVIEW-070 | SP-DEVELOPREVIEW-005 | 完了 |
| PR-DEVELOPREVIEW-071 | SP-DEVELOPREVIEW-005 | 完了 |
| PR-DEVELOPREVIEW-072 | SP-DEVELOPREVIEW-005 | 完了 |
| PR-DEVELOPREVIEW-073 | SP-DEVELOPREVIEW-007 | 完了 |
| PR-DEVELOPREVIEW-074 | SP-DEVELOPREVIEW-007 | 完了 |
| PR-DEVELOPREVIEW-075 | SP-DEVELOPREVIEW-008 | 完了 |
| PR-DEVELOPREVIEW-076 | SP-DEVELOPREVIEW-008 | 完了 |
| PR-DEVELOPREVIEW-077 | SP-DEVELOPREVIEW-008 | 完了 |
| PR-DEVELOPREVIEW-078 | SP-DEVELOPREVIEW-003 | 完了 |
| PR-DEVELOPREVIEW-079 | SP-DEVELOPREVIEW-007 | 完了 |
| PR-DEVELOPREVIEW-080 | SP-DEVELOPREVIEW-006 | 完了 |
