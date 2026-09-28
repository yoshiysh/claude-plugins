# prd-spec 再試走レポート: cleanup-branches（構造修正後）

skill の版: `61ab960`（試走開始時の HEAD）。前回の記録: `docs/trials/2026-09-27-prd-spec-cleanup-branches/`（`bfab2c5`）。
比べる指標は計画の段 8 の一覧に従う。値の出所は `evidence/` の各ファイル（抽出の手順は `evidence/orchestrator-log.md`）。

## 1. 概要

- 入力は前回と同じ。題材の blob は `2ed8adf0…`、`W/input.md` は前回の W の `input.md` と cmp で一致。先例は 0 件。
- W: `/root/.claude/prd-spec-workspace-rerun/cleanup-branches`。時刻は 2026-09-27T23:43:03Z〜2026-09-28T01:50:54Z。
- Workflow は 4 回呼んだ（`evidence/run-outputs/run{1..4}.output.json`）。
  1. `from` なし → needs_answers（G0、17 問: RS-012〜RS-028）
  2. `3a` → needs_answers（G0-2、1 問: RS-045）
  3. `3a` → needs_answers（G1、1 問: RS-050）
  4. `3a'` → blocked「2 パスの改稿と監査の後も blocking が 2 件残りました」
- 残った blocking は 2 件で、どちらも route は decision。
  - `r3-im-…-001`（PR-CLEANUP-037、origin input）
  - `r3-im-…-002`（PR-CLEANUP-010、origin ledger、direction tighten）
- holds は RS-052・054・057・058。doc_blocking 0、open_tbd 0。保持規則と Issue の文案は `evidence/prd-report.md` にある。
- 要求文書は blocked なので保存していない。

## 2. 比較表

「向き」は、計画に望ましい向きがある指標にだけ付けた。それ以外は増・減・同じで書く。

| 指標 | 前回 | 今回 | 向き |
|---|---|---|---|
| ゲートの回数（needs_answers） | 3 | 3 | 同じ |
| AskUserQuestion の呼び出し | 5（G0 3・G0-2 1・G1 1） | 7（G0 5・G0-2 1・G1 1） | 増 |
| 問いの総数（G0 / G0-2 / G1） | 13（9 / 1 / 3） | 19（17 / 1 / 1） | 増 |
| G1 の問い | 3 | 1 | 減 |
| 最後の status | blocked | blocked | 同じ |
| remaining_blocking / holds / open_tbd | 2 / 2 / 0 | 2 / 4 / 0 | holds 増 |
| next_args の最大（json.dumps の文字数。括弧内はファイルのバイト数） | 17,908（21,780） | 8,933（9,036） | 改善 |
| next_args の `state.flow` | あり | 無し（3 つとも） | 改善 |
| W の `stray` | 検査なし | 0（audited-1〜3・最後の tree-digest の 4 回とも） | — |
| W の `tmp/` の残り | script 5・控え 13 | 空 | 改善 |
| W の外への書き込み | 測っていない（記録なし） | scratchpad に 2 ファイル（1 つは agent が削除、`flow.txt` 1 つが残存）。`/tmp/claude-0` 直下のエントリ名は前後で同じ | — |
| doc_check の exit 1 | 測っていない | 10 回（引数の誤り 9・欄の外の値 1） | — |
| `FLOW_HISTORY` の件数 / put が経緯の印で拒否した回数 | 検査なし | 0（flow の検査 29 回すべて findings 0） / 0 | — |
| put が欄の条件で拒否した回数 | 検査なし | 1（meta に `vacant_ids`） | — |
| 段 2 の `FLOW_DT_*` | 検査なし | 0（doc_check flow の出力 29 回すべて findings 0） | — |
| `SIZE_OVER`（予算は `SIZE_BUDGET`） | — | 4 → 5 → 5（audited-1・2・3）、最後も 5 | 悪化 |
| 由来層（origin）ごとの指摘 | 欄なし | 表 3.1 | — |
| F-012 に当たる分類の OPEN・不明のマス | 無し（2 値に潰れていた） | 段 2 にはあった。3a の後に無くなった（§3.2） | — |
| direction の逆転 / それで decision に回った件数 | 1（r2-gr tighten → r3-gr relax、PR-CLEANUP-059） / 0（逆転の検出なし） | 0 / 0 | 改善 |
| RS-028 に当たる論点が G0・G0-2 で出たか | 出ず（G1 で出た） | 出ず（監査で出た。§3.3） | 同じ |
| agent 数 | 24 | 37（許容幅 32 以下） | 超過 |
| subagent_tokens | 2,737,996 | 4,336,332（前回の 1.58 倍。許容幅 3.56M 以下） | 超過 |
| duration_ms の和 | 3,868,205 | 5,766,523（1.49 倍） | 増 |
| 1 体あたりの初回ターン入力 | 62,583〜67,587 | 63,976〜69,221（平均 65,310、中央値 65,229） | 増（注） |
| telemetry の integrity_count / notices_count | 取れず（summary が全 None） | 0 / 3（3 件とも SIZE_OVER の知らせ） | 取れるようになった |

注:

- **問いの増加**: G0 の 17 問のうち RS-015〜RS-022 の 8 問は観点の問い（生命・金銭・個人情報など）。回答は 7 問が「無い」側で、
  RS-021 だけが「社内の開発者だけ」（`evidence/answers-g0.md`）。
- **next_args の単位**: 前回の README の 17,757 / 16,727 / 21,780 はファイルのバイト数。同じ数え方（json.dumps）で測り直すと
  13,785 / 12,869 / 17,908 になる（`evidence/transcript-extract.json` の `prev_next_args`）。
- **ゲートの args**: 司令塔は next_args を Workflow の args に打ち直して 3 回渡した。run2〜4 の args は `next_args_*.json` と一致した。
  確かめた先は司令塔のセッションの transcript（`<diagnostics>` の args と、Workflow の tool_use の args）。output ファイルには
  args のエコーが無い。
- **初回ターン入力**: `first_turn_input` は Read を実行する前の入力で、読み込んだ節の本文を含まない（前回の README §4.2 と同じ）。
  そのため、段 1b の共通 2 節の読み込みで増えた分はこの指標では測っていない。範囲が約 1.4K〜1.6K 上にずれた原因を
  プロンプトの見出しの文面の違いと見るのは推測である。
- **`NEXT_ARGS_MAX_CHARS=8000`**: テストの中の上限で、実行時には検査しない。G1 の後の 8,933 はこれを超えている。
- **doc_check の exit 1 の内訳**（`evidence/doc_check_rejections.json`）:
  - `--ledger` にファイル名（`resolutions.json`・`flow.json`）を渡した: put 5・sha 3。5 件とも同じ agent が後で同じ ID の put に成功した。
  - del の `--workspace` の欠落: 1。
  - 欄の外の値（meta の `vacant_ids`）: 1。

### 2.1 SIZE_OVER の内訳（`evidence/checks/*.sizes.json`、単位はバイト）

`SIZE_BUDGET` は計画では前回の値である。ただし前回の W の今のファイル（`wc -c`）とは一部で一致しない。どの時点の値を取ったかは確かめていない。

| ファイル | SIZE_BUDGET | 前回の W（wc -c） | audited-1 | audited-2 | audited-3 | 最後 |
|---|---:|---:|---:|---:|---:|---:|
| resolutions.json | 64,241 | 68,816 | 64,660 | 73,401 | 83,209 | 88,110 |
| verifications.json | 19,165 | 20,273 | 34,587 | 36,737 | 37,674 | 37,674 |
| flow.json | 20,734 | 20,733 | 32,209 | 32,209 | 32,372 | 32,372 |
| open.json | 5,029 | 5,350 | 6,199 | 6,199 | 6,199 | 6,199 |
| routes.json | 655 | 654 | — | 973 | 1,656 | 1,656 |
| 要求文書 .md | 23,378 | 23,378 | 17,412 | 18,236 | 19,153 | 19,153 |
| meta.json | 25,654 | 25,653 | 9,022 | 9,524 | 12,197 | 12,197 |
| decisions.json | 6,887 | 7,309 | 3,645 | 3,645 | 3,645 | 3,645 |

### 2.2 agent の増加（許容幅の超過。label ごと、`evidence/agents_by_run.json`）

| label | 前回 | 今回 | 差 | tokens の差 |
|---|---:|---:|---:|---:|
| `flow-framer:3b-reframe`・`resolver:3b`・`verifier:3bv`（段 3b） | 0 | 3 | +3 | +297,587 |
| `flow-framer:6-settle`・`resolver:6-settle-pairs`・`verifier:6v-settle` | 0 | 3 | +3 | +265,026 |
| `resolver:3'`・`verifier:3v'`（3v の不合格 20 件の差し戻し） | 0 | 2 | +2 | +278,249 |
| `resolver:6'`・`verifier:6v'`（6v の不合格 1 件の差し戻し） | 0 | 2 | +2 | +178,358 |
| `crossDoc`（r2・r3 にも起動） | 1 | 3 | +2 | +263,983 |
| `verifier:3a'v` | 0 | 1 | +1 | +79,750 |
| 上記以外（前回にもある label） | 23 | 23 | 0 | +235,383 |
| 合計 | 24 | 37 | +13 | +1,598,336 |

- 計画の見込みは「差し引き +2〜+8」だった。段 3b（+3）と settle（+3）はその範囲に入る。
- 次の 3 つは計画の表に同じ行が無い: 差し戻し 2 組（+4）、crossDoc の追加（+2）、3a' の verifier（+1）。
- 許容するかは依頼者に諮る（計画の段 8 の手順）。

### 2.3 usage.py（`evidence/usage.json` / `usage.txt`）

| 項目 | 前回 | 今回 |
|---|---:|---:|
| agents | 24 | 37 |
| turns（opus / sonnet） | 350（325 / 25） | 539（451 / 88） |
| input_all | 33,647,837 | 54,181,760 |
| cache_read（input_all に占める割合） | 31,129,356（92.5%） | 50,336,083（92.9%） |
| output | 46,287 | 48,637 |
| busy / span 秒 | 3,834.9 / 5,972.4 | 5,718.8 / 7,659.5 |

## 3. 監査の推移

### 3.1 パスごとの指摘（`evidence/findings/`）

| 監査 | findings | blocking | 項目 | doc_blocking | origin 別（blocking） |
|---|---:|---:|---:|---:|---|
| r1 | 10 | 4 | 8 | 16 | text 5（1）・ledger 5（3） |
| r2 | 4 | 3 | 4 | 16 | ledger 2（2）・flow 2（1） |
| r3 | 2 | 2 | 2 | 0 | input 1（1）・ledger 1（1） |

- 前回は r1 11（blocking 6）・r2 4（2）・r3 3（2）。
- doc_blocking は、各パスの監査が返した `doc_check doc` の blocking。
- PR-CLEANUP-010 と PR-CLEANUP-037 は、r1・r2・r3 のすべてで blocking の指摘を受けた。どのパスでも指摘の中身（どこで手が止まるか）が違う。
  - 010: 比べる相手に自分自身を入れるか（r1）→ remote の同名を含むか（r2）→ 同じ実行で削除される相手に内容があるとみなすか（r3）。
  - 037: 「現在の位置」を合わせる対象（r1）→ PR の有無が分からないとき（r2）→ 動かした後の作業ツリーの内容（r3）。
- prd.js の `reversedFindings`（同じ項目で tighten と relax が入れ替わる）の定義では、逆転は 0 件。
  前のすべてのパスの指摘と突き合わせても 0 件だった。

### 3.2 F-012 に当たる分類

- **段 2**（run1 flow-framer、`evidence/flow-stage2-flow-framer-command.txt`）: F-013（ローカル）と F-017（remote）の inputs に `PR` があった。
  - 値は `merged PR あり` / `open PR あり` / `それ以外` / `取得できない`。CLOSED と PR 無しは `それ以外` に入る。
  - OPEN のマスは「除外が未決」（O-013）。`取得できない` のマスは、条件によって「取り込み済み」か「要判断」。
- **3a の後**（run2 resolver:3a、`evidence/flow-3a-resolver-command.txt`）: F-013・F-017 の入力は `取り込み`（`取り込み済み` /
  `取り込み済みと確認できない`）に置き換わった。F-011（PR の一覧を取得できたか）を含む 8 要素が削除された。最後の flow
  （`evidence/flow-final.json`）には、PR の状態を入力に持つ判断が無い。
- F-051（現在のブランチに open PR があるか）の値は `true` / `false` だけで、「分からない」が無い。
  - `tableFindings`（doc_check.mjs L786）は、宣言した値の組み合わせしか展開しない。そのためこの欠けは flow の検査に出なかった。
  - 欠けを指摘したのは監査の r2-im-002 で、RS-054 の hold になった。

### 3.3 RS-028 に当たる論点（同期で現在のブランチを動かすか）

- G0・G0-2 の問い（`evidence/questions-g0.json`・`questions-g0-2.json`）には出ていない。
- 同じ論点は PR-CLEANUP-037 への監査の指摘として出た。
  - r1-im-003: resolver:6 が RS-049 で内部に裁定した（「commit を起点ブランチの remote 上の最新へ動かす」）。前回は G1 で依頼者に聞いた論点である。
  - r2-im-002: RS-054 の hold。
  - r3-im-001: RS-057 の hold。
- 計画（段 6b）では、この場合に段を戻すかを依頼者に諮る。

## 4. 観察と未検証の点

### 4.1 remaining_blocking に、hold にした指摘が残る

観察（コードと W で確認）:

- RS-057 の `about` は `finding: r3-im-…-001`、RS-058 の `about` は `finding: r3-im-…-002` で、どちらも `ruling: hold`
  （W の `resolutions.json`）。この 2 件は run4 の `resolver:final` が追加した。
- prd.js の段 8 は、監査の後に `setPending` で `state.pending.blocking` を決め、上限に達すると `finalHold` を呼ぶ（L1379-1390）。
- `finalHold`（L1394-1420）は、resolver:final を起動した後、その返り値を `absorbResolver` で取り込む前に
  `remaining_blocking: state.pending.blocking` を組む。取り込んだ後も、この値と reason の件数（`blocking`）を組み直さない。
  `absorbResolver`（L590-）は `state.pending` に触れない。
- そのため、hold にした 2 件がそのまま remaining_blocking の 2 件として返った。
- `finalHold` は文書を直さないので、2 件の指摘は要求文書の本文には残っている。

未検証:

- これが意図どおりかは確かめていない。`workflow-io.md` §3 は `remaining_blocking` を「上限に達した blocked のとき、残った blocking の
  指摘の ID」とするだけで、hold との関係を定めていない。
- 「文書に残る未解決」と定義するなら、今の値で正しい。「裁定の済んでいない論点」と定義するなら、hold と二重に数えている。

### 4.2 G0 の後、resolver が分類の入力を畳んだ

観察:

- 段 2 の flow にあった OPEN と「取得できない」のマスは、flow-framer ではなく run2 の resolver:3a が F-013・F-017 を書き換えて
  消した（§3.2）。
- F-017 は run2 の verifier:3av が合格させた（journal の `pass`）。
- F-013 は、doc_check flow の出力の `unverified` に残り続けた。run1 の verifier:3v が不合格にした後、run4 の flow-framer:6-settle の
  出力まで毎回残っていた。`unverified` が空になったのは verifier:6v-settle の後（run4 の resolver:final の出力）。
  - そのため、初稿（run3）と監査 r1・r2 は、F-013 が unverified のまま行われた。
  - この間に run2 の flow-framer:3b-reframe が F-013 をもう一度置き換えている。

未検証: 畳んだことが G0 の回答（RS-024「どれも外さない」など）から導けるかは確かめていない。

### 4.3 W の外への書き込みは残った

観察: 構造での検出は計画の範囲外。今回は 2 体の agent が scratchpad にファイルを書いた（`evidence/orchestrator-log.md`）。
grounding:r1 の `scratchpad/flow.txt` は試走の後も残っている。

## 5. 残したもの

- 保持規則 4 件（RS-052・054・057・058）と Issue の文案: `evidence/prd-report.md`。Issue は起票していない。
- 要求文書は blocked のため保存していない。

## 6. 再現

- W: `/root/.claude/prd-spec-workspace-rerun/cleanup-branches`（前回の W を含まない新しいルートの下に作った）。
- 1 回目の args: `{"workspace": "/root/.claude/prd-spec-workspace-rerun/cleanup-branches", "skillDir": "/home/user/claude-plugins/plugins/workflow/skills/prd-spec", "entry": "new", "existing_docs": []}`。
- 2 回目以降: 回答を `W/answers/*.md` に逐語で書き、直前の run の `next_args` をそのまま渡した（`from`: なし → `3a` → `3a` → `3a'`）。
- usage.py と telemetry の実行コマンドは `evidence/orchestrator-log.md` にある。
  telemetry の記録は `~/.claude/skill-telemetry/prd-spec/cleanup-branches-rerun-leg{1..4}.json` で、写しは `evidence/telemetry/`。

## 参考（evidence）

- 司令塔の事実と抽出: `orchestrator-log.md`、`transcript-extract.json`、`doc_check_rejections.json`、`scan.py`、`extract.py`
- run の返り値: `run-outputs/run{1..4}.output.json`、`run-outputs/next_args_{g0,g0-2,g1}.json`
- usage: `usage.json`、`usage.txt`、`agents_by_run.json`
- telemetry: `telemetry/cleanup-branches-rerun-leg{1..4}.json`、`telemetry/aggregate.json`、`telemetry/summary.txt`
- 問い: `questions-g0.json`、`questions-g0-2.json`・`.md`、`questions-g1.json`・`.md`
  - G0 は、司令塔がゲートで `cat` した `questions.json` の出力を transcript から取り出したもの。末尾の改行を補うと sha256 が
    `9d23d0ff…` になり、`doc_check questions` が当時返した値と一致する。
  - G0 の `.md` は残っていない。W のコピーで `doc_check questions` を実行すると、flow から消えた要素（F-011・F-040・F-041・F-043・F-044）を
    参照しているとして拒否され、導出できなかった。
  - G0-2 は W のコピーで導出した。sha256 は当時の値（md `e3725d74…`・json `c7f72ffa…`）と一致する。
  - G1 は W の最後の `questions.*`。
- 回答: `answers-g0.md`、`answers-g0-2.md`、`answers-g1.md`
- 監査: `findings/r{1,2,3}-{im,gr}-requirements__cleanup-branches.json`、`findings/r{1,2,3}-cd-all.json`
- 分量と stray: `checks/audited-{1,2,3}.sizes.json`、`checks/tree-digest.sizes.json`、`checks/tree-digest.stray.json`
- flow: `flow-stage2-flow-framer-command.txt`、`flow-3a-resolver-command.txt`、`flow-final.json`
- 事後報告: `prd-report.md`
