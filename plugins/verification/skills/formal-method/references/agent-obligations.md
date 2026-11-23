# 担当の共通の義務

formal-method の CLI（`run-daemon`）が開いた呼び出しで起動され、`claim` で task を取る全ての担当が守る項目。各担当の指示（`agents/<role>.md`）は、役ごとの境界・観点・返り値を持つ。形と値の正本は [成果物の形式](artifact-formats.md)（役ごとの抜粋は task の `instructions` の 3 つ目、`references/types/<role>.md`）、文書の一般規約は `instructions` の 4 つ目（run の領域の `document-rules/<指紋>.md`）、手順と配置の正本は [CLI 契約](cli-contract.md) で、ここには写さない。

<!-- この文書が義務の正本。担当に渡すのは、scripts/role-references.mjs がこの文書から作る役の分のファイル（references/obligations/author.md・confirmer.md）である。
節の見出しの次の行の「対象」の印（author か confirmer）で分け、印の無い節は両方に入れる。直したら node scripts/role-references.mjs を流す（role-references.test.mjs が一致を照らす）。 -->

## 目次

- [受け取るもの](#受け取るもの)
- [書く場所と返し方](#書く場所と返し方)
- [作業記録](#作業記録)
- [作成役の禁止](#作成役の禁止)
- [独立検証者の読む範囲](#独立検証者の読む範囲)
- [成功に読み替えない・秘密値・限界](#成功に読み替えない秘密値限界)

## 受け取るもの

担当は CLI の `claim` で task（[claim の Task](artifact-formats.md#claim-の-task)）を受け取り、`query` で資料を引く（手順の正本は [CLI 契約の依頼と応答](cli-contract.md#依頼と応答)）。1 回の `claim` は、その worker の出し終えていない task を全て（1 つ以上）返す。次の task は、受理された `submit` の応答の `next` で受け取る。`next` が `done: true` なら担当を終え、終わりの `claim` は流さない。1 体が複数の task を持つのは、確認役の詰め合わせ（同じ観点の unit）、原因の分類役の束、分割と計画を順に担う worker である。

| 受け取るもの | 中身 | 使い方 |
|---|---|---|
| `claim` の応答の最上位 | `query_cmd`・`submit_cmd`・`scratch_dir`・`document_rules`（worker で 1 つ）と `return_schemas`（役ごとの返り値の形） | `query` は `<query_cmd> <task_id>`、`submit` は `submit_cmd` で流す。返り値の形は `return_schemas[<task の role>]`。`document_rules` は適用する文書の一般規約の `{ref, version}` で、作業記録の `document_rules` の値（CLI が補うので書かなくてよい） |
| `submit` の応答の `next` | `done`・`tasks`・`shared_inputs` と `return_schemas`（`next` の `tasks` の役ごと）。`query_cmd`・`submit_cmd`・`scratch_dir`・`document_rules` は持たない | `done: true` なら終える。`done: false` なら `tasks` を続けて果たす。返り値の形は `next` の `return_schemas[<task の role>]`（`claim` の値のまま `query_cmd`・`submit_cmd`・`scratch_dir`・`document_rules` を使う） |
| `claim` の `tasks`（と `submit` の `next` の `tasks`）の各 task | `task_id`・`role`・`instructions`・`attempt_dir`・`result_path`・`context`（`TaskContext`） | `instructions` の 4 つのファイル（役の指示、この義務の役の分、役の型の抜粋、文書の一般規約）を読む。同じ役の task では読み直さない。`context` が担当の範囲 |
| `query` の `inputs` | 渡された資料ごとの `{name, ref, path, hash, spans?}`（`hash` は CLI が固定した指紋、`spans` は読む行の範囲。無ければファイルの全体）。ディレクトリの資料（`checks/<id>` など）は `hash` を持たない。`attempts/` の外の同じディレクトリの資料が 2 つ以上続けば `{ref, path, entries: [{name, entry}]}` に畳み、資料は `<path><entry>`（`ref` は `<ref><entry>`）である。`/` で終わる `entry` はディレクトリの資料である | 読む資料は下の「読んでよい資料」の規則のとおり |

- **読んでよい資料**: `query` の `inputs` が指す資料と、`instructions` の 4 つのファイルだけである。`claim` と `query` の出力の外を読まない。`ref` は `context.run_dir` からの相対 path か、対象のファイルを指す `target:<target_id>/<FilePath>` で、`path` は読む絶対 path（対象のファイルは元のファイル。写しは無い）。
  - ファイルの資料（`hash` を持つもの）は、そのファイルだけを読む。
  - ディレクトリの資料（`hash` を持たない要素と、畳んだ資料の `/` で終わる `entry`）は、その下のファイルを読んでよい。
  - 畳んだ資料は、`entries` が挙げるものだけを読む。畳んだディレクトリ（`<ref>`）の他のファイルは読まない。
  - CLI は `attempts/` の下の資料を畳まず、`attempts/` の下のディレクトリを資料にしない。`attempts/` の下のディレクトリを指す資料が渡されたら、その下を読まない（確認役・原因の分類役は、[独立検証者の読む範囲](#独立検証者の読む範囲)のとおり `failures` に書く）。
- `inputs` の要素が `spans`（`L<開始>-L<終了>` の並び）を持てば、そのファイルはその行だけを読む。範囲ごとに、範囲の行だけを開く手段で読む（Read の `offset` = 開始の行・`limit` = 終了 − 開始 + 1、`sed -n '<開始>,<終了>p' <path>` など）。ファイルの全体を開いてから範囲を探さない。
  - 理由: 渡した資料（SP-012）は、最初の `query` の時点の指紋で、範囲ごとに記録される。その外を読むと、記録された資料と読んだ資料が食い違う。担当の外の資料を `query` で引くと、CLI が拒む。
- 範囲の外の文脈（前後の行、他のファイル）が要るときは、範囲の外を読まずに、要った範囲（ファイルと行）と理由を作業記録の `unconfirmed` に書く。そのうえで、役ごとに次のとおりにする（どれも既存の欄で表す）。
  - 確認役・原因の分類役: その点を `確認できず` にし、要った範囲を確認の記録（`findings` の文か `note`）にも書く。
  - 作成役（抽出役・モデル作成役）: 範囲の中で取り出せる要素・性質は取り出し、範囲の外の文脈が要って決められない点は、推測で埋めずに `unconfirmed` に要った範囲として残す。判断が要る不足なら問い（`questions`）にする。範囲の外の文脈を補って書いた要素・節を、範囲の中の出所だけで書いたように見せない。
- `submit` の応答が `ok: false` で `problems` を返したら、CLI が見つけた欠陥か返り値の形の違いである。同じ担当として成果物と返り値を直し、同じ `submit_cmd` を流し直す。
- `submit` は、返り値を書いた task（前の照合から attempt の領域が変わったもの）を照合し、task ごとに結果を返す。書き終えた task から出す。
- 命令が `no_response` を返したら、何も書き換えずに同じ命令を 1 度だけ流し直す（それでも `ok: false` なら、理由を書いて担当を終える。Workflow の prompt と同じ）。応答を見られなかった `submit` を書き換えずに流し直すと、CLI は照合し直さず前の応答を返す（提出の回数は増えない）。応答を見た後に、直せないまま同じ成果物を出し直すと、新しい提出として照合される（欠陥が減らなければ残った欠陥ごと受理される）。
- `claim` の応答と `submit` の `next` の `shared_inputs` に挙がった資料は、同じ応答の複数の task が共有する資料である。`tasks` は共有する task ごとの `{task_id, spans?}` で、範囲は task ごとに違いうる。1 度だけ読み、task ごとの `query` の応答に同じ ref が出ても読み直さない。各 task の `query` は流す（task ごとの渡した資料の指紋はその時点で記録される）。
- 複数の task を持つときも、task ごとにその task の `query` の資料（範囲を持つ資料はその task の `spans` の行）だけで判断し、task ごとに返り値を書く。共有の資料を 1 度に読んでも、他の task の範囲の行や他の task の資料を根拠にしない（task ごとの渡した資料と判断が記録から読めなくなる）。
- 語と値は、`instructions` の役の型の抜粋（[成果物の形式](artifact-formats.md) から生成したもの）と役の指示に従う。一般の形式手法の語で置き換えると、CLI の照合と結果の値が食い違う。

## 書く場所と返し方

- 書くのは `attempt_dir` と `scratch_dir` の中だけである。`scratch_dir` は worker ごとの作業用の領域で、成果物でない生成物（途中の抜き出しなど）を置く。成果物・作業記録・返り値は `attempt_dir` に書く（`scratch_dir` を指す `Ref` は成功に数えられない）。run の状態（`status.json`）・台帳（`ledger.json`）・他の担当の `attempts/`・対象には書かない。台帳は CLI だけが書く（PR-BPDESIGNEDSKILL-029）。`attempt_dir` の外に書いたものは成果物として登録されない。
- 自分が書く全ての `Ref`（`outputs[].ref`・`record_ref`・`worklog_ref`・`query_ref`・`input_refs` など）は、`context.run_dir` からの相対 path で、`attempts/<task_id>/` で始まるか、`query` が渡した資料を指す。
- 返り値は `return_schemas[<task の role>]` の形の JSON を `result_path` に書き、`submit_cmd` を流して出す。返り値の `task_id` は task の値、`unit_id` は `context.unit_id`、`perspective` は `context.perspective` をそのまま使う。値が違う返り値は成功に数えられない。
- Workflow の返り値（担当の最後の応答）で内容を返さない。CLI は応答を読まず、`submit` で受理した `result_path` の返り値だけを使う。
- 書くファイルは、既にあれば上書きしてよい書き方で書く（Write の tool か、shell なら `>|`）。理由: shell の `noclobber` が効いていると `>` は既にあるファイルで失敗し、その回復に往復を使う。
- `submit` が `done: true` を返した担当は閉じている。受理された担当の成果物と返り値を書き換えない（受理の後に attempt の領域が書き換わると、CLI は受理を取り消す）。
- 長い作業は、書き終えた部分からファイルに書く。呼び出しの期限（CLI 契約の `AGENT_BATCH_DEADLINE_MS` と検査に使える期限の早い方）までに受理されなかった担当は欠測になる。期限の後の `submit` は拒まれる。そのため、期限より前に返り値を書き終えて `submit` を流す（条件の正本は [CLI 契約の依頼と応答](cli-contract.md#依頼と応答) と [成果物の形式の担当の返り値](artifact-formats.md#担当の返り値)）。

## 作業記録

`attempt_dir` の `worklog.json` に書き、返り値の `worklog_ref` で指す。形は型の抜粋の `Worklog`、欄は PR-BPDESIGNEDSKILL-028 の 9 項目である。

| 欄 | 書くもの |
|---|---|
| `role`・`task_id` | task の `role` と `task_id` |
| `stage` | `context.stage` |
| `target` | 対象（`context.target_id`、`model_id`、`unit_id` など、この task が扱うもの） |
| `inputs` | `query` の資料のうち、読んだファイルごとの `{ref}`。`instructions` のファイルは書かない。`ref` は、ファイルの資料ならその `ref`、ディレクトリの資料の下のファイルなら `<ディレクトリの ref>/<ディレクトリからの相対 path>`、畳んだ資料なら `<ref><entry>`（`entry` がディレクトリなら `<ref><entry><ディレクトリからの相対 path>`）。範囲（`spans`）で渡された対象のファイルは `{ref, spans: [{span}]}` で、渡された範囲のうち読んだものだけを書く。`span` は渡された `spans` の値のまま書く（範囲の一部だけを読んでも、行を切り詰めた範囲にしない。指紋は渡した範囲ごとにしか固定していないので、一部の範囲は渡していない範囲として差し戻される）。指紋（`hash`、範囲ごとの `hash`）は書かなくてよい |
| `actions`・`results`・`grounds` | したこと、得たこと、その根拠 |
| `failures`・`unconfirmed` | できなかったこととその理由、確かめられなかったこと |
| `unreadable_inputs` | 読めなかった資料と理由 |
| `document_rules` | 書かなくてよい（書くなら `claim` の `document_rules` のまま） |

- 指紋と `document_rules` は CLI が持つ。`submit` の照合で、書いていない指紋を渡した資料の指紋（最初の `query` の時点で固定したもの。ファイルの資料なら `query` の `hash` と同じ値、範囲なら渡した範囲ごとの指紋）で、`document_rules` を `claim` の値で補い、`worklog.json` を書き直してから照合する。書いた値が CLI の値と違えば欠陥として差し戻される（`problems`）。そのため、指紋を手で求めない。理由: 手で求めた指紋は写し間違いが起き、CLI が持つ値と 2 つの正本になる。
- 補うのは渡した資料と範囲だけである。渡していない資料（`query` の資料に無い ref。`query` を流す前の提出では全ての ref）と、渡していない範囲は、補わずに作業記録の欠陥として差し戻される（指紋を書いていても同じ）。理由: 作業記録の `inputs` は渡した資料のうち読んだものを示す欄で、渡していないものの指紋を補うと、資料の外を読んだ記録が通る。
- 文の欄は、文書の一般規約（`instructions` の 4 つ目のファイル。PR-BPDESIGNEDSKILL-040）に従って書く。そのファイルは `claim` の `document_rules` が指す版の写しである。
- model・effort・権限・渡した資料の指紋は CLI が台帳に書く。担当はそれらを作業記録に正本として書き直さない（PR-BPDESIGNEDSKILL-032）。

## 作成役の禁止
<!-- 対象: author -->

対象: `extractor`・`model-author`・`partition-author`・`plan-author`。

- 自分の成果物を「確認した」「検証した」と書かない。確認は独立検証者と CLI の役であり、作った者の確認を数えると独立した確認の定義（仕様の用語定義）が崩れる。
- 検証の道具（`z3` など）を実行しない。道具の実行は CLI が時間の上限と同時実行の数の下で行い、証拠として保存する。担当が実行した結果は記録に残らず、判定にも使われない。
- 判断が要る不足は、推測で埋めずに問い（`Question`）として返す。回答に依存しない部分は作り続け、依存する性質の id を `blocked_by_question` に入れる。書かれている遷移・条件を問いに変えない（それは要求の不足ではなく、読み落としである）。

## 独立検証者の読む範囲
<!-- 対象: confirmer -->

対象: `extraction-reviewer`・`fidelity-reviewer`・`assurance-reviewer`・`composition-reviewer`・`cause-analyst`。

読むのは `query` の `inputs` が指す資料だけである。次の表は観点ごとに渡される資料の種類で、読む集合を広げる根拠にはならない。CLI が `input_refs` に入れる具体の ref の正本は [成果物の形式の claim の Task](artifact-formats.md#claim-の-task) の「独立検証者と原因の分類役の `input_refs`」である。

| 観点（`perspective`） | 読むもの |
|---|---|
| `extraction` | 依頼の範囲の対象のファイルと一覧、固定した inventory、CLI の照合の記録 |
| `fidelity` | 対応表の行と、そのモデルの性質が扱う inventory の性質・節・遷移の出所の範囲の対象のファイル、そのモデルの性質の inventory の記述とその inventory の要素の一覧と、モデルの性質ごとの節・保証の抜粋と query のファイルの path（`views/<unit_id>.json`）、モデル、対応表、性質の query、CLI のモデル化の段の作業記録、そのモデルの判断を要する項目の記録とその実行の記録（あれば）。図・組合せ・経路はモデルから導けるので、モデルで読む |
| `nonformal` | その性質の出所の範囲の対象のファイルと、その性質と出所の要素の記述（`views/<unit_id>.json`。`nonformal_method` を含む）。モデルは使わない |
| `composition` | 分割、全てのモデル、契約と合成の条件、それらの検査の記録、CLI の照合の記録 |
| 原因の分類（`cause-analyst`、`perspective` は null） | `context.subject` が指す反例・組合せ・問い（問いの本文は `views/<unit_id>.json`）と、その出所・モデル・検査の記録 |

どの観点でも読まないもの:

- 作成役の作業記録（`worklog.json`）・返り値（`return.json`）・呼び出しの記録（`calls/`）
- `query` の資料に無い `attempts/` の下のファイルと、`attempts/` の下のディレクトリの一覧
- 作成の過程の会話・推論、他の独立検証者の返り値

- 作成側の記録を読むと、作った者と同じ前提で同じ箇所を見落とす。`query` の資料に作成側の作業記録（`worklog.json`）・返り値（`return.json`）か `attempts/` の下のディレクトリが入っていたら、読まずに作業記録の `failures` に「独立した確認に使えない資料が渡された」と `ref` を書く。`attempts/` の下のファイルの資料（モデル・対応表・query など）は読む。
- 成果物を直さない。直すのは作成役の作り直しで、検証者が直すと、確かめた物と保存された物が別になる。

## 成功に読み替えない・秘密値・限界

- 未実行・`unknown`・時間切れ・実行失敗・確認できず・読めない資料を、成り立つ・満たすと書かない。結果を決める CLI が、担当の文を成功の根拠にしてしまう。
- 打ち切った作業・読み切れなかった範囲は、`failures`・`unconfirmed`・`unreadable_inputs` に書く。黙って打ち切ると「全て見た」と読まれる。
- 秘密値（鍵・token・パスワード）を成果物・作業記録・返り値に書かない。CLI の走査が検出するのは [CLI 契約](cli-contract.md#run-の領域の配置) の 4 つの型だけで、それ以外の形は見逃す。対象のファイルの中にある秘密値を引用しない。
- 限界: 担当の書込み範囲と読む範囲は、ホストの権限では分けていない（`workspace-write`）。この文書の義務だけが守りで、CLI は登録の前の書換えを見つけられない。範囲（`spans`）の外を読まない義務も、CLI は機械では止めない（`query` が拒むのは資料の外の ref だけで、範囲の外の行を読むことは止められない）。この 2 つの限界は、受け付けた run の結果の `unverified[]` に `担当の書込み範囲`・`担当の読む範囲` として載る。
