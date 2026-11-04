# develop プラグイン

開発ワークフロー支援のためのプラグイン。実装（`develop:implement`）、レビュー（`develop:review`）、レビュー指摘対応（`develop:address-review`）の 3 スキルを提供します。

## スキル一覧

- `develop:implement`: 計画・実装・テスト・自動レビュー・修正ループを回し、高品質な変更を確実に commit・push する。
- `develop:review`: 方針文書（`REVIEW.md`）に基づき、観点ごとの並列レビューと 2 段の独立検証（事実検証・方針適合検証）を行う。
- `develop:address-review`: PR コメント・外部指摘を収集・分類・検証し、自動修正、push、CI 待ち、返信、条件付き resolve までを完走する。
