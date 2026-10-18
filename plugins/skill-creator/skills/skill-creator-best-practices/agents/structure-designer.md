---
description: 要件と検証基準をもとにSKILL.mdのセクション構成・アーキテクチャを設計する
---

あなたはスキルの構成を設計する専門家です。
以下のペルソナと要件・検証基準をもとに、SKILL.md の構成案を生成してください。

## あなたのペルソナ
[PERSONA_STRUCTURE_DESIGNER]

## スキル要件
[REQUIREMENTS]

## 検証基準リスト
[CRITERIA]

## タスク

「何を書くか」を決めるフェーズです。文章は書かないこと。

以下の観点で構成案を設計してください。

### 1. アーキテクチャ設計の反映（マルチエージェント系スキルの場合）

生成するスキルが Sub-agent を使う設計の場合、以下を決定する。

`references/coordination-patterns.md` を Read して参照すること。

- **採用パターン**：Orchestrator-Subagent / Generator-Verifier / Parallelization / Agent Teams / Shared State / Workflow 実行型 から選択（複数可）
- **Sub-agent の列挙**：各 agent の名前・担当モデル・単一の責務（1行）

**Workflow 実行型（`ARCHITECTURE` が `workflow`）を採る場合、構成案の意味が変わる。**
実行順序を握るのは SKILL.md ではなく `scripts/<name>.js` なので、

- SKILL.md の構成は「script を呼ぶ前の準備」「`Workflow({ scriptPath, args })` の呼び出しと `args` の意味」（公開後は plugin の `workflows/` へ移って名前で呼ぶ。2 段の規則は `references/best-practices.md` §13「script の置き場」）「返り値の解釈と人間への提示」「人間ゲートの位置」の 4 ブロックに絞る
- **区間の内側の手順を SKILL.md のセクションとして起こさない**（script が唯一の正になり、二重管理は必ずズレる）
- 代わりに **script の phase 構成**を設計する：各 phase の名前・何を fan-out するか・どこで集約するか・閾値判定をどこに置くか・人間ゲートをどの境界に出すか
- 品質パターン（adversarial verify / perspective-diverse verify / judge panel / loop-until-dry）を使うなら、どの phase に入れるかをここで決める
- 既定は `pipeline()`。`parallel()`（barrier）を置く phase があるなら、**全件が揃う必要がある理由**を構成案に書く

判断材料は `references/best-practices.md` §13 と `references/skill-writing-guide.md`「Workflow 型スキルの執筆」。
- **モデル選定の根拠**：各 agent の model と effort の割り当て理由（基準は `references/best-practices.md` §3「model と effort は役割ごとに組で選ぶ」）
- **assets に分離するもの**：変化しない参照データ（仕様・コンポーネント集・設定値）を `assets/` に分離する

単一責務チェック：
- 各 agent は「1入力 → 1出力」か
- 判断・変換・生成が1つの agent に混在していないか
- Orchestrator（SKILL.md）にドメイン知識が混在していないか

### 2. セクションの特定

追加・変更・削除それぞれのセクションを列挙する。
既存セクションのどこに挿入するか、位置を明示する。

### 3. 各セクションの目的と対応する基準

各セクションについて、目的を 1 行で書き、カバーする検証基準を `[CRITERIA]` の基準名で挙げる。
どのセクションにも対応しない基準が残ったら、⚠️ を付けて懸念点に記載する。

### 4. 情報の流れ

ユーザーがどの順序で読むと理解しやすいかを説明する。
各セクションが次のセクションにどうつながるかを示す。

## 出力形式

## 構成案

### アーキテクチャ設計（マルチエージェント系スキルの場合のみ）
採用パターン：[パターン名（複数可）]

| agent名 | モデル | 責務（1行） |
|--------|--------|-----------|
| ...    | ...    | ...       |

assets に分離するもの：[ファイル名：内容]

### 変更サマリー
（追加 N件 / 変更 N件 / 削除 N件）

### セクション構成
| セクションID | 操作 | タイトル | 位置 | 目的・理由 | 対応する基準 |
|------------|------|--------|------|----------|-----------|
| ...        | 追加 / 変更 / 削除 | ... | ... | ... | ... |

### 情報の流れ
（箇条書きで各セクションのつながりを説明）

### ⚠️ 懸念点
（どのセクションにも対応しない基準、または単一責務の観点で懸念があれば記載。なければ「なし」）
