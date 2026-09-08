# performance

エージェント作業の計測・分析と品質を維持するパフォーマンス改善を支援する

## 収録スキル

| スキル | 呼び出し | 説明 |
|---|---|---|
| `agent` | `/performance:agent` | エージェント作業の計測・分析と品質を維持するパフォーマンス改善を支援する |

## 使い方

```
/performance:agent <依頼内容>
```

詳細なフローは `skills/performance-agent/SKILL.md` を参照してください。

## 初版の状態

対応範囲は終了済みworkflowログと正規化済みJSONLのオフライン集計です。
hooks、自動収集、条件付き提案の自動起動は未実装・未有効です。
品質の同等性は使用量の減少だけから認定しません。

検証: 合成テスト15件、独立レビュー1回と指摘2件への修正、既存実ログの集計値照合を実施。
正式なbest-practices Workflow評価・自然言語トリガー評価・実環境install検証は未実施です。
リポジトリのバンドル検査は通過しましたが、Codex plugin-creatorの追加検査は
`interface` メタデータ欠損で未通過です。既存のClaude/Codex共通マニフェスト規約との
整合を解決するまで、Codexへの配布準備完了とは扱いません。

## 構成

このプラグインの `skills/` 配下がスキルの実体です。
リポジトリ内の `.agents/skills/<name>` がここへの相対シンボリックリンクになっています。
スキル実体はディレクトリ名（`performance-agent`）のまま、frontmatter の `name`（`agent`）で公開されます。
