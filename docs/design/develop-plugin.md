# develop plugin の構成案：implement・review・address-review の共通化

3 リポジトリ（yoshiysh/claude-plugins・personal-knowledge-rag・stock-valuation-dcf）にある実装・レビュー・レビュー指摘対応のスキルを、claude-plugins が配布する plugin `develop` の 1 組にまとめる構成案。原則は `docs/design/skill-design-patterns.md`（以下「設計方針文書」）の節を、要求は `docs/requirements/bp-designed-skill.md`（以下 PR-BPDESIGNEDSKILL-NNN を「PR-NNN」と略す）を参照し、ここには書き写さない。作るときと測るときは skill-creator-best-practices（以下 bp）の create・update・review を使う。

利用者が決めたこと（この文書では変えない）：
- 呼び出しは `develop:implement`・`develop:review`・`develop:address-review`。
- `workflow:pr-review` と `workflow:pr-review-fix` は develop に吸収して廃止する。

## 目次
- [結論と範囲](#結論と範囲)
- [plugin の構成](#plugin-の構成)
- [形の判定](#形の判定)
- [利用側リポジトリとの契約](#利用側リポジトリとの契約)
- [決定で足す流れ](#決定で足す流れ)
- [pr-review・pr-review-fix の機能の行き先](#pr-reviewpr-review-fix-の機能の行き先)
- [3 リポジトリから取り込む仕組み](#3-リポジトリから取り込む仕組み)
- [bp 計測から導いた差分](#bp-計測から導いた差分)
- [移行計画](#移行計画)
- [決まったこと](#決まったこと)

## 結論と範囲

- 土台は claude-plugins の `repo-implement`・`repo-review`・`address-review`（`.agents/skills/` の未公開の実体）にする。CLI と `stateDir` で状態を持ち、sum で写し間違いを止め、検証役を生成役と別の context に置く作りは、3 リポジトリの中でこれだけが持つ（出所は「3 リポジトリから取り込む仕組み」）。
- 今の役の分担・段・照合は残す。変えるのは 2 種類だけ。
  - claude-plugins に固有の値の直書きを、利用側リポジトリの宣言と導出に移す（「利用側リポジトリとの契約」）。
  - 一般化と設計方針への適合に要る段・op を足す。足すのは、投稿と投稿の確認、上限で止めた review-run の返り値をセッション側の CLI が状態に書く op とそこからの再開、skip 一覧からの追加起動、`REVIEW.md` の必須の観点の強制、観点ごとの focus を書く役、`pipeline_status`、PR の head の worktree、`stopAfter: "plan"` とそこからの再開、外のレビュー結果の分類（PR のある対象と無い対象）、返信の前の required checks の待ち、条件つきの resolve、git の外の対象のレビュー。どれも本文の該当節に書く。
- 3 スキルは同じ plugin に入れる。implement は review の返り値を厳密に照合し、address-review は implement に修正を渡す。別々の plugin にすると、相手の版がずれたときに照合が壊れる。

| 共通化するもの（develop が持つ） | 利用側リポジトリに残すもの |
|---|---|
| 段の順序、CLI の照合（状態・券・snapshot・pin・coverage・票の集計・返信の再照合）、役の prompt（`agents/*.md`）、Workflow source、既定の観点 | 方針文書（`REVIEW.md` とその「読むもの」表が挙げる文書）、check の許可リストと必須 check、除外と生成物の置き場、commit 後の push の要否、人が読む出力の言語 |
| 役ごとの model・effort（Workflow source の `ROLE_MODELS`） | 領域の観点（dcf の金融ロジック・Rust、pk のコーパス保護）。どれも各リポジトリの `REVIEW.md` に書く |

**dcf の magi-issue-resolver は対象外にする。** Issue の選定から PR-ready・振り返りまでを 1 本の Workflow（`.agent/skills/magi-issue-resolver/scripts/issue-resolve.js`）で回すもので、実装・レビュー・指摘対応に分かれていない（dcf の SKILL.md を gh api で読んで確かめた）。「develop:* を呼ぶ側になる」という見立ては、条件つきでだけ成り立つ。
- develop:implement と develop:address-review は、セッションが CLI を shell で流し、Workflow を段ごとに別の run で起動する作り。Workflow の中の agent から別の Workflow を起動できるかは未確認で、Codex runner は入れ子の workflow を持たない（`plugins/workflow/skills/dynamic-workflow-runner/scripts/runtime/README.md` の未実装の一覧）。magi の Workflow の中から develop:* は呼べない前提で考える。
- magi が develop:* を呼べるのは、run の境界（magi の Workflow が返った後に、セッションが次のスキルを起動する所）だけ。magi をその形に組み直すかは dcf の判断で、この構成案の範囲の外に置く。
- dcf の contextual-code-review は develop:review で置き換える（決定 5）。magi の Workflow の中のレビューエンジンの一覧から外す作業と、抜けた分の補い方を dcf が決めることは、移行計画の段 2 に入れる。

## plugin の構成

### スキル

| 呼び出し | ディレクトリ（実体名） | 元 | 担うこと |
|---|---|---|---|
| `develop:implement` | `implement` | `repo-implement`・pr-review-fix の apply と verify | 計画 → 計画のレビュー → 実装 → check → review → 上限つきの修正 → 最終照合 |
| `develop:review` | `review` | `repo-review`・pr-review | focus を書く段 → 観点ごとの reviewer → 統合 → 2 段の検証 → 結果。PR が対象なら投稿と投稿の確認。利用者が明示したときだけ、git の外の対象を `external` モードで見る |
| `develop:address-review` | `address-review` | `address-review`・pr-review-fix の分類と返信 | 指摘の収集 → 分類と分類の検証 → implement に修正を渡す → commit と push → required checks の待ち → 返信と投稿の確認 → 条件つきの resolve。PR の無い対象への外のレビュー結果は、分類から implement までで終わる |

ディレクトリ名は frontmatter の `name` と揃える。install 先のキャッシュはディレクトリ名で作られ、兄弟スキルへの `../<name>/` 参照がこの名前に依存する（AGENTS.md「実体が plugins/ 側にある理由」）。改名は公開の前（段 1）に済ませる。公開後に変えると、兄弟参照とキャッシュが同時に壊れる。

### ファイルの置き場

| もの | 置き場 | 持つもの |
|---|---|---|
| 役の prompt | 各スキルの `agents/*.md`（planner・plan-reviewer・implementer、reviewer・finding-verifier、comment-triager・triage-verifier） | 役の指示。Workflow source が `skillDir` からパスで読む。subagent としては登録しないので、frontmatter の道具の制限には頼らない（「権限」） |
| CLI | 各スキルの `scripts/<skill>-cli.mjs` と `<skill>-core.mjs` | 状態の読み書き、照合、`next` の決定 |
| Workflow source | `plugins/develop/workflows/*.js`（公開時に `register_plugin.py` が移す） | 段の制御。SKILL.md からは名前で呼ぶ |
| 共有の決定的処理 | `review/scripts/develop-core.mjs`（案） | `canonical`・`fnvSum`・SHA の形・repo 相対 path の判定・利用側の設定の読み込みと検査 |
| 既定の観点 | `review/references/default-lenses.md` | `workflow:pr-review` の `references/review-lenses.md` を移したもの |
| 設定の schema | `review/references/repo-config.schema.json`（案） | 利用側の宣言の形 |
| テスト（配布物） | 各スキルの `scripts/*.test.mjs` | core と CLI の単体のテスト、Workflow source の定数と core の一致の照合。`Makefile` が Node のテストとして拾うのはこの形で、`<skill>/tests/*.test.mjs` は拾わない（`Makefile` の `SKILL_NODE_TEST_FILES` を読んで確かめた） |
| テスト（配布しない） | リポジトリ直下の `tests/` | workflow plugin の runtime で Workflow source を模擬実行するテスト（下記） |

Workflow source の名前（`meta.name`）は `implement-plan`・`implement-run`・`review-run`・`address-review-triage` にする（案）。今の 4 本のうち 3 本（`repo-implement-plan`・`repo-implement-run`・`repo-review-run`）は `repo-` を頭に持ち、配布先の呼び出し名と合わない（`I:p1-best-practices-8`。finding id の書き方は「bp 計測から導いた差分」）。`address-review-triage` はそのまま使える。

**共有の処理を 1 箇所にする。** 今は `canonical`・`fnvSum` が core と Workflow source に字面で複製され、一致を照らすのはリポジトリ直下の `tests/repo-implement-workflow.test.mjs`・`tests/repo-review-workflow.test.mjs`・`tests/address-review-workflow.test.mjs` の 3 本だけ（各スキルの `scripts/*.test.mjs` を source のファイル名 `plan.js`・`implement.js`・`review.js`・`triage.js` で grep し、当たったのは `address-review/scripts/address-cli.test.mjs:289` の fixture のファイル名 `address-review-triage.json` の 1 行だけで、一致の照合ではなかった）。develop では次のようにする。
- CLI の core 3 つは `review/scripts/develop-core.mjs` を兄弟参照で import する。review を置き場に選ぶのは、implement も address-review も review に依存し、review は他に依存しないから（依存の向きと置き場の向きを揃える）。スキルの間の import は、`plugins/*/skills/*/scripts/` を `from '../../` で grep した範囲では先例が無い。`check_portability.py` が通すかは未確認で、段 1 で確かめる。
- Workflow source は import できない（本体は自分の位置を解決できず、runner は `workflows/` 直下の `.js` を全て source として読む）。写しは残す。
- 上の 3 本のテストは 2 つに分ける。
  - 定数・`canonical`・enum の一致の照合は、同じ plugin のファイルだけを読むので、各スキルの `scripts/*.test.mjs` に移して配布物に入れる。
  - 模擬実行のテストは直下の `tests/` に残す。3 本とも workflow plugin の runtime（`plugins/workflow/skills/dynamic-workflow-runner/scripts/runtime/runtime.mjs`・`source.mjs`）を import し、`repo-implement-workflow.test.mjs` は `scripts/traceability/specs.mjs` も読む。別の plugin と plugin の外のファイルを読むテストは、配布物に置けない（AGENTS.md「現在の実体」）。
- 守らないと壊れること：一致の照合が配布物の外だけにあると、配布先で core を直したときに写しとの drift を検出できない。

### 依存と Codex runner

- `.claude-plugin/plugin.json` の `dependencies` は `["workflow"]`。Codex で native Workflow が無いときに `workflow:dynamic-workflow-runner` を使うため（先例：`research`・`skill-creator` が同じ理由で `workflow` を宣言している。`jq .dependencies plugins/*/.claude-plugin/plugin.json` で見た）。workflow から develop への依存は作らない。
- Codex での起動の区分は、今の各 callsite のものを引き継ぐ。`implement-run` だけが workspace-write、他は read-only。`review-run` は上限で止まって再開するときも read-only のままにする（状態を書くのは run の外のセッション側の CLI。「起動数の上限」）。runner request の `requirements` は source の `meta` をそのまま使い、`ROLE_MODELS` の全ての model 名に `modelMap` を明示する。`review-run` の `limits` だけは「起動数の上限」の節で決め直す。
- 透過実行 route の定型文は、今の `repo-implement` の SKILL.md では 2 つの callsite にほぼ同じ文で 2 回書かれている（`I:p1-script-vs-prose-7`・`I:p1-duplicate-claims-3`・`I:p1-best-practices-7`。`repo-review` と `address-review` は callsite が 1 つで 1 回）。develop では各 SKILL.md に 1 回だけ書き、callsite ごとの違い（前処理・成功後処理・区分）は表にする。
- callsite を名前の呼び出しに変えると、`tests/workflow-callers.test.mjs` の、名前の callsite ごとの区分の一覧に 4 本を足す必要がある。足さないと `make test` が落ちる。

### 権限（PR-010・014・015）

| host | 読み取り専用を何が強いるか | 残る危険（結果に書く） |
|---|---|---|
| Codex runner | run ごとの `requirements`。`implement-run` だけを workspace-write にし、他の run は read-only | runner は agent ごとの道具の許可を持たない（runtime README の未実装の一覧）。同じ run の中の役は分けられない |
| Claude Code の native Workflow | 何も強いない。permission rules は全ての subagent に同じく効く（設計方針文書「権限」） | planner・reviewer・検証役・分類役の書き込みは止められない。事後に検出するだけ（implement は段ごとの snapshot、review は pin、全ての役は返した `head_sha` の照合） |

- read-only の run の中では、`stateDir` を含めてどこにも書かない。運搬役が run の中で流す CLI の op は、今と同じく読んで照合し結果を返すだけのもの（今の `review-cli.mjs` の `CARRIER_OPS` は pin・merge・judge で、状態を書かない）。状態を書く op は、run が返った後にセッションが流す（implement の `inventory`、address-review の `triage-result` と同じ形）。
- 各 SKILL.md には、run の前に利用者が許可しておくものを書く。node と git の実行、gh の読み出し、セッションが流す CLI の `stateDir` への書き込み。address-review と review の投稿では、gh の POST も要る。address-review の resolve では、`gh api graphql` の mutation も要る（「resolve」）。review の `external` モードでは、repo の外の名指されたファイルの読み出しも要る。許可が無いと、長い run の途中で確認が出て止まる（`R:p1-best-practices-7`・`A:p1-best-practices-5`）。
- 役の prompt は `agents/*.md` をパスで読ませる。subagent の frontmatter の制限は使わない。plugin から読む agent では frontmatter の一部が無視されるので、そこに頼ると配布先で黙って効かない。
- 「残る危険」の列の内容は、各スキルの結果に毎回書く（PR-015）。

### 起動数の上限（PR-016・017・019〜023）

fan-out を持つ Workflow source は `review-run` だけ。今の 4 本を `parallel(`・`pipeline(` で grep した範囲では、呼んでいるのは `repo-review/scripts/review.js` だけ（reviewer の段と検証の段）だった。plan・implement・triage は agent を順に起動するので、これらの要求は当たらない。

| 要求 | review-run での形 |
|---|---|
| PR-016 受け取り | args に起動数の上限を取る。値の検査（不正・最小に満たない値）は `docs/specifications/bp-run.md` の起動数の上限の規則に合わせる |
| PR-021 渡されないとき | 今の固定の上限（`review.js` の `MAX_REVIEWERS`）を外す。観点の数を決め打ちしない。超えたら観点をまとめるという SKILL.md の指示も消す |
| PR-017・019 渡されたとき | 項目を起動する前に残りの枠を数える。運搬役も起動数に数える（今の `review.js` の `meta.limits` の式が運搬役の段と試行の回数を含めている）。そのため枠からは、項目の分に加えて、起動した項目の後に要る運搬役（統合・判定）の分を先に取っておく。取っておけない項目は起動せず、順位つきの未着手として、それまでの結果と一緒に run の返り値に入れて止まる。状態に書くのは、run が返った後にセッションが流す CLI の `record-run`（下記）。順位は観点の順、同じ観点の中では担当の順（`docs/specifications/bp-inspection.md` の review の項目の順位と同じ決め方） |
| PR-020 再開 | `record-run` が状態を書き、`next_args`（計画の path と sum、状態の path と sum）を返す。次の run は、運搬役が CLI の読み出しの op で状態を読み（今の運搬役が計画のファイルを読むのと同じ read-only の操作）、未着手の項目から続け、結果のある項目を処理し直さない。pin が崩れていたら再開せず計画からやり直す |
| PR-022・023 起動の経路 | Codex runner で起動するときだけ上限を渡す。native Workflow では渡さない |

**上限の値の置き場。** 今は `meta.limits.maxAgents` を `MAX_REVIEWERS` から導き、その式を `tests/repo-review-workflow.test.mjs` が照らしている。`MAX_REVIEWERS` を消した後は次のようにする。
- runner の天井の値は source の `meta.limits` に置かず、review の CLI に 1 つだけ置く。Codex の callsite は CLI の出力から、runner request の `limits.maxAgents` と args の上限の両方を入れる。
- bp の作りに合わせた形。bp の `workflows/*.js` は `limits` を持たない（grep で 0 件）。runner の天井は `plugins/skill-creator/skills/skill-creator-best-practices/scripts/select_runtime.js` の `RUNNER_LIMITS` にあり、source の側は天井に収まる上限を自分の定数で持つ（`plugins/skill-creator/workflows/review_skill.js` の `MAX_UPDATE_ROUNDS` の注記）。
- source の `meta.limits.maxAgents` に値を置くと、native Workflow がそれを強いる場合に、上限を渡さない run の固定の上限になり、PR-021 とぶつかる。native が `meta.limits` を読むかは未確認（`review.js` の注記は runner だけが読むとしている）。
- 導出式のテストは、直下の `tests/` の模擬実行のテストに置き換える。上限を渡した run が上限を超えて起動せず、未着手を順位どおりに返り値に入れて止まることを確かめる。

**今の review に無く、新しく要る部品。** 今の `stateDir` が持つのは計画と方針の束だけ。
- `record-run` の op。run の返り値（reviewer の返り値と coverage、検証の票、未着手）を、セッションが CLI に渡して状態に書く（冪等。返り値の sum で写し間違いを止める）。これが無いと、再開した run は結果のある項目を見分けられず、処理し直す。
- 状態の読み出しの op（運搬役が run の中で流す。書かない）。
- 再開の入口（`next_args` を受け取る前処理）。

**書き手を run の外に置く理由。** 案は 2 つあった。`review-run` を workspace-write にして運搬役が書く案と、run の返り値をセッション側の CLI が書く案。後者を選ぶ。
- workspace-write にすると、runner は役ごとに書き込みの権限を分けられないので、同じ run の reviewer と検証役も書けるようになる。implement が書き込める run に implementer だけを置いているのと同じ理由で避ける。
- `stateDir` は repo の外の `mktemp -d` で、Codex の read-only の既定のままでは run の中から書けない（今の repo-review の callsite も「読み取りだけで実行」と決めている）。
- 返り値の受け渡しは、implement と address-review が既に使う形で、新しい権限が要らない。
- 守らないと壊れること：run が上限で失敗すると返り値が無く、それまでの結果が失われる。script が上限に届く前に返すのはこのため。設計方針文書「状態の書き込み」の、run の中で書くのは運搬役、という行には当たらない（書くのは run の外のセッションで、受理を決めるのは CLI）。

**その他。**
- 同時実行：`meta.limits.concurrency` が、設計方針文書「体数と同時実行」の初期値と違い、根拠が無い（`R:p1-best-practices-8`）。初期値に合わせ、eval で決め直す。守らせ方（runtime の設定か script か）は `docs/specifications/bp-conformance.md` の SP-BPCONFORMANCE-027 と TBD-SBPCONFORMANCE-003 で未決。bp 自身は script の名前付きの定数で守っており、develop も同じにする（案）。
- 結果に記録すること：実際に起動した agent のモデルと起動数（同節の、起動した agent のモデルを記録する行）。

## 形の判定

設計方針文書「形の判定」の図を、軽い形から順に当てた結果（PR-001）。重い形を選んだ所は、それを強いた条件を書く（PR-002）。

| 単位 | 問いへの答え | 形と部品 | 資産台帳 | 形を強いた条件 |
|---|---|---|---|---|
| `implement-plan` | 人間の入力（needs_human_decision）は run の境界にできる。項目は 1 つの計画で、作り直しに要るのはその計画のレビュー結果だけ | 固定パイプライン型＋項目ごとの until-pass。上限で止まったときの `revisions_exhausted` が、until-pass の「通らなかったことと理由を返す」に当たる | 持たない（fan-out が無い。PR-018） | — |
| `implement-run` | 戻りが無い | 固定パイプライン型（implementer 1 体） | 持たない（PR-018） | — |
| implement の外側（run の並び） | 実装 → check → review → 修正、の戻りを run をまたいで持つ | 固定集合の反復型。修正の回の上限は `implement-run` の source の定数 | 持たない | 書き込める run には implementer だけを置く必要がある。runner は役ごとに書き込みの権限を分けられない（`repo-implement` SKILL.md の「目的と段」）。check は shell を要し、script は shell に触れない |
| `review-run` | 戻りが無い（2 段目の検証は、1 段目で決着しなかった主張に当てる段で、戻りではない） | 固定パイプライン型＋観点ごとの検証・反証の部品。最初の段に focus を書く 1 体を置く（「contextual-code-review の置き換え」） | 持つ（PR-005。下記） | — |
| `address-review-triage` | 戻りが無い（食い違えば止まる） | 固定パイプライン型（分類 1 体 → 検証 1 体） | 持たない（全件を 1 つの context で読み、fan-out しない。PR-018） | — |
| address-review の外側 | 収集 → 分類 → 修正 → push → required checks の待ち → 返信 → resolve（PR の無い形は修正まで）。needs_decision は run の境界にし、次の run で `decisions` として入れる。checks の待ちは、待つ回数の上限つきの同じ op の流し直しで、段の間の戻りではない | 固定パイプライン型（1 run は 1 周） | 持たない | — |

- implement の外側は、人間の入力ではなく権限の分離で run に分かれている。設計方針文書「形の判定」の図の、書き込む役と書き込ませない役が同じ区間に要るかの問いと、同節の原則の表・例の着地の表の行が、これに当たる（決定 8 (i) で足した）。
- 外側の並びで段を選ぶのは司令塔（スキルを読むセッション）の仕事（AGENTS.md「作業ルール」の、段の選択の項）。選ぶ材料は CLI の `next` で、司令塔は `next` に従い、内容を作らない。

**目標の固定（PR-006）。** 入口で固定した目標と出発点を状態に書き、後の段はそれを書き換えない（設計方針文書「目標の固定」）。
- implement：`start` が依頼の文を目標として状態に書く。今は needs_human_decision の回答を依頼の文に足して計画からやり直している（`repo-implement` SKILL.md「計画と計画のレビュー」の status の表）。develop では、回答を address-review の `decisions` と同じく別の記録として状態に足し、目標の文は変えない。目標の文に足すと、何を頼まれ何を後から決めたかが区別できなくなる。
- review：計画の mode・SHA・対象・除外が目標。計画のファイルに固定し、sum で守る（今と同じ）。
- address-review：PR と、collect で取った指摘の集合が目標。PR の無い形では、差分（base と head の SHA）かファイルの集合と、渡された指摘の集合が目標（「外のレビュー結果を分類して直す」）。どちらも `stateDir` に固定する。
- review の `external` モード：対象のファイルと内容の SHA-256 が目標（「git の外の対象のレビュー」）。

**review の資産台帳。** 適用条件（fan-out した結果について、どこまで見たかを宣言する必要がある）に当たる。今の作りでは、CLI が coverage と `missing_coverage` を返すだけで、欠けた資産を追加で見に行く経路が無い（`R:p1-best-practices-6`）。develop では次を足す。
- 資産：対象ファイル（path と内容の SHA-256）。資産 ID は CLI が決める。
- 結び付き：「見た」は信用できる reviewer の coverage から入れる。指摘は検証役の結果として入れる。
- skip 一覧：信用できる reviewer が誰も読み終えていない資産。script はその資産だけを渡して reviewer を追加で起動し、新しく見た資産が無くなった回で止める。起動数の上限を渡されたときは、追加起動も枠に数える。
- 追加で起動するのは reviewer。develop:review で資産を読み「見た」を作るのは reviewer で、finding-verifier は割り当てられた主張だけを確かめ、新しい指摘を探さない（`repo-review/agents/finding-verifier.md`）。設計方針文書「資産台帳」の skip 一覧の行は、追加で起動する役を「資産を読んで『見た』を作る役」とし、主張だけを確かめる役に未読の資産を渡さないと書いている（決定 8 (ii) で直した）。

## 利用側リポジトリとの契約

### 宣言する設定

利用側は設定ファイル `develop.config.json` を 1 つ置く（決定 1。置き場はリポジトリの直下）。形は `review/references/repo-config.schema.json` で決め、CLI が読み込み時に schema で検査する。合わない設定は失敗させる。黙って既定に落とすと、書いた宣言が効かないまま run が進む。

| 項目 | 形 | 無いときの既定と失敗の仕方 |
|---|---|---|
| 方針文書 | `reviewPolicy`（既定 `REVIEW.md`）と `rulesDir`（「読むもの」表の、ディレクトリの無い名前を解決する基点） | 文書が無ければ既定の観点（次の節）で見て、結果に「方針文書なし」と書く。文書があるのに表を読めなければ `E_POLICY` で止める |
| 除外 | `excludePaths`：glob の配列か、`{from: <YAML の path>, key: <キー>}` | 除外なし |
| 生成物 | `generated`：`[{glob, note}]` か `[{command: {argv}, note}]`。後者は方針の版の内容で argv を流し、標準出力の glob を使う | 生成物なし |
| 対象の種類 | `kinds`：`{specification: [glob], prd: [glob]}` | skill・code・document は CLI の固定の規則で分ける。spec と prd は宣言が無ければ document として扱う |
| check | `checks.allowed`：`[{id, argv, pathGlob?}]`、`checks.required`：`[id]` | 既定を置かない。implement は受け入れで止め、宣言の雛形を返す。review と address-review は使わない |
| テストの設計の基準 | `testDesignGuide`（path か path#節） | plugin の既定（`implement/references/case-design.md`。案） |
| commit の後 | `afterCommit`：`push` か `none` | `none`。address-review は返信が push 済みの SHA を指すので、この設定に関わらず push する |
| 出力の言語 | `outputLanguage`（言語の名前。例 `ja`・`en`） | `ja`（決定 6）。効くのは人が読む出力だけ：address-review の返信の本文、review の PR への投稿の本文、3 スキルの報告。そのため comment-triager の `reply_draft` と、reviewer・検証役が書く指摘の本文（投稿に使う）は、この言語で書かせる。agent への prompt・agent の内部の作業・状態の中の機械向けの値には効かせない。`REVIEW.md` の「出力」が言語を書いていても、develop はこの設定だけを見る（2 箇所から決めると食い違う） |

**方針の版は設定に入れず、導く。** 設定は方針の版から読むので、方針の版を設定に書くと循環する。
- PR が対象なら、PR の base の branch の先端（今の repo-review の PR の扱い）。address-review と、address-review から呼ばれた implement もこれに当たる。base が既定ブランチでない PR（`release/*`・`develop` など）では、その base の branch が方針の branch になる。
- 他は、`gh repo view --json defaultBranchRef` の branch の、remote の先端。remote は、URL が `gh repo view` の `nameWithOwner` に当たるものを `git remote -v` から選ぶ。1 つに決まらなければ `E_PIN` で止める。

**設定は方針の版から読む。** 作業 branch の規約を基準に混ぜると、その branch で変えた規約で同じ変更を免責する（`repo-review` SKILL.md の前処理の 1、working_tree の policyRef の段落）。設定も同じで、作業ツリーや PR の head から読むと、その PR が自分の必須 check や除外を緩められる。
- その帰結として、設定を足す・変える PR は、merge されるまで効かない。設定の無いリポジトリでは、implement は受け入れで止まる。review は既定の観点で動く。
- 初めて develop を使うリポジトリは、設定を足す PR を develop:implement の外（手作業か通常のセッション）で作って merge してから使い始める。移行計画の段 1・段 2 はこの順にする。

**check に既定を置かない。** 許可リストを推測すると、モデルの書いた文を shell に渡す経路ができる。宣言が無いまま check を省くと、テストを流していない変更が `verify` を通る。

**claude-plugins の宣言。** 今の挙動を、この設定と `REVIEW.md` で表し直す。
- 除外：`{from: ".github/workflows/claude_review.yml", key: "exclude-paths"}`
- 生成物：`tools/sync-bp-criteria.mjs` の書き先。今は `review-cli.mjs` の `readGeneratedPaths` が tool の source を解析して導いている。develop では `command` 形にし、tool に書き先を出力する option を足す（今の tool の引数は `--check` と `--root` だけ。`main` を読んで確かめた）。glob を設定に写すと、tool の書き先と 2 箇所になる。argv は方針の版の内容で流すので、option は設定と同じ段 1a で main に入れる。
- check：`implement-core.mjs` の `MAKE_TARGETS`・`REQUIRED_CHECKS` 相当
- commit の後：`afterCommit: push`
- skill-design の観点は設定に書かない。次の「観点の決め方」で扱う。

**3 リポジトリの今の方針文書との突き合わせ（実測）。** gh api で取った `REVIEW.md` を見出しで grep した範囲では、3 つとも「読むもの」「観点」「指摘の基準」「重大度」「出力」を持つ。重大度の名前は 3 つとも CRITICAL・HIGH・MEDIUM・LOW。3 つとも `claude_review.yml` に `exclude-paths` があり、既定ブランチは `main`。今の `review-core.mjs` の `parseReadingTable` に当てると、結果は次のとおりで、そのままでは使えない。
- pk：Markdown のリンクで書いた参照が全て `unparsed` になり、読む文書が 0 件。
- dcf：ディレクトリの無い名前（`rust.md` など）として取れる。5 つとも `.claude/rules/` にある（別の検証役が確かめた）。リポジトリ直下を基点にすると束に入らない。
- develop では、表の解析を Markdown のリンクと `rulesDir` 基点の名前に広げる（dcf は `rulesDir: ".claude/rules"`）。そのうえで、各リポジトリで `policyPack.missing` が空になることを段 2 の完了条件にする。

### 観点の決め方

今は司令塔が `REVIEW.md` を読んで、観点・focus・担当を自由に作っている（`repo-review` SKILL.md「観点と担当」）。develop では、観点を CLI が作る閉集合から選ばせ、立てなければならない観点は `plan` が強いる。閉集合だけでは、どの部分集合を選ぶかが run ごとに変わり、必ず当てるべき観点を落としても通る。
- 閉集合：`REVIEW.md` の「観点」の箇条の太字の名前と、既定の観点の種類の観点（対象に出た種類だけ）。`REVIEW.md` が無ければ既定の観点だけ。CLI が `inventory` で返す。
- 必須の観点：`REVIEW.md` の「観点」の箇条のうち、文に「必ず当てる」を含むもの。CLI が方針の版の `REVIEW.md` から読み、`inventory` で必須として返す（設定に写さない）。箇条が書く適用の条件は散文で CLI には判定できないので、対象が 1 件でもあれば常に必須にする。条件に当たらない run では空振りの費用を払うが、落とす経路は無くなる。claude-plugins では「文書とコードの挙動の一致」がこれに当たる。
- 種類の観点の必須：`REVIEW.md` が無ければ、既定の観点の共通と、対象に出た種類の観点を全て必須にする。`REVIEW.md` があるときに必須にする種類の観点は skill だけ（今の skill-design の検査を引き継ぐため。他の種類は `REVIEW.md` の観点に任せる）。
- 司令塔は、閉集合から観点を選び、担当を付けて `plan` に渡す。focus（その差分で観点ごとに何を見るか）は司令塔が書かず、review-run の最初の段で focus を書く役が書く（「contextual-code-review の置き換え」）。必須の観点が無い計画、閉集合の外の観点、担当の無い対象を、`plan` が拒否する。選ぶ余地が残るのは、必須でない観点だけ。
- skill の観点は、既定の観点の skill（`default-lenses.md` の skill の節）を指す。claude-plugins の `REVIEW.md` の「スキル構造」とは別の観点で、「スキル構造」は「必ず当てる」を含まないので任意になる。両方を立てると同じ規則を 2 体が読むので、司令塔は「スキル構造」を選ばなくてよい。skill の種類（`SKILL.md`、その隣の `agents/*.md`、先頭の文が `export const meta` の `.js`）のファイルは、skill の観点に必ず割り当てる。今の skill-design の観点と同じ検査を、claude-plugins の置き場の glob（`SKILL_DESIGN_TARGETS`・`WORKFLOW_SOURCE_PATHS`）に依らず、ファイル名と内容で行う。
- skill の観点が何を規則に読むかは、`REVIEW.md` の「読むもの」表が決める。claude-plugins の表は、`SKILL.md`・`agents/*.md` と Workflow script の行で best-practices.md の節を挙げている。設定に規則を写さない（写すと表と 2 箇所になる）。best-practices.md は skill-creator plugin のファイルで、develop に作り付けにすると plugin をまたぐパス参照になる（AGENTS.md「plugin 間でスキルは共有できない」）。claude-plugins の作業ツリーにある版を、方針の版で読む。

### 既定の観点（REVIEW.md の無いリポジトリ）

- pr-review の観点（共通・skill・code・specification/prd・document）を `review/references/default-lenses.md` に移す。対象の種類の分類は CLI が決める。pr-review では LLM が分類していたが、develop では固定の規則と `kinds` の宣言で決める。
- 共通の観点は必ず立て、分類に出た種類の観点は全て立てる（pr-review の「分類されたすべての対象別観点を走査する」を引き継ぐ）。
- 重大度の既定は CRITICAL・HIGH・MEDIUM・LOW。3 リポジトリが同じ名前を使うので、develop の中で語彙を 1 つにする。pr-review の blocker・major・minor・nit は引き継がない。
- 重大度の名前は、計画（`plan` の出力）に入れて Workflow source に渡す。今は `review.js` が `REVIEW.md` の写しを持つ（`R:p1-duplicate-claims-2`）。計画から渡せば、写しが要らなくなる。

### 呼び出し側との契約

呼ぶ向きは、address-review → implement → review。address-review は review を直接呼ばない（今の `address-review` SKILL.md「目的と担い手」）。

- implement は review を**スキル呼び出し**で起動し、`caller` と pin の値（baseRef・headSha・policyRef・preservedPaths）を渡す。review はその値を解決し直さない（今の repo-review の前処理の 1 と同じ）。
- `caller` があれば、review は PR に投稿しない。投稿するかどうかは呼び出し側の流れが持ち、委譲先が投稿すると二重の投稿になる（dcf の contextual-code-review の delegation モードと同じ理由）。
- review が起動数の上限で止まって `next_args` を返したとき：implement の `record-review` は、その返り値を記録せず `next: resume_review` を返す。司令塔は同じ `next_args` で review を呼び直し、completed か review_incomplete になった返り値だけを記録する。今の `record-review` が受けるのは completed と review_incomplete だけで、この経路が無い。
- address-review は implement を呼ぶとき、PR の番号と、collect で固定した方針の版の SHA を渡す。今はそれぞれが始めた時点で主ブランチの先端を固定するので、間に主ブランチが進むと別の版で読む（`address-review` SKILL.md「照合しないもの」）。
  - 今の implement が方針の版を入力に取らないのは、作業 branch の規約で同じ変更を免責しないため（`repo-implement` SKILL.md「開始: 状態を固定する」の 2）。
  - その防ぎを残すため、implement の CLI は、照らす先の branch を自分で導く。PR の番号を渡されたら `gh pr view --json baseRefName` の base の branch、PR の無い形で collect が branch を名指していればその branch（remote にあることを確かめる）、どちらも無ければ既定ブランチ（「方針の版は設定に入れず、導く」）。渡された SHA がその branch の remote の先端の祖先（同じを含む）であることを `git merge-base --is-ancestor` で確かめ、違えば拒否する。base が `release/*` の PR でも、照らす先は既定ブランチではなく PR の base になる。作業 branch の commit は base の branch の祖先にならないので通らない。
- 返り値の形（`sum` を含む）は review の Workflow source の schema を正本にし、implement の `record-review` はそれを照合する。同じ plugin の同じ版で配るので、版のずれは起きない。

## 決定で足す流れ

利用者が決めたこと（「決まったこと」）から生まれる流れ。値（待つ回数・待つ間隔など）は core の名前付きの定数に置き、ここには書かない。

### 返信の前に required checks を待つ（決定 4）

address-review の push の後、返信の前に `await-checks` の op を足す。CLI は push した SHA が PR の head であることを確かめ、その SHA の required checks を gh で読む（どの gh の項目で読むかは未確認で、実装で決める）。

| required checks の状態 | `next` | 理由 |
|---|---|---|
| 全て成功 | `recheck`（その後に返信） | 返信の「直した」が CI でも成り立っている |
| 実行中が残る | `wait_and_retry`（今の `NEXT` と同じ待ち方）。回数は CLI が記録から数え、上限は core の定数 | 結果が出る前に返信すると、CI が落ちたときに誤った返信が残る |
| 待つ回数の上限に達した | `resume_checks`。返信せずに止まり、`next_args`（状態の path と sum）を返す | 待ち続けると run が終わらない。同じ周の続きなので、次の run は collect からではなく、同じ `stateDir` の `await-checks` から再開する（下記） |
| 1 件でも失敗 | `report`。失敗した check の名前を返し、返信しない | CI の失敗は指摘ではないので、address-review は直さない。利用者が直すか、次の run の collect から扱う（下記の、push 済みの指摘の扱い） |
| required checks が 1 件も無い | `recheck` | 待つものが無い。代わりの根拠は implement の `verify`（check と review を通った）で、そのことを報告に書く（pk の作り） |

`recheck` の後に head が他の人の push で動いたときは、今の `blocked` の扱い（返信を止め、次の run で扱う）のままにする。

**待ちの上限からの再開。** CLI は、待ちの上限で止まったことと push した SHA を状態に書く。再開の run は `next_args` で `await-checks` だけを流し直せ、分類の受け入れと返信の組み立ては繰り返さない（今の「同じ `stateDir` で 2 回目の分類と返信の組み立てを拒否する」はそのまま）。再開の前に PR の head が push した SHA から動いていれば、`blocked` と同じく止める。再開は何回でもでき、回数は状態に残す。

**push 済みの指摘を、次の run で分類し直したとき。** checks の失敗や head の移動で返信しなかった指摘は、次の run の collect で再び集まる。今の分類の基準では「今の head で既に直っている」は decline になるが、それでは直した問題を「問題ではない」と返信し、resolve の候補からも外れる。そこで次のようにする。
- CLI は collect で、PR の commit のうち指摘より後のものを一覧にして prompt に渡す。
- comment-triager は、今の head で直っている指摘のうち、直したのがその一覧の commit であるものを `fix` とし、`fixed_by` にその SHA を閉集合から選んで返す（decline にしない）。triage-verifier はそれを確かめる。
- CLI は、`fixed_by` が一覧にあり、その commit が `repair_paths` のどれかを変えていることを照らす。
- `fixed_by` のある fix は implement に渡さない（直す変更が無い）。返信は `fixed_by` の SHA を引き、resolve の条件の「修正の commit」には `fixed_by` を使う。

### resolve（決定 3）

返信を確かめた後（`confirm-replies` が通った後）に、`resolve-plan` と `confirm-resolves` の op を足す。CLI が次の条件を全て満たす thread だけを候補にし、GraphQL の mutation の入力をファイルに書く。セッションはそれを `gh api graphql --input <file>` で流す。
- 分類が fix で、`recheck` が `skipped` にしていない（修正の commit で `repair_paths` のどれかが変わった）。
- 修正の commit が、今の PR の head の祖先（同じを含む）。
- その head の required checks が `await-checks` で全て成功している（required checks が無いときは、上の表の最後の行の扱い）。
- その thread への返信が `confirm-replies` で確かめられている。
- thread の議論が `recheck` の snapshot から変わっておらず、まだ resolve されていない（pk の「直前の再取得」）。

fix 以外の扱い：
- decline・out_of_scope：返信するが resolve しない。退ける理由に納得するかは指摘した人が決めることで、こちらが閉じると議論を一方的に終わらせる（pk は decline の根拠を返信した thread も resolve するが、ここは取り込まない）。
- needs_decision・unverified：返信も resolve もしない（今と同じく止まる）。
- issue_comment・review の本文：thread が無いので resolve の対象にならない。

`STOP_AFTER` に `resolve` を足して既定にし、今の `reply` は「返信の後で止まる（resolve しない）」に変える。`scripts/address-skill.test.mjs` の「resolve の経路が無い」照合は、次の 2 つに変える。
- resolve の mutation の文が、CLI の `resolve-plan` の組み立ての 1 箇所にだけある。
- 分類・各条件の成否の組み合わせ（閉じた有限の集合）を全数列挙し、全ての条件を満たす組だけが候補になる（設計方針文書「機械で確かめる」の全数列挙の行）。

### 外のレビュー結果を分類して直す（決定 7）

入口は address-review の collect にする。collect に、PR のコメントの代わりに外のレビュー結果を受ける形（`source: "findings"`）を足す。PR があればその PR を、無ければ次の目標を入口で固定する。
- 目標：差分なら `{baseRef, headSha}`（どちらも完全な SHA）、ファイルなら `{paths, headSha}`。headSha は今の HEAD と同じで、作業ツリーは clean であること（PR の形で head を checkout した clean な作業ツリーを求めるのと同じ。implement が書き込む前の出発点を固定するため）。
- 方針の版：PR があれば PR の base の branch、無ければ既定ブランチの remote の先端（「方針の版は設定に入れず、導く」）。利用者が base の branch を名指したら、その branch の remote の先端。remote に無い branch は `E_PIN` で止める。
- 指摘：利用者が渡すファイル。JSON の一覧（`{path?, line?, body}`。develop:review の返り値もこの形に読める）か、テキスト（全体を 1 件として扱う）。ID は CLI が順序と本文の SHA-256 から決める。司令塔は本文を分けない・書き換えない（分けると、分け方が検証を通らない生成になる）。
- 流れ：分類の Workflow と分類の検証、`decisions` は PR の形と同じ。返信・push・`await-checks`・resolve の段は無い。`STOP_AFTER` は `classify` か `verify` だけを受け、commit は implement の規則（頼まれたときだけ、`afterCommit`）に従う。

address-review を入口にする理由：
- 分類と分類の検証（comment-triager・triage-verifier・CLI の照合・`decisions` の受け渡し）は address-review にだけある。implement に足すと、同じ役を 2 つのスキルに持つか、implement が分類の Workflow を呼ぶことになり、implement が「承認した 1 つの計画を実装する」以外の役を持つ。
- PR の形と PR の無い形で、分類の基準と fix を implement に渡す経路を 1 つにできる。

### git の外の対象のレビュー（決定 2）

既定の入口（description が拾う依頼）では扱わない。利用者が、貼り付けた文書や repo の外のファイルを名指してレビューを頼んだときだけ、review の `external` モードで見る。
- 対象：repo の外のファイルの path か、貼り付けた本文。本文は、セッションが `stateDir` のファイルに逐語で写す（写すだけで、手を加えない）。
- pin：各ファイルの内容の SHA-256。commit は無い。
- 方針：方針の版も方針文書も無い。既定の観点だけで見る。
- 資産台帳：作る。資産はファイルと内容の SHA-256 で、git に依らず CLI が ID を決められる（設計方針文書「資産台帳」の定義に当たる）。
- 結果に必ず書く、見なかったもの：方針文書（方針の版が無い）、除外と生成物の判定、PR への投稿（PR が無い）。
- 検証の 2 段・coverage・skip 一覧は他のモードと同じ。

### contextual-code-review の置き換え（決定 5）

develop:review で置き換え、次を取り込む。
- `pipeline_status`：CLI が `reasons` から決めて返す。completed は success。`coverage_or_limitations`・`verification_incomplete`・`forbidden_reads` だけなら degraded（検証を通った指摘は有効）。`pin_changed`・`carrier_failed`・`cli_rejected` があれば failed（指摘は空）。対応は core の定数に置く。呼び出し側は 1 つの値で「0 件」と「レビューできなかった」を分けられる。
- 除外した指摘を空でも必ず返す：`refuted`・`invalid_findings`・`untrusted_findings` を返り値の schema の必須にする。
- focus を書く役：review-run の最初の段に 1 体置く。選ばれた観点ごとに、その差分で何を見るかを、方針の束の節 ID と対象の path:line を引いて書く。観点を足したり外したりはしない。CLI は、引いた節 ID が束にあり、path が対象にあることを確かめ、合わない focus はその観点の focus を空にして limitations に書く。差分が小さく見えても省かない（dcf の `focus-brief-writer.md` の「常時無条件で呼ばれる」）。今は司令塔が focus を書いていて、司令塔が内容を作らないという役の分担に反する。起動数の上限を渡されたときは、この 1 体も枠に数える。
- dcf の `REVIEW.md` の「金融ロジックで必ず見ること」は「観点」の箇条ではないので、必須の観点の規則に乗らない。段 2 で、dcf がこの節を「観点」の箇条（「必ず当てる」を含む）にするか、「読むもの」表の行にする。

## pr-review・pr-review-fix の機能の行き先

| 元の機能 | develop での行き先 | 失うもの |
|---|---|---|
| pr-review：REVIEW.md の無い対象を汎用の観点で見る | 既定の観点 | 無し |
| pr-review：skill・code・spec・prd・document の分類 | CLI の分類と `kinds` | spec と prd の自動の見分け（宣言が無ければ document に寄る） |
| pr-review：PR への inline comment の投稿が既定 | review に `post` の段を足す。対象が PR で、利用者が直接呼び、「投稿しない」の指定が無いときに投稿する。CLI が確定指摘から本文と位置（head の SHA、path、右辺の `line`、`side`）を組み、セッションが `gh api ... --input <file>` で投稿する。投稿は 2 段の検証の後にだけ置く | 無し |
| pr-review：投稿の照合（`comment_id`・`line`・`original_line`）と `candidate_only` | `confirm-posts` の op（address-review の `confirm-replies` と同じ作り）。行を解決できない指摘は投稿せず `candidate_only` | 無し |
| pr-review：投稿できない環境での Codex の `::code-comment` 形式 | `post` の op が、gh で投稿できないときの出力の形として持つ | 無し |
| pr-review：PR を checkout せずにレビューする | 今の diff モードは、head を checkout した clean な作業ツリーを前提にする（`R:p1-description-alignment-3`）。CLI が `stateDir` の下に headSha の worktree を作り（案。`.git` の worktree の記録が増える）、worker の cwd をその worktree にする（Codex は runner request の cwd、今の callsite は repo を cwd にしている）。native Workflow で agent の cwd を変えられるかは未確認。変えられなければ、prompt に worktree の絶対 path を渡し、全ての path をそこ基点で読ませる | 無し（案が通れば） |
| pr-review：confidence | 票で置き換える。確定には有効な票が要り、確かめられない主張は確定しない | 自己申告の confidence の欄 |
| pr-review：重大度 blocker・major・minor・nit | CRITICAL・HIGH・MEDIUM・LOW（既定の観点の節） | 元の語彙 |
| pr-review：貼り付けた文書・git の外のファイル | 既定の入口では扱わず、利用者が明示したときだけ review の `external` モードで見る（「git の外の対象のレビュー」） | 方針文書による観点、投稿 |
| pr-review-fix：入力のレビュー結果を confirmed・rejected・unverified に分けてから直す | develop:review の結果は確定済みなので、そのまま implement に渡せる。外のレビュー結果は、PR があってもなくても address-review の分類と分類の検証に通す（「外のレビュー結果を分類して直す」） | 無し |
| pr-review-fix：plan だけを作る | implement に `stopAfter: "plan"` を足す（address-review の `STOP_AFTER` と同じ形）。止まるのは受け入れの後で、承認済みの計画は状態にある。続けるときは、返した `next_args`（状態の path と sum、計画と sum）で implement を呼ぶ。CLI は作業ツリーが受け入れの時から変わっていないことを snapshot で確かめ、開始時の check から続ける | 無し |
| pr-review-fix：apply・verify | implement の実装の回、check、review | check を宣言していないリポジトリでは修正できない（設定が merge されるまで） |
| pr-review-fix：確定した指摘だけ直す、未検証の重い指摘で止まる | implement は、確定指摘だけを券に載せる。未検証が残れば `abandon` | 無し |
| pr-review-fix：resolved・remaining・new の分類 | 最後の review の結果（remaining・new に当たる）と修正の回数を報告する。前の指摘が直ったかを run をまたいで追うことは、設計方針文書の未決事項（run をまたぐ指摘の追跡）に依る | resolved の判定 |
| pr-review-fix：`@login` を API から取って `in_reply_to` で返信する | address-review の `recheck`（返信の endpoint と本文を CLI が組む）と `confirm-replies` | 無し |

## 3 リポジトリから取り込む仕組み

| 仕組み | 出所 | develop での置き場 |
|---|---|---|
| 状態を `stateDir` の外部ファイルに持ち、sum で写し間違いを止める | claude-plugins（3 スキルの CLI） | 3 スキル |
| 実装の回を券で開け閉めする。段ごとの作業ツリーの snapshot、`abandon` | claude-plugins `repo-implement` | implement |
| check を固定の argv で流し、開始時の結果と比べて変更が起こした失敗だけを直す | claude-plugins `repo-implement`（pk の `ALLOWED_CHECKS` も同じ考え） | implement と `checks` の宣言 |
| 条件ごとのケース計画と `expected_basis` | claude-plugins `repo-implement` | implement（基準は `testDesignGuide`） |
| `no_change` と `needs_replan`（確定指摘が計画の外を指す） | pk の implement、claude-plugins にも同じものがある | implement |
| 方針の版を固定し、PR が変えた規約はデータとして読む | claude-plugins と pk（両方の SKILL.md） | 3 スキル |
| 方針の束を 1 回だけ作り、全ての役に同じ版を配る | claude-plugins `repo-review` | review |
| 観点ごとの reviewer、2 段の検証、見ていないもの（除外・生成物・未読）の宣言 | claude-plugins `repo-review` | review |
| 分類役と検証役が食い違ったら止まる。返信の直前の再照合と投稿の確認 | claude-plugins `address-review` | address-review |
| 条件を満たした thread だけを resolve する（修正が PR の head にあり、required checks が成功し、返信を投稿したもの） | pk の address-review（SKILL.md「commit、push、返信、resolve」の表）。claude-plugins の `scripts/address-skill.test.mjs` は、条件の外の resolve が無いことの照合に変える | address-review（「resolve」） |
| push の後、required checks の成功を待ってから返信する | pk の address-review | address-review（「返信の前に required checks を待つ」） |
| 全ての CLI の出力（拒否も）が `next` を持つ | claude-plugins `address-review`（`NEXT`・`NEXT_BY_CODE`）。dcf の BLOCKED に `reason`・`evidence`・`next_action` を付ける作りも同じ考え | implement と review の CLI にも広げる |
| agent が見た HEAD を返し、script が pin と照らす | pk の implement、claude-plugins にも同じものがある | 3 スキル |
| 0 件と「レビューできなかった」を分け、`pipeline_status`（success・degraded・failed）で返す | dcf の contextual-code-review、claude-plugins の `review_incomplete` も同じ考え | review（「contextual-code-review の置き換え」） |
| 除外した指摘を空でも必ず返す（`excluded_findings`） | dcf の contextual-code-review | review の `refuted`・`invalid_findings`・`untrusted_findings` を schema の必須にする |
| 差分に固有の focus を、方針の文書の見出し・行を引いて別の役が書く（focus brief） | dcf の contextual-code-review（`agents/focus-brief-writer.md`） | review-run の最初の段（「contextual-code-review の置き換え」） |

### 取り込まないもの

| 仕組み | 出所 | 理由 |
|---|---|---|
| `make tree-sha` による作業ツリーの同一性の確認 | pk | CLI の snapshot が同じことを Makefile に依らずに行う |
| 複数のレビューエンジン（codex・open-code-review・`/code-review`・Fable）と、落ちたときの切り替え | dcf magi | 別の plugin や外部の道具に依存し、配布先で揃う保証が無い。票の独立と起動数の記録が script の外に出る |
| 委譲されないとき（direct モード）の投稿の前に、利用者の承認を求める | dcf の contextual-code-review | pr-review の既定（PR が対象なら投稿する）を引き継ぐ。承認を挟むと、pr-review から吸収した既定が変わる |
| 既存の欠陥の露出を、Issue（`review-deferred`）として起票する | dcf magi | 「正しいが独立」は address-review の `out_of_scope` が受ける。Issue 化で完了を先送りしない（AGENTS.md「作業ルール」） |
| 振り返りの改善案を、その場でスキルに適用する | dcf magi | スキルの改善は bp の update の役割で、run の中で自分を書き換えない |
| `[SKILL_DELEGATION ...]` の見出しで呼び出しの種類を分ける | dcf | 文の見出しの照合ではなく、args の `caller` で分ける（構造で分けられるので） |
| `resumeFromRunId` による relaunch | dcf magi | 設計方針文書「停止・再開と人間の入力」は relaunch を使わず、状態から新しい run を起動する |
| 変更ファイルの数え上げのための専用の script | dcf `changed_files.py` | CLI が git を argv で呼んで数える。dcf の script は、同リポジトリの Bash hook が出力を汚す問題への対処 |

## bp 計測から導いた差分

計測：3 スキルに bp review（scope full。snapshot の verify は 3 つとも verified）。確定 0 件。棄却 19 / 26 / 21 件、minor 30 / 23 / 20 件（repo-implement / repo-review / address-review の順）。finding id は 3 スキルで重なるので、`I:`（repo-implement）・`R:`（repo-review）・`A:`（address-review）を頭に付けて引く。

**読み方。** bp review は、今のスキルの宣言に照らして測る。3 スキルは「yoshiysh/claude-plugins 専用」と宣言しているので、反証役は専用の直書きを「宣言どおりで欠陥ではない」として棄却した。この文書は、その棄却群を一般化の作業項目として読む。develop は汎用と宣言するので、同じ指摘は直さなければ確定に変わる。棄却群は次の 3 つに分けて読む。
- 一般化の項目
- 設計方針への適合の欠け
- どちらにも当たらないもの

### 一般化の項目

| 主題 | finding id | 解消する設計判断 |
|---|---|---|
| 名前・description が専用 | I:p1-description-alignment-1・2、I:p1-best-practices-1、I:p1-prompt-audit-1、R:p1-description-alignment-1、R:p1-best-practices-2、A:p1-description-alignment-1・2、A:p1-best-practices-1。minor の I:p1-best-practices-8、R:p1-prompt-audit-1、A:p1-prompt-audit-4 | `develop:*` の名前と、汎用の description。trigger evals を取り直す |
| 主ブランチを `origin/main` に固定 | I:p1-loopholes-2、R:p1-why-driven-6、R:p1-script-vs-prose-1・2、R:p1-loopholes-6、R:p1-prompt-audit-3、A:p1-script-vs-prose-3、A:p1-loopholes-2 | 方針の版を CLI が導く（「宣言する設定」の、方針の版を導く段落） |
| 対象リポジトリを定数で持つ | A:p1-script-vs-prose-1、A:p1-duplicate-claims-5、A:p1-loopholes-1、A:p1-best-practices-2 | `gh repo view` から導き、定数 `REPOSITORY` を消す |
| 方針文書の名前と場所を直書きし、無いときの経路が無い | I:p1-script-vs-prose-5、I:p1-duplicate-claims-8、I:p1-prompt-audit-3、I:p1-best-practices-3、R:p1-loopholes-5・7、R:p1-description-alignment-4、R:p1-best-practices-1、A:p1-script-vs-prose-2、A:p1-duplicate-claims-4、A:p1-best-practices-3、A:p1-description-alignment-3。minor と declared_only の I:p1-best-practices-4、I:p1-prompt-audit-4、R:p1-prompt-audit-4、A:p1-prompt-audit-1・2・3、R:p1-script-vs-prose-8、implementer.md と review.js の D | `reviewPolicy`・`rulesDir` の宣言と既定の観点。prompt は文書名を持たず、計画に入った方針の束の節 ID だけを指す |
| check が Makefile と `make test` 固定 | I:p1-loopholes-1、I:p1-best-practices-2、R:p1-why-driven-5。minor の I:p1-prompt-audit-5、R:p1-prompt-audit-5 | `checks` の宣言。既定を置かずに止める |
| 除外と生成物の置き場を固定 | R:p1-duplicate-claims-5、R:p1-script-vs-prose-7。minor の R:p1-prompt-audit-2・p1-why-driven-4 | `excludePaths`・`generated` の宣言 |
| 重大度を `REVIEW.md` から写す | R:p1-script-vs-prose-6、R:p1-duplicate-claims-2、R:p1-best-practices-5 | 重大度を計画に入れて渡す |
| skill-design の観点を best-practices.md に固定 | R:p1-best-practices-3、R:p1-description-alignment-2 | 観点の決め方（skill の種類の観点、規則は「読むもの」表） |
| 兄弟スキルが入っていない環境 | I:p1-loopholes-3、I:p1-best-practices-6、I:p1-prompt-audit-2、A:p1-loopholes-3、A:p1-best-practices-4 | 同じ plugin に入れる |
| commit と push の規則を AGENTS.md に結合 | I:p1-loopholes-5、push の D | `afterCommit` の宣言と、導いた remote。push の argv は CLI が出す |
| PR のレビューに head の checkout が要る | R:p1-description-alignment-3 | CLI が headSha の worktree を作る（「pr-review・pr-review-fix の機能の行き先」） |
| model・effort の根拠が AGENTS.md を指す | minor の I:p1-best-practices-5、triage.js の D | 根拠を設計方針文書「モデル・effort・prompt」と eval の記録に置き換える |
| 他人の PR・fork の PR への push | A:p1-loopholes-5 | collect で head に push できるかを確かめ、できなければ fix を needs_decision にして止める（gh で取れる項目は未確認） |
| 写しの一致の検査が配布物の外 | minor の A:p1-best-practices-6、address-core.mjs の D、A:p1-duplicate-claims-3、R:p1-duplicate-claims-4 | 一致の照合を各スキルの `scripts/*.test.mjs` に移す。模擬実行は直下の `tests/` に残す |
| eval が claude-plugins の PR 番号に依存 | minor の A:p1-best-practices-7 | fixture に置き換え、汎用の対象で測る |
| 返信が日本語に固定 | minor の A:p1-loopholes-8 | `outputLanguage` の設定（決定 6） |

### 設計方針への適合の欠け

棄却の理由は「実害が小さい」だったが、設計方針文書の原則に照らすと欠けているもの。

| finding id | 欠けている原則 | 設計判断 |
|---|---|---|
| R:p1-best-practices-6 | 「資産台帳」の skip 一覧からの追加起動（PR-013） | review の資産台帳（「形の判定」） |
| R:p1-script-vs-prose-4、minor の R:p1-best-practices-8 | 「体数と同時実行」（PR-008・021）と、起動したモデルの記録 | 起動数の上限の節 |
| I:p1-script-vs-prose-2、I:p1-loopholes-4、R:p1-loopholes-3、minor の I:p1-script-vs-prose-4・R:p1-script-vs-prose-5 | 散文の分岐（どの失敗を先に扱うか、reasons の優先）。「停止・再開と人間の入力」の、止まった理由と次の手を構造で返すこと | 全ての CLI が `next` を返す |
| X の I:p1-unchecked-verifier-before-mutation | 検証を状態変更の前に置く | 作業ツリーへの書き込みは implement の役目そのもので、永続化（commit・push）と PR への投稿は `verify` と 2 段の検証の後に置く。review の `post` も同じ |

### どちらにも当たらないもの（別枠）

一般化と関係しない。develop を作る update の中で直すが、構成は変えない。

- **理由の無い禁止（why-driven）**：I:p1-why-driven-1〜8、R:p1-why-driven-1・2・3・7・8、A:p1-why-driven-2〜6。棄却の A:p1-why-driven-1 も同じ種類。「守らないと何が壊れるか」を添える（AGENTS.md「作業ルール」の規範の書き方）。
- **SKILL.md が script の中身を散文で繰り返す**：I:p1-duplicate-claims-4・5・7、R:p1-best-practices-4、R:p1-duplicate-claims-3・6、A:p1-duplicate-claims-6、I:p1-duplicate-claims-2。正本の定数と schema を指す 1 文にする。
- **散文に残った決定的な手順**：I:p1-script-vs-prose-1・3・6、R:p1-script-vs-prose-3、A:p1-script-vs-prose-4・5・6。CLI の op が argv と次の手を出す。
- **入口と停止の細かな穴**：I:p1-loopholes-6・7・8、R:p1-loopholes-1・2・4・8、A:p1-loopholes-4・6・7。
- **description と本文のずれ**：I:p1-description-alignment-3・4・5、R:p1-description-alignment-5・6、A:p1-description-alignment-4。
- **run の前にそろえる許可が書かれていない**：R:p1-best-practices-7、A:p1-best-practices-5。「権限」の節で扱う。
- **字面の複製**：I:p1-duplicate-claims-1、R:p1-duplicate-claims-1、A:p1-duplicate-claims-1・2。「ファイルの置き場」の、共有の処理を 1 箇所にする段落で扱う。minor の I:p1-duplicate-claims-6（`ROLE_MODELS` が 2 本の source にある）は、役ごとに起動する source が 1 本だけになるので、複製ではない。

### 委譲項目（X）

- description-triggers（3 スキル）：description が変わるので、trigger evals を develop の description で取り直す。段 3 までは、`workflow:pr-review` と `workflow:pr-review-fix` との取り合いの負例も入れる。
- reference-consistency（I・R）：SKILL.md が指す定数の名前が、core と source に実在するかを `check_references.py` と core のテストで確かめる。

## 移行計画

| 段 | 作業 | 完了条件 | 壊れるもの |
|---|---|---|---|
| 0. bp の判定の模型を改める（claude-plugins） | 決定 8 (i) で、1 つのスキルが run の並びの形と各 run の形を持てるようになった。今の bp は、形の問いを A・Q1・Q2・Q3 の閉集合で持ち、1 つのスキルに 1 つの形（最初に到達した形）を付ける。下の作業で、判定の単位を「スキル」から「run の並びと各 run」に改める。仕様は prd-spec で改稿し、CLI とテストは実装で直す。改稿の後に `tools/sync-bp-criteria.mjs` で写しを同期する | 下の閉集合の全てに問い W が入り、W が「はい」のスキルで、run の並びと各 run の形が別々に判定される。`make test` が通る。W が「いいえ」の既存のスキルに bp review をかけ、判定が改稿の前と変わらない。W が「はい」の fixture（今の `repo-implement` の構成）で、run の並びが固定集合の反復型、各 run が固定パイプライン型（計画は＋until-pass）と判定される | 2a06b44 で設計方針文書（W あり）とその写しを同期した時から段 0 が終わるまで、配布される bp の中で、設計方針の写し（W あり）と仕様の写し・CLI（W なし）が食い違う。その間の bp は、develop:implement のような W が「はい」のスキルを 1 つの形で判定するので、PR-001・002 の判定は当てにならない |
| 1a. 設定を先に入れる（claude-plugins） | claude-plugins の設定ファイルと、`tools/sync-bp-criteria.mjs` に書き先を出力する option を、develop:implement の外で 1 つの PR にして main に merge する。develop が無い間は誰も読まない | main に設定と tool の option があり、設定がこの文書の形で書かれている（schema の検査は 1b で通す）。option の出力が今の `readGeneratedPaths` の結果と一致する | 無し（tool に option が増えるだけ） |
| 1b. develop を作る（claude-plugins） | `.agents/skills/` の 3 つを改名して一般化する（この文書を前段に要求を起こし、bp update で改稿する）。3 本のテスト `tests/repo-implement-workflow.test.mjs`・`tests/repo-review-workflow.test.mjs`・`tests/address-review-workflow.test.mjs` を、一致の照合（各スキルの `scripts/*.test.mjs` へ移す）と模擬実行（直下の `tests/` に残す）に分ける。`tests/workflow-callers.test.mjs` の名前の callsite の区分の一覧に 4 本を足す。`scripts/address-skill.test.mjs` を「resolve」の節の 2 つの照合に変える。manage-marketplace-plugin で plugin `develop` を作って 3 つを登録する（Workflow source は `workflows/` に移り、callsite は名前の呼び出しになる） | `make test` が通る。段 0 で改めた bp で、bp review（scope full）の確定 0。棄却の理由に「専用と宣言している」を挙げるものが 0 件（理由の文を grep して数える）。`verify_install.py --plugin develop` が通る。evals と trigger evals を測る。claude-plugins の PR で address-review を 1 周（required checks の待ちと resolve まで）、PR の無い差分で外のレビュー結果の形を 1 周、develop:review を上限つき（Codex runner）と上限なし（native）で 1 回ずつ流す。設定と tool の option は 1a で main にあるので、1b の merge の前に、checkout の scriptPath で流せる | claude-plugins で `repo-*` の名前を使う依頼（公開前なので、このリポジトリだけ）。段 3 までの発火の取り合い：`workflow:pr-review` と `develop:review`、`workflow:pr-review-fix` と `develop:implement`・`develop:address-review` |
| 2. pk・dcf の写しを消す | 各リポジトリで、設定を足す PR を先に merge する。pk：`REVIEW.md` の表が読めることを確かめ、`.agents/skills/{implement,review,address-review}` と参照を消す。dcf：`rulesDir` を宣言し、`REVIEW.md` の「金融ロジックで必ず見ること」を必須の観点か「読むもの」表の行にする。`.agent/skills/contextual-code-review` を消し、magi の `scripts/issue-resolve.js` のレビューエンジンの一覧と、SKILL.md「構造として保証されるもの」の重いレンズの起動の条件から contextual-code-review を外す（magi の Workflow の中からは develop:review を呼べない前提。「結論と範囲」）。magi の他の段は変えない。利用側（dcf）で決めること：magi の重いレンズから contextual-code-review が抜けた分を、Fable だけで足りるとするか、magi の Workflow が返った後にセッションが develop:review を呼ぶ形に magi を組み直すか。develop が約束するのは、develop:review をセッションからスキル呼び出しで呼べること（「呼び出し側との契約」）と、返り値の契約（`pipeline_status` の三値・除外した指摘を空でも必ず返すこと・確定した指摘の一覧。「contextual-code-review の置き換え」）だけ | 各リポジトリで、旧名（pk の 3 スキル、dcf の contextual-code-review）の参照が grep で 0 件。develop:review を 1 回流し、`policyPack.missing` が空で、dcf では金融ロジックの観点が必須として立つ | pk で旧名を使う依頼。dcf で contextual-code-review を呼ぶ依頼と、magi の重いレンズ（contextual-code-review の分が抜け、Fable だけが残る） |
| 3. workflow の 2 スキルを廃止 | `plugins/workflow/skills/pr-review`・`pr-review-fix` と `.agents/skills/` の symlink を消す。参照を直す（`README.md:13`、`plugins/workflow/README.md:12-13`、`.agents/skills/manage-marketplace-plugin/tests/test_marketplace_safety.py:108`・`test_path_safety.py:59` の例の名前）。develop の trigger evals から、2 スキルとの取り合いの負例を外す。workflow の version を上げる | 下記の grep の条件を満たす。`make test` と `verify_install.py --plugin workflow` が通る | `/workflow:pr-review` と `/workflow:pr-review-fix` を呼ぶ利用者（not found になる） |

- `.agents/skills/repo-implement/SKILL.md:13` と `.agents/skills/address-review/SKILL.md:10` の `workflow:pr-review-fix` への案内は、段 1b の一般化で書き直すので、段 3 を待たずに消える。
- 参照の洗い出しは、`grep -rln "pr-review"`（`.git`・`node_modules` を除く）で見た範囲。上の一覧の他に当たるのは 2 件で、どちらも別物。
  - `plugins/research/skills/search/evals/evals.json:48` の `caller=pre-pr-review`
  - `.claude/settings.json:125` の `pr-review-toolkit@claude-plugins-official`
- 段 3 の完了の grep は、この 2 件とこの文書（`docs/design/develop-plugin.md`。経緯として 2 スキルの名前を持つ）を除いて 0 件になることにする。develop の trigger evals の負例は、段 3 で外すので除外に入れない。
- `plugins/workflow/.codex-plugin/plugin.json` の description は pr-review に触れていない（grep で確かめた）。
- 既存の plugin からスキルを外す操作を manage-marketplace-plugin が扱うかは未確認。同スキルの description が対象外に挙げるのは、marketplace.json の閲覧のみ・アンインストール・公開済み plugin の削除・スキル本体の作成と編集で、スキルを外す操作には触れていない。扱わないなら、外す作業と両方の catalog の同期を手で行い、`verify_install.py` で確かめる。
- 段 1b の試走は、`Workflow({ scriptPath: "<checkout の絶対パス>/plugins/develop/workflows/<f>.js" })` で起動し、CLI も checkout の path で流す。名前で起動すると、install 済みの旧版が走るか not found になる（AGENTS.md「作業ルール」）。試走が読む方針の版（main）には、1a で設定と tool の option が入っている。

**段 0 で直す箇所。** 形の問いの閉集合と、1 つのスキルに 1 つの形という前提を持つ所（検証役が挙げたものを、grep で確かめた範囲）。
- 仕様：`docs/specifications/bp-conformance.md` の用語の表（問い A・Q1・Q2・Q3、重い形）と SP-BPCONFORMANCE-003・004（形は最初に到達した 1 つ）、`docs/specifications/bp-inspection.md:109`・`:113-121`（受理する並びの表）、`docs/specifications/bp-run.md:593`（applicability の schema の `shape` が 1 つの値）、`docs/specifications/bp-authoring.md:168`・`:571`。
- CLI と script：`plugins/skill-creator/skills/skill-creator-best-practices/scripts/bp/constants.mjs:270` の `APPLICABILITY_QUESTIONS`、同 `scripts/bp_inspect.js:65` の写し、`scripts/bp/applicability.mjs`。
- テスト：`applicability.test.mjs:16`、`ops-inspect.test.mjs:274`、`APPLICABILITY_QUESTIONS` を読む `tests/bp-inspect-static.test.mjs`・`tests/bp-spelling.test.mjs`。
- 写し：`plugins/skill-creator/skills/skill-creator-best-practices/references/criteria/` の仕様の写し（同期の tool で更新する）。
- 判定の模型の改め方（判定の単位を run の並びと各 run の組にする、`shape` を単位ごとの一覧にする）は、段 0 の要求・仕様で決める。この文書は改める必要と範囲だけを置く。

**検証の担い手。** 生成と検証を分ける。改稿は bp update の builder が行う。合否は、決定的なテスト（`make test`）、bp review、生成者と別の fresh な監査が持つ。司令塔は改稿しない。
- bp review は段 1b の終わりと、各段で develop を直した後に毎回かける。
- evals は with_skill と baseline を比べる。
- trigger evals の負例に入れるもの：`workflow:review-document`、skill-creator-best-practices。段 3 までは `workflow:pr-review`・`workflow:pr-review-fix` も入れる。

## 決まったこと

利用者が決めたことと、反映した節。

| # | 決めたこと | 反映した節 |
|---|---|---|
| 1 | 設定ファイルは `develop.config.json` | 「宣言する設定」 |
| 2 | git の外の対象（貼り付けた文書）は、既定では扱わず、指定されたときだけレビューする | 「git の外の対象のレビュー」、「pr-review・pr-review-fix の機能の行き先」 |
| 3 | thread を resolve してよい（条件つき） | 「resolve」、「3 リポジトリから取り込む仕組み」、「権限」、移行計画の段 1b |
| 4 | 返信は required checks の成功を待つ | 「返信の前に required checks を待つ」（待ちの上限からの再開、push 済みの指摘の扱いを含む）、「3 リポジトリから取り込む仕組み」 |
| 5 | dcf の contextual-code-review は develop:review で置き換え、有用な仕組みは取り込む | 「contextual-code-review の置き換え」、「3 リポジトリから取り込む仕組み」と「取り込まないもの」、「結論と範囲」、移行計画の段 2 |
| 6 | 返信などの言語は日本語を既定にし、`develop.config.json` で変えられる。agent の内部の作業の言語は問わない | 「宣言する設定」の出力の言語、bp 差分の表 |
| 7 | PR の無い対象への外のレビュー結果も、分類と分類の検証に通す | 「外のレビュー結果を分類して直す」、「pr-review・pr-review-fix の機能の行き先」 |
| 8 | 設計方針文書の (i) 「形の判定」に権限の分離で run を分ける場合を足し、(ii) 「資産台帳」の skip 一覧の行を直す | `docs/design/skill-design-patterns.md` の「形の判定」（図・原則の表・例の着地の表）と「資産台帳」の skip 一覧の行。この文書の「形の判定」、移行計画の段 0 |

決めたことから生まれた作業：
- 決定 8 (i) で、1 つのスキルが複数の形を持てるようになり、bp の判定の模型（形の問いの閉集合と、1 つのスキルに 1 つの形）を改める必要が出た。移行計画の段 0 に置き、範囲は同じ節の「段 0 で直す箇所」に書いた。段 0 が終わるまで、配布される bp の中で設計方針の写しと仕様の写し・CLI が食い違う。
