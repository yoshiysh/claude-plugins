#!/usr/bin/env python3
"""Read a URL through a domain-aware reader path and extract text/image links."""

from __future__ import annotations

import argparse
import hashlib
import html
import ipaddress
import json
import os
import re
import shutil
import sys
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from pathlib import Path


GENERIC_READER_HOST = "r." + "ji" + "na.ai"
GENERIC_READER_ENDPOINT = "https://" + GENERIC_READER_HOST + "/"
X_OEMBED_ENDPOINT = "https://publish.x.com/oembed"
IMAGE_RE = re.compile(r"!\[([^\]]*)\]\(([^)\s]+(?:\?[^)]*)?)\)")
TITLE_RE = re.compile(r"^Title:\s*(.+)$", re.MULTILINE)
SOURCE_RE = re.compile(r"^URL Source:\s*(.+)$", re.MULTILINE)
X_STATUS_RE = re.compile(r"^/(?:([^/]+)/status(?:es)?|i/status)/(\d+)")
X_WEB_STATUS_RE = re.compile(r"^/i/web/status/(\d+)")
X_ARTICLE_RE = re.compile(r"^/([^/]+)/article/(\d+)")
LINK_RE = re.compile(r'<a\s+[^>]*href=["\']([^"\']+)["\'][^>]*>(.*?)</a>', re.IGNORECASE | re.DOTALL)
TAG_RE = re.compile(r"<[^>]+>")
INSTAGRAM_REEL_RE = re.compile(r"^/reel/[^/]+/?")
RESULT_SCHEMA_VERSION = "1.0"
BLOCKED_HOSTS = {"localhost", "localhost.localdomain"}
BLOCKED_HOST_SUFFIXES = (".local", ".internal", ".lan", ".home", ".test", ".invalid")
MAX_IMAGE_BYTES = 20 * 1024 * 1024
MAX_BROWSER4_MARKDOWN_CHARS = 50_000


class ReaderError(Exception):
    """Expected reader failure that should be returned as structured output."""


class Browser4HTMLParser(HTMLParser):
    """Collect links and public image URLs from Browser4's live DOM HTML."""

    def __init__(self, source_url: str) -> None:
        super().__init__(convert_charrefs=True)
        self.source_url = source_url
        self.links: list[dict[str, str]] = []
        self.image_links: list[dict[str, str]] = []
        self._link_text: list[str] = []
        self._link_url: str | None = None
        self._skip_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = {key.lower(): value for key, value in attrs}
        tag = tag.lower()
        if tag in {"script", "style", "noscript", "template", "svg"}:
            self._skip_depth += 1
            return
        if self._skip_depth:
            return
        if tag == "a":
            href = attributes.get("href")
            if href:
                self._link_url = urllib.parse.urljoin(self.source_url, href)
                self._link_text = []
        elif tag == "img":
            raw_url = (
                attributes.get("src")
                or attributes.get("data-src")
                or attributes.get("data-original")
                or (attributes.get("srcset") or "").split(",", 1)[0].strip().split(" ", 1)[0]
            )
            if raw_url:
                image_url = urllib.parse.urljoin(self.source_url, raw_url)
                try:
                    validate_public_http_url(image_url)
                except ReaderError:
                    return
                self.image_links.append({"alt": (attributes.get("alt") or "").strip(), "url": image_url})

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag in {"script", "style", "noscript", "template", "svg"} and self._skip_depth:
            self._skip_depth -= 1
            return
        if tag == "a" and self._link_url is not None:
            text = " ".join(part.strip() for part in self._link_text if part.strip()).strip()
            if text:
                self.links.append({"text": text, "url": self._link_url})
            self._link_text = []
            self._link_url = None

    def handle_data(self, data: str) -> None:
        if self._skip_depth:
            return
        if self._link_url is not None:
            self._link_text.append(data)


def resolve_browser4_cli() -> str | None:
    """Find the optional Browser4 CLI without installing or mutating the host."""
    configured = os.environ.get("BROWSER4_CLI")
    if configured:
        return configured if Path(configured).is_file() else None
    return shutil.which("browser4-cli")


def _browser4_command(cli: str, session: str, args: list[str], timeout: int) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    navigation_timeout = str(max(timeout, 30))
    env.setdefault("BROWSER4_CLI_NAVIGATION_TIMEOUT_SECS", navigation_timeout)
    env.setdefault("BROWSER4_CLI_HTTP_TIMEOUT_SECS", str(max(timeout, 30)))
    return subprocess.run(
        [cli, "-s", session, *args],
        capture_output=True,
        text=True,
        timeout=max(timeout + 15, 45),
        check=False,
        env=env,
    )


def _clean_browser4_text(value: str) -> str:
    lines: list[str] = []
    blank_pending = False
    for raw_line in value.splitlines():
        line = re.sub(r"[ \t\u00a0]+", " ", raw_line).strip()
        if not line:
            blank_pending = bool(lines)
            continue
        if blank_pending and lines:
            lines.append("")
        lines.append(line)
        blank_pending = False
    return "\n".join(lines).strip()


def _focus_browser4_content(title: str, body: str) -> str:
    """Trim common browser chrome around an article without guessing missing text."""
    lines = [line.strip() for line in body.splitlines() if line.strip()]
    if not lines:
        return ""
    title_candidates = [candidate.strip() for candidate in (title, title.split(" - ", 1)[0]) if candidate.strip()]
    start = next(
        (index for index, line in enumerate(lines) if any(line == candidate or line.startswith(candidate) for candidate in title_candidates)),
        None,
    )
    if start is None:
        return "\n".join(lines)
    focused = lines[start:]
    if len(focused) > 1 and focused[1] == focused[0]:
        focused.pop(1)
    footer_markers = {"Recommended", "Write a comment", "お問い合わせ", "Contact us"}
    for index, line in enumerate(focused[1:], start=1):
        if line in footer_markers or line.startswith("©20"):
            focused = focused[:index]
            break
    return "\n".join(focused).strip()


def looks_like_browser4_login_wall(title: str, body: str) -> bool:
    lowered = f"{title}\n{body}".lower()
    login_words = ("sign in", "log in", "login", "サインイン", "ログイン")
    credential_words = ("password", "email", "メールアドレス", "パスワード")
    return any(word in lowered for word in login_words) and any(word in lowered for word in credential_words)


def parse_browser4_html(source_url: str, body_html: str) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    parser = Browser4HTMLParser(source_url)
    parser.feed(body_html)
    links: list[dict[str, str]] = []
    seen_links: set[tuple[str, str]] = set()
    for link in parser.links:
        key = (link["text"], link["url"])
        if key in seen_links or link["url"].startswith(("javascript:", "mailto:")):
            continue
        seen_links.add(key)
        links.append(link)
    images: list[dict[str, str]] = []
    seen_images: set[str] = set()
    for image in parser.image_links:
        if image["url"] in seen_images:
            continue
        seen_images.add(image["url"])
        images.append(image)
    return links, images


def run_browser4(url: str, timeout: int) -> dict[str, object]:
    """Read a public URL through Browser4's deterministic DOM commands."""
    cli = resolve_browser4_cli()
    if not cli:
        return {"status": "Failed", "reason": "browser4-cli is not installed or BROWSER4_CLI points to a missing file."}

    session = f"url-reader-{os.getpid()}-{hashlib.sha256(f'{url}-{time.time_ns()}'.encode()).hexdigest()[:10]}"
    opened = False
    try:
        open_result = _browser4_command(
            cli,
            session,
            ["open", "--headless", "--profile-mode", "temporary", url],
            timeout,
        )
        if open_result.returncode != 0:
            detail = (open_result.stderr or open_result.stdout).strip()
            return {"status": "Failed", "reason": f"Browser4 open failed: {detail[:500]}"}
        opened = True

        title_result = _browser4_command(cli, session, ["eval", "document.title"], timeout)
        body_result = _browser4_command(cli, session, ["eval", "document.body.innerText"], timeout)
        html_result = _browser4_command(cli, session, ["get", "html", "body"], timeout)
        if title_result.returncode != 0 or body_result.returncode != 0:
            detail = (body_result.stderr or title_result.stderr or body_result.stdout).strip()
            return {"status": "Failed", "reason": f"Browser4 content extraction failed: {detail[:500]}"}

        title = _clean_browser4_text(title_result.stdout)
        markdown = _clean_browser4_text(body_result.stdout)
        markdown = _focus_browser4_content(title, markdown)
        truncated = len(markdown) > MAX_BROWSER4_MARKDOWN_CHARS
        if truncated:
            markdown = markdown[:MAX_BROWSER4_MARKDOWN_CHARS].rstrip() + "\n\n[Browser4本文は上限文字数で切り詰めました]"
        body_html = html_result.stdout if html_result.returncode == 0 else ""
        links, image_links = parse_browser4_html(url, body_html)
        if looks_like_browser4_login_wall(title, markdown):
            return {
                "status": "Blocked",
                "reason": "Browser4 resolved the URL to a login wall",
                "title": title,
                "markdown": "",
                "links": [],
                "image_links": [],
            }
        useful_lines = [line for line in markdown.splitlines() if line.strip()]
        if len(useful_lines) >= 5 or len(markdown) >= 200:
            status = "Extracted"
            reason = None
        elif title or markdown or image_links:
            status = "Partial" if markdown or title else "ImagesOnly"
            reason = "Browser4 returned only a small amount of page content"
        else:
            status = "Failed"
            reason = "Browser4 returned no usable page content"
        warnings = ["Browser4 did not expose the source HTTP status."]
        if truncated:
            warnings.append("Browser4 body text was truncated at 50000 characters.")
        return {
            "status": status,
            "reason": reason,
            "title": title or None,
            "markdown": markdown,
            "links": links,
            "image_links": image_links,
            "warnings": warnings,
        }
    except subprocess.TimeoutExpired:
        return {"status": "Failed", "reason": "Browser4 command timed out"}
    except OSError as exc:
        return {"status": "Failed", "reason": f"Could not execute browser4-cli: {exc}"}
    finally:
        if opened:
            try:
                _browser4_command(cli, session, ["close"], min(timeout, 10))
            except Exception:  # noqa: BLE001 - cleanup must not mask the read result
                pass


def unwrap_reader_url(url: str) -> str:
    """Remove repeated reader-service prefixes from a URL."""
    current = url.strip()
    for _ in range(20):
        parsed = urllib.parse.urlparse(current)
        if parsed.netloc != GENERIC_READER_HOST:
            return current
        path = parsed.path.lstrip("/")
        if not path:
            return current
        current = urllib.parse.unquote(path)
        if parsed.query:
            current = f"{current}?{parsed.query}"
    return current


def is_blocked_host(hostname: str | None) -> bool:
    if not hostname:
        return True
    host = hostname.strip("[]").lower()
    if host in BLOCKED_HOSTS or host.endswith(BLOCKED_HOST_SUFFIXES):
        return True
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    return ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved


def validate_public_http_url(url: str) -> None:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        raise ReaderError("Only public http/https URLs are supported.")
    if is_blocked_host(parsed.hostname):
        raise ReaderError("Refusing to fetch localhost, private, or internal host URLs.")


def normalize_x_status_url(parsed: urllib.parse.ParseResult) -> urllib.parse.ParseResult:
    web_status_match = X_WEB_STATUS_RE.match(parsed.path)
    if web_status_match:
        return parsed._replace(path=f"/i/status/{web_status_match.group(1)}", query="", fragment="")
    status_match = X_STATUS_RE.match(parsed.path)
    if status_match:
        username, status_id = status_match.groups()
        path = f"/{username}/status/{status_id}" if username else f"/i/status/{status_id}"
        return parsed._replace(path=path, query="", fragment="")
    return parsed


def normalize_x_article_url(parsed: urllib.parse.ParseResult) -> urllib.parse.ParseResult:
    article_match = X_ARTICLE_RE.match(parsed.path)
    if article_match:
        username, article_id = article_match.groups()
        return parsed._replace(path=f"/{username}/article/{article_id}", query="", fragment="")
    return parsed


def normalize_url(url: str) -> str:
    unwrapped = unwrap_reader_url(url)
    parsed = urllib.parse.urlparse(unwrapped)
    host = parsed.netloc.lower()
    host_without_www = host.removeprefix("www.").removeprefix("mobile.")
    if host_without_www == "twitter.com":
        parsed = parsed._replace(netloc="x.com")
    if parsed.netloc.lower().removeprefix("www.").removeprefix("mobile.") == "x.com":
        parsed = parsed._replace(netloc="x.com")
        parsed = normalize_x_status_url(parsed)
        parsed = normalize_x_article_url(parsed)
        return urllib.parse.urlunparse(parsed)
    return unwrapped


def is_x_status_url(url: str) -> bool:
    parsed = urllib.parse.urlparse(url)
    host = parsed.netloc.lower().removeprefix("www.").removeprefix("mobile.")
    return host == "x.com" and bool(X_STATUS_RE.match(parsed.path))


def is_x_article_url(url: str) -> bool:
    parsed = urllib.parse.urlparse(url)
    host = parsed.netloc.lower().removeprefix("www.").removeprefix("mobile.")
    return host == "x.com" and bool(X_ARTICLE_RE.match(parsed.path))


def x_status_article_url(url: str) -> str | None:
    """Derive a canonical Article URL only from a known user-scoped status URL."""
    parsed = urllib.parse.urlparse(url)
    host = parsed.netloc.lower().removeprefix("www.").removeprefix("mobile.")
    status_match = X_STATUS_RE.match(parsed.path)
    if host != "x.com" or not status_match:
        return None
    username, status_id = status_match.groups()
    return f"https://x.com/{username}/article/{status_id}" if username else None


def is_instagram_reel_url(url: str) -> bool:
    parsed = urllib.parse.urlparse(url)
    host = parsed.netloc.lower().removeprefix("www.").removeprefix("mobile.")
    return host == "instagram.com" and bool(INSTAGRAM_REEL_RE.match(parsed.path))


def looks_like_instagram_login_wall(body: str) -> bool:
    lowered = body.lower()
    return (
        "log into instagram" in lowered
        or ("mobile number, username or email" in lowered and "log in with facebook" in lowered)
        or "accounts/login" in lowered
    )


def fetch_x_oembed(url: str, timeout: int) -> tuple[int, dict[str, object] | None, str | None]:
    validate_public_http_url(url)
    query = urllib.parse.urlencode({"url": url, "omit_script": "true"})
    request = urllib.request.Request(
        f"{X_OEMBED_ENDPOINT}?{query}",
        headers={"User-Agent": "codex-url-reader-skill/1.0"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read().decode("utf-8", errors="replace")
            return int(response.status), json.loads(body), None
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        return int(exc.code), None, body[:500]
    except json.JSONDecodeError as exc:
        return 200, None, f"Invalid oEmbed JSON: {exc}"


def strip_html(value: str) -> str:
    value = re.sub(r"(?i)<br\s*/?>", "\n", value)
    value = TAG_RE.sub("", value)
    return html.unescape(value).strip()


def extract_oembed_links(oembed_html: str) -> list[dict[str, str]]:
    links: list[dict[str, str]] = []
    for href, label_html in LINK_RE.findall(oembed_html):
        links.append({"text": strip_html(label_html), "url": html.unescape(href)})
    return links


def markdown_from_x_oembed(oembed_html: str) -> tuple[str, list[dict[str, str]], str | None]:
    paragraph_match = re.search(r"<p[^>]*>(.*?)</p>", oembed_html, flags=re.IGNORECASE | re.DOTALL)
    paragraph = paragraph_match.group(1) if paragraph_match else oembed_html
    body = strip_html(paragraph)
    links = extract_oembed_links(oembed_html)
    date_link = links[-1]["text"] if links else None
    markdown = body
    if links:
        body_links = [
            f"- [{link['text'] or link['url']}]({link['url']})"
            for link in links
            if link["url"] not in body and "status/" not in link["url"]
        ]
        if body_links:
            markdown = f"{body}\n\nLinks:\n" + "\n".join(body_links)
    return markdown.strip(), links, date_link


def is_tco_only_markdown(markdown: str) -> bool:
    """Identify an X post whose entire oEmbed body is one t.co redirect."""
    parsed = urllib.parse.urlparse(markdown.strip())
    return parsed.scheme == "https" and parsed.netloc.lower() == "t.co" and bool(parsed.path)


def build_x_oembed_result(input_url: str, normalized_url: str, timeout: int, image_dir: str | None) -> dict[str, object]:
    status_code, payload, error = fetch_x_oembed(normalized_url, timeout)
    if not payload:
        attempts = [{"backend": "x_oembed", "http_status": status_code, "status": "Failed", "reason": error}]
        return build_generic_result(
            input_url,
            normalized_url,
            timeout,
            image_dir,
            fallback_error=error,
            previous_attempts=attempts,
        )

    oembed_html = str(payload.get("html") or "")
    markdown, links, published_at_text = markdown_from_x_oembed(oembed_html)
    source_url = str(payload.get("url") or normalized_url)
    title = str(payload.get("author_name") or "X post")
    status = "Extracted" if markdown else "Partial"
    status_reason = None if markdown else "X oEmbed returned metadata but no post paragraph text"
    oembed_attempt = {"backend": "x_oembed", "http_status": status_code, "status": status, "reason": status_reason}
    article_url = x_status_article_url(normalized_url)
    if article_url and is_tco_only_markdown(markdown):
        oembed_attempt["reason"] = "X oEmbed returned only a t.co link; trying the canonical Article URL"
        return build_generic_result(
            input_url,
            article_url,
            timeout,
            image_dir,
            fallback_error="X oEmbed returned only a t.co link; generic reader used for the canonical Article URL",
            previous_attempts=[oembed_attempt],
        )
    return {
        "schema_version": RESULT_SCHEMA_VERSION,
        "input_url": input_url,
        "normalized_url": normalized_url,
        "reader_backend": "x_oembed",
        "http_status": status_code,
        "reader_status": status,
        "status_reason": status_reason,
        "title": title,
        "source_url": source_url,
        "author_name": payload.get("author_name"),
        "author_url": payload.get("author_url"),
        "published_at_text": published_at_text,
        "markdown": markdown,
        "links": links,
        "image_links": [],
        "downloaded_images": [],
        "attempts": [oembed_attempt],
        "warnings": ["X oEmbed does not reliably expose attached media URLs."],
        "error": None,
        "raw_oembed": payload,
    }


def build_x_article_result(
    input_url: str,
    normalized_url: str,
    timeout: int,
    image_dir: str | None,
    previous_attempts: list[dict[str, object]] | None = None,
) -> dict[str, object]:
    return build_generic_result(
        input_url,
        normalized_url,
        timeout,
        image_dir,
        fallback_error="X Article is read through the generic reader",
        previous_attempts=previous_attempts,
    )


def post_generic_reader(url: str, timeout: int) -> tuple[int, str]:
    validate_public_http_url(url)
    data = urllib.parse.urlencode({"url": url}).encode("utf-8")
    request = urllib.request.Request(
        GENERIC_READER_ENDPOINT,
        data=data,
        method="POST",
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "codex-url-reader-skill/1.0",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read().decode("utf-8", errors="replace")
            return int(response.status), body
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        return int(exc.code), body


def classify_with_reason(status_code: int, body: str) -> tuple[str, str | None]:
    lowered = body.lower()
    if status_code >= 400:
        if status_code in {401, 403}:
            return "Blocked", f"HTTP {status_code} access denied"
        if status_code == 429:
            return "Blocked", "HTTP 429 rate limited"
        if status_code == 404:
            return "Failed", "HTTP 404 not found"
        if status_code >= 500:
            return "Failed", f"HTTP {status_code} upstream server error"
        return "Failed", f"HTTP {status_code} reader error"
    if "abusealleviationerror" in lowered or "anonymous access" in lowered:
        return "Blocked", "Reader reported anonymous access or abuse protection"
    if "log in" in lowered and "sign up" in lowered and len(body) < 3000:
        return "Blocked", "Likely login wall"
    if not body.strip():
        return "Failed", "Empty reader response"
    images = extract_images(body)
    markdown = markdown_content(body)
    useful_lines = [
        line.strip()
        for line in markdown.splitlines()
        if line.strip()
        and not line.strip().startswith("[")
        and not line.strip().startswith("!")
        and not line.strip().startswith("* * *")
    ]
    if len(useful_lines) >= 5:
        return "Extracted", None
    if useful_lines:
        return "Partial", "Only a small amount of useful text was extracted"
    if images:
        return "ImagesOnly", "Image links found but useful text was not extracted"
    return "Failed", "No useful text or image links were extracted"


def classify(status_code: int, body: str) -> str:
    status, _reason = classify_with_reason(status_code, body)
    return status


def first_match(pattern: re.Pattern[str], body: str) -> str | None:
    match = pattern.search(body)
    return match.group(1).strip() if match else None


def markdown_content(body: str) -> str:
    marker = "Markdown Content:"
    if marker not in body:
        return body.strip()
    return body.split(marker, 1)[1].strip()


def extract_images(body: str) -> list[dict[str, str]]:
    seen: set[str] = set()
    images: list[dict[str, str]] = []
    for alt, url in IMAGE_RE.findall(body):
        if url in seen:
            continue
        seen.add(url)
        images.append({"alt": alt.strip(), "url": url})
    return images


def extension_from_url(url: str, content_type: str | None) -> str:
    path = urllib.parse.urlparse(url).path
    suffix = Path(path).suffix.lower()
    if suffix in {".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif"}:
        return suffix
    if content_type:
        main = content_type.split(";", 1)[0].strip().lower()
        return {
            "image/jpeg": ".jpg",
            "image/png": ".png",
            "image/gif": ".gif",
            "image/webp": ".webp",
            "image/avif": ".avif",
        }.get(main, ".img")
    return ".img"


def download_images(
    images: list[dict[str, str]],
    output_dir: Path,
    timeout: int,
    max_bytes: int = MAX_IMAGE_BYTES,
) -> list[dict[str, str]]:
    output_dir.mkdir(parents=True, exist_ok=True)
    downloaded: list[dict[str, str]] = []
    for index, image in enumerate(images, start=1):
        url = image["url"]
        try:
            validate_public_http_url(url)
        except ReaderError as exc:
            downloaded.append({"url": url, "error": str(exc)})
            continue
        digest = hashlib.sha256(url.encode("utf-8")).hexdigest()[:12]
        request = urllib.request.Request(url, headers={"User-Agent": "codex-url-reader-skill/1.0"})
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                content_type = response.headers.get("Content-Type")
                content_length = response.headers.get("Content-Length")
                if content_length:
                    try:
                        if int(content_length) > max_bytes:
                            downloaded.append({"url": url, "error": f"Image exceeds max size of {max_bytes} bytes"})
                            continue
                    except ValueError:
                        pass
                if content_type and not content_type.split(";", 1)[0].strip().lower().startswith("image/"):
                    downloaded.append({"url": url, "error": f"Response is not an image: {content_type}"})
                    continue
                data = response.read(max_bytes + 1)
                if len(data) > max_bytes:
                    downloaded.append({"url": url, "error": f"Image exceeds max size of {max_bytes} bytes"})
                    continue
                ext = extension_from_url(url, content_type)
        except Exception as exc:  # noqa: BLE001 - keep per-image failures in output
            downloaded.append({"url": url, "error": str(exc)})
            continue
        path = output_dir / f"image-{index:02d}-{digest}{ext}"
        path.write_bytes(data)
        downloaded.append({"url": url, "path": str(path), "bytes": len(data), "alt": image.get("alt", "")})
        time.sleep(0.1)
    return downloaded


def build_generic_result(
    input_url: str,
    normalized_url: str,
    timeout: int,
    image_dir: str | None,
    fallback_error: str | None = None,
    previous_attempts: list[dict[str, object]] | None = None,
) -> dict[str, object]:
    status_code, body = post_generic_reader(normalized_url, timeout)
    images = extract_images(body)
    status, status_reason = classify_with_reason(status_code, body)
    if is_instagram_reel_url(normalized_url) and looks_like_instagram_login_wall(body):
        status = "Blocked"
        status_reason = "Instagram Reel resolved to a login wall; do not register or move automatically"
        images = []
    downloaded = download_images(images, Path(image_dir), timeout) if image_dir and status not in {"Blocked", "Failed"} else []
    error = None
    if status in {"Blocked", "Failed"} and body.lstrip().startswith("{"):
        try:
            parsed_error = json.loads(body)
            error = parsed_error.get("readableMessage") or parsed_error.get("message")
        except json.JSONDecodeError:
            error = body[:500]
    if status in {"Blocked", "Failed"} and not error:
        error = status_reason
    attempts = list(previous_attempts or [])
    attempts.append({"backend": "generic_reader", "http_status": status_code, "status": status, "reason": status_reason})
    warnings = [fallback_error] if fallback_error and status not in {"Blocked", "Failed"} else []
    return {
        "schema_version": RESULT_SCHEMA_VERSION,
        "input_url": input_url,
        "normalized_url": normalized_url,
        "reader_backend": "generic_reader",
        "http_status": status_code,
        "reader_status": status,
        "status_reason": status_reason,
        "title": first_match(TITLE_RE, body),
        "source_url": first_match(SOURCE_RE, body),
        "author_name": None,
        "author_url": None,
        "published_at_text": None,
        "markdown": markdown_content(body),
        "links": [],
        "image_links": images,
        "downloaded_images": downloaded,
        "attempts": attempts,
        "warnings": warnings,
        "error": error,
        "raw_oembed": None,
    }


def build_browser4_result(
    input_url: str,
    normalized_url: str,
    timeout: int,
    image_dir: str | None,
    previous_attempts: list[dict[str, object]],
    fallback_reason: str | None,
) -> dict[str, object]:
    capture = run_browser4(normalized_url, timeout)
    status = str(capture.get("status") or "Failed")
    reason = capture.get("reason")
    attempt: dict[str, object] = {
        "backend": "browser4",
        "http_status": None,
        "status": status,
        "reason": reason,
        "reader_url": normalized_url,
    }
    attempts = [*previous_attempts, attempt]
    if status in {"Blocked", "Failed"}:
        return {
            "schema_version": RESULT_SCHEMA_VERSION,
            "input_url": input_url,
            "normalized_url": normalized_url,
            "reader_backend": "browser4",
            "http_status": None,
            "reader_status": status,
            "status_reason": reason,
            "title": capture.get("title"),
            "source_url": normalized_url,
            "author_name": None,
            "author_url": None,
            "published_at_text": None,
            "markdown": str(capture.get("markdown") or ""),
            "links": capture.get("links") or [],
            "image_links": capture.get("image_links") or [],
            "downloaded_images": [],
            "attempts": attempts,
            "warnings": list(capture.get("warnings") or []),
            "error": reason,
            "raw_oembed": None,
        }

    images = list(capture.get("image_links") or [])
    downloaded = download_images(images, Path(image_dir), timeout) if image_dir and status not in {"Blocked", "Failed"} else []
    warnings = list(capture.get("warnings") or [])
    if fallback_reason:
        warnings.insert(0, f"Browser4 fallback was used after: {fallback_reason}")
    return {
        "schema_version": RESULT_SCHEMA_VERSION,
        "input_url": input_url,
        "normalized_url": normalized_url,
        "reader_backend": "browser4",
        "http_status": None,
        "reader_status": status,
        "status_reason": reason,
        "title": capture.get("title"),
        "source_url": normalized_url,
        "author_name": None,
        "author_url": None,
        "published_at_text": None,
        "markdown": str(capture.get("markdown") or ""),
        "links": capture.get("links") or [],
        "image_links": images,
        "downloaded_images": downloaded,
        "attempts": attempts,
        "warnings": warnings,
        "error": None,
        "raw_oembed": None,
    }


def should_use_browser4_result(original: dict[str, object], browser4: dict[str, object]) -> bool:
    browser_status = browser4.get("reader_status")
    if browser_status not in {"Extracted", "Partial", "ImagesOnly"}:
        return False
    original_status = original.get("reader_status")
    if browser_status == "Extracted" and original_status != "Extracted":
        return True
    if original_status in {"Failed", "Blocked", "ImagesOnly"} and browser_status in {"Partial", "ImagesOnly"}:
        return bool(browser4.get("markdown") or browser4.get("title") or browser4.get("image_links"))
    original_markdown = str(original.get("markdown") or "")
    browser_markdown = str(browser4.get("markdown") or "")
    return len(browser_markdown) > len(original_markdown)


def attach_browser_fallback_requirement(
    result: dict[str, object],
    canonical_url: str,
) -> dict[str, object]:
    """Expose the mandatory agent-level Browser handoff for incomplete public URLs."""
    if result.get("reader_status") != "Extracted":
        result["browser_fallback"] = {
            "required": True,
            "surface": "in_app_browser",
            "canonical_url": canonical_url,
            "reason": "Source content remains incomplete after url-reader backends",
        }
    else:
        result["browser_fallback"] = None
    return result


def apply_browser4_fallback(
    result: dict[str, object],
    input_url: str,
    normalized_url: str,
    timeout: int,
    image_dir: str | None,
) -> dict[str, object]:
    """Always try Browser4 for non-complete reads; keep the better evidence."""
    if result.get("reader_status") == "Extracted":
        return attach_browser_fallback_requirement(result, normalized_url)
    previous_attempts = list(result.get("attempts") or [])
    fallback_reason = str(result.get("error") or result.get("status_reason") or "previous reader did not provide complete content")
    browser4_result = build_browser4_result(
        input_url,
        normalized_url,
        timeout,
        image_dir,
        previous_attempts,
        fallback_reason,
    )
    browser_attempt = (browser4_result.get("attempts") or [])[-1]
    if should_use_browser4_result(result, browser4_result):
        return attach_browser_fallback_requirement(browser4_result, normalized_url)
    result["attempts"] = [*previous_attempts, browser_attempt]
    warnings = list(result.get("warnings") or [])
    browser_reason = browser4_result.get("status_reason") or browser4_result.get("error") or "no better content returned"
    warnings.append(f"Browser4 fallback did not improve the result: {browser_reason}")
    result["warnings"] = warnings
    return attach_browser_fallback_requirement(result, normalized_url)


DOMAIN_ROUTES = (
    {"backend": "generic_reader", "matches": is_x_article_url, "handler": build_x_article_result},
    {"backend": "x_oembed", "matches": is_x_status_url, "handler": build_x_oembed_result},
)


def build_result(input_url: str, timeout: int, image_dir: str | None) -> dict[str, object]:
    normalized_url = normalize_url(input_url)
    validate_public_http_url(normalized_url)
    for route in DOMAIN_ROUTES:
        if route["matches"](normalized_url):
            result = route["handler"](input_url, normalized_url, timeout, image_dir)
            fallback_url = str(result.get("normalized_url") or normalized_url)
            return apply_browser4_fallback(result, input_url, fallback_url, timeout, image_dir)
    result = build_generic_result(input_url, normalized_url, timeout, image_dir)
    return apply_browser4_fallback(result, input_url, normalized_url, timeout, image_dir)


def main() -> int:
    parser = argparse.ArgumentParser(description="Read a URL through the configured reader path.")
    parser.add_argument("url", help="Original target URL. Repeated reader-service prefixes are unwrapped automatically.")
    parser.add_argument("--json", action="store_true", help="Print full JSON output.")
    parser.add_argument("--download-images", metavar="DIR", help="Download extracted image URLs into DIR.")
    parser.add_argument("--timeout", type=int, default=30, help="Network timeout in seconds.")
    parser.add_argument("--max-markdown-chars", type=int, default=4000, help="Markdown preview length for non-JSON output.")
    args = parser.parse_args()

    try:
        result = build_result(args.url, args.timeout, args.download_images)
    except Exception as exc:  # noqa: BLE001 - CLI should report structured failure
        result = {
            "schema_version": RESULT_SCHEMA_VERSION,
            "input_url": args.url,
            "normalized_url": unwrap_reader_url(args.url),
            "reader_backend": None,
            "http_status": None,
            "reader_status": "Failed",
            "status_reason": "Unhandled reader exception",
            "title": None,
            "source_url": None,
            "author_name": None,
            "author_url": None,
            "published_at_text": None,
            "markdown": "",
            "links": [],
            "image_links": [],
            "downloaded_images": [],
            "attempts": [],
            "warnings": [],
            "browser_fallback": None,
            "error": str(exc),
            "raw_oembed": None,
        }

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result["reader_status"] != "Failed" else 1

    print(f"Status: {result['reader_status']}")
    print(f"Backend: {result.get('reader_backend') or ''}")
    print(f"Title: {result['title'] or ''}")
    print(f"Source: {result['source_url'] or result['normalized_url']}")
    if result.get("published_at_text"):
        print(f"Published: {result['published_at_text']}")
    if result["error"]:
        print(f"Error: {result['error']}")
    print(f"Images: {len(result['image_links'])}")
    for item in result["image_links"][:10]:
        print(f"- {item.get('alt', '')}: {item['url']}")
    if result["downloaded_images"]:
        print("Downloaded:")
        for item in result["downloaded_images"]:
            print(f"- {item.get('path') or item.get('error')}")
    markdown = str(result["markdown"])
    if markdown:
        print("\nMarkdown Preview:")
        print(markdown[: args.max_markdown_chars])
    return 0 if result["reader_status"] != "Failed" else 1


if __name__ == "__main__":
    sys.exit(main())
