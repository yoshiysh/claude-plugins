------------------------------- MODULE Seam -------------------------------
(* 継ぎ目: 監査役（下位 agent）の返り値、指名された監査役が写す doc_check の stdout（doc_blocking の受け渡し）、
   保存直前の tree digest の照合。書き手は監査役（環境）と司令塔（照合）。
   IMPL_A024 = TRUE は実装のまま（doc_check の stdout が無いと doc_blocking を 0 にする）。 *)
EXTENDS Naturals

CONSTANTS IMPL_A024

VARIABLES aud, docOut, ncOut, tree
svars == <<aud, docOut, ncOut, tree>>

STypeOK ==
  /\ aud \in {"idle", "wait", "ok", "none"}
  /\ docOut \in {"na", "present", "absent", "malformed", "fault"}
  /\ ncOut \in BOOLEAN
  /\ tree \in {"na", "match", "mismatch"}

SInit == aud = "idle" /\ docOut = "na" /\ ncOut = FALSE /\ tree = "na"

\* @row Seam|idle|段 5・8 で監査役を起動する|-|wait|-|impl:prd-spec.js:2670
\* @trace Seam!Dispatch|plugins/workflow/workflows/prd-spec.js:2670|async function runAuditors(plan, round, stage) {|監査役の起動
Dispatch == aud = "idle" /\ aud' = "wait" /\ UNCHANGED <<docOut, ncOut, tree>>

\* @row Seam|wait|監査役が返す|-|ok（doc_check の stdout: present / absent / malformed、not_checked の有無）|-|impl:prd-spec.js:2724
\* @row Seam|wait|監査役が返さない（null・例外）|-|none|-|impl:prd-spec.js:2681
\* @trace Seam!Return|plugins/workflow/workflows/prd-spec.js:2681|const missing = plan.filter((_, i) => !results[i]).map((p) => auditorLabel(p, round))|返り値の有無と designated の doc_check の有無は環境が決める
Return ==
  /\ aud = "wait"
  /\ \/ aud' = "ok" /\ docOut' \in {"present", "absent", "malformed"} /\ ncOut' \in BOOLEAN
     \/ aud' = "none" /\ docOut' = "na" /\ ncOut' = FALSE
  /\ UNCHANGED tree

\* @row Seam|ok・malformed|写しの取り直し（1 回）|-|present / fault|-|impl:prd-spec.js:1270
\* @trace Seam!Recopy|plugins/workflow/workflows/prd-spec.js:1271|const bad = Object.keys(cmds).filter((k) => cmds[k] && copyFault(x[k]))|JSON の行はあるが受け取れない写しだけを取り直す
Recopy ==
  /\ aud = "ok" /\ docOut = "malformed"
  /\ docOut' \in {"present", "fault"}
  /\ UNCHANGED <<aud, ncOut, tree>>

Ready == aud \in {"ok", "none"} /\ docOut # "malformed"

\* @row Seam|ok・absent|司令塔が doc_blocking を読む|IMPL_A024|zero（doc_blocking=0 として進む）|-|impl:prd-spec.js:2758
\* @row Seam|ok・absent|司令塔が doc_blocking を読む|~IMPL_A024|rerun（段で止める）|blocked + next_args|decision:Q4
\* @row Seam|none・fault|司令塔が結果を読む|-|rerun|blocked + next_args|impl:prd-spec.js:2720
\* @trace Seam!Verdict|plugins/workflow/workflows/prd-spec.js:2758|doc_blocking: docCheck && Number.isInteger(docCheck.blocking) ? docCheck.blocking : 0,|A-024 の fail-open。stage8 の usable(d) も doc_check を見ない
Verdict ==
  IF aud = "none" \/ docOut = "fault" THEN "rerun"
  ELSE IF docOut = "absent" THEN (IF IMPL_A024 THEN "zero" ELSE "rerun")
  ELSE "proceed"

Consume == Ready /\ aud' = "idle" /\ docOut' = "na" /\ ncOut' = FALSE /\ tree' = "na"

\* @row Seam|na|司令塔が保存の直前に tree-digest を取る|-|match / mismatch|-|impl:SKILL.md:155
\* @trace Seam!TreeCheck|plugins/workflow/skills/prd-spec/SKILL.md:157|`tree_digest` を文字列で比べる|最後の監査の後の書き換えは環境が決める
TreeCheck == tree = "na" /\ tree' \in {"match", "mismatch"} /\ UNCHANGED <<aud, docOut, ncOut>>

(* 単位の性質: 結果の無い監査を 0 件にしない *)
SeamQ4 == Ready => Verdict # "zero"

SNext == Dispatch \/ Return \/ Recopy \/ (Consume /\ UNCHANGED <<>>) \/ TreeCheck
SSpec == SInit /\ [][SNext]_svars
=============================================================================
