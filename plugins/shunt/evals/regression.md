# 回帰表（上流ラベル vs fork 判定）

上流ラベルは 350 行規則の実装挙動そのもの。一致率で品質は測らない（NOTICE 参照）。
resolved_by=model は trace（API 応答由来の usage/responseId）で証明された判定。

| suite | id | name | upstream | fork | resolved_by | ms |
|---|---|---|---|---|---|---|
| check-bash-read | 1 | cat-large-file | block | block | model | 1357 |
| check-bash-read | 2 | cat-small-file | allow | allow | code | 29 |
| check-bash-read | 3 | cat-with-flag | block | block | model | 1318 |
| check-bash-read | 4 | head-large-file | block | block | model | 1288 |
| check-bash-read | 5 | head-with-count | block | block | model | 1241 |
| check-bash-read | 6 | tail-large-file | block | block | model | 1284 |
| check-bash-read | 7 | less-large-file | block | block | model | 1368 |
| check-bash-read | 8 | cat-pipe | allow | allow | code | 16 |
| check-bash-read | 9 | cat-redirect | allow | allow | code | 14 |
| check-bash-read | 10 | non-read-command | allow | allow | code | 15 |
| check-bash-read | 11 | grep-command | allow | allow | code | 13 |
| check-bash-read | 12 | cat-quoted-path | block | block | model | 1396 |
| check-bash-read | 13 | cat-nonexistent | allow | allow | code | 31 |
| check-bash-read | 14 | empty-command | allow | allow | code | 11 |
| check-bash-read | 15 | missing-command-field | allow | allow | code | 10 |
| check-bash-read | 16 | more-large-file | block | block | model | 1467 |
| check-bash-read | 17 | head-n-space-count | allow | allow | code | 29 |
| check-bash-read | 18 | cat-quoted-path-with-space | block | block | model | 1245 |
| check-file-size | 1 | small-file | allow | allow | code | 27 |
| check-file-size | 2 | boundary-exact-350 | allow | allow | code | 21 |
| check-file-size | 3 | just-over-threshold | block | block | model | 1276 |
| check-file-size | 4 | large-file | block | block | model | 1313 |
| check-file-size | 5 | very-large-file | block | block | model | 1248 |
| check-file-size | 6 | empty-file | allow | allow | code | 26 |
| check-file-size | 7 | targeted-read-offset | allow | allow | code | 17 |
| check-file-size | 8 | targeted-read-limit | allow | allow | code | 15 |
| check-file-size | 9 | targeted-read-both | allow | allow | code | 15 |
| check-file-size | 10 | nonexistent-file | allow | allow | code | 14 |
| check-file-size | 11 | empty-filepath | allow | allow | code | 14 |
| check-file-size | 12 | missing-filepath-field | allow | allow | code | 14 |
| check-file-size | 13 | offset-zero | allow | allow | code | 14 |
| check-file-size | 14 | limit-zero | allow | allow | code | 14 |
| check-file-size | 15 | env-override-lower | block | block | model | 1317 |
| check-file-size | 16 | env-override-higher | allow | allow | code | 26 |
| check-file-size | 17 | env-non-numeric-fallback | block | block | model | 1350 |

差分 0 件:
