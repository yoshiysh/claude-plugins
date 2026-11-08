// AC ごとのケース計画（testing.md「ケースの設計」、verification-plan「T が作るもの」）。
// 形は traceability.config.json の scenarios と同じ: normal・recovery（準正常）・error（異常）・boundary。
// 各観点は、ケースの配列（id は テストのファイルと名前の手掛かり）か { notApplicable: 理由 }。
// layer: 'auto' は自動テストの完了に数え、'eval'・'inspection' は証拠として扱い自動テストの完了に数えない。
export const CASE_PLAN = {
  'AC-01': {
    normal: [{ id: 'cli-pipeline:同じ依頼を2回', layer: 'auto' }, { id: 'evals:1,2 人と別のスキルの依頼', layer: 'eval' }],
    recovery: { notApplicable: '依頼の正規化に部分成功・再試行の経路が無い' },
    error: [{ id: 'cli-pipeline:範囲から除外した目標', layer: 'auto' }],
    boundary: [{ id: 'cli-pipeline:revision を添えない版は null', layer: 'auto' }],
  },
  'AC-02': {
    normal: [{ id: 'evals:3 既知の性質の一覧', layer: 'eval' }],
    recovery: [{ id: 'cli-pipeline:extraction_coverage（complete の true と false）', layer: 'auto' }],
    error: [{ id: 'cli-scope:読めないファイル', layer: 'auto' }],
    boundary: [{ id: 'cli-scope:バイナリ（NUL・UTF-8 でない）', layer: 'auto' }, { id: 'cli-scope:集まりの中の symbolic link', layer: 'auto' }],
  },
  'AC-03': {
    normal: [{ id: 'cli-pipeline:状態×出来事の 3 区分', layer: 'auto' }],
    recovery: { notApplicable: '組合せの区分は決定的で、再試行の経路を持たない' },
    error: [{ id: 'cli-pipeline:対応できていない組合せで完了にならない', layer: 'auto' }, { id: 'evals:1', layer: 'eval' }],
    boundary: [{ id: 'cli-pipeline:図とモデルの独立の突き合わせ', layer: 'auto' }],
  },
  'AC-04': {
    normal: [{ id: 'cli-pipeline:意味の確認の記録', layer: 'auto' }, { id: 'evals:4', layer: 'eval' }],
    recovery: { notApplicable: '意味の確認の再試行は契約に無い（依頼者の決定 1: 同じ run で再試行しない）' },
    error: [{ id: 'cli-pipeline:AC-14 未確認（忠実さの確認が成り立たない）', layer: 'auto' }, { id: 'inspection:人がモデルと要求を読む', layer: 'inspection' }],
    boundary: [{ id: 'cli-pipeline:保証の境界', layer: 'auto' }],
  },
  'AC-05': {
    normal: [{ id: 'cli-pipeline:候補に Rust と Z3', layer: 'auto' }],
    recovery: { notApplicable: '道具の失敗を再試行しない（依頼者の決定 1）' },
    error: [{ id: 'cli-pipeline:道具を除く・異常終了・メモリ不足・構文の誤り・読めない出力', layer: 'auto' }],
    boundary: [{ id: 'cli-pipeline:答えとしての unknown・道具自身の時間の上限・-T を超える遅れ', layer: 'auto' }],
  },
  'AC-06': {
    normal: [{ id: 'cli-pipeline:グラフの箇所の照合', layer: 'auto' }, { id: 'cli-pipeline:分割しなかった結果', layer: 'auto' }, { id: 'evals:5', layer: 'eval' }],
    recovery: { notApplicable: 'グラフの導出は決定的' },
    error: [{ id: 'cli-pipeline:依存グラフの導出の規則での導き直しと writer-merge-scc/1 の当て直し（正準）', layer: 'auto' }],
    boundary: [{ id: 'cli-pipeline:書き手の違う 2 組で候補が 2 つ', layer: 'auto' }, { id: 'decomposition-check:導出の規則と手順の自己検査', layer: 'auto' }],
  },
  'AC-07': {
    normal: [{ id: 'cli-pipeline:分割作成役が同じ候補を受け取る', layer: 'auto' }],
    recovery: { notApplicable: '合成の条件の再試行は契約に無い（依頼者の決定 1）' },
    error: [{ id: 'cli-pipeline:確認できない前提の分割で検証済みにならない', layer: 'auto' }],
    boundary: [{ id: 'cli-pipeline:分割前の要素（規則の id）が対応・対応なし・除外のちょうど 1 つ、跨ぐ辺ごとに境界', layer: 'auto' }],
  },
  'AC-08': {
    normal: [{ id: 'cli-pipeline:要求の不足と問い', layer: 'auto' }, { id: 'cli-pipeline:対象が性質を満たさない', layer: 'auto' }, { id: 'evals:6,7', layer: 'eval' }],
    recovery: { notApplicable: '回答の後の再開は契約に無い' },
    error: [{ id: 'inspection:形式モデルの欠陥・分類処理の欠陥の根拠を読む', layer: 'inspection' }],
    boundary: { notApplicable: '原因の 5 区分は担当の判断で、境界の値を持たない' },
  },
  'AC-09': {
    normal: [{ id: 'cli-pipeline:4 性質の判定', layer: 'auto' }, { id: 'verdict-oracle:照合1・2', layer: 'auto' }],
    recovery: [{ id: 'cli-pipeline:独立な検査は最後まで動く（D1）', layer: 'auto' }],
    error: [{ id: 'cli-pipeline:常に成功を返す道具', layer: 'auto' }],
    boundary: [{ id: 'verdict-oracle:End の全 360 通り', layer: 'auto' }, { id: 'cli-pipeline:外からの照合', layer: 'auto' }],
  },
  'AC-10': {
    normal: [{ id: 'cli-recovery:ps の標本で同時に複数', layer: 'auto' }],
    recovery: [{ id: 'cli-recovery:時間の上限で止め、完了と未完了の範囲', layer: 'auto' }],
    error: [{ id: 'cli-recovery:時間の上限の後に始めない', layer: 'auto' }, { id: 'cli-pipeline:時間の上限 1 秒', layer: 'auto' }],
    boundary: [{ id: 'cli-pipeline:検査ごとの記録と内部の上限', layer: 'auto' }],
  },
  'AC-12': {
    normal: [{ id: 'cli-intake:CI の有無で location が分かれる', layer: 'auto' }],
    recovery: { notApplicable: '性能の記録に再試行の経路が無い（retries は 0）' },
    error: [{ id: 'cli-pipeline:見積りが取れない値を 0 にしない', layer: 'auto' }],
    boundary: [{ id: 'cli-pipeline:一致する比較と一致しない比較', layer: 'auto' }],
  },
  'AC-13': {
    normal: [{ id: 'cli-pipeline:完了の run の記録と台帳', layer: 'auto' }],
    recovery: [{ id: 'cli-recovery:途中の段で書込み不可', layer: 'auto' }, { id: 'cli-recovery:status.json の書込みの失敗', layer: 'auto' }, { id: 'cli-recovery:salvage.mark を I/O で書けない（R\' を返す）', layer: 'auto' }, { id: 'cli-client・cli-recovery:壊れた status.json', layer: 'auto' }, { id: 'cli-recovery:公開の負けと result.json 1 つ', layer: 'auto' }],
    error: [{ id: 'cli-intake:保存先の root が書込み不可', layer: 'auto' }],
    boundary: [{ id: 'cli-intake:.formal-method/ 自体を作れない', layer: 'auto' }],
  },
  'AC-14': {
    normal: [{ id: 'cli-pipeline:全て成り立つときだけ完了', layer: 'auto' }, { id: 'verdict-spec:decideStatus', layer: 'auto' }],
    recovery: { notApplicable: '完了の判定は集約の段の決定的な処理' },
    error: [{ id: 'cli-pipeline:1 つずつ残すと停止', layer: 'auto' }],
    boundary: [{ id: 'cli-pipeline:必要な性質が 0 件・検出能力未確認', layer: 'auto' }, { id: 'verdict-oracle:Q10 群', layer: 'auto' }],
  },
  'AC-15': {
    normal: [{ id: 'cli-scope:集まりの規則', layer: 'auto' }],
    recovery: [{ id: 'cli-scope:未知のキーは拒まず unverified', layer: 'auto' }],
    error: [{ id: 'cli-intake:受け付けない依頼（9 の code）', layer: 'auto' }, { id: 'cli-intake:秘密値の型', layer: 'auto' }],
    boundary: [{ id: 'cli-scope:時間の上限 1・一致する指紋・深い .formal-method', layer: 'auto' }, { id: 'cli-intake:秘密値の型に無い形', layer: 'auto' }],
  },
  'AC-19': {
    normal: [{ id: 'cli-pipeline:段の分かっている処理の失敗', layer: 'auto' }],
    recovery: [{ id: 'cli-recovery:salvage の 処理の中断', layer: 'auto' }],
    error: [{ id: 'cli-pipeline:担当の失敗（返り値が無い・形が違う・cannot_proceed）× 抽出・モデル・計画', layer: 'auto' }],
    boundary: [{ id: 'cli-pipeline:道具が無い（計画）・実行失敗（実行）・集約の条件だけ', layer: 'auto' }, { id: 'decomposition-check:停止の段の規則の自己検査', layer: 'auto' }, { id: 'cli-recovery:集約の段で公開できない（保存の失敗 は 集約）', layer: 'auto' }],
  },
  'AC-21': {
    normal: [{ id: 'cli-pipeline:完了の結果が schema に通る', layer: 'auto' }],
    recovery: { notApplicable: '結果の形に回復の経路が無い' },
    error: [{ id: 'cli-pipeline:report.md の成功の語', layer: 'auto' }],
    boundary: [{ id: 'cli-intake:受付の停止の結果も schema に通る', layer: 'auto' }],
  },
};
