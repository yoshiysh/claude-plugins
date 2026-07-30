# Notion 記録ガイド（Step 5 用）

`/chat` の相談内容と Fable の回答を Notion データベースへ 1 相談 = 1 レコードで記録するための
ガイド。**Coordinator（SKILL.md 実行者）自身が Notion ツールを直接呼ぶ**（Agent tool 経由の
subagent には委譲しない。理由は下記 §subagent が継承できないケイパビリティ を参照）。

## 保存先

Notion データベース「Fable 相談ログ」（親ページ: `Fable`、
`https://app.notion.com/p/394ff60e509880d88e4ce1b1e785fc71`）。

data source: `collection://bf6dfdb4-2a39-4a47-af26-0ac6a526d1e1`

Notion ツールが deferred（未ロード）の場合は、まず ToolSearch で `notion-create-pages` 等を
ロードすること。

## スキーマ

- `相談サマリ`（title）: 相談内容を要約した 1 行（40 文字程度、具体的で検索しやすいもの。
  「DCFのDecimal丸め誤差について」のような固有性のある要約。「相談」「質問」等の空疎な語のみの
  要約にしない）
- `相談日時`（date、`date:相談日時:start` プロパティ）: 把握できる日付があれば設定。省略可
  （Notion 側の自動 `createdTime` が別途記録されるため必須ではない）
- `分類`（multi_select）: `technical` / `design` / `security` / `code-review` / `other` から
  該当するものを 1 つ以上選ぶ

## ページ本文の構成（Notion Markdown）

3 セクションいずれも要約・改変せず、受け取った内容をそのまま転記する（非改竄原則は
relay-formatter だけでなく記録にも適用される。ログが原文と食い違うと、後で見返したときに
何が実際にあったかを再現できなくなるため）。

```markdown
## 相談内容

{[USER_CONSULTATION] をそのまま}

## Fableの回答（ユーザー提示版）

{[FORMATTED_RESPONSE] をそのまま}

## Fable生分析（raw）

{[RAW_ANALYSIS] をそのまま}
```

## subagent が継承できないケイパビリティ（Notion に限らない一般原則）

Notion MCP は claude.ai 上でインタラクティブに認可されたコネクタであり、Agent ツールで起動した
subagent はこの認可済み接続を継承しない（実際に subagent 経由で `notion-create-pages` を呼んだ
ところ「Notion への接続が現在認証されていません」で失敗し、Coordinator 自身の呼び出しでは同じ
セッションで問題なく成功することを確認済み）。

これは Notion 固有の問題ではなく、**subagent が継承できないケイパビリティ（インタラクティブ
認可済みコネクタ、対話的セッション状態等）に依存する呼び出し全般**に当てはまる一般的な制約
である。他の Step（investment-topic-router 等）が「script 実行・別スキル呼び出しは常に agent
経由」という設計原則に従っているのに対し、この Step だけ例外的に Coordinator 直接呼び出しに
するのは、判断の複雑さではなく**ツールアクセス権限の制約**が理由であり、設計原則そのものを
緩めるものではない。

**この例外を導入する際の規律**: 推測で「subagent は継承できないだろう」と決めつけて例外化
しない。実際に subagent 経由で試し、失敗を実測してから例外化すること（本 Step 自体、当初は
subagent 委譲で設計し、実地で失敗を確認してから Coordinator 直接呼び出しに変更した）。

**未検証の類似リスク**: `investment-topic-router`（agent）が `Skill({skill:
"investment-strategist"})` を呼ぶ経路も、同じ「subagent コンテキストからの委譲呼び出しが
実際に機能するか」という懸念を共有する。investment-strategist 自体は script 実行・
riopon-rag・MAGI 等、インタラクティブ認可コネクタに依存しない構成であるため実害の可能性は
低いと推測されるが、実地確認はまだ行っていない（`references/delegation-contract.md`
§今後の再検証ポイント も参照）。

## エラー時の挙動

- Notion ツール呼び出しが失敗した場合（未認可・API エラー等）、リトライは 1 回のみ試し、
  それでも失敗する場合は諦める。ユーザーには一切伝えない（Step 4 の出力は既に返しているため、
  記録の成否はユーザー体験に影響させない）。
- 未認可エラーの場合は、次回以降の `/chat` でも同じ理由で失敗し続ける可能性が高い。同一
  セッション内で複数回連続して認可エラーが起きた場合のみ、ユーザーへ一言（Notion 連携の認可が
  必要である旨）を伝えてよい（毎回は伝えない。Step 4 の出力を汚さないよう、伝える場合も
  応答の末尾に短く添える程度に留める）。
