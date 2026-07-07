# Knowledge Model

## 目次

- [Workspace Shape](#workspace-shape)
- [Knowledge Index Schema](#knowledge-index-schema)
- [Required Semantics](#required-semantics)
- [Page Body Template](#page-body-template)
- [Duplicate Handling](#duplicate-handling)
- [Markdown/RAG Readiness](#markdownrag-readiness)

## Workspace Shape

Use pages as human entry points and databases as structured truth.

```text
Home
- Areas
  - Programming
  - Stock
  - Life
  - Work
- Knowledge Index
- Sources
- Decisions
- Projects
- Inbox
```

Area pages are navigation surfaces. The actual knowledge records should live in `Knowledge Index` and use properties for filtering.

## Knowledge Index Schema

Recommended properties:

```text
Title: title
Type: select
Area: multi_select
Status: select
Summary: rich_text
Source URL: url
Tags: multi_select
Created: created_time
Updated: last_edited_time
Exportable: checkbox
Canonical: checkbox
```

Recommended `Type` values:

```text
Note, Article, HowTo, Decision, Source, Log, Project, Book, Video, Reference
```

Recommended `Status` values:

```text
Inbox, Processing, Evergreen, Archived, Stale, Duplicate
```

Recommended starter `Area` values:

```text
Programming, Stock, AI, iOS, Tax, Investing, Life, Work
```

Treat select lists as open, but avoid near-duplicates such as `Investment` and `Investing` unless the user already distinguishes them.

## Required Semantics

`Type` describes the page role.

- `HowTo`: reusable procedure or implementation recipe
- `Decision`: chosen direction, conclusion, or investment/technical judgment
- `Source`: raw external material or clipped article
- `Article`: article notes with added interpretation
- `Log`: dated work journal or progress record
- `Project`: active outcome with tasks or milestones
- `Reference`: stable factual material to look up later

`Status` describes lifecycle.

- `Inbox`: captured but not processed
- `Processing`: partly classified or needs human review
- `Evergreen`: useful, current, and worth retrieving later
- `Archived`: no longer active but kept
- `Stale`: possibly outdated
- `Duplicate`: overlaps with a better canonical page

`Canonical` means this page is the preferred source for future AI retrieval. Set it only when the page is current, summarized, and more authoritative than related pages.

`Exportable` means the page can be exported to Markdown/JSON without losing important context.

## Page Body Template

Normalize pages toward this shape:

```markdown
## Summary
What this page is about and the current conclusion.

## Context
Why it was captured or researched, including relevant assumptions.

## Notes
Main notes, excerpts, implementation steps, facts, or observations.

## Decision
Personal judgment, chosen approach, rejected options, or investment stance. Leave blank when there is no decision.

## Links
Original source URLs and related Notion pages.

## Next
Open questions, follow-up tasks, or verification needed.
```

For source-only clips, keep `Decision` empty and make `Source URL` explicit. For decision pages, include links to sources used.

## Duplicate Handling

When duplicates are detected:

1. Pick the clearer, more complete, or more recent page as the canonical candidate.
2. Mark only that page `Canonical: true`.
3. Mark weaker overlaps `Status: Duplicate` or `Stale`.
4. Add a link from duplicate/stale pages to the canonical page when possible.
5. Do not merge or delete without explicit user approval.

## Markdown/RAG Readiness

A page is ready for future Markdown or RAG export when:

- The title is descriptive without relying on parent hierarchy.
- `Summary` states the conclusion or page role.
- `Source URL` is set for external material.
- `Decision` is separated from external source notes.
- Related pages are linked in `Links`.
- `Canonical` is set appropriately.
- `Exportable` is true only after the above conditions are met.

Do not build a vector DB inside this skill. This skill prepares clean Notion content that can later be exported to Markdown/JSON and embedded by a separate RAG pipeline.
