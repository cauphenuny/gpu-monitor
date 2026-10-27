import io
import tarfile
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import tasks

CFG = {"image": "reg/sglang:v1", "ifname": "bond0", "hosts": ["h1", "h2"],
       "env": "export A=1\nB='x y'\n# c\n", "mounts": "/data\n/src:/dst:ro\n",
       "entrypoint": "echo hi\n", "docker_args": "--shm-size 10g"}


class ParseTest(unittest.TestCase):
    def test_env(self):
        self.assertEqual(tasks.parse_env('export A=1\n  B="x y"\n# skip\n\nC=a=b\nD='),
                         [("A", "1"), ("B", "x y"), ("C", "a=b"), ("D", "")])
        for bad in ("A", "1A=2", "export =1", "A B=1"):
            with self.subTest(bad=bad), self.assertRaises(tasks.TaskError):
                tasks.parse_env(bad)

    def test_mounts(self):
        self.assertEqual(tasks.parse_mounts("/a\n/b:/c\n/d:/e:ro\n# /x"),
                         [("/a", "/a", False), ("/b", "/c", False), ("/d", "/e", True)])
        self.assertEqual(tasks.parse_mounts("/x:/root/data")[0][1], "/root/data")
        for bad in ("a:/b", "/a:b", "/a:/b:rw", "/a:/b:ro:x", "/x:/", "/root", "/x:/root/", "/x:/root/.ssh",
                    "/x:/root/.ssh/keys", "/x:/root/./.gpumon"):
            with self.subTest(bad=bad), self.assertRaises(tasks.TaskError):
                tasks.parse_mounts(bad)

    def test_validate(self):
        self.assertEqual(tasks.validate(CFG, {"h1", "h2"})["hosts"], ["h1", "h2"])
        for patch_, msg in (({"hosts": ["h1", "h1"]}, "重复"), ({"hosts": ["h3"]}, "未配置"),
                            ({"hosts": []}, "主机"), ({"image": "a b"}, "镜像"),
                            ({"ifname": "bond0;rm"}, "网卡"), ({"docker_args": "'"}, "docker")):
            with self.subTest(msg=msg), self.assertRaisesRegex(tasks.TaskError, msg):
                tasks.validate({**CFG, **patch_}, {"h1", "h2"})

    def test_docker_run_cmd(self):
        cmd = tasks.docker_run_cmd("c", CFG, [("A", "1 2")], [("/s", "/d", True)])
        self.assertEqual(cmd[:5], ["docker", "run", "-d", "--name", "c"])
        self.assertIn("--shm-size", cmd)
        self.assertEqual(cmd[cmd.index("--ipc") + 1], "private")  # host 模式下 --shm-size 不生效
        self.assertEqual(cmd[-4:], ["-v", "/s:/d:ro", "reg/sglang:v1", "infinity"])
        self.assertEqual(cmd[cmd.index("--entrypoint") + 1], "sleep")  # 实际执行 `sleep infinity`
        self.assertIn("A=1 2", cmd)

    def test_real_ssh_runner_streams_and_feeds_stdin(self):
        # 用 cat 冒充 ssh: stdin 原样回到 stdout, 校验管道读写和退出码
        real = tasks.subprocess.Popen
        with patch.object(tasks.subprocess, "Popen", lambda args, **kw: real(["sh", "-c", "cat; echo err >&2; exit 3"], **kw)):
            self.assertEqual(tasks._run_ssh("h", "x", 5, b"abc", None), (3, b"abc", b"err\n"))

    def test_proxy_only_in_apt_branch(self):
        s = tasks.setup_script("1.2.3.4", "proxy.local:8888")
        self.assertIn("export http_proxy=http://proxy.local:8888 https_proxy=http://proxy.local:8888", s)
        self.assertLess(s.index("https_proxy"), s.index("apt-get update"))
        self.assertLess(s.index("https_proxy"), s.index("apt-get update"))
        # 无代理时不注入; 无论有没有代理, 代理变量都不写进 ~/.ssh/environment (env 行会滤掉)
        self.assertNotIn("export http_proxy", tasks.setup_script("1.2.3.4"))
        self.assertIn("https?_proxy|HTTPS?_PROXY", tasks.setup_script("1.2.3.4", "p:1"))
        with self.assertRaisesRegex(tasks.TaskError, "代理"):
            tasks.validate({**CFG, "proxy": "http://a b"}, {"h1", "h2"})

    def test_sshd_keeps_container_path(self):
        # pam_env 会用 /etc/environment 覆盖 PATH, ssh 进来的 python3 就不是镜像里那个了
        self.assertIn("-o UsePAM=no", tasks.SETUP_SCRIPT)
        self.assertIn("PermitUserEnvironment=yes", tasks.SETUP_SCRIPT)

    def test_docker_run_record(self):
        rec = tasks.docker_run_record("c", CFG, [("A", "1 2")], [("/s", "/d", True)])
        self.assertNotIn("--name", rec)
        self.assertNotIn("reg/sglang", rec)  # 镜像不写
        self.assertEqual(rec.splitlines()[0], "docker run -d \\")
        self.assertIn("  --ipc private \\", rec.splitlines())
        self.assertIn("  -e 'A=1 2' \\", rec.splitlines())
        self.assertEqual(rec.splitlines()[-1], "  -v /s:/d:ro")

    def test_bundle(self):
        with tarfile.open(fileobj=io.BytesIO(tasks.build_bundle("c", ["1.1.1.1"], "1.1.1.1 slots=8\n", "echo hi"))) as tar:
            modes = {m.name: m.mode for m in tar.getmembers()}
            self.assertEqual(tar.extractfile("mpi_hostfile").read(), b"1.1.1.1 slots=8\n")
            self.assertTrue(tar.extractfile(".ssh/config").read().startswith(b"Host 1.1.1.1\n"))
            self.assertEqual(tar.extractfile(".ssh/authorized_keys").read(),
                             tar.extractfile(".ssh/id_ed25519.pub").read())
        self.assertEqual(modes[".ssh"], 0o700)
        self.assertEqual(modes[".ssh/id_ed25519"], 0o600)
        self.assertEqual(modes[".gpumon/entrypoint.sh"], 0o755)


class StoreTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        p = patch.object(tasks, "TASKS_DIR", Path(tmp.name))
        p.start()
        self.addCleanup(p.stop)
        # 线程改为同步执行, 测试里能直接看到最终状态
        t = patch.object(tasks, "_bg", lambda fn, *args: fn(*args))
        t.start()
        self.addCleanup(t.stop)

    def fake_ssh(self, rc="0", fail=None, hook=None):
        calls = []

        def ssh(host, cmd, timeout=120, input=None):
            calls.append((host, cmd))
            if hook:
                hook(cmd)
            if fail and fail in cmd:
                raise tasks.TaskError(f"{host}: boom")
            if "ip -4 -o addr" in cmd:
                return {"h1": "10.0.0.1 8\n", "h2": "10.0.0.2 4\n"}[host]
            if "cat /root/.gpumon/rc" in cmd:
                return f"{rc}\n0\n"  # 退出码 + 远端 output.log 大小
            return ""
        return calls, ssh

    def popen(self, data):
        real = tasks.subprocess.Popen  # ssh-keygen 走真实 Popen, 只替换跟随输出的 ssh

        def fake(args, *a, **k):
            if args[0] != "ssh":
                return real(args, *a, **k)
            return SimpleNamespace(stdout=io.BufferedReader(io.BytesIO(data)), wait=lambda: 0)
        return fake

    def test_launch_runs_entrypoint_and_captures_output(self):
        calls, ssh = self.fake_ssh()
        with patch.object(tasks, "_ssh", ssh), patch.object(tasks.subprocess, "Popen", self.popen(b"hello\n")):
            t = tasks.create("job", "", CFG, "gpumon")
        t = tasks.get(t["id"])
        self.assertEqual(t["status"], "succeeded")
        self.assertTrue(t["containers_up"])  # 容器保留到手动停止
        self.assertEqual(t["container"], "gpumon-" + t["id"])
        self.assertIn("-e MLP_TASK_ID=" + t["id"], t["docker_run"])
        self.assertEqual([n["ip"] for n in t["nodes"]], ["10.0.0.1", "10.0.0.2"])
        self.assertEqual(tasks.read_log(t["id"], "output", 0)["text"], "hello\n")
        runs = [c for c in calls if "docker run" in c[1]]
        self.assertEqual(len(runs), 2)
        self.assertIn("MLP_TASK_ID=" + t["id"], runs[0][1])
        self.assertIn("-e 'B=x y'", runs[0][1])
        entry = [c for c in calls if "entrypoint.sh" in c[1]]
        self.assertEqual([c[0] for c in entry], ["h1"])  # 只在 head 上跑
        self.assertIn("互连检查 完成", tasks.read_log(t["id"], "launch", 0)["text"])

    def test_debug_trace_hidden_by_default(self):
        _, ssh = self.fake_ssh()
        with patch.object(tasks, "_ssh", ssh), patch.object(tasks, "_launch"):
            tid = tasks.create("job", "", CFG, "gpumon")["id"]
        tasks._ctx.tid = tid
        try:
            with patch.object(tasks, "_run_ssh", lambda *a: (0, b"", "[setup] 安装中\n".encode())):
                tasks._ssh("h1", "docker run x\nmore")
        finally:
            tasks._ctx.tid = None
        self.assertNotIn("DEBUG", tasks.read_log(tid, "launch", 0)["text"])
        full = tasks.read_log(tid, "launch", 0, debug=True)["text"]
        self.assertIn("[h1] DEBUG $ docker run x …", full)
        self.assertIn("[h1] DEBUG → 退出码 0", full)

    def test_nonzero_exit_and_stop(self):
        calls, ssh = self.fake_ssh(rc="3")
        with patch.object(tasks, "_ssh", ssh), patch.object(tasks.subprocess, "Popen", self.popen(b"")):
            tid = tasks.create("job", "", CFG, "gpumon")["id"]
            self.assertEqual(tasks.get(tid)["error"], "entrypoint 退出码 3")
            with self.assertRaisesRegex(tasks.TaskError, "先停止"):
                tasks.delete(tid)
            t, errs = tasks.stop(tid)
        self.assertEqual((t["status"], t["containers_up"], errs), ("failed", False, []))
        self.assertEqual(sum("docker rm -f" in c[1] for c in calls), 2)
        tasks.delete(tid)
        self.assertEqual(tasks.list_tasks(), [])

    def test_stop_during_docker_run_cleans_up_late_container(self):
        state = {}

        def hook(cmd):  # docker run 进行中用户点了停止: 删除先于容器出现
            if "docker run" in cmd and "stopped" not in state:
                state["stopped"] = tasks.stop(state["tid"])
                state["again"] = tasks.stop(state["tid"])  # 连点两次也不能提前放行删除
        calls, ssh = self.fake_ssh(hook=hook)
        with patch.object(tasks, "_ssh", ssh), patch.object(tasks, "_launch"):
            state["tid"] = tid = tasks.create("job", "", CFG, "gpumon")["id"]
        with patch.object(tasks, "_ssh", ssh):
            tasks._launch(tid)
            for t, _ in (state["stopped"], state["again"]):
                self.assertTrue(t["containers_up"])  # 拉起中: 留给拉起线程收尾, 此时不让删除
        t = tasks.get(tid)
        self.assertEqual((t["status"], t["containers_up"]), ("stopped", False))
        rm = [i for i, c in enumerate(calls) if "docker rm -f" in c[1]]
        runs = [i for i, c in enumerate(calls) if "docker run" in c[1]]
        self.assertGreater(max(rm), max(runs))  # 晚到的容器被再删一遍
        self.assertFalse(any("entrypoint.sh" in c[1] for c in calls))

    def test_launch_failure_keeps_error_and_skips_entrypoint(self):
        calls, ssh = self.fake_ssh(fail="docker pull")
        with patch.object(tasks, "_ssh", ssh):
            t = tasks.get(tasks.create("job", "", CFG, "gpumon")["id"])
        self.assertEqual(t["status"], "failed")
        self.assertIn("boom", t["error"])
        self.assertFalse(t["containers_up"])
        self.assertFalse(any("docker run" in c[1] for c in calls))

    def test_ssh_retries_transient_failures(self):
        calls = []

        def run(host, cmd, timeout, input, tid):
            calls.append(1)
            if len(calls) < 3:   # 前两次: 跳板机连接被重置 (ssh 自身失败, rc=255)
                return 255, b"", b"kex_exchange_identification: read: Connection reset by peer"
            return 0, b"ok\n", b""
        with patch.object(tasks, "_run_ssh", run), patch.object(tasks.time, "sleep"):
            self.assertEqual(tasks._ssh("h1", "true"), "ok\n")
            self.assertEqual(len(calls), 3)

    def test_read_remote_parses_header_and_reset(self):
        _, ssh = self.fake_ssh()
        with patch.object(tasks, "_ssh", ssh), patch.object(tasks, "_launch"):
            tid = tasks.create("job", "", CFG, "gpumon")["id"]
        tasks.update(tid, containers_up=True)
        # 远端先回 "size start reset" 一行, 再是文件内容; 最后一个中文字符只写了一半
        body = "10 0 1\nab\n进".encode()[:-1]
        with patch.object(tasks, "_ssh", lambda *a, **k: body):
            r = tasks.read_remote(tid, "/logs/x.log", 999)
        self.assertEqual((r["text"], r["offset"], r["reset"], r["size"]), ("ab\n", 3, True, 10))
        tasks.update(tid, containers_up=False)
        with self.assertRaisesRegex(tasks.TaskError, "已清理"):
            tasks.read_remote(tid, "/logs/x.log", 0)

    def test_rename(self):
        _, ssh = self.fake_ssh()
        with patch.object(tasks, "_ssh", ssh), patch.object(tasks, "_launch"):
            tid = tasks.create("job", "", CFG, "gpumon")["id"]
        self.assertEqual(tasks.rename(tid, "  new name ")["name"], "new name")
        with self.assertRaises(tasks.TaskError):
            tasks.rename(tid, " ")
        self.assertEqual(tasks.set_note(tid, "  epd, dp8 ")["note"], "  epd, dp8 ")
        self.assertEqual(tasks.set_note(tid, "")["note"], "")   # 空串清除

    def test_recover_marks_interrupted_launch(self):
        _, ssh = self.fake_ssh()
        with patch.object(tasks, "_ssh", ssh), patch.object(tasks, "_launch"):
            tid = tasks.create("job", "", CFG, "gpumon")["id"]
        tasks.recover()
        self.assertEqual(tasks.get(tid)["status"], "failed")

    def test_read_log_chunks_on_lines(self):
        _, ssh = self.fake_ssh()
        with patch.object(tasks, "_ssh", ssh), patch.object(tasks, "_launch"):
            tid = tasks.create("job", "", CFG, "gpumon")["id"]
        (tasks.TASKS_DIR / tid / "output.log").write_bytes(b"ab\n" * 10)
        with patch.object(tasks, "LOG_CHUNK", 8), patch.object(tasks, "LOG_TAIL", 7):
            r = tasks.read_log(tid, "output", 0)
            self.assertEqual((r["text"], r["offset"], r["more"]), ("ab\nab\n", 6, True))
            r = tasks.read_log(tid, "output", -1)  # tail: 从截断处的下一整行开始
            self.assertEqual((r["text"], r["offset"], r["more"]), ("ab\nab\n", 30, False))
        (tasks.TASKS_DIR / tid / "output.log").write_bytes("进度 █".encode()[:-1])  # 写到一半的字符
        r = tasks.read_log(tid, "output", 0)
        self.assertEqual((r["text"], r["offset"]), ("进度 ", len("进度 ".encode())))
        with self.assertRaises(tasks.TaskError):
            tasks.read_log("../etc", "output", 0)


if __name__ == "__main__":
    unittest.main()
