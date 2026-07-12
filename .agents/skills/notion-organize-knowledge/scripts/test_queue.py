#!/usr/bin/env python3
"""Regression tests for the deterministic queue contract."""

from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent
QUEUE = ROOT / "queue.py"
AUDIT = ROOT / "validate_run_audit.py"


class QueueTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.workspace = Path(self.temp.name) / "workspace"

    def tearDown(self) -> None:
        self.temp.cleanup()

    def invoke(self, script: Path, *arguments: str, ok: bool = True) -> dict:
        process = subprocess.run(["python3", str(script), *arguments], text=True, capture_output=True)
        if ok and process.returncode != 0:
            self.fail(process.stderr)
        if not ok:
            self.assertNotEqual(process.returncode, 0, process.stdout)
            return json.loads(process.stderr)
        return json.loads(process.stdout)

    def create(self, max_workers: int = 2) -> None:
        self.invoke(
            QUEUE, "create-run", "--workspace", str(self.workspace), "--run-id", "run",
            "--input-kind", "notion_children", "--source-json", '{"page_id":"root"}',
            "--max-workers", str(max_workers),
        )

    def enqueue(self, job_id: str, url: str) -> None:
        self.invoke(
            QUEUE, "enqueue", "--workspace", str(self.workspace), "--run-id", "run", "--job-id", job_id,
            "--source-json", json.dumps({"page_id": job_id, "source_url": url}),
        )

    def enqueue_url_item(self, job_id: str, url: str) -> None:
        self.invoke(
            QUEUE, "enqueue", "--workspace", str(self.workspace), "--run-id", "run", "--job-id", job_id,
            "--source-json", json.dumps({"source_queue_page_id": "url-list", "source_url": url, "source_queue_position": 0}),
        )

    def test_capacity_domain_gate_and_owner_are_enforced(self) -> None:
        self.create()
        self.enqueue("x1", "https://x.com/a")
        self.enqueue("y1", "https://example.com/a")
        self.enqueue("x2", "https://x.com/b")
        self.invoke(AUDIT, "--workspace", str(self.workspace), "--run-id", "run", "--phase", "preflight")

        plan = self.invoke(QUEUE, "dispatch", "--workspace", str(self.workspace), "--run-id", "run")
        self.assertEqual([job["job_id"] for job in plan["worklist"]], ["x1", "y1"])
        self.assertEqual(plan["active_workers"], 0)
        first = self.invoke(QUEUE, "claim", "--workspace", str(self.workspace), "--run-id", "run", "--worker-id", "worker-1", "--job-id", "x1")
        self.assertEqual(first["job"]["job_id"], "x1")
        self.invoke(QUEUE, "heartbeat", "--workspace", str(self.workspace), "--run-id", "run", "--job-id", "x1", "--worker-id", "wrong", ok=False)

        self.invoke(
            QUEUE, "retry", "--workspace", str(self.workspace), "--run-id", "run", "--job-id", "x1",
            "--worker-id", "worker-1", "--retry-after", "2099-01-01T00:00:00Z", "--reason", "rate_limited",
        )
        claimed = self.invoke(QUEUE, "claim", "--workspace", str(self.workspace), "--run-id", "run", "--worker-id", "worker-3")
        self.assertEqual(claimed["job"]["job_id"], "y1")
        blocked = self.invoke(QUEUE, "claim", "--workspace", str(self.workspace), "--run-id", "run", "--worker-id", "worker-4")
        self.assertIsNone(blocked["job"])
        self.invoke(AUDIT, "--workspace", str(self.workspace), "--run-id", "run", "--phase", "progress")

    def test_dispatch_and_status_reclaim_expired_leases_without_false_capacity(self) -> None:
        self.create(max_workers=1)
        self.enqueue("page", "https://example.com/page")
        self.invoke(QUEUE, "claim", "--workspace", str(self.workspace), "--run-id", "run", "--worker-id", "worker-a")
        job_path = self.workspace / "runs" / "run" / "jobs" / "page.json"
        job = json.loads(job_path.read_text())
        job["lease"]["expires_at"] = "2000-01-01T00:00:00Z"
        job_path.write_text(json.dumps(job))
        status = self.invoke(QUEUE, "status", "--workspace", str(self.workspace), "--run-id", "run")
        self.assertEqual(status["counts"]["ready"], 1)
        self.assertEqual(status["capacity"]["active"], 0)
        plan = self.invoke(QUEUE, "dispatch", "--workspace", str(self.workspace), "--run-id", "run")
        self.assertEqual([entry["job_id"] for entry in plan["worklist"]], ["page"])

    def test_terminal_requires_evidence_backed_ai_proposal_and_refetch(self) -> None:
        self.create(max_workers=1)
        self.enqueue("page", "https://example.com/page")
        claimed = self.invoke(QUEUE, "claim", "--workspace", str(self.workspace), "--run-id", "run", "--worker-id", "worker-a")
        self.assertEqual(claimed["job"]["job_id"], "page")
        common = ("--workspace", str(self.workspace), "--run-id", "run", "--job-id", "page", "--worker-id", "worker-a")
        self.invoke(QUEUE, "advance", *common, "--phase", "enrich")
        proposal = {
            "classification": {
                "domain": "Programming", "topic": "Python", "subtopic": None,
                "evidence": ["The source describes Python tests."],
                "tags": [{"value": "python", "evidence": ["Python tests"], "confidence": "high"}],
                "alternatives": [], "decision_reason": "Existing Python topic is the closest fit.",
            }
        }
        self.invoke(QUEUE, "advance", *common, "--phase", "classify", "--proposal-json", json.dumps(proposal))
        application = {
            "page_identity": {
                "mode": "existing_page", "source_page_id": "page", "canonical_page_id": "page",
                "canonical_page_created": False, "source_queue_page_id": None,
            },
            "page_updated": True, "db_registered": True, "content_verified": True,
            "move_attempted": True, "move_verified": True, "source_queue_cleanup": None,
        }
        self.invoke(QUEUE, "advance", *common, "--phase", "apply", "--application-json", json.dumps(application))
        self.invoke(QUEUE, "advance", *common, "--phase", "verify")
        verification = {
            "verifier_id": "verifier-b", "verified_at": "2026-07-11T03:00:00Z",
            "notion_refetch": {"page_id": "page", "fetched_at": "2026-07-11T03:00:00Z", "destination_parent_id": "topic"},
            "page_identity": application["page_identity"],
            "db_registered": True, "content_verified": True, "move_attempted": True, "move_verified": True,
        }
        self.invoke(
            QUEUE, "complete", *common, "--verifier-id", "verifier-b", "--state", "registered",
            "--verification-json", json.dumps(verification),
        )
        self.invoke(AUDIT, "--workspace", str(self.workspace), "--run-id", "run", "--phase", "progress")
        self.invoke(AUDIT, "--workspace", str(self.workspace), "--run-id", "run", "--phase", "final")

    def test_same_worker_cannot_self_verify(self) -> None:
        self.create(max_workers=1)
        self.enqueue("page", "https://example.com/page")
        self.invoke(QUEUE, "claim", "--workspace", str(self.workspace), "--run-id", "run", "--worker-id", "worker-a")
        common = ("--workspace", str(self.workspace), "--run-id", "run", "--job-id", "page", "--worker-id", "worker-a")
        self.invoke(QUEUE, "advance", *common, "--phase", "enrich")
        proposal = '{"classification":{"domain":"AI","topic":"Agents","evidence":["text"],"tags":[],"alternatives":[],"decision_reason":"text"}}'
        self.invoke(QUEUE, "advance", *common, "--phase", "classify", "--proposal-json", proposal)
        application = {
            "page_identity": {
                "mode": "existing_page", "source_page_id": "page", "canonical_page_id": "page",
                "canonical_page_created": False, "source_queue_page_id": None,
            },
            "page_updated": True, "db_registered": True, "content_verified": True,
            "move_attempted": True, "move_verified": True, "source_queue_cleanup": None,
        }
        self.invoke(QUEUE, "advance", *common, "--phase", "apply", "--application-json", json.dumps(application))
        self.invoke(QUEUE, "advance", *common, "--phase", "verify")
        verification = json.dumps({
            "verifier_id": "worker-a", "verified_at": "2026-07-11T03:00:00Z",
            "notion_refetch": {"page_id": "page", "fetched_at": "2026-07-11T03:00:00Z", "destination_parent_id": "topic"},
            "page_identity": application["page_identity"],
            "db_registered": True, "content_verified": True, "move_attempted": True, "move_verified": True,
        })
        result = self.invoke(QUEUE, "complete", *common, "--verifier-id", "worker-a", "--state", "registered", "--verification-json", verification, ok=False)
        self.assertIn("distinct", result["error"])

    def test_existing_page_cannot_be_replaced_by_a_new_canonical_page(self) -> None:
        self.create(max_workers=1)
        self.enqueue("page", "https://example.com/page")
        self.invoke(QUEUE, "claim", "--workspace", str(self.workspace), "--run-id", "run", "--worker-id", "worker-a")
        common = ("--workspace", str(self.workspace), "--run-id", "run", "--job-id", "page", "--worker-id", "worker-a")
        self.invoke(QUEUE, "advance", *common, "--phase", "enrich")
        proposal = '{"classification":{"domain":"AI","topic":"Agents","evidence":["text"],"tags":[],"alternatives":[],"decision_reason":"text"}}'
        self.invoke(QUEUE, "advance", *common, "--phase", "classify", "--proposal-json", proposal)
        replacement = {
            "page_identity": {
                "mode": "url_item", "source_page_id": None, "canonical_page_id": "new-page",
                "canonical_page_created": True, "source_queue_page_id": "queue",
            }
        }
        result = self.invoke(QUEUE, "advance", *common, "--phase", "apply", "--application-json", json.dumps(replacement), ok=False)
        self.assertIn("existing_page", result["error"])

    def test_terminal_job_can_be_reopened_and_recompleted_by_a_new_verifier(self) -> None:
        self.create(max_workers=1)
        self.enqueue("page", "https://example.com/page")
        self.invoke(QUEUE, "claim", "--workspace", str(self.workspace), "--run-id", "run", "--worker-id", "worker-a")
        common = ("--workspace", str(self.workspace), "--run-id", "run", "--job-id", "page", "--worker-id", "worker-a")
        self.invoke(QUEUE, "advance", *common, "--phase", "enrich")
        proposal = {
            "classification": {
                "domain": "AI", "topic": "Agents", "subtopic": None,
                "source_url": "https://mirror.example.com/page",
                "evidence": ["text"], "tags": [], "alternatives": [], "decision_reason": "text",
            }
        }
        self.invoke(QUEUE, "advance", *common, "--phase", "classify", "--proposal-json", json.dumps(proposal))
        identity = {
            "mode": "existing_page", "source_page_id": "page", "canonical_page_id": "page",
            "canonical_page_created": False, "source_queue_page_id": None,
        }
        application = {
            "page_identity": identity, "page_updated": True, "db_registered": True,
            "content_verified": True, "move_attempted": True, "move_verified": True, "source_queue_cleanup": None,
        }
        self.invoke(QUEUE, "advance", *common, "--phase", "apply", "--application-json", json.dumps(application))
        self.invoke(QUEUE, "advance", *common, "--phase", "verify")
        verification = {
            "verifier_id": "verifier-b", "verified_at": "2026-07-12T22:00:00Z",
            "notion_refetch": {"page_id": "page", "fetched_at": "2026-07-12T22:00:00Z", "destination_parent_id": "topic"},
            "page_identity": identity,
            "db_registered": True, "content_verified": True, "move_attempted": True, "move_verified": True,
        }
        self.invoke(
            QUEUE, "complete", *common, "--verifier-id", "verifier-b", "--state", "registered",
            "--verification-json", json.dumps(verification),
        )

        # A terminal job is not "ready", so claim silently skips it instead of leasing it.
        blocked_claim = self.invoke(
            QUEUE, "claim", "--workspace", str(self.workspace), "--run-id", "run",
            "--worker-id", "worker-c", "--job-id", "page",
        )
        self.assertIsNone(blocked_claim["job"])

        reopened = self.invoke(
            QUEUE, "reopen", "--workspace", str(self.workspace), "--run-id", "run", "--job-id", "page",
            "--worker-id", "worker-c", "--reason", "source_url should point at the original publisher",
        )
        self.assertEqual(reopened["state"], "leased")
        self.assertEqual(reopened["phase"], "verify")
        self.assertIsNone(reopened["verification"])
        self.assertEqual(reopened["reopened_from"]["state"], "registered")

        # The prior proposal/application history survives the reopen and can be amended.
        corrected_proposal = json.loads(json.dumps(proposal))
        corrected_proposal["classification"]["source_url"] = "https://original.example.com/page"
        self.invoke(
            QUEUE, "record-proposal", "--workspace", str(self.workspace), "--run-id", "run", "--job-id", "page",
            "--worker-id", "worker-c", "--proposal-json", json.dumps(corrected_proposal),
        )
        new_verification = {
            "verifier_id": "verifier-d", "verified_at": "2026-07-12T23:00:00Z",
            "notion_refetch": {"page_id": "page", "fetched_at": "2026-07-12T23:00:00Z", "destination_parent_id": "topic"},
            "page_identity": identity,
            "db_registered": True, "content_verified": True, "move_attempted": True, "move_verified": True,
        }
        completed = self.invoke(
            QUEUE, "complete", "--workspace", str(self.workspace), "--run-id", "run", "--job-id", "page",
            "--worker-id", "worker-c", "--verifier-id", "verifier-d", "--state", "registered",
            "--verification-json", json.dumps(new_verification),
        )
        self.assertEqual(completed["job"]["state"], "registered")
        self.assertEqual(completed["job"]["proposal"]["classification"]["source_url"], "https://original.example.com/page")

    def test_reopen_rejects_a_non_terminal_job(self) -> None:
        self.create(max_workers=1)
        self.enqueue("page", "https://example.com/page")
        self.invoke(QUEUE, "claim", "--workspace", str(self.workspace), "--run-id", "run", "--worker-id", "worker-a")
        result = self.invoke(
            QUEUE, "reopen", "--workspace", str(self.workspace), "--run-id", "run", "--job-id", "page",
            "--worker-id", "worker-b", "--reason", "test", ok=False,
        )
        self.assertIn("terminal", result["error"])

    def test_url_item_requires_verified_source_cleanup(self) -> None:
        self.create(max_workers=1)
        self.invoke(
            QUEUE, "enqueue", "--workspace", str(self.workspace), "--run-id", "run", "--job-id", "url-item",
            "--input-kind", "url_list", "--source-json",
            json.dumps({"source_queue_page_id": "url-list", "source_queue_position": 0, "source_url": "https://example.com/article"}),
        )
        self.invoke(QUEUE, "claim", "--workspace", str(self.workspace), "--run-id", "run", "--worker-id", "worker-a")
        common = ("--workspace", str(self.workspace), "--run-id", "run", "--job-id", "url-item", "--worker-id", "worker-a")
        self.invoke(QUEUE, "advance", *common, "--phase", "enrich")
        proposal = '{"classification":{"domain":"AI","topic":"Agents","evidence":["text"],"tags":[],"alternatives":[],"decision_reason":"text"}}'
        self.invoke(QUEUE, "advance", *common, "--phase", "classify", "--proposal-json", proposal)
        identity = {
            "mode": "url_item", "source_page_id": None, "canonical_page_id": "canonical-page",
            "canonical_page_created": True, "source_queue_page_id": "url-list",
        }
        self.invoke(QUEUE, "advance", *common, "--phase", "apply", "--application-json", json.dumps({"page_identity": identity}))
        self.invoke(QUEUE, "advance", *common, "--phase", "verify")
        verification = {
            "verifier_id": "verifier-b", "verified_at": "2026-07-11T03:00:00Z",
            "notion_refetch": {"page_id": "canonical-page", "fetched_at": "2026-07-11T03:00:00Z", "destination_parent_id": "topic"},
            "page_identity": identity,
            "db_registered": True, "content_verified": True, "move_attempted": True, "move_verified": True,
        }
        result = self.invoke(QUEUE, "complete", *common, "--verifier-id", "verifier-b", "--state", "registered", "--verification-json", json.dumps(verification), ok=False)
        self.assertIn("source_queue_cleanup", result["error"])
        verification["source_queue_cleanup"] = {"attempted": True, "result": "success", "verified_absent_after": True}
        self.invoke(QUEUE, "complete", *common, "--verifier-id", "verifier-b", "--state", "registered", "--verification-json", json.dumps(verification))
        self.invoke(AUDIT, "--workspace", str(self.workspace), "--run-id", "run", "--phase", "final")


if __name__ == "__main__":
    unittest.main(verbosity=2)
