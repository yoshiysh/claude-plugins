# 回帰表（上流ラベル vs fork 判定）

上流ラベルは 350 行規則の実装挙動そのもの。一致率で品質は測らない（NOTICE 参照）。
resolved_by=model は、そのケースで trace に追記された API 試行の outcome が decided だった判定。
fallback はモデルに問えず行数規則で決まった判定で、http / error_status にその API 試行の失敗理由（例: 429 RESOURCE_EXHAUSTED）が出る。API 試行が無ければ空欄（preflight 失敗 or code 確定）。
API を叩きうるケースの間は 4.5 秒空けて実行した（SHUNT_REGRESSION_MIN_INTERVAL_SECONDS）。

| suite | id | name | upstream | fork | resolved_by | http | error_status | ms |
|---|---|---|---|---|---|---|---|---|
| check-bash-read | 1 | cat-large-file | block | block | model | 200 |  | 1314 |
| check-bash-read | 2 | cat-small-file | allow | allow | code |  |  | 49 |
| check-bash-read | 3 | cat-with-flag | block | block | model | 200 |  | 1281 |
| check-bash-read | 4 | head-large-file | block | block | model | 200 |  | 1359 |
| check-bash-read | 5 | head-with-count | block | block | model | 200 |  | 1433 |
| check-bash-read | 6 | tail-large-file | block | block | model | 200 |  | 1330 |
| check-bash-read | 7 | less-large-file | block | block | model | 200 |  | 1268 |
| check-bash-read | 8 | cat-pipe | allow | allow | code |  |  | 37 |
| check-bash-read | 9 | cat-redirect | allow | allow | code |  |  | 19 |
| check-bash-read | 10 | non-read-command | allow | allow | code |  |  | 19 |
| check-bash-read | 11 | grep-command | allow | allow | code |  |  | 17 |
| check-bash-read | 12 | cat-quoted-path | block | block | model | 200 |  | 1203 |
| check-bash-read | 13 | cat-nonexistent | allow | allow | code |  |  | 47 |
| check-bash-read | 14 | empty-command | allow | allow | code |  |  | 9 |
| check-bash-read | 15 | missing-command-field | allow | allow | code |  |  | 8 |
| check-bash-read | 16 | more-large-file | block | block | model | 200 |  | 1270 |
| check-bash-read | 17 | head-n-space-count | allow | allow | code |  |  | 52 |
| check-bash-read | 18 | cat-quoted-path-with-space | block | block | model | 200 |  | 1370 |
| check-bash-read | 19 | cat-complex-code-over-threshold | allow | allow | model | 200 |  | 1228 |
| check-bash-read | 20 | cat-simple-log-over-threshold | block | block | model | 200 |  | 1436 |
| check-bash-read | 21 | head-complex-code-small-slice | allow | allow | model | 200 |  | 1431 |
| check-bash-read | 22 | cat-simple-data-under-threshold | allow | allow | code |  |  | 41 |
| check-bash-read | 23 | sh-c-wrapped-more-large | block | block | model | 200 |  | 1252 |
| check-bash-read | 24 | absolute-path-more-large | block | block | model | 200 |  | 1288 |
| check-bash-read | 25 | zsh-lc-wrapped-cat-large | block | block | model | 200 |  | 1304 |
| check-bash-read | 26 | sh-c-wrapped-cat-small | allow | allow | code |  |  | 58 |
| check-bash-read | 27 | sh-c-wrapped-cat-piped-outside | allow | allow | code |  |  | 15 |
| check-bash-read | 28 | sh-runs-script-file | allow | allow | code |  |  | 21 |
| check-bash-read | 29 | bash-O-option-wrapped-cat-large | block | block | model | 200 |  | 1316 |
| check-bash-read | 30 | bash-rcfile-wrapped-cat-large | block | block | model | 200 |  | 1277 |
| check-bash-read | 31 | bash-sh-two-level-nested-cat-large | block | block | model | 200 |  | 1514 |
| check-bash-read | 32 | bash-sh-escaped-quote-cat-large | block | block | code |  |  | 43 |
| check-bash-read | 33 | cat-large-stderr-to-devnull | block | block | model | 200 |  | 1167 |
| check-bash-read | 34 | cat-large-stderr-to-stdout | block | block | model | 200 |  | 1225 |
| check-bash-read | 35 | cat-large-stdout-to-stderr | block | block | model | 200 |  | 1261 |
| check-bash-read | 36 | cat-large-append-to-file | allow | allow | code |  |  | 38 |
| check-bash-read | 37 | cat-large-both-to-file | allow | allow | code |  |  | 18 |
| check-bash-read | 38 | sh-c-wrapped-cat-large-stderr-to-devnull | block | block | model | 200 |  | 1363 |
| check-bash-read | 39 | cat-simple-log-exact-purpose | allow | allow | model | 200 |  | 1347 |
| check-bash-read | 40 | cat-simple-log-overview-purpose | block | block | model | 200 |  | 1418 |
| check-file-size | 1 | small-file | allow | allow | code |  |  | 45 |
| check-file-size | 2 | boundary-exact-350 | allow | allow | code |  |  | 21 |
| check-file-size | 3 | just-over-threshold | block | block | model | 200 |  | 1216 |
| check-file-size | 4 | large-file | block | block | model | 200 |  | 1347 |
| check-file-size | 5 | very-large-file | block | block | model | 200 |  | 1364 |
| check-file-size | 6 | empty-file | allow | allow | code |  |  | 43 |
| check-file-size | 7 | targeted-read-offset | allow | allow | code |  |  | 19 |
| check-file-size | 8 | targeted-read-limit | allow | allow | code |  |  | 16 |
| check-file-size | 9 | targeted-read-both | allow | allow | code |  |  | 14 |
| check-file-size | 10 | nonexistent-file | allow | allow | code |  |  | 14 |
| check-file-size | 11 | empty-filepath | allow | allow | code |  |  | 14 |
| check-file-size | 12 | missing-filepath-field | allow | allow | code |  |  | 13 |
| check-file-size | 13 | offset-zero | allow | allow | code |  |  | 13 |
| check-file-size | 14 | limit-zero | allow | allow | code |  |  | 14 |
| check-file-size | 15 | env-override-lower | block | block | model | 200 |  | 1261 |
| check-file-size | 16 | env-override-higher | allow | allow | code |  |  | 45 |
| check-file-size | 17 | env-non-numeric-fallback | block | block | model | 200 |  | 1263 |

差分 0 件:
