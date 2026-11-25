// doc_check: 本文を読む決定的な検査の CLI。Workflow script はファイルを読めないので、agent にこの CLI を実行させて
// 件数と digest だけを受け取る（本文を返り値で運ぶと、改稿のたびに文書全体を Write と返り値で 2 度出力させる）。

import { spawnSync } from 'node:child_process'
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
    fix: 'TBD の番号にも文書種別（R/S）と領域のプレフィックスを付けて振り直す（例 TBD-RAUTH-001）。',
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
    fix: '根拠（input.md・answers・決定の台帳・固定前提・flow）を trace に申告する。要求文書の項目は、発生源（§11.1）に届く trace を申告する。引用できないなら、その項目は要求ではなく未確定事項として起票し直す。',
  }),
  REQ_NO_ORIGIN: (id, writesSpec) => ({
    id: `ST-REQ-NO-ORIGIN-${id}`,
    location: id,
    quote: id,
    issue: `${id} の trace を辿っても、要求の発生源に届かない。発生源の定義は references/prd-and-spec.md §11.1。`,
    fix: writesSpec
      ? `${id} を要求文書から外す。同じ単位に仕様書があればそこへ移し、無ければ残りとして報告する。発生源があるなら、それを trace に申告する。`
      : `${id} を削るか、依頼者に問う TBD にする。発生源があるなら、それを trace に申告する。`,
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
  // STATE_GUARD_TABLE: 図の矢印のガードで分けた組（同じ状態・同じイベントの矢印が全てガードを持つ）の行が表にもある。ID は表と図の食い違いと同じにする。
  STATE_GUARD_TABLE: (docKey, s, e, tableTo, diagramTo) => ({
    id: `ST-STATE-DIAGRAM-CONFLICT-${docKey}-${s}-${e}`,
    location: '状態とイベント',
    quote: `${s} × ${e}`,
    issue: `状態「${s}」×「${e}」は状態遷移図の矢印のガードで行き先を分けている（${diagramTo}）のに、表にも行がある（${tableTo}）。ガードで分けた組は表に書かない。表の 1 行は 1 つの行き先しか持てず、どちらが正か決まらない。`,
    fix: `「${s} × ${e}」の行を表から消し、行き先は図の矢印のガードで書く（document-structure.md §6）。`,
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
  STATE_TRAP: (docKey, s) => ({
    id: `ST-STATE-TRAP-${docKey}-${s}`,
    location: '状態とイベント',
    quote: s,
    issue: `状態「${s}」から終端状態（\`--> [*]\`）へ至る経路がありません。この状態に入ると完了へ到達できない閉塞ループまたはデッドロックになります。`,
    fix: `「${s}」から終端状態へ進む遷移経路を追加するか、脱出条件を定めてください。`,
  }),
  STATE_MULTIPLE_INITIAL: (docKey, initials) => ({
    id: `ST-STATE-MULTIPLE-INITIAL-${docKey}`,
    location: '状態とイベント',
    quote: initials,
    issue: `初期状態（\`[*] --> ...\`）が複数定義されています（${initials}）。系の起点が決定論的に定まりません。`,
    fix: '初期状態を 1 つに絞るか、分岐条件を定めてください。',
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
  NC_FLOW_UNATTACHED: (ids) => ({
    id: 'ST-NOTCHECKED-FLOW-UNATTACHED',
    issue: `仕様書を書くランで、流れの要素 ${ids.join('・')} に項目が当たっていないが、書く仕様書が検査した文書の中にまだ無いため指摘していない（要求文書には振らない）。「指摘 0 件」ではなく「未検査」である。`,
  }),
  NC_FLOW_NO_ORIGIN: (ids) => ({
    id: 'ST-NOTCHECKED-FLOW-NO-ORIGIN',
    issue: `要求文書だけのランで、流れの要素 ${ids.join('・')} に項目が当たっていないが、発生源が無く仕様書の範囲なので要求文書には振っていない（references/prd-and-spec.md §11.1）。「指摘 0 件」ではなく「未検査」である。`,
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
const AXIS_START = /^(対象[^:：]{0,6}(状態|イベント)|条件の値|渡すもの)\s*[:：]/
// outsideFence が真なら、コードフェンスの中の行を読まない（新しい宣言の書式（§2.9）だけがこれを使い、直書きの「> 条件の値:」の既存の挙動は変えない）。
function quoteParagraphs(sec, outsideFence = false) {
  const paras = []
  let cur = null
  let inFence = false
  for (const ln of sec.lines) {
    if (outsideFence && /^\s*(```|~~~)/.test(ln)) {
      if (cur !== null) paras.push(cur)
      cur = null
      inFence = !inFence
      continue
    }
    if (inFence) continue
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

// conditionDecls: 区間の「> 条件の値: 名前 = 右辺」。右辺が項目 ID 1 つだけなら参照（document-structure.md §2.9）で、
// values は空のまま ref に ID を入れる（解くのは resolveCondition）。直書きは ref: null。参照はコードフェンスの外のものだけを読む
// （直書きはフェンスの中も読む既存の挙動のまま）。outsideFence が真なら直書きもフェンスの外だけにする（参照の索引が使う）。
const CONDITION_REF = /^(PR|SP)-[A-Z][A-Z0-9]*-\d+$/
function conditionDecls(sec, outsideFence = false) {
  const decls = (paras) =>
    paras
      .map((p) => /^条件の値\s*[:：]\s*(.+?)\s*=\s*(.+)$/.exec(p))
      .filter(Boolean)
      .map((m) => ({ name: m[1].trim(), right: m[2].trim() }))
  const direct = decls(quoteParagraphs(sec, outsideFence)).filter((c) => !CONDITION_REF.test(c.right))
  const refs = decls(quoteParagraphs(sec, true)).filter((c) => CONDITION_REF.test(c.right))
  return [...direct.map((c) => ({ name: c.name, values: splitAxis(c.right), ref: null })), ...refs.map((c) => ({ name: c.name, values: [], ref: c.right }))]
}
// roleDecls: 区間の「> 渡すもの: 役 = a / b」（コードフェンスの外だけ）。
function roleDecls(sec) {
  return quoteParagraphs(sec, true)
    .map((p) => /^渡すもの\s*[:：]\s*(.+?)\s*=\s*(.+)$/.exec(p))
    .filter(Boolean)
    .map((m) => ({ role: m[1].trim(), inputs: splitAxis(m[2]) }))
}
// conditionIndex: 全ての文書（固定を含む）の、ID を持つ区間の直書きの宣言の索引。"<ID>\0<名前>" → 値の配列。
// 同じ ID・同じ名前に値の集合の違う宣言が 2 つ以上あれば null（1 つに決まらない）。参照の参照は辿らない。
function conditionIndex(docs) {
  const index = new Map()
  const same = (a, b) => a.length === b.length && [...a].sort().join('\u0000') === [...b].sort().join('\u0000')
  for (const d of docs) {
    if (!d || !d.markdown || !ID_IN_TEXT[d.kind]) continue
    for (const sec of itemSections(d.markdown, d.kind)) {
      if (!sec.id) continue
      for (const c of conditionDecls(sec, true)) {
        if (c.ref) continue
        const k = `${sec.id}\u0000${c.name}`
        if (!index.has(k)) index.set(k, c.values)
        else if (index.get(k) !== null && !same(index.get(k), c.values)) index.set(k, null)
      }
    }
  }
  return index
}
// resolveCondition: 参照なら参照先の値（無いか 1 つに決まらなければ []）を values にする。直書きはそのまま。
const resolveCondition = (c, index) => (c.ref ? { ...c, values: index.get(`${c.ref}\u0000${c.name}`) || [] } : c)
// usesOf: 区間の本文（コードフェンスの中と `>` の行を除く）を文に分け、`渡された「X」` の印ごとに、同じ文に現れる宣言済みの役の名前を返す。
// 役の名前は「」の中を除いた文から探す（入力の名前に役の名前が含まれていても役に数えない）。役の宣言が全文書に無ければ作らない。
// 「引き渡された「」」のように動詞の一部になった「渡された」は印にしない（USE_MARK の直前の字の規則）。
// USE_MARK: 直前が文の始め・空白・記号か、助詞の 1 字（に・は・が・も・へ・と・で・ら・を・の）のときだけ印にする。
// 漢字・カタカナ・英数字や他のかなが前にあれば、複合動詞（引き渡す・受け渡す・言い渡す・見渡す）の一部とみなす。
const USE_MARK = /(?<![\p{L}\p{N}](?<![にはがもへとでらをの]))渡された「([^」]+)」/gu
function usesOf(sec, roleNames) {
  if (!roleNames.length) return []
  const body = []
  let inFence = false
  for (const ln of sec.lines.slice(1)) {
    if (/^\s*(```|~~~)/.test(ln)) {
      inFence = !inFence
      continue
    }
    if (inFence || /^\s*>/.test(ln)) continue
    body.push(ln)
  }
  const uses = []
  for (const sentence of body.join('\n').split(/[。\n]/)) {
    const inputs = [...sentence.matchAll(USE_MARK)].map((m) => m[1].trim()).filter(Boolean)
    if (!inputs.length) continue
    const roles = namesIn(sentence.replace(/「[^」]*」/g, '\u0000'), roleNames).sort()
    for (const input of inputs) uses.push({ input, roles })
  }
  return uses
}

// stateDiagramOf: 節の中の mermaid stateDiagram の辺。`A --> B : ラベル` だけを読む
// （state 定義・note・複合状態は読まない。読めない行は辺として数えない）。ラベルの `[式]` は矢印のガード（document-structure.md §2.9）で、
// guard に持ち label からは除く（イベントの名前に入れない）。line は文書の行番号（sec.start は見出しの 0 始まりの添字）。
function stateDiagramOf(sec) {
  const edges = []
  let inFence = false
  let isState = false
  let found = false
  sec.lines.forEach((ln, i) => {
    if (/^\s*(```|~~~)/.test(ln)) {
      inFence = !inFence
      isState = false
      return
    }
    if (!inFence) return
    if (/^\s*stateDiagram/.test(ln)) {
      isState = true
      found = true
      return
    }
    if (!isState) return
    const m = /^\s*(.+?)\s*-->\s*(.+?)\s*$/.exec(ln)
    if (!m || /^\s*%%/.test(ln)) return
    const [to, ...rest] = m[2].split(/\s*:\s*/)
    const raw = rest.join(':').trim()
    const g = /\[([^\]]*)\]/.exec(raw)
    const label = g ? raw.replace(g[0], ' ').replace(/\s+/g, ' ').trim() : raw
    edges.push({ from: m[1].trim(), to: to.trim(), label, guard: g ? g[1].trim() : null, line: (sec.start || 0) + i + 1 })
  })
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
  const idRanges = ID_IN_TEXT[d.kind] && d.markdown ? itemSections(d.markdown, d.kind).filter((s) => s.id).map((s) => [s.start, s.start + s.lines.length - 1]) : []
  const unitLine = (n) => idRanges.some(([a, b]) => a <= n && n <= b)
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
    if (!diagramByCell.has(k)) diagramByCell.set(k, { s: e.from, e: ev.label, targets: new Set(), edges: 0, guarded: 0 })
    const g = diagramByCell.get(k)
    g.targets.add(e.to)
    g.edges += 1
    if (e.guard && unitLine(e.line)) g.guarded += 1
  }
  // split: 同じ状態・同じイベントの矢印が全てガードを持つ組（ガードで分けた組）。行き先の一意と網羅は図が持ち、ガードの重なりと覆いは
  // 形式検証が見る（document-structure.md §6）。ガードの無い矢印が混ざる組は、今までどおり非決定にする。ガードを数えるのは、形式検証の単位に
  // なる図（ID を持つ区間の図。formalUnits）の矢印だけで、ID の無い節の図のガードは形式検証に回らないので非決定を抑えない。
  const split = (g) => g.edges > 0 && g.guarded === g.edges
  for (const cell of cells.values()) {
    const g = diagramByCell.get(`${cell.s}\u0000${cell.e}`)
    if (cell.targets.size > 1) out.push({ c: 'STATE_NONDET', d: key, a: [key, cell.s, cell.e, [...cell.targets].join(' / ')] })
    const tableTo = cell.noop ? '発生しない' : cell.open ? '未定義' : [...cell.targets].join(' / ')
    if (g && split(g)) out.push({ c: 'STATE_GUARD_TABLE', d: key, a: [key, cell.s, cell.e, tableTo, [...g.targets].join(' / ')] })
    else if (g && (cell.noop || [...g.targets].some((t) => !cell.targets.has(t)) || (cell.targets.size && [...cell.targets].some((t) => !g.targets.has(t))))) {
      out.push({ c: 'STATE_DIAGRAM_CONFLICT', d: key, a: [key, cell.s, cell.e, tableTo, [...g.targets].join(' / ')] })
    }
  }
  for (const g of diagramByCell.values()) {
    if (cells.has(`${g.s}\u0000${g.e}`)) continue
    if (g.targets.size > 1 && !split(g)) out.push({ c: 'STATE_NONDET', d: key, a: [key, g.s, g.e, [...g.targets].join(' / ')] })
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
  const initial = [...new Set(diagramEdges.filter((e) => e.from === '[*]').map((e) => e.to))]
  if (initial.length > 1) {
    out.push({ c: 'STATE_MULTIPLE_INITIAL', d: key, a: [key, initial.join(' / ')] })
  }
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
    const coReachable = new Set(terminal)
    if (terminal.size > 0) {
      const prevs = new Map()
      for (const t of transitions) {
        if (!prevs.has(t.to)) prevs.set(t.to, new Set())
        prevs.get(t.to).add(t.from)
      }
      const rQueue = [...terminal]
      while (rQueue.length) {
        const curr = rQueue.shift()
        for (const p of (prevs.get(curr) || [])) {
          if (!coReachable.has(p)) {
            coReachable.add(p)
            rQueue.push(p)
          }
        }
      }
    }
    for (const s of allStates) {
      if (!seen.has(s)) out.push({ c: 'STATE_UNREACHABLE', d: key, a: [key, s] })
      const exits = [...(nexts.get(s) || [])].filter((to) => to !== s)
      if (!terminal.has(s) && !exits.length) {
        out.push({ c: 'STATE_DEADEND', d: key, a: [key, s] })
      } else if (!terminal.has(s) && seen.has(s) && exits.length > 0 && terminal.size > 0 && !coReachable.has(s)) {
        out.push({ c: 'STATE_TRAP', d: key, a: [key, s] })
      }
    }
  }
}

const DT_WILDCARD = /^(\*|—|-|–|任意)?$/
const DT_MAX_COMBOS = 4096
function decisionCheck(d, sec, out, notChecked, index = new Map()) {
  // 参照（「> 条件の値: 名前 = <ID>」）は参照先の値で検査する。解けない参照は宣言の無い条件と同じに扱う（指摘は ST-ENUM-SET-MISMATCH- が出す）。
  const domains = new Map()
  for (const c of conditionDecls(sec).map((x) => resolveCondition(x, index))) {
    if (c.ref && !c.values.length) continue
    domains.set(c.name, c.values)
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
function formalCompact(docs, flow, writesSpec = writesSpecOf(writtenKeys(docs)), origin = null) {
  const out = []
  const notChecked = []
  // 参照の索引は固定の文書も含む全ての文書から作る（参照先が固定の文書にあってよい）。
  const index = conditionIndex(docs)
  for (const d of docs) {
    if (d.fixed || !d.markdown) continue
    const secs = sectionsOf2(d.markdown)
    const diagrams = secs.map((sec) => stateDiagramOf(sec)).filter(Boolean)
    const fallback = diagrams.length === 1 ? diagrams[0] : null
    for (const sec of secs) {
      stateCheck(d, sec, out, fallback)
      decisionCheck(d, sec, out, notChecked, index)
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
    // 仕様書を書くランでは仕様書にだけ返す: 要求文書へ返すと内部の工程・異常系の分岐が要求になる（prd-and-spec.md §11）。
    const editable = docs.filter((d) => !d.fixed && (!writesSpec || d.kind === 'specifications'))
    const fallback = (editable.find((d) => d.kind === 'specifications') || editable[0] || {}).key
    const unowned = []
    const noOrigin = []
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
      // 要求文書だけのランで発生源の無い要素を振ると、REQ_NO_ORIGIN が削らせる要求を足させることになる。
      if (!writesSpec && origin && !origin.element(el.id)) {
        noOrigin.push(el.id)
        continue
      }
      const near = [...neighbours.get(el.id)].flatMap((n) => [...(attachedBy.get(n) || [])])
      const owner = editable.map((d) => d.key).find((k) => near.includes(k)) || fallback
      if (owner) out.push({ c: 'FLOW_UNATTACHED', d: owner, a: [el.id, String(el.label || '')] })
      else if (writesSpec) unowned.push(el.id)
    }
    if (unowned.length) notChecked.push({ c: 'NC_FLOW_UNATTACHED', a: [unowned] })
    if (noOrigin.length) notChecked.push({ c: 'NC_FLOW_NO_ORIGIN', a: [noOrigin] })
  }
  return { findings: out, not_checked: notChecked }
}

// writesSpecOf: 「仕様書を書くラン」の述語。run では plan.json の units（planUnitDocs）に当てる。prd-spec.js の writesSpec はこの写しで、
// 同じ units（doc_check plan の stdout から入る state.units）に当てるので、flow-framer への指示と振り先が同じ材料で決まる。
function writesSpecOf(keys) {
  return keys.some((k) => String(k).startsWith('specifications/'))
}
const writtenKeys = (docs) => docs.filter((d) => !d.fixed).map((d) => d.key)
// units の欠けや形の崩れを空の単位として読むと、仕様書を書くランが黙って要求文書だけのランになる。
function unitsFault(plan) {
  const units = plan && plan.units
  const strs = (v) => Array.isArray(v) && v.every((k) => typeof k === 'string')
  const ok = Array.isArray(units) && units.length > 0 && units.every((u) => u && typeof u === 'object' && typeof u.id === 'string' && strs(u.docs) && u.docs.length > 0 && strs(u.depends_on))
  return ok ? null : 'plan.json の units が無いか、形（id・空でない docs・depends_on）を満たしません'
}
function planUnitDocs(plan) {
  const fault = unitsFault(plan)
  if (fault) throw new Error(fault)
  return plan.units.flatMap((u) => u.docs)
}

// passedResolutions: 合格を検証した版のままの裁定だけ。検証の後に書き換えた裁定を根拠に数えない。
function passedResolutions(resolutions, verifications) {
  const verdicts = new Map(listOf(verifications, 'items').filter((it) => it && it.id && it.verdict).map((it) => [String(it.id), it]))
  return listOf(resolutions, 'resolutions').filter((r) => {
    const judged = r && r.id && verdicts.get(String(r.id))
    return Boolean(judged) && judged.verdict === 'pass' && carriesVerdict(judged, r)
  })
}

// originJudge: 要求の発生源（references/prd-and-spec.md §11.1）に届くかの判定の正本。終点と非終点の一覧は §11.1 だけが持つ。
// ドメイン分析から導いた決定・裁定（plan.json の domain / required_categories が指す決定、about.domain の裁定）は、source に関わらず終点にしない。
// 保持規則は、その項目の ID が hold.item_ids にあるときだけ終点にする。flow の要素は要素自身の source だけを見る。
function originJudge(ledgers, flow, plan) {
  const decisions = new Map(listOf(ledgers.decisions, 'decisions').filter((d) => d && d.id).map((d) => [String(d.id), d]))
  const domainDecisions = new Set(
    [...listOf(plan, 'domain'), ...listOf(plan, 'required_categories')].map((x) => x && x.decision).filter(Boolean).map(String),
  )
  const passed = passedResolutions(ledgers.resolutions, ledgers.verifications)
  const rulings = new Map(passed.map((r) => [String(r.id), r]))
  const elements = new Map(listOf(flow, 'elements').filter((el) => el && el.id).map((el) => [String(el.id), el]))
  const byId = (id, itemId) => {
    const d = decisions.get(id)
    if (d) return !domainDecisions.has(id) && ['input', 'precedent'].includes(d.source)
    const r = rulings.get(id)
    if (!r || (r.about && r.about.domain != null)) return false
    if (r.ruling === 'hold') return itemId != null && listOf(r.hold, 'item_ids').map(String).includes(String(itemId))
    return ['answered_by', 'precedent'].includes(r.ruling) || (r.ruling === 'question' && r.answer != null)
  }
  const closesOpen = (o, itemId) => passed.some((r) => r.about && String(r.about.open) === o && byId(String(r.id), itemId))
  const fromSource = (s, itemId) =>
    Boolean(s) &&
    typeof s === 'object' &&
    (s.input != null || (s.decision != null && byId(String(s.decision), itemId)) || (s.open != null && closesOpen(String(s.open), itemId)))
  const element = (id, itemId) => {
    const el = elements.get(String(id))
    return Boolean(el) && [].concat(el.source ?? []).some((s) => fromSource(s, itemId))
  }
  const trace = (t, itemId) =>
    Boolean(t) &&
    (['input', 'answers'].includes(t.kind) || (['decision', 'resolution'].includes(t.kind) && byId(String(t.ref), itemId)) || (t.kind === 'flow' && element(t.ref, itemId)))
  return { element: (id) => element(id), item: (itemId, traces) => traces.some((t) => trace(t, itemId)) }
}

// 構造検査の正本はこのファイルだけである。Workflow script は複製を持たず、agent にこの CLI を実行させる。
// not_checked は「材料が無くて実行できなかった検査」で、失格ではない。これを返さないと、片側の文書が対象外のランで
// 「検査して 0 件」と「そもそも検査していない」が区別できず、後者が合格として提示される。
// ledgers（decisions・resolutions・verifications）が undefined なら発生源の検査を行わない（flow の undefined と同じ扱い）。
function structuralCompact(docs, flow, writesSpec = writesSpecOf(writtenKeys(docs)), ledgers, plan) {
  const origin = ledgers === undefined ? null : originJudge(ledgers, flow, plan)
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
  //     ここを検査しないと、本文から根拠句を消した瞬間に根拠の観点の監査の入力が消え、
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
      // (7b) 要求の発生源。trace があっても、run の中で決めたことだけを根拠にした要求は依頼者の要求ではない（prd-and-spec.md §11.1）。
      //      trace の無い項目は (7) が持つ。
      if (origin && d.kind === 'requirements') {
        for (const id of d.ids) {
          const own = d.trace.filter((t) => t && t.item_id === id)
          if (own.length && !origin.item(id, own)) out.push({ c: 'REQ_NO_ORIGIN', d: d.key, a: [id, writesSpec] })
        }
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
  const formal = formalCompact(docs, flow, writesSpec, origin)
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
function structuralFindings(docs, flow, writesSpec, ledgers, plan) {
  return expandStructural(structuralCompact(docs, flow, writesSpec, ledgers, plan))
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
    issue: `判断 ${id} の ${no} 件目の case に、{ input } / { decision } / { open } の形の出典が無い。出典の無いマスは推測で埋めたものであり、writer reviewer は flow を根拠と認めるので、そのまま要求文になる。`,
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
    fix: `次のどちらか 1 つだけにする。(a) ${id} の next を 1 つの判断だけにし、その判断の inputs に from が ${id} で unknown を持つ入力を置く。(b) ${id} に on_fail: { as: 値が得られないときに下流へ渡す値, source: { input } か { decision } } を書く。要求文書だけのランで、その失敗の扱いに依頼者側の発生源が無いなら、両方を外す（agents/planner.md「#### 要求文書だけのラン」）。`,
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
  PLAN_UNITS: (fault) => ({
    id: 'ST-PLAN-UNITS',
    location: 'plan.json の units',
    quote: 'units',
    issue: fault,
    fix: 'units を、各要素が id・空でない docs・depends_on を持つ空でない配列に直す。',
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
  PLAN_UNASSESSED: (aspect, revisitWhen, decision, open) => ({
    id: `ST-PLAN-UNASSESSED-${aspect}`,
    location: 'plan.json の domain',
    quote: `${aspect}: 未評価`,
    issue: `観点 ${aspect} は未評価だが、再評価する具体的な条件が無いか、decision / open が付いている。再評価の契機が無い状態か、根拠の無い適用判断が作られている。`,
    fix: `decision と open を外し、${aspect} を再評価する具体的な信号を revisit_when に書く。例: 「${String(revisitWhen || '').trim() || '対象データや操作が具体化されたとき'}」。`,
  }),
  PLAN_REF: (aspect, need, ref) => ({
    id: `ST-PLAN-REF-${aspect}`,
    location: 'plan.json の domain',
    quote: `${aspect}: ${need} ${ref || '無し'}`,
    issue: `観点 ${aspect} の ${need} が ${need === 'open' ? ledgerOf('open').file() : `${ledgerOf('decisions').file()} にも ${ledgerOf('resolutions').file()}`} に無い。判定の根拠を辿れない。`,
    fix: `${Object.entries(PLAN_VERDICT_NEEDS).filter(([, k]) => k).map(([v, k]) => `${v} は ${k}`).join('、')} に、実在する ID を書く。`,
  }),
  PLAN_INVARIANT_MISSING: () => ({
    id: `ST-PLAN-INVARIANT-MISSING-${DOMAIN.irreversible}`,
    location: 'plan.json の domain',
    quote: `${DOMAIN.irreversible}: 該当`,
    issue: '不可逆な操作が該当なのに、kind が invariant の決定も未決も無い。破壊的な工程が縛りを挙げられず、flow の検査を通れない。',
    fix: `依頼文が失ってはならないものを述べていれば、その逐語を quote にした kind が invariant の決定にする。述べていなければ kind が invariant の O- を ${ledgerOf('open').file()} に足す。`,
  }),
  // prd-graph check（Rust）が返す静的な検査。引数の並びは crates/prd-graph/src/checks.rs の各検査が正本。
  DECISION_UNAPPLIED: (itemId, decisionId, items) => ({
    id: `ST-DECISION-UNAPPLIED-${decisionId}`,
    location: itemId,
    quote: decisionId,
    issue: `決定 ${decisionId} が名指す項目（${items.join('・')}）を持つ文書の、どの項目にも節にも、その決定の trace が無い。決定が本文に入っていないか、入れたのに根拠を申告していない。`,
    fix: `${decisionId} の値を名指す項目の本文に当て、当てた項目か節の trace に { kind: "decision", ref: "${decisionId}" } を申告する。`,
  }),
  ABBREV_ID: (where, token, id) => ({
    id: `ST-ABBREV-ID-${where}-${token}`,
    location: where,
    quote: token,
    issue: `「${token}」は ${id} の略記に見える。略記は参照先の実在の検査を素通りするので、読み手も機械もどの項目を指すかを確かめられない。`,
    fix: `「${token}」を「${id}」に書き換える。別の項目を指すなら、その項目 ID を正しい形で書く。`,
  }),
  // ref: 項目の条件が参照（「> 条件の値: 名前 = <ID>」）なら、その参照先（graphCheck が足す）。
  DOC_FLOW_TABLE: (itemId, flowId, name, docValues, flowValues, ref) => ({
    id: `ST-DOC-FLOW-TABLE-${itemId}-${flowId}-${name}-${docValues}`,
    location: itemId,
    quote: `${name} = ${ref || docValues}`,
    issue: `項目 ${itemId} の条件「${name}」の値（${docValues}${ref ? `。参照先 ${ref} から解いた値` : ''}）が、trace が指す流れの判断 ${flowId} の入力の値（${flowValues}）と違う。同じ判断に流れと本文が別の値を定めている。`,
    fix: ref
      ? `参照先 ${ref} の「> 条件の値: ${name} = …」の宣言と、${itemId} の表を ${flowId} の値の集合に揃える。流れの側が誤っているなら、その要素を直す役（flow-framer）へ戻す。`
      : `本文の「> 条件の値:」と表を ${flowId} の値の集合に揃える。流れの側が誤っているなら、その要素を直す役（flow-framer）へ戻す。`,
  }),
  GLOSSARY_BACKREF: (where, term, specId) => ({
    id: `ST-GLOSSARY-BACKREF-${where}-${term}-${specId}`,
    location: where,
    quote: term,
    issue: `用語表の「${term}」は定義を ${specId} に置くと示すが、${specId} の本文にその語が無い。読み手が定義を辿れない。`,
    fix: `${specId} の本文に「${term}」の定義を書くか、用語表の行の参照先を定義のある項目に直す。`,
  }),
  HOLD_PROPAGATION: (itemId, heldId, rs) => ({
    id: `ST-HOLD-PROPAGATION-${itemId}-${rs}`,
    location: itemId,
    quote: heldId,
    severity: 'degraded',
    issue: `この run で変えた項目 ${itemId} が、保持規則 ${rs} の触れる項目 ${heldId} を参照するが、${rs} も「裁定が下るまで」の文も持たない。保持中の論点を断定していないかを確かめる。`,
    fix: `${itemId} が ${heldId} の保持中の論点に触れるなら、${rs} の保持規則に従う文にする。触れないなら直さない。`,
  }),
  FIELD_SPELLING: (itemId, field, n) => ({
    id: `ST-FIELD-SPELLING-${itemId}-${field}-${n}`,
    location: itemId,
    quote: field,
    severity: 'degraded',
    issue: `項目 ${itemId} は \`${field}\` の要素を日本語の名前で ${n} 項目と述べるが、同じ文にキーの綴りが無い。実装者がキーの名前を決められない。`,
    fix: `要素のキーをコードスパンで並べる（例: \`{a, b}\`）。`,
  }),
  ROLE_INPUT_COVERAGE: (where, role, input, related) => ({
    id: `ST-ROLE-INPUT-COVERAGE-${where}-${role}-${input}`,
    location: where,
    quote: `渡された「${input}」`,
    related,
    issue: `${where} の規則は ${role} に渡された「${input}」を使うが、${role} の「> 渡すもの:」の宣言（${related.join('・')}）に「${input}」が無い。役が受け取らないものを規則が使っている。`,
    fix: `宣言 ${related.join('・')} に「${input}」を足すか、規則が使うものを宣言の中の名前に直す（document-structure.md §2.9）。`,
  }),
  // ref: split のときの自分の参照先（graphCheck が足す）。quote は本文の宣言の行（参照なら `名前 = <ID>`）にする。
  ENUM_SET_MISMATCH: (kind, where, name, mine, other, related, ref) => ({
    id: `ST-ENUM-SET-MISMATCH-${where}-${name}`,
    location: where,
    quote: `${name} = ${kind === 'unresolved' ? related[0] : kind === 'split' && ref ? ref : mine}`,
    related,
    issue:
      kind === 'unresolved'
        ? `${where} の条件「${name}」の参照先 ${related[0]} に同じ名前の宣言が無いか、1 つに決まらない。値の集合を解けないので、判定表を検査できない。`
        : kind === 'redeclared'
          ? `${where} は、参照される条件「${name}」を別の値の集合（${mine}）で書き直している。参照先の集合（${other}）と食い違う。`
          : `${where} の条件「${name}」が参照する${ref ? ` ${ref} の` : ''}値の集合（${mine}）が、同じ名前の別の参照先の集合（${other}）と違う。参照された名前は 1 つの集合を指す。`,
    fix:
      kind === 'unresolved'
        ? `参照先 ${related[0]} に「> 条件の値: ${name} = …」を 1 つだけ置くか、参照を宣言のある項目に直す（document-structure.md §2.9）。`
        : kind === 'redeclared'
          ? `値を写さず「> 条件の値: ${name} = <参照先の ID>」の参照に置き換える。別の集合なら別の名前にする（document-structure.md §2.9）。`
          : `参照先（${related.filter((k) => k !== where).join('・')}）の宣言を 1 つの集合に揃えるか、別の集合の側の名前を変える（document-structure.md §2.9）。`,
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
  // FORMAL_CEX: formal-method が目標に反例を見つけた（fm/facts.json の verdict 反例）。単位の digest が今の版と同じときだけ出す（formalFindings）。
  FORMAL_CEX: (goalId, itemId, quote, goal, witness, related) => ({
    id: `ST-FORMAL-CEX-${goalId}`,
    location: itemId,
    quote,
    ...(related && related.length ? { related } : {}),
    issue: `形式検証の目標 ${goalId}「${goal}」に反例がある（${witness}）。この値の組では、書いた式どうしが目標を満たさない。`,
    fix: '値の式・制約・条件・ガードを直す（document-structure.md §2.9）。反例の値の組で、どの式が目標に反するかを確かめてから直す。',
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
    fix: `失敗しないと述べる依頼文の逐語（{ input }）か決定の ID（{ decision }）を ${id} の obtain_source に付ける。付けられないなら obtain を may_fail にして同じ put で obtain_source に null を送り、直後の成否の判断か on_fail で失敗を扱う（schemas/agent-contracts.md の「${ledgerOf('flow').file()} の形」の obtain）。要求文書だけのランで、その失敗の扱いに依頼者側の発生源が無いなら、may_fail にして扱い（判断・on_fail）は付けない（agents/planner.md「#### 要求文書だけのラン」）。失敗したときの行き先が決まらないなら、その判断の case の出典を open に起票する。`,
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

const WS_MODES = ['plan', 'flow', 'conflicts', 'doc', 'snapshot', 'diff', 'tree-digest', 'index', 'put', 'del', 'backup', 'restore', 'stash', 'unstash', 'reset', 'place', 'questions', 'answers', 'sha', 'report', 'quotes', 'get', 'view', 'describe', 'contract', 'formal-model', 'formal-request', 'formal-import', 'formal-status', 'formal-off']
const DOC_FILE = /^(requirements|specifications)-(.+)\.md$/
const DOC_PREFIX = /^(requirements|specifications)-/
// CARRY_FILE: 保存した文書の開いている TBD の正本（保存先では文書の .md を .tbd.json に替えたファイル）を place が W に置いた写し。
// 正本を置く理由は references/traceability.md §4。
const CARRY_SUFFIX = '.tbd.json'
const carryPathOf = (docPath) => docPath.replace(/\.md$/, CARRY_SUFFIX)
const CARRY_FILE = new RegExp(`^(requirements|specifications)-(.+)${CARRY_SUFFIX.replace(/\./g, '\\.')}$`)
const docFileOf = (key) => ledgerOf('meta').file(key).replace(/\.meta\.json$/, '.md')
const carryFileOf = (key) => carryPathOf(docFileOf(key))
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
      resolutions: ['id', 'about', 'ruling', 'value', 'why', 'evidence', 'domain_assessment', 'supersedes', 'layer', 'targets', 'question', 'options', 'answer', 'hold', 'upstream_revision', 'kind'],
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
const HISTORY_MARKS = [/段 ?\d/, /(?<![A-Za-z0-9])r\d+-(wr|wh)-/, /回答の反映/]

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
function readLedger(ws, name, doc, stored = true, text = undefined) {
  const file = ledgerOf(name).file(doc)
  // text: 読んだ中身（workspaceDocs が控えの版の meta を渡す）。無ければ W のファイルを読む。どちらも同じ正規形と形の検査を通す。
  const raw = text !== undefined ? text : fs.existsSync(path.join(ws, file)) ? fs.readFileSync(path.join(ws, file), 'utf8') : null
  if (raw === null) return null
  let value
  try {
    value = JSON.parse(raw)
  } catch (e) {
    throw new Error(`${path.basename(file)} を JSON として読めません: ${e.message}`)
  }
  checkShape(name, value, file)
  if (raw !== ledgerText(value)) {
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
  if (name === 'resolutions') bad.push(...domainAssessmentRejects(ws, value.resolutions || []))
  if (name === 'meta') for (const t of value.tbd || []) if (!tbdItemOk(t)) bad.push(`tbd ${t && t.id}: ${TBD_ITEM_SHAPE} ではありません`)
  return bad
}

function domainAssessmentRejects(ws, resolutions) {
  const axes = new Set(domainAspects())
  const plan = readJsonFile(path.join(ws, 'plan.json'))
  const baseline = new Map(listOf(plan, 'domain').filter((x) => x && typeof x.aspect === 'string').map((x) => [x.aspect, x]))
  const seen = new Map()
  const bad = []
  for (const r of resolutions) {
    if (!r) continue
    if (r.domain_assessment == null) {
      if (r.about && r.about.domain !== undefined) bad.push(`resolutions ${r.id}: about.domain には domain_assessment が必要です`)
      continue
    }
    const where = `resolutions ${r.id} domain_assessment`
    const d = r.domain_assessment
    if (!d || typeof d !== 'object' || Array.isArray(d)) {
      bad.push(`${where}: オブジェクトが必要です`)
      continue
    }
    const allowed = ['aspect', 'initial_verdict', 'superseded_categories', 'verdict', 'required_categories']
    const extra = Object.keys(d).filter((k) => !allowed.includes(k))
    if (extra.length) bad.push(`${where}: 未知の欄 ${extra.join(' / ')} があります（欄は ${allowed.join(' / ')}）`)
    const aspect = typeof d.aspect === 'string' ? d.aspect : ''
    if (!axes.has(aspect)) bad.push(`${where}: aspect ${JSON.stringify(d.aspect)} は ${DOMAIN.file} §2 のキーではありません`)
    if (!r.about || Object.keys(r.about).length !== 1 || r.about.domain !== aspect) bad.push(`${where}: about は { domain: aspect } で対象軸を指定してください`)
    if (r.ruling !== 'answered_by' || r.value !== d.verdict) bad.push(`${where}: ruling は answered_by、value は verdict と同じ値にしてください`)
    if (typeof r.why !== 'string' || !r.why.trim()) bad.push(`${where}: 具体的な信号から verdict と required_categories を導いた why が必要です`)
    const prior = seen.get(aspect)
    if (prior && prior !== r.id) bad.push(`${where}: 観点 ${aspect} は ${prior} でも評価されています（観点ごとに 1 件を更新してください）`)
    seen.set(aspect, r.id)
    if (!['該当', '非該当'].includes(d.verdict)) bad.push(`${where}: verdict は 該当 / 非該当 のどちらかにしてください`)
    if (!Array.isArray(d.required_categories)) bad.push(`${where}: required_categories は配列が必要です`)
    else {
      const names = d.required_categories
      if (names.some((x) => typeof x !== 'string' || !x.trim())) bad.push(`${where}: required_categories には空でない文字列だけを入れてください`)
      if (new Set(names.map((x) => typeof x === 'string' ? x.trim() : '')).size !== names.length) bad.push(`${where}: required_categories に重複があります`)
      if (d.verdict === '非該当' && names.length) bad.push(`${where}: 非該当の観点に required_categories は設定できません`)
    }
    if (!Array.isArray(r.evidence) || !r.evidence.length) {
      bad.push(`${where}: 具体的な信号を示す resolutions.evidence が 1 件以上必要です`)
      continue
    }
    for (const [i, e] of r.evidence.entries()) {
      const ew = `${where} evidence[${i}]`
      const { file, line, end, quote } = e || {}
      const last = end === undefined ? line : end
      if (typeof file !== 'string' || !path.isAbsolute(file) || !Number.isInteger(line) || line < 1 || !Number.isInteger(last) || last < line) {
        bad.push(`${ew}: { file（絶対パス）, line, end?（line 以上）, quote } の形ではありません`)
        continue
      }
      let realFile
      try {
        realFile = fs.realpathSync(file)
        if (fs.lstatSync(path.resolve(file)).isSymbolicLink()) {
          bad.push(`${ew}: domain の根拠ファイルは symlink にできません`)
          continue
        }
      } catch {
        bad.push(`${ew}: ${file} を読めません`)
        continue
      }
      const rel = path.relative(fs.realpathSync(ws), realFile).split(path.sep).join('/')
      if (!answersFile(rel)) {
        bad.push(`${ew}: 後段で新たに現れた domain の信号は所有表にある回答ファイルを直接引用してください`)
        continue
      }
      let lines
      try { lines = fs.readFileSync(file, 'utf8').split('\n') } catch {
        bad.push(`${ew}: ${file} を読めません`)
        continue
      }
      const span = lines.slice(line - 1, last).join('\n')
      if (last > lines.length || typeof quote !== 'string' || !quote || !span.includes(quote)) bad.push(`${ew}: ${file} の ${line}${last === line ? '' : `〜${last}`} 行目に逐語で無い ${JSON.stringify(quote)}`)
    }
    const initial = baseline.get(aspect)
    if (!initial || !['該当', '非該当', '未評価'].includes(initial.verdict)) {
      bad.push(`${where}: plan.domain の ${aspect} に有効な初期判定がありません`)
      continue
    }
    if (initial.verdict === '未評価' && (initial.decision !== undefined || initial.open !== undefined || !(typeof initial.revisit_when === 'string' && initial.revisit_when.trim()))) {
      bad.push(`${where}: 初期 未評価 の plan.domain は decision / open を持たず、revisit_when が必要です`)
    }
    if (initial.verdict !== '未評価' && !(typeof initial.decision === 'string' && initial.decision.trim())) {
      bad.push(`${where}: 初期 ${initial.verdict} の plan.domain には decision が必要です`)
    }
    const initialCategories = initial.decision
      ? listOf(plan, 'required_categories').filter((c) => c && String(c.decision ?? '') === String(initial.decision)).map((c) => String(c.name ?? ''))
      : []
    if (d.initial_verdict !== initial.verdict) bad.push(`${where}: initial_verdict は plan.domain の ${initial.verdict} と一致する必要があります`)
    if (!Array.isArray(d.superseded_categories) || d.superseded_categories.some((x) => typeof x !== 'string') || canonicalJson(d.superseded_categories) !== canonicalJson(initialCategories)) {
      bad.push(`${where}: superseded_categories は初期 decision ${initial.decision ?? 'なし'} に結び付いた plan.required_categories と一致する必要があります`)
    }
    const expectedSupersedes = typeof initial.decision === 'string' ? initial.decision : null
    if ((r.supersedes ?? null) !== expectedSupersedes) {
      bad.push(`${where}: supersedes は初期 domain decision ${expectedSupersedes ?? 'なし'} と一致する必要があります`)
    }
  }
  return bad
}

function domainAssessmentMutationRejects(cur, next) {
  const before = new Map((cur.resolutions || []).filter((r) => r && r.domain_assessment).map((r) => [r.id, r]))
  const after = new Map((next.resolutions || []).filter((r) => r && r.domain_assessment).map((r) => [r.id, r]))
  const bad = []
  for (const [id, prior] of before) {
    const current = after.get(id)
    if (!current || !prior.about || !current.about || prior.about.domain !== current.about.domain || prior.domain_assessment.aspect !== current.domain_assessment.aspect) {
      bad.push(`resolutions ${id}: 保存済み domain assessment の about.domain と assessment は削除・変更できません。verdict と categories は同じ ID で更新してください`)
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

// backup: writer は文書の本文を Edit で書き、doc_check を通らないので、put のように書き込みの前に控えを取れない。段 4・7 の writer が
// 最初のコマンドで、段の token で本文の控えを取る（無い文書は無い印）。blocked の後の同じ段の再実行の入口の restore が、台帳と一緒に本文を段に入った時点へ戻す。
// 戻さないと、止まった run が途中まで書いた本文が再実行の入力になる（expand の既存文書は S0 の原文が W から失われる）。
function wsBackup(ws, opts) {
  const token = txToken(opts, 'backup')
  const keys = [...new Set(opts.doc)].sort()
  if (!keys.length) throw new LedgerRejected('backup には --doc <キー> が 1 つ以上要ります')
  const files = keys.map((key) => {
    const m = DOC_KEY.exec(key)
    if (!m) throw new LedgerRejected(`文書のキー（<requirements|specifications>/<topic>）ではありません（控えを取っていません）: ${key}`)
    return docFileOf(key)
  })
  for (const file of files) txBegin(ws, token, file)
  return { backup: true, token, docs: keys, ...docDigests(ws, workspaceDocs(ws, token), keys) }
}

// docDigests: backup・restore の stdout の、文書の digest（tree-digest と同じ値）。digests は keys の文書ごと（本文が無ければ null）、
// entry_digest は checks/entry.json のキーの文書から writeEntry と同じ形で作った digest（entry.json が無いかキーが 0 なら null）、
// tree_digest は全文書の木の digest。script は段 4・7 の控えと再実行の入口の本文をこれで段の入口の本文と照らす。
function docDigests(ws, docs, keys) {
  const items = snapshotOf(docs)
  const entryKeys = Object.keys(entryDocsOf(readJsonFile(path.join(ws, ENTRY_FILE))))
  return {
    digests: Object.fromEntries(keys.map((k) => [k, items[k] ? digestOf({ [k]: items[k] }) : null])),
    entry_digest: entryKeys.length ? digestOf(entryOf(docs, entryKeys)) : null,
    tree_digest: digestOf(items),
  }
}

const fileSha = (p) => (fs.existsSync(p) ? sha256Bytes(fs.readFileSync(p)) : null)

// restore: token の控えを台帳と文書に戻し、token の下で作られた台帳と文書を消す。控えの無い台帳・文書・answers・plan.json・checks は触らない。
// 全部戻してから控えを消すので、途中で落ちても流し直せば同じ結果になる。控えを書く途中で落ちた一時名（writeAtomic）は控えではないので数えない。
// 控えが無いのは、止まった run が書かなかったか、戻し終えたか、後の token の最初の書き込みが消したときである。後の段の token（通し番号が
// 大きい）があれば最後のときで、戻す控えが失われているので何も変えずに pruned_by に挙げる（黙って 0 件を戻すと、再実行が止まった run の
// 書き込みの上から始まる）。同じ段の後の token は再実行自身の書き込みなので数えない。
// stash・unstash: flow と open を控え、控えのとおりに戻す（以前は flow-framer の lint の差し戻しの前後に使った。prd-spec.js は今は起動しない）。
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
  // digests・entry_digest・tree_digest: 戻した後（pruned_by のときは今）の W の文書。digests は W にある文書だけを載せる。
  const present = () => {
    const docs = workspaceDocs(ws)
    return docDigests(ws, docs, docs.map((d) => d.key))
  }
  if (prunedBy.length) return { token, restored: 0, files: [], pruned_by: prunedBy, flow_before: flowBefore, flow_after: flowBefore, ...present() }
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
  return { token, restored: files.length, files, pruned_by: [], flow_before: flowBefore, flow_after: ledgerSha(ws, 'flow'), ...present() }
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
      return [key, sha256(JSON.stringify([fileSha(path.join(ws, docFileOf(key))), fileSha(path.join(ws, meta))]))]
    })
  )
}

const RESET_REMOVES = ['plan.json', 'questions.md', 'questions.json', 'report.md', 'answers', 'findings', 'checks', TX_DIR]
function wsReset(ws, opts) {
  const keep = [...new Set(opts.keep || [])].sort()
  const fixed = [...new Set(opts.fixed || [])].sort()
  const docOf = (key) => {
    try {
      return docFileOf(key)
    } catch {
      throw new LedgerRejected(`文書のキー（<requirements|specifications>/<topic>）ではありません（何も消していません）: ${key}`)
    }
  }
  const docs = keep.map(docOf)
  fixed.forEach(docOf)
  const unkept = fixed.filter((key) => !keep.includes(key))
  if (unkept.length) throw new LedgerRejected(`--fixed の文書が --keep にありません（何も消していません）: ${unkept.join(', ')}`)
  const missing = keep.filter((_, i) => !fs.existsSync(path.join(ws, docs[i])))
  if (missing.length) throw new LedgerRejected(`existing_docs の文書が W にありません（S0 で doc_check place で置く。何も消していません）: ${missing.join(', ')}`)
  const carried = Object.fromEntries(keep.map((key) => [key, carriedTbd(ws, key)]).filter(([, tbd]) => tbd))
  const metas = keep.filter((key) => fixed.includes(key) || carried[key]).map((key) => ledgerOf('meta').file(key))
  const carries = keep.map(carryFileOf)
  const removes = RESET_REMOVES
  // checks/ の中の入口（reset 自身の出力）は消したものに数えない。数えると、流し直した reset が同じ W に戻らない。
  const ownEntry = (n) => n === 'checks' && fs.existsSync(path.join(ws, n)) && fs.readdirSync(path.join(ws, n)).every((f) => `checks/${f}` === ENTRY_FILE)
  const removed = fs
    .readdirSync(ws)
    .filter((n) => (txLedgerFile(n) && !metas.includes(n)) || (removes.includes(n) && !ownEntry(n)) || (DOC_FILE.test(n) && !docs.includes(n)) || (CARRY_FILE.test(n) && !carries.includes(n)))
    .sort()
  for (const n of removed) fs.rmSync(path.join(ws, n), { recursive: true, force: true })
  // fm/: 形式検証の依頼と事実（formal-*）は消す。fm/off.json は S0 の印（formal-off）なので残す。
  const fmDir = path.join(ws, FORMAL_DIR)
  const fmGone = fs.existsSync(fmDir) ? fs.readdirSync(fmDir).filter((n) => n !== FORMAL_OFF_FILE) : []
  for (const n of fmGone) fs.rmSync(path.join(fmDir, n), { recursive: true, force: true })
  if (fmGone.length) {
    removed.push(FORMAL_DIR)
    removed.sort()
  }
  fs.rmSync(path.join(ws, ENTRY_FILE), { force: true })
  for (const key of keep.filter((k) => fixed.includes(k) || carried[k])) {
    const meta = { ...emptyLedger(ledgerOf('meta')), ...(fixed.includes(key) ? { fixed: true } : {}), ...(carried[key] ? { tbd: carried[key] } : {}) }
    writeAtomic([path.join(ws, ledgerOf('meta').file(key)), ledgerText(meta)])
  }
  const carriedIds = Object.fromEntries(Object.entries(carried).map(([key, tbd]) => [key, tbd.map((t) => t.id).sort()]))
  const entry = writeEntry(ws, keep.filter((k) => !fixed.includes(k)))
  const keys = Object.keys(entryDocsOf(entry)).sort()
  return { reset: true, removed, kept: keep, fixed, carried_tbd: carriedIds, fixed_sha256: fixedShas(ws, fixed), entry: keys, entry_digest: keys.length ? digestOf(entry) : null }
}

// ENTRY_FILE・writeEntry: 段 1 の入口（reset の直後）の、既存の文書の項目ごとの本文の digest。doc は、ここから変わらず影響の範囲
// （prd-graph impact）にも入らない項目の指摘を既存の指摘（preexisting）として blocking に数えない。改訂していない項目には
// trace が無く（agent-contracts.md の「entry が existing のとき」）、直すには根拠を捏造するしかないため。固定の文書は書き換えないので
// 入れない。新しく書く文書は入口を持たず、全ての項目が変わった項目に数える。
const ENTRY_FILE = 'checks/entry.json'
// itemDigests: 項目 ID ごとの、本文の区間と項目自身の trace を合わせた digest。trace を含めるのは、この run で付けた trace が原因の指摘
// （発生源・flow の参照）を既存の指摘にしないため（入口の reset の直後は trace が空なので、trace を付けた項目は変わった項目になる）。
// 同じ ID の見出しが 2 つ以上あれば、その全ての区間をまとめて 1 つの digest にする（2 つ目以降の区間の改訂を取りこぼさない）。
// ID を持たない節（検証方法・用語定義など）も `<文書キー>§<見出し>` の key で入れる。表だけの改訂や、表にある既存の略記を分けるため。
function itemDigests(d) {
  const trace = d.meta && Array.isArray(d.meta.trace) ? d.meta.trace : []
  const byId = new Map()
  for (const s of itemSections(d.markdown, d.kind)) {
    const key = s.id || `${d.key}${s.key}`
    byId.set(key, [...(byId.get(key) || []), s])
  }
  return new Map([...byId].map(([id, secs]) => [id, { secs, digest: digestOf({ text: secs.map((s) => s.text), trace: trace.filter((t) => t && t.item_id === id) }) }]))
}
// ENTRY_ROLES: entry.json の予約のキー。入口の「> 渡すもの:」の宣言のある区間の key を役ごとに残す（宣言の無い W では書かない。
// 書かなければ entry.json と entry_digest は今までと同じ）。宣言を消した改訂で生じた ST-ROLE-INPUT-COVERAGE- を既存の指摘にしないため。
// 文書のキーは `<種別>/<トピック>` なので衝突しない。prd-graph impact には渡さない（entryDocsOf）。
const ENTRY_ROLES = '§roles'
const entryDocsOf = (entry) => Object.fromEntries(Object.entries(entry || {}).filter(([k]) => k !== ENTRY_ROLES))
const entryOf = (docs, keys) => {
  const picked = docs.filter((x) => keys.includes(x.key))
  const roles = {}
  for (const d of picked) {
    for (const sec of itemSections(d.markdown, d.kind)) {
      for (const r of roleDecls(sec)) roles[r.role] = [...new Set([...(roles[r.role] || []), sec.id || `${d.key}${sec.key}`])].sort()
    }
  }
  const docsPart = Object.fromEntries(picked.map((d) => [d.key, Object.fromEntries([...itemDigests(d)].map(([id, v]) => [id, v.digest]))]))
  return Object.keys(roles).length ? { ...docsPart, [ENTRY_ROLES]: Object.fromEntries(Object.entries(roles).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) } : docsPart
}
function writeEntry(ws, keys) {
  const entry = entryOf(workspaceDocs(ws), keys)
  if (keys.length) writeCheck(ws, 'entry.json', entry)
  return entry
}

// ITEM_LOCAL: 指摘の帰属先の項目の本文か trace だけで決まる検査の ID の接頭辞。ST-ABBREV-ID- は、区間の本文と全ての文書の ID の集合
// （当たる ID が 1 つか）で決まる。区間が変わらなければ改訂の誤りではないので、ここに入れる。
const ITEM_LOCAL = ['ST-NO-EVIDENCE-', 'ST-REQ-NO-ORIGIN-', 'ST-MODAL-', 'ST-AMBIGUOUS-', 'ST-ABBREV-ID-']
// NEVER_PREEXISTING: 項目に帰属するが、prd-graph の事実に無いもの（開いている TBD の集合・flow の要素）に依存する検査。影響の範囲で
// この run が原因でないと言えないので、既存の指摘にしない。
// ST-FORMAL-CEX- は、送る単位を自分か依存が入口から変わったものに限るので既存の指摘にならない（formal-request の規則 2）。それをここで固定する。
const NEVER_PREEXISTING = ['ST-TBD-ASSERT-', 'ST-FLOW-UNKNOWN-REF-', 'ST-DECISION-UNAPPLIED-', 'ST-DOC-FLOW-TABLE-', 'ST-FORMAL-CEX-']
// 宣言とつながる指摘（ST-ROLE-INPUT-COVERAGE-・ST-ENUM-SET-MISMATCH-）はどちらにも入れず、related に宣言の区間の key を持たせ、使う区間と related の
// どれも変わっておらず消えてもいないときだけ既存の指摘にする（宣言と使う区間は ID でつながるとは限らず、影響の範囲では分けられない）。

// GRAPH_BIN: 影響の範囲を決める Rust の CLI の wrapper（plugins/workflow/crates/prd-graph が正本）。本文の解析は doc_check に 1 つだけ置き、
// prd-graph には解析済みの事実だけを渡す。
const GRAPH_BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'prd-graph')
function impactOf(ws, docs, entry, name) {
  const ids = new RegExp(`${ID_IN_TEXT.requirements.source}|${ID_IN_TEXT.specifications.source}`, 'g')
  const facts = {
    entry: entryDocsOf(entry),
    docs: docs.map((d) => ({
      key: d.key,
      fixed: Boolean(d.fixed),
      // ID を持たない節（表など）は変わったかだけを見て、辺を持たせない。表は多くの ID を並べるので、辺にすると 1 行の改訂が全ての項目に波及する。
      items: [...itemDigests(d)].map(([id, v]) => ({ id, digest: v.digest, refs: v.secs[0].id ? [...new Set(v.secs.flatMap((s) => s.text.match(ids) || []))].filter((x) => x !== id).sort() : [] })),
      links: d.traceability || [],
    })),
  }
  const r = spawnSync(GRAPH_BIN, ['impact'], { input: JSON.stringify(facts), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.error || r.status !== 0) throw new Error(`prd-graph impact が失敗しました（exit ${r.status}）: ${(r.error && r.error.message) || String(r.stderr || '').trim()}`)
  const out = JSON.parse(r.stdout)
  return { ...out, path: writeCheck(ws, name, out) }
}

// graphCheck: 優先度 1 と 2 の静的な検査（prd-graph check）に事実を渡し、指摘を doc_check の compact の形で返す。文書の構造の解析
// （区間・表・「> 条件の値:」・本文中の ID・用語表の行）はここで doc_check の解析を使って済ませ、Rust には解析済みの値を渡す。
// Rust の側が文字を読むのは、略記の ID と欄の数の検査だけ。
function graphCheck(docs, ledgers, flow, impact) {
  const ids = new RegExp(`${ID_IN_TEXT.requirements.source}|${ID_IN_TEXT.specifications.source}`, 'g')
  const idsOf = (text, self) => [...new Set(String(text).match(ids) || [])].filter((x) => x !== self).sort()
  const trace = (d) => (d.meta && Array.isArray(d.meta.trace) ? d.meta.trace : []).filter((t) => t && t.item_id).map((t) => ({ item_id: t.item_id, kind: String(t.kind || ''), ref: t.ref == null ? null : String(t.ref) }))
  const changed = impact ? impact.changed : docs.filter((d) => !d.fixed).flatMap((d) => d.ids)
  const index = conditionIndex(docs)
  const conditionsOf = (sec) => conditionDecls(sec).map((c) => resolveCondition(c, index))
  // 役の名前は全文書（固定を含む）の「> 渡すもの:」の宣言から集める。
  const roleNames = [...new Set(docs.flatMap((d) => itemSections(d.markdown, d.kind).flatMap((sec) => roleDecls(sec).map((r) => r.role))))]
  // 用語表: 見出しに「用語」を含む節の表の行のうち、定義の所在を「定義は <ID>」と示すもの。
  const glossaryOf = (d, secs) =>
    secs
      .filter((sec) => !sec.id && /用語/.test(String(sec.lines[0] || '')))
      .flatMap((sec) =>
        tablesOf(sec).flatMap((t) =>
          t.rows.flatMap((r) => {
            const term = String(r.cells[0] || '').replace(/^`|`$/g, '').trim()
            const def = r.cells.slice(1).find((c) => String(c).includes('定義は'))
            const target = def ? (String(def).slice(String(def).indexOf('定義は')).match(ids) || [])[0] : null
            return term && target ? [{ section: `${d.key}${sec.key}`, term, target }] : []
          })
        )
      )
  // 覆された決定は無効（契約の「決定の台帳」）。手段の層の決定は要求文書に書かないので、名指す要求 ID を外す。
  const superseded = supersededIds(ledgers.resolutions)
  const facts = {
    docs: docs.map((d) => {
      const secs = itemSections(d.markdown, d.kind)
      return {
        key: d.key,
        fixed: Boolean(d.fixed),
        sections: secs.map((sec) => ({ key: sec.id ? sec.key : `${d.key}${sec.key}`, id: sec.id, body: sec.lines.slice(1).join('\n'), ids: idsOf(sec.lines.slice(1).join('\n'), sec.id), conditions: conditionsOf(sec), roles: roleDecls(sec), uses: usesOf(sec, roleNames) })),
        trace: trace(d),
        glossary: glossaryOf(d, secs),
      }
    }),
    decisions: listOf(ledgers.decisions, 'decisions')
      .filter((x) => x && x.id && !superseded.has(String(x.id)))
      .map((x) => ({ id: String(x.id), named: idsOf(`${x.value || ''} ${x.quote || ''}`).filter((id) => !(x.layer === '手段' && id.startsWith('PR-'))) })),
    flow: listOf(flow, 'elements').filter((e) => e && e.type === 'decision' && Array.isArray(e.inputs)).map((e) => ({ id: String(e.id), inputs: e.inputs.filter((i) => i && i.name && Array.isArray(i.values)).map((i) => ({ name: String(i.name), values: i.values.map(String) })) })),
    holds: listOf(ledgers.resolutions, 'resolutions').filter((r) => r && r.ruling === 'hold' && r.hold && Array.isArray(r.hold.item_ids)).map((r) => ({ id: String(r.id), item_ids: r.hold.item_ids.map(String) })),
    changed,
  }
  const r = spawnSync(GRAPH_BIN, ['check'], { input: JSON.stringify(facts), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.error || r.status !== 0) throw new Error(`prd-graph check が失敗しました（exit ${r.status}）: ${(r.error && r.error.message) || String(r.stderr || '').trim()}`)
  const found = JSON.parse(r.stdout).findings
  const unknown = found.filter((f) => !GRAPH_CODES.includes(f.code))
  if (unknown.length) throw new Error(`prd-graph check が知らない種別を返しました: ${[...new Set(unknown.map((f) => f.code))].join(', ')}`)
  // 参照（「> 条件の値: 名前 = <ID>」）を持つ区間の DOC_FLOW_TABLE と split は、本文の行を quote にし参照先を直させるため、参照先の ID を
  // 引数の末尾に足す（Rust の引数は変えない）。
  const refOf = new Map(facts.docs.flatMap((d) => d.sections.flatMap((sec) => sec.conditions.filter((c) => c.ref).map((c) => [`${sec.key}\u0000${c.name}`, c.ref]))))
  const withRef = (f) => {
    const at = f.code === 'DOC_FLOW_TABLE' ? [f.args[0], f.args[2]] : f.code === 'ENUM_SET_MISMATCH' && f.args[0] === 'split' ? [f.args[1], f.args[2]] : null
    const ref = at && refOf.get(`${at[0]}\u0000${at[1]}`)
    return ref ? [...f.args, ref] : f.args
  }
  return found.map((f) => ({ c: f.code, d: f.doc, a: withRef(f) }))
}
// GRAPH_CODES: prd-graph check が返す種別（文面は WORKSPACE_TEXT）。crates/prd-graph/src/checks.rs の Finding.code と一致させる。
const GRAPH_CODES = ['DECISION_UNAPPLIED', 'ABBREV_ID', 'DOC_FLOW_TABLE', 'GLOSSARY_BACKREF', 'HOLD_PROPAGATION', 'FIELD_SPELLING', 'ROLE_INPUT_COVERAGE', 'ENUM_SET_MISMATCH']

// place: S0 が既存文書を W に置く。文書と、その隣の開いている TBD の写しを 1 回でまとめて逐語で写す（写しを別の手順にすると置き忘れが起き、
// 次の保存で写しの無い文書として正本を上書きするか消す）。隣に写しが無ければ、前に置いた W の写しを消す。
function wsPlace(ws, opts) {
  if (opts.doc.length !== 1 || !opts.source) throw new Error('place には --doc <requirements|specifications>/<topic> と --source <元の文書のパス> が要ります')
  const key = opts.doc[0]
  const doc = docFileOf(key)
  const carry = carryFileOf(key)
  if (!/\.md$/.test(opts.source)) throw new Error(`--source は .md の文書のパスです: ${opts.source}`)
  const source = path.resolve(opts.source)
  if (!fs.existsSync(source)) throw new Error(`--source の文書がありません: ${opts.source}`)
  const carrySource = carryPathOf(source)
  const hasCarry = fs.existsSync(carrySource)
  if (hasCarry && !carryShapeOk(readJsonFile(carrySource))) throw new Error(`${carrySource} の形が ${CARRY_SHAPE} ではありません（何も置いていません）`)
  fs.copyFileSync(source, path.join(ws, doc))
  if (hasCarry) fs.copyFileSync(carrySource, path.join(ws, carry))
  else fs.rmSync(path.join(ws, carry), { force: true })
  return { placed: key, doc, carry: hasCarry ? carry : null }
}

// tbdItemOk: meta の tbd の要素の形。put（storedRejects）と写しの読み手（reset・place）が同じ判定を使う。put が緩いと、監査を通った meta から
// 保存した写しを次の run の reset が拒み、直す経路が手書きしか無い。
const TBD_ITEM_SHAPE = `{ id: ${TBD_ID_IN_TEXT.source} に合う文字列, text: 空でない文字列, blocking: 真偽値, candidates?: 文字列の配列 }（欄はこの 4 つだけ）`
function tbdItemOk(t) {
  return Boolean(
    t && typeof t === 'object' && !Array.isArray(t) && Object.keys(t).every((k) => ledgerOf('meta').fields.tbd.includes(k)) &&
      typeof t.id === 'string' && new RegExp(`^${TBD_ID_IN_TEXT.source}$`).test(t.id) && typeof t.text === 'string' && t.text.trim() && typeof t.blocking === 'boolean' &&
      (t.candidates === undefined || (Array.isArray(t.candidates) && t.candidates.every((c) => typeof c === 'string')))
  )
}

const CARRY_SHAPE = `{ "tbd": [${TBD_ITEM_SHAPE}]（1 件以上、ID は重複なし）}`
function carryShapeOk(data) {
  const tbd = data && typeof data === 'object' && !Array.isArray(data) && Object.keys(data).join() === 'tbd' ? data.tbd : null
  return Array.isArray(tbd) && tbd.length > 0 && tbd.every(tbdItemOk) && new Set(tbd.map((t) => t.id)).size === tbd.length
}

// carriedTbd: S0 が置いた写しの tbd。形が違えば何も消さずに止める（reset が黙って捨てると、開いている TBD が消える）。
function carriedTbd(ws, key) {
  const file = carryFileOf(key)
  const data = readJsonFile(path.join(ws, file))
  if (data === null) return null
  if (!carryShapeOk(data)) throw new LedgerRejected(`${file} の形が ${CARRY_SHAPE} ではありません（何も消していません）`)
  return data.tbd
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
// その問いに既にある回答を当てるなら、問いのまま answer と value を put する（planner.md の「回答の反映」）。
function answeredByRejects(ws, cur, next, body) {
  const touched = new Set((body.resolutions || []).map((r) => r && r.id))
  const cites = (r) => answerCites(ws, r).length > 0
  const waiting = new Set((cur.resolutions || []).filter((r) => r && r.ruling === 'question' && r.answer == null).map((r) => r.id))
  const mine = (next.resolutions || []).filter((r) => r && touched.has(r.id) && r.ruling === 'answered_by')
  return [
    ...mine.filter((r) => !(r.about && r.about.domain !== undefined) && !cites(r)).map((r) => `resolutions ${r.id}: answered_by の evidence に回答のファイル（所有表の answers/ の下）の行がありません`),
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
  const domainMutationBad = name === 'resolutions' ? domainAssessmentMutationRejects(cur, next) : []
  if (domainMutationBad.length) throw new LedgerRejected(`domain assessment の保存先を維持してください（何も書いていません）:\n${domainMutationBad.join('\n')}`)
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
  if (name === 'resolutions') {
    const protectedIds = new Set((cur && cur.resolutions || []).filter((r) => r && r.domain_assessment).map((r) => r.id))
    const removing = ids.filter((id) => protectedIds.has(id))
    if (removing.length) throw new LedgerRejected(`domain assessment ${removing.join(', ')} は削除できません。verdict と categories を同じ ID で更新してください`)
  }
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
    else if (!q || typeof q.header !== 'string' || typeof q.text !== 'string' || typeof q.searched !== 'string' || !q.searched.trim()) bad.push(`${id}: question { header, text, searched } がありません`)
    else if (typeof r.why !== 'string' || !r.why.trim() || !Array.isArray(r.evidence) || !r.evidence.length) bad.push(`${id}: 質問には簡潔な why と、具体的な信号を示す出典根拠が 1 件以上必要です`)
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

// FINDING_ID: 監査役の指摘の ID（契約「### 指摘の形」）。末尾の -<連番> を除いた名前が W/findings/<名前>.json になる。
const FINDING_ID = /^(r[1-9]\d*-(?:wr|wh)-(?:all|p[1-9]\d*))-\d{3,}$/

// findingsByIds: --findings の ID を W/findings から引く。ファイルか要素の無い ID があれば例外にする（何も書かない）。
function findingsByIds(ws, ids) {
  const files = new Map()
  const missing = []
  const out = []
  for (const id of ids) {
    const m = FINDING_ID.exec(id)
    if (!m) {
      missing.push(id)
      continue
    }
    if (!files.has(m[1])) {
      const data = readJsonFile(path.join(ws, 'findings', `${m[1]}.json`))
      files.set(m[1], data && Array.isArray(data.findings) ? data.findings : null)
    }
    const f = (files.get(m[1]) || []).find((x) => x && x.id === id)
    if (f) out.push(f)
    else missing.push(id)
  }
  if (missing.length) throw new Error(`--findings に W/findings のファイルか要素の無い ID があります: ${missing.join(', ')}`)
  return out
}

// unreflectedLines: 本文に反映していない指摘の節。LLM の指摘は blocking の真を先に、doc_check の指摘は checks/doc.json のうち blocking に
// 数えるもの（countsAsBlocking。degraded も数えない）だけを並べ、既存の指摘（preexisting）は件数の 1 行にする。checks/doc.json が無い W は 0 件。
function unreflectedLines(ws, ids) {
  const found = findingsByIds(ws, ids)
  const llm = [...found.filter((f) => f.blocking === true), ...found.filter((f) => f.blocking !== true)].map(
    (f) => `- ${f.id}（${f.doc ?? ''} ${f.item_id ?? ''}。blocking: ${f.blocking === true}）: ${f.issue ?? ''}`
  )
  const doc = readJsonFile(path.join(ws, 'checks', 'doc.json'))
  const docFindings = doc && Array.isArray(doc.findings) ? doc.findings.filter((f) => f && f.id) : []
  const fixedKeys = new Set((doc && Array.isArray(doc.documents) ? doc.documents : []).filter((d) => d && d.fixed).map((d) => d.key))
  const counted = docFindings.filter((f) => countsAsBlocking(f, fixedKeys) && f.severity !== 'degraded').map((f) => `- ${f.id}（${f.document} ${f.location}）`)
  const preexisting = docFindings.filter((f) => f.preexisting).length
  const lines = [...llm, ...counted]
  return {
    count: lines.length,
    md: [
      ...(lines.length ? lines : ['0 件。']),
      ...(preexisting ? ['', `既存の指摘（blocking に数えない）: ${preexisting} 件。checks/doc.json の preexisting`] : []),
      '',
    ],
  }
}

// report: 事後報告は resolutions.json の method・answered_by・measured・hold・upstream_revision から導出する。answered_by は依頼者の回答を
// 別の論点に当てた裁定、measured は聞かずに現物で決めた裁定（仕様書の実現の手段を含む）で、依頼者はここで初めて見て覆せる。手で書くと、同じ事実を
// resolutions と 2 か所に持ち、型も決まらない。本文に反映していない指摘の節は、--findings の ID（script の返り値の unreflected）を
// W/findings から、doc_check の指摘を checks/doc.json（最後の監査で指名された whole reviewer が書いたもの）から引く。
function wsReport(ws, opts) {
  if (opts.formalOff !== undefined && !FORMAL_OFF_REASONS.includes(opts.formalOff)) throw new UsageError(`--formal-off は ${FORMAL_OFF_REASONS.join(' / ')} です: ${opts.formalOff}`)
  const [listName] = Object.keys(ledgerOf('resolutions').lists)
  const rs = listOf(readLedger(ws, 'resolutions'), listName)
  const method = rs.filter((r) => r.ruling === 'method')
  const answeredBy = rs.filter((r) => r.ruling === 'answered_by')
  const measured = rs.filter((r) => r.ruling === 'measured')
  const shownPath = (file) => {
    const rel = path.relative(ws, file)
    return rel.startsWith('..') || path.isAbsolute(rel) ? file : rel
  }
  const cited = (r) => (Array.isArray(r.evidence) ? r.evidence : []).map((e) => `${shownPath(String((e && e.file) || ''))}#L${e && e.line}「${(e && e.quote) ?? ''}」`).join('、')
  const draftIds = new Set(opts.drafts || [])
  const unknown = [...draftIds].filter((id) => !rs.some((r) => r.id === id && r.ruling === 'hold'))
  if (unknown.length) throw new Error(`--drafts に hold でない ID があります: ${unknown.join(', ')}`)
  const holds = rs.filter((r) => r.ruling === 'hold' && !draftIds.has(r.id))
  const drafts = rs.filter((r) => draftIds.has(r.id))
  const upstream = rs.filter((r) => r.upstream_revision != null)
  const unreflected = unreflectedLines(ws, opts.findings || [])
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
    '## 現物で決めたこと',
    '',
    ...(measured.length ? measured.map((r) => `- ${r.id}: ${r.value ?? ''}（出典: ${cited(r)}）`) : ['0 件。']),
    '',
    '## 保持規則と Issue の文案',
    '',
    ...(holds.length ? [] : ['0 件。', '']),
    ...holds.flatMap(holdBlock),
    '## 保持規則の文案（本文に未反映）',
    '',
    ...(drafts.length ? [] : ['0 件。', '']),
    ...drafts.flatMap(holdBlock),
    '## 本文に反映していない指摘',
    '',
    ...unreflected.md,
    '## 上位文書の改訂の文案',
    '',
    ...(upstream.length ? [] : ['0 件。', '']),
    ...upstream.flatMap((r) => [`### ${r.id}`, '', ...block('改訂の文案', r.upstream_revision)]),
    ...formalReportLines(ws, opts.formalOff),
  ].join('\n')
  writeAtomic([path.join(ws, 'report.md'), md])
  // report は司令塔が run の返った後に実行するので、動いている label は無い。
  const swept = sweepWorkDirs(ws, [], 'report')
  return { path: 'report.md', method: method.length, answered_by: answeredBy.length, measured: measured.length, holds: holds.length, drafts: drafts.length, upstream_revisions: upstream.length, unreflected: unreflected.count, sha256: sha256Bytes(Buffer.from(md)), ...swept }
}

// isResetMeta: meta が、段 1 の入口の reset が写しから書いたもの（固定でない文書）のままか。
function isResetMeta(ws, key, meta) {
  if (!meta || meta.fixed) return false
  const carry = readJsonFile(path.join(ws, carryFileOf(key)))
  return carry !== null && ledgerText(meta) === ledgerText({ ...emptyLedger(ledgerOf('meta')), tbd: carry.tbd })
}

// workspaceDocs: W の文書（本文と meta）。token を渡すと控えの版（ファイルごとに tx/<token>/ の .pre があればその中身、.absent があれば
// 無い、どちらも無ければ今の W）を読む。backup・restore の digest も tree-digest・snapshot もここを通るので、meta の検査と digest は同じになる。
// 控えの印はファイルを読むたびに確かめる（本文と meta の読みの間に並列の writer の put が meta を書けば、書いた後の meta を読む窓は残る。
// その put は meta の控えを先に取るので、同じ token の次の backup は控えの版を読む）。
function workspaceDocs(ws, token = null) {
  const dir = token ? path.join(ws, TX_DIR, token) : null
  const read = (file) => {
    if (dir && fs.existsSync(path.join(dir, `${file}${TX_PRE}`))) return fs.readFileSync(path.join(dir, `${file}${TX_PRE}`), 'utf8')
    if (dir && fs.existsSync(path.join(dir, `${file}${TX_ABSENT}`))) return null
    const p = path.join(ws, file)
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null
  }
  const marked = dir && fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith(TX_PRE)).map((n) => n.slice(0, -TX_PRE.length)) : []
  return [...new Set([...fs.readdirSync(ws), ...marked].filter((n) => DOC_FILE.test(n)))]
    .sort()
    .flatMap((name) => {
      const markdown = read(name)
      if (markdown === null) return []
      const [, kind, topic] = DOC_FILE.exec(name)
      const key = `${kind}/${topic}`
      const meta = readLedger(ws, 'meta', key, true, token ? read(ledgerOf('meta').file(key)) : undefined)
      return [{ key, kind, topic, path: name, markdown, meta, resetMeta: isResetMeta(ws, key, meta) }]
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
    // reset が写しから書いたままの meta は、meta の無い既存文書と同じく trace を未検査にする（根拠は前のランの W にしか無い。根拠なしとして数えると、
    // 写しを持つだけで全項目が blocking の指摘になる）。writer が一度でも meta を書き換えれば、写しの無い文書と同じく検査する。
    const trace = !d.meta || d.resetMeta ? undefined : Array.isArray(d.meta.trace) ? d.meta.trace : []
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

// 曖昧語。偽陽性は writer の内部ループを空回りさせるので、複合語の
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
// writesSpec が偽（要求文書だけのラン）では、may_fail の失敗の扱いが無いことを指摘しない。失敗の扱いは仕様書の範囲で、求めると
// 発生源の無い失敗が要素として描かれ、要求文書の要求になる（発生源の扱いは references/prd-and-spec.md §11.1）。
function flowTableCompact(flow, writesSpec = true) {
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
    if (a === b) {
      if (a || writesSpec) out.push({ c: 'FLOW_FAIL_UNHANDLED', d: 'flow', a: [el.id, a] })
    } else if (b) {
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
      findings.push({ id: t.id, document: g.d, location: t.location, quote: t.quote, ...(t.severity ? { severity: t.severity } : {}), ...(t.related ? { related: t.related } : {}), issue: t.issue, fix: t.fix })
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

// carriesVerdict: 合否を持ち越す書き換えの正本。持ち越すのは根拠を増やさない書き換えだけ: 問いと保持規則への書き換えの不合格（問いは独立 verifier が
// 関連性と根拠を再検証するまで保持）と、検証した候補の decision_text を value に写しただけの候補の選択。合格は、保持規則の文（hold）・問いの形の修正で変えた候補の文・
// 自由記述の value を検証していないので持ち越さない（持ち越すと、検証していない文が保持規則や根拠として writer に届く）。
function carriesVerdict(judged, r) {
  if (judged.digest === digestOf(r)) return true
  if (['hold', 'question'].includes(r.ruling) && judged.verdict === 'fail') return true
  if (r.ruling !== 'question' || judged.verdict !== 'pass') return false
  const { answer, value, ...asked } = r
  const chosen = value === undefined || (Array.isArray(r.options) && r.options.some((o) => o && o.decision_text === value))
  return chosen && judged.digest === digestOf(asked)
}

// rulingsCompact: resolution の行を ruling・has_answer・verdict・fail_kind（と、あれば spec_layer）の組ごとに束ね、組の中は ID から about への表にする。verifier と
// flow-check はこの stdout を逐語で写すので、行ごとに欄名と同じ値を繰り返すと写す字数が台帳の件数に比例して膨らむ。
// 行への戻し方の正本は prd-spec.js の rulingRows。
function rulingsCompact(rows) {
  const groups = new Map()
  for (const r of rows) {
    const head = { ruling: r.ruling, has_answer: r.has_answer, verdict: r.verdict, ...(Object.hasOwn(r, 'fail_kind') ? { fail_kind: r.fail_kind } : {}), ...(r.spec_layer ? { spec_layer: true } : {}) }
    const key = canonicalJson(head)
    if (!groups.has(key)) groups.set(key, { ...head, about: {} })
    groups.get(key).about[r.id] = r.about
  }
  return [...groups.values()]
}

// specLayer: 仕様の論点の問い（答えが仕様書だけに入る。prd-and-spec.md §11.6 の手段の変更）。仕様書だけを書く run の prd-spec.js は、この行の問いだけを
// 依頼者に聞き、ほかの問いは要求文書の抜け（upstream_gap）にする。当たらない行には欄を付けない。
const specLayer = (r) => r.ruling === 'question' && r.layer === '手段' && r.upstream_revision == null

function wsFlow(ws, opts) {
  requireInput(ws)
  const flow = readLedger(ws, 'flow')
  if (flow === null) throw new Error(`${ledgerOf('flow').file()} がありません`)
  const openIds = new Set(listOf(readLedger(ws, 'open'), 'open').filter((x) => x && x.id).map((x) => String(x.id)))
  const inv = invariantsOf(ws)
  const plan = readJsonFile(path.join(ws, 'plan.json'))
  if (plan === null) throw new Error('plan.json がありません')
  const list = [...flowGraphCompact(flow), ...flowSourceCompact(flow, decisionIdsOf(ws), openIds, inv), ...flowTableCompact(flow, writesSpecOf(planUnitDocs(plan))), ...flowHistoryCompact(flow)]
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
      return { id: String(r.id), about: r.about ?? null, ruling: r.ruling ?? null, has_answer: r.answer != null, verdict: v ? v.verdict : null, ...(v && v.verdict === 'fail' ? { fail_kind: v.fail_kind ?? null } : {}), ...(specLayer(r) ? { spec_layer: true } : {}) }
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
  // unsettled_refs: 決まっていない裁定（今の版が合格していない・hold・answer の無い question）を出典か constrained_by に引く要素。裁定を flow に写すのは
  // 検証に合格した後の別の起動なので、planner の自己申告に頼らずにここで拾う（prd-spec.js が verifier の stdout で照らす）。台帳に無い RS- は実在の検査
  // （FLOW_SOURCE_UNKNOWN・FLOW_CONSTRAINT_UNKNOWN）に任せ、D- は見ない（stale_refs が見る）。findings・codes・digest・lint には入れない。
  const rulingOf = new Map(resolutions.map((r) => [r.id, r]))
  const unsettled = (ref) => {
    const r = rulingOf.get(ref)
    return Boolean(r) && (r.verdict !== 'pass' || r.ruling === 'hold' || (r.ruling === 'question' && !r.has_answer))
  }
  const unsettledRefs = els
    .flatMap((el) => {
      const cases = el.type === 'decision' && Array.isArray(el.cases) ? el.cases : []
      const refs = new Set([...decisionRefs(el.source), ...decisionRefs(el.on_fail && el.on_fail.source), ...cases.flatMap((c) => decisionRefs(c && c.source)), ...constraintsOf(el)])
      return [...refs].filter(unsettled).map((ref) => ({ el: String(el.id), ref }))
    })
    .sort((a, b) => (a.el === b.el ? (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0) : a.el < b.el ? -1 : 1))
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
    unsettled_refs: unsettledRefs,
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
const PLAN_VERDICT_NEEDS = { 該当: 'decision', 非該当: 'decision', 未評価: null }

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
  const unitsProblem = unitsFault(plan)
  if (unitsProblem) out.push({ c: 'PLAN_UNITS', d: 'plan', a: [unitsProblem] })
  const seen = new Map()
  for (const d of domain) {
    const aspect = String((d && d.aspect) ?? '')
    if (!keys.includes(aspect)) {
      out.push({ c: 'PLAN_ASPECT_UNKNOWN', d: 'plan', a: [aspect] })
      continue
    }
    seen.set(aspect, (seen.get(aspect) || 0) + 1)
    if (!Object.hasOwn(PLAN_VERDICT_NEEDS, d.verdict)) {
      out.push({ c: 'PLAN_VERDICT', d: 'plan', a: [aspect, String(d.verdict ?? '')] })
    } else if (d.verdict === '未評価') {
      const revisitWhen = typeof d.revisit_when === 'string' ? d.revisit_when.trim() : ''
      if (!revisitWhen || d.decision !== undefined || d.open !== undefined) {
        out.push({ c: 'PLAN_UNASSESSED', d: 'plan', a: [aspect, revisitWhen, d.decision, d.open] })
      }
    } else {
      const need = PLAN_VERDICT_NEEDS[d.verdict]
      if (!refs[need].has(String(d[need] ?? '').trim())) out.push({ c: 'PLAN_REF', d: 'plan', a: [aspect, need, String(d[need] ?? '')] })
    }
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
  // covers・units: script は plan.json を読めないので、ここから渡す。covers は仕様書だけを書く run の判定（prd-spec.js の specOnly）に、
  // units は書く文書の正本として state.units に入る（intake の申告で別に受けると、wsDoc の writesSpecOf と材料が分かれる）。
  const covers = Object.fromEntries(listOf(plan, 'docs').filter((d) => d && String(d.key).startsWith('specifications/')).map((d) => [String(d.key), Array.isArray(d.covers) ? d.covers.map(String) : []]))
  return { findings: body.findings.length, path: writeCheck(ws, 'plan.json', { ...body, digest }), digest, content_sha256: sha256Bytes(fs.readFileSync(path.join(ws, 'plan.json'))), covers, units: listOf(plan, 'units') }
}

// doc: 開いている TBD は --open-tbd
// （script が解消済みを除いて算出したもの）を正とし、無ければ meta の TBD の候補の和を使う（どちらを
// 使ったかを結果に書く）。--doc を付けると、その文書の指摘だけを別のファイルに書く（並列の writer が
// 同じ結果ファイルを奪い合わないため。検査そのものは文書を跨いで全体に当てる）。
// countsAsBlocking: doc の指摘のうち blocking に数えるもの（degraded は別に引く）。既存の指摘と固定の文書の指摘は数えない。
// report の本文に反映していない指摘の節も同じ式で選ぶ。
const countsAsBlocking = (f, fixedKeys) => !f.preexisting && (!fixedKeys.has(f.document) || String(f.id).startsWith('ST-ORPHAN-REQ-'))

// roleEntryKeys: ST-ROLE-INPUT-COVERAGE- の指摘 ID → 入口で、その役と、その印の文に現れる役（入口の役の名前で探す）を宣言していた区間の key。
// 今の宣言だけ（related）では、宣言の片方を消した改訂や、文の 2 つの役の片方の宣言を消して役が 1 つに決まった改訂を見分けられない。
function roleEntryKeys(docs, graph, entryRoles) {
  const out = new Map()
  const names = Object.keys(entryRoles)
  if (!names.length) return out
  const secOf = new Map(docs.flatMap((d) => itemSections(d.markdown, d.kind).map((sec) => [`${d.key}\u0000${sec.id ? sec.key : `${d.key}${sec.key}`}`, sec])))
  for (const g of graph.filter((x) => x.c === 'ROLE_INPUT_COVERAGE')) {
    const [where, role, input] = g.a
    const sec = secOf.get(`${g.d}\u0000${where}`)
    const roles = new Set([role, ...(sec ? usesOf(sec, names).filter((u) => u.input === input).flatMap((u) => u.roles) : [])])
    out.set(WORKSPACE_TEXT.ROLE_INPUT_COVERAGE(...g.a).id, [...roles].flatMap((r) => entryRoles[r] || []))
  }
  return out
}

function wsDoc(ws, opts) {
  const wsDocs = workspaceDocs(ws)
  if (!wsDocs.length) throw new Error('workspace に文書（requirements-*.md / specifications-*.md）がありません')
  const selected = selectDocs(wsDocs.map((d) => d.key), opts.doc)
  const plan = readJsonFile(path.join(ws, 'plan.json'))
  if (plan === null) throw new Error('plan.json がありません')
  const coversOf = new Map(listOf(plan, 'docs').filter((p) => p && p.key).map((p) => [p.key, Array.isArray(p.covers) ? p.covers : []]))
  const docs = deriveDocs(wsDocs).map((d) => ({ ...d, covers: coversOf.get(d.key) || [] }))
  const openTbd = opts.openTbd
    ? { source: 'args', ids: [...new Set(opts.openTbd)].sort() }
    : { source: 'meta', ids: [...new Set(docs.flatMap((d) => d.tbd_items.map((t) => t && t.id).filter(Boolean)))].sort() }
  const flow = readLedger(ws, 'flow')
  // disk の文書では決めない: 要求文書の writer の lint は仕様書のファイルがまだ無い時点でも走る。
  const ledgers = { decisions: readLedger(ws, 'decisions'), resolutions: readLedger(ws, 'resolutions'), verifications: readLedger(ws, 'verifications') }
  const structural = structuralCompact(docs, flow, writesSpecOf(planUnitDocs(plan)), ledgers, plan)
  const open = new Set(openTbd.ids)
  const kept = structural.findings
    .map((g) => (g.c === 'UNDECLARED_TBD' ? { ...g, a: g.a.filter((a) => !open.has(a[0])) } : g))
    .filter((g) => g.a.length)
  const entry = readJsonFile(path.join(ws, ENTRY_FILE))
  const metaOf = new Map(wsDocs.map((d) => [d.key, d.meta]))
  const withMeta = docs.map((d) => ({ ...d, meta: metaOf.get(d.key) }))
  const impactName = opts.doc.length ? `impact.${selected.map(indexName).join('+')}.json` : 'impact.json'
  const impact = entry ? impactOf(ws, withMeta, entry, impactName) : null
  const graph = graphCheck(withMeta, ledgers, flow, impact)
  const formal = formalFindings(ws, wsDocs)
  const all = [...kept, ...groupCompact([...workspaceExtraCompact(docs, openTbd.ids), ...graph, ...formal])]
  const expanded = expandWorkspace({ findings: opts.doc.length ? all.filter((g) => selected.includes(g.d)) : all, not_checked: structural.not_checked })
  // 既存の指摘: 入口から本文が変わっていない項目に帰属する指摘のうち、改訂が原因になりえないもの。報告には残すが blocking に数えない。
  // 項目の本文と trace だけで決まる検査（ITEM_LOCAL）は、本文が変わらなければ改訂で生じないので、影響の範囲の中でも既存の指摘にする。
  // 項目どうしの関係を見る検査は、隣の項目の改訂で生じうるので、影響の範囲（変えた項目とその 1 hop 先）の外のものだけを既存の指摘にする。
  if (impact) {
    const hit = new Set(impact.impact)
    const changed = new Set(impact.changed)
    const removed = new Set(impact.removed)
    const entryRoleKeys = roleEntryKeys(withMeta, graph, entry[ENTRY_ROLES] || {})
    for (const f of expanded.findings) {
      if (!entry[f.document] || f.document === ENTRY_ROLES || !Object.hasOwn(entry[f.document], f.location) || changed.has(f.location)) continue
      // related を持つ指摘（ST-FORMAL-CEX- の依存）も、NEVER_PREEXISTING なら既存の指摘にしない。
      if (NEVER_PREEXISTING.some((p) => f.id.startsWith(p))) continue
      if (f.related) {
        if ([...f.related, ...(entryRoleKeys.get(f.id) || [])].every((k) => !changed.has(k) && !removed.has(k))) f.preexisting = true
        continue
      }
      if (ITEM_LOCAL.some((p) => f.id.startsWith(p)) || !hit.has(f.location)) f.preexisting = true
    }
  }
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
  const counted = expanded.findings.filter((f) => countsAsBlocking(f, fixedKeys))
  const preexisting = expanded.findings.filter((f) => f.preexisting).length
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
    fixed_findings: expanded.findings.length - counted.length - preexisting,
    preexisting_findings: preexisting,
    ...(impact ? { impact: { changed: impact.changed.length, removed: impact.removed.length, items: impact.impact.length, path: impact.path }, entry_digest: digestOf(entry) } : {}),
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
  planner: [...COMMON_SECTIONS, '§intake', '§flow-framer', '§resolver', '決定の台帳', '現物と既存実装の扱い', FLOW_SHAPE, '不変条件の kind'],
  'plan-reviewer': [...COMMON_SECTIONS, '§plan-reviewer', '決定の台帳', '現物と既存実装の扱い', FLOW_SHAPE, '不変条件の kind'],
  writer: [...COMMON_SECTIONS, '§writer', '決定の台帳', '現物と既存実装の扱い', '形式検証の事実'],
  'writer-reviewer': [...COMMON_SECTIONS, '監査役の共通節', '§writer-reviewer', '現物と既存実装の扱い', '形式検証の事実'],
  'whole-reviewer': [...COMMON_SECTIONS, '監査役の共通節', '決定の台帳', '§whole-reviewer', '現物と既存実装の扱い', '形式検証の事実'],
  'flow-check': ['§flow-check'],
}

// CONTRACT_BUDGET・CONTRACT_PARTS: contract の 1 回の stdout の上限（UTF-8 のバイト）と、役ごとの回数の上限。agent の Bash は 30000 バイトを
// 超える出力をファイルに逃がして先頭しか見せないので、上限ごとに分けた全部を最初のターンに並べて実行させる。CONTRACT_PARTS は prd-spec.js と
// 同じ（tests が照合する）。
const CONTRACT_BUDGET = 30000
const CONTRACT_PARTS = 3

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
  return new Set(keys.flatMap((k) => [docFileOf(k), ledgerOf('meta').file(k), carryFileOf(k)]))
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

// quotes: writer reviewer の指摘の quote が W の原文のどれかに在るかを照らす（prd-spec.js が not_found の指摘を静的に退ける）。照らす先は文書の本文
// （固定の文書を含む）と meta、input.md と answers、台帳の decisions・resolutions・flow で、ファイルごとに文字列として読む。静的な退けは LLM の
// 判断を通らないので、正規化は在る向きにだけ倒す: NFKC にし、quote を ... で断片に分け、文字と数字以外を除いた形（plain）と、その前に HTML の
// タグ・Markdown のリンクの行き先・JSON の文字列のエスケープを外した形（stripped）を両側で作り、どの組でも空でない断片が全て同じファイルの中に
// この順で在れば在るとする。quote が無いか正規化して空になる形があれば no_quote（記録だけ）。
const QUOTE_NAME = /^r([1-9]\d*)-wr-(?:all|p[1-9]\d*)$/
const quoteKeep = (t) => t.replace(/[^\p{L}\p{N}]+/gu, '')
const quoteStrip = (t) => t.replace(/<\/?[A-Za-z][^<>]*>/g, ' ').replace(/\]\([^()]*\)/g, ']').replace(/\\[nrt"\\/]/g, ' ')
const quoteForms = (text) => {
  const n = String(text).normalize('NFKC')
  return [quoteKeep(n), quoteKeep(quoteStrip(n))]
}
const quoteFragments = (quote) => {
  const n = String(quote).normalize('NFKC')
  return [n, quoteStrip(n)].map((t) => t.split(/\.{3,}/).map(quoteKeep).filter(Boolean))
}
const inOrder = (text, frags) => {
  let at = 0
  for (const f of frags) {
    const i = text.indexOf(f, at)
    if (i < 0) return false
    at = i + f.length
  }
  return true
}
function quoteSources(ws, wsDocs) {
  const read = (rel) => {
    const p = path.join(ws, rel)
    return fs.existsSync(p) && fs.statSync(p).isFile() ? fs.readFileSync(p, 'utf8') : null
  }
  const dir = path.join(ws, 'answers')
  const answers = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.md')).sort().map((n) => path.join('answers', n)) : []
  const rels = [...wsDocs.flatMap((d) => [d.path, ledgerOf('meta').file(d.key)]), 'input.md', ...answers, ...['decisions', 'resolutions', 'flow'].map((n) => ledgerOf(n).file())]
  return rels.map(read).filter((t) => t !== null).map(quoteForms)
}
function wsQuotes(ws, opts) {
  const names = opts.findings || []
  if (!names.length) throw new Error('--findings に r<n>-wr-<組> の名前が要ります')
  const bad = names.filter((n) => !QUOTE_NAME.test(n))
  if (bad.length) throw new Error(`--findings の名前は r<n>-wr-(all|p<k>) の形です: ${bad.join(', ')}`)
  const rounds = [...new Set(names.map((n) => QUOTE_NAME.exec(n)[1]))]
  if (rounds.length !== 1) throw new Error(`--findings の名前は同じ回のものだけです: ${names.join(', ')}`)
  const findings = names.flatMap((name) => {
    const data = readJsonFile(path.join(ws, 'findings', `${name}.json`))
    if (data === null || !Array.isArray(data.findings)) throw new Error(`W/findings/${name}.json が無いか findings の配列がありません`)
    return data.findings.filter((f) => f && typeof f.id === 'string')
  })
  const wsDocs = workspaceDocs(ws)
  const sources = quoteSources(ws, wsDocs)
  const results = findings.map((f) => {
    const forms = typeof f.quote === 'string' ? quoteFragments(f.quote) : []
    if (!forms.length || forms.some((frags) => !frags.length)) return { id: f.id, reason: 'no_quote' }
    const found = forms.some((frags) => sources.some((texts) => texts.some((t) => inOrder(t, frags))))
    return { id: f.id, reason: found ? 'found' : 'not_found' }
  })
  const rel = writeCheck(ws, `quotes-r${rounds[0]}.json`, { files: names, results })
  return {
    findings: findings.length,
    files: names,
    ids: findings.map((f) => f.id),
    unquoted: results.filter((r) => r.reason === 'not_found').map((r) => r.id),
    path: rel,
    tree_digest: digestOf(snapshotOf(wsDocs)),
  }
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

// 文書一覧の行は本文だけから導出する（references/document-splitting.md §6）。
const NO_SECTION = '（節なし）'
function headingWalk(md, kind) {
  let inFence = false
  const stack = []
  const out = { title: null, sections: [] }
  for (const ln of String(md || '').split('\n')) {
    if (/^\s*(```|~~~)/.test(ln)) inFence = !inFence
    if (inFence) continue
    const m = /^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/.exec(ln)
    if (!m) continue
    const level = m[1].length
    const text = m[2]
    if (level === 1 && out.title === null) out.title = text
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop()
    if ((text.match(ID_IN_TEXT[kind]) || []).length) {
      const parent = [...stack].reverse().find((h) => h.level > 1 && !(h.text.match(ID_IN_TEXT[kind]) || []).length)
      const name = parent ? parent.text : NO_SECTION
      if (!out.sections.includes(name)) out.sections.push(name)
    }
    stack.push({ level, text })
  }
  if (out.sections.length === 1 && out.sections[0] === NO_SECTION) out.sections = []
  return out
}

// 欠番を並べるのは先頭のこの件数まで。誤記の大きな番号が 1 つあるだけで、行が数万件の欠番で埋まるのを防ぐ。
const GAPS_SHOWN = 10
function idRanges(ids) {
  const groups = new Map()
  for (const id of ids) {
    const m = /^(.*-)(\d+)$/.exec(id)
    if (!m) continue
    const g = groups.get(m[1]) || { width: 0, nums: new Set() }
    g.width = Math.max(g.width, m[2].length)
    g.nums.add(Number(m[2]))
    groups.set(m[1], g)
  }
  return [...groups].map(([prefix, g]) => {
    const nums = [...g.nums].sort((a, b) => a - b)
    const pad = (n) => String(n).padStart(g.width, '0')
    const first = Math.min(1, nums[0])
    const last = nums[nums.length - 1]
    const missing = last - first + 1 - nums.length
    const shown = []
    for (let n = first; n < last && shown.length < GAPS_SHOWN; n++) if (!g.nums.has(n)) shown.push(pad(n))
    const range = last > first ? `${prefix}${pad(first)}〜${pad(last)}` : `${prefix}${pad(last)}`
    if (!missing) return range
    return `${range}、欠番は ${shown.join('・')}${missing > shown.length ? ` ほか ${missing - shown.length} 件` : ''}`
  })
}

function docSummary(d) {
  const { sections } = headingWalk(d.markdown, d.kind)
  const tail = [...idRanges(d.ids), `${d.ids.length} 件`].join('／')
  return sections.length ? `${sections.join('／')}（${tail}）` : tail
}

function wsIndex(ws, opts) {
  const wsDocs = workspaceDocs(ws)
  if (!wsDocs.length) throw new Error('workspace に文書（requirements-*.md / specifications-*.md）がありません')
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
    lines.push('## 文書一覧', '', `| パス | 扱う関心事 | どういう${label}が書かれているか |`, '|---|---|---|')
    for (const d of target) lines.push(`| \`${pathOf(d)}\` | ${cellOf(headingWalk(d.markdown, d.kind).title ?? '（見出し 1 なし）')} | ${cellOf(docSummary(d))} |`)
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
  // 保存する文書の開いている TBD を、文書の隣へ写すファイルとして出す。写す先は文書の保存先で決まり（existing は元の場所）、ここでは決まらないので
  // 文書のキーで返す。固定の文書は保存しないので、保存先の写しをそのまま残す。開いている TBD が無い文書は消す側に出す（残すと、閉じた TBD が
  // 次の run の「未解決」に戻る）。
  const carry = []
  const clear = []
  for (const d of docs.filter((x) => !x.fixed)) {
    const open = d.tbd_items.filter((t) => t && t.id && openIds.has(t.id))
    if (!open.length) {
      clear.push(d.key)
      continue
    }
    carry.push({ doc: d.key, path: path.join('checks', carryFileOf(d.key)), tbd: open })
  }
  for (const c of carry) fs.writeFileSync(path.join(ws, c.path), ledgerText({ tbd: c.tbd }))
  return { indexes: written, open_tbd_files: carry.map(({ doc, path: p }) => ({ doc, path: p })), open_tbd_clear: clear }
}

// wsFormalModel: 仕様書（specifications/<topic>）に書かれた状態機械（stateDiagram-v2 / 状態 × イベント表）から、
// TLA+ 形式検証モデル（.tla, .cfg, README.md, check.test.mjs）を導出して W/formal/<topic>/ に置く。
// 成果物として tests/formal/<topic>/ へ写され、Layer 2（TLA+ モデル検査）および有界モデル検査が実行可能になる。
function wsFormalModel(ws, opts) {
  const wsDocs = workspaceDocs(ws)
  const docs = deriveDocs(wsDocs)
  const specDocs = docs.filter((d) => d.kind === 'specifications' && (!opts.doc.length || opts.doc.includes(d.key)))
  if (!specDocs.length) throw new Error('形式モデルを導出する仕様書（specifications/<topic>）がありません')

  const results = []
  for (const d of specDocs) {
    const topic = d.topic
    const md = d.markdown || ''
    const secs = sectionsOf2(md)
    let edges = null
    for (const sec of secs) {
      const diag = stateDiagramOf(sec)
      if (diag && diag.length) {
        edges = diag
        break
      }
    }
    if (!edges || !edges.length) continue

    const initial = (edges.find((e) => e.from === '[*]') || {}).to || null
    const terminals = edges.filter((e) => e.to === '[*]').map((e) => e.from)
    const validEdges = edges.filter((e) => e.from !== '[*]' && e.to !== '[*]')
    const states = [...new Set([...validEdges.flatMap((e) => [e.from, e.to]), ...(initial ? [initial] : []), ...terminals])].sort()

    const modelName = topic.split(/[-_]/).map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join('') || 'Spec'
    const outDir = path.join(ws, 'formal', topic)
    fs.mkdirSync(outDir, { recursive: true })

    // 1. TLA+ module (<ModelName>.tla)
    const tlaLines = [
      `------------------------------ MODULE ${modelName} ------------------------------`,
      'EXTENDS Naturals, Sequences',
      '',
      `CONSTANTS MaxSteps`,
      '',
      `VARIABLES state, stepCount`,
      '',
      `vars == <<state, stepCount>>`,
      '',
      `States == { ${states.map((s) => JSON.stringify(s)).join(', ')} }`,
      '',
      `TypeOK ==`,
      `    /\\ state \\in States`,
      `    /\\ stepCount \\in 0..MaxSteps`,
      '',
      `Init ==`,
      initial ? `    /\\ state = ${JSON.stringify(initial)}` : `    /\\ state \\in States`,
      `    /\\ stepCount = 0`,
      '',
    ]

    const transGroups = new Map()
    for (const e of validEdges) {
      if (!transGroups.has(e.from)) transGroups.set(e.from, [])
      transGroups.get(e.from).push(e)
    }

    const actionNames = []
    let actIdx = 1
    for (const [fromState, toEdges] of transGroups) {
      for (const edge of toEdges) {
        const actName = `Trans_${actIdx++}`
        actionNames.push(actName)
        tlaLines.push(
          `${actName} ==`,
          `    /\\ state = ${JSON.stringify(fromState)}`,
          `    /\\ stepCount < MaxSteps`,
          `    /\\ state' = ${JSON.stringify(edge.to)}`,
          `    /\\ stepCount' = stepCount + 1`,
          ''
        )
      }
    }

    if (!actionNames.length) {
      actionNames.push('Stutter')
      tlaLines.push(`Stutter == /\\ UNCHANGED vars`, '')
    }

    tlaLines.push(
      `Next ==`,
      `    ${actionNames.map((a) => `\\/ ${a}`).join('\n    ')}`,
      '',
      `Spec == Init /\\ [][Next]_vars`,
      '',
      `DeadlockFree ==`,
      terminals.length
        ? `    (state \\notin { ${terminals.map((t) => JSON.stringify(t)).join(', ')} }) => (stepCount < MaxSteps => ENABLED Next)`
        : `    stepCount < MaxSteps => ENABLED Next`,
      '',
      `ValidTerminal ==`,
      terminals.length
        ? `    (state \\in { ${terminals.map((t) => JSON.stringify(t)).join(', ')} }) => (stepCount <= MaxSteps)`
        : `    TRUE`,
      '',
      `=============================================================================`
    )

    const tlaPath = path.join(outDir, `${modelName}.tla`)
    fs.writeFileSync(tlaPath, tlaLines.join('\n') + '\n')

    // 2. TLC Config (<ModelName>.cfg)
    const cfgLines = [
      'SPECIFICATION Spec',
      'CONSTANTS',
      '    MaxSteps = 10',
      'INVARIANTS',
      '    TypeOK',
      '    DeadlockFree',
      '    ValidTerminal',
    ]
    const cfgPath = path.join(outDir, `${modelName}.cfg`)
    fs.writeFileSync(cfgPath, cfgLines.join('\n') + '\n')

    // 3. README.md
    const readmeLines = [
      `# ${topic} 仕様の形式モデル`,
      '',
      `この形式モデルは \`${d.key}\` から \`doc_check.mjs formal-model\` により自動導出された TLA+ 状態機械モデルである。`,
      '',
      '## 状態遷移',
      '',
      '```mermaid',
      'stateDiagram-v2',
      ...(initial ? [`    [*] --> ${initial}`] : []),
      ...validEdges.map((e) => `    ${e.from} --> ${e.to}${e.label ? ` : ${e.label}` : ''}`),
      ...terminals.map((t) => `    ${t} --> [*]`),
      '```',
      '',
      '## 検証する性質',
      '',
      '| 性質 | 内容 |',
      '|---|---|',
      '| `TypeOK` | 状態変数が仕様書で定義された状態集合に含まれる |',
      '| `DeadlockFree` | 終端状態以外の状態において、ステップ上限に達するまで次の遷移が存在する |',
      '| `ValidTerminal` | 終端状態に到達した実行パスの妥当性 |',
      '',
      '## 実行',
      '',
      '```bash',
      `node --test check.test.mjs`,
      '```',
      '',
      'または TLC によるモデル検査:',
      '',
      '```bash',
      `java -cp /path/to/tla2tools.jar tlc2.TLC ${modelName}.tla -config ${modelName}.cfg`,
      '```',
    ]
    const readmePath = path.join(outDir, 'README.md')
    fs.writeFileSync(readmePath, readmeLines.join('\n') + '\n')

    // 4. check.test.mjs (有界モデル検査器)
    const checkTestLines = [
      `import assert from 'node:assert/strict';`,
      `import fs from 'node:fs';`,
      `import path from 'node:path';`,
      `import { fileURLToPath } from 'node:url';`,
      `import test from 'node:test';`,
      '',
      `const here = path.dirname(fileURLToPath(import.meta.url));`,
      `const tlaPath = path.join(here, '${modelName}.tla');`,
      `const cfgPath = path.join(here, '${modelName}.cfg');`,
      `const readmePath = path.join(here, 'README.md');`,
      '',
      `test('Formal model files exist and match structure', () => {`,
      `  assert.ok(fs.existsSync(tlaPath));`,
      `  assert.ok(fs.existsSync(cfgPath));`,
      `  assert.ok(fs.existsSync(readmePath));`,
      `  const tla = fs.readFileSync(tlaPath, 'utf8');`,
      `  assert.match(tla, /MODULE ${modelName}/);`,
      `  assert.match(tla, /TypeOK/);`,
      `  assert.match(tla, /DeadlockFree/);`,
      `});`,
      '',
      `test('Bounded Model Checking: explore state space and reachability', () => {`,
      `  const states = ${JSON.stringify(states)};`,
      `  const initial = ${JSON.stringify(initial)};`,
      `  const terminals = new Set(${JSON.stringify(terminals)});`,
      `  const transitions = ${JSON.stringify(validEdges.map((e) => ({ from: e.from, to: e.to })))};`,
      '',
      `  const transMap = new Map();`,
      `  for (const t of transitions) {`,
      `    if (!transMap.has(t.from)) transMap.set(t.from, []);`,
      `    transMap.get(t.from).push(t.to);`,
      `  }`,
      '',
      `  const visited = new Set();`,
      `  const queue = initial ? [initial] : [...states];`,
      `  let reachedTerminal = terminals.size === 0;`,
      '',
      `  while (queue.length > 0) {`,
      `    const curr = queue.shift();`,
      `    if (visited.has(curr)) continue;`,
      `    visited.add(curr);`,
      `    assert.ok(states.includes(curr), \`State \${curr} must be in declared states\`);`,
      `    if (terminals.has(curr)) reachedTerminal = true;`,
      `    const nexts = transMap.get(curr) || [];`,
      `    if (!terminals.has(curr)) {`,
      `      assert.ok(nexts.length > 0, \`Non-terminal state \${curr} must have outgoing transitions\`);`,
      `    }`,
      `    for (const n of nexts) {`,
      `      if (!visited.has(n)) queue.push(n);`,
      `    }`,
      `  }`,
      `  assert.ok(visited.size > 0, 'Explored non-empty state space');`,
      `  assert.ok(reachedTerminal, 'Must be able to reach terminal state');`,
      `});`,
    ]
    const testPath = path.join(outDir, 'check.test.mjs')
    fs.writeFileSync(testPath, checkTestLines.join('\n') + '\n')

    results.push({
      topic,
      doc: d.key,
      model: modelName,
      output_dir: path.relative(ws, outDir),
      files: [
        path.join('formal', topic, `${modelName}.tla`),
        path.join('formal', topic, `${modelName}.cfg`),
        path.join('formal', topic, 'README.md'),
        path.join('formal', topic, 'check.test.mjs'),
      ],
      states_count: states.length,
      transitions_count: validEdges.length,
    })
  }

  return { formal_models: results }
}

// ---------------------------------------------------------------- 形式検証の接続（formal-request・formal-import・formal-status・formal-off）
// prd-spec は formal-method を import しない（公開済みの plugin から未公開のスキルをパスで呼べない）。ここは formal-method に渡す依頼の JSON を
// 書き、formal-method の run の領域に残った結果を読むだけで、formal-method を呼ぶのは司令塔の手順（SKILL.md「## 中継」）。形の正本は
// references/workflow-io.md §6 と schemas/agent-contracts.md の「## 形式検証の事実」。

// UsageError: 使い方の誤り（exit 2）。司令塔は formal-import の exit 2 のときだけ止まる。
class UsageError extends Error {}
// FORMAL_TIME_LIMIT_S: 依頼の time_limit_seconds。上限が無いと担当の呼び出しの期限（30 分）が段の数だけ積み上がる。実測していない値で、F 段で較正する。
const FORMAL_TIME_LIMIT_S = 3600
const FORMAL_DIR = 'fm'
const FORMAL_OFF_FILE = 'off.json'
const FORMAL_TARGET = 'prd-spec'
const FORMAL_RID = /^f[1-9]\d*[ab]$/
const FORMAL_FACTS = 'prd-spec.formal-facts/1'
const FORMAL_RESULT = 'formal-method.result/2'
const FORMAL_OFF_REASONS = ['skill_missing', 'host_unsupported']
const FORMAL_UNAVAILABLE = ['no_result']
// FORMAL_CAUSE: 反例を目標の反例として数える原因（formal-method の Cause.cause）。他の原因の反例は未検証にする（モデルや計画の欠陥は文書の誤りではない）。
const FORMAL_CAUSE = '対象が性質を満たさない'
// FORMAL_STATIC: 送らない単位を決める静的な指摘の種別（ST-DT-・ST-STATE-・ST-ENUM-SET-MISMATCH-）。静的に決まるものを形式検証に回さない。
const FORMAL_STATIC = /^(STATE_|DT_(GAP|OVERLAP|VALUE)$|ENUM_SET_MISMATCH$)/
const FORMAL_KINDS = ['domain', 'bounds', 'guard', 'state']

// 式（コードスパンの中・宣言の値・矢印のガード）。比較の記号で項に分け、項が数で始まれば値、それ以外を名前にする。等号だけの式（`経路 = 社外`）は
// 最初の項だけを名前にし、残りを条件の値とする。量の名前は、大小の比較か数の値を持つ式に現れる名前である。
const CMP_SPLIT = /\s*(≤|≥|≠|<=|>=|!=|<|>|=)\s*/
const ORDERING = new Set(['≤', '≥', '<', '>', '<=', '>='])
const NUMERIC_TERM = /^[-+]?\d/
function parseExpr(text) {
  const t = String(text || '').trim()
  const parts = t.split(CMP_SPLIT)
  if (parts.length < 3) return null
  const terms = parts.filter((_, i) => i % 2 === 0).map((x) => x.trim())
  if (terms.some((x) => !x)) return null
  const ordering = parts.some((x, i) => i % 2 === 1 && ORDERING.has(x))
  const numeric = terms.some((x) => NUMERIC_TERM.test(x))
  const names = (ordering ? terms : terms.slice(0, 1)).filter((x) => !NUMERIC_TERM.test(x))
  return names.length ? { text: t, ordering, numeric, names: [...new Set(names)] } : null
}

// formalSection: ID を持つ区間（itemSections）の、形式検証に回す材料。行番号は文書の行番号（区間の lines[i] は s.start + i 行目）。
// exprs の kind は、コードスパンの直後の語で決まる（でなければならない → bounds、のとき → guard、どちらでもなければ null）。表の行と引用の行の式は読まない。
function formalSection(s) {
  const out = { decls: [], refs: [], exprs: [], arrows: [], diagram: null, tables: [], axes: [] }
  let fence = null
  s.lines.forEach((ln, i) => {
    const line = s.start + i
    if (i === 0) return
    if (/^\s*(```|~~~)/.test(ln)) {
      if (fence) {
        if (fence.state) out.diagram = { from: fence.from, to: line }
        fence = null
      } else fence = { from: line, state: false }
      return
    }
    if (fence) {
      if (/^\s*stateDiagram/.test(ln)) fence.state = true
      else if (fence.state && !/^\s*%%/.test(ln)) {
        const m = /^\s*(.+?)\s*-->\s*(.+?)\s*$/.exec(ln)
        if (m) {
          const raw = m[2].split(/\s*:\s*/).slice(1).join(':')
          const g = /\[([^\]]*)\]/.exec(raw)
          out.arrows.push({ guard: g ? g[1].trim() : null, line, ids: raw.match(new RegExp(`${ID_IN_TEXT.requirements.source}|${ID_IN_TEXT.specifications.source}`, 'g')) || [] })
        }
      }
      return
    }
    const q = /^\s*>\s?(.*)$/.exec(ln)
    if (q) {
      const t = q[1].trim()
      const dm = /^条件の値\s*[:：]\s*(.+?)\s*=\s*(.+)$/.exec(t)
      if (dm && CONDITION_REF.test(dm[2].trim())) out.refs.push({ name: dm[1].trim(), ref: dm[2].trim(), line })
      else if (dm) out.decls.push({ name: dm[1].trim(), values: splitAxis(dm[2]), line, text: t })
      else if (AXIS_START.test(t)) out.axes.push(line)
      return
    }
    if (/^\s*\|/.test(ln)) {
      out.tables.push(line)
      return
    }
    for (const m of ln.matchAll(/`([^`]+)`/g)) {
      const e = parseExpr(m[1])
      if (!e) continue
      const after = ln.slice(m.index + m[0].length).replace(/^\s+/, '')
      out.exprs.push({ ...e, kind: after.startsWith('でなければならない') ? 'bounds' : after.startsWith('のとき') ? 'guard' : null, line })
    }
  })
  return out
}

const formalSpans = (ns) => {
  const out = []
  for (const n of [...new Set(ns)].sort((a, b) => a - b)) {
    const last = out[out.length - 1]
    if (last && n === last[1] + 1) last[1] = n
    else out.push([n, n])
  }
  return out.map(([a, b]) => `L${a}-L${b}`)
}
const spanFrom = (span) => Number((/^L(\d+)-L(\d+)$/.exec(String(span || '')) || [])[1])
const spanRange = (span) => {
  const m = /^L(\d+)-L(\d+)$/.exec(String(span || ''))
  return m ? [Number(m[1]), Number(m[2])] : null
}
// unitKey: 単位の key。bounds は量の名前の組（quantity）も入れる（1 つの項目に別の量の制約があれば別の単位）。
const unitKey = (u) => `${u.doc}\u0000${u.item_id}\u0000${u.kind}\u0000${u.quantity || ''}`

// formalStatics: 単位を送らない静的な指摘の場所。DT と ENUM は区間の key（<文書>#<ID>）、STATE は文書と区間の見出しの行で引く。
function formalStatics(ws, wsDocs) {
  const index = conditionIndex(wsDocs)
  const dt = new Set()
  for (const d of wsDocs) {
    for (const s of itemSections(d.markdown, d.kind)) {
      if (!s.id) continue
      const out = []
      decisionCheck(d, { heading: s.lines[0] || '', start: s.start - 1, lines: s.lines }, out, [], index)
      if (out.some((f) => FORMAL_STATIC.test(f.c))) dt.add(`${d.key}#${s.id}`)
    }
  }
  const derived = deriveDocs(wsDocs)
  const metaOf = new Map(wsDocs.map((d) => [d.key, d.meta]))
  const ledgers = { decisions: readLedger(ws, 'decisions'), resolutions: readLedger(ws, 'resolutions'), verifications: readLedger(ws, 'verifications') }
  for (const f of graphCheck(derived.map((d) => ({ ...d, meta: metaOf.get(d.key) })), ledgers, readLedger(ws, 'flow'), null)) {
    if (f.c === 'ENUM_SET_MISMATCH') dt.add(`${f.d}#${f.a[1]}`)
  }
  // state: 区間の見出しの行を含む ## の節に stateCheck を当てる（doc の検査と同じ材料。formalCompact の図の拾い方も同じ）。
  const stateAt = (d, line) => {
    const secs = sectionsOf2(d.markdown)
    const diagrams = secs.map((sec) => stateDiagramOf(sec)).filter(Boolean)
    const sec = [...secs].reverse().find((x) => x.start + 1 <= line)
    if (!sec) return false
    const out = []
    stateCheck(d, sec, out, diagrams.length === 1 ? diagrams[0] : null)
    return out.some((f) => FORMAL_STATIC.test(f.c))
  }
  return { keys: dt, stateAt }
}

// formalUnits: 固定でない文書の ID を持つ区間から、形式検証の単位を取る（references/workflow-io.md §6 の formal-request）。
// 単位の digest は、区間の itemDigests の digest と依存の区間の digest の並びから決める（依存の宣言だけを変えても送り直す）。
function formalUnits(ws, wsDocs) {
  const docs = wsDocs.map((d) => ({ d, fixed: Boolean(d.meta && d.meta.fixed), secs: itemSections(d.markdown, d.kind).filter((s) => s.id).map((s) => ({ s, f: formalSection(s) })) }))
  const declIndex = new Map()
  for (const { d, secs } of docs) {
    for (const { s, f } of secs) {
      for (const c of f.decls) {
        const k = `${s.id}\u0000${c.name}`
        const v = { doc: d.key, file: d.path, item: s.id, line: c.line, values: c.values }
        if (!declIndex.has(k)) declIndex.set(k, v)
        else if (declIndex.get(k) && canonicalJson([...declIndex.get(k).values].sort()) !== canonicalJson([...c.values].sort())) declIndex.set(k, null)
      }
    }
  }
  const quantities = new Set()
  for (const { secs } of docs) {
    for (const { f } of secs) {
      const exprs = [...f.exprs, ...f.arrows.map((a) => a.guard && parseExpr(a.guard)), ...f.decls.flatMap((c) => c.values.map(parseExpr))].filter(Boolean)
      for (const e of exprs) if (e.ordering || e.numeric) for (const n of e.names) quantities.add(n)
    }
  }
  const digests = new Map(wsDocs.map((d) => [d.key, itemDigests(d)]))
  const secDigest = (key) => {
    const i = key.indexOf('#')
    const m = digests.get(key.slice(0, i))
    const v = m && m.get(key.slice(i + 1))
    return v ? v.digest : null
  }
  const statics = formalStatics(ws, wsDocs)
  const counter = new Map()
  const goalId = (item, kind) => {
    const k = `${item}.${kind}`
    const n = (counter.get(k) || 0) + 1
    counter.set(k, n)
    return `${k}.${n}`
  }
  // resolve: 名前を、同じ区間の直書きの宣言 → 同じ区間の参照で解いた宣言 → 量の名前の順に解く。1 つに決まらなければ解けない（null）。
  const resolve = (ctx, name) => {
    const direct = ctx.f.decls.filter((c) => c.name === name)
    if (direct.length > 1) return null
    if (direct.length === 1) return { kind: '条件', line: direct[0].line, item: ctx.s.id, doc: ctx.d.key, file: ctx.d.path, dep: null }
    const refs = ctx.f.refs.filter((c) => c.name === name)
    if (refs.length > 1) return null
    if (refs.length === 1) {
      const t = declIndex.get(`${refs[0].ref}\u0000${name}`)
      return t ? { kind: '条件', line: t.line, item: t.item, doc: t.doc, file: t.file, dep: `${t.doc}#${t.item}`, ref: refs[0] } : null
    }
    return quantities.has(name) ? { kind: '量' } : null
  }
  // knownsOf: 名前と参照の対応（K-NAME・K-REF の文）。抽出役は範囲の外を読まないので、対応を推測させずに渡す。
  const knownsOf = (ctx, line, resolved) =>
    resolved.flatMap(([name, r]) => [
      r.kind === '量'
        ? { kind: 'NAME', text: `${ctx.s.id} の L${line} の名前「${name}」は、量（比較の式の変数）を指す`, file: ctx.d.path, line }
        : { kind: 'NAME', text: `${ctx.s.id} の L${line} の名前「${name}」は、${r.item} の L${r.line} の宣言の条件を指す`, file: ctx.d.path, line, refers: { file: r.file, line: r.line } },
      ...(r.ref ? [{ kind: 'REF', text: `${ctx.s.id} の L${r.ref.line} の参照の行の値の域は、${r.item} の L${r.line} の宣言と同じ集合である`, file: ctx.d.path, line: r.ref.line, refers: { file: r.file, line: r.line } }] : []),
    ])
  const units = []
  const unsent = []
  const drop = (ctx, kind, reason) => {
    if (!unsent.some((x) => x.doc === ctx.d.key && x.item_id === ctx.s.id && x.reason === reason)) unsent.push({ doc: ctx.d.key, item_id: ctx.s.id, kind, reason })
  }
  const bounds = new Map()
  const addBounds = (ctx, e, resolved, fixed) => {
    const k = [...e.names].sort().join('\u0000')
    bounds.set(k, [...(bounds.get(k) || []), { ctx, e, resolved, fixed }])
  }
  for (const { d, fixed, secs } of docs) {
    // ID の無い節のガード付きの状態図は単位にしない（項目に帰属できず、指摘を返す先が無い）。開示だけにし、非決定の抑止も当てない（stateCheck）。
    if (!fixed) {
      for (const s of itemSections(d.markdown, d.kind).filter((x) => !x.id)) {
        const f = formalSection(s)
        if (f.diagram && f.arrows.some((a) => a.guard)) unsent.push({ doc: d.key, item_id: `${d.key}${s.key}`, kind: 'state', reason: 'ID を持たない節の状態遷移図なので形式検証に回さない（項目の見出しの下に置く）' })
      }
    }
    for (const { s, f } of secs) {
      const ctx = { d, s, f }
      const self = `${d.key}#${s.id}`
      // 固定の文書の項目は単位にしない。同じ量の制約だけを bounds の依存にする。
      if (fixed) {
        for (const e of f.exprs.filter((x) => x.kind === 'bounds')) {
          const resolved = e.names.map((n) => [n, resolve(ctx, n)])
          if (resolved.every(([, r]) => r)) addBounds(ctx, e, resolved, true)
        }
        continue
      }
      // domain: 比較の式を値に持つ直書きの宣言。依存は、その宣言を参照する区間。
      const domains = f.decls.filter((c) => c.values.some((v) => (parseExpr(v) || {}).ordering))
      if (domains.length) {
        const refBy = docs.flatMap((x) => x.secs.flatMap((y) => y.f.refs.filter((r) => r.ref === s.id && domains.some((c) => c.name === r.name)).map((r) => ({ doc: x.d.key, file: x.d.path, item: y.s.id, line: r.line, name: r.name }))))
        units.push({
          doc: d.key, file: d.path, item_id: s.id, kind: 'domain', lines: domains.map((c) => c.line),
          deps: [...new Set(refBy.filter((r) => `${r.doc}#${r.item}` !== self).map((r) => `${r.doc}#${r.item}`))].sort(),
          goals: domains.map((c) => ({ goal_id: goalId(s.id, 'domain'), text: `${s.id} の \`> ${c.text}\` の値の式は、${c.name} のとりうる値の全体を覆い、どの 2 つも同時に真にならない`, blocking: true })),
          refs: refBy.map((r) => ({ file: r.file, line: r.line })),
          knowns: refBy.map((r) => ({ kind: 'REF', text: `${r.item} の L${r.line} の参照の行の値の域は、${s.id} の L${domains.find((c) => c.name === r.name).line} の宣言と同じ集合である`, file: r.file, line: r.line })),
        })
      }
      for (const e of f.exprs.filter((x) => x.kind === null)) drop(ctx, null, '制約か条件か決まらない')
      // guard: 条件の文型の式。名前を解けない式は送らない。
      const guards = []
      for (const e of f.exprs.filter((x) => x.kind === 'guard')) {
        const resolved = e.names.map((n) => [n, resolve(ctx, n)])
        const bad = resolved.find(([, r]) => !r)
        if (bad) drop(ctx, 'guard', `名前を解けない: ${bad[0]}`)
        else guards.push({ e, resolved })
      }
      if (guards.length) {
        const sat = guards.map(({ e }) => ({ goal_id: goalId(s.id, 'guard'), text: `${s.id} の L${e.line} の条件 \`${e.text}\` は、条件の値の域の下で満たす値を持つ`, blocking: true }))
        const overlap = guards.flatMap((a, i) => guards.slice(i + 1).map((b) => ({ goal_id: goalId(s.id, 'guard'), text: `${s.id} の L${a.e.line} と L${b.e.line} の条件は同時に真にならない`, blocking: false })))
        const knowns = guards.flatMap(({ e, resolved }) => knownsOf(ctx, e.line, resolved))
        units.push({
          doc: d.key, file: d.path, item_id: s.id, kind: 'guard', lines: guards.map(({ e }) => e.line),
          deps: [...new Set(guards.flatMap(({ resolved }) => resolved.map(([, r]) => r.dep).filter(Boolean)))].sort(),
          goals: [...sat, ...overlap], refs: knowns.flatMap((k) => (k.refers ? [k.refers] : [])), knowns,
        })
      }
      // bounds: 制約の文型の式。量（名前の組）ごとに、全ての文書の制約をまとめる。
      for (const e of f.exprs.filter((x) => x.kind === 'bounds')) {
        const resolved = e.names.map((n) => [n, resolve(ctx, n)])
        const bad = resolved.find(([, r]) => !r)
        if (bad) {
          drop(ctx, 'bounds', `名前を解けない: ${bad[0]}`)
          continue
        }
        addBounds(ctx, e, resolved, false)
      }
      // state: 矢印にガードを 1 つ以上持つ状態遷移図の区間。ガードの名前を解けなければ送らない。
      if (f.diagram && f.arrows.some((a) => a.guard)) {
        const resolved = []
        let bad = null
        for (const a of f.arrows.filter((x) => x.guard)) {
          const e = parseExpr(a.guard)
          if (!e) {
            bad = bad || `ガードを式として読めない: ${a.guard}`
            continue
          }
          for (const n of e.names) {
            const r = resolve(ctx, n)
            if (!r) bad = bad || `名前を解けない: ${n}`
            else resolved.push({ line: a.line, pair: [n, r] })
          }
        }
        if (bad) drop(ctx, 'state', bad)
        else {
          const lines = []
          for (let n = f.diagram.from; n <= f.diagram.to; n++) lines.push(n)
          const knowns = resolved.flatMap(({ line, pair }) => knownsOf(ctx, line, [pair]))
          units.push({
            doc: d.key, file: d.path, item_id: s.id, kind: 'state',
            lines: [...lines, ...f.tables, ...f.axes, ...f.decls.map((c) => c.line), ...f.refs.map((c) => c.line)],
            deps: [...new Set(resolved.map(({ pair }) => pair[1].dep).filter(Boolean))].sort(),
            goals: [
              `${s.id} の状態遷移で、初期状態から着ける終端でない状態は、条件と量のどの値でも使える遷移を持つ`,
              `${s.id} の状態遷移で、同じ状態・同じイベントの矢印のガードは同時に真にならない`,
              `${s.id} の状態遷移で、宣言した全ての状態に初期状態から着ける`,
            ].map((text) => ({ goal_id: goalId(s.id, 'state'), text, blocking: true })),
            refs: knowns.flatMap((k) => (k.refers ? [k.refers] : [])), knowns,
            stateLine: s.start,
          })
        }
      }
    }
  }
  // bounds: 量（名前の組）ごとに 1 つの単位。1 つの項目の別の量の制約は別の単位になる（quantity が単位の key に入る）。
  for (const group of bounds.values()) {
    const first = group.find((x) => !x.fixed)
    if (!first) continue
    const own = group.filter((x) => x.ctx.s === first.ctx.s)
    const names = [...first.e.names].sort().join('・')
    const knowns = own.flatMap(({ ctx, e, resolved }) => knownsOf(ctx, e.line, resolved))
    units.push({
      doc: first.ctx.d.key, file: first.ctx.d.path, item_id: first.ctx.s.id, kind: 'bounds', quantity: names, lines: own.map((x) => x.e.line),
      deps: [...new Set(group.filter((x) => x.ctx.s !== first.ctx.s).map((x) => `${x.ctx.d.key}#${x.ctx.s.id}`))].sort(),
      goals: [{ goal_id: goalId(first.ctx.s.id, 'bounds'), text: `量 ${names} の制約（${group.map((x) => `${x.ctx.s.id} の L${x.e.line} \`${x.e.text}\``).join('、')}）は、同時に満たす値を持つ`, blocking: true }],
      refs: [...group.filter((x) => x.ctx.s !== first.ctx.s).map((x) => ({ file: x.ctx.d.path, line: x.e.line })), ...knowns.flatMap((k) => (k.refers ? [k.refers] : []))],
      knowns,
    })
  }
  const byDoc = new Map(wsDocs.map((d) => [d.key, d]))
  for (const u of units) {
    const self = `${u.doc}#${u.item_id}`
    u.unit_digest = digestOf({ self: secDigest(self), deps: u.deps.map(secDigest), ...(u.quantity ? { quantity: u.quantity } : {}) })
    const blocked = [self, ...u.deps].some((k) => statics.keys.has(k)) || (u.kind === 'state' && statics.stateAt(byDoc.get(u.doc), u.stateLine))
    u.staticReason = blocked ? '静的な検査の指摘が残っている' : null
  }
  return { units, unsent, secDigest }
}

const formalPath = (ws, ...rel) => path.join(ws, FORMAL_DIR, ...rel)
// withUnsent: 送らなかった単位は今の文書の全体から毎回求め直すので、facts の unverified の unsent を最新の依頼の分に置き換える
// （直した単位の古い rid の unsent を report に載せ続けない）。
const withUnsent = (unverified, unsent, rid) => [
  ...unverified.filter((x) => !x.unsent),
  ...unsent.map((x) => ({ rid, item: `${x.item_id}（${x.doc}・${x.kind || '種の決まらない式'}）`, reason: x.reason, unsent: true })),
]
function readFacts(ws) {
  const f = readJsonFile(formalPath(ws, 'facts.json'))
  return f && f.schema === FORMAL_FACTS ? f : { schema: FORMAL_FACTS, requests: [], units: [], unverified: [] }
}
// formalRid: --rid の検査。合わなければ使い方の誤り（exit 2）。
function formalRid(opts) {
  if (!opts.rid || !FORMAL_RID.test(opts.rid)) throw new UsageError(`--rid は f<回>a か f<回>b です: ${opts.rid}`)
  return opts.rid
}
const sortBytes = (xs) => [...xs].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
// formalCollectionHash: formal-method の集まりの指紋（artifact-formats.md「版と指紋」。FilePath のバイト列の辞書順に `<path>\0sha256:<hex>\n` をつないだ SHA-256）。
function formalCollectionHash(root) {
  const files = []
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(r)
      else if (e.isFile()) files.push(r)
    }
  }
  walk('')
  const text = sortBytes(files).map((f) => `${f}\0sha256:${sha256Bytes(fs.readFileSync(path.join(root, f)))}\n`).join('')
  return `sha256:${sha256Bytes(Buffer.from(text, 'utf8'))}`
}

// formal-request: 送る単位を決め、formal-method の依頼（fm/<rid>/request.json）と prd-spec の側の対応表（fm/<rid>/units.json）を書く。
// 送る単位は、依頼 a では 1. facts の最新の事実と digest が違うか retry 2. 入口（checks/entry.json）から自分か依存が変わった 3. どちらも無い の最初の
// 規則で決め、依頼 b では依頼 a に入れた単位のうち digest が変わったものにする。outcome のある rid は作り直さない（exit 2）。
function wsFormalRequest(ws, opts) {
  const rid = formalRid(opts)
  if (!['5', '8'].includes(String(opts.stage || ''))) throw new UsageError(`--stage は 5 か 8 です: ${opts.stage}`)
  if (!['a', 'b'].includes(opts.phase) || !rid.endsWith(opts.phase)) throw new UsageError(`--phase は a か b で、--rid の末尾と同じです: ${opts.phase}`)
  const dir = formalPath(ws, rid)
  if (fs.existsSync(path.join(dir, 'outcome.json'))) throw new UsageError(`${rid} は取り込み済みです（outcome.json がある）。同じ rid の依頼は作り直さない`)
  const wsDocs = workspaceDocs(ws)
  const fu = formalUnits(ws, wsDocs)
  const tree = digestOf(snapshotOf(wsDocs))
  let send
  if (opts.phase === 'a') {
    const facts = new Map(readFacts(ws).units.map((u) => [unitKey(u), u]))
    const entry = readJsonFile(path.join(ws, ENTRY_FILE))
    const fixedKeys = new Set(wsDocs.filter((d) => d.meta && d.meta.fixed).map((d) => d.key))
    const movedSinceEntry = (key) => {
      const doc = key.slice(0, key.indexOf('#'))
      if (fixedKeys.has(doc)) return false
      const was = entry[doc] && entry[doc][key.slice(key.indexOf('#') + 1)]
      return was === undefined || was !== fu.secDigest(key)
    }
    send = fu.units.filter((u) => {
      const fact = facts.get(unitKey(u))
      if (fact) return fact.retry === true || fact.unit_digest !== u.unit_digest
      if (entry) return [`${u.doc}#${u.item_id}`, ...u.deps].some(movedSinceEntry)
      return true
    })
  } else {
    const a = readJsonFile(formalPath(ws, rid.replace(/b$/, 'a'), 'units.json'))
    if (!a) throw new UsageError(`依頼 b の前に、依頼 a（${rid.replace(/b$/, 'a')}）の units.json が要ります`)
    const before = new Map(a.units.map((u) => [unitKey(u), u.unit_digest]))
    send = fu.units.filter((u) => before.has(unitKey(u)) && before.get(unitKey(u)) !== u.unit_digest)
  }
  const unsent = [...fu.unsent, ...send.filter((u) => u.staticReason).map((u) => ({ doc: u.doc, item_id: u.item_id, kind: u.kind, reason: u.staticReason }))]
  send = send.filter((u) => !u.staticReason)
  fs.rmSync(dir, { recursive: true, force: true })
  if (!send.length) {
    // 送る単位が 0 でも、送らなかった単位（unsent）は取り込みが無いので、ここで facts の unverified に残す（report が載せる）。
    const facts = readFacts(ws)
    if (unsent.length || facts.unverified.some((x) => x.unsent)) {
      fs.mkdirSync(formalPath(ws), { recursive: true })
      writeAtomic([formalPath(ws, 'facts.json'), `${JSON.stringify({ ...facts, unverified: withUnsent(facts.unverified, unsent, rid) }, null, 1)}\n`])
    }
    return { rid, goals: 0, units: 0, unsent, tree_digest: tree }
  }
  // 対象: 単位と依存と対応の行を持つ文書を逐語で写す（W の根を対象にすると checks/ などが集まりに入り、formal-method が「対象の変化」で止まる）。
  const target = path.join(dir, 'target')
  const lineRefs = send.flatMap((u) => [...u.lines.map((line) => ({ file: u.file, line })), ...u.refs, ...u.knowns.map((k) => ({ file: k.file, line: k.line }))])
  const files = sortBytes([...new Set(lineRefs.map((x) => x.file))])
  fs.mkdirSync(target, { recursive: true })
  for (const f of files) fs.copyFileSync(path.join(ws, f), path.join(target, f))
  const source = (file, line) => ({ target_id: FORMAL_TARGET, file, span: `L${line}-L${line}` })
  const goals = send.flatMap((u) => u.goals.map((g) => ({ id: g.goal_id, text: g.text, source: source(u.file, Math.min(...u.lines)) })))
  const known = []
  for (const u of send) {
    for (const k of u.knowns) {
      if (known.some((x) => x.text === k.text)) continue
      const n = known.filter((x) => x.id.startsWith(`K-${k.kind}-${u.item_id}-`)).length + 1
      known.push({ id: `K-${k.kind}-${u.item_id}-${n}`, text: k.text, source: source(k.file, k.line) })
    }
  }
  const locations = files.flatMap((file) => formalSpans(lineRefs.filter((x) => x.file === file).map((x) => x.line)).map((span) => ({ kind: 'location', target_id: FORMAL_TARGET, file, span })))
  const request = {
    targets: [{ id: FORMAL_TARGET, location: target, content_hash: formalCollectionHash(target) }],
    goals,
    known_requirements: known,
    scope: { include: [...goals.map((g) => ({ kind: 'goal', id: g.id })), ...known.map((k) => ({ kind: 'known_requirement', id: k.id })), ...locations], exclude: [] },
    time_limit_seconds: FORMAL_TIME_LIMIT_S,
  }
  const body = `${JSON.stringify(request, null, 1)}\n`
  const requestDigest = sha256Bytes(Buffer.from(body, 'utf8'))
  const requestFnv = fnv(body)
  const units = {
    rid, stage: String(opts.stage), phase: opts.phase, tree_digest: tree, request_digest: requestDigest, request_fnv: requestFnv,
    units: send.map((u) => ({ doc: u.doc, item_id: u.item_id, kind: u.kind, ...(u.quantity ? { quantity: u.quantity } : {}), unit_digest: u.unit_digest, deps: u.deps, lines: formalSpans(u.lines).map((span) => ({ file: u.file, span })), goals: u.goals.map((g) => ({ goal_id: g.goal_id, blocking: g.blocking })) })),
    unsent,
  }
  writeAtomic([path.join(dir, 'request.json'), body], [path.join(dir, 'units.json'), `${JSON.stringify(units, null, 1)}\n`])
  const cwd = `${ws}.formal`
  fs.mkdirSync(cwd, { recursive: true })
  return { rid, goals: goals.length, units: send.length, unsent, request_digest: requestDigest, request_fnv: requestFnv, tree_digest: tree, cwd }
}

// goalFacts: formal-method の結果（result/2）を、依頼の目標ごとの判定にする（結果の欄だけで決める。agent の申告は読まない）。
// 1. 性質を目標に結び付ける: goal の出所を持つ性質はその目標にだけ、goal の出所を 1 つも持たない性質だけを単位自身の行の span で結び付ける。
// 2. 原因が「対象が性質を満たさない」反例: goal の出所なら blocking で 反例・でなければ 重なり。span なら、重なった目標が全て blocking のときだけ 反例。
// 3. 反例の帰属: goal の id の単位（state は矢印の行のラベルの項目）→ location の行の入る単位 → 目標の単位の最初の行。
function goalFacts(units, result, targetText) {
  const ourGoals = new Map(units.flatMap((u) => u.goals.map((g) => [g.goal_id, { ...g, unit: u }])))
  const linesOf = (u) => u.lines.map((x) => ({ file: x.file, range: spanRange(x.span) })).filter((x) => x.range)
  const unitsAtLine = (file, n) => units.filter((u) => linesOf(u).some((x) => x.file === file && x.range[0] <= n && n <= x.range[1]))
  const overlaps = (u, file, r) => linesOf(u).some((x) => x.file === file && x.range[0] <= r[1] && r[0] <= x.range[1])
  const props = Array.isArray(result.properties) ? result.properties : []
  const cexs = Array.isArray(result.counterexamples) ? result.counterexamples : []
  const causes = Array.isArray(result.causes) ? result.causes : []
  const questions = Array.isArray(result.questions) ? result.questions : []
  const causeOf = (cx) => causes.find((c) => c && c.subject && c.subject.kind === 'counterexample' && c.subject.id === cx.id) || null
  const bind = new Map()
  const unbound = []
  const spanGoals = new Map()
  for (const p of props) {
    const srcs = Array.isArray(p.sources) ? p.sources : []
    const byGoal = srcs.filter((s) => s && s.kind === 'goal' && ourGoals.has(s.id)).map((s) => s.id)
    let goals = [...new Set(byGoal)]
    let mode = 'goal'
    if (!srcs.some((s) => s && s.kind === 'goal')) {
      mode = 'span'
      const locs = srcs.filter((s) => s && s.kind === 'location' && s.source).map((s) => ({ file: s.source.file, range: spanRange(s.source.span) })).filter((x) => x.range)
      goals = [...new Set(units.filter((u) => locs.some((l) => overlaps(u, l.file, l.range))).flatMap((u) => u.goals.map((g) => g.goal_id)))]
      spanGoals.set(p.id, goals)
    }
    if (!goals.length) unbound.push({ item: `目標に結び付かない性質: ${p.id}`, reason: String(p.reason || '') })
    for (const g of goals) bind.set(g, [...(bind.get(g) || []), { p, mode }])
  }
  const arrowItem = (u, cx) => {
    if (u.kind !== 'state') return null
    for (const s of (cx.sources || []).filter((x) => x && x.kind === 'location')) {
      const n = spanFrom(s.span)
      const text = (targetText(s.file) || '').split('\n')[n - 1] || ''
      const id = /-->/.test(text) ? (text.match(new RegExp(`\\((${ID_IN_TEXT.requirements.source}|${ID_IN_TEXT.specifications.source})\\)`)) || [])[1] : null
      if (id) return { doc: u.doc, item_id: id, line: n }
    }
    return null
  }
  const firstLine = (u) => Math.min(...linesOf(u).map((x) => x.range[0]))
  const locationOf = (goal, cx) => {
    const gid = (cx.sources || []).find((s) => s && s.kind === 'goal' && ourGoals.has(s.id))
    if (gid) {
      const u = ourGoals.get(gid.id).unit
      return arrowItem(u, cx) || { doc: u.doc, item_id: u.item_id, line: firstLine(u) }
    }
    for (const s of (cx.sources || []).filter((x) => x && x.kind === 'location')) {
      const n = spanFrom(s.span)
      const [u] = unitsAtLine(s.file, n)
      if (u) return arrowItem(u, cx) || { doc: u.doc, item_id: u.item_id, line: n }
    }
    return { doc: goal.unit.doc, item_id: goal.unit.item_id, line: firstLine(goal.unit) }
  }
  const out = new Map()
  for (const [gid, goal] of ourGoals) {
    const bound = bind.get(gid) || []
    const base = { goal_id: gid, blocking: goal.blocking, detection: null, witness: null, location: null, assurance: null, property_ids: bound.map((b) => b.p.id), cex_ids: [] }
    if (!bound.length) {
      out.set(gid, { ...base, verdict: '未検証', reason: '目標に対応する性質が無い' })
      continue
    }
    const found = bound.flatMap((b) => cexs.filter((cx) => cx && cx.property_id === b.p.id).map((cx) => ({ cx, b, cause: causeOf(cx) })))
    const target = found.filter((x) => x.cause && x.cause.cause === FORMAL_CAUSE)
    const cexIds = found.map((x) => x.cx.id)
    const witnessOf = (cx) => `${cx.input_and_trace ?? ''} / ${cx.violated_condition ?? ''}`
    if (target.length) {
      const byGoal = target.find((x) => x.b.mode === 'goal')
      const pick = byGoal || target[0]
      const allBlocking = byGoal ? true : (spanGoals.get(pick.b.p.id) || []).every((g) => ourGoals.get(g).blocking)
      const verdict = byGoal ? (goal.blocking ? '反例' : '重なり') : allBlocking ? '反例' : '未検証'
      out.set(gid, {
        ...base, cex_ids: cexIds, verdict, reason: verdict === '未検証' ? '目標に結び付かない反例（blocking でない目標の混ざる span で結び付いた）' : String(pick.b.p.reason || ''),
        witness: witnessOf(pick.cx), location: verdict === '未検証' ? null : locationOf(goal, pick.cx),
      })
      continue
    }
    if (found.length) {
      out.set(gid, { ...base, cex_ids: cexIds, verdict: '未検証', reason: `反例の原因が対象の欠陥でない: ${found.map((x) => `${x.cause ? x.cause.cause : '原因なし'}（${x.cause ? x.cause.grounds : ''}）`).join(' / ')}`, witness: witnessOf(found[0].cx) })
      continue
    }
    const verdicts = bound.map((b) => (Array.isArray(b.p.verdict) ? b.p.verdict : []))
    if (verdicts.every((v) => v.includes('検証済み'))) {
      const det = bound.map((b) => (b.p.detection && b.p.detection.status) || null)
      const a = bound.map((b) => b.p.assurance).find(Boolean)
      out.set(gid, { ...base, verdict: '検証済み', reason: bound.map((b) => String(b.p.reason || '')).join(' / '), detection: det.includes('検出能力未確認') ? '検出能力未確認' : det.find(Boolean) || null, assurance: a ? `${a.kind}${a.scope ? `（${a.scope}）` : ''}` : null })
      continue
    }
    const asked = bound.flatMap((b) => (Array.isArray(b.p.depends_on_questions) ? b.p.depends_on_questions : [])).map((id) => questions.find((q) => q && q.id === id)).filter(Boolean)
    out.set(gid, { ...base, verdict: '未検証', reason: [...bound.map((b) => `${b.p.id}: ${verdicts[bound.indexOf(b)].join('・')}（${b.p.reason ?? ''}）`), ...asked.map((q) => `問い ${q.id}: ${q.missing_decision}`)].join(' / ') })
  }
  return { goals: out, unbound }
}

const FORMAL_COUNT_KEYS = { verified: '検証済み', counterexample: '反例', overlap: '重なり', unverified: '未検証' }
function formalCounts(units) {
  const goals = units.flatMap((u) => u.goals)
  return {
    ...Object.fromEntries(Object.entries(FORMAL_COUNT_KEYS).map(([k, v]) => [k, goals.filter((g) => g.verdict === v).length])),
    undetected: goals.filter((g) => g.verdict === '検証済み' && g.detection === '検出能力未確認').length,
  }
}
// formalCexDocs: 反例の帰属の文書（ST-FORMAL-CEX- が出る文書。差し戻すのはその文書の writer）。location が無ければ目標の単位の文書。
const formalCexDocs = (units) => [...new Set(units.flatMap((u) => u.goals.filter((g) => g.verdict === '反例').map((g) => (g.location && g.location.doc) || u.doc)))].sort()

// formal-import: formal-method の run の領域（<W>.formal/.formal-method/runs/ の下）の結果を、DC が自分で読んで W に置く（司令塔の申告では決めない）。
// どの outcome でも exit 0 で終え、同じ rid の 2 回目は何も変えずに前の outcome を返す。使い方の誤りだけ exit 2。
function wsFormalImport(ws, opts) {
  const rid = formalRid(opts)
  if (!opts.runDir && !opts.unavailable) throw new UsageError('formal-import には --run-dir か --unavailable no_result が要ります')
  if (opts.unavailable && !FORMAL_UNAVAILABLE.includes(opts.unavailable)) throw new UsageError(`--unavailable は ${FORMAL_UNAVAILABLE.join(' / ')} です: ${opts.unavailable}`)
  const dir = formalPath(ws, rid)
  const units = readJsonFile(path.join(dir, 'units.json'))
  if (!units || !fs.existsSync(path.join(dir, 'request.json'))) throw new UsageError(`${rid} の依頼（fm/${rid}/request.json・units.json）がありません`)
  const facts = readFacts(ws)
  const done = readJsonFile(path.join(dir, 'outcome.json'))
  if (done) {
    const r = facts.requests.find((x) => x.rid === rid) || {}
    return { rid, outcome: done.outcome, counts: r.counts || formalCounts([]), cex_docs: r.cex_docs || [] }
  }
  let ours
  try {
    ours = JSON.parse(fs.readFileSync(path.join(dir, 'request.json'), 'utf8'))
  } catch (e) {
    throw new UsageError(`fm/${rid}/request.json を JSON として読めません（formal-request で作り直す）: ${e.message}`)
  }
  let outcome = 'no_result'
  let reason = 'formal-method が結果を作らずに終えた'
  let result = null
  let resultDigest = null
  const runDir = opts.runDir ? path.resolve(opts.runDir) : null
  if (runDir) {
    const real = (p) => {
      try {
        return fs.realpathSync(p)
      } catch {
        return null
      }
    }
    const base = real(path.join(`${ws}.formal`, '.formal-method', 'runs'))
    const at = real(runDir)
    const theirs = at ? readJsonFile(path.join(at, 'request.json')) : null
    const ids = (q) => canonicalJson(sortBytes(((q && q.goals) || []).map((g) => String(g && g.id))))
    if (!base || !at || !at.startsWith(`${base}${path.sep}`)) [outcome, reason] = ['rejected', `run_dir が ${ws}.formal/.formal-method/runs/ の下に無い: ${runDir}`]
    else if (!theirs || ((theirs.targets || [])[0] || {}).location !== ours.targets[0].location || ids(theirs) !== ids(ours)) [outcome, reason] = ['rejected', 'run_dir の依頼の対象か目標が、この rid の依頼と違う']
    else if (fs.existsSync(path.join(at, 'result.json'))) {
      const bytes = fs.readFileSync(path.join(at, 'result.json'))
      resultDigest = sha256Bytes(bytes)
      try {
        result = JSON.parse(bytes.toString('utf8'))
      } catch {
        result = null
      }
      const hash = result && result.verified_scope && Array.isArray(result.verified_scope.targets) && result.verified_scope.targets[0] && result.verified_scope.targets[0].content_hash
      if (!result || result.schema !== FORMAL_RESULT) [outcome, reason, result] = ['rejected', `result.json が ${FORMAL_RESULT} ではない`, null]
      else if (result.provisional !== false) [outcome, reason, result] = ['rejected', 'result.json が仮の結果（provisional）', null]
      else if (hash !== ours.targets[0].content_hash) [outcome, reason, result] = ['rejected', '結果の対象の指紋が依頼の content_hash と違う', null]
      else [outcome, reason] = ['result', '']
    } else [outcome, reason] = ['provisional', 'run_dir に result.json が無い（仮の結果）']
  }
  const targetText = (file) => {
    try {
      return fs.readFileSync(path.join(ours.targets[0].location, file), 'utf8')
    } catch {
      return null
    }
  }
  const judged = result ? goalFacts(units.units, result, targetText) : null
  const factUnits = units.units.map((u) => ({
    rid, doc: u.doc, item_id: u.item_id, kind: u.kind, ...(u.quantity ? { quantity: u.quantity } : {}), unit_digest: u.unit_digest, deps: u.deps, retry: !judged,
    goals: u.goals.map((g) => (judged ? judged.goals.get(g.goal_id) : { goal_id: g.goal_id, blocking: g.blocking, verdict: '未検証', detection: null, reason: `${outcome}（${reason}）`, witness: null, location: null, assurance: null, property_ids: [], cex_ids: [] })),
  }))
  const counts = formalCounts(factUnits)
  const cexDocs = formalCexDocs(factUnits)
  const stop = result && result.stop_report && Array.isArray(result.stop_report.reasons) ? result.stop_report.reasons.map((x) => `${x.code}: ${x.detail}`) : []
  const request = {
    rid, stage: units.stage, phase: units.phase, outcome, reason, run_dir: runDir, request_digest: units.request_digest, result_digest: resultDigest,
    status: result ? result.status ?? null : null, stop_reasons: stop,
    coverage_complete: result && result.verified_scope && result.verified_scope.extraction_coverage ? result.verified_scope.extraction_coverage.complete ?? null : null,
    decomposition_adopted: result && result.decomposition ? result.decomposition.adopted ?? null : null,
    counts, cex_docs: cexDocs,
  }
  const unverified = [
    ...(result && Array.isArray(result.unverified) ? result.unverified.map((x) => ({ rid, item: String(x.item ?? x.target ?? ''), reason: String(x.reason ?? '') })) : []),
    ...(judged ? judged.unbound.map((x) => ({ rid, ...x })) : []),
  ]
  const keep = new Set(factUnits.map(unitKey))
  const next = {
    schema: FORMAL_FACTS,
    requests: [...facts.requests.filter((x) => x.rid !== rid), request],
    units: [...facts.units.filter((u) => !keep.has(unitKey(u))), ...factUnits],
    unverified: withUnsent([...facts.unverified.filter((x) => x.rid !== rid || x.unsent), ...unverified], units.unsent || [], rid),
  }
  const outcomeBody = { rid, outcome, reason, run_dir: runDir, result_digest: resultDigest, request_digest: units.request_digest }
  writeAtomic([formalPath(ws, 'facts.json'), `${JSON.stringify(next, null, 1)}\n`], [path.join(dir, 'outcome.json'), `${JSON.stringify(outcomeBody, null, 1)}\n`])
  return { rid, outcome, counts, cex_docs: cexDocs }
}

// formal-status: 読むだけ。再開の入口の flow-check が実行し、script が state.formal と照らす（references/workflow-io.md §3）。
function wsFormalStatus(ws, opts) {
  const rid = formalRid(opts)
  const dir = formalPath(ws, rid)
  const units = readJsonFile(path.join(dir, 'units.json'))
  if (!units || !fs.existsSync(path.join(dir, 'request.json'))) throw new UsageError(`${rid} の依頼（fm/${rid}/request.json・units.json）がありません`)
  const bytes = fs.readFileSync(path.join(dir, 'request.json'))
  const done = readJsonFile(path.join(dir, 'outcome.json'))
  const r = done ? readFacts(ws).requests.find((x) => x.rid === rid) || {} : {}
  return {
    rid, fnv: fnv(bytes.toString('utf8')), units_digest_ok: units.request_digest === sha256Bytes(bytes), outcome: done ? done.outcome : null,
    tree_digest_request: units.tree_digest, tree_digest_now: digestOf(snapshotOf(workspaceDocs(ws))), counts: done ? r.counts || formalCounts([]) : null, cex_docs: done ? r.cex_docs || [] : [],
  }
}

// formal-off: 司令塔が formal: false で呼ぶ前に、形式検証を行わない理由を残す（report の節の最初に書く。結果の無い依頼 no_result と分ける）。
function wsFormalOff(ws, opts) {
  if (!FORMAL_OFF_REASONS.includes(opts.reason)) throw new UsageError(`--reason は ${FORMAL_OFF_REASONS.join(' / ')} です: ${opts.reason}`)
  fs.mkdirSync(formalPath(ws), { recursive: true })
  writeAtomic([formalPath(ws, FORMAL_OFF_FILE), `${JSON.stringify({ off: true, reason: opts.reason }, null, 1)}\n`])
  return { off: true, reason: opts.reason, path: `${FORMAL_DIR}/${FORMAL_OFF_FILE}` }
}

// formalFindings: facts の反例の目標を ST-FORMAL-CEX- の指摘にする。単位の digest が今の版と同じときだけ出す（書き換えれば消える）。
function formalFindings(ws, wsDocs) {
  const facts = readFacts(ws)
  const cex = facts.units.filter((u) => u.goals.some((g) => g.verdict === '反例'))
  if (!cex.length) return []
  const now = new Map(formalUnits(ws, wsDocs).units.map((u) => [unitKey(u), u.unit_digest]))
  const texts = new Map()
  const goalText = (rid, id) => {
    if (!texts.has(rid)) texts.set(rid, new Map(((readJsonFile(formalPath(ws, rid, 'request.json')) || {}).goals || []).map((g) => [g.id, g.text])))
    return texts.get(rid).get(id) || id
  }
  const byDoc = new Map(wsDocs.map((d) => [d.key, d]))
  const out = []
  for (const u of cex.filter((x) => now.get(unitKey(x)) === x.unit_digest)) {
    for (const g of u.goals.filter((x) => x.verdict === '反例')) {
      // 帰属の先は location の文書（別の文書の単位の行に帰属した反例は、その文書の指摘にし、その文書の行を quote にする）。
      const loc = { doc: u.doc, item_id: u.item_id, line: null, ...(g.location || {}) }
      const line = loc.line ? (String((byDoc.get(loc.doc) || {}).markdown || '').split('\n')[loc.line - 1] || '').trim() : ''
      out.push({ c: 'FORMAL_CEX', d: loc.doc, a: [g.goal_id, loc.item_id, line || loc.item_id, goalText(u.rid, g.goal_id), g.witness || '', u.deps.map((k) => k.slice(k.indexOf('#') + 1))] })
    }
  }
  return out
}

// formalReportLines: report.md の「## 形式検証」の節。依頼ごとの outcome、目標ごとの判定、重なり、未検証、今の版で事実の無い単位を載せる。
// offReason: report の --formal-off（script の返り値の formal_off。司令塔が formal-off を実行しなかった W でも書く）。
function formalReportLines(ws, offReason) {
  const off = offReason ? { reason: offReason } : readJsonFile(formalPath(ws, FORMAL_OFF_FILE))
  const facts = readFacts(ws)
  const lines = ['', '## 形式検証', '']
  if (off) lines.push(`形式検証は行わなかった（${off.reason}）。`, '')
  // 送らなかった式は facts の写しに頼らず、report のときの今の文書から求め直す（formal-request を走らせない段の後に足された式も載せる）。
  const current = off || !fs.existsSync(formalPath(ws, 'facts.json')) ? null : formalUnits(ws, workspaceDocs(ws))
  const left = [
    ...facts.unverified.filter((x) => !(current && x.unsent)).map((x) => `- ${x.item}: ${x.reason}（${x.rid}）`),
    ...(current ? withUnsent([], current.unsent, '今の版').map((x) => `- ${x.item}: ${x.reason}（${x.rid}）`) : []),
  ]
  const unverifiedLines = () => ['', '### 未検証として残したもの', '', ...(left.length ? left : ['0 件。'])]
  if (!facts.requests.length) {
    if (!off && !left.length) lines.push('0 件（形式検証の依頼は無い）。', '')
    if (left.length) lines.push('形式検証の依頼は無い（送る単位が 0）。', ...unverifiedLines(), '')
    return lines
  }
  lines.push('### 依頼', '')
  for (const r of facts.requests) lines.push(`- ${r.rid}（段 ${r.stage}・依頼 ${r.phase}）: ${r.outcome}${r.reason ? `（${r.reason}）` : ''}。状態: ${r.status ?? '—'}。停止の理由: ${r.stop_reasons.length ? r.stop_reasons.join(' / ') : 'なし'}`)
  lines.push('', '### 目標ごとの判定', '', '未検証の目標を、検証済みと述べない。', '')
  for (const u of facts.units) {
    for (const g of u.goals) {
      const extra = [g.witness ? `反例: ${g.witness}` : '', g.assurance ? `保証: ${g.assurance}` : '', g.detection ? `検出: ${g.detection}` : ''].filter(Boolean).join('。')
      lines.push(`- ${g.goal_id}（${u.doc} ${u.item_id}・${u.kind}・${u.rid}）: ${g.verdict}${g.reason ? `（${g.reason}）` : ''}${extra ? `。${extra}` : ''}`)
    }
  }
  const overlaps = facts.units.flatMap((u) => u.goals.filter((g) => g.verdict === '重なり').map((g) => `- ${g.goal_id}（${u.doc} ${u.item_id}）: ${g.witness || ''}`))
  lines.push('', '### 重なり（意味で判定する）', '', ...(overlaps.length ? overlaps : ['0 件。']))
  lines.push(...unverifiedLines())
  const had = new Map(facts.units.map((u) => [unitKey(u), u.unit_digest]))
  const missing = (current || formalUnits(ws, workspaceDocs(ws))).units.filter((u) => had.get(unitKey(u)) !== u.unit_digest)
  lines.push('', '### 今の版で事実の無い単位', '', ...(missing.length ? missing.map((u) => `- ${u.item_id}（${u.doc}・${u.kind}）`) : ['0 件。']), '')
  return lines
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
    else if (a === '--findings') o.findings = take().split(',').map((s) => s.trim()).filter(Boolean)
    else if (a === '--check') o.check = true
    else if (a === '--rulings') o.rulings = true
    else if (a === '--lint') o.lint = true
    else if (a === '--token') o.token = take()
    else if (a === '--source') o.source = take()
    else if (a === '--fixed') o.fixed = take().split(',').map((s) => s.trim()).filter(Boolean)
    else if (a === '--file') o.file = take()
    else if (a === '--input') o.input = take()
    else if (a === '--sweep') o.sweep = true
    else if (a === '--keep') o.keep = take().split(',').map((s) => s.trim()).filter(Boolean)
    else if (a === '--rid') o.rid = take()
    else if (a === '--stage') o.stage = take()
    else if (a === '--phase') o.phase = take()
    else if (a === '--run-dir') o.runDir = take()
    else if (a === '--unavailable') o.unavailable = take()
    else if (a === '--reason') o.reason = take()
    else if (a === '--formal-off') o.formalOff = take()
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
  if (mode === 'place') return wsPlace(ws, opts)
  if (mode === 'questions') return wsQuestions(ws, opts)
  if (mode === 'answers') return wsAnswers(ws, opts)
  if (mode === 'sha') return wsSha(ws, opts)
  if (mode === 'report') return wsReport(ws, opts)
  if (mode === 'quotes') return wsQuotes(ws, opts)
  if (mode === 'get') return wsGet(ws, opts)
  if (mode === 'view') return wsView(ws, opts)
  if (mode === 'formal-model') return wsFormalModel(ws, opts)
  if (mode === 'formal-request') return wsFormalRequest(ws, opts)
  if (mode === 'formal-import') return wsFormalImport(ws, opts)
  if (mode === 'formal-status') return wsFormalStatus(ws, opts)
  if (mode === 'formal-off') return wsFormalOff(ws, opts)
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
  // 失敗は非ゼロで終える。--expect の不一致だけは 3 に、formal-* の使い方の誤り（UsageError）は 2 にして、壊れた入力（1）と区別できるようにする。
  const mode = process.argv[2]
  try {
    const out = runWorkspace(mode, process.argv.slice(3))
    process.stdout.write(typeof out === 'string' ? out : `${JSON.stringify(stampStdout(out))}\n`)
  } catch (e) {
    process.stderr.write(`doc_check ${mode}: ${e && e.message ? e.message : e}\n`)
    process.exit(e instanceof DigestMismatch ? 3 : e instanceof UsageError ? 2 : 1)
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
  carryShapeOk,
  carryPathOf,
  CARRY_SUFFIX,
  wsFormalModel,
}
