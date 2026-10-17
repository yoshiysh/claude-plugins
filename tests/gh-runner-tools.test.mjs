import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

const repoRoot = resolve(import.meta.dirname, '..')
const provision = join(repoRoot, 'tools', 'provision-gh-runner')
const ctl = join(repoRoot, 'tools', 'gh-runner-ctl')
const hasSystemd = existsSync('/run/systemd/system')

function script(path, body) {
  writeFileSync(path, `#!/bin/bash\n${body}\n`)
  chmodSync(path, 0o755)
}

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'gh-runner-tools-'))
  const home = join(root, 'home')
  const bin = join(root, 'bin')
  const pkg = join(root, 'pkg')
  for (const dir of [home, bin, pkg]) mkdirSync(dir)

  script(join(pkg, 'config.sh'), [
    'while [ $# -gt 0 ]; do case "$1" in',
    '  --url) url="$2"; shift 2 ;; --name) name="$2"; shift 2 ;; --labels) labels="$2"; shift 2 ;;',
    '  *) shift ;; esac; done',
    'printf \'\\357\\273\\277{\\n  "agentName": "%s",\\n  "gitHubUrl": "%s"\\n}\\n\' "$name" "$url" > .runner',
    'printf \'%s\' "$labels" > labels.txt',
  ].join('\n'))
  script(join(pkg, 'run.sh'), 'touch "$HOME/.listening"')
  script(join(pkg, 'svc.sh'), 'echo "$@" >> svc.log; [ "$1" = start ] && touch "$HOME/.listening"; exit 0')
  execFileSync('tar', ['czf', join(root, 'runner.tar.gz'), '-C', pkg, '.'])

  script(join(bin, 'gh'), [
    'case "$*" in',
    '  *registration-token*|*remove-token*) echo stub-token ;;',
    '  *releases/latest*) echo 9.9.9 ;;',
    '  *actions/runners*) echo "stub-runner: online" ;;',
    'esac',
  ].join('\n'))
  script(join(bin, 'curl'), `cp "${join(root, 'runner.tar.gz')}" runner.tar.gz`)
  script(join(bin, 'sudo'), 'exit 1')
  script(join(bin, 'pgrep'), '[ -f "$HOME/.listening" ]')
  script(join(bin, 'pkill'), 'rm -f "$HOME/.listening"')
  script(join(bin, 'sleep'), '/bin/sleep 0.2')
  return { home, bin }
}

function registerExisting(box, dir, repo) {
  const path = join(box.home, dir)
  mkdirSync(path)
  writeFileSync(join(path, '.runner'), `﻿{\n  "agentName": "old",\n  "gitHubUrl": "https://github.com/${repo}"\n}\n`)
  script(join(path, 'config.sh'), 'exit 0')
  script(join(path, 'run.sh'), 'touch "$HOME/.listening"')
  script(join(path, 'svc.sh'), 'echo "$@" >> svc.log; [ "$1" = start ] && touch "$HOME/.listening"; exit 0')
}

function run(tool, box, args) {
  const result = spawnSync(tool, args, {
    encoding: 'utf8',
    env: { ...process.env, HOME: box.home, PATH: `${box.bin}:${process.env.PATH}` },
  })
  return { code: result.status, out: `${result.stdout}${result.stderr}` }
}

test('provision stops when --dir is registered to another repository', () => {
  const box = sandbox()
  registerExisting(box, 'actions-runner', 'owner/other')

  const result = run(provision, box, ['--repo', 'owner/wanted', '--target', 'local', '--dir', 'actions-runner'])

  assert.equal(result.code, 1)
  assert.match(result.out, /owner\/other に登録済み/)
  assert.equal(existsSync(join(box.home, 'actions-runner', 'svc.log')), false)
})

test('provision reuses the one directory already registered to the repository', () => {
  const box = sandbox()
  registerExisting(box, 'actions-runner-wanted', 'Owner/Wanted')

  const result = run(provision, box, ['--repo', 'owner/wanted', '--target', 'local', '--allow-nohup'])

  assert.equal(result.code, 0, result.out)
  assert.match(result.out, /~\/actions-runner-wanted\n/)
  assert.match(result.out, /already-configured/)
  assert.equal(existsSync(join(box.home, 'actions-runner')), false)
})

test('provision asks for --dir when several directories are registered to the repository', () => {
  const box = sandbox()
  registerExisting(box, 'actions-runner-1', 'owner/wanted')
  registerExisting(box, 'actions-runner-2', 'owner/wanted')

  const result = run(provision, box, ['--repo', 'owner/wanted', '--target', 'local'])

  assert.equal(result.code, 1)
  assert.match(result.out, /複数ある: actions-runner-1 actions-runner-2/)
})

test('provision installs beside a default directory that another repository owns', () => {
  const box = sandbox()
  registerExisting(box, 'actions-runner', 'owner/other')

  const result = run(provision, box, [
    '--repo', 'owner/wanted', '--target', 'local', '--allow-nohup', '--labels', 'self-hosted,gpu,gpu',
  ])

  assert.equal(result.code, 0, result.out)
  const installed = join(box.home, 'actions-runner-wanted')
  assert.match(readFileSync(join(installed, '.runner'), 'utf8'), /github\.com\/owner\/wanted/)
  assert.match(readFileSync(join(installed, 'labels.txt'), 'utf8'), /^self-hosted,(linux|macos),gpu$/)
  assert.match(readFileSync(join(box.home, 'actions-runner', '.runner'), 'utf8'), /owner\/other/)
})

test('provision exits 3 when a service is possible but the runner fell back to nohup', { skip: !hasSystemd }, () => {
  const box = sandbox()

  const result = run(provision, box, ['--repo', 'owner/wanted', '--target', 'local'])

  assert.equal(result.code, 3, result.out)
  assert.match(result.out, /mode=nohup/)
  assert.match(result.out, /常駐化できていない/)
})

test('provision accepts the nohup fallback when told to', { skip: !hasSystemd }, () => {
  const box = sandbox()

  const result = run(provision, box, ['--repo', 'owner/wanted', '--target', 'local', '--allow-nohup'])

  assert.equal(result.code, 0, result.out)
})

test('ctl status reports each runner directory with its registered name', () => {
  const box = sandbox()
  registerExisting(box, 'actions-runner-1', 'owner/wanted')

  const result = run(ctl, box, ['--target', 'local', 'status'])

  assert.equal(result.code, 0, result.out)
  assert.match(result.out, /actions-runner-1 \[old\] mode=\w+ running=no/)
})
