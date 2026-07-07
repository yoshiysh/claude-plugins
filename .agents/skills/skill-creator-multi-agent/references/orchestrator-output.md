# 統合・保存ガイド

司令塔が Phase 5 で単独実行する手順。改善ループは Phase 4 で完結済み。

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
> 「保存しました。必要に応じてプラグイン／スキルの再読み込みを行うと、新しいスキルが使えるようになります。」

---

## バリデーションの実行

スキル保存後、`[SKILL_DIR]/scripts/quick_validate.py` でバリデーションを実行できる。`[SKILL_DIR]` はこのスキルの Base directory 絶対パス。

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

Phase 4 の評価結果を人間が確認するための静的 HTML を生成する。

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
