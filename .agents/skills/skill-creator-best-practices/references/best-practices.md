# スキル設計ベストプラクティス

## 目次
1. [SKILL.md の設計原則](#1-skillmd-の設計原則)
2. [description の設計](#2-description-の設計)
3. [Sub-agent 設計](#3-sub-agent-設計)
4. [スキーマ契約（schemas.md）](#4-スキーマ契約schemasmd)
5. [確定的処理はスクリプトに追い出す](#5-確定的処理はスクリプトに追い出す)
6. [評価（eval）フレームワーク](#6-評価evalフレームワーク)
7. [アーキテクチャパターンの選択](#7-アーキテクチャパターンの選択)
8. [Human-in-the-Loop の設計](#8-human-in-the-loop-の設計)
9. [よくある失敗パターン](#9-よくある失敗パターン)
10. [チェックリスト（スキル公開前の確認）](#10-チェックリストスキル公開前の確認)
11. [Claude 5 世代（Opus 5 / Fable 5）でのスキル設計](#11-claude-5-世代opus-5--fable-5-でのスキル設計)
12. [制約の較正 — right altitude と代理指標の排除](#12-制約の較正--right-altitude-と代理指標の排除)
13. [オーケストレーション層の決定化 — Workflow 実行型](#13-オーケストレーション層の決定化--workflow-実行型)

スキル本体の更新・新規スキル設計時の指標となる参照ドキュメント。
以下のソースを統合している（§11 は 2026-07-29 取得の一次情報に基づく）：
- [anthropics/skills - skill-creator](https://github.com/anthropics/skills/tree/main/skills/skill-creator)
- [Agent Skills Best Practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)
- [Prompting Claude Opus 5（公式・一次情報）](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5)
- [Prompting Claude Fable 5（公式・一次情報）](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5)
- [nyosegawa - skill-creator and orchestration skill](https://nyosegawa.com/posts/skill-creator-and-orchestration-skill/)
- [Multi-agent coordination patterns](https://claude.com/blog/multi-agent-coordination-patterns)
- [Orchestrate subagents at scale with dynamic workflows（公式・一次情報）](https://code.claude.com/docs/en/workflows)

---

## 1. SKILL.md の設計原則

### コンテキストは公共財

コンテキストウィンドウは全スキルが共有する。トークンコストを常に意識する。

**3層ローディング（Progressive Disclosure）**

| 層 | 内容 | 読込タイミング |
|---|---|---|
| Level 1 | name + description（~100トークン） | 常時注入 |
| Level 2 | SKILL.md 本体（推奨500行以内） | トリガー時 |
| Level 3 | references/ assets/ scripts/ | 参照・実行時のみ |

Level 3 のファイルはアクセスされるまでコンテキストを消費しない。
参照ファイルが大きくても問題ない。SKILL.md のみ軽量に保つ。

### Orchestratorの純粋性

SKILL.md は「誰に何を渡すか」だけを定義する。

- ドメイン知識（HTML仕様・コンポーネント詳細・業務ルール）は agents/ や assets/ に分離
- 判断ロジックは Sub-agent の責務
- SKILL.md にドメイン知識が混在し始めたら分割のサイン

**MVC的な責務分離**

```
SKILL.md          → Orchestrator（制御フロー）
agents/           → 専門家プロンプト（ドメインロジック）
references/       → データ契約 or ドメイン知識
assets/           → 変化しない参照データ（仕様・設定値）
scripts/          → 確定的処理（実行エンジン）
```

### 参照ファイルの深さ制限

参照は SKILL.md から **1レベル深さまで**。それ以上ネストすると Claude が部分的にしか読まない。

```
# 悪い例
SKILL.md → advanced.md → details.md → actual-info.md

# 良い例
SKILL.md → advanced.md
SKILL.md → details.md
SKILL.md → reference.md
```

100行を超える参照ファイルには **目次を冒頭に入れる**。
Claude が部分読みした場合でも全体像を把握できる。

---

## 2. description の設計

description はスキル発見の唯一の手がかり。最も重要な要素。

### 必須ルール

- **3人称で書く**（"I can help" や "You can use" は禁止）
- 最大1024文字
- XML タグ禁止
- [What] + [When] の両方を含む

**良い例**
```
Extracts text and tables from PDF files, fills forms, and merges documents.
Use when working with PDF files or when the user mentions PDFs, forms, or document extraction.
```

**悪い例**
```
Helps with documents
```

### トリガー精度の最適化

- Claudeは「スキルを使わなすぎる」傾向があるため、少し積極的（押し強め）に書く
- 「〜の場合に使う」より「〜なら使うこと」のスタイルが有効
- 競合しそうなスキルと明確に区別できる表現を入れる
- 除外条件（対象外）も明記する

### 命名規則

- lowercase letters / numbers / hyphens のみ（最大64文字）
- gerund 形式推奨：`processing-pdfs`、`analyzing-spreadsheets`
- 曖昧な名前は避ける：`helper`、`utils`、`tools`

---

## 3. Sub-agent 設計

### フロントマターでモデルを指定

各エージェントファイルの冒頭に記述。SKILL.md にモデルを書かなくてよくなる。

```markdown
---
model: sonnet
---

# agent-name
...
```

### モデル選定基準

| タスクの性質 | モデル |
|------------|--------|
| 最高難度・長時間自律実行・多数 subagent のオーケストレーション | Fable |
| 深い創造・推論・高品質な生成 | Opus |
| 構造的判断・分類・計画 | Sonnet |
| 定型処理・パターンマッチング | Haiku（定型化済みのタスクのみ） |

Haiku は処理が完全に定型化できてから適用する。曖昧さや推論が残る場合は Sonnet 以上。
Fable は単純なタスクに使うと能力を過小評価する（コストも見合わない）。「以前なら人が数時間〜数日かける仕事」に投入する。
Opus 5 / Fable 5 向けの指示設計は [§11](#11-claude-5-世代opus-5--fable-5-でのスキル設計) を参照。

### 単一責務の原則

- 各 agent は「1入力 → 1出力」
- 「コンポーネントを選ぶ」と「挿入位置を決める」は別 agent
- Generator と Verifier は別エージェント（自分の出力を自分で検証しない）

### Why-driven prompt design

MUST/NEVER を並べるのではなく、理由を説明する。

```
# 悪い例
ALWAYS validate before submission.
NEVER skip the formatting step.

# 良い例
Validation prevents API errors that waste tokens.
Consistent formatting ensures the viewer can parse results.
```

例外：スキーマのフィールド名一致など「崖の近く」のクリティカルな箇所では制約も必要。

---

## 4. スキーマ契約（schemas.md）

エージェント間の入出力フォーマットを `references/schemas.md` に先に定義する。

```markdown
# schemas.md

## clarifier の出力
{
  "operation": "追加 | 削除 | 変更 | ...",
  "target_section": "section id or 新規",
  "summary": "変更内容の概要",
  "needs_clarification": true | false,
  "clarification_message": "確認が必要な場合のメッセージ or null"
}

## planner の出力
{
  ...
}
```

フィールド名のズレ（`config` vs `configuration`）でパイプラインが壊れる。
契約書を先に書き、全エージェントがその契約に従う設計にする。

---

## 5. 確定的処理はスクリプトに追い出す

| 処理の種類 | 担当 |
|-----------|------|
| 判断・分析・文章生成 | Claude（エージェント） |
| ループ・集計・ファイル操作 | scripts/ のスクリプト |
| 数値計算・統計処理 | scripts/ のスクリプト |

スクリプトを使う利点：
- LLM より信頼性が高い
- トークンを消費しない（出力だけが context に入る）
- 同じ処理を毎回安定して実行できる

スクリプトが失敗したとき Claude がフォールバックできるように設計する。

---

## 6. 評価（eval）フレームワーク

### eval-first 開発

**評価を先に作ってから実装する**。想定される問題ではなく実際の問題を解くため。

```
1. スキルなしで代表的なタスクを実行 → 失敗・不足を記録
2. テストケースを3件作成（evals.json）
3. スキルなしのベースラインを計測
4. 最小限の指示を書いてギャップを埋める
5. 評価 → ベースラインと比較 → 改善
```

### evals.json の構造

```json
{
  "skill_name": "example-skill",
  "evals": [
    {
      "id": 1,
      "prompt": "ユーザーのタスクプロンプト",
      "expected_output": "期待する動作の説明",
      "assertions": [
        "適切なライブラリを使用して処理している",
        "出力が指定フォーマットに従っている"
      ]
    }
  ]
}
```

### with_skill vs baseline の並列比較

```
with_skill版実行 → grading.json（PASS/FAILと根拠）
baseline版実行  → grading.json（PASS/FAILと根拠）
                       ↓
          aggregate_benchmark.py で統計集約
                       ↓
          analyzer.md でパターン分析・改善提案
```

### description 最適化ループ

```
20件のトリガー評価クエリを作成
  └─ should_trigger 8〜10件（様々な言い回し）
  └─ should_not_trigger 8〜10件（近い関連ドメイン）

60/40 で train/test 分割
各クエリを3回実行（信頼性確保）
最大5反復で description を改善
test スコアでベストを選択（過学習防止）
```

---

## 7. アーキテクチャパターンの選択

`references/coordination-patterns.md` を参照。

### 2つのアーキテクチャ

**Sub-agent 型**（1スキル内でサブエージェントを生成）
- SKILL.md がマネージャー役に徹する
- 並列処理で時間短縮
- 適例：品質保証が重要・Human-in-the-Loop が必要

**Skill Chain 型**（独立したスキルを直列連結）
- 各スキルが独立して再利用可能
- 明確な順序性があるフェーズ移行
- 適例：調査→実装→レポートのような独立フェーズ

### パターン組み合わせの例

skill-creator は Parallelization + Orchestrator-Workers + Evaluator-Optimizer を組み合わせている。
単一パターンに縛られず、要件に応じて組み合わせる。

---

## 8. Human-in-the-Loop の設計

チャット UI に閉じず、タスクに最適なインターフェースを生成する。

```
eval-viewer/generate_review.py → ローカル HTML ダッシュボード
feedback.json で構造化フィードバック収集
5秒 auto-refresh で最適化ループの進捗をリアルタイム表示
```

フィードバック収集のポイント：
- 「スキルが期待通りにトリガーされるか」
- 「指示が明確か」
- 「何が不足しているか」

---

## 9. よくある失敗パターン

| 失敗 | 対策 |
|------|------|
| SKILL.md にドメイン知識を詰め込む | agents/ / assets/ / references/ に分離 |
| 参照が深くネストしている | SKILL.md から1レベル深さまでに制限 |
| description が抽象的 | [What] + [When] を具体的なユーザー発話で示す |
| 選択肢を多く提示しすぎる | デフォルトを1つ示し、例外だけ補足する |
| MUST/NEVER を多用する | 理由を説明する（Why-driven） |
| 評価なしで実装する | eval-first：テストケースを先に作る |
| スキーマ定義がない | schemas.md を先に書く |
| 確定的処理を LLM に任せる | scripts/ にスクリプトとして実装する |
| 時間に依存した情報を書く | "old patterns" セクションに分離 |
| Windows スタイルのパス | 常に forward slash を使う |
| エージェント間の競合環境を無視する | description の改善は競合スキルを考慮して設計する |

---

## 10. チェックリスト（スキル公開前の確認）

### 基本品質
- [ ] description が具体的で [What] + [When] の両方を含んでいる
- [ ] description が3人称で書かれている
- [ ] SKILL.md 本体が500行以内
- [ ] 追加の詳細が別ファイルに分離されている
- [ ] 参照ファイルの深さが1レベルに収まっている
- [ ] 100行超の参照ファイルに目次がある
- [ ] 時間依存の情報が含まれていない
- [ ] 用語が一貫している
- [ ] 具体的な例が含まれている
- [ ] フィードバックループ（検証→修正）が設計されている

### マルチエージェント設計（該当する場合）
- [ ] SKILL.md がフロー制御のみを持っている
- [ ] 各エージェントが単一責務を持っている
- [ ] フロントマターでモデルが指定されている
- [ ] schemas.md でエージェント間の入出力が定義されている
- [ ] assets/ に参照データが分離されている
- [ ] Generator と Verifier が別エージェントになっている
- [ ] エラー時の差し戻し先（計画レベル/実装レベル）が定義されている

### テスト
- [ ] 最低3件の評価テストケースを作成した
- [ ] Sonnet と Opus でテストした
- [ ] 実際のユースケースでテストした

### Claude 5 世代対応（対象モデルが Opus 5 / Fable 5 の場合）
- [ ] 明示的な検証指示（「最後に検証せよ」「ダブルチェックせよ」）を削除した（§11）
- [ ] 手順の hardcode・網羅的な書式ルール・防衛的な繰り返しを削った（§11）
- [ ] 境界（何をしないか）と scope 制約は明示的に残した（§11）
- [ ] 進捗報告に「ツール結果との突合」を要求している（長時間自律実行の場合）
- [ ] 推論の生出力を要求する指示（reasoning echo）がない（Fable 5 で refusal を誘発）

---

## 11. Claude 5 世代（Opus 5 / Fable 5）でのスキル設計

一次情報: [Prompting Claude Opus 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5) /
[Prompting Claude Fable 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5)（2026-07-29 取得）。

公式ガイドの核: 旧世代向けスキルは「often too prescriptive for Claude Fable 5 and can degrade
output quality」。ただし方向は「無規定化」ではなく **削るものと残すもの（むしろ強化するもの）の
仕分け** である。

### 削る（旧モデルの弱さを補っていた指示）

| 削る指示 | 理由（公式ガイドより） |
|---------|----------------------|
| 明示的な検証ステップ（「最後に検証せよ」「subagent で検証せよ」） | Opus 5 は指示なしで自己検証する。指示があると over-verification でトークン浪費 |
| 「ダブルチェックせよ」「再確認してから回答せよ」 | 自己修正はデフォルト挙動。指示が重なりコスト増・品質向上なし |
| 手順の hardcode・網羅的な書式ルール・防衛的な繰り返し | 弱い計画能力の補償だった。今は品質の上限になる |
| 挙動を1つずつ列挙する指示 | 指示追従が強く、短い方針1つで足りる（「brief instruction beats enumeration」） |
| 事前リサーチ強制（「全部調べて計画してから着手」） | 高 effort ではモデル自身が context 収集・自己検証する。二重コスト。「When you have enough information to act, act」で置き換える |
| レビュー指示の「high-severity のみ報告」「保守的に」 | 文字通り従い検出数が減る。全件報告させ別パスでフィルタする |
| 推論の生出力を要求（「思考過程を回答に書け」） | Fable 5 では reasoning_extraction refusal を誘発し Opus 4.8 への fallback 増加 |

### 残す・強化する

| 残す指示 | 理由 |
|---------|------|
| 境界ブロック（「問題の報告が deliverable。修正は指示されるまでしない」） | Fable 5 は頼まれていない行動を取ることがある（勝手なメール下書き・防衛的 git backup が公式の実例） |
| scope 制約（「頼まれた範囲で。勝手に広げない・狭めない」） | Opus 5 はタスクの scope を自己判断で拡張しうる |
| 進捗報告の証拠突合（「各主張をツール結果と突合してから報告」） | 公式テストで捏造ステータス報告をほぼ排除。長時間自律実行では必須級 |
| subagent 委譲の基準・上限 | 両モデルとも旧世代より委譲に積極的。小タスクへの委譲はコスト倍増。「genuinely independent で sizeable な作業のみ」+ 決定的な spawn 上限 |
| fresh-context の verifier subagent | 「Separate, fresh-context verifier subagents tend to outperform self-critique」— Generator-Verifier 分離（§3）は 5 世代でも有効 |
| Why（依頼の意図・誰のためか） | 「Give the reason, not only the request」— 意図が長時間実行中の各判断の質を上げる |
| 出力の長さ・narration の較正 | verbosity は effort では制御できない。プロンプトで明示する（「Lead with the outcome」型） |
| メモリ機構（1 教訓 1 ファイル + 既存更新・重複禁止・誤り削除） | Fable 5 は過去 run の教訓参照で特に性能が上がる |

### スキル作成フローへの含意

- **degrees of freedom（§1・公式 best practices）は 5 世代でも健在**。崖の近く（不可逆操作・
  スキーマ厳密一致）は low freedom のまま。削るのは「open field に引いてあったガードレール」だけ。
- **eval-first がより重要になる**: 「削って良くなったか」は eval でしか判定できない。公式も
  「consider removing older instructions **if default performance is better**」と条件付き。
  既存スキルの 5 世代移行では、削る前に baseline（旧指示のまま）を取り、削った版と比較する。
- **effort は再較正する**: 旧モデルから引き継いだ effort 既定値は当てにならない。low/medium が
  旧世代 xhigh を超えることがあるため、自前 eval で effort sweep をやり直す。
- **Fable 5 をスキルの対象モデルにする場合**: 長 turn（数分〜数時間）前提でタイムアウト・
  非同期チェック（ブロックせず scheduled job で確認）を設計する。context 残量カウントを
  モデルに見せない（自発的な session 分割提案を誘発する）。

---

## 12. 制約の較正 — right altitude と代理指標の排除

一次情報: [Effective context engineering for AI agents（Anthropic Engineering）](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)（2026-07-29 取得）。§11 の「削る/残す」仕分けを、検証ゲート・機械チェックの設計に適用したもの。

### right altitude（公式の中核原則）

システムプロンプト・スキル指示の最適点は 2 つの失敗モードの間にある:

- **over-specification**: 「hardcoding complex, brittle logic in their prompts... creates fragility and increases maintenance complexity over time」
- **under-specification**: 曖昧な高レベル指導のみで具体的な信号がない

目標は「specific enough to guide behavior effectively, yet flexible enough to provide the model with strong heuristics」であり、「find the smallest possible set of high-signal tokens that maximize the likelihood of some desired outcome」。

### 代理指標の制約を検証ゲートにしない

機械検証は**契約そのもの**を見るべきで、契約の**代理指標**を見てはならない。代理指標ゲートは
「意味的に正しい出力を書式・長さ・語彙で落とす」false positive を構造的に生む（Goodhart's law:
指標が目標になると指標としての価値を失う）。

| 代理指標ゲート（避ける） | 契約そのものの検証（置き換え先） |
|------------------------|--------------------------------|
| 行数・要素数の完全一致（「5 行ぴったり」） | 必須要素が各 1 回存在すること（欠落・重複の検出） |
| 本文の最低文字数 | 実質性判定は生成側 prompt とレビューに委譲 |
| 較正されていない類似度閾値（Jaccard 等）による「多様性」判定 | 同上（擬似意味判定を機械に持たせない） |
| キーワード allowlist による意味判定（「この語彙を含めば OK」） | 非ブロッキング警告に降格するか削除 |
| ラベル・見出しの文字列完全一致 / bold・空白の書式一致 | 正規化（NFKC・装飾除去・空白吸収）後の内容照合 |
| レイアウト強制（インデント構造・bullet 階層の要求） | 内容キーワードの存在確認のみ |

**残すべき機械検証**（契約・安全そのもの）: スキーマ必須フィールドと enum、証拠の存在
（verifier の verdict と evidence）、権限境界（承認 marker — 捏造防止が目的なら厳格書式が正解）、
禁止事項の混入検出（精密に定義できるもの）。

### 制約は失敗から育てる（前方修正のみ）

公式 Skill best practices の実践知: 最良のスキルは「数行 + gotcha 1 個」から始まり、実際の
失敗に当たるたびに追記されて育つ。逆向き（想像した失敗に先回りして制約を積む）は §11 の
「削る」対象を量産する。制約を足すときは「どの実失敗を防ぐか」を、削るときは eval baseline を
根拠にする（§6 eval-first）。

### 撤去弁明・来歴をドキュメントに残さない

「〜の検証は行わない。なぜなら以前は〜」という否定形の記述は、変更時点のレビュアーへの説明で
あって次の読者への情報ではない。経緯は commit message / PR に書き（git blame で辿れる）、
契約・スキル本文は**現在の要件の肯定形だけ**にする。公式 anti-pattern「time-sensitive
information を本文に置かない」の変種。コード内に残す why コメントは「コードだけでは読み取れ
ない制約」（例: この文字を除去対象に足すと照合が壊れる）に限る。

---

## 13. オーケストレーション層の決定化 — Workflow 実行型

一次情報: [Orchestrate subagents at scale with dynamic workflows（Claude Code 公式）](https://code.claude.com/docs/en/workflows)（2026-07-29 取得）。bundled の `/deep-research` が参照実装（fan-out 検索 → ソース相互検証 → 主張ごとに投票 → 検証を生き残らなかった主張を除外）。リポジトリ内の参照実装は `dispatch` スキル（`scripts/orchestrate.js`）。

### 「誰が plan を握るか」の 4 分類（公式）

| | Subagents | Skills | Agent teams | **Workflows** |
|---|---|---|---|---|
| 次に何を実行するか決めるのは | Claude（ターンごと） | Claude（prompt に従い） | lead agent | **script** |
| 中間結果の置き場 | context window | context window | 共有タスクリスト | **script 変数** |
| 再実行可能なもの | worker 定義 | instructions | チーム定義 | **orchestration 自体** |
| スケール | ターンあたり数個 | 同左 | 少数の長期 peer | **1 run で数十〜数百 agent** |
| 中断 | ターンやり直し | 同左 | 継続 | **同一 session 内で resume 可能** |

### Workflow 実行型を選ぶ基準

- 1 会話で調整できる数を超える agent が要る（監査・大規模移行・相互検証つき調査）
- **orchestration 自体を読める・再実行できる資産**にしたい（保存すると `/コマンド` 化できる）
- adversarial verify・多角ドラフト比較のような**品質パターンを構造として強制**したい（モデルの善意に頼らない）
- 制約: **実行中のユーザー入力は不可**（公式）。段階間の sign-off が必要なら「各段階を個別 workflow として回す」。設計された人間ゲートが途中に多いタスクは Coordinator 駆動のままにする

### 分担の原則（§5 Determinism Split のオーケストレーション層への拡張）

**plan の設計 = モデル裁量、ループ・並列・集約・リトライ = script、判断 = ノード内の agent**。
ultracode / dispatch が採る形で、§12 の right altitude をアーキテクチャに適用したもの。

### 「警察装置」シグナル

モデル駆動ループには、ループが正しく回らない場合に備えた監視機構（skip 検出・bypass 検出・
compliance theater 検査・記録漏れ検知）が必要になる。**この種の監視コードを書き始めたら、
ループ自体を script に移すべきサイン**——Workflow 化すればスキップも bypass も構造的に不可能に
なり、監視装置ごと削除できる（§12「制約は失敗から育てる」の final form は、制約を不要にする
構造への置換）。

### Skills との関係（置換ではなく分担）

Skill は専門知識（契約・ドメイン知識・agent prompt）を運び、Workflow は orchestration を運ぶ。
fan-out する既存スキルは「それを指して同じことをする workflow を書かせる」のが公式の移行経路。
移行後も contracts / agents / 内部保証はスキル資産としてそのまま生きる。

### loop / graph との関係（入れ子構造）

制御ループ（until-pass / until-dry / until-budget）と DAG（graph）は workflow script の
制御フロー・依存関係としてそのまま内包される（汎用コードはグラフ DSL の上位互換）。
唯一 workflow の外に残るのは**人間の不可逆点判断を挟む時間軸の反復**
（マージ・デプロイを人間が握る外側ループ。workflow は実行中のユーザー入力を受けられない）:

```
外側ループ（時間軸・人間ゲート付き）: /loop・cron・issue 反復 ← workflow の外
  └─ 1 反復の中身: workflow（plan はモデル設計）
       ├─ 制御ループ（until-pass / until-dry / until-budget）← script の while
       └─ graph（DAG）← script の依存関係（await / pipeline / parallel）として表現
```
