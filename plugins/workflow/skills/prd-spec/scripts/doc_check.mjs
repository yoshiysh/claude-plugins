// doc_check: 文書の本文に依存する決定的な検査を、Workflow script の外で実行する CLI。
//
// Workflow script はファイルを読めない。本文を script の手元に置くには writer に全文を返させる
// しかなく、それが改稿のたびに文書全体を Write と返り値で 2 度出力させる原因だった（実測:
// 6 文書・333〜1002 行の run で writer が cache read の約 45% を消費）。本文を読む検査を
// ここへ移し、checker agent にこの CLI を実行させて結果だけを受け取る。
//
// 使い方: node doc_check.mjs <input.json>（相対パスは実行時のカレントディレクトリ基準）
// 入出力の契約は references/workflow-io.md §7 を正とする。

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

// ------------------------------------------------------- 構造検査の文面（draft/refine と共有）
//
// CLI は指摘を { c: 種別, d: 文書キー, a: 引数 } の短い形で出し、文面（id / location / quote /
// severity / issue / fix）はこの表から組み立てる。checker agent は CLI の出力を 1 字ずつ書き写して
// 返すので、指摘ごとに同じ説明文を載せると出力が数百 KB に膨らみ、写すトークンと写し間違いの
// 機会がそのまま増える（実測: 実 run の下書きで 311〜415 KB）。
// 文面は TBD-EX / TBD-NI の ID・novelty の digest・抑止の照合キーに入るので、組み立て結果は
// 以前の文面と 1 字も違ってはならない（tests/test_doc_check.py が golden と照合する）。
// この区間は scripts/refine.js と scripts/draft.js に逐語で複製されている（workflow script は
// import を書けない。一致は tests/test_doc_check.py が検査する）。
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
    fix: `${id} を tbd_items に申告する（blocking の真偽を必ず付ける）。既に解決していて本文に参照が残っているだけなら、本文からその記述を消す。`,
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
    fix: 'tbd_items の text に解消条件（何がどう決まればこの項目が解消するか）を書き足す。',
  }),
  NO_EVIDENCE: (id) => ({
    id: `ST-NO-EVIDENCE-${id}`,
    location: id,
    quote: id,
    issue: `${id} に対応する trace（根拠原本の引用）が申告されていない。本文に根拠句を書かない規約なので、trace が無い項目は根拠がどこにも残らない。`,
    fix: '根拠原本（[INPUT] / [ANSWERS] / [TBD_ANSWERS] / [DECISIONS] / [SKILL_PREMISES] / 計測結果）からの引用を trace に申告する。引用できないなら、その項目は要求ではなく未確定事項として起票し直す。',
  }),
  NON_NORMATIVE: (what, quote, docKey) => ({
    id: `ST-NON-NORMATIVE-${docKey}-${what}`,
    location: '本文',
    quote,
    issue: `本文に${what}が含まれている。納品文書に書くのは規範文・ID・上位/姉妹文書への参照・自明でない規則の 1 文の理由だけであり、経緯と根拠は返り値（audit_trail）と保存時の commit / PR 本文に残す。`,
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
// は何も保証しないので、形と閉包は算術で押さえる。draft.js / refine.js は入口でこの区間を使い、
// 崩れた flow では書き始めない（writer には flow を直す手段が無く、改稿枠を空回りさせるだけになる）。
// この区間は scripts/draft.js と scripts/refine.js に逐語で複製されている（一致は tests/test_doc_check.py が検査する）。
// FLOW_GRAPH_BEGIN
function flowGraphCompact(flow) {
  // 型の一覧は関数の中に置く（refine.js は入口検査でこの関数を定義位置より前から呼ぶ。外の const は巻き上がらない）。
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
// FLOW_GRAPH_END

// ------------------------------------------------------- 状態 × イベント表と判定表の検査
//
// 状態機械と判定規則は、項目ごとの散文で書くと「同じ入力に 2 つの行き先」「分岐の値に行き先が無い」
// 「条件が重なる」を読み手が照合するしかなく、実 run では依頼者への質問に化けて人間ゲートへ届いた
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
    const specific = rows.filter((r) => !isElse(r))
    const hasElse = rows.some(isElse)
    const doms = conds.map((c, ci) => {
      const declared = domains.get(c.name)
      if (declared) {
        for (const r of specific) {
          const v = r.vals[ci]
          if (!DT_WILDCARD.test(v) && !declared.includes(v)) out.push({ c: 'DT_VALUE', d: d.key, a: [d.key, label, c.name, v] })
        }
        return declared
      }
      return [...new Set(specific.map((r) => r.vals[ci]).filter((v) => !DT_WILDCARD.test(v)))]
    })
    const matches = (r, combo) => r.vals.every((v, ci) => DT_WILDCARD.test(v) || v === combo[ci])
    const comboText = (combo) => conds.map((c, ci) => `${c.name}=${combo[ci]}`).join(', ')
    const total = doms.reduce((p, x) => p * Math.max(1, x.length), 1)
    if (total > DT_MAX_COMBOS) {
      notChecked.push({ c: 'NC_DTABLE', a: [d.key, label, total] })
      continue
    }
    let combos = [[]]
    for (const dom of doms) combos = combos.flatMap((pre) => (dom.length ? dom : ['']).map((v) => [...pre, v]))
    for (const combo of combos) {
      const hit = specific.filter((r) => matches(r, combo))
      if (!hit.length && !hasElse) out.push({ c: 'DT_GAP', d: d.key, a: [d.key, label, comboText(combo)] })
      const results = new Set(hit.map((r) => r.res))
      if (results.size > 1) {
        const a = hit[0]
        const b = hit.find((r) => r.res !== a.res)
        out.push({ c: 'DT_OVERLAP', d: d.key, a: [d.key, label, comboText(combo), a.no, b.no] })
      }
    }
  }
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

// ------------------------------------------------------- 構造検査（draft/refine 共通）
//
// 正本はこのファイルだけである。draft.js / refine.js は checker agent 経由でこの CLI を
// 実行して結果を受け取る（以前は両 script に逐語で複製しており、片方だけ直すと A と B で
// 判定が食い違った）。
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
  //     したため、「どの記述がどこから来たか」は trace（→ audit_trail）にしか無い。trace が
  //     欠けた項目は、本文からも返り値からも根拠を辿れず、出所不明の断定と区別できない。
  //     ここを検査しないと、本文から根拠句を消した瞬間に fabrication 監査の入力が消え、
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


// canonicalJson: キーを並べ替えた JSON。checker agent は入力を書き写し、出力を構造化して返す
// ので、キー順や空白は変わりうる。中身が同じなら同じ文字列になる形で digest を取り、
// 書き写しで指摘が落ちた・入力が欠けた、を script 側で検出できるようにする。
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
// 出力に載せないので、checker が書き写す量は増えない。書けなければ null（呼び出し側は Grep で
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

// import したときは実行しない（tests が関数を直接呼ぶ）。main の判定は実パスで比べる —
// plugin のパスは symlink を含みうるので、文字列比較だと黙って何も出力しない CLI になる。
const invokedDirectly = (() => {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  const file = process.argv[2]
  if (!file) {
    process.stderr.write('usage: node doc_check.mjs <input.json>\n')
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
  formalCompact,
  FINDING_TEXT,
  headingIndex,
  stableKey,
  canonicalJson,
  runChecks,
}
