---
name: prd-spec
description: >
  要求文書（requirements）と仕様書（specifications）を日本語で作成・レビューするスキル。
  要求文書は関係者の認識が一致する状態まで、仕様書は実装が一意に決まる状態まで詰める
  （2 つは目的が違うので、分量の決まり方も違う）。「PRD を書いて」「要件定義をまとめて」
  「これを仕様書に落として」「この PRD をレビューして」「要求から仕様書を起こして」といった依頼で
  使うこと。ドメインは問わず、助動詞規約・曖昧語の排除・ID とトレーサビリティ・未確定事項（TBD）の
  起票を常時適用する。入力に無い要求を推測で埋めず、決めきれていない項目はユーザーに聞き返してから
  完了する。関心事ごとに複数ファイルへ分割し、ディレクトリごとの INDEX を導出する。既存コードの
  挙動説明（「この関数の仕様を教えて」）や、文書を伴わない実装・修正依頼には発火しない。
  要求・仕様の体裁を取らない一般ドキュメントの執筆（提案書・意思決定文書・README・ブログ・
  議事録の要約）や設計判断の壁打ちにも発火しない — それらは文書共同執筆・相談系のスキルの領分。
  空入力・単語のみの入力では作成に入らず、何の文書かを尋ねて終了する。
---

# prd-spec（要求文書・仕様書の作成とレビュー）

**目次**: [目的（完成の定義）](#目的完成の定義) · [このスキルが防ぐ失敗](#このスキルが防ぐ失敗) · [対象外・起動条件](#対象外・起動条件) · [全体フロー](#全体フロー) · [1. モードを判定する](#1-モードを判定する) · [2. 事前分析を発行する（3 agent 並列）](#2-事前分析を発行する3-agent-並列) · [3. Workflow A を呼ぶ（draft.js）](#3-workflow-a-を呼ぶdraftjs) · [Workflow A の返り値と人間への提示](#workflow-a-の返り値と人間への提示) · [4〜5. 統合ゲート（人間ゲート①）と Workflow B](#45-統合ゲート人間ゲート①と-workflow-b) · [6. 結果を提示して保存する（保存承認＝人間ゲート②）](#6-結果を提示して保存する保存承認人間ゲート②) · [入出力の定義](#入出力の定義) · [入出力の例](#入出力の例) · [異常系・準正常系・正常系エッジ](#異常系・準正常系・正常系エッジ) · [注意事項](#注意事項) · [参照ファイル構成](#参照ファイル構成)

---

## 目的（完成の定義）

**2 つの文書は目的が違う。分量の決まり方も違う。** 何を書く文書なのかは
`references/prd-and-spec.md` を正とする。

| 文書 | 目的 | 分量が決まる基準 |
|---|---|---|
| **要求文書**（目的側） | **関係者の認識が一致していること** | 一致させるのに要る量。**網羅ではない** |
| **仕様書**（手段側） | **実装が一意に決まること** | 設計・実装・検証ができる量。**設計解は書かない** |

この 2 つを取り違えると分量が壊れる。要求文書の分量を決めるのは関係者の数と合意の重さで
あり（「迷いなく完走できるまで書く」を課すと上限が消える）、仕様書は**委ねないために書く**
ので短さを目標にできない。分量の決まり方は `references/prd-and-spec.md` §7 を正とする。

この目的から 2 つの結論が出る。

- **TBD は成果物ではなく、失敗の記録である。** 未確定を正直に残すのは正しいが、それだけでは
  目的を達成していない。TBD が大量に残った文書からは次工程が始まらない。
- **推測で埋めることは、それ以上に悪い。** 両立する道は 1 つしかない — **聞き切ること**。
  だからこのスキルの中核は執筆ではなく、**書いてみて足りないと分かったことを、書き終わった
  時点でユーザーに聞き返すループ**にある。

### 完成条件は「blocking 0 件」ではない

> **保証すべきなのは「未提示の blocking TBD が 0 件」である。**
> 残っている blocking は、すべて少なくとも 1 回はユーザーに提示されたものである。

「着手を止める未確定事項（blocking TBD）が 0 件」を完成条件にしてはならない。**保証できない**
からである。ユーザーが決めていないことは、何回聞いても決まらない。「上限金額は未定」は聞いても
消えない。それは失敗ではなく正しい状態である。一方「聞かれもせずに残っていた」は構造的に
無くせる。だから完成条件はそちらに置く。この判定は `scripts/refine.js` が
`unpresented_blocking` として算出し、SKILL.md はその件数を見るだけである。

### 既裁定の同型は人間に聞き直さない（先例裁定）

blocking TBD であっても、決定ログ・回答履歴に同型の先例があるものは人間ゲートに積まない。
毎回聞くと、ゲートは推奨を選ぶだけの承認ボタンになり、本当に人間にしか決められない項目が
その中に埋もれる（実測: 第 2 波統合ゲートで 4 問全てが第 1 波裁定の同型だった）。
`refine.js` の precedent-judge が未提示 blocking を先例と突き合わせ、解消できるものを
`auto_resolved_blocking`（先例 ID・解消文つき）として返す。司令塔はこれを質問せずに
次周回の `tbd_answers` へ採り、新しい決定（D-NNN、根拠に先例 ID）として `decisions` に足し、
**保存承認ゲートで決定ログとして事後提示する**（依頼者はそこで覆せる）。
人間ゲートへ残るのは、先例が無い（novel）・先例同士が衝突する（conflict）・
取り消しの難しい影響を持つ（irreversible）ものだけである。judge が応答しなかったときは
全件がゲート行きになる — 自動裁定は欠測で増えない側に倒してある。

完了時の提示は blocking TBD の残数で 2 通りに分かれる。

| 残数 | 提示 |
|---|---|
| 0 件 | 「このまま次工程に着手できます」 |
| 1 件以上 | 「**あと N 個決まれば着手できます**」＋ 残った項目を名指しで列挙 |

**後者を「完成しました」と提示してはならない。** 決まっていないことを決まった風に見せる提示は、
このスキルが防ごうとしている失敗そのものである。

## このスキルが防ぐ失敗

1. **要求の捏造** — 入力に無い要求を、もっともらしい文面で埋める。最も危険。業界知識・
   類似システムの慣行・「普通はこうする」を根拠にしない。
2. **聞かないまま残す** — 決めきれていない項目を、ユーザーに提示しないまま文書に残して完了する。
   目的に照らせば、これは捏造と同じくらい目的を外している。
3. **検証不能な要求** — 曖昧語でテスト設計できない要求文を書く。
4. **文書間の断絶** — 要求と仕様が辿れない、複数文書の間で重複・矛盾が生じる。
5. **権威の借用** — 規格名を引いて厳格さを演出する。特に、学習データに残った旧規制の条番号を
   現行規制として引用する（実例と禁止語は `[SKILL_DIR]/references/citation-policy.md`）。

## 対象外・起動条件

- **既存コードの挙動説明**（「この関数の仕様を教えて」）→ 発動しない。1 文で伝えて終了する。
- **文書を伴わない実装・修正依頼** → 発動しない。
- **適合性評価・認証取得の支援** → 行わない。規格に言及する場合も「準拠している」とは書かない。
- **空入力・単語のみ** → 何の文書かを尋ねて終了する（手順 1）。
- **実行環境**: このスキルは Claude Code の dynamic workflows に依存する。**Codex では動作しない**
  （`codex` CLI に workflow サーフェスが無い）。install は成功するため、実行時まで気づけない。

状態ごとの詳しい対応は [異常系・準正常系・正常系エッジ](#異常系準正常系正常系エッジ) に一本化してある。

## 全体フロー

```
司令塔がやること（Workflow の外・SKILL.md の指示であって構造ではない）

  1. モードを判定する（新規作成 / 既存文書レビュー / 要求→仕様の展開 / 対象外・空入力）
  2. intake（既定選定）・domain-analyst・splitter を【同一ターンに並列】発行する
     → intake の質問（既定を選べなかったもの）が 1 件以上あればここで一度だけ聞く。
       0 件なら止まらずに 3 へ直行する
  3. Workflow A を呼ぶ（scripts/draft.js。決定ログを渡す）
  4. 初稿サマリ・決定ログ（異議受付）・blocking TBD を 1 回にまとめて提示し、
     回答を得る  ← 統合ゲート（人間ゲート①）
  5. Workflow B を呼ぶ（scripts/refine.js）
     → 原則ここで完了。回答の反映で【新たに露出した】blocking が残った場合に限り、
       4 へ戻ってもう 1 周する（周回は上限 2。2 周目は例外経路であって既定ではない）
  6. 結果を提示し、承認後に保存する  ← 保存承認（人間ゲート②）

Workflow A がやること（draft.js が順序を握る）

  Write requirements → Write specifications → Executability → Collect
  初稿を書き切る → executability-auditor → 構造検査 → TBD と指摘を返す

Workflow B がやること（refine.js が順序を握る）

  Reflect → Audit → Revise → Finalize
  回答の反映 → 7 観点監査 → 改稿ループ → INDEX 内容 + unpresented_blocking
```

**なぜ Workflow を 2 本に割るのか**: Workflow は実行中にユーザー入力を受け取れない。統合ゲートを
挟むには境界で切るしかない。回答の反映で新たな blocking が露出することがあるので、例外周回の
制御は SKILL.md が持つ。

**質問より既定を優先する（draft-first）。** 既定を選んだ事実と理由が決定ログ（`[DECISIONS]`）
に載っていれば、それは捏造ではなく可視化された仮置きであり、依頼者は異議のある行だけ直せる。
聞くか既定かの判定は `references/question-policy.md` を唯一の正とする。

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
「PRD」「要件定義」→ requirements、「仕様書」「spec」→ specifications、どちらも無いか両方あれば
両方。表を唯一の根拠とし、語を独自に足さない（足すなら表を直す）。判定結果は統合ゲートの
決定ログに現れるので、誤判定はそこでユーザーが訂正できる。

`review` / `expand` では対象文書を Read し、`existing_docs` として渡す。**渡した文書だけが対象に
なる。** `expand` の requirements は入力として固定され、改稿されない（ユーザーが確定済みとして
渡した文書が黙って書き換わらないようにするため）。この制御は script 側にあり、言い聞かせに依存しない。

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
> **異なる軸を見ており、一方の結論が他方の入力にならない**。この独立性を確認したうえでの
> 並列である（依存があるのに並列にすると、後段が空の入力で推測を始める）。

- domain-analyst は 10 観点を `該当` / `非該当` / `不明` の三値で返し、該当・非該当のいずれにも
  入力からの根拠を添える。根拠が無いものは `不明` として TBD になる（`references/domain-analysis.md`）。
- **intake は質問係ではなく既定選定係である。** 論点を確定（依頼文に答えがある）/ 決定
  （既定を選んだ。`decisions` に起票）/ 質問（既定を選べない）に仕分ける。判定手順は
  `references/question-policy.md` が正。**質問 0 件が目標値**。
- splitter の分割案は司令塔が裁定する。splitter が複数案を出したら、**小規模案件は割らない**
  原則で選び、選んだ事実を決定として `decisions` に足す（統合ゲートで異議を受ける）。
- **`review` / `expand` では splitter に既存文書の一覧を渡し、既存の topic を維持する。**
  渡さないと topic の食い違いで「既存文書の改稿」が「別名ファイルの新規執筆」に化け、
  レビュー対象の本文が消える（`draft.js` は分割案と既存文書の対応が取れないと打ち切る）。

**intake の質問が 1 件以上あるときだけ、ここで一度聞く**（AskUserQuestion。候補を選択肢に）。
0 件なら**止まらずに手順 3 へ直行する** — 決定ログと分析結果の提示は統合ゲート（手順 4）に
まとめる。初稿前に確認の往復を挟むほど、依頼者は「まだ何も見ていないもの」について答える
ことになり、回答の質が下がる。

- 「全部おまかせ」と回答された → 未回答項目を TBD として起票し、その旨を明示して継続する。

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

| args | 意味 |
|---|---|
| `skillDir` | スキルの実ディレクトリ絶対パス。script は自身の位置を解決できず、agent の Read パスがここでしか決まらない |
| `self_containment` | **参照方針を採る案件では必須。** executability-auditor へ渡り、「参照先を見れば分かること」を着手不能として数えさせない。渡さないと、外出しした語彙リストの数だけ誤検出が量産され、本物の欠落がその中に埋もれる |
| `mode` | 手順 1 の判定。生成対象そのものを決める |
| `input` / `answers` | 確定要求の根拠原本（fabrication-auditor が照合する）。`answers` は手順 2 で質問したランのみ |
| `decisions` | intake の決定ログ + 司令塔が足した決定（分割の裁定など）。writer は `（既定: D-N）` の出所で使い、auditor は実在すれば受理する。書式と範囲の正は `references/question-policy.md` |
| `split_plan` | 採用した分割案（splitter 案から司令塔が裁定し、裁定は decisions に載せる）。構成は args で固定する |
| `tbd_items` | 未回答項目の持ち越し。確定要求に混ぜないため |
| `domain_findings` | 三値判定と根拠。「リスクと影響」章に非該当を根拠付きで残すのに要る |
| `required_categories` | 導出カテゴリ。writer が反映し coverage-auditor が実在を検査する |
| `existing_docs` | `review` / `expand` で Read した既存文書。渡した側だけが対象になる |
| `today` | `YYYY-MM-DD`。文書中に日付が要るときの基準日。script 内では日時生成が禁止されているため args で渡すしかない |

`today` は Bash で `date +%Y-%m-%d` を実行して得た値を渡す。日付を推測で書かない。

Workflow A は分割案の各文書を並列執筆し（specification は全 requirements の ID が揃ってから）、
**書けない箇所に TBD マーカーを置いて書き切る** — 全体像が無いと何が足りないか分からない。
そのうえで **executability-auditor を各文書に走らせる**。Workflow B にしか置かないと、
「これだけでは作れない」という最も重要な指摘がヒアリングの後（聞き返せない場所）で生まれる。

## Workflow A の返り値と人間への提示

```
{ status, verdict, mode, targets, documents[], requirement_ids, spec_ids,
  tbd_items[], blocking_tbd_ids[], blocking_tbd_items[],
  gate2_skippable, gate2_reason, paths,
  executability: { findings[], blocking_count, degraded_count, missing[] },
  structural_findings[], structural_not_checked[],
  categories_deferred[], writer_missing[], summary }
```

| 項目 | 読み方 |
|---|---|
| **`gate2_skippable`** | **統合ゲートで質問のために止まるか（偽なら止まる）の唯一の判定。** 件数から再判定しない。真でも初稿サマリと決定ログの報告は行う（報告のみで直行） |
| `gate2_reason` | `no_blocking`（聞くことが無い）/ `blocking_present`（聞く項目がある）/ `structural_presentation_required`（`ST-DUP` / `ST-OBSOLETE` が残っており提示が要る）/ `executability_incomplete`（**検査が完了していないので飛ばせない**） |
| `blocking_tbd_ids` | **まだ誰にも提示していない生の一覧。** この時点では `presented_tbd_ids` が存在しないため「未提示」は自明であり、`unpresented_blocking` はここでは算出されない |
| `executability.findings[].severity` | `blocking`（着手できない）/ `degraded`（着手はできるが後で作り直しになりうる）。blocking は script が TBD として起票し直し、`tbd_items` に含めている（ID は `TBD-EX-` 始まり） |
| `executability.missing` | 応答しなかった検査。**「指摘 0 件」と読まない。** 名指しで提示する |
| `categories_deferred` | **`required_categories` に含まれるものだけ**が入る。writer が別名を返したら`ST-UNKNOWN-CATEGORY-<名前>` として構造検査に出し、下流へは渡さない — このリストはcoverage-auditor への免罪符なので、導出カテゴリに無い名前は何も免除せず、「deferred にあるのに TBD が無い」検査で偽の指摘に化ける |
| `structural_findings` | 初稿段階の構造検査。**`ST-DUP` と `ST-OBSOLETE` は統合ゲートで提示する** — 前者は分割案の ID 体系の問題でユーザー判断が要り、後者は廃止済み規制の混入だから。それ以外は `draft_structural_findings` として Workflow B に渡し、初回改稿の契機に合流させる |
| `structural_not_checked` | **材料が無くて実行できなかった検査。「0 件」ではなく「未検査」として伝える** |
| `paths` | Workflow B に**そのまま渡す**。A と B で違う値を使うと本文と INDEX が別ディレクトリに分裂する |
| `status: "BLOCKED"` | writer が文書を返さなかった。文書を捏造せず止めた状態。`writer_missing` でどれが返らなかったかを伝える |

**`BLOCKED` が API エラー由来のときは再開できる**（品質の問題ではないため）。

```
Workflow({ scriptPath: "[SKILL_DIR]/scripts/draft.js", resumeFromRunId: "<Run ID>", args: { ...同じ args... })
```

**`resumeFromRunId` だけでは `args` が引き継がれず即座に落ちる。** 同じ `args` を必ず添える。
なお公式仕様上、**落ちた agent より後に起動した agent は完了済みでも再実行される**
ので、executability 検査は一部やり直しになる。

### セッション上限で Workflow B が途中死したとき（`audit_rounds`）

改稿の途中で死ぬと、改稿された文書と未改稿の文書が混在し、**片側 ID が大量に出る**。
これは中身の欠陥ではなく適用の未完了なので、**統合ゲートの質問としてユーザーへ回してはならない。**
素直に resume すると監査をもう一巡してから改稿に入り、同じ規模の予算を要求して同じ場所で死ぬ。
診断は既にキャッシュにあるので、**必要なのは適用だけ**である。

```
Workflow({ scriptPath: "[SKILL_DIR]/scripts/refine.js", resumeFromRunId: "<Run ID>",
           args: { ...同じ args..., audit_rounds: 1 } })
```

`audit_rounds: 1` は **r0 だけ agent 監査を行い、以降は構造検査（script の算術）だけで
改稿ループを回す**。構造検査は agent を使わないので抑制されず、片側 ID と TBD 申告漏れは
改稿のたびに再計算される。summary の各観点は r0 の結果を保持する（未実施を 0 件に化けさせない）。

**再開直後に r0 の監査 agent が live で走り始めたら止めること。** 何かが prompt を変えており、
キャッシュが効いていない。そのまま流すと予算だけ溶ける。journal ではなく、走っている agent が
writer だけかで判定する。

## 4〜5. 統合ゲート（人間ゲート①）と Workflow B

**原則 1 周で完了する。** 2 周目は「回答の反映で新たに露出した blocking」だけのための
例外経路であり、既定の周回数ではない（上限 2。周回カウンタ `outer_round` は SKILL.md が持つ）。
初回のゲートで聞き切ることが目標で、周回があることを前提に質問を分割してはならない。

1. **【統合ゲート＝人間ゲート①】** 次を 1 回にまとめて提示する:
   (a) 初稿サマリ（文書構成と summary）/ (b) **決定ログ**（`decisions` の一覧。
   「異議のある行だけ教えてください」の形で報告する — 承認待ちにしない）/
   (c) `blocking_tbd_items`（初稿の TBD と executability の blocking 起票を含む）/
   (d) 構造検査の `ST-DUP` / `ST-OBSOLETE`。
   **`gate2_skippable` が真のときは質問では止まらない** — (a)(b) を報告だけして 2 へ直行する
   （聞くことが無いのに聞かない。決定ログへの異議は後からでも受けられる）。
   - **提示の前に triage する。** 各 TBD を「依頼者にしか決められないもの」と「書き手が決めて
     宣言すれば足りるもの」に分ける（判定手順は `references/question-policy.md` を正とする）。
     後者は**質問にしない** — 司令塔が候補から選んで `tbd_answers` に決定として書き、
     `decisions` に D-ID で足して、**決定した事実と選んだ内容をゲートで報告する**
     （承認待ちにはしない。異議が出たらその周回の回答として上書きする）。
     スキルが固定している前提（`references/fixed-premises.md` が正）に関わる TBD は、
     質問にも決定にもせず、そのファイルの内容で解消する。
     依頼者への質問は「依頼者の運用・意図・リスク許容にしか答えが無いもの」だけに絞る。
     質問 0 件が目標値である — 自分の分類を信用せず、question-policy.md の手順で機械的に落とす。
   - **件数から自分で判定しない。** 判定式は script に 1 つだけ置く（`gate2_skippable`）。
     件数で再判定すると、executability が全滅した run で「聞くことが無い」に化ける。
   - **着手不能なものを先頭に**して提示し、`AskUserQuestion` で選択肢を添える（自由記述だけに
     しない。答えやすさが回答率を決める）。選択肢の材料は `tbd_items[].candidates`。**候補を
     文書本文に「提案します。決めてください」と書かせない** — 文書の読み手は後続の AI であり、
     依頼者宛ての対話文を成果物に混ぜない。候補の選択肢化は司令塔の仕事である。
   - 1 回にまとめて提示し、**初回のゲートで全 blocking を提示し切る**（持ち越しは無い —
     持ち越しは「周回があるから初回で聞き切らない」誘因になり、原則 1 周の設計と矛盾する）。
     件数が多いときは**同じ決定で複数が解消するものを 1 つの問いにまとめる**
     （「英語出力時の助動詞規約」「曖昧語リスト」「規律ファイルの置き方」は 1 問にできる）。
   - まとめてなお 20 件を超えるなら、それは提示の工夫ではなく**起票側の較正失敗**である。
     Workflow の返り値を JSON に保存して
     `python3 [SKILL_DIR]/scripts/check_blocking_rate.py <返り値.json>` で計測できる
     （blocking が提示容量 40 件を超えると exit 1）。超えていたら、聞き方を工夫する前に
     `references/traceability.md` §4 の基準で blocking を落とせる項目がないかを見る。
   - 「分からない」「後で決める」と答えられた項目は blocking のまま残すが、**提示済みとして
     記録する**（以後は未提示扱いにしない）。回答されなかった項目を推測で埋めない。
   - 提示した TBD の `{ id, digest }` を `presented_tbd_ids` に積む（前周までの分と合算する）。digest は `blocking_tbd_items[]` に script が計算済みの値を転記する。
2. **初稿を workspace に書き出す。** `documents[]` の `markdown` を 1 文書ずつ
   `~/.claude/prd-spec-workspace/<案件>/drafts/r<outer_round>/<kind>-<topic>.md` に Write し、
   各文書の `draft_path` にそのパスを入れ、**args の `documents` からは `markdown` を落とす**。
   全文を args で中継すると 12 文書で 24 万文字を超えることがあり、司令塔が本文を書き写す
   経路そのものが劣化点になる。writer agent は `draft_path` を Read して本文を得る
   （`review` / `expand` で既存文書を改稿する周回は `path` がそのまま下敷きになるので、
   この書き出しは不要）。保存先は workspace であり、対象リポジトリには書かない。
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
    documents: <直前の documents（markdown を落とし draft_path を入れたもの）>,
    tbd_items: <直前の tbd_items をそのまま>,
    presented_tbd_ids: [{ id: "TBD-001", digest: "<blocking_tbd_items[].digest を転記>" }, ...],
    outer_round: 1,
    domain_findings: [...], required_categories: [...],
    draft_structural_findings: <Workflow A の structural_findings をそのまま>,
    self_containment: "<手順 4 で合意した参照方針。無い案件では空文字>",
    paths: { requirements: "docs/requirements", specifications: "docs/specifications" },
    today: "<date +%Y-%m-%d>"
    // audit_rounds は通常渡さない（渡すのは途中死からの復旧時だけ。下記の節を参照）
  }
})
```

| args | 意味 |
|---|---|
| `documents` | 直前の返り値の `documents` から `markdown` を落とし、`draft_path`（手順 2 の書き出し先）を入れたもの。本文もパスも無い文書があると script が入口で落ちる（改稿が新規執筆に化けるのを防ぐ） |
| `tbd_answers` | **今周回の**統合ゲートの回答。**空なら script は反映パスを飛ばす**（直す理由が無いまま全文書を書き直させない） |
| `tbd_answers_history` | 過去周回の統合ゲート回答の累積。1 周目は `[]`。**2 周目は `next_args` が埋めるので手で作らない**（原本が欠けると過去回答由来の要求が fabrication の偽陽性になる） |
| `presented_tbd_ids` | これまでに提示済みの TBD。`unpresented_blocking` の唯一の入力。`{ id, digest }` の形（`digest` は script が計算済みの値。生 text を入れると全件が「未提示」に化ける）。1 周目は初回ゲートで提示した分を `blocking_tbd_items[].digest` から転記して積む。**2 周目は `next_args` が埋めるので手で作らない** |
| `outer_round` | 外側ループの周回（1 or 2）。`R<outer>.<rev>` は `revision_log`（返り値のメタ情報）だけで使い、**生成文書には書かない**。**カウンタは 2 つある**ことを取り違えない |
| `paths` | 保存先ディレクトリ。**Workflow A に渡したものと同じ値**を渡す |
| `draft_structural_findings` | Workflow A の `structural_findings`。渡さないと A の検査結果が誰にも読まれない |

Workflow B は 8 観点の監査を並列で発行する（欠測分の部分リトライを含む）。**観点ごとの対象範囲と並列の形は
`scripts/refine.js` の `AUDITORS` が唯一の正**（ここに内訳を書くと二重管理になり必ずズレる）。
返り値の `summary` が観点ごとの件数（未検査は `null`）を返すので、読む側に内訳の知識は要らない。
specimen（標本適用監査）だけはコスト抑制のため初回監査と終端の網羅監査のみ参加し、標本文書が
1 件も無いランでは skip される（欠測ではなく `specimen_skipped: true` として返る。標本は
`specimen_paths` で渡せる。省略時は fixed 文書を標本として使う）。標本は自己出自（当該ランと
同一 workspace の文書）以外を最低 1 件含めることを推奨する。自己出自のみでも skip はされないが、
書き方の違う文書での偽陽性を見逃すため、返り値 `specimen_self_only: true` で申告される。

改稿ループの停止は**乾き判定**が主で、固定回数ではない。script が各監査ラウンドの novelty
（前ラウンドまでに無い新規指摘の件数）を算出し、novelty 0 のラウンドが出たら改稿予算が残って
いても終端へ進む（返り値 `dry_stop: true` / `novelty_history`）。同一 digest のまま 2 回連続で
残った指摘は stuck として通常改稿から外れる。回数は backstop（`REVISION_BACKSTOP`）だけ残り、
到達すると verdict に `revision_backstop_reached` が立つ。改稿前には専任の ladder-judge が
指摘を failure kind で 4 分類し（スコープの梯子。判定表は `schemas/agent-contracts.md`
§ladder-judge が正）、`artifact` / `criteria` だけを writer に流す。`premise` / `question` は
改稿予算を消費させず blocking TBD（`TBD-NI-`）として起票され、返り値の `needs_input` に
集まる（統合ゲートの提示対象に入る）。ループ後の終端処理:

1. blocking が残っていれば**矛盾解消専用の追加改稿を 1 回きり**行い、validity / executability の
   2 観点だけで再確認する（従来どおり。追加はループしない）。
2. stuck が残っていれば**多角化 escalation をバッチで 1 回だけ**行う（3 レンズ並列の解消案 →
   writer 最終改稿 → スコープ再監査）。それでも digest 不変の指摘は `unanswerable` として返り、
   verdict は `unanswerable_findings` になる（`unresolved_findings` と区別される）。
3. 指摘起因の改稿後の再監査は当該範囲に限定されるため、収束後に**終端の網羅監査を全観点で
   1 回だけ**行う。新規 blocking は TBD 起票経路へ、新規 non-blocking は終端裁定へ渡る。
4. **終端裁定（adjudication）**: 残った全指摘を裁定 agent が三値（fixed / rejected /
   documented）に分類し、documented 分は writer の転記改稿 1 回で文書に反映される。
   `adjudication.unadjudicated` が空であることを script が検証し、空でなければ verdict が
   `adjudication_incomplete` になる。**未裁定 limbo（unresolved[] に載って終わるだけ）を残さない。**

外側ループの契約は変わらない（`outer_round` は最大 2 周、blocking TBD は統合ゲート経路）。

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

2 周目の Workflow 呼び出しは**返り値の `next_args` を使う**。統合ゲートの回答で `tbd_answers` の
`"<<ANSWER_HERE>>"` を置換し、それ以外は書き換えずにそのまま Workflow B に渡す。
**args の手組み（documents / tbd_items / tbd_answers_history / presented_tbd_ids /
outer_round の転記）はしない** — 30〜70KB の転記は写し間違いの温床であり、script が完全形を
組み立て済みである（本文は writer が `draft_path` へ Write 済みなので args は痩せている）。
`next_args` は needs_input または未提示 blocking が残った終了時にだけ返る（周回上限では `null`）。

## 6. 結果を提示して保存する（保存承認＝人間ゲート②）

> **ここで必ず止まる。保存は「承認」の語句を受け取ってから行う。**

1. **監査結果サマリを提示する。指摘 0 件でも「0 件だった」と明示する**（黙って省略すると、
   検査していないのか合格したのか読み手に区別できない）。`summary` の値が `null` の項目は
   「0 件」ではなく**「検査されていない」**として伝える。
2. `verdict` が `clean` 以外なら理由を先に述べる。`audit_incomplete` なら**どの auditor が
   応答しなかったかを名指しで**伝え、「失格 0 件」と読み替えない。`writer_missing` が空で
   なければ、それは「改稿したが直らなかった」ではなく**「一度も直されていない」**である。
3. **blocking TBD の残数で提示文を変える**（[完成の定義](#完成条件はblocking-0-件ではない)）。
   周回上限で `unpresented_blocking` が残ったなら、「提示できていない項目が N 件ある」と明示する。
4. **保存承認の前に、絶対品質採点を必ず実施する。** fresh context の検査 agent に
   `references/quality-checklist.md` の 13 項目を四値（pass / fail / not-applicable /
   not-checked）で採点させ、その結果を監査サマリと並べて提示する。これは司令塔の任意行動では
   なく手順である — 採点を省いた保存承認の提示は不完全であり、行ってはならない。
5. 文書一覧と本文を提示し、保存の可否を尋ねる。**「承認」の意思表示を受け取るまでファイルを
   書かない。**
   - **司令塔は生成文書を手編集しない。** 採点や監査で指摘が出ても、修正は改稿経路
     （writer + 監査、Workflow B の再実行または `review` モード）を通す。通さないなら
     指摘を残したまま保存し、残っている事実を明示する。手編集は Generator と Verifier の
     分離を最後の工程で破り、誰にも検査されていない版が成果物になる。
6. 承認後に保存する。
   - 各文書 → `documents[].path`
   - INDEX → `index_paths.requirements` / `index_paths.specifications` に `index.requirements` /
     `index.specifications` の内容をそのまま書き出す。**INDEX は導出物であり、手書きしない**
     （手書きの目次は必ず本体と drift する）。`index` にその kind のキーが無いランでは、
     その INDEX は**再生成しない**（既存のものを残す。対象外の文書だけから作った不完全な
     目次で上書きしないため）。
   - **途中成果物（初稿・各版・監査結果）を残したい場合は `~/.claude/prd-spec-workspace/<案件>/`
     を使う。** 対象リポジトリの中に作業ファイルを置かない — そのリポジトリの `.gitignore` は
     利用者の持ち物であり、こちらが管理してよいものではない。
   - **新規保存で同名ファイルが既存だった場合**（衝突）: 上書きしない。差分を提示して承認を求める。
   - **`review` / `expand` モードで意図的に既存文書を改訂する場合**（衝突ではない）: 止めない。
     旧内容との差分と変更理由を**ユーザーへ提示したうえで**上書きする。この 2 つを混同すると、
     意図した改訂が「衝突」として止まるか、意図しない上書きが無警告で通る。
7. **生成文書に変更履歴の章は置かない**（正: `references/document-structure.md` §4。承認の
   記録欄を置く条件もそこが正）。承認欄を置いた案件では、**このスキルは承認者の実在も承認の
   事実も確認できない**ため、記入されるのは「ユーザーがそう申告した文字列」に過ぎない旨を
   保存時に 1 文で伝える。

## 入出力の定義

**入力**: 自然言語の依頼（日本語）。既存文書 / 議事録 / Slack ログ / 手書きメモの貼り付けを含みうる。

**出力**: 承認後に保存する。固定 2 ファイルではない。

| 出力 | パス | 備考 |
|---|---|---|
| 要求文書 | `docs/requirements/<topic>.md`（1 つ以上） | 常設章は `references/document-structure.md` を正とする |
| 要求 INDEX | `docs/requirements/INDEX.md` | 導出物。script の返り値から書き出す |
| 仕様書 | `docs/specifications/<topic>.md`（1 つ以上） | トレーサビリティ表は**自分がカバーする要求の分だけ**を持つ |
| 仕様 INDEX | `docs/specifications/INDEX.md` | 導出物。純粋な目次（逆参照は各仕様書の表にあるので置かない） |
| 監査結果サマリ | （ファイルにしない） | 手順 7 で提示する |

## 入出力の例

通しの例（依頼文 → 統合ゲートでの確認 → 生成される文書）は
`[SKILL_DIR]/references/io-example.md` にある。

## 異常系・準正常系・正常系エッジ

| 状態 | イベント | 種別 | 対応 |
|---|---|---|---|
| 入力受領 | 依頼が 1 行のみ | 正常系エッジ | intake が初稿に要る分だけ質問。分析観点はほぼ `不明`。推測で埋めない |
| 入力受領 | 曖昧語を含む依頼 | 準正常系 | 曖昧語を指摘し、測定可能な形の候補を 2〜3 提示 |
| 入力受領 | 小規模・低リスクな案件 | 正常系 | 共通規律は下げない。分割数が 1 になるだけ |
| 入力受領 | 既存コードの挙動説明の依頼 | 対象外 | 発動しない。1 文で伝えて終了 |
| 入力受領 | 空入力 / 語だけ | 異常系 | 手順 1 の案内文を返して終了 |
| 分析後 | 全観点が `不明` | 準正常系 | 「判定できなかった」と正直に提示し質問に回す。業界知識で埋めない |
| 分析後 | ユーザーが分割案を否定 | 正常系 | 指示された分割で執筆する。提案を押し通さない |
| 初稿後 | blocking TBD も実行可能性の blocking 指摘も 0 件 | 正常系 | **統合ゲートは報告のみで質問では止まらない。**聞くことが無いのに聞かない |
| 初稿後 | blocking が 20 件超 | 準正常系 | blocking に絞って提示する。全部聞くと答えきれず、結局どれも決まらない |
| 統合ゲート | ユーザーが「分からない」と回答 | 準正常系 | blocking のまま残すが **presented として記録する**。手順 6 で名指しして提示。推測で埋めない |
| ループ中 | 新規 blocking が判明 | 正常系 | `unpresented_blocking` として返る（`first_seen_round` 付き）。周回 1 なら統合ゲートへ戻る |
| ループ中 | 周回上限でも未提示の blocking が残る | 準正常系 | **黙って完了しない。**「提示できていない項目が N 件ある」と明示して手順 7 へ |
| ループ中 | 監査が失格 0 件だが blocking TBD が残る | 正常系 | **「完成しました」と提示しない。**「あと N 個決まれば着手できます」と伝える |
| 実行中 | agent が応答しない（一部） | 異常系 | script が落ちた分だけを 1 回出し直す。それでも返らなければ欠測として報告される |
| 実行中 | 出した agent が全件応答しない | 異常系 | script は再実行しない（セッション上限・レート制限を疑う）。**上限の解除後に resume する** |
| ループ中 | auditor が応答しない | 異常系 | 「失格 0 件」と読まない。`missing_auditors` を名指しで提示（出し直し後もなお返らなかったもの） |
| ループ中 | writer が応答しない | 異常系 | 前稿を維持する（空で上書きしない）。「直したが直らなかった」ではなく**「一度も直されていない」**として提示 |
| 保存前 | 同名ファイルが既存（新規保存） | 準正常系 | 上書きしない。差分を提示して承認を求める |
| 保存前 | `review` / `expand` の意図的な改訂 | 正常系 | 止めない。旧内容との差分と変更理由をユーザーへ提示して上書きする |
| 保存前 | 分割数が実行のたびに変わる | 準正常系 | 分割案は人間が承認したものを使う。承認と違う構成で保存しない |
| 保存前 | INDEX だけが既存で本体が無い（またはその逆） | 準正常系 | 齟齬として報告する。INDEX は導出物なので本体に合わせて再生成する |

## 注意事項

- **規格・規制への言及は既定で行わない。多くの案件では規格に一切言及しない文書が正解である。**
  言及するのは、ユーザーが明示的に求めた場合か、分析で対象だと**入力から確認できた**場合に限る。
  条番号を書いてよい 7 系統の典拠と、書いてはならない規格・廃止済み規制の語は
  `references/citation-policy.md` を正とする（後者は script の完全一致検査でも押さえる）。
- **監査指摘の語り口**は責める調子にしない。「この要求はこのままだとテスト設計できません」という
  事実の指摘として書く。
- **未解決の記録は本文側に残る。** 残った TBD は INDEX の「未解決」節に載る。会話ログにしか
  無い状態にしない。**改稿の経緯は成果物に残さない**（`references/document-structure.md` §4）。
- **助動詞規約・曖昧語リスト・ID 体系・常設章・分割の指針**の詳細は SKILL.md に置かない。
  下表の参照ファイルが唯一の正であり、ここに写しを持つと必ず drift する。

## 参照ファイル構成

**この表は「どのファイルが何の正か」を宣言する。** 各 agent のモデル割当は scripts 側の spawn 指定（`refine.js` の `AUDITORS` と `draft.js`/事前分析の呼び出し）が唯一の正であり、この表には書かない（書くと必ず drift する）。 同じ概念を 2 ファイルで定義すると、
両方を読む agent が矛盾を自分で裁くことになる。二重定義は
`tests/test_no_duplicate_definitions.py` が機械で検出する
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
| `[SKILL_DIR]/agents/fabrication-auditor.md` | 根拠不明の断定の検出 |
| `[SKILL_DIR]/agents/consistency-auditor.md` | 文書間の重複・矛盾・INDEX との齟齬の検査 |
| `[SKILL_DIR]/agents/validity-auditor.md` | 内容の妥当性（要求の筋・相互矛盾・欠落・宣言漏れ）の検査 |
| `[SKILL_DIR]/agents/specimen-auditor.md` | 標本適用監査。各項目を実在の標本文書に適用し、判定不能・適用時矛盾を検出（初回と終端のみ） |
| `[SKILL_DIR]/references/requirement-writing-rules.md` | 助動詞規約・曖昧語リスト・単一要求・書き換え例 |
| `[SKILL_DIR]/references/prd-and-spec.md` | **正**: 2 文書の目的と切り分け・**目的側の必須内容項目**・手段側の上限（設計解を書かない）・分量の決まり方・典拠の強度 |
| `[SKILL_DIR]/references/document-structure.md` | **正**: 章立て（どの内容をどの章に置くか）・表と図の使い分け・状態遷移図と状態 × イベント表・変更履歴を書かない規律。**何が必須の内容かは `prd-and-spec.md` §4** |
| `[SKILL_DIR]/references/traceability.md` | **正**: **ID の形式**・トレーサビリティ表・TBD の `blocking` / `presented` |
| `[SKILL_DIR]/references/io-example.md` | 依頼文から生成文書までの通しの例 |
| `[SKILL_DIR]/references/document-splitting.md` | **正**: 何を作るかの判定・分割の軸・topic 命名と領域コードの対応・2 つの INDEX の構成（非対称である理由を含む）。**ID の形式は `traceability.md` §1** |
| `[SKILL_DIR]/references/domain-analysis.md` | 分析観点・三値判定・導出例・押しつけ禁止 |
| `[SKILL_DIR]/references/citation-policy.md` | 規格言及の要否判断・引用可能な典拠・禁止語 |
| `[SKILL_DIR]/references/fixed-premises.md` | **正**: スキルが固定する前提の一覧（案件ごとに問い直さない）。intake の質問抑制・writer の出所表記 `（スキル既定: 前提 N）`・fabrication-auditor の受理条件・司令塔の TBD 解消がここを見る |
| `[SKILL_DIR]/references/question-policy.md` | **正**: 聞くか既定かの判定手順・決定ログ（decisions）の書式と受理条件・既定にしてはならないもの。intake / 司令塔 / fabrication-auditor がここを見る |
| `[SKILL_DIR]/references/quality-checklist.md` | 生成物の絶対品質チェックリスト（外部規範由来・出典付き）。完成品の評価に使う索引で、各項目の定義の正は既存 references にある |
| `[SKILL_DIR]/schemas/agent-contracts.md` | agent 間の入出力契約（TBD の全フィールドを含む） |
| `[SKILL_DIR]/scripts/draft.js` | Workflow A（初稿 + 実行可能性検査 + 構造検査） |
| `[SKILL_DIR]/scripts/refine.js` | Workflow B（改稿 + 7 観点監査ループ + INDEX 組み立て + `unpresented_blocking`） |
| `[SKILL_DIR]/scripts/check_blocking_rate.py` | blocking TBD の件数を提示容量（20 件/周 × 2 周）と照合する回帰ゲート。欠測は exit 2 で「未計測」として返す |
| `[SKILL_DIR]/tests/` | 回帰テスト群（構造検査・重複定義・カテゴリ整合・TBD 名前空間・blocking 容量ほか）。`python3 -m unittest discover [SKILL_DIR]/tests` で全実行する |
| `[SKILL_DIR]/evals/evals.json` | テストケース |
| `[SKILL_DIR]/evals/trigger-evals.json` | description の発火評価（should_trigger 10 / should_not_trigger 10。`run_loop.py --eval-set` で使う） |
