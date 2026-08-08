# In-app Browser final fallback

> This skill owns its own copy of this protocol on purpose. `url-reader` defines the same
> protocol for its own callers, but it lives in a different plugin, and a plugin cannot read
> files from another plugin's install directory. This step is executed by the calling agent —
> `url-reader` cannot perform it — so the caller must carry the protocol itself.
> When `url-reader`'s copy changes, update this one too.

Use this protocol whenever `url-reader` returns an incomplete public URL with:

```json
{
  "browser_fallback": {
    "required": true,
    "surface": "in_app_browser",
    "canonical_url": "https://example.com/article"
  }
}
```

This is an execution-plane step for the agent, not a subprocess that `read_url.py` can perform. Do not ask the user whether to try it. Read and follow the `control-in-app-browser` skill before any browser action, and use its in-app Browser binding.

## Required sequence

1. Take `browser_fallback.canonical_url` verbatim. Do not reconstruct it from a status ID, an `i/article` ID, a username, or a page title. Confirm it is the normalized public URL preserved by `url-reader`.
2. Open or navigate an in-app Browser tab to that URL. Do not use a search engine, another URL, or a substitute web reader.
3. After navigation, record the final URL. Reject a redirect to a private/local host or a login wall. A normal public redirect is retained in the audit as `final_url`.
4. Choose the content scope without dumping the whole page. For an X Article, require exactly one `[data-testid="twitterArticleReadView"]`; a count of zero or more than one is `not_found` / `failed`. For other pages, prefer one semantic `article`, then a meaningful `main`/`[role="main"]`, and exclude `nav`, `aside`, `footer`, recommendation blocks, login UI, and repeated chrome. Record the selector or locator used.
5. From the selected scope only, extract ordered visible blocks: title/headings, paragraphs, code, quotes, lists, links, and real public images. For X Articles, accept `pbs.twimg.com/media/` images; for other pages, accept actual `img` URLs after public-URL validation. Never treat CSS/JS URL fragments as images.
6. Normalize and deduplicate image URLs while retaining each image's source block index. Do not download login-page assets. Do not enter credentials or click through a login wall.
7. Record the capture separately from page content:

```json
{
  "attempted": true,
  "canonical_url": "https://x.com/<user>/article/<id>",
  "final_url": "https://x.com/<user>/article/<id>",
  "status": "success|not_found|blocked|failed",
  "article_view_count": 1,
  "content_selector": "[data-testid=\"twitterArticleReadView\"]",
  "text_length": 0,
  "image_count": 0,
  "images": [{"url": "https://pbs.twimg.com/media/...", "block_index": 0}],
  "reason": null
}
```

`status: success` requires a public final URL, a stable selected content scope (exactly one Article view for X Articles), and meaningful visible text. If those checks fail, preserve the reason and keep the source unresolved or partial; never infer missing text.

## Handoff rules

- Pass the extracted Article blocks and the `browser_capture` audit to the content-enricher. Keep the audit out of the successful Notion page body.
- A required fallback with `attempted: false` is a missing enrichment step. Do not run classification, page-normalizer, or queue completion for that item.
- A blocked or failed capture may still be classified only from independently available Notion title/body/URL evidence; never treat the Browser error as Article content.
