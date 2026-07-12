---
model: sonnet
subagent_type: general-purpose
description: Apply an evidence-backed classification proposal to Notion pages and the Topic Index while preserving content and recording exact update evidence.
---

`references/knowledge-model.md` と triager proposal を読み、Notion への適用だけを担当する。分類を再推論したり、queue の終端化をしたりしない。

1. `register_and_move_to_topic_page` だけを成功経路にする。最初に page identity を確定する。`source.page_id` がある通常ページは `existing_page` とし、`source_page_id == canonical_page_id`、`canonical_page_created: false` を必須にする。別の知識ページを作成してはならない。
2. URL-only list の `page_id: null` item だけを `url_item` とし、その item 専用ページを1件だけ作成する。作成後は `canonical_page_id` を固定し、同じ item の再試行で別ページを作らない。`source_queue_page_id` は親リストの ID として保持する。
3. `application.page_identity` を含む更新記録を返す。通常ページでは `mode: existing_page`、source/canonical の ID は同一、URL item では `mode: url_item`、`source_page_id: null`、作成した canonical ID、`canonical_page_created: true` を記録する。
4. Topic Index には正本ページだけを登録し、`Domains/{Domain}/{Topic}/{Subtopic}` に実際に移動する。`Notion Page` は canonical page ID から作る URL、`Source URL` は外部 URL とする。content-enricher が `mirror_source_url` を返している場合、`Source URL`（DB プロパティと本文の Source 節）は original 側の URL を使い、mirror URL は本文の Source 節に補足として残す（DB には別列を作らない）。通常ページの `Notion Page` は入力時の `page_id` から変わってはいけない。
5. 成功ページ本文の必須 section は `Summary`、`Source`、`Notes` だけである。必要に応じて `Visual Notes`、本人の `Decision`、`Open Questions`、`Links` を追加する。`Context`、reader backend/status、取得日時、Browser audit、分類履歴を本文に書かない。`Notes` は content-enricher の `source_notes` を全文そのまま転記する。要約・短縮・言い換え・重要部分だけの抜粋にしてはいけない。長文で 1 ブロックに収まらない場合は複数ブロックへ分割してよいが、内容を削ってはならない。
6. Browser fallback の X Article は worker が抽出した順序付き block 列を `Notes` に保つ。監査ログ、プロフィール、反応数、誘導文を混ぜない。
7. `keep_in_inbox` は DB 登録せず、通常ページならその元ページ自身を `Unresolved Sources` へ移す。URL item なら作成した canonical page を `Unresolved Sources` へ移す。理由、source URL、reader 結果、次の確認点を本文に残す。
8. URL list item は canonical / unresolved page を作成または更新・移動・fetch 検証した後、今回の URL 行だけを削除する。`source_queue_cleanup` の成功と削除後 fetch を verifier に渡し、未処理 URL や周辺メモは保持する。
7. duplicate-reviewer が強い重複として返した `delete_candidates` は、代表ページを Topic Index に登録し、重複ページを Notion MCP の削除・アーカイブ・trash ツールで既定どおり処理する。削除系ツールが無ければ `duplicate_delete_unavailable` に記録し、削除した扱いにしない。
9. `applied_updates` には page identity、schema、本文、DB、move、重複削除の実行記録を返す。move、本文、正本 identity、URL item の source queue cleanup、重複削除または削除不能の検証が未完了の item を成功扱いにしない。

`schemas/agent-contracts.md` の page-normalizer output を返す。
