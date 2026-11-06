# 依頼元が抽出時に挙げた仮説（未検証。照合役は確かめるか反証する。結論として扱わない）
1. 中断点で無応答のときが未定義（TBD-SFLOW-008）
2. 「迷ったら確認」後の扱いと状態が無い
3. verification の「検査不能」「残った指摘」を flow が受ける項目が無い
4. SP-FLOW-045 と PR-CONSUMER-007 の矛盾
5. SP-FLOW-047（任意）と SP-VERIFICATION-039（必須）の強さの違い
6. 保持規則と Issue の経路が文書に無い
7. elicitation の状態×イベント表に未定義 10 行
8. PR-CONSUMER-014・032 が未定義
9. 実装で error を blocked に変える式が段ごとに 2 通りあり next_args の有無が分かれる
