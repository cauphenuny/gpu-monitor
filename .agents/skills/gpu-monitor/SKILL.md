---
name: gpu-monitor
description: 通过本机 gpu-monitor 服务查询 GPU 集群状态、挑选空闲机器、提交/停止/删除容器任务并跟踪日志。当用户要看 GPU 占用、找空闲卡、在多台主机上拉起互连容器跑任务、看任务日志或停任务时使用。服务默认在 http://127.0.0.1:8799。
---

# gpu-monitor 操作手册

服务默认 `http://127.0.0.1:8799`（下面记为 `$MON`）。只读接口直接 GET；
写接口需要页面令牌，从服务自己伺服的 JS 里取（令牌随进程重启轮换，收到 403 就重取）：

```bash
MON=http://127.0.0.1:8799
TOKEN=$(curl -s $MON/common.js | grep -o "clearToken = '[^']*'" | cut -d"'" -f2)
```

写请求固定带 `-H "Content-Type: application/json" -H "X-GPUMon-Token: $TOKEN"`。
用 `127.0.0.1`/`localhost` 访问即可满足 Host 校验。

## 只读：看状态、挑机器

```bash
curl -s "$MON/api/status?group=H200&brief=1"   # brief: 每机只剩 ok/错误/禁用 + 每卡显存和容器名
curl -s "$MON/api/tasks"                        # 任务列表
curl -s "$MON/api/tasks?id=<任务ID>"            # 单个任务: 状态、节点(ip/gpu数/阶段)、完整 docker run 参数
```

不需要服务在跑时也可以 `python3 server.py query [分组] [--brief]`（在 repo 目录执行）。

挑机器规则：
- 跳过 `disabled` 非 null 的主机（被人工标注不可用）和 `ok: false` 的。
- 卡的忙闲标准：利用率 ≥5% 或显存占用 ≥10%；全闲的机器才适合交新任务。
- `stale: true` 表示这是服务内存里的旧数据，看 `data_age_seconds` 判断可信度。
- 主机列表（合法的 `hosts` 取值）来自 `curl -s $MON/api/hosts`。

## 写：提交任务

`POST $MON/api/tasks`，body `{"name", "note", "config": {...}}`，config 字段：

| 字段 | 说明 |
|---|---|
| image | 镜像，必填 |
| hosts | 主机数组，**顺序即 /root/mpi_hostfile 顺序，第 1 台是 head**，entrypoint 只在 head 上跑 |
| nodes | 节点数量（1~64），必须与 hosts 数量一致，否则拒绝创建 |
| ifname | 互连网卡名，默认 `bond0`；预检会读它的 IPv4，读不到直接失败 |
| env | 每行 `[export ]KEY=VALUE`，`#` 注释；不做 shell 展开 |
| mounts | 每行 `src[:dst[:ro]]` 绝对路径；src 必须在每台主机存在；dst 不能覆盖 `/root/.ssh` 等 |
| entrypoint | 容器全部就绪后在 head 上用 bash 执行；留空只拉起容器 |
| docker_args | 额外 docker run 参数，如 `--shm-size 1500g --memory 1780g`（已固定 `--gpus all --network host --ipc private --privileged --entrypoint sleep`） |
| proxy | 可选，镜像缺 sshd 时 apt 走的代理，`http://host:port` |

```bash
curl -s -X POST $MON/api/tasks -H "Content-Type: application/json" -H "X-GPUMon-Token: $TOKEN" -d '{
  "name": "pd-test", "note": "desc",
  "config": {"image": "zcr.zhipuai-infra.cn/infra/sglang:v0.5.10-xxx",
    "hosts": ["zp-h200-003", "zp-h200-004"], "nodes": 2, "ifname": "bond0",
    "env": "PREFILL_REPLICAS=1\nDECODE_REPLICAS=1",
    "mounts": "/mnt/ceph/workspace/ycp/code/looplm",
    "entrypoint": "bash /mnt/ceph/workspace/ycp/code/looplm/utils/launch/platform-b300-pd.sh",
    "docker_args": "--shm-size 1500g --memory 1780g"}}'
```

返回新任务（含 `id`）。拉起流程：检查主机(挂载/网卡/GPU数/2222端口占用) → 拉镜像 → 起容器 →
推 ssh key/hostfile → 容器内起 sshd → N×N 互连检查 → head 上跑 entrypoint。
节点表里的 `state` 字段跟踪每台到哪一步。

## 跟踪任务

```bash
curl -s "$MON/api/tasks/log?id=<ID>&which=launch&offset=-1"          # 启动日志, 简要
curl -s "$MON/api/tasks/log?id=<ID>&which=launch&offset=-1&level=debug"  # 详细: 每条远端命令/stderr/耗时
curl -s "$MON/api/tasks/log?id=<ID>&which=output&offset=-1"          # entrypoint 输出
curl -s "$MON/api/tasks/files?id=<ID>&path=/logs"                     # 列 head 容器 /logs 下的文件
curl -s "$MON/api/tasks/tail?id=<ID>&path=/logs/prefill_g0.log&offset=-1"   # 实时 tail 单个文件
```

`offset=-1` 读最后一小段；把返回的 `offset` 带回下次请求即增量轮询。
任务状态机：`launching → running → succeeded/failed/stopped`。

## 写：停止 / 删除 / 改名

```bash
curl -s -X POST $MON/api/tasks/stop   -H ..token.. -d '{"id":"<ID>"}'   # 所有主机 docker rm -f
curl -s -X POST $MON/api/tasks/rename -H ..token.. -d '{"id":"<ID>","name":"新名字"}'
curl -s -X POST $MON/api/tasks/note   -H ..token.. -d '{"id":"<ID>","note":"备注"}'   # 空串清除
curl -s -X DELETE "$MON/api/tasks?id=<ID>" -H "X-GPUMon-Token: $TOKEN"  # 须先停止
```

失败的任务也要点一次停止来清理残留容器。容器保留到手动停止，方便 `ssh <host> docker exec -it <容器名> bash` 进去看现场；容器名是 `tasks?id=` 返回的 `container` 字段。

## 其他写操作

- 清空某台主机的 GPU 占用（占卡进程在容器里时 `docker stop -t 0` 整个容器）：
  `POST /api/hosts/clear {"host": "x", "confirmation": "x"}`（confirmation 必须逐字等于 host）。
- 改容器名前缀（默认 gpumon）：`POST /api/settings {"docker_prefix": "ycp"}`。
- 更新服务本身（git pull 后自重启，令牌随之轮换）：`POST /api/update`；已是最新时不动。
