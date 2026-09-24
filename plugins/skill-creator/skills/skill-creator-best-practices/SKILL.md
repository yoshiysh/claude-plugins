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
`scripts/review_skill.js`）が握る。司令塔が担うのは、その前後にある人間ゲートだけで、
Agent ツールで agent を直接起動しない。成果物の本文は司令塔ではなく agent が生成し、agent の起動は
script の多数決・欠測検出を通す必要がある（散文で起動すると、欠けた観点や応答しなかった agent が合格に化ける）。

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

## モード判定

**このスキルが起動したら、他のどの節より先にここで経路を決める。** 判定は下表のどれかに落とす。
経路の無い依頼を「とりあえず自分でやる」に落とすと、Workflow を通らない単発のレビューが判定として出てしまう。

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
まだ存在しないものを作るのが主目的なので `create`。規則が無いと、最も安直な行（対象外）が既定になる。

`review` と `update` の分かれ目は「直す許可が出ているか」だけ。`review` に倒したときは
結果提示で「このまま update で直すこともできる」と添える（読み違えて `update` に入ると、承認していない改稿が staging に残る）。

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

review と改稿の間に人間ゲートは置かない。本体ファイルは承認まで書き換えないため、途中で止める必要が無い。

## Phase 1: 要件整理とペルソナ設計（create）

`references/orchestrator-requirements.md` を Read し、手順に従って実行する。
ドメイン知識の要否判定と収集（domainKnowledge の組み立て）も同参照先の手順に含まれる。

完了条件：ユーザーがペルソナを承認したら「Workflow を呼ぶ（create）」へ進む。

## Phase 1: 対象と範囲の確認（review/update）

確認は 1 回にまとめる。ここでペルソナ承認ゲートは置かない。review/update の観点は script の `FINDERS` が
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

## Phase 2-4: Workflow を呼ぶ（create）

> **透過実行 route**（create / review / update で同じ判定を通す。引数と出力の意味は `scripts/select_runtime.js` 冒頭コメントが正本）:
> 経路（native `Workflow` / native が無い Codex での `workflow:dynamic-workflow-runner` / 停止）はその script が決め、
> 判定条件を散文から読み取って自己適用しない（「未試行か」の状態追跡が実行者の記憶に乗ると、同じ呼び出しでも経路がブレる）。
> 出力の `selected_runtime` をそのまま使い、`halt: true` なら agent を 1 体も起動せず `rejected_reason` を伝えて止める。
> native 試行後の失敗は runner へ fallback しない。caller の human gate は runner 内 gate に移さない。根拠と mapping は [Codex Workflow互換契約](references/codex-workflow-compatibility.md)（active callsite 到達時に読む）。
> `node [SKILL_DIR]/scripts/select_runtime.js --mode create --native-available --runner-installed`
> **Codex classification: `portable`**（`build_skill.js` create）。

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
    uncheckedItems: <`python3 [SKILL_DIR]/scripts/quick_validate.py --emit-unchecked` の出力をそのまま>,
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

`uncheckedItems` は**必須**。機械検査が判定できないと宣言した項目（id つき）を reviewer へ運ぶ
唯一の経路で、script はファイルを開けないため args でしか渡せない。渡し忘れると script は
起動直後に落ちる（「委譲する項目が無い」と読んで静かに通すと、実施されない検査が合格になる）。
出力は**加工せずそのまま**渡す（id の正本は `scripts/quick_validate.py`）。

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
| `passed` | 全テストケースが採点され、reviewer も応答し、delta が `DELTA_THRESHOLD` 以上かつ失格 0 件 |
| `needs_human_decision` | 評価は揃ったが、改稿上限に達しても閾値に届かなかった（品質の問題） |
| `evaluation_incomplete` | 採点 agent か reviewer が応答せず、合否を判定できなかった（品質とは無関係）。workflow では reviewer 欠測のみが該当 |
| `revision_failed` | 改稿 agent が応答しなかった |
| `script_rejected` | **workflow のみ**。評価は通ったが script-reviewer が失格項目を挙げた |
| `script_review_incomplete` | **workflow のみ**。script-reviewer が応答せず、script を検証できなかった |

`architecture: "workflow"` を渡すと、writer は SKILL.md に加えて `scripts/<name>.js` を生成し、
script-reviewer（別 context）がそれを検査する。合否は **reviewer（基準充足）＋ script-reviewer** で決まり、
script の判定を先に見る（評価が揃わなくても script の失格は報告する）。
script-reviewer が落ちたときも「失格 0 件」とは読まず `script_review_incomplete` で返す。

**Workflow 型では with_skill / baseline の delta 評価を行わない。** 評価時点の script はディスク上に無く、
出る数字が方法論の差ではなく「script が保存済みか」を測るため。実効性は保存後に人間が 1 回回して測る
（`references/orchestrator-output.md`「Workflow 型スキルの実効性測定（保存後）」）。

`architecture` は `taskType`（`document` / `procedure` / `data` というドメイン分類）とは**別軸**。
取り違えると構成設計フェーズの有無が変わるため、`build_skill.js` は不正な値を受けたら即座に落ちる。

`passed` は「閾値を超えた」だけでなく**評価が揃った**ことも要求する。欠測を平均に含めると、
生き残った少数の結果が全体の成績に見え、reviewer 欠測は「レビューを通った」に化ける。
測れなかった `delta` は `0`（実測の引き分け）ではなく `null` で返す。

### 判定を script に閉じない箇所

`verdict: needs_human_decision` は「実装レベルの修正では届かなかった」という報告で、失敗の宣告
ではない。要件・基準まで遡るかを人間が決める（提示手順は `references/orchestrator-output.md`）。

### eval-viewer の生成

Workflow 完了後にユーザーへ案内するコマンドは `references/orchestrator-output.md`
「eval-viewer によるレビュー」が正本（ここに書き写すと片方だけが古くなる）。

## Phase 2: Workflow を呼ぶ（review/update）

> **透過実行 route**: ここでも [create と同じ route](#workflow-を呼ぶcreate) を先に通す（正本はそのブロックと `scripts/select_runtime.js` 冒頭コメント）。
> `halt: true` なら review_skill.js を起動せず `rejected_reason` を伝えて止める。review と update は Codex runner では
> `rejected_source` で停止する。update の staging 境界、追加・削除を含む差分 manifest、caller 側の適用経路が未完成で、
> capability の宣言だけでは安全性を保証できない（根拠は [Codex Workflow互換契約](references/codex-workflow-compatibility.md)「review / update mapping」。active callsite 到達時に読む）。
> review の例: `node [SKILL_DIR]/scripts/select_runtime.js --mode review --native-available --runner-installed`
> update の runner 例: `node [SKILL_DIR]/scripts/select_runtime.js --mode update --no-native --runner-installed`（`halt: true` で停止する）。
> **Codex classification: review/update は runner で `rejected_source`**。

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
    uncheckedItems: <`python3 [SKILL_DIR]/scripts/quick_validate.py --emit-unchecked` の出力をそのまま。必須>,
    intent: "<update のときの変更意図。update では必須>",
    stagingDir: "<任意。省略時の既定は script が決める（対象スキルの兄弟ディレクトリ）>"
  }
})
```

`skillDir` は本スキルの実ディレクトリ、`target.skillPath` は評価対象の実ディレクトリ。
どちらも対象と範囲の確認で `realpath` を通した絶対パスで渡す（script はパスを解決できず、
agent の Read はこの値だけを頼りにする）。不正な `mode` / `scope`、`scope: "diff"` なのに
`diffRef` が無い、`mode: "update"` なのに `intent` が無い、`uncheckedItems` が無いか形式が不正、
`stagingDir` が対象スキルの配下を指している場合、script は起動直後に落ちる。対象も範囲も定まらないレビューが「結果」として返らないように。

改稿の打ち切りは回数ではなく進捗で決まる — 未解消 0 件、または前の巡から 1 件も動かなくなるまで回る。
暴走は workflow runtime の agent 起動上限が外側で止める。

**観点の一覧・反証者の立て方・多数決の閾値・打ち切りの判定・staging の既定値は
`scripts/review_skill.js` が持つ。** ここに数値や観点名やパスを書き写すと、同じ定義が 2 箇所に
存在して必ずズレる（それ自体が `duplicate-claims` 観点の指摘対象になる）。中身は script を読む。

完了すると以下が返る（フィールドの意味は[入出力の定義](#入出力の定義)を見る）：

```
{
  mode, target, verdict,
  findings: { confirmed[], rejected[], unverified[] },
  unchecked_failures: [],
  findings_source: "before" | "after",
  by_category: { before, after },
  reverify_missing: [],
  reverify_receipt: { phase, staging_dir, fresh_thread, completed, by_category,
                      updater_thread_id, fresh_thread_id } | null,
  staging: { dir, changed_files[], resolved[], remaining[], new[],
             unverified[], possibly_rephrased[], unobserved[],
             reclassified[], out_of_scope[], preexisting[], reverify_missing[] } | null,
  revisions_used
}
```

`verdict` は mode ごとに次の値を取る。判定条件は script の precedence chain が持つので、
ここには**司令塔がどう提示するか**だけを書く。提示フォーマットの実物は
`references/orchestrator-review.md`。

**review:**

| verdict | 司令塔の振る舞い |
|---|---|
| `clean` | 確定も未検証も、委譲項目の未達も無いと伝える。棄却の件数は添える |
| `findings` | `confirmed` を severity 順に提示し、`rejected` / `unverified` / `unchecked_failures` の件数も必ず添える |
| `review_incomplete` | `by_category.before` が `null` の観点を名指しし、見ていないと伝える。合格と読ませない |

**update:**

| verdict | 司令塔の振る舞い |
|---|---|
| `applied_to_staging` | 変更ファイルと `resolved` / `remaining` / `new` / `unverified` / `reclassified` / `out_of_scope` / `preexisting` に、staging の指紋を添えて提示し、反映してよいか確認する（`remaining` + `new` + `reclassified` のうち updater へ戻す重さの規則は script の `REVISE_SEVERITIES` が正本 — そこに含まれる severity は script がループ内で解消済みなので、この verdict で提示に残るのはそれ以外の軽い指摘だけ。含まれる severity が残った場合は verdict 自体が `needs_human_decision` になる） |
| `needs_human_decision` | 発火は 2 経路: 未検証・未観測の blocker（即時）と、`REVISE_SEVERITIES` に含まれる severity の未解消指摘が前の巡から 1 件も動かなくなった（解消も新規も無い＝同じ入力では収束しない）とき。残った指摘を severity ごと提示し、staging を残して判断を仰ぐ。自動反映しない |
| `update_failed` | 改稿 agent が応答しなかったと伝える。**書き込みの有無は不明**なので `staging.dir` を示して確認を促す |
| `reverify_incomplete` | staging には書かれたが再検証が揃わなかったと伝える。「直った」とは読ませない |
| `review_incomplete` | 改稿前に観点が欠けたため**改稿していない**と伝える。部分的な指摘から書き換えるより止まる方が安全 |

`reverify_missing` は Reverify で応答しなかった、または読めなかった観点の一覧。
空でない場合は再検証が完了していないため、`reverify_incomplete` となり、
`reverify_receipt.completed` も `false` になる。最初の試行で欠測があった場合は、全観点を一度だけ再試行した後の最終一覧が残る。

`unverified`（反証者の有効票が足りず、確定にも棄却にもできなかった指摘）は `confirmed` が
空でも黙って落とさない。「未検証」と「問題なし」を同じ表示にすると、見られていない箇所が
「見て問題が無かった」に化ける。update でも同じで、再検証後の `staging.unverified` も必ず提示する。
**未検証の blocker が 1 件でもあれば `applied_to_staging` にはならない**（検証が足りないことは
改稿で直せないため、script は改稿を繰り返さず `needs_human_decision` へ倒す）。この blocker ゲートの
正本はここで、以降の節は参照だけを置く。

## Phase 5: 統合・改善ループ・ユーザーへの提示（create）

改善ループは Workflow（`scripts/build_skill.js`）が内包しており、やり直す場合も `resumeFromRunId` で
Workflow を再実行する。

`references/orchestrator-output.md` を Read し、手順に従って実行する。

## Phase 3: 結果の提示と適用（review/update）

`references/orchestrator-review.md` を Read し、提示フォーマットと適用手順に従って実行する。

本体への反映は**承認後に司令塔が行う**（script は staging に書くところで必ず止まる）。司令塔の役割は
Workflow を呼ぶ・script が組んだ収支を verbatim に relay する・承認後に `staging.changed_files` を
機械コピーする、の 3 つだけで、**staging の内容は書かない**（minor の文言修正もユーザーの追加指示も、
新しい `intent` での update 再実行に一本化）。指紋照合・コピー対象・非承認時の扱い・純化の理由とコストは
参照先が正本。完了条件は、非承認で終了・指紋一致でコピー・指紋不一致でコピー拒否のいずれかが確定すること。

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
| `unchecked_failures[]` | 機械検査が判定できないと宣言した項目のうち、担当観点が未達と判定したもの・判定を返さなかったもの。反証を通していないので `confirmed` には混ぜない。合格にならない判定の集合は script の `UNCHECKED_BLOCKING` が正本 |
| `findings_source` | `"before"` 固定。review では 1 回しか検査しないため、出所は常に最初のパス |
| `by_category.before` | 観点ごとの確定件数。finder が落ちた観点は件数ではなく `null`（＝欠測） |
| `by_category.after` | `null` 固定。review では Reverify のパス自体が走らない（欠測ではない） |
| `staging` | `null` 固定 |
| `revisions_used` | `0` 固定 |

  `null` は 2 階層で意味が違う。`after === null` は「そのパスが走らなかった」（正常）、
  `before.<観点> === null` は「走ったがその担当が応答しなかった」（欠測）。
- **発火条件**：「このスキルを best-practices に沿ってるか評価して」「直近の変更をレビューして」

### update

- **入力**：review の入力すべて＋変更意図（必須）、任意で staging の出力先
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

## ユーザーへの話し方

- 技術用語（エージェント・アサーション・フロントマターなど）は使わない
- 処理中は何をしているかを一言で伝える
- 確認は一度にまとめる。細かい質問を何度も繰り返さない
- 選択肢は「Aで進めます。問題あれば言ってください」の形が使いやすい
- レビュー結果は「確定」「棄却」「未検証」を必ず区別して伝える。件数を隠さない

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
               # select_runtime.js — Workflow 呼び出し前の経路選択（native / 互換層 / 停止）
               # package_skill.py / quick_validate.py / diff_findings.py / utils.py
```

各ファイルの詳細な役割は、それを Read させている script と `references/schemas.md` が持つ
（ここに 1 行説明を複製すると、役割が変わったとき片方だけが古くなる）。

## 設計上の制約

パス・staging・新設ファイルの置き場・agent frontmatter の制約は `references/orchestrator-review.md`
「設計上の制約」節が正本。`stagingDir` を指定するときと staging を本体へ適用するときは staging の制約を、
このスキルに agent や reference を足すときは置き場と frontmatter の制約を見る。
