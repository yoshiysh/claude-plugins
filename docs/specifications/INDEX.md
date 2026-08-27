# docs/specifications 目次

この INDEX は自動生成される導出物である。本体を直したら再生成すること（手書きしない）。

## 文書一覧

| パス | 扱う関心事 | どういう仕様項目が書かれているか |
|---|---|---|
| `docs/specifications/flow.md` | 実行全体の制御（モード・周回・完成判定・保存） | 実行のモード決定・中断点の順序制約・未確定事項の区分と周回・完成判定・保存の承認と書き込み・実行基盤の制約と中断時の振る舞いを、外から観測できる振る舞いとして定める仕様書。状態遷移図と状態 × イベント表で全体の制御の網羅を示す。 |
| `docs/specifications/elicitation.md` | 未確定事項の抽出と問いの生成 | 依頼文などの入力から確定・未確定・保留の事項を区分し、着手を止める論点についてのみ問いを作る条件と、回答・無回答・論点の変化を受けたときの区分の付け替えを定める仕様書。 |
| `docs/specifications/authoring.md` | 生成文書そのものの記述規律 | 生成される要求文書・仕様書そのものの記述仕様（分量・章構成・要求文と仕様項目の書き方・ID 体系・トレーサビリティ表・未確定事項の書式・ファイル配置と INDEX・状態とイベントの記述・外部規格への言及）を定める仕様書。 |
| `docs/specifications/verification.md` | 生成文書の検査と改稿の反復 | 生成された文書一式に対する検査の観点と実施単位、指摘を受けた改稿、検査と改稿の反復の上限（2 往復）、検査記録の保持と引き渡し、未実施の検査を指摘 0 件と区別して扱う規律を定める仕様書。 |

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
| SP-AUTHORING-055 | 区分の並び順 | `docs/specifications/authoring.md` |
| SP-AUTHORING-056 | 未確定事項が持つ情報 | `docs/specifications/authoring.md` |
| SP-AUTHORING-057 | 決定者と期限の空欄 | `docs/specifications/authoring.md` |
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

## 検査結果

- ID の重複: 0 件
