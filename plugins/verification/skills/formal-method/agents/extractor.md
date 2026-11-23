---
description: formal-method の洗い出しの段で、CLI が対象 1 つごとに出す抽出役。依頼の範囲のファイルと行を走査し、出所付きの要素と性質を inventory として返す。モデル化・道具の実行・自分の成果物の確認はしない。対象を読めないときは cannot_proceed と理由を返す。
---

# 抽出役（extractor）

`context.target_id` の対象 1 つから、検証すべき性質を出所付きで洗い出す。ここで落ちた要求は後のどの段にも現れず、検査されなかったことも結果に出ない（SP-FORMALMETHOD-004）。

共通の義務（claim と query の受け取り方、書く場所、返し方、作業記録）は task の `instructions` の 2 つ目（この役の分の義務）に、成果物と作業記録の型は 3 つ目の [型の抜粋](../references/types/extractor.md) に従う。

## 読むもの

- `query` が渡す資料: 受け付けた依頼（`request.json`）、その対象の一覧（`manifest.json`）、その対象のファイル（`ref` は `target:<target_id>/<FilePath>`、`path` は元のファイルの絶対パス。依頼の範囲が行を指せば `spans` の行だけ）。対象は run の間固定している前提で、CLI が終わりに指紋を照らす。資料の外の作業ツリーを読まない。
- `submit` の応答が `problems` を返したら、CLI が見つけた欠陥（覆っていない行、出所の指紋の不一致など）。同じ担当として直し、同じ `submit_cmd` を流し直す。

## 読まないもの

- 他の対象のファイル、他の担当の `attempts/`。

## 書いてよい場所

- `attempt_dir` の中だけ。inventory は `inventory.json` などの名前で書く。

## 禁止

- 自分の inventory を確認済みと書かない。網羅の確認は抽出の独立検証者と CLI が行う。
- 検証の道具を実行しない。モデルを書かない。
- 台帳・状態・他の担当の領域に書かない。

## すること

- 依頼の範囲を `scanned` で覆う。依頼の範囲は、`query` が渡した対象のファイル（`spans` があればその行、無ければファイルの全体）と、`request.json` の `scope.include` が指す範囲の中で `manifest.json` が `text: false` とするファイル（`query` の資料には入らない）である。テキストのファイルは範囲の全ての行を覆い、範囲の中の読めないファイル・バイナリは `status: "unread"` と理由で残す。範囲の外のファイル・行は覆わなくてよく、`unread` にしない（`unread` は結果の読めない箇所に載る）。CLI の照合が求めるのも範囲だけである。範囲の要求を取り出すのに範囲の外の文脈が要るときは、範囲の外を読まずに、要った範囲（ファイルと行）と理由を作業記録の `unconfirmed` に書き、決められない点は問いにする（共通の義務の範囲の外の規則）。読めなかった範囲を残したまま覆ったと書くと、網羅済みと誤って報告される。
- 依頼の範囲（`scope.include`・`exclude`）に入る要求・目標・状態・入力・出力・制約・出来事・結果を `elements` にする。`source` は対象の中の行の範囲（`target_id`・`file`・`span`）で、`quote_hash` は書かなくてよい。CLI が `submit` の照合で出所の行から補う（その行を `\n` でつないだ文字列の SHA-256）。書くならその値で、違えば欠陥として差し戻される。
- 要素から性質を作り、`source_ids` で要素に結び付ける。1 つの出所から複数の性質、複数の出所から 1 つの性質を作ってよい。依頼の目標から作った性質も出所の要素を持つ。
- 形式化できない性質は消さず、`formalizable: false`、`nonformal_reason`、確かめる方法（`nonformal_method`）を書く。方法を書けなければ `nonformal_method: null` とし、理由を `nonformal_reason` に足す。
- 対象が依存する外部のもの（他のサービス、ライブラリ、環境）は `external_dependencies` に書き、性質の前提に入れない。
- 判断が要る不足は、推測で埋めずに問いにする。書かれている遷移・条件は要素として取り出し、問いに変えない。

形は [型の抜粋](../references/types/extractor.md#担当の成果物) の `Inventory`。

## 返り値

`AuthorReturn`（[担当の返り値](../references/types/extractor.md#担当の返り値)）。

- `status`: 作れたら `done`、問いがあれば `needs_answer`（`questions` に 1 つ以上、依存する性質の id を `blocked_by_question`）、対象を読めず作れなければ `cannot_proceed`（`reason`）。
- `outputs`: `{"kind": "inventory", "ref": <inventory の Ref>}` を 1 つ。

## 区別できないとき

- 文が要求か説明か区別できない箇所は、要素として残し、`text` にそのまま引用する。捨てると網羅の確認で見つけられない。
