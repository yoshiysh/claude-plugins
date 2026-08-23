#!/usr/bin/env python3
"""Topic Index registration evidence for the Notion organization queue.

A Topic Index row is a Notion page whose parent is the index data source.
A page created under a Topic page, even with the right title, is not a row and
does not appear in any database query. The queue therefore refuses to treat
"registered" as a boolean: the applying worker must record which data source
and which row page it created, and the verifier must record a query of that
data source that found the row pointing at the canonical page.
"""

from __future__ import annotations

import re
from typing import Any


HEX32_RE = re.compile(r"[0-9a-f]{32}")
PLACEHOLDER_TITLES = frozenset({"", "新規ページ", "無題", "untitled", "new page"})


def _string(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def normalize_notion_id(value: Any) -> str | None:
    """Return a comparable form of a Notion id, data source id, or collection:// URL."""

    text = _string(value)
    if text is None:
        return None
    return text.lower().removeprefix("collection://").replace("-", "")


def page_id_from_url(value: Any) -> str | None:
    """Return the page id embedded in a notion.so / app.notion.com URL."""

    text = _string(value)
    if text is None:
        return None
    compact = text.lower().replace("-", "")
    matches = HEX32_RE.findall(compact)
    if matches:
        return matches[-1]
    tail = compact.split("?", 1)[0].rstrip("/").rsplit("/", 1)[-1]
    return tail or None


def is_placeholder_title(value: Any) -> bool:
    text = value.strip().lower() if isinstance(value, str) else ""
    return text in PLACEHOLDER_TITLES


def knowledge_index_errors(job: dict[str, Any], application: Any, prefix: str = "application.knowledge_index") -> list[str]:
    """Validate that the apply record names a real index row under the data source."""

    if not isinstance(application, dict) or application.get("action") != "register_and_move_to_topic_page":
        return []
    record = application.get("knowledge_index")
    if not isinstance(record, dict):
        return [f"{prefix} is required for registration"]
    errors: list[str] = []
    canonical = normalize_notion_id((application.get("page_identity") or {}).get("canonical_page_id"))
    if normalize_notion_id(record.get("data_source_id")) is None:
        errors.append(f"{prefix}.data_source_id must be the Topic Index data source id")
    row = normalize_notion_id(record.get("row_page_id"))
    if row is None:
        errors.append(f"{prefix}.row_page_id must be the Notion id of the created row")
    elif canonical is not None and row == canonical:
        errors.append(f"{prefix}.row_page_id must not be the canonical page itself")
    if record.get("parent_type") != "data_source_id":
        errors.append(f"{prefix}.parent_type must be 'data_source_id'; a page under a Topic page is not an index row")
    if canonical is not None and page_id_from_url(record.get("notion_page_url")) != canonical:
        errors.append(f"{prefix}.notion_page_url must point at canonical_page_id")
    return errors


def db_verification_errors(job: dict[str, Any], verification: Any, prefix: str = "verification.db_verification") -> list[str]:
    """Validate that the verifier queried the data source and found the row."""

    if not isinstance(verification, dict):
        return [f"{prefix} cannot be checked without a verification record"]
    application = job.get("application") or {}
    expected = application.get("knowledge_index") if isinstance(application, dict) else None
    if not isinstance(expected, dict):
        return [f"{prefix} cannot be checked without application.knowledge_index"]
    record = verification.get("db_verification")
    if not isinstance(record, dict):
        return [f"{prefix} is required: query the Topic Index data source and record the row"]
    errors: list[str] = []
    if _string(record.get("method")) is None:
        errors.append(f"{prefix}.method must name the query tool used")
    if _string(record.get("queried_at")) is None:
        errors.append(f"{prefix}.queried_at is required")
    if normalize_notion_id(record.get("data_source_id")) != normalize_notion_id(expected.get("data_source_id")):
        errors.append(f"{prefix}.data_source_id must equal application.knowledge_index.data_source_id")
    if normalize_notion_id(record.get("row_page_id")) != normalize_notion_id(expected.get("row_page_id")):
        errors.append(f"{prefix}.row_page_id must equal the row the worker created")
    canonical = normalize_notion_id((application.get("page_identity") or {}).get("canonical_page_id"))
    if page_id_from_url(record.get("notion_page_property")) != canonical:
        errors.append(f"{prefix}.notion_page_property must be the queried 'Notion Page' value pointing at canonical_page_id")
    if record.get("notion_page_matches_canonical") is not True:
        errors.append(f"{prefix}.notion_page_matches_canonical must be true")
    return errors


def refetched_title_errors(verification: Any, prefix: str = "verification.notion_refetch") -> list[str]:
    """A registered page must carry a real title; placeholders are not organized."""

    refetch = verification.get("notion_refetch") if isinstance(verification, dict) else None
    if not isinstance(refetch, dict):
        return [f"{prefix} is required"]
    title = refetch.get("title")
    if not isinstance(title, str):
        return [f"{prefix}.title must be the refetched page title"]
    if is_placeholder_title(title):
        return [f"{prefix}.title is a placeholder ({title!r}); set the canonical page title before registration"]
    return []
