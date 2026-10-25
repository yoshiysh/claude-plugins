---
name: address-review
description: >
  yoshiysh/claude-plugins リポジトリの GitHub の PR に既に付いているレビュー指摘（inline の thread・bot の summary・review の本文）に対応するときに使うこと。
  全ての指摘を最初に CLI が集め、分類の Workflow で comment-triager が全件を分類して別の triage-verifier が独立に確かめ、
  直すものは repo-implement に渡してテストとレビューを通し、commit・push の後に各指摘へ返信する（thread は resolve しない）。
  「この PR のレビューコメントに対応して」「#172 の bot の指摘を直して返信して」「この PR の指摘が妥当か分類だけして」を、
  このリポジトリについて頼まれたら使う（Use when addressing existing review comments on a pull request of the yoshiysh/claude-plugins repository）。
  対象外: 新しくレビューすること（repo-review）、PR に載っていないレビュー結果の反映や指摘と関係しない実装・修正（repo-implement）、
  別のリポジトリの PR、thread の resolve。このリポジトリの PR の指摘には、汎用の workflow:pr-review-fix でなくこれを使う。
---

# Address review

## 目次

- [目的と担い手](#目的と担い手)
- [進め方](#進め方)
- [収集](#収集)
- [分類](#分類)
- [CLI の op](#cli-の-op)
- [報告](#報告)
- [照合しないもの](#照合しないもの)

## 目的と担い手

このリポジトリの PR に付いたレビュー指摘に、全てを最初に読む → 分類する → 直すものを直す → 返信する、の 1 周で対応する。決められる処理（指摘の収集・対象の選別・分類の結果の照合・修正の依頼の文と返信の本文の組み立て・返信の直前の再照合・投稿の確かめ・次の手の決定）は `scripts/address-cli.mjs` が行い、分類は 2 体の agent、修正は `repo-implement` が行う。司令塔（このスキルを読む session）はファイルを書かず、分類・返信の本文・修正の内容・次の手を自分で作らない（司令塔の手修正と手書きの返信は検証を通らずに成果物と PR に届く）。

司令塔が CLI の出力を写す以外に行うのは次のとおりで、次の手の判断は CLI の出力の `next` に任せる。

- 依頼の文から PR の番号・止める段（`stopAfter`）・含める指摘（`include`・`only`）を選び、利用者の答えを `decisions` に逐語で写して `collect` に渡す。
- 分類の Workflow を起動する（throw したときの呼び直しは「分類」の節）。
- `repo-implement` をスキル呼び出しで起動し、commit と push をその SKILL.md の手順で行う。
- CLI が書いた返信を `gh api` で投稿する。

**このスキルを呼んだことを、commit・push・返信の許可とみなす。** 利用者の要件が「返信まで行う」ことなので、段ごとに確認を挟むと要件に反する。依頼が手前で止めるよう明示したときだけ、`stopAfter` で止める。

**thread を resolve しない。** レビューの決着は利用者が自分で付けるため、このスキルには resolve の手順も API の呼び出しも置かない（`scripts/address-skill.test.mjs` が、スキルのファイルに resolve の mutation が無いことを照らす）。

**1 回の run は 1 周だけ。** push の後に新しい指摘が来ても、この run では集め直さない。新しい指摘・返信を止めた指摘・直せなかった fix は次の run で、新しい `stateDir` の `collect` から扱う（CLI は同じ `stateDir` での 2 回目の分類の受け入れと返信の組み立てを拒否する。返答済みの除外は返した指摘にだけ当たるので、返していない指摘は次の run に残る）。

## 進め方

CLI の入力は stdin の JSON、出力は 1 行の JSON。**全ての出力（`ok: false` の拒否も）が `next` を持ち、司令塔はそれに従って次の操作を選ぶ。** `next` の値と意味の正本は `scripts/address-core.mjs` の `NEXT`（拒否の `code` から決まる既定は `NEXT_BY_CODE`）。止まる・流し直す・待つの条件はここに写さない。CLI の出力の `state`・`state_sum`・`state_path` と各 op の出力の値は、手を加えずに次の入力へ写す（写し間違いは sum で拒否される）。

## 収集

PR の head branch を checkout した clean な作業ツリーで、`mktemp -d` で repo の外に `stateDir` を作り、`collect` を流す。PR の番号は依頼から決め、今の branch の PR が 1 つに決まらないときだけ聞く。

```bash
node [SKILL_DIR]/scripts/address-cli.mjs collect <<'JSON'
{"repo": "<作業ツリーの絶対パス>", "pr": <番号>, "stateDir": "<stateDir>", "stopAfter": "<段>", "decisions": {}}
JSON
```

- `stopAfter` は、依頼の文に合う値を `scripts/address-core.mjs` の `STOP_AFTER`（値と意味の正本）から選ぶ。
- `decisions` は前の run で止まった指摘への利用者の答えを `{"<comment_id>": "<利用者の文を逐語で>"}` で渡す（無ければ `{}`）。CLI が使えないもの（state に無い id・空の値）を外して `dropped_decisions` に返すので、それは報告に書く。
- 利用者が特定のコメントを含めるよう頼んだら `"include": [<comment_id>]` を、特定のものだけを頼んだら `"only": [<comment_id>]` を足す。既定で外すものの理由の正本は `scripts/address-core.mjs` の `EXCLUSION_REASONS`。

CLI は PR と作業ツリーが扱える状態かを確かめ、方針の版を `DEFAULT_POLICY_REF`（`repo-implement` と同じ主ブランチの remote の先端）の SHA に固定し、inline comment・PR の会話（bot の summary を含む）・review の本文・reviewThreads をページングして全件取り、指摘の一覧と返信の直前に照らす議論の snapshot を `stateDir` に書く。gh には argv で渡し、コメントの本文を shell に通さない。

## 分類

> **透過実行 route**: 現在の tool inventory に native `Workflow` があり、この call が未試行なら
> native を 1 回だけ使う。native が存在しない Codex では `workflow:dynamic-workflow-runner` を
> 内部互換層として使い、ユーザーに runner の指定を求めない。native を試行後に error / timeout /
> invalid result となった場合は runner へ fallback しない。human gate は無し。caller が所有する
> 前処理は「収集」、成功後処理は `triage-result`。runner の verified return 以外で
> 成功後処理へ進まず、runner 未 install・`unsupported_runtime`・`rejected_source`・`workflow_incomplete` はそのまま報告する。
>
> **Codex classification: read-only supported**。runner request の `requirements` と `limits` は source の
> `meta.requirements`・`meta.limits` をそのまま使い、SKILL.md に値を写さない。source が `agent()` に渡す
> model 名（source の `ROLE_MODELS`）の全てに runner の `modelMap` を明示する。worker の `cwd` は repo にする。

```js
Workflow({
  scriptPath: "[SKILL_DIR]/scripts/triage.js",
  args: { skillDir: "[SKILL_DIR]", request: "<利用者の依頼の文>", state: <collect の state>, stateSum: "<state_sum>" }
})
```

`skillDir` はこのスキルの実ディレクトリの絶対パス（Workflow source は自分の位置を解決できない）。comment-triager が全件を 1 つの context でまとめて分類し（分類の基準は `agents/comment-triager.md`）、triage-verifier が別の context で全件を確かめ、1 件でも食い違えば止まる（多数決や片方の採用はしない）。検証役を 1 体にしているのは、確定に 2 体の一致を求める作りで、体数を増やしても確定する分類の確かさは変わらず、食い違いで止まる run が増えるだけだから。返り値は status に関わらず `triage-result` に渡す。Workflow が返り値無しに throw した（args の写し間違い）ときは、collect の出力から args を写し直して 1 回だけ呼び直し、それでも throw したら報告して終える。

## CLI の op

どの op も入力に `statePath` と `stateSum`（`collect` の出力の値）を持つ。`next` がその op を示したときに流す。

| op | 足す入力 | 出力の主な値 |
| --- | --- | --- |
| `triage-result` | `triage`（分類の Workflow の返り値。tasks の `.output` の包みのまま `triagePath` でもよい） | `results`（止まったときも、返り値にあれば各指摘の分類と根拠）・`questions`、fix があれば `request`・`fix_ids` |
| `record-fix` | `verify`（repo-implement の verify の出力そのまま）か `stopped`（止まった理由の文） | `commit_message`・`branch`、修正したか（`fixed`） |
| `recheck` | `fixCommit`（push した SHA か JSON の `null`） | `replies`（`endpoint`・`input_path`）・`skipped`・`blocked`・`new_items` |
| `confirm-replies` | 無し | `passed`・`confirmed`・`missing`・`duplicated`・`misplaced` |

```bash
node [SKILL_DIR]/scripts/address-cli.mjs <op> <<'JSON'
{"statePath": "<state_path>", "stateSum": "<state_sum>", ...}
JSON
```

投稿は `gh api <endpoint> --method POST --input <input_path>` で行い、本文を shell の引数に入れない。二重の投稿・誤った場所の投稿を消さない（消すのは取り消せない操作で、利用者が決める）。

## 報告

PR・base と head の SHA・方針の版・取った指摘の件数と `excluded` の内訳・`dropped_decisions`、分類ごとの件数と各指摘の分類と根拠、`repo-implement` の結果（変更の path・check・レビュー・verify）、commit と push した SHA、返信の件数と `confirm-replies` の結果、`skipped`（直していない fix）・`blocked`（議論が変わった）・`new_items`（collect の後に来た指摘）を書き、後の 3 つは次の run で扱うと書く。止まったときは最後の出力の `next` と `reason`。thread は resolve していないことを書く。実行していない段を実行したと書かない。

## 照合しないもの

CLI と分類の Workflow が見ないものは次のとおりで、報告では照合した範囲に含めない。

- sum を計算し直した意図的な改変（state・分類の返り値・CLI の記録の sum は写し間違いと落としを検出するもので、署名ではない）。会話の返答済みの印も同じで、印を手で書いたコメントはその指摘を返答済みにする。
- 分類の草案の文の正しさ。script は形（分類ごとの必須の項目と path:line の形）だけを検査し、文の中身は triage-verifier が確かめる。
- `confirm-replies` の照合は本文と場所の一致で行うので、同じ本文を別の人が同じ場所に書いたものも 1 件に数える。
- thread の「返答済み」の除外は、最後に書いたのが認証ユーザーかで決める。認証ユーザーが指摘に答えずに書いた返信も返答として数える（含めるには `include`）。
- 投稿の反映の遅れが `NEXT` の `wait_and_retry` の待ち時間を超えたとき。`repost` は最初の投稿がまだ読めていないだけでも投稿するので、そのときは二重の投稿になる（`confirm-replies` の `duplicated` に出る）。
- 拒否の後の流し直しの回数。拒否は記録を書かないので、1 回だけ流し直すことは司令塔が数える。
- 方針の版の SHA の一致。分類も `repo-implement` も主ブランチの remote の先端（同じ ref 名）で読むが、それぞれが始めた時点の SHA に固定するので、間に主ブランチが進むと別の SHA になる。
- `repo-implement` の中の照合（計画・check・レビュー・verify）。正本は `repo-implement` の SKILL.md。`record-fix` は verify の出力の `passed` と `actual` だけを見る。
- fix の返信の草案と実際の修正の一致。草案は修正の前に書かれ、`recheck` が足すのは commit の SHA と変えた path だけで、草案の文が `repo-implement` の変更と合うかは照らさない。
- fix の指摘ごとの修正の中身。`recheck` は、fix の `repair_paths` のどれかが修正の commit で変わったかだけを見て（どれも変わっていなければその返信を `skipped` にする）、その path の変更がその指摘を直したかは見ない。
