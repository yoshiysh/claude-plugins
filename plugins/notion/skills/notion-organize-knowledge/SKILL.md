---
name: organize-knowledge
description: >
  Notion MCP を使い、Bookmark / Inbox / URL-only list / Unresolved Sources などの入力から知識ページを根拠付きで整理し、
  Domain / Topic / Subtopic、Tags、Topic Index、Domains 階層へ安全に反映する。URL 補完、重複レビュー、本文正規化、
  queue による再開・レート制限・実測検証を含む。Notion を整理して、メモをDB化して、AI検索/RAG向けに正規化して、
  InboxやUnresolved Sourcesを処理して、などの依頼で使う。Use when Codex must organize a Notion capture queue with resumable, verified writes.
  単一リンクの要約やNotion外のベクトルDB構築には使わない。
---

# Notion 知識整理

Notion は知識 UI と正本ページの置き場、`Topic Index` は軽い索引、`Domains/{Domain}/{Topic}/{Subtopic}` は人間が辿る物理階層として扱う。`Inbox`、URL-only list、`Unresolved Sources` はいずれも入力になり得る capture queue であり、処理済みページの検索先にしない。

実行前に `references/knowledge-model.md`、対象に応じた `agents/*.md`、URL がある場合は `$url-reader` を読む。エージェント出力の正本は `schemas/agent-contracts.md` とする。

## 責務境界

- **AI worker** は本文・画像・URLの解釈、要約、Domain / Topic / Subtopic、Tags、Related Topics、重複の意味的判断、Unresolved 判断を行う。各タグと分類には根拠、既存候補、代替候補、決定理由を残す。
- **queue.py** は AI の代わりに分類しない。job の順序、lease、owner 照合、heartbeat、retry、domain backoff、イベント、終端化の構造条件だけを保証する。
- **verifier** は applying worker と別の role で Notion を再 fetch し、DB・本文・移動先・ancestor を実測する。worker の自己申告や `audit_passed` だけで終端化してはいけない。

## 正本ページの同一性ルール（必須）

queue/worker の責務分離は維持するが、通常の Notion ページを別の知識ページへ複製してはならない。次のルールを `page-normalizer`、`update-verifier`、`queue.py`、`validate_run_audit.py` で共通に適用する。

- `source.page_id` がある通常の Notion item は `existing_page` とする。`source_page_id` と `canonical_page_id` は同じ値でなければならず、その既存ページ自身を本文更新・Topic Index 登録・Domains または `Unresolved Sources` への移動対象にする。専用の知識ページを新規作成しない。
- URL-only list の URL 行で `page_id` が無い item だけを `url_item` とする。通常は URL item 専用の Notion ページを1件だけ作成し、そのページを `canonical_page_id` とする。ただし強い重複の既存canonicalを再利用する場合は新規ページを作らず、既存ページを `canonical_page_id` とする。
- URL item に一時ページを先に作成して `page_id` が付いた場合、その時点から `existing_page` として扱い、さらに別の canonical page を作らない。
- `source_queue_page_id` は URL-only list の親ページを示すだけであり、通常ページの `source_page_id` や canonical page の代替ではない。
- `application.page_identity` と `verification.page_identity` を必ず記録する。既存ページでは `canonical_page_created: false`、通常のURL itemでは `canonical_page_created: true` とする。URL itemが強い重複で既存canonicalを再利用する場合は、`reused_existing_canonical: true`、`duplicate_of: <既存canonical page id>`、`canonical_page_created: false` を記録し、既存canonicalの再fetch・Index照合・入力URL cleanupを検証する。
- URL item は canonical または Unresolved page の移動と ancestor 検証が成功した後、元の URL 行を最小差分で削除し、削除後 fetch で不在を確認する。通常ページには URL 行 cleanup を適用しない。
- 強い重複を検出しても、通常ページの正本を勝手に新規作成しない。URL itemは既存 canonical candidateを再利用し、同一内容を表す代替出典URLを既存正本に追記できる場合は追記して入力URLをcleanupする。既存ページを再利用できず、削除・アーカイブも不能なら `deferred`（`deferred_reason: duplicate_delete_unavailable`）にする。重複ページをTopic Indexに登録しない。

## 実行モデル

`workspace/` は Git 管理外の run state である。実行系は次の3層を明確に分ける。Python は**状態管理のみ**で、AI/MCP を実行できない shell の常駐化を worker と見なしてはいけない。

```text
control plane       queue.py: durable state, lease recovery, capacity, worklist
execution plane     AI/MCP worker: URL取得、AI分類、Notion書込み、独立検証
wakeup mechanism    automation heartbeat または AI/MCP を起動できる runner
```

- `dispatch` は lease を作らない。現在の空き枠に収まる `worklist` を返すだけである。
- worker は、**実際に同じ起動内で処理を開始する直前**に `claim --job-id` を実行する。予定・候補・shell のバックグラウンド起動だけで lease を取得してはいけない。
- `status` と `dispatch` は最初に期限切れ lease を回収する。期限切れの `leased` を稼働中人数や capacity として報告してはいけない。
- 常駐プロセスを使う場合でも、AI/MCP 呼出しができないものは control plane の監視に限る。本文取得、分類、Notion更新、検証を代行できると説明・記録してはいけない。
- automation heartbeat は execution-capable runner として扱う。一度起動したら、単発の報告で終わらず、下記の dispatch loop を容量が埋まるまで実行する。

```text
ready -> leased(resolve -> enrich -> classify -> apply -> verify) -> registered|unresolved|deferred
                 \-> waiting_retry -> ready
```

- `ready`: すぐ worker が claim して処理可能。
- `waiting_retry`: `retry.not_before` 前。domain gate がある場合は同一 domain を claim しない。
- `leased`: 1 worker が所有。heartbeat が無ければ lease expiry 後に `ready` へ安全に回収する。
- 終端状態は verifier の Notion 再 fetch record がある場合だけ使う。

## 必須フロー

1. `input-resolver` で対象を `notion_page`、`notion_children`、`notion_database`、`notion_search`、`url_list_page`、`url_list`、`resume_run` のいずれかに正規化する。`Unresolved Sources` は `notion_children` の一例である。
2. `index-maintainer` で `Knowledge HOME`、`Topic Index`（既存 `Knowledge Index` は互換候補）、`Domains`、`Unresolved Sources`、既存 option を確認する。
3. run を作成し、対象を**順序付き** job として固定する。親の URL list page 自体は job にせず、URL item を job にする。
4. `validate_run_audit.py --phase preflight` を通してから `dispatch` で worklist を作る。preflight は未処理 job がすべて `ready` で、既に verifier 済みの terminal job は保持されていることを確認する。
5. worker は worklist の job を `claim --job-id` してから1 jobを処理する。URL-only / embed-only / 弱いタイトルの URL は必ず `$url-reader` を実行してから分類する。url-reader の JSON に `browser_fallback.required: true` がある場合、canonical URL を固定したうえで in-app Browser fallback を同じ起動内に必ず実行し、`browser_capture` を記録してから分類へ進む。未実行のまま terminal 化してはいけない。
6. AI worker は `classification` proposal を返す。タグの値だけを返すことは禁止し、各タグの根拠と分類の比較理由を含める。
7. `page-normalizer` はまず page identity を確定し、proposal と `source_content` を正しい canonical page にだけ適用する。`source_content` は要約ではなく、取得元の本文を元の順序で表す必須適用データである。option 不足時は既存 option を保持して追加し、同じ値で再試行する。値や本文を落として成功扱いにしない。
8. `update-verifier` は別 role で Notion を再 fetch し、`notion_refetch.page_id` が page identity の `canonical_page_id` と一致すること、通常ページではそれが `source.page_id` と同一であることを確認する。さらに `content_verification` で source / applied / refetched digest、本文 block 数、画像数、本文・画像順序の一致を記録する。`complete` は identity、移動、本文、DB、必要な URL 行 cleanup を含む verifier record を必須とする。
9. terminal event ごとに `validate_run_audit.py --phase progress` を実行し、直後に dispatcher が次の ready job を補充する。全 job が終端になったときだけ `--phase final` を実行し、バッチ完了と報告する。

## Dispatcher loop（heartbeat / runner ごとに必須）

毎回、次のループを**実作業が可能な範囲で繰り返す**。`dispatch` の出力だけを残してターンを終えてはいけない。

1. 全 run を列挙し、各 run に `status` を実行して期限切れ lease を回収する。入力は run metadata と、このスレッドで指定済みの Bookmark / Inbox / URL-only list / Unresolved Sources 等すべてを対象にする。
2. 各 run で `dispatch --max-claims 4` を呼び、`available_capacity` までの worklist を得る。
3. worklist の各 job を、実行可能な worker 数（最大4）まで即時 `claim --job-id` する。claim 後は同じ起動で `resolve → enrich → classify → apply → verify` または `retry` / terminal まで必ず進める。
4. 独立した verifier が terminal を確定したら、直ちに progress audit を実行して step 2 に戻る。これにより worker 終了通知が次の pending を埋める。
5. 容量、レート制限、またはAI/MCP実行時間の上限で続行できないときだけ止める。この場合、未開始 job は `ready` のまま残し、取得中 job だけを `leased` にする。429 は lease を保持せず `waiting_retry` に遷移する。

同一AIが真の並列実行を提供しない環境では、最大4件を**論理 worker**として管理し、独立な URL 取得は並列 tool call にしてよい。Notion書込みは各 job の verifier 記録が完成してから行う。並列化のために、根拠収集・分類・書込み・検証を省略してはいけない。

## Queue コマンド

```bash
WORKSPACE=[SKILL_DIR]/workspace
QUEUE=[SKILL_DIR]/scripts/queue.py
AUDIT=[SKILL_DIR]/scripts/validate_run_audit.py

python3 "$QUEUE" create-run --workspace "$WORKSPACE" --input-kind notion_children \
  --source-json '{"page_id":"..."}' --batch-limit 50 --max-workers 4
python3 "$QUEUE" enqueue --workspace "$WORKSPACE" --run-id '<run>' \
  --source-json '{"page_id":"...","source_url":"https://example.com"}'
python3 "$AUDIT" --workspace "$WORKSPACE" --run-id '<run>' --phase preflight
python3 "$QUEUE" dispatch --workspace "$WORKSPACE" --run-id '<run>' --max-claims 4
# worklist の各 job は、実際に開始する直前に claim する
python3 "$QUEUE" claim --workspace "$WORKSPACE" --run-id '<run>' \
  --job-id '<job-id>' --worker-id 'worker-1'
# 既に registered/unresolved/deferred の job を訂正する場合は claim ではなく reopen
python3 "$QUEUE" reopen --workspace "$WORKSPACE" --run-id '<run>' \
  --job-id '<job-id>' --worker-id 'worker-2' --reason 'source_url should point at the original publisher, not the mirror'
```

- `dispatch` は non-mutating worklist であり、worker reservation ではない。`claimed` 数ではなく `status.capacity.active` の有効 lease 数だけを稼働 worker 数として扱う。
- worker は `advance` で phase を一段ずつ進める。`classify` には `--proposal-json`、`apply` には `--application-json` が必須である。旧 run を `verify` から再検証する場合は、Notion 更新を再実行せず `record-proposal --proposal-json` で AI の根拠付き分類を補完できる。
- 旧 terminal（`registered`/`unresolved`/`deferred`）を再検証・訂正するときは `claim` ではなく `reopen --job-id <id> --reason <理由>` を使う。`claim`/`record-proposal`/`advance` はいずれも既に lease 済みの job しか扱えず、terminal job には使えない。`reopen` は対象 job を再度 lease し、既定で `verify` phase へ戻す（`--phase` で `classify`/`apply` からやり直すことも指定できる）。既存の `proposal`/`application` 履歴は保持されるので、`record-proposal` や `advance` で内容を訂正してから改めて `complete` を実行する。preflight はその検証が済むまで dispatch してはいけない。
- 429 は `retry --retry-after <ISO-8601> --reason rate_limited` を使う。job の domain と同一 domain の claim は指定時刻まで止まる。
- 長い取得中は `heartbeat` で lease を延長する。
- verifier が別 role で再 fetch した後だけ `complete --verifier-id ... --verification-json ...` を実行する。完了 event の直後に `dispatch` を再実行する。
- 旧 schema v1 の run は、`migrate-run` を明示的に実行してから再開する。旧 `registered` / `unresolved` は自動で信頼せず verify phase へ戻す。

## 本文・分類のルール

- 成功ページの本文は `Summary`、`Source`、`Notes` を必須とする。`Summary` は短い要旨でよいが、`Notes` は要約ではない。取得できた本文の全セクションを、見出し・段落・コード・引用・リスト・表・リンクの構造と順序を保ったまま収める。ナビゲーション・広告・関連記事欄・反応数などの非本文要素以外は省略・取捨選択をしない。ただし第三者の著作物は逐語転記ではなく、原文の構成・順序を保った丁寧な要約（paraphrase）にする。見出し・箇条書きの各項目・数値・日付・固有名詞などの情報は削らない。自分自身のメモ、コードブロック、コマンド例、表・数値などの事実データは必要に応じて逐語で保持できる。原文を再取得できない場合は本文を捏造せず、既存の根拠付き要約を残したまま `Open Questions` に不足を記録する。
- 通常ページの成功条件は、元の `source.page_id` がそのまま Domains 配下へ移動し、Topic Index の `Notion Page` も同じ page ID を指すことである。新規ページを作って元ページを Unresolved Sources に残した状態は成功ではない。
- 成功ページに `Context`、reader backend/status、取得日時、Browser audit、実行ログ、分類履歴を置かない。これらは queue / proposal / verification にのみ残す。
- `source_content` は content-enricher の取得結果から必ず生成する。URL reader の `markdown`、Notion の既存クリップ、または Browser fallback の順序付き block 列を `raw_markdown` と `ordered_blocks` に保持し、AI が要約を書き直したものを本文の代用にしてはいけない。`ordered_blocks` の `image` block は本文中の元の位置、画像 URL / 永続化された Notion asset、alt または視覚的説明を保持する。`digest`、`text_length`、`image_count` は実測値から計算し、分類用の Summary を `source_content` に混ぜない。
- in-app Browser fallback の取得手順・selector・`browser_capture` schema は `[SKILL_DIR]/references/in-app-browser-fallback.md` だけが定義する。この protocol は `url-reader` が代行できない「呼び出し側の agent が自分で実行する工程」なので、このスキルが自前で持つ（`url-reader` は別 plugin であり、そのファイルをパスで参照しても install 先では解決しない）。ここで再定義・再解釈しない。content-enricher が受け取った抽出済みブロック列（見出し・段落・コード・引用・リスト・表・リンク・画像）を元記事順のまま `Notes` に置き、プロフィール、反応数、誘導文、Browser audit を混ぜない。画像を先頭・末尾へまとめたり、画像 URL だけを別の節へ移したりしてはいけない。
- 登録成功には `source_content.status: complete`、本文 digest、ordered block 数、画像数、`content_application`、独立 verifier による本文・画像順序の一致が必須である。取得本文が `Partial`、画像が欠落、または原文と適用本文の対応を確認できない場合は登録せず、根拠と不足を `Unresolved Sources` へ移す。
- 根拠不足は DB に登録せず `Unresolved Sources` へ移す。理由、source URL、reader 結果、次の確認点を残す。
- 同一 source URL、normalized URL、または Notion capture の強い重複は、代表ページだけを残す。重複ページは既定で削除・アーカイブ・trash を実行し、削除系ツールが初期一覧に無ければ `tool_search` で露出を試す。検索後も利用できない場合は削除した扱いにせず `duplicate_delete_unavailable` として記録し、対象 job を `deferred`（`deferred_reason: duplicate_delete_unavailable`）にして報告する。重複ページを Topic Index に登録しない。

## 報告と完了条件

途中報告では、progress audit を通った item だけを「ページ完了」と呼ぶ。queue に `ready` / `waiting_retry` / `leased` が残っていても、既に検証済み item の結果を否定しない。`leased` は worker id・phase・有効期限を併記し、expired lease を含む生の件数を稼働中と表現してはいけない。`バッチ完了` は final audit 成功時だけ使い、処理数、DB 登録数、Unresolved 数、deferred 数、残件、domain backoff、次に人間が見る項目を報告する。既存の terminal job に page identity が無い場合は旧結果を信頼せず、`reopen` で再検証する。
