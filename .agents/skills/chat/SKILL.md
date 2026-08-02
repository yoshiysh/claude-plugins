---
name: chat
description: >
  技術的な壁打ち相談（コードチェック・セキュリティ・整合性/ロジック確認・設計判断）に対し、
  Claude Fable 5 を壁打ち相手として起用し、深い分析・意見をユーザーへ relay するスキル。
  ユーザーが `/chat` に続けて相談文を入力したときにのみ起動する（自然文トリガーは対象外）。
  Fable は助言に徹し、ファイル変更やコマンド実行といった行動は取らない。相談内容が
  投資判断（銘柄評価・買い時/売り時・組み入れ・ポートフォリオの相談・目標株価等）を含む場合は
  investment-strategist スキルへ完全委譲し、このスキル自身は投資判断を一切扱わない。
  雑談・投資相談・空入力には案内文を返して終了する。
---

# Chat（技術壁打ちスキル）

技術的な相談を **Claude Fable 5**（高性能・長時間自律実行モデル。Agent ツールの
`model: "fable"` で起動）に壁打ちさせ、その分析を読みやすく整形してユーザーへ relay する。

このスキル自身は分析結果を生成しない。**分析は Fable が行い、整形は relay-formatter が行う。**
SKILL.md（Orchestrator）は「誰に何を渡すか」だけを制御する。スクリプト呼び出し・別スキル呼び出し
の判断はいずれも Sub-agent の責務であり、SKILL.md からは直接呼ばない。

## 役割（何をするか）

1. `/chat <text>` の相談を受け取る
2. `investment-topic-router` agent に投資トピック判定と委譲判断を委ねる
3. 非投資の技術相談は、Fable 向け system prompt を組み立てる
4. Fable に壁打ち・分析・意見出しをさせる（Fable は助言のみ、行動は取らない）
5. Fable の生出力をユーザー向けに outcome-first で整形して返す
6. 今回のラウンドをトピック単位の spec.md（決定事項・未決の論点・却下した案）に凝縮して残す

## 何をしないか（境界）

- **投資判断を扱わない**：銘柄評価・売買タイミング・PF 相談は investment-strategist に完全委譲する。
  理由：投資助言の規制境界・売買命令ガードは investment-strategist が一元管理しており、
  本スキルで重複実装すると境界が二重管理になり漏れが生じる。
- **Fable に行動させない**：ファイル変更・コマンド実行はさせない。相談への deliverable は
  「assessment（見解）」であって「fix（修正の適用）」ではない。
- **Fable の懸念をトーンダウンしない／捏造しない**：relay-formatter が非改竄・非劣化を担保する。
- **SKILL.md がスクリプト・別スキルを直接呼ばない**：投資トピック判定（script 実行）と
  investment-strategist への委譲（Skill 呼び出し）はいずれも `investment-topic-router` agent の
  責務とし、SKILL.md はその agent を呼ぶとだけ書く。

## プログラム的呼び出し（他スキルからの起用）

frontmatter の description は「ユーザーが `/chat` に続けて相談文を入力したときにのみ起動する」
と書いているが、これは**ユーザーの自然文からの誤トリガーを防ぐための discovery 条件**であり、
他スキルが Skill ツール経由でこのスキルを直接呼び出すことまでは排除しない。呼び出し元スキルは
相談文の先頭に委譲ヘッダ `[SKILL_DELEGATION caller=<skill> purpose=code-review]` を付す。

**この場合、Step 1（investment-topic-router）・Step 4（relay-formatter）・Step 4.5（spec.md 更新）を
スキップし、Step 0 → 0.5 → 2 → 3 のみを通り、Step 3 の raw 出力を
そのまま呼び出し元へ返す**（理由は `references/delegation-contract.md` §Why Step 4 を
purpose=code-review では skip するか 参照。判定は Step 0.5 参照）。spec.md は
相談者個人の設計思考を凝縮する場であり、他スキルからの委譲相談（コードレビュー等）を
混在させない。

現在の呼び出し元・各スキップの理由・spoof 可能性の扱いは
`references/delegation-contract.md` に集約している（通常のユーザー起動フローでは毎回
関係しない契約説明のため、SKILL.md 本体には置かない）。

## フロー

```
/chat <text>
  │
  ├─[0] 空入力 / コマンドのみ  → 案内文を返して終了（agent に渡さない）
  │
  ├─[0.5] 委譲ヘッダ検出（SKILL.md が直接判定）
  │       先頭が `[SKILL_DELEGATION caller=... purpose=code-review]` なら
  │       [1] をスキップして [2] へ（呼び出し元スキルが技術文脈を保証しているため）。
  │       無ければ [1] へ。
  │
  ├─[1] investment-topic-router（agent, model: sonnet）
  │       [SKILL_DIR]/scripts/detect_investment_topic.py を実行し、投資トピックなら
  │       Skill({skill: "investment-strategist"}) を agent 自身が呼んで結果を relay。
  │       proceed: false を返せば、その結果をそのままユーザーに返して終了。
  │       proceed: true を返せば [2] へ続行。
  │
  ├─[2] prompt-compiler（agent, model: sonnet）
  │       相談文 + references/target-model-prompting-guide.md
  │       + `.claude/rules/thinking-stance.md`（あればそちらを正とする。無い環境では `[SKILL_DIR]/references/thinking-stance.md` の同梱コピーを読む） を読み、
  │       Fable 向け compiled prompt（思考レンズ + depth 指示 + 境界指示）を組み立てる
  │
  ├─[3] sounding-board-consultant（agent, model: fable）
  │       compiled prompt を受け取り、壁打ち・分析・意見出しを行う（助言のみ）
  │
  ├─[4] relay-formatter（agent, model: sonnet）
  │       Fable の生出力を outcome-first で整形し、ユーザーへ返す
  │       ★ この時点でユーザーへ応答済み。[4.5] はその後の付随処理。
  │
  └─[4.5] spec-updater（agent, model: sonnet。委譲呼び出し時は実行しない）
          今回のラウンドを workspace/{topic-slug}/spec.md に凝縮して書き込む
          （決定事項・未決の論点・却下した案。全文転記はしない）
```

## Step 0: 事前 short-circuit（SKILL.md が直接判定する分岐）

`<text>` が空、または空白のみ、またはコマンド語だけの場合、agent に渡さず以下を返して終了する。
理由：これは判断ではなく完了条件（フロー制御）そのものであり、agent 委譲の対象外。

```
壁打ちしたい技術相談を続けて書いてください。
例: /chat この DCF 計算関数の Decimal 変換、丸め誤差が出ない実装になってる？
```

`<text>` が明らかに技術相談でも投資相談でもない雑談的入力（例：「今日の天気は」「元気？」）の
場合も、同様に agent に渡さず以下を返して終了する。
理由：雑談を investment-topic-router → prompt-compiler → Fable まで流すのは無駄なホップであり、
このスキルの description が約束する「雑談には案内文を返す」を本文フローで担保するため
（判定はキーワード検出のような複雑な分類を必要とせず、Step 0 の完了条件の一部として扱える）。

```
このスキルは技術的な壁打ち相談（コードチェック・セキュリティ・整合性/ロジック確認・設計判断）
向けです。相談内容を書いて `/chat` で呼び出してください。
```

## Step 0.5: 委譲ヘッダ検出（SKILL.md が直接判定する分岐）

`<text>` の先頭行が `[SKILL_DELEGATION caller=<skill> purpose=code-review]` に一致するか
どうかを見る。これは agent への委譲判断ではなく、単純な文字列パターンの有無確認なので
SKILL.md 側で直接判定してよい（§プログラム的呼び出し参照）。

- **一致する場合**: Step 1（investment-topic-router）を丸ごとスキップし、ヘッダ行を除いた
  残りの本文を `[USER_CONSULTATION]` として Step 2 へ渡す。
- **一致しない場合**: 通常どおり Step 1 へ進む。

## Step 1: investment-topic-router を呼ぶ

`agents/investment-topic-router.md` を読み、以下を渡して呼ぶ。

- `[USER_CONSULTATION]`: ユーザーの相談文（`<text>`）

出力：`{"proceed": bool, "relayed_response"?: string}`

- `proceed: false` の場合：`relayed_response` をそのままユーザーに返して終了する。
- `proceed: true` の場合：Step 2 へ続行する。

## Step 2: prompt-compiler を呼ぶ

`agents/prompt-compiler.md` を読み、以下を渡して呼ぶ。

- `[USER_CONSULTATION]`: ユーザーの相談文（`<text>`）

出力：Fable 向け compiled prompt（1 本の文字列）。

## Step 3: sounding-board-consultant を呼ぶ

`agents/sounding-board-consultant.md` を読み、`model: "fable"` で呼ぶ。

- `[COMPILED_PROMPT]`: prompt-compiler の出力

出力：Fable の生分析（内部 shorthand を含みうる）。

## Step 4: relay-formatter を呼ぶ

`agents/relay-formatter.md` を読み、以下を渡して呼ぶ。

- `[RAW_ANALYSIS]`: sounding-board-consultant の出力
- `[USER_CONSULTATION]`: 元の相談文（固有表現の保持照合に使う）

出力：`[FORMATTED_RESPONSE]`（ユーザー向けに整形された最終回答）。**この時点でユーザーへ返す**
（Step 4.5 の完了を待たない。spec.md 更新は付随処理であり、ユーザーの応答受け取りを遅延・
ブロックしてはならない）。

## Step 4.5: spec-updater を呼ぶ（委譲呼び出し時はスキップ）

Step 0.5 で委譲ヘッダを検出していた場合はこの Step を実行しない（§プログラム的呼び出し参照）。

**目的**: 「今この瞬間、
設計がどこまで固まっているか」を1トピック1ファイルに凝縮し続ける場。1ラウンドで会話が
収束するか複数ラウンド続くかを先読みして判断せず、**毎ラウンド必ず書く**（ラウンド数を
気にする必要はない。1ラウンド目でも新規作成する）。

1. **書き込み先のパスを解決する**（Coordinator が直接判定。agent 委譲は不要）:
   - まず `workspace/` 配下の既存トピックを機械的にスキャンする: `Glob("workspace/*/spec.md")`
     で一覧を取得し、ヒットした各ファイルの1行目（`# {トピックの短い説明}`）だけを Read する。
     **この会話内の記憶だけに頼らない**（`/compact` 後やセッションを跨いだ継続では
     Coordinator 自身の記憶に前回のトピックが残っておらず、スキャンを省略すると同じ
     トピックの続きでも毎回新規ディレクトリが作られ、spec.md が「凝縮ドキュメント」として
     機能しなくなる）。
   - スキャン結果のタイトルのいずれかが今回の相談と明確に同一トピックだと判断できる場合
     （タイトルの言い回しが違っても指している設計対象が同じ、など）は、その
     `workspace/{topic-slug}/spec.md` のパスを再利用する。
   - **同一かどうか判断が割れる／自信が持てない場合は再利用せず新規トピック扱いにする**
     （下記スラッグ生成に進む）。理由: 別トピックの spec.md に誤ってマージすると、無関係な
     内容が決定事項・却下した案に混入し記録が汚染される。汚染は後から気づきにくく訂正コストが
     高い一方、同一トピックが2ファイルに分かれる「断片化」は目に見えるため人間が後で気づいて
     マージできる、可逆的な失敗モードである。安全側に倒すなら断片化を許容する。
   - 新規トピックと判定した場合、`[USER_CONSULTATION]` から短い英語 kebab-case のスラッグ
     （3〜6語程度、例: `sector-rotation-design`）を生成し、
     `workspace/{topic-slug}/spec.md` を新しいパスとする。
2. `agents/spec-updater.md` を読み、以下を渡して呼ぶ。
   - `[SPEC_PATH]`: 上記で解決したパス
   - `[USER_CONSULTATION]` / `[RAW_ANALYSIS]`（Step 3 の出力）/ `[FORMATTED_RESPONSE]`
     （Step 4 の出力）
3. agent がファイルへの書き込みまで直接行う（Coordinator は書き込まない）。戻り値は
   短い更新サマリのみで、全文を Coordinator の文脈に持ち帰らない。

## 人間承認について

このフローは Step 0〜4.5 まで承認なしに完結する。これは意図的な設計であり、理由は
このスキルの deliverable が常に「助言（assessment）」に留まり、ファイル変更・コマンド実行と
いった不可逆・状態変更を伴うアクションを一切取らないため。承認ポイントが必要になるのは
状態を変える操作だけであり、壁打ちの結果を relay するだけの本スキルには該当しない。Step 4.5 の
spec.md 更新も、スキル自身の workspace 配下への書き込みに閉じており、既に得ている承認の
範囲内（都度確認は不要）。

## エラー時の挙動

- `investment-topic-router` 内の script が非 0 終了 → agent は安全側で `proceed: true` を返す
  （投資でない可能性が高い相談を誤って investment-strategist に流すより、技術壁打ちを試みる方が
  ユーザーの意図に近い。詳細は `agents/investment-topic-router.md` を参照）。
- Fable 呼び出しが失敗 → その旨をユーザーに伝え、相談文の再送を促す。生成物を捏造しない。
- Step 4.5 の spec.md 更新が失敗（ファイル書き込みエラー等） → ユーザーへの
  応答は Step 4 の時点で既に返しているため影響しない。原則ユーザーには伝えない（次ラウンドで
  再試行される）。

## モデル交代時の更新ポイント

Fable 5 は現行フラッグシップ。次期モデルへ交代する際は、
`references/target-model-prompting-guide.md` と `agents/sounding-board-consultant.md` の
`model:` frontmatter を差し替える（詳細は各ファイル冒頭のコメント参照）。
