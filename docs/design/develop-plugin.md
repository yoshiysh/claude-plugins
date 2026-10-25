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
- [pr-review・pr-review-fix の機能の行き先](#pr-reviewpr-review-fix-の機能の行き先)
- [3 リポジトリから取り込む仕組み](#3-リポジトリから取り込む仕組み)
- [bp 計測から導いた差分](#bp-計測から導いた差分)
- [移行計画](#移行計画)
- [未決事項](#未決事項)

## 結論と範囲

- 土台は claude-plugins の `repo-implement`・`repo-review`・`address-review`（`.agents/skills/` の未公開の実体）にする。CLI と `stateDir` で状態を持ち、sum で写し間違いを止め、検証役を生成役と別の context に置く作りは、3 リポジトリの中でこれだけが持つ（出所は「3 リポジトリから取り込む仕組み」）。
- 今の役の分担・段・照合は残す。変えるのは 2 種類だけ。
  - claude-plugins に固有の値の直書きを、利用側リポジトリの宣言と導出に移す（「利用側リポジトリとの契約」）。
  - 一般化と設計方針への適合に要る段・op を足す。足すのは、投稿と投稿の確認、上限で止めるための未着手の記録と再開、skip 一覧からの追加起動、PR の head の worktree、`stopAfter: "plan"` とそこからの再開、外のレビュー結果の分類。どれも本文の該当節に書く。
- 3 スキルは同じ plugin に入れる。implement は review の返り値を厳密に照合し、address-review は implement に修正を渡す。別々の plugin にすると、相手の版がずれたときに照合が壊れる。

| 共通化するもの（develop が持つ） | 利用側リポジトリに残すもの |
|---|---|
| 段の順序、CLI の照合（状態・券・snapshot・pin・coverage・票の集計・返信の再照合）、役の prompt（`agents/*.md`）、Workflow source、既定の観点 | 方針文書（`REVIEW.md` とその「読むもの」表が挙げる文書）、check の許可リストと必須 check、除外と生成物の置き場、commit 後の push の要否 |
| 役ごとの model・effort（Workflow source の `ROLE_MODELS`） | 領域の観点（dcf の金融ロジック・Rust、pk のコーパス保護）。どれも各リポジトリの `REVIEW.md` に書く |

**dcf の magi-issue-resolver は対象外にする。** Issue の選定から PR-ready・振り返りまでを 1 本の Workflow（`.agent/skills/magi-issue-resolver/scripts/issue-resolve.js`）で回すもので、実装・レビュー・指摘対応に分かれていない（dcf の SKILL.md を gh api で読んで確かめた）。「develop:* を呼ぶ側になる」という見立ては、条件つきでだけ成り立つ。
- develop:implement と develop:address-review は、セッションが CLI を shell で流し、Workflow を段ごとに別の run で起動する作り。Workflow の中の agent から別の Workflow を起動できるかは未確認で、Codex runner は入れ子の workflow を持たない（`plugins/workflow/skills/dynamic-workflow-runner/scripts/runtime/README.md` の未実装の一覧）。magi の Workflow の中から develop:* は呼べない前提で考える。
- magi が develop:* を呼べるのは、run の境界（magi の Workflow が返った後に、セッションが次のスキルを起動する所）だけ。magi をその形に組み直すかは dcf の判断で、この構成案の範囲の外に置く。dcf の contextual-code-review の扱いは「未決事項」に置く。

## plugin の構成

### スキル

| 呼び出し | ディレクトリ（実体名） | 元 | 担うこと |
|---|---|---|---|
| `develop:implement` | `implement` | `repo-implement`・pr-review-fix の apply と verify | 計画 → 計画のレビュー → 実装 → check → review → 上限つきの修正 → 最終照合 |
| `develop:review` | `review` | `repo-review`・pr-review | 観点ごとの reviewer → 統合 → 2 段の検証 → 結果。PR が対象なら投稿 |
| `develop:address-review` | `address-review` | `address-review`・pr-review-fix の分類と返信 | 指摘の収集 → 分類と分類の検証 → implement に修正を渡す → 返信 → 投稿の確認 |

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
- Codex での起動の区分は、今の各 callsite のものを引き継ぐ。`implement-run` だけが workspace-write、他は read-only。runner request の `requirements` は source の `meta` をそのまま使い、`ROLE_MODELS` の全ての model 名に `modelMap` を明示する。`review-run` の `limits` だけは「起動数の上限」の節で決め直す。
- 透過実行 route の定型文は、今の `repo-implement` の SKILL.md では 2 つの callsite にほぼ同じ文で 2 回書かれている（`I:p1-script-vs-prose-7`・`I:p1-duplicate-claims-3`・`I:p1-best-practices-7`。`repo-review` と `address-review` は callsite が 1 つで 1 回）。develop では各 SKILL.md に 1 回だけ書き、callsite ごとの違い（前処理・成功後処理・区分）は表にする。
- callsite を名前の呼び出しに変えると、`tests/workflow-callers.test.mjs` の、名前の callsite ごとの区分の一覧に 4 本を足す必要がある。足さないと `make test` が落ちる。

### 権限（PR-010・014・015）

| host | 読み取り専用を何が強いるか | 残る危険（結果に書く） |
|---|---|---|
| Codex runner | run ごとの `requirements`。`implement-run` だけを workspace-write にし、他の run は read-only | runner は agent ごとの道具の許可を持たない（runtime README の未実装の一覧）。同じ run の中の役は分けられない |
| Claude Code の native Workflow | 何も強いない。permission rules は全ての subagent に同じく効く（設計方針文書「権限」） | planner・reviewer・検証役・分類役の書き込みは止められない。事後に検出するだけ（implement は段ごとの snapshot、review は pin、全ての役は返した `head_sha` の照合） |

- 各 SKILL.md には、run の前に利用者が許可しておくものを書く。node と git の実行、gh の読み出し、`stateDir` への書き込み。address-review と review の投稿では、gh の POST も要る。許可が無いと、長い run の途中で確認が出て止まる（`R:p1-best-practices-7`・`A:p1-best-practices-5`）。
- 役の prompt は `agents/*.md` をパスで読ませる。subagent の frontmatter の制限は使わない。plugin から読む agent では frontmatter の一部が無視されるので、そこに頼ると配布先で黙って効かない。
- 「残る危険」の列の内容は、各スキルの結果に毎回書く（PR-015）。

### 起動数の上限（PR-016・017・019〜023）

fan-out を持つ Workflow source は `review-run` だけ。今の 4 本を `parallel(`・`pipeline(` で grep した範囲では、呼んでいるのは `repo-review/scripts/review.js` だけ（reviewer の段と検証の段）だった。plan・implement・triage は agent を順に起動するので、これらの要求は当たらない。

| 要求 | review-run での形 |
|---|---|
| PR-016 受け取り | args に起動数の上限を取る。値の検査（不正・最小に満たない値）は `docs/specifications/bp-run.md` の起動数の上限の規則に合わせる |
| PR-021 渡されないとき | 今の固定の上限（`review.js` の `MAX_REVIEWERS`）を外す。観点の数を決め打ちしない。超えたら観点をまとめるという SKILL.md の指示も消す |
| PR-017・019 渡されたとき | 項目を起動する前に残りの枠を数える。運搬役も起動数に数える（今の `review.js` の `meta.limits` の式が運搬役の段と試行の回数を含めている）。そのため枠からは、項目の分に加えて、その後に要る運搬役の分と、未着手を書く運搬役の試行の分を先に取っておく。取っておけない項目は、順位つきの未着手として `stateDir` に書いて止まる。順位は観点の順、同じ観点の中では担当の順（`docs/specifications/bp-inspection.md` の review の項目の順位と同じ決め方） |
| PR-020 再開 | 止まった run は `next_args`（計画の path と sum、状態の path）を返す。次の run は未着手の項目から続け、結果のある項目を処理し直さない。pin が崩れていたら再開せず計画からやり直す |
| PR-022・023 起動の経路 | Codex runner で起動するときだけ上限を渡す。native Workflow では渡さない |

**上限の値の置き場。** 今は `meta.limits.maxAgents` を `MAX_REVIEWERS` から導き、その式を `tests/repo-review-workflow.test.mjs` が照らしている。`MAX_REVIEWERS` を消した後は次のようにする。
- runner の天井の値は source の `meta.limits` に置かず、review の CLI に 1 つだけ置く。Codex の callsite は CLI の出力から、runner request の `limits.maxAgents` と args の上限の両方を入れる。
- bp の作りに合わせた形。bp の `workflows/*.js` は `limits` を持たない（grep で 0 件）。runner の天井は `plugins/skill-creator/skills/skill-creator-best-practices/scripts/select_runtime.js` の `RUNNER_LIMITS` にあり、source の側は天井に収まる上限を自分の定数で持つ（`plugins/skill-creator/workflows/review_skill.js` の `MAX_UPDATE_ROUNDS` の注記）。
- source の `meta.limits.maxAgents` に値を置くと、native Workflow がそれを強いる場合に、上限を渡さない run の固定の上限になり、PR-021 とぶつかる。native が `meta.limits` を読むかは未確認（`review.js` の注記は runner だけが読むとしている）。
- 導出式のテストは、直下の `tests/` の模擬実行のテストに置き換える。上限を渡した run が上限を超えて起動せず、未着手を順位どおりに書いてから止まることを確かめる。

**今の review に無く、新しく要る部品。** 今の `stateDir` が持つのは計画と方針の束だけ。
- 段の結果を状態に書く op。reviewer の返り値と coverage、検証の票を、段ごとに運搬役が CLI で書く（冪等。設計方針文書「状態の書き込み」）。これが無いと、再開した run は結果のある項目を見分けられず、処理し直す。
- 未着手を書く op。
- 再開の入口（`next_args` を受け取る前処理）。

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
| `review-run` | 戻りが無い（2 段目の検証は、1 段目で決着しなかった主張に当てる段で、戻りではない） | 固定パイプライン型＋観点ごとの検証・反証の部品 | 持つ（PR-005。下記） | — |
| `address-review-triage` | 戻りが無い（食い違えば止まる） | 固定パイプライン型（分類 1 体 → 検証 1 体） | 持たない（全件を 1 つの context で読み、fan-out しない。PR-018） | — |
| address-review の外側 | 収集 → 分類 → 修正 → 返信。needs_decision は run の境界にし、次の run で `decisions` として入れる | 固定パイプライン型（1 run は 1 周） | 持たない | — |

- implement の外側は、人間の入力ではなく権限の分離で run に分かれている。設計方針文書の図にはこの分岐が無いので、ここに条件として書く（図に足すかは「未決事項」）。
- 外側の並びで段を選ぶのは司令塔（スキルを読むセッション）の仕事（AGENTS.md「作業ルール」の、段の選択の項）。選ぶ材料は CLI の `next` で、司令塔は `next` に従い、内容を作らない。

**目標の固定（PR-006）。** 入口で固定した目標と出発点を状態に書き、後の段はそれを書き換えない（設計方針文書「目標の固定」）。
- implement：`start` が依頼の文を目標として状態に書く。今は needs_human_decision の回答を依頼の文に足して計画からやり直している（`repo-implement` SKILL.md「計画と計画のレビュー」の status の表）。develop では、回答を address-review の `decisions` と同じく別の記録として状態に足し、目標の文は変えない。目標の文に足すと、何を頼まれ何を後から決めたかが区別できなくなる。
- review：計画の mode・SHA・対象・除外が目標。計画のファイルに固定し、sum で守る（今と同じ）。
- address-review：PR と、collect で取った指摘の集合が目標。`stateDir` に固定する（今と同じ）。

**review の資産台帳。** 適用条件（fan-out した結果について、どこまで見たかを宣言する必要がある）に当たる。今の作りでは、CLI が coverage と `missing_coverage` を返すだけで、欠けた資産を追加で見に行く経路が無い（`R:p1-best-practices-6`）。develop では次を足す。
- 資産：対象ファイル（path と内容の SHA-256）。資産 ID は CLI が決める。
- 結び付き：「見た」は信用できる reviewer の coverage から入れる。指摘は検証役の結果として入れる。
- skip 一覧：信用できる reviewer が誰も読み終えていない資産。script はその資産だけを渡して reviewer を追加で起動し、新しく見た資産が無くなった回で止める。起動数の上限を渡されたときは、追加起動も枠に数える。
- 追加で起動するのは reviewer で、設計方針文書「資産台帳」の skip 一覧の行が review の例に挙げる検証役ではない。develop:review で資産を読み「見た」を作るのは reviewer で、finding-verifier は割り当てられた主張だけを確かめ、新しい指摘を探さない（`repo-review/agents/finding-verifier.md`）。検証役に未読の資産を渡すと、発見と検証の票が混ざる。設計方針文書の行の書き方は「未決事項」に置く。

## 利用側リポジトリとの契約

### 宣言する設定

利用側は設定ファイルを 1 つ置く（置き場と名前は「未決事項」。以下は仮に `develop.config.json` と書く）。形は `review/references/repo-config.schema.json` で決め、CLI が読み込み時に schema で検査する。合わない設定は失敗させる。黙って既定に落とすと、書いた宣言が効かないまま run が進む。

| 項目 | 形 | 無いときの既定と失敗の仕方 |
|---|---|---|
| 方針文書 | `reviewPolicy`（既定 `REVIEW.md`）と `rulesDir`（「読むもの」表の、ディレクトリの無い名前を解決する基点） | 文書が無ければ既定の観点（次の節）で見て、結果に「方針文書なし」と書く。文書があるのに表を読めなければ `E_POLICY` で止める |
| 除外 | `excludePaths`：glob の配列か、`{from: <YAML の path>, key: <キー>}` | 除外なし |
| 生成物 | `generated`：`[{glob, note}]` か `[{command: {argv}, note}]`。後者は方針の版の内容で argv を流し、標準出力の glob を使う | 生成物なし |
| 対象の種類 | `kinds`：`{specification: [glob], prd: [glob]}` | skill・code・document は CLI の固定の規則で分ける。spec と prd は宣言が無ければ document として扱う |
| check | `checks.allowed`：`[{id, argv, pathGlob?}]`、`checks.required`：`[id]` | 既定を置かない。implement は受け入れで止め、宣言の雛形を返す。review と address-review は使わない |
| テストの設計の基準 | `testDesignGuide`（path か path#節） | plugin の既定（`implement/references/case-design.md`。案） |
| commit の後 | `afterCommit`：`push` か `none` | `none`。address-review は返信が push 済みの SHA を指すので、この設定に関わらず push する |

**方針の版は設定に入れず、導く。** 設定は方針の版から読むので、方針の版を設定に書くと循環する。
- PR が対象なら、PR の base の先端（今の repo-review の PR の扱い）。
- 他は、`gh repo view --json defaultBranchRef` の branch の、remote の先端。remote は、URL が `gh repo view` の `nameWithOwner` に当たるものを `git remote -v` から選ぶ。1 つに決まらなければ `E_PIN` で止める。

**設定は方針の版から読む。** 作業 branch の規約を基準に混ぜると、その branch で変えた規約で同じ変更を免責する（`repo-review` SKILL.md の前処理の 1、working_tree の policyRef の段落）。設定も同じで、作業ツリーや PR の head から読むと、その PR が自分の必須 check や除外を緩められる。
- その帰結として、設定を足す・変える PR は、merge されるまで効かない。設定の無いリポジトリでは、implement は受け入れで止まる。review は既定の観点で動く。
- 初めて develop を使うリポジトリは、設定を足す PR を develop:implement の外（手作業か通常のセッション）で作って merge してから使い始める。移行計画の段 1・段 2 はこの順にする。

**check に既定を置かない。** 許可リストを推測すると、モデルの書いた文を shell に渡す経路ができる。宣言が無いまま check を省くと、テストを流していない変更が `verify` を通る。

**claude-plugins の宣言。** 今の挙動を、この設定と `REVIEW.md` で表し直す。
- 除外：`{from: ".github/workflows/claude_review.yml", key: "exclude-paths"}`
- 生成物：`tools/sync-bp-criteria.mjs` の書き先。今は `review-cli.mjs` の `readGeneratedPaths` が tool の source を解析して導いている。develop では `command` 形にし、tool に書き先を出力する option を足す（今の tool の引数は `--check` と `--root` だけ。`main` を読んで確かめた）。glob を設定に写すと、tool の書き先と 2 箇所になる。
- check：`implement-core.mjs` の `MAKE_TARGETS`・`REQUIRED_CHECKS` 相当
- commit の後：`afterCommit: push`
- skill-design の観点は設定に書かない。次の「観点の決め方」で扱う。

**3 リポジトリの今の方針文書との突き合わせ（実測）。** gh api で取った `REVIEW.md` を見出しで grep した範囲では、3 つとも「読むもの」「観点」「指摘の基準」「重大度」「出力」を持つ。重大度の名前は 3 つとも CRITICAL・HIGH・MEDIUM・LOW。3 つとも `claude_review.yml` に `exclude-paths` があり、既定ブランチは `main`。今の `review-core.mjs` の `parseReadingTable` に当てると、結果は次のとおりで、そのままでは使えない。
- pk：Markdown のリンクで書いた参照が全て `unparsed` になり、読む文書が 0 件。
- dcf：ディレクトリの無い名前（`rust.md` など）として取れる。5 つとも `.claude/rules/` にある（別の検証役が確かめた）。リポジトリ直下を基点にすると束に入らない。
- develop では、表の解析を Markdown のリンクと `rulesDir` 基点の名前に広げる（dcf は `rulesDir: ".claude/rules"`）。そのうえで、各リポジトリで `policyPack.missing` が空になることを段 2 の完了条件にする。

### 観点の決め方

今は司令塔が `REVIEW.md` を読んで、観点・focus・担当を自由に作っている（`repo-review` SKILL.md「観点と担当」）。develop では、観点を CLI が作る閉集合から選ばせる。担当の範囲を LLM が自由に作ると、run ごとに変わる（設計方針文書「資産台帳」の担当の範囲の行）。
- 閉集合：`REVIEW.md` の「観点」の箇条の太字の名前と、既定の観点の種類の観点（対象に出た種類だけ）。`REVIEW.md` が無ければ既定の観点だけ。CLI が `inventory` で返す。
- 司令塔は、閉集合から観点を選び、focus と担当を付けて `plan` に渡す。閉集合の外の観点・担当の無い対象・種類の観点の無い対象を、`plan` が拒否する。
- skill の種類（`SKILL.md`、その隣の `agents/*.md`、先頭の文が `export const meta` の `.js`）のファイルは、skill の観点に必ず割り当てる。今の skill-design の観点と同じ検査を、claude-plugins の置き場の glob（`SKILL_DESIGN_TARGETS`・`WORKFLOW_SOURCE_PATHS`）に依らず、ファイル名と内容で行う。
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
- address-review は implement を呼ぶとき、collect で固定した方針の版の SHA を渡す。今はそれぞれが始めた時点で主ブランチの先端を固定するので、間に主ブランチが進むと別の版で読む（`address-review` SKILL.md「照合しないもの」）。
  - 今の implement が方針の版を入力に取らないのは、作業 branch の規約で同じ変更を免責しないため（`repo-implement` SKILL.md「開始: 状態を固定する」の 2）。
  - その防ぎを残すため、implement の CLI は、渡された SHA が導いた方針の branch の remote の先端の祖先（同じを含む）であることを `git merge-base --is-ancestor` で確かめ、違えば拒否する。作業 branch の commit は主ブランチの祖先にならないので通らない。
- 返り値の形（`sum` を含む）は review の Workflow source の schema を正本にし、implement の `record-review` はそれを照合する。同じ plugin の同じ版で配るので、版のずれは起きない。

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
| pr-review：貼り付けた文書・git の外のファイル | 取り込まない。pin（内容の SHA-256 と commit）と方針の束が git を前提にし、投稿には path と line が要る | git の外の対象のレビュー（「未決事項」） |
| pr-review-fix：入力のレビュー結果を confirmed・rejected・unverified に分けてから直す | develop:review の結果は確定済みなので、そのまま implement に渡せる。それ以外の外のレビュー結果は、address-review の分類と分類の検証に通す。collect に、PR のコメントの代わりに指摘の一覧を受ける入力を足し（案）、返信の段は飛ばす。今の implement は外の指摘を依頼の文として受けるだけで、分ける段が無い | 無し（案が通れば） |
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
| thread を resolve しない既定と、resolve の経路が無いことのテスト | claude-plugins `address-review`（`scripts/address-skill.test.mjs`） | address-review。未決事項 3 で明示の依頼の resolve を足すと決まれば、テストは「依頼の無い resolve が無い」ことの照合に変える |
| 全ての CLI の出力（拒否も）が `next` を持つ | claude-plugins `address-review`（`NEXT`・`NEXT_BY_CODE`）。dcf の BLOCKED に `reason`・`evidence`・`next_action` を付ける作りも同じ考え | implement と review の CLI にも広げる |
| agent が見た HEAD を返し、script が pin と照らす | pk の implement、claude-plugins にも同じものがある | 3 スキル |
| 0 件と「レビューできなかった」を分ける | dcf の contextual-code-review（`pipeline_status`）、claude-plugins の `review_incomplete` も同じ | review（今の形で足りる） |

### 取り込まないもの

| 仕組み | 出所 | 理由 |
|---|---|---|
| `make tree-sha` による作業ツリーの同一性の確認 | pk | CLI の snapshot が同じことを Makefile に依らずに行う |
| 複数のレビューエンジン（codex・open-code-review・`/code-review`・Fable）と、落ちたときの切り替え | dcf magi | 別の plugin や外部の道具に依存し、配布先で揃う保証が無い。票の独立と起動数の記録が script の外に出る |
| focus brief を別 agent が書き、レビュー役に注入する | dcf contextual-code-review | 観点は CLI が作る閉集合から選ぶ（「観点の決め方」）。brief を LLM が作ると、観点が run ごとに変わる |
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
| 返信が日本語に固定 | minor の A:p1-loopholes-8 | 「未決事項」 |

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
| 1a. 設定を先に入れる（claude-plugins） | claude-plugins の設定ファイルを、develop:implement の外で PR にして main に merge する。develop が無い間は誰も読まない | main に設定があり、この文書の形で書かれている（schema の検査は 1b で通す） | 無し |
| 1b. develop を作る（claude-plugins） | `.agents/skills/` の 3 つを改名して一般化する（この文書を前段に要求を起こし、bp update で改稿する）。3 本のテスト `tests/repo-implement-workflow.test.mjs`・`tests/repo-review-workflow.test.mjs`・`tests/address-review-workflow.test.mjs` を、一致の照合（各スキルの `scripts/*.test.mjs` へ移す）と模擬実行（直下の `tests/` に残す）に分ける。`tests/workflow-callers.test.mjs` の名前の callsite の区分の一覧に 4 本を足す。manage-marketplace-plugin で plugin `develop` を作って 3 つを登録する（Workflow source は `workflows/` に移り、callsite は名前の呼び出しになる） | `make test` が通る。bp review（scope full）で確定 0。棄却の理由に「専用と宣言している」を挙げるものが 0 件（理由の文を grep して数える）。`verify_install.py --plugin develop` が通る。evals と trigger evals を測る。merge の後、claude-plugins の PR で address-review を 1 周流す（main の設定を読むので、merge の前には流せない） | claude-plugins で `repo-*` の名前を使う依頼（公開前なので、このリポジトリだけ）。段 3 までの発火の取り合い：`workflow:pr-review` と `develop:review`、`workflow:pr-review-fix` と `develop:implement`・`develop:address-review` |
| 2. pk・dcf の写しを消す | 各リポジトリで、設定を足す PR を先に merge する。pk：`REVIEW.md` の表が読めることを確かめ、`.agents/skills/{implement,review,address-review}` と参照を消す。dcf：`rulesDir` を宣言し、contextual-code-review の扱いを決めてから（「未決事項」）。magi は変えない | 各リポジトリで、旧名の参照が grep で 0 件。develop:review を 1 回流し、`policyPack.missing` が空 | pk で旧名を使う依頼。dcf で contextual-code-review を消す場合は、magi のレビューエンジンの呼び出し |
| 3. workflow の 2 スキルを廃止 | `plugins/workflow/skills/pr-review`・`pr-review-fix` と `.agents/skills/` の symlink を消す。参照を直す（`README.md:13`、`plugins/workflow/README.md:12-13`、`.agents/skills/manage-marketplace-plugin/tests/test_marketplace_safety.py:108`・`test_path_safety.py:59` の例の名前）。develop の trigger evals から、2 スキルとの取り合いの負例を外す。workflow の version を上げる | 下記の grep の条件を満たす。`make test` と `verify_install.py --plugin workflow` が通る | `/workflow:pr-review` と `/workflow:pr-review-fix` を呼ぶ利用者（not found になる） |

- `.agents/skills/repo-implement/SKILL.md:13` と `.agents/skills/address-review/SKILL.md:10` の `workflow:pr-review-fix` への案内は、段 1b の一般化で書き直すので、段 3 を待たずに消える。
- 参照の洗い出しは、`grep -rln "pr-review"`（`.git`・`node_modules` を除く）で見た範囲。上の一覧の他に当たるのは 2 件で、どちらも別物。
  - `plugins/research/skills/search/evals/evals.json:48` の `caller=pre-pr-review`
  - `.claude/settings.json:125` の `pr-review-toolkit@claude-plugins-official`
- 段 3 の完了の grep は、この 2 件とこの文書（`docs/design/develop-plugin.md`。経緯として 2 スキルの名前を持つ）を除いて 0 件になることにする。develop の trigger evals の負例は、段 3 で外すので除外に入れない。
- `plugins/workflow/.codex-plugin/plugin.json` の description は pr-review に触れていない（grep で確かめた）。
- 既存の plugin からスキルを外す操作を manage-marketplace-plugin が扱うかは未確認。同スキルの description が対象外に挙げるのは、marketplace.json の閲覧のみ・アンインストール・公開済み plugin の削除・スキル本体の作成と編集で、スキルを外す操作には触れていない。扱わないなら、外す作業と両方の catalog の同期を手で行い、`verify_install.py` で確かめる。
- 段 1b の試走は、`Workflow({ scriptPath: "<checkout の絶対パス>/plugins/develop/workflows/<f>.js" })` で起動する。名前で起動すると、install 済みの旧版が走るか not found になる（AGENTS.md「作業ルール」）。

**検証の担い手。** 生成と検証を分ける。改稿は bp update の builder が行う。合否は、決定的なテスト（`make test`）、bp review、生成者と別の fresh な監査が持つ。司令塔は改稿しない。
- bp review は段 1b の終わりと、各段で develop を直した後に毎回かける。
- evals は with_skill と baseline を比べる。
- trigger evals の負例に入れるもの：`workflow:review-document`、skill-creator-best-practices。段 3 までは `workflow:pr-review`・`workflow:pr-review-fix` も入れる。

## 未決事項

1. 利用側の設定ファイルの置き場と名前（仮に `develop.config.json`）。方針の版から読むことは決めてある。
2. git の外の対象（貼り付けた文書）のレビューを捨ててよいか。pr-review から失う機能のうち、代わりの経路が無いのはこれだけ。confidence の欄・spec と prd の自動の見分け・重大度の語彙は、別の形に置き換えた（「pr-review・pr-review-fix の機能の行き先」の表）。
3. address-review で、利用者が明示したときに thread を resolve する経路を足すか。既定は今の「resolve しない」のまま取り込む。pk は条件つきで resolve する。
4. push の後、required checks の成功を返信の前提にするか（pk の作り。今の claude-plugins には無い）。
5. dcf の contextual-code-review を、仕組みだけ取り込むか、develop:review で置き換えて消すか。置き換えるなら、magi のレビューエンジンの呼び出しを直す必要がある。
6. 返信の言語。日本語に固定するか、設定にするか、指摘の言語に合わせるか。
7. 設計方針文書への書き戻し。(i) 「形の判定」の図に、権限の分離で run を分ける場合を足すか（implement の外側）。(ii) 「資産台帳」の skip 一覧の行で review の追加起動の役を検証役としている書き方を、資産を読む役が reviewer の構成に合わせて直すか。
