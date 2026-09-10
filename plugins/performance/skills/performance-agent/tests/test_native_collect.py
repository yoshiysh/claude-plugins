import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import native_collect as native


def claude(output=3, ident="secret-message", **overrides):
    usage = {"input_tokens": 10, "cache_creation_input_tokens": 5,
             "cache_read_input_tokens": 7, "output_tokens": output} | overrides
    return {"type": "assistant", "message": {"id": ident, "model": "private-model",
            "content": "private-prompt", "usage": usage}}


def codex(input_tokens=100, cached=40, output=10):
    return {"type": "event_msg", "payload": {"type": "token_count", "info": {
        "total_token_usage": {"input_tokens": input_tokens,
                              "cached_input_tokens": cached, "output_tokens": output}}}}


class NativeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.source = Path(self.temp.name) / "private-username.jsonl"
        self.store = Path(self.temp.name) / "ledger"

    def write(self, *rows, tail=b""):
        self.source.write_bytes(b"".join(json.dumps(row).encode() + b"\n" for row in rows) + tail)

    def collect(self, host="claude", session="secret-session"):
        return native.collect(host, self.source, session, self.store)

    def test_claude_dedup_cache_privacy_repeat(self):
        self.write(claude(1), claude(3), claude(3))
        result = self.collect()
        self.assertEqual(result["usage"], {"input_tokens": 22, "cached_input_tokens": 7, "output_tokens": 3})
        self.assertEqual(result["observed_usage_records"], 1)
        self.assertEqual(result["duplicate_updates"], 2)
        self.assertEqual(self.collect()["usage"], result["usage"])
        saved = (self.store / "state.json").read_text()
        for secret in ("secret-session", "secret-message", "private-model", "private-prompt", str(self.source)):
            self.assertNotIn(secret, saved)
        self.assertIsNone(native.report(self.store)["measurement_complete"])
        self.assertEqual(result["quality"], "unmeasured")

    def test_codex_cumulative_not_added(self):
        self.write(codex(), codex(120, 50, 15), codex(120, 50, 15))
        result = self.collect("codex")
        self.assertEqual(result["usage"]["input_tokens"], 120)
        self.assertEqual(result["observed_usage_records"], 1)
        self.assertEqual(self.collect("codex")["usage"], result["usage"])

    def test_regression_within_and_across_collections(self):
        self.write(codex(), codex(99))
        with self.assertRaisesRegex(ValueError, "regression"):
            self.collect("codex")
        self.write(codex())
        self.collect("codex")
        self.write(codex(99))
        with self.assertRaisesRegex(ValueError, "regression"):
            self.collect("codex")
        self.assertEqual(native.report(self.store)["usage"]["input_tokens"], 100)

    def test_malformed_known_usage_rejected_not_zero(self):
        for row, host in ((claude(output_tokens=True), "claude"),
                          (claude(input_tokens=-1), "claude"), (codex(cached=101), "codex"),
                          ({"type": "assistant", "message": {"id": "x", "usage": {}}}, "claude")):
            with self.subTest(row=row):
                self.write(row)
                with self.assertRaises(ValueError):
                    self.collect(host)
        self.assertFalse(self.store.exists())

    def test_claude_components_cannot_regress_even_if_total_grows(self):
        self.write(claude())
        self.collect()
        self.write(claude(input_tokens=9, cache_creation_input_tokens=100))
        with self.assertRaisesRegex(ValueError, "regression"):
            self.collect()

    def test_incomplete_tail_explicit_and_unknown_events_ignored(self):
        self.write({"type": "user", "body": "private"}, claude(), tail=b'{"type":')
        result = self.collect()
        self.assertEqual(result["incomplete_sources"], 1)
        self.assertEqual(result["observed_usage_records"], 1)

    def test_missing_usage_not_claimed_zero(self):
        self.write({"type": "assistant", "message": {"id": "x"}})
        result = self.collect()
        self.assertIsNone(result["usage"])
        self.assertEqual(result["missing_usage_events"], 1)

    def test_symlink_fifo_and_limit(self):
        target = Path(self.temp.name) / "target"
        target.write_text("{}\n")
        self.source.symlink_to(target)
        with self.assertRaises(OSError):
            self.collect()
        self.source.unlink()
        os.mkfifo(self.source)
        with self.assertRaisesRegex(ValueError, "unsafe_source"):
            self.collect()
        self.source.unlink()
        self.write(claude())
        with patch.object(native, "MAX_BYTES", 1):
            result = self.collect()
            self.assertEqual(result["status"], "censored")
            self.assertEqual(result["reason"], "source_limit")
            self.assertEqual(result["censored_sessions"], 1)
        # 上限内で観測できたら打ち切り記録は解消され、以後の report からも消える
        recovered = self.collect()
        self.assertEqual(recovered["status"], "collected")
        self.assertEqual(recovered["censored_sessions"], 0)

    def test_retention_and_capacity(self):
        self.write(claude())
        with patch.object(native.time, "time", return_value=10000000):
            self.collect(session="one")
            with patch.object(native, "MAX_SESSIONS", 1):
                self.assertEqual(self.collect(session="two")["capacity_evictions"], 1)
        with patch.object(native.time, "time", return_value=10000000 + 31 * 86400):
            self.assertEqual(native.report(self.store)["retained_sessions"], 0)


if __name__ == "__main__":
    unittest.main()
