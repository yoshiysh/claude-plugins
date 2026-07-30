---
name: chat-rigorous
description: >
  技術的な壁打ち・分析・レビュー相談（プロジェクト全体の評価、既存文書/Issue のレビュー、
  設計判断の壁打ち等）に対し、反証耐性の高い分析ワークフロー（24 パターン）を明示的な instructions
  として analyst agent に強制し、Sonnet / Opus 等どのモデルでも Claude Fable 5 相当の厳密な分析品質を
  再現するスキル。ユーザーが `/chat-rigorous` に続けて対象/トピックを入力したときにのみ起動する
  （自然文トリガーは対象外）。analyst は助言に徹し、調査目的の Read/Grep/Bash は行うが、ファイル変更・
  コマンドによる状態変更は行わない。相談内容が投資判断（銘柄評価・買い時/売り時・組み入れ・
  ポートフォリオ・目標株価等）を含む場合は investment-strategist スキルへ完全委譲し、このスキル自身は
  投資判断を一切扱わない。雑談・空入力には案内文を返して終了する。
---

# Chat-Rigorous（厳密分析・壁打ちスキル）

技術的な相談・レビュー・自己評価に対し、**反証耐性の高い分析ワークフロー（4 つの生成原理と 24 パターン）**を
明示的な instructions として `analyst` agent に踏ませることで、モデル非依存に厳密な分析を返す。

既存の `/chat` が Claude Fable 5 の素の分析能力に依存するのに対し、本スキルは「思考の型」を
instructions 化して強制する。これにより Sonnet / Opus 等でも Fable 5 相当の分析品質を目指す。

このスキル自身は分析結果を生成しない。**分析は `analyst` agent が生成原理に基づき（派生形として
24 パターンを用いて）行い、自己チェックを経て出力を確定する。** SKILL.md（Orchestrator）は「誰に何を
渡すか」だけを制御する。スクリプト実行・別スキル呼び出しの判断はいずれも Sub-agent の責務であり、
SKILL.md からは直接呼ばない。

## 役割（何をするか）

1. `/chat-rigorous <対象/トピック>` の相談を受け取る
2. `investment-topic-router` agent（既存 chat スキルのものを再利用）に投資トピック判定と委譲判断を委ねる
3. 非投資の相談は、`analyst` agent に渡して生成原理に基づく（派生形として 24 パターンを用いた）分析をさせる
4. analyst の出力をそのままユーザーへ返す（整形の中間 agent は挟まない）

## 何をしないか（境界）

- **投資判断を扱わない**：銘柄評価・売買タイミング・PF 相談・目標株価は investment-strategist に完全委譲する。
  理由：投資助言の規制境界・売買命令ガードは investment-strategist が一元管理しており、本スキルで
  重複実装すると境界が二重管理になり漏れが生じる。
- **analyst に状態変更させない**：ファイル変更・コマンドによる状態変更はさせない。deliverable は
  「assessment（見解）」であって「fix（修正の適用）」ではない。ただし調査目的の Read/Grep/Bash
  （テスト実行での挙動確認を含む）は許可する — 生成原理と 24 パターンの多く（実測値・file:line 引用・
  事実照合）は実際にコードを読まないと成立しないため。この read と write/execute の区別は analyst 本体で
  明示する。
- **SKILL.md がスクリプト・別スキルを直接呼ばない**：投資トピック判定（script 実行）と
  investment-strategist への委譲（Skill 呼び出し）はいずれも `investment-topic-router` agent の責務とし、
  SKILL.md はその agent を呼ぶとだけ書く。
- **Notion 記録はしない**：本スキルはログ記録機能を持たない（`/chat` との差別化点）。

## 既存 chat スキルとの関係（investment-topic-router の再利用）

投資トピック判定と investment-strategist への委譲は、**既存の
`[SKILL_DIR]/../chat/agents/investment-topic-router.md` をそのまま参照・呼び出す**（コピーしない）。
理由：投資判定ロジックと規制境界は investment-strategist 側で進化しうる。判定 agent をコピーすると、
将来 investment-strategist の規制ロジックが変わった際に二重管理・ドリフトが発生する。単一の判定 agent を
両スキルで共有することでこれを避ける。

## フロー

```
/chat-rigorous <対象/トピック>
  │
  ├─[0] 空入力 / コマンドのみ / 明らかな雑談  → 案内文を返して終了（agent に渡さない）
  │
  ├─[1] investment-topic-router（既存 chat スキルの agent, model: sonnet）
  │       [SKILL_DIR]/../chat/scripts/detect_investment_topic.py を実行し、投資トピックなら
  │       Skill({skill: "investment-strategist"}) を agent 自身が呼んで結果を relay。
  │       proceed: false を返せば、その relayed_response をそのままユーザーに返して終了。
  │       proceed: true を返せば [2] へ続行。
  │
  └─[2] analyst（agent, model は呼び出し時指定・デフォルトはセッション model 継承）
          対象/トピックを受け取り、references/analytical-workflow.md を読んだ上で、
          実際に対象を調査（Read/Grep/Bash）し、生成原理に基づき（派生形として 24 パターンを用いて）分析。
          敵対的自己チェックを経て出力を確定し、ユーザーへ返す。
```

## Step 0: 事前 short-circuit（SKILL.md が直接判定する分岐）

`<対象/トピック>` が空、空白のみ、またはコマンド語だけの場合、agent に渡さず以下を返して終了する。
理由：これは判断ではなく完了条件（フロー制御）そのものであり、agent 委譲の対象外。

```
厳密に分析・レビューしてほしい対象を続けて書いてください。
例: /chat-rigorous このプロジェクトの現状を評価して、今後の優先順位を提案してほしい
例: /chat-rigorous src/pricing/rounding.py の丸め処理、境界値で破綻しないか見てほしい
```

`<対象/トピック>` が明らかに分析相談でも投資相談でもない雑談的入力（例：「今日の天気は」「元気？」）の
場合も、同様に agent に渡さず以下を返して終了する。理由：雑談を router → analyst まで流すのは無駄な
ホップであり、description が約束する「雑談には案内文を返す」を本文フローで担保するため（判定は複雑な
分類を必要とせず、Step 0 の完了条件の一部として扱える）。

```
このスキルは技術的な分析・レビュー・設計の壁打ち（プロジェクト評価・文書やIssueのレビュー・
設計判断の相談等）向けです。分析したい対象を書いて `/chat-rigorous` で呼び出してください。
```

**ただし、曖昧だが実体のある相談（例：「なんかこの認証まわり、色々ヤバい気がする」）は打ち切らず
Step 1 へ進める。** 曖昧さは相談内容の未整理であって雑談ではなく、それを整理して結論に導くのが本スキルの
仕事だから。Step 0 で弾くのは「分析対象が存在しない入力」だけに限る。

## Step 1: investment-topic-router を呼ぶ（既存 chat スキルの agent を再利用）

`[SKILL_DIR]/../chat/agents/investment-topic-router.md`（**同一 plugin に同梱された兄弟スキル。コピーせず直接 Read する**）を読み、
以下を渡して呼ぶ。

- `[USER_CONSULTATION]`: ユーザーが渡した対象/トピックの文字列を**そのまま**渡す。
  （パス指定のみ（例：`src/pricing/rounding.py`）のような投資キーワードを含まない入力は、当然
  script 側で `is_investment_topic:false` となり proceed:true が返る。）

このagentは内部で `[SKILL_DIR]/../chat/scripts/detect_investment_topic.py` を実行し、投資トピックなら
`Skill({skill: "investment-strategist"})` へ自ら委譲、非投資なら proceed:true を返す。

出力：`{"proceed": bool, "relayed_response"?: string, "note"?: string}`

- `proceed: false` の場合：`relayed_response` をそのままユーザーに返して終了する（analyst は呼ばない）。
- `proceed: true` の場合：Step 2 へ続行する。**`note` が付いていた場合（script エラー時の断り書き）は
  破棄せず保持し、Step 2 の analyst 出力の末尾に付記して返す**（下記参照）。

**`note` を握り潰さないことが重要な理由**：既存 `/chat` では `note` は relay-formatter が最終出力末尾に
添える設計になっている。chat-rigorous には relay-formatter に相当する整形 agent がいないため、
`note` を受け取った SKILL.md（Orchestrator）自身がこれを保持し、Step 2 の出力に付記する責務を負う。
ここを見落とすと、script エラー時にユーザーへ届くはずの断り書き（「投資判断のご相談なら
investment-strategist をご利用ください」）が経路として存在しなくなる（既存の chat-rigorous 初版で
実際に発生していた欠落）。

## Step 2: analyst を呼ぶ

`agents/analyst.md` を読み、以下を渡して呼ぶ。**`model` は呼び出し時に指定可能で、デフォルトは
セッションの model を継承する**（SKILL.md では固定モデルを指定しない。理由は §モデルポータビリティ）。

- `[USER_CONSULTATION]`: ユーザーが渡した対象/トピックの文字列

出力：生成原理に基づき（派生形として 24 パターンを用いて）構成した分析結果（自由記述テキスト）。
**この出力をそのままユーザーへ返す**（整形の中間 agent は挟まない。24 パターンが出力構造そのものを
規定しており、analyst が自己チェック段階で読みやすさ・結論ファーストまで担保するため、追加整形は不要）。

**Step 1 で `note` を受け取っていた場合**：analyst の出力の末尾にそのまま追記してから返す
（改変・要約せず一言添えるだけ。SKILL.md 自身が行うフロー制御の一部であり、analyst に渡す必要はない）。

## モデルポータビリティ（本スキルの設計中核・`/chat` との差別化根拠）

`/chat` の `sounding-board-consultant` は frontmatter で `model: fable` を固定し、Fable 5 の素の分析
能力に依存する。本スキルの `analyst` は**あえてモデルを固定しない**。

- 理由：本スキルの存在意義は「分析品質をモデル能力ではなく instructions で担保する」こと。特定モデルに
  固定すると、その差別化が成立しない。生成原理と 24 パターン（`references/analytical-workflow.md`）と
  敵対的自己チェックが、弱いモデルでも Fable 5 相当の反証耐性を出すための代替手段になる。
- これは執筆ガイドの「frontmatter に model を必ず指定する」という既定に対する意図的な逸脱。
  ポータビリティを優先する。呼び出し側は必要なら `model` を明示指定できる（例：重い相談は opus、
  軽い相談は sonnet）。指定がなければセッション model を継承する。

## 人間承認について

このフローは Step 0〜2 まで承認なしに完結する。これは意図的な設計であり、理由はこのスキルの
deliverable が常に「助言（assessment）」に留まり、ファイル変更・コマンドによる状態変更を一切
取らないため。承認ポイントが必要になるのは状態を変える操作だけであり、分析結果を relay するだけの
本スキルには該当しない。

## エラー時の挙動

- `investment-topic-router` 内の script が非 0 終了 → agent は安全側で `proceed: true` を返す
  （既存 chat と同じ fail-safe。投資でない可能性が高い相談を誤って investment-strategist に流すより、
  分析を試みる方がユーザーの意図に近い。詳細は `[SKILL_DIR]/../chat/agents/investment-topic-router.md`
  を参照）。
- `analyst` 呼び出しが失敗 → その旨をユーザーに伝え、対象/トピックの再送を促す。生成物を捏造しない。
