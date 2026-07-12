# Agent Contracts

## 目次

- [input-resolver output](#input-resolver-output)
- [index-maintainer output](#index-maintainer-output)
- [content-enricher output](#content-enricher-output)
- [page-triager output](#page-triager-output)
- [page-normalizer output](#page-normalizer-output)
- [duplicate-reviewer output](#duplicate-reviewer-output)
- [update-verifier output](#update-verifier-output)
- [run queue (local only)](#run-queue-local-only)

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
  "queue_input": {
    "kind": "notion_page|notion_children|notion_database|notion_search|url_list_page|url_list|resume_run",
    "source": {}
  },
  "write_policy": {
    "low_risk_updates_allowed": true,
    "destructive_changes_allowed": false
  },
  "batch_limit": 50,
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
    "browser_fallback_required_count": 0,
    "browser_fallback_attempted_count": 0,
    "attempted_means": "read_url.py_invoked",
    "url_reader_missing": [
      {
        "page_id": "string",
        "url": "string",
        "reason": "string"
      }
    ],
    "browser_fallback_missing": [
      {
        "page_id": "string",
        "url": "string",
        "reason": "string"
      }
    ]
  },
  "visual_analysis_audit": {
    "visual_analysis_required_count": 0,
    "visual_analysis_attempted_count": 0,
    "attempted_means": "image_opened_with_visual_analysis_tool",
    "visual_analysis_missing": [
      {
        "page_id": "string",
        "image_source": "string",
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
      "mirror_source_url": "string|null",
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
      "browser_fallback": {
        "required": false,
        "surface": "in_app_browser|null",
        "canonical_url": "string|null",
        "reason": "string|null"
      },
      "browser_capture": {
        "attempted": false,
        "canonical_url": "string|null",
        "final_url": "string|null",
        "status": "not_attempted|success|not_found|blocked|failed",
        "article_view_count": 0,
        "content_selector": "string|null",
        "text_length": 0,
        "image_count": 0,
        "images": [],
        "reason": "string|null"
      },
      "visual_analysis_required": false,
      "visual_evidence": [
        {
          "source": "string",
          "analysis_status": "Analyzed|Unavailable|NotRequired",
          "description": "string",
          "observations": [],
          "classification_relevance": "string|null",
          "reason": "string|null"
        }
      ],
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
        "source_urls": [],
        "existing_candidates_checked": []
      },
      "classification": {
        "type": "string",
        "summary": "string",
        "source_url": "string|null",
        "source_type": "string",
        "published_at": "YYYY-MM-DD|null",
        "extraction_status": "string",
        "tags": [
          {
            "value": "lowercase-kebab-case",
            "evidence": ["source evidence id or concise observed fact"],
            "confidence": "high|medium|low"
          }
        ],
        "related_topics": [],
        "evidence": ["source evidence id or concise observed fact"],
        "alternatives": [
          {"domain": "string", "topic": "string", "reason_not_selected": "string"}
        ],
        "decision_reason": "why this destination best fits the evidence"
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
  "schema_option_audit": [
    {
      "page_id": "string",
      "property": "Type|Source Type|Domain|Tags|Related Topics",
      "required_options": [],
      "missing_options_before": [],
      "tool_search_attempted": true,
      "update_data_source_tool": "mcp__notion.notion_update_data_source|null",
      "update_result": "success|failed|not_needed|tool_unavailable_after_search",
      "schema_refetched": true,
      "missing_options_after": [],
      "db_retry_result": "success|failed|not_needed"
    }
  ],
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
      "required_sections": ["Summary", "Source", "Notes"],
      "has_summary": true,
      "has_source": true,
      "has_notes": true,
      "has_decision": false,
      "has_open_questions": false,
      "source_url_recorded": true,
      "visual_notes_required": false,
      "has_visual_notes": false,
      "visual_evidence_recorded": true,
      "section_details": {
        "Summary": "present|missing|empty",
        "Source": "present|missing|empty",
        "Notes": "present|missing|empty",
        "Decision": "present|missing|empty|not_required",
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

`applied_updates` の各 item は、Notion への適用前に次の `page_identity` を含める。通常の Notion item は入力ページ自身を正本にし、URL-only list の `page_id: null` item だけが新規ページを作成できる。

```json
{
  "page_identity": {
    "mode": "existing_page|url_item",
    "source_page_id": "string|null",
    "canonical_page_id": "string",
    "canonical_page_created": false,
    "source_queue_page_id": "string|null"
  }
}
```

Queue の `--application-json` に渡す record は1 job分の次の形を使う。`page_identity` を省略した旧形式や、通常ページで source と canonical が異なる形式は apply/verify へ進めない。

```json
{
  "page_identity": {
    "mode": "existing_page",
    "source_page_id": "notion-page-id",
    "canonical_page_id": "notion-page-id",
    "canonical_page_created": false,
    "source_queue_page_id": null
  },
  "page_updated": true,
  "db_registered": true,
  "content_verified": true,
  "move_attempted": true,
  "move_verified": true,
  "source_queue_cleanup": null
}
```

URL-only item では `mode: url_item`、`source_page_id: null`、作成した `canonical_page_id`、`canonical_page_created: true` を使い、`source_queue_cleanup` に URL 行の削除と削除後 fetch の根拠を記録する。

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
  "verification_records": [
    {
      "page_id": "string",
      "verifier_id": "string",
      "verified_at": "ISO-8601",
      "notion_refetch": {
        "page_id": "string",
        "fetched_at": "ISO-8601",
        "destination_parent_id": "string"
      },
      "page_identity": {
        "mode": "existing_page|url_item",
        "source_page_id": "string|null",
        "canonical_page_id": "string",
        "canonical_page_created": false,
        "source_queue_page_id": "string|null"
      },
      "db_registered": true,
      "content_verified": true,
      "move_attempted": true,
      "move_verified": true,
      "source_queue_cleanup": {
        "attempted": true,
        "result": "success",
        "verified_absent_after": true
      }
    }
  ],
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

## run queue (local only)

Use `scripts/queue.py` to create and mutate the only run ledger. `validate_run_audit.py --workspace <workspace> --run-id <run> --phase preflight|progress|final` reads those same files; do not create a parallel manifest or hand-edit job JSON. `events.jsonl` is append-only audit history and is never written into Notion.

```json
{
  "schema_version": 2,
  "job_id": "job-abc123",
  "sequence": 0,
  "input_kind": "notion_page|notion_children|notion_database|notion_search|url_list_page|url_list",
  "source": {},
  "domain": "example.com|null",
  "state": "ready|waiting_retry|leased|registered|unresolved|deferred",
  "phase": "resolve|enrich|classify|apply|verify|done",
  "attempt_count": 0,
  "retry": null,
  "lease": null,
  "proposal": null,
  "application": null,
  "verification": null
}
```

`proposal.classification` must contain `domain`, `topic`, `decision_reason`, evidence, alternatives, and evidence-backed tags. An apply record and terminal `verification` must contain the same `page_identity`. A terminal verification must contain a distinct `verifier_id`, `verified_at`, and Notion refetch evidence (`page_id`, `fetched_at`, `destination_parent_id`). For `existing_page`, the refetched page ID must equal the input `source.page_id`; for `url_item`, the URL row cleanup must be verified absent. `registered` additionally requires DB/content/move verification; `unresolved` requires a reason and move verification.
