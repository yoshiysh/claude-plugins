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

## 実装範囲と有効化状態

| 機能 | 状態 |
|---|---|
| 終了済みworkflow・正規化JSONLの読取計測 | 実装済み。通常は保存しない |
| 明示snapshot保存 | 実装済み。snapshot同士を合算しない |
| 増分ledger | 実装済み。途中行、rotate、重複排除、TTL掃除コマンド、容量制限、排他、回復 |
| Codex exec / Claude単発query adapter | 公式仕様の合成fixtureで検証。transcript自動解析ではない |
| 収集自身の計測 | 永続化できた試行の成功/失敗・読込量・処理時間を記録。記録不能な失敗は不明 |
| 比較・提案候補 | 同条件・品質証拠・最低sample数で判定。保留/却下/cooldown/重複抑止 |
| SDKログ用hook接続口 | 実装済み、明示設定用。候補キューまで、モデルは起動しない |
| plugin同梱native hooks | 初回project設定後に通常会話を限定計測。Codexではhook信頼承認も必要 |
| 明示producer終了後収集 | 共通argvラッパー。終了+EOF後に回収。モデル名やファイル名は固定しない |

ledgerは本文・入力path・生IDを保存せず、collectorは外部通信しません。
明示producer実行は別の許可経路です。一時stdout保存・外部推論の境界は
[終了後収集](skills/performance-agent/references/capture.md)を参照してください。
モデル世代の固定リストも持ちません。
品質の同等性はトークン減少から認定せず、品質評価の証拠が提供されても候補判定にとどめます。
各条件の詳細は [増分収集](skills/performance-agent/references/incremental.md) と
[比較・提案](skills/performance-agent/references/proposals.md) を参照してください。

## 検証と残る運用ゲート

計測、snapshot、独立ディレクトリからのCLI、増分収集、提案の回帰テストを同梱します。
軽量独立レビューでsnapshot schema不足と、観測の並べ替えによる不要な再提案を検出・修正しました。
これは正式なbest-practices Workflow評価ではありません。以前のworkflow実ログは集計値のみ照合済み。

Codex 0.153.4では隔離した設定で実推論、native hook発火、使用量のledger照合を検証済みです。
Stopではusage未着、SessionEndで取得という順序を観測しました。SessionEndは最大3秒のため
現在はskipし、最終回収はproducer終了後収集へ分離しています。
終了後収集の新経路でもCodexの実推論1件を回収済みです。Claude Code 2.1.217では
未ログインによる失敗結果をusage不明として回収しました。再ログイン後のClaude Code 2.1.267では
haiku aliasの単発実推論がexit 0で終了し、完了観測1件（入力396、cached入力0、出力99）を
ledgerから再確認しました。品質は未計測で、Claudeのnative hook発火は未検証です。
Claudeではplugin同梱hookを `--plugin-dir` で読み込んだ実推論の入力396・出力73を回収済み。
Claude/Codex両方の隔離marketplace installは成功しました。Codexの同梱hook承認後実行と、
同じmarketplaceインストール個体を使ったClaude実推論は未検証です。
有効化前に対象host/version・許可された入力・専用保存先を確認します。
常駐TTL削除、失われた旧ログの復元、全子実行の費用帰属、課金換算、自動LLM分析は提供しません。
`interface` はCodex専用として登録処理で保持します。manifest検証と実環境での認識は別です。

## Marketplaceからの自動計測

install・plugin有効化の後、`/performance:agent このプロジェクトの自動計測を有効にして`
と依頼します。対象と保存範囲を一度確認し、それ以降はhookが数値だけをローカルに保存します。
Codexでは `/hooks` の信頼承認が別途必要です。各projectの設定ファイルへのhook転記や、
他スキルへの組込みは不要です。詳細・無効化・容量制限は
[同梱hook契約](skills/performance-agent/references/native-hooks.md)を参照してください。

## ファイル配置

このプラグインの `skills/` 配下がスキルの実体です。
リポジトリ内の `.agents/skills/<name>` がここへの相対シンボリックリンクになっています。
スキル実体はディレクトリ名（`performance-agent`）のまま、frontmatter の `name`（`agent`）で公開されます。
