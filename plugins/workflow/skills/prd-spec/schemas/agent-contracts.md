# agent 間の入出力契約

**目次**: [共通の約束](#共通の約束) · [W のファイルと書き手](#w-のファイルと書き手) · [決定の台帳](#決定の台帳) · [§intake](#intake) · [§flow-framer](#flow-framer) · [§resolver](#resolver) · [§resolver-verifier](#resolver-verifier) · [§writer](#writer) · [監査役の共通節](#監査役の共通節) · [§implementer](#implementer) · [§grounding](#grounding) · [§cross-doc](#cross-doc) · [§structural（doc_check が生成する finding）](#structuraldoc_check-が生成する-finding)

各 agent が読むファイル・書くファイル・返す値の正本。役割と責務の境界は `schemas/role-map.md` を正とする。
`agents/*.md` は振る舞いを書き、形はここを指す。

## 共通の約束

- **入力はパスで受け取り、返り値は小さく保つ。** 返り値に載せるのは、script が次の段の分岐に使う件数・ID・
  digest と、flow-framer と resolver が返す flow 本体だけである。文書の本文や JSON の全量を返すと、script を
  経由して次の agent のプロンプトに載り、同じ内容に 2 度費用を払う。中身は W のファイルに書く。
- **書いてよいのは、下の表で自分が書き手になっているファイルだけ。** 作業用の script や一時ファイルは
  `W/tmp/` に置く。他のファイルは別の役が所有しており、そこを書き換えると、その役の検証の前提
  （sha256・digest の照合）が崩れる。
- **ハッシュは `shasum -a 256 <file>` の先頭 64 桁で取る。** writer が読んだ版と verifier が検証した版を、
  script が文字列比較で照合するため、全員が同じ取り方をする。
- **doc_check は `node <SKILL_DIR>/scripts/doc_check.mjs <mode> --workspace <W> …` で実行する。** 結果は
  `W/checks/` に書かれ、stdout には件数・digest・パスが 1 行の JSON で出る。実装を読む必要は無い。
- **`references/` は指された節だけを読む。** 見出しの行を Grep で探し、その節を offset/limit で Read する。
  350 行を超えるファイル（`prd-and-spec.md`・`document-structure.md`）を全体で Read すると読み込みの gate に
  止められ、通っても読んだ全文が以後のターンすべてに載り続ける。
- 文書のキーは `<kind>/<topic>`（例 `requirements/auth`）、ファイルは `W/<kind>-<topic>.md`。キーをファイル名に
  使うときは、英数字・`.`・`_`・`-` 以外の並びを `__` に置き換える（`requirements__auth`。doc_check と同じ変換）。

## W のファイルと書き手

所有表は約束であって強制されない。守られなかったときに何で気づくかを右端に書く。

| ファイル | 書き手 | 形 | 守られなかったときの検出 |
|---|---|---|---|
| `input.md`、`answers/g0.md`・`answers/g1.md` | 司令塔（依頼者の言葉を逐語で書くだけ） | テキスト | — |
| `precedent.json` | 司令塔（`[SKILL_DIR]/scripts/precedent.py list` の出力をそのまま） | `{ "paths": ["過去の decisions.json / verifications.json の絶対パス"] }`。旧い形式のランを変換したものは、`legacy: true` の decisions.json と、依頼者の回答を逐語で写した `answers.md` になる（検証を通っていないので verifications.json は無い。回答を引くときは ref を `<パス>#L<行>` にする） | — |
| `decisions.json`、`plan.json` | intake。以後は誰も追記しない（決定の追加と置き換えは resolutions に置く） | [決定の台帳](#決定の台帳)・[§intake](#intake) | 3v が検証する decisions.json の sha256 |
| `open.json` | intake、flow-framer（追記だけ） | [§intake](#intake) | — |
| `flow.json` | flow-framer。resolver は回答を当てるとき（3a・3a'）だけ | [§flow-framer](#flow-framer) | 更新のたびに返り値の flow を script が閉包検査する |
| `resolutions.json`、`routes.json`（段 6 で resolver が起動したときだけ）、`questions.md`、`report.md` | resolver | [決定の台帳](#決定の台帳)・[§resolver](#resolver) | writer が読んだ sha256 と verifier が検証した sha256 の照合 |
| `verifications.json` | resolver-verifier | [決定の台帳](#決定の台帳) | 同上 |
| `<kind>-<topic>.md`、`<kind>-<topic>.meta.json` | その文書を持つ単位の writer だけ | [§writer](#writer) | 段 8 の木全体の diff と writer の申告の照合 |
| `findings/r<n>-<役>-<文書>.json` | 各監査役（自分のファイルだけ） | [監査役の共通節](#監査役の共通節) | — |
| `checks/*.json` | doc_check。`audited-*` の snapshot は監査役だけが保存する | doc_check の出力 | `audited-*` は保存時の digest を script が持ち、diff の `--expect` で照合する |

司令塔は decisions・resolutions・answers の中身を起草しない。依頼者の言葉と agent の出力を、そのまま運ぶ。

## 決定の台帳

決定の台帳は、`decisions.json` と、`resolutions.json` のうち `verifications.json` で合格したものを合わせたもの
である。`supersedes` で置き換えられた決定は無効で、script が無効な ID の一覧を writer と監査役に渡す。

**decisions.json**（intake が書く）

```json
{
  "decisions": [
    {
      "id": "D-001",
      "topic": "何についての決定か（1 行）",
      "value": "決めた内容",
      "why": "なぜこの値か。source が input なら依頼文のどの記述か、default なら 上位互換 / 正しさ不変 / 標準的選択 のどれか",
      "source": "input | default | precedent",
      "quote": "source が input のとき。input.md に実在する文字列をそのまま写す",
      "ref": "source が precedent のとき。<precedent のパス>#<ID>",
      "layer": "要求 | 手段",
      "targets": ["この決定が関わる流れの要素・状態の名前（例 F-002、承認の主体）"],
      "reversibility": "変えるとき何を直せばよいか（1 行）"
    }
  ]
}
```

- `layer` は、プロダクトが何を達成するか（要求）か、それをどう実現するか（手段）か。writer は `手段` の決定を
  要求文書に書かない。
- `targets` は doc_check の `conflicts` が「同じ target を持つ決定どうし」「target が流れの要素の id か label と
  一致する決定と要素」の組を列挙するのに使う。名前が揃わないと組が見つからず、矛盾が初稿まで残る。

**resolutions.json**（resolver が書く）

```json
{
  "resolutions": [
    {
      "id": "RS-001",
      "about": { "open": "O-001" },
      "ruling": "precedent | internal | measured | method | question | hold",
      "value": "決まった内容（question は回答が当たってから、hold は書かない）",
      "why": "裁定の根拠（1〜2 文）",
      "evidence": [{ "file": "パス", "line": 42, "quote": "実在する文字列をそのまま" }],
      "supersedes": "D-003（決定を覆すときだけ）",
      "layer": "要求 | 手段",
      "targets": ["decisions と同じ意味"],
      "options": [{ "label": "案 A", "flow_effect": "選ばれたら flow のどの要素がどこへ行くか", "decision_text": "選ばれたら value になる文" }],
      "answer": { "path": "answers/g0.md", "quote": "回答の該当箇所を逐語で" },
      "hold": { "rule": "〜の裁定が下るまで、…してはならない", "issue_draft": "Issue の本文案", "item_ids": ["その論点に触れる項目 ID"] }
    }
  ]
}
```

- `about` は裁定の対象で、`{open}` / `{pair: [a, b]}`（conflicts の組）/ `{finding}` / `{tbd}` /
  `{verification}`（3v で不合格になった決定・要素の ID）のどれか 1 つ。
- 6 つの `ruling` の意味と順序は `agents/resolver.md` が正。`options` は `question` だけ、`hold` は `hold` だけに付く。
- 回答を当てるときは、その問いの resolution に `answer` と `value` を足す。ID は変えない（writer の trace が回答の
  前後で同じ ID を指し続けるため）。

**verifications.json**（resolver-verifier が書く）

```json
{
  "sha256": "検証した resolutions.json の sha256",
  "decisions_sha256": "検証した decisions.json の sha256",
  "items": [
    { "id": "RS-001 | D-004 | F-007", "verdict": "pass | fail", "fail_kind": "value_as_method | not_reproduced | insufficient_grounds | mapping", "reason": "判定の根拠 1 行（pass にも書く）" }
  ]
}
```

- 同じ ID を再検証したときは、その ID の項目を置き換える。`sha256` は最後に検証した版の値にする。
- `fail_kind`: `value_as_method` = プロダクトの価値の判断を方法論・先例・内部整合として決めた。`not_reproduced` =
  実測を再実行しても同じ証拠が出ない。`insufficient_grounds` = 出典が実在しない・支えていない。`mapping` =
  自由記述の回答の問いへの対応づけが回答の文面から言えない。

## §intake

入力: `W/input.md`、`W/precedent.json`（と、そこに並ぶファイル）、entry が `existing` / `expand` なら既存文書の
パス一覧。書くもの: `W/decisions.json`、`W/plan.json`、`W/open.json`。

**plan.json**

```json
{
  "targets": ["requirements", "specifications"],
  "docs": [{ "key": "requirements/auth", "concern": "認証と権限", "covers": [], "fixed": false, "decision": "D-010" }],
  "units": [{ "id": "U-1", "docs": ["requirements/auth"], "depends_on": [] }],
  "domain": [{ "aspect": "10 観点の名前", "verdict": "該当 | 非該当 | 不明", "decision": "D-012", "open": "O-003" }],
  "required_categories": [{ "name": "案件の言葉で具体化したカテゴリ", "decision": "D-012" }],
  "self_containment": { "decision": "D-015", "inline": ["文書に書くもの"], "reference": ["参照にとどめるもの"] }
}
```

- `docs[].covers` は仕様文書が実現する要求文書のキー。`fixed: true` は固定の入力（`expand` の要求文書・
  ラン外の文書）で、どの単位にも入れない。
- `units[].depends_on` は先に書き終える単位の ID。互いに参照し合う文書は同じ単位に入れる。
- `domain` は 10 観点すべて。`該当` / `非該当` は `decision`、`不明` は `open` を持つ。

**open.json**

```json
{ "open": [{ "id": "O-001", "text": "決まっていない論点（1 論点）", "searched": "依頼文のどこを探して答えが無かったか", "by": "intake | flow-framer", "targets": ["decisions と同じ意味"] }] }
```

返り値:

```json
{ "decisions": 18, "open": 3, "decisions_sha256": "…", "units": [{ "id": "U-1", "docs": ["requirements/auth"], "depends_on": [] }] }
```

## §flow-framer

入力: `W/input.md`、`W/decisions.json`、`W/precedent.json`、`W/open.json`（entry が `existing` なら既存文書も）。
書くもの: `W/flow.json`、`W/open.json` への追記。実行するもの: doc_check の `flow` と `conflicts`
（`W/checks/flow.json`・`W/checks/conflicts.json` ができる）。

```json
{
  "elements": [
    { "id": "F-001", "type": "input", "kind": "外から入るもの", "label": "依頼文", "next": ["F-002"], "source": { "input": "依頼文の逐語" } },
    {
      "id": "F-002", "type": "decision", "kind": "判断", "label": "対象外の依頼か", "source": { "decision": "D-004" },
      "branches": [{ "value": "対象外", "next": "F-009" }, { "value": "対象内", "next": "F-003" }]
    },
    { "id": "F-009", "type": "output", "kind": "返すもの", "label": "対象外の旨の 1 文", "source": [{ "input": "…" }, { "open": "O-004" }] }
  ],
  "kinds": [{ "name": "判断", "definition": "値によって次の工程が変わる要素" }],
  "closure": "一覧の外に要素が無いと言える根拠（確かめたことと推測を分けて書く）"
}
```

- `id` は `F-<連番>` で一意。`type` は `input` / `step` / `decision` / `output`。`kind` は `kinds[].name` のどれか。
- `decision` は `branches` に 2 つ以上の `{ value, next }` を持つ。それ以外は `next`（行き先 ID の配列）を持ち、
  `output` だけが行き先を持たなくてよい。どの要素にも `input` から辿り着ける。
- `source` は必須。`{input: 逐語}` / `{decision: D- か RS- の ID}` / `{open: O- の ID}` のどれか、または複数の配列。

返り値（flow 本体は script が閉包検査に使う）:

```json
{ "flow": { "elements": [], "kinds": [], "closure": "" }, "open": 5, "pairs": 2, "flow_findings": 0, "flow_digest": "…", "conflicts_digest": "…" }
```

## §resolver

入力（パス）: 上流の全部（input・answers・decisions・plan・open・flow・`checks/conflicts.json`・resolutions・
verifications・precedent）と、段ごとに script が渡す対象の ID。書くもの: `W/resolutions.json`（追記と、回答・差し戻しで
の更新）、`W/questions.md`、`W/routes.json`（段 6）、`W/report.md`（段 9）、`W/flow.json`（回答を当てるときだけ）。

**questions.md** は依頼者にそのまま見せる。問い 1 つにつき `## <RS-ID>` の節を置き、問い（1 論点・専門用語なし）、
依頼文を探したが答えが無かったこと、候補ごとの「選ばれたら何が変わるか」を書く。

**routes.json**（段 6。この段で裁定した resolution を、当てる単位と項目で束ねたもの）

```json
{ "routes": [{ "id": "RT-001", "unit": "U-1", "doc": "requirements/auth", "item_id": "PR-AUTH-003", "resolutions": ["RS-007"] }] }
```

- 持つのは resolution を伴う項目だけである。route が `writer` の指摘は載せない。それは script が項目 ID ごとに
  束ねて writer へ直接渡す（[§writer](#writer)）。段 6 が起動しないとき（decision の指摘も新しい TBD も 0 件）は
  routes.json は書かれず、writer の指摘はそれでも改稿に届く。

**report.md** は依頼者にそのまま見せる事後報告。方法論として決めたこと（resolutions の `method`）、保持規則と
Issue の文案、上位文書の改訂文案を書く。

返り値:

```json
{
  "ruled": [{ "id": "RS-001", "about": { "open": "O-001" } }],
  "questions": [{ "id": "RS-004", "about": { "tbd": "TBD-RAUTH-002" } }],
  "holds": [{ "id": "RS-006", "about": { "finding": "r1-im-requirements__auth-004" } }],
  "supersedes": ["D-003"], "free_text": ["RS-004"], "routes": [{ "id": "RT-001", "unit": "U-1" }],
  "sha256": "書き終えた resolutions.json の sha256",
  "flow": "回答を flow に当てたときだけ、更新後の flow 本体"
}
```

- `ruled`・`questions`・`holds` の `about` は、resolutions の `about` と同じ形で書く。script はファイルを読めない
  ので、どの open・組・指摘・TBD が閉じたかはここからしか分からない。script はこれと verifier の合格を突き合わせて、
  閉じた ID の集合（開いている TBD の算出に使う）を next_args に載せ、渡した対象のうち `about` に現れないものを
  裁定漏れとして数える。
- `free_text` は、回答が候補の外の自由記述で、問いへの対応づけを自分で解釈した ID（verifier の検証対象になる）。

## §resolver-verifier

入力: `W/resolutions.json`、`W/decisions.json`、`W/flow.json`、`W/input.md`、`W/answers/*.md`、`W/questions.md`、
script が渡す検証対象の ID。書くもの: `W/verifications.json`。返り値:

```json
{ "pass": ["RS-001", "D-004"], "fail": [{ "id": "RS-002", "kind": "value_as_method", "reason": "…" }], "sha256": "検証した resolutions.json の sha256", "decisions_sha256": "…" }
```

## §writer

入力（パス）: `W/input.md`、`W/answers/*.md`、`W/decisions.json`、`W/flow.json`、`W/plan.json`、
`W/resolutions.json` と合格した ID の一覧、無効な決定の ID、自分の単位の文書と meta、依存先の単位の文書、
開いている TBD の ID（script が解消済みを除いて算出したもの）。改稿では加えて、単位の文書ごとの改稿前の
digest と、次の 2 つ。

- route が `writer` の指摘の ID を、script が項目 ID ごとに束ねたもの（`[{ "item_id": "PR-AUTH-003", "doc": "requirements/auth", "findings": ["r1-im-requirements__auth-002"] }]`）。
  中身は `W/findings/*.json` から ID で読む。段 6 が起動しなくても渡る。
- `W/routes.json` のうち自分の担当の ID（段 6 で resolver が起動したときだけ）。

書くもの: `W/<kind>-<topic>.md` と `W/<kind>-<topic>.meta.json`（自分の単位の文書だけ）。

**meta.json**（本文から取れないものだけを置く。項目 ID と参照 ID は doc_check が本文から導出する）

```json
{
  "trace": [
    { "item_id": "PR-AUTH-001", "kind": "input", "quote": "input.md に実在する文字列をそのまま" },
    { "item_id": "PR-AUTH-001", "kind": "flow", "ref": "F-003" },
    { "item_id": "PR-AUTH-002", "kind": "decision", "ref": "D-004" }
  ],
  "tbd": [{ "id": "TBD-RAUTH-001", "text": "決めるべき論点と、何が決まれば解消するか", "blocking": true, "candidates": ["決め方の候補（任意）"] }]
}
```

- `trace[].kind` は `input` / `answers`（`quote` を逐語で）、`decision` / `resolution` / `flow`（`ref` に ID）、
  `premise`（`ref` に `前提 N`。`references/fixed-premises.md` の前提で、書き方の選択にだけ使える）のどれか。
  これ以外の出所は根拠として認められていないので、列挙に無い。
- 1 項目に複数の trace を置いてよい。振る舞いを定める項目は `flow` の trace を 1 つ以上持つ。
- TBD の ID は `TBD-<R|S><領域>-<連番>`（要求文書は R、仕様書は S。領域は topic を英大文字にしたもの）。

返り値:

```json
{
  "unit": "U-1",
  "docs": [{ "key": "requirements/auth", "digest": "tree-digest --doc の値", "doc_check_findings": 0, "doc_check_blocking": 0 }],
  "changed_items": ["PR-AUTH-003", "requirements/auth§用語", "requirements/auth§(meta)", "TBD-RAUTH-002"],
  "open_tbd": ["TBD-RAUTH-001"],
  "new_tbd": ["TBD-RAUTH-002"],
  "applied_findings": ["r1-im-requirements__auth-002"],
  "applied_routes": ["RT-001"],
  "resolutions_sha256": "読んだ resolutions.json の sha256"
}
```

- `applied_findings` は当てた writer の指摘の ID、`applied_routes` は当てた routes.json の ID。段 6 が起動せず
  routes.json を渡されなかったときは、`applied_routes` は空配列にする。script は渡した ID とこの 2 つを比べ、
  当たっていない分を残りとして数える。初稿では両方とも空配列でよい。
- `changed_items` は doc_check の snapshot と同じ項目キーで書く: ID を持つ項目は ID、ID を持たない節は
  `<文書キー>§<見出し>`（同じ見出しが続けば `#2`）、冒頭は `<文書キー>§(冒頭)`、meta の trace・TBD 以外は
  `<文書キー>§(meta)`、TBD の候補は TBD の ID。script はこれを段 8 の diff と文字列で比べる。形が違うと、
  直した項目がすべて「申告に無い変更」になり、監査が余分に起動する。初稿では空配列でよい。

## 監査役の共通節

implementer・grounding・cross-doc の 3 役に共通する契約。**route の定義と観点の守備範囲はここにだけ置く。**

### 読むもの

writer と同じ根拠一式（input・answers・decisions の全フィールド・合格した resolutions・flow・plan・無効な決定の
ID・開いている TBD の ID）と、監査する文書と meta。根拠が writer より少ないと、writer が決定の `why` や flow
から正しく書いた記述を「根拠が無い」と誤って指摘する（実測で 3 件）。

文書が 350 行以下なら全文を読む。350 行を超えるなら、shunt の locate で候補の箇所を逐語の引用で探させ、
原文の該当節を読んで判定してよい。判定は必ず原文で行う（要約を材料にすると、原文に無いことで指摘する）。
shunt が使えない環境では全文を読む。範囲を絞った監査（段 8）では、script が渡した項目の節から読む。

### 観点の守備範囲（排他）

1 つの欠陥は 1 つの観点が持つ。重ねて出すと、同じ箇所に 2 つの指摘が付き、writer が逆向きに直しうる。

| 観点 | 見るもの | 見ないもの |
|---|---|---|
| implementer | 1 項目の中: 着手できるか、その項目自身の trace と目的に対して過不足が無いか、要る項目か、EARS・境界値・複合要求の曖昧さ | 根拠の有無、項目どうしの関係（他の文書の項目・上位の要求と照らした範囲の判定を含む） |
| grounding | 1 文の根拠: trace が実在し支えているか、捏造・出所の偽装・既存実装を要求の根拠にしていないか、未決のことを断定していないか、入力に違反していないか | 着手可能性、項目どうしの関係 |
| cross-doc | 項目の間: 矛盾（文書の中と文書間）、重複、用語の揺れ、他の文書の項目（上位の要求）と照らした範囲の判定（拡大・不足）、境界の抜け、紐付けの意味と検証方法、必須カテゴリ・必須章・操作（登録・参照・更新・削除）の欠け、宣言漏れ | 1 項目で完結する問題 |
| doc_check | 語尾、曖昧語リスト、ID の参照、trace の有無、判定表・状態×イベント表・流れの網羅、開いた TBD に触れる断定の語尾 | 意味の判定 |

doc_check が判定するものを LLM の観点で重ねて出さない。機械の結果は決定的で、LLM の重複は揺れるだけ件数を増やす。

### 指摘の形（`W/findings/r<n>-<役>-<文書>.json`）

`<役>` は `im` / `gr` / `cd`、`<文書>` はキーを変換した名前（cross-doc は `all`）。段 8 で申告に無い変更のために追加で
起動した監査役は、末尾に `-extra` を付けたファイルに書く（同じ段・同じ文書の 1 体目のファイルを上書きしないため）。
指摘の ID はファイル名（`.json` を除く）に `-001` からの連番を付けて振る。

```json
{
  "findings": [
    {
      "id": "r1-im-requirements__auth-001",
      "doc": "requirements/auth",
      "item_id": "PR-AUTH-003",
      "quote": "問題の箇所の原文をそのまま",
      "issue": "何が問題か（1〜2 文）",
      "repro": "判定が割れる具体入力、またはその構成手順",
      "blocking": true,
      "route": "writer | decision",
      "direction": "relax | tighten | make_measurable | choose_one | merge_or_split | align_terms | add_trace | remove | document_decision",
      "direction_note": "任意。方向の補足 1 行",
      "action": "冗長の指摘だけ。delete | merge_into:<ID> | replace_with_reference:<文書#ID>"
    }
  ],
  "checked": "実際に読んだ範囲と、当てた観点"
}
```

- `item_id` は snapshot と同じ項目キー（[§writer](#writer)）。script はこれで指摘を項目ごとにまとめ、段 8 の
  監査範囲を決める。
- **`direction` は解消の方向だけを示す。新しい要求文を創作して与えない。** `direction_note` にも文案・候補値を
  書かない。検査者の文案は writer をアンカリングさせ、根拠からではなく文案から書かせる（実測）。しかもその文案は
  誰にも検証されない。
- **`repro` を書けない指摘は出さない。** 具体入力を構成できない指摘は仕上げの好みで、改稿しても総数が減らない。
- 指摘 0 件なら `findings: []`。`checked` は必須（何も読まずに 0 件を返す経路を残さないため）。
- 開いている TBD と、保持規則（「〜の裁定が下るまで…してはならない」）は指摘しない。決まっていないことが
  見えている正しい状態である。

### blocking

`true` は、直さずに保存すると次工程が誤る欠陥: 実装・QA の最初の作業で手が止まる、捏造、未決の断定、両立しない
規範。`false` は、着手はできるが後で作り直しになりうるもの（冗長を含む）。blocking が残ると段 6〜8 がもう
1 パス回り、それでも残れば run は blocked で止まる。乱発すると改稿のパスを使い切り、遠慮して `false` に
落とすと、推測で埋めた記述がそのまま保存される。

### route

| route | 条件 |
|---|---|
| `writer` | 入力と決定台帳の範囲で直せる: 削除、適用範囲の限定、既にある決定・入力・本文への追認、表現の修正、食い違いのうち上位文書か入力に辿れる側へ揃えること |
| `decision` | 直すのに、入力にも決定台帳にも無い規範・値を新しく置く必要がある。食い違いの両側がそれぞれ入力に辿れ、入力そのものが割れている。プロダクトの価値（何をすべきか・何を許すか・何を優先するか）の判断が要る |

- 見分け方: 直した後の文が指せる根拠（決定の ID・入力の文言・他の項目）を挙げられるなら `writer`。挙げられない
  なら、それは追認ではなく発明なので `decision`。
- 迷ったら `decision`。決定が要る指摘を writer に回すと、writer が根拠の無い規則を書き、段 8 の grounding で
  捏造として戻るまで 1 パスを失う。writer で直せる指摘を resolver に回しても、resolver が `internal` か `method`
  で裁定して返すだけで済む。
- `decision` の指摘は resolver が裁定する（段 6）。`writer` の指摘は script が項目ごとに束ね、routes.json を通らずに
  そのまま改稿へ回る。

### 指名されたとき

script は起動した監査役のうち 1 体を指名し、プロンプトでコマンド（`<n>`・`<digest>`・`<ID>` を埋めたもの）を
渡す。指名された 1 体は、監査の判定とは別にそれを実行し、**stdout の JSON を加工せずに**返り値に入れる。script はファイルを読めないので、この値が監査の
基準（どの版を監査したか）の唯一の記録になる。

| 段 | 最初に | 最後に |
|---|---|---|
| 段 5（cross-doc） | `doc --workspace W --open-tbd <ID>` | `snapshot --save audited-1 --role auditor --workspace W` |
| 段 8 | `diff --against audited-<n> --expect <digest> --workspace W` の後、`W/checks/diff-audited-<n>.json` を読んで ID 集合を返す | `snapshot --save audited-<n+1> --role auditor --workspace W`。最後の書き込みの後の監査では加えて `doc` と `tree-digest` |

- diff は監査の判定より**前に**実行する。後に回すと、判定中に誰かが書き換えた分が「監査した版」に混ざる。
- `diff` が exit 3（digest の不一致）で終わったら、それ以上進めず、stderr をそのまま `designated.diff_error` に入れて返す。監査の基準が
  差し替わっているので、その上で出した判定は何と比べたのかが分からない。

返り値（全監査役）:

```json
{
  "path": "findings/r1-im-requirements__auth.json",
  "findings": [{ "id": "r1-im-requirements__auth-001", "doc": "requirements/auth", "item_id": "PR-AUTH-003", "blocking": true, "route": "writer" }],
  "designated": {
    "doc_check": "doc の stdout（そのまま）",
    "diff": { "stdout": "diff の stdout（そのまま）", "changed": ["PR-AUTH-003"], "added": [], "removed": [] },
    "diff_error": "diff が exit 3 で終わったときだけ、stderr（そのまま）",
    "audited": "snapshot の stdout（そのまま）",
    "tree_digest": "tree-digest の stdout（そのまま）"
  }
}
```

`designated` は指名されたときだけ、実行した項目だけを入れる。

## §implementer

監査役の共通節に従う。入力は 1 文書（範囲を絞った監査では、その文書の対象の項目）。

## §grounding

監査役の共通節に従う。入力は 1 文書。範囲を絞った監査では、変わった項目と新しく入った規範文。

## §cross-doc

監査役の共通節に従う。入力は全文書と `plan.json`（`required_categories`・`covers`・`self_containment`）。
段 5 では必ず指名される。

## §structural（doc_check が生成する finding）

`scripts/doc_check.mjs` が検出する。agent は生成しない。文面は doc_check の表（`FINDING_TEXT` と
`WORKSPACE_TEXT`）から組み立てられる。

| `id` の接頭辞 | 検出内容 |
|---|---|
| `ST-DUP-` / `ST-DUP-TBD-` | 同じ ID・TBD ID が複数文書で定義されている |
| `ST-ORPHAN-REQ-` / `ST-ORPHAN-SPEC-` | 要求 ID・仕様項目 ID がトレーサビリティ表に無い |
| `ST-DANGLING-` | 表が参照する ID がどの文書にも無い |
| `ST-REF-UNDEFINED-` | 本文が参照する ID がどの文書の見出しにも無く、欠番の申告も無い |
| `ST-OBSOLETE-` / `ST-UNVERIFIED-` | 廃止済み規制の語・本文未確認の規格の条番号（`references/citation-policy.md`） |
| `ST-NO-EVIDENCE-` | 項目 ID に対応する trace が meta に無い |
| `ST-NON-NORMATIVE-` | 本文に根拠句・決定ログ・経緯・未確定事項の章が混ざっている |
| `ST-AMBIGUOUS-` | ID を持つ項目の文に曖昧語リストの語がある |
| `ST-TBD-ASSERT-` | 開いている TBD に触れる文が断定の語尾で終わる |
| `ST-STATE-` | 状態 × イベント表の欠け・非決定・図との食い違い・到達不能・出口なし・軸の外の値（書式は `references/document-structure.md` §6） |
| `ST-DT-` | 判定表の組み合わせの欠け・重なり・宣言外の値（書式は同 §2.8） |
| `ST-FLOW-` | 流れの形と閉包の欠陥、出典の欠け・形の誤り・実在しない出典、項目が当たっていない要素、実在しない要素への当て |

`not_checked` は失格ではなく「材料が無くて実行できなかった検査」である。`ST-NOTCHECKED-TRACE-<文書>` は meta が
無く trace を検査していないこと、`ST-NOTCHECKED-FLOW` は flow が無いことを示す。「指摘 0 件」と混同させない
ため、別の配列で返る。
