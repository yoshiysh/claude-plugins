# /Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications 目次

この INDEX は doc_check が文書から導出したものである。本体を直したら導出し直す（手書きしない）。

## 文書一覧

| パス | 扱う関心事 | どういう仕様項目が書かれているか |
|---|---|---|
| `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` | 仕様書: 生成される文書の記述仕様 | 文書の種別と分量／章構成／要求文と仕様項目の書き方／重複と矛盾／ID 体系／トレーサビリティ表／未確定事項の書式／保持規則／ファイル配置と INDEX／状態とイベントの記述／外部規格への言及／根拠が得られない事項の扱い／機械検査が参照する語の集合（SP-AUTHORING-001〜088、欠番は 001・002・004・019・049・083・084／81 件） |
| `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-authoring.md` | 仕様書: create と update の流れ | 対象スキルと run の入力／段の並び／目標の固定／書く／検証／合否／形式検証／停止／エラー処理と異常系／外部インタフェース（SP-BPAUTHORING-001〜046／46 件） |
| `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-conformance.md` | 仕様書: 対象スキルが備える性質の判定基準と、対象スキルに課す確定値 | 判定の当て方／配置の原則／形の判定／資産台帳／run の記録／形に関わる原則／配布先での確認／fan-out の起動数の上限／性能・容量（対象スキルに課す確定値）／エラー処理と異常系（SP-BPCONFORMANCE-001〜041／41 件） |
| `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-entry.md` | 仕様書: 依頼の振り分け・機能の連鎖・Workflow callsite | 振り分け／連鎖／Workflow callsite／エラー処理と異常系／外部インタフェース（SP-BPENTRY-001〜025／25 件） |
| `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-findings.md` | 仕様書: 指摘と資産台帳 | 台帳と資産／結果の結び付き／反証／指摘の状態／カバレッジと skip 一覧／run をまたぐ指摘の扱い／指摘の形／エラー処理と異常系（SP-BPFINDINGS-001〜037／37 件） |
| `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-inspection.md` | 仕様書: review と audit の観点と流れ | 形と段／観点／フローの観点／監査の観点／担当と起動／対象を書き換えない／対象スキル／外部インタフェース／エラー処理と異常系（SP-BPINSPECTION-001〜030／30 件） |
| `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-run.md` | 仕様書: best-practices の実行基盤 | run の境界／状態と作業場所／run の記録／停止／再開／起動数の上限／判定基準の写し／モデル・effort・権限／エラー処理と異常系／外部インタフェース／性能・容量（SP-BPRUN-001〜048／48 件） |
| `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/elicitation.md` | 仕様書: 事前分析と依頼者への問いかけ | 観点の判定／分割案／判定の委ね方／質問の生成と絞り込み／回答の反映／エラー処理と異常系（SP-ELICITATION-001〜049、欠番は 005・006・007・011・016・019・021・022・023・028 ほか 6 件／33 件） |
| `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/flow.md` | 仕様書: 全体の制御 | 起動時の判定／根拠として扱う入力の範囲／中断点と順序の制約／未確定事項の区分・周回・完成判定／保存／中断（SP-FLOW-001〜047、欠番は 001・006・008・009・023・038／41 件） |
| `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` | 仕様書: formal-methods の手順・状態・成果物の形 | 入力と機能／入口の step／step の表／役／状態と CLI／写し／機械で確かめる原則／取り込みの表／停止の種類／人の入力／軽い検査／単位／並列／階層と 2 つの軸／循環／費用の 2 段／手法と道具／モデルの作成と忠実さ／audit が確かめる中身／欠けの形と帰属／範囲と限界の記録／性質の洗い出し／失敗と回数／続きからの起動／停止の表と返り値／起動数の上限／このスキル自身への適用（開発時）／エラー処理と異常系／外部インタフェース（SP-FORMALMETHODS-001〜461、欠番は 001・002・003・004・005・006・007・008・009・010 ほか 72 件／379 件） |
| `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/verification.md` | 仕様書: 生成物の検査と改稿 | 検査の実行と記録／同一性の判定／実行可能性の判定／記述規約の検査／構造の検査／文書間の検査／網羅の検査／根拠の検査／改稿の反復／エラー処理と異常系（SP-VERIFICATION-001〜045、欠番は 008・030・040／42 件） |

## 仕様項目一覧

| ID | 見出し | 所在文書 |
|---|---|---|
| SP-AUTHORING-003 | 要求文書の分量の決め方 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-005 | 仕様書の記述水準の下限 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-006 | 仕様書の記述水準の上限 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-007 | 要求文書が持つ内容 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-008 | 仕様書が持つ内容 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-009 | 条件付き章の設置条件 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-010 | 常設章を削らないこと | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-087 | 常設章に該当が無いことの記述 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-011 | 見出しのレベル | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-012 | 分割時の常設章の自足 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-013 | リスクと影響章の判定の表記 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-014 | リスクと影響章の観点の範囲 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-015 | 機能固有の異常系の置き場 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-016 | 共通の異常系の置き場 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-017 | 表記規約の凡例 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-018 | 語尾の限定 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-020 | 曖昧語の排除 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-021 | 単位の明示 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-022 | 境界包含語の使用 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-023 | 定めた境界の明示 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-024 | 範囲外の値を受け取ったときの振る舞い | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-025 | 閾値が未確定のときの扱い | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-026 | 単一要求 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-027 | 条件節の構文 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-028 | 望ましくない事象の条件節 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-029 | 根拠の併記 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-030 | 根拠に書いてよい出所 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-031 | 根拠の分量 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-032 | 文書外の知識に依存しない記述 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-033 | 実在の人物を特定する表記の排除 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-034 | 人物の役割名による記述 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-035 | 変更履歴の章 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-036 | 改稿の経緯 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-037 | 用語の固定 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-038 | 解釈が分かれる語の定義 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-039 | 正となる記述の単一性 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-040 | 相反する記述の排除 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-041 | ID の形式 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-042 | 領域コード | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-043 | 未確定事項の領域コードの接頭辞 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-044 | ID の不変性 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-082 | 削除した項目の ID の欠番化 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-045 | 参照する ID の実在 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-046 | 全要求の紐付け | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-047 | 表の列構成 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-048 | 検証方法欄の内容 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-050 | 表の置き場と範囲 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-051 | 実装対象外の要求の扱い | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-052 | 要求と仕様項目の対応の多重度 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-053 | 未確定事項の置き場 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-054 | 未確定事項の区分 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-055 | 着手不能の未確定事項の一覧 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-056 | 未確定事項が持つ情報 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-057 | 決定者と期限を持たない | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-058 | 未確定事項の本文 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-059 | 要求文からの未確定事項の参照 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-088 | 保持規則の書き方 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-060 | 保存先のパス | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-061 | topic の字種 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-062 | 領域コードの衝突 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-063 | INDEX の導出 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-064 | 要求文書の INDEX が持つ内容 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-065 | 仕様書の INDEX が持つ内容 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-066 | 逆参照の置き場 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-067 | 組み合わせの網羅の示し方 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-081 | 図で示してよい内容の限定 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-068 | 状態遷移図の設置 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-069 | 遷移への仕様項目 ID の付与 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-070 | イベント集合の宣言 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-071 | 行の起こし方 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-072 | 状態 × イベント表の行が持つ情報 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-073 | 発生しない組み合わせの行を削除しないこと | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-085 | 発生しない組み合わせの行の空欄 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-086 | 発生しない組み合わせの根拠 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-074 | 主フローの遷移の置き場 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-075 | 図の記法 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-076 | 言及の条件 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-077 | 準拠の主張 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-078 | 条番号を付けた引用 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-079 | 根拠が無い事項の起票 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-AUTHORING-080 | 語の集合への参照 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/authoring.md` |
| SP-BPAUTHORING-001 | create の対象スキルのパス | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-002 | 書き換えてよい範囲 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-003 | 依頼文を状態に残す | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-004 | 作り直す前の写し | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-005 | 段の並びと反復 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-036 | 項目の ID に含める番号 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-006 | 目標の固定の段 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-007 | 出所の照合 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-008 | 待たれる入力の不足 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-009 | 固定した目標を前提に書く | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-010 | 再開した run の目標の固定 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-011 | 書く段の書き手 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-012 | 形の判定の当て方 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-013 | 書き手が対象スキルに入れてはならないもの | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-014 | 書き直しの入力 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-015 | 書いたパスの照合 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-016 | 観点と担当 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-017 | 適合の観点 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-046 | Claude Code での役ごとの制限の照らし方 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-018 | 目標の観点 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-037 | 依頼に無い目標・制約の照らし方 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-038 | 判定基準が求めた制約 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-019 | 契約の観点 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-039 | 契約の変化の返し方 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-040 | 既存の振る舞いの判定 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-020 | 1 回の反復の中の検証の順 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-041 | fan-out の項目の順位 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-021 | 判定の単位の結果 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-022 | 指摘による合否 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-023 | 反復の合否 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-024 | 反復の数え方 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-025 | 合否の後の進み方 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-026 | 完了の条件 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-042 | 形式検証の段 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-043 | 形式検証の記録 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-044 | 形式検証の段を通ったとするとき | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-045 | 形式検証の失敗 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-027 | needs_input で止まるところ | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-028 | 止まったときに書いたファイルと報告 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-035 | 再開した run が始めるところ | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-029 | 状態を作る前の入力の確かめ | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-030 | 検証が成り立たない | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-031 | 一覧の外へのパス | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-032 | 検証の結果 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-033 | 完了時の出力 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-034 | 完了の前に止まったときの報告 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-authoring.md` |
| SP-BPCONFORMANCE-001 | 判定基準の正本 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-002 | 判定の単位 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-003 | 適用の判定表 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-041 | 判断点の表の照合 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-004 | 形の判定の順序 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-005 | 探索グラフの適用条件 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-006 | 重い形を強いた条件の記録 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-007 | Workflow にしない判定 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-008 | 部品による組み立て | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-009 | 資産台帳の要否 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-039 | run の記録の判定 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-040 | run の記録の置き場 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-010 | 目標の固定 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-011 | 停止・再開と人間の入力 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-012 | 体数と同時実行 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-013 | モデル・effort・prompt | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-014 | 権限 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-015 | 探索グラフ | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-034 | 実行役の時間の上限 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-016 | 状態の書き込み | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-017 | 資産台帳の原則 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-018 | 判定の範囲と結果の宣言 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-019 | 役ごとの制限の確かめ方 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-020 | 確かめられなかった制限の報告 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-021 | 起動数の上限の受け取り | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-037 | 起動数の上限の入力が不正なとき | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-022 | 上限を渡された run の起動数 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-023 | 上限に収まらない項目 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-024 | 残した項目からの再開 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-025 | 上限を渡されない run | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-026 | callsite の経路と上限の受け渡し | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-027 | 同時実行の上限 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-028 | until-pass の繰り返しの上限 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-029 | 固定集合の反復型の反復の上限 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-030 | 探索グラフの周の上限 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-031 | 同じ意図の試行の上限 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-032 | 乾きの定義と乾き停止 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-033 | 要約の大きさの上限 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-035 | 役ごとのモデルと effort の指定 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-036 | 確定値の置き方 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-038 | 判定の単位を判定できないとき | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-conformance.md` |
| SP-BPENTRY-001 | 4 機能の入口 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-entry.md` |
| SP-BPENTRY-002 | 振り分けを行う場所 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-entry.md` |
| SP-BPENTRY-003 | 機能の当て方 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-entry.md` |
| SP-BPENTRY-004 | 機能の列の作り方 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-entry.md` |
| SP-BPENTRY-005 | 機能が 1 つに決まらない部分 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-entry.md` |
| SP-BPENTRY-006 | 対象スキルのパスの一覧 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-entry.md` |
| SP-BPENTRY-022 | パスの一覧に入れるファイル | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-entry.md` |
| SP-BPENTRY-023 | パスの一覧を作れないとき | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-entry.md` |
| SP-BPENTRY-007 | 連鎖の実行 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-entry.md` |
| SP-BPENTRY-008 | 次の機能へ進む条件 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-entry.md` |
| SP-BPENTRY-009 | 前の機能の結果の渡し方 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-entry.md` |
| SP-BPENTRY-010 | 結果を書き換えずに渡す | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-entry.md` |
| SP-BPENTRY-011 | 当たる機能が無い依頼 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-entry.md` |
| SP-BPENTRY-012 | 一部が当たらない依頼 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-entry.md` |
| SP-BPENTRY-013 | callsite の入力 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-entry.md` |
| SP-BPENTRY-014 | 経路の選び方 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-entry.md` |
| SP-BPENTRY-015 | 起動数の上限の渡し方 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-entry.md` |
| SP-BPENTRY-016 | Codex runner の request | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-entry.md` |
| SP-BPENTRY-024 | Codex runner の経路の前提 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-entry.md` |
| SP-BPENTRY-025 | runner と runtime README の変更 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-entry.md` |
| SP-BPENTRY-017 | 返り値の無い run | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-entry.md` |
| SP-BPENTRY-018 | どの経路も無い | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-entry.md` |
| SP-BPENTRY-019 | create を列の先頭以外に置く依頼 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-entry.md` |
| SP-BPENTRY-020 | 渡せる形でない前の結果 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-entry.md` |
| SP-BPENTRY-021 | 利用者への返り値 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-entry.md` |
| SP-BPFINDINGS-001 | 台帳の作成 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-002 | 資産の単位 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-003 | 資産 ID | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-004 | 内容の指紋 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-005 | 台帳の取り直し | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-006 | 資産の同一性を決める主体 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-007 | 検証役が返す形 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-008 | 「見た」の記録 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-009 | 「確認済みで問題なし」の記録 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-010 | 観点と指摘の種類の閉集合 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-011 | 指摘の鍵と指摘 ID | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-036 | 同じ指摘の決め方 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-012 | 重複する候補 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-013 | 反証の実施 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-014 | 反証の結果の記録 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-015 | 未反証の候補 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-016 | 状態の集合 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-017 | 状態の記録の仕方 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-018 | 見直しの判定 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-019 | 状態の遷移 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-020 | 消えた資産の指摘の照合 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-037 | 消えた資産の照合の結果の記録 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-021 | 判定の時点の記録 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-022 | カバレッジ | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-023 | skip 一覧 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-024 | 資産の結末 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-025 | skip 一覧への追加の起動 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-026 | 台帳の範囲 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-027 | 入力に受け取った前の run の指摘 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-028 | 報告する指摘の状態 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-029 | 結果に載せる指摘の項目 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-030 | 結果に載せる台帳の項目 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-031 | 修正の根拠の形 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-032 | create と update の完了時に返す指摘 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-033 | 資産が 0 件のとき | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-034 | 台帳に無い値を含む結果 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-035 | 台帳と食い違う書き込み | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-findings.md` |
| SP-BPINSPECTION-001 | 段の並び | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-inspection.md` |
| SP-BPINSPECTION-002 | 段の間に戻りを置かない | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-inspection.md` |
| SP-BPINSPECTION-003 | 観点の集合 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-inspection.md` |
| SP-BPINSPECTION-004 | 照らす先の決定 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-inspection.md` |
| SP-BPINSPECTION-005 | 仕様書を読めないとき | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-inspection.md` |
| SP-BPINSPECTION-006 | 適用の判定 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-inspection.md` |
| SP-BPINSPECTION-007 | フローの観点の判定 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-inspection.md` |
| SP-BPINSPECTION-008 | 仕様の観点の判定 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-inspection.md` |
| SP-BPINSPECTION-009 | 監査の観点の一覧 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-inspection.md` |
| SP-BPINSPECTION-010 | 一覧と出所の照合 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-inspection.md` |
| SP-BPINSPECTION-011 | 監査の範囲 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-inspection.md` |
| SP-BPINSPECTION-012 | 監査の観点の優先 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-inspection.md` |
| SP-BPINSPECTION-013 | モデルに固有の鮮度 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-inspection.md` |
| SP-BPINSPECTION-014 | 引き継がないもの | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-inspection.md` |
| SP-BPINSPECTION-015 | 担当の作り方 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-inspection.md` |
| SP-BPINSPECTION-016 | 検証の項目と順位 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-inspection.md` |
| SP-BPINSPECTION-017 | 検証役に渡すもの | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-inspection.md` |
| SP-BPINSPECTION-018 | 反証の起動 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-inspection.md` |
| SP-BPINSPECTION-019 | 照合と停止 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-inspection.md` |
| SP-BPINSPECTION-020 | 書き手の役を持たない | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-inspection.md` |
| SP-BPINSPECTION-021 | 対象は既にあるスキル | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-inspection.md` |
| SP-BPINSPECTION-022 | 対象スキルのパスの一覧 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-inspection.md` |
| SP-BPINSPECTION-023 | review と audit の入力 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-inspection.md` |
| SP-BPINSPECTION-024 | review と audit に固有の結果の項目 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-inspection.md` |
| SP-BPINSPECTION-025 | 未検査の観点の形と載せるもの | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-inspection.md` |
| SP-BPINSPECTION-026 | 対象が既にあるスキルでない | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-inspection.md` |
| SP-BPINSPECTION-027 | フローの観点・監査の観点の照らす先を読めない | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-inspection.md` |
| SP-BPINSPECTION-028 | 監査の観点の一覧が出所と食い違う | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-inspection.md` |
| SP-BPINSPECTION-029 | 再開したときの照らす先の食い違い | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-inspection.md` |
| SP-BPINSPECTION-030 | 再開した run の段の順 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-inspection.md` |
| SP-BPRUN-001 | 機能ごとの run | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-run.md` |
| SP-BPRUN-002 | run の中で入力を待たない | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-run.md` |
| SP-BPRUN-003 | run の開始 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-run.md` |
| SP-BPRUN-004 | 前提の書き込み | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-run.md` |
| SP-BPRUN-005 | 状態の中身 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-run.md` |
| SP-BPRUN-006 | 状態の書き込みの規則 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-run.md` |
| SP-BPRUN-007 | 作業場所の置き場 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-run.md` |
| SP-BPRUN-039 | 作業場所を残す場所 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-run.md` |
| SP-BPRUN-008 | 書き込み先の制限 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-run.md` |
| SP-BPRUN-009 | 書いたファイルの記録 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-run.md` |
| SP-BPRUN-038 | 段の開始と項目の列挙 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-run.md` |
| SP-BPRUN-041 | 作業記録 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-run.md` |
| SP-BPRUN-042 | 記録台帳 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-run.md` |
| SP-BPRUN-043 | 文書の一般規約の写しと版 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-run.md` |
| SP-BPRUN-044 | 記録の保持 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-run.md` |
| SP-BPRUN-046 | 性能の記録 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-run.md` |
| SP-BPRUN-010 | 停止の種類 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-run.md` |
| SP-BPRUN-011 | 停止の記録 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-run.md` |
| SP-BPRUN-012 | 停止で書いたファイルを戻さない | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-run.md` |
| SP-BPRUN-013 | 反復の上限の数え方 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-run.md` |
| SP-BPRUN-014 | 再開の起動 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-run.md` |
| SP-BPRUN-015 | 再開した run の始め方 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-run.md` |
| SP-BPRUN-016 | 再開時の対象スキルの照合 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-run.md` |
| SP-BPRUN-017 | 現在でない run の書き込み | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-run.md` |
| SP-BPRUN-018 | 停止の記録の無い run からの再開 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-run.md` |
| SP-BPRUN-019 | 起動数の上限の受け取り | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-run.md` |
| SP-BPRUN-040 | 上限を渡されない run と、起動数の上限の数え方 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-run.md` |
| SP-BPRUN-020 | 上限に収まらない項目 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-run.md` |
| SP-BPRUN-021 | 最小の起動数 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-run.md` |
| SP-BPRUN-037 | 不正な上限と、1 件も始められない上限 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-run.md` |
| SP-BPRUN-022 | 次の run への持ち越し | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-run.md` |
| SP-BPRUN-035 | 残した項目からの再開の手順 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-run.md` |
| SP-BPRUN-036 | 判定基準の写し | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-run.md` |
| SP-BPRUN-023 | 役ごとのモデルと effort | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-run.md` |
| SP-BPRUN-024 | 生成と別の context での起動 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-run.md` |
| SP-BPRUN-025 | 役ごとの権限 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-run.md` |
| SP-BPRUN-026 | 対象を書き換えていないことの照合 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-run.md` |
| SP-BPRUN-027 | fan-out の外の agent の失敗 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-run.md` |
| SP-BPRUN-028 | fan-out の項目の工程の欠け | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-run.md` |
| SP-BPRUN-029 | 全件の欠けと CLI の拒否 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-run.md` |
| SP-BPRUN-030 | BLOCKED の理由 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-run.md` |
| SP-BPRUN-045 | 文書の一般規約の版を得られないとき | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-run.md` |
| SP-BPRUN-047 | 結果を返さなかった担当の作業記録 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-run.md` |
| SP-BPRUN-048 | 記録の保存の失敗 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-run.md` |
| SP-BPRUN-031 | CLI の操作 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-run.md` |
| SP-BPRUN-032 | run の返り値 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-run.md` |
| SP-BPRUN-033 | next_args の中身 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-run.md` |
| SP-BPRUN-034 | 起動数の記録 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/bp-run.md` |
| SP-ELICITATION-001 | 事前分析の実施 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/elicitation.md` |
| SP-ELICITATION-002 | 判定の対象とする観点 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/elicitation.md` |
| SP-ELICITATION-003 | 判定の値の限定 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/elicitation.md` |
| SP-ELICITATION-004 | 判定の根拠の併記 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/elicitation.md` |
| SP-ELICITATION-008 | 判定の引き渡し | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/elicitation.md` |
| SP-ELICITATION-009 | 判定できない観点の扱い | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/elicitation.md` |
| SP-ELICITATION-010 | 不明と判定した観点の非確定 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/elicitation.md` |
| SP-ELICITATION-012 | 分割案の作成 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/elicitation.md` |
| SP-ELICITATION-013 | 分割単位が扱う関心事の記述 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/elicitation.md` |
| SP-ELICITATION-014 | 分割単位の名前の重複の禁止 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/elicitation.md` |
| SP-ELICITATION-015 | 同一の関心事の重複の禁止 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/elicitation.md` |
| SP-ELICITATION-048 | 分割案の引き渡し | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/elicitation.md` |
| SP-ELICITATION-044 | 判定を実行主体の言語理解に委ねること | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/elicitation.md` |
| SP-ELICITATION-045 | 判定が付かないときに倒してはならない側 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/elicitation.md` |
| SP-ELICITATION-046 | 判定が付かないときの依頼者への確認 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/elicitation.md` |
| SP-ELICITATION-017 | 着手を止める事項の問いかけ | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/elicitation.md` |
| SP-ELICITATION-018 | 確定した事項を問わないこと | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/elicitation.md` |
| SP-ELICITATION-020 | 問いと事項の結び付け | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/elicitation.md` |
| SP-ELICITATION-024 | 回答済みの論点の再質問の禁止 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/elicitation.md` |
| SP-ELICITATION-025 | 論点が変わったときの再質問 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/elicitation.md` |
| SP-ELICITATION-026 | 保留となった事項の再質問の禁止 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/elicitation.md` |
| SP-ELICITATION-049 | 入力から値が定まっている事項の確定 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/elicitation.md` |
| SP-ELICITATION-027 | 値を定める回答の反映 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/elicitation.md` |
| SP-ELICITATION-043 | 確定した事項の引き渡し | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/elicitation.md` |
| SP-ELICITATION-029 | 決まっていない旨の回答の反映 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/elicitation.md` |
| SP-ELICITATION-031 | 入力にも回答にも根拠が無い事項を推測で埋めないこと | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/elicitation.md` |
| SP-ELICITATION-040 | 保留であることの記録 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/elicitation.md` |
| SP-ELICITATION-041 | 保留となった事項の非着手不能扱い | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/elicitation.md` |
| SP-ELICITATION-042 | 保留となった事項の引き渡し | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/elicitation.md` |
| SP-ELICITATION-036 | 着手を止める事項が 1 件も無いとき | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/elicitation.md` |
| SP-ELICITATION-037 | どの論点にも対応づけられない回答を受け取ったとき | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/elicitation.md` |
| SP-ELICITATION-038 | 分割単位の名前が衝突したとき | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/elicitation.md` |
| SP-ELICITATION-039 | 所在を示された文書を読み取れないとき | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/elicitation.md` |
| SP-FLOW-002 | 実行基盤の充足の確認と、満たさないときの非着手 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/flow.md` |
| SP-FLOW-003 | 実行基盤が要件を満たさないときの提示 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/flow.md` |
| SP-FLOW-004 | 対象外の依頼の判定 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/flow.md` |
| SP-FLOW-005 | 対象外と判定したときの非着手 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/flow.md` |
| SP-FLOW-007 | 作成する文書の種別の決定 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/flow.md` |
| SP-FLOW-010 | モードの決定 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/flow.md` |
| SP-FLOW-011 | 根拠として扱う入力の範囲 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/flow.md` |
| SP-FLOW-012 | 対象リポジトリの実装の非読み取り | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/flow.md` |
| SP-FLOW-013 | 所在を示された既存文書の読み取り | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/flow.md` |
| SP-FLOW-040 | 所在を示されていない文書の非検出 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/flow.md` |
| SP-FLOW-014 | 確定情報を尋ねる中断点の設置 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/flow.md` |
| SP-FLOW-015 | 回答を受け取る前に文書の生成へ入らないこと | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/flow.md` |
| SP-FLOW-016 | 着手不能の未確定事項の提示 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/flow.md` |
| SP-FLOW-017 | 回答済みの論点への再質問の禁止 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/flow.md` |
| SP-FLOW-018 | 決めないと決めた事項への再質問の禁止 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/flow.md` |
| SP-FLOW-019 | 提示済みの記録 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/flow.md` |
| SP-FLOW-020 | 中断点を跨いで引き継ぐ情報 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/flow.md` |
| SP-FLOW-021 | 未確定事項への区分の付与 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/flow.md` |
| SP-FLOW-037 | 決まっていない旨の回答を受けた未確定事項の保持規則への変換 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/flow.md` |
| SP-FLOW-022 | 完成の判定 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/flow.md` |
| SP-FLOW-024 | 周回の継続と上限 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/flow.md` |
| SP-FLOW-045 | 上限に達したときの残件の明示と完成 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/flow.md` |
| SP-FLOW-025 | 保存先のパスの事前提示 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/flow.md` |
| SP-FLOW-026 | 保存する内容の事前提示 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/flow.md` |
| SP-FLOW-027 | 承認の意思表示の判定 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/flow.md` |
| SP-FLOW-028 | 承認を得るまで保存しないこと | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/flow.md` |
| SP-FLOW-041 | 承認しない旨を示されたときの作り直しへの復帰 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/flow.md` |
| SP-FLOW-042 | 終了の意思を示されたときの終了 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/flow.md` |
| SP-FLOW-029 | 同名の既存ファイルの検出 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/flow.md` |
| SP-FLOW-030 | 同名の既存ファイルがあるときの非保存と差分の提示 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/flow.md` |
| SP-FLOW-031 | 改訂としての上書きの明示 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/flow.md` |
| SP-FLOW-032 | 中間の生成物を対象リポジトリの外に置くこと | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/flow.md` |
| SP-FLOW-039 | 中間の生成物の置き場 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/flow.md` |
| SP-FLOW-036 | 提示した内容の書き込み | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/flow.md` |
| SP-FLOW-043 | 書き込みに失敗したときの既書き込みファイルの保持 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/flow.md` |
| SP-FLOW-044 | 書き込みに失敗したときの到達点の報告 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/flow.md` |
| SP-FLOW-046 | 応答を待つ時間の上限 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/flow.md` |
| SP-FLOW-047 | やり直す回数の上限 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/flow.md` |
| SP-FLOW-033 | 結果を得られないときの実行の終了 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/flow.md` |
| SP-FLOW-034 | 未完成の文書の非保存 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/flow.md` |
| SP-FLOW-035 | 中断した段階の提示 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/flow.md` |
| SP-FORMALMETHODS-081 | 入力の形 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-304 | Workflow の入力の entry | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-082 | 機能の決め方 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-083 | 表の外の欄 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-084 | 起動の同一性の表し方 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-085 | 指紋の算法 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-086 | 状態の鍵 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-087 | 状態の root の決め方 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-326 | 状態の root を応答で返す | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-327 | 作業場所の中のもの | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-305 | 状態の root を cwd に依らせない | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-088 | 記録台帳の置き場 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-089 | 役の書き込み先 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-328 | CLI の書き込み先 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-090 | 他のスキルを呼ばない | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-091 | 役に渡す検査の材料 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-092 | 入力の集合に入れる .tbd.json | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-093 | 入口の step で entry を呼ぶ | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-329 | entry の応答を Workflow に渡す | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-330 | agent の前に次の手を決める | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-094 | 入口の判定 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-331 | 入口の判定で見る作業場所 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-285 | 前の結果を返す状態の判定 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-095 | 入力の拒否の確かめ方 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-096 | 拒否で書かないもの | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-097 | 前の完了を返す | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-098 | 前の結果を返す | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-099 | 入口で状態を書くのに要る起動数 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-100 | 続きか新しい状態か | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-101 | 起動のロックを作る | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-332 | 走っていない起動のロックを消す | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-333 | link が失敗したとき | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-102 | 走っていない起動のロック | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-292 | ロックの更新の時刻を書き直す | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-293 | 道具の実行の間の更新 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-324 | 役の時間の上限を runner に渡す | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-325 | native Workflow で役の時間を守らせられないことの記録 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-103 | 起動のロックの解放 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-295 | 札の合わないロックを消さない | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-104 | CLI の操作の排他 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-296 | 記録台帳のロック | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-105 | 続ける step の決め方 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-106 | 差し込み口 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-334 | コードの層の行を持たない | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-107 | step の並び | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-306 | step を終えてから次へ進む | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-108 | 文書の層と検査の表 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-307 | 最後に回す step | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-109 | 作る機能が欠けで止まる step | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-110 | audit は全ての確かめを終えてから止まる | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-111 | step の開始と項目の列挙 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-112 | 項目の ID | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-113 | 起動数の上限で step を終えられないとき | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-114 | 役の一覧 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-115 | 生成と検証の別の context | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-116 | 個別の確かめ方の割り当て | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-117 | callsite は中身を作らない | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-341 | script は中身を作らない | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-118 | 役の prompt に渡すもの | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-119 | 状態の記録 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-343 | 上限と回数の判定に使う定数 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-120 | 状態の書き込みの規則 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-121 | 状態の要約 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-336 | 定数の表 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-337 | 定数の表を entry で返す | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-338 | script は定数を entry から読む | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-344 | callsite は定数を entry から読む | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-123 | 現在でない run の書き込み | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-124 | 作業記録 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-125 | 記録台帳 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-126 | 適用した一般規約の版 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-127 | 記録の保持 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-128 | 性能の記録 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-129 | 記録の保存の失敗 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-130 | 写しの置き場と一覧 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-345 | 写しのパスの作り方 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-131 | 規則の出所として docs/ を読まない | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-346 | 写しの中の参照の読み方 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-132 | 写しを作る道具 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-133 | 写しの検査 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-134 | 自分の文書での参照の仕方 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-299 | 正本の文を写して持たない | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-135 | 機械で確かめる原則の満たし方 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-136 | 取り込みの表 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-137 | 取り込みの表の範囲を引く | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-138 | 待たれる入力の行に従わない | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-139 | 対象の欠けを直した後の起動 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-140 | 停止の種類 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-141 | BLOCKED の理由の区分 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-142 | 人の答えを待たない | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-347 | 人の入力はヒントだけ | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-143 | 判断が要るものを欠けとして返す | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-144 | 既定値の表 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-145 | 入力の指定を優先する | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-146 | ヒントの追記 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-147 | ヒントを配る役と既読 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-308 | ヒントの既読 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-148 | ヒントが効く範囲 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-309 | ヒントの本文の使い道 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-149 | ヒントで止まらない | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-150 | ヒントのために終えた step をやり直さない | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-151 | 軽い検査を先に回す | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-152 | 抜き出し | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-349 | 数の上限の行を抜き出す | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-153 | 組の形 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-154 | 組を 2 回独立に抽出する | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-310 | 2 体の選択を照らす | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-155 | 抽出の食い違いを検証役に選ばせる | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-351 | 選ばれた選択だけで組を確定する | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-352 | neither の欄を欠けにする | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-156 | 上流の参照先を展開する | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-157 | 展開できない参照 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-158 | 仕様の層での上流の要求文書 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-159 | 結びつけられない語 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-160 | 実体の同一性 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-311 | 定義を読む規則の無い語 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-161 | 型に照らす | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-353 | 照合の選択を light の項目にする | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-162 | 判定の表を組み立てる | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-312 | 組み立てた判定の表の印 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-163 | 組み立てた判定の表を検証役に選ばせる | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-354 | 支持された表だけを照合に使う | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-355 | 退けられた表を欠けにする | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-164 | 保持規則の組 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-314 | 保持規則の組を両方の値で照らす | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-300 | unrealizable の照合の限界を記録する | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-165 | 単位を切る文書の層 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-166 | 要求の層の単位を作る | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-357 | 節で単位を区切らない | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-358 | 要求の層の単位の状態 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-359 | 要求の層の単位の操作 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-167 | 仕様の層の単位を切る材料 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-168 | 仕様の層の単位を作る | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-360 | 仕様の層の単位の状態と操作 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-169 | 根の単位 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-170 | 要求の層の単位の契約 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-171 | 仕様の層の単位の契約 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-172 | 単位の契約の表と式を照らす | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-173 | 種類の列挙を選ばせる | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-361 | 種類の列挙を読む | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-362 | 種類と状態の組を選ばせる | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-363 | coverage-gap を書く | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-174 | 停止・再開・拒否の種類が無いとき | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-175 | 外の主体の契約を選ばせる | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-364 | 外の契約を仮定に書く | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-365 | 示せない外の契約を欠けにする | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-348 | 数の上限の行を選ばせる | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-350 | 上限の行から数を読む | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-176 | 書き手を並べる仕組みの確かめ | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-177 | 並べる仕組みのある状態の単位 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-366 | 仕組みを通らない書き込みを欠けにする | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-178 | 並べる仕組みの無い状態の単位 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-367 | 並べる仕組みの無さを欠けにする | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-179 | 使う関係の階層 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-180 | 作る関係の木 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-368 | 作られた物の要求文書を選ばせる | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-369 | 作る関係の辺を縦に準じて照らす | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-370 | 要求文書の無い作る関係の辺 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-315 | 作る関係のための縦の step | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-181 | 横の欠けを書く step | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-356 | 縦の欠けを書く step | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-323 | 縦の欠けの上の層 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-182 | 縦の対応を結ぶ | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-313 | 結べない縦の対応を補わせる | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-371 | 補った対応の印 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-372 | 補った対応を検証役に選ばせる | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-373 | 支持された対応だけを使う | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-374 | 退けられた対応を欠けにする | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-183 | 横の継ぎ目を拾う | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-184 | 頼る保証を選ばせる | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-375 | 単位の契約の破れを欠けにする | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-286 | 全体の保証に読み替えない | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-185 | 詳細化を判定させる | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-376 | 詳細化の破れを欠けにする | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-186 | 継ぎ目の持ち主 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-187 | 終端条件を選ばせる | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-377 | 終端条件のある循環を分けたまま確かめる | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-378 | 終端条件の無い循環をまとめる | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-379 | 終端条件を確かめられないことを欠けにしない | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-188 | 終わらない経路 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-189 | 安定の判定 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-190 | 安定の判定の範囲に入る文書 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-191 | .tbd.json の読み方 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-192 | 重い検査の候補 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-193 | 重い検査の要否 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-194 | 費用を選ばせる | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-382 | 費用で範囲に入れる | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-383 | 費用の比べた結果を記録する | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-195 | 費用で一部の候補を外したとき | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-196 | 費用で全ての候補を外したとき | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-197 | 保留にした候補の名指し | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-198 | 重い検査に向かない部分 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-199 | 単位ごとのモデル | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-287 | 全体を 1 つにしたモデルを作らない | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-200 | 下流への依存の広がりの順 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-316 | 並べた順に形式化する | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-201 | 性質の種別 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-428 | 性質の種別は性質ごとに 1 つ | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-429 | 表の外の種別を拒否する | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-202 | 手法の表 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-431 | audit の道具 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-449 | 道具を読めない audit のモデルを入口で拒否しない | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-450 | 道具を読めない audit のモデルの道具を推さない | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-298 | 手法の指定の受け付ける値 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-432 | 版の決まっていない道具の指定の拒否 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-297 | Alloy の版が決まるまでの拒否 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-203 | 引いた手法の表の行の記録 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-204 | 道具の固定した版の集合 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-301 | TLC を動かす Java の版を確かめる | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-288 | 版の決まっていない道具 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-433 | 版の決まっていない道具を引いたとき | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-434 | 道具の実行環境を確かめる | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-205 | 道具を取得する | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-384 | 使うたびに道具を照合する | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-385 | 照合に落ちた道具を消す | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-335 | 照合に落ちたときの応答 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-386 | 照合を通った道具だけを動かす | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-206 | 道具を用意できないとき | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-207 | 抜き出しから生成してから抽象化する | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-208 | 手で写した部分の記録 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-209 | 丸めたものの記録 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-210 | 有限範囲の記録 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-436 | 証明の道具に有限範囲の記録を当てない | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-317 | 届かない境界値の記録 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-302 | 有限範囲を狭めたときの記録 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-303 | 状態数の上限で探索を打ち切る | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-387 | 打ち切った探索の記録 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-339 | 検査器の 1 回の時間の上限 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-340 | 運搬役 1 起動の tool-run は 1 回 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-380 | 検査器のプロセスグループ | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-342 | 止めた検査器の子プロセス | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-381 | 検査器の作業ディレクトリの置き場 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-388 | 止めた検査器の作業ディレクトリを消す | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-211 | 前提と公平性の宣言 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-289 | 環境の行動を自動と仮定しない | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-212 | 対応表 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-318 | 割り当ての無い行を数える | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-213 | 節の固定 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-319 | 節の固定を照らす | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-214 | 忠実さの層の宣言 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-215 | 写した忠実さの層の間の照合 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-320 | 照らさなかった層の組 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-216 | 状態の投影を作る | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-389 | 投影を図と照らす | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-390 | 照らす図が無いとき | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-217 | 列挙の欠落の注記 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-218 | 再実行できる形 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-452 | モデルの説明の検査の節 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-321 | check.json だけから動かす | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-219 | 遷移から転記した条件 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-220 | 作る機能が確かめる中身 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-221 | モデルの欠けを run の中で直す | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-222 | 検査の性質の集合を作る | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-437 | mutations.json の形 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-391 | 変異と witness の無い性質を欠けにする | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-445 | 変異の置き場 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-446 | 変異を当てた写しで検査する | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-447 | 当てられない変異 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-223 | 反例の有無の数え方 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-438 | 証明の未完了の印を合格にしない | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-439 | 違反の行の決まっていない道具を合格にしない | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-224 | 空振り | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-453 | 恒真の性質の行の設定 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-454 | 前件が常に真の性質の行の設定 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-460 | 替えた設定の置き方 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-461 | 型の制約の性質に恒真の性質の行を当てない | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-455 | 型の制約を推さない | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-456 | 空振りの写しの検査が終わらないとき | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-457 | 説明が名指す検査の名前の集合 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-458 | 空振りの確かめに要るものが無いモデル | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-440 | finite の性質の合否 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-441 | finite の性質の空振り | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-442 | finite の性質に検査器の数え方を当てない | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-443 | 重い検査を行わないときの check の項目 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-225 | 忠実さの項目 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-392 | 忠実さを判定させる | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-393 | 緩いモデルと強いモデルを欠けにする | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-226 | 忠実さの層の抜け | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-227 | 足した制約を挙げさせる | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-394 | 足した制約を欠けにする | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-395 | 足した制約を外して動かす | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-396 | 外して出た反例を添える | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-228 | 節の固定が無い節を欠けにする | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-397 | 落ちない節の固定を欠けにする | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-229 | 再実行で同じ結果になること | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-230 | 有限範囲の対応を選ばせる | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-398 | 届かない定数を欠けにする | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-231 | 生成と手で写すことの境目 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-232 | 記録のファイルが無いモデルを拒否しない | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-399 | 無いファイルに拠る確かめ | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-233 | audit の返し方 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-236 | 帰属の規則 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-237 | 上流に定めが無い欠けの位置 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-238 | 帰属を判定させる | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-400 | 決まらない帰属をもう一度判定させる | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-401 | あいまいとする | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-402 | あいまいな欠けの帰属先 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-403 | 帰属の規則に使う basis | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-239 | 直し方の候補 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-240 | 性質の違反 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-241 | 範囲と限界の記録の形 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-242 | 範囲と限界の記録の一時ファイル | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-404 | 一時ファイルを書けないとき | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-405 | 一時ファイルを scope.json にする | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-406 | 停止の記録を足せないときの一時ファイル | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-243 | 範囲と限界の記録を返す | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-244 | 状態に書かずに止まる run の返り値 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-290 | 状態に書かずに止まる run の範囲と限界の記録 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-245 | 空の縦 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-246 | 性質の洗い出しの項目 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-407 | 性質を洗い出させる | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-444 | コードで書ける道具を返させる | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-459 | 指定の道具で書けるかを返させる | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-430 | finite の性質の照合の script | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-448 | 照らす対象の外の変える行を受理しない | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-408 | 性質を検証役に確かめさせる | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-409 | 支持された性質だけを書く | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-410 | 漏れを 1 回だけ渡し直す | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-411 | 残った漏れと不支持の性質を記録する | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-247 | 仕分けの記録 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-248 | 試行の失敗を書く | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-412 | 試行の回数を累計で数える | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-420 | 試行の上限に達したかを返す | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-413 | 上限に達していない項目を試し直す | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-414 | 上限に達した項目で止まる | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-249 | 起動数の上限と試行の上限が同時に当たるとき | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-250 | 試行の上限の項目を戻した記録 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-415 | 戻した項目を未着手にする | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-416 | 戻した項目に 1 回の試行を許す | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-251 | 収束しないという判定 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-425 | 収束の判定に使う回 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-252 | 収束しないとき | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-253 | 規則を書いた位置を選ばせる | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-417 | 選んだ位置を検証役に確かめさせる | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-418 | 規則の散在を欠けにする | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-254 | 修正の回の上限 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-255 | 書いてよい先に書けないとき | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-256 | 終えた step を起動し直さない | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-426 | 終えた step の結果を状態から使う | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-257 | 入力の変化の印 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-419 | 入力の変化の印の step の結果を使わない | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-258 | 入力の指紋を照らす時点 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-259 | run をまたぐ欠けの結び付けの保持規則 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-260 | 修正と再検証を同じ run で行わない | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-261 | 停止の記録の無い終わりの後の起動 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-294 | 続きからの起動の入力 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-262 | CLI が決める停止の行 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-424 | script が決める停止の行 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-263 | 保存の失敗がほかの行と重なるとき | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-266 | 作る機能の完了の条件 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-267 | audit の完了の条件 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-268 | 重い検査の対象なし | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-269 | 起動数の上限の受け取り | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-270 | 上限を渡された run の確かめ | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-271 | 停止の記録を書く起動を残す予約分 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-272 | 上限に収まらないとき新しい単位を始めない | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-421 | 始めた単位の終わりを待つ | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-422 | 始めなかった項目を未着手として残す | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-423 | 上限で止まった理由 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-273 | 上限を渡されない run | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-274 | 起動数の上限を Codex runner の経路で渡す | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-427 | runner の request の上限 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-291 | native Workflow の経路では上限を渡さない | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-275 | 自分の要求文書に軽い検査を当てる | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-276 | 安定したら重い検査を当てる | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-277 | 自身のモデルの置き場 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-322 | 自身のモデルを make test で動かす | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-278 | 自身の性質の仕分け | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-279 | 形式化できるものを機械で確かめる | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-280 | 形式化できないものを PR のレビューで確かめる | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-281 | 自身への適用の範囲の記録 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-282 | 結果を返さない役 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-283 | CLI の拒否の扱い | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-284 | 停止の送り直し | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-122 | CLI の操作 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-264 | 停止の行ごとの返り値の欄の並び | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-265 | next_args の形 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-234 | 欠けの形 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-FORMALMETHODS-235 | 欠けの型の綴り | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/formal-methods.md` |
| SP-VERIFICATION-001 | 検査の対象 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/verification.md` |
| SP-VERIFICATION-042 | 照合元の入力の引き渡し | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/verification.md` |
| SP-VERIFICATION-002 | 検査ごとの独立した実施 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/verification.md` |
| SP-VERIFICATION-003 | 検査記録の生成 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/verification.md` |
| SP-VERIFICATION-004 | 未実施と指摘 0 件の区別 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/verification.md` |
| SP-VERIFICATION-005 | 検査記録の引き渡し | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/verification.md` |
| SP-VERIFICATION-006 | 指摘に含める情報 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/verification.md` |
| SP-VERIFICATION-043 | 判定できなかったときに同一とみなさないこと | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/verification.md` |
| SP-VERIFICATION-045 | 判定できなかったときの依頼者への確認 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/verification.md` |
| SP-VERIFICATION-007 | 実行可能性の判定の実施 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/verification.md` |
| SP-VERIFICATION-009 | 着手できない箇所の起票の指摘 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/verification.md` |
| SP-VERIFICATION-010 | 起票済みの論点と決めないと決めた事項を指摘しない | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/verification.md` |
| SP-VERIFICATION-011 | 文書外の知識に依存した記述の検出 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/verification.md` |
| SP-VERIFICATION-012 | 未決の選択肢の検出 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/verification.md` |
| SP-VERIFICATION-013 | 測定できない語の検出 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/verification.md` |
| SP-VERIFICATION-014 | 語尾の検査 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/verification.md` |
| SP-VERIFICATION-015 | 複合要求の検出 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/verification.md` |
| SP-VERIFICATION-016 | 根拠の併記の検査 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/verification.md` |
| SP-VERIFICATION-017 | 識別子の重複の検出 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/verification.md` |
| SP-VERIFICATION-018 | 実現する仕様項目が無い要求の検出 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/verification.md` |
| SP-VERIFICATION-019 | 根拠となる要求が無い仕様項目の検出 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/verification.md` |
| SP-VERIFICATION-020 | 検証方法が無い要求の検出 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/verification.md` |
| SP-VERIFICATION-021 | 表が参照する識別子が実在しないことの検出 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/verification.md` |
| SP-VERIFICATION-022 | 本文が参照する識別子が実在しないことの検出 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/verification.md` |
| SP-VERIFICATION-023 | 照合の相手を欠くときの申告 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/verification.md` |
| SP-VERIFICATION-024 | 相反する記述の検出 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/verification.md` |
| SP-VERIFICATION-025 | 用語の揺れの検出 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/verification.md` |
| SP-VERIFICATION-026 | 二重に置かれた記述の検出 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/verification.md` |
| SP-VERIFICATION-027 | 未定義の組み合わせの検出 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/verification.md` |
| SP-VERIFICATION-028 | 入力に根拠が無い断定の検出 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/verification.md` |
| SP-VERIFICATION-029 | 未回答の事項を埋めた記述の検出 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/verification.md` |
| SP-VERIFICATION-031 | 直し方が示す文書の改稿 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/verification.md` |
| SP-VERIFICATION-032 | 直し方が示す箇所以外の維持 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/verification.md` |
| SP-VERIFICATION-033 | 上限に達していない間の改稿後の再検査 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/verification.md` |
| SP-VERIFICATION-034 | 反復の上限に達したときの終了 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/verification.md` |
| SP-VERIFICATION-035 | 上限に達したときの申告 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/verification.md` |
| SP-VERIFICATION-036 | 反復の終了 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/verification.md` |
| SP-VERIFICATION-037 | 創作による解消の禁止 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/verification.md` |
| SP-VERIFICATION-038 | 検査対象が 0 件のとき | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/verification.md` |
| SP-VERIFICATION-039 | 検査結果が定めた形式に合わないとき | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/verification.md` |
| SP-VERIFICATION-044 | やり直しても形式に合わないとき | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/verification.md` |
| SP-VERIFICATION-041 | 検査を 1 件も実施できなかったときの終了 | `/Users/yoshiki.hemmi/github/yoshiysh/claude-plugins/.claude/worktrees/pr198/docs/specifications/verification.md` |

## 検査結果

- ID の重複: 0 件
