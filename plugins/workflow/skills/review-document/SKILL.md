---
name: review-document
description: >
  日本語の説明的文書（要求文書・rule・README・スキル本文など）を「短さ・平易さ・独自用語の不使用」
  の3つの軸で採点し、証拠つきの改善策を返すスキル。求められれば、内容を落とさない改稿案を
  staging（下書き置き場）に書いて before/after を示す。「この要求文書を読みやすさの観点で見て」
  「この rule、冗長じゃないか採点して」「この README を短く書き直して」「PRD を渾身の言語化の
  基準でレビューして」「独自用語が多すぎないか確認して」といった依頼で使うこと。
  他のドキュメント生成スキル（prd-spec など）から監査の観点として呼ばれる場合にも使う。
  文書の新規執筆、コードレビュー、翻訳は対象外。対象の文書パスが示されていない依頼では
  採点に入らず、どの文書かを1回だけ聞き返す。
---

# review-document

## S1. 目的・概要

日本語の説明的文書を読み、**同じ内容をもっと短く・平易に・独自用語なしで書けたはずか**を採点する。
採点は分量そのものではなく「圧縮できる余地」を見る。文字数や行数のしきい値で合否を出さないのは、
長さは内容量に比例することがあり、長さで切ると内容の濃い文書が不当に落ちるため。

モードは2つ。

| モード | すること | ファイル書き込み |
|---|---|---|
| `review`（既定） | 採点・証拠・改善策を返す | 一切しない |
| `revise` | review に加えて、改稿案を staging に書き、再採点して before/after を返す | staging のみ。本体は触らない |

`review` は合否を出さない（非ブロッキング）。採否は呼び出し側か人間が決める。

**対象外**：文書の新規執筆、コードレビュー、翻訳。これらは別スキルの領分で、
この3軸は「すでに書かれた説明文」を前提にしているため当てはまらない。

## S2. 実行前の準備

script を呼ぶ前に、司令塔（このスキルを読んでいる Claude）が次を揃える。
揃わないまま呼ぶと script は起動時に落ちる（何を見たか説明できない結果を「レビュー結果」として
返さないための設計）。

- [ ] **対象文書の実パス**を1つ以上、絶対パスで確定する。symlink 越しの参照パスではなく
      `realpath` で解決した実体パスを渡す（script はファイルシステムに触れないので解決できない）。
- [ ] **対象パスが示されていない依頼は、1回だけ聞き返す。**
      「短く書き直して」だけの依頼はモードとしては `revise` だが、**パスが無いことが優先**する。
      モードを推測できても対象が無ければ採点は始まらないので、先に
      「どの文書を短く書き直しますか。ファイルの場所を教えてください」と聞いて終了する。
      逆にパスがあってモードの指定が無ければ、聞き返さず `review` として進む（読むだけで
      副作用が無く、必要なら後から `revise` を回せるため）。
- [ ] **mode** を決める。「レビューして」「採点して」「見て」→ `review`。
      「短く書き直して」「改稿して」「直して」→ `revise`。
- [ ] `revise` のときは **constraints（落とせない性質）** をユーザーに確認する。
      例：「要求 ID を消さない」「根拠へのリンクを残す」。
      指定が無ければ「根拠の追跡性と検証可能性を落とさない」を既定として渡す。
- [ ] `references/rubric.md`（採点基準の正本）がこのスキルの中に存在するか確認する。
      無い場合も止めない。script が「基準を読めなかった」を欠測として返すので、
      その欠測をそのままユーザーに伝える（黙って一般論で採点すると、基準に無い判定が混ざる）。

## S3. Workflow の呼び出しと args の意味

```
Workflow({
  scriptPath: "<このスキルの実ディレクトリ絶対パス>/scripts/review-document.js",
  args: {
    rubricPath: "<このスキルの実ディレクトリ絶対パス>/references/rubric.md",
    mode: "review",
    targets: ["/abs/path/docs/requirements/overview.md"],
    focus: null,
    constraints: null,
    stagingDir: null
  }
})
```

| args | 必須 | 意味 |
|---|---|---|
| `rubricPath` | ○ | 採点基準（`references/rubric.md`）の絶対パス。既定はこのスキル同梱のもの。script は自分の位置を解決できないので、担当エージェントに読ませる基準パスをここで渡すしかない。呼び出し側が別の rubric を使うときもこの 1 箇所だけ差し替える |
| `mode` | ○ | `review` / `revise` |
| `targets` | ○ | 対象文書の絶対パス配列。複数渡すと、同じ用語が複数ファイルに跨る場合をまとめて見る |
| `focus` | 任意 | 「導入部だけ見て」など、人間が特に見てほしい関心。両モード・改稿の前後で維持される |
| `constraints` | `revise` で必須 | 落とせない性質の自由記述。改稿がこれを壊していないかを別の担当が突き合わせる |
| `stagingDir` | 任意 | 改稿案の置き場。省略時の既定値は script が決める（値を2箇所に置くとズレるので、ここには書かない） |

ループ回数・並列数・多数決のしきい値は script が持つ。SKILL.md には書かない。

## S4. 返り値の解釈（review）

> この節の例は、**基準の使い方**を示すもので、基準そのものではない。判定基準の正本は
> `references/rubric.md`。rubric を直したときにこの例が古くなっても、正しいのは rubric の側。

**入力例**

```
Workflow({
  scriptPath: "/Users/me/.claude/skills/review-document/scripts/review-document.js",
  args: {
    rubricPath: "/Users/me/.claude/skills/review-document/references/rubric.md",
    mode: "review",
    targets: ["/Users/me/proj/docs/requirements/retrieval.md"],
    focus: null, constraints: null, stagingDir: null
  }
})
```

**出力例（script の戻り値）**

```json
{
  "mode": "review",
  "targets": ["/Users/me/proj/docs/requirements/retrieval.md"],
  "verdict": "findings",
  "scores": [
    {
      "file": "/Users/me/proj/docs/requirements/retrieval.md",
      "shortness": { "score": 4, "rationale": "規範文1文につき前置きが2文つく形が全体で反復している" },
      "plainness": { "score": 6, "rationale": "1文が3つの否定を重ねる箇所が導入と制約節に2つある" },
      "no_jargon": { "score": 5, "rationale": "この文書が発明した語が4つあり、うち3つは一般語で置換できる" }
    }
  ],
  "jargon": [
    { "term": "期間分割検索", "files": ["retrieval.md"], "replacement": "日付で絞った検索", "loses": "無し" },
    { "term": "証拠連動改訂", "files": ["retrieval.md"], "replacement": "根拠が変わったら直す", "loses": "無し" }
  ],
  "worst_sentences": [
    {
      "file": "retrieval.md",
      "quote": "本節では、後述する制約と矛盾しない限りにおいて、原則として期間分割検索を用いないものとするが、例外が無いわけではない。",
      "rewrite": "期間分割検索は使わない。例外は次節に挙げる。"
    }
  ],
  "breakdown": [
    { "file": "retrieval.md", "normative_pct": 35, "evidence_pct": 20, "meta_pct": 45 }
  ],
  "suggestions": [
    "各節の冒頭にある「本節では〜を述べる」を削り、節見出しに役割を持たせる（メタ45%の主因）",
    "却下した設計案の記述を別ファイルへ移し、本文は採用案だけにする（根拠は残る）",
    "「期間分割検索」を「日付で絞った検索」に置換する（初出定義が不要になる）"
  ],
  "missing_axes": [],
  "missing_cells": [],
  "skipped_targets": [],
  "unreadable_targets": [],
  "rubric_readable": true,
  "unverified": [],
  "rejected_count": 1,
  "constraints_defaulted": null,
  "note": "",
  "staging": null
}
```

| 追加フィールド | 意味 |
|---|---|
| `missing_cells` | `[{file, axis}]`。軸ごとには採点が返ったが、特定ファイルの採点が欠けた箇所。1 件でもあれば `review_incomplete` |
| `skipped_targets` / `unreadable_targets` | 対象外（コード・非日本語等）／読めなかった対象 |
| `rubric_readable` | 採点基準が読めたか |
| `unverified` | 反証の有効票が足りず、確定でも棄却でもない指摘（`[{id, axis, type, claim}]`）。割れた材料として人間に見せる |
| `rejected_count` | 反証で棄却された指摘の件数 |
| `constraints_defaulted` | `revise` で constraints を既定値で補ったか（`review` では null） |
| `note` | script からの補足 |

確認すること：`scores` / `jargon` / `worst_sentences` / `breakdown` の4点セットが揃っているか。
揃っていない場合は必ず `missing_axes`（軸単位）または `missing_cells`（ファイル×軸単位）に載る。
**空配列と欠測は違う**（S6）。`verdict` は欠測の有無と指摘の有無を表すだけで、合否ではない。

`verdict` は次のいずれか。

| verdict | 意味 | 人間に伝えること |
|---|---|---|
| `clean` | 全軸が採点でき、生き残った指摘が0件 | 改善余地は見つからなかった |
| `findings` | 全軸が採点でき、指摘がある | 上の4点セットと改善策を提示する |
| `review_incomplete` | 採点できなかった軸（`missing_axes`）またはファイル×軸（`missing_cells`）がある | どの箇所が欠測かを名指しで伝え、「問題なし」とは言わない |

## S5. 返り値の解釈（revise）

`revise` では上に加えて `staging` が入る。

`scores_before` / `scores_after` の行は S4 の `scores` と同じ形（軸ごとに `{score, rationale}`、
欠測は `score: null`）。**両方とも `file` は本体側の絶対パス**で、before/after はこの `file` を
鍵に結合する（配列順に頼らない）。after 行には読ませた staging 側の物理パスが
`staging_path` として添えて返る。指摘系の配列は id だけでなく `{id, axis, type, claim}` の形。

```json
"staging": {
  "dir": "/Users/me/proj/docs/requirements-review-staging",
  "changed_files": [{ "path": "retrieval.md", "reason": "メタ文の削除と用語置換", "addresses": ["p1-no_jargon-1"] }],
  "scores_before": [ { "file": "/Users/me/proj/docs/requirements/retrieval.md",
    "shortness": { "score": 4, "rationale": "..." },
    "plainness": { "score": 6, "rationale": "..." },
    "no_jargon": { "score": 5, "rationale": "..." } } ],
  "scores_after": [ { "file": "/Users/me/proj/docs/requirements/retrieval.md",
    "staging_path": "/Users/me/proj/docs/requirements-review-staging/retrieval.md",
    "shortness": { "score": 7, "rationale": "..." },
    "plainness": { "score": 7, "rationale": "..." },
    "no_jargon": { "score": 8, "rationale": "..." } } ],
  "resolved": [ { "id": "p1-shortness-1", "axis": "shortness", "type": "worst_sentence", "claim": "..." } ],
  "remaining": [ { "id": "p1-plainness-2", "axis": "plainness", "type": "worst_sentence", "claim": "..." } ],
  "new": [],
  "reclassified": [],
  "carried_unverified": [ { "id": "p1-shortness-3", "axis": "shortness", "type": "suggestion",
    "claim": "...", "status": "still_unverified", "note": "改稿前も後も未検証のまま" } ],
  "unverified": [],
  "constraint_violations": [],
  "constraint_unchecked": [],
  "summary": "改稿担当の要約"
}
```

| フィールド | 意味 |
|---|---|
| `resolved` / `remaining` / `new` | 改稿前に確定していた指摘のうち解消・残存したもの／改稿後に初めて確定した指摘 |
| `reclassified` | 改稿前は未検証で、再検証で確定した指摘。改稿が持ち込んだ問題ではないので `new` とは別掲 |
| `carried_unverified` | 改稿前に未検証だった指摘の行方（`still_unverified`＝今も未検証／`gone_unresolved`＝再出現しなかったが検証を通っていないので解消とは数えない） |
| `unverified` | 改稿後の再検証で有効票が足りなかった指摘。制約違反が出た実行では、違反ファイルと無関係と確認できない指摘もここに入る |
| `constraint_violations` / `constraint_unchecked` | 落とせない性質が壊れた箇所／突き合わせを実施できなかった項目（未確認は「違反なし」ではない） |

人間へは次の順で出す。**本体ファイルは1バイトも変わっていない**ことを最初に言う
（改稿が既に適用されたと誤解されると、承認そのものが意味を失う）。

1. staging の場所と、変えたファイル
2. before/after のスコア表
3. 解消（`resolved`）／残存（`remaining`）／新規（`new`）／再分類（`reclassified`）／
   未検証の持ち越し（`carried_unverified`）の件数と中身
4. `constraint_violations` があれば、それに関わる指摘は**解消として数えていない**ことを、
   `constraint_unchecked` があれば突き合わせが**未確認**であることを明示する
5. 承認するか差し戻すかを聞く（承認後の本体への反映は、人間の指示を受けてから行う）

`verdict` は `applied_to_staging`（改稿して再採点まで通った）／`update_failed`（改稿の担当が
応答しなかった。staging に何が書かれたかは script からは分からないので、dir を示して確認を促す）／
`reverify_incomplete`（再採点で軸が欠けた。残存0件と読めないので止める）。

## S6. 欠測とゼロ点の区別

採点や反証の担当が応答しなかった軸・指摘は、`null` または `unverified` として返る。
これを「問題なし」と混ぜてはいけない。混ぜると、誰も見ていない箇所が「見たが綺麗だった」に化ける。

```json
"scores": [{ "file": "a.md", "shortness": { "score": null, "rationale": "採点担当が応答しませんでした" },
             "plainness": { "score": 7, "rationale": "..." },
             "no_jargon": { "score": 6, "rationale": "..." } }],
"missing_axes": ["shortness"],
"verdict": "review_incomplete"
```

軸ごとの担当は応答したが特定のファイルの採点だけが返らなかった場合も同じ扱いで、
`missing_cells: [{file, axis}]` に名指しで載り、`verdict` は `review_incomplete` になる。

伝え方：「短さの軸は採点できていません（0点ではありません）。残り2軸の結果です。」

## S7. 反証の分母と多数決

各指摘には、観点の違う反証担当が独立に当たる（既定3名。数と観点は script が持つ）。
指摘の単位は **用語1件＝1指摘 / 最悪文1件＝1指摘 / 改善策1件＝1指摘**。
まとめて1指摘にすると、1つが棄却されただけで残りも巻き添えで消える。

- 「読めなかった」という票は分母から外す。読んでいない票を分母に入れると、実際は1名しか
  検証していない指摘が「3名中1名だけが反証」＝確定として通ってしまう。
- 有効票が2票に満たない指摘は `unverified`（確定でも棄却でもない）。
- 有効票の過半数が反証したら棄却。同数（2票中1票）では棄却しない。割れた指摘は人間が見る材料として残す。

## S8. 採点基準の正本

3軸の判定手順・独自用語の「失うもの」の判定・分量内訳（規範文／根拠・注記／メタ）の数え方は
`references/rubric.md` が正本。SKILL.md に写さないのは、同じ判定が2箇所にあると必ず片方だけが
古くなるため。採点担当は script から rubric の絶対パス（`args.rubricPath`）を受け取り、自分で読む。
読めなかった場合は、その軸を欠測として返す（読めていないまま採点すると、rubric に無い基準が混ざる）。

## S9. このスキル自身が独自用語を作らないための注意

内部の担当名（採点担当・反証担当・統合担当・改稿担当などの実装上の識別子）は、
`scores` / `jargon` / `worst_sentences` / `suggestions` といったユーザー向けの出力に出さない。
出すときは「採点担当」「反証担当」のような一般語に直す。
独自用語を減らすスキルが自分の造語を読者に押しつけては、基準を自分に適用していないことになる。
`references/rubric.md` にも同じ識別子を持ち込まない。

## S10. エッジケース（正常系）

| ケース | 挙動 |
|---|---|
| どの軸も高得点で指摘が0件 | `verdict: "clean"`。`suggestions` は空配列。「改善余地なし」と伝える（無理に指摘を作らない） |
| 全軸が最低点近辺 | 通常どおり `findings`。改善策は効果順の上位3件程度に絞って提示する（全部並べると着手されない） |
| `revise` で constraints の指定が無い | 「根拠の追跡性と検証可能性を落とさない」を既定として扱う。既定を使ったことを結果に添える |
| 独自用語はあるが、置き換えると意味が失われる | `jargon` に載せない。載せるのは「失うものが無い」ものだけ（要件どおり） |

## S11. エッジケース（準正常系）

| ケース | 挙動 |
|---|---|
| 同じ用語が複数ファイルに跨る | `jargon[].files` に全ファイルを列挙し、1件の指摘として扱う。ファイルごとに分けると同じ議論を人数分繰り返すことになる |
| mode の指定が無い（パスはある） | 聞き返さず `review`。読むだけで副作用が無い |
| 対象パスが無い | モードを推測できても採点に入らない。1回だけ聞き返して終了（S2） |
| focus と constraints が矛盾する（例：「導入部を半分に」かつ「導入部の要求 ID を全部残す」） | script は止めない。改稿担当が constraints を優先し、focus を達成できなかった旨を `staging.summary` に書く。人間が判断する |

## S12. エッジケース（異常系）

| ケース | 挙動 |
|---|---|
| `references/rubric.md` が読めない | その軸を欠測にし `review_incomplete`。黙って一般論で採点しない |
| 対象パスが存在しない・読めない | Prepare 段階で `unreadable_targets` に載り、全件読めなければ `review_incomplete` で停止 |
| 対象がコード・非日本語・バイナリ | 対象外として `skipped_targets` に載せ、採点しない。3軸は日本語の説明文を前提にしており、当てはめると根拠の無い点数が出る |
| `targets` が空・相対パス | script が起動時に落ちる。S2 の準備に戻る |

## S13. staging のライフサイクル

- 置き場所は対象文書群の**兄弟**ディレクトリ（対象の配下には作らない）。配下に作ると、
  再採点の担当が本体と下書きの両方を読み、下書きで直した箇所が本体側から同じ指摘として
  再び出て、before/after の突き合わせが成立しない。
- 承認されたら、人間の指示を受けてから `staging.changed_files` に載っているファイルだけを
  本体へコピーする。載っていないファイルは中身が変わっていないので、コピーすると
  承認されていない上書きになる。
- 差し戻されたら staging はそのまま残す。次に `revise` を回すとき、同じ `stagingDir` を
  指定すれば前回の下書きが上書きされる。放置された staging を本体と間違えないよう、
  ユーザーに「不要なら削除してよい」と一度伝える。

## S14. 後続スキルからの呼び出し契約

prd-spec のような文書生成スキルから、監査の観点として呼ばれる前提で作られている。

| 渡すもの | 形式 |
|---|---|
| 採点基準の場所 | `<このスキルの実ディレクトリ>/references/rubric.md`（絶対パスの文字列）。呼び出し側が自前の担当に読ませてもよい |
| 対象 | 生成直後の文書の絶対パス配列 |
| 期待する戻り | 上の `scores` / `jargon` / `worst_sentences` / `breakdown` / `suggestions` |

rubric が読めなかった場合は、呼び出し側も**欠測として報告する**。黙って飛ばすと、
監査を通っていない文書が「監査済み」として下流に流れる。
このスキルは合否を出さないので、呼び出し側がこの結果でブロックするかどうかは呼び出し側の判断。
