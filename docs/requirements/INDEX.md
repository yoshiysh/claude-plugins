# docs/requirements 目次

この INDEX は doc_check が文書から導出したものである。本体を直したら導出し直す（手書きしない）。

## 文書一覧

| パス | 扱う関心事 | どういう要求が書かれているか |
|---|---|---|
| `docs/requirements/bp-designed-skill.md` | 要求文書: create・update が作るスキルが備える性質 | 形の判定／形に関わる原則／形式検証／run の記録／配布先での確認（PR-BPDESIGNEDSKILL-001〜050／50 件） |
| `docs/requirements/bp-operations.md` | 要求文書: best-practices の 4 機能（create・review・update・audit） | 機能の振り分け／4 機能に共通する run の記録／回答待ちの返り値／create／update／create と update に共通／review／audit／review と audit に共通（PR-BPOPERATIONS-001〜052／52 件） |
| `docs/requirements/cleanup.md` | 要求文書: cleanup-branches | 守るもの／取り込み済みの判定／状態の取得／取り込み済みの削除／判断が要る対象の問い／承認された対象の削除／作業状態／作業場所の同期／後処理／退避した変更の復帰／完了報告（PR-CLEANUP-001〜081、欠番は 031・034・035・038・039・072・079／74 件） |
| `docs/requirements/consumer.md` | 後続作業者にとっての要求 | 引き渡しの完了条件／後続作業を戻りなく進めるための要求／後続作業を不具合なく進めるための要求／後続作業を精度高く進めるための要求／後続作業を迷いなく進めるための要求／後続作業をぶれずに進めるための要求／読み手が AI であることに由来する要求／分量の決まり方（PR-CONSUMER-001〜031、欠番は 014・016／29 件） |
| `docs/requirements/develop-address-review.md` | 要求文書: develop:address-review | 入口と目標／分類／止める所／修正と push／required checks の待ち／返信／resolve／停止と再開／完了の条件（PR-DEVELOPADDRESSREVIEW-001〜066／66 件） |
| `docs/requirements/develop-implement.md` | 要求文書: develop:implement | 入口と目標／計画／実装と check／develop:review の呼び出し／最終照合と永続化／停止と再開／完了の条件（PR-DEVELOPIMPLEMENT-001〜078／78 件） |
| `docs/requirements/develop-plugin.md` | 要求文書: develop plugin 全体と利用側リポジトリとの契約 | 構成と呼び出し／利用側リポジトリとの契約／権限と残る危険／文脈の配達／停止と再開／取得した内容の記録／つまずきの記録と改善／費用と記録／形の判定／永続化と投稿の順序／移行と旧スキルの廃止（PR-DEVELOPPLUGIN-001〜085、欠番は 016／84 件） |
| `docs/requirements/develop-review.md` | 要求文書: develop:review | 対象と目標／観点／focus／検証と資産台帳／返り値の契約／起動数の上限と再開／PR への投稿／git の外の対象（PR-DEVELOPREVIEW-001〜077／77 件） |
| `docs/requirements/requester.md` | 要求文書: 依頼者から見た振る舞い | 判定に迷う場合の共通の扱い／起動と対象の見極め／問いかけと回答／提示と承認／保存と持ち帰り／根拠として読み取る範囲／実行環境と中断（PR-REQUESTER-001〜041、欠番は 002・004・006・016・019・027・028・030／33 件） |

## 要求一覧

| ID | 見出し | 所在文書 |
|---|---|---|
| PR-BPDESIGNEDSKILL-001 | 形の判定の順序 | `docs/requirements/bp-designed-skill.md` |
| PR-BPDESIGNEDSKILL-002 | 選んだ形を強いた条件の記録 | `docs/requirements/bp-designed-skill.md` |
| PR-BPDESIGNEDSKILL-003 | Workflow にしない判定 | `docs/requirements/bp-designed-skill.md` |
| PR-BPDESIGNEDSKILL-004 | 部品による組み立て | `docs/requirements/bp-designed-skill.md` |
| PR-BPDESIGNEDSKILL-005 | 資産台帳の適用条件を満たすとき | `docs/requirements/bp-designed-skill.md` |
| PR-BPDESIGNEDSKILL-018 | 資産台帳の適用条件を満たさないとき | `docs/requirements/bp-designed-skill.md` |
| PR-BPDESIGNEDSKILL-006 | 目標の固定 | `docs/requirements/bp-designed-skill.md` |
| PR-BPDESIGNEDSKILL-007 | 停止・再開と人間の入力 | `docs/requirements/bp-designed-skill.md` |
| PR-BPDESIGNEDSKILL-008 | 体数と同時実行 | `docs/requirements/bp-designed-skill.md` |
| PR-BPDESIGNEDSKILL-009 | モデル・effort・prompt | `docs/requirements/bp-designed-skill.md` |
| PR-BPDESIGNEDSKILL-048 | 役ごとのモデルと effort の指定 | `docs/requirements/bp-designed-skill.md` |
| PR-BPDESIGNEDSKILL-010 | 権限 | `docs/requirements/bp-designed-skill.md` |
| PR-BPDESIGNEDSKILL-011 | 探索グラフ | `docs/requirements/bp-designed-skill.md` |
| PR-BPDESIGNEDSKILL-043 | 実行役の時間の上限の値 | `docs/requirements/bp-designed-skill.md` |
| PR-BPDESIGNEDSKILL-047 | 上限を守らせられる host | `docs/requirements/bp-designed-skill.md` |
| PR-BPDESIGNEDSKILL-044 | 上限を守らせられない host | `docs/requirements/bp-designed-skill.md` |
| PR-BPDESIGNEDSKILL-012 | 状態の書き込み | `docs/requirements/bp-designed-skill.md` |
| PR-BPDESIGNEDSKILL-013 | 資産台帳の原則 | `docs/requirements/bp-designed-skill.md` |
| PR-BPDESIGNEDSKILL-024 | 形式化の対象の洗い出し | `docs/requirements/bp-designed-skill.md` |
| PR-BPDESIGNEDSKILL-037 | 形式化できない性質 | `docs/requirements/bp-designed-skill.md` |
| PR-BPDESIGNEDSKILL-041 | 形式化できない性質の確認 | `docs/requirements/bp-designed-skill.md` |
| PR-BPDESIGNEDSKILL-025 | 形式検証の実施 | `docs/requirements/bp-designed-skill.md` |
| PR-BPDESIGNEDSKILL-026 | 形式検証の結果と範囲 | `docs/requirements/bp-designed-skill.md` |
| PR-BPDESIGNEDSKILL-027 | 形式検証の失敗 | `docs/requirements/bp-designed-skill.md` |
| PR-BPDESIGNEDSKILL-028 | 担当ごとの作業記録 | `docs/requirements/bp-designed-skill.md` |
| PR-BPDESIGNEDSKILL-029 | 作業記録への参照 | `docs/requirements/bp-designed-skill.md` |
| PR-BPDESIGNEDSKILL-039 | 記録の保存先 | `docs/requirements/bp-designed-skill.md` |
| PR-BPDESIGNEDSKILL-030 | 共有の記録台帳への書き込み | `docs/requirements/bp-designed-skill.md` |
| PR-BPDESIGNEDSKILL-031 | 記録の分割 | `docs/requirements/bp-designed-skill.md` |
| PR-BPDESIGNEDSKILL-032 | 記録の正本 | `docs/requirements/bp-designed-skill.md` |
| PR-BPDESIGNEDSKILL-033 | 作業記録の書き方 | `docs/requirements/bp-designed-skill.md` |
| PR-BPDESIGNEDSKILL-040 | 文書の一般規約の参照 | `docs/requirements/bp-designed-skill.md` |
| PR-BPDESIGNEDSKILL-042 | 適用した文書の一般規約の版 | `docs/requirements/bp-designed-skill.md` |
| PR-BPDESIGNEDSKILL-034 | 記録の保持 | `docs/requirements/bp-designed-skill.md` |
| PR-BPDESIGNEDSKILL-038 | 過去の実行の記録 | `docs/requirements/bp-designed-skill.md` |
| PR-BPDESIGNEDSKILL-035 | 記録の保存の失敗 | `docs/requirements/bp-designed-skill.md` |
| PR-BPDESIGNEDSKILL-036 | 性能の見直しに使う記録 | `docs/requirements/bp-designed-skill.md` |
| PR-BPDESIGNEDSKILL-014 | 役ごとの制限の実効性の確認 | `docs/requirements/bp-designed-skill.md` |
| PR-BPDESIGNEDSKILL-045 | Claude Code での確かめ方 | `docs/requirements/bp-designed-skill.md` |
| PR-BPDESIGNEDSKILL-049 | 一覧を読めないときの制限の扱い | `docs/requirements/bp-designed-skill.md` |
| PR-BPDESIGNEDSKILL-050 | 一覧を読めないときの合否 | `docs/requirements/bp-designed-skill.md` |
| PR-BPDESIGNEDSKILL-046 | 効かないと確かめた制限 | `docs/requirements/bp-designed-skill.md` |
| PR-BPDESIGNEDSKILL-015 | 確かめられなかった制限の報告 | `docs/requirements/bp-designed-skill.md` |
| PR-BPDESIGNEDSKILL-016 | 起動数の上限の受け取り | `docs/requirements/bp-designed-skill.md` |
| PR-BPDESIGNEDSKILL-017 | 上限を渡された run の起動数 | `docs/requirements/bp-designed-skill.md` |
| PR-BPDESIGNEDSKILL-019 | 上限に収まらない項目 | `docs/requirements/bp-designed-skill.md` |
| PR-BPDESIGNEDSKILL-020 | 残した項目からの再開 | `docs/requirements/bp-designed-skill.md` |
| PR-BPDESIGNEDSKILL-021 | 上限を渡されない run | `docs/requirements/bp-designed-skill.md` |
| PR-BPDESIGNEDSKILL-022 | Codex runner での起動 | `docs/requirements/bp-designed-skill.md` |
| PR-BPDESIGNEDSKILL-023 | Claude Code の native Workflow での起動 | `docs/requirements/bp-designed-skill.md` |
| PR-BPOPERATIONS-001 | 4 機能の提供 | `docs/requirements/bp-operations.md` |
| PR-BPOPERATIONS-002 | 1 つの機能への振り分け | `docs/requirements/bp-operations.md` |
| PR-BPOPERATIONS-038 | 複数の機能にまたがる依頼 | `docs/requirements/bp-operations.md` |
| PR-BPOPERATIONS-039 | どの機能にも当たらない依頼 | `docs/requirements/bp-operations.md` |
| PR-BPOPERATIONS-048 | 途中の機能が止まったときの連なり | `docs/requirements/bp-operations.md` |
| PR-BPOPERATIONS-049 | 次の機能の入力を満たさないときの連なり | `docs/requirements/bp-operations.md` |
| PR-BPOPERATIONS-051 | best-practices の run の記録 | `docs/requirements/bp-operations.md` |
| PR-BPOPERATIONS-052 | needs_input の返り値 | `docs/requirements/bp-operations.md` |
| PR-BPOPERATIONS-003 | 目標の固定 | `docs/requirements/bp-operations.md` |
| PR-BPOPERATIONS-004 | 依頼文に無い目標の禁止 | `docs/requirements/bp-operations.md` |
| PR-BPOPERATIONS-005 | 待たれる入力の不足 | `docs/requirements/bp-operations.md` |
| PR-BPOPERATIONS-006 | run の中で入力を待たない | `docs/requirements/bp-operations.md` |
| PR-BPOPERATIONS-007 | 1 回で解ける課題と探索グラフ型 | `docs/requirements/bp-operations.md` |
| PR-BPOPERATIONS-008 | 設計方針への適合 | `docs/requirements/bp-operations.md` |
| PR-BPOPERATIONS-037 | create が書き換える範囲 | `docs/requirements/bp-operations.md` |
| PR-BPOPERATIONS-009 | 生成と別の context での検証 | `docs/requirements/bp-operations.md` |
| PR-BPOPERATIONS-010 | 検証を通るまでの完了の扱い | `docs/requirements/bp-operations.md` |
| PR-BPOPERATIONS-011 | 書き直しの許容 | `docs/requirements/bp-operations.md` |
| PR-BPOPERATIONS-012 | 検証を通らずに止まるとき | `docs/requirements/bp-operations.md` |
| PR-BPOPERATIONS-013 | 続けられない失敗 | `docs/requirements/bp-operations.md` |
| PR-BPOPERATIONS-014 | create の完了時の出力 | `docs/requirements/bp-operations.md` |
| PR-BPOPERATIONS-015 | update の入力 | `docs/requirements/bp-operations.md` |
| PR-BPOPERATIONS-016 | 修正の根拠を出発点にする | `docs/requirements/bp-operations.md` |
| PR-BPOPERATIONS-017 | create と同じ処理 | `docs/requirements/bp-operations.md` |
| PR-BPOPERATIONS-018 | 全体の作り直しの許容 | `docs/requirements/bp-operations.md` |
| PR-BPOPERATIONS-019 | 既存の振る舞いの判定 | `docs/requirements/bp-operations.md` |
| PR-BPOPERATIONS-020 | 書き換える範囲 | `docs/requirements/bp-operations.md` |
| PR-BPOPERATIONS-022 | 前の run の指摘の状態（保持規則） | `docs/requirements/bp-operations.md` |
| PR-BPOPERATIONS-042 | 報告する指摘の状態（保持規則） | `docs/requirements/bp-operations.md` |
| PR-BPOPERATIONS-023 | update の完了時の出力 | `docs/requirements/bp-operations.md` |
| PR-BPOPERATIONS-021 | run の中での指摘の追跡 | `docs/requirements/bp-operations.md` |
| PR-BPOPERATIONS-044 | 指摘の追跡の原則 | `docs/requirements/bp-operations.md` |
| PR-BPOPERATIONS-045 | 完了時の指摘の状態 | `docs/requirements/bp-operations.md` |
| PR-BPOPERATIONS-046 | 完了時の skip 一覧 | `docs/requirements/bp-operations.md` |
| PR-BPOPERATIONS-040 | 途中で止まったときの書いたファイル | `docs/requirements/bp-operations.md` |
| PR-BPOPERATIONS-041 | 途中で止まったときの報告 | `docs/requirements/bp-operations.md` |
| PR-BPOPERATIONS-024 | フローの観点 | `docs/requirements/bp-operations.md` |
| PR-BPOPERATIONS-025 | 仕様の観点 | `docs/requirements/bp-operations.md` |
| PR-BPOPERATIONS-026 | 仕様書が無いとき | `docs/requirements/bp-operations.md` |
| PR-BPOPERATIONS-027 | audit の対象 | `docs/requirements/bp-operations.md` |
| PR-BPOPERATIONS-028 | 監査の観点の引き継ぎ | `docs/requirements/bp-operations.md` |
| PR-BPOPERATIONS-050 | 現行の prompt-audit が存在しないとき | `docs/requirements/bp-operations.md` |
| PR-BPOPERATIONS-029 | 監査の流れ | `docs/requirements/bp-operations.md` |
| PR-BPOPERATIONS-030 | 対象を書き換えない | `docs/requirements/bp-operations.md` |
| PR-BPOPERATIONS-031 | 指摘の反証 | `docs/requirements/bp-operations.md` |
| PR-BPOPERATIONS-032 | 指摘の状態 | `docs/requirements/bp-operations.md` |
| PR-BPOPERATIONS-043 | dismissed の指摘の扱い | `docs/requirements/bp-operations.md` |
| PR-BPOPERATIONS-033 | 資産への結び付け | `docs/requirements/bp-operations.md` |
| PR-BPOPERATIONS-034 | カバレッジと skip 一覧 | `docs/requirements/bp-operations.md` |
| PR-BPOPERATIONS-035 | 見ていない資産の扱い | `docs/requirements/bp-operations.md` |
| PR-BPOPERATIONS-036 | update への受け渡し | `docs/requirements/bp-operations.md` |
| PR-BPOPERATIONS-047 | 途中で止まったときの報告（review と audit） | `docs/requirements/bp-operations.md` |
| PR-CLEANUP-001 | 承認なしに失わないもの | `docs/requirements/cleanup.md` |
| PR-CLEANUP-076 | 現在のブランチを対象から外す | `docs/requirements/cleanup.md` |
| PR-CLEANUP-077 | 他の作業場所で checkout 中のブランチを対象から外す | `docs/requirements/cleanup.md` |
| PR-CLEANUP-078 | open の PR の head を対象から外す | `docs/requirements/cleanup.md` |
| PR-CLEANUP-002 | 主ブランチの集合 | `docs/requirements/cleanup.md` |
| PR-CLEANUP-003 | 履歴による取り込み | `docs/requirements/cleanup.md` |
| PR-CLEANUP-064 | 主ブランチを判定と削除の対象から外す | `docs/requirements/cleanup.md` |
| PR-CLEANUP-065 | remote の起点ブランチの保持 | `docs/requirements/cleanup.md` |
| PR-CLEANUP-066 | remote ブランチの PR による取り込み | `docs/requirements/cleanup.md` |
| PR-CLEANUP-004 | ローカルブランチの PR による取り込み | `docs/requirements/cleanup.md` |
| PR-CLEANUP-075 | ローカルブランチのパッチの一致による取り込み | `docs/requirements/cleanup.md` |
| PR-CLEANUP-005 | remote ブランチの判定の経路 | `docs/requirements/cleanup.md` |
| PR-CLEANUP-006 | 判定できないブランチ | `docs/requirements/cleanup.md` |
| PR-CLEANUP-007 | PR 情報が得られないとき | `docs/requirements/cleanup.md` |
| PR-CLEANUP-008 | 状態の取得 | `docs/requirements/cleanup.md` |
| PR-CLEANUP-009 | remote で削除済みのブランチの判別 | `docs/requirements/cleanup.md` |
| PR-CLEANUP-010 | 追跡 ref の削除 | `docs/requirements/cleanup.md` |
| PR-CLEANUP-011 | 起点ブランチの追従 | `docs/requirements/cleanup.md` |
| PR-CLEANUP-012 | 判断の根拠 | `docs/requirements/cleanup.md` |
| PR-CLEANUP-068 | 状態を取れなかったとみなす失敗 | `docs/requirements/cleanup.md` |
| PR-CLEANUP-080 | 起点ブランチの追従に失敗したとき | `docs/requirements/cleanup.md` |
| PR-CLEANUP-081 | 取り込み済みの判定で比べる先 | `docs/requirements/cleanup.md` |
| PR-CLEANUP-069 | PR 情報だけが得られないとき | `docs/requirements/cleanup.md` |
| PR-CLEANUP-013 | 状態を取れないときの停止 | `docs/requirements/cleanup.md` |
| PR-CLEANUP-014 | 状態を取れないときの報告 | `docs/requirements/cleanup.md` |
| PR-CLEANUP-015 | 取り込み済みのローカルブランチの削除 | `docs/requirements/cleanup.md` |
| PR-CLEANUP-016 | 取り込み済みの remote ブランチの削除 | `docs/requirements/cleanup.md` |
| PR-CLEANUP-017 | 確認なしに削除する範囲 | `docs/requirements/cleanup.md` |
| PR-CLEANUP-018 | 未取り込みの一括削除の禁止 | `docs/requirements/cleanup.md` |
| PR-CLEANUP-019 | 取り込み済みのローカルブランチの削除の失敗 | `docs/requirements/cleanup.md` |
| PR-CLEANUP-020 | 取り込み済みの remote ブランチの削除の失敗 | `docs/requirements/cleanup.md` |
| PR-CLEANUP-021 | 判断が要る対象 | `docs/requirements/cleanup.md` |
| PR-CLEANUP-067 | 判断が要る対象に入らない要判断のブランチ | `docs/requirements/cleanup.md` |
| PR-CLEANUP-071 | 追跡先を持たない未取り込みのローカルブランチ | `docs/requirements/cleanup.md` |
| PR-CLEANUP-022 | 1 回の問い | `docs/requirements/cleanup.md` |
| PR-CLEANUP-023 | 判断が要る対象が無いとき | `docs/requirements/cleanup.md` |
| PR-CLEANUP-024 | 候補の示し方 | `docs/requirements/cleanup.md` |
| PR-CLEANUP-025 | 候補に添える事実 | `docs/requirements/cleanup.md` |
| PR-CLEANUP-026 | 要約したときの選択肢 | `docs/requirements/cleanup.md` |
| PR-CLEANUP-027 | 一括削除の選択肢の禁止 | `docs/requirements/cleanup.md` |
| PR-CLEANUP-028 | 応答の扱い | `docs/requirements/cleanup.md` |
| PR-CLEANUP-029 | 一覧の提示の上限 | `docs/requirements/cleanup.md` |
| PR-CLEANUP-030 | 終了済みの workspace | `docs/requirements/cleanup.md` |
| PR-CLEANUP-032 | workspace の示し方 | `docs/requirements/cleanup.md` |
| PR-CLEANUP-033 | 承認されない対象 | `docs/requirements/cleanup.md` |
| PR-CLEANUP-036 | 承認されたローカルブランチの削除 | `docs/requirements/cleanup.md` |
| PR-CLEANUP-037 | 承認されたローカルブランチの削除の失敗 | `docs/requirements/cleanup.md` |
| PR-CLEANUP-040 | 承認された remote ブランチの削除 | `docs/requirements/cleanup.md` |
| PR-CLEANUP-041 | 承認された remote ブランチの削除の失敗 | `docs/requirements/cleanup.md` |
| PR-CLEANUP-042 | 承認された workspace の削除 | `docs/requirements/cleanup.md` |
| PR-CLEANUP-043 | workspace の削除の失敗 | `docs/requirements/cleanup.md` |
| PR-CLEANUP-044 | 作業状態を削除しない | `docs/requirements/cleanup.md` |
| PR-CLEANUP-045 | 作業状態の提示 | `docs/requirements/cleanup.md` |
| PR-CLEANUP-046 | 検出手段による起点ブランチ | `docs/requirements/cleanup.md` |
| PR-CLEANUP-047 | 既定の起点ブランチ | `docs/requirements/cleanup.md` |
| PR-CLEANUP-048 | 未コミットの変更の退避 | `docs/requirements/cleanup.md` |
| PR-CLEANUP-049 | 退避の失敗 | `docs/requirements/cleanup.md` |
| PR-CLEANUP-050 | 現在のブランチの open PR | `docs/requirements/cleanup.md` |
| PR-CLEANUP-051 | 起点ブランチへ動かすかの判定 | `docs/requirements/cleanup.md` |
| PR-CLEANUP-052 | 起点ブランチに無いコミットがあるときの同期 | `docs/requirements/cleanup.md` |
| PR-CLEANUP-074 | 同期で作業ツリーを保つ | `docs/requirements/cleanup.md` |
| PR-CLEANUP-053 | 作業用ブランチの名前 | `docs/requirements/cleanup.md` |
| PR-CLEANUP-054 | 既定の作業用ブランチの名前 | `docs/requirements/cleanup.md` |
| PR-CLEANUP-055 | 作業用ブランチを作れないとき | `docs/requirements/cleanup.md` |
| PR-CLEANUP-056 | 後処理の実行 | `docs/requirements/cleanup.md` |
| PR-CLEANUP-057 | 書かれていないコマンドの禁止 | `docs/requirements/cleanup.md` |
| PR-CLEANUP-058 | 後処理の失敗 | `docs/requirements/cleanup.md` |
| PR-CLEANUP-059 | 後処理の設定が無いとき | `docs/requirements/cleanup.md` |
| PR-CLEANUP-060 | 退避した変更を戻す | `docs/requirements/cleanup.md` |
| PR-CLEANUP-061 | 退避が無いとき | `docs/requirements/cleanup.md` |
| PR-CLEANUP-070 | 戻す退避の範囲 | `docs/requirements/cleanup.md` |
| PR-CLEANUP-062 | 完了報告の項目 | `docs/requirements/cleanup.md` |
| PR-CLEANUP-073 | 作業状態の件数の時点 | `docs/requirements/cleanup.md` |
| PR-CLEANUP-063 | 残したものの明示 | `docs/requirements/cleanup.md` |
| PR-CONSUMER-001 | 追加の質問を要さない着手可能性 | `docs/requirements/consumer.md` |
| PR-CONSUMER-002 | 曖昧語の不在 | `docs/requirements/consumer.md` |
| PR-CONSUMER-003 | 平叙終止の不在 | `docs/requirements/consumer.md` |
| PR-CONSUMER-004 | 複合要求の不在 | `docs/requirements/consumer.md` |
| PR-CONSUMER-005 | 要求と仕様項目の紐付け | `docs/requirements/consumer.md` |
| PR-CONSUMER-006 | 要求と検証方法の紐付け | `docs/requirements/consumer.md` |
| PR-CONSUMER-007 | 着手を止める未確定事項の不在 | `docs/requirements/consumer.md` |
| PR-CONSUMER-008 | 未定義の振る舞いの不在 | `docs/requirements/consumer.md` |
| PR-CONSUMER-009 | 検討した観点の全件記載 | `docs/requirements/consumer.md` |
| PR-CONSUMER-010 | 対象範囲の明示 | `docs/requirements/consumer.md` |
| PR-CONSUMER-011 | 前提の明示 | `docs/requirements/consumer.md` |
| PR-CONSUMER-012 | 判断の委譲の禁止 | `docs/requirements/consumer.md` |
| PR-CONSUMER-013 | 継続できない事象の振る舞いの記述 | `docs/requirements/consumer.md` |
| PR-CONSUMER-015 | 数量の単位と境界の明示 | `docs/requirements/consumer.md` |
| PR-CONSUMER-017 | 境界を超えたときの振る舞いの記述 | `docs/requirements/consumer.md` |
| PR-CONSUMER-018 | 出所の特定可能性 | `docs/requirements/consumer.md` |
| PR-CONSUMER-019 | 用語の一意性 | `docs/requirements/consumer.md` |
| PR-CONSUMER-020 | 解釈が分かれる語の定義 | `docs/requirements/consumer.md` |
| PR-CONSUMER-021 | 記述の所在の特定 | `docs/requirements/consumer.md` |
| PR-CONSUMER-022 | 文書間の非矛盾 | `docs/requirements/consumer.md` |
| PR-CONSUMER-023 | 識別子の一意性 | `docs/requirements/consumer.md` |
| PR-CONSUMER-024 | 参照の解決 | `docs/requirements/consumer.md` |
| PR-CONSUMER-025 | 同一内容の二重記述の禁止 | `docs/requirements/consumer.md` |
| PR-CONSUMER-026 | 文書外の知識に依存しない記述 | `docs/requirements/consumer.md` |
| PR-CONSUMER-027 | 実在の人物を特定する表記の不記載 | `docs/requirements/consumer.md` |
| PR-CONSUMER-028 | 役割名による人物の記述 | `docs/requirements/consumer.md` |
| PR-CONSUMER-029 | 改稿の経緯の不記載 | `docs/requirements/consumer.md` |
| PR-CONSUMER-030 | 要求文書の分量 | `docs/requirements/consumer.md` |
| PR-CONSUMER-031 | 仕様書の分量 | `docs/requirements/consumer.md` |
| PR-DEVELOPADDRESSREVIEW-001 | 入口で受ける指摘 | `docs/requirements/develop-address-review.md` |
| PR-DEVELOPADDRESSREVIEW-002 | PR があるときの目標 | `docs/requirements/develop-address-review.md` |
| PR-DEVELOPADDRESSREVIEW-003 | PR が無いときの目標 | `docs/requirements/develop-address-review.md` |
| PR-DEVELOPADDRESSREVIEW-004 | PR が無いときの作業ツリー | `docs/requirements/develop-address-review.md` |
| PR-DEVELOPADDRESSREVIEW-005 | 名指された branch の方針の版 | `docs/requirements/develop-address-review.md` |
| PR-DEVELOPADDRESSREVIEW-006 | remote に無い branch | `docs/requirements/develop-address-review.md` |
| PR-DEVELOPADDRESSREVIEW-007 | 外のレビュー結果の形 | `docs/requirements/develop-address-review.md` |
| PR-DEVELOPADDRESSREVIEW-008 | 外の指摘の ID | `docs/requirements/develop-address-review.md` |
| PR-DEVELOPADDRESSREVIEW-009 | 外の指摘の本文 | `docs/requirements/develop-address-review.md` |
| PR-DEVELOPADDRESSREVIEW-010 | push できるかの確認 | `docs/requirements/develop-address-review.md` |
| PR-DEVELOPADDRESSREVIEW-011 | push できないとき | `docs/requirements/develop-address-review.md` |
| PR-DEVELOPADDRESSREVIEW-047 | push できず直す変更が無いとき | `docs/requirements/develop-address-review.md` |
| PR-DEVELOPADDRESSREVIEW-012 | 指摘より後の commit の一覧 | `docs/requirements/develop-address-review.md` |
| PR-DEVELOPADDRESSREVIEW-013 | 分類の run | `docs/requirements/develop-address-review.md` |
| PR-DEVELOPADDRESSREVIEW-014 | 分類が食い違ったとき | `docs/requirements/develop-address-review.md` |
| PR-DEVELOPADDRESSREVIEW-015 | 分類の run の書き込み | `docs/requirements/develop-address-review.md` |
| PR-DEVELOPADDRESSREVIEW-016 | 既に直った指摘の分類 | `docs/requirements/develop-address-review.md` |
| PR-DEVELOPADDRESSREVIEW-017 | 直した commit の照合 | `docs/requirements/develop-address-review.md` |
| PR-DEVELOPADDRESSREVIEW-053 | 直した commit の照合に合わないとき | `docs/requirements/develop-address-review.md` |
| PR-DEVELOPADDRESSREVIEW-018 | 既に直った指摘を修正に渡さない | `docs/requirements/develop-address-review.md` |
| PR-DEVELOPADDRESSREVIEW-019 | 人の判断が要る指摘 | `docs/requirements/develop-address-review.md` |
| PR-DEVELOPADDRESSREVIEW-020 | 同じ状態での 2 回目の分類 | `docs/requirements/develop-address-review.md` |
| PR-DEVELOPADDRESSREVIEW-048 | 人の判断を入れること | `docs/requirements/develop-address-review.md` |
| PR-DEVELOPADDRESSREVIEW-061 | 人の判断の値 | `docs/requirements/develop-address-review.md` |
| PR-DEVELOPADDRESSREVIEW-064 | fix の判断の修正の対象のパス | `docs/requirements/develop-address-review.md` |
| PR-DEVELOPADDRESSREVIEW-062 | 人の判断を入れた指摘の扱い | `docs/requirements/develop-address-review.md` |
| PR-DEVELOPADDRESSREVIEW-021 | 止める所の指定 | `docs/requirements/develop-address-review.md` |
| PR-DEVELOPADDRESSREVIEW-056 | 止める所が行わないとした操作 | `docs/requirements/develop-address-review.md` |
| PR-DEVELOPADDRESSREVIEW-022 | develop:implement への受け渡し | `docs/requirements/develop-address-review.md` |
| PR-DEVELOPADDRESSREVIEW-023 | 直す変更が無いとき | `docs/requirements/develop-address-review.md` |
| PR-DEVELOPADDRESSREVIEW-024 | develop:implement が止まったとき | `docs/requirements/develop-address-review.md` |
| PR-DEVELOPADDRESSREVIEW-066 | develop:implement が止まったときに返すもの | `docs/requirements/develop-address-review.md` |
| PR-DEVELOPADDRESSREVIEW-055 | develop:implement の段からの再開 | `docs/requirements/develop-address-review.md` |
| PR-DEVELOPADDRESSREVIEW-049 | commit の依頼 | `docs/requirements/develop-address-review.md` |
| PR-DEVELOPADDRESSREVIEW-025 | push | `docs/requirements/develop-address-review.md` |
| PR-DEVELOPADDRESSREVIEW-054 | develop:implement が commit しなかったとき | `docs/requirements/develop-address-review.md` |
| PR-DEVELOPADDRESSREVIEW-057 | push で止めるときに commit しなかったとき | `docs/requirements/develop-address-review.md` |
| PR-DEVELOPADDRESSREVIEW-052 | push が拒まれたとき | `docs/requirements/develop-address-review.md` |
| PR-DEVELOPADDRESSREVIEW-026 | PR が無いときに行わないこと | `docs/requirements/develop-address-review.md` |
| PR-DEVELOPADDRESSREVIEW-027 | 待つ SHA | `docs/requirements/develop-address-review.md` |
| PR-DEVELOPADDRESSREVIEW-028 | push した SHA と PR の head | `docs/requirements/develop-address-review.md` |
| PR-DEVELOPADDRESSREVIEW-029 | required checks の状態による進み方 | `docs/requirements/develop-address-review.md` |
| PR-DEVELOPADDRESSREVIEW-030 | CI の失敗を直さない | `docs/requirements/develop-address-review.md` |
| PR-DEVELOPADDRESSREVIEW-031 | 待ちの上限からの再開 | `docs/requirements/develop-address-review.md` |
| PR-DEVELOPADDRESSREVIEW-032 | 再開の前に head が動いていたとき | `docs/requirements/develop-address-review.md` |
| PR-DEVELOPADDRESSREVIEW-033 | 待ちの再開の回数 | `docs/requirements/develop-address-review.md` |
| PR-DEVELOPADDRESSREVIEW-034 | 待ちの再開の回数の記録 | `docs/requirements/develop-address-review.md` |
| PR-DEVELOPADDRESSREVIEW-035 | 返信の直前の再照合 | `docs/requirements/develop-address-review.md` |
| PR-DEVELOPADDRESSREVIEW-036 | head が他の人の push で動いたとき | `docs/requirements/develop-address-review.md` |
| PR-DEVELOPADDRESSREVIEW-050 | thread の議論が変わっていたとき | `docs/requirements/develop-address-review.md` |
| PR-DEVELOPADDRESSREVIEW-051 | 返信を止めた指摘の報告 | `docs/requirements/develop-address-review.md` |
| PR-DEVELOPADDRESSREVIEW-037 | 返信の宛先 | `docs/requirements/develop-address-review.md` |
| PR-DEVELOPADDRESSREVIEW-038 | 既に直った指摘への返信 | `docs/requirements/develop-address-review.md` |
| PR-DEVELOPADDRESSREVIEW-039 | 返信の確認 | `docs/requirements/develop-address-review.md` |
| PR-DEVELOPADDRESSREVIEW-040 | 返信の確認が食い違うとき | `docs/requirements/develop-address-review.md` |
| PR-DEVELOPADDRESSREVIEW-041 | resolve の候補の条件 | `docs/requirements/develop-address-review.md` |
| PR-DEVELOPADDRESSREVIEW-042 | 分類による resolve の扱い | `docs/requirements/develop-address-review.md` |
| PR-DEVELOPADDRESSREVIEW-043 | resolve の確認 | `docs/requirements/develop-address-review.md` |
| PR-DEVELOPADDRESSREVIEW-044 | resolve の確認が食い違うとき | `docs/requirements/develop-address-review.md` |
| PR-DEVELOPADDRESSREVIEW-045 | resolve の候補の全数の検査 | `docs/requirements/develop-address-review.md` |
| PR-DEVELOPADDRESSREVIEW-046 | address-review の結果 | `docs/requirements/develop-address-review.md` |
| PR-DEVELOPADDRESSREVIEW-058 | 停止の名前と記録する位置 | `docs/requirements/develop-address-review.md` |
| PR-DEVELOPADDRESSREVIEW-059 | 停止からの再開 | `docs/requirements/develop-address-review.md` |
| PR-DEVELOPADDRESSREVIEW-065 | 止まっている間のほかの入力 | `docs/requirements/develop-address-review.md` |
| PR-DEVELOPADDRESSREVIEW-063 | どの時点でも守る条件 | `docs/requirements/develop-address-review.md` |
| PR-DEVELOPADDRESSREVIEW-060 | 完了の条件 | `docs/requirements/develop-address-review.md` |
| PR-DEVELOPIMPLEMENT-001 | 目標の固定 | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-036 | 依頼の文の保存 | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-037 | 目標に足さないもの | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-038 | 依頼の文と目標を書き換えない | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-002 | 人の回答の記録 | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-052 | 記録した回答を読ませる | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-003 | 渡された方針の版と照らす先 | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-004 | 照らす先の branch の導き方 | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-053 | 名指された branch が remote に無いとき | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-005 | 渡された SHA の確認 | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-006 | 計画の run | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-007 | 計画が通らないとき | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-008 | 計画の run が人の判断を求めたとき | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-009 | 計画の run の書き込み | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-039 | 止まっている間のヒント | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-040 | ヒントを読ませる | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-065 | ヒントで作り直したときの開始時の check | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-067 | ヒントで作り直したときに開始時の結果が無いとき | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-066 | ヒントで作り直した計画の後で止まる所 | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-041 | ヒントの足し方の提示 | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-042 | ヒントを拒否する状態 | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-010 | check の宣言が無いとき | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-011 | check を推測しない | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-012 | 計画で止める | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-013 | 計画で止めた後の続き | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-014 | 計画で止めた後に作業ツリーが変わったとき | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-015 | 作業ツリーが変わった後に続けるとき | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-016 | 開始時の check | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-017 | 宣言の外の check | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-018 | 書き込める run の役 | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-043 | 確定した指摘が計画の外を指すとき | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-058 | 作り直すときの作業ツリー | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-059 | 作り直した後の check の比べる先 | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-060 | 作り直しと修正の回の数 | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-044 | 直す変更が無いとき | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-073 | 直す変更が無いと返されても終わらないとき | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-061 | 直す変更が無いときの結果 | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-019 | 変更の後の check | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-020 | テストのケースの基準 | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-054 | 指定された基準を読めないとき | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-021 | 修正の回の上限に達したとき | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-022 | 上限で止まったときの変更 | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-055 | 手直しの後の再開 | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-072 | 上限から作り直した計画 | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-023 | review の呼び出し | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-024 | review が上限で止まったとき | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-075 | 呼び直しが進まないとき | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-025 | 記録する review の返り値 | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-077 | review が結果の状態を返さずに止まったとき | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-045 | review が failed のときの変更 | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-026 | review の返り値の照合 | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-056 | 返り値が形に合わないとき | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-027 | 直す対象にする指摘 | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-028 | 未検証の指摘が残るとき | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-046 | abandon で止まるときの変更 | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-047 | abandon で止まるときに返すもの | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-062 | abandon で止まるときに人が決めること | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-063 | 確定した指摘と未検証の指摘の数え方 | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-064 | 同じ返り値で判断を足された指摘を理由に再び止まらない | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-048 | abandon で止まるときの commit と push | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-029 | 記録した review の返り値による進み方 | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-074 | 直す対象の数え方 | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-030 | 見られなかった範囲の報告 | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-071 | 完了の前の未読のヒント | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-057 | 最終照合で照らすもの | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-031 | 最終照合が通らないとき | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-032 | 最終照合が通らないときの変更 | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-033 | commit する条件 | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-034 | commit の後の push | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-049 | address-review から PR の修正を受けたとき | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-051 | address-review の PR の修正を push しない | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-050 | push が拒まれたとき | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-035 | implement の結果 | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-068 | 停止の名前と記録する位置 | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-069 | 停止からの再開 | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-076 | 止まっている間のほかの入力 | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-078 | 実装の後の停止から新しく呼ぶとき | `docs/requirements/develop-implement.md` |
| PR-DEVELOPIMPLEMENT-070 | 完了の条件 | `docs/requirements/develop-implement.md` |
| PR-DEVELOPPLUGIN-001 | 呼び出し名 | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-002 | 3 スキルの版の一致 | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-003 | 呼び出しの向き | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-004 | 実行環境がそろわないとき | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-005 | Codex での実行 | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-006 | 段の選択 | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-007 | 司令塔が作らないもの | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-008 | 固有の値の直書き | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-009 | 今の 3 スキルから残すもの | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-010 | 足す範囲 | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-011 | 宣言の形が合わないとき | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-012 | PR が対象のときの方針の版 | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-013 | PR が対象でないときの方針の版 | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-080 | 渡された方針の版 | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-014 | 方針の版が決まらないとき | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-015 | 宣言と方針文書を読む版 | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-017 | 人が読む出力の言語 | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-018 | 出力の言語の既定 | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-019 | 出力の言語が効かない範囲 | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-020 | 出力の言語を決める出所 | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-021 | Codex runner での書き込みの権限 | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-022 | 読み取り専用の run の中の書き込み | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-023 | 状態を書く時点 | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-024 | 書き込みの事後の検出 | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-025 | 道具の制限と事後の検出 | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-026 | 書き込みを検出したとき | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-027 | 検出した変化の報告 | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-028 | 残る危険の報告 | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-029 | run の前にそろえる許可 | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-030 | 前提の配達 | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-031 | 配れなかった前提の宣言 | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-032 | 止まるときに返すもの | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-033 | GitHub・git・check・状態の失敗 | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-034 | 失敗で止まるときの状態への記録 | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-035 | 再開の仕方 | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-036 | relaunch の禁止 | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-037 | run の中で人の入力を待たない | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-038 | 人の判断で止まるときに返すもの | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-039 | 前の run の遅れた書き込み | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-040 | pipeline の外の agent の失敗 | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-041 | 再開をまたいで残す値 | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-042 | 写し間違いの検出 | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-075 | 取得した内容の記録 | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-076 | 記録を根拠として読む | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-077 | 停止の理由の記録 | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-078 | 繰り返すつまずきの行き先 | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-079 | run の中でのスキルの書き換え | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-043 | トークン量の上限を受け取る経路 | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-044 | トークン量の既定の上限 | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-045 | トークン量の上限に達したとき | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-046 | 起動した agent の記録 | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-071 | 役ごとのモデルと effort の根拠 | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-085 | 役ごとのモデルと effort の指定 | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-047 | 形の判定の記録 | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-048 | 検証の後の永続化と投稿 | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-049 | 投稿・返信・resolve の取り消し | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-074 | 履歴を書き換える push | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-050 | 利用側の宣言を先に入れる | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-051 | claude-plugins の宣言を入れるときに壊さないもの | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-081 | develop が無い間の宣言 | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-052 | tool の option の出力 | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-053 | 登録のときに壊れてよいもの | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-054 | bp review による作成の完了 | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-055 | 判定の模型を改めた bp での review | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-056 | 作成の完了の検査 | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-057 | 作成の完了の試走 | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-082 | 試走を完了に数える条件 | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-083 | evals の測定 | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-073 | 仕様の ID の網羅の検査 | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-058 | 汎用の description | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-059 | 発火の評価の取り直し | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-060 | workflow の 2 スキルの廃止 | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-084 | workflow の 2 スキルの廃止の検査 | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-061 | workflow の 2 スキルを消す時点 | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-062 | dcf の contextual-code-review の置き換え | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-063 | dcf への約束の範囲 | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-064 | 旧スキルを消す順序 | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-065 | 元の機能の行き先 | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-066 | workflow の 2 スキルの廃止で失うもの | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-072 | pk・dcf の旧スキルの廃止で失うもの | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-067 | 旧名の参照 | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-068 | 旧名を呼ぶ利用者への案内 | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-069 | pk・dcf の置き換えの完了 | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPPLUGIN-070 | dcf の金融ロジックの観点 | `docs/requirements/develop-plugin.md` |
| PR-DEVELOPREVIEW-001 | 目標の固定 | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-002 | checkout していない PR | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-003 | 渡された pin の値 | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-004 | 観点の閉集合 | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-005 | 方針文書が無いときの閉集合 | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-006 | 「必ず当てる」観点 | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-007 | 必須の観点の出所 | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-008 | 方針文書が無いときの必須の観点 | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-009 | 方針文書があるときの種類の必須 | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-068 | 方針文書があるときの他の種類 | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-010 | 計画の拒否 | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-011 | skill の種類のファイルの割り当て | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-012 | skill の観点が読む規則 | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-013 | 「読むもの」表の参照の解決 | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-061 | 基点のディレクトリの宣言が無いとき | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-062 | 基点が無くて解決できなかった名前 | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-014 | 方針文書が無いとき | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-015 | 「読むもの」表を読めないとき | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-063 | 表が挙げる文書を読めないとき | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-064 | 読めなかった文書の宣言 | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-016 | 対象の種類の分類 | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-017 | specification と prd の宣言が無いとき | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-059 | 除外の宣言が無いとき | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-060 | 生成物の宣言が無いとき | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-018 | 重大度の語彙 | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-019 | focus を書く役 | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-020 | focus の引用 | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-065 | 方針文書が無いときの束の節 | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-021 | focus を書く役が変えないもの | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-022 | 合わない focus | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-023 | focus を省かない | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-024 | 指摘の確定 | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-025 | 確定に要る票 | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-026 | 資産 | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-027 | 「見た」の記録 | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-028 | 読まれていない資産の追加の起動 | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-029 | 追加の起動を止める回 | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-030 | 結果の状態 | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-031 | 除外した指摘の返却 | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-032 | 確定した指摘の返却 | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-069 | 未検証の指摘の返却 | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-033 | 見ていないものの宣言 | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-034 | 書き込みを検出したとき | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-074 | 完了の条件 | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-035 | 起動数の上限を受け取る経路 | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-071 | Codex runner で起動するときの上限 | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-036 | 上限を渡されないとき | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-070 | 1 回の呼び出しに収まらない項目 | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-037 | 上限を渡されたときの枠の取り置き | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-038 | 起動数に数えるもの | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-066 | 上限で止まったときの返り値 | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-039 | 枠に収まらない項目 | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-040 | 未着手の順位 | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-041 | 止まった run の結果の記録 | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-042 | 未着手からの再開 | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-043 | 再開の前の pin の確認 | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-072 | 停止の名前と記録する位置 | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-073 | 停止からの再開 | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-077 | 止まっている間に起きること | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-044 | 再開した run の権限 | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-045 | 同時に走る agent の数 | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-046 | LLM に渡す前の統合 | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-047 | 投稿する条件 | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-048 | 呼び出し側があるとき | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-049 | 行を解決できない指摘 | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-050 | 投稿の確認 | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-051 | 投稿の確認が食い違うとき | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-052 | gh で投稿できない環境 | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-067 | 投稿が拒まれたか失敗したとき | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-075 | 同じ pin のもとでの投稿の回数 | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-076 | pin が崩れた後の投稿 | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-053 | git の外の対象を見る条件 | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-054 | 貼り付けた本文の扱い | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-055 | git の外の対象の目標 | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-056 | git の外の対象の観点 | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-057 | git の外の対象の資産台帳 | `docs/requirements/develop-review.md` |
| PR-DEVELOPREVIEW-058 | git の外の対象で見なかったもの | `docs/requirements/develop-review.md` |
| PR-REQUESTER-037 | 判定に迷う場合に結論を定めない | `docs/requirements/requester.md` |
| PR-REQUESTER-040 | 判定に迷う場合に依頼者へ確認する | `docs/requirements/requester.md` |
| PR-REQUESTER-001 | 対象外の依頼で作成に入らない | `docs/requirements/requester.md` |
| PR-REQUESTER-003 | 作成する文書の種別を依頼文の語から判定する | `docs/requirements/requester.md` |
| PR-REQUESTER-038 | 種別の判定に用いる語を足さない | `docs/requirements/requester.md` |
| PR-REQUESTER-033 | 所在が示されなければ新規作成として扱う | `docs/requirements/requester.md` |
| PR-REQUESTER-005 | 着手を止める論点を尋ねる | `docs/requirements/requester.md` |
| PR-REQUESTER-007 | 同じ論点を繰り返し尋ねない | `docs/requirements/requester.md` |
| PR-REQUESTER-008 | 「分からない」と答える権利 | `docs/requirements/requester.md` |
| PR-REQUESTER-029 | 決まっていない旨の回答を着手不能から外す | `docs/requirements/requester.md` |
| PR-REQUESTER-009 | 未回答の事項を推測で埋めない | `docs/requirements/requester.md` |
| PR-REQUESTER-010 | 承認を得ずに保存しない | `docs/requirements/requester.md` |
| PR-REQUESTER-011 | 書き込む先を先に示す | `docs/requirements/requester.md` |
| PR-REQUESTER-012 | 書き込む内容を先に示す | `docs/requirements/requester.md` |
| PR-REQUESTER-013 | 承認の意思の有無を定型の語句で判定しない | `docs/requirements/requester.md` |
| PR-REQUESTER-014 | 未確定事項が残っている事実を明示せずに完了しない | `docs/requirements/requester.md` |
| PR-REQUESTER-015 | 着手を止める未確定事項の内容を依頼者へ示す | `docs/requirements/requester.md` |
| PR-REQUESTER-017 | 上書きであることを示す | `docs/requirements/requester.md` |
| PR-REQUESTER-036 | 新規作成の同名衝突では保存しない | `docs/requirements/requester.md` |
| PR-REQUESTER-039 | 新規作成の同名衝突では差分を示して指示を求める | `docs/requirements/requester.md` |
| PR-REQUESTER-018 | 中間の生成物を対象リポジトリに残さない | `docs/requirements/requester.md` |
| PR-REQUESTER-031 | 中間の生成物を依頼者のホームディレクトリの配下に置く | `docs/requirements/requester.md` |
| PR-REQUESTER-020 | 依頼文・回答・所在を示された文書以外を要求の根拠にしない | `docs/requirements/requester.md` |
| PR-REQUESTER-021 | 対象リポジトリの実装を読み取らない | `docs/requirements/requester.md` |
| PR-REQUESTER-022 | 所在を示された既存文書は読み取る | `docs/requirements/requester.md` |
| PR-REQUESTER-032 | 所在を示されていない文書を走査で探し出さない | `docs/requirements/requester.md` |
| PR-REQUESTER-035 | 所在を示されていない文書を読み取らない | `docs/requirements/requester.md` |
| PR-REQUESTER-023 | 実行基盤が要件を満たすかを起動時に確認する | `docs/requirements/requester.md` |
| PR-REQUESTER-041 | 非対応の環境で作成に入らない | `docs/requirements/requester.md` |
| PR-REQUESTER-024 | 非対応の環境であることを示す | `docs/requirements/requester.md` |
| PR-REQUESTER-034 | 上限を超えて実行を継続しない | `docs/requirements/requester.md` |
| PR-REQUESTER-025 | 未完成の文書を成果物として保存しない | `docs/requirements/requester.md` |
| PR-REQUESTER-026 | 中断したことを依頼者へ示す | `docs/requirements/requester.md` |

## 関連する仕様文書

| 要求文書 | 対応する仕様文書 |
|---|---|
| `docs/requirements/bp-designed-skill.md` | `docs/specifications/bp-authoring.md` / `docs/specifications/bp-conformance.md` / `docs/specifications/bp-entry.md` / `docs/specifications/bp-run.md` |
| `docs/requirements/bp-operations.md` | `docs/specifications/bp-authoring.md` / `docs/specifications/bp-conformance.md` / `docs/specifications/bp-entry.md` / `docs/specifications/bp-findings.md` / `docs/specifications/bp-inspection.md` / `docs/specifications/bp-run.md` |
| `docs/requirements/cleanup.md` | （対応する仕様文書なし） |
| `docs/requirements/consumer.md` | `docs/specifications/authoring.md` / `docs/specifications/elicitation.md` / `docs/specifications/flow.md` / `docs/specifications/verification.md` |
| `docs/requirements/develop-address-review.md` | （対応する仕様文書なし） |
| `docs/requirements/develop-implement.md` | （対応する仕様文書なし） |
| `docs/requirements/develop-plugin.md` | （対応する仕様文書なし） |
| `docs/requirements/develop-review.md` | （対応する仕様文書なし） |
| `docs/requirements/requester.md` | `docs/specifications/authoring.md` / `docs/specifications/elicitation.md` / `docs/specifications/flow.md` / `docs/specifications/verification.md` |

## 未解決（着手を止める未確定事項）

着手を止める未確定事項は 0 件である。

## 検査結果

- ID の重複: 0 件
- 実現する仕様項目が無い要求: 379 件
