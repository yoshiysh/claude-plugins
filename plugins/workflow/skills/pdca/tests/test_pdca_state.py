import contextlib
import hashlib
import importlib.util
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path

SKILL = Path(__file__).resolve().parents[1]
SCRIPT = SKILL / "scripts" / "pdca_state.py"
REQUEST = "PR の往復を減らしたい。\n変更は docs/ だけにしてほしい。\n"


def load_module():
    spec = importlib.util.spec_from_file_location("pdca_state", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class Run:
    def __init__(self, root: Path, rounds: int = 3, controlled: bool = False, env: dict | None = None):
        self.root = root
        self.dir = root / "run"
        self.env = env
        self.harness = root / "harness.py"
        self.harness.write_text("print(1)\n")
        self.material = root / "material.md"
        self.material.write_text("受入基準: 往復が 2 回以下\n")
        self.controlled = controlled
        self.rounds = rounds

    def cli(self, *args):
        proc = subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True, text=True, env=self.env)
        out = json.loads(proc.stdout) if proc.stdout.strip() else None
        err = json.loads(proc.stderr) if proc.stderr.strip() else None
        return proc.returncode, out, err

    def ok(self, *args):
        code, out, err = self.cli(*args, "--run-dir", str(self.dir))
        if code != 0:
            raise AssertionError(f"{args}: {err}")
        return out

    def refused(self, *args):
        code, out, err = self.cli(*args, "--run-dir", str(self.dir))
        if code != 1 or not isinstance(err, dict) or "error" not in err:
            raise AssertionError(f"{args}: exit {code}, {out}, {err}")
        return err["error"]

    def init(self, text: str = REQUEST):
        request = self.root / "request.txt"
        request.write_text(text)
        return self.ok("init", "--request-file", str(request), "--material", str(self.material))

    def scope(self, **over):
        return {"system": system(), "readings": [], "conditions": [condition()], "excluded": [],
                "human_gates": ["マージ"]} | over

    def design(self, **over):
        viewpoints = [{"id": "C1-V1", "condition": "C1", "check": "往復回数を数える", "means": {"kind": "audit"}}]
        if self.controlled:
            viewpoints.append({"id": "C1-V2", "condition": "C1", "check": "計測 script の値",
                               "means": {"kind": "script", "ref": str(self.harness), "pass_if": {"op": ">=", "value": 1}},
                               "controls": [{"input": "既知の PR", "expected": 1}]})
        return {"viewpoints": viewpoints, "budget": {"rounds": self.rounds, "wall_seconds": 7200}, "stops": []} | over

    def brief(self, role, *extra):
        out = self.ok("brief", "--role", role, *extra)
        return out, json.loads(Path(out["brief"]).read_text())

    def submit(self, brief, body):
        path = Path(brief["out"])
        path.write_text(json.dumps({"role": brief["role"], "brief_id": brief["brief_id"], "prompt_extra": "", **body}))
        return path

    def record(self, brief, body):
        return self.ok("record", "--file", str(self.submit(brief, body)))

    def write(self, aspect, doc):
        (self.dir / f"{aspect}.json").write_text(json.dumps(doc, ensure_ascii=False))

    def author(self, aspect="scope", agent=None, doc=None):
        _, brief = self.brief("criteria-author", "--aspect", aspect)
        self.write(aspect, doc or getattr(self, aspect)())
        return self.record(brief, {"agent": agent or f"author-{aspect}"})

    def review(self, aspect, agent=None, findings=()):
        _, brief = self.brief("criteria-verifier", "--aspect", aspect)
        return self.record(brief, {"agent": agent or f"rev-{aspect}", "aspect": aspect,
                                   "reviewed_sha256": sha(self.dir / f"{aspect}.json"), "findings": list(findings)})

    def scoped(self):
        self.init()
        self.author("scope")
        self.review("scope")

    def fixed(self, **design):
        self.scoped()
        self.author("design", doc=self.design(**design))
        self.review("design")
        return self.ok("fix")

    def work(self, agent="writer", conditions=("C1",)):
        _, brief = self.brief("writer", "--conditions", *conditions)
        return self.record(brief, {"agent": agent, "outputs": [str(self.root / "docs")]})

    def verify(self, viewpoint, agent, status="pass", observed=None, findings=()):
        _, brief = self.brief("verifier", "--viewpoint", viewpoint)
        return self.record(brief, {"agent": agent, "viewpoint": viewpoint, "status": status, "observed": observed,
                                   "evidence": "見た", "findings": list(findings)})

    def smoke(self, agent="smoke", observed=1):
        _, brief = self.brief("verifier", "--viewpoint", "C1-V2")
        return self.record(brief, {"agent": agent, "viewpoint": "C1-V2",
                                   "controls": [{"input": "既知の PR", "observed": observed}]})

    def verify_all(self, tag, statuses=None):
        statuses = statuses or {}
        ids = ["C1-V1"] + (["C1-V2"] if self.controlled else []) + ["R-REQUEST", "R-OUTSIDE"]
        for vid in ids:
            status = statuses.get(vid, "pass")
            observed = 1 if vid == "C1-V2" else None
            self.verify(vid, f"{tag}-{vid}", status=status, observed=observed)

    def judge(self, verdict="complete", open_items=None):
        report = self.root / "report.md"
        report.write_text("完了した")
        _, brief = self.brief("completion-judge", "--report-file", str(report))
        if open_items is None:
            open_items = [] if verdict == "complete" else ["R-OUTSIDE の報告が無い"]
        body = {"agent": "judge", "verdict": verdict, "open": open_items, "reason": "突き合わせた"}
        return brief, self.submit(brief, body)

    def next(self):
        return self.ok("status")["next"]

    def after(self, seconds: int):
        module = load_module()
        started = datetime.fromisoformat(json.loads((self.dir / "ledger.jsonl").read_text().splitlines()[0])["ts"])
        module.now = lambda: started + timedelta(seconds=seconds)
        return module

    def main_at(self, seconds: int, *args):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stderr(err), contextlib.redirect_stdout(out):
            code = self.after(seconds).main([*args, "--run-dir", str(self.dir)])
        return code, json.loads((out if code == 0 else err).getvalue())


def forge(run: Run, kind: str, data: dict, brief_id: str | None = None) -> None:
    path = run.dir / "ledger.jsonl"
    lines = path.read_text().splitlines()
    entry = {"seq": len(lines) + 1, "ts": "2000-01-01T00:00:00+00:00",
             "prev_sha256": hashlib.sha256(lines[-1].encode("utf-8")).hexdigest(), "kind": kind}
    if brief_id is not None:
        entry["brief_id"] = brief_id
    entry["data"] = data
    path.write_text(path.read_text() + json.dumps(entry, ensure_ascii=False) + "\n")


def rewrite(run: Run, kind: str, mutate) -> None:
    path = run.dir / "ledger.jsonl"
    entries = [json.loads(line) for line in path.read_text().splitlines()]
    mutate(next(e for e in entries if e["kind"] == kind)["data"])
    lines, prev = [], ""
    for e in entries:
        e["prev_sha256"] = prev
        lines.append(json.dumps(e, ensure_ascii=False))
        prev = hashlib.sha256(lines[-1].encode("utf-8")).hexdigest()
    path.write_text("\n".join(lines) + "\n")


def finding(layer="実装", severity="blocking", target="docs/a.md"):
    return {"target": target, "severity": severity, "layer": layer, "claim": "欠けている", "evidence": "L1"}


def kind(kid="K1", **over):
    return {"id": kid, "kind": "docs 配下の文書", "enumerate": {"cwd": str(SKILL), "command": "ls"}} | over


def system(*kinds):
    return {"flow": "依頼 → docs の編集 → PR", "closure": "PR が変えるのは docs 配下の文書だけ",
            "kinds": list(kinds) or [kind()]}


def condition(cid="C1", kinds=("K1",)):
    return {"id": cid, "statement": "往復が減る", "kinds": list(kinds),
            "source": {"path": "request.md", "quote": "PR の往復を減らしたい"}}


class Base(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def run_(self, **kw):
        return Run(self.root, **kw)


class TestBrokenPaths(Base):
    def test_blocking指摘の後にnextがcriteriaの直しを指す(self):
        r = self.run_()
        r.fixed()
        r.work()
        r.verify("C1-V1", "v1", status="fail", findings=[finding(layer="設計", target="design.json")])
        self.assertEqual(r.next(), "criteria-author:design")

    def test_briefは完了条件の文書のパスとdigestを渡し本文を埋め込まない(self):
        r = self.run_()
        r.fixed()
        _, brief = r.brief("writer", "--conditions", "C1")
        self.assertEqual(brief["documents"], {a: {"path": str((r.dir / f"{a}.json").resolve()),
                                                  "sha256": sha(r.dir / f"{a}.json")} for a in ("scope", "design")})
        text = json.dumps(brief, ensure_ascii=False)
        self.assertNotIn("PR の往復を減らしたい", text)
        self.assertNotIn("受入基準", text)
        self.assertEqual(brief["request"]["sha256"], sha(r.dir / "request.md"))

    def test_文書や指摘を書く役のbriefは文書の規則の正本を渡す(self):
        r = self.run_()
        r.init()
        _, author = r.brief("criteria-author", "--aspect", "scope")
        self.assertEqual(author["document_rules"], str(SKILL / "agents" / "writer.md"))
        r.author()
        _, reviewer = r.brief("criteria-verifier", "--aspect", "scope")
        self.assertEqual(reviewer["document_rules"], str(SKILL / "agents" / "writer.md"))
        r.review("scope", agent="s0")
        r.author("design")
        r.review("design")
        r.ok("fix")
        r.work()
        _, verifier = r.brief("verifier", "--viewpoint", "C1-V1")
        self.assertEqual(verifier["document_rules"], str(SKILL / "agents" / "writer.md"))

    def test_前周の指摘をbriefがledgerから載せる(self):
        r = self.run_()
        r.init()
        r.author()
        r.review("scope", findings=[finding(layer="範囲の導出", target="scope.json")])
        _, brief = r.brief("criteria-author", "--aspect", "scope")
        self.assertEqual([f["layer"] for f in brief["prior_findings"]], ["範囲の導出"])
        (self.root / "second").mkdir()
        r2 = Run(self.root / "second")
        r2.fixed()
        r2.work()
        r2.verify_all("r1", {"C1-V1": "fail"})
        r2.verify("C1-V1", "r1b-C1-V1", status="fail", findings=[finding()])
        _, writer = r2.brief("writer", "--conditions", "C1")
        self.assertEqual([f["claim"] for f in writer["prior_findings"]], ["欠けている"])

    def test_受け手の無い欄を持つ出力を拒否する(self):
        r = self.run_()
        r.fixed()
        _, brief = r.brief("writer", "--conditions", "C1")
        path = r.submit(brief, {"agent": "w", "outputs": ["x"], "needs_deliberation": True})
        self.assertIn("未知のキー", r.refused("record", "--file", str(path)))

    def test_pass_ifの観点はverifierの申告でなくobservedで決まる(self):
        r = self.run_(controlled=True)
        r.fixed()
        r.smoke()
        r.work()
        r.verify("C1-V2", "v", status="pass", observed=0)
        unmet = {u["viewpoint"]: u["status"] for u in r.ok("status")["unmet"]}
        self.assertEqual(unmet["C1-V2"], "fail")

    def test_not_doneの申告はobservedがpass_ifを満たしてもpassにならない(self):
        r = self.run_(controlled=True)
        r.fixed()
        r.smoke()
        r.work()
        r.verify("C1-V2", "v", status="not_done", observed=1)
        unmet = {u["viewpoint"]: u["status"] for u in r.ok("status")["unmet"]}
        self.assertEqual(unmet.get("C1-V2"), "not_done")

    def test_決定的な観点が1回passすればcloseできる(self):
        r = self.run_(controlled=True)
        r.fixed()
        r.smoke()
        r.work()
        r.verify_all("r1")
        self.assertEqual(r.next(), "completion-judge")
        r.ok("record", "--file", str(r.judge()[1]))
        self.assertEqual(r.ok("close")["human_gates"], ["マージ"])
        self.assertEqual(r.next(), "await_human")

    def test_criteriaを直して再fixでき前の検証は判定から外れる(self):
        r = self.run_()
        r.fixed()
        r.work()
        r.verify("C1-V1", "v", status="pass")
        r.verify("R-REQUEST", "q", status="fail", findings=[finding(layer="範囲の導出", target="scope.json")])
        self.assertIn("fix されていない", r.refused("brief", "--role", "writer", "--conditions", "C1"))
        r.author(agent="a2", doc=r.scope(excluded=[{"item": "CI", "reason": "依頼に無い"}]))
        r.review("scope", agent="s2")
        r.author("design", agent="a3")
        r.review("design", agent="d2")
        r.ok("fix")
        unmet = {u["viewpoint"]: u["status"] for u in r.ok("status")["unmet"]}
        self.assertEqual(unmet["C1-V1"], "not_done")
        self.assertEqual(r.next(), "writer")

    def test_run_dir以外で台帳を指定する引数が無い(self):
        parser = load_module().build_parser()
        sub = next(a for a in parser._actions if a.dest == "command")
        for name, p in sub.choices.items():
            opts = {o for a in p._actions for o in a.option_strings} - {"-h", "--help"}
            self.assertIn("--run-dir", opts, name)
            self.assertFalse([o for o in opts if "ledger" in o or o == "--path"], name)

    def test_roundsを使い切ったwriterのbriefを拒否する(self):
        r = self.run_(rounds=1)
        r.fixed()
        r.work()
        r.verify_all("r1", {"C1-V1": "fail"})
        self.assertEqual(r.next(), "stop:rounds")
        self.assertIn("停止中", r.refused("brief", "--role", "writer", "--conditions", "C1"))

    def test_roundsを使い切った後はcriteriaが再オープンされても直しに進まない(self):
        r = self.run_(rounds=1)
        r.fixed()
        r.work()
        r.verify("C1-V1", "v", status="fail", findings=[finding(layer="設計", target="design.json")])
        self.assertEqual(r.next(), "stop:rounds")
        self.assertIn("停止中", r.refused("brief", "--role", "criteria-author", "--aspect", "design"))
        self.assertIn("停止中", r.refused("brief", "--role", "writer", "--conditions", "C1"))
        status = r.ok("status")
        self.assertIsNone(status["unmet"])
        self.assertEqual(status["rounds"], {"used": 1, "budget": 1})
        self.assertEqual([f["layer"] for f in status["criteria_open"]], ["設計"])
        extra = self.root / "more.txt"
        extra.write_text("予算を増やして続けて\n")
        self.assertEqual(r.ok("amend", "--request-file", str(extra))["next"], "stop:rounds")

    def test_wall_secondsを過ぎたらcriteriaが再オープンされても直しに進まない(self):
        r = self.run_()
        r.fixed(budget={"rounds": 3, "wall_seconds": 3600})
        r.work()
        r.verify("C1-V1", "v", status="fail", findings=[finding(layer="設計", target="design.json")])
        self.assertEqual(r.next(), "criteria-author:design")
        self.assertEqual(r.after(3601).State(r.dir).next(), "stop:time_budget")
        code, err = r.main_at(3601, "brief", "--role", "criteria-author", "--aspect", "design")
        self.assertEqual(code, 1)
        self.assertIn("停止中", err["error"])
        code, status = r.main_at(3601, "status")
        self.assertEqual((code, status["next"], status["unmet"]), (0, "stop:time_budget", None))
        self.assertEqual(status["elapsed"], "elapsed 3601s / 3600s")
        self.assertEqual([f["claim"] for f in status["criteria_open"]], ["欠けている"])

    def test_wall_secondsを過ぎたら発行済みのレビューが揃っていてもfixしない(self):
        r = self.run_()
        r.fixed(budget={"rounds": 3, "wall_seconds": 3600})
        r.work()
        r.verify("C1-V1", "v", status="fail", findings=[finding(layer="設計", target="design.json")])
        r.author("design", agent="a2", doc=r.design(budget={"rounds": 3, "wall_seconds": 99999}))
        r.review("design", agent="d2")
        self.assertEqual(r.next(), "fix")
        code, err = r.main_at(3601, "fix")
        self.assertEqual(code, 1)
        self.assertIn("stop:time_budget", err["error"])
        self.assertEqual(r.after(3601).State(r.dir).next(), "stop:time_budget")

    def test_scriptが付けるキーを含む出力を拒否する(self):
        r = self.run_()
        r.fixed()
        _, brief = r.brief("writer", "--conditions", "C1")
        path = r.submit(brief, {"agent": "w", "outputs": ["x"], "seq": 99})
        self.assertIn("script が付けるキー", r.refused("record", "--file", str(path)))

    def test_layerの件数が2周続けて減らなければ非収束(self):
        r = self.run_(rounds=5)
        r.fixed()
        for n in range(3):
            r.work(agent=f"w{n}")
            r.verify_all(f"r{n}", {"C1-V1": "fail"})
            r.verify("C1-V1", f"r{n}-C1-V1", status="fail", findings=[finding()])
        self.assertEqual(r.next(), "stop:non_converging:実装")

    def test_2周続けて退行すれば非収束(self):
        r = self.run_(rounds=5)
        r.fixed()
        pattern = [{"R-OUTSIDE": "fail"}, {"R-REQUEST": "fail"}, {"R-OUTSIDE": "fail"}]
        for n, statuses in enumerate(pattern):
            r.work(agent=f"w{n}")
            r.verify_all(f"r{n}", statuses)
        self.assertEqual(r.next(), "stop:non_converging:退行")


class TestDocuments(Base):
    def test_測定の文書だけを直したとき範囲の再レビューを求めない(self):
        r = self.run_()
        r.scoped()
        r.author("design")
        r.review("design", findings=[finding(layer="設計", target="design.json")])
        self.assertEqual(r.next(), "criteria-author:design")
        r.author("design", agent="a2", doc=r.design(stops=["往復が増えたら止める"]))
        self.assertEqual(r.next(), "criteria-verifier:design")
        r.review("design", agent="d2")
        r.ok("fix")
        reviews = [json.loads(line)["data"]["aspect"] for line in (r.dir / "ledger.jsonl").read_text().splitlines()
                   if json.loads(line)["kind"] == "criteria_review"]
        self.assertEqual(reviews, ["scope", "design", "design"])

    def test_範囲を直したら測定の文書を開き直す(self):
        r = self.run_()
        r.fixed()
        r.work()
        r.verify("R-REQUEST", "q", status="fail", findings=[finding(layer="範囲の導出", target="scope.json")])
        self.assertEqual(r.next(), "criteria-author:scope")
        r.author(agent="a2", doc=r.scope(excluded=[{"item": "CI", "reason": "依頼に無い"}]))
        self.assertEqual(r.next(), "criteria-verifier:scope")
        r.review("scope", agent="s2")
        self.assertEqual(r.next(), "criteria-author:design")
        self.assertIn("design.json", r.refused("brief", "--role", "criteria-verifier", "--aspect", "design"))
        r.author("design", agent="a3")
        self.assertEqual(r.next(), "criteria-verifier:design")
        r.review("design", agent="d2")
        r.ok("fix")

    def test_測定の文書は範囲がscopeの反証を通るまで書けない(self):
        r = self.run_()
        r.init()
        self.assertIn("範囲", r.refused("brief", "--role", "criteria-author", "--aspect", "design"))
        r.author()
        self.assertIn("範囲", r.refused("brief", "--role", "criteria-author", "--aspect", "design"))
        r.review("scope", findings=[finding(layer="範囲の導出", target="scope.json")])
        self.assertIn("範囲", r.refused("brief", "--role", "criteria-author", "--aspect", "design"))
        self.assertEqual(r.next(), "criteria-author:scope")

    def test_範囲の書き手と検証者のbriefは測定の文書を渡さない(self):
        r = self.run_()
        r.init()
        _, author = r.brief("criteria-author", "--aspect", "scope")
        r.write("scope", r.scope())
        r.record(author, {"agent": "a"})
        _, reviewer = r.brief("criteria-verifier", "--aspect", "scope")
        for brief in (author, reviewer):
            self.assertEqual(list(brief["documents"]), ["scope"])
            self.assertNotIn("design.json", json.dumps(brief, ensure_ascii=False))
            self.assertNotIn("viewpoints", json.dumps(brief, ensure_ascii=False))
        r.record(reviewer, {"agent": "s", "aspect": "scope", "reviewed_sha256": sha(r.dir / "scope.json"),
                            "findings": []})
        _, design_author = r.brief("criteria-author", "--aspect", "design")
        self.assertEqual(list(design_author["documents"]), ["scope", "design"])
        self.assertIn("viewpoints", design_author["shape"])

    def test_測定の文書は範囲の全条件を観点で覆い範囲に無い条件を指さない(self):
        r = self.run_()
        r.init()
        two = r.scope()
        two["conditions"].append({"id": "C2", "statement": "docs だけ変える",
                                  "source": {"path": "request.md", "quote": "変更は docs/ だけにしてほしい。"}})
        r.author(doc=two)
        r.review("scope")
        _, brief = r.brief("criteria-author", "--aspect", "design")
        r.write("design", r.design())
        self.assertIn("C2", r.refused("record", "--file", str(r.submit(brief, {"agent": "a"}))))
        stray = r.design()
        stray["viewpoints"].append({"id": "C9-V1", "condition": "C9", "check": "x", "means": {"kind": "audit"}})
        r.write("design", stray)
        self.assertIn("C9", r.refused("record", "--file", str(r.submit(brief, {"agent": "a"}))))

    def test_範囲のレビューは範囲の導出の指摘だけを出せる(self):
        r = self.run_()
        r.init()
        r.author()
        _, brief = r.brief("criteria-verifier", "--aspect", "scope")
        path = r.submit(brief, {"agent": "s", "aspect": "scope", "reviewed_sha256": sha(r.dir / "scope.json"),
                                "findings": [finding(layer="設計", target="design.json")]})
        self.assertIn("layer", r.refused("record", "--file", str(path)))

    def test_測定の検証者の範囲の導出の指摘は範囲の書き手に回る(self):
        r = self.run_()
        r.scoped()
        r.author("design")
        r.review("design", findings=[finding(layer="範囲の導出", target="scope.json"),
                                     finding(layer="設計", target="design.json")])
        self.assertEqual(r.next(), "criteria-author:scope")
        _, brief = r.brief("criteria-author", "--aspect", "scope")
        self.assertEqual([f["layer"] for f in brief["prior_findings"]], ["範囲の導出"])

    def test_測定の設計の指摘が2版続けて減らなければ範囲の書き手に回る(self):
        r = self.run_()
        r.scoped()
        stuck = finding(layer="設計", target="design.json")
        r.author("design")
        r.review("design", findings=[stuck])
        self.assertEqual(r.next(), "criteria-author:design")
        r.author("design", agent="a2")
        r.review("design", agent="d2", findings=[stuck])
        self.assertEqual(r.next(), "criteria-author:scope")
        _, brief = r.brief("criteria-author", "--aspect", "scope")
        self.assertEqual([f["layer"] for f in brief["prior_findings"]], ["設計"])
        r.write("scope", r.scope())
        r.record(brief, {"agent": "a3"})
        self.assertEqual(r.next(), "criteria-verifier:scope")
        r.review("scope", agent="s2")
        self.assertEqual(r.next(), "criteria-author:design")
        r.author("design", agent="a4")
        r.review("design", agent="d3", findings=[stuck])
        self.assertEqual(r.next(), "stop:non_converging:設計")

    def test_範囲と測定を交互に書いても測定の文書の非収束を検出する(self):
        r = self.run_()
        r.scoped()
        both = [finding(layer="範囲の導出", target="scope.json"), finding(layer="設計", target="design.json")]
        for n in range(3):
            r.author("design", agent=f"ad{n}")
            r.review("design", agent=f"d{n}", findings=both)
            if n < 2:
                r.author(agent=f"as{n}")
                r.review("scope", agent=f"s{n}")
        self.assertTrue(r.next().startswith("stop:non_converging"), r.next())

    def test_recordとstatusは文書と観点ごとのcheckの文字数を返す(self):
        r = self.run_()
        r.init()
        _, brief = r.brief("criteria-author", "--aspect", "scope")
        r.write("scope", r.scope())
        scope_chars = len((r.dir / "scope.json").read_text())
        self.assertEqual(r.record(brief, {"agent": "a"})["sizes"], {"scope.json": scope_chars})
        r.review("scope")
        out = r.author("design")
        design_chars = len((r.dir / "design.json").read_text())
        expected = {"scope.json": scope_chars, "design.json": design_chars, "check": {"C1-V1": len("往復回数を数える")}}
        self.assertEqual(out["sizes"], expected)
        self.assertEqual(r.ok("status")["sizes"], expected)
        r.write("design", r.design(stops=["未記録の書き換え"]))
        sizes = r.ok("status")["sizes"]
        self.assertNotIn("check", sizes)
        self.assertEqual(sizes["design.json"], len((r.dir / "design.json").read_text()))


class TestSystem(Base):
    def submit_scope(self, r, doc):
        _, brief = r.brief("criteria-author", "--aspect", "scope")
        r.write("scope", doc)
        return brief, r.submit(brief, {"agent": "a"})

    def test_範囲の文書は系の種類の一覧が無ければ拒否する(self):
        r = self.run_()
        r.init()
        doc = r.scope()
        doc.pop("system", None)
        brief, path = self.submit_scope(r, doc)
        self.assertIn("system", brief["shape"])
        self.assertIn("system", r.refused("record", "--file", str(path)))

    def test_条件にも除外にも対応しない種類を拒否する(self):
        r = self.run_()
        r.init()
        doc = r.scope(system=system(kind(), kind("K2", kind="設定")), conditions=[condition()])
        brief, path = self.submit_scope(r, doc)
        self.assertIn("K2", r.refused("record", "--file", str(path)))
        doc["excluded"] = [{"item": "設定", "kinds": ["K2"], "reason": "依頼に無い"}]
        r.write("scope", doc)
        r.ok("record", "--file", str(path))

    def test_種類の一覧に無い種類を指す条件と除外を拒否する(self):
        r = self.run_()
        r.init()
        brief, path = self.submit_scope(r, r.scope(system=system(), conditions=[condition(kinds=("K1", "K9"))]))
        self.assertIn("K9", r.refused("record", "--file", str(path)))
        r.write("scope", r.scope(system=system(), conditions=[condition()],
                                 excluded=[{"item": "x", "kinds": ["K8"], "reason": "依頼に無い"}]))
        self.assertIn("K8", r.refused("record", "--file", str(path)))

    def test_列挙は実在する絶対パスのcwdとコマンドに分けなければ拒否する(self):
        r = self.run_()
        r.init()
        cases = {"相対": {"cwd": "docs", "command": "ls"},
                 "不在": {"cwd": str(self.root / "missing"), "command": "ls"},
                 "文字列": "ls docs"}
        for name, enumerate_ in cases.items():
            with self.subTest(name):
                brief, path = self.submit_scope(r, r.scope(system=system(kind(enumerate=enumerate_))))
                self.assertIn("enumerate", r.refused("record", "--file", str(path)))
        r.write("scope", r.scope(system=system(kind(enumerate={"cwd": str(self.root), "command": "ls"}))))
        r.ok("record", "--file", str(path))

    def test_割れる句と価値判断の種類は範囲の反証の前にまとめてask_humanで聞く(self):
        r = self.run_()
        r.init()
        asked = kind("K2", kind="設定", ask="設定も範囲に入れるか")
        reading = {"id": "Q1", "quote": "PR の往復を減らしたい", "ask": "往復は PR ごとか全体か"}
        r.author(doc=r.scope(system=system(kind(), asked), conditions=[condition()], readings=[reading]))
        status = r.ok("status")
        self.assertEqual(status["next"], "ask_human")
        self.assertEqual(status["ask_human"], [{"id": "K2", "ask": "設定も範囲に入れるか"},
                                               {"id": "Q1", "ask": "往復は PR ごとか全体か"}])
        for args in (("brief", "--role", "criteria-verifier", "--aspect", "scope"),
                     ("brief", "--role", "criteria-author", "--aspect", "scope"), ("fix",), ("continue",)):
            self.assertIn("ask_human", r.refused(*args))
        answer = self.root / "answer.txt"
        answer.write_text("設定は入れない。往復は PR ごと\n")
        self.assertIn("K9", r.refused("amend", "--request-file", str(answer), "--answers", "K9"))
        self.assertEqual(r.ok("amend", "--request-file", str(answer), "--answers", "K2", "Q1")["next"],
                         "criteria-author:scope")
        brief, path = self.submit_scope(r, r.scope(system=system(kind(), kind("K2", kind="設定")),
                                                   conditions=[condition()], readings=[reading],
                                                   excluded=[{"item": "設定", "kinds": ["K2"], "reason": "答え"}]))
        self.assertIn("Q1", r.refused("record", "--file", str(path)))
        r.author(agent="a2", doc=r.scope(system=system(kind(), kind("K2", kind="設定")), conditions=[condition()],
                                         excluded=[{"item": "設定", "kinds": ["K2"], "reason": "人間が入れないと答えた"}]))
        self.assertEqual(r.next(), "criteria-verifier:scope")
        r.review("scope", agent="s2")
        self.assertEqual(r.next(), "criteria-author:design")

    def test_割れる句も価値判断の種類も無ければ聞かずに範囲の反証へ進む(self):
        r = self.run_()
        r.init()
        r.author()
        status = r.ok("status")
        self.assertEqual(status["next"], "criteria-verifier:scope")
        self.assertNotIn("ask_human", status)

    def test_割れる句の引用が依頼に逐語で無ければ拒否する(self):
        r = self.run_()
        r.init()
        reading = {"id": "Q1", "quote": "依頼に無い句", "ask": "x"}
        brief, path = self.submit_scope(r, r.scope(readings=[reading]))
        self.assertIn("readings[0].quote", r.refused("record", "--file", str(path)))

    def test_ask_humanの間の答えでないamendでは問いを残せて再び聞く(self):
        r = self.run_()
        r.init()
        asked = kind("K2", kind="設定", ask="設定も範囲に入れるか")
        r.author(doc=r.scope(system=system(kind(), asked), conditions=[condition()]))
        extra = self.root / "more.txt"
        extra.write_text("README も直して\n")
        r.ok("amend", "--request-file", str(extra))
        r.author(agent="a2", doc=r.scope(system=system(kind(), asked), conditions=[condition()]))
        self.assertEqual(r.ok("status")["ask_human"], [{"id": "K2", "ask": "設定も範囲に入れるか"}])

    def test_answersはask_humanで待っている種類だけを取る(self):
        r = self.run_()
        r.init()
        answer = self.root / "answer.txt"
        answer.write_text("設定は入れない\n")
        self.assertIn("ask_human", r.refused("amend", "--request-file", str(answer), "--answers", "K2"))

    def test_読み方の問いを持つ範囲の指摘はcriteria_openに出て答えのamendは書き手に回る(self):
        r = self.run_()
        r.init()
        r.author()
        question = finding(layer="範囲の導出", target="scope.json") | {"ask": "2 行目は起動の指示か"}
        _, brief = r.brief("criteria-verifier", "--aspect", "scope")
        path = r.submit(brief, {"agent": "s", "aspect": "scope", "reviewed_sha256": sha(r.dir / "scope.json"),
                                "findings": [question | {"severity": "non_blocking"}]})
        self.assertIn("ask", r.refused("record", "--file", str(path)))
        r.review("scope", findings=[question])
        status = r.ok("status")
        self.assertEqual(status["next"], "criteria-author:scope")
        self.assertEqual([f.get("ask") for f in status["criteria_open"]], ["2 行目は起動の指示か"])
        answer = self.root / "answer.txt"
        answer.write_text("起動の指示ではない\n")
        self.assertEqual(r.ok("amend", "--request-file", str(answer))["next"], "criteria-author:scope")
        r.author(agent="a2")
        r.review("scope", agent="s2")
        self.assertEqual(r.next(), "criteria-author:design")

    def test_fixの後に人間に聞く種類を足しても台帳を読める(self):
        r = self.run_()
        r.fixed()
        r.work()
        r.verify("R-REQUEST", "q", status="fail", findings=[finding(layer="範囲の導出", target="scope.json")])
        asked = kind("K2", kind="設定", ask="設定も範囲に入れるか")
        r.author(agent="a2", doc=r.scope(system=system(kind(), asked), conditions=[condition()]))
        self.assertEqual(r.ok("status")["next"], "ask_human")

    def test_ask_humanの間に止まってもstatusは保留中の問いを出す(self):
        r = self.run_()
        r.fixed()
        r.work()
        r.verify("R-REQUEST", "q", status="fail", findings=[finding(layer="範囲の導出", target="scope.json")])
        asked = kind("K2", kind="設定", ask="設定も範囲に入れるか")
        r.author(agent="a2", doc=r.scope(system=system(kind(), asked), conditions=[condition()]))
        code, status = r.main_at(99999, "status")
        self.assertEqual((code, status["next"]), (0, "stop:time_budget"))
        self.assertEqual(status["ask_human"], [{"id": "K2", "ask": "設定も範囲に入れるか"}])


class TestRequest(Base):
    def test_initの前のbriefを拒否する(self):
        r = self.run_()
        r.dir.mkdir()
        self.assertIn("init の前", r.refused("brief", "--role", "criteria-author", "--aspect", "scope"))

    def test_request_mdが改変されたらbriefを拒否する(self):
        r = self.run_()
        r.init()
        (r.dir / "request.md").write_text("言い換えた依頼\n")
        self.assertIn("request.md", r.refused("brief", "--role", "criteria-author", "--aspect", "scope"))

    def test_amendの後は範囲の書き手に回り再レビューを経るまでwriterを呼べない(self):
        r = self.run_()
        r.fixed()
        extra = self.root / "more.txt"
        extra.write_text("README も直して\n")
        out = r.ok("amend", "--request-file", str(extra))
        self.assertEqual(out["recorded_request"], "README も直して\n")
        self.assertEqual(out["next"], "criteria-author:scope")
        self.assertIn("fix されていない", r.refused("brief", "--role", "writer", "--conditions", "C1"))
        self.assertIn("scope.json", r.refused("brief", "--role", "criteria-verifier", "--aspect", "scope"))
        self.assertIn("scope.json", r.refused("fix"))
        r.author(agent="a2")
        r.review("scope", agent="s2")
        r.author("design", agent="a3")
        r.review("design", agent="d2")
        r.ok("fix")
        r.brief("writer", "--conditions", "C1")

    def test_amendの後も前周の指摘が範囲の書き手のbriefに渡る(self):
        r = self.run_()
        r.init()
        r.author()
        r.review("scope", findings=[finding(layer="範囲の導出", target="scope.json"),
                                    finding(layer="範囲の導出", target="scope.json", severity="non_blocking")])
        extra = self.root / "more.txt"
        extra.write_text("README も直して\n")
        r.ok("amend", "--request-file", str(extra))
        _, brief = r.brief("criteria-author", "--aspect", "scope")
        self.assertEqual([f["severity"] for f in brief["prior_findings"]], ["blocking", "non_blocking"])

    def test_fixの前のamendも範囲の書き手に回る(self):
        r = self.run_()
        r.scoped()
        extra = self.root / "more.txt"
        extra.write_text("README も直して\n")
        self.assertEqual(r.ok("amend", "--request-file", str(extra))["next"], "criteria-author:scope")
        self.assertIn("範囲", r.refused("brief", "--role", "criteria-author", "--aspect", "design"))

    def test_initは依頼原文を写して返し資料は複製しない(self):
        r = self.run_()
        out = r.init()
        self.assertEqual(out["recorded_request"], REQUEST)
        self.assertEqual((r.dir / "request.md").read_text(), REQUEST)
        self.assertEqual(out["materials"][0]["sha256"], sha(r.material))
        self.assertEqual(sorted(p.name for p in r.dir.iterdir()), ["ledger.jsonl", "request.md"])

    def test_initの拒否条件(self):
        r = self.run_()
        empty = self.root / "empty.txt"
        empty.write_text("  \n")
        self.assertIn("空", r.refused("init", "--request-file", str(empty)))
        request = self.root / "req.txt"
        request.write_text(REQUEST)
        self.assertIn("存在しない", r.refused("init", "--request-file", str(request), "--material", str(self.root / "none")))
        r.dir.mkdir()
        inner = r.dir / "m.md"
        inner.write_text("x")
        self.assertIn("run-dir の中", r.refused("init", "--request-file", str(request), "--material", str(inner)))
        r.init()
        self.assertIn("初期化済み", r.refused("init", "--request-file", str(request)))


class TestInputShape(Base):
    def test_引数はパスと閉集合とIDだけ(self):
        parser = load_module().build_parser()
        sub = next(a for a in parser._actions if a.dest == "command")
        options = {name: {o for a in p._actions for o in a.option_strings} - {"-h", "--help"}
                   for name, p in sub.choices.items()}
        self.assertEqual(options, {
            "init": {"--run-dir", "--request-file", "--material"},
            "amend": {"--run-dir", "--request-file", "--answers"},
            "brief": {"--run-dir", "--role", "--conditions", "--viewpoint", "--aspect", "--report-file"},
            "record": {"--run-dir", "--file"},
            "fix": {"--run-dir"}, "status": {"--run-dir"}, "continue": {"--run-dir"}, "close": {"--run-dir"},
        })

    def test_prompt_extraが空でない出力を拒否する(self):
        r = self.run_()
        r.init()
        _, brief = r.brief("criteria-author", "--aspect", "scope")
        r.write("scope", r.scope())
        path = Path(brief["out"])
        path.write_text(json.dumps({"role": "criteria-author", "brief_id": brief["brief_id"], "agent": "a",
                                    "prompt_extra": "仮説: キャッシュが原因"}))
        self.assertIn("prompt_extra", r.refused("record", "--file", str(path)))

    def test_invokeはテンプレートの文だけ(self):
        r = self.run_()
        r.init()
        out, brief = r.brief("criteria-author", "--aspect", "scope")
        module = load_module()
        self.assertEqual(out["invoke"], module.INVOKE.format(brief=out["brief"], agent=brief["agent_file"], out=brief["out"]))

    def test_writerの未知の条件IDを拒否する(self):
        r = self.run_()
        r.fixed()
        self.assertIn("C9", r.refused("brief", "--role", "writer", "--conditions", "C9"))


class TestOrder(Base):
    def test_fixの前にwriterのbriefを出さない(self):
        r = self.run_()
        r.scoped()
        r.author("design")
        self.assertIn("fix されていない", r.refused("brief", "--role", "writer", "--conditions", "C1"))
        self.assertIn("fix されていない", r.refused("brief", "--role", "verifier", "--viewpoint", "C1-V1"))

    def test_layerかtargetの無い指摘を拒否する(self):
        r = self.run_()
        r.init()
        r.author()
        _, brief = r.brief("criteria-verifier", "--aspect", "scope")
        bad = finding()
        del bad["layer"]
        path = r.submit(brief, {"agent": "s", "aspect": "scope", "reviewed_sha256": sha(r.dir / "scope.json"),
                                "findings": [bad]})
        self.assertIn("layer か target", r.refused("record", "--file", str(path)))

    def test_scopeとdesignの片方だけではfixできない(self):
        r = self.run_()
        r.scoped()
        self.assertIn("design", r.refused("fix"))
        r.author("design")
        self.assertIn("design", r.refused("fix"))

    def test_fix後の再レビュー無しのcriteria_authorを拒否する(self):
        r = self.run_()
        r.fixed()
        self.assertIn("fix 済み", r.refused("brief", "--role", "criteria-author", "--aspect", "scope"))

    def test_fixは2人のレビュアーが同じか書き手と同じagentなら拒否する(self):
        r = self.run_()
        r.init()
        r.author()
        r.review("scope", agent="same")
        r.author("design")
        r.review("design", agent="same")
        self.assertIn("同じ agent", r.refused("fix"))
        (self.root / "second").mkdir()
        r2 = Run(self.root / "second")
        r2.scoped()
        r2.author("design")
        r2.review("design", agent="author-scope")
        self.assertIn("同じ agent", r2.refused("fix"))


class TestViewpoints(Base):
    def test_verifierのbriefは観点を1つだけ取る(self):
        r = self.run_()
        r.fixed()
        r.work()
        self.assertIn("1 つだけ", r.refused("brief", "--role", "verifier", "--viewpoint", "C1-V1", "--viewpoint", "R-REQUEST"))
        self.assertIn("1 つだけ", r.refused("brief", "--role", "verifier"))

    def test_同じ周で1つのagentが2つの観点を記録できない(self):
        r = self.run_()
        r.fixed()
        r.work()
        r.verify("C1-V1", "v")
        _, brief = r.brief("verifier", "--viewpoint", "R-REQUEST")
        path = r.submit(brief, {"agent": "v", "viewpoint": "R-REQUEST", "status": "pass", "observed": None,
                                "evidence": "x", "findings": []})
        self.assertIn("別の観点", r.refused("record", "--file", str(path)))

    def test_報告の無い観点はnot_doneでcloseできない(self):
        r = self.run_()
        r.fixed()
        r.work()
        r.verify("C1-V1", "v1")
        r.verify("R-REQUEST", "v2")
        unmet = {u["viewpoint"]: u["status"] for u in r.ok("status")["unmet"]}
        self.assertEqual(unmet, {"R-OUTSIDE": "not_done"})
        self.assertIn("R-OUTSIDE", r.refused("close"))

    def test_R_REQUESTとR_OUTSIDEは毎回の必須観点(self):
        r = self.run_()
        r.fixed()
        unmet = {u["viewpoint"] for u in r.ok("status")["unmet"]}
        self.assertEqual(unmet, {"C1-V1", "R-REQUEST", "R-OUTSIDE"})

    def test_観点にR_で始まるIDを書けない(self):
        r = self.run_()
        r.scoped()
        bad = r.design()
        bad["viewpoints"][0]["id"] = "R-REQUEST"
        _, brief = r.brief("criteria-author", "--aspect", "design")
        r.write("design", bad)
        path = r.submit(brief, {"agent": "a"})
        self.assertIn("R-", r.refused("record", "--file", str(path)))


class TestScoringMaterial(Base):
    def test_controlsを持つ観点はmeans_refが無ければ拒否する(self):
        for kind in ("script", "audit"):
            with self.subTest(kind=kind):
                (self.root / kind).mkdir()
                r = Run(self.root / kind, controlled=True)
                r.scoped()
                bad = r.design()
                means = bad["viewpoints"][1]["means"]
                means["kind"] = kind
                del means["ref"]
                _, brief = r.brief("criteria-author", "--aspect", "design")
                r.write("design", bad)
                self.assertIn("means.ref", r.refused("record", "--file", str(r.submit(brief, {"agent": "a"}))))

    def test_fix後の完了条件の文書の書き換えを検出する(self):
        for aspect, change in (("design", {"stops": ["x"]}), ("scope", {"human_gates": []})):
            with self.subTest(aspect=aspect):
                (self.root / aspect).mkdir()
                r = Run(self.root / aspect)
                r.fixed()
                r.write(aspect, getattr(r, aspect)(**change))
                self.assertIn(f"{aspect}.json の digest", r.refused("status"))
                self.assertIn("digest", r.refused("brief", "--role", "writer", "--conditions", "C1"))

    def test_fix後のmeans_refの書き換えを検出する(self):
        r = self.run_(controlled=True)
        r.fixed()
        r.harness.write_text("print(2)\n")
        _, brief = r.brief("verifier", "--viewpoint", "C1-V2")
        path = r.submit(brief, {"agent": "s", "viewpoint": "C1-V2", "controls": [{"input": "既知の PR", "observed": 1}]})
        self.assertIn("means.ref", r.refused("record", "--file", str(path)))

    def test_fixは採点物を複製しない(self):
        r = self.run_(controlled=True)
        out = r.fixed()
        self.assertEqual(out["means"], [{"viewpoint": "C1-V2", "ref": str(r.harness), "sha256": sha(r.harness)}])
        copies = [p for p in r.dir.rglob("*") if p.is_file() and p.read_bytes() == r.harness.read_bytes()]
        self.assertEqual(copies, [])

    def test_fix後の対照の入力の書き換えを検出する(self):
        r = self.run_(controlled=True)
        fixture = self.root / "fixture"
        fixture.mkdir()
        (fixture / "pr.json").write_text("{}\n")
        design = r.design()
        design["viewpoints"][1]["controls"][0]["ref"] = str(fixture)
        out = r.fixed(viewpoints=design["viewpoints"])
        self.assertIn({"viewpoint": "C1-V2", "ref": str(fixture), "sha256": load_module().digest(fixture)}, out["means"])
        (fixture / "pr.json").write_text('{"forged": true}\n')
        _, brief = r.brief("verifier", "--viewpoint", "C1-V2")
        path = r.submit(brief, {"agent": "s", "viewpoint": "C1-V2", "controls": [{"input": "既知の PR", "observed": 1}]})
        self.assertIn(str(fixture), r.refused("record", "--file", str(path)))


class TestSeparation(Base):
    def test_smokeがpassしていない観点の検証を受理しない(self):
        r = self.run_(controlled=True)
        r.fixed()
        r.work()
        _, brief = r.brief("verifier", "--viewpoint", "C1-V2")
        self.assertEqual(brief["mode"], "smoke")
        path = r.submit(brief, {"agent": "v", "viewpoint": "C1-V2", "status": "pass", "observed": 1,
                                "evidence": "x", "findings": []})
        self.assertIn("未知のキー", r.refused("record", "--file", str(path)))
        r.smoke(observed=0)
        _, again = r.brief("verifier", "--viewpoint", "C1-V2")
        self.assertEqual(again["mode"], "smoke")
        r.submit(again, {"agent": "s2", "viewpoint": "C1-V2", "controls": [{"input": "既知の PR", "observed": 1}]})
        r.ok("record", "--file", again["out"])
        _, verify = r.brief("verifier", "--viewpoint", "C1-V2")
        self.assertEqual(verify["mode"], "verify")

    def test_blockingの指摘を持つ検証はpassと申告してもfail(self):
        r = self.run_()
        r.fixed()
        r.work()
        r.verify("C1-V1", "v1", status="pass", findings=[finding()])
        r.verify("R-REQUEST", "v2")
        r.verify("R-OUTSIDE", "v3")
        unmet = {u["viewpoint"]: u["status"] for u in r.ok("status")["unmet"]}
        self.assertEqual(unmet, {"C1-V1": "fail"})
        self.assertIn("C1-V1", r.refused("close"))

    def test_検証役が生成者と同じagentなら拒否する(self):
        r = self.run_()
        r.fixed()
        r.work(agent="same")
        _, brief = r.brief("verifier", "--viewpoint", "C1-V1")
        path = r.submit(brief, {"agent": "same", "viewpoint": "C1-V1", "status": "pass", "observed": None,
                                "evidence": "x", "findings": []})
        self.assertIn("writer と同じ", r.refused("record", "--file", str(path)))

    def test_criteria_verifierがauthorと同じなら拒否する(self):
        r = self.run_()
        r.init()
        r.author(agent="same")
        _, brief = r.brief("criteria-verifier", "--aspect", "scope")
        path = r.submit(brief, {"agent": "same", "aspect": "scope", "reviewed_sha256": sha(r.dir / "scope.json"),
                                "findings": []})
        self.assertIn("author と同じ", r.refused("record", "--file", str(path)))

    def test_quoteが逐語でなければ拒否する(self):
        r = self.run_()
        r.init()
        bad = r.scope()
        bad["conditions"][0]["source"]["quote"] = "往復を減らす"
        _, brief = r.brief("criteria-author", "--aspect", "scope")
        r.write("scope", bad)
        self.assertIn("逐語", r.refused("record", "--file", str(r.submit(brief, {"agent": "a"}))))

    def test_briefが渡したrequestの絶対パスをsource_pathに書いたcriteriaを受け付ける(self):
        r = self.run_()
        r.init()
        _, brief = r.brief("criteria-author", "--aspect", "scope")
        scope = r.scope()
        scope["conditions"][0]["source"]["path"] = brief["request"]["path"]
        r.write("scope", scope)
        self.assertEqual(r.record(brief, {"agent": "a"})["recorded"], "criteria_written")

    def test_run_dirのrequest_md以外をrequestとして受け付けない(self):
        r = self.run_()
        r.init()
        _, brief = r.brief("criteria-author", "--aspect", "scope")
        elsewhere = self.root / "other"
        elsewhere.mkdir()
        copy = elsewhere / "request.md"
        copy.write_text(REQUEST)
        note = r.dir / "note.md"
        note.write_text(REQUEST)
        link = r.dir / "link.md"
        link.symlink_to(copy)
        for raw in (copy, note, link):
            scope = r.scope()
            scope["conditions"][0]["source"]["path"] = str(raw)
            r.write("scope", scope)
            self.assertIn("登録した資料ではない", r.refused("record", "--file", str(r.submit(brief, {"agent": "a"}))))
        (r.dir / "request.md").unlink()
        (r.dir / "request.md").symlink_to(copy)
        scope = r.scope()
        scope["conditions"][0]["source"]["path"] = str(copy.resolve())
        r.write("scope", scope)
        self.assertIn("登録した資料ではない", r.refused("record", "--file", str(r.submit(brief, {"agent": "a"}))))

    def test_roundsが5を超える測定の文書を拒否する(self):
        r = self.run_()
        r.scoped()
        _, brief = r.brief("criteria-author", "--aspect", "design")
        r.write("design", r.design(budget={"rounds": 6, "wall_seconds": 60}))
        self.assertIn("MAX_ROUNDS", r.refused("record", "--file", str(r.submit(brief, {"agent": "a"}))))


class TestResidualReferences(unittest.TestCase):
    REMOVED = re.compile(
        r"pdca\.js|pdca-plan\.js|ledger\.py|ledger\.md|harness_freeze|harness-freeze|goal_selector|skill_telemetry"
        r"|verification-lenses|shared-context|agent-contracts|plan-template|run-table|operators\.md|sample_ledger"
        r"|(?<![\w-])(intake|evidence-collector|planner|builder|build-verifier|runner|mechanism-analyst"
        r"|mechanism-arbiter|plan-verifier|act-judge|revision-planner)(?![\w-])"
        r"|MAX_REVISION_DIFFS|MAX_PLAN_REVISIONS|MAX_BUILD_REVISIONS|DEFAULT_MAX_CYCLES|VERIFY_LENSES"
        r"|measurement_harness|frozenHarness|criteria\.json|criteria_shape"
    )

    def test_削除した名前がpdcaの文書に残っていない(self):
        hits = []
        for path in sorted(SKILL.rglob("*")):
            if not path.is_file() or path.suffix not in (".md", ".json", ".py") or path == Path(__file__).resolve():
                continue
            for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
                if self.REMOVED.search(line):
                    hits.append(f"{path.relative_to(SKILL)}:{lineno}: {line.strip()}")
        self.assertEqual(hits, [])

    def test_SKILL_mdはWorkflow呼び出しの形を持たない(self):
        text = (SKILL / "SKILL.md").read_text(encoding="utf-8")
        self.assertNotRegex(text, r"Workflow\s*\(\s*\{[\s\S]*?scriptPath")


class TestStopAndLedger(Base):
    def test_自動継続は4回目を拒否する(self):
        r = self.run_()
        r.fixed()
        for n in range(1, 4):
            self.assertEqual(r.ok("continue")["count"], n)
        self.assertIn("stop:auto_continue", r.refused("continue"))
        status = r.ok("status")
        self.assertEqual(status["auto_continue"]["count"], 3)
        self.assertEqual(status["next"], "stop:auto_continue")
        self.assertIn("停止中", r.refused("brief", "--role", "writer", "--conditions", "C1"))

    def test_completion_judgeのcompleteが無ければcloseできない(self):
        r = self.run_()
        r.fixed()
        r.work()
        r.verify_all("r1")
        self.assertIn("complete", r.refused("close"))
        r.ok("record", "--file", str(r.judge(verdict="not_complete")[1]))
        self.assertIn("complete", r.refused("close"))

    def test_openが空でないcompleteの判定を記録せずcloseもできない(self):
        r = self.run_()
        r.fixed()
        r.work()
        r.verify_all("r1")
        brief, path = r.judge(verdict="complete", open_items=["unmet requirement"])
        self.assertIn("open", r.refused("record", "--file", str(path)))
        forge(r, "judgment", {"verdict": "complete", "open": ["unmet requirement"], "reason": "x", "agent": "judge"},
              brief_id=brief["brief_id"])
        self.assertNotEqual(r.next(), "close")
        self.assertIn("open", r.refused("close"))

    def test_openが空のnot_completeの判定を記録しない(self):
        r = self.run_()
        r.fixed()
        r.work()
        r.verify_all("r1")
        _, path = r.judge(verdict="not_complete", open_items=[])
        self.assertIn("open", r.refused("record", "--file", str(path)))

    def test_途中の行の書き換えを検出する(self):
        r = self.run_()
        r.fixed()
        lines = (r.dir / "ledger.jsonl").read_text().splitlines()
        entry = json.loads(lines[1])
        entry["ts"] = "2000-01-01T00:00:00+00:00"
        lines[1] = json.dumps(entry, ensure_ascii=False)
        (r.dir / "ledger.jsonl").write_text("\n".join(lines) + "\n")
        self.assertIn("prev_sha256", r.refused("status"))

    def test_検証を経ずに追記したcloseを拒否する(self):
        r = self.run_()
        r.fixed()
        forge(r, "close", {"documents": {a: sha(r.dir / f"{a}.json") for a in ("scope", "design")},
                           "human_gates": ["マージ"]})
        self.assertIn("成立していない", r.refused("status"))

    def test_briefを経ずに追記した記録を拒否する(self):
        r = self.run_()
        r.fixed()
        r.work()
        forge(r, "verification", {"viewpoint": "C1-V1", "reported": "pass", "status": "pass", "observed": None,
                                  "evidence": "x", "findings": [], "agent": "v"}, brief_id="b99")
        self.assertIn("script を経ない追記", r.refused("status"))

    def test_レビューを経ずに追記したfixを拒否する(self):
        r = self.run_()
        r.scoped()
        r.author("design")
        forge(r, "fix", {"documents": {a: sha(r.dir / f"{a}.json") for a in ("scope", "design")}, "means": [],
                         "budget": {"rounds": 3, "wall_seconds": 7200}})
        self.assertIn("成立していない", r.refused("status"))

    def test_97_末尾改行の無い台帳を拒否する(self):
        r = self.run_()
        r.init()
        path = r.dir / "ledger.jsonl"
        path.write_text(path.read_text().rstrip("\n"))
        self.assertIn("末尾", r.refused("status"))

    def test_97_パス引数のチルダを展開する(self):
        home = self.root / "home"
        home.mkdir()
        env = {**os.environ, "HOME": str(home)}
        r = Run(self.root, env=env)
        request = self.root / "req.txt"
        request.write_text(REQUEST)
        code, _, err = r.cli("init", "--run-dir", "~/run", "--request-file", str(request))
        self.assertEqual(code, 0, err)
        self.assertTrue((home / "run" / "ledger.jsonl").is_file())

    def test_97_呼び出し側のseqを拒否する(self):
        r = self.run_()
        r.fixed()
        _, brief = r.brief("writer", "--conditions", "C1")
        path = r.submit(brief, {"agent": "w", "outputs": ["x"], "prev_sha256": "", "ts": "x"})
        self.assertIn("script が付けるキー", r.refused("record", "--file", str(path)))

    def test_97_OSErrorとUnicodeDecodeErrorをJSONのエラーにする(self):
        r = self.run_()
        self.assertTrue(r.refused("init", "--request-file", str(self.root / "missing.txt")))
        binary = self.root / "bin.txt"
        binary.write_bytes(b"\xff\xfe\x00bad")
        self.assertTrue(r.refused("init", "--request-file", str(binary)))

    def test_97_空行を破損として拒否する(self):
        r = self.run_()
        r.fixed()
        path = r.dir / "ledger.jsonl"
        lines = path.read_text().splitlines()
        path.write_text("\n".join(lines[:2] + [""] + lines[2:]) + "\n")
        self.assertIn("空行", r.refused("status"))

    def test_97_配列の出力を拒否する(self):
        r = self.run_()
        r.fixed()
        _, brief = r.brief("writer", "--conditions", "C1")
        path = Path(brief["out"])
        path.write_text(json.dumps([{"role": "writer", "brief_id": brief["brief_id"], "agent": "w",
                                     "prompt_extra": "", "outputs": []}]))
        self.assertIn("配列", r.refused("record", "--file", str(path)))

    def test_97_init以外は台帳が無ければ拒否する(self):
        r = self.run_()
        r.dir.mkdir()
        for sub in ("status", "fix", "continue", "close"):
            self.assertIn("init の前", r.refused(sub))

    def test_budgetの無いfix行はどの操作も追記前にJSONのエラーで拒否する(self):
        r = self.run_()
        r.fixed()
        r.work()
        _, brief = r.brief("verifier", "--viewpoint", "C1-V1")
        rewrite(r, "fix", lambda data: data.pop("budget"))
        before = (r.dir / "ledger.jsonl").read_text()
        path = r.submit(brief, {"agent": "v", "viewpoint": "C1-V1", "status": "pass", "observed": None,
                                "evidence": "x", "findings": []})
        self.assertIn("budget", r.refused("record", "--file", str(path)))
        for args in (("status",), ("continue",), ("fix",), ("brief", "--role", "verifier", "--viewpoint", "R-REQUEST")):
            self.assertIn("budget", r.refused(*args))
        self.assertEqual((r.dir / "ledger.jsonl").read_text(), before)

    def test_kindかroleが文字列でない台帳をJSONのエラーで拒否する(self):
        for name, (kind_, data) in {"kind": (["brief"], {"role": "writer", "conditions": ["C1"]}),
                                    "role": ("brief", {"role": ["writer"], "conditions": ["C1"]})}.items():
            (self.root / name).mkdir()
            r = Run(self.root / name)
            r.init()
            forge(r, kind_, data, brief_id="b2")
            with self.subTest(name):
                proc = subprocess.run([sys.executable, str(SCRIPT), "status", "--run-dir", str(r.dir)],
                                      capture_output=True, text=True)
                self.assertEqual(proc.returncode, 1, proc.stderr)
                self.assertIn("error", json.loads(proc.stderr))

    def test_引きに使う欄が文字列でない台帳をJSONのエラーで拒否する(self):
        def brief_id(r):
            r.init()
            forge(r, "brief", {"role": "writer", "conditions": ["C1"]}, brief_id=["b2"])
            return ("status",)

        def mode(r):
            r.init()
            forge(r, "brief", {"role": "verifier", "viewpoint": "R-REQUEST", "mode": ["verify"]}, brief_id="b2")
            out = r.root / "out.json"
            out.write_text(json.dumps({"role": "verifier", "brief_id": "b2", "agent": "v", "prompt_extra": ""}))
            return ("record", "--file", str(out))

        def viewpoint(r):
            r.init()
            forge(r, "brief", {"role": "verifier", "viewpoint": "R-REQUEST", "mode": "verify"}, brief_id="b2")
            forge(r, "verification", {"viewpoint": ["R-REQUEST"], "reported": "pass", "status": "pass",
                                      "observed": None, "evidence": "x", "findings": [], "agent": "v"}, brief_id="b2")
            return ("status",)

        def agent(r):
            r.scoped()
            r.author("design")
            r.review("design")
            rewrite(r, "criteria_written", lambda data: data.update(agent=["a"]))
            return ("fix",)

        def outputs(r):
            r.fixed()
            r.work()
            rewrite(r, "work", lambda data: data.update(outputs=[["docs"]]))
            return ("brief", "--role", "verifier", "--viewpoint", "R-REQUEST")

        def asks(r):
            r.init()
            r.author()
            rewrite(r, "criteria_written", lambda data: data.update(asks=[{"id": ["K2"], "ask": "q"}]))
            answer = r.root / "answer.txt"
            answer.write_text("入れない\n")
            return ("amend", "--request-file", str(answer), "--answers", "K2")

        for case in (brief_id, mode, viewpoint, agent, outputs, asks):
            (self.root / case.__name__).mkdir()
            r = Run(self.root / case.__name__)
            args = case(r)
            with self.subTest(case.__name__):
                proc = subprocess.run([sys.executable, str(SCRIPT), *args, "--run-dir", str(r.dir)],
                                      capture_output=True, text=True)
                self.assertNotIn("Traceback", proc.stderr, proc.stderr.splitlines()[-1:])
                self.assertEqual(proc.returncode, 1, proc.stderr)
                self.assertIn("error", json.loads(proc.stderr))

    def test_台帳のどの欄を想定外の型にしても読む段階の検査で拒否する(self):
        r = self.run_(controlled=True)
        r.init()
        extra = self.root / "more.txt"
        extra.write_text("README も直して\n")
        r.ok("amend", "--request-file", str(extra))
        r.author()
        r.review("scope", findings=[finding(layer="範囲の導出", target="scope.json", severity="non_blocking")])
        r.author("design")
        r.review("design")
        r.ok("fix")
        r.ok("continue")
        r.smoke()
        r.work()
        r.verify_all("r1")
        r.ok("record", "--file", str(r.judge()[1]))
        r.ok("close")
        free = {("verification", ("data", "observed")), ("verification", ("data", "evidence")),
                ("judgment", ("data", "reason")), ("smoke", ("data", "controls", "*", "input")),
                ("smoke", ("data", "controls", "*", "observed"))}

        def nodes(obj, path=()):
            items = obj.items() if isinstance(obj, dict) else enumerate(obj) if isinstance(obj, list) else ()
            for key, value in items:
                yield path + (key,)
                yield from nodes(value, path + (key,))

        ledger = r.dir / "ledger.jsonl"
        original = ledger.read_text()
        module = load_module()
        for i, line in enumerate(original.splitlines()):
            entry = json.loads(line)
            for path in nodes(entry):
                shape = tuple("*" if isinstance(k, int) else k for k in path)
                if path == ("prev_sha256",) or (entry["kind"], shape) in free:
                    continue
                with self.subTest(seq=i + 1, kind=entry["kind"], path=shape):
                    entries = [json.loads(x) for x in original.splitlines()]
                    holder = entries[i]
                    for key in path[:-1]:
                        holder = holder[key]
                    holder[path[-1]] = {"x": [1]}
                    lines, prev = [], ""
                    for e in entries:
                        e["prev_sha256"] = prev
                        lines.append(json.dumps(e, ensure_ascii=False))
                        prev = hashlib.sha256(lines[-1].encode("utf-8")).hexdigest()
                    ledger.write_text("\n".join(lines) + "\n")
                    with self.assertRaises(module.StateError):
                        module.Ledger(r.dir)
        ledger.write_text(original)

    def test_想定外の例外もexit1とJSONのエラーで返し型と位置を含める(self):
        r = self.run_()
        r.init()
        module = load_module()

        def broken_status(state):
            raise ZeroDivisionError("壊れた status")

        module.State.status = broken_status
        err = io.StringIO()
        with contextlib.redirect_stderr(err), contextlib.redirect_stdout(io.StringIO()):
            code = module.main(["status", "--run-dir", str(r.dir)])
        self.assertEqual(code, 1)
        line = broken_status.__code__.co_firstlineno + 1
        self.assertEqual(json.loads(err.getvalue())["error"],
                         f"想定外の例外 ZeroDivisionError: 壊れた status（{Path(__file__).name}:{line} broken_status）")

    def test_旧形式の台帳はどの操作もJSONのエラーで拒否する(self):
        old_written = [("brief", {"role": "criteria-author"}), ("criteria_written", {"criteria_sha256": "x", "agent": "a"})]
        old_review = [("brief", {"role": "criteria-author", "aspect": "scope"}),
                      ("criteria_written", {"aspect": "scope", "sha256": "x", "agent": "a", "asks": []}),
                      ("brief", {"role": "criteria-verifier", "aspect": "scope"}),
                      ("criteria_review", {"aspect": "scope", "reviewed_sha256": "x", "verdict": "pass",
                                           "findings": [], "agent": "s"})]
        for name, lines in (("written", old_written), ("review", old_review)):
            (self.root / name).mkdir()
            r = Run(self.root / name)
            r.init()
            for n, (kind, data) in enumerate(lines, start=2):
                forge(r, kind, data, brief_id=f"b{n}" if kind == "brief" else f"b{n - 1}")
            for args in (("status",), ("continue",), ("fix",), ("close",),
                         ("brief", "--role", "criteria-author", "--aspect", "scope")):
                with self.subTest(ledger=name, args=args):
                    proc = subprocess.run([sys.executable, str(SCRIPT), *args, "--run-dir", str(r.dir)],
                                          capture_output=True, text=True)
                    self.assertEqual(proc.returncode, 1, proc.stderr)
                    self.assertIn("error", json.loads(proc.stderr))

    def test_使用済みのbrief_idを拒否する(self):
        r = self.run_()
        r.fixed()
        _, brief = r.brief("writer", "--conditions", "C1")
        path = r.submit(brief, {"agent": "w", "outputs": ["x"]})
        r.ok("record", "--file", str(path))
        self.assertIn("使用済み", r.refused("record", "--file", str(path)))


if __name__ == "__main__":
    unittest.main()
