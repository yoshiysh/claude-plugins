# CLI 契約

`scripts/formal-method-cli.mjs` の外から見える入出力と手順の正本。データの形（依頼・結果・成果物・記録）は [成果物の形式](artifact-formats.md) が正本で、ここでは名前で参照する。振る舞いの要求の正本は仕様 `docs/specifications/formal-method.md`（以下 SP-NNN と略す）で、この文書はその実現の約束だけを持つ。

テストの担当は、この文書と [成果物の形式](artifact-formats.md) と仕様だけで、テストを作れる。

## 目次

- [呼び方と入力の口](#呼び方と入力の口)
- [コマンド](#コマンド)
- [誤りと終了コード](#誤りと終了コード)
- [status.json](#statusjson)
- [起動の手順](#起動の手順)
- [受け箱](#受け箱)
- [生死の判定](#生死の判定)
- [salvage の手順](#salvage-の手順)
- [結果と台帳の保存の失敗](#結果と台帳の保存の失敗)
- [run の領域の配置](#run-の領域の配置)
- [構造の契約](#構造の契約)
- [Z3 の adapter](#z3-の-adapter)
- [定数](#定数)

## 呼び方と入力の口

```bash
node <SKILL_DIR>/scripts/formal-method-cli.mjs <command> < input.json
```

- 引数・標準入力・標準出力の規則（次の 2 項目と[誤りと終了コード](#誤りと終了コード)）は、[コマンド](#コマンド)の表の 4 つのコマンドに当てる。`run-daemon` の引数と標準入出力は、この節の最後の項目に従う。
- `<command>` は 1 語。入力は標準入力の 1 つの JSON で渡す。引数で値を渡さない。
- 出力は標準出力の 1 行の JSON。標準エラーは診断だけに使い、契約に含めない。
- **入力の口は、各コマンドの標準入力の JSON だけ**である。検証の内容を決める入力は、`start` の `request`（依頼。SP-001）だけで、他のコマンドの入力は CLI が前に返した値である。
- 環境変数は入力の口にしない。CLI が読む環境の値は次の 2 つだけで、どちらも依頼の内容を変えない。
  - `PATH`: 道具（`z3`）の実行体を探す。SP の検証方法の節の「実行環境に置く道具を差し替えて行う」の、実行環境そのものである。テストは `PATH` の先頭に偽の道具を置いて差し替える。専用の環境変数（旧版の道具の path の変数など）は持たない。理由: 専用の口は外の依頼元からも使えてしまう。
  - `CI`: 有無を `performance.location` に記録するだけで、振る舞いを変えない。
- 作業ツリー（workspace）は、`start` を呼んだ process の現在のディレクトリとする。入力に含めない。
- `run-daemon` は `start` が起動する内部のコマンドで、司令塔もテストも直接呼ばない。
  - argv は、コマンド名 `run-daemon`・`run_id`・nonce・一時の領域（`.tmp-<run_id>-<nonce>/`）の絶対 path の 4 つちょうどで、値は全て `start` が自分で作ったものである。
  - 依頼は一時の領域の `request.input.json` からだけ読む。標準入力は読まない。
  - `start` は、`run-daemon` の標準入力・標準出力・標準エラーを、自分のものにも pipe にも繋がずに起動する（3 つとも捨てる）。`run-daemon` が client に返すものは、全て `status.json` と [run の領域の配置](#run-の領域の配置)のファイルを通る。
  - 理由: `start` の出力の 1 行の JSON に `run-daemon` の出力が混ざらない。また、`start` から継いだ pipe の書き端を `run-daemon` が開いたままにすると、`start` を呼んだ側が pipe の close を待ち、`run-daemon` が終わるまで `start` の呼出しが返らない。

## コマンド

| コマンド | 標準入力 | 標準出力（成功） |
|---|---|---|
| `start` | `{"request": <Request>}` | `{"ok": true, "command": "start", "status": <Status>}` |
| `submit` | `{"run_dir": string, "batch_id": Id, "workflow_output_path": string}` 又は `{"run_dir": string, "batch_id": Id, "timed_out": true}`（`Id` は [成果物の形式の共通の型](artifact-formats.md#共通の型)の文字。合わなければ `E_INPUT` の `shape`。理由: `batch_id` は受け箱の file 名になるので、path の区切りを含めない） | `{"ok": true, "command": "submit", "outcome": "accepted" \| "duplicate"}` |
| `wait` | `{"run_dir": string, "status_seq": integer ≥ 0}` | `{"ok": true, "command": "wait", "status": <Status>}`（新しい `seq`）又は `{"ok": true, "command": "wait", "outcome": "still_waiting", "status_seq": integer}` |
| `salvage` | `{"run_dir": string}` | `{"ok": true, "command": "salvage", "status": <Status>}`（`action` は常に `terminal`） |

- `<Request>`・`<Result>` の形は [成果物の形式](artifact-formats.md#依頼request) と [結果](artifact-formats.md#結果result)。
- `<Status>` は [status.json](#statusjson) と同じ形。
- 依頼の不足・不備（SP-001）は誤りではなく、`status.action: "terminal"` の `停止` の結果として返す（終了コード 0）。誤り（[誤りと終了コード](#誤りと終了コード)）は、コマンドの入力そのものが壊れているときだけである。
- `start` の手順は [起動の手順](#起動の手順)、`submit` は [受け箱](#受け箱)、`salvage` は [salvage の手順](#salvage-の手順)。
- `wait`: `status.json` の `action` が `terminal` なら、`seq` によらずその `Status` をすぐ返す。そうでなければ、`status.json` の `seq` が入力の `status_seq` より大きくなるか、[生死の判定](#生死の判定)で `run.lock` の保持者が終わったと分かるまで、`WAIT_LIMIT_MS` を上限に `WAIT_POLL_MS` の間隔で待つ。保持者が終わり、`status.json` の `action` が `terminal` でなければ、`E_STALE` を返す。何も書かない。
  - `status.json` が無い、ファイルでない、JSON でない、`Status` の形に合わない場合は、`seq` が増えていないものとして扱う。その間に保持者が終われば `E_STALE` を返し、保持者が生きていれば待ち続ける（上限で `still_waiting`）。理由: `start` が `seq: 0` の `working` を返した直後は、`status.json` がまだ無い。rename で書くので書きかけは見えず、壊れた `status.json` は保持者が次に書くときに置き換わる。
  - `still_waiting` は `liveness: "alive" | "unknown"` を持つ。`unknown` は、保持者の開始時刻を読めず生死を判定できなかったことを表す（[生死の判定](#生死の判定)）。
- 全てのコマンドは、前景の 1 回の呼出しを `CALL_MAX_MS` 以内に終える。待つのは `CALL_MAX_MS` − `CLEANUP_BUDGET_MS` までで、残りを後始末と出力に使う。

## 誤りと終了コード

| 終了コード | 意味 | 標準出力 |
|---|---|---|
| 0 | 成功 | 上の表 |
| 1 | 拒否 | `{"ok": false, "command": string, "code": <code>, "reason": string, "detail": object \| null}` |
| 2 | 契約の誤り | `{"ok": false, "code": "E_CONTRACT", "reason": string}` |

| code | 当たるとき | 作用 |
|---|---|---|
| `E_CONTRACT` | 未知のコマンド、引数が 1 つでない、標準入力が JSON でない | 何も書かない |
| `E_INPUT` | コマンドの入力の JSON が上の表の形に合わない（`run_dir` のキーが無いか文字列でない場合を含む）、又は `run_dir` のディレクトリが無い。`detail` は `{"reason": "shape" \| "run_dir_not_found"}` | 何も書かない |
| `E_BUSY` | `salvage` か、`start` が起動の手順の 5-1 で salvage と同じ規則を当てたときに、`run.lock` の保持者（役 `run-daemon`）か `salvage.mark` の勝者（役 `salvage`）が生きているか、生死を判定できない。`detail` は `{"holder_role": "run-daemon" \| "salvage", "liveness": "alive" \| "unknown", "run_dir": string}` | 何も書かない |
| `E_STALE` | `wait` で、`run.lock` の保持者が終わったが、`status.json` が `terminal` でない | 何も書かない |
| `E_INTERNAL` | CLI の処理が予期しない誤り（捕まえていない例外。I/O の誤りを含む）で続けられない。`detail` は `null`。終了コードは 1 で、標準出力は上の拒否の形の JSON 1 つ | それまでに済ませた作用は取り消さずに残りうる。run の結果は作らない |
| `E_RESULT_UNREADABLE` | `result.json` が公開されているが、読めないか [結果](artifact-formats.md#結果result)の形に合わない。場面は次の全て: `salvage` の規則 2、`start` の 5-1、`run-daemon` と salvage の結果の公開の負け（`lost_unreadable`）、追補台帳の公開の失敗の後の確かめ、自分の link の後の再読込で中身が違い形に合わない場合（`reread_mismatch`）。`detail` は `{"run_dir": string, "path": string}` | この誤りを返すと決めた後は何も書かない。ただし公開の負け・追補台帳の公開の失敗の後の確かめ・`reread_mismatch` の場面では、それまでに済ませた作用（`salvage.mark`・`salvage-worklog.json`・追補台帳の公開、子の process group の停止、自分の `result.json` の link）は取り消さずに残る。run の結果はそのファイルだけで、別の結果を作らない |

拒否は作用の前に起こる。拒否で run の状態は変わらない。例外は `E_RESULT_UNREADABLE` と `E_INTERNAL` である。`E_RESULT_UNREADABLE` の、公開の負け・追補台帳の公開の失敗の後の確かめ・`reread_mismatch` の場面では、上の表のとおり先に済ませた作用が残る。理由: 結果の公開を試すまで、既にある結果が読めないことは分からない。`E_INTERNAL` は、予期しない誤りがどの作用の後に起きるかを前もって決められないので、それまでの作用が残りうる。終了コードを 0・1・2 の閉じた集合に保つため、捕まえていない例外も 1 つの JSON で返す。

司令塔の対応の正本は SKILL.md である（各 code と出力が JSON でないときは [誤りと止まり方](../SKILL.md#誤りと止まり方)、仮の結果の提示は [結果の提示](../SKILL.md#結果の提示)、timeout の明示は [CLI の呼び方と timeout](../SKILL.md#cli-の呼び方と-timeout)）。

## status.json

`run-daemon` だけが書き、rename で置き換える。client はこれと `run.lock` だけを読む。

```text
Status = {
  "seq": integer ≥ 0,          // run-daemon が書くたびに 1 増える（1 から）。start が自分で作った Status だけ 0
  "run_dir": string | null,    // 絶対パス。start が run の領域の無いまま返す terminal だけ null
  "action": "run_agents" | "working" | "terminal",
  "batch": Batch | null,       // action が run_agents のときだけ非 null
  "result": Result | null,     // action が terminal のときだけ非 null
  "daemon": Identity | null    // run.lock の保持者の識別。start が返す terminal（run の領域が無い場合）では null
}
Batch = { "batch_id": string, "tasks_path": string, "deadline_wall_ms": integer, "workflow_script": string }
Identity = { "pid": integer, "started_at": string, "nonce": string }
```

- `started_at` は OS が報告する process の開始時刻の文字列（`ps -o lstart=` を `LC_ALL=C` で読んだ値の前後の空白を除いたもの）。比べるときも、読んだ値の前後の空白を除いてから比べる。
- `action: "run_agents"`: 司令塔は担当を起動し、返ったら、又は `deadline_wall_ms` を過ぎたら、`submit` を呼ぶ。起動する script と args の正本は SKILL.md の [担当の起動](../SKILL.md#担当の起動) で、司令塔は起動に `workflow_script` の値を使わない。
- `action: "working"`: 司令塔は `wait` を呼ぶ。
- `action: "terminal"`: `result` が結果の正本で、司令塔はそれを提示する。保存できたかは `result.records` が示す。

## 起動の手順

`start` は依頼を検査しない。依頼の検査・対象の取得・版の照合・写しの保存は、全て `run-daemon` が同じバイト列で行う。理由: 照合したバイト列と保存する写しを同じ process が同じ読み込みで扱えば、その間に内容が変わる余地が無い。また、受付で止めた run の記録も、`run-daemon` が lock の下で保存できる。

1. **入力の形**: 標準入力が `{"request": <JSON の値>}` の形か（`request` があるか）だけを見る。無ければ `E_INPUT`。`request` の中身は見ない。
2. **保存先の能力の確認**: 保存先の root（`<workspace>/.formal-method/runs/`）に一時のディレクトリ（名前は `.probe-<nonce>/`。`.tmp-*` とは別の形）を作り、ファイルの書込み・fsync・ディレクトリの fsync を試し、作ったものを消す。
   - できなければ、`run-daemon` を起動せずに、受付の段の `停止` の結果を返す（`run_dir: null`、`seq: 0`、`daemon: null`）。停止の理由は `保存の失敗`。`records.saved` は空、`records.unsaved` に結果のファイル自身を含む全ての記録と理由を載せる（AC-13）。
3. **起動**: `run_id`（UTC の時刻と乱数）と nonce を作る。`.tmp-<run_id>-<nonce>/` を作り、`request` を `request.input.json` に書いて fsync する。書く直前に[秘密値の走査](#run-の領域の配置)の型で走査し、見つかれば書かずに一時の領域を消し、`run-daemon` を起動せずに受付の段の `停止` の結果を返す（`run_dir: null`、`seq: 0`、停止の理由は `保存の失敗`、`records.unsaved` に依頼と全ての記録）。`request.input.json` の書込みか fsync が I/O の誤りで失敗したときも同じく、一時の領域を消し、`run-daemon` を起動せずに同じ形の受付の段の `停止` の結果を返す（停止の理由は `保存の失敗`）。`run-daemon` を detach（新しい session と process group）で、標準入出力を繋がずに起動し、引数に `run_id`・nonce・一時の領域の path を渡す（[呼び方と入力の口](#呼び方と入力の口)）。起動した process の pid と開始時刻を控え、その終了を親として観測する。
4. **`run-daemon` の作成**: `run-daemon` は一時の領域に `run.lock` を排他作成し、`<run_id>/` へ rename する。その後に最初の `status.json`（`seq: 1`）を書く。依頼の検査（[依頼](artifact-formats.md#依頼request)）はその後に行い、受け付けない依頼なら受付の段の `停止` の結果を、通常の保存（[結果と台帳の保存の失敗](#結果と台帳の保存の失敗)）で保存して返す。
5. **待つ**: `start` は `START_WAIT_MS` を上限に、次を順に評価する。
   1. 起動そのものに失敗したか、起動した process が終わったと観測した。
      - `<run_id>/` があれば、[salvage の手順](#salvage-の手順)と同じ規則で結果を作って返す。規則が `E_BUSY` になれば、`start` は `E_BUSY`（`detail.run_dir` 付き）を返す（終了コード 1）。
      - 無ければ、受付の段の `停止` の結果を返す（`run_dir: null`、`seq: 0`、`daemon: null`）。停止の理由は `起動の失敗`。`records.unsaved` に全ての記録を載せる。
   2. `<run_id>/` と `status.json` が現れたら、その `Status` を返す。
   3. `START_WAIT_MS` に達したとき:
      - `<run_id>/run.lock` があれば、`{"seq": 0, "action": "working", "run_dir": ..., "batch": null, "result": null, "daemon": <run.lock の識別>}` を返す。司令塔は `wait`（`status_seq: 0`）に進む。
      - 無ければ、控えた識別と一致する process の group を止め（SIGKILL）、終了を `START_STOP_WAIT_MS` まで待ってから 1 を評価し直す。その間に終了を観測できなければ、終わったものとして 1 を評価し直す。ただし一時の領域は消さず（終了を観測していないので、6 の規則による）、返す結果の `unverified[]` に一時の領域の path と理由「run-daemon を止めたが終了を観測できなかった」を載せる。理由: SIGKILL は拒めないので process は終わるが、終了の観測を待ち続けると、前景の呼出しが `CALL_MAX_MS` を越える。
6. **残った一時の領域**: `start` は、自分が起動して終了を観測した process と、起動そのもの（spawn）に失敗した process の `.tmp-<run_id>-<nonce>/` だけを消す。他の `.tmp-*` は消さない。消せなければ、返す結果の `unverified[]` に path と理由を載せる。

`run-daemon` を起動しないで `start` が返す結果（2 と 5-1 の後半）は、保存しない。理由: 保存先に書けないか、run の領域（lock を持つ者の領域）が無いので、書く者がいない。構造の契約「`result.json` を書くのは `run-daemon` だけ」はそのまま成り立つ。

不変: `start` が `seq: 0` の `working` を返すとき、`<run_id>/run.lock` は必ずある。`start` が返す `Status` は 1 つで、`terminal` を返した run について、別の結果が後から公開されることはない。

## 受け箱

- `submit` は、入力を `inbox/.tmp-<nonce>` に書いて fsync し、`inbox/<batch_id>.json` へ link で公開し、一時ファイルを消す。
  - link が既にあれば、何も変えずに `outcome: "duplicate"` を返す。
  - `run_dir` に `status.json` が無いか、`batch_id` が `status.json` の開いている batch と違っても、公開はする。`run-daemon` が読むかは `run-daemon` が決める。
- 受け箱の中身は `{"batch_id": string, "workflow_output_path": string}` 又は `{"batch_id": string, "timed_out": true}`。
- `run-daemon` は、開いている batch の受け箱だけを読む。
  - 次のどれかに当たれば、**batch の拒否**とし、その batch の全ての task の返り値を使わず、成功に数えない。
    - 受け箱を読めない、JSON でない、上の形に合わない、`batch_id` が違う。
    - `timed_out: true` である。
    - `run-daemon` が受け箱を読んだ時刻が `deadline_wall_ms` 以上である。期限との比較は batch につき 1 回、受け箱を読んだ時点だけで行い、各 `return_path` を読んだ時刻とは比べない。
    - 期限（`deadline_wall_ms`）までに受け箱が公開されなかった（`run-daemon` が期限で batch を閉じた）。
    - `workflow_output_path` のファイルを読めないか、その中身が [Workflow の返り値](artifact-formats.md#workflow-の返り値) の形に合わないか、その `batch_id` が開いている batch と違うか、`received` か `results` の task の集合が `tasks.json` と違う。
  - batch の拒否では、その batch の全ての task を、[担当の返り値](artifact-formats.md#担当の返り値)の「成功に数えない」場合として扱う。task ごとに停止の理由 `担当の失敗` を、その task の `context.stage` を段として記録し、`detail` に `batch_id`・`task_id`・拒否の原因を書く。作業記録は task ごとに、その task の `context.stage` の `worklogs/cli-<context.stage>.json` の `failures` に、`batch_id`・`task_id`・拒否の原因を 1 件ずつ書く（段の異なる task を含む batch では、複数の段の作業記録に分かれる）。
    - 理由: 停止の報告の段が、失敗した処理の段と一致する（AC-19）。理由を batch に 1 件でなく task ごとに置くのは、既存の task 単位の `担当の失敗` と段の表（task の `context.stage`）にそのまま乗り、「batch の task は全て同じ段」という契約に無い前提を要らなくするためである。未作成の成果物と `未確認` の項目も task ごとに決まる。
  - 1 batch に受け箱は 1 つだけで、作り直しは受け付けない。
  - 担当の結論は、Workflow の返り値でなく、各 task の `return_path` を `run-daemon` が読んで得る。Workflow の返り値は、起動した task の値の照合にだけ使う。

## 生死の判定

ある識別（`Identity`）の生死は、次の順で決める。

1. `kill(pid, 0)` が「その process は無い」（ESRCH）を返せば、**死んでいる**（確定）。
2. `LC_ALL=C ps -o lstart= -p <pid>` の値が読めて、`started_at` と違えば、**死んでいる**（pid の再利用）。
3. 値が読めて `started_at` と一致すれば、**生きている**。
4. `ps` を実行できないか値を読めなければ、**判定できない**（`liveness: "unknown"`）。生きている側として扱い、何も書かない。

- pid だけでは判定しない（pid の再利用で、終わった process を生きていると誤るため）。
- 判定できない状態が続く場合の終わり方は、司令塔の `LIVENESS_UNKNOWN_MAX` による（[SKILL.md の誤りと止まり方](../SKILL.md#誤りと止まり方)）。
- client（`wait`・`salvage`）が判定に読むのは `run.lock`（保持者の識別）と `status.json` だけである。`salvage` は加えて `salvage.mark`（勝者の識別）を読む。

## salvage の手順

`salvage` は lock を取らず、`state.json`・`status.json`・`ledger.json` を書かない。上から順に評価する。

1. `run.lock` の保持者が生きていれば、`E_BUSY`（`holder_role: "run-daemon"`）を返す。
2. `result.json` があり、再読込して [結果](artifact-formats.md#結果result) の形に合えば、その結果を返す。あるのに読めないか形に合わなければ、`E_RESULT_UNREADABLE` を返す（別の結果を作らない）。`state.json` は判定に使わない。理由: `run-daemon` が結果を公開した直後、`state.json` を書く前に落ちても、公開済みの結果を見落とさない。
3. `status.json` の `action` が `terminal` なら、その `result` を返す（結果を公開できなかった `run-daemon` の結果を、別の結果で置き換えないため）。`status.json` が無い、ファイルでない、JSON でない、`Status` の形に合わない場合は、この規則に当たらないものとして 4 に進む。
4. 自分の識別を `salvage.mark.tmp-<nonce>` に書いて fsync し、`salvage.mark` へ link で公開する。
   - 公開に失敗したら（既にある）、`salvage.mark` の勝者の識別の生死を見る。生きていれば `E_BUSY`（`holder_role: "salvage"`）を返す。死んでいれば 5 に進む。
   - 一時ファイルを I/O の誤りで書けないか、link が「既にある」以外の誤りで失敗したら、5 の 1・2 で結果を作り、それを状態 `停止`・`provisional: true` の R' として公開せずに標準出力で返す。停止の理由に `処理の中断` と `保存の失敗`（段は `集約`）を入れ、`records.unsaved` に作業記録・追補台帳・結果と理由を載せる。
     - 理由: この R' は保存済みの範囲だけから決定的に作るので、この経路の salvage が何度呼ばれても同じ内容になる。あとで領域が書けるようになり、別の salvage が `result.json` を公開したら、それが正の結果になる（仮の結果の規則）。
     - 退けた案: 誤りとして返す。保存先に書けないときも停止の結果を返す SP-014・AC-13 に合わない。
5. 結果を作って公開する。
   1. `children/` の記録のうち、pid と開始時刻が一致して生きている process group を止める。
   2. rename まで終えた記録（`state.json` が数える範囲で、再読込の指紋が一致するもの）だけから、状態 `停止` の結果を作る。停止の理由は `処理の中断`、`stop_report.stage` は `state.json` の最後に確定した段。
      - 結果には、時刻・pid・nonce など、作った者や作った時で変わる値を入れない。キーの順は辞書順に固定する。そのため、勝者でも、勝者が死んだ後に続けた salvage でも、同じ入力から同じ内容の結果ができる。
      - `performance` の salvage の所要時間と run 全体の所要時間は `取得できず` とし、理由を「salvage の結果は作った者と時刻によらない内容にするため、時刻を記録しない」とする。
   3. 作業記録 `salvage-worklog.json` と追補台帳 `salvage-ledger.json` を同じく決定的に作り、[公開の手順](#結果と台帳の保存の失敗)で公開する。
      - **秘密値の走査**: 公開の前に、作業記録・追補台帳・結果の 3 つを[秘密値の走査](#run-の領域の配置)の型で走査する。どれか 1 つに当たれば、3 つとも公開せず（3 と 4 を行わない）、次の R' を標準出力で返す。
        - `status: "停止"`・`provisional: true`。`stop_report.reasons` は、`処理の中断`（2 のとおり）の後に `保存の失敗`（段 `集約`）と `記録の未保存`（段 `集約`）。
        - 中身を持たない: `properties`・`checks`・`models`・`counterexamples`・`causes`・`questions` は `[]`、`confirmations` は両方 `[]`、`decomposition` は分割しなかったときの形、`unverified` は `[{item: "結果の内容", reason}]`、`verified_scope` と `performance` は値を持たない形で理由を持つ。
        - `records.unsaved` に `salvage_worklog`（`salvage-worklog.json`）・`salvage_ledger`（`salvage-ledger.json`）・`result`（`result.json`）と理由。他の記録は、保存済み（指紋が非 null）のものを `saved` に、他を `unsaved` に載せる。ただし、その一覧の `ref` にも型が当たるなら、`saved` は空、`unsaved` は上の 3 つだけにする。
        - 理由: 3 つは互いを参照する（台帳は結果の指紋を、結果は台帳と作業記録の参照を持つ）ので、一部だけを公開すると参照の先が欠ける。中身を持つ R' を返すと、秘密値が標準出力に出る。値は診断にも残さない（上の一般の規則）。`run-daemon` の集約が秘密値で結果を書かないときも、同じ形の R' を `status.json` で返す。
   4. 結果を **`result.json`** に、同じ手順で公開する（`run-daemon` と同じ名前）。既にあれば、既にある結果を読んで返す。
- `run-daemon` は、`state.json`・`status.json`・`result.json`・`ledger.json` を書く直前に毎回 `salvage.mark` を確かめ、あれば何も書かずに終わる。この確認は、生死の判定が誤ったときの作業の重なりを減らすためのもので、結果の一意は次の節の「1 つの名前への公開」で守る。

## 結果と台帳の保存の失敗

**結果は 1 つの名前 `result.json` にだけ公開する**（`run-daemon` も salvage も）。link の排他で勝者が決まるので、生死の判定が誤っても、公開される結果は 1 つである。

- 理由: 前の稿は、`run-daemon` の `result.json` と salvage の `salvage-result.json` の 2 つの名前に公開し、「`salvage.mark` を確かめてから書く」で重ならないようにしていた。生死を誤判定すると、印の確認と書込みの間の隙間で両方が公開され、結果が 2 つになる（形式検証の `lock-misjudge-*`）。1 つの名前への link なら、確認と書込みが 1 つの不可分な操作になる。
- 退けた案: 印の確認を lock で守る。salvage は lock を取らない（保持者が死んでいれば lock は解けず、取れない）ので、守れない。

**公開の手順**（この文書で「公開する」は全てこの手順。`salvage.mark`・受け箱を除く）: 一時ファイルに書いて fsync し、最終の名前へ link で公開し、ディレクトリを fsync し、再読込して指紋を照合する。照合に通って初めて保存できたとする。
- 結果（`result.json`）だけは、link に成功した後は取り消せない（`FsBoundary` に最終の名前を消す操作は無く、構造の契約も消すことを許さない）。そのため link の後の失敗は、下の **link の後の失敗** で扱う。
- link が「既にある」で失敗したら、既にあるファイルを再読込する。
  - 台帳・作業記録: 指紋が公開しようとした内容と同じなら成功とみなす（決定的に作った salvage の記録を 2 つの salvage が公開した場合）。違えば、その公開は失敗とする。
  - 結果（`result.json`）: 中身によらず**負け**とする。負けた側は自分の結果を捨て、既にある結果を読んで返す（`run-daemon` は `status.json` の `terminal` にそれを入れる）。既にある結果を読めないか形に合わなければ、新しい結果を作らずに `E_RESULT_UNREADABLE` を返す（`run-daemon` は `status.json` を書かずに終わる）。
- `salvage.mark` と受け箱は、既にあれば常に失敗とする（勝者と受け箱は 1 つだけ）。

**link の後の失敗**（結果。依頼者の決定: 残った `result.json` を正の結果とし、結果を常に 1 つにする。salvage の規則 2 と揃える）
- ディレクトリの fsync か再読込が I/O の誤りで失敗した: 残った R を正の結果とする。R は作り直さず、中身も変えない。`run-daemon` は R を `status.json` の `terminal` に入れ、salvage は R を標準出力で返す。
- 再読込に成功したが、指紋が R と違う（corrupt）: 負けと同じに扱う。読んだ中身が [結果](artifact-formats.md#結果result) の形に合えばそれを返し、合わなければ `E_RESULT_UNREADABLE`（`run-daemon` は `status.json` を書かずに終わる）。理由: その名前にあるバイト列は R でなく、R を保存できたとは示せない（SP-014）。名前にあるファイルだけを結果とすれば、salvage の規則 2 と同じ結果になる。
- 失敗した fsync・再読込は、記録（結果・台帳・作業記録）に残さない。理由: 台帳と作業記録は結果より前に公開済みで、R も link 済みなので、書き足すと台帳の指紋か R の中身が変わり、結果が 2 つになる。失敗は `publishResult` の返り値の `fault` だけに現れる。この限界（R の `records.saved` が、fsync か再読込を終えていない `result.json` を含むこと）は、依頼者の決定として受け入れる。

**台帳**: 台帳は結果より先に公開する。`run-daemon` は `ledger.json`、salvage は `salvage-ledger.json`。どちらも「登録した結果の指紋」を持つが、それは結果のファイルが保存されたことを示さない。`result.json` に負けた側の台帳は、公開されない結果の指紋を持ったまま残る。今の結果を登録した台帳は、`result.json` の `records.ledger_refs` が示す。
- salvage の追補台帳の公開が「既にあって指紋が違う」で失敗したら、`result.json` を確かめ、あって形に合えばそれを返す。あるのに読めないか形に合わなければ `lost_unreadable`（`E_RESULT_UNREADABLE`）とする。無ければ下の表の「台帳が失敗」の行のとおりに扱う。

**結果の中の参照**: 結果は、自分自身のファイルと台帳を `records.saved` か `records.unsaved` に参照（path）だけで持ち、指紋を持たない。他の記録は参照と指紋を持つ。

**状態を決める順序**（SP-015 の「記録を全て保存した」）:
1. 集約の段は、台帳と結果の公開が成功すると仮定して、完了の条件を評価し、結果 R を作る。
2. 台帳を公開し、次に R を `result.json` に公開する。
3. どちらかに失敗したら（負けと、結果の link の後の失敗を除く）、R を捨てる。下の表の `records` で、状態を `停止`、`provisional: true`、停止の理由に `保存の失敗`（段は `集約`）と `記録の未保存` を入れた結果 R' を作り直す。R' は公開しない（公開できなかったので）。`run-daemon` は R' を `status.json` の `terminal` で返し、salvage は標準出力で返す。
- そのため、`status.json` の `terminal` に `完了` が出るのは、R の `result.json` への link に成功したときだけである。

| 台帳の公開 | 結果の公開 | `result.json` | 返す結果 |
|---|---|---|---|
| 成功 | 成功 | R を公開 | R（`saved` に台帳と結果の参照） |
| 成功・失敗 | 負け | 既にある結果 | 既にある結果 |
| 成功 | link の前で失敗（一時ファイルの書込み・link の `EEXIST` 以外の誤り） | 無い | R'（`停止`。`saved` に台帳の参照、`unsaved` に結果と理由） |
| 成功 | link の後で fsync か再読込が I/O の誤り | R が残る | R |
| 成功 | link の後の再読込で指紋が違う | 違う中身が残る | 負けと同じ（形に合えばその中身、合わなければ `E_RESULT_UNREADABLE`） |
| 失敗 | 試さない | 無い | R'（`停止`。`unsaved` に台帳と結果と理由） |

- 「台帳の公開が失敗」の行では、結果の公開を試さない。ただし salvage の追補台帳が「既にあって指紋が違う」で失敗した場合は、上のとおり先に `result.json` を確かめる。

**`status.json` は記録に数えない**。`status.json` は `run-daemon` から client への受け渡しの口で、`records`・台帳・`RecordKind` に入らない。書けなければ、`run-daemon` はそれ以上何も書かずに終わる。client の `wait` が `E_STALE` を観測し、salvage が規則 2（`result.json` があればそれ）か規則 5 で結果を返す。

**仮の結果と正の結果**（依頼者の決定）: 公開されずに返った R'（`provisional: true`）は、記録を保存できなかった仮の結果である（[成果物の形式](artifact-formats.md#結果result)）。あとで同じ run の `result.json` が公開されたら（別の salvage が保存に成功した場合など）、それが run の結果で、仮の結果はそれに置き換えられる。公開される `result.json` は常に 1 つである。仮の結果を受け取った者は、`<run_dir>/result.json` を読めば正の結果を得られる。

## run の領域の配置

保存先の root は `<workspace>/.formal-method/runs/` である。消す手順は持たない（利用者が消すまで残す。PR-034）。

| path（root から） | 書く者 | 中身 |
|---|---|---|
| `index/<run_id>.json` | `run-daemon` | `{"run_id", "run_dir", "created_stage": "受付"}`。過去の run を辿る索引（PR-038） |
| `.tmp-<run_id>-<nonce>/` | `start`（作成）、`run-daemon`（`run.lock`） | rename の前の一時の領域。run としても結果としても扱わない |
| `<run_id>/run.lock` | `run-daemon`（排他作成） | `{"pid", "started_at", "nonce", "role": "run-daemon"}` |
| `<run_id>/state.json` | `run-daemon`（rename） | 内部の状態。形は契約の外で、client と salvage は保存済みの範囲を知るためだけに読む（結果の有無の判定には使わない） |
| `<run_id>/status.json` | `run-daemon`（rename） | `Status` |
| `<run_id>/request.json` | `run-daemon` | 受け付けた依頼の正規形（[依頼](artifact-formats.md#依頼request)） |
| `<run_id>/targets/<target_id>/files/<FilePath>` と `<run_id>/targets/<target_id>/manifest.json` | `run-daemon` | 対象の集まりの固定した版の写し（ファイルごとのバイト列）と、`fixed.files` と同じ一覧 |
| `<run_id>/document-rules/<指紋>.md` | `run-daemon` | 適用した文書の一般規約の不変の写し |
| `<run_id>/inbox/<batch_id>.json` | client（link） | [受け箱](#受け箱) |
| `<run_id>/batches/<batch_id>/tasks.json` | `run-daemon` | [task の一覧](artifact-formats.md#task-の一覧) |
| `<run_id>/attempts/<task_id>/task.md` | `run-daemon` | 担当への指示の全文 |
| `<run_id>/attempts/<task_id>/return.json` | 担当 | [担当の返り値](artifact-formats.md#担当の返り値) |
| `<run_id>/attempts/<task_id>/worklog.json` | 担当 | [作業記録](artifact-formats.md#作業記録) |
| `<run_id>/attempts/<task_id>/<成果物>` | 担当 | 返り値の `outputs` が指すファイル |
| `<run_id>/worklogs/cli-<段>.json` | `run-daemon` | 決定的な処理の作業記録（担当 `cli`） |
| `<run_id>/checks/<execution_id>/{input.smt2,stdout.txt,stderr.txt,end.json}` | `run-daemon` | 道具の実行ごとの証拠。`execution_id` は、検査なら `Check.id`、道具を実行した確認（sanity・mutation・replay）なら `Confirmation.id` で、`Performance.executions[].id` と同じ値（実行と確認の id は 1 つの名前空間）。`end.json` は [終わり方](artifact-formats.md#検査の終わり方end) |
| `<run_id>/children/<pgid>.json` | `run-daemon` | `{"pgid", "started_at"}`。道具の process group の記録 |
| `<run_id>/ledger.json` | `run-daemon` | [記録台帳](artifact-formats.md#記録台帳) |
| `<run_id>/result.json` | `run-daemon` か salvage（link。先に公開した方だけ） | [結果](artifact-formats.md#結果result)。run の結果の正本 |
| `<run_id>/report.md` | `run-daemon` | 結果から導いた人向けの表示 |
| `<run_id>/salvage.mark` | salvage（link） | `Identity` |
| `<run_id>/salvage-ledger.json` | salvage（link） | [記録台帳](artifact-formats.md#記録台帳)の追補 |
| `<run_id>/salvage-worklog.json` | salvage（link） | salvage の [作業記録](artifact-formats.md#作業記録)（`role: "salvage"`、`stage: "集約"`、時刻を含まない） |
| `.tmp-<run_id>-<nonce>/request.input.json` | `start` | `start` が受け取った `request` の値そのまま。`run-daemon` だけが読む |

- 記録は全て、一時ファイル・fsync・rename（又は link）・ディレクトリの fsync で書く。同じ path を別の内容で上書きしない（`state.json`・`status.json` を除く）。
- **秘密値の走査**（依頼者の決定）: formal-method が書く記録（依頼の写し、担当の返り値・成果物（担当が書いた `.smt2` を含む）・作業記録、確認の記録、道具に渡す query（全ての実行の `checks/<execution_id>/input.smt2`。CLI が証人から作る replay の query（[証人](#証人)）を含む）、道具の標準出力・標準エラー、作業記録、台帳、結果、表示）は、書く直前に下の型で走査する。見つかれば書かずに、その記録を保存できなかったもの（`records.unsaved`、停止の理由 `保存の失敗`）として扱い、値は診断にも残さない（型と行の番号だけ）。
  - 対象の写し（`targets/`）は走査しない。理由: 利用者の作業ツリーに既にある内容で、写しによって新しく露出するものではない。
  - 型は誤検知の少ないものだけに絞り、次の閉じた集合とする。この集合に無い形は検出しない。

    | 型 | 形（正規表現） |
    |---|---|
    | `private_key` | `-----BEGIN (RSA \|EC \|DSA \|OPENSSH \|PGP \|ENCRYPTED )?PRIVATE KEY-----` |
    | `aws_access_key_id` | `\b(AKIA\|ASIA)[0-9A-Z]{16}\b` |
    | `github_token` | `\bgh[pousr]_[A-Za-z0-9]{36,}\b` |
    | `slack_token` | `\bxox[abprs]-[A-Za-z0-9-]{10,}\b` |

  - 理由: `password=` の代入や汎用の接頭辞（`sk-` など）は誤検知が多く、正しい記録まで保存できなくなる。
- 担当は自分の `attempts/<task_id>/` の中にだけ書く。その外に書いたものは、成果物として登録されない。

## 構造の契約

実装の構造で守る約束。テストはソースの走査と並行の結合テストで確かめる。

- 最終の名前の run の領域の `<run_id>/run.lock` を消す呼出しは、`scripts/lib/store.mjs` の関数 `releaseOwnLock` の中にだけある。`releaseOwnLock` は、`run.lock` の `nonce` が自分のものと一致することを確かめた後にだけ消す。他のどこにも、`<run_id>/run.lock` を消す・上書きする呼出しは無い。
- 一時の領域 `.tmp-<run_id>-<nonce>/` を最終の名前へ rename する呼出しは、`scripts/lib/store.mjs` の関数 `publishRunDir`（`run-daemon` だけが呼ぶ）の中にだけある。rename されるのは領域のディレクトリで、`run.lock` は領域ごと移る。
- `.tmp-*` を消す呼出しは、`scripts/lib/start.mjs` の関数 `removeOwnTmp` の中にだけある。`removeOwnTmp` は、自分が作った `run_id` と nonce の領域を、次のどれかの場面でだけ消す: (1) 自分が起動した process の終了を観測した後、(2) `request.input.json` に秘密値の型を見つけ、`run-daemon` を起動していないとき、(3) `request.input.json` の書込みか fsync が失敗し、`run-daemon` を起動していないとき、(4) `run-daemon` の起動そのもの（spawn）が失敗したとき（起動の手順 5-1 の「起動そのものに失敗した」）。
- `.probe-*` を消す呼出しは、`scripts/lib/start.mjs` の関数 `removeProbeDir` の中にだけある（能力の確認の後）。この領域は rename されていない（最終の名前の run の領域ではない）ので、その中の `run.lock` は上の `<run_id>/run.lock` に当たらない。
- 走査の検査は、この 4 つの関数名と file の組で、lock・一時の領域を消す・rename する呼出しの所在を照合する。
- `state.json`・`status.json`・`ledger.json` を書くのは、`run-daemon` の process だけである。`result.json` は `run-daemon` か salvage が link でだけ作る。
- `result.json`・`salvage.mark`・`salvage-ledger.json`・`salvage-worklog.json`・`inbox/<batch_id>.json` は、一時ファイルからの link でだけ作る。
- `.tmp-*` を作るのは `start` だけである。

### unit の入口（内部）

次の 2 つは、unit で判断と作用を確かめるための**内部の入口**である（scheduler の入口 `runExecution` は `architecture.md` の「期限と道具の終わりが重なったとき」に置く）。依頼元から見える入力の口ではない（CLI のコマンドとしては公開せず、依頼の内容を変えない）。テストは module を直接 import して呼ぶ。

**1. `start` の判断**: `scripts/lib/start.mjs` の `decideStartOutcome(observation)`（純粋関数）

```text
StartObservation = {
  spawn_failed: boolean,                    // 起動そのものの失敗
  daemon_exited: boolean,                   // 起動した process の終了を観測した
  waited_ms: int≥0, start_wait_ms: int≥1,   // 待った時間と START_WAIT_MS
  run_dir_exists: boolean,                  // 最終の名前の run の領域がある
  lock_holder: "alive" | "dead" | "unknown" | null,   // run.lock の保持者の生死。run の領域が無ければ null
  result_json: "absent" | "valid" | "invalid",
  status_json: "absent" | "invalid" | "run_agents" | "working" | "terminal",
  salvage_mark: "absent" | "present" | "unwritable",  // unwritable は、公開しようとして I/O の誤りになった
  mark_winner: "alive" | "dead" | "unknown" | null    // salvage_mark が present のときの勝者の生死。他は null
}
StartDecision =
    { kind: "keep_waiting" }
  | { kind: "return_status" }                          // 5-2。status.json の Status を返す
  | { kind: "return_working" }                         // 5-3 前半。seq: 0 の working を返す
  | { kind: "stop_child_and_reevaluate" }              // 5-3 後半
  | { kind: "return_launch_failure" }                  // 5-1 後半。受付の段の停止（起動の失敗）
  | { kind: "salvage", step: "return_result_json" | "return_status_result" | "build_and_publish" | "return_unpublished" }   // 5-1 前半。salvage の規則 2・3・5・4 の I/O の誤り
  | { kind: "e_busy", detail: { holder_role: "run-daemon" | "salvage", liveness: "alive" | "unknown" } }   // 呼び手が detail.run_dir を足して E_BUSY を返す
  | { kind: "result_unreadable" }                     // result_json が invalid。呼び手は E_RESULT_UNREADABLE を返す
```

- 評価の順は、[起動の手順](#起動の手順)の 5 と [salvage の手順](#salvage-の手順)のとおり。

**2. 結果の公開**: `scripts/lib/publish.mjs` の `publishResult(input, fs)`

```text
PublishInput = {
  run_dir: string,                                     // 絶対 path
  ledger: { name: "ledger.json" | "salvage-ledger.json", content: object },   // 結果の指紋は関数が埋める
  result: Result                                       // 公開が成功すると仮定して作った R
}
FsBoundary = {                                         // ファイル操作の境界。本番は node:fs、テストは差し替える。path は全て絶対 path
  writeTemp(finalPath: string, tmpPath: string, bytes: Uint8Array): void,   // finalPath へ公開する内容を tmpPath に書いて fsync
  link(tmpPath: string, finalPath: string): void,     // 失敗は Error を投げ、code が "EEXIST" か他の値
  fsyncDir(dirPath: string): void,                     // finalPath のディレクトリ
  readFile(path: string): Uint8Array,                  // 再読込と、負けたときの既にある結果の読込み
  unlink(tmpPath: string): void                        // 一時ファイルの後始末
}
PublishOutcome = {
  outcome: "published" | "published_unverified" | "lost" | "lost_unreadable" | "result_failed" | "ledger_failed",
  result: Result | null,                               // published・published_unverified なら R、lost なら既にある結果、lost_unreadable なら null、他は R'
  fault: "fsync_dir" | "reread_io" | "reread_mismatch" | null   // 結果の link の後の失敗。無ければ null。テストと診断のためで、呼び手は outcome だけで振る舞いを決め、fault で変えない
}
```

- `outcome` と `result` は、[結果と台帳の保存の失敗](#結果と台帳の保存の失敗)の表の行に対応する。link の後で fsync か再読込が I/O の誤りなら `published_unverified`（`fault` は `fsync_dir` か `reread_io`。fsync が失敗しても再読込は試す。再読込で指紋が違えば下の `reread_mismatch` の扱いが優先し、そうでなければ先に起きた失敗を `fault` にする）。link の後の再読込で指紋が違えば、読んだ中身で `lost` か `lost_unreadable`（`fault: "reread_mismatch"`）。他の行の `fault` は null。`result_failed` と `ledger_failed` の R' は、`status: "停止"`、`stop_report.reasons` に `保存の失敗`（段 `集約`）と `記録の未保存` を持ち、`records` は表のとおりである。
- `fs` の操作が投げた誤りは、`publishResult` の外へ出さない（`outcome` で返す）。
- **呼ぶ順に縛らない**: テストは失敗を、呼出しの何回目かではなく、引数の `finalPath`（`<run_dir>/ledger.json`・`<run_dir>/salvage-ledger.json`・`<run_dir>/result.json`）で指す。`publishResult` が保証する順は、台帳の `link` の成功（既にあって指紋が同じ場合を含む）が結果の `writeTemp` より前、ということだけである。
- **一時ファイルの名前**: `<finalPath>.tmp-<nonce>`。nonce は小文字の 16 進 24 桁の乱数。一時ファイルは `finalPath` と同じディレクトリに置く（link が同じファイルシステムの中で行われるため）。成功でも失敗でも、`publishResult` は戻る前に自分の一時ファイルを `unlink` する（`unlink` の失敗は `outcome` を変えない）。
- **`lost_unreadable`**: 次のどれかで、既にある `result.json` を読めないか、[結果](artifact-formats.md#結果result)の形に合わないとき。(1) 結果の `link` が `EEXIST` で負けた。(2) 追補台帳の公開が「既にあって指紋が違う」で失敗し、その後に `result.json` を確かめた。(3) 自分の結果の `link` の後の再読込で、中身が R と違い形にも合わない（`fault: "reread_mismatch"`。[link の後の失敗](#結果と台帳の保存の失敗)）。`result` は `null` で、呼び手は新しい結果を作らずに誤り `E_RESULT_UNREADABLE` を返す（[誤りと終了コード](#誤りと終了コード)）。
  - 理由: そのファイルは、run の結果の名前に既にあるもので、取り消せない（(1)(2) は link の排他を勝った者が公開したもの、(3) は自分が link した後に中身が違っていたもの）。別の結果（R' など）を返すと、そのファイルと合わせて結果が 2 つになる。読めないことを誤りとして伝え、run の結果はそのファイルだけとする。

## Z3 の adapter

- 実行体は `PATH` から `z3` を探す。見つからなければ、その道具を要る性質は `未実行`（SP-007）。
- 使う option は `-in`（query を標準入力から）、`-T:<秒>`（道具自身の時間の上限）、`-model`（答えの後にモデルも出す）、`-version`（準備で版を読む）の 4 つだけ。`-T` の値は `TOOL_TIME_LIMIT_MAX_S` 以下の 1 以上の整数で、実行の種類ごとに次の 1 つの値に決まる。
  - `property`・`composition`・`contract`: その検査の `PlanFile.checks[].tool_time_limit_seconds`。
  - `sanity`: その `PlanFile.sanity[].tool_time_limit_seconds`。
  - `mutation`: 検出役の検査（`MutationsFile.mutations[].detector_check_id`）の `tool_time_limit_seconds`。
  - `replay`: 反例の検査（`Counterexample.check_id`）の `tool_time_limit_seconds`。
  - 理由: 変異と replay は元の検査の範囲をそのまま検査するので、元の検査の値を使う。値は全て計画の照合で上限以下と確かめてあり、どの実行も[検査に使える期限](#定数)で止まるので、依頼元の時間の上限と残す時間を越えない。確認用の実行の値は、この規則で計画から導けるので、結果に値の欄を持たない。
- **道具に渡す query**: 実行の `input_refs` のファイルのバイト列を、その順に、各ファイルの後に `\n` を 1 つ置いてつないだもの。これを `checks/<execution_id>/input.smt2` に保存して標準入力に渡す。
  - `input_refs` の要素は、担当が書いた query（`ModelFile.properties[].query_ref`・`sanity[].query_ref`・`PartitionsFile` の `contracts[].query_ref`・`composition_conditions[].query_ref`）だけを指せる。対象の写し（`targets/`）など他のファイルを指せば計画の欠陥である。理由: 書いた役の段で `(check-sat)` と書かない form を照らしたファイルだけを道具に渡す。対象の写しは秘密値の走査も受けない。
  - 担当の query は全て `(check-sat)` を持つので、下のつなぎ方の照合により、今は `input_refs` の要素はちょうど 1 つである（型の `[Ref]+` は、つなぎ方の規則とともに残す）。変異の「最後の input を置き換える」は、その 1 つを `mutation_ref` に置き換えることである。
  - 1 つの `.smt2` の `(check-sat)` の数と位置は、そのファイルを書いた役の段で照らす（[成果物の形式の担当の成果物](artifact-formats.md#担当の成果物)。欠陥の修正の巡はその役に戻る）。計画の照合は、つなぎ方だけを照らす: 検査・sanity・変異の各実行で、`(check-sat)` を持つ input が最後の 1 つだけであること。違えば計画の欠陥である。担当が書く `.smt2` は全て `(check-sat)` を持つので、実際には最後の input だけが担当の `.smt2` になる。理由: つないだ query の `(check-sat)` が最後の form でないと、その後の form が答えの後に出力を足し、答えの読みか証人を壊す。実測（Z3 5.3.3）では、誤った式（`(assert (foo))`）は `(error …)` の行と終了コード 1 を出し、`-model` の有無によらず `実行失敗` になる。未知のコマンド（`(foo)`）は `unsupported` と注釈の行を出して終了コード 0 で、`-model` を渡さない実行では読めない出力（`実行失敗`）になり、渡した実行では答えは正しく読めるがモデルの文字列が形に合わず、証人を読めない。
  - 変異の query は、検出役の検査の `input_refs` の最後を変異（`mutation_ref`）に置き換えて、同じ規則でつなぐ。
- `-model` は、実行の種類が `property` と `composition` の実行にだけ渡す（反例になりうる実行で、反例の再実行に証人が要る）。他の種類（`contract`・`sanity`・`mutation`・`replay`）には渡さない。
  - 理由: 担当の query には `get-model` を書かせない（[成果物の形式](artifact-formats.md#modelモデル作成役)）。証人を取るのは CLI の役目なので、CLI が渡す option で取る。
  - 退けた案: CLI が query の `(check-sat)` の後に `(get-model)` を足す。実測（macOS arm64、Z3 5.3.3）では、答えが `unsat` のとき標準出力に `(error "line … column …: model is not available")` が出て終了コードが 1 になる。読む順の 1 に当たって `判定以外のエラー` になり、成り立つ性質の検査が全て `実行失敗` になる。CLI は答えを前もって知らないので、`sat` のときだけ足すこともできない。
- 子 process には環境変数を渡さない。process group を作って起動し、標準入力（query）を渡す前に `children/<pgid>.json` を記録する（pgid は起動しないと分からないので、記録は起動の後になる。z3 `-in` は入力を受けるまで何もしない）。記録できなければ、入力を渡さずに group を止め、その実行を起動の失敗とする。起動そのもの（spawn）の失敗も同じで、どちらも終わり方は `started: false`（判定は `未実行`）とし、理由を `Check.reason` か `Confirmation.reason` に書く。`children/` は記録（`RecordKind`）に数えないので、記録できないことだけでは `保存の失敗` にしない。
- 依頼の時間の上限に達したら、formal-method が group を止める（終わり方の `stopped_by: "時間"`）。
- query が並列の設定（`parallel.enable`、`check-sat-using` と `par-or`・`par-then`）を含めば、計画の照合で拒む。

**出力の流れと終了コード**（実測。macOS arm64、Z3 5.3.3。Linux は未測定）

| 場合 | 標準出力 | 標準エラー | 終了コード |
|---|---|---|---|
| 答え | `sat`・`unsat`・`unknown` のどれか 1 行 | — | 0 |
| 答え（`-model` を渡した） | 答えの 1 行と、それに続く 0 行以上のモデル。実測では `sat` と、一部の `unknown` の後にモデルが出て、`unsat` の後には出ない | — | 0 |
| 道具自身の時間の上限 | `timeout`（実測では `-model` を渡しても 1 行だけ） | — | 0 |
| 構文の誤り | `(error …)` の行 | — | 1 |
| メモリ不足 | （答えの行なし） | `(error "out of memory")` | 101 |

Linux（CI の ubuntu）の値は未測定で、F が CI で実測してこの表に足す（`-model` を渡したときの `sat`・`unknown`・`timeout` の出力を含む）。

**読む順**（道具が自分で終わったとき。formal-method が止めた場合は `tool_result: "なし"`）

0. `-model` を渡した実行で、標準出力の最初の空でない行が `sat`・`unsat`・`unknown`・`timeout` のどれかなら、その行を答えの行とし、続く全ての行をモデルの文字列とする。モデルの文字列は 1〜4 の読みに使わず、読めるかどうかで `tool_result` を変えない（[証人](#証人)）。以下の 1〜4 は、答えの行とモデルの文字列を除いた行と終了コードで見る。そのため `-model` を渡した実行では、答えの後の `(error …)` の行はモデルの文字列に入り、1 に当たらない。終了コードが 0 でなければ 3 の `abnormal_exit` になる（どちらも判定は `実行失敗` で、意図どおりである）。
1. 標準出力に `(error` で始まる行があれば、`tool_result: "判定以外のエラー"`。
2. 終了コードが 0 で、答えの行がある（0 で決めた）か、標準出力の空でない行がちょうど 1 つ（その行が答えの行）なら、答えの行で決める。
   - `unsat`・`sat` は、下の「答えと `tool_result` の対応」で決める。
   - `unknown` は `判定できない`。理由（`:reason-unknown`）は読まない。
   - `timeout` は `判定できない` で、`time_limit_hit: "道具"`。
3. それ以外で終了コードが 0 でなければ、`abnormal_exit: true`、`tool_result: "なし"`。
4. それ以外（終了コードが 0 で、空でない行が無い、2 に当たらずに 2 つ以上ある、又は答えの行が上のどの値でもない）は、`tool_result: "なし"`、`unreadable_output: true`。
- 標準エラーは証拠として保存するだけで、読む順に使わない。

**答えと `tool_result` の対応**（どの実行も、答えが `expected` と同じなら `満たす`、`sat`・`unsat` のうち違う方なら `反する`）

| 実行の種類 | 置く query | `expected` | `unsat` のとき | `sat` のとき | 何に使うか |
|---|---|---|---|---|---|
| 性質の検査（`property`） | 前提 ∧ ¬性質 | `unsat` | `満たす` | `反する`（反例） | 検査の判定 |
| 部分の契約（`contract`） | 部分の前提 ∧ ¬契約 | `unsat` | `満たす` | `反する` | 契約の判定 |
| 合成の条件（`composition`） | 契約の連言 ∧ ¬全体の性質 | `unsat` | `満たす` | `反する`（親の性質の反例） | 検査の判定 |
| 前提の整合（`sanity`） | 前提（と初期状態・到達例） | `sat` | `反する`（前提の矛盾） | `満たす` | 確認の記録 |
| 変異（`mutation`） | 検出役の検査の query の最後の input を変異に置き換えたもの | `expected_violation` | `unsat` が期待なら `満たす`（検出）、そうでなければ `反する`（検出せず） | `sat` が期待なら `満たす`、そうでなければ `反する` | 検出能力の確認 |
| 反例の再実行（`replay`） | 反例の検査の query ∧ 証人の値（下の [証人](#証人)） | `sat` | `反する`（再現せず） | `満たす`（再現） | 確認の記録 |

- `unknown`・`timeout`・`(error` の扱いは、どの種類でも上の読む順のとおりである。
- **出力の上限**: 標準出力が `TOOL_OUTPUT_MAX_BYTES` を超えたら、次のとおりにする。
  - `-model` を渡した実行で、上限までに答えの行（0 で決める行）を読み終えていれば、group を止めない。上限を超えた分は読んで捨て、`stdout.txt` には上限までのバイト列だけを保存する。答えはそのまま読み、モデルの文字列は途中までなので、証人を読めないものとする。切り詰めたことは、その検査の `Check.reason` と replay の `Confirmation.reason` に、固定の語「標準出力を TOOL_OUTPUT_MAX_BYTES で切り詰めた」を含めて書く。理由: 答えは読めているので、モデルの大きさで判定を変えない。止めない実行も `-T` と検査に使える期限で終わる。
  - それ以外は、formal-method が group を止め、`stopped_by: "その他"`、`unreadable_output: true` とする（判定は `未実行`）。
- **答えの後の停止**: `-model` を渡した実行で、答えの行を読み終えた後、モデルを読んでいる（又は読み捨てている）間に期限か停止の要求が来たら、group を止める。この実行は、答えの行を読み終えた時点で道具の結果を得たものとし、答えの行で決める（2 の終了コードの条件は当てない）。`stopped_by: null`、`time_limit_hit` は答えの値のとおり（`timeout` なら `道具`、他は null）、`abnormal_exit`・`unreadable_output` は false とし、証人は読めないものとする。理由: 判定がモデルの大きさで変わらないようにする（上の出力の上限と同じ）。止めたのはモデルの読み取りで、検査ではない。この組は、道具の結果を得た後に止めるものは無いとするオラクルの規則（網羅表の WF1）の、止めていない行と同じになる。
- 道具を実行した確認（`sanity`・`mutation`・`replay`）の `Confirmation.result` は、その `end` に `classifyCheck` を当てた値で決める。`成功` なら `成り立つ`、`反例` なら `成り立たない`、他の値なら `確認できず`。

### 証人

反例の再実行（SP-012 の決定的な検査）の入力を作る手順。

- **取る実行**: `-model` を渡した実行（`property`・`composition`）で、判定が `反例` のもの（`property`・`composition` の `expected` は `unsat` だけなので、答えの行は `sat` である）。
- **読む元**: その実行の `checks/<execution_id>/stdout.txt` を、保存と再読込の照合に通った後に読み直したバイト列の、答えの行より後の部分（モデルの文字列）。保存できなかった場合（秘密値の走査で書かなかった場合を含む）は、証人を読めないとする。理由: 再実行の入力を保存した証拠だけから作ると、記録から再現を辿れる。
- **モデルの形**: モデルの文字列から SMT-LIB の注釈（文字列の literal の外の `;` から行末まで）を除いたものが、S 式としてちょうど 1 つの list であること。list の後に空白以外が残れば、形に合わない。list の要素のうち `(define-fun <記号> () <値の sort> <項>)`（引数の無い定義）だけを使い、他の要素（引数のある `define-fun`、`declare-fun`、`forall` など）は使わない。
- **証人の値**: 使う要素のうち、記号が反例の検査の query（`checks/<execution_id>/input.smt2`）の `declare-const` か、引数の無い `declare-fun` で宣言されていて、項が次の閉じた集合の literal であるもの。
  - `true`・`false`。数字の列（例 `12`）と `(- <数字の列>)`。小数（例 `1.5`）と `(- <小数>)`・`(/ <小数> <小数>)`・`(- (/ <小数> <小数>))`。`#x` と 16 進の列、`#b` と 0・1 の列。文字列の literal。
  - 集合に無い項（`(as const …)`・`as-array`・`lambda`・`root-obj`・補助の記号 `k!0` や `U!val!0` を含む項など）の記号と、モデルに無い記号は、値を固定しない。
  - 理由: literal は replay の query の中でそのまま読め、他の記号に依らない。他の形は、補助の記号の宣言や論理の制約（量化子を許さない `QF_*` の logic など）に依り、replay の query を壊しうる。
  - 固定する記号が 1 つも無ければ、証人を読めないとする（何も固定しない replay は反例を再現したことにならない）。
- **replay の query**: 反例の検査の `input.smt2` のバイト列の、ただ 1 つの `(check-sat)` の form の直前に、固定する記号ごとに `(assert (= <記号> <項>))` と改行 `\n` 1 つからなる 1 行を、モデルの要素の順に挿入したもの。
  - `<項>` は、注釈を除いたモデルの文字列の、その項の最初の文字から最後の文字までを写し、文字列の literal の外の空白の並び（改行を含む）を空白 1 つにまとめたもの。
  - 固定しなかった記号は、replay の `Confirmation.reason` に名前を挙げる。挙げるのは query で宣言された記号のうち固定しなかったもの（モデルに無い、引数がある、項が literal でない）だけで、宣言の順に並べる。query で宣言されていない補助の記号（`k!0` など）は挙げない。
  - replay の実行は、この query を `checks/<replay の execution_id>/input.smt2` に保存して、`expected: "sat"` で実行する。`Counterexample.replay.steps_ref` は、この `input.smt2` を指す。
- **証人を読めないとき**（`stdout.txt` を保存できなかった、モデルが無い、出力の上限で途中まで、形に合わない、固定する記号が無い）:
  - replay の実行を始めない。replay の `Confirmation` は `result: "確認できず"`、`end` は始めていない終わり方（`started: false`、`tool_result: "なし"`、`abnormal_exit: false`、`unreadable_output: false`、`stopped_by: null`、`time_limit_hit: null`）、`reason` に読めなかった理由を持つ。
  - `Counterexample.replay.steps_ref` は、反例の検査の `checks/<execution_id>/input.smt2` を指す。
  - 反例の検査の `end` と `verdict` は変えない（答えの行は読めたので、`反する`・`反例` のまま）。理由: 証人を読めないことを `end` で表すと、`tool_result` が `なし` 以外で `unreadable_output: true` の組になり、[起こらない組](artifact-formats.md#検査の終わり方end)に当たる。モデルを答えの読みに使わないので、終わり方の組と判定の表は変わらない。
- **秘密値**: replay の `input.smt2` は、CLI が道具の出力から作る新しい記録なので、書く直前に[秘密値の走査](#run-の領域の配置)を当てる。見つかれば書かずに、replay を始めず（`確認できず`）、その記録を保存できなかったもの（停止の理由 `保存の失敗`）として扱う。

## 定数

`scripts/lib/schemas.mjs` に置き、関係を unit で検査する。

| 定数 | 値 | 関係・理由 |
|---|---|---|
| `CALL_MAX_MS` | 240000 | 前景の 1 回の呼出しの上限。Claude Code の Bash の上限 600000 の半分以下 |
| `CALL_MARGIN_MS` | 30000 | `CALL_MAX_MS` + `CALL_MARGIN_MS` ≤ 司令塔が指定する timeout ≤ 600000 |
| `CLEANUP_BUDGET_MS` | 30000 | `CLEANUP_BUDGET_MS` < `CALL_MAX_MS` |
| `START_WAIT_MS` | 210000 | = `CALL_MAX_MS` − `CLEANUP_BUDGET_MS` |
| `START_STOP_WAIT_MS` | 5000 | 起動の手順 5-3 で、止めた子の終了を待つ上限。< `CLEANUP_BUDGET_MS` |
| `WAIT_LIMIT_MS` | 210000 | = `CALL_MAX_MS` − `CLEANUP_BUDGET_MS` |
| `WAIT_POLL_MS` | 2000 | < `WAIT_LIMIT_MS` |
| `SALVAGE_RETRY_MS` | 10000 | 司令塔の呼び直しの間隔 |
| `SALVAGE_RETRY_MAX` | 30 | 司令塔の呼び直しの上限。`SALVAGE_RETRY_MAX` × `SALVAGE_RETRY_MS` > `CALL_MAX_MS`（勝者の salvage が 1 回の呼出しで終わる時間より長く待つ） |
| `LIVENESS_UNKNOWN_MAX` | 30 | 生死を判定できない状態が続いたときの、司令塔の待ちの上限（回数） |
| `AGENT_BATCH_MAX` | 4 | 1 つの batch で同時に起動する担当の上限 |
| `AGENT_BATCH_DEADLINE_MS` | 1800000 | 担当の batch の内部の期限（30 分）。依頼の時間の上限があれば、run の期限 − `REPORT_RESERVE_MS` との早い方。理由: モデル作成役は対象の全体を読んでモデルと対応表を書くので、数分では足りない。一方で、返らない担当が run を止め続けないよう有限にする。30 分は、確認の段の batch を数回回しても、人が待てる長さに収まる |
| `TOOL_TIME_LIMIT_MAX_S` | 600 | 道具の 1 回の実行の時間の上限（`-T`）の上限。`TOOL_TIME_LIMIT_MAX_S` × 1000 < `AGENT_BATCH_DEADLINE_MS`。理由: 時間の上限の無い依頼でも、実行の段が有限の時間で終わる。10 分を超える検査は、範囲を分けるべき大きさとみなす（計画作成役がそう分ける）。超えた検査は `時間切れ`（道具自身の時間の上限）になる。使った値は、各検査の `tool_time_limit` と結果の `verified_scope.internal_time_limits` に必ず出す |
| `REPORT_RESERVE_MS` | 60000 | 集約と保存のために残す時間の上限。実際に残す時間は min(`REPORT_RESERVE_MS`, 時間の上限 × 1000 / 4) ms。担当の batch の期限 = run の期限 − 残す時間 |
| `REVISE_ROUNDS_MAX` | 2 | 作成役の修正の巡の上限 |
| `TOOL_OUTPUT_MAX_BYTES` | 1048576 | 道具の標準出力の上限 |
| `MEMORY_SAMPLE_MS` | 100 | 性能の記録のための常駐メモリの標本の間隔 |

値の根拠は実測していない。値を変えるときは、表の関係の検査を通す。

**検査に使える期限**: 担当の batch の期限も道具の実行の期限も、run の期限 − 残す時間とする（残す時間は `REPORT_RESERVE_MS` の行）。この時点で実行中の道具は止め、終わり方は `stopped_by: "時間"`・`time_limit_hit: "依頼元"`（判定は `時間切れ`）とする。理由: 依頼元の時間の上限までに結果を返すには（SP-010・015）、集約と保存の時間をその上限の中に含めるしかない。そのため、検査に使える依頼元の時間の上限は、run の期限 − 残す時間である。

**時間の上限が小さい依頼**: 担当の batch や道具の実行を出す時点で、上の期限が既に過ぎていれば、出さない。出さなかった担当の成果物は未作成、検査と道具を実行する確認は `未実行` になる。出さなかった独立検証者の unit と原因の分類は、[確認](artifact-formats.md#確認sp-004005012)と[担当の返り値](artifact-formats.md#担当の返り値)の「担当を出さなかった場合」のとおり（`確認できず`・`原因未確認`、確認した者は `cli`）。停止の理由は `時間の上限`（`stage` はその段）で、状態は `停止`。
- 理由: 期限の過ぎた担当や道具を出しても、返る前に止めることになり、結果は同じで時間だけを使う。1 秒の上限も受け付けたうえで（SP-001）、上限までに何もできなかったことを、上限に達した停止として返す（SP-010）。
- 残す時間を時間の上限の 1/4 までに抑えるのは、短い上限でも担当と道具に時間を回すためである。

`AGENT_BATCH_DEADLINE_MS` と `TOOL_TIME_LIMIT_MAX_S` は、依頼元が時間の上限を渡したかどうかによらず使う内部の上限なので、結果の `verified_scope.internal_time_limits` に値と「内部の上限」であることを出す（[成果物の形式](artifact-formats.md#検証した対象と範囲sp-001003004)）。
