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
const FLOW = {
  elements: [
    { id: 'F-001', type: 'input', kind: 'k', label: 'in', next: ['F-002'], source: { input: 'x' } },
    { id: 'F-002', type: 'output', kind: 'k', label: 'out', source: { input: 'y' } },
  ],
  kinds: [{ name: 'k', definition: 'd' }],
  closure: 'c',
}
const BROKEN_FLOW = { elements: [{ id: 'F-001', type: 'step', kind: 'k', label: 'x', source: { input: 'x' } }], kinds: [{ name: 'k', definition: 'd' }], closure: 'c' }
const ids = (text, re) => [...new Set(String(text).match(re) || [])]
const about = (id) => ({ open: `O-${id}` })
function respond(prompt, label) {
  const base = label.replace(/#retry$/, '')
  const [role, stage, target] = base.split(':')
  if (role === 'intake') return { decisions: 3, open: 0, decisions_sha256: 'd', units: spec.units || [{ id: 'U-1', docs: ['requirements/x'], depends_on: [] }] }
  if (role === 'flow-framer') return { flow: spec.broken_flow ? BROKEN_FLOW : FLOW, open: spec.flow_open || 0, pairs: 0, flow_findings: 0, flow_digest: 'f', conflicts_digest: 'c' }
  if (role === 'resolver') {
    sha = `rs-${++shaN}`
    const q = ((spec.questions_at || {})[stage] || []).map((id) => ({ id, about: about(id) }))
    const ruled = ((spec.ruled_at || {})[stage] || []).map((id) => ({ id, about: about(id) }))
    const holds = ((spec.holds_at || {})[stage] || []).map((id) => ({ id, about: about(id) }))
    return { ruled, questions: q, holds, supersedes: [], free_text: (spec.free_text_at || {})[stage] || [], routes: (spec.routes_at || {})[stage] || [], sha256: sha }
  }
  if (role === 'verifier') {
    const asked = ids(prompt.split('検証する resolution の ID:')[1].split('\n')[0], /RS-\d+/g)
    const fail = (spec.verifier_fail || {})[stage] || []
    const failIds = fail.map((f) => f.id)
    return { pass: asked.filter((i) => !failIds.includes(i)), fail, sha256: sha, decisions_sha256: 'd' }
  }
  if (role === 'writer') {
    const revise = stage.endsWith('revise') || target === 'revise'
    const unit = stage
    const docs = (spec.units || [{ id: 'U-1', docs: ['requirements/x'] }]).find((u) => u.id === unit).docs
    return {
      unit,
      docs: docs.map((key) => ({ key, digest: `w-${key}`, doc_check_findings: 0, doc_check_blocking: 0 })),
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
      if (n === 1) out.designated = { doc_check: JSON.stringify({ blocking: 0 }), audited: JSON.stringify({ digest: 'a1' }) }
      else if ((spec.diff_error_at || []).includes(stage)) out.designated = { diff_error: 'doc_check diff: digest mismatch' }
      else {
        const changed = (spec.diff || {})[stage] || spec.writer_changed || ['PR-X-001']
        const firstDoc = (spec.units || [{ docs: ['requirements/x'] }])[0].docs[0]
        const byDoc = (spec.by_doc || {})[stage] || { [firstDoc]: { changed, added: [], removed: [] } }
        out.designated = {
          diff: { stdout: '{}', changed, added: [], removed: [], by_doc: byDoc },
          audited: JSON.stringify({ digest: `a${n}` }),
          doc_check: JSON.stringify({ blocking: 0 }),
          tree_digest: JSON.stringify({ digest: `t${n}` }),
        }
      }
    }
    return out
  }
  throw new Error(`unknown label ${label}`)
}
const findingFiles = []
const agent = async (prompt, opts) => {
  labels.push(opts.label)
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
console.log(JSON.stringify({ result, labels, logs, error, findingFiles }))
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
        self.assertEqual(labels[-1], "resolver:9")
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
        self.assertFalse(has(r2["labels"], "verifier:3av"), "候補の選択だけの回答は verifier に通さない")

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
            "flow": {
                "elements": [
                    {"id": "F-001", "type": "input", "kind": "k", "label": "i", "next": ["F-002"], "source": {"input": "x"}},
                    {"id": "F-002", "type": "output", "kind": "k", "label": "o", "source": {"input": "y"}},
                ],
                "kinds": [{"name": "k", "definition": "d"}],
                "closure": "c",
            },
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
    "9": ({}, "resolver:9"),
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
