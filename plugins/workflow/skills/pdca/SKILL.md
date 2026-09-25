---
name: pdca
description: >
  作る/やる工程と測る工程の両方を持つ依頼（実験に限らず施策・文書・運用改善も）を、
  Plan→Do→Check→Act の 1 ループとして回すスキル。
  作業の前に完了条件（検証観点・測定手段・予算）を別 agent の反証を経て固定し、writer が作り、
  観点ごとに別の verifier が検証し、completion-judge と script の close で完了を決める。
  依頼が機序（なぜ効くか）を求めれば、それも完了条件になる。
  「PDCA を回して」「/pdca」「こういうのをやってみたい、作って測って改善したい」「この記事の手法が
  本当か自分の環境で再現して比べて」「レビューの往復が多いので減らしたい、施策を測れる形で立てて」
  「なぜダメだったのか機序まで出して次の一手を決めて」といった依頼で積極的に使うこと。
  対象外：調査・原因究明だけで改善ループを伴わない依頼（research:search）、反復のない 1 回限りの
  実行依頼、実装方針そのものの審議（magi）。
---

# Running PDCA Loops

## 目的

作る工程と測る工程を持つ作業を、完了条件を作業の前に固定し、作る役・測る役・完了を決める役を
別の agent に分けて回す。何を条件にするか（事実の確認・比較・機序・恒久化）は依頼から
criteria-author が決める。全 run に一律に課すと、依頼に無い約束が観点と予算を使う。

## 固定するもの

次の不変条件は、モデルや司令塔の判断に依らず `[SKILL_DIR]/scripts/pdca_state.py` が持つ。
規則の本体は script にあり、ここには写さない。拒否は exit 1 と stderr の `{"error": 理由}` で返る。

| 不変条件 | 守られないと何が壊れるか | 担当 |
|---|---|---|
| 依頼原文を書き直さずに全 agent へ届ける | 言い換えが入ると、検証者は依頼に対する欠落を検出できない | `init` `amend` `brief` |
| 生成者と検証者を別 agent にする | 生成者は自分の出力に通る判定を書ける | `record` `fix` |
| 完了条件と採点物（`means.ref` と `controls` の `ref` が指す元の場所）を、作業の前に digest で固定する | 作業の中で基準や採点物が作り替えられる | `fix` `record` |
| 宣言した検証を実施しなかったら `not_done` | 測れなかったことが合格に化ける | `status` `close` |
| 予算（周回数・経過時間）・非収束・自動継続で止める | 周回がいくらでも伸びる | `brief` `fix` `continue` `status` |
| 完了は、固定した完了条件と別の判定役で決める | text だけで終わるターンが完了扱いになる | `close` |
| 未充足の一覧を台帳から毎回導出する | 文脈が圧縮されるとタスク一覧が消える | `status` |
| 台帳は script だけが書き、読むたびに行の連鎖・brief との対応・fix と close の前提を検査する（検査の限界は「残るリスク」） | 手で書き換えた行や、brief を経ずに書き足した記録が、正規の記録として合否と完了の判定に使われる | 全サブコマンド |
| 対照入りの試走（smoke）を本番の検証の前に通す | 対照で期待どおりに出ない手段は、成果物を測れていない | `brief` `record` |
| agent の起動文は `brief` が返す `invoke` だけ（書き足した文は agent が `prompt_extra` に申告する） | 司令塔の文が混ざると、ループが検証するのは司令塔の仮説になる | `brief` `record` |

## 流れ

run-dir は対象の作業ツリーの外に置く。ユーザーの発言は、書き換えずにファイルへ写してから渡す。

```bash
S=[SKILL_DIR]/scripts/pdca_state.py
python3 $S init --run-dir <run-dir> --request-file <依頼原文> --material <資料のパス>   # 資料は複数可
python3 $S amend --run-dir <run-dir> --request-file <後から来た発言>
python3 $S brief --run-dir <run-dir> --role <役割> [--conditions <条件 ID>…] [--viewpoint <観点 ID>] [--aspect <scope か design>] [--report-file <最終報告案>]
python3 $S record --run-dir <run-dir> --file <agent の出力>
python3 $S fix --run-dir <run-dir>
python3 $S status --run-dir <run-dir>
python3 $S continue --run-dir <run-dir>
python3 $S close --run-dir <run-dir>
```

1. `init`（後から発言が来たら `amend`）。返った `recorded_request` を、最初の報告で「依頼として
   記録した原文」としてユーザーに示す。
2. criteria-author が完了条件文書を書く → criteria-verifier が scope と design を別 agent で反証する →
   両方 pass で `fix`。
3. writer が作る → verifier が観点ごとに 1 agent ずつ検証する（対照を持つ観点は先に smoke）。
4. 各 `record` と `status` が返す `next` に従う。`writer` なら次の周、`criteria-author` なら完了条件の
   直し、`stop:*` なら止めて報告する。
5. 全観点が pass になったら、最終報告案をファイルに書いて completion-judge に渡し、complete なら `close`。

各 agent は `brief` → `invoke` で起動 → `record` の順で回す。ターンを text だけで終えようとして
未充足が残っているときは `continue` を呼び、返った継続文に従う（完了を宣言しない）。

## 役割

| 役割 | 定義 | モデルの格 |
|---|---|---|
| criteria-author | [agents/criteria-author.md](agents/criteria-author.md) | 上位 |
| criteria-verifier | [agents/criteria-verifier.md](agents/criteria-verifier.md) | 上位 |
| writer | [agents/writer.md](agents/writer.md) | 司令塔が作業ごとに選ぶ |
| verifier | [agents/verifier.md](agents/verifier.md) | 中位 |
| completion-judge | [agents/completion-judge.md](agents/completion-judge.md) | 小（作業を回したモデルと別の小さいモデル） |

モデルの格はここだけに書く。Claude Code では Agent 呼び出しの `model` で指定する。fan-out を
既定のまま起動すると全員がセッションのモデルを継承し、観点の数だけ上位モデルを消費する。

## 司令塔が決めること・決めないこと

- **決める**（script は検査しない）:
  - writer の分け方と並列度: 条件が互いのファイルに触れないなら並列にし、同じファイルに触れるなら
    1 writer にまとめる（ぶつかると、どの変更がどの条件のためか追えない）。
  - 周回の形: 同じ原因を持つ指摘は 1 周でまとめて直す。他の条件が前提にする条件（現状を作る試作
    など）は、先に writer に渡す（前提が無いまま測ると not_done が並ぶ）。
  - writer のモデル、人間への提示。
- **決めない**: 完了条件、検証観点、測定手段、予算、合否。これらは criteria-author が書き、
  criteria-verifier が反証し、script が判定する。司令塔がこれらを決めると、検証観点が場当たりになり、
  何を見れば網羅かを誰も突き合わせられない。
- 司令塔は成果物を書かない。agent への入力に、依頼の言い換え・仮説・解決策・未検証の事実・範囲の
  限定を足さない（`brief` にそれを書く欄は無い）。

## 人間の境界

- `close` が返した `human_gates`（マージ・公開など）は、人間の承認を得てから行う。`next` は
  `await_human` になる。
- プロダクトの価値に関わる判断（問いを続ける価値、目標や許容リスクの変更、予算の増額）は、
  人間に返す。
- 方法論の行き詰まり（測定手段が成立しない等）は人間の境界ではない。検証者の指摘として、
  完了条件の直しに戻る。
- `stop:*` で止まったら、どの停止に当たったかと未充足の一覧（`unmet`。完了条件が未固定なら
  `criteria_open`）を人間に報告する。止まった run は `amend` しても再開しない。予算の増額が承認されたら、
  新しい run-dir で `init` し直し、前の run の request.md を `--request-file` に、criteria.json と
  ledger.jsonl を `--material` に渡す。

## 結果の提示

`status` と `close` の出力をそのまま示し、その後に要約を書く。報告案と PR 本文には
[agents/writer.md の「文書の規則」](agents/writer.md)を当てる。`not_done` の観点と、測れていないもの
（n・非決定性・欠測）を先に書く。pass の数だけを出すと、強さの較正が読み手に丸投げされる。

## 関連スキル

| 依頼 | 行き先 |
|---|---|
| 改善ループを伴わない調査・原因究明 | `research:search` |
| どの方式を採るかの審議 | `magi` |
| 対象がこのリポジトリの配布スキル自身 | [references/skill-kaizen.md](references/skill-kaizen.md) |

## 残るリスク

script の構造では防げず、読み手が知っておくべきもの。

- **依頼原文の書き写し**: `--request-file` を書くのは司令塔で、そこでの言い換えは検出できない。
  `init` と `amend` が返す原文をユーザーに示して確かめてもらう。
- **台帳の手書き**: 読むたびの検査（「固定するもの」の台帳の行）でも、最終行の書き換えと、
  辻褄を合わせて書き足した記録は検出できない。
- **agent の同一性と起動文**: 生成者と検証者の分離は、出力の `agent` と `prompt_extra` の自己申告に
  依存する。同じ agent に別の役割の brief を続けて渡すことは防げない。
- **名指しの停止条件**: `criteria.json` の `stops` は、script が成立を判定しない（`status` に表示する
  だけ）。当たったと判断したら、司令塔が止めて人間に報告する。
- **人間ゲートと自動継続**: どちらも司令塔が `close`・`continue` を呼ぶ前提で、script はマージや公開、
  `continue` を呼ばずに終わるターンを止められない。
- **モデル**: Codex（GPT-6）上の挙動は未測定。Codex で役割ごとにモデルを指定する方法も未確認。
  effort の指定が効くかも未確認。
