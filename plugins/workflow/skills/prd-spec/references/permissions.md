# run の前の許可（permissions）

`/workflow:prd-spec-run` の run が止まるのは、依頼者の回答を待つゲートのほかは、agent の権限の確認と利用上限の待ちだけである
（本家の workflows の文書: 「To avoid prompts on a long run, add the tools the agents need to your allow rules before starting.」）。
prd-spec の agent は段ごとに doc_check を実行し、W（置き場は SKILL.md S0 の 2）を読み書きし、`[SKILL_DIR]` の役のファイルと契約を読む。

skill は利用者の settings を書かない。settings を変えるかは利用者が決める（`.claude/rules/`・`CLAUDE.md` に触れるときに止まるのと同じ扱い）。
S0 で、この文書の前提と規則を示して確かめる。

## 前提: auto mode で走らせる

install した plugin の W は `~/.claude/` の下（plugin の install 先）にあり、`~/.claude/` は protected path である。本家の permission modes の
文書は protected path への書き込みを、auto mode では classifier に回し、`default`・`acceptEdits` では確認を出し、`dontAsk` では拒むとし、
allow rule について次のように書く:

> `permissions.allow` rules in settings files do not pre-approve protected-path writes.

このため W への Write・Edit は allow rule では通せず、下の規則に入れない。agent の Write・Edit（writer の文書、intake の plan.json）は
auto mode では classifier が審査する。doc_check が Bash の process の中で書く台帳は、Write・Edit のパスの検査を通らず、Bash の規則で決まる。

prd-spec は auto mode で走らせることを前提にする。manual（`default`）・`acceptEdits` で走らせるときは、W への最初の書き込みの確認で
本家の文書の次の選択肢を選ぶ（その session の間だけ効く）。選ばないと、agent の書き込みのたびに run が確認で止まる。

> **Yes, and allow Claude to edit files in its ~/.claude folder for this session**

`dontAsk` では W に書けないので走らせない。

## allow rule を足す

どの mode でも効く規則だけを置く。`[SKILL_DIR]` はこの skill の絶対パス（`/` で始まる）に置き換える。絶対パスの規則は `//` で始まるので、
`Read(/[SKILL_DIR]/**)` は置き換えた後に `Read(//…/prd-spec/**)` になる。

```
Bash(node [SKILL_DIR]/scripts/doc_check.mjs *)
Read(/[SKILL_DIR]/**)
```

- 1 行目は、`workflows/prd-spec.js` の `cli()` と SKILL.md が実行させる doc_check の全モードの接頭辞である（tests が `cli()` と照合する）。
  auto mode では allow rule に当たる行為は classifier を通らずに決まる（本家の文書の「How the classifier evaluates actions」の 1）。
- 2 行目は、役のファイル・契約と W の読みの両方を覆う（W は `[SKILL_DIR]` の下にある）。作業ディレクトリの外の最初の Read は auto mode
  でも確認が出る（本家の文書の「The first read outside the working directories」）。
- 規則は doc_check の接頭辞と `[SKILL_DIR]` の読みに限る。広げると、prd-spec の外の操作まで確認なしに通る。
- `precedent.py` は S0 で司令塔が 1 回実行するだけなので、規則に入れない（run の途中では止まらない）。
