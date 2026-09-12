# Explicit local collection (preview)

保存を依頼された場合のみ、保存先を明示して同梱のcollect.pyを実行する。
通常の計測は引き続きmeasure.pyだけで行い、保存はしない。

```sh
python3 [PLUGIN_DIR]/scripts/collect.py normalized <usage.jsonl> --store <private-directory>
python3 [PLUGIN_DIR]/scripts/collect.py workflow <closed-run-directory> --store <private-directory>
```

保存先は信頼する親ディレクトリ配下の専用領域。leafは所有者本人の0700 directory、
保存ファイルは0600 regular fileで、symlink/hardlinkを拒否する。親ディレクトリを
第三者が変更できる環境は対象外。新規leafだけ自動作成し、既存の権限は変更しない。
Linux/macOS向けでfcntl/O_NOFOLLOWを使用する。Windowsは未対応。

保存するのはmeasure.pyの集計結果、入力証拠のdigestから得るID、収集時刻、adapter名だけ。
prompt、tool本文、入力path、正規化レコードの生IDは保存・表示しない。通信・LLM呼出しなし。
新規・既存snapshotはadapter別の許可キー、値の型、token・件数・完全性の整合性を検証する。
既存データは期限削除前に全件検証し、未知の本文フィールドや破損を検出したら元ファイルを
変更せず失敗する。これはschema検証であり、正しい形の数値の捏造を検知する署名ではない。
既定30日、最大1000snapshot、snapshots.jsonは最大1MiB。
`--retention-days`は1〜365、`--max-records`は1〜1000。期限超過と件数超過は次回収集時に
古い順で削除する。期限到来時に常駐処理が自動削除するわけではない。
容量超過・破損・排他競合は非ゼロ終了。計測失敗を0使用量に変えない。
stdoutのcollector_duration_msは今回の収集処理だけの壁時計時間で、モデルの性能ではない。

同じadapter・同じ証拠バイト列のsnapshotは1件。再収集で保存期限を延長しない。
別ファイル、更新版のログ、異なるrunの重複呼出しを突合した保証はない。
**snapshotを合算して総トークン数にしない**。run横断のcanonical identityは今後のadapterで定義する。
失敗後の同じ証拠の再実行は可能だが、期限削除後は再度新規snapshotになる。

排他は待機せず失敗し、書込は一時ファイルをfsync後にatomic replaceする。
replace後のfsyncエラーは結果不確定（保存済みの可能性あり）。同じ証拠で再収集して確認する。
一時ファイルの削除に失敗しても排他lockは解放し、後続の明示再実行を妨げない。
一時ファイルは予約名.pending-snapshotの1つだけを使用する。排他取得後、既存snapshotの検証と
新しい保存内容の容量検証が通った場合に、その予約ファイルだけを回収する。
所有者本人のprivate regular fileであることを確認し、symlink/hardlinkは拒否する。
専用保存先にはこの予約名のユーザーファイルを置かない。recovered_pendingで回収の有無を返す。
正常な専用保存先ではsnapshotとpendingの各最大1MiB、lockは空で、収集処理が作る
データ本文は最大2MiB（filesystemの割当・メタデータを除く）。
旧版のランダム名.pending-*や不明ファイルは自動削除しない。それらを含む全容量の保証はない。
別プロセスの強制終了とreplace後fsync失敗の再実行をテストしたが、実機の電源断は未検証。
このsnapshot形式には全ディレクトリ容量制御・常駐TTL削除・増分読込・hook接続・失敗回数の
継続集計を追加しない。増分処理は別storeの[ledger](incremental.md)が担当し、snapshotを合算しない。
