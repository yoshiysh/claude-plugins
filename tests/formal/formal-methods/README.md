# formal-methods 仕様の形式モデル

この形式モデルは `specifications/formal-methods` の状態遷移を写した TLA+ 状態機械モデルである。

## 状態遷移

```mermaid
stateDiagram-v2
    [*] --> 実行中
    実行中 --> 完了 : E2 完了の条件を満たして止まる (SP-FORMALMETHODS-262)
    実行中 --> 欠け停止 : E3 対象の欠けで止まる (SP-FORMALMETHODS-262)
    実行中 --> 失敗停止 : E4 失敗で止まる (SP-FORMALMETHODS-262)
    実行中 --> 反復上限停止 : E5 反復の上限で止まる (SP-FORMALMETHODS-262)
    反復上限停止 --> 実行中 : E7 同じ起動の同一性で起動する (SP-FORMALMETHODS-105)
    失敗停止 --> 実行中 : E7 同じ起動の同一性で起動する (SP-FORMALMETHODS-105)
    欠け停止 --> 欠け停止 : E7 同じ起動の同一性で起動する (SP-FORMALMETHODS-098)
    完了 --> 完了 : E7 同じ起動の同一性で起動する (SP-FORMALMETHODS-097)
    欠け停止 --> [*]
    完了 --> [*]
```

## 検証する性質

| 性質 | 内容 |
|---|---|
| `TypeOK` | 状態変数が仕様書で定義された状態集合に含まれる |
| `DeadlockFree` | 終端状態以外の状態において、ステップ上限に達するまで次の遷移が存在する |
| `ValidTerminal` | 終端状態に到達した実行パスの妥当性 |

## 実行

```bash
node --test check.test.mjs
```

または TLC によるモデル検査:

```bash
java -cp /path/to/tla2tools.jar tlc2.TLC FormalMethods.tla -config FormalMethods.cfg
```
