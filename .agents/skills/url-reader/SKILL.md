---
name: url-reader
description: >
  Enriches URL-only notes, Notion/bookmark inbox items, and captured social post links by using domain-aware reader backends to produce stable Markdown, metadata, image links, and structured failure states.
  Use when Codex needs to normalize twitter.com links to x.com, inspect whether X/Twitter or Instagram posts can be read, download extracted public image assets, or classify login walls, blocked domains, partial extraction, and unsupported private URLs. Do not use for general web browsing, latest-news research, or official API documentation lookup.
---

# URL Reader

Use a domain-aware read-only enrichment layer before summarizing, classifying, or moving URL-only notes. Prefer this skill when a page has too little local context, when Notion only exposes an embed block, or when the user asks whether a social URL can be read.

## Quick Start

Run the bundled script with the original target URL:

```bash
python3 .agents/skills/url-reader/scripts/read_url.py 'https://www.instagram.com/p/...'
```

For machine-readable output:

```bash
python3 .agents/skills/url-reader/scripts/read_url.py 'https://www.instagram.com/p/...' --json
```

To save extracted image assets:

```bash
python3 .agents/skills/url-reader/scripts/read_url.py 'https://www.instagram.com/p/...' --json --download-images /tmp/url-reader-images
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

- `x.com/<user>/status/<id>`: fetch `publish.x.com/oembed` first. Use the returned blockquote paragraph as `markdown`, keep `author_name`, `author_url`, and the date-like link text when present, and report `reader_backend: x_oembed`.
- `twitter.com/<user>/status/<id>` and mobile/www variants: normalize to the equivalent `x.com` URL, then use the X oEmbed path.
- `twitter.com/i/web/status/<id>`: normalize to `x.com/i/status/<id>` before using X oEmbed.
- Instagram post URLs: use the generic reader path. It can often return the caption, author link, location, hashtags, and signed image URLs.
- Instagram Reel URLs (`instagram.com/reel/...`): if the reader returns an Instagram login page or generic shell, report `Blocked` and do not treat extracted login assets as usable images.
- Other public URLs: use the generic reader path unless a more specific domain backend has been added.

X oEmbed is sufficient for post text and author metadata, but it does not reliably expose attached media URLs. If the user asks for X images or video, mark the text extraction separately from media extraction and use another backend or `Needs Review` for media.

## Interpreting Results

Use these extraction statuses:

- `Extracted`: title and meaningful body text are present.
- `Partial`: title, metadata, image links, or a short caption are present, but the page body is incomplete.
- `ImagesOnly`: image URLs are present but the textual content is missing or mostly boilerplate.
- `Blocked`: the selected reader returns an error such as `403`, login wall, domain block, or access denial.
- `Failed`: network, timeout, invalid URL, or parser failure.

For Instagram, image URLs may expire, so download them immediately when the user asks for images. Do not download or preserve login-page assets from Reel URLs.

For X, if oEmbed fails, the script falls back to the generic reader path. If both paths fail, report the exact error and fall back to official X API, browser automation with a logged-in session, another configured backend, or `Needs Review`.

## Output To Use Downstream

For the full JSON contract, read [references/output-contract.md](references/output-contract.md).

When feeding another workflow, keep these fields:

- `input_url`
- `normalized_url`
- `reader_backend`
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
- `error`

For Notion knowledge organization, only register the page when `reader_status` is `Extracted`, `Partial`, or `ImagesOnly` with enough local title context. Do not register or move Instagram Reel URLs that resolve to a login wall; leave them in Inbox as `Needs Review`.

## Validation

Use [evals/evals.json](evals/evals.json) as the minimum regression set after changing routing, safety checks, or the JSON contract. Always run the script on at least one X post, one generic public URL, and one refused private/local URL.
