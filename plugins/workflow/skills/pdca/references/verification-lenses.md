# 検証の多視点化と集計規則

1 つの生成物に 1 人の検証者を当てると、その 1 人が持っていない失敗様式は素通りする。
ここでは「どの視点を当てるか」「結果をどう足し合わせるか」「コストが見合わないとき
どう縮退するか」を定める。**視点の中身は agent の判断、足し合わせと縮退は script の算術**で、
この分担は崩さない。

## 目次
- run verify の 3 レンズ
- 集計規則
- 縮退規則
- 機序分析の複数視点と決定的マージ
- builder 成果物の独立 verify
- 凍結 harness の照合（誰が何を見るか）

## run verify の 3 レンズ

`scripts/pdca.js` は run ごとに [agents/verifier.md](../agents/verifier.md) を
**レンズを変えて**起動する。役割定義は 1 本で、`[LENS]` が見る角度を決める。

| lens | 問い | 見落としを塞ぐ失敗様式 |
|---|---|---|
| `criteria` | 成功基準を満たしたか。`metric` の実測値はいくつか | 基準の読み違い・採点漏れ |
| `authenticity` | この run は主張どおりに実行されたか（成果物・ログ・生の測定値が、申告された実行と辻褄が合うか） | 実行していないのに実行したことになる／別条件の成果物が混ざる |
| `contract` | successCriteria に書かれた検証が**実施された**か。未実施を pass にしていないか | 「書いたのに実施されず pass」（SKILL.md の末尾が禁じている事故そのもの） |

`score` を返すのは `criteria` レンズだけ。3 レンズが別々に点を付けると、どれを成績に
使うかという裁量が生まれる。

## 集計規則

- `measured`: **適用した全レンズが `measured: true`** のときだけ true（全員一致）。
  真正性か契約実施のどちらかが立たない run は、基準を満たして見えても測れていない
- `score`: `criteria` レンズの値のみ。`measured` が false なら成績に入れない
- `self_report_used`: どれか 1 つでも true なら true（汚染は最悪値を採る）
- `lens_disagreements[]`: レンズ間で `measured` が割れた run を、どのレンズがどう
  判定したかとともに記録する。消さずに `calibration_notes` へ出す（割れたこと自体が
  測定設計の情報で、平均に丸めると消える）

過半数ではなく全員一致にしてあるのは、レンズが**別々の失敗様式**を見ているため。
多数決は「2 人が見ていない欠陥を 1 人が見つけた」ケースを捨てる。

## 縮退規則

コストは run 数 × レンズ数で増える。`criteria` は全 run に必ず当て、
`authenticity` / `contract` は発行 run 数が `FULL_LENS_RUN_BUDGET`（`scripts/pdca.js` の
定数）を超えたときだけ**各条件の先頭 run** に絞る。条件ごとに最低 1 本は真正性と
契約実施が見られる状態を保ちつつ、総 agent 数を線形に抑える。

縮退したら `truncations` と `calibration_notes` に何を落としたかを出す。黙って減らすと
「全部見た」と読める。

## 機序分析の複数視点と決定的マージ

`mechanism-analyst` を 2 本、**互いの出力を見ないまま**独立に起動する。そのあと
[agents/mechanism-arbiter.md](../agents/mechanism-arbiter.md) が両者の機序を突き合わせ、
「同じことを言っている組」を index の対応として返す。結論は script の算術で決める。

| 状態 | 扱い |
|---|---|
| 両者が独立に同じ機序を出し、両者とも `identified: true` | `identified: true` / `corroboration: "corroborated"` |
| 片方だけが出した、または片方が `identified: false` | `identified: false` / `corroboration: "single_source"`（候補として残し、消さない） |

「決定的マージ」は**対応付けそのものを決定的にする**という意味ではない（文の同一性判定は
未較正の類似度閾値になり、閾値が合否を左右する設計をこのスキルは採らない）。対応付けは
arbiter の判断、その帰結は script の規則、という分担である。arbiter は index しか返せない
ので、どちらの analyst も出していない機序を新たに足す経路が構造上ない。

**この変更は停止条件の意味を変える。** 単独出所の機序が `identified: false` に落ちる分、
`new_identified_mechanisms` は従来より小さく出る。つまり Act 判定表の「乾いた → stop」行が、
以前なら周回を続けていた局面で立つ。これは意図した厳格化で、単独の分析者しか言っていない
機序を根拠に周回を重ねる挙動を止める。

## builder 成果物の独立 verify

builder が作った harness・測定対象物を、**Plan の measurement 契約と照合する**
fresh context の [build-verifier](../agents/build-verifier.md) を run 開始前に挟む。
run は 1 本ごとに予算を食うので、測定点が契約を満たしていない harness で回すのは
最も高くつく失敗になる。

blocker/major があれば builder へ差し戻し、上限 `MAX_BUILD_REVISIONS`（`scripts/pdca.js`）
まで改稿する。超えたら Measure に入らず BLOCKED で返す（欠けた測定点のまま run を
発行しない）。

## 凍結 harness の照合（誰が何を見るか）

採点物（判定ロジック・期待値・hold-out・判定プロンプト）は Plan の成果物で、Do の前に
`scripts/harness_freeze.py` が凍結する。**照合するのは凍結物を作っていない agent だけ**で、
builder には在処を渡さない。機構と保証の段（構造 / 事後検出 / 強制でないこと）は
[harness-freeze.md](harness-freeze.md)。

| 誰が | 何を返すか | 破れたときの script の帰結 |
|---|---|---|
| build-verifier（レンズ 6） | `frozen_harness_digest_ok` / `frozen_harness_touched` | run を 1 本も発行せず BLOCKED（改稿ループに乗せない） |
| build-verifier（レンズ 7） | 測定点が Plan に対応づき、出す値の範囲・除外が成果物の都合で決まっていないか（findings として） | blocker/major なら builder へ差し戻し（凍結物に触らずに結果を動かす経路はここで見る） |
| verifier（各レンズ） | `frozen_harness_digest_ok` | その run は `measured: false`（欠測と同じ扱い。score を成績に入れない） |

build 側を改稿ループに乗せないのは、凍結物が変わった状態の測定は後から救済できないため。
測定点の不足は作り直せば直るが、採点物の同一性は run の後からは復元できない。
