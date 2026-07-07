# エージェント間入出力スキーマ定義

manage-marketplace-plugin 内の各エージェントが入出力するデータの契約書。
フィールド名のズレでパイプラインが壊れるため、変更時は全エージェントに伝播させること。

## 目次
- [input-resolver の出力](#input-resolver-の出力)
- [plugin-registrar の入力](#plugin-registrar-の入力)
- [register_plugin.py の JSON レポート](#register_pluginpy-の-json-レポート)

---

## input-resolver の出力

```
status: ok | error
skill_name: <正規化済みスキル名（.claude/skills/ の実ディレクトリ名）>
mode: register | update
update: true | false
version: <ユーザー明示時のみ。無指定は空>
author: <例 yoshiysh>
description: <プラグイン説明文（What+When を含む）>
error_message: <status: error のときのみ。候補名や欠落理由を含める>
```

### フィールド詳細

- `skill_name`: ユーザー入力の表記ゆれを `.claude/skills/` 実ディレクトリ名へ寄せた正規名。
- `mode` / `update`: **marketplace.json を照合した実体ベースの判定**。既に登録済みなら `update / true`、未登録（または marketplace.json 不在）なら `register / false`。ユーザーの言い回しではなく実体で決める。
- `version`: **ユーザーが明示した場合のみ**値を入れる。無指定なら空のまま渡す（新規=`0.1.0`／更新=既存 version の patch+1 を register_plugin.py が決めるため、ここで `0.1.0` を埋めない）。
- `author`: ユーザー指定が無ければデフォルト `yoshiysh`。
- `description`: ユーザー指定 → 対象 SKILL.md frontmatter の description → AskUserQuestion の順で確定。空のまま渡さない。

---

## check_portability.py の出力

`python3 scripts/check_portability.py --skill <name>` が stdout に出す JSON：

```json
{
  "status": "ok",
  "skill": "<name>",
  "summary": { "self_hardcode": 1, "external_script": 4 },
  "has_blockers": true,
  "findings": [
    {
      "type": "self_hardcode | external_script | script_internal_dep | env_build | other_external",
      "file": "<スキル内の相対パス>",
      "line": 23,
      "match": "<該当行（先頭160字）>",
      "remediation": "<推奨対応>",
      "script": "<external_script のみ：ファイル名>",
      "exists_at_root": true,
      "already_bundled": false
    }
  ]
}
```

- `has_blockers`：self_hardcode / external_script / env_build のいずれかがあれば true。
- 検出は候補出し（broad net）。記述的言及か実依存かの最終判断は portability-checker が行う。

---

## portability-checker の出力

```
status: ok | fixed | blocked
proceed: true | false
applied_fixes: <適用した修正の箇条書き。なければ「なし」>
warnings: <env_build 等の警告。なければ「なし」>
note: <補足>
```

- `proceed: false`（配布不可・ユーザー中止）の場合、司令塔は plugin-registrar に進まず中断する。

---

## detect_dependencies.py の出力

`python3 scripts/detect_dependencies.py --skill <name>` が stdout に出す JSON：

```json
{
  "status": "ok",
  "skill": "<name>",
  "has_candidates": true,
  "dependency_candidates": {
    "<dep-skill>": {
      "referenced_by": "<どのスキルが言及したか（推移的検出のため対象自身とは限らない）>",
      "occurrences": [ { "file": "<相対パス>", "line": 12, "match": "<該当行先頭160字>" } ]
    }
  }
}
```

- `.claude/skills/` に実在する他スキル名への言及を**推移的**に候補出しする（broad-net）。
- 実依存か単なる言及（案内）かの最終判断は dependency-resolver が行う。

---

## dependency-resolver の出力

```
status: ok
has_dependencies: true | false
bundle_skills: [<実依存と判定した同梱対象スキル名>]
rationale:
  - <skill>: <実依存と判断した根拠（呼び出し箇所）>
needs_confirmation:
  - <skill>: <判断に迷う候補と理由。なければ空>
excluded:
  - <skill>: <候補に出たが同梱不要と判断した理由（案内・言及のみ）>
note: <補足。依存スキル自体が env_build 等で配布困難なら警告>
```

- `bundle_skills` が空でも `status: ok`（依存なしは正常）。
- 司令塔は `bundle_skills` の同梱可否をユーザーに確認し（`needs_confirmation` は必須）、確定分を plugin-registrar に渡す。

---

## plugin-registrar の入力

input-resolver の出力（`status: ok`）＋ dependency-resolver で確定した同梱対象を受け取る。

| plugin-registrar の入力 | 提供元 | フィールド名 |
|---|---|---|
| skill_name  | input-resolver | skill_name  |
| mode / update | input-resolver | mode / update |
| version     | input-resolver | version（空のことがある） |
| author      | input-resolver | author      |
| description | input-resolver | description |
| bundle_skills | dependency-resolver（司令塔が確認後に確定）| bundle_skills |

これらを `scripts/register_plugin.py` の引数 `--skill / --author / --description` に対応させて実行する。
`--update` は `update=true` のときだけ付ける。`--version` は version が空でない（ユーザー明示）ときだけ付ける（空なら付けず、スクリプトに新規 0.1.0／更新 patch+1 を決めさせる）。
`--bundle-skill <dep>` は確定した同梱対象スキルごとに付ける（複数可。無ければ付けない）。

---

## register_plugin.py の JSON レポート

成功時（exit 0）に stdout へ出力される形式：

```json
{
  "status": "ok",
  "dry_run": false,
  "created_new": false,
  "marketplace_path": "<絶対パス>/.claude-plugin/marketplace.json",
  "version": "0.1.1",
  "version_bump": "0.1.0 -> patch+1 | explicit | default(0.1.0)",
  "actions": {
    "marketplace_entry": "added | updated",
    "plugin_json": "created",
    "readme": "created | kept",
    "symlink": "created | kept | relinked"
  },
  "bundled_skills": [
    { "skill": "<dep>", "symlink": "created | kept | relinked", "ok": true }
  ],
  "symlink_ok": true,
  "next_action": "/plugin install <name>@<marketplace名> でインストールして動作確認できます。"
}
```

- `version`: 実際に plugin.json へ書いた version。`version_bump`: その決め方（`explicit`=ユーザー明示／`X -> patch+1`=更新で patch を上げた／`default(0.1.0)`=新規）。
- `bundled_skills`: `--bundle-skill` で同一プラグインに同梱した依存スキルの symlink 結果（`skills/<dep>`）。指定が無ければ空配列。`symlink_ok` は本体＋同梱すべてのリンク検証を AND した結果。
- `--dry-run` 時は `actions` の代わりに `planned_actions`（`marketplace_entry` / `plugin_json: would_create (version X)` / `readme` / `symlink` / `bundled_symlinks`）を返し、`version` / `version_bump` / `bundled_skills`（同梱予定の名前リスト）も返る。

### 終了コード

| code | 意味 | 対応 |
|---|---|---|
| 0 | 成功（added または updated）| レポートをそのまま報告 |
| 2 | marketplace.json が破損 | 自動修復せず中断。手動修正→再実行を案内 |
| 3 | 対象スキルの SKILL.md が無い | 設置不備として欠落パスを案内 |
| 4 | `--update` 未指定なのに既存と衝突 | input-resolver の判定とズレ。ユーザーに更新可否を確認し --update で再実行 |

---

## verify_install.py の出力

`python3 scripts/verify_install.py --skill <name>` が stdout に出す JSON（登録後検証 L2＋L3）：

```json
{
  "skill": "<name>",
  "l2_bundle_check": { "passed": true, "findings": [] },
  "l3_isolated_install": {
    "passed": true,
    "steps": [["marketplace add", 0, "..."], ["install", 0, "..."]],
    "bundled_skill_md": true,
    "bundled_scripts": ["..."],
    "bundled_scripts_real": true,
    "details_ok": true
  },
  "overall_passed": true
}
```

- **L2**：plugin.json 妥当性／`skills/<name>` symlink→SKILL.md 解決／dangling symlink の有無（読み取り専用）。
- **L3**：HOME を一時ディレクトリに差し替えた**実 install**。キャッシュにバンドルが実体（symlink でない）として展開され、`claude plugin details` でスキル認識されるか。**実ホーム ~/.claude は変更しない**（終了時に一時ディレクトリごと後始末）。
- 終了コード：0=overall_passed / 5=検証失敗 / 3=登録 plugin dir 不在。
- L4（実データ実行）は本スクリプト外。司令塔が AskUserQuestion で入力を聞いて実行する。

---

## install-verifier の出力

```
status: ok | failed
overall_passed: true | false
l2: <findings の要約。問題なければ「解決OK」>
l3: <install 成否・バンドル展開・skill 認識の要約>
note: <overall_passed=false のとき、何が install 先で壊れるかと対処>
```

- `overall_passed: false` の場合、司令塔は「成功」と報告せず、登録のやり直し／取り消しを判断する。
