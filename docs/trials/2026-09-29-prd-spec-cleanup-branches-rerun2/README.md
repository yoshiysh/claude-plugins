# prd-spec 再々試走レポート: cleanup-branches（R1〜R15 の後、段 R16）

skill の版: run1〜3 は `7a208d0`、run4〜5 は `7d06d97`（run3 の写し損ねを直した版。§1 の逸脱 2）。
比べる相手: 主は再試走 `docs/trials/2026-09-28-prd-spec-cleanup-branches-rerun/`（37 体）、前回 `docs/trials/2026-09-27-prd-spec-cleanup-branches/`（24 体）も列に残す。
比べる指標は計画の段 8 の一覧と段 R16 で足した項目に従う。値の出所は `evidence/` の各ファイル。抽出は `evidence/scan.py`・`extract.py`・`stdout_copies.mjs`・`reading.py` で再実行できる（§6）。
数値のうち推測・概算のものは、その場で「推測」「概算」と書いた。

## 1. 概要

- 入力は再試走と同じ。`W/input.md` は再試走の W の `input.md` を複写し、cmp で一致した。先例は 0 件（`evidence/orchestrator-log.md`）。
- W: `/home/user/claude-plugins/plugins/workflow/skills/prd-spec/workspace/cleanup-branches`。時刻は 2026-09-29T20:48:28Z〜2026-09-30T05:37:41Z。
- Workflow の呼び出しは 6 回で、そのうち名前付きの 1 回は拒否された（§1.1 の 1）。走った run は 5 つ（`evidence/run-outputs/run{1..5}.output.json`）。Workflow の Run は 2 つ（`wf_f413a4a5-c3e` が run1〜3、`wf_0f45ed55-8ba` が run4〜5）。
  1. 引数なしで起動 → needs_answers（G0、18 問: RS-001〜016・025・026）
  2. resume → needs_answers（G0-2、1 問: RS-033）
  3. resume → blocked「flow-check（段 3a）が doc_check flow の stdout を返しませんでした」（resumable false）
  4. run3 の `next_args` をそのまま渡して新しく起動（`from` 3a）→ needs_answers（G1、4 問: RS-045・049・050・051）
  5. resume → **done**（passes 3、stop_reason null）
- 最後は done。holds は RS-027・052・053・054・055・056 の 6 件、hold_drafts・open_tbd・integrity・missed はすべて空。
- 保持規則 6 件と Issue の文案は `evidence/prd-report.md`。要求文書は `evidence/requirements-cleanup-branches.md` に写した。

### 1.1 計画からの逸脱

1. **名前付きの呼び出しが無かった**: `Workflow({name:"workflow:prd-spec-run"})` は「not found. Available: deep-research」で拒否された（plugin が未 install）。
   同じ args を `scriptPath: plugins/workflow/workflows/prd-spec.js` で呼んだ。そのため R9（2 回目以降に承認を求められたか）は測れていない。
2. **版が途中で変わった**: run3 で haiku の flow-check:3a が `doc_check flow --rulings` の stdout を写し損ね、壊れた JSON を返した
   （3,558 字の写しの 3,195 字目で区切りが欠けた。`evidence/flow-check-3a-bad-stdout.json`）。`7d06d97` で stdout に `stdout_fnv` を付け、写し損ねは
   `flow-check:<…>-recopy` で 1 回取り直すようにした。run4 は resume せず run3 の `next_args` で起動した。保存された結果の stdout に
   `stdout_fnv` が無く、新しい script が写し損ねとして扱うからである（`orchestrator-log.md`）。
3. **W の場所**: 計画の W の根（`~/.claude/prd-spec-workspace-rerun2`）は、W の移動（`b0a8715`）で skill の `workspace/` の下に替わった。
4. **権限の数え方**: 計画の「manual モードで権限の確認で止まった回数」は、依頼者の裁定で auto mode に替えた。数えたのは agent の拒否の回数（§2 の表）。
   classifier の no-verdict は transcript で区別できる印が見つからず、数えていない。
5. **保存と Issue**: 試走なので、文書を repo の `docs/requirements` に写していない。Issue も起票していない。
6. **起動の数え方**: 計画は「保存された結果で返った agent は journal で数える」としていた。しかし journal は key ごとに started・result を 1 組しか
   持たない（wf_f413 が 32 組、wf_0f45 が 36 組で、どちらも transcript の数と同じ）。そのため replay は journal に現れない。replay の数は
   各 run の返り値の `workflowProgress` で数えた（tokens が null で、前の run で見た agentId の行）。
7. **telemetry**: `skill_telemetry.py record` は実行していない。`integrity`・`notices` の件数は run の返り値から数えた。

## 2. 比較表

「向き」は、計画に望ましい向きがある指標にだけ付けた。それ以外は増・減・同じで書く。

| 指標 | 前回 | 再試走 | 今回 | 向き |
|---|---|---|---|---|
| ゲートの回数（needs_answers） | 3 | 3 | 3（G0・G0-2・G1） | 同じ |
| AskUserQuestion の呼び出し | 5 | 7（5・1・1） | 7（G0 5・G0-2 1・G1 1） | 同じ |
| 問いの総数（G0 / G0-2 / G1） | 13（9 / 1 / 3） | 19（17 / 1 / 1） | 23（18 / 1 / 4） | 増 |
| G1 の問い | 3 | 1 | 4 | 増 |
| 最後の status | blocked | blocked | **done** | 改善 |
| remaining_blocking / holds / open_tbd | 2 / 2 / 0 | 2 / 4 / 0 | 無し（done）/ 6 / 0 | — |
| hold_drafts（最後の run） | 欄なし | 欄なし | 0（run2・3 は RS-027 の 1 件） | — |
| next_args の最大（`json.dumps(…, ensure_ascii=False)` の文字数。既定の ensure_ascii では 10,130） | 17,908 | 8,933 | 9,830（run4、G1 の後） | 増 |
| next_args の `state.flow` | あり | 無し | 無し（4 つとも） | 同じ |
| W の `stray` | 検査なし | 0 | 2（audited-1〜4・tree-digest の 5 回とも同じ 2 件） | 悪化 |
| W の `tmp/` の残り | script 5・控え 13 | 空 | ファイル 2・空のディレクトリ 1（§4.4） | 悪化 |
| W の外への書き込み | 測っていない | scratchpad に 2 ファイル | scratchpad に 5 体が書いた。2 ファイルが残存（§4.5） | 悪化 |
| doc_check の exit 1（うち引数の誤り） | 測っていない | 10（9） | 7（2） | 改善 |
| put が経緯の印で拒否 / 欄の条件で拒否 | 検査なし | 0 / 1 | 1 / 2 | 増 |
| doc_check flow の出力 / うち findings ≠ 0 | — | 29 / 0 | 60 / 0（codes はすべて `{}`） | — |
| 段 2 の `FLOW_DT_*` | 検査なし | 0 | 0 | 同じ |
| `SIZE_OVER`（予算は `SIZE_BUDGET`） | — | 4 → 5 → 5、最後 5 | 5 → 7 → 7 → 7、最後 7 | 悪化 |
| direction の逆転 / それで decision に回った件数 | 1 / 0 | 0 / 0 | 0 / 0 | 同じ |
| RS-028 に当たる論点が G0・G0-2 で出たか | 出ず | 出ず | **出た**（G0 の RS-012 と G0-2 の RS-033、§3.3） | 改善 |
| 初稿の writer のプロンプトの「出典が検証に落ちた流れの要素」 | — | 16 | 0（「（なし）」） | 改善 |
| doc_blocking（`ST-FLOW-UNATTACHED` を含む） | — | r1・r2 16、r3 0 | r1〜r4 すべて 0 | 改善 |
| agent 数（live の起動） | 24 | 37 | 68（run ごとに 12・17・3・14・22） | 増 |
| 保存された結果で返った agent（0 tokens） | — | — | 55（run2 12・run3 29・run5 14） | — |
| subagent_tokens（run の totalTokens の和） | 2,737,996 | 4,336,332 | 7,635,445（再試走の 1.76 倍、前回の 2.79 倍） | 増 |
| duration_ms の和 | 3,868,205 | 5,766,523 | 9,116,451（再試走の 1.58 倍） | 増 |
| 1 体あたりの初回ターン入力 | 62,583〜67,587 | 63,976〜69,221 | opus 64,820〜67,614・sonnet 66,140〜66,277・haiku 46,247〜46,503 | 注 |
| integrity / notices（最後の run） | 取れず | 0 / 3 | 0 / 10（stray 4・SIZE_OVER 4・既裁定の再出 2） | — |
| agent の権限の拒否（auto mode） | — | — | 2（どちらも Bash。run は止まらず、同じ agent が狭めたコマンドで続けた） | — |
| null の返り値で blocked（R7） / `stop_reason: budget` | — | — | 0 / 無し | — |

注:

- **agent 数**: 68 のうち 4 体（run4 の flow-check:3a-entry・flow-check:g0-2-answers・resolver:3a・flow-check:3a、252,731 tokens）は、
  修正後に段 3a から呼び直した分である（`transcript-extract.json` の `rerun_from_3a_after_fix`）。写し損ねが無ければ起動しなかったとみるのは推測である。
- **duration_ms**: run ごとの値（2,026,973・2,195,233・52,355・2,090,159・2,751,731）は `orchestrator-log.md` の記録である（run の出力ファイルには run 全体の duration の欄が無い。agent ごとの durationMs はある）。
- **初回ターン入力**: haiku は再試走に居ない役（flow-check）なので、範囲を分けた。opus と sonnet の範囲は再試走の範囲の中に入る。
- **next_args**: `NEXT_ARGS_MAX_CHARS=8000` はテストの中の上限で、実行時には検査しない。9,830 はこれを超える。
- **ゲートの args**: run4 の args と、run5 の args から `gates_answered` を除いたものは、どちらも run3 の `next_args` と一致した（`workflow_args_vs_next_args`）。
- **doc_check の exit 1 の内訳**（`doc_check_stderr_lines`）:
  - 引数の誤り（`--help`）: 2（verifier:3v の put、writer:U-1:revise の diff）。
  - 欄の条件: 2（verifier:3bv-settle と verifier:3v-settle-2。pass の項目に `fail_kind` を載せた）。2 体とも `fail_kind: null` を足して同じ put に成功した。
  - 逐語の照合: 1（resolver:3a-settle-pairs）。参照先の照合: 1（resolver:3a-fix）。
  - 経緯の印: 1（run5 の verifier:6v。verifications の reason に「r2-cd-」「r2-im-」）。次の put で RS-052〜055 を書けた。
- **null で blocked**: blocked は run3 の 1 回だけである。理由の文は、flow-check の stdout を JSON として読めなかったときの経路の文
  （`7a208d0` の prd-spec.js L1323、HEAD では L1371）で、agent が返り値を返さなかったときの `notRun` の文ではない。
- **holds と telemetry**: `holds` は writer に渡した保持規則だけを数え、渡していないものは `hold_drafts` に分かれる（`references/workflow-io.md` §3）。
  telemetry の `holds_count` は返り値の `holds` を数えるので、この意味に変わった（`scripts/skill_telemetry.py` L63。`hold_drafts_count` は別の欄）。今回は telemetry を記録していない。
- **権限の拒否**（`permission_denials`）: run2 resolver:3a の `rm -rf W/tmp/resolver__3a; ls …`、run4 implementer:r1 の `mkdir -p … && cat > … gen.py`。

### 2.1 SIZE_OVER の内訳（`evidence/checks/*.sizes.json`、単位はバイト）

`SIZE_BUDGET` の値は再試走と同じ。右端は再試走の最後の値。

| ファイル | SIZE_BUDGET | audited-1 | audited-2 | audited-3 | audited-4 | 最後 | 再試走の最後 |
|---|---:|---:|---:|---:|---:|---:|---:|
| resolutions.json | 64,241 | 67,094 | 91,069 | 99,323 | 101,170 | 101,170 | 88,110 |
| verifications.json | 19,165 | 34,531 | 40,837 | 42,675 | 43,354 | 43,354 | 37,674 |
| flow.json | 20,734 | 45,615 | 45,615 | 45,615 | 45,615 | 45,615 | 32,372 |
| open.json | 5,029 | 7,602 | 7,602 | 7,602 | 7,602 | 7,602 | 6,199 |
| routes.json | 655 | — | 3,872 | 5,794 | 5,953 | 5,953 | 1,656 |
| 要求文書 .md | 23,378 | 24,040 | 27,707 | 28,749 | 29,758 | 29,758 | 19,153 |
| meta.json | 25,654 | 25,029 | 31,041 | 32,705 | 33,691 | 33,691 | 12,197 |
| decisions.json | 6,887 | 4,247 | 4,247 | 4,247 | 4,247 | 4,247 | 3,645 |

- 超えたのは audited-1 で 5 件（decisions と meta 以外。routes は無い）、audited-2 以降は decisions 以外の 7 件。

### 2.2 起動の理由ごとの体数（`transcript-extract.json` の `launch_reasons`）

分類は HEAD の `plugins/workflow/skills/prd-spec/tests/test_launch_reasons.py` の `LABEL_FAMILIES`（label の形）と `PROMPT_CLUES`（プロンプトの行）で行った。
68 体のすべてがちょうど 1 つの形に当たった（`unclassified` は空）。数えたのは起動の回数で、label の種類の数ではない。

| 形（理由） | 起動 | tokens | run ごと | label（回数） |
|---|---:|---:|---|---|
| intake（base） | 1 | 112,819 | 1 | intake |
| flow-framer（base） | 1 | 127,333 | 1 | flow-framer |
| main-resolver（base） | 9 | 1,052,403 | 1:1・2:2・3:1・4:2・5:3 | resolver:3・3a（3）・3a'・3b・6（3） |
| main-verifier（base） | 6 | 745,376 | 1:1・2:2・4:1・5:2 | verifier:3v・3av・3bv・6v（3） |
| writer（base） | 4 | 668,136 | 4:1・5:3 | draft 1・revise 3 |
| audit-first（base、r1） | 3 | 506,267 | 4:3 | implementer・grounding・crossDoc の r1 |
| audit-scoped（base、r2 以降） | 6 | 1,093,359 | 5:6 | implementer・grounding の r2〜r4 |
| flow-check-entry（base） | 2 | 124,443 | 1:1・4:1 | 1-entry・3a-entry |
| flow-check-answers（base） | 4 | 219,769 | 2・3・4・5 に 1 ずつ | g0・g0-2（2）・g1 |
| flow-check-backup（base） | 4 | 221,062 | 4:1・5:3 | 4-backup・7-backup（3） |
| 差し戻し（v1 の不合格）: resolver | 4 | 410,911 | 1:1・2:2・4:1 | resolver:3-fix・3a-fix・3b-fix・6-fix |
| 差し戻し（v1 の不合格）: verifier | 4 | 394,568 | 1:1・2:2・4:1 | verifier:3-fixv・3a-fixv・3b-fixv・6-fixv |
| 変換 | 1 | 101,754 | 2:1 | resolver:3a-settle-convert |
| settle: flow-framer | 4 | 401,740 | 1:2・2:2 | 3-settle・3-settle-2・3a-settle・3b-settle |
| settle: verifier | 4 | 454,036 | 1:2・2:2 | 3v-settle・3v-settle-2・3av-settle・3bv-settle |
| 未裁定の O- と組（R6b） | 1 | 111,526 | 1:1 | resolver:3-settle-opens |
| 組の再検査 | 1 | 130,381 | 2:1 | resolver:3a-settle-pairs |
| 独立な flow の数え直し | 4 | 233,892 | 2・3・4・5 に 1 ずつ | flow-check:3a（2）・3a'・3a-settle-convert |
| 写しの取り直し（recopy） | 2 | 123,628 | 4:1・5:1 | crossDoc-r1-all-recopy・grounding-r4-…-recopy |
| 段 3b の組み直し | 1 | 143,537 | 2:1 | flow-framer:3b-reframe |
| crossDoc の再監査 | 2 | 258,505 | 5:2 | crossDoc:r2・r3 |
| 問いの形の修正・doc_check の差し戻し（flow・framer）・保持規則の書き直し・聞けない問いの変換・検証し残しの拾い直し・resolver:final | 0 | 0 | — | — |

settle のプロンプトの行（`prompt_clue_counts`）:

- 「検証の裁定（verification、R2）」: 2（flow-framer:3-settle・3b-settle）。
- 「閉じた未決の終端（left）」と「left、constrained_by」: 各 1（3a-settle）。
- 「裁定の無い不合格の要素（redo、R2）」: 1（3-settle-2）。
- 「settle の後の未裁定の O-（R6b）」: 1（3-settle-opens）。
- 「crossDoc の再監査（scopedAuditPlan が当てた項目）」: 2。
- 次の行は、どの起動にも現れなかった: 裁定した指摘（found）、続けて出た項目（R6）、stale_refs、handoff、直し手の振り分け（R6b）、
  R6 の「再発した項目」・「hold の指示」。

skipped の照合（`skipped`）: run3 と run4 の `verifier:3av`（unchanged、RS-033）、run5 の `verifier:3av` と `verifier:3a'v`（unchanged、RS-045・049・050・051）。
どの step も、その run の live の起動に同じ label が無い（食い違い 0）。run5 に `verifier:3av` が載るのは、`references/workflow-io.md` §3 の
「resume は script を頭から走り直すので、その leg の全体を返す」による説明で、コードでは確かめていない。

役ごとの比較（`role_counts_vs_rerun`。label の最初の `:` の前で束ねた）:

| 役 | 再試走 | 今回 | tokens（再試走 → 今回） |
|---|---:|---:|---|
| flow-check（haiku） | 0 | 16 | 0 → 922,794 |
| resolver | 11 | 16 | 1,259,353 → 1,806,975 |
| verifier | 10 | 14 | 988,674 → 1,593,980 |
| flow-framer | 3 | 6 | 318,464 → 672,610 |
| writer | 3 | 4 | 418,080 → 668,136 |
| implementer / grounding | 3 / 3 | 4 / 4 | 399,711 / 457,983 → 744,249 / 711,354 |
| crossDoc | 3 | 3 | 392,048 → 402,528 |
| intake | 1 | 1 | 102,019 → 112,819 |

- 増えた 31 体のうち 16 体は、再試走に居なかった flow-check である。
- 監査のパスが 1 つ多い（r4）ので、writer・implementer・grounding が 1 体ずつ多い。

### 2.3 usage.py と prompt cache（`evidence/usage.json`・`usage-weights-0.1.json`・`usage.txt`）

実行したコマンドは §6。母集団は 68 体で、除外は 0。

| 項目 | 再試走 | 今回 |
|---|---:|---:|
| agents | 37 | 68 |
| turns（opus / sonnet / haiku） | 539（451 / 88 / —） | 802（694 / 35 / 73） |
| input_all | 54,181,760 | 83,764,706 |
| cache_read（input_all に占める割合） | 50,336,083（92.9%） | 76,977,494（91.9%） |
| cache_creation（5 分 / 1 時間） | 3,844,599（内訳なし） | 6,785,138（6,785,138 / 0） |
| output | 48,637 | 89,930 |
| busy / span 秒 | 5,718.8 / 7,659.5 | 9,062.6 / 31,715.3 |

- span には G0 の回答待ち（約 4.6 時間）と run3〜4 の間の修正（約 1.7 時間）が入る。
- **請求の重み**: 倍率は `claude-api` スキル（2.1.285 同梱）の `shared/prompt-caching.md` の Economics の段と、同じスキルの料金表（cached 2026-09-25）から取った。
  cache read の倍率は model ごとに違う（Opus 5.5 と、Sonnet 5.5・Haiku 4.5 で別）。Haiku 4.5 の倍率は、料金表ではなく Economics の段の一般の値（Opus 5.5・Fable 5.1 以外）だけが出所である。usage.py は倍率を 1 組しか受け取らないので、2 組で 2 回実行した。
  model ごとに、合う組の出力の `by_model` の `weighted_input` を取った（`transcript-extract.json` の `weighted_input_by_model_matched`）。

| model | input_all | weighted_input（通常の入力に換算） | 割合 |
|---|---:|---:|---:|
| claude-opus-5-5 | 76,187,940 | 10,401,682.0 | 13.7% |
| claude-sonnet-5-5 | 3,606,645 | 823,545.0 | 22.8% |
| claude-haiku-4-5 | 3,970,121 | 1,421,314.9 | 35.8% |

- model ごとに通常の入力の単価が違うので、3 行の和は料金の比較には使えない。
- `usage.json` の `total.weighted_input`（12,332,371.2）は、haiku と sonnet にも opus の cache read の倍率を当てた値で、正しい合計ではない。

Workflow の呼び出しごと（`usage_per_run`。usage.py の `per_run` は wf_ のディレクトリごとで 2 行しか無いので、各 agent を最初に live で走った run に割り当てて足した）:

| run | 体 | input_all | cache_read の割合 | cache_creation | output | 直前の run の終わりからの空き |
|---|---:|---:|---:|---:|---:|---:|
| 1 | 12 | 13,356,855 | 91.0% | 1,199,807 | 18,853 | — |
| 2 | 17 | 18,403,332 | 91.5% | 1,558,988 | 24,675 | 16,419.8 秒（G0） |
| 3 | 3 | 685,154 | 78.2% | 149,141 | 895 | 92.2 秒（G0-2） |
| 4 | 14 | 19,687,352 | 92.9% | 1,391,661 | 20,424 | 5,981.6 秒（修正） |
| 5 | 22 | 31,632,013 | 92.1% | 2,485,541 | 25,083 | 109.7 秒（G1） |

- 空きは、前の run の live の agent の終わり（usage.json の `start + seconds`。seconds は 0.1 秒に丸めた値）の最大から、この run の最初の agent の `start` まで。
- run は 1 回ずつしか無い（n=1）。run の間の cache の差をどの要因によるものとみるかは推測である。

run の最初の agent の初回ターン（cache_read / cache_creation）:

| run | 最初の agent | 最初の opus の agent |
|---|---|---|
| 1 | flow-check:1-entry 0 / 46,237 | intake 0 / 64,818 |
| 2 | flow-check:g0-answers 0 / 46,477 | resolver:3a 0 / 66,605 |
| 3 | flow-check:g0-2-answers 0 / 46,413 | resolver:3a 39,476 / 27,179 |
| 4 | flow-check:3a-entry 0 / 46,489 | resolver:3a 0 / 66,643 |
| 5 | flow-check:g1-answers 0 / 46,410 | resolver:3a' 39,476 / 27,243 |

- 最初の agent は 5 回とも haiku の flow-check で、5 回とも cache を作った。
- 最初の opus の agent は、空きが 2 分未満の run3・run5 では約 39K を読んだ。空きが 1 時間を超えた run2・run4 では全体を作った。

初回ターンで cache を読んだか（`first_turn_cache_vs_gap`）。同じ model・同じ役の前の agent の最後の行から、この agent の起動までの空きで分けた
（implementer と grounding は同じ組に数えた。組は run をまたぐ）:

| 空き | opus・sonnet: 読んだ / 体 | haiku: 読んだ / 体 |
|---|---:|---:|
| 重なっている | 4 / 4 | — |
| 300 秒未満 | 14 / 14 | 1 / 6 |
| 300〜3,600 秒 | 0 / 22 | 0 / 7 |
| 3,600 秒以上 | 0 / 5 | 0 / 2 |
| 前が無い | 0 / 7 | 0 / 1 |

- 読んだ量は 32,419〜39,476 だった（resolver 39,310・39,476、verifier 38,784・38,950、implementer・grounding 39,355、haiku の flow-check 32,419）。
- 同じ run・同じ model・同じ役の 2 体目以降（R7 の header の並べ替えの確認）: 役を label の最初の `:` の前で分けると（implementer と grounding は別）43 体のうち 15 体、
  implementer と grounding を同じ組にすると 45 体のうち 17 体が、初回ターンで cache を読んだ（`same_role_first_turn` は前者）。
  読まなかった 28 体は、上の表では 300 秒以上の空きか haiku に入る。
- haiku が 300 秒未満でも読まなかった理由は確かめていない。
- **役をまたいだ共有**（`cross_role_check`。上の表と同じ組み方）: 見られなかった。
  - 同じ役の前から 300 秒以上空いて外れた opus・sonnet の初回ターンは 27 体。
  - そのうち 23 体は、同じ model の別の役の agent が 300 秒以内に動いていたが、読みは 0 だった。
  - 例: run5 の writer:U-1:revise は resolver:6・verifier:6v の直後に起動した。
- **作業ディレクトリ**: 68 本の transcript の `cwd` はすべて `/home/user/claude-plugins`（`transcript_cwd`）。

### 2.4 読んだものの内訳（R15。`evidence/reading.json`、概算）

費用の精査 §5.1 の `cat.py` と同じ按分で数えた。ターンごとのコンテキストの増分を、直前の応答が出した tool の結果の文字数で分ける。
分類の正規表現には、今回のプロンプトにある `doc_check get`・`describe` と `--ledger <台帳>` を足した（`reading.py`）。tool の結果をターンに割り当てる処理は reading.py で組み直した（cat.py の入力の agents.json を作った手順は残っていない）。そのため再試走の値と同じ数え方かは確かめていない。

| 読んだもの | 再試走（37 体） | 今回（68 体） |
|---|---:|---:|
| resolutions | 364K | 808K |
| agent-contracts.md の節 | 370K | 766K |
| input.md | 200K | 350K |
| agents/*.md | 202K | 340K |
| 要求文書と meta | 130K | 290K |
| flow | 176K | 260K |
| doc_check.mjs のソース | 106K | 89K |
| verifications | — | 75K |
| その他（references・findings・answers・decisions・checks・書き込み・分類外） | — | 483K |
| 合計（初回ターンの土台を除く） | 約 1.92M | 3.46M |

初回ターンのコンテキストの和（土台）は 4,173,424。

## 3. 監査の推移

### 3.1 パスごとの指摘（`evidence/findings/`）

r1 は段 5 の監査で、r2〜r4 は段 8 のパスである。返り値の `passes: 3` は段 8 のパスの数で、監査の回数 4 とは食い違わない。

| 監査 | findings | blocking | 項目 | doc_blocking | origin 別（blocking） | route（decision / writer） |
|---|---:|---:|---:|---:|---|---|
| r1 | 27 | 9 | 20 | 0 | ledger 11（7）・text 13（1）・input 3（1） | 16 / 11 |
| r2 | 8 | 2 | 6 | 0 | text 5（1）・ledger 2（1）・input 1（0） | 3 / 5 |
| r3 | 7 | 1 | 5 | 0 | text 5（1）・ledger 2（0） | 2 / 5 |
| r4 | 1 | 0 | 1 | 0 | ledger 1（0） | 1 / 0 |

- 再試走は r1 10（4）・r2 4（3）・r3 2（2）で、r3 に blocking が残って上限で止まった。
- doc_blocking は、各パスで指名された監査役の `doc_check doc` の stdout の blocking（`audit_designated_copies`）。4 回とも findings 0。
  not_checked 1 件（`ST-NOTCHECKED-CROSSREF`。仕様書が対象に無い）は毎回ある。
- crossDoc の再監査で `scopedAuditPlan` が当てた項目（プロンプトの「範囲を絞った監査: 対象は項目」の行）:
  - r2: PR-CLEANUP-006・008・017・024・029・034・048。
  - r3: PR-CLEANUP-006・015・034・048。
- 2 パス以上で指摘を受けた項目（`items_in_2plus_passes`）:
  - PR-CLEANUP-028 は r1〜r4 のすべて（blocking は r1 と r3）。
  - PR-CLEANUP-048 と 062 は r1〜r3。
  - PR-CLEANUP-003・006・011・034 は 2 パス。
- 逆転（同じ項目で tighten と relax）は 0 件。
- 項目ごとの経路（R6）: 返り値の `item_routes` は 5 回とも空で、decision・hold・尽きた（exhausted）に回した項目は 0 件。
- run5 の log の「経路を変えた項目」は 2 回とも「（なし）」。`recurringItems` が返した項目は 0 である。
- R6 の「再発した項目」「hold の指示」の行はどのプロンプトにも無かった（§2.2）。
- 既裁定の再出（notices）: 2 件（r2-im-001 ← RS-047、r3-im-002 ← RS-055）。
- **誤りだった指摘の割合**（P1 の材料）: 段 6 で「本文を変えない」と裁定された指摘は 0 件。
  - 探し方: finding を about に持つ resolution 19 件の value と hold を「変えない」「直さない」「今のまま」「誤り」「当たらない」で grep した。
    当たった RS-055 の「当たらない」は、選択肢に当たらない応答の意味だった。
  - 既裁定の再出を足しても 2 / 43 = 4.7%。

### 3.2 PR-CLEANUP-010・037 に当たる項目

item の ID が変わったので、内容で当てた。

- 037（現在のブランチを起点ブランチへ動かす）に当たるのは、今回の PR-CLEANUP-050〜052（判定表と、起点に無いコミットがあるときの同期）である。
  r1〜r4 のどのパスでも指摘を受けていない。
- 010（主ブランチ・現在のブランチ・open PR のブランチを同じ規則で分類する）と同じ文の項目は無い。今回の分類の項目は
  「主ブランチでないブランチ」に対象を絞っている（要求文書 L78・L90・L102）。
  - 近いのは PR-CLEANUP-003（取り込み済みの判定）で、r1 で blocking 2 件、r3 で非 blocking 1 件を受けた。r1 の指摘が RS-053 の hold になった。
- hold が縛る項目（`prd-report.md` の「触れる項目」）:
  - RS-027: F-003
  - RS-052: PR-CLEANUP-034・035・038・039・062
  - RS-053: PR-CLEANUP-003・004・015
  - RS-054: PR-CLEANUP-006・021・067・062
  - RS-055: PR-CLEANUP-028
  - RS-056: PR-CLEANUP-062・045

### 3.3 F-012・F-051・RS-028 に当たる論点

- **F-012（分類の PR の状態のマス）**: 最後の flow（`evidence/flow-final.json`、58 要素）で PR の状態を入力に持つ判断は F-026 だけである。
  分類の判断には PR の状態の入力が無い。段 2 の flow（flow-framer の `gen.py`）も、分類には PR の入力を持たない。
- **F-051（現在のブランチの open PR）に当たる入力**: F-026 の入力「現在のブランチの open PR」は `ある / 無い / 得られない` で、分からない値を持つ。
  最後の flow で `unknown` を持つ入力は 25 件中 13 件。
- **RS-028（同期で現在のブランチを動かすか）に当たる論点**: 出た。
  - G0 の RS-012「今のブランチに開いた PR があるか分からないとき、作業場所を起点ブランチへ合わせ直しますか？」（回答: 合わせ直さない）。
  - G0-2 の RS-033「今いるブランチに起点ブランチに無いコミットがあるとき、同期でそのブランチを起点ブランチの位置へ動かしてよいですか？」（回答: 今のまま）。
- **不変条件（R5）**:
  - `kind: invariant` は resolution 2 件（RS-004 ← O-004、RS-016 ← O-016）と O- 2 件（O-004 は intake、O-016 は flow-framer）。decisions は 0 件。
  - 不変条件 × 工程の組は 8 件（`constrained_by`: RS-004 が F-003・005・006・017・020・022・027、RS-016 が F-031）。`checks/conflicts.json` の constrained-by の 8 組と同じ。
  - `FLOW_DESTRUCTIVE_UNCONSTRAINED` は 0 件（doc_check flow の出力 60 回の codes はすべて空）。
- **R4 の符号**: `FLOW_OBTAIN_MISSING`・`FLOW_INPUT_UNKNOWN`・`FLOW_DT_SIZE`・`FLOW_HISTORY` は、flow の出力 60 回ですべて 0 件。
  journal の flow_check にも現れない。
- **`ST-FLOW-UNATTACHED`（R1・R2）**: 0 件。agent の tool の結果 947 件（Bash 603・Read 198・StructuredOutput 68・Edit 38・Grep 30・Write 10）と journal 2 本を、この符号の文字列で grep して 0 件だった。
  各パスの doc_check doc の findings も 0 件（§3.1）。
- **段 3b（R14）**:
  - flow-framer:3b-reframe の後の conflicts は 9 組（constraint_pairs 9、self_sourced 0）で、questions --check の対象は RS-033。
  - resolver:3b のプロンプトの「まだ裁定の無い open」は（なし）で 0 件、「まだ裁定の無い組」は F-003|RS-011 の 1 組。
  - resolver:3b は 1 回起動し、RS-035（組 F-003 × RS-011）を裁定し、RS-033 を問いのまま持ち越した。
  - verifier:3bv が F-003 を不合格にし、resolver:3b-fix・verifier:3b-fixv と settle（3b-settle・3bv-settle）が続いた。
  - 出所は journal の result。
- **conflicts の自己参照（R12）**: conflicts の出力 7 回と最後の `checks/conflicts.json` で、`self_sourced` はすべて 0。

## 4. 観察と未検証の点

### 4.1 hold_drafts が空で、report の本文に未反映の保持規則が 0 件なのは想定どおり

観察（コードと journal で確認）:

- `finish()` は `hold_drafts` を「`state.holds` のうち `state.settled_written` に無いもの」として作る（`plugins/workflow/workflows/prd-spec.js` L864-873）。
- `settled_written` は、段 4 の初稿の writer の後（L2050）と、段 7 の改稿の writer の後（L2279）に、その時点の holds を含めて書き直される。
- 6 件の hold はどれも、後に writer が走った時点で作られた。
  - RS-027: run2 の resolver:3a-settle-convert。初稿の前で、run2・3 の返り値では hold_drafts に居た。
  - RS-052〜055: run5 の 1 回目の resolver:6。
  - RS-056: run5 の 2 回目の resolver:6。
  - どれにも、後に writer:U-1:draft か writer:U-1:revise が続いた（journal の順）。
- `resolver:final`（上限で止まったときに writer を通さずに hold を作る）は、run が done で終わったので起動していない。
- 6 件の保持規則の文は要求文書の本文にある（`evidence/requirements-cleanup-branches.md` L94・L120・L184・L236・L258〜L278・L418）。
  report の「保持規則の文案（本文に未反映）」も 0 件（`prd-report.md`）。
- 以上から、hold_drafts [] と report の drafts 0 は欠陥ではない。

### 4.2 写し損ねと取り直し（`evidence/stdout-copies.json`、`stdout_copies.mjs`）

journal の result にある doc_check の stdout の写しの欄 89 件を、`7d06d97` の `parseStdout` と同じ規則（fnv の照合）で判定した。

| 版 | model | 照合なし（`stdout_fnv` が無い） | 合う | 合わない / 壊れた JSON |
|---|---|---:|---:|---:|
| 7a208d0 | haiku | 4 | — | 1（run3 flow-check:3a、3,558 字） |
| 7a208d0 | opus | 46 | — | 0 |
| 7d06d97 | haiku | — | 13 | 0 |
| 7d06d97 | opus | — | 22 | 1（grounding:r4 の tree_digest、471 字） |
| 7d06d97 | sonnet | — | 1 | 1（crossDoc:r1 の doc_check、277 字） |

- 数えたのは欄の数で、別々の写しの数ではない。crossDoc の recopy は同じ stdout を `flow_check` と `doc_check` の 2 欄に入れたので 2 件に数えた。
- 修正の後の写し損ねは 2 件で、どちらも haiku 以外。
  - crossDoc（sonnet）は `flow_refs` の中身を空の `{}` にした。
  - grounding:r4（opus）は `size_over.path` の `sizes` を `stray` と書いた。
- 2 件とも recopy（haiku）の 1 回目で合った。2 回とも合わなかった回数は 0。
- 7a208d0 の 50 件は照合の手段が無く、正しく写したかは分からない。
- `--rulings` の flow の stdout の長さ（`rulings_flow_check_chars`）:
  - run1〜2: 2,617〜3,593 字。
  - run3〜4 の段 3a: 3,558〜3,583 字。
  - 段 6 の後（run4〜5）: 5,277〜5,754 字。
  - haiku が合わせて写したのは 5,277 字（flow-check:3a'）まで。

### 4.3 run3 の止まり方

- run3 の flow-check:3a の写しは、JSON として読めない（3,195 字目で区切りが欠けた）。当時の版には checksum が無く、壊れた JSON だから検出できた。
- run3 は resumable false で止まった。司令塔は skill を直し（`7d06d97`）、run3 の next_args で段 3a から起動した。
- `from` に切り替えたのは 1 回で、理由は §1.1 の 2。
- resume（run2・3・5）で最初に live で走った agent は、3 回とも `flow-check:<ゲート>-answers` だった（g0・g0-2・g1）。保存された結果で返ったのは 12・29・14 体。

### 4.4 stray と tmp/ の残り

- stray の 2 件（`checks/*.stray.json`）は `tmp/verifier__3bv-settle/v.json` と `tmp/verifier__3v-settle-2/put.json` で、欄の条件で落ちた put の入力である。
  2 体とも同じ入力を直して put に成功した後、ファイルを消さずに返った。
- 最後の W の `tmp/` には、この 2 ファイルと空の `tmp/resolver__6-fix/` が残っている（作成役が `find` で見た。W には書いていない）。

### 4.5 W の外への書き込み

`/tmp/claude-0`・scratchpad・`~/`・`/root/` を含む Bash のコマンドを grep した範囲で数えた（`commands_touching_outside_W`）。
Write/Edit の書き先はすべて W の中。司令塔が試走の前後で `ls` を比べた記録は `orchestrator-log.md` に無いので、この方法でしか数えていない。

| agent | ファイル（scratchpad の直下） | 後始末 |
|---|---|---|
| run1 verifier:3v | `v.json`（cp） | 残存（14,052 バイト、mtime 2026-09-29T21:06） |
| run5 resolver:3a' | `put.json`（リダイレクト） | 残存（906 バイト、mtime 2026-09-30T04:52） |
| run5 grounding:r2 | `rs.txt` | 同じ agent が `rm -f` |
| run5 grounding:r3 | `rs2.txt`・`flow.txt` | 同じ agent が `rm -f` |
| run5 implementer:r3 | `flow.txt` | 並行していた grounding:r3 が同じパスに上書きし、後で消した |

- implementer:r3 が `flow.txt` を Read したのは 05:20:08 で、grounding:r3 が上書きした 05:20:18 より前だった。
- 2 体が同じパスを使った。今回は相手の内容を読んでいない。
- `v.json`・`put.json` が試走の前から在ったかは分からない。

### 4.6 未検証の点

- 修正後に段 3a から呼び直した 4 体（§2 の注）を「写し損ねが無ければ起動しなかった」とみるのは推測である。
- haiku が 300 秒未満の空きでも初回ターンで cache を読まなかった理由（§2.3）。
- R9（名前付きの呼び出しの 2 回目以降の承認）は、呼び出しが無かったので測れていない。
- classifier の no-verdict は数えていない（§1.1 の 4）。

## 5. 残したもの

- 要求文書: `evidence/requirements-cleanup-branches.md`（repo の `docs/requirements` には写していない）。
- 保持規則 6 件と Issue の文案: `evidence/prd-report.md`。Issue は起票していない。

## 6. 再現

- W: `/home/user/claude-plugins/plugins/workflow/skills/prd-spec/workspace/cleanup-branches`（`.gitignore` の `/plugins/workflow/skills/prd-spec/workspace/` に当たる）。
- 呼び出し: 1 回目の args は `{"workspace": <W>, "skillDir": "/home/user/claude-plugins/plugins/workflow/skills/prd-spec", "entry": "new", "existing_docs": []}`。
  - run2・3・5 は `resumeFromRunId` と `gates_answered` を足した resume。
  - run4 は run3 の `next_args`。
  - 詳細は `orchestrator-log.md` と `transcript-extract.json` の `main_workflow_calls`。
- usage（evidence/ の直下から。T は `~/.claude/projects/-home-user-claude-plugins/bbfbc7eb-d042-5c7d-8fa6-ab266c5cd669/subagents/workflows`）:
  - `python3 plugins/workflow/skills/prd-spec/scripts/usage.py --json --weights 0.05,1.25,2 --workspace <W> $T/wf_f413a4a5-c3e $T/wf_0f45ed55-8ba > usage.json`
    （`--json` なしで `usage.txt`）
  - `… --weights 0.1,1.25,2 … > usage-weights-0.1.json`
  - 倍率の出所は §2.3。
- 抽出（evidence/ で）:
  - `python3 scan.py <rows.json> <prompts.json>`: agent の tool 呼び出しと最初のプロンプト。出力は大きいので scratchpad に置いた。
  - `node stdout_copies.mjs . > stdout-copies.json`
  - `python3 extract.py <rows.json> <prompts.json> transcript-extract.json`: HEAD の `tests/test_launch_reasons.py` を import する。
  - `python3 reading.py reading.json`

## 7. R16 の後に決めること（材料）

- **`subagentPromptCacheTtl: 1h` を推奨するか**:
  - 書き込みはすべて 5 分の TTL（6,785,138、1 時間 0）。
  - ゲートの後の run の最初の opus の agent: 空き 92.2 秒・109.7 秒では 39,476 を読んだ。空き 16,419.8 秒（G0）・5,981.6 秒（修正）では全体を作った。
    G0 の待ちは 1 時間を超えているので、1 時間の TTL でも run2 の頭は作り直す。
  - 効きうるのは、run の中の 300〜3,600 秒の空きで外れた初回ターンである。opus・sonnet 22 体・haiku 7 体で、初回ターンの cache_creation の和は 1,781,568。
  - **推測**（`ttl_1h_estimate`）: 外れた初回ターンが、同じ組で観測した最大の cache_read の分だけ読みに変わるとみなした。
    書き込みがすべて 1 時間の倍率になるので、cache の重み付きの量は増える: opus +3,123,448、sonnet +301,838、haiku +236,489（通常の入力に換算した token）。
    読みに変わる量には、読んだ例の無い組（writer・flow-framer・crossDoc など）を 0 と数えた。
    opus・sonnet の 22 体すべてに 39,476 を当てると、読みに変わる量は約 0.87M。同じ重みの単位で、減る分は約 1.69M（0.87M × (1 時間の書き込み − 読み) の倍率の差）、
    増える分は約 4.12M（opus の書き込み 5,492,472 × (1 時間 − 5 分) の倍率の差）で、増える分の方が大きい（推測）。
  - run は 1 回ずつしか無い（n=1）ので、空きの分布が run ごとに変わる影響は見ていない。
- **収束のループの上限**:
  - `MAX_AUDIT_PASSES = 4` に対して、段 8 のパスは 3 で、stop_reason は null（r4 の blocking 0 で done）。
  - `MAX_SETTLE_ROUNDS = 3` に対して、settle の回数の最大は 2（段 3 の 3-settle・3-settle-2）。
  - `MAX_CHECK_REWORK = 3` に対して、doc_check の差し戻し（flow・framer・questions）の起動は 0。
- **haiku → sonnet と `--rulings` の縮小**:
  - recopy は 2 回で、どちらも haiku 以外の写し損ねの取り直し。2 回とも合わなかった回数は 0。
  - haiku の写し損ねは修正前の 1 件（3,558 字）だけ。修正後の haiku の写し 13 件はすべて合った（最長 5,277 字）。
  - `--rulings` の stdout は、台帳が育つと 2,617 字から 5,754 字に伸びた（§4.2）。
- **cache を共有しやすくする変更**:
  - 同じ役の初回ターンの読みは、同じ model・同じ役の前の agent から 300 秒未満のときだけ起きた（§2.3）。
  - 別の役が 300 秒以内に動いていても、読みは 0 だった（27 体中 23 体がこの場合）。
  - 読んだ量は役によって違った（opus で 38,784〜39,476）。
- **O1（`agentType` と `omitClaudeMd`）と N20 の案 (b)**:
  - 初回ターンのコンテキストは opus 約 65K（64,820〜67,614）・haiku 約 46K で、68 体の和は 4,173,424。
  - 同じ役で温かいときに読めた前半は約 39K（38,784〜39,476）。役をまたいでは読めなかった（§2.3）。
  - 初回ターンのうち CLAUDE.md・skill 一覧などの環境の分がどれだけかは測っていない。
- **P1（adversarial verify）**: 誤りだった指摘の割合は 4.7%（2 / 43、§3.1）。
- **N13（呼び出しの種類ごとの effort）**: 役ごとの tokens は §2.2 の表と `transcript-extract.json` の `launch_reasons.by_family`。

## 参考（evidence）

- 司令塔の事実: `orchestrator-log.md`
- 抽出: `scan.py`、`extract.py`、`transcript-extract.json`、`stdout_copies.mjs`、`stdout-copies.json`、`reading.py`、`reading.json`
- run の返り値: `run-outputs/run{1..5}.output.json`。journal: `journal-wf_f413a4a5-c3e.jsonl`、`journal-wf_0f45ed55-8ba.jsonl`
- usage: `usage.json`、`usage-weights-0.1.json`、`usage.txt`
- 問いと回答: `questions-g0.{json,md}`、`questions-g0-2.{json,md}`、`questions-g1.{json,md}`、`answers-g0.md`、`answers-g0-2.md`、`answers-g1.md`
- 監査: `findings/r{1..4}-*.json`
- 分量・stray・diff・doc: `checks/`
- 台帳と flow の最後: `resolutions-final.json`、`verifications.json`、`decisions.json`、`open.json`、`routes.json`、`plan.json`、`flow-final.json`、`tree-digest-final.json`
- 写し損ねの証拠: `flow-check-3a-bad-stdout.json`
- 事後報告と文書: `prd-report.md`、`requirements-cleanup-branches.md`
