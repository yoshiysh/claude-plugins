import fs from 'node:fs'
import readline from 'node:readline'
import { runWorkspace, stampStdout } from '../scripts/doc_check.mjs'

let currentStdin = null
const origReadFileSync = fs.readFileSync
fs.readFileSync = function (fd, ...args) {
  if (fd === 0 && currentStdin !== null) {
    return currentStdin
  }
  return origReadFileSync.call(fs, fd, ...args)
}

const origStderrWrite = process.stderr.write
let capturedStderr = ''

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
})

rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return

  let req
  try {
    req = JSON.parse(trimmed)
  } catch (err) {
    process.stdout.write(
      JSON.stringify({
        returncode: 1,
        stdout: '',
        stderr: `worker json parse error: ${err && err.message ? err.message : err}\n`,
      }) + '\n',
    )
    return
  }

  const { mode, args = [], stdin = null } = req

  capturedStderr = ''
  process.stderr.write = function (chunk, encoding, callback) {
    capturedStderr += typeof chunk === 'string' ? chunk : chunk.toString(encoding || 'utf8')
    if (typeof callback === 'function') callback()
    return true
  }
  currentStdin = stdin !== null && stdin !== undefined ? (typeof stdin === 'string' ? stdin : JSON.stringify(stdin)) : ''

  try {
    const out = runWorkspace(mode, args)
    const text = typeof out === 'string' ? out : `${JSON.stringify(stampStdout(out))}\n`
    process.stdout.write(
      JSON.stringify({
        returncode: 0,
        stdout: text,
        stderr: capturedStderr,
      }) + '\n',
    )
  } catch (e) {
    const isMismatch = Boolean(e && (e.constructor.name === 'DigestMismatch' || e.name === 'DigestMismatch'))
    const returncode = isMismatch ? 3 : 1
    const errMsg = e && e.message ? e.message : e
    process.stdout.write(
      JSON.stringify({
        returncode,
        stdout: '',
        stderr: `${capturedStderr}doc_check ${mode}: ${errMsg}\n`,
      }) + '\n',
    )
  } finally {
    process.stderr.write = origStderrWrite
    currentStdin = null
  }
})
