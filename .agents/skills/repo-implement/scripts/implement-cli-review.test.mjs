// implement-cli の record-review・snapshot・state の改変・main。共有の道具は test-fixtures/implement-cli.mjs（ファイルを分けて並列に走らせる）。
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { main } from './implement-cli.mjs'
import { CODES, MAX_REVIEW_RETRIES } from './implement-core.mjs'
import { CLI, write, fixture, call, ok, start, planFor, ref, admit, round, reviewPlanFile, reviewOf, confirmed, implemented, recordReview } from './test-fixtures/implement-cli.mjs'

describe('implement-cli', { concurrency: 4 }, () => {
test('record-review: 今の変更の全体を今の内容でレビューした結果だけを記録する', async (t) => {
  await t.test('正常: 記録し、確定指摘はレビューの修正の券に載る', (t) => {
    const { s, p } = implemented(t)
    const out = recordReview(s, ['src/a.mjs'], { findings: [confirmed()] })
    assert.equal(out.ok, true, out.reason)
    assert.equal(out.review.passed, false)
    const begun = ok('begin-round', { ...ref(s), ...p, repair: 'review' })
    assert.deepEqual([begun.ticket.round, begun.ticket.findings.length], [1, 1])
  })
  await t.test('境界: 空白だけの欄を持つ確定指摘も repo-review の schema（minLength: 1）どおり記録する', (t) => {
    const { s, p } = implemented(t)
    const blank = confirmed({ claim: { ...confirmed().claim, summary: ' ', evidence: '\n' } })
    const out = recordReview(s, ['src/a.mjs'], { findings: [blank] })
    assert.equal(out.ok, true, out.reason)
    assert.deepEqual(ok('begin-round', { ...ref(s), ...p, repair: 'review' }).ticket.findings, [blank])
  })
  const rejects = [
    ['異常: 対象を一部に狭めた', (s) => recordReview(s, [], {}, {})],
    ['異常: implementer の変更を preserved に混ぜた', (s) => recordReview(s, [], { preserved: [...s.out.preservedPaths, 'src/a.mjs'] }, { preserved: [...s.out.preservedPaths, 'src/a.mjs'] })],
    ['異常: scope を付けた', (s) => recordReview(s, ['src/a.mjs'], { scope: ['src'] })],
    ['異常: 計画のファイルと返り値の対象が違う', (s) => recordReview(s, ['src/a.mjs'], {}, { target: { files: ['src/b.mjs'] } })],
    ['異常: 計画のファイルの後に内容が変わった（前の round のレビュー）', (s) => recordReview(s, ['src/a.mjs'], {}, { digests: { 'src/a.mjs': 'file:old' } })],
    ['異常: 計画のファイルの sum が合わない', (s) => call('record-review', { ...ref(s), review: reviewOf(s, ['src/a.mjs']), ...{ reviewPlanPath: reviewPlanFile(s, ['src/a.mjs']).reviewPlanPath, reviewPlanSum: '00000000' } })],
    ['異常: 別の HEAD のレビュー', (s) => recordReview(s, ['src/a.mjs'], { headSha: 'f'.repeat(40) })],
  ]
  for (const [name, act] of rejects) {
    await t.test(name, (t) => {
      const { s } = implemented(t)
      assert.equal(act(s).code, CODES.input)
    })
  }
  await t.test('異常: check の前のレビューは記録しない', (t) => {
    const fx = fixture(t)
    const s = start(fx)
    const p = planFor(s)
    admit(s, p)
    round(s, p, (r) => write(r, 'src/a.mjs', '2\n'), ['src/a.mjs'])
    assert.equal(recordReview(s, ['src/a.mjs']).code, CODES.state)
  })
})

test('record-review: 1 round に 1 回だけ記録し、やり直しは review_incomplete の後だけ', async (t) => {
  await t.test('異常: completed の後の 2 回目', (t) => {
    const { s } = implemented(t)
    assert.equal(recordReview(s, ['src/a.mjs'], { findings: [confirmed()] }).ok, true)
    assert.equal(recordReview(s, ['src/a.mjs']).code, CODES.state, '指摘 0 件が出るまで回し直せない')
  })
  await t.test('準正常: review_incomplete の後のやり直しは記録し、前の確定指摘を残す', (t) => {
    const { s, p } = implemented(t)
    assert.equal(recordReview(s, ['src/a.mjs'], { status: 'review_incomplete', coverage: undefined, pin: undefined, findings: [confirmed()] }).ok, true)
    const again = recordReview(s, ['src/a.mjs'])
    assert.equal(again.ok, true, again.reason)
    assert.deepEqual([again.review.findings, again.review.passed], [1, false])
    assert.deepEqual(ok('verify', { ...ref(s), ...p }).problems.map((x) => x.cause), ['review_not_passed'])
  })
  await t.test('異常: 返り値から findings を落とした', (t) => {
    const { s } = implemented(t)
    const rp = reviewPlanFile(s, ['src/a.mjs'])
    const dropped = { ...reviewOf(s, ['src/a.mjs'], { findings: [confirmed()] }), findings: [] }
    assert.equal(call('record-review', { ...ref(s), review: dropped, reviewPlanPath: rp.reviewPlanPath, reviewPlanSum: rp.reviewPlanSum }).code, CODES.input)
  })
  await t.test('異常: target.files の path が repo の外・文字列でない（内容を読む前に拒否する）', async (t) => {
    for (const files of [['../outside'], [42]]) {
      await t.test(JSON.stringify(files), (t) => {
        const { s } = implemented(t)
        const out = recordReview(s, files)
        assert.equal(out.code, CODES.input, out.reason)
      })
    }
  })
})

test('record-review: 記録から次の段を 1 つに決めて返す', async (t) => {
  const cases = [
    ['正常: 確定も未検証も無い', [{}], 'verify'],
    ['異常: 確定指摘がある', [{ findings: [confirmed()] }], 'repair'],
    ['異常: completed で未検証が残る', [{ unverified: [{ claim: 'x' }] }], 'abandon'],
    ['準正常: 途中で止まったレビュー（やり直せる）', [{ status: 'review_incomplete', coverage: undefined, pin: undefined }], 'retry_review'],
    ['準正常: 確定指摘が残る review_incomplete は修正へ', [{ status: 'review_incomplete', coverage: undefined, pin: undefined, findings: [confirmed()] }], 'repair'],
    ['境界: やり直しの上限に達した review_incomplete', Array.from({ length: MAX_REVIEW_RETRIES + 1 }, () => ({ status: 'review_incomplete', coverage: undefined, pin: undefined })), 'abandon'],
    ['準正常: やり直しても前の未検証は残る', [{ status: 'review_incomplete', coverage: undefined, pin: undefined, unverified: [{ claim: 'x' }] }], 'abandon'],
  ]
  for (const [name, reviews, next] of cases) {
    await t.test(name, (t) => {
      const { s } = implemented(t)
      let out
      for (const patch of reviews) out = recordReview(s, ['src/a.mjs'], patch)
      assert.equal(out.ok, true, out.reason)
      assert.equal(out.next, next)
    })
  }
  await t.test('異常: 上限を超えるやり直し', (t) => {
    const { s } = implemented(t)
    const inc = { status: 'review_incomplete', coverage: undefined, pin: undefined }
    for (let i = 0; i <= MAX_REVIEW_RETRIES; i += 1) assert.equal(recordReview(s, ['src/a.mjs'], inc).ok, true)
    assert.equal(recordReview(s, ['src/a.mjs'], inc).code, CODES.state)
  })
  await t.test('準正常: 確定指摘と未検証が同時に残るとき、未検証の本文を出力と abandon に残す', (t) => {
    const { s } = implemented(t)
    const out = recordReview(s, ['src/a.mjs'], { findings: [confirmed()], unverified: [{ claim: 'u' }] })
    assert.deepEqual([out.next, out.unverifiedDetail], ['repair', [{ claim: 'u' }]])
    const ab = ok('abandon', { ...ref(s), reason: 'x' })
    assert.deepEqual([ab.lastReview.findingsDetail.length, ab.lastReview.unverifiedDetail], [1, [{ claim: 'u' }]])
  })
})

test('snapshot: 内容・未追跡・symlink の先の文字列で変わり、読むだけでは変わらない', (t) => {
  const fx = fixture(t)
  const s = start(fx)
  const first = ok('snapshot', ref(s)).snapshot
  assert.equal(ok('snapshot', ref(s)).snapshot, first, '読むだけでは変わらない')
  write(fx.repo, 'new.md', 'n\n')
  const second = ok('snapshot', ref(s)).snapshot
  assert.notEqual(second, first)
  write(fx.repo, 'new.md', 'm\n')
  assert.notEqual(ok('snapshot', ref(s)).snapshot, second, '同じ path の内容の違い')
  rmSync(path.join(fx.repo, 'new.md'))
  unlinkSync(path.join(fx.repo, 'link'))
  symlinkSync('src', path.join(fx.repo, 'link'))
  const third = ok('snapshot', ref(s))
  assert.notEqual(third.snapshot, first, 'symlink の先の文字列の違い')
  assert.equal(third.unchanged, false)
})

test('state の改変・写し間違いは E_INPUT で拒否する', (t) => {
  const fx = fixture(t)
  const s = start(fx)
  assert.equal(call('snapshot', { statePath: s.statePath, stateSum: '00000000' }).code, CODES.input)
  assert.equal(call('snapshot', { statePath: 'relative.json', stateSum: s.stateSum }).code, CODES.input)
  writeFileSync(s.statePath, JSON.stringify({ ...s.state, head: 'c'.repeat(40) }))
  assert.equal(call('snapshot', ref(s)).code, CODES.input)
})

test('main: 使い方の誤りは exit 2、拒否は exit 1 で、本物の CLI も同じ JSON の 1 行を返す', async (t) => {
  for (const [name, argv, input, exit, code] of [
    ['異常: 知らない操作', ['merge'], '{}', 2, CODES.input],
    ['異常: 引数が多い', ['start', 'x'], '{}', 2, CODES.input],
    ['異常: JSON でない', ['start'], 'not json', 2, CODES.input],
    ['異常: 配列', ['start'], '[]', 2, CODES.input],
    ['異常: 必須の値が無い', ['start'], '{}', 1, CODES.input],
  ]) {
    await t.test(name, () => {
      const r = main(argv, input)
      assert.equal(r.exitCode, exit)
      assert.equal(JSON.parse(r.output).code, code)
    })
  }
  await t.test('正常: 子プロセスとして start を通す（空白を含む stateDir）', (t) => {
    const fx = fixture(t)
    const dir = path.join(fx.stateDir, 'a b')
    mkdirSync(dir)
    const r = spawnSync(process.execPath, [CLI, 'start'], { input: JSON.stringify({ repo: fx.repo, stateDir: dir }), encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    const out = JSON.parse(r.stdout)
    assert.equal(out.ok, true)
    assert.equal(out.state_path, path.join(dir, 'repo-implement-state.json'))
  })
})
})
