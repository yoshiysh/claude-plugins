# 仕様と実行テストの対応を検証する

Node.js 22 以降で実行する。規約は [テスト指針](../../docs/guidelines/testing.md) を参照する。この文書は設定と実行方法を扱う。

```bash
node scripts/traceability/cli.mjs --config traceability.config.json --output .artifacts/verification
node scripts/traceability/cli.mjs --config traceability.config.json --output .artifacts/verification --complete
node scripts/traceability/cli.mjs --config traceability.config.json --output .artifacts/verification -- tests/bp-author-cli.test.mjs
```

`--` 以降は実行するテストファイルの置き換えで、カレントディレクトリから解決する。仕様とソースの対象は設定のまま保持するため、部分実行で他の完了仕様を実行しなければ終了コード `1` になり得る。`--complete` は対象全仕様の完了と、成功した leaf test、採用済みの全シナリオを要求する。通常実行では仕様先行の追加や作成中の行を認めるが、「完了」の検証行には成功した対応テストが必要になる。ID の対応だけでは、その検証行の内容を assert しているかまでは判定できず、結果の `semanticMatch` はレビュー待ちになる。

## 設定

JSON 設定は次のフィールドを使う。パスは、設定ファイルから解決した `root` の内側に置く。グロブは使わない。

| フィールド | 意味 |
|---|---|
| `root` | 設定ファイルを基準にしたリポジトリのパス。省略時は設定ファイルのディレクトリ |
| `scopePrefixes` | 検証する仕様 ID の接頭辞 |
| `specFiles`, `testFiles`, `sourceFiles` | root からの相対パスによる明示対象 |
| `specDirectories`, `testDirectories`, `sourceDirectories` | 再帰探索する対象。文字列のパス、または `{ "path": "...", "prefix": "ファイル名の接頭辞" }` |
| `scenarios` | 仕様 ID ごとのシナリオ計画。下記形式 |
| `unmeasuredSources` | 対象ソースの相対パスと、未計測とする具体的な理由の対応 |

探索と明示対象は結合する。仕様は Markdown、テストは `.test.js` / `.test.mjs`、ソースは `.js` / `.mjs` を収集する。ソースからテストファイルを除き、全探索で `node_modules`、`.git`、fixture とテスト用のディレクトリを除く。除外名の正本は `specs.mjs` の `discover` にある。探索中の symlink は拒否する。各対象種別に一つ以上のファイルが必要で、対象仕様がゼロの場合も成功にはならない。実際の探索起点とファイル一覧は出力の `inventory` に残る。

仕様は、見出しの先頭にある `SP-...` を定義として読み込む。検証表は第1列の要求 ID に `PR-` を含み、第2列に仕様 ID、第3列に検証内容、最終列に進捗状態を持つ Markdown 表から読み込む。状態は既存文書の「未着手」「作成中」「完了」を使う。全ファイルの定義を先に集めるので、他ファイルの仕様への参照も解決できる。重複定義と対象内の未知 ID は設定エラーになる。

シナリオ計画の一例:

```json
{
  "scenarios": {
    "SP-EXAMPLE-001": {
      "normal": [{ "id": "accepted", "expectation": "有効な入力を受理する" }],
      "recovery": { "notApplicable": "状態を保存せず回復操作を持たない" },
      "error": [{ "id": "invalid", "expectation": "無効な入力を拒否する" }],
      "boundary": [{ "id": "empty", "expectation": "空入力を拒否する" }]
    }
  }
}
```

採用した仕様では上記の全分類にケース一覧または理由つきの `notApplicable` を置く。未採用仕様は `unplanned` として残り、通常実行のエラーにはならない。計画のない仕様に注釈を付けた場合は未知シナリオとして失敗する。分類は互いに排他的ではなく、一つのテストに複数注釈を付けられる。

```js
test('SP-EXAMPLE-001', async t => {
  await t.test('@error:invalid @boundary:empty', () => {
    assert.throws(() => parse(''), /empty/);
  });
});
```

子テストは親の仕様 ID と注釈を継承する。子に仕様 ID または注釈がある場合、それぞれの継承値を置き換える。成功件数は leaf だけを数える。親を含む全宣言の未知 ID・分類・ケースも検査するので、子で置き換えても親の誤記は隠れない。複数の対象 ID を持つテストでは、その注釈が全対象 ID に適用される。別の接頭辞の ID は検証外として件数と ID 一覧を開示する。skip / todo / cancelled は成功扱いにせず、未知参照の検査対象に含める。

## 出力と失敗時の扱い

同じ実行から `traceability.json`、`coverage.json`、`report.md` を生成する。JSON は共通の `runId` を持ち、Markdown には同じ値と分類別の進捗を載せる。仕様の `complete` は、対象が非空、参照エラーなし、テスト実行成功、全仕様でシナリオ計画が採用され、全仕様とその計画が完了したときだけ真になる。

| 終了コード | 意味 |
|---|---|
| `0` | 検証成功。仕様作成中や未計画、カバレッジの部分計測は残り得る |
| `1` | テスト失敗・取消・未完了、対応の不整合、完了ゲート未達 |
| `2` | 設定・対象読取・runner・出力処理の異常 |

実行開始時に前回のレポートを消すため、設定や runner が異常終了しても古い成功結果を今回の結果として残さない。同一出力先は `.traceability.lock` で排他し、競合した実行は前回の出力を変更せず終了する。強制終了でロックが残った場合は、記録された PID の実行が終了したことを確認してロックを削除し、同じコマンドを再実行する。正常終了・通常の異常終了ではロックを解放する。

コードカバレッジは仕様・シナリオの充足度とは別の指標である。実行した行・分岐・関数を集計するが assertion の妥当性は証明しない。未ロードの対象も一覧に残す。Node 22 では未ロードソースをゼロとして取り込む include-all が利用できない場合があるため、`unloaded` として部分計測を開示する。対応する Node では include-all を使い、計測できたゼロ実行のソースを `zero-covered` とする。

変換して実行する Workflow ソース二つは現在の設定で理由つきの `unmeasured` として明示し、計測率の分母から除く。対象ファイルと理由の正本は `traceability.config.json` の `unmeasuredSources` にある。未計測や未ロードのソースがあれば全体は `partial` となり、任意のカバレッジ閾値で合否を補わない。
