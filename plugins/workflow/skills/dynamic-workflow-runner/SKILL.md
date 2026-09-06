---
name: dynamic-workflow-runner
user-invocable: false
description: >
  選択済み Claude 向け skill が到達した Workflow({scriptPath,args}) の Codex 内部実行面。
  親が caller skill を読み、信頼済み JavaScript source が worker の役割・prompt・reference を所有する。
  native Workflow が存在する場合はそちらを使う。任意名の source を扱い、追加の LLM 変換担当は起動しない。
  未対応権限や未検証の caller を自動実行できるとは扱わない。通常の script 実行や hostile code には使わない。
---

# Dynamic Workflow Runner

親向けの内部入口。インストールだけで native tool を登録・横取りする仕組みではない。
caller が実際に到達した callsite から明示的に委譲する。direct mode は保守・移行検証用であり、
通常のユーザーに runner の指定を要求しない。

## 責務と読む範囲

- **親**: caller の SKILL.md とこの入口を読む。callsite、exact args、実行権限、上限、戻り値の扱いを確認する。
- **source**: `agent()` の役割・prompt・必要な入力・reference path、依存関係、レビューの要否を定義する。
- **runtime**: source を構文解析して実行し、並行数・呼出し数・期限・結果型・ログを管理する。
- **worker**: source が渡した prompt と指定 reference を読む。親会話、runner SKILL.md、全契約の読込を追加しない。

親が読んだ指示を全文で配布しない。reference は担当の実行時に必要なものだけ明示する。
source 自身が必要とするレビューは維持するが、runner 都合の translator・調整役・契約レビュアーは追加しない。
SDK worker は fresh thread だが、cwd の指示やホスト設定までゼロになるとは主張しない。

## 実行前の判断

1. native `Workflow` が実際に呼べるなら caller の native 経路を使う。設定フラグ名は能力の証明ではない。
2. native を一度でも試行した call をこちらで再実行しない。timeout は未実行の証明にならない。
3. caller が宣言した source と args を確認する。別 branch や例示から call を推測しない。
4. 現 adapter は read-only worker 用。書込、厳密な tool allowlist、承認の転送、resume を必要とする
   caller は `unsupported_runtime` として止める。外部サービス権限を filesystem 制限で代用しない。
5. source の信頼性、worker cwd、利用するモデル対応表、実行上限を確認する。
   任意名・任意拡張子は許すが、Node vm は hostile source の強制 sandbox ではない。
6. caller の必要機能を request の `requirements` に列挙する。source の meta にも宣言できる。
   現在の対応値は `read-only`、`fresh-thread` のみ。それ以外は最初の呼出し前に拒否する。
   動的に構成する option も宣言対象。source 全体の静的推定が完成したとは扱わない。

## JavaScript 実行経路

初回 setup と request 作成時だけ [実行仕様](scripts/runtime/README.md) を読む。
request JSON に `scriptPath`、`args`、新規 `runDir`、worker `cwd` と必要なモデル設定・上限を記録する。
モデル指定のある source には明示的な `modelMap` が必要。対応表の品質同等性は推測しない。

```bash
node [SKILL_DIR]/scripts/runtime/cli.mjs <request.json> --live --trusted-source
```

source は JavaScript として実行する。LLM に manifest へ翻訳させない。source の固定ファイル名を要求しない。
プロセス完了を待ち、CLI の status と run のログを確認する。タスクごとのモデル駆動ポーリングはしない。
`completed` は source が正常に return したという意味であり、独立レビューや投資判断の合格を意味しない。
`agent()` の失敗は null。null を許容するか停止するかは source が決める。上限超過は run 全体を失敗させる。
caller の post-success phase と human gate は caller が所有し、runtime が代替しない。

## 失敗・検証・移行

- 失敗時だけ run の `events.jsonl` と [既知の検証範囲](scripts/runtime/VALIDATION.md) を読む。
  同じ runDir の再利用・自動再試行・失敗した native call の fallback はしない。
- token 使用量は完了 turn の実測を示す。agent 数や timeout を token 上限と言い換えない。
- 現在の実証は mock tests と小さな live smoke。既存 caller 全体の無変更 E2E は未検証。
  既存 caller の旧 manifest receipt 指示を新 request と混ぜない。caller の移行前は自動切替しない。
- 既存 manifest run の保守を明示的に求められた場合だけ [旧手順](LEGACY.md) を読む。
  新規 JS run では旧契約・変換 prompt・旧最終レビューを読まない。

設計変更時の責務・受入基準は [設計](references/runtime-design.md) を参照する。通常実行では不要。
