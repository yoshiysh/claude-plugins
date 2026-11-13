# BP要求の途中検証snapshot

状態: **未完了**。現行要求2本の56要求（D29/O27）を検証する途中成果を保存する。要求原文・設計原文・仕様・CLI・testsは変更していない。56要求の形式検証完了は0件、最初の停止・再開group（33S）も未完了で、仕様6本の検証は未着手である。

## 現在の入口と版

このREADMEがsnapshot時点の入口である。[validation.md](validation.md)、ローカル保存の`contract-receipt.md`、`continuation-status.json`は各作業段階の状態・試行履歴を保存しているため、当時の「未レビュー」「待機」を含む。後日の結果で古いrunを成功化しない。

- 原文版と56件の索引: [coverage.json](coverage.json)、[source-table.md](source-table.md)。baseは`c67bd7cdac257f3193341ed7f37260c011205204`。要求DのSHA-256は`e7fd43456763d8327ce8a008fd68e0a9511f3149ebfecf987f0e687f72ecbe0c`、Oは`ce0b67b9c97c839d1eae2f809aaf726e77f8c4303f9353c256c5073fcfecb0c0`。
- 原文全文の独立意味レビューで確認済み矛盾・不足は0（通知の保存先は[validation.mdの初回結果](validation.md)、[execution-receipt.json](execution-receipt.json)）。この記録はsource整合の確認範囲を表し、56要求の形式合格を表さない。
- 現行の小契約計画: [contract-plan.md](contract-plan.md)。対象スキルrunとBP操作run、通常不合格と形式失敗、停止処理と実処理続行、報告と保存を区別する。`Realizable(c)`と同じcontextに義務を加えた`Compliant(c)`を別queryにし、source義務を一つ落とす変異と比較する。

| 入力 | SHA-256 | 保存観測 | 独立確認の状態 |
|---|---|---|---|
| [run32/input.smt2](contract-run-20261113-32/input.smt2) | `a61cbfa45c426ba12aa6ddaf1e5e307bc3e967963e93624a7b2ad6668feea436` | 166局所query、SAT105/UNSAT61、期待不一致0、exit0 | [独立レビュー](reviews/contract-run-20261113-32-c-review.md)が固定入力を一度再生しraw一致を確認。run29のC層4欠けは選定有限関係に限り修復確認。全域の意味合格は未達。 |
| `run33/input.smt2`（local-only） | `108ba32aaf5febfabea304a71e3dfff6a21445987fd97a32e9de6e331332f36a` | 174局所query、SAT106/UNSAT68、期待不一致0、exit0 | 後続作業版。対応する独立意味レビューは未保存。 |
| `run34/input.smt2`（local-only） | `2e7be301e49eff8dfc715935dce82e7d6a1e9d68b9443eae71721648bf6dcd9d` | 179局所query、SAT109/UNSAT70、期待不一致0、exit0 | 後続作業版。対応する独立意味レビューは未保存。 |
| [current contract-model.smt2](contract-model.smt2) | `632a1d637c3f828586fbc397afde876ec3efae80fee9fa1d88dcc26a80da1a7d` | 183個のcheck-sat式を含む作業中source。上記runのいずれとも異なる | このhashに対応する保存済み実行結果・独立意味レビューは本snapshotに無い。run32/33/34の結果を転用しない。 |

梱包時に取得した`origin/main`は`75d5565f1421b36c81aab66ed19bf2ccf167a777`で、証拠固定baseとは異なる。検証対象は旧固定版であり、現mainへの再適用は未確認である。rebaseや原文の差替えで証拠を最新扱いしていない。

query数は要求の達成数ではない。run32の166件は全33Sの正常・禁止・例外を尽くさず、33signature表との名前結合も意味被覆を証明しない。後続版のquery追加だけでrun32レビューの範囲は広がらない。

## 確認したことと未達

run32では、非形式書直しのChoiceをfieldに限定する、hint拒否の原因未定をUに残す、reviewのneeds_inputと保存失敗でO052/O013/O051の義務を同一op/run/停止episodeに合成する、有限4phase×2順位のentryと域外・未到達・非適用を分離する修復を独立確認した。詳しい根拠・行範囲・限定は上記reviewを正とする。

S32には利用者裁定「過去の受理履歴は保持し、影響する結果の再利用を止めて再検証する」を追加入力として使う。履歴、現在のvalid/eligibility、今回useする選択を分ける。再検証後にeligibleでも利用義務は無く、無関係結果の不使用も許される。この裁定を既存原文の規範へ混入しない。

次の完了条件は未達のまま残る。

1. 型付き候補K全域の生成と重複・欠落、全33signatureのA/F/Choice/U、各Uの到達SAT/UNSAT/unknown・未処理、同時contextのprojection間join。source guardや正規Nextで候補を先に間引かず、Fを単純なnot Aで作らない。
2. 全33Sの正常・禁止・例外について同一対象、run、episode、delivery、event順、拒否frameの原文対応。有限sampleで任意N・任意段・無界runを保証しない。
3. [contract-source-inventory.tsv](contract-source-inventory.tsv)の132文+103規範offsetから全source短句spanを確定し、covered/residual/Uを独立意味確認する。235は重なる索引unit数で、被覆句数ではない。group2=59/group3=25/group4=55/U=96は予定割当て。covered確定済spanは無い。[contract-span-candidates.json](contract-span-candidates.json)の40件も未レビュー候補である。
4. [remaining groups 2–4](reviews/remaining-requirement-groups.md): 設計選択・入口・役・host、状態・資産・証拠・記録、機能・検証・指摘の受渡し。第一group外の句は未検証。
5. 56要求の検証完了後に仕様6本へ進む。現時点では仕様・CLI実装の正しさを判定しない。

実host/CLIの権限強制、物理保存、LLM文章や独立検証の実品質はこの有限整合モデルの保証外である。モデル外を理由に関連要求を完了扱いにはしない。

## 試行履歴の扱い

- 旧静的SMT: ローカル保存の`checks.smt2`の初稿83queryは80期待一致、3件はqueryの同一項目・episode結合不足と独立確認され、明示承認された限定修復で3件ともUNSAT。C/S32追加や診断の履歴を含め、旧結果を新モデルへ合算しない。
- 50action/24stepのRustモデル: ローカル保存の`model.rs`、`classification.rs`。正常43SAT等の限定観測があったが、禁止・変異にはunknownが残り、C全域とsource対応も未完。出来事の同一性・順序の欠陥、巨大展開・探索負荷が残ったため、実装内部pipeline再現からsource cutpointの小契約へ戻した。旧24step保証の未達は維持する。
- 小契約run01–34はローカル保存し、このPRではrun32だけを含める。run01は実行時inputを凍結しておらず単独で正確に再生できない。run17/27はparser error/exit1を保持し、後続修復を遡及しない。run18–28の旧C分類の層混同、run29の4欠けも各reviewの失敗履歴として残す。

## Gitへ保存する範囲

[package-manifest.json](package-manifest.json)が明示include集合、サイズ、SHA-256、除外理由を持つ。Gitへ含むのは再開に必要なcurrent小契約source、source索引/期待/残余計画、run32の固定input/期待・実測/raw/hash/time、最新独立reviewと入口だけに絞る。元ファイルの移動・削除はしていない。

約1.3GBの`runs/`全体、旧静的SMT/Rust著作源・smoke・全履歴run、run33/34はローカル保存のまま除外する。本文中の旧ファイルや`runs/...`、run33/34への参照はlocal-onlyの歴史参照で、clone内での実在を保証しない。snapshot以前からtrackedの`workflow-runs/bp-contract-scope/`は別の旧成果で、現在の原文版へ流用しない。

cloneから正確に再生できるsolver入力はこのPRではrun32に限る。current作業版は含むが保存結果は付かない。除外した過去各版・臨時harness・solverモデル・Rust入力の生成/再生はcloneだけではできず、ローカル保管物が必要である。既存文書の履歴参照やhashは対象本体の配布を意味しない。

## 再開・再生

まずrun32固定inputと独立review、current sourceのhash差分、全source span候補と残余計画を読む。作業中sourceを次の固定版として独立確認するか、未達条件の設計へ戻るかを判断し、既存run IDを再利用しない。今回の梱包では形式検証を再開していない。

以下はrepository rootで実行する**再生例**であり、今回実行済みという意味ではない。Z3 5.3.3が保存環境の版で、異なる版ではstdoutまでの一致を別途確認する。`contract-run.sh`のcached絶対pathとmacOSの`time -l`は実行履歴として保持する。同scriptはcurrentを新runへコピーするもので、run32を再生する手順ではない。

```sh
export Z3_TOOL=/absolute/path/to/z3
scope=workflow-runs/bp-requirements-validation
replay_dir=$(mktemp -d)
"$Z3_TOOL" -version
"$Z3_TOOL" -T:120 "$scope/contract-run-20261113-32/input.smt2" > "$replay_dir/z3.stdout" 2> "$replay_dir/z3.stderr"
diff -u "$scope/contract-run-20261113-32/z3.stdout" "$replay_dir/z3.stdout"
```

183queryのcurrentは未レビュー作業版のため、上の入力へ置換してもrun32の合格再生にはならない。新しいhashの結果として別に扱う。

今回の配達確認は保存hash、raw/期待・実測対応、参照実在、secret pattern、大きいfile、include listの整合に限定した。`make check`や全面solver再実行を実施したとは報告しない。
