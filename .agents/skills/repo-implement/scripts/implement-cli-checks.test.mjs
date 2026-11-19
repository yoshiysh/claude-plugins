// implement-cli の run-checks・verify・abandon・path での入力。共有の道具は test-fixtures/implement-cli.mjs（ファイルを分けて並列に走らせる）。
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { defaultIo, main } from './implement-cli.mjs'
import { CODES } from './implement-core.mjs'
import { write, fixture, call, ok, start, planFor, ref, implementationFor, admit, round, reviewPlanFile, reviewOf, confirmed, implemented, recordReview } from './test-fixtures/implement-cli.mjs'

describe('implement-cli', { concurrency: 4 }, () => {
test('run-checks: 開始時に成功していた check と開始時に無かったテストの、変更後の失敗だけを repairable にする', async (t) => {
  const cases = [
    { name: '正常: 開始時も変更後も成功', failBefore: false, failAfter: false, exit: 0, failedAtBaseline: false, repairable: false },
    { name: '異常: 変更が起こした失敗', failBefore: false, failAfter: true, exit: 2, failedAtBaseline: false, repairable: true },
    { name: '準正常: 開始時から失敗していた', failBefore: true, failAfter: true, exit: 2, failedAtBaseline: true, repairable: false },
  ]
  for (const c of cases) {
    await t.test(c.name, (t) => {
      const fx = fixture(t)
      if (c.failBefore) write(fx.repo, 'FAIL', 'x\n')
      const s = start(fx)
      const p = planFor(s)
      ok('inventory', { ...ref(s), ...p })
      const baseline = ok('run-checks', { ...ref(s), ...p, phase: 'baseline' })
      assert.equal(baseline.run.results[0].exit_code, c.failBefore ? 2 : 0)
      const addFail = c.failAfter && !c.failBefore
      round(s, p, (r) => { write(r, 'src/a.mjs', 'changed\n'); if (addFail) write(r, 'FAIL', 'x\n') }, ['src/a.mjs', ...(addFail ? ['FAIL'] : [])])
      const out = ok('run-checks', { ...ref(s), ...p, phase: 'after' })
      const [r] = out.run.results
      assert.deepEqual([r.argv, r.exit_code, r.failed_at_baseline, r.repairable], [['make', 'test'], c.exit, c.failedAtBaseline, c.repairable])
      assert.match(r.stdout_tail, /running/)
      assert.equal(out.passed, c.exit === 0)
      assert.equal(out.run.tree_changed, false)
    })
  }
  await t.test('境界: 開始時にまだ無いテストは baseline で実行せず、変更後の失敗は変更起因にする', (t) => {
    const fx = fixture(t)
    const s = start(fx)
    const p = planFor(s, { checks: [{ kind: 'make', value: 'test' }, { kind: 'node-test', value: 'src/new.test.mjs' }] })
    ok('inventory', { ...ref(s), ...p })
    const baseline = ok('run-checks', { ...ref(s), ...p, phase: 'baseline' })
    assert.equal(baseline.run.results[1].not_run, 'baseline にまだ無いテスト')
    round(s, p, (r) => write(r, 'src/new.test.mjs', "import test from 'node:test'\ntest('n', () => { throw new Error('x') })\n"), ['src/new.test.mjs'])
    const r = ok('run-checks', { ...ref(s), ...p, phase: 'after' }).run.results[1]
    assert.deepEqual([r.argv, r.exit_code === 0, r.failed_at_baseline, r.repairable], [['node', '--test', 'src/new.test.mjs'], false, false, true])
  })
})

test('run-checks: 実行の順と対象を記録で縛り、許可されないものは何も実行しない', async (t) => {
  await t.test('異常: baseline の 2 回目・実装の前の after・受け入れていない plan・知らない phase を拒否する', (t) => {
    const fx = fixture(t)
    const s = start(fx)
    const p = planFor(s)
    assert.equal(call('run-checks', { ...ref(s), ...p, phase: 'baseline' }).code, CODES.state)
    ok('inventory', { ...ref(s), ...p })
    assert.equal(call('run-checks', { ...ref(s), ...p, phase: 'after' }).code, CODES.state)
    ok('run-checks', { ...ref(s), ...p, phase: 'baseline' })
    assert.equal(call('run-checks', { ...ref(s), ...p, phase: 'baseline' }).code, CODES.state)
    assert.equal(call('run-checks', { ...ref(s), ...p, phase: 'later' }).code, CODES.input)
  })
  await t.test('異常: round を閉じる前・記録の外で変わった後の after を拒否する', (t) => {
    const fx = fixture(t)
    const s = start(fx)
    const p = planFor(s)
    admit(s, p)
    const begun = ok('begin-round', { ...ref(s), ...p, repair: null })
    write(fx.repo, 'src/a.mjs', '2\n')
    assert.equal(call('run-checks', { ...ref(s), ...p, phase: 'after' }).code, CODES.state, 'round を閉じる前')
    ok('inventory', { ...ref(s), ...p, implementation: implementationFor(begun, ['src/a.mjs']) })
    write(fx.repo, 'src/a.mjs', '3\n')
    assert.equal(call('run-checks', { ...ref(s), ...p, phase: 'after' }).code, CODES.state, '記録の外の書き込み')
  })
  await t.test('異常: 変更後に node --test の path が symlink か欠落なら実行しない', async (t) => {
    for (const [name, edit] of [
      ['欠落', (r) => rmSync(path.join(r, 'src/a.test.mjs'))],
      ['symlink', (r) => { rmSync(path.join(r, 'src/a.test.mjs')); symlinkSync('a.mjs', path.join(r, 'src/a.test.mjs')) }],
    ]) {
      await t.test(name, (t) => {
        const fx = fixture(t)
        const s = start(fx)
        const p = planFor(s, { checks: [{ kind: 'make', value: 'test' }, { kind: 'node-test', value: 'src/a.test.mjs' }] })
        admit(s, p)
        round(s, p, edit, ['src/a.test.mjs'])
        assert.equal(call('run-checks', { ...ref(s), ...p, phase: 'after' }).code, CODES.check)
      })
    }
  })
  await t.test('異常: 許可リストに無い check を含む plan は 1 件も実行しない', (t) => {
    const fx = fixture(t)
    const s = start(fx)
    const p = planFor(s, { checks: [{ kind: 'make', value: 'test' }, { kind: 'make', value: 'install' }] })
    const ledger = JSON.parse(readFileSync(s.state.ledgerPath, 'utf8'))
    writeFileSync(s.state.ledgerPath, JSON.stringify({ ...ledger, plan_sum: p.planSum }))
    const ran = []
    const io = { ...defaultIo(), run: (argv) => { ran.push(argv); return { status: 0, stdout: '', stderr: '' } } }
    const out = JSON.parse(main(['run-checks'], JSON.stringify({ ...ref(s), ...p, phase: 'baseline' }), io).output)
    assert.equal(out.code, CODES.check)
    assert.deepEqual(ran, [])
  })
})

test('verify: 最後に check と review を通した作業ツリーのままのときだけ passed にする', async (t) => {
  await t.test('正常: check と review が通り、その後に変わっていない', (t) => {
    const { s, p } = implemented(t)
    assert.equal(recordReview(s, ['src/a.mjs']).ok, true)
    const out = ok('verify', { ...ref(s), ...p })
    assert.deepEqual(out.problems, [])
    assert.equal(out.passed, true)
  })
  await t.test('異常: review の後に作業ツリーが変わった', (t) => {
    const { fx, s, p } = implemented(t)
    recordReview(s, ['src/a.mjs'])
    write(fx.repo, 'src/a.mjs', 'export const a = 3\n')
    assert.deepEqual(ok('verify', { ...ref(s), ...p }).problems.map((x) => x.cause), ['changed_outside_steps', 'changed_since_checks', 'changed_since_review'])
  })
  await t.test('異常: review が確定指摘を返した', (t) => {
    const { s, p } = implemented(t)
    recordReview(s, ['src/a.mjs'], { findings: [confirmed()] })
    assert.deepEqual(ok('verify', { ...ref(s), ...p }).problems.map((x) => x.cause), ['review_not_passed'])
  })
  await t.test('異常: review を記録していない', (t) => {
    const { s, p } = implemented(t)
    assert.deepEqual(ok('verify', { ...ref(s), ...p }).problems.map((x) => x.cause), ['review_missing'])
  })
  await t.test('異常: 承認済みの plan を実装していない', (t) => {
    const fx = fixture(t)
    const s = start(fx)
    const p = planFor(s)
    admit(s, p)
    assert.deepEqual(ok('verify', { ...ref(s), ...p }).problems.map((x) => x.cause), ['not_implemented'])
  })
  await t.test('境界: 変更不要の計画は check と review を求めない', (t) => {
    const fx = fixture(t)
    const s = start(fx)
    const p = planFor(s, { status: 'no_change', affected_paths: [], checks: [] })
    ok('inventory', { ...ref(s), ...p })
    assert.equal(ok('verify', { ...ref(s), ...p }).passed, true)
  })
})

test('通らなかった round の後は check・レビューへ進めず、abandon で終えて残った変更を返す', async (t) => {
  for (const [name, status, edit, touched] of [
    ['異常: 実装の Workflow が incomplete', 'incomplete', null, []],
    ['異常: inventory が plan の外の変更で通らない', 'ready_for_check', (r) => write(r, 'README.md', 'x\n'), ['README.md']],
  ]) {
    await t.test(name, (t) => {
      const fx = fixture(t)
      const s = start(fx)
      const p = planFor(s)
      admit(s, p)
      round(s, p, edit, touched, { status })
      assert.equal(call('run-checks', { ...ref(s), ...p, phase: 'after' }).code, CODES.state)
      assert.equal(call('begin-round', { ...ref(s), ...p, repair: 'checks' }).code, CODES.state)
      assert.equal(ok('verify', { ...ref(s), ...p }).passed, false)
      const out = ok('abandon', { ...ref(s), reason: name })
      assert.deepEqual(out.remaining, edit ? ['README.md'] : [])
      for (const [op, body] of [['begin-round', { ...p, repair: null }], ['run-checks', { ...p, phase: 'after' }], ['inventory', p], ['abandon', { reason: 'x' }]]) {
        assert.equal(call(op, { ...ref(s), ...body }).code, CODES.state, `${op} は終わった run で受け付けない`)
      }
      assert.ok(ok('verify', { ...ref(s), ...p }).problems.some((x) => x.cause === 'terminated'))
    })
  }
  await t.test('準正常: Workflow が返り値無しで終わって開いたままの round を abandon が閉じる', (t) => {
    const fx = fixture(t)
    const s = start(fx)
    const p = planFor(s)
    admit(s, p)
    ok('begin-round', { ...ref(s), ...p, repair: null })
    write(fx.repo, 'src/a.mjs', 'half written\n')
    const out = ok('abandon', { ...ref(s), reason: 'workflow timeout' })
    assert.deepEqual(out.remaining, ['src/a.mjs'])
    assert.deepEqual([out.uninventoriedWrites, out.changedOutsideSteps], [true, false], 'implementer の書き込みを段の外の書き込みと報告しない')
    const ledger = JSON.parse(readFileSync(s.state.ledgerPath, 'utf8'))
    assert.deepEqual([ledger.open, ledger.rounds.at(-1).status], [null, 'abandoned'])
  })
  await t.test('異常: 理由の無い abandon', (t) => {
    const fx = fixture(t)
    const s = start(fx)
    assert.equal(call('abandon', ref(s)).code, CODES.input)
  })
})

test('run-checks: 同じ round の run は全てを数え、通るまで回し直しても失敗は消えない', (t) => {
  const fx = fixture(t)
  const s = start(fx)
  const p = planFor(s)
  admit(s, p)
  round(s, p, (r) => { write(r, 'src/a.mjs', '2\n'); write(r, 'FAIL', 'x\n') }, ['src/a.mjs', 'FAIL'])
  assert.equal(ok('run-checks', { ...ref(s), ...p, phase: 'after' }).passed, false)
  rmSync(path.join(fx.repo, 'FAIL'))
  assert.equal(call('run-checks', { ...ref(s), ...p, phase: 'after' }).code, CODES.state, '記録の外で失敗の原因を消した')
})

test('大きな入力はファイルの path で渡せ、拒否された op は記録を書かない（正しい入力で同じ段を流し直せる）', async (t) => {
  await t.test('正常: implementationPath・reviewPath で渡す', (t) => {
    const fx = fixture(t)
    const s = start(fx)
    const p = planFor(s)
    admit(s, p)
    const begun = ok('begin-round', { ...ref(s), ...p, repair: null })
    write(fx.repo, 'src/a.mjs', '2\n')
    const implFile = path.join(s.stateDir, 'impl.json')
    writeFileSync(implFile, JSON.stringify(implementationFor(begun, ['src/a.mjs'])))
    assert.equal(call('inventory', { ...ref(s), ...p, implementation: implementationFor(begun, ['src/a.mjs']), implementationPath: implFile }).code, CODES.input, '両方は渡さない')
    assert.equal(ok('inventory', { ...ref(s), ...p, implementationPath: implFile }).passed, true)
    ok('run-checks', { ...ref(s), ...p, phase: 'after' })
    const rp = reviewPlanFile(s, ['src/a.mjs'])
    const reviewFile = path.join(s.stateDir, 'review.output')
    writeFileSync(reviewFile, JSON.stringify({ summary: 'done', agentCount: 9, logs: [], result: reviewOf(s, ['src/a.mjs']), workflowProgress: [], totalTokens: 1, totalToolCalls: 1 }))
    assert.equal(ok('record-review', { ...ref(s), reviewPath: reviewFile, reviewPlanPath: rp.reviewPlanPath, reviewPlanSum: rp.reviewPlanSum }).next, 'verify')
  })
  await t.test('準正常: 写し間違いで拒否された後、同じ段を正しい入力で流し直せる', (t) => {
    const { s, p } = implemented(t)
    const before = readFileSync(s.state.ledgerPath, 'utf8')
    const rp = reviewPlanFile(s, ['src/a.mjs'])
    const bad = [
      ['record-review', { review: { ...reviewOf(s, ['src/a.mjs']), findings: [confirmed()] }, reviewPlanPath: rp.reviewPlanPath, reviewPlanSum: rp.reviewPlanSum }],
      ['begin-round', { ...p, planSum: '00000000', repair: 'checks' }],
      ['run-checks', { ...p, phase: 'later' }],
      ['inventory', { ...p, implementation: { status: 'x' } }],
      ['verify', { ...p, planSum: '00000000' }],
      ['abandon', {}],
    ]
    for (const [op, body] of bad) {
      assert.equal(call(op, { ...ref(s), ...body }).ok, false, op)
      assert.equal(readFileSync(s.state.ledgerPath, 'utf8'), before, `${op} の拒否は記録を書かない`)
    }
    assert.equal(recordReview(s, ['src/a.mjs']).ok, true)
  })
})
})
