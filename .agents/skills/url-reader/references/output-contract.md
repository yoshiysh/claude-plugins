# URL Reader Output Contract

The script prints one JSON object when run with `--json`. Keep these field names stable so downstream Notion, bookmark, or knowledge workflows can consume results without domain-specific parsing.

## Required Fields

```json
{
  "schema_version": "1.0",
  "input_url": "original user-provided URL",
  "normalized_url": "canonical URL after unwrapping and domain normalization",
  "reader_backend": "x_oembed | tweet_md | generic_reader | null",
  "http_status": 200,
  "reader_status": "Extracted | Partial | ImagesOnly | Blocked | Failed",
  "status_reason": "machine-readable explanation for the status, or null",
  "title": "page or post title, or null",
  "source_url": "source URL reported by the backend, or null",
  "author_name": "social post author name, or null",
  "author_url": "social post author URL, or null",
  "published_at_text": "date-like text from the source, or null",
  "markdown": "extracted text as Markdown",
  "links": [{"text": "link label", "url": "https://example.com"}],
  "image_links": [{"alt": "image alt text", "url": "https://example.com/image.jpg"}],
  "downloaded_images": [{"url": "https://example.com/image.jpg", "path": "/tmp/image.jpg", "bytes": 1234, "alt": ""}],
  "attempts": [{"backend": "x_oembed", "http_status": 200, "status": "Extracted", "reason": null}],
  "warnings": ["non-fatal extraction caveat"],
  "error": "structured failure message, or null",
  "raw_oembed": "backend payload for x_oembed, otherwise null"
}
```

## Status Semantics

- `Extracted`: enough text is available to summarize or classify the source.
- `Partial`: useful metadata, links, image URLs, or a short caption are present, but body extraction is incomplete.
- `ImagesOnly`: image URLs are present and textual content is not useful.
- `Blocked`: login wall, access denial, rate limit, or domain protection.
- `Failed`: invalid input, unsupported URL, timeout, network failure, or parser failure.

When an extraction backend requires a derived retrieval target, `attempts[].reader_url` records it. For example, an X Article may use a same-ID status URL for `tweet_md`; this must never replace the Article's `normalized_url` or `source_url`.

## Safety Rules

- Only fetch public `http` and `https` URLs.
- Refuse localhost, private IPs, link-local addresses, and internal host suffixes before calling a reader backend or downloading images.
- Treat signed image URLs as temporary. Download them immediately only when requested.
- Download only image content and reject individual images larger than 20 MiB.
