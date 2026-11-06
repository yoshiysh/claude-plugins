# 照合役 A の notes

担当: requester.md・consumer.md・flow.md（と各 .tbd.json）、および prd-spec.js の継ぎ目（doc_check の結果を受ける箇所、blocked・hold・finalHold・error・status を作る箇所）。

## 仮説の成否

| # | 仮説 | 判定 | 行 |
|---|---|---|---|
| 1 | 中断点で無応答のときが未定義（TBD-SFLOW-008） | 成立。E3 の 3 行が ❌ で、TBD は blocking=false のため PR-CONSUMER-008 とも合わない | A-010 |
| 2 | 「迷ったら確認」後の扱いと状態が無い | 成立。起動判定中は「依頼者の応答を待たない」とされ、確認待ちの状態もイベントも無い | A-011 |
| 3 | verification の「検査不能」「残った指摘」を flow が受ける項目が無い | 成立。flow.md・requester.md・consumer.md・INDEX 2 本で「検査不能\|残った指摘\|未実施」は 0 件 | A-009 |
| 4 | SP-FLOW-045 と PR-CONSUMER-007 の矛盾 | 成立 | A-001 |
| 5 | SP-FLOW-047（任意）と SP-VERIFICATION-039（必須）の強さの違い | 成立。強さに加え、上限を超えたときの結末（SP-FLOW-033 は終了、SP-VERIFICATION-044 は未実施として記録）と、1 回の出所（依頼者の決定か否か）も食い違う | A-008 |
| 6 | 保持規則と Issue の経路が文書に無い | 成立。文書の保持規則の経路は決まっていない旨の回答だけで、flow.md:271-272 は「唯一の経路」と書く。Issue は grep「Issue\|起票」で 6 文書と INDEX に 0 件 | A-004 |
| 7 | elicitation の状態×イベント表に未定義 10 行 | 担当外（elicitation.md は照合役 B）。確認していない | - |
| 8 | PR-CONSUMER-014・032 が未定義 | 成立。`git log -S` でも consumer.md に過去の定義は無い。参照元は authoring.md・verification.md（B の文書）なので B の行と重なりうる | A-012 |
| 9 | error を blocked に変える式が段ごとに 2 通りあり next_args の有無が分かれる | 不成立（下記）。別の欠陥として A-019 | A-019 |

### 仮説 9 の詳細

blocked への変換式は 6 通りある（seam.tsv の各行）。

- E1 `x.rerun === false ? null : 段`: L2392・2454・2488・2494・2514・2518・2546・2775・2781・2786・3125。rerun キーの無い error に next_args が付く。
- E2 `x.rerun ? 段 : null`: L2727・2935・3021・3025。rerun キーの無い error に next_args が付かない。
- E3 段の直書き: L2321・2359・2364・2368・2373・2374・2395・2401・2725・2931・2933・3085・3113・3165・3167。
- E4 null の直書き: L2930・3032・3088・3128・3161・3163。
- E5 throw 経由（rerunStage・budgetStop）: L3156〜3157。常に running の段から next_args。
- E6 finish の直接呼び出し: L2247（upstream_gap、next_args 無し）・L3138（budget、nextArgs(next)）。

不成立の理由: E2 の呼び先は fixedMoved（L2327-2335）・flowKept（L1435-1441）・independentFlow（L1663-1690）だけで、3 つとも全ての error に rerun を明示している。rerun キーの無い error が E2 に届く経路は無いので、現行の入力で E1 と E2 の結果は分かれない。式が 2 通りあることは、将来 E2 の呼び先がキーの無い error を返したときに黙って next_args が落ちる潜在的な不整合にとどまる。

実体の欠陥: rerun キーの無い error（L1572・1639・1741・1753・1755・1828・2109・2129、ほかに L1979・2091・2151・2188）は E1 で next_args の付く blocked になる。workflow-io.md §3（L80-95）が next_args を付ける・付けないと列挙する場合のどちらにも、resolver の返り値の契約違反は入っていない（A-019）。

## 補足

- prd-spec.js は doc_check の exit code を受け取らない。受け取るのは agent が返り値に写した doc_check の stdout（JSON の行）だけで、exit code の解釈は agent 側（agents/・schemas）にある。今回 agents/・schemas/ は読んでいない。
- 継ぎ目の閉集合は 2 つのパターンで作った（seam.tsv の先頭行に逐語で記録）。P1 は brief の指定のとおり。P2 `rerunStage|budgetStop|notRun\(|scriptDefect` は、例外で blocked に変わる経路（L1146・1168・1187 など）が P1 から落ちるため足した。286 行、全行に disposition を付けた（未分類 0）。
- seam.tsv の「文書と一致」は、6 文書の req_id に対応がある行だけに付けた。SKILL.md・workflow-io.md にだけ規定がある停止は実装側の規定とみなし、finding の id を付けた。
- A-024（doc_check の stdout が無いと doc_blocking が 0 になる）は、designated が schema で required を持たないこと（L843-860）、usable（L2898-2901）が doc_check を見ないこと、copyFault（L544）が JSON の行の無い値を写し損ねとしないことをコードで確かめた。監査役の契約（agents/・schemas/）が doc_check の写しを必ず返させるかは読んでいないので confidence は medium。
- A-007・A-008 の「応答の無い agent は出し直さない」は workflow-io.md §5（L216）と prd-spec.js の call()（L1153-1170）による。runtime 側の出し直しの回数は script から見えないので数えていない。

## 見なかった範囲

- elicitation.md・verification.md・authoring.md は、仮説 3・5・8 の確認に要る行（verification.md L80-98・L293・L312-320・L337-394・L430-460、authoring.md L547・L592）だけを読んだ。全文は読んでいない。
- doc_check.mjs・agents/・schemas/ は読んでいない。
- workflow-io.md は §1〜§3 の前半（L1-139）と §5（L209-222）を読み、§3 の後半（L140-208）と §6 は grep で必要な行だけを見た。
- prd-spec.js は継ぎ目の grep の全行（286 行）と、関連する関数（finish・blocked・call・recopy・flowKept・independentFlow・fixedMoved・fixFailed・convertFailed・settle・settleRound・reholdFailed・holdLeft・needsAnswers・upstreamGap・answersStop・answersUnchecked・resetEntry・stage8 の末尾・finalHold・exitViolation・restored・enterFromDisk・メインの loop）を読んだ。段の本体（stage1〜stage7）は blocked を返す行の前後だけを読んだ。

## 判断に迷って入れなかった候補

| 箇所 | 理由 |
|---|---|
| docs/requirements/INDEX.md・docs/specifications/INDEX.md の path 列が別のマシンの `/Users/yoshiki.hemmi/.../pr198/...` を指している | 異常系ではない。参照の解決（PR-CONSUMER-024）には関わりうる |
| SKILL.md S0 の W の置き場（native は `[SKILL_DIR]/workspace/<案件>/`）と PR-REQUESTER-031・SP-FLOW-039（ホームディレクトリ配下の作業用ディレクトリ） | 正常系の置き場の話。plugin の install 先はホーム配下なので、食い違いかどうかは TBD-SFLOW-012 次第 |
| SP-FLOW-010 のモード（TBD-SFLOW-010 で未定）に対し、実装は entry の new・existing・expand を持つ | 正常系のモードの決定で、停止条件ではない。A-013 の rationale でだけ触れた |
| flow.tbd.json の blocking=true の TBD 10 件が、このスキル自身の仕様書に残っている | 文書一式そのものの完成度の問題で、異常系の照合の外 |
| L2151 の error（resolver が doc_check flow の stdout を返さない）だけ rerun キーが無い。同じ文面の L1437 は rerun: true | E1 で受けるので結果は同じ（next_args あり）。A-019 の潜在的な不整合の一例 |
