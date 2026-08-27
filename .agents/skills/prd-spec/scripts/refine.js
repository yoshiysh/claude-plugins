export const meta = {
  name: 'prd-spec-refine',
  description: 'TBD 回答を反映して改稿し、7 観点の監査ループを回して INDEX 内容と未提示 blocking を返す',
  phases: [
    { title: 'Reflect', detail: '人間ゲート②の回答を各文書に反映する' },
    { title: 'Audit', detail: '7 観点の監査を 1 つの parallel で発行し、script が構造検査を足す' },
    { title: 'Revise', detail: '失格が残っていれば writer へ差し戻して改稿する（上限あり）' },
    { title: 'Finalize', detail: '2 つの INDEX 内容と unpresented_blocking を組み立てて返す' },
  ],
}

// 停止条件は「乾き停止（novelty 0）+ 不動点検出」が主で、回数は backstop に格下げした
// （実測: 固定上限 2 回は「進んでいるのに切る」を起こし、non-blocking 指摘は改稿しても
// 総数がほぼ減らなかった — 生成量 ≈ 消化量。回数で切っても直る見込みとは無関係だから。
// さらに run9/10 では不動点検出が一度も発火せず毎回 backstop 到達で止まったため、
// 「新規指摘が尽きた」を script が novelty として算出する乾き停止を主条件に据えた）。
//
// STUCK_THRESHOLD: ある指摘が「改稿を経ても同一 digest のまま残る」ことがこの回数連続したら
// stuck（回答不能候補）とマークし、通常の改稿ループから外して多角化 escalation（1 回きり）へ回す。
const STUCK_THRESHOLD = 2
// REVISION_BACKSTOP: 総改稿回数の予算。run7 の実測で、不動点検出は「毎回新しい指摘が湧く」
// 通常ケースでは一度も発火せず（同一 digest の再来ではなく新表面の露出が支配的）、backstop 8 まで
// 走って 5.86M トークンを消費した。ループを実際に閉じたのは改稿ではなく終端裁定だったため、
// 改稿は少数回で切り上げ、残る指摘は終端裁定（rejected / documented）へ流す設計に改めた。
// 到達したら verdict に 'revision_backstop_reached' を立てて明示的に終わる。
const REVISION_BACKSTOP = 3

// AUDITORS の scope: 'each' = 全文書に 1 体ずつ / 'requirements' | 'specifications' = その種別だけ /
// 'all' = 全文書をまとめて 1 体。consistency だけが 'all' なのは、重複・矛盾・INDEX との齟齬は
// 単一文書の中では原理的に見えないため。他の 5 観点は 1 文書で判定が閉じるので fan-out する。
const AUDITORS = [
  { name: 'executability', file: 'executability-auditor.md', model: 'opus', scope: 'each' },
  { name: 'clarity', file: 'clarity-auditor.md', model: 'sonnet', scope: 'each' },
  { name: 'traceability', file: 'traceability-auditor.md', model: 'sonnet', scope: 'specifications' },
  { name: 'coverage', file: 'coverage-auditor.md', model: 'sonnet', scope: 'requirements' },
  { name: 'fabrication', file: 'fabrication-auditor.md', model: 'opus', scope: 'each' },
  { name: 'consistency', file: 'consistency-auditor.md', model: 'sonnet', scope: 'all' },
  // validity: 内容の妥当性（筋・矛盾・欠落）。書式・規律の監査を全通過した筋の悪い要求を
  // 止める最後の観点。事後レビュー頼みだと実施されないことが実測されたため観点に組み込んだ。
  { name: 'validity', file: 'validity-auditor.md', model: 'opus', scope: 'all' },
  // specimen: 標本適用監査。生成文書の各項目を実在の標本文書に実際に適用し、判定不能・
  // 適用時矛盾を検出する。内部監査が見逃す共通原因「文書を読むだけで、使ってみない」を
  // 塞ぐために導入された（実測: 全監査通過後の独立レビューが判定不能 4 件を検出した）。
  // scope 'kind' は文書 kind ごとに 1 体（要求と仕様で適用の物差しが違うため）。
  // コスト抑制のため毎改稿のスコープ監査には参加せず、初回監査と終端の網羅監査だけ参加する。
  { name: 'specimen', file: 'specimen-auditor.md', model: 'opus', scope: 'kind' },
]

const OBSOLETE_TERMS = ['21 cfr 820.30', 'design input', 'design output', 'design history file']
const UNVERIFIABLE_STANDARDS = ['IEC 62304', 'ISO 14971', 'ISO 13485', 'JIS T 2304', 'FISC']
const CLAUSE_REF = '(?:(?:§|Clause|Section|箇条)\\s*\\d|第\\s*\\d+(?:\\.\\d+)*\\s*(?:節|条|項))'
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

const REQ_DOC_SCHEMA = {
  type: 'object',
  properties: {
    markdown: { type: 'string' },
    summary: { type: 'string' },
    requirement_items: { type: 'array', items: ID_ITEM },
    tbd_items: { type: 'array', items: TBD_ITEM },
    categories_deferred: { type: 'array', items: { type: 'string' } },
    referenced_ids: { type: 'array', items: { type: 'string' } },
    // item_delta: 改稿の前後で項目が何件増えたか、増やした理由は何かを writer に申告させる。
    // 数えさせるのが目的である。監査指摘はすべて「足りない」の形で届くため、書き足すことが
    // 唯一の解決に見えるため、項目数は放っておくと単調に増える（減る契機がどこにも無い）。
    // 件数を口に出させると、足す前に統合・書き直し・削除を検討する。
    item_delta: {
      type: 'object',
      properties: {
        after: { type: 'number' },
        net_added: { type: 'number' },
        added_items: {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: { type: 'string' }, why_not_edit_existing: { type: 'string' } },
            required: ['id', 'why_not_edit_existing'],
          },
        },
      },
      required: ['after', 'net_added'],
    },
  },
  required: ['markdown', 'summary', 'requirement_items', 'tbd_items'],
}

const SPEC_DOC_SCHEMA = {
  type: 'object',
  properties: {
    markdown: { type: 'string' },
    summary: { type: 'string' },
    spec_items: { type: 'array', items: ID_ITEM },
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
    // item_delta: 改稿の前後で項目が何件増えたか、増やした理由は何かを writer に申告させる。
    // 数えさせるのが目的である。監査指摘はすべて「足りない」の形で届くため、書き足すことが
    // 唯一の解決に見えるため、項目数は放っておくと単調に増える（減る契機がどこにも無い）。
    // 件数を口に出させると、足す前に統合・書き直し・削除を検討する。
    item_delta: {
      type: 'object',
      properties: {
        after: { type: 'number' },
        net_added: { type: 'number' },
        added_items: {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: { type: 'string' }, why_not_edit_existing: { type: 'string' } },
            required: ['id', 'why_not_edit_existing'],
          },
        },
      },
      required: ['after', 'net_added'],
    },
  },
  required: ['markdown', 'summary', 'spec_items', 'traceability', 'tbd_items'],
}

// AUDIT_SCHEMA: 6 auditor 共通。判定は failed[] の件数で受け取る（markdown 中の ❌ を数えない）。
// checked を必須にしているのは、何も見ずに failed: [] を返す経路を残さないため。
// severity は executability と validity が使う（blocking / degraded。validity は fail-open/
// fail-closed の適用範囲の重なり — 前提 7 — に blocking を付ける）。
const AUDIT_SCHEMA = {
  type: 'object',
  properties: {
    failed: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          document: { type: 'string' },
          location: { type: 'string' },
          quote: { type: 'string' },
          issue: { type: 'string' },
          fix: { type: 'string' },
          severity: { type: 'string', enum: ['blocking', 'degraded'] },
          // repro: 判定が割れる具体入力（またはその構成手順）。degraded 指摘にも必須の契約
          // （schemas/agent-contracts.md）。schema の required にはしない — writer が該当なしと
          // 判断したときに schema 違反で応答ごと失う経路を作らない（既存の enum 不採用と同じ理由）。
          repro: { type: 'string' },
        },
        required: ['id', 'location', 'quote', 'issue', 'fix'],
      },
    },
    checked: { type: 'string' },
  },
  required: ['failed', 'checked'],
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

const today = parsedArgs.today
if (!today) {
  throw new Error('args.today が未指定です。日付を推測で書かないため、ここで打ち切ります。')
}

const inputDocs = parsedArgs.documents || []
if (!inputDocs.length) {
  throw new Error('args.documents が空です。draft.js の返り値 documents をそのまま渡してください（初稿なしで改稿は始められません）。')
}

// outer_round: SKILL.md が持つ外側ループの周回カウンタ（1 or 2）。ユーザーには聞かない。
// R<outer>.<rev> は revision_log（返り値のメタ情報）だけで使う識別子であり、**生成文書には書かない**。
// 改稿の経緯は成果物ではなく実行の途中経過なので、本文にも変更履歴の章にも残さない。
const outerRound = Number(parsedArgs.outer_round || 1)
// MAX_OUTER_ROUNDS: 外側ループの上限（SKILL.md「最大 2 周」の script 側の対）。
// 範囲外を黙って受けると、revision_log の R<outer>.<rev> と提示容量の前提
// （check_blocking_rate.py の 20 件/周 × 2 周）が崩れたまま走る。
const MAX_OUTER_ROUNDS = 2
if (!Number.isInteger(outerRound) || outerRound < 1 || outerRound > MAX_OUTER_ROUNDS) {
  throw new Error(`args.outer_round が不正です: ${parsedArgs.outer_round}（1〜${MAX_OUTER_ROUNDS} の整数）`)
}
// auditRounds: agent 監査を実施するラウンド数。既定は全ラウンド（抑制しない）。
const auditRounds = Number(parsedArgs.audit_rounds || REVISION_BACKSTOP + 1)

// presented_tbd_ids: これまでに人間ゲート②で提示済みの TBD の ID。この配列が
// unpresented_blocking の唯一の入力であり、「聞かれもせずに残った blocking」を可視化する。
// 要素は文字列（ID のみ・旧形式）か {id, digest} を受け付ける。digest は提示した時点の
// text から導いた安定キーで、ID の使い回しによる偽陰性を防ぐために照合する。
const presentedById = new Map(
  (parsedArgs.presented_tbd_ids || [])
    .map((e) => (typeof e === 'string' ? { id: e } : e))
    .filter((e) => e && e.id)
    .map((e) => [e.id, e])
)
const presentedIds = new Set(presentedById.keys())

const mode = parsedArgs.mode || 'new'
const answers = parsedArgs.answers || '(事前ヒアリングなし。既定は [DECISIONS] を見よ)'
// decisions: intake（既定選定係）の決定ログ + 統合ゲートで上書きされた決定。
// draft.js と同じ理由で CONTEXT に載せる（無いと既定由来の記述が捏造扱いになる）。
const decisions = parsedArgs.decisions || []
const tbdAnswers = (parsedArgs.tbd_answers || '').trim()
// tbd_answers_history: 過去周回のゲート②回答。文書は周回を跨いで累積する（1 周目回答を
// 根拠にした要求文が 2 周目の文書にも残る）のに、根拠の原本を今周回の tbd_answers だけに
// すると、fabrication-auditor には過去回答を根拠にした要求が「存在しない回答を挙げた捏造」に
// 見える（実測: 2 周目で blocking の偽陽性 6 件）。原本も周回を跨いで累積させる。
// 呼び出し側は前周回の返り値の tbd_answers_history をそのまま渡す（documents と同じ規約）。
const tbdAnswersHistory = (parsedArgs.tbd_answers_history || []).filter(
  (e) => e && typeof e.answers === 'string' && e.answers.trim()
)
// 2 周目以降で履歴が空なら、それは渡し忘れの徴候（1 周目でゲート②を飛ばした正当なランも
// ありうるので throw にはしない）。黙って進むと偽陽性が再発するため、名指しで警告する。
if (outerRound >= 2 && !tbdAnswersHistory.length) {
  log(
    '警告: outer_round が 2 以上なのに tbd_answers_history が空です。1 周目のゲート②回答が' +
      '根拠原本から欠けると、過去回答由来の要求が fabrication の偽陽性になります。' +
      '前周回の返り値の tbd_answers_history をそのまま渡してください（1 周目でゲート②を飛ばした場合はこの警告は無視してよい）。'
  )
}
const inputTbdItems = parsedArgs.tbd_items || []
const domainFindings = parsedArgs.domain_findings || []
const requiredCategories = parsedArgs.required_categories || []
const paths = parsedArgs.paths || {}
// self_containment: 「何を文書に書き写し、何を参照にとどめるか」の合意。draft.js と同じ理由で
// executability-auditor に渡す（渡さないと語彙リストの数だけ誤検出が量産される）。
const selfContainment = parsedArgs.self_containment || ''
// specimen_paths: 標本適用監査（specimen）が項目を実際に当てる実在文書のパス。省略時は
// 同一 workspace 内の既存文書（documents のうち fixed: true のもの）を script が列挙する
// — fixed 文書は「確定済みとして渡された実在の文書」なので標本の条件を満たす。
// 1 件も無ければ specimen 監査は skip し、specimen_skipped: true として返す。
// 「未実施」を missing（欠測 = 失敗）と混同させないための区別である: 欠測は再実行で
// 埋めるべきものだが、標本が無いのは環境の事実であり、再実行しても変わらない。
const specimenPaths = [
  ...new Set(
    (parsedArgs.specimen_paths && parsedArgs.specimen_paths.length
      ? parsedArgs.specimen_paths
      : (parsedArgs.documents || [])
          .filter((d) => d && d.fixed)
          .map((d) => d.draft_path || d.path)
    ).filter(Boolean)
  ),
]
const specimenSkipped = !specimenPaths.length
// specimen_self_only: 標本が「当該ランの生成対象と同一 workspace の自己出自文書のみ」の申告。
// 自己出自の標本は生成規範と同じ書き方に寄っているため、書き方の少し違う文書で起きる偽陽性
// （活用形を無視した literal 照合など）を specimen 監査が検出できない。skip はしない —
// 自己出自の標本でも検出できる欠陥はあるので実行はするが、試運転の多様性が不足している
// 事実を返り値で申告し、呼び出し側が自己出自以外の標本を足せるようにする。
const documentPathsAll = new Set(
  (parsedArgs.documents || []).map((d) => d && (d.draft_path || d.path)).filter(Boolean)
)
const specimenSelfOnly = !specimenSkipped && specimenPaths.every((p) => documentPathsAll.has(p))
if (specimenSelfOnly) {
  log(
    'specimen 警告: 標本が当該ランの生成対象と同一 workspace の自己出自文書のみです。' +
      '自己出自の標本は生成規範と同じ書き方に寄っており、書き方の違う文書での偽陽性を見逃します。' +
      '自己出自以外の標本を specimen_paths で 1 件以上渡すことを推奨します（skip はしません）。'
  )
}
// draft_structural_findings: Workflow A の構造検査結果。ここで受け取らないと A の検査は
// 計算されて捨てられ、初稿段階の ID 重複や廃止規制語が誰にも読まれないまま次へ進む。
const draftStructural = parsedArgs.draft_structural_findings || []
const reqDir = paths.requirements || 'docs/requirements'
const specDir = paths.specifications || 'docs/specifications'

// documents: draft.js の返り値のうち **メタ情報だけ** を受け取る。
//
// **本文（markdown）は args で渡さない。** 12 文書で 24 万文字を超えることがあり、
// それを args に載せると、呼び出し側（SKILL.md）が全文を書き写して中継することになる。
// workflow script はファイルを読めないが **agent は読める** ので、本文は draft_path を
// writer に Read させて取り込む。この分担なら args は数 KB で済む。
//
// 構造検査は本文を必要とするが、回答反映パス（forceAll）が全文書を必ず writer に通すため、
// 監査へ入る時点では返ってきた markdown が script の手元に揃っている。初稿段階の構造検査は
// Workflow A で済んでおり、その結果は draft_structural_findings で受け取る。
//
// fixed（このランの対象外として固定入力にした文書）は改稿も監査もしない — ユーザーが
// 確定済みとして渡した文書を黙って書き換えないため。ただし consistency の文脈には入れる。
let documents = inputDocs.map((d) => ({
  key: d.key,
  kind: d.kind,
  topic: d.topic,
  concern: d.concern || '',
  path: d.path || `${d.kind === 'requirements' ? reqDir : specDir}/${d.topic}.md`,
  // draft_path: 初稿の本文が置いてあるパス。writer はここを Read して改稿する。
  // 省略時は path（保存先）を見る — review / expand で既存文書を改稿する経路がこれにあたる。
  draft_path: d.draft_path || d.path || '',
  // markdown は原則として空で始まり、writer が返した時点で埋まる。
  markdown: d.markdown || '',
  summary: d.summary || '',
  items: d.items || [],
  ids: (d.items || []).map((i) => i.id).filter(Boolean),
  referenced: d.referenced_ids || [],
  traceability: d.traceability || [],
  tbd_items: d.tbd_items || [],
  categories_deferred: d.categories_deferred || [],
  fixed: Boolean(d.fixed),
}))

// 本文もパスも無い文書があると、writer は何を改稿すればよいか分からないまま書き始める
// （＝新規執筆に化ける）。入口で止める。
{
  const orphan = documents.filter((d) => !d.markdown && !d.draft_path)
  if (orphan.length) {
    throw new Error(
      `args.documents に本文（markdown）も参照先（draft_path）も無い文書があります: ${orphan
        .map((d) => d.key)
        .join(' / ')}。改稿の下敷きが無いまま新規執筆に化けるのを防ぐため、ここで打ち切ります。`
    )
  }
}

const CONTEXT_BLOCK = [
  '# [MODE] 実行モード',
  mode,
  '',
  '# [SKILL_PREMISES] スキルが固定する前提（案件ごとに問い直さない）',
  `${SKILL_DIR}/references/fixed-premises.md を Read し、そこに列挙された前提を執筆・検査の`,
  '枠組みとして使うこと。前提由来の書き方の選択は根拠欄に `（スキル既定: 前提 N）` と書く。',
  '前提は案件の確定要求の根拠にはならない（区別は同ファイルの末尾節を正とする）。',
  '',
  '# [INPUT] 依頼文（確定要求の根拠その 1）',
  input,
  '',
  '# [ANSWERS] 人間ゲート①の回答（確定要求の根拠その 2）',
  answers,
  '',
  '# [TBD_ANSWERS] 人間ゲート②の回答（確定要求の根拠その 3。過去周回の回答も含む）',
  [
    ...tbdAnswersHistory.map((e) => `## 第 ${e.round} 周回の回答\n${e.answers}`),
    tbdAnswers ? `## 今周回の回答\n${tbdAnswers}` : '',
  ]
    .filter(Boolean)
    .join('\n\n') || '(未確定事項への回答なし)',
  '',
  '# [DECISIONS] 決定ログ（確定要求の根拠その 4。既定として選ばれた書き方・進め方）',
  '出所は `（既定: D-N）` と表記する。書式と使ってよい範囲は references/question-policy.md を正とする。',
  JSON.stringify(decisions, null, 2),
  '',
  '# [TBD_ITEMS] 現時点の未確定事項',
  JSON.stringify(inputTbdItems, null, 2),
  '',
  '# [DOMAIN_FINDINGS] ドメイン分析の三値判定と根拠',
  JSON.stringify(domainFindings, null, 2),
  '',
  '# [REQUIRED_CATEGORIES] 反映が必須の追加要求カテゴリ',
  JSON.stringify(requiredCategories, null, 2),
  '',
  '# [TODAY] 文書中に日付を書く必要が生じたときの基準日（推測で日付を書かない）',
  today,
  '',
  '',
  '**既存実装は根拠にならない。** 対象のコードを読んでよい場合でも、「実装がこうなっている」を',
  '要求の根拠にしてはならない。読んでよいことと、根拠にできることは別である。',
  '読み取った振る舞いは**仕様**に書き、要求にはその**目的**を書く（根拠は依頼文・回答の側にある）。',
  '目的が入力から辿れないものは、実装をなぞらず **TBD として起票**すること。',
  '「動いているコード」は業界の常識より説得力があるように見えるが、ユーザーがそれを要求した',
  '根拠にはならない。詳細は references/requirement-writing-rules.md §4「既存実装は根拠にならない」。',
  'INPUT / ANSWERS / TBD_ANSWERS / DECISIONS に根拠が無い要求を書いてはならない。回答されなかった項目を',
  '推測で埋めず、TBD のまま残すこと。「分からない」と回答された項目も TBD のまま残す。',
].join('\n')

const RULES = [
  `規律は ${SKILL_DIR}/references/requirement-writing-rules.md ・`,
  `${SKILL_DIR}/references/document-structure.md ・${SKILL_DIR}/references/traceability.md ・`,
  `${SKILL_DIR}/references/document-splitting.md ・${SKILL_DIR}/references/citation-policy.md を正とする。`,
].join('\n')

// areaCode / tbdPrefix: draft.js と同じ規約でなければならない。ここがずれると、改稿のたびに
// ID の領域コードが変わり、本文中の表記と ID 一覧が食い違う。
const areaCode = (t) => {
  const s = String(t).toUpperCase().replace(/[^A-Z0-9]/g, '')
  return /^[A-Z]/.test(s) ? s : `X${s}`
}
const tbdPrefix = (doc) => `TBD-${doc.kind === 'requirements' ? 'R' : 'S'}${areaCode(doc.topic)}-`

// bodyOf: 本文が手元に無い文書は、検査 agent に Read させる。改稿を通った文書は writer が
// 返した markdown が入っているので、この分岐に入るのは fixed 文書（このランの対象外）だけ。
const bodyOf = (d) => (d.markdown ? d.markdown : `（本文は ${d.draft_path} にある。Read すること）`)

// 他文書は「重複を作らないための参照」なので、本文が手元に無ければパスと要約で足りる
// （writer は必要ならそのパスを Read できる）。全文を常に載せると、12 文書のプロンプトが
// それぞれ他 11 文書分を抱えて肥大する。
function otherDocsContext(self) {
  return documents
    .filter((d) => d.key !== self.key)
    .map((d) =>
      d.markdown
        ? `## ${d.path}（${d.concern}）\n\n${d.markdown}`
        : `## ${d.path}（${d.concern}）\n\n要約: ${d.summary || '(なし)'}\n本文: ${d.draft_path} を Read すること`
    )
    .join('\n\n---\n\n')
}

function buildWriterPrompt(doc, findings, revisionId, requirementsRevised) {
  const isReq = doc.kind === 'requirements'
  const role = isReq ? 'req-writer' : 'spec-writer'
  const tail = []
  if (findings && findings.length) {
    tail.push('# [FINDINGS] 解消すべき監査指摘', JSON.stringify(findings, null, 2), '')
    tail.push(
      '指摘の解消のために新しい要求を創作してはならない。情報が未確定なら TBD として立て、',
      'そのカテゴリ名を categories_deferred に入れること。',
      '`ladder_kind: "criteria"` の指摘は判定基準・既定の欠落である。書き手が決められる既定なら',
      '既定として書き、選んだ既定と代替候補を tbd_items[].candidates の形で返す（決められない',
      'なら blocking TBD として起票する）。',
      ''
    )
  }
  // requirements だけが改稿されたラウンドで findings が空のまま渡すと、spec-writer からは
  // 「指摘 0 件で改稿せよ」と読め、前稿をそのまま返すのが最も自然な応答になる。すると
  // 要求 ID の増減にトレーサビリティ表が追随せず、次ラウンドで片側 ID として検出され、
  // 改稿枠をもう 1 回消費する。引き直しの理由を明示する。
  if (!isReq && requirementsRevised) {
    tail.push(
      '# [REQUIREMENTS_REVISED] requirements 文書が改稿された',
      'この文書への指摘が 0 件でも、要求 ID の増減・文言変更にトレーサビリティ表と各仕様項目の',
      '紐付けを追随させること。追随に不要な箇所は前稿を維持すること。',
      ''
    )
  }
  return [
    `Read ${SKILL_DIR}/agents/${role}.md for your full role instructions before doing anything else.`,
    RULES,
    `契約は ${SKILL_DIR}/schemas/agent-contracts.md §${role} を正とする。`,
    '',
    CONTEXT_BLOCK,
    '',
    '# [THIS_DOCUMENT] あなたが改稿する 1 文書',
    `パス: ${doc.path}`,
    `扱う関心事: ${doc.concern || '(分割案に記載なし)'}`,
    `ID の領域プレフィックス: ${isReq ? 'PR' : 'SP'}-${areaCode(doc.topic)}-`,
    `未確定事項の ID: ${tbdPrefix(doc)}001 の形で振ること（この形以外で振らない）。`,
    '',
    '# [PREVIOUS] 前稿（これを改稿する。指摘の無い箇所は維持すること）',
    doc.markdown
      ? doc.markdown
      : [
          `**前稿は ${doc.draft_path} にある。まず Read すること。**`,
          '本文がここに埋め込まれていないのは、12 文書分の全文を引数で受け渡すと呼び出し側が',
          '全文を書き写して中継することになるためである。読み込めなかった場合は、推測で書き',
          '始めず、読み込めなかった事実を返すこと（前稿の無い改稿は新規執筆に化ける）。',
        ].join('\n'),
    '',
    '# [OTHER_DOCUMENTS] 同じ案件の他文書（重複を作らないための参照。ここは書き換えない）',
    otherDocsContext(doc) || '(他文書なし)',
    '',
    '# [NO_CHANGELOG] 改稿の経緯を成果物に残さない',
    '**変更履歴の章を置かない。** 版・日付・変更者・承認者・変更内容のいずれも書かない。',
    '**本文にも改稿の経緯を書かない。** 「前稿は〜だったが〜へ差し替えた」「監査指摘 FB-001 により〜」',
    '「R2.1 では〜を解消し」のような記述を、要求文・仕様項目・章の説明・INDEX 用の要約に入れない。',
    '前稿・版番号・監査指摘 ID を本文から参照しない。',
    '',
    'あなたが今行っているのは 1 回の実行の中の途中経過であり、利用者から見れば結果が 1 つ出るだけである。',
    '経緯を書くと**途中経過が成果物に化ける**。読み手が必要とするのは今の内容だけである。',
    '直した理由を残したくなったら、それは書かずに捨てる（この指示自体がその判断の根拠になる）。',
    '',
    '# [HOW_TO_RESOLVE] 指摘の解消は「足す」だけではない',
    '指摘はすべて「足りない / 曖昧 / 根拠が無い」の形で届く。そのため**書き足すことが唯一の解決に',
    '見えるが、そうではない**。次のどれも、指摘を正しく解消した状態である。',
    '',
    '- **既存の項目を書き直す**（新しい項目を足さずに、その項目の記述を直す）',
    '- **2 つの項目を 1 つに統合する**（同じ決定を指しているなら分かれている必要はない）',
    '- **項目を削除する** — 指摘が「根拠が無い」と言っているとき、**削除が正しい答えであることが多い。**',
    '  根拠の無い要求に長い説明を足しても、根拠が生まれるわけではない。入力に無い要求はそもそも',
    '  書いてはならないものなので、消すか、TBD として起票し直す。',
    '',
    '**新しい項目を足すのは、上のどれでも解消できないと確かめた後にする。**',
    '',
    '# [ITEM_BUDGET] 項目数を申告する',
    `前稿の項目数: ${(doc.items || []).length} 件`,
    '返り値の `item_delta` に、改稿後の件数・純増した件数・純増した各項目の ID と、なぜ既存項目の',
    '修正では足りなかったのかを書くこと。**数えてから足す**ためであり、増やしてはならないという',
    '意味ではない（本当に足りなければ足す）。',
    '',
    ...(doc.draft_path && doc.draft_path !== doc.path
      ? [
          '# [WRITE_BACK] 最終稿の書き出し',
          `改稿後の本文（返り値の markdown と同一内容）を ${doc.draft_path} に Write すること。`,
          '次周回はこのパスを下敷き（draft_path）として参照するため、書き出しが無いと再開時に前稿へ巻き戻る。',
          `保存先（${doc.path}）には書かない — そこへの書き出しは人間の承認後に司令塔が行う。`,
          '',
        ]
      : []),
    ...tail,
  ].join('\n')
}

function buildAuditPrompt(auditor, task, deferred, scopeNote) {
  const scoped =
    auditor.scope === 'all'
      ? documents.map((d) => `## ${d.path}（${d.concern}）${d.fixed ? '【このランの対象外・変更不可】' : ''}\n\n${bodyOf(d)}`).join('\n\n---\n\n')
      : task.docs.map((d) => `## ${d.path}（${d.concern}）\n\n${bodyOf(d)}`).join('\n\n---\n\n')

  const head = [
    `Read ${SKILL_DIR}/agents/${auditor.file} for your full role instructions before doing anything else.`,
    `契約は ${SKILL_DIR}/schemas/agent-contracts.md §${auditor.name}-auditor を正とする。`,
    '',
  ]

  if (auditor.name === 'executability') {
    head.push(
      '（この役割前提の正は agents/executability-auditor.md。ここは注入用の要約で、食い違ったら agent md 側に従うこと）',
      'あなたはこの文書を渡された実装担当者である。仕様の意図を知らず、書いてあるとおりにしか',
      '作れない。**依頼文も分析結果も持っていない。**',
      '',
      'ただし、**この文書が参照先として明示しているファイルは読めるものとして扱うこと。**',
      '文書が「詳細は X を正とする」と書いている場合、実装担当者は X を開ける。したがって',
      '**X を見れば分かることを「文書に書かれていないから着手できない」と判定してはならない。**',
      '判定すべきは「参照先を開いても、なお決まらないこと」である。',
      '参照先が実在しない・見ても該当箇所が無い場合は、それ自体を指摘すること。',
      '',
      '# [SELF_CONTAINMENT] この案件で合意した自己完結度の方針',
      selfContainment ||
        '(指定なし。文書本体と、文書が参照先として明示しているファイルの範囲で判定すること)',
      '',
      '各指摘に severity（blocking = 着手できない / degraded = 着手はできるが後で作り直しになりうる）を',
      '必ず付けること。',
      ''
    )
  } else {
    head.push(CONTEXT_BLOCK, '')
  }

  if (auditor.name === 'specimen') {
    head.push(
      '# [SPECIMENS] 実在の標本文書（各項目をここへ実際に適用する。Read すること）',
      specimenPaths.map((p) => `- ${p}`).join('\n'),
      '標本は判定装置のテスト入力であり、監査対象ではない（標本自体の品質は指摘しない）。',
      ''
    )
  }

  if (auditor.name === 'traceability') {
    head.push(
      '# [ALL_REQUIREMENT_IDS] 全 requirements 文書の要求 ID（他文書の ID を参照していても欠落ではない）',
      JSON.stringify(documents.filter((d) => d.kind === 'requirements').flatMap((d) => d.items), null, 2),
      ''
    )
  }

  if (auditor.name === 'consistency') {
    head.push(
      '# [INDEX_SOURCE] script が INDEX を組み立てるときに使う各文書の要約と ID 一覧',
      JSON.stringify(documents.map((d) => ({ path: d.path, concern: d.concern, summary: d.summary, items: d.items })), null, 2),
      'INDEX は script がこの値から機械的に組み立てる。要約や ID 一覧が本文と食い違っていれば、',
      'それは INDEX との齟齬として指摘すること（INDEX 本体は手書きされないため、齟齬はここに現れる）。',
      ''
    )
  }

  return [
    ...head,
    ...(scopeNote ? [scopeNote, ''] : []),
    '# [DOCUMENTS] 監査対象',
    scoped,
    '',
    '# [CATEGORIES_DEFERRED] 情報が未確定のため TBD として起票済みのカテゴリ',
    JSON.stringify(deferred, null, 2),
    'ここに挙がっているカテゴリは、章として書かれていなくても「反映漏れ」として扱わないこと。',
    'TBD として立てるのは正しい振る舞いであり、指摘すると writer は解消できず、改稿枠を空回りで',
    '消費したうえで章を捏造して埋める圧力がかかる。',
    '',
    '各指摘の document には、対象文書のパスをそのまま書くこと（どの文書を直せばよいか決まらないため）。',
    '検査した範囲を checked に必ず記述すること（何も読まずに failed: [] を返す余地を残さないため）。',
    '指摘が 0 件ならば failed は空配列で返すこと。0 件であること自体が報告に値する。',
  ].join('\n')
}

// ------------------------------------------------------- 構造検査（draft/refine 共通）
//
// この関数は scripts/draft.js に**逐語で複製**されている。workflow script は import を
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
          fix: 'TBD 表に解消条件（何がどう決まればこの項目が解消するか）を書き足す。',
        })
      }
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
      // キーに issue を含める。document|location だけだと、同じ章に対する複数の指摘が
      // 同一 ID に潰れ、片方が黙って消える（draft.js と同じ規約にすること）。
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

// ladderToTbd: スコープの梯子で premise / question に分類された指摘を blocking TBD として
// 起票し直す（execToTbd と同じ安定キー規約）。名前空間 TBD-NI- は「人間からしか得られない
// 入力を待つ（needs_input）」ことを読み手が区別できるようにするため。改稿予算は消費させない —
// 根拠が入力に無い指摘を writer に回しても、writer は根拠を発明できず、予算を消費してから
// TBD 起票で逃げるだけだった（実測）。
function ladderToTbd(entries) {
  return entries.map(({ kind, finding: f }) => ({
    id: `TBD-NI-${stableKey(`${f.document}|${f.location}|${f.issue}`)}`,
    text: `${f.issue}（想定される解消: ${f.fix || '依頼者の決定'}）`,
    owner: '',
    due: '',
    blocking: true,
    source: 'needs_input',
    needs_input_kind: kind === 'premise' ? 'data' : 'decision',
    source_finding_id: f.id,
    document: f.document,
    location: f.location,
  }))
}

// findingDigest: 指摘の同一性を改稿を跨いで追跡するための安定キー（stableKey/FNV-1a を再利用）。
// auditor + 宛先 + 場所 + issue 本文で導く。改稿で issue の文面が変われば別の指摘として数え直す
// （文面が変わった＝監査が新しい稿を見て判定し直した、であり不動点ではない）。
function findingDigest(f) {
  return stableKey(
    `${(f && f.auditor) || ''}|${(f && f.document) || ''}|${(f && f.location) || ''}|${(f && f.issue) || ''}`
  )
}

// computeNovelty: 乾き判定の判定材料。前ラウンドまでに見た digest 集合（seenDigests）に無い
// 新規指摘の件数を返し、今回分を集合へ足す。停止は証拠側に置く（新しい指摘がその周で 1 つも
// 出なかった＝乾いた）で、回数上限は backstop に格下げする — 回数で止めるループは、学び切る前に
// 止まるか、学び終えても回り続ける（実測: run9/10 とも毎回 backstop 到達で止まっていた）。
function computeNovelty(seenDigests, findings) {
  const digests = (findings || []).filter(Boolean).map((f) => f.digest || findingDigest(f))
  const novelty = digests.filter((dg) => !seenDigests.has(dg)).length
  for (const dg of digests) seenDigests.add(dg)
  return novelty
}

// buildNextArgs: needs_input（または未提示 blocking）を残して終わるとき、次周回にそのまま渡せる
// 完全な args を script が組み立てる。司令塔に 30〜70KB の args JSON を手組みさせると転記ミスが
// 混入する（digest の劣化・history の渡し忘れは実測済みの故障モード）ので、置換箇所を
// tbd_answers の "<<ANSWER_HERE>>" 1 点に絞る。script は FS を触れないため本文は持たせず、
// writer が draft_path へ Write 済みの文書は markdown を空にして draft_path 参照で渡す。
function buildNextArgs(ctx) {
  if (ctx.outer_round >= ctx.max_outer_rounds) return null
  if (!ctx.has_needs_input && !ctx.has_unpresented_blocking) return null
  return {
    skillDir: ctx.skillDir,
    mode: ctx.mode,
    input: ctx.input,
    answers: ctx.answers,
    decisions: ctx.decisions,
    tbd_answers: '<<ANSWER_HERE>>',
    tbd_answers_history: ctx.tbd_answers_history,
    documents: ctx.documents.map((d) => {
      // writer は draft_path が保存先 path と別のときだけ最終稿を Write する（保存先への直書きは
      // 人間ゲートを迂回するため指示しない）。Write 済みなら markdown を空にでき、args が痩せる。
      const wroteBack = Boolean(d.draft_path && d.draft_path !== d.path)
      return {
        key: d.key,
        kind: d.kind,
        topic: d.topic,
        concern: d.concern,
        path: d.path,
        draft_path: wroteBack ? d.draft_path : d.path,
        markdown: wroteBack ? '' : d.markdown,
        summary: d.summary,
        items: d.items,
        referenced_ids: d.referenced,
        traceability: d.traceability,
        tbd_items: d.tbd_items,
        categories_deferred: d.categories_deferred,
        fixed: d.fixed,
      }
    }),
    tbd_items: ctx.tbd_items,
    presented_tbd_ids: ctx.presented_tbd_ids,
    outer_round: ctx.outer_round + 1,
    domain_findings: ctx.domain_findings,
    required_categories: ctx.required_categories,
    self_containment: ctx.self_containment,
    paths: ctx.paths,
    today: ctx.today,
    ...(ctx.specimen_paths_arg && ctx.specimen_paths_arg.length
      ? { specimen_paths: ctx.specimen_paths_arg }
      : {}),
  }
}

// trackStuck: 不動点検出。tracker は digest → 連続出現ラウンド数。改稿を経ても同一 digest の
// まま残ることが threshold 回連続した指摘を stuck（回答不能候補）に分類し、通常の改稿ループから
// 外す。今回消えた digest は tracker から落とす — 一度消えた指摘が別の形で再出現したら、それは
// 前進の結果なので数え直す。survived_revisions = 出現回数 - 1（初出は改稿を経ていない）。
function trackStuck(tracker, findings, threshold) {
  const next = {}
  const stuck = []
  const active = []
  for (const f of findings || []) {
    if (!f) continue
    const dg = findingDigest(f)
    // 同一ラウンド内の重複 digest は 1 回として数える（重複で二重加算すると初出が stuck に化ける）
    const count = next[dg] !== undefined ? next[dg] : (((tracker && tracker[dg]) || 0) + 1)
    next[dg] = count
    const tagged = { ...f, digest: dg, survived_revisions: count - 1 }
    if (count - 1 >= threshold) stuck.push(tagged)
    else active.push(tagged)
  }
  return { tracker: next, stuck, active }
}

// buildScopeNote: 指摘起因の改稿の後の再監査を、当該指摘の document / location に対応する
// 範囲（当該 SP 項目・当該章）に限定する指示文を組み立てる。全文を毎回 7 観点で再監査すると、
// 改稿のたびに新しい仕上げレベルの指摘が汲み出され、生成量 ≈ 消化量で総数が減らない（実測）。
function buildScopeNote(findings) {
  const ranges = []
  const seen = new Set()
  for (const f of findings || []) {
    if (!f || !f.document) continue
    const key = `${f.document}::${f.location || ''}`
    if (seen.has(key)) continue
    seen.add(key)
    ranges.push(`- ${f.document} の「${f.location || '(場所指定なし)'}」`)
  }
  if (!ranges.length) return ''
  return [
    '# [AUDIT_SCOPE] 監査範囲の限定',
    '今回の監査対象は、直前の改稿の契機になった指摘に対応する次の範囲だけである。',
    ...ranges,
    'この範囲だけを見る。checked にその範囲を書くこと。範囲外の箇所への新規指摘は起票しない',
    '（全文の網羅監査は改稿ループの収束後に終端で 1 回だけ行われる）。',
  ].join('\n')
}

// ------------------------------------------- スコープの梯子（ladder-judge）
//
// 監査指摘を writer に渡す前に、専任 judge が failure kind で 4 分類する（判定表は
// schemas/agent-contracts.md §ladder-judge が正）。戻り先が writer 改稿 1 種類しか無いと、
// 「根拠が入力に無い」指摘まで同じ浅い段を掘り直し、改稿予算を消費してから TBD 起票で逃げる。
// artifact / criteria だけを改稿ループへ流し、premise / question は即座に blocking TBD
// （TBD-NI-）へ起票して needs_input 側に集める。分類は生成側と別 spawn の judge が行い、
// 表に無い状況で規則を発明せず question（needs_input(decision)）へ落とす。
const LADDER_KINDS = ['artifact', 'criteria', 'premise', 'question']
const LADDER_SCHEMA = {
  type: 'object',
  properties: {
    classified: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          digest: { type: 'string' },
          kind: { type: 'string', enum: LADDER_KINDS },
          rationale: { type: 'string' },
        },
        required: ['digest', 'kind', 'rationale'],
      },
    },
  },
  required: ['classified'],
}

async function classifyFindings(findings, label) {
  const withDigest = findings.map((f) => ({ ...f, digest: f.digest || findingDigest(f) }))
  const res = await agent(
    [
      `Read ${SKILL_DIR}/agents/ladder-judge.md for your full role instructions before doing anything else.`,
      `判定表と契約は ${SKILL_DIR}/schemas/agent-contracts.md §ladder-judge を正とする。`,
      '',
      '# [FINDINGS] 分類対象（digest で照合される。digest を書き換えない）',
      JSON.stringify(
        withDigest.map(({ digest, auditor, document, location, quote, issue, fix, severity }) => ({
          digest, auditor, document, location, quote, issue, fix, severity,
        })),
        null,
        2
      ),
    ].join('\n'),
    { model: 'sonnet', schema: LADDER_SCHEMA, phase: 'Audit', label }
  )
  const kindByDigest = new Map(
    (((res || {}).classified) || [])
      .filter((e) => e && e.digest && LADDER_KINDS.includes(e.kind))
      .map((e) => [e.digest, e.kind])
  )
  const toWriter = []
  const needsInput = []
  for (const f of withDigest) {
    const kind = kindByDigest.get(f.digest)
    if (kind === 'premise' || kind === 'question') needsInput.push({ ...f, ladder_kind: kind })
    // judge が応答しなかった / 分類が欠けた指摘は従来どおり writer へ流す。分類の欠測で
    // 改稿経路そのものを止めない（欠測を needs_input に読み替えると偽の質問が人間へ飛ぶ）。
    else toWriter.push({ ...f, ladder_kind: kind || 'artifact' })
  }
  return { toWriter, needsInput }
}

// validateAdjudication: 終端裁定の三値分類（fixed / rejected / documented）を検証する。
// rejected は理由必須（理由の無い棄却は分類から落とし、unadjudicated に戻す）。
// どの分類にも digest が現れなかった指摘が unadjudicated であり、空であることを script が
// 検証する — 空でなければ verdict に反映して明示する（未裁定 limbo を黙って残さない）。
function validateAdjudication(adj, findings) {
  const norm = (list) => (Array.isArray(list) ? list.filter((e) => e && e.digest) : [])
  const fixed = norm((adj || {}).fixed)
  const rejected = norm((adj || {}).rejected).filter((e) => e.reason)
  const documented = norm((adj || {}).documented)
  const covered = new Set([...fixed, ...rejected, ...documented].map((e) => e.digest))
  const unadjudicated = (findings || []).filter(
    (f) => f && !covered.has(f.digest || findingDigest(f))
  )
  return { fixed, rejected, documented, unadjudicated }
}

// contradictionPassTargets: 改稿上限到達後に 1 回だけ許す「矛盾解消専用の追加改稿」へ渡す
// 指摘を選ぶ。blocking だけを返し、degraded は返さない — degraded を混ぜると通常の改稿と
// 区別がつかず、追加枠が改稿回数の実質的な引き上げに化ける。fail-open/fail-closed の
// 適用範囲の重なり（前提 7）のような定義同士の矛盾は blocking で届くため、この選別が
// 追加改稿の対象をその種の欠陥に限定する（実測: run5 で定義矛盾が上限内に解消できず
// unresolved のまま残った）。
function contradictionPassTargets(findings) {
  return (findings || []).filter((f) => f && f.severity === 'blocking')
}

// rebuildTbd: 現ラウンドの申告を正として TBD 集合を組み直す。
//
// 単純な統合（前回分と今回分を無条件にマージ）にすると集合が単調増加し、**解決した TBD が
// 二度と消えない**。ユーザーが答えて writer が本文に反映しても、前回の一覧に残っている限り
// 未確定として数え続け、「あと N 個決まれば着手できます」の N が永遠に減らない。
//
// 現在の TBD = 最新の documents[].tbd_items ∪ 今回の execTbd。
// previous は「提示済みか」「初出はいつか」というメタデータの供給元としてのみ参照し、
// 本体の復活源にはしない。前回あって今回消えた ID は resolved として別に返す。
function rebuildTbd(currentLists, previousItems) {
  const prevById = new Map((previousItems || []).filter((t) => t && t.id).map((t) => [t.id, t]))
  const map = new Map()
  for (const item of currentLists.flat()) {
    if (!item || !item.id) continue
    const prev = prevById.get(item.id)
    const existing = map.get(item.id)
    const base = existing || {}
    map.set(item.id, {
      ...base,
      ...item,
      text: item.text || base.text || (prev && prev.text) || '',
      // owner / due は人間が埋めた値なので、前回分を引き継ぐ（writer は空で返してくる）。
      owner: item.owner || base.owner || (prev && prev.owner) || '',
      due: item.due || base.due || (prev && prev.due) || '',
      // blocking は最新の申告を採る。OR にすると、解消して非 blocking になった項目が
      // 前回の判定に引きずられて着手不能のまま残る。
      blocking: Boolean(item.blocking),
      first_seen_round: (prev && prev.first_seen_round) || (prev ? prev.round : undefined) || outerRound,
    })
  }
  const current = [...map.values()]
  const resolved = [...prevById.keys()].filter((id) => !map.has(id))
  return { current, resolved }
}

// cell: markdown 表の中で | が現れると列が割れる。INDEX は script が組み立てるので
// ここで潰しておかないと、writer の要約に | が 1 つ入っただけで目次の表が崩れる。
const cell = (s) => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')

// 文書一覧・ID 一覧・検査結果を機械的に組み立てる。INDEX を手書きさせないのは、
// 手書きの目次が必ず本体と drift するため。script はファイルに触れないので、
// ここでは内容だけを返し、保存は SKILL.md が行う。
function buildIndex(kind, docs, tbdItems, structural) {
  const dir = kind === 'requirements' ? reqDir : specDir
  const label = kind === 'requirements' ? '要求' : '仕様項目'
  const target = docs.filter((d) => d.kind === kind)
  const lines = [`# ${dir} 目次`, '', `この INDEX は自動生成される導出物である。本体を直したら再生成すること（手書きしない）。`, '']

  lines.push('## 文書一覧', '', `| パス | 扱う関心事 | どういう${label}が書かれているか |`, '|---|---|---|')
  for (const d of target) lines.push(`| \`${d.path}\` | ${cell(d.concern)} | ${cell(d.summary)} |`)
  lines.push('')

  lines.push(`## ${label}一覧`, '', `| ID | 見出し | 所在文書 |`, '|---|---|---|')
  for (const d of target) for (const item of d.items) lines.push(`| ${cell(item.id)} | ${cell(item.heading)} | \`${d.path}\` |`)
  lines.push('')

  if (kind === 'requirements') {
    // 要求 → 仕様は横断しないと辿れない（どの specification 文書にあるか分からない）ので
    // INDEX に持つ。逆向き（仕様 → 要求）は各 specification 文書のトレーサビリティ表に
    // 既にあるので INDEX には置かない（写しになる）。
    lines.push('## 関連する仕様文書', '', '| requirements 文書 | 対応する specifications 文書 |', '|---|---|')
    const specDocs = docs.filter((d) => d.kind === 'specifications')
    for (const d of target) {
      const own = new Set(d.ids)
      const related = specDocs
        .filter((s) => (s.traceability || []).some((l) => own.has(l.requirement_id)))
        .map((s) => `\`${s.path}\``)
      lines.push(`| \`${d.path}\` | ${related.join(' / ') || '（対応する仕様文書なし）'} |`)
    }
    lines.push('')

    lines.push('## 未解決（着手を止める未確定事項）', '')
    const blocking = tbdItems.filter((t) => t.blocking)
    if (!blocking.length) {
      lines.push('着手を止める未確定事項は 0 件である。', '')
    } else {
      lines.push('| ID | 内容 | 所在 | 提示状況 |', '|---|---|---|---|')
      for (const t of blocking) {
        lines.push(`| ${cell(t.id)} | ${cell(t.text)} | ${cell(t.document || '—')} | ${presentedIds.has(t.id) ? '提示済み（未決定）' : '**未提示**'} |`)
      }
      lines.push('')
    }
  }

  lines.push('## 検査結果', '')
  const dup = structural.filter((f) => f.id.startsWith('ST-DUP')).length
  if (kind === 'requirements') {
    const orphan = structural.filter((f) => f.id.startsWith('ST-ORPHAN-REQ')).length
    lines.push(`- ID の重複: ${dup} 件`, `- 実現する仕様項目が無い要求: ${orphan} 件`, '')
  } else {
    lines.push(`- ID の重複: ${dup} 件`, '')
  }

  return lines.join('\n')
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

// ---------------------------------------------------------------- Reflect

phase('Reflect')

const writerMissing = []
const revisionLog = []


let revisions = 0

// forceAll: 人間ゲート②の回答を反映する最初のパスで使う。このパスは監査指摘ではなく回答が
// 契機なので、findings が空でも全文書を引き直す必要がある（回答がどの文書に効くかは
// 書いてみるまで決まらない）。findings で絞ると、反映パスが 1 文書も動かないまま通る。
async function reviseDocuments(findingsByDoc, revisionId, forceAll) {
  // requirements を先に流し切ってから specifications に入る。仕様項目は文書を跨いだ
  // 要求 ID を引くため、要求側の増減が確定するまで紐付けを直しようがない。
  let requirementsRevised = false

  const runFor = async (kind) => {
    const subset = documents.filter((d) => d.kind === kind && !d.fixed)
    const targetsForRound = subset.filter((d) => {
      if (forceAll) return true
      const f = findingsByDoc.get(d.key) || []
      if (f.length) return true
      // 指摘 0 件でも、要求側が改稿されたラウンドの仕様書は紐付けの追随のために引き直す。
      return kind === 'specifications' && requirementsRevised
    })
    if (!targetsForRound.length) return
    const results = await runWithRetry(
      `改稿 ${revisionId}`,
      targetsForRound,
      (doc, attempt) =>
        agent(buildWriterPrompt(doc, findingsByDoc.get(doc.key) || [], revisionId, requirementsRevised), {
          model: 'opus',
          schema: kind === 'requirements' ? REQ_DOC_SCHEMA : SPEC_DOC_SCHEMA,
          phase: revisionId.endsWith('.0') ? 'Reflect' : 'Revise',
          label: `${kind === 'requirements' ? 'req' : 'spec'}-${doc.topic}-${revisionId}${attempt > 1 ? `-retry${attempt - 1}` : ''}`,
        }).then((result) => ({ doc, result: result || null })),
      (r) => r && r.result && r.result.markdown
    )
    for (const { doc, result } of results) {
      if (!result || !result.markdown) {
        // 改稿が返らなければ前稿を維持する。空で上書きすると改稿前より悪化する。
        // ただし「直そうとして直らなかった」と「一度も直されていない」は区別して返す。
        writerMissing.push(`${doc.key}@${revisionId}`)
        log(`改稿 ${revisionId}: ${doc.key} の writer が応答せず、前稿を維持しました。`)
        continue
      }
      const idx = documents.findIndex((d) => d.key === doc.key)
      const items = kind === 'requirements' ? result.requirement_items || [] : result.spec_items || []
      documents[idx] = {
        ...documents[idx],
        markdown: result.markdown,
        summary: result.summary || documents[idx].summary,
        items,
        ids: items.map((i) => i.id).filter(Boolean),
        referenced: result.referenced_ids || [],
        traceability: kind === 'specifications' ? result.traceability || [] : [],
        tbd_items: result.tbd_items || [],
        categories_deferred: result.categories_deferred || [],
        item_delta: result.item_delta || null,
      }
      if (kind === 'requirements') requirementsRevised = true
    }
  }

  await runFor('requirements')
  await runFor('specifications')
  return requirementsRevised
}

// 回答が来ているときだけ反映パスを走らせる。人間ゲート②を飛ばした（blocking 0 件の）ランで
// 空の反映パスを回すと、直す理由が無いまま opus が全文書を書き直し、初稿が理由なく変わる。
if (tbdAnswers) {
  await reviseDocuments(new Map(), `R${outerRound}.0`, true)
  revisionLog.push({ revision_id: `R${outerRound}.0`, trigger: ['人間ゲート②の回答'], reason: 'TBD 回答の反映', changed_by: 'user 回答の反映' })
} else {
  log('人間ゲート②の回答が空のため、反映パスを飛ばして監査から始めます。')
}

// ---------------------------------------------------------------- Audit / Revise ループ

let byName = {}
let missing = []
let allFailed = []
let structural = []
// structuralNotChecked: 材料が無くて実行できなかった検査。失格ではないが「0 件」でもない。
let structuralNotChecked = []
// fixedFindings: このランの対象外の文書への指摘。改稿トリガから外し、人間に返す。
let fixedFindings = []
let execFindings = []
// 不動点検出の状態。stuckTracker は digest → 連続残存ラウンド数。stuckFindings は
// STUCK_THRESHOLD 回連続で同一 digest のまま残り、通常改稿から外して escalation へ回す指摘。
let stuckTracker = {}
let stuckFindings = []
let backstopReached = false
// 乾き停止の状態。noveltySeen は全ラウンドで見た digest の累積集合。novelty（新規指摘の件数）が
// 0 のラウンドが出たら、改稿予算が残っていても改稿ループを抜けて終端（網羅監査→裁定）へ進む。
let dryStop = false
const noveltySeen = new Set()
const noveltyHistory = []
// needs_input: スコープの梯子で premise / question に分類され、改稿予算を消費させずに
// blocking TBD へ起票し直した指摘。digest をキーに周回内で累積する（監査が同じ指摘を
// 再起票しても二重に集めない）。
const needsInputByDigest = new Map()
// lastRevisionFindings: 直前の改稿の契機になった指摘。指摘起因の改稿の後の再監査は、この範囲に
// 限定する（scopedAuditUsed が立ったランは、収束後に終端の網羅監査を 1 回だけ行う）。
let lastRevisionFindings = null
let scopedAuditUsed = false

while (true) {
  phase('Audit')

  const { deferred, findings: roundCategoryFindings } = reconcileCategories(
    documents,
    requiredCategories
  )
  const auditable = documents.filter((d) => !d.fixed)

  // audit_rounds: agent 監査を実施するラウンド数（既定は全ラウンド）。1 を渡すと r0 だけ
  // agent に見せ、以降は構造検査（script の算術）だけで改稿ループを回す。
  // 中断したランを再開するときのための縮退で、狙いは「診断は済んでいるが適用が終わって
  // いない」状態を、監査をもう一巡させずに閉じること。構造検査は agent を使わないので
  // 抑制しない — 片側 ID と TBD 申告漏れはこのスキルの契約そのものであり、
  // 改稿のたびに再計算されなければ、直したつもりの取りこぼしが検出されない。
  const skipAgentAudit = revisions >= auditRounds
  const tasks = []
  if (skipAgentAudit) {
    log(
      `Audit r${revisions}: agent 監査は実施しません（audit_rounds=${auditRounds}）。` +
        `構造検査だけで改稿ループを続けます。各観点の件数は r${auditRounds - 1} の結果を保持します。`
    )
  }
  for (const auditor of skipAgentAudit ? [] : AUDITORS) {
    // specimen は初回の全範囲監査だけに参加する（毎改稿のスコープ監査には参加しない —
    // 標本への全項目適用は重く、範囲限定と相性が悪い。終端の網羅監査で再参加する）。
    if (auditor.name === 'specimen') {
      if (specimenSkipped) {
        if (revisions === 0 && !lastRevisionFindings) {
          log('specimen 監査は skip: 標本文書が 1 件も無いため（欠測ではありません。specimen_skipped: true として返します）')
        }
        continue
      }
      if (revisions > 0 || lastRevisionFindings) continue
      for (const kind of ['requirements', 'specifications']) {
        const subset = auditable.filter((d) => d.kind === kind)
        if (subset.length) tasks.push({ auditor, target: `KIND:${kind}`, docs: subset })
      }
      continue
    }
    if (auditor.scope === 'all') {
      // consistency は文書「間」の重複・矛盾の検査。対象が 1 文書だけのランでは検査対象が
      // 構造的に存在しない（実測: 単一文書ラン 3 回連続で指摘 0 件）。発行すると「0 件」に
      // 見えるが実際は出番が無かっただけなので、traceability と同じく未実施（null）にする。
      if (auditor.name === 'consistency' && auditable.length < 2) {
        log('consistency 監査は未実施: 対象が 1 文書のみで文書間検査が成立しないため（指摘 0 件ではありません）')
        continue
      }
      tasks.push({ auditor, target: 'ALL', docs: auditable })
      continue
    }
    // traceability は要求 ID と仕様項目 ID の突き合わせなので、要求文書が 1 件も対象に
    // 含まれないランでは検査が成立しない。それでも発行すると auditor は正常に応答し、
    // 「紐付け欠落 0 件」として数えられる — 紐付け先が存在しない状態で。
    // 発行しなければ received が 0 のままになり、summary が null（＝未検査）を返す。
    if (auditor.name === 'traceability' && !documents.some((d) => d.kind === 'requirements')) {
      log('traceability 監査は未実施: requirements 文書が本ランの対象に含まれないため（指摘 0 件ではありません）')
      continue
    }
    const subset = auditor.scope === 'each' ? auditable : auditable.filter((d) => d.kind === auditor.scope)
    for (const d of subset) tasks.push({ auditor, target: d.key, docs: [d] })
  }

  // 全件を待ち合わせる（barrier）のが正当な理由: 次の判断は「改稿するかどうか」であり、それは
  // 7 観点の指摘を横断して見なければ決まらない。clarity の指摘だけ先に writer へ戻すと、同じ稿に
  // 対する consistency の指摘が古い稿を前提にしたものになり、改稿が噛み合わなくなる。
  // 結果は必ず名前付きで受け取る。素の .filter(Boolean) で潰すと「どの auditor が欠けたか」が
  // 失われ、応答しなかった auditor が「失格 0 件」に化ける（最も危険な読み替え）。
  // 応答しなかった検査は runWithRetry が出し直す。**未実施は失敗であって仕様ではない。**
  // 1 回落ちただけで「未検査」として人間へ返すと、一過性の API エラーが恒久的な欠測に化ける。
  // スコープ監査: 指摘起因の改稿の後は、その指摘に対応する範囲だけを再監査する。
  // 回答反映パス（R<outer>.0）の後の初回監査は lastRevisionFindings が null なので全範囲。
  const roundScopeNote = lastRevisionFindings ? buildScopeNote(lastRevisionFindings) : ''
  if (roundScopeNote && !skipAgentAudit) {
    log(
      `スコープ監査の対象範囲 (r${revisions}): ` +
        [...new Set(lastRevisionFindings.map((f) => `${f.document}:${f.location || ''}`))].join(' / ')
    )
  }
  const wrapped = await runWithRetry(
    `Audit r${revisions}`,
    tasks,
    (task, attempt) =>
      agent(buildAuditPrompt(task.auditor, task, deferred, roundScopeNote), {
        model: task.auditor.model,
        schema: AUDIT_SCHEMA,
        phase: 'Audit',
        label: `${task.auditor.name}-${task.target}-r${revisions}${attempt > 1 ? `-retry${attempt - 1}` : ''}`,
      }).then((result) => ({ auditor: task.auditor.name, target: task.target, result: result || null })),
    (r) => r && r.result
  )

  const received = wrapped.filter(Boolean)
  // agent 監査を実施しなかったラウンドでは missing / byName を更新しない。ここで空の tasks を
  // 元に組み直すと、expected が 0 になって summary の各観点が「検査して 0 件」に化ける。
  // 実施した最後のラウンドの結果を保持するのが正しい（未実施を 0 件と読ませない）。
  if (!skipAgentAudit) {
    missing = tasks
      .filter((t) => !received.some((r) => r.auditor === t.auditor.name && r.target === t.target && r.result))
      .map((t) => `${t.auditor.name}@${t.target}`)

    // specimen は初回にしか発行されない。後続ラウンドで空エントリに作り直すと、初回の
    // 「検査して N 件」が「未検査（null）」に化けるので、発行の無いラウンドは前回分を保持する。
    const prevSpecimen = byName.specimen
    byName = {}
    for (const auditor of AUDITORS) byName[auditor.name] = { received: 0, expected: 0, failed: [] }
    for (const t of tasks) byName[t.auditor.name].expected++
    if (!tasks.some((t) => t.auditor.name === 'specimen') && prevSpecimen) byName.specimen = prevSpecimen
  }

  const docKeys = new Set(documents.map((d) => d.key));
  const pathToKey = new Map(documents.map((d) => [d.path, d.key]))

  allFailed = []
  execFindings = []
  fixedFindings = []
  for (const r of received) {
    if (!r.result) continue
    byName[r.auditor].received++
    for (const finding of r.result.failed || []) {
      // 指摘の宛先は script が決める。単一文書を見た auditor の指摘は必ずその文書のもので、
      // agent の自己申告を信じると綴り違いで宛先を失い、改稿に回らないまま unresolved に落ちる。
      let docKey = r.target
      if (r.target === 'ALL' || String(r.target).startsWith('KIND:')) {
        docKey = pathToKey.get(finding.document) || (docKeys.has(finding.document) ? finding.document : null)
      }
      const routed = { auditor: r.auditor, ...finding, document: docKey, unroutable: !docKey }
      byName[r.auditor].failed.push(routed)
      allFailed.push(routed)
      if (r.auditor === 'executability') execFindings.push(routed)
    }
  }

  // 構造検査は auditor の応答有無と無関係に必ず走る。集合差分と禁止語の混入は agent が
  // 落ちても検出される（この 2 つがこのスキルの契約そのものだから）。
  const structResult = structuralFindings(documents)

  // 構造検査は素の ID に対して走らせる（writer の採番ミスをそのまま指摘するため）。
  // そのうえで documents[].tbd_items を正規化し、rebuildTbd の ID キー統合が
  // 別文書の同名 ID を後勝ちで潰すのを防ぐ。退避の事実は同じラウンドの改稿契機に乗せる。
  const { findings: tbdRenumbered, byKey: tbdByKey } = namespaceTbd(documents)
  for (const d of documents) d.tbd_items = tbdByKey[d.key] || []

  structural = [...structResult.findings, ...roundCategoryFindings, ...tbdRenumbered]
  structuralNotChecked = structResult.not_checked
  // 固定文書（このランの対象外）への指摘は改稿トリガから外す。改稿しない文書の指摘で
  // writer を回すと、直せない指摘のまま改稿枠を消費する。別配列で人間に返す。
  const fixedKeys = new Set(documents.filter((d) => d.fixed).map((d) => d.key))
  for (const f of structural) {
    if (fixedKeys.has(f.document)) fixedFindings.push(f)
    else allFailed.push(f)
  }
  // 初稿（Workflow A）の構造検査結果も初回ラウンドの改稿トリガに合流させる。
  // A で計算して捨てると、ID 重複や廃止規制語が誰にも読まれないまま次のゲートへ進む。
  if (revisions === 0 && draftStructural.length) {
    for (const f of draftStructural) {
      if (fixedKeys.has(f.document)) continue
      if (structural.some((s) => s.id === f.id)) continue
      allFailed.push({ ...f, from_draft: true })
    }
  }

  if (missing.length) {
    log(`監査未完了: ${missing.join(' / ')} が応答しませんでした（失格 0 件とは読みません）`)
  }
  const unroutable = allFailed.filter((f) => f.unroutable).length
  log(
    `Audit r${revisions}: 失格 ${allFailed.length} 件（構造検査 ${structural.length} 件 / 未応答 ${missing.length} 件 / 宛先不明 ${unroutable} 件）`
  )

  // needs_input へ起票済みの指摘は改稿・裁定の対象から外す（既に blocking TBD として
  // 人間ゲートへ向かっている。残すと同じ論点が unresolved と TBD に二重計上される）。
  if (needsInputByDigest.size) {
    allFailed = allFailed.filter((f) => !needsInputByDigest.has(findingDigest(f)))
  }

  if (allFailed.length === 0) break

  // 乾き停止: このラウンドの指摘のうち、前ラウンドまでに見た digest 集合に無い新規指摘の
  // 件数（novelty）を算出する。novelty 0 のラウンドが出たら、改稿予算が残っていても
  // 改稿ループを抜けて終端（網羅監査→裁定）へ進む。停止は証拠側（乾き）に置き、
  // REVISION_BACKSTOP は暴走防止の backstop としてだけ残す。
  const novelty = computeNovelty(noveltySeen, allFailed)
  noveltyHistory.push(novelty)
  log(`Audit r${revisions}: novelty ${novelty} 件（前ラウンドまでに無い新規指摘の件数）`)
  if (novelty === 0) {
    dryStop = true
    log(
      '乾き停止: 新規指摘が 0 件のラウンドに達しました。改稿予算が残っていても改稿ループを抜け、' +
        '終端（網羅監査→裁定）へ進みます。'
    )
    break
  }

  // 不動点検出: 改稿を跨いで同一 digest のまま残る指摘を数え、STUCK_THRESHOLD 回連続で
  // 残ったものを stuck として通常改稿から外す。停止条件は「新規（active）指摘が尽きた」で、
  // 固定回数ではない（固定上限は「進んでいるのに切る」を起こした実績がある）。
  const tracked = trackStuck(stuckTracker, allFailed, STUCK_THRESHOLD)
  stuckTracker = tracked.tracker
  stuckFindings = tracked.stuck
  const activeFindings = tracked.active

  if (!activeFindings.length) {
    log(
      `全 ${stuckFindings.length} 件が stuck（${STUCK_THRESHOLD} 回連続で同一 digest のまま残存）。` +
        '改稿ループを停止し、多角化 escalation（1 回きり）へ回します。'
    )
    break
  }

  // スコープの梯子: writer に渡す前に専任 judge が failure kind で 4 分類する。
  // artifact / criteria だけを改稿ループへ流す。premise / question は改稿予算を消費させず、
  // 即座に blocking TBD（TBD-NI-）へ起票して needs_input 側に集める。
  const laddered = await classifyFindings(activeFindings, `ladder-judge-r${revisions}`)
  if (laddered.needsInput.length) {
    for (const f of laddered.needsInput) {
      if (!needsInputByDigest.has(f.digest)) {
        needsInputByDigest.set(f.digest, { kind: f.ladder_kind, finding: f })
      }
    }
    const niDigests = new Set(laddered.needsInput.map((f) => f.digest))
    allFailed = allFailed.filter((f) => !niDigests.has(findingDigest(f)))
    log(
      `ladder-judge: ${laddered.needsInput.length} 件を needs_input（premise / question）に分類し、` +
        'blocking TBD として起票しました（改稿予算は消費しません）。'
    )
  }
  const reviseTargets = laddered.toWriter
  if (!reviseTargets.length) {
    log('改稿対象の指摘（artifact / criteria）が 0 件のため、改稿ループを抜けて終端へ進みます。')
    break
  }

  if (revisions >= REVISION_BACKSTOP) {
    backstopReached = true
    log(
      `総改稿 backstop ${REVISION_BACKSTOP} 回に到達（verdict: revision_backstop_reached）。` +
        `残る ${allFailed.length} 件は unresolved として返します。`
    )
    break
  }
  if (stuckFindings.length) {
    log(
      `stuck 指摘 ${stuckFindings.length} 件を通常改稿から外しました（escalation で一括処理します）。` +
        `active ${activeFindings.length} 件で改稿を続けます。`
    )
  }

  phase('Revise')
  revisions++
  const revisionId = `R${outerRound}.${revisions}`

  const byDoc = new Map()
  for (const f of reviseTargets) {
    if (!f.document) continue
    if (!byDoc.has(f.document)) byDoc.set(f.document, [])
    byDoc.get(f.document).push(f)
  }

  revisionLog.push({
    revision_id: revisionId,
    trigger: [...new Set(reviseTargets.map((f) => f.id))].slice(0, 50),
    reason: `監査指摘 ${reviseTargets.length} 件の解消（stuck ${stuckFindings.length} 件 / needs_input ${laddered.needsInput.length} 件は除外）`,
    changed_by: '監査指摘の解消',
    auditors: [...new Set(reviseTargets.map((f) => f.auditor))],
    missing_auditors: [...missing],
    unroutable_findings: unroutable,
  })

  await reviseDocuments(byDoc, revisionId, false)
  lastRevisionFindings = reviseTargets
  scopedAuditUsed = true
}

// ------------------------------------------- 矛盾解消専用の追加改稿（blocking 限定・1 回きり）
//
// 改稿上限に達しても blocking が残っているときだけ、追加 1 回の改稿を許す。契機は run5 の
// 実測: 監査指摘への改稿のたびに定義・共通規則が厚くなり、新しい定義同士の矛盾
// （fail-closed の規則と fail-open の規則が同じ入力に真逆の判定を与える）が上限の最終盤で
// 露出して、上限内に解消できないまま unresolved に落ちた。この種の欠陥は着手を止めるので、
// 「上限だから」で残すより 1 回の限定改稿の方が安い。
//
// 制約: 追加は 1 回きり（ループにしない）。writer に渡すのは blocking だけ（degraded を
// 混ぜると上限の実質引き上げになる）。再監査は validity と executability の 2 観点だけ
// （定義矛盾はこの 2 観点でしか出ないことが実測されている。checklist の完成品評価では
// 出なかった）。それでも blocking が消えなければ、そこで打ち切って unresolved として返す。
{
  const blockingLeft = contradictionPassTargets(allFailed)
  if (blockingLeft.length) {
    phase('Revise')
    log(
      `改稿上限到達後も blocking が ${blockingLeft.length} 件残っているため、` +
        '矛盾解消専用の追加改稿を 1 回だけ行います（blocking 限定。degraded は渡しません）。'
    )
    revisions++
    const revisionId = `R${outerRound}.${revisions}`
    revisionLog.push({
      revision_id: revisionId,
      trigger: [...new Set(blockingLeft.map((f) => f.id))].slice(0, 50),
      reason: `blocking 指摘 ${blockingLeft.length} 件に限定した矛盾解消の追加改稿（1 回きり）`,
      changed_by: '監査指摘の解消',
      auditors: [...new Set(blockingLeft.map((f) => f.auditor))],
      extra_contradiction_pass: true,
    })
    const byDoc = new Map()
    for (const f of blockingLeft) {
      if (!f.document) continue
      if (!byDoc.has(f.document)) byDoc.set(f.document, [])
      byDoc.get(f.document).push(f)
    }
    await reviseDocuments(byDoc, revisionId, false)

    // 再監査は validity / executability の 2 観点だけ。全 7 観点を回すと監査 1 周分の
    // コストになり、収束機構の較正（網羅監査は終端 1 回だけ）を追加パスが破る。
    const auditable = documents.filter((d) => !d.fixed)
    const { deferred } = reconcileCategories(documents, requiredCategories)
    const recheckTasks = []
    for (const auditor of AUDITORS.filter((a) => a.name === 'validity' || a.name === 'executability')) {
      if (auditor.scope === 'all') recheckTasks.push({ auditor, target: 'ALL', docs: auditable })
      else for (const d of auditable) recheckTasks.push({ auditor, target: d.key, docs: [d] })
    }
    const wrapped = await runWithRetry(
      `Audit recheck r${revisions}`,
      recheckTasks,
      (task, attempt) =>
        agent(buildAuditPrompt(task.auditor, task, deferred), {
          model: task.auditor.model,
          schema: AUDIT_SCHEMA,
          phase: 'Audit',
          label: `${task.auditor.name}-${task.target}-r${revisions}${attempt > 1 ? `-retry${attempt - 1}` : ''}`,
        }).then((result) => ({ auditor: task.auditor.name, target: task.target, result: result || null })),
      (r) => r && r.result
    )
    const received = wrapped.filter(Boolean).filter((r) => r.result)

    // 再実行した 2 観点は最新の結果で置き換える（実施した最後のラウンドの結果を保持する規約）。
    // 他 5 観点の指摘は再検査していないので、そのまま unresolved に残す。
    const recheckNames = new Set(['validity', 'executability'])
    allFailed = allFailed.filter((f) => !recheckNames.has(f.auditor) && f.auditor !== 'structural')
    execFindings = []
    for (const name of recheckNames) {
      byName[name] = {
        received: 0,
        expected: recheckTasks.filter((t) => t.auditor.name === name).length,
        failed: [],
      }
    }
    const docKeys = new Set(documents.map((d) => d.key))
    const pathToKey = new Map(documents.map((d) => [d.path, d.key]))
    for (const r of received) {
      byName[r.auditor].received++
      for (const finding of r.result.failed || []) {
        let docKey = r.target
        if (r.target === 'ALL' || String(r.target).startsWith('KIND:')) {
          docKey = pathToKey.get(finding.document) || (docKeys.has(finding.document) ? finding.document : null)
        }
        const routed = { auditor: r.auditor, ...finding, document: docKey, unroutable: !docKey }
        byName[r.auditor].failed.push(routed)
        allFailed.push(routed)
        if (r.auditor === 'executability') execFindings.push(routed)
      }
    }
    missing = [
      ...missing.filter((m) => ![...recheckNames].some((n) => m.startsWith(`${n}@`))),
      ...recheckTasks
        .filter((t) => !received.some((r) => r.auditor === t.auditor.name && r.target === t.target))
        .map((t) => `${t.auditor.name}@${t.target}`),
    ]

    // 構造検査と TBD の正規化は算術なので、改稿のたびに必ず再計算する（このスキルの契約）。
    const structResult = structuralFindings(documents)
    const { findings: tbdRenumbered, byKey: tbdByKey } = namespaceTbd(documents)
    for (const d of documents) d.tbd_items = tbdByKey[d.key] || []
    const { findings: catFindings } = reconcileCategories(documents, requiredCategories)
    structural = [...structResult.findings, ...catFindings, ...tbdRenumbered]
    structuralNotChecked = structResult.not_checked
    fixedFindings = []
    const fixedKeys = new Set(documents.filter((d) => d.fixed).map((d) => d.key))
    for (const f of structural) {
      if (fixedKeys.has(f.document)) fixedFindings.push(f)
      else allFailed.push(f)
    }

    const stillBlocking = contradictionPassTargets(allFailed).length
    log(
      stillBlocking
        ? `追加改稿後も blocking が ${stillBlocking} 件残っています。追加は 1 回きりなので、ここで打ち切って unresolved として返します。`
        : `追加改稿で blocking は解消しました（残指摘 ${allFailed.length} 件は degraded / 未再検査の観点分）。`
    )
  }
}

// ------------------------------------------- 監査 1 パスの再利用ヘルパ（escalation 再監査・終端網羅監査用）
//
// 主ループの発行規約（consistency は 2 文書未満で未実施 / traceability は requirements 無しで
// 未実施 / runWithRetry の部分リトライ）をそのまま踏襲する。byName（観点別サマリ）は
// 触らない — 実施した最後の全周監査の結果を保持する規約を、範囲限定パスで上書きしないため。
async function runAuditPass(label, auditorNames, scopeNote) {
  const auditable = documents.filter((d) => !d.fixed)
  const { deferred } = reconcileCategories(documents, requiredCategories)
  const tasks = []
  for (const auditor of AUDITORS.filter((a) => !auditorNames || auditorNames.has(a.name))) {
    // specimen は文書 kind ごとに 1 体。標本が無ければ skip（specimen_skipped として返す）。
    if (auditor.name === 'specimen') {
      if (specimenSkipped) continue
      for (const kind of ['requirements', 'specifications']) {
        const subset = auditable.filter((d) => d.kind === kind)
        if (subset.length) tasks.push({ auditor, target: `KIND:${kind}`, docs: subset })
      }
      continue
    }
    if (auditor.scope === 'all') {
      if (auditor.name === 'consistency' && auditable.length < 2) continue
      tasks.push({ auditor, target: 'ALL', docs: auditable })
      continue
    }
    if (auditor.name === 'traceability' && !documents.some((d) => d.kind === 'requirements')) continue
    const subset = auditor.scope === 'each' ? auditable : auditable.filter((d) => d.kind === auditor.scope)
    for (const d of subset) tasks.push({ auditor, target: d.key, docs: [d] })
  }
  const wrapped = await runWithRetry(
    label,
    tasks,
    (task, attempt) =>
      agent(buildAuditPrompt(task.auditor, task, deferred, scopeNote), {
        model: task.auditor.model,
        schema: AUDIT_SCHEMA,
        phase: 'Audit',
        label: `${task.auditor.name}-${task.target}-${label.replace(/\s+/g, '-')}${attempt > 1 ? `-retry${attempt - 1}` : ''}`,
      }).then((result) => ({ auditor: task.auditor.name, target: task.target, result: result || null })),
    (r) => r && r.result
  )
  const received = wrapped.filter(Boolean).filter((r) => r.result)
  const docKeys = new Set(documents.map((d) => d.key))
  const pathToKey = new Map(documents.map((d) => [d.path, d.key]))
  const findings = []
  for (const r of received) {
    for (const finding of r.result.failed || []) {
      let docKey = r.target
      if (r.target === 'ALL' || String(r.target).startsWith('KIND:')) {
        docKey = pathToKey.get(finding.document) || (docKeys.has(finding.document) ? finding.document : null)
      }
      findings.push({ auditor: r.auditor, ...finding, document: docKey, unroutable: !docKey })
    }
  }
  const passMissing = tasks
    .filter((t) => !received.some((r) => r.auditor === t.auditor.name && r.target === t.target))
    .map((t) => `${t.auditor.name}@${t.target}`)
  return { findings, missing: passMissing }
}

// ------------------------------------------- stuck 指摘の多角化 escalation（バッチ 1 回きり）
//
// 不動点検出で stuck になった指摘は、同じレンズ（同じ auditor 契約 × 同じ writer プロンプト）を
// 何度回しても digest が変わらないことが実証された指摘である。エラーで終わる前に 1 回だけ、
// 異なるレンズを明示した 3 本の agent に並列で解消案を出させ、writer にその一式を渡して最終改稿を
// 行う。escalation は指摘ごとではなくバッチで 1 回（stuck 全件をまとめて処理）。
// それでも同一 digest のまま残った指摘は unanswerable として verdict に明示する（黙らない）。

const ESCALATION_LENSES = [
  {
    name: 'intent',
    instruction:
      '要求の意図から見る。この指摘が守ろうとしている価値（誰の何が壊れるのか）に遡り、記述の形を変えてその価値を満たす案を出す。',
  },
  {
    name: 'implementer',
    instruction:
      '実装者の手順から見る。この文書だけを渡された実装者が実際に手を動かす順序を書き下し、その手順のどこで指摘が実害になるかから解消案を導く。実害にならないなら、その論証を proposal に書く。',
  },
  {
    name: 'counterexample',
    instruction:
      '反例の構成から見る。指摘が正しいとしたときに判定が割れる具体入力を構成し、その入力を境界にした記述への書き換え案を出す。構成できないなら「指摘が偽である」根拠として書く。',
  },
]

const ESCALATION_SCHEMA = {
  type: 'object',
  properties: {
    proposals: {
      type: 'array',
      items: {
        type: 'object',
        properties: { digest: { type: 'string' }, proposal: { type: 'string' } },
        required: ['digest', 'proposal'],
      },
    },
  },
  required: ['proposals'],
}

function buildEscalationPrompt(lens, stuckList) {
  const docKeys = new Set(stuckList.map((f) => f.document).filter(Boolean))
  const bodies = documents
    .filter((d) => docKeys.has(d.key))
    .map((d) => `## ${d.path}（key: ${d.key} / ${d.concern}）\n\n${bodyOf(d)}`)
    .join('\n\n---\n\n')
  return [
    'あなたは、改稿を繰り返しても解消しなかった監査指摘（stuck）の解消案を出す分析者である。',
    `今回のレンズ: ${lens.instruction}`,
    '他のレンズは別の agent が並列で担当している。このレンズ以外の観点からの提案はしない。',
    RULES,
    '',
    CONTEXT_BLOCK,
    '',
    '# [STUCK_FINDINGS] 解消案を出す対象（digest ごとに 1 案。digest は書き換えない）',
    JSON.stringify(
      stuckList.map(({ digest, auditor, document, location, quote, issue, fix, severity }) => ({
        digest, auditor, document, location, quote, issue, fix, severity,
      })),
      null,
      2
    ),
    '',
    '# [DOCUMENTS] 当該文書',
    bodies || '(本文なし)',
    '',
    'proposals に { digest, proposal } を返す。proposal は writer がそのまま実行できる粒度で書き、',
    '書き直し・統合・削除・TBD 起票のどれかを明示する。新しい要求の創作は解消案にならない。',
    '解消不能と判断した指摘には、その理由を proposal に書く。',
  ].join('\n')
}

let unanswerable = []
{
  // 矛盾解消パスで解消済みの stuck は外す（digest が allFailed に残っているものだけが対象）。
  const stillStuck = stuckFindings.filter((s) => allFailed.some((g) => findingDigest(g) === s.digest))
  if (stillStuck.length) {
    phase('Revise')
    log(
      `stuck 指摘 ${stillStuck.length} 件に対し、多角化 escalation をバッチで 1 回だけ行います` +
        '（3 レンズ並列 → writer 最終改稿 → スコープ再監査）。'
    )
    const lensResults = await runWithRetry(
      'Escalation lenses',
      ESCALATION_LENSES,
      (lens, attempt) =>
        agent(buildEscalationPrompt(lens, stillStuck), {
          model: 'opus',
          schema: ESCALATION_SCHEMA,
          phase: 'Revise',
          label: `escalate-${lens.name}${attempt > 1 ? `-retry${attempt - 1}` : ''}`,
        }).then((result) => ({ lens: lens.name, result: result || null })),
      (r) => r && r.result
    )
    const proposals = []
    for (const e of lensResults) {
      if (!e || !e.result) continue
      for (const p of e.result.proposals || []) proposals.push({ lens: e.lens, ...p })
    }
    revisions++
    const revisionId = `R${outerRound}.${revisions}`
    revisionLog.push({
      revision_id: revisionId,
      trigger: [...new Set(stillStuck.map((f) => f.id))].slice(0, 50),
      reason: `stuck 指摘 ${stillStuck.length} 件の多角化 escalation（バッチ 1 回きり）`,
      changed_by: '監査指摘の解消',
      escalation_pass: true,
    })
    const byDoc = new Map()
    for (const f of stillStuck) {
      if (!f.document) continue
      const attach = proposals.filter((p) => p.digest === f.digest)
      if (!byDoc.has(f.document)) byDoc.set(f.document, [])
      byDoc.get(f.document).push({
        ...f,
        escalation_proposals: attach.map((p) => `【レンズ: ${p.lens}】${p.proposal}`),
      })
    }
    await reviseDocuments(byDoc, revisionId, false)

    // 再監査は stuck を起票した観点だけ・当該範囲だけ（スコープ監査）。
    const names = new Set(stillStuck.map((f) => f.auditor).filter((n) => n && n !== 'structural'))
    log(
      'スコープ監査の対象範囲（escalation 再監査）: ' +
        [...new Set(stillStuck.map((f) => `${f.document}:${f.location || ''}`))].join(' / ')
    )
    const re = names.size
      ? await runAuditPass(`Audit escalation r${revisions}`, names, buildScopeNote(stillStuck))
      : { findings: [], missing: [] }
    missing = [...missing, ...re.missing]

    // 構造検査と TBD の正規化は算術なので、改稿のたびに必ず再計算する（このスキルの契約）。
    const structResult = structuralFindings(documents)
    const { findings: tbdRenumbered, byKey: tbdByKey } = namespaceTbd(documents)
    for (const d of documents) d.tbd_items = tbdByKey[d.key] || []
    const { findings: catFindings } = reconcileCategories(documents, requiredCategories)
    structural = [...structResult.findings, ...catFindings, ...tbdRenumbered]
    structuralNotChecked = structResult.not_checked
    const fixedKeys = new Set(documents.filter((d) => d.fixed).map((d) => d.key))
    fixedFindings = structural.filter((f) => fixedKeys.has(f.document))

    // 残指摘の組み直し: 旧 structural と stuck 分を落とし、再監査結果と新 structural を足す。
    const stuckDigests = new Set(stillStuck.map((f) => f.digest))
    allFailed = allFailed.filter(
      (f) => f.auditor !== 'structural' && !stuckDigests.has(findingDigest(f))
    )
    for (const f of re.findings) {
      allFailed.push(f)
      if (f.auditor === 'executability' && f.severity === 'blocking') execFindings.push(f)
      // escalation 後も digest 不変で残った指摘は unanswerable（従来の unresolved と区別する）
      if (stuckDigests.has(findingDigest(f))) unanswerable.push({ ...f, digest: findingDigest(f) })
    }
    for (const f of structural) if (!fixedKeys.has(f.document)) allFailed.push(f)
    log(
      unanswerable.length
        ? `escalation 後も ${unanswerable.length} 件が同一 digest のまま残りました。unanswerable として明示して終了します。`
        : 'escalation で stuck 指摘はすべて digest が変化しました（解消または再定式化）。'
    )
  }
}

// ------------------------------------------- 終端の網羅監査（1 回だけ）
//
// 改稿ループが収束（新規指摘 0 または全指摘 stuck 処理済み）した後に、全観点・全範囲で 1 回だけ
// 実行する。スコープ監査は当該範囲しか見ていないので、範囲外への波及はここで初めて検査される。
// 新規 blocking は従来どおりの経路（executability → TBD 起票）に乗せ、新規 non-blocking は
// 次の終端裁定に直接渡す（改稿ループへは戻さない — 戻すと汲み出しが再開する）。
{
  const skipTerminal = revisions >= auditRounds
  if (scopedAuditUsed && !backstopReached && !skipTerminal) {
    phase('Audit')
    log('網羅監査は終端 1 回: 全観点・全範囲の最終監査を実行します（改稿ループへは戻しません）。')
    const term = await runAuditPass('Audit terminal', null, '')
    missing = [...missing, ...term.missing]
    const known = new Set(allFailed.map((f) => findingDigest(f)))
    let added = 0
    for (const f of term.findings) {
      const dg = findingDigest(f)
      if (known.has(dg)) continue
      known.add(dg)
      added++
      allFailed.push(f)
      if (f.auditor === 'executability' && f.severity === 'blocking') execFindings.push(f)
    }
    log(`終端の網羅監査: 新規 ${added} 件。新規 blocking は TBD 起票へ、non-blocking は終端裁定へ渡します。`)
  } else if (scopedAuditUsed) {
    log(
      `終端の網羅監査は実施しません（${backstopReached ? 'revision backstop 到達' : `audit_rounds=${auditRounds} の縮退`}）。`
    )
  }
}

// ---------------------------------------------------------------- Finalize

phase('Finalize')

// ------------------------------------------- 終端裁定（adjudication）
//
// 終了時に残っている全指摘（unresolved + unanswerable）を、裁定 agent 1 本が三値に分類する。
// non-blocking 指摘の終端処理が無いと、修正も棄却も記録もされないまま unresolved[] に載って
// 終わる（未裁定 limbo）。documented 分は writer の最終転記改稿 1 回で文書へ反映する。
// unadjudicated が空であることを script が検証し、空でなければ verdict に反映して明示する。

const ADJUDICATION_SCHEMA = {
  type: 'object',
  properties: {
    fixed: {
      type: 'array',
      items: {
        type: 'object',
        properties: { digest: { type: 'string' }, evidence: { type: 'string' } },
        required: ['digest', 'evidence'],
      },
    },
    rejected: {
      type: 'array',
      items: {
        type: 'object',
        properties: { digest: { type: 'string' }, reason: { type: 'string' } },
        required: ['digest', 'reason'],
      },
    },
    documented: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          digest: { type: 'string' },
          target_document: { type: 'string' },
          target_section: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['digest', 'target_document', 'text'],
      },
    },
  },
  required: ['fixed', 'rejected', 'documented'],
}

function buildAdjudicationPrompt(remaining) {
  return [
    'あなたは終端裁定（adjudication）の裁定者である。改稿ループ終了時に残った監査指摘の全件を、',
    '次の三値のいずれかに分類する。未裁定のまま残す指摘があってはならない（全件をどれかに入れる）。',
    '',
    '- fixed: 実は既に解消済み・誤残留である。現在の本文を確認し、解消している根拠を evidence に書く。',
    '- rejected: 偽指摘である。reason 必須（理由の無い棄却は無効として未裁定に戻される）。',
    '- documented: 意図した制約である。文書の「検査範囲の限定」等の該当節へ転記すべき内容を text に、',
    '  転記先を target_document（文書キーまたはパス）と target_section に指定する。',
    '',
    RULES,
    '',
    CONTEXT_BLOCK,
    '',
    '# [REMAINING_FINDINGS] 裁定対象（digest で照合される。digest を書き換えない）',
    JSON.stringify(remaining, null, 2),
    '',
    '# [DOCUMENTS] 現在の文書',
    documents
      .map((d) => `## ${d.path}（key: ${d.key} / ${d.concern}）\n\n${bodyOf(d)}`)
      .join('\n\n---\n\n'),
  ].join('\n')
}

let adjudication = { fixed: [], rejected: [], documented: [], unadjudicated: [] }
{
  const seen = new Set()
  const remaining = []
  for (const f of [...allFailed, ...unanswerable]) {
    if (!f) continue
    const dg = f.digest || findingDigest(f)
    // needs_input へ起票済みの指摘は裁定に回さない（既に blocking TBD として人間ゲートへ向かう。
    // 終端の網羅監査が同じ指摘を再起票した場合もここで畳む）。
    if (needsInputByDigest.has(dg)) continue
    if (seen.has(dg)) continue
    seen.add(dg)
    remaining.push({ ...f, digest: dg })
  }
  if (remaining.length) {
    log(
      `終端裁定: 残指摘 ${remaining.length} 件（unresolved + unanswerable）を三値` +
        '（fixed / rejected / documented）に分類します。'
    )
    const adjRaw = await agent(buildAdjudicationPrompt(remaining), {
      model: 'opus',
      schema: ADJUDICATION_SCHEMA,
      phase: 'Finalize',
      label: 'adjudicator',
    })
    adjudication = validateAdjudication(adjRaw, remaining)

    if (adjudication.documented.length) {
      const docByKeyOrPath = new Map(documents.flatMap((d) => [[d.key, d], [d.path, d]]))
      const byDoc = new Map()
      for (const e of adjudication.documented) {
        const doc = docByKeyOrPath.get(e.target_document)
        if (!doc || doc.fixed) {
          // 転記先が特定できない裁定は成立しない — 未裁定へ戻して verdict に出す（黙らない）。
          adjudication.unadjudicated.push({
            digest: e.digest,
            auditor: 'adjudication',
            issue: `documented の転記先 ${e.target_document} が特定できない、または固定文書である`,
          })
          continue
        }
        if (!byDoc.has(doc.key)) byDoc.set(doc.key, [])
        byDoc.get(doc.key).push({
          auditor: 'adjudication',
          id: `ADJ-${e.digest}`,
          document: doc.key,
          location: e.target_section || '検査範囲の限定',
          issue: '終端裁定で「意図した制約（documented）」と分類された。該当節へ転記する。',
          fix: e.text,
        })
      }
      if (byDoc.size) {
        phase('Revise')
        revisions++
        const revisionId = `R${outerRound}.${revisions}`
        revisionLog.push({
          revision_id: revisionId,
          trigger: adjudication.documented.map((e) => `ADJ-${e.digest}`).slice(0, 50),
          reason: `終端裁定 documented ${adjudication.documented.length} 件の転記改稿（1 回きり）`,
          changed_by: '終端裁定の転記',
          adjudication_transfer: true,
        })
        await reviseDocuments(byDoc, revisionId, false)

        // 構造検査と TBD の正規化は算術なので、改稿のたびに必ず再計算する（このスキルの契約）。
        const structResult = structuralFindings(documents)
        const { findings: tbdRenumbered, byKey: tbdByKey } = namespaceTbd(documents)
        for (const d of documents) d.tbd_items = tbdByKey[d.key] || []
        const { findings: catFindings } = reconcileCategories(documents, requiredCategories)
        structural = [...structResult.findings, ...catFindings, ...tbdRenumbered]
        structuralNotChecked = structResult.not_checked
        const fixedKeys = new Set(documents.filter((d) => d.fixed).map((d) => d.key))
        fixedFindings = structural.filter((f) => fixedKeys.has(f.document))
        const knownDigests = new Set(allFailed.map((f) => findingDigest(f)))
        for (const f of structural) {
          if (fixedKeys.has(f.document)) continue
          if (knownDigests.has(findingDigest(f))) continue
          allFailed.push(f)
        }
      }
    }

    // 裁定で閉じた指摘（fixed / rejected / documented）は unresolved から外す。
    const closed = new Set(
      [...adjudication.fixed, ...adjudication.rejected, ...adjudication.documented].map((e) => e.digest)
    )
    allFailed = allFailed.filter((f) => !closed.has(f.digest || findingDigest(f)))
    unanswerable = unanswerable.filter((f) => !closed.has(f.digest || findingDigest(f)))
    if (adjudication.unadjudicated.length) {
      log(
        `終端裁定: ${adjudication.unadjudicated.length} 件が未裁定（unadjudicated）のまま残りました。` +
          'verdict に反映します。'
      )
    }
  }
}

// needs_input へ起票済みの指摘は残指摘（unresolved）から外す。TBD と unresolved の二重計上を
// 防ぐ（終端の網羅監査で同一 digest が再起票された分もここで畳む）。
if (needsInputByDigest.size) {
  allFailed = allFailed.filter((f) => !needsInputByDigest.has(f.digest || findingDigest(f)))
}
// needs_input の TBD 起票（スコープの梯子で premise / question に分類された指摘）。
const needsInputTbd = ladderToTbd([...needsInputByDigest.values()])
const needsInputKinds = [...new Set(needsInputTbd.map((t) => t.needs_input_kind))]

const execTbd = execToTbd(execFindings)
// 現ラウンドの申告を正として組み直す（前回分は owner/due などのメタデータ供給元）。
// 無条件マージにすると解決した TBD が消えず、「あと N 個」の N が永遠に減らない。
// spread して渡すのは、currentLists.flat() が 1 段しか平坦化しないため。
// [documents.map(...), execTbd] と書くと documents 側が配列の配列のまま残り、
// item.id が undefined になって**全件が黙って捨てられる**。捨てられた結果は
// tbd_items 0 件・blocking 0 件となり、「未提示の blocking が 0 件」という完成条件を
// 無条件に成立させる。ここは完成判定の唯一の供給元なので、形を崩さないこと。
const { current: tbdItems, resolved: resolvedTbdIds } = rebuildTbd(
  [...documents.map((d) => d.tbd_items), execTbd, needsInputTbd],
  inputTbdItems
)
const blockingTbd = tbdItems.filter((t) => t.blocking)

// unpresented_blocking: この設計の要。blocking かつ「まだ人間に提示していない」TBD。
// 「聞かれもせずに残った blocking」を完了時に必ず可視化するための唯一の算出地点であり、
// SKILL.md 側はこの配列の length を見るだけで、同じ式を再実装しない。
//
// 判定を ID だけで行うと偽陰性が出る。改稿で TBD-AUTH-003 が別の論点に振り直されると、
// 古い 003 を提示した記録が新しい論点に流用され、聞いていないのに「提示済み」になる。
// そこで内容の digest も併せて照合する（id が一致しても中身が変わっていれば未提示扱い）。
const unpresentedBlocking = blockingTbd.filter((t) => {
  const rec = presentedById.get(t.id)
  if (!rec) return true
  if (!rec.digest) return false // 旧形式（ID のみ）で渡された場合は従来どおり提示済みとみなす
  return rec.digest !== stableKey(String(t.text || ''))
})

const { deferred: categoriesDeferred } = reconcileCategories(documents, requiredCategories)

// INDEX は導出物なので、その kind の文書を実際に書いた（＝ fixed でない）ランでのみ組み立てる。
// 対象外の kind まで組み立てると、固定文書だけから作られた不完全な目次で既存 INDEX を
// 上書きすることになる。組み立てなければ SKILL.md は既存 INDEX をそのまま保持できる。
const index = {}
if (documents.some((d) => d.kind === 'requirements' && !d.fixed)) {
  index.requirements = buildIndex('requirements', documents, tbdItems, structural)
}
if (documents.some((d) => d.kind === 'specifications' && !d.fixed)) {
  index.specifications = buildIndex('specifications', documents, tbdItems, structural)
}

// verdict は「監査が欠けた」を「失格 0 件」より先に立てる。has_unresolved を併記するのは、
// audit_incomplete と unresolved_findings が排他だと、監査が欠けたうえに指摘も残っている
// 状態で後者が verdict から見えなくなるため。
// 優先順: 監査の欠測 > 裁定の欠測 > 回数 backstop > 回答不能（unanswerable）> 残指摘 > clean。
// unanswerable_findings は「escalation まで尽くしても digest 不変で残った」であり、従来の
// unresolved_findings（単に残った）と区別して黙らずに終える。
const verdict = missing.length
  ? 'audit_incomplete'
  : adjudication.unadjudicated.length
  ? 'adjudication_incomplete'
  : backstopReached
  ? 'revision_backstop_reached'
  : unanswerable.length
  ? 'unanswerable_findings'
  : allFailed.length
  ? 'unresolved_findings'
  : 'clean'

// 件数は null と 0 を区別する。null は「その観点が 1 件も検査されていない」、0 は「検査して指摘なし」。
const countOf = (name) => (byName[name] && byName[name].received ? byName[name].failed.length : null)

// needs_input: 人間からしか得られない入力を待つ項目の集約。kind は data（入力・前提の根拠が
// 無い）/ decision（依頼者にしか決められない）/ mixed（両方）/ null（なし）。
const needsInput = {
  kind: needsInputKinds.length === 1 ? needsInputKinds[0] : needsInputKinds.length ? 'mixed' : null,
  items: needsInputTbd,
}

// next_args: needs_input または未提示 blocking を残して終わるとき、次周回にそのまま渡せる
// 完全な args を組み立てて返す。司令塔は tbd_answers の "<<ANSWER_HERE>>" を回答で置換する
// だけでよい（args の手組みは転記ミスの温床。実測 30〜70KB）。presented_tbd_ids には
// 今周回の blocking 全件を digest 込みで先積みする — SKILL.md はゲートで全 blocking を
// 提示し切る規約なので、次周回の入力としてはこれが提示後の状態に一致する。
const nextPresented = (() => {
  const m = new Map(presentedById)
  for (const t of blockingTbd) m.set(t.id, { id: t.id, digest: stableKey(String(t.text || '')) })
  return [...m.values()]
})()
const nextArgs = buildNextArgs({
  outer_round: outerRound,
  max_outer_rounds: MAX_OUTER_ROUNDS,
  has_needs_input: needsInputTbd.length > 0,
  has_unpresented_blocking: unpresentedBlocking.length > 0,
  skillDir: SKILL_DIR,
  mode,
  input,
  answers,
  decisions,
  tbd_answers_history: [
    ...tbdAnswersHistory,
    ...(tbdAnswers ? [{ round: outerRound, answers: tbdAnswers }] : []),
  ],
  documents,
  tbd_items: tbdItems,
  presented_tbd_ids: nextPresented,
  domain_findings: domainFindings,
  required_categories: requiredCategories,
  self_containment: selfContainment,
  paths,
  today,
  specimen_paths_arg: parsedArgs.specimen_paths || [],
})

return {
  status: 'OK',
  verdict,
  mode,
  outer_round: outerRound,
  // tbd_answers_history: 全周回のゲート②回答の累積。次周回の args にそのまま渡す。
  // これを渡し忘れると過去回答を根拠にした要求が fabrication の偽陽性になる。
  tbd_answers_history: [
    ...tbdAnswersHistory,
    ...(tbdAnswers ? [{ round: outerRound, answers: tbdAnswers }] : []),
  ],
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
    traceability: d.traceability,
    tbd_items: d.tbd_items,
    categories_deferred: d.categories_deferred,
    fixed: d.fixed,
  })),
  index,
  index_paths: {
    requirements: `${reqDir}/INDEX.md`,
    specifications: `${specDir}/INDEX.md`,
  },
  tbd_items: tbdItems,
  // digest は script が計算して付ける。司令塔に text からの導出をさせると、
  // 照合側（stableKey）と別の値（生 text など）が積まれ、提示済みが全件「未提示」に化ける。
  blocking_tbd_items: blockingTbd.map((t) => ({ ...t, digest: stableKey(String(t.text || '')) })),
  unpresented_blocking: unpresentedBlocking.map((t) => ({
    ...t,
    digest: stableKey(String(t.text || '')),
  })),
  // 入力の {id, digest} をそのまま返す（ID 文字列に劣化させない）。劣化形を「そのまま渡す」
  // 規約で次周回に渡すと digest 欠落で全件が旧形式扱いになり、ID 振り直しの検出が黙って死ぬ。
  presented_tbd_ids: [...presentedById.values()],
  // resolved_tbd_ids: 前ラウンドにあって今回消えた TBD。人間ゲート③が「解決 N 件 / 残 M 件」を
  // 出せるようにする。これが無いと、減っていることが利用者に見えない。
  resolved_tbd_ids: resolvedTbdIds,
  audit: byName,
  // specimen_skipped: 標本が 1 件も無く specimen 監査を実施しなかった（欠測 missing とは
  // 別物 — 欠測は失敗であり再実行で埋めるが、標本の不在は環境の事実である）。
  specimen_skipped: specimenSkipped,
  // specimen_self_only: 標本が自己出自文書のみ（多様性不足の申告。skip はしていない）。
  specimen_self_only: specimenSelfOnly,
  specimen_paths: specimenPaths,
  missing_auditors: missing,
  audit_incomplete: missing.length > 0,
  writer_missing: writerMissing,
  structural_findings: structural,
  // structural_not_checked: 材料が無くて実行できなかった検査。「0 件」と混同させない。
  structural_not_checked: structuralNotChecked,
  // fixed_findings: このランの対象外の文書への指摘。改稿には回していない。
  fixed_findings: fixedFindings,
  unresolved: allFailed,
  has_unresolved: allFailed.length > 0,
  // unanswerable: 多角化 escalation 後も同一 digest のまま残った指摘（回答不能）。
  unanswerable,
  // adjudication: 終端裁定の三値分類。unadjudicated が空であることを script が検証済みで、
  // 空でなければ verdict = 'adjudication_incomplete' に反映されている。
  adjudication,
  unroutable_findings: allFailed.filter((f) => f.unroutable),
  categories_deferred: categoriesDeferred,
  // dry_stop: 乾き停止（novelty 0 のラウンドで改稿ループを抜けた）。novelty_history は
  // 各監査ラウンドの新規指摘件数の並び。backstop 到達との区別は verdict / dry_stop で読む。
  dry_stop: dryStop,
  novelty_history: noveltyHistory,
  // needs_input: 人間からしか得られない入力を待つ項目（premise → data / question → decision）。
  // items は blocking TBD（TBD-NI-）として tbd_items / unpresented_blocking にも載っている。
  needs_input: needsInput,
  // next_args: 次周回にそのまま渡せる args。tbd_answers の "<<ANSWER_HERE>>" を回答で置換して
  // Workflow を呼ぶ（手組みしない）。継続が不要・不能（周回上限）なら null。
  next_args: nextArgs,
  revisions_used: revisions,
  revision_log: revisionLog,
  summary: {
    document_count: documents.length,
    executability_findings: countOf('executability'),
    clarity_findings: countOf('clarity'),
    traceability_findings: countOf('traceability'),
    coverage_findings: countOf('coverage'),
    fabrication_findings: countOf('fabrication'),
    consistency_findings: countOf('consistency'),
    validity_findings: countOf('validity'),
    // specimen: null は「未検査」、数値は「検査して N 件」。標本が無かったランは
    // specimen_skipped: true で null になる（欠測 missing とは区別される）。
    specimen_findings: countOf('specimen'),
    specimen_skipped: specimenSkipped,
    duplicate_ids: structural.filter((f) => f.id.startsWith('ST-DUP')).length,
    orphan_ids: structural.filter((f) => f.id.startsWith('ST-ORPHAN') || f.id.startsWith('ST-DANGLING')).length,
    undeclared_ids: structural.filter((f) => f.id.startsWith('ST-UNDECLARED') || f.id.startsWith('ST-PHANTOM')).length,
    obsolete_terms: structural.filter((f) => f.id.startsWith('ST-OBSOLETE')).length,
    unverified_citations: structural.filter((f) => f.id.startsWith('ST-UNVERIFIED')).length,
    tbd_count: tbdItems.length,
    blocking_tbd_count: blockingTbd.length,
    unpresented_blocking_count: unpresentedBlocking.length,
    deferred_categories_count: categoriesDeferred.length,
    revision_backstop: REVISION_BACKSTOP,
    stuck_threshold: STUCK_THRESHOLD,
    unanswerable_count: unanswerable.length,
    adjudicated: {
      fixed: adjudication.fixed.length,
      rejected: adjudication.rejected.length,
      documented: adjudication.documented.length,
      unadjudicated: adjudication.unadjudicated.length,
    },
  },
}
