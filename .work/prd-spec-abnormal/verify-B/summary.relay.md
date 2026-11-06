# 検証役 B の最終報告（summary.md は hook に拒否されたため、報告本文を司令塔が逐語で写した）
- 反証（findings 27 行）: holds 26、resev 1（B-006 を 高→中。flow.md:386「SP-FLOW-047 の上限に数えない。」により SP-FLOW-033 を検査に掛けない読み方が成り立つ）。refuted・reclass・redecide・merge は 0。
- 抜き取り 44 項目: covered 10、missed 2、doc-ok 1、not-abnormal 31（inventory 21: covered 3 / missed 1 / doc-ok 1 / not-abnormal 16、文書 8: covered 6 / missed 1 / not-abnormal 1、grep 15: covered 1 / not-abnormal 14）
- 見落とし率 2/12 = 16.7%
- missed: M-001（ID-326、a、中: 改稿が申告外の箇所を書き換えたときの扱いが文書に無い）、M-002（DX-100、c、中: verification.md 状態×イベント表 374・376 行の未定義セル）
- 線引き: doc_check の CLI 引数・台帳の形・内部の予算・再開の仕組みは not-abnormal（blocked に至る経路は flow の E4 で照合役 A の担当とみなした）。この線引きで母数と率が変わる。
- 見なかった範囲: authoring.md・flow.md は引用箇所の前後のみ、requester.md はほぼ未読、prd-spec.js・doc_check.mjs は引用箇所以外未読、agents/・schemas/ 未読、B-008 の runtime 側の出し直しは未確認。
