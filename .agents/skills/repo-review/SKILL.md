---
name: repo-review
description: >
  yoshiysh/claude-plugins リポジトリの中のコード・文書・スキル・差分・branch・PR を、そのリポジトリの
  base 側の REVIEW.md と docs/guidelines を基準に、読み取り専用でレビューする。観点ごとの独立した reviewer と、
  観点ごとの別の検証役を Workflow で立て、検証を通った指摘・読んだ範囲（coverage）・読めなかった範囲を返す。
  「この PR をレビューして」「この差分を REVIEW.md で見て」「作業中の変更をレビューして」
  「plugins/research を監査して」のように、このリポジトリの変更や範囲のレビューを頼まれたら使うこと
  （Use when reviewing a diff, PR, working tree, or path of this repository）。
  対象外: このリポジトリ以外のコード・文書のレビュー（workflow:pr-review や /code-review の領分）、
  PR へのコメント投稿、指摘の修正。
---

# Repo review

## 目次

- [目的と結果の扱い](#目的と結果の扱い)
- [前処理: 対象と方針を固定する](#前処理-対象と方針を固定する)
- [観点と担当](#観点と担当)
- [Workflow を呼ぶ](#workflow-を呼ぶ)
- [結果を解釈して返す](#結果を解釈して返す)

## 目的と結果の扱い

このリポジトリの変更か指定範囲を、base 側の `REVIEW.md` に照らしてレビューする。決められる処理（対象の列挙・除外・担当の照合・coverage・重複の統合・判定の集計・内容の SHA-256 の照合）は `scripts/review-cli.mjs` が行い、問題の発見は観点ごとの reviewer、成否の判断は観点ごとの別の検証役が行う。レビュー中にファイルを変更せず、PR にも投稿しない。指摘への対応（修正・返信）はこのスキルの役割ではなく、別のスキルが受け持つ。

| モード | 対象 | 指摘の対象 | 作業ツリー |
| --- | --- | --- | --- |
| **diff** | base から head への commit 済みの差分 | 変更が持ち込んだか悪化させた問題 | head を checkout し、追跡ファイルに未コミットの変更が無い |
| **working_tree** | base と今の作業ツリーの差（staged・unstaged・untracked） | 今の変更が持ち込んだか悪化させた問題 | 開始時の HEAD と対象の内容の SHA-256 を固定する |
| **audit** | 依頼された path の今の作業ツリーの内容 | 指定範囲に今ある問題（変更前からある問題として扱う） | HEAD と対象の内容の SHA-256 を固定する |

audit の範囲は依頼された path に限る。リポジトリ全体と言えるのは、範囲に `.` を渡して全ファイルを列挙したときだけ。

## 前処理: 対象と方針を固定する

1. **モードと SHA を決める。** 依頼の範囲を広げも狭めもしない。PR・branch・ファイル範囲が一意に決まらないときだけ確認する。
   - PR: `gh pr view <番号> --json baseRefName,baseRefOid,headRefOid` で得た head を **headSha**、`git merge-base <baseRefOid> <headRefOid>` を **baseRef**、base branch の先端（`baseRefOid`）を **policyRef** にする。手元に無い commit は `git fetch` で取る。
   - branch・commit の差分: 比べる 2 点の完全な SHA を baseRef・headSha にし、base 側を policyRef にする。
   - working_tree: 比べる base の SHA を baseRef と policyRef に、今の HEAD を headSha にする。依頼の前から利用者が持っていた変更の path は **preservedPaths** に入れる（レビューの対象から外れ、名前だけ結果に残る）。
   - audit: 今の HEAD を headSha に、主ブランチの先端（`git rev-parse origin/main`）を policyRef にする。範囲を **scope** に入れる。公開済みスキルは `plugins/` の実体のパスで渡す（`.agents/skills/` の symlink を渡すと CLI が拒否する）。
2. **diff の作業ツリーを用意する。** diff は head を checkout した作業ツリーで行う。今の作業ツリーが head と違うか未コミットの変更を持つなら、利用者の作業ツリーに触らず `git worktree add --detach <一時ディレクトリ> <headSha>` を作り、それを **repo** にする。終わったら `git worktree remove` で消す。
3. **対象を列挙する。** 次で inventory を取る（入力は stdin の JSON。repo は絶対パス）。

   ```bash
   node [SKILL_DIR]/scripts/review-cli.mjs inventory <<'JSON'
   {"repo": "<repo>", "mode": "diff", "baseRef": "<baseRef>", "headSha": "<headSha>", "policyRef": "<policyRef>"}
   JSON
   ```

   CLI は policyRef の `.github/workflows/claude_review.yml` の `exclude-paths` を内容を読まない path に、`tools/sync-bp-criteria.mjs` が書く判定基準の写しの置き場（置き場の正本は skill-creator-best-practices の `scripts/bp/constants.mjs` の `CRITERIA_DIR`）を生成物にして、変更を `reviewable`・`excluded`・`generated`・`preserved` に分ける。除外と生成物は名前だけを残し、内容を開かない。生成物の内容は `docs/` の正本と同じ指摘が二重に出るのでレビューせず、正本との同期は `make test` の検査（SP-BPRUN-036）に任せる。`pin_problems` が空でなければ（HEAD の食い違い、diff の未コミットの変更）始めずに報告する。`reviewable` が 0 件なら Workflow を呼ばず、対象が無いことと除外・生成物の名前を報告して終える。
4. **観点と担当を決め、計画を作る。** 下の「観点と担当」で reviewers を決め、inventory と同じ入力に `"reviewers"` を足して `plan` 操作を呼ぶ。`E_PLAN` は担当の割り当ての誤りなので、理由のとおりに直して呼び直す。`E_PIN` は対象が固定できていないので、始めずに報告する。

## 観点と担当

- policyRef の `REVIEW.md` を `git show <policyRef>:REVIEW.md` で読む。観点（reviewer の lens）は、その「観点」の項目と docs/guidelines の文書から、変更の性質に合うものを選んで立てる（人数の下限は `scripts/review-core.mjs` の `MIN_REVIEWERS`）。一覧をここに写さないのは、`REVIEW.md` が変わったときに写しだけが古くなるため。
- 各 reviewer は `{ "id": "<観点の id>", "focus": "<照らす観点の名前と、見る内容>", "files": [...] }`。担当ファイルは「読むもの」の表で、そのファイルの種類に対応する文書を照らせる観点に割り当てる。全ての対象ファイルを 1 つ以上の観点に割り当てる（和集合が対象と一致しないと `plan` が拒否する）。id の形は `scripts/review-core.mjs` の `LENS_ID` で、合わなければ `plan` が `E_INPUT` で拒否する。
- 対象に `SKILL.md`・スキルの `agents/*.md`・Workflow script が含まれるときは、best-practices.md を規則として読む **スキル設計** の観点を `"id": "skill-design"` で足し、それらのファイルを担当させる。どのパスが当たるかの正本は `scripts/review-core.mjs` の `SKILL_DESIGN_TARGETS` で、当たるファイルを `skill-design` に割り当てないと `plan` が拒否する。
- reviewer の人数の上限は `scripts/review.js` の `meta.caps.maxReviewers`。超えるなら観点をまとめる。

## Workflow を呼ぶ

> **透過実行 route**: 現在の tool inventory に native `Workflow` があり、この call が未試行なら
> native を 1 回だけ使う。native が存在しない Codex では `workflow:dynamic-workflow-runner` を
> 内部互換層として使い、ユーザーに runner の指定を求めない。native を試行後に error / timeout /
> invalid result となった場合は runner へ fallback しない。human gate は無し。caller が所有する
> 前処理は「前処理: 対象と方針を固定する」の 1〜4、成功後処理は「結果を解釈して返す」。runner の
> verified return 以外で成功後処理へ進まず、runner 未 install・`unsupported_runtime`・`rejected_source`・
> `workflow_incomplete` はそのまま報告する。
>
> **Codex classification: read-only supported**。runner request の `requirements` と `limits` は source の
> `meta.requirements`・`meta.limits` をそのまま使い、SKILL.md に値を写さない。source が `agent()` に渡す
> model 名（`scripts/review.js` の `ROLE_MODELS`）の全てに runner の `modelMap` を明示する。運搬役の agent は
> worker の sandbox で `node` と `git` を読み取りだけで実行する。worker の `cwd` は repo にする。

`plan` の出力の `plan` と `plan_sum` を、手を加えずに args へ写す（script が sum で写し間違いを拒否する）。

```js
Workflow({
  scriptPath: "[SKILL_DIR]/scripts/review.js",
  args: { skillDir: "[SKILL_DIR]", plan: <plan の出力の plan>, planSum: "<plan の出力の plan_sum>" }
})
```

`skillDir` はこのスキルの実ディレクトリの絶対パス。script は自分の位置を解決できず、agent に渡す `agents/*.md` と CLI のパスがここで決まる。

Workflow の段と、script が構造で守ることは次のとおり。

| 段 | 内容 | 欠けたとき |
| --- | --- | --- |
| レビュー | 観点ごとに reviewer を同時に起動する。全員に同じ共通部分を prompt の先頭で渡し、観点と担当だけを最後に渡す | 返らない reviewer の担当は coverage の欠けになる |
| 網羅の照合と統合 | 運搬役が CLI の `pin` と `merge` を流す。HEAD・対象の集合・内容の SHA-256 が計画のままかを照らし、担当ごとの coverage を照らし、同じ path で行範囲の重なる指摘を 1 つの候補にまとめ、最初に挙げた観点の検証役に割り当てる | pin が崩れたら検証に回さず止まる。coverage の欠けは記録して続ける |
| 指摘の検証 | 候補を持つ観点ごとに検証役を 1 体起動する | 返らない検証役の候補は unverified |
| 判定の集計 | 運搬役が `pin` と `finalize` を流し、候補ごとの判定と根拠の妥当性を照らす | 欠けた・不正な判定は unverified |

## 結果を解釈して返す

- **completed** は、全ての対象の coverage・全ての候補の有効な判定が揃い、pin が最後まで崩れなかったことを示す。指摘が無くても、mode・base・head・policyRef・対象の件数・coverage を報告する。
- **review_incomplete** は `reasons` に原因を持つ。`coverage_or_limitations` と `verification_incomplete` は、レビューの一部が欠けたが、検証を通った `findings` は有効なまま返っている状態。欠けた範囲（`missing_coverage`・`limitations`・`unverified`）を明記し、「問題なし」と報告しない。`pin_changed` と `carrier_failed` は、対象が計画と違う内容になったか CLI の判定を得られなかった状態で、`unverified_candidates` は確定指摘として扱わない。working_tree・audit の `pin_changed` は、今の内容で前処理からやり直す。
- **findings** は確定指摘。`claims` は検証役が成り立つと判断した主張だけで、`verification.evidence` に確かめた path:line がある。`in_target: false` の指摘は差分の外の行なので summary に path:line で書く。
- **refuted** は棄却された主張と理由。件数を summary に含める。**invalid_findings** は場所が不正（除外・生成物・audit の範囲外など）で検証に回さなかった候補。
- **excluded**・**generated**・**preserved** は内容を読んでいない path。生成物の同期を確かめたことにはならないので、`make test` を実行したか、その結果と一緒に書く。
- 報告の書き方（言語、重大度の表記、件数の書き方、読めなかったファイルの列挙）は policyRef の `REVIEW.md`「出力」に従う。テストやコマンドの実行結果は、このスキルの外で実行したものだけを添え、実行していないものは未実行と書く。
