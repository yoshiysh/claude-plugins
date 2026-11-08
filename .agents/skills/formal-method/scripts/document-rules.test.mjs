// 同梱の規約の写し references/document-rules.md と、正本 docs/guidelines/documentation.md の一致（依頼者の決定 3、PR-BPDESIGNEDSKILL-040）。
// 一致はバイト列の一致とする（契約に写しの加工の規則が無いため）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const COPY = join(SKILL, 'references', 'document-rules.md');

function findCanonical() {
  for (let d = SKILL; d !== dirname(d); d = dirname(d)) {
    const p = join(d, 'docs', 'guidelines', 'documentation.md');
    if (existsSync(p)) return p;
  }
  return null;
}

test('SP-FORMALMETHOD-014 PR-BPDESIGNEDSKILL-040: 同梱の写し references/document-rules.md がある', () => {
  assert.ok(existsSync(COPY), `${COPY} が無い（A が正本から写す）`);
});

test('SP-FORMALMETHOD-014 PR-BPDESIGNEDSKILL-040・042: 同梱の写しは正本 docs/guidelines/documentation.md とバイト列で一致する', (t) => {
  const canonical = findCanonical();
  if (!canonical) { t.skip('正本を持つリポジトリの外（配布先）で動いている'); return; }
  assert.ok(existsSync(COPY), `${COPY} が無い`);
  const a = readFileSync(canonical);
  const b = readFileSync(COPY);
  assert.ok(a.equals(b), `写しが正本と違う。直し方: cp ${canonical} ${COPY}`);
});
