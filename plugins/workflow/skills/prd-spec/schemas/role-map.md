# role-map（1 role = 1 責務の正本）

**この表がロール設計の正である。** 各 `agents/*.md` は担当ロールの詳細（判定基準・書き方）を
持つが、責務の宣言がこの表と食い違ったら**この表に合わせて agent md を直す**。
`scripts/draft.js` / `scripts/refine.js` の冒頭コメントもこの表を参照する。

## 設計規範

> **検証者（auditor / judge 系）は判定と事実指摘のみ。解決策の設計・要求文の文案・候補の起草は
> 生成側の責務。1 role = 1 責務。**

この境界を破ると何が壊れるか: 検証者が文案を書くと、(1) writer が監査者の文案にアンカリングし、
根拠から書く代わりに文案を写す（実測済みの実害）、(2) 生成と検証が同一 role に混ざり、その文案を
誰も検証しない、(3) 監査指摘の再現性が「指摘の事実」ではなく「文案の好み」に依存して総数が
減らなくなる。だから検証者が出せるのは**判定・事実・方向（`direction`）まで**であり、文そのものは
常に生成側（writer / resolver）が起草し、生成物は必ず別の検証者（auditor / resolver-verifier）を通る。

## 全 step のロール表

処理順（intake → … → 統合ゲート）に並べる。「責務」は各 role にちょうど 1 つ。

| step | role | 種別 | 責務（1 つ） | やること | やらないこと | なぜ（破ると何が壊れるか） |
|---|---|---|---|---|---|---|
| 1 | intake | 生成（判断の起票） | 論点の仕分け（確定 / 決定 / 質問） | 既定を選べる論点は decisions に起票し、選べないものだけ質問にする | 文書本文の執筆・要求の創作 | 仕分けと執筆が混ざると、質問 0 件の目標が「書いて埋める」で達成されて捏造になる |
| 2 | domain-analyst | 検証（三値判定） | 10 観点の該当判定と根拠の提示 | 各観点を該当 / 非該当 / 不明で判定し、入力からの根拠を添える | 要求カテゴリの中身の起草 | 分析係が要求を書くと、入力に無い要求が「分析結果」の顔で確定する |
| 3 | splitter | 生成（構成案） | 文書分割案の起草 | topic / concern / covers の分割案を出す | 分割案の自己承認・本文の執筆 | 承認まで持つと、再実行のたびに構成が変わり既存文書が消える |
| 3b | flow-framer | 生成（軸の起草） | 対象の工程の流れ（PFD）の起草 | 入力・工程・判断（値ごとの行き先）・出力を描き、要素の種類を性質で閉じる | 要求・仕様の文面・分割・既定の選定 | 流れを持たずに書くと、書かれなかった工程と分岐の値が文書のどこにも現れず、依頼者への質問に化けて戻る |
| 4 | req-writer / spec-writer | 生成 | 担当 1 文書の本文の起草・改稿 | 根拠原本だけから本文・trace・TBD を書く。指摘は direction を手がかりに自分で文案を決める | 監査判定・他文書の執筆・（[WRITE_BACK] 指定外の）ファイル書き込み | writer が判定を兼ねると自己承認になり、検査されていない版が成果物になる |
| 5 | structural（script） | 検証（決定的算術） | 集合差分・禁止語の機械検査 | ID / TBD / trace の突き合わせと完全一致の語彙検査、状態 × イベント表・判定表・工程の流れの網羅と一意と到達。決定的な指摘（是正手順を含む）を出す。本文を読む部分は `scripts/doc_check.mjs` が正本で、checker agent はそれを実行して出力を返すだけ（digest で写しを照合する） | 意味の判定（checker も判定・取捨・要約をしない） | 算術を agent の善意に載せると、落ちた auditor が「指摘 0 件」に化ける |
| 6 | 8 観点 auditor（executability / clarity / traceability / coverage / fabrication / consistency / validity / specimen） | 検証 | 担当観点の欠陥の判定と事実指摘 | quote・issue・repro と `direction`（解消の方向）を返す | 解消文・候補値・改訂文案の起草（`direction_note` は方向の補足 1 行まで） | 検査者の文案に writer がアンカリングし、根拠ではなく文案から書く（実測） |
| 7 | ladder-judge | 検証（分類） | 指摘の failure kind 分類（戻り先の決定） | artifact / criteria / consistency / premise / question の 5 分類と rationale（consistency は食い違う項目を cited に挙げる） | 指摘の修正・棄却・解消案の起草 | 分類係が直し始めると、needs_input へ返すべき指摘が改稿予算を消費する |
| 8 | resolver | 生成 | 指摘・TBD に対する解消候補の起草 | finding（issue + direction）と根拠から、選択肢（summary / draft_text / tradeoff）を起草する | 指摘の真偽の裁定（反例が構成できない**事実の報告**まで。偽と断ずるのは adjudicator） | 起草役が裁定を兼ねると、候補を出したくない指摘が「偽」に分類される |
| 9 | resolver-verifier | 検証 | resolver 候補の合否判定 | 各候補が (a) decisions と矛盾しない (b) 原本に無い事実を捏造していない (c) direction と整合する、を pass / reject で判定する | 候補の書き直し・改良案の提示 | 検証者が書き直すと、その書き直しを誰も検証しない（resolver と同じ穴が復活する） |
| 10 | precedent-judge | 検証（分類） | 未提示 blocking の裁定可能性の分類 | resolvable / internal / measurable / novel / conflict / irreversible と precedent_ids（internal は cited） | 解消文の起草（resolvable の文案は resolver の責務） | judge が文案まで書くと、先例の「当てはめ」が実質の新規裁定に化ける |
| 11 | measurement | 検証（実測） | 現物を読んだ事実の確定 | Read / Grep で証拠付きの事実（statement + evidence）を返す。確定できなければ resolved: false | 推測での補完・「今後どうすべきか」の判断・ファイルの変更 | 実測の体裁をまとった推測は下流の監査を素通りする |
| 12 | adjudicator | 検証（終端裁定） | 残指摘の三値分類（fixed / rejected / documented） | digest ごとに分類し、根拠（evidence / reason）を返す。documented は転記先と理由まで | 転記文の起草（文案は転記改稿時の writer の責務） | 裁定者の文案が本文に直行すると、検証されない文が成果物に入る |
| 13 | writer（転記改稿） | 生成 | documented 裁定の本文への転記 | reason + direction +（あれば）resolver 候補から転記文を自分で起草する | 裁定の再審 | 転記が「裁定文のコピー」になると step 12 の境界が無意味になる |
| 14 | 司令塔（SKILL.md） | 制御 | ゲート運営・保存・Issue 起票 | 提示・回答収集・正本ファイルの書き出し（sources_path）・保存と事後報告 | 生成文書の手編集・検査式の再実装 | 司令塔が書くと Generator / Verifier の分離が最後の工程で破れる |

## 責務の重複・空白の確認

- **重複が無いこと**: 「生成」列に文案を起草する role は writer（4, 13）と resolver（8）だけ。
  検証系（5, 6, 7, 9, 10, 11, 12）はどれも文案を持たない。分類は ladder-judge（指摘の戻り先）と
  precedent-judge（TBD の裁定可能性）で対象が違い、判定は resolver-verifier（候補）と
  adjudicator（指摘）で対象が違う。
- **空白が無いこと**: 指摘の一生は 6（起票）→ 7（分類）→ 4（改稿）または 8→9→4（stuck 時の
  候補起草→検証→改稿）→ 12（終端裁定）→ 13（documented の転記）で閉じる。TBD の一生は
  4（起票）→ 10（分類）→ 8→9（resolvable・internal の文案）/ 11（measurable の実測）/ ゲート（novel 等）
  → 4（反映）で閉じる。どの経路にも「誰の責務でもない工程」は無い。
