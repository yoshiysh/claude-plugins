---
name: prd-spec
description: >
  要求文書（requirements）と仕様書（specifications）を日本語で作成・レビューするスキル。
  要求文書は関係者の認識が一致する状態まで、仕様書は実装が一意に決まる状態まで詰める
  （2 つは目的が違うので、分量の決まり方も違う）。「PRD を書いて」「要件定義をまとめて」
  「これを仕様書に落として」「この PRD をレビューして」「要求から仕様書を起こして」といった依頼で
  使うこと。ドメインは問わず、助動詞規約・曖昧語の排除・ID とトレーサビリティ・未確定事項の
  解消を常時適用する。入力に無い要求を推測で埋めず、決めきれていない項目は先例・実測・
  依頼者への質問で run 内に解消する。それでも決まらない論点は「裁定が下るまで何をしてはならないか」
  を定める規範文（保持規則）へ変換して本文に残し、裁定そのものは GitHub Issue として起票して
  完了する。関心事ごとに複数ファイルへ分割し、
  ディレクトリごとの INDEX を導出する。既存コードの挙動説明（「この関数の仕様を教えて」）や、
  文書を伴わない実装・修正依頼には発火しない。
  要求・仕様の体裁を取らない一般ドキュメントの執筆（提案書・意思決定文書・README・ブログ・
  議事録の要約）や設計判断の壁打ちにも発火しない — それらは文書共同執筆・相談系のスキルの領分。
  空入力・単語のみの入力では作成に入らず、何の文書かを尋ねて終了する。
---

# prd-spec（要求文書・仕様書の作成とレビュー）

要求文書は関係者の認識を一致させる文書、仕様書は実装を一意に決める文書である（正は
`references/prd-and-spec.md`）。完成の条件は、開いている未確定事項（TBD）が 0 件であること。決まらない論点は
保持規則（「〜の裁定が下るまで、…してはならない」）にして本文に残し、裁定は Issue にする。

段の順序・起動の条件・上限は名前付き workflow `/workflow:prd-spec-run`（plugin の `workflows/prd-spec.js`）が持つ。**あなた（司令塔）の仕事は、依頼と回答を逐語で運び、
workspace を用意し、保存することだけである。** 決定・問い・回答・文書の文面は書かない。司令塔が書いた文は
どの検証者も通らないまま、依頼者の判断や決定の顔をして文書に届く（実測: 司令塔が起草した決定が回答の欄に
複写され、同じ決定が 2 つの出所から writer に届いた）。役割の分担は `schemas/role-map.md` を正とする。

## 対象外・起動条件

- 既存コードの挙動説明・文書を伴わない実装依頼には使わない（前者は 1 文で伝えて終える）。
- 適合性評価・認証取得の支援はしない。規格に言及しても「準拠している」とは書かない（`references/citation-policy.md`）。
- 空入力・単語のみのときは、推測で対象を決めずに次を返して終える（取り違えた文書は害の方が大きい）。

```
何についての要求文書 / 仕様書かを教えてください。
例: /prd-spec 社内の勤怠申請ツールの要件をまとめたい。承認フローは部長承認のみ。
```

## 流れ

`/workflow:prd-spec-run` が 1 本で走り、止まるのは依頼者の入力を待つ地点（G0・G0-2・G1）だけである。問いが 0 件なら 1 回で終わる。

| 段 | 何をするか |
|---|---|
| S0 | 司令塔: workspace を作り、依頼文を逐語で書き、先例を並べる |
| 1〜3 | 依頼を仕分け（intake）、流れを閉じ（flow-framer）、未決と矛盾を裁定する（resolver → resolver-verifier） |
| G0 | 初稿の前に、プロダクトの価値の判断だけを聞く（流れの抜けもここで届く） |
| 3a・3b・G0-2 | 回答を当て、回答で flow を組み直す。回答の反映で出た問い（差し戻しで問いに戻したものを含む）と、組み直した flow から出た問いを 1 回にまとめて聞く |
| 4〜5 | 初稿を書き（writer）、implementer・grounding・cross-doc で 1 回監査する |
| 6・G1 | 決定が要る指摘を裁定する。初稿の後に初めて出た価値の問いだけを聞く |
| 7〜8 | 改稿し、変えた範囲だけを監査する。blocking が 0 になるか進展が止まるまで回す（上限は `MAX_AUDIT_PASSES`。残れば blocked） |
| 9 | 事後報告（resolver）→ 司令塔が照合して保存する |

段ごとの入出力、返り値の読み方、再実行は `references/workflow-io.md` を正とする。

## S0: workspace を用意する

1. **入口（entry）を決める。** 作るものが要求文書か仕様書かは `references/document-splitting.md` §0 の表で判定する。

   | 依頼 | entry |
   |---|---|
   | 新しく書く | `new` |
   | 既存の要求文書・仕様書の監査と改訂（所在が示されている） | `existing` |
   | 要求文書から仕様書を起こす | `expand` |

2. **W を作る**: `~/.claude/prd-spec-workspace/<案件>/`（絶対パスに展開する。Write は `~` を展開しない）。
   対象リポジトリの中に作業ファイルを置かない（そのリポジトリの `.gitignore` は利用者の持ち物である）。
3. **依頼文を `W/input.md` に逐語で書く。** 貼り付けられた議事録やメモも含め、要約も整形もしない。要約すると、
   依頼者が言っていないことが入力の顔をして全員に届く。
4. **既存文書**（`existing`・`expand`）は `W/<kind>-<topic>.md` に逐語で置き、`existing_docs` に
   `{ key: "<kind>/<topic>", source: "<元のパス>", fixed }` で並べる。`expand` の要求文書は `fixed: true` にする
   （固定の文書は別のランで承認されたもので、ここで書き換えるとその承認を迂回する）。固定の印の meta は書かない。段 1 の入口の
   `doc_check reset` が W を S0 の直後に戻すときに、`existing_docs` の `fixed` から書く。`existing_docs` に無い文書はその reset が消す
   （`references/workflow-io.md` §3）。
5. **先例を並べる**: `python3 [SKILL_DIR]/scripts/precedent.py list --root ~/.claude/prd-spec-workspace --workspace <W>`。
   規則どおり全部並べるだけで、選ばない（選ぶのは intake と resolver）。依頼者が旧い形式の過去のランを先例に
   挙げたときは、先に `precedent.py convert --from <そのランの args の JSON> --out ~/.claude/prd-spec-workspace/<そのラン>/legacy`
   で変換してから並べる。

## 中継: /workflow:prd-spec-run を呼び、返り値のとおりに運ぶ

```
Workflow({
  name: "workflow:prd-spec-run",
  args: { workspace: "<W の絶対パス>", skillDir: "[SKILL_DIR]", entry: "new | existing | expand", existing_docs: [] }
})
```

args に打ち直すのは ID・件数・digest と、返った `next_args`・回答済みのゲートだけにする（依頼文は W/input.md に、flow などの本体は W に
ある。why は `references/workflow-io.md` §1）。model / effort は全役に既定があり、`role_opts` で上書きできる
（`references/workflow-io.md` §2）。返った `next_args` は変えずに渡す（変えてよい欄と、変えたときに止まる仕組みは
`references/workflow-io.md` §3）。返り値の `status` で次を決める。

- **`needs_answers`**（G0・G0-2・G1）: 先に `node [SKILL_DIR]/scripts/doc_check.mjs questions --ids <question_ids をカンマで> --workspace <W>`
  を実行する。INDEX と同じく、resolutions.json の問いから `questions_path`・`questions_json_path` を導出するだけの
  実行である。exit 0 で終わらなければ、問いを出さずに同じコマンドを流し直す（2 つのファイルの片方だけが新しい
  ことがある）。`questions_json_path` の問いを AskUserQuestion で出す（1 回に 4 問まで。
  `header`・`question`・`options` の文面は**変えずに**渡す）。選択式で答えやすくするためで、文面を縮めたり
  言い換えたりすると、その要約は誰にも検証されないまま依頼者の判断材料になる。背景を読みたいと言われたら
  `questions_path` の本文をそのまま見せる。回答は `<ID>: <選ばれた label>` の行（自由記述や注記があればその文を
  続けて逐語で）として `answers_path` に**逐語で**書き、下の「呼び直し」のとおりに呼び直す。回答を言い換えたり、候補の番号に丸めたり、
  回答の無い問いを既定で埋めたりしない。回答の解釈は resolver が行い、候補の外の自由記述は verifier が検証する。
  司令塔が解釈すると、その解釈は誰にも検証されない。
- **`blocked`**: `reason` をそのまま伝える。`next_args` があるのは、その段からやり直せる失敗（agent が応答
  しなかったなど）のときで、原因を除いてから下の「呼び直し」のとおりに呼び直す。`report_path` があれば
  `node [SKILL_DIR]/scripts/doc_check.mjs report --workspace <W> --drafts "<返り値の hold_drafts をカンマで>"` で導出して
  そのまま見せ、止まった理由（`stop_reason`）、返り値の `holds` と `hold_drafts`、残った blocking（`remaining_blocking`・`carried_blocking`・`doc_blocking`）を
  並べて見せる（意味は `references/workflow-io.md` §3）。blocked のまま保存しない。
- **Workflow が例外で終わった、または `reason` が「script の不変条件に反しました」**: `references/workflow-io.md` §5 に従う。
- **`done`**: 下の「保存」へ進む。

**呼び直し**（resume と `next_args` の使い分けは、ここにだけ書く）:

- **同じセッションの中では resume する。** 返り値の `resumable` が true なら、返った run の `runId` を `resumeFromRunId` に渡し、
  args はその run を起動した args を変えずに渡す。needs_answers の後は、回答を書き終えたゲート（`answers_path` のファイル名の
  `g0`・`g0-2`・`g1`）を `answered` に足す（前の resume で足したものも残す）:
  `Workflow({ name: "workflow:prd-spec-run", resumeFromRunId: "<runId>", args: { <その run の args>, answered: ["g0"] } })`。
  完了した agent は保存された結果を返し（費用 0。W にも書かない）、ゲートの後か、失敗した agent とその後に起動した agent だけが走る。
- **resume するときは args と W を変えない。** `answered` のほかの欄（`skillDir`・`role_opts` を含む）を変えたり W を手で変えたりすると、
  最初の agent のプロンプトか前提が変わり、段 1 の入口の reset から live で走り直して、書いた回答ごと W を S0 の直後に戻す
  （保存された結果は、ゲートより前の agent が W に書いたことを再現しない）。変えたときは `next_args` で呼び直す。
- **`next_args` で呼び直すのは次のときだけ**: `resumable` が false の blocked（失敗した agent が無いので、resume すると保存された結果が
  同じ理由で同じ所に戻る）、resume が起動の前に拒まれた（別のセッションの `runId`・plugin の更新の後・Workflow ツールのエラー）、
  上の理由で args か W を変えた。`next_args` は変えずに渡す（どの段から始めるかは `next_args.from` が決め、状態は W と `next_args.state` に
  ある。`references/workflow-io.md` §3）。`next_args` で起動する（resume しない）ときは `answered` を足さない（回答は answers にあり、`from` がゲートの後の段から始める）。
- resume で起動した run の返り値も、同じ規則で扱う。

## 保存と事後報告

保存先が git で可逆な docs である限り、保存は人間の承認を待たずに行い、事後報告で覆せるようにする。止まるのは、
不変条件（`.claude/rules/`・`CLAUDE.md`・PR のマージ・外部公開）に触れるとき、保存先が git 管理下でないとき、
このランの生成物でない既存ファイルを上書きするとき（下の衝突）だけである。

1. **照合**: `node [SKILL_DIR]/scripts/doc_check.mjs tree-digest --workspace <W>` の `digest` と、返り値の
   `tree_digest` を文字列で比べる。違えば保存しない。最後の監査の後に誰かが文書を書き換えており、保存しようと
   している版は監査されていない。同じ出力の `stray`（W に所有表に無いファイル。版の控えや残った作業用の script）の
   件数が 0 でなければ、保存は止めずに、`stray.path` のファイルの一覧を事後報告に添える。続けて
   `node [SKILL_DIR]/scripts/doc_check.mjs report --workspace <W>` で `W/report.md` を導出する（3・4・5 が読む）。
2. **INDEX**: `node [SKILL_DIR]/scripts/doc_check.mjs index --workspace <W> --req-dir <要求の保存先> --spec-dir <仕様の保存先> --open-tbd "<返り値の open_tbd をカンマで>"`
   を実行し、出力の `indexes.<kind>.path` のファイルを `save_to` へ逐語で写す。INDEX は導出物で、手で書くと本体と
   ずれる。W に無い文書は INDEX に載らないので、保存先に他の文書があるランでは S0 でそれも W に置き、`existing_docs` に `fixed: true` で並べる（固定の印は `existing_docs` にしか無く、並べない文書は書き換えてよい文書として監査される）。
3. **文書**: `W/<kind>-<topic>.md` を保存先へ写す。`new`・`expand` の保存先は既定で `docs/requirements/<topic>.md`・
   `docs/specifications/<topic>.md`、`existing` は `existing_docs[].source`（元の場所。別の場所に写すと、改訂が
   新規の文書に化けて元の文書が古いまま残る）。INDEX の `--req-dir`・`--spec-dir` も保存先に合わせる。`fixed` の文書は写さない。meta は写さない（根拠は W と commit に残る）。
   - 新規保存で同名のファイルが既にあれば上書きせず、差分を見せて判断を求める。
   - `existing` で既存文書を意図して改訂するときは止めない。差分と変更理由（`report.md` の該当箇所）を見せてから上書きする。
4. **事後報告**: 1 で導出した `W/report.md` をそのまま見せる。方法論として決めたこと・保持規則・Issue の文案・上位文書の改訂の文案がそこにある。
   依頼者はここで覆せる。返り値の `open_tbd` が 1 件以上なら「完成しました」と言わず、「あと N 個決まれば着手
   できます」と件数と ID を示す。`integrity`・`notices`・`missed`・`undeclared` が空でなければ、その行をそのまま添える（`undeclared` は writer が申告せずに変えた項目で、追加の監査は済んでいるが、申告漏れがあった事実は依頼者に見えるようにする）。
   `integrity` は sha256・digest の照合で食い違った事実、`notices` は照合ではない所見（監査の時点で W に所有表に無いファイルがあった、分量の目安を超えたファイルがあった、など）である。
5. **Issue**: `report.md` の Issue の文案は、依頼者の承認を得てから `gh issue create` で起票し、番号を報告する。
   文案は書き換えない。
6. **経緯は commit と PR に残す**: 文書には決定ログも経緯も書かない（`references/document-structure.md` §4）。
   commit メッセージに主要な決定を、PR 本文に保持規則と Issue の一覧を書く。git 管理下でない案件では、経緯が
   W にしか残らないことを 1 文で伝える。
7. 承認欄を置いた案件では、このスキルは承認者の実在も承認の事実も確認できず、記入されるのは依頼者が申告した
   文字列にすぎないことを 1 文で伝える。

保存した文書を手で直さない。直すなら `entry: existing` でもう一度走らせる。手で直した版は誰の監査も通って
いない。

## 実行環境

native の Workflow で、名前付き workflow `/workflow:prd-spec-run` を呼ぶ。名前で呼ぶのは、plugin の workflow を名前で呼ぶと承認に
「Yes, and don't ask again」が出る（本家の workflows の文書）ので、ゲートと blocked のたびの呼び直しで承認を繰り返さずに済むからである。

native の Workflow が無い Codex では実行しない。`workflow:dynamic-workflow-runner` は skill の中の `scriptPath` の callsite だけを扱い、
名前の callsite と skill の外の script を受けないので、この skill は runner が実行の前に拒否する対象である。

## 参照ファイル

| パス | 何の正か |
|---|---|
| plugin の `workflows/prd-spec.js`（名前 `/workflow:prd-spec-run`） | 段の順序・起動の条件・上限・返り値の検査（Workflow script） |
| `[SKILL_DIR]/scripts/doc_check.mjs` | 本文を読む決定的な検査・snapshot と diff・tree-digest・INDEX の導出 |
| `[SKILL_DIR]/scripts/precedent.py` | 先例の一覧と、旧い形式のランの変換 |
| `[SKILL_DIR]/scripts/usage.py` | 1 ランの費用と時間の集計（母集団の定義を持つ） |
| `[SKILL_DIR]/schemas/role-map.md` | 役割と責務（1 role = 1 責務） |
| `[SKILL_DIR]/schemas/agent-contracts.md` | W のファイル・所有・各役の返り値 |
| `[SKILL_DIR]/agents/` | 各役の振る舞い（役割は frontmatter の description が正。model / effort は `workflows/prd-spec.js` の `ROLE_OPTS` が正） |
| `[SKILL_DIR]/references/workflow-io.md` | `/workflow:prd-spec-run` の args・返り値・段・再実行 |
| `[SKILL_DIR]/references/io-example.md` | 依頼から保存までの通しの例 |
| `[SKILL_DIR]/references/prd-and-spec.md` | 2 文書の目的と切り分け・必須の内容 |
| `[SKILL_DIR]/references/document-structure.md` | 章立て・表と図・本文に書くのは規範だけ（§4） |
| `[SKILL_DIR]/references/document-splitting.md` | 何を作るか・分割・topic・INDEX |
| `[SKILL_DIR]/references/requirement-writing-rules.md` | 語尾・曖昧語・単一要求・EARS・数値 |
| `[SKILL_DIR]/references/traceability.md` | ID の形式・トレーサビリティ表・TBD |
| `[SKILL_DIR]/references/fixed-premises.md` | 案件ごとに問い直さない前提 |
| `[SKILL_DIR]/references/question-policy.md` | 聞くか決めるかの判定・既定にしてはならないもの |
| `[SKILL_DIR]/references/domain-analysis.md` | ドメインの 10 観点と三値判定 |
| `[SKILL_DIR]/references/citation-policy.md` | 規格への言及・禁止語 |
| `[SKILL_DIR]/references/quality-checklist.md` | 生成物の品質チェックリスト |
| `[SKILL_DIR]/references/telemetry.md` | このスキル自身を改善するときの実測の記録と対照 run |
| `[SKILL_DIR]/tests/` | `python3 -m unittest discover -s [SKILL_DIR]/tests` で全部走る |
