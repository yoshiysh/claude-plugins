# 仕様書: 依頼の振り分け・機能の連鎖・Workflow callsite

## 表記規約

仕様項目の語尾の区分は `docs/requirements/bp-operations.md` の「表記規約」に従う（必須 = 〜しなければならない、推奨 = 〜することが望ましい、許容 = 〜してもよい、禁止 = 〜してはならない）。主体「best-practices」「利用者」の意味も同文書に従う。

## 対象範囲

本文書は、best-practices の入口を定める。扱うのは次のとおり。

- 依頼から機能への振り分けと、当たる機能が無い依頼の返し方
- 複数の機能にまたがる依頼の、順の実行と結果の受け渡し
- SKILL.md の Workflow callsite: 経路（Claude Code の native Workflow と Codex runner）の選び方、callsite の入力、起動数の上限の渡し方、Codex runner の request に書く値
- 利用者への返り値
- Codex runner の経路の前提と、その前提のために runner と runtime README に入れる変更（SP-BPENTRY-024・SP-BPENTRY-025）

経路の選び方（SP-BPENTRY-014）は、best-practices 自身の callsite の仕様であると同時に、`docs/specifications/bp-conformance.md` が対象スキルの callsite を PR-BPDESIGNEDSKILL-022・023 に照らすときの経路の選び方の正本である（SP-BPCONFORMANCE-026 がここを参照する）。起動数の上限の値と request の項目（SP-BPENTRY-015・016）は best-practices 自身の callsite にだけ当て、対象スキルが渡す値の基準は SP-BPCONFORMANCE-026 に従う。

次の事柄は他の文書が定め、本文書は参照だけにする。

| 事柄 | 正本 |
|---|---|
| run の境界、状態、停止の種類、next_args、CLI、起動数の上限を受け取った run の振る舞い、共通の異常系 | `docs/specifications/bp-run.md` |
| create・update の流れ、create が作るスキルの置き場、修正の根拠が 0 件のときの扱い | `docs/specifications/bp-authoring.md` |
| review・audit の観点と流れ | `docs/specifications/bp-inspection.md` |
| 指摘の形と修正の根拠の形 | `docs/specifications/bp-findings.md` |
| 対象スキルに課す値と判定基準 | `docs/specifications/bp-conformance.md` |

### 本文書が実現する要求

- 主担当: `docs/requirements/bp-operations.md` の PR-BPOPERATIONS-001・PR-BPOPERATIONS-002・PR-BPOPERATIONS-038・PR-BPOPERATIONS-039
- 併せて実現: PR-BPOPERATIONS-036、`docs/requirements/bp-designed-skill.md` の PR-BPDESIGNEDSKILL-016・PR-BPDESIGNEDSKILL-022・PR-BPDESIGNEDSKILL-023（best-practices 自身の入力と callsite に当てたもの。主担当は `docs/specifications/bp-conformance.md`）

## 用語定義

要求文書の用語（`docs/requirements/bp-operations.md`「用語」）と、`docs/specifications/bp-run.md` の用語定義（状態・状態 ID・run ID・作業場所・起動数・起動数の上限）はそのまま使う。本表は本文書で足す語だけを持つ。

| 用語 | 意味 |
|---|---|
| 入口 | best-practices の SKILL.md のうち、依頼を受けてから run を起動し、返り値を利用者へ返すまでの手順。Claude のターンとして実行され、run の中では動かない |
| 機能の列 | 1 件の依頼から入口が作る、実行する機能の順序付きの並び。1 つの機能だけの依頼では長さ 1 |
| 連鎖 | 長さ 2 以上の機能の列を、前から順に 1 つずつ run として実行すること |
| 未実行の機能 | 機能の列のうち、連鎖が止まったために run を起動しなかった機能 |
| 当たらなかった部分 | 依頼のうち、4 機能のどれにも当たらなかった部分 |
| callsite | SKILL.md の中で Workflow を起動する箇所 |
| 経路 | callsite が Workflow を起動する手段。native Workflow の経路（Claude Code の Workflow ツール）と、Codex runner の経路（`workflow:dynamic-workflow-runner` を内部で使う）の 2 つ |
| request | Codex runner の経路で、callsite が runner に渡す実行の指定（`limits` などを持つ。runtime README の Explicit live execution の節） |

## 機能仕様

### 振り分け

#### SP-BPENTRY-001 4 機能の入口
best-practices の SKILL.md は、create・review・update・audit の 4 機能を 1 つの入口から提供しなければならない。入口は、どの機能も best-practices の Workflow を 1 つの機能につき 1 つの run として起動して実行しなければならない（run の境界は SP-BPRUN-001）。起動する機能は callsite の入力の「機能」で指定する（SP-BPENTRY-013）。

#### SP-BPENTRY-002 振り分けを行う場所
振り分けと機能の列の作成は、入口が run を起動する前に行わなければならない。run の中で依頼を振り分け直してはならない（振り分けは依頼文を読む判断で、1 つの run は 1 つの機能だけを実行するため：SP-BPRUN-001）。

#### SP-BPENTRY-003 機能の当て方
入口は、依頼の各部分を次の表で機能に当てなければならない。

| 依頼の部分が求めること | 当てる機能 |
|---|---|
| まだ無いスキルを、依頼文の目的から新しく作る | create |
| 既存のスキルのフローと仕様からの逸れを評価する | review |
| 既存のスキルを、現行の prompt-audit の観点で監査する | audit |
| 既存のスキルを、review・audit の指摘か利用者の修正の指示に沿って直す | update |
| 上のどれにも当たらない（marketplace への登録・公開、スキルの実行、スキルを伴わない質問など） | 当たる機能が無い（SP-BPENTRY-011） |

marketplace への登録・公開は `docs/requirements/bp-operations.md` のスコープ外である。

#### SP-BPENTRY-004 機能の列の作り方
入口は、当てた機能を依頼が述べる順に並べて機能の列を作らなければならない。依頼が順を述べずに複数の機能を求めるとき、review・audit を update より前に置かなければならない（update は review・audit の結果を修正の根拠として受け取るため：PR-BPOPERATIONS-036）。同じ機能が列に 2 回以上現れてよい（例: review → update → review）。

#### SP-BPENTRY-005 機能が 1 つに決まらない部分
依頼の 1 つの部分が SP-BPENTRY-003 の 2 つ以上の行に当たり、どちらかに決まらないとき、入口は run を起動する前に、どの機能かを利用者にターンの中で尋ねなければならない。推測で一方を選んではならない（選び違えると、頼まれていない機能の run に費用を払う）。尋ねるのは run の外なので、SP-BPRUN-002 の禁止には当たらない。

#### SP-BPENTRY-006 対象スキルのパスの一覧
review・update・audit の run を起動する前に、入口は、CLI に対象スキルのパスの一覧（形は `docs/specifications/bp-run.md` の用語定義）を作らせ（SP-BPRUN-031）、callsite の入力に渡さなければならない（run の開始の入力：SP-BPRUN-003）。一覧の根は、依頼が指す対象スキルのディレクトリとする。一覧に入れるファイルは SP-BPENTRY-022 に、一覧を作れないときは SP-BPENTRY-023 に従う。create の対象スキルのパスの決め方は `docs/specifications/bp-authoring.md` に従う。連鎖の 2 番目以降の機能の対象スキルは SP-BPENTRY-009 に従う。

#### SP-BPENTRY-022 パスの一覧に入れるファイル
対象スキルのパスの一覧に入れるファイルは、次のとおりとしなければならない（範囲は `docs/requirements/bp-operations.md` の用語「対象スキル」）。callsite を workflow script に解決する規則は本項だけに置き、`docs/specifications/bp-inspection.md` の SP-BPINSPECTION-022、連鎖の SP-BPENTRY-009、CLI がパスの一覧を作る処理と取り直す処理（SP-BPRUN-031）は本項を参照する。

- 根のディレクトリの中の全てのファイル
- 対象スキルの SKILL.md にある Workflow callsite が起動する、自分の plugin の workflow script。`Workflow({ name: "<plugin>:<meta.name>" })` の callsite は、`<plugin>` が対象スキルの属する plugin であるときだけ、その plugin の `workflows/` 直下で literal の `meta.name` が一致するファイルに解決する。`Workflow({ scriptPath })` の callsite は、対象スキルのディレクトリを基準に解決する（`references/claude-workflow-compatibility.md` の Caller 境界の固定の節）

#### SP-BPENTRY-023 パスの一覧を作れないとき
対象スキルのディレクトリを依頼から特定できないとき、入口は run を起動せず、利用者にターンの中で尋ねなければならない。自分の plugin を指す callsite のどれかをファイルに解決できないとき、入口は、解決できたパスだけで一覧を作って run を起動し、解決できなかった callsite を `SKILL.md` の行番号とともに、対象スキルから外したものとして返り値に載せなければならない（SP-BPENTRY-021。載せないと、外した callsite が見た範囲に入ったと読まれる）。

### 連鎖

#### SP-BPENTRY-007 連鎖の実行
入口は、機能の列を前から順に、1 つの機能につき 1 つの run として起動しなければならない。前の機能の run が返り値を返す前に、次の機能の run を起動してはならない。

#### SP-BPENTRY-008 次の機能へ進む条件
入口が次の機能の run を起動してよいのは、前の機能の run が完了で止まったときだけとする。前の run が完了以外で止まったとき、入口は次の機能の run を起動してはならず、前の run の返り値と未実行の機能を利用者に返さなければならない（SP-BPENTRY-021）。

#### SP-BPENTRY-009 前の機能の結果の渡し方
入口は、次の機能の run の入力を、前の機能の run の返り値から次の判定表に従って作らなければならない。

> 条件の値: 前の機能 = create / review / update / audit
> 条件の値: 次の機能 = create / review / update / audit

| 条件: 前の機能 | 条件: 次の機能 | 結果 |
|---|---|---|
| * | create | 起こりえない。create を列の先頭以外に置く依頼は SP-BPENTRY-019 で扱い、run を起動しない |
| create | review | 対象スキルのディレクトリを create の返り値の作ったスキルのディレクトリ（`docs/specifications/bp-authoring.md` の SP-BPAUTHORING-033）から取り、パスの一覧を SP-BPENTRY-006 で作る。指摘は渡さない |
| create | audit | 対象スキルのディレクトリを create の返り値の作ったスキルのディレクトリ（SP-BPAUTHORING-033）から取り、パスの一覧を SP-BPENTRY-006 で作る。指摘は渡さない |
| create | update | 対象スキルのディレクトリを create の返り値の作ったスキルのディレクトリ（SP-BPAUTHORING-033）から取り、パスの一覧を SP-BPENTRY-006 で作る。修正の根拠は、依頼の中の利用者の修正の指示だけにする |
| review | review | 対象スキルを前の run と同じにする。指摘は渡さない |
| review | audit | 対象スキルを前の run と同じにする。指摘は渡さない |
| review | update | 対象スキルを前の run と同じにする。修正の根拠は、review の返り値の指摘の一覧（SP-BPFINDINGS-029 の形）と、依頼の中の利用者の修正の指示にする |
| audit | review | 対象スキルを前の run と同じにする。指摘は渡さない |
| audit | audit | 対象スキルを前の run と同じにする。指摘は渡さない |
| audit | update | 対象スキルを前の run と同じにする。修正の根拠は、audit の返り値の指摘の一覧（SP-BPFINDINGS-029 の形）と、依頼の中の利用者の修正の指示にする |
| update | review | 対象スキルのディレクトリを前の run と同じにし、パスの一覧を SP-BPENTRY-006 で作り直す。指摘は渡さない |
| update | audit | 対象スキルのディレクトリを前の run と同じにし、パスの一覧を SP-BPENTRY-006 で作り直す。指摘は渡さない |
| update | update | 対象スキルのディレクトリを前の run と同じにし、パスの一覧を SP-BPENTRY-006 で作り直す。修正の根拠は、依頼の中の利用者の修正の指示だけにする |

前の機能が create・update のときにパスの一覧を作り直すのは、update が全体を作り直してよく（PR-BPOPERATIONS-018）、create・update の run の後に自分の plugin の workflow script が増減していることがあるからである。review・audit は対象スキルを書き換えないので、一覧を引き継ぐ。create・update の指摘を修正の根拠として渡さないのは、修正の根拠の形が review・audit の指摘と利用者の指示の 2 つだけだからである（SP-BPFINDINGS-031）。修正の根拠が 0 件になった update の扱いは `docs/specifications/bp-authoring.md` に従う。

#### SP-BPENTRY-010 結果を書き換えずに渡す
入口は、前の run の返り値から次の run へ渡す指摘の一覧を、返り値のまま渡さなければならない（パスの一覧は SP-BPENTRY-009 の判定表に従う）。入口は、指摘を要約・言い換え・並べ替えしてはならず、状態（open・dismissed）や観点で絞ってもならない（絞るのは SP-BPFINDINGS-031）。利用者の修正の指示は、依頼の文言をそのまま渡さなければならない。

#### SP-BPENTRY-011 当たる機能が無い依頼
依頼の全ての部分が SP-BPENTRY-003 で「当たる機能が無い」になったとき、入口は run を 1 つも起動してはならず、当たる機能が無いことを利用者に返さなければならない（SP-BPENTRY-021）。

#### SP-BPENTRY-012 一部が当たらない依頼
依頼の一部だけが「当たる機能が無い」になったとき、入口は、当たった部分だけで機能の列を作って実行し、当たらなかった部分を実行せずに返り値に載せなければならない（SP-BPENTRY-021）。当たらなかった部分を、4 機能のどれかで代わりに行ってはならない。

### Workflow callsite

#### SP-BPENTRY-013 callsite の入力
callsite は、best-practices の Workflow に次の入力を渡さなければならない。4 機能の入力の表は本項だけに置き、他の文書は参照する。入力の項目の綴り（起動数の上限の項目を含む）は TBD-SBPENTRY-002 で決める。

> 条件の値: 起動 = 新しい状態での起動 / 再開
> 条件の値: 項目 = 機能 / 依頼文 / 対象スキルのパスの一覧 / 修正の根拠 / next_args / 利用者の回答 / 起動数の上限

| 条件: 起動 | 条件: 項目 | 結果 |
|---|---|---|
| 新しい状態での起動 | 機能 | 渡す（create・review・update・audit のどれか） |
| 新しい状態での起動 | 依頼文 | create のときだけ渡す。依頼の文言をそのまま渡す |
| 新しい状態での起動 | 対象スキルのパスの一覧 | review・update・audit では SP-BPENTRY-006 の一覧を渡す（連鎖の 2 番目以降は SP-BPENTRY-009 で作る）。create では `docs/specifications/bp-authoring.md` に従う |
| 新しい状態での起動 | 修正の根拠 | update のときだけ渡す（形は SP-BPFINDINGS-031、連鎖では SP-BPENTRY-009） |
| 新しい状態での起動 | next_args | 渡さない |
| 新しい状態での起動 | 利用者の回答 | 渡さない |
| 新しい状態での起動 | 起動数の上限 | SP-BPENTRY-015 に従う |
| 再開 | 機能 | 渡さない（next_args が持つ：SP-BPRUN-033） |
| 再開 | 依頼文 | 渡さない（再開に要る値は run が状態から読む：SP-BPRUN-033） |
| 再開 | 対象スキルのパスの一覧 | 渡さない（状態にある：SP-BPRUN-005） |
| 再開 | 修正の根拠 | 渡さない（前提として状態にある：SP-BPRUN-004） |
| 再開 | next_args | 止まった run が返した next_args を、1 字も変えずに渡す |
| 再開 | 利用者の回答 | 利用者が回答を足したときだけ、next_args と別の項目として、回答の文言をそのまま渡す（SP-BPRUN-033） |
| 再開 | 起動数の上限 | SP-BPENTRY-015 に従う |

#### SP-BPENTRY-014 経路の選び方
callsite は、Workflow を起動するたびに、次の判定表で経路を選ばなければならない（native-first の経路の契約：AGENTS.md、`references/claude-workflow-compatibility.md` の目的の節）。この規則は再開の起動にも当てる。

> 条件の値: native Workflow = 今の道具の一覧にある / 無い
> 条件の値: この起動での native の試行 = 未試行 / 試行して失敗した

| 条件: native Workflow | 条件: この起動での native の試行 | 結果 |
|---|---|---|
| 今の道具の一覧にある | 未試行 | native Workflow の経路で 1 回だけ起動する |
| 今の道具の一覧にある | 試行して失敗した | Codex runner の経路に切り替えてはならない。SP-BPENTRY-017 に従う |
| 無い | 未試行 | Codex runner の経路で起動する。利用者に runner の指定を求めてはならない |
| 無い | 試行して失敗した | 起こりえない（native が無ければ試行できない） |

「試行して失敗した」は、native Workflow の起動が error・timeout・不正な結果のどれかで終わったことを指す。

#### SP-BPENTRY-015 起動数の上限の渡し方
callsite は、選んだ経路に従って起動数の上限を渡さなければならない。

- Codex runner の経路では、起動数の上限を必ず渡す。値は、同じ起動の request の `limits.maxAgents` と同じ値とする（`limits.maxAgents` を超える値を渡すと、上限に収めても runner に run 全体を失敗させられる：SP-BPCONFORMANCE-026）。
- native Workflow の経路では、起動数の上限を渡してはならない（渡さない run は件数にも起動数にも上限を置かない：SP-BPRUN-040）。

再開の起動でも、経路をその起動で選び直し、同じ規則で渡すかどうかを決めなければならない（前の run と経路が違うことがある）。

#### SP-BPENTRY-016 Codex runner の request
Codex runner の経路で、callsite は request に次を書かなければならない。

| request の項目 | 書くもの |
|---|---|
| `limits.maxAgents` | 省略してはならない。値は TBD-SBPENTRY-001 |
| `limits.timeoutMs` | 値は TBD-SBPENTRY-001 |
| `modelMap` | best-practices の script が `agent()` に渡す全ての model の名前（SP-BPCONFORMANCE-035 の best-practices 自身の役の表の `model` の列）に、Codex の model を対応させる（全ての `agent()` が model を明示する（SP-BPRUN-023）ので、対応が欠けると、runner はその名前を使う最初の `agent()` を dispatch する前に例外を投げ、run 全体が失敗する：`scripts/runtime/models.mjs` の 27〜28 行、runtime README の Explicit live execution の節）。対応させる Codex の model は TBD-SBPENTRY-001 |
| workspace の mode と `requirements` | 4 機能とも書き込みのできる mode にし、`requirements` にその mode に合う capability を宣言する。review・audit も運搬役が作業場所の状態を CLI で書く（SP-BPRUN-008）。runner の既定は読み取りだけで、`requirements` は run の作成前に照合される（runtime README の Explicit live execution の節）。host に `updatePolicy`・`updateContract` を書かない（SP-BPENTRY-024） |

`limits.maxAgents` の値が決まるまで（TBD-SBPENTRY-001）、callsite は `limits.maxAgents` を省略した request で起動してはならない（runner の既定の `limits.maxAgents` は、開始と停止の運搬役だけで使い切る数であり、SP-BPRUN-021 の最小の起動数に満たないので、run が必ず BLOCKED になる）。

Codex runner で review・audit が対象スキルを書き換えていないことは、SP-BPRUN-025・SP-BPRUN-026 で扱う。同時実行の上限は SP-BPCONFORMANCE-027 に従う。

#### SP-BPENTRY-024 Codex runner の経路の前提
本文書の Codex runner の経路は、runner が source の `meta.name` や `args` の値によって特定の caller を特別に扱わないことを前提にする（依頼者の裁定）。今の runner は、`meta.name` が `skill-creator-review` で `args.mode` が `update` の run を skill-creator の update として扱い、host の `updateContract`（`createWorkflow` では `updatePolicy`）が無ければ失敗させる（`scripts/runtime/runtime.mjs` の 69〜75 行、`scripts/runtime/adapter.mjs` の 45・97・113〜119 行、runtime README の 80〜87 行）。best-practices の update は対象スキルへ直接書く（SP-BPRUN-008）ので、staging への書き込みと承認後の適用を求めるこの扱いとは両立しない。SP-BPENTRY-025 の変更が入った runner でなければ、callsite は update の run を Codex runner の経路で起動してはならない。変更の入っていない runner を callsite が見分ける手段と、見分けたときに入口が返すものは TBD-SBPENTRY-003 で決める。

#### SP-BPENTRY-025 runner と runtime README の変更
SP-BPENTRY-024 の前提のために、`plugins/workflow/skills/dynamic-workflow-runner/` に次の変更を入れなければならない。コードの形は本文書では定めない。

| 変更する箇所 | 変更 |
|---|---|
| `scripts/runtime/runtime.mjs` の、`meta.name === 'skill-creator-review'` と `args.mode` による分岐（32〜38 行・69〜75 行）と、`scripts/runtime/resume.mjs` の同じ分岐（150 行） | 外す。source の名前と `args` の値で実行の条件を変えない |
| `scripts/runtime/adapter.mjs` の `updatePolicy` の検証と結び付け（45 行・97 行・113〜119 行）と、host の `updateContract` の受け取り | 外す。外した host の項目は、runtime README の Explicit live execution の節のとおり、未知の項目として拒否されるようになる |
| runtime README の skill-creator の caller の段落（80〜87 行） | 消す |
| 上の分岐と項目を使う他の箇所（`scripts/runtime/update-contract.mjs` と、`grep -E 'skill-creator-review\|updateContract\|updatePolicy\|creatorUpdate'` で当たる runner の skill の中のコード・テスト・文書） | 外した分岐に合わせて直すか消す |
| リポジトリ直下の `tests/` の、上の分岐と項目を前提にするテスト（`dynamic-workflow-adapter.test.mjs`・`skill-creator-workflow-meta.test.mjs`・`workflow-callers.test.mjs`。どれも上の grep に当たる） | 外した分岐に合わせて直すか消す |
| 今の skill-creator の caller が runner に渡す `updatePolicy`・`updateContract` の扱い（`plugins/skill-creator/` の中） | 新しい best-practices と同じ変更で置き換える（分岐を外した runner は、この項目を未知の項目として拒否する） |

変更の後に、runner の skill の中、リポジトリ直下の `tests/`、新しい best-practices の配布物を除いた `plugins/skill-creator/` で、上の grep に当たる箇所が 0 件であることを確かめる。

runner の `requirements` の照合と workspace の mode（runtime README の Explicit writable and isolated checkouts の節）は変えない。best-practices の update が対象スキルに書けるのは、SP-BPENTRY-016 の workspace の mode による。

## エラー処理と異常系

本文書の機能に固有の異常系だけを置く。run の中の agent の失敗・続けられない失敗・途中終了は `docs/specifications/bp-run.md` が扱う。

#### SP-BPENTRY-017 native Workflow の起動の失敗
native Workflow の経路の起動が error・timeout・不正な結果で終わったとき、入口は Codex runner の経路で起動し直してはならない（SP-BPENTRY-014）。入口は、host が返した失敗の内容をそのまま利用者に返し、連鎖の後ろの機能を未実行の機能として返さなければならない。run が状態を書いた後に失敗したことがあるので、入口は、CLI が列挙する未完了の状態（SP-BPRUN-018）から状態 ID と next_args を得て再開できることを併せて返さなければならない（再開の手順は SP-BPRUN-018）。

#### SP-BPENTRY-018 どの経路も無い
native Workflow が今の道具の一覧に無く、`workflow:dynamic-workflow-runner` も使えないとき、入口は run を起動してはならず、`workflow` plugin の install が要ることを利用者に返さなければならない（Codex は plugin の依存を自動で入れない：AGENTS.md）。

#### SP-BPENTRY-019 create を列の先頭以外に置く依頼
依頼が、他の機能の後に create を求めるとき、入口は run を 1 つも起動してはならず、その機能の列を組めないことと、組めない理由（create の入力は依頼文だけで、前の機能の結果を渡す形が無い：PR-BPOPERATIONS-003）を利用者に返さなければならない。

#### SP-BPENTRY-020 渡せる形でない前の結果
連鎖の次の機能が update で、前の review・audit の run が完了で止まったのに、返り値の指摘の一覧が SP-BPFINDINGS-029 の項目を欠くとき、入口は update の run を起動してはならない。入口は、欠けた項目を補ったり作り直したりしてはならず、前の run の返り値・欠けた項目・未実行の機能を利用者に返さなければならない。

## 外部インタフェース

#### SP-BPENTRY-021 利用者への返り値
入口は、1 件の依頼に対して次を利用者に返さなければならない。

| 項目 | 返すとき | 中身 |
|---|---|---|
| 実行した各機能の返り値 | run を 1 つ以上起動したとき | 機能の列の順に、各 run の返り値をそのまま載せる（共通の項目は SP-BPRUN-032、機能に固有の項目は `docs/specifications/bp-authoring.md`・`docs/specifications/bp-inspection.md`、指摘と台帳の項目は SP-BPFINDINGS-030） |
| 未実行の機能 | 連鎖が完了以外で止まったとき（SP-BPENTRY-008・017） | 機能の列のうち起動しなかった機能を、列の順に |
| 再開の仕方 | 最後に起動した run が完了以外で止まったとき | その run の next_args をそのまま載せ、停止の種類ごとに再開の前に利用者がすること（needs_input では回答を足す、BLOCKED では原因を直す）を添える（SP-BPRUN-014）。run が next_args を返さなかったとき（状態を作らずに止まったとき：SP-BPRUN-032）は、next_args の代わりに、入力を直して新しく起動することを添える |
| 当たらなかった部分 | SP-BPENTRY-011・012 のとき | 依頼の該当する文言 |
| 当たる機能が無いこと | SP-BPENTRY-011 のとき | 当たる機能が無いことと、4 機能の名前 |
| 組めない・起動できない理由 | SP-BPENTRY-018・019・020・023 のとき | 各項目が定める内容 |
| 対象スキルから外した callsite | SP-BPENTRY-023 で解決できなかった callsite があったとき | 外した callsite の文言と `SKILL.md` の行番号と、それを持つファイルのパス |

入口は、run の返り値を要約・言い換えしてはならない（返り値の中の検証の結果や skip 一覧を書き換えると、利用者が完了の主張を確かめられない）。

利用者が再開を頼むとき、入口は、止まった run の機能を先頭とし、その後ろに依頼が求める機能を並べた機能の列として扱わなければならない。前に返した未実行の機能は、再開の依頼が求めたときだけ列に入れる。

## 検証方法

各仕様項目は、次の手段のどれかで確かめる。項目ごとの手段と測るものは、トレーサビリティ表の検証方法の列に置く。

| 手段 | 中身 |
|---|---|
| 振り分けの eval | 依頼文の fixture ごとに、期待する機能の列・当たらなかった部分・run を起動しないことを用意し、入口が作る機能の列と照らす |
| 静的な照合 | SKILL.md の本文を読み、callsite の経路の選び方・入力の項目・起動数の上限の有無・request の項目を照らす |
| 連鎖の結合テスト | agent を模擬の backend に置き換えた run の返り値を入口に渡し、次の run の入力・起動の有無・利用者への返り値を照らす（Codex runner の runtime は模擬の backend でのテストを持つ：runtime README の Install and verify without inference の節） |
| CLI の単体テスト | `docs/specifications/bp-run.md` の「検証方法」の同名の手段 |
| runner のテストの実行 | SP-BPENTRY-025 の変更を入れた runner について、runner の skill の中のテストとリポジトリ直下の `tests/` のテストを模擬の backend で走らせ、結果を照らす（runtime README の Install and verify without inference の節） |

## TBD の宣言

本文書が所属先の TBD。どれも着手を止めない（blocking: false）。

| TBD ID | 決めること | 決めない理由 | blocking | 保持規則 |
|---|---|---|---|---|
| TBD-SBPENTRY-001 | Codex runner の request の `limits.maxAgents` と `limits.timeoutMs` の値と、`modelMap` で SP-BPCONFORMANCE-035 の各 `model` に対応させる Codex の model | 値の出所が入力に無い。runner は Claude の model と Codex の model の対応を何も含意しない（runtime README の `modelMap` の段落）。Claude 側の `model` と `effort` は SP-BPCONFORMANCE-035 で決まっている | false | 決まるまで、callsite は `limits.maxAgents` を省略した request で起動してはならない（SP-BPENTRY-016）。`limits.timeoutMs` も request から省いて runner の既定に任せてはならない（既定の 60 秒は、best-practices の run に合わせて決めた値ではない）。`modelMap` を省いてはならず、SP-BPCONFORMANCE-035 の `model` の名前を 1 つも欠いてはならない（model を明示する `agent()` には runner の既定の model が使われず、対応の無い名前で run が失敗する：SP-BPENTRY-016） |
| TBD-SBPENTRY-002 | callsite が best-practices の Workflow に渡す入力の項目の綴り（起動数の上限の項目を含む） | 綴りは最初の実装でテストとともに決めると、上位文書（`docs/requirements/bp-operations.md`・設計方針文書「水準と未決事項」）が定めている | false | 決まるまで、入力の項目の意味と有無を SP-BPENTRY-013 の表から変えてはならない。綴りを決めるときは、script の定数と SKILL.md の callsite の契約を同じ変更で揃える |
| TBD-SBPENTRY-003 | 変更（SP-BPENTRY-025）の入っていない runner を callsite が見分ける手段と、見分けたときに入口が利用者へ返すもの | runner の変更の有無を caller が知る手段が、runtime README に書かれていない | false | 決まるまで、best-practices は SP-BPENTRY-025 の変更と同じ変更で配布し、変更の入っていない runner と組み合わせて配布してはならない（見分けられないまま起動すると、runner が update の run を失敗させる：SP-BPENTRY-024） |

## トレーサビリティ表

| 要求 ID | 仕様項目 ID | 検証方法 | ステータス |
|---|---|---|---|
| PR-BPOPERATIONS-001 | SP-BPENTRY-001 | 静的な照合（SKILL.md が 4 機能のそれぞれで Workflow を 1 run として起動する） | 未着手 |
| PR-BPOPERATIONS-001 | SP-BPENTRY-013 | 静的な照合（callsite の入力の項目が機能と起動の種類ごとに表と一致する） | 未着手 |
| PR-BPOPERATIONS-001 | SP-BPENTRY-016 | 静的な照合（Codex runner の request が `limits.maxAgents`・`modelMap`・書き込みのできる workspace の mode を持つ） | 未着手 |
| PR-BPOPERATIONS-001 | SP-BPENTRY-018 | 振り分けの eval（native も runner も無い環境で run を起動せず install を案内する） | 未着手 |
| PR-BPOPERATIONS-002 | SP-BPENTRY-002 | 静的な照合（振り分けが run の起動より前の手順にあり、script に振り分けが無い） | 未着手 |
| PR-BPOPERATIONS-002 | SP-BPENTRY-003 | 振り分けの eval（4 機能のそれぞれに当たる依頼文が、その機能だけの列になる） | 未着手 |
| PR-BPOPERATIONS-002 | SP-BPENTRY-005 | 振り分けの eval（review と audit のどちらにも読める依頼で、run を起動せずに尋ねる） | 未着手 |
| PR-BPOPERATIONS-002 | SP-BPENTRY-006 | 連鎖の結合テスト（review・update・audit の run の入力に、根が対象スキルのディレクトリのパスの一覧が渡る） | 未着手 |
| PR-BPOPERATIONS-002 | SP-BPENTRY-022 | 連鎖の結合テスト（自分の plugin の workflow script がパスの一覧に入る）と CLI の単体テスト（`name` と `scriptPath` の callsite を持つ対象スキルで、パスの一覧の作成が同じ入力に同じ一覧を返す） | 未着手 |
| PR-BPOPERATIONS-002 | SP-BPENTRY-023 | 連鎖の結合テスト（解決できない callsite が行番号とともに返り値に外したものとして載る）と振り分けの eval（対象スキルを特定できない依頼で run を起動せずに尋ねる） | 未着手 |
| PR-BPOPERATIONS-038 | SP-BPENTRY-009 | 連鎖の結合テスト（create → review で、review の対象スキルが create の返り値の作ったスキルのディレクトリになる） | 未着手 |
| PR-BPOPERATIONS-038 | SP-BPENTRY-021 | 連鎖の結合テスト（状態を作らずに止まった run の返り値で、再開の仕方に next_args が無く、入力を直して新しく起動することが載る） | 未着手 |
| PR-BPOPERATIONS-038 | SP-BPENTRY-004 | 振り分けの eval（順を述べた依頼と述べない依頼で、期待する列になる） | 未着手 |
| PR-BPOPERATIONS-038 | SP-BPENTRY-007 | 連鎖の結合テスト（前の run の返り値より前に次の run が起動されない） | 未着手 |
| PR-BPOPERATIONS-038 | SP-BPENTRY-008 | 連鎖の結合テスト（前の run が needs_input・BLOCKED で止まると次の run を起動せず、未実行の機能を返す） | 未着手 |
| PR-BPOPERATIONS-038 | SP-BPENTRY-009 | 連鎖の結合テスト（判定表の行ごとに、次の run の対象スキルと修正の根拠が表と一致し、update の後に足された workflow script が次の review の一覧に入る） | 未着手 |
| PR-BPOPERATIONS-038 | SP-BPENTRY-010 | 連鎖の結合テスト（open と dismissed の指摘を含む review の返り値が、update の入力に同じバイト列で渡る） | 未着手 |
| PR-BPOPERATIONS-038 | SP-BPENTRY-012 | 振り分けの eval（一部が当たらない依頼で、当たった部分だけを実行し、当たらなかった部分を返す） | 未着手 |
| PR-BPOPERATIONS-038 | SP-BPENTRY-021 | 連鎖の結合テスト（返り値に各 run の返り値が列の順に変えずに載り、止まったときは未実行の機能と next_args が載る） | 未着手 |
| PR-BPOPERATIONS-038 | SP-BPENTRY-017 | 連鎖の結合テスト（native の起動の失敗で runner に切り替えず、未実行の機能と再開の手段を返す） | 未着手 |
| PR-BPOPERATIONS-038 | SP-BPENTRY-019 | 振り分けの eval（review の後に create を求める依頼で run を起動しない） | 未着手 |
| PR-BPOPERATIONS-038 | SP-BPENTRY-020 | 連鎖の結合テスト（項目の欠けた指摘の一覧で update の run を起動しない） | 未着手 |
| PR-BPOPERATIONS-039 | SP-BPENTRY-003 | 振り分けの eval（marketplace への公開だけを求める依頼が「当たる機能が無い」になる） | 未着手 |
| PR-BPOPERATIONS-039 | SP-BPENTRY-011 | 振り分けの eval（当たる機能が無い依頼で run が 0 件起動され、当たる機能が無いことを返す） | 未着手 |
| PR-BPOPERATIONS-039 | SP-BPENTRY-021 | 振り分けの eval（当たる機能が無いときの返り値に、当たる機能が無いことと 4 機能の名前がある） | 未着手 |
| PR-BPOPERATIONS-036 | SP-BPENTRY-009 | 連鎖の結合テスト（review・audit → update で、指摘の一覧が修正の根拠として渡る） | 未着手 |
| PR-BPOPERATIONS-036 | SP-BPENTRY-010 | 連鎖の結合テスト（入口が指摘を絞らず、update の受け手で dismissed が除かれる） | 未着手 |
| PR-BPDESIGNEDSKILL-016 | SP-BPENTRY-013 | 静的な照合（SKILL.md の callsite の契約に起動数の上限の項目がある） | 未着手 |
| PR-BPDESIGNEDSKILL-022 | SP-BPENTRY-014 | 静的な照合（native が無いときだけ Codex runner の経路を選び、native の失敗で切り替えない） | 未着手 |
| PR-BPDESIGNEDSKILL-022 | SP-BPENTRY-015 | 連鎖の結合テスト（Codex runner の経路で、最初の起動と再開の起動の両方に `limits.maxAgents` と同じ値の上限が渡る） | 未着手 |
| PR-BPDESIGNEDSKILL-022 | SP-BPENTRY-016 | 静的な照合（`limits.maxAgents` を省略した request で起動しない） | 未着手 |
| PR-BPDESIGNEDSKILL-023 | SP-BPENTRY-014 | 静的な照合（native Workflow が道具の一覧にあれば native の経路を 1 回だけ選ぶ） | 未着手 |
| PR-BPDESIGNEDSKILL-023 | SP-BPENTRY-015 | 連鎖の結合テスト（native Workflow の経路で、最初の起動と再開の起動のどちらにも上限が渡らない） | 未着手 |
| PR-BPOPERATIONS-001 | SP-BPENTRY-024 | 連鎖の結合テスト（模擬の backend の Codex runner で、update の run が `updatePolicy`・`updateContract` の無い host で起動でき、対象スキルに書ける） | 未着手 |
| PR-BPOPERATIONS-001 | SP-BPENTRY-025 | 静的な照合（runner の skill の中、リポジトリ直下の `tests/`、新しい best-practices の配布物を除いた `plugins/skill-creator/` で SP-BPENTRY-025 の grep が 0 件）と runner のテストの実行（`meta.name` が `skill-creator-review` で `args.mode` が `update` の source が、他の source と同じ条件で動く） | 未着手 |
