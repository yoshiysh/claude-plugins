# 要求文書: create・update が作るスキルが備える性質

表記規約と用語は `docs/requirements/bp-operations.md` に従う（「対象スキル」の範囲も同文書の用語が定める）。本文書の要求の主語「対象スキル」は、そのうち create が作るスキルと update が作り直したスキルを指す。

## 背景と課題

create と update が作るスキルが設計方針文書に沿っているかを、作る側（create・update）と評価する側（review のフローの観点）が同じ基準で判定できる必要がある。本文書はその基準を、設計方針文書の節を正本として参照する形で定める。原則の中身は設計方針文書だけが持ち、本文書には書き写さない（書き写すと 2 箇所の記述が食い違う）。

## 想定する利用者と利用場面

| 利用者 | 利用場面 |
|---|---|
| create・update | 対象スキルを書くときに満たす性質として参照する |
| review | フローの観点（`docs/requirements/bp-operations.md` PR-BPOPERATIONS-024）で照らす基準として参照する |
| 対象スキルを動かす host（Claude Code・Codex） | 対象スキルが配布先で動く環境として関わる |

## どう使われるか

1. create・update が、対象スキルが入口で目標を固定するようにする（PR-BPDESIGNEDSKILL-006）。
2. create・update が、対象スキルに設計方針文書の「形の判定」を軽い形から順に当て、形を決める。
3. 決めた形に応じて部品を選び、形に関わる原則（PR-BPDESIGNEDSKILL-007〜013）を当てる。
4. 重い形を選んだ条件を、対象スキルの設計の説明に書く。
5. review は、create が作るスキルと update が作り直したスキルに限り、同じ要求に照らして対象スキルのフローを評価する。

## スコープとスコープ外

スコープ: 対象スキルが設計方針文書に適合するための性質。

スコープ外: 設計方針文書が未決事項とする論点のうち、run をまたぐ指摘の追跡の裁定。裁定が下るまでの扱いは保持規則として `docs/requirements/bp-operations.md` の PR-BPOPERATIONS-022・042 に置く。もう一つの未決事項である Codex runner での実行方法のうち、起動数の上限の値の出所は依頼者が裁定済みで、runner が Codex 側で決まる値を指定し、対象スキルがその出所にならないことを PR-BPDESIGNEDSKILL-022 が定める。渡された上限の受け取りと扱いは PR-BPDESIGNEDSKILL-016・017・019・020 が定める。

## 前提と依存

- 原則の正本は設計方針文書（`docs/design/skill-design-patterns.md`）であり、本文書の要求は同文書の節を参照する。
- 対象スキルの配布先には Claude Code と Codex（Codex runner）がある。

## リスクと影響

| ID | 観点 | 判定 | 根拠 |
|---|---|---|---|
| RK-002 | 外部システムとの連携 | 該当 | 対象スキルは配布先の host で動き、役ごとの制限が配布先で効くかと Codex runner での扱いが host に依存する |

## 要求一覧

### 形の判定

#### PR-BPDESIGNEDSKILL-001 形の判定の順序
create と update は、対象スキルの形を、設計方針文書の「形の判定」の節の図の順（軽い形から）に問うて決めなければならない（重い形が既定になると、決まった手順のスキルに探索の費用を払う）。

#### PR-BPDESIGNEDSKILL-002 選んだ形を強いた条件の記録
形の判定で重い形を選んだとき、対象スキルは、形の判定の問いへの答えのうち、選んだ形を強いた条件を設計の説明に書かなければならない（書かないと、重い形が既定になっても気づけない）。

#### PR-BPDESIGNEDSKILL-003 Workflow にしない判定
形の判定が「Claude がターンごとに指揮する」となったとき、対象スキルは Workflow script を持ってはならない。

#### PR-BPDESIGNEDSKILL-004 部品による組み立て
対象スキルが Workflow script を持つ場合、対象スキルは、判定した形の中に設計方針文書の「形の判定」の節が挙げる部品を選んで組まなければならない。

#### PR-BPDESIGNEDSKILL-005 資産台帳の適用条件を満たすとき
設計方針文書の「資産台帳」の節の適用条件を満たすならば、対象スキルは資産台帳を持たなければならない。

#### PR-BPDESIGNEDSKILL-018 資産台帳の適用条件を満たさないとき
設計方針文書の「資産台帳」の節の適用条件を満たさないならば、対象スキルは資産台帳を持ってはならない。

### 形に関わる原則

各要求の理由は、参照する節の表の「守らないと壊れること」の列による。

#### PR-BPDESIGNEDSKILL-006 目標の固定
対象スキルは、入口で、設計方針文書の「目標の固定」の節の原則を満たして目標を固定しなければならない。

#### PR-BPDESIGNEDSKILL-007 停止・再開と人間の入力
対象スキルが Workflow script を持つ場合、対象スキルは、設計方針文書の「停止・再開と人間の入力」の節の原則を満たさなければならない。

#### PR-BPDESIGNEDSKILL-008 体数と同時実行
対象スキルが Workflow script を持つ場合、対象スキルは、設計方針文書の「体数と同時実行」の節の原則を満たさなければならない。

#### PR-BPDESIGNEDSKILL-009 モデル・effort・prompt
対象スキルが Workflow script を持つ場合、対象スキルは、設計方針文書の「モデル・effort・prompt」の節の原則を満たさなければならない。

#### PR-BPDESIGNEDSKILL-010 権限
対象スキルが Workflow script を持つ場合、対象スキルは、設計方針文書の「権限」の節の原則を満たさなければならない。

#### PR-BPDESIGNEDSKILL-011 探索グラフ
対象スキルが探索グラフ型である場合、対象スキルは、設計方針文書の「探索グラフ」の節の原則を満たさなければならない。

#### PR-BPDESIGNEDSKILL-012 状態の書き込み
対象スキルが探索グラフか資産台帳を備える場合、対象スキルは、設計方針文書の「状態の書き込み」の節の原則を満たさなければならない。

#### PR-BPDESIGNEDSKILL-013 資産台帳の原則
対象スキルが資産台帳を備える場合、対象スキルは、設計方針文書の「資産台帳」の節の原則を満たさなければならない。

### 配布先での確認

#### PR-BPDESIGNEDSKILL-014 役ごとの制限の実効性の確認
create と update は、対象スキルの役ごとの制限が、配布先（Claude Code・Codex）のそれぞれで実際に効くかを確かめなければならない（plugin から読み込む agent では設定の一部が無視され、制限が黙って効かないことがある）。

#### PR-BPDESIGNEDSKILL-015 確かめられなかった制限の報告
create と update は、いずれかの配布先で効くかを確かめられなかった役ごとの制限を、残る危険として結果に書かなければならない。

#### PR-BPDESIGNEDSKILL-016 起動数の上限の受け取り
対象スキルの Workflow script が fan-out を含む場合、対象スキルは、runner が Codex 側で決まる値を指定する 1 run で起動する agent の数の上限を、入力として受け取れなければならない（Codex runner は 1 run の agent 呼び出しの総数に上限を課し、超えると run 全体が失敗する。出所は `plugins/workflow/skills/dynamic-workflow-runner/scripts/runtime/README.md`）。

#### PR-BPDESIGNEDSKILL-017 上限を渡された run の起動数
runner が指定する起動数の上限を渡されたとき、対象スキルは、その run で起動する agent の数を上限以下に収めなければならない。

#### PR-BPDESIGNEDSKILL-019 上限に収まらない項目
runner が指定する起動数の上限を渡された run で、上限に収まらず処理していない fan-out の項目が残るとき、対象スキルは、その項目を順位付きの未着手として状態に残して止まらなければならない（切り捨てると、見ていない項目が「見た」と読まれる）。

#### PR-BPDESIGNEDSKILL-020 残した項目からの再開
PR-BPDESIGNEDSKILL-019 で止まった run から再開したとき、対象スキルは、状態に残した未着手の項目から処理を続けなければならない。

#### PR-BPDESIGNEDSKILL-021 上限を渡されない run
起動数の上限を渡されないとき、対象スキルは、fan-out の項目の件数にも、1 run で起動する agent の数にも、固定の上限を置いてはならない（起動数の固定の上限とは、入力に依らず対象スキルが決め打ちする件数をいう。件数を決め打ちすると、PR-BPDESIGNEDSKILL-008 が参照する原則に反する。反復・周・試行の上限はこの要求の対象外とする）。

#### PR-BPDESIGNEDSKILL-022 Codex runner での起動
対象スキルの Workflow script が fan-out を含む場合、対象スキルは、自分の Workflow を Codex runner で起動するとき、起動数の上限の値の出所になってはならない（上限は Codex 側で決まる値を runner が指定する）。

#### PR-BPDESIGNEDSKILL-023 Claude Code の native Workflow での起動
対象スキルの Workflow script が fan-out を含む場合、対象スキルは、自分の Workflow を Claude Code の native Workflow で起動するとき、起動数の上限を渡してはならない。
