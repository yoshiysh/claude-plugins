---
name: pr-create
description: >
  Pushes the current branch, analyzes the diff against main to generate a PR title and body,
  fills the repository's pull_request_template.md when present, and creates the PR as a draft
  via gh. Use when the user asks to open or create a pull request ("PR を作って", "open a PR",
  "プルリク出して") after their work is committed. Does not commit or stage changes
  (use commit for that), and does not merge, review, or update an existing PR.
---

# PR Create Skill

This skill automates and streamlines the GitHub Pull Request (PR) creation process. It analyzes changes in the current branch, generates appropriate titles and descriptions, and creates the PR.

## Overview

1.  **Preparation**: Push the current branch to remote.
2.  **Generate Content**: Analyze diffs to generate PR title and description based on templates.
3.  **Verify Content**: A separate agent re-reads the diff and checks the body against it.
4.  **Execution**: Create a PR in Draft mode using `gh pr create`.

## Detailed Steps

### 1. Preparation

Ensure the current local branch changes are up-to-date and pushed to remote.

```bash
git push -u origin HEAD
```

### 2. Generate Content

Determine the PR title and body.

- **Title**:
    - If single commit: Use that commit message.
    - If multiple commits: Generate a summary title from changes.

- **Body**:
    - Analyze diff (`git diff main...HEAD`).
    - If `.github/pull_request_template.md` exists, fill sections like "Changes (What)", "Reason (Why)", "Compliance Check" following its structure.
    - **IMPORTANT**: Do NOT delete HTML comments (`<!-- ... -->`); keep them as is.

### 3. Verify Content (before creating the PR)

Read `agents/body-verifier.md` and call it with `[PROPOSED_TITLE]`, `[PROPOSED_BODY]`, and
`[BASE_BRANCH]`. It runs in a fresh context, reads the diff itself, and looks for claims the
diff does not support, changes the body omits, and unfilled template sections.

Why a separate agent: the agent that wrote the body already believes its own summary, so
self-checking re-confirms the same reading. A verifier that has not seen the drafting catches
fabricated claims — "検証した" / "tests pass" with nothing behind it — which are the most
damaging kind of error here, because reviewers trust the body before reading the diff.

Why before creating rather than after: a PR notifies reviewers on creation. A body corrected
afterwards does not reach whoever already read the first version.

- `verdict: ok` → proceed to Step 4.
- `verdict: mismatch` → **do not create the PR**. Show the user the fabricated claims and
  missing changes, and let them choose: fix the body, create it anyway, or stop. The branch is
  already pushed, so nothing is lost by pausing here.

### 4. Execution

Create the PR using `gh` command. Create as **Draft** (`--draft`) by default.

```bash
gh pr create --title "<Verified Title>" --body "<Verified Body>" --draft
```

### 5. Post-Creation

If successful, the PR URL is output. Present this URL to the user.

**CRITICAL**: The final output to the user (URL and status) must be in **JAPANESE**.
