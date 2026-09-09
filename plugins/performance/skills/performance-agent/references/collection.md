# Explicit local collection (preview)

保存を依頼された場合のみ、保存先を明示して同梱のcollect.pyを実行する。
通常の計測は引き続きmeasure.pyだけで行い、保存はしない。

```sh
python3 [SKILL_DIR]/scripts/collect.py normalized <usage.jsonl> --store <private-directory>
python3 [SKILL_DIR]/scripts/collect.py workflow <closed-run-directory> --store <private-directory>
```

保存先は信頼する親ディレクトリ配下の専用領域。leafは所有者本人の0700 directory、
保存ファイルは0600 regular fileで、symlink/hardlinkを拒否する。親ディレクトリを
第三者が変更できる環境は対象外。新規leafだけ自動作成し、既存の権限は変更しない。
Linux/macOS向けでfcntl/O_NOFOLLOWを使用する。Windowsは未対応。

保存するのはmeasure.pyの集計結果、入力証拠のdigestから得るID、収集時刻、adapter名だけ。
prompt、tool本文、入力path、正規化レコードの生IDは保存・表示しない。通信・LLM呼出しなし。
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
通常例外で一時ファイルを除去するが、強制kill・電源断時の.pending残骸の回収は未実装。
全ディレクトリ容量制御、常駐TTL削除、稼働中ログのtail/rotate、hookイベントadapter、
収集失敗回数の継続集計は未実装。このため自動hooksの有効化条件を満たしていない。
