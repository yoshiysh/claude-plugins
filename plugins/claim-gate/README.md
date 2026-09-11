# claim-gate

Stop hook の主張ゲート。「〜は無い」「〜のみ」「すべて」型の**不在・網羅の断定**に、
網羅検証の裏付けも手段スコープも付いていなければ、排出前に差し戻す。

opt-in（既定 off）・fail-open。**トグルを on にするまで、このプラグインは何もしない。**

## 目次
- [導入手順](#導入手順)
- [無効化する](#無効化する)
- [状態ファイル](#状態ファイル)
- [適合検査の実行](#適合検査の実行)
- [timeout の順序（正本）](#timeout-の順序正本)
- [Codex CLI での利用](#codex-cli-での利用)
- [判定規約とその出所](#判定規約とその出所)
- [fail-open](#fail-open)
- [既知の未決事項](#既知の未決事項)

---

## 導入手順

上から順に実行する。4 まで終えないとゲートは動かない（既定が off のため）。

**1. marketplace を追加する**

```bash
claude
# 対話セッションで:
/plugin marketplace add yoshiysh/claude-plugins
```

**2. プラグインを install する**

```
/plugin install claim-gate@yoshiysh-claude-plugins
```

**3. user レベルで enable する**

```
/plugin
```

表示された一覧から `claim-gate` を選び、**user レベル**で enable する。
user レベルにするのは、`hooks/hooks.json` の Stop 登録を全プロジェクトで効かせるため
（プロジェクト単位にすると、状態ファイルが global 1 ファイルであることと噛み合わない）。

**4. トグルを on にする（ここまでやって初めて発火する）**

先に適合検査（下記）を一度回して同梱物の実在と hook の応答を確認してから、
状態ファイルを書く。

```bash
mkdir -p ~/.claude/claim-gate
printf '{"enabled": true}' > ~/.claude/claim-gate/state.json
```

**いつから効くか**: hook は Stop イベントのたびに状態ファイルを読む。**次の応答の終わりから**
効き、実行中の応答には効かない。

## 無効化する

```bash
printf '{"enabled": false}' > ~/.claude/claim-gate/state.json
```

**切れたことの確認**（opt-in の前提は「切ったことを確認できる」ことなので、確認手段を 2 つ持つ）。

1. 状態を読む — `cat ~/.claude/claim-gate/state.json` が `{"enabled": false}` であること。
   ファイルを削除しても off（欠如・パース失敗・想定外の値はすべて off として解釈する）
2. コード経路を見る — 下記の適合検査を off 区分まで回し、`toggle-off` のケースが
   `b1_hit: false` / `llm_calls: 0` / `stage: "toggle_off"` で記録されること

2 が見ているのは**コード経路が no-op であること**で、利用者の実環境が現に off であることでは
ない（検査は一時ファイルの state を使い、`~/.claude/claim-gate/state.json` を読み書きしない）。
1 と 2 が食い違う場合は状態ファイルの読み手が 2 系統あるということなので、利用者側の操作では
解消しない。実装の不整合として扱う。

プラグインごと止めるなら `/plugin` で disable する。こちらは Stop 登録自体が外れる。

## 状態ファイル

| 項目 | 値 |
|---|---|
| パス | `~/.claude/claim-gate/state.json` |
| 作用範囲 | **global（ユーザー単位）1 ファイル。全プロジェクトに効く** |
| 形式 | `{"enabled": true}` / `{"enabled": false}` |
| 既定 | ファイル無し = **off** |
| 解釈 | `enabled` が厳密に `true` のときだけ on。欠如・パース失敗・想定外の値はすべて off |

プロジェクトの作業ツリーには書かない（リポジトリに他人の環境設定が混入する）。
このパスはこの README が正本で、`CLAIM_GATE_STATE_FILE` を立てるとそちらが優先される
（適合検査が利用者の state を触らないために使う）。

## 適合検査の実行

`tests/fixtures/` の固定入力を hook に通し、期待と実測の一致を JSON で返す。

```bash
# 全 fixture（判定器 = claude を呼ぶ）
node ~/.claude/plugins/cache/yoshiysh-claude-plugins/claim-gate/*/scripts/run_conformance.mjs

# 決定的部分だけ（LLM 呼び出しなし。B1 が主張を拾えたかまでを見る）
node .../scripts/run_conformance.mjs --b1-only

# 単件モード（判定させたい文面を渡す）
node .../scripts/run_conformance.mjs --message "この設定はどこにも定義されていない"
```

読み方:

- `verdict` … `"pass"` / `"fail"` / `null`（採点できたケースが 0 件のとき。`0` は実測の
  一致を意味する値なので欠測と混ぜない）
- `unreachable` … 判定器に届かなかった件数（CLI 不在・timeout・非 JSON）。**合否に混ぜない**
- `handler_error` … hook 自身の例外。1 件でもあれば `fail`
- `not_scored` … `--b1-only` で B2 を要するため採点しなかった件数
- ケースごとの `b1_hit` / `llm_calls` … **判定器を実際に通ったのはどのケースか**がここで分かる。
  台帳の真主張のうち、B1 に当たらないものは B2 の pass 経路を測っていない

## 故障の 3 分類

「通した」と「動かなかった」を混ぜると、走らなかったゲートが全件合格として読める。

| 分類 | 何が起きたか | 排出 | 適合検査での扱い |
|---|---|---|---|
| `input_invalid` | stdin の JSON parse 失敗 / `last_assistant_message` 欠損 | pass | 件数を別に数える。合否に混ぜない |
| `unreachable` | `claude` CLI 不在 / spawn 失敗 / timeout / 認証エラー / 非 JSON 応答 | pass | 件数を別に数える。合否に混ぜない |
| `handler_error` | hook ハンドラ自体の例外 | **実装がこうする**: 最上位を try/catch で包み、自身の例外時は stdout を空にして exit 0（= pass）する | 例外の記録を検査から読めるようにし、1 件でもあれば `verdict` は `"fail"` |

`handler_error` の行は**実装が満たす契約**であって、ハンドラが例外を投げたときに
harness が何をするかの観測ではない（その挙動は未確認なので書かない）。自分で捕まえて
exit 0 に落とすと決めておけば、排出の側は fail-open で揃い、かつ「例外が起きた」ことは
検査から見える。

`handler_error` だけ合否に効かせるのは、これが「判定できなかった」ではなく
**判定に一度も到達していない**状態だからである。他 2 分類と同じ扱いにすると、
一度も走らなかったゲートが全件合格として読める。

## fixture の 1 件と母集団

```json
{
  "id": "false-01",
  "expect": "block",
  "source": "ledger",
  "origin": "OBSERVATION.md #1",
  "message": "writer は担当文書への指摘と前稿だけを受け取る。他文書との関係は REQUIREMENTS_REVISED のみ"
}
```

| フィールド | 値 |
|---|---|
| `expect` | `"block"` / `"pass"` / `"pass_without_llm"`（B1 にヒットしないことまで含めて期待する通常応答） |
| `source` | `"ledger"`（台帳由来）/ `"paraphrase"`（言い換え負例）/ `"normal"`（通常応答） |

### 母集団の分解

fixture 母集団 = **台帳由来分 + 言い換え負例 + 通常応答**。

**台帳の件数（偽・真それぞれの内訳）の正本は `tests/ledger.md` の「確認された主張」**
で、ここには書き写さない。同じ数字を 2 か所に置くと、片方だけが直ったときにどちらが正か
決められなくなる。

- **台帳由来分**: OBSERVATION.md の偽（不在・サンプリング検証）に当たる主張と、真（引用付き
  存在 + 閉集合列挙の不在）に当たる主張。BRIEF の合格基準「偽 → block / 真 → pass」は
  **この部分集合にだけ**かかる
- **言い換え負例** (`source: "paraphrase"`): 台帳の偽主張と同じ型を別語彙で述べた文面。
  期待は `block`。決定的パターン前段という設計の中心リスクは「言い換えで素通りする」
  ことなので、台帳の実在行だけでは中心リスクが 1 件も測られない
- **通常応答** (`source: "normal"`): B1 に当たらない応答。期待は `pass_without_llm`
- **撤回行は fixture に含めない**（真の主張を過剰に全面撤回した事例で、block / pass の
  期待値が定まらない）

したがって fixture 総数は台帳の件数と一致しない。**`total` は採点できたケースを数えた実数を
入れ、期待件数をリテラルで固定しない。**

検査スクリプトはこれに加えて、fixture に由来しない制御ケースを 2 件持つ。

| id | `expect` | 見るもの |
|---|---|---|
| `toggle-off` | `"no_op"` | off の state で、B1 も判定器も走らないこと（`b1_hit: false` / `llm_calls: 0`） |
| `input-invalid` | `"pass"` | stdin が JSON でないときに block しないこと。`input_invalid` として数え、合否に混ぜない |

## 適合検査の結果

```json
{
  "toggle_state": "on",
  "cases": [
    { "id": "false-01", "source": "ledger", "expect": "block", "actual": "block", "b1_hit": true, "llm_calls": 1, "ok": true }
  ],
  "summary": {
    "total": 0, "ok": 0, "failed": 0,
    "unreachable": 0, "input_invalid": 0, "handler_error": 0
  },
  "truncated": [],
  "verdict": "pass"
}
```

- `failed` が 1 件でもあれば `verdict` は `"fail"`。`handler_error` が 1 件でも同じ
- `not_scored` は、B2 を要するため決定的モード（`--b1-only`）で採点しなかったケース。
  `ok` にも `failed` にも数えない
- ケースごとの `b1_hit` / `llm_calls` から、**判定器を実際に通ったのはどれか**が読めること。
  B1 に当たらずに通った pass は、B2 の判定を一度も測っていない
- 採点できたケースが 0 件なら `verdict` は `"fail"` ではなく `null`（`0` は実測の一致を
  意味する値なので、欠測と混ぜない）
- `unreachable` / `input_invalid` は `ok` にも `failed` にも数えない
- `truncated` には、本文の絞り込みを行ったケースの id を入れる（黙った打ち切りを残さない）
- 4 つの区分（台帳の偽 → block / 台帳の真 → pass / 通常応答 → LLM 0 / toggle off → no-op）が
  `cases` から読み取れること。これが BRIEF の合格基準に対応する

この検査が見ているのは **fixture の再現性**であって、ゲートの効果（検出率・誤ブロック率）
ではない。効果はどこにも測っていない。

## timeout の順序（正本）

timeout は 3 箇所にあり、値そのものではなく**順序**が契約になっている。

```
JUDGE_TIMEOUT_MS（判定器上限） < hooks/hooks.json の timeout < CASE_TIMEOUT_MS（適合検査上限）
```

hook 全体の timeout を判定器上限より大きく取るのは、逆にすると harness 側の kill が常態化し、
kill 時の挙動は未観測なので「全経路 fail-open」が script 側だけでは成り立たなくなるため。
差分は node 起動と state 読みの余裕にあたる。数値を変えるときはこの順序を保つ。
JSON にコメントを置けず、top-level の説明フィールドは Codex のパーサが拒否するため、
この順序の正本は本 README に置く。

## Codex CLI での利用

Stop hook の宣言は `hooks/hooks.json` の 1 箇所だけで、**Claude Code と Codex CLI の両方が
同じファイルを読む**（書き写しはしない）。`.codex-plugin/plugin.json` は表示メタデータのみ。

実測済み（codex-cli 0.142.5、scratch CODEX_HOME に local marketplace から install して確認）:

- plugin として install した状態で `hooks/hooks.json` の Stop hook が発火し、
  `${CLAUDE_PLUGIN_ROOT}` は install 先の plugin root に展開される
- stdin は Claude Code と同型（`last_assistant_message` / `session_id` / `cwd` を含む）で、
  `{"decision": "block", "reason": ...}` で排出が止まり reason がモデルに渡る。
  hook 本体は無改修で動く。stdin の `stop_hook_active: true` で block 後の再入を判別できる
- Codex のパーサは hooks.json の top-level に `hooks` 以外のフィールドを許さない
  （`description` を置くと parse warning で hook 全体が無効になる）。説明はこの README に置く

注意:

- B2 判定器は `claude -p` を spawn する。claude CLI が無い環境では unreachable → fail-open で
  全て通る（ゲートは実質 no-op になる。適合検査の `unreachable` で観測できる）
- トグルは Claude Code と共通の `~/.claude/claim-gate/state.json` を読む

## 判定規約とその出所

差し戻しの基準は 1 点だけ。**不在・網羅型の断定に、(a) 網羅検証の裏付け（閉集合の列挙・
全文読み・形を変えた複数回の検索への言及）か (b) 手段スコープ（「この方法で調べた範囲では」）
が付いているか。** 主張の真偽は見ない。

この規約は**このリポジトリの利用者が自分の運用として定めたもの**であり、
**業界標準でも公式の定めでもない**。出所は当該ユーザーの memory
`feedback_verify_before_claiming.md`。合わない運用では on にしない選択が正しい。

差し戻されたときの出口は 2 つある。裏付けを取って言明するか、手段でスコープして書くか。
**主張の撤回は要求していない**（真のまま残る主張を過剰に全面撤回した事例が台帳にある）。

## on にしたときに増えるコスト

B1（決定的パターン前段）は **recall に寄せてある**。取りこぼした主張は判定器に一度も届かない
一方、拾いすぎた分は判定器 1 回分のコストで済み、block にはならない（判定器が裏付けを見て通す）。

その結果、**日常的な語でも判定器が起動する**。例えば `only` / `すべて` / `〜はありません` を
含む応答は、主張の型に関係なく B1 に当たる。実測すると次のような文も拾う。

- `I only changed the timeout value in the config; the rest of the diff is formatting.`
- `すべてのテストが通ったので、この変更で問題ありません。`

つまり on の間は、応答の終わりに **判定器 1 回分の待ち時間とトークン**が加わることが珍しくない。
これが見合わないと感じたら off にするのが正しい（そのための opt-in である）。
どの程度の割合で起動するかは測っていないので、ここには書けない。

## fail-open

判定に迷ったとき・判定できなかったときは**通す**。具体的には次のすべてで排出が続く。

- stdin が JSON でない / `last_assistant_message` が無い
- トグルが off
- B1 にヒットしない
- 判定器の spawn 失敗・timeout・認証エラー・非 JSON 応答
- 裏付けが部分的（`support: "partial"`）
- hook ハンドラ自身の例外（最上位で捕まえ、stdout を空にして exit 0 する）

**この点は先例（codex の stop review gate）と逆である。** 先例は timeout・非ゼロ終了・
パース不能をいずれも block にしている。claim-gate は全応答を尋問する装置ではないので、
すべて pass に倒す。ただし「通した」と「ゲートが動いていない」は適合検査で別に数える。

## 並行セッションでの扱い

- hook 側は状態ファイルを**読むだけ**で書かない。判定は spawn 単位で独立していて、
  セッション間で共有する状態を持たない。複数セッションが同時に Stop を迎えても
  互いの判定に影響しない
- 書き込むのはトグル操作だけで、1 フィールドの全体書き換え。ロックは持たず、同時に
  逆向きの切り替えが起きたら後勝ちで一方が失われる。次の状態確認で気付ける

## 既知の未決事項

- **block 後の再入**: Stop は block 後に再び発火しうるため、同じ文面が再び B1 に当たる経路が
  理論上ある。再入を判別できる入力フィールドがあるかは**この方法で調べた範囲では**
  （先例プラグイン配下の grep のみ。公式 docs 未読）確認できていないので、再入対策の機構は
  入れていない。判定器の子プロセス側については、env マーカーと `--safe-mode` で
  hook が再帰しないようにしてある
