# 保存プロトタイプの検証範囲

これは formal-method の実装案を試す、合成データ専用の stdlib Rust プロトタイプである。スキル本体・Notion 保存・運用環境への組み込みは行っていない。

`durable_storage.rs` が保存形式と保存手順の正本である。`Record` は停止時の本文を一つだけ保持し、遅れて到着した結果を `late_results` として同じ run/job に結び付ける。既存本文・照合キー・run/job の変更と結果列の巻き戻しを拒否する。保存済み本文を遅延結果で書き換えない。実行単位ごとに別の保存先を使い、単一 writer が保存と回復を排他的に呼ぶことを前提とする。このプロトタイプには排他ロック、認証、janitor、期限による削除、保存形式の移行はない。

保存は同じディレクトリの `pending` を排他的に作成し、全内容を書き、ファイルを sync し、`record` へ rename し、親ディレクトリを sync する。公開前の失敗は `BeforeCommit`、rename 後の失敗は `CommitUncertain` を返す。後者では新しい内容が既に見えるため、「失敗なら以前の内容が必ず残る」とは扱わず、再読込して状態を確認する。再起動時の `recover_pending` は未公開の一時ファイルだけを除去する。

読込は形式バージョン、長さ、UTF-8、サイズ上限と checksum を検査する。不正なら再利用も上書きも拒否する。checksum は偶発的な破損の検出用であり、改ざん耐性の証明ではない。`reusable` は run/job/照合キーの完全一致だけを判定する。照合キーに必要な各要素を正しく符号化したことや、期限の妥当性を保存部品自身では検証しない。`DeletionRequest::User` は明示的な削除入口の区別であり、実際の利用者認証・承認の検証ではない。外部プロセスや利用者によるファイル削除を防がず、無期限保持を実機で証明したものでもない。

## 抽象モデルと実コードの対応

`storage.smt2` の stage は untouched → temporary created → written → file synced → rename published → directory synced の境界である。`previous`/`proposed`/`recovered` は旧・新・再読込された正規レコード、`report_before`/`report_after` は停止時本文を抽象化する。rename の原子性、単一 writer、正常なファイルシステム API の意味はモデルの仮定である。

`storage_checks.rs` は各不変条件の否定を Z3 に渡し、正しいモデルで UNSAT、対応する欠陥を有効にしたモデルで SAT を要求する。公開前の旧レコード回復、公開後かつ未確認の新レコード回復には SAT の到達可能性検査も置く。これは境界間の抽象プロトコルの検査である。Rust の各命令と抽象遷移の対応は上記の対応表をコードと照合するレビュー対象であり、自動抽出された refinement proof ではない。テスト成功を形式証明とは扱わない。

## 実ファイル試験

同じディレクトリで次を実行する。コンパイラの位置は環境に合わせて指定する。

```sh
rustc --edition=2021 --test durable_storage_tests.rs -o /tmp/formal-durable-storage-tests
/tmp/formal-durable-storage-tests --test-threads=1
```

2026-11-06 の builder 実行では 10 tests passed、0 failed、0 ignored。一時ディレクトリと合成データだけを使った。正常保存→再読込→遅延結果追加、照合不一致、本文不変、結果巻き戻し拒否、破損・切断・版違い、明示削除、古い部分書込の回復、OS の create/rename エラーを確認した。各保存境界に失敗を注入し、公開前は旧レコードのバイト列がそのまま残り、公開後は uncertain と新レコードになることを確認した。各境界で別プロセスを exit(73) させ、親プロセスがディスクから再読込・一時ファイル回復・再保存できることも確認した。

障害注入は syscall の実際の EIO や short-write を発生させたものではない。実際の create/rename 失敗は別ケースで確認し、部分書込は不完全な pending ファイルを作って確認した。プロセス exit は OS の電源断・SIGKILL・媒体故障ではない。ディスクコントローラの永続性、実際の電源断後のディレクトリ回復、NFS/Windows、競合 writer、サイズ上限の全境界、OS による sync エラーは未検証である。プラットフォーム上の sync 成功だけでハードウェアの永続性を保証したとは報告しない。

独立レビュー後、既存の `record` がディレクトリの場合のテスト名を `existing_directory_is_rejected_before_staging` に訂正し、pending が作られないことを確認した。このケースは rename の試験ではない。実際の rename エラーは `os_rename_failure_before_first_commit` で、Rename 境界への到達、pending の存在、初回保存先の不存在を確認してから保存先をディレクトリにして発生させる。この試験には以前の正規レコードはなく、旧レコード保持の根拠は別の境界障害注入試験である。

追加試験 `os_rename_source_disappearance_preserves_existing_record` では、旧レコードを保存後、Rename 境界で file sync 済みの pending を意図的に除去する。実際の rename が NotFound を返し、旧レコードの生バイト列・再読込結果が不変で、再保存が成功することを確認した。これは rename の source-disappearance によるファイルシステム障害注入であり、権限エラーや媒体故障の再現ではない。追加後の builder 再実行は 11 tests passed、0 failed、0 ignored。
