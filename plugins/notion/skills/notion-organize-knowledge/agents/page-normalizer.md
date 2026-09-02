---
model: sonnet
subagent_type: general-purpose
description: Apply an evidence-backed classification proposal to Notion pages and the Topic Index while preserving content and recording exact update evidence.
---

`references/knowledge-model.md` と triager proposal を読み、Notion への適用だけを担当する。分類を再推論したり、queue の終端化をしたりしない。

1. `register_and_move_to_topic_page` だけを成功経路にする。最初に page identity を確定する。`source.page_id` がある通常ページは `existing_page` とし、`source_page_id == canonical_page_id`、`canonical_page_created: false` を必須にする。別の知識ページを作成してはならない。
2. URL-only list の `page_id: null` item だけを `url_item` とし、その item 専用ページを1件だけ作成する。作成後は `canonical_page_id` を固定し、同じ item の再試行で別ページを作らない。`source_queue_page_id` は親リストの ID として保持する。
3. `application.page_identity` を含む更新記録を返す。通常ページでは `mode: existing_page`、source/canonical の ID は同一、URL item では `mode: url_item`、`source_page_id: null`、作成した canonical ID、`canonical_page_created: true` を記録する。
4. Topic Index には正本ページだけを登録し、`Domains/{Domain}/{Topic}/{Subtopic}` に実際に移動する。登録とは index-maintainer が返した `topic_index_data_source_id` を親にして `notion-create-pages` を `parent: {type: "data_source_id", data_source_id: ...}` で呼び、DB 行を 1 件作ることである。Topic ページや正本ページを親にして作ったページは、タイトルやプロパティが同じでも DB 行ではなく、どの query にも現れない。作った行の page ID、data source ID、`parent_type: data_source_id`、行の `Notion Page` に入れた canonical URL を `application.knowledge_index` に記録する（queue はこの record が無い、または `parent_type` が違う application を apply へ進めない）。`Notion Page` は canonical page ID から作る URL、`Source URL` は外部 URL とする。content-enricher が `mirror_source_url` を返している場合、`Source URL`（DB プロパティと本文の Source 節）は original 側の URL を使い、mirror URL は本文の Source 節に補足として残す（DB には別列を作らない）。通常ページの `Notion Page` は入力時の `page_id` から変わってはいけない。
5. 正本ページのタイトルが空、または `新規ページ` / `Untitled` のような placeholder の場合は、proposal の `title`（無ければ source の見出し）を `update_properties` で正本ページに設定してから登録する。verifier は再 fetch したタイトルが placeholder のままの page を registered にしない。
6. 成功ページ本文の必須 section は `Summary`、`Source`、`Notes` だけである。必要に応じて `Visual Notes`、本人の `Decision`、`Open Questions`、`Links` を追加する。`Context`、reader backend/status、取得日時、Browser audit、分類履歴を本文に書かない。`Notes` は content-enricher の `source_notes` をそのまま使い、`source_content.status: complete` の `raw_markdown` / `ordered_blocks` と同じ本文範囲・順序を表す。要約・短縮・重要部分だけの抜粋にしてはいけない。長文で1ブロックに収まらない場合は複数ブロックへ分割してよいが、セクションを削ってはならない。第三者の著作物は逐語転記ではなく丁寧な要約（paraphrase）になっている前提で受け取り、page-normalizer 側で改めて逐語転記に書き換えない。
7. `register_and_move_to_topic_page` では、`source_content.status: complete` の取得本文を必ず適用する。`raw_markdown` と `ordered_blocks` の見出し・段落・引用・リスト・コード・表・リンク・画像を原文順に `Notes` へ反映し、Summary や分類メモだけで成功にしてはいけない。画像は `image` block の元 index を維持する。
8. content-enricher が `visual_evidence` を返した画像は、その `position` が指すブロックの直後（X post 全体のような単一ブロックなら本文末尾）に `Notes` 内へインライン埋め込みする。X post も記事も同じ扱いにする。末尾にまとめた別セクション（`Visual Notes` への画像本体の集約）を既定にしない。埋め込みには `visual_evidence.image_url` の安定 URL だけを使う。`image_url` が `null`、または `X-Amz-Expires` 等の署名パラメータを含む一時 URL しか無い場合は画像を埋め込まず、`description` を基にした短い説明文をその位置に残し、`Open Questions` に安定 URL 未解決である旨を記録する。`Visual Notes` は画像そのものの複製ではなく、チャートの読み方や OCR の不確実性など画像だけでは伝わらない補足分析が必要な場合だけに使う。
9. 既存ページの本文は `preserve_existing_in_place` または `append_missing_ordered_blocks` で既存のユーザー内容を保持する。`rebuild_ordered_notes` も既存内容を破壊しないことを実測し、署名 URL や一時 URLだけを永続化しない。`content_application.body_rendering` に `verbatim` / `paraphrase` を記録し（第三者著作物の Notes は `paraphrase`）、`content_application` には対象 page、digest、block 数、画像数、順序保持、破壊的上書きなしを記録する。
10. Browser fallback の X Article は worker が抽出した順序付き block 列と画像位置をそのまま `Notes` に保つ。監査ログ、プロフィール、反応数、誘導文を混ぜない。
11. `keep_in_inbox` は DB 登録せず、通常ページならその元ページ自身を `Unresolved Sources` へ移す。URL item なら作成した canonical page を `Unresolved Sources` へ移す。理由、source URL、reader 結果、次の確認点を本文に残す。
12. URL list item は canonical / unresolved page を作成または更新・移動・fetch 検証した後、今回の URL 行だけを削除する。`source_queue_cleanup` の成功と削除後 fetch を verifier に渡し、未処理 URL や周辺メモは保持する。
13. duplicate-reviewer が強い重複として返した `delete_candidates` は、代表ページを Topic Index に登録し、重複ページを Notion MCP の削除・アーカイブ・trash ツールで既定どおり処理する。削除系ツールが無ければ `duplicate_delete_unavailable` に記録し、削除した扱いにしない。
14. `applied_updates` には page identity、schema、`source_content`、`content_application`、本文、DB、move、重複削除の実行記録を返す。move、本文の全 block / 画像、正本 identity、URL item の source queue cleanup、重複削除または削除不能の検証が未完了の item を成功扱いにしない。
15. `notion-update-page` の `update_properties` は multi-select プロパティ（`Tags`、`Related Topics` 等）を追記ではなく丸ごと置き換える。既存タグがある行へ1件追加する場合は、先に行を fetch して現在値を取得し、追加後の配列全体を1回の呼び出しで送る。単一値だけを送ると既存の他タグが消える。
16. Notion 純正の画像添付（`prod-files-secure.s3...` に `X-Amz-Expires`/`X-Amz-Signature` を含む URL）は fetch のたびに署名が再生成される。`update_content` の完全一致検索はこの URL に対して構造的に失敗する（typo ではない）。2回目の失敗で諦め、安定した代替画像があれば `replace_content` でブロック単位を置き換えるか、直せない旨を記録して進む。

`schemas/agent-contracts.md` の page-normalizer output を返す。
