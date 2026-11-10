// 人向けの表示 report.md を、結果の構造の欄だけから導く（SP-FORMALMETHOD-003、AC-21）。
// 成功の語は、その性質の verdict の欄にあるときだけ書く。
export function renderReport(result) {
  const lines = ['# formal-method の結果', '', `状態: ${result.status}`, ''];
  lines.push('## 性質', '');
  if (result.properties.length === 0) lines.push('（必要な性質は無い）');
  for (const p of result.properties) lines.push(`- ${p.id}: ${p.verdict.join('・')}（検査 ${p.check_ids.length} 件、検出能力 ${p.detection.status}）`);
  lines.push('', '## 検査', '');
  for (const c of result.checks) lines.push(`- ${c.id}（${c.kind}）: ${c.verdict}`);
  if (result.stop_report) {
    lines.push('', '## 停止の報告', '', `段: ${result.stop_report.stage}`);
    for (const r of result.stop_report.reasons) lines.push(`- ${r.code}（${r.stage}）`);
  }
  if (result.questions.length) {
    lines.push('', '## 回答を待つ問い', '');
    for (const q of result.questions) lines.push(`- ${q.id}: ${q.missing_decision}`);
  }
  lines.push('');
  return lines.join('\n');
}
