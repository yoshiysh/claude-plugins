export const meta = {
  name: 'skill-creator-review',
  description:
    '既存スキル/変更を観点別に評価し、独立した反証に生き残った指摘だけを返す（update では staging への改稿と再検証まで、audit では prompt-audit の観点だけを行う）',
  whenToUse:
    'skill-creator の best-practices スキルが review / update / audit の手順から呼ぶ。skillDir・target・uncheckedItems などの args をそのスキルが組み立てて渡す前提で、args が無いと起動直後に落ちるため直接は起動しない',
  phases: [
    { title: 'Find', model: 'sonnet', detail: '観点別 finder を並列で走らせる' },
    { title: 'Verify', model: 'sonnet', detail: '各指摘に観点の異なる反証者を独立に当てる' },
    { title: 'Update', model: 'opus', detail: 'mode=update のとき staging へ改稿する' },
    { title: 'Reverify', model: 'sonnet', detail: 'staging に同じ観点を再適用し before/after を突き合わせる' },
  ],
}

// 有効票の下限。これを下回ると多数決の分母が 1 になり、
// 「1 体が反証しなかった」だけで確定してしまう。欠測は反証の不在ではないので、
// 確定にも棄却にも回さず unverified として残す。
const MIN_VALID_VOTES = 2

// updater へ再入させ、反証に回す指摘の重さ（再入規則の正本）。minor まで含めると文言の好みで
// 周回が尽き、改稿を動かさない指摘に反証の票を使う。外の重さは reported_minor として未検証で返す。
const REVISE_SEVERITIES = ['blocker', 'major']

// 回数ではなく進捗で止める（回数は「直っているか」と無関係な量）。未解消件数がそれまでの最小値を
// 下回らない巡がこれだけ続いたら止める。前巡比でなく最小値と比べるのは往復を進捗と読まないため。
const STALL_ROUNDS = 2

// budget（出力 token の hard ceiling）の残りがこれを下回ったら巡を始めない。ceiling で agent() が
// throw すると staging と突き合わせが返らない。値は 1 巡の出力量の見積もりで実測値ではない。
const MIN_ROUND_BUDGET_TOKENS = 200_000

// finder 1 体が返す指摘数の上限。指摘ごとに複数の独立反証を起動するため、
// schema 側で制限しないと runtime data がそのまま無界の fan-out になる。
const MAX_FINDINGS_PER_FINDER = 8

// UNCHECKED_BLOCKING: quick_validate.py が機械判定できないと宣言した項目について、
// 担当 finder の判定がこれらのどれかなら未解消として残す。`unknown`（判定できなかった）と
// `partial`（部分的）を `fail` と同格に置くのは、どちらも「満たしている」と言えていない点で
// 同じだからで、区別すると満たせなかったものが中間の名前で verdict を通り抜ける。
// **この集合の正本はここ 1 箇所**（SKILL.md / schemas.md は名前で参照する）。
const UNCHECKED_BLOCKING = ['fail', 'partial', 'unknown']

// 未判定・fail/partial から作る指摘の重さ。REVISE_SEVERITIES に含まれる値にしてあるので、
// 未解消のまま applied_to_staging にはならず、改稿ループへ戻る。
const UNCHECKED_SEVERITY = 'major'

// audit モードで走らせる唯一の観点。外部 skill（claude-api の prompt-audit）に依存するのはこの観点だけ。
const AUDIT_CATEGORY = 'prompt-audit'

// prompt-audit の確信度から severity への写像（正本はここ 1 箇所）。重さを finder の裁量にすると、
// 同じ監査結果が実行ごとに反証される側とされない側へ揺れる。High は文書化された挙動かリポジトリ自体と
// 矛盾する指摘なので反証にかける major、Medium は広く観測される傾向にとどまるので反証しない minor。
// Low と action=flag は監査ガイド自身が編集を提案しない扱いなので指摘にせず、宣言だけ残す。
const PROMPT_AUDIT_SEVERITY = { High: 'major', Medium: 'minor' }

// by_category で「外部 skill が実行環境に無く、この観点を実施できなかった」を表す値。null（応答しなかった）
// とも 0（見て何も無かった）とも違う。欠測に寄せると Codex のように常に無い環境で review/update が
// 毎回 review_incomplete になり、0 に寄せると見ていない観点が clean に数えられる。
const UNAVAILABLE = 'unavailable'

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
          // prompt-audit の観点だけが埋める。severity は script が PROMPT_AUDIT_SEVERITY でこれから決める。
          audit_confidence: { type: 'string', enum: ['High', 'Medium', 'Low'] },
          audit_action: {
            type: 'string',
            enum: ['remove', 'rewrite', 'move', 'replace-with-API-feature', 'add', 'flag'],
          },
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
    // 以下は担当する観点だけが埋める任意フィールド。全観点で schema を 1 つにする理由は
    // skill-writing-guide.md「subagent への指示と prompt cache」。必須性は script が担当の観点についてだけ
    // 読むことで保つ。unchecked_judgments の欠落は、返ってこなかった id を集合の差で未判定にして拾う。
    unchecked_judgments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          verdict: { type: 'string', enum: ['pass', 'partial', 'fail', 'unknown'] },
          evidence: { type: 'string' },
        },
        required: ['id', 'verdict', 'evidence'],
      },
    },
    unavailable: { type: 'boolean' },
    // prompt-audit が実際に走った証跡（監査レポート冒頭の scope と target model の前提行）。
    // 空なら監査せずに 0 件を返した可能性と区別できないので、script は欠測として扱う。
    audit_header: { type: 'string' },
    // prompt-audit の Low・flag の項目。note の自由記述にすると、再確認中の指摘が確信度を下げて
    // そこへ移ったときに script が照合できず、再報告されなかった（resolved）と数えてしまう。
    declared_only: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          location: { type: 'string' },
          claim: { type: 'string' },
          audit_confidence: { type: 'string', enum: ['High', 'Medium', 'Low'] },
          audit_action: {
            type: 'string',
            enum: ['remove', 'rewrite', 'move', 'replace-with-API-feature', 'add', 'flag'],
          },
        },
        required: ['file', 'claim'],
      },
    },
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
if (!['review', 'update', 'audit'].includes(mode)) {
  throw new Error(`args.mode は 'review' / 'update' / 'audit' のいずれかです（受領: ${mode}）。`)
}

// promptAuditExpected: この実行環境で claude-api skill の prompt-audit が使えるはずか。司令塔が
// select_runtime.js の selected_runtime から決める（native なら true）。true のとき prompt-audit の
// unavailable は欠測として扱う。使えるはずの環境で「無い」を受け付けると、観点が黙って外れる。
// 既定値を置かないのは、未指定を false と読むと native でも観点の脱落が skipped で通るため。
const promptAuditExpected = parsedArgs.promptAuditExpected
if (typeof promptAuditExpected !== 'boolean') {
  throw new Error(
    'args.promptAuditExpected（true / false）が未指定です。select_runtime.js の selected_runtime が native なら true、' +
      'dynamic-workflow-runner なら false を渡してください。'
  )
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

// uncheckedItems: quick_validate.py が「機械では判定できない」と宣言した項目。
// 司令塔が `python3 [SKILL_DIR]/scripts/quick_validate.py --emit-unchecked` の出力をそのまま渡す。
// script はファイルを開けないので、この委譲を運ぶ経路は args しかない。必須にしているのは、
// 未指定を「委譲する項目が無い」と読むと、実施されていない検査が黙って通るため。
// audit は委譲項目を判定する観点（best-practices）を走らせないので受け取らない。渡されたまま黙って
// 無視すると「委譲項目も見た」と読まれるため、明示的に落とす。
if (mode === 'audit' && parsedArgs.uncheckedItems !== undefined) {
  throw new Error(
    "args.mode が 'audit' のときは args.uncheckedItems を渡さないでください。" +
      'audit は prompt-audit の観点だけを走らせ、委譲項目を判定する観点を起動しません。'
  )
}
const uncheckedItems = mode === 'audit' ? [] : parsedArgs.uncheckedItems
if (!Array.isArray(uncheckedItems) || uncheckedItems.some((x) => !x || !x.id || !x.item)) {
  throw new Error(
    'args.uncheckedItems が未指定か形式が不正です。' +
      '`python3 [SKILL_DIR]/scripts/quick_validate.py --emit-unchecked` の出力（[{id, item}]）を' +
      'そのまま渡してください。'
  )
}
const uncheckedIds = uncheckedItems.map((x) => x.id)
const uncheckedBlock = [
  '[UNCHECKED_ITEMS] 機械検査が判定できないと宣言した項目（id つき）',
  JSON.stringify(uncheckedItems, null, 2),
  '',
  `上の id **すべて**について \`unchecked_judgments\` を返すこと（${uncheckedIds.join(' / ')}）。`,
  `判定は pass / partial / fail / unknown の 4 値で、${UNCHECKED_BLOCKING.join(' / ')} は未解消として`,
  '扱われる。返ってこなかった id は script が未判定として指摘に変換する。',
].join('\n')

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

// args.maxRevisions は受け取らない（後方互換を切った破壊的変更）。渡されても黙って無視すると
// 「上限を指定したつもり」で走ることになるため、明示的に落とす。停止は回数ではなく進捗で決まる。
if (parsedArgs.maxRevisions !== undefined) {
  throw new Error(
    'args.maxRevisions は廃止されました。改稿の打ち切りは回数ではなく進捗で決まります' +
      '（停止規則は review_skill.js の STALL_ROUNDS / MIN_ROUND_BUDGET_TOKENS を参照）。引数を外してください。'
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
    // この観点だけが UNCHECKED_ITEMS の判定を担う。項目の中身（検証者経路・発火実測・
    // 参照整合）がどれもガイド照合と同じ読み方で、他の観点は見る立場に無い。
    owns_unchecked: true,
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
  {
    id: AUDIT_CATEGORY,
    title: '古くなったプロンプトの書き方・食い違う指示',
    // unavailable を受け付ける規則の正本（finder.md / schemas.md は名前で参照する）。受け付けるのはこの観点
    // だけで、さらに promptAuditExpected が false のとき・Reverify では Find でも unavailable だったときに限る。
    // claude-api skill は Codex など実行環境によって無いが、どの観点・どの pass でも自分を外せると、
    // 未実施の観点が clean に化け、Find で確定した指摘が再確認されずに解消扱いになる。
    may_be_unavailable: true,
    guide: [
      'Claude Code 同梱の claude-api skill を、Skill ツールで prompt-audit サブコマンドを付けて起動し、',
      'その監査結果を指摘に写す観点。監査の基準は claude-api skill 側が持つ。中身をここで再現しない',
      '（写しは本家の更新に追随せずズレる）。',
      '',
      '1. Skill ツールで claude-api skill を起動し、引数に prompt-audit と [TARGET_DIR] の絶対パスを渡す。',
      '   依頼は「[TARGET_DIR] だけを scope にした報告のみの監査。ファイルは編集しない」と書く。',
      '   「整理して」「削って」のような語を依頼に入れない。監査ガイドはそれを編集の依頼と読み、',
      '   Reverify では [TARGET_DIR] が改稿ドラフトなので、検査者がドラフトを書き換えることになる。',
      '   target model は「対象ファイルが model を固定していればそのモデル、無ければ現行の Claude',
      '   フラッグシップ世代」と依頼に明記する。省くと監査はあなた自身のモデルを target にし、',
      '   finder のモデルを変えるたびに指摘が変わる。',
      '2. Skill ツールが無い、claude-api skill が一覧に無い、prompt-audit を受け付けない、のどれかなら',
      '   unavailable を true にし、findings を空で返して note に理由を書く。自分の知識で監査を代行したり、',
      '   監査ガイドのファイルを探して読んだりしない（本家の監査を通っていない指摘が同じ名前で混ざる）。',
      '3. 監査が走ったら、レポート冒頭の scope と target model の前提行をそのまま audit_header に写す。',
      '   これが空だと script は監査が走ったと確かめられず、この観点を欠測として扱う。',
      '4. レポートの各指摘を 1 件ずつ findings に写す: Location → file（[TARGET_DIR] からの相対）と',
      '   location（行）、Evidence → evidence（引用をそのまま）、Pattern と Why obsolete → claim（1 文）、',
      '   Action と置換案 → suggested_fix、Confidence → audit_confidence、Action → audit_action。',
      '   severity は script が audit_confidence から決め直すので、何を入れても上書きされる。',
      '5. Confidence が Low のもの、Action が flag のものは findings に入れず、declared_only に',
      '   file・location・claim・audit_confidence・audit_action を入れて全件返す（note の自由記述にしない）。',
      '   例外として [RECHECK_FINDINGS] の指摘は、まだ成立するなら確信度や Action に関わらず findings に',
      '   claim を一字も変えずに入れ、今回の audit_confidence / audit_action を付ける（重さは script が前巡の値で決める）。',
      '   findings の上限を超える分は Confidence の高い順に残し、溢れた件数と位置を note に書く。',
      '6. 監査が対象を読めなかった（ディレクトリが開けない等）なら unavailable ではなく unreadable を true にする。',
      'scope・RECHECK_FINDINGS・REVERIFY_SCOPE・present_in_original の規則は他の観点と同じに守る',
      '（再確認の claim は一字も変えない）。',
    ].join('\n'),
  },
]

const ACTIVE_FINDERS = mode === 'audit' ? FINDERS.filter((f) => f.id === AUDIT_CATEGORY) : FINDERS

// PERSPECTIVES: 反証者の観点。同じ懐疑者を並べても同じ見落とし方をするため、
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

// agentType は指定しない。agents/*.md の役割は Agent ツールのレジストリに登録された型ではなく、
// 指定すると解決に失敗する。役割はプロンプト本文が担う。
// 構造化出力の再試行が尽きたときや budget の上限に達したとき、agent() は null ではなく throw する。
// parallel() が throw を null に変えるかは host 次第（runner の parallel は catch しない）なので、ここで
// null に揃える。呼び出し側はどれも null を欠測（missing / unverified / update_failed）として扱う。
function roleAgent(file, body, opts) {
  return agent(
    [
      `Read ${SKILL_DIR}/agents/${file} for your full role instructions before doing anything else.`,
      '以下の入力を、その役割定義に従って処理すること。',
      '',
      body,
    ].join('\n'),
    opts
  ).catch((error) => {
    log(`${opts.label} が失敗しました: ${error && error.message ? error.message : error}`)
    return null
  })
}

// 範囲の指示は 2 種類ある。source は対象スキル本体（git 追跡下）、draft は staging。
// staging は git の追跡外なので、そこで scope=diff の指示をそのまま渡すと差分が空になり、
// finder は「見るべき箇所が無い」と判断して何も読まない。Reverify は git 差分ではなく
// reverifyScope（updater の変更ファイル＋再確認する指摘のファイル）で報告範囲を絞り、
// focus だけは両パスで維持する（人間が見てほしいと言った関心は改稿後も変わらない）。
function scopeBlock(kind, category, reverifyScope) {
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
      `各指摘の present_in_original を ${SKILL_DIR}/references/schemas.md の「finder の出力（FINDINGS_SCHEMA）」の定義に従って返すこと。` +
        '[ORIGINAL_DIR] 側で読んだファイルは scanned_files に含めない（scanned_files は' +
        '[TARGET_DIR] で実際に読んだものだけ。原本は相対パスが同じなので混ぜると観測の有無が狂う）。'
    )
    if (mode === 'update') lines.push(`[INTENT]:\n${intent}`)
    const recheck = reverifyScope.recheck.filter((f) => f.category === category)
    lines.push(
      `[REVERIFY_SCOPE]:\n${JSON.stringify([...scopeFilesFor(reverifyScope, category)], null, 2)}\n` +
        '指摘として報告してよいのは、上のファイルに置かれたものだけ（文脈のために他のファイルを読むのは構わない）。' +
        '例外として、改稿が [INTENT] を満たしていない・反している指摘は、どのファイルに置かれていても報告する。'
    )
    lines.push(
      `[RECHECK_FINDINGS]:\n${JSON.stringify(
        recheck.map((f) => ({ file: f.file, location: f.location, claim: f.claim, severity: f.severity })),
        null,
        2
      )}\n` +
        '前巡までに確定し、まだ解消が確かめられていない指摘。各指摘のファイルを必ず読み、まだ成立するなら' +
        ' claim を一字も変えずに再報告する（文言を変えると同じ指摘と照合できず、解消と新規に化ける）。'
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

// prompt-audit の監査結果を指摘へ写す。severity は PROMPT_AUDIT_SEVERITY で決め、写像の外（Low・flag・
// 確信度なし）は指摘にせず declared として返す。
// 例外は Reverify で再確認中の指摘（観点・ファイル・claim が一致）で、findings と declared_only のどちらに
// 来ても、確信度に関わらず前巡の severity の指摘として残す。確信度は実行ごとに揺れるので、下がった値で
// 写すと、手の入っていない指摘が minor や宣言へ逃げて改稿ループを抜け、resolved に数えられる。
function mapAuditItems(f, items, declaredItems, reverifyScope) {
  const recheck = new Map(
    (reverifyScope ? reverifyScope.recheck : []).filter((r) => r.category === f.id).map((r) => [keyOf(r), r])
  )
  const keyFor = (it) => keyOf({ category: f.id, file: it.file, claim: it.claim })
  const outsideMapping = (it) =>
    it.audit_action === 'flag' || !Object.hasOwn(PROMPT_AUDIT_SEVERITY, it.audit_confidence)
  const kept = new Map()
  const out = []
  const declared = []
  for (const [it, fromDeclared] of [...items.map((x) => [x, false]), ...declaredItems.map((x) => [x, true])]) {
    const previous = recheck.get(keyFor(it))
    if (previous) {
      if (kept.has(keyFor(it))) continue
      kept.set(keyFor(it), true)
      out.push({
        evidence: previous.evidence,
        suggested_fix: previous.suggested_fix,
        location: previous.location,
        ...it,
        severity: previous.severity,
      })
    } else if (fromDeclared || outsideMapping(it)) {
      declared.push({
        file: it.file,
        location: it.location || '',
        claim: it.claim,
        audit_confidence: it.audit_confidence || null,
        audit_action: it.audit_action || null,
      })
    } else {
      out.push({ ...it, severity: PROMPT_AUDIT_SEVERITY[it.audit_confidence] })
    }
  }
  return { items: out, declared }
}

// pass ごとに id を振り直す。before/after を突き合わせるので、id が衝突すると
// 「解消された指摘」と「新しく出た指摘」が同一視される。
// unavailableAllowed: unavailable を skipped_unavailable として受け付ける観点の id。それ以外の観点が
// unavailable を返したら欠測として扱う（決め方は呼び出し側の findUnavailableAllowed / Reverify の呼び出し）。
function runFinders(dir, phaseTitle, passLabel, scopeKind, reverifyScope, unavailableAllowed) {
  // parallel（barrier）を使う理由: 次の集約が全観点を横断して見る必要がある。
  // どの観点が欠測したかを by_category に載せ、1 つでも落ちたら verdict を
  // review_incomplete に固定する判定は、全件が出揃わないと下せない。
  return parallel(
    ACTIVE_FINDERS.map((f) => () =>
      roleAgent(
        'finder.md',
        [
          `[TARGET_DIR]: ${dir}`,
          `[CATEGORY]: ${f.id} — ${f.title}`,
          `[CATEGORY_GUIDE]:\n${f.guide}`,
          scopeBlock(scopeKind, f.id, reverifyScope),
          f.owns_unchecked ? uncheckedBlock : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
        {
          model: 'sonnet',
          effort: 'medium',
          schema: FINDINGS_SCHEMA,
          phase: phaseTitle,
          label: `find-${f.id}-${passLabel}`,
        }
      ).then((res) => ({ category: f.id, res }))
    )
  ).then((raw) => {
    const rows = raw.filter(Boolean)
    const findings = []
    const missing = []
    const unavailable = []
    const declaredOnly = []
    const scannedByCategory = {}
    // 委譲した項目の未達。build_skill.js の judgmentFailures と同じ原則で、判定フィールドを
    // script が直接走査し、返ってこなかった id は集合の差で拾う（不在は走査に写らないため）。
    // 反証には回さない —— これは finder の主張ではなく、委譲した項目に判定が付いたか
    // どうかという script 側の事実で、反証者が「実害が無い」と落とせる種類のものではない。
    const uncheckedFailures = []
    for (const f of ACTIVE_FINDERS) {
      const row = rows.find((r) => r.category === f.id)
      if (!row || !row.res) {
        missing.push(f.id)
        log(`観点 ${f.id} の finder が応答しませんでした（${passLabel}）。未実施として扱います。`)
        continue
      }
      if (row.res.unavailable === true && row.res.unreadable !== true) {
        if (unavailableAllowed.has(f.id)) {
          unavailable.push(f.id)
          log(
            `観点 ${f.id}: 依存する skill が実行環境に無いため実施できませんでした（${passLabel}）。` +
              '欠測とは別に skipped_unavailable として宣言します。' +
              (row.res.note ? ` 報告: ${row.res.note}` : '')
          )
        } else {
          missing.push(f.id)
          log(
            `観点 ${f.id}: unavailable を返しましたが、この pass では受け付けない観点です（${passLabel}）。欠測として扱います。` +
              (row.res.note ? ` 報告: ${row.res.note}` : '')
          )
        }
        continue
      }
      if (f.id === AUDIT_CATEGORY && row.res.unreadable !== true && !String(row.res.audit_header || '').trim()) {
        missing.push(f.id)
        log(
          `観点 ${f.id}: 監査が走った証跡（audit_header）が空です（${passLabel}）。` +
            '監査せずに 0 件を返した場合と区別できないため、未実施として扱います。'
        )
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
      let items = row.res.findings || []
      if (f.id === AUDIT_CATEGORY) {
        const audited = mapAuditItems(f, items, row.res.declared_only || [], reverifyScope)
        items = audited.items
        declaredOnly.push(...audited.declared)
        if (audited.declared.length > 0) {
          log(
            `観点 ${f.id}: PROMPT_AUDIT_SEVERITY の外の ${audited.declared.length} 件は指摘にせず declared_only に残します（${passLabel}）: ` +
              audited.declared.map((it) => `${it.file}:${it.location || '?'}`).join(', ')
          )
        }
      }
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
          ...(item.audit_confidence ? { audit_confidence: item.audit_confidence } : {}),
          ...(item.audit_action ? { audit_action: item.audit_action } : {}),
        })
      })
      if (f.owns_unchecked) {
        const judgments = row.res.unchecked_judgments || []
        const judged = new Set(judgments.map((j) => j.id))
        for (const j of judgments) {
          if (UNCHECKED_BLOCKING.includes(j.verdict)) {
            uncheckedFailures.push({
              id: `${passLabel}-unchecked-${j.id}`,
              category: f.id,
              file: 'SKILL.md',
              location: `機械判定できない項目: ${j.id}`,
              claim: `委譲項目 ${j.id} が満たされていない（判定: ${j.verdict}）`,
              evidence: j.evidence,
              severity: UNCHECKED_SEVERITY,
              suggested_fix: `${uncheckedItems.find((x) => x.id === j.id)?.item || j.id} を満たす経路を設ける`,
            })
          }
        }
        for (const id of uncheckedIds.filter((x) => !judged.has(x))) {
          uncheckedFailures.push({
            id: `${passLabel}-unchecked-${id}`,
            category: f.id,
            file: 'SKILL.md',
            location: `機械判定できない項目: ${id}`,
            claim: `委譲項目 ${id} の判定が返ってこなかった（未判定）`,
            evidence: '(判定なし)',
            severity: UNCHECKED_SEVERITY,
            suggested_fix: `${uncheckedItems.find((x) => x.id === id)?.item || id} を判定する`,
          })
        }
        log(`観点 ${f.id}: 委譲項目の未達 ${uncheckedFailures.length} 件（${passLabel}）`)
      }
      const checked = items.filter((it) => typeof it.present_in_original === 'boolean').length
      log(
        `観点 ${f.id}: 指摘 ${items.length} 件 / 読んだファイル ${scannedByCategory[f.id].length} 件（${passLabel}）` +
          (scopeKind === 'draft' ? ` / 原本照合 ${checked}/${items.length}` : '')
      )
    }
    return { findings, missing, unavailable, declaredOnly, scannedByCategory, uncheckedFailures }
  })
}

// ------------------------------------------------------------------ 反証（Verify / Reverify）

// 過半数に必要な票数。先頭からこの数の観点が全員有効票で一致すれば、残りの観点が
// どう投じても多数決の結論は変わらないので起動しない（PERSPECTIVES の並びが先行順を決める）。
const REFUTE_MAJORITY = Math.floor(PERSPECTIVES.length / 2) + 1

const isValidVote = (v) => v.verdict === 'refuted' || v.verdict === 'not_refuted'

function refuteOnce(f, p, phaseTitle) {
  return roleAgent(
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
      mode === 'update' && phaseTitle === 'Reverify' ? `[INTENT]:\n${intent}` : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
    {
      model: 'sonnet',
      effort: 'medium',
      schema: REFUTE_SCHEMA,
      phase: phaseTitle,
      label: `refute-${f.id}-${p.id}`,
    }
  ).then((v) => (v ? { perspective: p.id, verdict: v.verdict, reason: v.reason } : null))
}

function refuteStaged(f, phaseTitle) {
  const lead = PERSPECTIVES.slice(0, REFUTE_MAJORITY)
  const rest = PERSPECTIVES.slice(REFUTE_MAJORITY)
  // 段ごとの parallel（barrier）は、早期決着の判定が先行段の全票を必要とするため ——
  // 1 票ずつ流して途中で決めると、到着順で結論と起動数が変わる。先行段の観点は
  // 並びで固定してあるので、同じ票なら同じ結論・同じ起動数になる。
  return parallel(lead.map((p) => () => refuteOnce(f, p, phaseTitle))).then((leadRaw) => {
    const leadVotes = leadRaw.filter(Boolean)
    const valid = leadVotes.filter(isValidVote)
    // 欠測・unreadable が先行段に 1 票でもあれば決着させない。欠けた票を一致側に
    // 数えると、検証していない票で多数決が成立する。
    const settled =
      valid.length === lead.length &&
      valid.length >= MIN_VALID_VOTES &&
      valid.every((v) => v.verdict === valid[0].verdict)
    if (settled || rest.length === 0) {
      return { finding: f, votes: leadVotes, skipped_perspectives: settled ? rest.map((p) => p.id) : [] }
    }
    return parallel(rest.map((p) => () => refuteOnce(f, p, phaseTitle))).then((restRaw) => ({
      finding: f,
      votes: [...leadVotes, ...restRaw.filter(Boolean)],
      skipped_perspectives: [],
    }))
  })
}

function verifyFindings(findings, phaseTitle, passLabel) {
  // REVISE_SEVERITIES の外の指摘は改稿を動かさないので反証しない。黙って捨てると
  // 「見ていないもの」が消えるため、未検証であることを名前に持つ別枠で返す。
  const reportedMinor = findings
    .filter((f) => !REVISE_SEVERITIES.includes(f.severity))
    .map(({ __dir, ...rest }) => rest)
  const toVerify = findings.filter((f) => REVISE_SEVERITIES.includes(f.severity))
  // 外側の parallel は finding どうしが独立だから。
  return parallel(toVerify.map((f) => () => refuteStaged(f, phaseTitle))).then((raw) => {
    const confirmed = []
    const rejected = []
    const unverified = []
    for (const row of raw.filter(Boolean)) {
      // unreadable は有効票に数えない。読めていない票を分母に入れると、実際には
      // 1 体しか検証していない指摘が「反証したのは少数だけ」＝確定として通る。
      const votes = row.votes.filter(isValidVote)
      const unreadableVotes = row.votes.length - votes.length
      const refutedCount = votes.filter((v) => v.verdict === 'refuted').length
      const entry = {
        ...row.finding,
        votes: row.votes,
        valid_votes: votes.length,
        unreadable_votes: unreadableVotes,
        refuted_votes: refutedCount,
        skipped_perspectives: row.skipped_perspectives,
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
    const skipped = raw.filter(Boolean).reduce((n, row) => n + row.skipped_perspectives.length, 0)
    log(
      `${passLabel}: 確定 ${confirmed.length} 件 / 棄却 ${rejected.length} 件 / 未検証 ${unverified.length} 件` +
        ` / 先行 ${REFUTE_MAJORITY} 票の一致で省いた反証 ${skipped} 体` +
        ` / 反証せず提示する ${REVISE_SEVERITIES.join('/')} 以外の指摘 ${reportedMinor.length} 件`
    )
    return { confirmed, rejected, unverified, reported_minor: reportedMinor }
  })
}

function tag(dir, findings) {
  // 反証者は対象ファイルを自分で Read するため、どのディレクトリを見るかを finding に載せる。
  return findings.map((f) => ({ ...f, __dir: dir }))
}

function byCategory(missing, confirmed, unavailable = []) {
  const out = {}
  for (const f of ACTIVE_FINDERS) {
    // 欠測は 0 件ではなく null。0 と書くと「見たが何も無かった」と読まれる。
    if (unavailable.includes(f.id)) out[f.id] = UNAVAILABLE
    else out[f.id] = missing.includes(f.id) ? null : confirmed.filter((c) => c.category === f.id).length
  }
  return out
}

// 指摘の同一性は 2 段階で見る。厳密キーは (観点, ファイル, 主張)、粗いキーは (観点, ファイル)。
// script は意味の一致を見られないので、文言が変わっただけの指摘は厳密キーでは別件になる。
// 粗いキーだけが一致したものは possibly_rephrased として残し、人間が判断する材料にする。
// ファイル表記は `./SKILL.md` と `SKILL.md` のような揺れが出る。文字列一致で突き合わせる
// 以上、揺れは resolved を unobserved に倒す（安全側だが誤判定）。先頭の `./` だけ正規化する。
// この正規化の正本は scripts/diff_findings.py。片方だけ変えると、同じ「同じ指摘か」の問いに
// 2 つの答えが生まれる（resolved/new の突き合わせと、下の乾き判定がどちらもこのキーで動く）。
const normPath = (p) => String(p).replace(/^\.\//, '')

function keyOf(f) {
  return [f.category, normPath(f.file), String(f.claim).trim().toLowerCase().replace(/\s+/g, ' ')].join('::')
}

function coarseKeyOf(f) {
  return [f.category, normPath(f.file)].join('::')
}

// Reverify で観点ごとに報告させるファイル。updater の変更ファイルに、その観点で再確認する
// 指摘のファイルを足す。後者を足さないと、変更されなかったファイルに残る指摘が報告されず、
// 消えたように見えて resolved に化ける。
function scopeFilesFor(reverifyScope, category) {
  return new Set([
    ...reverifyScope.changedFiles,
    ...reverifyScope.recheck.filter((f) => f.category === category).map((f) => normPath(f.file)),
  ])
}

// updater に渡すのは直すのに要る欄だけ。票や理由まで渡すと、反証の議論を改稿の指示と読み違える。
function forUpdater(c) {
  return {
    id: c.id,
    category: c.category,
    file: c.file,
    location: c.location,
    claim: c.claim,
    evidence: c.evidence,
    severity: c.severity,
    suggested_fix: c.suggested_fix,
  }
}

// ------------------------------------------------------------------------- Find / Verify

phase('Find')
const findUnavailableAllowed = new Set(
  promptAuditExpected ? [] : ACTIVE_FINDERS.filter((f) => f.may_be_unavailable).map((f) => f.id)
)
const first = await runFinders(skillPath, 'Find', 'p1', 'source', null, findUnavailableAllowed)

phase('Verify')
const base = await verifyFindings(tag(skillPath, first.findings), 'Verify', 'before')

// 比較の基準は常にこの最初の確定指摘。改稿を 2 回以上重ねたときに直前のラウンドと比べると、
// 1 度直った指摘がぶり返しても「元から無かった」ことになり、resolved が水増しされる。
const originalConfirmed = base.confirmed

const beforeCategories = byCategory(first.missing, base.confirmed, first.unavailable)
const reviewIncomplete = first.missing.length > 0
let reverifyProvenance = null
let reverifyMissing = []
let reverifyUnavailable = null
let reverifyDeclared = null
if (reviewIncomplete) {
  log(`観点 ${first.missing.join(', ')} が未実施のため、この結果は網羅していません。`)
}

function receiptOf(stagingDir, afterCategories) {
  const observed = Object.fromEntries(Object.entries(afterCategories).filter(([, value]) => value !== UNAVAILABLE))
  return {
    phase: 'Reverify',
    staging_dir: stagingDir,
    fresh_thread: true,
    completed:
      Object.keys(observed).length > 0 && Object.values(observed).every((value) => Number.isSafeInteger(value)),
    by_category: observed,
    skipped_unavailable: Object.keys(afterCategories).filter((id) => afterCategories[id] === UNAVAILABLE),
    ...reverifyProvenance,
  }
}

function result(verdict, findings, findingsSource, afterCategories, staging, revisionsUsed, uncheckedFailures, stopReason) {
  return {
    mode,
    // update で、どの出口で止まったか。needs_human_decision は複数の出口が共有するので、
    // verdict だけでは「乾いた」「停滞した」「予算が尽きた」「blocker を検証しきれない」が区別できない。
    stop_reason: stopReason,
    // 委譲項目の未達。findings と分けているのは、反証を通っていないため
    // （confirmed に混ぜると「反証を生き残った指摘」という意味が薄まる）。
    // audit は委譲項目を判定する観点を走らせないので null（[] だと「全部満たした」と読まれる）。
    unchecked_failures: mode === 'audit' ? null : uncheckedFailures || [],
    // 依存する skill が実行環境に無く実施できなかった観点。欠測（by_category の null・review_incomplete）
    // とは別枠で、見ていない観点として必ず提示する。
    skipped_unavailable: { before: first.unavailable, after: reverifyUnavailable },
    // prompt-audit が挙げたが PROMPT_AUDIT_SEVERITY の外のため指摘にしなかった項目。反証も改稿もしないが、
    // 結果に残さないと「監査が見て何も言わなかった」と区別できない。
    declared_only: { before: first.declaredOnly, after: reverifyDeclared },
    target: { skillPath, scope, diffRef: diffRef || null, focus },
    verdict,
    findings,
    // update の findings は再検証後のものに置き換わり、Reverify は報告範囲を絞るので、
    // 改稿前の棄却・未検証・reported_minor は再登場しないことがある。持ち越さないと結果から黙って消える。
    findings_before: mode === 'update' ? base : null,
    // findings がどちらの検査パスのものかを明示する。改稿後の結果を改稿前のものと
    // 取り違えると、「まだ直っていない」と「もう直した」が逆に読める。
    findings_source: findingsSource,
    // before は最初の Find、after は Reverify。after が null なのは「そのパスが走らなかった」、
    // before.<観点> が null なのは「走ったがその観点の担当が応答しなかった」で、意味が違う。
    by_category: { before: beforeCategories, after: afterCategories },
    reverify_missing: reverifyMissing,
    staging,
    // runner 経由の update では action package の発行条件になる。Reverify が走らなかった
    // outcome を completed と偽装しないため、after の全観点が観測済みのときだけ true にする。
    // 依存 skill が無く実施できなかった観点は by_category から外して skipped_unavailable に宣言する。
    // 含めると、その skill を持たない Codex runner では receipt が永久に完了せず update が通らない。
    reverify_receipt:
      mode === 'update' && staging && afterCategories && reverifyProvenance
        ? receiptOf(staging.dir, afterCategories)
        : null,
    revisions_used: revisionsUsed,
  }
}

if (mode === 'review' || mode === 'audit') {
  // 確定が 0 件でも未検証が残っていれば clean とは言わない。未検証を clean に丸めると、
  // 「未検証と問題なしを区別する」ために置いた 3 バケットが結果表示で 1 つに戻る。
  // 委譲項目の未達も clean を妨げる。機械検査が判定せず、委譲先も判定しなかった項目が
  // 残っているなら、見ていない箇所があるという点で未検証と同じ。反証に回さなかった
  // reported_minor も同じ理由で clean を妨げる（検証していないものを「問題なし」と言わない）。
  // 実施できなかった観点（skipped_unavailable）も同じで、残りが空でも clean ではなく
  // clean_except_unavailable にする。
  const nothingFound =
    base.confirmed.length === 0 &&
    base.unverified.length === 0 &&
    base.reported_minor.length === 0 &&
    first.uncheckedFailures.length === 0
  const verdict = reviewIncomplete
    ? 'review_incomplete'
    : !nothingFound
      ? 'findings'
      : first.unavailable.length > 0
        ? 'clean_except_unavailable'
        : 'clean'
  return result(verdict, base, 'before', null, null, 0, first.uncheckedFailures, null)
}

// -------------------------------------------------------------------------------- Update

// 観点が欠けたまま改稿しない。部分的な絵から書き換えるのは、見えていない箇所を
// 「問題なし」と決めつけて手を入れるのと同じで、止まる方が安全。
if (reviewIncomplete) {
  return result('review_incomplete', base, 'before', null, null, 0, first.uncheckedFailures, 'review_incomplete')
}

// 最後に完了した検査パスの委譲項目未達。update では Reverify の結果で上書きする。
let latestUnchecked = first.uncheckedFailures

let revision = 0
// revisions_used は「起動した updater の数 − 1」。revision は巡の番号として巡の末尾で進むので、
// 巡の頭で止まる出口（budget）では実際の起動数より 1 多くなる。
let updatesRun = 0
let staging = null
let latest = base
let latestSource = 'before'
let afterCategories = null
let verdict = null
let stopReason = null
// 前巡の未解消指摘の同一性キー集合。null は「まだ 1 巡もしていない」で、比較対象が無い。
// 乾き判定（前巡と 1 件も違わなければ打ち切る）のためだけに持つ。
let prevUnresolvedKeys = null
let prevUnresolvedFindings = []
// 停滞判定の状態。最小値は「これまでに到達した最良の未解消件数」で、更新できない巡を数える。
let minUnresolvedCount = null
let stallStreak = 0
// typeof で見るのは、budget を持たない実行環境（Codex runner・単体テスト）では識別子
// そのものが存在せず、参照しただけで ReferenceError になるため。そこではこの停止は働かない。
const roundBudget = typeof budget !== 'undefined' && budget && budget.total ? budget : null

// 回数上限を持たないループ。出口は break だけで、どれも stop_reason を設定する（値の正本は schemas.md）。
while (true) {
  if (roundBudget && roundBudget.remaining() < MIN_ROUND_BUDGET_TOKENS) {
    log(
      `budget の残り ${roundBudget.remaining()} token が 1 巡の見積もり ${MIN_ROUND_BUDGET_TOKENS} を下回るため、` +
        '次の改稿を始めずに現時点の結果を返します。'
    )
    verdict = 'needs_human_decision'
    stopReason = 'budget'
    break
  }
  phase('Update')
  const updaterThreadId = `update-r${revision + 1}`
  // confirmed が 0 件でも updater は走らせる。intent は必須引数であり、
  // 「レビューでは問題が出ないが依頼された変更はある」場合（Issue 起点の更新が典型）に
  // confirmed の有無で門を作ると、update が黙って何もしないモードになる。
  // reported_minor は渡さない。反証していない指摘で改稿を広げると、変更ファイルが増えて
  // Reverify の範囲と新規指摘が膨らむ。
  updatesRun++
  const changed = await roleAgent(
    'updater.md',
    [
      `[TARGET_DIR]: ${skillPath}`,
      `[STAGING_DIR]: ${stagingDir}`,
      `[INTENT]:\n${intent}`,
      `[CONFIRMED_FINDINGS]:\n${JSON.stringify(originalConfirmed.map(forUpdater), null, 2)}`,
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
        ? // ループを回した未解消の集合そのものを渡す。一部（残存・新規）だけを渡すと、再分類や
          // 再確認で未検証になった指摘が周回の理由なのに updater には見えず、同じ状態で回り続ける。
          `[REVISE_NOTE]:\n前回の改稿後も未解消の指摘がある。下の unresolved を解消すること。\n${JSON.stringify(
            { unresolved: prevUnresolvedFindings.map(forUpdater) },
            null,
            2
          )}`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
    { model: 'opus', effort: 'high', schema: UPDATE_SCHEMA, phase: 'Update', label: updaterThreadId }
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
      preexisting: [],
      still_unverified: [],
      refuted_on_recheck: [],
      unverified_absent: [],
      unverified_unobserved: [],
      reverify_scope: null,
    }
    verdict = 'update_failed'
    stopReason = 'update_failed'
    break
  }
  log(`staging に ${changed.changed_files.length} ファイルを書きました（改稿 ${revision + 1} 回目）`)
  if (changed.changed_files.length === 0) {
    log('updater は応答したが変更ファイルを 1 つも報告しなかった。改稿が空のまま再検証に入る。')
  }

  // 再確認の対象は「最初の確定指摘 ∪ 改稿前に未検証だった REVISE_SEVERITIES ∪ 前巡の未解消」。
  // 最初の確定指摘を毎巡含めるのは、resolved / remaining がそれとの突き合わせで決まるため ——
  // updater は毎巡原本から複製し直してよいので、前巡で直ったファイルが今巡は原本に戻っていることが
  // あり、再確認しないとぶり返しが報告されない。未検証を含めるのは、変更されないファイルにある
  // 未検証の blocker が範囲外として反証されないまま消え、blocker ゲートを素通りするため。
  // 委譲項目の未達は [UNCHECKED_ITEMS] で毎回判定し直すので含めない。
  const recheckByKey = new Map()
  for (const f of [...originalConfirmed, ...base.unverified, ...prevUnresolvedFindings]) {
    if (!recheckByKey.has(keyOf(f))) recheckByKey.set(keyOf(f), f)
  }
  const reverifyScope = {
    changedFiles: changed.changed_files.map((c) => normPath(c.path)),
    recheck: [...recheckByKey.values()],
  }
  log(
    `再検証の報告範囲: 変更ファイル ${reverifyScope.changedFiles.length} 件 + 再確認する指摘 ` +
      `${reverifyScope.recheck.length} 件のファイル（観点ごと）。それ以外のファイルは改稿前と同じ内容のため` +
      '再走査せず、[INTENT] 未達の指摘だけを範囲外でも受け付ける。'
  )

  phase('Reverify')
  let reverifyPassLabel = `p2r${revision + 1}`
  let freshThreadId = `find-${FINDERS[0].id}-${reverifyPassLabel}`
  // Reverify で unavailable を受け付けるのは、Find でも実施できなかった観点だけ。Find で実施できた観点が
  // Reverify だけ「無い」と返すと、確定指摘が再確認されないまま resolved / unobserved に流れ、
  // receipt からも外れて update が通ってしまう。欠測にして既存の再試行と reverify_incomplete へ回す。
  const reverifyUnavailableAllowed = new Set(promptAuditExpected ? [] : first.unavailable)
  let after = await runFinders(stagingDir, 'Reverify', reverifyPassLabel, 'draft', reverifyScope, reverifyUnavailableAllowed)
  reverifyMissing = after.missing
  reverifyUnavailable = after.unavailable
  reverifyDeclared = after.declaredOnly
  if (after.missing.length > 0) {
    log(`再検証の欠測（${after.missing.join(', ')}）を保持したまま、全体を 1 回だけ再試行します。`)
    reverifyPassLabel = `${reverifyPassLabel}-retry`
    freshThreadId = `find-${FINDERS[0].id}-${reverifyPassLabel}`
    after = await runFinders(stagingDir, 'Reverify', reverifyPassLabel, 'draft', reverifyScope, reverifyUnavailableAllowed)
    reverifyMissing = after.missing
    reverifyUnavailable = after.unavailable
    reverifyDeclared = after.declaredOnly
  }
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
      preexisting: [],
      still_unverified: [],
      refuted_on_recheck: [],
      unverified_absent: [],
      unverified_unobserved: [],
      reverify_scope: null,
      reverify_missing: after.missing,
    }
    afterCategories = byCategory(after.missing, [], after.unavailable)
    reverifyProvenance = { updater_thread_id: updaterThreadId, fresh_thread_id: freshThreadId }
    verdict = 'reverify_incomplete'
    stopReason = 'reverify_incomplete'
    break
  }

  // 報告範囲の外の指摘は反証に回さない。範囲外のファイルは改稿前と同じ内容なので、そこで
  // present_in_original: true の指摘は改稿が持ち込んだものではなく、改稿を動かす材料にならない。
  // true 以外を範囲内に残すのは、[INTENT] 未達の指摘は原本と同一のファイルでも false になり、
  // 外すと未達が隠れるため（changed_files の申告漏れも同じ形で現れる）。
  const inReverifyScope = (f) =>
    scopeFilesFor(reverifyScope, f.category).has(normPath(f.file)) || f.present_in_original !== true
  const scopedFindings = after.findings.filter(inReverifyScope)
  const excludedByScope = after.findings.filter((f) => !inReverifyScope(f))
  if (excludedByScope.length > 0) {
    log(
      `報告範囲の外で原本にもある指摘 ${excludedByScope.length} 件は反証せず、` +
        'staging.reverify_scope.excluded_findings に未検証のまま残します。'
    )
  }

  const post = await verifyFindings(tag(stagingDir, scopedFindings), 'Reverify', 'after')

  const beforeKeys = new Set(originalConfirmed.map(keyOf))
  const afterKeys = new Set(post.confirmed.map(keyOf))
  // 反証に回さなかった minor も「まだ在る」側に数える。最初の確定指摘が severity を下げて
  // 再報告されたとき、post.confirmed に無いからと resolved に数えると、消えていないものが
  // 解消済みに化ける。remaining に置くが REVISE_SEVERITIES の外なので改稿は動かさない。
  const minorAfter = post.reported_minor.filter((f) => beforeKeys.has(keyOf(f)))
  // 再報告されたが確定しなかった最初の確定指摘も「消えた」ではない。未検証になったものは
  // 直ったと確かめられていないので未解消に数え、棄却されたものは反証の結果として別枠に置く。
  const stillUnverified = post.unverified.filter((f) => beforeKeys.has(keyOf(f)))
  const refutedOnRecheck = post.rejected.filter((f) => beforeKeys.has(keyOf(f)))
  // prompt-audit の確定指摘が、改稿で手の入っていないファイルから消えたときは解消と数えず残存に置く。
  // 外部の監査は実行ごとに確信度が揺れる。規則どおりなら再確認中の指摘は確信度に関わらず findings か
  // declared_only で戻り mapAuditItems が拾うが、規則に従わない finder は note に書くだけのことがあり、
  // ここはその場合の受け皿。ファイルが変わっていない以上、消えたことは直った証拠にならない。
  const changedSet = new Set(reverifyScope.changedFiles)
  const auditCarried = originalConfirmed.filter(
    (f) =>
      f.category === AUDIT_CATEGORY &&
      !changedSet.has(normPath(f.file)) &&
      ![...afterKeys, ...minorAfter.map(keyOf), ...stillUnverified.map(keyOf), ...refutedOnRecheck.map(keyOf)].includes(
        keyOf(f)
      )
  )
  if (auditCarried.length > 0) {
    log(`prompt-audit の確定指摘 ${auditCarried.length} 件は、変更の無いファイルから消えたため解消とせず残存に数えます。`)
  }
  const presentAfterKeys = new Set(
    [
      ...afterKeys,
      ...minorAfter.map(keyOf),
      ...stillUnverified.map(keyOf),
      ...refutedOnRecheck.map(keyOf),
      ...auditCarried.map(keyOf),
    ]
  )
  // 「新規」の基準は改稿前に確定した指摘ではなく、改稿前に**見えていた**指摘全体。
  // 改稿前に unverified / rejected / reported_minor だったものが再検証で票が揃って確定しても、
  // それは改稿が持ち込んだ問題ではなく反証の結果（や severity の付け方）が変わっただけ。
  // new は「改稿で悪くなっていないか」を人間が判断する唯一の数字なので、ここに混ぜると
  // 承認判断が直接歪む。
  const beforeSeenKeys = new Set(
    [...base.confirmed, ...base.unverified, ...base.rejected, ...base.reported_minor].map(keyOf)
  )

  // 「消えた」ように見える指摘のうち、再検証でそのファイルを誰も開かなかったものは
  // resolved に数えない。読まなかっただけかもしれず、それを解消として数えると
  // 改稿の効果が水増しされる。観測の有無は指摘と同じ観点の finder の scanned_files で見る
  // （別観点の担当が読んでいても、この観点で見られたことにはならない）。報告範囲の外の
  // ファイルは読まれていても報告させていないので、そこで消えたものも解消とは数えない。
  const observedIn = (f) =>
    (after.scannedByCategory[f.category] || []).map(normPath).includes(normPath(f.file)) &&
    scopeFilesFor(reverifyScope, f.category).has(normPath(f.file))
  const resolved = []
  const unobserved = []
  for (const f of originalConfirmed) {
    if (presentAfterKeys.has(keyOf(f))) continue
    if (observedIn(f)) resolved.push(f)
    else unobserved.push(f)
  }
  // 改稿前に未検証だった指摘も同じ観測の問いにかける。再確認させても、再報告されなかったときの
  // 行き先が無いと結果から黙って消える。観測したうえで消えたもの（unverified_absent）は、確定した
  // ことが無いので解消とは呼ばず提示だけする。観測できなかったもの（unverified_unobserved）の
  // blocker は unobserved と同じく自動確定させない。
  const seenAfterKeys = new Set(
    [...post.confirmed, ...post.unverified, ...post.rejected, ...post.reported_minor].map(keyOf)
  )
  const unverifiedAbsent = []
  const unverifiedUnobserved = []
  for (const f of base.unverified) {
    if (seenAfterKeys.has(keyOf(f))) continue
    if (observedIn(f)) unverifiedAbsent.push(f)
    else unverifiedUnobserved.push(f)
  }

  const remaining = [...post.confirmed.filter((f) => beforeKeys.has(keyOf(f))), ...minorAfter, ...auditCarried]
  const notOriginal = post.confirmed.filter((f) => !beforeKeys.has(keyOf(f)))
  const reclassified = notOriginal.filter((f) => beforeSeenKeys.has(keyOf(f)))
  // 改稿前の Find が見落とした既存の問題は reclassified に落ちずに new へ入る。
  // finder の非決定性由来で前後の Find 結果の差からは区別できないので、
  // 再検証の finder が原本を照合した present_in_original を唯一の材料にして分ける。
  // 実在する確定指摘であることに変わりはないので提示はするが、「改稿が持ち込んだ」数字と
  // blocker 判定からは外す（改稿前にも同じ状態だったものを改稿の副作用として止めない）。
  const candidates = notOriginal.filter((f) => !beforeSeenKeys.has(keyOf(f)))
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
      `再分類 ${reclassified.length} / 既存 ${preexisting.length} / 範囲外で未検証 ${excludedByScope.length} / ` +
      `再確認で未検証 ${stillUnverified.length} / 再確認で棄却 ${refutedOnRecheck.length} / ` +
      `改稿前未検証のうち観測して消えた ${unverifiedAbsent.length} / 観測できなかった ${unverifiedUnobserved.length}`
  )
  if (minorAfter.length > 0) {
    log(`残存のうち ${minorAfter.length} 件は severity を下げて再報告された最初の確定指摘（反証していない）。`)
  }
  if (preexisting.length > 0) {
    log(`既存 ${preexisting.length} 件は引用が改稿前の原本にもそのまま存在する指摘（改稿が持ち込んだものではない）。`)
  }
  if (reclassified.length > 0) {
    log(`うち ${reclassified.length} 件は改稿前に未検証・棄却・minor だった指摘が再検証で確定したもの（改稿が持ち込んだものではない）。`)
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
    preexisting,
    still_unverified: stillUnverified,
    refuted_on_recheck: refutedOnRecheck,
    unverified_absent: unverifiedAbsent,
    unverified_unobserved: unverifiedUnobserved,
    // 再検証が何を見なかったかの宣言。report_files（観点ごと）の外は指摘を報告させておらず、
    // excluded_findings は finder が範囲外で返したため反証に回さなかった指摘（未検証・未分類）。
    reverify_scope: {
      changed_files: reverifyScope.changedFiles,
      recheck_ids: reverifyScope.recheck.map((f) => f.id),
      report_files: Object.fromEntries(FINDERS.map((f) => [f.id, [...scopeFilesFor(reverifyScope, f.id)]])),
      excluded_findings: excludedByScope,
    },
    reverify_missing: [],
  }
  latest = post
  latestSource = 'after'
  afterCategories = byCategory(after.missing, post.confirmed, after.unavailable)
  reverifyProvenance = { updater_thread_id: updaterThreadId, fresh_thread_id: freshThreadId }

  // 未検証の blocker は「検証が足りない」であって「直っていない」ではない。改稿を繰り返しても
  // 有効票は増えないので、ここで再改稿に回すと予算だけを消費する。人間の判断へ倒す。
  // unobserved も同じ扱い。「消えたのか、誰も見なかったのか」が分からない blocker を
  // 解消扱いで通すと、再検証していない改稿が applied_to_staging になる。
  const unverifiedBlockers = post.unverified.filter((f) => f.severity === 'blocker')
  const unobservedBlockers = [...unobserved, ...unverifiedUnobserved].filter((f) => f.severity === 'blocker')
  // 最初の blocker が再確認で棄却された、または minor に格下げされて反証を通らずに戻ったとき、
  // 改稿で手が入っていない（ファイルが変更されていない、または引用が原本にもある）なら、直った
  // 証拠ではなく Verify と Reverify の判定が割れただけ。重さは再報告側ではなく最初の確定時の値で見る。
  const originalSeverity = new Map(originalConfirmed.map((f) => [keyOf(f), f.severity]))
  const contestedBlockers = [...refutedOnRecheck, ...minorAfter].filter(
    (f) =>
      originalSeverity.get(keyOf(f)) === 'blocker' &&
      (!changedSet.has(normPath(f.file)) || f.present_in_original === true)
  )
  if (unverifiedBlockers.length > 0 || unobservedBlockers.length > 0 || contestedBlockers.length > 0) {
    log(
      `未検証 ${unverifiedBlockers.length} 件 / 未観測 ${unobservedBlockers.length} 件 / ` +
        `改稿なしで判定が割れた ${contestedBlockers.length} 件の blocker があるため、自動では確定させません。`
    )
    verdict = 'needs_human_decision'
    stopReason =
      unverifiedBlockers.length > 0 || unobservedBlockers.length > 0 ? 'unverified_blocker' : 'contested_blocker'
    break
  }

  // reclassified は「改稿が持ち込んだ」ものではないが、ドラフトに実在する確定指摘ではある。
  // new から外すのは提示上の分類であって、承認判断から外す理由にはならない。
  // 委譲項目の未達も未解消に数える。改稿で満たせる種類のもの（検証者経路を足す・参照を
  // 整合させる）なので、ループへ戻す。
  latestUnchecked = after.uncheckedFailures
  const unresolvedFindings = [...remaining, ...stillUnverified, ...introduced, ...reclassified].filter((f) =>
    REVISE_SEVERITIES.includes(f.severity)
  )
  const unresolved = [
    ...unresolvedFindings,
    ...after.uncheckedFailures.filter((f) => REVISE_SEVERITIES.includes(f.severity)),
  ]
  if (unresolved.length === 0) {
    verdict = 'applied_to_staging'
    stopReason = 'resolved'
    break
  }

  // 乾き判定。未解消指摘の同一性キー集合が前巡から動かなかった（1 件も解消されず、新規も
  // 出なかった）なら、同じ入力で回し続けても結果は変わらない。キーは keyOf（= diff_findings.py
  // と同じ規則。正規化を別に書き起こすと判定が 2 つになる）。
  // possibly_rephrased は文言が変わると厳密キーも変わるため「動いた」と出る。その揺れや
  // present_in_original の揺れで集合が毎巡変わる場合は、下の停滞判定が止める。
  const unresolvedKeys = new Set(unresolved.map(keyOf))
  const dried =
    prevUnresolvedKeys !== null &&
    prevUnresolvedKeys.size === unresolvedKeys.size &&
    [...unresolvedKeys].every((k) => prevUnresolvedKeys.has(k))
  if (dried) {
    log(
      `${REVISE_SEVERITIES.join('/')} ${unresolved.length} 件が前回の改稿から 1 件も動きませんでした` +
        '（解消も新規も無し）。同じ入力では収束しないため人間の判断へ返します。'
    )
    verdict = 'needs_human_decision'
    stopReason = 'dried'
    break
  }

  // 停滞判定。集合は動いていても件数が最良値を更新しないなら、直した分だけ新しく湧いている。
  if (minUnresolvedCount === null || unresolved.length < minUnresolvedCount) {
    minUnresolvedCount = unresolved.length
    stallStreak = 0
  } else {
    stallStreak++
  }
  log(
    `未解消 ${REVISE_SEVERITIES.join('/')} ${unresolved.length} 件（これまでの最小 ${minUnresolvedCount} 件 / ` +
      `最小を更新しない巡 ${stallStreak}/${STALL_ROUNDS}）`
  )
  if (stallStreak >= STALL_ROUNDS) {
    log(
      `未解消の件数が ${STALL_ROUNDS} 巡続けて最小 ${minUnresolvedCount} 件を下回りませんでした。` +
        '直した分だけ新しい指摘が出ており収束しないため人間の判断へ返します。'
    )
    verdict = 'needs_human_decision'
    stopReason = 'stalled'
    break
  }

  prevUnresolvedKeys = unresolvedKeys
  prevUnresolvedFindings = unresolvedFindings
  revision++
}

return result(
  verdict,
  latest,
  latestSource,
  afterCategories,
  staging,
  Math.max(0, updatesRun - 1),
  latestUnchecked,
  stopReason
)
