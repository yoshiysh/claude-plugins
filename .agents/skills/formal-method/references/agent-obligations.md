# 担当の共通の義務

formal-method の CLI（`run-daemon`）が出す task で起動される全ての担当が守る項目。各担当の指示（`agents/<role>.md`）は、役ごとの境界・観点・返り値を持つ。形と値の正本は [成果物の形式](artifact-formats.md)、手順と配置の正本は [CLI 契約](cli-contract.md) で、ここには写さない。

## 目次

- [受け取るもの](#受け取るもの)
- [書く場所と返し方](#書く場所と返し方)
- [作業記録](#作業記録)
- [作成役の禁止](#作成役の禁止)
- [独立検証者の読む範囲](#独立検証者の読む範囲)
- [成功に読み替えない・秘密値・限界](#成功に読み替えない秘密値限界)

## 受け取るもの

prompt は `task.md` の絶対 path を指す。`task.md` は次の 4 つの見出しを持つ（[task の一覧](artifact-formats.md#task-の一覧)）。

| 見出し | 中身 | 使い方 |
|---|---|---|
| `ROLE` | 担当の指示ファイルと、この文書の絶対 path | 両方を読む |
| `TASK` | `Task` から `prompt` を除いた JSON | `task_id`・`role`・`attempt_dir`・`return_path` と `context`（`TaskContext`）を読む |
| `RETURN_SCHEMA` | 返り値の JSON Schema | 返り値をこの形にする |
| `WRITE` | 書いてよい領域、返り値の path、最後の応答の形 | 書く場所をここに限る |

- 読む資料は `context.input_refs` が指すものだけである。`ref` は `context.run_dir` からの相対 path。ディレクトリを指す `ref`（対象の写しなど）は、その下のファイルを読んでよい。
- `context.revise_defects_ref` が null でなければ、CLI が見つけた欠陥の一覧である。同じ役の作り直しとして、その欠陥を直す。
- 語と値は仕様（`docs/specifications/formal-method.md`）と [形式手法の知識](formal-method-knowledge.md) に従う。一般の形式手法の語で置き換えると、CLI の照合と結果の値が食い違う。

## 書く場所と返し方

- 書くのは `attempt_dir` の中だけである。run の状態（`state.json`・`status.json`）・台帳（`ledger.json`）・他の担当の `attempts/`・対象には書かない。台帳は CLI だけが書く（PR-BPDESIGNEDSKILL-030）。`attempt_dir` の外に書いたものは成果物として登録されない。
- 自分が書く全ての `Ref`（`outputs[].ref`・`record_ref`・`worklog_ref`・`query_ref`・`input_refs` など）は、`context.run_dir` からの相対 path で、`attempts/<task_id>/` で始まるか、task が渡した資料を指す。
- 返り値は `RETURN_SCHEMA` の形の JSON を `return_path` に書く。返り値の `task_id` は `TASK` の値、`unit_id` は `context.unit_id`、`perspective` は `context.perspective` をそのまま使う。値が違う返り値は成功に数えられない。
- 最後の応答は `{"task_id": ..., "return_path": ...}` だけにする。CLI は応答ではなく `return_path` を読むので、応答に本文や結論を入れても使われない。
- 長い作業は、書き終えた部分からファイルに書く。期限（CLI 契約の `AGENT_BATCH_DEADLINE_MS`）までに返り値が無い担当は欠測になる。期限内に `return_path` を書いても、その batch が拒否されれば（期限の後に受け箱が読まれた、`timed_out` など）成功に数えられない。そのため、期限より前に返り値を書き終える（条件の正本は [CLI 契約の受け箱](cli-contract.md#受け箱) と [成果物の形式の担当の返り値](artifact-formats.md#担当の返り値)）。

## 作業記録

`attempt_dir` の `worklog.json` に書き、返り値の `worklog_ref` で指す。形は [作業記録](artifact-formats.md#作業記録) の `Worklog`、欄は PR-BPDESIGNEDSKILL-028 の 9 項目である。

| 欄 | 書くもの |
|---|---|
| `role`・`task_id` | `TASK` の `role` と `task_id` |
| `stage` | `context.stage` |
| `target` | 対象（`context.target_id`、`model_id`、`unit_id` など、この task が扱うもの） |
| `inputs` | 読んだ資料ごとの `{ref, hash}`。ディレクトリを指す `ref` は、実際に読んだファイルごとに 1 要素 |
| `actions`・`results`・`grounds` | したこと、得たこと、その根拠 |
| `failures`・`unconfirmed` | できなかったこととその理由、確かめられなかったこと |
| `unreadable_inputs` | 読めなかった資料と理由 |
| `document_rules` | 適用した文書の一般規約の写しの `ref` と `version` |

- `hash` と `version` は、ファイルのバイト列の SHA-256 を `"sha256:"` に続けた値である。次の command で求める（`shasum` の無い環境があり、CLI の動く環境には node が必ずある）。推測で書いた指紋は、CLI の再読込の照合に通らない。

  ```bash
  node -e 'console.log("sha256:"+require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' <ファイルの絶対 path>
  ```
- `document_rules.ref` は、`context.input_refs` の中の `document-rules/` で始まる `ref` とする。無ければ `<run_dir>/document-rules/` の中のファイルを使う。
- 文の欄は、その写しの規約（平易な文と具体的な条件、値は正本を参照）に従って書く（PR-BPDESIGNEDSKILL-033）。
- model・effort・権限・渡した資料の指紋は CLI が台帳に書く。担当はそれらを作業記録に正本として書き直さない（PR-BPDESIGNEDSKILL-032）。

## 作成役の禁止

対象: `extractor`・`model-author`・`partition-author`・`plan-author`。

- 自分の成果物を「確認した」「検証した」と書かない。確認は独立検証者と CLI の役であり、作った者の確認を数えると独立した確認の定義（仕様の用語定義）が崩れる。
- 検証の道具（`z3` など）を実行しない。道具の実行は CLI が時間の上限と同時実行の数の下で行い、証拠として保存する。担当が実行した結果は記録に残らず、判定にも使われない。指紋を求める node の command は検証の道具ではない。
- 判断が要る不足は、推測で埋めずに問い（`Question`）として返す。回答に依存しない部分は作り続け、依存する性質の id を `blocked_by_question` に入れる。書かれている遷移・条件を問いに変えない（それは要求の不足ではなく、読み落としである）。

## 独立検証者の読む範囲

対象: `extraction-reviewer`・`fidelity-reviewer`・`assurance-reviewer`・`composition-reviewer`・`cause-analyst`。

読むのは `context.input_refs` が指す資料だけである。次の表は観点ごとに渡される資料の種類で、読む集合を広げる根拠にはならない。CLI が `input_refs` に入れる具体の ref の正本は [成果物の形式の task の一覧](artifact-formats.md#task-の一覧) の「独立検証者と原因の分類役の `input_refs`」である。

| 観点（`perspective`） | 読むもの |
|---|---|
| `extraction` | 対象の固定した写し、固定した inventory、CLI の照合の記録 |
| `fidelity` | 対象の写し、inventory、モデル、対応表、CLI の照合の記録 |
| `assurance` | モデル、対応表、計画、変異、検査と確認の記録 |
| `nonformal` | 対象の写しと、その性質の inventory の記述（`nonformal_method` を含む）。モデルは使わない |
| `composition` | 分割、全てのモデル、契約と合成の条件、それらの検査の記録、CLI の照合の記録 |
| 原因の分類（`cause-analyst`、`perspective` は null） | `context.subject` が指す反例・組合せ・問いと、その出所・モデル・検査の記録 |

どの観点でも読まないもの:

- 作成役の作業記録（`worklog.json`）・返り値（`return.json`）・`task.md`
- `input_refs` に無い `attempts/` の下のファイルと、`attempts/` の下のディレクトリの一覧
- 作成の過程の会話・推論、他の独立検証者の返り値

- 作成側の記録を読むと、作った者と同じ前提で同じ箇所を見落とす。`input_refs` に作成側の作業記録や `attempts/` のディレクトリが入っていたら、読まずに作業記録の `failures` に「独立した確認に使えない資料が渡された」と `ref` を書く。
- 成果物を直さない。直すのは作成役の作り直しで、検証者が直すと、確かめた物と保存された物が別になる。

## 成功に読み替えない・秘密値・限界

- 未実行・`unknown`・時間切れ・実行失敗・確認できず・読めない資料を、成り立つ・満たすと書かない。結果を決める CLI が、担当の文を成功の根拠にしてしまう。
- 打ち切った作業・読み切れなかった範囲は、`failures`・`unconfirmed`・`unreadable_inputs` に書く。黙って打ち切ると「全て見た」と読まれる。
- 秘密値（鍵・token・パスワード）を成果物・作業記録・返り値に書かない。CLI の走査が検出するのは [CLI 契約](cli-contract.md#run-の領域の配置) の 4 つの型だけで、それ以外の形は見逃す。対象の写しの中にある秘密値を引用しない。
- 限界: 担当の書込み範囲と読む範囲は、ホストの権限では分けていない（`workspace-write`）。この文書の義務だけが守りで、CLI は登録の前の書換えを見つけられない。この限界は結果の `unverified[]` に載る。
