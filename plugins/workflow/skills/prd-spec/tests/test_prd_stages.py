"""scripts/prd.js の段の経路の smoke テスト。

agent / pipeline / parallel / log / phase を stub にして prd.js を node で走らせ、段の順序と
起動の条件と上限を確かめる。stub の agent は label で応答を返し分ける（label の形は
`<役>:<段や周回>:<対象>` で、prd.js が付ける）。

押さえること（設計書 §4 の「移すテスト」）:
- 問い 0 件なら 1 回の run で done になる（resolver の段 3 も段 6 も起動しない。3v は必ず起動する）
- G0・G1 で needs_answers になり、next_args をそのまま渡すと続きの段から走る
- 上限の 2 パスに達したら blocked になり、2 パス目の監査を飛ばさない
- writer の申告に無い変更 ID があれば、変更の起きた文書に監査が追加で起動する
- 任意の from から再実行すると、その段から進む。要る state が無ければ止まる
- 応答しなかった agent を「0 件」として扱わず、blocked にして、その段からの next_args を返す

構文の確認もここで行う。prd.js は `export const meta` とトップレベルの return を持つので、
そのままでは `node --check` に通らない。`export ` を外し、本体を async 関数で包んでから確かめる。
"""

import json
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_prd_pure import contract_values  # noqa: E402

SKILL = Path(__file__).resolve().parents[1]
PRD = SKILL / "scripts" / "prd.js"

HARNESS = r"""
const spec = JSON.parse(process.argv[2])
const labels = []
const logs = []
let sha = 'rs-0'
let shaN = 0
const nulls = new Set(spec.null_labels || [])
// long_digests: sha256・digest を実物と同じ 64 字にする（next_args の上限テストで字数を実測に合わせるため）。
const H = (x) => (spec.long_digests ? String(x).padEnd(64, '0') : x)
// flowSha: stub の世界での flow.json の内容の sha256。spec.world があれば run をまたいで W の flow.json のように残り
// （同じ W で再実行したときの実物に合わせる）、無ければ state.flow_digest から始める。
const fs = await import('node:fs')
const world = spec.world && fs.existsSync(spec.world) ? JSON.parse(fs.readFileSync(spec.world, 'utf8')) : {}
let flowSha = world.flow || (spec.args.state && spec.args.state.flow_digest) || null
const setFlow = (x) => {
  flowSha = x
  if (spec.world) fs.writeFileSync(spec.world, JSON.stringify({ flow: x }))
}
const at = (key, stage) => (spec[key] || {})[stage]
// failedNow: W の verifications.json のように run をまたいで残る不合格。verifier の pass / fail で変わり、要素を書き換えた段は
// failed_current_at で明示する（書き換えは stub には見えない）。
let failedNow = (spec.args.state && spec.args.state.flow_failed) || []
// unverified_at・failed_current_at・open_only_at・stale_refs_at・pair_keys_at: 段（label の 2 つ目）ごとの doc_check flow / conflicts の stdout の一覧。
const flowStdout = (findings, sha, stage) => {
  if (at('failed_current_at', stage) !== undefined) failedNow = at('failed_current_at', stage)
  return JSON.stringify({ findings, open: spec.flow_open || 0, path: 'checks/flow.json', digest: 'fd', content_sha256: sha, unverified: at('unverified_at', stage) || [], failed_current: failedNow, open_only: at('open_only_at', stage) || [], stale_refs: at('stale_refs_at', stage) || [], open_ids: at('open_ids_at', stage) || [] })
}
const conflictsStdout = (stage) => JSON.stringify({ pairs: (at('pair_keys_at', stage) || []).length, path: 'checks/conflicts.json', digest: 'c', pair_keys: at('pair_keys_at', stage) || [] })
const ids = (text, re) => [...new Set(String(text).match(re) || [])]
const about = (id) => (spec.about || {})[id] || { open: `O-${id}` }
function respond(prompt, label) {
  const base = label.replace(/#retry$/, '')
  const [role, stage, target] = base.split(':')
  if (role === 'intake') return { decisions: 3, open: 0, decisions_sha256: H('d'), units: spec.units || [{ id: 'U-1', docs: ['requirements/x'], depends_on: [] }] }
  if (role === 'flow-framer') {
    setFlow(H(`f-${stage || 'framer'}`))
    const k = target ? `${stage}-${target}` : stage || 'framer'
    const out = { flow_check: flowStdout(at('flow_findings_at', k) || (spec.broken_flow ? 1 : 0), flowSha, k), conflicts_check: conflictsStdout(k) }
    const asked = ids((/--ids (\S+) --check/.exec(prompt) || [])[1], /RS-\d+/g)
    if (asked.length) {
      const bad = (spec.bad_questions_at || []).includes(k) ? 1 : 0
      out.questions_check = JSON.stringify({ check: true, ids: asked, questions: asked.length - bad, findings: bad, bad_ids: bad ? [asked[0]] : [] })
    }
    return out
  }
  if (role === 'resolver') {
    sha = H(`rs-${++shaN}`)
    const q = (at('questions_at', stage) || []).map((id) => ({ id, about: about(id) }))
    const ruled = (at('ruled_at', stage) || []).map((id) => ({ id, about: about(id) }))
    const holds = (at('holds_at', stage) || []).map((id) => ({ id, about: about(id) }))
    const out = { ruled, questions: q, holds, supersedes: [], free_text: at('free_text_at', stage) || [], routes: at('routes_at', stage) || [], [spec.resolver_sha_key || 'resolutions_sha256']: sha }
    const checked = at('questions_check_ids_at', stage) || (stage.endsWith('-questions') ? ids((/--ids (\S+) --check/.exec(prompt) || [])[1], /RS-\d+/g) : q.map((x) => x.id))
    if (checked.length) {
      const bad = (spec.bad_questions_at || []).includes(stage) ? 1 : 0
      out.questions_check = JSON.stringify({ check: true, ids: checked, questions: checked.length - bad, findings: bad, bad_ids: bad ? [checked[0]] : [] })
    }
    const keepsFlow = prompt.includes('この呼び出しでは flow.json を書かない')
    const returnsFlow = ["3a", "3a'"].includes(stage) || stage.endsWith('-flow') || keepsFlow || at('flow_sha_at', stage) !== undefined
    if (returnsFlow && !(spec.no_flow_check_at || []).includes(stage)) {
      if (at('flow_sha_at', stage) !== undefined) setFlow(H(at('flow_sha_at', stage)))
      out.flow_check = flowStdout(at('flow_findings_at', stage) || 0, flowSha, stage)
      if (!keepsFlow && !(spec.no_conflicts_check_at || []).includes(stage)) out.conflicts_check = conflictsStdout(stage)
    }
    return out
  }
  if (role === 'verifier') {
    const asked = ids(prompt.split('検証する resolution の ID:')[1].split('\n')[0], /RS-\d+/g)
    // fails_when_asked: 検証を求められたら必ず落ちる項目（検証に落ちた要素を渡し直したときの実物の振る舞い）。
    const fail = [...(at('verifier_fail', stage) || []), ...(spec.fails_when_asked || []).filter((f) => new RegExp(`\\b${f.id}\\b`).test(prompt))]
    const failIds = fail.map((f) => f.id)
    const seen = at('verifier_flow_sha_at', stage) !== undefined ? H(at('verifier_flow_sha_at', stage)) : flowSha
    const askedFlow = ids((prompt.split('あわせて検証する: flow.json の要素')[1] || '').split('\n')[0], /F-\d+/g).filter((i) => !failIds.includes(i))
    failedNow = [...new Set([...failedNow.filter((i) => !askedFlow.includes(i)), ...failIds.filter((i) => /^F-/.test(i))])]
    return {
      pass: [...asked.filter((i) => !failIds.includes(i)), ...askedFlow, ...(at('verifier_extra_pass', stage) || [])],
      fail,
      resolutions_sha256: at('verifier_resolutions_sha_at', stage) || sha,
      decisions_sha256: H('d'),
      flow_check: flowStdout(at('verifier_flow_findings_at', stage) || 0, seen, stage),
    }
  }
  if (role === 'writer') {
    const revise = stage.endsWith('revise') || target === 'revise'
    const unit = stage
    const docs = (spec.units || [{ id: 'U-1', docs: ['requirements/x'] }]).find((u) => u.id === unit).docs
    return {
      unit,
      docs: docs.map((key) => ({ key, digest: H(`w-${key}`), doc_check_findings: 0, doc_check_blocking: 0 })),
      changed_items: revise ? ((spec.writer_changed_by_unit || {})[unit] || spec.writer_changed || ['PR-X-001']) : [],
      open_tbd: spec.open_tbd || [],
      new_tbd: revise ? [] : spec.new_tbd || [],
      applied_findings: revise ? ids(prompt, /r\d+-[a-z]{2}-[A-Za-z0-9_.-]+-\d+/g) : [],
      applied_routes: revise ? ids(prompt, /RT-\d+/g) : [],
      resolutions_sha256: sha,
    }
  }
  if (['implementer', 'grounding', 'crossDoc'].includes(role)) {
    const n = Number(stage.slice(1))
    const byKey = spec.findings || {}
    const findings = (byKey[`${role}:${stage}:${target}`] || byKey[`${role}:${stage}`] || []).map((f) => ({ doc: 'requirements/x', item_id: 'PR-X-001', blocking: true, route: 'writer', direction: 'remove', origin: 'text', ...f }))
    const out = { path: `findings/${stage}-${role}.json`, findings }
    if (prompt.includes('あなたは指名された監査役')) {
      // files は snapshot の stdout に無い一覧で、script が一覧を notices に写したら next_args の上限テストが落ちるように置く。
      const listed = (count, kind) => Array.from({ length: count }, (_, i) => `tmp/writer__U-1__draft/${kind}-${String(i).padStart(3, '0')}.pre${i}.json`)
      const found = {
        stray: { count: (spec.stray_at || {})[stage] || 0, path: `checks/audited-${n}.stray.json`, files: listed((spec.stray_at || {})[stage] || 0, 'stray') },
        size_over: { count: (spec.size_over_at || {})[stage] || 0, path: `checks/audited-${n}.sizes.json`, files: listed((spec.size_over_at || {})[stage] || 0, 'size') },
      }
      const docCheck = JSON.stringify({ blocking: 0, flow_refs: spec.doc_flow_refs || {} })
      if (n === 1) out.designated = { doc_check: docCheck, audited: JSON.stringify({ digest: H('a1'), ...found }) }
      else if ((spec.diff_error_at || []).includes(stage)) out.designated = { diff_error: 'doc_check diff: digest mismatch' }
      else {
        const changed = (spec.diff || {})[stage] || spec.writer_changed || ['PR-X-001']
        const firstDoc = (spec.units || [{ docs: ['requirements/x'] }])[0].docs[0]
        const byDoc = (spec.by_doc || {})[stage] || { [firstDoc]: { changed, added: [], removed: [] } }
        out.designated = {
          diff: { stdout: '{}', changed, added: [], removed: [], by_doc: byDoc },
          audited: JSON.stringify({ digest: H(`a${n}`), ...found }),
          doc_check: docCheck,
          tree_digest: JSON.stringify({ digest: H(`t${n}`) }),
        }
      }
    }
    return out
  }
  throw new Error(`unknown label ${label}`)
}
const findingFiles = []
const prompts = []
let auditSchema = null
let resolverSchema = null
const agent = async (prompt, opts) => {
  labels.push(opts.label)
  if (['implementer', 'grounding', 'crossDoc'].includes(opts.label.split(':')[0])) auditSchema = opts.schema
  if (opts.label.startsWith('resolver:')) resolverSchema = opts.schema
  // tamper_before: その label の agent が動く前に、所有表の外の誰かが flow.json を書き換えたことにする。
  if ((spec.tamper_before || {})[opts.label] !== undefined) setFlow(H(spec.tamper_before[opts.label]))
  prompts.push({ label: opts.label, prompt })
  const m = /findings\/(r\d+-[^\s/]+?)\.json に書き/.exec(prompt)
  if (m && !opts.label.endsWith('#retry')) findingFiles.push(m[1])
  if (!opts.model || !opts.effort) throw new Error(`model / effort が無い呼び出し: ${opts.label}`)
  if (nulls.has(opts.label)) return null
  return respond(prompt, opts.label)
}
const pipeline = async (items, stage) => Promise.all(items.map((it, i) => stage(it, it, i)))
const parallel = async (thunks) => Promise.all(thunks.map((t) => t()))
const log = (m) => logs.push(m)
const phase = () => {}
let result, error = null
try {
  result = await __main(spec.args, agent, pipeline, parallel, log, phase)
} catch (e) {
  error = String(e && e.message ? e.message : e)
}
console.log(JSON.stringify({ result, labels, logs, error, findingFiles, prompts, auditSchema, resolverSchema }))
"""


def wrapped_source():
    src = PRD.read_text(encoding="utf-8")
    assert src.startswith("export const meta = {"), "prd.js は export const meta から始まる"
    body = src[len("export ") :]
    return (
        "async function __main(args, agent, pipeline, parallel, log, phase) {\n"
        + body
        + "\n}\n"
        + HARNESS
    )


def run(spec):
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "prd_harness.mjs"
        path.write_text(wrapped_source(), encoding="utf-8")
        out = subprocess.run(["node", str(path), json.dumps(spec)], capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def args(**kw):
    a = {"workspace": "/tmp/prd-w", "skillDir": str(SKILL), "entry": "new"}
    a.update(kw)
    return a


def has(labels, prefix):
    return any(l.startswith(prefix) for l in labels)


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class Syntax(unittest.TestCase):
    def test_包んだ本体がnode_checkに通る(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "prd_check.mjs"
            path.write_text(wrapped_source(), encoding="utf-8")
            r = subprocess.run(["node", "--check", str(path)], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_禁止されたAPIを使っていない(self):
        src = PRD.read_text(encoding="utf-8")
        for bad in ("Date.now(", "Math.random(", "new Date()", "\nimport ", "require("):
            self.assertNotIn(bad, src)


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class Stages(unittest.TestCase):
    def test_問い0件なら1回のrunでdoneになる(self):
        r = run({"args": args()})
        self.assertIsNone(r["error"])
        self.assertEqual(r["result"]["status"], "done")
        labels = r["labels"]
        self.assertEqual(labels[0], "intake")
        self.assertFalse(has(labels, "resolver:3"), "open も組も 0 件なら段 3 の resolver は起動しない")
        self.assertTrue(has(labels, "verifier:3v"), "3v は open も組も 0 件でも必ず起動する")
        self.assertFalse(has(labels, "resolver:6"), "decision の指摘も新しい TBD も 0 件なら段 6 は起動しない")
        self.assertFalse(has(labels, "writer:U-1:revise"))
        self.assertFalse(has(labels, "resolver:9"), "事後報告は導出物なので生成する役を起動しない")
        self.assertEqual(r["result"]["report_path"], "/tmp/prd-w/report.md")
        self.assertIsNone(r["result"]["next_args"])

    def test_G0でneeds_answersになりnext_argsで続きから走る(self):
        spec = {"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}}
        r1 = run(spec)
        res = r1["result"]
        self.assertEqual(res["status"], "needs_answers")
        self.assertEqual(res["question_ids"], ["RS-001"])
        self.assertEqual(res["answers_path"], "/tmp/prd-w/answers/g0.md")
        self.assertEqual(res["next_args"]["from"], "3a")
        self.assertFalse(has(r1["labels"], "writer"), "問いがあれば初稿の前に止まる")
        self.assertEqual(json.loads(json.dumps(res["next_args"])), res["next_args"])

        r2 = run({"args": res["next_args"], "ruled_at": {"3a": ["RS-001"]}})
        self.assertIsNone(r2["error"])
        self.assertEqual(r2["result"]["status"], "done")
        self.assertEqual(r2["labels"][0], "resolver:3a")
        self.assertFalse(has(r2["labels"], "intake"))
        self.assertIn("verifier:3av", r2["labels"], "回答を flow に当てた段では、候補の選択だけでも verifier が flow を照合する")

    def test_自由記述の回答はverifierに通す(self):
        spec = {"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}}
        res = run(spec)["result"]
        r2 = run({"args": res["next_args"], "ruled_at": {"3a": ["RS-001"]}, "free_text_at": {"3a": ["RS-001"]}})
        self.assertTrue(has(r2["labels"], "verifier:3av"))
        self.assertEqual(r2["result"]["status"], "done")

    def test_free_textだけに入れた回答が2回落ちるとG0ではG0_2の問いにG0_2ではholdになる(self):
        fail = {"id": "RS-001", "kind": "insufficient_grounds", "reason": "回答の文面から対応づけが読めない"}
        res = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]
        g0 = run({
            "args": res["next_args"],
            "free_text_at": {"3a": ["RS-001"], "3a'": ["RS-001"]},
            "fails_when_asked": [fail],
            "questions_at": {"3a-convert": ["RS-001"]},
        })
        prompts = {p["label"]: p["prompt"] for p in g0["prompts"]}
        self.assertIn("RS-001 → question（insufficient_grounds）", prompts["resolver:3a-convert"])
        self.assertEqual(g0["result"]["status"], "needs_answers")
        self.assertEqual(g0["result"]["question_ids"], ["RS-001"])
        self.assertEqual(g0["result"]["answers_path"], "/tmp/prd-w/answers/g0-2.md")

        g02 = run({
            "args": g0["result"]["next_args"],
            "free_text_at": {"3a": ["RS-001"], "3a'": ["RS-001"]},
            "fails_when_asked": [fail],
            "holds_at": {"3a-convert": ["RS-001"]},
        })
        prompts = {p["label"]: p["prompt"] for p in g02["prompts"]}
        self.assertIn("RS-001 → hold（insufficient_grounds）", prompts["resolver:3a-convert"])
        self.assertEqual(g02["result"]["status"], "done")
        self.assertIn("RS-001", g02["result"]["holds"])
        self.assertEqual(g02["result"]["hold_drafts"], [])

    def test_free_textだけに入れた回答もverifierに通り回答済みになる(self):
        res = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]
        r2 = run({"args": res["next_args"], "free_text_at": {"3a": ["RS-001"]}})
        prompts = {p["label"]: p["prompt"] for p in r2["prompts"]}
        self.assertIn("RS-001", prompts["verifier:3av"].split("検証する resolution の ID:")[1].split("\n")[0])
        self.assertEqual(r2["result"]["status"], "done")
        self.assertFalse(has(r2["labels"], "resolver:final"), "回答した問いを保持規則に変えない")

    def test_3vの不合格は1回だけ差し戻し残りは理由で分ける(self):
        fail = {"id": "RS-001", "kind": "value_as_method", "reason": "価値の判断を方法論で決めた"}
        spec = {
            "args": args(),
            "flow_open": 1,
            "ruled_at": {"3": ["RS-001"], "3'": ["RS-001"]},
            "verifier_fail": {"3v": [fail], "3v'": [fail]},
            "questions_at": {"3-convert": ["RS-001"]},
        }
        r = run(spec)
        labels = r["labels"]
        self.assertEqual(
            [l for l in labels if l.startswith(("resolver:", "verifier:"))],
            ["resolver:3", "verifier:3v", "resolver:3'", "verifier:3v'", "resolver:3-convert"],
            "差し戻しは 1 回きりで、変換の後に検証を回さない",
        )
        self.assertEqual(r["result"]["status"], "needs_answers", "価値の判断は問いになって G0 に届く")
        self.assertEqual(r["result"]["question_ids"], ["RS-001"])

    def test_実測で価値を決めた裁定は検証役が節を読んで落とし問いに変わる(self):
        # 前回の試走の RS-010: O-010 の失敗の行き先を measured（現行の挙動）で決め、3v を通って G1 まで残った形。
        fail = {"id": "RS-010", "kind": "value_as_method", "reason": "失敗の行き先を現行の挙動で決めた"}
        spec = {
            "args": args(),
            "flow_open": 1,
            "about": {"RS-010": {"open": "O-010"}},
            "ruled_at": {"3": ["RS-010"], "3'": ["RS-010"]},
            "verifier_fail": {"3v": [fail], "3v'": [fail]},
            "questions_at": {"3-convert": ["RS-010"]},
        }
        r = run(spec)
        prompts = {p["label"]: p["prompt"] for p in r["prompts"]}
        for label in ("resolver:3", "verifier:3v", "verifier:3v'"):
            self.assertIn("「## 現物と既存実装の扱い」", prompts[label], label)
        self.assertIn("RS-010 → question（value_as_method）", prompts["resolver:3-convert"])
        self.assertEqual(r["result"]["status"], "needs_answers")
        self.assertEqual(r["result"]["question_ids"], ["RS-010"])

    def test_差し戻しで合格すれば変換しない(self):
        fail = {"id": "RS-001", "kind": "insufficient_grounds", "reason": "出典が無い"}
        spec = {"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"], "3'": ["RS-001"]}, "verifier_fail": {"3v": [fail]}}
        r = run(spec)
        self.assertNotIn("resolver:3-convert", r["labels"])
        self.assertEqual(r["result"]["status"], "done")

    def test_G1でneeds_answersになる(self):
        spec = {
            "args": args(),
            "findings": {"crossDoc:r1": [{"id": "r1-cd-all-001", "route": "decision"}]},
            "questions_at": {"6": ["RS-010"]},
        }
        r1 = run(spec)
        res = r1["result"]
        self.assertEqual(res["status"], "needs_answers")
        self.assertEqual(res["answers_path"], "/tmp/prd-w/answers/g1.md")
        self.assertEqual(res["next_args"]["from"], "3a'")
        self.assertTrue(has(r1["labels"], "writer:U-1:draft"), "G1 は初稿の後")

        r2 = run({"args": res["next_args"], "ruled_at": {"3a'": ["RS-010"]}})
        self.assertIsNone(r2["error"])
        self.assertEqual(r2["labels"][0], "resolver:3a'")
        self.assertTrue(has(r2["labels"], "writer:U-1:revise"))
        self.assertTrue(has(r2["labels"], "grounding:r2"), "最後の書き込みには範囲を絞った監査を当てる")
        self.assertEqual(r2["result"]["status"], "done")

    def test_writerの指摘は段6を起動せずに改稿へ届く(self):
        spec = {"args": args(), "findings": {"implementer:r1": [{"id": "r1-im-requirements__x-001"}]}}
        r = run(spec)
        self.assertFalse(has(r["labels"], "resolver:6"))
        self.assertTrue(has(r["labels"], "writer:U-1:revise"))
        self.assertTrue(has(r["labels"], "implementer:r2"), "指摘を出した観点を変えた項目に当て直す")
        self.assertEqual(r["result"]["status"], "done")

    def test_上限の2パスでblockedになり監査は飛ばさない(self):
        blocking = {"id": "x", "blocking": True, "route": "writer"}
        spec = {
            "args": args(),
            "findings": {
                "implementer:r1": [{**blocking, "id": "r1-im-requirements__x-001"}],
                "grounding:r2": [{**blocking, "id": "r2-gr-requirements__x-001"}],
                "grounding:r3": [{**blocking, "id": "r3-gr-requirements__x-001"}],
            },
        }
        r = run(spec)
        res = r["result"]
        self.assertEqual(res["status"], "blocked")
        self.assertTrue(has(r["labels"], "grounding:r3"), "2 パス目の改稿の後も監査を当てる")
        self.assertFalse(has(r["labels"], "grounding:r4"))
        self.assertEqual(sum(1 for l in r["labels"] if l.startswith("writer:U-1:revise")), 2)
        self.assertIn("resolver:final", r["labels"])
        self.assertEqual(res["remaining_blocking"], ["r3-gr-requirements__x-001"])
        self.assertEqual(res["report_path"], "/tmp/prd-w/report.md")
        [final] = [p["prompt"] for p in r["prompts"] if p["label"] == "resolver:final"]
        self.assertNotIn("report.md", final)
        silent = run({**spec, "null_labels": ["resolver:final", "resolver:final#retry"]})["result"]
        self.assertEqual((silent["status"], silent["report_path"]), ("blocked", "/tmp/prd-w/report.md"))

    def test_上限の後に作ったholdは文案で返し本文に入ったholdと分ける(self):
        blocking = {"blocking": True, "route": "writer"}
        limit = {
            "args": args(),
            "about": {"RS-051": {"finding": "r3-gr-requirements__x-001"}, "RS-050": {"finding": "r1-cd-all-001"}},
            "findings": {
                "implementer:r1": [{**blocking, "id": "r1-im-requirements__x-001"}],
                "grounding:r2": [{**blocking, "id": "r2-gr-requirements__x-001"}],
                "grounding:r3": [{**blocking, "id": "r3-gr-requirements__x-001"}],
            },
            "holds_at": {"final": ["RS-051"]},
        }
        first_pass = {
            **limit,
            "findings": {**limit["findings"], "crossDoc:r1": [{"id": "r1-cd-all-001", "route": "decision"}]},
            "holds_at": {"6": ["RS-050"], "final": ["RS-051"]},
        }
        for name, spec, holds in (("上限の経路", limit, []), ("1 パス目の hold の経路", first_pass, ["RS-050"])):
            with self.subTest(name):
                r = run(spec)
                res = r["result"]
                self.assertEqual(res["status"], "blocked")
                self.assertIn("resolver:final", r["labels"])
                self.assertEqual(res["holds"], holds)
                self.assertEqual(res["hold_drafts"], ["RS-051"])
                self.assertEqual(res["remaining_blocking"], ["r3-gr-requirements__x-001"], "文案にした指摘も本文には無いので残す")
                self.assertFalse(set(res["holds"]) & set(res["hold_drafts"]))
        revise = [p["prompt"] for p in run(first_pass)["prompts"] if p["label"].startswith("writer:U-1:revise")]
        self.assertIn("RS-050", revise[0], "1 パス目の hold は段 7 で writer に渡る")

    def test_2パス目の問いは保持規則にしてゲートにしない(self):
        spec = {
            "args": args(),
            "findings": {
                "implementer:r1": [{"id": "r1-im-requirements__x-001"}],
                "grounding:r2": [{"id": "r2-gr-requirements__x-001", "route": "decision"}],
            },
            "questions_at": {"6": ["RS-020"]},
        }
        # 1 パス目の段 6 は decision が 0 件で起動しない。2 パス目の段 6 で出た問いは hold に変える。
        r = run(spec)
        self.assertEqual(r["result"]["status"], "done")
        self.assertIn("resolver:6-hold", r["labels"])
        self.assertIn("RS-020", r["result"]["holds"])
        self.assertEqual(r["result"]["hold_drafts"], [])

    def test_申告に無い変更があれば監査を追加で起動する(self):
        spec = {
            "args": args(),
            "findings": {"implementer:r1": [{"id": "r1-im-requirements__x-001", "blocking": False}]},
            "writer_changed": ["PR-X-001"],
            "diff": {"r2": ["PR-X-001", "PR-X-009"]},
        }
        r = run(spec)
        extra = [l for l in r["labels"] if l.endswith(":extra")]
        self.assertTrue(extra, "申告に無い PR-X-009 に監査が追加で起動していない")
        self.assertTrue(any(l.startswith("implementer:") for l in extra))
        self.assertTrue(any(l.startswith("grounding:") for l in extra))
        self.assertEqual(r["result"]["status"], "done")

    def test_何も申告しなかった単位の変更にもその文書で監査を追加で起動する(self):
        units = [
            {"id": "U-1", "docs": ["requirements/x"], "depends_on": []},
            {"id": "U-2", "docs": ["requirements/y"], "depends_on": []},
        ]
        spec = {
            "args": args(),
            "units": units,
            "findings": {
                "implementer:r1:requirements/x": [{"id": "r1-im-requirements__x-001", "blocking": False}],
                "implementer:r1:requirements/y": [
                    {"id": "r1-im-requirements__y-001", "doc": "requirements/y", "item_id": "PR-Y-001", "blocking": False}
                ],
            },
            "writer_changed_by_unit": {"U-1": ["PR-X-001"], "U-2": []},
            "diff": {"r2": ["PR-X-001", "PR-Y-003"]},
            "by_doc": {
                "r2": {
                    "requirements/x": {"changed": ["PR-X-001"], "added": [], "removed": []},
                    "requirements/y": {"changed": ["PR-Y-003"], "added": [], "removed": []},
                }
            },
        }
        r = run(spec)
        self.assertIsNone(r["error"], r["error"])
        extra = [l for l in r["labels"] if l.endswith(":extra")]
        self.assertIn("implementer:r2:requirements/y:extra", extra, "申告しなかった U-2 の文書に監査が届いていない")
        self.assertIn("grounding:r2:requirements/y:extra", extra)
        self.assertFalse(any(":requirements/x:" in l for l in extra), "申告どおりの文書に追加の監査は要らない")
        self.assertEqual(r["result"]["undeclared"], {"requirements/y": ["PR-Y-003"]})
        self.assertEqual(r["result"]["status"], "done")

    def test_追加の監査役は1体目の指摘ファイルを上書きしない(self):
        spec = {
            "args": args(),
            "findings": {"implementer:r1": [{"id": "r1-im-requirements__x-001", "blocking": False}]},
            "writer_changed": ["PR-X-001"],
            "diff": {"r2": ["PR-X-001", "PR-X-009"]},
        }
        files = run(spec)["findingFiles"]
        self.assertEqual(len(files), len(set(files)), f"指摘ファイルが重なっている: {files}")
        self.assertIn("r2-gr-requirements__x-extra", files)

    def test_diffのdigestが一致しなければblocked(self):
        spec = {
            "args": args(),
            "findings": {"implementer:r1": [{"id": "r1-im-requirements__x-001"}]},
            "diff_error_at": ["r2"],
        }
        r = run(spec)
        self.assertEqual(r["result"]["status"], "blocked")
        self.assertIn("digest", r["result"]["reason"])

    def test_任意のfromからその段に進む(self):
        state = {
            "units": [{"id": "U-1", "docs": ["requirements/x"], "depends_on": []}],
            "flow_digest": "f-framer",
            "flow_failed": [],
            "counts": {"decisions": 1, "open": 0, "pairs": 0},
        }
        for frm, first in (("4", "writer:U-1:draft"), ("5", "implementer:r1:requirements/x"), ("3", "verifier:3v")):
            with self.subTest(frm=frm):
                r = run({"args": args(**{"from": frm, "state": state})})
                self.assertIsNone(r["error"])
                self.assertEqual(r["labels"][0], first)
                self.assertEqual(r["result"]["status"], "done")

    def test_要るstateが無いfromは止まる(self):
        r = run({"args": args(**{"from": "7", "state": {"units": []}})})
        self.assertIn("state.audit", r["error"])
        self.assertEqual(r["labels"], [])

    def test_reviewやupdateはentryに使えない(self):
        for bad in ("review", "update"):
            with self.subTest(bad=bad):
                r = run({"args": args(entry=bad)})
                self.assertIn("entry", r["error"])

    def test_応答しなかったwriterは0件にせずblockedにする(self):
        spec = {"args": args(), "null_labels": ["writer:U-1:draft", "writer:U-1:draft#retry"]}
        r = run(spec)
        res = r["result"]
        self.assertEqual(res["status"], "blocked")
        self.assertEqual(res["next_args"]["from"], "4")
        self.assertFalse(has(r["labels"], "implementer"))

    def test_閉じていない流れでは初稿を始めない(self):
        r = run({"args": args(), "broken_flow": True})
        self.assertEqual(r["result"]["status"], "blocked")
        self.assertIn("flow-framer:rework", r["labels"])
        self.assertFalse(has(r["labels"], "writer"))

    def test_依存のある単位は順番に書く(self):
        units = [
            {"id": "U-2", "docs": ["specifications/x"], "depends_on": ["U-1"]},
            {"id": "U-1", "docs": ["requirements/x"], "depends_on": []},
        ]
        r = run({"args": args(), "units": units})
        writers = [l for l in r["labels"] if l.startswith("writer:")]
        self.assertEqual(writers, ["writer:U-1:draft", "writer:U-2:draft"])

    def test_role_optsの未知の役割は止める(self):
        r = run({"args": args(role_opts={"checker": {"model": "opus"}})})
        self.assertIn("role_opts", r["error"])


TMP_DIR = re.compile(r"^作業用ディレクトリ: (\S+)$", re.M)


def tmp_dir(prompt):
    return TMP_DIR.search(prompt).group(1)


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class CommonContract(unittest.TestCase):
    def test_全役のプロンプトに共通の2節が出る(self):
        r = run({"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"]}})
        self.assertIsNone(r["error"], r["error"])
        roles = {p["label"].split(":")[0] for p in r["prompts"]}
        self.assertEqual(roles, {"intake", "flow-framer", "resolver", "verifier", "writer", "implementer", "grounding", "crossDoc"})
        for p in r["prompts"]:
            self.assertIn("「## 共通の約束」・「## W のファイルと書き手」", p["prompt"], p["label"])

    def test_並列に動く呼び出しは別の作業用ディレクトリを指す(self):
        units = [
            {"id": "U-1", "docs": ["requirements/x"], "depends_on": []},
            {"id": "U-2", "docs": ["requirements/y"], "depends_on": []},
        ]
        r = run({"args": args(), "units": units})
        by_label = {p["label"]: tmp_dir(p["prompt"]) for p in r["prompts"]}
        parallel = ["writer:U-1:draft", "writer:U-2:draft", "implementer:r1:requirements/x", "grounding:r1:requirements/x",
                    "implementer:r1:requirements/y", "grounding:r1:requirements/y", "crossDoc:r1:all"]
        dirs = [by_label[l] for l in parallel]
        self.assertEqual(len(set(dirs)), len(dirs), dirs)
        self.assertEqual(by_label["grounding:r1:requirements/x"], "/tmp/prd-w/tmp/grounding__r1__requirements__x/")

    def test_出し直しは同じ作業用ディレクトリを使う(self):
        r = run({"args": args(), "null_labels": ["writer:U-1:draft"]})
        dirs = [tmp_dir(p["prompt"]) for p in r["prompts"] if p["label"].startswith("writer:U-1:draft")]
        self.assertEqual(len(dirs), 2)
        self.assertEqual(dirs[0], dirs[1])


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class Notices(unittest.TestCase):
    def test_段5のstrayはnoticesに件数とパスだけが入りintegrityに入らない(self):
        r = run({"args": args(), "stray_at": {"r1": 100}})
        res = r["result"]
        self.assertEqual(res["status"], "done")
        self.assertEqual(len(res["notices"]), 1)
        self.assertIn("100 件", res["notices"][0])
        self.assertIn("/tmp/prd-w/checks/audited-1.stray.json", res["notices"][0])
        self.assertEqual(res["integrity"], [])

    def test_段8のstrayはnoticesに入りintegrityに入らない(self):
        spec = {"args": args(), "findings": {"implementer:r1": [{"id": "r1-im-requirements__x-001", "blocking": False}]}, "stray_at": {"r2": 1}}
        r = run(spec)
        res = r["result"]
        self.assertEqual(res["status"], "done")
        self.assertTrue(any("checks/audited-2.stray.json" in n and "audited-2 の時点" in n for n in res["notices"]), res["notices"])
        self.assertEqual(res["integrity"], [])

    def test_SIZE_OVERはnoticesに入りintegrityに入らない(self):
        r = run({"args": args(), "size_over_at": {"r1": 2}})
        res = r["result"]
        self.assertEqual(len(res["notices"]), 1)
        self.assertIn("SIZE_BUDGET", res["notices"][0])
        self.assertIn("/tmp/prd-w/checks/audited-1.sizes.json", res["notices"][0])
        self.assertEqual(res["integrity"], [])

    def test_strayが無ければnoticesは空(self):
        self.assertEqual(run({"args": args()})["result"]["notices"], [])

    def test_指名された監査役のsnapshotに同じplanの全labelをliveで渡す(self):
        spec = {"args": args(), "findings": {"implementer:r1": [{"id": "r1-im-requirements__x-001", "blocking": False}]}}
        r = run(spec)
        by_label = {p["label"]: p["prompt"] for p in r["prompts"]}
        self.assertIn("--live implementer__r1__requirements__x,grounding__r1__requirements__x,crossDoc__r1__all", by_label["crossDoc:r1:all"])
        r2 = [l for l in r["labels"] if ":r2:" in l]
        live = ",".join(re.sub(r"[^A-Za-z0-9._-]+", "__", l) for l in r2)
        designated = [p for l, p in by_label.items() if ":r2:" in l and "あなたは指名された監査役" in p]
        self.assertEqual(len(designated), 1)
        self.assertIn(f"--save audited-2 --role auditor --live {live}", designated[0])

    def test_verifierの照合はresolutions_sha256で行う(self):
        r = run({"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"]}})
        self.assertEqual(r["result"]["integrity"], [])
        stale = run({"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"]}, "verifier_resolutions_sha_at": {"3v": "rs-old"}})
        self.assertTrue(any("resolutions.json（rs-old）" in x for x in stale["result"]["integrity"]), stale["result"]["integrity"])

    def test_resolutions_sha256を返さないresolverでは止まる(self):
        r = run({"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"]}, "resolver_sha_key": "sha256"})
        self.assertEqual(r["result"]["status"], "blocked")
        self.assertEqual(r["result"]["reason"], "resolver:3: resolver が resolutions_sha256 を返しませんでした")
        self.assertNotIn("resolver:3#retry", r["labels"], "済んだ put を二重に走らせない")
        self.assertFalse(has(r["labels"], "verifier:3v"), "照合できない版で検証に進まない")
        self.assertEqual(r["result"]["next_args"]["from"], "3")


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class FlowDigest(unittest.TestCase):
    def test_stateはflowの本体を持たずflow_frameの内容のsha256を運ぶ(self):
        res = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]
        self.assertEqual(res["status"], "needs_answers")
        self.assertNotIn("flow", res["next_args"]["state"])
        self.assertEqual(res["next_args"]["state"]["flow_digest"], "f-framer")

    def test_verifierが見たflowの内容が違えばintegrityに入れてblocked(self):
        r = run({"args": args(), "verifier_flow_sha_at": {"3v": "f-other"}})
        res = r["result"]
        self.assertEqual(res["status"], "blocked")
        self.assertEqual(len(res["integrity"]), 1)
        self.assertIn("f-other", res["integrity"][0])
        self.assertFalse(has(r["labels"], "writer"))

    def test_verifierのflowに指摘があれば内容が一致してもblocked(self):
        r = run({"args": args(), "verifier_flow_findings_at": {"3v": 1}})
        res = r["result"]
        self.assertEqual(res["status"], "blocked")
        self.assertEqual(res["integrity"], [])
        self.assertIn("指摘が 1 件", res["reason"])
        self.assertFalse(has(r["labels"], "writer"))

    def test_3aでは候補の選択だけでもverifierが起動する(self):
        g0 = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]
        r = run({"args": g0["next_args"], "ruled_at": {"3a": ["RS-001"]}})
        self.assertEqual([l for l in r["labels"] if l.startswith(("resolver:", "verifier:"))], ["resolver:3a", "verifier:3av", "verifier:3bv"])
        self.assertEqual(r["result"]["status"], "done")

    def test_3aでflowを変えたresolverのsha256をverifierと照合する(self):
        g0 = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]
        ok = run({"args": g0["next_args"], "ruled_at": {"3a": ["RS-001"]}, "flow_sha_at": {"3a": "f-3a"}})
        self.assertEqual(ok["result"]["status"], "done")
        stale = run({"args": g0["next_args"], "ruled_at": {"3a": ["RS-001"]}, "flow_sha_at": {"3a": "f-3a"}, "verifier_flow_sha_at": {"3av": "f-framer"}})
        self.assertEqual(stale["result"]["status"], "blocked")
        self.assertEqual(stale["result"]["next_args"]["from"], "3a")

    def test_3aでflowの指摘を返したresolverは1回だけ差し戻す(self):
        g0 = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]
        fixed = run({"args": g0["next_args"], "ruled_at": {"3a": ["RS-001"]}, "flow_findings_at": {"3a": 2}})
        self.assertIn("resolver:3a-flow", fixed["labels"])
        self.assertEqual(fixed["result"]["status"], "done")
        broken = run({"args": g0["next_args"], "ruled_at": {"3a": ["RS-001"]}, "flow_findings_at": {"3a": 2, "3a-flow": 1}})
        self.assertEqual(broken["result"]["status"], "blocked")
        self.assertFalse(has(broken["labels"], "verifier:3av"))

    def test_3aでflowのstdoutを返さないresolverは差し戻す(self):
        g0 = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]
        r = run({"args": g0["next_args"], "ruled_at": {"3a": ["RS-001"]}, "no_flow_check_at": ["3a", "3a-flow"]})
        self.assertIn("resolver:3a-flow", r["labels"])
        self.assertEqual(r["result"]["status"], "blocked")


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class QuestionsCheck(unittest.TestCase):
    def test_形の検査に落ちた問いは1回差し戻し直ればneeds_answers(self):
        r = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}, "bad_questions_at": ["3"]})
        self.assertIn("resolver:3-questions", r["labels"])
        [again] = [p["prompt"] for p in r["prompts"] if p["label"] == "resolver:3-questions"]
        self.assertIn("questions --workspace /tmp/prd-w --ids RS-001 --check", again)
        self.assertEqual(r["result"]["status"], "needs_answers")
        self.assertEqual(r["result"]["question_ids"], ["RS-001"])

    def test_差し戻しでも直らなければblocked(self):
        r = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}, "bad_questions_at": ["3", "3-questions"]})
        self.assertEqual(r["result"]["status"], "blocked")
        self.assertEqual(r["result"]["next_args"]["from"], "3")
        self.assertEqual(sum(1 for l in r["labels"] if l.startswith("resolver:3-questions")), 1)

    def test_別の問いを検査したstdoutは合格にしない(self):
        r = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001", "RS-002"]}, "questions_check_ids_at": {"3": ["RS-001"]}})
        [again] = [p["prompt"] for p in r["prompts"] if p["label"] == "resolver:3-questions"]
        self.assertIn("RS-002", again)
        self.assertEqual(r["result"]["status"], "needs_answers")

    def test_問いが無ければ検査を求めない(self):
        r = run({"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"]}})
        self.assertNotIn("resolver:3-questions", r["labels"])


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class RerunFromTheSameStage(unittest.TestCase):
    """段の途中で止まり、返った next_args をそのまま渡して再実行すると、止まらなかった run と同じ状態になる。

    spec.world は W の flow.json に当たり、run をまたいで残る（stub が flow を state から組み直さない）。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.world = str(Path(self._tmp.name) / "world.json")

    def tearDown(self):
        self._tmp.cleanup()

    def _world(self, **kw):
        return {"world": self.world, **kw}

    def _resume(self, stopped, spec):
        res = stopped["result"]
        self.assertEqual(res["status"], "blocked", res)
        again = run({**spec, "args": res["next_args"]})
        self.assertIsNone(again["error"], again["error"])
        return again["result"]

    def _g0(self, **kw):
        return run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001", "RS-002"]}, **self._world(), **kw})["result"]

    def test_3aのverifierで止まっても候補の選択の回答を持ち越さない(self):
        g0 = self._g0()
        spec = {"ruled_at": {"3a": ["RS-001", "RS-002"]}, "questions_at": {"3a": ["RS-003"]}, **self._world()}
        whole = run({**spec, "args": g0["next_args"]})["result"]
        stopped = run({**spec, "args": g0["next_args"], "null_labels": ["verifier:3av", "verifier:3av#retry"]})
        self.assertNotIn("answered", stopped["result"]["next_args"]["state"])
        resumed = self._resume(stopped, spec)
        self.assertEqual(resumed["status"], "needs_answers")
        self.assertEqual(resumed["next_args"], whole["next_args"])

    def test_形の検査に落ちた問いを持ち越さない(self):
        spec = {"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}, **self._world()}
        whole = run(spec)["result"]
        stopped = run({**spec, "bad_questions_at": ["3", "3-questions"]})
        self.assertNotIn("RS-001", stopped["result"]["next_args"]["state"].get("questions", []))
        self.assertEqual(self._resume(stopped, spec)["next_args"], whole["next_args"])

    def test_段6のverifierで止まっても同じ状態から再開する(self):
        spec = {
            "args": args(), **self._world(),
            "findings": {"crossDoc:r1": [{"id": "r1-cd-all-001", "route": "decision"}]},
            "ruled_at": {"6": ["RS-011"]}, "questions_at": {"6": ["RS-010"]},
        }
        whole = run(spec)["result"]
        stopped = run({**spec, "null_labels": ["verifier:6v", "verifier:6v#retry"]})
        self.assertEqual(stopped["result"]["next_args"]["from"], "6")
        self.assertEqual(self._resume(stopped, {k: v for k, v in spec.items() if k != "args"})["next_args"], whole["next_args"])

    def test_段3で生成者のいないflowの食い違いはnext_argsを付けず行を重ねない(self):
        r = run({"args": args(), **self._world(), "tamper_before": {"verifier:3v": "f-x"}})["result"]
        self.assertEqual(r["status"], "blocked")
        self.assertIsNone(r["next_args"])
        self.assertIn("所有表の外", r["reason"])
        self.assertEqual(len(r["integrity"]), 1)

    def test_3aのflowの食い違いは同じ段の再実行で生成者が検査し直す(self):
        g0 = self._g0()
        spec = {"ruled_at": {"3a": ["RS-001", "RS-002"]}, "questions_at": {"3a": ["RS-003"]}, **self._world()}
        stopped = run({**spec, "args": g0["next_args"], "tamper_before": {"verifier:3av": "f-x"}})
        self.assertEqual(stopped["result"]["next_args"]["from"], "3a")
        self.assertEqual(len(stopped["result"]["integrity"]), 1)
        resumed = self._resume(stopped, spec)
        self.assertEqual((resumed["status"], resumed["integrity"]), ("needs_answers", []))
        whole = run({**spec, "args": g0["next_args"]})["result"]
        self.assertEqual(resumed["next_args"], whole["next_args"], "W の flow.json が f-x のまま止まらずに走った run と同じ")


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class ValuelessResolversKeepFlow(unittest.TestCase):
    """値を決めない resolver の呼び出し（変換・保持規則・問いの形の修正・上限の後）は flow.json を書かない。"""

    def _g02(self):
        g0 = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]
        return run({"args": g0["next_args"], "ruled_at": {"3a": ["RS-001"]}, "questions_at": {"3a": ["RS-002"]}})["result"]

    def test_保持規則への変換がflowを変えなければ進む(self):
        r = run({"args": self._g02()["next_args"]})
        self.assertIn("resolver:3a-hold", r["labels"])
        [p] = [x["prompt"] for x in r["prompts"] if x["label"] == "resolver:3a-hold"]
        self.assertIn("flow.json を書かない", p)
        self.assertEqual(r["result"]["status"], "done")

    def test_保持規則への変換がflowを変えたらnext_argsを付けずにblocked(self):
        r = run({"args": self._g02()["next_args"], "flow_sha_at": {"3a-hold": "f-bad"}})["result"]
        self.assertEqual((r["status"], r["next_args"]), ("blocked", None))
        self.assertEqual(len(r["integrity"]), 1)

    def test_変換がflowを変えたらblocked(self):
        fail = {"id": "RS-001", "kind": "insufficient_grounds", "reason": "出典が無い"}
        spec = {"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"], "3'": ["RS-001"]}, "verifier_fail": {"3v": [fail], "3v'": [fail]}}
        self.assertEqual(run(spec)["result"]["status"], "done")
        r = run({**spec, "flow_sha_at": {"3-convert": "f-bad"}})["result"]
        self.assertEqual((r["status"], r["next_args"]), ("blocked", None))

    def test_問いの形の修正がflowを変えたらblocked(self):
        spec = {"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}, "bad_questions_at": ["3"], "flow_sha_at": {"3-questions": "f-bad"}}
        r = run(spec)["result"]
        self.assertEqual((r["status"], r["next_args"]), ("blocked", None))

    def test_flowのstdoutを返さなければ同じ段から再実行できる(self):
        r = run({"args": self._g02()["next_args"], "no_flow_check_at": ["3a-hold"]})["result"]
        self.assertEqual((r["status"], r["next_args"]["from"]), ("blocked", "3a"))


    def _final(self, **kw):
        blocking = {"id": "x", "blocking": True, "route": "writer"}
        return run({
            "args": args(),
            "findings": {
                "implementer:r1": [{**blocking, "id": "r1-im-requirements__x-001"}],
                "grounding:r2": [{**blocking, "id": "r2-gr-requirements__x-001"}],
                "grounding:r3": [{**blocking, "id": "r3-gr-requirements__x-001"}],
            },
            **kw,
        })["result"]

    def test_上限の後の変換がflowを変えたらその理由でblocked(self):
        ok = self._final()
        self.assertEqual((ok["status"], ok["integrity"]), ("blocked", []))
        r = self._final(flow_sha_at={"final": "f-bad"})
        self.assertEqual((r["status"], r["next_args"], len(r["integrity"])), ("blocked", None, 1))
        self.assertIn("flow.json が変わっています", r["reason"])
        self.assertEqual(r["report_path"], "/tmp/prd-w/report.md")

    def test_上限の後の変換がflowのstdoutを返さなければ段8からやり直す(self):
        r = self._final(no_flow_check_at=["final"])
        self.assertEqual((r["status"], r["next_args"]["from"]), ("blocked", "8"))


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class FlowRecheck(unittest.TestCase):
    """flow を変えた呼び出しの後に、新しい組を resolver に、検証を通っていない要素を verifier に回す（A2）。
    裁定で閉じた O- だけを出典に持つ要素（前回の F-090・F-091）は、どの段でも flow-framer:<段>-settle に直させる。"""

    def _g0(self):
        return run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]

    def _prompt(self, r, label):
        [p] = [x["prompt"] for x in r["prompts"] if x["label"] == label]
        return p

    def test_3aでflowが変わると新しい組はresolverに_unverifiedはverifierに渡る(self):
        spec = {"args": self._g0()["next_args"], "ruled_at": {"3a": ["RS-001"], "3a-pairs": ["RS-002"]}, "flow_sha_at": {"3a": "f-3a"},
                "pair_keys_at": {"3a": ["pair:D-001|F-099"]}, "unverified_at": {"3a": ["F-099"]}}
        r = run(spec)
        self.assertEqual([l for l in r["labels"] if l.startswith(("resolver:", "verifier:"))], ["resolver:3a", "resolver:3a-pairs", "verifier:3av", "verifier:3bv"])
        self.assertIn("pair:D-001|F-099", self._prompt(r, "resolver:3a-pairs"))
        v = self._prompt(r, "verifier:3av")
        self.assertIn("F-099", v)
        self.assertIn("RS-002", v.split("検証する resolution の ID:")[1].split("\n")[0])
        self.assertEqual(r["result"]["status"], "done")
        self.assertIn("pair:D-001|F-099", r["result"]["missed"], "about に組が現れなければ裁定漏れに数える")

    def test_flowが変わらなければ組を検査し直さない(self):
        r = run({"args": self._g0()["next_args"], "ruled_at": {"3a": ["RS-001"]}, "pair_keys_at": {"3a": ["pair:D-001|F-099"]}, "unverified_at": {"3a": ["F-099"]}})
        self.assertNotIn("resolver:3a-pairs", r["labels"])
        self.assertNotIn("F-099", self._prompt(r, "verifier:3av"))

    def test_同じ呼び出しで裁定中の組は渡し直さない(self):
        # RS-005 はまだ verifier を通っていない（closedKeys に無い）が、about には入っている。
        spec = {"args": self._g0()["next_args"], "ruled_at": {"3a": ["RS-001", "RS-005"]}, "flow_sha_at": {"3a": "f-3a"},
                "about": {"RS-005": {"pair": ["F-099", "D-001"]}}, "pair_keys_at": {"3a": ["pair:D-001|F-099"]}}
        self.assertNotIn("resolver:3a-pairs", run(spec)["labels"])

    def test_組でないaboutの値は組の裁定として数えない(self):
        spec = {"args": self._g0()["next_args"], "ruled_at": {"3a": ["RS-001"]}, "flow_sha_at": {"3a": "f-3a"}, "pair_keys_at": {"3a": ["open:O-RS-001"]}}
        self.assertIn("resolver:3a-pairs", run(spec)["labels"])

    def test_自由記述の回答で閉じたOも同じcycleでsettleする(self):
        spec = {"args": self._g0()["next_args"], "ruled_at": {"3a": ["RS-001"]}, "free_text_at": {"3a": ["RS-001"]},
                "open_only_at": {"3av": [{"el": "F-091", "open": "O-RS-001"}]}}
        r = run(spec)
        self.assertIn("flow-framer:3a-settle", r["labels"])
        self.assertEqual(r["result"]["status"], "done")

    def test_flowを変えたのにconflictsのstdoutが無ければblocked(self):
        r = run({"args": self._g0()["next_args"], "ruled_at": {"3a": ["RS-001"]}, "flow_sha_at": {"3a": "f-3a"}, "no_conflicts_check_at": ["3a"]})
        self.assertNotIn("verifier:3av", r["labels"])
        self.assertEqual((r["result"]["status"], r["result"]["next_args"]["from"]), ("blocked", "3a"))

    def test_同じcycleで閉じたOだけを出典に持つ要素はsettleで直す(self):
        g0 = self._g0()
        only = [{"el": "F-091", "open": "O-RS-001"}, {"el": "F-092", "open": "O-RS-009"}]
        spec = {"args": g0["next_args"], "ruled_at": {"3a": ["RS-001"]}, "open_only_at": {"3av": only}, "unverified_at": {"3a-settle": ["F-091"]}}
        r = run(spec)
        self.assertEqual([l for l in r["labels"] if l.startswith(("resolver:", "verifier:", "flow-framer"))],
                         ["resolver:3a", "verifier:3av", "flow-framer:3a-settle", "verifier:3av-settle", "flow-framer:3b-reframe", "verifier:3bv"])
        framer = self._prompt(r, "flow-framer:3a-settle")
        self.assertIn("F-091（O-RS-001 ← RS-001）", framer)
        self.assertNotIn("F-092", framer, "開いたままの O- の要素は直させない")
        v = self._prompt(r, "verifier:3av-settle")
        self.assertIn("F-091", v)
        self.assertEqual(v.split("検証する resolution の ID:")[1].split("\n")[0].strip(), "（なし）")
        self.assertEqual(r["result"]["status"], "done")
        self.assertEqual(r["result"]["next_args"], None)

        for left in ({"open_only_at": {"3av": only, "3av-settle": only[:1]}}, {"unverified_at": {"3a-settle": ["F-091"], "3av-settle": ["F-091"]}, "open_only_at": {"3av": only}},
                     {"verifier_fail": {"3av-settle": [{"id": "F-091", "kind": "mapping", "reason": "r"}]}, "open_only_at": {"3av": only}}):
            with self.subTest(left=left):
                stopped = run({**spec, **left})["result"]
                self.assertEqual((stopped["status"], stopped["next_args"]["from"]), ("blocked", "3a"))
                self.assertEqual(stopped["next_args"]["state"], g0["next_args"]["state"], "段の頭の state からやり直す")

    def test_caseの出典だけが閉じたOを指すときもsettleでそのマスを直す(self):
        spec = {"args": self._g0()["next_args"], "ruled_at": {"3a": ["RS-001"]}, "open_only_at": {"3av": [{"el": "F-004", "case": 2, "open": "O-RS-001"}]},
                "unverified_at": {"3a-settle": ["F-004"]}}
        r = run(spec)
        self.assertIn("F-004 の case 2（O-RS-001 ← RS-001）", self._prompt(r, "flow-framer:3a-settle"))
        self.assertIn("F-004", self._prompt(r, "verifier:3av-settle"))
        self.assertEqual(r["result"]["status"], "done")
        left = run({**spec, "open_only_at": {**spec["open_only_at"], "3av-settle": spec["open_only_at"]["3av"]}})["result"]
        self.assertEqual(left["status"], "blocked")
        self.assertIn("F-004 の case 2", left["reason"])

    def test_書き換えていない不合格のFは検証に渡さずsettleは進む(self):
        # unverified と failed_current は stub ではなく、F-002 に fail を put した実際の W で doc_check flow を叩いた stdout から取る。
        with tempfile.TemporaryDirectory() as tmp:
            ws = Path(tmp) / "W"
            shutil.copytree(Path(__file__).resolve().parent / "fixtures" / "workspace", ws)
            cli = lambda *a, stdin=None: json.loads(subprocess.run(["node", str(SKILL / "scripts" / "doc_check.mjs"), *a, "--workspace", str(ws)],
                                                                   input=stdin, capture_output=True, text=True, check=True).stdout)
            shas = [cli("sha", "--ledger", x)["sha256"] for x in ("resolutions", "decisions")]
            cli("put", "--ledger", "verifications", "--expect-resolutions", shas[0], "--expect-decisions", shas[1],
                stdin=json.dumps({"items": [{"id": "F-002", "verdict": "fail", "fail_kind": "insufficient_grounds", "reason": "r"}]}))
            got = cli("flow")
        unverified, failed = got["unverified"], got["failed_current"]
        self.assertIn("F-002", unverified)
        self.assertEqual(failed, ["F-002"])
        fail = [{"id": "F-002", "kind": "insufficient_grounds", "reason": "出典が無い"}]
        g0 = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}, "verifier_fail": {"3v": fail, "3v'": fail}})["result"]
        self.assertEqual(g0["status"], "needs_answers")
        self.assertEqual(g0["next_args"]["state"]["flow_failed"], ["F-002"])
        self.assertNotIn("F-002", g0["next_args"]["state"]["failed_ids"])
        only = [{"el": "F-003", "open": "O-RS-001"}]
        r = run({"args": g0["next_args"], "ruled_at": {"3a": ["RS-001"]}, "flow_sha_at": {"3a": "f-3a"}, "unverified_at": {"3a": unverified, "3a-settle": unverified, "3av-settle": ["F-002"]},
                 "failed_current_at": {"3a": failed}, "open_only_at": {"3av": only}, "fails_when_asked": fail})
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))
        self.assertEqual([l for l in r["labels"] if l.startswith(("resolver:", "verifier:", "flow-framer"))],
                         ["resolver:3a", "verifier:3av", "flow-framer:3a-settle", "verifier:3av-settle", "flow-framer:3b-reframe", "verifier:3bv"], "不合格の F- を渡さないので差し戻しも変換も起きない")
        for label in ("verifier:3av", "verifier:3av-settle"):
            self.assertNotIn("F-002", self._prompt(r, label))
        self.assertIn("F-003", self._prompt(r, "verifier:3av-settle"))

    def test_検証に落ちた要素でもsettleで直させたら必ず検証する(self):
        fail = [{"id": "F-003", "kind": "insufficient_grounds", "reason": "出典が無い"}]
        g0 = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}, "verifier_fail": {"3v": fail, "3v'": fail}})["result"]
        self.assertEqual(g0["next_args"]["state"]["flow_failed"], ["F-003"])
        r = run({"args": g0["next_args"], "ruled_at": {"3a": ["RS-001"]}, "open_only_at": {"3av": [{"el": "F-003", "open": "O-RS-001"}]},
                 "unverified_at": {"3a-settle": ["F-003"]}})
        self.assertIn("F-003", self._prompt(r, "verifier:3av-settle"))
        self.assertEqual(r["result"]["status"], "done")

    def _rewritten_after_fail(self):
        fail = [{"id": "F-003", "kind": "insufficient_grounds", "reason": "出典が無い"}]
        g0 = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}, "verifier_fail": {"3v": fail, "3v'": fail}})["result"]
        self.assertEqual(g0["next_args"]["state"]["flow_failed"], ["F-003"])
        return run({"args": g0["next_args"], "ruled_at": {"3a": ["RS-001"]}, "flow_sha_at": {"3a": "f-3a"},
                    "unverified_at": {"3a": ["F-003"]}, "failed_current_at": {"3a": []}})

    def test_不合格の後に書き換えた要素は次のverifierで検証する(self):
        r = self._rewritten_after_fail()
        self.assertRegex(self._prompt(r, "verifier:3av"), r"あわせて検証する: flow.json の要素 [^\n]*F-003")
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))

    def test_差し戻しの後も落ちた要素は変換に渡さずblocked(self):
        fail = [{"id": "F-003", "kind": "insufficient_grounds", "reason": "出典が無い"}]
        r = run({"args": self._g0()["next_args"], "ruled_at": {"3a": ["RS-001"]}, "flow_sha_at": {"3a": "f-3a", "3a'": "f-3a2"},
                 "unverified_at": {"3a": ["F-003"], "3a'": ["F-003"]}, "failed_current_at": {"3a'": []}, "fails_when_asked": fail})
        self.assertRegex(self._prompt(r, "verifier:3av'"), r"あわせて検証する: flow.json の要素 [^\n]*F-003")
        self.assertNotIn("resolver:3a-convert", r["labels"])
        res = r["result"]
        self.assertEqual((res["status"], res["next_args"]), ("blocked", None))
        self.assertIn("F-003", res["reason"])

    def test_書き換えて合格した要素をwriterに根拠にしない要素として渡さない(self):
        grounds = self._prompt(self._rewritten_after_fail(), "writer:U-1:draft")
        self.assertIn("出典が検証に落ちた流れの要素（この要素を根拠に規範を書かない）: （なし）", grounds)

    def _verification_ruled(self):
        fail = [{"id": "F-003", "kind": "insufficient_grounds", "reason": "出典が無い"}]
        return run({"args": args(), "verifier_fail": {"3v": fail}, "ruled_at": {"3'": ["RS-005"]}, "about": {"RS-005": {"verification": "F-003"}},
                    "unverified_at": {"3-settle": ["F-003"]}, "failed_current_at": {"3-settle": []}})

    def test_検証の裁定は同じ段のsettleでflowに写し検証する(self):
        r = self._verification_ruled()
        self.assertEqual([l for l in r["labels"] if l.startswith(("resolver:", "verifier:", "flow-framer:"))],
                         ["verifier:3v", "resolver:3'", "verifier:3v'", "flow-framer:3-settle", "verifier:3v-settle"])
        self.assertIn("F-003 ← RS-005", self._prompt(r, "flow-framer:3-settle"))
        self.assertRegex(self._prompt(r, "verifier:3v-settle"), r"あわせて検証する: flow.json の要素 [^\n]*F-003")
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))

    def test_検証の裁定を写した要素をwriterに根拠にしない要素として渡さない(self):
        grounds = self._prompt(self._verification_ruled(), "writer:U-1:draft")
        self.assertIn("出典が検証に落ちた流れの要素（この要素を根拠に規範を書かない）: （なし）", grounds)

    def test_書き換えなかった検証の裁定の要素もsettleの検証に回す(self):
        fail = [{"id": "F-003", "kind": "insufficient_grounds", "reason": "出典が無い"}]
        r = run({"args": args(), "verifier_fail": {"3v": fail}, "ruled_at": {"3'": ["RS-005"]}, "about": {"RS-005": {"verification": "F-003"}},
                 "unverified_at": {"3-settle": ["F-003"]}, "fails_when_asked": fail})
        self.assertNotIn("F-003", self._prompt(r, "verifier:3v'"))
        self.assertRegex(self._prompt(r, "verifier:3v-settle"), r"あわせて検証する: flow.json の要素 [^\n]*F-003")
        self.assertEqual((r["result"]["status"], r["result"]["next_args"]["from"]), ("blocked", "3"))
        self.assertIn("不合格: F-003", r["result"]["reason"])

    def test_verifierが返したFの合否がverificationsに無ければblocked(self):
        fail = [{"id": "F-003", "kind": "insufficient_grounds", "reason": "出典が無い"}]
        unput = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}, "verifier_fail": {"3v": fail}, "failed_current_at": {"3v": []}})
        self.assertEqual([l for l in unput["labels"] if l.startswith(("resolver:", "verifier:"))], ["resolver:3", "verifier:3v"])
        passed = run({"args": self._g0()["next_args"], "ruled_at": {"3a": ["RS-001"]}, "flow_sha_at": {"3a": "f-3a"}, "unverified_at": {"3a": ["F-003"], "3av": ["F-003"]}})
        self.assertIn("verifier:3av", passed["labels"])
        for name, r, frm in (("fail を put していない", unput, "3"), ("pass を put していない", passed, "3a")):
            with self.subTest(name):
                res = r["result"]
                self.assertEqual((res["status"], res["next_args"]["from"]), ("blocked", frm))
                self.assertIn("F-003", res["reason"])
                self.assertTrue(any("F-003" in line for line in res["integrity"]), res["integrity"])

    def test_決定の検証の裁定は覆した決定を引く要素が無ければsettleしない(self):
        fail = [{"id": "D-003", "kind": "insufficient_grounds", "reason": "出典が無い"}]
        r = run({"args": args(), "verifier_fail": {"3v": fail}, "ruled_at": {"3'": ["RS-005"]}, "about": {"RS-005": {"verification": "D-003"}}})
        self.assertFalse(has(r["labels"], "flow-framer:3-settle"))
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))

    def test_覆された決定を引く要素はsettleで直し検証する(self):
        fail = [{"id": "D-003", "kind": "insufficient_grounds", "reason": "出典が無い"}]
        stale = [{"el": "F-002", "ref": "D-003"}]
        spec = {"args": args(), "verifier_fail": {"3v": fail}, "ruled_at": {"3'": ["RS-005"]}, "about": {"RS-005": {"verification": "D-003"}},
                "stale_refs_at": {"3v'": stale}, "unverified_at": {"3-settle": ["F-002"]}}
        r = run(spec)
        self.assertEqual([l for l in r["labels"] if l.startswith(("resolver:", "verifier:", "flow-framer:"))],
                         ["verifier:3v", "resolver:3'", "verifier:3v'", "flow-framer:3-settle", "verifier:3v-settle"])
        self.assertIn("F-002 ← D-003", self._prompt(r, "flow-framer:3-settle"))
        self.assertRegex(self._prompt(r, "verifier:3v-settle"), r"あわせて検証する: flow.json の要素 [^\n]*F-002")
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))
        left = run({**spec, "stale_refs_at": {"3v'": stale, "3v-settle": stale}})["result"]
        self.assertEqual((left["status"], left["next_args"]["from"]), ("blocked", "3"))
        self.assertIn("覆された決定を引く要素: F-002（D-003）", left["reason"])

    def test_段3で閉じたOも同じcycleでsettleする(self):
        r = run({"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"]}, "open_only_at": {"3v": [{"el": "F-091", "open": "O-RS-001"}]}})
        self.assertIn("flow-framer:3-settle", r["labels"])
        self.assertEqual(r["labels"][r["labels"].index("flow-framer:3-settle") + 1], "verifier:3v-settle")
        self.assertEqual(r["result"]["status"], "done")

    def test_保持規則と回答待ちの問いで閉じたOではsettleしない(self):
        only = [{"el": "F-091", "open": "O-RS-001"}]
        held = run({"args": args(), "flow_open": 1, "holds_at": {"3": ["RS-001"]}, "open_only_at": {"3v": only}})
        self.assertFalse(has(held["labels"], "flow-framer:3-settle"))
        asked = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}, "open_only_at": {"3v": only}})
        self.assertFalse(has(asked["labels"], "flow-framer:3-settle"))
        self.assertEqual(asked["result"]["status"], "needs_answers")

    def test_段6でも同じ経路でsettleする(self):
        spec = {"args": args(), "findings": {"crossDoc:r1": [{"id": "r1-cd-all-001", "route": "decision"}]}, "ruled_at": {"6": ["RS-011"]},
                "open_only_at": {"6v": [{"el": "F-091", "open": "O-RS-011"}]}}
        r = run(spec)
        self.assertIn("flow-framer:6-settle", r["labels"])
        self.assertEqual(r["labels"][r["labels"].index("flow-framer:6-settle") + 1], "verifier:6v-settle")
        stopped = run({**spec, "open_only_at": {"6v": spec["open_only_at"]["6v"], "6v-settle": spec["open_only_at"]["6v"]}})["result"]
        self.assertEqual((stopped["status"], stopped["next_args"]["from"]), ("blocked", "6"))

    def test_settleでflowが閉じなければ1回だけ差し戻し直らなければblocked(self):
        spec = {"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"]}, "open_only_at": {"3v": [{"el": "F-091", "open": "O-RS-001"}]}}
        fixed = run({**spec, "flow_findings_at": {"3-settle": 1}, "pair_keys_at": {"3-settle-rework": ["pair:D-001|F-099"]}})
        self.assertEqual([l for l in fixed["labels"] if "settle" in l],
                         ["flow-framer:3-settle", "flow-framer:3-settle:rework", "resolver:3-settle-pairs", "verifier:3v-settle"], "組は差し戻した後の stdout から読む")
        self.assertIn("指摘が 1 件", self._prompt(fixed, "flow-framer:3-settle:rework"))
        self.assertEqual(fixed["result"]["status"], "done")
        broken = run({**spec, "flow_findings_at": {"3-settle": 1, "3-settle-rework": 1}})
        self.assertEqual([l for l in broken["labels"] if "settle" in l], ["flow-framer:3-settle", "flow-framer:3-settle:rework"])
        self.assertEqual((broken["result"]["status"], broken["result"]["next_args"]["from"]), ("blocked", "3"))


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class FindingRoutes(unittest.TestCase):
    """前のパスの指摘の受け渡し・direction の逆転・指摘の由来層（origin）の経路。"""

    ITEM = "PR-X-001"

    def _prompt(self, r, label):
        return next(p["prompt"] for p in r["prompts"] if p["label"] == label)

    def _reversal(self, r3_direction):
        return run({"args": args(), "findings": {
            "implementer:r1": [{"id": "r1-im-requirements__x-001"}],
            "grounding:r2": [{"id": "r2-gr-requirements__x-001", "direction": "tighten"}],
            "grounding:r3": [{"id": "r3-gr-requirements__x-001", "direction": r3_direction}],
        }})

    def test_前のパスと逆向きの指摘はdecisionになり2パス目なのでhold行きになる(self):
        r = self._reversal("relax")
        self.assertEqual(r["result"]["status"], "blocked")
        self.assertIn("route が decision の指摘 r3-gr-requirements__x-001", self._prompt(r, "resolver:final"))
        same = self._reversal("tighten")
        self.assertNotIn("r3-gr-requirements__x-001", self._prompt(same, "resolver:final"))

    def test_段8の監査に同じ項目への前のパスの指摘のIDが入る(self):
        r = self._reversal("relax")
        self.assertIn("同じ項目への前のパスの指摘: r1-im-requirements__x-001", self._prompt(r, "grounding:r2:requirements/x"))
        self.assertIn("同じ項目への前のパスの指摘: r2-gr-requirements__x-001", self._prompt(r, "grounding:r3:requirements/x"))
        self.assertNotIn("前のパスの指摘", self._prompt(r, "grounding:r1:requirements/x"))

    def test_改稿のwriterに項目のtraceが指すflow要素のIDを渡す(self):
        r = run({"args": args(), "doc_flow_refs": {"requirements/x": {"PR-X-001": ["F-011", "F-010"]}, "requirements/y": {"PR-X-002": ["F-099"]}},
                 "findings": {"implementer:r1": [{"id": "r1-im-requirements__x-001", "blocking": False},
                                                 {"id": "r1-im-requirements__x-002", "item_id": "PR-X-002", "blocking": False}]}})
        revise = self._prompt(r, "writer:U-1:revise")
        self.assertIn("- requirements/x PR-X-001: r1-im-requirements__x-001（trace が指す flow 要素: F-010, F-011）", revise)
        self.assertIn("- requirements/x PR-X-002: r1-im-requirements__x-002\n", revise, "別の文書の同じ項目 ID の要素は渡さない")
        self.assertNotIn("F-099", revise)
        none = self._prompt(run({"args": args(), "findings": {"implementer:r1": [{"id": "r1-im-requirements__x-001", "blocking": False}]}}), "writer:U-1:revise")
        self.assertNotIn("flow 要素", none, "flow_refs の無い項目では行を出さない")

    FLOW_FINDING = "r1-im-requirements__x-001"

    def _flow_finding(self, **kw):
        spec = {"args": args(), "findings": {"implementer:r1": [{"id": self.FLOW_FINDING, "route": "writer", "origin": "flow", "blocking": False}]},
                "ruled_at": {"6": ["RS-011"]}, "about": {"RS-011": {"finding": self.FLOW_FINDING}}, "unverified_at": {"6-settle": ["F-010"]}}
        spec.update(kw)
        return run(spec)

    def test_originがflowの指摘はwriterの束に入らず段6に届く(self):
        r = self._flow_finding()
        self.assertIn(f"route が decision の指摘 {self.FLOW_FINDING}", self._prompt(r, "resolver:6"))
        self.assertNotIn(self.FLOW_FINDING, self._prompt(r, "writer:U-1:revise"))
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))

    def test_originがflowの指摘の裁定はsettleでflowに写し変わった要素を検証する(self):
        r = self._flow_finding()
        settle = [l for l in r["labels"] if "settle" in l]
        self.assertEqual(settle, ["flow-framer:6-settle", "verifier:6v-settle"], "閉じた O- が無くても起動する")
        self.assertIn(f"{self.FLOW_FINDING}（← RS-011）", self._prompt(r, "flow-framer:6-settle"))
        self.assertIn("F-010", self._prompt(r, "verifier:6v-settle"))
        fail = [{"id": "F-010", "kind": "insufficient_grounds", "reason": "出典が無い"}]
        failed = self._flow_finding(verifier_fail={"3v": fail, "3v'": fail})
        self.assertIn("F-010", self._prompt(failed, "verifier:6v-settle"), "検証に落ちた要素でも、指摘から直させたら検証する")
        text = run({**{"args": args()}, "findings": {"implementer:r1": [{"id": self.FLOW_FINDING, "route": "decision", "origin": "text", "blocking": False}]},
                    "ruled_at": {"6": ["RS-011"]}, "about": {"RS-011": {"finding": self.FLOW_FINDING}}})
        self.assertFalse(has(text["labels"], "flow-framer:6-settle"), "origin が text の指摘の裁定は flow に写さない")

    def test_G1の後の3aでは段6で写した指摘を写し直さない(self):
        g1 = self._flow_finding(questions_at={"6": ["RS-012"]})
        self.assertEqual(g1["result"]["status"], "needs_answers")
        self.assertIn("flow-framer:6-settle", g1["labels"])
        r = run({"args": g1["result"]["next_args"], "ruled_at": {"3a'": ["RS-012"]}, "about": {"RS-011": {"finding": self.FLOW_FINDING}}})
        self.assertFalse(has(r["labels"], "flow-framer:3a'-settle"))
        self.assertEqual(r["result"]["status"], "done", r["result"].get("reason"))

    def test_監査役の返り値のスキーマはdirectionとoriginを契約の値に絞る(self):
        item = run({"args": args()})["auditSchema"]["properties"]["findings"]["items"]
        self.assertEqual(sorted(item["properties"]["direction"]["enum"]), contract_values("direction"))
        self.assertEqual(sorted(item["properties"]["origin"]["enum"]), contract_values("origin"))
        self.assertLessEqual({"direction", "origin"}, set(item["required"]))


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class Reframe(unittest.TestCase):
    """G0 の回答で flow を組み直す段 3b と、追加の問いを G0-2 の 1 回に集める経路（A5）。"""

    def _g0(self, **kw):
        return run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}, **kw})["result"]

    def _prompt(self, r, label):
        return next(p["prompt"] for p in r["prompts"] if p["label"] == label)

    def _cycle(self, labels):
        return [l for l in labels if l.startswith(("resolver:", "verifier:", "flow-framer"))]

    def test_G0からG0_2を経て初稿に進む(self):
        g02 = run({"args": self._g0()["next_args"], "ruled_at": {"3a": ["RS-001"]}, "questions_at": {"3a": ["RS-002"], "3b": ["RS-002"]}})
        self.assertEqual(self._cycle(g02["labels"]), ["resolver:3a", "verifier:3av", "flow-framer:3b-reframe", "resolver:3b", "verifier:3bv"])
        res = g02["result"]
        self.assertEqual((res["status"], res["answers_path"], res["next_args"]["from"]), ("needs_answers", "/tmp/prd-w/answers/g0-2.md", "3a"))
        r = run({"args": res["next_args"], "ruled_at": {"3a": ["RS-002"]}})
        self.assertEqual(self._cycle(r["labels"]), ["resolver:3a", "verifier:3av"], "G0-2 の回答の後は組み直さない")
        self.assertEqual(r["labels"][2], "writer:U-1:draft")
        self.assertEqual(r["result"]["status"], "done")

    def test_持ち越した問いは3bの後にも問いの形を検査する(self):
        r = run({"args": self._g0()["next_args"], "ruled_at": {"3a": ["RS-001"]}, "questions_at": {"3a": ["RS-002"]}})
        self.assertIn("--ids RS-002 --check", self._prompt(r, "resolver:3b-questions"), "返さなかった持ち越しの問いも検査させる")
        self.assertEqual(r["result"]["question_ids"], ["RS-002"])
        broken = run({"args": self._g0()["next_args"], "ruled_at": {"3a": ["RS-001"]}, "questions_at": {"3a": ["RS-002"]}, "bad_questions_at": ["3b-questions"]})["result"]
        self.assertEqual((broken["status"], broken["next_args"]["from"]), ("blocked", "3b"))

    def test_3aの問いと3bの問いを1回のG0_2で聞く(self):
        r = run({"args": self._g0()["next_args"], "ruled_at": {"3a": ["RS-001"]}, "questions_at": {"3a": ["RS-002"], "3b": ["RS-003"]}})
        self.assertNotIn("resolver:3a-hold", r["labels"])
        self.assertIn("RS-002", self._prompt(r, "resolver:3b"))
        self.assertIn("根拠にしてよい resolution（合格・回答済み）: RS-001\n", self._prompt(r, "flow-framer:3b-reframe"), "回答待ちの RS-002 は出典にさせない")
        self.assertEqual((r["result"]["status"], r["result"]["question_ids"]), ("needs_answers", ["RS-002", "RS-003"]))

    def test_3bで決まった問いはG0_2で聞かない(self):
        spec = {"args": self._g0()["next_args"], "ruled_at": {"3a": ["RS-001"], "3b": ["RS-002"]}, "questions_at": {"3a": ["RS-002"]}}
        r = run(spec)
        self.assertIn("RS-002", self._prompt(r, "verifier:3bv").split("検証する resolution の ID:")[1].split("\n")[0])
        self.assertEqual(r["result"]["status"], "done")
        both = run({**spec, "questions_at": {"3a": ["RS-002"], "3b": ["RS-003"]}})["result"]
        self.assertEqual(both["question_ids"], ["RS-003"])

    def test_3bで問いが0件ならG0_2を出さない(self):
        r = run({"args": self._g0()["next_args"], "ruled_at": {"3a": ["RS-001"]}})
        self.assertNotIn("resolver:3b", r["labels"])
        self.assertEqual(r["result"]["status"], "done")

    def test_G0_2の後に出た問いは保持規則になる(self):
        g02 = run({"args": self._g0()["next_args"], "ruled_at": {"3a": ["RS-001"]}, "questions_at": {"3a": ["RS-002"]}})["result"]
        r = run({"args": g02["next_args"], "ruled_at": {"3a": ["RS-002"]}, "questions_at": {"3a": ["RS-003"]}})
        self.assertIn("依頼者にはもう聞けない", self._prompt(r, "resolver:3a"))
        self.assertIn("resolver:3a-hold", r["labels"])
        self.assertFalse(has(r["labels"], "flow-framer:3b"))
        self.assertEqual(r["result"]["status"], "done")
        self.assertIn("RS-003", r["result"]["holds"])
        self.assertEqual(r["result"]["hold_drafts"], [])

    def test_組み直しで出たopenと組をresolverに渡す(self):
        spec = {"args": self._g0()["next_args"], "ruled_at": {"3a": ["RS-001"], "3b": ["RS-005"]},
                "about": {"RS-005": {"open": "O-020"}},
                "open_ids_at": {"3b-reframe": ["O-020", "O-021", "O-RS-001"]},
                "pair_keys_at": {"3b-reframe": ["pair:D-010|F-035"]}}
        r = run(spec)
        task = self._prompt(r, "resolver:3b")
        self.assertIn("まだ裁定の無い open: O-020, O-021", task, "要素の出典に現れない O- も渡し、裁定済みの O-RS-001 は渡さない")
        self.assertIn("pair:D-010|F-035", task)
        self.assertEqual(r["result"]["missed"], ["open:O-021", "pair:D-010|F-035"])

    def test_組み直したflowは解決が無くても3bvが照合する(self):
        spec = {"args": self._g0()["next_args"], "ruled_at": {"3a": ["RS-001"]}, "unverified_at": {"3b-reframe": ["F-040"]}}
        r = run(spec)
        v = self._prompt(r, "verifier:3bv")
        self.assertEqual(v.split("検証する resolution の ID:")[1].split("\n")[0].strip(), "（なし）")
        self.assertIn("F-040", v)
        self.assertEqual(r["result"]["status"], "done")
        stale = run({**spec, "verifier_flow_sha_at": {"3bv": "f-framer"}})["result"]
        self.assertEqual((stale["status"], stale["next_args"]["from"]), ("blocked", "3b"))
        self.assertEqual(len(stale["integrity"]), 1)

    def test_組み直したflowが閉じなければ差し戻す(self):
        spec = {"args": self._g0()["next_args"], "ruled_at": {"3a": ["RS-001"]}}
        fixed = run({**spec, "flow_findings_at": {"3b-reframe": 1}})
        self.assertIn("flow-framer:3b-reframe:rework", fixed["labels"])
        self.assertEqual(fixed["result"]["status"], "done")
        broken = run({**spec, "flow_findings_at": {"3b-reframe": 1, "3b-reframe-rework": 1}})
        self.assertEqual(sum(1 for l in broken["labels"] if l.startswith("flow-framer:3b-reframe")), 1 + 1)
        self.assertFalse(has(broken["labels"], "verifier:3bv"))
        self.assertEqual((broken["result"]["status"], broken["result"]["next_args"]["from"]), ("blocked", "3b"))

    def test_flowを書く権限の無いresolverがflowを変えたら止まる(self):
        g0 = self._g0()
        cases = (
            ({"args": g0["next_args"], "ruled_at": {"3a": ["RS-001"]}, "questions_at": {"3a": ["RS-002"], "3b": ["RS-002"]}, "flow_sha_at": {"3b": "f-evil"}}, "resolver:3b"),
            ({"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"]}, "flow_sha_at": {"3": "f-evil"}}, "resolver:3"),
            ({"args": args(), "findings": {"crossDoc:r1": [{"id": "r1-cd-all-001", "route": "decision"}]}, "ruled_at": {"6": ["RS-011"]}, "flow_sha_at": {"6": "f-evil"}}, "resolver:6"),
        )
        for spec, label in cases:
            with self.subTest(label=label):
                r = run(spec)
                self.assertIn("この呼び出しでは flow.json を書かない", self._prompt(r, label))
                res = r["result"]
                self.assertEqual((res["status"], res["next_args"], len(res["integrity"])), ("blocked", None, 1))

    def test_入口で問いだったIDは差し戻し後も落ちたら問いに戻す(self):
        fail = [{"id": "RS-002", "kind": "insufficient_grounds", "reason": "組み直した flow からは言えない"}]
        r = run({"args": self._g0()["next_args"], "ruled_at": {"3a": ["RS-001"], "3b": ["RS-002"], "3b'": ["RS-002"]}, "questions_at": {"3a": ["RS-002"], "3b-convert": ["RS-002"]},
                 "verifier_fail": {"3bv": fail, "3bv'": fail}})
        self.assertIn("RS-002 → question（insufficient_grounds）", self._prompt(r, "resolver:3b-convert"))
        self.assertEqual((r["result"]["status"], r["result"]["question_ids"]), ("needs_answers", ["RS-002"]))

    def test_settleで生まれた組の問いも同じG0_2で聞く(self):
        spec = {"args": self._g0()["next_args"], "ruled_at": {"3a": ["RS-001"], "3b": ["RS-005"]}, "about": {"RS-005": {"open": "O-020"}},
                "open_ids_at": {"3b-reframe": ["O-020"]}, "open_only_at": {"3bv": [{"el": "F-030", "open": "O-020"}]},
                "pair_keys_at": {"3b-settle": ["pair:D-001|F-030"]}, "questions_at": {"3b-settle-pairs": ["RS-006"]}}
        r = run(spec)
        self.assertNotIn("question ではなく hold", self._prompt(r, "resolver:3b-settle-pairs"))
        self.assertEqual((r["result"]["status"], r["result"]["question_ids"]), ("needs_answers", ["RS-006"]))

    def test_settleの後に回答待ちの問いの形を検査し直す(self):
        # 段 3: RS-001 は合格して settle が走り、RS-002 は G0 で聞く問いとして残っている。
        spec = {"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"]}, "questions_at": {"3": ["RS-002"]},
                "open_only_at": {"3v": [{"el": "F-091", "open": "O-RS-001"}]}}
        r = run(spec)
        self.assertIn("--ids RS-002 --check", self._prompt(r, "flow-framer:3-settle"))
        self.assertNotIn("resolver:3-settle-questions", r["labels"])
        self.assertEqual(r["result"]["question_ids"], ["RS-002"])
        fixed = run({**spec, "bad_questions_at": ["3-settle"]})
        self.assertIn("--ids RS-002 --check", self._prompt(fixed, "resolver:3-settle-questions"))
        self.assertEqual(fixed["result"]["status"], "needs_answers")
        broken = run({**spec, "bad_questions_at": ["3-settle", "3-settle-questions"]})["result"]
        self.assertEqual((broken["status"], broken["next_args"]["from"]), ("blocked", "3"))

    def test_resolverの返り値はflow_checkを必ず持つ(self):
        r = run({"args": args(), "flow_open": 1, "ruled_at": {"3": ["RS-001"]}})
        self.assertIn("flow_check", r["resolverSchema"]["required"])

    def test_段3bの途中で止まっても段の頭から再開できる(self):
        g0 = self._g0()
        spec = {"ruled_at": {"3a": ["RS-001"]}, "questions_at": {"3a": ["RS-002"], "3b": ["RS-003"]}}
        whole = run({**spec, "args": g0["next_args"]})["result"]
        for stop in ("flow-framer:3b-reframe", "resolver:3b", "verifier:3bv"):
            with self.subTest(stop=stop):
                stopped = run({**spec, "args": g0["next_args"], "null_labels": [stop, f"{stop}#retry"]})["result"]
                self.assertEqual((stopped["status"], stopped["next_args"]["from"]), ("blocked", "3b"))
                again = run({**spec, "args": stopped["next_args"]})
                self.assertIsNone(again["error"], again["error"])
                self.assertEqual(again["labels"][0], "flow-framer:3b-reframe")
                # resolutions_sha256 は stub が run ごとに数え直す値なので比べない。
                drop = lambda st: {k: v for k, v in st.items() if k != "resolutions_sha256"}
                self.assertEqual(drop(again["result"]["next_args"]["state"]), drop(whole["next_args"]["state"]))


NEEDS_ANSWERS = re.compile(r"needsAnswers\('([^']+)'")
FUNCTION = re.compile(r"^(?:async )?function (\w+)")


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class Gates(unittest.TestCase):
    """needs_answers になる経路は G0（段 3）・G0-2（段 3b）・G1（段 6）の 3 つだけ。"""

    def test_needs_answersを返す呼び出しの場所を列挙する(self):
        src = PRD.read_text(encoding="utf-8")
        self.assertEqual(src.count("finish('needs_answers'"), 1)
        calls, fn = set(), None
        for line in src.splitlines():
            m = FUNCTION.match(line)
            fn = m.group(1) if m else fn
            calls |= {(fn, g) for g in NEEDS_ANSWERS.findall(line)}
        self.assertEqual(calls, {("stage3", "g0"), ("stage3b", "g0-2"), ("stage6", "g1")})


# NEXT_ARGS_MAX_CHARS: 司令塔が打ち直す next_args の上限（json.dumps(ensure_ascii=False) の字数）。根拠は 2026-09-27 の試走の
# G1 の next_args のうち flow 以外が 6,998 字だったこと。後の段が state を増やしても上げない（増えた分は ID・件数・digest に絞る）。
NEXT_ARGS_MAX_CHARS = 8_000


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class NextArgsBudget(unittest.TestCase):
    """前回の試走の G1 と同じ規模（問い 13・about 28・passed 82 以上・pending の findings 11・束 3・単位 1）で、
    stray 100 件と SIZE_OVER のある snapshot を通ってから、G0・G0-2・G1 の next_args が上限に収まる。"""

    DOC = "requirements/cleanup-branches"

    def _size(self, res):
        self.assertEqual(res["status"], "needs_answers", res.get("reason"))
        return len(json.dumps(res["next_args"], ensure_ascii=False))

    def test_各ゲートのnext_argsが上限に収まる(self):
        rs = lambda a, b: [f"RS-{i:03d}" for i in range(a, b + 1)]
        units = [{"id": "U-1", "docs": [self.DOC], "depends_on": []}]
        g0 = run({
            "args": args(), "units": units, "flow_open": 1, "long_digests": True,
            "ruled_at": {"3": rs(1, 12)}, "questions_at": {"3": rs(13, 21)},
            "verifier_extra_pass": {"3v": [f"D-{i:03d}" for i in range(1, 56)]},
        })["result"]
        g02 = run({"args": g0["next_args"], "units": units, "long_digests": True, "ruled_at": {"3a": rs(13, 21)}, "questions_at": {"3a": ["RS-022"]}})["result"]
        writer = lambda n, item: {"id": f"r1-im-requirements__cleanup-branches-{n:03d}", "doc": self.DOC, "item_id": item, "route": "writer"}
        decision = lambda n: {"id": f"r1-cd-all-{n:03d}", "doc": self.DOC, "item_id": "PR-CLEANUP-BRANCHES-009", "route": "decision"}
        items = ["PR-CLEANUP-BRANCHES-001"] * 3 + ["PR-CLEANUP-BRANCHES-002"] * 3 + ["PR-CLEANUP-BRANCHES-003"] * 2
        g1 = run({
            "args": g02["next_args"], "units": units, "long_digests": True, "ruled_at": {"3a": ["RS-022"], "6": rs(26, 28)},
            "stray_at": {"r1": 100}, "size_over_at": {"r1": 2},
            "doc_flow_refs": {self.DOC: {f"PR-CLEANUP-BRANCHES-{i:03d}": [f"F-{10 * i + j:03d}" for j in range(3)] for i in range(1, 10)}},
            "findings": {"implementer:r1": [writer(i + 1, it) for i, it in enumerate(items)], "crossDoc:r1": [decision(n) for n in (1, 2, 3)]},
            "questions_at": {"6": rs(23, 25)},
            "routes_at": {"6": [{"id": f"RT-{i:03d}", "unit": "U-1"} for i in range(1, 4)]},
        })["result"]

        state = g1["next_args"]["state"]
        self.assertEqual(len(state["questions"]), 13)
        self.assertEqual(len(state["about"]), 28)
        self.assertGreaterEqual(len(state["passed"]), 82)
        self.assertEqual(len(state["pending"]["findings"]), 11)
        self.assertEqual(len(state["pending"]["bundles"]), 3)
        self.assertTrue(all(len(b["flow"]) == 3 for b in state["pending"]["bundles"]))
        self.assertEqual(len(state["units"]), 1)
        self.assertTrue(any("100 件" in n for n in state["notices"]) and any("SIZE_BUDGET" in n for n in state["notices"]), state["notices"])
        for gate, res in (("G0", g0), ("G0-2", g02), ("G1", g1)):
            with self.subTest(gate=gate):
                self.assertLess(self._size(res), NEXT_ARGS_MAX_CHARS)


# 段ごとに、その段を通るシナリオと、その段で最初に起動する agent の label。
STAGE_CASES = {
    "1": ({}, "intake"),
    "2": ({}, "flow-framer"),
    "3": ({"flow_open": 1, "ruled_at": {"3": ["RS-001"]}}, "resolver:3"),
    "4": ({}, "writer:U-1:draft"),
    "5": ({}, "implementer:r1:requirements/x"),
    "6": ({"findings": {"crossDoc:r1": [{"id": "r1-cd-all-001", "route": "decision", "blocking": False}]}, "ruled_at": {"6": ["RS-010"]}}, "resolver:6"),
    "7": ({"findings": {"implementer:r1": [{"id": "r1-im-requirements__x-001", "blocking": False}]}}, "writer:U-1:revise"),
    "8": ({"findings": {"implementer:r1": [{"id": "r1-im-requirements__x-001", "blocking": False}]}}, "grounding:r2:requirements/x"),
}


@unittest.skipIf(shutil.which("node") is None, "node が無い環境ではスキップする")
class EveryEntry(unittest.TestCase):
    """各 from の入口で、要る値が next_args.state から得られることを実際に走らせて確かめる。

    その段の最初の agent を応答させずに blocked にし、返った next_args を変えずに渡すと done まで進むこと。
    REQUIRES は手で書いた表なので、値が抜けていると再開は blocked ではなく TypeError で落ちる。
    """

    def _recover(self, spec, label, stage):
        broken = run({**spec, "null_labels": [label, f"{label}#retry"]})
        self.assertIsNone(broken["error"], broken["error"])
        res = broken["result"]
        self.assertEqual(res["status"], "blocked", res)
        self.assertEqual(res["next_args"]["from"], stage)
        again = run({**{k: v for k, v in spec.items() if k != "args"}, "args": res["next_args"]})
        self.assertIsNone(again["error"], again["error"])
        self.assertEqual(again["labels"][0], label)
        return again["result"]

    def test_各段から再開できる(self):
        for stage, (extra, label) in STAGE_CASES.items():
            with self.subTest(stage=stage):
                self.assertEqual(self._recover({"args": args(), **extra}, label, stage)["status"], "done")

    def test_段9から再開すると誰も起動せずにdoneになる(self):
        r = run({"args": args(**{"from": "9", "state": {"units": [{"id": "U-1", "docs": ["requirements/x"], "depends_on": []}], "tree_digest": "t2"}})})
        self.assertIsNone(r["error"], r["error"])
        self.assertEqual(r["labels"], [])
        self.assertEqual((r["result"]["status"], r["result"]["report_path"], r["result"]["tree_digest"]), ("done", "/tmp/prd-w/report.md", "t2"))

    def test_回答の反映の段から再開できる(self):
        g0 = run({"args": args(), "flow_open": 1, "questions_at": {"3": ["RS-001"]}})["result"]
        done = self._recover({"args": g0["next_args"], "ruled_at": {"3a": ["RS-001"]}}, "resolver:3a", "3a")
        self.assertEqual(done["status"], "done")
        done = self._recover({"args": g0["next_args"], "ruled_at": {"3a": ["RS-001"]}}, "flow-framer:3b-reframe", "3b")
        self.assertEqual(done["status"], "done")
        spec = {"args": args(), "findings": {"crossDoc:r1": [{"id": "r1-cd-all-001", "route": "decision"}]}, "questions_at": {"6": ["RS-010"]}}
        g1 = run(spec)["result"]
        done = self._recover({"args": g1["next_args"], "ruled_at": {"3a'": ["RS-010"]}}, "resolver:3a'", "3a'")
        self.assertEqual(done["status"], "done")


if __name__ == "__main__":
    unittest.main()
