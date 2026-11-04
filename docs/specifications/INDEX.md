# docs/specifications 目次

この INDEX は doc_check が文書から導出したものである。本体を直したら導出し直す（手書きしない）。

## 文書一覧

| パス | 扱う関心事 | どういう仕様項目が書かれているか |
|---|---|---|
| `docs/specifications/authoring.md` | 仕様書: 生成される文書の記述仕様 | 文書の種別と分量／章構成／要求文と仕様項目の書き方／重複と矛盾／ID 体系／トレーサビリティ表／未確定事項の書式／保持規則／ファイル配置と INDEX／状態とイベントの記述／外部規格への言及／根拠が得られない事項の扱い／機械検査が参照する語の集合（SP-AUTHORING-001〜088、欠番は 001・002・004・019・049・083・084／81 件） |
| `docs/specifications/bp-authoring.md` | 仕様書: create と update の流れ | 対象スキルと run の入力／段の並び／目標の固定／書く／検証／合否／形式検証／停止／エラー処理と異常系／外部インタフェース（SP-BPAUTHORING-001〜046／46 件） |
| `docs/specifications/bp-conformance.md` | 仕様書: 対象スキルが備える性質の判定基準と、対象スキルに課す確定値 | 判定の当て方／配置の原則／形の判定／資産台帳／run の記録／形に関わる原則／配布先での確認／fan-out の起動数の上限／性能・容量（対象スキルに課す確定値）／エラー処理と異常系（SP-BPCONFORMANCE-001〜041／41 件） |
| `docs/specifications/bp-entry.md` | 仕様書: 依頼の振り分け・機能の連鎖・Workflow callsite | 振り分け／連鎖／Workflow callsite／エラー処理と異常系／外部インタフェース（SP-BPENTRY-001〜025／25 件） |
| `docs/specifications/bp-findings.md` | 仕様書: 指摘と資産台帳 | 台帳と資産／結果の結び付き／反証／指摘の状態／カバレッジと skip 一覧／run をまたぐ指摘の扱い／指摘の形／エラー処理と異常系（SP-BPFINDINGS-001〜037／37 件） |
| `docs/specifications/bp-inspection.md` | 仕様書: review と audit の観点と流れ | 形と段／観点／フローの観点／監査の観点／担当と起動／対象を書き換えない／対象スキル／外部インタフェース／エラー処理と異常系（SP-BPINSPECTION-001〜030／30 件） |
| `docs/specifications/bp-run.md` | 仕様書: best-practices の実行基盤 | run の境界／状態と作業場所／run の記録／停止／再開／起動数の上限／判定基準の写し／モデル・effort・権限／エラー処理と異常系／外部インタフェース／性能・容量（SP-BPRUN-001〜048／48 件） |
| `docs/specifications/develop-address-review.md` | 仕様書: develop:address-review の詳細仕様・分類・返信 | 指摘の収集／分類と独立検証／triage 構造の保持と引き渡し／停止結果の引き継ぎ／implement 修正結果の検証／push／CI 待ち／返信／resolve（SP-DEVELOPADDRESSREVIEW-001〜009／9 件） |
| `docs/specifications/develop-implement.md` | 仕様書: develop:implement の詳細仕様・経路・制御 | 目標の固定／方針の版とブランチ／経路分岐／計画の run とケース計画／洗い出し段／作業ファイルの読み手制限／run 内外の引き渡し／check／review 修正ループ／根を探す段／人間ゲート／即時停止／最終照合・commit・push（SP-DEVELOPIMPLEMENT-001〜013／13 件） |
| `docs/specifications/develop-plugin.md` | 仕様書: develop plugin の共通基盤・利用側の宣言・CLI 契約 | 呼び出し名と配布／スキル間呼び出し／実行環境判定／固有値の外部化／利用側の宣言／方針の版／方針文書／言語制御／変更の種類の分類／状態と世代管理／run 返り値と record-run／事後変化検出／停止情報／relaunch 禁止／モデル・effort 指定（SP-DEVELOPPLUGIN-001〜015／15 件） |
| `docs/specifications/develop-review.md` | 仕様書: develop:review の詳細仕様・観点・2 段検証 | 対象と diff／観点と focus／洗い出しの束の配分／並列 reviewer／2 段検証／確定指摘の構造保持／運搬役の軽量化／PR 投稿・確認／external モード（SP-DEVELOPREVIEW-001〜009／9 件） |
| `docs/specifications/elicitation.md` | 仕様書: 事前分析と依頼者への問いかけ | 観点の判定／分割案／判定の委ね方／質問の生成と絞り込み／回答の反映／エラー処理と異常系（SP-ELICITATION-001〜049、欠番は 005・006・007・011・016・019・021・022・023・028 ほか 6 件／33 件） |
| `docs/specifications/flow.md` | 仕様書: 全体の制御 | 起動時の判定／根拠として扱う入力の範囲／中断点と順序の制約／未確定事項の区分・周回・完成判定／保存／中断（SP-FLOW-001〜047、欠番は 001・006・008・009・023・038／41 件） |
| `docs/specifications/verification.md` | 仕様書: 生成物の検査と改稿 | 検査の実行と記録／同一性の判定／実行可能性の判定／記述規約の検査／構造の検査／文書間の検査／網羅の検査／根拠の検査／改稿の反復／エラー処理と異常系（SP-VERIFICATION-001〜045、欠番は 008・030・040／42 件） |

## 仕様項目一覧

| ID | 見出し | 所在文書 |
|---|---|---|
| SP-AUTHORING-003 | 要求文書の分量の決め方 | `docs/specifications/authoring.md` |
| SP-AUTHORING-005 | 仕様書の記述水準の下限 | `docs/specifications/authoring.md` |
| SP-AUTHORING-006 | 仕様書の記述水準の上限 | `docs/specifications/authoring.md` |
| SP-AUTHORING-007 | 要求文書が持つ内容 | `docs/specifications/authoring.md` |
| SP-AUTHORING-008 | 仕様書が持つ内容 | `docs/specifications/authoring.md` |
| SP-AUTHORING-009 | 条件付き章の設置条件 | `docs/specifications/authoring.md` |
| SP-AUTHORING-010 | 常設章を削らないこと | `docs/specifications/authoring.md` |
| SP-AUTHORING-087 | 常設章に該当が無いことの記述 | `docs/specifications/authoring.md` |
| SP-AUTHORING-011 | 見出しのレベル | `docs/specifications/authoring.md` |
| SP-AUTHORING-012 | 分割時の常設章の自足 | `docs/specifications/authoring.md` |
| SP-AUTHORING-013 | リスクと影響章の判定の表記 | `docs/specifications/authoring.md` |
| SP-AUTHORING-014 | リスクと影響章の観点の範囲 | `docs/specifications/authoring.md` |
| SP-AUTHORING-015 | 機能固有の異常系の置き場 | `docs/specifications/authoring.md` |
| SP-AUTHORING-016 | 共通の異常系の置き場 | `docs/specifications/authoring.md` |
| SP-AUTHORING-017 | 表記規約の凡例 | `docs/specifications/authoring.md` |
| SP-AUTHORING-018 | 語尾の限定 | `docs/specifications/authoring.md` |
| SP-AUTHORING-020 | 曖昧語の排除 | `docs/specifications/authoring.md` |
| SP-AUTHORING-021 | 単位の明示 | `docs/specifications/authoring.md` |
| SP-AUTHORING-022 | 境界包含語の使用 | `docs/specifications/authoring.md` |
| SP-AUTHORING-023 | 定めた境界の明示 | `docs/specifications/authoring.md` |
| SP-AUTHORING-024 | 範囲外の値を受け取ったときの振る舞い | `docs/specifications/authoring.md` |
| SP-AUTHORING-025 | 閾値が未確定のときの扱い | `docs/specifications/authoring.md` |
| SP-AUTHORING-026 | 単一要求 | `docs/specifications/authoring.md` |
| SP-AUTHORING-027 | 条件節の構文 | `docs/specifications/authoring.md` |
| SP-AUTHORING-028 | 望ましくない事象の条件節 | `docs/specifications/authoring.md` |
| SP-AUTHORING-029 | 根拠の併記 | `docs/specifications/authoring.md` |
| SP-AUTHORING-030 | 根拠に書いてよい出所 | `docs/specifications/authoring.md` |
| SP-AUTHORING-031 | 根拠の分量 | `docs/specifications/authoring.md` |
| SP-AUTHORING-032 | 文書外の知識に依存しない記述 | `docs/specifications/authoring.md` |
| SP-AUTHORING-033 | 実在の人物を特定する表記の排除 | `docs/specifications/authoring.md` |
| SP-AUTHORING-034 | 人物の役割名による記述 | `docs/specifications/authoring.md` |
| SP-AUTHORING-035 | 変更履歴の章 | `docs/specifications/authoring.md` |
| SP-AUTHORING-036 | 改稿の経緯 | `docs/specifications/authoring.md` |
| SP-AUTHORING-037 | 用語の固定 | `docs/specifications/authoring.md` |
| SP-AUTHORING-038 | 解釈が分かれる語の定義 | `docs/specifications/authoring.md` |
| SP-AUTHORING-039 | 正となる記述の単一性 | `docs/specifications/authoring.md` |
| SP-AUTHORING-040 | 相反する記述の排除 | `docs/specifications/authoring.md` |
| SP-AUTHORING-041 | ID の形式 | `docs/specifications/authoring.md` |
| SP-AUTHORING-042 | 領域コード | `docs/specifications/authoring.md` |
| SP-AUTHORING-043 | 未確定事項の領域コードの接頭辞 | `docs/specifications/authoring.md` |
| SP-AUTHORING-044 | ID の不変性 | `docs/specifications/authoring.md` |
| SP-AUTHORING-082 | 削除した項目の ID の欠番化 | `docs/specifications/authoring.md` |
| SP-AUTHORING-045 | 参照する ID の実在 | `docs/specifications/authoring.md` |
| SP-AUTHORING-046 | 全要求の紐付け | `docs/specifications/authoring.md` |
| SP-AUTHORING-047 | 表の列構成 | `docs/specifications/authoring.md` |
| SP-AUTHORING-048 | 検証方法欄の内容 | `docs/specifications/authoring.md` |
| SP-AUTHORING-050 | 表の置き場と範囲 | `docs/specifications/authoring.md` |
| SP-AUTHORING-051 | 実装対象外の要求の扱い | `docs/specifications/authoring.md` |
| SP-AUTHORING-052 | 要求と仕様項目の対応の多重度 | `docs/specifications/authoring.md` |
| SP-AUTHORING-053 | 未確定事項の置き場 | `docs/specifications/authoring.md` |
| SP-AUTHORING-054 | 未確定事項の区分 | `docs/specifications/authoring.md` |
| SP-AUTHORING-055 | 着手不能の未確定事項の一覧 | `docs/specifications/authoring.md` |
| SP-AUTHORING-056 | 未確定事項が持つ情報 | `docs/specifications/authoring.md` |
| SP-AUTHORING-057 | 決定者と期限を持たない | `docs/specifications/authoring.md` |
| SP-AUTHORING-058 | 未確定事項の本文 | `docs/specifications/authoring.md` |
| SP-AUTHORING-059 | 要求文からの未確定事項の参照 | `docs/specifications/authoring.md` |
| SP-AUTHORING-088 | 保持規則の書き方 | `docs/specifications/authoring.md` |
| SP-AUTHORING-060 | 保存先のパス | `docs/specifications/authoring.md` |
| SP-AUTHORING-061 | topic の字種 | `docs/specifications/authoring.md` |
| SP-AUTHORING-062 | 領域コードの衝突 | `docs/specifications/authoring.md` |
| SP-AUTHORING-063 | INDEX の導出 | `docs/specifications/authoring.md` |
| SP-AUTHORING-064 | 要求文書の INDEX が持つ内容 | `docs/specifications/authoring.md` |
| SP-AUTHORING-065 | 仕様書の INDEX が持つ内容 | `docs/specifications/authoring.md` |
| SP-AUTHORING-066 | 逆参照の置き場 | `docs/specifications/authoring.md` |
| SP-AUTHORING-067 | 組み合わせの網羅の示し方 | `docs/specifications/authoring.md` |
| SP-AUTHORING-081 | 図で示してよい内容の限定 | `docs/specifications/authoring.md` |
| SP-AUTHORING-068 | 状態遷移図の設置 | `docs/specifications/authoring.md` |
| SP-AUTHORING-069 | 遷移への仕様項目 ID の付与 | `docs/specifications/authoring.md` |
| SP-AUTHORING-070 | イベント集合の宣言 | `docs/specifications/authoring.md` |
| SP-AUTHORING-071 | 行の起こし方 | `docs/specifications/authoring.md` |
| SP-AUTHORING-072 | 状態 × イベント表の行が持つ情報 | `docs/specifications/authoring.md` |
| SP-AUTHORING-073 | 発生しない組み合わせの行を削除しないこと | `docs/specifications/authoring.md` |
| SP-AUTHORING-085 | 発生しない組み合わせの行の空欄 | `docs/specifications/authoring.md` |
| SP-AUTHORING-086 | 発生しない組み合わせの根拠 | `docs/specifications/authoring.md` |
| SP-AUTHORING-074 | 主フローの遷移の置き場 | `docs/specifications/authoring.md` |
| SP-AUTHORING-075 | 図の記法 | `docs/specifications/authoring.md` |
| SP-AUTHORING-076 | 言及の条件 | `docs/specifications/authoring.md` |
| SP-AUTHORING-077 | 準拠の主張 | `docs/specifications/authoring.md` |
| SP-AUTHORING-078 | 条番号を付けた引用 | `docs/specifications/authoring.md` |
| SP-AUTHORING-079 | 根拠が無い事項の起票 | `docs/specifications/authoring.md` |
| SP-AUTHORING-080 | 語の集合への参照 | `docs/specifications/authoring.md` |
| SP-BPAUTHORING-001 | create の対象スキルのパス | `docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-002 | 書き換えてよい範囲 | `docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-003 | 依頼文を状態に残す | `docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-004 | 作り直す前の写し | `docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-005 | 段の並びと反復 | `docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-036 | 項目の ID に含める番号 | `docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-006 | 目標の固定の段 | `docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-007 | 出所の照合 | `docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-008 | 待たれる入力の不足 | `docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-009 | 固定した目標を前提に書く | `docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-010 | 再開した run の目標の固定 | `docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-011 | 書く段の書き手 | `docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-012 | 形の判定の当て方 | `docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-013 | 書き手が対象スキルに入れてはならないもの | `docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-014 | 書き直しの入力 | `docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-015 | 書いたパスの照合 | `docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-016 | 観点と担当 | `docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-017 | 適合の観点 | `docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-046 | Claude Code での役ごとの制限の照らし方 | `docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-018 | 目標の観点 | `docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-037 | 依頼に無い目標・制約の照らし方 | `docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-038 | 判定基準が求めた制約 | `docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-019 | 契約の観点 | `docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-039 | 契約の変化の返し方 | `docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-040 | 既存の振る舞いの判定 | `docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-020 | 1 回の反復の中の検証の順 | `docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-041 | fan-out の項目の順位 | `docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-021 | 判定の単位の結果 | `docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-022 | 指摘による合否 | `docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-023 | 反復の合否 | `docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-024 | 反復の数え方 | `docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-025 | 合否の後の進み方 | `docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-026 | 完了の条件 | `docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-042 | 形式検証の段 | `docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-043 | 形式検証の記録 | `docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-044 | 形式検証の段を通ったとするとき | `docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-045 | 形式検証の失敗 | `docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-027 | needs_input で止まるところ | `docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-028 | 止まったときに書いたファイルと報告 | `docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-035 | 再開した run が始めるところ | `docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-029 | 状態を作る前の入力の確かめ | `docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-030 | 検証が成り立たない | `docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-031 | 一覧の外へのパス | `docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-032 | 検証の結果 | `docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-033 | 完了時の出力 | `docs/specifications/bp-authoring.md` |
| SP-BPAUTHORING-034 | 完了の前に止まったときの報告 | `docs/specifications/bp-authoring.md` |
| SP-BPCONFORMANCE-001 | 判定基準の正本 | `docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-002 | 判定の単位 | `docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-003 | 適用の判定表 | `docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-041 | 判断点の表の照合 | `docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-004 | 形の判定の順序 | `docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-005 | 探索グラフの適用条件 | `docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-006 | 重い形を強いた条件の記録 | `docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-007 | Workflow にしない判定 | `docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-008 | 部品による組み立て | `docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-009 | 資産台帳の要否 | `docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-039 | run の記録の判定 | `docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-040 | run の記録の置き場 | `docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-010 | 目標の固定 | `docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-011 | 停止・再開と人間の入力 | `docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-012 | 体数と同時実行 | `docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-013 | モデル・effort・prompt | `docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-014 | 権限 | `docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-015 | 探索グラフ | `docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-034 | 実行役の時間の上限 | `docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-016 | 状態の書き込み | `docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-017 | 資産台帳の原則 | `docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-018 | 判定の範囲と結果の宣言 | `docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-019 | 役ごとの制限の確かめ方 | `docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-020 | 確かめられなかった制限の報告 | `docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-021 | 起動数の上限の受け取り | `docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-037 | 起動数の上限の入力が不正なとき | `docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-022 | 上限を渡された run の起動数 | `docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-023 | 上限に収まらない項目 | `docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-024 | 残した項目からの再開 | `docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-025 | 上限を渡されない run | `docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-026 | callsite の経路と上限の受け渡し | `docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-027 | 同時実行の上限 | `docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-028 | until-pass の繰り返しの上限 | `docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-029 | 固定集合の反復型の反復の上限 | `docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-030 | 探索グラフの周の上限 | `docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-031 | 同じ意図の試行の上限 | `docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-032 | 乾きの定義と乾き停止 | `docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-033 | 要約の大きさの上限 | `docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-035 | 役ごとのモデルと effort の指定 | `docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-036 | 確定値の置き方 | `docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-038 | 判定の単位を判定できないとき | `docs/specifications/bp-conformance.md` |
| SP-BPENTRY-001 | 4 機能の入口 | `docs/specifications/bp-entry.md` |
| SP-BPENTRY-002 | 振り分けを行う場所 | `docs/specifications/bp-entry.md` |
| SP-BPENTRY-003 | 機能の当て方 | `docs/specifications/bp-entry.md` |
| SP-BPENTRY-004 | 機能の列の作り方 | `docs/specifications/bp-entry.md` |
| SP-BPENTRY-005 | 機能が 1 つに決まらない部分 | `docs/specifications/bp-entry.md` |
| SP-BPENTRY-006 | 対象スキルのパスの一覧 | `docs/specifications/bp-entry.md` |
| SP-BPENTRY-022 | パスの一覧に入れるファイル | `docs/specifications/bp-entry.md` |
| SP-BPENTRY-023 | パスの一覧を作れないとき | `docs/specifications/bp-entry.md` |
| SP-BPENTRY-007 | 連鎖の実行 | `docs/specifications/bp-entry.md` |
| SP-BPENTRY-008 | 次の機能へ進む条件 | `docs/specifications/bp-entry.md` |
| SP-BPENTRY-009 | 前の機能の結果の渡し方 | `docs/specifications/bp-entry.md` |
| SP-BPENTRY-010 | 結果を書き換えずに渡す | `docs/specifications/bp-entry.md` |
| SP-BPENTRY-011 | 当たる機能が無い依頼 | `docs/specifications/bp-entry.md` |
| SP-BPENTRY-012 | 一部が当たらない依頼 | `docs/specifications/bp-entry.md` |
| SP-BPENTRY-013 | callsite の入力 | `docs/specifications/bp-entry.md` |
| SP-BPENTRY-014 | 経路の選び方 | `docs/specifications/bp-entry.md` |
| SP-BPENTRY-015 | 起動数の上限の渡し方 | `docs/specifications/bp-entry.md` |
| SP-BPENTRY-016 | Codex runner の request | `docs/specifications/bp-entry.md` |
| SP-BPENTRY-024 | Codex runner の経路の前提 | `docs/specifications/bp-entry.md` |
| SP-BPENTRY-025 | runner と runtime README の変更 | `docs/specifications/bp-entry.md` |
| SP-BPENTRY-017 | 返り値の無い run | `docs/specifications/bp-entry.md` |
| SP-BPENTRY-018 | どの経路も無い | `docs/specifications/bp-entry.md` |
| SP-BPENTRY-019 | create を列の先頭以外に置く依頼 | `docs/specifications/bp-entry.md` |
| SP-BPENTRY-020 | 渡せる形でない前の結果 | `docs/specifications/bp-entry.md` |
| SP-BPENTRY-021 | 利用者への返り値 | `docs/specifications/bp-entry.md` |
| SP-BPFINDINGS-001 | 台帳の作成 | `docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-002 | 資産の単位 | `docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-003 | 資産 ID | `docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-004 | 内容の指紋 | `docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-005 | 台帳の取り直し | `docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-006 | 資産の同一性を決める主体 | `docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-007 | 検証役が返す形 | `docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-008 | 「見た」の記録 | `docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-009 | 「確認済みで問題なし」の記録 | `docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-010 | 観点と指摘の種類の閉集合 | `docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-011 | 指摘の鍵と指摘 ID | `docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-036 | 同じ指摘の決め方 | `docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-012 | 重複する候補 | `docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-013 | 反証の実施 | `docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-014 | 反証の結果の記録 | `docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-015 | 未反証の候補 | `docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-016 | 状態の集合 | `docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-017 | 状態の記録の仕方 | `docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-018 | 見直しの判定 | `docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-019 | 状態の遷移 | `docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-020 | 消えた資産の指摘の照合 | `docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-037 | 消えた資産の照合の結果の記録 | `docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-021 | 判定の時点の記録 | `docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-022 | カバレッジ | `docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-023 | skip 一覧 | `docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-024 | 資産の結末 | `docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-025 | skip 一覧への追加の起動 | `docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-026 | 台帳の範囲 | `docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-027 | 入力に受け取った前の run の指摘 | `docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-028 | 報告する指摘の状態 | `docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-029 | 結果に載せる指摘の項目 | `docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-030 | 結果に載せる台帳の項目 | `docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-031 | 修正の根拠の形 | `docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-032 | create と update の完了時に返す指摘 | `docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-033 | 資産が 0 件のとき | `docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-034 | 台帳に無い値を含む結果 | `docs/specifications/bp-findings.md` |
| SP-BPFINDINGS-035 | 台帳と食い違う書き込み | `docs/specifications/bp-findings.md` |
| SP-BPINSPECTION-001 | 段の並び | `docs/specifications/bp-inspection.md` |
| SP-BPINSPECTION-002 | 段の間に戻りを置かない | `docs/specifications/bp-inspection.md` |
| SP-BPINSPECTION-003 | 観点の集合 | `docs/specifications/bp-inspection.md` |
| SP-BPINSPECTION-004 | 照らす先の決定 | `docs/specifications/bp-inspection.md` |
| SP-BPINSPECTION-005 | 仕様書を読めないとき | `docs/specifications/bp-inspection.md` |
| SP-BPINSPECTION-006 | 適用の判定 | `docs/specifications/bp-inspection.md` |
| SP-BPINSPECTION-007 | フローの観点の判定 | `docs/specifications/bp-inspection.md` |
| SP-BPINSPECTION-008 | 仕様の観点の判定 | `docs/specifications/bp-inspection.md` |
| SP-BPINSPECTION-009 | 監査の観点の一覧 | `docs/specifications/bp-inspection.md` |
| SP-BPINSPECTION-010 | 一覧と出所の照合 | `docs/specifications/bp-inspection.md` |
| SP-BPINSPECTION-011 | 監査の範囲 | `docs/specifications/bp-inspection.md` |
| SP-BPINSPECTION-012 | 監査の観点の優先 | `docs/specifications/bp-inspection.md` |
| SP-BPINSPECTION-013 | モデルに固有の鮮度 | `docs/specifications/bp-inspection.md` |
| SP-BPINSPECTION-014 | 引き継がないもの | `docs/specifications/bp-inspection.md` |
| SP-BPINSPECTION-015 | 担当の作り方 | `docs/specifications/bp-inspection.md` |
| SP-BPINSPECTION-016 | 検証の項目と順位 | `docs/specifications/bp-inspection.md` |
| SP-BPINSPECTION-017 | 検証役に渡すもの | `docs/specifications/bp-inspection.md` |
| SP-BPINSPECTION-018 | 反証の起動 | `docs/specifications/bp-inspection.md` |
| SP-BPINSPECTION-019 | 照合と停止 | `docs/specifications/bp-inspection.md` |
| SP-BPINSPECTION-020 | 書き手の役を持たない | `docs/specifications/bp-inspection.md` |
| SP-BPINSPECTION-021 | 対象は既にあるスキル | `docs/specifications/bp-inspection.md` |
| SP-BPINSPECTION-022 | 対象スキルのパスの一覧 | `docs/specifications/bp-inspection.md` |
| SP-BPINSPECTION-023 | review と audit の入力 | `docs/specifications/bp-inspection.md` |
| SP-BPINSPECTION-024 | review と audit に固有の結果の項目 | `docs/specifications/bp-inspection.md` |
| SP-BPINSPECTION-025 | 未検査の観点の形と載せるもの | `docs/specifications/bp-inspection.md` |
| SP-BPINSPECTION-026 | 対象が既にあるスキルでない | `docs/specifications/bp-inspection.md` |
| SP-BPINSPECTION-027 | フローの観点・監査の観点の照らす先を読めない | `docs/specifications/bp-inspection.md` |
| SP-BPINSPECTION-028 | 監査の観点の一覧が出所と食い違う | `docs/specifications/bp-inspection.md` |
| SP-BPINSPECTION-029 | 再開したときの照らす先の食い違い | `docs/specifications/bp-inspection.md` |
| SP-BPINSPECTION-030 | 再開した run の段の順 | `docs/specifications/bp-inspection.md` |
| SP-BPRUN-001 | 機能ごとの run | `docs/specifications/bp-run.md` |
| SP-BPRUN-002 | run の中で入力を待たない | `docs/specifications/bp-run.md` |
| SP-BPRUN-003 | run の開始 | `docs/specifications/bp-run.md` |
| SP-BPRUN-004 | 前提の書き込み | `docs/specifications/bp-run.md` |
| SP-BPRUN-005 | 状態の中身 | `docs/specifications/bp-run.md` |
| SP-BPRUN-006 | 状態の書き込みの規則 | `docs/specifications/bp-run.md` |
| SP-BPRUN-007 | 作業場所の置き場 | `docs/specifications/bp-run.md` |
| SP-BPRUN-039 | 作業場所を残す場所 | `docs/specifications/bp-run.md` |
| SP-BPRUN-008 | 書き込み先の制限 | `docs/specifications/bp-run.md` |
| SP-BPRUN-009 | 書いたファイルの記録 | `docs/specifications/bp-run.md` |
| SP-BPRUN-038 | 段の開始と項目の列挙 | `docs/specifications/bp-run.md` |
| SP-BPRUN-041 | 作業記録 | `docs/specifications/bp-run.md` |
| SP-BPRUN-042 | 記録台帳 | `docs/specifications/bp-run.md` |
| SP-BPRUN-043 | 文書の一般規約の写しと版 | `docs/specifications/bp-run.md` |
| SP-BPRUN-044 | 記録の保持 | `docs/specifications/bp-run.md` |
| SP-BPRUN-046 | 性能の記録 | `docs/specifications/bp-run.md` |
| SP-BPRUN-010 | 停止の種類 | `docs/specifications/bp-run.md` |
| SP-BPRUN-011 | 停止の記録 | `docs/specifications/bp-run.md` |
| SP-BPRUN-012 | 停止で書いたファイルを戻さない | `docs/specifications/bp-run.md` |
| SP-BPRUN-013 | 反復の上限の数え方 | `docs/specifications/bp-run.md` |
| SP-BPRUN-014 | 再開の起動 | `docs/specifications/bp-run.md` |
| SP-BPRUN-015 | 再開した run の始め方 | `docs/specifications/bp-run.md` |
| SP-BPRUN-016 | 再開時の対象スキルの照合 | `docs/specifications/bp-run.md` |
| SP-BPRUN-017 | 現在でない run の書き込み | `docs/specifications/bp-run.md` |
| SP-BPRUN-018 | 停止の記録の無い run からの再開 | `docs/specifications/bp-run.md` |
| SP-BPRUN-019 | 起動数の上限の受け取り | `docs/specifications/bp-run.md` |
| SP-BPRUN-040 | 上限を渡されない run と、起動数の上限の数え方 | `docs/specifications/bp-run.md` |
| SP-BPRUN-020 | 上限に収まらない項目 | `docs/specifications/bp-run.md` |
| SP-BPRUN-021 | 最小の起動数 | `docs/specifications/bp-run.md` |
| SP-BPRUN-037 | 不正な上限と、1 件も始められない上限 | `docs/specifications/bp-run.md` |
| SP-BPRUN-022 | 次の run への持ち越し | `docs/specifications/bp-run.md` |
| SP-BPRUN-035 | 残した項目からの再開の手順 | `docs/specifications/bp-run.md` |
| SP-BPRUN-036 | 判定基準の写し | `docs/specifications/bp-run.md` |
| SP-BPRUN-023 | 役ごとのモデルと effort | `docs/specifications/bp-run.md` |
| SP-BPRUN-024 | 生成と別の context での起動 | `docs/specifications/bp-run.md` |
| SP-BPRUN-025 | 役ごとの権限 | `docs/specifications/bp-run.md` |
| SP-BPRUN-026 | 対象を書き換えていないことの照合 | `docs/specifications/bp-run.md` |
| SP-BPRUN-027 | fan-out の外の agent の失敗 | `docs/specifications/bp-run.md` |
| SP-BPRUN-028 | fan-out の項目の工程の欠け | `docs/specifications/bp-run.md` |
| SP-BPRUN-029 | 全件の欠けと CLI の拒否 | `docs/specifications/bp-run.md` |
| SP-BPRUN-030 | BLOCKED の理由 | `docs/specifications/bp-run.md` |
| SP-BPRUN-045 | 文書の一般規約の版を得られないとき | `docs/specifications/bp-run.md` |
| SP-BPRUN-047 | 結果を返さなかった担当の作業記録 | `docs/specifications/bp-run.md` |
| SP-BPRUN-048 | 記録の保存の失敗 | `docs/specifications/bp-run.md` |
| SP-BPRUN-031 | CLI の操作 | `docs/specifications/bp-run.md` |
| SP-BPRUN-032 | run の返り値 | `docs/specifications/bp-run.md` |
| SP-BPRUN-033 | next_args の中身 | `docs/specifications/bp-run.md` |
| SP-BPRUN-034 | 起動数の記録 | `docs/specifications/bp-run.md` |
| SP-ELICITATION-001 | 事前分析の実施 | `docs/specifications/elicitation.md` |
| SP-ELICITATION-002 | 判定の対象とする観点 | `docs/specifications/elicitation.md` |
| SP-ELICITATION-003 | 判定の値の限定 | `docs/specifications/elicitation.md` |
| SP-ELICITATION-004 | 判定の根拠の併記 | `docs/specifications/elicitation.md` |
| SP-ELICITATION-008 | 判定の引き渡し | `docs/specifications/elicitation.md` |
| SP-ELICITATION-009 | 判定できない観点の扱い | `docs/specifications/elicitation.md` |
| SP-ELICITATION-010 | 不明と判定した観点の非確定 | `docs/specifications/elicitation.md` |
| SP-ELICITATION-012 | 分割案の作成 | `docs/specifications/elicitation.md` |
| SP-ELICITATION-013 | 分割単位が扱う関心事の記述 | `docs/specifications/elicitation.md` |
| SP-ELICITATION-014 | 分割単位の名前の重複の禁止 | `docs/specifications/elicitation.md` |
| SP-ELICITATION-015 | 同一の関心事の重複の禁止 | `docs/specifications/elicitation.md` |
| SP-ELICITATION-048 | 分割案の引き渡し | `docs/specifications/elicitation.md` |
| SP-ELICITATION-044 | 判定を実行主体の言語理解に委ねること | `docs/specifications/elicitation.md` |
| SP-ELICITATION-045 | 判定が付かないときに倒してはならない側 | `docs/specifications/elicitation.md` |
| SP-ELICITATION-046 | 判定が付かないときの依頼者への確認 | `docs/specifications/elicitation.md` |
| SP-ELICITATION-017 | 着手を止める事項の問いかけ | `docs/specifications/elicitation.md` |
| SP-ELICITATION-018 | 確定した事項を問わないこと | `docs/specifications/elicitation.md` |
| SP-ELICITATION-020 | 問いと事項の結び付け | `docs/specifications/elicitation.md` |
| SP-ELICITATION-024 | 回答済みの論点の再質問の禁止 | `docs/specifications/elicitation.md` |
| SP-ELICITATION-025 | 論点が変わったときの再質問 | `docs/specifications/elicitation.md` |
| SP-ELICITATION-026 | 保留となった事項の再質問の禁止 | `docs/specifications/elicitation.md` |
| SP-ELICITATION-049 | 入力から値が定まっている事項の確定 | `docs/specifications/elicitation.md` |
| SP-ELICITATION-027 | 値を定める回答の反映 | `docs/specifications/elicitation.md` |
| SP-ELICITATION-043 | 確定した事項の引き渡し | `docs/specifications/elicitation.md` |
| SP-ELICITATION-029 | 決まっていない旨の回答の反映 | `docs/specifications/elicitation.md` |
| SP-ELICITATION-031 | 入力にも回答にも根拠が無い事項を推測で埋めないこと | `docs/specifications/elicitation.md` |
| SP-ELICITATION-040 | 保留であることの記録 | `docs/specifications/elicitation.md` |
| SP-ELICITATION-041 | 保留となった事項の非着手不能扱い | `docs/specifications/elicitation.md` |
| SP-ELICITATION-042 | 保留となった事項の引き渡し | `docs/specifications/elicitation.md` |
| SP-ELICITATION-036 | 着手を止める事項が 1 件も無いとき | `docs/specifications/elicitation.md` |
| SP-ELICITATION-037 | どの論点にも対応づけられない回答を受け取ったとき | `docs/specifications/elicitation.md` |
| SP-ELICITATION-038 | 分割単位の名前が衝突したとき | `docs/specifications/elicitation.md` |
| SP-ELICITATION-039 | 所在を示された文書を読み取れないとき | `docs/specifications/elicitation.md` |
| SP-FLOW-002 | 実行基盤の充足の確認と、満たさないときの非着手 | `docs/specifications/flow.md` |
| SP-FLOW-003 | 実行基盤が要件を満たさないときの提示 | `docs/specifications/flow.md` |
| SP-FLOW-004 | 対象外の依頼の判定 | `docs/specifications/flow.md` |
| SP-FLOW-005 | 対象外と判定したときの非着手 | `docs/specifications/flow.md` |
| SP-FLOW-007 | 作成する文書の種別の決定 | `docs/specifications/flow.md` |
| SP-FLOW-010 | モードの決定 | `docs/specifications/flow.md` |
| SP-FLOW-011 | 根拠として扱う入力の範囲 | `docs/specifications/flow.md` |
| SP-FLOW-012 | 対象リポジトリの実装の非読み取り | `docs/specifications/flow.md` |
| SP-FLOW-013 | 所在を示された既存文書の読み取り | `docs/specifications/flow.md` |
| SP-FLOW-040 | 所在を示されていない文書の非検出 | `docs/specifications/flow.md` |
| SP-FLOW-014 | 確定情報を尋ねる中断点の設置 | `docs/specifications/flow.md` |
| SP-FLOW-015 | 回答を受け取る前に文書の生成へ入らないこと | `docs/specifications/flow.md` |
| SP-FLOW-016 | 着手不能の未確定事項の提示 | `docs/specifications/flow.md` |
| SP-FLOW-017 | 回答済みの論点への再質問の禁止 | `docs/specifications/flow.md` |
| SP-FLOW-018 | 決めないと決めた事項への再質問の禁止 | `docs/specifications/flow.md` |
| SP-FLOW-019 | 提示済みの記録 | `docs/specifications/flow.md` |
| SP-FLOW-020 | 中断点を跨いで引き継ぐ情報 | `docs/specifications/flow.md` |
| SP-FLOW-021 | 未確定事項への区分の付与 | `docs/specifications/flow.md` |
| SP-FLOW-037 | 決まっていない旨の回答を受けた未確定事項の保持規則への変換 | `docs/specifications/flow.md` |
| SP-FLOW-022 | 完成の判定 | `docs/specifications/flow.md` |
| SP-FLOW-024 | 周回の継続と上限 | `docs/specifications/flow.md` |
| SP-FLOW-045 | 上限に達したときの残件の明示と完成 | `docs/specifications/flow.md` |
| SP-FLOW-025 | 保存先のパスの事前提示 | `docs/specifications/flow.md` |
| SP-FLOW-026 | 保存する内容の事前提示 | `docs/specifications/flow.md` |
| SP-FLOW-027 | 承認の意思表示の判定 | `docs/specifications/flow.md` |
| SP-FLOW-028 | 承認を得るまで保存しないこと | `docs/specifications/flow.md` |
| SP-FLOW-041 | 承認しない旨を示されたときの作り直しへの復帰 | `docs/specifications/flow.md` |
| SP-FLOW-042 | 終了の意思を示されたときの終了 | `docs/specifications/flow.md` |
| SP-FLOW-029 | 同名の既存ファイルの検出 | `docs/specifications/flow.md` |
| SP-FLOW-030 | 同名の既存ファイルがあるときの非保存と差分の提示 | `docs/specifications/flow.md` |
| SP-FLOW-031 | 改訂としての上書きの明示 | `docs/specifications/flow.md` |
| SP-FLOW-032 | 中間の生成物を対象リポジトリの外に置くこと | `docs/specifications/flow.md` |
| SP-FLOW-039 | 中間の生成物の置き場 | `docs/specifications/flow.md` |
| SP-FLOW-036 | 提示した内容の書き込み | `docs/specifications/flow.md` |
| SP-FLOW-043 | 書き込みに失敗したときの既書き込みファイルの保持 | `docs/specifications/flow.md` |
| SP-FLOW-044 | 書き込みに失敗したときの到達点の報告 | `docs/specifications/flow.md` |
| SP-FLOW-046 | 応答を待つ時間の上限 | `docs/specifications/flow.md` |
| SP-FLOW-047 | やり直す回数の上限 | `docs/specifications/flow.md` |
| SP-FLOW-033 | 結果を得られないときの実行の終了 | `docs/specifications/flow.md` |
| SP-FLOW-034 | 未完成の文書の非保存 | `docs/specifications/flow.md` |
| SP-FLOW-035 | 中断した段階の提示 | `docs/specifications/flow.md` |
| SP-VERIFICATION-001 | 検査の対象 | `docs/specifications/verification.md` |
| SP-VERIFICATION-042 | 照合元の入力の引き渡し | `docs/specifications/verification.md` |
| SP-VERIFICATION-002 | 検査ごとの独立した実施 | `docs/specifications/verification.md` |
| SP-VERIFICATION-003 | 検査記録の生成 | `docs/specifications/verification.md` |
| SP-VERIFICATION-004 | 未実施と指摘 0 件の区別 | `docs/specifications/verification.md` |
| SP-VERIFICATION-005 | 検査記録の引き渡し | `docs/specifications/verification.md` |
| SP-VERIFICATION-006 | 指摘に含める情報 | `docs/specifications/verification.md` |
| SP-VERIFICATION-043 | 判定できなかったときに同一とみなさないこと | `docs/specifications/verification.md` |
| SP-VERIFICATION-045 | 判定できなかったときの依頼者への確認 | `docs/specifications/verification.md` |
| SP-VERIFICATION-007 | 実行可能性の判定の実施 | `docs/specifications/verification.md` |
| SP-VERIFICATION-009 | 着手できない箇所の起票の指摘 | `docs/specifications/verification.md` |
| SP-VERIFICATION-010 | 起票済みの論点と決めないと決めた事項を指摘しない | `docs/specifications/verification.md` |
| SP-VERIFICATION-011 | 文書外の知識に依存した記述の検出 | `docs/specifications/verification.md` |
| SP-VERIFICATION-012 | 未決の選択肢の検出 | `docs/specifications/verification.md` |
| SP-VERIFICATION-013 | 測定できない語の検出 | `docs/specifications/verification.md` |
| SP-VERIFICATION-014 | 語尾の検査 | `docs/specifications/verification.md` |
| SP-VERIFICATION-015 | 複合要求の検出 | `docs/specifications/verification.md` |
| SP-VERIFICATION-016 | 根拠の併記の検査 | `docs/specifications/verification.md` |
| SP-VERIFICATION-017 | 識別子の重複の検出 | `docs/specifications/verification.md` |
| SP-VERIFICATION-018 | 実現する仕様項目が無い要求の検出 | `docs/specifications/verification.md` |
| SP-VERIFICATION-019 | 根拠となる要求が無い仕様項目の検出 | `docs/specifications/verification.md` |
| SP-VERIFICATION-020 | 検証方法が無い要求の検出 | `docs/specifications/verification.md` |
| SP-VERIFICATION-021 | 表が参照する識別子が実在しないことの検出 | `docs/specifications/verification.md` |
| SP-VERIFICATION-022 | 本文が参照する識別子が実在しないことの検出 | `docs/specifications/verification.md` |
| SP-VERIFICATION-023 | 照合の相手を欠くときの申告 | `docs/specifications/verification.md` |
| SP-VERIFICATION-024 | 相反する記述の検出 | `docs/specifications/verification.md` |
| SP-VERIFICATION-025 | 用語の揺れの検出 | `docs/specifications/verification.md` |
| SP-VERIFICATION-026 | 二重に置かれた記述の検出 | `docs/specifications/verification.md` |
| SP-VERIFICATION-027 | 未定義の組み合わせの検出 | `docs/specifications/verification.md` |
| SP-VERIFICATION-028 | 入力に根拠が無い断定の検出 | `docs/specifications/verification.md` |
| SP-VERIFICATION-029 | 未回答の事項を埋めた記述の検出 | `docs/specifications/verification.md` |
| SP-VERIFICATION-031 | 直し方が示す文書の改稿 | `docs/specifications/verification.md` |
| SP-VERIFICATION-032 | 直し方が示す箇所以外の維持 | `docs/specifications/verification.md` |
| SP-VERIFICATION-033 | 上限に達していない間の改稿後の再検査 | `docs/specifications/verification.md` |
| SP-VERIFICATION-034 | 反復の上限に達したときの終了 | `docs/specifications/verification.md` |
| SP-VERIFICATION-035 | 上限に達したときの申告 | `docs/specifications/verification.md` |
| SP-VERIFICATION-036 | 反復の終了 | `docs/specifications/verification.md` |
| SP-VERIFICATION-037 | 創作による解消の禁止 | `docs/specifications/verification.md` |
| SP-VERIFICATION-038 | 検査対象が 0 件のとき | `docs/specifications/verification.md` |
| SP-VERIFICATION-039 | 検査結果が定めた形式に合わないとき | `docs/specifications/verification.md` |
| SP-VERIFICATION-044 | やり直しても形式に合わないとき | `docs/specifications/verification.md` |
| SP-VERIFICATION-041 | 検査を 1 件も実施できなかったときの終了 | `docs/specifications/verification.md` |
| SP-DEVELOPADDRESSREVIEW-001 | 入口における指摘受領 |  |
| SP-DEVELOPADDRESSREVIEW-002 | PR 存在時の目標設定 |  |
| SP-DEVELOPADDRESSREVIEW-003 | PR 非存在時のローカル目標 |  |
| SP-DEVELOPADDRESSREVIEW-004 | PR 非存在時の作業ツリー整合 |  |
| SP-DEVELOPADDRESSREVIEW-005 | ブランチ指定時の方針版導出 |  |
| SP-DEVELOPADDRESSREVIEW-006 | リモート未存在ブランチのエラー処理 |  |
| SP-DEVELOPADDRESSREVIEW-007 | 外部レビュー結果のスキーマ検証 |  |
| SP-DEVELOPADDRESSREVIEW-008 | 外部指摘 ID の一意性 |  |
| SP-DEVELOPADDRESSREVIEW-009 | 指摘本文の改竄禁止 |  |
| SP-DEVELOPADDRESSREVIEW-010 | 事前 push 権限確認 |  |
| SP-DEVELOPADDRESSREVIEW-011 | push 不可時の早期停止 |  |
| SP-DEVELOPADDRESSREVIEW-012 | 指摘以降のコミット一覧取得 |  |
| SP-DEVELOPADDRESSREVIEW-013 | 分類ロールの二段実行 |  |
| SP-DEVELOPADDRESSREVIEW-014 | 分類不一致時の安全エスカレーション |  |
| SP-DEVELOPADDRESSREVIEW-015 | 分類実行時の作業ツリー不変性 |  |
| SP-DEVELOPADDRESSREVIEW-016 | 既修正（already_fixed）の判定 |  |
| SP-DEVELOPADDRESSREVIEW-017 | 修正コミットの照合 |  |
| SP-DEVELOPADDRESSREVIEW-018 | 既修正指摘の除外 |  |
| SP-DEVELOPADDRESSREVIEW-019 | 人間判断要（discuss / question）の抽出 |  |
| SP-DEVELOPADDRESSREVIEW-020 | 同一状態での二重分類抑止 |  |
| SP-DEVELOPADDRESSREVIEW-021 | 停止位置オプション（--stop-at） |  |
| SP-DEVELOPADDRESSREVIEW-022 | develop:implement への修正委託 |  |
| SP-DEVELOPADDRESSREVIEW-023 | 修正対象 0 件時のスキップ |  |
| SP-DEVELOPADDRESSREVIEW-024 | develop:implement 停止時の連動停止 |  |
| SP-DEVELOPADDRESSREVIEW-025 | リモートへの Push 実行 |  |
| SP-DEVELOPADDRESSREVIEW-026 | PR 非存在時の CI/返信スキップ |  |
| SP-DEVELOPADDRESSREVIEW-027 | 監視対象 SHA の固定 |  |
| SP-DEVELOPADDRESSREVIEW-028 | push 済み SHA と PR head の一致検証 |  |
| SP-DEVELOPADDRESSREVIEW-029 | required checks 監視ループ |  |
| SP-DEVELOPADDRESSREVIEW-030 | CI 失敗時の不介入規約 |  |
| SP-DEVELOPADDRESSREVIEW-031 | 監視タイムアウト時の再開 |  |
| SP-DEVELOPADDRESSREVIEW-032 | 再開時 head ドリフト検知 |  |
| SP-DEVELOPADDRESSREVIEW-033 | 待ち再開の上限回数 |  |
| SP-DEVELOPADDRESSREVIEW-034 | 待ち再開カウンタの記録 |  |
| SP-DEVELOPADDRESSREVIEW-035 | 返信直前の PR 状態再照合 |  |
| SP-DEVELOPADDRESSREVIEW-036 | 外部プッシュ検知時の返信中止 |  |
| SP-DEVELOPADDRESSREVIEW-037 | メンション付き個別返信 |  |
| SP-DEVELOPADDRESSREVIEW-038 | 既修正指摘への返信フォーマット |  |
| SP-DEVELOPADDRESSREVIEW-039 | 返信内容の事前検証 |  |
| SP-DEVELOPADDRESSREVIEW-040 | 不正返信文の送信抑止 |  |
| SP-DEVELOPADDRESSREVIEW-041 | Resolve 候補の条件 |  |
| SP-DEVELOPADDRESSREVIEW-042 | 分類別 Resolve 判定表 |  |
| SP-DEVELOPADDRESSREVIEW-043 | Resolve 前の GraphQL 照合 |  |
| SP-DEVELOPADDRESSREVIEW-044 | 不整合 thread の resolve 抑止 |  |
| SP-DEVELOPADDRESSREVIEW-045 | 全 Resolve 候補の網羅性検査 |  |
| SP-DEVELOPADDRESSREVIEW-046 | 最終完了結果の返却 |  |
| SP-DEVELOPADDRESSREVIEW-047 | 修正不要かつ push 不可時のハンドリング |  |
| SP-DEVELOPADDRESSREVIEW-048 | 人間裁定値の注入 |  |
| SP-DEVELOPADDRESSREVIEW-049 | コミットの委託 |  |
| SP-DEVELOPADDRESSREVIEW-050 | thread 更新検知時の返信中止 |  |
| SP-DEVELOPADDRESSREVIEW-051 | 返信中止指摘の明記 |  |
| SP-DEVELOPADDRESSREVIEW-052 | Push 拒絶時の安全停止 |  |
| SP-DEVELOPADDRESSREVIEW-053 | 解消コミット特定不能時の差し戻し |  |
| SP-DEVELOPADDRESSREVIEW-054 | 未コミット時の push 中止 |  |
| SP-DEVELOPADDRESSREVIEW-055 | implement 段からの再開 |  |
| SP-DEVELOPADDRESSREVIEW-056 | 指定停止段の操作抑止 |  |
| SP-DEVELOPADDRESSREVIEW-057 | push 抑止時のコミット保全 |  |
| SP-DEVELOPADDRESSREVIEW-058 | 停止状態名の統一 |  |
| SP-DEVELOPADDRESSREVIEW-059 | 停止からの再開決定表 |  |
| SP-DEVELOPADDRESSREVIEW-060 | 全体完了の成立条件 |  |
| SP-DEVELOPADDRESSREVIEW-061 | 人間判断の許容語彙 |  |
| SP-DEVELOPADDRESSREVIEW-062 | 裁定済み指摘の再審査抑止 |  |
| SP-DEVELOPADDRESSREVIEW-063 | 常時不変条件（Invariants） |  |
| SP-DEVELOPADDRESSREVIEW-064 | fix 裁定時の対象パス明記 |  |
| SP-DEVELOPADDRESSREVIEW-065 | 停止中の追加指示処理 |  |
| SP-DEVELOPADDRESSREVIEW-066 | 子スキル停止情報の完全伝達 |  |
| SP-DEVELOPADDRESSREVIEW-067 | トリアージ構造の保持と引き渡し |  |
| SP-DEVELOPADDRESSREVIEW-068 | 子スキル停止情報の継承 |  |
| SP-DEVELOPIMPLEMENT-001 | 目標の不変固定 |  |
| SP-DEVELOPIMPLEMENT-002 | 人間回答の履歴追記 |  |
| SP-DEVELOPIMPLEMENT-003 | 方針版の照合 |  |
| SP-DEVELOPIMPLEMENT-004 | 照合先ブランチの導出 |  |
| SP-DEVELOPIMPLEMENT-005 | SHA-1/SHA-256 検証 |  |
| SP-DEVELOPIMPLEMENT-006 | 計画実行の二重化 |  |
| SP-DEVELOPIMPLEMENT-007 | 計画審査不合格時の差し戻し |  |
| SP-DEVELOPIMPLEMENT-008 | 人間判断要求時の安全停止 |  |
| SP-DEVELOPIMPLEMENT-009 | 計画段階での作業ツリー不変性 |  |
| SP-DEVELOPIMPLEMENT-010 | Check 設定未宣言時の停止 |  |
| SP-DEVELOPIMPLEMENT-011 | Check コマンド推測の禁止 |  |
| SP-DEVELOPIMPLEMENT-012 | 計画確認用停止オプション |  |
| SP-DEVELOPIMPLEMENT-013 | 計画停止からの再開手順 |  |
| SP-DEVELOPIMPLEMENT-014 | 作業ツリー予期せぬ変更の検知 |  |
| SP-DEVELOPIMPLEMENT-015 | 差分検知時の上書き禁止 |  |
| SP-DEVELOPIMPLEMENT-016 | 実装前ベースライン check |  |
| SP-DEVELOPIMPLEMENT-017 | 未定義 check の実行禁止 |  |
| SP-DEVELOPIMPLEMENT-018 | 実装役（Implementer）の単独書き込み権 |  |
| SP-DEVELOPIMPLEMENT-019 | 変更後 check 必須合格 |  |
| SP-DEVELOPIMPLEMENT-020 | テストケース設計基準 |  |
| SP-DEVELOPIMPLEMENT-021 | 修正上限到達時の停止 |  |
| SP-DEVELOPIMPLEMENT-022 | 上限到達時の作業ツリー保全 |  |
| SP-DEVELOPIMPLEMENT-023 | develop:review スキル呼び出し |  |
| SP-DEVELOPIMPLEMENT-024 | review 上限停止の伝播 |  |
| SP-DEVELOPIMPLEMENT-025 | レビュー結果の構造化記録 |  |
| SP-DEVELOPIMPLEMENT-026 | 返却値スキーマの機械照合 |  |
| SP-DEVELOPIMPLEMENT-027 | 確定指摘のみの修正対象化 |  |
| SP-DEVELOPIMPLEMENT-028 | 未検証指摘の人間エスカレーション |  |
| SP-DEVELOPIMPLEMENT-029 | レビュー合否判定の進行分岐 |  |
| SP-DEVELOPIMPLEMENT-030 | 未レビュー範囲の透明性報告 |  |
| SP-DEVELOPIMPLEMENT-031 | 最終照合不合格時のコミット阻止 |  |
| SP-DEVELOPIMPLEMENT-032 | 最終照合不合格時の変更保全 |  |
| SP-DEVELOPIMPLEMENT-033 | コミットの実行規約 |  |
| SP-DEVELOPIMPLEMENT-034 | プッシュの実行規約 |  |
| SP-DEVELOPIMPLEMENT-035 | 最終成功結果の返却 |  |
| SP-DEVELOPIMPLEMENT-036 | 依頼文の完全保存 |  |
| SP-DEVELOPIMPLEMENT-037 | 目標への付加禁止 |  |
| SP-DEVELOPIMPLEMENT-038 | 依頼文と目標の改竄防止 |  |
| SP-DEVELOPIMPLEMENT-039 | 停止中のヒント受付口 |  |
| SP-DEVELOPIMPLEMENT-040 | ヒントの取り込み |  |
| SP-DEVELOPIMPLEMENT-041 | ヒント入力ガイダンス提示 |  |
| SP-DEVELOPIMPLEMENT-042 | 不正状態でのヒント拒否 |  |
| SP-DEVELOPIMPLEMENT-043 | 計画外変更の拒否 |  |
| SP-DEVELOPIMPLEMENT-044 | 修正不要時の安全早期終了 |  |
| SP-DEVELOPIMPLEMENT-045 | review failed 時の修正キューイング |  |
| SP-DEVELOPIMPLEMENT-046 | 設計破綻時の断念 (abandon) |  |
| SP-DEVELOPIMPLEMENT-047 | abandon 停止時の詳細報告 |  |
| SP-DEVELOPIMPLEMENT-048 | abandon 時のコミット・プッシュ絶対禁止 |  |
| SP-DEVELOPIMPLEMENT-049 | address-review からの修正受託時 |  |
| SP-DEVELOPIMPLEMENT-050 | プッシュ拒絶時の安全停止 |  |
| SP-DEVELOPIMPLEMENT-051 | PR 修正時の push 抑止 |  |
| SP-DEVELOPIMPLEMENT-052 | 記録回答のコンテキスト注入 |  |
| SP-DEVELOPIMPLEMENT-053 | 未存在ブランチのエラー停止 |  |
| SP-DEVELOPIMPLEMENT-054 | 不正テスト基準の拒絶 |  |
| SP-DEVELOPIMPLEMENT-055 | 手動修正後の再開 |  |
| SP-DEVELOPIMPLEMENT-056 | 不正形式の即時拒否 |  |
| SP-DEVELOPIMPLEMENT-057 | 最終照合の実行 |  |
| SP-DEVELOPIMPLEMENT-058 | 実装破棄とクリーンロールバック |  |
| SP-DEVELOPIMPLEMENT-059 | 修正後 check の差分比較 |  |
| SP-DEVELOPIMPLEMENT-060 | 修正回数上限カウンタ |  |
| SP-DEVELOPIMPLEMENT-061 | 変更不要時の結果明記 |  |
| SP-DEVELOPIMPLEMENT-062 | abandon 時の人間裁定 |  |
| SP-DEVELOPIMPLEMENT-063 | 指摘数の正確な計量 |  |
| SP-DEVELOPIMPLEMENT-064 | 同一指摘のループ防止 |  |
| SP-DEVELOPIMPLEMENT-065 | ヒント反映後のベースライン再測定 |  |
| SP-DEVELOPIMPLEMENT-066 | ヒント反映計画の承認ゲート |  |
| SP-DEVELOPIMPLEMENT-067 | ベースライン結果欠如時の測定強制 |  |
| SP-DEVELOPIMPLEMENT-068 | 停止状態の標準分類 |  |
| SP-DEVELOPIMPLEMENT-069 | 再開マッピング決定表 |  |
| SP-DEVELOPIMPLEMENT-070 | 完了の厳格定義 |  |
| SP-DEVELOPIMPLEMENT-071 | 完了前の未読ヒント検査 |  |
| SP-DEVELOPIMPLEMENT-072 | 上限到達からの計画改訂再開 |  |
| SP-DEVELOPIMPLEMENT-073 | 虚偽の変更不要報告の検出 |  |
| SP-DEVELOPIMPLEMENT-074 | 修正対象件数のゼロ判定 |  |
| SP-DEVELOPIMPLEMENT-075 | 呼び直しデッドロック防止 |  |
| SP-DEVELOPIMPLEMENT-076 | 停止中の不正追加入力拒絶 |  |
| SP-DEVELOPIMPLEMENT-077 | 状態欠如レスポンスのエラー処理 |  |
| SP-DEVELOPIMPLEMENT-078 | 実装後停止からの新規起動 |  |
| SP-DEVELOPIMPLEMENT-079 | 規範文書洗い出し段 |  |
| SP-DEVELOPIMPLEMENT-080 | 条件別ケース計画 |  |
| SP-DEVELOPIMPLEMENT-081 | 作業ファイルの分離と独立性 |  |
| SP-DEVELOPIMPLEMENT-082 | 同一 run 内再開の票引き渡し |  |
| SP-DEVELOPIMPLEMENT-083 | 範囲外指摘の根本原因探索 |  |
| SP-DEVELOPIMPLEMENT-084 | 範囲拡大の人為的承認ゲート |  |
| SP-DEVELOPIMPLEMENT-085 | 環境・前提障害の即時停止 |  |
| SP-DEVELOPPLUGIN-001 | 呼び出し名規約 |  |
| SP-DEVELOPPLUGIN-002 | 3スキルの版の一致 |  |
| SP-DEVELOPPLUGIN-003 | 呼び出しの向き |  |
| SP-DEVELOPPLUGIN-004 | 実行環境欠如時の安全停止 |  |
| SP-DEVELOPPLUGIN-005 | Codex runner 実行アダプタ |  |
| SP-DEVELOPPLUGIN-006 | 段の選択決定権 |  |
| SP-DEVELOPPLUGIN-007 | 司令塔の成果物不介入 |  |
| SP-DEVELOPPLUGIN-008 | 固有値の外部化 |  |
| SP-DEVELOPPLUGIN-009 | 再設計アーキテクチャの適用 |  |
| SP-DEVELOPPLUGIN-010 | 機能境界の限定 |  |
| SP-DEVELOPPLUGIN-011 | 宣言の形式検証 |  |
| SP-DEVELOPPLUGIN-012 | PR 対象時の方針コミット解決 |  |
| SP-DEVELOPPLUGIN-013 | 作業ツリー対象時の方針コミット解決 |  |
| SP-DEVELOPPLUGIN-014 | 方針コミット未解決時の停止 |  |
| SP-DEVELOPPLUGIN-015 | 版からの分離抽出 |  |
| SP-DEVELOPPLUGIN-017 | 人間向け出力の言語 |  |
| SP-DEVELOPPLUGIN-018 | 言語の既定値 |  |
| SP-DEVELOPPLUGIN-019 | 言語非依存の境界 |  |
| SP-DEVELOPPLUGIN-020 | 言語決定の優先順位 |  |
| SP-DEVELOPPLUGIN-021 | Codex runner における書き込み制限 |  |
| SP-DEVELOPPLUGIN-022 | 読み取り専用ステップの隔離 |  |
| SP-DEVELOPPLUGIN-023 | 状態書き込みのアトミック性 |  |
| SP-DEVELOPPLUGIN-024 | 意図せぬ書き込みの事後検知 |  |
| SP-DEVELOPPLUGIN-025 | ツール制限と事後検査の二重防御 |  |
| SP-DEVELOPPLUGIN-026 | 不正書き込み検知時の即時停止・ロールバック |  |
| SP-DEVELOPPLUGIN-027 | 変化の報告形式 |  |
| SP-DEVELOPPLUGIN-028 | 残留リスクの明示 |  |
| SP-DEVELOPPLUGIN-029 | 事前権限チェック |  |
| SP-DEVELOPPLUGIN-030 | 前提の安全配達 |  |
| SP-DEVELOPPLUGIN-031 | 欠落前提の自己申告 |  |
| SP-DEVELOPPLUGIN-032 | 停止時の返却構造体 |  |
| SP-DEVELOPPLUGIN-033 | 外部ツール障害のハンドリング |  |
| SP-DEVELOPPLUGIN-034 | 失敗状態の記録 |  |
| SP-DEVELOPPLUGIN-035 | 再開トークンと状態照合 |  |
| SP-DEVELOPPLUGIN-036 | 多重起動（Relaunch）の禁止 |  |
| SP-DEVELOPPLUGIN-037 | 対話型入力待ちの禁止 |  |
| SP-DEVELOPPLUGIN-038 | 人間判断待ち停止 |  |
| SP-DEVELOPPLUGIN-039 | 遅延書き込みの排斥 |  |
| SP-DEVELOPPLUGIN-040 | サブエージェント失敗の捕捉 |  |
| SP-DEVELOPPLUGIN-041 | セッション跨ぎの永続化 |  |
| SP-DEVELOPPLUGIN-042 | 転記ミスの自動検知 |  |
| SP-DEVELOPPLUGIN-043 | トークン予算の注入 |  |
| SP-DEVELOPPLUGIN-044 | 既定のトークン予算 |  |
| SP-DEVELOPPLUGIN-045 | 予算枯渇時の安全縮退 |  |
| SP-DEVELOPPLUGIN-046 | 実行メトリクス記録 |  |
| SP-DEVELOPPLUGIN-047 | 形式判定のログ化 |  |
| SP-DEVELOPPLUGIN-048 | 全検証合格後の外部反映 |  |
| SP-DEVELOPPLUGIN-049 | 外部副作用の不可逆性警告 |  |
| SP-DEVELOPPLUGIN-050 | 設定先行配備規約 |  |
| SP-DEVELOPPLUGIN-051 | 既存 CI/CD 非破壊性 |  |
| SP-DEVELOPPLUGIN-052 | CLI オプションの後方互換 |  |
| SP-DEVELOPPLUGIN-053 | マーケットプレイス登録整合 |  |
| SP-DEVELOPPLUGIN-054 | best-practices review 合格保証 |  |
| SP-DEVELOPPLUGIN-055 | 形式検証モデルとの照合 |  |
| SP-DEVELOPPLUGIN-056 | 成果物の全数静的検査 |  |
| SP-DEVELOPPLUGIN-057 | 実環境スモーク試走 |  |
| SP-DEVELOPPLUGIN-058 | スキル説明文の汎用性 |  |
| SP-DEVELOPPLUGIN-059 | 発火トリガーの正確性 |  |
| SP-DEVELOPPLUGIN-060 | 旧ワークフロースキルの廃止 |  |
| SP-DEVELOPPLUGIN-061 | 廃止と削除の段階分離 |  |
| SP-DEVELOPPLUGIN-062 | dcf contextual-code-review の代替 |  |
| SP-DEVELOPPLUGIN-063 | 外部リポジトリへの提供保証 |  |
| SP-DEVELOPPLUGIN-064 | 撤去順序の規律 |  |
| SP-DEVELOPPLUGIN-065 | 機能等価性の維持 |  |
| SP-DEVELOPPLUGIN-066 | 廃止による非互換の文書化 |  |
| SP-DEVELOPPLUGIN-067 | 旧名エイリアスの過渡的保持 |  |
| SP-DEVELOPPLUGIN-068 | 利用者向け移行ガイダンス |  |
| SP-DEVELOPPLUGIN-069 | pk/dcf 移行完了検証 |  |
| SP-DEVELOPPLUGIN-070 | ドメイン固有観点の外挿 |  |
| SP-DEVELOPPLUGIN-071 | モデル選択の根拠 |  |
| SP-DEVELOPPLUGIN-072 | 外部リポジトリ固有機能の分離 |  |
| SP-DEVELOPPLUGIN-073 | 仕様トレーサビリティ全数照合 |  |
| SP-DEVELOPPLUGIN-074 | 履歴書き換え push の禁止 |  |
| SP-DEVELOPPLUGIN-075 | 外部入力の原典記録 |  |
| SP-DEVELOPPLUGIN-076 | 証拠に基づく判定 |  |
| SP-DEVELOPPLUGIN-077 | 停止理由の証拠性 |  |
| SP-DEVELOPPLUGIN-078 | 停滞検知とエスカレーション |  |
| SP-DEVELOPPLUGIN-079 | 自己書き換えの禁止 |  |
| SP-DEVELOPPLUGIN-080 | 外部指定コミットの優先解決 |  |
| SP-DEVELOPPLUGIN-081 | 移行期間の縮退運転 |  |
| SP-DEVELOPPLUGIN-082 | 完了判定基準 |  |
| SP-DEVELOPPLUGIN-083 | 回帰評価 (evals) |  |
| SP-DEVELOPPLUGIN-084 | 廃止スキルの安全撤去 |  |
| SP-DEVELOPPLUGIN-085 | モデル指定のオーバーライド |  |
| SP-DEVELOPPLUGIN-086 | 変更種類による分類マトリクス |  |
| SP-DEVELOPPLUGIN-087 | 参照渡しとチェックサム検証 |  |
| SP-DEVELOPPLUGIN-088 | 状態世代と遅延書き込み排斥 |  |
| SP-DEVELOPREVIEW-001 | 目標の不変固定 |  |
| SP-DEVELOPREVIEW-002 | 非チェックアウトPRの安全取得 |  |
| SP-DEVELOPREVIEW-003 | pin 値（固定ハッシュ）の照合 |  |
| SP-DEVELOPREVIEW-004 | 観点の閉集合原則 |  |
| SP-DEVELOPREVIEW-005 | 方針文書未存在時の既定観点 |  |
| SP-DEVELOPREVIEW-006 | 必須適用観点（Mandatory Viewpoints） |  |
| SP-DEVELOPREVIEW-007 | 必須観点の出所明記 |  |
| SP-DEVELOPREVIEW-008 | 方針文書欠落時の必須観点 |  |
| SP-DEVELOPREVIEW-009 | 方針文書に基づく観点の動的導出 |  |
| SP-DEVELOPREVIEW-010 | 計画審査による不正観点の排除 |  |
| SP-DEVELOPREVIEW-011 | スキルファイル固有の観点割り当て |  |
| SP-DEVELOPREVIEW-012 | スキル観点における規則参照 |  |
| SP-DEVELOPREVIEW-013 | 「読むもの」参照の完全解決 |  |
| SP-DEVELOPREVIEW-014 | 方針文書未配置の報告 |  |
| SP-DEVELOPREVIEW-015 | 構文不正方針文書の処理 |  |
| SP-DEVELOPREVIEW-016 | ファイル種別の 4 分類 |  |
| SP-DEVELOPREVIEW-017 | spec/prd 宣言未存在時の判定 |  |
| SP-DEVELOPREVIEW-018 | 指摘重大度の語彙統一 |  |
| SP-DEVELOPREVIEW-019 | Focus 作成役の責務 |  |
| SP-DEVELOPREVIEW-020 | Focus の完全引用規約 |  |
| SP-DEVELOPREVIEW-021 | Focus 作成時の対象コード不変性 |  |
| SP-DEVELOPREVIEW-022 | 不整合 Focus の棄却 |  |
| SP-DEVELOPREVIEW-023 | Focus の省略禁止 |  |
| SP-DEVELOPREVIEW-024 | 二段検証による指摘の確定 |  |
| SP-DEVELOPREVIEW-025 | 確定に必要な検証票 |  |
| SP-DEVELOPREVIEW-026 | レビュー資産台帳 |  |
| SP-DEVELOPREVIEW-027 | 閲覧履歴の記録 |  |
| SP-DEVELOPREVIEW-028 | 未読資産の追加レビュー起動 |  |
| SP-DEVELOPREVIEW-029 | 追加起動の上限回数 |  |
| SP-DEVELOPREVIEW-030 | レビュー結果ステータス |  |
| SP-DEVELOPREVIEW-031 | 棄却指摘の記録 |  |
| SP-DEVELOPREVIEW-032 | 確定指摘の返却 |  |
| SP-DEVELOPREVIEW-033 | 未審査範囲の申告 |  |
| SP-DEVELOPREVIEW-034 | 意図せぬ書き込み検知時の停止 |  |
| SP-DEVELOPREVIEW-035 | 起動数上限の受領 |  |
| SP-DEVELOPREVIEW-036 | 上限未指定時の安全既定値 |  |
| SP-DEVELOPREVIEW-037 | 枠の事前予約 |  |
| SP-DEVELOPREVIEW-038 | 起動数の厳密計測 |  |
| SP-DEVELOPREVIEW-039 | 枠超過項目の未着手登録 |  |
| SP-DEVELOPREVIEW-040 | 未着手項目の優先順位付け |  |
| SP-DEVELOPREVIEW-041 | 停止時の中間結果永続化 |  |
| SP-DEVELOPREVIEW-042 | 再開時の未着手キュー消化 |  |
| SP-DEVELOPREVIEW-043 | 再開前 pin 不変照合 |  |
| SP-DEVELOPREVIEW-044 | 再開セッションの権限継承 |  |
| SP-DEVELOPREVIEW-045 | 並行エージェント数制御 |  |
| SP-DEVELOPREVIEW-046 | 同種指摘の統合 |  |
| SP-DEVELOPREVIEW-047 | 投稿条件の充足 |  |
| SP-DEVELOPREVIEW-048 | 呼び出し元存在時の投稿抑止 |  |
| SP-DEVELOPREVIEW-049 | 行不解決指摘のサマリ投稿 |  |
| SP-DEVELOPREVIEW-050 | 投稿前内容確認 |  |
| SP-DEVELOPREVIEW-051 | 投稿内容の不一致防止 |  |
| SP-DEVELOPREVIEW-052 | gh CLI 欠如時のフォールバック |  |
| SP-DEVELOPREVIEW-053 | Git 外対象の入力検証 |  |
| SP-DEVELOPREVIEW-054 | 貼り付けテキストの隔離保存 |  |
| SP-DEVELOPREVIEW-055 | Git 外対象の目標設定 |  |
| SP-DEVELOPREVIEW-056 | Git 外対象の観点限定 |  |
| SP-DEVELOPREVIEW-057 | Git 外対象の台帳管理 |  |
| SP-DEVELOPREVIEW-058 | Git 外対象の範囲外明記 |  |
| SP-DEVELOPREVIEW-059 | 除外宣言未存在時のデフォルト除外 |  |
| SP-DEVELOPREVIEW-060 | 自動生成物の除外 |  |
| SP-DEVELOPREVIEW-061 | 基点ディレクトリ未宣言時のルート適用 |  |
| SP-DEVELOPREVIEW-062 | 未解決参照の透明性記録 |  |
| SP-DEVELOPREVIEW-063 | 参照先文書読取不能時の扱い |  |
| SP-DEVELOPREVIEW-064 | 読取不能文書の構造化申告 |  |
| SP-DEVELOPREVIEW-065 | 方針文書未存在時の Focus 生成 |  |
| SP-DEVELOPREVIEW-066 | 上限到達時の返却構造体 |  |
| SP-DEVELOPREVIEW-067 | 投稿失敗時の安全終了 |  |
| SP-DEVELOPREVIEW-068 | 未定義ファイル種別のフォールバック観点 |  |
| SP-DEVELOPREVIEW-069 | 未検証指摘の分離返却 |  |
| SP-DEVELOPREVIEW-070 | 枠不足時の項目分割 |  |
| SP-DEVELOPREVIEW-071 | Codex runner 起動数上限 |  |
| SP-DEVELOPREVIEW-072 | 停止状態の命名 |  |
| SP-DEVELOPREVIEW-073 | 停止状態からの再開遷移 |  |
| SP-DEVELOPREVIEW-074 | レビュー完了条件 |  |
| SP-DEVELOPREVIEW-075 | 同一 pin での二重投稿防止 |  |
| SP-DEVELOPREVIEW-076 | pin 変更後の旧指摘無効化 |  |
| SP-DEVELOPREVIEW-077 | 停止中外部変更の遮断 |  |
| SP-DEVELOPREVIEW-078 | 洗い出し束の効率的配分 |  |
| SP-DEVELOPREVIEW-079 | 運搬役の軽量化と path/sum 照合 |  |
| SP-DEVELOPREVIEW-080 | 前段指摘構造の厳格継承 |  |

## 検査結果

- ID の重複: 0 件
