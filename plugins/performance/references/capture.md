# Explicit producer capture

## When to use

ユーザーが新規の実行と使用量計測を依頼した場合のみ使う。ログ分析だけなら起動しない。
`capture.py` は明示されたargvをshellなしで一度実行し、stdout EOFと直接の子プロセスの終了を
確認した後、残りのイベントを増分collectorへ最大32batchで渡す。モデル名・プログラム名・
workflowファイル名は固定しない。引数はユーザーの許可範囲内で親が構成し、ログから生成しない。

```sh
python3 [PLUGIN_DIR]/scripts/capture.py --adapter <adapter> --store <new-private-ledger> --timeout 60 -- <producer> <arguments...>
```

adapterは `codex-exec`、`claude-query`、`normalized` の明示選択。
producerはその形式のJSONLだけをstdoutへ出す。stderrは保存・表示せず破棄する。
作業directory・認証・環境変数は呼出し元を継承するため、必要な設定隔離は親が行う。
このラッパーはsandboxではない。許可されていないコマンドや高額な推論を安全にするものではない。
モデル・SDKの利用に外部通信が必要なら、その実行許可に含まれる範囲でproducerが行う。

## Bounds and evidence

保存先は未作成の専用directoryのみ。既存保存先は起動前に拒否し、上書きしない。
stdinは閉じ、バックグラウンド化しない。制限はstdout最大16MiB、実行時間既定60秒・最大300秒。
時間超過・容量超過時は開始したprocess groupを停止する。別sessionへ離脱した子孫の停止や
ホスト側の非同期処理完了は保証しない。stdoutを保持した子孫が残る場合もtimeoutにする。
ラッパー自身がSIGKILLされた場合、実行中producerの停止や時間制限は保証しない。
常駐watchdogではなく、終了したproducerを自動で再実行する仕組みでもない。

イベント本文を含むstdoutはPOSIXの匿名一時ファイル（作成直後unlink、0600）へ一時保存する。
開いたFDをcollectorへ渡し、本文を持つpathnameを残さない。ラッパー自身のSIGKILLでも
孤立したrawログは残らない。ただしディスクへの一時書込自体やOSのswap・crash dumpを
防ぐ保証ではない。機密本文を一時保存できないタスクには使用しない。
ledgerは本文・コマンド・元pathを持たず、使用量とhash化された識別子のみ。

`collected` はproducer exit 0、JSONL EOF、native adapterの終端、非空の観測を確認した状態。
モデルの品質合格、未観測subagent、課金総額、全ホスト活動の捕捉は意味しない。
非0終了は `producer_failed`。その場合も有効な終端に付いた既知usageはreportへ残す。
失敗イベントのusage欠損、品質未計測、measurement_complete=nullは0やtrueに変換しない。
途中行、終端欠損、収集失敗、spawn失敗、timeout、容量超過は `capture_failed`。
途中batchがledgerへ保存済みでも、この返却値を完了に読み替えない。
stderrを保存しないため、失敗理由の詳細調査は別途明示した診断が必要。

出力の `elapsed_ms` は起動前から最終収集までのwall timeで、モデルだけの推論時間ではない。
本処理の再実行は新しいproducer実行になる。自動retry・resume・二重実行防止は提供しない。

## Hook boundary

Codex 0.153.4の実測ではStopがturn.completedより先に発火した。
Stop/SubagentStopは既存ログの途中収集だけに使い、当該turnを回収済みと認定しない。
Codex SessionEndは最大3秒で、この汎用hookのworker budgetを満たさないので処理をskipする。
最終収集はこのproducer-owner経路を使う。短いsleepでevent到着を推測しない。
常設hook・SDKログ供給の無い通常会話へ、このラッパーを自動挿入する仕組みではない。
