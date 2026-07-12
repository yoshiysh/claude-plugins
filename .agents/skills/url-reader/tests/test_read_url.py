import importlib.util
import unittest
from pathlib import Path
from unittest import mock


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "scripts" / "read_url.py"
SPEC = importlib.util.spec_from_file_location("read_url", SCRIPT_PATH)
read_url = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(read_url)


class UrlReaderTests(unittest.TestCase):
    def test_normalizes_twitter_status_to_x_without_tracking_query(self):
        normalized = read_url.normalize_url("https://mobile.twitter.com/nikkei/status/1524011459130314752?s=12")
        self.assertEqual(normalized, "https://x.com/nikkei/status/1524011459130314752")

    def test_normalizes_web_status_to_x_i_status(self):
        normalized = read_url.normalize_url("https://twitter.com/i/web/status/1524011459130314752")
        self.assertEqual(normalized, "https://x.com/i/status/1524011459130314752")

    def test_normalizes_x_article_without_deriving_status_url(self):
        normalized = read_url.normalize_url(
            "https://mobile.x.com/claudecode84/article/2072546601789428152?ref=share"
        )
        self.assertEqual(normalized, "https://x.com/claudecode84/article/2072546601789428152")
        self.assertTrue(read_url.is_x_article_url(normalized))

    def test_rejects_private_urls_before_backend_fetch(self):
        with self.assertRaises(read_url.ReaderError):
            read_url.validate_public_http_url("http://127.0.0.1:3000/private")

    def test_x_oembed_result_has_stable_contract_fields(self):
        payload = {
            "url": "https://x.com/nikkei/status/1524011459130314752",
            "author_name": "Nikkei",
            "author_url": "https://x.com/nikkei",
            "html": (
                '<blockquote><p lang="ja">post body '
                '<a href="https://t.co/example">https://t.co/example</a></p>'
                '<a href="https://x.com/nikkei/status/1524011459130314752">May 10, 2022</a></blockquote>'
            ),
        }
        with mock.patch.object(read_url, "fetch_x_oembed", return_value=(200, payload, None)):
            result = read_url.build_result("https://twitter.com/nikkei/status/1524011459130314752?s=12", 5, None)

        self.assertEqual(result["schema_version"], "1.0")
        self.assertEqual(result["normalized_url"], "https://x.com/nikkei/status/1524011459130314752")
        self.assertEqual(result["reader_backend"], "x_oembed")
        self.assertEqual(result["reader_status"], "Extracted")
        self.assertEqual(result["author_name"], "Nikkei")
        self.assertIn("post body", result["markdown"])
        self.assertEqual(result["image_links"], [])
        self.assertTrue(result["attempts"])
        self.assertIn("warnings", result)

    def test_x_status_with_tco_only_body_recovers_canonical_article(self):
        payload = {
            "url": "https://x.com/0xMoysei/status/2072808742274392194",
            "author_name": "Moysei",
            "author_url": "https://x.com/0xMoysei",
            "html": (
                '<blockquote><p><a href="https://t.co/fuFoYMVO93">https://t.co/fuFoYMVO93</a></p>'
                '<a href="https://x.com/0xMoysei/status/2072808742274392194">July 2, 2026</a></blockquote>'
            ),
        }
        generic_body = """Title: Recovered Article
URL Source: https://x.com/0xMoysei/article/2072808742274392194

Markdown Content:
Article body line one.
Article body line two.
Article body line three.
Article body line four.
Article body line five.
"""
        with (
            mock.patch.object(read_url, "fetch_x_oembed", return_value=(200, payload, None)),
            mock.patch.object(read_url, "post_generic_reader", return_value=(200, generic_body)),
        ):
            result = read_url.build_result("https://x.com/0xMoysei/status/2072808742274392194", 5, None)

        self.assertEqual(result["reader_backend"], "generic_reader")
        self.assertEqual(result["normalized_url"], "https://x.com/0xMoysei/article/2072808742274392194")
        self.assertEqual(result["source_url"], "https://x.com/0xMoysei/article/2072808742274392194")
        self.assertEqual(result["attempts"][0]["backend"], "x_oembed")
        self.assertEqual(result["attempts"][1]["backend"], "generic_reader")

    def test_instagram_reel_login_wall_is_blocked(self):
        body = """Title: Instagram
URL Source: https://www.instagram.com/reel/Cg_nrIBvg7k/

Markdown Content:
See everyday moments from your close friends.
![Image 1](https://static.cdninstagram.com/login.webp)
Log into Instagram
Mobile number, username or email
Log in with Facebook
"""
        with mock.patch.object(read_url, "post_generic_reader", return_value=(200, body)):
            result = read_url.build_result("https://www.instagram.com/reel/Cg_nrIBvg7k/?igshid=x", 5, None)

        self.assertEqual(result["reader_status"], "Blocked")
        self.assertIn("Instagram Reel", result["status_reason"])
        self.assertEqual(result["image_links"], [])
        self.assertEqual(result["downloaded_images"], [])

    def test_x_article_uses_generic_reader_and_preserves_article_source_url(self):
        generic_body = """Title: Example X Article
URL Source: https://x.com/example/article/123456789

Markdown Content:
![Cover image](https://pbs.twimg.com/media/example.jpg)

Article body line one.
Article body line two.
Article body line three.
Article body line four.
Article body line five.
"""
        with mock.patch.object(read_url, "post_generic_reader", return_value=(200, generic_body)):
            result = read_url.build_result("https://x.com/example/article/123456789", 5, None)

        self.assertEqual(result["reader_backend"], "generic_reader")
        self.assertEqual(result["reader_status"], "Extracted")
        self.assertEqual(result["title"], "Example X Article")
        self.assertEqual(result["source_url"], "https://x.com/example/article/123456789")
        self.assertEqual(result["image_links"], [{"alt": "Cover image", "url": "https://pbs.twimg.com/media/example.jpg"}])

    def test_x_article_does_not_treat_i_as_an_author_handle(self):
        generic_body = """Title: Example X Article
URL Source: https://x.com/i/article/123456789

Markdown Content:
Article body line one.
Article body line two.
Article body line three.
Article body line four.
Article body line five.
"""
        with mock.patch.object(read_url, "post_generic_reader", return_value=(200, generic_body)):
            result = read_url.build_result("https://x.com/i/article/123456789", 5, None)

        self.assertEqual(result["reader_backend"], "generic_reader")
        self.assertEqual(result["author_name"], None)
        self.assertEqual(result["author_url"], None)

    def test_incomplete_x_article_requires_in_app_browser_fallback(self):
        with (
            mock.patch.object(read_url, "post_generic_reader", return_value=(403, "blocked")),
            mock.patch.object(
                read_url,
                "run_browser4",
                return_value={"status": "Failed", "reason": "browser4-cli is not installed"},
            ),
        ):
            result = read_url.build_result("https://x.com/example/article/123456789", 5, None)

        self.assertEqual(result["reader_status"], "Blocked")
        self.assertEqual(
            result["browser_fallback"],
            {
                "required": True,
                "surface": "in_app_browser",
                "canonical_url": "https://x.com/example/article/123456789",
                "reason": "Source content remains incomplete after url-reader backends",
            },
        )

    def test_complete_x_article_does_not_request_in_app_browser(self):
        generic_body = """Title: Complete Article
URL Source: https://x.com/example/article/123456789

Markdown Content:
Article body line one.
Article body line two.
Article body line three.
Article body line four.
Article body line five.
"""
        with mock.patch.object(read_url, "post_generic_reader", return_value=(200, generic_body)):
            result = read_url.build_result("https://x.com/example/article/123456789", 5, None)

        self.assertIsNone(result["browser_fallback"])

    def test_incomplete_public_page_requires_in_app_browser_fallback(self):
        with (
            mock.patch.object(read_url, "post_generic_reader", return_value=(403, "blocked")),
            mock.patch.object(
                read_url,
                "run_browser4",
                return_value={"status": "Failed", "reason": "browser4-cli is not installed"},
            ),
        ):
            result = read_url.build_result("https://example.com/article", 5, None)

        self.assertEqual(result["reader_status"], "Blocked")
        self.assertEqual(result["browser_fallback"]["required"], True)
        self.assertEqual(result["browser_fallback"]["surface"], "in_app_browser")
        self.assertEqual(result["browser_fallback"]["canonical_url"], "https://example.com/article")

    def test_browser4_fallback_promotes_better_public_page_content(self):
        with (
            mock.patch.object(read_url, "post_generic_reader", return_value=(503, "unavailable")),
            mock.patch.object(
                read_url,
                "run_browser4",
                return_value={
                    "status": "Extracted",
                    "reason": None,
                    "title": "Browser Article",
                    "markdown": "\n".join(["Browser Article"] + [f"Article line {i}" for i in range(1, 6)]),
                    "links": [{"text": "Source", "url": "https://example.com/source"}],
                    "image_links": [{"alt": "Cover", "url": "https://example.com/cover.jpg"}],
                    "warnings": ["Browser4 did not expose the source HTTP status."],
                },
            ),
        ):
            result = read_url.build_result("https://example.com/article", 5, None)

        self.assertEqual(result["reader_backend"], "browser4")
        self.assertEqual(result["reader_status"], "Extracted")
        self.assertEqual(result["attempts"][0]["backend"], "generic_reader")
        self.assertEqual(result["attempts"][1]["backend"], "browser4")
        self.assertIn("Browser4 fallback was used", result["warnings"][0])

    def test_browser4_failure_is_recorded_without_replacing_original_result(self):
        generic_body = """Title: Generic fallback
URL Source: https://example.com/article

Markdown Content:
Short but useful title context.
"""
        with (
            mock.patch.object(read_url, "post_generic_reader", return_value=(200, generic_body)),
            mock.patch.object(
                read_url,
                "run_browser4",
                return_value={"status": "Failed", "reason": "browser4-cli is not installed"},
            ),
        ):
            result = read_url.build_result("https://example.com/article", 5, None)

        self.assertEqual(result["reader_backend"], "generic_reader")
        self.assertEqual(result["reader_status"], "Partial")
        self.assertEqual(result["attempts"][-1]["backend"], "browser4")
        self.assertIn("did not improve", result["warnings"][-1])

    def test_browser4_html_parser_extracts_public_links_and_images(self):
        links, images = read_url.parse_browser4_html(
            "https://example.com/article",
            '<a href="/source">Source</a><img src="/cover.jpg" alt="Cover">'
            '<script><img src="https://example.com/ignored.jpg"></script>',
        )

        self.assertEqual(links, [{"text": "Source", "url": "https://example.com/source"}])
        self.assertEqual(images, [{"alt": "Cover", "url": "https://example.com/cover.jpg"}])

    def test_browser4_focus_removes_navigation_and_recommendations(self):
        focused = read_url._focus_browser4_content(
            "Article title",
            """Home
Login
Article title
Article title
Article paragraph.
Recommended
Other article
""",
        )

        self.assertEqual(focused, "Article title\nArticle paragraph.")


if __name__ == "__main__":
    unittest.main()
