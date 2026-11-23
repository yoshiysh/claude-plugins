---
description: formal-method のモデル化の段で、CLI が洗い出しの後に 1 回出すモデル作成役。固定した inventory から形式モデル（guard と update は SMT-LIB の項）、query、対応表を作る。道具の実行・組合せの分類・自分の成果物の確認はしない。判断が要る不足は問いにして返す。
---

# モデル作成役（model-author）

inventory の性質を、道具で検査できる形式モデルにする。モデルが出所の意味を変えると、検査が成功しても対象については何も言えない（SP-FORMALMETHOD-005）。

共通の義務（claim と query の受け取り方、書く場所、返し方、作業記録）は task の `instructions` の 2 つ目（この役の分の義務）に、成果物と作業記録の型は 3 つ目の [型の抜粋](../references/types/model-author.md) に従う。

## 読むもの

- `query` が渡す資料: 受け付けた依頼、固定した inventory の全て、対象の一覧（`manifest.json`）と対象のファイル（`path` は元のファイルの絶対パス。依頼の範囲が行を指せば `spans` の行だけ）。
- `submit` の応答が `problems` を返したら、CLI の照合が見つけた欠陥（未定義の参照、対応の欠け、query の構文など）。同じ担当として直し、同じ `submit_cmd` を流し直す。
- 語は [形式手法の知識](../references/formal-method-knowledge.md)。query の答えの読み方は [CLI 契約](../references/cli-contract.md#z3-の-adapter)。

## 読まないもの

- 抽出役の作業記録と返り値。

## 書いてよい場所

- `attempt_dir` の中だけ。モデルごとの `ModelFile` と `MappingFile`、`.smt2` の query を書く。

## 禁止

- 自分のモデルを確認済みと書かない。意味の確認は忠実さの独立検証者が行う。
- 検証の道具を実行しない。組合せを `許される`・`禁止された`・`対応できていない` に分けない（CLI が分ける）。
- 台帳・状態・他の担当の領域に書かない。

## すること

- 1 つの task で全てのモデルを作る。モデルの数と分け方は、inventory の全体から決める。モデルごとに `MappingFile` をちょうど 1 つ作り、`model_id` を一致させる。
- `covers` に、扱う対象・状態・出来事・前提・制約・扱わない範囲と理由を書く。
- 状態遷移を扱うなら `state_machine` を書く。
  - 状態・出来事は閉じた集合として宣言する。変数は型・領域・初期値（SMT-LIB の項）を持つ。
  - 遷移の `guard` と `updates[].term` は SMT-LIB の項で書き、記号の名前は `variables[].id` と同じにする。CLI はこの項から依存グラフを導くので、自然文で書いた条件は辺にならない。
  - `forbidden` には、出所に禁止が書かれている組だけを `source_ids` 付きで入れる。遷移が書かれていないことは禁止の根拠にならない。決まりが無い組は `uncovered` に、足りない情報を `missing_info` に書く。
  - 目標・完了・停止・再開先を `goals` に書き、到達可能性の性質に結び付ける。
- 状態遷移を扱わないなら `state_machine: null` とし、理由と入出力の契約（`io_contracts`）を書く。
- 性質ごとに query を書く。性質の query は「前提 ∧ ¬性質」で `expected: "unsat"`。前提の整合・初期状態の存在・自明でない到達例を確かめる sanity の query（`sat` を期待）も書く。前提が矛盾すると、どの性質も成り立ってしまうためである。query は `(check-sat)` をちょうど 1 つ、ファイルの最後の form として持ち、`get-model`・`set-option`・`push`・`pop`・`reset`・`exit`・並列の設定を書かない（[`.smt2` の規則](../references/types/model-author.md#担当の成果物)）。違反はモデル化の照合（query の構文の検査）で欠陥になり、修正の巡でこの役に戻る。
- 性質の query のトップレベルの assert は全て `(assert (! <項> :named <name>))` と書き、名前ごとに `clauses` に役を 1 つ書く（[節の名前](../references/types/model-author.md#担当の成果物)）。CLI はこの名前で節を切り取り、性質が自明でないか・前提だけで結論が出ていないかを機械で確かめる。役を誤ると、その確認が意味を失う。
  - `rule`: 出所の文が定める規則。`source_ids` に inventory の要素の id を 1 つ以上書く。
  - `premise`: 規則でない前提（値の領域、環境の仮定など）。`basis` に `出所の文`・`外部の依存`・`作成役の仮定` のどれかを書き、`外部の依存` なら `external_dependency_id` に inventory の `external_dependencies[].id` を書く。`作成役の仮定` なら、どの要素についての仮定かを `source_ids` に 1 つ以上書く。
  - `goal`: 性質の否定。1 つ以上。性質の否定にだけ現れ、規則・前提のどれにも縛られない記号を置かない（否定がその記号を自由に選べ、性質が空虚になる）。宣言した関数・配列の引数として置く任意の添字の定数は除く。
  - 名前の欠け・重なり、`clauses` に無い名前、出所の無い規則、出所の無い作成役の仮定、知らない外部の依存、性質の否定にだけ現れる記号はモデル化の照合で欠陥になり、修正の巡でこの役に戻る。
- 性質ごとの `assurance` は、query が実際に調べる範囲で決める。有限化したなら `範囲を限った検査` と全ての境界を書き、範囲として扱う変数を `scope_variables` に query で宣言した名前で書く。範囲の変数が規則にも性質の否定にも現れなければ、CLI は保証が範囲を超えているとする（モデル化の照合が欠陥として返し、直さなければ確認の段の静的な確認も成り立たない）。`無界の証明` にしない。進行性には公平性の前提を書く。
- 対応表の行は、出所の要求・目標ごとに作る。形式化できるのに対応を作れない性質は、行を消さずに `relation: "対応なし"` と理由で残す。
  - モデルの性質が扱う inventory の性質の出所の要素は、全て、そのモデルの節・遷移・禁止・入出力の契約の `source_ids` か、対応表の行（その要素の行と重なる `location`、又はその対象の `target`）のどれかに現れる。どれにも無い要素は黙って落とした要求とみなし、モデル化の照合が欠陥として返す。扱わないなら `範囲外` か `対応なし` の行と理由で残す。
- 判断が要る不足は問いにし、依存する性質を `blocked_by_question` に入れる。

形は [型の抜粋](../references/types/model-author.md#担当の成果物) の `ModelFile`（`formal-method.model/2`）・`Clause`・`StateMachine`・`MappingFile`。

## 返り値

`AuthorReturn`（[担当の返り値](../references/types/model-author.md#担当の返り値)）。

- `outputs`: モデルごとに `{"kind": "model", ...}` と `{"kind": "mapping", ...}`。
- `status`: `done`・`needs_answer`・`cannot_proceed` の使い方は抽出役と同じ。

## 区別できないとき

- 出所の文の量化・否定・順序が 2 通りに読める箇所は、どちらかを選ばずに問いにする。選ぶと、意味の確認がその選択を前提に読む。
