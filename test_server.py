import unittest
import io
import json
import shlex
from email.message import Message
from types import SimpleNamespace
from unittest.mock import patch, Mock
from subprocess import CompletedProcess

import server


class ClearHostTest(unittest.TestCase):
    def remote_clear(self, snapshots, failures=None, sleeps=None):
        calls = iter(snapshots)
        failed = failures or set()
        last_pids = []
        elapsed = 0
        def query(*args, **kwargs):
            nonlocal last_pids
            pids = next(calls, last_pids)
            last_pids = pids
            xml = '<nvidia_smi_log><gpu><processes>' + ''.join(
                f'<process_info><pid>{pid}</pid></process_info>' for pid in pids
            ) + '</processes></gpu></nvidia_smi_log>'
            return CompletedProcess([], 0, stdout=xml)
        def send(handle, sig):
            if handle in failed:
                raise PermissionError('permission denied')
        def sleep(seconds):
            nonlocal elapsed
            elapsed += seconds
            if sleeps is not None:
                sleeps.append(seconds)
        output = io.StringIO()
        with patch.object(server.subprocess, 'run', side_effect=query), \
                patch('os.pidfd_open', create=True, side_effect=lambda pid: pid), \
                patch('os.close') as close, \
                patch('signal.pidfd_send_signal', create=True, side_effect=send) as signal, \
                patch('time.sleep', side_effect=sleep), \
                patch('time.monotonic', side_effect=lambda: elapsed), patch('sys.stdout', output):
            exec(shlex.split(server.CLEAR_CMD)[2], {})
        return json.loads(output.getvalue()), signal, close

    def test_deduplicates_and_rechecks_membership(self):
        result, signal, close = self.remote_clear([[101, 101, 102], [101], []])
        self.assertTrue(result['ok'])
        self.assertEqual(result['killed'], [101])
        signal.assert_called_once()
        self.assertEqual(signal.call_args.args[0], 101)
        self.assertEqual(close.call_count, 2)

    def test_permission_failure_and_restart_are_reported(self):
        result, _, _ = self.remote_clear([[101, 102], [101, 102], [102, 103]], {102})
        self.assertFalse(result['ok'])
        self.assertEqual(result['killed'], [101])
        self.assertEqual(result['failed'][0]['pid'], 102)
        self.assertEqual(result['remaining'], [102, 103])

    def test_waits_for_delayed_release_and_returns_early(self):
        sleeps = []
        result, signal, _ = self.remote_clear([[101], [101], [101], [101], []], sleeps=sleeps)
        self.assertTrue(result['ok'])
        self.assertEqual(result['remaining'], [])
        self.assertEqual(sleeps, [5, 5])
        signal.assert_called_once()

    def test_waits_three_minutes_without_killing_again(self):
        sleeps = []
        result, signal, _ = self.remote_clear([[101], [101], [102]], sleeps=sleeps)
        self.assertFalse(result['ok'])
        self.assertEqual(result['remaining'], [102])
        self.assertEqual(sleeps, [5] * 36)
        signal.assert_called_once()

    def test_invalid_pid_stops_without_signals(self):
        for pid in ('1', '-1', '101;echo bad', 'N/A'):
            with self.subTest(pid=pid):
                result, signal, _ = self.remote_clear([[pid]])
                self.assertFalse(result['ok'])
                self.assertTrue(result['error'])
                signal.assert_not_called()

    def test_empty_host_and_exited_process(self):
        result, signal, _ = self.remote_clear([[], []])
        self.assertTrue(result['ok'])
        signal.assert_not_called()
        with patch('os.pidfd_open', create=True, side_effect=ProcessLookupError):
            with patch.object(server.subprocess, 'run', return_value=CompletedProcess(
                    [], 0, stdout='<nvidia_smi_log><gpu><processes><process_info><pid>101</pid>'
                    '</process_info></processes></gpu></nvidia_smi_log>')), \
                    patch('signal.pidfd_send_signal', create=True) as signal, \
                    patch('sys.stdout', new_callable=io.StringIO) as output:
                exec(shlex.split(server.CLEAR_CMD)[2], {})
        result = json.loads(output.getvalue())
        signal.assert_not_called()
        self.assertEqual(result['remaining'], [101])

    def test_remote_query_failure_stops_without_signals(self):
        with patch.object(server.subprocess, 'run', side_effect=FileNotFoundError('no nvidia-smi')), \
                patch('signal.pidfd_send_signal', create=True) as signal, \
                patch('sys.stdout', new_callable=io.StringIO) as output:
            exec(shlex.split(server.CLEAR_CMD)[2], {})
        self.assertFalse(json.loads(output.getvalue())['ok'])
        signal.assert_not_called()

    def test_api_confirmation_and_page_token(self):
        valid = {'host': 'test-host', 'confirmation': 'test-host'}
        for body, origin, token, content_type, expected in (
                (valid, 'http://localhost:8799', server.CLEAR_TOKEN, 'application/json', 200),
                (valid, 'https://monitor.example', server.CLEAR_TOKEN, 'application/json', 200),
                (valid, None, server.CLEAR_TOKEN, 'application/json', 200),
                (valid, 'http://evil.example', None, 'application/json', 403),
                (valid, 'http://localhost:8799', 'wrong-token', 'application/json', 403),
                (valid, None, server.CLEAR_TOKEN, 'text/plain', 400),
                ({'host': 'test-host', 'confirmation': 'wrong'}, None, server.CLEAR_TOKEN, 'application/json', 400),
                ({'host': 'unknown', 'confirmation': 'unknown'}, None, server.CLEAR_TOKEN, 'application/json', 400),
                ({'host': '-oProxyCommand=bad', 'confirmation': '-oProxyCommand=bad'}, None, server.CLEAR_TOKEN, 'application/json', 400),
                ([], None, server.CLEAR_TOKEN, 'application/json', 400)):
            with self.subTest(body=body, origin=origin, token=token):
                headers = Message()
                headers['Content-Type'] = content_type
                headers['Host'] = 'localhost:8799'
                if origin:
                    headers['Origin'] = origin
                if token:
                    headers['X-GPUMon-Token'] = token
                handler = SimpleNamespace(path='/api/hosts/clear', headers=headers,
                                          _body=lambda: body, _json=Mock())
                with patch.object(server, 'load_entries', return_value=[{'host': 'test-host'}]), \
                        patch.object(server, 'clear_host', return_value={'ok': True}) as clear:
                    server.Handler.do_POST(handler)
                code = handler._json.call_args.args[1] if len(handler._json.call_args.args) > 1 else 200
                self.assertEqual(code, expected)
                self.assertEqual(clear.call_count, int(expected == 200))

    def test_page_contains_current_token(self):
        for path in ('/', '/tasks', '/common.js', '/app.js', '/tasks.js', '/style.css'):
            handler = SimpleNamespace(path=path, send_response=Mock(), send_header=Mock(),
                                      end_headers=Mock(), wfile=io.BytesIO())
            server.Handler.do_GET(handler)
            page = handler.wfile.getvalue()
            self.assertNotIn(b'__GPUMON_CLEAR_TOKEN__', page)
        handler = SimpleNamespace(path='/common.js', send_response=Mock(), send_header=Mock(),
                                  end_headers=Mock(), wfile=io.BytesIO())
        server.Handler.do_GET(handler)
        self.assertIn(server.CLEAR_TOKEN.encode(), handler.wfile.getvalue())

    def test_ssh_errors_and_result(self):
        with patch.object(server.subprocess, 'run', return_value=CompletedProcess(
                [], 0, stdout='{"ok": true, "killed": [101]}')) as run:
            self.assertTrue(server.clear_host('test-host')['ok'])
            self.assertEqual(run.call_args.args[0][-3:], ['--', 'test-host', server.CLEAR_CMD])
            self.assertEqual(run.call_args.kwargs['timeout'], 240)
        for response in (CompletedProcess([], 1, stdout='', stderr='denied'),
                         CompletedProcess([], 0, stdout='invalid')):
            with patch.object(server.subprocess, 'run', return_value=response):
                self.assertFalse(server.clear_host('test-host')['ok'])


GPU = "0, GPU-test, NVIDIA Test, 50, 2048, 8192, 60, 100\n"
PROCS = "GPU-test, 101, /usr/bin/python, 1024\nGPU-test, 102, worker, 1024\n"


class ContainerNamesTest(unittest.TestCase):
    def test_elapsed_seconds(self):
        output = (GPU + "__GPUMON_P__\n" + PROCS
                  + "__GPUMON_D__\n__GPUMON_C__\n__GPUMON_E__\n"
                  + "  101 183600\n  102 0\ninvalid output\n101 -1\n101 NaN\n")
        with patch.object(server.subprocess, "run", return_value=CompletedProcess(
                [], 0, stdout=output, stderr="")):
            result = server.query_host("test-host")
        self.assertTrue(result["ok"])
        self.assertEqual([p["elapsed_seconds"] for p in result["gpus"][0]["procs"]],
                         [183600, 0])

    def test_missing_elapsed_seconds(self):
        for tail in ("", "__GPUMON_D__\n__GPUMON_C__\n__GPUMON_E__\n"):
            with self.subTest(tail=tail):
                _, procs, _ = server.parse_nvidia_output(GPU + "__GPUMON_P__\n" + PROCS + tail)
                self.assertTrue(all(p["elapsed_seconds"] is None for p in procs))

    def test_cgroup_v1_and_v2(self):
        container_id = "a" * 64
        for path in (f"12:memory:/docker/{container_id}",
                     f"0::/system.slice/docker-{container_id}.scope/workers"):
            with self.subTest(path=path):
                output = (GPU + "__GPUMON_P__\n" + PROCS + "__GPUMON_D__\n"
                          + container_id + " training-job\n__GPUMON_C__\n"
                          + f"101 {path}\n102 0::/user.slice\n")
                with patch.object(server.subprocess, "run", return_value=CompletedProcess(
                        [], 0, stdout=output, stderr="")):
                    result = server.query_host("test-host")
                self.assertTrue(result["ok"])
                procs = result["gpus"][0]["procs"]
                self.assertEqual(procs[0]["container"], "training-job")
                self.assertEqual(procs[0]["name"], "/usr/bin/python")
                self.assertEqual(procs[1]["container"], None)
                self.assertEqual(procs[0]["mem"], 1024)

    def test_fallback_without_docker_or_matching_id(self):
        for tail in ("", "__GPUMON_D__\n__GPUMON_C__\n101 0::/docker/" + "b" * 64):
            with self.subTest(tail=tail):
                _, procs, _ = server.parse_nvidia_output(GPU + "__GPUMON_P__\n" + PROCS + tail)
                self.assertEqual(len(procs), 2)
                self.assertIsNone(procs[0]["container"])
                self.assertEqual(procs[0]["name"], "/usr/bin/python")


class StaleFallbackTest(unittest.TestCase):
    def test_failure_returns_last_success_with_age(self):
        server._last_ok.pop("stale-host", None)
        fail = CompletedProcess([], 255, stdout="", stderr="ssh: connect timed out\n")
        with patch.object(server.subprocess, "run", return_value=fail):
            first = server.query_host("stale-host")
        self.assertEqual((first["ok"], first["stale"], first["gpus"]), (False, False, []))
        ok = CompletedProcess([], 0, stdout=GPU + "__GPUMON_P__\n", stderr="")
        with patch.object(server.subprocess, "run", return_value=ok), \
                patch.object(server.time, "time", return_value=1000):
            self.assertFalse(server.query_host("stale-host")["stale"])
        with patch.object(server.subprocess, "run", return_value=fail), \
                patch.object(server.time, "time", return_value=1090):
            res = server.query_host("stale-host")
        self.assertEqual((res["ok"], res["stale"], res["data_age_seconds"]), (False, True, 90))
        self.assertEqual(res["error"], "ssh: connect timed out")
        self.assertEqual(len(res["gpus"]), 1)


class QueryGroupTest(unittest.TestCase):
    def test_filters_group_case_insensitive(self):
        entries = [{"host": "a", "group": "H200"}, {"host": "b", "group": "B300"},
                   {"host": "c", "group": "H200"}]
        with patch.object(server, "load_entries", return_value=entries), \
                patch.object(server, "query_host", side_effect=lambda h: {"host": h}):
            self.assertEqual([r["host"] for r in server.query_group("h200")["results"]], ["a", "c"])
            self.assertEqual(len(server.query_group()["results"]), 3)
            missing = server.query_group("A100")
        self.assertFalse(missing["ok"])
        self.assertEqual(missing["groups"], ["H200", "B300"])

    def test_brief_keeps_memory_and_unique_containers(self):
        procs = [{"container": "job"}, {"container": None}, {"container": "job"}, {"container": "eval"}]
        r = {"host": "a", "ok": True, "error": None, "latency_ms": 5, "stale": False, "data_age_seconds": 0,
             "gpus": [{"index": 0, "uuid": "u", "util": 9, "mem_used": 100.0, "mem_total": 200.0, "procs": procs}]}
        self.assertEqual(server.brief_result(r)["gpus"],
                         [{"index": 0, "mem_used": 100.0, "mem_total": 200.0, "containers": ["job", "eval"]}])


class DisabledTest(unittest.TestCase):
    def test_disable_persists_and_annotates_results(self):
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as d, \
                patch.object(server, "CONFIG_FILE", Path(d) / "hosts.json"), \
                patch.object(server, "query_host", side_effect=lambda h: {
                    "host": h, "ok": True, "error": None, "stale": False, "data_age_seconds": 0, "gpus": []}):
            server.save_entries([{"host": "a", "group": "H200"}, {"host": "b", "group": "H200"}])
            server.set_disabled("a", "维修中")
            server.save_entries([{"host": "b", "group": "H200"}, {"host": "a", "group": "H200"}])  # 排序不丢禁用
            self.assertEqual(server.load_disabled(), {"a": "维修中"})
            out = server.query_group("h200", brief=True)
            self.assertEqual({r["host"]: r["disabled"] for r in out["results"]}, {"a": "维修中", "b": None})
            server.set_disabled("a", None)
            self.assertEqual(server.load_disabled(), {})
            self.assertEqual(len(server.load_entries()), 2)


if __name__ == "__main__":
    unittest.main()
