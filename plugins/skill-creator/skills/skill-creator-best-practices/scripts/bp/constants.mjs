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
});

export const READ_OPS = new Set([OPS.summary, OPS.list, OPS.report, OPS.kinds, OPS.refutationItems]);

export const FUNCTIONS = Object.freeze(['create', 'review', 'update', 'audit']);
export const REWRITING_FUNCTIONS = new Set(['create', 'update']);

export const STOP_KINDS = Object.freeze({
  complete: 'complete',
  needsInput: 'needs_input',
  iterationLimit: 'iteration_limit',
  blocked: 'blocked',
});
export const LIMIT_HITS = Object.freeze(['iteration', 'launch']);
export const STOP_KINDS_BY_FUNCTION = Object.freeze({
  create: [STOP_KINDS.complete, STOP_KINDS.needsInput, STOP_KINDS.iterationLimit, STOP_KINDS.blocked],
  update: [STOP_KINDS.complete, STOP_KINDS.needsInput, STOP_KINDS.iterationLimit, STOP_KINDS.blocked],
  review: [STOP_KINDS.complete, STOP_KINDS.iterationLimit, STOP_KINDS.blocked],
  audit: [STOP_KINDS.complete, STOP_KINDS.iterationLimit, STOP_KINDS.blocked],
});

export const NEXT_ARGS_KEYS = Object.freeze({ function: 'function', state: 'state' });

export const LIMIT_KEYS = Object.freeze({ attempts: 'attempts', iterations: 'iterations', untilPass: 'untilPass' });

export const PREMISE_KINDS = Object.freeze(['answer', 'goal']);

// 段の slug は項目の ID の接頭辞になる。名前は bp-authoring SP-BPAUTHORING-005 と bp-inspection SP-BPINSPECTION-001 の「段」の列。
export const STAGES = Object.freeze({
  start: '開始',
  snapshot: '作り直す前の写し',
  goal: '目標の固定',
  write: '書く',
  ledger: '台帳',
  targets: '照らす先の決定',
  bundle: '台帳の作成と資産の束',
  assign: '担当の作成',
  applicability: '適用の判定',
  verify: '検証',
  'verify-extra': '追加の検証',
  refute: '反証',
  vanish: '消えた資産の照合',
  rejudge: '見直し',
  gate: '合否',
  close: '照合と停止',
});
export const VERIFY_STAGES = new Set(['verify', 'verify-extra']);

export const VIEWPOINTS = Object.freeze({
  flow: 'フローの観点',
  spec: '仕様の観点',
  conformance: '適合の観点',
  goal: '目標の観点',
  contract: '契約の観点',
  audit: '監査の観点',
});

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
export const CRITERIA_DIR_ENV = 'BP_CRITERIA_DIR';
export const STATE_DIR_NAME = '.best-practices';
export const STATES_DIR = 'states';
export const LOG_FILE = 'log.jsonl';
export const LOCK_FILE = 'lock';
export const WORK_DIR = 'work';
export const CRITERIA_DIR = 'references/criteria';
export const PROMPT_AUDIT_PATH = 'references/prompt-audit.md';

export const SUMMARY_MAX_CHARS = 8000;
export const LOCK_WAIT_MS = 10000;

export const ID_LENGTHS = Object.freeze({ asset: 10, finding: 10, item: 8, stateRandom: 8 });
