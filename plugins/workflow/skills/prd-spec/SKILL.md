---
name: prd-spec
description: >
  要求文書（requirements）と仕様書（specifications）を日本語で作成・レビューするスキル。
  要求文書は関係者の認識が一致する状態まで、仕様書は実装が一意に決まる状態まで詰める
  （2 つは目的が違うので、分量の決まり方も違う）。「PRD を書いて」「要件定義をまとめて」
  「これを仕様書に落として」「この PRD をレビューして」「要求から仕様書を起こして」といった依頼で
  使うこと。ドメインは問わず、助動詞規約・曖昧語の排除・ID とトレーサビリティ・未確定事項の
  解消を常時適用する。入力に無い要求を推測で埋めず、決めきれていない項目は先例・実測・
  依頼者への質問のいずれかで run 内に解消してから完了する。関心事ごとに複数ファイルへ分割し、
  ディレクトリごとの INDEX を導出する。既存コードの挙動説明（「この関数の仕様を教えて」）や、
  文書を伴わない実装・修正依頼には発火しない。
  要求・仕様の体裁を取らない一般ドキュメントの執筆（提案書・意思決定文書・README・ブログ・
  議事録の要約）や設計判断の壁打ちにも発火しない — それらは文書共同執筆・相談系のスキルの領分。
  空入力・単語のみの入力では作成に入らず、何の文書かを尋ねて終了する。
---

# prd-spec（要求文書・仕様書の作成とレビュー）

**目次**: [目的（完成の定義）](#目的完成の定義) · [人間に聞く前に落とす（判定パイプライン）](#人間に聞く前に落とす判定パイプライン) · [このスキルが防ぐ失敗](#このスキルが防ぐ失敗) · [対象外・起動条件](#対象外起動条件) · [全体フロー](#全体フロー) · [1. モードを判定する](#1-モードを判定する) · [2. 事前分析を発行する](#2-事前分析を発行する3-agent-並列) · [3. Workflow A を呼ぶ](#3-workflow-a-を呼ぶdraftjs) · [4〜5. 統合ゲートと Workflow B](#45-統合ゲート人間ゲートと-workflow-b) · [6. 結果を提示して保存する](#6-結果を提示して保存する保存と事後報告) · [入出力の定義](#入出力の定義) · [注意事項](#注意事項) · [参照ファイル構成](#参照ファイル構成)

## 目的（完成の定義）

**2 つの文書は目的が違う。分量の決まり方も違う。** 何を書く文書なのかは
`references/prd-and-spec.md` を正とする。

| 文書 | 目的 | 分量が決まる基準 |
|---|---|---|
| **要求文書**（目的側） | **関係者の認識が一致していること** | 一致させるのに要る量。**網羅ではない** |
| **仕様書**（手段側） | **実装が一意に決まること** | 設計・実装・検証ができる量。**設計解は書かない** |

この 2 つを取り違えると分量が壊れる。要求文書の分量を決めるのは関係者の数と合意の重さで
あり、仕様書は**委ねないために書く**ので短さを目標にできない（正は `prd-and-spec.md` §7）。

### 完成条件は「未確定事項（TBD）0 件」である

> **保証すべきなのは「残っている TBD が 0 件」である。**

TBD が並んだ文書からは次工程が始まらない。かといって推測で埋めるのはそれ以上に悪い。この 2 つ
は長く両立しないと考えられ、完成条件は「未提示の blocking が 0 件」（＝聞くだけは聞いた）に
置かれていた。**依頼者が決めていないことは、何回聞いても決まらない**からである。

その前提は今も正しい。変わったのは書き方の方である。決まらない論点は、**裁定が下るまで
何をしてはならないか**という規範文（**保持規則**）へ変換できる。

- 悪い: 「上限金額は未定（TBD-BILL-002）」← 次工程は勝手に決めるか止まるかしかない
- 良い: 「上限金額の裁定が下るまで、金額を伴う自動処理を新しい画面へ拡大してはならない。」

保持規則は未確定を隠さない。隠さずに、**次に何をしてよいかだけを確定させる**。裁定そのものは
作業項目（`work_items`）として文書の外へ出し、司令塔が Issue 化する。これで「決まらない」と
「文書が完成しない」が切り離せるので、完成条件を TBD 0 に置ける。

未確定が出たときの解消は次の順で試す（前段で決まったものは後段へ渡さない）。

| 順 | 手段 | 誰が決めるか |
|---|---|---|
| 1 | 先例裁定 | 既に下っている裁定（`decisions` / 回答履歴）と同型なら、それを当てはめる |
| 2 | 実測 | 現物（実装・設定・既存文書）が答えを持つなら、measurement agent が読んで確定する |
| 3 | 質問 | 依頼者の運用・意図・リスク許容にしか答えが無いものだけを、統合ゲートで聞く |
| 4 | 保持規則 | 3 で聞いてなお決まらなかったものを規範文へ変換し、裁定を `work_items` へ |

1・2 は `scripts/refine.js` が**同じラン内で本文へ反映する**。完了時の提示は残数で分かれる。

| `tbd_items` の残数 | 提示 |
|---|---|
| 0 件 | 「このまま次工程に着手できます」＋ 保持規則と `work_items` があればその一覧 |
| 1 件以上 | 「**あと N 個決まれば着手できます**」＋ 残った項目を名指しで列挙 |

**後者を「完成しました」と提示してはならない。** 決まっていないことを決まった風に見せる提示は、
このスキルが防ぐと宣言した失敗そのものである。

### 納品文書に書くのは規範だけ

本文に置いてよいのは**規範文・ID と見出し・上位/姉妹文書への参照・自明でない規則に添える
1 文の理由**だけである（正は `references/document-structure.md` §4）。根拠句・出所表記・
決定ログ・検討の経緯・採らなかった案・未確定事項の章は書かない。読むのはこれから作る人と AI で
あり、彼らが要るのは従うべき規範だけだからである。経緯を混ぜると規範がその中に薄まる。

**どこにも残らなくなるわけではない。** 本文から除いた情報の残る場所（`audit_trail` の内訳・
git commit / PR 本文・保持規則と `work_items`）は `references/document-structure.md` §4 の
対応表を正とする。ここに写しを置かないのは、写しと正本が必ずズレるからである。

## 人間に聞く前に落とす（判定パイプライン）

**なぜ人間ゲートを最小化するのか。** 既に裁定した論点と同型の質問を毎回返すと、ゲートは推奨を
選ぶだけの承認ボタンになり、**本当に人間にしか決められない項目がその中に埋もれる**（実測: 第 2 波
統合ゲートで 4 問すべてが第 1 波裁定の同型だった）。ゲートの価値は件数ではなく、そこに並ぶ 1 問が
人間にしか答えられないことにある。判定は 4 段で、いずれも script が実行経路として持つ。

4 段（ladder-judge → precedent-judge → measurement → script の算術）の各段が何を判定し、
通らなかったものがどこへ行くかの表は `references/workflow-io.md` の判定パイプライン節を正とする。
人間ゲートに届くのは `novel`（先例が無い）/ `conflict`（先例が衝突する）/ `irreversible`
（取り消しが難しい）だけである。**さらにその 3 分類は「プロダクトの価値に関わる判断」
（プロダクトが何をすべきか・何を許すか・何を優先するか・問いを続ける価値があるか）に絞って
解釈する** — 書式・構成・分割・測定方法・文書間整合のような方法論の判断は、先例が無くても
司令塔が既定で決めて決定として事後提示する。人間の境界はプロダクト価値と不変条件
（`.claude/rules/`・`CLAUDE.md` への書き込み、PR のマージ、外部公開）だけである。

- **段 2・3 は迷ったら人間ゲートへ倒す。** 自動裁定の偽陽性は依頼者の決定を勝手に置き換える
  事故であり、余計に聞く偽陰性より重い。judge が応答しなければ全件がゲート行きになる。
- **段 2・3 の決着は同じラン内で本文へ反映される。** 次周回に持ち越す設計にすると、未提示
  blocking が 0 件になったランでは次周回そのものが起きず、解消文が一度も書かれないまま
  「解消済み」として提示される（文書の実体と提示内容の乖離）。
- **司令塔は保存の事後報告で「聞かずに決めた事項」を決定として提示する。** 依頼者はそこで
  覆せる。黙って決めることと、決めた事実を示して覆せるようにすることは別である。

### 下位文書は上位を広げたまま保存しない（階層エスカレーション）

下位文書の要求が上位文書の禁止・義務の範囲を広げている状態（格上げ）は consistency 監査の検出
対象であり、**そのまま保存へ流してはならない**。「後で上位を改訂する TBD を起票した」は解消では
ない — 下位だけを読む実装者と上位だけを読む実装者で規範が食い違う期間が生まれ、その長さを誰も
管理しないからである。司令塔は保存ゲートまでに次のどちらかへ倒す。

1. **下位を狭める**: 上位の範囲に収まる形へ改稿する（既定。上位の改訂を要しない）。
2. **上位改訂案を同梱する**: 上位側に足す 1 文の改訂文案を作り、両方を同時に保存して
   保存の事後報告で**セットで**提示する（覆されたら改稿経路で戻す）。

上位文書も git で可逆な docs である限り 2. は自動実行してよい。上位が不変条件のファイル
（`.claude/rules/` 等）に当たる場合だけ人間ゲートを通す。1. か 2. かの選択そのものは
段 2（先例裁定）の対象にしてよい。

## このスキルが防ぐ失敗

1. **要求の捏造** — 入力に無い要求を、もっともらしい文面で埋める。最も危険。業界知識・類似
   システムの慣行・「普通はこうする」を根拠にしない。証拠なしの「コードがこうなっている」も同じ。
2. **聞かないまま残す** — 決めきれていない項目を、ユーザーに提示しないまま文書に残して完了する。
3. **同型の質問を積む** — 既裁定と同じ判断を毎回聞き、本当に要る質問をその中に埋もれさせる。
4. **検証不能な要求** — 曖昧語でテスト設計できない要求文を書く。
5. **文書間の断絶** — 要求と仕様が辿れない、複数文書の間で重複・矛盾が生じる。
6. **権威の借用** — 規格名を引いて厳格さを演出する。特に、学習データに残った旧規制の条番号を
   現行規制として引用する（実例と禁止語は `references/citation-policy.md`）。

## 対象外・起動条件

- **既存コードの挙動説明**（「この関数の仕様を教えて」）・**文書を伴わない実装依頼** → 発動しない
  （前者は 1 文で伝えて終了する）。**空入力・単語のみ** → 何の文書かを尋ねて終了する（手順 1）。
- **適合性評価・認証取得の支援** → 行わない。規格に言及する場合も「準拠している」とは書かない。
- **実行環境**: このスキルは Claude Code の dynamic workflows に依存する。**Codex では動作しない**
  （`codex` CLI に workflow サーフェスが無い）。install は成功するため、実行時まで気づけない。

手順の本流から外れた状態への対応は `references/workflow-io.md` §6 を正とする。

## 全体フロー

```
司令塔（Workflow の外。SKILL.md の指示であって構造ではない）

  1 モード判定 → 2 事前分析 3 agent 並列（質問 0 件なら止まらない）→ 3 Workflow A
  → 4 統合ゲート（1 回にまとめて聞く）→ 5 Workflow B
  → 新規露出の blocking が残ったときだけ 4 へ戻る（上限 2 周・例外経路）→ 6 保存と事後報告

Workflow A（draft.js が順序を握る）  Write req → Write spec → Executability → Collect
  初稿を書き切る → executability-auditor → 構造検査 → TBD・指摘・audit_trail を返す

Workflow B（refine.js が順序を握る）  Reflect → Audit → Revise → Finalize
  回答の反映 → 監査 → 改稿ループ → 終端裁定 → 判定パイプライン段 2〜4 → INDEX 内容 + 残 TBD
```

**なぜ Workflow を 2 本に割るのか**: Workflow は実行中にユーザー入力を受け取れないので、統合
ゲートを挟むには境界で切るしかない。例外周回の制御は SKILL.md が持つ。

**質問より既定を優先する（draft-first）。** 既定を選んだ事実と理由が決定ログ（`[DECISIONS]`）に
載っていれば、それは捏造ではなく可視化された仮置きであり、依頼者は異議のある行だけ直せる。
判定は `references/question-policy.md` を唯一の正とする。

## 1. モードを判定する

依頼文から次を判定する。これは調査判断ではなくフロー制御なので SKILL.md 側で決める。

| モード | 判定の手掛かり | `mode` |
|---|---|---|
| 新規作成 | 「要件をまとめて」「PRD を書いて」＋対象領域の記述がある | `new` |
| 既存文書レビュー | 既存の requirements / specifications のパスまたは本文が渡される | `review` |
| 要求→仕様の展開 | 「この要求文書から仕様書を起こして」＋所在が示されている | `expand` |
| 対象外 | 既存コードの挙動説明・文書を伴わない実装依頼 | 発動しない旨を 1 文で伝えて終了 |
| 異常系（空入力） | 空・空白のみ・単語のみ | 下の案内文を返して終了 |

**要求文書と仕様書のどちらを作るかは、`references/document-splitting.md` §0 の対応表で判定する。**
表を唯一の根拠とし、語を独自に足さない（足すなら表を直す）。判定結果は統合ゲートの決定ログに
現れるので、誤判定はそこでユーザーが訂正できる。

`review` / `expand` では対象文書を Read し、`existing_docs` として渡す。**渡した文書だけが対象に
なる。** `expand` の requirements は入力として固定され改稿されない（確定済みとして渡した文書が
黙って書き換わらないようにするため）。この制御は script 側にあり、言い聞かせに依存しない。

空入力時の案内文（推測で対象を決めて書き始めない。対象を取り違えた文書は害の方が大きい）:

```
何についての要求文書 / 仕様書かを教えてください。
例: /prd-spec 社内の勤怠申請ツールの要件をまとめたい。承認フローは部長承認のみ。
```

## 2. 事前分析を発行する（3 agent 並列）

同一ターンに 3 つの Agent 呼び出しを発行する。

```
Agent(prompt: "Read [SKILL_DIR]/agents/intake.md for your full role instructions before doing anything else.
               契約は [SKILL_DIR]/schemas/agent-contracts.md §intake を正とする。
               聞くか既定かの判定は [SKILL_DIR]/references/question-policy.md を、
               スキルが固定する前提は [SKILL_DIR]/references/fixed-premises.md を正とする。
               # 依頼文
               <text>
               # モード
               <mode>")

Agent(prompt: "Read [SKILL_DIR]/agents/domain-analyst.md for your full role instructions before doing anything else.
               契約は [SKILL_DIR]/schemas/agent-contracts.md §domain-analyst を正とする。
               # 依頼文
               <text>")

Agent(prompt: "Read [SKILL_DIR]/agents/splitter.md for your full role instructions before doing anything else.
               契約は [SKILL_DIR]/schemas/agent-contracts.md §splitter を正とする。
               分割の指針は [SKILL_DIR]/references/document-splitting.md を正とする。
               # 依頼文
               <text>
               # モード
               <mode>
               # 既存文書（review / expand のみ。kind / topic / パス / 1 行要約）
               <existing_docs の一覧>")
```

> **並列にしてよい根拠**: 3 者は依頼文（＋レビュー/展開モードでは既存文書）だけを入力に、
> **異なる軸を見ており、一方の結論が他方の入力にならない**（依存があるのに並列にすると、
> 後段が空の入力で推測を始める）。

- domain-analyst は 10 観点を三値（該当 / 非該当 / 不明）で返し、いずれにも入力からの根拠を
  添える。根拠が無いものは `不明` として TBD になる（`references/domain-analysis.md`）。
- **intake は質問係ではなく既定選定係である。** 論点を確定 / 決定（`decisions` に起票）/ 質問に
  仕分ける。判定手順は `references/question-policy.md` が正。**質問 0 件が目標値**。
- splitter の分割案は司令塔が裁定する。複数案が出たら**小規模案件は割らない**原則で選び、
  選んだ事実を決定として `decisions` に足す（統合ゲートで異議を受ける）。
- **`review` / `expand` では splitter に既存文書の一覧を渡し、既存の topic を維持する。**
  渡さないと topic の食い違いで「既存文書の改稿」が「別名ファイルの新規執筆」に化け、
  レビュー対象の本文が消える（`draft.js` は分割案と既存文書の対応が取れないと打ち切る）。

**intake の質問が 1 件以上あるときだけ、ここで一度聞く**（AskUserQuestion。候補を選択肢に）。
0 件なら**止まらずに手順 3 へ直行する** — 提示は統合ゲート（手順 4）にまとめる。初稿前に確認の
往復を挟むほど、依頼者は「まだ何も見ていないもの」について答えることになり、回答の質が下がる。
「全部おまかせ」と答えられたら、未回答項目を TBD として起票し、その旨を明示して継続する。

## 3. Workflow A を呼ぶ（draft.js）

```
Workflow({
  scriptPath: "[SKILL_DIR]/scripts/draft.js",
  args: {
    skillDir: "[SKILL_DIR]",
    mode: "new | review | expand",
    input: "<依頼文の全文>",
    answers: "<手順 2 で質問した場合の回答。質問 0 件なら空文字>",
    decisions: [{ id: "D-001", topic: "...", value: "...", why: "...", source: "default", reversibility: "..." }],
    split_plan: {
      requirements:   [{ topic: "auth", concern: "認証と権限" }],
      specifications: [{ topic: "auth", concern: "認証と権限", covers: ["auth"] }]
    },
    tbd_items: [{ id: "TBD-001", text: "...", owner: "", due: "", blocking: true }],
    domain_findings: [{ aspect: "...", verdict: "該当|非該当|不明", evidence: "..." }],
    required_categories: ["..."],
    existing_docs: [{ kind: "requirements", topic: "auth", path: "...", markdown: "..." }],
    paths: { requirements: "docs/requirements", specifications: "docs/specifications" },
    self_containment: "<何を文書に書き写し、何を参照にとどめるかの合意>",
    today: "<Bash の `date +%Y-%m-%d` で取得した日付>"
  }
})
```

**各 args の意味と、返り値の読み方は `references/workflow-io.md` §1〜2 を正とする**（ここに
表を再掲すると必ず drift する）。取り違えると壊れ方が分かりにくいものだけ挙げる。

- `skillDir` — script は自身の位置を解決できず、agent の Read パスがここでしか決まらない。
- `today` — `date +%Y-%m-%d` の実行結果を渡す（script 内では日時生成が禁止）。推測で書かない。
- `paths` — Workflow B に**同じ値**を渡す。違えると本文と INDEX が別ディレクトリに分裂する。
- `self_containment` — 参照方針を採る案件では必須。渡さないと、外出しした語彙リストの数だけ
  「着手不能」の誤検出が量産され、本物の欠落がその中に埋もれる。

Workflow A は分割案の各文書を並列執筆し（specification は全 requirements の ID が揃ってから）、
**書けない箇所に TBD を立てて書き切る** — 全体像が無いと何が足りないか分からない。そのうえで
**executability-auditor を各文書に走らせる**（Workflow B にしか置かないと、「これだけでは
作れない」という最も重要な指摘が、聞き返せない場所で生まれる）。

**途中死からの復旧（`resumeFromRunId` / `audit_rounds`）は `references/workflow-io.md` §3 を正とする。**

## 4〜5. 統合ゲート（人間ゲート）と Workflow B

**原則 1 周で完了する。** 2 周目は「回答の反映で新たに露出した blocking」だけのための例外経路
であり、既定の周回数ではない（上限 2。カウンタ `outer_round` は SKILL.md が持つ）。初回のゲート
で聞き切ることが目標で、周回があることを前提に質問を分割してはならない。

1. **【統合ゲート】** 次を 1 回にまとめて提示する:
   (a) 初稿サマリ（文書構成と summary）/ (b) **決定ログ**（`decisions` の一覧。
   「異議のある行だけ教えてください」の形で報告する — 承認待ちにしない）/
   (c) 聞くべき未確定事項（`blocking_tbd_items`。executability の blocking 起票を含む）/
   (d) 構造検査の `ST-DUP` / `ST-OBSOLETE`。
   **`gate2_skippable` が真のときは質問では止まらない** — (a)(b) を報告だけして 2 へ直行する
   （聞くことが無いのに聞かない。決定ログへの異議は後からでも受けられる）。
   - **提示の前に triage する。** 「書き手が決めて宣言すれば足りるもの」は質問にせず、司令塔が
     候補から選んで `tbd_answers` に決定として書き、`decisions` に D-ID で足して、**決めた事実と
     内容をゲートで報告する**（承認待ちにしない。異議が出たらその周回の回答として上書きする）。
     `references/fixed-premises.md` に関わる TBD は、質問にも決定にもせずそのファイルで解消する。
     **依頼者へ聞くのは novel / conflict / irreversible だけ**（[判定パイプライン](#人間に聞く前に落とす判定パイプライン)）。
     質問 0 件が目標値であり、自分の分類を信用せず `references/question-policy.md` の手順で落とす。
   - **件数から自分で判定しない。** 判定式は script に 1 つだけ置く（`gate2_skippable`）。
     件数で再判定すると、executability が全滅した run で「聞くことが無い」に化ける。
   - **着手不能なものを先頭に**して提示し、`AskUserQuestion` で選択肢を添える（材料は
     `tbd_items[].candidates`。自由記述だけにしない — 答えやすさが回答率を決める）。
   - **初回のゲートで全 blocking を提示し切る**（持ち越しは無い。持ち越しは「周回があるから
     初回で聞き切らない」誘因になり、原則 1 周の設計と矛盾する）。件数が多いときは**同じ決定で
     複数が解消するものを 1 つの問いにまとめる**。
   - まとめてなお返り値の `blocking_over_capacity` が真なら、それは提示の工夫では吸収できない
     **起票側の較正失敗**である。聞き方を変える前に `references/traceability.md` §4 の基準で
     blocking を落とせる項目を探す。
   - 「分からない」「後で決める」と答えられた項目は blocking のまま残すが、**提示済みとして
     記録する**（段 4 で保持規則に変換される）。推測で埋めない。
   - 提示した TBD の `{ id, digest }` を `presented_tbd_ids` に積む（前周までの分と合算する。
     digest は `blocking_tbd_items[]` に script が計算済みの値を転記する）。
2. **初稿を workspace に書き出す。** `documents[]` の `markdown` を 1 文書ずつ
   `~/.claude/prd-spec-workspace/<案件>/drafts/r<outer_round>/<kind>-<topic>.md` に Write し、
   各文書の `draft_path` にそのパスを入れ、**args の `documents` からは `markdown` を落とす**
   （全文を args で中継すると 12 文書で 24 万文字を超え、司令塔が本文を書き写す経路そのものが
   劣化点になる）。writer は `draft_path` を Read して本文を得る。`review` / `expand` で既存
   文書を改稿する周回は `path` が下敷きになるので不要。対象リポジトリには書かない。
3. **Workflow B を呼ぶ。**

```
Workflow({
  scriptPath: "[SKILL_DIR]/scripts/refine.js",
  args: {
    skillDir: "[SKILL_DIR]",
    mode: "new | review | expand",
    input: "<依頼文の全文>",
    answers: "<手順 2 の回答（質問しなかったランは空文字）>",
    decisions: <直前の decisions（統合ゲートで上書き・追加された分を反映したもの）>,
    tbd_answers: "<今周回の統合ゲートの回答。質問で止まらなかったなら空文字>",
    tbd_answers_history: <前周回の返り値の tbd_answers_history をそのまま。1 周目は []>,
    documents: <直前の documents（markdown を落とし draft_path を入れたもの。trace はそのまま）>,
    tbd_items: <直前の tbd_items をそのまま>,
    presented_tbd_ids: [{ id: "TBD-001", digest: "<blocking_tbd_items[].digest を転記>" }, ...],
    outer_round: 1,
    domain_findings: [...], required_categories: [...],
    draft_structural_findings: <Workflow A の structural_findings をそのまま>,
    self_containment: "<手順 4 で合意した参照方針。無い案件では空文字>",
    paths: { requirements: "docs/requirements", specifications: "docs/specifications" },
    today: "<date +%Y-%m-%d>"
    // audit_rounds は通常渡さない（渡すのは途中死からの復旧時だけ。workflow-io.md §3）
  }
})
```

**各 args の意味と、Workflow B の内部機構（監査ループ・乾き停止・終端裁定・判定パイプライン
段 2〜4）は `references/workflow-io.md` §4〜5 を正とする。** 取り違えると壊れ方が分かりにくい
ものだけ挙げる。

- `tbd_answers` — **今周回の**回答。空なら script は反映パスを飛ばす。
- `presented_tbd_ids` — `{ id, digest }` の形（digest は script が計算済みの値。生 text を
  入れると全件が「未提示」に化ける）。**2 周目は `next_args` が埋めるので手で作らない**。
- `documents[].trace` — 落とさない。落とすと根拠の対応が消え、構造検査が全項目を未検査にする。

4. **【判定】** `unpresented_blocking` を見る。**式は script 側にしかない。ここで再実装しない。**
   2 周目に入れる条件は「新たに露出した blocking がある」ことだけである
   （`first_seen_round` が今周回の項目。初回から見えていた blocking を持ち越して
   2 周目の理由にしない — それは初回ゲートの提示漏れであり、周回で救済しない）。

| `unpresented_blocking` の状態 | 周回 | 次 |
|---|---|---|
| 0 件 | — | ループを抜けて手順 6 |
| `first_seen_round` = 今周回の項目がある | 1 | 統合ゲートへ戻ってもう 1 周（例外経路） |
| 残があるが全て初回から既知 | — | ループを抜ける。**初回ゲートの提示漏れとして手順 6 で明示する** |
| 1 件以上 | 2 | ループを抜ける。**提示されずに残った項目がある事実を手順 6 で明示する**（黙って完了しない） |

2 周目の呼び出しは**返り値の `next_args` を使う**。`tbd_answers` の `"<<ANSWER_HERE>>"` を回答で
置換し、それ以外はそのまま渡す。**args の手組みはしない** — 30〜70KB の転記は写し間違いの温床
であり、script が完全形を組み立て済みである（周回上限では `next_args` は `null`）。

## 6. 結果を提示して保存する（保存と事後報告）

> **保存は人間ゲートではない。** 保存先が git で可逆な docs である限り、司令塔は保存まで
> 自動実行し、下の 1〜6 を**事後報告**として提示する（依頼者はそこで覆せる。覆されたら
> 改稿経路で直すか revert する）。止まるのは次の 3 つだけ:
> (a) 保存が不変条件（`.claude/rules/`・`CLAUDE.md`、PR のマージ、外部公開）に触れる、
> (b) 保存先が git 管理下でなく取り消せない、
> (c) このランの生成物でない既存ファイルを上書きする（下の衝突規則）。

1. **監査結果サマリを提示する。指摘 0 件でも「0 件だった」と明示する**（黙って省略すると、
   検査していないのか合格したのか読み手に区別できない）。`summary` の値が `null` の項目は
   「0 件」ではなく**「検査されていない」**として伝える。
2. `verdict` が `clean` 以外なら理由を先に述べる。`audit_incomplete` なら**どの auditor が
   応答しなかったかを名指しで**伝え、「失格 0 件」と読み替えない。`writer_missing` が空で
   なければ、それは「改稿したが直らなかった」ではなく**「一度も直されていない」**である。
3. **人間に聞かずに決めた事項を決定として事後提示する。** `auto_resolved_blocking`（先例）と
   `resolved_by_measurement`（実測。証拠付き）を根拠つきで一覧にする。**依頼者はここで覆せる**
   （覆されたら改稿経路で直す）。黙って決めることと、示して覆せるようにすることは別である。
4. **保持規則と作業項目を提示する。** `holding_rules` は文書に規範文として入っている旨を、
   `work_items` は保存時に `gh issue create` で起票し、起票した番号を報告する
   （対応する保持規則 ID を本文に含める）。
5. **残 TBD の数で提示文を変える**（[完成の定義](#完成条件は未確定事項tbd-0-件である)）。
   周回上限で `unpresented_blocking` が残ったなら、「提示できていない項目が N 件ある」と明示する。
6. **保存の報告に、絶対品質採点を必ず含める**（司令塔の任意行動ではなく手順である）。
   fresh context の検査 agent に `references/quality-checklist.md` の項目を四値（pass / fail /
   not-applicable / not-checked）で採点させ、監査サマリと並べて提示する。**採点の材料は文書と
   返り値（`audit_trail`）の両方**である（文書だけを見て「根拠が無い」と採点させない）。
7. 文書一覧を提示する（本文は保存済みのパスで示す）。
   - **司令塔は生成文書を手編集しない。** 採点や監査で指摘が出ても、修正は改稿経路
     （writer + 監査、Workflow B の再実行または `review` モード）を通す。通さないなら
     指摘を残したまま保存し、残っている事実を明示する。手編集は Generator と Verifier の
     分離を最後の工程で破り、誰にも検査されていない版が成果物になる。
   - **writer を直接呼んで指摘を直した場合も、その版に fresh 監査を 1 パス当ててから
     保存する。** 指摘に 1 対 1 で対応させた局所修正でも新しい欠陥は入る（実測: 監査指摘
     対応で新設した 6 要求のうち 4 件に、取得失敗時の非出力との衝突・上位より狭い典拠集合・
     EARS 語尾の不揃い・検証不能な参照が入っていた。再監査で捕まった）。修正回数が
     少ないことは検査を省く理由にならない。
8. 保存の実行規則。
   - 各文書 → `documents[].path`。INDEX → `index_paths.*` に `index.*` の内容をそのまま
     書き出す。**INDEX は導出物であり、手書きしない**（手書きの目次は必ず本体と drift する）。
     `index` にその kind のキーが無いランでは**再生成しない**（既存のものを残す）。
   - **経緯は commit と PR 本文に残す。** 文書に決定ログも経緯も書かない以上、「なぜこの規範に
     なったか」「どの案を採らなかったか」の永続化はここが唯一の場所である。commit メッセージに
     主要な決定（`audit_trail.decisions` と聞かずに決めた事項）を、PR 本文に保持規則と
     `work_items` の一覧を書く。**git 管理下でない案件では、経緯が会話ログにしか残らない
     ことを保存時に 1 文で伝える。**
   - **途中成果物（初稿・各版・監査結果）を残したい場合は `~/.claude/prd-spec-workspace/<案件>/`
     を使う。** 対象リポジトリの中に作業ファイルを置かない — そのリポジトリの `.gitignore` は
     利用者の持ち物であり、こちらが管理してよいものではない。
   - **新規保存で同名ファイルが既存だった場合**（衝突 = このランの生成物でないものへの上書き）:
     上書きしない。差分を提示して判断を求める（これは人間ゲート (c)）。
   - **`review` / `expand` モードで意図的に既存文書を改訂する場合**（衝突ではない）: 止めない。
     旧内容との差分と変更理由を**ユーザーへ提示したうえで**上書きする。この 2 つを混同すると、
     意図した改訂が「衝突」として止まるか、意図しない上書きが無警告で通る。
9. 承認欄を置いた案件では、**このスキルは承認者の実在も承認の事実も確認できない**ため、
   記入されるのは「ユーザーがそう申告した文字列」に過ぎない旨を保存時に 1 文で伝える
   （承認欄を置く条件の正は `references/document-structure.md` §4）。

## 入出力の定義

**入力**: 自然言語の依頼（日本語）。既存文書 / 議事録 / Slack ログ / 手書きメモの貼り付けを
含みうる。**出力**: 保存して事後報告する（固定 2 ファイルではない）。

| 出力 | パス | 備考 |
|---|---|---|
| 要求文書 | `docs/requirements/<topic>.md`（1 つ以上） | 常設章は `references/document-structure.md` を正とする |
| 要求 INDEX | `docs/requirements/INDEX.md` | 導出物。script の返り値から書き出す |
| 仕様書 | `docs/specifications/<topic>.md`（1 つ以上） | トレーサビリティ表は**自分がカバーする要求の分だけ**を持つ |
| 仕様 INDEX | `docs/specifications/INDEX.md` | 導出物。純粋な目次（逆参照は各仕様書の表にあるので置かない） |
| 監査証跡・監査結果サマリ | （ファイルにしない） | 返り値として提示し、経緯は commit / PR 本文に残す |
| 作業項目 | GitHub Issue | `work_items` を保存時に起票する |

通しの例は `[SKILL_DIR]/references/io-example.md` にある。

## 注意事項

- **規格・規制への言及は既定で行わない。多くの案件では規格に一切言及しない文書が正解である。**
  言及するのは、ユーザーが明示的に求めた場合か、分析で対象だと**入力から確認できた**場合に限る。
  引用してよい典拠と書いてはならない語は `references/citation-policy.md` を正とする
  （後者は script の完全一致検査でも押さえる）。
- **監査指摘の語り口**は責める調子にしない。「この要求はこのままだとテスト設計できません」という
  事実の指摘として書く。
- **未解決の記録は成果物側に残る。** 決まらない論点は本文の保持規則になり、裁定は Issue になる
  （会話ログにしか無い状態にしない）。**改稿の経緯は成果物に残さない**（document-structure.md §4）。
- **助動詞規約・曖昧語リスト・ID 体系・常設章・分割の指針・args の意味**の詳細は SKILL.md に
  置かない。下表の参照ファイルが唯一の正であり、ここに写しを持つと必ず drift する。
- **このスキル自身の文章にも同じ規範を適用する**（独自用語を発明しない・定義は箇条書き・
  同じ概念を 2 箇所で定義しない）。

## 参照ファイル構成

**この表は「どのファイルが何の正か」を宣言する。** 各 agent のモデル割当は scripts 側の spawn
指定（`refine.js` の `AUDITORS` と `draft.js` / 事前分析の呼び出し）が唯一の正であり、この表には
書かない（書くと必ず drift する）。同じ概念を 2 ファイルで定義すると、両方を読む agent が矛盾を
自分で裁くことになる。二重定義は `tests/test_no_duplicate_definitions.py` が機械で検出する
（検査対象の概念一覧はそのファイルが持つ。概念を増やしたら足すこと）。

| パス | 役割 |
|---|---|
| `[SKILL_DIR]/agents/intake.md` | 初稿に要る情報の充足判定と質問生成 |
| `[SKILL_DIR]/agents/domain-analyst.md` | 10 観点の三値判定と要求カテゴリの導出 |
| `[SKILL_DIR]/agents/splitter.md` | 文書の分割案の作成 |
| `[SKILL_DIR]/agents/req-writer.md` | requirements 文書の執筆・改稿 |
| `[SKILL_DIR]/agents/spec-writer.md` | specification 文書の執筆・改稿 |
| `[SKILL_DIR]/agents/executability-auditor.md` | 実行可能性の検査。blocking / degraded を付ける |
| `[SKILL_DIR]/agents/clarity-auditor.md` | 曖昧語・助動詞規約・単一要求の検査 |
| `[SKILL_DIR]/agents/traceability-auditor.md` | 紐付けの欠落と検証方法の実質の検査 |
| `[SKILL_DIR]/agents/coverage-auditor.md` | 導出カテゴリの反映検査 |
| `[SKILL_DIR]/agents/fabrication-auditor.md` | 根拠不明の断定の検出（`audit_trail` と入力を突き合わせる） |
| `[SKILL_DIR]/agents/consistency-auditor.md` | 文書間の重複・矛盾・INDEX との齟齬・階層エスカレーションの検査 |
| `[SKILL_DIR]/agents/validity-auditor.md` | 内容の妥当性（要求の筋・相互矛盾・欠落・宣言漏れ）の検査 |
| `[SKILL_DIR]/agents/specimen-auditor.md` | 標本適用監査。各項目を実在の標本文書に適用する（初回と終端のみ） |
| `[SKILL_DIR]/agents/ladder-judge.md` | **判定パイプライン段 1**: 監査指摘を failure kind で 4 分類する |
| `[SKILL_DIR]/agents/measurement.md` | **判定パイプライン段 3**: 現物を読んで事実を確定する（段 2 の precedent-judge は refine.js 内のプロンプトで、契約は schemas 側にある） |
| `[SKILL_DIR]/references/requirement-writing-rules.md` | 助動詞規約・曖昧語リスト・単一要求・根拠の申告・書き換え例 |
| `[SKILL_DIR]/references/prd-and-spec.md` | **正**: 2 文書の目的と切り分け・**目的側の必須内容項目**・手段側の上限（設計解を書かない）・分量の決まり方・典拠の強度 |
| `[SKILL_DIR]/references/document-structure.md` | **正**: 章立て・表と図の使い分け・状態遷移図と状態 × イベント表・**本文に書くのは規範だけという規律（§4）**。**何が必須の内容かは `prd-and-spec.md` §4** |
| `[SKILL_DIR]/references/traceability.md` | **正**: **ID の形式**・トレーサビリティ表・TBD の `blocking` / `presented` |
| `[SKILL_DIR]/references/workflow-io.md` | **正**: Workflow A / B の args と返り値の読み方・途中死からの復旧・Workflow B の内部機構・手順の本流から外れた状態への対応 |
| `[SKILL_DIR]/references/io-example.md` | 依頼文から生成文書までの通しの例 |
| `[SKILL_DIR]/references/document-splitting.md` | **正**: 何を作るかの判定・分割の軸・topic 命名と領域コードの対応・2 つの INDEX の構成。**ID の形式は `traceability.md` §1** |
| `[SKILL_DIR]/references/domain-analysis.md` | 分析観点・三値判定・導出例・押しつけ禁止 |
| `[SKILL_DIR]/references/citation-policy.md` | 規格言及の要否判断・引用可能な典拠・禁止語 |
| `[SKILL_DIR]/references/fixed-premises.md` | **正**: スキルが固定する前提の一覧（案件ごとに問い直さない） |
| `[SKILL_DIR]/references/question-policy.md` | **正**: 聞くか既定かの判定手順・決定ログ（decisions）の書式と受理条件・既定にしてはならないもの |
| `[SKILL_DIR]/references/quality-checklist.md` | 生成物の絶対品質チェックリスト（外部規範由来・出典付き）。各項目の定義の正は既存 references にある |
| `[SKILL_DIR]/schemas/agent-contracts.md` | agent 間の入出力契約（TBD・trace・precedent-judge・measurement を含む） |
| `[SKILL_DIR]/scripts/draft.js` | Workflow A（初稿 + 実行可能性検査 + 構造検査 + `audit_trail`） |
| `[SKILL_DIR]/scripts/refine.js` | Workflow B（改稿 + 監査ループ + 判定パイプライン段 2〜4 + INDEX 組み立て） |
| `[SKILL_DIR]/scripts/check_blocking_rate.py` | **正**: 人間ゲートの提示容量の定数。返り値 JSON に対する回帰ゲートとしても使う（欠測は exit 2 で「未計測」） |
| `[SKILL_DIR]/tests/` | 回帰テスト群。`python3 -m unittest discover [SKILL_DIR]/tests` で全実行する |
| `[SKILL_DIR]/evals/evals.json` | テストケース |
| `[SKILL_DIR]/evals/trigger-evals.json` | description の発火評価（`run_loop.py --eval-set` で使う） |
