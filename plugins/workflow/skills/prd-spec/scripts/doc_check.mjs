// doc_check: 本文を読む決定的な検査の CLI。Workflow script はファイルを読めないので、agent にこの CLI を実行させて
// 件数と digest だけを受け取る（本文を返り値で運ぶと、改稿のたびに文書全体を Write と返り値で 2 度出力させる）。

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// OBSOLETE_TERMS: 現行規制として引用すると誤りになる語。QMSR（2026-02-02 施行）により
// 21 CFR 820.30 Design Controls は [Reserved] 化され、現行 Part 820 本文にこれらの語は
// 一度も出現しない。学習データに旧 QSR の語彙が大量に残っているため、agent の判断ではなく
// 完全一致の文字列検査で押さえる。照合は小文字化した本文に対して行う。
const OBSOLETE_TERMS = ['21 cfr 820.30', 'design input', 'design output', 'design history file']

// UNVERIFIABLE_STANDARDS: 有料規格で本文を確認できていないもの。存在と射程には触れてよいが、
// 条番号を伴う引用をさせない。「第 14 版」を条番号と誤検出しないため、日本語側は
// 「第 N 節/条/項」に限定する（限定しないと改稿ラウンドを 1 回無駄にする）。
const UNVERIFIABLE_STANDARDS = ['IEC 62304', 'ISO 14971', 'ISO 13485', 'JIS T 2304', 'FISC']
const CLAUSE_REF = '(?:(?:§|Clause|Section|箇条)\\s*\\d|第\\s*\\d+(?:\\.\\d+)*\\s*(?:節|条|項))'

// ID_IN_TEXT: 本文に実在する ID を agent の申告とは独立に抽出するためのパターン。
// これが無いと集合差分は「agent が申告した ID 一覧」と「agent が書いた表」を比べるだけになり、
// 両者が同じ自己申告に由来するため循環する。
// TBD ID を本文から拾う。要求 ID と別に持つのは、この検査が効く先が違うからである。
// 要求 ID の申告漏れはトレーサビリティを壊すが、TBD の申告漏れは**完成条件そのもの**を壊す。
const TBD_ID_IN_TEXT = /\bTBD-[A-Z][A-Z0-9]*-\d+\b/g

const ID_IN_TEXT = {
  requirements: /\bPR-[A-Z][A-Z0-9]*-\d+\b/g,
  specifications: /\bSP-[A-Z][A-Z0-9]*-\d+\b/g,
}

// newlineCount: `wc -l` と同じ数え方（改行の数）。lineTotal と違い、末尾に改行の無い最終行を数えない。
function newlineCount(md) {
  return (String(md || '').match(/\n/g) || []).length
}

// lineTotal: offset/limit の範囲計算に使う行数（末尾に改行が無い最終行も 1 行と数える）。
function lineTotal(md) {
  const s = String(md || '')
  if (!s) return 0
  return newlineCount(s) + (s.endsWith('\n') ? 0 : 1)
}

// 節は「見出し文字列 + 出現順」で対応づける — 位置で対応づけると、1 節の挿入で後続の全節が
// 変更扱いになり、スコープ監査が全文監査に戻る。返す行番号は改稿（next）側の 1 始まり。
// 削除された節は幅 0 の { start, end: start - 1, deleted: true } で、元あった位置を示す。
function changedLineRanges(prevMarkdown, nextMarkdown) {
  const sectionsOf = (md) => {
    const lines = String(md || '').split('\n')
    if (lines.length && lines[lines.length - 1] === '') lines.pop()
    const out = []
    const seen = new Map()
    let inFence = false
    let cur = { heading: '', start: 1, body: [] }
    const close = (end) => {
      if (end < cur.start) return
      const n = (seen.get(cur.heading) || 0) + 1
      seen.set(cur.heading, n)
      out.push({ key: `${cur.heading}#${n}`, heading: cur.heading, start: cur.start, end, text: cur.body.join('\n') })
    }
    lines.forEach((ln, i) => {
      if (/^\s*(```|~~~)/.test(ln)) inFence = !inFence
      if (!inFence && /^#{2,4}\s/.test(ln)) {
        close(i)
        cur = { heading: ln.trim(), start: i + 1, body: [] }
      }
      cur.body.push(ln)
    })
    close(lines.length)
    return out
  }
  const prev = sectionsOf(prevMarkdown)
  const next = sectionsOf(nextMarkdown)
  const prevText = new Map(prev.map((sec) => [sec.key, sec.text]))
  const nextByKey = new Map(next.map((sec) => [sec.key, sec]))
  const merged = []
  for (const sec of next.filter((x) => prevText.get(x.key) !== x.text)) {
    const last = merged[merged.length - 1]
    if (last && sec.start <= last.end + 1) {
      last.end = Math.max(last.end, sec.end)
      last.heading = [last.heading, sec.heading].filter(Boolean).join(' / ')
    } else {
      merged.push({ start: sec.start, end: sec.end, heading: sec.heading })
    }
  }
  const deleted = []
  prev.forEach((sec, i) => {
    if (nextByKey.has(sec.key)) return
    let at = 1
    for (let j = i - 1; j >= 0; j--) {
      const kept = nextByKey.get(prev[j].key)
      if (kept) {
        at = kept.end + 1
        break
      }
    }
    deleted.push({ start: at, end: at - 1, heading: sec.heading, deleted: true })
  })
  return [...merged, ...deleted].sort((a, b) => a.start - b.start || Number(Boolean(a.deleted)) - Number(Boolean(b.deleted)))
}

// CLI は指摘を { c: 種別, d: 文書キー, a: 引数 } の短い形で出し、文面はこの表から組み立てる。agent は CLI の出力を
// 書き写して返すので、指摘ごとに同じ説明文を載せると出力が数百 KB に膨らみ、写すトークンと写し間違いの機会が増える。
// 組み立て結果は tests/test_doc_check.py が golden と照合する（文面を変えたら golden も直す）。
// FINDING_TEXT_BEGIN
const KIND_LABEL = { R: '要求', S: '仕様項目' }
const FINDING_TEXT = {
  DUP: (id, keys) => ({
    id: `ST-DUP-${id}`,
    location: 'ID 一覧',
    quote: id,
    issue: `ID ${id} が ${keys.join(' / ')} の複数文書で定義されている。ID は文書を跨いで一意でなければ、トレーサビリティ表がどちらの項目を指しているか決まらない。`,
    fix: `領域プレフィックスを文書の topic に対応させて振り直す（${keys[1]} 側を別の領域名にする）。`,
  }),
  DUP_TBD: (id, keys, text0, text1) => ({
    id: `ST-DUP-TBD-${id}`,
    location: '未確定事項',
    quote: id,
    issue: `TBD ${id} が ${keys.join(' / ')} の複数文書から別々の内容で申告されている（「${text0}」と「${text1}」）。統合時に片方が消えるため、消えた側が着手を止める項目でも人間に提示されない。`,
    fix: 'TBD の番号にも文書の領域プレフィックスを付けて振り直す（例 TBD-AUTH-001）。',
  }),
  ORPHAN_REQ: (id) => ({
    id: `ST-ORPHAN-REQ-${id}`,
    location: 'トレーサビリティ表',
    quote: id,
    issue: `要求 ${id} がどの specification 文書のトレーサビリティ表にも現れない（＝この要求を実現する仕様項目が無い）。`,
    fix: `${id} を実現する仕様項目をいずれかの specification 文書に追加して紐付けるか、実現しないのであれば requirements 側でスコープ外として明記する。情報が未確定なら TBD として起票する。`,
  }),
  ORPHAN_SPEC: (id) => ({
    id: `ST-ORPHAN-SPEC-${id}`,
    location: 'トレーサビリティ表',
    quote: id,
    issue: `仕様項目 ${id} が自文書のトレーサビリティ表に現れない（＝根拠となる要求が不明の仕様）。`,
    fix: `${id} の根拠となる要求 ID を紐付ける。根拠が無いのであれば仕様項目を削除する。`,
  }),
  DANGLING_REQ: (id) => ({
    id: `ST-DANGLING-REQ-${id}`,
    location: 'トレーサビリティ表',
    quote: id,
    issue: `トレーサビリティ表が要求 ${id} を参照しているが、どの requirements 文書の要求一覧にも存在しない。`,
    fix: `いずれかの requirements 文書に ${id} を実在させるか、表の行を正しい要求 ID に直す。`,
  }),
  DANGLING_SPEC: (id) => ({
    id: `ST-DANGLING-SPEC-${id}`,
    location: 'トレーサビリティ表',
    quote: id,
    issue: `トレーサビリティ表が仕様項目 ${id} を参照しているが、仕様書に存在しない。`,
    fix: `${id} を本文に実在させるか、表の行を正しい仕様項目 ID に直す。`,
  }),
  VACANT_CONFLICT: (k, id) => ({
    id: `ST-VACANT-CONFLICT-${id}`,
    location: 'ID 一覧',
    quote: id,
    issue: `${KIND_LABEL[k]} ${id} が vacant_ids（欠番）と ID 一覧（実在の項目）の両方に申告されている。欠番は「割り当てられていない」の宣言であり、実在する項目と両立しない。`,
    fix: `${id} が実在するなら vacant_ids から外し、欠番なら ID 一覧から外して本文の項目を削除する。`,
  }),
  UNDECLARED: (k, id) => ({
    id: `ST-UNDECLARED-${id}`,
    location: '本文',
    quote: id,
    issue: `${KIND_LABEL[k]} ${id} が本文に現れているが、返り値の ID 一覧に含まれていない。一覧から漏れた ID は照合対象から外れ、紐付けの欠落が検出されないまま通る。`,
    fix: `${id} を ID 一覧に加える。他文書の ID を参照しているだけ、または ID 体系の例示であって実在の項目ではない場合は referenced_ids に、この文書の欠番であるなら vacant_ids に入れる（本文で「欠番」と同じ行に併記されている ID も欠番として扱われる）。`,
  }),
  UNDECLARED_TBD: (id) => ({
    id: `ST-UNDECLARED-TBD-${id}`,
    location: '未確定事項',
    quote: id,
    issue: `未確定事項 ${id} が本文に現れているが、どの文書の TBD 一覧にも含まれていない。申告に載らない TBD は blocking の集計から外れ、「未提示の blocking が 0 件」という完成判定を素通りする。`,
    fix: `${id} を meta の tbd に起票する（blocking の真偽を必ず付ける）。既に解決していて本文に参照が残っているだけなら、本文からその記述を消す。`,
  }),
  PHANTOM: (k, id) => ({
    id: `ST-PHANTOM-${id}`,
    location: '本文',
    quote: id,
    issue: `${KIND_LABEL[k]} ${id} が ID 一覧に申告されているが、本文に存在しない。読み手はこの ID の中身を確認できない。`,
    fix: `${id} を本文に実在させるか、ID 一覧から外す。`,
  }),
  GAP: (missingId) => ({
    id: `ST-GAP-UNDECLARED-${missingId}`,
    location: 'ID 一覧',
    quote: missingId,
    issue: `ID 連番に欠番がある（${missingId}）のに、本文に欠番の申告が無い。無申告の欠番は「項目が削除された」のか「統合時に取りこぼした」のか読み手が区別できない。`,
    fix: `${missingId} が欠番であることを申告する（vacant_ids に入れる、または本文で「欠番」の語と同じ行に併記する。どちらも申告漏れの検査から除外される）か、採番を詰めて欠番を無くす。`,
  }),
  OBSOLETE: (term, docKey) => ({
    id: `ST-OBSOLETE-${docKey}-${term.replace(/[^a-z0-9]/g, '')}`,
    location: '本文',
    quote: term,
    issue: `「${term}」は現行の規制文言ではない。21 CFR 820.30 Design Controls は QMSR（2026-02-02 施行）で [Reserved] 化され、現行 Part 820 本文にこの語は出現しない。現行規制の引用として書くと誤りになる。`,
    fix: '現行規制の根拠として書いているなら削除する。設計モデルとして言及したいのであれば「歴史的な設計統制モデル」であることを同じ段落に明記し、現行規則の引用として提示しない。',
  }),
  OBSOLETE_DHF: (docKey) => ({
    id: `ST-OBSOLETE-${docKey}-dhf`,
    location: '本文',
    quote: 'DHF',
    issue: '「DHF（design history file）」は現行の規制文言ではない。QMSR は DHF ではなく "medical device file" の語を使う。',
    fix: '現行規制の根拠として書いているなら削除する。設計モデルとして言及したいのであれば「歴史的な設計統制モデル」であることを同じ段落に明記する。',
  }),
  UNVERIFIED: (std, docKey) => ({
    id: `ST-UNVERIFIED-${docKey}-${std.replace(/[^A-Za-z0-9]/g, '')}`,
    location: '本文',
    quote: std,
    issue: `${std} の条番号を引用している。この規格は本文を確認できていないため、条番号の内容を裏付けられない。誤った条番号の引用は、規格に触れないことより有害である。`,
    fix: `条番号を落とし、規格名と大まかな射程だけを述べる形に直す（例:「${std} の考え方に基づく」）。または引用自体を削除する。`,
  }),
  NOUNIT: (docKey) => ({
    id: `ST-NOUNIT-${docKey}`,
    location: '対象範囲',
    quote: '(単位の宣言なし)',
    severity: 'degraded',
    issue: '何を 1 つの仕様項目として切り出すかの宣言が本文に無い。単位が宣言されていないと、読み手ごとに項目の切り出し方が変わり、件数・網羅の判定が文書間で揃わない。',
    fix: '本文の一箇所（対象範囲の章など）に、機械的に判別できる形で単位を宣言する（例:「本書は `####` 見出し 1 つを 1 仕様項目とする」）。requirement-writing-rules.md §8 を正とする。',
  }),
  MODAL: (id, sent, quote) => ({
    id: `ST-MODAL-${id}-${sent}`,
    location: id,
    quote,
    severity: 'degraded',
    issue: `要求 ${id} の本文に、規範の意図を持つのに 4 語尾（〜しなければならない / 〜してはならない / 〜することが望ましい / 〜してもよい）のいずれでも終わらない文がある。区分（必須 / 禁止 / 推奨 / 許容）が読み手に決まらない。`,
    fix: '文意に対応する 4 語尾のいずれかで文を終える（requirement-writing-rules.md §1 を正とする）。',
  }),
  IDHEADING: (id, level, baseLevel) => ({
    id: `ST-IDHEADING-${id}`,
    location: '見出し',
    quote: id,
    severity: 'degraded',
    issue: `ID を含む見出しのレベルが文書内で不統一（${id} はレベル ${level}、この文書の基準はレベル ${baseLevel}）。読み手が「章の中の区分」と「個別項目」を階層で見分けられない。`,
    fix: '個別項目の見出しレベルを文書内で統一する（document-structure.md §2.6 は `####` を基準とする）。',
  }),
  TBD_NORESOLVE: (id) => ({
    id: `ST-TBD-NORESOLVE-${id}`,
    location: '未確定事項',
    quote: id,
    severity: 'degraded',
    issue: `着手を止める未確定事項 ${id} に、解消条件に相当する記述（「解消」の語）が無い。解消条件の無い blocking TBD は、何が決まれば先へ進めるのかが読み手に決まらない。`,
    fix: 'meta の tbd の text に解消条件（何がどう決まればこの項目が解消するか）を書き足す。',
  }),
  NO_EVIDENCE: (id) => ({
    id: `ST-NO-EVIDENCE-${id}`,
    location: id,
    quote: id,
    issue: `${id} に対応する trace（根拠原本の引用）が申告されていない。本文に根拠句を書かない規約なので、trace が無い項目は根拠がどこにも残らない。`,
    fix: '根拠（input.md・answers・決定の台帳・固定前提・flow）を trace に申告する。引用できないなら、その項目は要求ではなく未確定事項として起票し直す。',
  }),
  NON_NORMATIVE: (what, quote, docKey) => ({
    id: `ST-NON-NORMATIVE-${docKey}-${what}`,
    location: '本文',
    quote,
    issue: `本文に${what}が含まれている。納品文書に書くのは規範文・ID・上位/姉妹文書への参照・自明でない規則の 1 文の理由だけであり、経緯と根拠は meta の trace と保存時の commit / PR 本文に残す。`,
    fix: '当該の記述を本文から外す。根拠は trace に申告し、決まっていないことは保持規則（規範文）として書く。',
  }),
  FLOW_SHAPE: (key, detail) => ({
    id: `ST-FLOW-SHAPE-${key}`,
    location: '工程の流れ（flow）',
    quote: key,
    issue: `工程の流れの形が契約に合わない（${detail}）。流れは各項目を当てる軸であり、形が崩れていると閉じているかを判定できない。`,
    fix: `${ledgerOf('flow').file()} を契約（schemas/agent-contracts.md の「${ledgerOf('flow').file()} の形」）の形に直す（文書の改稿では直らない）。`,
  }),
  FLOW_BRANCH_OPEN: (id, value) => ({
    id: `ST-FLOW-BRANCH-OPEN-${id}-${value}`,
    location: '工程の流れ（flow）',
    quote: `${id}: ${value}`,
    issue: `判断 ${id} の値「${value}」に行き先が無い。行き先の無い値は、誰も振る舞いを決めていない枝になる。`,
    fix: `値「${value}」の行き先の要素を flow に描く。その値が起こりえないなら branches から外し、外せる根拠を closure に書く。`,
  }),
  FLOW_DANGLING: (from, to) => ({
    id: `ST-FLOW-DANGLING-${from}-${to}`,
    location: '工程の流れ（flow）',
    quote: `${from} → ${to}`,
    issue: `流れの要素 ${from} の行き先 ${to} が flow の要素一覧に無い。`,
    fix: `${to} を要素として描くか、行き先を実在する要素に直す。`,
  }),
  FLOW_UNREACHABLE: (id) => ({
    id: `ST-FLOW-UNREACHABLE-${id}`,
    location: '工程の流れ（flow）',
    quote: id,
    issue: `流れの要素 ${id} へ、どの入力からも辿り着けない。辿り着けない工程は、描いてあっても実行されない。`,
    fix: `${id} へ入る辺を描くか、実行されないなら要素ごと外す。`,
  }),
  FLOW_DEADEND: (id) => ({
    id: `ST-FLOW-DEADEND-${id}`,
    location: '工程の流れ（flow）',
    quote: id,
    issue: `流れの要素 ${id} は出力ではないのに行き先が無い。中断点の後の戻り先や終わり方が決まっていない。`,
    fix: `${id} の次の要素（戻り先・終了）を描くか、流れの終わりなら type を output にする。`,
  }),
  FLOW_UNATTACHED: (id, label) => ({
    id: `ST-FLOW-UNATTACHED-${id}`,
    location: '工程の流れ（flow）',
    quote: `${id} ${label}`,
    issue: `流れの要素 ${id}（${label}）に、どの項目も当てられていない（flow_refs に現れない）。当たる項目の無い工程は、実装が何をしても仕様違反にならない。`,
    fix: `${id} を扱う項目の flow_refs に ${id} を加える。扱う項目が無ければその工程の振る舞いを定める項目を足す（根拠が入力に無いなら TBD として起票する）。`,
  }),
  FLOW_UNKNOWN_REF: (itemId, ref) => ({
    id: `ST-FLOW-UNKNOWN-REF-${itemId}-${ref}`,
    location: itemId,
    quote: ref,
    issue: `項目 ${itemId} の flow_refs が指す ${ref} は flow の要素一覧に無い。`,
    fix: `${ref} を flow に実在する要素 ID に直す。`,
  }),
  STATE_NOAXIS: (docKey, section) => ({
    id: `ST-STATE-NOAXIS-${docKey}-${section}`,
    location: section,
    quote: '(対象のイベントの宣言なし)',
    issue: '状態 × イベント表の前にイベントの軸（「> 対象のイベント:」の行）が無い。軸が無いと、どの組み合わせが欠けているかを判定できない。',
    fix: '表の直前にイベントの集合を「> 対象のイベント: E1 … / E2 …」の形で置く（document-structure.md §6）。',
  }),
  STATE_MISSING: (docKey, s, e) => ({
    id: `ST-STATE-MISSING-${docKey}-${s}-${e}`,
    location: '状態とイベント',
    quote: `${s} × ${e}`,
    issue: `状態「${s}」でイベント「${e}」が起きたときの行き先が、表にも図にも無い。書かれていない組み合わせは、実装者ごとに違う振る舞いになる。`,
    fix: `「${s} × ${e}」の行を足す。起こりえないなら次の状態を「—」、定義済みか列を「発生しない」にする。`,
  }),
  STATE_NONDET: (docKey, s, e, targets) => ({
    id: `ST-STATE-NONDET-${docKey}-${s}-${e}`,
    location: '状態とイベント',
    quote: `${s} × ${e} → ${targets}`,
    issue: `状態「${s}」でイベント「${e}」が起きたときの次の状態が 1 つに決まらない（${targets}）。同じ入力に 2 つの行き先があると、どちらを実装しても仕様に合う。`,
    fix: '行き先を 1 つにする。条件で分かれるなら、その条件をイベントとして軸に足して行を分ける。',
  }),
  STATE_HIDDEN: (docKey, s, e, other) => ({
    id: `ST-STATE-HIDDEN-${docKey}-${s}-${e}-${other}`,
    location: '状態とイベント',
    quote: `${s} × ${e}: ${other}`,
    issue: `状態「${s}」×「${e}」の行の定義済みか列が、次の状態とは別の状態「${other}」への移り方を書いている。表の外に書いた遷移は、網羅と一意の検査から漏れる。`,
    fix: `「${other}」へ移る遷移は、それを起こすイベントの行（または図の辺）として書く。定義済みか列には仕様項目 ID だけを置く。`,
  }),
  STATE_DIAGRAM_CONFLICT: (docKey, s, e, tableTo, diagramTo) => ({
    id: `ST-STATE-DIAGRAM-CONFLICT-${docKey}-${s}-${e}`,
    location: '状態とイベント',
    quote: `${s} × ${e}`,
    issue: `状態「${s}」×「${e}」の行き先が、表では「${tableTo}」、状態遷移図では「${diagramTo}」になっている。どちらが正か決まらない。`,
    fix: '表と図のどちらか一方にだけ書く（主フローは図、それ以外は表。document-structure.md §6）。両方に残すなら行き先を揃える。',
  }),
  STATE_UNREACHABLE: (docKey, s) => ({
    id: `ST-STATE-UNREACHABLE-${docKey}-${s}`,
    location: '状態とイベント',
    quote: s,
    issue: `状態「${s}」へ、初期状態から表と図のどの遷移を辿っても着かない。`,
    fix: `「${s}」へ入る遷移を書くか、存在しない状態なら軸と図から外す。`,
  }),
  STATE_DEADEND: (docKey, s) => ({
    id: `ST-STATE-DEADEND-${docKey}-${s}`,
    location: '状態とイベント',
    quote: s,
    issue: `状態「${s}」から出る遷移が表にも図にも無く、終端（\`--> [*]\`）でもない。この状態に入ると抜けられない。`,
    fix: `「${s}」から出る遷移を書くか、終端なら図に「${s} --> [*]」を書く。`,
  }),
  STATE_AXIS: (docKey, s, e, what, value) => ({
    id: `ST-STATE-AXIS-${docKey}-${s}-${e}-${what}`,
    location: '状態とイベント',
    quote: value,
    issue: `状態 × イベント表の${what}「${value}」が、宣言した軸（対象の状態 / 対象のイベント / 図の状態）に無い。軸の外の値は網羅と一意の検査に乗らない。`,
    fix: `「${value}」を軸の値に揃える（イベントは記号か名前をそのまま書く。次の状態は状態名を 1 つだけ書き、補足は書かない。終端へ移るなら、図で \`--> [*]\` を持つ状態の名前を書く）。`,
  }),
  STATE_NO_NEXT: (docKey, s, e) => ({
    id: `ST-STATE-NO-NEXT-${docKey}-${s}-${e}`,
    location: '状態とイベント',
    quote: `${s} × ${e}`,
    issue: `状態「${s}」×「${e}」の行は定義済みとされているのに、次の状態が書かれていない。`,
    fix: '次の状態を 1 つ書く。留まるなら現在の状態名を書く。起こりえないなら定義済みか列を「発生しない」にする。',
  }),
  DT_GAP: (docKey, label, combo) => ({
    id: `ST-DT-GAP-${docKey}-${label}-${combo}`,
    location: label,
    quote: combo,
    issue: `判定表「${label}」に、条件の組み合わせ「${combo}」に当たる行が無い（上記以外の行も無い）。`,
    fix: 'その組み合わせの行を足すか、「上記以外」の行で結果を定める。起こりえない組み合わせなら、起こりえない旨を結果に書いた行を置く。',
  }),
  DT_OVERLAP: (docKey, label, combo, rowA, rowB) => ({
    id: `ST-DT-OVERLAP-${docKey}-${label}-${combo}`,
    location: label,
    quote: combo,
    issue: `判定表「${label}」の ${rowA} 行目と ${rowB} 行目が、同じ組み合わせ「${combo}」に当たり、結果が違う。どちらを採るか決まらない。`,
    fix: '条件の値を分けて、1 つの組み合わせが 1 行にだけ当たるようにする。',
  }),
  DT_VALUE: (docKey, label, cond, value) => ({
    id: `ST-DT-VALUE-${docKey}-${label}-${cond}-${value}`,
    location: label,
    quote: value,
    issue: `判定表「${label}」の条件「${cond}」の値「${value}」が、宣言した値の集合に無い。`,
    fix: `値を「> 条件の値: ${cond} = …」で宣言した値に揃えるか、宣言に足す。`,
  }),
  NC_FLOW: () => ({
    id: 'ST-NOTCHECKED-FLOW',
    issue: '工程の流れ（flow）が渡されていないため、各工程に項目が当たっているかを検査していない。「指摘 0 件」ではなく「未検査」である。',
  }),
  NC_DTABLE: (key, label, n) => ({
    id: `ST-NOTCHECKED-DTABLE-${key}-${label}`,
    issue: `${key} の判定表「${label}」は条件の組み合わせが ${n} 通りあり、網羅の検査を実行していない。「指摘 0 件」ではなく「未検査」である。`,
  }),
  NC_CROSSREF: (kind) => ({
    id: 'ST-NOTCHECKED-CROSSREF',
    issue:
      `${kind} 文書が本ランの対象に含まれないため、` +
      '要求 ID と仕様項目 ID の突き合わせを実行していない。「指摘 0 件」ではなく「未検査」である。',
  }),
  NC_TRACE: (key) => ({
    id: `ST-NOTCHECKED-TRACE-${key}`,
    issue: `${key} が trace を申告していないため、項目 ID と根拠の対応を検査していない。「根拠あり」ではなく「未検査」である。`,
  }),
  NC_BODY: (key, p) => ({
    id: `ST-NOTCHECKED-BODY-${key}`,
    issue: `${key} の本文 ${p} を読めなかったため、本文を使う検査（申告と本文の突き合わせ・禁止語・語尾）を実行していない。「指摘 0 件」ではなく「未検査」である。`,
  }),
}

// expandStructural: 未知の種別は例外にする（黙って落とすと、指摘が「0 件」に化ける）。
function expandStructural(compact) {
  const make = (c, args) => {
    const t = FINDING_TEXT[c]
    if (!t) throw new Error(`構造検査の未知の種別です: ${JSON.stringify(c)}`)
    return t(...(args || []))
  }
  const findings = []
  for (const g of compact.findings || []) {
    for (const args of (g && g.a) || []) {
      const t = make(g.c, args)
      findings.push({
        auditor: 'structural',
        id: t.id,
        document: g.d,
        location: t.location,
        quote: t.quote,
        ...(t.severity ? { severity: t.severity } : {}),
        issue: t.issue,
        fix: t.fix,
      })
    }
  }
  return { findings, not_checked: (compact.not_checked || []).map((n) => make(n && n.c, n && n.a)) }
}
// FINDING_TEXT_END

// flow の軸が閉じていなければ「どの工程にも項目が当たっている」は何も保証しないので、形と閉包は算術で押さえる。
// prd-spec.js は指摘が 0 件でない flow では書き始めない（writer には flow を直す手段が無い）。
function flowGraphCompact(flow) {
  const out = []
  const shape = (key, detail) => out.push({ c: 'FLOW_SHAPE', d: 'flow', a: [key, detail] })
  if (!flow || typeof flow !== 'object' || !Array.isArray(flow.elements)) {
    shape('elements', 'elements が配列ではない')
    return out
  }
  const kindNames = new Set()
  for (const k of Array.isArray(flow.kinds) ? flow.kinds : []) {
    if (!k || !k.name || !String(k.definition || '').trim()) shape(`kind-${(k && k.name) || '?'}`, '種類に name と definition が揃っていない')
    else kindNames.add(k.name)
  }
  if (!kindNames.size) shape('kinds', '要素の種類（kinds）が 1 つも定義されていない')
  if (!String(flow.closure || '').trim()) shape('closure', '一覧の外に要素が無いと言える根拠（closure）が無い')
  const byId = new Map()
  const noId = flow.elements.filter((el) => !el || !el.id).length
  if (noId) shape('id', `id の無い要素が ${noId} 件ある`)
  for (const el of flow.elements.filter((x) => x && x.id)) {
    if (byId.has(el.id)) shape(`dup-${el.id}`, `要素 ID ${el.id} が重複している`)
    byId.set(el.id, el)
    if (!FLOW_TYPES.includes(el.type)) shape(`type-${el.id}`, `${el.id} の type が ${FLOW_TYPES.join(' / ')} のいずれでもない`)
    if (!kindNames.has(el.kind)) shape(`kind-of-${el.id}`, `${el.id} の kind が kinds に定義されていない`)
    const branches = Array.isArray(el.branches) ? el.branches : []
    if (el.type === 'decision' && branches.length < 2) shape(`branches-${el.id}`, `判断 ${el.id} の値が 2 つ未満`)
    if (el.type !== 'decision' && branches.length) shape(`branches-${el.id}`, `判断でない ${el.id} が branches を持つ`)
  }
  const types = new Set([...byId.values()].map((el) => el.type))
  if (!types.has('input')) shape('no-input', '入力（type: input）が無い')
  if (!types.has('output')) shape('no-output', '出力（type: output）が無い')
  const nextOf = new Map()
  for (const el of byId.values()) {
    const targets = []
    for (const to of Array.isArray(el.next) ? el.next : []) targets.push(to)
    for (const b of el.type === 'decision' && Array.isArray(el.branches) ? el.branches : []) {
      if (!b || !b.next) out.push({ c: 'FLOW_BRANCH_OPEN', d: 'flow', a: [el.id, String((b && b.value) || '?')] })
      else targets.push(b.next)
    }
    for (const to of targets) {
      if (!byId.has(to)) out.push({ c: 'FLOW_DANGLING', d: 'flow', a: [el.id, to] })
    }
    nextOf.set(el.id, targets.filter((to) => byId.has(to)))
    if (el.type !== 'output' && el.type !== 'decision' && !targets.length) out.push({ c: 'FLOW_DEADEND', d: 'flow', a: [el.id] })
  }
  const seen = new Set()
  const queue = [...byId.values()].filter((el) => el.type === 'input').map((el) => el.id)
  while (queue.length) {
    const id = queue.shift()
    if (seen.has(id)) continue
    seen.add(id)
    queue.push(...(nextOf.get(id) || []))
  }
  if (types.has('input')) {
    for (const id of byId.keys()) if (!seen.has(id)) out.push({ c: 'FLOW_UNREACHABLE', d: 'flow', a: [id] })
  }
  return out
}

// 状態機械と判定規則は、散文だと「同じ入力に 2 つの行き先」「分岐の値に行き先が無い」「条件が重なる」を読み手が照合するしかない。
// 表の形を document-structure.md §6 / §2.8 に固定して算術で検査し、機械的に読めない表は検査しない（偽陽性は改稿枠を空回りさせる）。

const cellsOf = (line) => {
  const t = line.trim()
  if (!t.startsWith('|')) return null
  return t.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
}
const isSeparator = (cells) => cells && cells.length && cells.every((c) => /^:?-{2,}:?$/.test(c))
const splitAxis = (s) => String(s).split(/\s+\/\s+/).map((x) => x.trim()).filter(Boolean)
const BLANK_CELL = /^(—|-|–|―|なし)?$/

function sectionsOf2(md) {
  const lines = String(md || '').split('\n')
  const secs = []
  let cur = { heading: '', start: 0, lines: [] }
  let inFence = false
  lines.forEach((ln, i) => {
    if (/^\s*(```|~~~)/.test(ln)) inFence = !inFence
    if (!inFence && /^##\s/.test(ln)) {
      secs.push(cur)
      cur = { heading: ln.replace(/^##\s+/, '').trim(), start: i, lines: [] }
    }
    cur.lines.push(ln)
  })
  secs.push(cur)
  return secs
}

function tablesOf(sec) {
  const tables = []
  let lastHeading = sec.heading
  for (let i = 0; i < sec.lines.length; i++) {
    const hm = /^#{2,6}\s+(.*)$/.exec(sec.lines[i])
    if (hm) lastHeading = hm[1].trim()
    const header = cellsOf(sec.lines[i])
    if (!header || !isSeparator(cellsOf(sec.lines[i + 1] || ''))) continue
    const rows = []
    let j = i + 2
    for (; j < sec.lines.length; j++) {
      const cells = cellsOf(sec.lines[j])
      if (!cells) break
      rows.push({ line: sec.start + j + 1, cells })
    }
    tables.push({ line: sec.start + i + 1, heading: lastHeading, header, rows })
    i = j - 1
  }
  return tables
}

// quoteParagraphs: 節の中の引用段落（連続する `>` 行を 1 つに連結したもの）。軸の宣言が複数行に折れていても
// 拾う。宣言の書き出し（「対象の状態:」「条件の値:」など）の行と空の `>` 行は新しい段落を始める —
// 続けて並べた 2 つの宣言を 1 つに連結すると、状態の軸の末尾にイベントの宣言が混ざる。
const AXIS_START = /^(対象[^:：]{0,6}(状態|イベント)|条件の値)\s*[:：]/
function quoteParagraphs(sec) {
  const paras = []
  let cur = null
  for (const ln of sec.lines) {
    const m = /^\s*>\s?(.*)$/.exec(ln)
    if (m) {
      const t = m[1].trim()
      if (cur !== null && (!t || AXIS_START.test(t))) {
        paras.push(cur)
        cur = null
      }
      // 和文の折り返しは空白を挟まずにつなぐ（挟むと「件数が 増える」になり、表のイベント名と一致しない）。
      if (t) cur = cur === null ? t : /[\x00-\x7f]$/.test(cur) || /^[\x00-\x7f]/.test(t) ? `${cur} ${t}` : `${cur}${t}`
      continue
    }
    if (cur !== null) paras.push(cur)
    cur = null
  }
  if (cur !== null) paras.push(cur)
  return paras
}

// stateDiagramOf: 節の中の mermaid stateDiagram の辺。`A --> B : ラベル` だけを読む
// （state 定義・note・複合状態は読まない。読めない行は辺として数えない）。
function stateDiagramOf(sec) {
  const edges = []
  let inFence = false
  let isState = false
  let found = false
  for (const ln of sec.lines) {
    if (/^\s*(```|~~~)/.test(ln)) {
      inFence = !inFence
      isState = false
      continue
    }
    if (!inFence) continue
    if (/^\s*stateDiagram/.test(ln)) {
      isState = true
      found = true
      continue
    }
    if (!isState) continue
    const m = /^\s*(.+?)\s*-->\s*(.+?)\s*$/.exec(ln)
    if (!m || /^\s*%%/.test(ln)) continue
    const [to, ...rest] = m[2].split(/\s*:\s*/)
    edges.push({ from: m[1].trim(), to: to.trim(), label: rest.join(':').trim() })
  }
  return found ? edges : null
}

function namesIn(text, names) {
  let rest = String(text || '')
  const hits = []
  for (const n of [...names].sort((a, b) => b.length - a.length)) {
    if (!n || !rest.includes(n)) continue
    hits.push(n)
    rest = rest.split(n).join('\u0000')
  }
  return hits
}

function stateCheck(d, sec, out, fallbackEdges) {
  const tables = tablesOf(sec).filter((t) => {
    const h = t.header
    return h.includes('現在の状態') && h.includes('次の状態') && h.some((c) => c.includes('イベント'))
  })
  // 図が同じ節に無ければ、文書に 1 つだけある図を使う（図と表を別の ## 節に置いた文書で、到達・出口・
  // 表と図の突き合わせが黙って検査されなくなるのを防ぐ）。図が複数あって節で決まらないときは使わない。
  const edges = stateDiagramOf(sec) || fallbackEdges || null
  if (!tables.length) return
  const paras = quoteParagraphs(sec)
  const axisOf = (re) => {
    const p = paras.find((x) => re.test(x))
    return p ? splitAxis(p.replace(re, '')) : null
  }
  const declaredStates = axisOf(/^対象[^:：]{0,6}状態\s*[:：]\s*/)
  const eventItems = axisOf(/^対象[^:：]{0,6}イベント\s*[:：]\s*/)
  const events = (eventItems || []).map((s) => {
    const m = /^([A-Z][A-Z0-9]*\d+)\s+(.+)$/.exec(s)
    return m ? { code: m[1], name: m[2].trim(), label: m[1] } : { code: '', name: s, label: s }
  })
  const squash = (x) => String(x || '').replace(/\s+/g, '')
  const eventOf = (cell) => {
    const c = String(cell || '').trim()
    return events.find((e) => (e.code && (c === e.code || squash(c) === squash(`${e.code} ${e.name}`))) || squash(c) === squash(e.name)) || null
  }
  const diagramEdges = (edges || []).filter((e) => e.from !== '[*]' || e.to !== '[*]')
  const terminal = new Set(diagramEdges.filter((e) => e.to === '[*]').map((e) => e.from))
  const diagramStates = new Set(diagramEdges.flatMap((e) => [e.from, e.to]).filter((s) => s !== '[*]'))
  const tableStates = new Set(tables.flatMap((t) => t.rows.map((r) => r.cells[t.header.indexOf('現在の状態')])))
  const axisStates = declaredStates || (edges ? [...diagramStates] : [...tableStates])
  const allStates = new Set([...axisStates, ...diagramStates])
  const key = d.key
  if (!events.length) {
    out.push({ c: 'STATE_NOAXIS', d: key, a: [key, sec.heading || '(冒頭)'] })
  }
  const cells = new Map()
  const cellOf = (s, e) => {
    const k = `${s}\u0000${e}`
    if (!cells.has(k)) cells.set(k, { s, e, targets: new Set(), noop: false, open: false })
    return cells.get(k)
  }
  const transitions = []
  for (const t of tables) {
    const col = (pred) => t.header.findIndex(pred)
    const cS = col((c) => c === '現在の状態')
    const cE = col((c) => c.includes('イベント'))
    const cN = col((c) => c === '次の状態')
    const cD = col((c) => c.includes('定義済み'))
    for (const r of t.rows) {
      const s = r.cells[cS] || ''
      const eCell = r.cells[cE] || ''
      const next = r.cells[cN] || ''
      const note = cD >= 0 ? r.cells[cD] || '' : ''
      if (!allStates.has(s)) out.push({ c: 'STATE_AXIS', d: key, a: [key, s, eCell, '現在の状態', s] })
      const ev = events.length ? eventOf(eCell) : { label: eCell }
      if (!ev) {
        out.push({ c: 'STATE_AXIS', d: key, a: [key, s, eCell, 'イベント', eCell] })
        continue
      }
      const cell = cellOf(s, ev.label)
      if (note.includes('発生しない') || next.startsWith('発生しない')) {
        cell.noop = true
        continue
      }
      if (/❌|未定義/.test(note)) {
        cell.open = true
        if (!/TBD-[A-Z]/.test(note)) out.push({ c: 'STATE_NO_NEXT', d: key, a: [key, s, ev.label] })
        continue
      }
      const named = namesIn(next, allStates)
      if (!named.length) {
        if (BLANK_CELL.test(next.trim())) out.push({ c: 'STATE_NO_NEXT', d: key, a: [key, s, ev.label] })
        else out.push({ c: 'STATE_AXIS', d: key, a: [key, s, ev.label, '次の状態', next] })
        continue
      }
      for (const n of named) {
        cell.targets.add(n)
        transitions.push({ from: s, to: n })
      }
      for (const other of namesIn(note, allStates)) {
        if (other === s || named.includes(other)) continue
        out.push({ c: 'STATE_HIDDEN', d: key, a: [key, s, ev.label, other] })
      }
    }
  }
  // 図の辺のうちラベルが軸のイベントで始まらないものは、イベントでない条件による主フローなので表とは突き合わせない。
  const diagramByCell = new Map()
  for (const e of diagramEdges) {
    if (e.from === '[*]' || e.to === '[*]') continue
    transitions.push({ from: e.from, to: e.to })
    const ev = events.find((x) => (x.code && new RegExp(`^${x.code}(?![0-9])`).test(e.label)) || (x.name && e.label.startsWith(x.name)))
    if (!ev) continue
    const k = `${e.from}\u0000${ev.label}`
    if (!diagramByCell.has(k)) diagramByCell.set(k, { s: e.from, e: ev.label, targets: new Set() })
    diagramByCell.get(k).targets.add(e.to)
  }
  for (const cell of cells.values()) {
    const g = diagramByCell.get(`${cell.s}\u0000${cell.e}`)
    if (cell.targets.size > 1) out.push({ c: 'STATE_NONDET', d: key, a: [key, cell.s, cell.e, [...cell.targets].join(' / ')] })
    if (g && (cell.noop || [...g.targets].some((t) => !cell.targets.has(t)) || (cell.targets.size && [...cell.targets].some((t) => !g.targets.has(t))))) {
      const tableTo = cell.noop ? '発生しない' : cell.open ? '未定義' : [...cell.targets].join(' / ')
      out.push({ c: 'STATE_DIAGRAM_CONFLICT', d: key, a: [key, cell.s, cell.e, tableTo, [...g.targets].join(' / ')] })
    }
  }
  for (const g of diagramByCell.values()) {
    if (cells.has(`${g.s}\u0000${g.e}`)) continue
    if (g.targets.size > 1) out.push({ c: 'STATE_NONDET', d: key, a: [key, g.s, g.e, [...g.targets].join(' / ')] })
  }
  if (events.length) {
    for (const s of axisStates) {
      for (const e of events) {
        if (cells.has(`${s}\u0000${e.label}`) || diagramByCell.has(`${s}\u0000${e.label}`)) continue
        out.push({ c: 'STATE_MISSING', d: key, a: [key, s, e.label] })
      }
    }
  }
  // 到達と出口は初期状態（[*] --> X）を持つ図があるときだけ判定する。初期状態が無いと起点が決まらない。
  const initial = diagramEdges.filter((e) => e.from === '[*]').map((e) => e.to)
  if (initial.length) {
    const nexts = new Map()
    for (const t of transitions) {
      if (!nexts.has(t.from)) nexts.set(t.from, new Set())
      nexts.get(t.from).add(t.to)
    }
    const seen = new Set()
    const queue = [...initial]
    while (queue.length) {
      const s = queue.shift()
      if (seen.has(s)) continue
      seen.add(s)
      queue.push(...(nexts.get(s) || []))
    }
    for (const s of allStates) {
      if (!seen.has(s)) out.push({ c: 'STATE_UNREACHABLE', d: key, a: [key, s] })
      const exits = [...(nexts.get(s) || [])].filter((to) => to !== s)
      if (!terminal.has(s) && !exits.length) out.push({ c: 'STATE_DEADEND', d: key, a: [key, s] })
    }
  }
}

const DT_WILDCARD = /^(\*|—|-|–|任意)?$/
const DT_MAX_COMBOS = 4096
function decisionCheck(d, sec, out, notChecked) {
  const domains = new Map()
  for (const p of quoteParagraphs(sec)) {
    const m = /^条件の値\s*[:：]\s*(.+?)\s*=\s*(.+)$/.exec(p)
    if (m) domains.set(m[1].trim(), splitAxis(m[2]))
  }
  const seenLabels = new Map()
  for (const t of tablesOf(sec)) {
    const condCols = t.header.map((c, i) => ({ i, m: /^条件\s*[:：]\s*(.+)$/.exec(c) })).filter((x) => x.m)
    const resCol = t.header.findIndex((c) => /^結果/.test(c))
    if (!condCols.length || resCol < 0) continue
    const n = (seenLabels.get(t.heading) || 0) + 1
    seenLabels.set(t.heading, n)
    const label = n > 1 ? `${t.heading}#${n}` : t.heading
    const conds = condCols.map((x) => ({ i: x.i, name: x.m[1].trim() }))
    const rows = t.rows.map((r, k) => ({
      no: k + 1,
      vals: conds.map((c) => String(r.cells[c.i] || '').trim()),
      res: String(r.cells[resCol] || '').trim(),
    }))
    const isElse = (r) => r.vals[0] === '上記以外' || r.vals.every((v) => DT_WILDCARD.test(v))
    const tableConds = conds.map((c) => ({ name: c.name, values: domains.get(c.name) || null }))
    for (const f of tableFindings(tableConds, rows.filter((r) => !isElse(r)), rows.some(isElse))) {
      if (f.kind === 'value') out.push({ c: 'DT_VALUE', d: d.key, a: [d.key, label, f.name, f.value] })
      if (f.kind === 'too_many') notChecked.push({ c: 'NC_DTABLE', a: [d.key, label, f.total] })
      if (f.kind === 'gap') out.push({ c: 'DT_GAP', d: d.key, a: [d.key, label, f.combo] })
      if (f.kind === 'overlap') out.push({ c: 'DT_OVERLAP', d: d.key, a: [d.key, label, f.combo, f.a, f.b] })
    }
  }
}

// tableFindings: 文書の判定表と flow の decision の両方がこれを呼ぶ（展開の実装を 1 つに保つ）。
function tableFindings(conds, rows, hasElse) {
  const found = []
  // 宣言外の値は (条件, 値) ごとに 1 件にする。行ごとに出すと、同じ値が 4 行にあれば同じ id の指摘が
  // 4 件になり、writer への指摘と報告の件数が水増しされる（行番号は id に入らない）。
  const reported = new Set()
  const doms = conds.map((c, ci) => {
    if (c.values) {
      for (const r of rows) {
        const v = r.vals[ci]
        if (DT_WILDCARD.test(v) || c.values.includes(v) || reported.has(`${c.name}\u0000${v}`)) continue
        reported.add(`${c.name}\u0000${v}`)
        found.push({ kind: 'value', name: c.name, value: v })
      }
      return c.values
    }
    return [...new Set(rows.map((r) => r.vals[ci]).filter((v) => !DT_WILDCARD.test(v)))]
  })
  const matches = (r, combo) => r.vals.every((v, ci) => DT_WILDCARD.test(v) || v === combo[ci])
  const comboText = (combo) => conds.map((c, ci) => `${c.name}=${combo[ci]}`).join(', ')
  const total = doms.reduce((p, x) => p * Math.max(1, x.length), 1)
  if (total > DT_MAX_COMBOS) return [...found, { kind: 'too_many', total }]
  let combos = [[]]
  for (const dom of doms) combos = combos.flatMap((pre) => (dom.length ? dom : ['']).map((v) => [...pre, v]))
  for (const combo of combos) {
    const hit = rows.filter((r) => matches(r, combo))
    if (!hit.length && !hasElse) found.push({ kind: 'gap', combo: comboText(combo) })
    const results = new Set(hit.map((r) => r.res))
    if (results.size > 1) {
      const a = hit[0]
      const b = hit.find((r) => r.res !== a.res)
      found.push({ kind: 'overlap', combo: comboText(combo), a: a.no, b: b.no })
    }
  }
  return found
}

// flow が undefined（入力に flow キーが無い）なら flow の検査を行わない。null は「渡されるはずが
// 無かった」ではなく「無い」の申告なので未検査として返す。
function formalCompact(docs, flow) {
  const out = []
  const notChecked = []
  for (const d of docs) {
    if (d.fixed || !d.markdown) continue
    const secs = sectionsOf2(d.markdown)
    const diagrams = secs.map((sec) => stateDiagramOf(sec)).filter(Boolean)
    const fallback = diagrams.length === 1 ? diagrams[0] : null
    for (const sec of secs) {
      stateCheck(d, sec, out, fallback)
      decisionCheck(d, sec, out, notChecked)
    }
  }
  if (flow === null) {
    if (docs.some((d) => !d.fixed)) notChecked.push({ c: 'NC_FLOW', a: [] })
  } else if (flow !== undefined) {
    out.push(...flowGraphCompact(flow))
    const elements = Array.isArray(flow && flow.elements) ? flow.elements.filter((el) => el && el.id) : []
    const known = new Set(elements.map((el) => el.id))
    const attachedBy = new Map()
    for (const d of docs) {
      for (const r of Array.isArray(d.flow_refs) ? d.flow_refs : []) {
        if (!r || !r.ref) continue
        if (!known.has(r.ref)) {
          out.push({ c: 'FLOW_UNKNOWN_REF', d: d.key, a: [r.item_id || '?', r.ref] })
          continue
        }
        if (!attachedBy.has(r.ref)) attachedBy.set(r.ref, new Set())
        attachedBy.get(r.ref).add(d.key)
      }
    }
    // 当たっていない要素は、隣の要素に項目を当てている文書へ返す（その工程の関心事を持っている
    // 可能性が最も高い）。隣にも無ければ最初の非固定の仕様書、無ければ最初の非固定の文書へ返す。
    const editable = docs.filter((d) => !d.fixed)
    const fallback = (editable.find((d) => d.kind === 'specifications') || editable[0] || {}).key
    const neighbours = new Map(elements.map((el) => [el.id, new Set()]))
    for (const el of elements) {
      const targets = [...(Array.isArray(el.next) ? el.next : []), ...(Array.isArray(el.branches) ? el.branches.map((b) => b && b.next) : [])]
      for (const to of targets) {
        if (!neighbours.has(to)) continue
        neighbours.get(el.id).add(to)
        neighbours.get(to).add(el.id)
      }
    }
    for (const el of elements) {
      if (attachedBy.has(el.id)) continue
      const near = [...neighbours.get(el.id)].flatMap((n) => [...(attachedBy.get(n) || [])])
      const owner = editable.map((d) => d.key).find((k) => near.includes(k)) || fallback
      if (owner) out.push({ c: 'FLOW_UNATTACHED', d: owner, a: [el.id, String(el.label || '')] })
    }
  }
  return { findings: out, not_checked: notChecked }
}

// 構造検査の正本はこのファイルだけである。Workflow script は複製を持たず、agent にこの CLI を実行させる。
// not_checked は「材料が無くて実行できなかった検査」で、失格ではない。これを返さないと、片側の文書が対象外のランで
// 「検査して 0 件」と「そもそも検査していない」が区別できず、後者が合格として提示される。
function structuralCompact(docs, flow) {
  const out = []
  const notChecked = []
  const reqDocs = docs.filter((d) => d.kind === 'requirements')
  const specDocs = docs.filter((d) => d.kind === 'specifications')
  // 申告済み TBD の全体集合。固定文書の申告も数える（その TBD は実在するため）。
  const tbdDeclaredAll = new Set(
    docs.flatMap((d) => (d.tbd_items || []).map((t) => t && t.id).filter(Boolean))
  )

  // (1) 文書を跨いだ ID の重複。同じ ID を 2 文書が
  //     定義すると、トレーサビリティ表がどちらを指すか決まらず、紐付け自体が意味を失う。
  const owners = new Map()
  for (const d of docs) {
    for (const id of d.ids) {
      if (!owners.has(id)) owners.set(id, [])
      if (!owners.get(id).includes(d.key)) owners.get(id).push(d.key)
    }
  }
  const fixedKeys = new Set(docs.filter((d) => d.fixed).map((d) => d.key))
  const fixable = (keys) => keys.find((k) => !fixedKeys.has(k)) || keys[0]
  for (const [id, keys] of owners) {
    if (keys.length < 2) continue
    out.push({ c: 'DUP', d: fixable(keys), a: [id, keys] })
  }

  // (1b) TBD ID の文書跨ぎ重複。分割文書は並列で執筆されるため、互いの採番を知らない
  //      writer が同じ TBD-003 を別の論点に振りうる。統合時に片方が黙って消え、
  //      消えた側が blocking だと「聞くべき項目が最初から存在しなかった」ことになる。
  const tbdOwners = new Map()
  for (const d of docs) {
    for (const t of d.tbd_items || []) {
      if (!t || !t.id) continue
      if (!tbdOwners.has(t.id)) tbdOwners.set(t.id, [])
      const rec = tbdOwners.get(t.id)
      if (!rec.some((r) => r.key === d.key)) rec.push({ key: d.key, text: t.text })
    }
  }
  for (const [id, recs] of tbdOwners) {
    if (recs.length < 2) continue
    out.push({ c: 'DUP_TBD', d: fixable(recs.map((r) => r.key)), a: [id, recs.map((r) => r.key), recs[0].text, recs[1].text] })
  }

  if (!reqDocs.length || !specDocs.length) {
    notChecked.push({ c: 'NC_CROSSREF', a: [!reqDocs.length ? 'requirements' : 'specifications'] })
  }
  if (reqDocs.length && specDocs.length) {
    const reqIds = new Set(reqDocs.flatMap((d) => d.ids))
    const specIds = new Set(specDocs.flatMap((d) => d.ids))
    const links = specDocs.flatMap((d) => (d.traceability || []).map((l) => ({ ...l, from: d.key })))
    const linkedReq = new Set(links.map((l) => l.requirement_id).filter(Boolean))
    const linkedSpec = new Set(links.map((l) => l.spec_id).filter(Boolean))

    // 要求 → 仕様の紐付けは仕様書の側が負う。ラン内で書く仕様書が実現する要求文書に限って問う（要求文書だけを書くランや
    // 固定の文書で問うと、そのランでは直せない指摘が blocking に積もり、改稿と監査が上限まで空回りする）。
    // 要求文書と仕様書を同じランで書くときは、書いている要求文書を covers の書き漏らしに左右させない。
    const writingSpecs = specDocs.filter((d) => !d.fixed)
    const covered = new Set(
      writingSpecs.length
        ? [
            ...reqDocs.filter((d) => !d.fixed).map((d) => d.key),
            ...writingSpecs.flatMap((d) => [
              ...(Array.isArray(d.covers) ? d.covers : []),
              ...(d.traceability || []).flatMap((l) => (l.requirement_id && owners.get(l.requirement_id)) || []),
            ]),
          ]
        : []
    )
    for (const id of reqIds) {
      if (linkedReq.has(id)) continue
      const owner = (owners.get(id) || ['requirements'])[0]
      if (!covered.has(owner)) continue
      out.push({ c: 'ORPHAN_REQ', d: owner, a: [id] })
    }
    for (const id of specIds) {
      if (linkedSpec.has(id)) continue
      const owner = (owners.get(id) || ['specifications'])[0]
      out.push({ c: 'ORPHAN_SPEC', d: owner, a: [id] })
    }
    for (const link of links) {
      if (link.requirement_id && !reqIds.has(link.requirement_id)) {
        out.push({ c: 'DANGLING_REQ', d: link.from, a: [link.requirement_id] })
      }
      if (link.spec_id && !specIds.has(link.spec_id)) {
        out.push({ c: 'DANGLING_SPEC', d: link.from, a: [link.spec_id] })
      }
    }
  }

  for (const d of docs) {
    if (!d.markdown) continue

    // (3) 申告された ID 一覧と、本文に実在する ID の突き合わせ。片側にしか現れない ID の集合差分は agent の
    //     自己申告同士を比べているだけなので、本文を独立に見るこの検査が無いと
    //     「本文にあるのに一覧にも表にも載せなかった ID」を検出できない。
    //     固定文書（本ランの対象外・既存本文をそのまま持つもの）は agent の自己申告が
    //     存在しないので、この検査の対象にしない（申告漏れは申告があって初めて定義できる）。
    const re = ID_IN_TEXT[d.kind]
    const kindCode = d.kind === 'requirements' ? 'R' : 'S'
    const inText = new Set(d.markdown.match(re) || [])
    const inList = new Set(d.ids)
    const referenced = new Set(d.referenced || [])
    // 欠番（vacant）は items（実在の項目）にも referenced_ids（他文書参照・体系の例示）にも
    // 属さない第三の類型であり、欠番の列挙は表記規約が要求する記載である。申告（vacant_ids）と
    // 本文の行併記（「欠番」の語と同じ行にある ID）の和で認識する。行単位に絞るのは、文書全体の
    // includes で判定すると「欠番」の語が一度でもあれば全 ID が免除され、本物の申告漏れを
    // 隠すため。この認識が無いと、欠番宣言を持つ文書で ST-UNDECLARED が毎 run 再発する（棄却は run を跨いで
    // 持ち越されないため、検査側で認識しない限り止まらない）。
    const vacantDeclared = new Set(d.vacant || [])
    for (const line of d.markdown.split('\n')) {
      if (!line.includes('欠番')) continue
      for (const id of line.match(re) || []) vacantDeclared.add(id)
    }
    // 欠番と実在の両方に載る ID は矛盾（欠番は「割り当てられていない」の宣言であり、
    // 実在する項目と両立しない）。どちらの申告が正しいか読み手に判断させない。
    for (const id of d.fixed ? [] : new Set(d.vacant || [])) {
      if (!inList.has(id)) continue
      out.push({ c: 'VACANT_CONFLICT', d: d.key, a: [kindCode, id] })
    }
    for (const id of d.fixed ? [] : inText) {
      if (inList.has(id) || referenced.has(id) || vacantDeclared.has(id)) continue
      out.push({ c: 'UNDECLARED', d: d.key, a: [kindCode, id] })
    }
    // (3b) 本文が引く TBD ID と、申告された tbd_items の突き合わせ。(3) と同じ理屈だが、
    //      壊れる先が違う。申告に載らない TBD は blocking の集計から外れるため、
    //      本文に「まだ決まっていない」と書いてあるのに **未提示の blocking が 0 件**という
    //      完成判定を素通りする。決まっていないことを決まった風に提示する状態そのものであり、
    //      このスキルが防ぐと宣言した失敗に該当する。だから agent の判断に委ねず算術で押さえる。
    const tbdInText = new Set(d.markdown.match(TBD_ID_IN_TEXT) || [])
    for (const id of d.fixed ? [] : tbdInText) {
      // 申告は文書を跨いで有効。仕様書が要求文書の TBD を引くのは、ID が文書を跨いで一意で
      // あることの帰結であり正しい参照である。ここを文書ローカルで突き合わせると、その参照が
      // すべて「申告漏れ」に化け、writer が直せない指摘を抱えて改稿枠を空回りさせる。守りたいのは「どの文書にも申告されていない
      // TBD が blocking の集計から外れること」なので、全文書の申告の和で判定する。
      if (tbdDeclaredAll.has(id)) continue
      out.push({ c: 'UNDECLARED_TBD', d: d.key, a: [id] })
    }

    for (const id of d.fixed ? [] : inList) {
      if (inText.has(id)) continue
      out.push({ c: 'PHANTOM', d: d.key, a: [kindCode, id] })
    }

    // (3c) ID 連番の欠番の無申告。欠番そのものは許す（採番を詰める改稿を強制しない）が、
    //      無申告の欠番は「項目が削除された」のか「最初から無い」のか読み手が区別できず、
    //      統合時の取りこぼしと見分けが付かない。本文に「欠番」の語と当該 ID が同じ行に
    //      併記されていれば申告済みとして起票しない（(3) の除外と同じ vacantDeclared 基準。
    //      基準を分けると「(3c) は通るのに (3) が落ちる」行またぎの取りこぼしが生じる）。
    //      固定文書は自己申告（ids）を持たないので対象外。
    const gapPrefixes = new Map()
    for (const id of d.fixed ? [] : d.ids) {
      const m = /^(.*-)(\d+)$/.exec(id)
      if (!m) continue
      if (!gapPrefixes.has(m[1])) gapPrefixes.set(m[1], [])
      gapPrefixes.get(m[1]).push({ n: Number(m[2]), w: m[2].length })
    }
    for (const [gapPrefix, nums] of gapPrefixes) {
      if (nums.length < 2) continue
      const sorted = [...nums].sort((a, b) => a.n - b.n)
      const width = sorted[sorted.length - 1].w
      const present = new Set(sorted.map((e) => e.n))
      for (let n = sorted[0].n + 1; n < sorted[sorted.length - 1].n; n++) {
        if (present.has(n)) continue
        const missingId = `${gapPrefix}${String(n).padStart(width, '0')}`
        if (vacantDeclared.has(missingId)) continue
        out.push({ c: 'GAP', d: d.key, a: [missingId] })
      }
    }

    // (4) 廃止済み規制の語。完全一致なので機械検査が正しい形（agent の善意に載せない）。
    const lower = d.markdown.toLowerCase()
    for (const term of OBSOLETE_TERMS) {
      if (!lower.includes(term)) continue
      out.push({ c: 'OBSOLETE', d: d.key, a: [term, d.key] })
    }
    // DHF は略語。'design history file' が既に検出されていれば同じ記述を 2 件に数えない。
    if (!lower.includes('design history file') && /\bDHF\b/.test(d.markdown)) {
      out.push({ c: 'OBSOLETE_DHF', d: d.key, a: [d.key] })
    }

    // (5) 本文を確認できていない有料規格の条番号引用。規格名の直後に節番号が続く形だけを拾う。
    for (const std of UNVERIFIABLE_STANDARDS) {
      const pattern = new RegExp(`${std}[^。\\n]{0,20}?${CLAUSE_REF}`)
      if (!pattern.test(d.markdown)) continue
      out.push({ c: 'UNVERIFIED', d: d.key, a: [std, d.key] })
    }

    // (6) 品質チェックリストが「機械」と宣言する検査の script 実装。いずれも severity は
    //     degraded（着手は止めない）で、fix は方向のみを示す。機械的に判別できない行は
    //     起票しない — 偽陽性は writer の改稿枠を空回りさせるため、取りこぼしより有害である。
    if (d.kind === 'specifications' && !d.fixed) {
      // (6a) 仕様項目の単位の自己宣言。何を 1 仕様項目とするかを本文の一箇所で宣言していないと、
      //      読み手ごとに項目の切り出し方が変わり、件数・網羅の判定が文書間で揃わない。
      //      宣言の実在だけを機械判定する（宣言内容の妥当性は厳密に判定できないので検査しない）。
      if (!/仕様項目の単位|(1\s*(つの)?|一つの)仕様項目とす/.test(d.markdown)) {
        out.push({ c: 'NOUNIT', d: d.key, a: [d.key] })
      }
    }
    if (d.kind === 'requirements' && !d.fixed) {
      // (6b) 要求文の語尾照合。4 語尾は活用形（五段動詞「含まなければならない」「置かなければ
      //      ならない」等）に対応するため後方一致（なければならない / てはならない /
      //      ことが望ましい / てもよい）で判定する。literal 照合（「〜しなければならない」の
      //      丸ごと一致）は五段動詞の語尾を偽陽性にするので使わない。規範の意図が機械的に
      //      判別できる文だけを起票し、である調の宣言文・表・注記・根拠欄は対象にしない
      //      （除外判定が機械的にできない行も起票しない — 偽陽性回避を優先する）。
      const bodyLines = d.markdown.split('\n')
      const idHeadings = []
      for (let i = 0; i < bodyLines.length; i++) {
        const hm = /^(#{1,6})\s/.exec(bodyLines[i])
        if (!hm) continue
        const hIds = bodyLines[i].match(ID_IN_TEXT.requirements)
        if (hIds) idHeadings.push({ line: i, level: hm[1].length, id: hIds[0] })
      }
      const levelCount = new Map()
      for (const h of idHeadings) levelCount.set(h.level, (levelCount.get(h.level) || 0) + 1)
      let baseLevel = 0
      for (const [lv, c] of levelCount) {
        if (!baseLevel || c > levelCount.get(baseLevel) || (c === levelCount.get(baseLevel) && lv < baseLevel)) baseLevel = lv
      }
      const MODAL_OK = /(なければならない|てはならない|ことが望ましい|てもよい)$/
      const MODAL_INTENT = /(すべきである|すべきだ|する必要がある|することとする|ものとする|推奨する|推奨される|必須である|すること)$/
      for (let k = 0; k < idHeadings.length; k++) {
        if (idHeadings[k].level !== baseLevel) continue
        const start = idHeadings[k].line + 1
        let end = bodyLines.length
        for (let i = start; i < bodyLines.length; i++) {
          if (/^#{1,6}\s/.test(bodyLines[i])) { end = i; break }
        }
        let sent = 0
        for (let i = start; i < end; i++) {
          const t = bodyLines[i].trim()
          if (!t || /^[|>\-*`#!（(※]/.test(t) || /^注/.test(t) || t.includes('根拠')) continue
          for (const s of t.split('。')) {
            const body = s.trim()
            if (!body) continue
            sent++
            if (MODAL_OK.test(body)) continue
            if (!MODAL_INTENT.test(body)) continue
            out.push({ c: 'MODAL', d: d.key, a: [idHeadings[k].id, sent, body.slice(-40)] })
          }
        }
      }
      // (6c) ID を含む見出しのレベルが文書内で不統一。基準レベル（最頻値。同数なら浅い方）
      //      以外に ID 見出しが散在すると、読み手が「章の中の区分」と「個別項目」を階層で
      //      見分けられず、目次の機械生成でも構造が崩れる。
      if (levelCount.size > 1) {
        for (const h of idHeadings) {
          if (h.level === baseLevel) continue
          out.push({ c: 'IDHEADING', d: d.key, a: [h.id, h.level, baseLevel] })
        }
      }
      // (6d) 解消条件の無い blocking TBD。何が決まればこの項目が解消するかが書かれていないと、
      //      「着手を止める」とだけ言われた読み手は先へ進む条件を知れない。「解消」の語の
      //      実在で機械判定する（申告 text か、本文中で当該 ID と同じ行にあるかのいずれか）。
      for (const t of d.tbd_items || []) {
        if (!t || !t.blocking || !t.id) continue
        if (String(t.text || '').includes('解消')) continue
        if (bodyLines.some((ln) => ln.includes(t.id) && ln.includes('解消'))) continue
        out.push({ c: 'TBD_NORESOLVE', d: d.key, a: [t.id] })
      }
    }
  }


  // (7) 根拠の所在。納品文書の本文には根拠句を書かない規約（document-structure.md §4）に
  //     したため、「どの記述がどこから来たか」は meta の trace にしか無い。trace が
  //     欠けた項目は、本文からも返り値からも根拠を辿れず、出所不明の断定と区別できない。
  //     ここを検査しないと、本文から根拠句を消した瞬間に grounding の監査の入力が消え、
  //     指摘 0 件が「健全」に化ける。
  for (const d of docs) {
    if (d.fixed) continue
    if (!Array.isArray(d.trace)) {
      notChecked.push({ c: 'NC_TRACE', a: [d.key] })
    } else {
      const traced = new Set(d.trace.map((t) => t && t.item_id).filter(Boolean))
      for (const id of d.ids) {
        if (traced.has(id)) continue
        out.push({ c: 'NO_EVIDENCE', d: d.key, a: [id] })
      }
    }
  }

  // (8) 本文に混ざった非規範の記述。納品文書に置いてよいのは規範文・ID・上位/姉妹文書への
  //     参照・自明でない規則の 1 文 inline の why だけである。根拠句・決定ログ・採らなかった
  //     案・未確定事項の章は、読み手（後続の実装者と AI）が従うべき規範を薄めるだけであり、
  //     経緯は git commit / PR 本文に残す。文字列は旧規約が定めていた定型なので機械照合できる。
  const NON_NORMATIVE = [
    { re: /（既定[:：]/, what: '決定ログの出所表記' },
    { re: /（スキル既定[:：]/, what: 'スキル既定の出所表記' },
    { re: /^#{1,6}\s*(決定ログ|決定の記録|検討の経緯|採用しなかった案|代替案の検討|未確定事項|TBD)\s*$/, what: '経緯・未確定事項の章' },
  ]
  for (const d of docs) {
    if (d.fixed || !d.markdown) continue
    for (const p of NON_NORMATIVE) {
      const hit = String(d.markdown).split('\n').find((ln) => p.re.test(ln))
      if (!hit) continue
      out.push({ c: 'NON_NORMATIVE', d: d.key, a: [p.what, hit.trim().slice(0, 60), d.key] })
    }
  }

  // (9) 状態 × イベント表・判定表・工程の流れ（flow）の閉包。文書内の整合と閉包の欠陥であり、
  //     依頼者に聞く論点ではない（writer が表と項目を直せば閉じる）。
  const formal = formalCompact(docs, flow)
  out.push(...formal.findings)
  notChecked.push(...formal.not_checked)

  // 同じ種別・同じ文書が続く指摘を 1 要素にまとめる（ORPHAN / GAP は数百件が連続する）。
  const grouped = []
  for (const f of out) {
    const last = grouped[grouped.length - 1]
    if (last && last.c === f.c && last.d === f.d) last.a.push(f.a)
    else grouped.push({ c: f.c, d: f.d, a: [f.a] })
  }
  return { findings: grouped, not_checked: notChecked }
}

function stableKey(text) {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36).padStart(7, '0').slice(-7)
}


// canonicalJson: キーを並べ替えた JSON。中身が同じなら同じ文字列になる形で digest を取る
// （snapshot・diff・tree-digest の digest がキー順や空白で揺れないようにする）。
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value === undefined ? null : value)
}

// STDOUT_FNV・stampStdout: CLI の stdout の本体の digest の欄。agent は stdout を返り値に手で写すので、prd-spec.js は写しの本体から
// canonicalText・fnv で計算し直し、合わない写し（壊れた JSON・要素の欠けた一覧）を受け取らない。canonicalText・fnv・STDOUT_FNV は
// prd-spec.js と同じ（tests が照合する）。
const STDOUT_FNV = 'stdout_fnv'
function canonicalText(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalText).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${k}:${canonicalText(v[k])}`).join(',')}}`
  return `${typeof v}:${String(v)}`
}

function fnv(text) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0
  return h.toString(16).padStart(8, '0')
}

function stampStdout(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const body = JSON.parse(JSON.stringify(value))
  return { ...body, [STDOUT_FNV]: fnv(canonicalText(body)) }
}

// structuralFindings: 文面付きの形で返す版（tests と、文面を直接見たい呼び出し側のため）。
// CLI の出力は structuralCompact の短い形で、文面は受け取った側が expandStructural で組み立てる。
function structuralFindings(docs, flow) {
  return expandStructural(structuralCompact(docs, flow))
}

function headingIndex(md) {
  const lines = String(md || '').split('\n')
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  const heads = []
  let inFence = false
  lines.forEach((ln, i) => {
    if (/^\s*(```|~~~)/.test(ln)) inFence = !inFence
    const m = !inFence && /^(#{2,4})\s/.exec(ln)
    if (m) heads.push({ level: m[1].length, start: i + 1, heading: ln.trim() })
  })
  return heads.map((h, k) => {
    const next = heads.slice(k + 1).find((x) => x.level <= h.level)
    return { ...h, end: next ? next.start - 1 : lines.length }
  })
}

// writeIndex: 監査役・writer は
// 他文書や固定文書の本文を通読する代わりにこれを読み、要る節だけを行範囲で Read する。本文を
// 出力に載せないので、agent が書き写す量は増えない。書けなければ null（呼び出し側は Grep で
// 見出しを列挙させる経路に戻る）。
function writeIndex(indexDir, name, docPath, md) {
  const entries = headingIndex(md)
  const text =
    [`# 見出し索引: ${docPath}（${lineTotal(md)} 行。各行は「開始-終了 見出し」。本文はこの範囲を offset/limit で Read する）`]
      .concat(entries.map((e) => `${e.start}-${e.end} ${e.heading}`))
      .join('\n') + '\n'
  const file = path.join(String(indexDir), `${name}.index.md`)
  try {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true })
    fs.writeFileSync(path.resolve(file), text)
    return { index_path: file, index_lines: lineTotal(text) }
  } catch {
    return null
  }
}

const indexName = (key) => String(key).replace(/[^A-Za-z0-9._-]+/g, '__')

function readBody(p) {
  try {
    return { exists: true, text: fs.readFileSync(path.resolve(String(p)), 'utf8') }
  } catch {
    return { exists: false, text: '' }
  }
}

// 読めなかった文書は exists: false にして本文の検査を not_checked に載せる（CLI ごと落とすと、
// 他の文書の検査結果まで失われる）。
function runChecks(input) {
  if (!input || !Array.isArray(input.documents)) throw new Error('input.documents が配列ではありません')
  const docs = []
  const perDoc = []
  for (const d of input.documents) {
    if (!d || !d.key || !ID_IN_TEXT[d.kind] || !d.path) {
      throw new Error(`key / kind / path の揃わない文書があります: ${JSON.stringify(d && d.key)}`)
    }
    const cur = readBody(d.path)
    const prev = d.prev_path ? readBody(d.prev_path) : null
    const inText = [...new Set(cur.text.match(ID_IN_TEXT[d.kind]) || [])]
    // extract_ids: 申告（ids）を持たない固定文書は、本文から ID を抽出して補う。空のままにすると、
    // その文書が定義している ID が「存在しない」ものとして扱われ、トレーサビリティ表がそれを指した
    // 瞬間に全件が片側 ID として失格になる。
    const ids = d.extract_ids && !(d.ids || []).length ? inText : d.ids
    docs.push({ ...d, ids, markdown: cur.text })
    perDoc.push({
      key: d.key,
      path: d.path,
      exists: cur.exists,
      line_count: cur.exists ? lineTotal(cur.text) : null,
      newline_count: cur.exists ? newlineCount(cur.text) : null,
      // 前稿が読めないときは null（呼び出し側は全体を区切って読ませる）。空配列は「変更なし」。
      changed_ranges: cur.exists && prev && prev.exists ? changedLineRanges(prev.text, cur.text) : null,
      // byte_size: UTF-8 のバイト数。bulk-read の 1 回の送信量（shunt の上限はバイトで決まる）の計算に使う。
      // 日本語は 1 字 3 バイト前後なので、文字数で代用すると送信量を 3 分の 1 に見積もる。
      byte_size: cur.exists ? Buffer.byteLength(cur.text, 'utf8') : null,
      ...(d.extract_ids ? { ids_in_text: inText } : {}),
      ...(cur.exists && input.index_dir ? writeIndex(input.index_dir, indexName(d.key), d.path, cur.text) || {} : {}),
    })
  }
  const extra = (input.index_extra || []).map((p, i) => {
    const cur = readBody(p)
    return {
      path: p,
      exists: cur.exists,
      line_count: cur.exists ? lineTotal(cur.text) : null,
      ...(cur.exists && input.index_dir ? writeIndex(input.index_dir, `extra-${i + 1}`, p, cur.text) || {} : {}),
    }
  })
  const structural = structuralCompact(docs, 'flow' in input ? input.flow : undefined)
  for (const d of perDoc) {
    if (d.exists) continue
    structural.not_checked.push({ c: 'NC_BODY', a: [d.key, d.path] })
  }
  const body = { documents: perDoc, structural, ...(extra.length ? { index_extra: extra } : {}) }
  return { input_digest: stableKey(canonicalJson(input)), ...body, output_digest: stableKey(canonicalJson(body)) }
}

// 文書は W/<kind>-<topic>.md の 1 本だけを持ち、writer が Edit で直接更新する。項目 ID と参照 ID は
// 本文から導出し、本文から取れない trace と TBD の候補だけを W/<kind>-<topic>.meta.json に置く（本文と
// meta に同じ ID を二重に持つと、Edit のたびに両方を直すことになり、ずれを検査で拾う手間が増える）。
// Workflow script はファイルを読めないので、このモードは起動済みの agent が実行し、結果は W/checks/ の
// ファイルと stdout の digest で受け渡す。stdout に指摘の文面を出さないのは、agent に書き写させると
// 写すトークンと写し間違いの機会がそのまま増えるため。
// fixed: true の文書（expand の要求文書など）は ID の定義元として数えるが、書き手の欠陥は検査しない。
// flow の出典の引用が依頼文に実在するかは put が書く前に照合する（flow モードは形と ID の実在だけを見る）。

// WORKSPACE_TEXT_BEGIN
const WORKSPACE_TEXT = {
  FLOW_NOSOURCE: (id) => ({
    id: `ST-FLOW-NOSOURCE-${id}`,
    location: '工程の流れ（flow）',
    quote: id,
    issue: `流れの要素 ${id} に出典（source）が無い。flow は項目を当てる原本になるので、出典の無い要素は根拠の無い記述のまま文書に流れ込む。`,
    fix: id.endsWith('.on_fail')
      ? `${id} に source として依頼文の引用（input）か決定の ID（decision）を付ける（open は受けない）。どちらも付けられないなら、on_fail をやめて直後に成否の判断を置く。`
      : `${id} に source として依頼文の引用（input）・決定の ID（decision）・未決の ID（open）のどれかを付ける。どれも付けられないなら依頼から辿れない要素なので、外すか open に起票する。`,
  }),
  FLOW_SOURCE_SHAPE: (id) => ({
    id: `ST-FLOW-SOURCE-SHAPE-${id}`,
    location: '工程の流れ（flow）',
    quote: id,
    issue: `流れの要素 ${id} の source が { input } / { decision } / { open } のどれか 1 つの形になっていない。形が決まらないと、出典が実在するかを照合できない。`,
    fix: id.endsWith('.on_fail')
      ? 'source を { "input": "引用" } / { "decision": "D-…" } のどちらかにする（複数あるなら配列にする。open は受けない）。'
      : 'source を { "input": "引用" } / { "decision": "D-…" } / { "open": "…" } のどれかにする（複数あるなら配列にする）。',
  }),
  FLOW_SOURCE_UNKNOWN: (id, kind, ref) => ({
    id: `ST-FLOW-SOURCE-UNKNOWN-${id}-${ref}`,
    location: '工程の流れ（flow）',
    quote: `${id}: ${kind} ${ref}`,
    issue: `流れの要素 ${id} が出典に挙げた ${ref} が ${kind === 'decision' ? `${ledgerOf('decisions').file()} にも ${ledgerOf('resolutions').file()} にも` : `${ledgerOf('open').file()} に`}無い。実在しない出典は、出典が無いのと同じである。`,
    fix: `${ref} を実在する ID に直すか、出典を付け直す。`,
  }),
  FLOW_CONSTRAINT_UNKNOWN: (id, ref) => ({
    id: `ST-FLOW-CONSTRAINT-UNKNOWN-${id}-${ref}`,
    location: '工程の流れ（flow）',
    quote: `${id}: constrained_by ${ref}`,
    issue: `流れの要素 ${id} の constrained_by が挙げた ${ref} が ${ledgerOf('decisions').file()} にも ${ledgerOf('resolutions').file()} にも無く、kind が invariant の O- でもない。無い決定とは組にならず、矛盾が見つからない。`,
    fix: `${ref} を実在する決定か kind が invariant の O- の ID に直すか外す。`,
  }),
  FLOW_EFFECT_MISSING: (id, value) => ({
    id: `ST-FLOW-EFFECT-MISSING-${id}`,
    location: '工程の流れ（flow）',
    quote: `${id}: effect ${value || '無し'}`,
    issue: `工程 ${id} の effect が ${EFFECT.join(' / ')} のどれでもない。何を失いうるかを宣言しない工程は、名前が「削除」でない破壊的な操作（reset など）を不変条件と組にできない。`,
    fix: `${id} に effect を付ける。ref・作業ツリー・未反映の変更・外部の状態のどれかを戻せない形で変えるなら destructive にする。`,
  }),
  FLOW_DESTRUCTIVE_UNCONSTRAINED: (id) => ({
    id: `ST-FLOW-DESTRUCTIVE-UNCONSTRAINED-${id}`,
    location: '工程の流れ（flow）',
    quote: `${id}: effect destructive`,
    issue: `破壊的な工程 ${id} の constrained_by に、kind が invariant の決定も未決も無い。何を失ってはならないかと組にならず、破壊の範囲の論点が初稿の後まで見つからない。`,
    fix: `${id} の constrained_by に、その工程を縛る kind が invariant の決定を挙げる。無ければ ${ledgerOf('open').file()} に kind が invariant の O- を足して挙げる。`,
  }),
  FLOW_HISTORY: (where, mark) => ({
    id: `ST-FLOW-HISTORY-${where}`,
    location: '工程の流れ（flow）',
    quote: `${where}: ${mark}`,
    issue: `流れの ${where} に経緯の印「${mark}」がある。経緯が混ざると、どれが現行の値か読み手が区別できない。`,
    fix: `${where} を現行の値だけに書き直す。判断の記録は resolutions と commit に置く。`,
  }),
  FLOW_CASE_NOSOURCE: (id, no) => ({
    id: `ST-FLOW-CASE-NOSOURCE-${id}-${no}`,
    location: '工程の流れ（flow）',
    quote: `${id} cases[${no}]`,
    issue: `判断 ${id} の ${no} 件目の case に、{ input } / { decision } / { open } の形の出典が無い。出典の無いマスは推測で埋めたものであり、grounding は flow を根拠と認めるので、そのまま要求文になる。`,
    fix: 'case に source を付ける。根拠から決まらないマスは open に起票し、その ID を出典にする。',
  }),
  FLOW_NO_TABLE: (id) => ({
    id: `ST-FLOW-NO-TABLE-${id}`,
    location: '工程の流れ（flow）',
    quote: id,
    issue: `判断 ${id} に入力（inputs: name・values・from）か case（cases）が無い。入力の値の組み合わせが無いと、欠けたマスも重なったマスも検査できない。`,
    fix: `${id} の入力の変数と取りうる値を inputs に閉じて書き、値の組み合わせごとの枝を cases に書く。`,
  }),
  FLOW_INPUT_FROM: (id, name, from) => ({
    id: `ST-FLOW-INPUT-FROM-${id}-${name}`,
    location: '工程の流れ（flow）',
    quote: `${id}: ${name} ← ${from}`,
    issue: `判断 ${id} の入力「${name}」の from（${from || '無し'}）が flow の要素に無い。値を作る上流が分からないと、その値の集合が閉じているかを確かめられない。`,
    fix: 'from に、その値を作る上流の要素の ID を書く。',
  }),
  FLOW_FAIL_UNHANDLED: (id, both) => ({
    id: `ST-FLOW-FAIL-UNHANDLED-${id}`,
    location: '工程の流れ（flow）',
    quote: `${id}: obtain may_fail（${both ? '直後の成否の判断と on_fail の両方' : '直後の成否の判断も on_fail も無い'}）`,
    issue: `may_fail の要素 ${id} の失敗が値になる場所が 1 つに決まらない。場所が無ければ得られないときの行き先を誰も決めず、2 つあれば扱いが食い違う。`,
    fix: `次のどちらか 1 つだけにする。(a) ${id} の next を 1 つの判断だけにし、その判断の inputs に from が ${id} で unknown を持つ入力を置く。(b) ${id} に on_fail: { as: 値が得られないときに下流へ渡す値, source: { input } か { decision } } を書く。`,
  }),
  FLOW_ON_FAIL_AS: (id) => ({
    id: `ST-FLOW-ON-FAIL-AS-${id}`,
    location: '工程の流れ（flow）',
    quote: `${id}: on_fail`,
    issue: `要素 ${id} の on_fail に as（値が得られないときに下流へ渡す値）が無いか空である。渡す値が無いと、得られないときのマスがどの表にも無い。`,
    fix: `on_fail を { as: 空でない値, source: { input } か { decision } } にする。on_fail で扱わないなら欄ごと消す（null を送る）。`,
  }),
  FLOW_INPUT_ON_FAIL: (id, name, as) => ({
    id: `ST-FLOW-INPUT-ON-FAIL-${id}-${name}`,
    location: '工程の流れ（flow）',
    quote: `${id}: ${name} on_fail.as ${as}`,
    issue: `判断 ${id} の入力「${name}」の from は on_fail で失敗を扱う要素なのに、values に on_fail.as「${as}」が無い。得られないときに渡る値のマスが表に無い。`,
    fix: `values に「${as}」を足し、そのマスの case を出典付きで書く。`,
  }),
  FLOW_OBTAIN_MISSING: (id, value) => ({
    id: `ST-FLOW-OBTAIN-MISSING-${id}`,
    location: '工程の流れ（flow）',
    quote: `${id}: obtain ${value || '無し'}`,
    issue: `判断の入力の from に挙がる要素 ${id} の obtain が ${OBTAIN.join(' / ')} のどれでもない。値が得られないことがあるかを宣言しないと、「得られない」値の欠けが判定表の検査に乗らない。`,
    fix: `${id} が input か step なら obtain を付ける（定義は契約）。output なら、from をその値を作る上流の要素に直す。`,
  }),
  FLOW_INPUT_UNKNOWN: (id, name, unknown) => ({
    id: `ST-FLOW-INPUT-UNKNOWN-${id}-${name}`,
    location: '工程の流れ（flow）',
    quote: `${id}: ${name} unknown ${unknown || '無し'}`,
    issue: `判断 ${id} の入力「${name}」の from は直後の成否の判断で失敗を扱う may_fail の要素で、${id} はその判断自身か失敗の枝の先にあるのに、unknown が values の 1 つを指していない。値が得られないときのマスが表に無く、誰も行き先を決めない。`,
    fix: `unknown に、値が得られないときに当たる values の値を書く（無ければ values に足す）。そのマスの case を出典付きで書く。`,
  }),
  FLOW_UNKNOWN_CASE: (id, name, combo, value) => ({
    id: `ST-FLOW-UNKNOWN-CASE-${id}-${name}-${combo}`,
    location: '工程の流れ（flow）',
    quote: `${id}: ${combo}`,
    issue: `判断 ${id} の入力「${name}」が得られないときの組み合わせ「${combo}」を、その値を明示した case が受けていない（上記以外か * に任せている）。得られないときの行き先を誰も選ばない。`,
    fix: `when の「${name}」に「${value}」そのものを書いた case を、出典付きで足す。`,
  }),
  FLOW_CASE_BRANCH: (id, no, branch) => ({
    id: `ST-FLOW-CASE-BRANCH-${id}-${no}`,
    location: '工程の流れ（flow）',
    quote: `${id} cases[${no}]: ${branch}`,
    issue: `判断 ${id} の ${no} 件目の case の branch「${branch}」が branches の value に無い。そのマスの行き先が決まらない。`,
    fix: 'branch を branches の value のどれかにするか、branches に枝を足す。',
  }),
  FLOW_BRANCH_UNUSED: (id, value) => ({
    id: `ST-FLOW-BRANCH-UNUSED-${id}-${value}`,
    location: '工程の流れ（flow）',
    quote: `${id}: ${value}`,
    issue: `判断 ${id} の枝「${value}」を選ぶ case が無い。どの入力の組み合わせからも通らない枝は、行き先の検査を通っても意味を持たない。`,
    fix: 'その枝を選ぶ case を書くか、枝を消す。',
  }),
  FLOW_DT_GAP: (id, combo) => ({
    id: `ST-FLOW-DT-GAP-${id}-${combo}`,
    location: '工程の流れ（flow）',
    quote: `${id}: ${combo}`,
    issue: `判断 ${id} の入力の組み合わせ「${combo}」に当たる case が無い（上記以外の case も無い）。そのマスの行き先が決まらない。`,
    fix: 'その組み合わせの case を出典付きで足す。',
  }),
  FLOW_DT_OVERLAP: (id, combo, a, b) => ({
    id: `ST-FLOW-DT-OVERLAP-${id}-${combo}`,
    location: '工程の流れ（flow）',
    quote: `${id}: ${combo}`,
    issue: `判断 ${id} の ${a} 件目と ${b} 件目の case が、同じ組み合わせ「${combo}」に当たり、枝が違う。どちらを採るか決まらない。`,
    fix: '値を分けて、1 つの組み合わせが 1 つの case にだけ当たるようにする。',
  }),
  FLOW_DT_VALUE: (id, name, value) => ({
    id: `ST-FLOW-DT-VALUE-${id}-${name}-${value}`,
    location: '工程の流れ（flow）',
    quote: `${id}: ${name}=${value}`,
    issue: `判断 ${id} の case の「${name}」の値「${value}」が、inputs に宣言した入力と値に無い（書かれていない入力も含む）。宣言の外の値と書き漏らした入力は、網羅の検査に乗らない。`,
    fix: 'when には inputs のすべての name を書き、値は宣言した値か * にする。',
  }),
  FLOW_DT_SIZE: (id, n) => ({
    id: `ST-FLOW-DT-SIZE-${id}`,
    location: '工程の流れ（flow）',
    quote: id,
    issue: `判断 ${id} の入力の組み合わせが ${n} 通りあり、網羅を検査できない。`,
    fix: '判断を、入力の少ない複数の判断に分ける。',
  }),
  FLOW_SAME_NEXT: (id, next) => ({
    id: `ST-FLOW-SAME-NEXT-${id}`,
    location: '工程の流れ（flow）',
    quote: `${id} → ${next}`,
    issue: `判断 ${id} の枝がすべて ${next} へ行き、下流のどの判断も ${id} を inputs の from に挙げていない。値で何も変わらない判断は、分類を潰したまま閉包の検査を通る。`,
    fix: `${id} の値を使う下流の判断の inputs に from: ${id} を書くか、値ごとに行き先を分ける。値で何も変わらないなら判断ではなく工程にする。`,
  }),
  PLAN_ASPECT_UNKNOWN: (aspect) => ({
    id: `ST-PLAN-ASPECT-UNKNOWN-${aspect}`,
    location: 'plan.json の domain',
    quote: aspect,
    issue: `観点「${aspect}」が ${DOMAIN.file} §2 のキーに無い。キーでないと、不可逆な操作の観点を特定できず、不変条件の起こし漏れを検査できない。`,
    fix: `aspect を ${DOMAIN.file} §2 のキーにする。`,
  }),
  PLAN_ASPECT_MISSING: (key) => ({
    id: `ST-PLAN-ASPECT-MISSING-${key}`,
    location: 'plan.json の domain',
    quote: key,
    issue: `観点 ${key} の判定が無い。判定しなかった観点は、要る要求カテゴリが丸ごと落ちても気づけない。`,
    fix: `${key} を ${Object.keys(PLAN_VERDICT_NEEDS).join(' / ')} のどれかで判定して足す。`,
  }),
  PLAN_ASPECT_DUP: (key) => ({
    id: `ST-PLAN-ASPECT-DUP-${key}`,
    location: 'plan.json の domain',
    quote: key,
    issue: `観点 ${key} の判定が 2 つ以上ある。どれが正か決まらない。`,
    fix: '1 つにまとめる。',
  }),
  PLAN_VERDICT: (aspect, verdict) => ({
    id: `ST-PLAN-VERDICT-${aspect}`,
    location: 'plan.json の domain',
    quote: `${aspect}: ${verdict || '無し'}`,
    issue: `観点 ${aspect} の verdict が ${Object.keys(PLAN_VERDICT_NEEDS).join(' / ')} のどれでもない。`,
    fix: 'verdict をそのどれかにする。',
  }),
  PLAN_REF: (aspect, need, ref) => ({
    id: `ST-PLAN-REF-${aspect}`,
    location: 'plan.json の domain',
    quote: `${aspect}: ${need} ${ref || '無し'}`,
    issue: `観点 ${aspect} の ${need} が ${need === 'open' ? ledgerOf('open').file() : `${ledgerOf('decisions').file()} にも ${ledgerOf('resolutions').file()}`} に無い。判定の根拠を辿れない。`,
    fix: `${Object.entries(PLAN_VERDICT_NEEDS).map(([v, k]) => `${v} は ${k}`).join('、')} に、実在する ID を書く。`,
  }),
  PLAN_INVARIANT_MISSING: () => ({
    id: `ST-PLAN-INVARIANT-MISSING-${DOMAIN.irreversible}`,
    location: 'plan.json の domain',
    quote: `${DOMAIN.irreversible}: 該当`,
    issue: '不可逆な操作が該当なのに、kind が invariant の決定も未決も無い。破壊的な工程が縛りを挙げられず、flow の検査を通れない。',
    fix: `依頼文が失ってはならないものを述べていれば、その逐語を quote にした kind が invariant の決定にする。述べていなければ kind が invariant の O- を ${ledgerOf('open').file()} に足す。`,
  }),
  AMBIGUOUS: (docKey, itemId, word, quote) => ({
    id: `ST-AMBIGUOUS-${docKey}-${itemId}-${word}`,
    location: itemId,
    quote,
    issue: `項目 ${itemId} の文に曖昧語「${word}」がある。どこからが満たしたことになるかが読み手で割れ、テストを設計できない。`,
    fix: '測定できる形（値・単位・境界を含むか・超えたときの挙動）に書き換える。値が決まっていないなら数値を置かず、未決として扱う（requirement-writing-rules.md §2・§2.6）。',
  }),
  TBD_ASSERT: (docKey, tbdId, where, quote) => ({
    id: `ST-TBD-ASSERT-${docKey}-${tbdId}-${where}`,
    location: where,
    quote,
    issue: `開いている未決 ${tbdId} に触れる文が、裁定を待つ形ではなく断定で終わっている。決まっていないことを決まったこととして書くと、読み手はそれを要求として実装する。`,
    fix: `裁定が下るまで何をしてはならないか（保持規則）の形に書き換える（例:「${tbdId} の裁定が下るまで、〜してはならない」）。${tbdId} が裁定済みなら、開いている未決の一覧から外すよう返り値で伝える。`,
  }),
  REF_UNDEFINED: (docKey, id) => ({
    id: `ST-REF-UNDEFINED-${docKey}-${id}`,
    location: '本文',
    quote: id,
    issue: `本文が ${id} を参照しているが、workspace のどの文書にも ${id} を見出しに持つ項目が無く、欠番の申告も無い。読み手は参照先の中身を確認できない。`,
    fix: `${id} を見出しに持つ項目を置くか、参照を実在する ID に直す。欠番なら「欠番」の語と同じ行に ${id} を書く。`,
  }),
}
// WORKSPACE_TEXT_END

// LINT_TEXT: 生成者（flow-framer・writer）が自分のループで --lint を付けたときだけ出す指摘。findings・codes・blocking・digest に
// 入れないのは、verifier・flow-check・監査役がその数で止まる（codes は FIXERS_BY_CODE に無い符号で段を止める）ため。
// LINT_TEXT_BEGIN
const LINT_TEXT = {
  LINT_OBTAIN_UNGROUNDED: (id, effect) => ({
    id: `LINT-OBTAIN-UNGROUNDED-${id}`,
    location: '工程の流れ（flow）',
    quote: `${id}: effect ${effect} / obtain always`,
    issue: `状態を変える工程 ${id} が obtain always なのに、失敗しないと言える出典（obtain_source）が無い。書き込みはふつう失敗しうるので、根拠の無い always は verifier が insufficient_grounds で落とし、失敗の枝と未決が検証の後まで見つからない。`,
    fix: `失敗しないと述べる依頼文の逐語（{ input }）か決定の ID（{ decision }）を ${id} の obtain_source に付ける。付けられないなら obtain を may_fail にして同じ put で obtain_source に null を送り、直後の成否の判断か on_fail で失敗を扱う（schemas/agent-contracts.md の「${ledgerOf('flow').file()} の形」の obtain）。失敗したときの行き先が決まらないなら、その判断の case の出典を open に起票する。`,
  }),
  LINT_GROUNDS_SHAPE: (where) => ({
    id: `LINT-GROUNDS-SHAPE-${where}`,
    location: '工程の流れ（flow）',
    quote: where,
    issue: `${where} が { input } / { decision } のどれか 1 つの形（または その配列）になっていない。open は裁定の無い論点なので、obtain の根拠にならない。`,
    fix: `${where} を { "input": "逐語" } か { "decision": "D-…" } にする。どちらも付けられないなら欄を消す（null を送る）。`,
  }),
  LINT_GROUNDS_UNKNOWN: (where, ref) => ({
    id: `LINT-GROUNDS-UNKNOWN-${where}-${ref}`,
    location: '工程の流れ（flow）',
    quote: `${where}: ${ref}`,
    issue: `${where} が挙げた ${ref} が ${ledgerOf('decisions').file()} にも ${ledgerOf('resolutions').file()} にも無いか、supersedes で覆されている。`,
    fix: `${ref} を実在する今の決定の ID に直すか、出典を付け直す。`,
  }),
  LINT_TABLE_ELSEWHERE: (itemId, docKey, phrase) => ({
    id: `LINT-TABLE-ELSEWHERE-${docKey}-${itemId}`,
    location: itemId,
    quote: phrase,
    issue: `項目 ${itemId} の文が「${phrase}」と表を指すのに、${itemId} の節（次の同じか浅い見出しか、ID を持つ見出しまで。コードの囲みの中は除く）に表が無い。表が別の項目の見出しの下にあると、監査役は表をその項目の規範として読む。`,
    fix: `表を ${itemId} の見出しの下に移すか、別の項目の表を指すなら「${phrase}」をその項目の ID で書き直す。`,
  }),
}
// LINT_TEXT_END

const WS_MODES = ['plan', 'flow', 'conflicts', 'doc', 'snapshot', 'diff', 'tree-digest', 'index', 'put', 'del', 'backup', 'restore', 'stash', 'unstash', 'reset', 'questions', 'answers', 'sha', 'report', 'get', 'view', 'describe', 'contract']
const DOC_FILE = /^(requirements|specifications)-(.+)\.md$/
const DOC_PREFIX = /^(requirements|specifications)-/
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

class DigestMismatch extends Error {}

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex')
const digestOf = (value) => sha256(canonicalJson(value))
const listOf = (value, key) => (Array.isArray(value) ? value : value && Array.isArray(value[key]) ? value[key] : [])

// readJsonFile: 無いファイルは null。壊れた JSON は例外にする（黙って「無い」と扱うと、
// 検査が素通りしたのか材料が無かったのかが区別できなくなる）。
function readJsonFile(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e && e.code === 'ENOENT') return null
    throw e
  }
  try {
    return JSON.parse(text)
  } catch (e) {
    throw new Error(`${path.basename(file)} を JSON として読めません: ${e.message}`)
  }
}

// 台帳は ID 単位の put / del だけで書く。全体を読んで書き戻す更新は再実行で結果が変わり、復元点として
// 版の控えが要る原因になった。lists は配列名とその要素のキー、groupBy の配列は同じキーの行をまとめて置き換える。
// fields は要素が持てる欄の閉集合（型の外の欄は put が拒否する）。enums は値が閉集合の欄。cases は、by が返す行ごとに must（持つ）・
// never（持てない）欄を宣言する。欄単位のマージでは型や ruling を変えても古い欄が残るので、残りを構造で止める。by の 2 つ目の引数は
// 他の台帳を読む関数で、呼んだときだけ読む（関係の無い台帳の put を、他の台帳の壊れで止めない）。
const OTHER_RULING = { never: ['question', 'options', 'answer', 'hold'] }
const KIND = { kind: ['invariant'] }
const FLOW_TYPES = ['input', 'step', 'decision', 'output']
const OUT_OF_TYPE = '（型の外）'
// DOC_KEY: 文書のキー（<kind>/<topic>）の形。prd-spec.js の DOC_KEY と同じ（tests が照合する）。
const DOC_KEY = /^(requirements|specifications)\/([A-Za-z0-9][A-Za-z0-9._-]*)$/

const LEDGERS = {
  decisions: {
    file: () => 'decisions.json',
    lists: { decisions: 'id' },
    scalars: {},
    fields: { decisions: ['id', 'topic', 'value', 'why', 'source', 'quote', 'ref', 'layer', 'targets', 'reversibility', 'kind'] },
    enums: { decisions: KIND },
    cases: { decisions: { by: (d) => (d.kind === undefined ? '（kind なし）' : d.kind), rows: { invariant: { must: ['quote'] }, '（kind なし）': {} } } },
  },
  open: {
    file: () => 'open.json',
    lists: { open: 'id' },
    scalars: {},
    fields: { open: ['id', 'text', 'searched', 'by', 'targets', 'kind'] },
    enums: { open: KIND },
    // 閉じた resolution に kind の無い O- を invariant にすると、settle がその resolution に差し替えた工程が縛りを失う。
    cases: {
      open: {
        by: (o, read) =>
          o.kind === 'invariant' && listOf(read('resolutions'), 'resolutions').some((r) => r && r.about && String(r.about.open) === String(o.id) && r.kind !== 'invariant')
            ? 'kind の無い resolution が閉じた O-'
            : 'それ以外',
        rows: {
          'kind の無い resolution が閉じた O-': {
            never: ['kind'],
            fix: () => `閉じた O- を invariant に格上げしない。新しい kind が invariant の O- を ${ledgerOf('open').file()} に足し、その工程の constrained_by に挙げる`,
          },
          それ以外: {},
        },
      },
    },
  },
  resolutions: {
    file: () => 'resolutions.json',
    lists: { resolutions: 'id' },
    // keyShape: prd-spec.js の RESOLUTION_ID と同じ（tests が照合する）。prd-spec.js は合否をこの形で resolution と D- / F- に分けるので、
    // 形の外の ID で書いた裁定は、検証に通っても閉じた論点に数えられない。
    keyShape: /^RS-\d+$/,
    scalars: {},
    fields: {
      resolutions: ['id', 'about', 'ruling', 'value', 'why', 'evidence', 'supersedes', 'layer', 'targets', 'question', 'options', 'answer', 'hold', 'upstream_revision', 'kind'],
    },
    // objects: 値がオブジェクト（か消すための null）でなければならない欄。about は prd-spec.js が論点のキーに引き直すので、ほかの型を書くと
    // flow --rulings の stdout を script が受け取れず、段のやり直しが繰り返される。
    objects: { resolutions: ['about'] },
    enums: { resolutions: KIND },
    cases: {
      resolutions: [
        {
          by: (r, read) => (r.about && invariantOpenIds(read('open')).has(String(r.about.open)) ? 'kind が invariant の O- を閉じる' : 'それ以外'),
          rows: { 'kind が invariant の O- を閉じる': { must: ['kind'] }, それ以外: {} },
        },
        {
          by: (r) => (r.ruling === undefined ? '（ruling なし）' : r.ruling === 'question' ? `question（answer ${r.answer === undefined ? 'なし' : 'あり'}）` : r.ruling),
          rows: {
            'question（answer なし）': { must: ['question', 'options'], never: ['answer', 'value', 'hold'] },
            'question（answer あり）': { must: ['question', 'options', 'value'], never: ['hold'] },
            hold: { must: ['hold'], never: ['question', 'options', 'answer', 'value'] },
            precedent: OTHER_RULING,
            internal: OTHER_RULING,
            measured: OTHER_RULING,
            method: OTHER_RULING,
            answered_by: { must: ['value', 'evidence'], never: ['question', 'options', 'answer', 'hold'] },
            '（ruling なし）': OTHER_RULING,
          },
        },
      ],
    },
  },
  verifications: {
    file: () => 'verifications.json',
    lists: { items: 'id' },
    scalars: { resolutions_sha256: 'string', decisions_sha256: 'string' },
    filled: ['resolutions_sha256', 'decisions_sha256'],
    fields: { items: ['id', 'verdict', 'fail_kind', 'reason', 'digest'] },
    cases: {
      items: {
        by: (it) => (it.verdict === undefined ? '（verdict なし）' : it.verdict),
        // drop: 送った要素がこの行になったら、送らなかった欄を消す。pass が fail_kind を持つ版は作れないので、残す値が無い。
        rows: { fail: {}, pass: { never: ['fail_kind'], drop: ['fail_kind'] }, '（verdict なし）': { never: ['fail_kind'] } },
      },
    },
  },
  routes: { file: () => 'routes.json', lists: { routes: 'id' }, scalars: {}, fields: { routes: ['id', 'unit', 'doc', 'item_id', 'resolutions'] } },
  flow: {
    file: () => 'flow.json',
    lists: { elements: 'id', kinds: 'name' },
    scalars: { closure: 'string' },
    fields: { elements: ['id', 'type', 'kind', 'label', 'next', 'source', 'branches', 'inputs', 'cases', 'constrained_by', 'obtain', 'effect', 'on_fail', 'obtain_source'], kinds: ['name', 'definition'] },
    subfields: { elements: { inputs: ['name', 'values', 'from', 'unknown'] } },
    enums: { elements: { obtain: ['always', 'may_fail'], effect: ['read', 'reversible', 'destructive'] } },
    cases: {
      elements: [
        {
          by: (el) => (FLOW_TYPES.includes(el.type) ? el.type : OUT_OF_TYPE),
          rows: {
            input: { never: ['branches', 'inputs', 'cases', 'effect'] },
            step: { never: ['branches', 'inputs', 'cases'] },
            decision: { never: ['next', 'effect', 'obtain', 'on_fail', 'obtain_source'] },
            output: { never: ['branches', 'inputs', 'cases', 'effect', 'obtain', 'on_fail', 'obtain_source'] },
            [OUT_OF_TYPE]: {},
          },
        },
        { by: (el) => (['input', 'step'].includes(el.type) && el.obtain !== 'may_fail' ? 'may_fail 以外の input・step' : 'それ以外'), rows: { 'may_fail 以外の input・step': { never: ['on_fail'] }, それ以外: {} } },
        // obtain_source は always の出典なので、may_fail に変えた要素に残すと、根拠の無くなった出典が検証に届く。
        { by: (el) => (el.obtain === 'always' ? 'always' : 'always 以外'), rows: { always: {}, 'always 以外': { never: ['obtain_source'] } } },
      ],
    },
  },
  meta: {
    file: (doc) => {
      const m = DOC_KEY.exec(String(doc || ''))
      if (!m) throw new Error(`--ledger meta には --doc <requirements|specifications>/<topic> が 1 つ要ります: ${doc}`)
      return `${m[1]}-${m[2]}.meta.json`
    },
    lists: { tbd: 'id', trace: 'item_id' },
    groupBy: ['trace'],
    scalars: { fixed: 'boolean' },
    fields: { tbd: ['id', 'text', 'blocking', 'candidates'], trace: ['item_id', 'kind', 'quote', 'ref'] },
  },
}

// 経緯の印は prd-spec の工程にしか出ない形に限る。版・旧・v2・RS-232・G1 GC・§ 3a のような語は案件の分野にも
// 出るので、裸の G1・3a は印にせず「段 3a」の接頭辞付きの形で拾う（偽陽性で put が止まるより、取りこぼしを選ぶ）。
const HISTORY_FIELDS = ['flow.closure', 'flow.elements.label', 'flow.kinds.definition', 'decisions.decisions.why', 'resolutions.resolutions.why', 'verifications.items.reason']
const HISTORY_MARKS = [/段 ?\d/, /(?<![A-Za-z0-9])G0-2(?![A-Za-z0-9])/, /(?<![A-Za-z0-9])r\d+-(im|gr|cd)x?-/, /回答の反映/]

// SIZE_BUDGET: ファイルのバイト数の目安（合否ではない）。仮の値として 2026-09-27 の cleanup-branches の試走の台帳を
// 正規形に直した実測を置いた。段 3・5 が意図して生成物を太らせるので、試走し直した実測で決め直す。
const SIZE_BUDGET = { resolutions: 64241, meta: 25654, document: 23378, flow: 20734, verifications: 19165, decisions: 6887, open: 5029, routes: 655 }

class LedgerRejected extends Error {}

const sortDeep = (v) =>
  Array.isArray(v) ? v.map(sortDeep) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep(v[k])])) : v
const ledgerText = (value) => `${JSON.stringify(sortDeep(value), null, 1)}\n`
const sha256Bytes = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

const META_FILE = /^(requirements|specifications)-[A-Za-z0-9][A-Za-z0-9._-]*\.meta\.json$/
const ledgerFileOf = (name, doc) => {
  try {
    return LEDGERS[name].file(doc)
  } catch {
    return null
  }
}

function ledgerOf(name) {
  if (Object.hasOwn(LEDGERS, name)) return LEDGERS[name]
  const owner = Object.keys(LEDGERS).find((n) => ledgerFileOf(n) === name) || (META_FILE.test(String(name)) ? 'meta' : null)
  const hint = owner ? `${name} はファイル名です。--ledger ${owner} を渡す。` : ''
  throw new Error(`${hint}--ledger は ${Object.keys(LEDGERS).join(' / ')} のどれかです: ${name}`)
}

function checkShape(name, value, file, input) {
  const spec = ledgerOf(name)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${file} がオブジェクトではありません`)
  for (const k of Object.keys(value)) {
    if (k in spec.lists) {
      if (!Array.isArray(value[k])) throw new Error(`${file} の ${k} が配列ではありません`)
      for (const el of value[k]) {
        const key = el && typeof el === 'object' && !Array.isArray(el) ? el[spec.lists[k]] : undefined
        if (typeof key !== 'string' || !key.trim()) throw new Error(`${file} の ${k} に ${spec.lists[k]} の無い要素があります`)
        if (spec.keyShape && !spec.keyShape.test(key)) throw new Error(`${file} の ${k} の ${spec.lists[k]} ${key} が形（${spec.keyShape.source}）に合いません`)
      }
    } else if (k in spec.scalars) {
      if (!(input && value[k] === null) && typeof value[k] !== spec.scalars[k]) throw new Error(`${file} の ${k} が ${spec.scalars[k]} ではありません`)
    } else throw new Error(`${file} に台帳 ${name} の欄ではない ${k} があります（欄は ${[...Object.keys(spec.lists), ...Object.keys(spec.scalars)].join(' / ')}）`)
  }
}

// readLedger: 無いファイルは null。put が書く正規形と 1 バイトでも違えば、put 以外で書かれたものとして止める
// （Write や自作の script による全体の書き戻しを、読む側で構造的に検出するため）。
// stored: false は put / del だけが使う（旧い欄を消す書き込みを通し、書く前に次の版を storedRejects で見る）。
function readLedger(ws, name, doc, stored = true) {
  const file = ledgerOf(name).file(doc)
  const value = readJsonFile(path.join(ws, file))
  if (value === null) return null
  checkShape(name, value, file)
  if (fs.readFileSync(path.join(ws, file), 'utf8') !== ledgerText(value)) {
    throw new Error(`${file} が正規形ではありません。台帳は doc_check put / del 以外で書かないでください`)
  }
  const bad = stored ? storedRejects(ws, name, value) : []
  if (bad.length) throw new Error(`${file} に台帳の形に合わない要素があります。put で直してください（${STORED_FIX}）:\n${bad.join('\n')}`)
  return value
}

const STORED_FIX = '持てない欄は null を送って消す。inputs の欄は inputs を送り直す。要る欄は値を送る'

// storedRejects: 保存済みの版の全要素を欄の型と、その台帳だけで決まる欄の条件に照らす（put は送られた欄しか見ないので、
// 型が変わった後の旧い欄が残る）。他の台帳を読む条件は put の時だけ見る（読むたびに見ると、別の台帳の変更でこの台帳が読めなくなる）。
function storedRejects(ws, name, value) {
  const spec = ledgerOf(name)
  const bad = []
  for (const [list, key] of Object.entries(spec.lists)) {
    const els = value[list] || []
    for (const el of els) {
      for (const k of Object.keys(el)) if (!spec.fields[list].includes(k)) bad.push(`${list} ${el[key]}: ${k} は ${list} の欄ではありません（欄は ${spec.fields[list].join(' / ')}）`)
      bad.push(...subfieldRejects(spec, list, el, key))
    }
    for (const { el, row, rows, extra, lack } of caseViolations(ws, name, list, els, true)) {
      if (rows) bad.push(`${list} ${el[key]}: ${row} は ${rows.join(' / ')} のどれでもありません`)
      if (extra && extra.length) bad.push(`${list} ${el[key]}: ${row} では ${extra.join('・')} を持てません`)
      if (lack && lack.length) bad.push(`${list} ${el[key]}: ${row} では ${lack.join('・')} が要ります`)
    }
  }
  return bad
}

function subfieldRejects(spec, list, el, key) {
  const bad = []
  for (const [k, allowed] of Object.entries((spec.subfields || {})[list] || {})) {
    for (const sub of Array.isArray(el[k]) ? el[k] : []) {
      for (const s of sub && typeof sub === 'object' && !Array.isArray(sub) ? Object.keys(sub) : []) {
        if (!allowed.includes(s)) bad.push(`${list} ${el[key]} の ${k}: ${s} は ${k} の欄ではありません（欄は ${allowed.join(' / ')}）`)
      }
    }
  }
  return bad
}

function requireInput(ws) {
  let text = ''
  try {
    text = fs.readFileSync(path.join(ws, 'input.md'), 'utf8')
  } catch (e) {
    if (!(e && e.code === 'ENOENT')) throw e
  }
  if (!text.trim()) throw new Error('input.md が無いか空です。依頼原文が無いと逐語の照合ができません')
  return text
}

// writeAtomic: 全部を一時名に書き終えてから rename する（組で導出したファイルの片方だけが新しくなる窓を
// rename の間だけに縮める）。
const TMP_NAME = /^\..+\.\d+\.tmp$/
function writeAtomic(...pairs) {
  const tmps = pairs.map(([file]) => path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`))
  try {
    pairs.forEach(([, text], i) => fs.writeFileSync(tmps[i], text))
    pairs.forEach(([file], i) => fs.renameSync(tmps[i], file))
  } catch (e) {
    for (const t of tmps) fs.rmSync(t, { force: true })
    throw e
  }
}

// 段の書き込みは token ごとの取引にする。blocked の後の同じ段の再実行は、止まった run の書き込みを restore で段に入った時点の台帳へ
// 戻してから始める（W から state を組み直す方式は、持ち越す欄が増えるたびに再実行が止まらなかった run とずれた）。
// 控えは台帳ごとに最初の書き込みの直前に取る（並列の writer が別の meta を同時に put するので、共有の索引を持たない）。
// token は prd-spec.js が段の入口で決める（t<段の通し番号> と、同じ段の再実行の r<回数>）。順序を持つのは、打ち間違えた token や止まった run の
// 遅れた書き込みが、今の段の控えを消して restore を空振りさせないため。token の名前は所有表のパターン（tx/<token>/*）に合うよう . を含めない。
const TX_DIR = 'tx'
const TX_TOKEN = /^t(\d+)(?:r(\d+))?$/
const TX_PRE = '.pre'
const TX_ABSENT = '.absent'
const txOrder = (token) => {
  const m = TX_TOKEN.exec(token)
  return m ? [Number(m[1]), Number(m[2] || 0)] : null
}
const txBefore = (a, b) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1])

function txToken(opts, mode) {
  if (!opts.token) throw new LedgerRejected(`${mode} には --token <プロンプトのトークン> が要ります（再実行が段の入口の台帳へ戻す控えを、token ごとに取るため）`)
  if (!txOrder(opts.token)) throw new LedgerRejected(`--token はプロンプトの「トークン:」の値（t<数> か t<数>r<数>）をそのまま渡してください: ${opts.token}`)
  return opts.token
}

// txBegin: 新しい token の最初の書き込みで、それより前の token の控えを消す（済んだ段より前へ戻せないように）。後の token の控えがあれば
// 書かずに拒む（止まった run の遅れた書き込みが、今の段の再実行が戻す控えを消す）。
function txBegin(ws, token, file) {
  const root = path.join(ws, TX_DIR)
  const own = txOrder(token)
  const others = fs.existsSync(root) ? fs.readdirSync(root).filter((t) => t !== token) : []
  const later = others.filter((t) => txOrder(t) && !txBefore(txOrder(t), own))
  if (later.length) throw new LedgerRejected(`token ${token} より後の token（${later.join(', ')}）の控えがあります。プロンプトの「トークン:」の値で書き直してください（何も書いていません）`)
  for (const t of others) fs.rmSync(path.join(root, t), { recursive: true, force: true })
  const dir = path.join(root, token)
  fs.mkdirSync(dir, { recursive: true })
  const pre = path.join(dir, `${file}${TX_PRE}`)
  const absent = path.join(dir, `${file}${TX_ABSENT}`)
  if (fs.existsSync(pre) || fs.existsSync(absent)) return
  const cur = path.join(ws, file)
  if (fs.existsSync(cur)) writeAtomic([pre, fs.readFileSync(cur)])
  else writeAtomic([absent, ''])
}

const txLedgerFile = (name) => Object.keys(LEDGERS).some((n) => n !== 'meta' && ledgerOf(n).file() === name) || META_FILE.test(name)
// txFile: 控えを取ってよいファイル（台帳と、backup が取る文書の本文）。
const txFile = (name) => txLedgerFile(name) || /^(requirements|specifications)-[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(name)

// backup: writer は文書の本文を Edit で書き、doc_check を通らないので、put のように書き込みの前に控えを取れない。writer を起動する前に、
// 段の token で本文の控えを取る（無い文書は無い印）。blocked の後の同じ段の再実行の入口の restore が、台帳と一緒に本文を段に入った時点へ戻す。
// 戻さないと、止まった run が途中まで書いた本文が再実行の入力になる（expand の既存文書は S0 の原文が W から失われる）。
function wsBackup(ws, opts) {
  const token = txToken(opts, 'backup')
  const keys = [...new Set(opts.doc)].sort()
  if (!keys.length) throw new LedgerRejected('backup には --doc <キー> が 1 つ以上要ります')
  const files = keys.map((key) => {
    const m = DOC_KEY.exec(key)
    if (!m) throw new LedgerRejected(`文書のキー（<requirements|specifications>/<topic>）ではありません（控えを取っていません）: ${key}`)
    return `${m[1]}-${m[2]}.md`
  })
  for (const file of files) txBegin(ws, token, file)
  return { backup: true, token, docs: keys }
}

const fileSha = (p) => (fs.existsSync(p) ? sha256Bytes(fs.readFileSync(p)) : null)

// restore: token の控えを台帳と文書に戻し、token の下で作られた台帳と文書を消す。控えの無い台帳・文書・answers・plan.json・checks は触らない。
// 全部戻してから控えを消すので、途中で落ちても流し直せば同じ結果になる。控えを書く途中で落ちた一時名（writeAtomic）は控えではないので数えない。
// 控えが無いのは、止まった run が書かなかったか、戻し終えたか、後の token の最初の書き込みが消したときである。後の段の token（通し番号が
// 大きい）があれば最後のときで、戻す控えが失われているので何も変えずに pruned_by に挙げる（黙って 0 件を戻すと、再実行が止まった run の
// 書き込みの上から始まる）。同じ段の後の token は再実行自身の書き込みなので数えない。
// stash・unstash: flow-framer の lint の差し戻しの前の flow と open を控え、差し戻しで flow が閉じなくなったら戻す（lint は段を止めない）。
// 戻す版は stash の時点の内容で、段の token の控え（tx）は段の入口の版のまま残る。
const STASH_LEDGERS = ['flow', 'open']
function wsStash(ws, opts) {
  const label = opts.save
  if (!label || !LABEL.test(label)) throw new LedgerRejected(`stash には --save <英数字と . _ - のラベル> が要ります: ${label}`)
  const files = Object.fromEntries(STASH_LEDGERS.map((n) => {
    const p = path.join(ws, ledgerOf(n).file())
    return [n, fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null]
  }))
  return { stash: label, path: writeCheck(ws, `${label}.stash.json`, { files }), flow_sha256: ledgerSha(ws, 'flow') }
}
function wsUnstash(ws, opts) {
  const token = txToken(opts, 'unstash')
  const label = opts.against
  const saved = label && LABEL.test(label) ? readJsonFile(path.join(ws, 'checks', `${label}.stash.json`)) : null
  if (!saved || !saved.files || typeof saved.files !== 'object') throw new LedgerRejected(`unstash の --against ${label} の控え（checks/${label}.stash.json）がありません（何も戻していません）`)
  for (const n of STASH_LEDGERS) txBegin(ws, token, ledgerOf(n).file())
  for (const n of STASH_LEDGERS) {
    const p = path.join(ws, ledgerOf(n).file())
    const text = saved.files[n]
    if (typeof text === 'string') writeAtomic([p, text])
    else fs.rmSync(p, { force: true })
  }
  return { unstash: label, flow_sha256: ledgerSha(ws, 'flow') }
}

function wsRestore(ws, opts) {
  const token = txToken(opts, 'restore')
  const dir = path.join(ws, TX_DIR, token)
  const flowBefore = ledgerSha(ws, 'flow')
  const root = path.join(ws, TX_DIR)
  const prunedBy = fs.existsSync(dir) || !fs.existsSync(root) ? [] : fs.readdirSync(root).filter((t) => txOrder(t) && txOrder(t)[0] > txOrder(token)[0]).sort()
  if (prunedBy.length) return { token, restored: 0, files: [], pruned_by: prunedBy, flow_before: flowBefore, flow_after: flowBefore }
  const files = []
  const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => !TMP_NAME.test(n)).sort() : []
  const plan = names.map((n) => {
    const kind = n.endsWith(TX_PRE) ? 'pre' : n.endsWith(TX_ABSENT) ? 'absent' : null
    const file = kind ? n.slice(0, -(kind === 'pre' ? TX_PRE : TX_ABSENT).length) : null
    if (!kind || !txFile(file)) throw new LedgerRejected(`${TX_DIR}/${token}/${n} は台帳か文書の控えではありません（何も戻していません）`)
    return { n, kind, file }
  })
  for (const { n, kind, file } of plan) {
    const p = path.join(ws, file)
    const before = fileSha(p)
    if (kind === 'pre') writeAtomic([p, fs.readFileSync(path.join(dir, n))])
    else fs.rmSync(p, { force: true })
    files.push({ path: file, before, after: fileSha(p) })
  }
  fs.rmSync(dir, { recursive: true, force: true })
  return { token, restored: files.length, files, pruned_by: [], flow_before: flowBefore, flow_after: ledgerSha(ws, 'flow') }
}

// reset: 段 1 から始める run の W を、S0 が書いたもの（依頼文・先例の一覧・existing_docs の文書）だけの状態に戻す。前のランや止まった段 1・2 の
// 台帳が残ると、put はキー単位で足すので、再実行が書かなかった要素と欄（D- の kind・quote など）が黙って残る。answers も消す: 段 1・2 は
// 回答を読まず、新しいランは RS- を 1 から振り直すので、残った回答の ID は別の問いを指す。--keep に無い文書も消す: 前のランの writer の
// 文書が meta なしで残ると、index に載り、同じ topic の単位の writer に前の草稿が渡る。固定の文書の meta は S0 の依頼の写し
// （existing_docs の fixed）なので、消した後に --fixed から書き直す。所有表に無いファイルと tmp/ は触らない（snapshot の stray に出る）。
// fixedShas: 固定の文書（existing_docs の fixed）の本文と meta のバイトの sha256。reset が段 1 の入口の値を返し、監査の snapshot が同じ値を
// 返して script が照合する。固定の文書は所有表の誰の書き込みでもないので、変わっていれば承認を迂回した書き込みである。meta も数えるのは、
// fixed の印を外すと doc の検査がその文書を書き換えてよい文書として扱うから。
function fixedShas(ws, keys) {
  return Object.fromEntries(
    [...new Set(keys || [])].sort().map((key) => {
      const meta = ledgerOf('meta').file(key)
      return [key, sha256(JSON.stringify([fileSha(path.join(ws, meta.replace(/\.meta\.json$/, '.md'))), fileSha(path.join(ws, meta))]))]
    })
  )
}

const RESET_REMOVES = ['plan.json', 'questions.md', 'questions.json', 'report.md', 'answers', 'findings', 'checks', TX_DIR]
function wsReset(ws, opts) {
  const keep = [...new Set(opts.keep || [])].sort()
  const fixed = [...new Set(opts.fixed || [])].sort()
  const docOf = (key) => {
    try {
      return ledgerOf('meta').file(key).replace(/\.meta\.json$/, '.md')
    } catch {
      throw new LedgerRejected(`文書のキー（<requirements|specifications>/<topic>）ではありません（何も消していません）: ${key}`)
    }
  }
  const docs = keep.map(docOf)
  fixed.forEach(docOf)
  const unkept = fixed.filter((key) => !keep.includes(key))
  if (unkept.length) throw new LedgerRejected(`--fixed の文書が --keep にありません（何も消していません）: ${unkept.join(', ')}`)
  const missing = keep.filter((_, i) => !fs.existsSync(path.join(ws, docs[i])))
  if (missing.length) throw new LedgerRejected(`existing_docs の文書が W にありません（S0 で逐語で置く。何も消していません）: ${missing.join(', ')}`)
  const metas = fixed.map((key) => ledgerOf('meta').file(key))
  const removed = fs
    .readdirSync(ws)
    .filter((n) => (txLedgerFile(n) && !metas.includes(n)) || RESET_REMOVES.includes(n) || (DOC_FILE.test(n) && !docs.includes(n)))
    .sort()
  for (const n of removed) fs.rmSync(path.join(ws, n), { recursive: true, force: true })
  for (const m of metas) writeAtomic([path.join(ws, m), ledgerText({ ...emptyLedger(ledgerOf('meta')), fixed: true })])
  return { reset: true, removed, kept: keep, fixed, fixed_sha256: fixedShas(ws, fixed) }
}

function answerTexts(ws) {
  const dir = path.join(ws, 'answers')
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.md'))
    .sort()
    .map((n) => fs.readFileSync(path.join(dir, n), 'utf8'))
}

function verbatimRejects(ws, name, body) {
  const input = requireInput(ws)
  const answers = answerTexts(ws)
  const bad = []
  const inInput = (where, q) => {
    if (typeof q !== 'string' || !q || !input.includes(q)) bad.push(`${where}: input.md に逐語で無い ${JSON.stringify(q)}`)
  }
  const inAnswers = (where, q, texts) => {
    if (typeof q !== 'string' || !q || !texts.some((t) => t.includes(q))) bad.push(`${where}: 回答に逐語で無い ${JSON.stringify(q)}`)
  }
  if (name === 'decisions') for (const d of body.decisions || []) if (d.quote != null) inInput(d.id, d.quote)
  if (name === 'flow') {
    const quotes = (where, source) => {
      for (const s of Array.isArray(source) ? source : source ? [source] : []) {
        if (s && typeof s === 'object' && s.input !== undefined) inInput(where, s.input)
      }
    }
    for (const el of body.elements || []) {
      quotes(el.id, el.source)
      if (el.on_fail) quotes(`${el.id} on_fail`, el.on_fail.source)
      quotes(`${el.id} obtain_source`, el.obtain_source)
      for (const [i, c] of (Array.isArray(el.cases) ? el.cases : []).entries()) quotes(`${el.id} cases[${i}]`, c && c.source)
    }
  }
  if (name === 'meta') {
    for (const t of body.trace || []) {
      if (t.kind === 'input') inInput(t.item_id, t.quote)
      if (t.kind === 'answers') inAnswers(t.item_id, t.quote, answers)
    }
  }
  if (name === 'resolutions') {
    for (const r of body.resolutions || []) {
      if (r.answer != null) {
        const a = r.answer || {}
        let texts = answers
        if (a.path !== undefined) {
          try {
            texts = [fs.readFileSync(path.resolve(ws, String(a.path)), 'utf8')]
          } catch {
            texts = []
          }
        }
        inAnswers(`${r.id} answer`, a.quote, texts)
      }
      for (const [i, e] of (Array.isArray(r.evidence) ? r.evidence : r.evidence == null ? [] : [null]).entries()) {
        const where = `${r.id} evidence[${i}]`
        const { file, line, end, quote } = e || {}
        const last = end === undefined ? line : end
        if (typeof file !== 'string' || !path.isAbsolute(file) || !Number.isInteger(line) || line < 1 || !Number.isInteger(last) || last < line) {
          bad.push(`${where}: { file（絶対パス）, line, end?（line 以上）, quote } の形ではありません`)
          continue
        }
        let lines
        try {
          lines = fs.readFileSync(file, 'utf8').split('\n')
        } catch {
          bad.push(`${where}: ${file} を読めません`)
          continue
        }
        const span = lines.slice(line - 1, last).join('\n')
        if (last > lines.length || typeof quote !== 'string' || !quote || !span.includes(quote)) {
          bad.push(`${where}: ${file} の ${line}${last === line ? '' : `〜${last}`} 行目に逐語で無い ${JSON.stringify(quote)}`)
        }
      }
    }
  }
  return bad
}

// flowRefRejects: 候補の flow_refs が指す要素の実在。無い要素を指す候補は、回答を当てる resolver が変える要素を辿れない。
function flowRefRejects(ws, resolutions) {
  const [elementsOf, elementKey] = Object.entries(ledgerOf('flow').lists)[0]
  const els = new Set(listOf(readLedger(ws, 'flow'), elementsOf).map((el) => el && String(el[elementKey])))
  const bad = []
  for (const r of resolutions) {
    for (const [i, o] of (Array.isArray(r.options) ? r.options : []).entries()) {
      if (!o || o.flow_refs === undefined) continue
      const where = `${r.id} options[${i}].flow_refs`
      if (!Array.isArray(o.flow_refs)) bad.push(`${where}: 要素 ID の配列ではありません`)
      else for (const ref of o.flow_refs) if (!els.has(String(ref))) bad.push(`${where}: ${ref} は ${ledgerOf('flow').file()} にありません`)
    }
  }
  return bad
}

function refRejects(ws, name, body) {
  if (name === 'resolutions') return flowRefRejects(ws, body.resolutions || [])
  if (name !== 'flow') return []
  const ids = new Set([...decisionIdsOf(ws), ...invariantOpenIds(readLedger(ws, 'open'))])
  const bad = []
  for (const el of body.elements || []) {
    if (el.constrained_by == null) continue
    if (!Array.isArray(el.constrained_by)) bad.push(`${el.id} constrained_by: 決定の ID の配列ではありません`)
    else for (const ref of constraintsOf(el)) if (!ids.has(ref)) bad.push(`${el.id} constrained_by: ${ref} は ${ledgerOf('decisions').file()} にも ${ledgerOf('resolutions').file()} にも無く、${ledgerOf('open').file()} の kind が invariant の O- でもありません`)
  }
  return bad
}

function historyMark(text) {
  for (const re of HISTORY_MARKS) {
    const m = re.exec(String(text))
    if (m) return m[0]
  }
  return null
}

function proseRejects(where, pathKey, value) {
  if (typeof value !== 'string') return []
  const bad = []
  const mark = HISTORY_FIELDS.includes(pathKey) ? historyMark(value) : null
  if (mark) bad.push(`${where}: 経緯の印「${mark}」があります。現行の値だけを書き、判断の記録は resolutions と commit に置いてください`)
  return bad
}

// fieldRejects: 送られた欄だけを見る（型の外の欄・経緯の印）。null は欄を消す指示なので、型の中か保存済みの版にある欄なら通す。
function fieldRejects(name, body, cur) {
  const spec = ledgerOf(name)
  const bad = []
  for (const [list, key] of Object.entries(spec.lists)) {
    const allowed = spec.fields[list]
    const stored = new Map(((cur || {})[list] || []).map((el) => [el[key], el]))
    for (const el of body[list] || []) {
      for (const [k, v] of Object.entries(el)) {
        const where = `${list} ${el[key]} の ${k}`
        const values = spec.enums && spec.enums[list] && spec.enums[list][k]
        if (!allowed.includes(k)) {
          if (!(v === null && k in (stored.get(el[key]) || {}))) bad.push(`${where}: 台帳 ${name} の ${list} の欄ではありません（欄は ${allowed.join(' / ')}）`)
        } else if (values && v !== null && !values.includes(v)) bad.push(`${where}: ${JSON.stringify(v)} は ${values.join(' / ')} のどれでもありません`)
        else if (((spec.objects || {})[list] || []).includes(k) && v !== null && !(v && typeof v === 'object' && !Array.isArray(v))) bad.push(`${where}: ${JSON.stringify(v)} はオブジェクトではありません（{ "open": "O-…" } のように書く）`)
        else bad.push(...proseRejects(where, `${name}.${list}.${k}`, v))
      }
      bad.push(...subfieldRejects(spec, list, el, key))
    }
  }
  for (const k of Object.keys(spec.scalars)) if (k in body) bad.push(...proseRejects(k, `${name}.${k}`, body[k]))
  return bad
}

function caseViolations(ws, name, list, els, ownOnly = false) {
  const spec = ledgerOf(name)
  const read = (other) => readLedger(ws, other)
  const out = []
  for (const c of [].concat((spec.cases || {})[list] || []).filter((x) => !ownOnly || x.by.length < 2)) {
    for (const el of els) {
      const row = c.by(el, read)
      const rule = Object.hasOwn(c.rows, row) ? c.rows[row] : null
      if (!rule) out.push({ el, row, rows: Object.keys(c.rows) })
      else out.push({ el, row, extra: (rule.never || []).filter((k) => k in el), lack: (rule.must || []).filter((k) => !(k in el)), fix: rule.fix && rule.fix() })
    }
  }
  return out
}

// answerLineId: 回答のファイルの中の、問いごとの節の頭の行（`<ID>:`）。節は次の頭の行の手前まで続く。
const answerLineId = (l) => (/^(RS-\d+):/.exec(String(l).trim()) || [])[1]
// answersFile: 回答のファイルは所有表で司令塔が書く answers/ の下のファイルだけ（写しを持たない）。ほかの役が answers/ に置いたファイルを
// 回答として引けると、依頼者の言葉でない行が回答の顔で根拠になる。
const answersFile = (rel) => rel.startsWith('answers/') && ownedPatterns().files.some((re) => re.test(rel))
const answersRel = (ws, file) => path.relative(ws, path.resolve(file)).split(path.sep).join('/')
// answerSections: 回答のファイルの問いごとの節（{id, from, to, text}。行は 1 始まりで両端を含み、text は頭の行の `<ID>:` の後と続きの行）。
// 節の頭は台帳にある ID の行だけにする（回答の自由記述の中の `RS-9:` のような行で節を切らない）。answerHolds と wsAnswers がこの 1 つで切る:
// 別々の条件で切ると、同じ行が片方では答えの続き、もう片方では別の問いの節になり、保留の hold が指定の外に数えられる。
function answerSections(lines, resolutions) {
  const known = new Set(resolutions.map((r) => String(r && r.id)))
  const isHead = (id) => known.has(id)
  const heads = []
  lines.forEach((l, i) => {
    const id = answerLineId(l)
    if (id && isHead(id)) heads.push({ id, from: i + 1 })
  })
  return heads.map((h, k) => {
    const to = k + 1 < heads.length ? heads[k + 1].from - 1 : lines.length
    return { ...h, to, text: [lines[h.from - 1].trim().slice(h.id.length + 1), ...lines.slice(h.from, to)].join('\n').trim() }
  })
}

// answerCites: evidence のうち、回答のファイルの行を引くもの。
const answerCites = (ws, r) => (Array.isArray(r.evidence) ? r.evidence : []).filter((e) => e && typeof e.file === 'string' && answersFile(answersRel(ws, e.file)))

// answerHolds: 依頼者のその問いへの回答を根拠にした hold（evidence が、その hold と同じ ID の節の空でない回答の中だけを引く）と、引いた節
// （{id, file, from, to}。行は 1 始まりで両端を含む）。聞ける段でも問いに書き換え直させない（prd-spec.js の designatedHold）。書き換えると、保留と
// 答えた依頼者に同じ論点を聞き直す。回答が保留か実際の選択かはここでは決めない: 実際の選択を hold にしたものは verifier がその節を出典に
// decidable で落とし、prd-spec.js の convertFailed が例外から外す。
// 別の ID の節や空の回答（答えなかった問い）を引く hold は数えない: どの回答の行でも引けば通るなら、resolver が聞ける論点を保持規則に逃がせる。
// 節の頭は台帳にある ID の行だけにする（回答の自由記述の中の `RS-9:` のような行で節を切らない）。
function answerHolds(ws, resolutions) {
  const files = new Map()
  const sectionsOf = (file) => {
    if (!files.has(file)) {
      try {
        const lines = fs.readFileSync(file, 'utf8').split('\n')
        files.set(file, { size: lines.length, sections: answerSections(lines, resolutions) })
      } catch {
        files.set(file, null)
      }
    }
    return files.get(file)
  }
  const ownSection = (id, e) => {
    const got = sectionsOf(path.resolve(e.file))
    const last = e.end === undefined ? e.line : e.end
    if (!got || !Number.isInteger(e.line) || e.line < 1 || !Number.isInteger(last) || last < e.line || last > got.size) return null
    const s = got.sections.find((x) => x.from <= e.line && e.line <= x.to)
    return s && s.id === id && last <= s.to && s.text !== '' ? { id, file: answersRel(ws, e.file), from: s.from, to: s.to } : null
  }
  const out = resolutions
    .filter((r) => r && r.ruling === 'hold')
    .flatMap((r) => answerCites(ws, r).map((e) => ownSection(String(r.id), e)).filter(Boolean))
  return [...new Map(out.map((x) => [canonicalJson(x), x])).values()].sort((a, b) => (a.id + a.file + a.from < b.id + b.file + b.from ? -1 : 1))
}

// answeredByRejects: answered_by は依頼者の既にある回答を別の論点に当てる裁定で、その回答の行（answerCites）を evidence に引く。引かないと
// verifier が当てた回答を照合できず、依頼者が決めていない値が回答の顔で入る。合格した問いの回答を当てるときも、その問いの answer の行を引く。
// 回答待ちの問いを answered_by に変えない: 候補の選択として返されると検証を飛ばして回答済みになり、依頼者が答えていない値が根拠になる。
// その問いに既にある回答を当てるなら、問いのまま answer と value を put する（resolver.md の「回答の反映」）。
function answeredByRejects(ws, cur, next, body) {
  const touched = new Set((body.resolutions || []).map((r) => r && r.id))
  const cites = (r) => answerCites(ws, r).length > 0
  const waiting = new Set((cur.resolutions || []).filter((r) => r && r.ruling === 'question' && r.answer == null).map((r) => r.id))
  const mine = (next.resolutions || []).filter((r) => r && touched.has(r.id) && r.ruling === 'answered_by')
  return [
    ...mine.filter((r) => !cites(r)).map((r) => `resolutions ${r.id}: answered_by の evidence に回答のファイル（所有表の answers/ の下）の行がありません`),
    ...mine.filter((r) => waiting.has(r.id)).map((r) => `resolutions ${r.id}: 回答待ちの問いは answered_by にできません（その問いに回答を当てるなら、question のまま answer と value を put する）`),
  ]
}

function caseRejects(ws, name, next, body) {
  const spec = ledgerOf(name)
  const bad = []
  for (const list of Object.keys(spec.cases || {})) {
    const key = spec.lists[list]
    const touched = new Set((body[list] || []).map((el) => el[key]))
    for (const { el, row, rows, extra, lack, fix } of caseViolations(ws, name, list, next[list].filter((x) => touched.has(x[key])))) {
      const how = fix ? `。直し方: ${fix}` : ''
      if (rows) bad.push(`${list} ${el[key]}: ${row} は ${rows.join(' / ')} のどれでもありません`)
      if (extra && extra.length) bad.push(`${list} ${el[key]}: ${row} では ${extra.join('・')} を持てません${how || '。消すには、その欄に null を送ってください'}`)
      if (lack && lack.length) bad.push(`${list} ${el[key]}: ${row} では ${lack.join('・')} が要ります${how}`)
    }
  }
  return bad
}

function groupRows(rows, key) {
  const groups = new Map()
  for (const r of rows) {
    const k = r[key]
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(r)
  }
  return groups
}

function mergeList(cur, incoming, key, grouped, tally) {
  if (grouped) {
    const out = [...cur]
    for (const [k, rows] of groupRows(incoming, key)) {
      const at = out.findIndex((r) => r[key] === k)
      if (at < 0) {
        out.push(...rows)
        tally.added.push(k)
        continue
      }
      const old = out.filter((r) => r[key] === k)
      if (canonicalJson(old) === canonicalJson(rows)) {
        tally.unchanged.push(k)
        continue
      }
      const rest = out.filter((r, i) => i < at || r[key] !== k)
      rest.splice(at, 0, ...rows)
      out.splice(0, out.length, ...rest)
      tally.replaced.push(k)
    }
    return out
  }
  const seen = new Set()
  for (const el of incoming) {
    if (seen.has(el[key])) throw new LedgerRejected(`入力に同じ ${key} ${el[key]} が 2 回あります`)
    seen.add(el[key])
  }
  const out = [...cur]
  for (const el of incoming) {
    const at = out.findIndex((r) => r[key] === el[key])
    const merged = mergeElement(at < 0 ? {} : out[at], el)
    if (at < 0) {
      out.push(merged)
      tally.added.push(el[key])
    } else if (canonicalJson(out[at]) === canonicalJson(merged)) tally.unchanged.push(el[key])
    else {
      out[at] = merged
      tally.replaced.push(el[key])
    }
  }
  return out
}

function dropByCase(spec, list, merged, sent) {
  const cases = [].concat((spec.cases || {})[list] || []).filter((c) => Object.values(c.rows).some((r) => r.drop))
  if (!cases.length) return merged
  const key = spec.lists[list]
  const byKey = new Map(sent.map((el) => [el[key], el]))
  return merged.map((el) => {
    const drop = byKey.has(el[key]) ? cases.flatMap((c) => (c.rows[c.by(el)] || {}).drop || []) : []
    const gone = drop.filter((f) => f in el && !(f in byKey.get(el[key])))
    return gone.length ? Object.fromEntries(Object.entries(el).filter(([f]) => !gone.includes(f))) : el
  })
}

function mergeElement(old, el) {
  const out = { ...old, ...el }
  for (const k of Object.keys(el)) if (el[k] === null) delete out[k]
  return out
}

function emptyLedger(spec) {
  return Object.fromEntries(Object.keys(spec.lists).map((k) => [k, []]))
}

// ledgerSha: 無い台帳は空の台帳（put が書く正規形）と同じ値にする。readLedger も無い台帳を空として読むので、
// まだ誰も書いていない台帳を検証の起点にできる（段 3 で open も組も 0 件のとき resolutions.json は無い）。
function ledgerSha(ws, name, doc) {
  const spec = ledgerOf(name)
  const p = path.join(ws, spec.file(doc))
  return sha256Bytes(fs.existsSync(p) ? fs.readFileSync(p) : Buffer.from(ledgerText(emptyLedger(spec))))
}

function wsSha(ws, opts) {
  const file = ledgerOf(opts.ledger).file(opts.doc.length === 1 ? opts.doc[0] : opts.doc.join(','))
  return { ledger: opts.ledger, path: file, exists: fs.existsSync(path.join(ws, file)), sha256: ledgerSha(ws, opts.ledger, opts.doc[0]) }
}

// STDOUT_BUDGET: CLI の 1 行の stdout の上限（バイト）。agent は stdout を返り値に写すので、超えると以後の全ターンに載る。
const STDOUT_BUDGET = 50000
const stdoutBytes = (value) => Buffer.byteLength(`${JSON.stringify(stampStdout(value))}\n`)

// fieldPicker: --fields の欄だけを残す（キーは常に残す）。欄は台帳の型から選ばせ、打ち間違いを空の結果にしない。
function fieldPicker(name, fields) {
  const allowed = [...new Set(Object.values(ledgerOf(name).fields || {}).flat())]
  const unknown = (fields || []).filter((f) => !allowed.includes(f))
  if (unknown.length) throw new Error(`--fields は台帳 ${name} の欄 ${allowed.join(' / ')} から選ぶ: ${unknown.join(', ')}`)
  return (el, key) => (fields ? Object.fromEntries(Object.keys(el).filter((k) => k === key || fields.includes(k)).map((k) => [k, el[k]])) : el)
}

// view: 欄と配列の要素を 1 行ずつにするのは、Read が 2000 字を超える行を切るから。名前を台帳と --fields だけで決めるので、並列の呼び出しは同じ中身を同じ名前に書く。
function wsView(ws, opts) {
  const name = opts.ledger
  const spec = ledgerOf(name)
  const doc = opts.doc.length === 1 ? opts.doc[0] : opts.doc.join(',')
  const file = spec.file(doc)
  const pick = fieldPicker(name, opts.fields)
  const value = readLedger(ws, name, opts.doc[0]) || emptyLedger(spec)
  const field = ([k, v]) => ` ${JSON.stringify(k)}: ${Array.isArray(v) && v.length ? `[\n${v.map((x) => `  ${JSON.stringify(x)}`).join(',\n')}\n ]` : JSON.stringify(v)}`
  const blocks = [
    ...Object.entries(spec.lists).flatMap(([list, key]) => listOf(value, list).map((el) => `{${JSON.stringify(list)}: {\n${Object.entries(pick(el, key)).map(field).join(',\n')}\n}}`)),
    ...Object.keys(spec.scalars).filter((k) => k in value).map((k) => JSON.stringify({ [k]: value[k] })),
  ]
  const lines = blocks.join('\n').split('\n')
  const suffix = opts.fields ? `.${fnv([...new Set(opts.fields)].sort().join(','))}` : ''
  const rel = `checks/view-${file.replace(/\.json$/, '')}${suffix}.txt`
  fs.mkdirSync(path.join(ws, 'checks'), { recursive: true })
  writeAtomic([path.join(ws, rel), lines.map((l) => `${l}\n`).join('')])
  return { ledger: name, path: rel, elements: blocks.length, lines: lines.length, sha256: sha256Bytes(Buffer.from(ledgerText(value))) }
}

// get: 台帳から ID の要素を選ぶだけで、値を加工しない（要約や書き直しは正本から drift した写しになる）。上限に入らない要素は
// 黙って落とさず over_budget に挙げる。
function wsGet(ws, opts) {
  const name = opts.ledger
  const spec = ledgerOf(name)
  if (!opts.ids || !opts.ids.length) throw new Error('get には --ids a,b が要ります')
  const file = spec.file(opts.doc.length === 1 ? opts.doc[0] : opts.doc.join(','))
  const pick = fieldPicker(name, opts.fields)
  const value = readLedger(ws, name, opts.doc[0])
  const ids = [...new Set(opts.ids)]
  const hits = ids.map((id) => ({ id, rows: Object.entries(spec.lists).flatMap(([list, key]) => listOf(value, list).filter((el) => el[key] === id).map((el) => [list, pick(el, key)])) }))
  const out = { ledger: name, path: file, exists: value !== null, sha256: ledgerSha(ws, name, opts.doc[0]), ...Object.fromEntries(Object.keys(spec.lists).map((k) => [k, []])), missing: [], over_budget: [] }
  out.missing = hits.filter((h) => !h.rows.length).map((h) => h.id)
  const found = hits.filter((h) => h.rows.length)
  let room = STDOUT_BUDGET - stdoutBytes({ ...out, over_budget: found.map((h) => h.id) })
  if (room < 0) throw new Error(`get の --ids ${ids.length} 件は、ID の一覧（missing・over_budget）だけで stdout の上限 ${STDOUT_BUDGET} バイトを超える。ID を分けて読み直す`)
  for (const h of found) {
    const size = h.rows.reduce((n, [, el]) => n + Buffer.byteLength(JSON.stringify(el)) + 1, 0)
    if (size > room) {
      out.over_budget.push(h.id)
      continue
    }
    room -= size
    for (const [list, el] of h.rows) out[list].push(el)
  }
  return out
}

// describe: LEDGERS と指摘の表から導出する（写しを持つと、台帳の型を変えたときに片方だけが古くなる）。
function describeLedgers() {
  const rows = (c) => Object.fromEntries(Object.entries(c.rows).map(([row, r]) => [row, { must: r.must || [], never: r.never || [] }]))
  const ledgers = Object.fromEntries(
    Object.entries(LEDGERS).map(([name, spec]) => [
      name,
      {
        file: ledgerFileOf(name),
        ...(ledgerFileOf(name) === null ? { doc: DOC_KEY.source, file_of_doc: spec.file('requirements/topic') } : {}),
        lists: spec.lists,
        scalars: spec.scalars,
        fields: spec.fields || {},
        ...(spec.subfields ? { subfields: spec.subfields } : {}),
        ...(spec.objects ? { objects: spec.objects } : {}),
        enums: spec.enums || {},
        ...(spec.keyShape ? { key_shape: spec.keyShape.source } : {}),
        ...(spec.groupBy ? { group_by: spec.groupBy } : {}),
        ...(spec.filled ? { filled: spec.filled } : {}),
        cases: Object.fromEntries(Object.entries(spec.cases || {}).map(([list, c]) => [list, (Array.isArray(c) ? c : [c]).map(rows)])),
      },
    ]),
  )
  return { modes: WS_MODES, ledgers, finding_codes: [...Object.keys(FINDING_TEXT), ...Object.keys(WORKSPACE_TEXT)].sort(), lint_codes: Object.keys(LINT_TEXT).sort() }
}

// verifications の sha256 は put の時点のファイルから取る。verifier が読んだ版と違えば書かない
// （検証していない版の sha256 を合格の記録に残さないため）。
function fillVerifications(ws, opts, next, body) {
  if (!opts.expectResolutions || !opts.expectDecisions) {
    throw new LedgerRejected('verifications の put には --expect-resolutions <sha> と --expect-decisions <sha>（検証を始めたときに読んだ版）が要ります')
  }
  const now = { resolutions_sha256: ledgerSha(ws, 'resolutions'), decisions_sha256: ledgerSha(ws, 'decisions') }
  if (now.resolutions_sha256 !== opts.expectResolutions) throw new LedgerRejected(`${ledgerOf('resolutions').file()} が検証を始めた版から変わっています（--expect-resolutions ${opts.expectResolutions} / 今 ${now.resolutions_sha256}）`)
  if (now.decisions_sha256 !== opts.expectDecisions) throw new LedgerRejected(`${ledgerOf('decisions').file()} が検証を始めた版から変わっています（--expect-decisions ${opts.expectDecisions} / 今 ${now.decisions_sha256}）`)
  const [itemsOf, itemKey] = Object.entries(ledgerOf('verifications').lists)[0]
  const [elementsOf, elementKey] = Object.entries(ledgerOf('flow').lists)[0]
  const flowEls = new Map(listOf(readLedger(ws, 'flow'), elementsOf).map((el) => [el[elementKey], el]))
  const [resolutionsOf, resolutionKey] = Object.entries(ledgerOf('resolutions').lists)[0]
  const rulings = new Map(listOf(readLedger(ws, 'resolutions'), resolutionsOf).map((r) => [r[resolutionKey], r]))
  const asked = new Set(listOf(body, itemsOf).map((it) => it[itemKey]))
  const items = next[itemsOf].map((it) => {
    if (!asked.has(it[itemKey])) return it
    if (rulings.has(it[itemKey])) return { ...it, digest: digestOf(rulings.get(it[itemKey])) }
    if (!/^F-/.test(it[itemKey])) return it
    if (!flowEls.has(it[itemKey])) throw new LedgerRejected(`${it[itemKey]} が ${ledgerOf('flow').file()} にありません`)
    return { ...it, digest: digestOf(flowEls.get(it[itemKey])) }
  })
  return { ...next, [itemsOf]: items, ...now }
}

function ledgerResult(name, file, tally, value, ws, doc) {
  const spec = ledgerOf(name)
  return {
    ledger: name,
    path: file,
    ...tally,
    count: value ? Object.fromEntries(Object.keys(spec.lists).map((k) => [k, value[k].length])) : {},
    sha256: ledgerSha(ws, name, doc),
    ...(value && spec.filled ? Object.fromEntries(spec.filled.map((k) => [k, value[k]])) : {}),
  }
}

// put: 検査はすべて書く前に済ませ、1 件でも落ちたらファイルに触れない。
const aboutText = (a) => (a && typeof a === 'object' ? canonicalJson(Array.isArray(a.pair) ? { ...a, pair: a.pair.map(String).sort() } : a) : null)

// aboutRejects: 覆されていない（supersedes に挙がっていない）裁定を持つ論点に、別の ID の裁定を足さない。足すと同じ論点に使える根拠が
// 2 つでき、writer が食い違う根拠を受け取る。
function aboutRejects(next, body) {
  const [list, key] = Object.entries(ledgerOf('resolutions').lists)[0]
  const dead = supersededIds(next)
  const live = next[list].filter((r) => !dead.has(String(r[key])) && aboutText(r.about) !== null)
  const sent = new Set(listOf(body, list).map((r) => r[key]))
  return live
    .filter((r) => sent.has(r[key]))
    .flatMap((r) => live.filter((o) => o[key] !== r[key] && aboutText(o.about) === aboutText(r.about)).map((o) => `${r[key]}: 論点 ${aboutText(r.about)} には ${o[key]} の裁定があります（同じ ID を put で直すか、supersedes に ${o[key]} を挙げて覆す）`))
}

// putInput: W の外のファイルは所有表にも片付けにも乗らないので受けない。拒否したら残す（直して流し直せる）。
function putInput(ws, input) {
  const abs = path.resolve(input)
  const real = (p) => (fs.existsSync(p) ? fs.realpathSync(p) : p)
  const rel = path.relative(real(ws), path.join(real(path.dirname(abs)), path.basename(abs))).split(path.sep).join('/')
  const work = ownedPatterns().workDirs.map((re) => re.exec(rel)).find(Boolean)
  if (rel.startsWith('..') || !work) throw new LedgerRejected(`--input は W の作業用ディレクトリ（所有表の tmp/<label>/）の中のファイルにしてください: ${input}`)
  if (!fs.existsSync(abs)) throw new LedgerRejected(`--input のファイルがありません: ${input}`)
  return { abs, text: fs.readFileSync(abs, 'utf8') }
}

function wsPut(ws, opts, readStdin) {
  const name = opts.ledger
  const spec = ledgerOf(name)
  const token = txToken(opts, 'put')
  const file = spec.file(opts.doc.length === 1 ? opts.doc[0] : opts.doc.join(','))
  const input = opts.input ? putInput(ws, opts.input) : null
  const source = input ? '--input' : '標準入力'
  let body
  try {
    body = JSON.parse(input ? input.text : readStdin())
  } catch (e) {
    throw new LedgerRejected(`${source}を JSON として読めません: ${e.message}`)
  }
  if (body && typeof body === 'object' && !Array.isArray(body)) for (const k of spec.filled || []) delete body[k]
  checkShape(name, body, source, true)
  const cur = readLedger(ws, name, opts.doc[0], false) || emptyLedger(spec)
  const shapeBad = fieldRejects(name, body, cur)
  if (shapeBad.length) throw new LedgerRejected(`欄の検査に落ちました（何も書いていません）:\n${shapeBad.join('\n')}`)
  const bad = verbatimRejects(ws, name, body)
  if (bad.length) throw new LedgerRejected(`逐語の照合に落ちました（何も書いていません）:\n${bad.join('\n')}`)
  const refBad = refRejects(ws, name, body)
  if (refBad.length) throw new LedgerRejected(`参照先の照合に落ちました（何も書いていません）:\n${refBad.join('\n')}`)
  let next = { ...emptyLedger(spec), ...cur }
  const tally = { added: [], replaced: [], unchanged: [], removed: [] }
  for (const [k, key] of Object.entries(spec.lists)) {
    if (body[k]) next[k] = dropByCase(spec, k, mergeList(next[k], body[k], key, (spec.groupBy || []).includes(k), tally), body[k])
  }
  for (const k of Object.keys(spec.scalars)) {
    if (!(k in body)) continue
    if (body[k] === null) {
      tally[k in next ? 'removed' : 'unchanged'].push(k)
      delete next[k]
      continue
    }
    tally[!(k in next) ? 'added' : next[k] === body[k] ? 'unchanged' : 'replaced'].push(k)
    next[k] = body[k]
  }
  const aboutBad = name === 'resolutions' ? aboutRejects(next, body) : []
  if (aboutBad.length) throw new LedgerRejected(`同じ論点の裁定が 2 つになります（何も書いていません）:\n${aboutBad.join('\n')}`)
  const caseBad = [...caseRejects(ws, name, next, body), ...(name === 'resolutions' ? answeredByRejects(ws, cur, next, body) : [])]
  if (caseBad.length) throw new LedgerRejected(`欄の条件に落ちました（何も書いていません）:\n${caseBad.join('\n')}`)
  const storedBad = storedRejects(ws, name, next)
  if (storedBad.length) throw new LedgerRejected(`書いた後の版が台帳の形に合いません（何も書いていません。${STORED_FIX}）:\n${storedBad.join('\n')}`)
  if (name === 'verifications') next = fillVerifications(ws, opts, next, body)
  const text = ledgerText(next)
  const p = path.join(ws, file)
  if (!fs.existsSync(p) || fs.readFileSync(p, 'utf8') !== text) {
    txBegin(ws, token, file)
    writeAtomic([p, text])
  }
  if (input) fs.rmSync(input.abs)
  return ledgerResult(name, file, tally, next, ws, opts.doc[0])
}

function wsDel(ws, opts) {
  const name = opts.ledger
  const spec = ledgerOf(name)
  const token = txToken(opts, 'del')
  const file = spec.file(opts.doc.length === 1 ? opts.doc[0] : opts.doc.join(','))
  const lists = Object.keys(spec.lists)
  const coll = opts.collection || (lists.length === 1 ? lists[0] : null)
  if (!coll) throw new LedgerRejected(`台帳 ${name} は配列が複数あるので --collection <${lists.join('|')}> が要ります`)
  if (!lists.includes(coll)) throw new LedgerRejected(`--collection は ${lists.join(' / ')} のどれかです: ${coll}`)
  if (!opts.ids || !opts.ids.length) throw new LedgerRejected('del には --ids a,b が要ります')
  const cur = readLedger(ws, name, opts.doc[0], false)
  const tally = { added: [], replaced: [], unchanged: [], removed: [] }
  const key = spec.lists[coll]
  const ids = [...new Set(opts.ids)]
  for (const id of ids) tally[cur && cur[coll].some((r) => r[key] === id) ? 'removed' : 'unchanged'].push(id)
  if (!cur || !tally.removed.length) return ledgerResult(name, file, tally, cur, ws, opts.doc[0])
  const next = { ...cur, [coll]: cur[coll].filter((r) => !tally.removed.includes(r[key])) }
  const storedBad = storedRejects(ws, name, next)
  if (storedBad.length) throw new LedgerRejected(`消した後の版が台帳の形に合いません（何も書いていません。先に put で直す: ${STORED_FIX}）:\n${storedBad.join('\n')}`)
  txBegin(ws, token, file)
  writeAtomic([path.join(ws, file), ledgerText(next)])
  return ledgerResult(name, file, tally, next, ws, opts.doc[0])
}

const QUESTION_OPTIONS = { min: 2, max: 4 }

// questions: 問いの文面の正本は resolutions.json の question・options だけにし、依頼者に見せる 2 つの形は
// ここで導出する（手で書くと写しが増え、片方だけ直されて食い違う）。--check は同じ検査だけを行い、何も書かない
// （問いを出した resolver が返る前に確かめる。導出はゲートの時点で pending の全件に対して司令塔が行う）。
// answers: 回答のファイルが問いのすべてに `<ID>:` の行を持つか。script はファイルを読めないので、resume が live で走り直して reset が
// answers を消した W でも、この stdout が無ければゲートを越えたことにされる。
// free: 候補の label 1 つだけではない回答の節の逐語（label の後に自由欄が続く・label と違う）。script はファイルを読めないので、回答を当てる resolver の
// プロンプトにはここから写す。パスだけを渡すと「ある（自由欄に書く）」の後の行を読み落とし、選ばなかった候補に当てる。
function wsAnswers(ws, opts) {
  if (!opts.file || !answersFile(opts.file)) throw new LedgerRejected(`answers には --file answers/<ゲート>.md が要ります（所有表の answers/ の下のファイル）`)
  if (!opts.ids || !opts.ids.length) throw new LedgerRejected('answers には --ids RS-… が要ります')
  const ids = [...new Set(opts.ids)].sort()
  const file = path.join(ws, opts.file)
  const exists = fs.existsSync(file)
  const text = exists ? fs.readFileSync(file, 'utf8') : ''
  const lines = text.split('\n')
  const heads = new Set(lines.map(answerLineId).filter(Boolean))
  const [listName, key] = Object.entries(ledgerOf('resolutions').lists)[0]
  const rs = listOf(readLedger(ws, 'resolutions'), listName)
  const byId = new Map(rs.map((r) => [String(r[key]), r]))
  const labels = (id) => new Set(((byId.get(id) || {}).options || []).map((o) => o && typeof o.label === 'string' && o.label.trim()).filter(Boolean))
  const lastFilled = (s) => {
    let to = s.to
    while (to > s.from && !lines[to - 1].trim()) to -= 1
    return to
  }
  const free = answerSections(lines, rs)
    .filter((s) => ids.includes(s.id) && s.text !== '' && !labels(s.id).has(s.text))
    .map((s) => ({ id: s.id, from: s.from, to: lastFilled(s), text: s.text }))
  return { file: opts.file, exists, ids, missing: ids.filter((id) => !heads.has(id)), free }
}

function wsQuestions(ws, opts) {
  if (!opts.ids || !opts.ids.length) throw new LedgerRejected('questions には --ids RS-… が要ります')
  const [listName, key] = Object.entries(ledgerOf('resolutions').lists)[0]
  const byId = new Map(listOf(readLedger(ws, 'resolutions'), listName).map((r) => [r[key], r]))
  const bad = []
  const qs = []
  for (const id of [...new Set(opts.ids)]) {
    const r = byId.get(id)
    const q = r && r.question
    const options = r && Array.isArray(r.options) ? r.options : []
    const refBad = r ? flowRefRejects(ws, [r]) : []
    if (!r) bad.push(`${id}: ${ledgerOf('resolutions').file()} にありません`)
    else if (r.answer != null) bad.push(`${id}: 回答（answer）が残っています（続きの問いにするなら answer と value に null を送って消す）`)
    else if (!q || typeof q.header !== 'string' || typeof q.text !== 'string' || typeof q.searched !== 'string') bad.push(`${id}: question { header, text, searched } がありません`)
    else if (options.length < QUESTION_OPTIONS.min || options.length > QUESTION_OPTIONS.max) bad.push(`${id}: 候補が ${options.length} 個です（${QUESTION_OPTIONS.min}〜${QUESTION_OPTIONS.max} 個）`)
    else if (options.some((o) => !o || typeof o.label !== 'string' || typeof o.description !== 'string' || typeof o.flow_effect !== 'string')) bad.push(`${id}: 候補に label・description・flow_effect の無いものがあります`)
    else if (refBad.length) bad.push(`${id}: ${refBad.join(' / ')}`)
    else qs.push({ id, q, options })
  }
  if (opts.check) {
    if (bad.length) process.stderr.write(`${bad.join('\n')}\n`)
    return { check: true, ids: [...new Set(opts.ids)], questions: qs.length, findings: bad.length, bad_ids: bad.map((b) => b.split(':')[0]), bad }
  }
  if (bad.length) throw new LedgerRejected(`問いを導出できません（何も書いていません）:\n${bad.join('\n')}`)
  const md = qs
    .flatMap(({ id, q, options }) => [
      `## ${id}`,
      '',
      q.text,
      '',
      `依頼文で探したところ: ${q.searched}`,
      '',
      ...options.map((o) => `- **${o.label}**: ${o.description}（選ばれたら: ${o.flow_effect}）`),
      '',
    ])
    .join('\n')
  const json = `${JSON.stringify(qs.map(({ id, q, options }) => ({ id, header: q.header, question: q.text, options: options.map((o) => ({ label: o.label, description: o.description })) })), null, 1)}\n`
  writeAtomic([path.join(ws, 'questions.md'), md], [path.join(ws, 'questions.json'), json])
  return {
    questions: qs.length,
    md: { path: 'questions.md', sha256: sha256Bytes(Buffer.from(md)) },
    json: { path: 'questions.json', sha256: sha256Bytes(Buffer.from(json)) },
  }
}

const fenceOf = (text) => '`'.repeat(Math.max(4, ...(String(text).match(/`+/g) || []).map((m) => m.length + 1)))

// report: 事後報告は resolutions.json の method・answered_by・hold・upstream_revision から導出する。answered_by は依頼者の回答を
// 別の論点に当てた裁定で、依頼者はここで初めて見て覆せる。手で書くと、同じ事実を
// resolutions と 2 か所に持ち、型も決まらない。
function wsReport(ws, opts) {
  const [listName] = Object.keys(ledgerOf('resolutions').lists)
  const rs = listOf(readLedger(ws, 'resolutions'), listName)
  const method = rs.filter((r) => r.ruling === 'method')
  const answeredBy = rs.filter((r) => r.ruling === 'answered_by')
  const cited = (r) => (Array.isArray(r.evidence) ? r.evidence : []).map((e) => `${path.relative(ws, String((e && e.file) || ''))}#L${e && e.line}「${(e && e.quote) ?? ''}」`).join('、')
  const draftIds = new Set(opts.drafts || [])
  const unknown = [...draftIds].filter((id) => !rs.some((r) => r.id === id && r.ruling === 'hold'))
  if (unknown.length) throw new Error(`--drafts に hold でない ID があります: ${unknown.join(', ')}`)
  const holds = rs.filter((r) => r.ruling === 'hold' && !draftIds.has(r.id))
  const drafts = rs.filter((r) => draftIds.has(r.id))
  const upstream = rs.filter((r) => r.upstream_revision != null)
  const block = (label, text) => {
    const fence = fenceOf(text)
    return [`**${label}**:`, '', `${fence}markdown`, String(text ?? ''), fence, '']
  }
  const holdBlock = (r) => {
    const h = r.hold || {}
    return [`### ${r.id}`, '', `**保持規則**: ${h.rule ?? ''}`, '', `**触れる項目**: ${(Array.isArray(h.item_ids) ? h.item_ids : []).join('、') || '（なし）'}`, '', ...block('Issue の文案', h.issue_draft)]
  }
  const md = [
    '# 事後報告',
    '',
    '## 方法論として決めたこと',
    '',
    ...(method.length ? method.map((r) => `- ${r.id}: ${r.value ?? ''}（${r.why ?? ''}）`) : ['0 件。']),
    '',
    '## 既にある回答の当てはめ',
    '',
    ...(answeredBy.length ? answeredBy.map((r) => `- ${r.id}: ${r.value ?? ''}（${r.why ?? ''}。回答: ${cited(r)}）`) : ['0 件。']),
    '',
    '## 保持規則と Issue の文案',
    '',
    ...(holds.length ? [] : ['0 件。', '']),
    ...holds.flatMap(holdBlock),
    '## 保持規則の文案（本文に未反映）',
    '',
    ...(drafts.length ? [] : ['0 件。', '']),
    ...drafts.flatMap(holdBlock),
    '## 上位文書の改訂の文案',
    '',
    ...(upstream.length ? [] : ['0 件。', '']),
    ...upstream.flatMap((r) => [`### ${r.id}`, '', ...block('改訂の文案', r.upstream_revision)]),
  ].join('\n')
  writeAtomic([path.join(ws, 'report.md'), md])
  // report は司令塔が run の返った後に実行するので、動いている label は無い。
  const swept = sweepWorkDirs(ws, [], 'report')
  return { path: 'report.md', method: method.length, answered_by: answeredBy.length, holds: holds.length, drafts: drafts.length, upstream_revisions: upstream.length, sha256: sha256Bytes(Buffer.from(md)), ...swept }
}

function workspaceDocs(ws) {
  return fs
    .readdirSync(ws)
    .filter((n) => DOC_FILE.test(n))
    .sort()
    .map((name) => {
      const [, kind, topic] = DOC_FILE.exec(name)
      const meta = readLedger(ws, 'meta', `${kind}/${topic}`)
      return { key: `${kind}/${topic}`, kind, topic, path: name, markdown: fs.readFileSync(path.join(ws, name), 'utf8'), meta }
    })
}

// itemSections: 区間の text は末尾の空白行を落とす（項目の間の空行の出し入れを変更と数えないため）。
function itemSections(md, kind) {
  const lines = String(md || '').split('\n')
  const out = []
  const seen = new Map()
  let inFence = false
  let cur = { heading: null, start: 1, lines: [] }
  const close = () => {
    if (cur.heading === null && !cur.lines.some((l) => l.trim())) return
    const ids = cur.heading ? cur.heading.match(ID_IN_TEXT[kind]) || [] : []
    const base = ids.length ? ids[0] : `§${cur.heading === null ? '(冒頭)' : cur.heading.replace(/^#+\s*/, '').trim()}`
    const n = (seen.get(base) || 0) + 1
    seen.set(base, n)
    out.push({ key: n > 1 ? `${base}#${n}` : base, id: ids.length ? ids[0] : null, start: cur.start, lines: cur.lines, text: cur.lines.join('\n').replace(/\s+$/, '') })
  }
  lines.forEach((ln, i) => {
    if (/^\s*(```|~~~)/.test(ln)) inFence = !inFence
    else if (!inFence && /^#{1,6}\s/.test(ln)) {
      close()
      cur = { heading: ln.trim(), start: i + 1, lines: [] }
    }
    cur.lines.push(ln)
  })
  close()
  return out
}

// docItems: snapshot に載せる項目ごとの hash。ID の項目は本文の区間とその項目の trace を合わせて hash する
// （根拠だけを差し替えた変更も監査の範囲に入れるため）。TBD の候補は TBD の ID を key にし、meta の残りは
// 「<文書>§(meta)」にまとめる。ID を持たない区間の key には文書キーを前に付ける（文書を跨いで一意にするため）。
function docItems(d) {
  const meta = d.meta || {}
  const trace = Array.isArray(meta.trace) ? meta.trace : []
  const secs = itemSections(d.markdown, d.kind)
  const idKeys = new Set(secs.filter((s) => s.id && s.key === s.id).map((s) => s.id))
  const items = {}
  for (const s of secs) {
    const own = s.id && s.key === s.id
    items[own ? s.key : `${d.key}${s.key}`] = digestOf({ text: s.text, trace: own ? trace.filter((t) => t && t.item_id === s.id) : [] })
  }
  if (d.meta) {
    const tbd = Array.isArray(meta.tbd) ? meta.tbd : []
    for (const t of tbd) if (t && t.id) items[String(t.id)] = digestOf(t)
    const rest = { ...meta, trace: trace.filter((t) => !t || !idKeys.has(t.item_id)), tbd: tbd.filter((t) => !t || !t.id) }
    items[`${d.key}§(meta)`] = digestOf(rest)
  }
  return items
}

// snapshotOf: { 文書キー: { 項目 key: hash } }。この形の digest が tree digest であり、snapshot --save が
// 返す digest と tree-digest が返す digest は、同じ木なら同じ文字列になる（ラベルやパスを入れない）。
function snapshotOf(wsDocs) {
  return Object.fromEntries(wsDocs.map((d) => [d.key, docItems(d)]))
}

// traceabilityOf: 両方の ID が揃わない行は紐付けとして数えない（片側だけの行を数えると、根拠の無い仕様項目が
// 「紐付け済み」に化ける）。
function traceabilityOf(md) {
  const links = []
  const lines = new Set()
  for (const sec of sectionsOf2(md)) {
    for (const t of tablesOf(sec)) {
      const rc = t.header.findIndex((c) => /要求\s*ID/.test(c))
      const sc = t.header.findIndex((c) => /仕様(項目)?\s*ID/.test(c))
      if (rc < 0 || sc < 0) continue
      lines.add(t.line)
      for (const r of t.rows) {
        lines.add(r.line)
        const reqs = String(r.cells[rc] || '').match(ID_IN_TEXT.requirements) || []
        const specs = String(r.cells[sc] || '').match(ID_IN_TEXT.specifications) || []
        for (const q of reqs) for (const s of specs) links.push({ requirement_id: q, spec_id: s })
      }
    }
  }
  return { links, lines }
}

// deriveDocs: この導出では申告と本文の突き合わせ（UNDECLARED / PHANTOM）は起こりえないので、
// 代わりに参照先の実在を REF_UNDEFINED で検査する。
function deriveDocs(wsDocs) {
  return wsDocs.map((d) => {
    const secs = itemSections(d.markdown, d.kind)
    const ids = [...new Set(secs.map((s) => s.id).filter(Boolean))]
    const idSet = new Set(ids)
    const inText = [...new Set(d.markdown.match(ID_IN_TEXT[d.kind]) || [])]
    const trace = d.meta ? (Array.isArray(d.meta.trace) ? d.meta.trace : []) : undefined
    const tr = d.kind === 'specifications' ? traceabilityOf(d.markdown) : { links: [], lines: new Set() }
    return {
      key: d.key,
      kind: d.kind,
      topic: d.topic,
      path: d.path,
      markdown: d.markdown,
      ids,
      referenced: inText.filter((id) => !idSet.has(id)),
      vacant: [],
      traceability: tr.links,
      traceLines: tr.lines,
      tbd_items: d.meta && Array.isArray(d.meta.tbd) ? d.meta.tbd : [],
      trace,
      flow_refs: (trace || []).filter((t) => t && t.kind === 'flow' && t.ref).map((t) => ({ item_id: t.item_id, ref: t.ref })),
      fixed: Boolean(d.meta && d.meta.fixed),
    }
  })
}

// 曖昧語（requirement-writing-rules.md §2）。偽陽性は writer の内部ループを空回りさせるので、複合語の
// 一部になる語（同等・等しい・これまで など）は外す。「まで」と「前後」は数量に付いたときだけ拾う
// （「裁定が下るまで」は保持規則の定型であり、境界の曖昧さではない）。
const AMBIGUOUS_JA = [
  ['適切', /適切[にな]/],
  ['必要に応じて', /必要に応じて/],
  ['可能な限り', /可能な限り/],
  ['柔軟に', /柔軟に/],
  ['速やかに', /速やかに/],
  ['原則として', /原則として/],
  ['等', /(?<![同平均対上高初劣優一二三中下特何彼])等(?![しくい価号級式分辺間])/],
  ['など', /など/],
  ['十分な', /十分な/],
  ['適宜', /適宜/],
  ['基本的に', /基本的に/],
  ['高速に', /高速に/],
  ['使いやすい', /使いやすい/],
  ['安定した', /安定した/],
  ['極力', /極力/],
  ['なるべく', /なるべく/],
  ['場合によっては', /場合によっては/],
  ['想定される', /想定される/],
  ['考慮する', /考慮す/],
  ['まで', /\d[\d.,]*\s*[^\s\d。、）)]{0,4}まで/],
  ['最大', /最大/],
  ['最小', /最小/],
  ['程度', /程度/],
  ['前後', /\d[\d.,]*\s*[^\s\d。、）)]{0,4}前後/],
]
const AMBIGUOUS_EN =
  /\b(minimi[sz]e|maximi[sz]e|optimi[sz]e|fast|prompt|quick|rapid|user-friendly|easy|intuitive|sufficient|adequate|appropriate|approximately|about|around|usually|typically|normally|as needed|as required|if necessary|etc|and so on|including but not limited to)\b/i
const CJK = /[぀-ヿ㐀-鿿]/

// 開いている TBD に触れる文の断定。裁定を待つ語（まで・裁定・解消 など）を含まず、禁止・許容以外の
// 断定の語尾（〜しなければならない・〜する・〜である など）で終わる文だけを拾う。名詞で終わる文
// （「TBD-X を参照」）は断定とも保持とも読めないので拾わない（偽陽性より取りこぼしを選ぶ）。
const HOLD_MARKER = /(まで|裁定|決まる|決まっ|決まら|解消|保留|未定|未決|未確定)/
const HOLD_END = /(てはならない|てもよい)$/
const ASSERT_END = /(なければならない|ことが望ましい|ない|です|ます|である|だ|た|[うくぐすつぬぶむる])$/

function sentencesOf(line) {
  return line.split('。').map((s) => s.trim()).filter(Boolean)
}

function workspaceExtraCompact(docs, openTbd) {
  const out = []
  const defined = new Set(docs.flatMap((d) => d.ids))
  const vacantAll = new Set()
  for (const d of docs) {
    for (const ln of d.markdown.split('\n')) {
      if (!ln.includes('欠番')) continue
      for (const re of Object.values(ID_IN_TEXT)) for (const id of ln.match(re) || []) vacantAll.add(id)
    }
  }
  // 参照先の種別の文書が 1 つも無いときは、その種別の参照を検査しない（NC_CROSSREF と同じ理由。
  // 要求文書を書く前の仕様書では、要求 ID の参照がすべて未定義に化ける）。
  const kindsPresent = new Set(docs.map((d) => d.kind))
  const open = new Set(openTbd)
  for (const d of docs) {
    if (d.fixed) continue
    const refSeen = new Set()
    let inFence = false
    d.markdown.split('\n').forEach((ln, i) => {
      if (/^\s*(```|~~~)/.test(ln)) inFence = !inFence
      if (inFence || /^\s*(```|~~~)/.test(ln) || d.traceLines.has(i + 1)) return
      for (const [kind, re] of Object.entries(ID_IN_TEXT)) {
        if (!kindsPresent.has(kind)) continue
        for (const id of ln.match(re) || []) {
          if (defined.has(id) || vacantAll.has(id) || refSeen.has(id)) continue
          refSeen.add(id)
          out.push({ c: 'REF_UNDEFINED', d: d.key, a: [d.key, id] })
        }
      }
    })
    for (const s of itemSections(d.markdown, d.kind)) {
      const where = s.id || s.key
      const ambSeen = new Set()
      const tbdSeen = new Set()
      let fence = false
      s.lines.forEach((ln, k) => {
        if (/^\s*(```|~~~)/.test(ln)) {
          fence = !fence
          return
        }
        const t = ln.trim()
        if (fence || !t || k === 0 && /^#/.test(t) || /^>/.test(t)) return
        const isTable = t.startsWith('|')
        for (const sent of sentencesOf(t)) {
          if (s.id) {
            const words = CJK.test(sent) ? AMBIGUOUS_JA.filter(([, re]) => re.test(sent)).map(([w]) => w) : [(sent.match(AMBIGUOUS_EN) || [])[1]].filter(Boolean).map((w) => w.toLowerCase())
            for (const w of words) {
              if (ambSeen.has(w)) continue
              ambSeen.add(w)
              out.push({ c: 'AMBIGUOUS', d: d.key, a: [d.key, s.id, w, sent.slice(-60)] })
            }
          }
          if (isTable) continue
          const body = sent.replace(/[（(][^（）()]*[）)]\s*$/, '').replace(/[。．.、,\s]+$/, '')
          if (HOLD_MARKER.test(sent) || HOLD_END.test(body) || !ASSERT_END.test(body)) continue
          for (const id of sent.match(TBD_ID_IN_TEXT) || []) {
            if (!open.has(id) || tbdSeen.has(id)) continue
            tbdSeen.add(id)
            out.push({ c: 'TBD_ASSERT', d: d.key, a: [d.key, id, where, sent.slice(-60)] })
          }
        }
      })
    }
  }
  return out
}

const decisionRefs = (source) => (Array.isArray(source) ? source : source ? [source] : []).map((s) => s && typeof s === 'object' && String(s.decision ?? '').trim()).filter(Boolean)

const constraintsOf = (el) => [...new Set((Array.isArray(el.constrained_by) ? el.constrained_by : []).map((x) => String(x).trim()).filter(Boolean))]

const EFFECT = LEDGERS.flow.enums.elements.effect

function flowSourceCompact(flow, decisionIds, openIds, inv) {
  const out = []
  const check = (where, source, badShape, allowed = ['input', 'decision', 'open']) => {
    const sources = Array.isArray(source) ? source : source ? [source] : []
    if (!sources.length) return badShape(true)
    for (const s of sources) {
      const kinds = s && typeof s === 'object' && !Array.isArray(s) ? ['input', 'decision', 'open'].filter((k) => String(s[k] ?? '').trim()) : []
      if (kinds.length !== 1 || !allowed.includes(kinds[0])) {
        badShape(false)
        continue
      }
      const ref = String(s[kinds[0]]).trim()
      if (kinds[0] === 'decision' && !decisionIds.has(ref)) out.push({ c: 'FLOW_SOURCE_UNKNOWN', d: 'flow', a: [where, 'decision', ref] })
      if (kinds[0] === 'open' && !openIds.has(ref)) out.push({ c: 'FLOW_SOURCE_UNKNOWN', d: 'flow', a: [where, 'open', ref] })
    }
  }
  for (const el of listOf(flow, 'elements')) {
    if (!el || !el.id) continue
    check(el.id, el.source, (none) => (none ? out.push({ c: 'FLOW_NOSOURCE', d: 'flow', a: [el.id] }) : out.push({ c: 'FLOW_SOURCE_SHAPE', d: 'flow', a: [el.id] })))
    // on_fail は settle が差し替えない出典なので、{ open } を受けない。
    if (el.on_fail) check(`${el.id}.on_fail`, el.on_fail.source, (none) => out.push({ c: none ? 'FLOW_NOSOURCE' : 'FLOW_SOURCE_SHAPE', d: 'flow', a: [`${el.id}.on_fail`] }), ['input', 'decision'])
    for (const ref of constraintsOf(el)) if (!decisionIds.has(ref) && !inv.open.has(ref)) out.push({ c: 'FLOW_CONSTRAINT_UNKNOWN', d: 'flow', a: [el.id, ref] })
    if (el.type === 'step' && !EFFECT.includes(el.effect)) out.push({ c: 'FLOW_EFFECT_MISSING', d: 'flow', a: [el.id, String(el.effect ?? '')] })
    const bound = (ref) => inv.live.has(ref) || inv.open.has(ref) || inv.dead.has(ref)
    if (el.type === 'step' && el.effect === 'destructive' && !constraintsOf(el).some(bound)) out.push({ c: 'FLOW_DESTRUCTIVE_UNCONSTRAINED', d: 'flow', a: [el.id] })
    if (el.type !== 'decision' || !Array.isArray(el.cases)) continue
    el.cases.forEach((c, i) => check(`${el.id}.case${i + 1}`, c && c.source, () => out.push({ c: 'FLOW_CASE_NOSOURCE', d: 'flow', a: [el.id, i + 1] })))
  }
  return out
}

const OBTAIN = LEDGERS.flow.enums.elements.obtain

// failBranches: 判断 el の、要素 x の失敗の枝（上記以外と * は、得られないときの行き先を選んだことにならない）。
function failBranches(el, x) {
  const unknowns = (Array.isArray(el.inputs) ? el.inputs : []).filter((i) => i && i.from === x && i.unknown != null && Array.isArray(i.values) && i.values.map(String).includes(String(i.unknown)))
  const cases = Array.isArray(el.cases) ? el.cases : []
  return new Set(cases.filter((c) => c && c.when && typeof c.when === 'object' && unknowns.some((i) => Object.hasOwn(c.when, i.name) && String(c.when[i.name]) === String(i.unknown))).map((c) => String(c.branch)))
}

// flowTableCompact: decision ごとの判定表（inputs × cases）。網羅と一意は文書の判定表と同じ tableFindings で見る。
// 行き先の同じ値を 1 つの枝に畳んだ判断は、下流が値を使わない限り、分類を潰したまま検査を通る。
function flowTableCompact(flow) {
  const out = []
  const els = listOf(flow, 'elements').filter((el) => el && el.id)
  const byId = new Map(els.map((el) => [el.id, el]))
  const nextOf = (el) => [...(Array.isArray(el.next) ? el.next : []), ...(el.type === 'decision' && Array.isArray(el.branches) ? el.branches.map((b) => b && b.next) : [])].filter((x) => byId.has(x))
  const reach = (starts, stop) => {
    const seen = new Set()
    const queue = starts.filter((x) => byId.has(x) && x !== stop)
    while (queue.length) {
      const id = queue.shift()
      if (seen.has(id)) continue
      seen.add(id)
      queue.push(...nextOf(byId.get(id)).filter((x) => x !== stop))
    }
    return seen
  }
  // 失敗が値になる場所は may_fail の要素ごとに 1 つ: (a) next が 1 つの判断で、それが unknown 付きでこの要素を読む。(b) on_fail.as。
  // 下流への伝播は計算しない（制御の流れで伝えると、失敗を使わない判断で止まり、処理済みの失敗を越えて伝わる）。
  const handled = new Map()
  for (const el of els.filter((x) => x.type !== 'decision' && x.obtain === 'may_fail')) {
    const next = Array.isArray(el.next) ? el.next : []
    const d = next.length === 1 ? byId.get(next[0]) : null
    const a = Boolean(d && d.type === 'decision' && (Array.isArray(d.inputs) ? d.inputs : []).some((i) => i && i.from === el.id && i.unknown != null))
    const b = el.on_fail != null
    const as = b && typeof el.on_fail === 'object' && !Array.isArray(el.on_fail) && String(el.on_fail.as ?? '').trim() ? String(el.on_fail.as) : null
    if (b && as === null) out.push({ c: 'FLOW_ON_FAIL_AS', d: 'flow', a: [el.id] })
    if (a === b) out.push({ c: 'FLOW_FAIL_UNHANDLED', d: 'flow', a: [el.id, a] })
    else if (b) {
      if (as !== null) handled.set(el.id, { as })
    } else {
      const fails = failBranches(d, el.id)
      // 再試行で el に戻る枝の先は、el の次の試行なので失敗の枝の先に数えない。
      handled.set(el.id, { at: new Set([d.id, ...reach((d.branches || []).filter((x) => x && fails.has(String(x.value))).map((x) => x.next), el.id)]) })
    }
  }
  const usedBy = new Map()
  for (const el of els.filter((x) => x.type === 'decision')) {
    for (const inp of Array.isArray(el.inputs) ? el.inputs : []) {
      if (!inp || !inp.from) continue
      if (!usedBy.has(inp.from)) usedBy.set(inp.from, new Set())
      usedBy.get(inp.from).add(el.id)
    }
  }
  for (const el of els.filter((x) => x.type === 'decision')) {
    const inputs = Array.isArray(el.inputs) ? el.inputs : []
    const cases = Array.isArray(el.cases) ? el.cases : []
    const branchValues = (Array.isArray(el.branches) ? el.branches : []).map((b) => b && String(b.value))
    const targets = new Set((Array.isArray(el.branches) ? el.branches : []).map((b) => b && b.next))
    if (targets.size === 1 && branchValues.length > 1) {
      const seen = reach(nextOf(el))
      if (![...(usedBy.get(el.id) || [])].some((id) => seen.has(id))) out.push({ c: 'FLOW_SAME_NEXT', d: 'flow', a: [el.id, [...targets][0]] })
    }
    const badInput = inputs.find((i) => !i || !String(i.name || '').trim() || !Array.isArray(i.values) || !i.values.length)
    if (!inputs.length || !cases.length || badInput) {
      out.push({ c: 'FLOW_NO_TABLE', d: 'flow', a: [el.id] })
      continue
    }
    for (const inp of inputs) {
      const from = byId.get(inp.from)
      if (!from) {
        out.push({ c: 'FLOW_INPUT_FROM', d: 'flow', a: [el.id, String(inp.name), String(inp.from ?? '')] })
        continue
      }
      const values = inp.values.map(String)
      if (from.type === 'decision') continue
      if (!OBTAIN.includes(from.obtain)) out.push({ c: 'FLOW_OBTAIN_MISSING', d: 'flow', a: [from.id, String(from.obtain ?? '')] })
      const h = from.obtain === 'may_fail' && handled.get(from.id)
      if (h && h.as !== undefined && !values.includes(h.as)) out.push({ c: 'FLOW_INPUT_ON_FAIL', d: 'flow', a: [el.id, String(inp.name), h.as] })
      if (h && h.at && h.at.has(el.id) && (inp.unknown == null || !values.includes(String(inp.unknown)))) out.push({ c: 'FLOW_INPUT_UNKNOWN', d: 'flow', a: [el.id, String(inp.name), String(inp.unknown ?? '')] })
    }
    const names = inputs.map((i) => String(i.name))
    const isElse = (c) => Boolean(c && c.when && c.when['上記以外'])
    const rows = []
    cases.forEach((c, i) => {
      if (!c || !branchValues.includes(String(c.branch))) out.push({ c: 'FLOW_CASE_BRANCH', d: 'flow', a: [el.id, i + 1, String(c && c.branch)] })
      if (isElse(c)) return
      const when = c && c.when && typeof c.when === 'object' ? c.when : {}
      for (const k of Object.keys(when)) if (!names.includes(k)) out.push({ c: 'FLOW_DT_VALUE', d: 'flow', a: [el.id, k, String(when[k])] })
      rows.push({ no: i + 1, vals: names.map((n) => (n in when ? String(when[n]) : '（書かれていない）')), res: String(c && c.branch) })
    })
    const chosen = new Set(cases.map((c) => c && String(c.branch)))
    for (const v of branchValues) if (!chosen.has(v)) out.push({ c: 'FLOW_BRANCH_UNUSED', d: 'flow', a: [el.id, v] })
    const conds = inputs.map((i) => ({ name: String(i.name), values: i.values.map(String) }))
    const found = tableFindings(conds, rows, cases.some(isElse))
    for (const f of found) {
      if (f.kind === 'value') out.push({ c: 'FLOW_DT_VALUE', d: 'flow', a: [el.id, f.name, f.value] })
      if (f.kind === 'too_many') out.push({ c: 'FLOW_DT_SIZE', d: 'flow', a: [el.id, f.total] })
      if (f.kind === 'gap') out.push({ c: 'FLOW_DT_GAP', d: 'flow', a: [el.id, f.combo] })
      if (f.kind === 'overlap') out.push({ c: 'FLOW_DT_OVERLAP', d: 'flow', a: [el.id, f.combo, f.a, f.b] })
    }
    if (found.some((f) => f.kind === 'too_many')) continue
    // 得られないときの値（unknown と on_fail.as）のマスは、その値を when に書いた case だけが受ける（上記以外と * は、得られないときの行き先を選んだことにならない）。
    const gaps = new Set(found.filter((f) => f.kind === 'gap').map((f) => f.combo))
    inputs.forEach((inp, at) => {
      const h = handled.get(inp.from)
      for (const v of new Set([inp.unknown, h && h.as].filter((x) => x != null).map(String))) {
        if (!inp.values.map(String).includes(v)) continue
        const only = conds.map((c, ci) => (ci === at ? { ...c, values: [v] } : c))
        const explicit = rows.filter((r) => r.vals[at] === v)
        for (const f of tableFindings(only, explicit, false)) if (f.kind === 'gap' && !gaps.has(f.combo)) out.push({ c: 'FLOW_UNKNOWN_CASE', d: 'flow', a: [el.id, String(inp.name), f.combo, v] })
      }
    })
  }
  return out
}

// flowLintCompact: scope（今の版に合格の無い要素）の外は見ない。合格した要素を直させると、settle と verifier の検証の対象が増える。
function flowLintCompact(flow, scope, decisionIds, superseded) {
  const out = []
  // 形の崩れた出典は SHAPE・UNKNOWN だけで指摘し、UNGROUNDED と二重にしない。
  const grounded = (where, source) => {
    const sources = Array.isArray(source) ? source : source ? [source] : []
    for (const s of sources) {
      const kinds = s && typeof s === 'object' && !Array.isArray(s) ? ['input', 'decision', 'open'].filter((k) => String(s[k] ?? '').trim()) : []
      if (kinds.length !== 1 || kinds[0] === 'open') {
        out.push({ c: 'LINT_GROUNDS_SHAPE', d: 'flow', a: [where] })
        continue
      }
      const ref = String(s[kinds[0]]).trim()
      if (kinds[0] === 'decision' && (!decisionIds.has(ref) || superseded.has(ref))) out.push({ c: 'LINT_GROUNDS_UNKNOWN', d: 'flow', a: [where, ref] })
    }
    return sources.length > 0
  }
  for (const el of listOf(flow, 'elements')) {
    if (!el || !el.id || el.type !== 'step' || !scope.has(el.id) || !EFFECT.includes(el.effect) || el.effect === 'read') continue
    if (el.obtain === 'always' && !grounded(`${el.id}.obtain_source`, el.obtain_source)) out.push({ c: 'LINT_OBTAIN_UNGROUNDED', d: 'flow', a: [el.id, el.effect] })
  }
  return out
}

// docLintCompact: 項目の節は、その見出しより深い見出し（小見出しの下の表を含む）を越え、同じか浅い見出しか ID を持つ見出しで終わる。
// 表の前の語は閉集合にする（任意の語を許すと「以下の内容を公表」の公表・代表を拾う）。後の「示・記・現…」は「次の表示」「以下の表現」を除く。
const TABLE_KINDS = ['判定', '対応', '一覧', '決定', '条件', '状態遷移', '状態', 'イベント', '対照', '比較', '項目']
const TABLE_POINTER = new RegExp(`(?:(?:次|以下)の(?:${TABLE_KINDS.join('|')})?表|次に示す表|下記の表|下表)(?![示記現面明情す])`)
function docLintCompact(docs) {
  const out = []
  const unquote = (ln) => ln.replace(/^\s*>\s?/, '')
  for (const d of docs) {
    const lines = d.markdown.split('\n')
    let inFence = false
    const body = lines.map((ln) => {
      const fence = /^\s*(```|~~~)/.test(ln)
      if (fence) inFence = !inFence
      return fence || inFence ? '' : ln
    })
    const heads = body.map((ln, i) => [i, /^(#{1,6})\s/.exec(ln)]).filter(([, m]) => m).map(([i, m]) => ({ i, depth: m[1].length, id: (body[i].match(ID_IN_TEXT[d.kind]) || [])[0] || null }))
    heads.forEach((h, k) => {
      if (!h.id) return
      const end = heads.slice(k + 1).find((x) => x.depth <= h.depth || x.id)
      const sec = body.slice(h.i + 1, end ? end.i : body.length)
      const m = TABLE_POINTER.exec(sec.join('\n'))
      if (!m) return
      const hasTable = sec.some((ln, j) => cellsOf(unquote(ln)) && isSeparator(cellsOf(unquote(sec[j + 1] || ''))))
      if (!hasTable) out.push({ c: 'LINT_TABLE_ELSEWHERE', d: d.key, a: [h.id, d.key, m[0]] })
    })
  }
  return out
}

function lintResult(ws, name, list) {
  const grouped = groupCompact(list)
  const body = expandWorkspace({ findings: grouped, not_checked: [] }, LINT_TEXT)
  const codes = {}
  for (const g of grouped) codes[g.c] = [...(codes[g.c] || []), ...g.a.map((a) => String(a[0]))]
  return { lint: body.findings.length, lint_codes: codes, lint_path: writeCheck(ws, name, body) }
}

// flowHistoryCompact: put 以外の経路で入った経緯の印を、put と同じ欄と印で拾う。
function flowHistoryCompact(flow) {
  const out = []
  const scan = (where, pathKey, text) => {
    const mark = HISTORY_FIELDS.includes(pathKey) ? historyMark(text ?? '') : null
    if (mark) out.push({ c: 'FLOW_HISTORY', d: 'flow', a: [where, mark] })
  }
  scan('closure', 'flow.closure', flow && flow.closure)
  for (const el of listOf(flow, 'elements')) if (el && el.id) scan(`${el.id}.label`, 'flow.elements.label', el.label)
  for (const k of listOf(flow, 'kinds')) if (k && k.name) scan(`${k.name}.definition`, 'flow.kinds.definition', k.definition)
  return out
}

function groupCompact(list) {
  const seen = new Set()
  const grouped = []
  for (const f of list) {
    const k = canonicalJson([f.c, f.d, f.a])
    if (seen.has(k)) continue
    seen.add(k)
    const last = grouped[grouped.length - 1]
    if (last && last.c === f.c && last.d === f.d) last.a.push(f.a)
    else grouped.push({ c: f.c, d: f.d, a: [f.a] })
  }
  return grouped
}

function expandWorkspace(compact, table = { ...FINDING_TEXT, ...WORKSPACE_TEXT }) {
  const make = (c, args) => {
    const t = table[c]
    if (!t) throw new Error(`構造検査の未知の種別です: ${JSON.stringify(c)}`)
    return t(...(args || []))
  }
  const findings = []
  for (const g of compact.findings || []) {
    for (const args of (g && g.a) || []) {
      const t = make(g.c, args)
      findings.push({ id: t.id, document: g.d, location: t.location, quote: t.quote, ...(t.severity ? { severity: t.severity } : {}), issue: t.issue, fix: t.fix })
    }
  }
  return { findings, not_checked: (compact.not_checked || []).map((n) => make(n && n.c, n && n.a)) }
}

function writeCheck(ws, name, content) {
  const rel = `checks/${name}`
  fs.mkdirSync(path.join(ws, 'checks'), { recursive: true })
  writeAtomic([path.join(ws, rel), `${JSON.stringify(content, null, 1)}\n`])
  return rel
}

function decisionIdsOf(ws) {
  const ids = [...listOf(readLedger(ws, 'decisions'), 'decisions'), ...listOf(readLedger(ws, 'resolutions'), 'resolutions')]
  return new Set(ids.filter((x) => x && x.id).map((x) => String(x.id)))
}

const invariantOpenIds = (open) => new Set(listOf(open, 'open').filter((x) => x && x.id && x.kind === 'invariant').map((x) => String(x.id)))

const supersededIds = (resolutions) =>
  new Set(
    listOf(resolutions, 'resolutions')
      .flatMap((r) => (r && r.supersedes != null ? [].concat(r.supersedes) : []))
      .map((x) => String(x).trim())
      .filter(Boolean)
  )

// invariantsOf: 覆された・検証に落ちた不変条件（dead）は縛りにならない。dead を引く要素は stale_refs で settle に直させるので、
// その間は FLOW_DESTRUCTIVE_UNCONSTRAINED にしない（verifier の flow の検査で段が止まり、差し戻しにも settle にも届かない）。
function invariantsOf(ws) {
  const resolutions = readLedger(ws, 'resolutions')
  const failed = listOf(readLedger(ws, 'verifications'), 'items').filter((it) => it && it.verdict === 'fail').map((it) => String(it.id))
  const dead = new Set([...supersededIds(resolutions), ...failed])
  const kinds = [...listOf(readLedger(ws, 'decisions'), 'decisions'), ...listOf(resolutions, 'resolutions')].filter((x) => x && x.id && x.kind === 'invariant').map((x) => String(x.id))
  return { live: new Set(kinds.filter((id) => !dead.has(id))), dead: new Set(kinds.filter((id) => dead.has(id))), open: invariantOpenIds(readLedger(ws, 'open')) }
}

function selectDocs(keys, wanted) {
  for (const k of wanted) if (!keys.includes(k)) throw new Error(`--doc ${k} は workspace にありません（あるのは ${keys.join(' / ') || 'なし'}）`)
  return wanted.length ? wanted : keys
}

// carriesVerdict: 合否を持ち越す書き換えの正本。持ち越すのは根拠を増やさない書き換えだけ: 問いと保持規則への書き換えの不合格（変換した分は
// もう検証しない）と、検証した候補の decision_text を value に写しただけの候補の選択。合格は、保持規則の文（hold）・問いの形の修正で変えた候補の文・
// 自由記述の value を検証していないので持ち越さない（持ち越すと、検証していない文が保持規則や根拠として writer に届く）。
function carriesVerdict(judged, r) {
  if (judged.digest === digestOf(r)) return true
  if (['hold', 'question'].includes(r.ruling) && judged.verdict === 'fail') return true
  if (r.ruling !== 'question' || judged.verdict !== 'pass') return false
  const { answer, value, ...asked } = r
  const chosen = value === undefined || (Array.isArray(r.options) && r.options.some((o) => o && o.decision_text === value))
  return chosen && judged.digest === digestOf(asked)
}

// rulingsCompact: resolution の行を ruling・has_answer・verdict・fail_kind の組ごとに束ね、組の中は ID から about への表にする。verifier と
// flow-check はこの stdout を逐語で写すので、行ごとに欄名と同じ値を繰り返すと写す字数が台帳の件数に比例して膨らむ。
// 行への戻し方の正本は prd-spec.js の rulingRows。
function rulingsCompact(rows) {
  const groups = new Map()
  for (const r of rows) {
    const head = { ruling: r.ruling, has_answer: r.has_answer, verdict: r.verdict, ...(Object.hasOwn(r, 'fail_kind') ? { fail_kind: r.fail_kind } : {}) }
    const key = canonicalJson(head)
    if (!groups.has(key)) groups.set(key, { ...head, about: {} })
    groups.get(key).about[r.id] = r.about
  }
  return [...groups.values()]
}

function wsFlow(ws, opts) {
  requireInput(ws)
  const flow = readLedger(ws, 'flow')
  if (flow === null) throw new Error(`${ledgerOf('flow').file()} がありません`)
  const openIds = new Set(listOf(readLedger(ws, 'open'), 'open').filter((x) => x && x.id).map((x) => String(x.id)))
  const inv = invariantsOf(ws)
  const list = [...flowGraphCompact(flow), ...flowSourceCompact(flow, decisionIdsOf(ws), openIds, inv), ...flowTableCompact(flow), ...flowHistoryCompact(flow)]
  const grouped = groupCompact(list)
  const body = expandWorkspace({ findings: grouped, not_checked: [] })
  const digest = digestOf(body)
  // codes: 指摘を消せる役は符号で決まる（prd-spec.js の FIXERS_BY_CODE）。件数だけでは、生成者に消せない指摘を生成者に差し戻してしまう。
  const codes = {}
  for (const g of grouped) codes[g.c] = [...(codes[g.c] || []), ...g.a.map((a) => String(a[0]))]
  const els = listOf(flow, 'elements').filter((el) => el && el.id)
  const items = listOf(readLedger(ws, 'verifications'), 'items')
  const verdictAt = (verdict) => new Set(items.filter((it) => it && it.verdict === verdict && it.digest).map((it) => `${it.id}\u0000${it.digest}`))
  const [passed, failed] = [verdictAt('pass'), verdictAt('fail')]
  const unverified = els.filter((el) => !passed.has(`${el.id}\u0000${digestOf(el)}`)).map((el) => el.id)
  const failedCurrent = els.filter((el) => failed.has(`${el.id}\u0000${digestOf(el)}`)).map((el) => el.id)
  // resolutions は --rulings のときだけ出す: script がファイルを読めない代わりに今の版の合否を知る元で、全 resolution の行を毎回写すと
  // flow を返すすべての役の出力が台帳の大きさに比例して増える（形は rulingsCompact）。合否を検証した版にだけ付けるのは、検証の後に書き換えた裁定を根拠に使わせないため。
  const verdicts = new Map(items.filter((it) => it && it.id && it.verdict).map((it) => [String(it.id), it]))
  const stored = listOf(readLedger(ws, 'resolutions'), 'resolutions').filter((r) => r && r.id)
  const resolutions = stored
    .map((r) => {
      const judged = verdicts.get(String(r.id))
      const v = judged && carriesVerdict(judged, r) ? judged : null
      return { id: String(r.id), about: r.about ?? null, ruling: r.ruling ?? null, has_answer: r.answer != null, verdict: v ? v.verdict : null, ...(v && v.verdict === 'fail' ? { fail_kind: v.fail_kind ?? null } : {}) }
    })
  // どの O- が裁定済みかは state を持つ script が決める（ここで判断すると、同じ cycle で閉じた O- を 1 手遅れで見る）。
  const opensOnly = (source) => {
    const sources = Array.isArray(source) ? source : source ? [source] : []
    const opens = sources.map((s) => s && typeof s === 'object' && String(s.open ?? '').trim())
    return sources.length && opens.every(Boolean) ? [...new Set(opens)] : []
  }
  const openOnly = els.flatMap((el) => [
    ...opensOnly(el.source).map((o) => ({ el: el.id, open: o })),
    ...(el.type === 'decision' && Array.isArray(el.cases) ? el.cases : []).flatMap((c, i) => opensOnly(c && c.source).map((o) => ({ el: el.id, case: i + 1, open: o }))),
    ...constraintsOf(el).filter((ref) => openIds.has(ref)).map((o) => ({ el: el.id, constraint: o })),
  ])
  // supersedes で覆された決定を引く要素。出典の実在だけを見る FLOW_SOURCE_UNKNOWN では、覆された ID も実在するので出ない。
  const superseded = supersededIds(readLedger(ws, 'resolutions'))
  const staleRefs = els.flatMap((el) => {
    const cases = el.type === 'decision' && Array.isArray(el.cases) ? el.cases : []
    const refs = new Set([...decisionRefs(el.source), ...decisionRefs(el.on_fail && el.on_fail.source), ...cases.flatMap((c) => decisionRefs(c && c.source)), ...constraintsOf(el)])
    return [...refs].filter((ref) => superseded.has(ref) || (inv.dead.has(ref) && constraintsOf(el).includes(ref))).map((ref) => ({ el: String(el.id), ref }))
  })
  // content_sha256 は flow.json のバイト列から取る。digest は指摘の一覧の値で、指摘が 0 件の flow どうしを区別できない。
  return {
    findings: body.findings.length,
    codes,
    open: openIds.size,
    path: writeCheck(ws, 'flow.json', { ...body, digest }),
    digest,
    content_sha256: ledgerSha(ws, 'flow'),
    unverified,
    failed_current: failedCurrent,
    ...(opts.rulings ? { resolutions: rulingsCompact(resolutions) } : {}),
    answer_holds: answerHolds(ws, stored),
    open_only: openOnly,
    stale_refs: staleRefs,
    open_ids: [...openIds].sort(),
    pair_keys: pairKeysOf(conflictPairs(readLedger(ws, 'decisions'), flow, readLedger(ws, 'open')).pairs),
    ...(opts.lint ? lintResult(ws, 'flow.lint.json', flowLintCompact(flow, new Set(unverified), decisionIdsOf(ws), superseded)) : {}),
  }
}

// conflicts: 同じ target を持つ決定どうし、決定と flow の要素（id か label が target に一致するか、要素の constrained_by が
// その決定を挙げる）の組を列挙する。target の一致だけでは、名前の違う決定と要素（不可逆な操作の禁止と reset の工程）が組にならない。
// 組の探索を resolver の生成に任せると探索の量に上限が無くなるので、ここで閉集合にして resolver には
// 判定だけをさせる。target の無い決定は組を作れないので untargeted として件数とともに返す（見ていないものを宣言する）。
// conflictPairs: flow の stdout も同じ組を出す（verifier と flow-check が、組を申告した生成者と別に数える）。
function conflictPairs(decisions, flow, open) {
  const ds = listOf(decisions, 'decisions')
    .filter((x) => x && x.id)
    .map((x) => ({ id: String(x.id), targets: [...new Set((Array.isArray(x.targets) ? x.targets : []).map((t) => String(t).trim()).filter(Boolean))] }))
  const els = listOf(flow, 'elements').filter((el) => el && el.id)
  const pairs = []
  for (let i = 0; i < ds.length; i++) {
    for (let j = i + 1; j < ds.length; j++) {
      const shared = ds[i].targets.filter((t) => ds[j].targets.includes(t))
      if (shared.length) pairs.push({ kind: 'decision-decision', a: ds[i].id, b: ds[j].id, targets: shared.sort() })
    }
    for (const el of els) {
      const shared = ds[i].targets.filter((t) => t === String(el.id) || t === String(el.label || '').trim())
      if (shared.length) pairs.push({ kind: 'decision-flow', a: ds[i].id, b: String(el.id), targets: shared.sort() })
    }
  }
  const paired = new Set(pairs.map((p) => `${p.a}|${p.b}`))
  const openIds = invariantOpenIds(open)
  const selfSourced = []
  for (const el of els) {
    const cited = sourcedDecisions(el)
    for (const ref of constraintsOf(el).filter((r) => !paired.has(`${r}|${el.id}`) && !openIds.has(r))) {
      // 組にしない範囲の理由は契約「## flow.json の形」の conflicts の項。
      if (ledgerOf('resolutions').keyShape.test(ref) && cited.has(ref)) selfSourced.push({ a: ref, b: String(el.id) })
      else pairs.push({ kind: 'constrained-by', a: ref, b: String(el.id) })
    }
  }
  pairs.sort((x, y) => x.kind.localeCompare(y.kind) || x.a.localeCompare(y.a) || x.b.localeCompare(y.b))
  selfSourced.sort((x, y) => x.a.localeCompare(y.a) || x.b.localeCompare(y.b))
  return { ds, pairs, selfSourced }
}

const sourcedDecisions = (el) => {
  const cases = el.type === 'decision' && Array.isArray(el.cases) ? el.cases : []
  return new Set([...decisionRefs(el.source), ...cases.flatMap((c) => decisionRefs(c && c.source))])
}

const pairKeysOf = (pairs) => pairs.map((p) => `pair:${[p.a, p.b].map(String).sort().join('|')}`)

function wsConflicts(ws) {
  requireInput(ws)
  const decisions = readLedger(ws, 'decisions')
  if (decisions === null) throw new Error(`${ledgerOf('decisions').file()} がありません`)
  const flow = readLedger(ws, 'flow')
  const { ds, pairs, selfSourced } = conflictPairs(decisions, flow, readLedger(ws, 'open'))
  const untargeted = ds.filter((x) => !x.targets.length).map((x) => x.id).sort()
  const body = { pairs, untargeted, self_sourced: selfSourced, flow_checked: flow !== null }
  const digest = digestOf(body)
  return {
    pairs: pairs.length,
    decision_pairs: pairs.filter((p) => p.kind === 'decision-decision').length,
    flow_pairs: pairs.filter((p) => p.kind === 'decision-flow').length,
    constraint_pairs: pairs.filter((p) => p.kind === 'constrained-by').length,
    untargeted: untargeted.length,
    self_sourced: selfSourced.length,
    flow_checked: flow !== null,
    path: writeCheck(ws, 'conflicts.json', { ...body, digest }),
    digest,
    pair_keys: pairKeysOf(pairs),
  }
}

const DOMAIN = { file: path.join('references', 'domain-analysis.md'), heading: /^## 2\. /, irreversible: 'irreversible' }
const PLAN_VERDICT_NEEDS = { 該当: 'decision', 非該当: 'decision', 不明: 'open' }

// domainAspects: 観点のキーは domain-analysis.md §2 から毎回読み、写しを持たない（intake が読む一覧と検査がずれない）。
function domainAspects() {
  const lines = fs.readFileSync(path.join(SKILL_DIR, DOMAIN.file), 'utf8').split('\n')
  const start = lines.findIndex((l) => DOMAIN.heading.test(l))
  const end = lines.findIndex((l, i) => i > start && /^## /.test(l))
  const keys = start < 0 ? [] : lines.slice(start + 1, end < 0 ? undefined : end).map((l) => /^\d+\. `([a-z_]+)`/.exec(l)).filter(Boolean).map((m) => m[1])
  if (!keys.includes(DOMAIN.irreversible)) throw new Error(`観点のキー（${DOMAIN.file} の §2）を読み取れないか、${DOMAIN.irreversible} がありません`)
  return keys
}

// plan: intake の出力の検査。不変条件の起こし漏れは intake にしか直せないので、flow ではなくここで止める。
function wsPlan(ws) {
  const plan = readJsonFile(path.join(ws, 'plan.json'))
  if (plan === null) throw new Error('plan.json がありません')
  const keys = domainAspects()
  const refs = { decision: decisionIdsOf(ws), open: new Set(listOf(readLedger(ws, 'open'), 'open').filter((x) => x && x.id).map((x) => String(x.id))) }
  const inv = invariantsOf(ws)
  const domain = listOf(plan, 'domain')
  const out = []
  const seen = new Map()
  for (const d of domain) {
    const aspect = String((d && d.aspect) ?? '')
    if (!keys.includes(aspect)) {
      out.push({ c: 'PLAN_ASPECT_UNKNOWN', d: 'plan', a: [aspect] })
      continue
    }
    seen.set(aspect, (seen.get(aspect) || 0) + 1)
    const need = Object.hasOwn(PLAN_VERDICT_NEEDS, d.verdict) ? PLAN_VERDICT_NEEDS[d.verdict] : null
    if (!need) out.push({ c: 'PLAN_VERDICT', d: 'plan', a: [aspect, String(d.verdict ?? '')] })
    else if (!refs[need].has(String(d[need] ?? '').trim())) out.push({ c: 'PLAN_REF', d: 'plan', a: [aspect, need, String(d[need] ?? '')] })
  }
  for (const k of keys) {
    if (!seen.has(k)) out.push({ c: 'PLAN_ASPECT_MISSING', d: 'plan', a: [k] })
    else if (seen.get(k) > 1) out.push({ c: 'PLAN_ASPECT_DUP', d: 'plan', a: [k] })
  }
  const irreversible = domain.some((d) => d && d.aspect === DOMAIN.irreversible && d.verdict === '該当')
  if (irreversible && !inv.live.size && !inv.open.size) out.push({ c: 'PLAN_INVARIANT_MISSING', d: 'plan', a: [] })
  const body = expandWorkspace({ findings: groupCompact(out), not_checked: [] })
  const digest = digestOf(body)
  // content_sha256: intake の後で plan.json が書き換えられていないかを、script が次の段の stdout と照合する。
  return { findings: body.findings.length, path: writeCheck(ws, 'plan.json', { ...body, digest }), digest, content_sha256: sha256Bytes(fs.readFileSync(path.join(ws, 'plan.json'))) }
}

// doc: 開いている TBD は --open-tbd
// （script が解消済みを除いて算出したもの）を正とし、無ければ meta の TBD の候補の和を使う（どちらを
// 使ったかを結果に書く）。--doc を付けると、その文書の指摘だけを別のファイルに書く（並列の writer が
// 同じ結果ファイルを奪い合わないため。検査そのものは文書を跨いで全体に当てる）。
function wsDoc(ws, opts) {
  const wsDocs = workspaceDocs(ws)
  if (!wsDocs.length) throw new Error('workspace に文書（requirements-*.md / specifications-*.md）がありません')
  const selected = selectDocs(wsDocs.map((d) => d.key), opts.doc)
  const plan = readJsonFile(path.join(ws, 'plan.json'))
  const coversOf = new Map(listOf(plan, 'docs').filter((p) => p && p.key).map((p) => [p.key, Array.isArray(p.covers) ? p.covers : []]))
  const docs = deriveDocs(wsDocs).map((d) => ({ ...d, covers: coversOf.get(d.key) || [] }))
  const openTbd = opts.openTbd
    ? { source: 'args', ids: [...new Set(opts.openTbd)].sort() }
    : { source: 'meta', ids: [...new Set(docs.flatMap((d) => d.tbd_items.map((t) => t && t.id).filter(Boolean)))].sort() }
  const flow = readLedger(ws, 'flow')
  const structural = structuralCompact(docs, flow)
  const open = new Set(openTbd.ids)
  const kept = structural.findings
    .map((g) => (g.c === 'UNDECLARED_TBD' ? { ...g, a: g.a.filter((a) => !open.has(a[0])) } : g))
    .filter((g) => g.a.length)
  const all = [...kept, ...groupCompact(workspaceExtraCompact(docs, openTbd.ids))]
  const expanded = expandWorkspace({ findings: opts.doc.length ? all.filter((g) => selected.includes(g.d)) : all, not_checked: structural.not_checked })
  const tree = digestOf(snapshotOf(wsDocs))
  const body = {
    tree_digest: tree,
    documents: docs.map((d) => ({ key: d.key, path: d.path, fixed: d.fixed, line_count: lineTotal(d.markdown), byte_size: Buffer.byteLength(d.markdown, 'utf8'), ids: d.ids })),
    open_tbd: openTbd,
    findings: expanded.findings,
    not_checked: expanded.not_checked,
  }
  const digest = digestOf(body)
  const name = opts.doc.length ? `doc.${selected.map(indexName).join('+')}.json` : 'doc.json'
  // 固定の文書はラン内で書き換えないので、その指摘は blocking に数えない（数えると直せない件数で収束が止まる）。
  // ORPHAN-REQ は書いている仕様書の側で直せるものにしか出ないので数える（DUP は直せる文書へ帰属させてある）。
  const fixedKeys = new Set(docs.filter((d) => d.fixed).map((d) => d.key))
  const counted = expanded.findings.filter((f) => !fixedKeys.has(f.document) || f.id.startsWith('ST-ORPHAN-REQ-'))
  const degraded = counted.filter((f) => f.severity === 'degraded').length
  // flow_refs: 項目 → trace が指す flow 要素。prd-spec.js はファイルを読めないので、改稿の writer に渡す要素の ID はここから取る。
  const flowRefs = {}
  for (const d of docs.filter((x) => selected.includes(x.key))) {
    for (const { item_id: item, ref } of d.flow_refs) {
      const byItem = (flowRefs[d.key] ||= {})
      byItem[item] = [...new Set([...(byItem[item] || []), ref])].sort()
    }
  }
  return {
    findings: expanded.findings.length,
    blocking: counted.length - degraded,
    degraded,
    fixed_findings: expanded.findings.length - counted.length,
    not_checked: expanded.not_checked.length,
    path: writeCheck(ws, name, { ...body, digest }),
    digest,
    tree_digest: tree,
    flow_refs: flowRefs,
    ...(opts.lint ? lintResult(ws, name.replace(/\.json$/, '.lint.json'), docLintCompact(docs.filter((d) => selected.includes(d.key) && !d.fixed))) : {}),
  }
}

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CONTRACT_FILE = path.join('schemas', 'agent-contracts.md')
const OWNERSHIP = { file: CONTRACT_FILE, heading: '## W のファイルと書き手' }

// contractSection: 契約の「## 見出し」の行から次の「## 」の手前までの行（見出しの行を含む）。見出しが無ければ null。
function contractSection(lines, heading) {
  const start = lines.indexOf(heading)
  if (start < 0) return null
  const end = lines.findIndex((l, i) => i > start && /^## /.test(l))
  return lines.slice(start, end < 0 ? undefined : end)
}

// CONTRACT_SECTIONS: 役（agents/ のファイル名）ごとに読む契約の節の正本（prd-spec.js は役のファイル名を渡すだけ）。COMMON_SECTIONS は
// 書き込みの規則で、書く役にだけ配る（flow-check は何も書かない）。
const COMMON_SECTIONS = ['共通の約束', 'W のファイルと書き手']
// FLOW_SHAPE: 見出しは台帳のファイル名を含むので、名前は LEDGERS から取る（ファイル名の正本は LEDGERS）。
const FLOW_SHAPE = `${ledgerOf('flow').file()} の形`
const CONTRACT_SECTIONS = {
  intake: [...COMMON_SECTIONS, '§intake', '決定の台帳', '現物と既存実装の扱い', '不変条件の kind'],
  'flow-framer': [...COMMON_SECTIONS, '§flow-framer', FLOW_SHAPE, '不変条件の kind'],
  resolver: [...COMMON_SECTIONS, '§resolver', '決定の台帳', '現物と既存実装の扱い', FLOW_SHAPE, '不変条件の kind'],
  'resolver-verifier': [...COMMON_SECTIONS, '§resolver-verifier', '決定の台帳', '現物と既存実装の扱い', FLOW_SHAPE, '不変条件の kind'],
  writer: [...COMMON_SECTIONS, '§writer', '現物と既存実装の扱い'],
  implementer: [...COMMON_SECTIONS, '監査役の共通節', '§implementer'],
  grounding: [...COMMON_SECTIONS, '監査役の共通節', '§grounding', '現物と既存実装の扱い'],
  'cross-doc': [...COMMON_SECTIONS, '監査役の共通節', '§cross-doc'],
  'flow-check': ['§flow-check'],
}

// CONTRACT_BUDGET・CONTRACT_PARTS: contract の 1 回の stdout の上限（UTF-8 のバイト）と、役ごとの回数の上限。agent の Bash は 30000 バイトを
// 超える出力をファイルに逃がして先頭しか見せないので、上限ごとに分けた全部を最初のターンに並べて実行させる。CONTRACT_PARTS は prd-spec.js と
// 同じ（tests が照合する）。
const CONTRACT_BUDGET = 30000
const CONTRACT_PARTS = 2

// contractText: 役が読む節を契約から逐語で切り出す（見出しを探して節ごとに Read する往復をなくす）。見出しが欠ければ止める（節を黙って落とさない）。
function contractText(role) {
  if (!Object.hasOwn(CONTRACT_SECTIONS, role)) throw new Error(`--role には役のファイル名（${Object.keys(CONTRACT_SECTIONS).join(' / ')}）を渡してください: ${role}`)
  const lines = fs.readFileSync(path.join(SKILL_DIR, CONTRACT_FILE), 'utf8').split('\n')
  const names = CONTRACT_SECTIONS[role]
  const missing = names.filter((n) => !contractSection(lines, `## ${n}`))
  if (missing.length) throw new Error(`契約（${CONTRACT_FILE}）に見出しがありません: ${missing.map((n) => `「## ${n}」`).join('・')}`)
  return `${names.map((n) => contractSection(lines, `## ${n}`).join('\n').replace(/\n+$/, '')).join('\n\n')}\n`
}

// contractParts: contractText を CONTRACT_BUDGET 以下の断片に切る。切れ目は節の頭を優先し、1 つの節が上限を超えるときだけ行の頭で切る
// （断片をつなげると contractText に戻る）。
function contractParts(role) {
  const text = contractText(role)
  const bytes = (a, b) => Buffer.byteLength(text.slice(a, b), 'utf8')
  const heads = [...text.matchAll(/^## /gm)].map((m) => m.index)
  const lineHeads = [...text.matchAll(/^/gm)].map((m) => m.index)
  const parts = []
  for (let at = 0; at < text.length; ) {
    if (bytes(at) <= CONTRACT_BUDGET) {
      parts.push(text.slice(at))
      break
    }
    const fit = (xs) => xs.filter((x) => x > at && bytes(at, x) <= CONTRACT_BUDGET).pop()
    const cut = fit(heads) ?? fit(lineHeads)
    if (cut === undefined) throw new Error(`役 ${role} の契約に、1 行で ${CONTRACT_BUDGET} バイトを超える行があります`)
    parts.push(text.slice(at, cut))
    at = cut
  }
  if (parts.length > CONTRACT_PARTS) throw new Error(`役 ${role} の契約の節は ${parts.length} 回に分かれ、上限 ${CONTRACT_PARTS} 回を超えます`)
  return parts
}

function wsContract(opts) {
  const part = Number(opts.part ?? 1)
  if (!Number.isInteger(part) || part < 1 || part > CONTRACT_PARTS) throw new Error(`--part は 1〜${CONTRACT_PARTS} の整数です: ${opts.part}`)
  return contractParts(opts.role)[part - 1] ?? ''
}

// ownedPatterns: 所有表は契約から毎回読み、写しを持たない（写すと表を直しても検出が古いまま残る）。<…> に
// ドットを許さないのは、版を付けた写し（requirements-x.pre2.md）を表に合わせないため。
function ownedPatterns() {
  const text = fs.readFileSync(path.join(SKILL_DIR, OWNERSHIP.file), 'utf8')
  const unreadable = () => new Error(`所有表（${OWNERSHIP.file} の「${OWNERSHIP.heading}」の表の 1 列目）を読み取れません。W に置いてよいファイルが決まらないので止めます`)
  const section = contractSection(text.split('\n'), OWNERSHIP.heading)
  if (!section) throw unreadable()
  const cells = section.slice(1).filter((l) => /^\|/.test(l)).map((l) => l.split('|')[1] || '')
  const pats = cells.flatMap((c) => [...c.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim()))
  if (!pats.length) throw unreadable()
  const esc = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  const toRe = (p, name) => esc(p).replace(/<[^>]+>/g, name).replace(/\*/g, '[^/]*')
  return {
    files: pats.filter((p) => !p.endsWith('/')).map((p) => new RegExp(`^${toRe(p, '[^/.]+')}$`)),
    workDirs: pats.filter((p) => p.endsWith('/')).map((p) => new RegExp(`^${toRe(p, '([^/]+)')}`)),
    workBases: pats.filter((p) => p.endsWith('/')).map((p) => p.replace(/<[^>]+>\/$/, '')),
  }
}

// planDocFiles: 文書と meta は plan.json の docs[].key から導いた名前だけを置いてよいものにする。所有表の
// パターンでは、版名を付けた写し（requirements-auth-v2.md）と正当な topic を区別できない。
function planDocFiles(ws) {
  const plan = readJsonFile(path.join(ws, 'plan.json'))
  if (plan === null) throw new Error('plan.json がありません。置いてよい文書のファイル名が決まらないので、stray を判定できません')
  const keys = listOf(plan, 'docs').map((d) => d && d.key)
  return new Set(keys.flatMap((k) => [`${String(k).replace('/', '-')}.md`, ledgerOf('meta').file(k)]))
}

function strayFiles(ws, live) {
  const { files, workDirs } = ownedPatterns()
  const docs = planDocFiles(ws)
  const alive = new Set(live || [])
  const out = []
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(ws, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(r)
      else {
        const work = workDirs.map((re) => re.exec(r)).find(Boolean)
        const stray = work ? !alive.has(work[1]) : DOC_PREFIX.test(r) ? !docs.has(r) : !files.some((re) => re.test(r))
        if (stray) out.push(r)
      }
    }
  }
  walk('')
  return out.sort()
}

// sizesOf: 台帳と文書のファイルごとのバイト数。SIZE_BUDGET は目安なので、超えても止めずに数えるだけにする。全件はファイルにだけ書く（stdout は監査役が
// 逐語で写し、script は件数とパスしか読まない）。
function sizesOf(ws, wsDocs, name) {
  const entries = [
    ...Object.keys(LEDGERS).filter((n) => n !== 'meta').map((n) => [n, ledgerOf(n).file()]),
    ...wsDocs.flatMap((d) => [['document', d.path], ['meta', ledgerOf('meta').file(d.key)]]),
  ].filter(([, f]) => fs.existsSync(path.join(ws, f)))
  const sizes = Object.fromEntries(entries.map(([, f]) => [f, fs.statSync(path.join(ws, f)).size]))
  const over = entries.filter(([n, f]) => sizes[f] > SIZE_BUDGET[n]).map(([n, f]) => ({ file: f, bytes: sizes[f], budget: SIZE_BUDGET[n] }))
  return { size_over: { count: over.length, path: writeCheck(ws, `${name}.sizes.json`, { budget: SIZE_BUDGET, sizes, over }) } }
}

// sweepWorkDirs: --live は今動いている label のすべてでなければならない（並列の writer の tree-digest は他の label を知らないので --sweep で明示させる）。
// swept に出すのは消したファイルとリンクだけで、中身の無いディレクトリは数えない。リンクは辿らない（rmSync はリンクだけを消す）。
function sweepWorkDirs(ws, live, name) {
  const alive = new Set(live)
  const dirs = ownedPatterns().workBases.flatMap((base) => {
    const abs = path.join(ws, base)
    if (!fs.existsSync(abs)) return []
    return fs.readdirSync(abs, { withFileTypes: true }).filter((e) => e.isDirectory() && !alive.has(e.name)).map((e) => `${base}${e.name}`)
  })
  const entries = (rel) => fs.readdirSync(path.join(ws, rel), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? entries(`${rel}/${e.name}`) : [`${rel}/${e.name}`]))
  const swept = dirs.flatMap((d) => {
    const listed = entries(d)
    fs.rmSync(path.join(ws, d), { recursive: true, force: true })
    return listed
  })
  return { swept: { count: swept.length, path: writeCheck(ws, `${name}.swept.json`, { swept: swept.sort() }) } }
}

// treeFindings: snapshot と tree-digest の所見。一覧は checks/<name>.* に書き、stdout には件数とパスだけを出す
// （一覧を stdout に載せると、script が notices に入れて next_args が上限なしに膨らむ）。name を snapshot の label に
// するのは、後の snapshot が先の notices の指す一覧を上書きしないため。
function treeFindings(ws, wsDocs, live, name) {
  const stray = strayFiles(ws, live)
  return { stray: { count: stray.length, path: writeCheck(ws, `${name}.stray.json`, { stray }) }, ...sizesOf(ws, wsDocs, name) }
}

// snapshot --save: audited- で始まるラベルは --role auditor のときだけ保存する。CLI は呼び出し元を識別できないので、これは書き手が監査の基準を
// 取り違えて上書きする事故を防ぐだけである。基準の差し替えを検出するのは diff の --expect の照合。
function wsSnapshot(ws, opts) {
  const label = opts.save
  if (!label) throw new Error('snapshot には --save <label> が要ります')
  if (!LABEL.test(label)) throw new Error(`ラベルは英数字と . _ - だけにしてください: ${label}`)
  if (label.startsWith('audited-') && opts.role !== 'auditor') {
    throw new Error('audited- で始まるラベルは --role auditor のときだけ保存できます（監査の基準は監査役だけが保存する）')
  }
  if (opts.sweep && !opts.live) throw new Error('--sweep には --live <今動いている label,…> が要ります（挙げなかった label の作業用ディレクトリを消すため）')
  const swept = opts.sweep ? sweepWorkDirs(ws, opts.live, label) : {}
  const wsDocs = workspaceDocs(ws)
  const found = { ...treeFindings(ws, wsDocs, opts.live, label), ...swept }
  const items = snapshotOf(wsDocs)
  const digest = digestOf(items)
  const docs = Object.fromEntries(wsDocs.map((d) => [d.key, { path: d.path, digest: digestOf({ [d.key]: items[d.key] }), items: items[d.key] }]))
  const rel = writeCheck(ws, `${label}.snapshot.json`, { label, digest, docs })
  const fixed = opts.fixed ? { fixed_sha256: fixedShas(ws, opts.fixed) } : {}
  return { label, docs: wsDocs.length, items: Object.values(items).reduce((n, x) => n + Object.keys(x).length, 0), path: rel, digest, ...found, ...fixed }
}

// diff: snapshot の
// digest はファイルの items から計算し直し、ファイルに書かれた digest と --expect の両方に一致しなければ
// 失敗にする（どちらか一方との照合だと、items を書き換えたファイルを受け入れてしまう）。失敗したときは
// 以前の diff の結果ファイルも消す（古い結果を今回の結果として読ませないため）。
function wsDiff(ws, opts) {
  if (!opts.against || !opts.expect) throw new Error('diff には --against <label> と --expect <digest> が要ります')
  if (!LABEL.test(opts.against)) throw new Error(`ラベルは英数字と . _ - だけにしてください: ${opts.against}`)
  const outRel = `checks/diff-${opts.against}.json`
  const snap = readJsonFile(path.join(ws, 'checks', `${opts.against}.snapshot.json`))
  if (snap === null) throw new Error(`checks/${opts.against}.snapshot.json がありません`)
  const prev = Object.fromEntries(Object.entries((snap && snap.docs) || {}).map(([k, v]) => [k, (v && v.items) || {}]))
  const recomputed = digestOf(prev)
  if (recomputed !== snap.digest || recomputed !== opts.expect) {
    fs.rmSync(path.join(ws, outRel), { force: true })
    throw new DigestMismatch(`snapshot ${opts.against} の digest が一致しません（--expect ${opts.expect} / 記録 ${snap.digest} / 再計算 ${recomputed}）`)
  }
  const cur = snapshotOf(workspaceDocs(ws))
  const byDoc = {}
  const all = { changed: [], added: [], removed: [] }
  for (const key of [...new Set([...Object.keys(prev), ...Object.keys(cur)])].sort()) {
    const p = prev[key] || {}
    const c = cur[key] || {}
    const r = {
      changed: Object.keys(c).filter((k) => k in p && p[k] !== c[k]).sort(),
      added: Object.keys(c).filter((k) => !(k in p)).sort(),
      removed: Object.keys(p).filter((k) => !(k in c)).sort(),
    }
    if (!r.changed.length && !r.added.length && !r.removed.length) continue
    byDoc[key] = r
    for (const f of Object.keys(all)) all[f].push(...r[f])
  }
  for (const f of Object.keys(all)) all[f] = [...new Set(all[f])].sort()
  const tree = digestOf(cur)
  const rel = writeCheck(ws, `diff-${opts.against}.json`, { against: opts.against, expect: opts.expect, tree_digest: tree, ...all, by_doc: byDoc })
  return { changed: all.changed.length, added: all.added.length, removed: all.removed.length, path: rel, tree_digest: tree }
}

// tree-digest: 今の木の digest。--doc を付けるとその文書だけの digest（snapshot の docs[key].digest と同じ値）。
function wsTreeDigest(ws, opts) {
  const wsDocs = workspaceDocs(ws)
  const items = snapshotOf(wsDocs)
  const selected = selectDocs(Object.keys(items), opts.doc)
  const subset = Object.fromEntries(selected.map((k) => [k, items[k]]))
  return { digest: digestOf(subset), docs: selected.length, items: selected.reduce((n, k) => n + Object.keys(items[k]).length, 0), ...treeFindings(ws, wsDocs, opts.live, 'tree-digest') }
}

// index: INDEX は本体の写しなので、手で書くと必ず本体と drift する。司令塔はこの
// ファイルを保存先へ逐語で写すだけにする（司令塔が文を書かないため）。
const cellOf = (v) => String(v == null ? '' : v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
function wsIndex(ws, opts) {
  const wsDocs = workspaceDocs(ws)
  if (!wsDocs.length) throw new Error('workspace に文書（requirements-*.md / specifications-*.md）がありません')
  const plan = readJsonFile(path.join(ws, 'plan.json'))
  const concernOf = (key) => (listOf(plan, 'docs').find((d) => d && d.key === key) || {}).concern || '—'
  const docs = deriveDocs(wsDocs)
  const dirs = { requirements: opts.reqDir || 'docs/requirements', specifications: opts.specDir || 'docs/specifications' }
  const pathOf = (d) => `${dirs[d.kind]}/${d.topic}.md`
  const headings = (d) => {
    const out = {}
    for (const sec of itemSections(d.markdown, d.kind)) {
      if (sec.id && !(sec.id in out)) out[sec.id] = String(sec.lines[0] || '').replace(/^#+\s*/, '').replace(sec.id, '').trim()
    }
    return out
  }
  const openIds = new Set(opts.openTbd || docs.flatMap((d) => d.tbd_items.map((t) => t && t.id).filter(Boolean)))
  const specs = docs.filter((d) => d.kind === 'specifications')
  const links = specs.flatMap((s) => s.traceability.map((l) => ({ ...l, spec: s })))
  const written = {}
  for (const kind of ['requirements', 'specifications']) {
    const target = docs.filter((d) => d.kind === kind)
    if (!target.length) continue
    const label = kind === 'requirements' ? '要求' : '仕様項目'
    const lines = [`# ${dirs[kind]} 目次`, '', 'この INDEX は doc_check が文書から導出したものである。本体を直したら導出し直す（手書きしない）。', '']
    lines.push('## 文書一覧', '', `| パス | 扱う関心事 | ${label}の数 |`, '|---|---|---|')
    for (const d of target) lines.push(`| \`${pathOf(d)}\` | ${cellOf(concernOf(d.key))} | ${d.ids.length} |`)
    lines.push('', `## ${label}一覧`, '', '| ID | 見出し | 所在文書 |', '|---|---|---|')
    for (const d of target) {
      const hs = headings(d)
      for (const id of d.ids) lines.push(`| ${cellOf(id)} | ${cellOf(hs[id])} | \`${pathOf(d)}\` |`)
    }
    lines.push('')
    const seen = {}
    for (const d of target) for (const id of d.ids) seen[id] = (seen[id] || 0) + 1
    const dup = Object.values(seen).filter((n) => n > 1).length
    if (kind === 'requirements') {
      lines.push('## 関連する仕様文書', '', '| 要求文書 | 対応する仕様文書 |', '|---|---|')
      for (const d of target) {
        const own = new Set(d.ids)
        const related = [...new Set(links.filter((l) => own.has(l.requirement_id)).map((l) => `\`${pathOf(l.spec)}\``))]
        lines.push(`| \`${pathOf(d)}\` | ${related.join(' / ') || '（対応する仕様文書なし）'} |`)
      }
      lines.push('', '## 未解決（着手を止める未確定事項）', '')
      const blocking = target.flatMap((d) => d.tbd_items.filter((t) => t && t.id && t.blocking && openIds.has(t.id)).map((t) => ({ ...t, doc: pathOf(d) })))
      if (!blocking.length) lines.push('着手を止める未確定事項は 0 件である。', '')
      else {
        lines.push('| ID | 内容 | 所在 |', '|---|---|---|')
        for (const t of blocking) lines.push(`| ${cellOf(t.id)} | ${cellOf(t.text)} | \`${t.doc}\` |`)
        lines.push('')
      }
      const realized = new Set(links.map((l) => l.requirement_id))
      const orphan = specs.length ? `${target.flatMap((d) => d.ids).filter((id) => !realized.has(id)).length} 件` : '仕様書が無いので数えていない'
      lines.push('## 検査結果', '', `- ID の重複: ${dup} 件`, `- 実現する仕様項目が無い要求: ${orphan}`, '')
    } else {
      lines.push('## 検査結果', '', `- ID の重複: ${dup} 件`, '')
    }
    const rel = path.join('checks', `INDEX.${kind}.md`)
    fs.mkdirSync(path.join(ws, 'checks'), { recursive: true })
    fs.writeFileSync(path.join(ws, rel), lines.join('\n'))
    written[kind] = { path: rel, save_to: `${dirs[kind]}/INDEX.md`, digest: sha256(lines.join('\n')) }
  }
  return { indexes: written }
}

function parseWorkspaceArgs(argv) {
  const o = { doc: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const take = () => {
      const v = argv[++i]
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} に値がありません`)
      return v
    }
    if (a === '--workspace' || a === '-w') o.workspace = take()
    else if (a === '--save') o.save = take()
    else if (a === '--against') o.against = take()
    else if (a === '--expect') o.expect = take()
    else if (a === '--role') o.role = take()
    else if (a === '--part') o.part = take()
    else if (a === '--doc') o.doc.push(take())
    else if (a === '--req-dir') o.reqDir = take()
    else if (a === '--spec-dir') o.specDir = take()
    else if (a === '--open-tbd') o.openTbd = take().split(',').map((s) => s.trim()).filter(Boolean)
    else if (a === '--ledger') o.ledger = take()
    else if (a === '--fields') o.fields = take().split(',').map((s) => s.trim()).filter(Boolean)
    else if (a === '--ids') o.ids = take().split(',').map((s) => s.trim()).filter(Boolean)
    else if (a === '--collection') o.collection = take()
    else if (a === '--live') o.live = take().split(',').map((s) => s.trim()).filter(Boolean)
    else if (a === '--expect-resolutions') o.expectResolutions = take()
    else if (a === '--expect-decisions') o.expectDecisions = take()
    else if (a === '--drafts') o.drafts = take().split(',').map((s) => s.trim()).filter(Boolean)
    else if (a === '--check') o.check = true
    else if (a === '--rulings') o.rulings = true
    else if (a === '--lint') o.lint = true
    else if (a === '--token') o.token = take()
    else if (a === '--fixed') o.fixed = take().split(',').map((s) => s.trim()).filter(Boolean)
    else if (a === '--file') o.file = take()
    else if (a === '--input') o.input = take()
    else if (a === '--sweep') o.sweep = true
    else if (a === '--keep') o.keep = take().split(',').map((s) => s.trim()).filter(Boolean)
    else throw new Error(`不明な引数です: ${a}`)
  }
  return o
}

function runWorkspace(mode, argv) {
  const opts = parseWorkspaceArgs(argv)
  if (mode === 'describe') return describeLedgers()
  if (mode === 'contract') return wsContract(opts)
  if (!opts.workspace) throw new Error('--workspace <W> が要ります')
  const ws = path.resolve(opts.workspace)
  if (!fs.existsSync(ws) || !fs.statSync(ws).isDirectory()) throw new Error(`workspace がディレクトリではありません: ${opts.workspace}`)
  if (mode === 'plan') return wsPlan(ws)
  if (mode === 'flow') return wsFlow(ws, opts)
  if (mode === 'conflicts') return wsConflicts(ws)
  if (mode === 'doc') return wsDoc(ws, opts)
  if (mode === 'snapshot') return wsSnapshot(ws, opts)
  if (mode === 'diff') return wsDiff(ws, opts)
  if (mode === 'tree-digest') return wsTreeDigest(ws, opts)
  if (mode === 'index') return wsIndex(ws, opts)
  if (mode === 'put') return wsPut(ws, opts, () => fs.readFileSync(0, 'utf8'))
  if (mode === 'del') return wsDel(ws, opts)
  if (mode === 'backup') return wsBackup(ws, opts)
  if (mode === 'stash') return wsStash(ws, opts)
  if (mode === 'unstash') return wsUnstash(ws, opts)
  if (mode === 'restore') return wsRestore(ws, opts)
  if (mode === 'reset') return wsReset(ws, opts)
  if (mode === 'questions') return wsQuestions(ws, opts)
  if (mode === 'answers') return wsAnswers(ws, opts)
  if (mode === 'sha') return wsSha(ws, opts)
  if (mode === 'report') return wsReport(ws, opts)
  if (mode === 'get') return wsGet(ws, opts)
  if (mode === 'view') return wsView(ws, opts)
  throw new Error(`不明なモードです: ${mode}`)
}

// import したときは実行しない（tests が関数を直接呼ぶ）。main の判定は実パスで比べる —
// plugin のパスは symlink を含みうるので、文字列比較だと黙って何も出力しない CLI になる。
const invokedDirectly = (() => {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

if (invokedDirectly && WS_MODES.includes(process.argv[2])) {
  // 失敗は非ゼロで終える。--expect の不一致だけは 3 にして、壊れた入力（1）と区別できるようにする。
  const mode = process.argv[2]
  try {
    const out = runWorkspace(mode, process.argv.slice(3))
    process.stdout.write(typeof out === 'string' ? out : `${JSON.stringify(stampStdout(out))}\n`)
  } catch (e) {
    process.stderr.write(`doc_check ${mode}: ${e && e.message ? e.message : e}\n`)
    process.exit(e instanceof DigestMismatch ? 3 : 1)
  }
} else if (invokedDirectly) {
  const file = process.argv[2]
  if (!file) {
    process.stderr.write(`usage: node doc_check.mjs <input.json> | node doc_check.mjs <${WS_MODES.join('|')}> --workspace <W>\n`)
    process.exit(2)
  }
  try {
    const input = JSON.parse(fs.readFileSync(file, 'utf8'))
    process.stdout.write(`${JSON.stringify(runChecks(input))}\n`)
  } catch (e) {
    process.stderr.write(`doc_check: ${e && e.message ? e.message : e}\n`)
    process.exit(1)
  }
}

export {
  OBSOLETE_TERMS,
  UNVERIFIABLE_STANDARDS,
  CLAUSE_REF,
  TBD_ID_IN_TEXT,
  ID_IN_TEXT,
  newlineCount,
  lineTotal,
  changedLineRanges,
  structuralFindings,
  structuralCompact,
  expandStructural,
  flowGraphCompact,
  flowTableCompact,
  tableFindings,
  formalCompact,
  FINDING_TEXT,
  headingIndex,
  stableKey,
  canonicalJson,
  canonicalText,
  fnv,
  STDOUT_FNV,
  stampStdout,
  rulingsCompact,
  runChecks,
  WORKSPACE_TEXT,
  LINT_TEXT,
  itemSections,
  runWorkspace,
  LEDGERS,
  DOC_KEY,
  SIZE_BUDGET,
  STDOUT_BUDGET,
  WS_MODES,
  CONTRACT_SECTIONS,
  COMMON_SECTIONS,
  CONTRACT_BUDGET,
  CONTRACT_PARTS,
  contractText,
  contractParts,
  writeAtomic,
}
