# Measurement contract v1

## 入力と出力

`measure.py workflow RUN_DIR` は信頼できる静止した runtime run の request.json と
events.jsonl を読み、`measure.py normalized FILE` は正規化済み JSONL を読む。
任意名の source に対応し、source 自体を実行しない。ログ形式を自動推測しない。
ファイルは regular file、各最大32 MiB、JSONL の各行は最大1 MiB。
実ログをテスト fixture や Git に複製しない。stdout は数値・状態と匿名IDのみ。

正規化の1行は次の形（全キー必須、追加キー不可）。

```json
{"version":1,"source":"example","run_id":"run-1","call_id":"call-1","input_tokens":100,"cached_input_tokens":40,"output_tokens":20}
```

各行は単一呼出しの完了時点の差分使用量。累積スナップショットや親集計は投入しない。
source/run_id/call_id の組を一意なIDとする。同じIDの同じ値は1件、異なる値はエラー。
別 source に同一呼出しがある場合はIDだけでは突合できないため混ぜない。
この境界を保証できない収集元は正規化アダプターで拒否する。
各 token は0以上の整数（bool不可）、cache <= input。cacheはinputの内数。
推定料金、account quota、context peak は計算しない。

出力は performance-report/v1。usage の合計は観測した完了呼出しのみ。
観測できた呼出しが0件ならusageはnullであり、使用量ゼロとは判断しない。
`uncached_input_tokens = input_tokens - cached_input_tokens` は算術差分であり請求額ではない。
`measurement_complete` はworkflowの全started担当の完了使用量が1件ずつ揃ったときだけtrue。
これは全モデル要求・全外部子実行を捕捉した保証ではない。
normalized形式では母数を知らないためnull。完了結果があってもusageが無ければ欠損。
実行の成否と計測の完全性は別。run.failedでも取得済みusageは保持する。

## Workflow adapter

requestとjournalのSHA-256をevidence_digestに束ねる。これは真正性を保証しない。
run_idはrequestのバイト列のdigest。入力path・prompt・result・tool本文は出力しない。
イベントsequence、started/terminalの位置、担当start/outcomeを検証する。
成功終端で未終了担当があるrunはこのアダプターでは拒否する（未awaitで返るworkflowも対象外）。
JSONの同名キー重複は、外側・内側とも不明確な証拠として拒否する。
agent.eventのturn.completedだけを使用量とする。SDKのinput/cache/outputが欠けた場合は
その担当の使用量を欠損扱い。stream全体のtoken合計など別粒度の値は加算しない。
異なるrunが同一requestを使用した場合でも、このCLIはrunを横断して合算しない。
duration_msはrun.startedから終端までの壁時計差で、並列担当の時間の合計ではない。
逆行・時刻欠損はnull。モデル・スキル・品質の比較可能性は自動認定しない。

## プライバシーと失敗

保存・通信はしない。例外に本文やpathを含めず固定コードを返す。
入力は改ざんされうる。結果からコマンドや改善変更を自動実行しない。
集計失敗は非ゼロ終了。将来のhookはそれを計測欠損として取り扱い、本来の作業を止めない。
稼働中ログのtail、rotate、lock、増分checkpointはこの版では未対応。
