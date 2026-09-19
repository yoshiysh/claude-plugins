# AGENTS.md

This file provides guidance to Codex when working in this repository.

内容は `CLAUDE.md` と同じ設計を Codex 視点で述べたもの。齟齬があれば `CLAUDE.md` を正とする。

## リポジトリ概要

Claude/Codex 向けの汎用スキルを marketplace plugin として管理・配布するリポジトリ。スキルは `.agents/skills/<name>` から参照する。Claude 用には `.claude/skills -> ../.agents/skills` の symlink が同じものを指している。

## 現在の実体

スキル実体の置き場は「公開済みかどうか」で決まる。

- **公開済み（plugin に属する）**: 実体は `plugins/<plugin>/skills/<name>/`。`.agents/skills/<name>` はそこへの相対 symlink（`../../plugins/<plugin>/skills/<name>`）。
- **未公開・未登録**: 実体は `.agents/skills/<name>/`（現状は `manage-marketplace-plugin` のみ）。
- Marketplace 定義: `.claude-plugin/marketplace.json`（Codex も legacy パスとして読む）
- Marketplace 名: `yoshiysh-claude-plugins`
- 公開用 plugin: `plugins/<name>/`

新規スキルは `.agents/skills/` に実体で作る。`manage-marketplace-plugin` で公開した瞬間に `register_plugin.py` が実体を `plugins/` へ移し、`.agents/skills/<name>` を逆向き symlink に置き換える。

### なぜ実体が plugins/ 側なのか

**配布サブツリー（`plugins/<plugin>/` 配下）に symlink を置いてはいけない。**

Codex は plugin サブツリーだけを取得し、symlink を落とす。実測では `~/.codex/plugins/cache/yoshiysh-claude-plugins/<plugin>/<version>/skills/` が空になり、`plugin.json` は読めているのにスキルが 1 つも入らなかった。Claude Code は同一 marketplace 内を指す symlink を dereference する仕様なので旧構成でも動いていたが、両方で動く形は「symlink を置かない」しかない。

### plugin 間でスキルは共有できない

実体は常に 1 箇所。複数 plugin での共有はコピーになり drift するため禁止（`register_plugin.py` が exit 4 で止める）。別 plugin のスキルが必要な場合は、

1. `.claude-plugin/plugin.json` の `dependencies` に宣言する（Claude Code は同時 install する。**Codex に同等機能は無いので、依存 plugin は手動で install する**）。
2. 呼び出しはスキル呼び出しで行う。相手のファイルをパス参照したりスクリプトを直接実行したりしない。
3. 呼び出し側が自分で実行する必要のある手順書だけ、自前の `references/` に持つ。

## Plugin マニフェスト

各 plugin は 2 つのマニフェストを持つ。

| パス | 用途 |
|---|---|
| `plugins/<p>/.claude-plugin/plugin.json` | Claude Code 用。`dependencies` はこちらだけに書く |
| `plugins/<p>/.codex-plugin/plugin.json` | Codex 用（[公式仕様](https://developers.openai.com/codex/plugins/build)で required）。Codex 仕様に無いフィールドは書かない |

共通フィールドは一致していなければならず、`verify_install.py` の L2 がそれを検査する。
専用フィールドは Claude の `dependencies`、Codex の `interface`。逆側への混入は拒否する。
登録処理は Codex の表示情報を生成し、既存の `interface` は再登録でも保持する。
L2 は既存の interface 未設定プラグインを許容するため、Codex の詳細な表示スキーマ検証とは別である。

## ディレクトリ構成

```text
.agents/skills/
  manage-marketplace-plugin/                         # 未登録スキルはここが実体
  commit -> ../../plugins/git/skills/commit          # 公開済みは plugins/ への symlink
  ...
.claude/
  settings.json
  skills -> ../.agents/skills
.claude-plugin/
  marketplace.json
.codex/
  config.toml
  hooks.json
plugins/
  git/                     # 例。chat / research / notion / skill-creator / workflow / performance も同構成
    .claude-plugin/plugin.json
    .codex-plugin/plugin.json
    README.md
    skills/commit/         # ← 実体
    skills/pr-create/
    skills/cleanup-branches/
```

## 作業ルール

- 編集は `.agents/skills/<name>/` から行う。
- 新規スキルは `.agents/skills/<name>/` に実体で作る。`plugins/` へ手で置かない。
- `plugins/` 配下に symlink を作らない。
- skill の `SKILL.md` は frontmatter の `name` と `description` を必ず持つ。
- 具体的な処理はできるだけ `scripts/` に寄せ、`SKILL.md` はフロー・分岐・完了条件を中心に保つ。
- plugin 登録時は `manage-marketplace-plugin` のスクリプトを使う。
- plugin author の既定値は `yoshiysh`。
- 説明的なコメントは書かない。コメントは Why Driven な best-practices に従った形式で簡潔に
  （書くのはコードから読めない制約・根拠だけ）。コメントはゼロが本来は望ましく、理由は
  commit message / PR 本文へ置く。
- 後方互換性は不要。保存データ・入力形式の migration や旧形式サポートは書かない
  （形式の検証は構造で行い、合わない旧データは失敗させる）。marketplace 配布の
  plugin version bump は互換性管理ではなく配布機構なので、この規則の対象外。
- 途中で止めず完了まで実行する。人間ゲート（マージ・公開）以外では止めない。
  作業の分割や Issue 化で完了を先送りしない — Issue を切ることは望ましいことではない。
- 不在・網羅の断定（「〜は無い」「全て〜」「〜のみ」）には裏付けを付ける: 閉集合の
  全列挙・対象の全文読み・形を変えた複数回の検索のいずれかを示すか、「grep で見た
  範囲では」のように手段でスコープする。rename・削除の sweep 後は commit 前に
  再 grep で残 0 を確認してから網羅を主張する。
- 生成と検証を分離する。自分が書いた成果物・修正に自分で合格判定を出さず、検証は
  fresh context で行う。指摘への修正差分そのものも再検証を通す（修正が持ち込む欠陥と
  修正の不徹底は、修正者自身には見えない）。
- 検証は単一視点にしない。視点（レンズ）の異なる複数の検証者で多角的に評価し、
  fan-out・反復する検証は multi-agent workflow として設計することを考慮する
  （Claude Code: Workflow / agent teams、Codex: collaboration modes）。
- 同じ値・列挙・上限を 2 箇所に書かない。named constant か単一文書を正本にし、
  他は参照にする（書き写しは必ずズレる — cycle 上限 3/5 矛盾・timeout 3 箇所
  書き写しの実例による）。
- 役割の分担は構造で持つ。オーケストレーター（司令塔）は「エージェントに振る・返り値を
  そのまま relay する・承認後に機械的へコピーする」だけで、**内容の生成・修正・採点を
  行わない**（実測: 司令塔の安価な手修正は 3 回中 3 回欠陥を持ち込んだ）。各役割には
  やること・やらないことを明示で書く — 推論可能なだけの don't は守られない。
  ループの出口条件は役割境界と一致させる（役割の無い場所へ作業が漏れる出口を作らない）。
- 1 役割 1 責務は multi-agent ループの内外を問わず適用する。司令塔（メインセッション）は
  成果物本文（コード・hook・文書の実体）を書かない — 「小さい修正だから」「workflow を
  立てるほどでもないから」は、手修正 3/3 欠陥を生んだ合理化の言い換えである。実装タスクの
  『直接実行』とは実行前固定の実験契約を組まないことであって、司令塔が書くことではない:
  生成は builder 役の agent へ dispatch し、検証は決定的テスト + 生成者と別の fresh 監査 +
  PR レビュー（人間）が持つ。
- 解決は常に根本原因の除去を目指す。防御パッチ（注意書き・監視・例外条項で症状を塞ぐ）は
  原因を残したまま読み手の注意力に依存する対処療法で、注意書きを読まない経路が一つでも
  あれば再発する（実測: 「agents/ の有無で判断しない」という注意書きは正本に書かれていた
  のに、写しであるチェックリスト側には届かず、検証者経路チェックの欠落を防げなかった）。
  誤りを構造（正本参照・script による配達・型/スキーマ検査）で不可能にできるなら構造を
  直し、防御コメントはその後で削除する。構造で防げず注意書きだけが唯一のガードになる
  場合のみ、why-driven の 1 行として残す。
- fan-out する workflow は agent ごとにモデルと effort を明示指定する。`opts.model` 等を
  省略した場合の既定はセッションモデルの継承であり、継承 = 最上位モデル × 体数分の消費に
  なる。enum 判定・機械的照合のような役割は小さいモデル + 低 effort で足り、最上位モデルは
  司令塔と統合判断だけに使う。さらに、多数の agent が同じコーパスを読む workflow では各体に
  冷読みさせない — 抽出役 1 体が行番号つき evidence pack を 1 回作って各体へ配り、各体は
  引用行のピンポイント再読だけ行う。共有部分は prompt の先頭に置いて prefix を揃え、
  プロンプトキャッシュを効かせる（実測: `opts.model` を省略した ad-hoc 監査 workflow は
  60 agent 全てが Fable 5 を継承し、同じ 10 ファイルを冷読みして cache 生成入力 9.3M
  token・cache 読み 28M token を消費し、5 時間のレート制限窓を約 3 分で使い切った。一方
  claude-plugins 配布の skill-creator scripts は反証役を claude-sonnet-5 に固定しており
  問題を起こしていない）。上位モデルへ渡すプロンプト自体も、フィルタ済み diff・該当抜粋・
  対象ファイルのみに絞る — 全量を渡す設計は入力が対象サイズに比例して膨らみ、分あたり
  入力上限（実測: free tier で 250K tokens/分）を単発の呼び出しで超える。ただしこの
  絞り込みは 2 つの品質条件と対で運用しないと網の穴に化ける。第一に、絞る判断は
  「生成」でなく「選択」にする — 安いモデルには閉集合（行範囲・enum・ファイル単位の
  verdict）から選ばせ、本文のコピーは script が正本から逐語で行う（要約・書き直しを
  させると正本から drift した写しと捏造が混入する。上記の「オーケストレーターは内容を
  生成しない」と同根）。第二に、絞った結果の「見ていないもの」は必ず宣言する —
  除外一覧・skip 一覧・fail-open を明示し、可能なら skip からの無作為サンプル精読で
  偽陰性を実測する（黙って最低限化すると、見なかった箇所が「問題なし」に化ける）。
- 規範・ルール・スキル指示は、何をするかに「守られないと何が壊れるか」を添えて書くと
  読み手が初めて見る状況にも自分で適用できる。裸の命令形（ALL CAPS の ALWAYS/NEVER 等）
  は書いた時に想定した状況にしか結びつかないため、状況が変わると素通りされる（実測:
  本リポジトリの散文命令は役割分担・ledger 搬送のように機序説明が薄い間は繰り返し
  違反され、why を明記するか hook で機械強制した後に定着した）。命令形がそのまま適する
  のは低自由度領域（不可逆操作・壊れやすい手順）で、そこでは省略せず正確な手順を
  具体に書く。
- commit を作ったら同じ作業単位のうちに remote へ push する。ローカル、特に `/tmp` 系の
  一時 worktree にしか無い commit は、環境の清掃や worktree の破棄で失われる
  （実測: 検証済み 4 round 分の成果 commit が未 push のまま `/tmp` 清掃で失われ、
  再実行に丸 1 周を要した）。push しておけば worktree 自体を失っても成果は remote に残る。

## 検証

`Makefile` が入口。対象スキルは `.agents/skills/*/` から毎回導出する。

```bash
make test         # 合否ゲート: 参照・quick_validate・unittest・汎用 Node test・各 eval preflight
make portability  # 配布 portability の一覧（合否ゲートではない）
make check        # 上記 2 つをまとめて
```

個別に見るとき:

```bash
python3 .agents/skills/skill-creator-best-practices/scripts/quick_validate.py .agents/skills/<name> --verbose
python3 .agents/skills/manage-marketplace-plugin/scripts/check_portability.py --skill <name>
python3 .agents/skills/manage-marketplace-plugin/scripts/check_references.py --skill <name>
python3 .agents/skills/manage-marketplace-plugin/scripts/verify_install.py --plugin <plugin-name>
```

`make test` は `.codex/hooks.json` の PostToolUse hook（matcher `Edit|Write|MultiEdit`）からも呼ばれる。

## インストール

```bash
/plugin install <plugin-name>@yoshiysh-claude-plugins
```

`notion` plugin は `url-reader` スキルを使うため、Codex では `research` plugin も併せて install する（Claude Code は `dependencies` により自動で入る）。

`research` の search/dispatch、`skill-creator`、`workflow` の pdca / prd-spec / review-document の
Workflow callsite は、native Workflow が無い Codex で `workflow:dynamic-workflow-runner` を内部利用する
（runner は workflow plugin に同梱）。Codex は plugin dependency を自動導入しないため、workflow 以外の
caller plugin と `workflow` plugin を別々に一度 install する。runner をユーザーが直接呼ぶ必要は無い。
runner v1で意味保存して実行できるのは `research:search` と `skill-creator` の create modeだけで、
dispatch、pdca、prd-spec、review-document、skill-creatorのreview/updateはexecution前にfail-closedする。

`performance` plugin は install しただけでは何も収集しない（opt-in）。有効化・境界・保存先は
`plugins/performance/skills/performance-agent/references/native-hooks.md` を正とする。

## 注意点

- `.claude/skills` は symlink なので、Git 上では実ファイル削除と symlink 追加が見えることがある。
- `.claude-plugin/marketplace.json` の `name` を変えると `/plugin install <plugin>@<marketplace>` の marketplace 名も変わる。

## 言語

ユーザーへの返答は日本語で行う。
