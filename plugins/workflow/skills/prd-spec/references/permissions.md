# run の前の許可（permissions）

`/workflow:prd-spec-run` の run が止まるのは、依頼者の回答を待つゲートのほかは、agent の権限の確認と利用上限の待ちだけである
（本家の workflows の文書: 「To avoid prompts on a long run, add the tools the agents need to your allow rules before starting.」）。
prd-spec の agent は段ごとに doc_check を実行し、作業ディレクトリの外にある W を読み書きし、`[SKILL_DIR]` の役のファイルと契約を読む。
許可が無いと、manual モードではそのたびに run が確認で止まる。

skill は利用者の settings を書かない。settings を変えるかは利用者が決める（`.claude/rules/`・`CLAUDE.md` に触れるときに止まるのと同じ扱い）。
S0 で、次のどちらにするかを利用者に確かめる。

## 1. allow rule を足す

`[SKILL_DIR]` はこの skill の絶対パス（`/` で始まる）に置き換える。絶対パスの規則は `//` で始まるので、`Read(/[SKILL_DIR]/**)` は
置き換えた後に `Read(//…/prd-spec/**)` になる。

```
Bash(node [SKILL_DIR]/scripts/doc_check.mjs *)
Read(/[SKILL_DIR]/**)
Read(~/.claude/prd-spec-workspace/**)
Edit(~/.claude/prd-spec-workspace/**)
```

- 1 行目は、`workflows/prd-spec.js` の `cli()` と SKILL.md が実行させる doc_check の全モードの接頭辞である（tests が `cli()` と照合する）。
- 規則は doc_check の接頭辞と W の親ディレクトリに限る。広げると、prd-spec の外の操作まで確認なしに通る。
- `precedent.py` は S0 で司令塔が 1 回実行するだけなので、規則に入れない（run の途中では止まらない）。

## 2. auto mode

本家の blog は dynamic workflows を auto mode で使うことを勧める。ただし auto mode の classifier は protected directory への書き込みを
審査し、`agent()` に渡したプロンプトは利用者の依頼として数えない（本家の workflows の文書）。W は `~/.claude/` の下にあるので、
W への書き込みか doc_check の実行が止められるかを実機で確かめるまで、auto mode は選択肢として勧めない。確かめるまでは 1 を使う。
