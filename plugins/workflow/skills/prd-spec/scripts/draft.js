export const meta = {
  name: 'prd-spec-draft',
  description: '分割案どおりに要求・仕様の初稿を書き切り、実行可能性検査と構造検査で「何が足りないか」を洗い出す',
  phases: [
    { title: 'Write requirements', detail: '分割案の各 requirements 文書を req-writer が並列に書き切る' },
    { title: 'Write specifications', detail: '全 requirements の ID が揃ってから各 specification 文書を書く' },
    { title: 'Executability', detail: '各文書に executability-auditor を当て、着手できない箇所を洗い出す' },
    { title: 'Collect', detail: 'TBD・実行可能性の指摘・構造検査を統合して返す' },
  ],
}

// ロールと責務の対応（誰が生成し、誰が検証するか）は schemas/role-map.md を正とする。
// 検証者（auditor 系）は判定と事実指摘のみを返し、文案の起草は生成側が担う — 1 role = 1 責務。
//
// このスキルの初稿は「完成品」ではなく「何が足りないかを見えるようにする全体像」である。
// だから書けない箇所で止めず TBD を置いて書き切り、そのうえで executability-auditor を
// ここで走らせる。B にしか置かないと「これだけでは作れない」の判明がヒアリングより後になり、
// 最も重要な指摘が聞き返せない場所で生まれる。

// 本文を読む検査（禁止語・ID 抽出・語尾など）の定数と関数は scripts/doc_check.mjs が正本である。
// Workflow script はファイルを読めないので、checker agent にその CLI を実行させて結果を受け取る。

// ROLE_OPTS: 各 role の model / effort。省略するとセッションの設定（xhigh 等）を継承し、
// 初稿の全呼び出しが最重量で走る。配分を 1 箇所で変えられるよう agent() は必ずここから取る。
const ROLE_OPTS = {
  reqWriter: { model: 'opus', effort: 'medium' },
  specWriter: { model: 'opus', effort: 'medium' },
  executability: { model: 'opus', effort: 'high' },
  // checker: 与えた JSON をファイルに書き doc_check.mjs を実行して出力を返すだけの係。判断をしない。
  checker: { model: 'sonnet', effort: 'low' },
}

const ID_ITEM = {
  type: 'object',
  properties: { id: { type: 'string' }, heading: { type: 'string' } },
  required: ['id', 'heading'],
}

// TBD_ITEM: blocking は「これが決まらないと実装・QA に着手できないか」。区分が無いと、
// 着手を止める 3 件と決まらなくても進める 24 件が同列に並び「TBD だらけで使えない文書」に見える。
const TBD_ITEM = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    text: { type: 'string' },
    owner: { type: 'string' },
    due: { type: 'string' },
    blocking: { type: 'boolean' },
    // candidates: 依頼者が選びやすくするための候補。**本文には書かない** — 文書の読み手は
    // 後続の AI であり、「決めてください」と依頼者へ話しかける文が成果物に混ざるため。
    // 候補を選択肢に整形して提示するのは、ゲートを運営する司令塔の仕事。
    candidates: { type: 'array', items: { type: 'string' } },
  },
  required: ['id', 'text', 'blocking'],
}

// TRACE_ITEM: 項目 ID → 根拠原本の対応。納品文書の本文には根拠句を書かない規約に変えたため、
// 「この記述はどこから来たか」はここにしか残らない。返り値では audit_trail として集約され、
// fabrication 監査と traceability 監査の照合対象になる。本文から根拠句を消しただけで
// trace を作らないと、捏造検査の入力そのものが消え、指摘 0 件が「健全」に化ける。
const TRACE_ITEM = {
  type: 'object',
  properties: {
    item_id: { type: 'string' },
    // kind: 根拠原本の種別。認められた原本以外の出所（業界の常識・類似システムの慣行）は
    // 列挙に無いので、そもそも申告できない。
    kind: {
      type: 'string',
      enum: ['input', 'answers', 'tbd_answers', 'decision', 'premise', 'measurement', 'domain'],
    },
    // ref: 原本の中の識別子（D-003 / 前提 2 / 計測 M-001 / 観点名）。input のように識別子を
    // 持たない原本では空でよい。
    ref: { type: 'string' },
    // quote: 原本からの引用。要約や言い換えではなく、原本に実在する文字列を写す
    // （照合側は文字列一致で確かめるため、言い換えると根拠なしとして扱われる）。
    quote: { type: 'string' },
  },
  required: ['item_id', 'kind', 'quote'],
}

const REQ_DOC_SCHEMA = {
  type: 'object',
  properties: {
    // 本文（markdown）は返させない。writer は [WRITE_BACK] のファイルに書き、script は本文を
    // 受け取らない（返させると文書全体を Write と返り値で 2 度出力させることになる）。
    // line_count: [WRITE_BACK] のファイルに対する `wc -l` の値。required にしない — 欠落で応答
    // ごと失わず、欠落は書き出し未確認として script が扱う（reportedLineCount）。
    line_count: { type: 'number' },
    // summary: requirements/INDEX.md の「文書一覧」に script が並べる。手書きの目次は
    // 必ず本体と drift するので、writer には要約だけ返させ、目次は script が組み立てる。
    summary: { type: 'string' },
    requirement_items: { type: 'array', items: ID_ITEM },
    trace: { type: 'array', items: TRACE_ITEM },
    tbd_items: { type: 'array', items: TBD_ITEM },
    categories_deferred: { type: 'array', items: { type: 'string' } },
    // referenced_ids: 本文で言及するがこの文書の項目ではない ID（他文書への参照、ID 体系の例示）。
    // 複数文書化で他文書 ID への言及は日常的に起きる。これが無いと正当な言及が「申告漏れ」と
    // され、writer は直しようのない指摘で改稿枠を空回りさせたうえ項目を捏造して埋める圧力を受ける。
    referenced_ids: { type: 'array', items: { type: 'string' } },
    // vacant_ids: この文書の欠番 ID（採番済みだが項目が存在しない ID）。表記規約が欠番の列挙を
    // 要求するため、本文に現れるが items にも referenced_ids にも属さない。申告が無いと
    // 構造検査が申告漏れとして毎 run 再検出する（#53）。
    vacant_ids: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'requirement_items', 'trace', 'tbd_items'],
}

const SPEC_DOC_SCHEMA = {
  type: 'object',
  properties: {
    // 本文（markdown）は返させない。writer は [WRITE_BACK] のファイルに書き、script は本文を
    // 受け取らない（返させると文書全体を Write と返り値で 2 度出力させることになる）。
    // line_count: [WRITE_BACK] のファイルに対する `wc -l` の値。required にしない — 欠落で応答
    // ごと失わず、欠落は書き出し未確認として script が扱う（reportedLineCount）。
    line_count: { type: 'number' },
    summary: { type: 'string' },
    spec_items: { type: 'array', items: ID_ITEM },
    trace: { type: 'array', items: TRACE_ITEM },
    traceability: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          requirement_id: { type: 'string' },
          spec_id: { type: 'string' },
          verification: { type: 'string' },
          status: { type: 'string', enum: ['未着手', '作成中', '完了'] },
        },
        required: ['requirement_id', 'spec_id', 'verification', 'status'],
      },
    },
    tbd_items: { type: 'array', items: TBD_ITEM },
    categories_deferred: { type: 'array', items: { type: 'string' } },
    referenced_ids: { type: 'array', items: { type: 'string' } },
    // vacant_ids: この文書の欠番 ID（採番済みだが項目が存在しない ID）。表記規約が欠番の列挙を
    // 要求するため、本文に現れるが items にも referenced_ids にも属さない。申告が無いと
    // 構造検査が申告漏れとして毎 run 再検出する（#53）。
    vacant_ids: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'spec_items', 'trace', 'traceability', 'tbd_items'],
}

// EXEC_SCHEMA: severity は blocking（着手できない）/ degraded（着手はできるが作り直しになりうる）。
// blocking だけを TBD として起票し直し、人間ゲート②の提示対象に入れる。
// direction: 解消の方向のみ（enum。refine.js の AUDIT_DIRECTIONS と同じ列挙）。旧 fix
// （自由記述の解消案）は廃止した — 検査者の文案は writer をアンカリングさせる
// （schemas/role-map.md を正とする）。direction_note は方向の補足 1 行に限る。
const AUDIT_DIRECTIONS = [
  'relax', 'tighten', 'make_measurable', 'choose_one', 'merge_or_split',
  'align_terms', 'add_trace', 'remove', 'document_decision', 'needs_human',
]
const EXEC_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          location: { type: 'string' },
          quote: { type: 'string' },
          issue: { type: 'string' },
          direction: { type: 'string', enum: AUDIT_DIRECTIONS },
          direction_note: { type: 'string' },
          severity: { type: 'string', enum: ['blocking', 'degraded'] },
          // action: 冗長指摘の処置（delete / merge_into:<ID> / replace_with_reference:<文書#ID>）。
          action: { type: 'string' },
        },
        required: ['id', 'location', 'quote', 'issue', 'direction', 'severity'],
      },
    },
    checked: { type: 'string' },
  },
  required: ['findings', 'checked'],
}

const parsedArgs = (typeof args === 'string' ? JSON.parse(args) : args) || {}

// role_opts: 司令塔が run ごとに役割の model / effort を上書きする口。表の値は既定であって、
// 点検が軽い・判断が易しいと分かっている run で下げ、難所で上げる判断は呼び出す側が持つ。
// 未知の役割名や値は止める（黙って既定に落ちると、指定したつもりの配分が効かない）。
const MODELS = ['haiku', 'sonnet', 'opus']
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
// READ_MODES: 監査役の本文の読み方（AUDITORS の read）。read を持たない役割（書き手・判定役）への
// 指定は止める — 読み方を切り替える口が無い役割に渡すと、指定したつもりで何も変わらない。
const READ_MODES = ['locate', 'full']
function applyRoleOverrides(tables, overrides) {
  const applied = {}
  for (const [name, o] of Object.entries(overrides || {})) {
    const target = tables.find((t) => t[name])
    if (!target) throw new Error(`args.role_opts の役割名が不明です: "${name}"`)
    if (!o || typeof o !== 'object') throw new Error(`args.role_opts.${name} はオブジェクトで渡してください`)
    if (o.model !== undefined && !MODELS.includes(o.model)) throw new Error(`args.role_opts.${name}.model が不正です: "${o.model}"`)
    if (o.effort !== undefined && !EFFORTS.includes(o.effort)) throw new Error(`args.role_opts.${name}.effort が不正です: "${o.effort}"`)
    if (o.read !== undefined && !READ_MODES.includes(o.read)) throw new Error(`args.role_opts.${name}.read が不正です: "${o.read}"`)
    if (o.read !== undefined && !('read' in target[name])) throw new Error(`args.role_opts.${name}.read は読み方を持つ監査役にだけ指定できます`)
    const next = { ...(o.model ? { model: o.model } : {}), ...(o.effort ? { effort: o.effort } : {}), ...(o.read ? { read: o.read } : {}) }
    Object.assign(target[name], next)
    applied[name] = { ...target[name] }
  }
  return applied
}
const roleOverrides = applyRoleOverrides([ROLE_OPTS], parsedArgs.role_opts)
if (Object.keys(roleOverrides).length) log(`role_opts で上書きした配分: ${JSON.stringify(roleOverrides)}`)

const SKILL_DIR = parsedArgs.skillDir
if (!SKILL_DIR) {
  throw new Error('args.skillDir が未指定です。SKILL.md の Workflow 呼び出し例に従ってください。')
}

const input = parsedArgs.input
if (!input || typeof input !== 'string' || !input.trim()) {
  throw new Error('args.input が空です。依頼文の全文を args.input に渡してください。')
}

// today: 文書中に日付が要るときの基準日。script 内では日時生成が禁止（resume の再現性を壊す）
// なので呼び出し側が渡すしかない。無ければ日付を推測で埋めさせず落とす。
const today = parsedArgs.today
if (!today) {
  throw new Error('args.today が未指定です。日付を推測で書かないため、ここで打ち切ります。')
}

const mode = parsedArgs.mode || 'new'
if (!['new', 'review', 'expand'].includes(mode)) {
  throw new Error(`args.mode が不正です: ${mode}（new / review / expand のいずれか）`)
}

// split_plan: 人間ゲート①でユーザーが承認した分割案。執筆側が自律的に分けると、同じ案件を
// 再実行するたびにファイル構成が変わる。だから構成は args で固定して渡す。
const splitPlan = parsedArgs.split_plan || {}
// existing_docs はパス（path）で持つ。書き手も checker も本文をそのパスから読む。本文を args に
// 埋めると、司令塔が数十万字を書き写す経路が生まれ、写し間違いを誰も検出できない。
// line_count（`wc -l` の値）を添えると、書き手への区切り読みの指示が行数から決まる。
const existingDocs = parsedArgs.existing_docs || []
const hasBody = (d) => Boolean(d.path)
// agent に本文を渡す経路はパスだけである（プロンプトへ本文を埋めない）。markdown だけで渡された
// 既存文書は誰も読めないので入口で止める（黙って対象から外すと、レビュー対象が消える）。
{
  const bodyOnly = existingDocs.filter((d) => d && d.markdown && !d.path)
  if (bodyOnly.length) {
    throw new Error(
      `existing_docs に path の無い文書があります: ${bodyOnly.map((d) => `${d.kind}/${d.topic}`).join(' / ')}。` +
        'agent は本文をパスから Read するため、path を付けて渡してください。'
    )
  }
}

// draft_dir: writer が初稿を書き出す workspace のディレクトリ（絶対パス）。以後の agent（実行可能性の
// 検査・仕様書の writer・Workflow B）は本文をこのファイルから Read する。対象リポジトリには書かない。
const draftDir = String(parsedArgs.draft_dir || '').trim().replace(/\/+$/, '')
if (!draftDir.startsWith('/')) {
  throw new Error(
    `args.draft_dir が絶対パスではありません: "${draftDir}"。writer は初稿を workspace へ Write し、` +
      'agent は以後そのパスを Read する。Write は ~ を展開しないため絶対パスで渡してください。'
  )
}
const draftPathOf = (kind, topic) => `${draftDir}/${kind}-${topic}.md`

// self_containment: 「何を文書に書き写し、何を参照にとどめるか」の合意。
// これを executability-auditor に渡さないと、参照方針を採る案件で「文書だけでは 1 語も
// 確定しない」という指摘が語彙リストの数だけ量産され、本物の欠落がその中に埋もれる。
const selfContainment = parsedArgs.self_containment || ''
const answers = parsedArgs.answers || '(事前ヒアリングなし。既定は [DECISIONS] を、未回答項目は TBD を見よ)'
// decisions: intake（既定選定係）が起票した決定ログ。書式と受理条件は
// references/question-policy.md が正。これが CONTEXT に無いと、writer は既定を使った箇所の
// 出所を説明できず、外部規格や依頼者回答の名を借りて偽装する（実測: JIS Z 8301 準拠の捏造宣言）。
const decisions = parsedArgs.decisions || []
const inputTbdItems = parsedArgs.tbd_items || []
const domainFindings = parsedArgs.domain_findings || []
const requiredCategories = parsedArgs.required_categories || []

// targets: このランで生成してよい文書種別。ここが制御フローに現れていないと、
// 「既存の要求文書をレビューして」の依頼で頼まれていない仕様書が丸ごと新規生成され、
// このスキルが防ぐと宣言した「要求の捏造」を script 自身が犯す。
let targets
if (mode === 'new') {
  // new でも生成対象は split_plan に載った kind だけ。document-splitting.md §0 は
  // 「要件だけまとめて」のような片方名指しを認めており、両 kind を固定すると
  // requirements のみの依頼で頼まれていない仕様書が新規生成される（＝要求の捏造の script 版）。
  targets = ['requirements', 'specifications'].filter(
    (kind) => Array.isArray(splitPlan[kind]) && splitPlan[kind].length
  )
  if (!targets.length) {
    throw new Error('args.split_plan に requirements も specifications もありません。人間ゲート①で承認された分割案をそのまま渡してください。')
  }
} else if (mode === 'expand') {
  if (!existingDocs.some((d) => d.kind === 'requirements' && hasBody(d))) {
    throw new Error('mode=expand には kind="requirements" の existing_docs が必要です。展開元が無いまま新規執筆に化けるのを防ぐため、ここで打ち切ります。')
  }
  targets = ['specifications']
} else {
  const kinds = [...new Set(existingDocs.filter(hasBody).map((d) => d.kind))]
  if (!kinds.length) {
    throw new Error('mode=review には本文を持つ existing_docs が必要です。レビュー対象が無いまま新規執筆に化けるのを防ぐため、ここで打ち切ります。')
  }
  targets = kinds
}

for (const kind of targets) {
  if (!Array.isArray(splitPlan[kind]) || !splitPlan[kind].length) {
    throw new Error(`args.split_plan.${kind} が空です。人間ゲート①で承認された分割案をそのまま渡してください（承認と違う構成で書き始めないため）。`)
  }
}

// paths: 保存先。A と B で同じ値を渡さないと、本文と INDEX が別ディレクトリに分裂する。
const paths = parsedArgs.paths || {}
const reqDir = paths.requirements || 'docs/requirements'
const specDir = paths.specifications || 'docs/specifications'
const dirOf = (kind) => (kind === 'requirements' ? reqDir : specDir)

// areaCode: ID の領域プレフィックス。doc_check.mjs の ID_IN_TEXT が英字始まりしか拾わないので、
// topic が数字始まりでも必ず英字始まりへ正規化する。ここを検出側と揃えていないと、
// writer が申告した ID が本文から 1 件も抽出されず、全件が「幽霊 ID」として失格になる。
const areaCode = (t) => {
  const s = String(t).toUpperCase().replace(/[^A-Z0-9]/g, '')
  return /^[A-Z]/.test(s) ? s : `X${s}`
}

// tbdPrefix: TBD の領域には kind も混ぜる。requirements と specifications で同じ topic を
// 使う分割（1:1 に揃える形は自然で、そうすると covers が機械的に決まる）では、
// topic だけを領域にすると両側が同じ TBD-<TOPIC>-001 を振り、統合時に片方が消える。
// PR- / SP- は接頭辞そのものが kind を持つのでこの問題が起きない。TBD だけが持つ穴。
const tbdPrefix = (doc) => `TBD-${doc.kind === 'requirements' ? 'R' : 'S'}${areaCode(doc.topic)}-`

// areaCode の衝突検査。`auth-v1` と `auth_v1` は同じ AUTHV1 になり、別文書の ID が
// 見分けられなくなる。承認された分割案の問題なので、script が勝手に別名を作らず打ち切る。
for (const kind of targets) {
  const seen = new Map()
  for (const d of splitPlan[kind]) {
    const code = areaCode(d.topic)
    if (seen.has(code)) {
      throw new Error(
        `分割案の topic「${seen.get(code)}」と「${d.topic}」が同じ ID 領域コード（${code}）になります。` +
          'ID が文書を跨いで一意にならないため、どちらかの topic 名を変えて人間ゲート①からやり直してください。'
      )
    }
    seen.set(code, d.topic)
  }
}

// 承認された分割案と、渡された既存文書の対応検査。ここが無いと、splitter が既存とは
// 違う topic 名を提案した場合に「既存文書の改稿」が「別名ファイルの新規執筆」に化け、
// レビュー対象だった本文がどの返り値にも現れないまま消える。
{
  const orphanExisting = existingDocs
    .filter((d) => targets.includes(d.kind) && hasBody(d))
    .filter((d) => !(splitPlan[d.kind] || []).some((p) => p.topic === d.topic))
  if (orphanExisting.length) {
    throw new Error(
      '渡された既存文書のうち、分割案に対応する topic が無いものがあります: ' +
        orphanExisting.map((d) => `${d.kind}/${d.topic}`).join(' / ') +
        '。このまま進めると既存の本文が処理されないまま消えます。分割案を既存の topic に合わせてから再実行してください。'
    )
  }
}

const docKey = (kind, topic) => `${kind}/${topic}`
const previousOf = (kind, topic) => {
  const hit = existingDocs.find((d) => d.kind === kind && d.topic === topic && hasBody(d))
  if (!hit) return null
  return `${readInstruction(hit.path, Number.isInteger(hit.line_count) ? hit.line_count : null)}\nその全文を既存の同名文書として扱うこと（ここには写していない）。`
}
// 対象外の種別は「入力として固定」する。改稿もしないし生成もしない。path だけで渡された文書も
// 含める（本文が手元に無い分、script の構造検査は申告済みの items / ids しか使えない）。
const fixedDocs = existingDocs.filter((d) => !targets.includes(d.kind) && hasBody(d))

const CONTEXT_BLOCK = [
  '# [MODE] 実行モード',
  `${mode}（このランで作成してよい文書種別: ${targets.join(' / ')}）`,
  '',
  '# [SKILL_PREMISES] スキルが固定する前提（案件ごとに問い直さない）',
  `${SKILL_DIR}/references/fixed-premises.md を Read し、そこに列挙された前提を執筆・検査の`,
  '枠組みとして使うこと。前提由来の書き方の選択は根拠欄に `（スキル既定: 前提 N）` と書く。',
  '前提は案件の確定要求の根拠にはならない（区別は同ファイルの末尾節を正とする）。',
  '',
  '# [INPUT] 依頼文（確定要求の根拠その 1）',
  input,
  '',
  '# [ANSWERS] 人間ゲート①でユーザーが回答した内容（確定要求の根拠その 2）',
  answers,
  '',
  '# [DECISIONS] 決定ログ（確定要求の根拠その 4。既定として選ばれた書き方・進め方）',
  '出所は `（既定: D-N）` と表記する。書式と使ってよい範囲は references/question-policy.md を正とする。',
  JSON.stringify(decisions, null, 2),
  '',
  '# [TBD_ITEMS] 持ち越された未確定事項',
  JSON.stringify(inputTbdItems, null, 2),
  '',
  '# [DOMAIN_FINDINGS] ドメイン分析の三値判定と根拠',
  JSON.stringify(domainFindings, null, 2),
  '',
  '# [REQUIRED_CATEGORIES] 反映が必須の追加要求カテゴリ',
  JSON.stringify(requiredCategories, null, 2),
  '',
  '# [SPLIT_PLAN] ユーザーが承認した分割案（この構成から外れないこと）',
  JSON.stringify(splitPlan, null, 2),
  '',
  '# [TODAY] 文書中に日付を書く必要が生じたときの基準日（推測で日付を書かない）',
  today,
  '',
  '# [NO_CHANGELOG] 改稿の経緯を成果物に残さない',
  '**変更履歴の章を置かない。** 版・日付・変更者・承認者・変更内容のいずれも書かない。',
  '文書の改訂履歴はバージョン管理が持つ。文書側に二重に持つと必ず片方が古くなる。',
  '本文にも「前稿は〜」「この版では〜」のような経緯を書かない。読み手が必要とするのは今の内容だけである。',
  '',
  '',
  '**既存実装は根拠にならない。** 対象のコードを読んでよい場合でも、「実装がこうなっている」を',
  '要求の根拠にしてはならない。読んでよいことと、根拠にできることは別である。',
  '読み取った振る舞いは**仕様**に書き、要求にはその**目的**を書く（根拠は依頼文・回答の側にある）。',
  '目的が入力から辿れないものは、実装をなぞらず **TBD として起票**すること。',
  '「動いているコード」は業界の常識より説得力があるように見えるが、ユーザーがそれを要求した',
  '根拠にはならない。詳細は references/requirement-writing-rules.md §4「既存実装は根拠にならない」。',
  '上記 INPUT と ANSWERS に根拠が無い要求を書いてはならない。情報が足りない箇所は文面で埋めず、',
  'TBD 項目として起票したうえで、その章を飛ばさずに書き切ること。初稿の目的は完成ではなく、',
  '全体像を出して「何が足りないか」を見えるようにすることである。',
].join('\n')

// ------------------------------------------------------- 役割ファイルと契約の渡し方
//
// この区間は scripts/draft.js と scripts/refine.js で逐語で同一である（一致と行範囲は
// tests/test_prompt_budget.py が検査する）。
// ROLE_HEADER_BEGIN
// CONTRACT_LINES: schemas/agent-contracts.md の節の行範囲（1 始まり・両端を含む）。このファイルは
// 500 行を超え、行範囲の無い Read は shunt の gate（350 行超）に止められて 1 ターン無駄になる。
// § の名前だけを渡すと agent はファイル全体を探して読む — validity・clarity などは固有の節を
// 持たず共通形を使うので、存在しない節を探し回ることになる。値は見出しから導いたもので、
// 実ファイルの見出しとの一致をテストが照合する（ファイルを直したらこの表も直す）。
const CONTRACT_LINES = {
  'req-writer': [99, 156],
  'spec-writer': [157, 200],
  auditor: [201, 282],
  'executability-auditor': [283, 325],
  'ladder-judge': [326, 371],
  resolver: [372, 402],
  'resolver-verifier': [403, 426],
  'precedent-judge': [427, 462],
  measurement: [463, 488],
}

// READ_SCOPE: 読んでよい範囲の宣言。役割に要る指示と契約は roleHeader が渡すもので完結している。
// スキル自身の実装や他の役割の指示を読んでも判断は変わらず、読んだ分は以後の全ターンの文脈に
// 載り続ける（実測: measurement 1 体が SKILL.md・scripts/・references を読み回って Bash 42 回・
// キャッシュ読み 1,540 万トークン）。
const READ_SCOPE =
  '読む範囲: 上の役割ファイルと契約の範囲、このプロンプトが名指しするファイルと行範囲だけを読む。' +
  'このスキルの SKILL.md・scripts/・他の役割の agents/*.md・名指しされていない references/ と schemas/ は' +
  'この役割の範囲外なので読まない（読んでも判断は変わらず、読んだ量だけ以後の全ターンが重くなる）。' +
  'ここで範囲外とする references/ は、このプロンプトと役割ファイルのどちらも名指ししていないものに限る。' +
  '役割ファイルが references/ の節を指しているときは、それを読む — 添えられた行範囲だけを offset/limit で読む。'

// roleHeader: 役割ファイル（いずれも 350 行未満なので 1 回で読める）と契約の節を渡す冒頭。
function roleHeader(skillDir, roleFiles, contractKey) {
  const range = CONTRACT_LINES[contractKey]
  if (!range) throw new Error(`契約の節が未定義の役割です: ${contractKey}`)
  const files = roleFiles.map((f) => `${skillDir}/agents/${f}`)
  return [
    `Read ${files.join(' and then ')} for your full role instructions before doing anything else.`,
    `契約（返り値の形）: Read ${skillDir}/schemas/agent-contracts.md offset=${range[0]} limit=${range[1] - range[0] + 1}（この範囲だけが契約。ファイルの他の節は読まない）。`,
    READ_SCOPE,
  ].join('\n')
}

// RULES_NOTE: 執筆・監査の規律の正本。どれも必要な節だけを読めば足りる。350 行を超える
// document-structure.md（407 行）を行範囲なしで Read すると gate に止められる。
function rulesNote(skillDir) {
  return [
    `規律は ${skillDir}/references/requirement-writing-rules.md ・`,
    `${skillDir}/references/document-structure.md ・${skillDir}/references/traceability.md ・`,
    `${skillDir}/references/document-splitting.md ・${skillDir}/references/citation-policy.md を正とする。`,
    'いずれも通読しない。判断に要る節だけを見出しの Grep（`^## `）で探し、300 行以内の offset/limit で Read する。',
  ].join('\n')
}
// INLINE_SCOPE: 役割ファイルを持たず、指示と材料をプロンプトに収めた係（先例裁定・終端裁定）の宣言。
const INLINE_SCOPE =
  '読む範囲: 役割の指示と材料はこのプロンプトで完結している。このスキルの SKILL.md・scripts/・agents/・' +
  'schemas/ と、名指しされていない references/ は読まない（読んでも判断は変わらず、読んだ量だけ以後の全ターンが重くなる）。'
// ROLE_HEADER_END

const RULES = rulesNote(SKILL_DIR)

// ------------------------------------------------------- 本文の渡し方（パスのみ）
//
// この区間の関数は scripts/refine.js に逐語で複製されている（一致は tests/test_prompt_budget.py が検査する）。
// 行数の計算は本文を要するので scripts/doc_check.mjs にある。
//
// READ_CHUNK_LINES: 1 回の Read の上限行数。shunt の PreToolUse gate は 350 行を超える無制限 Read を
// 止めて要約器へ回しうるため、その手前で区切る。監査者は要約ではなく逐語を見なければならない。
const READ_CHUNK_LINES = 300

// readInstruction: 本文の代わりにプロンプトへ入れる Read 指示。行数が分からないときも
// 「一度に全体を読め」とは書かない — 350 行を超える一括 Read は gate に止められるため。
// ranges を渡すと、その範囲だけを読ませる（空配列は「今回変更なし」）。
function readInstruction(path, lineCount, ranges) {
  const chunks = (start, end) => {
    const out = []
    for (let s = start; s <= end; s += READ_CHUNK_LINES) {
      out.push(`- Read ${path} offset=${s} limit=${Math.min(READ_CHUNK_LINES, end - s + 1)}`)
    }
    return out
  }
  if (Array.isArray(ranges)) {
    if (!ranges.length) {
      return `本文: ${path}（今回の改稿で変更された節は無い。照合に要る箇所だけを ${READ_CHUNK_LINES} 行以内の offset/limit で Read すること）`
    }
    const out = [`本文: ${path}（次の範囲だけを Read すること。全体は読まない）`]
    for (const r of ranges) {
      if (r.deleted) {
        out.push(`- 削除された節「${r.heading || '(冒頭)'}」（${r.start} 行目の直前にあった。削除で生じた欠落・参照切れだけを確かめる）`)
      } else {
        out.push(`節「${r.heading || '(冒頭)'}」: ${r.start}〜${r.end} 行`, ...chunks(r.start, r.end))
      }
    }
    return out.join('\n')
  }
  if (lineCount && lineCount <= READ_CHUNK_LINES) return `本文: ${path}（${lineCount} 行。Read すること）`
  if (lineCount) {
    return [`本文: ${path}（${lineCount} 行。1 回の Read で全体を読まず、次の単位で順に Read すること）`, ...chunks(1, lineCount)].join('\n')
  }
  return `本文: ${path}（行数未確認。1 回の Read で全体を読まず、offset/limit を付けて ${READ_CHUNK_LINES} 行ずつ末尾まで順に Read すること）`
}

// ------------------------------------------------------- 本文の渡し方ここまで

// ------------------------------------------------------- 本文の検査（checker 経由。draft/refine 共通）
//
// 本文を要する決定的な検査（構造検査・行数・変更範囲）の正本は scripts/doc_check.mjs である。
// workflow script はファイルを読めないので、checker agent に入力を渡してその CLI を実行させ、
// 出力だけを受け取る。この区間の関数は scripts/refine.js に逐語で複製されている（workflow script は
// import を書けない。一致と doc_check.mjs 側の定義との一致は tests/test_doc_check.py が検査する）。

// canonicalJson: キーを並べ替えた JSON（doc_check.mjs と同じ定義）。checker は入力を書き写し、
// 出力を構造化して返すので、キー順や空白が変わっても同じ文字列になる形で digest を比べる。
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value === undefined ? null : value)
}

// checkerDoc: doc_check.mjs に渡す 1 文書。検査が読むフィールドだけに絞る — checker は入力を
// 書き写すので、量がそのまま出力トークンと写し間違いの機会になる（trace は item_id だけで足りる）。
function checkerDoc(d, prevPath) {
  return {
    key: d.key,
    kind: d.kind,
    topic: d.topic,
    path: d.draft_path,
    ...(prevPath ? { prev_path: prevPath } : {}),
    fixed: Boolean(d.fixed),
    ids: d.ids || [],
    referenced: d.referenced || [],
    vacant: d.vacant || [],
    traceability: (d.traceability || []).filter(Boolean).map((l) => ({ requirement_id: l.requirement_id, spec_id: l.spec_id })),
    tbd_items: (d.tbd_items || []).filter(Boolean).map((t) => ({ id: t.id, text: t.text, blocking: t.blocking })),
    ...(Array.isArray(d.trace) ? { trace: d.trace.map((t) => ({ item_id: t ? t.item_id : undefined })) } : {}),
    ...(d.extract_ids ? { extract_ids: true } : {}),
  }
}

const CHECK_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    error: { type: 'string' },
    output: { type: 'object' },
  },
  required: ['ok'],
}

// checkerPrompt: checker は判断をしない。書いて・実行して・出力を返すだけにする（判断させると、
// 検査結果の取捨が agent の注意に依存する）。
function checkerPrompt(input, file, skillDir) {
  const quote = (p) => `'${String(p).replace(/'/g, `'\\''`)}'`
  const dir = file.slice(0, file.lastIndexOf('/'))
  return [
    'あなたは checker である。判断・要約・手直しはしない。次の 3 手順だけを行う。',
    `1. Bash で書き出し先を作る: mkdir -p ${quote(dir)}`,
    `2. 末尾の [INPUT] の JSON を 1 文字も変えずに Write で ${file} に書く（整形し直さない・省略しない・要約しない）。`,
    '3. Bash で次を実行する（cd しない。相対パスは今のカレントディレクトリ基準で解決される）:',
    `   node ${quote(`${skillDir}/scripts/doc_check.mjs`)} ${quote(file)}`,
    '終了コードが 0 なら、標準出力の JSON を parse した値をそのまま output に入れて ok: true を返す',
    '（フィールドを足さない・削らない・言い換えない。script が digest で写しを照合する）。',
    '0 以外なら ok: false とし、標準エラーの内容を error に入れて返す。直してやり直さない。',
    '',
    '# [INPUT]',
    JSON.stringify(input),
  ].join('\n')
}

// 構造検査の文面。doc_check.mjs は指摘を短い形（種別・文書・引数）で出し、文面はここで組み立てる。
// 以下の FINDING_TEXT_BEGIN〜END は scripts/doc_check.mjs の同区間の逐語の写しである（workflow script は
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

// verifyCheck: checker の返り値を受理してよいかを script が決める。schema では写し間違い（指摘の
// 脱落・入力の欠け）を検出できないので、doc_check.mjs が出した digest と script が計算した digest を
// 照合する。受理できなければ「検査を実行できなかった」として扱う（0 件に読み替えない）。
function verifyCheck(res, input) {
  if (!res) return { ok: false, reason: 'checker が応答しなかった' }
  if (!res.ok || !res.output) return { ok: false, reason: `doc_check.mjs の実行に失敗した: ${res.error || '(理由の記載なし)'}` }
  const out = res.output
  if (out.input_digest !== stableKey(canonicalJson(input))) {
    return { ok: false, reason: 'checker が書いた入力が渡した JSON と一致しない（input_digest 不一致）' }
  }
  if (!Array.isArray(out.documents) || !out.structural || !Array.isArray(out.structural.findings) || !Array.isArray(out.structural.not_checked)) {
    return { ok: false, reason: 'doc_check.mjs の出力の形が契約と違う' }
  }
  // index_extra は渡したときだけ出力に載る（canonicalJson は undefined のキーを落とすので、無いときの digest は変わらない）。
  if (out.output_digest !== stableKey(canonicalJson({ documents: out.documents, structural: out.structural, index_extra: out.index_extra }))) {
    return { ok: false, reason: 'checker が返した出力が CLI の出力と一致しない（output_digest 不一致）' }
  }
  const byKey = new Map(out.documents.map((d) => [d.key, d]))
  const lost = input.documents.filter((d) => !byKey.has(d.key)).map((d) => d.key)
  if (lost.length) return { ok: false, reason: `出力に無い文書がある: ${lost.join(' / ')}` }
  // digest は短い形のまま照合し、受理した後で文面を組み立てる（文面は digest の外にあるので、
  // checker の写しに文面を含める必要が無い）。未知の種別は写し間違いと同じく受理しない。
  let structural
  try {
    structural = expandStructural(out.structural)
  } catch (e) {
    return { ok: false, reason: `構造検査の出力を展開できない: ${e && e.message ? e.message : e}` }
  }
  return { ok: true, byKey, structural, indexExtra: Array.isArray(out.index_extra) ? out.index_extra : [] }
}

// reportedLineCount: writer が返した `wc -l` の値。欠けていれば null（書き出し未確認）。
function reportedLineCount(result) {
  if (!result || result.line_count === undefined || result.line_count === null) return null
  const n = Number(String(result.line_count).trim())
  return Number.isInteger(n) ? n : null
}

// lineCountConfirmed: writer が申告した行数と、checker が実ファイルで数えた行数の照合。
// `wc -l` は改行の数なので、末尾が改行で終わらないファイルでは 1 少ない。どちらかに一致すれば
// 受理する。ファイルが無ければ受理しない（以後の agent はファイルしか読めない）。
function lineCountConfirmed(reported, fileCheck) {
  if (reported === null || !fileCheck || !fileCheck.exists) return false
  return reported === fileCheck.newline_count || reported === fileCheck.line_count
}

// ------------------------------------------------------- 本文の検査ここまで

// writeBackLines: 初稿は全文を 1 回だけ Write させる。本文を返り値にも入れさせると、同じ全文を
// 2 度出力することになる。script はファイルを checker 経由で照合し、以後の agent もファイルを読む。
function writeBackLines(file) {
  return [
    `本文を ${file} に Write すること。本文は返り値に入れない（script は本文を受け取らない）。`,
    `Write の後に \`wc -l < ${file}\` を実行し、出た整数を返り値の line_count に入れること。`,
    '書いた本文を Read し直して確かめない。行数・ID の申告と本文の突き合わせ・構造は script が checker で検査する',
    '（通読し直すと、文書全体が以後のターンに載り続ける）。',
    '以後の agent はこのファイルを Read する（本文をプロンプトで渡さない）。line_count がファイルの行数と',
    '食い違うと書き出しの失敗として扱われる。保存先（パス欄）には書かない — 保存は人間の承認後に司令塔が行う。',
  ]
}

function buildReqPrompt(doc) {
  const previous = previousOf('requirements', doc.topic)
  return [
    roleHeader(SKILL_DIR, ['writer-common.md', 'req-writer.md'], 'req-writer'),
    RULES,
    '',
    CONTEXT_BLOCK,
    '',
    '# [THIS_DOCUMENT] あなたが書く 1 文書',
    `パス: ${reqDir}/${doc.topic}.md`,
    `扱う関心事: ${doc.concern || '(分割案に記載なし)'}`,
    `ID の領域プレフィックス: PR-${areaCode(doc.topic)}-`,
    `未確定事項の ID: ${tbdPrefix({ kind: 'requirements', topic: doc.topic })}001 の形で振ること（この形以外で振らない）。`,
    '各文書は並列に書かれ、互いの採番を知らない。領域を冠さないと別文書の TBD と番号が衝突し、',
    '統合時に片方が消える。消えた側が着手を止める項目でも、人間に提示されないまま完了する。',
    'この関心事の外側は書かない。他文書の担当範囲に踏み込むと同じ要求が複数文書に並び、',
    'consistency 監査で重複として毎回指摘される。他文書の ID に言及する必要があるときは',
    'referenced_ids に入れること（入れないと申告漏れとして検出される）。欠番（採番済みだが項目が',
    '存在しない ID）は本文に「欠番」の語と同じ行で列挙し、vacant_ids にも申告すること。',
    '',
    previous
      ? ['# [PREVIOUS] 既存の同名文書（これを下敷きに改稿する。指摘の無い箇所は維持すること）', previous].join('\n')
      : '# 新規執筆（前稿なし）',
    '',
    '# [WRITE_BACK] 初稿の書き出し',
    ...writeBackLines(draftPathOf('requirements', doc.topic)),
  ].join('\n')
}

function buildSpecPrompt(doc, requirementsContext) {
  const previous = previousOf('specifications', doc.topic)
  return [
    roleHeader(SKILL_DIR, ['writer-common.md', 'spec-writer.md'], 'spec-writer'),
    RULES,
    '',
    CONTEXT_BLOCK,
    '',
    '# [REQUIREMENTS] 全 requirements 文書（仕様項目はここの要求 ID と紐付けること）',
    requirementsContext || '(requirements は本ランの対象外。既存の要求 ID との紐付けを維持し、新たな要求を作らないこと)',
    '',
    '# [THIS_DOCUMENT] あなたが書く 1 文書',
    `パス: ${specDir}/${doc.topic}.md`,
    `扱う関心事: ${doc.concern || '(分割案に記載なし)'}`,
    `カバーする requirements 文書: ${(doc.covers || []).join(' / ') || '(分割案に記載なし)'}`,
    `ID の領域プレフィックス: SP-${areaCode(doc.topic)}-`,
    `未確定事項の ID: ${tbdPrefix({ kind: 'specifications', topic: doc.topic })}001 の形で振ること（この形以外で振らない）。`,
    '各文書は並列に書かれ、互いの採番を知らない。領域を冠さないと別文書の TBD と番号が衝突し、',
    '統合時に片方が消える。消えた側が着手を止める項目でも、人間に提示されないまま完了する。',
    'トレーサビリティ表は「あなたがカバーする要求の分だけ」をこの文書に持つこと。',
    '全要求を書き写すと他の仕様文書と重複し、どちらが正か決まらなくなる。',
    '',
    previous
      ? ['# [PREVIOUS] 既存の同名文書（これを下敷きに改稿する。指摘の無い箇所は維持すること）', previous].join('\n')
      : '# 新規執筆（前稿なし）',
    '',
    '# [WRITE_BACK] 初稿の書き出し',
    ...writeBackLines(draftPathOf('specifications', doc.topic)),
  ].join('\n')
}

function buildExecPrompt(doc) {
  return [
    roleHeader(SKILL_DIR, ['executability-auditor.md'], 'executability-auditor'),
    '',
    '（この役割前提の正は agents/executability-auditor.md。ここは注入用の要約で、食い違ったら agent md 側に従うこと）',
    'あなたはこの文書を渡された実装担当者である。仕様の意図を知らず、書いてあるとおりにしか',
    '作れない。**依頼文も分析結果も持っていない**（他の文脈を足して読むと「実際には渡されない',
    '情報」で補完してしまい、検査の意味が消える）。',
    '',
    'ただし、**この文書が参照先として明示しているファイルは読めるものとして扱うこと。**',
    '文書が「詳細は X を正とする」と書いている場合、実装担当者は X を開ける。したがって',
    '**X を見れば分かることを「文書に書かれていないから着手できない」と判定してはならない。**',
    '判定すべきは「参照先を開いても、なお決まらないこと」である。',
    '参照先が実在しない・参照先を見ても該当箇所が無い場合は、それ自体を指摘すること。',
    '',
    '# [SELF_CONTAINMENT] この案件で合意した自己完結度の方針',
    selfContainment ||
      '(指定なし。文書本体と、文書が参照先として明示しているファイルの範囲で判定すること)',
    '',
    `# [DOCUMENT] ${doc.key}`,
    readInstruction(doc.draft_path, Number.isInteger(doc.line_count) ? doc.line_count : null),
    '',
    '各指摘は「ここで手が止まる。なぜなら〜が分からないから」の形で書き、severity に',
    'blocking（着手できない）か degraded（着手はできるが後で作り直しになりうる）を必ず付けること。',
    '指摘が 0 件ならば findings は空配列で返すこと。0 件であること自体が報告に値する。',
    '検査した範囲を checked に必ず記述すること（何も読まずに findings: [] を返す余地を残さないため）。',
  ].join('\n')
}

// execToTbd: blocking の実行可能性指摘を TBD として起票し直す（draft/refine 共通）。
// ID は文書・箇所から決まる安定キーにする。連番にすると、指摘が 1 件増減しただけで
// 既提示の TBD-005 が別の内容を指すようになり、presented_tbd_ids の突き合わせが壊れる。
// 名前空間を TBD-EX- と分けているのは、writer が立てた TBD と script が起票した TBD を
// 読み手が区別できるようにするため。
function stableKey(text) {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36).padStart(7, '0').slice(-7)
}

function execToTbd(findings) {
  return findings
    .filter((f) => f.severity === 'blocking')
    .map((f) => ({
      // キーに issue を含める。document|location だけだと、同じ章に対する複数の指摘
      // （「単位が無い」と「失敗時の挙動が無い」）が同一 ID に潰れ、片方が黙って消える。
      // issue は指摘の内容そのものなので、同一指摘は再実行しても同じキーになる。
      id: `TBD-EX-${stableKey(`${f.document}|${f.location}|${f.issue}`)}`,
      // text は issue の要旨のみ。監査者由来の解消案を焼き込まない（writer のアンカリング防止。
      // 解消候補は resolver の出力が candidates に digest 参照付きで入る経路だけを使う）。
      text: `${f.issue}`,
      owner: '',
      due: '',
      blocking: true,
      source: 'executability',
      source_finding_id: f.id,
      document: f.document,
      location: f.location,
    }))
}

// mergeTbd: 同じ TBD が複数文書から重複して届く。無条件連結すると「TBD 2 件の案件」が
// 「TBD 8 件」として報告される。id で統合し、blocking は安全側（OR）に倒す。
function mergeTbd(lists) {
  const map = new Map()
  for (const item of lists.flat()) {
    if (!item || !item.id) continue
    const prev = map.get(item.id)
    if (!prev) {
      map.set(item.id, { ...item })
      continue
    }
    map.set(item.id, {
      ...prev,
      ...item,
      text: prev.text || item.text,
      owner: prev.owner || item.owner || '',
      due: prev.due || item.due || '',
      blocking: Boolean(prev.blocking || item.blocking),
    })
  }
  return [...map.values()]
}

function blocked(reason, extra) {
  return {
    status: 'BLOCKED',
    verdict: 'draft_incomplete',
    reason,
    mode,
    targets,
    documents: [],
    requirement_ids: [],
    spec_ids: [],
    tbd_items: inputTbdItems,
    blocking_tbd_ids: [],
    executability: { findings: [], blocking_count: 0, degraded_count: 0, missing: [] },
    structural_findings: [],
    categories_deferred: [],
    writer_missing: [],
    summary: null,
    ...extra,
  }
}

// ------------------------------------------- TBD の名前空間化（draft/refine 共通）

// 分割文書は並列に書かれて互いの採番を知らないため、同じ `TBD-003` が別の論点に振られうる。
// 統合前に所属文書のコードを冠して、衝突で片方が消えるのを防ぐ。
//
// **統合先が ID をキーにした Map である以上、これは保険ではなく前提条件である。**
// refine の `rebuildTbd` は `map.set(item.id, {...base, ...item})` で組み直すので、素の ID が
// 2 文書から来ると後勝ちに潰れるだけでなく、両者のフィールドが混ざった項目ができる。さらに
// 前ラウンドが `TBD-RAUTH-001`、今回が素の `TBD-001` だと**同じ論点が別 ID として扱われ**、
// 前者は resolved（解決した）に落ち、後者は presented を失って「未提示の新規」に化ける。
// `unpresented_blocking` は完成条件そのものなので、ここが崩れると完成判定が壊れる。
//
// writer のプロンプトには接頭辞付きの形で振るよう明記してあるが、それでも素の ID が返る。
// 是正は構造検査（ST-DUP-TBD / 下記 ST-TBDRENUM）が writer に差し戻し、ここは実害を止める。
//
// 振り直し先が同一文書内の既存 ID と一致したら、畳まずに未使用の最小連番へ退避する。素朴に
// 振り直すと、writer が TBD-001 と TBD-<領域>-001 を両方返した場合に両者が同じ ID へ落ち、
// 統合で片方の内容が黙って消える — **この処理が防ごうとしている事象を、この処理自身が起こす。**
const namespaceTbd = (documents) => {
  const findings = []
  const byKey = {}
  const items = documents.flatMap((d) => {
    const prefix = tbdPrefix(d)
    const src = (d.tbd_items || []).filter((t) => t && t.id)
    // 振り直しの要らないもの（既に接頭辞を持つ／TBD-EX-）を先に席として確保する。
    // 後回しにすると振り直した側が先に席を取り、正しい採番の側を追い出す。
    const taken = new Set(
      src.filter((t) => t.id.startsWith(prefix) || t.id.startsWith('TBD-EX-')).map((t) => t.id)
    )
    const out = []
    for (const t of src) {
      if (t.id.startsWith(prefix) || t.id.startsWith('TBD-EX-')) {
        out.push({ ...t, document: t.document || d.key })
        continue
      }
      let id = `${prefix}${t.id.replace(/^TBD-/, '')}`
      if (taken.has(id)) {
        const collided = id
        let n = 1
        while (taken.has(`${prefix}${String(n).padStart(3, '0')}`)) n++
        id = `${prefix}${String(n).padStart(3, '0')}`
        findings.push({
          auditor: 'structural',
          id: `ST-TBDRENUM-${id}`,
          document: d.key,
          location: '未確定事項',
          quote: t.id,
          issue: `未確定事項 ${t.id} を所属文書の接頭辞で振り直すと ${collided} になり、同じ文書の既存の項目と一致した。畳むと片方の内容が消えるため ${id} へ退避した。採番が文書内で衝突している。`,
          fix: `この文書の未確定事項の採番を、${prefix} を冠した連番で振り直す（接頭辞の有無が混在している）。`,
        })
      }
      taken.add(id)
      out.push({ ...t, id, document: t.document || d.key })
    }
    // 所属は「どの文書の tbd_items に載っていたか」で決める。t.document を信じて振り分けると、
    // 前ラウンドから引き継がれた古い document 値で別の文書へ紛れ込む。
    byKey[d.key] = out
    return out
  })
  return { items, findings, byKey }
}

// ------------------------------------------- categories_deferred の照合（draft/refine 共通）

// `categories_deferred` は coverage-auditor に対する免罪符である —「導出カテゴリのうち TBD に
// 落としたものを反映漏れとして指摘するな」というリスト。したがって **`required_categories` に
// 無い名前は何も免除しない。**
//
// 無害でもない。coverage-auditor は「deferred に挙がっているのに TBD 一覧に対応項目が無い」も
// 検査するので、素性の分からない名前はそこで**偽の指摘**に化ける。さらに件数がそのまま人間へ
// 返るため、未確定の規模を実際より大きく見せる。
//
// writer のプロンプトには `[REQUIRED_CATEGORIES]` を既に渡してある。それでも別名が返るので、
// **言い聞かせでは閉じない。** ここで機械的に照合する。
//
// schema の `enum` で入口を塞ぐ案は採らない。writer が該当なしと判断したときに schema 違反で
// 応答そのものを失い、文書が 1 本まるごと落ちうる（既存の ID 重複も同じ理由で、schema では
// なく構造検査の指摘として writer に差し戻している）。加えて refine は既存文書の
// `categories_deferred` を入力として受け取るため、agent の schema を通らない経路が残る。
const reconcileCategories = (documents, required) => {
  const allow = new Set(required)
  const findings = []
  const seen = new Set()
  for (const d of documents) {
    for (const name of d.categories_deferred || []) {
      if (allow.has(name)) continue
      const key = `${d.key}::${name}`
      if (seen.has(key)) continue
      seen.add(key)
      findings.push({
        id: `ST-UNKNOWN-CATEGORY-${name}`,
        document: d.key,
        auditor: 'structural',
        severity: 'blocking',
        issue:
          `categories_deferred の「${name}」は required_categories に無い。` +
          `免罪符として働かないうえ、対応する TBD が見つからなければ偽の指摘になる。`,
        fix:
          `required_categories（${required.join(' / ') || '（空）'}）の名称をそのまま使うか、` +
          `どれにも当たらないなら categories_deferred から外す。`,
      })
    }
  }
  // 下流と件数表示には、照合を通ったものだけを渡す。
  const deferred = [...new Set(documents.flatMap((d) => (d.categories_deferred || []).filter((n) => allow.has(n))))]
  return { deferred, findings }
}

// ------------------------------------------------- agent 欠測のリトライ（draft/refine 共通）

// 応答しなかった呼び出しだけを、もう一度出す。**未実施は失敗であって仕様ではない。**
// 1 回落ちただけで先へ進めると、一過性の API エラーが「指摘 0 件」「文書が返らなかった」に
// 化ける。前者は検査を素通しし、後者は実行そのものを打ち切る。原因は同じなので、返らなかった
// 分だけを出し直す。
//
// ただし**複数件を出して全件が落ちたときは再実行しない**。全滅はセッション上限・レート制限の
// ような環境側の事情であり、同じ実行の中で繰り返しても結果は変わらず、予算だけを消費する。
// 1 件でも通っていれば個別の失敗の可能性があるので、落ちた分を出し直す（割合の閾値を置かない
// のは、何 % なら環境側かを決める根拠が無いため）。
// **出した件数が 1 件のときは、全滅でも再実行する。** 母数 1 の全滅は環境側の証拠にならず、
// 一方で再実行しない代償（この 1 件の欠測が確定する）だけが残るため。
//
// この判定は環境側の失敗を取りこぼす。**セッション上限は batch の途中で来るため、先行分は
// 成功し後続だけが落ちる — つまり部分失敗として現れ、再実行が走る。** 尽きた予算をさらに使う
// ことになるが、そのランは resumeFromRunId で再開できるので、欠測を確定させるより軽い。
const runWithRetry = async (label, items, issue, ok) => {
  // 添字は runtime が渡すものを持ち回る。**pipeline の返り値が入力順に並ぶ保証は文書化されて
  // いない。** 位置から添字を逆算すると、並びが変わったときに成功した項目を出し直し、落ちた
  // 項目は永久に出し直さない — 例外も差分も出ないまま、リトライだけが黙って無効になる。
  const run = (idxs, attempt) =>
    pipeline(idxs, (i) => Promise.resolve(issue(items[i], attempt)).then((r) => ({ i, r })))

  const results = new Array(items.length).fill(null)
  // 初回は ok でなくても格納する。呼び出し側は欠測した項目の器（doc / key を持つ）を後段で読む。
  for (const e of await run(items.map((_, i) => i), 1)) if (e) results[e.i] = e.r

  const missing = () => results.map((r, i) => (ok(r) ? -1 : i)).filter((i) => i >= 0)
  const failed = missing()
  if (!failed.length) return results
  if (items.length > 1 && failed.length === items.length) {
    log(
      `${label}: ${failed.length}/${items.length} 件すべてが応答しませんでした。環境側の事情と判断し、` +
        `再実行しません（同じ実行の中では結果が変わらないため）。セッション上限なら、解除後に resume すること。`
    )
    return results
  }
  log(`${label}: ${failed.length}/${items.length} 件が応答しなかったので再実行します`)
  // 再実行も返らなければ初回の結果（欠測）を残す。上書きすると欠測の事実まで消える。
  for (const e of await run(failed, 2)) if (e && ok(e.r)) results[e.i] = e.r

  const left = missing()
  if (left.length) log(`${label}: 再実行後も ${left.length} 件が応答しませんでした`)
  return results
}

// ---------------------------------------------------------------- Write requirements

phase('Write requirements')

const writerMissing = []
let reqResults = []

if (targets.includes('requirements')) {
  // pipeline が既定。各 requirements 文書は互いの本文を必要としない（担当する関心事が
  // 分割案で分かれている）ので、item ごとに独立して流してよい。
  reqResults = await runWithRetry(
    '要求文書の執筆',
    splitPlan.requirements,
    (doc, attempt) =>
      agent(buildReqPrompt(doc), {
        ...ROLE_OPTS.reqWriter,
        schema: REQ_DOC_SCHEMA,
        phase: 'Write requirements',
        label: `req-${doc.topic}${attempt > 1 ? `-retry${attempt - 1}` : ''}`,
      }).then((result) => ({ doc, result: result || null })),
    (r) => r && r.result && reportedLineCount(r.result) !== null
  )
} else {
  reqResults = existingDocs
    .filter((d) => d.kind === 'requirements' && hasBody(d))
    .map((d) => ({ doc: d, result: { summary: d.summary || '', requirement_items: d.items || [], tbd_items: [], fixed: true } }))
}

// writerFailed: 応答が無い、または [WRITE_BACK] の書き出しを申告しなかった（line_count が無い）。
// ファイルと申告の照合は、全文書を書き終えた後に checker が行う（Check 段）。
const writerFailed = (r) => !r.result || (!r.result.fixed && reportedLineCount(r.result) === null)
const reqFailed = reqResults.filter(writerFailed).map((r) => `req-writer@${r.doc.topic}`)
if (targets.includes('requirements') && reqFailed.length) {
  // 文書が返らなかったのに空の器を返すと、後段が「空の要求文書が完成した」と読む。捏造せず止める。
  return blocked(
    `req-writer が ${reqFailed.join(' / ')} を返さないか、書き出しを確認できませんでした。文書を捏造しないため、ここで打ち切ります。`,
    { writer_missing: reqFailed }
  )
}

// 仕様書の writer には requirements の本文ではなく、ID と見出しの一覧と Read 指示を渡す（本文を
// プロンプトに埋めると仕様書の数だけ全要求文書が複製される）。全体を読ませるのは、その仕様書が
// 実現する（covers に挙がる）要求文書だけにする。他の要求文書と固定文書は紐付けの確認先なので、
// 要る節だけを探して読ませる（全文書を通読させると、仕様書の数だけ全要求文書を読み直すことになる）。
// covers が分割案に無いときは、どれを実現するか決まらないので固定文書以外を全体読みさせる。
const requirementsContextFor = (spec) => {
  const covers = new Set(spec.covers || [])
  return reqResults
    .filter((r) => r.result)
    .map((r) => {
      const src = r.result.fixed ? r.doc.path : draftPathOf('requirements', r.doc.topic)
      // 行数は writer の `wc -l`（固定文書は args の line_count）。末尾が改行で終わらない最終行は数に
      // 入らないが、区切り読みの単位を決めるだけなので、ここで checker を 1 回余分に回さない。
      const lines = r.result.fixed ? r.doc.line_count : reportedLineCount(r.result)
      const items = (r.result.requirement_items || []).filter((i) => i && i.id)
      const whole = !r.result.fixed && (!covers.size || covers.has(r.doc.topic))
      return [
        `## ${reqDir}/${r.doc.topic}.md${r.result.fixed ? '（このランの対象外・変更不可）' : ''}`,
        `ID と見出し: ${items.map((i) => `${i.id} ${i.heading || ''}`.trim()).join(' / ') || '(申告なし。本文の ID を Grep で拾う)'}`,
        whole
          ? readInstruction(src, Number.isInteger(lines) ? lines : null)
          : `本文: ${src}（紐付けに要る要求の節だけを ID・見出しの Grep（固定文字列・行番号付き）で探し、${READ_CHUNK_LINES} 行以内の offset/limit で Read する。全体は読まない）`,
      ].join('\n')
    })
    .join('\n\n---\n\n')
}

// ---------------------------------------------------------------- Write specifications

phase('Write specifications')

// requirements を書き切ってから specifications に入る（req と spec を 1 本の pipeline に
// 融合できない）。仕様項目は文書を跨いだ要求 ID を引くため、全 requirements が揃うまで
// 「どの ID が実在するか」が決まらない。1 文書ずつ流すと、後から書かれた要求への紐付けを
// 先行した仕様書が持てず、構造検査で片側 ID として必ず落ちる。
let specResults = []

if (targets.includes('specifications')) {
  specResults = await runWithRetry(
    '仕様書の執筆',
    splitPlan.specifications,
    (doc, attempt) =>
      agent(buildSpecPrompt(doc, requirementsContextFor(doc)), {
        ...ROLE_OPTS.specWriter,
        schema: SPEC_DOC_SCHEMA,
        phase: 'Write specifications',
        label: `spec-${doc.topic}${attempt > 1 ? `-retry${attempt - 1}` : ''}`,
      }).then((result) => ({ doc, result: result || null })),
    (r) => r && r.result && reportedLineCount(r.result) !== null
  )
} else {
  specResults = existingDocs
    .filter((d) => d.kind === 'specifications' && hasBody(d))
    .map((d) => ({ doc: d, result: { summary: d.summary || '', spec_items: d.items || [], traceability: [], tbd_items: [], fixed: true } }))
}

const specFailed = specResults.filter(writerFailed).map((r) => `spec-writer@${r.doc.topic}`)
if (targets.includes('specifications') && specFailed.length) {
  return blocked(
    `spec-writer が ${specFailed.join(' / ')} を返さないか、書き出しを確認できませんでした。仕様書は未作成として扱ってください。`,
    { writer_missing: specFailed }
  )
}

// declaredIds: writer（または args の固定文書）が申告した ID。固定文書で申告が無いものは
// extract_ids を立て、checker が本文から抽出して補う（Check 段）。
const declaredIds = (result, itemsKey) => (result[itemsKey] || []).map((i) => i.id).filter(Boolean)

// documents: 以降の全処理が使う正規化済みの文書一覧。
const documents = [
  ...reqResults.map((r) => {
    const ids = declaredIds(r.result, 'requirement_items')
    return {
      key: docKey('requirements', r.doc.topic),
      kind: 'requirements',
      topic: r.doc.topic,
      concern: r.doc.concern || '',
      path: r.doc.path || `${reqDir}/${r.doc.topic}.md`,
      draft_path: r.result.fixed ? r.doc.path : draftPathOf('requirements', r.doc.topic),
      reported_line_count: r.result.fixed ? null : reportedLineCount(r.result),
      extract_ids: Boolean(r.result.fixed) && !ids.length,
      summary: r.result.summary || '',
      items: (r.result.requirement_items || []).length
        ? r.result.requirement_items
        : ids.map((id) => ({ id, heading: '' })),
      ids,
      referenced: r.result.referenced_ids || [],
      vacant: r.result.vacant_ids || [],
      trace: r.result.trace,
      traceability: [],
      tbd_items: r.result.tbd_items || [],
      categories_deferred: r.result.categories_deferred || [],
      fixed: Boolean(r.result.fixed),
    }
  }),
  ...specResults.map((r) => {
    const ids = declaredIds(r.result, 'spec_items')
    return {
      key: docKey('specifications', r.doc.topic),
      kind: 'specifications',
      topic: r.doc.topic,
      concern: r.doc.concern || '',
      path: r.doc.path || `${specDir}/${r.doc.topic}.md`,
      draft_path: r.result.fixed ? r.doc.path : draftPathOf('specifications', r.doc.topic),
      reported_line_count: r.result.fixed ? null : reportedLineCount(r.result),
      extract_ids: Boolean(r.result.fixed) && !ids.length,
      summary: r.result.summary || '',
      items: (r.result.spec_items || []).length ? r.result.spec_items : ids.map((id) => ({ id, heading: '' })),
      ids,
      referenced: r.result.referenced_ids || [],
      vacant: r.result.vacant_ids || [],
      trace: r.result.trace,
      traceability: r.result.traceability || [],
      tbd_items: r.result.tbd_items || [],
      categories_deferred: r.result.categories_deferred || [],
      fixed: Boolean(r.result.fixed),
    }
  }),
]

// ---------------------------------------------------------------- Check

// 書き出しの照合・行数・構造検査を 1 回の checker でまとめて行う。本文は script の手元に無いので、
// 本文を読む検査は checker が scripts/doc_check.mjs を実行した結果だけを使う。
const checkerMissing = []
const checkInput = { documents: documents.map((d) => checkerDoc(d)) }
const [checkRaw] = await runWithRetry(
  '構造検査',
  [checkInput],
  (inp, attempt) =>
    agent(checkerPrompt(inp, `${draftDir}/checks/draft.json`, SKILL_DIR), {
      ...ROLE_OPTS.checker,
      schema: CHECK_SCHEMA,
      phase: 'Executability',
      label: `checker-draft${attempt > 1 ? `-retry${attempt - 1}` : ''}`,
    }).then((res) => verifyCheck(res, inp)),
  (r) => r && r.ok
)
const check = checkRaw || { ok: false, reason: 'checker が応答しなかった' }
if (check.ok) {
  // 書き出しが確かめられない初稿は採用しない。以後の agent はファイルしか読めないので、
  // 申告とファイルが食い違うと、監査は writer が申告したのと別の本文を見る。
  const unconfirmed = documents
    .filter((d) => !d.fixed && !lineCountConfirmed(d.reported_line_count, check.byKey.get(d.key)))
    .map((d) => `${d.kind === 'requirements' ? 'req' : 'spec'}-writer@${d.topic}`)
  if (unconfirmed.length) {
    return blocked(
      `${unconfirmed.join(' / ')} の書き出しを確認できませんでした（ファイルが無いか、行数が申告と合わない）。文書を捏造しないため、ここで打ち切ります。`,
      { writer_missing: unconfirmed }
    )
  }
  for (const d of documents) {
    const c = check.byKey.get(d.key)
    if (c && c.exists) d.line_count = c.line_count
    if (d.extract_ids && c) {
      d.ids = c.ids_in_text || []
      d.items = d.ids.map((id) => ({ id, heading: '' }))
    }
  }
} else {
  checkerMissing.push('checker@draft')
  log(`構造検査: 実行できませんでした（${check.reason}）。構造検査は「0 件」ではなく「未検査」として返します。`)
  // 行数は writer の申告で代用する（区切り読みの単位を決めるだけ）。
  for (const d of documents) if (Number.isInteger(d.reported_line_count)) d.line_count = d.reported_line_count
}

// ---------------------------------------------------------------- Executability

phase('Executability')

// 各文書を独立に検査する。「この文書だけを渡された実装担当者」という前提そのものが検査対象
// なので、文書をまとめて渡すと他文書の情報で補完されてしまい、検査の意味が消える。
const execResults = await runWithRetry(
  '実行可能性の検査',
  documents.filter((d) => !d.fixed),
  (doc, attempt) =>
    agent(buildExecPrompt(doc), {
      ...ROLE_OPTS.executability,
      schema: EXEC_SCHEMA,
      phase: 'Executability',
      label: `exec-${doc.key}${attempt > 1 ? `-retry${attempt - 1}` : ''}`,
    }).then((result) => ({ key: doc.key, result: result || null })),
  (r) => r && r.result
)

const execMissing = execResults.filter((r) => !r.result).map((r) => r.key)
const execFindings = execResults
  .filter((r) => r.result)
  .flatMap((r) => (r.result.findings || []).map((f) => ({ ...f, auditor: 'executability', document: r.key })))

if (execMissing.length) {
  log(`実行可能性の検査未完了: ${execMissing.join(' / ')} が応答しませんでした（指摘 0 件とは読みません）`)
}

// ---------------------------------------------------------------- Collect

phase('Collect')

const structural = check.ok ? [...check.structural.findings] : []
const notChecked = check.ok
  ? [...check.structural.not_checked]
  : [
      {
        id: 'ST-NOTCHECKED-CHECKER',
        issue: `構造検査を実行できなかった（${check.reason}）。ID の照合・本文の検査は「指摘 0 件」ではなく「未検査」である。`,
      },
    ]
const execTbd = execToTbd(execFindings)

const { items: namespacedTbd, findings: tbdRenumbered } = namespaceTbd(documents)
structural.push(...tbdRenumbered)

const tbdItems = mergeTbd([inputTbdItems, namespacedTbd, execTbd])
const blockingTbd = tbdItems.filter((t) => t.blocking)

const { deferred: categoriesDeferred, findings: categoryFindings } = reconcileCategories(
  documents,
  requiredCategories
)
structural.push(...categoryFindings)

// gate2_skippable: 人間ゲート②を飛ばしてよいかの判定を、script 側に 1 つだけ置く。
// SKILL.md で件数から再判定させると、executability が全滅した run で
// 「blocking 0 件だから聞くことが無い」に化け、着手可能性を一度も検査していない文書について
// 「このまま着手できます」と提示する経路ができる。
// ST-DUP / ST-OBSOLETE はゲート②で提示すると SKILL.md が定めているので、
// これらが残っている run はゲート②を飛ばせない。式に含めないと
// 「blocking 0 件かつ ST-DUP あり」の run で提示先が消える。
const gate2PresentFindings = structural.filter(
  (f) => f.id.startsWith('ST-DUP') || f.id.startsWith('ST-OBSOLETE')
)
// 構造検査を実行できなかった run も飛ばせない。ST-DUP / ST-OBSOLETE が 0 件なのか、検査して
// いないのかが区別できないため。
const gate2Skippable =
  blockingTbd.length === 0 && execMissing.length === 0 && checkerMissing.length === 0 && gate2PresentFindings.length === 0
const gate2Reason = execMissing.length
  ? 'executability_incomplete'
  : checkerMissing.length
    ? 'structural_incomplete'
    : blockingTbd.length
      ? 'blocking_present'
      : gate2PresentFindings.length
        ? 'structural_presentation_required'
        : 'no_blocking'

log(
  `初稿 ${documents.length} 文書 / TBD ${tbdItems.length} 件（着手不能 ${blockingTbd.length} 件）/ ` +
    `実行可能性 blocking ${execFindings.filter((f) => f.severity === 'blocking').length} 件 / 構造検査 ${structural.length} 件`
)

return {
  role_opts_applied: roleOverrides,
  status: 'OK',
  verdict: execMissing.length ? 'executability_incomplete' : 'drafted',
  mode,
  targets,
  documents: documents.map((d) => ({
    key: d.key,
    kind: d.kind,
    topic: d.topic,
    concern: d.concern,
    path: d.path,
    // draft_path: writer が Write し line_count で照合済みのファイル。Workflow B はこれを Read する。
    draft_path: d.draft_path,
    // 本文は返さない。line_count は checker が draft_path で数えた行数（Workflow B の区切り読みに使う）。
    ...(Number.isInteger(d.line_count) ? { line_count: d.line_count } : {}),
    summary: d.summary,
    items: d.items,
    referenced_ids: d.referenced,
    vacant_ids: d.vacant,
    // trace: 項目 ID → 根拠。Workflow B へそのまま渡す（本文には根拠句を書かないので、
    // ここが欠けると根拠がどこにも残らない）。
    trace: d.trace,
    traceability: d.traceability,
    tbd_items: d.tbd_items,
    categories_deferred: d.categories_deferred,
    fixed: d.fixed,
  })),
  // audit_trail: 全文書の trace を 1 つに畳んだ監査証跡。「この記述はどこから来たか」を
  // 成果物の外に置くための唯一の受け皿であり、fabrication 監査の照合対象でもある。
  // 経緯そのものの永続化は保存時の git commit / PR 本文で行う（文書には残さない）。
  audit_trail: documents
    .filter((d) => !d.fixed)
    .map((d) => ({ document: d.key, path: d.path, basis: d.trace || [] })),
  fixed_documents: fixedDocs.map((d) => ({ kind: d.kind, topic: d.topic, path: d.path || '' })),
  requirement_ids: documents.filter((d) => d.kind === 'requirements').flatMap((d) => d.ids),
  spec_ids: documents.filter((d) => d.kind === 'specifications').flatMap((d) => d.ids),
  tbd_items: tbdItems,
  // blocking_tbd_ids: まだ誰にも提示していない生の一覧。この時点では presented_tbd_ids が
  // 存在しないので「未提示」は自明であり、unpresented_blocking はここでは算出しない。
  blocking_tbd_ids: blockingTbd.map((t) => t.id),
  // digest は script が計算して付ける（refine.js と同じ規約）。司令塔に text からの導出を
  // させると、照合側（stableKey）と別の値が積まれ、提示済みが全件「未提示」に化ける。
  blocking_tbd_items: blockingTbd.map((t) => ({ ...t, digest: stableKey(String(t.text || '')) })),
  // gate2_skippable: SKILL.md はこの真偽値だけを見る。件数から再判定しない。
  gate2_skippable: gate2Skippable,
  gate2_reason: gate2Reason,
  paths: { requirements: reqDir, specifications: specDir },
  executability: {
    findings: execFindings,
    blocking_count: execFindings.filter((f) => f.severity === 'blocking').length,
    degraded_count: execFindings.filter((f) => f.severity === 'degraded').length,
    missing: execMissing,
  },
  structural_findings: structural,
  // structural_not_checked: 材料が無くて実行できなかった検査。「0 件」と混同させないため
  // 失格とは別配列で返す。人間ゲート③はこれを「未検査」として提示する。
  structural_not_checked: notChecked,
  // missing_checks: 構造検査（checker）を実行できなかったパス。「指摘 0 件」と読まない。
  missing_checks: checkerMissing,
  categories_deferred: categoriesDeferred,
  writer_missing: writerMissing,
  summary: {
    document_count: documents.length,
    tbd_count: tbdItems.length,
    blocking_tbd_count: blockingTbd.length,
    executability_blocking: execFindings.filter((f) => f.severity === 'blocking').length,
    executability_degraded: execFindings.filter((f) => f.severity === 'degraded').length,
    executability_missing: execMissing.length,
    structural_checked: checkerMissing.length === 0,
    structural_count: structural.length,
    duplicate_ids: structural.filter((f) => f.id.startsWith('ST-DUP')).length,
    orphan_ids: structural.filter((f) => f.id.startsWith('ST-ORPHAN') || f.id.startsWith('ST-DANGLING')).length,
    obsolete_terms: structural.filter((f) => f.id.startsWith('ST-OBSOLETE')).length,
    unverified_citations: structural.filter((f) => f.id.startsWith('ST-UNVERIFIED')).length,
  },
}
