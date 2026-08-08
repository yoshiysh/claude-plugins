#!/usr/bin/env python3
"""Shared page-identity rules for the Notion organization queue.

The queue owns state transitions, while AI/MCP workers own content decisions.
This module only answers which Notion page is allowed to become canonical for
an item, so the worker and the audit cannot silently choose different models.
"""

from __future__ import annotations

from typing import Any


EXISTING_PAGE_INPUT_KINDS = frozenset(
    {"notion_page", "notion_children", "notion_database", "notion_search", "resume_run"}
)
URL_ITEM_INPUT_KINDS = frozenset({"url_list", "url_list_page"})


def _string(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def job_page_mode(job: dict[str, Any]) -> str | None:
    """Return the only valid identity mode for a queue job."""

    source = job.get("source") or {}
    page_id = _string(source.get("page_id"))
    if page_id:
        # A URL-list item may already have a temporary Notion page. Once a
        # page_id exists, it follows the normal same-page rule.
        return "existing_page"
    if job.get("input_kind") in URL_ITEM_INPUT_KINDS and _string(source.get("source_queue_page_id")):
        return "url_item"
    return None


def identity_errors(job: dict[str, Any], identity: Any, label: str = "page_identity") -> list[str]:
    """Validate an application or verification identity record."""

    errors: list[str] = []
    if not isinstance(identity, dict):
        return [f"{job.get('job_id', 'job')}: {label} is required"]

    mode = job_page_mode(job)
    prefix = f"{job.get('job_id', 'job')}: {label}"
    if mode is None:
        input_kind = job.get("input_kind")
        errors.append(
            f"{prefix}: cannot derive page identity for input_kind={input_kind!r}; "
            "existing Notion items need source.page_id and URL items need source_queue_page_id"
        )
        return errors
    if identity.get("mode") != mode:
        errors.append(f"{prefix}.mode must be {mode!r}")

    source = job.get("source") or {}
    source_page_id = _string(identity.get("source_page_id"))
    canonical_page_id = _string(identity.get("canonical_page_id"))
    created = identity.get("canonical_page_created")
    if mode == "existing_page":
        expected = _string(source.get("page_id"))
        if source_page_id != expected:
            errors.append(f"{prefix}.source_page_id must equal source.page_id")
        if canonical_page_id != expected:
            errors.append(f"{prefix}.canonical_page_id must equal source.page_id")
        if created is not False:
            errors.append(f"{prefix}.canonical_page_created must be false for an existing Notion page")
        if identity.get("source_queue_page_id") not in (None, ""):
            errors.append(f"{prefix}.source_queue_page_id must be empty for an existing Notion page")
    else:
        expected_queue = _string(source.get("source_queue_page_id"))
        if source_page_id is not None:
            errors.append(f"{prefix}.source_page_id must be null for a URL-only item without page_id")
        if canonical_page_id is None:
            errors.append(f"{prefix}.canonical_page_id is required after creating a URL item page")
        reused = identity.get("reused_existing_canonical") is True
        if reused:
            if created is not False:
                errors.append(f"{prefix}.canonical_page_created must be false when reusing an existing canonical page")
            if not _string(identity.get("duplicate_of")):
                errors.append(f"{prefix}.duplicate_of is required when reusing an existing canonical page")
        elif created is not True:
            errors.append(f"{prefix}.canonical_page_created must be true for a URL-only item")
        if _string(identity.get("source_queue_page_id")) != expected_queue:
            errors.append(f"{prefix}.source_queue_page_id must equal the URL list parent")
    return errors


def identity_key(identity: Any) -> tuple[Any, ...] | None:
    if not isinstance(identity, dict):
        return None
    return (
        identity.get("mode"),
        _string(identity.get("source_page_id")),
        _string(identity.get("canonical_page_id")),
        identity.get("canonical_page_created"),
        _string(identity.get("source_queue_page_id")),
        identity.get("reused_existing_canonical") is True,
        _string(identity.get("duplicate_of")),
    )


def cleanup_verified(cleanup: Any) -> bool:
    """Return true only when a URL-list source row was actually removed and refetched."""

    return (
        isinstance(cleanup, dict)
        and cleanup.get("attempted") is True
        and cleanup.get("result") == "success"
        and cleanup.get("verified_absent_after") is True
    )
