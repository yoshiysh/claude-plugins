# リポジトリの運用

配置・配布・実行環境・検証の正本。作業の進め方は [agent-work.md](agent-work.md)、スキル設計は [best-practices](../../plugins/skill-creator/skills/skill-creator-best-practices/references/best-practices.md) を参照する。

## 配置と配布

スキル実体の置き場は「公開済みかどうか」で決まる。

- **公開済み（plugin に属する）**: 実体は `plugins/<plugin>/skills/<name>/`。`.agents/skills/<name>` はそこへの相対 symlink（`../../plugins/<plugin>/skills/<name>`）。
- **未公開・未登録**: 実体は `.agents/skills/<name>/`（symlink でないもの。`ls -F .agents/skills | grep -v '@$'` で列挙できる）。
- Claude からの参照: `.claude/skills -> ../.agents/skills`
- Marketplace 定義: `.claude-plugin/marketplace.json`
- Marketplace 名: `yoshiysh-claude-plugins`
- 公開用 plugin: `plugins/<name>/`
- 公開済みスキルの Workflow script: `plugins/<plugin>/workflows/<f>.js`（実体。SKILL.md から `Workflow({ name: "<plugin>:<meta.name>" })` で呼ぶ）。`.agents/` からの参照は無い。テストは workflows/ に置かず（runner は workflows/ 直下の `.js` を全て source として読む）、スキルの `scripts/*.test.mjs`・`tests/` に置く。別 plugin のファイルを読むテストは配布物に入れず、リポジトリ直下の `tests/` に置く。

`manage-marketplace-plugin` で公開した瞬間に、`register_plugin.py` が実体を `plugins/` 側へ移し、`.agents/skills/<name>` を逆向き symlink に置き換える。初めて公開するスキルの Workflow script も同じ時に `plugins/<plugin>/workflows/` へ移り、callsite が名前の呼び出しに書き換わる。置き場の 2 段の規則は `plugins/skill-creator/skills/skill-creator-best-practices/references/best-practices.md` §13「script の置き場」を正とする。

### 実体が plugins/ 側にある理由

「`plugins/` 配下に symlink を作らない」はこれが理由: Codex は plugin サブツリーだけを取得して symlink を落とすため、`plugin.json` は読めても `skills/` が空のまま install される。実体を `plugins/` 側に置き、開発用の参照を `.agents/skills/` の symlink にしているのはこのため。

ディレクトリ名は実体名に揃える（公開名は frontmatter の `name` が担う。install 先のキャッシュはこのディレクトリ名で作られるため、`../<兄弟スキル>/` 参照を壊さないように名前を保つ）。

### plugin 間でスキルは共有できない

実体は常に 1 箇所。symlink が使えない以上、複数 plugin での共有はコピーになり drift するため禁止する（`register_plugin.py` が exit 4 で止める）。別 plugin のスキルが必要な場合は:

1. `.claude-plugin/plugin.json` の `dependencies` にその plugin を宣言する（Claude Code が同時 install する。Codex での扱いは本書「実行と環境」）。
2. 呼び出しは**スキル呼び出し**で行う。相手のファイルをパス参照したりスクリプトを直接実行したりしない（install 先では別ディレクトリに展開されるため解決しない）。
3. 呼び出し側の agent が自分で実行する必要がある手順書だけは、自前の `references/` に持つ。

実例: `notion-organize-knowledge` は `url-reader` をスキル呼び出し（`$url-reader`）で使い、`dependencies: ["research"]` を宣言し、caller 実行が必須な in-app Browser fallback protocol だけ自前の `references/in-app-browser-fallback.md` に持っている。

### 収録スキル

一覧はこの文書に書き写さず、正本から毎回得る。

- plugin 一覧: `.claude-plugin/marketplace.json` の `plugins`
- plugin ごとのスキル: `ls plugins/<plugin>/skills`（スキルを持たない plugin もある）と各 plugin の `README.md`
- 開発用の参照一覧: `ls .agents/skills`
- 公開名: 各 `SKILL.md` frontmatter の `name`（`grep -m1 '^name:' plugins/*/skills/*/SKILL.md`）。呼び出し名は `<plugin>:<name>` になる。

frontmatter の `name` はディレクトリ名より優先される（plugin スキルの公式仕様）。呼び出し名を書くときはディレクトリ名から推測せず frontmatter を見る。

install 手順は `README.md` の「インストール」を参照。plugin の改名・削除で残骸になった旧 plugin は `tools/update-plugins` がカタログ照合で検出して uninstall する（新 plugin の install は手動）。

### 編集と登録

- 編集は `.agents/skills/<name>/` から行う（公開済みスキルは symlink 越しに `plugins/` の実体を触ることになる）。`.claude/skills/` は symlink なので直接実体を増やさない。例外は公開済みの Workflow script で、`.agents/` から届く経路が無いので `plugins/<plugin>/workflows/` を直接編集する。
- 新規スキルは `.agents/skills/<name>/` に実体で作る。`plugins/` へ手で置かない（移動は `register_plugin.py` の仕事）。
- `plugins/` 配下に symlink を作らない。
- skill の `SKILL.md` は frontmatter の `name` と `description` を必ず持つ。
- 具体的な処理はできるだけ `scripts/` に寄せ、`SKILL.md` はフロー・分岐・完了条件を中心に保つ。
- plugin 登録時は `manage-marketplace-plugin` のスクリプトを使う。
- plugin author の既定値は `yoshiysh`。

### 配布時の注意

- `.claude-plugin/marketplace.json` の `name` を変えると `/plugin install <plugin>@<marketplace>` の marketplace 名も変わる。
- `plugin.json` は `.claude-plugin/` と `.codex-plugin/` の 2 箇所にある。両方を維持し、共通フィールドは `verify_install.py` の L2 が一致を検査する。専用フィールドは Claude の `dependencies`、Codex の `interface` で、逆側への混入を拒否する（[Codex 仕様](https://developers.openai.com/codex/plugins/build)に無いフィールドは `.codex-plugin/` 側に書かない）。登録処理は Codex の `interface` を生成し、既存の `interface` は再登録でも保持する。L2 の合格は Codex の表示スキーマに対する検証を含まない。
- **`.agents/skills/` を `find` で走査するときは `-L` を付ける。** 公開済みスキルは symlink なので、`find` は既定で中へ降りず、結果が静かに 0 件になる（`find -L .agents/skills -name '*.js'` のように書く）。同じ理由で `grep -r` も `-r` ではなく実体側（`plugins/`）か `-L` 相当の指定を使う。`make` の `$(wildcard .agents/skills/*/)` と Python の `Path.rglob` は symlink を辿るので影響を受けない。

## 実行と環境

`Workflow({ name })` は install 済みの写しへ解決される。未リリースの改稿は `Workflow({ scriptPath: "<checkout の絶対パス>/plugins/<plugin>/workflows/<f>.js", args })` で起動する。名前では旧版が走り、未 install なら not found になるため。

```bash
/plugin install <plugin-name>@yoshiysh-claude-plugins
```

`notion` plugin は `url-reader` スキルを使うため、Codex では `research` plugin も併せて install する（Claude Code は `dependencies` により自動で入る）。

Workflow caller は、各 SKILL.md の active callsite 契約に従い、native Workflow が無い Codex で
`workflow:dynamic-workflow-runner` を内部利用する（runner は workflow plugin に同梱）。
Codex は plugin dependency を自動導入しないため、workflow 以外の caller plugin と `workflow` plugin を
別々に一度 install する。runner をユーザーが直接呼ぶ必要は無い。
共通 JavaScript runtime は信頼済み source の `scriptPath` と、信頼済み plugin root 内の source の
`meta.name` による名前付き呼び出しを受け付け、caller 名の許可リストを要求しない。
必要 capability・source 構文・host 権限と各 caller の互換性分類は引き続き検証する。
実行条件は `plugins/workflow/skills/dynamic-workflow-runner/scripts/runtime/README.md`、
旧 receipt 経路の分類は同 skill の `references/claude-workflow-compatibility.md` と各 caller の契約を正とする。
名前付き source の返り値は変えずに返す。prd-spec のゲート後の再起動は caller の next_args 契約に従う
（設定は `plugins/workflow/skills/prd-spec/SKILL.md` の「## 実行環境」）。

`performance` plugin は install しただけでは何も収集しない（opt-in）。有効化・境界・保存先は
`plugins/performance/references/native-hooks.md` を正とする。

- Workflow を使う caller スキルは native Workflow を優先し、それが無い Codex では caller SKILL.md の active callsite から `workflow:dynamic-workflow-runner` を透過利用する（runner を参照しているスキルは `grep -rl dynamic-workflow-runner plugins/*/skills | cut -d/ -f1-4 | sort -u | grep -v '/dynamic-workflow-runner$'` で列挙できる）。これは host-global interceptor ではないため、新たな Workflow caller には同じ native-first route 契約を追加する。
- runner は意味保存して実行できない graph を最初の execution agent の dispatch 前に拒否する。拒否の基準は `plugins/workflow/skills/dynamic-workflow-runner/references/claude-workflow-compatibility.md` の互換性基準を正とする。

Codex の plugin marketplace は次で登録する。

```bash
codex plugin marketplace add yoshiysh/claude-plugins
```

登録後は ChatGPT デスクトップの Plugin Directory から必要な plugin を選んでインストールする。
Codex は `.claude-plugin/plugin.json` の `dependencies` を自動で解決しないため、依存は推移的に辿って手動でインストールする。plugin ごとの依存は次で確認する。

```bash
jq -r '.dependencies[]?' plugins/<plugin-name>/.claude-plugin/plugin.json
```

Codex Desktop の Worktree を使う場合は、ローカル環境のセットアップスクリプトに
`scripts/worktree-setup.sh` を指定する。依存関係が未導入の Worktree だけが `npm ci` を実行し、runtime の
リポジトリ root の `.npmrc` の release age 設定で新しい package version を拒否する。`.worktreeinclude` には Worktree
へコピーするローカル設定（`.env` / `.env.local`）を列挙する。秘密情報を含むため、追加するパスは
必要最小限に保つ。

Claude Code の plugin install は `README.md` の手順に従い、依存は `.claude-plugin/plugin.json` の `dependencies` で解決される。
`.codex/hooks.json` の PostToolUse hook（matcher `Edit|Write|MultiEdit`）は編集のたびに `make test` を実行する。

## 検証

`Makefile` が入口。対象スキルは `.agents/skills/*/` から毎回導出する（`.agents/skills/` に参照が無いスキルは検証対象に入らない）。

```bash
make test         # 合否ゲート: 参照・quick_validate・unittest・汎用 Node test・各 eval preflight
make portability  # 配布 portability の一覧（install 先で壊れる「書き方」の検出）
make check        # 上記 2 つをまとめて
```

`make test` は `check_references.py`（参照先の実在チェック）を含み、存在しない参照先があれば exit 1 で落ちる。

`make portability` は合否ゲートではない。`check_portability.py` は blocker を検出しても exit 0 を返し、既知の false positive もあるため、出力の `BLOCKER` 行は人が読んで判断する。既知の false positive は `skills-audit.md` §4.1b を参照。

個別スキルだけを見るとき:

```bash
python3 .agents/skills/skill-creator-best-practices/scripts/quick_validate.py .agents/skills/<name> --verbose
python3 .agents/skills/manage-marketplace-plugin/scripts/check_portability.py --skill <name>
python3 .agents/skills/manage-marketplace-plugin/scripts/check_references.py --skill <name>
```

Marketplace 登録後の install 検証:

```bash
python3 .agents/skills/manage-marketplace-plugin/scripts/verify_install.py --plugin <plugin-name>
```

PR を ready にした後に足した差分は、push した後に、生成者とは別の fresh context で読み取り専用の検証役へ差分とテスト結果を渡し、`REVIEW.md` を基準に見させる（観点を分けるかは差分の大きさと種類で呼び出し側が決め、分けるときは検証役を観点ごとに立てる）。Claude Code では `.claude/agents/diff-verifier.md` を使い、Codex でも同じ条件で検証役を立てる。

`quick_validate.py` の成功だけでは全項目の合格ではない。検証者の有無・description の実発火など機械判定できない項目は `SKIP:` として毎回申告されるので、公開前の設計レビューで確認する。
