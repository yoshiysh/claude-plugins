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
`report.md` に残っている。

## 2. 計測

### 2.1 run ごと（`orchestrator-log.md` の task-notification usage より）

| run | from | 結果 | agent 数 | subagent_tokens | tool_uses | duration_ms |
|---|---|---|---:|---:|---:|---:|
| 1 | 1 | needs_answers (G0) | 4 | 418,873 | 49 | 527,685 |
| 2 | 3a | needs_answers (G0-2) | 2 | 195,945 | 29 | 324,050 |
| 3 | 3a | needs_answers (G1) | 8 | 1,007,837 | 159 | 1,842,409 |
| 4 | 3a' | blocked | 10 | 1,115,341 | 162 | 1,174,061 |
| 合計 | — | — | 24 | 2,737,996 | 399 | 3,868,205 |

合計は 4 run の単純和（418,873+195,945+1,007,837+1,115,341 = 2,737,996 tokens、
49+29+159+162 = 399 tool_uses、527,685+324,050+1,842,409+1,174,061 = 3,868,205 ms）。
agent 数の合計 24 は `usage.json` の `agents: 24` と一致する。

### 2.2 usage.py の集計（`usage.json` / `usage.txt`）

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

### 2.3 役割ごと（`agents_by_run.json`）

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

`workflow-io.md` §2 の既定どおり、`crossDoc` だけ sonnet/medium 相当で、他は全て opus。
writer は run3 の draft から run4 で 2 回 revise が起きており（改稿 2 パス）、これは
§4 の「1 パス目の段 6 で問いが出た→G1、2 パス目は保持規則」「段 8: blocking が残れば 6 へ（2 パスまで）」
という上限と符合する。

### 2.4 next_args の大きさ

next_args（JSON 文字数、ファイル実測）: G0 後 17,757、G0-2 後 16,727、G1 後 21,780。いずれも
`state.flow`（流れ図の全要素）を含む。司令塔はこれを Workflow の args に手で逐語転記して 3 回渡した。

## 3. 監査の推移

usage.py の集計（`usage.json` の `findings`）:

| 監査 | findings | blocking | items |
|---|---:|---:|---:|
| r1 | 11 | 6 | 9 |
| r2 | 4 | 2 | 4 |
| r3 | 3 | 2 | 3 |

段 8 の上限（2 パス）まで改稿しても r3 の blocking 2 件は解消しなかった。

残った 2 件（`r3-gr-requirements__cleanup-branches.json`）はどちらも `route: writer`、`direction: relax`。

- `-001`（PR-CLEANUP-059）: 「PR が CLOSED であるか PR が無いと確かめられた remote のブランチ」の
  「と確かめられた」という限定に根拠が無く、入力 L57（gh が使えない環境では分類が要判断に寄るとする記述、
  D-009・F-010 の出典）に反する。
- `-002`（§用語「要判断」）: 定義文に -001 と同じ根拠の無い限定がある。

r3-gr の `checked` 欄は「段 8 の範囲監査。`diff-audited-2` の changed 8 件（PR-CLEANUP-007/008/043/059/063/064/065、
§用語）と added 1 件（PR-CLEANUP-066）の本文を原文で読み」と記しており、PR-CLEANUP-059 と §用語は
`diff-audited-2` の changed（= 2 パス目の改稿で変わった項目）に含まれる。つまり残った 2 件の指摘対象は
1 パス目から持ち越された欠陥ではなく、2 パス目の改稿が変えた箇所にそのまま出た指摘である。

r3-gr は同じ checked 欄で、「merged の PR の head と名前で一致しマージ後の commit を持つ remote ブランチ
（PR-CLEANUP-063 で取り込み済みから外れ、MERGED なので 059 の要判断にも当たらない）」の行き先が無いことを
把握しているが、grounding の観点の守備範囲外として指摘にはしていない、と明記している。

## 4. 分かったこと（スキルの改善候補）

### 4.1 next_args の手動転記

観測: next_args は G0 後 17.7KB・G0-2 後 16.7KB・G1 後 21.8KB で、いずれも `state.flow`（流れ図の全要素）を
含む。`prd.js` は state をファイルから読む経路を持たない（`grep -n "state_path\|readFile" scripts/prd.js`
該当 0 件、L513 が `input.state` を直接使う、と `orchestrator-log.md` に記載）。司令塔はこの JSON を
3 回、手で Workflow の args に逐語転記した。

影響: `workflow-io.md` §1 は「args に依頼文の全文を入れない」理由を「司令塔が手で組む args が数十万字に
なり、写し間違いがそのまま入力になる」としている。next_args の手動転記は規模は一桁小さいが同じ形の危険
（写し間違いがそのまま state を変える）を負っている。実際、task-notification の result プレビューでは
next_args 内の `<` `>` が `&lt;` `&gt;` に置換されて表示され（例: `"git branch -D &lt;name&gt;"`）、
output ファイル（JSON）では `<name>` のまま保たれている。プレビューから転記すると state が変わりうる。

候補: state を W 側のファイルに置き、次呼び出しの next_args は小さく（例えばファイルへの参照だけ）保つ
経路を検討する。

### 4.2 費用構造: ターン数 × ほぼ固定の初回文脈

観測: 24 agent の `first_turn_input` は全て 62,583〜67,587 の狭い範囲に収まっており、ほぼ一定である。
一方で input_all 33,647,837 のうち cache_read が 31,129,356（約 92.5%）を占め、output は 46,287 と
input_all に比べて極小（46,287 / 33,647,837 ≈ 0.14%）。

影響: agent 1 体あたりの入力コストは「初回の役割ファイル・契約の読み込み（約 63K、ほぼ固定）＋以降の
ターンのほとんどが cache_read」という構造になっており、費用はエージェントのターン数にほぼ比例して
決まる。turns 350（うち opus 325・sonnet 25）が入力コストの主要な説明変数になっている。

### 4.3 上限 2 パスで残った 2 件がいずれも改稿由来

3.節のとおり、上限 2 パスの改稿を終えても blocking が 2 件残り、その 2 件はどちらも 2 パス目の改稿
（`diff-audited-2` の changed）が変えた項目に出た。段 8 の設計（改稿→再監査→2 パスで打ち切り→blocked）は
今回、1 パス目の指摘を潰す過程で新たな根拠欠如を持ち込んだケースを止め切れずに blocked へ落ちた形になった。

### 4.4 skill_telemetry.py の summary が全 None

観測: `skill_telemetry.py record` を 4 run 分実行した
（`~/.claude/skill-telemetry/prd-spec/cleanup-branches-lean-run{1..4}.json`）。summary の出力は
全 run で verdict/dry/nov/tail/rev/fab/unpres が None、「dry_stop 到達 0/4」だった。

原因: `orchestrator-log.md` は「prd.js の返り値に、この script が読むフィールドが無いため（旧 refine.js
形式を前提としている可能性。未確認）」と記しており、根本原因は未確認である。

### 4.5 G0 の質問に「個人向け開発ツールでは自明に近い」ものが含まれていた

観測として書く（評価ではない）。G0 の 9 問のうち RS-002（保存義務の有無）と RS-003（残す必要の有無）への
回答は `g0.md` によればそれぞれ「義務はない」「残す必要はない」であり、いずれも「無い」という回答だった。

## 5. 残したもの

保持規則 2 件（RS-021・RS-032）と対応する Issue 文案は `evidence/prd-report.md` にある。

- RS-021（対象: `{"open": "O-005"}`）: 終了済み workspace の確認なし削除が失敗したときの続行/停止の裁定が
  下るまで、要求・仕様として定めない。
- RS-032（対象: `{"finding": "r3-im-requirements__cleanup-branches-001"}`）: merged の PR の head との
  一致をブランチ名だけで判定するか、その PR が作られた元のブランチであることまで求めるかの裁定が下るまで、
  名前だけが一致し出所を確かめられないブランチを取り込み済みに分類・確認なし削除しない。

Issue はいずれも起票していない（承認を得てから行う運用のため）。要求文書 `requirements-cleanup-branches.md`
は blocked のまま保存していない（プロジェクトの規則: blocked のまま保存しない）。

## 6. 再現

- W（ワークスペース）: `/root/.claude/prd-spec-workspace/cleanup-branches`
- skillDir: `/home/user/claude-plugins/plugins/workflow/skills/prd-spec`
- 入力: `plugins/git/skills/cleanup-branches/SKILL.md`（232 行）を `W/input.md` に逐語で貼付
- 1 回目の呼び出し args の形:
  ```json
  {
    "workspace": "~/.claude/prd-spec-workspace/cleanup-branches",
    "skillDir": "/home/user/claude-plugins/plugins/workflow/skills/prd-spec",
    "entry": "new",
    "existing_docs": []
  }
  ```
- 2 回目以降: `from` を `3a` → `3a` → `3a'` と進め、直前の run が返した `next_args` をそのまま渡す
  （`W/answers/g0.md`・`g0-2.md`・`g1.md` に回答を逐語で書いたうえで）。
- usage.py の呼び方: `scripts/usage.py --json`（`usage.json` を生成）。素の集計は `usage.txt`。

## 参考

- `evidence/orchestrator-log.md`
- `evidence/usage.json` / `evidence/usage.txt`
- `evidence/agents_by_run.json`
- `evidence/prd-report.md`
- `evidence/answers-g0.md` / `answers-g0-2.md` / `answers-g1.md`
