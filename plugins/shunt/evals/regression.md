# 回帰表（上流ラベル vs fork 判定）

上流ラベルは 350 行規則の実装挙動そのもの。一致率で品質は測らない（NOTICE 参照）。
resolved_by=model は trace（API 応答由来の usage/responseId）で証明された判定。

| suite | id | name | upstream | fork | resolved_by | ms |
|---|---|---|---|---|---|---|
| check-bash-read | 1 | cat-large-file | block | block | model | 1137 |
| check-bash-read | 2 | cat-small-file | allow | allow | code | 33 |
| check-bash-read | 3 | cat-with-flag | block | block | model | 1190 |
| check-bash-read | 4 | head-large-file | block | allow **≠** | model | 1296 |
| check-bash-read | 5 | head-with-count | block | allow **≠** | model | 1231 |
| check-bash-read | 6 | tail-large-file | block | allow **≠** | model | 1229 |
| check-bash-read | 7 | less-large-file | block | block | model | 1338 |
| check-bash-read | 8 | cat-pipe | allow | allow | code | 19 |
| check-bash-read | 9 | cat-redirect | allow | allow | code | 18 |
| check-bash-read | 10 | non-read-command | allow | allow | code | 18 |
| check-bash-read | 11 | grep-command | allow | allow | code | 17 |
| check-bash-read | 12 | cat-quoted-path | block | block | model | 1555 |
| check-bash-read | 13 | cat-nonexistent | allow | allow | code | 30 |
| check-bash-read | 14 | empty-command | allow | allow | code | 11 |
| check-bash-read | 15 | missing-command-field | allow | allow | code | 10 |
| check-bash-read | 16 | more-large-file | block | block | model | 1250 |
| check-bash-read | 17 | head-n-space-count | allow | allow | code | 30 |
| check-file-size | 1 | small-file | allow | allow | code | 23 |
| check-file-size | 2 | boundary-exact-350 | allow | allow | code | 21 |
| check-file-size | 3 | just-over-threshold | block | allow **≠** | model | 1156 |
| check-file-size | 4 | large-file | block | block | model | 1170 |
| check-file-size | 5 | very-large-file | block | block | model | 1150 |
| check-file-size | 6 | empty-file | allow | allow | code | 30 |
| check-file-size | 7 | targeted-read-offset | allow | allow | code | 21 |
| check-file-size | 8 | targeted-read-limit | allow | allow | code | 19 |
| check-file-size | 9 | targeted-read-both | allow | allow | code | 19 |
| check-file-size | 10 | nonexistent-file | allow | allow | code | 19 |
| check-file-size | 11 | empty-filepath | allow | allow | code | 21 |
| check-file-size | 12 | missing-filepath-field | allow | allow | code | 19 |
| check-file-size | 13 | offset-zero | allow | allow | code | 19 |
| check-file-size | 14 | limit-zero | allow | allow | code | 19 |
| check-file-size | 15 | env-override-lower | block | allow **≠** | model | 1598 |
| check-file-size | 16 | env-override-higher | allow | allow | code | 30 |
| check-file-size | 17 | env-non-numeric-fallback | block | allow **≠** | model | 1269 |

差分 6 件:
- check-bash-read case 4 (head-large-file): upstream=block → fork=allow [model] — 上流の意図: head on large file — should block
- check-bash-read case 5 (head-with-count): upstream=block → fork=allow [model] — 上流の意図: head -100 — still a bulk read, block
- check-bash-read case 6 (tail-large-file): upstream=block → fork=allow [model] — 上流の意図: tail on large file — should block
- check-file-size case 3 (just-over-threshold): upstream=block → fork=allow [model] — 上流の意図: One line over threshold — should block
- check-file-size case 15 (env-override-lower): upstream=block → fork=allow [model] — 上流の意図: SHUNT_MIN_LINES=200 overrides default — 250-line file should block
- check-file-size case 17 (env-non-numeric-fallback): upstream=block → fork=allow [model] — 上流の意図: Non-numeric SHUNT_MIN_LINES falls back to 350 — 351-line file blocked
