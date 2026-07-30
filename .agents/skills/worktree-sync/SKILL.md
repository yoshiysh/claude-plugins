---
name: worktree-sync
description: |
  Worktree を最新の main に同期し、マージ済みブランチと不要な作業状態を掃除する。
  「main を更新」「最新にして」「sync」「同期」「マージしたから更新」「main を取得」
  「ブランチを更新」「ブランチを整理」「掃除して」等のキーワードで起動する。
  ローカル・remote 双方のマージ済みブランチ、stash の滞留、submodule の drift、
  終了済み workspace までを 1 回の実行で洗い出す。
---

# Sync — Worktree 同期とリポジトリ整理

PR マージ後に worktree を最新の main に同期し、溜まった不要物を落として次の作業用ブランチを作る。

検出と削除は `[SKILL_DIR]/scripts/repo_state.py` に閉じている。Coordinator は
**いつユーザーに聞くか**だけを持つ。

> **Why スクリプトか（workflow ではなく）**: この作業には agent の判断が要る箇所が無く、
> 全てが決定的な git 操作。workflow スクリプトは shell を持たないため、workflow 化すると
> `git fetch` 1 本ごとに agent を挟むことになり、決定性を落としてコストだけが増える。
> ループ・並列・ファイル操作はスクリプト、判断は agent という分担にそのまま従う。

## 判定の根拠（ここが壊れると静かに取りこぼす）

- **基準は常に `origin/main`**。ローカル `main` は他 worktree が checkout 中だと更新に失敗し、
  その状態で `--merged main` を使うと検出漏れが黙って起きる。
- **fetch は `--prune` つき**。prune しないと remote 削除済みブランチが `[gone]` にならない。
- **「取り込まれたか」を 3 経路で見る**。`git branch --merged` は merge commit しか辿れず
  squash merge を取りこぼす（実測: MERGED な remote ブランチ 7 本のうち検出できたのは 1 本だけ）。
  そこで ①履歴に含まれるか（`merge-base --is-ancestor`）②PR が merged か
  ③パッチが既に main にあるか（`git cherry` の patch-id 比較）を順に見る。③は cherry-pick /
  rebase で取り込まれ、履歴にも PR にも痕跡が残らないブランチだけが該当する。

判定は全て `git` と `gh` の呼び出しで完結し、agent は関与しない。`gh` が使えない環境では
PR 経路が落ちるだけで、残る 2 経路が効き、分類は安全側（要判断）に寄る。

## [ACTION] Step 1: 状態を取る

```bash
python3 [SKILL_DIR]/scripts/repo_state.py report
```

`--prune` つき fetch とローカル main の追従までを含む。以降の判断は全てこの JSON を根拠にする。

## 聞く / 聞かないの基準

**削除がその成果物の唯一の写しを壊すときだけ聞く。** 取り込み済みと分類されたものは定義上
main に同じ内容があり、消しても失われるものが無い。そこに確認を挟んでも答えは毎回同じで、
ユーザーの注意を「本当に判断が要る項目」から逸らすだけになる。

| 対象 | 削除で失うもの | 確認 |
|---|---|---|
| ローカルの取り込み済み | 無し（main にある） | 不要 |
| remote の取り込み済み | 無し（main にある。復元も `git push origin <sha>:refs/heads/<name>` の 1 行） | 不要 |
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

消した内容は Step 7 の報告に必ず載せる（黙って消さない）。

## [ACTION] Step 3: 判断が要るものを 1 回でまとめて聞く

以下のうち**空でないものだけ**を 1 回の問いかけにまとめる。カテゴリごとに質問を分けない。

**`local.needs_decision`（remote 削除済みだが未取り込み）**: 消えた PR の作業がローカルにだけ
残っている。承認された分だけ `git branch -D <name>` を個別に実行する。

**`remote.needs_decision`（未取り込みで remote に残存）**: CLOSED PR や PR の無いブランチ。
提示するだけだと永久に溜まるので、削除するかを選択肢として出す。承認後:

```bash
python3 [SKILL_DIR]/scripts/repo_state.py prune-remote --branches "a,b"
```

ただしスクリプトは merged 以外を拒否するため、承認された未取り込みブランチは
`git push origin --delete <name>` を個別に実行する。

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

未コミットの変更があれば先に `git stash`（Step 7 で戻す）。

- **open な PR のブランチに乗っている場合**: `git reset` するとローカル ref が PR head から
  離れるため reset しない。`git switch -c <new> origin/main` で新ブランチを直接作る。
- **それ以外**: `git reset --mixed origin/main` で同期してから `git switch -c <new>`。

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
- main: {commit} {message}
- ブランチ: {new_branch}
- 削除（確認不要・取り込み済み）: ローカル {names} / remote {names}
- 要判断のまま残したもの: {names | なし}
- 作業状態: submodule drift {n} / tracked dirty {n} / untracked {n} / stash {n}
- workspace: 削除 {n} / 保持 {n}
- 後処理: {実行したコマンドと結果 | 設定なし（.claude/worktree-sync.json が無い）}
```

削除しなかったものは「なし」で省略せず、何を残したかを明示する。
