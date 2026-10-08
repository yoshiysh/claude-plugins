# Review Guidelines

PR をレビューする AI（Claude・Gemini）向けの指示。実装の規約そのものは `AGENTS.md`「作業ルール」と `plugins/skill-creator/skills/skill-creator-best-practices/references/best-practices.md`（以下 best-practices.md）が正本で、ここでは写さない。

## 読むもの

変更されたファイルの種類に応じて、該当する箇所を読んでから判断する。best-practices.md は全体を読まず、挙げた節を読む。

| 変更 | 読むもの |
|---|---|
| `plugins/*/skills/` `.agents/skills/` の `SKILL.md`・`agents/*.md`・`references/*.md` | best-practices.md §1「SKILL.md の設計原則」・§2「description の設計」・§3「Sub-agent 設計」・§5「確定的処理はスクリプトに追い出す」・§10「チェックリスト（スキル公開前の確認）」・§11「Claude 5 世代の指示設計 — 世代共通の原則」・§12「制約の較正 — right altitude と代理指標の排除」 |
| `plugins/*/workflows/*.js` | best-practices.md §13「オーケストレーション層の決定化 — Workflow 実行型」 |
| スクリプト（`*.py` `*.mjs` `*.js` `*.sh`）とテスト（`tests/`・`plugins/*/skills/*/scripts/*.test.mjs`） | `AGENTS.md`「注意点」。バグとセキュリティを見る: `.agents/skills/` の走査、`subprocess` への文字列連結や `shell=True`、パスの組み立て、ゲートが依存する exit code |
| `plugins/*/.claude-plugin/plugin.json`・`plugins/*/.codex-plugin/plugin.json`・`.claude-plugin/marketplace.json` | `AGENTS.md`「注意点」（2 つの `plugin.json` の同期、Claude 専用の `dependencies` と Codex 専用の `interface`、marketplace 名） |
| `plugins/` 配下の配置 | `AGENTS.md`「現在の実体」「作業ルール」（`plugins/` 配下の symlink 禁止、実体の置き場、plugin 間のパス参照・スクリプト直接実行の禁止。plugin 間の利用はスキル呼び出しと `dependencies`） |
| `*.md` | 事実の誤り、存在しないファイルやコマンドへの参照、正本との重複 |
| `.github/workflows/` | 権限が必要以上に広い、Secret の露出、SHA で固定していない Action |
| すべて | `AGENTS.md`「作業ルール」 |

## 観点

- **役割分担と正本の一意性**：スキル実体が `plugins/` と `.agents/skills/` の規則どおりの側にあるか。同じ値・列挙・上限が 2 箇所に書かれていないか。司令塔（SKILL.md 本体・オーケストレーター）が成果物の生成・修正・採点をしていないか。書き写しはいずれ食い違い、司令塔の手修正は欠陥を持ち込む
- **生成と検証の分離**：生成者が自分の成果物に合格を出す構造、単一視点だけの検証になっていないか。生成者には自分の欠陥が見えない
- **根本解決と対症療法**：注意書き・例外条項・監視だけで症状を塞ぎ、構造（正本参照・script による配達・型 / スキーマ検査）で防げる原因を残していないか。注意書きを読まない経路が一つでもあれば再発する
- **不在・網羅の断定**：「〜は無い」「全て〜」「〜のみ」に、閉集合の全列挙・全文読み・形を変えた複数回の検索のいずれかの裏付けがあるか、手段でスコープされているか。裏付けの無い断定は検証済みとして下流の判断に使われる
- **スキル構造**：frontmatter の `name`・`description`、SKILL.md がフロー・分岐・完了条件に留まり処理を `scripts/` に寄せているか、参照の深さ。基準は上の表の best-practices.md の節
- **コメントと後方互換**：コードから読めない制約・根拠以外のコメント、旧形式の migration や fallback を新たに持ち込んでいないか。経緯は commit message / PR 本文に置くもので、互換層は合わない旧データを黙って通す。対象外の範囲は `AGENTS.md`「作業ルール」
- **スクリプト**：バグ（境界値・off-by-one・None・例外の握りつぶし・競合）、セキュリティ、性能。設計の好みや書式は対象外

## 指摘の基準

- 指摘には根拠の `file:line` を付ける。名前やコメントからの推測で指摘しない
- 言語・ライブラリ・ツールの挙動についての主張（「この式は null でエラーになる」など）は、実行して確かめたか公式ドキュメントで確認できたものだけを書く。確かめられないなら書かない
- 指摘する前に、作者がそう書いた理由を考える。妥当な理由がありうるなら、断定せず質問の形で書く
- 参照先の不在や frontmatter の欠落も指摘の対象にする。`make test`（中身は `AGENTS.md`「検証」）は GitHub Actions では走らないので、レビューで見なければ main に入る
- この PR が持ち込んでいない既存の問題は、重大なものだけを書き、既存の問題だと明記する

## 重大度

| 重大度 | 対象 |
|---|---|
| CRITICAL | 配布される skill / plugin が壊れる（参照切れ、symlink 経由での実体の破壊、install 先で解決しないパス参照）、セキュリティ欠陥 |
| HIGH | 正本が二重化して drift する設計、生成と検証が未分離、原因を残す対症療法、変更の意図に反する挙動を生む機能的なバグ |
| MEDIUM | スキル構造の違反、裏付けの無い不在・網羅の断定、命名規約の違反、ドキュメントの事実の誤りや食い違い |
| LOW | 冗長なコメント、誤字、テストの品質、軽微な改善 |

LOW は 1 回のレビューで 5 件まで。それを超えた分は件数だけを summary に書く。

## 出力

- 日本語で書く
- 指摘は変更行にインラインで付け、全体の所見は summary に書く
- summary の冒頭に重大度ごとの件数を書く。指摘が無ければそう書く
- 読めなかったファイルがあれば summary に列挙する。網羅したかのように書かない
