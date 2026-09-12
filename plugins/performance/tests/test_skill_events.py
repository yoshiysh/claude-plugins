import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import schema_v2
import skill_events


def fingerprint():
    return {"digest": "a" * 64, "computed_at": 1, "drift": None}


def skill():
    return {"marketplace": "m", "plugin": "demo", "public_name": "demo", "scope": None}


def start(inv="inv-1", parent=None, root=None, evidence="explicit_entry", at=100):
    return {"type": "skill_start", "invocation_id": inv,
            "parent_invocation_id": parent,
            "root_invocation_id": root or (parent and "inv-1") or inv,
            "skill": skill(), "fingerprint": fingerprint(),
            "boundary_evidence": evidence, "at": at}


def end(inv="inv-1", status="completed", at=200):
    return {"type": "skill_end", "invocation_id": inv, "status": status, "at": at}


def span(sid, inv, at=110, kind="agent"):
    return {"type": "span_start", "span_id": sid, "invocation_id": inv,
            "kind": kind, "at": at}


def usage(call, claimed, owner, tokens, at=120):
    return {"type": "usage", "call_identity": call, "claimed_by": claimed,
            "owner_span_id": owner, "host": "claude", "provider": "anthropic",
            "usage": {"input_tokens": tokens, "cached_input_tokens": 0,
                      "output_tokens": 10},
            "evidence": "sdk_message_id", "at": at}


class ScenarioS1(unittest.TestCase):
    def test_declared_only_boundary_never_complete(self):
        result = skill_events.project_events(
            [start(evidence="declared"), end()])
        cov = result["run"]["coverage"]["inv-1"]["boundary"]
        self.assertNotEqual(cov["state"], "complete")
        self.assertEqual(cov["missing_reason"], "declared_only")
        schema_v2.validate_run(result["run"])


class ScenarioS2(unittest.TestCase):
    def test_skill_md_read_alone_emits_no_invocation(self):
        result = skill_events.project_events(
            [{"type": "skill_md_read", "path": "skills/demo/SKILL.md", "at": 1}])
        self.assertEqual(result["run"]["invocations"], [])
        self.assertEqual(len(result["skill_md_reads"]), 1)


class ScenarioS3(unittest.TestCase):
    def test_double_claimed_atom_stays_unattributed(self):
        events = [
            start("inv-P", root="inv-P"), start("inv-Q", root="inv-Q", at=101),
            span("sp-P", "inv-P"), span("sp-Q", "inv-Q"),
            usage("call-1", claimed=["inv-P", "inv-Q"], owner="sp-P", tokens=100),
            end("inv-P"), end("inv-Q", at=201),
        ]
        run = skill_events.project_events(events)["run"]
        atom = run["atoms"][0]
        self.assertIsNone(atom["owner_span_id"])
        zero = {"input_tokens": 0, "cached_input_tokens": 0, "output_tokens": 0}
        self.assertEqual(schema_v2.exclusive_usage(run, "inv-P"), zero)
        self.assertEqual(schema_v2.exclusive_usage(run, "inv-Q"), zero)


class ScenarioS4(unittest.TestCase):
    def test_nested_inclusive_no_double_count(self):
        events = [
            start("inv-P", root="inv-P"),
            start("inv-C", parent="inv-P", root="inv-P", at=105),
            span("sp-P", "inv-P"), span("sp-C", "inv-C"),
            usage("call-p", claimed=["inv-P"], owner="sp-P", tokens=100),
            usage("call-c", claimed=["inv-C"], owner="sp-C", tokens=300, at=130),
            end("inv-C", at=190), end("inv-P"),
        ]
        run = skill_events.project_events(events)["run"]
        self.assertEqual(schema_v2.exclusive_usage(run, "inv-P")["input_tokens"], 100)
        self.assertEqual(schema_v2.exclusive_usage(run, "inv-C")["input_tokens"], 300)
        self.assertEqual(schema_v2.inclusive_usage(run, "inv-P")["input_tokens"], 400)


class ProjectionContracts(unittest.TestCase):
    def test_missing_end_stays_running(self):
        run = skill_events.project_events([start()])["run"]
        self.assertEqual(run["invocations"][0]["status"], "running")
        self.assertIsNone(run["invocations"][0]["ended_at"])

    def test_unknown_event_type_rejected(self):
        with self.assertRaisesRegex(ValueError, "unknown_event_type"):
            skill_events.project_events([{"type": "transcript_guess"}])

    def test_usage_without_claim_rejected(self):
        events = [start(), span("sp-1", "inv-1"),
                  {"type": "usage", "call_identity": "c", "claimed_by": [],
                   "owner_span_id": "sp-1", "host": "claude",
                   "provider": "anthropic",
                   "usage": {"input_tokens": 1, "cached_input_tokens": 0,
                             "output_tokens": 0},
                   "evidence": "e", "at": 5}]
        with self.assertRaisesRegex(ValueError, "usage_without_claim"):
            skill_events.project_events(events)

    def test_deterministic(self):
        events = [start(), span("sp-1", "inv-1"),
                  usage("c1", ["inv-1"], "sp-1", 42), end()]
        a = skill_events.project_events(events)
        b = skill_events.project_events(events)
        self.assertEqual(a, b)


if __name__ == "__main__":
    unittest.main()
