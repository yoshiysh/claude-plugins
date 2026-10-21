import { assetId, sha256Hex } from './ids.mjs';

const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const SETEXT =/^ {0,3}(=+|-+)[ \t]*$/;

function atxText(raw) {
  return (raw ?? '').replace(/[ \t]+#+[ \t]*$/, '').replace(/^#+$/, '').trim();
}

function splitLines(text) {
  const lines = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') {
      lines.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

function bare(line) {
  return line.replace(/\r?\n$/, '');
}

function headingsOf(lines, from) {
  const out = [];
  let fence = null;
  for (let i = from; i < lines.length; i += 1) {
    const line = bare(lines[i]);
    const f = FENCE.exec(line);
    if (fence) {
      const close = CLOSE.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      continue;
    }
    if (f) { fence = f[1]; continue; }
    const atx = ATX.exec(line);
    if (atx) { out.push({ start: i, level: atx[1].length, text: atxText(atx[2]) }); continue; }
    const next = i + 1 < lines.length ? bare(lines[i + 1]) : null;
    if (next != null && line.trim() !== '' && SETEXT.test(next) && !FENCE.test(line)) {
      const level = next.trim()[0] === '=' ? 1 : 2;
      out.push({ start: i, level, text: line.trim(), underline: true });
      i += 1;
    }
  }
  return out;
}

function markdownRanges(text) {
  const lines = splitLines(text);
  const ranges = [];
  let body = 0;
  if (lines.length > 0 && bare(lines[0]) === '---') {
    const end = lines.findIndex((l, i) => i > 0 && bare(l) === '---');
    if (end > 0) {
      ranges.push({ loc: { k: 'fm' }, content: lines.slice(0, end + 1).join('') });
      body = end + 1;
    }
  }
  const heads = headingsOf(lines, body);
  const firstHead = heads.length ? heads[0].start : lines.length;
  const pre = lines.slice(body, firstHead).join('');
  if (pre.trim() !== '') ranges.push({ loc: { k: 'pre' }, content: pre });
  const stack = [];
  const counts = new Map();
  heads.forEach((h, idx) => {
    while (stack.length && stack.at(-1)[0] >= h.level) stack.pop();
    stack.push([h.level, h.text]);
    const chain = stack.map((x) => [...x]);
    const chainKey = JSON.stringify(chain);
    const n = (counts.get(chainKey) ?? 0) + 1;
    counts.set(chainKey, n);
    const end = idx + 1 < heads.length ? heads[idx + 1].start : lines.length;
    ranges.push({ loc: { k: 'sec', h: chain, n }, content: lines.slice(h.start, end).join('') });
  });
  return ranges;
}

export function isMarkdown(relPath) {
  return /\.(md|markdown)$/i.test(relPath);
}

export function splitAssets(relPath, bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const ranges = isMarkdown(relPath) ? markdownRanges(buffer.toString('utf8')) : [{ loc: { k: 'file' }, content: buffer }];
  return ranges.map((r) => ({
    id: assetId(relPath, r.loc),
    path: relPath,
    loc: r.loc,
    digest: sha256Hex(Buffer.isBuffer(r.content) ? r.content : Buffer.from(r.content, 'utf8')),
  }));
}
