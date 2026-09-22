---
name: ooda
description: >
  状況が読めないまま動き出す必要がある課題で、Observe→Orient→Decide→Act を 1 周ずつ回し、
  Act で得た観測を別 agent が出所から確かめてから次の周の Observe に戻すスキル。
  各周は目的に照らした事実の基準線、根拠付きの選択肢 3 つ、既試行を踏まえた 1 案の選択、実行と出所付き観測、
  観測の独立検証までを一貫させ、周ごとの記録を ledger に積む。
  Use when 「OODA で回して」「/ooda」「状況が読めない中で素早く判断を回したい」
  「観察して方針を決め直しながら進めたい」「まず様子を見て、分かったことで打ち手を変えていきたい」
  「障害の原因がまだ絞れないので、見ながら手を打って、また見て決め直したい」といった依頼。
  成功基準を事前に固定して施策を測る改善・検証ループ（A/B で比べたい、基準を決めて効果を測りたい）は
  pdca に回し、実装方針や方式そのものを複数視点で審議して決めたい場合は magi に回す。
  調査・原因究明だけで打ち手を伴わない依頼（research:search）や、反復のない 1 回限りの実行依頼には使わない。
---

# Running OODA Loops

## 目的

先に成功基準を固定できるほど状況が分かっていない課題で、観測 → 読み → 選択 → 実行を短く回し、
実行で分かったことを次の周の読みに戻す。PDCA が「基準を実行前に固定して測る」ループなのに対し、
OODA は「観測が増えるたびに状況の読み（Orient）を作り直す」ループで、重心は Orient にある。

pdca / magi との使い分け:

| 依頼の形 | 使うスキル |
|---|---|
| 状況がまだ読めず、見ながら打ち手を決め直したい | ooda |
| 成功基準を決めて、施策を対制御や前後比較で測りたい | pdca |
| 方式・実装方針そのものを複数案で審議して決めたい | magi |

## 1 周の流れと、生成と検証の分離

1 回の Workflow 呼び出しが 1 周で、`scripts/ooda.js` が順序と停止を持つ。

1. **Observe**（[agents/observe.md](agents/observe.md)）: 目的・文脈・前周の**検証済み**観測から、出所付きの事実を集める
2. **Orient**（[agents/orient.md](agents/orient.md)）: 目的に照らして状況を読み、根拠付きの選択肢をちょうど 3 つ出す。材料不足なら `insufficient_data`
3. **Decide**（[agents/decide.md](agents/decide.md)）: 制約と `ledger_state`（過去に選んだ方針と検証済みの結果）を踏まえて 1 案を選ぶ。選べなければ `BLOCKED`
4. **Act**（[agents/act.md](agents/act.md)）: 手順を実行し、`{observation, source}` の形で新しい観測を返す
5. **Verify**（[agents/observation-verifier.md](agents/observation-verifier.md)）: Act を書いていない agent が各観測を `source` から確かめ、`verified` / `rejected` に分ける

次の周の Observe に渡るのは `verified` だけ。Act が自分の観測を「事実」と宣言して次の周へ進む経路を
作らないためで、`source` が空の観測は検証役に渡す前に script が落とす。検証役が同じ観測を verified と rejected の両方に入れた場合は rejected を優先する。検証役が Act に無い観測を足した場合や、
判定を返さなかった観測も script が `rejected` にする。

Orient が `insufficient_data`、Decide が `BLOCKED` を返した周、または agent が結果を返さなかった周は、
その時点で後続フェーズを起動せずに止まる。やっていない工程を完了扱いにしない。

## 実行手順

### 1. run の置き場所を決める

run ごとに 1 本の ledger を `~/.claude/ooda-workspace/<run-id>/ledger.jsonl` に置く。
`<run-id>` は日付と短い題（例: `2026-09-22-checkout-lcp`）。スキルのディレクトリの下には置かない
（インストール先は plugin のバージョンごとのディレクトリなので、更新すると再開できなくなり、古いバージョンの削除で ledger も消える）。
ディレクトリは初回の `ledger.py append` が作るので、事前の `mkdir` は要らない。

### 2. 各周の前に ledger を読む

```bash
python3 <このスキルの絶対パス>/scripts/ledger.py read --path ~/.claude/ooda-workspace/<run-id>/ledger.jsonl
```

出力（JSON 配列）を編集せずに `args.ledger` に渡す。ファイルが無いと非ゼロで止まる（run-id の打ち間違いを
新規 run と取り違えないため）。**新規 run の初周だけ** `--allow-missing` を付け、`[]` を受け取る:

```bash
python3 <このスキルの絶対パス>/scripts/ledger.py read --allow-missing --path ~/.claude/ooda-workspace/<run-id>/ledger.jsonl
```

ファイルが無い・壊れた行がある・payload の形が phase と合わない場合は非ゼロで止まる。その場合は周を回さず、エラーをユーザーに返す。

### 3. Workflow を呼ぶ（1 周）

> **透過実行 route**: 現在の tool inventory に native `Workflow` があり、この call が未試行なら
> native を 1 回だけ使う。native が存在しない Codex では `workflow:dynamic-workflow-runner` を
> 内部互換層として自動利用し、ユーザーに runner の指定を求めない。native の試行後に
> error / timeout / invalid result となった場合は runner へ fallback しない。
> 周回の継続判断とユーザーへの報告はこの SKILL.md（呼び出し側）が持ち、runner 内 gate に移さない。
>
> **Codex classification: `portable`**。`ooda.js` は 1 呼び出しで agent を最大 5 回（`meta.phases` の各フェーズ 1 回）しか起動せず、
> worktree isolation も runtime-generated artifact path も使わない（ledger は返り値の entry を呼び出し側が書く）。
> model 指定は `meta.codex_workflow_compatibility.model_hints` に宣言した非拘束の hint だけ。
> Observe / Act / Verify は実行時点の live な状態（ファイル・ログ・コマンド出力）を読む。skill-creator の review mode は
> 対象 tree の file inventory・content hash が call receipt に無いまま live tree を暗黙入力として読むことを理由に
> `rejected_source` になっている。ooda は research:search（`investigate.js`）と同じ扱いにした: live な状態を読むこと自体が
> 目的で、読んだ出所は各観測の `source` として返り値と ledger に残り、次の周へは検証役が出所から確かめた観測しか渡らない。
> review mode との差は、review が「固定された対象 tree を採点する」ために入力の同一性が結果の意味を決めるのに対し、
> ooda は「その時点の状態を観測する」ので入力が周ごとに変わることが前提になっている点にある。
>
> runner で動かすときの request（根拠は `workflow:dynamic-workflow-runner` の runtime README）:
> - `limits.maxAgents` を **5 以上**にする。既定は 2 で、3 回目の `agent()` が `agent call budget exceeded` で run 全体を失敗させる。
>   フェーズは逐次なので `limits.concurrency` は既定（2）のままでよい。
> - `limits.timeoutMs` は run 全体の期限（既定 60000 = 60 秒）で、5 回の agent 呼び出しが逐次で収まる必要がある。
>   実測値は無い。目安として 1800000（30 分）から始め、`events.jsonl` の所要時間を見て調整する。
> - `modelMap` は**必須**。runner は `agent()` の `model` 値ごとに明示の対応を要求し、無いと `explicit model mapping required` で止まる。
>   `sonnet` と `opus` の両方に Codex 側の model を割り当てる。対応表は品質の同等性を保証しない。
> - worker は既定で read-only・network 無効。Act の手順が書き込みを要するなら host 側で `workspace-write` を許可する。
>   許可が無ければ Act はその手順を `not_executed` と返し、実行したことにはならない。

```js
Workflow({
  scriptPath: '<このスキルの絶対パス>/scripts/ooda.js',
  args: {
    skillDir: '<このスキルの絶対パス>',
    objective: '<この run の目的。全周で同じ文を渡す>',
    context: '<状況・既に分かっていること>',
    constraints: '<予算・触ってよい範囲・禁止事項>',
    ledger: [ /* 手順 2 の ledger.py read が出した配列をそのまま。新規 run の初周は [] */ ],
  },
})
```

`skillDir` か `objective` が無い、または `args.ledger` が entry の配列でない・不正な要素（`payload` が object でない、`iteration` が 1 以上の整数でないなど）を含むと、agent を起動せずに `status: 'BLOCKED'` を返す。

返り値: `{ status: 'ok' | 'BLOCKED' | 'INSUFFICIENT_DATA', iteration, observe, orient, decide, act, verification, ledger_entries, reason? }`。
止まった周では、そこまでに得たフェーズだけが入る。

- `iteration`: この周の番号（ledger の最大 iteration + 1）。`args.ledger` が entry の配列でない、または不正な要素を含むために agent を起動せず BLOCKED を返したときは `null`
- `decide`: Decide agent の出力に、script が `selected_option`（選ばれた案の description 文字列。`selected_option_id` が Orient の選択肢に無ければ `null`）を付け足したもの
- `verification`: `{ verified, rejected }`。次の周の Observe に渡るのは `verified` だけ

### 4. 返り値の ledger_entries を追記する

status に関わらず、返り値の `ledger_entries` を編集せずに追記する（止まった周の記録も残す）。
観測文にはシングルクォートが入りうるので、`--json '<...>'` ではなく引用符を解釈しない heredoc で stdin から渡す:

```bash
python3 <このスキルの絶対パス>/scripts/ledger.py append --path ~/.claude/ooda-workspace/<run-id>/ledger.jsonl <<'LEDGER_ENTRIES'
<返り値の ledger_entries（JSON 配列）をそのまま>
LEDGER_ENTRIES
```

Workflow 自体が失敗して返り値（`ledger_entries`）が得られなかった場合は、ledger に何も追記しない（推測で entry を作らない）。
その周が Act まで進んでいた可能性があることをユーザーに伝え、Act が状態を変えたかの確認と再開するかどうかはユーザーの判断に任せる。
自動で同じ周を再実行しない。

ledger の writer は `ledger.py` だけ。`seq` と `timestamp` は ledger.py が付け、呼び出し側が書いた `seq` / `timestamp` は受け付けない。
entry の形は `{seq, iteration, phase, payload, timestamp}`、phase は `observe | orient | decide | act | act_verified`。
周回番号 `iteration` は ooda.js が ledger から数える。

### 5. ユーザーへ返す

- status と、止まった場合は理由（`reason` / `missing_data` / `blocked_reasons`）
- 各フェーズの要点: Observe の基準線と gaps、Orient の読みと 3 案（根拠）、Decide の選択と理由、Act の実行結果（`not_executed` / `failed` を含む）
- 検証の内訳: `verified` の件数と中身、`rejected` の件数と理由

### 6. 次の周を回すか

- `status: 'ok'` で、`verified` が 1 件以上あり、目的がまだ満たされていない → 次の周を回す（手順 2 から）。
  1 回の依頼で回すのは既定 3 周まで。超える場合は、ここまでの要点を返してユーザーに続行を確認する
  （1 周で agent を手順 3 の route に書いた回数だけ起動し、Act は状態を変えうる。方向がずれたまま周を重ねる前にユーザーが確かめられる区切りとして置いた初期値で、実績を見て調整する）。
- `status: 'ok'` だが `verified` が 0 件 → 新しい確認済み情報が無く、次の周は同じ事実で読み直すだけになるので止める。
  rejected の理由（出所が無い・確かめられない）を返し、何を測れば進めるかを示す。
- `INSUFFICIENT_DATA` → `missing_data` を返して止める。データが揃ったら同じ run-id で再開する。
- `BLOCKED` → 理由を返して止める。制約の緩和や前提の変更はユーザーが決める。
- Act が「人間の承認が要る」として `not_executed` にした手順がある → その手順を示し、承認を得るまで次の周に進まない。

## ファイル一覧

| ファイル | 役割 |
|---|---|
| [scripts/ooda.js](scripts/ooda.js) | 1 周の Workflow script（順序・停止・検証結果の照合・ledger entry の組み立て） |
| [scripts/ledger.py](scripts/ledger.py) | ledger の唯一の writer / reader（`append` / `read`） |
| [agents/observe.md](agents/observe.md) | Observe の入出力契約 |
| [agents/orient.md](agents/orient.md) | Orient の入出力契約 |
| [agents/decide.md](agents/decide.md) | Decide の入出力契約 |
| [agents/act.md](agents/act.md) | Act の入出力契約 |
| [agents/observation-verifier.md](agents/observation-verifier.md) | Act の観測を出所から確かめる検証役の契約 |
| [evals/evals.json](evals/evals.json) | 発火・非発火と各フェーズの契約を見る評価シナリオ |
| [evals/fixtures/api-latency-ledger.jsonl](evals/fixtures/api-latency-ledger.jsonl) | eval 2 が使う 1 周分の ledger（ledger.py で生成） |
| [tests/test_ledger.py](tests/test_ledger.py) | ledger.py の契約テスト（`python3 -m unittest discover -s tests -p 'test_*.py'`） |

## Usage

1. `workflow` plugin を入れる: `/plugin install workflow@yoshiysh-claude-plugins`
2. 呼ぶ: `/workflow:ooda 目的: モバイルの購入ページの表示が遅い。原因がまだ絞れていないので、見ながら手を打ちたい`
