---
name: repo-review
description: >
  yoshiysh/claude-plugins リポジトリの作業ツリーの中で、そのリポジトリのコード・文書・スキル・差分・branch・PR・
  作業中の変更・path の範囲をレビューするときに使うこと。汎用のレビューではなく、base 側の REVIEW.md・
  docs/guidelines・AGENTS.md を規則として、観点ごとの独立した reviewer と別の検証役を Workflow で立て、
  2 段の反証を通った指摘と、読んだ範囲・読めなかった範囲を返す（リポジトリのファイルを変えず、PR に投稿しない。書くのは repo の外の計画のファイル 1 つだけ）。
  「この PR をレビューして」「この差分を REVIEW.md で見て」「作業中の変更をレビューして」
  「plugins/research を監査して」を、このリポジトリについて頼まれたら使う
  （Use when reviewing a diff, PR, working tree, or path of the yoshiysh/claude-plugins repository）。
  対象外: 別のリポジトリや手元に無いコードのレビュー、PR へのコメント投稿、指摘の修正、
  1 つのスキルを best-practices への適合で評価・作成・改稿すること。
---

# Repo review

## 目次

- [目的と結果の扱い](#目的と結果の扱い)
- [前処理: 対象と方針を固定する](#前処理-対象と方針を固定する)
- [観点と担当](#観点と担当)
- [Workflow を呼ぶ](#workflow-を呼ぶ)
- [結果を解釈して返す](#結果を解釈して返す)

## 目的と結果の扱い

このリポジトリの変更か指定範囲を、base 側の `REVIEW.md` に照らしてレビューする。決められる処理（対象の列挙・除外・担当の照合・coverage・重複の統合・票の集計・内容の SHA-256 の照合）は `scripts/review-cli.mjs` が行い、問題の発見は観点ごとの reviewer、成否の判断は観点ごとの別の検証役が行う。レビュー中にリポジトリのファイルを変更せず、PR にも投稿しない。指摘への対応（修正・返信）はこのスキルの役割ではなく、別のスキルが受け持つ。

| モード | 対象 | 指摘の対象 | 作業ツリー |
| --- | --- | --- | --- |
| **diff** | base から head への commit 済みの差分 | 変更が持ち込んだか悪化させた問題 | head を checkout し、変更も未追跡のファイルも無い（CLI が計画と各段で確かめ、合わなければ止める） |
| **working_tree** | base と今の作業ツリーの差（staged・unstaged・untracked） | 今の変更が持ち込んだか悪化させた問題 | 開始時の HEAD と対象の内容の SHA-256 を固定する |
| **audit** | 依頼された path の今の作業ツリーの内容 | 指定範囲に今ある問題（変更前からある問題として扱う） | HEAD と対象の内容の SHA-256 を固定する |

audit の範囲は依頼された path に限る。リポジトリ全体と言えるのは、範囲に `.` を渡して全ファイルを列挙したときだけ。

## 前処理: 対象と方針を固定する

1. **モードと SHA を決める。** 依頼の範囲を広げも狭めもしない。PR・branch・ファイル範囲が一意に決まらないときだけ確認する。
   - PR: `gh pr view <番号> --json baseRefOid,headRefOid` で得た head を **headSha**、`git merge-base <baseRefOid> <headRefOid>` を **baseRef**、base branch の先端（`baseRefOid`）を **policyRef** にする。手元に無い commit は `git fetch` で取る（`.git` の refs と objects が増える）。
   - diff は、作業ツリーが headSha を checkout した clean な状態でだけ始める。reviewer と検証役は作業ツリーのファイルも開くので、別の版の作業ツリーでは別の内容と行番号で候補が作られる。そうでなければ始めずに利用者に伝える（作業ツリーの切り替えは利用者の操作）。
   - branch・commit の差分: 比べる 2 点の完全な SHA を baseRef・headSha にし、base 側を policyRef にする。
   - working_tree: 比べる base の SHA を baseRef と policyRef に、今の HEAD を headSha にする。依頼の前から利用者が持っていた変更の path は **preservedPaths** に入れる（レビューの対象から外れ、名前だけ結果に残る）。
   - audit: 今の HEAD を headSha に、主ブランチの先端（`git rev-parse origin/main`）を policyRef にする。範囲を **scope** に入れる。公開済みスキルは `plugins/` の実体のパスで渡す（symlink を通る path は CLI が拒否する）。
2. **対象を列挙する。** 次で inventory を取る（入力は stdin の JSON。repo はこのリポジトリの作業ツリーの絶対パス）。

   ```bash
   node [SKILL_DIR]/scripts/review-cli.mjs inventory <<'JSON'
   {"repo": "<repo>", "mode": "diff", "baseRef": "<baseRef>", "headSha": "<headSha>", "policyRef": "<policyRef>"}
   JSON
   ```

   CLI は policyRef の `.github/workflows/claude_review.yml` の `exclude-paths` に当たる path を `excluded`、`tools/sync-bp-criteria.mjs` が写しを書く置き場に当たる path を `generated` にして、変更を `reviewable`・`excluded`・`generated`・`preserved` に分ける。除外と生成物は名前だけを残し、内容を開かない。生成物の扱いと理由は出力の `generated_note` が示す。policyRef にその tool が無ければ生成物は無い。`pin_problems` が空でなければ（commit が無い、HEAD の食い違い）始めずに報告する。`reviewable` が 0 件なら Workflow を呼ばず、対象が無いことと除外・生成物の名前を報告して終える。
3. **観点と担当を決め、計画を作る。** 下の「観点と担当」で reviewers を決め、inventory と同じ入力に `"reviewers"` と `"stateDir"`（`mktemp -d` で作った、repo の外のディレクトリ）を足して `plan` 操作を呼ぶ。CLI は計画を `stateDir` に 1 つのファイルとして書く。ほかに書くものは無く、repo の中も変えない。`E_PLAN` は担当の割り当ての誤りなので、理由のとおりに直して呼び直す。`E_PIN` は対象が固定できていないので、始めずに報告する。

## 観点と担当

- policyRef の `REVIEW.md` を `git show <policyRef>:REVIEW.md` で読む。観点（reviewer の lens）は、その「観点」の項目と docs/guidelines の文書から、変更の性質に合うものを選んで立てる（人数の下限は `scripts/review-core.mjs` の `MIN_REVIEWERS`）。一覧をここに写さないのは、`REVIEW.md` が変わったときに写しだけが古くなるため。
- 各 reviewer は `{ "id": "<観点の id>", "focus": "<照らす観点の名前と、見る内容>", "files": [...] }`。担当ファイルは「読むもの」の表で、そのファイルの種類に対応する文書を照らせる観点に割り当てる。全ての対象ファイルを 1 つ以上の観点に割り当てる（和集合が対象と一致しないと `plan` が拒否する）。id の形は `scripts/review-core.mjs` の `LENS_ID` で、合わなければ `plan` が `E_INPUT` で拒否する。
- 対象に `SKILL.md`・スキルの `agents/*.md`・Workflow source（先頭の文が `export const meta` の `.js`）が含まれるときは、best-practices.md を規則として読む **スキル設計** の観点を `"id": "skill-design"` で足し、それらのファイルを担当させる。当たるかの判定の正本は `scripts/review-core.mjs` の `SKILL_DESIGN_TARGETS`・`WORKFLOW_SOURCE_PATHS`・`isWorkflowSource` で（置き場は best-practices.md §13「script の置き場」、削除した Workflow source は base の版で判定する）、当たるファイルを `skill-design` に割り当てないと `plan` が拒否する。
- reviewer の人数の上限は、下の callsite が呼ぶ Workflow source の定数 `MAX_REVIEWERS`。超えるなら観点をまとめる。

## Workflow を呼ぶ

> **透過実行 route**: 現在の tool inventory に native `Workflow` があり、この call が未試行なら
> native を 1 回だけ使う。native が存在しない Codex では `workflow:dynamic-workflow-runner` を
> 内部互換層として使い、ユーザーに runner の指定を求めない。native を試行後に error / timeout /
> invalid result となった場合は runner へ fallback しない。human gate は無し。caller が所有する
> 前処理は「前処理: 対象と方針を固定する」の 1〜3、成功後処理は「結果を解釈して返す」。runner の
> verified return 以外で成功後処理へ進まず、runner 未 install・`unsupported_runtime`・`rejected_source`・
> `workflow_incomplete` はそのまま報告する。
>
> **Codex classification: read-only supported**。runner request の `requirements` と `limits` は source の
> `meta.requirements`・`meta.limits` をそのまま使い、SKILL.md に値を写さない。source が `agent()` に渡す
> model 名（source の `ROLE_MODELS`）の全てに runner の `modelMap` を明示する。運搬役の agent は worker の
> sandbox で `node` と `git` を読み取りだけで実行し、`stateDir` の計画のファイルを読む。worker の `cwd` は repo にする。

`plan` の出力の `plan`・`plan_sum`・`plan_path` を、手を加えずに args へ写す（script が sum で写し間違いを拒否する）。

```js
Workflow({
  scriptPath: "[SKILL_DIR]/scripts/review.js",
  args: { skillDir: "[SKILL_DIR]", plan: <plan の出力の plan>, planSum: "<plan_sum>", planPath: "<plan_path>" }
})
```

`skillDir` はこのスキルの実ディレクトリの絶対パス。Workflow source は自分の位置を解決できず、agent に渡す `agents/*.md` と CLI のパスがここで決まる。

Workflow の段と、source が構造で守ることは次のとおり。運搬役が CLI に渡すのは計画のファイルの path と sum で、計画の本体ではない。

| 段 | 内容 | 欠けたとき |
| --- | --- | --- |
| レビュー | 観点ごとに reviewer を同時に起動する。全員に同じ共通部分を prompt の先頭で渡し、観点と担当だけを最後に渡す | 返らない reviewer の担当は coverage の欠けになる |
| 網羅の照合と統合 | 運搬役が CLI の `pin` と `merge` を流す。commit・HEAD・対象の集合・内容の SHA-256 が計画のままかを照らし、担当ごとの coverage を照らし、同じ path で行範囲の重なる指摘を 1 つの候補にまとめる | pin が崩れたら止まる。coverage の欠けは記録して続ける |
| 一次の検証・一次の判定 | 候補ごとに、最初に挙げた観点の検証役 1 体が主張を 1 つずつ判定し、運搬役が `pin` と `judge` を流す。有効な confirmed の 1 票で確定する | 返らない・不正な票は有効票に数えず、決着していない主張として次の段へ回る |
| 追加の検証・最終の判定 | 決着しなかった主張（refuted・unverified・欠けた票）のうち、過半数（観点の数の半分を超える数）に届き得るものに、残りの観点の検証役を全て当てる。全観点の有効票のうち同じ判定が過半数に届いた主張だけを確定・棄却する | 届かない主張・届き得ない主張は unverified |

観点が 2 つ（`MIN_REVIEWERS`）のときの過半数は 2 で、2 段目で足せる票は 1 つ。1 段目で確定しなかった主張は 2 段目でも確定できず、1 段目の票が refuted の主張だけが 2 段目で棄却され得る。それ以外の主張（1 段目が unverified・欠けた票）は検証役を起動せずに unverified にする。確定に 2 段目を使いたいときは観点を 3 つ以上にする。

検証の段は best-practices の schemas.md「refuter の出力（REFUTE_SCHEMA）」の 2 段の組み方（1 体の段は有効な 1 票で確定、決着しない指摘だけ残りの観点に当てて多数決、欠けた・読めなかった票は有効票に数えない）に合わせている。その節と照らした範囲で、次は違う。

- 観点の集合は reviewer の観点と同じで、人数（`MIN_REVIEWERS` から source の `MAX_REVIEWERS` まで）で変わり、過半数も人数から決まる。固定の観点の一覧を持つと、`REVIEW.md` の観点と別の正本になる。
- 1 段目に置く観点（候補を最初に挙げた観点）は実測で選んでいない。
- 重い指摘を最初から複数の検証役に当てず、検証に回す重さも絞らない（重さは reviewer の申告で、申告で体数や検証の有無を変えると起動数と範囲が帳簿の外で決まる）。
- 1 体の検証役に渡す主張の数に上限が無い。体数を候補の数に依らない上限（段ごとに観点の数まで）に保つためで、1 体の入力は割り当てた主張の数に比例して増える。

## 結果を解釈して返す

- **completed** は、全ての対象の coverage・全ての主張の判定が揃い、pin が最後まで崩れなかったことを示す。指摘が無くても、mode・base・head・policyRef・対象の件数・coverage を報告する。
- **review_incomplete** は `reasons` に原因を持つ。
  - `coverage_or_limitations` と `verification_incomplete` は、レビューの一部が欠けたが、検証を通った `findings` は有効なまま返っている状態。欠けた範囲（`missing_coverage`・`limitations`・`unverified`）を明記し、「問題なし」と報告しない。
  - `pin_changed`・`carrier_failed`・`cli_rejected` は、対象が計画と違う内容になったか、CLI の判定を得られなかった状態。`findings` は空で、`unverified_candidates` は確定指摘として扱わない。working_tree・audit の `pin_changed` は、今の内容で前処理からやり直す。diff の `pin_changed` は `pin.problems` を見る。HEAD・作業ツリーの変化なら作業ツリーを head の clean な状態に戻してから、commit が無い・`E_IO`（git が読めない）なら commit の取得や repo の状態を直してから、前処理からやり直す。
  - `cli_rejected` の `reason` が `plan のファイルを読めない` なら、運搬役の worker が `stateDir` を読めていない。worker が読める repo の外の場所を `stateDir` にして前処理の 3 からやり直す。それ以外の `cli_rejected`（`merge`・`judge` の `E_INPUT`、`E_INTERNAL`）は source と CLI の食い違いなので、`reason` をそのまま報告し、やり直さない。
- **findings** は確定した主張。`votes` に票ごとの観点・理由・確かめた path:line がある。`in_target: false` の指摘は差分の外の行なので summary に path:line で書く。
- **refuted** は棄却された主張と票。件数を summary に含める。**invalid_findings** は場所が不正（除外・生成物・作業中の変更・audit の範囲外など）で検証に回さなかった候補。
- **excluded**・**generated**・**preserved** は内容を読んでいない path。生成物の同期を確かめたことにはならないので、`make test` を実行したか、その結果と一緒に書く。
- 報告の書き方（言語、重大度の表記、件数の書き方、読めなかったファイルの列挙）は policyRef の `REVIEW.md`「出力」に従う。テストやコマンドの実行結果は、このスキルの外で実行したものだけを添え、実行していないものは未実行と書く。
