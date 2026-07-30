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
3.  **Execution**: Create a PR in Draft mode using `gh pr create`.

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

### 3. Execution

Create the PR using `gh` command. Create as **Draft** (`--draft`) by default.

```bash
gh pr create --title "<Generated Title>" --body "<Generated Body>" --draft
```

### 4. Post-Creation

If successful, the PR URL is output. Present this URL to the user.

**CRITICAL**: The final output to the user (URL and status) must be in **JAPANESE**.
