#!/usr/bin/env python3
"""Regression tests for the deterministic queue contract."""

from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from content_contract import canonical_source_content_digest


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

    def source_content(self) -> dict:
        raw_markdown = "Full source body.\n![diagram](https://example.com/diagram.png)"
        content = {
            "status": "complete",
            "origin": "url_reader",
            "raw_markdown": raw_markdown,
            "ordered_blocks": [
                {"index": 0, "type": "paragraph", "markdown": "Full source body."},
                {
                    "index": 1,
                    "type": "image",
                    "markdown": "![diagram](https://example.com/diagram.png)",
                    "image": {
                        "source_url": "https://example.com/diagram.png",
                        "persistent_asset": "notion-asset://diagram",
                        "alt": "diagram",
                    },
                },
            ],
            "text_length": len(raw_markdown),
            "image_count": 1,
        }
        content["digest"] = canonical_source_content_digest(content)
        return content

    def registered_application(self, identity: dict) -> dict:
        content = self.source_content()
        return {
            "page_identity": identity,
            "action": "register_and_move_to_topic_page",
            "source_content": content,
            "content_application": {
                "required": True,
                "status": "applied",
                "target_page_id": identity["canonical_page_id"],
                "mode": "preserve_existing_in_place",
                "source_content_digest": content["digest"],
                "source_content_block_count": 2,
                "applied_block_count": 2,
                "source_content_image_count": 1,
                "applied_image_count": 1,
                "source_content_order_preserved": True,
                "image_order_preserved": True,
                "existing_content_preserved": True,
                "destructive_overwrite": False,
            },
            "knowledge_index": {
                "data_source_id": "collection://index-source",
                "row_page_id": "index-row",
                "parent_type": "data_source_id",
                "notion_page_url": f"https://www.notion.so/{identity['canonical_page_id']}",
            },
            "page_updated": True,
            "db_registered": True,
            "content_verified": True,
            "move_attempted": True,
            "move_verified": True,
            "source_queue_cleanup": None,
        }

    def registered_verification(self, application: dict) -> dict:
        identity = application["page_identity"]
        content = application["source_content"]
        return {
            "verifier_id": "verifier-b",
            "verified_at": "2026-07-11T03:00:00Z",
            "notion_refetch": {
                "page_id": identity["canonical_page_id"], "fetched_at": "2026-07-11T03:00:00Z",
                "destination_parent_id": "topic", "title": "Organized page title",
            },
            "page_identity": identity,
            "db_registered": True,
            "db_verification": {
                "method": "notion-query-data-sources sql",
                "queried_at": "2026-07-11T03:00:00Z",
                "data_source_id": "collection://index-source",
                "row_page_id": "index-row",
                "notion_page_property": f"https://www.notion.so/{identity['canonical_page_id']}",
                "notion_page_matches_canonical": True,
            },
            "content_verified": True,
            "move_attempted": True,
            "move_verified": True,
            "content_verification": {
                "status": "passed",
                "target_page_id": identity["canonical_page_id"],
                "source_content_digest": content["digest"],
                "refetched_content_digest": content["digest"],
                "source_content_block_count": 2,
                "applied_block_count": 2,
                "refetched_block_count": 2,
                "source_content_image_count": 1,
                "applied_image_count": 1,
                "refetched_image_count": 1,
                "source_content_order_preserved": True,
                "image_order_preserved": True,
                "summary_only_rejected": True,
                "operational_metadata_absent": True,
            },
        }

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
        application = self.registered_application({
                "mode": "existing_page", "source_page_id": "page", "canonical_page_id": "page",
                "canonical_page_created": False, "source_queue_page_id": None,
            })
        self.invoke(QUEUE, "advance", *common, "--phase", "apply", "--application-json", json.dumps(application))
        self.invoke(QUEUE, "advance", *common, "--phase", "verify")
        verification = self.registered_verification(application)
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
        application = self.registered_application({
                "mode": "existing_page", "source_page_id": "page", "canonical_page_id": "page",
                "canonical_page_created": False, "source_queue_page_id": None,
            })
        self.invoke(QUEUE, "advance", *common, "--phase", "apply", "--application-json", json.dumps(application))
        self.invoke(QUEUE, "advance", *common, "--phase", "verify")
        verification_record = self.registered_verification(application)
        verification_record["verifier_id"] = "worker-a"
        verification = json.dumps(verification_record)
        result = self.invoke(QUEUE, "complete", *common, "--verifier-id", "worker-a", "--state", "registered", "--verification-json", verification, ok=False)
        self.assertIn("distinct", result["error"])

    def test_summary_only_application_is_rejected(self) -> None:
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
            "action": "register_and_move_to_topic_page",
            "summary": "short classification summary",
        }
        result = self.invoke(QUEUE, "advance", *common, "--phase", "apply", "--application-json", json.dumps(application), ok=False)
        self.assertIn("source_content", result["error"])

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
        application = self.registered_application(identity)
        self.invoke(QUEUE, "advance", *common, "--phase", "apply", "--application-json", json.dumps(application))
        self.invoke(QUEUE, "advance", *common, "--phase", "verify")
        verification = self.registered_verification(application)
        verification["verified_at"] = "2026-07-12T22:00:00Z"
        verification["notion_refetch"]["fetched_at"] = "2026-07-12T22:00:00Z"
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
        new_verification = self.registered_verification(application)
        new_verification["verifier_id"] = "verifier-d"
        new_verification["verified_at"] = "2026-07-12T23:00:00Z"
        new_verification["notion_refetch"]["fetched_at"] = "2026-07-12T23:00:00Z"
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

    def prepare_apply(self) -> tuple[tuple[str, ...], dict]:
        self.create(max_workers=1)
        self.enqueue("page", "https://example.com/page")
        self.invoke(QUEUE, "claim", "--workspace", str(self.workspace), "--run-id", "run", "--worker-id", "worker-a")
        common = ("--workspace", str(self.workspace), "--run-id", "run", "--job-id", "page", "--worker-id", "worker-a")
        self.invoke(QUEUE, "advance", *common, "--phase", "enrich")
        proposal = '{"classification":{"domain":"AI","topic":"Agents","evidence":["text"],"tags":[],"alternatives":[],"decision_reason":"text"}}'
        self.invoke(QUEUE, "advance", *common, "--phase", "classify", "--proposal-json", proposal)
        application = self.registered_application({
                "mode": "existing_page", "source_page_id": "page", "canonical_page_id": "page",
                "canonical_page_created": False, "source_queue_page_id": None,
            })
        return common, application

    def test_index_row_must_be_created_under_the_data_source(self) -> None:
        common, application = self.prepare_apply()
        del application["knowledge_index"]
        result = self.invoke(QUEUE, "advance", *common, "--phase", "apply", "--application-json", json.dumps(application), ok=False)
        self.assertIn("knowledge_index is required", result["error"])

        application = self.registered_application(application["page_identity"])
        application["knowledge_index"]["parent_type"] = "page_id"
        result = self.invoke(QUEUE, "advance", *common, "--phase", "apply", "--application-json", json.dumps(application), ok=False)
        self.assertIn("not an index row", result["error"])

        application["knowledge_index"]["parent_type"] = "data_source_id"
        application["knowledge_index"]["notion_page_url"] = "https://www.notion.so/someone-else"
        result = self.invoke(QUEUE, "advance", *common, "--phase", "apply", "--application-json", json.dumps(application), ok=False)
        self.assertIn("notion_page_url must point at canonical_page_id", result["error"])

    def test_registration_requires_a_verifier_query_of_the_index_row(self) -> None:
        common, application = self.prepare_apply()
        self.invoke(QUEUE, "advance", *common, "--phase", "apply", "--application-json", json.dumps(application))
        self.invoke(QUEUE, "advance", *common, "--phase", "verify")
        complete = (QUEUE, "complete", *common, "--verifier-id", "verifier-b", "--state", "registered")

        verification = self.registered_verification(application)
        del verification["db_verification"]
        result = self.invoke(*complete, "--verification-json", json.dumps(verification), ok=False)
        self.assertIn("db_verification is required", result["error"])

        verification = self.registered_verification(application)
        verification["db_verification"]["row_page_id"] = "another-row"
        result = self.invoke(*complete, "--verification-json", json.dumps(verification), ok=False)
        self.assertIn("row_page_id must equal the row the worker created", result["error"])

        verification = self.registered_verification(application)
        verification["db_verification"]["notion_page_property"] = "https://www.notion.so/other-page"
        verification["db_verification"]["notion_page_matches_canonical"] = False
        result = self.invoke(*complete, "--verification-json", json.dumps(verification), ok=False)
        self.assertIn("notion_page_property", result["error"])

        self.invoke(*complete, "--verification-json", json.dumps(self.registered_verification(application)))
        self.invoke(AUDIT, "--workspace", str(self.workspace), "--run-id", "run", "--phase", "final")

    def test_registration_rejects_a_placeholder_page_title(self) -> None:
        common, application = self.prepare_apply()
        self.invoke(QUEUE, "advance", *common, "--phase", "apply", "--application-json", json.dumps(application))
        self.invoke(QUEUE, "advance", *common, "--phase", "verify")
        verification = self.registered_verification(application)
        verification["notion_refetch"]["title"] = "新規ページ"
        result = self.invoke(
            QUEUE, "complete", *common, "--verifier-id", "verifier-b", "--state", "registered",
            "--verification-json", json.dumps(verification), ok=False,
        )
        self.assertIn("placeholder", result["error"])

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
        application = self.registered_application(identity)
        self.invoke(QUEUE, "advance", *common, "--phase", "apply", "--application-json", json.dumps(application))
        self.invoke(QUEUE, "advance", *common, "--phase", "verify")
        verification = self.registered_verification(application)
        result = self.invoke(QUEUE, "complete", *common, "--verifier-id", "verifier-b", "--state", "registered", "--verification-json", json.dumps(verification), ok=False)
        self.assertIn("source_queue_cleanup", result["error"])
        verification["source_queue_cleanup"] = {"attempted": True, "result": "success", "verified_absent_after": True}
        self.invoke(QUEUE, "complete", *common, "--verifier-id", "verifier-b", "--state", "registered", "--verification-json", json.dumps(verification))
        self.invoke(AUDIT, "--workspace", str(self.workspace), "--run-id", "run", "--phase", "final")


if __name__ == "__main__":
    unittest.main(verbosity=2)
