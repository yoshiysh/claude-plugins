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

    def test_normalizes_x_article_and_derives_status_url(self):
        normalized = read_url.normalize_url(
            "https://mobile.x.com/claudecode84/article/2072546601789428152?ref=share"
        )
        self.assertEqual(normalized, "https://x.com/claudecode84/article/2072546601789428152")
        self.assertEqual(
            read_url.x_article_status_url(normalized),
            "https://x.com/claudecode84/status/2072546601789428152",
        )

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
        markdown = """# Recovered Article

Article body line one.
Article body line two.
Article body line three.
Article body line four.
Article body line five.
"""
        with (
            mock.patch.object(read_url, "fetch_x_oembed", return_value=(200, payload, None)),
            mock.patch.object(read_url, "fetch_tweet_markdown", return_value=(200, markdown)),
        ):
            result = read_url.build_result("https://x.com/0xMoysei/status/2072808742274392194", 5, None)

        self.assertEqual(result["reader_backend"], "tweet_md")
        self.assertEqual(result["normalized_url"], "https://x.com/0xMoysei/article/2072808742274392194")
        self.assertEqual(result["source_url"], "https://x.com/0xMoysei/article/2072808742274392194")
        self.assertEqual(result["attempts"][0]["backend"], "x_oembed")
        self.assertEqual(result["attempts"][1]["reader_url"], "https://x.com/0xMoysei/status/2072808742274392194")

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

    def test_x_article_uses_tweet_md_and_preserves_article_source_url(self):
        markdown = """# Example X Article

![Cover image](https://pbs.twimg.com/media/example.jpg)

Article body line one.
Article body line two.
Article body line three.
Article body line four.
Article body line five.
"""
        with mock.patch.object(read_url, "fetch_tweet_markdown", return_value=(200, markdown)):
            result = read_url.build_result("https://x.com/example/article/123456789", 5, None)

        self.assertEqual(result["reader_backend"], "tweet_md")
        self.assertEqual(result["reader_status"], "Extracted")
        self.assertEqual(result["title"], "Example X Article")
        self.assertEqual(result["source_url"], "https://x.com/example/article/123456789")
        self.assertEqual(result["image_links"], [{"alt": "Cover image", "url": "https://pbs.twimg.com/media/example.jpg"}])
        self.assertEqual(result["attempts"][0]["reader_url"], "https://x.com/example/status/123456789")

    def test_x_article_falls_back_to_generic_reader_when_tweet_md_fails(self):
        generic_body = """Title: Fallback Article
URL Source: https://x.com/example/article/123456789

Markdown Content:
Fallback Article body.
"""
        with (
            mock.patch.object(read_url, "fetch_tweet_markdown", return_value=(503, "unavailable")),
            mock.patch.object(read_url, "post_generic_reader", return_value=(200, generic_body)),
        ):
            result = read_url.build_result("https://x.com/example/article/123456789", 5, None)

        self.assertEqual(result["reader_backend"], "generic_reader")
        self.assertEqual(result["attempts"][0]["backend"], "tweet_md")
        self.assertEqual(result["attempts"][1]["backend"], "generic_reader")

    def test_x_article_does_not_treat_i_as_an_author_handle(self):
        markdown = """# Example X Article

Article body line one.
Article body line two.
Article body line three.
Article body line four.
Article body line five.
"""
        with mock.patch.object(read_url, "fetch_tweet_markdown", return_value=(200, markdown)):
            result = read_url.build_result("https://x.com/i/article/123456789", 5, None)

        self.assertEqual(result["author_name"], None)
        self.assertEqual(result["author_url"], None)


if __name__ == "__main__":
    unittest.main()
