# formal-method 要求の検証

対象は `docs/requirements/formal-method.md` の一部と、合成データ専用の保存プロトタイプである。要求全体、利用者の意図、予定するスキル実装の正しさを保証するものではない。

## 正本と責務

| 正本 | 検査する責務 | 限界 |
|---|---|---|
| `operational.smt2`、`operational_checks.rs` | 回答待ち、停止報告、報告後の結果到着と保存、照合、再利用、成功時だけの完了。10遷移の証人と変異 | 一つの判断事項と一度の再開、run 内一定の版、抽象保存 |
| `boundary_composition.rs`、`boundary-contracts.smt2` | 上記モデルの採用した境界、関係契約、帰納的不変条件、全体安全性 | この抽象モデルの証明。具体実装の refinement、活性、競合は未検証 |
| `identity.smt2` | 再利用の12次元の一致・欠落・不正、性能比較の条件 | 有限の識別値。実ハッシュ・時計・取得処理を検証しない |
| `mapping.smt2` | 2要求と2性質の対応、未対応・保証範囲・比較条件 | 実文書の意味や対応抽出を証明しない |
| `job-ledger.smt2` | 2 job の出所・値、run/版不一致・重複・宛先違いの受理拒否。同値の結果でも出所交換を検出 | 信頼された入力フィールドによる判定であり、送信元認証を証明しない |
| `reporting.smt2` | 2 job の集約、独立レビュー、台帳の鮮度、停止時の報告フィールド | 集約・表示専用fixture。input/env/resumeイベントは禁止して実行し、run制御の別正本として使わない |
| `storage.smt2`、`storage_checks.rs` | 保存プロトコルの抽象不変条件と変異 | Rust命令との自動refinement証明ではない |
| `durable_storage.rs`、`durable_storage_tests.rs` | 実ファイル保存・再読込・故障・別プロセス終了後の回復 | 単一writer、合成データ。電源断や媒体の永続性は未検証 |

境界の証明は [分割と合成](boundary-composition.md)、実保存は [保存プロトタイプの検証範囲](storage-evidence.md) を参照する。旧模型からの移行と、引き継いだ保証・未検証は [正本への置換](canonical-models.md) に示す。

## 実行

リポジトリのルートで、実際の `rustc` と Z3 を指定して実行する。標準の実行環境に無い場合は絶対パスを使う。

```bash
rustc --edition 2021 --test tests/formal/formal-method/check.rs -o /tmp/formal-method-unit
/tmp/formal-method-unit
rustc --edition 2021 tests/formal/formal-method/check.rs -o /tmp/formal-method-check
FORMAL_RUN_DIR=/absolute/path/to/evidence Z3=/absolute/path/to/z3 /tmp/formal-method-check
rustc --edition 2021 --test tests/formal/formal-method/durable_storage_tests.rs -o /tmp/formal-durable-storage-tests
/tmp/formal-durable-storage-tests --test-threads=1
RUSTC=/absolute/path/to/rustc Z3=/absolute/path/to/z3 tests/formal/formal-method/check-regressions.sh
```

現在の対象範囲で全queryが期待する SAT/UNSAT に一致し、入力とsolverの指紋が実行後も一致すれば全体入口はexit 0になる。未知・時間切れ・異常終了・不足した出力・指紋不一致は成功にしない。廃止したclosure契約の未分類を、現在のrunのエラーとして残さない。

`check.rs` はsolverごとに10秒の内部timeout、14秒の外側期限と最大1秒の後処理を使う。Unixで同じプロセスグループの子孫を停止し、開いたままのpipe・書けなかった入力・大き過ぎる出力を成功にしない。別グループへ移動する子孫やWindowsは対象外である。回帰試験は現在の全14ソースのコンパイル後変更、PRD変更、unknown、solver/版変更、型を保った偽の証人を拒否する。

`FORMAL_RUN_DIR` は生成query、依存グラフ・候補・境界の対応、操作モデルのSAT証人を保存する。操作モデルの証人はFORMAL_RUN_DIRを指定した実行でのみ値を元queryへ拘束して再照合する。共通run_case自体は証人replayを行わない。境界のSAT存在チェック・identity/mapping/reporting等はquery又は可否の検査であり、全てに具体証人の保存・replayがあるわけではない。

## 判定と証拠の範囲

PRDと模型の指紋が一致することは、要求の意味が模型に忠実なことの証明ではない。PRDのpinは今回の基準を特定し、模型・性質・対応を確認した上でのみ更新する。新しいPRDへ以前の結果を流用しない。独立した意味のレビュー、形式モデルの前提と実環境の一致、必要な全要求の網羅は別に確認する。

抽出する依存グラフは操作モデルの宣言・定義・assertionの構文上の参照に限る。未解決参照・未対応の束縛構文は拒否する。任意のSMT構文、外部定義、意味上の読み書き依存は扱わない。SCC候補を独立した実装単位と確定せず、採用した意味上の境界の証明と区別する。

現在の要求IDとの対応は [旧IDからの対応表](requirements-map.json)、検証結果と限界は [検証基準](verification.md) を参照する。対応表の出所は旧PRDの指紋で特定する。過去の試走と失敗結果はローカルの作業記録として保持し、本変更には含めない。現在の入口が成功しても、過去の未完了runを成功へ書き換えない。
