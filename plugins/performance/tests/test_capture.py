import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import capture
import hook_collect


EVENTS = [dict(type='thread.started', thread_id='test'), dict(type='turn.started'),
          dict(type='turn.completed', usage=dict(input_tokens=100, cached_input_tokens=20, output_tokens=3))]


class CaptureTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.store = self.root / 'ledger'

    def invoke(self, text, exit_code=0, **kwargs):
        command = [sys.executable, '-c', 'import sys; sys.stdout.write(' + repr(text) +
                   '); sys.stdout.flush(); sys.exit(' + repr(exit_code) + ')']
        return capture.run(command, 'codex-exec', self.store, **kwargs)

    def test_collects_after_exit_and_matches_usage(self):
        result = self.invoke(''.join(json.dumps(e) + '\n' for e in EVENTS))
        self.assertEqual(result['status'], 'collected')
        self.assertEqual(result['producer_exit_code'], 0)
        self.assertEqual(result['report']['groups'][0]['usage'], EVENTS[-1]['usage'])
        self.assertEqual(result['quality'], 'unmeasured')
        self.assertEqual(set(p.name for p in self.store.iterdir()), {'.lock', 'state.json'})

    def test_nonzero_exit_keeps_known_usage_without_success_claim(self):
        result = self.invoke(''.join(json.dumps(e) + '\n' for e in EVENTS), 7)
        self.assertEqual(result['status'], 'producer_failed')
        self.assertEqual(result['producer_exit_code'], 7)
        self.assertEqual(result['report']['groups'][0]['usage']['input_tokens'], 100)

    def test_missing_terminal_and_partial_line_fail(self):
        for n, text in enumerate(['', json.dumps(EVENTS[0]) + '\n',
             ''.join(json.dumps(e) + '\n' for e in EVENTS[:-1]),
             ''.join(json.dumps(e) + '\n' for e in EVENTS) + '{']):
            self.store = self.root / str(n)
            self.assertEqual(self.invoke(text)['status'], 'capture_failed')

    def test_multichunk_drain(self):
        padding = json.dumps({'type': 'item.completed', 'item': {'text': 'x' * 400}}) + '\n'
        result = capture.run(
            [sys.executable, '-c', 'import json; print(json.dumps(' + repr(EVENTS[0]) +
             ')); print(json.dumps(' + repr(EVENTS[1]) + ')); print(' + repr(padding) +
             '*3000,end=""); print(json.dumps(' + repr(EVENTS[-1]) + '))'], 'codex-exec', self.store)
        self.assertEqual(result['status'], 'collected')
        self.assertGreater(result['report']['metrics']['attempts'], 1)

    def test_limit_timeout_and_spawn_failure(self):
        self.assertEqual(self.invoke('x' * 1000, max_bytes=100)['status'], 'capture_failed')
        for name, command in [('timeout', [sys.executable, '-c', 'import time; time.sleep(5)']),
                              ('missing', ['/nonexistent/performance-producer'])]:
            result = capture.run(command, 'codex-exec', self.root / name, timeout=0.1)
            self.assertEqual(result['status'], 'capture_failed')

    def test_existing_store_is_not_modified(self):
        self.store.mkdir()
        marker = self.store / 'owned'
        marker.write_text('keep')
        with self.assertRaises(FileExistsError):
            self.invoke('')
        self.assertEqual(marker.read_text(), 'keep')

    def test_claude_result_adapter(self):
        event = dict(type='result', subtype='success', is_error=False, usage=dict(input_tokens=10,
            cache_creation_input_tokens=5, cache_read_input_tokens=3, output_tokens=2))
        result = capture.run([sys.executable, '-c', 'print(' + repr(json.dumps(event)) + ')'],
                             'claude-query', self.store)
        self.assertEqual(result['status'], 'collected')
        self.assertEqual(result['report']['groups'][0]['usage']['input_tokens'], 18)

    def test_anonymous_file_and_empty_argument(self):
        real_drain = capture.drain
        seen = []
        def checked_drain(store, source, adapter, stream_id):
            seen.append(os.fstat(source).st_nlink)
            result = real_drain(store, source, adapter, stream_id)
            os.fstat(source)  # collector closed only its duplicate, not the owner's FD.
            return result
        text = ''.join(json.dumps(e) + '\n' for e in EVENTS)
        command = [sys.executable, '-c', 'import sys; assert sys.argv[1] == ""; print(' +
                   repr(text) + ', end="")', '']
        with patch.object(capture, 'drain', side_effect=checked_drain):
            result = capture.run(command, 'codex-exec', self.store)
        self.assertEqual(result['status'], 'collected')
        self.assertEqual(seen, [0])

    def test_codex_session_end_skips_workers_but_stop_remains_available(self):
        config = dict(enabled=True, host='codex', cwd=str(self.root),
            adapter='codex-exec', input=str(self.root / 'input'), stream_id='test',
            store=str(self.store), retention_days=30)
        event = dict(hook_event_name='SessionEnd', cwd=str(self.root))
        self.assertIsNone(hook_collect.command(config, event))
        self.assertIsNotNone(hook_collect.command(config, event | {'hook_event_name': 'Stop'}))
        self.assertIsNotNone(hook_collect.command(config | {'host': 'claude'}, event))


if __name__ == '__main__':
    unittest.main()
