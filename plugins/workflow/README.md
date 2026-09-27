# workflow

生成・改善ループを回す業務フロー系スキル（PDCA ループ実行、要求文書・仕様書の生成と監査、
文書の言語化レビューと改稿）と、Codex 向けの Workflow 内部互換層を収録するプラグイン。

## 収録スキル

| スキル | 呼び出し | 説明 |
|---|---|---|
| `pdca` | `/workflow:pdca` | Plan→Do→Check→Act を契約・検証付きで回す |
| `ooda` | `/workflow:ooda` | 状況が読めない課題で Observe→Orient→Decide→Act を 1 周ずつ回し、観測を独立検証してから次の周へ戻す |
| `prd-spec` | `/workflow:prd-spec` | 要求文書・仕様書を日本語で作成・レビューする |
| `review-document` | `/workflow:review-document` | 文書の言語化レビューと改稿 |
| `pr-review` | `/workflow:pr-review` | PR、コード、skill、PRD、仕様書、README などを複数観点で網羅的にレビューする |
| `pr-review-fix` | `/workflow:pr-review-fix` | レビューで確定した指摘を安全に修正し、再レビューする |
| `dynamic-workflow-runner` | 内部専用 | caller skill が native Workflow 不在時に透過利用する compatibility layer |

## 使い方

```
/workflow:pdca <依頼内容>
/workflow:ooda <依頼内容>
/workflow:prd-spec <依頼内容>
```

詳細なフローは各 `skills/<name>/SKILL.md` を参照してください。

### dynamic-workflow-runner について

ユーザーが runner を直接呼ぶ必要はありません。対応済み caller skill が active callsite に到達し、
native Workflow が現在の tool inventory に無いときだけ、この runner を内部利用します。

Claude Code では caller plugin の `dependencies` から導入されます。Codex は plugin dependency を
自動導入しないため、対応済み caller plugin と `workflow` をそれぞれ一度 install してください。

新 runtime は信頼済み source を JavaScript として実行し、Codex SDK の fresh thread へ
`agent()` の exact prompt を渡します。モデル名と reasoning effort は明示的な対応表で指定します。
adapter は既定で read-only。明示設定で workspace-write と完全 commit hash 起点の独立 worktree を使用できます。
call 数・並行数・期限を制限しますが、厳密な token 上限ではありません。

導入だけで native Workflow が追加されるわけではありません。既存 caller の旧 receipt 経路は
まだ新 runtime へ自動移行していません。検証範囲は自動テストと、単一 agent による workspace
書込の live smoke です。一般的な sandbox 隔離保証、全 caller の live E2E、承認転送、
resume の live E2E は未検証です。workspace の検証範囲と上限は runtime の
[README](skills/dynamic-workflow-runner/scripts/runtime/README.md) を参照してください。
旧 manifest 手順は `skills/dynamic-workflow-runner/LEGACY.md` に隔離しています。

詳細なフローは `skills/dynamic-workflow-runner/SKILL.md` を参照してください。

## 構成

このプラグインの `skills/` 配下がスキルの実体です。
リポジトリ内の `.agents/skills/<name>` がここへの相対シンボリックリンクになっています。
