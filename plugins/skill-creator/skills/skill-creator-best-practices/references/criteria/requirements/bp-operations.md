# 要求文書: best-practices の 4 機能（create・review・update・audit）

## 表記規約

本文書と `docs/requirements/bp-designed-skill.md` の要求文は次の語尾で区分する（JIS Z 8301 が定める助動詞対応に従う）。

| 区分 | 語尾 | 対応する英語 |
|---|---|---|
| 必須 | 〜しなければならない | shall / MUST |
| 推奨 | 〜することが望ましい | should / SHOULD |
| 許容 | 〜してもよい | may / MAY |
| 禁止 | 〜してはならない | shall not / MUST NOT |

本文書では、本文書の要求を満たす処理を行う主体を「best-practices」と呼び、best-practices に作成・評価・修正・監査を頼む人間を「利用者」と呼ぶ。

## 用語

| 用語 | 意味 |
|---|---|
| 設計方針文書 | `docs/design/skill-design-patterns.md`。スキルを multi-agent の Workflow として設計するときの方針 |
| 対象スキル | create が作るスキル、または review・update・audit が扱う既存のスキル。スキルのディレクトリと、そのスキルが呼ぶ自分の plugin の workflow script からなる |
| 修正の根拠 | update に渡す、review の指摘・audit の指摘・利用者の修正の指示 |
| best-practices の仕様書 | 本文書と `docs/requirements/bp-designed-skill.md` を実現する手段を定める仕様書（`docs/specifications/bp-*.md`） |
| 現行の prompt-audit | 現行の best-practices スキルが持つ監査の観点の基準（`plugins/skill-creator/skills/skill-creator-best-practices/references/prompt-audit.md`） |
| 資産・指摘・カバレッジ・skip 一覧 | 設計方針文書の「資産台帳」の節が定める意味で使う |
| 形・探索グラフ型 | 設計方針文書の「用語」の節が定める意味で使う（選び方は同文書の「形の判定」の節） |
| needs_input・BLOCKED | 設計方針文書の「用語」の節が定める停止の種類。needs_input は人間の入力を待って止まったこと、BLOCKED は失敗して続けられずに止まったことを指す |
| run | Workflow の 1 回の実行。止まった run から続けるときは、新しい run を起動する（設計方針文書の「停止・再開と人間の入力」の節） |
| context | agent が 1 回の実行の中で持つ入力と作業の内容。「生成と別の context」は、生成した agent の context を持たない別の agent を指す |
| fan-out | 1 つの段で、項目（ファイル・観点・意図など）ごとに agent を起動して処理すること |
| 設計の説明 | 対象スキルに書き残す、形を選んだ条件などの設計の記述（設計方針文書の「形の判定」の節が「スキルの設計の説明」と呼ぶもの） |

## 背景と課題

依頼者は、スキルを multi-agent の Workflow として設計する方針を設計方針文書にまとめた。best-practices はこの方針に沿ってスキルを作り直す土台であり、スキルの作成（create）・評価（review）・修正（update）・監査（audit）の 4 機能を、同じ方針の上で提供する必要がある。作られたスキルが備える性質は `docs/requirements/bp-designed-skill.md` が定め、本文書は 4 機能の振る舞い（入力・停止・出力・機能間の受け渡し）を定める。

## 想定する利用者と利用場面

| 利用者 | 利用場面 |
|---|---|
| スキルを作る人 | 作りたいスキルの依頼文を渡し、create で設計方針文書に沿ったスキルを得る |
| スキルを評価・監査する人 | 既存のスキルを review または audit にかけ、指摘とどこまで見たかを得る |
| スキルを直す人 | review・audit の指摘や自分の修正の指示を update に渡し、直したスキルを得る |

## どう使われるか

1. 利用者が依頼し、best-practices が当たる機能に振り分ける（複数の機能にまたがる依頼は、機能を順に実行する）。
2. create は依頼文から目標を固定し、対象スキルに形の判定を当て、スキルを書き、生成と別の context で検証して返す。
3. review は対象スキルを「フローが適切か」と「仕様から逸れていないか」の 2 観点で評価し、指摘・カバレッジ・skip 一覧・未検査の観点を返す。
4. audit は現行の prompt-audit の観点で対象スキルを監査し、review と同じ形の結果を返す。
5. 利用者は review・audit の指摘（または自分の指示）を update に渡す。update は create と同じ処理で対象スキルを作り直し、検証の結果を返す。

## スコープとスコープ外

スコープ: create・review・update・audit の 4 機能の振る舞いと、機能間の受け渡し。

スコープ外:
- 現行の best-practices の実装の読解と、そこからの移行（現行の prompt-audit の観点を参照することを除く）
- marketplace への登録・公開
- best-practices 自身をどの形（設計方針文書の「形の判定」の形）で実装するか。best-practices の仕様書が定める

## 前提と依存

- 設計方針文書が存在し、本文書と `docs/requirements/bp-designed-skill.md` はその節を参照する。
- 設計方針文書が「（暫定）」とした規則と値、および CLI の形とキー・ID の作り方は、best-practices の仕様書と最初の実装が定める。
- audit は現行の prompt-audit が存在することに依存する。

## リスクと影響

| ID | 観点 | 判定 | 根拠 |
|---|---|---|---|
| RK-001 | 不可逆な操作 | 該当 | create と update は対象スキルのファイルへ書き込み、update は既存のスキルを作り直してよい。途中で止まったときは書いたファイルを残し、戻すかどうかは利用者が決める（PR-BPOPERATIONS-040・041） |

## 要求一覧

### 機能の振り分け

#### PR-BPOPERATIONS-001 4 機能の提供
best-practices は、create・review・update・audit の 4 機能を提供しなければならない。

#### PR-BPOPERATIONS-002 1 つの機能への振り分け
利用者の依頼が 4 機能のうち 1 つに当たるならば、best-practices は依頼をその機能に振り分けなければならない。

#### PR-BPOPERATIONS-038 複数の機能にまたがる依頼
利用者の依頼が複数の機能にまたがるならば、best-practices は、それらの機能を順に実行し、前の機能の結果を次の機能に渡さなければならない。

#### PR-BPOPERATIONS-039 どの機能にも当たらない依頼
利用者の依頼が 4 機能のどれにも当たらないならば、best-practices は、どの機能も実行せず、当たる機能が無いことを返さなければならない。

#### PR-BPOPERATIONS-048 途中の機能が止まったときの連なり
複数の機能にまたがる依頼で、途中の機能が完了せずに止まったならば、best-practices は、後続の機能を実行せずに連なり全体を止め、止まった機能が返す報告を連なりの返しとしなければならない。

#### PR-BPOPERATIONS-049 次の機能の入力を満たさないときの連なり
複数の機能にまたがる依頼で、best-practices は、前の機能の結果を、次の機能の必須の入力（update については PR-BPOPERATIONS-015 が定める入力）の代わりとして渡してはならない。必須の入力が満たされないまま実行された機能が完了せずに止まったときの連なりの扱いは、PR-BPOPERATIONS-048 に従う。

### create

#### PR-BPOPERATIONS-003 目標の固定
create は、スキルを書く前に、依頼文から、PR-BPDESIGNEDSKILL-006 と同じ原則に従って目標を固定しなければならない（固定しないと、手順を終えたことが完了と読まれる）。

#### PR-BPOPERATIONS-004 依頼文に無い目標の禁止
create は、依頼文に無い目標・制約を対象スキルに加えてはならない（頼まれていない成果物に費用を払い、その完了を報告することになる）。

#### PR-BPOPERATIONS-005 待たれる入力の不足
目標を固定するのに要る人間の入力（承認・回答）が足りないならば、create は needs_input と理由を返して止まらなければならない（run の中では入力を待って続けられない）。

#### PR-BPOPERATIONS-006 run の中で入力を待たない
create は、PR-BPDESIGNEDSKILL-007 と同じ原則に従い、自身の run の途中で人間の承認・回答を待つ手順を持ってはならない（Workflow の実行中は入力を受け取れない）。

#### PR-BPOPERATIONS-007 1 回で解ける課題と探索グラフ型
形の判定で探索グラフの適用条件を問うとき、create は、1 体の agent の 1 回の実行で解ける課題を探索グラフ型の対象にしてはならない（1 回で解けるなら、スキルの形にする理由が無い）。

#### PR-BPOPERATIONS-008 設計方針への適合
create は、`docs/requirements/bp-designed-skill.md` の要求を満たすスキルを書かなければならない。

#### PR-BPOPERATIONS-037 create が書き換える範囲
create は、対象スキルの外にあるファイルを書き換えてはならない（書き換えは取り消せない操作なので、頼まれた対象の外へ広げない）。

#### PR-BPOPERATIONS-009 生成と別の context での検証
create は、書いたスキルを、書いた agent と別の context で検証しなければならない（生成した本人には自分の誤りが見えない）。

#### PR-BPOPERATIONS-010 検証を通るまでの完了の扱い
create は、書いたスキルが検証を通るまで、そのスキルを完了として報告してはならない（代わりに返すものは PR-BPOPERATIONS-012 が定める）。

#### PR-BPOPERATIONS-011 書き直しの許容
検証を通らなかったとき、create はスキルを書き直して再び検証してもよい。

#### PR-BPOPERATIONS-012 検証を通らずに止まるとき
書いたスキルが検証を通らないまま止まるならば、create は、通らなかったことと理由を返さなければならない。

#### PR-BPOPERATIONS-013 続けられない失敗
続けられない失敗が起きたならば、create は BLOCKED と理由を返して止まらなければならない（理由が残らないと、どこから再開すればよいかが分からない）。

#### PR-BPOPERATIONS-014 create の完了時の出力
create が完了したとき、create は作ったスキル・スキルの設計の説明・検証の結果を返さなければならない（完了の主張を利用者が検証の結果に照らして確かめられるようにするため）。指摘の状態と skip 一覧は PR-BPOPERATIONS-045・046 が定める。

### update

#### PR-BPOPERATIONS-015 update の入力
update は、対象スキルの全体と、1 件以上の修正の根拠を入力に受け取らなければならない。修正の根拠の件数に上限は置かず、update は、渡された修正の根拠を件数にかかわらず全件受け取らなければならず、件数を理由に受け取りを拒否したり切り詰めたりしてはならない。

#### PR-BPOPERATIONS-016 修正の根拠を出発点にする
update は、修正の根拠を、目標の固定の出発点として前提に置かなければならない（前提に無いと、後の手順が出発点を根拠として指せない）。

#### PR-BPOPERATIONS-017 create と同じ処理
update は、目標の固定から検証までを create と同じ処理（PR-BPOPERATIONS-003〜013）で行わなければならない。このとき、それらの要求の「依頼文」は「対象スキルの全体から読み取った目的と修正の根拠」と読み替える。

#### PR-BPOPERATIONS-018 全体の作り直しの許容
update は、修正の根拠が触れない部分を含め、対象スキルの全体を作り直してもよい。

#### PR-BPOPERATIONS-019 既存の振る舞いの判定
update は、修正の根拠が触れない既存の振る舞いが保たれたかを、作り直した後の検証の結果だけで判定しなければならない。作り直した後の検証の結果が触れていない既存の振る舞いは、保たれたと判定してはならず、検証の結果からは判定できなかったことを結果に示さなければならない。

#### PR-BPOPERATIONS-020 書き換える範囲
update は、対象スキルの外にあるファイルを書き換えてはならない（書き換えは取り消せない操作なので、頼まれた対象の外へ広げない）。

#### PR-BPOPERATIONS-022 前の run の指摘の状態（保持規則）
指摘の状態を run をまたいで追うかの裁定が下るまで、update は、入力に受け取った前の run の指摘を resolved / regressed として報告してはならない。

#### PR-BPOPERATIONS-042 報告する指摘の状態（保持規則）
指摘の状態を run をまたいで追うかの裁定が下るまで、update は、指摘の状態として、update の run の中で付けた状態だけを報告しなければならない。

#### PR-BPOPERATIONS-023 update の完了時の出力
update が完了したとき、update は直したスキルと検証の結果を返さなければならない。指摘の状態と skip 一覧は PR-BPOPERATIONS-045・046 が定める。

### create と update に共通

#### PR-BPOPERATIONS-021 run の中での指摘の追跡
create と update の run の中で対象スキルを書き換えたとき、create と update は、その run の中で付けた指摘を resolved（直った）/ regressed（再発した）まで追わなければならない（追わないと、直った指摘と再発した指摘を区別できない）。

#### PR-BPOPERATIONS-044 指摘の追跡の原則
create と update は、run の中での指摘の追跡を、設計方針文書の「資産台帳」の節の原則に従って行わなければならない。

#### PR-BPOPERATIONS-045 完了時の指摘の状態
create と update が完了したとき、create と update は、その run の中で付けた指摘ごとの状態を返さなければならない。

#### PR-BPOPERATIONS-046 完了時の skip 一覧
create と update が完了したとき、create と update は skip 一覧を返さなければならない（見ていない箇所が「問題なし」と読まれないようにするため）。

#### PR-BPOPERATIONS-040 途中で止まったときの書いたファイル
完了の前に止まったならば、create と update は、それまでに書いたファイルを残さなければならない（戻すかどうかは利用者が決める）。

#### PR-BPOPERATIONS-041 途中で止まったときの報告
完了の前に止まったならば、create と update は、書いたファイルが検証を通っていないことと、止まった段と止まった理由を報告しなければならない。

### review

#### PR-BPOPERATIONS-024 フローの観点
review は、対象スキルのフローが適切かを、`docs/requirements/bp-designed-skill.md` の要求に照らして評価しなければならない（create・update が満たす性質と同じ基準で評価するため）。

#### PR-BPOPERATIONS-025 仕様の観点
review は、対象スキルが仕様から逸れていないかを、best-practices の仕様書に照らして評価しなければならない（設計方針文書が暫定とした値と規則は、その仕様書が定める）。

#### PR-BPOPERATIONS-026 仕様書が無いとき
best-practices の仕様書が無い間、review は仕様の観点を未検査として結果に示さなければならない（無いまま「問題なし」と返すと、照らしていない観点が照らしたと読まれる）。仕様書の一部だけが存在するときは、この定めは照らすべき観点ごと・範囲ごとに当たり、対応する仕様書が無い観点は未検査として結果に示さなければならず、仕様書の一部が存在することだけを理由に対応する仕様書が無い観点を検査済みにしてはならない。

### audit

#### PR-BPOPERATIONS-027 audit の対象
audit は、既存のスキルを対象にしなければならない。

#### PR-BPOPERATIONS-028 監査の観点の引き継ぎ
audit は、現行の prompt-audit が定める監査の観点を引き継がなければならない。

#### PR-BPOPERATIONS-050 現行の prompt-audit が存在しないとき
現行の prompt-audit が存在しないならば、audit は、監査を実行せずに止まらなければならず、そのときの返しは PR-BPOPERATIONS-047 に従う止まった段と止まった理由（引き継ぐ監査の観点が無いこと）の報告とし、監査の結果を返してはならない。

#### PR-BPOPERATIONS-029 監査の流れ
audit は、監査の流れを、現行の best-practices スキルが行う監査の流れではなく設計方針文書に沿って組まなければならない（4 機能を同じ設計方針に揃えるため）。

### review と audit に共通

#### PR-BPOPERATIONS-030 対象を書き換えない
review と audit は、対象スキルを書き換えてはならない（修正は update が行う）。

#### PR-BPOPERATIONS-031 指摘の反証
review と audit は、指摘の候補を、生成と別の context で反証してから結果に含めなければならない（生成した本人には自分の誤りが見えない）。

#### PR-BPOPERATIONS-032 指摘の状態
review と audit は、指摘の状態を open と dismissed のどちらかとして返さなければならない（対象が書き換わらない run では resolved / regressed が決まらない）。

#### PR-BPOPERATIONS-043 dismissed の指摘の扱い
review と audit は、反証で dismissed とした指摘も、却下の理由を付けて結果に含めなければならない（載せないと、検討して退けた指摘と検討していない指摘を結果から区別できない）。

#### PR-BPOPERATIONS-033 資産への結び付け
review と audit は、指摘と「確認済みで問題なし」を、設計方針文書の「資産台帳」の節の原則に従って資産に結び付けなければならない（結び付けないと、どこまで見たかを数えられない）。

#### PR-BPOPERATIONS-034 カバレッジと skip 一覧
review と audit は、カバレッジと skip 一覧を結果に含めなければならない（見ていない箇所が「問題なし」と読まれる）。

#### PR-BPOPERATIONS-035 見ていない資産の扱い
review と audit は、結果が結び付かなかった資産を「問題なし」として返してはならない（それらの資産は、PR-BPOPERATIONS-034 の skip 一覧に載せて返す）。

#### PR-BPOPERATIONS-036 update への受け渡し
review と audit は、返した指摘を update の修正の根拠として渡せる形で返さなければならない。

#### PR-BPOPERATIONS-047 途中で止まったときの報告（review と audit）
完了の前に止まったならば、review と audit は、止まった段と止まった理由を報告しなければならない（利用者が、再開した run がどこから続くかと、止まった原因を知るため）。
