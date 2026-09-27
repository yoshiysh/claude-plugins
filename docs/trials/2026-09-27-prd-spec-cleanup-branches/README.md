# prd-spec（refactor/prd-spec-lean 版）試走レポート: cleanup-branches

対象ブランチ: `refactor/prd-spec-lean` @ `bfab2c5`（yoshiysh/claude-plugins#109 の head）。
skillDir: `plugins/workflow/skills/prd-spec`。

## 1. 概要

題材は `plugins/git/skills/cleanup-branches`（`SKILL.md` 232 行を `W/input.md` に逐語で貼付）。
entry は `new`、`existing_docs` は空。保存先は `docs/cleanup-branches/{requirements,specifications}/` を
予定していたが、結果が blocked のため実際には保存していない。

Workflow（`scripts/prd.js`）は 4 回呼び出した。

1. `from: 1` → `needs_answers`（G0、9 問: RS-002, 003, 004, 005, 006, 007, 008, 011, 012）
2. `from: 3a` → `needs_answers`（G0-2、1 問: RS-020。RS-005 の自由記述から生成された追加質問）
3. `from: 3a` → `needs_answers`（G1、3 問: RS-022, 027, 028。この時点で RS-021 が保持規則になった）
4. `from: 3a'` → `blocked`。理由は「2 パスの改稿と監査の後も blocking が 2 件残りました」。
   remaining_blocking は r3-gr-…-001 / -002（いずれも `route: writer`）、holds は RS-021・RS-032。

依頼者への質問は合計 13 問（G0 9・G0-2 1・G1 3）。AskUserQuestion の 4 問制限により G0 は
3 回（4・4・1 問）に分けて提示した。

結果は blocked で終了し、要求文書は保存していない。保持規則 2 件（RS-021・RS-032）と Issue 文案は
`evidence/prd-report.md` に残っている。

## 2. 計測

### 2.1 run ごと（`evidence/orchestrator-log.md` の task-notification usage より）

| run | from | 結果 | agent 数 | subagent_tokens | tool_uses | duration_ms |
|---|---|---|---:|---:|---:|---:|
| 1 | 1 | needs_answers (G0) | 4 | 418,873 | 49 | 527,685 |
| 2 | 3a | needs_answers (G0-2) | 2 | 195,945 | 29 | 324,050 |
| 3 | 3a | needs_answers (G1) | 8 | 1,007,837 | 159 | 1,842,409 |
| 4 | 3a' | blocked | 10 | 1,115,341 | 162 | 1,174,061 |
| 合計 | — | — | 24 | 2,737,996 | 399 | 3,868,205 |

合計は 4 run の単純和（418,873+195,945+1,007,837+1,115,341 = 2,737,996 tokens、
49+29+159+162 = 399 tool_uses、527,685+324,050+1,842,409+1,174,061 = 3,868,205 ms）。
agent 数の合計 24 は `evidence/usage.json` の `agents: 24` と一致する。

### 2.2 usage.py の集計（`evidence/usage.json` / `evidence/usage.txt`）

- workspace: `/root/.claude/prd-spec-workspace/cleanup-branches`
- agents: 24（excluded なし）、turns: 350
- input_all: 33,647,837 内訳 = input 700 + cache_read 31,129,356 + cache_creation 2,517,781
  （700 + 31,129,356 + 2,517,781 = 33,647,837、一致）
- output: 46,287
- busy_seconds: 3,834.9、span_seconds: 5,972.4
  - busy/span = 3834.9 / 5972.4 ≈ 0.642（実働時間は壁時計の約 64%）
- by_model: `claude-opus-5-5` turns 325（input 650、cache_read 28,760,674、cache_creation 2,389,722、
  output 46,126）、`claude-sonnet-5` turns 25（input 50、cache_read 2,368,682、cache_creation 128,059、
  output 161）。sonnet は 24 agent 中 1 体（`crossDoc:r1:all`）のみ。
  - opus + sonnet の turns = 325 + 25 = 350（total.turns と一致）
- cache_read 比率: 31,129,356 / 33,647,837 ≈ 0.925（input_all の約 92.5% が cache_read）
- per_agent の `first_turn_input` は 24 件全て 62,583〜67,587 の範囲に収まる
  （最小 62,583 は `agent-ae4bdcfb59941886f`、最大 67,587 は sonnet の `agent-a3fb43d8e04855bf4`）。

### 2.3 役割ごと（`evidence/agents_by_run.json`）

| run | label | model | tokens | toolCalls | durationMs |
|---|---|---|---:|---:|---:|
| 1 | intake | opus-5-5 | 94,199 | 9 | 102,634 |
| 1 | flow-framer | opus-5-5 | 103,059 | 12 | 160,107 |
| 1 | resolver:3 | opus-5-5 | 113,043 | 12 | 144,189 |
| 1 | verifier:3v | opus-5-5 | 108,572 | 16 | 104,845 |
| 2 | resolver:3a | opus-5-5 | 117,117 | 19 | 278,417 |
| 2 | verifier:3av | opus-5-5 | 78,828 | 10 | 43,571 |
| 3 | resolver:3a | opus-5-5 | 109,623 | 19 | 265,631 |
| 3 | verifier:3av | opus-5-5 | 79,370 | 11 | 41,257 |
| 3 | writer:U-1:draft | opus-5-5 | 155,127 | 26 | 502,622 |
| 3 | implementer:r1:requirements/cleanup-branches | opus-5-5 | 142,586 | 17 | 237,051 |
| 3 | grounding:r1:requirements/cleanup-branches | opus-5-5 | 141,183 | 21 | 260,026 |
| 3 | crossDoc:r1:all | sonnet-5 | 128,065 | 28 | 316,103 |
| 3 | resolver:6 | opus-5-5 | 161,979 | 27 | 416,953 |
| 3 | verifier:6v | opus-5-5 | 89,904 | 10 | 53,545 |
| 4 | resolver:3a' | opus-5-5 | 103,734 | 14 | 108,427 |
| 4 | writer:U-1:revise | opus-5-5 | 121,577 | 19 | 238,564 |
| 4 | grounding:r2:requirements/cleanup-branches | opus-5-5 | 137,093 | 20 | 146,204 |
| 4 | implementer:r2:requirements/cleanup-branches | opus-5-5 | 132,764 | 19 | 258,549 |
| 4 | resolver:6 | opus-5-5 | 111,141 | 17 | 126,180 |
| 4 | verifier:6v | opus-5-5 | 85,119 | 11 | 59,918 |
| 4 | writer:U-1:revise | opus-5-5 | 97,416 | 13 | 70,782 |
| 4 | grounding:r3:requirements/cleanup-branches | opus-5-5 | 113,190 | 22 | 206,371 |
| 4 | implementer:r3:requirements/cleanup-branches | opus-5-5 | 111,672 | 14 | 224,846 |
| 4 | resolver:final | opus-5-5 | 101,635 | 13 | 78,919 |

`crossDoc` だけ sonnet で、他は全て opus。これは `workflow-io.md` §2 の役割別 model 既定
（`crossDoc` は sonnet、他の役割は opus）と model の面では一致する。`agents_by_run.json` は
model しか記録していないため、effort（medium/high）が既定どおりだったかは観測していない。

writer は run3 の `writer:U-1:draft` の後、run4 で `writer:U-1:revise` が 2 回起きている（改稿 2 パス）。
`workflow-io.md` §4 の段 8 の行は「改稿の後は必ず」起動し、「blocking が残れば 6 へ（2 パスまで）、
それでも残れば blocked」としており、この 2 回の revise と run4 の結果が blocked だったことはこの上限と符合する。

### 2.4 next_args の大きさ

next_args（JSON 文字数、ファイル実測）: G0 後 17,757、G0-2 後 16,727、G1 後 21,780。いずれも
`state.flow`（流れ図の全要素）を含む。司令塔はこれを Workflow の args に手で逐語転記して 3 回渡した。

## 3. 監査の推移

usage.py の集計（`evidence/usage.json` の `findings`）:

| 監査 | findings | blocking | items |
|---|---:|---:|---:|
| r1 | 11 | 6 | 9 |
| r2 | 4 | 2 | 4 |
| r3 | 3 | 2 | 3 |

段 8 の上限（2 パス）まで改稿しても r3 の blocking 2 件は解消しなかった。

残った 2 件（`evidence/r3-gr-requirements__cleanup-branches.json`）はどちらも `route: writer`、
`direction: relax`。

- `-001`（PR-CLEANUP-059）: 「PR が CLOSED であるか PR が無いと確かめられた remote のブランチ」の
  「と確かめられた」という限定に根拠が無く、入力 L57（gh が使えない環境では分類が要判断に寄るとする記述、
  D-009・F-010 の出典）に反する、という指摘。
- `-002`（§用語「要判断」）: 定義文に -001 と同じ根拠の無い限定がある、という指摘。

r1 の findings（`evidence/r1-gr-requirements__cleanup-branches.json`・
`evidence/r1-im-requirements__cleanup-branches.json`・`evidence/r1-cd-all.json`、計 11 件）には
PR-CLEANUP-059 への指摘は無い（3 ファイルとも `059` を検索して該当 0 件）。一方 r2 の findings
（`evidence/r2-gr-requirements__cleanup-branches.json`）には次の指摘がある。

> `r2-gr-requirements__cleanup-branches-001`（item_id: PR-CLEANUP-059、blocking: true、route: writer、
> direction: **tighten**）
> quote: 「システムは、基準ブランチ以外で取り込み済みと確かめられないブランチのうち、remote で削除済みの
> ローカルブランチと remote のブランチを、要判断に分類しなければならない。」
> issue: 「trace の引用 input L136『`remote.needs_decision`（未取り込みで remote に残存）: CLOSED PR や
> PR の無いブランチ。』は remote 側の要判断を CLOSED PR か PR の無いブランチに限っているが、本文は取り込み済みと
> 確かめられない remote ブランチ全部を要判断にしており、基準ブランチを base とする open の PR の head である
> remote ブランチまで問いかけと承認済み削除の対象に入る。」
> direction_note: 「要判断に含める remote ブランチを、trace の引用が述べる範囲に限る（§用語 の要判断の定義も
> 同じ範囲に揃える）」

r2 のこの指摘（direction: tighten、根拠は入力 L136）を受けて 2 パス目の writer が本文を
「PR が CLOSED であるか PR が無いと確かめられた」まで狭めた。その狭めた文面に対して、r3-gr
（`evidence/r3-gr-requirements__cleanup-branches.json`）が今度は入力 L57 を根拠に direction: **relax**
（同じ限定を外す）を指摘した。

> `r3-gr-requirements__cleanup-branches-001` issue（抜粋）: 「『PR が CLOSED であるか PR が無いと確かめられた
> remote のブランチ』の『と確かめられた』は入力・決定・resolution・flow のどこにも根拠が無く、入力 L57
> （D-009 が逐語で引用し、F-010 の『gh が使えない』枝の出典）が『gh が使えない環境では PR 経路が落ちるだけで
> …分類は安全側（要判断）に寄る』と定めた場合を要判断から外しており、入力に違反している。」

つまり、同じ grounding という役が監査のパスごとに異なる入力行（r2 は input L136、r3 は input L57）を
根拠に、互いに逆向きの指示（r2: 絞れ / r3: 広げろ）を出し、writer はそのつど従っている。これが r3 の
blocking として最後まで残った。r3-gr の `checked` 欄はこの範囲（`diff-audited-2` の changed 8 件・
added 1 件）を原文で読んだことを記しており、PR-CLEANUP-059 と §用語がその changed に含まれることは
確認できるが、そこから言えるのは「2 パス目の改稿でこの 2 項目の文面が変わった」ことまでである。

r3-gr は同じ `checked` 欄で、「merged の PR の head と名前で一致しマージ後の commit を持つ remote ブランチ
（PR-CLEANUP-063 で取り込み済みから外れ、MERGED なので 059 の要判断にも当たらない）」の行き先が無いことを
把握しているが、grounding の観点の守備範囲外として指摘にはしていない、と明記している。

## 4. 分かったこと（スキルの改善候補）

### 4.1 next_args の手動転記

観測: next_args は G0 後 17,757 文字（約 17.8KB）・G0-2 後 16,727 文字（約 16.7KB）・G1 後 21,780 文字
（約 21.8KB）で、いずれも `state.flow`（流れ図の全要素）を含む。司令塔はこの JSON を 3 回、手で
Workflow の args に逐語転記した。

制約: `workflow-io.md` は「`scripts/prd.js` は…段の順序・起動の条件・上限・返り値の検査だけを持つ
Workflow script である。ファイルを読めないので、分岐に使う値（件数・ID・digest・flow 本体）はすべて
agent の返り値から受け取り、`next_args.state` に載せて返す」としている（§1）。つまり state をファイル
経由にしない今の形は、`prd.js` 自身がファイルを読めないという制約に沿った意図どおりの設計であり、
`grep -n "state_path\|readFile" scripts/prd.js` の該当 0 件（`orchestrator-log.md` に記載）はその
結果である。

影響: `workflow-io.md` §1 は依頼文を args に入れない理由を「司令塔が手で組む args が数十万字になり、
写し間違いがそのまま入力になる」としている。next_args の手動転記は規模は一桁小さいが同じ形の危険
（写し間違いがそのまま state を変える）を負っている。実際、task-notification の result プレビューでは
next_args 内の `<` `>` が `&lt;` `&gt;` に置換されて表示され（例: `"git branch -D &lt;name&gt;"`）、
output ファイル（JSON）では `<name>` のまま保たれている。プレビューから転記すると state が変わりうる。

候補: `prd.js` 自身にファイルを読ませることはできないので、state 本体を W 内のファイルに書く役目は
agent 側に持たせ、`prd.js` の返り値（ひいては次呼び出しの `next_args`）にはそのファイルへの参照だけを
載せる形にする。司令塔が逐語転記するものを縮められれば、転記量に比例する写し間違いの余地も縮まる。

### 4.2 agent 1 体あたりの初回ターン入力がほぼ一定

観測: 24 agent の `first_turn_input`（`usage.py` が集計する、最初の応答が受け取った入力トークン数）は
全て 62,583〜67,587 の狭い範囲に収まっている。`prd.js` の `header()`（L540-541 付近）は各役割への
プロンプトに「最初に `${SKILL_DIR}/agents/${ROLE_FILES[role]}` を Read し」「`schemas/agent-contracts.md`
の…節だけを offset/limit で Read する」という指示を書くだけで、役割ファイルや契約そのものの本文を
埋め込んでいない。したがって `first_turn_input` は Read が実行される前の基底文脈（プロンプトそのものと
システム側の文脈）であり、役割ファイル・契約の本文はそれ以降のターン（Read/Grep の結果として）に乗る。
初回ターンの入力の中身が何で構成されているかは、この試走の evidence からは未確認である。

一方で input_all 33,647,837 のうち cache_read が 31,129,356（約 92.5%）を占め、output は 46,287 と
input_all に比べて極小（46,287 / 33,647,837 ≈ 0.14%）。

影響: agent 1 体あたりの初回ターンの入力（Read の前の基底文脈）が約 63K でほぼ一定、以降のターンの
入力のほとんどが cache_read という構造になっている。トークン量（コストではない。モデル単価は入れていない）
は、この基底文脈がほぼ一定という条件のもとでは、エージェントのターン数と相関する。24 agent の
per_agent データで turns と（input + cache_read + cache_creation）の相関係数を計算すると r ≈ 0.986
（`evidence/usage.json` の `per_agent` から算出）であり、turns 350（うち opus 325・sonnet 25）が
トークン量の主要な説明変数になっている。

### 4.3 上限 2 パスで残った 2 件は、2 パス目の改稿がその場で持ち込んだ根拠欠如

3 節のとおり、残った blocking 2 件（PR-CLEANUP-059・§用語「要判断」）は、r2-gr が入力 L136 を根拠に
狭めを指摘し（direction: tighten）、2 パス目の writer がそれに従って「と確かめられた」という限定を
足したところ、r3-gr が今度は入力 L57 を根拠に同じ限定を外すよう指摘した（direction: relax）、という
連鎖の結果である。r1 の findings にはこの項目への指摘が無い。段 8 の上限 2 パスで blocked に落ちたこと
自体は設計どおりの動作であり、それ自体を欠陥とは書かない。改善候補として書けるのは、grounding の
`direction_note` が指摘のたびに入力内の 1 か所（L136 または L57）だけを根拠にしており、同じ規範（要判断
の remote ブランチの範囲）に関わる入力内の競合する複数行（L136 と L57）を突き合わせていない、という点で
ある。

### 4.4 skill_telemetry.py が prd-spec の現行の返り値を読めない（#109 が持ち込んだ回帰）

観測: `skill_telemetry.py record` を 4 run 分実行した
（`~/.claude/skill-telemetry/prd-spec/cleanup-branches-lean-run{1..4}.json`）。summary の出力は
全 run で verdict/dry/nov/tail/rev/fab/unpres が None、「dry_stop 到達 0/4」だった。

原因（コードで確認済み）: `skill_telemetry.py` の `extract()`（L46-69）は返り値から
`verdict`・`dry_stop`・`novelty_history`・`revisions_used`・`summary.fabrication_findings` などの
`summary.*`・`unpresented_blocking` を読む。同ファイル L9 のモジュール docstring は対象を
「Workflow 返り値（prd-spec の refine.js など、構造化 summary を返す script）」と明記している。
一方、現在の `prd.js` の `finish()`（L520-533）が返すのは
`{status, questions_path, report_path, next_args, open_tbd, holds, missed, integrity, undeclared, ...}`
で、`extract()` が読むフィールドは 1 つも含まれていない。

`refine.js`・`draft.js` はコミット `92dcd12`（`refactor(prd-spec): draft.js と refine.js を prd.js 1 本に
統合し…`）で削除されており、この commit は `origin/refactor/prd-spec-lean`（#109 の head である
`bfab2c5` を含むブランチ）の祖先である。同じ commit の diff 一覧に `skill_telemetry.py` の変更は
含まれておらず、`goal_selector.py` も同様に未更新のまま残っている
（`goal_selector.py` L30 前後のコメントは「現状の RULES の field 名は prd-spec（refine.js）の返り値
スキーマそのもの」「未登録スキルはエラーで止める」と明記しており、同じ refine.js 前提を持つ）。
したがって `skill_telemetry.py` の summary が全 None になる原因は、#109（`refine.js`/`draft.js` の削除）が
`skill_telemetry.py` 側を追随させずに持ち込んだ回帰であるとコードから確認できる。`goal_selector.py` 側の
実行時の挙動（実際にエラーで止まるか、無言で欠測を出すか）は未確認である。

### 4.5 G0 の質問のうち、回答がいずれも「無い」だったもの

観測として書く（評価ではない）。G0 の 9 問のうち RS-002・RS-003 は次の内容で、`evidence/questions-g0.md`
から逐語で引用する。

> **RS-002**: 「ブランチや workspace を消すことに、法令・社内の決まり・契約で『残しておかなければならない』
> という義務はかかっていますか?」— 選択肢は「義務はない」「義務がある」。
>
> **RS-003**: 「ブランチや workspace を消した記録（誰が何をいつ消したか・誰が承認したか）を、監査などの
> ために残す必要はありますか?」— 選択肢は「残す必要はない」「残す必要がある」。

`evidence/answers-g0.md` の回答はそれぞれ「義務はない」「残す必要はない」であり、いずれも「無い」側の
選択肢が選ばれた。

### 4.6 W/tmp に版の控えが 18 本残った

観測: `orchestrator-log.md`（追記分）によれば、`W/tmp/` に agent が作ったファイルが 18 本残っている
（ls で確認）。内訳は生成用の Python script 5 本（`gen.py`・`apply3a.py`・`gen_meta_u1.py`・`gen6.py`・
`rev7.py`）と、版の控え 13 本（`flow.bak`/`pre3a2`/`pre3a3`/`flow_min.json`、
`questions.bak`/`pre6` の json・md、`resolutions.bak`/`pre3a2`/`pre3a3`/`pre6`/`pre9.json`）。
どの役が作ったかは transcript で確認していない。

この観測は #109 の PR 本文が問題に挙げているという指摘（版ごとのコピーを作っていたことを問題視し、
「版コピーは作らない」としている）と合わせて見るべきものだが、PR 本文そのものはこの試走の evidence
には含まれておらず独立に確認していない。書くならスコープを絞って「#109 の PR 本文によれば」とする
必要がある観測であり、ここではその出所の限定を明記したうえで記録するにとどめる。

## 5. 残したもの

保持規則 2 件（RS-021・RS-032）と対応する Issue 文案は `evidence/prd-report.md` にある。

- RS-021（対象: `{"open": "O-005"}`）: 終了済み workspace の確認なし削除が失敗したときの続行/停止の裁定が
  下るまで、要求・仕様として定めない。
- RS-032（対象: `{"finding": "r3-im-requirements__cleanup-branches-001"}`）: merged の PR の head との
  一致をブランチ名だけで判定するか、その PR が作られた元のブランチであることまで求めるかの裁定が下るまで、
  名前だけが一致し出所を確かめられないブランチを取り込み済みに分類・確認なし削除しない。

Issue はいずれも起票していない（承認を得てから行う運用のため）。要求文書 `requirements-cleanup-branches.md`
は blocked のまま保存していない。この扱いは `plugins/workflow/skills/prd-spec/SKILL.md` L102 の
「blocked のまま保存しない」という記述に基づく（プロジェクト全体の規則ではなく、prd-spec スキル自身の
規則）。

## 6. 再現

- W（ワークスペース）: `/root/.claude/prd-spec-workspace/cleanup-branches`
- skillDir: `/home/user/claude-plugins/plugins/workflow/skills/prd-spec`
- 入力: `plugins/git/skills/cleanup-branches/SKILL.md`（232 行）を `W/input.md` に逐語で貼付。
  `W/input.md` は前書き 5 行 + SKILL.md 232 行の計 237 行で、監査の指摘が引く「入力 L57」「入力 L136」
  は `W/input.md` の行番号であり、SKILL.md 側の行番号とは 5 行ずれる（`W/input.md` L57 は
  SKILL.md L52 と同一内容、L136 は SKILL.md L131 と同一内容であることを確認済み）。
- 1 回目の呼び出し args の形:
  ```json
  {
    "workspace": "~/.claude/prd-spec-workspace/cleanup-branches",
    "skillDir": "/home/user/claude-plugins/plugins/workflow/skills/prd-spec",
    "entry": "new",
    "existing_docs": []
  }
  ```
- 2 回目以降: `W/answers/g0.md`・`g0-2.md`・`g1.md` に回答を逐語で書いたうえで、直前の run が返した
  `next_args`（`from` を含む。`from` は司令塔が選ぶ値ではなく、`prd.js` が返り値として決めて渡す値であり、
  `workflow-io.md` は「`next_args` は完成形である。司令塔は回答を `answers_path` に逐語で書き、
  `next_args` を変えずに渡すだけでよい」としている）をそのまま渡した。結果として `from` は
  `1 → 3a → 3a → 3a'` と進んだ。
- usage.py の呼び方（`evidence/orchestrator-log.md` 追記分より）:
  `python3 scripts/usage.py --json --workspace /root/.claude/prd-spec-workspace/cleanup-branches <4 run
  分の transcript ディレクトリ>`。`--workspace` と各 run の transcript ディレクトリの指定が必須で、
  `--json` を付けると `usage.json` の形、外すと `usage.txt` の形で出る。

## 参考

- `evidence/orchestrator-log.md`
- `evidence/usage.json` / `evidence/usage.txt`
- `evidence/agents_by_run.json`
- `evidence/prd-report.md`
- `evidence/answers-g0.md` / `answers-g0-2.md` / `answers-g1.md`
- `evidence/questions-g0.md` / `questions-g0-2.md` / `questions-g1.md`
- `evidence/r1-gr-requirements__cleanup-branches.json` / `r1-im-requirements__cleanup-branches.json` /
  `r1-cd-all.json`
- `evidence/r2-gr-requirements__cleanup-branches.json` / `r2-im-requirements__cleanup-branches.json`
- `evidence/r3-gr-requirements__cleanup-branches.json` / `r3-im-requirements__cleanup-branches.json`
