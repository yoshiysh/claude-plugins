# 回帰表（上流ラベル vs fork 判定）

上流ラベルは 350 行規則の実装挙動そのもの。一致率で品質は測らない（NOTICE 参照）。
resolved_by=model は、そのケースで trace に追記された API 試行の outcome が decided だった判定。
fallback はモデルに問えず行数規則で決まった判定で、http / error_status にその API 試行の失敗理由（例: 429 RESOURCE_EXHAUSTED）が出る。API 試行が無ければ空欄（preflight 失敗 or code 確定）。
API を叩きうるケースの間は 4.5 秒空けて実行した（SHUNT_REGRESSION_MIN_INTERVAL_SECONDS）。

| suite | id | name | upstream | fork | resolved_by | http | error_status | ms |
|---|---|---|---|---|---|---|---|---|
| bash-read-gate | 1 | cat-large-file | block | block | model | 200 |  | 1314 |
| bash-read-gate | 2 | cat-small-file | allow | allow | code |  |  | 49 |
| bash-read-gate | 3 | cat-with-flag | block | block | model | 200 |  | 1281 |
| bash-read-gate | 4 | head-large-file | block | block | model | 200 |  | 1359 |
| bash-read-gate | 5 | head-with-count | block | block | model | 200 |  | 1433 |
| bash-read-gate | 6 | tail-large-file | block | block | model | 200 |  | 1330 |
| bash-read-gate | 7 | less-large-file | block | block | model | 200 |  | 1268 |
| bash-read-gate | 8 | cat-pipe | allow | allow | code |  |  | 37 |
| bash-read-gate | 9 | cat-redirect | allow | allow | code |  |  | 19 |
| bash-read-gate | 10 | non-read-command | allow | allow | code |  |  | 19 |
| bash-read-gate | 11 | grep-command | allow | allow | code |  |  | 17 |
| bash-read-gate | 12 | cat-quoted-path | block | block | model | 200 |  | 1203 |
| bash-read-gate | 13 | cat-nonexistent | allow | allow | code |  |  | 47 |
| bash-read-gate | 14 | empty-command | allow | allow | code |  |  | 9 |
| bash-read-gate | 15 | missing-command-field | allow | allow | code |  |  | 8 |
| bash-read-gate | 16 | more-large-file | block | block | model | 200 |  | 1270 |
| bash-read-gate | 17 | head-n-space-count | allow | allow | code |  |  | 52 |
| bash-read-gate | 18 | cat-quoted-path-with-space | block | block | model | 200 |  | 1370 |
| bash-read-gate | 19 | cat-complex-code-over-threshold | allow | allow | model | 200 |  | 1228 |
| bash-read-gate | 20 | cat-simple-log-over-threshold | block | block | model | 200 |  | 1436 |
| bash-read-gate | 21 | head-complex-code-small-slice | allow | allow | model | 200 |  | 1431 |
| bash-read-gate | 22 | cat-simple-data-under-threshold | allow | allow | code |  |  | 41 |
| bash-read-gate | 23 | sh-c-wrapped-more-large | block | block | model | 200 |  | 1252 |
| bash-read-gate | 24 | absolute-path-more-large | block | block | model | 200 |  | 1288 |
| bash-read-gate | 25 | zsh-lc-wrapped-cat-large | block | block | model | 200 |  | 1304 |
| bash-read-gate | 26 | sh-c-wrapped-cat-small | allow | allow | code |  |  | 58 |
| bash-read-gate | 27 | sh-c-wrapped-cat-piped-outside | allow | allow | code |  |  | 15 |
| bash-read-gate | 28 | sh-runs-script-file | allow | allow | code |  |  | 21 |
| bash-read-gate | 29 | bash-O-option-wrapped-cat-large | block | block | model | 200 |  | 1316 |
| bash-read-gate | 30 | bash-rcfile-wrapped-cat-large | block | block | model | 200 |  | 1277 |
| bash-read-gate | 31 | bash-sh-two-level-nested-cat-large | block | block | model | 200 |  | 1514 |
| bash-read-gate | 32 | bash-sh-escaped-quote-cat-large | block | block | code |  |  | 43 |
| bash-read-gate | 33 | cat-large-stderr-to-devnull | block | block | model | 200 |  | 1167 |
| bash-read-gate | 34 | cat-large-stderr-to-stdout | block | block | model | 200 |  | 1225 |
| bash-read-gate | 35 | cat-large-stdout-to-stderr | block | block | model | 200 |  | 1261 |
| bash-read-gate | 36 | cat-large-append-to-file | allow | allow | code |  |  | 38 |
| bash-read-gate | 37 | cat-large-both-to-file | allow | allow | code |  |  | 18 |
| bash-read-gate | 38 | sh-c-wrapped-cat-large-stderr-to-devnull | block | block | model | 200 |  | 1363 |
| bash-read-gate | 39 | cat-simple-log-exact-purpose | block | block | model | 200 |  | 1347 |
| bash-read-gate | 40 | cat-simple-log-overview-purpose | block | block | model | 200 |  | 1418 |
| read-gate | 1 | small-file | allow | allow | code |  |  | 45 |
| read-gate | 2 | boundary-exact-350 | allow | allow | code |  |  | 21 |
| read-gate | 3 | just-over-threshold | block | block | model | 200 |  | 1216 |
| read-gate | 4 | large-file | block | block | model | 200 |  | 1347 |
| read-gate | 5 | very-large-file | block | block | model | 200 |  | 1364 |
| read-gate | 6 | empty-file | allow | allow | code |  |  | 43 |
| read-gate | 7 | targeted-read-offset | allow | allow | code |  |  | 19 |
| read-gate | 8 | targeted-read-limit | allow | allow | code |  |  | 16 |
| read-gate | 9 | targeted-read-both | allow | allow | code |  |  | 14 |
| read-gate | 10 | nonexistent-file | allow | allow | code |  |  | 14 |
| read-gate | 11 | empty-filepath | allow | allow | code |  |  | 14 |
| read-gate | 12 | missing-filepath-field | allow | allow | code |  |  | 13 |
| read-gate | 13 | offset-zero | allow | allow | code |  |  | 13 |
| read-gate | 14 | limit-zero | allow | allow | code |  |  | 14 |
| read-gate | 15 | env-override-lower | block | block | model | 200 |  | 1261 |
| read-gate | 16 | env-override-higher | allow | allow | code |  |  | 45 |
| read-gate | 17 | env-non-numeric-fallback | block | block | model | 200 |  | 1263 |

差分 0 件:
