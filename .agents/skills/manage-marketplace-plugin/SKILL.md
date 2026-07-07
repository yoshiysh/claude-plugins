---
name: manage-marketplace-plugin
description: >
  このリポジトリ内の既存スキル（.claude/skills/ 配下に実体があるもの）を、リポジトリ自身の
  marketplace.json（ルートの .claude-plugin/marketplace.json）にプラグインとして登録・更新・公開するスキル。
  未登録なら新規登録し、登録済みなら更新する（version は明示が無ければ patch を自動インクリメント）。
  marketplace.json への非破壊追記／更新、プラグインディレクトリと plugin.json の生成、README の雛形作成、
  スキル本体への相対 symlink 作成、リンク経由の検証までを自動化する。
  対象スキルが別スキルを呼び出す連鎖依存を持つ場合は、その依存スキルを同一プラグインの skills 配下に同梱する。
  「skill-creator-multi-agent をマーケットプレイスに追加して」「既存スキルをプラグインとして公開して」
  「このスキルを marketplace に登録して」「〇〇を /plugin で入れられるようにして」
  「登録済みの 〇〇 を更新して／再公開して」「〇〇 の version を上げて公開し直して」
  などのリクエストで使うこと。登録・更新対象スキル名への言及があれば積極的に使う。
  既存の marketplace.json エントリ・README は壊さない非破壊・冪等が既定（更新時は plugin.json の version を上げ、
  symlink/plugin.json を現状へ再同期する）。
  スキル本体（SKILL.md）の作成・編集は対象外（それは skill-creator-multi-agent の役割）。
  marketplace.json の内容閲覧のみ・プラグインのアンインストール・公開済みプラグインの削除も対象外。
---

# マーケットプレイス・プラグイン登録／更新スキル

採用パターン：Orchestrator-Subagent（直列5エージェント）

未登録なら**登録**、登録済みなら**更新**を行う（登録/更新の判定は input-resolver が marketplace.json を見て自動で行う）。更新時は plugin.json の version を上げ（明示が無ければ patch+1）、symlink・plugin.json を現状へ再同期する。対象スキルが**別スキルを呼び出す連鎖依存**を持つ場合は、その依存スキルを**同一プラグインに同梱**（`skills/<dep>` を追加）して、install 先で連鎖が切れないようにする。

SKILL.md はフロー進行（誰に何を渡すか・分岐・完了条件）のみを担う。確定的処理は `scripts/register_plugin.py`（登録／更新・同梱）・`scripts/check_portability.py`（配布前スキャン）・`scripts/detect_dependencies.py`（依存スキル検出）・`scripts/verify_install.py`（登録後の install 検証）、入力解決は `agents/input-resolver.md`、配布前チェックは `agents/portability-checker.md`、依存解決は `agents/dependency-resolver.md`、登録は `agents/plugin-registrar.md`、登録後検証は `agents/install-verifier.md` が担当する。エージェント間の入出力契約は `references/schemas.md` を唯一の正とする。

## 何のためのスキルか（Why）

`.claude/skills/<name>/` にあるスキルを社内マーケットプレイス（ルートの `.claude-plugin/marketplace.json`）で配布するには、毎回 marketplace.json への追記・プラグインディレクトリ作成・plugin.json/README 生成・skills への相対 symlink 作成・検証を手作業で行う必要がある。手作業では既存 plugins 配列の誤上書き・JSON 破壊・重複登録・symlink パスの間違い（クローン後に解決できない絶対 symlink）が起きやすい。本スキルはこれらを非破壊・冪等なスクリプトに寄せ、スキル本体は複製せず**相対 symlink で1箇所を唯一の正**に保ったまま安全に公開する。

加えて2段階で検証する：(1) **登録前**に対象スキルを静的スキャンし、install 先で壊れる参照（自己参照のリポジトリ固定パス・スキル外の共有スクリプト依存・環境依存）を検出・修正する。(2) **登録後**に、HOME を隔離した環境で**実際に install** してバンドルが展開・認識されるか（L3）まで確認し、必要なら実データでの動作確認（L4）もユーザーに聞いて行う。`claude plugin validate`（構造=L1）止まりにせず「公開したのに install 先で動かない」を実 install で潰す。

## 全体フロー図

```
ユーザーの指示（「〇〇をマーケットプレイスに登録して／更新して」）
  │
  ▼
agents/input-resolver（sonnet）
  │  スキル名の表記ゆれを .claude/skills/ 実ディレクトリ名と照合して解決
  │  SKILL.md 実在確認 / version・author・description の決定
  │  marketplace.json を見て登録済みか判定 → 登録済みなら update=true
  │  description が frontmatter に無ければ AskUserQuestion で問い返す
  │
  ├─ status: error（スキル未発見）→ 中断し候補を提示
  │
  ▼  status: ok（mode = register / update）
agents/portability-checker（sonnet）
  │  scripts/check_portability.py で「install 先で壊れる参照」を静的スキャン
  │  検出時はユーザー確認のうえ修正（固定パス→[SKILL_DIR]化／共有script→スキル内symlink同梱）
  │
  ├─ proceed: false（env 依存等で配布不可・ユーザーが中止）→ 中断
  │
  ▼  proceed: true
agents/dependency-resolver（sonnet）
  │  scripts/detect_dependencies.py で「対象が呼ぶ他スキル」を検出（推移的）
  │  実依存（パイプライン呼び出し）だけを同梱対象に。案内・言及は除外
  │
  ├─【司令塔】bundle_skills をユーザーに提示し同梱可否を確認（needs_confirmation は必須）
  │
  ▼  bundle_skills 確定（空＝同梱なし）
agents/plugin-registrar（sonnet）
  │  scripts/register_plugin.py を実行（update=true なら --update／同梱は --bundle-skill <dep>）
  │  新規=登録 / 既存=更新（version は明示優先、無ければ更新時 patch+1）
  │  依存は同一プラグインに skills/<dep> として同梱
  │
  ├─ exit 2（marketplace.json 破損）  → 中断して手動修正を案内
  ├─ exit 3（SKILL.md 欠落）          → 設置不備として終了
  ├─ exit 4（update=false なのに既存）→ 想定外。安全側で中止しユーザー確認
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

input-resolver は登録対象スキル名の解決・SKILL.md 実在確認・**登録済みか（marketplace.json 照合）による update 判定**・メタ情報（version / author / description）の決定までを行い、`references/schemas.md` の「input-resolver の出力」形式で返す。

- `status: error`（対象スキルが見つからない・存在しない）の場合：ここで中断し、input-resolver が提示した候補スキル名をユーザーに伝えて終了する。後続には進まない。
- `update`（登録済みなら true / 未登録なら false）と `mode`（register / update）も後続に渡す。version はユーザー明示が無ければ空のままで渡してよい（更新時の patch+1・新規時の 0.1.0 は register_plugin.py が決める）。

### ステップ2：portability-checker を呼ぶ

`agents/portability-checker.md` を Read し、以下を埋め込んで Agent ツールを呼ぶ：

- `[SKILL_DIR]` → このスキル（manage-marketplace-plugin）の Base directory 絶対パス（`check_portability.py` の場所）
- `skill_name` → input-resolver の `skill_name`

portability-checker は対象スキルを静的スキャンし、「install 先で壊れる参照」を検出する。検出時はユーザー確認のうえ修正（自己参照の固定パス→`[SKILL_DIR]` 化／スキル外の共有スクリプト→スキル内 symlink 同梱＋参照修正）を行う。

- `proceed: false`（環境依存等で配布不可、またはユーザーが中止を選択）の場合：ここで中断し、warnings をユーザーに伝えて終了する。登録には進まない。
- `proceed: true` の場合：次のステップへ進む。

### ステップ2.5：dependency-resolver を呼ぶ（連鎖依存の検出・同梱対象の確定）

`agents/dependency-resolver.md` を Read し、以下を埋め込んで Agent ツールを呼ぶ：

- `[SKILL_DIR]` → このスキル（manage-marketplace-plugin）の Base directory 絶対パス（`detect_dependencies.py` の場所）
- `skill_name` → input-resolver の `skill_name`

dependency-resolver は対象スキルが呼び出す他スキル（連鎖依存）を検出し、`references/schemas.md` の「dependency-resolver の出力」形式で `bundle_skills`（実依存と判定した同梱対象）を返す。

- **司令塔は同梱可否をユーザーに確認する（人間介入ポイント）**：`bundle_skills` を「これらの依存スキルも同一プラグインに同梱します」と提示し、`needs_confirmation` があれば必ず可否を聞く。ユーザーが外したスキルは同梱対象から除外する。
- `bundle_skills` が空（依存なし）の場合：そのまま次のステップへ（同梱なし）。
- 確定した同梱対象を `bundle_skills` として plugin-registrar に渡す。

### ステップ3：plugin-registrar を呼ぶ

input-resolver の出力（`status: ok`）に、ステップ2.5 で確定した `bundle_skills` と `[SKILL_DIR]`（このスキルの Base directory 絶対パス）を添えて `agents/plugin-registrar.md` の入力に渡して Agent ツールを呼ぶ。受け渡すフィールドは `references/schemas.md` の対応表に従う（`skill_name` / `version` / `author` / `description` / `update` / `bundle_skills`）。

plugin-registrar は `scripts/register_plugin.py` を実行し、JSON レポートを解釈してユーザーに報告する。実行モードの判断も plugin-registrar の責務：

- `update=true`（input-resolver が登録済みと判定）の場合は `--update` を付けて実行する。これが**更新の正常系**で、register_plugin.py が version を patch+1（ユーザー version 明示時はそれ）に上げ、plugin.json/symlink を現状へ再同期し、レポートの `marketplace_entry: updated` と `version` / `version_bump` を返す。
- `update=false`（未登録）の場合は `--update` なしで実行する。これが**新規登録の正常系**（`marketplace_entry: added` / version 0.1.0）。
- 万一 `update=false` で実行したのに既存だった場合（exit 4）は、input-resolver の判定とズレている異常事態。勝手に上書きせず「既に登録済みのようです。更新しますか？」とユーザーに確認し、同意が得られたら `--update` 付きで再実行する（人間介入ポイント）。

登録/更新が異常終了（破損 JSON・SKILL.md 欠落・想定外衝突）した場合は、自動修復していない旨と対処方法を伝えて終了する（後続の検証には進まない）。報告では「新規登録」か「更新（version X→Y）」かを明示する。

### ステップ4：install-verifier を呼ぶ（登録後検証 L2＋L3）

`agents/install-verifier.md` を Read し、以下を埋め込んで Agent ツールを呼ぶ：

- `[SKILL_DIR]` → このスキル（manage-marketplace-plugin）の Base directory 絶対パス（`verify_install.py` の場所）
- `skill_name` → input-resolver の `skill_name`

install-verifier は `scripts/verify_install.py` を実行し、L2（バンドル解決の読み取り検査）と L3（HOME を隔離した実 install スモーク。実ホームは汚さない）を行う。

- `overall_passed: false` の場合：**登録は install 先で壊れる可能性**。findings をユーザーに提示し、登録のやり直し／取り消しを判断する（このまま「成功」と報告しない）。
- `overall_passed: true` の場合：次のステップへ進む。

### ステップ5：L4 動作確認（任意・司令塔が AskUserQuestion で実施）

実データでの動作確認は入力・認証が対象ごとに異なるため、サブエージェントではなく**司令塔が `AskUserQuestion` で行う**。

1. 「install したスキルを実データで動作確認しますか？」を確認する。不要ならスキップしてステップ6へ。
2. 行う場合、必要な入力をユーザーに聞く。
3. 受け取った入力で、対象スキルのバンドル済みスクリプト（`.claude/skills/<name>/scripts/...` は symlink で実体へ解決される）を実行し、正常終了・妥当な出力を確認する。失敗時は内容をそのまま提示する。

### ステップ6：結果をユーザーに伝える

登録内容（操作・source・symlink）と検証結果（L2/L3、実施したなら L4）、次アクション（`/plugin install`）をまとめて提示する。

## 設計上の不変条件（守るべきルール）

- **非破壊**：marketplace.json の既存 `plugins` 配列要素・他トップレベルキー（name / description / owner）は保持する。既存の plugin.json・README.md は上書きしない。これは他人が登録済みのプラグイン定義や手書き README を壊さないため。
- **冪等**：同じスキルを2回登録しても marketplace.json のエントリは重複せず、symlink は二重化しない。再実行は安全（登録済みなら更新として扱われる）。
- **登録済みは更新（破壊しない）**：既に登録済みのスキルは新規登録ではなく更新として扱い、plugin.json の version を上げて symlink/plugin.json を現状へ再同期する。手書き README は上書きしない。
- **連鎖依存は同梱**：対象スキルが実行時に別スキルを呼ぶ場合、その依存スキルを同一プラグインに `skills/<dep>` として相対 symlink で同梱する（複製しない）。同梱対象は実依存のみ（案内・言及は除外）で、適用前にユーザー確認する。
- **相対 symlink**：`plugins/<name>/skills/<name>` → `../../../.claude/skills/<name>` の相対リンクのみを作る。絶対パス symlink はクローン先で解決できず壊れるため使わない。git では mode 120000 で記録される。
- **実在確認の前置**：登録前に `.claude/skills/<name>/SKILL.md` の実在を確認する。存在しないスキルを登録すると壊れたプラグインが公開されるため。
- **破損は中断**：marketplace.json が壊れた JSON の場合は自動修復せず中断する（他人のエントリを失う恐れがあるため）。不在は新規作成と明確に区別する。
- **本体は単一ソース**：スキル実体は `.claude/skills/` のみ。プラグインディレクトリには複製を置かず、必ず symlink で参照する。

## 前提・制約

- **register_plugin.py 前提**：本スキルのファイル操作はすべて `scripts/register_plugin.py` が行う。SKILL.md・agents には具体的なファイルパスや JSON 構造を書かない（スクリプトが唯一の真実）。
- **Unix 系前提**：相対 symlink は macOS / Linux を前提とする。Windows では symlink がテキストファイル化される可能性があり、その場合はリンクが機能しない（本スキルの対象外）。
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
    register_plugin.py      非破壊マージ／更新・version 解決(patch+1)・symlink 作成・依存同梱・検証・--update / --bundle-skill / --dry-run
    verify_install.py       L2（バンドル解決）＋ L3（HOME 隔離の実 install スモーク）
```
