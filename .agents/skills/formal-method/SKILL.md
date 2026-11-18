---
name: formal-method
description: >
  検証の対象（要求文書・仕様書・コード・状態遷移）と目標を受け取り、形式手法で確かめられる性質を洗い出し、
  モデル化・検査・独立した確認を決定的な CLI と担当の agent で行って、検証できた範囲・反例・原因・未検証・
  記録への参照を構造化した結果として返す。
  「この要求を形式検証して」「この状態遷移に抜けや到達できない終点が無いか機械的に確かめて」
  「この制約が矛盾しないか SMT で確かめて」「別のスキルから対象と目標の JSON を渡すので検証結果を返して」
  「止まった formal-method の run の結果を見せて」といった依頼なら使うこと
  （Use when formally verifying requirements, specifications, code, or state machines with an SMT-based pipeline）。
  対象外: 単体テストの作成、通常のコードレビュー、PRD・仕様書の作成やレビュー、形式手法の一般的な説明や道具の比較の質問、
  対象の修正、法令・規格への適合の認証。
---

# formal-method

依頼元（人又は別のスキル）から対象と目標を受け取り、形式手法で確かめられた範囲と確かめられなかった範囲を区別した結果を返す。振る舞いの正本は仕様 `docs/specifications/formal-method.md`、内部の仕組みの正本は [設計](references/architecture.md)、CLI の入出力の正本は [CLI 契約](references/cli-contract.md)、データの形の正本は [成果物の形式](references/artifact-formats.md) である。

このスキルは対象を変更しない。結果だけで、利用者の意図への適合や対象の実装との一致を断定しない。

## 役と境界

| 役 | 実体 | すること | しないこと |
|---|---|---|---|
| 司令塔 | このスキルを読む session | CLI を呼び、出力の値を次の呼出しへ渡し、結果の欄を提示する | 判定・状態・結果の本文を作る、直す、採点する。run の領域に書く。担当の役を代わりに行う |
| CLI | `scripts/formal-method-cli.mjs` と、run ごとに 1 つの background の `run-daemon` | 依頼の検査、段の進行、照合、道具の実行、判定、保存の全て | 意味の判断 |
| Workflow script | [担当の起動](#担当の起動) で起動する script | CLI が決めた task を起動し、task ごとの起動の結末を返す | 判断、返り値の中身を読むこと |
| 担当 | Workflow が起動する agent（`agents/<role>.md`） | 抽出・モデル・分割・計画の作成と、観点ごとの独立した確認、原因の分類 | 自分の成果物の確認、台帳への書込み |

判断を司令塔の散文に置くと、読む者ごとに停止の条件や期限の確かめ方が変わる。そのため、決定的に書ける判断は全て CLI が持ち、司令塔は中継だけをする。

配布先は今は Claude Code だけである。Codex での動作は確かめていない（[設計の未検証と限界](references/architecture.md#未検証と限界)）。

**用語**

- `run_dir`: run の記録を置くディレクトリの絶対 path。CLI が返す値をそのまま使う。
- `run-daemon`: run の状態を書く唯一の background の process。司令塔は直接呼ばない。
- `status_seq`: CLI が前に返した `status.seq`（又は `still_waiting` の `status_seq`）。司令塔は自分で値を作らない。
- `batch_id`・`task_id`・`return_path`: CLI が担当の起動ごとに決める識別子と、担当が返り値を書く path。
- `provisional`: 結果が記録を保存できなかった仮の結果であることを示す欄。

## 依頼の受け方

依頼の項目は SP-FORMALMETHOD-001 の 5 つ（対象・目標・既知の要求・検証範囲・時間の上限）だけで、形は [依頼（Request）](references/artifact-formats.md#依頼request)。どの経路でも、同じ項目の JSON を `start` に渡す。

1. **別のスキルが依頼の JSON を渡したとき**: その値を書き換えずに `start` の `request` に入れる。
2. **人が自然文で頼んだとき**: 文に書かれた値だけで依頼の下書きを作り、依頼元に示して確認を得る。
   - 対象は `targets`（`location` は作業ツリーからの相対 path、絶対 path、又は `file://` の URI）、目標は `goals`、文の中の要求・制約は `known_requirements`、範囲は `scope`（除外には理由）に分ける。
   - 時間の上限（`time_limit_seconds`）は、依頼元が秒で述べたときだけ入れる。CPU とメモリの項目は無いので作らない。
   - 文に無い値（任意の項目、時間の上限、範囲）を補わない。補った目標や範囲は、依頼元が指定していないものを検証済みとして返す原因になる。
   - 依頼元が確認したら、確認した値を変えずに `start` に渡す。確認が無ければ `start` を呼ばない。
3. **対象か目標を特定できないとき**: 下書きを作らず、足りない項目を名指しして尋ねて終える。作業ツリーのファイルを推測で対象に選ばない。

尋ねて終えるときの案内（いずれも `start` を呼ばない）:

| 依頼 | 案内 |
|---|---|
| 空、又は「検証して」だけ | 何を（対象のファイルかディレクトリ）、何について（目標の文）検証するかを尋ねる |
| 対象はあるが目標が無い | 目標の文を尋ねる |
| 目標はあるが対象が無い | 対象の場所を尋ねる |
| 項目が互いに矛盾する（同じものを含めて除外するなど） | どちらを採るかを尋ねる |
| 形式手法の検証ではない（テストの作成、説明の質問など） | このスキルでは扱わないことを伝える |

次の場合は補わずに、書かれたとおり渡すかを尋ねる: 任意の項目が欠けている、時間の上限が書かれていない、対象に URL と path が混ざっている（`file://` 以外の URI は CLI が取得できない対象として扱う）。

**既に在る run の結果を見たいとき**: 依頼元が `run_dir` を示したら、[呼び方](#cli-の呼び方と-timeout) に従って `wait` を `{"run_dir": "<run_dir>", "status_seq": 0}` で呼び、以後は [手順](#手順) の分岐に従う。`run_dir` が示されていなければ、どの run かを尋ねる。司令塔は保存先のディレクトリを一覧して run を選ばない（どれを選ぶかの規則は CLI に無い）。run の記録を直接読んで結果として示したり、書き換えたりしない。

## CLI の呼び方と timeout

全てのコマンドを、標準入力の 1 つの JSON で呼ぶ。出力は標準出力の 1 行の JSON である。

```bash
node [SKILL_DIR]/scripts/formal-method-cli.mjs <command> <<'JSON'
<入力の JSON>
JSON
```

- **Bash の timeout を、呼ぶたびに 300000（ms）と明示する。** timeout を省くとホストの既定の値になり、CLI が返る前に殺される。値は `CALL_MAX_MS` + `CALL_MARGIN_MS` 以上で、Claude Code の上限 600000 以下である。
- `start` は、作業ツリーの根を現在のディレクトリにして呼ぶ。CLI は呼んだ process の現在のディレクトリを作業ツリーとし、保存先をその下の `.formal-method/runs/` に置く。

| コマンド | 入力 |
|---|---|
| `start` | `{"request": <依頼>}` |
| `wait` | `{"run_dir": "<run_dir>", "status_seq": <status_seq>}` |
| `submit` | `{"run_dir": "<run_dir>", "batch_id": "<batch_id>", "workflow_output_path": "<path>"}` 又は `{"run_dir": "<run_dir>", "batch_id": "<batch_id>", "timed_out": true}` |
| `salvage` | `{"run_dir": "<run_dir>"}` |

この手順が使う定数（正本は [CLI 契約の定数](references/cli-contract.md#定数)。この表は写しで、正本が変われば正本に従う）:

| 定数 | 値 | 使う所 |
|---|---|---|
| `CALL_MAX_MS` | 240000 | 1 回の呼出しの上限。timeout の下限の計算 |
| `CALL_MARGIN_MS` | 30000 | timeout の下限の計算 |
| `SALVAGE_RETRY_MS` | 10000 | `salvage` を呼び直すまでの待ち |
| `SALVAGE_RETRY_MAX` | 30 | `salvage` の呼び直しの上限 |
| `LIVENESS_UNKNOWN_MAX` | 30 | `liveness: "unknown"` が続いたときの上限 |

**待ち方**: 前景の `sleep` は使わない。指定の時刻か時間まで待つときは、次の command を background で起動し、その終了の通知を待つ（`<ms>` は待つ時間、`<deadline_wall_ms>` は CLI が返した期限）。

```bash
node -e 'setTimeout(() => {}, Math.max(0, Number(process.argv[1])))' <ms>
node -e 'setTimeout(() => {}, Math.max(0, Number(process.argv[1]) - Date.now()))' <deadline_wall_ms>
```

## 手順

1. 依頼を受け、`start` を呼ぶ。
2. CLI の出力ごとに、次の表の行を 1 つ選んで行う。終える行に当たるまで繰り返す。

| 出力 | 司令塔がすること |
|---|---|
| `status.action` が `run_agents` | [担当の起動](#担当の起動) を行い、その後 `wait` を `status_seq` = この `status.seq` で呼ぶ |
| `status.action` が `working` | `wait` を `status_seq` = この `status.seq` で呼ぶ |
| `status.action` が `terminal` | [結果の提示](#結果の提示) を行って終える |
| `wait` の `outcome: "still_waiting"` | `wait` を、出力の `status_seq` のまま呼び直す。繰り返しても値を変えない |
| `submit` の `outcome` が `accepted` か `duplicate` | `wait` を、`run_agents` の `status.seq` で呼ぶ |
| 誤り（`ok: false`） | [誤りと止まり方](#誤りと止まり方) |
| JSON でない出力 | [誤りと止まり方](#誤りと止まり方) |

- `run_dir` は、CLI が最後に返した値を使う。
- batch は 1 つの run の中で何度も来る（洗い出し・モデル化・計画・確認の段ごと、件数が多ければ同じ段で複数）。対象が 1 つでも同じ表で進む。

## 担当の起動

`status.action` が `run_agents` のとき、`status.batch` の `batch_id`・`tasks_path`・`deadline_wall_ms` を使う。

1. `tasks_path` の JSON を Read し、その `batch_id` と `tasks` を値のまま args に入れる。値を選んだり並べ替えたりしない（Workflow script が受け取った値を返し、CLI が `tasks.json` と照合する。食い違えばその batch の返り値は全て使われない）。`attempts/` の `task.md` は読まない、書かない。
2. Workflow を background で起動する。

   ```js
   Workflow({
     scriptPath: "[SKILL_DIR]/scripts/formal-method-agents.js",
     args: { batch_id: "<tasks.json の batch_id>", tasks: <tasks.json の tasks をそのまま> }
   })
   ```

3. 同時に、`deadline_wall_ms` までの待ちの command を background で起動する（[待ち方](#cli-の呼び方と-timeout)）。
4. 先に届いた通知で、`submit` の入力を次のどちらか 1 つに決める。
   - **Workflow の完了が先に届き、その通知が返り値の JSON を収めたファイルの path を示した**: `workflow_output_path` にその path を入れる。
   - **それ以外**（待ちの command が先に終わった、Workflow が起動しなかった、途中で終わった、通知に返り値のファイルの path が無い、native の `Workflow` が無い）: `timed_out: true` を入れる。動いている Workflow は止める。
5. `submit` を 1 回だけ呼ぶ。`timed_out: true` で出した後に Workflow の完了が届いても、`submit` を呼び直さない（期限の後の値は CLI が使わない）。同じ `batch_id` の `submit` を 2 回呼ぶと `duplicate` が返り、2 回目は使われない。

担当の役（抽出・モデル・確認など）を司令塔が代わりに行わない。担当が返らなかった分は、CLI が欠測として扱い、結果の未作成・`未確認` に残す。

## 誤りと止まり方

誤りの code の意味は [CLI 契約の誤りと終了コード](references/cli-contract.md#誤りと終了コード)。

| 出力 | 司令塔がすること |
|---|---|
| `E_STALE`（`wait`） | `salvage` を呼ぶ |
| `E_BUSY` で `detail.holder_role` が `run-daemon` | `wait` を呼ぶ（`status_seq` は最後に受け取った値。まだ受け取っていなければ 0）。`run_dir` は `detail.run_dir` |
| `E_BUSY` で `detail.holder_role` が `salvage` | `SALVAGE_RETRY_MS` 待って、`detail.run_dir` で `salvage` を呼び直す（`start` が返した場合も同じ）。呼び直しが `SALVAGE_RETRY_MAX` 回に達したら、結果を作らずに終える（下の表の「呼び直しの上限」） |
| `E_RESULT_UNREADABLE` | 結果を作らずに終える（下の表の「結果のファイルが読めない」） |
| `E_INPUT` | 呼び直さずに終える（「入力の誤り」） |
| `E_CONTRACT` | 呼び直さずに終える（「契約の誤り」） |
| `run_dir` を持つ呼出し（`wait`・`submit`）の出力が JSON でない | `salvage` を呼ぶ |
| `start` か `salvage` の出力が JSON でない | 呼び直さずに終える（「出力が読めない」） |

- `liveness: "unknown"`（`wait` の `still_waiting`、又は `E_BUSY` の `detail.liveness`）の出力を、続けて受け取った回数を数える。`unknown` でない出力を受けたら 0 に戻す。`LIVENESS_UNKNOWN_MAX` 回に達したら、結果を作らずに終える（「保持者の生死が分からない」）。`ps` が使えない環境では生死が分からないまま待ち続けるため、司令塔の側で終わらせる。

**結果を作らずに終える経路**

どの経路でも、依頼元へ「結果は返らなかった」と最初に書き、理由の語、`run_dir`（あれば）、CLI の出力の原文をそのまま示す。理由は CLI の出力にある値だけから述べ、原因を推測で足さない。この案内に判定や状態の語を書かない（結果が無いので、書けば構造に無い値を足すことになる）。

| 理由の語 | 当たる経路 | 依頼元が取れる次の対応 |
|---|---|---|
| 呼び直しの上限 | `E_BUSY`（`salvage`）が `SALVAGE_RETRY_MAX` 回続いた | しばらく後に同じ `run_dir` の結果を見る依頼をし直す |
| 保持者の生死が分からない | `liveness: "unknown"` が `LIVENESS_UNKNOWN_MAX` 回続いた | `run_dir` を確かめる。`ps` が使える環境で、同じ `run_dir` の結果を見る依頼をし直す |
| 結果のファイルが読めない | `E_RESULT_UNREADABLE` | `detail.path` のファイルを確かめる。run の結果はそのファイルだけである |
| 入力の誤り | `E_INPUT` | 依頼の `run_dir` を確かめて依頼し直す |
| 契約の誤り | `E_CONTRACT` | 同じ入力で依頼し直す。続くなら CLI の不具合として報告する |
| 出力が読めない | `start`・`salvage` の出力が JSON でない | 同じ入力で依頼し直す。`run_dir` があればそれを確かめる |

## 結果の提示

`status.action` が `terminal` のとき、`status.result` が結果の正本である。提示は結果の欄の値を並べて引用するだけで、本文を作らない。結果の構造に無い成功を足さない（SP-FORMALMETHOD-003）。

**呼び出し元がスキルのとき**: `status.result` を書き換えずにそのまま返し、`status.run_dir` を添える。仮の結果であることは `provisional` の欄で伝わる。

**人に示すとき**は、次の順に示す。

1. **仮の結果**（`provisional: true` のときだけ、最初に示す）
   - 「記録を保存できなかった仮の結果である」と書く。
   - `run_dir` が null でなければ、`run_dir` を示し、`<run_dir>/result.json` が在ればそれが正の結果であり、そのファイルを読めば正の結果を得られると伝える。
   - `run_dir` が null なら、run の領域が作られなかったので、後から正の結果が公開されることは無いと伝える。
   - 仮の結果を `完了` や確定した結果として述べない。
2. **状態**: `status`（`完了` か `停止`）。`停止` なら `stop_report` の `stage` と `reasons` の全て。
3. **保証の範囲**: `verified_scope`（対象と版、範囲、除外と理由、前提とした外部のもの、読めなかった箇所）、性質ごとの `verdict`・`assurance`・`detection`、`models` の扱う範囲。
4. **未検証**: `unverified[]` の項目と理由をそのまま並べる。空なら「未検証の項目は結果に無い」とだけ書き、範囲を広げて言い換えない。
5. **反例・原因・問い**: `counterexamples`・`causes`・`questions`。問いに回答を得たら、回答を足した依頼を新しい依頼として [依頼の受け方](#依頼の受け方) からやり直す（同じ run を続ける手段は無い）。
6. **停止の報告の残り**（`停止` のとき）: 確認済み・未確認の範囲、生成済み・未作成の成果物、実行中・中止した検査、保存できなかった記録（`records.unsaved`）。
7. **限界**: [限界と未検証](#限界と未検証) のうち、結果の `unverified[]` に載ったもの。

- 担当の返り値が欠けた batch があっても、結果の欄がそれを `未確認`・未作成として持つ。司令塔は、返った担当と返らなかった担当を数え直して結果に足さない。
- `検証済み`・`別手段で確認済み` 以外の値（`未実行`・`unknown`・`時間切れ`・`実行失敗`・`未確認`、保存できなかった記録）を、成功として述べない。
- 語の意味（unknown、時間切れ、充足可能、反例、有限化など）を人に説明するときは、[形式手法の知識](references/formal-method-knowledge.md) の文を引く。自分の言い換えで意味を広げない。
- 人向けの表示 `<run_dir>/report.md` が結果の記録に在れば、その path を添えてよい。

## 限界と未検証

解決していない限界である（正本は [設計の未検証と限界](references/architecture.md#未検証と限界)）。

- 担当の書込みと読む範囲は、ホストの権限で分けていない。担当の義務だけで守り、CLI は登録の前の書換えを見つけられない。
- 結果に記録した model・effort は、Workflow が受け取ったと返した値である。ホストが実際にその値で動かしたかは確かめられない。
- 秘密値の走査は 4 つの型だけを検出し、それ以外の形は見逃す。対象の写しは走査しない。
- Z3 の出力の流れと終了コードは、macOS arm64・Z3 5.3.3 でだけ測った。Linux では測っていない。
- `run-daemon` の detach は、Claude Code のデスクトップ（macOS arm64）で前景のコマンドの終了後も生きることだけを確かめた。session やアプリの終了の後と Linux での振る舞いは確かめていない。
- Codex での動作（コマンドの時間の上限、detach した process の扱い、Workflow の実行）は確かめていない。

## 参照

| 読むとき | ファイル |
|---|---|
| コマンド・誤りの code・`status.json`・定数 | [references/cli-contract.md](references/cli-contract.md) |
| 依頼・結果・task・返り値の形 | [references/artifact-formats.md](references/artifact-formats.md) |
| 役割・段・停止の手順・限界の理由 | [references/architecture.md](references/architecture.md) |
| 担当の共通の義務 | [references/agent-obligations.md](references/agent-obligations.md) |
| 語の意味（判定、保証、unknown など） | [references/formal-method-knowledge.md](references/formal-method-knowledge.md) |
| 作業記録に適用する文書の一般規約（CLI が run に固定して使う写し） | [references/document-rules.md](references/document-rules.md) |
| 担当ごとの指示 | `agents/<role>.md`（task.md の ROLE が指す） |
