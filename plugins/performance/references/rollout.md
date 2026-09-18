# Rollout and proposal policy

## Stage 1: offline measurement

汎用の正規化レコードを中心とし、workflowは入力アダプターの1つだけにする。
実装済み。実ログは集計値だけ照合し、匿名の合成fixtureで回帰テストする。
品質が同等という根拠が無ければ、安くなったことを改善とは呼ばない。

## Stage 2: passive collection (opt-in)

明示snapshotと増分ledgerを実装した。[snapshot契約](collection.md)と
[増分収集・hook契約](incremental.md)を用途別に参照する。
SDK用hook接続口に加え、[plugin同梱native hooks](native-hooks.md)を追加した。
pluginのinstall/有効化でhook定義を読み込み、初回のproject許可まで収集はしない。
Codexは現在のhook定義に対するホストの信頼承認も必要。

Codex exec JSON、Claude単発queryのadapterは公式仕様に基づく合成fixtureで検証する。
Codex 0.153.4では隔離設定で実推論とnative hook発火・使用量照合を検証済み。
常設設定と各host/versionでの照合は有効化前のゲートとして残す。
Stopで終端usage未着の実測に対応し、[終了後収集](capture.md)を追加した。
SDK用hook接続口のCodex SessionEndでは時間制限に収まらないworkerを起動しない。
native経路は別の1秒制限workerを使い、最終回収保証とは区別する。
hookは収集のきっかけであり、LLMスキルを毎イベント起動する場所ではない。
公式の安定したusage経路を優先し、不安定なtranscript形式はversion別に検査する。
ledgerは本文を保存しない。明示producer実行の一時stdout保存は終了後収集契約を参照。
local保存、保存先明示、retention/容量上限、排他、差分読込、
重複イベント、rotate、クラッシュ回復、無効化を実装。常駐TTL掃除や失われたログの復元は行わない。
収集の遅延・失敗件数も計測し、失敗しても本来の処理を妨げない。
hooksの実環境への登録・信頼承認はユーザーが確認する。インストールだけで有効とは言わない。

## Stage 3: proactive suggestions (not enabled)

比較・候補キュー・保留/却下・cooldownは実装済み。[候補契約](proposals.md)を参照。
hookは候補をキューへ保存するだけであり、LLMを自動起動する機構ではない。
同一project/task class/モデル/設定/品質基準の比較可能な実行群で候補を検出する。
閾値と最低サンプル数は設定・検証対象とし、単発の差から原因や改善を断定しない。
毎イベントLLMを起動せず、決定的な候補判定後、作業の区切りでのみ分析する。
分析の回数・入力上限とクールダウンを設け、分析自身のusageも別枠で記録する。
提案は観測、仮説、最小変更、品質リスク、実験条件、成功基準を持つ。
fingerprintで重複抑止し、保留/却下を保存する。新しい根拠で再提示する場合は理由を示す。
自動修正しない。承認された改善だけ試し、品質と使用量・時間を並べて評価する。
hookから分析を安全に起動できない環境では候補をキューへ残すだけにする。

## Acceptance

正常: cacheを重複加算せず、並列呼出しを各1回だけ合算する。
準正常: 結果欠損や失敗runでも既知のusageを残し、完全性を偽らない。
異常: 競合ID、不正値、壊れた/途中のjournalを成功として返さない。
誤発動: 通常の業務やCPU/DB改善の依頼では自動でこのスキルを起動しない。
今後の改善比較: 異なる条件、低下した品質、未計測を削減成功にしない。
