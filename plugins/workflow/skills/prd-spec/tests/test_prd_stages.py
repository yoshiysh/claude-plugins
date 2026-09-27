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
import tempfile
import unittest
from pathlib import Path

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
const flowStdout = (findings, sha) => JSON.stringify({ findings, open: spec.flow_open || 0, path: 'checks/flow.json', digest: 'fd', content_sha256: sha })
const ids = (text, re) => [...new Set(String(text).match(re) || [])]
const about = (id) => ({ open: `O-${id}` })
function respond(prompt, label) {
  const base = label.replace(/#retry$/, '')
  const [role, stage, target] = base.split(':')
  if (role === 'intake') return { decisions: 3, open: 0, decisions_sha256: H('d'), units: spec.units || [{ id: 'U-1', docs: ['requirements/x'], depends_on: [] }] }
  if (role === 'flow-framer') {
    setFlow(H(`f-${stage || 'framer'}`))
    return { flow_check: flowStdout(spec.broken_flow ? 1 : 0, flowSha), conflicts_check: JSON.stringify({ pairs: 0, path: 'checks/conflicts.json', digest: 'c' }) }
  }
  if (role === 'resolver') {
    sha = H(`rs-${++shaN}`)
    const q = (at('questions_at', stage) || []).map((id) => ({ id, about: about(id) }))
    const ruled = (at('ruled_at', stage) || []).map((id) => ({ id, about: about(id) }))
    const holds = (at('holds_at', stage) || []).map((id) => ({ id, about: about(id) }))
    const out = { ruled, questions: q, holds, supersedes: [], free_text: at('free_text_at', stage) || [], routes: at('routes_at', stage) || [], sha256: sha }
    const checked = at('questions_check_ids_at', stage) || (stage.endsWith('-questions') ? ids((/--ids (\S+) --check/.exec(prompt) || [])[1], /RS-\d+/g) : q.map((x) => x.id))
    if (checked.length) {
      const bad = (spec.bad_questions_at || []).includes(stage) ? 1 : 0
      out.questions_check = JSON.stringify({ check: true, ids: checked, questions: checked.length - bad, findings: bad, bad_ids: bad ? [checked[0]] : [] })
    }
    const keepsFlow = /-(convert|hold|questions)$/.test(stage) || stage === 'final'
    const returnsFlow = ["3a", "3a'"].includes(stage) || stage.endsWith('-flow') || keepsFlow || at('flow_sha_at', stage) !== undefined
    if (returnsFlow && !(spec.no_flow_check_at || []).includes(stage)) {
      if (at('flow_sha_at', stage) !== undefined) setFlow(H(at('flow_sha_at', stage)))
      out.flow_check = flowStdout(at('flow_findings_at', stage) || 0, flowSha)
    }
    return out
  }
  if (role === 'verifier') {
    const asked = ids(prompt.split('検証する resolution の ID:')[1].split('\n')[0], /RS-\d+/g)
    const fail = at('verifier_fail', stage) || []
    const failIds = fail.map((f) => f.id)
    const seen = at('verifier_flow_sha_at', stage) !== undefined ? H(at('verifier_flow_sha_at', stage)) : flowSha
    return {
      pass: [...asked.filter((i) => !failIds.includes(i)), ...(at('verifier_extra_pass', stage) || [])],
      fail,
      resolutions_sha256: sha,
      decisions_sha256: H('d'),
      flow_check: flowStdout(at('verifier_flow_findings_at', stage) || 0, seen),
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
    const findings = (byKey[`${role}:${stage}:${target}`] || byKey[`${role}:${stage}`] || []).map((f) => ({ doc: 'requirements/x', item_id: 'PR-X-001', blocking: true, route: 'writer', ...f }))
    const out = { path: `findings/${stage}-${role}.json`, findings }
    if (prompt.includes('あなたは指名された監査役')) {
      // files は snapshot の stdout に無い一覧で、script が一覧を notices に写したら next_args の上限テストが落ちるように置く。
      const listed = (count, kind) => Array.from({ length: count }, (_, i) => `tmp/writer__U-1__draft/${kind}-${String(i).padStart(3, '0')}.pre${i}.json`)
      const found = {
        stray: { count: (spec.stray_at || {})[stage] || 0, path: `checks/audited-${n}.stray.json`, files: listed((spec.stray_at || {})[stage] || 0, 'stray') },
        size_over: { count: (spec.size_over_at || {})[stage] || 0, path: `checks/audited-${n}.sizes.json`, files: listed((spec.size_over_at || {})[stage] || 0, 'size') },
      }
      if (n === 1) out.designated = { doc_check: JSON.stringify({ blocking: 0 }), audited: JSON.stringify({ digest: H('a1'), ...found }) }
      else if ((spec.diff_error_at || []).includes(stage)) out.designated = { diff_error: 'doc_check diff: digest mismatch' }
      else {
        const changed = (spec.diff || {})[stage] || spec.writer_changed || ['PR-X-001']
        const firstDoc = (spec.units || [{ docs: ['requirements/x'] }])[0].docs[0]
        const byDoc = (spec.by_doc || {})[stage] || { [firstDoc]: { changed, added: [], removed: [] } }
        out.designated = {
          diff: { stdout: '{}', changed, added: [], removed: [], by_doc: byDoc },
          audited: JSON.stringify({ digest: H(`a${n}`), ...found }),
          doc_check: JSON.stringify({ blocking: 0 }),
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
const agent = async (prompt, opts) => {
  labels.push(opts.label)
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
console.log(JSON.stringify({ result, labels, logs, error, findingFiles, prompts }))
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
        self.assertEqual([l for l in r["labels"] if l.startswith(("resolver:", "verifier:"))], ["resolver:3a", "verifier:3av"])
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
        self.assertEqual(resumed["next_args"]["state"]["flow_digest"], "f-x")
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
            "verifier_extra_pass": {"3v": [f"D-{i:03d}" for i in range(1, 16)] + [f"F-{i:03d}" for i in range(1, 41)]},
        })["result"]
        g02 = run({"args": g0["next_args"], "units": units, "long_digests": True, "ruled_at": {"3a": rs(13, 21)}, "questions_at": {"3a": ["RS-022"]}})["result"]
        writer = lambda n, item: {"id": f"r1-im-requirements__cleanup-branches-{n:03d}", "doc": self.DOC, "item_id": item, "route": "writer"}
        decision = lambda n: {"id": f"r1-cd-all-{n:03d}", "doc": self.DOC, "item_id": "PR-CLEANUP-BRANCHES-009", "route": "decision"}
        items = ["PR-CLEANUP-BRANCHES-001"] * 3 + ["PR-CLEANUP-BRANCHES-002"] * 3 + ["PR-CLEANUP-BRANCHES-003"] * 2
        g1 = run({
            "args": g02["next_args"], "units": units, "long_digests": True, "ruled_at": {"3a": ["RS-022"], "6": rs(26, 28)},
            "stray_at": {"r1": 100}, "size_over_at": {"r1": 2},
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
        spec = {"args": args(), "findings": {"crossDoc:r1": [{"id": "r1-cd-all-001", "route": "decision"}]}, "questions_at": {"6": ["RS-010"]}}
        g1 = run(spec)["result"]
        done = self._recover({"args": g1["next_args"], "ruled_at": {"3a'": ["RS-010"]}}, "resolver:3a'", "3a'")
        self.assertEqual(done["status"], "done")


if __name__ == "__main__":
    unittest.main()
