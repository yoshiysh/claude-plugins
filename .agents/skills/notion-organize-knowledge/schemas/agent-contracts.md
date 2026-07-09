# Agent Contracts

## input-resolver output

```json
{
  "status": "ok|needs_input|blocked",
  "scope": {
    "kind": "bookmark|inbox|url_list_page|page|database|unclassified|unknown",
    "query": "string",
    "page_ids": [],
    "database_ids": []
  },
  "write_policy": {
    "low_risk_updates_allowed": true,
    "destructive_changes_allowed": false
  },
  "batch_limit": 20,
  "questions": []
}
```

## index-maintainer output

```json
{
  "status": "ready|needs_confirmation|blocked",
  "home_page_id": "string|null",
  "topic_index_data_source_id": "string|null",
  "topic_index_database_page_id": "string|null",
  "unresolved_sources_page_id": "string|null",
  "domains": [],
  "available_properties": [],
  "missing_properties": [],
  "select_options": {
    "Type": [],
    "Source Type": [],
    "Domain": [],
    "Tags": [],
    "Related Topics": []
  },
  "schema_updates_applied": [],
  "schema_updates_proposed": [],
  "needs_confirmation": []
}
```

## content-enricher output

```json
{
  "status": "ok|partial|blocked",
  "url_reader_audit": {
    "url_reader_required_count": 0,
    "url_reader_attempted_count": 0,
    "url_reader_missing": [
      {
        "page_id": "string",
        "url": "string",
        "reason": "string"
      }
    ]
  },
  "pages": [
    {
      "page_id": "string",
      "source_queue_page_id": "string|null",
      "source_queue_title": "string|null",
      "source_queue_url": "string|null",
      "source_queue_position": 0,
      "title": "string",
      "resolved_title": "string|null",
      "title_source": "notion|url_reader|url_path|generated|unknown",
      "source_url": "string|null",
      "source_type": "Notion Note|Web Article|Bookmark|PDF|Video|Book|Code|Chat|Unknown",
      "published_at": "YYYY-MM-DD|null",
      "extraction_status": "Not Started|Extracted|Partial|Failed|Needs Manual Review",
      "reader": {
        "required": false,
        "attempted": false,
        "input_url": "string|null",
        "normalized_url": "string|null",
        "backend": "string|null",
        "status": "string|null",
        "status_reason": "string|null",
        "attempts": [],
        "warnings": []
      },
      "summary": "string",
      "source_notes": [],
      "decision_notes": [],
      "evidence": [],
      "unknowns": [],
      "warnings": []
    }
  ]
}
```

## page-triager output

```json
{
  "status": "ok|partial|blocked",
  "pages": [
    {
      "page_id": "string",
      "source_queue_page_id": "string|null",
      "source_queue_title": "string|null",
      "source_queue_url": "string|null",
      "source_queue_position": 0,
      "title": "string",
      "resolved_title": "string|null",
      "title_source": "notion|url_reader|url_path|generated|unknown",
      "topic": {
        "domain": "string",
        "topic": "string",
        "subtopic": "string|null",
        "summary": "string",
        "topic_page_id": "string|null",
        "confidence": "high|medium|low",
        "recommended_action": "register_and_move_to_topic_page|keep_in_inbox",
        "source_urls": []
      },
      "classification": {
        "type": "string",
        "summary": "string",
        "source_url": "string|null",
        "source_type": "string",
        "published_at": "YYYY-MM-DD|null",
        "extraction_status": "string",
        "tags": [],
        "related_topics": []
      },
      "evidence": [],
      "unknowns": []
    }
  ]
}
```

## page-normalizer output

```json
{
  "status": "applied|proposed|partial|blocked",
  "applied_updates": [],
  "proposed_updates": [],
  "schema_updates_applied": [],
  "schema_updates_proposed": [],
  "move_audit": [
    {
      "page_id": "string",
      "destination_page_id": "string",
      "destination_path": "string",
      "tool": "mcp__notion.notion_move_pages",
      "attempted": true,
      "result": "success|failed|skipped",
      "verified": true,
      "ancestor_path_after": []
    }
  ],
  "content_audit": [
    {
      "page_id": "string",
      "required_sections": ["Summary", "Context", "Source", "Decision", "Related Topics"],
      "has_summary": true,
      "has_context": true,
      "has_source": true,
      "has_decision": true,
      "has_related_topics": true,
      "has_open_questions": false,
      "reader_status_recorded": true,
      "source_url_recorded": true,
      "section_details": {
        "Summary": "present|missing|empty",
        "Context": "present|missing|empty",
        "Source": "present|missing|empty",
        "Decision": "present|missing|empty",
        "Related Topics": "present|missing|empty",
        "Open Questions": "present|missing|empty|not_required"
      },
      "result": "success|failed|skipped"
    }
  ],
  "source_queue_cleanup": [
    {
      "source_queue_page_id": "string",
      "source_queue_title": "string",
      "source_queue_url": "string|null",
      "source_queue_position": 0,
      "source_url": "string",
      "item_page_id": "string",
      "destination": "canonical|unresolved",
      "tool": "mcp__notion.notion_update_page",
      "attempted": true,
      "result": "success|failed|skipped",
      "verified_absent_after": true,
      "preserved_unprocessed_urls": true
    }
  ],
  "duplicate_deletes": [
    {
      "page_id": "string",
      "canonical_page_id": "string",
      "reason": "same normalized_url|same source_url|same_notion_page",
      "tool": "string",
      "result": "deleted|archived|trashed"
    }
  ],
  "duplicate_delete_unavailable": [
    {
      "page_id": "string",
      "canonical_page_id": "string",
      "reason": "string"
    }
  ],
  "needs_confirmation": [],
  "unresolved_sources": [
    {
      "page_id": "string",
      "title": "string",
      "url": "string",
      "reason": "string",
      "moved_to_page_id": "string|null",
      "move_audit": {
        "tool": "mcp__notion.notion_move_pages",
        "attempted": true,
        "verified": true,
        "ancestor_path_after": []
      }
    }
  ],
  "errors": []
}
```

## duplicate-reviewer output

```json
{
  "status": "ok|partial|blocked",
  "canonical_candidates": [],
  "duplicate_candidates": [],
  "delete_candidates": [],
  "stale_candidates": [],
  "human_review": []
}
```

## update-verifier output

```json
{
  "status": "passed|revise|needs_human|blocked",
  "findings": [],
  "summary_counts": {
    "processed": 0,
    "db_registered": 0,
    "moved_to_unresolved_sources": 0,
    "moved": 0,
    "content_appended": 0,
    "duplicates_deleted": 0,
    "duplicates_delete_unavailable": 0,
    "duplicates_or_stale": 0,
    "unknown": 0,
    "remaining": 0
  },
  "human_review": []
}
```
