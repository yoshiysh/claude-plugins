---
name: cleanup-branches
description: |
  取り込み済みブランチと終了済み workspace を削除し（承認を得た未取り込みブランチも個別に削除。
  stash・submodule drift・untracked・tracked の未コミット差分は削除せず一覧として提示するだけ）、
  worktree を最新の主ブランチに同期し、
  その後の作業用ブランチ（`feature/{hex}` 等）を作成して終わる。
  「ブランチを整理して」「不要なブランチを消したい」「マージ済みブランチをクリーンアップして」
  「main を更新」「最新にして」「sync」「同期」「マージしたから更新」「ブランチを更新」
  「掃除して」等のキーワードで起動する。
  ローカル・remote 双方のマージ済みブランチ（squash merge・cherry-pick・rebase で
  取り込まれたものを含む）、stash の滞留、submodule の drift、終了済み workspace までを
  1 回の実行で洗い出す。判定基準は main / develop / release/* / dev/* を動的に列挙するため、
  develop が主軸で dev/{version} のような並走ブランチを持つリポジトリでも正しく判定する。
---

# cleanup-branches — ブランチ整理と worktree 同期

PR マージ後に worktree を最新の主ブランチに同期し、溜まった不要物を落として次の作業用ブランチを作る。

検出と削除は `[SKILL_DIR]/scripts/repo_state.py` に閉じている。Coordinator は
**いつユーザーに聞くか**だけを持つ。

> **Why スクリプトか（workflow ではなく）**: この作業には agent の判断が要る箇所が無く、
> 全てが決定的な git 操作。workflow スクリプトは shell を持たないため、workflow 化すると
> `git fetch` 1 本ごとに agent を挟むことになり、決定性を落としてコストだけが増える。
> ループ・並列・ファイル操作はスクリプト、判断は agent という分担にそのまま従う。

## 判定の根拠（ここが壊れると静かに取りこぼす）

- **判定基準は main / develop / release/* / dev/* を動的に列挙する**（`primary_branch_names()`）。
  `origin/main` 固定にすると、develop が主軸で dev/{version} のような並走ブランチを持つ
  リポジトリで、実際には取り込み済みのブランチを誤って「未マージ」と判定する。release/* と dev/*
  はワイルドカードのため、ローカル・リモートに実在するブランチだけを対象にする。
- **fetch は `--prune` つき**。prune しないと remote 削除済みブランチが `[gone]` にならない。
- **「取り込まれたか」を経路を分けて見る**。①いずれかの primary ref の履歴に含まれるか
  （事前に primary ごと `git branch --merged` で取り込み済み集合を1回だけ計算し、以降は
  集合参照にする。ブランチごとに `merge-base --is-ancestor` を呼ぶと本リポジトリの実測
  （remote 301本 × primary 38本）で7分超かかった）②いずれかの primary ref を base とする
  PR が merged か（`gh pr list` は primary ごとに絞らず1回だけ取得し、`baseRefName` で
  Python 側にフィルタする。primary ごとに絞ると1回あたり数秒かかる `gh pr list` を
  primary 数ぶん呼ぶことになり実測4-5分かかった）③**ローカルブランチに限り**、パッチが
  既に main/develop/起点ブランチ（`sync_base`）のいずれかにあるか（`git cherry` の
  patch-id 比較）。③は cherry-pick / rebase で取り込まれ、履歴にも PR にも痕跡が残らない
  ブランチだけが該当する。remote には適用しない（相手が数百本規模になりうるリモート全件に
  `git cherry` を適用すると、それだけで再び分単位の遅延になる。サーバー側で PR も経由せず
  cherry-pick される remote ブランチは稀なケースであり、この経路だけ needs_decision に
  倒す安全側の判断にしている）。PR の base を限定するのは、限定しないと無関係な feature 間
  PR の headRefName まで拾ってしまうため。
- **削除前に退避タグを打つ**（`deleted-branches/<branch名の / を - に置換>-<YYYYMMDD-HHMMSS>`）。
  reflog は保持期限があり同一マシン限定のため、それに依存しない復元手段を先に用意してから消す。
  タグ作成に失敗したら削除自体を中止する（復元手段が無いまま消さない）。

判定は全て `git` と `gh` の呼び出しで完結し、agent は関与しない。`gh` が使えない環境では
PR 経路が落ちるだけで、残る 2 経路が効き、分類は安全側（要判断）に寄る。

**スクリプトが消すのは「取り込み済み」と分類された ref だけ**という契約になっている
（`prune-local` は `local.auto_delete`、`prune-remote` は `remote.merged` としか照合しない）。
この経路では `git branch -d`/`-D`・`git tag` がスクリプト内部で `subprocess` の引数リスト形式
（シェル文字列展開を経ない）で呼ばれるため、エージェントが自分で `git branch -d` を組み立てる
設計と違い、ヒアドキュメント・`eval` 等で許可制（deny ルール）を迂回する余地が構造的に無い。

この契約の**外側**にあるもの（未取り込みブランチ = `needs_decision`）は、スクリプトに
サブコマンドを足して消せるようにしない。足せば「未取り込みの ref を消せる経路」がスクリプト内に
生まれ、上の契約そのものが失われる。未取り込みの削除はユーザーの承認が前提の一件ごとの判断で、
まとめて回す対象ではないため、Step 3 では**承認された分だけを手で 1 本ずつ**消す。その代わり、
スクリプトが自動でやっている「先に退避タグを打ち、タグが作れなければ削除しない」を
手順としてそのまま踏む（下記）。

## [ACTION] Step 1: 状態を取る

```bash
python3 [SKILL_DIR]/scripts/repo_state.py report
```

`--prune` つき fetch と、起点ブランチ（後述）のローカル追従までを含む。以降の判断は全て
この JSON を根拠にする。`primary_branches` フィールドに、今回の判定で実際に使った
main/develop/release/* / dev/* の一覧が入るので、想定通り列挙されているか確認する。

## 聞く / 聞かないの基準

**削除がその成果物の唯一の写しを壊すときだけ聞く。** 取り込み済みと分類されたものは定義上
いずれかの primary ref に同じ内容があり、消しても失われるものが無い（加えて退避タグでも
復元できる）。そこに確認を挟んでも答えは毎回同じで、ユーザーの注意を「本当に判断が要る項目」
から逸らすだけになる。

| 対象 | 削除で失うもの | 確認 |
|---|---|---|
| ローカルの取り込み済み | 無し（primary ref にある。加えて退避タグでも復元可） | 不要 |
| remote の取り込み済み | 無し（primary ref にある。復元も `git push origin <sha>:refs/heads/<name>` の 1 行） | 不要 |
| 未取り込み（ローカル / remote） | **その作業そのもの** | 必要 |
| 終了済み workspace | **審議の記録**（gitignore 対象で復元不可） | 必要 |

## [ACTION] Step 2: 取り込み済みを削除（確認不要）

```bash
python3 [SKILL_DIR]/scripts/repo_state.py prune-local
python3 [SKILL_DIR]/scripts/repo_state.py prune-remote
```

どちらも対象は分類結果そのもの（`local.auto_delete` / `remote.merged`）で、名前を渡す必要は無い。
`prune-remote` に名前を渡した場合はスクリプトが分類と照合し、merged でないものは拒否する。

削除方法もスクリプトが分類とセットで決める（履歴に含まれるものは `-d`、squash merge や
cherry-pick で取り込まれたものは `-D`）。**ブランチ名だけを受け取って人手で `-D` し直さない** —
その運用にすると未取り込みのブランチを巻き込む余地が生まれる。

`prune-local` の出力には各ブランチの `backup_tag` が含まれる。消した内容は Step 7 の報告に
退避タグ名とあわせて必ず載せる（黙って消さない）。

## [ACTION] Step 3: 判断が要るものを 1 回でまとめて聞く

以下のうち**空でないものだけ**を 1 回の問いかけにまとめる。カテゴリごとに質問を分けない。
候補が多い（目安として 1 カテゴリ 20 件超）ときも問いかけは 1 回のままで、全件列挙はせず
件数と代表例（最終 commit が古い順に数件、下記の `reason` の事実を添える）に要約したうえで
「全件残す / 一覧を見て個別に選ぶ」を選択肢として出す（ユーザーが一覧を求めた場合にだけ
全件を出す。これはユーザーの返答であって、カテゴリごとに質問を分けることではない）。
「全件まとめて削除」は選択肢に含めない —— 未取り込みの削除は一件ごとの承認が前提で、
まとめて回す対象ではないという上の契約に反する。

**`local.needs_decision`（remote 削除済みだが未取り込み）**: 消えた PR の作業がローカルにだけ
残っている。承認された分だけ、次の 2 手を**この順で**個別に実行する。

```bash
git tag deleted-branches/<branch名の / を - に置換>-<YYYYMMDD-HHMMSS> <name>
git branch -D <name>
```

例: `feature/foo` なら `git tag deleted-branches/feature-foo-20250101-123456 feature/foo`。
タグ名は Step 2 のスクリプトと同じ規則（`/` を `-` に置換し、`-YYYYMMDD-HHMMSS` を付ける）。
**`git tag` が失敗したら `git branch -D` を実行しない** — 復元手段が無いまま消さないという
スクリプト側の性質を、手順としてそのまま踏む。打ったタグ名は Step 7 の報告に載せる。

**`remote.needs_decision`（未取り込みで remote に残存）**: CLOSED PR や PR の無いブランチ。
提示するだけだと永久に溜まるので、削除するかを選択肢として出す。`prune-remote` は merged 以外を
拒否する（それが上の契約）ので、承認された未取り込みブランチはローカル側と同じ 2 手を
**この順で**個別に実行する。

```bash
git tag deleted-branches/<branch名の / を - に置換>-<YYYYMMDD-HHMMSS> origin/<name>
git push origin --delete <name>
```

タグは必ず削除**前**に、remote-tracking ref（`origin/<name>`）から打つ。push --delete の後は
その ref が消えて、控える対象自体が無くなる。`git tag` が失敗したら削除しない。
復元は控えた SHA から `git push origin <sha>:refs/heads/<name>`。
このタグはローカルにしか残らない（他の誰かの手元には無い）ので、確認を省く理由にはならない —
Step 3 で聞くこと自体は変わらない。打ったタグ名は Step 7 の報告に載せる。

**`workspace.finished`（終了済みの skill session）**: `{.agent,.claude}/skills/*/workspace` を
自動探索し、session の `state.json` が `status: completed` を持つものだけを終端と見なす。
名前は `<skill>/<session>` 形式で、workspace を持つスキルが複数あっても取り違えない。
終端済みでも成果物はそこにしか無いので、消す前に聞く。

```bash
python3 [SKILL_DIR]/scripts/repo_state.py purge-workspace --sessions "id1,id2"
```

`workspace.active` は resume されうるので候補にしない。

いずれも `reason` に添えた事実（独自 commit 数・最終 commit 日）を一緒に出す。名前だけでは
捨ててよいか判断できない。

## [ACTION] Step 4: 作業状態は報告するだけ（削除しない）

以下は**提示のみ**。中身を見ずに消すと未コミットの作業を破壊する。

| 項目 | 意味 | 直し方 |
|---|---|---|
| `submodule_drift` | submodule のポインタ差分 | `git submodule update` で戻すか、意図した更新なら commit する。**削除ではない** |
| `tracked_dirty` | tracked ファイルの未コミット差分 | 内容を見て commit か revert。ツールが機械生成する local state が tracked になっているなら、`git rm --cached` + gitignore はユーザー承認が要る |
| `untracked` | 未追跡ファイル | **`git clean` は使わない**。スキル一式や設定ファイルなど未コミットの作業が混ざる |
| `stashes` | 滞留した stash | 一覧を出す。自動 drop はしない |

## [ACTION] Step 5: 同期とブランチ作成

**起点ブランチの決定**: プロジェクト側に `.claude/detect-base-branch.sh`（現在のブランチから
適切なベースブランチを検出するスクリプト。`resolve-conflict`・`create-pr` スキルが既に使って
いる）があれば、`repo_state.py` がそれを優先して使う（`report` 出力の `sync_base` で確認できる）。
無ければ `origin/HEAD` の default branch（多くの場合 `main`）にフォールバックする。

未コミットの変更があれば先に `git stash`（Step 7 で戻す）。

分岐は Step 1 の JSON の `current_branch_open_pr` だけで決める（`gh pr view` 等で改めて
調べ直さない。同じ判定を 2 か所で持つと食い違う）。この値は `hold_reason()` の open PR 判定と
同じ集合（base が primary の open PR）に基づくため、base が別の feature ブランチの
stacked PR は `false` になる。

- **`current_branch_open_pr` が `true`**: `git reset` するとローカル ref が PR head から
  離れるため reset しない。`git switch -c <new> origin/<sync_base>` で新ブランチを直接作る。
- **`false`**: `git reset --mixed origin/<sync_base>` で同期してから `git switch -c <new>`。
  `current_branch` が空（detached HEAD）のときもこちら。

ブランチ名はユーザー指定があればそれを使い、無ければ `feature/{6文字hex}` を生成する。

## [ACTION] Step 6: リポジトリ固有の後処理

同期後に何を走らせるか（依存の再構築、submodule の更新など）はリポジトリごとに違うので、
スキル側には持たせない。`.claude/worktree-sync.json` があればそれを読み、`post_sync` の
コマンドを順に実行する。

```json
{
  "post_sync": [
    "git -C output/notes pull origin main",
    "make venv && make install-dev"
  ]
}
```

ファイルが無ければ何もせず、その旨を Step 7 で報告する（「後処理なし」を黙って省略しない）。
コマンドが失敗しても Step 7 へ進み、失敗した行をそのまま提示して手動実行を案内する。

> **Why 設定ファイルか**: ここに `make venv` のような特定リポジトリの手順を直書きすると、
> 別のリポジトリでは必ず失敗する。かといって agent に推測させると、実行するコマンドが
> 毎回変わって同期が非決定的になる。リポジトリ自身に宣言させるのが両方を避ける唯一の形。

## [ACTION] Step 7: 完了報告

stash した場合は `git stash pop`（コンフリクト時は箇所を出して手動解決を案内）。そのうえで:

```
同期完了:
- 起点ブランチ: {sync_base}（{commit} {message}）
- 判定に使った primary refs: {primary_branches}
- ブランチ: {new_branch}
- 削除（確認不要・取り込み済み）: ローカル {names + backup_tag} / remote {names}
- 承認を得て削除した未取り込み: ローカル {names + tag} / remote {names + tag} | なし
- 要判断のまま残したもの: {names | なし}
- 作業状態: submodule drift {n} / tracked dirty {n} / untracked {n} / stash {n}
- workspace: 削除 {n} / 保持 {n}
- 後処理: {実行したコマンドと結果 | 設定なし（.claude/worktree-sync.json が無い）}
```

削除しなかったものは「なし」で省略せず、何を残したかを明示する。退避タグは復元の手がかりに
なるため、削除したブランチと必ず対にして示す。
