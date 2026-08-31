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

// このスキルの初稿は「完成品」ではなく「何が足りないかを見えるようにする全体像」である。
// だから書けない箇所で止めず TBD を置いて書き切り、そのうえで executability-auditor を
// ここで走らせる。B にしか置かないと「これだけでは作れない」の判明がヒアリングより後になり、
// 最も重要な指摘が聞き返せない場所で生まれる。

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
    markdown: { type: 'string' },
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
  },
  required: ['markdown', 'summary', 'requirement_items', 'trace', 'tbd_items'],
}

const SPEC_DOC_SCHEMA = {
  type: 'object',
  properties: {
    markdown: { type: 'string' },
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
  },
  required: ['markdown', 'summary', 'spec_items', 'trace', 'traceability', 'tbd_items'],
}

// EXEC_SCHEMA: severity は blocking（着手できない）/ degraded（着手はできるが作り直しになりうる）。
// blocking だけを TBD として起票し直し、人間ゲート②の提示対象に入れる。
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
          fix: { type: 'string' },
          severity: { type: 'string', enum: ['blocking', 'degraded'] },
        },
        required: ['id', 'location', 'quote', 'issue', 'fix', 'severity'],
      },
    },
    checked: { type: 'string' },
  },
  required: ['findings', 'checked'],
}

const parsedArgs = (typeof args === 'string' ? JSON.parse(args) : args) || {}

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
const existingDocs = parsedArgs.existing_docs || []

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
  if (!existingDocs.some((d) => d.kind === 'requirements' && d.markdown)) {
    throw new Error('mode=expand には kind="requirements" の existing_docs が必要です。展開元が無いまま新規執筆に化けるのを防ぐため、ここで打ち切ります。')
  }
  targets = ['specifications']
} else {
  const kinds = [...new Set(existingDocs.filter((d) => d.markdown).map((d) => d.kind))]
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

// areaCode: ID の領域プレフィックス。ID_IN_TEXT が英字始まりしか拾わないので、
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
    .filter((d) => targets.includes(d.kind) && d.markdown)
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
  const hit = existingDocs.find((d) => d.kind === kind && d.topic === topic && d.markdown)
  return hit ? hit.markdown : null
}
// 対象外の種別は「入力として固定」する。改稿もしないし生成もしない。
const fixedDocs = existingDocs.filter((d) => !targets.includes(d.kind) && d.markdown)

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

const RULES = [
  `規律は ${SKILL_DIR}/references/requirement-writing-rules.md ・`,
  `${SKILL_DIR}/references/document-structure.md ・${SKILL_DIR}/references/traceability.md ・`,
  `${SKILL_DIR}/references/document-splitting.md ・${SKILL_DIR}/references/citation-policy.md を正とする。`,
].join('\n')

function buildReqPrompt(doc) {
  const previous = previousOf('requirements', doc.topic)
  return [
    `Read ${SKILL_DIR}/agents/req-writer.md for your full role instructions before doing anything else.`,
    RULES,
    `契約は ${SKILL_DIR}/schemas/agent-contracts.md §req-writer を正とする。`,
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
    'referenced_ids に入れること（入れないと申告漏れとして検出される）。',
    '',
    previous
      ? ['# [PREVIOUS] 既存の同名文書（これを下敷きに改稿する。指摘の無い箇所は維持すること）', previous].join('\n')
      : '# 新規執筆（前稿なし）',
  ].join('\n')
}

function buildSpecPrompt(doc, requirementsContext) {
  const previous = previousOf('specifications', doc.topic)
  return [
    `Read ${SKILL_DIR}/agents/spec-writer.md for your full role instructions before doing anything else.`,
    RULES,
    `契約は ${SKILL_DIR}/schemas/agent-contracts.md §spec-writer を正とする。`,
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
  ].join('\n')
}

function buildExecPrompt(doc) {
  return [
    `Read ${SKILL_DIR}/agents/executability-auditor.md for your full role instructions before doing anything else.`,
    `契約は ${SKILL_DIR}/schemas/agent-contracts.md §executability-auditor を正とする。`,
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
    doc.markdown,
    '',
    '各指摘は「ここで手が止まる。なぜなら〜が分からないから」の形で書き、severity に',
    'blocking（着手できない）か degraded（着手はできるが後で作り直しになりうる）を必ず付けること。',
    '指摘が 0 件ならば findings は空配列で返すこと。0 件であること自体が報告に値する。',
    '検査した範囲を checked に必ず記述すること（何も読まずに findings: [] を返す余地を残さないため）。',
  ].join('\n')
}

// ------------------------------------------------------- 構造検査（draft/refine 共通）
//
// この関数は scripts/refine.js に**逐語で複製**されている。workflow script は import を
// 書けないため共有できない。片方だけ直すと A と B で判定が食い違い、初稿で通った文書が
// 改稿後に落ちる（またはその逆）。直すときは必ず両方を同じ内容にすること。
//
// docs は [{ key, kind, topic, markdown, ids, referenced, traceability, fixed }] の正規化済み配列。
// 戻り値は { findings, not_checked }。not_checked は「材料が無くて実行できなかった検査」で、
// 失格ではない。これを返さないと、片側の文書が対象外のランで「検査して 0 件」と
// 「そもそも検査していない」が区別できず、後者が合格として提示される。
function structuralFindings(docs) {
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
    out.push({
      auditor: 'structural',
      id: `ST-DUP-${id}`,
      document: keys[0],
      location: 'ID 一覧',
      quote: id,
      issue: `ID ${id} が ${keys.join(' / ')} の複数文書で定義されている。ID は文書を跨いで一意でなければ、トレーサビリティ表がどちらの項目を指しているか決まらない。`,
      fix: `領域プレフィックスを文書の topic に対応させて振り直す（${keys[1]} 側を別の領域名にする）。`,
    })
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
    out.push({
      auditor: 'structural',
      id: `ST-DUP-TBD-${id}`,
      document: recs[0].key,
      location: '未確定事項',
      quote: id,
      issue: `TBD ${id} が ${recs.map((r) => r.key).join(' / ')} の複数文書から別々の内容で申告されている（「${recs[0].text}」と「${recs[1].text}」）。統合時に片方が消えるため、消えた側が着手を止める項目でも人間に提示されない。`,
      fix: 'TBD の番号にも文書の領域プレフィックスを付けて振り直す（例 TBD-AUTH-001）。',
    })
  }

  // (2) 片側にしか現れない ID。requirements の ID 集合 / specifications の ID 集合 /
  //     トレーサビリティ表の 3 集合を**文書を跨いで**照合する。ここがこのスキルの背骨。
  if (!reqDocs.length || !specDocs.length) {
    notChecked.push({
      id: 'ST-NOTCHECKED-CROSSREF',
      issue:
        `${!reqDocs.length ? 'requirements' : 'specifications'} 文書が本ランの対象に含まれないため、` +
        '要求 ID と仕様項目 ID の突き合わせを実行していない。「指摘 0 件」ではなく「未検査」である。',
    })
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
      out.push({
        auditor: 'structural',
        id: `ST-ORPHAN-REQ-${id}`,
        document: owner,
        location: 'トレーサビリティ表',
        quote: id,
        issue: `要求 ${id} がどの specification 文書のトレーサビリティ表にも現れない（＝この要求を実現する仕様項目が無い）。`,
        fix: `${id} を実現する仕様項目をいずれかの specification 文書に追加して紐付けるか、実現しないのであれば requirements 側でスコープ外として明記する。情報が未確定なら TBD として起票する。`,
      })
    }
    for (const id of specIds) {
      if (linkedSpec.has(id)) continue
      const owner = (owners.get(id) || ['specifications'])[0]
      out.push({
        auditor: 'structural',
        id: `ST-ORPHAN-SPEC-${id}`,
        document: owner,
        location: 'トレーサビリティ表',
        quote: id,
        issue: `仕様項目 ${id} が自文書のトレーサビリティ表に現れない（＝根拠となる要求が不明の仕様）。`,
        fix: `${id} の根拠となる要求 ID を紐付ける。根拠が無いのであれば仕様項目を削除する。`,
      })
    }
    for (const link of links) {
      if (link.requirement_id && !reqIds.has(link.requirement_id)) {
        out.push({
          auditor: 'structural',
          id: `ST-DANGLING-REQ-${link.requirement_id}`,
          document: link.from,
          location: 'トレーサビリティ表',
          quote: link.requirement_id,
          issue: `トレーサビリティ表が要求 ${link.requirement_id} を参照しているが、どの requirements 文書の要求一覧にも存在しない。`,
          fix: `いずれかの requirements 文書に ${link.requirement_id} を実在させるか、表の行を正しい要求 ID に直す。`,
        })
      }
      if (link.spec_id && !specIds.has(link.spec_id)) {
        out.push({
          auditor: 'structural',
          id: `ST-DANGLING-SPEC-${link.spec_id}`,
          document: link.from,
          location: 'トレーサビリティ表',
          quote: link.spec_id,
          issue: `トレーサビリティ表が仕様項目 ${link.spec_id} を参照しているが、仕様書に存在しない。`,
          fix: `${link.spec_id} を本文に実在させるか、表の行を正しい仕様項目 ID に直す。`,
        })
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
    const label = d.kind === 'requirements' ? '要求' : '仕様項目'
    const inText = new Set(d.markdown.match(re) || [])
    const inList = new Set(d.ids)
    const referenced = new Set(d.referenced || [])
    for (const id of d.fixed ? [] : inText) {
      if (inList.has(id) || referenced.has(id)) continue
      out.push({
        auditor: 'structural',
        id: `ST-UNDECLARED-${id}`,
        document: d.key,
        location: '本文',
        quote: id,
        issue: `${label} ${id} が本文に現れているが、返り値の ID 一覧に含まれていない。一覧から漏れた ID は照合対象から外れ、紐付けの欠落が検出されないまま通る。`,
        fix: `${id} を ID 一覧に加える。他文書の ID を参照しているだけ、または ID 体系の例示であって実在の項目ではない場合は referenced_ids に入れる。`,
      })
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
      out.push({
        auditor: 'structural',
        id: `ST-UNDECLARED-TBD-${id}`,
        document: d.key,
        location: '未確定事項',
        quote: id,
        issue: `未確定事項 ${id} が本文に現れているが、どの文書の TBD 一覧にも含まれていない。申告に載らない TBD は blocking の集計から外れ、「未提示の blocking が 0 件」という完成判定を素通りする。`,
        fix: `${id} を tbd_items に申告する（blocking の真偽を必ず付ける）。既に解決していて本文に参照が残っているだけなら、本文からその記述を消す。`,
      })
    }

    for (const id of d.fixed ? [] : inList) {
      if (inText.has(id)) continue
      out.push({
        auditor: 'structural',
        id: `ST-PHANTOM-${id}`,
        document: d.key,
        location: '本文',
        quote: id,
        issue: `${label} ${id} が ID 一覧に申告されているが、本文に存在しない。読み手はこの ID の中身を確認できない。`,
        fix: `${id} を本文に実在させるか、ID 一覧から外す。`,
      })
    }

    // (3c) ID 連番の欠番の無申告。欠番そのものは許す（採番を詰める改稿を強制しない）が、
    //      無申告の欠番は「項目が削除された」のか「最初から無い」のか読み手が区別できず、
    //      統合時の取りこぼしと見分けが付かない。本文に「欠番」の語と当該 ID が併記されて
    //      いれば申告済みとして起票しない。固定文書は自己申告（ids）を持たないので対象外。
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
        if (d.markdown.includes('欠番') && d.markdown.includes(missingId)) continue
        out.push({
          auditor: 'structural',
          id: `ST-GAP-UNDECLARED-${missingId}`,
          document: d.key,
          location: 'ID 一覧',
          quote: missingId,
          issue: `ID 連番に欠番がある（${missingId}）のに、本文に欠番の申告が無い。無申告の欠番は「項目が削除された」のか「統合時に取りこぼした」のか読み手が区別できない。`,
          fix: `${missingId} が欠番であることを本文に申告する（「欠番」の語と ID を併記し、その ID は referenced_ids に入れる）か、採番を詰めて欠番を無くす。`,
        })
      }
    }

    // (4) 廃止済み規制の語。完全一致なので機械検査が正しい形（agent の善意に載せない）。
    const lower = d.markdown.toLowerCase()
    for (const term of OBSOLETE_TERMS) {
      if (!lower.includes(term)) continue
      out.push({
        auditor: 'structural',
        id: `ST-OBSOLETE-${d.key}-${term.replace(/[^a-z0-9]/g, '')}`,
        document: d.key,
        location: '本文',
        quote: term,
        issue: `「${term}」は現行の規制文言ではない。21 CFR 820.30 Design Controls は QMSR（2026-02-02 施行）で [Reserved] 化され、現行 Part 820 本文にこの語は出現しない。現行規制の引用として書くと誤りになる。`,
        fix: '現行規制の根拠として書いているなら削除する。設計モデルとして言及したいのであれば「歴史的な設計統制モデル」であることを同じ段落に明記し、現行規則の引用として提示しない。',
      })
    }
    // DHF は略語。'design history file' が既に検出されていれば同じ記述を 2 件に数えない。
    if (!lower.includes('design history file') && /\bDHF\b/.test(d.markdown)) {
      out.push({
        auditor: 'structural',
        id: `ST-OBSOLETE-${d.key}-dhf`,
        document: d.key,
        location: '本文',
        quote: 'DHF',
        issue: '「DHF（design history file）」は現行の規制文言ではない。QMSR は DHF ではなく "medical device file" の語を使う。',
        fix: '現行規制の根拠として書いているなら削除する。設計モデルとして言及したいのであれば「歴史的な設計統制モデル」であることを同じ段落に明記する。',
      })
    }

    // (5) 本文を確認できていない有料規格の条番号引用。規格名の直後に節番号が続く形だけを拾う。
    for (const std of UNVERIFIABLE_STANDARDS) {
      const pattern = new RegExp(`${std}[^。\\n]{0,20}?${CLAUSE_REF}`)
      if (!pattern.test(d.markdown)) continue
      out.push({
        auditor: 'structural',
        id: `ST-UNVERIFIED-${d.key}-${std.replace(/[^A-Za-z0-9]/g, '')}`,
        document: d.key,
        location: '本文',
        quote: std,
        issue: `${std} の条番号を引用している。この規格は本文を確認できていないため、条番号の内容を裏付けられない。誤った条番号の引用は、規格に触れないことより有害である。`,
        fix: `条番号を落とし、規格名と大まかな射程だけを述べる形に直す（例:「${std} の考え方に基づく」）。または引用自体を削除する。`,
      })
    }

    // (6) 品質チェックリストが「機械」と宣言する検査の script 実装。いずれも severity は
    //     degraded（着手は止めない）で、fix は方向のみを示す。機械的に判別できない行は
    //     起票しない — 偽陽性は writer の改稿枠を空回りさせるため、取りこぼしより有害である。
    if (d.kind === 'specifications' && !d.fixed) {
      // (6a) 仕様項目の単位の自己宣言。何を 1 仕様項目とするかを本文の一箇所で宣言していないと、
      //      読み手ごとに項目の切り出し方が変わり、件数・網羅の判定が文書間で揃わない。
      //      宣言の実在だけを機械判定する（宣言内容の妥当性は厳密に判定できないので検査しない）。
      if (!/仕様項目の単位|(1\s*(つの)?|一つの)仕様項目とす/.test(d.markdown)) {
        out.push({
          auditor: 'structural',
          id: `ST-NOUNIT-${d.key}`,
          document: d.key,
          location: '対象範囲',
          quote: '(単位の宣言なし)',
          severity: 'degraded',
          issue: '何を 1 つの仕様項目として切り出すかの宣言が本文に無い。単位が宣言されていないと、読み手ごとに項目の切り出し方が変わり、件数・網羅の判定が文書間で揃わない。',
          fix: '本文の一箇所（対象範囲の章など）に、機械的に判別できる形で単位を宣言する（例:「本書は `####` 見出し 1 つを 1 仕様項目とする」）。requirement-writing-rules.md §8 を正とする。',
        })
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
            out.push({
              auditor: 'structural',
              id: `ST-MODAL-${idHeadings[k].id}-${sent}`,
              document: d.key,
              location: idHeadings[k].id,
              quote: body.slice(-40),
              severity: 'degraded',
              issue: `要求 ${idHeadings[k].id} の本文に、規範の意図を持つのに 4 語尾（〜しなければならない / 〜してはならない / 〜することが望ましい / 〜してもよい）のいずれでも終わらない文がある。区分（必須 / 禁止 / 推奨 / 許容）が読み手に決まらない。`,
              fix: '文意に対応する 4 語尾のいずれかで文を終える（requirement-writing-rules.md §1 を正とする）。',
            })
          }
        }
      }
      // (6c) ID を含む見出しのレベルが文書内で不統一。基準レベル（最頻値。同数なら浅い方）
      //      以外に ID 見出しが散在すると、読み手が「章の中の区分」と「個別項目」を階層で
      //      見分けられず、目次の機械生成でも構造が崩れる。
      if (levelCount.size > 1) {
        for (const h of idHeadings) {
          if (h.level === baseLevel) continue
          out.push({
            auditor: 'structural',
            id: `ST-IDHEADING-${h.id}`,
            document: d.key,
            location: '見出し',
            quote: h.id,
            severity: 'degraded',
            issue: `ID を含む見出しのレベルが文書内で不統一（${h.id} はレベル ${h.level}、この文書の基準はレベル ${baseLevel}）。読み手が「章の中の区分」と「個別項目」を階層で見分けられない。`,
            fix: '個別項目の見出しレベルを文書内で統一する（document-structure.md §2.6 は `####` を基準とする）。',
          })
        }
      }
      // (6d) 解消条件の無い blocking TBD。何が決まればこの項目が解消するかが書かれていないと、
      //      「着手を止める」とだけ言われた読み手は先へ進む条件を知れない。「解消」の語の
      //      実在で機械判定する（申告 text か、本文中で当該 ID と同じ行にあるかのいずれか）。
      for (const t of d.tbd_items || []) {
        if (!t || !t.blocking || !t.id) continue
        if (String(t.text || '').includes('解消')) continue
        if (bodyLines.some((ln) => ln.includes(t.id) && ln.includes('解消'))) continue
        out.push({
          auditor: 'structural',
          id: `ST-TBD-NORESOLVE-${t.id}`,
          document: d.key,
          location: '未確定事項',
          quote: t.id,
          severity: 'degraded',
          issue: `着手を止める未確定事項 ${t.id} に、解消条件に相当する記述（「解消」の語）が無い。解消条件の無い blocking TBD は、何が決まれば先へ進めるのかが読み手に決まらない。`,
          fix: 'tbd_items の text に解消条件（何がどう決まればこの項目が解消するか）を書き足す。',
        })
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
      notChecked.push({
        id: `ST-NOTCHECKED-TRACE-${d.key}`,
        issue: `${d.key} が trace を申告していないため、項目 ID と根拠の対応を検査していない。「根拠あり」ではなく「未検査」である。`,
      })
    } else {
      const traced = new Set(d.trace.map((t) => t && t.item_id).filter(Boolean))
      for (const id of d.ids) {
        if (traced.has(id)) continue
        out.push({
          auditor: 'structural',
          id: `ST-NO-EVIDENCE-${id}`,
          document: d.key,
          location: id,
          quote: id,
          issue: `${id} に対応する trace（根拠原本の引用）が申告されていない。本文に根拠句を書かない規約なので、trace が無い項目は根拠がどこにも残らない。`,
          fix: '根拠原本（[INPUT] / [ANSWERS] / [TBD_ANSWERS] / [DECISIONS] / [SKILL_PREMISES] / 計測結果）からの引用を trace に申告する。引用できないなら、その項目は要求ではなく未確定事項として起票し直す。',
        })
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
      out.push({
        auditor: 'structural',
        id: `ST-NON-NORMATIVE-${d.key}-${p.what}`,
        document: d.key,
        location: '本文',
        quote: hit.trim().slice(0, 60),
        issue: `本文に${p.what}が含まれている。納品文書に書くのは規範文・ID・上位/姉妹文書への参照・自明でない規則の 1 文の理由だけであり、経緯と根拠は返り値（audit_trail）と保存時の commit / PR 本文に残す。`,
        fix: '当該の記述を本文から外す。根拠は trace に申告し、決まっていないことは保持規則（規範文）として書く。',
      })
    }
  }

  return { findings: out, not_checked: notChecked }
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
      text: `${f.issue}（想定される解消: ${f.fix}）`,
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
        model: 'opus',
        schema: REQ_DOC_SCHEMA,
        phase: 'Write requirements',
        label: `req-${doc.topic}${attempt > 1 ? `-retry${attempt - 1}` : ''}`,
      }).then((result) => ({ doc, result: result || null })),
    (r) => r && r.result && r.result.markdown
  )
} else {
  reqResults = existingDocs
    .filter((d) => d.kind === 'requirements' && d.markdown)
    .map((d) => ({ doc: d, result: { markdown: d.markdown, summary: d.summary || '', requirement_items: [], tbd_items: [], fixed: true } }))
}

const reqFailed = reqResults.filter((r) => !r.result || !r.result.markdown).map((r) => `req-writer@${r.doc.topic}`)
if (targets.includes('requirements') && reqFailed.length) {
  // 文書が返らなかったのに空の器を返すと、後段が「空の要求文書が完成した」と読む。捏造せず止める。
  return blocked(
    `req-writer が ${reqFailed.join(' / ')} を返しませんでした。文書を捏造しないため、ここで打ち切ります。`,
    { writer_missing: reqFailed }
  )
}

const requirementsContext = reqResults
  .filter((r) => r.result && r.result.markdown)
  .map((r) => `## ${reqDir}/${r.doc.topic}.md\n\n${r.result.markdown}`)
  .join('\n\n---\n\n')

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
      agent(buildSpecPrompt(doc, requirementsContext), {
        model: 'opus',
        schema: SPEC_DOC_SCHEMA,
        phase: 'Write specifications',
        label: `spec-${doc.topic}${attempt > 1 ? `-retry${attempt - 1}` : ''}`,
      }).then((result) => ({ doc, result: result || null })),
    (r) => r && r.result && r.result.markdown
  )
} else {
  specResults = existingDocs
    .filter((d) => d.kind === 'specifications' && d.markdown)
    .map((d) => ({ doc: d, result: { markdown: d.markdown, summary: d.summary || '', spec_items: [], traceability: [], tbd_items: [], fixed: true } }))
}

const specFailed = specResults.filter((r) => !r.result || !r.result.markdown).map((r) => `spec-writer@${r.doc.topic}`)
if (targets.includes('specifications') && specFailed.length) {
  return blocked(
    `spec-writer が ${specFailed.join(' / ')} を返しませんでした。仕様書は未作成として扱ってください。`,
    { writer_missing: specFailed }
  )
}

// idsOf: 固定文書は agent の申告を持たないので、本文から ID を抽出して補う。
// 空のままにすると、その文書が定義している ID が「存在しない」ものとして扱われ、
// トレーサビリティ表がそれを指した瞬間に全件が幽霊 ID として失格になる。
const idsOf = (result, kind, itemsKey) => {
  const declared = (result[itemsKey] || []).map((i) => i.id).filter(Boolean)
  if (declared.length || !result.fixed || !result.markdown) return declared
  return [...new Set(result.markdown.match(ID_IN_TEXT[kind]) || [])]
}

// documents: 以降の全処理が使う正規化済みの文書一覧。
const documents = [
  ...reqResults.map((r) => {
    const ids = idsOf(r.result, 'requirements', 'requirement_items')
    return {
      key: docKey('requirements', r.doc.topic),
      kind: 'requirements',
      topic: r.doc.topic,
      concern: r.doc.concern || '',
      path: r.doc.path || `${reqDir}/${r.doc.topic}.md`,
      markdown: r.result.markdown,
      summary: r.result.summary || '',
      items: (r.result.requirement_items || []).length
        ? r.result.requirement_items
        : ids.map((id) => ({ id, heading: '' })),
      ids,
      referenced: r.result.referenced_ids || [],
      trace: r.result.trace,
      traceability: [],
      tbd_items: r.result.tbd_items || [],
      categories_deferred: r.result.categories_deferred || [],
      fixed: Boolean(r.result.fixed),
    }
  }),
  ...specResults.map((r) => {
    const ids = idsOf(r.result, 'specifications', 'spec_items')
    return {
      key: docKey('specifications', r.doc.topic),
      kind: 'specifications',
      topic: r.doc.topic,
      concern: r.doc.concern || '',
      path: r.doc.path || `${specDir}/${r.doc.topic}.md`,
      markdown: r.result.markdown,
      summary: r.result.summary || '',
      items: (r.result.spec_items || []).length ? r.result.spec_items : ids.map((id) => ({ id, heading: '' })),
      ids,
      referenced: r.result.referenced_ids || [],
      trace: r.result.trace,
      traceability: r.result.traceability || [],
      tbd_items: r.result.tbd_items || [],
      categories_deferred: r.result.categories_deferred || [],
      fixed: Boolean(r.result.fixed),
    }
  }),
]

// ---------------------------------------------------------------- Executability

phase('Executability')

// 各文書を独立に検査する。「この文書だけを渡された実装担当者」という前提そのものが検査対象
// なので、文書をまとめて渡すと他文書の情報で補完されてしまい、検査の意味が消える。
const execResults = await runWithRetry(
  '実行可能性の検査',
  documents.filter((d) => !d.fixed),
  (doc, attempt) =>
    agent(buildExecPrompt(doc), {
      model: 'opus',
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

const { findings: structural, not_checked: notChecked } = structuralFindings(documents)
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
const gate2Skippable =
  blockingTbd.length === 0 && execMissing.length === 0 && gate2PresentFindings.length === 0
const gate2Reason = execMissing.length
  ? 'executability_incomplete'
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
    markdown: d.markdown,
    summary: d.summary,
    items: d.items,
    referenced_ids: d.referenced,
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
  categories_deferred: categoriesDeferred,
  writer_missing: writerMissing,
  summary: {
    document_count: documents.length,
    tbd_count: tbdItems.length,
    blocking_tbd_count: blockingTbd.length,
    executability_blocking: execFindings.filter((f) => f.severity === 'blocking').length,
    executability_degraded: execFindings.filter((f) => f.severity === 'degraded').length,
    executability_missing: execMissing.length,
    structural_count: structural.length,
    duplicate_ids: structural.filter((f) => f.id.startsWith('ST-DUP')).length,
    orphan_ids: structural.filter((f) => f.id.startsWith('ST-ORPHAN') || f.id.startsWith('ST-DANGLING')).length,
    obsolete_terms: structural.filter((f) => f.id.startsWith('ST-OBSOLETE')).length,
    unverified_citations: structural.filter((f) => f.id.startsWith('ST-UNVERIFIED')).length,
  },
}
