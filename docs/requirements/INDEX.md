# docs/requirements 目次

この INDEX は doc_check が文書から導出したものである。本体を直したら導出し直す（手書きしない）。

## 文書一覧

| パス | 扱う関心事 | どういう要求が書かれているか |
|---|---|---|
| `docs/requirements/bp-designed-skill.md` | 要求文書: create・update が作るスキルが備える性質 | 形の判定／形に関わる原則／配布先での確認（PR-BPDESIGNEDSKILL-001〜023／23 件） |
| `docs/requirements/bp-operations.md` | 要求文書: best-practices の 4 機能（create・review・update・audit） | 機能の振り分け／create／update／create と update に共通／review／audit／review と audit に共通（PR-BPOPERATIONS-001〜050／50 件） |
| `docs/requirements/cleanup.md` | 要求文書: cleanup-branches | 守るもの／取り込み済みの判定／状態の取得／取り込み済みの削除／判断が要る対象の問い／承認された対象の削除／作業状態／作業場所の同期／後処理／退避した変更の復帰／完了報告（PR-CLEANUP-001〜081、欠番は 031・034・035・038・039・072・079／74 件） |
| `docs/requirements/consumer.md` | 後続作業者にとっての要求 | 引き渡しの完了条件／後続作業を戻りなく進めるための要求／後続作業を不具合なく進めるための要求／後続作業を精度高く進めるための要求／後続作業を迷いなく進めるための要求／後続作業をぶれずに進めるための要求／読み手が AI であることに由来する要求／分量の決まり方（PR-CONSUMER-001〜031、欠番は 014・016／29 件） |
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
| PR-BPDESIGNEDSKILL-010 | 権限 | `docs/requirements/bp-designed-skill.md` |
| PR-BPDESIGNEDSKILL-011 | 探索グラフ | `docs/requirements/bp-designed-skill.md` |
| PR-BPDESIGNEDSKILL-012 | 状態の書き込み | `docs/requirements/bp-designed-skill.md` |
| PR-BPDESIGNEDSKILL-013 | 資産台帳の原則 | `docs/requirements/bp-designed-skill.md` |
| PR-BPDESIGNEDSKILL-014 | 役ごとの制限の実効性の確認 | `docs/requirements/bp-designed-skill.md` |
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
| `docs/requirements/requester.md` | `docs/specifications/authoring.md` / `docs/specifications/elicitation.md` / `docs/specifications/flow.md` / `docs/specifications/verification.md` |

## 未解決（着手を止める未確定事項）

| ID | 内容 | 所在 |
|---|---|---|
| TBD-RCONSUMER-003 | 状態を持つ対象とみなす範囲と、その対象の振る舞いが定義されていると判定する条件（PR-CONSUMER-008 に関係する） | `docs/requirements/consumer.md` |
| TBD-RCONSUMER-007 | 引き渡す文書に、実施した検査と実施していない検査の区別を載せるかどうか。載せる場合の対象とする検査の集合と、未実施の検査を指摘 0 件の検査と区別する表記も決まっていない | `docs/requirements/consumer.md` |
| TBD-RCONSUMER-008 | 生成文書の記述が文書外の知識に依存していると判定する境界（PR-CONSUMER-026 に関係する） | `docs/requirements/consumer.md` |
| TBD-RCONSUMER-010 | 仕様書が「実装が一意に決まる水準」に達したと判定する基準（PR-CONSUMER-031 に関係する） | `docs/requirements/consumer.md` |
| TBD-RREQUESTER-016 | 中間の生成物を置くフォルダの名前となる案件名が、何によって決まるかが決まっていない（PR-REQUESTER-031 に関係する） | `docs/requirements/requester.md` |

## 検査結果

- ID の重複: 0 件
- 実現する仕様項目が無い要求: 77 件
