# Workflow の入出力と復旧（workflow-io）

`scripts/draft.js`（Workflow A）と `scripts/refine.js`（Workflow B）の **args フィールドの意味・
返り値の読み方・途中死からの復旧・Workflow B の内部機構**を、このファイルが唯一の正とする。
呼び出しそのもの（args の JSON と手順）は SKILL.md が持つ。**同じ表を両方に置かない。**

**目次**: [1. Workflow A の args](#1-workflow-a-の-args) · [2. Workflow A の返り値](#2-workflow-a-の返り値)
· [3. 途中死からの復旧](#3-途中死からの復旧) · [4. Workflow B の args](#4-workflow-b-の-args)
· [5. Workflow B の内部機構](#5-workflow-b-の内部機構) · [6. 異常系・準正常系・正常系エッジ](#6-異常系準正常系正常系エッジ)

---

## 1. Workflow A の args

| args | 意味 |
|---|---|
| `skillDir` | スキルの実ディレクトリ絶対パス。script は自身の位置を解決できず、agent の Read パスがここでしか決まらない |
| `args_file` | args 全文を書いた JSON ファイルの絶対パス。指定するとその中身を args として読み、inline に同じキーがあれば inline が勝つ。30KB を超える args を毎周回タイプし直さないための経路（Workflow A / B の両方で使える） |
| `self_containment` | **参照方針を採る案件では必須。** executability-auditor へ渡り、「参照先を見れば分かること」を着手不能として数えさせない。渡さないと、外出しした語彙リストの数だけ誤検出が量産され、本物の欠落がその中に埋もれる |
| `mode` | 手順 1 の判定。生成対象そのものを決める |
| `input` / `answers` | 確定要求の根拠原本（fabrication-auditor が照合する）。`answers` は手順 2 で質問したランのみ |
| `decisions` | intake の決定ログ + 司令塔が足した決定（分割の裁定など）。writer は `trace` の `kind: "decision"` として申告し、auditor は実在すれば受理する。書式と範囲の正は `references/question-policy.md` |
| `specimen_paths` | 標本適用監査に使う実在文書（Workflow B のみ）。省略時は fixed 文書を使う |
| `split_plan` | 採用した分割案（splitter 案から司令塔が裁定し、裁定は decisions に載せる）。構成は args で固定する |
| `tbd_items` | 未回答項目の持ち越し。確定要求に混ぜないため |
| `domain_findings` | 三値判定と根拠。「リスクと影響」章に非該当を根拠付きで残すのに要る |
| `required_categories` | 導出カテゴリ。writer が反映し coverage-auditor が実在を検査する |
| `existing_docs` | `review` / `expand` で Read した既存文書。渡した側だけが対象になる |
| `today` | `YYYY-MM-DD`。文書中に日付が要るときの基準日。script 内では日時生成が禁止されているため args で渡すしかない |

## 2. Workflow A の返り値

| 項目 | 読み方 |
|---|---|
| **`gate2_skippable`** | **統合ゲートで質問のために止まるか（偽なら止まる）の唯一の判定。** 件数から再判定しない。真でも初稿サマリと決定ログの報告は行う（報告のみで直行） |
| `gate2_reason` | `no_blocking`（聞くことが無い）/ `blocking_present`（聞く項目がある）/ `structural_presentation_required`（`ST-DUP` / `ST-OBSOLETE` が残っており提示が要る）/ `executability_incomplete`（**検査が完了していないので飛ばせない**） |
| `blocking_tbd_ids` | **まだ誰にも提示していない生の一覧。** この時点では `presented_tbd_ids` が存在しないため「未提示」は自明であり、`unpresented_blocking` はここでは算出されない |
| `executability.findings[].severity` | `blocking`（着手できない）/ `degraded`（着手はできるが後で作り直しになりうる）。blocking は script が TBD として起票し直し、`tbd_items` に含めている（ID は `TBD-EX-` 始まり） |
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
| `documents` | 直前の返り値の `documents` から `markdown` を落とし、`draft_path`（手順 2 の書き出し先）を入れたもの。本文もパスも無い文書があると script が入口で落ちる（改稿が新規執筆に化けるのを防ぐ） |
| `tbd_answers` | **今周回の**統合ゲートの回答。**空なら script は反映パスを飛ばす**（直す理由が無いまま全文書を書き直させない） |
| `tbd_answers_history` | 過去周回の統合ゲート回答の累積。1 周目は `[]`。**2 周目は `next_args` が埋めるので手で作らない**（原本が欠けると過去回答由来の要求が fabrication の偽陽性になる） |
| `presented_tbd_ids` | これまでに提示済みの TBD。`unpresented_blocking` の唯一の入力。`{ id, digest }` の形（`digest` は script が計算済みの値。生 text を入れると全件が「未提示」に化ける）。1 周目は初回ゲートで提示した分を `blocking_tbd_items[].digest` から転記して積む。**2 周目は `next_args` が埋めるので手で作らない** |
| `outer_round` | 外側ループの周回（1 or 2）。`R<outer>.<rev>` は `revision_log`（返り値のメタ情報）だけで使い、**生成文書には書かない**。**カウンタは 2 つある**ことを取り違えない |
| `paths` | 保存先ディレクトリ。**Workflow A に渡したものと同じ値**を渡す |
| `draft_structural_findings` | Workflow A の `structural_findings`。渡さないと A の検査結果が誰にも読まれない |

## 4.5 Workflow B の返り値のうち、司令塔が使うもの

| 項目 | 読み方 |
|---|---|
| `verdict` | `clean` / `audit_incomplete` / `adjudication_incomplete` / `revision_backstop_reached` / `unanswerable_findings` / `unresolved_findings` / `blocking_over_capacity` / `tbd_remaining` |
| `summary.*_findings` | 観点ごとの件数。**`null` は「0 件」ではなく「未検査」** |
| `tbd_items` | 残った未確定事項。**完成条件はこれが 0 件**（SKILL.md「完成の定義」） |
| `unpresented_blocking` | blocking かつ未提示。1 件以上なら統合ゲートで聞く（`first_seen_round` 付き） |
| `auto_resolved_blocking` / `resolved_by_measurement` | 人間に聞かずに決着させた項目。**本文への反映はラン内で完了している**。保存承認ゲートで決定として事後提示する（依頼者は覆せる） |
| `holding_rules` | 提示済みでなお決まらず、保持規則（規範文）へ変換した論点。文書側には規範文として入っている |
| `work_items` | 保持規則に対応する裁定の作業項目。**文書には書かない**。司令塔が Issue 化する |
| `audit_trail` | 項目 ID → 根拠、決定ログ、裁定の記録。納品文書に根拠句を書かないので、ここが唯一の証跡 |
| `blocking_over_capacity` | 起票された blocking が提示容量を超えている（起票側の較正失敗）。閾値の正は `scripts/check_blocking_rate.py` の定数 |
| `next_args` | 次周回にそのまま渡せる args。`tbd_answers` の `"<<ANSWER_HERE>>"` だけ置換する |

## 5. Workflow B の内部機構

Workflow B は `AUDITORS` の全観点の監査を並列で発行する（欠測分の部分リトライを含む）。**観点ごとの対象範囲と並列の形は
`scripts/refine.js` の `AUDITORS` が唯一の正**（ここに内訳を書くと二重管理になり必ずズレる）。
返り値の `summary` が観点ごとの件数（未検査は `null`）を返すので、読む側に内訳の知識は要らない。
specimen（標本適用監査）だけはコスト抑制のため初回監査と終端の網羅監査のみ参加し、標本が無い
ランでは skip される（欠測ではなく `specimen_skipped: true`。標本は `specimen_paths` で渡す。
省略時は fixed 文書を使う）。自己出自（同一 workspace）以外を最低 1 件含めることを推奨し、
自己出自のみのときは `specimen_self_only: true` で申告される。

改稿ループの停止は**乾き判定**が主で、固定回数ではない。script が各監査ラウンドの novelty
（前ラウンドまでに無い新規指摘の件数）を算出し、novelty 0 のラウンドが出たら改稿予算が残って
いても終端へ進む（返り値 `dry_stop: true` / `novelty_history`）。同一 digest のまま 2 回連続で
残った指摘は stuck として通常改稿から外れる。回数は backstop（`REVISION_BACKSTOP`）だけ残り、
到達すると verdict に `revision_backstop_reached` が立つ。改稿前には専任の ladder-judge が
指摘を failure kind で 4 分類し（**人間必要性の判定パイプラインの段 1**。判定表は
`schemas/agent-contracts.md` §ladder-judge が正）、`artifact` / `criteria` だけを writer に流す。
`premise` / `question` は改稿予算を消費させず blocking TBD（`TBD-NI-`）として起票される。
**この TBD-NI も段 2（precedent-judge）の対象である** — 「依頼者にしか決められない」と分類
しただけで先例照合を免れると、同型の質問が周回のたびに人間へ戻る。段 2 で `resolvable` と
判定された分は `needs_input.items` から外れて `auto_resolved_blocking` に移る（両方に同じ項目は
現れない）。残りが `needs_input` に集まり、統合ゲートの提示対象に入る。ループ後の終端処理:

1. blocking が残っていれば**矛盾解消専用の追加改稿を 1 回きり**（validity / executability の
   2 観点だけで再確認。ループしない）。
2. stuck が残っていれば**多角化 escalation を 1 回だけ**（3 レンズ並列 → 最終改稿 → 再監査）。
   なお digest 不変なら `unanswerable` として返り、verdict は `unanswerable_findings`。
3. 収束後に**終端の網羅監査を全観点で 1 回だけ**行う（指摘起因の再監査は範囲限定のため）。
4. **終端裁定**: 残った全指摘を裁定 agent が三値（fixed / rejected / documented）に分類し、
   documented 分は転記改稿 1 回で反映する。`adjudication.unadjudicated` が空でなければ verdict は
   `adjudication_incomplete`。**未裁定 limbo（unresolved[] に載って終わるだけ）を残さない。**

終端裁定のあと、**人間必要性の判定パイプラインの段 2〜4** が走る（段 1 は上記 ladder-judge）。

| 段 | 係 | 判定 | 決着 |
|---|---|---|---|
| 2 | precedent-judge | 既裁定と同型か | `resolvable` は同一ラン内で本文へ反映 |
| 3 | measurement | 現物を読めば決まるか | 証拠付きで確定した分を同一ラン内で本文へ反映 |
| 4 | script（算術） | 提示済みでなお決まらないか | 保持規則へ変換し、裁定は `work_items` へ |

段 2・3 の結果は**同じラウンドのうちに writer が本文へ書き込む**（`R<outer>.resolve`）。
次周回に持ち越す設計にすると、未提示 blocking が 0 件になったランでは次周回そのものが
起きず、解消文が一度も書かれないまま「解消済み」として提示される。反映後は集計と構造検査を
引き直す。段 2・3 は迷ったら人間ゲートへ倒し、agent が応答しなければ全件がゲート行きになる。

外側ループの契約は変わらない（`outer_round` は最大 2 周、blocking TBD は統合ゲート経路）。

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
| ループ中 | 新規 blocking が判明 | 正常系 | `unpresented_blocking` として返る（`first_seen_round` 付き）。周回 1 なら統合ゲートへ戻る |
| ループ中 | 監査が失格 0 件だが未確定事項が残る | 正常系 | **「完成しました」と提示しない。**「あと N 個決まれば着手できます」と伝える |
| 終端 | 計測で確定できなかった | 正常系 | 人間ゲートへ戻る。実測できなかったことを推測で埋めない |
| 実行中 | agent が応答しない（一部） | 異常系 | script が落ちた分だけを 1 回出し直す。それでも返らなければ欠測として報告される |
| 実行中 | 出した agent が全件応答しない | 異常系 | script は再実行しない（セッション上限・レート制限を疑う）。**上限の解除後に resume する** |
| ループ中 | auditor が応答しない | 異常系 | 「失格 0 件」と読まない。`missing_auditors` を名指しで提示（出し直し後もなお返らなかったもの） |
| 保存前 | 分割数が実行のたびに変わる | 準正常系 | 分割案は人間が承認したものを使う。承認と違う構成で保存しない |
| 保存前 | INDEX だけが既存で本体が無い（またはその逆） | 準正常系 | 齟齬として報告する。INDEX は導出物なので本体に合わせて再生成する |
