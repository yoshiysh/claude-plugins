# workflow

生成・改善ループを回す業務フロー系スキル（PDCA ループ実行、要求文書・仕様書の生成と監査、
文書の言語化レビューと改稿）と、Codex 向けの Workflow 内部互換層を収録するプラグイン。

## 収録スキル

| スキル | 呼び出し | 説明 |
|---|---|---|
| `pdca` | `/workflow:pdca` | Plan→Do→Check→Act を契約・検証付きで回す |
| `prd-spec` | `/workflow:prd-spec` | 要求文書・仕様書を日本語で作成・レビューする |
| `review-document` | `/workflow:review-document` | 文書の言語化レビューと改稿 |
| `dynamic-workflow-runner` | 内部専用 | caller skill が native Workflow 不在時に透過利用する compatibility layer |

## 使い方

```
/workflow:pdca <依頼内容>
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

導入だけで native Workflow が追加されるわけではありません。native が無い Codex では caller が
同じ scriptPath と args を新 JavaScript runtime へ渡します。旧分類による一律停止は行いません。
現時点の検証範囲は自動テストと小さな live 実行であり、
全 caller の E2E、書込の live 検証、承認転送、resume は未完了です。

詳細なフローは `skills/dynamic-workflow-runner/SKILL.md` を参照してください。

## 構成

このプラグインの `skills/` 配下がスキルの実体です。
リポジトリ内の `.agents/skills/<name>` がここへの相対シンボリックリンクになっています。
