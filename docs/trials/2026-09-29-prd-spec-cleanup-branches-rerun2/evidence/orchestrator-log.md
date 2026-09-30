# 司令塔の記録（事実のみ）

- skill の版: HEAD `7a208d0`（試走開始時）。試走中は skill を変えない。
- skillDir: `/home/user/claude-plugins/plugins/workflow/skills/prd-spec`（実体のパス。`.claude/skills/...` の symlink 経由ではない）。
- W: `/home/user/claude-plugins/plugins/workflow/skills/prd-spec/workspace/cleanup-branches`（SKILL.md S0 の 2。`git check-ignore -v` で
  `.gitignore:6:/plugins/workflow/skills/prd-spec/workspace/` に当たる）。
- `W/input.md` は再試走の W の `input.md` を複写し、cmp で一致。
- 先例: `precedent.py list --root <skillDir>/workspace --workspace <W>` → paths 0。
- 計画からの変更: 計画の W の根（`~/.claude/prd-spec-workspace-rerun2`）は W の移動（b0a8715）で置き換わった。計画の「manual モードで
  権限の確認で止まった回数」は依頼者の裁定（auto mode 前提）で置き換え、classifier の no-verdict と拒否の回数を数える。
- 開始: 2026-09-29T20:48:28Z
- run1: 名前付きの呼び出し `Workflow({name:"workflow:prd-spec-run"})` は「not found. Available: deep-research」で拒否（plugin が未 install）。
  同じ args を `scriptPath: plugins/workflow/workflows/prd-spec.js` で呼んだ（逸脱。名前付きの呼び出しの未確認項目は残る）。
  Run ID `wf_f413a4a5-c3e`、task `whvtgdqj1`。args: workspace=<W>, skillDir=<skillDir>, entry=new, existing_docs=[]。
- run1 → needs_answers G0（18 問: RS-001〜016・025・026）。agents 12、subagent_tokens 1,382,505、tool_uses 167、duration_ms 2,026,973。
  AskUserQuestion 5 回（4・4・4・4・3 問。最後の 1 問は RS-002 の自由欄が空だったので同じ問いの補足を聞き直したもの）。
  RS-001 と RS-002 の補足は自由記述。回答は answers/g0.md に逐語で書いた（evidence/answers-g0.md）。
- run2: resume（resumeFromRunId wf_f413a4a5-c3e、run1 の args に gates_answered {g0: question_ids}）。
- run2 → needs_answers G0-2（1 問: RS-033）。agents 29、subagent_tokens 1,808,489、tool_uses 215、duration_ms 2,195,233。hold_drafts [RS-027]。
  AskUserQuestion 1 回。回答は answers/g0-2.md（evidence/answers-g0-2.md）。
- run3: resume（resumeFromRunId wf_f413a4a5-c3e、args に gates_answered {g0: …, "g0-2": ["RS-033"]}）。
- run3 → blocked「flow-check（段 3a）が doc_check flow の stdout を返しませんでした」、resumable false、next_args.from 3a（tx.restore t6）。
  agents 32（保存された結果で返った分を含む）、subagent_tokens 188,646、duration_ms 52,355。skipped: verifier:3av（unchanged、RS-033）。
  原因（journal の flow-check:3a の返り値）: haiku が `doc_check flow --rulings` の stdout を写し損ね、JSON として読めない（3,195 字目で
  区切りの欠落。evidence/flow-check-3a-bad-stdout.json）。R16 で初めて実 agent に当たった経路の欠陥として記録し、skill を直してから
  next_args で段 3a から呼び直す。
- skill の修正: 7d06d97（doc_check の stdout に stdout_fnv、写し損ねは flow-check の -recopy で 1 回読み直す）。検証役 1 体が合格。
  run1〜3 は 7a208d0、run4 以降は 7d06d97 で走る。
- run4: run3 の next_args をそのまま渡して scriptPath で起動（from 3a、tx.restore t6。gates_answered は足さない）。resume しないのは、
  保存された結果の stdout に stdout_fnv が無く、新しい script が写し損ねとして扱うため。
  Run ID `wf_0f45ed55-8ba`、task `w3jtseaod`。
