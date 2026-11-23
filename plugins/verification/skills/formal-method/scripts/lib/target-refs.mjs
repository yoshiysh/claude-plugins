// 対象のファイルの資料の ref（artifact-formats.md「担当に渡す資料」）。対象の写しを作らないので、担当に渡す対象のファイルは
// target:<target_id>/<FilePath> の ref で表し、path は受付で控えた元のファイルの絶対パスにする。他の ref は run の領域からの相対 path。
import { join } from 'node:path';
import { parseSpan } from './schemas.mjs';
import { linesOf } from './checks/common.mjs';

const PREFIX = 'target:';
export const targetRef = (targetId, file) => `${PREFIX}${targetId}/${file}`;

// target:<id>/<file> を { targetId, file } に分ける。対象の ref でなければ null。
export function parseTargetRef(ref) {
  if (typeof ref !== 'string' || !ref.startsWith(PREFIX)) return null;
  const rest = ref.slice(PREFIX.length);
  const i = rest.indexOf('/');
  if (i < 1 || i === rest.length - 1) return null;
  return { targetId: rest.slice(0, i), file: rest.slice(i + 1) };
}

// ref → 読む path。対象の ref は受付で控えたファイル（targets[].files[].abs）、無ければ null。他は run の領域の下。
export function refPathOf(runDir, targets) {
  return (ref) => {
    const t = parseTargetRef(ref);
    if (!t) return join(runDir, ref);
    const f = targets.find((x) => x.id === t.targetId)?.files.find((x) => x.path === t.file);
    return f && f.bytes !== null ? f.abs : null;
  };
}

// ---- 行の範囲（artifact-formats.md「担当に渡す資料」の spans）----
// 対象の ref は、担当が読む行の範囲 spans（Span の文字列。重ならず昇順）を持てる。無ければファイルの全体。
// 範囲の指紋は quote_hash と同じ求め方（範囲の行を "\n" でつないだ文字列の SHA-256）で取り、ファイル全体の指紋も併せて記録する。
// Span の読み方の正本は schemas.mjs の parseSpan、行の分け方の正本は checks/common.mjs の linesOf で、ここでは呼ぶだけにする。

// Span の並びを重なりと隣り合いで畳み、昇順の Span の文字列にする。読めない Span は誤り（範囲は CLI が inventory・対応表の照合を
// 通った出所から作るので、読めない Span が来るのは内部の誤り）
export function mergeSpans(spans) {
  const xs = spans.map((sp) => { const p = parseSpan(sp); if (!p) throw new Error(`読めない Span: ${JSON.stringify(sp)}`); return [p.from, p.to]; }).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [a, b] of xs) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b); else out.push([a, b]);
  }
  return out.map(([a, b]) => `L${a}-L${b}`);
}

// ファイルの行（Span の行の規則。linesOf）
export const fileLines = (bytes) => linesOf(Buffer.from(bytes).toString('utf8'));

// 範囲の行を "\n" でつないだ文字列（行数を超える部分は無い行として切る）。読めない Span は null
export function spanText(lines, span) {
  const p = parseSpan(span);
  return p ? lines.slice(p.from - 1, p.to).join('\n') : null;
}
