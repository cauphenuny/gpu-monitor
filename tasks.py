"""任务: 在多台主机上各拉起一个容器, 组成互通的 ssh mesh (同平台的 MPI 环境:
/root/mpi_hostfile + 容器间 `ssh root@<ip>` 免密), 全部就绪后在 head (第一台) 上跑 entrypoint.

每个任务一个目录 tasks/<id>/: task.json (配置与状态), launch.log (拉起过程), output.log
(entrypoint 输出). entrypoint 在容器里后台运行, 本服务重启后重新接上输出; 容器保留到手动停止.
"""

import io
import json
import os
import posixpath
import re
import secrets
import shlex
import shutil
import subprocess
import tarfile
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

TASKS_DIR = Path(__file__).resolve().parent / "tasks"
SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15",
            "-o", "StrictHostKeyChecking=accept-new",
            # OpenSSH 10.1+ 对未升级的服务端打 post-quantum 警告, 会混进报错; 旧客户端不认识该选项, 用 IgnoreUnknown 兜住
            "-o", "IgnoreUnknown=WarnWeakCrypto", "-o", "WarnWeakCrypto=no"]
SSH_PORT = 2222  # host network 下宿主机 sshd 占了 22. ponytail: 固定端口, 同一主机同时跑两个任务会冲突
GPUMON_DIR = "/root/.gpumon"
# --ipc private: 每个容器自己的 /dev/shm, 大小由额外参数里的 --shm-size 决定 (--ipc host 下 --shm-size 会被忽略), 删容器即释放
DOCKER_BASE = ["--gpus", "all", "--network", "host", "--ipc", "private", "--privileged",
               "--cap-add", "IPC_LOCK", "--ulimit", "memlock=-1:-1",
               "--entrypoint", "sleep"]  # 镜像自带的 ENTRYPOINT 可能不接受 `infinity` 参数
RESERVED_DST = ("/root/.ssh", "/root/.gpumon", "/root/mpi_hostfile")  # 挂进来会改写宿主机上的文件
ACTIVE = ("launching", "running")
LOG_CHUNK = 256 * 1024
LOG_TAIL = 1024 * 1024  # offset<0 (页面「跳到末尾」) 只读最后 1MB, 大日志不至于撑爆页面

ENV_KEY = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
IMAGE_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._/:@-]*")
IFNAME_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")
PREFIX_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,39}")
TASK_ID_RE = re.compile(r"\d{14}-[0-9a-f]{4}")
PROXY_RE = re.compile(r"[A-Za-z][A-Za-z0-9+.-]*://[^\s'\"]+|[A-Za-z0-9._-]+:\d+")

SSH_CONFIG = """Host {ips}
  User root
  Port {port}
  IdentityFile /root/.ssh/id_ed25519
  StrictHostKeyChecking no
  UserKnownHostsFile /dev/null
  LogLevel ERROR
  ConnectTimeout 5
"""

# 容器内: 装/起 sshd, 只监听互连网卡 IP. ssh 会话默认拿不到容器 env (镜像 ENV + 任务 env),
# 把 docker exec 看到的环境写进 ~/.ssh/environment, 让 `ssh root@ip cmd` 拿到同一套变量;
# 关掉 PAM: 否则 pam_env 会用镜像的 /etc/environment 覆盖 PATH (如丢掉 /opt/torch/bin), 互连只用 key 登录, 不需要 PAM.
SETUP_SCRIPT = """set -e
if ! command -v sshd >/dev/null && [ ! -x /usr/sbin/sshd ]; then
  echo "[setup] 镜像里没有 sshd, 用 apt 安装 openssh-server{proxy_note}" >&2
  {proxy_env}
  # policy-rc.d 拦住 postinst 自动起 sshd (宿主机 sshd 已占 22, 起不来会让安装报错)
  [ -e /usr/sbin/policy-rc.d ] || {{ printf '#!/bin/sh\\nexit 101\\n' > /usr/sbin/policy-rc.d; chmod +x /usr/sbin/policy-rc.d; rm_policy=1; }}
  apt-get update -qq
  echo "[setup] apt-get update 完成, 开始安装" >&2
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends openssh-server openssh-client >/dev/null
  [ -z "${{rm_policy:-}}" ] || rm -f /usr/sbin/policy-rc.d
  echo "[setup] openssh-server 安装完成" >&2
fi
mkdir -p /run/sshd && ssh-keygen -A >/dev/null
env | grep -vE '^(HOME|HOSTNAME|PWD|OLDPWD|SHLVL|_|https?_proxy|HTTPS?_PROXY)=' > /root/.ssh/environment
echo "[setup] 启动 sshd {ip}:{port}" >&2
/usr/sbin/sshd -p {port} -o ListenAddress={ip} -o PermitRootLogin=prohibit-password -o PermitUserEnvironment=yes -o UsePAM=no -o MaxStartups=200
"""

# host 网络下各容器的 sshd 共用宿主机端口, 且 sshd 绑定失败时仍返回 0, 所以拉起前先查占用,
# 并报出占用者: 按监听进程的 cgroup 找到所属容器, 找不到就是宿主机进程
PORT_CHECK = r"""if (exec 3<>/dev/tcp/$ip/__PORT__) 2>/dev/null; then
  who="未知进程 (无权限查看)"
  pid=$(ss -ltnpH "sport = :__PORT__" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
  if [ -n "$pid" ]; then
    cmd=$(ps -o args= -p "$pid" 2>/dev/null | cut -c1-80)
    cid=$(grep -oE '[0-9a-f]{64}' "/proc/$pid/cgroup" 2>/dev/null | head -1)
    name=$([ -n "$cid" ] && timeout 5 docker inspect -f '{{.Name}}' "$cid" 2>/dev/null | sed 's#^/##')
    if [ -n "$name" ]; then who="容器 $name 里的进程 $pid ($cmd)"; else who="宿主机进程 $pid ($cmd)"; fi
  fi
  echo "$ip:__PORT__ 已被$who占用, 请先停掉它" >&2; exit 1
fi""".replace("__PORT__", str(SSH_PORT))

_lock = threading.Lock()
_ctx = threading.local()  # 拉起线程/每台主机的工作线程里记下当前任务, _ssh 据此把详细 trace 写进启动日志
DEBUG_RE = re.compile(rb"^\d\d:\d\d:\d\d (\[[^\]]*\] )?DEBUG ")


class TaskError(Exception):
    pass


class _Stopped(Exception):
    pass


# ---- 配置解析 ----

def _lines(text):
    for n, line in enumerate(str(text or "").splitlines(), 1):
        line = line.strip()
        if line and not line.startswith("#"):
            yield n, line


def parse_env(text):
    """每行 [export ]KEY=VALUE, # 开头为注释; VALUE 外层成对的引号去掉, 不做 shell 展开."""
    env = []
    for n, line in _lines(text):
        if line.startswith("export "):
            line = line[7:].lstrip()
        key, eq, val = line.partition("=")
        if not eq or not ENV_KEY.fullmatch(key):
            raise TaskError(f"环境变量第 {n} 行应为 [export ]KEY=VALUE: {line}")
        if len(val) >= 2 and val[0] == val[-1] and val[0] in "'\"":
            val = val[1:-1]
        env.append((key, val))
    return env


def parse_mounts(text):
    """每行 src[:dst[:ro]], dst 省略时同 src; 都必须是绝对路径."""
    mounts = []
    for n, line in _lines(text):
        parts = line.split(":")
        if len(parts) > 3 or (len(parts) == 3 and parts[2] != "ro"):
            raise TaskError(f"挂载第 {n} 行应为 src[:dst[:ro]]: {line}")
        src = parts[0]
        dst = parts[1] if len(parts) > 1 and parts[1] else src
        if not src.startswith("/") or not dst.startswith("/"):
            raise TaskError(f"挂载第 {n} 行需为绝对路径: {line}")
        d = posixpath.normpath(dst)
        if any(d == r or d.startswith(r + "/") or r.startswith(d.rstrip("/") + "/") for r in RESERVED_DST):
            raise TaskError(f"挂载第 {n} 行的目标会覆盖 {'、'.join(RESERVED_DST)}: {line}")
        mounts.append((src, dst, len(parts) == 3))
    return mounts


def validate(cfg, known_hosts):
    """校验并规整前端提交的 config; env/mounts 保留原文, 复制任务时原样带回."""
    if not isinstance(cfg, dict):
        raise TaskError("config 必须是对象")
    out = {k: str(cfg.get(k) or "") for k in ("image", "ifname", "env", "mounts", "entrypoint", "docker_args", "proxy")}
    out["image"], out["ifname"], out["proxy"] = out["image"].strip(), out["ifname"].strip(), out["proxy"].strip()
    if out["proxy"] and not PROXY_RE.fullmatch(out["proxy"]):
        raise TaskError("代理格式应为 http://host:port 或 host:port")
    if not IMAGE_RE.fullmatch(out["image"]):
        raise TaskError("镜像名无效")
    if not IFNAME_RE.fullmatch(out["ifname"]):
        raise TaskError("网卡名无效")
    hosts = cfg.get("hosts")
    if not isinstance(hosts, list) or not hosts or not all(isinstance(h, str) for h in hosts):
        raise TaskError("请至少选择一台主机")
    if len(set(hosts)) != len(hosts):
        raise TaskError("主机重复")
    unknown = [h for h in hosts if h not in known_hosts]
    if unknown:
        raise TaskError("主机未配置: " + ", ".join(unknown))
    out["hosts"] = hosts
    parse_env(out["env"])
    parse_mounts(out["mounts"])
    try:
        shlex.split(out["docker_args"])
    except ValueError as e:
        raise TaskError(f"docker 参数无法解析: {e}")
    return out


def setup_script(ip, proxy=""):
    """容器内装/起 sshd; proxy 只在 apt 安装期间生效, 不写进容器环境."""
    q = shlex.quote(proxy if "://" in proxy else f"http://{proxy}") if proxy else ""
    return SETUP_SCRIPT.format(
        port=SSH_PORT, ip=ip, proxy_note=f" (代理 {proxy})" if proxy else "",
        proxy_env=f"export http_proxy={q} https_proxy={q} HTTP_PROXY={q} HTTPS_PROXY={q}" if proxy else ":")


def docker_run_cmd(name, cfg, env, mounts):
    cmd = ["docker", "run", "-d", "--name", name, *DOCKER_BASE, *shlex.split(cfg["docker_args"])]
    for k, v in env:
        cmd += ["-e", f"{k}={v}"]
    for src, dst, ro in mounts:
        cmd += ["-v", f"{src}:{dst}" + (":ro" if ro else "")]
    return cmd + [cfg["image"], "infinity"]  # 配合 DOCKER_BASE 的 --entrypoint sleep


def docker_run_record(name, cfg, env, mounts):
    """任务记录里展示的 docker run 选项: 实际执行的全部参数, 去掉 --name 和镜像 (及其后的命令), 每个选项一行."""
    cmd = docker_run_cmd(name, cfg, env, mounts)
    opts = cmd[2:-2]  # 去掉 "docker run" 和末尾的 镜像 + infinity
    i = opts.index("--name")
    del opts[i:i + 2]
    lines = []
    for a in opts:
        if a.startswith("-") or not lines:
            lines.append([a])
        else:
            lines[-1].append(a)
    return "docker run " + " \\\n  ".join(shlex.join(l) for l in lines)


def build_bundle(comment, ips, hostfile, entrypoint):
    """推进每个容器 /root 的 tar: 共用的一次性 ssh key、ssh config、mpi_hostfile、entrypoint."""
    with tempfile.TemporaryDirectory() as d:
        subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", comment, "-f", f"{d}/id"],
                       check=True, capture_output=True)
        priv, pub = Path(d, "id").read_bytes(), Path(d, "id.pub").read_bytes()
    files = {
        ".ssh/id_ed25519": (priv, 0o600), ".ssh/id_ed25519.pub": (pub, 0o644),
        ".ssh/authorized_keys": (pub, 0o600), ".ssh/config": (SSH_CONFIG.format(ips=" ".join(ips), port=SSH_PORT).encode(), 0o600),
        "mpi_hostfile": (hostfile.encode(), 0o644), ".gpumon/entrypoint.sh": (entrypoint.encode(), 0o755),
    }
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tar:
        for d, mode in ((".ssh", 0o700), (".gpumon", 0o755)):
            ti = tarfile.TarInfo(d)
            ti.type, ti.mode = tarfile.DIRTYPE, mode
            tar.addfile(ti)
        for path, (data, mode) in files.items():
            ti = tarfile.TarInfo(path)
            ti.size, ti.mode, ti.mtime = len(data), mode, int(time.time())
            tar.addfile(ti, io.BytesIO(data))
    return buf.getvalue()


# ---- 持久化 ----

def _dir(tid):
    if not TASK_ID_RE.fullmatch(str(tid)):
        raise TaskError("任务不存在")
    return TASKS_DIR / tid


def get(tid):
    try:
        return json.loads((_dir(tid) / "task.json").read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise TaskError("任务不存在")


def _save(t):
    p = _dir(t["id"]) / "task.json"
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(t, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    tmp.replace(p)


def update(tid, **kw):
    with _lock:
        t = get(tid)
        t.update(kw)
        _save(t)
        return t


def _set_node(tid, host, **kw):
    with _lock:
        t = get(tid)
        for n in t["nodes"]:
            if n["host"] == host:
                n.update(kw)
        _save(t)


def _finish(tid, status, error=None):
    """只有仍在进行中的任务才落终态, 避免和「停止」互相覆盖."""
    with _lock:
        t = get(tid)
        if t["status"] in ACTIVE and not t["stop_requested"]:
            t.update(status=status, error=error, ended=time.time())
            _save(t)
        return t


def _advance(tid, **kw):
    """拉起线程推进状态; 用户已点停止则中止, 不覆盖 stopped."""
    with _lock:
        t = get(tid)
        if t["stop_requested"]:
            raise _Stopped()
        t.update(kw)
        _save(t)


def list_tasks():
    out = []
    for p in TASKS_DIR.glob("*/task.json"):
        try:
            out.append(json.loads(p.read_text(encoding="utf-8")))
        except (OSError, ValueError):
            pass
    return sorted(out, key=lambda t: t["created"], reverse=True)


def _log(tid, msg, host=None, debug=False):
    line = time.strftime("%H:%M:%S ") + (f"[{host}] " if host else "") + ("DEBUG " if debug else "") + str(msg).rstrip() + "\n"
    with _lock, open(_dir(tid) / "launch.log", "a", encoding="utf-8") as f:
        f.write(line)


def _clip(data, start, size, tail):
    """把读到的一段字节规整成可直接显示的文本块, 返回 (data, start).
    tail: 从文件中间开始读的, 跳过第一行残片; 后面还有内容时按整行截断; 读到 EOF 时把写到一半的多字节字符留给下次."""
    if tail and start > 0 and b"\n" in data:
        cut = data.index(b"\n") + 1
        data, start = data[cut:], start + cut
    if start + len(data) < size and b"\n" in data:
        data = data[:data.rindex(b"\n") + 1]
    elif data and not data.endswith(b"\n"):
        for i in range(1, min(4, len(data)) + 1):
            if data[-i] & 0xC0 != 0x80:
                need = 1 if data[-i] < 0x80 else 2 if data[-i] >> 5 == 6 else 3 if data[-i] >> 4 == 14 else 4
                if need > i:
                    data = data[:-i]
                break
    return data, start


def read_log(tid, which, offset, debug=False):
    """从 offset 字节起读日志; offset<0 表示只读最后 LOG_TAIL 字节. 按整行切, 不截断多字节字符.
    启动日志默认滤掉 DEBUG 行 (每条远端命令的 trace), debug=True 才返回; offset 仍按文件字节算."""
    p = _dir(tid) / ("output.log" if which == "output" else "launch.log")
    try:
        with open(p, "rb") as f:
            size = os.fstat(f.fileno()).st_size
            start = max(0, size - LOG_TAIL) if offset < 0 else min(offset, size)
            f.seek(start)
            data = f.read(min(LOG_CHUNK, size - start))
    except FileNotFoundError:
        return {"text": "", "offset": max(offset, 0), "more": False}
    data, start = _clip(data, start, size, offset < 0)
    end = start + len(data)
    if which != "output" and not debug:
        data = b"".join(l for l in data.splitlines(keepends=True) if not DEBUG_RE.match(l))
    return {"text": data.decode("utf-8", "replace"), "offset": end, "more": end < size}


# ---- 远端执行 ----

# 外层 ssh 经跳板机, 偶发连接重置/断开; 这些报错重试通常就能过. 超时不重试 (可能在跑长命令)
_TRANSIENT = re.compile(r"kex_exchange_identification|connection reset|connection closed|broken pipe|"
                        r"connection timed out|connection refused|could not resolve hostname", re.I)


def _run_ssh(host, cmd, timeout, input, tid):
    """跑一次 ssh, 返回 (rc, stdout, stderr); 有 tid 时 stderr 逐行实时写成 DEBUG 日志."""
    p = subprocess.Popen(["ssh", *SSH_OPTS, "--", host, cmd], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                         stdin=subprocess.PIPE if input is not None else subprocess.DEVNULL)
    out, err = [], []

    def pump(stream, buf, live):
        for line in stream:
            buf.append(line)
            s = line.decode(errors="replace").rstrip()
            if live and s and not s.startswith("Warning: Permanently added"):
                _log(tid, "  " + s, host, debug=True)
    readers = [threading.Thread(target=pump, args=(p.stdout, out, False), daemon=True),
               threading.Thread(target=pump, args=(p.stderr, err, bool(tid)), daemon=True)]
    for r in readers:
        r.start()
    if input is not None:
        try:
            p.stdin.write(input)
            p.stdin.close()
        except BrokenPipeError:
            pass
    try:
        p.wait(timeout)
    except subprocess.TimeoutExpired:
        p.kill()
        p.wait()
        raise TaskError(f"{host}: 超时 ({timeout}s)")
    for r in readers:
        r.join()
    return p.returncode, b"".join(out), b"".join(err)


def _ssh(host, cmd, timeout=120, input=None, attempts=3, raw=False):
    tid = getattr(_ctx, "tid", None)
    for i in range(attempts):
        t0 = time.monotonic()
        if tid:
            first = cmd.splitlines()[0] if cmd else ""
            _log(tid, f"$ {first[:200]}{' …' if len(first) > 200 or chr(10) in cmd else ''}", host, debug=True)
        rc, out, err = _run_ssh(host, cmd, timeout, input, tid)
        if tid:
            _log(tid, f"→ 退出码 {rc}, {time.monotonic() - t0:.1f}s", host, debug=True)
        if not rc:
            return out if raw else out.decode(errors="replace")
        msg = (err or out).decode(errors="replace").strip()
        if i < attempts - 1 and rc == 255 and _TRANSIENT.search(msg):
            if tid:
                _log(tid, f"ssh 瞬断, {2 * (i + 1)}s 后重试 ({i + 2}/{attempts})", host)
            time.sleep(2 * (i + 1))
            continue
        raise TaskError(f"{host}: {msg or f'退出码 {rc}'}")
    raise TaskError(f"{host}: 不可达")


def _bash(script):
    return shlex.join(["bash", "-c", script])


def _in(name, script, *flags):
    return shlex.join(["docker", "exec", "-u", "root", *flags, name, "bash", "-c", script])


def _each(tid, hosts, fn):
    """所有主机并行跑 fn(host), 返回 {host: 结果}; 任一失败则汇总报错."""
    with ThreadPoolExecutor(len(hosts)) as ex:
        futs = [(h, ex.submit(fn, h)) for h in hosts]
    out, errs = {}, []
    for h, f in futs:
        try:
            out[h] = f.result()
        except Exception as e:
            errs.append(str(e))
            _log(tid, f"失败: {e}", h)
            _set_node(tid, h, state="失败")
    if errs:
        raise TaskError("; ".join(errs))
    return out


def _remove_containers(t):
    def rm(h):
        # 只有 docker 明确说没有这个容器才算删掉; dockerd 不通时 inspect 也会失败, 不能当成功
        name = shlex.quote(t["container"])
        _ssh(h, _bash(f"docker rm -f {name} >/dev/null 2>&1; docker inspect {name} 2>&1 | grep -qi 'no such'"),
             timeout=60)
    errs = []
    with ThreadPoolExecutor(len(t["config"]["hosts"])) as ex:
        for h, f in [(h, ex.submit(rm, h)) for h in t["config"]["hosts"]]:
            try:
                f.result()
            except TaskError as e:
                errs.append(str(e))
    return errs


# ---- 生命周期 ----

def _bg(fn, *args):
    threading.Thread(target=fn, args=args, daemon=True).start()


def _name(name):
    name = str(name or "").strip()
    if not name or len(name) > 100:
        raise TaskError("名称不能为空且不超过 100 字")
    return name


def rename(tid, name):
    return update(tid, name=_name(name))


def set_note(tid, note):
    """备注可任意文本, 空串表示清除."""
    return update(tid, note=str(note or ""))


def create(name, note, cfg, prefix):
    name = _name(name)
    if not PREFIX_RE.fullmatch(prefix):
        raise TaskError("容器名前缀无效, 请在设置里修改")
    tid = time.strftime("%Y%m%d%H%M%S") + "-" + secrets.token_hex(2)
    _dir(tid).mkdir(parents=True)
    container = f"{prefix}-{tid}"
    t = {"id": tid, "name": name, "note": str(note or ""), "config": cfg, "container": container,
         "docker_run": docker_run_record(container, cfg, [("MLP_TASK_ID", tid), *parse_env(cfg["env"])],
                                         parse_mounts(cfg["mounts"])),
         "status": "launching", "error": None, "containers_up": False, "stop_requested": False,
         "launch_active": True,  # 拉起线程还在跑; 期间 docker run 可能晚于「停止」的删除
         "created": time.time(), "started": None, "ended": None,
         "nodes": [{"host": h, "ip": None, "gpus": None, "state": "等待"} for h in cfg["hosts"]]}
    with _lock:
        _save(t)
    _bg(_launch, tid)
    return t


def _launch(tid):
    _ctx.tid = tid  # 只 trace 拉起过程; 之后的 _follow 轮询不记
    try:
        running = _bring_up(tid)
    finally:
        _ctx.tid = None
        try:
            update(tid, launch_active=False)
        except TaskError:  # 停止后已被删除
            return
    if running:
        _follow(tid)


def _bring_up(tid):
    """拉起全部容器并在 head 上启动 entrypoint; 返回是否需要跟随输出."""
    t = get(tid)
    cfg, name = t["config"], t["container"]
    hosts, head = cfg["hosts"], cfg["hosts"][0]
    env = [("MLP_TASK_ID", tid), *parse_env(cfg["env"])]  # 平台同名变量, launch 脚本用它命名日志目录
    mounts = parse_mounts(cfg["mounts"])

    def stage(state, fn):
        if get(tid)["stop_requested"]:
            raise _Stopped()

        def run(h):
            _ctx.tid = tid
            try:
                _set_node(tid, h, state=state)
                _log(tid, state, h)
                t0 = time.monotonic()
                r = fn(h)
                _log(tid, f"{state} 完成, {time.monotonic() - t0:.1f}s", h)
                return r
            finally:
                _ctx.tid = None
        return _each(tid, hosts, run)

    def preflight(h):
        # docker -v 遇到不存在的源会静默建空目录, 先查
        srcs = " ".join(shlex.quote(m[0]) for m in mounts)
        ifname = shlex.quote(cfg["ifname"])
        out = _ssh(h, _bash(f"""set -e
for p in {srcs}; do [ -e "$p" ] || {{ echo "挂载源不存在: $p" >&2; exit 1; }}; done
ip=$(ip -4 -o addr show dev {ifname} | awk '{{split($4, a, "/"); print a[1]; exit}}')
[ -n "$ip" ] || {{ echo "网卡 {ifname} 上没有 IPv4" >&2; exit 1; }}
{PORT_CHECK}
echo "$ip $(nvidia-smi -L | grep -c ^GPU)"
"""), timeout=60)
        ip, gpus = out.split()
        if not re.fullmatch(r"\d{1,3}(\.\d{1,3}){3}", ip):
            raise TaskError(f"{h}: 网卡地址无效: {ip}")
        _set_node(tid, h, ip=ip, gpus=int(gpus))
        return ip, int(gpus)

    def setup(h):
        _ssh(h, shlex.join(["docker", "exec", "-u", "root", "-i", name, "tar", "--no-same-owner", "-xf", "-", "-C", "/root"]),
             input=bundle)
        _ssh(h, _in(name, setup_script(info[h][0], cfg.get("proxy", ""))), timeout=600)

    def mesh(h):
        _ssh(h, _in(name, f"for ip in {' '.join(ips)}; do ssh -o BatchMode=yes root@$ip true "
                          f"|| {{ echo \"ssh root@$ip 不通\" >&2; exit 1; }}; done"))
        _set_node(tid, h, state="就绪")

    try:
        info = stage("检查主机", preflight)
        image = shlex.quote(cfg["image"])
        stage("拉取镜像", lambda h: _ssh(h, _bash(f"docker image inspect {image} >/dev/null 2>&1 "
                                              f"|| docker pull -q {image}"), timeout=3600))
        _advance(tid, containers_up=True)
        stage("启动容器", lambda h: _ssh(h, shlex.join(docker_run_cmd(name, cfg, env, mounts))))
        ips = [info[h][0] for h in hosts]  # 已在 preflight 校验为 IPv4, 可直接拼进脚本
        bundle = build_bundle(name, ips, "".join(f"{info[h][0]} slots={info[h][1]}\n" for h in hosts), cfg["entrypoint"])
        stage("配置 ssh", setup)
        stage("互连检查", mesh)
        if not cfg["entrypoint"].strip():
            _advance(tid, status="running", started=time.time())
            _log(tid, "全部就绪; 未填写 entrypoint, 容器保持运行")
            return False
        _advance(tid)  # 停止了就别再起 entrypoint
        # 工作目录用镜像的 WORKDIR, 只有输出和退出码写到 GPUMON_DIR
        _ssh(head, _in(name, f"bash {GPUMON_DIR}/entrypoint.sh > {GPUMON_DIR}/output.log 2>&1; "
                             f"echo $? > {GPUMON_DIR}/rc.tmp && mv {GPUMON_DIR}/rc.tmp {GPUMON_DIR}/rc", "-d"))
        _advance(tid, status="running", started=time.time())
        _log(tid, "全部就绪, entrypoint 已在 head 上启动", head)
        return True
    except Exception as e:
        t = get(tid)
        if t["stop_requested"]:
            errs = _remove_containers(t)  # 停止时可能有容器正在创建, 由拉起线程再清一遍并收尾
            update(tid, containers_up=bool(errs))
            _log(tid, "已停止, 拉起中断" + (f"; 部分容器删除失败: {'; '.join(errs)}" if errs else ""))
        else:
            _log(tid, f"拉起失败: {e}")
            _finish(tid, "failed", str(e))
        return False


def _follow(tid):
    """把 head 容器里的 entrypoint 输出追加到本地 output.log, 断线从本地已有字节数续传."""
    t = get(tid)
    name, head = t["container"], t["config"]["hosts"][0]
    out = _dir(tid) / "output.log"
    while get(tid)["status"] == "running":
        off = out.stat().st_size if out.exists() else 0
        # entrypoint 已结束就读到 EOF 自然退出; 否则跟随, 结束后多等 1 秒再停
        script = (f"cd {GPUMON_DIR} && if [ -f rc ]; then tail -c +{off + 1} output.log; else "
                  f"{{ tail -c +{off + 1} -F output.log 2>/dev/null & t=$!; "
                  "while [ ! -f rc ]; do sleep 2; done; sleep 1; kill $t; }; fi")
        try:
            p = subprocess.Popen(["ssh", *SSH_OPTS, "--", head, _in(name, script)],
                                 stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            with open(out, "ab") as f:
                for chunk in iter(lambda: p.stdout.read1(65536), b""):
                    f.write(chunk)
                    f.flush()
            p.wait()
        except OSError:
            pass
        try:
            rc, size = map(int, _ssh(head, _in(name, f"cat {GPUMON_DIR}/rc && stat -c %s {GPUMON_DIR}/output.log")).split())
            if size > (out.stat().st_size if out.exists() else 0):
                continue  # 断线期间积压的输出还没传完, 再续一轮
        except (TaskError, ValueError):
            try:
                alive = _ssh(head, _bash(f"docker inspect -f '{{{{.State.Running}}}}' {shlex.quote(name)} 2>&1 || true"))
            except TaskError:
                alive = "true"  # ssh 本身不通, 稍后重试
            if alive.strip() != "true" and get(tid)["status"] == "running":
                _log(tid, "head 上的容器已退出", head)
                return _finish(tid, "failed", "head 上的容器已退出")
            time.sleep(5)
            continue
        _log(tid, f"entrypoint 结束, 退出码 {rc}", head)
        return _finish(tid, "succeeded" if rc == 0 else "failed", None if rc == 0 else f"entrypoint 退出码 {rc}")


# ---- head 容器里的文件 (实时日志面板) ----

REMOTE_TAIL = 64 * 1024  # 首次打开远端文件只看最后 64KB


def _head_container(tid, path):
    t = get(tid)
    if not t["containers_up"]:
        raise TaskError("容器已清理, 无法查看")
    path = str(path or "").strip()
    if not path.startswith("/") or "\n" in path:
        raise TaskError("路径须为容器内的绝对路径")
    return t["config"]["hosts"][0], t["container"], path


def list_files(tid, path):
    """列出 head 容器里 path 下的文件 (最多 3 层, 200 个); path 是文件时只返回它自己."""
    head, name, path = _head_container(tid, path)
    script = (f"p={shlex.quote(path)}; [ -e \"$p\" ] || {{ echo \"不存在: $p\" >&2; exit 1; }}; "
              "if [ -f \"$p\" ]; then stat -c '%s %Y' -- \"$p\" | tr '\\n' ' '; echo; "
              "else cd -- \"$p\" && find -L . -maxdepth 3 -type f -printf '%s %T@ %P\\n' 2>/dev/null | sort -k3 | head -200; fi")
    out = _ssh(head, _in(name, script), timeout=30)
    files = []
    for line in out.splitlines():
        parts = line.split(" ", 2)
        if len(parts) >= 2:
            files.append({"name": parts[2] if len(parts) == 3 and parts[2] else "", "size": int(parts[0]),
                          "mtime": float(parts[1])})
    return {"path": path, "files": files}


def read_remote(tid, path, offset):
    """增量读 head 容器里的文件, 用法同 read_log; 文件被截断/轮转 (变得比 offset 小) 时 reset=True 从头读."""
    head, name, path = _head_container(tid, path)
    q = shlex.quote(path)
    out = _ssh(head, _in(name, f"s=$(stat -L -c %s -- {q}) || exit 1; o={int(offset)}; r=0; "
                               f"[ $o -lt 0 ] && o=$(( s > {REMOTE_TAIL} ? s - {REMOTE_TAIL} : 0 )); "
                               "[ $o -gt $s ] && { o=0; r=1; }; echo \"$s $o $r\"; "
                               f"tail -c +$((o + 1)) -- {q} | head -c {LOG_CHUNK}"), timeout=30, raw=True)
    head_line, _, data = out.partition(b"\n")
    size, start, reset = map(int, head_line.split())
    data, start = _clip(data, start, size, offset < 0 or reset)
    end = start + len(data)
    return {"text": data.decode("utf-8", "replace"), "offset": end, "more": end < size, "size": size,
            "reset": bool(reset)}


def stop(tid):
    with _lock:
        t = get(tid)
        t["stop_requested"] = True
        if t["status"] in ACTIVE:
            t.update(status="stopped", ended=time.time())
        _save(t)
    errs = _remove_containers(t)
    with _lock:
        t = get(tid)
        # 拉起线程还在时, docker run 可能晚于这次删除: containers_up 留给它再删一遍后清掉
        if not t.get("launch_active"):
            t["containers_up"] = bool(errs)
            _save(t)
    _log(tid, "已停止, 容器已删除" if not errs else "停止时部分容器删除失败: " + "; ".join(errs))
    return t, errs


def delete(tid):
    t = get(tid)
    if t["status"] in ACTIVE or t["containers_up"]:
        raise TaskError("请先停止任务")
    shutil.rmtree(_dir(tid))


def recover():
    """服务启动时调用: 拉起中断的标失败; 运行中的接回 entrypoint 输出."""
    for t in list_tasks():
        if t.get("launch_active"):
            update(t["id"], launch_active=False)
        if t["status"] == "launching":
            _log(t["id"], "gpumon 服务重启, 拉起过程中断")
            _finish(t["id"], "failed", "gpumon 服务重启, 拉起过程中断")
        elif t["status"] == "running" and t["config"]["entrypoint"].strip():
            _bg(_follow, t["id"])
