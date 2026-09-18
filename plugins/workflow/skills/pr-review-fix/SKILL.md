---
name: pr-review-fix
description: >
  [What] レビューで確定した指摘だけを安全に修正し、修正後に再レビューして結果を返す。
  [When] Use when PR、diff、skill、コード、仕様書、PRD、README などのレビュー結果を反映して直すとき。
  レビュー指摘を入力として plan、apply、verify を分離し、修正済み・残存・新規・未検証を根拠付きで返す。
  PR コメントへ返信する場合は、実際のコメント者を取得して @login でメンションする。
---

# PR Review Fix

レビュー結果をそのまま鵜呑みにせず、該当性を確認したうえで最小限の修正を行い、修正後に同じ観点で再検証する。
レビューと修正、修正と PR 投稿を混ぜず、各段階の状態を明示する。

## 実行モード

- `plan`: 指摘を分類し、修正方針・対象ファイル・検証方法を確定する。ファイルを変更しない。
- `apply`: 承認済みの計画だけを実装する。無関係な変更や推測による修正をしない。
- `verify`: 修正後に元の指摘を再確認し、新規問題を探索する。ファイルを変更しない。

モードを指定されない場合は `plan` から開始し、`apply` と `verify` は明示的な許可を得てから実行する。

## 実行規則

1. 対象、範囲、比較対象、レビュー結果、未コミット変更を確認する。
2. 指摘を `confirmed`、`rejected`、`unverified` に分ける。`confirmed` 以外は修正しない。
3. 混在した対象はファイルまたは変更単位で `skill`、`code`、`specification`、`prd`、`document` に分類する。
4. 各修正について、対応する指摘、期待する変更、影響範囲、検証方法を計画に記録する。
5. blocker または major の未検証指摘がある場合は fail-closed とし、推測で修正を進めない。
6. `apply` では指摘に必要な最小範囲だけを変更し、既存のユーザー変更を上書きしない。
7. `verify` では元の指摘が解消したか、修正が新しい問題を持ち込んでいないかを確認する。
8. 結果を `resolved`、`remaining`、`new`、`unverified`、`out_of_scope` に分ける。

## PR コメントへの返信

PR コメントに返信する場合は、まず GitHub API から対象コメントの `user.login` を取得する。
login を推測したり、表示名を login として扱ったりしない。取得できた場合だけ本文の先頭に
`@login` を付ける。取得できない場合はメンションを作らず、未解決の理由を報告する。

返信は、修正内容・検証結果・残存事項を短く記載する。対象コメントは
`GET /repos/{owner}/{repo}/pulls/{pull_number}/comments` で取得し、実際の `id` と
`user.login` を対応づける。スレッド返信は同じ PR review comments endpoint に
`POST` し、`body` と `in_reply_to=<comment_id>` を渡す（CLI では
`gh api repos/{owner}/{repo}/pulls/{pull_number}/comments --method POST -f body=... -F in_reply_to=<comment_id>`）。
レスポンスの comment id と投稿結果を記録し、対象 id が不明な場合は返信せず未解決として報告する。
PR への返信、commit、push、merge は、ユーザーがその操作を明示的に許可した場合だけ実行する。

## 出力

```json
{
  "mode": "plan|apply|verify",
  "target": {"kinds": [], "scope": "full|diff", "ref": ""},
  "changes": [],
  "resolved": [],
  "remaining": [],
  "new": [],
  "unverified": [],
  "out_of_scope": [],
  "verification": {"passed": [], "failed": [], "not_run": []},
  "comment_replies": [],
  "status": "planned|applied|verified|needs_review|blocked"
}
```

`status` は、未検証の blocker、検証失敗、または残存した major 以上の指摘がある場合に
`needs_review` または `blocked` とする。未実行の検証を成功扱いにしない。
