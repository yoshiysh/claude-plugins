# Bounded comparison and proposal queue

算術・候補判定は `proposals.py`、解釈は親。hookは候補を保存するだけでLLMを起動しない。

```sh
python3 [PLUGIN_DIR]/scripts/proposals.py evaluate --input <comparison.json> --store <private-queue>
python3 [PLUGIN_DIR]/scripts/proposals.py list --store <private-queue>
python3 [PLUGIN_DIR]/scripts/proposals.py defer --id <fingerprint> --store <private-queue>
python3 [PLUGIN_DIR]/scripts/proposals.py dismiss --id <fingerprint> --store <private-queue>
```

入力は mode（"drift" か "variant"）、baseline、candidate のみ。各 cohort は group と samples（variant mode では variant も）。mode の意味と拒否理由コードの正本は scripts/proposals.py。
groupのキーはproject/task_class/model/settings/quality_contract。値はそれぞれ同一条件を表す
資料のSHA-256（64文字小文字hex）。モデル名は固定せず、実際のモデル・推論設定を条件資料に含める。
5条件が双方で一致しなければnot_comparable。勝手に異なるモデルを同条件と読み替えない。

sampleの全キー：id（観測のdigest）、usage（input_tokens/cached_input_tokens/output_tokens）、
duration_ms（非負整数またはnull）、status（completed/failed/unknown）、quality
（passed/failed/unmeasured）、quality_source（independent/producer）、
quality_evidence（digestまたはnull）、usage_evidence（digest）。
usageは不明ならnull。余分なキー・本文・pathは拒否。idとusage_evidenceは全sampleを通じて一意。
usage_evidenceはファイル全体のhashを使い回さず、**単一観測を切り出した証拠**のdigestとする。
quality_evidenceはidともusage_evidenceとも異なる値でなければならない（使い回しはschema拒否。
品質を測っていないのに測った形だけ整える最短の抜け道を構造で塞ぐ）。
入力提供者が実際の証拠との対応・独立sample・条件・品質評価を保証する。CLIはdigestの真正性や
品質合格を自力で検証しないため、出力は常に調査/検証候補であって改善の認定ではない。

**quality_sourceの意味**：independentは、品質判定の産物がsampleを生成した主体と**別の工程**
（fresh contextの監査者・検証段・別スキルの判定器）で作られ、その産物のdigestを
quality_evidenceにしていること。producerは生成主体の自己申告。生成者は自分の出力に通る判定を
書けてしまうため、producer品質のsampleを含むcohortは候補の前提を満たさない（not_comparable側）。
これはツールの検証能力の主張ではなく入力規約であり、independentの宣言が事実かは入力提供者の
責任のまま残る — ただし宣言を必須にすることで「独立検証をしていない比較」が黙って候補に
化ける経路は消える。kaizen運転との結線は[kaizen統合](kaizen-integration.md)を正とする。

既定各3sample以上、最大各100。`--min-samples`は3〜100。
全sampleがcompletedかつquality passed（quality_source=independent）、品質証拠・usage・
durationが既知でなければ候補なし。
input+outputとdurationの下側中央値で比較し、cacheをinputに再加算しない。
費用や統計的有意差を推定しない。基準中央値0は割合比較できないのでnot_comparable。
`--threshold-percent`既定25（1〜1000）。増加があればinvestigate_regression、減少だけなら
verify_reduction。トークン減・時間増のトレードオフはregression調査候補として両値を示す。

queueは[private state契約](incremental.md)と同じ専用ディレクトリ方式で、ledgerとは別にする。
最大100候補、超過時は失敗し既存の却下を消さない。本文は保存せずfingerprint・証拠digest・
観測中央値・状態・時刻だけを保存する。配列並び替えは同じ証拠と判定する。
同条件/理由の同じ証拠では再enqueueしない。異なる証拠かつcooldown後のみ再提示候補にする。
`--cooldown`既定86400秒（60秒〜30日）。new_evidence=trueの再提示では新しい証拠の理由を説明する。
deferはcooldown経過で再び一覧対象、dismissは同じ証拠を再提示しない。
提案と却下履歴は明示削除まで保持する（100件/容量でbounded）。ledgerの30日TTLとは別。

親がキューを扱うのは依頼された分析または承認された作業区切りだけ。listは最大5候補を返す。
1区切りにつき最大1候補・追加agentなしで解釈する。追加の証拠読込が必要なら、最大32KiBの
対象資料に限定し、その範囲で判断不能なら未検証として保留する。全ログを再読込しない。
解釈には観測、原因仮説、最小変更、品質リスク、比較条件、成功基準を含める。
提示後はユーザーの判断でdefer/dismissを使い、承認なく改修しない。
分析自身の使用量が取得できる場合は別capture・別sourceで収集する。取得できなければ不明とし、
「分析のコスト0」とはしない。自動LLM起動は提供しないので無限な分析ループは作らない。
