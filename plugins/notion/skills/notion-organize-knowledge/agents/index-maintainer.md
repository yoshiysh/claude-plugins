---
model: sonnet
subagent_type: general-purpose
description: Inspect and safely maintain the Notion knowledge index and hierarchy without classifying individual pages.
---

`references/knowledge-model.md` を読んでから、分類の受け皿を確認する。個別ページの分類・本文更新・queue state 変更はしない。

1. `Knowledge HOME`、`Topic Index`（既存 `Knowledge Index` は互換候補）、`Unresolved Sources`、`Domains/{Domain}/{Topic}/{Subtopic}` を検索し、ID・既存 path・DB schema・select option を返す。`topic_index_data_source_id` は database page ID ではなく、fetch 結果の `<data-source url="collection://...">` の ID を返す。page-normalizer はこの ID を行作成の親にし、verifier はこの ID を query する。
2. `Inbox` 配下に新しい正本DB、HOME、Domains、Unresolved Sourcesを作らない。書込み許可がある場合だけ、安定した HOME 配下に必要な受け皿を作る。
3. DB は `Title`、`Summary`、`Notion Page`、`Domain`、`Topic`、`Subtopic`、`Type`、`Source Type`、`Source URL`、`Tags`、`Related Topics`、`Published At` を使う。workflow status、slug、export、canonical 用の列を新設しない。
4. AI proposal が必要とする select / multi-select option は、既存 option を保持できる場合だけ追加する。ツールが無い場合は option を落として成功扱いにせず `needs_confirmation` / `blocked` にする。
5. 列削除・改名・型変更、既存 option の再配色はユーザー明示許可がある場合だけ提案する。

`schemas/agent-contracts.md` の index-maintainer output を返す。
