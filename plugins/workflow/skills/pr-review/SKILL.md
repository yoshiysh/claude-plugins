---
name: pr-review
description: >
  [What] 対象を分類し、複数観点を網羅して根拠付きの inline comment と summary を返す。
  [When] Use when PR、変更差分、既存ファイル、skill、コード、仕様書、PRD、README などのレビューを求められたとき。
  skill、コード、仕様書、PRD、README などを複数の独立した観点から網羅的にレビューし、
  確認済みの問題を inline comment 形式と全体 summary で返す。最初の指摘で終了せず、
  対象分類に応じた全観点を走査し、指摘ごとに根拠・影響・優先度・確信度を付ける。
  明示的な修正依頼がない限りファイルを変更しない。
---

# PR Review

対象を先に分類し、観点ごとの検査をすべて完了してから結果を返す汎用レビュー。PR の diff、
ローカルのファイル、ディレクトリ、貼り付けられた文書を扱う。

## 実行規則

1. 対象、範囲（full / diff）、基準ブランチまたは比較対象を確定する。
2. 対象をファイルまたは変更単位で `skill`、`code`、`specification`、`prd`、`document` に分類する。1つの PR に複数種別が含まれる場合は複数分類を保持する。
3. `references/review-lenses.md` の共通観点と、分類された**すべて**の対象別観点を走査する。
4. 各観点で見つけた候補を、該当箇所・期待・実際・影響の証拠付きで記録する。
5. 候補ごとに反証を行い、`confirmed`、`rejected`、`unverified` に分ける。
6. 分類したすべての観点の走査を終えてから出力する（走査した観点は出力の「走査した全観点」に列挙する）。
7. 明示的な修正依頼がない限り、ファイル、ブランチ、commit、push、merge は変更しない。PR 対象では、レビューコメントの投稿は既定で許可された状態変更として扱う。ユーザーが「投稿しない」「候補だけ」など明示した場合は投稿しない。
8. 指摘ごとに `claim`、直接確認した `evidence`、反証結果、`confidence`、severity の対応を記録する。条件付き推論や一次資料・実行確認のない環境依存の主張は `medium` 以下とし、`confirmed` にする場合も条件と未検証範囲を本文に明記する。

## 出力

主出力は inline comment の配列。PR でない場合も同じ形式で行・節・要素を指定する。

PR を対象にした場合は、各確定コメントを GitHub の review comment として投稿することをデフォルトとする。
ユーザーが「投稿しない」「候補だけ」など明示した場合だけ投稿を抑制する。
対象 PR の head commit SHA、変更後ファイル path、右辺の `line`、`side=RIGHT` を diff から解決し、
`gh api repos/{owner}/{repo}/pulls/{number}/comments --method POST` に `body`、`commit_id`、
`path`、`line`、`side` を渡す。投稿できない環境では投稿を試みず、同じコメントを Codex の
`::code-comment{title="..." body="..." file="..." start=... end=... priority=...}`
形式で返し、未投稿であることを summary に明記する。

投稿後は API レスポンスを検証し、`comment_id`、`commit_id`、`path`、要求した `line`、
API が返した `line` または `original_line`、`side`、`delivery` を記録する。API が `line=null`
でも `original_line` / `original_position` で解決された場合は、その差を未検証ではなく投稿結果の
メタデータとして残す。行位置を解決できない場合は投稿せず `candidate_only` にする。

severity と confidence は独立に決めるが、次を必ず守る。

- `blocker` / `major` は、差分・対象ファイル・一次資料・再現結果のいずれかを直接引用する。
- 環境変数、ホスト仕様、外部 API の挙動などを実行確認していない条件付き主張は `confidence=medium`
  以下にし、未確認の条件を本文に書く。確認できないまま断定的な `high` にはしない。
- 根拠が条件付きで、影響が未測定なら `unverified` として残す。`confirmed` は「問題の存在」を
  根拠から確認できた場合だけにする。

各コメントは次を含める。

- `severity`: `blocker` / `major` / `minor` / `nit`
- `confidence`: `high` / `medium` / `low`
- `location`: ファイルと行、または文書の節
- `body`: 問題、根拠、影響、修正方針
- `status`: `confirmed` のみを inline 候補にする
- `delivery`: `posted` / `codex_directive` / `candidate_only`

inline 候補とは別に、次を summary に含める。

- 対象分類（複数可）とレビュー範囲
- 走査した全観点
- 確定・棄却・未検証の件数
- 未検証の理由
- 観点ごとのカバレッジ
- 観点ごとの `scanned_files`、未読ファイル、実行した検証、未検証理由
- 各確定指摘の evidence、反証結果、confidence と severity の対応

問題が 0 件でも、走査した観点と未検証項目を示す。未検証を「問題なし」として扱わない。

## 境界

- レビューと修正を同じ実行に混ぜない。修正はユーザーが明示した場合だけ別フローで行う。
- 一般知識だけで事実を断定しない。対象ファイル、diff、一次資料を根拠にする。
- 観点を省略した場合は、summary に理由を明記する。
