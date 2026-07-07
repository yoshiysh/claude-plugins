# Agent Contracts

## input-resolver output

```json
{
  "status": "ok|needs_input|blocked",
  "scope": {
    "kind": "inbox|page|database|unclassified|unknown",
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
  "data_source_id": "string|null",
  "database_page_id": "string|null",
  "available_properties": [],
  "missing_properties": [],
  "needs_confirmation": []
}
```

## page-triager output

```json
{
  "status": "ok|partial|blocked",
  "pages": [
    {
      "page_id": "string",
      "title": "string",
      "classification": {
        "type": "string",
        "area": [],
        "status": "string",
        "summary": "string",
        "source_url": "string|null",
        "tags": [],
        "canonical_candidate": false,
        "exportable_candidate": false
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
  "needs_confirmation": [],
  "errors": []
}
```

## duplicate-reviewer output

```json
{
  "status": "ok|partial|blocked",
  "canonical_candidates": [],
  "duplicate_candidates": [],
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
    "updated": 0,
    "canonical": 0,
    "duplicates_or_stale": 0,
    "unknown": 0,
    "remaining": 0
  },
  "human_review": []
}
```
