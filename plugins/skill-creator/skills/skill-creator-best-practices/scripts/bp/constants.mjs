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

export const FUNCTION = Object.freeze({ create: 'create', review: 'review', update: 'update', audit: 'audit' });
export const FUNCTIONS = Object.freeze(Object.values(FUNCTION));
export const REWRITING_FUNCTIONS = new Set([FUNCTION.create, FUNCTION.update]);

export const STOP_KINDS = Object.freeze({
  complete: 'complete',
  needsInput: 'needs_input',
  iterationLimit: 'iteration_limit',
  blocked: 'blocked',
});
export const LIMIT_HITS = Object.freeze(['iteration', 'launch']);
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
  [STAGE.close]: '照合と停止',
});
export const VERIFY_STAGES = new Set([STAGE.verify, STAGE.verifyExtra]);
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
});
export const FINGERPRINT_AT = Object.freeze({ start: 'start', retake: 'retake', stop: 'stop' });
export const FILE_ACTIONS = Object.freeze({ write: 'write', delete: 'delete' });
export const ASSIGN_RULES = Object.freeze({ all: 'all', skip: 'skip' });
export const RESULT_KINDS = Object.freeze({ verdicts: 'verdicts', refutation: 'refutation', vanish: 'vanish' });
export const BASIS = Object.freeze({ upheld: 'upheld', rejected: 'rejected', noCandidate: 'no-candidate', unknown: 'unknown', vanish: 'vanish' });
export const RECORDED = Object.freeze({ state: 'state', judgement: 'judgement', none: 'none' });
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
});
export const CRITERIA_CHAPTERS = Object.freeze({ functional: '機能仕様', capacityPrefix: '性能・容量' });
export const PRINCIPLE_HEADER = '原則';
export const UPDATE_ONLY_MARK = '（update だけ）';

export const SUMMARY_MAX_CHARS = 8000;
export const SUMMARY_RESERVE_CHARS = 600;
export const SUMMARY_CLIP_CHARS = Object.freeze({ request: 1500, ground: 300, premise: 400 });
export const LOCK_WAIT_MS = 10000;

export const ID_LENGTHS = Object.freeze({ asset: 10, finding: 10, item: 8, stateRandom: 8 });
