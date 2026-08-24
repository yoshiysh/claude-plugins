export const meta = {
  name: 'search-investigate',
  description:
    '一次情報検証つき調査ループ（claim 抽出 → claim ごと並列検証 → 合成、進捗ガード付き until-converged）',
  phases: [{ title: 'Extract' }, { title: 'Verify' }, { title: 'Synthesize' }],
  codex_workflow_compatibility: {
    schema_version: 'claude-workflow-model-portability/v1',
    classification: 'portable_v1',
    model_identity_semantics: 'non_load_bearing_scheduling_hint',
    codex_translation: 'drop_declared_model_hint_preserve_role_and_result_contract',
    quality_parity: 'not_guaranteed',
    model_hints: {
      claim_extractor: { requested_model: 'sonnet', role: 'extract bounded factual claims' },
      source_verifier: { requested_model: 'sonnet', role: 'verify one pre-enumerated claim slot' },
      root_cause_synthesizer: { requested_model: 'opus', role: 'synthesize only validated verdict inputs' },
    },
  },
}

function modelHint(callsite) {
  const hint = meta.codex_workflow_compatibility.model_hints[callsite]
  if (!hint) throw new Error(`undeclared model hint callsite: ${callsite}`)
  return hint.requested_model
}

// DEFAULT_MAX_ROUNDS: 1 ラウンドで extractor 1 回 + claim 数分の verifier + synthesizer 1 回を
// 消費する。5 ラウンドあれば「検証 → 新たな問い → 再検証」が 4 回連鎖する調査までカバーでき、
// 暴走時には打ち切れる。voodoo constant であることを認める初期値であり、実績（収束までの
// 平均ラウンド数）を見て調整する対象。args.maxRounds はこの上限内だけ変更できる。
const DEFAULT_MAX_ROUNDS = 5
const HARD_MAX_ROUNDS = 5
const MAX_CLAIMS_PER_ROUND = 12

// PRIORITY_ORDER: claim を spawn する順序。parallel() は同時実行数を harness 側の上限で
// 絞るため、load-bearing な主張（high）を先に並べることで、打ち切り時に検証済みで残る
// claim が本筋を支えるものになる。SKILL.md の「priority 順に上位を先に verify」を
// 並び替えとして構造化したもの。
const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 }

const CLAIMS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    claims: {
      type: 'array',
      maxItems: MAX_CLAIMS_PER_ROUND,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 96 },
          text: { type: 'string' },
          kind: { type: 'string', enum: ['fact', 'inference'] },
          verify_method: {
            type: 'string',
            enum: [
              'live-api',
              'file-read',
              'web-search',
              'web-fetch',
              'not-verifiable-by-nature',
            ],
          },
          priority: { type: 'string', enum: ['high', 'medium', 'low'] },
          hedge: { type: 'boolean' },
          based_on: { type: 'array', items: { type: 'string' } },
        },
        required: ['id', 'text', 'kind', 'verify_method', 'priority', 'hedge'],
      },
    },
    note: { type: 'string' },
  },
  required: ['claims'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    verdict: { type: 'string', enum: ['verified', 'refuted', 'cannot-verify'] },
    evidence_ref: { type: 'string' },
    evidence_file: { type: 'string' },
    source_completeness: { type: 'string', enum: ['complete', 'partial', 'unavailable'] },
    as_of: { type: 'string' },
    independence: { type: 'string', enum: ['original', 'reposted', 'unknown'] },
    note: { type: 'string' },
  },
  required: ['id', 'verdict', 'evidence_ref', 'evidence_file', 'source_completeness', 'note'],
}

const SYNTH_SCHEMA = {
  type: 'object',
  properties: {
    root_cause: { type: ['string', 'null'] },
    disconfirmation_attempted: { type: 'boolean' },
    contradictions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          between: { type: 'array', items: { type: 'string' } },
          description: { type: 'string' },
        },
        required: ['between', 'description'],
      },
    },
    scope_assumption: { type: 'string' },
    next_question: { type: ['string', 'null'] },
    // same_question_as_previous: 進捗ガードの条件(b)「next_question が前ラウンドと実質同一か」の
    // 判定。「実質同一」は言い換えを含む意味判断なので script 側で文字列比較しない（代理指標に
    // なり、言い換えただけの同一問いが素通りして収束しなくなる）。判断は agent、分岐は script。
    same_question_as_previous: { type: 'boolean' },
    report: {
      type: 'object',
      properties: {
        verified_facts: { type: 'array' },
        unverified_or_inconclusive: { type: 'array' },
        root_cause: { type: ['string', 'null'] },
        inferences: { type: 'array' },
      },
      required: ['verified_facts', 'unverified_or_inconclusive', 'root_cause', 'inferences'],
    },
  },
  required: ['disconfirmation_attempted', 'next_question', 'same_question_as_previous', 'report'],
}

function buildExtractPrompt(question, draft, nextQuestion, verifiedTexts) {
  return [
    `Read ${SKILL_DIR}/agents/claim-extractor.md for your full role instructions before doing anything else.`,
    `契約は ${SKILL_DIR}/schemas/agent-contracts.md §claim-extractor を正とする。`,
    '',
    '# [QUESTION] 元の調査依頼',
    question,
    '',
    '# [DRAFT] 現時点のドラフト回答',
    draft || '(初回ラウンド。ドラフトなし)',
    '',
    '# [NEXT_QUESTION] 前ラウンドで立った追加検証の問い',
    nextQuestion || '(なし)',
    '',
    '# 既に検証済みの主張（再抽出しても再検証されないため、新規の主張に注力すること）',
    verifiedTexts.length ? verifiedTexts.map((t) => `- ${t}`).join('\n') : '(なし)',
  ].join('\n')
}

function buildVerifyPrompt(claim, evidenceFile) {
  return [
    `Read ${SKILL_DIR}/agents/source-verifier.md for your full role instructions before doing anything else.`,
    `契約は ${SKILL_DIR}/schemas/agent-contracts.md §source-verifier を正とする。`,
    '',
    '# 検証対象の主張（1 件）',
    JSON.stringify({ id: claim.id, text: claim.text, verify_method: claim.verify_method }, null, 2),
    '',
    '# 収集材料の書き出し先（evidence_file）',
    evidenceFile,
    '取得した生の情報（ログ全文・WebFetch 結果・コード断片等）は Write ツールで上記パスに' +
      'そのまま書き出すこと。verdict の `note` には要約のみを残し、詳細はこのファイルに置く' +
      '（後段の synthesizer には note しか渡らないため、判定に不要な detail をここに逃がす）。',
    '',
    '出力の `id` は上記の id をそのまま返すこと（後段の突合キー）。',
    '出力の `evidence_file` には上記パスをそのまま返すこと。',
  ].join('\n')
}

function buildSynthPrompt(question, verdicts, previousQuestion) {
  return [
    `Read ${SKILL_DIR}/agents/root-cause-synthesizer.md for your full role instructions before doing anything else.`,
    `契約は ${SKILL_DIR}/schemas/agent-contracts.md §root-cause-synthesizer と §final-report を正とする。`,
    '',
    '# [QUESTION] 元の調査依頼',
    question,
    '',
    '# 累積 verdicts（これまでの全ラウンドの検証結果）',
    JSON.stringify(verdicts, null, 2),
    '',
    '# 前ラウンドの next_question',
    previousQuestion || '(なし。初回ラウンド)',
    '',
    '# same_question_as_previous の判定',
    'あなたが今回立てる next_question が、上記「前ラウンドの next_question」と実質的に同じ問い' +
      '（言い回しが違っても検証対象と論点が同一）なら true、異なる問いなら false を返すこと。' +
      '前ラウンドが無い場合、または next_question が null の場合は false。',
  ].join('\n')
}

// args はツール呼び出し側が JSON オブジェクトとして渡しても、この harness では文字列
// （JSON テキストそのまま）で届くことが dispatch/scripts/orchestrate.js の実測で確認されている。
// 同じ harness を使うため同じ防御を敷く。
const parsedArgs = (typeof args === 'string' ? JSON.parse(args) : args) || {}

// スキルの実ディレクトリ。workflow スクリプトは自身の位置を解決できないので
// 呼び出し側（SKILL.md）が渡す。agent 定義・契約の Read パス組み立てに使う。
const SKILL_DIR = parsedArgs.skillDir
if (!SKILL_DIR) {
  throw new Error('args.skillDir が未指定です。SKILL.md の Workflow 呼び出し例に従ってください。')
}

const question = parsedArgs.question
if (!question || typeof question !== 'string' || !question.trim()) {
  throw new Error('args.question が空です。調査依頼の本文を args.question に渡してください。')
}

// workspaceDir: source-verifier が生の収集材料（ログ全文・WebFetch 結果等）を書き出す先。
// 対象プロジェクトのツリーの外（呼び出し元スキルがユーザーの gitignore 管理外に確保した
// 固定ロケーション）を SKILL.md が生成して渡す。script は自身で日時/乱数を生成できない
// （resume 時に再現性が崩れるため禁止）ので、ここでもパスを組み立てず素通しする。
const workspaceDir = parsedArgs.workspaceDir
if (!workspaceDir) {
  throw new Error('args.workspaceDir が未指定です。SKILL.md の Workflow 呼び出し例に従ってください。')
}

const maxRounds = parsedArgs.maxRounds ?? DEFAULT_MAX_ROUNDS
if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > HARD_MAX_ROUNDS) {
  throw new Error(`args.maxRounds は 1..${HARD_MAX_ROUNDS} の整数で指定してください。`)
}

// claimKey: 同一主張の再検証を防ぐ突合キー。extractor は毎ラウンド id を振り直すため
// id では突合できない。空白の正規化のみに留め、それ以外は完全一致でしか同一と見なさない
// （緩い類似判定にすると別主張を「検証済み」と誤認して検証を飛ばす。取りこぼしは
// 再検証の無駄で済むが、誤同一視は未検証の主張がレポートに載る = 契約違反になる）。
const claimKey = (text) => String(text).replace(/\s+/g, ' ').trim()

const verdicts = []
const seen = new Set()
const rounds = []
let round = 0
let previousQuestion = null
let draft = ''
// terminationReason は「ループを抜けた理由」であり、既定値を持たせない。converged を
// 初期値にすると 1 ラウンドも回らずに抜けたケースが「収束」と報告される（達成度を実態より
// 良く見せる方向の誤り）。break したときだけ設定し、それ以外はループ後に解決する。
let terminationReason = null

while (round < maxRounds) {
  round++
  const roundLabel = `r${round}`

  phase('Extract')
  const extracted = await agent(
    buildExtractPrompt(question, draft, previousQuestion, verdicts.map((v) => v.text)),
    {
      model: modelHint('claim_extractor'),
      schema: CLAIMS_SCHEMA,
      phase: 'Extract',
      label: `extract-${roundLabel}`,
    }
  )

  // 未検証の claim だけを対象にする。既出の主張は verdicts に既に載っているため
  // 再 spawn しない（ラウンドを跨いだ重複検証の抑止）。
  const fresh = (extracted?.claims || []).filter((c) => c && c.text && !seen.has(claimKey(c.text)))
  fresh.sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 3) - (PRIORITY_ORDER[b.priority] ?? 3))
  fresh.forEach((c) => seen.add(claimKey(c.text)))

  phase('Verify')
  // 全 fresh claim に verifier を 1 件ずつ spawn する。ここが構造的保証の中核 ——
  // claims[] を走査して verifier を立てるのは script なので、「検証されないまま
  // レポートに混入する主張」は原理的に存在しえない。散文で禁止する必要がない。
  const verifiedSlots = await parallel(
      fresh.map((claim, claimIndex) => () => {
        // agent が生成した claim.id を path や runtime label に使わない。round/slot は
        // hard max から事前列挙できるため、Codex 互換層でも bounded graph に変換できる。
        const evidenceFile = `${workspaceDir}/evidence/round-${round}/slot-${claimIndex}.md`
        return agent(buildVerifyPrompt(claim, evidenceFile), {
          model: modelHint('source_verifier'),
          schema: VERDICT_SCHEMA,
          phase: 'Verify',
          label: `verify-${roundLabel}-slot-${claimIndex}`,
        }).then((verdict) => ({ claim, evidenceFile, verdict }))
      })
    )
  const newVerdicts = verifiedSlots
    .filter(({ verdict }) => verdict)
    .map(({ claim, evidenceFile, verdict }) => ({
      ...verdict,
      id: claim.id,
      text: claim.text,
      kind: claim.kind,
      based_on: claim.based_on,
      hedge: claim.hedge,
      evidence_file: evidenceFile,
    }))

  // agent が落ちた（null が返った）claim は verdict を得られていない。捏造せず
  // cannot-verify として明示的に積む（レポートの unverified_or_inconclusive に載る）。
  const dropped = verifiedSlots
    .filter(({ verdict }) => !verdict)
    .map(({ claim: c }) => ({
      id: c.id,
      text: c.text,
      kind: c.kind,
      based_on: c.based_on,
      hedge: c.hedge,
      verdict: 'cannot-verify',
      evidence_ref: '(検証 agent が結果を返さなかった)',
      evidence_file: null,
      source_completeness: 'unavailable',
      note: 'source-verifier の呼び出しが失敗したため未検証。推測で埋めていない。',
    }))

  const roundVerdicts = [...newVerdicts, ...dropped]
  verdicts.push(...roundVerdicts)

  phase('Synthesize')
  const synth = await agent(buildSynthPrompt(question, verdicts, previousQuestion), {
    model: modelHint('root_cause_synthesizer'),
    schema: SYNTH_SCHEMA,
    phase: 'Synthesize',
    label: `synthesize-${roundLabel}`,
  })

  const newlyVerified = roundVerdicts.filter((v) => v.verdict === 'verified').length
  log(
    `Round ${round}: claim ${roundVerdicts.length} 件検証（verified ${newlyVerified}）/ 累計 ${verdicts.length} 件`
  )
  rounds.push({
    round,
    claims_verified: roundVerdicts.length,
    newly_verified: newlyVerified,
    next_question: synth?.next_question || null,
    contradictions: synth?.contradictions || [],
    report: synth?.report || null,
  })

  draft = JSON.stringify(synth?.report || {}, null, 2)

  // 収束判定。next_question が無ければ synthesizer が確定版を返している。
  if (!synth?.next_question) {
    terminationReason = 'converged'
    break
  }

  // 進捗ガード: (a) 新たに verified になった claim が 0 件、かつ (b) next_question が
  // 前ラウンドと実質同一（判定は synthesizer が返す）なら、同じ問いを検証し直す
  // reactive loop に入っているので早期に打ち切る。
  if (newlyVerified === 0 && synth.same_question_as_previous) {
    terminationReason = 'stalled'
    break
  }

  previousQuestion = synth.next_question
}

// break しなかった場合は hard max に到達している。
if (!terminationReason) {
  terminationReason = 'max_rounds'
}

const finalRound = rounds[rounds.length - 1]

return {
  question,
  rounds_run: round,
  termination_reason: terminationReason,
  report: finalRound?.report || null,
  verdicts,
  rounds,
}
