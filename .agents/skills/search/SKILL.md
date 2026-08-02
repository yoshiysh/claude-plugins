---
name: search
description: >
  「調べて」「確認して」「なぜ〜なのか」等の調査・確認依頼に対し、一次情報（live API・
  実ファイル・Web 検索/WebFetch）を徹底的に確認し、もっともらしい仮説で止まらず、回答文中の
  全ての事実主張（本筋の結論だけでなく添え物的な描写も含む）を検証してから回答を組み立てる
  調査ワークフロー。ユーザーが「この CI が失敗している理由を調べて」「なぜこの設定が効いて
  いないのか確認して」「なぜこの挙動になるのか調べて」のように調査・確認・原因究明を求めた
  ときに使う。「徹底的に」等の修飾語は不要 — 調査依頼である限り、この徹底性は常に適用する。
  他スキル（Issue 分析・pre-PR レビュー等）から「この主張は一次情報で裏付けられているか」を
  検証する delegation 呼び出しにも応じ、verified/refuted/cannot-verify の三値を返す。
  純粋な実行・変更依頼（「このファイルを編集して」「コミットして」等、調査を伴わないもの）
  には発火しない。
---

# Search（一次情報検証つき調査スキル）

調査依頼を、**一次情報の実地確認**と**回答文中の全事実主張の検証**を経てから回答へ組み立てる。
このスキルの deliverable は「もっともらしい説明」ではなく「一次情報に裏付けられた検証済み事実
＋未検証のまま残った点の正直な区別＋（特定できた場合の）根本原因」である。

検証ループ本体（claim 抽出 → claim ごと並列検証 → 合成 → 収束判定）は
`scripts/investigate.js`（Workflow スクリプト）が持つ。SKILL.md は「ループに入る前の分岐」と
「結果の提示」だけを制御する。各 agent の検証ロジック（truncation 検知・チェリーピッキング
防止・三値判定・反証義務）は `agents/` に外出しする。

**なぜループを script に置くか**: 「抽出された claim が検証されないままレポートに載る」
「同じ問いを検証し直して終わらない」を散文の禁止事項で防ごうとすると、それを見張る記述が
際限なく増える。script が claims[] を走査して verifier を spawn する形にすれば、検証の
スキップは原理的に起こりえず、監視の記述ごと不要になる。ループ・並列・集約は script、
判断（何を検証すべきか・収束したか）は agent、という分担。

## このスキルが対策する失敗（設計の出発点）

以下は実際に起きた誤りで、各 agent の具体例として本文にも埋め込んでいる。

1. **情報源の不完全性を見落とした断定**：GitHub Actions のログが truncate されているのに
   気づかず「AI が呼ばれなかった」と結論した（実際は `gh run view --log` が不完全なだけで、
   `gh api .../actions/jobs/{id}/logs` の完全ログでは呼ばれていた）。→ `source-verifier`。
2. **添え物的描写の未検証挿入**：本筋の説明の "ついで" に「何度も手を入れた完成度の高い
   コード」と未検証の描写を入れた（実際は 1 コミットのみ）。→ `claim-extractor`。
3. **単一仮説での即断**：もっともらしい仮説（新規スレッド vs 返信スレッドの違い）が 1 つ
   見つかった時点で結論としかけたが、実際は別原因（ブランチ同期タイミング）だった。
   → `root-cause-synthesizer`。

## アーキテクチャ（Orchestrator-Subagent + Generator-Verifier + Parallelization）

- **claim-extractor（sonnet）**：問い・ドラフト回答から、検証が必要な事実主張を**本筋・
  添え物を問わず全て**列挙し、各主張に検証手段を付す。合成された推論主張を事実と区別する。
- **source-verifier（sonnet, 主張ごとに並列）**：実際にツールを実行して
  `verified`/`refuted`/`cannot-verify` の三値で判定する。情報源自体の不完全性も確認する。
- **root-cause-synthesizer（opus）**：検証済み主張から根本原因を組む。単一仮説で即断せず、
  最低 1 つの反証を試みる。未解決点があれば「次に検証すべき問い」を 1 つ出して差し戻し、
  最終的に4要素の最終レポートを組み立てる。

三者の入出力契約と最終レポート契約は `schemas/agent-contracts.md` を正とする。

## 何をしないか（境界）

- **実行・変更を伴う操作をしない**：deliverable は「検証済みの調査結果」であって、ファイル
  編集・コミット・デプロイ等の状態変更ではない。純粋な実行依頼には発火しない（discovery
  境界。§Step 0 と description 参照）。
- **記憶・一般知識で断定しない**：外部システムの挙動・API 仕様・モデル名/可用性・ファイル
  内容は、毎回一次情報で確認してから述べる（`source-verifier` が担保）。
- **もっともらしい仮説で止めない**：単一仮説は反証を経るまで結論にしない
  （`root-cause-synthesizer` が担保）。
- **読めなかった内容を創作しない**：`cannot-verify` は「未検証」として正直に区分する。
  推測で根本原因を埋めない。
- **SKILL.md が検証ツールを直接叩かない**：一次情報の取得・判定は agent の責務。
- **SKILL.md がループを回さない**：ラウンド反復・並列 spawn・累積・打ち切り判定は
  `scripts/investigate.js` の責務。

## フロー

```
調査依頼 <text>
  │
  ├─[0] 空入力 / 対象が特定できない曖昧な問い  → 案内 or 明確化質問を返して終了（§Step 0）
  │
  ├─[0.5] 委譲ヘッダ検出（SKILL.md が直接判定）
  │       先頭が [SKILL_DELEGATION caller=... purpose=verify-claim] なら
  │       Workflow を通さず、渡された主張を source-verifier へ直接 spawn する。
  │       三値（verified/refuted/cannot-verify）で呼び出し元へ返して終了（§Step 0.5）。
  │
  ├─[1] 調査+実行の混在判定（SKILL.md が直接判定）
  │       「調べて直して」等なら調査部分のみ担当。実行部分は検証済みレポート＋明示的な
  │       引き継ぎとしてユーザー / 呼び出し元へ返す（自身では実行しない。§Step 1）。
  │
  ├─[2] Workflow を呼ぶ（§Step 2）
  │       scriptPath: scripts/investigate.js
  │       args: { skillDir, question, maxRounds? }
  │       ループ本体は script が内包する:
  │         Extract    claim-extractor（sonnet）が検証すべき事実主張を全列挙
  │         Verify     source-verifier（sonnet）を claim ごとに並列 spawn し三値判定
  │         Synthesize root-cause-synthesizer（opus）が累積 verdict から根本原因を組む
  │         → next_question があれば Extract へ戻る。round 上限 5 / 進捗ガードで打ち切り
  │
  └─[3] 4要素の最終レポートを返す（verified_facts / unverified_or_inconclusive / root_cause /
        inferences）。組み立ては root-cause-synthesizer が行い、SKILL.md はそれを relay する。
```

## Step 0: 事前 short-circuit（SKILL.md が直接判定する分岐）

agent に渡す前に、以下は SKILL.md 側で判定して終了する。理由：これらは調査判断ではなく
完了条件（フロー制御）であり、agent 委譲の対象外。

- **空入力 / 空白のみ / 語だけ**：案内文を返して終了。

  ```
  調べたい問い・観察された異常を続けて書いてください。
  例: /search この CI が失敗している理由を調べて（対象の PR / run URL があれば添えて）
  ```

- **対象が特定できない曖昧な問い**（例：「なんか調子が悪い」「動かない」だけで対象・
  症状・再現条件のいずれも不明）：**推測で対象を決めて調査を始めない**。1〜2 個の明確化
  質問を返して終了する（人間介入ポイント）。理由：対象を取り違えたまま一次情報を集めても、
  正しい情報源を「否定的結果」と誤認する（criteria 9 の逆流）。

  ```
  対象を特定できませんでした。次のどれを調べますか？
  - どのコンポーネント / ファイル / URL の話か
  - 観察された具体的な症状（エラーメッセージ・期待と実際の差）
  ```

- **純粋な実行・変更依頼**（「このファイルを編集して」「コミットして」等、調査を伴わない）：
  このスキルの対象外。呼び出されても調査タスクが無いことを伝えて終了する（discovery 境界を
  本文でも担保）。ただし「調べて直して」のように調査を含む場合は Step 1 で扱う。

## Step 0.5: 委譲ヘッダ検出（SKILL.md が直接判定する分岐）

`<text>` の先頭行が `[SKILL_DELEGATION caller=<skill> purpose=verify-claim]` に一致するかを
見る。これは単純な文字列パターンの有無確認なので SKILL.md 側で直接判定してよい。

- **一致する場合**：ヘッダ行を除いた本文を「検証対象の主張（1 個または少数）」として、
  `agents/source-verifier.md` を読み **Agent ツールで直接 spawn する**（複数主張なら
  同一ターンで並列に）。各主張について `verified`/`refuted`/`cannot-verify` の三値 +
  `evidence_ref` を呼び出し元へ返して終了する（root-cause 合成は行わない。呼び出し元が
  求めているのは主張の裏付け可否のみ）。契約は `schemas/agent-contracts.md`
  §delegation-verify-claim を正とする。

  **この経路は Workflow を通さない**。委譲は呼び出し元スキルへの同期的な request/response
  であり、バックグラウンド実行される Workflow に載せると応答の形と待ち方が変わる。
  検証ループ（抽出 → 検証 → 合成の反復）が要らない経路でもあり、script の出番がない。
- **一致しない場合**：通常どおり Step 1 へ進む。

## Step 1: 調査+実行の混在判定（SKILL.md が直接判定する分岐）

「なぜ動かないか調べて直して」「原因を確認して修正して」のように、調査と実行（状態変更）が
混在する依頼を受けた場合：

- **調査部分のみをこのスキルで担当する**（Step 2 以降の検証ループを回す）。
- **実行部分は行わない**。最終レポートの末尾に「検証済みの根本原因に基づく次アクション
  （修正方針）」を**引き継ぎ**として明記し、実行はユーザー / 呼び出し元スキルに委ねる。
  理由：このスキルの検証保証は「助言（assessment）」に閉じることで成立しており、状態変更の
  承認境界と混ぜない（不可逆操作は人間 / 呼び出し元の責務）。

## Step 2: Workflow を呼ぶ

```
Workflow({
  scriptPath: "[SKILL_DIR]/scripts/investigate.js",
  args: { skillDir: "[SKILL_DIR]", question: "<調査依頼>", maxRounds: <number|undefined> }
})
```

`skillDir` には本スキルの実ディレクトリを実パスで渡す。スクリプトは自身の位置を解決できず、
agent に渡す `agents/*.md` と `schemas/agent-contracts.md` の Read パスがここでしか決まらない。

完了すると `{ question, rounds_run, termination_reason, report, verdicts, rounds }` が返る。

**script が構造として保証すること**（散文の禁止事項で担保していたものの置き換え）:

| 保証 | 実現方法 |
|---|---|
| 抽出された claim は必ず検証を通る | script が `claims[]` を走査して claim ごとに verifier を spawn する。未検証の主張がレポートに載る経路が存在しない |
| 同じ claim を毎ラウンド検証し直さない | 正規化した主張文をキーに既検証分を除外（`seen`） |
| 無限ループしない | `round < maxRounds`（既定 5）の `while` |
| 進捗のないループを早期に切る | (a) 新規 verified 0 件 かつ (b) `same_question_as_previous` で打ち切り。(b) の意味判断は synthesizer が返し、分岐は script が持つ |
| 検証 agent が落ちても捏造しない | 結果を返さなかった claim を `cannot-verify` として明示的に積む |
| load-bearing な主張を先に検証する | `priority` 順に並べてから spawn。打ち切り時に本筋を支える claim が残る |

**部分検証でも回答を継続する**：一部の claim が `cannot-verify` でもループは止まらず、その
claim は最終レポートの `unverified_or_inconclusive` に落ちる（全部検証できないことは回答
放棄の理由にしない）。`claims` が空（検証すべき事実主張が無い純粋な定義・意見の問い）の
場合も同様にレポートは組み上がる（`verified_facts` が空になりうる）。

`termination_reason` は `converged`（収束）/ `stalled`（進捗なしで打ち切り）/ `max_rounds`
（ラウンド上限）/ `budget_exhausted`（予算到達）/ `not_started`（1 ラウンドも回らなかった）。
`converged` 以外は Step 3 で必ず明示する（達成度を実態より良く見せない）。`not_started` と
`report: null` が返った場合はレポートを組み立てず、その事実をそのまま伝える。

Workflow は `resumeFromRunId` で再開できる。長い調査が中断した場合は同じ `scriptPath` +
`resumeFromRunId` で続きから回せる。

## Step 3: 4要素の最終レポートを返す

root-cause-synthesizer が組み立てた `report` をそのままユーザー / 呼び出し元へ返す。構造は
`schemas/agent-contracts.md` §final-report を正とする（`verified_facts` / 
`unverified_or_inconclusive` / `root_cause` / `inferences`）。各事実主張には一次情報の
`evidence_ref`（URL / ファイルパス / API レスポンス）を必ず併記する。root_cause が特定
できなかった場合は `null` + 理由を明記し、推測で埋めない。

## 一次情報にアクセスできないとき

`source-verifier` は、URL が直接取得できない（paywall / login 必須 / 4xx・5xx 等）場合でも
すぐ諦めず、以下のフォールバック順（reader プロキシ →
プラットフォーム固有ミラー/API → 短縮 URL 展開 → 本文貼付依頼）を順に試す。取得できた範囲と
できなかった範囲を正直に区別し、読めなかった内容は創作しない。それでも取れなければ
`cannot-verify` として区分する。

## 人間承認について

このフローは Step 0〜3 まで承認なしに完結する。deliverable が常に「検証済みの調査結果
（assessment）」に留まり、状態変更を伴わないため。人間介入が要るのは 2 箇所のみ：
(1) Step 0 の対象特定不能な曖昧問い（明確化質問を返す）、(2) Step 1 の実行部分（引き継ぎ、
実行は人間 / 呼び出し元）。

**どちらも Workflow 起動前に位置している**。Workflow は実行中にユーザー入力を受け取れない
ため、人間ゲートを持つ判断（Step 0 の明確化質問・Step 0.5 の委譲判定・Step 1 の実行分離）は
SKILL.md 側に残し、script にはループだけを持たせている。

## エラー時の挙動

- 検証ツール（Bash/gh/WebFetch 等）が失敗 → `source-verifier` はその claim を `cannot-verify`
  とし、失敗理由を `note` に残す（捏造しない）。ループ全体は止めない。
- `source-verifier` の呼び出し自体が失敗（agent が結果を返さない）→ script がその claim を
  `cannot-verify` として積む。検証済みとして扱われることはない。
- synthesizer が矛盾を検出 → `contradictions[]` に記録し、レポートの
  `unverified_or_inconclusive` に反映する。矛盾を隠して片方を採らない。
- ラウンド上限 / 進捗なし打ち切り → その時点のレポートを「未解決点あり」として返す。
  `termination_reason` を必ず添える。
- Workflow 呼び出し自体が失敗（構文エラー・ツール未許可等）→ エラー内容をそのまま伝える。
  生成物を捏造しない。

## モデル交代時の更新ポイント

現行の割り当ては claim-extractor=sonnet / source-verifier=sonnet / root-cause-synthesizer=opus。
検証は generator（extractor）と verifier を別 agent に分離することで成立している。モデルを
交代する際も、抽出 → 検証 → 合成の 3 者分離と、synthesizer に最上位モデルを充てる方針は維持する
（合成が最も反証・因果推論の質を要するため）。
