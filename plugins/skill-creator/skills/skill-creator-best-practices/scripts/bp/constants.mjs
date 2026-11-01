export const OPS = Object.freeze({
  start: 'start',
  premise: 'premise',
  stageStart: 'stage-start',
  itemResult: 'item-result',
  itemFail: 'item-fail',
  stageRepeat: 'stage-repeat',
  stageFinish: 'stage-finish',
  discard: 'discard',
  files: 'files',
  stop: 'stop',
  summary: 'summary',
  list: 'list',
  ledgerCreate: 'ledger-create',
  ledgerRetake: 'ledger-retake',
  assignments: 'assignments',
  verdicts: 'verdicts',
  refutationItems: 'refutation-items',
  refutation: 'refutation',
  reviewJudge: 'review-judge',
  vanishMatch: 'vanish-match',
  report: 'report',
  kinds: 'kinds',
  key: 'key',
  paths: 'paths',
  pathsRetake: 'paths-retake',
  snapshot: 'snapshot',
  goalCheck: 'goal-check',
  filesScan: 'files-scan',
  units: 'units',
  gate: 'gate',
  outcome: 'outcome',
  targets: 'targets',
  bundle: 'bundle',
  applicability: 'applicability',
  stopDraft: 'stop-draft',
  placement: 'placement',
  record: 'record',
});

// 送り直しで記録が増えないことをテストが操作ごとに照らすので、書き込みの操作の集合はここだけに置く。
export const WRITE_OPS = Object.freeze([
  OPS.start, OPS.premise, OPS.stageStart, OPS.itemResult, OPS.itemFail, OPS.stageRepeat, OPS.stageFinish, OPS.discard,
  OPS.files, OPS.stop, OPS.ledgerCreate, OPS.ledgerRetake, OPS.assignments, OPS.verdicts, OPS.refutation, OPS.reviewJudge,
  OPS.vanishMatch, OPS.pathsRetake, OPS.snapshot, OPS.goalCheck, OPS.filesScan, OPS.gate, OPS.targets, OPS.bundle, OPS.applicability,
  OPS.placement, OPS.record,
]);

// 入口（SKILL.md）だけが呼ぶ読み出しの操作。run の中の script は呼ばないので、script が写す OPS と分ける（分けないと、入口の操作を足すたびに script の写しが変わる）。
export const ENTRY_OPS = Object.freeze({ chainCheck: 'chain-check', chainNext: 'chain-next', launchArgs: 'launch-args', chainReport: 'chain-report' });
export const ROUTES = Object.freeze({ native: 'native', codex: 'codex' });
export const LAUNCH_KINDS = Object.freeze({ new: 'new', resume: 'resume' });
export const WORKFLOW_SOURCES = Object.freeze({ author: 'best-practices-author', inspect: 'best-practices-inspect' });

export const FUNCTION = Object.freeze({ create: 'create', review: 'review', update: 'update', audit: 'audit' });
export const FUNCTIONS = Object.freeze(Object.values(FUNCTION));
export const REWRITING_FUNCTIONS = new Set([FUNCTION.create, FUNCTION.update]);
export const INSPECTING_FUNCTIONS = new Set([FUNCTION.review, FUNCTION.audit]);

export const STOP_KINDS = Object.freeze({
  complete: 'complete',
  needsInput: 'needs_input',
  iterationLimit: 'iteration_limit',
  blocked: 'blocked',
});
export const LIMIT_HITS = Object.freeze({ iteration: 'iteration', launch: 'launch' });
// 書き直さずに検証し直す再開（SP-BPAUTHORING-005 のただし書き）に当てる BLOCKED の原因の区分。
export const STOP_CAUSES = Object.freeze({ verifiers: 'verifiers', formalUnrunnable: 'formalUnrunnable', formalFailed: 'formalFailed' });
const REWRITING_STOPS = Object.freeze([STOP_KINDS.complete, STOP_KINDS.needsInput, STOP_KINDS.iterationLimit, STOP_KINDS.blocked]);
const INSPECTING_STOPS = Object.freeze([STOP_KINDS.complete, STOP_KINDS.iterationLimit, STOP_KINDS.blocked]);
export const STOP_KINDS_BY_FUNCTION = Object.freeze({
  [FUNCTION.create]: REWRITING_STOPS,
  [FUNCTION.update]: REWRITING_STOPS,
  [FUNCTION.review]: INSPECTING_STOPS,
  [FUNCTION.audit]: INSPECTING_STOPS,
});

export const NEXT_ARGS_KEYS = Object.freeze({ function: 'function', state: 'state' });

export const LIMIT_KEYS = Object.freeze({ attempts: 'attempts', iterations: 'iterations', untilPass: 'untilPass' });

export const PREMISE_KINDS = Object.freeze(['answer', 'goal']);

export const STAGE = Object.freeze({
  start: 'start',
  snapshot: 'snapshot',
  goal: 'goal',
  write: 'write',
  ledger: 'ledger',
  targets: 'targets',
  bundle: 'bundle',
  assign: 'assign',
  applicability: 'applicability',
  verify: 'verify',
  verifyExtra: 'verify-extra',
  refute: 'refute',
  vanish: 'vanish',
  rejudge: 'rejudge',
  gate: 'gate',
  formal: 'formal',
  close: 'close',
});
export const STAGES = Object.freeze({
  [STAGE.start]: '開始',
  [STAGE.snapshot]: '作り直す前の写し',
  [STAGE.goal]: '目標の固定',
  [STAGE.write]: '書く',
  [STAGE.ledger]: '台帳',
  [STAGE.targets]: '照らす先の決定',
  [STAGE.bundle]: '台帳の作成と資産の束',
  [STAGE.assign]: '担当の作成',
  [STAGE.applicability]: '適用の判定',
  [STAGE.verify]: '検証',
  [STAGE.verifyExtra]: '追加の検証',
  [STAGE.refute]: '反証',
  [STAGE.vanish]: '消えた資産の照合',
  [STAGE.rejudge]: '見直し',
  [STAGE.gate]: '合否',
  [STAGE.formal]: '形式検証',
  [STAGE.close]: '照合と停止',
});
export const VERIFY_STAGES = new Set([STAGE.verify, STAGE.verifyExtra]);
// review・audit の段の並び（SP-BPINSPECTION-001。消えた資産の照合は再開の開始の取り直しにだけ伴うので並びに入れない）。再開した run はこの順で止まった段を決める。
export const INSPECT_PIPELINE = Object.freeze([STAGE.targets, STAGE.bundle, STAGE.assign, STAGE.applicability, STAGE.verify, STAGE.verifyExtra, STAGE.refute, STAGE.close]);
export const STAGE_STATUS = Object.freeze({ open: 'open', finished: 'finished', none: 'none', stopped: 'stopped' });

export const RECORDS = Object.freeze({
  state: 'state',
  ground: 'ground',
  run: 'run',
  premise: 'premise',
  paths: 'paths',
  fingerprint: 'fingerprint',
  stage: 'stage',
  result: 'result',
  fail: 'fail',
  abort: 'abort',
  discard: 'discard',
  stageEnd: 'stageEnd',
  repeat: 'repeat',
  file: 'file',
  verified: 'verified',
  stop: 'stop',
  ledger: 'ledger',
  asset: 'asset',
  digest: 'digest',
  gone: 'gone',
  assignment: 'assignment',
  seen: 'seen',
  candidate: 'candidate',
  dup: 'dup',
  rejected: 'rejected',
  refute: 'refute',
  unrefuted: 'unrefuted',
  finding: 'finding',
  fstate: 'fstate',
  judgement: 'judgement',
  addAsset: 'addAsset',
  snapshot: 'snapshot',
  extra: 'extra',
  target: 'target',
  bundle: 'bundle',
  applicability: 'applicability',
  placement: 'placement',
  workLog: 'workLog',
});
export const FINGERPRINT_AT = Object.freeze({ start: 'start', retake: 'retake', stop: 'stop' });
export const FILE_ACTIONS = Object.freeze({ write: 'write', delete: 'delete' });
export const ASSIGN_RULES = Object.freeze({ all: 'all', skip: 'skip' });
export const RESULT_KINDS = Object.freeze({ verdicts: 'verdicts', refutation: 'refutation', vanish: 'vanish' });
export const BASIS = Object.freeze({ upheld: 'upheld', rejected: 'rejected', noCandidate: 'no-candidate', unknown: 'unknown', vanish: 'vanish' });
export const RECORDED = Object.freeze({ state: 'state', judgement: 'judgement', none: 'none' });
export const REJECT_SCOPE = Object.freeze({ item: 'item:', assign: 'assign:', applicability: 'applicability' });
export const ROUND_PREFIX = Object.freeze({ refute: 'refute:', judge: 'judge:', vanish: 'vanish:' });
export const REVIEW_INPUT = Object.freeze({
  r: Object.freeze({ empty: 'empty', present: 'present' }),
  content: Object.freeze({ changed: 'changed', same: 'same' }),
  candidates: Object.freeze({ none: 'none', upheld: 'upheld', unrefuted: 'unrefuted', dup: 'dup', rejected: 'rejected', mixedDup: 'mixed_dup' }),
  judged: Object.freeze({ none: 'none', decided: 'decided', unsure: 'unsure' }),
});

export function emptyRunBase() {
  return { iterations: 0, repeats: {} };
}

export const INPUT_KEYS = Object.freeze({
  function: 'function',
  request: 'request',
  target: 'target',
  grounds: 'grounds',
  nextArgs: 'nextArgs',
  answer: 'answer',
  maxLaunches: 'maxLaunches',
  skillDir: 'skillDir',
  key: 'key',
  host: 'host',
});

export const RESULT_KEYS = Object.freeze({
  stopKind: 'stopKind',
  reason: 'reason',
  nextArgs: 'nextArgs',
  state: 'state',
  run: 'run',
  launches: 'launches',
  writtenFiles: 'writtenFiles',
  unverifiedRoleLimits: 'unverifiedRoleLimits',
  skill: 'skill',
  designNote: 'designNote',
  verification: 'verification',
  findings: 'findings',
  residualRisks: 'residualRisks',
  receivedGrounds: 'receivedGrounds',
  excludedCallsites: 'excludedCallsites',
  unverified: 'unverified',
  stoppedStage: 'stoppedStage',
  targets: 'targets',
  applicability: 'applicability',
  uncheckedViewpoints: 'uncheckedViewpoints',
  target: 'target',
  ledger: 'ledger',
  performance: 'performance',
  unsavedRecords: 'unsavedRecords',
  toDecide: 'toDecide',
  impact: 'impact',
  remainingWork: 'remainingWork',
});
export const VERIFICATION_KEYS = Object.freeze({
  decision: 'decision',
  iterations: 'iterations',
  units: 'units',
  forcedUnchecked: 'forcedUnchecked',
  basisConstraints: 'basisConstraints',
  contract: 'contract',
  ledger: 'ledger',
  checkedRoleLimits: 'checkedRoleLimits',
  formalVerification: 'formalVerification',
});
// 形式検証の段の result の欄と性質の結果（SP-BPRUN-031 の「形式検証の段の result」）。
export const FORMAL_KEYS = Object.freeze({ workRecord: 'workRecord', readable: 'readable', properties: 'properties' });
export const READABLE_KEYS = Object.freeze({ ok: 'ok', reason: 'reason' });
export const PROPERTY_KEYS = Object.freeze({ target: 'target', formalized: 'formalized', outcome: 'outcome', reason: 'reason' });
export const FORMAL_OUTCOMES = Object.freeze({ holds: 'holds', fails: 'fails', unrunnable: 'unrunnable', confirmed: 'confirmed', unconfirmed: 'unconfirmed' });
// 性能の記録の欄（SP-BPRUN-046）。
export const PERFORMANCE_KEYS = Object.freeze({ durationMs: 'durationMs', interventions: 'interventions', retries: 'retries', cost: 'cost' });
// 記録台帳の 1 つの記録の欄（SP-BPRUN-042）。role と item が作業記録の担当、attempt が試行の番号。
export const WORK_LOG_KEYS = Object.freeze({ role: 'role', item: 'item', attempt: 'attempt', path: 'path', evidence: 'evidence' });

export const GOAL_KEYS = Object.freeze({
  deliverables: 'deliverables',
  scope: 'scope',
  prohibitions: 'prohibitions',
  numeric: 'numeric',
  deixis: 'deixis',
});
export const SOURCE_KINDS = Object.freeze({ request: 'request', answer: 'answer', snapshot: 'snapshot', ground: 'ground' });
export const GROUND_INSTRUCTION = Object.freeze({ kindKey: 'kind', kind: '利用者の指示', textKey: 'text' });
// 前の review・audit の run の指摘を状態 ID で指す修正の根拠の形（SP-BPFINDINGS-031）。開始の操作が状態の返り値の指摘の一覧に展開する。
export const GROUND_REF_KEY = 'from';
export const SNAPSHOT_DIR = 'snapshot';
export const SNAPSHOT_PARTS = Object.freeze({ root: 'root', plugin: 'plugin' });

export const UNIT_RESULTS = Object.freeze({ conform: 'conform', nonconform: 'nonconform', na: 'na', unchecked: 'unchecked' });
// 照らした制限の結果（SP-BPAUTHORING-046）。値は仕様の字面そのまま。
// 照らした制限の配布先（SP-BPAUTHORING-046 は Claude Code での制限だけを照らす）。
export const CLAUDE_CODE_HOST = 'Claude Code';
export const ROLE_LIMIT_RESULTS = Object.freeze({ effective: '効く', ineffective: '効かない' });
export const UNCHECKED_KINDS = Object.freeze({ forced: 'forced', unforced: 'unforced' });
export const CONTRACT_ELEMENTS = Object.freeze(['発火する条件', '発火しない条件', '入力', '出力', '停止の種類']);
export const CONTRACT_NONE = 'none';
export const GATE_DECISIONS = Object.freeze({ pass: 'pass', fail: 'fail', unverifiable: 'unverifiable' });
export const FINDING_GATE = Object.freeze({ fail: 'fail', ok: 'ok', unverifiable: 'unverifiable' });
export const GATE_NEXT = Object.freeze({ formal: 'formal', rewrite: 'rewrite', iterationLimit: 'iterationLimit', blocked: 'blocked' });
export const ITERATION_STAGES = Object.freeze([STAGE.write, STAGE.ledger, STAGE.verify, STAGE.verifyExtra, STAGE.refute, STAGE.rejudge, STAGE.gate]);
// 追加の検証は「見た」が増えなくなるまで回を重ねるので、同じ段・回に部分の列挙を足せる段をここだけに置く（SP-BPFINDINGS-025）。
export const PARTED_STAGES = Object.freeze([STAGE.verifyExtra]);

export const VIEWPOINTS = Object.freeze({
  flow: 'フローの観点',
  spec: '仕様の観点',
  conformance: '適合の観点',
  goal: '目標の観点',
  contract: '契約の観点',
  audit: '監査の観点',
});
export const VIEWPOINT = Object.freeze(Object.fromEntries(Object.keys(VIEWPOINTS).map((k) => [k, k])));
export const PRESENCE_QUESTIONS = Object.freeze(['ledger', 'fanout']);

export const RUN_VIEWPOINTS = Object.freeze({
  create: Object.freeze(['conformance', 'goal']),
  update: Object.freeze(['conformance', 'goal', 'contract']),
  review: Object.freeze(['flow', 'spec']),
  audit: Object.freeze(['audit']),
});

// 適用の判定の閉集合（SP-BPINSPECTION-006 の表の選択肢と、SP-BPCONFORMANCE-003 の条件の値）。値は表の字面そのままにし、表との一致はテストが照らす。
export const APPLICABILITY_QUESTIONS = Object.freeze(['A', 'W', 'Q1', 'Q2', 'Q3']);
// 問い W の答えで置き場（answers か runs の要素）が決まる問い（SP-BPINSPECTION-006）。
export const SHAPE_QUESTIONS = Object.freeze(['Q1', 'Q2', 'Q3']);
export const RUN_SEQUENCE = 'sequence';
export const APPLICABILITY_ANSWERS = Object.freeze({ yes: 'はい', no: 'いいえ', unreached: '問いに到達しない' });
export const PRESENCE = Object.freeze({ present: '有', absent: '無' });
export const SHAPES = Object.freeze({ turn: 'ターンごとの指揮', pipeline: '固定パイプライン型', iterative: '固定集合の反復型', explore: '探索グラフ型' });
export const UNCHECKED_SCOPES = Object.freeze({ whole: 'whole', unit: 'unit', pa: 'pa' });
// SP-BPINSPECTION-012 の固定の 1 件。検証役に判断させないので、audit の完了のたびに CLI が状態から載せる。
export const FIXED_AUDIT_UNCHECKED = Object.freeze({
  value: 'PA-3',
  reason: 'PR-BPDESIGNEDSKILL-021・SP-BPCONFORMANCE-025: 起動数の上限を渡されない run で、fan-out の項目の件数と 1 run の起動数に上限が無いことに PA-3 を当てない（SP-BPINSPECTION-012）',
});

// 役の制限は host が役ごとに強制できない（SP-BPRUN-025）ので、どの run の返り値にも確かめられなかった制限として載せる。
export const ROLE_WRITE_LIMITS = Object.freeze([
  Object.freeze({ role: '書き手', writes: '対象スキルと作業ファイル' }),
  Object.freeze({ role: '検証役・反証役・抽出役', writes: '作業ファイルだけ' }),
  Object.freeze({ role: '運搬役', writes: 'CLI を通した状態だけ' }),
]);
// review・audit は書き手を起動しないので、確かめられなかった制限から書き手の行を除く（SP-BPRUN-025 の表は書き手を create・update だけとする）。
export const INSPECT_ROLE_WRITE_LIMITS = Object.freeze(ROLE_WRITE_LIMITS.slice(1));

export const JUDGEMENTS = Object.freeze({ candidate: 'candidate', ok: 'ok', unsure: 'unsure' });
export const REFUTATION_VERDICTS = Object.freeze({ uphold: 'uphold', reject: 'reject' });
export const FINDING_STATES = Object.freeze({ open: 'open', dismissed: 'dismissed', resolved: 'resolved', regressed: 'regressed' });
export const REVIEW_VALUES = Object.freeze({ exists: 'exists', absent: 'absent', unknown: 'unknown', skip: 'skip' });
export const OUTCOMES = Object.freeze({
  finding: 'finding',
  dismissedOnly: 'dismissed_only',
  ok: 'ok',
  seenOnly: 'seen_only',
  skip: 'skip',
});
export const VANISH_NONE = 'none';

export const CODES = Object.freeze({
  conflict: 'E_CONFLICT',
  unknownId: 'E_UNKNOWN_ID',
  staleRun: 'E_STALE_RUN',
  result: 'E_RESULT',
  input: 'E_INPUT',
  place: 'E_PLACE',
  transport: 'E_TRANSPORT',
  lock: 'E_LOCK',
  internal: 'E_INTERNAL',
});
export const EXIT = Object.freeze({ ok: 0, internal: 1, rejected: 2 });

export const STATE_ROOT_ENV = 'BP_STATE_ROOT';
export const STATE_DIR_NAME = '.best-practices';
export const STATES_DIR = 'states';
export const LOG_FILE = 'log.jsonl';
export const LOCK_FILE = 'lock';
export const WORK_DIR = 'work';
export const CRITERIA_DIR = 'references/criteria';
export const CRITERIA_FILES = Object.freeze({
  conformance: Object.freeze(['specifications', 'bp-conformance.md']),
  design: Object.freeze(['design', 'skill-design-patterns.md']),
  authoring: Object.freeze(['specifications', 'bp-authoring.md']),
  inspection: Object.freeze(['specifications', 'bp-inspection.md']),
  designedSkill: Object.freeze(['requirements', 'bp-designed-skill.md']),
  guidelines: Object.freeze(['guidelines', 'documentation.md']),
});
// others は bp-conformance の、機能仕様と性能・容量のほかの章（読める章）。章を読めない写しでどの章の仕様項目を落としてよいかを、この閉集合で決める。
export const CRITERIA_CHAPTERS = Object.freeze({
  functional: '機能仕様',
  capacityPrefix: '性能・容量',
  others: Object.freeze(['対象範囲', '用語定義', 'エラー処理と異常系', '検証方法', 'トレーサビリティ表']),
});
// CLI が機械の照合で判定する仕様項目（SP-BPFINDINGS-010）と、仕様の観点から除きフローの観点が PR-BPDESIGNEDSKILL-048 の単位として判定する仕様項目（SP-BPINSPECTION-008）。
export const CONFORMANCE_SP = Object.freeze({ placement: 'SP-BPCONFORMANCE-041', roleModels: 'SP-BPCONFORMANCE-035' });
export const PROMPT_AUDIT_FILE = 'references/prompt-audit.md';
// 照らす先の決定の出力で、観点ごとのファイルを名前で指す（パスの順に意味を持たせない）。
export const TARGET_FILES = Object.freeze({ conformance: 'conformance', design: 'design', inspection: 'inspection', promptAudit: 'promptAudit', designedSkill: 'designedSkill' });
export const PROMPT_AUDIT_SECTION = 'Finding criteria';
export const PRINCIPLE_HEADER = '原則';
export const UPDATE_ONLY_MARK = '（update だけ）';

export const SUMMARY_MAX_CHARS = 8000;
export const SUMMARY_RESERVE_CHARS = 600;
export const SUMMARY_CLIP_CHARS = Object.freeze({ request: 1500, ground: 300, premise: 400 });
export const LOCK_WAIT_MS = 10000;

export const ID_LENGTHS = Object.freeze({ asset: 10, finding: 10, item: 8, stateRandom: 8 });
