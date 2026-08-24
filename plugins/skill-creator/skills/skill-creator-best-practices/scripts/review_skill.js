export const meta = {
  name: 'skill-creator-review',
  description:
    '既存スキル/変更を観点別に評価し、独立した反証に生き残った指摘だけを返す（update では staging への改稿と再検証まで行う）',
  phases: [
    { title: 'Find', detail: '観点別 finder を並列で走らせる' },
    { title: 'Verify', detail: '各指摘に観点の異なる反証者を独立に当てる' },
    { title: 'Update', detail: 'mode=update のとき staging へ改稿する' },
    { title: 'Reverify', detail: 'staging に同じ観点を再適用し before/after を突き合わせる' },
  ],
}

// 有効票の下限。3 体中 2 体以上が返ってこないと、多数決の分母が 1 になり
// 「1 体が反証しなかった」だけで確定してしまう。欠測は反証の不在ではないので、
// 確定にも棄却にも回さず unverified として残す。
const MIN_VALID_VOTES = 2

// 再改稿の上限。1 回直しても blocker が残るなら、指摘の解釈か要件側の問題である可能性が高く、
// 同じ入力で回し続けても収束しない。上限に達したら人間へ返す。
const MAX_REVISIONS = 1

// finder 1 体が返す指摘数の上限。指摘ごとに複数の独立反証を起動するため、
// schema 側で制限しないと runtime data がそのまま無界の fan-out になる。
const MAX_FINDINGS_PER_FINDER = 8

const SEVERITY = { type: 'string', enum: ['blocker', 'major', 'minor'] }

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      maxItems: MAX_FINDINGS_PER_FINDER,
      items: {
        type: 'object',
        // evidence を必須にしているのは、引用が無い指摘を反証者が検証できないため。
        // 「〜が不足している」という主張だけだと、反証者は不在の証明を求められる。
        required: ['file', 'claim', 'evidence', 'severity', 'suggested_fix'],
        properties: {
          file: { type: 'string' },
          location: { type: 'string' },
          claim: { type: 'string' },
          evidence: { type: 'string' },
          severity: SEVERITY,
          suggested_fix: { type: 'string' },
          // Reverify（draft）でだけ意味を持つ。evidence の引用が改稿前の原本にもそのまま
          // 存在するか。true なら改稿が持ち込んだ問題ではなく、改稿前の Find が見落とした
          // 既存の問題。script はこれを new から preexisting へ分ける唯一の材料にする。
          present_in_original: { type: 'boolean' },
        },
      },
    },
    // scanned_files を必須にする。再検証で「指摘が消えた」と「そのファイルを誰も開かなかった」
    // を区別する唯一の手がかりがこれで、任意フィールドにすると防御そのものが動かなくなる。
    scanned_files: { type: 'array', items: { type: 'string' } },
    // 読めなかったことを findings 0 件と同じ形で返されると、欠測が「問題なし」に化ける。
    // 真偽値で受け取り、script 側で null（未観測）として扱う。
    unreadable: { type: 'boolean' },
    note: { type: 'string' },
  },
  required: ['findings', 'scanned_files', 'unreadable'],
}

// 反証の結果は三値で受け取る。boolean だと「読めなかった」を false（反証できなかった）に
// 押し込むことになり、検証していない票が確定側の有効票として数えられる。
const REFUTE_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['refuted', 'not_refuted', 'unreadable'] },
    reason: { type: 'string' },
  },
  required: ['verdict', 'reason'],
}

const UPDATE_SCHEMA = {
  type: 'object',
  properties: {
    changed_files: {
      type: 'array',
      items: {
        type: 'object',
        // findings_addressed を必須にして、変更と指摘の対応を残す。対応が書けない変更は
        // intent にも findings にも紐づかない改稿であり、後段の突き合わせで説明できない。
        required: ['path', 'reason', 'findings_addressed'],
        properties: {
          path: { type: 'string' },
          reason: { type: 'string' },
          findings_addressed: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    summary: { type: 'string' },
  },
  required: ['changed_files', 'summary'],
}

const parsedArgs = (typeof args === 'string' ? JSON.parse(args) : args) || {}

// ------------------------------------------------------------ phase 0: 起動時ガード
// 対象も範囲も定まらないまま走らせると、何を見たのか説明できない結果が「レビュー結果」として
// 返る。曖昧さは司令塔（Phase 1 の確認）で潰す契約なので、ここは黙って補完せず落とす。

function requireAbsolutePath(value, name) {
  if (!value || typeof value !== 'string' || !value.trim()) {
    throw new Error(`args.${name} が未指定です。SKILL.md の Workflow 呼び出し例に従ってください。`)
  }
  // script はファイルシステムに触れず symlink も解決できない。実体パスの解決は呼び出し側の
  // 責務（SKILL.md Phase 1 の realpath 手順）で、ここでできるのは形式検査だけ。
  if (!value.startsWith('/')) {
    throw new Error(
      `args.${name} は絶対パスで渡してください（受領: ${value}）。` +
        'symlink 越しの参照パスではなく、司令塔が realpath で解決した実体パスを渡すこと。'
    )
  }
  return value.replace(/\/+$/, '')
}

const SKILL_DIR = requireAbsolutePath(parsedArgs.skillDir, 'skillDir')

const mode = parsedArgs.mode
if (!['review', 'update'].includes(mode)) {
  throw new Error(`args.mode は 'review' か 'update' のいずれかです（受領: ${mode}）。`)
}

const target = parsedArgs.target || {}
const skillPath = requireAbsolutePath(target.skillPath, 'target.skillPath')

const scope = target.scope
if (!['full', 'diff'].includes(scope)) {
  throw new Error(`args.target.scope は 'full' か 'diff' のいずれかです（受領: ${scope}）。`)
}

const diffRef = target.diffRef
if (scope === 'diff' && (!diffRef || !String(diffRef).trim())) {
  throw new Error(
    "args.target.scope が 'diff' のときは args.target.diffRef（git の範囲指定。例 main...HEAD）が必須です。" +
      '範囲が無いまま差分レビューを始めると、何を見たのかが結果から復元できません。'
  )
}

const focus = target.focus || null

const intent = parsedArgs.intent
if (mode === 'update' && (!intent || !String(intent).trim())) {
  throw new Error(
    "args.mode が 'update' のときは args.intent（変更意図）が必須です。" +
      '意図が無いと、指摘の解消と依頼された変更を区別できないまま改稿することになります。'
  )
}

// 既定の staging は対象スキルディレクトリの「兄弟」。この値の定義はここが唯一で、
// SKILL.md には「script が決める」とだけ書いてある（値を 2 箇所に置くとズレる）。
const stagingDir = parsedArgs.stagingDir
  ? requireAbsolutePath(parsedArgs.stagingDir, 'stagingDir')
  : `${skillPath}-workspace/staging`

// 配下チェックは「一致」か「/ 区切りの前方一致」で行う。単純な startsWith にすると
// 既定値の `<skillPath>-workspace/staging` まで弾いて script が起動しなくなる。
// 包含は双方向で弾く。staging が対象の祖先でも、Reverify の finder はミラーと原本の両方を
// 読むことになり、ミラーで直した指摘が原本側から同じ主張として再び出て remaining に積まれる。
if (stagingDir === skillPath || stagingDir.startsWith(`${skillPath}/`)) {
  throw new Error(
    `args.stagingDir が対象スキルの配下を指しています（${stagingDir}）。` +
      'スキルを列挙する検証や参照実在チェックは配下を再帰的に見るため、未承認のドラフトが' +
      '本体スキルの一部として検査・配布の対象に入ります。兄弟ディレクトリを指定してください。'
  )
}
if (skillPath.startsWith(`${stagingDir}/`)) {
  throw new Error(
    `args.stagingDir が対象スキルの祖先を指しています（${stagingDir}）。` +
      '再検証はこのディレクトリ全体を改稿ドラフトとして読むため、ミラーと原本の両方が対象になり、' +
      '直した指摘が原本側から再び出て突き合わせが成立しません。兄弟ディレクトリを指定してください。'
  )
}

const maxRevisions = parsedArgs.maxRevisions ?? MAX_REVISIONS
// 上限が数値でないまま while に入ると、比較が常に false になって改稿が 1 回で黙って終わるか、
// 逆に打ち切りが効かなくなる。どちらも「上限がある」という保証が消えるので起動時に落とす。
if (!Number.isInteger(maxRevisions) || maxRevisions < 0 || maxRevisions > MAX_REVISIONS) {
  throw new Error(
    `args.maxRevisions は 0..${MAX_REVISIONS} の整数です（受領: ${JSON.stringify(parsedArgs.maxRevisions)}）。`
  )
}

// FINDERS: レビュー観点の唯一の正。SKILL.md にも references/ にも書き写さない（同じ判定が
// 2 箇所にあると必ずズレる。それ自体がここの duplicate-claims 観点の指摘対象になる）。
// 各観点は「1 つの見方だけで対象を読む」よう分離してある。1 体に全観点を渡すと、目立つ
// 観点だけを拾って残りを黙って飛ばす（どれを見なかったかも残らない）。
// ガイド内のガイドライン参照は SKILL_DIR 起点の絶対パスで埋める。評価対象は別スキルなので、
// 相対パスで書くと finder の作業ディレクトリからは存在しないパスになる。
const FINDERS = [
  {
    id: 'why-driven',
    title: '理由の無い命令',
    guide: [
      '命令・禁止・手順だけが書かれていて、なぜそうするのかが書かれていない箇所を探す。',
      '理由が無い指示は、状況が変わったときに実行者が読み替える根拠を持てず、',
      '「書いてあるから」だけで守られるか、黙って無視されるかのどちらかになる。',
      'ただし schema のフィールド名一致のような「崖の近く」の制約は理由が自明なので対象外。',
    ].join('\n'),
  },
  {
    id: 'script-vs-prose',
    title: '散文に残った確定的処理',
    guide: [
      '判定・集計・ループ・並列の指示が散文で書かれ、script に落ちていない箇所を探す。',
      '「まとめて起動する」「平均を出して閾値と比べる」を文章で指示すると、実行者が',
      'まとめ忘れたり目分量で判断したりする余地が残る。構造で保証できるものが',
      '文章のままかどうかを見る。',
    ].join('\n'),
  },
  {
    id: 'duplicate-claims',
    title: '二重定義',
    guide: [
      '同じ判定・閾値・観点一覧・手順・パスが 2 箇所以上に定義されている箇所を探す。',
      '一方だけが更新されると静かに食い違い、どちらが正かを読者が決められなくなる。',
      '「片方がもう片方を参照している」形なら問題ない。値そのものが複製されている',
      'ケースだけを挙げる。',
    ].join('\n'),
  },
  {
    id: 'loopholes',
    title: '経路の無い依頼・抜け道',
    guide: [
      '文書が想定していない依頼が来たときに、どこにも落ちずに実行者の裁量になる箇所を探す。',
      '分岐の網羅漏れ、判定表に無いケース、複数の分岐に同時に当たったときの優先順位が',
      '無い箇所、前提が崩れたときの経路が書かれていない箇所。',
      '裁量に落ちた依頼は最も安直な形で処理されるため、抜け道は実質的な既定値になる。',
    ].join('\n'),
  },
  {
    id: 'description-alignment',
    title: 'description と本文の乖離',
    guide: [
      'frontmatter の description が宣言する守備範囲と、本文・入出力定義が扱う範囲の',
      'ズレを探す。description にあるのに本文に経路が無い、本文にあるのに description が',
      '触れていない、除外条件が食い違う、のいずれか。',
      'description はスキルがいつ呼ばれるかを決める唯一の手がかりなので、',
      'ズレは「呼ばれたのにやり方が無い」「やれるのに呼ばれない」に直結する。',
    ].join('\n'),
  },
  {
    id: 'best-practices',
    title: 'ベストプラクティス準拠',
    guide: [
      `${SKILL_DIR}/references/best-practices.md と`,
      `${SKILL_DIR}/references/skill-writing-guide.md に照らして逸脱している箇所を探す。`,
      'この 2 つは絶対パスで示してある。評価対象は別のスキルなので、相対パスでは解決しない。',
      '参照ファイルは自分で Read すること（要約を渡していないのは、要約経由だと原典に',
      '無い基準を作りかねないため）。',
      '逸脱を挙げるときは、どのガイドのどの記述に反するかを evidence に引用する。',
      '2 つのガイドがどちらも読めなかった場合は unreadable を true にする。読めていないまま',
      '「逸脱なし」を返すと、この観点が実施済みとして数えられる。',
    ].join('\n'),
  },
]

// PERSPECTIVES: 反証者の観点。同じ懐疑者を 3 体並べても同じ見落とし方をするため、
// 「何を疑うか」をずらす。実在 → 重要性 → 代替解釈 の順で、指摘が生き残る条件を狭めていく。
const PERSPECTIVES = [
  {
    id: 'existence',
    guide:
      '指摘された記述が本当にそのファイルのその位置に存在するかを確認する観点。' +
      '引用が実物と一致しない、既に別の箇所で手当てされている、そもそも該当行が無い、' +
      'のいずれかなら反証が成立する。',
  },
  {
    id: 'materiality',
    guide:
      '記述が存在するとして、それが実害につながるかを問う観点。' +
      '直さなくても誰も困らない、様式の好みでしかない、指摘された severity が実際の' +
      '影響に対して過大、のいずれかなら反証が成立する。',
  },
  {
    id: 'alternative',
    guide:
      'その記述には別の合理的な読み方があるのではないかを問う観点。' +
      '意図的な設計判断である、別の箇所がその理由を説明している、文書の役割上そう書くのが' +
      '正しい、のいずれかなら反証が成立する。',
  },
]

// agentType は指定しない。agents/*.md の frontmatter の subagent_type は Agent ツールの
// レジストリに登録された型ではなく、指定すると解決に失敗する。役割はプロンプト本文が担う。
function roleAgent(file, body, opts) {
  return agent(
    [
      `Read ${SKILL_DIR}/agents/${file} for your full role instructions before doing anything else.`,
      '以下の入力を、その役割定義に従って処理すること。',
      '',
      body,
    ].join('\n'),
    opts
  )
}

// 範囲の指示は 2 種類ある。source は対象スキル本体（git 追跡下）、draft は staging。
// staging は git の追跡外なので、そこで scope=diff の指示をそのまま渡すと差分が空になり、
// finder は「見るべき箇所が無い」と判断して何も読まない。Reverify は常に full 相当で読ませ、
// focus だけは両パスで維持する（人間が見てほしいと言った関心は改稿後も変わらない）。
function scopeBlock(kind) {
  const lines = []
  if (kind === 'draft') {
    lines.push('[SCOPE]: draft')
    lines.push(
      'このディレクトリは改稿ドラフトである。git の差分は取得せず、置かれているファイルを' +
        'そのまま読む。ドラフトは git の追跡外にあり、差分を取ろうとすると空になり、' +
        '「見るべき箇所が無い」と誤解したまま何も読まないことになる。'
    )
    // 改稿前の原本を渡すのは、各指摘に present_in_original を返させるため。改稿前の Find が
    // 見落とした既存の問題を「改稿が持ち込んだ」と報告すると、承認判断が歪む（実際に起きた）。
    lines.push(`[ORIGINAL_DIR]: ${skillPath}`)
    lines.push(
      '各指摘について、evidence の引用が [ORIGINAL_DIR] の同じファイルにもそのまま存在するかを' +
        '確認し present_in_original に true / false で返すこと。原本が読めなければ省略する。' +
        '引用が同じでも、指摘が成立する条件（参照先・前提）が改稿で変わったなら false。' +
        '[ORIGINAL_DIR] 側で読んだファイルは scanned_files に含めない（scanned_files は' +
        '[TARGET_DIR] で実際に読んだものだけ。原本は相対パスが同じなので混ぜると観測の有無が狂う）。'
    )
  } else {
    lines.push(`[SCOPE]: ${scope}`)
    lines.push(
      scope === 'diff'
        ? `[DIFF_REF]: ${diffRef}\n差分は自分で取得すること（例: git diff ${diffRef} -- <対象ディレクトリ>）。` +
            '差分に関係しない箇所は指摘しない。範囲外を混ぜると、この変更が持ち込んだ問題と' +
            '元からあった問題が区別できなくなる。'
        : 'スキル全体を対象にする。'
    )
  }
  if (focus) lines.push(`[FOCUS]:\n${focus}`)
  return lines.join('\n')
}

// --------------------------------------------------------- 観点別の指摘出し（Find / Reverify）

// pass ごとに id を振り直す。before/after を突き合わせるので、id が衝突すると
// 「解消された指摘」と「新しく出た指摘」が同一視される。
function runFinders(dir, phaseTitle, passLabel, scopeKind) {
  // parallel（barrier）を使う理由: 次の集約が全観点を横断して見る必要がある。
  // どの観点が欠測したかを by_category に載せ、1 つでも落ちたら verdict を
  // review_incomplete に固定する判定は、全件が出揃わないと下せない。
  return parallel(
    FINDERS.map((f) => () =>
      roleAgent(
        'finder.md',
        [
          `[TARGET_DIR]: ${dir}`,
          `[CATEGORY]: ${f.id} — ${f.title}`,
          `[CATEGORY_GUIDE]:\n${f.guide}`,
          scopeBlock(scopeKind),
        ].join('\n\n'),
        { model: 'sonnet', schema: FINDINGS_SCHEMA, phase: phaseTitle, label: `find-${f.id}-${passLabel}` }
      ).then((res) => ({ category: f.id, res }))
    )
  ).then((raw) => {
    const rows = raw.filter(Boolean)
    const findings = []
    const missing = []
    const scannedByCategory = {}
    for (const f of FINDERS) {
      const row = rows.find((r) => r.category === f.id)
      if (!row || !row.res) {
        missing.push(f.id)
        log(`観点 ${f.id} の finder が応答しませんでした（${passLabel}）。未実施として扱います。`)
        continue
      }
      // unreadable は 0 件ではなく欠測。読めていないのに findings 0 件を成果として扱うと、
      // 「見て問題が無かった」に化ける。missing と同じ扱いに寄せる。
      if (row.res.unreadable === true) {
        missing.push(f.id)
        log(
          `観点 ${f.id}: 対象を読めなかったと報告されました（${passLabel}）。未実施として扱います。` +
            (row.res.note ? ` 報告: ${row.res.note}` : '')
        )
        continue
      }
      if (row.res.note) log(`観点 ${f.id}（${passLabel}）の補足: ${row.res.note}`)
      scannedByCategory[f.id] = row.res.scanned_files || []
      const items = row.res.findings || []
      items.forEach((item, i) => {
        findings.push({
          id: `${passLabel}-${f.id}-${i + 1}`,
          category: f.id,
          file: item.file,
          location: item.location || '',
          claim: item.claim,
          evidence: item.evidence,
          severity: item.severity,
          suggested_fix: item.suggested_fix,
          // 明示列挙で再構築しているので、ここに書かないと finder が返した値が落ちる
          // （実際に落ちていて preexisting が恒常的に空になった）。boolean 以外は undefined に
          // 正規化し、「分からない」を false（＝改稿由来）に丸めない。
          present_in_original:
            typeof item.present_in_original === 'boolean' ? item.present_in_original : undefined,
        })
      })
      const checked = items.filter((it) => typeof it.present_in_original === 'boolean').length
      log(
        `観点 ${f.id}: 指摘 ${items.length} 件 / 読んだファイル ${scannedByCategory[f.id].length} 件（${passLabel}）` +
          (scopeKind === 'draft' ? ` / 原本照合 ${checked}/${items.length}` : '')
      )
    }
    return { findings, missing, scannedByCategory }
  })
}

// ------------------------------------------------------------------ 反証（Verify / Reverify）

function verifyFindings(findings, phaseTitle, passLabel) {
  // 外側の parallel は finding どうしが独立だから。内側の parallel（barrier）は
  // 多数決の算術が 3 票すべてを必要とするため —— 1 票ずつ流して途中で決めると、
  // 到着順で結論が変わる。
  return parallel(
    findings.map((f) => () =>
      parallel(
        PERSPECTIVES.map((p) => () =>
          roleAgent(
            'refuter.md',
            [
              `[PERSPECTIVE]: ${p.id}`,
              `[PERSPECTIVE_GUIDE]:\n${p.guide}`,
              `[TARGET_DIR]: ${f.__dir}`,
              `[FINDING]:\n${JSON.stringify(
                {
                  category: f.category,
                  file: f.file,
                  location: f.location,
                  claim: f.claim,
                  evidence: f.evidence,
                  severity: f.severity,
                },
                null,
                2
              )}`,
            ].join('\n\n'),
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
      // unreadable は有効票に数えない。読めていない票を分母に入れると、実際には
      // 1 体しか検証していない指摘が「3 体中 1 体だけが反証した」＝確定として通る。
      const votes = row.votes.filter((v) => v.verdict === 'refuted' || v.verdict === 'not_refuted')
      const unreadableVotes = row.votes.length - votes.length
      const refutedCount = votes.filter((v) => v.verdict === 'refuted').length
      const entry = {
        ...row.finding,
        votes: row.votes.map((v) => ({ verdict: v.verdict, reason: v.reason })),
        valid_votes: votes.length,
        unreadable_votes: unreadableVotes,
        refuted_votes: refutedCount,
      }
      delete entry.__dir
      // 欠測は反証の不在ではない。有効票が足りないまま確定させると「誰も反論しなかった」が
      // 「検証を通った」に化ける。確定にも棄却にも回さず未検証として残す。
      if (votes.length < MIN_VALID_VOTES) {
        unverified.push(entry)
        continue
      }
      // 過半数。同数（2 票中 1 票）では棄却しない —— 反証は「疑わしきは落とす」側に
      // 倒してあるので、そこで割れたなら人間が見るべき材料として残す方が安全。
      if (refutedCount * 2 > votes.length) rejected.push(entry)
      else confirmed.push(entry)
    }
    log(
      `${passLabel}: 確定 ${confirmed.length} 件 / 棄却 ${rejected.length} 件 / 未検証 ${unverified.length} 件`
    )
    return { confirmed, rejected, unverified }
  })
}

function tag(dir, findings) {
  // 反証者は対象ファイルを自分で Read するため、どのディレクトリを見るかを finding に載せる。
  return findings.map((f) => ({ ...f, __dir: dir }))
}

function byCategory(missing, confirmed) {
  const out = {}
  for (const f of FINDERS) {
    // 欠測は 0 件ではなく null。0 と書くと「見たが何も無かった」と読まれる。
    out[f.id] = missing.includes(f.id) ? null : confirmed.filter((c) => c.category === f.id).length
  }
  return out
}

// 指摘の同一性は 2 段階で見る。厳密キーは (観点, ファイル, 主張)、粗いキーは (観点, ファイル)。
// script は意味の一致を見られないので、文言が変わっただけの指摘は厳密キーでは別件になる。
// 粗いキーだけが一致したものは possibly_rephrased として残し、人間が判断する材料にする。
// ファイル表記は `./SKILL.md` と `SKILL.md` のような揺れが出る。文字列一致で突き合わせる
// 以上、揺れは resolved を unobserved に倒す（安全側だが誤判定）。先頭の `./` だけ正規化する。
const normPath = (p) => String(p).replace(/^\.\//, '')

function keyOf(f) {
  return [f.category, normPath(f.file), String(f.claim).trim().toLowerCase().replace(/\s+/g, ' ')].join('::')
}

function coarseKeyOf(f) {
  return [f.category, normPath(f.file)].join('::')
}

// ------------------------------------------------------------------------- Find / Verify

phase('Find')
const first = await runFinders(skillPath, 'Find', 'p1', 'source')

phase('Verify')
const base = await verifyFindings(tag(skillPath, first.findings), 'Verify', 'before')

// 比較の基準は常にこの最初の確定指摘。改稿を 2 回以上重ねたときに直前のラウンドと比べると、
// 1 度直った指摘がぶり返しても「元から無かった」ことになり、resolved が水増しされる。
const originalConfirmed = base.confirmed

const beforeCategories = byCategory(first.missing, base.confirmed)
const reviewIncomplete = first.missing.length > 0
if (reviewIncomplete) {
  log(`観点 ${first.missing.join(', ')} が未実施のため、この結果は網羅していません。`)
}

function result(verdict, findings, findingsSource, afterCategories, staging, revisionsUsed) {
  return {
    mode,
    target: { skillPath, scope, diffRef: diffRef || null, focus },
    verdict,
    findings,
    // findings がどちらの検査パスのものかを明示する。改稿後の結果を改稿前のものと
    // 取り違えると、「まだ直っていない」と「もう直した」が逆に読める。
    findings_source: findingsSource,
    // before は最初の Find、after は Reverify。after が null なのは「そのパスが走らなかった」、
    // before.<観点> が null なのは「走ったがその観点の担当が応答しなかった」で、意味が違う。
    by_category: { before: beforeCategories, after: afterCategories },
    staging,
    revisions_used: revisionsUsed,
  }
}

if (mode === 'review') {
  // 確定が 0 件でも未検証が残っていれば clean とは言わない。未検証を clean に丸めると、
  // 「未検証と問題なしを区別する」ために置いた 3 バケットが結果表示で 1 つに戻る。
  const verdict = reviewIncomplete
    ? 'review_incomplete'
    : base.confirmed.length === 0 && base.unverified.length === 0
      ? 'clean'
      : 'findings'
  return result(verdict, base, 'before', null, null, 0)
}

// -------------------------------------------------------------------------------- Update

// 観点が欠けたまま改稿しない。部分的な絵から書き換えるのは、見えていない箇所を
// 「問題なし」と決めつけて手を入れるのと同じで、止まる方が安全。
if (reviewIncomplete) {
  return result('review_incomplete', base, 'before', null, null, 0)
}

let revision = 0
let staging = null
let latest = base
let latestSource = 'before'
let afterCategories = null
let verdict = null

// 静的な上限つきループ。`while (true)` だと打ち切りが break の書き漏れ 1 つで消えるが、
// この形なら条件が上限を保証し、break はすべて「早く抜ける」方向にしか効かない。
// maxRevisions が 0 でも初回の改稿は 1 度走る（0 は「再改稿しない」という意味）。
while (revision <= maxRevisions) {
  phase('Update')
  // confirmed が 0 件でも updater は走らせる。intent は必須引数であり、
  // 「レビューでは問題が出ないが依頼された変更はある」場合（Issue 起点の更新が典型）に
  // confirmed の有無で門を作ると、update が黙って何もしないモードになる。
  const changed = await roleAgent(
    'updater.md',
    [
      `[TARGET_DIR]: ${skillPath}`,
      `[STAGING_DIR]: ${stagingDir}`,
      `[INTENT]:\n${intent}`,
      `[CONFIRMED_FINDINGS]:\n${JSON.stringify(
        originalConfirmed.map((c) => ({
          id: c.id,
          category: c.category,
          file: c.file,
          location: c.location,
          claim: c.claim,
          evidence: c.evidence,
          severity: c.severity,
          suggested_fix: c.suggested_fix,
        })),
        null,
        2
      )}`,
      // 未検証も渡す。「未検証」と「問題なし」を混ぜないという原則は update でも同じで、
      // 渡さないと updater は確定 0 件を「直すところが無い」と読む。ただし確定指摘とは
      // 別枠にして、直すかどうかを updater が判断できるようにする。
      `[UNVERIFIED_FINDINGS]:\n${JSON.stringify(
        base.unverified.map((c) => ({
          id: c.id,
          category: c.category,
          file: c.file,
          claim: c.claim,
          evidence: c.evidence,
          severity: c.severity,
        })),
        null,
        2
      )}`,
      revision > 0
        ? `[REVISE_NOTE]:\n前回の改稿後も残った指摘がある。下の残存・新規を解消すること。\n${JSON.stringify(
            staging ? { remaining: staging.remaining, new: staging.new } : {},
            null,
            2
          )}`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
    { model: 'opus', schema: UPDATE_SCHEMA, phase: 'Update', label: `update-r${revision + 1}` }
  )

  if (!changed) {
    // 改稿 agent が落ちた。ここまでに staging へ何が書かれたかは script からは分からない。
    // staging を null で返すと「書かれていない」と読まれるので、空の一覧を持つ器を返し、
    // dir を提示して人間に確認させる。
    staging = {
      dir: stagingDir,
      changed_files: [],
      resolved: [],
      remaining: [],
      new: [],
      unverified: [],
      possibly_rephrased: [],
      unobserved: [],
      reclassified: [],
      out_of_scope: [],
      preexisting: [],
    }
    verdict = 'update_failed'
    break
  }
  log(`staging に ${changed.changed_files.length} ファイルを書きました（改稿 ${revision + 1} 回目）`)
  if (changed.changed_files.length === 0) {
    log('updater は応答したが変更ファイルを 1 つも報告しなかった。改稿が空のまま再検証に入る。')
  }

  phase('Reverify')
  const after = await runFinders(stagingDir, 'Reverify', `p2r${revision + 1}`, 'draft')
  if (after.missing.length > 0) {
    // 再検証で観点が欠けた状態を「残存 0 件」と読むと、直っていないものが直ったことになる。
    staging = {
      dir: stagingDir,
      changed_files: changed.changed_files,
      resolved: [],
      remaining: [],
      new: [],
      unverified: [],
      possibly_rephrased: [],
      unobserved: [],
      reclassified: [],
      out_of_scope: [],
      preexisting: [],
    }
    verdict = 'reverify_incomplete'
    break
  }

  const post = await verifyFindings(tag(stagingDir, after.findings), 'Reverify', 'after')

  const beforeKeys = new Set(originalConfirmed.map(keyOf))
  const afterKeys = new Set(post.confirmed.map(keyOf))
  // 「新規」の基準は改稿前に確定した指摘ではなく、改稿前に**見えていた**指摘全体。
  // 改稿前に unverified / rejected だったものが再検証で票が揃って確定しても、それは改稿が
  // 持ち込んだ問題ではなく反証の結果が変わっただけ。new は「改稿で悪くなっていないか」を
  // 人間が判断する唯一の数字なので、ここに混ぜると承認判断が直接歪む。
  const beforeSeenKeys = new Set(
    [...base.confirmed, ...base.unverified, ...base.rejected].map(keyOf)
  )
  // scope=diff のとき、改稿前は差分に触れた箇所だけ、再検証はドラフト全体を見ている。
  // 観測範囲が違うまま引き算すると、元からあって今回の変更と無関係な問題が丸ごと new に
  // 入る。比較対象は「改稿前に読まれたファイル ∪ 今回変更したファイル」に絞り、範囲外は
  // out_of_scope として提示だけする（blocker の算出には入れない）。full では全件が範囲内。
  const inScope =
    scope === 'diff'
      ? new Set(
          [
            ...Object.values(first.scannedByCategory).flat(),
            ...changed.changed_files.map((c) => c.path),
          ].map(normPath)
        )
      : null
  const isInScope = (f) => inScope === null || inScope.has(normPath(f.file))

  // 「消えた」ように見える指摘のうち、再検証でそのファイルを誰も開かなかったものは
  // resolved に数えない。読まなかっただけかもしれず、それを解消として数えると
  // 改稿の効果が水増しされる。観測の有無は指摘と同じ観点の finder の scanned_files で見る
  // （別観点の担当が読んでいても、この観点で見られたことにはならない）。
  const resolved = []
  const unobserved = []
  for (const f of originalConfirmed) {
    if (afterKeys.has(keyOf(f))) continue
    const scanned = after.scannedByCategory[f.category] || []
    if (scanned.map(normPath).includes(normPath(f.file))) resolved.push(f)
    else unobserved.push(f)
  }

  const remaining = post.confirmed.filter((f) => beforeKeys.has(keyOf(f)))
  const notOriginal = post.confirmed.filter((f) => !beforeKeys.has(keyOf(f)))
  const reclassified = notOriginal.filter((f) => beforeSeenKeys.has(keyOf(f)))
  const outOfScope = notOriginal.filter((f) => !beforeSeenKeys.has(keyOf(f)) && !isInScope(f))
  // 改稿前の Find が見落とした既存の問題は、どのバケット（reclassified / out_of_scope）にも
  // 落ちずに new へ入る。finder の非決定性由来で前後の Find 結果の差からは区別できないので、
  // 再検証の finder が原本を照合した present_in_original を唯一の材料にして分ける。
  // 実在する確定指摘であることに変わりはないので提示はするが、「改稿が持ち込んだ」数字と
  // blocker 判定からは外す（改稿前にも同じ状態だったものを改稿の副作用として止めない）。
  const candidates = notOriginal.filter((f) => !beforeSeenKeys.has(keyOf(f)) && isInScope(f))
  const preexisting = candidates.filter((f) => f.present_in_original === true)
  const introduced = candidates.filter((f) => f.present_in_original !== true)

  // 粗いキー（観点＋ファイル）だけが一致する新規は、文言が変わっただけの同じ指摘である
  // 可能性がある。script は意味の一致を判定できないので new から取り除かず、別枠に併記する。
  const remainingCoarse = new Set(remaining.map(coarseKeyOf))
  const beforeCoarse = new Set(originalConfirmed.map(coarseKeyOf))
  const possiblyRephrased = introduced.filter(
    (f) => beforeCoarse.has(coarseKeyOf(f)) && !remainingCoarse.has(coarseKeyOf(f))
  )

  log(
    `突き合わせ（最初の確定指摘との比較・観点/ファイル/主張の一致で判定）: ` +
      `解消 ${resolved.length} / 残存 ${remaining.length} / 新規 ${introduced.length} / ` +
      `未観測 ${unobserved.length} / 未検証 ${post.unverified.length} / ` +
      `再分類 ${reclassified.length} / 範囲外 ${outOfScope.length} / 既存 ${preexisting.length}`
  )
  if (preexisting.length > 0) {
    log(`既存 ${preexisting.length} 件は引用が改稿前の原本にもそのまま存在する指摘（改稿が持ち込んだものではない）。`)
  }
  if (reclassified.length > 0) {
    log(`うち ${reclassified.length} 件は改稿前に未検証・棄却だった指摘が再検証で確定したもの（改稿が持ち込んだものではない）。`)
  }
  if (outOfScope.length > 0) {
    log(`範囲外 ${outOfScope.length} 件は diff 範囲の外で元からあった可能性が高い指摘。提示はするが blocker 判定には入れない。`)
  }
  if (possiblyRephrased.length > 0) {
    log(
      `うち ${possiblyRephrased.length} 件は同じ観点・同じファイルの指摘の言い換えの可能性がある` +
        `（主張の文言が一致しないため機械的には新規として扱っている）。`
    )
  }

  staging = {
    dir: stagingDir,
    changed_files: changed.changed_files,
    resolved,
    remaining,
    new: introduced,
    unverified: post.unverified,
    possibly_rephrased: possiblyRephrased,
    unobserved,
    reclassified,
    out_of_scope: outOfScope,
    preexisting,
  }
  latest = post
  latestSource = 'after'
  afterCategories = byCategory(after.missing, post.confirmed)

  // 未検証の blocker は「検証が足りない」であって「直っていない」ではない。改稿を繰り返しても
  // 有効票は増えないので、ここで再改稿に回すと予算だけを消費する。人間の判断へ倒す。
  // unobserved も同じ扱い。「消えたのか、誰も見なかったのか」が分からない blocker を
  // 解消扱いで通すと、再検証していない改稿が applied_to_staging になる。
  const unverifiedBlockers = post.unverified.filter((f) => f.severity === 'blocker')
  const unobservedBlockers = unobserved.filter((f) => f.severity === 'blocker')
  if (unverifiedBlockers.length > 0 || unobservedBlockers.length > 0) {
    log(
      `未検証 ${unverifiedBlockers.length} 件 / 未観測 ${unobservedBlockers.length} 件の blocker が` +
        'あるため、自動では確定させません。'
    )
    verdict = 'needs_human_decision'
    break
  }

  // reclassified は「改稿が持ち込んだ」ものではないが、ドラフトに実在する確定 blocker ではある。
  // new から外すのは提示上の分類であって、承認判断から外す理由にはならない。
  const blockers = [...remaining, ...introduced, ...reclassified].filter((f) => f.severity === 'blocker')
  if (blockers.length === 0) {
    verdict = 'applied_to_staging'
    break
  }

  if (revision >= maxRevisions) {
    // 上限到達。同じ指摘が 2 度残るなら、指摘の解釈か要件側の問題である可能性が高く、
    // script で回し続けても収束しない。判断材料を添えて人間へ返す。
    log(`blocker ${blockers.length} 件が残ったまま改稿上限に達しました。`)
    verdict = 'needs_human_decision'
    break
  }
  revision++
}

// ループ条件で抜けた（break を通らなかった）場合の保険。verdict が null のまま返すと、
// 司令塔は「どの表にも無い値」を受け取り、提示の分岐が裁量に落ちる。
if (verdict === null) {
  log('改稿上限に達したまま判定が確定しませんでした。人間の判断へ回します。')
  verdict = 'needs_human_decision'
}

return result(verdict, latest, latestSource, afterCategories, staging, revision)
