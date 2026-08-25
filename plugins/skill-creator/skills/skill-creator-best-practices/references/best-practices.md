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
14. [ハーネス設計 — モデルに面したインターフェースと状態](#14-ハーネス設計--モデルに面したインターフェースと状態)

スキル本体の更新・新規スキル設計時の指標となる参照ドキュメント。
以下のソースを統合している（§11 は 2026-07-29 取得の一次情報に基づく）：
- [anthropics/skills - skill-creator](https://github.com/anthropics/skills/tree/main/skills/skill-creator)
- [Agent Skills Best Practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)
- [Prompting Claude Opus 5（公式・一次情報）](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5)
- [Prompting Claude Fable 5（公式・一次情報）](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5)
- [nyosegawa - skill-creator and orchestration skill](https://nyosegawa.com/posts/skill-creator-and-orchestration-skill/)
- [Multi-agent coordination patterns](https://claude.com/blog/multi-agent-coordination-patterns)
- [Orchestrate subagents at scale with dynamic workflows（公式・一次情報）](https://code.claude.com/docs/en/workflows)
- [Introducing dynamic workflows in Claude Code（公式ブログ）](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code)
- Workflow ツールの contract（セッション内のツール定義。公開 URL は無い。§13 の script 作法はここが一次情報）
- [Six Agent Harness Capabilities for Higher Model Performance（NVIDIA Technical Blog）](https://developer.nvidia.com/blog/six-agent-harness-capabilities-for-higher-model-performance/) / [技術レポート arXiv:2607.20709](https://arxiv.org/abs/2607.20709)
- [How enabling two settings tripled our scores on the ARC-AGI-3 benchmark（OpenAI）](https://openai.com/index/how-two-settings-tripled-our-arc-agi-3-scores/)
- [NVIDIA AVO reaches 100% on ARC-AGI-3（NVIDIA Technical Blog）](https://developer.nvidia.com/blog/nvidia-avo-reaches-100-on-arc-agi-3-demonstrating-a-frontier-level-general-purpose-architecture-for-long-horizon-autonomous-agents/) / [AVO: Agentic Variation Operators arXiv:2603.24517](https://arxiv.org/abs/2603.24517)
- [Long-Horizon Agent の設計原理（岡野原大輔・X スレッド）](https://x.com/hillbig/status/2091320304329269722) — 二次整理。PARC / Argus / InfiAgent / File-as-Bus への索引

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

**適用範囲の決め方**: 各項目が「どのスキルに当てはまるか」は、そのスキルが**何をするか**で決める。
既にある構造（`agents/` があるか等）で決めない。構造で決めると、構造が無いこと自体が欠落である
ケースが自動的に対象外になる（欠落は「在るもの」を走査しても出てこない）。

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
- [ ] **生成物を、それを生成した agent 以外が検証する経路がある** — 状態を変える（コミット・
      PR 作成・外部書き込み・ファイル変更）か、出力が下流で行動の根拠になるスキルに適用する。
      `agents/` の有無で判断しない。**単体スキルで検証者が 1 つも無い状態こそが、この項目の
      不合格**（§3・§11）
- [ ] 検証は状態変更の**前**に置かれている — 事後検証は既に起きた変更を報告するだけで、
      push 後の履歴訂正や通知済みレビュアーへの周知はやり直せない
- [ ] 改善ループ（評価 → 修正 → 再評価）が設計されている（eval を持つスキルの場合）

### マルチエージェント設計（既に複数 agent を持つ場合）

**注意**: この条件は「複数 agent を持つスキルの、agent 間の設計」を見る節であって、
「検証者が要るか」を問う節ではない。後者は基本品質側で全スキルに問う。ここが「該当しない」
ことを、検証者不要の根拠にしない。

- [ ] SKILL.md がフロー制御のみを持っている
- [ ] 各エージェントが単一責務を持っている
- [ ] フロントマターでモデルが指定されている
- [ ] schemas.md でエージェント間の入出力が定義されている
- [ ] assets/ に参照データが分離されている
- [ ] Generator と Verifier が別エージェントになっている
- [ ] Verifier が生成物を自分で読み直す（生成側の要約を信じない）。読んだ証拠を出力に含める
- [ ] エラー時の差し戻し先（計画レベル/実装レベル）が定義されている

### テスト
- [ ] 最低3件の評価テストケースを作成した
- [ ] Sonnet と Opus でテストした
- [ ] 実際のユースケースでテストした

### ループ・反復を持つスキル（改稿 / 審査 / 実験の繰り返しがある場合）
基準の正本は `criteria-by-task.md`「反復（グラフ）」節。
- [ ] 停止条件が証拠側（乾き・前提崩れ・予算）にあり、回数上限は backstop と明記されている（§13）
- [ ] 失敗の種別ごとに戻り先の辺（成果物 / 基準 / 計画 / 人間）が定義されている（§13）
- [ ] 人間の境界が needs_input（data / decision）に統一され、承認ゲートは対象（不可逆・外部公開・rules 類）で引かれている（§13）

### ハーネス（状態を持つ・長時間走る・agent を跨ぐスキルの場合）
基準の正本は `criteria-by-task.md`「ハーネス」節。ここでは構造で保証すべき 3 点だけ挙げる。
- [ ] 現在の状態が会話履歴ではなく state ファイル／script 変数にあり、再開はそこから始まる。session を切るのは Phase 境界で、再試行では切らない（§14 ①④）
- [ ] 永続状態への書き込みを verifier の再取得証拠で gate し、verified にはスコープを付け、却下した経路と実行した事実も state に残している（§14 ⑤）
- [ ] supervisor の介入は redirect のみで、仮説を供給しない（§14 較正 3）

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

### 反復の停止と戻り先 — ループではなく型付きの辺を持つグラフ

改稿・審査・実験のような反復を設計するとき、実体は円環（同じ経路を N 回回る）ではなく
**有向グラフ**である: ノードは工程（計画 / 実行 / 検証 / 判定）、辺は「失敗の種別が選ぶ戻り先」、
終端は「証拠が乾いた・予算が尽きた・人間の入力待ち」。円環として書くと、戻り先が 1 種類しか
なくなり、どんな失敗でも同じ浅い段を掘り直す。

**1. 停止は証拠、回数は backstop。** 「N 回まで」という回数上限は、実測から較正されていない限り
§12 の voodoo constant である（実例: 反復上限 3 に根拠が無く、前提の弱さが 1 周目で見えていた
のに 3 周とも消化した）。正しい停止条件は証拠側に置く — 新しい findings / 機序がその周で
1 つも出なかった（乾き）、前提が崩れた、予算（run・トークン・時間）に達した。回数上限は
暴走防止の backstop としてだけ残し、当たって止まったときは「十分回した」ではなく
「backstop 停止」と明記する。

**2. 失敗の種別が戻る深さを決める（スコープの梯子）。** 実装の欠陥 → 成果物の修正。
基準・測定の欠陥 → 基準へ。前提の欠陥 → 計画へ遡上。問いの価値・入力の欠陥 → 人間へ。
判定役は失敗の種別を機序として分類し（前提の不成立を示すか、手順が壊れているか）、
区別できなければ人間に裁定を返す。梯子が無いループは一番浅い辺しか持たず、局所最適に沈む。

**3. 人間の境界は一分類 `needs_input`、ゲートは対象で引く。** 人間に返る状態は
「人間からしか得られない入力を待つ」の一種類で、kind が中身を分ける — `data`（環境・予算・
成功の定義・問いの価値）と `decision`（判定機構が決められず裁定が要る）。どちらも
「質問を提示し、答えが入れば自動で再開」という同じ動作契約を持つ。承認ゲートは操作の
種類（standardize だから止める）ではなく**対象**で引く: 不可逆・外部公開・rules 類の変更だけ
人間が握り、git で可逆な範囲は自動実行 + 事後報告にする。

**4. 判定は判定表 + 専任 judge。** decision を散文の判断に任せると「もう少し頑張る」が revise に
化ける。判定表（行の優先順位つき）を書き、適用は生成側と別の judge agent が行い、表に無い
状況で規則を発明せず `needs_input`（decision）で返す。

参照実装は `pdca` スキル（別 plugin）: 乾き判定（機序の novelty マーキング → script が件数算出 →
judge が stop 行を適用）、梯子（revise_criteria / revise_plan / needs_input）、backstop
（maxCycles 既定 5、明記付き）まで構造化されている。これらは全て実運用の失敗
（§14 較正の追試ループ）から §12 の手順で育てた制約であり、新しいスキルに足すときも
同じく「実失敗 → 制約」の順で入れる。

### `scripts/` は 2 つの別の層を指す（混同しない）

同じ `scripts/` でも、担っている層が違う。

| | 決定的処理（§5 Determinism Split） | orchestration（本節） |
|---|---|---|
| 例 | `anthropics/skills` の `docx/scripts/{accept_changes,comment,merge_runs}.py` | `dispatch/scripts/orchestrate.js` |
| 中身 | OOXML 手術・PDF 処理など、1 操作を確実に行うコード | agent の fan-out・集約・閾値判定 |
| 呼ぶ人 | agent が Bash で叩く | `Workflow({ scriptPath })` でランタイムが実行 |

`docx` が workflow を持たないのは正しい。あのスキルは fan-out しない（1 agent が Python を叩くだけ）ので、orchestration を決定化する対象が無い。**「scripts/ があるから決定化済み」ではない**——見るべきは「ループと並列と閾値判定を誰が持っているか」。

### 参照実装と、本家との差

`anthropics/skills`（2026-08 時点）は `workflows/` ディレクトリを 1 つも持たず、`.js` は作画テンプレート 1 本のみ。本家 `skill-creator` も `agents/` + Python の `scripts/` で、全区間が Claude のターンごとの指揮で回る。**このリポジトリの skill-creator-best-practices はその直系だが、Phase 2–4 を `build_skill.js` に移した時点で本家より先へ出ている。**

継承したパターン表（`coordination-patterns.md` の 1–6）は dynamic workflows 以前の corpus 由来で、Workflow 実行型が候補に入っていなかった。本節が後から足されても選択経路に届いていなかったのが、fan-out するスキルを作っても script 化しない傾向の実際の原因。ステップ 0 の判定はそれを塞ぐために置いてある。

より進んだ参照実装は別リポジトリの `magi`（`stock-valuation-dcf`）:

- `.claude/workflows/{magi-deliberate,magi-implement,magi-close}.js` に**名前付き**で保存し、`/magi-deliberate` として起動
- skill 側は `agents/` `contracts/` `domains/` のみを持ち、`.js` を 1 本も持たない（**skill＝専門知識、workflow＝実行順序**の完全分離）
- 人間ゲートは workflow の境界に置き、gate FAIL は `status: "BLOCKED"` と理由・証拠を返して停止
- `evals/scenarios/28_workflow_execution_boundary.md` で「構造で解決された failure mode」と「honor system に残る failure mode」を切り分けて検証している

### script の置き場

公式は 3 つのサーフェスを認めているが、どれを使うべきかは**何も言っていない**。

| 置き場 | 起動 | 配布 |
|---|---|---|
| `<skill>/scripts/*.js` | skill が `Workflow({ scriptPath })` | skill 資産として plugin に同梱される |
| `.claude/workflows/*.js` | `/name`（保存済み workflow） | リポジトリローカル。plugin 配布されない |
| `plugins/<p>/workflows/*.js` | `/plugin:name` | plugin 資産として配布される |

**このリポジトリは `<skill>/scripts/*.js` に統一する。**

### 実行時制約（script を書く前に知っておく）

出典: [workflows docs](https://code.claude.com/docs/en/workflows)（2026-08-09 取得）。

| 制約 | 設計への影響 |
|---|---|
| **実行中のユーザー入力は不可** | 人間ゲートは workflow の境界に置く。段階ごとに別 workflow として回す |
| **script 自身からファイルシステム・shell を触れない** | 読み書き・コマンド実行は agent の仕事。script は agent を並べるだけ |
| **`import()` を含む script は起動前に失敗する** | ライブラリが要る処理は agent のタスクに寄せる |
| **同時実行は最大 16 agent**（CPU コア数次第でさらに少ない） | 100 件渡しても全部完走する。並列度は気にしなくてよい |
| **1 run あたり通算 1000 agent** | 暴走ループのバックストップ。通常の設計で当たる数ではない |
| `Date.now()` / `Math.random()` / 引数なし `new Date()` は throw する | resume を壊すため。時刻は `args` で渡し、乱択は index で prompt を変える |

`agent()` はユーザーが停止したり回復不能な API エラーになると `null` を返す。`pipeline()` はその `null` を配列に残すので、**結果を使う前に `.filter(Boolean)` する**。

### resume の意味論と、そこから出る設計則

停止した run を再開すると、完了済み agent は原則キャッシュから返る。ただし復元のルールが 2 つある。

> Cached results stop at the first agent that didn't finish, and every agent that started after that one runs again, even if it completed.

つまり A→B→C→D の順に起動して B の実行中に止めると、再開時は A だけがキャッシュから返り、**B・C・D は全部やり直し**になる（C・D が完了済みでも）。ここから設計則が出る。

> **A workflow that fans work out across many small agents therefore preserves more progress than one long agent.**

長い 1 agent に仕事を集めるより、小さい agent に fan-out した方が中断に強い。phase の粒度を決めるときの判断材料にする。

### pipeline と parallel の使い分け（既定は pipeline）

**`pipeline()` を既定にする。** 各 item がステージ間の barrier なしで独立に流れるので、wall-clock は「最も遅い 1 item の連鎖」であって「ステージごとの最遅の総和」にならない。

`parallel()` は **barrier**（全件揃うまで待つ）。これが正当なのは、次のステージが**前ステージの全件を横断して見る必要がある**ときだけ。

| barrier が正当 | barrier の理由にならない |
|---|---|
| 全件を突き合わせて dedup / merge してから高コストな後続へ渡す | 「flatten / map / filter したい」→ pipeline のステージ内でやればよい |
| 合計が 0 件なら後続を丸ごと省略したい（early exit） | 「ステージが概念的に別」→ pipeline はそれを表現する形。別 ≠ 同期が要る |
| 次ステージの prompt が「他の findings」を参照する | 「その方がコードが読みやすい」→ barrier の待ち時間は実在するコスト |

判定の目安：`const a = await parallel(...)` → `const b = transform(a)`（flatten/map/filter だけ）→ `const c = await parallel(b.map(...))` と書いていたら、その中間 transform に barrier は要らない。pipeline のステージに畳む。

**このスキル自身の `build_skill.js` が barrier を使っている箇所は正当な例**：Evaluate は with_skill と baseline を 1 つの `parallel()` にまとめて発行する。採点は必ず対で行う必要があり、片側だけ先に進めても意味がないため。逆に「なぜここだけ barrier なのか」を説明できない `parallel()` は pipeline に直す候補。

### 品質パターン（構造として強制するもの）

出典: [workflows docs](https://code.claude.com/docs/en/workflows)、[Introducing dynamic workflows in Claude Code](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code)（2026-08-09 取得）、および Workflow ツールの contract（セッション内のツール定義。公開 URL は無い）。

workflow の価値は「agent を増やせる」ことではなく、**品質パターンを構造として強制できる**ことにある。blog はこれを「independent attempts と、結果をあなたが見る前に壊しにかかる adversarial agents」と表現している。

| パターン | 形 | 効く場面 |
|---|---|---|
| **Adversarial verify** | 主張ごとに独立した懐疑者を N 体立て、**反証するよう**指示する。過半数が反証したら棄却 | もっともらしいが誤りの findings を落とす |
| **Perspective-diverse verify** | 同一の検証者を N 体ではなく、観点を変える（correctness / security / perf / 再現性） | 失敗の仕方が複数ある主張。冗長性では拾えない |
| **Judge panel** | 独立した N 案を別角度から生成 → 並列の judge が採点 → 勝ち筋を軸に、次点の良い部分を接ぐ | 解の空間が広い設計判断。1 案を反復するより強い |
| **Loop-until-dry** | 新規発見が K ラウンド連続でゼロになるまで探索を続ける | 件数が事前に読めない発見タスク。`while count < N` は尻尾を取りこぼす |
| **Multi-modal sweep** | 探し方の違う agent を並べる（コンテナ別・内容別・エンティティ別・時系列別） | 1 つの探索軸では全部見つからないとき |
| **Completeness critic** | 最後に「何が欠けているか（未実行の modality・未検証の主張・未読の source）」だけを問う agent を置く | その出力が次ラウンドの作業になる |
| **No silent caps** | top-N・リトライ無し・サンプリングで範囲を絞ったら `log()` に落とす | 黙った打ち切りは「全部見た」と読まれる |
| **Verified commit** | 永続状態（DB・索引・`resolved` フラグ・メモリ）への書き込みは、生成側と別 context の verifier が再取得した証拠を record に持つときだけ script が受理する | 「登録した」「解決した」が自己申告で通ると、後段はそれを前提に動く。§14 |
| **乾き停止** | 反復の停止条件を「新しい findings が出なくなった」に置き、判定材料（novelty マーク・件数）を script が算出する。回数上限は backstop | 回数で止めるループは、学び切る前に止まるか、学び終えても回り続ける。§13 反復の停止と戻り先 |
| **スコープの梯子** | 失敗の種別（実装 / 基準 / 前提 / 問い）ごとに戻り先の辺を持ち、judge が分類する | 戻り先が 1 種類だと、前提が崩れていても浅い段を掘り続ける（局所最適）。§13 同上 |

blog が挙げる収束形は「独立した角度から取り組む agent 群 → 別の agent がそれを反証しにかかる → 答えが収束するまで反復」。上表の adversarial verify と loop-until-dry の組み合わせにあたる。

`schema` オプションを渡すと agent は構造化出力を強制され、検証済みオブジェクトが返る。**検証結果は schema の `failed[]` で受け取り、markdown 中の ❌ を数えない**（書式に判定を依存させない）。

### 規模とコスト

- 1 run のトークン消費は通常のセッションより桁で大きくなりうる。blog も docs も「まず狭いスコープで 1 回試して感触を掴む」ことを勧めている
- size guideline（`/config`）は Claude が狙う agent 数の目安。`small` < 5 / `medium` < 15（既定）/ `large` < 50 / `unrestricted`
- 25 agent 超、または予測トークンが 150 万を超えると `Large workflow` 警告が出る（助言であって停止はしない）
- **モデルは既定でセッションのモデル**。安く済むステージだけ明示的に落とす。`effort` も同様（機械的なステージは `low`、最も難しい verify / judge だけ上げる）

規模はタスクに合わせる。「バグを探して」なら finder 数体＋単票 verify、「徹底的に監査して」なら finder を増やし 3〜5 票の adversarial pass と統合ステージを置く。

---

## 14. ハーネス設計 — モデルに面したインターフェースと状態

一次情報: [Six Agent Harness Capabilities（NVIDIA Technical Blog）](https://developer.nvidia.com/blog/six-agent-harness-capabilities-for-higher-model-performance/)（[arXiv:2607.20709](https://arxiv.org/abs/2607.20709)）、
[How enabling two settings tripled our scores on ARC-AGI-3（OpenAI）](https://openai.com/index/how-two-settings-tripled-our-arc-agi-3-scores/)、
[NVIDIA AVO reaches 100% on ARC-AGI-3（NVIDIA Technical Blog）](https://developer.nvidia.com/blog/nvidia-avo-reaches-100-on-arc-agi-3-demonstrating-a-frontier-level-general-purpose-architecture-for-long-horizon-autonomous-agents/)（[arXiv:2603.24517](https://arxiv.org/abs/2603.24517)）。
整理の出典（二次）: [Long-Horizon Agent の設計原理（岡野原大輔・X）](https://x.com/hillbig/status/2091320304329269722) — PARC [arXiv:2512.03549](https://arxiv.org/abs/2512.03549) / Argus / InfiAgent / File-as-Bus への索引として参照する。
いずれも 2026-08-23〜24 取得。数字は一次ソースと照合済み。

**ハーネス**とは、モデルを取り囲んでタスクを遂行させる周辺設計の全体（context に何を入れるか、
ツール結果をどう返すか、状態をどこに持つか、ループを誰が回すか、完了を誰が判定するか）。
スキルは SKILL.md・agents・scripts・schemas の形でこのハーネスを定義している。

同じモデルでもハーネスで結果が桁で変わることが、実測で示されている:

| 実測 | 数字 |
|---|---|
| OpenAI: ARC-AGI-3 公式ハーネス → reasoning 保持 + compaction | GPT-5.6 Sol 13.3% → 38.3%、出力トークン 1/6 |
| NVIDIA NOOA: SWE-bench Verified、同じ GPT-5.5 | 82.2%（29 呼び出し・110 万 token）vs 比較ハーネス 78.2%（66 呼び出し・220 万 token）。context compaction 不要 |
| 本書の較正実験: ARC-AGI-3 `ls20`、同じモデル・同じ action 予算 300 | ハーネス設計 v1 → v3 で 2 → 3 レベル、L1 通過時の action 187 → 68（下記「較正」） |

NVIDIA AVO（Claude Opus 5 で ARC-AGI-3 public set 183 レベル全問）はこの表に入れない。NVIDIA 自身が
「統制された ablation ではない（agent backend・観測表現・memory・context 管理が全て異なる）」と明記し、
論文も memory・supervisor・lineage の個別寄与を測っていないため、「ハーネスで同じモデルが何倍になったか」
の数字として使えない。AVO から持ち込めるのは構造（⑤ の例）だけ。

§5（決定的処理の分離）・§11（fresh-context verifier・メモリ）・§13（orchestration の決定化）は
ハーネスの「誰が回すか」側を扱っている。本節はその先、**モデルに何を見せ、状態をどこに置くか**を
扱う。NOOA は Python クラスという形でこれを実現しているが、スキルに持ち込むのは形ではなく原理
（Claude Code のスキルは Python クラスではない）。

### 原理とスキルへの写像

| # | 原理（出典） | スキルでの形 | 既に持っている場所（本書の節、または参照実装 `magi`（別リポジトリ `stock-valuation-dcf`）） |
|---|---|---|---|
| ① | **状態は履歴ではなくオブジェクトに**（NOOA explicit object state / InfiAgent「history ではなく state」/ File-as-Bus「thin control over thick state」） | 現在の状態（phase・決定・制約・未解決・成果物パス）を state ファイルか script 変数に持つ。agent に渡すのは「現在の状態 + 直近の固定幅」であって transcript ではない。再開は state から。**切るのはタスク/レベル境界であって試行単位ではない**（④ との粒度の違い。較正 1） | §13 の script 変数。MAGI の `state.json` + Phase Capsule |
| ② | **参照渡し — ツール結果を context に往復させない**（NOOA pass by reference） | subagent は全文をファイルに書き、親へは要約 + findings + パスだけ返す。script は判定に要る結果だけを出力する（案内文・進捗ナレーションを混ぜない）。NOOA は transcript が追記専用になり prefill cache が効き続けることでトークンを半減させた | §13「中間結果の置き場 = script 変数」。token-budget の「親へ戻す出力を選別」 |
| ④ | **reasoning を捨てない。compaction は truncation ではない**（OpenAI） | ステップ間で「なぜそう決めたか」を落とすと、agent は毎ターン問題を一から解釈し直す（公式ハーネスの 13.3% の主因）。同じタスクの再試行で agent を作り直すと同じことが起きる（較正 1）。capsule には決定・制約・根拠・未解決・却下案を残し、要約のために削らない。古い方から捨てる rolling truncation は初期の観察を失い、満杯付近で動く時間を長くする | token-budget の NG リスト（Hard Constraints / concerns / Sources は削らない） |
| ⑤ | **検証済みだけを永続化し、却下経路も状態に残す**（Argus verification → review → commit / rejected route。AVO は正しさ検査を通りスコアを維持/改善した候補だけを git commit し、失敗は 0 点で lineage に残す） | DB 登録・索引・`resolved`・メモリへの書き込みは、生成側と別 context の verifier が再取得した証拠を持つ record だけを script が受理する（§13 表の Verified commit）。**verified にはスコープ（どの条件下で観測したか）を必ず付ける** — 無スコープの verified は後段で反証されても捨てられず探索を抑圧する（較正 2）。試して却下した案、実行した事実も state に書く — 無いと次のループや resume で同じ失敗を繰り返すか二重実行する。rule に抽象化したとき落ちる情報は生の手順側に残す（較正 4） | §11 fresh-context verifier（検証の独立性）。本項はその出力を**受理する条件**を足す |

NOOA の残り 2 つは本書で既出: code as action（複数操作を 1 本のコードに）は §5、
model-callable harness API / agent 自身が curation するメモリは §11「1 教訓 1 ファイル + 既存更新・
重複禁止・誤り削除」。NOOA の memory +11.8 pt は NOOA 固有の memory subsystem の数字で、
スキルのメモリファイルに転用できる保証はないため根拠には使わない。

### 制約を足した根拠（§12「制約は失敗から育てる」）

- ⑤ は実失敗から来ている。`notion-organize-knowledge` は `db_registered: true` という根拠の無い
  boolean を verifier が転記するだけで `registered` を受理していたため、1 回の run で 13 件が
  DB に 1 行も無いまま「登録済み」になった（2026-08-23）。受理条件を query の証拠に置き換えて
  構造で閉じた
- ① は MAGI で state ファイル導入前に 1 session で continue 介入が 22 回起きたことが根拠。
  Coordinator が履歴から「どこから再開するか」を復元できなかった
- ④ は OpenAI が公式ハーネスの低スコアを調べて見つけた 2 要因（reasoning 破棄・rolling
  truncation）がそのまま根拠
- ⑤ のスコープ要件・supervisor の制限・探索義務は下記の較正実験が根拠

### 較正: 公開された制約から再構成したハーネスを自分で測る（2026-08-24）

AVO の ARC-AGI-3 設計は公開情報が原理レベルまでしかない（テキストグリッド観測・persistent memory・
停滞を検知する supervisor・lineage）。そこで公開された制約（6,624 action / 183 レベル ≒ 36 action
/レベル、64×64 観測 × 数千手は 1 window に入らない）から設計を逆算し、`arc-agi` toolkit のローカル
環境（`ls20`、7 レベル、4 action）で、同じモデル・同じ action 予算 300 でハーネスだけを変えて測った。
各 1 run（n=1）なので優劣の結論には使わず、**失敗機序の特定**に使う。

| run | ハーネス | レベル | action | 失敗機序 |
|---|---|---|---|---|
| v1 | レベルごと + **試行ごと**に fresh agent、memory を verifier gate で commit、supervisor が仮説を供給 | 2 | 300 | 再試行のたびに盤面理解を再導出 |
| v2 | レベルごとに fresh agent、**試行は同一 agent を継続**（supervisor は SendMessage で介入）、memory 同上 | 2 | 287 | L0–1 で verified にした「panel 一致 + ゴール進入 = クリア」が L2 で anchor になり、唯一未踏の前提タイルを 147 action 踏まなかった。supervisor の仮説（bar コスト）も誤誘導 |
| v3 | v2 + **rule にスコープ明記** + **未踏の特殊要素は結論前に必ず踏む** + **supervisor は redirect のみ（仮説を出さない）** | 3 | 269 | L2 を最初の試行で前提タイル発見。L1 通過時 action は v1 187 → v2 142 → v3 68 |
| baseline | 1 session・memory なし | 3 | 279 | prior が無いので素直に探索 |

ここから本節に入れた修正:

1. **①（状態の外部化）と ④（reasoning 保持）は粒度が違う。** session を切るのはタスク/レベル境界。
   試行単位で切ると ④ を壊して性能が落ちる（v1）
2. **verified commit にはスコープが要る。** 「L0–1 で観測」を普遍則として渡すと、次段で反証されても
   捨てられず探索を抑圧する（v2）。verified は「何を・どの条件で」の組で持つ
3. **supervisor は redirect のみ。** 停滞検知と未探索領域の指摘に限り、仮説を供給しない。供給した仮説は
   v1・v2 とも誤誘導になった。NVIDIA の記述も「別の方向へ steer する」であって答えを出すことではない
4. **探索義務は memory の prior より優先する。** 未踏の特殊要素を 1 回は踏んでから結論する（v3）。
   rule 抽象化で落ちた情報（L0 の「key を取る」手順）は生の手順側に残っていた — ⑤「実行した事実も
   状態に残す」の意味はこれ
5. **環境の非決定性を測る。** action ログを再生すると L2 以降で分岐した（launch pad の発火が試行ごとに
   異なる）。比較は seed 固定か複数試行でしか成立しない


#### 追試: pdca スキルによる 3 周ループ（2026-08-24）

上の 4 run を基に作った `pdca` スキル（別 plugin）で、同じ環境の主張検証
（「36 action/レベル」の再現性）を 3 周回した。各周 6 run・同一条件・基準は実行前固定。

| 周 | 有効 n | 結果 | 前周の revise が効いたか |
|---|---|---|---|
| 1 | 3/6 | 指標が「打ち切り時刻」に崩壊（87-100）。撤退を報奨する向きの逆転・生存者バイアスを verifier が検出 | — |
| 2 | 4/6 | L1 クリアコスト 19/29/39/61。ただし 1 run が port 割当を破り session 共有 → 打ち切り値の二重計上を mechanism-analyst が特定 | 指標崩壊は解消 |
| 3 | 6/6 | 13-63（中央値 ≈26.5、CV ≈57%）。初期盤面 sha256 が 6 run 一致し同一条件を機械確認 | session 共有はゲートで検出可能に |

結論は「桁は 36 と同水準だが、CV は事前基準 25% を超え、単発値は代表値にならない」。ここから足した知見:

- **指標は崩壊しうる**。分母が退化すると指標は「測りたいもの」から「打ち切り時点」に化け、撤退を
  報奨する向きの逆転が起きる。基準には指標名・向き・censoring（打ち切り run の扱い）を実行前に登録する
- **測定ゲートも検証対象**。「measured の機械条件」は session 共有を検出できなかった（共有 log でも
  条件を満たす）。独立性は port 強制 + raw_log ペア突合のような**別経路の証拠**で確認する
- **verifier が宣言された検証を省略しても pass が付く**のが残欠陥（cycle 3 で raw_log 突合が一部未実施の
  まま met 扱い）。宣言済み検証の不実施は unverified に落とす規則が要る（pdca 0.1.1 で対応）

### 評価はハーネスも測る

- with_skill / baseline の delta は「指示の差」のつもりでも、context 方針・ツール・API 設定が
  違えばその差を測ってしまう。比較では**ハーネスを固定**し、指示だけを変える。環境に非決定性が
  あるなら seed 固定か複数試行（較正 5）
- 低スコアに出会ったら、モデルを疑う前にハーネス設定を疑う（OpenAI の教訓はこれ自体）。
  公開ベンチマークは意図的に素朴なハーネスを使う（欠点を見えやすくするため）ので、そのスコアは
  商用ハーネス下の性能を表さない
- ハーネスを整えても長時間委任の劣化は消えない（DELEGATE-52: フロンティアモデルでも長時間
  ワークフローで文書内容の平均 25% が破損）。長く走らせる設計ではなく、§11 の「小さい agent
  への fan-out」で区切る。⑤ は区切りの手段ではなく、区切った先で永続化を受理する条件

### 持ち込まないもの

- NOOA の「agent = Python クラス」、AVO の「進化探索の variation operator」という形そのもの。
  スキルが扱うのはインターフェースの原理で、フレームワークの置き換えではない
- 「常に参照渡しせよ」「transcript を渡すな」「常に fresh session」のような一律ルール。全文中の広範な
  相互依存を検証する必要がある場面では全文を渡すのが正しい（token-budget の例外と同じ）し、
  同一タスク内の再試行では session を保つのが正しい（較正 1）。§12 の right altitude で較正する
