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

// ロールと責務の対応（誰が生成し、誰が検証するか）は schemas/role-map.md を正とする。
// 検証者（auditor / judge 系）は判定と事実指摘のみを返し、文案の起草は生成側
// （writer / resolver）が担う — 1 role = 1 責務。
//
// 停止条件は「乾き停止（novelty 0）+ 不動点検出」が主で、回数は backstop に格下げした
// （実測: 固定上限 2 回は「進んでいるのに切る」を起こし、non-blocking 指摘は改稿しても
// 総数がほぼ減らなかった — 生成量 ≈ 消化量。回数で切っても直る見込みとは無関係だから。
// さらに run9/10 では不動点検出が一度も発火せず毎回 backstop 到達で止まったため、
// 「新規指摘が尽きた」を script が novelty として算出する乾き停止を主条件に据えた）。
//
// STUCK_THRESHOLD: ある指摘が「改稿を経ても同一 digest のまま残る」ことがこの回数連続したら
// stuck（回答不能候補）とマークし、通常の改稿ループから外して resolver → resolver-verifier のバッチ処理（1 回きり）へ回す。
const STUCK_THRESHOLD = 2
// REVISION_BACKSTOP: 総改稿回数の予算。run7 の実測で、不動点検出は「毎回新しい指摘が湧く」
// 通常ケースでは一度も発火せず（同一 digest の再来ではなく新表面の露出が支配的）、backstop 8 まで
// 走って 5.86M トークンを消費した。ループを実際に閉じたのは改稿ではなく終端裁定だったため、
// 改稿は少数回で切り上げ、残る指摘は終端裁定（rejected / documented）へ流す設計に改めた。
// 到達したら verdict に 'revision_backstop_reached' を立てて明示的に終わる。
const REVISION_BACKSTOP = 3

// GATE_CAPACITY_PER_ROUND / MAX_GATE_ROUNDS: 人間ゲートの提示容量。**正は
// scripts/check_blocking_rate.py の同名定数**であり、ここはその写しである（workflow script は
// import を書けず、Python との間で値を共有できない）。両者の一致は
// tests/test_function_parity.py が機械で検査する。容量を超えた blocking は
// 「未提示のまま完了」に直結するため、返り値の blocking_over_capacity で申告する
// （司令塔に別のスクリプトを走らせる判断を委ねない — 走らせなければ超過に気づけない）。
const GATE_CAPACITY_PER_ROUND = 20
const MAX_GATE_ROUNDS = 2

// AUDITORS の scope: 'each' = 全文書に 1 体ずつ / 'requirements' | 'specifications' = その種別だけ /
// 'all' = 全文書をまとめて 1 体。consistency だけが 'all' なのは、重複・矛盾・INDEX との齟齬は
// 単一文書の中では原理的に見えないため（本文は locate 読みで安いモデルに探させる）。
// validity と specimen は文書ごとに 1 体にしている。1 体に全文書を持たせると、固定文書まで含めた
// 全文を読み込んだ文脈が毎ターン読み直され、1 体で数十万トークンの文脈に達する（実測: validity 1 体が
// 文脈 80 万・キャッシュ読み 1,660 万トークン）。文書間の突き合わせは、他文書の見出し索引を渡して
// 必要な節だけを読ませることで残す。
// model / effort は既定値であり、args.role_opts で run ごとに上書きできる（実測で較正する前提）。
// 省略するとセッションの設定（xhigh 等）を継承し、照合だけの観点まで最重量で走る（実測: 9 文書の
// 1 run で 349 呼び出しが利用上限に 2 回達した）。
// - 照合・列挙の観点は sonnet / medium
// - 判断を要する観点は opus / medium。公式の指針（platform docs「optimizing for cost and
//   intelligence」）では知識作業で medium は high と同等の結果を出し、出力トークンは入力の 5 倍の
//   単価で agent のループの中で積み上がる
// - executability と fabrication だけ opus / high に残す。1 文ずつ「着手できるか」「根拠が原本に
//   あるか」を見る観点で、見落としがそのまま成果物の欠陥（着手不能・捏造）になり、代償が大きい
// read: 全範囲監査での本文の読み方。'locate' は安いモデル（shunt の bulk-read）に候補箇所の逐語引用
// だけを選ばせ、監査役はその箇所と抜き取り範囲を原文で読んで判定する。'full' は監査役が全文を区切り読みする。
// locate にするのは、判定に要る箇所が文書のごく一部に集まる観点（consistency: 定義・数値・順序の
// 突き合わせ / coverage: カテゴリと章の実在）だけ。全文の一文ずつを見る観点（clarity・executability・
// fabrication・validity・specimen）と、script 側の ID 照合に乗る traceability は full のまま。
const AUDITORS = [
  { name: 'executability', file: 'executability-auditor.md', model: 'opus', effort: 'high', scope: 'each', read: 'full' },
  { name: 'clarity', file: 'clarity-auditor.md', model: 'sonnet', effort: 'medium', scope: 'each', read: 'full' },
  { name: 'traceability', file: 'traceability-auditor.md', model: 'sonnet', effort: 'medium', scope: 'specifications', read: 'full' },
  { name: 'coverage', file: 'coverage-auditor.md', model: 'sonnet', effort: 'medium', scope: 'requirements', read: 'locate' },
  { name: 'fabrication', file: 'fabrication-auditor.md', model: 'opus', effort: 'high', scope: 'each', read: 'full' },
  { name: 'consistency', file: 'consistency-auditor.md', model: 'sonnet', effort: 'medium', scope: 'all', read: 'locate' },
  // validity: 内容の妥当性（筋・矛盾・欠落）。書式・規律の監査を全通過した筋の悪い要求を
  // 止める最後の観点。事後レビュー頼みだと実施されないことが実測されたため観点に組み込んだ。
  { name: 'validity', file: 'validity-auditor.md', model: 'opus', effort: 'medium', scope: 'each', read: 'full' },
  // specimen: 標本適用監査。生成文書の各項目を実在の標本文書に実際に適用し、判定不能・
  // 適用時矛盾を検出する。内部監査が見逃す共通原因「文書を読むだけで、使ってみない」を
  // 塞ぐために導入された（実測: 全監査通過後の独立レビューが判定不能 4 件を検出した）。
  // コスト抑制のため毎改稿のスコープ監査には参加せず、初回監査と終端の網羅監査だけ参加する。
  { name: 'specimen', file: 'specimen-auditor.md', model: 'opus', effort: 'medium', scope: 'each', read: 'full' },
]

// ROLE_OPTS: auditor 以外の role の model / effort の既定値（args.role_opts で上書きできる）。
// 配分を 1 箇所で変えられるよう、agent() は必ずここか AUDITORS から opts を取る。判断を要する係も
// medium に置く理由は AUDITORS の注記と同じ（writer は判断より転記が主）。
const ROLE_OPTS = {
  writer: { model: 'opus', effort: 'medium' },
  ladderJudge: { model: 'sonnet', effort: 'medium' },
  resolver: { model: 'opus', effort: 'medium' },
  resolverVerifier: { model: 'opus', effort: 'medium' },
  adjudicator: { model: 'opus', effort: 'medium' },
  precedentJudge: { model: 'opus', effort: 'medium' },
  measurement: { model: 'opus', effort: 'medium' },
  // checker: 与えた JSON をファイルに書き doc_check.mjs を実行して出力を返すだけの係。判断をしない。
  checker: { model: 'sonnet', effort: 'low' },
}

// 本文を読む検査（禁止語・ID 抽出・語尾など）の定数と関数は scripts/doc_check.mjs が正本である。
// Workflow script はファイルを読めないので、checker agent にその CLI を実行させて結果を受け取る
// （runDocChecks）。


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

// TRACE_ITEM: 項目 ID → 根拠原本の対応。納品文書の本文には根拠句を書かない規約に変えたため、
// 「この記述はどこから来たか」はここにしか残らない。返り値では audit_trail として集約され、
// fabrication 監査と traceability 監査の照合対象になる。本文から根拠句を消しただけで
// trace を作らないと、捏造検査の入力そのものが消え、指摘 0 件が「健全」に化ける。
// FLOW_REF_ITEM: 項目 ID → 工程の流れ（flow）の要素 ID。根拠（trace）とは別に持つ — flow は根拠原本ではなく、
// trace に混ぜると根拠の検査（NO_EVIDENCE・捏造監査）が flow への当てはめを根拠と数える。
const FLOW_REF_ITEM = {
  type: 'object',
  properties: { item_id: { type: 'string' }, ref: { type: 'string' } },
  required: ['item_id', 'ref'],
}

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
    // 本文（markdown）は返させない。writer は改稿稿のファイルを Edit し、script は本文を受け取らない
    // （返させると文書全体を Write と返り値で 2 度出力させることになる）。
    // line_count: [WRITE_BACK] のファイルに対する `wc -l` の値。required にしない — 欠落で応答
    // ごと失わず、欠落は書き出し未確認として script が扱う（reportedLineCount）。
    line_count: { type: 'number' },
    summary: { type: 'string' },
    requirement_items: { type: 'array', items: ID_ITEM },
    trace: { type: 'array', items: TRACE_ITEM },
    flow_refs: { type: 'array', items: FLOW_REF_ITEM },
    tbd_items: { type: 'array', items: TBD_ITEM },
    categories_deferred: { type: 'array', items: { type: 'string' } },
    referenced_ids: { type: 'array', items: { type: 'string' } },
    // vacant_ids: この文書の欠番 ID（採番済みだが項目が存在しない ID）。表記規約が欠番の列挙を
    // 要求するため、本文に現れるが items にも referenced_ids にも属さない。申告が無いと
    // 構造検査が申告漏れとして毎 run 再検出する（#53）。
    vacant_ids: { type: 'array', items: { type: 'string' } },
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
  required: ['summary', 'requirement_items', 'trace', 'tbd_items'],
}

const SPEC_DOC_SCHEMA = {
  type: 'object',
  properties: {
    // 本文（markdown）は返させない。writer は改稿稿のファイルを Edit し、script は本文を受け取らない
    // （返させると文書全体を Write と返り値で 2 度出力させることになる）。
    // line_count: [WRITE_BACK] のファイルに対する `wc -l` の値。required にしない — 欠落で応答
    // ごと失わず、欠落は書き出し未確認として script が扱う（reportedLineCount）。
    line_count: { type: 'number' },
    summary: { type: 'string' },
    spec_items: { type: 'array', items: ID_ITEM },
    trace: { type: 'array', items: TRACE_ITEM },
    flow_refs: { type: 'array', items: FLOW_REF_ITEM },
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
  required: ['summary', 'spec_items', 'trace', 'traceability', 'tbd_items'],
}

// AUDIT_SCHEMA: 6 auditor 共通。判定は failed[] の件数で受け取る（markdown 中の ❌ を数えない）。
// checked を必須にしているのは、何も見ずに failed: [] を返す経路を残さないため。
// severity は executability と validity が使う（blocking / degraded。validity は fail-open/
// fail-closed の適用範囲の重なり — 前提 7 — に blocking を付ける）。
// direction: 解消の方向のみ（enum）。旧 fix（自由記述の解消案）は廃止した — 検査者の文案は
// writer をアンカリングさせ、根拠からではなく文案から書かせる（schemas/role-map.md を正とする）。
// direction_note は方向の補足 1 行（50 字目安）に限り、文案・候補値・改訂文を書かせない
// （契約は schemas/agent-contracts.md）。
const AUDIT_DIRECTIONS = [
  'relax', 'tighten', 'make_measurable', 'choose_one', 'merge_or_split',
  'align_terms', 'add_trace', 'remove', 'document_decision', 'needs_human',
]
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
          direction: { type: 'string', enum: AUDIT_DIRECTIONS },
          direction_note: { type: 'string' },
          severity: { type: 'string', enum: ['blocking', 'degraded'] },
          // resolved_by: blocking の指摘を誰が閉じるか。requester はプロダクトの価値の判断（人間ゲートへ）、
          // writer は文書内の食い違い・閉じていない集合（他の項目と根拠から書き手が揃える。TBD にしない）。
          // 欠けたら requester として扱う（黙って人間から外すより、余計に聞く方が軽い）。
          resolved_by: { type: 'string', enum: ['requester', 'writer'] },
          // repro: 判定が割れる具体入力（またはその構成手順）。degraded 指摘にも必須の契約
          // （schemas/agent-contracts.md）。schema の required にはしない — writer が該当なしと
          // 判断したときに schema 違反で応答ごと失う経路を作らない（既存の enum 不採用と同じ理由）。
          repro: { type: 'string' },
          // action: 冗長指摘の処置（delete / merge_into:<ID> / replace_with_reference:<文書#ID>）。
          // 引数を取る形があるので enum にしない。writer は direction より具体的な処置としてこれに従う。
          action: { type: 'string' },
          // found_via: locate 読みの監査で、その指摘をどちらの読みで見つけたか。sample は locator の
          // 引用に現れなかった箇所での発見（= locator の見落とし）。full 読みの監査では付けない。
          found_via: { type: 'string', enum: ['locator', 'sample'] },
        },
        required: ['id', 'location', 'quote', 'issue', 'direction'],
      },
    },
    checked: { type: 'string' },
    // read_mode 以下は locate 読みを割り当てた監査だけが返す任意項目（他の観点の契約は変えない）。
    // 件数の正は script 側で数え直す（locator_misses は found_via: 'sample' の件数から導く）。
    read_mode: { type: 'string', enum: ['locate', 'full', 'full_fallback'] },
    read_fallback_reason: { type: 'string' },
    locator_quotes: { type: 'number' },
    locator_unmatched: { type: 'number' },
    locator_misses: { type: 'number' },
    // locate_groups: bulk-read の組（script が送信量の上限に収まるよう束ねた単位）ごとの結果。
    locate_groups: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          group: { type: 'string' },
          status: { type: 'string', enum: ['ok', 'split_ok', 'full_fallback'] },
          reason: { type: 'string' },
        },
        required: ['group', 'status'],
      },
    },
  },
  required: ['failed', 'checked'],
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
const AUDITOR_BY_NAME = Object.fromEntries(AUDITORS.map((a) => [a.name, a]))
const roleOverrides = applyRoleOverrides([ROLE_OPTS, AUDITOR_BY_NAME], parsedArgs.role_opts)
if (Object.keys(roleOverrides).length) log(`role_opts で上書きした配分: ${JSON.stringify(roleOverrides)}`)

// MAX_OUTER_ROUNDS: 外側ループの暴走防止 backstop（較正された停止条件ではない）。
// 停止の正条件は SKILL.md 手順 4 の乾き（今周回に first_seen の新規 blocking が 0）で、
// この値は乾かないまま回り続ける事故を切るためだけにある。固定 2 周だった旧設計は
// 「run 中の監査が新たに掘る NI はその run 内で提示できない」機序（kaizen 第 3 サイクル、
// 計装 3 run で帰属確定）により unpres >= 1 を定常化させていた。提示容量の前提
// （check_blocking_rate.py の 20 件/周 × 2 周）は MAX_GATE_ROUNDS が持ち、この値とは独立。
const MAX_OUTER_ROUNDS = 5

// entryErrors: 入口で止める args の不備を 1 箇所で列挙する。関数にしてあるのは、返り値の
// next_args（buildNextArgs）がこの検査をそのまま通ることを tests が確かめるため — 次周回の
// args が入口で落ちると、司令塔が手組みに戻り、転記ミスの経路が復活する。
function entryErrors(a) {
  const errs = []
  if (!a.skillDir) errs.push('args.skillDir が未指定です。SKILL.md の Workflow 呼び出し例に従ってください。')
  if (!a.input || typeof a.input !== 'string' || !a.input.trim()) {
    errs.push('args.input が空です。依頼文の全文を args.input に渡してください。')
  }
  if (!a.today) errs.push('args.today が未指定です。日付を推測で書かないため、ここで打ち切ります。')
  const docs = a.documents || []
  if (!docs.length) {
    errs.push('args.documents が空です。draft.js の返り値 documents をそのまま渡してください（初稿なしで改稿は始められません）。')
  }
  const round = Number(a.outer_round || 1)
  if (!Number.isInteger(round) || round < 1 || round > MAX_OUTER_ROUNDS) {
    errs.push(`args.outer_round が不正です: ${a.outer_round}（1〜${MAX_OUTER_ROUNDS} の整数）`)
  }
  // agent に本文を渡す経路はパスだけである（プロンプトへ本文を埋めない。実測: 改稿後の文書を
  // インラインで渡した監査プロンプトが 39 万字に達した）。Read できるパスが無い文書は、
  // agent に見せる手段が無いので入口で止める。
  const orphan = docs.filter((d) => !d || (!d.draft_path && !d.path))
  if (orphan.length) {
    errs.push(
      `args.documents に参照先（draft_path / path）の無い文書があります: ${orphan
        .map((d) => d && d.key)
        .join(' / ')}。agent は本文をパスから Read するため、パスの無い文書は監査も改稿もできません。`
    )
  }
  // draft_dir: writer が改稿稿を書き出す workspace のディレクトリ（絶対パス）。
  const draftDir = String(a.draft_dir || '').trim().replace(/\/+$/, '')
  if (docs.some((d) => d && !d.fixed) && !draftDir.startsWith('/')) {
    errs.push(
      `args.draft_dir が絶対パスではありません: "${draftDir}"。writer は改稿稿を workspace へ複写して Edit し、` +
        'agent は以後そのパスを Read する。Write / Edit は ~ を展開しないため絶対パスで渡してください。'
    )
  }
  // flow: 崩れた flow では改稿を始めない（writer には flow を直す手段が無い）。形と閉包の判定式は
  // FLOW_GRAPH 区間（doc_check.mjs の写し）にだけ置く。
  if (a.flow) {
    for (const f of flowGraphCompact(a.flow)) {
      errs.push(`args.flow が閉じていません: ${f.c} ${f.a.join(' / ')}。flow-framer の出力を直してから渡してください。`)
    }
  }
  const bulkReadPath = String(a.bulk_read_path || '').trim()
  if (bulkReadPath && !bulkReadPath.startsWith('/')) {
    errs.push(
      `args.bulk_read_path が絶対パスではありません: "${bulkReadPath}"。監査役は Bash でこのパスをそのまま実行するため、` +
        'インストール済み shunt plugin の scripts/bulk-read を展開した絶対パスで渡してください。'
    )
  }
  return errs
}
{
  const errs = entryErrors(parsedArgs)
  if (errs.length) throw new Error(errs.join('\n'))
}

const SKILL_DIR = parsedArgs.skillDir
const input = parsedArgs.input
const today = parsedArgs.today
const inputDocs = parsedArgs.documents

// outer_round: SKILL.md が持つ外側ループの周回カウンタ（1 or 2）。ユーザーには聞かない。
// R<outer>.<rev> は revision_log（返り値のメタ情報）だけで使う識別子であり、**生成文書には書かない**。
// 改稿の経緯は成果物ではなく実行の途中経過なので、本文にも変更履歴の章にも残さない。
const outerRound = Number(parsedArgs.outer_round || 1)
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
// flow: draft.js と同じ工程の流れ（形と閉包は entryErrors で検査済み）。writer が項目を当て直し、
// checker が当たり方を検査する。渡さない run では当てはめの検査が「未検査」になる。
const flow = parsedArgs.flow || null
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
// suppressed_finding_ids: 過去の run の終端裁定で「偽指摘（rejected）」と分類された
// **決定的な構造検査の指摘 ID**（例: "ST-UNDECLARED-PR-X-003"）。構造検査は無状態の算術で、
// 発火条件が本文に残る限り毎 run 同じ指摘を再起票する一方、棄却は返り値の中の分類で終わり
// run を跨いで持ち越されない（#53）。この口で司令塔（または next_args）が棄却済み ID を渡すと、
// 当該 ID の構造検査指摘を集計前に畳む。対象を auditor: 'structural' に限るのは、LLM 監査者の
// 指摘 ID（EX-001 等）は run ごとに振り直され、digest（auditor|document|location）も粗く、
// ID や digest での抑止が別の本物の指摘を誤って畳みうるため。畳んだ件数と ID は log と
// 返り値（suppressed_findings）に明示する — 黙って消さない。
const suppressedFindingIds = new Set(parsedArgs.suppressed_finding_ids || [])
const suppressedApplied = []
function applySuppression(structResult) {
  if (!suppressedFindingIds.size) return structResult
  const kept = []
  for (const f of structResult.findings || []) {
    if (f && f.auditor === 'structural' && (suppressedFindingIds.has(f.id) || suppressedFindingIds.has(`${f.document}::${f.id}`))) {
      suppressedApplied.push({ id: f.id, document: f.document })
      continue
    }
    kept.push(f)
  }
  return { ...structResult, findings: kept }
}
const draftStructural = (parsedArgs.draft_structural_findings || []).filter((f) => {
  if (f && f.auditor === 'structural' && (suppressedFindingIds.has(f.id) || suppressedFindingIds.has(`${f.document}::${f.id}`))) {
    suppressedApplied.push({ id: f.id, document: f.document })
    return false
  }
  return true
})
const reqDir = paths.requirements || 'docs/requirements'
const specDir = paths.specifications || 'docs/specifications'

// documents: draft.js の返り値のうち **メタ情報だけ** を受け取る。
//
// **本文（markdown）は args でも writer の返り値でも受け取らない。** 12 文書で 24 万文字を
// 超えることがあり、args に載せると呼び出し側が全文を書き写して中継し、返り値に載せると
// writer が改稿のたびに全文を出力する。workflow script はファイルを読めないが **agent は読める**
// ので、本文は draft_path を agent に Read させ、本文を要する決定的な検査（構造検査・行数・
// 変更範囲）は checker agent が scripts/doc_check.mjs を実行して結果だけを返す。
// 旧形式の args が markdown を持っていても読まない（読む口を残すと、本文を中継する経路が戻る）。
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
  // line_count: 本文の行数（改行で終わらない最終行も 1 行と数える）。checker が数え直して上書きする。
  ...(Number.isInteger(d.line_count) ? { line_count: d.line_count } : {}),
  summary: d.summary || '',
  items: d.items || [],
  ids: (d.items || []).map((i) => i.id).filter(Boolean),
  referenced: d.referenced_ids || [],
  vacant: d.vacant_ids || [],
  // trace: 前工程（Workflow A / 前周回）が申告した項目 ID → 根拠。改稿で writer が返した
  // 値に置き換わる。undefined のまま渡すと構造検査が「未検査」を立てるので、欠落は
  // 「根拠あり」に化けずに申告される。
  trace: d.trace,
  flow_refs: d.flow_refs || [],
  traceability: d.traceability || [],
  tbd_items: d.tbd_items || [],
  categories_deferred: d.categories_deferred || [],
  fixed: Boolean(d.fixed),
}))

// draft_dir: writer が改稿稿を書き出す workspace のディレクトリ（絶対パス。検査は entryErrors）。
// 改稿のたびに別ファイルへ複写して Edit させるのは、読んだ前稿を上書きすると書き出しの失敗で
// 唯一の写しが壊れるため。保存先（path）へは書かせない — そこへの書き出しは人間の承認後に司令塔が行う。
const draftDir = String(parsedArgs.draft_dir || '').trim().replace(/\/+$/, '')
const revisedDraftPath = (doc, revisionId) => `${draftDir}/${doc.kind}-${doc.topic}.${revisionId}.md`

// bulk_read_path: shunt の bulk-read スクリプトの絶対パス（任意）。渡されると、read: 'locate' の
// 監査役は全範囲監査でこれを使って候補箇所の逐語引用を集めてから原文を読む。未指定なら全文の
// 区切り読みに戻し、返り値の summary.locator に full_fallback として残す（黙って読み方を変えない）。
const bulkReadPath = String(parsedArgs.bulk_read_path || '').trim()

// sources_path: 司令塔が run 前に workspace へ書き出した根拠正本（過去周回のゲート②回答など）
// のパス（任意）。指定時は、全文を必要とする role（writer / fabrication-auditor）にだけ
// 「まず Read せよ」を指示し、他 role の CONTEXT からは history 全文を落として要旨 1 行に
// 置き換える（12 文書 × 7 観点のプロンプトが周回のたびに history 全文を抱えて肥大するため）。
// 未指定時は現行どおりインライン（後方互換）。
const sourcesPath = String(parsedArgs.sources_path || '').trim()

// buildContextBlock: CONTEXT を role 別に組む。
// - decisions: auditor / judge 系には `id: topic = value` の 1 行形式のみ（why / reversibility を
//   落とす — 検査に要るのは「何が決まっているか」で、経緯は判定材料にさせない）。writer と
//   adjudicator と resolver（生成・裁定側）には全フィールドを維持する。
// - tbd_answers_history: sources_path 指定時、writer / fabrication 以外には要旨 1 行のみ。
const decisionsOneLine = (list) =>
  (list || []).map((d) => `${d.id}: ${d.topic} = ${d.value}`).join('\n') || '(決定なし)'

// flowContext: writer へ渡す工程の流れ。要素の一覧と、項目を flow_refs で当てる指示だけを渡す（本文には
// 要素 ID も流れの説明も書かせない。流れは項目を当てる軸であって、読み手に向けた規範ではない）。
function flowContext(f) {
  if (!f) return ['# [FLOW] 工程の流れ', '(渡されていない。flow_refs は空配列で返す)']
  const elements = (f.elements || []).filter(Boolean).map((el) => ({
    id: el.id,
    type: el.type,
    label: el.label,
    ...(Array.isArray(el.next) && el.next.length ? { next: el.next } : {}),
    ...(Array.isArray(el.branches) ? { branches: el.branches.filter(Boolean).map((b) => ({ value: b.value, next: b.next })) } : {}),
  }))
  return [
    '# [FLOW] 工程の流れ（flow-framer が依頼から描いた入力・工程・判断・出力。項目を当てる軸）',
    '各項目を、それが振る舞いを定める要素に flow_refs（{ item_id, ref: 要素 ID }）で当てる。1 項目が複数の要素に当たってよい。',
    'どの項目も当たらない要素・判断の値は構造検査が指摘する。本文には要素 ID を書かない。flow は根拠ではないので trace には入れない。',
    JSON.stringify(elements),
  ]
}

function buildContextBlock(role) {
  const fullDecisions = role === 'writer' || role === 'adjudicator' || role === 'resolver'
  const historyInline = !sourcesPath
  const tbdAnswersSection =
    [
      ...(historyInline
        ? tbdAnswersHistory.map((e) => `## 第 ${e.round} 周回の回答\n${e.answers}`)
        : tbdAnswersHistory.length
        ? [`回答済み TBD の周回 ${tbdAnswersHistory.length} 件、正本: ${sourcesPath}`]
        : []),
      tbdAnswers ? `## 今周回の回答\n${tbdAnswers}` : '',
    ]
      .filter(Boolean)
      .join('\n\n') || '(未確定事項への回答なし)'
  return [
  '# [MODE] 実行モード',
  mode,
  '',
  '# [SKILL_PREMISES] スキルが固定する前提（案件ごとに問い直さない）',
  `${SKILL_DIR}/references/fixed-premises.md を Read し、そこに列挙された前提を執筆・検査の`,
  '枠組みとして使うこと。前提由来の書き方の選択は trace に `{ kind: "premise", ref: "前提 N" }` で申告し、本文には書かない。',
  '前提は案件の確定要求の根拠にはならない（区別は同ファイルの末尾節を正とする）。',
  '',
  '# [INPUT] 依頼文（確定要求の根拠その 1）',
  input,
  '',
  '# [ANSWERS] 事前分析の質問への回答（確定要求の根拠その 2）',
  answers,
  '',
  '# [TBD_ANSWERS] 統合ゲートの回答（確定要求の根拠その 3。過去周回の回答も含む）',
  tbdAnswersSection,
  '',
  '# [DECISIONS] 決定ログ（確定要求の根拠その 4。既定として選ばれた書き方・進め方）',
  '決定を根拠にした項目は trace に `{ kind: "decision", ref: "D-N" }` で申告し、本文には出所を書かない。使ってよい範囲は references/question-policy.md を正とする。',
  fullDecisions ? JSON.stringify(decisions, null, 2) : decisionsOneLine(decisions),
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
  ...(role === 'writer' ? [...flowContext(flow), ''] : []),
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
}

// CONTEXT_BLOCK: 生成側（writer / resolver）向けの全量版。role 別の縮約は buildContextBlock を使う。
const CONTEXT_BLOCK = buildContextBlock('writer')

// sourcesReadNote: sources_path 指定時に、全文を要する role（writer / fabrication）へ入れる指示。
const sourcesReadNote = sourcesPath
  ? `まず ${sourcesPath} を Read すること（過去周回のゲート②回答の正本。引用・照合はこの原本に対して行う）。`
  : ''

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
  'req-writer': [129, 191],
  'spec-writer': [192, 237],
  auditor: [238, 318],
  'executability-auditor': [319, 367],
  'ladder-judge': [368, 418],
  resolver: [419, 449],
  'resolver-verifier': [450, 473],
  'precedent-judge': [474, 511],
  measurement: [512, 537],
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
// document-structure.md（400 行超）を行範囲なしで Read すると gate に止められる。
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

// areaCode / tbdPrefix: draft.js と同じ規約でなければならない。ここがずれると、改稿のたびに
// ID の領域コードが変わり、本文中の表記と ID 一覧が食い違う。
const areaCode = (t) => {
  const s = String(t).toUpperCase().replace(/[^A-Z0-9]/g, '')
  return /^[A-Z]/.test(s) ? s : `X${s}`
}
const tbdPrefix = (doc) => `TBD-${doc.kind === 'requirements' ? 'R' : 'S'}${areaCode(doc.topic)}-`

// ------------------------------------------------------- 本文の渡し方（パスのみ）
//
// この区間の関数は scripts/draft.js に逐語で複製されている（一致は tests/test_prompt_budget.py が検査する）。
// 行数と変更範囲の計算は本文を要するので scripts/doc_check.mjs にある。
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

// bodyOf: 本文はプロンプトに入れず、draft_path を Read させる。
// docLineCount: 行数は checker（doc_check.mjs）が数えた値を使う。checker が走っていない文書は
// 呼び出し側が渡した documents[].line_count を使い、それも無ければ区切り読みも抜き取り範囲も
// 決められず全文読みへ戻る。
const docLineCount = (d) => (Number.isInteger(d.line_count) ? d.line_count : null)
const bodyOf = (d) => readInstruction(d.draft_path, docLineCount(d))

// lastRevisedId: 直近の改稿の revisionId。スコープ監査は、この改稿で書き換わった文書の
// 変更範囲（changed_ranges）だけを読ませる。
let lastRevisedId = null

// auditBodyOf: スコープ監査では変更された節の行範囲だけを読ませる。変更範囲を計算できなかった
// 文書（checker が走らなかった・前稿を読めなかった — changed_ranges が null）は全体を区切って読ませる。
function auditBodyOf(d, scoped) {
  if (!scoped) return bodyOf(d)
  if (d.revised_in !== lastRevisedId) return readInstruction(d.draft_path, docLineCount(d), [])
  if (!Array.isArray(d.changed_ranges)) return bodyOf(d)
  return readInstruction(d.draft_path, docLineCount(d), d.changed_ranges)
}

// indexInstruction: 本文を通読させずに、見出し索引から要る節だけを読ませる指示。索引は checker が
// doc_check.mjs で書き出した「開始-終了 見出し」の一覧。他文書・固定文書は突き合わせの参照先で
// あって読む対象そのものではないので、全文を読ませる理由が無い（実測: validity 1 体が固定文書 3 件を
// 含む全文書を通読し、文脈が 80 万トークンに達した）。checker が走らず索引が無いときも全文読みには
// 戻さず、見出しを Grep で列挙させる。
function indexInstruction(d) {
  const body = `本文 ${d.draft_path} は、要る節だけを索引の行範囲で ${READ_CHUNK_LINES} 行以内の offset/limit で Read する。全体は読まない。`
  if (!d.index_path) {
    return `見出し索引なし: ${d.draft_path} を Grep（パターン \`^#{2,4} \`・行番号付き）して見出しと行番号を列挙する。${body}`
  }
  const lines = Number(d.index_lines) || 0
  const head = `見出し索引: ${d.index_path}（${lines || '行数未確認'} 行。各行が「開始行-終了行 見出し」）`
  if (lines && lines <= READ_CHUNK_LINES) return `${head}を Read する。${body}`
  const chunks = []
  for (let st = 1; st <= (lines || READ_CHUNK_LINES); st += READ_CHUNK_LINES) {
    chunks.push(`- Read ${d.index_path} offset=${st} limit=${READ_CHUNK_LINES}`)
  }
  return [`${head}を次の単位で Read する。${body}`, ...chunks].join('\n')
}

// 他文書は「重複を作らないための参照」なので、要約と見出し索引で足りる。全体の区切り読みを
// 指示すると writer ごとに全文書を読み直すことになるため、要る節だけを読ませる。
function otherDocsContext(self) {
  return documents
    .filter((d) => d.key !== self.key)
    .map((d) => `## ${d.path}（${d.concern}）${d.fixed ? '【このランの対象外・変更不可】' : ''}\n\n要約: ${d.summary || '(なし)'}\n${indexInstruction(d)}`)
    .join('\n\n---\n\n')
}

// crossDocSection: 文書ごとに 1 体で走る観点（validity / specimen）に、他文書との突き合わせの材料を
// 渡す。本文ではなく ID 一覧と見出し索引を渡し、引用・参照している節だけを読ませる。
// 文書間の矛盾は両側の監査から見えるので、報告する側を文書の並び順で 1 つに決める（両側が報告すると
// 件数が二重になり、2 つの writer が逆向きに直しうる）。固定文書は監査されないので、固定文書との
// 矛盾は常にこちら側が報告する。
function crossDocSection(self) {
  const order = new Map(documents.map((d, i) => [d.key, i]))
  const others = documents.filter((d) => d.key !== self.key)
  if (!others.length) return []
  const owned = (d) => d.fixed || order.get(d.key) > order.get(self.key)
  const entry = (d) =>
    [
      `## ${d.key}（${d.path}・${d.concern || '関心事の記載なし'}）${d.fixed ? '【このランの対象外・変更不可】' : ''}`,
      `ID: ${(d.ids || []).join(' ') || '(申告なし)'}`,
      indexInstruction(d),
    ].join('\n')
  return [
    '# [OTHER_DOCUMENTS] 同じ案件の他文書（突き合わせの参照先。監査対象ではない）',
    '監査対象は上の [DOCUMENTS] の 1 文書だけである。他文書は、対象文書が参照・依存している節と、',
    '同じ対象について定めている節だけを、索引の行範囲で読む。他文書の問題そのものは指摘しない。',
    `文書間の矛盾を報告するのは、相手が次の文書のときだけ: ${others.filter(owned).map((d) => d.key).join(' / ') || '(なし)'}。`,
    'それ以外の文書との矛盾は相手側の監査が報告するので、ここでは報告しない。',
    '',
    others.map(entry).join('\n\n'),
    '',
  ]
}

// ------------------------------------------------------- locate 読み（安いモデルが探し、監査役が原文で判定する）
//
// 大きな文書を監査役（高価なモデル）に全文読ませる代わりに、shunt の bulk-read（Gemini）に候補箇所の
// 逐語引用だけを選ばせる。安いモデルに任せるのは「どこを見るか」の選択に限り、判定・要約はさせない。
// 判定に使う原文は、引用を Grep の完全一致で元ファイルに見つけ、その節を Read した監査役だけが持つ。
// 安いモデルが選ばなかった部分は、script が割り当てた抜き取り範囲を監査役が全文読みして見落としを測る。

// MISS_SAMPLE_SMALL_DOC_LINES / MISS_SAMPLE_CHUNKS_*: 見落とし測定の抜き取り量。600 行以下の文書は
// 300 行の塊 1 つ（= 文書の半分以上）で足りる。それを超える文書は 2 塊にとどめる — 塊を増やすほど
// 全文読みに近づき、locate にした意味（監査役の読む量を減らす）が消えるため。1 run で文書あたり
// 最大 600 行の追加読みと引き換えに、locator の見落とし率を run ごとに実測できる。
const MISS_SAMPLE_SMALL_DOC_LINES = 600
const MISS_SAMPLE_CHUNKS_SMALL = 1
const MISS_SAMPLE_CHUNKS_LARGE = 2

// locatorSampleRanges: 見落とし測定のために全文読みさせる塊（READ_CHUNK_LINES 行単位）を決める。
// 選び方は文書キーと版の FNV-1a ハッシュだけで決まる（Math.random / Date を使わない）— 同じ入力で
// 再実行すれば同じ範囲を読むので、見落とし率の差が抜き取り位置の揺れではなく locator の差になる。
// 版が変われば選ばれる塊も変わりうるので、周回を重ねると文書の別の場所が抜き取られる。
function locatorSampleRanges(docKey, revision, lineCount) {
  const total = Math.ceil((lineCount || 0) / READ_CHUNK_LINES)
  if (!total) return []
  const want = Math.min(total, lineCount <= MISS_SAMPLE_SMALL_DOC_LINES ? MISS_SAMPLE_CHUNKS_SMALL : MISS_SAMPLE_CHUNKS_LARGE)
  const picked = []
  for (let salt = 0; picked.length < want; salt++) {
    const text = `${docKey}|${revision}|${salt}`
    let h = 2166136261
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    const idx = (h >>> 0) % total
    if (!picked.includes(idx)) picked.push(idx)
  }
  return picked
    .sort((a, b) => a - b)
    .map((i) => ({ start: i * READ_CHUNK_LINES + 1, end: Math.min(lineCount, (i + 1) * READ_CHUNK_LINES) }))
}

// LOCATE_GROUP_MAX_BYTES: 1 回の bulk-read で送る量の上限（本文・ファイル枠・問いの合計の見積もり）。
// shunt の上限は SHUNT_MAX_PAYLOAD_BYTES=400000（shunt 0.1.1 の scripts/lib/gemini.sh 29 行目）で、
// 超えると送らずに失敗する（実測: 全文書を 1 回で送り 481,051 バイトで失敗）。同じ run で別の呼び出しが
// curl の時間切れ SHUNT_TIMEOUT_SECONDS=120（同 25 行目）にも掛かったので、上限の半分に抑えて
// 1 回の処理量も減らす。値は既定であり、時間切れの実績（summary.locator.group_status）で較正する。
const LOCATE_GROUP_MAX_BYTES = 200000
// LOCATE_PART_MAX_BYTES: 上限を超える 1 文書を行範囲で分けるときの 1 片の目安。行あたりのバイト数は
// 平均から見積もるので、表の多い区間では実際の片が見積もりより大きくなる。組の上限の半分にして、
// 見積もりの 2 倍に膨らんでも組の上限に収まるようにする。
const LOCATE_PART_MAX_BYTES = 100000
// LOCATE_FILE_OVERHEAD_BYTES: bulk-read が 1 ファイルごとに足す `<file path="…">` と `</file>` と改行
// （パスのバイト数は別に足す）。LOCATE_PROMPT_OVERHEAD_BYTES: 問いの前置きと回答形式の指示
// （ANSWER / EVIDENCE / UNVERIFIED の 4 行）の分（問い本体のバイト数は別に足す）。
const LOCATE_FILE_OVERHEAD_BYTES = 32
const LOCATE_PROMPT_OVERHEAD_BYTES = 400

// utf8Bytes: 文字列の UTF-8 バイト数（workflow script には Buffer が無い）。送信量の上限はバイトで
// 決まり、日本語は 1 字 3 バイト前後なので、文字数で代用すると送信量を 3 分の 1 に見積もる。
function utf8Bytes(text) {
  let n = 0
  for (const ch of String(text)) {
    const c = ch.codePointAt(0)
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4
  }
  return n
}

// locateGroups: bulk-read の呼び出し単位を決める。組ごとの送信量の見積もりが LOCATE_GROUP_MAX_BYTES を
// 超えないように文書を束ね、1 文書で超えるものは行範囲の片（chunk ファイル）に分ける。各組には時間切れの
// ときに 1 回だけ使う半分ずつの組（halves）を前もって決めておく — 監査役に分け方を考えさせない。
// 並びは大きい順の first-fit（同じ大きさは key 順）で、同じ入力なら同じ組になる。
function locateGroups(docs, questionBytes, chunkDir) {
  const indexNameOf = (key) => String(key).replace(/[^A-Za-z0-9._-]+/g, '__')
  const fileBytes = (file, bytes) => bytes + utf8Bytes(file) + LOCATE_FILE_OVERHEAD_BYTES
  const chunks = []
  const partsOf = (d, start, end, maxBytes) => {
    const perLine = d.byteSize / Math.max(1, d.lineCount)
    const span = Math.max(1, Math.floor(maxBytes / Math.max(1, perLine)))
    const out = []
    for (let a = start; a <= end; a += span) {
      const b = Math.min(end, a + span - 1)
      const file = `${chunkDir}/${indexNameOf(d.key)}.${a}-${b}.md`
      if (!chunks.some((c) => c.file === file)) chunks.push({ src: d.draft_path, start: a, end: b, file })
      out.push({ key: d.key, file, start: a, end: b, bytes: fileBytes(file, Math.ceil(perLine * (b - a + 1))) })
    }
    return out
  }
  const budget = LOCATE_GROUP_MAX_BYTES - LOCATE_PROMPT_OVERHEAD_BYTES - questionBytes
  const items = []
  for (const d of docs) {
    const whole = { key: d.key, file: d.draft_path, start: 1, end: d.lineCount, bytes: fileBytes(d.draft_path, d.byteSize) }
    if (whole.bytes <= budget) items.push(whole)
    else items.push(...partsOf(d, 1, d.lineCount, Math.min(LOCATE_PART_MAX_BYTES, budget)))
  }
  items.sort((x, y) => y.bytes - x.bytes || (x.key < y.key ? -1 : x.key > y.key ? 1 : x.start - y.start))
  const bins = []
  for (const it of items) {
    const bin = bins.find((b) => b.bytes + it.bytes <= budget)
    if (bin) {
      bin.items.push(it)
      bin.bytes += it.bytes
    } else bins.push({ items: [it], bytes: it.bytes })
  }
  const groups = bins.map((b, i) => {
    let halves
    if (b.items.length > 1) {
      halves = [[], []]
      b.items.forEach((it, k) => halves[k % 2].push(it))
    } else {
      const it = b.items[0]
      const d = docs.find((x) => x.key === it.key)
      const mid = Math.floor((it.start + it.end) / 2)
      halves = it.end > it.start ? [partsOf(d, it.start, mid, Infinity), partsOf(d, mid + 1, it.end, Infinity)] : null
    }
    return { id: `G${i + 1}`, bytes: b.bytes + LOCATE_PROMPT_OVERHEAD_BYTES + questionBytes, items: b.items, halves }
  })
  return { groups, chunks }
}

// auditReadPlan: この監査呼び出しの読み方を script が決める。locate にできない理由があれば
// full_fallback とその理由を返す（呼び出し側は理由を返り値に残す）。
// - スコープ監査（scoped）は変更範囲だけを読む既存の経路のまま（locate を掛けない）
// - bulk_read_path が無ければ locator を走らせる手段が無い
// - 行数の分からない対象文書があると抜き取り範囲を割り当てられない。見落としを測れない locate は
//   「読まなかった部分」を申告できないので、全文読みに戻す（固定文書は抜き取り対象外なので問わない）
// - バイト数の分からない対象文書があると、送信量の上限に収まる組を作れない（固定文書は bulk-read に
//   送らず、索引から要る節を読ませる）
function auditReadPlan(read, scoped, bulkPath, docs, questionBytes, chunkDir) {
  if (read !== 'locate' || scoped) return { mode: 'full' }
  if (!bulkPath) return { mode: 'full_fallback', reason: 'bulk_read_path_unset' }
  const unknown = docs.filter((d) => !d.fixed && !d.lineCount)
  if (unknown.length) return { mode: 'full_fallback', reason: `line_count_unknown: ${unknown.map((d) => d.key).join(', ')}` }
  const noBytes = docs.filter((d) => !d.fixed && !d.byteSize)
  if (noBytes.length) return { mode: 'full_fallback', reason: `byte_size_unknown: ${noBytes.map((d) => d.key).join(', ')}` }
  const sendable = docs.filter((d) => d.lineCount && d.byteSize)
  return {
    mode: 'locate',
    samples: docs
      .filter((d) => !d.fixed)
      .map((d) => ({ key: d.key, path: d.draft_path, ranges: locatorSampleRanges(d.key, d.revision, d.lineCount) })),
    chunkDir,
    ...locateGroups(sendable, questionBytes || 0, chunkDir),
  }
}

// locateQuestion: bulk-read に渡す問い。各監査役のチェックリストのうち「どこを見るか」だけを問い、
// 判定（矛盾か・欠落か）と言い換えを禁じる。引用を 1 行以内の原文の部分文字列に限るのは、監査役が
// Grep の完全一致で元ファイルの行を特定するため（表の複数行や要約は一致しない）。
function locateQuestion(auditorName, categories) {
  const contract = [
    '各引用は、ファイル内に実在する 1 行以内の連続した部分文字列を一字一句そのまま写し、ファイルパスを添えること。',
    '要約・言い換え・補足・正誤や矛盾や欠落の判断・評価は一切書かないこと。引用の列挙だけを返すこと。',
    '該当が無い項目は none とだけ書くこと。',
  ]
  if (auditorName === 'consistency') {
    return [
      '次の文書群から、以下のいずれかに当たる箇所をすべて原文のまま引用して列挙せよ。',
      '(1) 用語を定義している箇所、または同じものを別の語で呼んでいる箇所',
      '(2) 数値・上限・下限・期限・回数・時間を定めている箇所',
      '(3) 順序・優先順位・適用範囲・禁止・義務を定めている箇所のうち、別の文書も同じ対象について述べているもの（両方の文書の箇所を引用する）',
      '(4) 他の文書・INDEX・上位文書を参照している箇所',
      ...contract,
    ].join('\n')
  }
  if (auditorName === 'coverage') {
    return [
      '次の文書から、以下を原文のまま引用して列挙せよ。',
      `(1) 次の各カテゴリについて、それを扱っている章見出しまたは要求文。カテゴリ一覧: ${JSON.stringify(categories || [])}`,
      '    カテゴリごとに見出しを付け、見つからないカテゴリは「カテゴリ名: none」と書く。',
      '(2) 文書中のすべての章見出し（## / ### / #### で始まる行）',
      '(3) 「該当なし」「非該当」「対象外」と書かれている箇所',
      ...contract,
    ].join('\n')
  }
  throw new Error(`locate 読みの問いが未定義の監査役です: ${auditorName}`)
}

// locateDocumentsSection: locate 読みの [DOCUMENTS] 節。bulk-read は script が決めた組ごとに実行させる。
// 組が実行時に失敗しても、その組の文書だけを全文読みへ戻せるよう、区切り読みの一覧（[FALLBACK]）を
// 必ず添える — 読まずに済ませる経路を作らない。固定文書は bulk-read に送っても全文読みには戻さず、
// 索引から要る節を読ませる。
function locateDocumentsSection(plan, docs, bulkPath, question) {
  const quote = (p) => `'${String(p).replace(/'/g, `'\\''`)}'`
  const sampleLines = plan.samples.flatMap((s) =>
    s.ranges.map((r) => `- ${s.key}: Read ${s.path} offset=${r.start} limit=${r.end - r.start + 1}`)
  )
  const groups = plan.groups || []
  const chunks = plan.chunks || []
  const run = (items) => `${quote(bulkPath)} --question "$(cat ${quote(`${qDir(plan)}/locate-question.txt`)})" --paths ${items.map((it) => quote(it.file)).join(' ')}`
  const label = (it) => (it.start === 1 && it.file === docs.find((d) => d.key === it.key).draft_path ? it.key : `${it.key} ${it.start}〜${it.end} 行`)
  const groupBlocks = groups.map((g) =>
    [
      `### ${g.id}（見積もり ${g.bytes} バイト: ${g.items.map(label).join(' / ')}）`,
      '```bash',
      run(g.items),
      '```',
      ...(g.halves
        ? [
            `時間切れ（標準エラーに \`curl rc=28\` または \`timed out\`）のときだけ、次の 2 つを 1 回ずつ実行する:`,
            '```bash',
            run(g.halves[0]),
            run(g.halves[1]),
            '```',
          ]
        : []),
    ].join('\n')
  )
  return [
    '# [DOCUMENTS] 監査対象（読み方: locate）',
    '安いモデル（bulk-read）に候補箇所の逐語引用だけを探させ、判定はあなたが原文を読んで行う。',
    'bulk-read の出力は「どこを読むか」の手掛かりであって、判定の根拠ではない。',
    '',
    docs.map((d) => `- ${d.key}: ${d.draft_path}（${d.concern || '関心事の記載なし'}）${d.fixed ? '【このランの対象外・変更不可】' : ''}`).join('\n'),
    '',
    '## 手順 0: 問いと分割ファイルを書き出す（Bash でそのまま実行する。問いの文言を変えない）',
    '```bash',
    `mkdir -p ${quote(qDir(plan))}`,
    `cat > ${quote(`${qDir(plan)}/locate-question.txt`)} <<'LOCATE_Q'`,
    question,
    'LOCATE_Q',
    ...chunks.map((c) => `sed -n '${c.start},${c.end}p' ${quote(c.src)} > ${quote(c.file)}`),
    '```',
    '',
    `## 手順 1: 組ごとに候補箇所の逐語引用を集める（shunt の送信量の上限に収まるよう script が ${groups.length} 組に分けた。1 組ずつ実行する）`,
    ...groupBlocks,
    '使うのは出力の EVIDENCE 節の引用だけである。ANSWER / UNVERIFIED の記述は判定材料にしない。',
    '組ごとの結果を locate_groups に { group, status, reason } で記録する。status は、1 回で通れば "ok"、',
    '時間切れで 2 つに分けて両方通れば "split_ok"。分けても通らない・時間切れ以外で失敗した（0 以外の終了・',
    'API キーが無い・上限超過・EVIDENCE 節が無い）ときは、その組の文書だけを末尾の [FALLBACK] で全文読みし、',
    '"full_fallback" と reason を記録する。**他の組の結果は捨てない。** 全組が full_fallback になったときだけ、',
    'read_mode: "full_fallback" と read_fallback_reason を返す。',
    '**どの場合も、読まずに判定してはならない。**',
    '',
    '## 手順 2: 引用を原文で確かめてから判定する',
    '- 各引用から 1 行に収まる特徴的な部分文字列を選び、Grep（固定文字列・行番号付き）で元の文書（分割ファイルではない）を検索して行番号を得る。',
    `- 見つかった行を含む節（直前の ### / #### 見出しから次の同格の見出しの手前まで）を、${READ_CHUNK_LINES} 行以内の offset/limit で Read する。`,
    '- 判定は Read した原文だけから行う。指摘の quote も Read した原文から写す（引用をそのまま使わない）。',
    '- 元ファイルに逐語で見つからない引用は捨て、その件数を locator_unmatched に数える。',
    '- 引用が無いことは不在の証拠にならない。欠落・不在を指摘するときは、Grep で `^#{2,4} ` の見出しを自分で全列挙し、関係しうる節を Read して確かめる。',
    '',
    '## 手順 3: 見落としの抜き取り（script が割り当てた範囲。手順 1 の結果に関わらず全文を読む）',
    ...(sampleLines.length ? sampleLines : ['- （抜き取り対象の文書なし）']),
    'この範囲にも同じ観点を適用する。指摘には found_via を付ける — 手順 1 の引用が指していた箇所での指摘は "locator"、',
    '引用が指していなかった箇所で抜き取りによって見つけた指摘は "sample"（= locator の見落とし）。',
    '',
    '## 返り値に加えるもの',
    '- read_mode: "locate"（全組が失敗して全文読みに戻したときは "full_fallback" と read_fallback_reason）',
    '- locate_groups: 組ごとの { group, status, reason }',
    '- locator_quotes: EVIDENCE 節の引用の件数 / locator_unmatched: 逐語で見つからず捨てた件数 / locator_misses: found_via が "sample" の指摘件数',
    '- checked: 手順 2 で Read した範囲・手順 3 で Read した範囲・全文読みに戻した組を列挙し、それ以外の範囲は読んでいないことを明記する（読まなかった部分を申告しないと、網羅したように見える）',
    '',
    '## [FALLBACK] 全文の区切り読み（組が失敗したとき、その組の文書だけに使う）',
    docs.map((d) => `### ${d.key}\n${d.fixed ? indexInstruction(d) : readInstruction(d.draft_path, d.lineCount)}`).join('\n\n'),
  ].join('\n')
}

// qDir: 問いと分割ファイルの置き場（監査の呼び出しごとに別。並列の呼び出しが同じファイルを書かないように）。
const qDir = (plan) => plan.chunkDir

// fullFallbackNote: locate を割り当てた監査役を全文読みに戻したときの注記。理由は script が決めて
// 返り値にも残すので、監査役には read_mode を申告させるだけにする。
function fullFallbackNote(reason) {
  return [
    `# [READ_MODE] full_fallback（理由: ${reason}）`,
    'この監査は本来 locate 読みの割り当てだが、上の理由で全文の区切り読みに戻している。',
    '下の [DOCUMENTS] の指示どおり全文を読み、返り値の read_mode に "full_fallback" を入れること。',
  ].join('\n')
}

// summarizeLocator: locate を割り当てた監査の実績を監査役ごとに集計する。件数の正は script 側で
// 数える — locator_misses は自己申告の数ではなく found_via: 'sample' の指摘件数から導く（自己申告の
// 数は reported に並べるだけ）。判定（verdict）には使わない — 見落とし率を run ごとに見えるようにする計測である。
// locator_miss_rate: locate 読みの全指摘に占める sample 由来（locator の見落とし）の割合。抜き取りは
// 文書の一部しか読まないので、真の見落としはこれより多くありうる（下限の目安として読む）。
function summarizeLocator(records) {
  const out = {}
  for (const rec of records) {
    const s = (out[rec.auditor] = out[rec.auditor] || {
      calls: 0,
      locate: 0,
      full_fallback: 0,
      unreported: 0,
      fallback_reasons: [],
      sampled_chunks: 0,
      locator_quotes: 0,
      locator_unmatched: 0,
      findings_via_locator: 0,
      locator_misses: 0,
      locator_misses_reported: 0,
      locator_miss_rate: null,
      // 組ごとの結果（locate 読みの呼び出しの中で組単位に全文読みへ戻した件数）。既存の full_fallback は
      // 呼び出し単位の件数のままにして、以前の run と比べられるようにする。
      groups: 0,
      group_split_ok: 0,
      group_full_fallback: 0,
      group_unreported: 0,
      group_fallback_reasons: [],
    })
    s.calls++
    const result = rec.result || {}
    const reason =
      rec.plan.mode === 'full_fallback' ? rec.plan.reason : result.read_mode === 'full_fallback' ? result.read_fallback_reason || 'reported_by_auditor' : null
    if (reason) {
      s.full_fallback++
      if (!s.fallback_reasons.includes(reason)) s.fallback_reasons.push(reason)
      continue
    }
    if (result.read_mode !== 'locate') {
      s.unreported++
      continue
    }
    s.locate++
    s.sampled_chunks += (rec.plan.samples || []).reduce((n, x) => n + x.ranges.length, 0)
    const reported = new Map((result.locate_groups || []).filter((g) => g && g.group).map((g) => [g.group, g]))
    for (const g of rec.plan.groups || []) {
      s.groups++
      const r = reported.get(g.id)
      if (!r) s.group_unreported++
      else if (r.status === 'split_ok') s.group_split_ok++
      else if (r.status === 'full_fallback') {
        s.group_full_fallback++
        const why = r.reason || 'reported_by_auditor'
        if (!s.group_fallback_reasons.includes(why)) s.group_fallback_reasons.push(why)
      }
    }
    s.locator_quotes += Number(result.locator_quotes) || 0
    s.locator_unmatched += Number(result.locator_unmatched) || 0
    s.locator_misses_reported += Number(result.locator_misses) || 0
    for (const f of result.failed || []) {
      if (f && f.found_via === 'sample') s.locator_misses++
      else s.findings_via_locator++
    }
  }
  for (const s of Object.values(out)) {
    const total = s.findings_via_locator + s.locator_misses
    s.locator_miss_rate = total ? s.locator_misses / total : null
  }
  return out
}

// locateDocOf: locate 読みの計画に要る文書のメタ情報。行数は手元の本文から数えられるときだけ持つ。
// 版は改稿の revisionId（未改稿なら読み元のパス）— 抜き取り範囲のハッシュ入力になる。
const locateDocOf = (d) => ({
  key: d.key,
  concern: d.concern,
  draft_path: d.draft_path,
  fixed: d.fixed,
  revision: d.revised_in || d.draft_path,
  lineCount: docLineCount(d),
  byteSize: Number.isInteger(d.byte_size) ? d.byte_size : null,
  index_path: d.index_path || null,
  index_lines: d.index_lines || null,
})

// locatorRecords: locate を割り当てた（full_fallback を含む）全範囲監査の結果。summary.locator の材料。
const locatorRecords = []
function recordLocator(r) {
  if (r && r.plan && r.plan.mode !== 'full' && r.result) locatorRecords.push({ auditor: r.auditor, plan: r.plan, result: r.result })
}

// writerDirectives: 人間必要性の判定パイプライン（段 2〜4）が決めた「この TBD をこう解消する /
// 保持規則に変換する」を writer へ渡す経路。監査指摘とは契機が違う（指摘は文書の欠陥、これは
// 未確定事項の決着）ので [FINDINGS] に混ぜない — 混ぜると writer は「指摘の解消」として扱い、
// 決着した内容を新しい要求として書き足す方向へ流れる。
let writerDirectives = new Map()

// previousMetadata: 前稿について script が持っている申告の全体。writer は本文を通読しないので、
// 触っていない項目の申告をここから写させる（渡さないと、読んでいない項目は返り値の一覧から
// 落ち、構造検査が申告漏れ・根拠なしとして大量に起票する）。本文ではなくメタ情報なので、
// プロンプトに本文を埋めない規約には触れない。
function previousMetadata(doc) {
  const isReq = doc.kind === 'requirements'
  return {
    summary: doc.summary || '',
    [isReq ? 'requirement_items' : 'spec_items']: doc.items || [],
    trace: Array.isArray(doc.trace) ? doc.trace : null,
    flow_refs: doc.flow_refs || [],
    ...(isReq ? {} : { traceability: doc.traceability || [] }),
    tbd_items: doc.tbd_items || [],
    categories_deferred: doc.categories_deferred || [],
    referenced_ids: doc.referenced || [],
    vacant_ids: doc.vacant || [],
  }
}

// editInPlaceSection: 改稿は前稿の複写に Edit を当てて行わせる。全文を Write し直させると、
// 数か所の修正のために 1000 行の文書を区切り読みで通読し（ターンごとに伸びる文脈を読み直す）、
// 全文を出力することになる（実測: writer が run の cache read の約 45% を消費）。加えて全文の
// 書き直しは触っていない文言まで揺らし、変更範囲（= 次のスコープ監査の範囲）を広げる。
function editInPlaceSection(doc, revisionId) {
  const next = revisedDraftPath(doc, revisionId)
  const quote = (p) => `'${String(p).replace(/'/g, `'\\''`)}'`
  const answersPass = String(revisionId).endsWith('.0')
  return [
    '# [WRITE_BACK] 改稿稿の書き出し（前稿を複写して必要な箇所だけを Edit する。全文を書き直さない）',
    `前稿: ${doc.draft_path}（${docLineCount(doc) ? `${docLineCount(doc)} 行` : '行数未確認'}）`,
    `改稿稿: ${next}`,
    '1. Bash で前稿を改稿稿へ複写する。前稿そのものは書き換えない（書き出しに失敗したとき唯一の写しが壊れる）。',
    `   cp ${quote(doc.draft_path)} ${quote(next)}`,
    '2. 直す箇所だけを探して読む。指摘・決着の対象の ID・見出し・quote の特徴的な部分を Grep（固定文字列・行番号付き）で',
    `   改稿稿の中から探し、その節だけを ${READ_CHUNK_LINES} 行以内の offset/limit で Read する。全体を通読しない。`,
    ...(answersPass
      ? ['   [TBD_ANSWERS] の回答が効く箇所は、[PREVIOUS_METADATA] の tbd_items の ID と回答に出てくる語で Grep して探す。']
      : []),
    '   Edit は同じ会話で Read していないファイルを拒む。最初の Edit の前に、改稿稿（前稿ではない）の該当範囲を Read すること。',
    '3. Edit で必要な箇所だけを置き換える。指摘の無い箇所の文言は変えない — 言い回しを整えるだけの変更も入れない',
    '   （変わった節がそのまま次の監査範囲になり、触っていない箇所まで再監査される）。**Write で全文を書き直さない。**',
    '4. 確かめるのは Edit した範囲だけにする（その範囲を offset/limit で Read する）。書き終えた稿を全体に読み直さない —',
    '   行数・ID の申告と本文の突き合わせ・構造は script が checker で検査し、変わった範囲は次の監査が読む。',
    '   通読し直すと、読んだ文書全体が以後のターンに載り続ける（実測: 書き手 1 体が全文を 4 回に分けて読み直していた）。',
    `5. \`wc -l < ${quote(next)}\` を実行し、出た整数を返り値の line_count に入れる。`,
    '本文は返り値に入れない。script は改稿稿のファイルを検査し（行数が line_count と合わなければ書き出しの失敗として',
    'この改稿を採用しない）、以後の監査と次周回もこのファイルを Read する。',
    '前稿を読めない・複写に失敗した場合は、推測で書き始めず、その事実を summary に書いて line_count を返さないこと',
    '（前稿の無い改稿は新規執筆に化ける）。',
    `保存先（${doc.path}）には書かない — 保存先への書き出しは人間の承認後に司令塔が行う。`,
    '',
    '# [PREVIOUS_METADATA] 前稿の申告（返り値はこれを改稿後の状態に更新した全体で返す）',
    '項目一覧・trace・tbd_items・referenced_ids・vacant_ids・traceability は差分ではなく**文書全体の一覧**で返す。',
    '触っていない項目の要素はここから一字一句そのまま写す（script は本文から ID を独立に抽出して一覧と突き合わせる',
    'ので、写し漏れは申告漏れ・根拠なしとして指摘される）。',
    'trace が null のときは前稿の申告が無い。その場合に限り、全項目の trace を根拠原本から組み直して返す。',
    JSON.stringify(previousMetadata(doc), null, 1),
  ]
}

function buildWriterPrompt(doc, findings, revisionId, requirementsRevised) {
  const isReq = doc.kind === 'requirements'
  const role = isReq ? 'req-writer' : 'spec-writer'
  const tail = []
  if (findings && findings.length) {
    tail.push('# [FINDINGS] 解消すべき監査指摘', JSON.stringify(findings, null, 2), '')
    tail.push(
      '各指摘の `direction` は解消の方向（緩める・強める・削除する等）であり、文案ではない。',
      '**具体的な文はあなたが根拠原本から起草する**（検査者は文案を書かない契約 — role-map.md）。',
      '`resolver_proposals` が付いた指摘には、検証済みの解消候補（生成側 resolver の起草・',
      'resolver-verifier の検証を通過したもの）が添えてある。採用してもよいし、根拠に照らして',
      'より良い形に書き直してもよい。',
      '`action` が付いた指摘は冗長の指摘である。delete / merge_into:<ID> / replace_with_reference:<文書#ID> の',
      '処置をそのまま適用する（読み手の次の行動を変えない記述なので、書き直して残さない）。',
      '指摘の解消のために新しい要求を創作してはならない。情報が未確定なら TBD として立て、',
      'そのカテゴリ名を categories_deferred に入れること。',
      '`ladder_kind: "criteria"` の指摘は判定基準・既定の欠落である。書き手が決められる既定なら',
      '既定として書き、選んだ既定と代替候補を tbd_items[].candidates の形で返す（決められない',
      'なら blocking TBD として起票する）。',
      '`ladder_kind: "consistency"` の指摘は文書内の食い違い・閉じていない集合・表の欠けである。',
      '依頼者に聞く論点ではないので TBD にしない。`cited` の項目（無ければ指摘の箇所）を突き合わせ、',
      '根拠（trace）が上位文書・入力に辿れる側に揃えて直す。状態遷移と判定規則は',
      'references/document-structure.md §6 / §2.8 の表の形に直す（構造検査が網羅・一意・到達を確かめる）。',
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
  const directives = writerDirectives.get(doc.key) || []
  if (directives.length) {
    tail.push(
      '# [TBD_RESOLUTION] 未確定事項の決着（この 1 回で本文へ反映する）',
      JSON.stringify(directives, null, 2),
      '',
      '- `action: "resolve"` — `resolution` の内容を確定した規範として本文に書き、対応する',
      '  未確定事項を tbd_items から外す。根拠は本文に書かず、trace に申告する',
      '  （kind は先例なら decision、計測なら measurement）。',
      '- `action: "carry"` — 着手は止めないが決まっていない論点である。**本文には何も書かず**、',
      '  その未確定事項を tbd_items から外す（止めるべき進行が無いので保持規則も書かない。',
      '  裁定は文書の外の作業項目として追跡される）。',
      '- `action: "hold"` — その論点は決まらないままである。「決まっていない」と書く代わりに、',
      '  **裁定が下るまで何をしてはならないかを規範文として書く**（例:「〜の裁定が下るまで、',
      '  この出力を新しい箇所へ拡大してはならない」）。書いたら tbd_items から外す。',
      '  読み手が次に何をしてよいかが決まる形にすること — 「未定」とだけ書かれた項目を前に',
      '  すると、次工程は勝手に決めるか止まるかしかない。',
      ''
    )
  }
  return [
    roleHeader(SKILL_DIR, ['writer-common.md', `${role}.md`], role),
    RULES,
    ...(sourcesReadNote ? [sourcesReadNote] : []),
    '',
    CONTEXT_BLOCK,
    '',
    '# [THIS_DOCUMENT] あなたが改稿する 1 文書',
    `パス: ${doc.path}`,
    `扱う関心事: ${doc.concern || '(分割案に記載なし)'}`,
    `ID の領域プレフィックス: ${isReq ? 'PR' : 'SP'}-${areaCode(doc.topic)}-`,
    `未確定事項の ID: ${tbdPrefix(doc)}001 の形で振ること（この形以外で振らない）。`,
    '',
    ...editInPlaceSection(doc, revisionId),
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
    ...tail,
  ].join('\n')
}

function buildAuditPrompt(auditor, task, deferred, scopeNote) {
  // スコープ監査（scopeNote あり）は変更された節の行範囲だけを読ませ、網羅監査は全体を区切って読ませる。
  const narrowed = Boolean(scopeNote)
  const scoped =
    auditor.scope === 'all'
      ? // 固定文書は突き合わせの参照先なので、索引から要る節だけを読ませる（全文を読ませない）。
        documents
          .map((d) => `## ${d.path}（${d.concern}）${d.fixed ? '【このランの対象外・変更不可】' : ''}\n\n${d.fixed ? indexInstruction(d) : auditBodyOf(d, narrowed)}`)
          .join('\n\n---\n\n')
      : task.docs.map((d) => `## ${d.path}（${d.concern}）\n\n${auditBodyOf(d, narrowed)}`).join('\n\n---\n\n')
  // 読み方は script が決め、task に残す（結果の集計で「何を割り当てたか」を自己申告に頼らないため）。
  const locateDocs = (auditor.scope === 'all' ? documents : task.docs).map(locateDocOf)
  const question = auditor.read === 'locate' ? locateQuestion(auditor.name, requiredCategories) : ''
  const chunkDir = `${draftDir}/locate/${auditor.name}-${String(task.target).replace(/[^A-Za-z0-9._-]+/g, '__')}`
  const plan = auditReadPlan(auditor.read, narrowed, bulkReadPath, locateDocs, utf8Bytes(question), chunkDir)
  task.readPlan = plan
  const documentsSection =
    plan.mode === 'locate'
      ? [locateDocumentsSection(plan, locateDocs, bulkReadPath, question)]
      : [...(plan.mode === 'full_fallback' ? [fullFallbackNote(plan.reason), ''] : []), '# [DOCUMENTS] 監査対象', scoped]

  const head = [
    // executability だけが固有の契約節を持ち、他の観点は auditor 共通形で返す。
    roleHeader(SKILL_DIR, [auditor.file], auditor.name === 'executability' ? 'executability-auditor' : 'auditor'),
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
    head.push(buildContextBlock('auditor'), '')
  }

  if (auditor.name === 'specimen') {
    head.push(
      '# [SPECIMENS] 実在の標本文書（各項目をここへ実際に適用する）',
      '標本は通読しない。各項目の適用に要る節（その項目が判定する対象を記述している節）を索引で探し、その範囲だけを読む。',
      specimenPaths.map((p) => `## ${p}\n${indexInstruction(specimenIndexOf(p))}`).join('\n\n'),
      '標本は判定装置のテスト入力であり、監査対象ではない（標本自体の品質は指摘しない）。',
      ''
    )
  }

  if (auditor.name === 'fabrication') {
    if (sourcesReadNote) head.push(sourcesReadNote, '')
    head.push(
      '# [TRACE] 項目 ID → 根拠原本の引用（本文には根拠句を書かない規約なので、根拠はここにある）',
      JSON.stringify(
        (auditor.scope === 'all' ? documents : task.docs)
          .filter((d) => !d.fixed)
          .map((d) => ({ document: d.path, basis: d.trace || [] })),
        null,
        2
      ),
      '本文に出所が書かれていないことを指摘しない（規約どおりの状態である）。引用が原本に実在し、',
      'その項目を本当に支えているかを突き合わせること。trace の無い項目は構造検査が拾う。',
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

  // validity / specimen は文書ごとに 1 体なので、他文書は索引で渡して要る節だけを読ませる。
  const crossDoc = auditor.scope === 'each' && (auditor.name === 'validity' || auditor.name === 'specimen') ? crossDocSection(task.docs[0]) : []

  return [
    ...head,
    ...(scopeNote ? [scopeNote, ''] : []),
    ...documentsSection,
    '',
    ...crossDoc,
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

// ------------------------------------------------------- 本文の検査（checker 経由。draft/refine 共通）
//
// 本文を要する決定的な検査（構造検査・行数・変更範囲）の正本は scripts/doc_check.mjs である。
// workflow script はファイルを読めないので、checker agent に入力を渡してその CLI を実行させ、
// 出力だけを受け取る。この区間の関数は scripts/draft.js に逐語で複製されている（workflow script は
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
    ...(Array.isArray(d.flow_refs) && d.flow_refs.length ? { flow_refs: d.flow_refs.filter(Boolean).map((r) => ({ item_id: r.item_id, ref: r.ref })) } : {}),
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

// 工程の流れ（flow）の形と閉包。scripts/doc_check.mjs の同区間の逐語の写しである（入口で崩れた flow を止めるため。
// 一致は tests/test_doc_check.py が検査する）。
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

// flowForCheck: checker に渡す flow。doc_check.mjs が読むフィールドだけに絞る（checker は入力を書き写す）。
function flowForCheck(f) {
  if (!f) return null
  return {
    elements: (f.elements || []).filter(Boolean).map((el) => ({
      id: el.id,
      type: el.type,
      kind: el.kind,
      label: el.label,
      ...(Array.isArray(el.next) ? { next: el.next } : {}),
      ...(Array.isArray(el.branches) ? { branches: el.branches.filter(Boolean).map((b) => ({ value: b.value, next: b.next })) } : {}),
    })),
    kinds: (f.kinds || []).filter(Boolean).map((k) => ({ name: k.name, definition: k.definition })),
    closure: f.closure,
  }
}

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
    .filter((f) => f.severity === 'blocking' && f.resolved_by !== 'writer')
    .map((f) => ({
      // キーに issue を含める。document|location だけだと、同じ章に対する複数の指摘が
      // 同一 ID に潰れ、片方が黙って消える（draft.js と同じ規約にすること）。
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

// ladderToTbd: スコープの梯子で premise / question に分類された指摘を blocking TBD として
// 起票し直す（execToTbd と同じ安定キー規約）。名前空間 TBD-NI- は「人間からしか得られない
// 入力を待つ（needs_input）」ことを読み手が区別できるようにするため。改稿予算は消費させない —
// 根拠が入力に無い指摘を writer に回しても、writer は根拠を発明できず、予算を消費してから
// TBD 起票で逃げるだけだった（実測）。
function ladderToTbd(entries) {
  return entries.map(({ kind, finding: f }) => ({
    id: `TBD-NI-${stableKey(`${f.document}|${f.location}|${f.issue}`)}`,
    // text は issue の要旨のみ（解消案の焼き込みは execToTbd と同じ理由で行わない）。
    text: `${f.issue || f.text || '(指摘本文なし)'}`,
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

// normalizeLocation: 自由記述の location から表記だけの差（空白・記号・全半角・大小文字）を
// 落とす。location は auditor の自己申告値で、同じ場所を指していても「§4 / 検査範囲の限定」と
// 「検査範囲の限定（§4）」のように毎回書き方が揺れる。揺れが digest に入ると、同一箇所への
// 再指摘が毎ラウンド novelty に計上され、乾き停止（novelty 0）に原理的に到達できない
// （実測: 4 run 連続で dry_stop false・novelty 最終値 2〜5）。
function normalizeLocation(loc) {
  return String(loc || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s、。・．，,.\/>#§()（）「」『』\[\]【】:：;；\-—–_'"~〜｜|]+/g, '')
}

// findingDigest: 指摘の同一性を改稿を跨いで追跡するための安定キー（stableKey/FNV-1a を再利用）。
// auditor + 宛先 + 正規化した場所で導く。issue 本文は含めない — 文面は改稿のたびに auditor が
// 書き直すため、本文を含めると同一論点の言い換えが毎回「新規」に数えられ、novelty が
// auditor の言い回しの関数になる（乾き判定が注意依存に化ける）。粗視化の代償として、同一
// auditor が同一箇所に出す別論点は 1 つに畳まれるが、その場合も指摘自体は改稿・裁定に届く
// （digest は novelty / stuck の追跡キーであり、指摘の取捨には使われない）。
function findingDigest(f) {
  return stableKey(
    `${(f && f.auditor) || ''}|${(f && f.document) || ''}|${normalizeLocation(f && f.location)}`
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
// 全文書を draft_path 参照で渡す（line_count も添える — 次周回の入口で区切り読みの単位が決まる）。
// 出力は entryErrors をそのまま通らなければならない（tests が確かめる）。
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
      // 本文は常に draft_path（writer が最後に書き、checker が行数を照合済みのファイル。
      // 一度も改稿されていない文書は入力のパス）から読ませる。args に本文を載せない。
      return {
        key: d.key,
        kind: d.kind,
        topic: d.topic,
        concern: d.concern,
        path: d.path,
        draft_path: d.draft_path || d.path,
        ...(Number.isInteger(d.line_count) ? { line_count: d.line_count } : {}),
        summary: d.summary,
        items: d.items,
        referenced_ids: d.referenced,
        vacant_ids: d.vacant,
        // trace: 改稿の writer は本文を通読せず、触っていない項目の申告を前稿のメタ情報から写す。
        // 落とすと次周回の writer は根拠を写せず、全項目が根拠なしとして指摘される。
        trace: d.trace,
        flow_refs: d.flow_refs || [],
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
    ...(ctx.sources_path ? { sources_path: ctx.sources_path } : {}),
    ...(ctx.draft_dir ? { draft_dir: ctx.draft_dir } : {}),
    ...(ctx.flow ? { flow: ctx.flow } : {}),
    ...(ctx.role_opts ? { role_opts: ctx.role_opts } : {}),
    ...(ctx.bulk_read_path ? { bulk_read_path: ctx.bulk_read_path } : {}),
    ...(ctx.specimen_paths_arg && ctx.specimen_paths_arg.length
      ? { specimen_paths: ctx.specimen_paths_arg }
      : {}),
    // 今 run までに rejected と裁定された構造検査指摘の累積。次周回はこれを畳み、
    // 同じ偽指摘の再起票と再裁定を止める。
    ...(ctx.suppressed_finding_ids && ctx.suppressed_finding_ids.length
      ? { suppressed_finding_ids: ctx.suppressed_finding_ids }
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
const LADDER_KINDS = ['artifact', 'criteria', 'consistency', 'premise', 'question']
// FORMAL_FINDING: 状態 × イベント表・判定表・工程の流れの閉包を doc_check.mjs が算術で検出した指摘。
// 文書内の整合と閉包の欠陥であって依頼者の判断ではないので、ladder-judge に分類させず writer へ流す
// （分類させると「行き先が決まっていない」の見かけで question に落ち、人間ゲートへ届く — 実 run で
// 6 文書 12 問のほぼ全件がこの型だった）。
const FORMAL_FINDING = /^ST-(STATE|DT|FLOW)-/
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
          // cited: consistency のとき、食い違っている（または集合を閉じる材料を持つ）項目の ID・箇所。
          // writer はこれを突き合わせて揃える。挙げられないなら consistency ではない。
          cited: { type: 'array', items: { type: 'string' } },
          rationale: { type: 'string' },
        },
        required: ['digest', 'kind', 'rationale'],
      },
    },
  },
  required: ['classified'],
}

// partitionLadder: ladder-judge の分類で改稿経路（toWriter）と人間ゲート経路（needsInput）に分ける。
// 指摘は丸ごと渡す — severity: degraded の冗長指摘の action もここで落とさずに writer へ届く。
function partitionLadder(withDigest, kindByDigest, citedByDigest) {
  const toWriter = []
  const needsInput = []
  for (const f of withDigest) {
    const kind = kindByDigest.get(f.digest)
    if (kind === 'premise' || kind === 'question') needsInput.push({ ...f, ladder_kind: kind })
    // consistency: 文書内の食い違い・閉じていない集合。writer が挙げられた項目を突き合わせて揃える。
    else if (kind === 'consistency') toWriter.push({ ...f, ladder_kind: kind, cited: (citedByDigest && citedByDigest.get(f.digest)) || [] })
    // judge が応答しなかった / 分類が欠けた指摘は従来どおり writer へ流す。分類の欠測で
    // 改稿経路そのものを止めない（欠測を needs_input に読み替えると偽の質問が人間へ飛ぶ）。
    else toWriter.push({ ...f, ladder_kind: kind || 'artifact' })
  }
  return { toWriter, needsInput }
}

async function classifyFindings(findings, label) {
  const all = findings.map((f) => ({ ...f, digest: f.digest || findingDigest(f) }))
  // executability が resolved_by: writer と申告した着手不能（draft から EX-WRITER- として届くものを含む）も
  // judge に回さない。judge はこの申告を見ないので、見かけで question に落とすと TBD-NI として人間ゲートへ戻る。
  const writerClosable = (f) => FORMAL_FINDING.test(String(f.id || '')) || f.resolved_by === 'writer'
  const formal = all.filter(writerClosable).map((f) => ({ ...f, ladder_kind: 'consistency' }))
  const withDigest = all.filter((f) => !writerClosable(f))
  if (!withDigest.length) return { toWriter: formal, needsInput: [], unclassified: 0 }
  const res = await agent(
    [
      roleHeader(SKILL_DIR, ['ladder-judge.md'], 'ladder-judge'),
      '判定表は上の契約の範囲にある。',
      '',
      '# [FINDINGS] 分類対象（digest で照合される。digest を書き換えない）',
      JSON.stringify(
        withDigest.map(({ digest, auditor, document, location, quote, issue, direction, direction_note, fix, severity, action }) => ({
          // fix は構造検査（script 生成の決定的指摘）だけが持つ。LLM auditor は direction。
          digest, auditor, document, location, quote, issue, direction, direction_note, fix, severity, action,
        })),
        null,
        2
      ),
    ].join('\n'),
    { ...ROLE_OPTS.ladderJudge, schema: LADDER_SCHEMA, phase: 'Audit', label }
  )
  const classified = (((res || {}).classified) || []).filter((e) => e && e.digest && LADDER_KINDS.includes(e.kind))
  const kindByDigest = new Map(classified.map((e) => [e.digest, e.kind]))
  const citedByDigest = new Map(classified.map((e) => [e.digest, Array.isArray(e.cited) ? e.cited : []]))
  const parted = partitionLadder(withDigest, kindByDigest, citedByDigest)
  const toWriter = [...formal, ...parted.toWriter]
  const needsInput = parted.needsInput
  const unclassified = withDigest.filter((f) => !kindByDigest.has(f.digest)).length
  if (unclassified > 0) {
    log(
      `ladder-judge 欠測: ${unclassified} 件が未分類のまま writer 経路へ流れました` +
        '（premise 相当が artifact 扱いされる恐れ。捏造監査が下流で照合します）。'
    )
  }
  return { toWriter, needsInput, unclassified }
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

// (kaizen C4) attributionObserve: 改稿で追加された項目の trace.quote が根拠原本に文字列として
// 実在するかを、LLM の判断を介さず分類する純データ関数（観測のみ。文書にも指摘にも触れない）。
// 背景: fabrication は「原本に無い内容を、原本にあるかのように申告して本文へ足す」形で現れるが、
// doc_check.mjs の structuralFindings(7) は trace の存在だけを見て内容を照合しない。照合は quote 契約
// （「原本に実在する文字列を写す」）により文字列一致で機械化できる。介入（再依頼・revert）は
// 露出の実測が溜まるまで入れない — 偽陽性の規模を知らないまま副作用を入れないため。
// 設計の要点（plan-verifier の反証由来）:
// - added の母集団は「writer 申告 ∪ ID 集合差分」の和集合（片方の欠落・省略で母集団が縮む
//   経路を作らない。両導出の不一致は derivation_disagreement として記録のみ）
// - trace は同一 item_id に複数エントリを持ち得る。1 件でも一致すれば matched（帰属の必要条件は
//   「支える原本が 1 つ実在する」こと）。エントリ単位の内訳は record に残す
// - premise / measurement はプロセス内に引用可能な原本が無いので照合せず recorded_only とする。
//   ただし kind_escape として別掲する（この kind を申告すれば照合を回避できる事実を隠さない）
// - decision / domain の原本はオブジェクト。JSON.stringify を haystack にするとエスケープが
//   正当な引用を落とすので、文字列値だけを再帰的に集めて結合する
// - 正規化は NFKC + 空白連続の単一スペース化（削除ではない — 全削除は行境界を跨いだ偶然一致を
//   作る）。NORM 後 20 文字未満の quote は too_short（短文は偶然一致と区別できない）
// - exposure の定義: unattributed + too_short + no_trace の合計（recorded_only と matched は
//   含めない）。この値が次サイクルの「未帰属追加の実測率」の分子になる
function attributionObserve({ prev_ids, next_items, declared_added_ids, trace, origins }) {
  const norm = (s) =>
    String(s || '')
      .normalize('NFKC')
      .replace(/[\s　]+/g, ' ')
      .trim()
  const collectStrings = (v, out) => {
    if (typeof v === 'string') out.push(v)
    else if (Array.isArray(v)) for (const x of v) collectStrings(x, out)
    else if (v && typeof v === 'object') for (const k of Object.keys(v)) collectStrings(v[k], out)
    return out
  }
  const haystacks = {}
  for (const kind of ['input', 'answers', 'tbd_answers']) haystacks[kind] = norm(origins[kind])
  for (const kind of ['decision', 'domain']) haystacks[kind] = norm(collectStrings(origins[kind], []).join('\n'))
  const NO_ORIGIN_KINDS = new Set(['premise', 'measurement'])
  const MIN_QUOTE_NORM_LEN = 20

  const prevSet = new Set(prev_ids || [])
  const nextIds = (next_items || []).map((i) => i && i.id).filter(Boolean)
  const diffAdded = nextIds.filter((id) => !prevSet.has(id))
  const declared = (declared_added_ids || []).filter(Boolean)
  const added = [...new Set([...declared, ...diffAdded])].filter((id) => nextIds.includes(id))
  const derivationDisagreement =
    declared.filter((id) => !diffAdded.includes(id)).length +
    diffAdded.filter((id) => !declared.includes(id)).length

  const records = []
  for (const id of added) {
    const entries = (trace || []).filter((t) => t && t.item_id === id)
    if (!entries.length) {
      records.push({ item_id: id, classification: 'no_trace', entries: [] })
      continue // eslint-disable-line -- 分類済み項目を後段の照合へ流さない
    }
    const perEntry = entries.map((t) => {
      const kind = String(t.kind || '')
      if (NO_ORIGIN_KINDS.has(kind)) return { kind, verdict: 'recorded_only' }
      const q = norm(t.quote)
      if (q.length < MIN_QUOTE_NORM_LEN) return { kind, verdict: 'too_short', norm_len: q.length }
      const hay = haystacks[kind]
      if (!hay) return { kind, verdict: 'unattributed', reason: 'unknown_kind_or_empty_origin' }
      return { kind, verdict: hay.includes(q) ? 'matched' : 'unattributed', norm_len: q.length }
    })
    const has = (v) => perEntry.some((e) => e.verdict === v)
    const classification = has('matched')
      ? 'matched'
      : has('recorded_only')
      ? 'recorded_only'
      : has('unattributed')
      ? 'unattributed'
      : 'too_short'
    // shielded: premise/measurement エントリの併記が unattributed エントリを classification 上
    // 遮蔽している項目（監査の敵対 fixture F9 で発見）。分類は変えず（正当な premise 項目を
    // exposure に混ぜない）、遮蔽の事実だけを別掲して観測から消えないようにする。
    const shielded = classification === 'recorded_only' && has('unattributed')
    records.push({ item_id: id, classification, shielded, entries: perEntry })
  }
  const count = (c) => records.filter((r) => r.classification === c).length
  return {
    records,
    counters: {
      added_total: added.length,
      matched: count('matched'),
      unattributed: count('unattributed'),
      too_short: count('too_short'),
      no_trace: count('no_trace'),
      kind_escape: count('recorded_only'),
      kind_escape_shielded: records.filter((r) => r.shielded).length,
      derivation_disagreement: derivationDisagreement,
      exposure: count('unattributed') + count('too_short') + count('no_trace'),
    },
  }
}
// 集約: 呼び出しは改稿ラウンド × 文書ごとに起きるので、record は round / document 付きで
// 追記し、counters は最終集計時に records から再計算する（1 回分の形状を使い回さない）。
const attributionRecords = []

// ------------------------------------------------------- checker の実行（refine 側）
//
// checkerMissing: 検査を実行できなかったパス。監査役の欠測（missing）は監査ラウンドごとに
// 組み直されるので、そこへ混ぜると次のラウンドで消える。別に貯め、返り値で合流させる。
const checkerMissing = []
// lastCheck: 直近の checker の結果。構造検査の指摘・行数・変更範囲はここから取る。
let lastCheck = null

async function runDocChecks(label, prevPaths) {
  if (!draftDir) {
    checkerMissing.push(`checker@${label}`)
    return { ok: false, label, reason: 'draft_dir が無く、checker の入力を書き出す先が無い' }
  }
  // index_dir: 各文書の見出し索引の書き出し先。監査役・writer は他文書や固定文書を通読せず、索引から
  // 要る節だけを読む。index_extra: run の外の標本文書（索引だけが要る）。
  const docPaths = new Set(documents.map((d) => d.draft_path))
  const extra = specimenPaths.filter((p) => !docPaths.has(p))
  const input = {
    documents: documents.map((d) => checkerDoc(d, prevPaths && prevPaths.get(d.key))),
    flow: flowForCheck(flow),
    index_dir: `${draftDir}/checks/index`,
    ...(extra.length ? { index_extra: extra } : {}),
  }
  const file = `${draftDir}/checks/${label}.json`
  const [check] = await runWithRetry(
    `構造検査 ${label}`,
    [input],
    (inp, attempt) =>
      agent(checkerPrompt(inp, file, SKILL_DIR), {
        ...ROLE_OPTS.checker,
        schema: CHECK_SCHEMA,
        phase: 'Audit',
        label: `checker-${label}${attempt > 1 ? `-retry${attempt - 1}` : ''}`,
      }).then((res) => verifyCheck(res, inp)),
    (r) => r && r.ok
  )
  const result = { ...(check || { ok: false, reason: 'checker が応答しなかった' }), label }
  if (!result.ok) {
    checkerMissing.push(`checker@${label}`)
    log(`構造検査 ${label}: 実行できませんでした（${result.reason}）。このパスの構造検査は「0 件」ではなく「未検査」として扱います。`)
  }
  return result
}

// structuralOf: checker の結果を構造検査の形（findings / not_checked）で返す。実行できなかった
// パスは指摘 0 件ではなく未検査として not_checked に載せる。
function structuralOf(check) {
  if (check && check.ok) {
    return applySuppression({ findings: check.structural.findings, not_checked: check.structural.not_checked })
  }
  return {
    findings: [],
    not_checked: [
      {
        id: 'ST-NOTCHECKED-CHECKER',
        issue:
          `構造検査を実行できなかった（${check ? `${check.label}: ${check.reason}` : '未実行'}）。` +
          'ID の照合・本文の検査は「指摘 0 件」ではなく「未検査」である。',
      },
    ],
  }
}

// applyCheck: checker が実ファイルで数えた行数を正とし、今回改稿した文書には変更範囲を付ける。
// 見出し索引とバイト数も受け取る（索引は他文書・固定文書を節単位で読ませるため、バイト数は locate 読みの
// 送信量を組むため）。
function applyCheck(check, revisedKeys) {
  if (!check || !check.ok) return
  for (const d of documents) {
    const c = check.byKey.get(d.key)
    if (!c || !c.exists) continue
    d.line_count = c.line_count
    d.byte_size = Number.isInteger(c.byte_size) ? c.byte_size : null
    d.index_path = c.index_path || null
    d.index_lines = c.index_lines || null
    if (revisedKeys.has(d.key)) d.changed_ranges = c.changed_ranges
  }
  for (const x of check.indexExtra || []) {
    if (x && x.path) specimenIndex.set(x.path, { draft_path: x.path, index_path: x.index_path || null, index_lines: x.index_lines || null })
  }
}

// specimenIndex / specimenIndexOf: 標本の見出し索引。run の文書なら文書の索引を、run の外の標本なら
// checker が index_extra として書いた索引を使う。どちらも無ければ Grep で見出しを列挙させる。
const specimenIndex = new Map()
function specimenIndexOf(p) {
  const d = documents.find((x) => x.draft_path === p || x.path === p)
  if (d) return d
  return specimenIndex.get(p) || { draft_path: p, index_path: null, index_lines: null }
}

// forceAll: 人間ゲート②の回答を反映する最初のパスで使う。このパスは監査指摘ではなく回答が
// 契機なので、findings が空でも引き直す必要がある。findings で絞ると、反映パスが 1 文書も
// 動かないまま通る。true は全文書、Set は回答が名指しした文書だけ（answerTargets）。Set のときも
// 要求文書が改稿されれば仕様書は紐付けの追随のために引き直す（下の規則がそのまま効く）。
async function reviseDocuments(findingsByDoc, revisionId, forceAll) {
  // requirements を先に流し切ってから specifications に入る。仕様項目は文書を跨いだ
  // 要求 ID を引くため、要求側の増減が確定するまで紐付けを直しようがない。
  let requirementsRevised = false
  lastRevisedId = revisionId
  // staged: writer が line_count を返した改稿。ファイルの照合（checker）を通るまでは仮の採用で、
  // 通らなければ before へ戻す。
  const staged = []

  const runFor = async (kind) => {
    const subset = documents.filter((d) => d.kind === kind && !d.fixed)
    const targetsForRound = subset.filter((d) => {
      if (forceAll === true) return true
      if (forceAll instanceof Set && forceAll.has(d.key)) return true
      // 未確定事項の決着（段 2〜4）は指摘 0 件でも引き直す契機である。指摘の有無だけで
      // 絞ると、決着の反映パスが 1 文書も動かないまま「反映済み」として返る。
      if ((writerDirectives.get(d.key) || []).length) return true
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
          ...ROLE_OPTS.writer,
          schema: kind === 'requirements' ? REQ_DOC_SCHEMA : SPEC_DOC_SCHEMA,
          phase: revisionId.endsWith('.0') ? 'Reflect' : 'Revise',
          label: `${kind === 'requirements' ? 'req' : 'spec'}-${doc.topic}-${revisionId}${attempt > 1 ? `-retry${attempt - 1}` : ''}`,
        }).then((result) => ({ doc, result: result || null })),
      (r) => r && r.result && reportedLineCount(r.result) !== null
    )
    for (const { doc, result } of results) {
      if (reportedLineCount(result) === null) {
        // 改稿が返らなければ前稿を維持する。空で上書きすると改稿前より悪化する。
        // ただし「直そうとして直らなかった」と「一度も直されていない」は区別して返す。
        writerMissing.push(`${doc.key}@${revisionId}`)
        log(`改稿 ${revisionId}: ${doc.key} の writer が応答しないか line_count を返さず、前稿を維持しました。`)
        continue
      }
      const idx = documents.findIndex((d) => d.key === doc.key)
      const before = documents[idx]
      const items = kind === 'requirements' ? result.requirement_items || [] : result.spec_items || []
      documents[idx] = {
        ...before,
        draft_path: revisedDraftPath(doc, revisionId),
        revised_in: revisionId,
        // 変更範囲と行数は checker が前稿と改稿稿のファイルから計算して入れる（applyCheck）。
        // 索引とバイト数も前稿のものなので外す（残すと改稿稿を前稿の行範囲で読ませる）。
        changed_ranges: null,
        index_path: null,
        index_lines: null,
        byte_size: null,
        summary: result.summary || before.summary,
        items,
        ids: items.map((i) => i.id).filter(Boolean),
        referenced: result.referenced_ids || [],
        vacant: result.vacant_ids || [],
        trace: result.trace,
        flow_refs: result.flow_refs || [],
        traceability: kind === 'specifications' ? result.traceability || [] : [],
        tbd_items: result.tbd_items || [],
        categories_deferred: result.categories_deferred || [],
        item_delta: result.item_delta || null,
      }
      staged.push({ key: doc.key, idx, before, result, items })
      if (kind === 'requirements') requirementsRevised = true
    }
  }

  await runFor('requirements')
  await runFor('specifications')

  // 書き出しの照合と構造検査を 1 回の checker でまとめて行う。前稿のパスを渡すと、変更範囲が
  // 前稿と改稿稿のファイルから計算される（手元に本文を持たないので、ファイル同士で比べる）。
  const prevOf = (list) => new Map(list.map((s) => [s.key, s.before.draft_path]))
  let check = await runDocChecks(revisionId, prevOf(staged))
  let accepted = staged
  if (check.ok) {
    // 書き出しが確かめられない改稿は採用しない。以後の agent はファイルしか読めないので、
    // 申告とファイルが食い違うと、監査は writer が申告したのと別の本文を見る。
    const rejected = staged.filter((s) => !lineCountConfirmed(reportedLineCount(s.result), check.byKey.get(s.key)))
    for (const s of rejected) {
      const c = check.byKey.get(s.key)
      writerMissing.push(`${s.key}@${revisionId}`)
      log(
        `改稿 ${revisionId}: ${s.key} の書き出しを確認できません（line_count ${s.result.line_count} / ` +
          `ファイル ${c && c.exists ? `${c.newline_count} 改行` : '無し'}）。前稿を維持しました。`
      )
      documents[s.idx] = s.before
    }
    if (rejected.length) {
      accepted = staged.filter((s) => !rejected.includes(s))
      // 戻した文書の本文で検査し直す。採用しなかった稿の検査結果を残すと、指摘が実在しない本文を指す。
      check = await runDocChecks(`${revisionId}-recheck`, prevOf(accepted))
    }
  }
  // checker が走らなかったパスは照合できないが、改稿は採用する（ファイルは writer が書いている）。
  // 行数は writer の申告で代用し、変更範囲は分からないので全体を区切って読ませる（changed_ranges: null）。
  if (!check.ok) {
    for (const s of accepted) documents[s.idx].line_count = reportedLineCount(s.result)
  }
  applyCheck(check, new Set(accepted.map((s) => s.key)))
  lastCheck = check

  for (const s of accepted) {
    // (kaizen C4) 帰属の観測。前稿の ids は before に残っている。
    const gateObs = attributionObserve({
      prev_ids: s.before.ids || [],
      next_items: s.items,
      declared_added_ids: ((s.result.item_delta || {}).added_items || []).map((a) => a && a.id),
      trace: s.result.trace || [],
      origins: {
        input,
        answers,
        tbd_answers: [...tbdAnswersHistory.map((e) => e.answers), tbdAnswers].filter(Boolean).join('\n'),
        decision: decisions,
        domain: domainFindings,
      },
    })
    for (const rec of gateObs.records) attributionRecords.push({ round: revisionId, document: s.key, ...rec })
  }
  return requirementsRevised
}

// 回答が来ているときだけ反映パスを走らせる。人間ゲート②を飛ばした（blocking 0 件の）ランで
// 空の反映パスを回すと、直す理由が無いまま opus が全文書を書き直し、初稿が理由なく変わる。
// answerTargets: 今周回の回答が効く文書。回答の空でない各行が、既知の TBD の ID を 1 つ以上
// 名指ししているときに限り、その TBD を持つ文書に絞る。1 行でも宛先の決まらない行（ID を含まない
// 決定・前置き）があれば null を返し、全文書を引き直す — 回答がどの文書に効くかを script は本文から
// 判断できないので、決められないときは反映漏れの側に倒さない。絞れれば、回答と無関係な文書に
// writer を 1 体ずつ出さずに済む（opus の writer 1 体は前稿の該当箇所を探して読むだけでも重い）。
function answerTargets(answersText) {
  const owner = new Map()
  const keyOf = (ref) => (documents.find((d) => d.key === ref || d.path === ref || d.draft_path === ref) || {}).key
  for (const d of documents) for (const t of d.tbd_items || []) if (t && t.id) owner.set(t.id, d.key)
  for (const t of inputTbdItems) if (t && t.id && keyOf(t.document)) owner.set(t.id, keyOf(t.document))
  const keys = new Set()
  for (const line of String(answersText).split('\n').map((l) => l.trim()).filter(Boolean)) {
    const ids = (line.match(/\bTBD-[A-Z][A-Z0-9]*-[A-Za-z0-9]+\b/g) || []).filter((id) => owner.has(id))
    if (!ids.length) return null
    for (const id of ids) keys.add(owner.get(id))
  }
  return keys.size ? keys : null
}

if (tbdAnswers) {
  const reflectTargets = answerTargets(tbdAnswers)
  if (reflectTargets) log(`回答の反映: 回答が名指しした TBD を持つ文書だけを引き直します（${[...reflectTargets].join(' / ')}）。`)
  await reviseDocuments(new Map(), `R${outerRound}.0`, reflectTargets || true)
  revisionLog.push({ revision_id: `R${outerRound}.0`, trigger: ['人間ゲート②の回答'], reason: 'TBD 回答の反映', changed_by: 'user 回答の反映' })
} else {
  log('人間ゲート②の回答が空のため、反映パスを飛ばして監査から始めます。')
}
// 反映パスを通らなかったランでも、監査の前に一度 checker を通して行数と構造検査を得る
// （行数が無いと区切り読みと locate の抜き取り範囲が決まらず、構造検査が無いと改稿の契機が欠ける）。
if (!lastCheck) {
  lastCheck = await runDocChecks(`R${outerRound}.initial`, new Map())
  applyCheck(lastCheck, new Set())
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
// STUCK_THRESHOLD 回連続で同一 digest のまま残り、通常改稿から外して resolver のバッチ処理へ回す指摘。
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
      // 文書ごとに 1 体（全文書を 1 体に持たせると文脈が文書の総量まで膨らむ。AUDITORS の注記）。
      for (const d of auditable) tasks.push({ auditor, target: d.key, docs: [d] })
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
        effort: task.auditor.effort,
        schema: AUDIT_SCHEMA,
        phase: 'Audit',
        label: `${task.auditor.name}-${task.target}-r${revisions}${attempt > 1 ? `-retry${attempt - 1}` : ''}`,
      }).then((result) => ({ auditor: task.auditor.name, target: task.target, plan: task.readPlan, result: result || null })),
    (r) => r && r.result
  )

  const received = wrapped.filter(Boolean)
  for (const r of received) recordLocator(r)
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
      if (r.target === 'ALL') {
        docKey = pathToKey.get(finding.document) || (docKeys.has(finding.document) ? finding.document : null)
      }
      const routed = { auditor: r.auditor, ...finding, document: docKey, unroutable: !docKey }
      byName[r.auditor].failed.push(routed)
      allFailed.push(routed)
      if (r.auditor === 'executability') execFindings.push(routed)
    }
  }

  // (kaizen A-3) スコープの強制: スコープ監査のラウンドでは、範囲外への agent 指摘を
  // コード側で落とす。buildScopeNote は「範囲外は起票しない」と頼むだけで、遵守は auditor の
  // 注意に依存していた（範囲外起票を除外するコードは存在しなかった）。範囲外指摘が novelty に
  // 入ると、改稿対象が収束しても監査面の別の場所から新規が湧き続け、乾き停止に到達できない。
  // 落とした指摘は捨て置きにならない — 乾き停止後の終端網羅監査が全範囲を 1 回見る。
  // 判定は document 一致 + 正規化 location の包含（どちらかが空なら document 一致のみで通す。
  // 曖昧なら in-scope 側へ倒す = 指摘を落とす側を fail-closed にしない）。
  if (lastRevisionFindings && lastRevisionFindings.length) {
    const scopeRanges = lastRevisionFindings
      .filter((f) => f && f.document)
      .map((f) => ({ doc: f.document, loc: normalizeLocation(f.location) }))
    const inScope = (f) => {
      const fLoc = normalizeLocation(f.location)
      return scopeRanges.some(
        (s) => s.doc === f.document && (!s.loc || !fLoc || fLoc.includes(s.loc) || s.loc.includes(fLoc))
      )
    }
    const before = allFailed.length
    const outOfScope = allFailed.filter((f) => !f.unroutable && !inScope(f))
    if (outOfScope.length) {
      const oosDigests = new Set(outOfScope.map((f) => findingDigest(f)))
      allFailed = allFailed.filter((f) => f.unroutable || !oosDigests.has(findingDigest(f)))
      log(
        `スコープ強制 (r${revisions}): 範囲外の agent 指摘 ${outOfScope.length} 件（全 ${before} 件中）を` +
          '今ラウンドの改稿・novelty 対象から除外しました（終端の網羅監査が全範囲を確認します）。'
      )
    }
  }

  // 構造検査は auditor の応答有無と無関係に必ず走る。集合差分と禁止語の混入は agent が
  // 落ちても検出される（この 2 つがこのスキルの契約そのものだから）。本文を読む算術なので、
  // 直前の改稿（または入口）で checker が doc_check.mjs を実行した結果を使う。
  const structResult = structuralOf(lastCheck)

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
      // draft.js の構造検査は {id, text} 形で届く。issue へ正規化しないと、下流の
      // ladderToTbd / findingDigest が f.issue を読んで undefined を TBD 本文に落とす（実測）。
      allFailed.push({ ...f, issue: f.issue || f.text || '', auditor: f.auditor || 'structural', from_draft: true })
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
        '改稿ループを停止し、resolver → resolver-verifier のバッチ処理（1 回きり）へ回します。'
    )
    break
  }

  // スコープの梯子: writer に渡す前に専任 judge が failure kind で 4 分類する。
  // artifact / criteria だけを改稿ループへ流す。premise / question は改稿予算を消費させず、
  // 即座に blocking TBD（TBD-NI-）へ起票して needs_input 側に集める。
  // (kaizen A-2) 分類は novelty 計算より先に行う。従来は novelty → ladder の順だったため、
  // needs_input（人間ゲート行き）に初分類される指摘まで novelty に計上され、writer が
  // 何を改稿しようと乾かない成分が混ざっていた（乾き判定の対象は「改稿ループがまだ
  // 学んでいる指摘」だけであるべきで、ゲート行きの指摘は novelty ではなく TBD 側で数える）。
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

  // 乾き停止: このラウンドの指摘（needs_input 除外後）のうち、前ラウンドまでに見た digest
  // 集合に無い新規指摘の件数（novelty）を算出する。novelty 0 のラウンドが出たら、改稿予算が
  // 残っていても改稿ループを抜けて終端（網羅監査→裁定）へ進む。停止は証拠側（乾き）に置き、
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
      `stuck 指摘 ${stuckFindings.length} 件を通常改稿から外しました（resolver のバッチ処理で一括処理します）。` +
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
          effort: task.auditor.effort,
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
        if (r.target === 'ALL') {
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
    const structResult = structuralOf(lastCheck)
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

// ------------------------------------------- 監査 1 パスの再利用ヘルパ（resolver 後の再監査・終端網羅監査用）
//
// 主ループの発行規約（consistency は 2 文書未満で未実施 / traceability は requirements 無しで
// 未実施 / runWithRetry の部分リトライ）をそのまま踏襲する。byName（観点別サマリ）は
// 触らない — 実施した最後の全周監査の結果を保持する規約を、範囲限定パスで上書きしないため。
async function runAuditPass(label, auditorNames, scopeNote) {
  const auditable = documents.filter((d) => !d.fixed)
  const { deferred } = reconcileCategories(documents, requiredCategories)
  const tasks = []
  for (const auditor of AUDITORS.filter((a) => !auditorNames || auditorNames.has(a.name))) {
    // specimen は文書ごとに 1 体。標本が無ければ skip（specimen_skipped として返す）。
    if (auditor.name === 'specimen') {
      if (specimenSkipped) continue
      for (const d of auditable) tasks.push({ auditor, target: d.key, docs: [d] })
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
        effort: task.auditor.effort,
        schema: AUDIT_SCHEMA,
        phase: 'Audit',
        label: `${task.auditor.name}-${task.target}-${label.replace(/\s+/g, '-')}${attempt > 1 ? `-retry${attempt - 1}` : ''}`,
      }).then((result) => ({ auditor: task.auditor.name, target: task.target, plan: task.readPlan, result: result || null })),
    (r) => r && r.result
  )
  const received = wrapped.filter(Boolean).filter((r) => r.result)
  for (const r of received) recordLocator(r)
  const docKeys = new Set(documents.map((d) => d.key))
  const pathToKey = new Map(documents.map((d) => [d.path, d.key]))
  const findings = []
  for (const r of received) {
    for (const finding of r.result.failed || []) {
      let docKey = r.target
      if (r.target === 'ALL') {
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

// ------------------------------------------- resolver（生成）→ resolver-verifier（検証）の 2 段
//
// 解消候補の起草は生成側（resolver）の責務であり、その候補は検証側（resolver-verifier）を
// 通ってから writer に渡る — 1 role = 1 責務（schemas/role-map.md）。旧・多角化 escalation
// （3 レンズ並列の解消案）はレンズを resolver の起草観点として吸収した。「指摘が偽である論証」
// （counterexample レンズの真偽判定兼務）は resolver から外し、「反例が構成できない事実の報告」
// までに留める（真偽の裁定は adjudicator の領分）。
// 使い所は 2 つ: (1) stuck 指摘のバッチ処理（1 回きり）、(2) precedent-judge が resolvable と
// 分類した TBD の解消文の起草。

const RESOLVER_SCHEMA = {
  type: 'object',
  properties: {
    proposals: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          digest: { type: 'string' },
          options: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                summary: { type: 'string' },
                draft_text: { type: 'string' },
                tradeoff: { type: 'string' },
              },
              required: ['summary', 'tradeoff'],
            },
          },
          recommended: { type: 'number' },
        },
        required: ['digest', 'options'],
      },
    },
  },
  required: ['proposals'],
}

const VERIFIER_SCHEMA = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          digest: { type: 'string' },
          option_index: { type: 'number' },
          verdict: { type: 'string', enum: ['pass', 'reject'] },
          reason: { type: 'string' },
        },
        required: ['digest', 'option_index', 'verdict', 'reason'],
      },
    },
  },
  required: ['verdicts'],
}

// relevantBodies: 指摘の宛先の文書だけを、指摘の箇所に絞って読ませる。解消候補の起草・検証に要るのは
// 指摘の節とその前後であり、文書の通読ではない。
function relevantBodies(items) {
  const docKeys = new Set(items.map((f) => f.document).filter(Boolean))
  return (
    documents
      .filter((d) => docKeys.has(d.key))
      .map((d) => `## ${d.path}（key: ${d.key} / ${d.concern}）\n\n${indexInstruction(d)}`)
      .join('\n\n---\n\n') || '(本文なし)'
  ) + FINDING_READ_NOTE
}

// FINDING_READ_NOTE: 指摘を起点に本文を読ませる手順。quote の完全一致で行を特定し、その節だけを読む。
const FINDING_READ_NOTE =
  '\n\n各指摘の箇所は、quote（無ければ location の ID・見出し）を Grep（固定文字列・行番号付き）で document の本文から探し、' +
  `その行を含む節だけを索引の行範囲で ${READ_CHUNK_LINES} 行以内の offset/limit で Read する。文書を通読しない。`

function buildResolverPrompt(items) {
  return [
    roleHeader(SKILL_DIR, ['resolver.md'], 'resolver'),
    RULES,
    '',
    buildContextBlock('resolver'),
    '',
    '# [FINDINGS] 解消候補を起草する対象（digest は照合キー。書き換えない）',
    JSON.stringify(
      items.map(({ digest, auditor, document, location, quote, issue, direction, direction_note, severity, text }) => ({
        digest, auditor, document, location, quote, issue: issue || text, direction, direction_note, severity,
      })),
      null,
      2
    ),
    '',
    '# [DOCUMENTS] 当該文書の現本文（候補はここからの差分として意味を持つ）',
    relevantBodies(items),
    '',
    'proposals に digest ごとの options（summary / draft_text? / tradeoff）を返す。',
    '候補は根拠原本の範囲内で組む。指摘の真偽は裁定しない — 反例が構成できないときは、その事実の',
    '報告に留める。',
  ].join('\n')
}

function buildVerifierPrompt(items, proposals) {
  return [
    roleHeader(SKILL_DIR, ['resolver-verifier.md'], 'resolver-verifier'),
    '',
    buildContextBlock('auditor'),
    '',
    '# [FINDINGS] 候補の対象になった指摘（direction との整合の物差し）',
    JSON.stringify(
      items.map(({ digest, document, location, issue, direction, direction_note, text }) => ({
        digest, document, location, issue: issue || text, direction, direction_note,
      })),
      null,
      2
    ),
    '',
    '# [PROPOSALS] 検証対象の候補（digest × option_index 単位で全件判定する）',
    JSON.stringify(proposals, null, 2),
    '',
    '# [DOCUMENTS] 当該文書の現本文（捏造判定の原本の一部）',
    relevantBodies(items),
    '',
    'verdicts に { digest, option_index, verdict, reason } を全候補分返す。判定条件は',
    '(a) decisions と矛盾しない (b) 原本に無い事実を捏造していない (c) direction と整合する。',
    '候補の書き直しはしない。',
  ].join('\n')
}

// runResolveCandidates: resolver → resolver-verifier の 2 段を実行し、検証を通過した候補だけを
// digest → options[] の Map で返す。reject された候補・判定の無い候補は writer に渡さない
// （fail-closed。検証されていない文案を成果物経路に入れない）。
async function runResolveCandidates(items, label) {
  const out = new Map()
  if (!items.length) return out
  const res = await agent(buildResolverPrompt(items), {
    ...ROLE_OPTS.resolver,
    schema: RESOLVER_SCHEMA,
    phase: 'Revise',
    label: `resolver-${label}`,
  })
  const proposals = (((res || {}).proposals) || []).filter(
    (p) => p && p.digest && Array.isArray(p.options) && p.options.length
  )
  if (!proposals.length) {
    log(`resolver (${label}): 候補が返りませんでした（0 件として続行します）。`)
    return out
  }
  const ver = await agent(buildVerifierPrompt(items, proposals), {
    ...ROLE_OPTS.resolverVerifier,
    schema: VERIFIER_SCHEMA,
    phase: 'Revise',
    label: `resolver-verifier-${label}`,
  })
  const passed = new Set(
    (((ver || {}).verdicts) || [])
      .filter((v) => v && v.verdict === 'pass' && v.digest && Number.isInteger(v.option_index))
      .map((v) => `${v.digest}#${v.option_index}`)
  )
  let rejected = 0
  for (const p of proposals) {
    const options = p.options
      .map((o, i) => ({ ...o, option_index: i, recommended: p.recommended === i }))
      .filter((o) => {
        const ok = passed.has(`${p.digest}#${o.option_index}`)
        if (!ok) rejected++
        return ok
      })
    if (options.length) out.set(p.digest, options)
  }
  log(
    `resolver (${label}): 候補 ${proposals.reduce((n, p) => n + p.options.length, 0)} 件のうち ` +
      `検証通過 ${[...out.values()].reduce((n, o) => n + o.length, 0)} 件 / 不通過（reject または判定なし） ${rejected} 件。` +
      '不通過の候補は writer に渡しません。'
  )
  return out
}

// formatOptions: 検証済み候補を writer / TBD candidates 向けの 1 行表現に整形する。
// digest 参照を先頭に付け、どの指摘への候補かを機械で辿れるようにする。
const formatOptions = (digest, options) =>
  options.map(
    (o) =>
      `[${digest}#${o.option_index}]${o.recommended ? '（推奨）' : ''} ${o.summary}` +
      `${o.draft_text ? ` / 文案: ${o.draft_text}` : ''}（トレードオフ: ${o.tradeoff}）`
  )

let unanswerable = []
{
  // 矛盾解消パスで解消済みの stuck は外す（digest が allFailed に残っているものだけが対象）。
  const stillStuck = stuckFindings.filter((s) => allFailed.some((g) => findingDigest(g) === s.digest))
  if (stillStuck.length) {
    phase('Revise')
    log(
      `stuck 指摘 ${stillStuck.length} 件に対し、resolver → resolver-verifier の 2 段をバッチで 1 回だけ行います` +
        '（候補の起草 → 検証 → writer 最終改稿 → スコープ再監査）。'
    )
    const verified = await runResolveCandidates(stillStuck, `stuck-r${revisions + 1}`)
    revisions++
    const revisionId = `R${outerRound}.${revisions}`
    revisionLog.push({
      revision_id: revisionId,
      trigger: [...new Set(stillStuck.map((f) => f.id))].slice(0, 50),
      reason: `stuck 指摘 ${stillStuck.length} 件の resolver 候補付き最終改稿（バッチ 1 回きり）`,
      changed_by: '監査指摘の解消',
      resolver_pass: true,
    })
    const byDoc = new Map()
    for (const f of stillStuck) {
      if (!f.document) continue
      const options = verified.get(f.digest) || []
      if (!byDoc.has(f.document)) byDoc.set(f.document, [])
      byDoc.get(f.document).push({
        ...f,
        resolver_proposals: formatOptions(f.digest, options),
      })
    }
    await reviseDocuments(byDoc, revisionId, false)

    // 再監査は stuck を起票した観点だけ・当該範囲だけ（スコープ監査）。
    const names = new Set(stillStuck.map((f) => f.auditor).filter((n) => n && n !== 'structural'))
    log(
      'スコープ監査の対象範囲（resolver 後の再監査）: ' +
        [...new Set(stillStuck.map((f) => `${f.document}:${f.location || ''}`))].join(' / ')
    )
    const re = names.size
      ? await runAuditPass(`Audit resolver r${revisions}`, names, buildScopeNote(stillStuck))
      : { findings: [], missing: [] }
    missing = [...missing, ...re.missing]

    // 構造検査と TBD の正規化は算術なので、改稿のたびに必ず再計算する（このスキルの契約）。
    const structResult = structuralOf(lastCheck)
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
      // resolver 候補付き改稿の後も digest 不変で残った指摘は unanswerable（従来の unresolved と区別する）
      if (stuckDigests.has(findingDigest(f))) unanswerable.push({ ...f, digest: findingDigest(f) })
    }
    for (const f of structural) if (!fixedKeys.has(f.document)) allFailed.push(f)
    log(
      unanswerable.length
        ? `resolver 候補付き改稿の後も ${unanswerable.length} 件が同一 digest のまま残りました。unanswerable として明示して終了します。`
        : 'resolver 候補付き改稿で stuck 指摘はすべて digest が変化しました（解消または再定式化）。'
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
          // text（転記文の文案）は廃止した。裁定者は判定（転記先と理由）までを返し、
          // 転記文の起草は転記改稿時の writer が reason + direction から行う
          // （検証されない文案を本文へ直行させない — schemas/role-map.md）。
          reason: { type: 'string' },
        },
        required: ['digest', 'target_document', 'reason'],
      },
    },
  },
  required: ['fixed', 'rejected', 'documented'],
}

function buildAdjudicationPrompt(remaining) {
  return [
    'あなたは終端裁定（adjudication）の裁定者である。改稿ループ終了時に残った監査指摘の全件を、',
    '次の三値のいずれかに分類する。未裁定のまま残す指摘があってはならない（全件をどれかに入れる）。',
    INLINE_SCOPE,
    '',
    '- fixed: 実は既に解消済み・誤残留である。現在の本文を確認し、解消している根拠を evidence に書く。',
    '- rejected: 偽指摘である。reason 必須（理由の無い棄却は無効として未裁定に戻される）。',
    '- documented: 意図した制約であり、かつ現在の本文の規範からは読み取れない。本文の既存規範から既に読み取れるなら fixed にする。転記先を target_document（文書キーまたはパス）と',
    '  target_section に、なぜ意図した制約と言えるかを reason に書く。**転記文の文案は書かない** —',
    '  文案の起草は転記改稿時の writer の責務である（あなたが書いた文は誰にも検証されずに本文へ',
    '  入ることになる）。',
    '',
    RULES,
    '',
    buildContextBlock('adjudicator'),
    '',
    '# [REMAINING_FINDINGS] 裁定対象（digest で照合される。digest を書き換えない）',
    JSON.stringify(remaining, null, 2),
    '',
    // 全文書の通読はさせない。裁定に要るのは各指摘の箇所の現状だけである（fixed の根拠も
    // rejected の理由も、その節を読めば書ける）。
    '# [DOCUMENTS] 現在の文書（指摘の箇所だけを読む）',
    documents
      .map((d) => `## ${d.path}（key: ${d.key} / ${d.concern}）${d.fixed ? '【このランの対象外・変更不可】' : ''}\n\n${indexInstruction(d)}`)
      .join('\n\n---\n\n') + FINDING_READ_NOTE,
  ].join('\n')
}

let adjudication = { fixed: [], rejected: [], documented: [], unadjudicated: [] }
let adjudicationRemaining = []
{
  const seen = new Set()
  const remaining = adjudicationRemaining
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
      ...ROLE_OPTS.adjudicator,
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
        // 転記文はここに無い。writer が reason + direction（と、あれば resolver 候補）から
        // 起草する — 裁定者の文案を検証なしで本文へ直行させない（schemas/role-map.md）。
        byDoc.get(doc.key).push({
          auditor: 'adjudication',
          id: `ADJ-${e.digest}`,
          document: doc.key,
          location: e.target_section || '検査範囲の限定',
          issue:
            '終端裁定で「意図した制約（documented）」と分類された。裁定の理由: ' +
            `${e.reason}。この制約が意図したものであることを該当節へ規範文として転記する（文案はあなたが起草する）。既存の規範文の適用範囲を限定する書き換えで表せるなら、新しい文を足さずにそちらを採る。`,
          direction: 'document_decision',
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
        const structResult = structuralOf(lastCheck)
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

// 未確定事項の集計。段 3（計測解消）と段 4（保持規則への変換）は本文と TBD 申告を書き換える
// ので、集計は関数にして反映の前後で 2 回走らせる。式を 2 箇所に書き分けると、反映後の件数
// だけが古い式で出て「解消したのに残っている」「残っているのに 0 件」が起きる。
let tbdItems = []
let resolvedTbdIds = []
let blockingTbd = []
// settled: 判定パイプラインが決着させた TBD の ID。**再集計から差し引くために要る。**
// tbd_items は毎回ゼロから組み直され、script 起票分（TBD-EX- / TBD-NI-）は writer の申告に
// 関係なく再投入される。差し引かないと、本文には解消文や保持規則が入っているのに返り値では
// 未解決のまま残り、文書の実体と提示内容が食い違う（この乖離こそ在ラン解消の目的である）。
const settled = new Set()
// unpresented_blocking: blocking かつ「まだ人間に提示していない」TBD。「聞かれもせずに残った
// blocking」を可視化する唯一の算出地点であり、SKILL.md 側はこの配列の length を見るだけで
// 同じ式を再実装しない。
//
// 判定を ID だけで行うと偽陰性が出る。改稿で TBD-AUTH-003 が別の論点に振り直されると、
// 古い 003 を提示した記録が新しい論点に流用され、聞いていないのに「提示済み」になる。
// そこで内容の digest も併せて照合する（id が一致しても中身が変わっていれば未提示扱い）。
let unpresentedBlocking = []
const recomputeTbd = () => {
  // 現ラウンドの申告を正として組み直す（前回分は owner/due などのメタデータ供給元）。
  // 無条件マージにすると解決した TBD が消えず、「あと N 個」の N が永遠に減らない。
  // spread して渡すのは、currentLists.flat() が 1 段しか平坦化しないため。
  // [documents.map(...), execTbd] と書くと documents 側が配列の配列のまま残り、
  // item.id が undefined になって**全件が黙って捨てられる**。捨てられた結果は
  // tbd_items 0 件・blocking 0 件となり、完成条件を無条件に成立させる。形を崩さないこと。
  const rebuilt = rebuildTbd(
    [...documents.map((d) => d.tbd_items), execToTbd(execFindings), needsInputTbd],
    inputTbdItems
  )
  tbdItems = rebuilt.current.filter((t) => !settled.has(t.id))
  resolvedTbdIds = [...rebuilt.resolved, ...[...settled].filter((id) => !tbdItems.some((t) => t.id === id))]
  blockingTbd = tbdItems.filter((t) => t.blocking)
  unpresentedBlocking = blockingTbd.filter((t) => {
    const rec = presentedById.get(t.id)
    if (!rec) return true
    if (!rec.digest) return false // 旧形式（ID のみ）で渡された場合は従来どおり提示済みとみなす
    return rec.digest !== stableKey(String(t.text || ''))
  })
}
recomputeTbd()

// (kaizen C3) 計装: unpresented_blocking の帰属判定に要る内訳を返り値へ emit する。
// telemetry の unpresented_blocking_count は段 3 時点の gate 件数しか持たず、「未提示 blocking
// が残る」という観測が自動解消の不発・起票の過剰・ID 振り直し churn・再入経路の不成立の
// どれとも整合してしまい帰属が決まらない（kaizen 第 3 サイクルの plan-verifier 実測）。
// 全キーを null で先置きし、実行されなかった段は「欠測」ではなく明示的 null（該当なし）で残す。
// 変更は純加算に限る（既存の条件式・代入・agent プロンプトに触れない — これが「計装は run の
// 挙動を変えない」という control 前提の機械判定条件になる）。
const instr = {
  entry_outer_round: outerRound,
  entry_presented_count: presentedById.size,
  stage2_input_count: null,
  origin_breakdown: null,
  stage_verdicts: null,
  pj_returned_count: null,
  classified_count: null,
  measurable_dropped_no_target: null,
  precedent_ids_counts: null,
  measurement_accepted: null,
  measurement_evidence_counts: null,
  gate_blocking_count: null,
  terminal_unpresented_count: null,
  terminal_unpresented_no_record: null,
  terminal_unpresented_digest_mismatch: null,
  terminal_unpresented_new_or_renamed: null,
  attribution: null,
}
// (kaizen C4) 帰属観測の集約。counters は records から再計算する（呼び出し 1 回分の counters を
// 使い回さない）。exposure = unattributed + too_short + no_trace（matched / recorded_only を
// 含めない）で、次サイクルの exposure × fab 裁定の突合の分子。
{
  const cnt = (c) => attributionRecords.filter((r) => r.classification === c).length
  instr.attribution = {
    mode: 'observe',
    records: attributionRecords,
    counters: {
      added_total: attributionRecords.length,
      matched: cnt('matched'),
      unattributed: cnt('unattributed'),
      too_short: cnt('too_short'),
      no_trace: cnt('no_trace'),
      kind_escape: cnt('recorded_only'),
      kind_escape_shielded: attributionRecords.filter((r) => r.shielded).length,
      exposure: cnt('unattributed') + cnt('too_short') + cnt('no_trace'),
    },
  }
}
instr.stage2_input_count = unpresentedBlocking.length
instr.origin_breakdown = {
  tbd_ex: unpresentedBlocking.filter((t) => String(t.id).startsWith('TBD-EX-')).length,
  tbd_ni: unpresentedBlocking.filter((t) => String(t.id).startsWith('TBD-NI-')).length,
  writer_declared: unpresentedBlocking.filter(
    (t) => !String(t.id).startsWith('TBD-EX-') && !String(t.id).startsWith('TBD-NI-')
  ).length,
}
const instrEntryBlockingIds = new Set(blockingTbd.map((t) => t.id))

// ------------------------------------------------ 人間必要性の判定パイプライン（段 2〜4）
//
// 段 1（ladder-judge）は改稿ループの中にある。ここは残った未確定事項を、人間に聞く前に
// 「聞かなくても決まるもの」から順に落とす経路である。同型の質問を毎回返すと、ゲートは
// 推奨を選ぶだけの承認ボタンになり、本当に人間にしか決められない項目がその中に埋もれる
// （実測: 第 2 波統合ゲートで 4 問すべてが第 1 波裁定の同型だった）。
//
//   段 2 先例裁定  … 既裁定と同型か（decidable なら裁定して反映）
//   段 3 計測解消  … リポジトリを読めば事実が確定するか（resolvable なら計測して反映）
//   段 4 保持規則  … 依頼者に提示済みでなお決まらないものを規範文へ変換し、作業項目を起票
//
// 段 2・3 は迷ったら人間ゲートへ倒す。自動裁定の偽陽性は依頼者の決定を勝手に置き換える
// 事故であり、余計に聞く偽陰性より重い。judge が応答しなければ全件がゲート行きになる。
const PRECEDENT_SCHEMA = {
  type: 'object',
  properties: {
    classifications: {
      type: 'array',
      items: {
        type: 'object',
        required: ['tbd_id', 'verdict', 'rationale'],
        properties: {
          tbd_id: { type: 'string' },
          verdict: {
            type: 'string',
            enum: ['resolvable', 'internal', 'measurable', 'novel', 'conflict', 'irreversible'],
          },
          precedent_ids: { type: 'array', items: { type: 'string' } },
          // cited: internal のとき、食い違っている（または集合を閉じる材料を持つ）項目の ID。
          // 挙げられないなら internal ではない（script は cited の空な internal を採らない）。
          cited: { type: 'array', items: { type: 'string' } },
          // proposed_resolution は廃止した。judge は判定（verdict / precedent_ids）だけを返し、
          // resolvable の解消文の起草は resolver（生成側）→ resolver-verifier（検証）が担う
          // （1 role = 1 責務。schemas/role-map.md）。
          // measurement_target: measurable のときに「何を読めば決まるか」を書く。
          // 書けないなら、それは計測ではなく推測なので novel に落ちる。
          measurement_target: { type: 'string' },
          rationale: { type: 'string' },
        },
      },
    },
  },
  required: ['classifications'],
}
let autoResolvedBlocking = []
let measurableBlocking = []
let gateBlocking = unpresentedBlocking
if (unpresentedBlocking.length) {
  const pj = await agent(
    [
      'あなたは先例裁定係。未提示の blocking TBD それぞれについて、人間に聞く必要が本当に',
      'あるかを判定する。',
      INLINE_SCOPE,
      '',
      'verdict の基準:',
      '- resolvable: 決定ログ・回答・過去周回の回答履歴に同型の先例があり、その判断をそのまま',
      '  当てはめれば解消する（先例の ID を precedent_ids に書く。**解消文は書かない** —',
      '  起草は resolver の責務であり、あなたは判定だけを返す）。',
      '- internal: 問いがプロダクトの価値（何をすべきか・何を許すか・何を優先するか・続ける価値が',
      '  あるか）ではなく、文書の中の整合と閉包である。2 つの項目が同じ入力に違う振る舞いを定めている・',
      '  本文が参照する集合の要素が他の項目から決まる・表の組み合わせが欠けている、の類。食い違う項目の',
      '  ID を cited に書く（書けないなら internal にしない）。どちらに揃えるかは書き手が根拠（上位文書・',
      '  入力に辿れる側）から決めるので、人間に聞かない。ただし食い違いの両側がそれぞれ依頼者の入力に',
      '  辿れ、入力そのものが割れているなら、それはプロダクトの価値の判断であり internal ではない。',
      '- measurable: 依頼者の意図ではなく現物（リポジトリの実装・設定・既存文書）が答えを',
      '  持っており、読めば確定する（何を読めば決まるかを measurement_target に書く）。',
      '- novel: 先例が無い、または先例からの類推に飛躍がある。',
      '- conflict: 当てはまりうる先例が複数あり、互いに逆の判断を含む。',
      '- irreversible: 解消の内容が外部公開・データ削除など取り消しの難しい影響を持つ。',
      '',
      '迷ったら novel にする。resolvable / measurable の偽陽性は依頼者の決定を勝手に置き換える',
      '事故であり、余計に質問する（偽陰性）より重い。「推奨が自明」は先例ではない — 判断の型が',
      '先例と一致するときだけ resolvable にする。「たぶんコードにあるはず」も計測ではない —',
      '読む対象を名指しできるときだけ measurable にする。',
      '',
      'ただし「規範文書に書かれていない」ことを理由に novel にしてはならない。正本の文書に',
      '定義が無いことと、現物に答えが無いことは別である。システムが現にその値を出している',
      'なら、算式・境界・語彙・書式の答えはコードにあり measurable である（実測: 安全余裕の',
      '算式・割引率の導出・乖離率の分子が「財務計算ルールに無い」という理由で novel に落ち、',
      '実装を読めば全件確定するものが人間ゲートへ回った）。novel にしてよいのは、現物にも',
      '答えが無い（まだ作られていない挙動）か、現物に複数の答えがあってどれを採るかが依頼者の',
      '意図に属するときだけである。',
      '',
      `# [DECISIONS]\n${JSON.stringify(decisions, null, 1)}`,
      `# [ANSWERS]\n${answers}`,
      `# [TBD_ANSWERS_HISTORY]\n${JSON.stringify(tbdAnswersHistory, null, 1)}`,
      `# [UNPRESENTED_BLOCKING]\n${JSON.stringify(
        unpresentedBlocking.map(({ id, text, document }) => ({ id, text, document })),
        null,
        1
      )}`,
    ].join('\n'),
    { ...ROLE_OPTS.precedentJudge, schema: PRECEDENT_SCHEMA, phase: 'Finalize', label: 'precedent-judge' }
  )
  const pjById = new Map(
    (((pj || {}).classifications) || []).filter((c) => c && c.tbd_id).map((c) => [c.tbd_id, c])
  )
  const withVerdict = (v) =>
    unpresentedBlocking
      .filter((t) => (pjById.get(t.id) || {}).verdict === v)
      .map((t) => {
        const c = pjById.get(t.id)
        return {
          ...t,
          precedent_ids: c.precedent_ids || [],
          cited: Array.isArray(c.cited) ? c.cited : [],
          measurement_target: c.measurement_target || '',
          rationale: c.rationale || '',
        }
      })
  // resolvable の解消文は resolver（生成側）が起草し、resolver-verifier の検証を通す
  // （judge の proposed_resolution は廃止 — 判定係の文案は誰にも検証されずに本文へ直行していた）。
  // 検証済みの文案（draft_text）を得られなかった項目は自動解消しない — 文案の無い「解消」は
  // 申告だけが残って本文に反映できないため、人間ゲートへ返す。
  const resolvableCandidates = withVerdict('resolvable')
  autoResolvedBlocking = []
  if (resolvableCandidates.length) {
    const items = resolvableCandidates.map((t) => ({
      digest: t.id,
      document: t.document,
      location: t.location || '',
      issue: t.text,
      direction: 'document_decision',
      direction_note: `先例 ${(t.precedent_ids || []).join(' / ') || '(ID なし)'} の当てはめ`,
    }))
    const verified = await runResolveCandidates(items, 'precedent')
    for (const t of resolvableCandidates) {
      const options = verified.get(t.id) || []
      const pick = options.find((o) => o.recommended && o.draft_text) || options.find((o) => o.draft_text)
      if (!pick) continue
      autoResolvedBlocking.push({
        ...t,
        proposed_resolution: pick.draft_text,
        // 解消候補は candidates に digest 参照付きで残す（text には混ぜない）。
        candidates: formatOptions(t.id, options),
      })
    }
    const droppedToGate = resolvableCandidates.length - autoResolvedBlocking.length
    if (droppedToGate) {
      log(
        `先例裁定: resolvable ${resolvableCandidates.length} 件のうち ${droppedToGate} 件は検証済みの解消文を` +
          '得られなかったため自動解消せず、人間ゲートへ返します。'
      )
    }
  }
  // internal: 文書内の整合・閉包の欠陥。人間ではなく書き手が揃える。解消文は resolver が cited の項目を
  // 突き合わせて起草し、resolver-verifier を通ったものだけを同じラン内で本文へ反映する（resolvable と同じ経路）。
  // cited の無い internal は、何と何が食い違うかを名指しできていないので採らない（ゲートへ返す）。
  const internalCandidates = withVerdict('internal').filter((t) => t.cited.length)
  if (internalCandidates.length) {
    const items = internalCandidates.map((t) => ({
      digest: t.id,
      document: t.document,
      location: t.location || '',
      issue: t.text,
      direction: 'align_terms',
      direction_note: `文書内の整合: ${t.cited.join(' / ')} を突き合わせ、根拠が上位文書・入力に辿れる側に揃える`,
    }))
    const verified = await runResolveCandidates(items, 'internal')
    let resolvedInternal = 0
    for (const t of internalCandidates) {
      const options = verified.get(t.id) || []
      const pick = options.find((o) => o.recommended && o.draft_text) || options.find((o) => o.draft_text)
      if (!pick) continue
      resolvedInternal++
      autoResolvedBlocking.push({ ...t, resolved_as: 'internal', proposed_resolution: pick.draft_text, candidates: formatOptions(t.id, options) })
    }
    if (resolvedInternal < internalCandidates.length) {
      log(
        `文書内整合: internal ${internalCandidates.length} 件のうち ${internalCandidates.length - resolvedInternal} 件は検証済みの` +
          '解消文を得られなかったため、人間ゲートへ返します。'
      )
    }
  }
  // 読む対象を名指しできない measurable は計測ではなく推測なので、ゲートへ返す。
  measurableBlocking = withVerdict('measurable').filter((t) => t.measurement_target)
  const handled = new Set([...autoResolvedBlocking, ...measurableBlocking].map((t) => t.id))
  gateBlocking = unpresentedBlocking.filter((t) => !handled.has(t.id))
  log(
    `先例裁定: 未提示 blocking ${unpresentedBlocking.length} 件のうち、先例で解消 ${autoResolvedBlocking.length} 件 / ` +
      `計測で解消可能 ${measurableBlocking.length} 件 / 人間ゲート行き ${gateBlocking.length} 件。`
  )
  // (kaizen C3) 段 2 の内訳。novel への落ちすぎ（機序 b）を読む分子は pjById（judge が実際に
  // 返した分）であり、分母には classified_count を使う — judge の無応答・部分応答は
  // 「novel が多い」ではなく「未分類が多い」として別枠で見える必要がある。
  instr.pj_returned_count = (((pj || {}).classifications) || []).length
  instr.classified_count = unpresentedBlocking.filter((t) => pjById.has(t.id)).length
  instr.stage_verdicts = { resolvable: 0, internal: 0, measurable: 0, novel: 0, conflict: 0, irreversible: 0 }
  for (const c of pjById.values()) {
    if (instr.stage_verdicts[c.verdict] !== undefined) instr.stage_verdicts[c.verdict] += 1
  }
  instr.measurable_dropped_no_target = withVerdict('measurable').length - measurableBlocking.length
  instr.precedent_ids_counts = autoResolvedBlocking.filter((t) => t.resolved_as !== 'internal').map((t) => (t.precedent_ids || []).length)
}

// 段 3: 計測解消。measurement agent はリポジトリを Read して事実を確定する係であり、
// 「確定できなかった」を返せる。返せない設計にすると、もっともらしいコードから事実を
// 推論して埋める — このスキルが防ぐと宣言した失敗（要求の捏造）そのものになる。
// 証拠（file / quote）の無い解消は採らない。証拠なしの断定は計測ではなく推測である。
const MEASUREMENT_SCHEMA = {
  type: 'object',
  properties: {
    resolutions: {
      type: 'array',
      items: {
        type: 'object',
        // statement は resolved: true のときに本文へ反映する確定文そのもの。schema で必須に
        // しないと agent は reason に結論を書いて statement を空にし、受理条件（statement 必須）
        // で証拠付きの確定が黙って落ちる（実測: 6 件の evidence 付き resolved が 0 件に化けた）。
        required: ['tbd_id', 'resolved', 'reason', 'statement'],
        properties: {
          tbd_id: { type: 'string' },
          resolved: { type: 'boolean' },
          statement: { type: 'string' },
          evidence: {
            type: 'array',
            items: {
              type: 'object',
              required: ['file', 'quote'],
              properties: {
                file: { type: 'string' },
                line: { type: 'number' },
                quote: { type: 'string' },
              },
            },
          },
          reason: { type: 'string' },
        },
      },
    },
  },
  required: ['resolutions'],
}
let resolvedByMeasurement = []
if (measurableBlocking.length) {
  const mm = await agent(
    [
      roleHeader(SKILL_DIR, ['measurement.md'], 'measurement'),
      // 読む対象を項目ごとの measurement_target に限る。問いの答えは依頼元の現物にあり、このスキルの
      // 実装（SKILL_DIR 配下）には無い — そこを読んで「run の仕組み」を理解しても、どの項目も確定しない。
      '読む対象: 各項目の measurement_target が名指しする現物（依頼元のリポジトリの実装・設定・既存文書）と、',
      'それを探すための Grep / Glob だけ。' + `${SKILL_DIR} 配下（このスキル自身）は測定対象ではないので読まない。`,
      'measurement_target で見つからなければ、周辺を広く読み回らず resolved: false で返す。',
      '',
      'statement は全項目で必須フィールドである。resolved: false の項目では空文字 "" を返す',
      '（省略すると返答全体が schema 不合格になり、同梱の確定分まで受理されない）。',
      'resolved: true の項目では本文へ反映する確定文そのものを書く。',
      '',
      '# [ITEMS] 計測で解消しうる未確定事項',
      JSON.stringify(
        measurableBlocking.map(({ id, text, document, measurement_target }) => ({
          id,
          text,
          document,
          measurement_target,
        })),
        null,
        1
      ),
    ].join('\n'),
    { ...ROLE_OPTS.measurement, schema: MEASUREMENT_SCHEMA, phase: 'Finalize', label: 'measurement' }
  )
  const byId = new Map(
    (((mm || {}).resolutions) || []).filter((r) => r && r.tbd_id).map((r) => [r.tbd_id, r])
  )
  resolvedByMeasurement = measurableBlocking
    .map((t) => ({ item: t, r: byId.get(t.id) }))
    .filter(({ r }) => r && r.resolved && String(r.statement || '').trim() && (r.evidence || []).length)
    .map(({ item, r }) => ({
      ...item,
      proposed_resolution: r.statement,
      evidence: r.evidence,
      rationale: r.reason || '',
    }))
  const resolvedIds = new Set(resolvedByMeasurement.map((t) => t.id))
  for (const t of measurableBlocking) {
    const r = byId.get(t.id)
    if (r && r.resolved && !resolvedIds.has(t.id)) {
      log(
        `計測解消: ${t.id} は resolved: true だが受理条件を満たさない（statement 空: ${!String(r.statement || '').trim()} / evidence 無し: ${!(r.evidence || []).length}）。ゲートへ戻します。`
      )
    }
  }
  // 計測できなかった分はゲートへ戻す（黙って消さない）。
  gateBlocking = [...gateBlocking, ...measurableBlocking.filter((t) => !resolvedIds.has(t.id))]
  log(
    `計測解消: ${measurableBlocking.length} 件のうち ${resolvedByMeasurement.length} 件を実測で確定し、` +
      `残り ${measurableBlocking.length - resolvedByMeasurement.length} 件は人間ゲートへ戻しました。`
  )
  // (kaizen C3) 段 3 の内訳。証拠件数は経路ごとに別キー（先例 = precedent_ids_counts、
  // 計測 = measurement_evidence_counts）で持ち、共通の has_evidence には潰さない
  // （「該当なし」を「証拠なし」に化けさせないため）。
  instr.measurement_accepted = resolvedByMeasurement.length
  instr.measurement_evidence_counts = resolvedByMeasurement.map((t) => (t.evidence || []).length)
}
// (kaizen C3) 段 3 確定後の gate 件数。summary.unpresented_blocking_count と同値のはずで、
// 一致しなければ計装か集計のどちらかが壊れている（適合監査の照合点）。
instr.gate_blocking_count = gateBlocking.length

// 段 4: 保持規則。既に提示したのに決まらない未確定事項は、聞き直しても決まらない（依頼者が
// 決めていないものは、何回聞いても決まらない）。そのまま TBD として残すと、次工程は
// 「決まっていない」とだけ書かれた項目を前にして、勝手に決めるか止まるかしかない。
// そこで「裁定が下るまで何をしてはならないか」という規範文（保持規則）へ変換して文書に置き、
// 裁定そのものは作業項目（work_items）として文書の外へ出す。これが完成条件を
// 「未提示 blocking 0」から「TBD 0」へ動かせる理由である。
const isPresented = (t) => {
  const rec = presentedById.get(t.id)
  if (!rec) return false
  if (rec.digest && rec.digest !== stableKey(String(t.text || ''))) return false
  return true
}
const holdingTargets = blockingTbd.filter(isPresented)
// 進行可能（blocking: false）な未確定事項には止めるべき進行が無いので、保持規則を書かない
// （書くと、実際には妨げていない規範が本文に増える）。決着は作業項目としてだけ出す。
const carryTargets = tbdItems.filter((t) => !t.blocking)
const holdingRules = holdingTargets.map((t) => ({
  id: `HR-${t.id}`,
  tbd_id: t.id,
  document: t.document || '',
  unresolved: t.text,
}))
// work_items: 保持規則で当面の被害は止まるが、裁定そのものは未了である。この一覧は
// **文書には書かない** — 司令塔が保存時に Issue 化する（規約は SKILL.md）。
const workItems = [...holdingTargets, ...carryTargets].map((t, i) => ({
  id: `WI-${String(i + 1).padStart(3, '0')}`,
  tbd_id: t.id,
  document: t.document || '',
  title: t.text,
  why: t.blocking
    ? `提示済みだが裁定が得られていない。保持規則 HR-${t.id} で当面の拡大は止めているが、裁定は未了である。`
    : '着手は止めないが未確定である。決まった時点で文書へ反映する。',
  candidates: t.candidates || [],
}))

// 段 2〜4 の結果を**同じラウンドのうちに**本文へ反映する。次周回に持ち越すと、未提示
// blocking が 0 件になった run では次周回そのものが起きず、解消したはずの記述が文書に
// 残ったまま「解消済み」として提示される（文書の実体と提示内容の乖離）。
const resolutionDirectives = new Map()
const pushDirective = (docKey, entry) => {
  if (!docKey) return
  if (!resolutionDirectives.has(docKey)) resolutionDirectives.set(docKey, [])
  resolutionDirectives.get(docKey).push(entry)
}
for (const t of [...autoResolvedBlocking, ...resolvedByMeasurement]) {
  pushDirective(t.document, {
    action: 'resolve',
    tbd_id: t.id,
    unresolved: t.text,
    resolution: t.proposed_resolution,
    source: t.evidence ? 'measurement' : t.resolved_as === 'internal' ? 'internal' : 'precedent',
    evidence: t.evidence || t.precedent_ids || [],
  })
}
for (const h of holdingRules) {
  pushDirective(h.document, {
    action: 'hold',
    tbd_id: h.tbd_id,
    unresolved: h.unresolved,
    holding_rule_id: h.id,
  })
}
for (const t of carryTargets) {
  pushDirective(t.document, { action: 'carry', tbd_id: t.id, unresolved: t.text })
}
if (resolutionDirectives.size) {
  const beforeMissing = new Set(writerMissing)
  writerDirectives = resolutionDirectives
  await reviseDocuments(new Map(), `R${outerRound}.resolve`, false)
  writerDirectives = new Map()
  // writer が応答しなかった文書の項目は決着していない。ここを区別せずに settled へ入れると、
  // **応答しなかった writer が TBD を黙って消す**経路になる（前稿のまま残っているのに解決扱い）。
  const failedDocs = new Set(
    writerMissing.filter((m) => !beforeMissing.has(m)).map((m) => String(m).split('@')[0])
  )
  for (const [docKey, entries] of resolutionDirectives) {
    if (failedDocs.has(docKey)) continue
    for (const e of entries) settled.add(e.tbd_id)
  }
  revisionLog.push({
    revision_id: `R${outerRound}.resolve`,
    trigger: ['先例裁定 / 計測解消 / 保持規則への変換'],
    reason: `解消 ${autoResolvedBlocking.length + resolvedByMeasurement.length} 件 / 保持規則 ${holdingRules.length} 件の反映`,
    changed_by: '人間必要性の判定パイプライン',
  })
  // 反映で本文と TBD 申告が変わったので、集計と構造検査を引き直す。引き直さないと、
  // 返り値は反映前の件数を報告する（解消した項目が残って見え、新たに入った本文が未検査になる）。
  const structResult = structuralOf(lastCheck)
  const { findings: tbdRenumbered, byKey: tbdByKey } = namespaceTbd(documents)
  for (const d of documents) d.tbd_items = tbdByKey[d.key] || []
  const { findings: catFindings } = reconcileCategories(documents, requiredCategories)
  structural = [...structResult.findings, ...catFindings, ...tbdRenumbered]
  structuralNotChecked = structResult.not_checked
  recomputeTbd()
}

// (kaizen C3) 終端内訳: resolve 反映と namespaceTbd の ID 振り直しを経た後の未提示 blocking
// を分解する（resolve ブロックが実行されなかった run でも無条件に算出する — 条件内だけに
// 置くと terminal_* が null になり「該当なし」と「未計測」が混ざる）。
// new_or_renamed は「入口 blocking の ID 集合に無い ID」で、ID 振り直し churn と resolve 改稿
// での新規申告が混成で入る。この計装では両者を分離できないため、名前で混成を明示する。
// 読み方: no_record ∧ ¬new_or_renamed は「入口から居たが一度も提示されなかった」を意味する
// （run 中に立った blocking は単発 run では提示できない — 再入経路の帰属に使う組合せ）。
instr.terminal_unpresented_count = unpresentedBlocking.length
instr.terminal_unpresented_no_record = unpresentedBlocking.filter(
  (t) => !presentedById.get(t.id)
).length
instr.terminal_unpresented_digest_mismatch = unpresentedBlocking.filter((t) => {
  const rec = presentedById.get(t.id)
  return Boolean(rec && rec.digest && rec.digest !== stableKey(String(t.text || '')))
}).length
instr.terminal_unpresented_new_or_renamed = unpresentedBlocking.filter(
  (t) => !instrEntryBlockingIds.has(t.id)
).length

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
// unanswerable_findings は「resolver のバッチ処理まで尽くしても digest 不変で残った」であり、従来の
// unresolved_findings（単に残った）と区別して黙らずに終える。
// blocking_over_capacity: 起票された blocking が人間ゲートの提示容量を超えている。
// 提示の工夫では吸収できず、超えた分は「未提示のまま完了」に直結するので、
// 起票側の較正失敗として返り値で申告する（別スクリプトの実行に委ねない）。
const blockingOverCapacity = blockingTbd.length > GATE_CAPACITY_PER_ROUND * MAX_GATE_ROUNDS
// missingAll: 監査役の欠測と、構造検査（checker）を実行できなかったパス。後者も「検査していない」
// であり、指摘 0 件と読ませない。
const missingAll = [...missing, ...checkerMissing]
const verdict = missingAll.length
  ? 'audit_incomplete'
  : adjudication.unadjudicated.length
  ? 'adjudication_incomplete'
  : backstopReached
  ? 'revision_backstop_reached'
  : unanswerable.length
  ? 'unanswerable_findings'
  : allFailed.length
  ? 'unresolved_findings'
  : blockingOverCapacity
  ? 'blocking_over_capacity'
  : blockingTbd.length
  ? 'tbd_remaining'
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
// 今 run の終端裁定で rejected と分類された構造検査の指摘 ID。次周回の suppressed_finding_ids へ
// 合流させ、同じ偽指摘の再起票と再裁定を止める（digest は auditor|document|location で粗く、
// 同一 location の複数指摘が 1 つの digest を共有するため、rejected digest に含まれる structural
// 指摘の ID 単位で持ち越す）。
if (suppressedApplied.length) {
  const uniq = [...new Set(suppressedApplied.map((e) => e.id))]
  log(`抑止: suppressed_finding_ids により構造検査指摘 ${suppressedApplied.length} 件を畳みました（${uniq.slice(0, 8).join(' / ')}${uniq.length > 8 ? ' …' : ''}）`)
}
const rejectedStructuralIds = (() => {
  const rejectedDigests = new Set(adjudication.rejected.map((e) => e.digest))
  const out = new Set(suppressedFindingIds)
  for (const f of adjudicationRemaining) {
    if (f && f.auditor === 'structural' && rejectedDigests.has(f.digest)) out.add(f.id)
  }
  return [...out].sort()
})()
const nextArgs = buildNextArgs({
  outer_round: outerRound,
  max_outer_rounds: MAX_OUTER_ROUNDS,
  has_needs_input: needsInputTbd.length > 0,
  has_unpresented_blocking: gateBlocking.length > 0,
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
  sources_path: sourcesPath,
  draft_dir: draftDir,
  flow,
  role_opts: parsedArgs.role_opts,
  bulk_read_path: bulkReadPath,
  specimen_paths_arg: parsedArgs.specimen_paths || [],
  suppressed_finding_ids: rejectedStructuralIds,
})

return {
  role_opts_applied: roleOverrides,
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
    // 本文は返さない。draft_path が最新の稿（checker が行数を照合済み）であり、保存は司令塔が
    // このファイルを documents[].path へ複写して行う。
    draft_path: d.draft_path,
    ...(Number.isInteger(d.line_count) ? { line_count: d.line_count } : {}),
    summary: d.summary,
    items: d.items,
    referenced_ids: d.referenced,
    vacant_ids: d.vacant,
    trace: d.trace,
    flow_refs: d.flow_refs || [],
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
  // auto_resolved_blocking / resolved_by_measurement: 人間必要性の判定パイプラインが人間に
  // 聞かずに決着させた項目。**本文への反映はこのラン内で済んでいる**（次周回に持ち越さない）。
  // 司令塔は保存承認ゲートで決定として事後提示する — 依頼者はそこで覆せる。
  auto_resolved_blocking: autoResolvedBlocking,
  resolved_by_measurement: resolvedByMeasurement,
  // holding_rules: 提示済みでなお決まらない論点を、規範文（裁定までの保持規則）へ変換した
  // 記録。文書側には規範文として入っている。
  holding_rules: holdingRules,
  // work_items: 保持規則に変換した論点の裁定そのもの。**文書には書かない**。司令塔が
  // 保存時に Issue として起票する（規約は SKILL.md）。
  work_items: workItems,
  // audit_trail: 項目 ID → 根拠の対応と、このランで下した裁定の記録。納品文書には根拠句・
  // 決定ログを書かないため、「どこから来たか」はここにしか無い。捏造監査と
  // traceability 監査はこれと入力（input / answers / decisions / 前提）を突き合わせる。
  // 形は draft.js の audit_trail（{ document, path, basis[] } の配列）を basis に入れ子にした
  // ものである。Workflow B では裁定の記録が加わるため、配列ではなくオブジェクトになる。
  audit_trail: {
    basis: documents
      .filter((d) => !d.fixed)
      .map((d) => ({ document: d.key, path: d.path, basis: d.trace || [] })),
    decisions,
    tbd_answers_history: [
      ...tbdAnswersHistory,
      ...(tbdAnswers ? [{ round: outerRound, answers: tbdAnswers }] : []),
    ],
    auto_resolved: autoResolvedBlocking,
    measured: resolvedByMeasurement,
    holding_rules: holdingRules,
    adjudication,
  },
  // blocking_over_capacity: 起票された blocking が提示容量（GATE_CAPACITY_PER_ROUND ×
  // MAX_GATE_ROUNDS）を超えている。verdict にも現れるが、他の verdict と同時に成立しうるので
  // 真偽値でも返す。
  blocking_over_capacity: blockingOverCapacity,
  unpresented_blocking: gateBlocking.map((t) => ({
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
  missing_auditors: missingAll,
  audit_incomplete: missingAll.length > 0,
  writer_missing: writerMissing,
  structural_findings: structural,
  // structural_not_checked: 材料が無くて実行できなかった検査。「0 件」と混同させない。
  structural_not_checked: structuralNotChecked,
  // fixed_findings: このランの対象外の文書への指摘。改稿には回していない。
  fixed_findings: fixedFindings,
  unresolved: allFailed,
  has_unresolved: allFailed.length > 0,
  // unanswerable: resolver 候補付き改稿の後も同一 digest のまま残った指摘（回答不能）。
  unanswerable,
  // adjudication: 終端裁定の三値分類。unadjudicated が空であることを script が検証済みで、
  // 空でなければ verdict = 'adjudication_incomplete' に反映されている。
  adjudication,
  unroutable_findings: allFailed.filter((f) => f.unroutable),
  // suppressed_findings: suppressed_finding_ids により集計前に畳んだ構造検査指摘。
  // 黙って消さず、何をいくつ畳んだかをここで開示する。
  suppressed_findings: suppressedApplied,
  // suppressed_finding_ids_next: 次の run（next_args を使わない新規 run を含む）へ渡すべき累積。
  suppressed_finding_ids_next: rejectedStructuralIds,
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
    unpresented_blocking_count: gateBlocking.length,
    auto_resolved_blocking_count: autoResolvedBlocking.length,
    resolved_by_measurement_count: resolvedByMeasurement.length,
    holding_rules_count: holdingRules.length,
    work_items_count: workItems.length,
    blocking_capacity: GATE_CAPACITY_PER_ROUND * MAX_GATE_ROUNDS,
    blocking_over_capacity: blockingOverCapacity,
    suppressed_findings_count: suppressedApplied.length,
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
    instrumentation: instr,
    // locator: locate 読みを割り当てた全範囲監査の実績（監査役ごと）。full_fallback の理由・locator の
    // 引用件数・逐語で見つからなかった件数・抜き取りで見つかった見落とし件数。verdict には使わない。
    locator: summarizeLocator(locatorRecords),
  },
}
