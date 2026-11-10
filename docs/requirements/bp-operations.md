# 要求文書: best-practices の 4 機能（create・review・update・audit）

## 表記規約

本文書と [bp-designed-skill.md](bp-designed-skill.md) は、必須を「〜しなければならない」、推奨を「〜することが望ましい」、許容を「〜してもよい」、禁止を「〜してはならない」と書く（JIS Z 8301 の助動詞対応）。

## 用語

| 用語 | 意味 |
|---|---|
| best-practices | 本文書の要求を満たす作成・評価・修正・監査の機能を提供する主体 |
| 利用者 | これらの機能を依頼する人間 |
| 設計方針文書 | [skill-design-patterns.md](../design/skill-design-patterns.md)。形・部品・役割などの上位の設計制約の正本 |
| 対象スキル | create が作るスキル、または review・update・audit が扱う既存のスキル。スキルのディレクトリと、それが呼ぶ自分の plugin の workflow script |
| 修正の根拠 | update に渡す review・audit の指摘、または利用者の修正指示 |
| best-practices の仕様書 | 本文書と bp-designed-skill を実現する、外から観測できる振る舞いと課された設計制約を定める `docs/specifications/bp-*.md` |
| 現行の prompt-audit | `plugins/skill-creator/skills/skill-creator-best-practices/references/prompt-audit.md` にある監査の観点 |
| fan-out | 1 つの段で、項目（ファイル・観点・意図）ごとに agent を起動して処理すること |
| 指摘 | 対象スキルのどの資産がどの基準に反するかを、位置・根拠・内容・直し方とともに示すもの。反証前を「指摘の候補」と呼び、反証後の状態は各機能の要求に従う |
| run | 処理を開始して完了または停止するまでの 1 回の実行。Workflow の場合は 1 回の Workflow 実行。再開は新しい run で行う |
| context | agent が 1 回の実行で持つ入力と作業の内容。「生成と別の context」は生成した agent の context を持たない別の agent |
| 設計の説明 | 形を選んだ条件や AI の自由な判断の所在など、対象スキルに残す設計の記述 |
| 作業記録 | run の担当が、作業・結果・根拠を後から辿れるように残す記録 |
| 記録台帳 | 作業記録と証拠への参照。資産と指摘の対応を持つ資産台帳とは異なる |
| 文書の一般規約 | [documentation.md](../guidelines/documentation.md)。作業記録を含む文書の書き方の正本 |

資産・カバレッジ・skip 一覧、形・探索グラフ型、needs_input・BLOCKED は設計方針文書の定義に従う。

## 背景と課題

利用者は、同じ設計方針の上でスキルを作り、既存スキルを評価・監査し、根拠のある修正を反映したい。best-practices は、その 4 機能と機能間の受け渡しを提供する。作るスキルが備える性質は bp-designed-skill が定める。

## 想定する利用者と利用場面

- スキルを作る人は、目的を依頼し、create でスキルと検証結果を得る。
- スキルを評価する人は、review・audit で指摘と確認範囲を得る。
- スキルを直す人は、指摘または修正指示を update に渡し、修正結果と既存の振る舞いを確認する。

## どう使われるか

単独の機能を依頼する場合と、複数の機能を順に依頼する場合がある。create・update は目標を固定して作成と独立検証を行う。review はフローと仕様、audit は現行の prompt-audit の観点で評価し、指摘・確認範囲・未検査を返す。利用者は結果をそのまま update の根拠にでき、停止した場合は保存された作業と報告を使って続行を判断する。

## スコープとスコープ外

対象は create・review・update・audit の能力、入力と成果、停止・再開、確認範囲と機能間の受け渡しである。現行実装からの移行、marketplace への登録・公開は含めない。best-practices 自身の形と内部の実現方法は設計の責務とし、仕様書には外部契約と上位から課された制約だけを定める。

## 前提と依存

- 設計方針文書と bp-designed-skill を 4 機能の共通基準とする。暫定の規則・値を確定する場合、仕様と検証に反映する。
- audit は現行の prompt-audit を監査基準として参照する。その基準を使えない場合の扱いも要求に含める。
- CLI の内部操作名、保存形式、内部 worker の細かな段取りは、上位指定が無ければ要求に含めない。

## リスクと影響

| ID | 観点 | 判定 | 根拠 |
|---|---|---|---|
| RK-001 | 不可逆な操作 | 該当 | create・update は対象のファイルへ書き込み、update は全体を作り直してよい。途中で止まった成果を戻すかは利用者が決めるため、書き換え範囲と停止時の保持・報告が必要である（PR-BPOPERATIONS-018・037・040） |

## 要求一覧

### 機能と連鎖

#### PR-BPOPERATIONS-001 4 機能の選択
best-practices は create・review・update・audit を提供し、利用者の依頼に該当する機能を実行できなければならない。どの機能にも当たらない依頼では、機能を実行せず該当が無いことを返さなければならない。

#### PR-BPOPERATIONS-038 複数機能の実行と受け渡し
複数機能を求められた場合、best-practices は、依頼で指定された順を尊重し、未指定なら入出力の依存関係で順を決め、決められない場合または指定順が依存関係と矛盾する場合は利用者に確認しなければならない（依頼者の裁定）。前の結果を次に渡して順に実行し、必須入力の代わりに不十分な結果を渡してはならない。途中の機能が完了せず止まった場合、後続を実行せず、その停止報告を連鎖全体の報告としなければならない。

#### PR-BPOPERATIONS-051 実行記録の保持
best-practices は、4 機能の各 run に bp-designed-skill の記録・証拠・記録台帳・保持・保存失敗の要求を適用しなければならない。自らの判断も生成するスキルと同様に検証できるようにするためである。

#### PR-BPOPERATIONS-052 回答待ちの判断材料
needs_input で止まる場合、best-practices は、理由・決めること・ここまでの検証結果・影響範囲・残る作業を返し、まだ無い材料も欄を省かず無いと示さなければならない。入力確認で目標固定前に止まる場合は検証結果と残る作業が無いと示し、目標固定で止まる場合は残る作業と、それまでに得た検証結果を示さなければならない。

### 作成と修正

#### PR-BPOPERATIONS-003 依頼に基づく目標
create は、書く前に、依頼と回答から bp-designed-skill の目標固定の原則に沿って目標を定めなければならない。依頼に無い目標・制約を加えてはならない。update では、対象スキルから読み取った目的と修正の根拠を出発点に同じ原則を適用しなければならない。

#### PR-BPOPERATIONS-005 入力不足での停止
create・update は、目標を定める人間の承認・回答が足りない場合、needs_input と判断材料を返して止まらなければならない。Workflow の run の中で入力を待ち続けてはならない。

#### PR-BPOPERATIONS-008 設計方針に沿う成果
create・update は、bp-designed-skill の要求を満たすスキルを提供しなければならない。1 体の agent の 1 回の実行で解ける課題を探索グラフ型にしてはならない。

#### PR-BPOPERATIONS-037 書き換えてよい範囲
create・update は、run の作業記録・証拠・記録台帳を除き、対象スキルの外を書き換えてはならない。依頼の対象外へ変更を広げないためである。

#### PR-BPOPERATIONS-009 生成と独立した検証
create・update は、書いた agent と別の context で成果を検証しなければならない。生成者の説明や自己評価を合格の根拠にしてはならない。

#### PR-BPOPERATIONS-010 検証に基づく完了
create・update は、必要な検証を通るまで成果を完了と報告してはならない。検証を通らず止まる場合、未達であることと理由を返さなければならない。

#### PR-BPOPERATIONS-011 検証後の書き直し
create・update は、形式検証以外の検証を通らない場合、書き直して独立に再検証してもよい。形式検証を実行できないか性質が成り立たない場合は bp-designed-skill の形式検証失敗の要求に従い、同じ run の書き直しで続けてはならない。

#### PR-BPOPERATIONS-013 続行できない失敗
4 機能は、続行できない失敗で BLOCKED と理由を返して止まり、止まった段を報告しなければならない。review・audit は、失敗に限らず、完了前に止まる全ての場合で止まった段と理由を報告しなければならない。原因と続ける場所を利用者が判断できるようにするためである。

#### PR-BPOPERATIONS-014 作成・修正の成果と検証結果
create・update は、完了時に作成または修正したスキル、設計の説明、検証結果を返さなければならない。検証結果には、指摘の状態、skip 一覧、残る危険を含め、利用者が完了の根拠と限界を確認できなければならない。

#### PR-BPOPERATIONS-015 修正の根拠の受け取り
update は、対象スキルの全体と 1 件以上の修正の根拠を受け取り、その根拠を目標の出発点にしなければならない。修正の根拠の件数に上限を置いてはならず、渡された根拠を件数にかかわらず全件受け取らなければならない。件数を理由に受け取りを拒否または切り詰めてはならない。

#### PR-BPOPERATIONS-018 全体の作り直し
update は、修正の根拠が触れない部分を含め、対象スキル全体を作り直してもよい。作り直す場合も目標・範囲・独立検証と完了の要求を満たさなければならない。

#### PR-BPOPERATIONS-019 既存の振る舞いの確認
update は、修正の根拠が触れない既存の振る舞いを保てたかを、作り直した後の検証結果だけから判定しなければならない。検証が触れていない振る舞いを保持済みとせず、判定できなかった範囲を示さなければならない。

#### PR-BPOPERATIONS-021 同じ run の指摘の追跡
create・update は、書き換えた後に同じ run で付けた指摘が直ったか再発したかを追い、その状態を結果に示さなければならない。追跡には設計方針文書「資産台帳」の原則を適用しなければならない。

#### PR-BPOPERATIONS-022 run をまたぐ追跡の保持規則
run をまたぐ指摘の追跡の裁定が下るまで、update は、入力に受け取った前の run の指摘を resolved・regressed と報告してはならない。報告する状態は今の run の中で付けた状態だけとしなければならない。前の run の指摘は修正の根拠として受け取ってよいが、状態の追跡を今の run に引き継いだと扱ってはならない。

#### PR-BPOPERATIONS-040 途中の成果の保持と報告
create・update は、完了前に止まった場合、それまでに書いたファイルを残し、検証済み・未検証の範囲、停止した段と理由を報告しなければならない。戻すかどうかは利用者が決める。

### 評価と監査

#### PR-BPOPERATIONS-024 フローの評価
review は、bp-designed-skill の要求に照らし、対象スキルのフローが適切かを評価しなければならない。作成と評価で異なる基準を適用しないためである。

#### PR-BPOPERATIONS-025 仕様からの逸脱の評価
review は、対象スキルを BP 仕様が課す確定値と規則に照らして評価しなければならない。役ごとのモデル・effort は bp-designed-skill の例外に従わなければならない。対応する仕様が無い観点・範囲は未検査とし、一部の仕様があることを全範囲の検査済みとしてはならない。

#### PR-BPOPERATIONS-028 監査基準と証拠の継承
audit は、既存スキルを現行の prompt-audit の観点で監査し、流れは設計方針文書の「形の判定」「資産台帳」「証拠記録の保存と照会」に沿わせ、証拠を保存して後の run から照会できるようにしなければならない。同文書の未決事項はこの要求で裁定しない。現行の prompt-audit が無い場合、監査を実行せず止まり、監査結果の代わりに止まった段と、継承する基準が無いという理由を報告しなければならない。

#### PR-BPOPERATIONS-030 対象を変更しない評価
review・audit は、対象スキルを書き換えてはならない。修正は update が行う。

#### PR-BPOPERATIONS-031 指摘の独立した反証
review・audit は、候補を生成と別の context で反証してから結果に含めなければならない。却下した指摘も理由とともに含めなければならない。ただし、review の PR-BPDESIGNEDSKILL-051 の機械照合だけで決まる指摘は、反証を通さず含めなければならない（依頼者の裁定）。

#### PR-BPOPERATIONS-032 評価・監査での指摘の状態
review・audit は、指摘の状態を open または dismissed として返さなければならない。対象を変更しない run で resolved・regressed を確定してはならない。

#### PR-BPOPERATIONS-033 確認範囲と未確認の区別
review・audit は、指摘と「確認済みで問題なし」を資産に結び付け、カバレッジと skip 一覧、未検査の観点を結果に示さなければならない。結果が結び付かない資産を「問題なし」としてはならない。

#### PR-BPOPERATIONS-036 修正へ渡せる結果
review・audit は、指摘を update の修正の根拠として受け取れる形で返さなければならない。機能間の受け渡しで、内容・根拠・判断の状態を失ってはならない。

## ID の扱い

欠番: PR-BPOPERATIONS-002・PR-BPOPERATIONS-004・PR-BPOPERATIONS-006・PR-BPOPERATIONS-007・PR-BPOPERATIONS-012・PR-BPOPERATIONS-016・PR-BPOPERATIONS-017・PR-BPOPERATIONS-020・PR-BPOPERATIONS-023・PR-BPOPERATIONS-026・PR-BPOPERATIONS-027・PR-BPOPERATIONS-029・PR-BPOPERATIONS-034・PR-BPOPERATIONS-035・PR-BPOPERATIONS-039・PR-BPOPERATIONS-041・PR-BPOPERATIONS-042・PR-BPOPERATIONS-043・PR-BPOPERATIONS-044・PR-BPOPERATIONS-045・PR-BPOPERATIONS-046・PR-BPOPERATIONS-047・PR-BPOPERATIONS-048・PR-BPOPERATIONS-049・PR-BPOPERATIONS-050。統合前の番号を新しい能力へ再利用してはならない。
