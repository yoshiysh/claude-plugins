---
name: notion-organize-knowledge
description: >
  Notion MCP を使って Notion workspace を DB 中心の知識ベースへ整理するスキル。Knowledge Index
  データベースの作成・保守、Inbox や未分類ページの分類、Summary 生成、Source と Decision の分離、
  Canonical / Exportable 設定、重複・古いページの検出、Markdown/RAG 移行しやすい本文正規化を行う。
  Use when the user says 「Notion を整理して」「Notion のメモを DB 化したい」「AI 検索や将来 RAG に備えてページを正規化して」
  など。単一リンクの要約、Notion 以外のベクトル DB 構築、Obsidian への全面移行作業は対象外。
---

# Notion 知識整理スキル

採用パターン：Orchestrator-Subagent + Generator-Verifier。

Notion を作業場・閲覧 UI・入力口として使いながら、将来 Markdown export や自前 RAG に逃がせる形へ知識ページを整理する。SKILL.md は進行管理だけを担い、Notion の読み取り・分類・更新・検証は `agents/` の各 Sub-agent が担当する。分類基準と DB スキーマは `references/knowledge-model.md`、エージェント間の入出力契約は `schemas/agent-contracts.md` を正とする。

## 全体フロー

```
ユーザーの依頼
  │
  ▼
agents/input-resolver
  │  対象範囲・Notion MCP 利用可否・処理上限・確認要否を整理
  │
  ▼
agents/index-maintainer
  │  Knowledge Index DB を検索し、無ければ作成案または作成結果を返す
  │
  ▼
agents/page-triager
  │  対象ページを読み、Type / Area / Status / Summary / Source URL / Canonical 候補を分類
  │
  ├──────────────┐
  ▼              ▼
agents/page-normalizer   agents/duplicate-reviewer
  │  本文とプロパティの更新案を作る/適用   重複・古いページ・Canonical 候補を検証
  └──────────────┘
          │
          ▼
agents/update-verifier
          │  更新結果と判断不能項目を検証
          ▼
司令塔が完了報告
```

## 実行手順

### Step 1: input-resolver を呼ぶ

`agents/input-resolver.md` を Read し、ユーザー依頼全文、現在分かっている Notion workspace 情報、希望件数を渡す。対象範囲が空、または Notion MCP が使えない場合はここで止め、足りない情報だけをユーザーに聞く。

処理件数は既定 20 件までにする。大量ページを一度に更新すると Notion 側の状態把握が難しくなるため、残件数を報告して次回に続ける。

### Step 2: index-maintainer を呼ぶ

`agents/index-maintainer.md` を Read し、Step 1 の scope と `references/knowledge-model.md` を渡す。`Knowledge Index` が無い場合、ユーザーが「作ってよい」と明示していれば作成する。明示がない場合は作成案を返し、司令塔が確認する。

既存 DB がある場合は破壊的変更をしない。足りないプロパティは追加候補として扱い、既存プロパティ名の変更や削除は確認してから行う。

### Step 3: page-triager を呼ぶ

`agents/page-triager.md` を Read し、対象ページ一覧、Knowledge Index の data source ID、分類基準を渡す。各ページを Notion MCP で読み、以下を判定させる。

- `Type`
- `Area`
- `Status`
- `Summary`
- `Source URL`
- `Tags`
- `Canonical` 候補
- `Exportable` 候補
- 判断不能な項目と理由

事実が足りない項目は空欄または `Unknown` にする。AI が推測で著者、日付、出典、結論を埋めると後の検索品質が悪くなるため、根拠が取れない項目は埋めない。

### Step 4: page-normalizer と duplicate-reviewer を呼ぶ

Step 3 の結果をもとに、独立して実行できる場合は同一ターンで並列に呼ぶ。

- `agents/page-normalizer.md`: ページ本文と DB プロパティの更新案を作る。ユーザーが一括整理を許可している場合だけ Notion に適用する。
- `agents/duplicate-reviewer.md`: 類似ページ、古いメモ、正式ページ候補を検出し、Canonical / Duplicate / Stale の扱いを提案する。

削除、不可逆な本文置換、大量移動、既存 DB スキーマの破壊的変更は行わない。必要なら候補として報告して確認する。

### Step 5: update-verifier を呼ぶ

`agents/update-verifier.md` を Read し、更新結果、重複レビュー、判断不能項目を渡す。検証結果が `status: revise` の場合は page-normalizer に1回だけ差し戻す。2回目も失敗する場合は、失敗理由と対象ページをユーザーへ提示して止める。

### Step 6: 完了報告

司令塔は以下を短く報告する。

```text
Notion知識整理完了:
- 処理: {N}件
- 更新済み: {A}件
- Canonical設定/候補: {C}件
- 重複/古い可能性: {D}件
- 判断不能: {U}件
- 未処理: {R}件
- 次に人間が見るべきページ: {titles}
```

## 入出力

入力：ユーザーの Notion 整理依頼、対象ページ名または Inbox / Area / DB 名、必要なら処理件数。

出力：Notion 上の DB / ページ更新、または更新前のレビュー用変更案。完了報告には処理件数、変更内容、未確定項目、次の確認対象を含める。

## 境界

- Notion は RAG エンジンそのものではなく、知識 UI と MCP 経由の検索・文脈取得の場として扱う。
- 自前 RAG が必要な場合は、このスキルで整えた `Summary`、`Source URL`、`Canonical`、`Exportable` を使って Markdown/JSON export へつなぐ。
- 単一リンクの要約だけならこのスキルではなく通常の要約タスクとして扱う。
