# docs/specifications 目次

この INDEX は自動生成される導出物である。本体を直したら再生成すること（手書きしない）。

## 文書一覧

| パス | 扱う関心事 | どういう仕様項目が書かれているか |
|---|---|---|
| `docs/specifications/flow.md` | 実行全体の制御（モード・周回・完成判定・保存） | 実行のモード決定・中断点の順序制約・未確定事項の区分と周回・完成判定・保存の承認と書き込み・実行基盤の制約と中断時の振る舞いを、外から観測できる振る舞いとして定める仕様書。状態遷移図と状態 × イベント表で全体の制御の網羅を示す。 |
| `docs/specifications/elicitation.md` | 未確定事項の抽出と問いの生成 | 依頼文などの入力から確定・未確定・保留の事項を区分し、着手を止める論点についてのみ問いを作る条件と、回答・無回答・論点の変化を受けたときの区分の付け替えを定める仕様書。 |
| `docs/specifications/authoring.md` | 生成文書そのものの記述規律 | 生成される要求文書・仕様書そのものの記述仕様（分量・章構成・要求文と仕様項目の書き方・ID 体系・トレーサビリティ表・未確定事項の書式・ファイル配置と INDEX・状態とイベントの記述・外部規格への言及）を定める仕様書。 |
| `docs/specifications/verification.md` | 生成文書の検査と改稿の反復 | 生成された文書一式に対する検査の観点と実施単位、指摘を受けた改稿、検査と改稿の反復の上限（2 往復）、検査記録の保持と引き渡し、未実施の検査を指摘 0 件と区別して扱う規律を定める仕様書。 |
| `docs/specifications/bp-authoring.md` | 仕様書: create と update の流れ | 対象スキルと run の入力／段の並び／目標の固定／書く／検証／合否／停止／エラー処理と異常系／外部インタフェース（SP-BPAUTHORING-001〜041／41 件） |
| `docs/specifications/bp-conformance.md` | 仕様書: 対象スキルが備える性質の判定基準と、対象スキルに課す確定値 | 判定の当て方／形の判定／資産台帳／形に関わる原則／配布先での確認／fan-out の起動数の上限／性能・容量（対象スキルに課す確定値）／エラー処理と異常系（SP-BPCONFORMANCE-001〜038／38 件） |
| `docs/specifications/bp-entry.md` | 仕様書: 依頼の振り分け・機能の連鎖・Workflow callsite | 振り分け／連鎖／Workflow callsite／エラー処理と異常系／外部インタフェース（SP-BPENTRY-001〜025／25 件） |
| `docs/specifications/bp-findings.md` | 仕様書: 指摘と資産台帳 | 台帳と資産／結果の結び付き／反証／指摘の状態／カバレッジと skip 一覧／run をまたぐ指摘の扱い／指摘の形／エラー処理と異常系（SP-BPFINDINGS-001〜037／37 件） |
| `docs/specifications/bp-inspection.md` | 仕様書: review と audit の観点と流れ | 形と段／観点／フローの観点／監査の観点／担当と起動／対象を書き換えない／対象スキル／外部インタフェース／エラー処理と異常系（SP-BPINSPECTION-001〜030／30 件） |
| `docs/specifications/bp-run.md` | 仕様書: best-practices の実行基盤 | run の境界／状態と作業場所／停止／再開／起動数の上限／判定基準の写し／モデル・effort・権限／エラー処理と異常系／外部インタフェース／性能・容量（SP-BPRUN-001〜040／40 件） |

## 仕様項目一覧

| ID | 見出し | 所在文書 |
|---|---|---|
| SP-FLOW-002 | 実行基盤の充足の確認と、満たさないときの非着手 | `docs/specifications/flow.md` |
| SP-FLOW-003 | 実行基盤が要件を満たさないときの提示 | `docs/specifications/flow.md` |
| SP-FLOW-004 | 対象外の依頼の判定 | `docs/specifications/flow.md` |
| SP-FLOW-005 | 対象外と判定したときの非着手 | `docs/specifications/flow.md` |
| SP-FLOW-007 | 作成する文書の種別の決定 | `docs/specifications/flow.md` |
| SP-FLOW-010 | モードの決定 | `docs/specifications/flow.md` |
| SP-FLOW-011 | 根拠として扱う入力の範囲 | `docs/specifications/flow.md` |
| SP-FLOW-012 | 対象リポジトリの実装の非読み取り | `docs/specifications/flow.md` |
| SP-FLOW-013 | 所在を示された既存文書の読み取り | `docs/specifications/flow.md` |
| SP-FLOW-014 | 確定情報を尋ねる中断点の設置 | `docs/specifications/flow.md` |
| SP-FLOW-015 | 回答を受け取る前に文書の生成へ入らないこと | `docs/specifications/flow.md` |
| SP-FLOW-016 | 着手不能の未確定事項の提示 | `docs/specifications/flow.md` |
| SP-FLOW-017 | 回答済みの論点への再質問の禁止 | `docs/specifications/flow.md` |
| SP-FLOW-018 | 決めないと決めたに区分した論点への再質問の禁止 | `docs/specifications/flow.md` |
| SP-FLOW-019 | 提示済みの記録 | `docs/specifications/flow.md` |
| SP-FLOW-020 | 中断点を跨いで引き継ぐ情報 | `docs/specifications/flow.md` |
| SP-FLOW-021 | 未確定事項への区分の付与 | `docs/specifications/flow.md` |
| SP-FLOW-022 | 完成の判定 | `docs/specifications/flow.md` |
| SP-FLOW-024 | 周回の継続と上限 | `docs/specifications/flow.md` |
| SP-FLOW-025 | 保存先のパスの事前提示 | `docs/specifications/flow.md` |
| SP-FLOW-026 | 保存する内容の事前提示 | `docs/specifications/flow.md` |
| SP-FLOW-027 | 承認の意思表示の判定 | `docs/specifications/flow.md` |
| SP-FLOW-028 | 承認を得るまで保存しないこと | `docs/specifications/flow.md` |
| SP-FLOW-029 | 同名の既存ファイルの検出 | `docs/specifications/flow.md` |
| SP-FLOW-030 | 同名の既存ファイルがあるときの非保存と差分の提示 | `docs/specifications/flow.md` |
| SP-FLOW-031 | 改訂としての上書きの明示 | `docs/specifications/flow.md` |
| SP-FLOW-032 | 中間の生成物を対象リポジトリの外に置くこと | `docs/specifications/flow.md` |
| SP-FLOW-033 | 結果を得られないときの実行の終了 | `docs/specifications/flow.md` |
| SP-FLOW-034 | 未完成の文書の非保存 | `docs/specifications/flow.md` |
| SP-FLOW-035 | 中断した段階の提示 | `docs/specifications/flow.md` |
| SP-FLOW-036 | 提示した内容の書き込み | `docs/specifications/flow.md` |
| SP-FLOW-037 | 決まっていない旨の回答を受けた未確定事項の区分の付け替え | `docs/specifications/flow.md` |
| SP-FLOW-039 | 中間の生成物の置き場 | `docs/specifications/flow.md` |
| SP-FLOW-040 | 所在を示されていない文書の非検出 | `docs/specifications/flow.md` |
| SP-FLOW-041 | 承認しない旨を示されたときの作り直しへの復帰 | `docs/specifications/flow.md` |
| SP-FLOW-042 | 終了の意思を示されたときの終了 | `docs/specifications/flow.md` |
| SP-FLOW-043 | 書き込みに失敗したときの既書き込みファイルの保持 | `docs/specifications/flow.md` |
| SP-FLOW-044 | 書き込みに失敗したときの到達点の報告 | `docs/specifications/flow.md` |
| SP-FLOW-045 | 上限に達したときの残件の明示と完成 | `docs/specifications/flow.md` |
| SP-FLOW-046 | 応答を待つ時間の上限 | `docs/specifications/flow.md` |
| SP-FLOW-047 | やり直す回数の上限 | `docs/specifications/flow.md` |
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
| SP-AUTHORING-003 | 要求文書の分量の決め方 | `docs/specifications/authoring.md` |
| SP-AUTHORING-005 | 仕様書の記述水準の下限 | `docs/specifications/authoring.md` |
| SP-AUTHORING-006 | 仕様書の記述水準の上限 | `docs/specifications/authoring.md` |
| SP-AUTHORING-007 | 要求文書が持つ内容 | `docs/specifications/authoring.md` |
| SP-AUTHORING-008 | 仕様書が持つ内容 | `docs/specifications/authoring.md` |
| SP-AUTHORING-009 | 条件付き章の設置条件 | `docs/specifications/authoring.md` |
| SP-AUTHORING-010 | 常設章を削らないこと | `docs/specifications/authoring.md` |
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
| SP-AUTHORING-060 | 保存先のパス | `docs/specifications/authoring.md` |
| SP-AUTHORING-061 | topic の字種 | `docs/specifications/authoring.md` |
| SP-AUTHORING-062 | 領域コードの衝突 | `docs/specifications/authoring.md` |
| SP-AUTHORING-063 | INDEX の導出 | `docs/specifications/authoring.md` |
| SP-AUTHORING-064 | 要求文書の INDEX が持つ内容 | `docs/specifications/authoring.md` |
| SP-AUTHORING-065 | 仕様書の INDEX が持つ内容 | `docs/specifications/authoring.md` |
| SP-AUTHORING-066 | 逆参照の置き場 | `docs/specifications/authoring.md` |
| SP-AUTHORING-067 | 組み合わせの網羅の示し方 | `docs/specifications/authoring.md` |
| SP-AUTHORING-068 | 状態遷移図の設置 | `docs/specifications/authoring.md` |
| SP-AUTHORING-069 | 遷移への仕様項目 ID の付与 | `docs/specifications/authoring.md` |
| SP-AUTHORING-070 | イベント集合の宣言 | `docs/specifications/authoring.md` |
| SP-AUTHORING-071 | 行の起こし方 | `docs/specifications/authoring.md` |
| SP-AUTHORING-072 | 状態 × イベント表の行が持つ情報 | `docs/specifications/authoring.md` |
| SP-AUTHORING-073 | 発生しない組み合わせの行を削除しないこと | `docs/specifications/authoring.md` |
| SP-AUTHORING-074 | 主フローの遷移の置き場 | `docs/specifications/authoring.md` |
| SP-AUTHORING-075 | 図の記法 | `docs/specifications/authoring.md` |
| SP-AUTHORING-076 | 言及の条件 | `docs/specifications/authoring.md` |
| SP-AUTHORING-077 | 準拠の主張 | `docs/specifications/authoring.md` |
| SP-AUTHORING-078 | 条番号を付けた引用 | `docs/specifications/authoring.md` |
| SP-AUTHORING-079 | 根拠が無い事項の起票 | `docs/specifications/authoring.md` |
| SP-AUTHORING-080 | 語の集合への参照 | `docs/specifications/authoring.md` |
| SP-AUTHORING-081 | 図で示してよい内容の限定 | `docs/specifications/authoring.md` |
| SP-AUTHORING-082 | 削除した項目の ID の欠番化 | `docs/specifications/authoring.md` |
| SP-AUTHORING-085 | 発生しない組み合わせの行の空欄 | `docs/specifications/authoring.md` |
| SP-AUTHORING-086 | 発生しない組み合わせの根拠 | `docs/specifications/authoring.md` |
| SP-AUTHORING-087 | 常設章に該当が無いことの記述 | `docs/specifications/authoring.md` |
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
| SP-VERIFICATION-010 | 起票済みの論点を指摘しない | `docs/specifications/verification.md` |
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
| SP-BPCONFORMANCE-004 | 形の判定の順序 | `docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-005 | 探索グラフの適用条件 | `docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-006 | 重い形を強いた条件の記録 | `docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-007 | Workflow にしない判定 | `docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-008 | 部品による組み立て | `docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-009 | 資産台帳の要否 | `docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-010 | 目標の固定 | `docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-011 | 停止・再開と人間の入力 | `docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-012 | 体数と同時実行 | `docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-013 | モデル・effort・prompt | `docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-014 | 権限 | `docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-015 | 探索グラフ | `docs/specifications/bp-conformance.md` |
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
| SP-BPCONFORMANCE-034 | 実行役の時間の上限 | `docs/specifications/bp-conformance.md` |
| SP-BPCONFORMANCE-035 | 役ごとのモデルと effort の初期値 | `docs/specifications/bp-conformance.md` |
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
| SP-BPENTRY-017 | native Workflow の起動の失敗 | `docs/specifications/bp-entry.md` |
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
| SP-BPRUN-031 | CLI の操作 | `docs/specifications/bp-run.md` |
| SP-BPRUN-032 | run の返り値 | `docs/specifications/bp-run.md` |
| SP-BPRUN-033 | next_args の中身 | `docs/specifications/bp-run.md` |
| SP-BPRUN-034 | 起動数の記録 | `docs/specifications/bp-run.md` |

## 検査結果

- ID の重複: 0 件
