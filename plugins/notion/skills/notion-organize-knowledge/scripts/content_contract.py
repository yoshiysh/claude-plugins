"""Deterministic validation for source-body application and verification.

The AI decides what the source means.  This module only checks that the
source payload is present, internally consistent, and carried through to the
Notion verification record without being replaced by a summary.
"""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any


SOURCE_CONTENT_STATUSES = {"complete", "partial", "failed", "not_available"}
SOURCE_ORIGINS = {"notion_capture", "url_reader", "browser_fallback", "combined"}
SOURCE_BLOCK_TYPES = {"heading", "paragraph", "quote", "list", "code", "table", "link", "image", "divider"}
CONTENT_APPLICATION_MODES = {
    "preserve_existing_in_place",
    "append_missing_ordered_blocks",
    "rebuild_ordered_notes",
}
SHA256_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
# verbatim: the applied body reproduces ordered_blocks, so the refetched digest must equal the
# source digest.  paraphrase: third-party copyrighted text is rewritten in the knowledge model's
# own words, so the digest legitimately differs and structure (block count / order / images /
# verbatim code blocks) is the verifiable contract instead.
BODY_RENDERINGS = {"verbatim", "paraphrase"}


def canonical_source_content_digest(content: dict[str, Any]) -> str:
    """Return the digest defined by the knowledge model for ordered blocks."""

    canonical = json.dumps(
        content.get("ordered_blocks"),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def source_content_errors(content: Any, prefix: str = "source_content", require_complete: bool = True) -> list[str]:
    errors: list[str] = []
    if not isinstance(content, dict):
        return [f"{prefix} must be an object"]

    status = content.get("status")
    if status not in SOURCE_CONTENT_STATUSES:
        errors.append(f"{prefix}.status is invalid")
    if require_complete and status != "complete":
        errors.append(f"{prefix}.status must be complete for registration")
    origin = content.get("origin")
    if origin not in SOURCE_ORIGINS:
        errors.append(f"{prefix}.origin is invalid")
    raw_markdown = content.get("raw_markdown")
    if not isinstance(raw_markdown, str) or not raw_markdown.strip():
        errors.append(f"{prefix}.raw_markdown must contain the fetched source body")
    blocks = content.get("ordered_blocks")
    if not isinstance(blocks, list) or not blocks:
        errors.append(f"{prefix}.ordered_blocks must contain the source body in order")
        blocks = []
    image_count = 0
    for position, block in enumerate(blocks):
        block_prefix = f"{prefix}.ordered_blocks[{position}]"
        if not isinstance(block, dict):
            errors.append(f"{block_prefix} must be an object")
            continue
        if block.get("index") != position:
            errors.append(f"{block_prefix}.index must equal its position")
        if block.get("type") not in SOURCE_BLOCK_TYPES:
            errors.append(f"{block_prefix}.type is invalid")
        if not isinstance(block.get("markdown"), str) or not block.get("markdown").strip():
            errors.append(f"{block_prefix}.markdown must be non-empty")
        if block.get("type") == "image":
            image_count += 1
            image = block.get("image")
            if not isinstance(image, dict):
                errors.append(f"{block_prefix}.image is required")
            elif not image.get("source_url") and not image.get("persistent_asset"):
                errors.append(f"{block_prefix}.image requires source_url or persistent_asset")
        elif "image" in block and block.get("image") is not None:
            errors.append(f"{block_prefix}.image is only allowed on image blocks")
    if content.get("image_count") != image_count:
        errors.append(f"{prefix}.image_count must equal the number of image blocks")
    if isinstance(raw_markdown, str) and content.get("text_length") != len(raw_markdown):
        errors.append(f"{prefix}.text_length must equal raw_markdown length")
    digest = content.get("digest")
    if not isinstance(digest, str) or not SHA256_RE.fullmatch(digest):
        errors.append(f"{prefix}.digest must be sha256:<64 lowercase hex>")
    elif digest != canonical_source_content_digest(content):
        errors.append(f"{prefix}.digest does not match ordered_blocks")
    return errors


def content_application_errors(job: dict[str, Any], application: Any, prefix: str = "application") -> list[str]:
    errors: list[str] = []
    if not isinstance(application, dict):
        return [f"{prefix} must be an object"]
    action = application.get("action")
    if action == "keep_in_inbox":
        if not application.get("unresolved_reason"):
            errors.append(f"{prefix}.unresolved_reason is required for keep_in_inbox")
        return errors
    if action != "register_and_move_to_topic_page":
        errors.append(f"{prefix}.action must be register_and_move_to_topic_page or keep_in_inbox")
        return errors

    content = application.get("source_content")
    errors.extend(source_content_errors(content, f"{prefix}.source_content"))
    applied = application.get("content_application")
    if not isinstance(applied, dict):
        return errors + [f"{prefix}.content_application is required for registration"]
    identity = application.get("page_identity") or {}
    canonical_page_id = identity.get("canonical_page_id")
    required = {
        "required": True,
        "status": "applied",
        "target_page_id": canonical_page_id,
        "source_content_digest": content.get("digest") if isinstance(content, dict) else None,
        "source_content_block_count": len(content.get("ordered_blocks", [])) if isinstance(content, dict) and isinstance(content.get("ordered_blocks"), list) else None,
        "applied_block_count": len(content.get("ordered_blocks", [])) if isinstance(content, dict) and isinstance(content.get("ordered_blocks"), list) else None,
        "source_content_image_count": content.get("image_count") if isinstance(content, dict) else None,
        "applied_image_count": content.get("image_count") if isinstance(content, dict) else None,
        "source_content_order_preserved": True,
        "image_order_preserved": True,
        "existing_content_preserved": True,
        "destructive_overwrite": False,
    }
    for key, expected in required.items():
        if applied.get(key) != expected:
            errors.append(f"{prefix}.content_application.{key} must be {expected!r}")
    if applied.get("mode") not in CONTENT_APPLICATION_MODES:
        errors.append(f"{prefix}.content_application.mode is invalid")
    if applied.get("body_rendering", "verbatim") not in BODY_RENDERINGS:
        errors.append(f"{prefix}.content_application.body_rendering is invalid")
    return errors


def content_verification_errors(job: dict[str, Any], verification: Any, prefix: str = "verification.content_verification") -> list[str]:
    errors: list[str] = []
    if not isinstance(verification, dict):
        return [f"{prefix} must be an object"]
    application = job.get("application") or {}
    content = application.get("source_content") if isinstance(application, dict) else None
    applied = application.get("content_application") if isinstance(application, dict) else None
    if not isinstance(content, dict) or not isinstance(applied, dict):
        return [f"{prefix} cannot be checked without source_content and content_application"]
    rendering = verification.get("body_rendering") or applied.get("body_rendering") or "verbatim"
    if rendering not in BODY_RENDERINGS:
        errors.append(f"{prefix}.body_rendering is invalid")
        rendering = "verbatim"
    expected = {
        "status": "passed",
        "target_page_id": (application.get("page_identity") or {}).get("canonical_page_id"),
        "source_content_digest": content.get("digest"),
        "source_content_block_count": len(content.get("ordered_blocks", [])),
        "applied_block_count": len(content.get("ordered_blocks", [])),
        "refetched_block_count": len(content.get("ordered_blocks", [])),
        "source_content_image_count": content.get("image_count"),
        "applied_image_count": content.get("image_count"),
        "refetched_image_count": content.get("image_count"),
        "source_content_order_preserved": True,
        "image_order_preserved": True,
        "summary_only_rejected": True,
        "operational_metadata_absent": True,
    }
    if rendering == "verbatim":
        expected["refetched_content_digest"] = content.get("digest")
    else:
        refetched_digest = verification.get("refetched_content_digest")
        if not isinstance(refetched_digest, str) or not SHA256_RE.match(refetched_digest):
            errors.append(f"{prefix}.refetched_content_digest must be the measured sha256 of the refetched blocks")
        expected["paraphrase_structure_verified"] = True
        expected["code_blocks_verbatim"] = True
    for key, expected_value in expected.items():
        if verification.get(key) != expected_value:
            errors.append(f"{prefix}.{key} must be {expected_value!r}")
    return errors
