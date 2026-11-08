# 仕様書: 依頼の振り分け・機能の連鎖・Workflow callsite

[設計時点の出典／旧規約 @ c7759f1]: https://github.com/yoshiysh/claude-plugins/blob/c7759f152c1e51369818f21e34a98cb0146e5e76/AGENTS.md
[repository-operations の現行案内]: https://github.com/yoshiysh/claude-plugins/blob/main/docs/guidelines/repository-operations.md

## 表記規約

仕様項目の語尾の区分は `docs/requirements/bp-operations.md` の「表記規約」に従う（必須 = 〜しなければならない、推奨 = 〜することが望ましい、許容 = 〜してもよい、禁止 = 〜してはならない）。主体「best-practices」「利用者」の意味も同文書に従う。

## 対象範囲

本文書は、best-practices の入口を定める。本文書は `####` 見出し 1 つを 1 仕様項目とする。扱うのは次のとおり。

- 依頼から機能への振り分けと、当たる機能が無い依頼の返し方
- 複数の機能にまたがる依頼の、順の実行と結果の受け渡し
- SKILL.md の Workflow callsite: 経路（Claude Code の native Workflow と Codex runner）の選び方、callsite の入力、起動数の上限の渡し方、Codex runner の request に書く値
- 利用者への返り値
- Codex runner の経路の前提（SP-BPENTRY-024）

経路の選び方（SP-BPENTRY-014）は、best-practices 自身の callsite の仕様であると同時に、`docs/specifications/bp-conformance.md` が対象スキルの callsite を PR-BPDESIGNEDSKILL-022 に照らすときの経路の選び方の正本である（SP-BPCONFORMANCE-026 がここを参照する）。起動数の上限の値と request の項目（SP-BPENTRY-015・016）は best-practices 自身の callsite にだけ当て、対象スキルが渡す値の基準は SP-BPCONFORMANCE-026 に従う。

次の事柄は他の文書が定め、本文書は参照だけにする。

| 事柄 | 正本 |
|---|---|
| run の境界、状態、停止の種類と next_args、起動数の上限を受け取った run の振る舞い、共通の異常系 | `docs/specifications/bp-run.md` |
| create・update の流れ、create が作るスキルの置き場、修正の根拠が 0 件のときの扱い | `docs/specifications/bp-authoring.md` |
| review・audit の観点と流れ | `docs/specifications/bp-inspection.md` |
| 指摘の形と修正の根拠の形 | `docs/specifications/bp-findings.md` |
| 対象スキルに課す値と判定基準 | `docs/specifications/bp-conformance.md` |

### 本文書が実現する要求

本書の各仕様項目と要求の対応は、末尾のトレーサビリティ表を正とする。

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
入口は、依頼が指定した順を尊重して機能の列を作らなければならない。順を指定しない場合は、対象の作成や修正の根拠など、機能間の入出力の依存関係から順を決めなければならない。依存関係で順が一意に決まらない場合は、run を起動する前に利用者へ確認しなければならない。たとえば review と audit の間に依存も順の指定も無い場合、勝手に順を固定してはならない。

指定された順が依存関係と矛盾する場合も、起動前に矛盾と不足する入力を示して確認しなければならない。同じ機能が複数回現れる列は許容する。

#### SP-BPENTRY-005 機能が 1 つに決まらない部分
依頼の 1 つの部分が SP-BPENTRY-003 の 2 つ以上の行に当たり、どちらかに決まらないとき、入口は run を起動する前に、どの機能かを利用者にターンの中で尋ねなければならない。推測で一方を選んではならない（選び違えると、頼まれていない機能の run に費用を払う）。尋ねるのは run の外なので、SP-BPRUN-002 の禁止には当たらない。

#### SP-BPENTRY-006 対象スキルのパスの一覧
review・update・audit の run を起動する前に、入口は、対象スキルのパスの一覧（形は `docs/specifications/bp-run.md` の用語定義）を確定し、callsite の入力に渡さなければならない（run の開始の入力：SP-BPRUN-003）。一覧の根は、依頼が指す対象スキルのディレクトリとする。一覧に入れるファイルは SP-BPENTRY-022 に、一覧を作れないときは SP-BPENTRY-023 に従う。create の対象スキルのパスの決め方は `docs/specifications/bp-authoring.md` に従う。連鎖の 2 番目以降の機能の対象スキルは SP-BPENTRY-009 に従う。

#### SP-BPENTRY-022 パスの一覧に入れるファイル
対象スキルのパスの一覧に入れるファイルは、次のとおりとしなければならない（範囲は `docs/requirements/bp-operations.md` の用語「対象スキル」）。callsite を workflow script に解決する規則は本項だけに置き、`docs/specifications/bp-inspection.md` の SP-BPINSPECTION-022、連鎖の SP-BPENTRY-009、パスの一覧の作成と取り直しは本項を参照する。

- 根のディレクトリの中の全てのファイル
- 対象スキルの SKILL.md にある Workflow callsite が起動する、自分の plugin の workflow script。`Workflow({ name: "<plugin>:<meta.name>" })` の callsite は、`<plugin>` が対象スキルの属する plugin であるときだけ、その plugin の `workflows/` 直下で literal の `meta.name` が一致するファイルに解決する。`Workflow({ scriptPath })` の callsite は、対象スキルのディレクトリを基準に解決する（`references/claude-workflow-compatibility.md` の Caller 境界の固定の節）

#### SP-BPENTRY-023 パスの一覧を作れないとき
対象スキルのディレクトリを依頼から特定できないとき、入口は run を起動せず、利用者にターンの中で尋ねなければならない。自分の plugin を指す callsite のどれかをファイルに解決できないとき、入口は、解決できたパスだけで一覧を作って run を起動し、解決できなかった callsite を `SKILL.md` の行番号とともに、対象スキルから外したものとして返り値に載せなければならない（SP-BPENTRY-021。載せないと、外した callsite が見た範囲に入ったと読まれる）。

### 連鎖

#### SP-BPENTRY-007 連鎖の実行
入口は、機能の列を前から順に、1 つの機能につき 1 つの run として起動しなければならない。前の機能の run が返り値を返す前に、次の機能の run を起動してはならない。

#### SP-BPENTRY-008 次の機能へ進む条件
次の機能を起動してよいのは、前の機能が完了の返り値を返した場合だけとする。次の機能の入力の確認は、その機能の定めに委ねなければならない。update が扱う修正の根拠が 0 件の場合も、入口で起動を遮断せず、SP-BPAUTHORING-029 の入力確認により、状態を作らず needs_input と受領・除外の件数を返さなければならない。完了以外で止まった場合は、返り値と未実行の機能を返して連鎖を止めなければならない。状態を作る前の停止も同じ扱いとする。返り値が無い場合は SP-BPENTRY-017 に従い、失敗を成功として補ってはならない。

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

表の入力を、前の結果と依頼の修正指示から改変せずに作らなければならない。review・audit の指摘は SP-BPFINDINGS-031 の結果参照の形で渡し、入口で書き写してはならない。

前の機能が create・update のときにパスの一覧を作り直すのは、update が全体を作り直してよく（PR-BPOPERATIONS-018）、create・update の run の後に自分の plugin の workflow script が増減していることがあるからである。review・audit は対象スキルを書き換えないので、一覧を引き継ぐ。create・update の指摘を修正の根拠として渡さないのは、修正の根拠の形（`docs/specifications/bp-findings.md` の SP-BPFINDINGS-031 の表）に create・update の指摘が無いからである。修正の根拠が 0 件になった update の扱いは `docs/specifications/bp-authoring.md` に従う。

#### SP-BPENTRY-010 結果を書き換えずに渡す
review・audit の指摘の一覧は、完了した前の run の参照として渡し、次の機能が受け取る内容・順序・状態を前の結果と同じに保たなければならない。入口で要約・言い換え・並べ替えや、状態・観点での絞り込みをしてはならない。update が扱う指摘の選別は SP-BPFINDINGS-031 に従い、利用者の修正指示も原文のまま渡さなければならない。

#### SP-BPENTRY-011 当たる機能が無い依頼
依頼の全ての部分が SP-BPENTRY-003 で「当たる機能が無い」になったとき、入口は run を 1 つも起動してはならず、当たる機能が無いことを利用者に返さなければならない（SP-BPENTRY-021）。

#### SP-BPENTRY-012 一部が当たらない依頼
依頼の一部だけが「当たる機能が無い」になったとき、入口は、当たった部分だけで機能の列を作って実行し、当たらなかった部分を実行せずに返り値に載せなければならない（SP-BPENTRY-021）。当たらなかった部分を、4 機能のどれかで代わりに行ってはならない。

### Workflow callsite

#### SP-BPENTRY-013 callsite の入力
callsite は、best-practices の Workflow に次の入力を渡さなければならない。4 機能の入力の表は本項だけに置き、他の文書は参照する。入力の項目の綴り（起動数の上限の項目を含む）は表の後の綴りの表とする。

> 条件の値: 起動 = 新しい状態での起動 / 再開
> 条件の値: 項目 = 機能 / 依頼文 / 対象スキルのパスの一覧 / 修正の根拠 / next_args / 利用者の回答 / 起動数の上限 / スキルのディレクトリ / 起動の key / 経路

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
| * | スキルのディレクトリ | 渡す。best-practices のスキルのディレクトリの絶対パス |
| * | 起動の key | 渡す。起動の再送を識別できる、起動ごとに得た値。英数字と `.`・`_`・`-` だけの文字列とする |
| * | 経路 | 渡す。その起動で SP-BPENTRY-014 により選んだ経路を示す |

綴りは次の表とする。表に無い項目と、その起動の種類で「渡さない」とした項目を持つ入力は、script が agent を起動せずに BLOCKED で止める（SP-BPRUN-037 と同じく状態を書かない）。

| 項目 | 綴り | 渡すとき |
|---|---|---|
| 機能 | `function` | 新しい状態での起動 |
| 依頼文 | `request` | 新しい状態での create |
| 対象スキルのパスの一覧 | `target`（`{"root": <根>, "files": [<根の外のファイル>]}`） | 新しい状態での起動 |
| 修正の根拠 | `grounds`（前の run の参照の形 `{"from": <状態 ID>}` を含む：SP-BPFINDINGS-031） | 新しい状態での update |
| next_args | `nextArgs` | 再開 |
| 利用者の回答 | `answer` | 回答を足した再開 |
| 起動数の上限 | `maxLaunches` | SP-BPENTRY-015 |
| スキルのディレクトリ | `skillDir` | 常に。`'` を含むパスは受けない（運搬役が呼ぶコマンドで CLI のパスを `'` で囲む） |
| 起動の key | `key` | 常に |
| 経路 | `host` | 常に。`native`・`codex` のどちらかで表す（SP-BPENTRY-014 で起動ごとに選ぶ経路を、run の開始の記録と性能の記録の「取得できなかった」に使う：`docs/specifications/bp-run.md` の SP-BPRUN-046）。`native`・`codex` のどれでもない値は、script が agent を起動せずに BLOCKED で止める |

入力の作成手段は実装の設計で決めるが、起動の種類で渡さないとした項目、未定義の項目と不正な host を持つ入力は、agent を起動せず状態を作らずに BLOCKED として拒否しなければならない。

#### SP-BPENTRY-014 経路の選び方
callsite は、Workflow を起動するたびに、次の判定表で経路を選ばなければならない（native-first の経路の契約：[設計時点の出典／旧規約 @ c7759f1]、`references/claude-workflow-compatibility.md` の目的の節）。この規則は再開の起動にも当てる。

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
| `limits.maxAgents` | 省略してはならない。値は runner が受ける上限の 1000 とする（native の run は上限を持たないので、上限の役目は runner に収めることだけである：SP-BPENTRY-015） |
| `limits.timeoutMs` | 省略してはならない（runner の既定の 60 秒は、best-practices の run に合わせて決めた値ではない）。値は公開前の本物の agent での試走の記録の最長の run の所要時間の 2 倍を時間の単位で切り上げた値とし、一箇所を正本にして参照する。試走は Claude Code の native Workflow でだけ記録できる（`docs/specifications/bp-run.md` の「検証方法」）ので、Codex runner の値も native の run の所要時間から決める（runner の上で同じ run がどれだけかかるかは測っていない）。試走の記録が無い間は、旧 caller の先例の値を置く |
| `limits.concurrency` | `docs/specifications/bp-conformance.md` の SP-BPCONFORMANCE-027 が定める best-practices 自身の 同時実行の上限とする（runner の既定の 2 に任せると、script の同時実行の定数が runner で絞られる） |
| `limits.agentTimeoutMs` | 試走の記録の最長の 1 体の所要時間（native Workflow の run の記録の agent ごとの所要時間）の 2 倍を、時間上限の値と同じ正本に置く。置くまでは省き、runner の既定（`limits.timeoutMs` の 80%）に任せる |
| `modelMap` | best-practices の script が `agent()` に渡す全ての model の名前（SP-BPCONFORMANCE-035 の best-practices 自身の役の表の `model` の列）に、Codex の model を対応させる（全ての `agent()` が model を明示する（SP-BPRUN-023）ので、対応が欠けると、runner はその名前を使う最初の `agent()` を dispatch する前に例外を投げ、run 全体が失敗する：runtime README の Explicit live execution の節）。`modelMap` の鍵は、SP-BPCONFORMANCE-035 の best-practices の役の表の `model` の列の名前の全てとする。値は、起動する host がその時の Codex の model を明示で選んで埋める（Codex の model の名前を本書群に書くと、Codex の版で黙って古くなる）。callsite は、値の欠けた `modelMap` で起動してはならない |
| workspace の mode と `requirements` | 4 機能とも書き込みのできる mode にし、`requirements` にその mode に合う capability を宣言する。review・audit も運搬役が作業場所の状態を CLI で書く（SP-BPRUN-008）。runner の既定は読み取りだけで、`requirements` は run の作成前に照合される（runtime README の Explicit live execution の節）。host に `updatePolicy`・`updateContract` を書かない（SP-BPENTRY-024） |

callsite は、`limits.maxAgents` を省略した request で起動してはならない（runner の既定の `limits.maxAgents` は、開始と停止の運搬役だけで使い切る数であり、SP-BPRUN-021 が要るとする起動数に満たないので、run が必ず BLOCKED になる）。request を作る内部の手順は実装の設計で決め、同じ値の正本を複数にしてはならない。

Codex runner で review・audit が対象スキルを書き換えていないことは、SP-BPRUN-025・SP-BPRUN-026 で扱う。同時実行の上限は SP-BPCONFORMANCE-027 に従う。

#### SP-BPENTRY-024 Codex runner の経路の前提
Codex runner の経路は、source の名前や args の値に基づき特定の caller を特別扱いしないことを前提とする（依頼者の裁定）。4 機能は宣言した workspace の mode と capability に基づいて実行され、update には対象への書き込みを許す。callsite は host に `updatePolicy`・`updateContract` を渡してはならない。

runner との互換性と権限を確認できない場合は起動失敗として報告し、互換性を成立させるコードの分岐・ファイル・修正手順は BP の外部契約に含めない。

## エラー処理と異常系

本文書の機能に固有の異常系だけを置く。run の中の agent の失敗・続けられない失敗・途中終了は `docs/specifications/bp-run.md` が扱う。

#### SP-BPENTRY-017 返り値の無い run
機能の run が返り値を返さずに終わったとき（機能の列の長さを問わず、native Workflow と Codex runner のどちらの経路でも、起動の失敗・error・timeout・不正な結果を含む）、入口は後続の機能の run を起動してはならない。native Workflow の経路の失敗では、入口は Codex runner の経路で起動し直してはならない（SP-BPENTRY-014）。入口は、止まった機能が返す報告の代わりに host が返した失敗の内容を書き換えずに利用者に返し、後続の機能があればそれを未実行の機能として返さなければならない。run が状態を書いた後に失敗したことがあるので、入口は、CLI が列挙する未完了の状態（SP-BPRUN-018）から状態 ID と next_args を得て再開できることを併せて返さなければならない（再開の手順は SP-BPRUN-018）。

#### SP-BPENTRY-018 どの経路も無い
native Workflow が今の道具の一覧に無く、`workflow:dynamic-workflow-runner` も使えないとき、入口は run を起動してはならず、`workflow` plugin の install が要ることを利用者に返さなければならない（Codex は plugin の依存を自動で install しない。依存は利用者が個別に導入する：[repository-operations の現行案内]、設計時点の出典：[設計時点の出典／旧規約 @ c7759f1]）。

#### SP-BPENTRY-019 指定順と依存の矛盾
他の機能の後に create を置く指定など、列の順と入出力の依存関係が矛盾する場合、run を起動する前に、組めない依存関係・不足する入力を示して利用者に順または依頼の修正を確認しなければならない。指定を黙って並べ替えたり、依頼の無い入力を補ったりしてはならない。確認が済むまでは列を実行してはならない。

#### SP-BPENTRY-020 渡せる形でない前の結果
連鎖の次の機能が update で、前の review・audit の run が完了で止まったのに、返り値の指摘の一覧が SP-BPFINDINGS-029 の項目を欠くとき、入口は update の run を起動してはならない。入口は、欠けた項目を補ったり作り直したりしてはならず、前の run の返り値・欠けた項目・未実行の機能を利用者に返さなければならない。

## 外部インタフェース

#### SP-BPENTRY-021 利用者への返り値
入口は、1 件の依頼に対して次を利用者に返さなければならない。返り値の作成は保存された実行結果に基づき、元の内容を書き換えずに行わなければならない。

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

入力となる依頼・対象・修正根拠・host を変えた fixture で、起動する機能と順、起動しない機能、次へ渡す入力、返り値を観測する。順の指定がある/無い、依存が決まる/決まらない/矛盾、前の機能の完了/停止/返り値なし、対象の不足、外れた依頼と呼び出しも含める。

呼び出し側との入力・runner request は公開された項目と拒否条件に照合し、内部のコマンド名やモジュール配置を合格条件にしない。自然文の機能選択の質は、本物の agent を使う依頼群の eval で、期待する機能と未検査範囲を比較する。

## トレーサビリティ表

整理後の契約を実装が満たすかは未検証である。旧版のテストの「完了」を持ち越さず、各行は現契約に対応する実行証拠が得られてから更新する。

| 要求 ID | 仕様項目 ID | 検証方法 | ステータス |
|---|---|---|---|
| PR-BPOPERATIONS-001 | SP-BPENTRY-001 | 入出力・停止・再開の fixture で「4 機能の入口」の本項の条件と観測結果を照合する。意味の判定は本物の agent の試走で別に確認する | 未着手 |
| PR-BPOPERATIONS-001 | SP-BPENTRY-002 | 入出力・停止・再開の fixture で「振り分けを行う場所」の本項の条件と観測結果を照合する。意味の判定は本物の agent の試走で別に確認する | 未着手 |
| PR-BPOPERATIONS-001 | SP-BPENTRY-003 | 入出力・停止・再開の fixture で「機能の当て方」の本項の条件と観測結果を照合する。意味の判定は本物の agent の試走で別に確認する | 未着手 |
| PR-BPOPERATIONS-038 | SP-BPENTRY-004 | 入出力・停止・再開の fixture で「機能の列の作り方」の本項の条件と観測結果を照合する。意味の判定は本物の agent の試走で別に確認する | 未着手 |
| PR-BPOPERATIONS-001 | SP-BPENTRY-005 | 入出力・停止・再開の fixture で「機能が 1 つに決まらない部分」の本項の条件と観測結果を照合する。意味の判定は本物の agent の試走で別に確認する | 未着手 |
| PR-BPOPERATIONS-001 | SP-BPENTRY-006 | 入出力・停止・再開の fixture で「対象スキルのパスの一覧」の本項の条件と観測結果を照合する。意味の判定は本物の agent の試走で別に確認する | 未着手 |
| PR-BPOPERATIONS-001 | SP-BPENTRY-022 | 入出力・停止・再開の fixture で「パスの一覧に入れるファイル」の本項の条件と観測結果を照合する。意味の判定は本物の agent の試走で別に確認する | 未着手 |
| PR-BPOPERATIONS-001 | SP-BPENTRY-023 | 入出力・停止・再開の fixture で「パスの一覧を作れないとき」の本項の条件と観測結果を照合する。意味の判定は本物の agent の試走で別に確認する | 未着手 |
| PR-BPOPERATIONS-038 | SP-BPENTRY-007 | 入出力・停止・再開の fixture で「連鎖の実行」の本項の条件と観測結果を照合する。意味の判定は本物の agent の試走で別に確認する | 未着手 |
| PR-BPOPERATIONS-038 | SP-BPENTRY-008 | 入出力・停止・再開の fixture で「次の機能へ進む条件」の本項の条件と観測結果を照合する。意味の判定は本物の agent の試走で別に確認する | 未着手 |
| PR-BPOPERATIONS-036 | SP-BPENTRY-009 | 入出力・停止・再開の fixture で「前の機能の結果の渡し方」の本項の条件と観測結果を照合する。意味の判定は本物の agent の試走で別に確認する | 未着手 |
| PR-BPOPERATIONS-038 | SP-BPENTRY-009 | 入出力・停止・再開の fixture で「前の機能の結果の渡し方」の本項の条件と観測結果を照合する。意味の判定は本物の agent の試走で別に確認する | 未着手 |
| PR-BPOPERATIONS-036 | SP-BPENTRY-010 | 入出力・停止・再開の fixture で「結果を書き換えずに渡す」の本項の条件と観測結果を照合する。意味の判定は本物の agent の試走で別に確認する | 未着手 |
| PR-BPOPERATIONS-038 | SP-BPENTRY-010 | 入出力・停止・再開の fixture で「結果を書き換えずに渡す」の本項の条件と観測結果を照合する。意味の判定は本物の agent の試走で別に確認する | 未着手 |
| PR-BPOPERATIONS-001 | SP-BPENTRY-011 | 入出力・停止・再開の fixture で「当たる機能が無い依頼」の本項の条件と観測結果を照合する。意味の判定は本物の agent の試走で別に確認する | 未着手 |
| PR-BPOPERATIONS-038 | SP-BPENTRY-012 | 入出力・停止・再開の fixture で「一部が当たらない依頼」の本項の条件と観測結果を照合する。意味の判定は本物の agent の試走で別に確認する | 未着手 |
| PR-BPDESIGNEDSKILL-016 | SP-BPENTRY-013 | 入出力・停止・再開の fixture で「callsite の入力」の本項の条件と観測結果を照合する。意味の判定は本物の agent の試走で別に確認する | 未着手 |
| PR-BPOPERATIONS-001 | SP-BPENTRY-013 | 入出力・停止・再開の fixture で「callsite の入力」の本項の条件と観測結果を照合する。意味の判定は本物の agent の試走で別に確認する | 未着手 |
| PR-BPDESIGNEDSKILL-022 | SP-BPENTRY-014 | 入出力・停止・再開の fixture で「経路の選び方」の本項の条件と観測結果を照合する。意味の判定は本物の agent の試走で別に確認する | 未着手 |
| PR-BPDESIGNEDSKILL-022 | SP-BPENTRY-015 | 入出力・停止・再開の fixture で「起動数の上限の渡し方」の本項の条件と観測結果を照合する。意味の判定は本物の agent の試走で別に確認する | 未着手 |
| PR-BPDESIGNEDSKILL-022 | SP-BPENTRY-016 | 入出力・停止・再開の fixture で「Codex runner の request」の本項の条件と観測結果を照合する。意味の判定は本物の agent の試走で別に確認する | 未着手 |
| PR-BPOPERATIONS-001 | SP-BPENTRY-016 | 入出力・停止・再開の fixture で「Codex runner の request」の本項の条件と観測結果を照合する。意味の判定は本物の agent の試走で別に確認する | 未着手 |
| PR-BPOPERATIONS-001 | SP-BPENTRY-024 | 入出力・停止・再開の fixture で「Codex runner の経路の前提」の本項の条件と観測結果を照合する。意味の判定は本物の agent の試走で別に確認する | 未着手 |
| PR-BPOPERATIONS-038 | SP-BPENTRY-017 | 入出力・停止・再開の fixture で「返り値の無い run」の本項の条件と観測結果を照合する。意味の判定は本物の agent の試走で別に確認する | 未着手 |
| PR-BPOPERATIONS-001 | SP-BPENTRY-018 | 入出力・停止・再開の fixture で「どの経路も無い」の本項の条件と観測結果を照合する。意味の判定は本物の agent の試走で別に確認する | 未着手 |
| PR-BPOPERATIONS-038 | SP-BPENTRY-019 | 入出力・停止・再開の fixture で「指定順と依存の矛盾」の本項の条件と観測結果を照合する。意味の判定は本物の agent の試走で別に確認する | 未着手 |
| PR-BPOPERATIONS-038 | SP-BPENTRY-020 | 入出力・停止・再開の fixture で「渡せる形でない前の結果」の本項の条件と観測結果を照合する。意味の判定は本物の agent の試走で別に確認する | 未着手 |
| PR-BPOPERATIONS-001 | SP-BPENTRY-021 | 入出力・停止・再開の fixture で「利用者への返り値」の本項の条件と観測結果を照合する。意味の判定は本物の agent の試走で別に確認する | 未着手 |
| PR-BPOPERATIONS-038 | SP-BPENTRY-021 | 入出力・停止・再開の fixture で「利用者への返り値」の本項の条件と観測結果を照合する。意味の判定は本物の agent の試走で別に確認する | 未着手 |

## ID の扱い

欠番: SP-BPENTRY-025。内部実現を固定した項目を廃止した。外部の性質は対応する本文の契約で保持し、欠番は再利用しない。
