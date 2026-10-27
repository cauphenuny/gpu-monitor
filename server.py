#!/usr/bin/env python3
"""gpu-monitor — 网页集中查看多台主机 NVIDIA GPU 的利用率/显存占用.

    python3 server.py [--bind 127.0.0.1] [--port 8799]

浏览器打开 http://127.0.0.1:8799,在页面上增删主机(可分组);服务端通过本机
ssh (支持 ~/.ssh/config 别名与密钥) 到各主机并行执行 nvidia-smi 并汇总返回。
配置持久化在同目录 hosts.json ({"hosts": [{"host":..,"group":..},..]},
兼容旧版纯主机名列表,读取时自动迁移)。仅依赖 Python3 标准库。
"""

import argparse
import csv
import os
import sys
import io
import json
import re
import secrets
import shlex
import subprocess
import threading
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import tasks

ROOT = Path(__file__).resolve().parent
STATIC = {  # URL → (文件, Content-Type)
    "/": ("index.html", "text/html; charset=utf-8"),
    "/tasks": ("tasks.html", "text/html; charset=utf-8"),
    "/common.js": ("common.js", "application/javascript; charset=utf-8"),
    "/app.js": ("app.js", "application/javascript; charset=utf-8"),
    "/tasks.js": ("tasks.js", "application/javascript; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
}
CONFIG_FILE = ROOT / "hosts.json"
CLEAR_TOKEN = secrets.token_urlsafe(32)
# 监听本机时只认这些 Host 头, 防 DNS rebinding 读走页面令牌后起特权容器; None 表示不校验
ALLOWED_HOSTS = None

GPU_FIELDS = "index,uuid,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw"
PROC_FIELDS = "gpu_uuid,pid,process_name,used_memory"
REMOTE_CMD = rf"""
nvidia-smi --query-gpu={GPU_FIELDS} --format=csv,noheader,nounits
echo __GPUMON_P__
gpumon_procs=$(nvidia-smi --query-compute-apps={PROC_FIELDS} --format=csv,noheader,nounits) || exit $?
printf '%s\n' "$gpumon_procs"
echo __GPUMON_D__
timeout 3s docker ps --no-trunc --format '{{{{.ID}}}} {{{{.Names}}}}' 2>/dev/null || true
echo __GPUMON_C__
gpumon_pids=$(printf '%s\n' "$gpumon_procs" | awk -F, '$2 ~ /^[[:space:]]*[0-9]+[[:space:]]*$/ {{gsub(/[[:space:]]/, "", $2); print $2}}' | sort -u)
printf '%s\n' "$gpumon_pids" | while read -r gpumon_pid; do
    [ -n "$gpumon_pid" ] || continue
    sed "s/^/$gpumon_pid /" "/proc/$gpumon_pid/cgroup" 2>/dev/null || true
done
echo __GPUMON_E__
if [ -n "$gpumon_pids" ]; then
    ps -p "$(printf '%s\n' "$gpumon_pids" | paste -sd, -)" -o pid=,etimes= 2>/dev/null || true
fi
"""
SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=6", "-o", "StrictHostKeyChecking=accept-new",
            "-o", "IgnoreUnknown=WarnWeakCrypto", "-o", "WarnWeakCrypto=no"]  # 屏蔽 OpenSSH 10.1+ 的 post-quantum 警告
SSH_TIMEOUT = 25

CLEAR_CMD = "python3 -c " + shlex.quote(r'''
import json
import os
import re
import signal
import subprocess
import time
import xml.etree.ElementTree as ET

result = {"ok": False, "killed": [], "failed": [], "remaining": [], "stopped": [], "error": None}
handles = {}

def gpu_pids():
    output = subprocess.run(["nvidia-smi", "-q", "-x"], capture_output=True,
                            text=True, check=True, timeout=10)
    pids = set()
    for proc in ET.fromstring(output.stdout).findall("./gpu/processes/process_info"):
        pid = (proc.findtext("pid") or "").strip()
        if not pid.isascii() or not pid.isdigit() or int(pid) <= 1:
            raise ValueError("GPU 进程 PID 无效，清空已停止")
        pids.add(int(pid))
    return pids

try:
    if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
        raise RuntimeError("清空需要 Linux 和 Python 3.9+ 的 pidfd 支持")
    for pid in sorted(gpu_pids()):
        try:
            handles[pid] = os.pidfd_open(pid)
        except ProcessLookupError:
            pass
        except OSError as exc:
            result["failed"].append({"pid": pid, "error": str(exc)})
    # 占卡的进程若属于容器, 先 docker stop -t 0 (SIGKILL): PID 1 一死内核对整个
    # 命名空间发 SIGKILL, 整个容器一起干净地掉, 避免幸存组件 SIGQUIT 自杀写 core
    current = gpu_pids() if handles else set()
    cids, container_pids = {}, set()
    for pid in current:
        try:
            with open(f"/proc/{pid}/cgroup") as f:
                m = re.search(r"[0-9a-f]{64}", f.read())
            if m:
                cids[m.group(0)] = True
                container_pids.add(pid)
        except OSError:
            pass
    if cids:
        try:
            out = subprocess.run(["docker", "ps", "--no-trunc", "--format", "{{.ID}} {{.Names}}"],
                                 capture_output=True, text=True, timeout=10).stdout
            names = dict(l.split(None, 1) for l in out.splitlines() if " " in l)
        except Exception:
            names = {}
        for cid in cids:
            name = names.get(cid, cid[:12])
            try:
                subprocess.run(["docker", "stop", "-t", "0", cid], capture_output=True, timeout=90)
                result["stopped"].append(name)
            except Exception as exc:
                result["failed"].append({"pid": name, "error": f"docker stop: {exc}"})
        current = gpu_pids()  # 容器里的进程随命名空间被 SIGKILL, 重查幸存的
    for pid, handle in handles.items():
        if pid in container_pids or pid not in current:
            continue
        try:
            signal.pidfd_send_signal(handle, signal.SIGKILL)
            result["killed"].append(pid)
        except ProcessLookupError:
            pass
        except OSError as exc:
            result["failed"].append({"pid": pid, "error": str(exc)})
    deadline = time.monotonic() + 180
    result["remaining"] = sorted(gpu_pids())
    while result["killed"] and result["remaining"] and time.monotonic() < deadline:
        time.sleep(min(5, max(0, deadline - time.monotonic())))
        result["remaining"] = sorted(gpu_pids())
    result["ok"] = not result["failed"] and not result["remaining"]
except Exception as exc:
    result["error"] = str(exc)
finally:
    for handle in handles.values():
        os.close(handle)
print(json.dumps(result))
''')

_lock = threading.Lock()


def _read_config():
    try:
        data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _write_config(data):
    CONFIG_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def load_entries():
    """读取主机配置 → [{"host": str, "group": str}]; 兼容旧版纯字符串列表格式."""
    with _lock:
        hosts = _read_config().get("hosts", [])
    entries = []
    if isinstance(hosts, list):
        for h in hosts:
            if isinstance(h, str) and h.strip():
                entries.append({"host": h.strip(), "group": ""})
            elif isinstance(h, dict) and str(h.get("host", "")).strip():
                entries.append({"host": str(h["host"]).strip(), "group": str(h.get("group", "")).strip()})
    return entries


def save_entries(entries):
    with _lock:
        data = _read_config()
        data["hosts"] = entries
        _write_config(data)


def load_disabled():
    """临时禁用的机器 → {host: 原因}; 按机器而非分组记录."""
    with _lock:
        d = _read_config().get("disabled")
    return {str(k): str(v) for k, v in d.items()} if isinstance(d, dict) else {}


def set_disabled(host, reason):
    """reason 为 None 表示解除禁用."""
    with _lock:
        data = _read_config()
        d = data.get("disabled") if isinstance(data.get("disabled"), dict) else {}
        if reason is None:
            d.pop(host, None)
        else:
            d[host] = reason
        data["disabled"] = d
        _write_config(data)
    return d


def load_settings():
    with _lock:
        s = _read_config().get("settings")
    s = s if isinstance(s, dict) else {}
    return {"docker_prefix": str(s.get("docker_prefix") or "gpumon")}


def save_settings(settings):
    with _lock:
        data = _read_config()
        data["settings"] = settings
        _write_config(data)
    return settings


def _num(s):
    if s is None:
        return None
    s = s.strip().rstrip("%")
    if not s or s.startswith("["):  # "[N/A]" / "[Not Supported]"
        return None
    try:
        return float(s)
    except ValueError:
        return None


def parse_nvidia_output(text):
    """解析 REMOTE_CMD 的输出 → (gpus, procs, uuid到gpu的映射)."""
    gpu_text, _, tail = text.partition("__GPUMON_P__")
    proc_text, _, tail = tail.partition("__GPUMON_D__")
    docker_text, _, cgroup_text = tail.partition("__GPUMON_C__")
    cgroup_text, _, elapsed_text = cgroup_text.partition("__GPUMON_E__")
    pid_to_elapsed = {}
    for line in elapsed_text.splitlines():
        fields = line.split()
        if len(fields) == 2 and all(field.isascii() and field.isdigit() for field in fields):
            pid_to_elapsed[fields[0]] = int(fields[1])
    container_names = {}
    for line in docker_text.splitlines():
        container_id, _, name = line.strip().partition(" ")
        if container_id and name:
            container_names[container_id] = name.strip()
    pid_to_container = {}
    for line in cgroup_text.splitlines():
        pid, _, cgroup = line.partition(" ")
        if not pid.isdigit():
            continue
        path = cgroup.split(":", 2)[-1]
        for container_id in re.findall(r"(?:^|/)(?:docker-)?([0-9a-f]{64})(?=\.scope(?:/|$)|/|$)", path):
            if container_id in container_names:
                pid_to_container[pid] = container_names[container_id]
    gpus, uuid_to_gpu = [], {}
    for row in csv.reader(io.StringIO(gpu_text)):
        row = [c.strip() for c in row]
        if len(row) < 6 or not row[0].isdigit():
            continue
        gpu = {
            "index": int(row[0]),
            "uuid": row[1],
            "name": row[2],
            "util": _num(row[3]) if len(row) > 3 else None,
            "mem_used": _num(row[4]) if len(row) > 4 else None,
            "mem_total": _num(row[5]) if len(row) > 5 else None,
            "temp": _num(row[6]) if len(row) > 6 else None,
            "power": _num(row[7]) if len(row) > 7 else None,
            "procs": [],
        }
        gpus.append(gpu)
        if gpu["uuid"]:
            uuid_to_gpu[gpu["uuid"]] = gpu
    procs = []
    for row in csv.reader(io.StringIO(proc_text)):
        row = [c.strip() for c in row]
        if len(row) < 4:
            continue
        procs.append({"gpu_uuid": row[0], "pid": row[1], "name": row[2], "mem": _num(row[3]),
                      "container": pid_to_container.get(row[1]),
                      "elapsed_seconds": pid_to_elapsed.get(row[1])})
    return gpus, procs, uuid_to_gpu


def collect_host(host):
    started = time.time()
    res = {"host": host, "ok": False, "error": None, "latency_ms": None, "ts": started, "gpus": []}
    try:
        proc = subprocess.run(
            ["ssh", *SSH_OPTS, host, REMOTE_CMD],
            capture_output=True, text=True, timeout=SSH_TIMEOUT,
        )
    except subprocess.TimeoutExpired:
        res["error"] = "ssh 超时 (>%ds)" % SSH_TIMEOUT
        return res
    except FileNotFoundError:
        res["error"] = "本机未安装 ssh 命令"
        return res
    res["latency_ms"] = round((time.time() - started) * 1000)
    if proc.returncode != 0:  # ssh 本身失败: 网络不通 / 未配置免密 / 未知主机等
        lines = (proc.stderr or proc.stdout or "").strip().splitlines()
        res["error"] = lines[-1].strip() if lines else "ssh 退出码 %d" % proc.returncode
        return res
    gpus, procs, uuid_to_gpu = parse_nvidia_output(proc.stdout)
    if not gpus:
        lines = (proc.stderr or "").strip().splitlines()
        if lines:  # 如 "nvidia-smi: command not found" / "No devices were found"
            res["error"] = lines[-1].strip()
            return res
    for p in procs:
        g = uuid_to_gpu.get(p["gpu_uuid"])
        if g is not None:
            g["procs"].append(p)
    res["ok"] = True
    res["gpus"] = gpus
    return res


HISTORY_SECONDS = 12 * 3600   # 内存里保留的历史时长; 服务重启即清空
HISTORY_MAX_POINTS = 1440     # 每张卡的点数上限, 超出后隔点抽稀 (时间窗不变, 精度减半)
_history = {}                # host → {gpu_key: [[ts, util%, mem%], ...]}
_history_lock = threading.Lock()


def _record_history(host, gpus):
    cutoff = time.time() - HISTORY_SECONDS
    with _history_lock:
        per_host = _history.setdefault(host, {})
        live = set()
        for g in gpus:
            key = str(g.get("uuid") or g.get("index"))
            live.add(key)
            mem_pct = (g["mem_used"] / g["mem_total"] * 100) if g.get("mem_total") else None
            pts = per_host.setdefault(key, [])
            pts.append([round(time.time(), 1), g.get("util"), None if mem_pct is None else round(mem_pct, 1)])
            while pts and pts[0][0] < cutoff:
                pts.pop(0)
            if len(pts) > HISTORY_MAX_POINTS:   # ponytail: 隔点抽稀, 精度降到 2x/4x… 点够时可换成分桶平均
                pts[:] = pts[::2]
        for key in list(per_host):   # 卡下架后不再记录
            if key not in live:
                del per_host[key]


def gpu_history(host, minutes=None, max_points=180):
    with _history_lock:
        per_host = _history.get(host) or {}
        data = {k: list(v) for k, v in per_host.items()}
    if minutes:   # 只回给定窗口; 超出 max_points 时按时间桶取平均降采样
        cutoff = time.time() - minutes * 60
        data = {k: [pt for pt in v if pt[0] >= cutoff] for k, v in data.items()}
    out = {}
    for key, pts in data.items():
        if len(pts) > max_points:
            step = len(pts) / max_points
            buckets = [pts[int(i * step):int((i + 1) * step)] for i in range(max_points)]
            pts = [[round(b[len(b)//2][0], 1),
                    round(sum(x[1] for x in b if x[1] is not None) / max(1, sum(1 for x in b if x[1] is not None)), 1) if any(x[1] is not None for x in b) else None,
                    round(sum(x[2] for x in b if x[2] is not None) / max(1, sum(1 for x in b if x[2] is not None)), 1) if any(x[2] is not None for x in b) else None,
                    ] for b in buckets if b]
        out[key] = pts
    return out


_fails = {}   # host → 连续失败次数, 成功的采集会清零; 前端据此决定何时算真离线

_last_ok = {}  # ponytail: 仅存内存, 服务重启/命令行单次查询时没有旧数据可回退; 需要时落盘


def query_host(host):
    """查询失败时回退到该主机上一次成功的数据, 用 stale/data_age_seconds 标注数据有多旧."""
    res = collect_host(host)
    if res["ok"]:
        _fails[host] = 0
        _last_ok[host] = res
        _record_history(host, res["gpus"])
        return {**res, "stale": False, "data_age_seconds": 0, "fails": 0}
    fails = _fails[host] = _fails.get(host, 0) + 1
    last = _last_ok.get(host)
    if last is None:
        return {**res, "stale": False, "data_age_seconds": None, "fails": fails}
    return {**last, "ok": False, "error": res["error"], "latency_ms": res["latency_ms"],
            "stale": True, "data_age_seconds": round(time.time() - last["ts"]), "fails": fails}


def query_all(hosts):
    hosts = list(dict.fromkeys(hosts))  # 同一主机可能在多个分组, 只查一次
    if not hosts:
        return []
    with ThreadPoolExecutor(max_workers=min(16, len(hosts))) as ex:
        return list(ex.map(query_host, hosts))


def brief_result(r):
    """精简结果: 每张卡只保留显存占用和占用显存的容器名 (去重, 不在容器里的进程不列出)."""
    return {"host": r["host"], "ok": r["ok"], "error": r["error"], "stale": r["stale"], "fails": r.get("fails"),
            "data_age_seconds": r["data_age_seconds"], "disabled": r.get("disabled"),
            "gpus": [{"index": g["index"], "mem_used": g["mem_used"], "mem_total": g["mem_total"],
                      "containers": list(dict.fromkeys(p["container"] for p in g["procs"] if p["container"]))}
                     for g in r["gpus"]]}


def query_group(group=None, brief=False):
    """按分组查询 (忽略大小写, None 为全部) → 可直接 json 输出的 dict; 分组不存在时返回 error 和可选分组."""
    entries = load_entries()
    if group is not None:
        groups = list(dict.fromkeys(e["group"] for e in entries))
        entries = [e for e in entries if e["group"].casefold() == group.casefold()]
        if not entries:
            return {"ok": False, "error": "分组不存在: %s" % group, "groups": groups}
    disabled = load_disabled()
    results = [{**r, "disabled": disabled.get(r["host"])} for r in query_all([e["host"] for e in entries])]
    return {"ok": True, "ts": time.time(), "group": group,
            "results": [brief_result(r) for r in results] if brief else results}


def clear_host(host):
    try:
        proc = subprocess.run(["ssh", *SSH_OPTS, "--", host, CLEAR_CMD],
                              capture_output=True, text=True, timeout=240)
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "清空查询超时，部分任务可能已终止，请刷新确认"}
    except FileNotFoundError:
        return {"ok": False, "error": "本机未安装 ssh 命令"}
    if proc.returncode != 0:
        return {"ok": False, "error": (proc.stderr or proc.stdout or "ssh 执行失败").strip()}
    try:
        result = json.loads(proc.stdout)
        if not isinstance(result, dict) or "ok" not in result:
            raise ValueError()
        return result
    except ValueError:
        return {"ok": False, "error": "清空结果无法解析，部分任务可能已终止，请刷新确认"}


def git_pull():
    """在本仓库目录 git pull --ff-only; 返回是否拉到了新东西."""
    try:
        p = subprocess.run(["git", "pull", "--ff-only"], cwd=ROOT, capture_output=True,
                           text=True, timeout=120)
    except FileNotFoundError:
        return {"ok": False, "out": "本机没有 git 命令", "changed": False}
    except subprocess.TimeoutExpired:
        return {"ok": False, "out": "git pull 超时 (120s)", "changed": False}
    out = (p.stdout + "\n" + p.stderr).strip() or "(无输出)"
    changed = p.returncode == 0 and "Already up to date" not in p.stdout and "最新" not in out
    return {"ok": p.returncode == 0, "out": out, "changed": changed}


def _restart_soon():
    """拉到新代码后用新文件重新执行自己 (python sockets 默认不继承, 新进程重新绑端口)."""
    def go():
        time.sleep(0.8)   # 等响应发完
        os.execv(sys.executable, [sys.executable, os.path.abspath(sys.argv[0]), *sys.argv[1:]])
    threading.Thread(target=go, daemon=True).start()


def _bad_host(h):
    """Host 头不在允许列表时回 403 并返回 True."""
    if ALLOWED_HOSTS is None or h.headers.get("Host", "").lower() in ALLOWED_HOSTS:
        return False
    Handler._json(h, {"error": "Host 不在允许列表，经反向代理访问请用 --allow-host 添加"}, 403)
    return True


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # 安静模式, 刷新频繁不刷屏
        pass

    def _json(self, obj, code=200):
        data = json.dumps(obj, indent=2, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n:
            try:
                return json.loads(self.rfile.read(n))
            except json.JSONDecodeError:
                return {}
        return {}

    def do_GET(self):
        if _bad_host(self):
            return
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        if path in STATIC:
            name, ctype = STATIC[path]
            try:
                data = (ROOT / name).read_bytes().replace(b"__GPUMON_CLEAR_TOKEN__", CLEAR_TOKEN.encode())
            except FileNotFoundError:
                return self._json({"error": name + " 缺失"}, 500)
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        elif path == "/api/hosts":
            self._json({"hosts": load_entries(), "disabled": load_disabled()})
        elif path == "/api/status":
            qs = urllib.parse.parse_qs(parsed.query)
            out = query_group(qs.get("group", [None])[0],
                              brief=qs.get("brief", ["0"])[0].lower() in ("1", "true", "yes"))
            self._json(out, 200 if out["ok"] else 404)
        elif path == "/api/history":
            qs = urllib.parse.parse_qs(parsed.query)
            host = (qs.get("host") or [""])[0].strip()
            try:
                minutes = float((qs.get("minutes") or [""])[0])
            except ValueError:
                minutes = 0
            if not any(e["host"] == host for e in load_entries()):
                return self._json({"error": "主机未配置"}, 400)
            self._json({"host": host, "gpus": gpu_history(host, minutes or None)})
        elif path == "/api/tasks":
            tid = (urllib.parse.parse_qs(parsed.query).get("id") or [""])[0]
            if not tid:
                return self._json({"tasks": tasks.list_tasks()})
            try:
                self._json(tasks.get(tid))
            except tasks.TaskError as e:
                self._json({"error": str(e)}, 404)
        elif path == "/api/tasks/log":
            qs = urllib.parse.parse_qs(parsed.query)
            try:
                offset = int((qs.get("offset") or ["-1"])[0])
                self._json(tasks.read_log((qs.get("id") or [""])[0], (qs.get("which") or [""])[0], offset,
                                          (qs.get("level") or [""])[0] == "debug"))
            except ValueError:
                self._json({"error": "offset 无效"}, 400)
            except tasks.TaskError as e:
                self._json({"error": str(e)}, 404)
        elif path in ("/api/tasks/files", "/api/tasks/tail"):
            qs = urllib.parse.parse_qs(parsed.query)
            tid, fpath = (qs.get("id") or [""])[0], (qs.get("path") or [""])[0]
            try:
                if path == "/api/tasks/files":
                    self._json(tasks.list_files(tid, fpath))
                else:
                    self._json(tasks.read_remote(tid, fpath, int((qs.get("offset") or ["-1"])[0])))
            except ValueError:
                self._json({"error": "offset 无效"}, 400)
            except tasks.TaskError as e:
                self._json({"error": str(e)}, 400)
        elif path == "/api/settings":
            self._json(load_settings())
        else:
            self._json({"error": "not found"}, 404)

    def _token_ok(self):
        token = self.headers.get("X-GPUMon-Token", "").encode()
        return secrets.compare_digest(token, CLEAR_TOKEN.encode())

    def _task_post(self, path):
        """任务/设置接口: 会在远端起特权容器跑任意命令, 必须带页面令牌防跨站触发."""
        if not self._token_ok():
            return self._json({"error": "校验失败，请刷新页面后重试"}, 403)
        body = self._body()
        if not isinstance(body, dict):
            return self._json({"error": "请求必须是 JSON 对象"}, 400)
        try:
            if path == "/api/tasks":
                cfg = tasks.validate(body.get("config"), {e["host"] for e in load_entries()})
                return self._json(tasks.create(body.get("name"), body.get("note"), cfg,
                                               load_settings()["docker_prefix"]))
            if path == "/api/update":
                r = git_pull()
                restarting = r["ok"] and r["changed"]
                if restarting:
                    _restart_soon()
                return self._json({**r, "restarting": restarting})
            if path == "/api/tasks/rename":
                return self._json(tasks.rename(body.get("id"), body.get("name")))
            if path == "/api/tasks/note":
                return self._json(tasks.set_note(body.get("id"), body.get("note")))
            if path == "/api/tasks/stop":
                t, errs = tasks.stop(body.get("id"))
                return self._json({"task": t, "errors": errs})
            prefix = str(body.get("docker_prefix") or "").strip()
            if not tasks.PREFIX_RE.fullmatch(prefix):
                raise tasks.TaskError("前缀只能含字母、数字、_ . -，以字母或数字开头，最长 40 字符")
            self._json(save_settings({**load_settings(), "docker_prefix": prefix}))
        except tasks.TaskError as e:
            self._json({"error": str(e)}, 400)

    def do_POST(self):
        if _bad_host(self):
            return
        path = urllib.parse.urlparse(self.path).path
        if path in ("/api/tasks", "/api/tasks/stop", "/api/tasks/rename", "/api/tasks/note", "/api/settings", "/api/update"):
            return self._task_post(path)
        if path == "/api/hosts/clear":
            if self.headers.get_content_type() != "application/json":
                return self._json({"ok": False, "error": "清空请求格式错误，请刷新页面后重试"}, 400)
            token = self.headers.get("X-GPUMon-Token", "").encode()
            if not secrets.compare_digest(token, CLEAR_TOKEN.encode()):
                return self._json({"ok": False, "error": "清空校验失败，请刷新页面后重试"}, 403)
            body = self._body()
            if not isinstance(body, dict):
                return self._json({"ok": False, "error": "请求必须是 JSON 对象"}, 400)
            host = body.get("host")
            if (not isinstance(host, str) or not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.@:%\[\]-]*", host)
                    or not any(e["host"] == host for e in load_entries())):
                return self._json({"ok": False, "error": "服务器未配置或名字无效"}, 400)
            if body.get("confirmation") != host:
                return self._json({"ok": False, "error": "输入的服务器名不匹配，未执行清空"}, 400)
            self._json(clear_host(host))
        elif path == "/api/hosts/disable":
            body = self._body()
            host = str(body.get("host", "")).strip() if isinstance(body, dict) else ""
            if not host:
                return self._json({"error": "host 不能为空"}, 400)
            if body.get("disabled", True):
                reason = str(body.get("reason") or "").strip() or "未注明原因"
                self._json({"disabled": set_disabled(host, reason)})
            else:
                self._json({"disabled": set_disabled(host, None)})
        elif path == "/api/hosts":
            body = self._body()
            host = str(body.get("host", "")).strip()
            group = str(body.get("group", "")).strip()
            if not host:
                return self._json({"error": "host 不能为空"}, 400)
            entries = load_entries()
            if not any(e["host"] == host and e["group"] == group for e in entries):
                entries.append({"host": host, "group": group})
                save_entries(entries)
            self._json({"hosts": entries})
        elif path == "/api/hosts/reorder":
            items = self._body().get("hosts")
            if not isinstance(items, list):
                return self._json({"error": "hosts 必须是列表"}, 400)
            entries, seen = [], set()
            for it in items:
                if not isinstance(it, dict):
                    continue
                host = str(it.get("host", "")).strip()
                group = str(it.get("group", "")).strip()
                if host and (group, host) not in seen:
                    seen.add((group, host))
                    entries.append({"host": host, "group": group})
            save_entries(entries)  # 整表按客户端给出的顺序覆盖保存
            self._json({"hosts": entries})
        elif path == "/api/groups/rename":
            body = self._body()
            src = str(body.get("from", "")).strip()
            dst = str(body.get("to", "")).strip()
            if not src or not dst or src == dst:
                return self._json({"hosts": load_entries()})
            entries = [{"host": e["host"], "group": dst if e["group"] == src else e["group"]}
                       for e in load_entries()]
            seen, merged = set(), []
            for e in entries:  # 重名分组合并后可能出现重复主机, 去重
                key = (e["group"], e["host"])
                if key not in seen:
                    seen.add(key)
                    merged.append(e)
            save_entries(merged)
            self._json({"hosts": merged})
        else:
            self._json({"error": "not found"}, 404)

    def do_DELETE(self):
        if _bad_host(self):
            return
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
        if parsed.path == "/api/hosts":
            host = (qs.get("host") or [""])[0].strip()
            group = (qs.get("group") or [""])[0].strip()
            entries = [e for e in load_entries() if not (e["host"] == host and e["group"] == group)]
            save_entries(entries)
            self._json({"hosts": entries})
        elif parsed.path == "/api/groups":
            group = (qs.get("group") or [""])[0].strip()
            entries = [e for e in load_entries() if e["group"] != group]
            save_entries(entries)
            self._json({"hosts": entries})
        elif parsed.path == "/api/tasks":
            if not self._token_ok():
                return self._json({"error": "校验失败，请刷新页面后重试"}, 403)
            try:
                tasks.delete((qs.get("id") or [""])[0])
                self._json({"ok": True})
            except tasks.TaskError as e:
                self._json({"error": str(e)}, 400)
        else:
            self._json({"error": "not found"}, 404)


def main():
    ap = argparse.ArgumentParser(description="GPU 监控网页")
    ap.add_argument("--bind", default="127.0.0.1", help="监听地址 (默认 127.0.0.1, 仅本机可访问)")
    ap.add_argument("--port", type=int, default=8799)
    ap.add_argument("--allow-host", action="append", default=[], metavar="HOST[:PORT]",
                    help="监听本机时额外允许的 Host 头 (经反向代理访问时用), 可重复")
    sub = ap.add_subparsers(dest="cmd")
    q = sub.add_parser("query", help="直接查询 GPU 状态并输出 JSON (供 agent/脚本调用), 不启动服务")
    q.add_argument("group", nargs="?", help="分组名 (如 H200, 忽略大小写); 省略则查询全部主机")
    q.add_argument("--brief", action="store_true", help="每张卡只返回显存占用和占用显存的容器名")
    args = ap.parse_args()
    if args.cmd == "query":
        out = query_group(args.group, args.brief)
        print(json.dumps(out, indent=2, ensure_ascii=False))
        raise SystemExit(0 if out["ok"] else 1)
    global ALLOWED_HOSTS
    if args.bind in ("127.0.0.1", "localhost", "::1"):
        ALLOWED_HOSTS = {f"{h}:{args.port}" for h in ("127.0.0.1", "localhost", "[::1]")}
        ALLOWED_HOSTS |= {h.lower() for h in args.allow_host}
    srv = ThreadingHTTPServer((args.bind, args.port), Handler)
    tasks.recover()
    shown = args.bind if args.bind not in ("0.0.0.0", "::") else "127.0.0.1"
    print("GPU Monitor 已启动: http://%s:%d  (Ctrl+C 退出)" % (shown, args.port))
    print("提示: 在网页中添加的主机需可免密 ssh 登录 (ssh <host> 不提示输密码), 且装有 nvidia-smi")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")


if __name__ == "__main__":
    main()
