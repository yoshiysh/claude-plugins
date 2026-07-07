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


if __name__ == "__main__":
    unittest.main()
