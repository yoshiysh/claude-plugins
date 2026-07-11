#!/usr/bin/env python3
"""Fail closed validation for a Notion-organize-knowledge batch manifest."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


TERMINAL_STATES = {"registered", "unresolved", "deferred"}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("manifest", type=Path)
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text())
    items = manifest.get("items", [])
    errors: list[str] = []

    if manifest.get("target_count") != len(items):
        errors.append("target_count must equal the number of item records")

    seen: set[str] = set()
    for item in items:
        page_id = item.get("page_id")
        if not page_id or page_id in seen:
            errors.append(f"duplicate or missing page_id: {page_id!r}")
            continue
        seen.add(page_id)

        state = item.get("state")
        if state not in TERMINAL_STATES:
            errors.append(f"{page_id}: non-terminal state {state!r}")
            continue

        reader = item.get("reader", {})
        if item.get("url_required"):
            if not reader.get("attempted"):
                errors.append(f"{page_id}: URL reader was required but not actually attempted")
            if not (reader.get("status") or reader.get("status_reason")):
                errors.append(f"{page_id}: URL reader outcome is missing")

        browser = item.get("browser", {})
        if browser.get("attempted") and not browser.get("canonical_url"):
            errors.append(f"{page_id}: browser attempt has no canonical URL")
        if browser.get("status") == "success" and browser.get("article_view_count") != 1:
            errors.append(f"{page_id}: browser success requires exactly one article view")

        if state == "registered":
            required = ("db_registered", "content_verified", "move_attempted", "move_verified")
            for field in required:
                if item.get(field) is not True:
                    errors.append(f"{page_id}: registered item lacks {field}")
            if not item.get("destination_page_id"):
                errors.append(f"{page_id}: registered item has no destination_page_id")

        if state == "unresolved":
            required = ("unresolved_reason", "move_attempted", "move_verified")
            for field in required:
                if not item.get(field):
                    errors.append(f"{page_id}: unresolved item lacks {field}")

        if state == "deferred" and not item.get("deferred_reason"):
            errors.append(f"{page_id}: deferred item lacks deferred_reason")

    if errors:
        print(json.dumps({"status": "revise", "errors": errors}, ensure_ascii=False, indent=2))
        return 1
    print(json.dumps({"status": "passed", "items": len(items)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
