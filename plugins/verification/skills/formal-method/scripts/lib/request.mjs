// 依頼の検査（artifact-formats.md「依頼（Request）」、SP-FORMALMETHOD-001）。依頼は開いた object で、未知のキーは拒まずに控える。
// 受け付けない依頼は 9 つのコードで、項目（item）・依頼の中の JSON Pointer（field）・理由（detail）を返す。
import { ID_RE as ID, SHA256_RE as SHA, FILE_PATH_RE as FILE_PATH, parseSpan } from './schemas.mjs';

const REVISION = /^[A-Za-z0-9._/-]+$/;

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonEmpty = (v) => typeof v === 'string' && v.length > 0;
const esc = (k) => String(k).replace(/~/g, '~0').replace(/\//g, '~1');

const problem = (code, detail, { item = null, field = null } = {}) => ({ request_code: code, item, field, detail });

// 形の検査。戻り値 { problems, unknownKeys }。
export function checkRequestShape(req) {
  const problems = [];
  const unknownKeys = [];
  const shape = (field, detail) => problems.push(problem('shape_invalid', detail, { field }));
  const known = (obj, keys, at) => { for (const k of Object.keys(obj)) if (!keys.includes(k)) unknownKeys.push(`${at}/${esc(k)}`); };
  const id = (v, at) => { if (!nonEmpty(v)) shape(at, '識別子が空でない文字列でない'); else if (!ID.test(v)) shape(at, '識別子に使えない文字がある'); };
  const sourceRef = (v, at) => {
    if (!isPlain(v)) { shape(at, '出所が object でない'); return; }
    known(v, ['target_id', 'file', 'span'], at);
    id(v.target_id, `${at}/target_id`);
    if (!nonEmpty(v.file) || !FILE_PATH.test(v.file)) shape(`${at}/file`, 'file が FilePath でない');
    if (!parseSpan(v.span)) shape(`${at}/span`, 'span が L<開始>-L<終了> でない');
  };
  const pointer = (v, at) => {
    if (!isPlain(v)) { shape(at, 'Pointer が object でない'); return; }
    if (['target', 'goal', 'known_requirement'].includes(v.kind)) { known(v, ['kind', 'id'], at); id(v.id, `${at}/id`); return; }
    if (v.kind === 'location') {
      known(v, ['kind', 'target_id', 'file', 'span'], at);
      id(v.target_id, `${at}/target_id`);
      if (!nonEmpty(v.file) || !FILE_PATH.test(v.file)) shape(`${at}/file`, 'file が FilePath でない');
      if ('span' in v && !parseSpan(v.span)) shape(`${at}/span`, 'span が L<開始>-L<終了> でない');
      return;
    }
    shape(`${at}/kind`, 'Pointer の kind が target・goal・known_requirement・location のどれでもない');
  };
  const statements = (list, at, missingCode) => {
    if (list === undefined) { if (missingCode) problems.push(problem(missingCode, `${at.slice(1)} が無い`, { field: at })); return; }
    if (!Array.isArray(list)) { shape(at, '配列でない'); return; }
    if (list.length === 0 && missingCode) { problems.push(problem(missingCode, `${at.slice(1)} が空`, { field: at })); return; }
    list.forEach((s, i) => {
      const p = `${at}/${i}`;
      if (!isPlain(s)) { shape(p, 'object でない'); return; }
      known(s, ['id', 'text', 'source'], p);
      id(s.id, `${p}/id`);
      if (!nonEmpty(s.text)) shape(`${p}/text`, 'text が空でない文字列でない');
      if ('source' in s) sourceRef(s.source, `${p}/source`);
    });
  };
  if (!isPlain(req)) { shape('', '依頼が object でない'); return { problems, unknownKeys }; }
  known(req, ['targets', 'goals', 'known_requirements', 'scope', 'time_limit_seconds'], '');
  // targets
  if (req.targets === undefined) problems.push(problem('target_missing', '対象が無い', { field: '/targets' }));
  else if (!Array.isArray(req.targets)) shape('/targets', '対象が配列でない');
  else if (req.targets.length === 0) problems.push(problem('target_missing', '対象が空', { field: '/targets' }));
  else req.targets.forEach((t, i) => {
    const p = `/targets/${i}`;
    if (!isPlain(t)) { shape(p, '対象が object でない'); return; }
    known(t, ['id', 'location', 'revision', 'content_hash'], p);
    id(t.id, `${p}/id`);
    if (!('location' in t)) shape(`${p}/location`, 'location が無い');
    else if (!nonEmpty(t.location)) shape(`${p}/location`, 'location が空でない文字列でない');
    if ('revision' in t && (!nonEmpty(t.revision) || !REVISION.test(t.revision) || t.revision.includes('..'))) shape(`${p}/revision`, 'revision が git の版の名前でない');
    if ('content_hash' in t && (typeof t.content_hash !== 'string' || !SHA.test(t.content_hash))) shape(`${p}/content_hash`, 'content_hash が Sha256 でない');
  });
  statements(req.goals, '/goals', 'goal_missing');
  if ('known_requirements' in req) statements(req.known_requirements, '/known_requirements', null);
  if ('scope' in req) {
    const s = req.scope;
    if (!isPlain(s)) shape('/scope', 'scope が object でない');
    else {
      known(s, ['include', 'exclude'], '/scope');
      if (!Array.isArray(s.include) || s.include.length === 0) shape('/scope/include', 'include が空でない配列でない');
      else s.include.forEach((x, i) => pointer(x, `/scope/include/${i}`));
      if (!Array.isArray(s.exclude)) shape('/scope/exclude', 'exclude が配列でない');
      else s.exclude.forEach((x, i) => {
        const p = `/scope/exclude/${i}`;
        if (!isPlain(x)) { shape(p, 'object でない'); return; }
        known(x, ['item', 'reason'], p);
        pointer(x.item, `${p}/item`);
        if (!('reason' in x)) problems.push(problem('exclude_without_reason', '除外の項目に理由が無い', { item: isPlain(x.item) ? x.item : null, field: `${p}/reason` }));
        else if (!nonEmpty(x.reason)) shape(`${p}/reason`, 'reason が空でない文字列でない');
      });
    }
  }
  if ('time_limit_seconds' in req) {
    const v = req.time_limit_seconds;
    if (!(typeof v === 'number' && Number.isSafeInteger(v) && v >= 1)) problems.push(problem('time_limit_invalid', '時間の上限が 1 以上の整数でない', { field: '/time_limit_seconds' }));
  }
  // 同じ種類の中で id が重なる
  for (const [key, at] of [['targets', '/targets'], ['goals', '/goals'], ['known_requirements', '/known_requirements']]) {
    if (!Array.isArray(req[key])) continue;
    const seen = new Map();
    req[key].forEach((x, i) => {
      if (!isPlain(x) || !nonEmpty(x.id)) return;
      if (seen.has(x.id)) problems.push(problem('duplicate_id', `${key} の id ${x.id} が重なる`, { item: { kind: key === 'targets' ? 'target' : key === 'goals' ? 'goal' : 'known_requirement', id: x.id }, field: `${at}/${i}/id` }));
      else seen.set(x.id, i);
    });
  }
  return { problems, unknownKeys };
}

// Pointer と SourceRef の解決（pointer_unresolved）。targets は取得した対象（Map: id → { files: Map path → { text, lines } } | null）。
export function checkPointers(req, targets) {
  const problems = [];
  const has = (kind, id) => {
    if (kind === 'target') return req.targets.some((t) => t.id === id);
    if (kind === 'goal') return req.goals.some((g) => g.id === id);
    return (req.known_requirements ?? []).some((k) => k.id === id);
  };
  const location = (targetId, file, span) => {
    if (!req.targets.some((t) => t.id === targetId)) return `依頼に無い対象 ${targetId} を指す`;
    const t = targets.get(targetId);
    if (!t) return null; // 取得できなかった対象は target_unavailable で示す
    const f = t.files.get(file);
    if (!f) return `対象 ${targetId} の集まりに無いファイル ${file} を指す`;
    if (span === undefined) return null;
    const s = parseSpan(span);
    if (!f.text) return `バイナリか読めないファイル ${file} の行を指す`;
    if (!s || s.to > f.lines) return `ファイル ${file} の行数（${f.lines}）を超える範囲 ${span} を指す`;
    return null;
  };
  const pointer = (p, at) => {
    if (p.kind === 'location') {
      const why = location(p.target_id, p.file, p.span);
      if (why) problems.push(problem('pointer_unresolved', why, { item: p, field: at }));
    } else if (!has(p.kind, p.id)) problems.push(problem('pointer_unresolved', `依頼に無い ${p.kind} ${p.id} を指す`, { item: p, field: at }));
  };
  for (const [key, at] of [['goals', '/goals'], ['known_requirements', '/known_requirements']]) {
    (req[key] ?? []).forEach((s, i) => {
      if (!s.source) return;
      const why = location(s.source.target_id, s.source.file, s.source.span);
      if (why) problems.push(problem('pointer_unresolved', `出所が${why}`, { item: { kind: 'location', target_id: s.source.target_id, file: s.source.file, span: s.source.span }, field: `${at}/${i}/source` }));
    });
  }
  if (req.scope) {
    req.scope.include.forEach((p, i) => pointer(p, `/scope/include/${i}`));
    req.scope.exclude.forEach((x, i) => pointer(x.item, `/scope/exclude/${i}/item`));
  }
  return problems;
}

// 受け付けた依頼の正規形（未知のキーを除き、省略の既定値を埋める）。fixed は対象ごとに足す。
export function normalizeRequest(req, fixedById) {
  const stmt = (s) => ({ id: s.id, text: s.text, ...(s.source ? { source: { target_id: s.source.target_id, file: s.source.file, span: s.source.span } } : {}) });
  const ptr = (p) => (p.kind === 'location' ? { kind: 'location', target_id: p.target_id, file: p.file, ...(p.span ? { span: p.span } : {}) } : { kind: p.kind, id: p.id });
  const out = {
    targets: req.targets.map((t) => ({
      id: t.id, location: t.location, ...(t.revision ? { revision: t.revision } : {}), ...(t.content_hash ? { content_hash: t.content_hash } : {}),
      fixed: fixedById.get(t.id),
    })),
    goals: req.goals.map(stmt),
    known_requirements: (req.known_requirements ?? []).map(stmt),
    scope: req.scope
      ? { include: req.scope.include.map(ptr), exclude: req.scope.exclude.map((x) => ({ item: ptr(x.item), reason: x.reason })) }
      : { include: [...req.targets.map((t) => ({ kind: 'target', id: t.id })), ...req.goals.map((g) => ({ kind: 'goal', id: g.id }))], exclude: [] },
  };
  if ('time_limit_seconds' in req) out.time_limit_seconds = req.time_limit_seconds;
  return out;
}
