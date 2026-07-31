---
name: url-reader
description: >
  Enriches URL-only notes, Notion/bookmark inbox items, and captured social post links by using domain-aware reader backends, an automatic Browser4 fallback, and an agent-executed in-app Browser fallback when required to produce stable Markdown, metadata, image links, and structured failure states.
  Use when Codex needs to normalize twitter.com links to x.com, read X/Twitter posts or X Articles, inspect whether Instagram posts can be read, download extracted public image assets, or classify login walls, blocked domains, partial extraction, and unsupported private URLs. Do not use for general web browsing, latest-news research, or official API documentation lookup.
---

# URL Reader

Use a domain-aware read-only enrichment layer before summarizing, classifying, or moving URL-only notes. Prefer this skill when a page has too little local context, when Notion only exposes an embed block, or when the user asks whether a social URL can be read.

## Quick Start

Run the bundled script with the original target URL. The script owns backend and Browser4 attempts, but the calling agent owns the in-app Browser handoff:

```bash
python3 [SKILL_DIR]/scripts/read_url.py 'https://www.instagram.com/p/...'
```

When the normal reader returns anything other than `Extracted`, `read_url.py` automatically tries Browser4 and keeps whichever result contains better evidence. Browser4 is optional: if `browser4-cli` is unavailable, the original reader result is preserved and the failed Browser4 attempt is recorded. If the public URL still remains incomplete, the JSON contains `browser_fallback.required: true`; the calling agent must then execute the in-app Browser final-fallback protocol in [references/in-app-browser-fallback.md](references/in-app-browser-fallback.md) without asking the user for permission. This is a fixed retrieval stage, not a decision to ask the user about.

To enable the fallback, install Browser4 and its self-contained runtime, then make `browser4-cli` available on `PATH`. A non-standard CLI location can be supplied with `BROWSER4_CLI=/absolute/path/to/browser4-cli`. The fallback uses a temporary headless profile and deterministic DOM/text commands; it does not run Browser4's autonomous agent, enter credentials, or mutate the target site.

For machine-readable output:

```bash
python3 [SKILL_DIR]/scripts/read_url.py 'https://www.instagram.com/p/...' --json
```

To save extracted image assets:

```bash
python3 [SKILL_DIR]/scripts/read_url.py 'https://www.instagram.com/p/...' --json --download-images /tmp/url-reader-images
```

## Rules

- Pass the original URL to the script. Do not manually add reader-service prefixes.
- Let the script pick the retrieval path from the URL domain. Keep the skill instructions generic so future domain-specific fetchers can be added without changing user prompts.
- If a URL already contains one or more reader-service prefixes, let the script unwrap them instead of manually editing the URL.
- Normalize `twitter.com`, `www.twitter.com`, and `mobile.twitter.com` URLs to `x.com` before extraction.
- Refuse localhost, private IPs, and internal hostnames. Public URL readers should not receive private or machine-local URLs.
- Treat reader output as extracted public web content, not as an authoritative API response. Keep the original `URL Source` with any summary.
- Keep failures explicit. Do not infer hidden post text when the reader returns a login page, 403, domain block, empty content, or unrelated navigation.

## Domain Routing

Use these reader paths:

- `x.com/<user>/status/<id>`: fetch `publish.x.com/oembed` first. Use the returned blockquote paragraph as `markdown`, keep `author_name`, `author_url`, and the date-like link text when present, and report `reader_backend: x_oembed`. If that paragraph is only one `t.co` link, derive `x.com/<user>/article/<id>` from the original status URL and try the X Article route before treating the post as link-only.
- `twitter.com/<user>/status/<id>` and mobile/www variants: normalize to the equivalent `x.com` URL, then use the X oEmbed path.
- `twitter.com/i/web/status/<id>`: normalize to `x.com/i/status/<id>` before using X oEmbed.
- `x.com/<user>/article/<id>`: preserve the canonical Article URL as `normalized_url` and `source_url`, and use the generic reader for the Article page. If the result is incomplete, `read_url.py` automatically tries Browser4 against that same canonical Article URL; if it remains incomplete, it sets `browser_fallback.required: true` and the calling agent must use in-app Browser against that exact URL. Do not replace the Article URL with a derived status URL. An opaque `x.com/i/article/<id>` URL must remain opaque; do not infer an author or a same-ID status URL.
- Instagram post URLs: use the generic reader path. It can often return the caption, author link, location, hashtags, and signed image URLs.
- Instagram Reel URLs (`instagram.com/reel/...`): if the reader returns an Instagram login page or generic shell, report `Blocked` and do not treat extracted login assets as usable images.
- Other public URLs: use the generic reader path first. If the result is `Partial`, `ImagesOnly`, `Blocked`, or `Failed`, `read_url.py` automatically tries Browser4 and then emits the mandatory in-app Browser handoff if the result is still incomplete. Do not omit the handoff because the domain is ordinary.
- GitHub URLs: run the generic reader first. If it returns `403`, an anonymous-access block, rate limiting, or missing repository content, run `[SKILL_DIR]/scripts/read_github_cli.py` when an authenticated `gh` CLI is available before the in-app Browser final fallback. The script uses the CLI's keyring-backed login and never accepts or prints a PAT. If CLI evidence is still incomplete or the CLI is unavailable, execute the required in-app Browser fallback; do not ask the user to choose between them.

X oEmbed is sufficient for post text and author metadata, but it does not reliably expose attached media URLs. If the user asks for X images or video, mark the text extraction separately from media extraction and use another backend or `Needs Review` for media.

## Interpreting Results

Use these extraction statuses:

- `Extracted`: title and meaningful body text are present.
- `Partial`: title, metadata, image links, or a short caption are present, but the page body is incomplete.
- `ImagesOnly`: image URLs are present but the textual content is missing or mostly boilerplate.
- `Blocked`: the selected reader returns an error such as `403`, login wall, domain block, or access denial.
- `Failed`: network, timeout, invalid URL, or parser failure.

For Instagram, image URLs may expire, so download them immediately when the user asks for images. Do not download or preserve login-page assets from Reel URLs.

For X status posts, if oEmbed fails, the script falls back to the generic reader path and then automatically tries Browser4 when the result is incomplete. X Articles use the generic reader path directly, then Browser4, then the mandatory in-app Browser handoff when `browser_fallback.required` is true. The same handoff is mandatory for every other public URL that remains incomplete after its configured reader backends. A result with that flag is not terminal: do not classify, move, register, or mark the item resolved until the in-app Browser attempt is recorded. Browser4 or in-app Browser may still return `Blocked` when a page requires login; never enter credentials or infer hidden text. Do not use `Needs Review` as a default failure state.

Browser4 extraction is intentionally read-only and deterministic: open the public URL in a temporary headless session, extract `document.title`, `document.body.innerText`, and the live body HTML, then close the session. Do not use Browser4 `agent`, `extract`, `summarize`, `swarm`, or login interactions for this fallback.

## Verifying The Claimed Status

`read_url.py` reports `reader_status` from its own extraction. Before handing the result to
anything that acts on it — registering a Notion page, classifying an inbox item, telling the
user a post could be read — read [agents/extraction-verifier.md](agents/extraction-verifier.md)
and call it with the full JSON as `[READER_JSON]`.

Why a separate agent: the status is self-reported by the same run that produced the payload, so
nothing in the pipeline currently contradicts it. A verifier reading only the payload catches
`Extracted` with an empty `markdown`, `ImagesOnly` counting login-page assets, and results still
carrying `browser_fallback.required` that are about to be treated as terminal. Downstream
(`notion-organize-knowledge`) decides registration from this field, and an overstated status
becomes an empty page in the knowledge base that nobody notices later.

- `verdict: consistent` → use the result as reported.
- `verdict: overstated` → treat `actual_status` as the real one. If it drops to `Blocked` or
  `Failed`, do not register or move the item; leave it for review with the verifier's `evidence`.
- `fallback_pending: true` → run the in-app Browser protocol before treating the item as
  terminal, regardless of status.

Skip the verifier only when the result is not being acted on (e.g. the user asked to inspect one
URL interactively and is reading the output themselves).

## Output To Use Downstream

For the full JSON contract, read [references/output-contract.md](references/output-contract.md).

When feeding another workflow, keep these fields:

- `input_url`
- `normalized_url`
- `reader_backend` (`browser4` is used when the automatic browser fallback supplies the best evidence)
- `reader_status`
- `status_reason`
- `title`
- `source_url`
- `author_name`
- `author_url`
- `published_at_text`
- `markdown`
- `links`
- `image_links`
- `downloaded_images`
- `attempts`
- `warnings`
- `browser_fallback` (`required`, `surface`, `canonical_url`, and `reason`, or `null`)
- `error`

For Notion knowledge organization, only register the page when `reader_status` is `Extracted`, `Partial`, or `ImagesOnly` with enough local title context. Do not register or move Instagram Reel URLs that resolve to a login wall; leave them in Inbox as `Needs Review`.

## Validation

Use [evals/evals.json](evals/evals.json) as the minimum regression set after changing routing, safety checks, or the JSON contract. Always run the script on at least one X post, one X Article, one generic public URL, and one refused private/local URL. When Browser4 is installed, also verify a public page whose normal reader is incomplete and confirm that `attempts` contains `browser4`; when it is unavailable, verify that the original result remains usable and the missing dependency is explicit. For any incomplete public URL, verify that `browser_fallback.required` is true and that the calling agent performs the in-app Browser protocol before treating the item as terminal.
