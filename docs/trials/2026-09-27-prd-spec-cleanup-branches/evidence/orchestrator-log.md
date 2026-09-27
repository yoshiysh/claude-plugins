# 司令塔の記録（事実のみ・出所付き）

- 対象ブランチ: refactor/prd-spec-lean @ bfab2c5（yoshiysh/claude-plugins#109 の head）。skillDir=/home/user/claude-plugins/plugins/workflow/skills/prd-spec
- 題材: plugins/git/skills/cleanup-branches（SKILL.md 232 行を input.md に逐語で貼付。entry: new、existing_docs: []）
- 保存先の予定: docs/cleanup-branches/{requirements,specifications}/（docs/requirements は prd-spec 自身の文書と INDEX を持つため分離）。blocked のため保存していない。
- 開始時刻（S0 直後）: 2026-09-27T07:51:54Z。最終 run 完了の確認: 2026-09-27T10:47Z 頃。
- run の区切り（Workflow 呼び出し 4 回）:
  1. from=1 → needs_answers（G0, 9 問: RS-002,003,004,005,006,007,008,011,012）
  2. from=3a → needs_answers（G0-2, 1 問: RS-020）
  3. from=3a → needs_answers（G1, 3 問: RS-022,027,028）。holds: RS-021
  4. from=3a' → blocked。reason「2 パスの改稿と監査の後も blocking が 2 件残りました」。remaining_blocking: r3-gr-…-001, r3-gr-…-002（どちらも route=writer）。holds: RS-021, RS-032
- Workflow の usage 報告（task-notification の <usage>）:
  - run1: agent 4, subagent_tokens 418873, tool_uses 49, duration_ms 527685
  - run2: agent 2, subagent_tokens 195945, tool_uses 29, duration_ms 324050
  - run3: agent 8, subagent_tokens 1007837, tool_uses 159, duration_ms 1842409
  - run4: agent 10, subagent_tokens 1115341, tool_uses 162, duration_ms 1174061
- 依頼者への質問: 合計 13 問（G0 9・G0-2 1・G1 3）。AskUserQuestion の 4 問制限により G0 は 3 回（4・4・1）に分けて提示。questions.json の header は全て 12 字以内、options は 2〜4 で、文面を変えずに渡せた。
- 自由記述の回答: RS-004「タグは不要」、RS-005「退避タグが不要なのと、ユーザーへの確認が多いから減らしたい」（g0.md）。RS-005 の自由記述から G0-2 の追加質問 RS-020 が生成された。
- next_args の大きさ（JSON 文字数、ファイル実測）: G0 後 17757、G0-2 後 16727、G1 後 21780。state.flow（流れ図の全要素）を含む。司令塔はこれを Workflow の args に手で逐語転記して 3 回渡した（prd.js は state をファイルから読む経路を持たない: `grep -n "state_path\|readFile" scripts/prd.js` で該当 0、L513 が input.state を直接使う）。
- task-notification の result プレビューでは next_args 内の `<` `>` が `&lt;` `&gt;` に置換されて表示された（例: "git branch -D &lt;name&gt;"）。output ファイル（JSON）では `<name>` のまま。プレビューから転記すると state が変わる。
- workflow-io.md §1 は「args に全文を入れると、司令塔が手で組む args が数十万字になり、写し間違いがそのまま入力になる」を理由に依頼文を args に入れないとしている。
- skill_telemetry.py record を 4 run 分実行した（~/.claude/skill-telemetry/prd-spec/cleanup-branches-lean-run{1..4}.json）。summary の出力は全 run で verdict/dry/nov/tail/rev/fab/unpres が None、「dry_stop 到達 0/4」。prd.js の返り値に、この script が読むフィールドが無いため（旧 refine.js 形式を前提としている可能性。未確認）。
- usage.py（--json）: agents 24、excluded []、turns 350、input_all 33,647,837（cache_read 31,129,356・cache_creation 2,517,781・input 700）、output 46,287、busy_seconds 3834.9、span_seconds 5972.4。by_model: opus-5-5 turns 325 / sonnet-5 turns 25（sonnet は crossDoc 1 体のみ）。全 agent の first_turn_input は 62,583〜67,587。
- findings（usage.py）: r1 11 件（blocking 6、項目 9）、r2 4 件（blocking 2、項目 4）、r3 3 件（blocking 2、項目 3）。
- 残った blocking 2 件はいずれも PR-CLEANUP-059 と §用語「要判断」の「PR が無いと確かめられた」という限定の根拠欠如（r3-gr）。r3-gr の checked 欄によれば PR-CLEANUP-059 は diff-audited-2 の changed（= 2 パス目の改稿で変わった項目）に含まれる。
- セッションの途中でコンテナ/セッションが一度切り替わった（scratchpad のパスが c80cc526… から bbfbc7eb… に変わった）。W（~/.claude/prd-spec-workspace/cleanup-branches）は保持され、再実行に支障は無かった。
- (追記) usage.py の実行コマンド（実際に使ったもの）: `python3 scripts/usage.py --json --workspace /root/.claude/prd-spec-workspace/cleanup-branches <4 run の transcript ディレクトリ: ~/.claude/projects/-home-user-claude-plugins/{c80cc526…/subagents/workflows/wf_3b5c2b21-912, bbfbc7eb…/subagents/workflows/wf_4b67c639-757, …/wf_ceb65266-c36, …/wf_0ddb5c1c-29b}>`（--json なしで usage.txt）
- W/tmp/ に agent が作ったファイルが 18 本残った（ls で確認）: 生成用の Python script 5 本（gen.py 07:53, apply3a.py 08:27, gen_meta_u1.py 08:42, gen6.py 09:00, rev7.py 09:15。時刻は UTC の mtime）と、版の控え 13 本（flow.bak/pre3a2/pre3a3/flow_min.json、questions.bak/pre6 の json・md、resolutions.bak/pre3a2/pre3a3/pre6/pre9.json）。どの役が作ったかは transcript で確認していない。
- 問いの本文は、G0 の 9 問が W/tmp/questions.bak.md、G0-2 の 1 問が W/tmp/questions.pre6.md、G1 の 3 問が W/questions.md に残っている（W/questions.md は各ゲートで上書きされる）。evidence に questions-g0.md / questions-g0-2.md / questions-g1.md として逐語コピーした。
