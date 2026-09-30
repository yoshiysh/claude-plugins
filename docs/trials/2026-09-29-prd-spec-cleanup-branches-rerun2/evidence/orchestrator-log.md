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
