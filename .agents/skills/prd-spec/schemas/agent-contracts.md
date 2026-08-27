# agent 間の入出力契約

**目次**: [§intake](#intake) · [§domain-analyst](#domain-analyst) · [§splitter](#splitter) · [§req-writer](#req-writer) · [§spec-writer](#spec-writer) · [auditor 共通形（clarity / traceability / coverage / fabrication / consistency）](#auditor-共通形clarity--traceability--coverage--fabrication--consistency) · [§executability-auditor](#executability-auditor) · [§ladder-judge](#ladder-judge) · [§structural（script が生成する finding）](#structuralscript-が生成する-finding)

各 agent が返す形の正。`scripts/draft.js` と `scripts/refine.js` にも同じ定義が JSON Schema と
して埋まっており、writer / auditor はそちらで構造化出力を強制される。このファイルは**文書側の
正**であり、両者が食い違った場合は script のスキーマを直したうえでここを更新する。

`intake` / `domain-analyst` / `splitter` は SKILL.md が Agent ツールで直接呼ぶため、script の
スキーマ強制がかからない。この 3 つはここが唯一の契約になる。

---

## §intake

SKILL.md が事前分析（手順 2）で呼ぶ。**論点を確定 / 決定（既定）/ 質問の 3 つに仕分ける**
既定選定係。判定手順は `references/question-policy.md` を正とする。

```json
{
  "known": ["確定している事項（根拠となる原文の引用付き。実装先行の案件では [依頼] / [実装の現状] のラベルを付ける）"],
  "decisions": [
    {
      "id": "D-001",
      "topic": "何についての決定か（1 行）",
      "value": "選んだ既定",
      "why": "なぜこの既定か（上位互換 / 正しさ不変 / 標準的選択 のどれか）",
      "source": "default",
      "reversibility": "変更するとき何を直せばよいか（1 行）"
    }
  ],
  "questions": [
    {
      "text": "ユーザーへの質問文（1 問 1 論点）",
      "searched": "依頼文のどこを探して答えが無かったか",
      "candidates": ["選びやすくするための候補。無ければ空配列"]
    }
  ]
}
```

- **`questions` は既定を選べないものだけ**（question-policy.md §判定手順 4 の 2 条件を
  両方満たすもの）。0 件が目標値。旧 `blocks_draft` は廃止 — 質問に残る時点で blocking である。
- 依頼文に答えがある論点・固定前提にある事項を質問に入れてはならない。
- 依頼文に無いことを `known` に入れてはならない。既定で埋めてはならないもの
  （案件の要求そのもの・外部に波及する値・依頼者が保留を明示した事項）を `decisions` に
  入れてはならない。

---

## §domain-analyst

観点の定義は `references/domain-analysis.md` を正とする。

```json
{
  "findings": [
    { "aspect": "10 観点のいずれか", "verdict": "該当 | 非該当 | 不明", "evidence": "入力のどの記述から判定したか" }
  ],
  "required_categories": ["該当した観点から導出した、案件固有の要求カテゴリ"],
  "question_candidates": ["不明の観点をユーザーに尋ねるための質問文"]
}
```

- `findings` は 10 観点**すべて**を返す（該当したものだけ返すと「検討していない」と
  「検討して非該当」が区別できなくなる）。
- `evidence` を空にしてはならない。書けないなら `verdict` は `不明`。
- `required_categories` は案件の言葉で具体化する（例示表の語をそのまま貼らない）。

---

## §splitter

分割の指針は `references/document-splitting.md` を正とする。

```json
{
  "requirements": [
    { "topic": "auth", "concern": "認証と権限", "rationale": "なぜこの単位で切るか" }
  ],
  "specifications": [
    { "topic": "auth", "concern": "認証と権限", "covers": ["auth"], "rationale": "..." }
  ],
  "notes": "分割にあたって迷った点・ユーザーに確認したい点"
}
```

- **`topic` は英字始まりの kebab-case**（英小文字・数字・ハイフンのみ）。script が ID の領域
  コードを作るため、数字始まりや ASCII 以外は使えない。
- 異なる `topic` が同じ領域コードにならないこと（`auth-v1` と `auth_v1` は衝突する）。
- `covers` は、その仕様文書がどの requirements 文書の要求を実現するか。
- 分割数は 1 でよい。**既存文書がある場合は既存の topic を維持するのが既定。**

---

## §req-writer

`scripts/draft.js` / `scripts/refine.js` が文書ごとに呼ぶ。**担当は 1 文書だけ。**

```json
{
  "markdown": "要求文書の本文（常設章は references/document-structure.md を正とする）",
  "summary": "この文書に何が書いてあるかの 1〜2 文。INDEX の文書一覧に使われる",
  "requirement_items": [{ "id": "PR-AUTH-001", "heading": "多要素認証" }],
  "tbd_items": [
    { "id": "TBD-AUTH-001", "text": "決めるべき論点", "owner": "", "due": "", "blocking": true, "candidates": ["決め方の候補（任意）"] }
  ],
  "categories_deferred": ["情報が未確定で章にできず TBD へ落としたカテゴリ名"],
  "referenced_ids": ["本文で言及するがこの文書の項目ではない ID"],
  "item_delta": {
    "after": 24,
    "net_added": 2,
    "added_items": [{ "id": "PR-AUTH-025", "why_not_edit_existing": "既存項目の修正では足りなかった理由" }]
  }
}
```

- `requirement_items` は本文に実在する ID を**すべて**列挙する。script が本文から正規表現で
  独立に抽出して突き合わせるので、抜けると欠陥として検出される。
- **`tbd_items[].id` は `TBD-<領域>-<連番>`。** 各文書は並列に書かれ互いの採番を知らないため、
  領域を冠さないと番号が衝突し、統合時に片方が消える。
- **`candidates`** は決め方の候補（任意）。**本文には書かない** — 文書の読み手は後続の AI で
  あり、「決めてください」は依頼者宛ての対話だから。司令塔がゲートで選択肢に使う。
- **`blocking`** は「これが決まらないと実装・QA に着手できないか」。判定基準は
  `references/traceability.md` §4。
- `owner` / `due` はユーザーが指定していなければ空文字のままにする。埋めた風にしない。
- **`referenced_ids`** に他文書の ID を入れる。複数文書化で他文書への言及は日常的に起きるため、
  ここに入れないと構造検査が申告漏れとして指摘し、直しようのない指摘で改稿枠を消費する。
- `summary` を空にしない。INDEX が「どのファイルに何が書いてあるか」を示せなくなる。

---

## §spec-writer

```json
{
  "markdown": "仕様書の本文",
  "summary": "この文書に何が書いてあるかの 1〜2 文",
  "spec_items": [{ "id": "SP-AUTH-001", "heading": "認証トークンの発行" }],
  "traceability": [
    {
      "requirement_id": "PR-AUTH-001",
      "spec_id": "SP-AUTH-001",
      "verification": "検証方法（テスト種別と、何を測るか）",
      "status": "未着手 | 作成中 | 完了"
    }
  ],
  "tbd_items": [{ "id": "TBD-AUTH-002", "text": "...", "owner": "", "due": "", "blocking": false }],
  "categories_deferred": [],
  "referenced_ids": [],
  "item_delta": { "after": 31, "net_added": 0, "added_items": [] }
}
```

- `traceability` は**この文書がカバーする要求の分だけ**を持つ。全要求を書き写すと他の仕様文書と
  重複し、どちらが正か決まらなくなる。本文中の表と一致させる（片方だけ更新しない）。
- `requirement_id` は他文書の要求を指してよい（文書を跨いだ照合は script が行う）。
  その場合も本文で言及するなら `referenced_ids` に入れる。
- `status` は列挙値以外を返さない。

---

## auditor 共通形（clarity / traceability / coverage / fabrication / consistency）

```json
{
  "failed": [
    {
      "id": "指摘の識別子（例 CL-001）",
      "document": "対象文書のキー（例 requirements/auth）",
      "location": "章名・要求 ID など、書き手が場所を特定できる情報",
      "quote": "問題のある箇所の原文引用",
      "issue": "何が問題か（1〜2 文）",
      "fix": "どう直すか。書き手がそのまま動ける粒度で書く",
      "repro": "判定が割れる具体入力、またはその構成手順（degraded 指摘にも必須）"
    }
  ],
  "checked": "実際に検査した範囲（何を読み、何を見たか）",
  "note": "任意。補足があれば"
}
```

- **判定は `failed` の件数で行う。** 本文中に ❌ や「NG」と書いても script は数えない。
- 指摘が 0 件なら `failed: []` を返す。0 件であること自体が報告に値する。
- `checked` は必須。何も読まずに `failed: []` を返す経路を残さないため。
- **degraded を含む全指摘に「判定が割れる具体入力（またはその構成手順）」を `repro` として
  添付する。書けない指摘は起票しない。** 具体入力を構成できない指摘は「仕上げの好み」であり、
  改稿しても総数が減らない指摘の主たる供給源だから（実測: 改稿のたびに同規模の指摘が汲み出され、
  生成量 ≈ 消化量で収束しなかった）。
- `document` は**渡された文書のキーをそのまま使う**。綴りを変えると宛先を失い、改稿に回らない。
- `[CATEGORIES_DEFERRED]` に挙がっているカテゴリは、章として無くても反映漏れとして扱わない。

### 各 auditor の担当範囲

| auditor | 見るもの | 見ないもの |
|---|---|---|
| clarity | 曖昧語・助動詞規約違反・複合要求 | 内容の正しさ |
| traceability | 紐付けの欠落・検証方法の実質・ステータスの妥当性 | 文言 |
| coverage | `required_categories` の実在・「該当なし」の明記 | 文言 |
| fabrication | 入力・回答・分析結果に根拠が無い断定 | 文体 |
| consistency | **文書間**の重複・矛盾・用語の揺れ・境界の抜け | 単一文書で完結する問題 |
| specimen | 実在の標本文書へ各項目を適用したときの判定不能（blocking）・適用時矛盾 | 標本に当てずに分かる問題・標本自体の品質 |

**片側にしか現れない ID・ID の重複・禁止語の混入は script が検出する**（`structural` として
`unresolved` に混ざる）。auditor が重複して報告しても害はないが、そこは主戦場ではない。

---

## §executability-auditor

**共通形と違い `findings` / `severity` を使う。** blocking の指摘は TBD として起票し直され、
人間ゲート②の提示対象に入るため、`failed` とは別の意味を持つ。

```json
{
  "findings": [
    {
      "id": "EX-001",
      "location": "章名・要求 ID",
      "quote": "問題のある箇所の原文引用",
      "issue": "ここで手が止まる。なぜなら〜が分からないから",
      "fix": "何を決めればよいか（決め方の候補があれば添える）",
      "severity": "blocking | degraded",
      "repro": "判定が割れる具体入力、またはその構成手順（degraded 指摘にも必須）"
    }
  ],
  "checked": "実際に読んだ範囲"
}
```

| severity | 意味 |
|---|---|
| `blocking` | **着手できない。** 決めてもらわないと 1 行も書けない。人間に質問として提示される |
| `degraded` | 着手はできるが、後で作り直しになりうる |

- **degraded 指摘にも「判定が割れる具体入力（またはその構成手順）」を `repro` として添付する。
  書けない指摘は起票しない**（auditor 共通形と同じ較正。仕上げの好みを degraded に流し込ませない）。
- **既に TBD として起票されている項目は指摘しない。** それは正しく扱われている状態である。
- `blocking` の乱発はユーザーが答えきれなくなる。逆に遠慮して `degraded` に落とすと、
  推測で埋めて進むことになる。「本当に手が止まるか」で判定する。
- **文書が参照先として明示しているファイルは読めるものとして扱う。** 参照先を見れば分かる
  ことを「文書に書かれていない」として指摘しない。判定対象は「参照先を開いてもなお決まらない
  こと」である。`[SELF_CONTAINMENT]` ブロックに、何を文書に書き何を参照にとどめるかの合意が
  渡される。参照先が実在しない場合は、それ自体を指摘する。

---

## §ladder-judge

`scripts/refine.js` が監査結果を writer に渡す前に呼ぶ**専任の分類係**（生成側と別 spawn）。
auditor 共通形の finding 配列を受け取り、各 finding に failure kind を付けて返す。
戻り先が writer 改稿 1 種類しか無いと、根拠が入力に無い指摘まで改稿予算を消費してから
TBD 起票で逃げる — 失敗の種別が戻る深さを決める（スコープの梯子）。

```json
{
  "classified": [
    { "digest": "受け取った digest をそのまま", "kind": "artifact | criteria | premise | question", "rationale": "分類の根拠（1 行必須）" }
  ]
}
```

### 判定表（複数行に当たるときは番号の小さい行を採る）

| 優先 | kind | 徴候 | 戻り先 |
|---|---|---|---|
| 1 | `premise` | 指摘の解消に要る根拠が入力・前提（INPUT / ANSWERS / TBD_ANSWERS / DECISIONS）のどこにも無い | `needs_input`（data）。改稿予算を消費させず blocking TBD として起票 |
| 2 | `question` | 依頼者にしか決められない（外部に波及する値・要求そのものの取捨） | `needs_input`（decision）。同上 |
| 3 | `criteria` | 判定基準・既定の欠落。決定ログに既定を要する | writer 改稿。書き手が決められる既定なら writer が既定を提案し、decisions 候補（`tbd_items[].candidates`）として返す |
| 4 | `artifact` | 成果物の記述の欠陥（曖昧・矛盾・欠落・書式） | writer 改稿 |

- **表に無い状況は `question`（`needs_input(decision)`）に落とす。規則を発明しない。**
- `rationale` は必須（1 行）。書けない分類は根拠が無い。
- `digest` は書き換えない（script が照合キーに使う）。分類が欠けた finding は script が
  従来どおり writer へ流す（分類の欠測で改稿経路を止めない）。

---

## §structural（script が生成する finding）

`structuralFindings()` が返す。agent は生成しない。戻り値は `{ findings, not_checked }`。

| `id` の接頭辞 | 検出内容 |
|---|---|
| `ST-DUP-` | 同じ ID が複数文書で定義されている |
| `ST-DUP-TBD-` | 同じ TBD ID が複数文書から別内容で申告されている |
| `ST-ORPHAN-REQ-` | 要求 ID がトレーサビリティ表に無い（実現する仕様が無い） |
| `ST-ORPHAN-SPEC-` | 仕様項目 ID がトレーサビリティ表に無い（根拠が不明） |
| `ST-DANGLING-` | 表が参照する ID がどの文書にも無い |
| `ST-UNDECLARED-` | 本文にあるが ID 一覧にも `referenced_ids` にも無い |
| `ST-PHANTOM-` | ID 一覧にあるが本文に無い |
| `ST-OBSOLETE-` | 廃止済み規制の語の混入（`references/citation-policy.md`） |
| `ST-UNVERIFIED-` | 本文未確認の規格に条番号を付けた引用 |

`not_checked` は**失格ではなく「材料が無くて実行できなかった検査」**。
`ST-NOTCHECKED-CROSSREF` は、片方の kind の文書が対象に含まれず ID 照合が成立しなかったこと
を示す。**「指摘 0 件」と混同させないため、別配列で返す。**
