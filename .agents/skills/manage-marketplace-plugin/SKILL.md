---
name: manage-marketplace-plugin
description: >
  このリポジトリ内の既存スキル（.claude/skills/ 配下に実体があるもの）を、リポジトリ自身の
  marketplace.json（ルートの .claude-plugin/marketplace.json）にプラグインとして登録・更新・公開するスキル。
  plugin はカテゴリ単位（git / chat / research / notion / skill-creator 等）で複数スキルを収録でき、
  既存カテゴリ plugin へのスキル追加にも対応する。未登録 plugin なら新規登録し、
  登録済みなら更新する（version は明示が無ければ patch を自動インクリメント）。
  marketplace.json への非破壊追記／更新、プラグインディレクトリと plugin.json（Claude 用・Codex 用の 2 系統）の生成、
  README の雛形作成、スキル実体の plugins/ 配下への移動と開発用の逆 symlink 作成、install 先を模した検証までを自動化する。
  対象スキルが別スキルを呼び出す連鎖依存を持つ場合は、未登録の依存スキルなら同一プラグインの skills 配下へ取り込み、
  既に別 plugin に属するなら dependencies 宣言＋スキル呼び出しで解く（実体の複製はしない）。
  「url-reader を research plugin に追加して」「既存スキルをプラグインとして公開して」
  「このスキルを marketplace に登録して」「〇〇を /plugin で入れられるようにして」
  「登録済みの 〇〇 を更新して／再公開して」「〇〇 の version を上げて公開し直して」
  などのリクエストで使うこと。登録・更新対象スキル名への言及があれば積極的に使う。
  既存の marketplace.json エントリ・README は壊さない非破壊・冪等が既定（更新時は plugin.json の version を上げ、
  plugin.json と逆 symlink を現状へ再同期する）。
  スキル本体（SKILL.md）の作成・編集は対象外（それは skill-creator-best-practices の役割）。
  marketplace.json の内容閲覧のみ・プラグインのアンインストール・公開済みプラグインの削除も対象外。
---

# マーケットプレイス・プラグイン登録／更新スキル

採用パターン：Orchestrator-Subagent（直列5エージェント）

未登録 plugin なら**登録**、登録済みなら**更新**（既存カテゴリ plugin へのスキル追加を含む）を行う（登録/更新の判定と登録先 plugin の決定は input-resolver が行う）。plugin はカテゴリ単位で複数スキルを収録でき、スキルの公開名（`/plugin:skill` の skill 部分）は frontmatter の `name` が担う（実体ディレクトリ名と異なってよい）。更新時は plugin.json の version を上げ（明示が無ければ patch+1）、plugin.json と逆 symlink を現状へ再同期する。対象スキルが**別スキルを呼び出す連鎖依存**を持つ場合は、未登録の依存スキルなら**同一プラグインへ取り込み**（`skills/<dep>` を追加）、既に別 plugin に属するなら `--depends-on` による `dependencies` 宣言＋スキル呼び出しで解く（実体は複製しない）。

SKILL.md はフロー進行（誰に何を渡すか・分岐・完了条件）のみを担う。確定的処理は `scripts/register_plugin.py`（登録／更新・同梱）・`scripts/check_portability.py`（配布前スキャン）・`scripts/detect_dependencies.py`（依存スキル検出）・`scripts/verify_install.py`（登録後の install 検証）、入力解決は `agents/input-resolver.md`、配布前チェックは `agents/portability-checker.md`、依存解決は `agents/dependency-resolver.md`、登録は `agents/plugin-registrar.md`、登録後検証は `agents/install-verifier.md` が担当する。エージェント間の入出力契約は `references/schemas.md` を唯一の正とする。

## 何のためのスキルか（Why）

`.agents/skills/<name>/` にあるスキルを社内マーケットプレイス（ルートの `.claude-plugin/marketplace.json`）で配布するには、毎回 marketplace.json への追記・プラグインディレクトリ作成・plugin.json/README 生成・スキル実体の移動・検証を手作業で行う必要がある。手作業では既存 plugins 配列の誤上書き・JSON 破壊・重複登録・実体の取り違えが起きやすい。本スキルはこれらを非破壊・冪等なスクリプトに寄せ、**実体を常に1箇所**に保ったまま安全に公開する。

配布サブツリー（`plugins/<plugin>/` 配下）には symlink を置かない。Claude Code は同一 marketplace 内を指す symlink を dereference するが、Codex は plugin サブツリーだけを取得して symlink を落とすため、`skills/` が空のまま install が「成功」してしまう（実測）。そのため公開時にスキル実体を `plugins/` へ移し、リポジトリ内の開発用参照（`.agents/skills/<name>`）を symlink にする向きにしている。

加えて2段階で検証する：(1) **登録前**に対象スキルを静的スキャンし、install 先で壊れる参照（自己参照のリポジトリ固定パス・スキル外の共有スクリプト依存・環境依存）を検出・修正する。(2) **登録後**に、HOME を隔離した環境で**実際に install** してバンドルが展開・認識されるか（L3）まで確認し、必要なら実データでの動作確認（L4）もユーザーに聞いて行う。`claude plugin validate`（構造=L1）止まりにせず「公開したのに install 先で動かない」を実 install で潰す。

## 全体フロー図

```
ユーザーの指示（「〇〇をマーケットプレイスに登録して／更新して」）
  │
  ▼
agents/input-resolver（sonnet）
  │  スキル名の表記ゆれを .claude/skills/ 実ディレクトリ名と照合して解決
  │  SKILL.md 実在確認 / 登録先 plugin（既存追加・新カテゴリ新設・同名新規）の決定
  │  plugin 名と公開名の重複・冗長（chat:chat / notion:notion-* 型）を検出したら
  │  簡潔化候補つきで AskUserQuestion 確認
  │  version・author・description の決定
  │  marketplace.json を plugin 名で照合して登録済みか判定 → 登録済みなら update=true
  │  description が frontmatter に無ければ AskUserQuestion で問い返す
  │
  ├─ status: error（スキル未発見）→ 中断し候補を提示
  │
  ▼  status: ok（mode = register / update）
agents/portability-checker（sonnet）
  │  scripts/check_portability.py で「install 先で壊れる参照」を静的スキャン
  │  検出時はユーザー確認のうえ修正（固定パス→[SKILL_DIR]化／共有script→スキル内へ取り込み）
  │
  ├─ proceed: false（env 依存等で配布不可・ユーザーが中止）→ 中断
  │
  ▼  proceed: true
agents/dependency-resolver（sonnet）
  │  scripts/detect_dependencies.py で「対象が呼ぶ他スキル」を検出（推移的）
  │  実依存（パイプライン呼び出し）だけを同梱対象に。案内・言及は除外
  │
  ├─ bundle_skills（実依存確定）はそのまま同梱。needs_confirmation があるときだけ聞く
  │
  ▼  bundle_skills 確定（空＝同梱なし）
agents/plugin-registrar（sonnet）
  │  scripts/register_plugin.py を実行（--skill <skill> --plugin <plugin>／
  │  update=true なら --update／同梱は --bundle-skill <dep>）
  │  新規=登録 / 既存=更新・スキル追加（version は明示優先、無ければ更新時 patch+1）
  │  未登録の依存は同一プラグインへ取り込み／既登録の依存は --depends-on で宣言
  │
  ├─ exit 2（marketplace.json 破損）  → 中断して手動修正を案内
  ├─ exit 3（SKILL.md 欠落）          → 設置不備として終了
  ├─ exit 4（update=false なのに既存）→ --update を付けて再実行（非破壊。報告に記載）
  │
  ▼  exit 0（added / updated）
agents/install-verifier（sonnet）
  │  scripts/verify_install.py で L2（バンドル解決）＋ L3（HOME 隔離の実 install スモーク）
  │  実ホーム ~/.claude は汚さない／終了時に後始末
  │
  ├─ overall_passed: false → install 先で壊れる可能性として警告・やり直し判断
  │
  ▼  overall_passed: true
【司令塔】L4 動作確認（任意・AskUserQuestion）
  │  「実データで動かすか？」を聞き、必要な入力（例: エントリ script と引数）を受け取って実行
  │
  ▼
  操作内容・検証結果・次アクション（/plugin install）を案内
```

## 実行手順

### ステップ1：input-resolver を呼ぶ

`agents/input-resolver.md` を Read し、以下を埋め込んで Agent ツールを呼ぶ：

- `[USER_INPUT]` → ユーザーの指示テキスト全文

input-resolver は登録対象スキル名の解決・SKILL.md 実在確認・**登録先 plugin（カテゴリ）の決定**・**登録済みか（marketplace.json を plugin 名で照合）による update 判定**・メタ情報（version / author / description）の決定までを行い、`references/schemas.md` の「input-resolver の出力」形式で返す。

- `status: error`（対象スキルが見つからない・存在しない）の場合：ここで中断し、input-resolver が提示した候補スキル名をユーザーに伝えて終了する。後続には進まない。
- `plugin_name`（登録先 plugin）・`update`（plugin 登録済みなら true / 未登録なら false）・`mode`（register / update）も後続に渡す。version はユーザー明示が無ければ空のままで渡してよい（更新時の patch+1・新規時の 0.1.0 は register_plugin.py が決める）。

### ステップ2：portability-checker を呼ぶ

`agents/portability-checker.md` を Read し、以下を埋め込んで Agent ツールを呼ぶ：

- `[SKILL_DIR]` → このスキル（manage-marketplace-plugin）の Base directory 絶対パス（`check_portability.py` の場所）
- `skill_name` → input-resolver の `skill_name`

portability-checker は対象スキルを静的スキャンし、「install 先で壊れる参照」を検出する。検出時はユーザー確認のうえ修正（自己参照の固定パス→`[SKILL_DIR]` 化／スキル外の共有スクリプト→スキル内へ取り込み＋参照修正）を行う。

- `proceed: false`（環境依存等で配布不可、またはユーザーが中止を選択）の場合：ここで中断し、warnings をユーザーに伝えて終了する。登録には進まない。
- `proceed: true` の場合：次のステップへ進む。

### ステップ2.5：dependency-resolver を呼ぶ（連鎖依存の検出・同梱対象の確定）

`agents/dependency-resolver.md` を Read し、以下を埋め込んで Agent ツールを呼ぶ：

- `[SKILL_DIR]` → このスキル（manage-marketplace-plugin）の Base directory 絶対パス（`detect_dependencies.py` の場所）
- `skill_name` → input-resolver の `skill_name`

dependency-resolver は対象スキルが呼び出す他スキル（連鎖依存）を検出し、`references/schemas.md` の「dependency-resolver の出力」形式で `bundle_skills`（実依存と判定した同梱対象）を返す。

- **`bundle_skills`（実依存と確定した分）はそのまま同梱する。確認しない。** `rationale` に呼び出し箇所が挙がっている時点で判断は済んでおり、聞いても答えは毎回同じになる。加えて失敗のコストが非対称：余分に同梱した場合の害は「プラグインにスキルが1つ多い」だけで後から外せるが、実依存を同梱し損ねるとプラグインは install 先で壊れ、しかも壊れたことに気づくのは使った人になる。安全側は同梱する方。
- **`needs_confirmation`（判断に迷った候補）だけをユーザーに聞く（人間介入ポイント）。** ここは分類が付いていないので、聞く価値のある問いが実際に残っている。
- `bundle_skills` と `needs_confirmation` がどちらも空の場合：何も聞かず次のステップへ（同梱なし）。
- **`cross_plugin_dependencies`（既に別 plugin に属する実依存）がある場合**は同梱できない。実体は 1 箇所しか置けず、同梱すると実体のコピーになって drift するため、`register_plugin.py` が exit 4 で止める。この分は次の 3 つで解く：
  1. `plugin-registrar` に `--depends-on <owning_plugin>` を渡し、`.claude-plugin/plugin.json` の `dependencies` に宣言する。
  2. `path_references` に挙がった箇所（相手のファイルの Read・スクリプトの直接実行）を**スキル呼び出し**に書き換える。install 先では相手が別ディレクトリに展開されるため、パス参照は必ず壊れる。ここはユーザー確認のうえ修正する。
  3. 呼び出し側の agent が自分で実行する必要のある手順書だけ、対象スキル自前の `references/` に持たせる。
  書き換え後は `scripts/check_references.py --skill <skill>` で参照が 0 件になることを確認してから登録に進む。
- 同梱した内容と cross-plugin 依存の扱いは最終報告（ステップ6）に必ず載せる。確認を省いた分、何が入ったかは事後に見える形で残す。

### ステップ3：plugin-registrar を呼ぶ

input-resolver の出力（`status: ok`）に、ステップ2.5 で確定した `bundle_skills` と `[SKILL_DIR]`（このスキルの Base directory 絶対パス）を添えて `agents/plugin-registrar.md` の入力に渡して Agent ツールを呼ぶ。受け渡すフィールドは `references/schemas.md` の対応表に従う（`skill_name` / `plugin_name` / `version` / `author` / `description` / `update` / `bundle_skills` / `depends_on`）。`depends_on` は `cross_plugin_dependencies` の `owning_plugin` を重複なく並べたもので、`--depends-on` として渡る。

plugin-registrar は `scripts/register_plugin.py` を実行し、JSON レポートを解釈してユーザーに報告する。実行モードの判断も plugin-registrar の責務：

- `update=true`（input-resolver が登録済みと判定）の場合は `--update` を付けて実行する。これが**更新の正常系**で、register_plugin.py が version を patch+1（ユーザー version 明示時はそれ）に上げ、plugin.json と逆 symlink を現状へ再同期し、レポートの `marketplace_entry: updated` と `version` / `version_bump` を返す。
- `update=false`（未登録）の場合は `--update` なしで実行する。これが**新規登録の正常系**（`marketplace_entry: added` / version 0.1.0）。
- 万一 `update=false` で実行したのに既存だった場合（exit 4）は、`--update` を付けて**そのまま再実行する**。理由：このスキルの契約は「未登録なら登録、登録済みなら更新」であり、既存だったと判明した時点で正しい操作は更新に決まる。`--update` は非破壊（marketplace.json の他エントリを保持し、手書き README を上書きせず、version を patch+1 するだけ）なので、聞いて得られるのは同じ答えだけ。input-resolver の判定とズレていた事実は最終報告に載せる（黙って呑み込まない）。

登録/更新が異常終了（破損 JSON・SKILL.md 欠落・想定外衝突）した場合は、自動修復していない旨と対処方法を伝えて終了する（後続の検証には進まない）。報告では「新規登録」か「更新（version X→Y）」かを明示する。

### ステップ4：install-verifier を呼ぶ（登録後検証 L2＋L3）

`agents/install-verifier.md` を Read し、以下を埋め込んで Agent ツールを呼ぶ：

- `[SKILL_DIR]` → このスキル（manage-marketplace-plugin）の Base directory 絶対パス（`verify_install.py` の場所）
- `plugin_name` → input-resolver の `plugin_name`（`verify_install.py --plugin` に渡す。plugin 内の全スキルを検証する）

install-verifier は `scripts/verify_install.py` を実行し、L2（バンドル解決の読み取り検査）と L3（HOME を隔離した実 install スモーク。実ホームは汚さない）を行う。

- `overall_passed: false` の場合：**登録は install 先で壊れる可能性**。findings をユーザーに提示し、登録のやり直し／取り消しを判断する（このまま「成功」と報告しない）。
- `overall_passed: true` の場合：次のステップへ進む。

### ステップ5：L4 動作確認（任意・司令塔が AskUserQuestion で実施）

実データでの動作確認は入力・認証が対象ごとに異なるため、サブエージェントではなく**司令塔が `AskUserQuestion` で行う**。

1. 「install したスキルを実データで動作確認しますか？」を確認する。不要ならスキップしてステップ6へ。
2. 行う場合、必要な入力をユーザーに聞く。
3. 受け取った入力で、対象スキルのバンドル済みスクリプト（`plugins/<plugin>/skills/<name>/scripts/...` の実体）を実行し、正常終了・妥当な出力を確認する。失敗時は内容をそのまま提示する。

### ステップ6：結果をユーザーに伝える

登録内容（操作・source・実体の移動先）と検証結果（L2/L3、実施したなら L4）、次アクション（`/plugin install`）をまとめて提示する。

## 設計上の不変条件（守るべきルール）

- **非破壊**：marketplace.json の既存 `plugins` 配列要素・他トップレベルキー（name / description / owner）は保持する。既存の plugin.json・README.md は上書きしない。これは他人が登録済みのプラグイン定義や手書き README を壊さないため。
- **冪等**：同じスキルを2回登録しても marketplace.json のエントリは重複せず、既に移動済みのスキルは `relocate: "kept"` になる。再実行は安全（登録済みなら更新として扱われる）。
- **登録済みは更新（破壊しない）**：既に登録済みのスキルは新規登録ではなく更新として扱い、plugin.json の version を上げて plugin.json / 逆 symlink を現状へ再同期する。手書き README は上書きしない。
- **配布サブツリーに symlink を置かない**：`plugins/<plugin>/` 配下は全て実体でなければならない。Claude Code は同一 marketplace 内を指す symlink を dereference するが、Codex は plugin サブツリーだけを取得して symlink を落とすため、`skills/` が空のまま install が「成功」する（実測）。この不変条件が本スキルで最も重要。
- **公開は実体の移動**：登録時にスキル実体を `.agents/skills/<skill>` から `plugins/<plugin>/skills/<skill>` へ移し、`.agents/skills/<skill>` を移動先への相対 symlink に置き換える。開発中は `.agents/skills/` に実体、公開後は `plugins/` に実体、という向きになる。
- **ディレクトリ名は実体名**：公開名（`/plugin:skill` の skill 部分）は frontmatter の `name` が担うため、ディレクトリ名を公開名に変えない。install 先のキャッシュはこのディレクトリ名で作られるため、`[SKILL_DIR]/../<兄弟スキル>/` のようなディレクトリ名参照が名前の変更で壊れる。
- **実在確認の前置**：登録前に対象スキルの `SKILL.md` の実在を確認する。存在しないスキルを登録すると壊れたプラグインが公開されるため。
- **破損は中断**：marketplace.json が壊れた JSON の場合は自動修復せず中断する（他人のエントリを失う恐れがあるため）。不在は新規作成と明確に区別する。
- **本体は単一ソース**：スキル実体は常に 1 箇所。symlink が使えない以上、複数 plugin での共有はコピーになり drift するため、既に別 plugin に属するスキルの同梱は exit 4 で中断する。
- **plugin 間依存は宣言と呼び出しで解く**：別 plugin のスキルが必要な場合は `--depends-on <plugin>` で `.claude-plugin/plugin.json` の `dependencies` に宣言し、呼び出し側はスキル呼び出しを使う（相手のファイルをパス参照しない）。Codex に同等機能は無いため、Codex では依存 plugin を手動 install する前提になる。
- **マニフェストは 2 系統**：`.claude-plugin/plugin.json` と `.codex-plugin/plugin.json` の両方を生成する。`dependencies` は Claude 側だけに書く（Codex 仕様に無く、未知フィールドの許容も明記されていないため）。それ以外のフィールドは一致させる。

## 前提・制約

- **register_plugin.py 前提**：本スキルのファイル操作はすべて `scripts/register_plugin.py` が行う。SKILL.md・agents には具体的なファイルパスや JSON 構造を書かない（スクリプトが唯一の真実）。
- **Unix 系前提**：開発用の逆 symlink（`.agents/skills/<name>`）は macOS / Linux を前提とする。Windows では symlink がテキストファイル化される可能性がある（本スキルの対象外）。なお配布サブツリー側には symlink を作らないため、install 先はこの制約を受けない。
- **version の決定はスクリプトに集約**：新規=`0.1.0`、更新=既存 `plugin.json` の version の patch を +1。ユーザーが version を明示した場合のみそれを優先する（minor/major を上げる判断は人間に委ねる）。非 semver の version は据え置く。
- **過剰実装しない**：author のメール形式・UTF-8 BOM 付き互換・minor/major の自動判定は扱わない。

## ファイル構成

```
.claude/skills/manage-marketplace-plugin/
  SKILL.md                  このファイル（フロー進行）
  agents/
    input-resolver.md       スキル名解決・実在確認・登録/更新判定・メタ情報決定（sonnet）
    portability-checker.md  配布前の静的スキャン・検出時の確認修正（sonnet）
    dependency-resolver.md  連鎖依存スキルの検出・実依存判定・同梱対象確定（sonnet）
    plugin-registrar.md     register_plugin.py 実行・レポート解釈・報告（sonnet）
    install-verifier.md     登録後の install 検証（L2+L3）・結果報告（sonnet）
  references/
    schemas.md              エージェント間入出力契約
  scripts/
    check_portability.py    install 先で壊れる参照の静的スキャン（検出専用）
    detect_dependencies.py  対象が呼ぶ他スキル（連鎖依存）の静的検出（推移的・候補出し）
    register_plugin.py      非破壊マージ／更新・version 解決(patch+1)・実体移動＋逆symlink・2系統manifest生成・依存取り込み・検証・--update / --bundle-skill / --depends-on / --dry-run
    verify_install.py       L2（バンドル解決）＋ L3（HOME 隔離の実 install スモーク）
```
