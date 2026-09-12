# Incremental ledger and hook trigger

## Explicit input contract

`stream_collect.py` は専用ledgerへ終端の観測を保存する。既存の `collect.py` snapshot storeとは
別ディレクトリを使う。snapshotの合算や移行はしない。通常の読取計測は `measure.py` のまま。

```sh
python3 [PLUGIN_DIR]/scripts/stream_collect.py collect normalized <events.jsonl> --stream-id <capture-id> --store <private-ledger>
python3 [PLUGIN_DIR]/scripts/stream_collect.py report --store <private-ledger>
python3 [PLUGIN_DIR]/scripts/stream_collect.py maintain --store <private-ledger> --retention-days 30
```

`report` は読取専用。観測をadapter・scope別に最大32群返し、残りは `omitted_groups` で示す。
群を跨いで合算しない。品質はunmeasured、全実行捕捉の完全性はnull。観測0件を使用量0としない。
観測期間は収集日時でありモデルの実行日時ではない。retentionは次のcollect/maintain時に適用する。

| adapter | 入力と計上単位 | ID・除外境界 |
|---|---|---|
| normalized | [正規化契約](measurement.md)のJSONL、完了呼出しごとの差分 | source/run_id/call_idで重複排除。別sourceを合算しない |
| codex-exec | `codex exec --json` または同形のSDKイベント、turn.completedのusage | capture-id/thread-id/turn序数。turn.failedはusage不明。item本文は破棄 |
| claude-query | 単発queryのTypeScript SDK形JSONL、唯一のresult.usage | capture-id単位、main-loopのみ。assistantのplaceholderやsubagent本文は加算しない。error resultはusage不明 |

native adapterのcapture-idは **SDK/CLI呼出しごとに新しい一意ID**。同じ収集の再試行・同じログの
物理的rotateでは維持する。別query/execのログへの差替え、resumeの別呼出しでは必ず変更する。
Claudeのstreaming-inputによる複数resultは累積値なので拒否する。単一resultでもログの切り抜きが
streaming由来でないことは入力提供者が保証する。複数のcaptureに同じ実行を投入しない。
SDKイベント形式の明示選択は必須。Codex rollout/transcript、Claude transcript、statuslineの
自動推測・自動走査は行わない。実環境のセッション全体、隠れた子実行の費用帰属は未認定。

Claudeのinputはfresh+cache_creation+cache_read、cachedはcache_readを内数として保持する。
cache_creationはuncached側に含まれ、同一の単価とは解釈しない。費用・課金枠を計算しない。
エラーのゼロ値はクラッシュ時にリセットされた可能性があるため、ゼロ使用量とは認定しない。

## Incremental boundaries and recovery

- 入力は信頼するappend-only regular file。末尾1MiB以内の1chunkずつ処理し、途中行は次回へ保留。
  読み進めたoffsetから新規部分のみ読む。head/tail各4KiB以内のanchor照合を追加で行う。
- inode変更・短縮・anchor不一致なら先頭から再読込。保持済みIDで重複排除する。
  未読部分を含む旧ログが失われた場合は復元できない。本文の中間改ざんを検出する保証ではない。
- nativeログのrotate後には有効な先頭からのイベント列が必要。途中turnからの再開は拒否する。
  違う値の同一IDは失敗。batch内の一部だけをcommitせず、失敗時は観測とcursorを巻き戻す。
- `pending_bytes` は未消費の末尾あり。完全な行のbacklogなら再実行、途中行ならproducerの追記を待つ。
  hooksは1回1chunkで終了し、backlog解消のためにループ・LLM起動をしない。

## Private storage and overhead

保存先は信頼する親配下の専用0700 directory、ファイル0600。symlink/hardlinkを拒否する。
入力ログを保存先の配下に置く設定は拒否し、予約pendingの回収が入力を削除しないようにする。
認める名前はstate.json、.pending、.lockだけ。不明ファイルは削除せず収集を拒否する。
state/pending各最大2MiB、lock空、管理する本文は合計最大4MiB（filesystem割当等は除く）。
最大2000観測・32cursorで、上限なら古い観測を黙って捨てず失敗する。retention既定30日、1〜365日。
期限後の再投入は新規扱いになり得る。永久exactly-onceや全期間合計ではない。

非待機排他、fsync→atomic replace→directory fsyncを使用。予約pendingは検証後の次回書込で回収。
replace後の失敗はcommit済みの可能性があり、同じcaptureで再試行する。破損の自動修復はしない。
`maintain` は明示的な期限掃除コマンド。常駐プロセスは起動せず、定期実行登録は別途ユーザー承認。
活動がなければ期限を過ぎてもデータは残る。期限時刻の厳密な自動消去を約束しない。

metricsのattempts/successes/failuresはledgerへcommitできた試行。bytes_readは成功batchの
payload読込量（anchor/state読込、失敗batchは除外）。duration_msは計測開始から書込前までの
成功/失敗処理時間の累計。返却するcollector_duration_msはfsyncを含む今回の全処理時間。
排他取得前・store破損・ディスク不可・timeout・強制終了は記録できない場合がある。
その場合CLIはfailure_recorded=false。永続failure値0を「失敗なし」と認定しない。

## Hook adapter: opt-in only

`hook_collect.py --config <trusted-config.json>` が共通の接続口。
configのenabledがfalseなら入力を読まず終了。配布サンプルは
[hook-config.example.json](hook-config.example.json)。有効化・登録は自動で行わない。

Stop/SubagentStop/SessionEndの共通payloadからevent名とcwdだけを確認し、設定されたログだけ読む。
ただしCodex SessionEndは最大3秒のためworkerを起動せずskipする。
Stopは当該turnのusage確定より先に発火し得る。終了後の取りこぼし防止には
[producer終了後収集](capture.md)を使い、hookだけで最終回収を認定しない。
payloadのtranscript_path、agent_transcript_path、本文・モデル名からパスやコマンドを作らない。
stop_hook_active時・cwd不一致では動作しない。設定hostは運用上の選択ラベルでありホスト認証ではない。
SDKログを供給していない普通の会話へこのhookを付けても、その会話のusageは取得できない。

stdin待ち最大1秒、収集worker最大3秒、任意の候補評価worker最大2秒。hook設定のtimeoutは
対応するイベントでは起動時間も含めて8秒以上を指定する。Codex SessionEndには登録しない。
例外・収集失敗でもstdout/stderrは空、exit 0。
decision:block、追加プロンプト、モデル呼出し、外部送信は一切行わない。
候補評価を接続する場合だけconfigにproposal: {input: 絶対パス, store: 別の専用絶対パス}を指定する。
比較用証拠ファイルはユーザー/計測系が用意し、hookが品質や条件を捏造して生成することはない。
収集成功はhook成功から推定せず、ledgerのmetrics/updated_atを確認する。

無効化はconfigのenabled=false、または登録したhookを削除する。既存データは勝手に消去しない。
実際のhostへの登録・trust承認・イベント発火・対象session照合の実測が終わるまで「自動収集済み」と言わない。

## Source checks (2026-09-09)

- [Codex JSON events](https://learn.chatgpt.com/docs/non-interactive-mode): turn.completedのusageを確認。
- [Codex hooks](https://learn.chatgpt.com/docs/hooks): transcriptは安定interfaceではなく、共通payloadにcwd等を持つ。
- [Claude cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking): step outputのplaceholder、resultとの粒度差を確認。
- [Claude hooks](https://code.claude.com/docs/en/hooks): Stop/SubagentStopのpayloadと本文の存在を確認。

これらは公式仕様の確認であり、ユーザーのインストール済みhost versionでのend-to-end保証ではない。
