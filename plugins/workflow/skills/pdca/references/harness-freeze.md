# 評価 harness の凍結と情報隔離

Plan が固定するのは基準の文だけでは足りない。基準を**測る物**（判定スクリプト・fixture・
LLM 判定なら判定プロンプト）が Do の中で作られると、実行前に固定したはずの基準が実行時に
作り替えられる。ここでは何を凍結し、誰から隠し、どこまでを保証と呼べるかを定める。

## 目次
- なぜ builder に採点物を作らせないか
- 凍結の手順（Plan の最後）
- 誰に何を渡すか
- 保証の強さ（強制 / 構造 / 事後検出）
- class ごとの適用限界
- 採らなかった手段とその理由

## なぜ builder に採点物を作らせないか

builder は成果物と、その成果物を観測するための**測定点**（ログ・カウンタ・出力ファイル）を
作る。ここまでは builder の仕事で、変えない — 観測材料は成果物の内側にしか埋め込めない。

変えるのはその先で、**測定点の生の値を基準に照らして点にする物**（採点ロジック・期待値・
hold-out・判定プロンプト）は builder が作らない。この線を引かないと、評価対象の作者と
評価材料の作者が同一になり、SKILL.md「生成と検証の不変条件」が成果物には適用され、
採点物には適用されない状態になる。実測された事故は 2 つ:

- 判定器が実装との一致しか示さず、実装が間違っていても pass した
- hold-out が決定的スクリプトから再生成できたため、秘匿が成立していなかった

| 誰が作るか | 何を | どこに置くか |
|---|---|---|
| planner（Plan の成果物） | 判定スクリプト・期待値・hold-out・判定プロンプト | 凍結される（`<run-dir>/frozen/`） |
| builder | 成果物と測定点（生の観測値を出す仕掛け） | 作業ツリー（`artifacts`） |
| runner / verifier | どちらも作らない。凍結物を実行・参照して測る | — |

## 凍結の手順（Plan の最後）

`scripts/harness_freeze.py` が決定的処理（複製・digest・凍結時刻）を持つ。workflow script
（`scripts/pdca.js`）には filesystem が無く、`Date.now()` も resume を壊すため runtime が
禁じているので、凍結を script 側に置くしかない。分担は `scripts/ledger.py` と同じで、
**複製と digest は script、harness が契約を満たすかの判断は agent**。

```bash
python3 [SKILL_DIR]/scripts/harness_freeze.py freeze \
  --run-dir <workspace>/<run-id> --source-root <harness の置き場> \
  --json '{"class":"deterministic_script","entry":"score.py","files":["score.py","fixtures/cases.json"],"criteria":{"metric":"pass_rate","higher_is_better":true,"threshold":0}}'
```

返るのは `frozenHarness`（`path` / `entry` / `digest` / `class` / `file_count`）と
`ledger_entry`（`type: harness_frozen`）。後者を編集せず `scripts/ledger.py append` へ流し、
前者を `scripts/pdca.js` の `args.frozenHarness` に渡す。

- **二重凍結は拒否される。** 凍結後の差し替えは Plan の作り直しにあたるので、新しい run-id で行う
- **凍結先が `--source-root` の内側なら拒否される。** builder の作業ツリーに凍結物が同居すると、
  非開示で守っている構造がその場で崩れる
- 照合は `verify --run-dir <run-dir か frozenHarness.path> [--expect <digest>]`。不一致は exit 1。
  凍結ディレクトリ自体を渡しても通る（親の推測を要求すると、呼び方の間違いが「凍結が破れた」
  判定になって run を止める）

## 誰に何を渡すか

凍結物の在処は、渡す相手を script が選ぶことで隠す（agent への「見るな」という指示に
頼らない。`references/ledger.md` の台帳の絞り込みと同じ考え方）。

| agent | `[FROZEN_HARNESS]` | 理由 |
|---|---|---|
| builder | **渡さない** | 採点物の在処を知らなければ、そこへ有利な変更を入れる対象が無い |
| build-verifier | 渡す（path / digest / class） | 成果物が凍結物に触れていないかを照合し、digest を自分で再計算する |
| runner | 渡す | 測定は凍結された入口だけを実行する |
| verifier | 渡す | 採点は凍結された判定物だけを参照する。参照先が digest と違えば `measured: false` |

## 保証の強さ（強制 / 構造 / 事後検出）

**このスキルが主張できるのは「強制」ではない。** 段階を分けて書くのは、凍結を根拠に
「採点の恣意性が消えた」と読める要約を作らないため。

| 段 | 何で担保しているか | 破れる経路 |
|---|---|---|
| **構造（非開示）** | 凍結物は builder の作業ツリー外にあり、パスが builder プロンプトに載らない | builder が自力で探索すれば到達しうる（builder は worktree 分離されていない） |
| **事後検出（digest）** | build-verifier が digest を再計算し、`frozen_harness_digest_ok` として返す。false なら `scripts/pdca.js` は run を 1 本も発行せず BLOCKED | 検出であって阻止ではない。検出前の改変自体は起きうる |
| **事後検出（照合レンズ）** | build-verifier のレンズ 6 が、成果物が凍結 harness を含む・複製する・再生成する・上書きするかを見る | agent の判断なので見落としはありうる |
| **事後検出（独立性レンズ）** | build-verifier のレンズ 7 が、測定点が Plan に対応づいているか・出す値の範囲や除外が成果物の都合で決まっていないかを見る | 同上。凍結物に触らずに生の値の選び方で結果を動かす経路がここで見られる |
| **強制（アクセス制御）** | 採っていない（下記） | — |

`args.frozenHarness` が欠けている・不完全な呼び出しは `scripts/pdca.js` が Build に入る前に
BLOCKED で止める。ここを緩めると凍結は散文の約束になり、渡し忘れた run が「凍結したつもり」で
通る。

## class ごとの適用限界

| class | 凍結が保証すること | 保証しないこと |
|---|---|---|
| `deterministic_script` | 同じ入力に同じ判定が返る。採点の基準が Do の中で変わっていない | harness 自体が主張を捉えているか（それは `criteria_validity` の領分） |
| `llm_judge` | 判定プロンプトと fixture が凍結時のまま。判定者は fresh context で立つ | **判定の同一性は保証されない。** 同じプロンプトでも読みが揺れるので、再現は「同じ指示・同じ材料」までで、「同じ点」ではない |

`llm_judge` で得られるのは**凍結プロンプト + fresh judge** までで、それ以上を主張しない。
判定の揺れは `spread` と `confidence` に現れるべきもので、凍結で消える性質のものではない。

## 採らなかった手段とその理由

**agentType + agent frontmatter hooks（PreToolUse の Read ブロック / Bash ホワイトリスト）による
実行時アクセス制御は採っていない。** 採れなかった理由は 2 つで、どちらも実測ではなく構成上の
制約である（「試したが発火しなかった」ではない）。

1. このスキルの `agents/*.md` は agent が Read する**プロンプト定義**で、Agent tool の
   registry に登録された subagent type ではない。`agentType` を使うには
   `plugins/<plugin>/agents/` 側に登録された agent が必要で、それはこのスキルディレクトリの
   外側にある
2. 配布されている plugin の agent に `hooks:` frontmatter を持つ実例が無く、workflow runtime の
   subagent でそれが発火するかを、このスキル内の変更だけでは実測できない

したがって現状の担保は上の表の**構造 + 事後検出**までである。将来 `plugins/workflow/agents/`
側に hooks 付き agent を登録して発火が実測できたら、この節と保証表を先に更新してから
`scripts/pdca.js` の受け渡しを変える（保証の強さの記述が実装より先に強くならないように）。
