# スキル一覧 ベストプラクティス監査

対象: `.agents/skills/` 配下の全 12 スキル
基準: `skill-creator-best-practices/references/best-practices.md`（§1–13）
実施日: 2026-07-30

---

## 目次

1. [サマリ](#1-サマリ)
2. [機械検証の結果](#2-機械検証の結果)
3. [チェックリスト適合表](#3-チェックリスト適合表)
4. [個別の指摘](#4-個別の指摘)
5. [Workflow 実行型（§13）の判定](#5-workflow-実行型13-の判定)
6. [リポジトリレベルの指摘](#6-リポジトリレベルの指摘)
7. [対応方針](#7-対応方針)

---

## 1. サマリ

全体としてこのリポジトリのスキル群はベストプラクティスへの適合度が高い。特に

- **Orchestrator の純粋性（§1）**: `chat` / `chat-rigorous` / `search` / `manage-marketplace-plugin` は SKILL.md をフロー制御に限定し、ドメイン知識を `agents/` `references/` に外出しできている。
- **Determinism Split（§5）**: `worktree-sync` / `manage-marketplace-plugin` / `notion-organize-knowledge` / `url-reader` は確定的処理を `scripts/` に寄せている。`worktree-sync` は「なぜ workflow でなくスクリプトか」まで本文に明記している。
- **Generator-Verifier 分離（§3・§11)**: `search`（extractor / verifier / synthesizer）、`manage-marketplace-plugin`（registrar / install-verifier）、`notion-organize-knowledge`（worker / update-verifier）にはある。ただし**状態を変える `commit` / `pr-create` / `url-reader` には無かった**（§4.8。初版で見落としていた項目で、後から検証者を追加した）。
- **SKILL.md 500 行制限（§1）**: 全 12 スキルが適合（最大 306 行 = `skill-creator-best-practices`）。
- **参照ファイルの目次（§1）**: 100 行超の参照ファイル 12 本のうち 11 本に目次あり。

不足は **eval の欠落**、**配布ポータビリティ検出の欠陥**、**状態変更スキルの検証者不在**、**一部 description の [When] 欠落**に集中している。

---

## 2. 機械検証の結果

`quick_validate.py --verbose` を全 12 スキルに実行 → **全て「✅ バリデーション通過」**。

警告の内訳と判定:

| 警告 | 該当 | 判定 |
|---|---|---|
| `description に [When] が含まれていない可能性` | 11 スキル | **大半は誤検出**。判定ロジックが `"?" / "Use when" / "use"` の ASCII 一致（`quick_validate.py:94`）で、日本語 description を評価できない。実際に [When] を欠くのは `commit` と `pr-create` の 2 件のみ |
| `name は gerund 形式を推奨` | chat, commit, dispatch, reference, search | **対応不要**。すべてスラッシュコマンド名として使われており（`/commit` `/search`）、gerund 化は呼び出し体験を悪化させる |
| `agents/analyst.md に model: がありません` | chat-rigorous | **意図的な逸脱**。`SKILL.md:140–150`「モデルポータビリティ」で理由が明記済み（分析品質を instructions で担保するのが設計中核のため、モデルを固定しない） |

その他の機械チェック:

- **Git 衛生**: `__pycache__` / `workspace/runs` はいずれも追跡されていない（`.gitignore` と `workspace/.gitignore` で除外済み）。問題なし。
- **§12 撤去弁明の grep**: 実質的な該当は 1 件のみ（`chat-rigorous/SKILL.md:123`）。他の 2 件は best-practices.md 自身の説明文とガイドの例示で、該当しない。

---

## 3. チェックリスト適合表

| スキル | 行数 | evals | agents | scripts | Orchestrator純粋性 | 主な指摘 |
|---|---:|---:|---:|---:|---|---|
| chat | 248 | 5 | 5 | 1 | ✅ | — |
| chat-rigorous | 165 | 3 | 1 | — | ✅ | §12 撤去弁明 1 件 |
| commit | 104 | ❌ 0 | 1 | — | 該当なし | description に [When] 欠落 / **検証者不在（§4.8）** / MUST・CRITICAL 過多（§11） |
| dispatch | 166 | ❌ 0 | — | 1 | ✅ | typo「スキール」3 箇所 / planner-role.md に目次なし |
| manage-marketplace-plugin | 197 | ❌ 0 | 5 | 4 | ✅ | evals 欠落 / 不要な人間ゲート 2 件（§4.9） |
| notion-organize-knowledge | 127 | 7 | 7 | 5 | △ ※ | repo 固定パス / 禁止事項の羅列（§12 right altitude） |
| pr-create | 54 | ❌ 0 | 1 | — | 該当なし | description に [When] 欠落 / **検証者不在（§4.8）** |
| reference | 68 | ❌ 0 | — | — | 該当なし | `user-invocable: false`。evals 欠落 |
| search | 247 | 4 | 3 | — | ✅ | ループが散文（§13 警察装置シグナル）→ Workflow 化した |
| skill-creator-best-practices | 306 | 3 | 10 | 8 | ✅ | Phase 2–4 が Workflow 候補（§13）→ 抽出した |
| url-reader | 106 | 6 | 1 | 2 | 該当なし | repo 固定パス / **検証者不在（§4.8）** |
| worktree-sync | 163 | ❌ 0 | — | 1 | ✅ | evals 欠落 |

**evals 欠落 6 件**（commit / dispatch / manage-marketplace-plugin / pr-create / reference / worktree-sync）が §6・§10「最低 3 件の評価テストケース」に対する最大の未達。

`commit` / `pr-create` / `url-reader` の agents 列 1 は、本監査で追加した検証者（§4.8）。

※ `notion-organize-knowledge` だけが △ なのは、SKILL.md が「本文・分類のルール」節でドメイン知識（Summary/Source/Notes の必須構成、逐語転記と paraphrase の境界、画像順序の保持）を直接持っているため。§1 ならこれは `agents/page-normalizer.md` 側に属する。`commit` / `pr-create` / `reference` / `url-reader` の「該当なし」は subagent を持たない単体スキルで、Orchestrator 純粋性の評価対象外という意味。

---

## 4. 個別の指摘

### 4.1 配布ポータビリティ（優先度: 高）

`notion-organize-knowledge` と `url-reader` の SKILL.md が、リポジトリ固定の相対パスを直書きしている。

- `notion-organize-knowledge/SKILL.md:88–90` — `WORKSPACE=.agents/skills/...` / `QUEUE=` / `AUDIT=`
- `notion-organize-knowledge/SKILL.md:120` — `.agents/skills/url-reader/references/in-app-browser-fallback.md`（他スキルへのクロス参照）
- `url-reader/SKILL.md:17,27,33` — `python3 .agents/skills/url-reader/scripts/read_url.py`

これは `manage-marketplace-plugin` の `portability-checker` / `check_portability.py` がまさに検出対象としている「install 先で壊れる参照」に該当する。両スキルとも現在 marketplace 未登録なので実害は出ていないが、**登録の前提を満たしていない状態**。

なお `manage-marketplace-plugin` と `skill-creator-best-practices` の `.claude/skills/...` 参照は、いずれも「そのスキルが操作・生成する対象のパス」であって自己参照ではないため、該当しない。

### 4.1b check_portability.py が `.agents/skills/` を検出できない（優先度: 高）

上記 6 件が今まで検出されなかった理由。`check_portability.py:83` の `self_hardcode` 判定が

```python
re_self = re.compile(r"\.claude/skills/" + re.escape(name) + r"/[\w.\-]")
```

と `.claude/skills/` だけを見ており、**このリポジトリのスキル実体パスである `.agents/skills/` を見逃していた**。CLAUDE.md は「スキル実体は `.agents/skills/`、Claude 用は `.claude/skills` symlink」と定めているので、checker の側が旧構成の前提のまま取り残されていた形。

`external_script` 判定（`re_script`）も救えない。negative lookbehind `(?<![\w./\]])scripts/` により、`.agents/skills/url-reader/scripts/read_url.py` のように `/` が直前に来る形は除外されるため。

これは §12「残すべき機械検証（契約・安全そのもの）」に属するゲートが**静かに素通りしていた**ケースで、代理指標の問題ではなく単純な検出漏れ。

**適用済み**: 正規表現を `\.(?:claude|agents)/skills/` に拡張。修正後、url-reader 3 件・notion 3 件を検出。他 10 スキルで新たな誤検出は発生しない（回帰確認済み）。修正後は 12 スキル中 10 スキルが blocker 0 件。

残る 2 件はいずれも本監査のスコープ外の既知の false positive:

- `worktree-sync`（`env_build` 2 件）— `make venv && make install-dev` は `.claude/worktree-sync.json` に**リポジトリ自身が宣言する例**として本文に書かれているもので、スキルが実行するコマンドではない。
- `manage-marketplace-plugin`（`external_script` 19 件）— 自身の `scripts/*.py` をフロー説明の中で名指ししているもの。このスキルの scripts は同名で同梱されている。

### 4.2 description の [What] + [When]（優先度: 中）

`commit` と `pr-create` の description は [What] のみで [When] を欠く。

```
commit:    "Generate intelligent commit messages and execute commits."
pr-create: "Automate intelligent Pull Request creation (Diff analysis, Template filling, Draft mode)."
```

§2「description はスキル発見の唯一の手がかり」および §10「[What] + [When] の両方を含む」に対し、いつ発火すべきか・何が対象外かの情報がゼロ。両者とも marketplace 公開済み。

### 4.3 §11「削る」に該当する指示（優先度: 中）

`commit/SKILL.md` は Claude 5 世代向けとしては規定が過剰。

- `CRITICAL` 4 箇所・`PROHIBITED` 1 箇所・`IMPORTANT` などの大文字強調が本文 104 行に対して密度が高い
- ただし **Step 0 の Authority Check（コミット権限の確認）と「`git add .` を勝手に実行しない」は §11 の「残す」側**（境界ブロック・不可逆操作の scope 制約）に該当する。削ってはいけない。

削る候補は「Why が書かれていない MUST/NEVER」（§3 Why-driven）に限る。`commit` の場合、各 CRITICAL に理由が併記されていないものが対象。

### 4.4 §12 撤去弁明・来歴（優先度: 低）

`chat-rigorous/SKILL.md:123`:

> …（既存の chat-rigorous 初版で実際に発生していた欠落）

§12「撤去弁明・来歴をドキュメントに残さない」に該当。この経緯は commit message に属する情報で、SKILL.md には「`note` を保持して末尾に付記する」という現在の要件だけが残るべき。

### 4.5 存在しないスキルへの参照（優先度: 高）

**リポジトリ外のスキルへの委譲**: `chat` / `chat-rigorous` / `dispatch` が `investment-strategist`（40 箇所）と `magi` / `magi-issue-resolver`（5 箇所）を参照しているが、これらは本リポジトリにも `~/.claude/skills/`（存在しない）にも無い。実体は別リポジトリ `stock-valuation-dcf` の `.agent/skills/` 配下にある。

影響が実在するのは `chat` の投資ルーティング。`chat/agents/investment-topic-router.md:53` が `Skill({skill: "investment-strategist"})` を呼ぶが、**同ファイルの fail-safe は `detect_investment_topic.py` が非 0 終了した場合のみ**を扱っており、スキル自体が存在せず `Skill` 呼び出しが失敗する経路は未定義。`chat` と `dispatch` は marketplace 公開済みなので、インストールした環境で投資トピックを投げると未定義の失敗に落ちる。

`dispatch` / `chat-rigorous` の `magi` 参照は「そちらを使ってください」という案内文と設計上の引用のみで、実行経路には乗らない（影響は誘導先が存在しないことに留まる）。

**適用済み**: `pr-create/SKILL.md:52` の「use the `git` skill's `fix` subcommand」を削除。`git` という名前のスキルはリポジトリにもセッションのスキル一覧にも存在せず、しかも frontmatter に新たに書いた「既存 PR の更新・レビューは対象外」と矛盾する誘導だったため。

### 4.6 軽微

- `dispatch/SKILL.md` — 「本スキール」の typo 3 箇所（19, 84, 149 行付近）
- `dispatch/references/planner-role.md` — 103 行あるが目次なし（§1「100 行超の参照ファイルには目次」）
- `notion-organize-knowledge/SKILL.md` — 「〜してはいけない」形の禁止列挙が多く、§12 の right altitude としては over-specification 寄り。ただし §4.7 参照。

### 4.7 notion-organize-knowledge の「警察装置」シグナル（§13）

`scripts/validate_run_audit.py`（preflight / progress / final の 3 フェーズ監査）と、SKILL.md 本文の「〜と説明・記録してはいけない」「予定・候補・shell のバックグラウンド起動だけで lease を取得してはいけない」といった compliance theater 検査は、§13 が名指しする **「この種の監視コードを書き始めたら、ループ自体を script に移すべきサイン」** そのもの。

**しかし Workflow 化は現状ブロックされている**（§5 参照）。シグナルは実在するが、対処は Workflow 変換ではない。

---

### 4.8 Generator-Verifier 分離の欠落（優先度: 高）

**本監査の初版が見落としていた項目**。§1 サマリで `search` / `manage-marketplace-plugin` /
`notion-organize-knowledge` の分離を「徹底されている」と評価したが、**残る 9 スキルを確認して
いなかった**。確認したところ、状態を変える 3 スキルに分離が無い。

| スキル | 生成するもの | 検証者 |
|---|---|---|
| `commit` | コミットメッセージ | 無し（同じ agent が書いてコミットする） |
| `pr-create` | PR タイトル・本文 | 無し（同じ agent が書いて PR を作る） |
| `url-reader` | `reader_status` | 無し（抽出した run が自己申告する） |

§3「Generator と Verifier は別エージェント（自分の出力を自分で検証しない）」、§10 チェック
リスト「Generator と Verifier が別エージェントになっている」、§11 の残す欄「fresh-context の
verifier subagent は self-critique を上回る」——いずれにも反する。

**Workflow 化とは別の話**。verifier は fresh context の `agent()` 1 回であって script は要らない
（`chat` は Workflow なしで複数 agent を回している）。§5 で shell 制約を理由に Workflow を
見送ったことと、検証者を置かないことは無関係だった。

**適用済み**（いずれも状態変更の**前**に置いた。事後検証では既に起きた変更を報告するだけになる）:

- `commit/agents/message-verifier.md` — `git diff --staged` を自分で読み、type / description /
  breaking change を照合。`mismatch` ならコミットせず修正案を提示。`diff_summary` を必須に
  して「diff を読まずに ok を返す」経路を塞いだ
- `pr-create/agents/body-verifier.md` — diff を自分で読み、捏造された主張（「検証した」の
  裏付けが無い等）・欠落した変更・未記入のテンプレート節を検出。PR は作成時にレビュアーへ
  通知が飛ぶため、事後の修正は最初の版を読んだ人に届かない
- `url-reader/agents/extraction-verifier.md` — payload に対して `reader_status` が過大申告に
  なっていないか判定（`Extracted` なのに `markdown` が空、ログインページの資産を
  `ImagesOnly` と数えている、`browser_fallback.required` を terminal 扱いしている等）。
  下流の `notion-organize-knowledge` がこの status で登録可否を決めるため 3 つの中で影響が最大

**実走結果**: 3 件を「不一致を捕まえるか」「正しい出力を誤って止めないか」の両方向で実行した（6/6 期待どおり）。

| 検証者 | 捕捉ケース | 誤検出ケース |
|---|---|---|
| `message-verifier` | 挙動追加 + 非互換シグネチャ変更に `chore:` を付けた staged diff → `mismatch`（type / description / breaking change の 3 点すべて指摘） | README への節追加に `docs:` → `ok` |
| `body-verifier` | 捏造入り本文 → `mismatch`（存在しない `tests/test_workflows.py`・未実施の実走主張・収束ラウンド数を検出） | 本監査ブランチの実際の PR 本文 → `ok`（捏造なし） |
| `extraction-verifier` | ログインウォール本文を `Extracted` と申告 → `overstated`（実態 `Blocked`）+ `fallback_pending: true` | oEmbed の `Partial` 申告 → `consistent` |

想定を超えた挙動が 2 件あった。`message-verifier` は仕込んでいなかった不具合を挙げた——
`timeout=5` を機械的に `timeout_ms=5` へ置換すると 5 秒が 5 ミリ秒に静かに変わり、かつ既定値だけは
`30000/1000 == 30` で等価なので既定のまま使う呼び出しでは気づけない、という指摘。`body-verifier` は
捏造版に対し、同じ diff に含まれる `skills-audit.md` §7 の未対応記載を反証として使い、さらに
「残した課題」節が矛盾する 2 項目（B・G）だけを落としていることを検出した。

`diff_summary` / `evidence` の必須化も機能した。6 件すべてで、実際に読んだ diff・payload の内容が
具体的な引用つきで返っており、読まずに判定した形跡は無い。

**副次的な収穫**: 実際の PR 本文に対する `body-verifier` の実行が、本文側の実不備を 3 件検出した
（節番号の 3 → 5 の飛び、`commit` の Preview / Dry run セマンティクス変更の未記載、
`orchestrator-output.md` に増えた Phase 5 の分岐の未記載）。いずれも PR 本文に反映済み。

### 4.9 manage-marketplace-plugin の不要な人間ゲート（優先度: 中）

人間ゲートが 5 箇所あり、§13 の「設計された人間ゲートが途中に多いタスクは Coordinator 駆動の
ままにする」に該当していたが、**5 箇所すべてが必要だったわけではなかった**。中身を確かめると
2 箇所は「聞いても答えが毎回同じ」もので、ゲートの数が判定を歪めていた。

| ゲート | 判定 | 根拠 |
|---|---|---|
| 依存同梱の可否（SKILL.md:121） | **自動化した** | `dependency-resolver` の契約は既に `bundle_skills`（実依存確定・`rationale` に呼び出し箇所あり）と `needs_confirmation`（分類不能）を分けている。前者まで聞いていた。失敗コストも非対称で、余分な同梱は後から外せるが同梱漏れは install 先で壊れる |
| exit 4 の衝突確認（133） | **自動化した** | スキルの契約が「未登録なら登録、登録済みなら更新」である以上、既存と判明した時点で正しい操作は決まる。`--update` は非破壊（他エントリ保持・手書き README 保持・version patch+1）。ズレた事実は報告に残す |
| description の問い返し（44） | 残す | ユーザーにしか書けない**入力**であって判断ではない |
| ポータビリティ修正の確認（107） | 残す | **他スキルのファイル**を書き換える状態変更 |
| L4 動作確認（151） | 残す | テストデータ・認証がユーザー側にある |

**Workflow 化はしていない**。ゲートを 2 つ外しても残る区間（dependency-resolve → register →
install-verify）は python スクリプトを 1 本ずつ叩く直列 3 agent で、fan-out もループも無い。
script は shell を持たないので、コマンド 1 本ごとに agent を挟むだけになり §5 の
`commit` / `pr-create` と同じ損になる。生成と検証（`plugin-registrar` と `install-verifier`）は
既に別 agent なので、そこは元から満たしている。

### 4.10 §4.8 の見落としを招いた基準側の欠陥（優先度: 高）

§4.8（状態変更スキルの検証者不在）は本監査の初版が見落とした項目だが、原因を追うと
**基準を提供する `skill-creator-best-practices` 側にも 3 つの欠陥があった**。同じ見落としが
このスキルを使う次のスキル作成でも起きる。

**欠陥1: 同一スキル内で 2 つの基準リストが食い違っていた**

`best-practices.md` §10 の「基本品質」（全スキル対象）には
「フィードバックループ（検証→修正）が設計されている」があるのに、基準生成 agent が実際に
参照する `criteria-by-task.md` の「全タスク種別共通」には無く、「workflow 系」にだけあった。
document / data と分類されたスキルにはこの観点が一度も現れない。

**欠陥2: 問おうとしている問いを、条件が先に答えていた**

§10 の「Generator と Verifier が別エージェントになっている」は
`### マルチエージェント設計（該当する場合）` の下にあった。この条件は**構造**（`agents/` が
あるか）で切っているが、検証者の要否は**機能**（状態を変えるか・出力が下流で行動の根拠に
なるか）で決まる。結果、agent を持たないスキルは「該当しない」に落ち、**検証者が無いという
状態そのものが、その項目の適用対象から自分を外していた**。

**欠陥3: `quick_validate.py` が沈黙で通していた**

`agents_dir.exists()` が偽なら agent 関連の検査を丸ごと飛ばす（`quick_validate.py:104`）。
全 12 スキルで ✅ が出るため、機械検査の通過が全項目の合格に見える偽の底ができていた。

**適用済み**（§12「制約は失敗から育てる。足すときは『どの実失敗を防ぐか』を根拠にする」に
該当する。実失敗が観測されたのが今回）:

- `best-practices.md` §10 に**適用範囲の決め方**を明記（「各項目がどのスキルに当てはまるかは
  そのスキルが何をするかで決める。既にある構造で決めない」）
- §10 基本品質に「生成物を、生成した agent 以外が検証する経路がある」「検証が状態変更の前に
  置かれている」を追加。`agents/` の有無で判定しないこと、単体スキルで検証者が 1 つも無い
  状態こそが不合格であることを項目内に明記
- 「マルチエージェント設計（該当する場合）」を「（既に複数 agent を持つ場合）」に改題し、
  「ここが該当しないことを検証者不要の根拠にしない」と注記
- `criteria-by-task.md` の「全タスク種別共通」に同じ 2 項目を追加（欠陥1 の解消）
- `quick_validate.py` に `SKIP:` 出力を追加。判定できない項目（検証者の要否・description の
  実発火・参照ファイルの整合）を毎回列挙し、`agents/` 不在時はその旨も出す

**`quick_validate.py` で検証者の有無を判定しない理由**: 要否がスキルの機能に依存するため、
機械判定にすると `reference`（検証すべき出力を持たない指針文書）のようなスキルに誤検出する。
§12 の「代理指標を検証ゲートにしない」に該当するので、判定せず「見ていない」と申告する形に
した。

---

## 5. Workflow 実行型（§13）の判定

§13 の選択基準のうち決定的なのは **「実行中のユーザー入力は不可。設計された人間ゲートが途中に多いタスクは Coordinator 駆動のままにする」**。fan-out の有無ではなく、この制約を各スキルに当てて判定した。

| スキル | fan-out | 人間ゲート | 判定 |
|---|---|---|---|
| **dispatch** | あり | Step 0 のみ（Workflow 起動前） | **✅ 既に Workflow 型**（`scripts/orchestrate.js`）。best-practices.md §13 がリポジトリ内の参照実装として名指ししている。変更不要 |
| **search** | あり（claim ごと並列） | Step 0 の明確化質問のみ（ループ前） | **✅ Workflow 化した**（`scripts/investigate.js`）。下記参照 |
| **skill-creator-best-practices** | あり（6 並列 + 3 並列） | Phase 1（ペルソナ承認）・Phase 5（保存承認） | **✅ Phase 2–4 を Workflow 化した**（`scripts/build_skill.js`）。下記参照 |
| **notion-organize-knowledge** | あり（論理 worker 4） | 途中に多数 | **❌ 変換不可**。下記参照 |
| chat / chat-rigorous | なし（直列 2–5 agent） | なし | ❌ 対象外。fan-out していない |
| commit / pr-create / reference / worktree-sync / url-reader / manage-marketplace-plugin | なし | manage-marketplace-plugin は 3 箇所 | ❌ 対象外 |

### 5.1 search — Workflow 化した（`scripts/investigate.js`）

`claim-extractor → source-verifier（claim ごと並列）→ root-cause-synthesizer` の bounded loop は
best-practices.md §13 が参照実装として名指しする `/deep-research`（fan-out 検索 → ソース相互検証 →
主張ごとに投票 → 検証を生き残らなかった主張を除外）とほぼ同型で、§13 の選択基準
「相互検証つき調査」「品質パターンを構造として強制したい」に正面から該当する。

決定的なのは**警察装置シグナル**（§13）。変換前の SKILL.md には監視機構が散文で 4 種そろっていた:

| 変換前の散文（警察装置） | §13 の分類 |
|---|---|
| 「どの claim も検証されないまま最終レポートに混入させない」 | 記録漏れ検知 |
| 「添え物の検証省略を構造的に防ぐ」（synthesizer が未検証主張を見つけたら next_question を必ず立てる） | compliance theater 検査 |
| 「進捗ガード：新規 verified 0 件かつ next_question が実質同一なら打ち切り」 | skip 検出 |
| 「round は最大 5」 | ループ暴走の監視 |

§13 は「この種の監視コードを書き始めたら、ループ自体を script に移すべきサイン——Workflow 化すれば
スキップも bypass も構造的に不可能になり、監視装置ごと削除できる」と明示している。

**適用した構造**（`scripts/investigate.js`）:

| 保証 | 実現方法 | 削除できた散文 |
|---|---|---|
| 抽出された claim は必ず検証を通る | script が `claims[]` を走査して claim ごとに verifier を spawn | 「混入させない」「添え物の検証省略を構造的に防ぐ」（`root-cause-synthesizer.md` §差し戻し判定からも削除） |
| 同一 claim を再検証しない | 正規化した主張文をキーに `seen` で除外 | — |
| ループが暴走しない | `round < maxRounds` の `while` | 「round は最大 5」 |
| 進捗のないループを切る | (a) 新規 verified 0 件 かつ (b) `same_question_as_previous` | 進捗ガードの散文 |
| 検証 agent が落ちても捏造しない | 結果を返さなかった claim を `cannot-verify` として積む | （新規の保証） |
| 打ち切り時に本筋が残る | `priority` 順に並べてから spawn | 「priority 順に上位を先に verify」 |
| 達成度を良く見せない | `termination_reason` に既定値を持たせず、break した理由からのみ決める | — |

**進捗ガードの条件(b) の扱い**: 「next_question が前ラウンドと実質同一」は言い換えを含む意味判断
なので、script 側の文字列比較にはしなかった（§12 の代理指標になり、言い換えただけの同一問いが
素通りして収束しなくなる）。synthesizer の出力に `same_question_as_previous`（boolean）を追加し、
**判断は agent・分岐は script** という §13 の分担原則に合わせた。契約は
`schemas/agent-contracts.md` §root-cause-synthesizer に反映済み。

**Workflow に入れなかった経路**: Step 0（空入力・曖昧な問いへの明確化質問）、Step 0.5（委譲ヘッダ
検出）、Step 1（調査+実行の混在判定）は SKILL.md に残した。Step 0 は設計された人間ゲートで、
§13 の制約（実行中のユーザー入力は不可）に抵触する。Step 0.5 の委譲は呼び出し元スキルへの
同期的な request/response であり、バックグラウンド実行される Workflow に載せると応答の形と
待ち方が変わるため、`source-verifier` を直接 spawn する形のまま残した。

### 5.1b 実走結果（`investigate.js`）

実タスク（§6.2 の CLAUDE.md の記述が現状と一致するかの調査）を 1 本通した。

| 指標 | 結果 |
|---|---|
| ラウンド | r1（12 claim）→ r2（6）→ r3（16）→ **自然収束** |
| 終了理由 | `converged`（打ち切りではない） |
| 重複検証 | **0 件**（`seen` による除外が機能） |
| verdict | verified 33 / refuted 1 / cannot-verify 0 |
| agent | 40 件、エラー 0 |

設計時の構造的保証が実データで確認できた点:

- **`seen` による重複除外**: 3 ラウンドで 34 claim を検証し、同一主張の再検証が 0 件
- **反証義務**: refuted 1 件は**ワークフロー自身が前ラウンドで立てた主張**で、反証したうえで「本レポートの root_cause と inferences はこの claim に依存しないため結論を変えない」と明記していた
- **`next_question` による継続と収束**: r1・r2 で問いが立ち、r3 で `null` になって停止。進捗ガード（`same_question_as_previous`）は発火せず、収束経路で終わった

結論の質も監査者（人間側）を上回った。監査の初版は「Makefile が無い」という CLAUDE.md の記述を検証せず引き写していたが、ワークフローは**記述が執筆時点では真で、無関係な 2 コミットで二段階に偽になった**ことまで特定した（§6.2 の表）。

**未確認**: 進捗ガードの停止経路（`stalled`）と `cannot-verify` の蓄積経路は、この run では通っていない。収束したため。

### 5.2 skill-creator-best-practices — Phase 2–4 を Workflow 化した（`scripts/build_skill.js`）

Phase 2 → 2.5 → 3 → 4 は「fan-out → 集約 → 閾値判定 → 条件付き再実行」の連なりで、途中に人間の
判断が要らない。散文では「同一ターンで6エージェント同時起動」「delta を集計して 0.2 未満なら改稿」
と書かれていたが、実行者がまとめ忘れる・閾値を目分量で判断する余地が残っていた。

**適用した構造**:

| 保証 | 実現方法 |
|---|---|
| with_skill と baseline が必ず対で走る | 全テストケース分を 1 つの `parallel()` にまとめて発行 |
| pass_rate と delta が正確 | 集計は script の算術（LLM に平均を出させない。§5） |
| 閾値判定がぶれない | `delta >= 0.2 && reviewer.failed.length === 0` |
| 改稿が無限に続かない | `revision >= maxRevisions`（既定 1）で打ち切り |
| 構成の差し戻しが止まる | designer → reviewer を最大 2 回。未解決は `structure.unresolved` で返す |
| テストが改稿を跨いで同一 | テストケース生成をループの外に置き、pass_rate の変化が改善だけを反映する |
| 出力欠損を成績に混ぜない | 片側が欠けたペアは採点に回さず `ungraded_cases` として数える |

**変換中に見つかった既存の契約ギャップ 2 件**（いずれも script 側で解消）:

1. `tester.md` の出力形式はプロンプト 3 本のみだが、`grader.md` は assertions を必要とする
   （SKILL.md の `[TEST_CASE]` は「プロンプト + assertions」）。schema で assertions を必須にして塞いだ。
2. `reviewer.md` / `structure-reviewer.md` は自由記述の markdown に ✅/⚠️/❌ を書く形式で、
   合否を判定するには script が絵文字を数えることになる（§12 の代理指標ゲート）。schema で
   `failed[]` を返させ、script はそのフィールドだけを見るようにした。

**人間ゲートは Coordinator に残した**: Phase 1（ペルソナ承認）と Phase 5（保存承認）。
Workflow が返す `verdict: needs_human_decision`（改稿上限に達しても閾値に届かなかった）は
失敗の宣告ではなく、要件・基準まで遡るかを人間が決めるための報告として Phase 5 に渡る。

**agentType を渡していない点**: `agents/*.md` の frontmatter には `subagent_type`
（analyzer / architect / qa / reviewer）が書かれているが、これらは Agent ツールのレジストリに
登録された型ではなく、指定すると解決に失敗する。役割はプロンプト本文が担っているため、
`model` だけを渡して既定の subagent で実行している。

### 5.2b 実走で判明した重大な欠陥（`build_skill.js`）— 修正済み・再検証は未了

実タスク（全スキルに検証スクリプトを一括実行するスキルの生成）を流したところ、**評価フェーズの
agent がリポジトリを書き換えた**ため途中で停止させた。

| 起きたこと | 影響 |
|---|---|
| `.agents/skills/validate-skills/`（10 ファイル）を新規作成 | 未追跡。セッションにスキルとして登録され、意図せず発火しうる状態になった |
| `quick_validate.py` を 80 行追加で改変 | **追跡ファイル**。PR 進行中のブランチ上で、著者もレビューも経ていない変更が混入した |

**原因**: `with_skill` の評価 agent へ渡すプロンプトに**境界ブロックが無かった**。「このスキル定義が
システムプロンプトに含まれているものとして振る舞え」とだけ指示していたため、定義が
`scripts/run_validation.py` を呼ぶと書いてあるのを見た agent が、**そのスクリプトを実際に作って
実行した**（journal に `run_validation.py --skill dispatch-helper` の実行記録がある）。

これは本監査 §11 で「残す側」に分類した「境界ブロック（頼まれていない行動を取ることがある）」
そのものであり、その原則を自分のスクリプトに適用し損ねていた。

**害は書き込みだけではない**。不足を自力で補った `with_skill` は baseline に勝つが、それは
スキル定義の質ではなく **agent の補完能力**を測っている。delta が測定対象を取り違える。

**適用済み**: 評価 agent のプロンプトに境界ブロックを追加した（ファイルの作成・編集・削除を禁止、
定義が参照する未作成のスクリプトを作らない、実行できない場合は記述で答える、読み取り専用の調査は
許可）。理由も併記している — 評価対象は「定義がどれだけ的確に振る舞いを導くか」であって
「不足を自力で補える agent かどうか」ではない、という Why。

**後始末**: `quick_validate.py` は `git checkout` で復旧。生成された `validate-skills/` は
scratchpad へ退避した（削除ではなく移動。差分は `unauthorized-quick_validate.patch` に保全）。
追跡ファイルへの他の変更は無く、既存スキルは壊れていない。

**この題材選定自体も誤りだった**: 生成対象とした「全スキルに検証スクリプトを一括実行するスキル」は、
`Makefile` の `make test` が既に大半をカバーしていた。要件を書く前にそれを確認していなかった
（§6.2 と同じ、一次情報に当たらずに前提を書いた失敗）。実際に必要だったのは Makefile の数行修正で、
agent 4 本 + スクリプトを持つスキルではない。

### 5.2c 再実行の結果（`build_skill.js`）— 評価ループは動作、失敗時の判定に別バグ

境界ブロック修正後に別の題材（`quick_validate.py` が SKIP: と申告する 4 項目を実際にレビューする
スキル）で再実行した。

**確認できたこと**:

| 検証したい点 | 結果 |
|---|---|
| 意図しない書き込みが起きないか | **ゼロ**。作業ツリー監視を張ったまま完走し、追跡・未追跡とも変更なし。境界ブロックは機能した |
| Grade / Analyze に到達するか | 到達。rev0 で with_skill 1.00 / baseline 0.38 / **delta 0.617** を算出 |
| 閾値判定が働くか | 働いた。delta は閾値を超えたが reviewer の失格が 8 件あり `passed: false`。`delta >= 0.2 && failed.length === 0` の後段で落ちている |
| 改稿ループが回るか | 回った。`revision_used: 1`、writer(revise) が実行され rev1 に進んだ |
| 上限で止まるか | 止まった。`needs_human_decision` で返り、草稿は保持された |

rev0 の grading 内訳は `1.00/0.90`（delta 0.10）、`1.00/0.25`（0.75）、`1.00/0.00`（1.00）で、
テストケースごとに差が出ている。reviewer の失格 8 件も「非該当に file:line を要求していない」
「自己参照時の挙動が未定義」など具体的な設計指摘だった。評価機構としては意図どおり動いている。

**発見した別のバグ（修正済み）**: rev1 で採点 agent 3 件と reviewer が環境側の理由（session
limit）で全滅した際、スクリプトは **0 件の結果から `delta = 0` を算出し、`review: null` を
「失格 0 件」と読んだ**。今回は `delta 0 < 0.2` で安全側に落ちたが、危険な経路が実在する:

```
3 件中 2 件が落ち、1 件だけ delta 0.9 を返す → mean([0.9]) = 0.9 ≥ 0.2
reviewer も落ちる → review?.failed || [] は [] → 失格 0 件
⇒ passed = true（証拠 1/3、レビューなし）
```

これは監査自身が掲げた「達成度を実態より良く見せない」に反する。`investigate.js` では
`termination_reason` に既定値を持たせない形で同じ失敗を避けていたのに、`build_skill.js` の
合否計算には適用していなかった。

**適用した修正**:

- `evaluationComplete = ungraded === 0 && !!review` を合否の必要条件に追加
- 1 件も採点できなかったときの `delta` を `0` ではなく `null` に（`0` は実測の引き分けを
  意味する値なので、欠測をそこに丸めない）
- 評価が揃っていない場合は改稿せず `evaluation_incomplete` で返す（何を直すべきかの根拠が
  無いまま writer を回さない）。品質不足の `needs_human_decision` と区別する
- 判定ロジックを今回の実データ 4 パターンで再現テストし、危険ケースが `passed: false` に
  なることを確認

**未検証のまま残るもの**: `taskType: workflow` で実行したため Structure フェーズ
（designer → reviewer の until-pass ループ）は通っていない。コードパスを通すために種別を
偽ると測定が歪むので、正直な種別を選んだ結果として残した。

### 5.2d 3 回目の実走（`taskType: document`）— Structure は通り、境界の片側漏れが露見

未検証だった Structure フェーズを通すため `taskType: document` で実行した（題材: 公開済み
8 プラグインの README が全て同一の 25 行雛形のまま放置されている問題）。

**Structure フェーズは動作した**。journal 上で `structure-designer` が構成案を返し、
`structure-reviewer` が `STRUCTURE_REVIEW_SCHEMA` に沿って
`{checks: [{name: "A. 要件との整合性", result: "warn", rationale: ...}]}` を返している。
schema による構造化判定（markdown 中の ✅/❌ を数えない形）が実データで機能した。

ただし `result` は `warn` であり `fail` は 0 件だったため、`failed[]` が空になり 1 回目で
ループを抜けた。**❌ が出たときの差し戻し・再設計と `MAX_STRUCTURE_ATTEMPTS` による打ち切りは
まだ通っていない。**

**露見した別のバグ（修正済み）**: 実行中、監視が `plugins/dispatch/README.md`（追跡ファイル）の
書き換えを**リアルタイムで捕捉**したため停止させた。原因は、前回追加した境界ブロックを
**`with_skill` 側にしか入れていなかった**こと。`baseline` は素のプロンプトのまま全ツールを
持つため、「README が雛形のままなので直して」というテストプロンプトを額面どおり実行した。
journal の該当 agent は「`plugins/dispatch/README.md` を書き換えました」と明示的に報告している。

スキル定義を渡されない `baseline` の方がむしろ歯止めが無い、という非対称性を見落としていた。

**なぜ前回の実行では出なかったか**: 前回の題材（既存スキルの設計レビュー）は本質的に
読み取り専用で、テストプロンプトが変更を求めなかった。今回の題材は「README を直して」と
書き換えを求めるため、境界の欠落が初めて表面化した。**題材の性質が異なる 2 本を通して
初めて出た欠陥**であり、1 本の実走では見つからなかった。

**適用した修正**: 境界ブロックを `EVAL_BOUNDARY` 定数として抽出し、`with_skill` と `baseline`
の両方に適用した。文面も「スキル定義の実装ではない」から「依頼の遂行ではない。変更を求められても
適用せず、こう変更するという内容を回答として書く」に一般化している。定数の直上に、片側だけに
付けた場合に何が起きたかを実失敗として記録した。

**検出の改善**: 1 回目は書き込みに 20 分以上気づかなかったが、今回は作業ツリー監視を張って
いたため最初の 1 ファイル目で検出・停止できた。被害は 1 ファイルに留まり、差分を保全したうえで
復旧済み。

**あわせて気づいた点（未対応）**: `writer` agent がこの run では成果物を scratchpad に
書き出し、戻り値を「4 つのファイルを書いた」という報告にしていた。リポジトリ外なので実害は
無いが、`skill_draft` が SKILL.md 本文ではなくポインタになると、後段の
`extractFrontmatter` と評価 agent に定義が渡らない。前回の run では本文が返っていたため
挙動が安定していない。

### 5.3 notion-organize-knowledge — シグナルは実在するが変換不可

§13 の警察装置シグナルは強く出ている（§4.7）。しかし Workflow script には次の制約がある（Workflow ツール仕様）:

- **ファイルシステム / Node API へのアクセス不可**
- **`Date.now()` / `new Date()` / `Math.random()` が throw する**（resume 機構を壊すため）

`queue.py` の中核は「durable state を `workspace/runs/<timestamp>-<hash>/` に書く」「lease の期限を時刻で管理する」「heartbeat で延長する」であり、これらは上記制約に真正面から衝突する。resume 可能性そのものが `workspace/` のファイル状態に依存している。

→ **結論: シグナルは正しいが、Workflow への変換は現行の Workflow ツールでは不可能**。現状の「Python が control plane、AI/MCP が execution plane」という 3 層分離は、この制約下では妥当な設計。監視コードは残さざるを得ない。

---

## 6. リポジトリレベルの指摘

### 6.1 CLAUDE.md の「収録スキル」表が実態と乖離（優先度: 高）

CLAUDE.md は 2 スキル（`skill-creator-best-practices` / `manage-marketplace-plugin`）しか記載していないが、実際には 12 スキルが存在する。CLAUDE.md はセッションごとに読み込まれる指示であり、最も目に触れる場所が最も古い。

### 6.2 CLAUDE.md の「検証」節が二重に古くなっていた（優先度: 中）

CLAUDE.md 89 行目は「`.claude/settings.json` と `.codex/hooks.json` には `make test` hook があるが、このリポジトリには現在 `Makefile` がない」と記載していた。**本監査の初版はこの記述を検証せずそのまま引き写した**（§4.10 と同じく、走査で済ませて一次情報に当たらなかった失敗）。

`search` スキルの Workflow（`investigate.js`）を実走させてこの記述を調査させたところ、**執筆時点では真だったものが、無関係な 2 コミットで二段階に偽になっていた**ことが判明した。

| 時点 | 出来事 | 記述への影響 |
|---|---|---|
| 2026-07-07 `c395a26` | CLAUDE.md 追加。当時 `settings.json` にも `make test` の PostToolUse hook が実在し、Makefile は未追加 | 前段・後段とも真 |
| 2026-07-08 `9701486a` | `settings.json` から `make test` hook ブロックのみ削除 | **前段が偽に** |
| 2026-07-10 `a75982e` | Makefile を追加 | **後段も偽に** |

以後 2026-07-31 の CLAUDE.md 大規模書き換えを含め、89 行目は blame 上 `c395a26` のまま一度も更新されていなかった。

要点は自分でも一次情報で再確認した — `.claude/settings.json` に `make` の出現は 0 件（hook は Notification / Stop のみ）、`.codex/hooks.json` は PostToolUse（matcher `Edit|Write|MultiEdit`）で `make test` を呼ぶ、`Makefile` は追跡済みで `make test` は exit 0。

**適用済み**: CLAUDE.md の検証節を現状に合わせて書き直し、`Makefile` を検証の入口として明記した。あわせて Makefile 自体の 2 つの穴も塞いだ。

- スキル一覧が 12 個ハードコードされており、13 個目が静かに漏れる状態だった（`investigate.js` の F12 が検出）→ `$(wildcard $(SKILLS_DIR)/*/)` から毎回導出する形に変更。一時的な probe スキルを置いて自動で拾われることを確認済み
- `check_portability` が `make` から呼ばれていなかった → `portability` ターゲットを追加。ただし合否ゲートにはしない（同スクリプトは blocker 検出時も exit 0 を返し、かつ既知 false positive が 2 件あるため恒常的に失敗する）。`check` で両方まとめて実行できる

### 6.3 marketplace 未登録の 3 スキル

`manage-marketplace-plugin` / `notion-organize-knowledge` / `url-reader` が未登録。

- `manage-marketplace-plugin` は marketplace そのものを管理するスキルで、リポジトリ固有の前提（`.claude-plugin/marketplace.json` の存在）に依存するため、**未登録が正しい**可能性が高い。
- `notion-organize-knowledge` / `url-reader` は §4.1 のポータビリティ問題を解消すれば登録可能。ただし登録するか否かは公開意図の問題であり、監査で決める事項ではない。

---

## 7. 対応方針

### 適用済み

| # | 内容 | 根拠 | 対象 |
|---|---|---|---|
| 1 | `check_portability.py` の `self_hardcode` 検出を `.agents/skills/` にも拡張 | §4.1b | `manage-marketplace-plugin/scripts/check_portability.py` |
| 2 | `url-reader` の repo 固定パス 3 件 + `read_github_cli.py` 参照を `[SKILL_DIR]` 化 | §4.1 | `url-reader/SKILL.md:17,27,33,57` |
| 3 | `notion-organize-knowledge` の `WORKSPACE`/`QUEUE`/`AUDIT` を `[SKILL_DIR]` 化 | §4.1 | `notion-organize-knowledge/SKILL.md:88–90` |
| 4 | url-reader へのクロス参照を `[SKILL_DIR]/../url-reader/...` + 同梱前提の注記に変更（`chat-rigorous` が chat を参照するのと同じパターン） | §4.1 | `notion-organize-knowledge/SKILL.md:120` |
| 5 | `agent-contracts.md` の bare `scripts/queue.py` 参照を `[SKILL_DIR]` 化 | §4.1 | `notion-organize-knowledge/schemas/agent-contracts.md:511` |
| 6 | `commit` / `pr-create` の description に [When] と対象外を追加 | §4.2 | 各 SKILL.md frontmatter |
| 7 | 撤去弁明「既存の chat-rigorous 初版で実際に発生していた欠落」を削除 | §4.4 | `chat-rigorous/SKILL.md:123` |
| 8 | 「スキール」typo を 12 箇所修正 | §4.5 | `dispatch/SKILL.md` + `references/*.md` |
| 9 | `planner-role.md` に目次追加 | §4.5 | `dispatch/references/planner-role.md` |
| 10 | CLAUDE.md の収録スキル表を全 12 スキル + plugin 登録状況へ更新、検証コマンドを全スキル対象＋ポータビリティ検証を追加 | §6.1 | `CLAUDE.md` |
| 11 | 存在しない `git` スキルへの誘導を削除 | §4.5 | `pr-create/SKILL.md:52` |
| 12 | **`search` の検証ループを Workflow 化**。散文の警察装置 4 種を構造的保証に置き換え、`root-cause-synthesizer.md` の「添え物の検証省略を構造的に防ぐ」指示ごと削除。契約に `same_question_as_previous` を追加 | §5.1 | `search/scripts/investigate.js`（新規）/ `SKILL.md` / `agents/root-cause-synthesizer.md` / `schemas/agent-contracts.md` |
| 13 | **`skill-creator-best-practices` Phase 2–4 を Workflow 化**。並列発行・pass_rate 集計・閾値判定・改稿上限を script に移し、Phase 1/5 の人間ゲートは司令塔に残置 | §5.2 | `skill-creator-best-practices/scripts/build_skill.js`（新規）/ `SKILL.md` / `references/orchestrator-output.md` |
| 14 | tester → grader の assertions 受け渡しギャップと、reviewer 系の ✅/❌ markdown 判定（§12 代理指標）を schema で解消 | §5.2 | `build_skill.js` の `TEST_CASES_SCHEMA` / `REVIEW_SCHEMA` / `STRUCTURE_REVIEW_SCHEMA` |
| 15 | **状態変更 3 スキルに fresh-context の検証者を追加**。いずれも状態変更の前に置き、`mismatch` なら実行しない。verifier に `diff_summary` / `evidence` を必須化して「読まずに ok を返す」経路を塞いだ | §4.8 | `commit/agents/message-verifier.md`・`pr-create/agents/body-verifier.md`・`url-reader/agents/extraction-verifier.md`（いずれも新規）+ 各 SKILL.md |
| 16 | `manage-marketplace-plugin` の不要な人間ゲート 2 件を自動化（実依存確定分の同梱確認・exit 4 の衝突確認）。残る 3 件は入力・他スキルへの状態変更・テストデータが必要なため維持 | §4.9 | `manage-marketplace-plugin/SKILL.md` / `references/schemas.md` |
| 18 | **CLAUDE.md の検証節を現状へ更新し、Makefile の 2 つの穴を修正**。スキル一覧のハードコード（13 個目が漏れる）を動的導出に、`check_portability` を呼ぶ `portability` / `check` ターゲットを追加 | §6.2 | `CLAUDE.md` / `Makefile` |
| 17 | **§4.8 の見落としを招いた基準側の欠陥 3 件を修正**。基準リストの不一致・構造キーの条件付け・機械検査の沈黙。§10 に「適用範囲は機能で決める」を明記し、検証者の項目を基本品質へ、`quick_validate.py` に `SKIP:` 申告を追加 | §4.10 | `skill-creator-best-practices/references/best-practices.md` / `references/criteria-by-task.md` / `scripts/quick_validate.py` |

`[SKILL_DIR]` の使用可否は確認済み。`worktree-sync` が subagent を持たない単体スキルで
`python3 [SKILL_DIR]/scripts/repo_state.py` を既に使っており、`url-reader` も同じ形になる。
クロス参照の `[SKILL_DIR]/../<sibling>/...` は `chat-rigorous/SKILL.md:103` の実績パターン。

### 未対応（ユーザー判断が必要）

| # | 内容 | 規模 | 判断が要る点 |
|---|---|---|---|
| A | evals 欠落 6 スキルへのテストケース追加（§6・§10） | 3 件 × 6 = 18 件 | **最大の未達**。全部作るか、公開済みプラグイン（commit / pr-create / reference / dispatch / worktree-sync）優先か |
| B | **`build_skill.js` の残る未検証パス** | 小 | Structure の**差し戻し経路**（reviewer が `fail` を返したときの再設計と `MAX_STRUCTURE_ATTEMPTS` 打ち切り）。3 回目の実走で designer → reviewer は動いたが `warn` のみで `fail` が出ず、ループは 1 回で抜けた（§5.2d） |
| H | `writer` agent の戻り値の不安定さ（§5.2d 末尾） | 小 | 成果物を scratchpad に書き出して「書いた」と報告する run があり、その場合 `skill_draft` が本文ではなくポインタになる。writer 側にも「戻り値が成果物である」境界が要るか検討 |
| C | `commit` の Why-less な CRITICAL の整理（§4.3） | 小 | Authority Check と `git add .` 禁止は §11 の「残す」側。どこまで削るかは実際の誤爆経験に依存する |

| D | `notion-organize-knowledge` / `url-reader` の marketplace 登録（§6.3） | 小 | ポータビリティは解消済み。登録するかは公開意図の問題。登録する場合、notion は url-reader を同梱する必要がある |

| F | `investment-strategist` / `magi` への外部依存（§4.5） | 中 | 実体は別リポジトリ `stock-valuation-dcf`。(1) 同梱する (2) `chat` / `chat-rigorous` から投資ルーティング自体を外す (3) router にスキル不在時の fallback を足す、のいずれか。`chat` / `dispatch` は公開済みなので放置すると他環境で未定義の失敗になる |
