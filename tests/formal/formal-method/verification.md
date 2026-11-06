# 検証基準とレビュー用の証拠

対象PRDのSHA-256は `8c455b3dd4303aacdad2eeaf241caaeb3aa9e5594dc3eb3abe9e69d0f3b8c08e`。能力ごとの15要求へ整理した版である。旧58要求との対応は [requirements-map.json](requirements-map.json) に保存し、旧版・新版の指紋と各受入条件の位置を記録する。対応表は要求の意味を読む独立レビューを経た移行記録であり、形式検証による全要求の証明ではない。

`PRD.sha256` はこの版に対する**部分的な模型検査**の基準を特定する。以前のPRDの検証成功をそのまま新しい版の結果と扱わず、現行版で実行し直した。実行入口の見出し照合は、使う性質に対応する12要求の存在を確認するものであり、15要求全ての実装や保証を確認するものではない。

## 実行した検査

2026-11-06、macOS arm64、rustc 1.99.1、Z3 5.3.3で実行した。

| 検査 | 結果 | 意味 |
|---|---|---|
| 現行模型の全体入口 | exit 0、267件の期待するSAT/UNSATに不一致なし | identity・mapping・job-ledger・reporting・operational・境界合成・保存プロトコルの限定した性質 |
| Rust unit | 9 passed、0 failed | 出力分類、入力不完了、timeout、pipeを保持する子孫、stderr、batch出力等の実行面 |
| 実ファイル保存試験 | 11 passed、0 failed | 合成データでの保存、破損拒否、故障、別プロセス終了後の回復 |
| 回帰試験 | exit 0 | 14ソースとPRDの変更、正しい出力件数のunknown、solver/版変更、偽証人のreplay拒否 |
| リポジトリのmake check | exit 0 | make testとportability。traceabilityのerrors/failures/unverifiedは0、complete=false・coverage=partial |

make checkのNode実行にはskip 2件の診断があり、リポジトリ全体の完了や完全なcoverageを確認したものではない。portabilityには非ゲートのBLOCKER表示が残る。これらを本変更で修正したとは報告しない。

再現コマンドは [README](README.md) に示す。全体入口は各入力とsolverの指紋を出力し、実行後の一致を確認する。`FORMAL_RUN_DIR` を指定した今回の操作モデルのSAT証人は元queryへ拘束して再照合した。境界の存在検査など全てのSATに具体証人の保存・replayがあるわけではない。

生成query・詳細ログ・旧模型の履歴はローカル作業記録に保持する。本変更は現行ソース、対応表とこの小さな再現用記録を含み、大量の生成ログを含めない。現在の結果で過去の未完了runを書き換えていない。

## 確認できた範囲

- 現行モデルのrun制御、回答待ち、停止報告後の結果保存、照合後の再利用と成功時の完了。
- 参照グラフと候補の導出、採用した意味上の境界の関係契約と帰納的な安全性。説明は [分割と合成](boundary-composition.md)。
- 2jobの信頼された出所・run・版の判定、同値結果での出所交換検出、集約・レビュー・台帳・報告の専用fixture。
- 単一writerの保存プロトコルと実ファイル試験。説明は [保存の検証範囲](storage-evidence.md)。

## 未検証

[正本への置換](canonical-models.md) の移行差分を含め、PRD全要求の意味・網羅、予定するスキル実装とのrefinement、実際の送信元認証、run中に版が変わる場合、任意個数job・複数質問・任意回数の再開、一般の合成戦略、無限実行の活性は未検証である。形式化できない性質の確認や手法選択・性能改善など、PRDが要求する全能力を実装したものではない。

保存試験のプロセス終了は実際の電源断ではない。媒体・コントローラの永続性、実sync EIO、競合writer、認証された削除、NFS/Windows等は未検証である。実試験成功をハードウェアの耐久性や永久保持の証明と扱わない。
