export const meta = {
  name: 'review-document',
  description:
    '日本語の説明的文書を短さ・平易さ・独自用語の不使用の3軸で採点し、反証に生き残った指摘だけを返す（revise では staging への改稿と再採点まで行う）',
  phases: [
    { title: 'Prepare', detail: '採点基準と対象の読み取り可否を確かめる' },
    { title: 'Score', detail: '3つの軸をそれぞれ独立に採点する' },
    { title: 'Refute', detail: '各指摘に観点の違う反証者を独立に当てる' },
    { title: 'Synthesize', detail: '生き残った証拠から改善策を統合する' },
    { title: 'Update', detail: 'mode=revise のとき staging へ改稿する' },
    { title: 'Rescore', detail: 'staging を同じ構成で再採点し before/after を突き合わせる' },
  ],
}

// 有効票の下限。3 票中 2 票が返らないと多数決の分母が 1 になり、「1 名が反証しなかった」
// だけで確定してしまう。欠測は反証の不在ではないので、確定にも棄却にも回さない。
const MIN_VALID_VOTES = 2

// 指摘の粒度：用語 1 件 / 最悪文 1 件 / 改善策 1 件をそれぞれ 1 指摘として反証にかける。
// まとめて 1 指摘にすると、1 つが棄却されただけで残りが巻き添えで消える。
const AXES = [
  {
    id: 'shortness',
    title: '短さ',
    evidence: 'worst_sentences と breakdown を返す。jargon は空配列でよい。',
  },
  {
    id: 'plainness',
    title: '平易さ',
    evidence: 'worst_sentences を返す。jargon と breakdown は空配列でよい。',
  },
  {
    id: 'no_jargon',
    title: '独自用語の不使用',
    evidence: 'jargon を返す。worst_sentences と breakdown は空配列でよい。',
  },
]

// 反証者の観点。同じ懐疑者を 3 名並べても同じ見落とし方をするため、何を疑うかをずらす。
// 実在 → 実害 → 副作用 の順で、指摘が生き残る条件を狭めていく。
const PERSPECTIVES = [
  {
    id: 'existence',
    guide:
      '指摘された記述が本当にそのファイルに存在するかを確認する観点。' +
      '引用が実物と一致しない、既に別の箇所で手当てされている、該当箇所が無い、' +
      'のいずれかなら反証が成立する。',
  },
  {
    id: 'materiality',
    guide:
      '記述が存在するとして、それが読み手の理解を実際に妨げているかを問う観点。' +
      '直さなくても 1 読で意味が取れる、様式の好みでしかない、のいずれかなら反証が成立する。',
  },
  {
    id: 'lossiness',
    guide:
      '提案された書き換え・置き換えが、内容・根拠の追跡・検証可能性を落としていないかを問う観点。' +
      '書き換え例が条件や例外を落としている、置き換え案が区別していた概念を潰している、' +
      '削除案が根拠へのたどり方を消している、のいずれかなら反証が成立する。' +
      'この観点は「短くなったが内容が減った」提案を落とすために置いてある。',
  },
]

const PREPARE_SCHEMA = {
  type: 'object',
  properties: {
    rubric_readable: { type: 'boolean' },
    readable_targets: { type: 'array', items: { type: 'string' } },
    unreadable_targets: { type: 'array', items: { type: 'string' } },
    // 日本語の説明文ではないもの（コード・非日本語・バイナリ）。採点対象から外す。
    skipped_targets: {
      type: 'array',
      items: {
        type: 'object',
        required: ['file', 'reason'],
        properties: { file: { type: 'string' }, reason: { type: 'string' } },
      },
    },
    note: { type: 'string' },
  },
  required: ['rubric_readable', 'readable_targets', 'unreadable_targets', 'skipped_targets'],
}

const SCORE_SCHEMA = {
  type: 'object',
  properties: {
    per_file: {
      type: 'array',
      items: {
        type: 'object',
        required: ['file', 'score', 'rationale'],
        properties: {
          file: { type: 'string' },
          score: { type: 'number' },
          rationale: { type: 'string' },
        },
      },
    },
    worst_sentences: {
      type: 'array',
      items: {
        type: 'object',
        // quote と rewrite を対で必須にする。書き換え例の無い指摘は反証者が
        // 「内容を落としていないか」を判定できず、未検証のまま終わる。
        required: ['file', 'quote', 'rewrite'],
        properties: {
          file: { type: 'string' },
          quote: { type: 'string' },
          rewrite: { type: 'string' },
        },
      },
    },
    jargon: {
      type: 'array',
      items: {
        type: 'object',
        required: ['term', 'files', 'replacement', 'loses', 'safe_to_replace'],
        properties: {
          term: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          replacement: { type: 'string' },
          loses: { type: 'string' },
          safe_to_replace: { type: 'boolean' },
        },
      },
    },
    breakdown: {
      type: 'array',
      items: {
        type: 'object',
        required: ['file', 'normative_pct', 'evidence_pct', 'meta_pct'],
        properties: {
          file: { type: 'string' },
          normative_pct: { type: 'number' },
          evidence_pct: { type: 'number' },
          meta_pct: { type: 'number' },
        },
      },
    },
    suggestions: { type: 'array', items: { type: 'string' } },
    // 基準や対象が読めなかったことを「指摘 0 件」と同じ形で返されると、欠測が
    // 「見たが問題なし」に化ける。真偽値で受け取り、script 側で null として扱う。
    unreadable: { type: 'boolean' },
    note: { type: 'string' },
  },
  required: ['per_file', 'worst_sentences', 'jargon', 'breakdown', 'suggestions', 'unreadable'],
}

// 三値で受け取る。boolean にすると「読めなかった」を false（反証できなかった）に押し込み、
// 検証していない票が確定側の有効票として数えられる。
const REFUTE_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['refuted', 'not_refuted', 'unreadable'] },
    reason: { type: 'string' },
  },
  required: ['verdict', 'reason'],
}

const SYNTH_SCHEMA = {
  type: 'object',
  properties: {
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['text', 'effect'],
        properties: {
          text: { type: 'string' },
          effect: { type: 'string', enum: ['high', 'medium', 'low'] },
          files: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    note: { type: 'string' },
  },
  required: ['suggestions'],
}

const UPDATE_SCHEMA = {
  type: 'object',
  properties: {
    changed_files: {
      type: 'array',
      items: {
        type: 'object',
        // addresses を必須にして、変更と指摘の対応を残す。対応の書けない改稿は
        // 後段の突き合わせで説明できない（人間の依頼由来なら "focus" と書く）。
        required: ['path', 'reason', 'addresses'],
        properties: {
          path: { type: 'string' },
          reason: { type: 'string' },
          addresses: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    summary: { type: 'string' },
  },
  required: ['changed_files', 'summary'],
}

const CONSTRAINT_SCHEMA = {
  type: 'object',
  properties: {
    violations: {
      type: 'array',
      items: {
        type: 'object',
        required: ['path', 'constraint', 'evidence'],
        properties: {
          path: { type: 'string' },
          constraint: { type: 'string' },
          evidence: { type: 'string' },
        },
      },
    },
    unchecked: { type: 'array', items: { type: 'string' } },
    note: { type: 'string' },
  },
  required: ['violations', 'unchecked'],
}

const parsedArgs = (typeof args === 'string' ? JSON.parse(args) : args) || {}

// ------------------------------------------------------------------ 起動時ガード
// 対象も範囲も定まらないまま走らせると、何を見たのか説明できない結果が「採点結果」として
// 返る。曖昧さは呼び出し側（SKILL.md S2 の準備）で潰す契約なので、黙って補完せず落とす。

function requireAbsolutePath(value, name) {
  if (!value || typeof value !== 'string' || !value.trim()) {
    throw new Error(`args.${name} が未指定です。SKILL.md S3 の呼び出し例に従ってください。`)
  }
  if (!value.startsWith('/')) {
    throw new Error(
      `args.${name} は絶対パスで渡してください（受領: ${value}）。` +
        'script はファイルシステムに触れず symlink も解決できないので、' +
        '呼び出し側が realpath で解決した実体パスを渡すこと。'
    )
  }
  return value.replace(/\/+$/, '')
}

const RUBRIC_PATH = requireAbsolutePath(parsedArgs.rubricPath, 'rubricPath')

const mode = parsedArgs.mode
if (!['review', 'revise'].includes(mode)) {
  throw new Error(`args.mode は 'review' か 'revise' のいずれかです（受領: ${mode}）。`)
}

const rawTargets = parsedArgs.targets
if (!Array.isArray(rawTargets) || rawTargets.length === 0) {
  throw new Error(
    'args.targets（対象文書の絶対パス配列）が空です。' +
      '対象が示されていない依頼は script を呼ばず、SKILL.md S2 に従って 1 回聞き返すこと。'
  )
}
const targets = rawTargets.map((t, i) => requireAbsolutePath(t, `targets[${i}]`))

const focus = parsedArgs.focus || null

// constraints は revise で必須。落とせない性質が分からないまま短くすると、
// 要求 ID や根拠へのリンクごと消える改稿が「改善」として通る。
const constraints =
  parsedArgs.constraints && String(parsedArgs.constraints).trim()
    ? String(parsedArgs.constraints).trim()
    : '根拠の追跡性と検証可能性を落とさないこと。要求 ID・参照リンク・例外条件は保持する。'
const constraintsWereDefaulted = !(parsedArgs.constraints && String(parsedArgs.constraints).trim())

// 対象群の共通ディレクトリ。staging をこの「兄弟」に置くための基準。
function commonDir(paths) {
  const dirs = paths.map((p) => p.slice(0, p.lastIndexOf('/')))
  let base = dirs[0]
  for (const d of dirs.slice(1)) {
    while (base && d !== base && !d.startsWith(`${base}/`)) {
      base = base.slice(0, base.lastIndexOf('/'))
    }
  }
  return base || ''
}
const mirrorRoot = commonDir(targets)
if (!mirrorRoot) {
  throw new Error(
    '対象文書に共通の親ディレクトリがありません。staging のミラーを作る基準が決まらないため、' +
      '同じディレクトリツリーの文書群を渡すか、args.stagingDir を明示してください。'
  )
}

const stagingDir = parsedArgs.stagingDir
  ? requireAbsolutePath(parsedArgs.stagingDir, 'stagingDir')
  : `${mirrorRoot}-review-staging`

// 包含は双方向で弾く。staging が対象の配下だと、再採点の担当がミラーと原本の両方を読み、
// ミラーで直した箇所が原本側から同じ指摘として再び出て remaining に積まれる。
// 逆に staging が対象の祖先でも同じことが起きる。
if (stagingDir === mirrorRoot || stagingDir.startsWith(`${mirrorRoot}/`)) {
  throw new Error(
    `args.stagingDir が対象文書の配下を指しています（${stagingDir}）。` +
      '再採点が下書きと原本の両方を読むことになり、before/after の突き合わせが成立しません。' +
      '兄弟ディレクトリを指定してください。'
  )
}
if (mirrorRoot.startsWith(`${stagingDir}/`)) {
  throw new Error(
    `args.stagingDir が対象文書の祖先を指しています（${stagingDir}）。` +
      '同上の理由で突き合わせが成立しません。兄弟ディレクトリを指定してください。'
  )
}

const stagingPathOf = (p) => `${stagingDir}${p.slice(mirrorRoot.length)}`
const originalPathOf = (p) =>
  p === stagingDir || p.startsWith(`${stagingDir}/`) ? `${mirrorRoot}${p.slice(stagingDir.length)}` : p

// agent が返すファイル表記（絶対パス・staging パス・basename・'./' 付き）を、script が持つ
// 正準パス（scoreTargets の本体側絶対パス）へ解決する。解決できなければ null。
// ファイルの同一性判定を agent の文字列表記に依存させないための唯一の入口。
function canonicalPathOf(raw, canonicalTargets) {
  if (!raw) return null
  const cleaned = originalPathOf(String(raw).trim().replace(/^\.\//, ''))
  if (canonicalTargets.includes(cleaned)) return cleaned
  const bySuffix = canonicalTargets.filter((t) => t.endsWith(`/${cleaned}`))
  return bySuffix.length === 1 ? bySuffix[0] : null
}

const focusBlock = focus ? `[FOCUS]:\n${focus}\n人間が特に見てほしいと言った関心。両モードで維持する。` : ''

// ------------------------------------------------------------------------- Prepare
// 採点前に、基準と対象が実際に読めるかを 1 度だけ確かめる。読めないまま採点すると、
// rubric に無い基準で付けた点数が「基準どおりの採点」として下流に流れる。

phase('Prepare')
const prep = await agent(
  [
    'あなたは文書レビューの下準備を担当する。読み取り可否の確認だけを行い、採点はしない。',
    '',
    `[RUBRIC]: ${RUBRIC_PATH}`,
    'この採点基準ファイルを Read すること。存在しない・読めない場合は rubric_readable を false にする。',
    '無いことを黙って補って一般論で進めると、基準に無い判定が「基準どおり」として通ってしまう。',
    '',
    `[TARGETS]:\n${targets.join('\n')}`,
    '各パスを Read し、読めたものを readable_targets、読めなかったものを unreadable_targets に入れる。',
    '読めたもののうち、日本語の説明的文書ではないもの（ソースコード、日本語以外の言語の文書、',
    'バイナリ、データだけの表）は skipped_targets に理由つきで入れる。',
    'この 3 軸は日本語の説明文を前提にしており、当てはめると根拠の無い点数が出るため。',
  ].join('\n'),
  { model: 'sonnet', schema: PREPARE_SCHEMA, phase: 'Prepare', label: 'prepare' }
)

if (!prep) {
  return {
    mode,
    targets,
    verdict: 'review_incomplete',
    scores: [],
    jargon: [],
    worst_sentences: [],
    breakdown: [],
    suggestions: [],
    missing_axes: AXES.map((a) => a.id),
    missing_cells: [],
    unverified: [],
    rejected_count: 0,
    constraints_defaulted: false,
    skipped_targets: [],
    unreadable_targets: [],
    rubric_readable: null,
    note: '下準備の担当が応答しなかったため、採点は行っていません。',
    staging: null,
  }
}

const skipped = prep.skipped_targets || []
const skippedPaths = new Set(skipped.map((s) => s.file))
const scoreTargets = (prep.readable_targets || []).filter((f) => !skippedPaths.has(f))
if (prep.note) log(`下準備の補足: ${prep.note}`)
if ((prep.unreadable_targets || []).length > 0) {
  log(`読めなかった対象: ${prep.unreadable_targets.join(', ')}`)
}
if (skipped.length > 0) {
  log(`採点対象外: ${skipped.map((s) => `${s.file}（${s.reason}）`).join(' / ')}`)
}
if (!prep.rubric_readable) {
  log(`採点基準 ${RUBRIC_PATH} を読めませんでした。全軸を欠測として扱います。`)
}

function incompleteResult(note, missingAxes) {
  return {
    mode,
    targets,
    verdict: 'review_incomplete',
    scores: [],
    jargon: [],
    worst_sentences: [],
    breakdown: [],
    suggestions: [],
    missing_axes: missingAxes,
    missing_cells: [],
    unverified: [],
    rejected_count: 0,
    constraints_defaulted: false,
    skipped_targets: skipped,
    unreadable_targets: prep.unreadable_targets || [],
    rubric_readable: prep.rubric_readable === true,
    note,
    staging: null,
  }
}

if (!prep.rubric_readable) {
  return incompleteResult(
    `採点基準 ${RUBRIC_PATH} を読めなかったため採点していません。0 点でも「問題なし」でもありません。`,
    AXES.map((a) => a.id)
  )
}
if (scoreTargets.length === 0) {
  return incompleteResult(
    '採点できる日本語の説明文が 1 件もありませんでした（読めない、または対象外の形式）。',
    AXES.map((a) => a.id)
  )
}

// --------------------------------------------------------------------- 採点（Score）

// 採点担当が返す file 表記は、渡した絶対パスと一致するとは限らない（basename や './' 付き）。
// 完全一致 → 一意な末尾一致 の順で照合し、曖昧（複数一致）なら不一致として扱う。
function findPerFile(perFile, file) {
  const list = perFile || []
  const exact = list.find((p) => p.file === file)
  if (exact) return exact
  const suffix = list.filter((p) => {
    const s = String(p.file).replace(/^\.\//, '')
    return s && file.endsWith(`/${s}`)
  })
  return suffix.length === 1 ? suffix[0] : null
}

function runScore(files, phaseTitle, passLabel) {
  // parallel（barrier）を使う理由: 次の集約が 3 軸を横断して見る必要がある。
  // どの軸が欠測したかを missing_axes に載せ、1 つでも落ちたら verdict を
  // review_incomplete に固定する判定は、全軸が出揃わないと下せない。
  // また統合担当は軸をまたいだ重複を消すため、部分的な結果では作業を再開できない。
  return parallel(
    AXES.map((a) => () =>
      agent(
        [
          `あなたは文書を「${a.title}」の観点だけで採点する担当。他の観点の結果は見ない。`,
          '1 名に全観点を渡すと、目立つ観点だけを拾って残りを黙って飛ばし、',
          'どれを見なかったかも残らないため、観点ごとに分けてある。',
          '',
          `[RUBRIC]: ${RUBRIC_PATH}`,
          'この採点基準を必ず Read すること。要約を渡していないのは、要約経由だと',
          '原典に無い基準を作りかねないため。読めなければ unreadable を true にして返す。',
          '',
          `[AXIS]: ${a.id} — ${a.title}`,
          `採点手順・判定基準は rubric 内の「軸 ${a.id}」の節と「共通原則」の節に従うこと。`,
          '基準はこの指示文に写さない。写しと原本がズレたとき、どちらが正か分からなくなるため。',
          `[EVIDENCE_TO_RETURN]: ${a.evidence}`,
          '',
          `[FILES]:\n${files.join('\n')}`,
          '各ファイルを Read し、per_file に 1〜10 点と 1 行の根拠を返す。',
          '文字数・行数のしきい値で点を決めないこと。測るのは分量ではなく、',
          '同じ内容をもっと短く言えたはずかという圧縮の余地。',
          '',
          'suggestions には、この観点から見た「内容を落とさない」改善策だけを 1〜2 行で書く。',
          '削除だけの提案は、根拠の追跡ができなくなるので置き場の移動を先に検討する。',
          focusBlock,
        ]
          .filter(Boolean)
          .join('\n'),
        { model: 'sonnet', schema: SCORE_SCHEMA, phase: phaseTitle, label: `score-${a.id}-${passLabel}` }
      ).then((res) => ({ axis: a.id, res }))
    )
  ).then((raw) => {
    const rows = raw.filter(Boolean)
    const byAxis = {}
    const missing = []
    const missing_cells = []
    for (const a of AXES) {
      const row = rows.find((r) => r.axis === a.id)
      if (!row || !row.res) {
        missing.push(a.id)
        log(`観点「${a.title}」の採点担当が応答しませんでした（${passLabel}）。欠測として扱います。`)
        continue
      }
      if (row.res.unreadable === true) {
        missing.push(a.id)
        log(
          `観点「${a.title}」: 対象または基準を読めなかったと報告されました（${passLabel}）。欠測として扱います。` +
            (row.res.note ? ` 報告: ${row.res.note}` : '')
        )
        continue
      }
      if (row.res.note) log(`観点「${a.title}」の補足（${passLabel}）: ${row.res.note}`)
      byAxis[a.id] = row.res
      // 採点担当が応答しても、per_file から一部のファイルが落ちることがある。落ちた箇所を
      // 素通しすると score: null のまま verdict が findings/clean になり、
      // 「誰も見ていない」が「見たが問題なし」に化ける。欠測セルとして名指しで積む。
      for (const file of files) {
        if (!findPerFile(row.res.per_file, file)) {
          missing_cells.push({ file, axis: a.id })
          log(`観点「${a.title}」: ${file} の採点が返りませんでした（${passLabel}）。欠測セルとして扱います。`)
        }
      }
    }
    return { byAxis, missing, missing_cells }
  })
}

// 指摘の粒度は 1 用語 / 1 文 / 1 改善策。ここで id を振る。pass ごとに接頭辞を変えるのは、
// before/after を突き合わせるときに id が衝突すると「解消された指摘」と「新しく出た指摘」が
// 同一視されるため。
function collectFindings(byAxis, passLabel) {
  const out = []
  for (const a of AXES) {
    const res = byAxis[a.id]
    if (!res) continue
    let n = 0
    for (const j of res.jargon || []) {
      // 置き換えると失うものがある用語は指摘しない（要件）。判定は採点担当が行い、
      // script は宣言された真偽値でふるいにかける。
      if (j.safe_to_replace !== true) continue
      out.push({
        id: `${passLabel}-${a.id}-${++n}`,
        axis: a.id,
        type: 'jargon',
        file: (j.files || [])[0] || '',
        files: j.files || [],
        claim: `独自用語「${j.term}」は「${j.replacement}」で置き換えられる`,
        evidence: `${j.term} / 置換案: ${j.replacement} / 失うもの: ${j.loses}`,
        payload: j,
      })
    }
    for (const w of res.worst_sentences || []) {
      out.push({
        id: `${passLabel}-${a.id}-${++n}`,
        axis: a.id,
        type: 'worst_sentence',
        file: w.file,
        files: [w.file],
        claim: `この文は書き換えで短く（または平易に）できる: ${String(w.quote).slice(0, 60)}`,
        evidence: `原文: ${w.quote}\n書き換え案: ${w.rewrite}`,
        payload: w,
      })
    }
    for (const s of res.suggestions || []) {
      out.push({
        id: `${passLabel}-${a.id}-${++n}`,
        axis: a.id,
        type: 'suggestion',
        file: '',
        files: [],
        claim: String(s),
        evidence: String(s),
        payload: { text: String(s) },
      })
    }
  }
  return out
}

// --------------------------------------------------------------------- 反証（Refute）

function refute(findings, dir, phaseTitle, passLabel) {
  // 外側の parallel は指摘どうしが独立だから。内側の parallel（barrier）は多数決の算術が
  // 3 票すべてを必要とするため —— 1 票ずつ流して途中で決めると到着順で結論が変わる。
  return parallel(
    findings.map((f) => () =>
      parallel(
        PERSPECTIVES.map((p) => () =>
          agent(
            [
              'あなたは 1 件の指摘を検証する反証担当。指摘を確認するのではなく、',
              '棄却できるかどうかだけを判断する。反証できなければ not_refuted を返す。',
              '採点はしない（点数を付け直すのは担当外）。',
              '',
              `[PERSPECTIVE]: ${p.id}`,
              `[PERSPECTIVE_GUIDE]:\n${p.guide}`,
              '',
              `[TARGET_DIR]: ${dir}`,
              '対象ファイルは自分で Read すること。読めなければ unreadable を返す。',
              '読めていないのに not_refuted を返すと、検証していない票が確定側に数えられる。',
              '',
              `[FINDING]:\n${JSON.stringify(
                {
                  type: f.type,
                  axis: f.axis,
                  file: f.file,
                  claim: f.claim,
                  evidence: f.evidence,
                },
                null,
                2
              )}`,
            ].join('\n'),
            {
              model: 'sonnet',
              schema: REFUTE_SCHEMA,
              phase: phaseTitle,
              label: `refute-${f.id}-${p.id}`,
            }
          )
        )
      ).then((votes) => ({ finding: f, votes: votes.filter(Boolean) }))
    )
  ).then((raw) => {
    const confirmed = []
    const rejected = []
    const unverified = []
    for (const row of raw.filter(Boolean)) {
      // unreadable は有効票に数えない。読めていない票を分母に入れると、実際には 1 名しか
      // 検証していない指摘が「3 名中 1 名だけが反証」＝確定として通る。
      const votes = row.votes.filter((v) => v.verdict === 'refuted' || v.verdict === 'not_refuted')
      const refutedCount = votes.filter((v) => v.verdict === 'refuted').length
      const entry = {
        ...row.finding,
        valid_votes: votes.length,
        unreadable_votes: row.votes.length - votes.length,
        refuted_votes: refutedCount,
        votes: row.votes.map((v) => ({ verdict: v.verdict, reason: v.reason })),
      }
      if (votes.length < MIN_VALID_VOTES) {
        unverified.push(entry)
        continue
      }
      // 過半数。同数（2 票中 1 票）では棄却しない。割れた指摘は人間が見る材料として残す。
      if (refutedCount * 2 > votes.length) rejected.push(entry)
      else confirmed.push(entry)
    }
    log(
      `${passLabel}: 確定 ${confirmed.length} 件 / 棄却 ${rejected.length} 件 / 未検証 ${unverified.length} 件`
    )
    return { confirmed, rejected, unverified }
  })
}

// --------------------------------------------------------------- 集約（script の算術）

// files は常に「本体側の論理パス」。physicalOf は採点担当が実際に読んだ物理パスへの写像
// （review では恒等、rescore では stagingPathOf）。before/after は本体パスの file を鍵に
// 結合でき、staging の物理パスは staging_path として補助情報に載る。配列順には依存しない。
function scoreRows(byAxis, missing, files, physicalOf) {
  const toPhysical = physicalOf || ((p) => p)
  return files.map((file) => {
    const physical = toPhysical(file)
    const row = { file }
    if (physical !== file) row.staging_path = physical
    for (const a of AXES) {
      const res = byAxis[a.id]
      const hit = res ? findPerFile(res.per_file, physical) : null
      // 欠測は 0 ではなく null。0 は「見たが最低点だった」という実測値なので、
      // 見ていないことを 0 で表すと、誰も読んでいない文書が「ひどい文書」に化ける。
      row[a.id] = missing.includes(a.id) || !hit
        ? { score: null, rationale: missing.includes(a.id) ? '採点担当が応答しなかった、または基準を読めなかった' : '該当ファイルの採点が返らなかった' }
        : { score: hit.score, rationale: hit.rationale }
    }
    return row
  })
}

function flatBreakdown(byAxis) {
  const res = byAxis['shortness']
  return res ? res.breakdown || [] : []
}

function confirmedOf(type, confirmed) {
  return confirmed.filter((c) => c.type === type).map((c) => c.payload)
}

function keyOf(f) {
  return [f.type, f.axis, String(f.claim).trim().toLowerCase().replace(/\s+/g, ' ')].join('::')
}

// ------------------------------------------------------------------- 実行本体

phase('Score')
const first = await runScore(scoreTargets, 'Score', 'p1')

phase('Refute')
const firstFindings = collectFindings(first.byAxis, 'p1')
const base =
  firstFindings.length > 0
    ? await refute(firstFindings, mirrorRoot, 'Refute', 'before')
    : { confirmed: [], rejected: [], unverified: [] }

phase('Synthesize')
const synth =
  base.confirmed.length > 0
    ? await agent(
        [
          'あなたは統合担当。反証を生き残った証拠だけを見て、改善策を効果順に並べ直す。',
          '新しい指摘を作らないこと（採点も反証も担当外で、ここで足した指摘は誰の検証も通っていない）。',
          '観点をまたいで同じことを言っている策は 1 本にまとめる。',
          '削除だけの策は、根拠の追跡や検証可能性を壊すので、置き場の移動に言い換えられるなら言い換える。',
          '各策は 1〜2 行。effect は high / medium / low。',
          `[RUBRIC]: ${RUBRIC_PATH}`,
          'effect の判定は rubric の「改善策の効果順（effect）の判定基準」の節を Read して従うこと。',
          '主観の印象順で並べない。基準を写していないのは、写しと原本のズレを防ぐため。',
          '',
          '内部の担当名（採点担当・反証担当などの実装上の呼び方）を策の文面に出さないこと。',
          '読者にとっては意味の無い造語で、独自用語を減らすための出力が造語を持ち込むことになる。',
          '',
          `[CONFIRMED]:\n${JSON.stringify(
            base.confirmed.map((c) => ({ id: c.id, axis: c.axis, type: c.type, claim: c.claim, evidence: c.evidence })),
            null,
            2
          )}`,
          focusBlock,
        ]
          .filter(Boolean)
          .join('\n'),
        { model: 'opus', schema: SYNTH_SCHEMA, phase: 'Synthesize', label: 'synthesize' }
      )
    : { suggestions: [], note: '確定した指摘がありませんでした。' }

const rank = { high: 0, medium: 1, low: 2 }
const orderedSuggestions = synth
  ? [...(synth.suggestions || [])].sort((a, b) => (rank[a.effect] ?? 3) - (rank[b.effect] ?? 3)).map((s) => s.text)
  : []
if (!synth) log('統合担当が応答しませんでした。確定した指摘のみをそのまま返します。')

const beforeScores = scoreRows(first.byAxis, first.missing, scoreTargets)
const firstMissingCells = first.missing_cells || []

function baseResult(verdict, staging) {
  return {
    mode,
    targets,
    verdict,
    scores: beforeScores,
    jargon: confirmedOf('jargon', base.confirmed),
    worst_sentences: confirmedOf('worst_sentence', base.confirmed),
    breakdown: flatBreakdown(first.byAxis),
    suggestions: synth ? orderedSuggestions : base.confirmed.filter((c) => c.type === 'suggestion').map((c) => c.claim),
    missing_axes: first.missing,
    missing_cells: firstMissingCells,
    skipped_targets: skipped,
    unreadable_targets: prep.unreadable_targets || [],
    rubric_readable: true,
    unverified: base.unverified.map((u) => ({ id: u.id, axis: u.axis, type: u.type, claim: u.claim })),
    rejected_count: base.rejected.length,
    constraints_defaulted: mode === 'revise' ? constraintsWereDefaulted : null,
    note: synth ? synth.note || '' : '統合担当が応答しなかったため、改善策は未整理のまま返しています。',
    staging,
  }
}

if (mode === 'review') {
  // 確定 0 件でも未検証が残っていれば clean とは言わない。未検証を clean に丸めると、
  // 「未検証と問題なしを区別する」ために置いた 3 バケットが結果表示で 1 つに戻る。
  // 軸単位の欠測（missing_axes）だけでなく、ファイル×軸単位の欠測（missing_cells）も
  // 同格に扱う。どちらも「誰も見ていない箇所がある」ことに変わりがない。
  const verdict =
    first.missing.length > 0 || firstMissingCells.length > 0
      ? 'review_incomplete'
      : base.confirmed.length === 0 && base.unverified.length === 0
        ? 'clean'
        : 'findings'
  return baseResult(verdict, null)
}

// ---------------------------------------------------------------------- Update

// 軸が欠けたまま改稿しない。部分的な絵から書き換えるのは、見えていない箇所を
// 「問題なし」と決めつけて手を入れるのと同じで、止まる方が安全。
if (first.missing.length > 0 || firstMissingCells.length > 0) {
  return baseResult('review_incomplete', null)
}

const emptyStaging = (extra) => ({
  dir: stagingDir,
  changed_files: [],
  scores_before: beforeScores,
  scores_after: null,
  resolved: [],
  remaining: [],
  new: [],
  reclassified: [],
  carried_unverified: [],
  unverified: [],
  constraint_violations: [],
  constraint_unchecked: [],
  summary: '',
  ...extra,
})

phase('Update')
const changed = await agent(
  [
    'あなたは改稿担当。対象文書を staging（下書き置き場）に丸ごと複製し、複製側だけを書き直す。',
    '本体ファイルは 1 バイトも変更しないこと。承認前に本体が変わると、人間が承認する対象が',
    '「これから変わるもの」ではなく「もう変わったもの」になり、承認そのものが意味を失う。',
    '',
    `[TARGET_DIR]: ${mirrorRoot}`,
    `[STAGING_DIR]: ${stagingDir}`,
    `[FILES]:\n${scoreTargets.join('\n')}`,
    'ディレクトリ構造は対象と同じ相対位置で作る（後で承認されたファイルだけを本体へ戻すため）。',
    '',
    `[CONSTRAINTS]:\n${constraints}`,
    'これは落とせない性質。短くするために要求 ID・参照リンク・例外条件を消してはいけない。',
    '短くなったが根拠をたどれなくなった文書は、改善ではなく劣化。',
    '',
    `[CONFIRMED_FINDINGS]:\n${JSON.stringify(
      base.confirmed.map((c) => ({ id: c.id, axis: c.axis, type: c.type, file: c.file, claim: c.claim, evidence: c.evidence })),
      null,
      2
    )}`,
    `[SUGGESTIONS]:\n${orderedSuggestions.join('\n')}`,
    // 未検証も渡す。「未検証」と「問題なし」を混ぜない原則は改稿でも同じで、渡さないと
    // 確定 0 件を「直すところが無い」と読む。ただし確定指摘とは別枠にして判断を委ねる。
    `[UNVERIFIED_FINDINGS]:\n${JSON.stringify(
      base.unverified.map((c) => ({ id: c.id, axis: c.axis, type: c.type, claim: c.claim })),
      null,
      2
    )}`,
    focusBlock,
    '',
    'changed_files には実際に内容を変えたファイルだけを載せる。staging には全ファイルを複製するが、',
    'この一覧は承認後に本体へコピーする対象そのものなので、無変更のファイルを載せると',
    '承認されていない上書きが起きる。',
  ]
    .filter(Boolean)
    .join('\n'),
  { model: 'sonnet', schema: UPDATE_SCHEMA, phase: 'Update', label: 'update' }
)

if (!changed) {
  // 改稿担当が落ちた。staging へ何が書かれたかは script からは分からないので、
  // 「書かれていない」と読まれないよう空の器と dir を返して人間に確認させる。
  return baseResult(
    'update_failed',
    emptyStaging({ summary: '改稿担当が応答しませんでした。staging の中身を人が確認してください。' })
  )
}
log(`staging に ${changed.changed_files.length} ファイルを書きました。`)
if (changed.changed_files.length === 0) {
  log('改稿担当は応答したが変更ファイルを 1 つも報告しなかった。空の改稿のまま再採点に入る。')
}

// ---------------------------------------------------------------------- Rescore

phase('Rescore')
const stagedFiles = scoreTargets.map(stagingPathOf)
const after = await runScore(stagedFiles, 'Rescore', 'p2')
const afterMissingCells = (after.missing_cells || []).map((c) => ({ file: originalPathOf(c.file), axis: c.axis }))
if (after.missing.length > 0 || afterMissingCells.length > 0) {
  // 再採点で軸が欠けた状態を「残存 0 件」と読むと、直っていないものが直ったことになる。
  return baseResult(
    'reverify_incomplete',
    emptyStaging({
      changed_files: changed.changed_files,
      summary:
        `再採点で欠測が出たため、before/after を突き合わせていません。` +
        (after.missing.length > 0 ? ` 欠測した観点: ${after.missing.join(', ')}。` : '') +
        (afterMissingCells.length > 0
          ? ` 採点が返らなかった箇所: ${afterMissingCells.map((c) => `${c.file}×${c.axis}`).join(', ')}。`
          : ''),
    })
  )
}

const afterFindings = collectFindings(after.byAxis, 'p2')
const post =
  afterFindings.length > 0
    ? await refute(afterFindings, stagingDir, 'Rescore', 'after')
    : { confirmed: [], rejected: [], unverified: [] }

// 制約の突き合わせ。要求 ID や参照リンクの出現数を改稿前後で数えるのは、
// 分量のしきい値判定（禁止）ではなく、不変であるべき性質が保たれたかの確認。
// 前者は長さで品質を決める代理指標だが、後者は「落としてはいけないものが落ちていないか」を見る。
const constraintCheck = await agent(
  [
    'あなたは制約の突き合わせ担当。改稿が「落としてはいけない性質」を壊していないかだけを見る。',
    '文章の良し悪しは判定しない（採点は担当外）。',
    '',
    `[ORIGINAL_DIR]: ${mirrorRoot}`,
    `[STAGING_DIR]: ${stagingDir}`,
    `[FILES]:\n${scoreTargets.join('\n')}`,
    '対応するファイルを両方 Read し、次を突き合わせる。',
    '- 要求 ID・章番号など識別子の出現が減っていないか',
    '- 参照リンク・引用元の記載が減っていないか',
    '- 例外条件・否定条件が落ちていないか',
    '',
    `[CONSTRAINTS]:\n${constraints}`,
    '',
    '減っている・落ちているものを violations に、確認できなかった項目を unchecked に入れる。',
    '確認できなかったことを violations 0 件として返すと、未確認が「壊れていない」に化ける。',
  ].join('\n'),
  { model: 'sonnet', schema: CONSTRAINT_SCHEMA, phase: 'Rescore', label: 'constraint-check' }
)

const violations = constraintCheck ? constraintCheck.violations || [] : []
const unchecked = constraintCheck
  ? constraintCheck.unchecked || []
  : ['制約の突き合わせ担当が応答しませんでした（未確認であり、違反なしではありません）']
if (violations.length > 0) {
  log(`制約違反 ${violations.length} 件を検出しました。解消としては数えません。`)
}

// 制約違反のパスも指摘側のパスも、agent の返した表記のままでは突き合わせられない
// （片や絶対パス、片や basename になりうる）。両辺とも canonicalPathOf で本体側の正準
// パスへ解決してから比べる。解決できない違反が 1 件でもあれば、どのファイルが壊れたか
// script には分からないので、消えた指摘は全て「解消」ではなく未確定側へ倒す。
const violatedCanon = new Set()
let unresolvedViolation = false
for (const v of violations) {
  const c = canonicalPathOf(v.path, scoreTargets)
  if (c) violatedCanon.add(c)
  else {
    unresolvedViolation = true
    log(`制約違反のパス「${v.path}」を対象ファイルに対応付けられませんでした。消えた指摘は解消と数えません。`)
  }
}

const summarize = (f) => ({ id: f.id, axis: f.axis, type: f.type, claim: f.claim })
const afterConfirmedKeys = new Set(post.confirmed.map(keyOf))
const afterUnverifiedKeys = new Set(post.unverified.map(keyOf))

const resolved = []
const remaining = []
const reclassified = []
const carriedUnverified = []
const stagingUnverified = post.unverified.map(summarize)

for (const f of base.confirmed) {
  if (afterConfirmedKeys.has(keyOf(f))) {
    remaining.push(summarize(f))
    continue
  }
  // 制約を壊したファイルに関わる指摘は resolved に入れない。内容を落として消えた指摘は
  // 解消ではなく損失で、それを成果に数えると「短くして中身を削る」改稿が高く出る。
  // 違反が出ている実行では、ファイルに紐づかない指摘（suggestion 型）や、パスを正準化
  // できない指摘も、違反ファイルと無関係だと証明できないので resolved に入れない。
  if (violations.length > 0) {
    const canon = (f.files || []).map((x) => canonicalPathOf(x, scoreTargets))
    const cannotClear =
      unresolvedViolation ||
      f.type === 'suggestion' ||
      canon.length === 0 ||
      canon.some((x) => x === null) ||
      canon.some((x) => violatedCanon.has(x))
    if (cannotClear) {
      stagingUnverified.push({
        ...summarize(f),
        note: '制約違反が検出された実行で、違反ファイルと無関係だと確認できないため、解消として数えていません',
      })
      continue
    }
  }
  resolved.push(summarize(f))
}

// 改稿前に未検証だった指摘（有効票不足で確定も棄却もされなかったもの）も突き合わせの
// 対象に含める。再検証で確定したものは new に混ぜず reclassified として別掲する
// （改稿が持ち込んだ問題ではなく、票の結果が変わっただけ）。確定しなかったものは
// carried_unverified に残し、静かに消さない（消えても「解消」とは呼べない）。
for (const f of base.unverified) {
  if (afterConfirmedKeys.has(keyOf(f))) {
    reclassified.push({ ...summarize(f), note: '改稿前は未検証。再検証で確定した' })
  } else {
    carriedUnverified.push({
      ...summarize(f),
      status: afterUnverifiedKeys.has(keyOf(f)) ? 'still_unverified' : 'gone_unresolved',
      note:
        afterUnverifiedKeys.has(keyOf(f))
          ? '改稿前も後も未検証のまま'
          : '改稿後に再出現しなかったが、一度も検証を通っていないので解消とは数えない',
    })
  }
}
// 「新規」は改稿前に見えていた指摘全体（確定・棄却・未検証）と比べる。改稿前に棄却された
// ものが再採点で確定しても、それは改稿が持ち込んだ問題ではなく票の結果が変わっただけ。
// new は「改稿で悪くなっていないか」を人間が判断する唯一の数字なので、混ぜると判断が歪む。
const beforeSeen = new Set([...base.confirmed, ...base.rejected, ...base.unverified].map(keyOf))
const fresh = post.confirmed.filter((f) => !beforeSeen.has(keyOf(f))).map((f) => ({ id: f.id, axis: f.axis, type: f.type, claim: f.claim }))

const afterScores = scoreRows(after.byAxis, after.missing, scoreTargets, stagingPathOf)

return baseResult(
  'applied_to_staging',
  emptyStaging({
    changed_files: changed.changed_files,
    scores_after: afterScores,
    resolved,
    remaining,
    new: fresh,
    reclassified,
    carried_unverified: carriedUnverified,
    unverified: stagingUnverified,
    constraint_violations: violations,
    constraint_unchecked: unchecked,
    summary: changed.summary,
  })
)