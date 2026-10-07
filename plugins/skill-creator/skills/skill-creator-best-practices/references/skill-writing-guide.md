# スキル執筆ガイドライン

## 目次
- [SKILL.md の必須構造](#skillmd-の必須構造)
- [description と命名](#description-と命名)
- [本文の書き方](#本文の書き方)
- [マルチエージェント設計の原則](#マルチエージェント設計の原則)
- [document タイプの追加ルール](#document-タイプの追加ルール)
- [Workflow 型スキルの執筆](#workflow-型スキルの執筆)
- [eval-first 開発](#eval-first-開発)
- [パターン選択](#パターン選択)
- [良い SKILL.md の基準](#良い-skillmd-の基準)
- [よくある失敗パターン](#よくある失敗パターン)

執筆 Sub-agent が参照するスキル執筆ルール。
`references/best-practices.md` の知見をエージェント向けに凝縮したもの。

---

## SKILL.md の必須構造

```
---
name: スキル識別子
description: >
  [name・description の規則は references/best-practices.md §2]
---

# スキル名

## 目的・概要

## フロー / 手順（またはアーキテクチャフロー図）

## 入出力の定義

## 注意事項
```

### フローの書き方 — 保証の強さで層を分ける

**「Phase 1 / Phase 2 / …」のような通し番号を、性質の違う工程に一律で振らない。**

同じ番号体系で並べると、どれも同じ強度で必ず順に通るように見える。しかし実際には
2 種類が混在している。

| | 何が順序を決めるか | 必ず通るか |
|---|---|---|
| **司令塔がやること**（SKILL.md の散文） | SKILL.md を読んだモデル | **保証されない**。指示であって構造ではない |
| **Workflow の中**（script の `phase()`） | script | **通る**。制御フローそのもの |

この 2 つを分けて書く。

```markdown
## 司令塔がやること（Workflow の外）

1. …する
2. …する ← 条件付き（〜のときだけ）
3. …をユーザーに提示して承認を得る ← 人間ゲート
4. Workflow を呼ぶ
5. 結果を提示し、保存の承認を得る ← 人間ゲート

## Workflow がやること（script が順序を握る）

Criteria → Structure → Write → Test → Evaluate
```

規則は 3 つ。

- **番号を振るのは司令塔の手順だけ。** 実際に上から順に通るものにしか番号を付けない
- **script 側は phase 名だけを並べ、番号を振らない。** 順序は script が持っているので、
  散文で番号を振ると二重管理になり、片方が必ず古くなる
- **条件付き・人間ゲートはその場で明示する。** 番号の列に条件付きが黙って混ざると、
  「1 → 2 → 3 と必ず進む」と読まれる

**後から工程を足して「Phase 0」が生まれたら、それは番号体系が壊れた合図である。**
0 は「1 より前」を意味しないし、条件付きの工程に通し番号を振ること自体が誤り。
番号を振り直すのではなく、層で分け直す。

---

## description と命名

description の必須ルール・発火の書き方・命名規則の正本は `references/best-practices.md` §2「description の設計」。

---

## 本文の書き方

### Why-driven と長さの目安

Why-driven の書き方は `references/best-practices.md` §3「Why-driven prompt design」、長さの目安
（SKILL.md の行数・参照の深さ・目次）は同 §1「コンテキストは公共財」「参照ファイルの深さ制限」が正本。

### 選択肢を絞る

複数の選択肢を並べず、デフォルトを1つ示して例外だけ補足する。

```
# 悪い例
"pypdf、pdfplumber、PyMuPDF、pdf2image のどれかを使う"

# 良い例
"テキスト抽出には pdfplumber を使う。スキャン PDF（OCR が必要）の場合は pdf2image + pytesseract を使う"
```

### 時間依存情報を避ける

```
# 悪い例
"2025年8月以前は旧 API を使う"

# 良い例（old patterns セクションに分離）
## 現在の方法
v2 API を使う: api.example.com/v2/messages

## 旧仕様（廃止済み）
v1 API: api.example.com/v1/messages（2025-08 廃止）
```

---

## マルチエージェント設計の原則

### Orchestratorの純粋性

SKILL.md（Orchestrator）は「誰に何を渡すか」だけを定義する。

- ドメイン知識（HTML仕様・コンポーネント詳細・業務ルール）は agents/ や assets/ に分離
- 判断ロジックは Sub-agent の責務
- SKILL.md にドメイン知識が混在し始めたら分割のサイン

**MVC 的な責務分離：**

```
SKILL.md          → Orchestrator（制御フロー）
agents/           → 専門家プロンプト（ドメインロジック・スクリプト呼び出しの判断）
references/       → データ契約 or ドメイン知識
assets/           → 変化しない参照データ（仕様・設定値）
scripts/          → 確定的処理（実行エンジン）
```

**agent と scripts の関係：**
- agent は「何をどのスクリプトで処理するか」を判断し、スクリプトを呼ぶ
- scripts は確定的な変換・計算・フォーマットを実装する（Claude が変換ロジックを自前実装しない）
- Claude が変換ロジックを agent の本文に直書きしている場合は scripts に切り出すサイン

**他スキルのパイプライン呼び出し：**
- 別スキルの呼び出しを agent に委譲するかは `references/best-practices.md` §11 P7 に従う
- 例：`update-confluence-page` では `existing-page-fetcher` agent が `fetch-confluence-page` スキルを呼ぶ
- 委譲する場合、その agent は「呼び出しの責任を持つ単一責務 agent」にする
- 別スキルを呼ぶ際は、そのスキルの出力フォーマット（YAML フロントマター等）から必要なフィールドを取り出す

**出力フォーマットの後続スキル向け設計：**
- 後続スキルが使うフィールドを最初から出力フォーマットに含める
- 例：`fetch-confluence-page` の出力に `version`（更新 API 必須）・`space_key`・`edit_url` を含める
- 後続スキルが何を必要とするかを要件整理の段階で確認しておく

### 役割の「やること・やらないこと」を明示で書く

マルチエージェント構成のスキルは、**役割ごとに do と don't を本文に書き下す**。
don't は推論可能なだけでは守られない —— 「オーケストレーターなのだから内容は書かないはず」は、
出口から漏れた作業が目の前にあると簡単に裏返る（実際に、ループの出口から漏れた指摘を
オーケストレーターが手で塞ぐ運用が発生した）。

- **オーケストレーター役は dispatch / relay / 機械コピーに限る。** 内容の生成・修正・採点はしない。
  自分が中継した数字を再計算しない（同じ判定が 2 箇所に生まれる）。
- **例外条項を書かない。** 「ただし軽微なら」「ユーザーの明示指示があれば」は、重さの上限を
  持たないので何でも通る穴になる。直す必要が出たら、それを担当する役割へ入力として戻す。
- **ループの出口条件を役割境界と一致させる。** どの出口も、その先を担当する役割が定義されている
  場所へ出ること。役割の無い場所へ出る出口を作ると、そこに落ちた作業は誰の責務でもないまま
  実行者の裁量で処理される。
- **解決は根本原因の除去に置き、防御パッチを解決と呼ばない。** 注意書き・監視・例外条項で
  症状を塞ぐと、読まない経路が 1 つあるだけで再発する。正本参照・script による配達・
  スキーマ検査で誤りを不可能にしてから、防御コメントを削る。詳細は
  `references/best-practices.md` §1「解決は根本原因の除去に置く」。

### 単一責務の原則

- 各 agent は「1入力 → 1出力」
- 判断・変換・生成を1つのエージェントに混在させない
- Generator と Verifier は別エージェント（自分の出力を自分で検証しない）
- model と effort は起動する側の 1 箇所に書く（`references/best-practices.md` §3「model と effort は役割ごとに組で選ぶ」）

### assets の分離

変化しない参照データは `assets/` に分離する：

```
assets/
  components.md   コンポーネント一覧・仕様（HTMLの仕様書など）
  structure.md    ファイル構造・命名規則
```

`agents/` に置く .md ファイルは「処理の指示」だけを含む。
Sub-agent が必要なタイミングで `assets/` を Read する設計にする。

### schemas 先行設計

エージェントを複数使う設計の場合、`references/schemas.md` を最初に設計する。
フィールド名のズレでパイプラインが壊れるため、契約書を先に書く。

---

## document タイプの追加ルール

- 実際の入力例と出力例をセットで **1パターン以上含める**（「省略」と書いて省くことは禁止）
- サンプルが具体的であるほど、Claude の出力品質が安定する

---

## Workflow 型スキルの執筆

`ARCHITECTURE` が `workflow` のときだけ適用する。SKILL.md に加えて `scripts/<スキル名>.js` を生成する。
背景と選択理由は `references/best-practices.md` §13。生成するスキルは未公開なので script は `scripts/` に置き、
`scriptPath` で呼ぶ。公開後は plugin の `workflows/` へ移って名前で呼ぶ形に変わる（2 段の規則と `meta.name` の条件は
§13「script の置き場」が正本）。

### SKILL.md 側に書くこと・書かないこと

| 書く | 書かない |
|---|---|
| script を呼ぶ前の準備（要件の構造化・ユーザー確認） | script が回す区間の手順の再掲 |
| `Workflow({ scriptPath, args })`（未公開）/ `Workflow({ name, args })`（公開後）の呼び出しと `args` の意味 | ループ回数・並列数・閾値の数値（script が持つ） |
| 返り値の構造と、その解釈・人間への提示 | 「〜を忘れずに実行する」型の注意書き（構造で保証済み） |
| 人間ゲートの位置と、止まったときの選択肢 | agent プロンプトの本文（`agents/` に置く） |

**区間の内側を散文で再掲しない。** script が唯一の正になるため、二重管理は必ずズレる。

script は自身の位置を解決できないので、`agents/*.md` を Read させるための基準パスはどちらの段でも `args.skillDir` で渡す。
selector の書き方は §13「script の置き場」に従う（公開時の書き換えはその形にしか効かない）。

### script の骨格

```javascript
export const meta = {
  name: 'skill-name-run',  // スキルの名前とは別にする（条件は best-practices.md §13「script の置き場」）
  description: '一行の説明（承認ダイアログに出る）',
  whenToUse: 'skill-name スキルが args を組み立てて呼ぶ。args が無いと起動直後に落ちるため直接は起動しない',
  phases: [
    { title: 'Collect', model: 'haiku', detail: '対象を列挙する' },
    { title: 'Verify',  model: 'sonnet', detail: '各件を独立に検証する' },
  ],
}

phase('Collect')
const found = await agent('対象を列挙する。', { model: 'haiku', effort: 'low', schema: LIST_SCHEMA })

const verified = await pipeline(
  found.items,
  item => agent(`${item} を検証する。`, {
    model: 'sonnet', effort: 'medium', label: item, phase: 'Verify', schema: VERDICT,
  }),
)
return verified.filter(Boolean)
```

### meta の任意フィールドと agent() の opts

以下の 3 節で〔同梱〕を付けた事実は、公開 docs（code.claude.com の workflows）ではなく Claude Code 同梱の
workflow-authoring reference（`/workflow-authoring` で読める）に拠る。版で変わりうるので、食い違ったら同梱側を正とする。

- **`whenToUse`**〔同梱〕は workflow の一覧に出る説明。`args` が無いと落ちる script は、どのスキルから呼ばれるかと
  「直接は起動しない」を書く。公開後は `/<plugin>:<name>` として補完候補に並ぶので、書かないと利用者が
  args 無しで起動して落とす。meta は純粋なリテラルにする（`quick_validate.py` はバッククォートと `...` も弾く）。
- **`phases[].model`**〔同梱〕は、その phase の agent が全て同じ model のときだけ書く。callsite の `model` と同じ値の
  二重定義になるので、ずれを検出するテスト（phase ごとに実際の `opts.model` と照合する）と組で置く。
  混在する phase には書かない。
- **`model` と `effort` は全ての `agent()` で明示する**（理由と選び方は best-practices.md §3「model と effort は
  役割ごとに組で選ぶ」）。機械的な照合・enum 判定・採点は小さい model と `low`、最も難しい検証・統合判断と
  改稿だけを上げる。
- **`isolation: 'worktree'`** は、並列の agent がファイルを書き換えて互いに衝突するときだけ付ける（移行・
  一括変換を並列に書くスキルの安全な形）。agent ごとに新しい git worktree を作るので 1 体あたり
  約 200〜500 ms の準備と disk を食う〔同梱〕。変更が無ければ worktree は自動で消える。sub-agents docs の
  `isolation: worktree` では、worktree は親セッションの HEAD ではなく既定でリポジトリの default branch から切られる
  ので、作業ブランチの未 merge の変更を前提にする書き換えには使えない。読むだけの agent や、書き手が 1 体の
  stage には付けない。dynamic-workflow-runner は worktree capability が無い host ではこの opts を拒否する。
- **`agentType`**〔同梱〕は Agent ツールのレジストリに登録された型の名前で、スキル内の `agents/*.md` の役割名ではない。
  役割は prompt 本文で渡す。

### budget と workflow()

- **`budget`**〔同梱〕は利用者の「+500k」のような指示から来る token の上限で、`total` / `spent()` / `remaining()` を持つ。
  上限は助言ではなく hard ceiling で、`spent()` が `total` に達すると以降の `agent()` は throw する。上限の指示が
  無いと `total` は `null`、`remaining()` は `Infinity` なので、budget で回すループは必ず `budget.total` で守る
  （`while (budget.total && budget.remaining() > N)`）。守らないと 1 run あたりの通算 agent 上限（best-practices.md §13「実行時制約」）まで回り続ける。
  budget を持たない実行環境（Codex runner・単体テスト）では識別子自体が無いので `typeof budget` で確かめる。
- **`workflow(nameOrRef, args)`**〔同梱〕は別の workflow を 1 段だけ入れ子で呼ぶ（子の中で呼ぶと throw）。子は親と
  同時実行の上限・agent の通算数・中断・budget を共有する。名前の解決に失敗すると throw するので catch する。
  dynamic-workflow-runner が受け付けるかは runner の互換性基準が正本。

### subagent への指示と prompt cache

- workflow の subagent には起動時に呼び出し側と同じ CLAUDE.md が注入される〔同梱〕（Explore・Plan など一部の組み込み型を
  除く）。prompt で CLAUDE.md を読み直させたり規則を貼り込んだりしない。注入済みの文書を二重に読ませるだけで、
  貼った写しは原本の更新に追随しない。その stage に要る規則があれば、名前で 1 つだけ指す。
- fan-out する兄弟 agent は `model`・`effort`・`schema`・`agentType` を揃える（この規則の理由の正本はここ）。
  揃っていると tools と system prompt の prefix が一致して、先行する 1 体の cache を残りが読む（仕組みと待ち時間・
  TTL は best-practices.md §13「規模とコスト」）。兄弟ごとに schema を変えると prefix が割れるので、観点ごとの
  違いは prompt 本文で渡し、観点ごとの必須性は script が担当の観点についてだけ読むことで保つ。
- prompt は共通部分（役割の Read 指示・共通の入力）を先頭に置き、item ごとに変わる値を後ろに置く。

### デバッグ

完了した workflow が空・想定外の結果を返したら、原因を推測する前に `<transcriptDir>/journal.jsonl` を読む〔同梱〕。
各 agent が実際に返した値が記録されている。resume で返るキャッシュ結果も空でないとは限らないので、
「前回は返っていたはず」を前提にしない。journal が無いときは同じディレクトリの `agent-<id>.jsonl` を読む。

### 起動前に落ちる・resume が壊れる書き方（禁止）

| 禁止 | 理由 |
|---|---|
| `meta` に変数・関数呼び出し・スプレッド・テンプレート展開を入れる | `meta` は純粋なリテラルでなければならない |
| `import()` を書く | 含む script は起動前に失敗する |
| `Date.now()` / `Math.random()` / 引数なし `new Date()` | throw する（resume を壊すため）。時刻は `args` で渡し、乱択は index で prompt を変える |
| script から直接ファイル読み書き・shell 実行 | script にその権限は無い。agent のタスクに寄せる |
| `agent()` の結果をそのまま使う | 停止・API エラーで `null` になる。`.filter(Boolean)` してから使う |
| `phase()` のタイトルを `meta.phases[].title` とずらす | 進捗表示が別グループに割れる |
| script の内側でユーザーに確認する | 実行中にユーザー入力を受け取れない |

### pipeline を既定にする

`pipeline()` は item ごとに独立して流れる。`parallel()` は **barrier**（全件揃うまで待つ）で、次のステージが前ステージの**全件を横断して見る必要がある**ときだけ正当。

barrier の理由にならないもの：「flatten / map / filter したい」（ステージ内でやる）、「ステージが概念的に別」（pipeline がそれを表現する）、「その方が読みやすい」。

`parallel()` を使うなら、**なぜ全件が揃う必要があるのかをコメントに書く**。書けないなら pipeline に直す。

resume の性質上、**長い 1 agent より小さい agent への fan-out の方が中断時に進捗が残る**（キャッシュは最初の未完了 agent で止まり、それ以降に起動した分は完了済みでもやり直しになる）。phase の粒度はこれを踏まえて決める。

### 人間ゲートは境界に置く

workflow は実行中にユーザー入力を受け取れない。承認・sign-off が要るなら、

1. 段階ごとに別 workflow として回す
2. gate が通らなかったら `status: "BLOCKED"` と理由・証拠を返して**止める**
3. SKILL.md 側がそれをユーザーへ提示し、判断を得てから再実行する

### 集計と判定は script の算術で行う

- 平均・比率・件数を LLM に出させない。`agent()` の返り値から script が計算する
- 閾値判定は式で書く（`score >= SCORE_THRESHOLD && failed.length === 0`）。目分量の余地を残さない。
  閾値の値は**定数として script に 1 箇所だけ置き**、SKILL.md・references には定数名で書く
- 検証結果は `schema` で判定フィールド（enum / boolean）として受け取り、**script がその
  フィールドを直接読む**。markdown 中の ❌ を数えないだけでは足りない —— `failed[]` のような
  要約配列だけをゲートが見ると、判定を要約へ書き写す作業が agent の裁量に残り、
  落ちても「失格 0 件」と同じ形に見える
- **欠測を成績に混ぜない**。出力が欠けたケースは採点対象から外し、別カウントで返す。0 件しか採点できなかったときの差分は `0` ではなく `null`（`0` は実測の引き分けを意味する値）
- 上限・打ち切り・サンプリングで範囲を絞ったら `log()` に落とす。黙った打ち切りは「全部見た」と読まれる

### 品質パターン

`references/best-practices.md` §13 の表から要件に合うものを選ぶ。よく効くのは、

- **Adversarial verify**：主張ごとに独立した懐疑者を N 体立て、**反証するよう**指示して過半数で棄却
- **Perspective-diverse verify**：同じ検証者を N 体ではなく観点を変える（correctness / security / perf / 再現性）
- **Loop-until-dry**：新規発見が K ラウンド連続でゼロになるまで続ける（件数が読めない発見タスク）
- **Judge panel**：独立した N 案を生成 → 並列 judge で採点 → 勝ち筋に次点の良い部分を接ぐ

---

## eval-first 開発

スキルを書く前にテストケースを作る。

```
1. スキルなしで代表的なタスクを実行 → 失敗・不足を記録
2. テストケースを3件作成（evals.json）
3. スキルなしのベースラインを計測
4. 最小限の指示を書いてギャップを埋める
5. 評価 → ベースラインと比較 → 改善
```

evals.json のフォーマットは `references/schemas.md` を参照。

---

## パターン選択

`references/coordination-patterns.md` を参照して適切なパターンを選ぶ。
基本は Orchestrator-Subagent を骨格とし、以下を組み合わせる：

- 品質保証が必要 → Generator-Verifier を追加
- 独立した複数観点の検証 → Parallelization を追加

---

## 良い SKILL.md の基準

「このSKILL.mdを読んだだけで動作を再現できるか」が判断基準。
読んだ後に「〜の場合はどうするの？」という追加の質問が必要なら、仕様として未完成。

---

## よくある失敗パターン

| 失敗 | 対策 |
|------|------|
| 指示が多すぎてモデルが迷う | 優先順位を明示する（「最重要は〜」） |
| SKILL.md にドメイン知識を詰め込む | agents/ / assets/ / references/ に分離。変換ルール・定型メッセージ・設定値・URL はすべて外出しする |
| SKILL.md に変換ルール表を書く | references/ または assets/ に分離。SKILL.md は「○○変換スクリプトを実行する」とだけ書く |
| SKILL.md に定型エラーメッセージを書く | assets/error-messages.md 等に分離。SKILL.md はエラー種別の分岐だけ書く |
| agents/ に参照データを直書きする | 参照データは assets/ に置き、agent が Read する設計にする |
| 確定的な処理を Claude に任せる | scripts/ にスクリプトとして実装する |
| 小さな処理まで Sub-agent に切り出す | 委譲は独立した大きな作業に限る（`references/best-practices.md` §11 P7） |
| 選択肢を多く提示しすぎる | デフォルトを1つ示し、例外だけ補足 |
| エラー時の記述がなく止まる | 「〜の場合は〜して続ける」を入れる |
| 非エンジニアが読めない | 技術用語に括弧で補足を入れる |
| 入出力が曖昧 | 「入力：〜 → 出力：〜」を明示する |
| document タイプでサンプルが省略されている | 入力例・出力例のセットを必ず完全に記述する |
| schemas がない | エージェント間の入出力フォーマットを先に定義する |
| 異常系・準正常系・正常系エッジケースが未定義 | 空・不完全・想定外の入力への挙動を3種で整理して明示する |
| agent の description が「何をするか」だけで「いつ呼ばれるか」がない | 前のステップの agent 名またはスキル起動タイミングを description に明記する |
| agent の description に除外条件がない | 「何をしないか」「エラー時はどうするか」を description に追記する |
| agent 本文に命令だけあって理由がない | Why-driven で書く。なぜそのコマンド・順番・条件なのかを添える |
| 想定される誤った理由を先回りで否定している（「〜は理由にならない」） | **判定基準とコストだけを書く。** 否定は列挙が終わらない — 1 つ潰しても別の言い分が残る。コストを 1 回書けば、まだ思いついていない言い分にも効く |
| 「〜すれば〜になる」と機構を主張したが、その機構が働く形になっていない | **保証を成立させる条件まで書く。** 例：「表にすれば網羅できる」は、軸を宣言して直積から行を起こす場合にしか成り立たない。形式を指定しただけでは保証は生まれず、主張だけが残る |
| 支えの無い概念を語だけ導入している | **その語が成立するのに要る仕組みが他にあるかを確かめる。** 無いなら語も入れない。置き場の無い概念は、読み手がどう扱えばよいか決められない |
| 実務で通っている名前がある概念を、自前の説明だけで書いている | **既知の名前を併記する**（「軸を宣言して直積から起こす（いわゆる MECE）」）。読み手が持っている知識に接続でき、説明より短い。**指す実体がスキル内にあるときだけ**行う — 実体の無い語は上の行に当たる |
| 変換ロジックを agent 本文に Claude が直書きしている | scripts/ に確定的処理を切り出し、agent はそれを呼ぶだけにする |
| 別スキルと同じ処理を重複実装している | 既存スキルをパイプライン呼び出しで再利用する |
| 後続スキルが必要とするフィールドを出力に含めていない | 要件整理で後続スキルの入力要件を確認し、出力フォーマットに必要フィールドを最初から含める |
