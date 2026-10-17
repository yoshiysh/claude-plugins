# 司令塔：review / update / audit の提示と適用

名前付き workflow `/skill-creator:skill-creator-review`（plugin の `workflows/review_skill.js`）の戻り値を人間に見せ、update なら承認を得て本体へ反映するまでの手順。
SKILL.md の「結果の提示と適用（review/update）」と、create の保存後の監査（`references/orchestrator-output.md`）から Read される。

## 目次

- [提示の原則](#提示の原則)
- [review の提示フォーマット](#review-の提示フォーマット)
- [audit の提示フォーマット](#audit-の提示フォーマット)
- [update の提示フォーマット](#update-の提示フォーマット)
- [司令塔は staging を書かない](#司令塔は-staging-を書かない)
- [承認後の適用手順](#承認後の適用手順)
- [非承認・中断のときの扱い](#非承認中断のときの扱い)
- [設計上の制約](#設計上の制約)

---

## 提示の原則

1. **3 つのバケットを必ず区別する。** `confirmed`（確定）・`rejected`（反証で棄却）・
   `unverified`（検証が揃わず判断保留）。棄却と未検証を黙って落とすと、
   「見ていない」が「見て問題が無かった」に化ける。件数だけでも必ず出す。
   これは update の再検証結果（`staging.unverified`）でも同じ。
   反証に回していない `findings.reported_minor` も同じ理由で、確定とは別の枠で中身ごと出す。
   update では改稿前の分（`findings_before.reported_minor`）も併せて出す。再検証は範囲を絞るので、
   改稿後の一覧に無いことは「消えた」を意味しない。
2. **観点の欠落を隠さない。** `by_category.before` が `null` の観点は「その観点では見ていない」。
   合格の材料に数えない。`"unavailable"` の観点（`skipped_unavailable` に載る）も見ていない点は同じで、
   理由が「担当が応答しなかった」ではなく「必要な skill / criteria / capability を実行環境で利用できなかった」だと区別して名指しする。
   `by_category.after` 全体が `null` なのは別の意味で、
   「再検証のパス自体が走らなかった」（review・audit、または改稿前に止まった場合）。
3. **どちらの時点の指摘かを言う。** `findings_source` が `"before"` なら改稿前、
   `"after"` なら再検証後。取り違えると「まだ直っていない」と「もう直した」が逆に読める。
4. **数値の判定を再計算しない。** verdict は script が決めている。ここで条件を
   組み直すと、同じ判定が 2 箇所に存在することになる。
5. 技術用語を避ける。「指摘」「反論で消えたもの」「確かめきれなかったもの」で通じる。
6. **update では staging の指紋を必ず 1 行で出す。** 司令塔は staging を書かないが、
   ファイルシステム上は誰でも書ける場所で、手が入ったかどうかは読み手には見えない。
   ユーザーの目に触れた値があって初めて、反映直前の再計算が帯域外の書き込みを検出できる。
   値は「承認後の適用手順」の手順 0 で script が出す `fingerprint` を、そのまま提示に載せる。
7. **snapshot verify が `status: verified` 以外なら結果を出さない。** 非 0 終了も同じ扱い。
   確定・棄却・未検証のどのバケットも、verdict も提示せず、「対象が実行中に変わったか snapshot が
   壊れたため、今回のレビューは見ていない扱い」と verify の出力（理由）をそのまま伝える。update では
   staging を適用候補として示さない。drift した snapshot に対する指摘を出すと、読み手は現在の
   対象を見た結果だと受け取り、見ていないものが「見て問題が無かった」に化ける。

---

## review の提示フォーマット

```
このスキルを見た結果です。

【直した方がよいもの】（3件）
1. [blocker] SKILL.md — モード判定の表に「範囲が読み取れない場合」の行が無い
   根拠: 「| 何を対象にするか読み取れない | ...」の行が存在しない
   直し方: 判定不能の行を追加し、聞き返す内容を書く
2. [major] ...

【軽微なもの（反論にかけていません）】1件
  - [minor] ...

【反論で消えたもの】2件（実物と照合したところ、指摘が成り立ちませんでした）
【確かめきれなかったもの】1件（検証が揃わなかったため、判断を保留しています）

観点ごとの確定件数: 理由の無い命令 1 / 散文に残った確定的処理 0 / 二重定義 1 /
経路の無い依頼 1 / description との乖離 0 / ベストプラクティス準拠 0 /
古くなったプロンプトの書き方 0
```

観点の名前と並びは戻り値の `by_category.before` のキーから取る（観点の一覧の正本は script の `FINDERS`。
上の例を一覧として写さない）。

- `confirmed` は `severity` 順（`blocker` → `major`）に並べる。`reported_minor` は確定ではないので
  【直した方がよいもの】に混ぜない。混ぜると「反論を生き残った」と読まれる。
- `unverified` か `reported_minor` が 1 件でもあれば、`confirmed` が 0 件でも「問題なし」とは言わない。
- `unverified` の各指摘には、`missing_perspectives` に記録された票の欠けた観点も添える。
  指摘ごとに反証が揃わなかった理由が分からないと、確認済みの範囲と未検証の範囲を見分けられない。
- 最後に「このまま直すこともできます（update）」と一言添える。review だけを頼まれた
  ときに勝手に直さないための線引きが、ここで初めて相手に見える。

`verdict: review_incomplete` のときは、冒頭に次を置く。

```
※ 一部の観点（〜）が実行できなかったため、この結果は全体を見たものではありません。
```

`skipped_unavailable.before` が空でないとき（`verdict: clean_except_unavailable` を含む）は、冒頭に次を置く。

```
※ 観点（〜）は、必要な skill / criteria / capability がこの環境に無いため実施していません。その観点では見ていません。
```

---

## audit の提示フォーマット

review の提示フォーマットをそのまま使う（観点は 1 つなので「観点ごとの確定件数」の行は省く）。違いは 3 点。

- 【監査が挙げたが指摘にしなかったもの】として `declared_only.before` を件数と中身（file:location — claim、
  確信度、Action）で出す。0 件でも行を残す。ここを出さないと「監査が見て何も言わなかった」と区別できない。

- 末尾の一言は「直すなら、この指摘を変更意図にして update で直せます」にする。適用は必ず update を通す
  （audit は staging を持たず、指摘の文言を司令塔が本体へ書き写すと、誰の検証も通らない改稿になる）。
  update を呼ぶときは、提示した `findings.confirmed` と `findings.reported_minor` の file / location / claim /
  suggested_fix を `intent` にそのまま並べる。
- `verdict: review_incomplete` のときは、指摘の一覧ではなく次だけを伝える。「指摘なし」とは言わない。

```
※ 古くなったプロンプトの書き方の監査（prompt-audit）を完了できませんでした。監査はしていません。
```

---

## update の提示フォーマット

```
staging に改稿を書きました（本体はまだ変えていません）。

書き出し先: <staging.dir>
　※ ここには対象スキルの全ファイルが複製されています。実際に書き換えたのは下の一覧だけです。

【変更したファイル】
- SKILL.md — モード判定セクションを追加（指摘 2 件を解消）
- agents/finder.md — 新規（意図: Issue #31 の観点分離）
【この反映では行われない変更】0件（削除・改名・移動と、スキル外のファイルの変更。承認しても適用されません）

【解消できた指摘】3件
【まだ残っている指摘】1件
  - [major] ...
【新しく出てきた指摘】0件
【確かめきれなかった指摘】1件（再検証で判断が揃いませんでした。下の「まだ残っているか確かめきれなかった指摘」はこの内数）
  - [major] ...
【軽微なもの（反論にかけていません）】改稿後 1件 / 改稿前 2件
  - [minor] ...
【言い換えの可能性がある指摘】0件（同じ箇所・同じ観点だが文言が変わったもの）
【再検証で見られなかった箇所の指摘】0件（消えたのか見ていないだけかが分かりません）
【改稿前は未検証・棄却だったが今回確定した指摘】0件（改稿が持ち込んだものではありません）
【まだ残っているか確かめきれなかった指摘】0件（上の「確かめきれなかった指摘」の内数。最初に確定した指摘が再び出たが判断が揃わなかったもの。解消には数えていません）
【再検証で反論により消えた指摘】0件（再び出たが反論で成り立たなかったもの。解消とは別に数えています）
【改稿前に確かめきれず、再検証で見て出なかった指摘】0件（一度も確定していないので、解消とは呼びません）
【改稿前に確かめきれず、再検証でも見られなかった指摘】0件（出なかったのか見ていないのかが分かりません）
【再検証で見直さなかった範囲】変更ファイルと、残っていた指摘のファイル以外（改稿前と同じ内容のため）
　範囲外で報告されたため確かめていない指摘: 0件
【改稿前から同じ文言で存在していた指摘】0件（改稿前の検査が見落としたもの。改稿が持ち込んだものではありません）
【この環境で実施できなかった観点】改稿前: なし / 再検証: なし

【この時点の中身の指紋】a1b2c3d4e5f6
　※ 反映の直前にもう一度この指紋を取ります。変わっていたら、誰かがこの外で書き換えたという
　　事実なので、その内容を反映せず、改めて更新をやり直します。

本体に反映してよいですか？
```

- `staging.dir` は必ず見せる。承認しない場合でも、そこを直接見たいと言われる。
  `stop_reason: budget` で最初の改稿より前に止まったときは `staging` が `null` で、書き出しも指紋も
  存在しない。上のフォーマットは使わず、「改稿を始める前に予算の残りが足りず止めた。本体も staging も
  書いていない」と伝え、改稿前の `findings` を review と同じ形で提示する。
- 【この時点の中身の指紋】の行は必ず出す。値は「承認後の適用手順」の手順 0 で script が出した
  `fingerprint` そのままで、**提示のこの時点で取ったもの**であることが読み手に見える形にする。
  提示できる状態は「一致」しかない。不一致は報告する結果ではなく反映の拒否なので、
  「手直しの再検証を通した」形の行は存在しない。
- `remaining` / `new` / `unverified` / `still_unverified` は件数だけでなく中身を出す。件数だけだと承認の判断ができない。
- 【この反映では行われない変更】の行は 0 件でも残す（値は `staging.out_of_scope_changes`。1 件以上なら
  `kind`・`path`・`change` を 1 件ずつ出す）。行が無いと、承認すれば依頼の全部が反映されると読まれる。
  値が `null`（`update_failed`）なら「不明（改稿の担当が応答しなかったため）」と書き、0 件とは書かない。
- `possibly_rephrased` と `unobserved` は 0 件でも行を消さない。0 と「その概念を出さない」は
  読み手にとって別の意味で、行が無いと「そういう区別はされていない」と読まれる。
- `unobserved` があるときは、`resolved` の件数に含まれていないことを明示する。
- 【再検証で見直さなかった範囲】の行は必ず残す（値は `staging.reverify_scope`）。範囲外を見ていない
  ことが見えないと、範囲外の 0 件が「見て問題が無かった」に化ける。
- 冒頭に止まった理由を `stop_reason` から 1 行で添える（`needs_human_decision` は複数の理由が共有する）。
- `still_unverified` / `refuted_on_recheck` / `unverified_absent` / `unverified_unobserved` も 0 件で行を残す。
  `resolved` に入れなかった理由が見えないと、解消の件数がそのまま「直った数」と読まれる。
  `still_unverified` は `unverified` の内数なので、2 つの件数を足さない。
- `reclassified` / `preexisting` も 0 件で行を残す。`new` が「改稿で悪くなったか」を判断する
  唯一の数字なので、そこに入れなかった理由が読み手に見える必要がある。
- 【この環境で実施できなかった観点】の行は必ず残す（値は `skipped_unavailable.before` / `.after`。`.after` は
  `reverify_receipt.skipped_unavailable` と同じ）。空でなければ冒頭にも review と同じ ※ の 1 行を置き、
  その観点では改稿前も改稿後も見ていないと伝える。receipt の完了はその観点を除いた残りで判定されているので、
  伝えないと「全観点で再検証を通った」と読まれる。
- verdict ごとの言い回しは SKILL.md の verdict 表に従う。ここで条件を再解釈しない。

---

## 司令塔は staging を書かない

司令塔の役割の境界（内容の生成・修正・採点をしない）は SKILL.md 冒頭が正本。この節は、update で
その境界から漏れやすい経路を閉じる。改稿は updater の仕事で、未解消の指摘は script が
ループ内で updater へ戻す（`REVISE_SEVERITIES`）。ループの出口から漏れた指摘を司令塔が手で塞ぐと、
検証されない変更が本体に入る。

例外は置かない。**ユーザーの明示指示でも、minor の文言 1 つでも、司令塔は staging を書かない。**
直すべきものが出てきたら、それを新しい `intent` にして update をもう 1 周回す。
「明示指示なら可」という例外には severity の上限が無く、`あなたが直して` の一言で blocker 級の改稿まで
この経路に流れる。例外の境界は言葉では守れない。

- **コスト**: 1 行の文言修正にも updater 1 周（改稿 + 全観点の再検証）がかかる。これは承知の上。
- **それでも純化する根拠**: 安価に見えた司令塔の手修正は、実測 3 件中 3 件が欠陥を持ち込んだ。
  改稿した本人には改稿の欠陥が見えない —— update 経路はこの非対称性を前提に Update と Reverify を
  別の担当に分けている。司令塔の手修正だけをその外に置く理由が無い。1 周分の費用は、
  検証されていない変更が本体に入る確率と引き換えになっている。

---

## 承認後の適用手順

適用してよいのは verdict が `applied_to_staging` の staging だけ。`needs_human_decision` /
`reverify_incomplete` / `update_failed` で人間が反映を望んだ場合も staging は適用せず、残った指摘を
新しい `intent` にした update を回し直す（再検証を通っていない、または通らなかった改稿を本体に入れないため）。

### Codex runner の approved package 適用

verified return の `source_result.verdict: applied_to_staging`、`action_package_path`、
`action_package_sha256` を提示して承認を得る。全て揃わなければ適用しない。
承認後だけ次を実行する。

```bash
node [SKILL_DIR]/scripts/apply-update-package.mjs \
  --package "<action_package_path>" \
  --approved-package-sha256 "<action_package_sha256>"
```

helper は package と target / staging の tree hash、add/update/delete manifest、Reverify receipt を再照合し、
同じ親ディレクトリに準備した tree で target を置換する。失敗時は元 tree を保持または rollback する。
`applied_with_backup_remains` は適用済みとして backup の所在を伝える。中断時に backup が残る場合も
勝手に消さない。手動コピーへ fallback しない。適用後は `quick_validate.py` を実行し結果を伝える。

### native Workflow の適用手順

以下は native Workflow で完了した update だけに適用する。Workflow は実行中にユーザー入力を受け取れないため、
承認後の適用だけは script の外にあり、司令塔が `scripts/apply-staging.mjs` を実行する。
指紋の取得・照合・コピー対象の限定・不一致時の拒否と変わったパスの列挙は、この script が行う。

指紋の役割は**違反検出器**であって、手直しを検証して通すための装置ではない。司令塔は staging を
書かないので、値が動いていたら「誰かがこの経路の外で書いた」という事実だけが分かる。その内容の良し悪しを
司令塔は判定できない（判定は Reverify の担当の仕事で、帯域外の書き込みはそれを通っていない）。

#### 手順 0: 基準の指紋を取る（Workflow の戻り値を受け取った直後）

`<作業ディレクトリ>` は、update の戻り値を受け取るたびに `mktemp -d` で新しく作り、その出力したパス。
手順 1 でも同じパスを使う。既定の `staging.dir` は update を回し直しても同じパスなので、基準ファイルの置き場を
staging から決めると前の run の基準と衝突する（script は既存の基準ファイルを上書きせずに拒否する。
上書きを許すと、帯域外の書き込みのあとに取り直した基準で照合が通ってしまう）。

```bash
mktemp -d
node [SKILL_DIR]/scripts/apply-staging.mjs fingerprint --staging "<staging.dir>" --out "<作業ディレクトリ>/staging-baseline.json"
```

出力の `fingerprint` を提示メッセージの【この時点の中身の指紋】行にそのまま載せる。基準ファイルは
staging の外に置く（中に置くと指紋を取る対象自体が変わるため、script が拒否する）。
`baseline already exists` で拒否されたら、その基準がこの戻り値のものなら取り直さず、手順 1 でその基準を使う
（取り直すと、提示した指紋のあとの書き込みを基準に取り込んでしまう）。【この時点の中身の指紋】には、拒否の
出力にある既存の基準の `fingerprint` を載せる（`staging_dir` が `<staging.dir>` と一致することを確かめる）。
新しい `<作業ディレクトリ>` を作るのは、update を回し直して新しい戻り値を受け取ったときだけ。

- **戻り値を受け取った直後**に 1 回実行する。書き換えのあとに基準を取れば不一致は起きないので、後から
  取る運用では自分で取った 2 つの値を自分で比べるだけになる。ユーザーの目に触れた値になって初めて
  あとからの照合が意味を持つ。
- 検出できないのは「戻り値を受け取る前に staging を触った場合」だけ（基準自体が既に書き換え後になる）。

#### 手順 1: 承認後に適用 script を実行する

`staging.changed_files` を戻り値から加工せずに JSON ファイル（staging の外）へ書き出し、実行する。

```bash
node [SKILL_DIR]/scripts/apply-staging.mjs apply --staging "<staging.dir>" --target "<対象スキルの実パス>" \
  --baseline "<作業ディレクトリ>/staging-baseline.json" --changed-files "<作業ディレクトリ>/changed-files.json"
```

- **成功（`status: applied`）** → `copied` の一覧を伝え、基本バリデーションに進む。
- **拒否（非 0 終了・`status: rejected`）** → 照合や検査で止まったなら何もコピーしていない。コピーの
  途中で止まったなら、出力の `copied` にコピー済みのパスが載る。出力の `reason`・`changed_paths`・`copied` をそのまま伝える（`changed_paths` のうち `/` で終わるものは
  ディレクトリで、`./` は staging の直下）。指紋の不一致なら、
  その変更を反映したいときは**改めて update を回す**（変えたい内容を新しい `intent` にする）。
  ここで内容を検証して通す経路は置かない（上の「司令塔は staging を書かない」）。

script は `changed_files` に挙がったファイルだけを staging 内の相対パスのまま本体へ書き、それ以外は触らない。
ファイルの削除・改名は適用しない（updater もそれをしない。`agents/updater.md`）。

#### 手順 2: 基本バリデーション

```bash
python3 [SKILL_DIR]/scripts/quick_validate.py <対象スキルの実パス> --verbose
```

検証で落ちた項目があれば、その内容をそのまま伝える。落ちたことを黙って直そうとすると、
承認された変更に承認外の変更が混ざる。

---

## 非承認・中断のときの扱い

- 完了した Workflow の戻り値が空・想定外（全観点 0 件・`findings` が欠けている等）なら、原因を推測したり
  `resumeFromRunId` で再実行したりする前に `<transcriptDir>/journal.jsonl` を読み、各 agent が実際に返した値を
  確かめる（理由は `references/skill-writing-guide.md`「Workflow 型スキルの執筆」の「デバッグ」）。
- staging は**消さない**。消すと「やっぱり見せて」に応えるために全部を回し直すことになる。
- 「どこにあるか」だけを伝えて終了する。
- `verdict: update_failed` のときは、改稿の担当が応答しなかったため
  **staging に何がどこまで書かれたかは分からない**。`staging.changed_files` は空で返るが、
  これは「何も書かれていない」ことの証明ではない（一覧を返す前に落ちた可能性がある）。
  `staging.dir` を提示し、中身を見て判断してもらう。「何も書かれていません」とは言わない。

---

## 設計上の制約

SKILL.md の「設計上の制約」から参照される。制約の本文はここが唯一で、SKILL.md 側には
要約を置いていない（2 箇所に分けると片方だけが更新される）。

### パスは呼び出し側が実体で渡す

Workflow script はファイルシステムに触れず、symlink の解決も自分ではできない。
`skillDir` と `target.skillPath` は司令塔が `realpath` で実体に解決してから渡し、script 側は
「空でない絶対パスか」だけを検査して落とす。`.claude/skills/...` のような参照パスを
script に埋め込むと、install 先（別ディレクトリに展開される）で解決できなくなる。

### staging はスキル本体の外に置く

Native Workflow で `args.stagingDir` を省略したときの既定値は review/update の workflow
（plugin の `workflows/review_skill.js`）が持つ。これは対象スキルディレクトリの**兄弟**であって
内部ではない。Codex runner では caller が `stagingDir` を渡さず、host policy が
`updatePolicy.stagingRoot/update-<uuid>` を選んで args に注入する。この staging も対象スキルの外に
置かれる。スキルディレクトリを列挙する検証スクリプトや参照実在チェックは配下を再帰的に見るため、
内部に置くと未承認のドラフトが本体スキルの一部として検査・配布の対象に入る。明示的に
`stagingDir` を渡す場合も対象スキルの配下は指定できず、script が起動時に落とす。

### staging の指紋は Workflow の外の script が取る

Workflow script はファイルシステムに触れないため、staging の中身から値を作れない。帯域外の書き込みの
検出に使う指紋は、Workflow の戻り値ではなく `scripts/apply-staging.mjs` が取り、照合も同じ script が行う。
Workflow script 側に digest を足そうとすると、ファイルを読めないまま常に空を返すフィールドができる。

### 新設ファイルは実体で置く

`agents/finder.md` `agents/refuter.md` `agents/updater.md` `references/orchestrator-review.md` は
このスキルディレクトリ直下の実ファイル、workflow の `review_skill.js` は plugin の `workflows/` 直下の実ファイル
（置き場の規則は `references/best-practices.md` §13「script の置き場」）。配布サブツリーに symlink を置くと、
取得側によっては symlink が落ちて中身が空になる。

### agent の frontmatter は既存と同じフィールドに揃える

新設 agent の frontmatter は `description` のみ。model / effort は起動する script の `agent()` opts に書く
（`references/best-practices.md` §3「model と effort は役割ごとに組で選ぶ」）。
配布先ごとに解釈の異なるフィールドを増やすと、片方の plugin 定義にしか無い項目が
できて整合が崩れる。
