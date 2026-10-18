#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

export const LINE_TOLERANCE = 3
// これより短い引用は本文の別の箇所にも現れやすく、誤った行へ当たる。
export const MIN_QUOTE_CHARS = 6
// location の 1 つの行範囲がこの行数を超えたら位置不明として扱う。ファイル全体のような広い範囲は
// 仕込みも囮もまとめて覆い、どこを指したかを表さない。
export const MAX_LOCATION_SPAN = 20

const DASH = '\\s*[-–—〜~]\\s*'
// 裸の数字（§3・手順2・3件）は拾わない。位置を表すと書式で分かるものだけを行番号とみなす。
// 「N 行」は数（全160行のうち・3 行以上）にも使うので、数と分かる形（前が「全」、後ろが「以上・以下…」）だけを除く。
const LINE_PATTERNS = [
  new RegExp(`(?<![A-Za-z])L(\\d+)(?:${DASH}L?(\\d+))?`, 'g'),
  new RegExp(`(?<![全\\d])(\\d+)(?:${DASH}(\\d+))?\\s*行目`, 'g'),
  new RegExp(`(?<![全\\d])(\\d+)(?:${DASH}(\\d+))?\\s*行(?!目|以上|以下|未満|程度|ほど|分)`, 'g'),
  new RegExp(`\\blines?\\s+(\\d+)(?:${DASH}(\\d+))?`, 'gi'),
  new RegExp(`\\.[A-Za-z]+:(\\d+)(?:${DASH}(\\d+))?`, 'g'),
]

export function unwrapResult(raw) {
  let value = raw
  for (let depth = 0; depth < 8; depth++) {
    if (typeof value === 'string') value = JSON.parse(value)
    else if (value && typeof value === 'object' && 'mode' in value) return value
    else if (value && typeof value === 'object' && 'result' in value) value = value.result
    else break
  }
  throw new Error('workflow 結果の中に mode を持つ object が見つかりません')
}

const PATH_TOKEN = /(?:\.{0,2}\/)?[\w.-]+(?:\/[\w.-]+)*\.(?:md|mjs|js|py|json|ya?ml|txt|sh)\b/g

function locateRanges(text) {
  const normalized = String(text || '').normalize('NFKC')
  const found = []
  for (const pattern of LINE_PATTERNS) {
    for (const m of normalized.matchAll(pattern)) {
      const start = Number(m[1])
      const end = m[2] === undefined ? start : Number(m[2])
      found.push({ index: m.index, range: [Math.min(start, end), Math.max(start, end)] })
    }
  }
  return { normalized, found }
}

export function extractRanges(text) {
  return locateRanges(text).found.map((f) => f.range)
}

const narrowEnough = ([start, end]) => end - start + 1 <= MAX_LOCATION_SPAN

// location が別ファイルの行も挙げることがある（二重定義の両側など）。各行番号は直前に書かれた
// パスのものとして扱い、パスが前に無ければ finding.file のものとする。
export function rangesByFile(finding, snapshotDir) {
  const own = normalizeFile(finding.file, snapshotDir)
  const { normalized, found } = locateRanges(finding.location)
  const paths = [...normalized.matchAll(PATH_TOKEN)].map((m) => ({ index: m.index, file: normalizeFile(m[0], snapshotDir) }))
  const out = found.filter(({ range }) => narrowEnough(range)).map(({ index, range }) => {
    const owner = paths.filter((p) => p.index < index).at(-1)
    return { file: owner ? owner.file : own, range, via: 'location' }
  })
  for (const range of extractRanges(finding.file).filter(narrowEnough)) out.push({ file: own, range, via: 'location' })
  return out
}

const QUOTE_PAIRS = { '「': '」', '『': '』', '“': '”', '"': '"', '`': '`' }

// 入れ子の「」は外側だけを 1 つの引用として取る（引用の中に「その他」のような鉤括弧が残る）。
export function extractQuotes(text) {
  const quotes = []
  let i = 0
  while (i < text.length) {
    const close = QUOTE_PAIRS[text[i]]
    if (!close) {
      i++
      continue
    }
    const open = text[i]
    let depth = 1
    let j = i + 1
    for (; j < text.length; j++) {
      if (open !== close && text[j] === open) depth++
      else if (text[j] === close && --depth === 0) break
    }
    if (j >= text.length) {
      i++
      continue
    }
    quotes.push({ index: i, text: text.slice(i + 1, j) })
    i = j + 1
  }
  return quotes
}

function squash(text) {
  return text.normalize('NFKC').replace(/\s+/g, '')
}

// 引用の途中を省いた「…」で分け、各片を独立に探す。
function quoteSegments(text) {
  return text.split(/…+|\.{3,}|⋯+/).map(squash).filter((seg) => [...seg].length >= MIN_QUOTE_CHARS)
}

export function indexSources(sources) {
  const index = {}
  for (const [file, text] of Object.entries(sources || {})) {
    let flat = ''
    const lineOf = []
    text.split('\n').forEach((line, n) => {
      const part = squash(line)
      flat += part
      for (let k = 0; k < part.length; k++) lineOf.push(n + 1)
    })
    index[file] = { flat, lineOf }
  }
  return index
}

function findSegment(entry, seg) {
  const ranges = []
  for (let at = entry.flat.indexOf(seg); at !== -1; at = entry.flat.indexOf(seg, at + 1)) {
    ranges.push([entry.lineOf[at], entry.lineOf[at + seg.length - 1]])
  }
  return ranges
}

function sourceFilesFor(cited, index) {
  return Object.keys(index).filter((file) => sameFile(cited, file))
}

// evidence の引用を対象ファイルの本文から探して行へ直す。引用の直前に書かれたファイル名のファイルで
// 探し、そこに無ければ finding.file で探す。
export function evidenceRanges(finding, index, snapshotDir) {
  if (!index || Object.keys(index).length === 0) return []
  const own = normalizeFile(finding.file, snapshotDir)
  const evidence = String(finding.evidence || '')
  const quotes = extractQuotes(evidence)
  const pieces = quotes.length > 0 ? quotes : [{ index: 0, text: evidence }]
  const paths = [...evidence.matchAll(PATH_TOKEN)].map((m) => ({ index: m.index, file: normalizeFile(m[0], snapshotDir) }))
  const out = []
  for (const piece of pieces) {
    const cited = paths.filter((p) => p.index < piece.index).at(-1)
    const candidates = [...(cited ? [sourceFilesFor(cited.file, index)] : []), sourceFilesFor(own, index)]
    // 断片が候補のファイルに 2 回以上出るなら、どの箇所を引いたか決まらないので当たりにしない
    // （一意に定まるときだけ採る。短い語は仕込みと囮の両方に現れる）。
    for (const seg of quoteSegments(piece.text)) {
      for (const files of candidates) {
        const found = files.flatMap((file) => findSegment(index[file], seg).map((range) => ({ file, range, via: 'evidence' })))
        if (found.length === 1) out.push(...found)
        if (found.length > 0) break
      }
    }
  }
  return out
}

export function normalizeFile(file, snapshotDir) {
  let f = String(file || '').trim().replace(/:\d+(?:\s*[-–—〜~]\s*\d+)?$/, '')
  if (snapshotDir) {
    const prefix = snapshotDir.replace(/\/+$/, '') + '/'
    if (f.startsWith(prefix)) f = f.slice(prefix.length)
  }
  while (f.startsWith('./')) f = f.slice(2)
  return f
}

function sitesOf(entry) {
  return [{ file: entry.file, lines: entry.lines }, ...(entry.also || [])]
}

// 許容幅は finder が書いた行番号のずれを吸収するためのもの。引用から引いた行は本文上の正確な位置なので
// 幅を付けない（付けると引用した隣の段落の仕込みまで当たる）。
function overlaps([start, end], [lo, hi], via) {
  const tolerance = via === 'evidence' ? 0 : LINE_TOLERANCE
  return start <= hi + tolerance && end >= lo - tolerance
}

// finder がディレクトリを省いて basename だけを書くことがあるため、その場合だけ basename で突き合わせる。
function sameFile(cited, truthFile) {
  return cited === truthFile || (!cited.includes('/') && truthFile.split('/').at(-1) === cited)
}

function hitsOf(located, entries) {
  return entries
    .map((entry) => {
      const via = new Set(
        located
          .filter((l) => sitesOf(entry).some((site) => sameFile(l.file, site.file) && overlaps(l.range, site.lines, l.via)))
          .map((l) => l.via)
      )
      return { entry, via }
    })
    .filter((hit) => hit.via.size > 0)
}

function routeOf(vias) {
  return vias.has('location') && vias.has('evidence') ? 'both' : vias.has('location') ? 'location' : 'evidence'
}

function classify(findings, truth, snapshotDir, index) {
  return findings.map((finding) => {
    const located = [...rangesByFile(finding, snapshotDir), ...evidenceRanges(finding, index, snapshotDir)]
    if (located.length === 0) return { finding, bucket: 'unlocated', route: null, defects: [], decoys: [] }
    const defectHits = hitsOf(located, truth.defects)
    const decoyHits = hitsOf(located, truth.decoys)
    const hits = [...defectHits, ...decoyHits]
    const bucket = defectHits.length > 0 ? 'defect' : decoyHits.length > 0 ? 'decoy' : 'outside'
    return {
      finding,
      bucket,
      route: hits.length > 0 ? routeOf(new Set(hits.flatMap((h) => [...h.via]))) : null,
      defects: defectHits.map((h) => h.entry),
      decoys: decoyHits.map((h) => h.entry),
    }
  })
}

function rate(hit, total) {
  return { hit, total, rate: total === 0 ? null : hit / total }
}

function hitDefectIds(rows, scoped) {
  const ids = new Set(scoped.map((d) => d.id))
  return new Set(rows.flatMap((row) => row.defects.map((d) => d.id)).filter((id) => ids.has(id)))
}

export function score(truth, rawResult, { category = null, sources = null } = {}) {
  const result = unwrapResult(rawResult)
  const index = indexSources(sources)
  const snapshotDir = result.source_snapshot?.snapshot_dir || null
  const findings = result.findings || {}
  const scoped = category ? truth.defects.filter((d) => d.category === category) : truth.defects
  const scopedIds = new Set(scoped.map((d) => d.id))

  const confirmed = classify(findings.confirmed || [], truth, snapshotDir, index)
  const detected = hitDefectIds(confirmed, scoped)
  const categoryMatched = new Set(
    confirmed.flatMap((row) =>
      row.defects.filter((d) => scopedIds.has(d.id) && d.category === row.finding.category).map((d) => d.id)
    )
  )
  const decoysHit = new Set(confirmed.flatMap((row) => row.decoys.map((d) => d.id)))

  const byCategory = {}
  for (const d of scoped) {
    byCategory[d.category] ||= { hit: 0, total: 0, rate: null }
    byCategory[d.category].total++
    if (detected.has(d.id)) byCategory[d.category].hit++
  }
  for (const entry of Object.values(byCategory)) entry.rate = entry.hit / entry.total

  const reference = {}
  for (const [name, list] of [
    ['unverified', findings.unverified],
    ['reported_minor', findings.reported_minor],
    ['declared_only_before', result.declared_only?.before],
  ]) {
    const rows = classify(list || [], truth, snapshotDir, index)
    reference[name] = {
      findings: rows.length,
      defects_hit: hitDefectIds(rows, scoped).size,
      decoys_hit: new Set(rows.flatMap((row) => row.decoys.map((d) => d.id))).size,
      unlocated: rows.filter((row) => row.bucket === 'unlocated').length,
    }
  }

  return {
    mode: result.mode,
    category_filter: category,
    tolerance: LINE_TOLERANCE,
    detection: { ...rate(detected.size, scoped.length), by_category: byCategory },
    category_matched: rate(categoryMatched.size, scoped.length),
    false_positive: rate(decoysHit.size, truth.decoys.length),
    confirmed: {
      total: confirmed.length,
      on_defect: confirmed.filter((row) => row.bucket === 'defect').length,
      on_out_of_scope_defect: confirmed.filter(
        (row) => row.bucket === 'defect' && !row.defects.some((d) => scopedIds.has(d.id))
      ).length,
      on_decoy: confirmed.filter((row) => row.bucket === 'decoy').length,
      outside: confirmed.filter((row) => row.bucket === 'outside').length,
      unlocated: confirmed.filter((row) => row.bucket === 'unlocated').length,
      matched_by: Object.fromEntries(
        ['location', 'evidence', 'both'].map((route) => [route, confirmed.filter((row) => row.route === route).length])
      ),
    },
    evidence_lookup: index && Object.keys(index).length > 0,
    findings: confirmed.map((row) => ({
      category: row.finding.category,
      file: row.finding.file,
      location: row.finding.location,
      bucket: row.bucket,
      route: row.route,
      defects: row.defects.map((d) => d.id),
      decoys: row.decoys.map((d) => d.id),
    })),
    reference,
    defects: scoped.map((d) => ({ id: d.id, category: d.category, detected: detected.has(d.id) })),
    decoys: truth.decoys.map((d) => ({ id: d.id, hit: decoysHit.has(d.id) })),
  }
}

function pct(r) {
  return r.rate === null ? '-' : `${(r.rate * 100).toFixed(1)}%`
}

export function formatText(report) {
  const lines = [
    `mode: ${report.mode} / 分母のカテゴリ: ${report.category_filter || '全観点'} / 行の許容: ±${report.tolerance}`,
    `検出率: ${report.detection.hit}/${report.detection.total} (${pct(report.detection)})`,
    ...Object.entries(report.detection.by_category).map(([id, r]) => `  ${id}: ${r.hit}/${r.total} (${pct(r)})`),
    `観点も一致した検出: ${report.category_matched.hit}/${report.category_matched.total}`,
    `誤検出率（囮、カテゴリ絞り込みの対象外）: ${report.false_positive.hit}/${report.false_positive.total} (${pct(report.false_positive)})`,
    `confirmed ${report.confirmed.total} 件: 仕込みに当たった ${report.confirmed.on_defect}` +
      `（うち分母外のカテゴリ ${report.confirmed.on_out_of_scope_defect}）/ 囮 ${report.confirmed.on_decoy}` +
      ` / 仕込み外 ${report.confirmed.outside} / 位置不明 ${report.confirmed.unlocated}`,
    `当たった経路（evidence の引用照合: ${report.evidence_lookup ? '有効' : '無効'}）: location ${report.confirmed.matched_by.location}` +
      ` / evidence ${report.confirmed.matched_by.evidence} / 両方 ${report.confirmed.matched_by.both}`,
    'confirmed の内訳（観点 | file | location | 分類 | 経路 | 当たり）:',
    ...report.findings.map(
      (f) =>
        `  ${f.category} | ${f.file} | ${f.location} | ${f.bucket} | ${f.route || '-'} | ${[...f.defects, ...f.decoys].join(',') || '-'}`
    ),
    ...Object.entries(report.reference).map(
      ([name, r]) =>
        `参考 ${name}: ${r.findings} 件 / 当たった仕込み ${r.defects_hit} / 当たった囮 ${r.decoys_hit} / 位置不明 ${r.unlocated}`
    ),
    `未検出: ${report.defects.filter((d) => !d.detected).map((d) => d.id).join(', ') || 'なし'}`,
    `当たった囮: ${report.decoys.filter((d) => d.hit).map((d) => d.id).join(', ') || 'なし'}`,
  ]
  return lines.join('\n')
}

function loadSources(root) {
  const sources = {}
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else sources[relative(root, path)] = readFileSync(path, 'utf8')
    }
  }
  walk(root)
  return sources
}

function main(argv) {
  const positional = []
  let json = false
  let category = null
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') json = true
    else if (argv[i] === '--category') category = argv[++i]
    else positional.push(argv[i])
  }
  if (positional.length !== 2 || (category !== null && !category)) {
    process.stderr.write('usage: node score.mjs <truth.json> <workflow結果.json> [--json] [--category <id>]\n')
    process.exit(2)
  }
  const truth = JSON.parse(readFileSync(positional[0], 'utf8'))
  const raw = JSON.parse(readFileSync(positional[1], 'utf8'))
  if (category && !truth.defects.some((d) => d.category === category)) {
    process.stderr.write(`truth に category ${category} の defects がありません\n`)
    process.exit(2)
  }
  const report = score(truth, raw, { category, sources: loadSources(join(dirname(positional[0]), 'target', truth.skill)) })
  process.stdout.write((json ? JSON.stringify(report, null, 2) : formatText(report)) + '\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2))
