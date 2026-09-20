# 回帰表（上流ラベル vs fork 判定）

上流ラベルは 350 行規則の実装挙動そのもの。一致率で品質は測らない（NOTICE 参照）。
resolved_by=model は trace（API 応答由来の usage/responseId）で証明された判定。

| suite | id | name | upstream | fork | resolved_by | ms |
|---|---|---|---|---|---|---|
| check-bash-read | 1 | cat-large-file | block | block | model | 1241 |
| check-bash-read | 2 | cat-small-file | allow | allow | code | 34 |
| check-bash-read | 3 | cat-with-flag | block | block | model | 1208 |
| check-bash-read | 4 | head-large-file | block | allow **≠** | model | 1295 |
| check-bash-read | 5 | head-with-count | block | allow **≠** | model | 1238 |
| check-bash-read | 6 | tail-large-file | block | block | model | 1206 |
| check-bash-read | 7 | less-large-file | block | block | model | 1339 |
| check-bash-read | 8 | cat-pipe | allow | allow | code | 57 |
| check-bash-read | 9 | cat-redirect | allow | allow | code | 22 |
| check-bash-read | 10 | non-read-command | allow | allow | code | 16 |
| check-bash-read | 11 | grep-command | allow | allow | code | 16 |
| check-bash-read | 12 | cat-quoted-path | block | block | model | 1348 |
| check-bash-read | 13 | cat-nonexistent | allow | allow | code | 30 |
| check-bash-read | 14 | empty-command | allow | allow | code | 10 |
| check-bash-read | 15 | missing-command-field | allow | allow | code | 10 |
| check-bash-read | 16 | more-large-file | block | block | model | 1510 |
| check-bash-read | 17 | head-n-space-count | allow | allow | code | 35 |
| check-bash-read | 18 | cat-quoted-path-with-space | block | block | model | 1311 |
| check-file-size | 1 | small-file | allow | allow | code | 30 |
| check-file-size | 2 | boundary-exact-350 | allow | allow | code | 23 |
| check-file-size | 3 | just-over-threshold | block | block | model | 1297 |
| check-file-size | 4 | large-file | block | block | model | 1199 |
| check-file-size | 5 | very-large-file | block | block | model | 1249 |
| check-file-size | 6 | empty-file | allow | allow | code | 29 |
| check-file-size | 7 | targeted-read-offset | allow | allow | code | 21 |
| check-file-size | 8 | targeted-read-limit | allow | allow | code | 19 |
| check-file-size | 9 | targeted-read-both | allow | allow | code | 19 |
| check-file-size | 10 | nonexistent-file | allow | allow | code | 18 |
| check-file-size | 11 | empty-filepath | allow | allow | code | 18 |
| check-file-size | 12 | missing-filepath-field | allow | allow | code | 19 |
| check-file-size | 13 | offset-zero | allow | allow | code | 19 |
| check-file-size | 14 | limit-zero | allow | allow | code | 19 |
| check-file-size | 15 | env-override-lower | block | block | model | 1179 |
| check-file-size | 16 | env-override-higher | allow | allow | code | 31 |
| check-file-size | 17 | env-non-numeric-fallback | block | block | model | 1303 |

差分 2 件:
- check-bash-read case 4 (head-large-file): upstream=block → fork=allow [model] — 上流の意図: head on large file — should block
- check-bash-read case 5 (head-with-count): upstream=block → fork=allow [model] — 上流の意図: head -100 — still a bulk read, block
