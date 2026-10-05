# native run の前の利用者の設定（許可と cache の TTL）

この文書の auto mode・allow rule・cache TTL は native Claude Code 用。Codex runner の host sandbox 設定・必要 capability・W の置き場は SKILL.md「実行環境」と「S0」を正とし、この設定の変更を要求しない。Codex のゲート後の再起動は同 SKILL.md「呼び直し」の next_args 契約に従う。

`/workflow:prd-spec-run` の run が止まるのは、依頼者の回答を待つゲートのほかは、agent の権限の確認と利用上限の待ちだけである
（本家の workflows の文書: 「To avoid prompts on a long run, add the tools the agents need to your allow rules before starting.」）。
prd-spec の agent は段ごとに doc_check を実行し、W（置き場は SKILL.md S0 の 2）を読み書きし、`[SKILL_DIR]` の役のファイルと契約を読む。

skill は利用者の settings を書かない。settings を変えるかは利用者が決める（`.claude/rules/`・`CLAUDE.md` に触れるときに止まるのと同じ扱い）。
S0 で、この文書の前提・規則・推奨する設定を示して確かめる。

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

## 推奨: subagent の prompt cache の TTL を 1 時間にする

```json
{ "subagentPromptCacheTtl": "1h" }
```

利用者が自分の settings（どの settings ファイルでもよい。例: user settings）に書く。skill は書かない。

本家の workflows の文書: 「A workflow agent's requests fall outside the main conversation's cache TTL bucket, so its cache holds for five minutes
by default, including on a Claude subscription.」この設定で 1 時間に延びる。

- 効きうるのは、run の中で同じ model・同じ役の前の agent から 5 分〜1 時間空いて起動した agent の初回ターンである。
- ゲートの回答待ちが 1 時間を超えると、次の run の最初の agent は設定があっても cache を作り直す。
- API の請求では、1 時間の書き込みは 5 分より高い（同じ文書: 「The API bills 1-hour cache writes at a higher rate.」）。書き込みの全部が
  高くなるので、1 回の試走から推計すると、読みに変わって減る分より増える分が大きく、cache の重み付きの費用は増える見込みだった。
  費用が増えうることを示したうえで推奨する。
