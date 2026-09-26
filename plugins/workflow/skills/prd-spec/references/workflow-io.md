# Workflow の入出力と復旧（workflow-io）

`scripts/draft.js`（Workflow A）と `scripts/refine.js`（Workflow B）の **args フィールドの意味・
返り値の読み方・途中死からの復旧・Workflow B の内部機構**を、このファイルが唯一の正とする。
呼び出しそのもの（args の JSON と手順）は SKILL.md が持つ。**同じ表を両方に置かない。**

**目次**: [1. Workflow A の args](#1-workflow-a-の-args) · [2. Workflow A の返り値](#2-workflow-a-の返り値)
· [3. 途中死からの復旧](#3-途中死からの復旧) · [4. Workflow B の args](#4-workflow-b-の-args)
· [5. Workflow B の内部機構](#5-workflow-b-の内部機構) · [6. 異常系・準正常系・正常系エッジ](#6-異常系準正常系正常系エッジ)
· [7. 本文の検査（doc_check.mjs）](#7-本文の検査doc_checkmjs)

---

## 1. Workflow A の args

| args | 意味 |
|---|---|
| `skillDir` | スキルの実ディレクトリ絶対パス。script は自身の位置を解決できず、agent の Read パスがここでしか決まらない |
| `self_containment` | **参照方針を採る案件では必須。** executability-auditor へ渡り、「参照先を見れば分かること」を着手不能として数えさせない。渡さないと、外出しした語彙リストの数だけ誤検出が量産され、本物の欠落がその中に埋もれる |
| `mode` | 手順 1 の判定。生成対象そのものを決める |
| `input` / `answers` | 確定要求の根拠原本（fabrication-auditor が照合する）。`answers` は手順 2 で質問したランのみ |
| `decisions` | intake の決定ログ + 司令塔が足した決定（分割の裁定など）。writer は `trace` の `kind: "decision"` として申告し、auditor は実在すれば受理する。書式と範囲の正は `references/question-policy.md` |
| `specimen_paths` | 標本適用監査に使う実在文書（Workflow B のみ）。省略時は fixed 文書を使う |
| `split_plan` | 採用した分割案（splitter 案から司令塔が裁定し、裁定は decisions に載せる）。構成は args で固定する |
| `tbd_items` | 未回答項目の持ち越し。確定要求に混ぜないため |
| `domain_findings` | 三値判定と根拠。「リスクと影響」章に非該当を根拠付きで残すのに要る |
| `required_categories` | 導出カテゴリ。writer が反映し coverage-auditor が実在を検査する |
| `flow` | 任意。flow-framer の返り値（工程の流れ。形は `schemas/agent-contracts.md` §flow-framer）。writer が各項目を要素に `flow_refs` で当て、構造検査が当たっていない要素を `ST-FLOW-UNATTACHED-` として返す。**形と閉包（行き先の無い判断の値・実在しない行き先・辿り着けない要素・行き先の無い工程）が崩れていると入口で止まる**（writer には flow を直す手段が無い）。渡さない run では当てはめの検査が `ST-NOTCHECKED-FLOW` になる |
| `existing_docs` | `review` / `expand` で Read した既存文書。渡した側だけが対象になる。`path` 必須（agent も checker もパスから読む。`markdown` だけの文書は入口で止まる）。`line_count`（`wc -l` の値）を添えると、書き手への区切り読みの単位が決まる |
| `draft_dir` | writer が初稿を Write する workspace の絶対パス。返り値の `documents[].draft_path` がその書き出し先で、以後の agent はここを Read する（本文をプロンプトに埋めない）。checker の入力も `<draft_dir>/checks/` に書かれる |
| `role_opts` | 任意。役割ごとの model / effort の上書き（例: `{"clarity": {"effort": "low"}, "writer": {"model": "sonnet"}}`）。既定値は script の表（refine.js の `AUDITORS` / `ROLE_OPTS`、draft.js の `ROLE_OPTS`）で、実測で較正する前提の出発点である（判断を要する係は opus / medium、1 文ずつ見て見落としが成果物の欠陥に直結する executability と fabrication だけ opus / high、照合の観点は sonnet / medium、checker は sonnet / low）。点検が軽い run で下げ、難所で上げる判断は呼び出す側が持つ。未知の役割名・値は入口で止まる。適用した値は返り値の `role_opts_applied` に出る |
| `today` | `YYYY-MM-DD`。文書中に日付が要るときの基準日。script 内では日時生成が禁止されているため args で渡すしかない |

## 2. Workflow A の返り値

| 項目 | 読み方 |
|---|---|
| **`gate2_skippable`** | **統合ゲートで質問のために止まるか（偽なら止まる）の唯一の判定。** 件数から再判定しない。真でも初稿サマリと決定ログの報告は行う（報告のみで直行） |
| `gate2_reason` | `no_blocking`（聞くことが無い）/ `blocking_present`（聞く項目がある）/ `structural_presentation_required`（`ST-DUP` / `ST-OBSOLETE` が残っており提示が要る）/ `executability_incomplete` / `structural_incomplete`（**検査が完了していないので飛ばせない**。後者は構造検査の checker が実行できなかった） |
| `documents[]` | 本文は含まない。`draft_path` が writer の書き出したファイル（checker が行数を照合済み）、`line_count` が checker の数えた行数。Workflow B の `documents` にそのまま渡す |
| `missing_checks` | 構造検査（checker）を実行できなかったパス。空でなければ `structural_findings` の 0 件は「未検査」である |
| `blocking_tbd_ids` | **まだ誰にも提示していない生の一覧。** この時点では `presented_tbd_ids` が存在しないため「未提示」は自明であり、`unpresented_blocking` はここでは算出されない |
| `executability.findings[].severity` | `blocking`（着手できない）/ `degraded`（着手はできるが後で作り直しになりうる）。blocking は script が TBD として起票し直し、`tbd_items` に含めている（ID は `TBD-EX-` 始まり）。ただし `resolved_by: writer`（文書内の食い違い・閉じていない集合）の blocking は TBD にせず、`EX-WRITER-` として `structural_findings` に入れる（Workflow B の初回改稿の対象になる） |
| `executability.missing` | 応答しなかった検査。**「指摘 0 件」と読まない。** 名指しで提示する |
| `categories_deferred` | **`required_categories` に含まれるものだけ**が入る。writer が別名を返したら`ST-UNKNOWN-CATEGORY-<名前>` として構造検査に出し、下流へは渡さない — このリストはcoverage-auditor への免罪符なので、導出カテゴリに無い名前は何も免除せず、「deferred にあるのに TBD が無い」検査で偽の指摘に化ける |
| `structural_findings` | 初稿段階の構造検査。**`ST-DUP` と `ST-OBSOLETE` は統合ゲートで提示する** — 前者は分割案の ID 体系の問題でユーザー判断が要り、後者は廃止済み規制の混入だから。それ以外は `draft_structural_findings` として Workflow B に渡し、初回改稿の契機に合流させる |
| `structural_not_checked` | **材料が無くて実行できなかった検査。「0 件」ではなく「未検査」として伝える** |
| `audit_trail` | 文書ごとの根拠の対応（`{ document, path, basis[] }` の配列。`basis[]` の要素は `{ item_id, kind, ref, quote }`）。**成果物の本文には根拠句を書かない**ので、「この記述はどこから来たか」はここにしか無い。Workflow B へ `documents[].trace` としてそのまま渡る。**Workflow B の `audit_trail` は同じ配列を `basis` に入れ子にしたオブジェクト**で、裁定の記録が加わる（§4.5） |
| `paths` | Workflow B に**そのまま渡す**。A と B で違う値を使うと本文と INDEX が別ディレクトリに分裂する |
| `status: "BLOCKED"` | writer が文書を返さなかった。文書を捏造せず止めた状態。`writer_missing` でどれが返らなかったかを伝える |

## 3. 途中死からの復旧

**`BLOCKED` が API エラー由来のときは再開できる**（品質の問題ではないため）。

```
Workflow({ scriptPath: "[SKILL_DIR]/scripts/draft.js", resumeFromRunId: "<Run ID>", args: { ...同じ args... })
```

**`resumeFromRunId` だけでは `args` が引き継がれず即座に落ちる。** 同じ `args` を必ず添える。
なお公式仕様上、**落ちた agent より後に起動した agent は完了済みでも再実行される**
ので、executability 検査は一部やり直しになる。

### セッション上限で Workflow B が途中死したとき（`audit_rounds`）

改稿の途中で死ぬと、改稿済みと未改稿の文書が混在して**片側 ID が大量に出る**。これは中身の
欠陥ではなく適用の未完了なので、**統合ゲートの質問としてユーザーへ回してはならない。** 素直に
resume すると監査をもう一巡してから改稿に入り、同じ場所で死ぬ。診断はキャッシュにあるので、
**必要なのは適用だけ**である。

```
Workflow({ scriptPath: "[SKILL_DIR]/scripts/refine.js", resumeFromRunId: "<Run ID>",
           args: { ...同じ args..., audit_rounds: 1 } })
```

`audit_rounds: 1` は **r0 だけ agent 監査を行い、以降は構造検査（script の算術）だけで改稿
ループを回す**。summary の各観点は r0 の結果を保持する（未実施を 0 件に化けさせない）。
**再開直後に r0 の監査 agent が live で走り始めたら止めること** — prompt が変わってキャッシュが
効いておらず、予算だけ溶ける。走っている agent が writer だけかで判定する。

## 4. Workflow B の args

| args | 意味 |
|---|---|
| `documents` | 直前の返り値の `documents` をそのまま（本文は含まれない。`draft_path` / `line_count` / `trace` を落とさない）。パス（`draft_path` / `path`）の無い文書があると script が入口で落ちる（agent は本文をパスからしか読めない）。`markdown` を持っていても script は読まない。行数は script が入口で checker に数えさせる |
| `draft_dir` | writer が改稿稿を書く workspace の絶対パス。改稿ごとに前稿を `<kind>-<topic>.<R番号>.md` へ複写させて必要な箇所だけを Edit させる（全文を書き直させない）。checker が数えたファイルの行数と writer の `line_count` が合わない改稿は採用しない（前稿を維持し `writer_missing` に載る） |
| `role_opts` | 任意。役割ごとの model / effort の上書き（例: `{"clarity": {"effort": "low"}, "writer": {"model": "sonnet"}}`）。既定値は §1 の同じ行を見よ。点検が軽い run で下げ、難所で上げる判断は呼び出す側が持つ。未知の役割名・値は入口で止まる。適用した値は返り値の `role_opts_applied` に出る。監査役には読み方 `read`（`locate` / `full`）も指定できる（例: `{"consistency": {"read": "full"}}`。既定は consistency / coverage が `locate`、他は `full`。監査役以外への `read` は入口で止まる） |
| `bulk_read_path` | 任意。shunt plugin の `scripts/bulk-read` の絶対パス。渡すと `read: locate` の監査役が全範囲監査（初回と終端）で、安いモデルに候補箇所の逐語引用だけを探させ、引用を元ファイルで完全一致で特定してその節を原文で読んで判定する。script が割り当てた抜き取り範囲も全文読みして見落としを測る。bulk-read は script が組に分けて実行させる（1 組の送信量の見積もりを shunt の上限 400,000 バイトの半分以下に抑え、1 文書で超えるものは行範囲の片に分ける。時間切れの組だけ半分に割って 1 回再実行する）。未指定・行数やバイト数の分からない文書があるときは全文の区切り読みに戻る（`summary.locator` に `full_fallback` と理由が残る）。実行時に失敗した組はその組の文書だけを全文読みに戻す（`summary.locator` の `group_*`）。固定文書は全文読みに戻さず、見出し索引から要る節を読ませる。スコープ監査は変わらず変更範囲だけを読む。`next_args` に引き継がれる |
| `tbd_answers` | **今周回の**統合ゲートの回答。**空なら script は反映パスを飛ばす**（直す理由が無いまま全文書を書き直させない）。回答の空でない各行が既知の TBD ID を名指ししていれば、その TBD を持つ文書だけを反映パスで引き直す（要求文書が変われば仕様書は紐付けの追随のため引き直す）。ID を含まない行が 1 行でもあれば全文書を引き直す |
| `tbd_answers_history` | 過去周回の統合ゲート回答の累積。1 周目は `[]`。**2 周目以降は `next_args` が埋めるので手で作らない**（原本が欠けると過去回答由来の要求が fabrication の偽陽性になる） |
| `presented_tbd_ids` | これまでに提示済みの TBD。`unpresented_blocking` の唯一の入力。`{ id, digest }` の形（`digest` は script が計算済みの値。生 text を入れると全件が「未提示」に化ける）。1 周目は初回ゲートで提示した分を `blocking_tbd_items[].digest` から転記して積む。**2 周目以降は `next_args` が埋めるので手で作らない** |
| `outer_round` | 外側ループの周回（1〜`MAX_OUTER_ROUNDS`）。`R<outer>.<rev>` は `revision_log`（返り値のメタ情報）だけで使い、**生成文書には書かない**。**カウンタは 2 つある**ことを取り違えない |
| `paths` | 保存先ディレクトリ。**Workflow A に渡したものと同じ値**を渡す |
| `draft_structural_findings` | Workflow A の `structural_findings`。渡さないと A の検査結果が誰にも読まれない |
| `flow` | Workflow A に渡したものと同じ（§1）。改稿の writer が項目を当て直し、checker が当たり方を検査する。**2 周目以降は `next_args` が埋める** |
| `suppressed_finding_ids` | 過去 run の終端裁定で rejected（偽指摘）と分類された**構造検査**の指摘 ID の累積（例: `"ST-UNDECLARED-PR-X-003"`）。構造検査は無状態の算術なので、発火条件が本文に残る限り毎 run 同じ指摘を再起票する — この口が無いと棄却が run を跨いで効かない。**2 周目以降は `next_args` が埋める**。新規 run に持ち越すときは前 run の返り値 `suppressed_finding_ids_next` を転記する。対象は `auditor: 'structural'` の指摘に限る（LLM 監査者の指摘 ID は run ごとに振り直され、誤爆する） |

## 4.5 Workflow B の返り値のうち、司令塔が使うもの

| 項目 | 読み方 |
|---|---|
| `verdict` | `clean` / `audit_incomplete` / `adjudication_incomplete` / `revision_backstop_reached` / `unanswerable_findings` / `unresolved_findings` / `blocking_over_capacity` / `tbd_remaining` |
| `missing_auditors` | 応答しなかった監査役（`<観点>@<対象>`。対象は文書キー、consistency だけ `ALL`）と、構造検査を実行できなかったパス（`checker@<改稿 ID>`）。どちらも「0 件」と読まない。後者があれば `structural_not_checked` に `ST-NOTCHECKED-CHECKER` が載る |
| `documents[]` | 本文は含まない。`draft_path` が最新の稿（checker が行数を照合済み）、`line_count` が checker の数えた行数。**保存は `draft_path` を `path` へ複写して行う**（SKILL.md 手順 6） |
| `summary.*_findings` | 観点ごとの件数。**`null` は「0 件」ではなく「未検査」** |
| `summary.locator` | locate 読みを割り当てた監査役ごとの実績（`calls` / `locate` / `full_fallback` と `fallback_reasons` / `unreported` / `sampled_chunks` / `locator_quotes` / `locator_unmatched` / `findings_via_locator` / `locator_misses` / `locator_miss_rate`、組ごとの `groups` / `group_split_ok` / `group_full_fallback` / `group_unreported` / `group_fallback_reasons`）。`full_fallback` は呼び出し単位の件数で、組単位の全文読みは `group_full_fallback` に数える。`locator_misses` は抜き取り範囲でだけ見つかった指摘の件数を script が数えたもの（自己申告は `locator_misses_reported`）。抜き取りは文書の一部なので、見落とし率は下限の目安として読む。verdict には影響しない |
| `tbd_items` | 残った未確定事項。**完成条件はこれが 0 件**（SKILL.md「完成の定義」） |
| `unpresented_blocking` | blocking かつ未提示。1 件以上なら統合ゲートで聞く（`first_seen_round` 付き） |
| `auto_resolved_blocking` / `resolved_by_measurement` | 人間に聞かずに決着させた項目。**本文への反映はラン内で完了している**。保存の事後報告で決定として提示する（依頼者は覆せる） |
| `suppressed_findings` / `suppressed_finding_ids_next` | 前者は `suppressed_finding_ids` により集計前に畳んだ構造検査指摘（黙って消さない開示）。後者は今 run の rejected 裁定を合流させた累積で、**次の run（新規 run を含む）の `suppressed_finding_ids` にそのまま渡す** |
| `holding_rules` | 提示済みでなお決まらず、保持規則（規範文）へ変換した論点。文書側には規範文として入っている |
| `work_items` | 保持規則に対応する裁定の作業項目。**文書には書かない**。司令塔が Issue 化する |
| `audit_trail` | 項目 ID → 根拠、決定ログ、裁定の記録。納品文書に根拠句を書かないので、ここが唯一の証跡 |
| `blocking_over_capacity` | 起票された blocking が提示容量を超えている（起票側の較正失敗）。閾値の正は `scripts/check_blocking_rate.py` の定数 |
| `next_args` | 次周回にそのまま渡せる args。`tbd_answers` の `"<<ANSWER_HERE>>"` だけ置換する |

## 5. Workflow B の内部機構

Workflow B は `AUDITORS` の全観点の監査を並列で発行する（欠測分の部分リトライを含む）。**観点ごとの対象範囲と並列の形は
`scripts/refine.js` の `AUDITORS` が唯一の正**（ここに内訳を書くと二重管理になり必ずズレる）。
返り値の `summary` が観点ごとの件数（未検査は `null`）を返すので、読む側に内訳の知識は要らない。
validity と specimen は文書ごとに 1 体で走る。他文書は ID 一覧と見出し索引（checker が書き出す）で
渡し、突き合わせに要る節だけを読ませる。文書間の矛盾は文書の並び順で報告する側を 1 つに決める
（固定文書との矛盾は常に対象文書の側）。固定文書（このランの対象外）は、どの役割にも全文を読ませず、
見出し索引から要る節だけを読ませる。
specimen（標本適用監査）だけはコスト抑制のため初回監査と終端の網羅監査のみ参加し、標本が無い
ランでは skip される（欠測ではなく `specimen_skipped: true`。標本は `specimen_paths` で渡す。
省略時は fixed 文書を使う）。自己出自（同一 workspace）以外を最低 1 件含めることを推奨し、
自己出自のみのときは `specimen_self_only: true` で申告される。

改稿ループの停止は**乾き判定**が主で、固定回数ではない。script が各監査ラウンドの novelty
（前ラウンドまでに無い新規指摘の件数）を算出し、novelty 0 のラウンドが出たら改稿予算が残って
いても終端へ進む（返り値 `dry_stop: true` / `novelty_history`）。同一 digest のまま 2 回連続で
残った指摘は stuck として通常改稿から外れる。回数は backstop（`REVISION_BACKSTOP`）だけ残り、
到達すると verdict に `revision_backstop_reached` が立つ。改稿前には専任の ladder-judge が
指摘を failure kind で 5 分類し（**人間必要性の判定パイプラインの段 1**。判定表は
`schemas/agent-contracts.md` §ladder-judge が正）、`artifact` / `criteria` / `consistency` だけを writer に流す。
状態 × イベント表・判定表・工程の流れの構造検査（`ST-STATE-` / `ST-DT-` / `ST-FLOW-`）は文書内の整合と
閉包の欠陥なので、judge を通さず writer へ流す。
`premise` / `question` は改稿予算を消費させず blocking TBD（`TBD-NI-`）として起票される。
**この TBD-NI も段 2（precedent-judge）の対象である** — 「依頼者にしか決められない」と分類
しただけで先例照合を免れると、同型の質問が周回のたびに人間へ戻る。段 2 で `resolvable` と
判定された分は `needs_input.items` から外れて `auto_resolved_blocking` に移る（両方に同じ項目は
現れない）。残りが `needs_input` に集まり、統合ゲートの提示対象に入る。ループ後の終端処理:

1. blocking が残っていれば**矛盾解消専用の追加改稿を 1 回きり**（validity / executability の
   2 観点だけで再確認。ループしない）。
2. stuck が残っていれば **resolver → resolver-verifier のバッチ処理を 1 回だけ**（解消候補の起草 → 検証 → 候補付きの最終改稿 → 再監査。役割の境界は `schemas/role-map.md`）。
   なお digest 不変なら `unanswerable` として返り、verdict は `unanswerable_findings`。
3. 収束後に**終端の網羅監査を全観点で 1 回だけ**行う（指摘起因の再監査は範囲限定のため）。
4. **終端裁定**: 残った全指摘を裁定 agent が三値（fixed / rejected / documented）に分類し、
   documented 分は転記改稿 1 回で反映する。`adjudication.unadjudicated` が空でなければ verdict は
   `adjudication_incomplete`。**未裁定 limbo（unresolved[] に載って終わるだけ）を残さない。**

終端裁定のあと、**人間必要性の判定パイプラインの段 2〜4** が走る（段 1 は上記 ladder-judge）。

| 段 | 係 | 判定 | 決着 |
|---|---|---|---|
| 2 | precedent-judge | 既裁定と同型か / 文書内の整合の問題か | `resolvable` と `internal`（`cited` の項目を書き手が揃える）は同一ラン内で本文へ反映。`auto_resolved_blocking[].resolved_as` が `internal` のものは後者 |
| 3 | measurement | 現物を読めば決まるか | 証拠付きで確定した分を同一ラン内で本文へ反映 |
| 4 | script（算術） | 提示済みでなお決まらないか | 保持規則へ変換し、裁定は `work_items` へ |

段 2・3 の結果は**同じラウンドのうちに writer が本文へ書き込む**（`R<outer>.resolve`）。
次周回に持ち越す設計にすると、未提示 blocking が 0 件になったランでは次周回そのものが
起きず、解消文が一度も書かれないまま「解消済み」として提示される。反映後は集計と構造検査を
引き直す。段 2・3 は迷ったら人間ゲートへ倒し、agent が応答しなければ全件がゲート行きになる。

外側ループの契約は変わらない（`outer_round` は乾き停止 + backstop `MAX_OUTER_ROUNDS`、blocking TBD は統合ゲート経路）。

## 6. 異常系・準正常系・正常系エッジ

本文の手順に書いてある状態はここに再掲しない（二重管理になる）。載せるのは、手順の本流から
外れた状態と、その状態で取り違えやすい対応だけである。

| 状態 | イベント | 種別 | 対応 |
|---|---|---|---|
| 入力受領 | 依頼が 1 行のみ | 正常系エッジ | intake が初稿に要る分だけ質問。分析観点はほぼ `不明`。推測で埋めない |
| 入力受領 | 曖昧語を含む依頼 | 準正常系 | 曖昧語を指摘し、測定可能な形の候補を 2〜3 提示 |
| 入力受領 | 小規模・低リスクな案件 | 正常系 | 共通規律は下げない。分割数が 1 になるだけ |
| 分析後 | 全観点が `不明` | 準正常系 | 「判定できなかった」と正直に提示し質問に回す。業界知識で埋めない |
| 分析後 | ユーザーが分割案を否定 | 正常系 | 指示された分割で執筆する。提案を押し通さない |
| 初稿後 | `blocking_over_capacity` が真 | 準正常系 | 提示の工夫では吸収できない。`references/traceability.md` §4 の基準で起票側を絞る |
| ループ中 | 新規 blocking が判明 | 正常系 | `unpresented_blocking` として返る（`first_seen_round` 付き）。backstop 未到達なら統合ゲートへ戻る |
| ループ中 | 監査が失格 0 件だが未確定事項が残る | 正常系 | **「完成しました」と提示しない。**「あと N 個決まれば着手できます」と伝える |
| 終端 | 計測で確定できなかった | 正常系 | 人間ゲートへ戻る。実測できなかったことを推測で埋めない |
| 実行中 | agent が応答しない（一部） | 異常系 | script が落ちた分だけを 1 回出し直す。それでも返らなければ欠測として報告される |
| 実行中 | 出した agent が全件応答しない | 異常系 | script は再実行しない（セッション上限・レート制限を疑う）。**上限の解除後に resume する** |
| ループ中 | auditor が応答しない | 異常系 | 「失格 0 件」と読まない。`missing_auditors` を名指しで提示（出し直し後もなお返らなかったもの） |
| 保存前 | 分割数が実行のたびに変わる | 準正常系 | 分割案は `decisions` に載った裁定を使う。裁定と違う構成で保存しない |
| 保存前 | INDEX だけが既存で本体が無い（またはその逆） | 準正常系 | 齟齬として報告する。INDEX は導出物なので本体に合わせて再生成する |

## 7. 本文の検査（doc_check.mjs）

Workflow script はファイルを読めず、writer は本文を返さない。本文を要する決定的な検査（構造検査・
行数・前稿との変更範囲）は `scripts/doc_check.mjs` が正本で、script は checker agent（安いモデル）に
入力 JSON を書かせてこの CLI を実行させ、出力だけを受け取る。

```
node <SKILL_DIR>/scripts/doc_check.mjs <input.json>   # 相対パスは実行時のカレントディレクトリ基準
```

| 入力 `documents[]` | 意味 |
|---|---|
| `key` / `kind` / `topic` / `fixed` | 文書の識別と種別 |
| `path` | 検査する本文のファイル（現在の稿） |
| `prev_path` | 任意。前稿のファイル。渡すと `changed_ranges` を返す |
| `ids` / `referenced` / `vacant` / `traceability` / `tbd_items` / `trace` | 構造検査の照合に使う申告（`trace` は `item_id` だけ。無ければ未検査として扱う） |
| `flow_refs` | 任意。項目 ID → 工程の流れの要素 ID（`{ item_id, ref }`） |
| `extract_ids` | 任意。申告の無い固定文書の ID を本文から抽出して補う |
| 入力（最上位） | `flow`（任意。キーが無ければ工程への当たり方を検査しない。`null` なら `ST-NOTCHECKED-FLOW` を返す。オブジェクトなら形と閉包と当たり方を検査する）/ `index_dir`（任意。各文書の見出し索引「開始行-終了行 見出し」を書き出す先）/ `index_extra`（任意。検査はせず索引だけを書くファイル。run の外の標本文書） |

| 出力 | 意味 |
|---|---|
| `documents[]` | `key` / `path` / `exists` / `line_count`（最終行も数えた行数）/ `newline_count`（`wc -l` と同じ数え方）/ `byte_size`（UTF-8 のバイト数。locate 読みの組分けに使う）/ `changed_ranges`（前稿が無ければ `null`、変更なしは `[]`）/ `ids_in_text`（`extract_ids` のときだけ）/ `index_path` / `index_lines`（`index_dir` のときだけ） |
| `structural` | `{ findings, not_checked }` の短い形。`findings` は同じ種別・同じ文書が続く指摘をまとめた `{ c: 種別, d: 文書キー, a: [引数の組, ...] }` の列、`not_checked` は `{ c, a }`。文面（`id` / `issue` / `fix` など）は出力に載せず、script が同じ表（`FINDING_TEXT`。doc_check.mjs と両 script に逐語で同じもの）から組み立てる — checker は出力を書き写して返すので、文面を載せると写す量が数百 KB になる。読めなかった文書は `ST-NOTCHECKED-BODY-<key>` として `not_checked` に載る（CLI は落ちない） |
| `index_extra` | `index_extra` を渡したときだけ。`{ path, exists, line_count, index_path, index_lines }` の配列 |
| `input_digest` / `output_digest` | 入力と出力をキー順正規化した JSON の digest。script が同じ値を計算し、checker の写し間違い（入力の欠け・指摘の脱落）を検出する。一致しなければそのパスは「検査を実行できなかった」として扱う |

入力が壊れている（`documents` が配列でない・`key` / `kind` / `path` が欠ける）ときだけ非ゼロで終わる。
**本文を読まない算術（TBD の名前空間化・`categories_deferred` の照合・抑止・INDEX の組み立て）は
script 側に残す** — checker が失敗しても `rebuildTbd` の前提（ID の名前空間化）が崩れないようにするため。
