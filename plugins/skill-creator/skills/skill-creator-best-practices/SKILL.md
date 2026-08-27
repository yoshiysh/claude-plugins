---
name: best-practices
description: >
  スキルの作成（create）・既存スキルや直近変更の評価（review）・評価にもとづく改稿（update）を、
  マルチエージェントの Workflow で実行する。create は要件整理・検証基準生成・構成設計・執筆・
  テスト・評価を分担して新規スキルを生成し、review は観点別の指摘出しと独立した反証を経て
  生き残った指摘だけを構造化して返し、update はその指摘と変更意図から staging へ改稿して
  同じ観点で再検証し、人間の承認後に本体へ反映する。「スキルをマルチエージェントで作りたい」
  「品質チェック付きでスキルを作って」「このスキルを best-practices に沿ってるか評価して」
  「直近の変更をレビューして」「Issue に沿ってこのスキルを更新して」といったリクエストで使うこと。
  既存スキルの実行、通常のチャット質問への回答、SKILL.md を伴わない一般のコードレビューは対象外。
---

# マルチエージェント スキルクリエイター

複数の Sub Agent を実際に起動して役割分担し、単独実行より高品質なスキルを生み出す。
新規作成だけでなく、既存スキル・直近の変更の評価と改稿も同じ枠組みで扱う。

各 Sub Agent のプロンプトは `agents/` 配下の個別ファイルに定義されている。
実行順序・並列・集約・閾値判定は Workflow スクリプト（`scripts/build_skill.js` /
`scripts/review_skill.js`）が握る。司令塔が担うのは、その前後にある人間ゲートだけ。

## 目次

- [モード判定](#モード判定)
- [全体フロー](#全体フロー)
- create の司令塔手順
  - [要件整理とペルソナ設計（create）](#要件整理とペルソナ設計create)
  - [Workflow を呼ぶ（create）](#workflow-を呼ぶcreate)
  - [統合・改善ループ・ユーザーへの提示（create）](#統合改善ループユーザーへの提示create)
- review/update の司令塔手順
  - [対象と範囲の確認（review/update）](#対象と範囲の確認reviewupdate)
  - [Workflow を呼ぶ（review/update）](#workflow-を呼ぶreviewupdate)
  - [結果の提示と適用（review/update）](#結果の提示と適用reviewupdate)
- [入出力の定義](#入出力の定義)
- [ユーザーへの話し方](#ユーザーへの話し方)
- [ファイル構成（参照先）](#ファイル構成参照先)
- [設計上の制約](#設計上の制約)

---

## モード判定

**このスキルが起動したら、他のどの節より先にここで経路を決める。** 経路の無い依頼を
「とりあえず自分でやる」に落とすと、Workflow を通らない単発のレビューが判定として
出てしまう（実際に起きた事故がこの節の理由）。判定は必ず下表のどれかに落とす。

| 依頼の形 | モード | 進む先 |
|---|---|---|
| これから作るスキルの説明がある（「〜するスキルを作って」「品質チェック付きで設計して」） | `create` | 「要件整理とペルソナ設計（create）」へ |
| 既存スキルのパス・名前を挙げて評価を求める（「このスキルを best-practices に沿ってるか評価して」） | `review` | 「対象と範囲の確認（review/update）」へ |
| 変更・コミット・PR の範囲を挙げて評価を求める（「直近の変更をレビューして」「main...HEAD を見て」） | `review` | 「対象と範囲の確認（review/update）」へ |
| 評価に加えて直すことまで求める（「Issue に沿ってこのスキルを更新して」「指摘を反映して」） | `update` | 「対象と範囲の確認（review/update）」へ |
| スキルの実行依頼・通常の質問・SKILL.md を伴わない一般のコードレビュー | 対象外 | このスキルを使わない旨を伝えて終了 |
| 何を対象にするか読み取れない・入力が空 | 判定不能 | create / review / update のどれかと対象を 1 回で聞き返す |

**複数行に一致したときの優先順位**：作成・評価・更新の**実体を伴う行**（上 4 行）を優先し、
それらに 1 行も当たらないときだけ「対象外」「判定不能」を選ぶ。上 4 行の中で `review` と
`update` の両方に読めるなら `review` を選ぶ。依頼文に「作って」と「見て」が同居するなら、
まだ存在しないものを作るのが主目的なので `create`。この規則が無いと、複数に当たった時点で
選択が実行者の裁量に落ち、最も安直な行（対象外）が既定になる。

`review` と `update` の分かれ目は「直す許可が出ているか」だけ。`review` に倒したときは
結果提示で「このまま update で直すこともできる」と添える（読み違えて `update` に入ると、承認していない改稿が staging に残る）。

---

## 全体フロー

**create:**

```
要件整理とペルソナ設計（司令塔が単独で実行・人間ゲート）
  └─ 要件を構造化 → ドメイン知識を確認（条件付き）→ ペルソナを推論 → ユーザーに確認
  ※ 詳細手順： references/orchestrator-requirements.md を Read すること

Workflow を呼ぶ（scripts/build_skill.js が全て内包）
  Criteria → Structure → Write（+ Review script）→ Test → Evaluate → Grade → Analyze
  → 閾値を満たさなければ writer(revise) で改稿し Evaluate へ戻る

統合・改善ループ・ユーザーへの提示（司令塔が単独で実行・人間ゲート）
  └─ pass_rate と定性レポートをユーザーに提示 → 承認後に保存
  ※ 詳細手順： references/orchestrator-output.md を Read すること
```

**review:**

```
対象と範囲の確認（司令塔が単独で実行・人間ゲート／確認は 1 回）

Workflow を呼ぶ（scripts/review_skill.js。ここで回るのは 2 フェーズだけ）
  Find     観点別 finder を並列で fan-out（観点の一覧は script の FINDERS が唯一の正）
  Verify   finding ごとに観点の異なる反証者を独立に立て、過半数の反証で棄却
  ※ Update / Reverify は起動しない。ファイルは 1 バイトも書かれない

結果の提示（司令塔が単独で実行）
  └─ 確定・棄却・未検証を件数ごと提示。直すかどうかは人間が決める
  ※ 詳細手順： references/orchestrator-review.md を Read すること
```

**update:**

```
対象と範囲と変更意図の確認（司令塔が単独で実行・人間ゲート／確認は 1 回）

Workflow を呼ぶ（scripts/review_skill.js。review の 2 フェーズに 2 つ続く）
  Find     観点別 finder を並列で fan-out
  Verify   finding ごとに反証者を独立に立て、過半数の反証で棄却
  Update   updater が staging（対象スキルの全ファイルのミラー）に改稿を書く
  Reverify staging に同じ観点を再適用し、最初の Verify の確定指摘と突き合わせる

結果の提示と適用（司令塔が単独で実行・人間ゲート）
  └─ 解消/残存/新規/未検証を提示 → 承認後に司令塔が staging を本体へ反映
  ※ 詳細手順： references/orchestrator-review.md を Read すること
```

図を分けているのは、review では Update / Reverify が動かず **何も書かれない**ことを 1 本の図では読み取れないため。

**なぜ review/update も script にするか**: この区間も fan-out・反証の集計・閾値判定・
条件付き再実行の連なりで、途中に人間の判断が要らない。散文で「観点ごとに見て」「怪しい
指摘は落として」と書くと、観点の抜けも取捨の基準も実行者の裁量に落ちる。script にすれば
観点の集合・多数決・未検証の扱いが構造として決まる。

review と改稿の間に人間ゲートを置かないのも同じ理由（止めると指摘の選別が裁量に戻る）。
**本体ファイルは承認まで一切書き換えない**ため、途中に止める必要が無い。

---

## 要件整理とペルソナ設計（create）

**Agent ツールは呼び出さない。司令塔が単独で行う。**

`references/orchestrator-requirements.md` を Read し、手順に従って実行する。
ドメイン知識の要否判定と収集（domainKnowledge の組み立て）も同参照先の手順に含まれる。

完了条件：ユーザーがペルソナを承認したら「Workflow を呼ぶ（create）」へ進む。

---

## 対象と範囲の確認（review/update）

**Agent ツールは呼び出さない。司令塔が単独で行う。確認は 1 回にまとめる。**

ここでペルソナ承認ゲートは置かない。review/update の観点は script の `FINDERS` が
持っており、ユーザーに選ばせる余地が無いため、聞くべきことは対象と範囲だけになる。

依頼文から次を埋め、埋まらないものだけをまとめて 1 回聞き返す。

| 項目 | 意味 | 既定 |
|---|---|---|
| 対象スキルのディレクトリ | 評価するスキルの**実パス**（symlink 越しのパスではなく実体） | 既定なし。必須 |
| 範囲 | `full`（スキル全体）か `diff`（変更のみ） | 依頼が変更・コミット・PR を指していれば `diff`、それ以外は `full` |
| diff の範囲指定 | `diff` のときの git の範囲（例 `main...HEAD`） | `diff` なら必須。無ければ聞く |
| 焦点 | Issue 本文・見てほしい観点などの自由記述 | 任意。無ければ渡さない |
| 変更意図 | `update` のとき何をどう変えたいか | `update` では必須。無ければ聞く |

### 実パスの解決手順

対象ディレクトリは**実体パスで渡す**。script はファイルを開けず、symlink も解決できない。
agent が Read する基準パスは `args` でしか決まらないため、`.claude/skills/...` のような
symlink 越しの表記をそのまま渡すと、install 先（別ディレクトリに展開される）で解決できない
参照になる。次の順で解決する。

1. ユーザーの言い方（スキル名・`.claude/skills/<name>`・相対パス）から候補パスを 1 つ作る。
2. `realpath <候補パス>` を実行して実体パスを得る。**このスキル自身のディレクトリ**
   （`skillDir`）も同じく `realpath` にかける。
3. `realpath` が失敗したら、そのパスは存在しない。推測で別候補に読み替えず、
   「見つからなかったパス」をそのまま伝えて聞き返す。存在しないパスで走らせると、
   finder が全員「読めなかった」を返し、結果が空なのか対象が無いのかを人間が判別できない。
4. 得た実体パスを `skillDir` / `target.skillPath` に渡す。

完了条件：上表が埋まり、パスが `realpath` で解決できたら「Workflow を呼ぶ（review/update）」へ進む。

---

## Workflow を呼ぶ（create）

> **実行環境の前提**: このスキルは Claude Code の dynamic workflows に依存する。Codex では動作しない可能性が高い — `codex` CLI に workflow サブコマンドが無く、[Codex plugin の仕様](https://developers.openai.com/codex/plugins/build)にも `workflows/` サーフェスが無い（いずれも 2026-08 時点。Codex セッション内のツールセットを直接確認したものではない）。Codex で使う場合は、まず Workflow 相当のツールが露出しているか確認すること。この前提は review/update（`scripts/review_skill.js`）にも同じく効く。

ユーザーへの一言：
> 「基準づくりから執筆・品質チェックまでをまとめて回しています...」

```
Workflow({
  scriptPath: "[SKILL_DIR]/scripts/build_skill.js",
  args: {
    skillDir: "[SKILL_DIR]",
    requirements: "<要件整理で構造化した要件全体>",
    requirementsSummary: "<トリガー条件・対象ユーザーの要約>",
    taskType: "document | procedure | data",
    architecture: "coordinator | workflow",
    domainKnowledge: {          // 任意。要件整理で「要る」と判定したときだけ
      summary: "...",
      claims: [{ claim: "...", strength: "一次情報確認済み|実務慣行|未確認", source: "..." }],
      do_not_write: ["..."]
    },
    personas: {
      criteriaGen: "...", criteriaComp: "...",
      structureDesigner: "...", structureReviewer: "...",
      writer: "...", tester: "...", reviewer: "...",
      scriptReviewer: "..."   // architecture: "workflow" のときのみ
    }
  }
})
```

`domainKnowledge` は **要件整理で「要る」と判定したときだけ**渡す。渡すと criteria-gen・
writer・reviewer のプロンプトへ注入され、writer は `references/<領域>-knowledge.md` として
生成物にも書き出す。**`strength` を落とさないこと** — 内容そのものより「どの主張がどれだけ
確かなのか」が下流で効き、強度の無い知識は根拠のある記述と無い記述を混ぜてしまう。

`skillDir` には本スキルの実ディレクトリを実パスで渡す。スクリプトは自身の位置を解決できず、
`agents/*.md` の Read パスがここでしか決まらない。`personas` は要件整理でユーザーが承認した
ペルソナ説明文を役割ごとに入れる（未指定の役割は script 側で「要件から自分で置く」旨の
指示に落ちる）。

完了すると以下が返る：

```
{
  task_type, architecture, workflow_script, script_review,
  criteria, structure: { plan, attempts, unresolved, review },
  skill_draft, test_cases, iterations[], final, revisions_used, verdict
}
```

`verdict` は次の 6 値（下 2 つは `architecture: "workflow"` のときだけ出る）。

| verdict | 意味 |
|---|---|
| `passed` | 全テストケースが採点され、reviewer も応答し、delta >= 0.2 かつ失格 0 件 |
| `needs_human_decision` | 評価は揃ったが、改稿上限に達しても閾値に届かなかった（品質の問題） |
| `evaluation_incomplete` | 採点 agent か reviewer が応答せず、合否を判定できなかった（品質とは無関係）。workflow では reviewer 欠測のみが該当 |
| `revision_failed` | 改稿 agent が応答しなかった |
| `script_rejected` | **workflow のみ**。評価は通ったが script-reviewer が失格項目を挙げた |
| `script_review_incomplete` | **workflow のみ**。script-reviewer が応答せず、script を検証できなかった |

`architecture: "workflow"` を渡すと、writer は SKILL.md に加えて `scripts/<name>.js` を生成し、
script-reviewer（別 context）がそれを検査する。合否は **reviewer（基準充足）＋ script-reviewer** で決まり、
script の判定を先に見る（評価が揃わなくても script の失格は報告する）。
script-reviewer が落ちたときも「失格 0 件」とは読まず `script_review_incomplete` で返す。

**Workflow 型では with_skill / baseline の delta 評価を行わない。** この測定の前提は「with_skill は
方法論を持ち baseline は持たない」だが、Workflow 型の方法論は script 側にあり、評価時点の script は
ディスク上に無く、しかも評価 subagent には Workflow ツール自体が無い（実測）。出る数字は方法論の差では
なく「script が保存済みか」を測ることになるため、走らせない。実効性の実測は**保存後に人間が 1 回
回して測る**（「統合・改善ループ・ユーザーへの提示（create）」の eval-viewer 手順）。

script が失格でもこのループでは改稿しない。script-reviewer は Write 直後に 1 回だけ走る設計で、
再検証の経路が無いまま writer を回すと直ったか確かめずに次へ進むことになる。指摘を添えて返し、
人間が判断する。

`architecture` は `taskType`（`document` / `procedure` / `data` というドメイン分類）とは**別軸**。
取り違えると構成設計フェーズの有無が変わるため、`build_skill.js` は不正な値を受けたら即座に落ちる。

`passed` は「閾値を超えた」だけでなく**評価が揃った**ことも要求する。落ちた agent の分を
欠測として扱わず平均に含めると、生き残った少数の結果から出た数字が全体の成績に見える
（3 件中 2 件が落ちて 1 件だけ delta 0.9 を返すと平均も 0.9 になる）。reviewer も同じで、
応答が無い状態を「失格 0 件」と読むと「レビューされていない」が「レビューを通った」に化ける。
1 件も採点できなかったときの `delta` は `0` ではなく `null` を返す（`0` は実測の引き分けを
意味する値なので、欠測をそこに丸めない）。

### script が構造として保証すること

散文の手順書で担保していたものを、実行構造そのものに置き換えた対応表。

| 保証 | 実現方法 |
|---|---|
| with_skill と baseline が必ず対で走る | 全テストケース分を 1 つの `parallel()` にまとめて発行。直列化も片側だけの実行も起こりえない |
| pass_rate と delta が正確 | 集計は script の算術。LLM に平均を出させない |
| 閾値判定がぶれない | `delta >= 0.2 && reviewer.failed.length === 0` という式。目分量が入らない |
| 改稿が無限に続かない | 上限に達したら打ち切り、判断材料を添えて司令塔へ返す |
| 構成の差し戻しが止まる | designer → reviewer を上限付きで反復。未解決の指摘は `structure.unresolved` に載せて返す |
| Generator と Verifier が別 agent | designer と reviewer、writer と reviewer をそれぞれ別 spawn |
| テストが改稿を跨いで同一 | テストケース生成はループの外。pass_rate の変化が「スキルの改善」だけを反映する |
| 出力欠損を成績に混ぜない | 片側の出力が欠けたペアは採点に回さず `ungraded_cases` として数える |
| 検証結果が書式に左右されない | reviewer 系は schema で `failed[]` を返す。markdown 中の ❌ を script が数えない |

### 判定を script に閉じない箇所

`verdict: needs_human_decision` は「実装レベルの修正では届かなかった」という報告であって、
失敗の宣告ではない。「統合・改善ループ・ユーザーへの提示（create）」でユーザーに提示し、要件・基準（要件整理・Criteria 相当）まで遡るかを
人間が決める。script はそこを自動で判断しない。

### eval-viewer の生成

Workflow 完了後、以下のコマンドをユーザーに案内する（実行はユーザーが行う）：

```bash
# 評価結果をワークスペースに保存
python3 [SKILL_DIR]/scripts/run_eval.py \
  --skill-path .claude/skills/[スキル名] --iteration 1

# review.html を生成してブラウザで確認
python3 [SKILL_DIR]/eval-viewer/generate_review.py \
  .claude/skills/[スキル名]-workspace/iteration-1 --output review.html
```

---

## Workflow を呼ぶ（review/update）

ユーザーへの一言：
> 「観点ごとに見たうえで、それぞれの指摘に反論を当てて、生き残ったものだけ出します...」

```
Workflow({
  scriptPath: "[SKILL_DIR]/scripts/review_skill.js",
  args: {
    skillDir: "[SKILL_DIR]",
    mode: "review | update",
    target: {
      skillPath: "<対象スキルの実パス>",
      scope: "full | diff",
      diffRef: "<scope=diff のときの git 範囲指定。例 main...HEAD>",
      focus: "<任意。Issue 本文・見てほしい観点>"
    },
    intent: "<update のときの変更意図。update では必須>",
    stagingDir: "<任意。省略時の既定は script が決める（対象スキルの兄弟ディレクトリ）>",
    maxRevisions: "<任意。整数 0 以上。省略時の既定は script が持つ>"
  }
})
```

`skillDir` は本スキルの実ディレクトリ、`target.skillPath` は評価対象の実ディレクトリ。
どちらも対象と範囲の確認で `realpath` を通した絶対パスで渡す（script はパスを解決できず、
agent の Read はこの値だけを頼りにする）。不正な `mode` / `scope`、`scope: "diff"` なのに
`diffRef` が無い、`mode: "update"` なのに `intent` が無い、`maxRevisions` が 0 以上の整数でない、
`stagingDir` が対象スキルの配下を指している場合、script は起動直後に落ちる。曖昧なまま
走らせると、対象も範囲も定まらないレビューが「結果」として返るため。

**観点の一覧・反証者の立て方・多数決の閾値・改稿の上限・staging の既定値は
`scripts/review_skill.js` が持つ。** ここに数値や観点名やパスを書き写すと、同じ定義が
2 箇所に存在して必ずズレる（それ自体が `duplicate-claims` 観点の指摘対象になる）。
中身を知りたいときは script を読む。

完了すると以下が返る（フィールドの意味は[入出力の定義](#入出力の定義)を見る）：

```
{
  mode, target, verdict,
  findings: { confirmed[], rejected[], unverified[] },
  findings_source: "before" | "after",
  by_category: { before, after },
  staging: { dir, changed_files[], resolved[], remaining[], new[],
             unverified[], possibly_rephrased[], unobserved[],
             reclassified[], out_of_scope[], preexisting[] } | null,
  revisions_used
}
```

`verdict` は mode ごとに次の値を取る。判定条件は script の precedence chain が持つので、
ここには**司令塔がどう提示するか**だけを書く。提示フォーマットの実物は
`references/orchestrator-review.md`。

**review:**

| verdict | 司令塔の振る舞い |
|---|---|
| `clean` | 確定も未検証も無いと伝える。棄却の件数は添える |
| `findings` | `confirmed` を severity 順に提示し、`rejected` / `unverified` の件数も必ず添える |
| `review_incomplete` | `by_category.before` が `null` の観点を名指しし、見ていないと伝える。合格と読ませない |

**update:**

| verdict | 司令塔の振る舞い |
|---|---|
| `applied_to_staging` | 変更ファイルと `resolved` / `remaining` / `new` / `unverified` / `reclassified` / `out_of_scope` / `preexisting` を提示し、反映してよいか確認する（blocker 判定は `remaining` + `new` + `reclassified`） |
| `needs_human_decision` | 残った blocker（未検証の blocker を含む）を提示し、staging を残して判断を仰ぐ。自動反映しない |
| `update_failed` | 改稿 agent が応答しなかったと伝える。**書き込みの有無は不明**なので `staging.dir` を示して確認を促す |
| `reverify_incomplete` | staging には書かれたが再検証が揃わなかったと伝える。「直った」とは読ませない |
| `review_incomplete` | 改稿前に観点が欠けたため**改稿していない**と伝える。部分的な指摘から書き換えるより止まる方が安全 |

`unverified`（反証者の有効票が足りず、確定にも棄却にもできなかった指摘）は
`confirmed` が空でも黙って落とさない。「未検証」と「問題なし」を同じ表示にすると、
見られていない箇所が「見て問題が無かった」に化ける。これは update でも同じで、
再検証後の `staging.unverified` も必ず提示する。**未検証の blocker が 1 件でもあれば
`applied_to_staging` にはならない**（検証が足りないことは改稿で直せないため、
script は改稿を繰り返さず `needs_human_decision` へ倒す）。

---

## 統合・改善ループ・ユーザーへの提示（create）

**Agent ツールは呼び出さない。司令塔が単独で行う。** 改善ループは Workflow（`scripts/build_skill.js`）が内包しており、
ここでやり直す場合も `resumeFromRunId` で Workflow を再実行する（散文で agent を起動し直さない）。

`references/orchestrator-output.md` を Read し、手順に従って実行する。

---

## 結果の提示と適用（review/update）

**Agent ツールは呼び出さない。司令塔が単独で行う。**

`references/orchestrator-review.md` を Read し、提示フォーマットと適用手順に従って実行する。

本体への反映は**承認後に司令塔が行う**。Workflow は実行中にユーザー入力を受け取れないため、
script は staging に書くところで必ず止まる。コピー対象・非承認時の扱い・staging の性質は
すべて参照先に書いてある（要点をここにも置くと、手順が 2 箇所に分かれて食い違う）。

完了条件：ユーザーが反映を承認して本体へコピーしたか、非承認で終了したか、どちらかが確定すること。

---

## 入出力の定義

description に書いた 3 つの守備範囲と 1 対 1 で対応する。

### create

- **入力**：作りたいスキルの説明（自然言語・日本語可）。例：「月報を自動生成するスキルが欲しい」「PDF を要約するスキルを作って」
- **出力**：`SKILL.md`（スキル本体）／ `evals/evals.json`（テストケース3件）／ マルチエージェント設計なら `agents/` `assets/` `schemas/` ／ `architecture: "workflow"` なら `scripts/[スキル名].js`（**配布される実体はこの script なので、保存時に必ず一緒に書き出す**。Workflow の戻り値 `workflow_script` に入っている）
- **発火条件**：「スキルを作りたい」「スキルを設計して」「〜を自動化するスキル」

### review

- **入力**：対象スキルの実パス、範囲（`full` か `diff` + git の範囲指定）、任意の焦点（Issue 本文・観点）
- **出力**：**ファイルは 1 バイトも書き換えない。** 返るのは次のフィールドだけ。

| フィールド | 中身 |
|---|---|
| `findings.confirmed[]` | 反証を生き残った指摘 |
| `findings.rejected[]` | 過半数の反証で棄却された指摘 |
| `findings.unverified[]` | 有効票が足りず、確定にも棄却にもできなかった指摘 |
| `findings_source` | `"before"` 固定。review では 1 回しか検査しないため、出所は常に最初のパス |
| `by_category.before` | 観点ごとの確定件数。finder が落ちた観点は件数ではなく `null`（＝欠測） |
| `by_category.after` | `null` 固定。review では Reverify のパス自体が走らない（欠測ではない） |
| `staging` | `null` 固定 |
| `revisions_used` | `0` 固定 |

  `null` は 2 階層で意味が違う。`after === null` は「そのパスが走らなかった」（正常）、
  `before.<観点> === null` は「走ったがその担当が応答しなかった」（欠測）。
- **発火条件**：「このスキルを best-practices に沿ってるか評価して」「直近の変更をレビューして」

### update

- **入力**：review の入力すべて＋変更意図（必須）、任意で staging の出力先・改稿上限
- **出力**：staging に書かれた改稿一式と、再検証の突き合わせ結果。**本体は承認まで触らない。**

| フィールド | 中身 |
|---|---|
| `staging.dir` | 改稿の書き出し先。対象スキルの**全ファイルのミラー**（変更しなかったファイルも入っている） |
| `staging.changed_files[]` | 実際に書き換えたファイルと、その理由・対応する指摘 |
| `staging.resolved[]` | **最初の**確定指摘のうち、再検証で消えたもの |
| `staging.remaining[]` | **最初の**確定指摘のうち、再検証でも残ったもの |
| `staging.new[]` | 再検証で新しく出た確定指摘（改稿が持ち込んだ可能性がある） |
| `staging.unverified[]` | 再検証で確定にも棄却にもできなかった指摘。`remaining` と混ぜない |
| `staging.possibly_rephrased[]` | ファイルと観点は一致するが主張の文言が変わり、機械的には `new` として出たもの。`new` にも載ったまま、別枠でも残す |
| `staging.unobserved[]` | 再検証時にそのファイルを誰も読んでいないため、消えたのか見られていないのかが分からない指摘。`resolved` には数えない。blocker が含まれる場合は `unverified` の blocker と同様に自動確定せず `needs_human_decision` になる |
| `staging.reclassified[]` | 改稿前に未検証・棄却だった指摘が、再検証で票が揃って確定したもの。改稿が持ち込んだものではないので `new` には入れない |
| `staging.preexisting[]` | 再検証で新しく出たが、引用が改稿前の原本にもそのまま存在する確定指摘。改稿前の検査が見落とした既存の問題なので `new` には入れず、blocker 判定にも入れない（提示はする） |
| `staging.out_of_scope[]` | `scope: "diff"` のときだけ。改稿前に読まれたファイルにも今回変更したファイルにも無い場所で再検証が見つけた確定指摘。元からあった可能性が高いので提示だけし、blocker 判定には入れない（`full` では常に空） |
| `findings` / `findings_source` | 最後に**完了した**検査パスの確定・棄却・未検証と、それが `"before"`（改稿前）か `"after"`（再検証後）か |
| `by_category.before` | 改稿前（Find）の観点別確定件数。欠測観点は `null` |
| `by_category.after` | 再検証（Reverify）の観点別確定件数。Reverify が完了していなければ `null` |
| `revisions_used` | **再**改稿の回数。初回の改稿は含まないので、1 回だけ書いて終わったなら `0` |

  `resolved` / `remaining` / `new` は改稿を 2 回以上重ねても**常に最初の確定指摘と
  突き合わせる**。直前のラウンドと比べると、1 度直った指摘がぶり返しても「元から無かった」
  ことになる。
- **発火条件**：「Issue に沿ってこのスキルを更新して」「指摘を反映して直して」

### 3 モード共通の対象外

上の 3 節はそれぞれ独立した返り値を持つ。以下はどのモードにも経路が無い。

- 既存スキルの実行そのもの（このスキルはスキルを作る・見る・直すためのもの）
- 通常のチャット質問への回答
- SKILL.md を伴わない一般のコードレビュー（対象が「スキル」でないなら経路が無い）

---

## ユーザーへの話し方

- 技術用語（エージェント・アサーション・フロントマターなど）は使わない
- 処理中は何をしているかを一言で伝える
- 確認は一度にまとめる。細かい質問を何度も繰り返さない
- 選択肢は「Aで進めます。問題あれば言ってください」の形が使いやすい
- レビュー結果は「確定」「棄却」「未検証」を必ず区別して伝える。件数を隠さない

---

## ファイル構成（参照先）

```
agents/        # Sub-agent プロンプト。各 workflow script が Read させる
               #   create: criteria-gen / criteria-comp / structure-designer / structure-reviewer /
               #           writer / tester / grader / reviewer / script-reviewer / comparator / analyzer
               #   review/update: finder（単一観点の指摘出し）/ refuter（1 件への反証）/
               #           updater（staging への改稿）
eval-viewer/   # generate_review.py（静的 HTML 生成）/ viewer.html（レビュー UI）
evals/         # evals.json — このスキル自体の評価テストケース
references/    # orchestrator-requirements / orchestrator-output / orchestrator-review（司令塔の手順）、
               # coordination-patterns / best-practices / skill-writing-guide / criteria-by-task /
               # flow-design（設計ガイド）、schemas（エージェント間入出力の契約書）
scripts/       # build_skill.js  — create の Workflow 本体
               # review_skill.js — review/update 本体（観点一覧 FINDERS の唯一の正）
               # run_eval.py / aggregate_benchmark.py / improve_description.py / run_loop.py /
               # package_skill.py / quick_validate.py / utils.py
```

各ファイルの詳細な役割は、それを Read させている script と `references/schemas.md` が持つ
（ここに 1 行説明を複製すると、役割が変わったとき片方だけが古くなる）。

---

## 設計上の制約

パス・staging・新設ファイルの置き場・agent frontmatter に関する制約は
`references/orchestrator-review.md` の「設計上の制約」節にまとめてある。
review/update を実行する前に、「結果の提示と適用（review/update）」と同じタイミングで一度 Read すること。
ここに要約を置かないのは、制約の本文が 2 箇所に分かれると片方だけが更新されるため。
