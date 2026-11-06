# docs/requirements 目次

この INDEX は doc_check が文書から導出したものである。本体を直したら導出し直す（手書きしない）。

## 文書一覧

| パス | 扱う関心事 | どういう要求が書かれているか |
|---|---|---|
| `docs/requirements/bp-designed-skill.md` | 要求文書: create・update が作るスキルが備える性質 | 配置の原則／形の判定／形に関わる原則／形式検証／run の記録／配布先での確認（PR-BPDESIGNEDSKILL-001〜051／51 件） |
| `docs/requirements/bp-operations.md` | 要求文書: best-practices の 4 機能（create・review・update・audit） | 機能の振り分け／4 機能に共通する run の記録／回答待ちの返り値／create／update／create と update に共通／review／audit／review と audit に共通（PR-BPOPERATIONS-001〜052／52 件） |
| `docs/requirements/cleanup.md` | 要求文書: cleanup-branches | 守るもの／取り込み済みの判定／状態の取得／取り込み済みの削除／判断が要る対象の問い／承認された対象の削除／作業状態／作業場所の同期／後処理／退避した変更の復帰／完了報告（PR-CLEANUP-001〜081、欠番は 031・034・035・038・039・072・079／74 件） |
| `docs/requirements/consumer.md` | 後続作業者にとっての要求 | 引き渡しの完了条件／後続作業を戻りなく進めるための要求／後続作業を不具合なく進めるための要求／後続作業を精度高く進めるための要求／後続作業を迷いなく進めるための要求／後続作業をぶれずに進めるための要求／読み手が AI であることに由来する要求／分量の決まり方（PR-CONSUMER-001〜033、欠番は 014・016・032／30 件） |
| `docs/requirements/develop-address-review.md` | 要求文書: develop:address-review | 入口と目標／分類／止める所／修正と push／required checks の待ち／返信／resolve／停止と再開／完了の条件（PR-DEVELOPADDRESSREVIEW-001〜066／66 件） |
| `docs/requirements/develop-implement.md` | 要求文書: develop:implement | 入口と目標／計画／実装と check／develop:review の呼び出し／最終照合と永続化／停止と再開／完了の条件（PR-DEVELOPIMPLEMENT-001〜078／78 件） |
| `docs/requirements/develop-plugin.md` | 要求文書: develop plugin 全体と利用側リポジトリとの契約 | 構成と呼び出し／利用側リポジトリとの契約／権限と残る危険／文脈の配達／停止と再開／取得した内容の記録／つまずきの記録と改善／費用と記録／形の判定／永続化と投稿の順序／移行と旧スキルの廃止（PR-DEVELOPPLUGIN-001〜085、欠番は 016／84 件） |
| `docs/requirements/develop-review.md` | 要求文書: develop:review | 対象と目標／観点／focus／検証と資産台帳／返り値の契約／起動数の上限と再開／PR への投稿／git の外の対象（PR-DEVELOPREVIEW-001〜077／77 件） |
| `docs/requirements/formal-methods.md` | 要求文書: formal-methods | 位置づけ／2 つの機能／人の入力／原則と文書の一般規約の写し／機械で確かめる原則／best-practices の形／入口／軽い検査／単位／並列／階層／2 つの軸／継ぎ目／循環／費用の 2 段／手法と道具／モデルの作成と忠実さ／audit が確かめる中身／欠けの帰属と返し方／範囲と限界の記録／性質の洗い出し／失敗・停止・完了／続きからの起動／停止の表と完了／このスキル自身への適用（開発時）（PR-FORMALMETHODS-001〜333、欠番は 010・015・047・049・065・169・171・194・220・221 ほか 1 件／322 件） |
| `docs/requirements/requester.md` | 要求文書: 依頼者から見た振る舞い | 判定に迷う場合の共通の扱い／起動と対象の見極め／問いかけと回答／仕様書だけを作成する実行／中断点での待ち方／保存の判断と事後報告／保存と持ち帰り／根拠として読み取る範囲／検査と改稿の結果／実行環境と中断（PR-REQUESTER-001〜079、欠番は 002・004・006・010・016・019・027・028・030／70 件） |

## 要求一覧

| ID | 見出し | 所在文書 |
|---|---|---|
| PR-BPDESIGNEDSKILL-051 | 硬い層へ置けない理由の記録 | `docs/requirements/bp-designed-skill.md` |
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
| PR-CONSUMER-033 | 裁定の下っていない論点の書き方 | `docs/requirements/consumer.md` |
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
| PR-FORMALMETHODS-001 | 単独でも呼び出しでも同じ形で動く | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-002 | 他のスキルを呼ばない | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-003 | 書き換えてよい範囲 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-004 | 作業場所の位置 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-005 | 記録台帳の置き場 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-296 | 記録台帳への書き込みを並べる | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-006 | 下流で上流の穴を埋めない | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-302 | 原則の出所に定めが無い欠けの差し戻し先 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-007 | 作る機能と audit | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-008 | 確かめる中身の正本を 1 つにする | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-009 | 機能を入力から決める | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-011 | 人の答えを待たない | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-012 | needs_input を使わない | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-013 | 判断が要るものは欠けとして返す | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-014 | 自分の判断は既定値の表で決める | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-016 | 入力の指定を優先する | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-293 | 有限範囲と抽象化を決める順 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-325 | 違う値を指すヒントが重なるとき | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-326 | 上書きされたヒントを返す | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-017 | 人の入力はヒントとしてだけ受ける | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-018 | ヒントを読む役 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-019 | ヒントが効く範囲 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-321 | 終えた step で決めた値に当たるヒント | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-020 | ヒントで止まらない | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-021 | 規則の出所は写し | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-022 | 規則の出所として docs/ を読まない | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-023 | 検査の材料は入力だけ | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-024 | 原則を言い換えて写さない | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-025 | 正本を節名で参照する | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-026 | 写しは正本の commit から作る | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-027 | 写しの中身の一致を確かめる | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-028 | 写しの版の一致を確かめる | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-029 | 機械で確かめる原則を満たす | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-297 | 既存のテストを性質に変換する | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-298 | 要求 ID と仕様 ID の網羅を確かめる | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-030 | 停止と再開 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-031 | 待たれる入力の原則に従わない | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-236 | 対象の欠けを直した後の起動 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-032 | 停止の種類 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-033 | BLOCKED の理由の区分 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-034 | 状態の書き込み | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-035 | run の記録 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-036 | 役ごとの agent のモデルと effort | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-037 | 起動数の上限 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-273 | 起動数の上限が入力に無いとき | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-038 | 生成と検証の役を分ける | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-310 | 欠けとして返す判定を反証させる | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-322 | 重大度を付ける | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-323 | 重大度を確かめる | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-324 | 低の欠けも返す | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-314 | 反証役が退けた判定を返さない | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-315 | 退けた判定を記録する | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-311 | 欠けなしの判定の偽陰性を測る | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-312 | 偽陰性の率を記録する | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-039 | 個別の確かめ方 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-040 | 司令塔は中身を書かない | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-041 | 入口の step | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-195 | 続きから起動した run で続ける step を入口で決める | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-042 | 文書の層を入力で受ける | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-281 | 上流の文書の種別を入力で受ける | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-300 | 作られた物を入力で受ける | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-043 | 入力の拒否 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-044 | 上の文書の層が無いとき | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-045 | 単位を切る材料の差し込み口 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-046 | 仕様の層で作る機能が回す検査 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-237 | 要求と仕様の層で作る機能が回す重い検査 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-228 | 要求の層で作る機能が回す検査 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-223 | 仕様の層で audit が回す確かめ | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-227 | 要求の層で audit が回す確かめ | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-224 | 仕様の層の単位を切る材料 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-225 | 仕様の層の単位の切り方 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-226 | 仕様の層で縦を回す | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-048 | 文書の層と検査の表 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-291 | 文書の層と検査の表の転記 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-292 | 表の転記の一致を確かめる | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-050 | 軽い検査を先に毎回回す | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-051 | 規範文を組に分解する | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-196 | 組の要素に行範囲を添える | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-052 | 組の要素を言い換えない | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-053 | 組を 1 つの抽出だけで確定させない | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-054 | 抽出の食い違いを別の検証役が決める | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-055 | 上流の原則を展開する | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-274 | 展開した本文の先の参照 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-056 | 展開できない参照 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-235 | 仕様の層では上流の要求文書を展開した参照先だけ組にする | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-057 | 用語に結びつける | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-058 | 結びつけられない語を返す | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-059 | 組の対象を実体まで具体化する | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-275 | 実体を持たない組の対象 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-276 | 具体化の結果を持つ欄 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-060 | 実体の同一性 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-061 | 型に照らす | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-277 | 確定しなかった組 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-062 | 表として無い判定の表 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-197 | 組み立てた判定の表を確かめる | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-063 | 検証役が退けたとき | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-064 | 保持規則の組 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-198 | 保持規則の組を両方の値で照らす | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-066 | 単位を前提にした確かめの範囲 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-067 | 検査対象の状態の持ち主で区切る | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-199 | 単位に持たせるもの | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-068 | 要求の層の単位の切り方 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-278 | 状態を変える主体の無い組 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-069 | 節で区切らない | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-070 | 根の単位 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-200 | 根の単位に継ぎ目を持たせる | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-071 | 要求の層の契約 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-072 | 仕様の層の契約 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-201 | 単位の契約の表と式を照らす | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-073 | 単位を切った後に照らす型 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-239 | 停止・再開・拒否の種類が無いとき | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-074 | 外の主体の契約を仮定にする | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-075 | 示せない外の契約を欠けにする | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-076 | 書き手を並べる仕組み | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-077 | 並べる仕組みがあるとき | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-202 | 並列を交ざり方として確かめる | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-078 | 並べる仕組みが無いとき | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-203 | 並べる仕組みが無いことを返す | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-305 | 外の契約が同時の書き込みを除くとき | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-079 | 下の単位を単位の契約だけで扱う | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-080 | 階層の深さを決め打ちしない | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-081 | 使う関係を階層に乗せる | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-204 | 作る関係を別の木にする | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-255 | 作る関係を縦の検査で確かめる | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-283 | 作られた物が入力に無いとき | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-082 | 横と縦を分けて確かめる | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-205 | 縦の検査の始まり | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-083 | 縦の対応を表で結ぶ | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-306 | トレーサビリティ表が無いとき | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-084 | 結べない縦の対応 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-206 | 補った縦の対応を確かめる | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-085 | 表の欠けを返す | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-086 | 横の継ぎ目を機械で拾う | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-087 | 参照の連鎖と名前だけの転記を拾わない | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-284 | 継ぎ目にする組の対象の同一性 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-301 | 継ぎ目として拾わなかった組 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-088 | 横の継ぎ目を単位の契約で確かめる | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-309 | 読むだけの単位どうしの継ぎ目 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-089 | 縦の継ぎ目を詳細化で確かめる | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-282 | 重い検査を行わない run の継ぎ目と並列 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-299 | 重い検査を行わない run の縦の継ぎ目 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-090 | 継ぎ目の持ち主 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-091 | 全体の保証に読み替えない | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-092 | 終端条件のある循環 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-319 | 分けたまま確かめる循環の単位の置き場 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-093 | 終端条件を確かめられない循環 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-094 | 終端条件を確かめられないことを欠けにしない | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-095 | 終わらない経路 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-096 | 重い検査は要求が安定してから | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-240 | 要求が安定していないときは重い検査を行わない | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-097 | 重い検査の要否の指定 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-098 | 保留を記録する | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-241 | 保留にした候補を名指しする | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-099 | 保留のまま完了してよい | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-100 | 安定の判定 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-101 | 着手不能の未確定事項を数える文書 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-102 | 着手不能の未確定事項の読み方 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-103 | .tbd.json が無いとき | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-104 | 重い検査の範囲を費用で決める | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-242 | 要と指定された重い検査の候補を費用で外さない | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-207 | 費用の比べた結果を記録する | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-243 | 費用で一部の候補を外したとき | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-244 | 費用で全ての候補を外したとき | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-105 | 向かない部分を黙って外さない | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-188 | 重い検査は単位を前提にする | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-245 | 単位を切らない全体のモデルで重い検査を回さない | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-189 | 下流への依存の広がりで優先づける | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-106 | 手法を性質の種別から引く | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-285 | 指定された手法の道具 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-333 | TLC か Alloy の指定と合わない性質の種別 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-208 | 引いた手法の表の行を記録する | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-107 | Alloy は指定されたときだけ | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-286 | audit の道具 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-108 | プログラムの契約と定理の性質の道具 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-331 | コードの層の道具を選ぶ | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-327 | 全数列挙は重い検査に依らない | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-328 | 証明の未完了の印を合格にしない | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-329 | 証明の道具に変異と witness を課さない | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-330 | 証明の道具に有限範囲を当てない | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-332 | 道具の実行環境が無いとき | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-109 | 道具を固定した版で取得する | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-110 | 道具を照合してから使う | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-111 | 道具を用意できないとき | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-112 | 許可が無いとき | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-113 | 文書から生成してから抽象化する | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-114 | 手で写した部分を記録する | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-115 | 丸めたものを記録する | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-116 | 有限範囲の切り方と根拠 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-209 | 届かない境界値を記録する | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-117 | 前提と公平性を宣言する | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-269 | 範囲と限界の記録からモデルを引く | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-118 | 環境の行動を自動と仮定しない | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-119 | 対応表を作る | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-210 | 対応表の全行を割り当てる | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-120 | 節の固定を作る | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-121 | 起動の途中で入力が変わったとき | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-264 | 入力の指紋を step ごとに照らす | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-294 | 照らす時点の間に戻った入力 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-256 | 入力が変わって止まった step をやり直す | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-271 | やり直す step で累計を戻さない | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-122 | 忠実さの層ごとに写したかを宣言する | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-123 | 写した忠実さの層の間を照らす | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-124 | 状態の投影を導出する | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-211 | 投影を検査対象の図と照合する | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-279 | 状態の図が無いとき | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-125 | 列挙の欠落は機械で見つからないと記録する | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-126 | 検査を再実行できる形で残す | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-190 | 遷移から転記した条件を要求側の性質と二重にする | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-257 | 遷移から転記した条件が独立した仕様でないことを明示する | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-127 | 変異と witness を持つ | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-128 | 反例の有無は検査器の出力で数える | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-129 | 空振り | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-130 | 忠実さ | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-212 | 緩いモデルと強いモデルを欠けにする | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-131 | 忠実さの層の抜け | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-132 | モデルが足した制約 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-213 | 足した制約を外して確かめる | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-317 | 外して出た反例の扱い | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-318 | 外して反例が出た制約の帰属 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-268 | 外しても反例が出ない制約 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-133 | 節の固定があること | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-214 | 節の固定が落ちることを確かめる | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-215 | 再実行で同じ結果になることを確かめる | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-134 | 有限範囲 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-216 | 届かない定数を欠けにする | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-135 | 生成と手で写すことの境目 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-217 | 手で写した記録の無い箇所を欠けにする | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-136 | 他の作り手のモデルに当てる | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-280 | 構成要素の欠けたモデル | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-137 | audit の返し方 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-138 | 欠けの返し方 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-267 | 確かめた結果を欠けにする | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-139 | 反例と差し戻し先 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-140 | 欠けを位置で帰属させる | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-246 | 帰属の規則が重なるとき | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-313 | モデルの欠けの帰属を当てる順に入れない | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-141 | モデルの欠けの帰属 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-142 | 2 つの層にまたがる根拠 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-143 | 上流に定めが無い欠け | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-261 | 上流に定めが無い欠けの位置 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-144 | 帰属が決まらない欠け | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-218 | 帰属が決まらない欠けをあいまいとする | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-262 | あいまいな欠けの帰属先 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-233 | 性質の違反を返す | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-287 | 作る機能の反例を対応表で照らす | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-288 | モデルが外れた反例 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-307 | audit の反例を対応表で照らす | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-308 | audit でモデルが外れた反例 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-316 | 対応表の行の無い反例 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-145 | 確かめた範囲と結果を記録する | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-146 | 対象外を名指しで列挙する | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-147 | 範囲と限界の記録の置き場 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-320 | 範囲と限界の記録を置き換える | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-148 | 範囲と限界の記録を返す | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-149 | 状態に書かずに止まる run の返り値 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-150 | 状態に書かずに止まる run は記録を作らない | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-151 | 性質の洗い出しの走査元 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-152 | 作る機能が欠けで止まる | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-153 | audit が欠けで止まる | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-154 | 起動数の上限で step を終えられないとき | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-155 | 1 件も始められない上限 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-156 | 起動数の上限と試行の上限が同時に当たるとき | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-157 | モデルの欠けを run の中で直す | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-158 | 一時的な失敗の再試行 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-159 | 試行の回数を持ち越す | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-258 | 試行の上限を累計に当てる | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-160 | 続きから起動した run で試行の上限の項目を未着手に戻す | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-247 | 戻した項目を 1 回は試す | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-161 | 収束しない判定は run の中のモデルの修正に限る | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-162 | 収束の判定の幅 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-265 | モデルの修正の回の結果を持ち越す | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-266 | 収束の判定を run をまたいだ累計で行う | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-163 | 収束しないとき | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-164 | 規則の散在 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-270 | 数えた散在を状態に書く | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-219 | 規則の散在を返す | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-165 | モデルの修正の回の上限 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-166 | モデルの修正の回数を持ち越す | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-167 | 続きから起動した run で修正の回を 1 回は行う | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-290 | 散在なしで止まった状態から修正の回を 1 回は行う | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-168 | 状態に起動の同一性と結果を書く | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-289 | 直した欠けに印を付ける | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-170 | 起動の同一性が同じで完了していないとき | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-248 | 再利用した step を数える | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-172 | run をまたぐ収束の判定（保持規則） | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-173 | 保持規則に当たらないもの | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-191 | 修正と再検証を同じ run で行わない | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-192 | 完了した状態を同じ起動で起動したとき | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-193 | 完了していない状態の続きから始める | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-229 | 状態が無いときは新しい状態から始める | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-249 | 違う起動の状態から引き継がない | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-230 | 続きからの起動のヒント | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-272 | ヒントの既読 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-295 | 読まれないまま終わるヒント | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-303 | 受け付けない値のヒント | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-304 | 使わなかったヒントを返す | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-250 | ヒントのために終えた step をやり直さない | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-231 | 前の結果を返す状態を同じ起動で起動したとき | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-234 | 前の結果を返す状態へのヒントを拒む | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-174 | 書いてよい先に書けないとき | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-175 | 停止ごとに残すもの | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-176 | 返り値の並びと形 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-177 | 当てる順 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-232 | 停止の行が重なるとき | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-251 | 対象の欠けの行を先に当てる | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-259 | 入力が変わった run を先に当てる | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-252 | 失敗の行を反復の上限より先に当てる | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-253 | 保存の失敗がほかの行と重なるとき | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-263 | 保存できなかった範囲と理由を合わせて返す | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-260 | 失敗の行を記録の保存の失敗の行より先に当てる | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-254 | 完了の行を当てる条件 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-178 | 作る機能の完了 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-179 | 重い検査の対象が無い場合 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-180 | audit の完了 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-181 | 自分の要求文書に軽い検査を当てる | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-182 | 安定したら重い検査を当てる | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-183 | 自身のモデルの置き場 | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-184 | 自身の性質を仕分ける | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-185 | 形式化できるものを機械で確かめる | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-186 | 形式化できないものを PR のレビューで確かめる | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-222 | PR のレビューの方法と結果を残す | `docs/requirements/formal-methods.md` |
| PR-FORMALMETHODS-187 | 自身への適用の範囲を記録する | `docs/requirements/formal-methods.md` |
| PR-REQUESTER-037 | 判定に迷う場合に結論を定めない | `docs/requirements/requester.md` |
| PR-REQUESTER-040 | 判定に迷う場合に依頼者へ確認する | `docs/requirements/requester.md` |
| PR-REQUESTER-042 | 作成に入った後の確認を次の中断点の問いにする | `docs/requirements/requester.md` |
| PR-REQUESTER-078 | 次の中断点が無い確認を保持規則の対象にする | `docs/requirements/requester.md` |
| PR-REQUESTER-001 | 対象外の依頼で作成に入らない | `docs/requirements/requester.md` |
| PR-REQUESTER-069 | 空の依頼文と単語だけの依頼文で作成に入らない | `docs/requirements/requester.md` |
| PR-REQUESTER-070 | 空の依頼文と単語だけの依頼文では何の文書かを尋ねる | `docs/requirements/requester.md` |
| PR-REQUESTER-079 | 空の依頼文と単語だけの依頼文では尋ねた後に実行を終える | `docs/requirements/requester.md` |
| PR-REQUESTER-003 | 作成する文書の種別を依頼文の語から判定する | `docs/requirements/requester.md` |
| PR-REQUESTER-038 | 種別の判定に用いる語を足さない | `docs/requirements/requester.md` |
| PR-REQUESTER-033 | 所在が示されなければ新規作成として扱う | `docs/requirements/requester.md` |
| PR-REQUESTER-005 | 着手を止める論点を尋ねる | `docs/requirements/requester.md` |
| PR-REQUESTER-007 | 同じ論点を繰り返し尋ねない | `docs/requirements/requester.md` |
| PR-REQUESTER-008 | 「分からない」と答える権利 | `docs/requirements/requester.md` |
| PR-REQUESTER-029 | 決まっていない旨の回答を着手不能から外す | `docs/requirements/requester.md` |
| PR-REQUESTER-009 | 未回答の事項を推測で埋めない | `docs/requirements/requester.md` |
| PR-REQUESTER-048 | 回答の記録が欠けた問いを尋ね直す | `docs/requirements/requester.md` |
| PR-REQUESTER-049 | 空のまま渡された回答を尋ね直さない | `docs/requirements/requester.md` |
| PR-REQUESTER-050 | 検証に落ちた回答の反映を文書に書かない | `docs/requirements/requester.md` |
| PR-REQUESTER-073 | 検証に落ちた回答の反映を差し戻す | `docs/requirements/requester.md` |
| PR-REQUESTER-074 | 差し戻しても検証に落ちる回答の論点を問いに戻す | `docs/requirements/requester.md` |
| PR-REQUESTER-051 | 修正後も検証に落ちる裁定・問い・保持規則で止まる | `docs/requirements/requester.md` |
| PR-REQUESTER-071 | 確定した事項と食い違う回答を確認の問いにする | `docs/requirements/requester.md` |
| PR-REQUESTER-072 | どの論点にも当たらない回答と保留の事項への回答を問いとして聞き直す | `docs/requirements/requester.md` |
| PR-REQUESTER-045 | 仕様書だけを作成する実行で上流の論点を尋ねない | `docs/requirements/requester.md` |
| PR-REQUESTER-046 | 上流の論点が見つかった仕様書の作成を完了しない | `docs/requirements/requester.md` |
| PR-REQUESTER-075 | 上流の論点で止めた実行を最初からやり直させる | `docs/requirements/requester.md` |
| PR-REQUESTER-047 | 要求文書の改訂が先に要ることを示す | `docs/requirements/requester.md` |
| PR-REQUESTER-043 | 応答の無い中断点を時間で打ち切らない | `docs/requirements/requester.md` |
| PR-REQUESTER-044 | 中断点から後で続けられるようにする | `docs/requirements/requester.md` |
| PR-REQUESTER-052 | 元に戻せる保存先へは承認を待たずに保存する | `docs/requirements/requester.md` |
| PR-REQUESTER-053 | 元に戻せない保存と不変のものに触れる保存は承認を得てから行う | `docs/requirements/requester.md` |
| PR-REQUESTER-011 | 書き込んだ先を示す | `docs/requirements/requester.md` |
| PR-REQUESTER-012 | 書き込んだ内容を示す | `docs/requirements/requester.md` |
| PR-REQUESTER-013 | 承認の意思の有無を定型の語句で判定しない | `docs/requirements/requester.md` |
| PR-REQUESTER-014 | 開いている未確定事項が残る文書を完成と示さない | `docs/requirements/requester.md` |
| PR-REQUESTER-054 | 残っている未確定事項の件数と識別子を示す | `docs/requirements/requester.md` |
| PR-REQUESTER-015 | 着手を止める未確定事項の内容を依頼者へ示す | `docs/requirements/requester.md` |
| PR-REQUESTER-055 | 上限の後に決まらない論点を保持規則にする | `docs/requirements/requester.md` |
| PR-REQUESTER-056 | 保持規則の裁定を求める Issue の文案を示す | `docs/requirements/requester.md` |
| PR-REQUESTER-057 | 承認を得ずに Issue を起票しない | `docs/requirements/requester.md` |
| PR-REQUESTER-076 | 承認された Issue の文案を書き換えずに起票する | `docs/requirements/requester.md` |
| PR-REQUESTER-077 | 起票した Issue の番号を示す | `docs/requirements/requester.md` |
| PR-REQUESTER-017 | 上書きであることを示す | `docs/requirements/requester.md` |
| PR-REQUESTER-036 | 新規作成の同名衝突では保存しない | `docs/requirements/requester.md` |
| PR-REQUESTER-039 | 新規作成の同名衝突では差分を示して指示を求める | `docs/requirements/requester.md` |
| PR-REQUESTER-064 | 最後に検査した文書と違う文書を保存しない | `docs/requirements/requester.md` |
| PR-REQUESTER-065 | 保存の直前の食い違いを示す | `docs/requirements/requester.md` |
| PR-REQUESTER-018 | 中間の生成物を対象リポジトリに残さない | `docs/requirements/requester.md` |
| PR-REQUESTER-031 | 中間の生成物を依頼者のホームディレクトリの配下に置く | `docs/requirements/requester.md` |
| PR-REQUESTER-020 | 依頼文・回答・所在を示された文書以外を要求の根拠にしない | `docs/requirements/requester.md` |
| PR-REQUESTER-021 | 対象リポジトリの実装を読み取らない | `docs/requirements/requester.md` |
| PR-REQUESTER-022 | 所在を示された既存文書は読み取る | `docs/requirements/requester.md` |
| PR-REQUESTER-062 | 所在を示された文書を読み取れなければ作成に入らない | `docs/requirements/requester.md` |
| PR-REQUESTER-063 | 読み取れなかった文書の所在を示す | `docs/requirements/requester.md` |
| PR-REQUESTER-032 | 所在を示されていない文書を走査で探し出さない | `docs/requirements/requester.md` |
| PR-REQUESTER-035 | 所在を示されていない文書を読み取らない | `docs/requirements/requester.md` |
| PR-REQUESTER-058 | 改稿を必須とする指摘が残れば完了しない | `docs/requirements/requester.md` |
| PR-REQUESTER-059 | 検査の結果を得ないまま完了しない | `docs/requirements/requester.md` |
| PR-REQUESTER-068 | 実施しなかった検査と残った指摘を区別して示す | `docs/requirements/requester.md` |
| PR-REQUESTER-066 | 申告の外の書き換えを示す | `docs/requirements/requester.md` |
| PR-REQUESTER-067 | 申告の外の書き換えを検査せずに残さない | `docs/requirements/requester.md` |
| PR-REQUESTER-023 | 実行基盤が要件を満たすかを起動時に確認する | `docs/requirements/requester.md` |
| PR-REQUESTER-041 | 非対応の環境で作成に入らない | `docs/requirements/requester.md` |
| PR-REQUESTER-024 | 非対応の環境であることを示す | `docs/requirements/requester.md` |
| PR-REQUESTER-034 | 上限を超えて実行を継続しない | `docs/requirements/requester.md` |
| PR-REQUESTER-025 | 未完成の文書を成果物として保存しない | `docs/requirements/requester.md` |
| PR-REQUESTER-026 | 中断したことを依頼者へ示す | `docs/requirements/requester.md` |
| PR-REQUESTER-060 | 下位 agent の結果を得られずに止めた実行を途中から続けられるようにする | `docs/requirements/requester.md` |
| PR-REQUESTER-061 | 途中から実行し直せるかを示す | `docs/requirements/requester.md` |

## 関連する仕様文書

| 要求文書 | 対応する仕様文書 |
|---|---|
| `docs/requirements/bp-designed-skill.md` | `docs/specifications/bp-authoring.md` / `docs/specifications/bp-conformance.md` / `docs/specifications/bp-entry.md` / `docs/specifications/bp-findings.md` / `docs/specifications/bp-inspection.md` / `docs/specifications/bp-run.md` |
| `docs/requirements/bp-operations.md` | `docs/specifications/bp-authoring.md` / `docs/specifications/bp-conformance.md` / `docs/specifications/bp-entry.md` / `docs/specifications/bp-findings.md` / `docs/specifications/bp-inspection.md` / `docs/specifications/bp-run.md` |
| `docs/requirements/cleanup.md` | （対応する仕様文書なし） |
| `docs/requirements/consumer.md` | `docs/specifications/authoring.md` / `docs/specifications/elicitation.md` / `docs/specifications/flow.md` / `docs/specifications/verification.md` |
| `docs/requirements/develop-address-review.md` | （対応する仕様文書なし） |
| `docs/requirements/develop-implement.md` | （対応する仕様文書なし） |
| `docs/requirements/develop-plugin.md` | （対応する仕様文書なし） |
| `docs/requirements/develop-review.md` | （対応する仕様文書なし） |
| `docs/requirements/formal-methods.md` | `docs/specifications/formal-methods.md` |
| `docs/requirements/requester.md` | `docs/specifications/authoring.md` / `docs/specifications/elicitation.md` / `docs/specifications/flow.md` / `docs/specifications/verification.md` |

## 未解決（着手を止める未確定事項）

| ID | 内容 | 所在 |
|---|---|---|
| TBD-RCONSUMER-003 | 状態を持つ対象とみなす範囲と、その対象の振る舞いが定義されていると判定する条件（PR-CONSUMER-008 に関係する） | `docs/requirements/consumer.md` |
| TBD-RCONSUMER-008 | 生成文書の記述が文書外の知識に依存していると判定する境界（PR-CONSUMER-026 に関係する） | `docs/requirements/consumer.md` |
| TBD-RCONSUMER-010 | 仕様書が「実装が一意に決まる水準」に達したと判定する基準（PR-CONSUMER-031 に関係する） | `docs/requirements/consumer.md` |
| TBD-RREQUESTER-016 | 中間の生成物を置くフォルダの名前となる案件名が、何によって決まるかが決まっていない（PR-REQUESTER-031 に関係する） | `docs/requirements/requester.md` |

## 検査結果

- ID の重複: 0 件
- 実現する仕様項目が無い要求: 418 件
