---
name: investment-topic-router
model: sonnet
subagent_type: general-purpose
description: >
  chat スキルの Step 1 で SKILL.md から呼ばれる。ユーザーの相談文が投資トピックかどうかを
  [SKILL_DIR]/scripts/detect_investment_topic.py で判定し、投資トピックであれば investment-strategist
  スキルへ自ら委譲して結果を relay する。非投資トピックであれば SKILL.md に続行シグナルを返す。
  スクリプト実行判断と別スキル呼び出しの両方を本 agent の責務とし、SKILL.md からは
  どちらも直接呼ばない（判断不要でも常に agent 経由という設計原則に従う）。
  **呼び出し元は chat スキルの Step 1 だけではない**：`chat-rigorous` スキル
  も Step 1 でこのファイルをリポジトリルートからの相対パスで参照し、コピーせず再利用している（ドリフト回避）。
  本ファイルを変更する際は chat-rigorous 側の呼び出し（SKILL.md の出力契約）も壊れないか
  確認すること。
---

# Investment Topic Router

相談文が投資判断（銘柄評価・売買タイミング・PF 相談等）かどうかを決定的に判定し、
該当すれば investment-strategist に委譲する。非該当であれば chat の壁打ちパイプラインへ
進めてよいことを SKILL.md に伝える。

## なぜ agent 化するか

投資トピック判定自体は script（決定的キーワード分類）が担い、LLM 判断は不要
（Determinism Split）。ただし「script を呼ぶか」「別スキルを呼ぶか」の判断は常に
Sub-agent の責務であり、SKILL.md から直接スクリプト・別スキルを呼ぶことは設計原則違反
（「シンプルだから省略していい」という例外は認めない）。判定結果に応じた分岐制御を
本 agent 1 つに閉じ込めることで、SKILL.md はフローの進行のみを保てる。

## Inputs

- `[USER_CONSULTATION]`: ユーザーの相談文（自然文）

## Task

### Step 1: 投資トピック判定 script を実行する

```bash
python3 [SKILL_DIR]/scripts/detect_investment_topic.py --text "[USER_CONSULTATION]"
```

出力 JSON（`{"is_investment_topic": bool, "matched_keywords": [...]}`）を受け取る。

script が非 0 終了した場合（実行エラー等）は、判定不能とみなし
**安全側で `is_investment_topic: false` 相当として扱う**（Step 3 へ）。
理由：投資でない可能性が高い相談を誤って investment-strategist に流すより、
技術壁打ちを試みる方がユーザーの意図に近い。ただし委譲漏れの懸念に備え、
Step 3 の出力に一言添える（下記参照）。

### Step 2: is_investment_topic が true の場合

`Skill({skill: "investment-strategist"})` を呼び、`[USER_CONSULTATION]` をそのまま渡す。
investment-strategist の応答をそのまま `relayed_response` として返す（改変・要約しない。
investment-strategist 自身が既に規制境界・disclaimer を経た最終出力を生成しているため）。

出力：

```json
{"proceed": false, "relayed_response": "<investment-strategist の応答>"}
```

### Step 3: is_investment_topic が false の場合（script エラー時も含む）

`Skill()` は呼ばない。SKILL.md に続行を伝える。

出力：

```json
{"proceed": true}
```

script がエラー終了していた場合は、`proceed: true` の判定に加えて、後続の
relay-formatter が最終出力の末尾に次の一言を添えられるよう、その旨を明記して返す：

```json
{"proceed": true, "note": "投資トピック判定が実行エラーのため技術壁打ちとして処理します。投資判断のご相談なら /chat ではなく investment-strategist をご利用ください。"}
```

## Output

`{"proceed": bool, "relayed_response"?: string, "note"?: string}` のいずれかの形。
SKILL.md はこの出力のみを見て次の分岐を決める（script や investment-strategist を
直接見ることはない）。
