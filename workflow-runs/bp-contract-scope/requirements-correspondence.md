# BP 要求の整理対応

基準: 4c53a3f。要求の能力と裁定済み制約を残し、同じ能力の条件へ統合した。個別の外部条件・結果は仕様で保持する。内部実現だけを理由とする要求の廃止はない。番号を再利用しない。

| 要求群 | 旧番号 | 現在の番号 | 扱い |
|---|---|---|---|
| BPDESIGNEDSKILL | 001・003・004・005・018 | 001 | 同じ能力の条件に統合 |
| BPDESIGNEDSKILL | 002 | 002 | 保持 |
| BPDESIGNEDSKILL | 006 | 006 | 保持 |
| BPDESIGNEDSKILL | 007 | 007 | 保持 |
| BPDESIGNEDSKILL | 008 | 008 | 保持 |
| BPDESIGNEDSKILL | 009・048 | 009 | 同じ能力の条件に統合 |
| BPDESIGNEDSKILL | 010 | 010 | 保持 |
| BPDESIGNEDSKILL | 011・043・044・047 | 011 | 同じ能力の条件に統合 |
| BPDESIGNEDSKILL | 012 | 012 | 保持 |
| BPDESIGNEDSKILL | 013 | 013 | 保持 |
| BPDESIGNEDSKILL | 014・045・049・050 | 014 | 同じ能力の条件に統合 |
| BPDESIGNEDSKILL | 015 | 015 | 保持 |
| BPDESIGNEDSKILL | 016・017 | 016 | 同じ能力の条件に統合 |
| BPDESIGNEDSKILL | 019・020 | 019 | 同じ能力の条件に統合 |
| BPDESIGNEDSKILL | 021 | 021 | 保持 |
| BPDESIGNEDSKILL | 022・023 | 022 | 同じ能力の条件に統合 |
| BPDESIGNEDSKILL | 024・037・041 | 024 | 同じ能力の条件に統合 |
| BPDESIGNEDSKILL | 025 | 025 | 保持 |
| BPDESIGNEDSKILL | 026 | 026 | 保持 |
| BPDESIGNEDSKILL | 027 | 027 | 保持 |
| BPDESIGNEDSKILL | 028 | 028 | 保持 |
| BPDESIGNEDSKILL | 029・030・039 | 029 | 同じ能力の条件に統合 |
| BPDESIGNEDSKILL | 031・032 | 032 | 同じ能力の条件に統合 |
| BPDESIGNEDSKILL | 034・038 | 034 | 同じ能力の条件に統合 |
| BPDESIGNEDSKILL | 035 | 035 | 保持 |
| BPDESIGNEDSKILL | 036 | 036 | 保持 |
| BPDESIGNEDSKILL | 033・040・042 | 040 | 同じ能力の条件に統合 |
| BPDESIGNEDSKILL | 046 | 046 | 保持 |
| BPDESIGNEDSKILL | 051 | 051 | 保持 |
| BPOPERATIONS | 001・002・039 | 001 | 同じ能力の条件に統合 |
| BPOPERATIONS | 003・004・016・017 | 003 | 同じ能力の条件に統合 |
| BPOPERATIONS | 005・006 | 005 | 同じ能力の条件に統合 |
| BPOPERATIONS | 007・008 | 008 | 同じ能力の条件に統合 |
| BPOPERATIONS | 009 | 009 | 保持 |
| BPOPERATIONS | 010・012 | 010 | 同じ能力の条件に統合 |
| BPOPERATIONS | 011 | 011 | 保持 |
| BPOPERATIONS | 013・047 | 013 | 同じ能力の条件に統合 |
| BPOPERATIONS | 014・023・045・046 | 014 | 同じ能力の条件に統合 |
| BPOPERATIONS | 015 | 015 | 保持 |
| BPOPERATIONS | 018 | 018 | 保持 |
| BPOPERATIONS | 019 | 019 | 保持 |
| BPOPERATIONS | 021・044 | 021 | 同じ能力の条件に統合 |
| BPOPERATIONS | 022・042 | 022 | 同じ能力の条件に統合 |
| BPOPERATIONS | 024 | 024 | 保持 |
| BPOPERATIONS | 025・026 | 025 | 同じ能力の条件に統合 |
| BPOPERATIONS | 027・028・029・050 | 028 | 同じ能力の条件に統合 |
| BPOPERATIONS | 030 | 030 | 保持 |
| BPOPERATIONS | 031・043 | 031 | 同じ能力の条件に統合 |
| BPOPERATIONS | 032 | 032 | 保持 |
| BPOPERATIONS | 033・034・035 | 033 | 同じ能力の条件に統合 |
| BPOPERATIONS | 036 | 036 | 保持 |
| BPOPERATIONS | 020・037 | 037 | 同じ能力の条件に統合 |
| BPOPERATIONS | 038・048・049 | 038 | 同じ能力の条件に統合 |
| BPOPERATIONS | 040・041 | 040 | 同じ能力の条件に統合 |
| BPOPERATIONS | 051 | 051 | 保持 |
| BPOPERATIONS | 052 | 052 | 保持 |

検証の範囲: 文書の能力・制約の保持と責務の分離を対象とする。既存実装のテスト結果を整理後仕様の実装完了へ読み替えない。閉じた決定規則・状態遷移の検査候補は整理後本文から抽出し、自然言語の意味と実装の適合は独立レビューで確認する。
