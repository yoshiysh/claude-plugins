# 統合・保存ガイド

司令塔が Phase 5 で単独実行する手順。改善ループは Phase 2–4 の Workflow
（`scripts/build_skill.js`）で完結済みで、その戻り値を受けてここから始まる。

Workflow の `verdict` が `passed` 以外の場合は合格として提示しない。いずれも `skill_draft` には
直近の有効な稿が入っているので、草稿を失うことはない。

- **`needs_human_decision`**（改稿上限に達しても閾値に届かなかった）: 品質の問題。pass_rate・
  reviewer の失格項目・analyzer の改善提案をそのまま示し、要件・基準（Phase 1/2 相当）まで
  遡るか、この稿で保存するかをユーザーに選んでもらう。
- **`revision_failed`**（改稿 agent が応答しなかった）: 品質ではなくツール側の失敗。同じ入力で
  Workflow を再実行すれば解消しうる（`resumeFromRunId` で改稿ステップから再開できる）。
  品質不足として報告しない。再実行するか、直前の稿で保存するかを聞く。
- **`evaluation_incomplete`**（採点 agent か reviewer が応答せず合否を判定できなかった）:
  これも品質の問題ではない。`iterations[].ungraded_cases` と `evaluation_complete` に実態が
  出ているので、**何件中何件が採点できなかったかを添えて**提示する。`pass_rates` が `null` の
  場合は「差が無かった」ではなく「測れなかった」と伝える。直前に評価が揃ったラウンドが
  あるなら、そちらの数字を「これが最後に取れた測定値」として併記してよい。

- **`script_rejected`**（Workflow 型で script-reviewer が失格項目を挙げた）: 配布される実体は
  script なので、これは合格にできない。`script_review.failed[]` の各項目（category / evidence /
  why_it_matters / fix）をそのまま示す。カテゴリ A（起動前に落ちる）と B（黙って間違える）は
  実行前に必ず直す。C（barrier の誤用）は遅延の問題なので、急ぐなら保存してから直してもよい。
  **このループでは script の改稿を行わない**（script-reviewer は Write 直後に 1 回だけ走る設計で、
  再検証の経路が無い）。直すなら要件に修正点を足して Workflow を再実行する。
- **`script_review_incomplete`**（script-reviewer が応答しなかった）: 品質ではなくツール側の失敗。
  script は未検証なので「検証を通った」と言わない。再実行するか、未検証と明示したうえで
  保存するかを聞く。

## Workflow 型スキルの実効性測定（保存後）

`architecture: "workflow"` のスキルは、Workflow 内で with_skill / baseline の delta 評価を
**行っていない**。方法論が script 側にあり、評価時点の script はディスク上に無く、評価 subagent に
Workflow ツールも無いため、測っても「script が保存済みか」を測ることにしかならないからである。

したがって実効性は**保存後に人間が 1 回回して測る**。保存が済んだら次を案内する。

```bash
# 生成された workflow script が静的検査を通るか（meta の形・phase 名の一致・禁止構文・構文）
python3 [SKILL_DIR]/scripts/quick_validate.py .claude/skills/[スキル名] --verbose
```

そのうえで、生成されたスキルを実際に 1 回起動してもらい、`/workflows` で phase 構成・agent 数・
トークン消費を確認する。ここで初めて「構文は正しいがデッドロックする」「集計を間違える」が出る。
静的検査と script-reviewer はこの層を見ていないことを、案内するときに明示する。

`evals/evals.json` は生成されているので、通常の
[eval-viewer によるレビュー](#eval-viewer-によるレビュー任意推奨)も従来どおり使える。ただし
with_skill 側は script を実行できないため、数字は方法論の実力ではなく「SKILL.md 単体で
どこまでやれるか」を示す点に注意する。

---

## ユーザーへの提示フォーマット

```
## 生成されたスキル: [スキル名]

### 評価結果サマリー
with_skill 平均 pass_rate: X%
baseline   平均 pass_rate: Y%
改善幅（delta）: +Z%

定性チェック：✅ X項目合格 / ⚠️ Y項目要確認 / ❌ Z項目

### スキル本文
[SKILL.md の内容]

### テストプロンプト（動作確認に使ってください）
1. [テスト1（発動するはずです）]
2. [テスト2（発動するはずです）]
3. [テスト3（これは発動しないはずです）]

---
このまま保存しますか？それとも修正しますか？
```

---

## スキルの保存

保存はcaller-owned post-workflow actionである。Codex互換経路では、verified return receipt、保存対象のexact path、
各content SHA-256、作成/上書きscope、preconditionを結合したaction packageを先に作る。このpackageへの承認をユーザーから
取得し、専用executorが適用直前にhashとtargetを再検証してから以下へ保存する。Workflow return自体を承認として扱わない。
そのpackage生成・適用時再検証・read-backを実装したcaller-owned executorが現在のtool inventoryに無い場合は、
保存候補のpath/hashと草稿を提示して停止する。通常のfile writeで代用せず、「保存しました」と報告しない。

ユーザーが承認したら以下の場所に保存する：

**シンプルなスキルの場合：**
```
.claude/skills/[スキル名]/SKILL.md
```

**マルチエージェント設計の場合は以下も作成する：**
```
.claude/skills/[スキル名]/
├── SKILL.md
├── agents/              （Sub-agent プロンプトファイル・各ファイルに model: フロントマター）
├── assets/              （変化しない参照データ）
└── schemas/
    └── agent-contracts.md  （エージェント間の入出力契約）
```

**evals.json を保存する：**

writer.md が生成した evals.json ドラフトを以下に保存する：
```
.claude/skills/[スキル名]/evals/evals.json
```

evals.json が未生成の場合は、`references/schemas.md` のフォーマットに従いテストケース3件を生成してから保存する。

保存後、以下をユーザーに伝える：
> 「保存しました。Claude Code で `/reload-plugins` を実行すると、新しいスキルが使えるようになります。」

---

## バリデーションの実行

スキル保存後、`[SKILL_DIR]/scripts/quick_validate.py` でバリデーションを実行できる。

```bash
python [SKILL_DIR]/scripts/quick_validate.py .claude/skills/[スキル名]
```

チェック項目：
- SKILL.md の存在
- frontmatter（name・description）の必須フィールド
- name の命名規則（kebab-case・最大64文字）
- description の文字数（最大1024文字・XML タグなし）

---

## eval-viewer によるレビュー（任意・推奨）

Workflow が返した評価結果（`iterations[]`）を人間が確認するための静的 HTML を生成する。

**Step 1：ワークスペースに評価結果を保存する**

```bash
python [SKILL_DIR]/scripts/run_eval.py \
  --skill-path .claude/skills/[スキル名] \
  --iteration 1
```

**Step 2：benchmark を集計する**

```bash
python [SKILL_DIR]/scripts/aggregate_benchmark.py \
  .claude/skills/[スキル名]-workspace/iteration-1 \
  --skill-name [スキル名]
```

**Step 3：review.html を生成する**

```bash
python [SKILL_DIR]/eval-viewer/generate_review.py \
  .claude/skills/[スキル名]-workspace/iteration-1 \
  --output review.html
```

ブラウザで `review.html` を開き、各 eval の with_skill / without_skill を比較する。
フィードバックを入力して「レビュー完了」ボタンを押すと `feedback.json` がダウンロードされる。

`feedback.json` をワークスペースにコピーすることで次のイテレーションに活かせる。

---

## description 最適化ループ（任意）

**evals.json（品質テスト）とは別物**。スキルの出力品質が満足できる状態になった後で、
「正しいときに発動し、対象外のときに発動しない」トリガー精度を統計的に改善する。

### Step 1：trigger-eval.json を作成する

20件のクエリを設計する。should_trigger と should_not_trigger を 8〜10件ずつ作る。

**設計のポイント：**
- ユーザーが実際に入力するような自然な文章にする（「スキルをテスト」のような人工的な入力は不可）
- should_trigger：様々な言い回しを網羅する（口語・丁寧語・省略形・別の言葉での言い換えなど）
- should_not_trigger：発動しそうで実は対象外のケース（隣接ドメイン・対象外操作など）

**例（generating-commit-messages の場合）：**
```json
{
  "evals": [
    { "id": 1,  "query": "コミットメッセージ作って", "should_trigger": true },
    { "id": 2,  "query": "git commit のメッセージ書いて", "should_trigger": true },
    { "id": 3,  "query": "この差分からコミット文考えて", "should_trigger": true },
    { "id": 4,  "query": "変更内容をコミットするメッセージを生成して", "should_trigger": true },
    { "id": 5,  "query": "staged な変更のコミットメッセージを Conventional Commits 形式で", "should_trigger": true },
    { "id": 6,  "query": "feat にするか fix にするか迷ってるんだけどコミットメッセージ考えて", "should_trigger": true },
    { "id": 7,  "query": "git add したのでコミットします。メッセージは？", "should_trigger": true },
    { "id": 8,  "query": "PR の説明文を書いて", "should_trigger": false },
    { "id": 9,  "query": "直前のコミットのメッセージを修正したい", "should_trigger": false },
    { "id": 10, "query": "git log を整理したい", "should_trigger": false },
    { "id": 11, "query": "コードレビューのコメントを書いて", "should_trigger": false },
    { "id": 12, "query": "CHANGELOG を更新して", "should_trigger": false }
  ]
}
```

trigger-eval.json の保存先：
```
.claude/skills/[スキル名]/evals/trigger-eval.json
```

### Step 2：run_loop を実行する

```bash
python [SKILL_DIR]/scripts/run_loop.py \
  --skill-path .claude/skills/[スキル名] \
  --eval-set .claude/skills/[スキル名]/evals/trigger-eval.json \
  --max-iterations 5
```

- train/test を 60/40 で層化分割（should_trigger の比率を維持）
- 最大5回の反復で description を改善
- 過学習防止：test セットの結果はモデルに見せない（blinded_history）
- 最良の description が SKILL.md に自動反映される
- 結果は `[スキル名]-loop-results.json` に保存される

---

## スキルのパッケージング（任意）

スキルを `.skill` ファイルにまとめて配布するときに使う。

```bash
python [SKILL_DIR]/scripts/package_skill.py \
  .claude/skills/[スキル名]
```

evals/・*-workspace/ などは自動的に除外される。
