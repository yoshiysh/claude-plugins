# claim-gate

Stop hook の主張ゲート。「〜は無い」「〜のみ」「すべて」型の**不在・網羅の断定**に、
網羅検証の裏付けも手段スコープも付いていなければ、排出前に差し戻す。

opt-in（既定 off）・fail-open。**トグルを on にするまで、このプラグインは何もしない。**

## 目次
- [導入手順](#導入手順)
- [無効化する](#無効化する)
- [状態ファイル](#状態ファイル)
- [適合検査の実行](#適合検査の実行)
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

```
claim-gate を有効化して
```

claim-gate スキルが同梱物の実在を確認してから状態ファイルを書く。手で書く場合は次と同じ。

```bash
mkdir -p ~/.claude/claim-gate
printf '{"enabled": true}' > ~/.claude/claim-gate/state.json
```

**いつから効くか**: hook は Stop イベントのたびに状態ファイルを読む。**次の応答の終わりから**
効き、実行中の応答には効かない。

## 無効化する

```
claim-gate を無効化して
```

手で行う場合:

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

スキル経由なら「claim-gate の適合検査を回して」で同じスクリプトが走る。

読み方:

- `verdict` … `"pass"` / `"fail"` / `null`（採点できたケースが 0 件のとき。`0` は実測の
  一致を意味する値なので欠測と混ぜない）
- `unreachable` … 判定器に届かなかった件数（CLI 不在・timeout・非 JSON）。**合否に混ぜない**
- `handler_error` … hook 自身の例外。1 件でもあれば `fail`
- `not_scored` … `--b1-only` で B2 を要するため採点しなかった件数
- ケースごとの `b1_hit` / `llm_calls` … **判定器を実際に通ったのはどのケースか**がここで分かる。
  台帳の真主張のうち、B1 に当たらないものは B2 の pass 経路を測っていない

この検査が見ているのは **fixture の再現性**であって、ゲートの効果（検出率・誤ブロック率）
ではない。効果はどこにも測っていない。

## Codex CLI での利用

`.codex-plugin/plugin.json` に同じ Stop hook を宣言してあり、Codex CLI（plugin の hooks 宣言に
対応した版）でも同じゲートが効く。実測済みの事実と未確認の事項を分けて書く。

- **実測済み**（codex-cli 0.142.5、scratch CODEX_HOME での codex exec）: Stop hook の stdin は
  Claude Code と同型（`last_assistant_message` / `session_id` / `cwd` を含む）で、
  `{"decision": "block", "reason": ...}` で排出が止まり reason がモデルに渡る。
  hook 本体は無改修で動く。また stdin の `stop_hook_active: true` で block 後の再入を判別できる
- **未確認**: plugin 経由で install したときの `${CLAUDE_PLUGIN_ROOT}` の展開（実測はファイル
  直置きの hooks.json で行った。plugin 内 command hook の公式実例は無い）。展開されない場合も
  hook は起動に失敗するだけで fail-open（排出は止まらない）
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
