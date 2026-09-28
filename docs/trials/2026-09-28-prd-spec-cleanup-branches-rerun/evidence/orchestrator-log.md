# 司令塔の記録と、レポート作成役の抽出（事実のみ・出所付き）

## 司令塔から渡された事実

- skill の版: HEAD `61ab960`（試走開始時）。skillDir=/home/user/claude-plugins/plugins/workflow/skills/prd-spec
- 題材: `plugins/git/skills/cleanup-branches/SKILL.md` の blob `2ed8adf03cf7ce3028bcb1d0132028b37aa3cc7d`。
  W の `input.md` は前回の W の `input.md` と cmp で一致。
- W: `/root/.claude/prd-spec-workspace-rerun/cleanup-branches`。先例: `precedent.py list --root ~/.claude/prd-spec-workspace-rerun` で 0 件。
- 開始 2026-09-27T23:43:03Z（rerun-start.txt）、終了 2026-09-28T01:50:54Z（rerun-end.txt）。
- task-notification の usage:
  - run1: agents 6, subagent_tokens 778277, tool_uses 102, duration_ms 1664880
  - run2: agents 5, subagent_tokens 537705, tool_uses 74, duration_ms 635139
  - run3: agents 10, subagent_tokens 1220229, tool_uses 171, duration_ms 1581905
  - run4: agents 16, subagent_tokens 1800121, tool_uses 283, duration_ms 1884599
- AskUserQuestion の回数: G0 の 17 問は 5 回（4・4・4・4・1 問）、G0-2 の 1 問と G1 の 1 問は各 1 回。
- RS-012 の回答は自由記述（「退避タグ不要。origin/main に取り込まれてるブランチは確認不要で削除」）。
- next_args の文字数（json.dumps ensure_ascii=False、既定の区切り）: G0 後 3653、G0-2 後 3931、G1 後 8933。
  `NEXT_ARGS_MAX_CHARS=8000` はテストの中の上限で、実行時には検査しない。
- 司令塔は next_args を Workflow の args に打ち直して 3 回渡した。
- `/tmp/claude-0` 直下のエントリ名の一覧は、試走の前後で同じ（rerun-tmp-before.txt / rerun-tmp-after.txt。
  作成役が名前の列だけを diff して一致を確認。サイズと mtime は違う）。
- W/tmp は空。tree-digest の stray は 0。size_over は 5。

## 作成役が transcript から抽出したもの

抽出のスクリプトは `scan.py`（agent の transcript 37 本から tool 呼び出しを集める）と `extract.py`、結果は
`transcript-extract.json`・`doc_check_rejections.json`。tool 呼び出しの総数は 630 件で、usage の tool_uses の和
（102+74+171+283=630）と一致する。

- **args の一致**: run の output ファイルに args のエコーは無い。司令塔のセッションの transcript
  （`~/.claude/projects/-home-user-claude-plugins/bbfbc7eb-….jsonl`）の task-notification の `<diagnostics>` にある
  args と、Workflow の tool_use の `args` の両方が、run2〜4 でそれぞれ `next_args_g0.json`・`next_args_g0-2.json`・
  `next_args_g1.json` と JSON として一致した。各 `next_args_*.json` は run1〜3 の `result.next_args` とも一致した。
- **AskUserQuestion**: 00:11:12・00:20:43・00:21:22・00:24:02・00:28:05（4・4・4・4・1 問）、00:42:42（1 問）、01:10:44（1 問）。
  前回（2026-09-27 の同じ jsonl）はゲートの間に 3 回（4・4・1）・1 回（1）・1 回（3）の計 5 回。
- **doc_check の exit 1**: stderr の `doc_check <mode>:` 行が 10 回（`doc_check_rejections.json`）。
  - `--ledger resolutions.json` / `flow.json` のようにファイル名を渡した引数の誤り: put 5 回・sha 3 回（resolver:3b・resolver:6'・
    resolver:3a（run3）・resolver:final・flow-framer:6-settle）。5 件とも、同じ agent が後で同じ ID の put に成功している。
  - `del` の `--workspace` 欠落: 1 回（writer:U-1:revise、agent a6a1af915713e95b0）。後で同じ agent の del が成功（PR-CLEANUP-008 を削除）。
  - 欄の外の値で拒否: 1 回（同じ writer が meta に `vacant_ids` を put）。再試行は無い。PR-CLEANUP-008 の del はこの 7 秒前に成功済み。
  - 経緯の印（FLOW_HISTORY）での拒否: 0 回。
  - RS-050 の `questions --check` が `findings: 1`（question の欄が無い）を返したのは exit 0 で、上の 10 回に含まない。
- **doc_check flow の出力**: 29 回で、findings はすべて 0。
  各回の `unverified` は `transcript-extract.json` の `doc_check_flow_outputs`。F-013 は verifier:6v-settle（run4）より前のすべての回で
  `unverified` に入っていた。verifier の `pass` は `verifier_fail[].pass`（F-017 は run2 の verifier:3av が pass、F-013 は verifier:6v-settle が pass）。
- **W の外への書き込み**（Bash のコマンドを `/tmp/claude-0`・リダイレクト・`open(..., 'w')`・mkdir・cp などで grep した範囲。Write/Edit の
  書き先 8 ファイルはすべて W の中）:
  - run1 verifier:3v が `scratchpad/rs.txt` に resolutions の一覧を書き、同じ agent が後で `rm` した（1 回目の rm は permission で拒否、2 回目で削除）。
  - run3 grounding:r1 が `scratchpad/flow.txt`（24,755 バイト）に flow の一覧を書いた。削除は無く、今も残っている。
  - どちらも scratchpad の下で、`/tmp/claude-0` 直下のエントリは増えていない。
- **verifier の不合格**: run1 verifier:3v が 20 件（RS-023・024・027・028、F-004〜F-058 の 16 件）、run3 verifier:6v が 1 件（RS-050）。
  それぞれ `resolver:3'`・`verifier:3v'`、`resolver:6'`・`verifier:6v'` の差し戻しが起きた。
- **段 2 の flow（F-013・F-017）**: run1 flow-framer の生成コマンド（`flow-stage2-flow-framer-command.txt`）では、F-013・F-017 の
  inputs に `PR`（値: `base が primary の merged PR あり` / `base が primary の open PR あり` / `それ以外` / `取得できない`）があった。
  run2 resolver:3a（00:37:21、`flow-3a-resolver-command.txt`）がこの 2 要素を `取り込み`（`取り込み済み` / `取り込み済みと確認できない`）
  の入力に置き換え、F-011（PR の一覧を取得できたか）を含む 8 要素を削除した。
- **作成役の副作用**:
  - `precedent.py list --root ~/.claude/prd-spec-workspace-rerun --workspace <W>` を実行し、W の `precedent.json` が同じ内容
    （`{"paths": []}`）で書き直された。mtime は 2026-09-28 01:56:16Z に変わった（W のコピーと cmp で一致）。
  - `skill_telemetry.py record` の 4 件を既定の保存先 `~/.claude/skill-telemetry/prd-spec/cleanup-branches-rerun-leg{1..4}.json` に書いた。
- **usage.py の実行コマンド**: `python3 plugins/workflow/skills/prd-spec/scripts/usage.py --json --workspace
  /root/.claude/prd-spec-workspace-rerun/cleanup-branches ~/.claude/projects/-home-user-claude-plugins/bbfbc7eb-…/subagents/workflows/{wf_cfb5b04b-b59,wf_1ff7d0e4-637,wf_aee918a8-e02,wf_f679c9fb-dd6}`
  （`--json` なしで `usage.txt`）。
- **前回の W のバイト数**（作成役が 2026-09-28 に `wc -c` で測った。README §2.1 の比較用）: resolutions.json 68816、verifications.json 20273、
  flow.json 20733、open.json 5350、routes.json 654、decisions.json 7309、requirements-cleanup-branches.md 23378、
  requirements-cleanup-branches.meta.json 25653。
