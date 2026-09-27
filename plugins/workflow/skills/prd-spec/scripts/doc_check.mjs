// doc_check: 文書の本文に依存する決定的な検査を、Workflow script の外で実行する CLI。
//
// Workflow script はファイルを読めない。本文を script の手元に置くには writer に全文を返させる
// しかなく、それが改稿のたびに文書全体を Write と返り値で 2 度出力させる原因だった（実測:
// 6 文書・333〜1002 行の run で writer が cache read の約 45% を消費）。本文を読む検査を
// ここへ置き、agent にこの CLI を実行させて件数と digest だけを受け取る。
//
// 使い方は 2 つある。
// - node doc_check.mjs <input.json>（相対パスは実行時のカレントディレクトリ基準）。入出力の契約は
//   fixture テストが移設前の結果との一致を確かめる形として残している。
// - node doc_check.mjs <mode> --workspace <W> [...]。workspace を直接読むモード。mode は
//   WS_MODES のどれか（references/workflow-io.md §6）。結果は W/checks/ に書き、stdout には
//   件数・digest・書いたパスだけを出す（下の「workspace モード」の節）。

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

// newlineCount: `wc -l` と同じ数え方（改行の数）。writer が返す line_count との照合に使う。
function newlineCount(md) {
  return (String(md || '').match(/\n/g) || []).length
}

// lineTotal: offset/limit の範囲計算に使う行数（末尾に改行が無い最終行も 1 行と数える）。
function lineTotal(md) {
  const s = String(md || '')
  if (!s) return 0
  return newlineCount(s) + (s.endsWith('\n') ? 0 : 1)
}

// changedLineRanges: 前稿と改稿の差分を、見出し（## / ### / ####）で区切った節の単位で返す。
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

// ------------------------------------------------------- 構造検査の文面
//
// CLI は指摘を { c: 種別, d: 文書キー, a: 引数 } の短い形で出し、文面（id / location / quote /
// severity / issue / fix）はこの表から組み立てる。agent は CLI の出力を書き写して返すので、指摘ごとに同じ説明文を載せると出力が数百 KB に膨らみ、写すトークンと写し間違いの
// 機会がそのまま増える（実測: 実 run の下書きで 311〜415 KB）。
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
    fix: 'flow-framer の出力を、その契約（schemas/agent-contracts.md の flow-framer 節）の形に直して渡し直す（文書の改稿では直らない）。',
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

// expandStructural: 短い形の { findings, not_checked } を文面付きの形に戻す。短い形の findings は
// 「同じ種別・同じ文書が続く指摘」を 1 要素にまとめた { c, d, a: [引数の組, ...] } の列で、
// 展開すると引数の組 1 つが指摘 1 件になる（順序は CLI が検出した順のまま）。文面付きの各要素は
// { auditor: 'structural', id, document, location, quote, severity?, issue, fix }、not_checked は
// { id, issue }。未知の種別は例外にする（黙って落とすと、指摘が「0 件」に化ける）。
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

// ------------------------------------------------------- 工程の流れ（flow）の形と閉包
//
// flow は flow-framer が初稿の前に描く PFD で、各項目を当てる軸になる（契約は
// schemas/agent-contracts.md の flow-framer 節）。軸が閉じていなければ「どの工程にも項目が当たっている」
// は何も保証しないので、形と閉包は算術で押さえる。prd.js は flow モードの stdout の指摘が 0 件でない flow では
// 書き始めない（writer には flow を直す手段が無く、改稿枠を空回りさせるだけになる）。
function flowGraphCompact(flow) {
  const FLOW_TYPES = ['input', 'step', 'decision', 'output']
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

// ------------------------------------------------------- 状態 × イベント表と判定表の検査
//
// 状態機械と判定規則は、項目ごとの散文で書くと「同じ入力に 2 つの行き先」「分岐の値に行き先が無い」
// 「条件が重なる」を読み手が照合するしかなく、実 run では依頼者への質問に化けて依頼者に届いた
// （6 文書で 12 問。ほぼ全件が文書内の不整合だった）。表の形を document-structure.md §6 / §2.8 に
// 固定し、網羅・一意・到達を算術で検査する。機械的に読めない表は検査しない（偽陽性は改稿枠を空回りさせる）。

const cellsOf = (line) => {
  const t = line.trim()
  if (!t.startsWith('|')) return null
  return t.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
}
const isSeparator = (cells) => cells && cells.length && cells.every((c) => /^:?-{2,}:?$/.test(c))
const splitAxis = (s) => String(s).split(/\s+\/\s+/).map((x) => x.trim()).filter(Boolean)
const BLANK_CELL = /^(—|-|–|―|なし)?$/

// sectionsOf2: `## ` 見出しで区切った節（コードフェンスの中は見出しとして扱わない）。
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

// tablesOf: 節の中のパイプ表（見出し行 + 区切り行 + 本体）。行番号は文書全体の 1 始まり。
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

// namesIn: 文字列に現れる状態名（長い名前から照合し、照合済みの箇所は二重に数えない）。
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
  // cells: (状態, イベント) → { targets: Set, noop, open, from: 'table' }。図の辺でイベントに当たるものは別に持つ。
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
  // 図の辺のうち、ラベルが軸のイベント（記号か名前）で始まるものを (状態, イベント) の遷移として読む。
  // それ以外の辺はイベントでない条件による主フローであり、表とは突き合わせない。
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

// 判定表: 見出しに「条件: 名前」の列が 1 つ以上と「結果」の列を持つ表（document-structure.md §2.8）。
// 各条件の値の集合は「> 条件の値: 名前 = a / b」の宣言、無ければ列に現れた値から取る。
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

// tableFindings: 判定表の網羅と一意の算術。文書の判定表と flow の decision の両方がこれを呼ぶ（展開の実装を 1 つに保つ）。
// conds は [{name, values}]（values が null なら行に現れた値から取る）、rows は「上記以外」を除いた [{no, vals, res}]。
// 戻り値は検出の順に並んだ { kind: value | too_many | gap | overlap, … } の列。
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

// formalCompact: 文書ごとの状態機械・判定表の検査と、flow への項目の当たり方の検査。
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

// ------------------------------------------------------- 構造検査
//
// 正本はこのファイルだけである。Workflow script は複製を持たず、agent にこの CLI を実行させる
// （以前は 2 つの script に逐語で複製しており、片方だけ直すと判定が食い違った）。
//
// docs は [{ key, kind, topic, markdown, ids, referenced, traceability, fixed }] の正規化済み配列。
// 戻り値は { findings, not_checked }。not_checked は「材料が無くて実行できなかった検査」で、
// 失格ではない。これを返さないと、片側の文書が対象外のランで「検査して 0 件」と
// 「そもそも検査していない」が区別できず、後者が合格として提示される。
function structuralCompact(docs, flow) {
  const out = []
  const notChecked = []
  const reqDocs = docs.filter((d) => d.kind === 'requirements')
  const specDocs = docs.filter((d) => d.kind === 'specifications')
  // 申告済み TBD の全体集合。固定文書の申告も数える（その TBD は実在するため）。
  const tbdDeclaredAll = new Set(
    docs.flatMap((d) => (d.tbd_items || []).map((t) => t && t.id).filter(Boolean))
  )

  // (1) 文書を跨いだ ID の重複。複数文書化で新たに必要になった検査。同じ ID を 2 文書が
  //     定義すると、トレーサビリティ表がどちらを指すか決まらず、紐付け自体が意味を失う。
  const owners = new Map()
  for (const d of docs) {
    for (const id of d.ids) {
      if (!owners.has(id)) owners.set(id, [])
      if (!owners.get(id).includes(d.key)) owners.get(id).push(d.key)
    }
  }
  for (const [id, keys] of owners) {
    if (keys.length < 2) continue
    out.push({ c: 'DUP', d: keys[0], a: [id, keys] })
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
    out.push({ c: 'DUP_TBD', d: recs[0].key, a: [id, recs.map((r) => r.key), recs[0].text, recs[1].text] })
  }

  // (2) 片側にしか現れない ID。requirements の ID 集合 / specifications の ID 集合 /
  //     トレーサビリティ表の 3 集合を**文書を跨いで**照合する。ここがこのスキルの背骨。
  if (!reqDocs.length || !specDocs.length) {
    notChecked.push({ c: 'NC_CROSSREF', a: [!reqDocs.length ? 'requirements' : 'specifications'] })
  }
  if (reqDocs.length && specDocs.length) {
    const reqIds = new Set(reqDocs.flatMap((d) => d.ids))
    const specIds = new Set(specDocs.flatMap((d) => d.ids))
    const links = specDocs.flatMap((d) => (d.traceability || []).map((l) => ({ ...l, from: d.key })))
    const linkedReq = new Set(links.map((l) => l.requirement_id).filter(Boolean))
    const linkedSpec = new Set(links.map((l) => l.spec_id).filter(Boolean))

    for (const id of reqIds) {
      if (linkedReq.has(id)) continue
      const owner = (owners.get(id) || ['requirements'])[0]
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

    // (3) 申告された ID 一覧と、本文に実在する ID の突き合わせ。(2) の集合差分は agent の
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
    // 隠すため。この認識が無いと、欠番宣言を持つ文書で ST-UNDECLARED が毎 run 再発する
    // （実測: 同一文書の review 3 run で同じ 6 件が再起票され、終端裁定が毎回同じ棄却を
    // 繰り返した。棄却は run を跨いで持ち越されないため、検査側で認識しない限り止まらない）。
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
      // すべて「申告漏れ」に化け、writer が直せない指摘を抱えて改稿枠を空回りさせる
      // （実測: 6 文書の初稿で 15 件の誤検出）。守りたいのは「どの文書にも申告されていない
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

// structuralFindings: 文面付きの形で返す版（tests と、文面を直接見たい呼び出し側のため）。
// CLI の出力は structuralCompact の短い形で、文面は受け取った側が expandStructural で組み立てる。
function structuralFindings(docs, flow) {
  return expandStructural(structuralCompact(docs, flow))
}

// headingIndex: 見出し（## / ### / ####。コードフェンスの中は除く）ごとの行範囲。範囲は次の同格以上の
// 見出しの手前まで（## はその下の ### / #### を含む）。行番号は 1 始まり。
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

// writeIndex: 見出しと行範囲の一覧を index_dir に書き、そのパスと行数を返す。監査役・writer は
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

// runChecks: 入力の各文書をファイルから読み、構造検査・行数・変更範囲を返す。
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
  // index_extra: 検査対象ではないが索引だけが要るファイル（run の外の標本文書など）。
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

// ======================================================= workspace モード
//
// 文書は W/<kind>-<topic>.md の 1 本だけを持ち、writer が Edit で直接更新する。項目 ID と参照 ID は
// 本文から導出し、本文から取れない trace と TBD の候補だけを W/<kind>-<topic>.meta.json に置く（本文と
// meta に同じ ID を二重に持つと、Edit のたびに両方を直すことになり、ずれを検査で拾う手間が増える）。
// Workflow script はファイルを読めないので、このモードは起動済みの agent が実行し、結果は W/checks/ の
// ファイルと stdout の digest で受け渡す。stdout に指摘の文面を出さないのは、agent に書き写させると
// 写すトークンと写し間違いの機会がそのまま増えるため。
//
// meta.json: { "trace": [{ "item_id", "kind", "ref"? }], "tbd": [{ "id", "text", "blocking" }], "fixed"? }
// - kind が "flow" の trace は、その項目を flow の要素 ref に当てた申告として扱う。
// - fixed: true の文書（expand の要求文書など）は ID の定義元として数えるが、書き手の欠陥は検査しない。
// flow.json の各要素の source: { "input": "依頼文の引用" } / { "decision": "D-001" } / { "open": "O-001" }
// のどれか 1 つ（複数なら配列）。引用が依頼文に実在するかは put が書く前に照合する（flow モードは形と ID の実在だけ）。

// WORKSPACE_TEXT_BEGIN
const WORKSPACE_TEXT = {
  FLOW_NOSOURCE: (id) => ({
    id: `ST-FLOW-NOSOURCE-${id}`,
    location: '工程の流れ（flow）',
    quote: id,
    issue: `流れの要素 ${id} に出典（source）が無い。flow は項目を当てる原本になるので、出典の無い要素は根拠の無い記述のまま文書に流れ込む。`,
    fix: `${id} に source として依頼文の引用（input）・決定の ID（decision）・未決の ID（open）のどれかを付ける。どれも付けられないなら依頼から辿れない要素なので、外すか open に起票する。`,
  }),
  FLOW_SOURCE_SHAPE: (id) => ({
    id: `ST-FLOW-SOURCE-SHAPE-${id}`,
    location: '工程の流れ（flow）',
    quote: id,
    issue: `流れの要素 ${id} の source が { input } / { decision } / { open } のどれか 1 つの形になっていない。形が決まらないと、出典が実在するかを照合できない。`,
    fix: 'source を { "input": "引用" } / { "decision": "D-…" } / { "open": "…" } のどれかにする（複数あるなら配列にする）。',
  }),
  FLOW_SOURCE_UNKNOWN: (id, kind, ref) => ({
    id: `ST-FLOW-SOURCE-UNKNOWN-${id}-${ref}`,
    location: '工程の流れ（flow）',
    quote: `${id}: ${kind} ${ref}`,
    issue: `流れの要素 ${id} が出典に挙げた ${ref} が ${kind === 'decision' ? `${ledgerOf('decisions').file()} にも ${ledgerOf('resolutions').file()} にも` : `${ledgerOf('open').file()} に`}無い。実在しない出典は、出典が無いのと同じである。`,
    fix: `${ref} を実在する ID に直すか、出典を付け直す。`,
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
    fix: 'その組み合わせの case を出典付きで足す。根拠から決まらないなら open に起票し、その ID を case の出典にする。',
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

const WS_MODES = ['flow', 'conflicts', 'doc', 'snapshot', 'diff', 'tree-digest', 'index', 'put', 'del', 'questions', 'sha', 'report']
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
// fields は要素が持てる欄の閉集合（型の外の欄は put が拒否する）。cases は、by が返す行ごとに must（持つ）・
// never（持てない）欄を宣言する。欄単位のマージでは型や ruling を変えても古い欄が残るので、残りを構造で止める。
const OTHER_RULING = { never: ['question', 'options', 'answer', 'hold'] }
const LEDGERS = {
  decisions: {
    file: () => 'decisions.json',
    lists: { decisions: 'id' },
    scalars: {},
    fields: { decisions: ['id', 'topic', 'value', 'why', 'source', 'quote', 'ref', 'layer', 'targets', 'reversibility'] },
  },
  open: { file: () => 'open.json', lists: { open: 'id' }, scalars: {}, fields: { open: ['id', 'text', 'searched', 'by', 'targets'] } },
  resolutions: {
    file: () => 'resolutions.json',
    lists: { resolutions: 'id' },
    scalars: {},
    fields: {
      resolutions: ['id', 'about', 'ruling', 'value', 'why', 'evidence', 'supersedes', 'layer', 'targets', 'question', 'options', 'answer', 'hold', 'upstream_revision'],
    },
    cases: {
      resolutions: {
        by: (r) => (r.ruling === undefined ? '（ruling なし）' : r.ruling === 'question' ? `question（answer ${r.answer === undefined ? 'なし' : 'あり'}）` : r.ruling),
        rows: {
          'question（answer なし）': { must: ['question', 'options'], never: ['answer', 'value', 'hold'] },
          'question（answer あり）': { must: ['question', 'options'], never: ['hold'] },
          hold: { must: ['hold'], never: ['question', 'options', 'answer', 'value'] },
          precedent: OTHER_RULING,
          internal: OTHER_RULING,
          measured: OTHER_RULING,
          method: OTHER_RULING,
          '（ruling なし）': OTHER_RULING,
        },
      },
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
        rows: { fail: {}, pass: { never: ['fail_kind'] }, '（verdict なし）': { never: ['fail_kind'] } },
      },
    },
  },
  routes: { file: () => 'routes.json', lists: { routes: 'id' }, scalars: {}, fields: { routes: ['id', 'unit', 'doc', 'item_id', 'resolutions'] } },
  flow: {
    file: () => 'flow.json',
    lists: { elements: 'id', kinds: 'name' },
    scalars: { closure: 'string' },
    fields: { elements: ['id', 'type', 'kind', 'label', 'next', 'source', 'branches', 'inputs', 'cases'], kinds: ['name', 'definition'] },
    cases: {
      elements: {
        by: (el) => (el.type === 'decision' ? 'decision' : 'decision 以外'),
        rows: { decision: { never: ['next'] }, 'decision 以外': { never: ['branches', 'inputs', 'cases'] } },
      },
    },
  },
  meta: {
    file: (doc) => {
      const m = /^(requirements|specifications)\/([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(String(doc || ''))
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
const HISTORY_MARKS = [/段 ?\d/, /(?<![A-Za-z0-9])G0-2(?![A-Za-z0-9])/, /(?<![A-Za-z0-9])r\d+-(im|gr|cd)-/, /回答の反映/]

// SIZE_BUDGET: ファイルのバイト数の目安（合否ではない）。仮の値として 2026-09-27 の cleanup-branches の試走の台帳を
// 正規形に直した実測を置いた。段 3・5 が意図して生成物を太らせるので、試走し直した実測で決め直す。
const SIZE_BUDGET = { resolutions: 64241, meta: 25654, document: 23378, flow: 20734, verifications: 19165, decisions: 6887, open: 5029, routes: 655 }

class LedgerRejected extends Error {}

const sortDeep = (v) =>
  Array.isArray(v) ? v.map(sortDeep) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep(v[k])])) : v
const ledgerText = (value) => `${JSON.stringify(sortDeep(value), null, 1)}\n`
const sha256Bytes = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

function ledgerOf(name) {
  if (!Object.hasOwn(LEDGERS, name)) throw new Error(`--ledger は ${Object.keys(LEDGERS).join(' / ')} のどれかです: ${name}`)
  return LEDGERS[name]
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
      }
    } else if (k in spec.scalars) {
      if (!(input && value[k] === null) && typeof value[k] !== spec.scalars[k]) throw new Error(`${file} の ${k} が ${spec.scalars[k]} ではありません`)
    } else throw new Error(`${file} に台帳 ${name} の欄ではない ${k} があります（欄は ${[...Object.keys(spec.lists), ...Object.keys(spec.scalars)].join(' / ')}）`)
  }
}

// readLedger: 無いファイルは null。put が書く正規形と 1 バイトでも違えば、put 以外で書かれたものとして止める
// （Write や自作の script による全体の書き戻しを、読む側で構造的に検出するため）。
function readLedger(ws, name, doc) {
  const file = ledgerOf(name).file(doc)
  const value = readJsonFile(path.join(ws, file))
  if (value === null) return null
  checkShape(name, value, file)
  if (fs.readFileSync(path.join(ws, file), 'utf8') !== ledgerText(value)) {
    throw new Error(`${file} が正規形ではありません。台帳は doc_check put / del 以外で書かないでください`)
  }
  return value
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

// fieldRejects: 送られた欄だけを見る（型の外の欄・経緯の印）。null は欄を消す指示なので型の中なら通す。
function fieldRejects(name, body) {
  const spec = ledgerOf(name)
  const bad = []
  for (const [list, key] of Object.entries(spec.lists)) {
    const allowed = spec.fields[list]
    for (const el of body[list] || []) {
      for (const [k, v] of Object.entries(el)) {
        const where = `${list} ${el[key]} の ${k}`
        if (!allowed.includes(k)) bad.push(`${where}: 台帳 ${name} の ${list} の欄ではありません（欄は ${allowed.join(' / ')}）`)
        else bad.push(...proseRejects(where, `${name}.${list}.${k}`, v))
      }
    }
  }
  for (const k of Object.keys(spec.scalars)) if (k in body) bad.push(...proseRejects(k, `${name}.${k}`, body[k]))
  return bad
}

// caseRejects: マージした後の要素のうち、この put が触れたものを欄の条件で見る。
function caseRejects(name, next, body) {
  const spec = ledgerOf(name)
  const bad = []
  for (const [list, c] of Object.entries(spec.cases || {})) {
    const key = spec.lists[list]
    const touched = new Set((body[list] || []).map((el) => el[key]))
    for (const el of next[list].filter((x) => touched.has(x[key]))) {
      const row = c.by(el)
      const rule = Object.hasOwn(c.rows, row) ? c.rows[row] : null
      if (!rule) {
        bad.push(`${list} ${el[key]}: ${row} は ${Object.keys(c.rows).join(' / ')} のどれでもありません`)
        continue
      }
      const extra = (rule.never || []).filter((k) => k in el)
      const lack = (rule.must || []).filter((k) => !(k in el))
      if (extra.length) bad.push(`${list} ${el[key]}: ${row} では ${extra.join('・')} を持てません。消すには、その欄に null を送ってください`)
      if (lack.length) bad.push(`${list} ${el[key]}: ${row} では ${lack.join('・')} が要ります`)
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

// mergeElement: 送った最上位の欄だけを上書きし、null の欄は消す。送らなかった欄は残るので、欄を消すには null が要る。
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
  const asked = new Set(listOf(body, itemsOf).map((it) => it[itemKey]))
  const items = next[itemsOf].map((it) => {
    if (!asked.has(it[itemKey]) || !/^F-/.test(it[itemKey])) return it
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

// put: 標準入力の { <配列名>: [要素], <スカラー名>: 値 } をキー単位で足し・置き換える。検査はすべて書く前に
// 済ませ、1 件でも落ちたらファイルに触れない。
function wsPut(ws, opts, stdin) {
  const name = opts.ledger
  const spec = ledgerOf(name)
  const file = spec.file(opts.doc.length === 1 ? opts.doc[0] : opts.doc.join(','))
  let body
  try {
    body = JSON.parse(stdin)
  } catch (e) {
    throw new LedgerRejected(`標準入力を JSON として読めません: ${e.message}`)
  }
  if (body && typeof body === 'object' && !Array.isArray(body)) for (const k of spec.filled || []) delete body[k]
  checkShape(name, body, '標準入力', true)
  const shapeBad = fieldRejects(name, body)
  if (shapeBad.length) throw new LedgerRejected(`欄の検査に落ちました（何も書いていません）:\n${shapeBad.join('\n')}`)
  const bad = verbatimRejects(ws, name, body)
  if (bad.length) throw new LedgerRejected(`逐語の照合に落ちました（何も書いていません）:\n${bad.join('\n')}`)
  const cur = readLedger(ws, name, opts.doc[0]) || emptyLedger(spec)
  let next = { ...emptyLedger(spec), ...cur }
  const tally = { added: [], replaced: [], unchanged: [], removed: [] }
  for (const [k, key] of Object.entries(spec.lists)) {
    if (body[k]) next[k] = mergeList(next[k], body[k], key, (spec.groupBy || []).includes(k), tally)
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
  const caseBad = caseRejects(name, next, body)
  if (caseBad.length) throw new LedgerRejected(`欄の条件に落ちました（何も書いていません）:\n${caseBad.join('\n')}`)
  if (name === 'verifications') next = fillVerifications(ws, opts, next, body)
  const text = ledgerText(next)
  const p = path.join(ws, file)
  if (!fs.existsSync(p) || fs.readFileSync(p, 'utf8') !== text) writeAtomic([p, text])
  return ledgerResult(name, file, tally, next, ws, opts.doc[0])
}

function wsDel(ws, opts) {
  const name = opts.ledger
  const spec = ledgerOf(name)
  const file = spec.file(opts.doc.length === 1 ? opts.doc[0] : opts.doc.join(','))
  const lists = Object.keys(spec.lists)
  const coll = opts.collection || (lists.length === 1 ? lists[0] : null)
  if (!coll) throw new LedgerRejected(`台帳 ${name} は配列が複数あるので --collection <${lists.join('|')}> が要ります`)
  if (!lists.includes(coll)) throw new LedgerRejected(`--collection は ${lists.join(' / ')} のどれかです: ${coll}`)
  if (!opts.ids || !opts.ids.length) throw new LedgerRejected('del には --ids a,b が要ります')
  const cur = readLedger(ws, name, opts.doc[0])
  const tally = { added: [], replaced: [], unchanged: [], removed: [] }
  const key = spec.lists[coll]
  const ids = [...new Set(opts.ids)]
  for (const id of ids) tally[cur && cur[coll].some((r) => r[key] === id) ? 'removed' : 'unchanged'].push(id)
  if (!cur || !tally.removed.length) return ledgerResult(name, file, tally, cur, ws, opts.doc[0])
  const next = { ...cur, [coll]: cur[coll].filter((r) => !tally.removed.includes(r[key])) }
  writeAtomic([path.join(ws, file), ledgerText(next)])
  return ledgerResult(name, file, tally, next, ws, opts.doc[0])
}

const QUESTION_OPTIONS = { min: 2, max: 4 }

// questions: 問いの文面の正本は resolutions.json の question・options だけにし、依頼者に見せる 2 つの形は
// ここで導出する（手で書くと写しが増え、片方だけ直されて食い違う）。--check は同じ検査だけを行い、何も書かない
// （問いを出した resolver が返る前に確かめる。導出はゲートの時点で pending の全件に対して司令塔が行う）。
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
    if (!r) bad.push(`${id}: ${ledgerOf('resolutions').file()} にありません`)
    else if (!q || typeof q.header !== 'string' || typeof q.text !== 'string' || typeof q.searched !== 'string') bad.push(`${id}: question { header, text, searched } がありません`)
    else if (options.length < QUESTION_OPTIONS.min || options.length > QUESTION_OPTIONS.max) bad.push(`${id}: 候補が ${options.length} 個です（${QUESTION_OPTIONS.min}〜${QUESTION_OPTIONS.max} 個）`)
    else if (options.some((o) => !o || typeof o.label !== 'string' || typeof o.description !== 'string' || typeof o.flow_effect !== 'string')) bad.push(`${id}: 候補に label・description・flow_effect の無いものがあります`)
    else qs.push({ id, q, options })
  }
  if (opts.check) {
    if (bad.length) process.stderr.write(`${bad.join('\n')}\n`)
    return { check: true, ids: [...new Set(opts.ids)], questions: qs.length, findings: bad.length, bad_ids: bad.map((b) => b.split(':')[0]) }
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

// report: 事後報告は resolutions.json の method・hold・upstream_revision から導出する。手で書くと、同じ事実を
// resolutions と 2 か所に持ち、型も決まらない。
function wsReport(ws) {
  const [listName] = Object.keys(ledgerOf('resolutions').lists)
  const rs = listOf(readLedger(ws, 'resolutions'), listName)
  const method = rs.filter((r) => r.ruling === 'method')
  const holds = rs.filter((r) => r.ruling === 'hold')
  const upstream = rs.filter((r) => r.upstream_revision != null)
  const block = (label, text) => {
    const fence = fenceOf(text)
    return [`**${label}**:`, '', `${fence}markdown`, String(text ?? ''), fence, '']
  }
  const md = [
    '# 事後報告',
    '',
    '## 方法論として決めたこと',
    '',
    ...(method.length ? method.map((r) => `- ${r.id}: ${r.value ?? ''}（${r.why ?? ''}）`) : ['0 件。']),
    '',
    '## 保持規則と Issue の文案',
    '',
    ...(holds.length ? [] : ['0 件。', '']),
    ...holds.flatMap((r) => {
      const h = r.hold || {}
      return [`### ${r.id}`, '', `**保持規則**: ${h.rule ?? ''}`, '', `**触れる項目**: ${(Array.isArray(h.item_ids) ? h.item_ids : []).join('、') || '（なし）'}`, '', ...block('Issue の文案', h.issue_draft)]
    }),
    '## 上位文書の改訂の文案',
    '',
    ...(upstream.length ? [] : ['0 件。', '']),
    ...upstream.flatMap((r) => [`### ${r.id}`, '', ...block('改訂の文案', r.upstream_revision)]),
  ].join('\n')
  writeAtomic([path.join(ws, 'report.md'), md])
  return { path: 'report.md', method: method.length, holds: holds.length, upstream_revisions: upstream.length, sha256: sha256Bytes(Buffer.from(md)) }
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

// itemSections: 見出し（# 〜 ######。コードフェンスの中は除く）ごとの区間。見出しに自文書の種別の ID を
// 持つ区間はその ID を key にし、持たない区間は「§見出し」を key にする（同じ key が続けば #2, #3）。
// 区間の text は末尾の空白行を落とす（項目の間の空行の出し入れを変更と数えないため）。
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

// traceabilityOf: 「要求 ID」と「仕様項目 ID」の列を持つ表の行から紐付けを導出する。1 つのセルに複数の
// ID があれば組をすべて作る。両方の ID が揃わない行は紐付けとして数えない（片側だけの行を数えると、
// 根拠の無い仕様項目が「紐付け済み」に化ける）。
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

// deriveDocs: structuralCompact が読む形に正規化する。ids は見出しに現れる自文書の種別の ID、referenced は
// 本文のそれ以外の自種別の ID。この導出では申告と本文の突き合わせ（UNDECLARED / PHANTOM）は起こりえないので、
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

// workspaceExtraCompact: workspace モードだけで当てる検査（参照先の実在・曖昧語・開いた TBD の断定）。
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

// flowSourceCompact: flow の各要素と decision の各 case の出典の形と、挙げた決定・未決の ID の実在。
function flowSourceCompact(flow, decisionIds, openIds) {
  const out = []
  const check = (where, source, badShape) => {
    const sources = Array.isArray(source) ? source : source ? [source] : []
    if (!sources.length) return badShape(true)
    for (const s of sources) {
      const kinds = s && typeof s === 'object' && !Array.isArray(s) ? ['input', 'decision', 'open'].filter((k) => String(s[k] ?? '').trim()) : []
      if (kinds.length !== 1) {
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
    if (el.type !== 'decision' || !Array.isArray(el.cases)) continue
    el.cases.forEach((c, i) => check(`${el.id}.case${i + 1}`, c && c.source, () => out.push({ c: 'FLOW_CASE_NOSOURCE', d: 'flow', a: [el.id, i + 1] })))
  }
  return out
}

// flowTableCompact: decision ごとの判定表（inputs × cases）。網羅と一意は文書の判定表と同じ tableFindings で見る。
// 行き先の同じ値を 1 つの枝に畳んだ判断は、下流が値を使わない限り、分類を潰したまま検査を通る（前回の試走の F-012）。
function flowTableCompact(flow) {
  const out = []
  const els = listOf(flow, 'elements').filter((el) => el && el.id)
  const byId = new Map(els.map((el) => [el.id, el]))
  const nextOf = (el) => [...(Array.isArray(el.next) ? el.next : []), ...(el.type === 'decision' && Array.isArray(el.branches) ? el.branches.map((b) => b && b.next) : [])].filter((x) => byId.has(x))
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
      const seen = new Set()
      const queue = nextOf(el)
      while (queue.length) {
        const id = queue.shift()
        if (seen.has(id)) continue
        seen.add(id)
        queue.push(...nextOf(byId.get(id)))
      }
      if (![...(usedBy.get(el.id) || [])].some((id) => seen.has(id))) out.push({ c: 'FLOW_SAME_NEXT', d: 'flow', a: [el.id, [...targets][0]] })
    }
    const badInput = inputs.find((i) => !i || !String(i.name || '').trim() || !Array.isArray(i.values) || !i.values.length)
    if (!inputs.length || !cases.length || badInput) {
      out.push({ c: 'FLOW_NO_TABLE', d: 'flow', a: [el.id] })
      continue
    }
    for (const inp of inputs) if (!byId.has(inp.from)) out.push({ c: 'FLOW_INPUT_FROM', d: 'flow', a: [el.id, String(inp.name), String(inp.from ?? '')] })
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
    for (const f of tableFindings(conds, rows, cases.some(isElse))) {
      if (f.kind === 'value') out.push({ c: 'FLOW_DT_VALUE', d: 'flow', a: [el.id, f.name, f.value] })
      if (f.kind === 'too_many') out.push({ c: 'FLOW_DT_SIZE', d: 'flow', a: [el.id, f.total] })
      if (f.kind === 'gap') out.push({ c: 'FLOW_DT_GAP', d: 'flow', a: [el.id, f.combo] })
      if (f.kind === 'overlap') out.push({ c: 'FLOW_DT_OVERLAP', d: 'flow', a: [el.id, f.combo, f.a, f.b] })
    }
  }
  return out
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

// groupCompact: { c, d, a } の列を、同じ (c, d, a) を 1 件にしてから、続く同じ種別・同じ文書でまとめる。
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

// expandWorkspace: expandStructural と同じ展開を、workspace モードの種別も含めた表で行う。
function expandWorkspace(compact) {
  const table = { ...FINDING_TEXT, ...WORKSPACE_TEXT }
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

function selectDocs(keys, wanted) {
  for (const k of wanted) if (!keys.includes(k)) throw new Error(`--doc ${k} は workspace にありません（あるのは ${keys.join(' / ') || 'なし'}）`)
  return wanted.length ? wanted : keys
}

function wsFlow(ws) {
  requireInput(ws)
  const flow = readLedger(ws, 'flow')
  if (flow === null) throw new Error(`${ledgerOf('flow').file()} がありません`)
  const openIds = new Set(listOf(readLedger(ws, 'open'), 'open').filter((x) => x && x.id).map((x) => String(x.id)))
  const list = [...flowGraphCompact(flow), ...flowSourceCompact(flow, decisionIdsOf(ws), openIds), ...flowTableCompact(flow), ...flowHistoryCompact(flow)]
  const body = expandWorkspace({ findings: groupCompact(list), not_checked: [] })
  const digest = digestOf(body)
  const els = listOf(flow, 'elements').filter((el) => el && el.id)
  const passed = new Set(listOf(readLedger(ws, 'verifications'), 'items').filter((it) => it && it.verdict === 'pass' && it.digest).map((it) => `${it.id}\u0000${it.digest}`))
  const unverified = els.filter((el) => !passed.has(`${el.id}\u0000${digestOf(el)}`)).map((el) => el.id)
  // どの O- が裁定済みかは state を持つ script が決める（ここで判断すると、同じ cycle で閉じた O- を 1 手遅れで見る）。
  const openOnly = els.flatMap((el) => {
    const sources = Array.isArray(el.source) ? el.source : el.source ? [el.source] : []
    const opens = sources.map((s) => s && typeof s === 'object' && String(s.open ?? '').trim())
    return sources.length && opens.every(Boolean) ? [...new Set(opens)].map((o) => ({ el: el.id, open: o })) : []
  })
  // content_sha256 は flow.json のバイト列から取る。digest は指摘の一覧の値で、指摘が 0 件の flow どうしを区別できない。
  return {
    findings: body.findings.length,
    open: openIds.size,
    path: writeCheck(ws, 'flow.json', { ...body, digest }),
    digest,
    content_sha256: ledgerSha(ws, 'flow'),
    unverified,
    open_only: openOnly,
  }
}

// conflicts: 同じ target を持つ決定どうし、決定と flow の要素（id か label が target に一致）の組を列挙する。
// 組の探索を resolver の生成に任せると探索の量に上限が無くなるので、ここで閉集合にして resolver には
// 判定だけをさせる。target の無い決定は組を作れないので untargeted として件数とともに返す（見ていないものを宣言する）。
function wsConflicts(ws) {
  requireInput(ws)
  const decisions = readLedger(ws, 'decisions')
  if (decisions === null) throw new Error(`${ledgerOf('decisions').file()} がありません`)
  const flow = readLedger(ws, 'flow')
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
  pairs.sort((x, y) => x.kind.localeCompare(y.kind) || x.a.localeCompare(y.a) || x.b.localeCompare(y.b))
  const untargeted = ds.filter((x) => !x.targets.length).map((x) => x.id).sort()
  const body = { pairs, untargeted, flow_checked: flow !== null }
  const digest = digestOf(body)
  return {
    pairs: pairs.length,
    decision_pairs: pairs.filter((p) => p.kind === 'decision-decision').length,
    flow_pairs: pairs.filter((p) => p.kind === 'decision-flow').length,
    untargeted: untargeted.length,
    flow_checked: flow !== null,
    path: writeCheck(ws, 'conflicts.json', { ...body, digest }),
    digest,
    pair_keys: pairs.map((p) => `pair:${[p.a, p.b].map(String).sort().join('|')}`),
  }
}

// doc: 文書の構造検査に、参照先の実在・曖昧語・開いた TBD の断定を加える。開いている TBD は --open-tbd
// （script が解消済みを除いて算出したもの）を正とし、無ければ meta の TBD の候補の和を使う（どちらを
// 使ったかを結果に書く）。--doc を付けると、その文書の指摘だけを別のファイルに書く（並列の writer が
// 同じ結果ファイルを奪い合わないため。検査そのものは文書を跨いで全体に当てる）。
function wsDoc(ws, opts) {
  const wsDocs = workspaceDocs(ws)
  if (!wsDocs.length) throw new Error('workspace に文書（requirements-*.md / specifications-*.md）がありません')
  const selected = selectDocs(wsDocs.map((d) => d.key), opts.doc)
  const docs = deriveDocs(wsDocs)
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
  const degraded = expanded.findings.filter((f) => f.severity === 'degraded').length
  return {
    findings: expanded.findings.length,
    blocking: expanded.findings.length - degraded,
    degraded,
    not_checked: expanded.not_checked.length,
    path: writeCheck(ws, name, { ...body, digest }),
    digest,
    tree_digest: tree,
  }
}

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OWNERSHIP = { file: path.join('schemas', 'agent-contracts.md'), heading: '## W のファイルと書き手' }

// ownedPatterns: 所有表は契約から毎回読み、写しを持たない（写すと表を直しても検出が古いまま残る）。<…> に
// ドットを許さないのは、版を付けた写し（requirements-x.pre2.md）を表に合わせないため。
function ownedPatterns() {
  const text = fs.readFileSync(path.join(SKILL_DIR, OWNERSHIP.file), 'utf8')
  const lines = text.split('\n')
  const unreadable = () => new Error(`所有表（${OWNERSHIP.file} の「${OWNERSHIP.heading}」の表の 1 列目）を読み取れません。W に置いてよいファイルが決まらないので止めます`)
  const start = lines.indexOf(OWNERSHIP.heading)
  if (start < 0) throw unreadable()
  const end = lines.findIndex((l, i) => i > start && /^## /.test(l))
  const cells = lines.slice(start + 1, end < 0 ? undefined : end).filter((l) => /^\|/.test(l)).map((l) => l.split('|')[1] || '')
  const pats = cells.flatMap((c) => [...c.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim()))
  if (!pats.length) throw unreadable()
  const esc = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  const toRe = (p, name) => esc(p).replace(/<[^>]+>/g, name).replace(/\*/g, '[^/]*')
  return {
    files: pats.filter((p) => !p.endsWith('/')).map((p) => new RegExp(`^${toRe(p, '[^/.]+')}$`)),
    workDirs: pats.filter((p) => p.endsWith('/')).map((p) => new RegExp(`^${toRe(p, '([^/]+)')}`)),
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

// sizesOf: 台帳と文書のファイルごとのバイト数。SIZE_BUDGET は目安なので、超えても止めずに数えるだけにする。
function sizesOf(ws, wsDocs, name) {
  const entries = [
    ...Object.keys(LEDGERS).filter((n) => n !== 'meta').map((n) => [n, ledgerOf(n).file()]),
    ...wsDocs.flatMap((d) => [['document', d.path], ['meta', ledgerOf('meta').file(d.key)]]),
  ].filter(([, f]) => fs.existsSync(path.join(ws, f)))
  const sizes = Object.fromEntries(entries.map(([, f]) => [f, fs.statSync(path.join(ws, f)).size]))
  const over = entries.filter(([n, f]) => sizes[f] > SIZE_BUDGET[n]).map(([n, f]) => ({ file: f, bytes: sizes[f], budget: SIZE_BUDGET[n] }))
  return { sizes, size_over: { count: over.length, path: writeCheck(ws, `${name}.sizes.json`, { budget: SIZE_BUDGET, sizes, over }) } }
}

// treeFindings: snapshot と tree-digest の所見。一覧は checks/<name>.* に書き、stdout には件数とパスだけを出す
// （一覧を stdout に載せると、script が notices に入れて next_args が上限なしに膨らむ）。name を snapshot の label に
// するのは、後の snapshot が先の notices の指す一覧を上書きしないため。
function treeFindings(ws, wsDocs, live, name) {
  const stray = strayFiles(ws, live)
  return { stray: { count: stray.length, path: writeCheck(ws, `${name}.stray.json`, { stray }) }, ...sizesOf(ws, wsDocs, name) }
}

// snapshot --save: 項目ごとの hash を checks/<label>.snapshot.json に書く。audited- で始まるラベルは
// --role auditor のときだけ保存する。CLI は呼び出し元を識別できないので、これは書き手が監査の基準を
// 取り違えて上書きする事故を防ぐだけである。基準の差し替えを検出するのは diff の --expect の照合。
function wsSnapshot(ws, opts) {
  const label = opts.save
  if (!label) throw new Error('snapshot には --save <label> が要ります')
  if (!LABEL.test(label)) throw new Error(`ラベルは英数字と . _ - だけにしてください: ${label}`)
  if (label.startsWith('audited-') && opts.role !== 'auditor') {
    throw new Error('audited- で始まるラベルは --role auditor のときだけ保存できます（監査の基準は監査役だけが保存する）')
  }
  const wsDocs = workspaceDocs(ws)
  const found = treeFindings(ws, wsDocs, opts.live, label)
  const items = snapshotOf(wsDocs)
  const digest = digestOf(items)
  const docs = Object.fromEntries(wsDocs.map((d) => [d.key, { path: d.path, digest: digestOf({ [d.key]: items[d.key] }), items: items[d.key] }]))
  const rel = writeCheck(ws, `${label}.snapshot.json`, { label, digest, docs })
  return { label, docs: wsDocs.length, items: Object.values(items).reduce((n, x) => n + Object.keys(x).length, 0), path: rel, digest, ...found }
}

// diff --against <label> --expect <digest>: 保存した snapshot と今の木を項目の単位で比べる。snapshot の
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

// index: 保存先の 2 つの INDEX（references/document-splitting.md §6）を W の文書から導出し、
// checks/INDEX.<kind>.md に書く。INDEX は本体の写しなので、手で書くと必ず本体と drift する。司令塔はこの
// ファイルを保存先へ逐語で写すだけにする（司令塔が文を書かないため）。関心事は plan.json の docs[].concern、
// 項目は見出しの ID、要求と仕様の対応は仕様書のトレーサビリティ表から取る。
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
    else if (a === '--doc') o.doc.push(take())
    else if (a === '--req-dir') o.reqDir = take()
    else if (a === '--spec-dir') o.specDir = take()
    else if (a === '--open-tbd') o.openTbd = take().split(',').map((s) => s.trim()).filter(Boolean)
    else if (a === '--ledger') o.ledger = take()
    else if (a === '--ids') o.ids = take().split(',').map((s) => s.trim()).filter(Boolean)
    else if (a === '--collection') o.collection = take()
    else if (a === '--live') o.live = take().split(',').map((s) => s.trim()).filter(Boolean)
    else if (a === '--expect-resolutions') o.expectResolutions = take()
    else if (a === '--expect-decisions') o.expectDecisions = take()
    else if (a === '--check') o.check = true
    else throw new Error(`不明な引数です: ${a}`)
  }
  return o
}

// runWorkspace: stdout に出す 1 行分のオブジェクトを返す（件数・digest・書いたパスだけ）。
function runWorkspace(mode, argv) {
  const opts = parseWorkspaceArgs(argv)
  if (!opts.workspace) throw new Error('--workspace <W> が要ります')
  const ws = path.resolve(opts.workspace)
  if (!fs.existsSync(ws) || !fs.statSync(ws).isDirectory()) throw new Error(`workspace がディレクトリではありません: ${opts.workspace}`)
  if (mode === 'flow') return wsFlow(ws)
  if (mode === 'conflicts') return wsConflicts(ws)
  if (mode === 'doc') return wsDoc(ws, opts)
  if (mode === 'snapshot') return wsSnapshot(ws, opts)
  if (mode === 'diff') return wsDiff(ws, opts)
  if (mode === 'tree-digest') return wsTreeDigest(ws, opts)
  if (mode === 'index') return wsIndex(ws, opts)
  if (mode === 'put') return wsPut(ws, opts, fs.readFileSync(0, 'utf8'))
  if (mode === 'del') return wsDel(ws, opts)
  if (mode === 'questions') return wsQuestions(ws, opts)
  if (mode === 'sha') return wsSha(ws, opts)
  if (mode === 'report') return wsReport(ws)
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
    process.stdout.write(`${JSON.stringify(runWorkspace(mode, process.argv.slice(3)))}\n`)
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
  runChecks,
  WORKSPACE_TEXT,
  itemSections,
  runWorkspace,
  LEDGERS,
  SIZE_BUDGET,
  writeAtomic,
}
