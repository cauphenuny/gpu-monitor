# gpu-monitor

一个本地网页，集中查看多台 Linux 主机上 NVIDIA GPU 的**利用率 / 显存占用 / 温度 / 功耗 / 占卡进程**。支持主机分组、分组折叠/重命名，紧凑视图一屏可见更多服务器。另有任务页，可在多台主机上一键拉起互连的容器并运行 entrypoint。

## 使用

```bash
cd gpu-monitor
python3 server.py            # 默认监听 http://127.0.0.1:8799
# python3 server.py --port 9000 --bind 0.0.0.0   # 可选: 换端口 / 局域网可访问
# python3 server.py --allow-host gpu.example.com   # 经反向代理访问时允许该 Host 头
```

浏览器打开 <http://127.0.0.1:8799>，在右上角输入主机名（如 `lab-gpu-01`、`user@10.0.0.5`，或 `~/.ssh/config` 里的别名），可选填分组，点添加即可。页面默认每 10 秒自动刷新，可切换 5/10/30/60 秒或手动。

## 界面

- **紧凑卡片**：每张 GPU 两行（型号/温度/功耗 + 利用率/显存双进度条），点击 GPU 行展开该卡上的进程（第一行 Docker 容器名、第二行命令名，右侧显示 PID、占用显存和已运行时长；无容器名时只显示命令名，长名称悬停查看完整内容）
- **分组**：添加主机时填写分组即可归组；分组栏支持折叠（状态记忆在浏览器里）、重命名（重名自动合并）、整组删除，并显示该组的在线/忙闲汇总
- **排序**：顶栏分段按钮切换 手动 / 名称 / 空闲优先 / 忙碌优先（选择记忆在浏览器里）；手动模式下可拖拽卡片调整顺序、拖到别的分组即移动分组，顺序持久化到 `hosts.json`
- **总览**：顶栏全局汇总"几台在线 · 共几张卡 · 几忙几闲"，方便找空闲卡
- 每台主机显示 ssh 延迟；连不上的直接在卡片上显示 ssh 的错误原因
- **临时禁用**：卡片上的「禁用」按钮把机器标注为现在不准使用（可填原因），卡片显示红色斜纹和原因，该机的卡不计入忙闲、空闲/忙碌排序时垫底；仍照常监控。按机器记录（同一主机在多个分组都生效），保存在 `hosts.json` 的 `disabled`，其他人打开的页面下次刷新即同步。点「启用」解除
- **一键清空**：服务器卡片上的按钮要求输入完全一致的服务器名，确认后重新查询并强制终止该服务器所有 NVIDIA GPU 进程（包括计算/图形任务）。占卡的进程属于容器时改用 `docker stop -t 0` 停掉整个容器（SIGKILL，不留孤儿进程），其余进程仍直接 SIGKILL。每 5 秒复查一次，最多等待 3 分钟确认清空，提前清空即返回；返回终止失败和仍在占卡的 PID。未保存的进度会丢失，自动拉起的任务可能再次占卡。
- **任务页**（顶栏「监控 / 任务」切换，地址 `/tasks`）：在多台主机上各起一个容器，组成互通的 ssh 环境（`/root/mpi_hostfile` + 容器间免密 `ssh root@<ip>`），全部就绪后在第一台（head）容器里运行 entrypoint
  - **列表**：名称、任务 ID、备注、状态（启动中/运行中/已完成/失败/已停止）、主机、创建时间、运行时长；有进行中的任务时每 5 秒刷新
  - **新建/复制**：右上角「新建任务」；列表或详情页的「复制」用已有任务的名称、备注和配置预填表单。字段：
    - 名称（必填，不超过 100 字）、备注
    - 镜像
    - 主机：从监控页已添加的主机里按分组点选，**点选顺序即 hostfile 顺序**，第 1 台为 head；已禁用的主机会标出，但仍可选
    - 网卡：默认 `bond0`，取该网卡的 IPv4 作为容器互连和 hostfile 地址
    - 环境变量：每行 `[export ]KEY=VALUE`，`#` 开头为注释；VALUE 外层成对的引号会去掉，不做 shell 展开
    - 安装 sshd 用的代理（可选）：镜像里没有 sshd 时 apt 走这个代理（`http_proxy`/`https_proxy`），只在安装期间生效，不写进容器环境变量
    - 挂载：每行 `src[:dst[:ro]]`，dst 省略时同 src，须为绝对路径；src 须在每台主机上存在。dst 不能是 `/`、`/root`，也不能覆盖 `/root/.ssh`、`/root/.gpumon`、`/root/mpi_hostfile`（否则推入的 ssh 文件会改写宿主机上的同名文件）
    - Entrypoint：bash 脚本，在 head 容器里执行；留空则只拉起容器
    - docker run 额外参数：按 shell 规则拆分后追加，默认 `--shm-size 1500g --memory 1780g --ulimit stack=67108864:67108864`
  - **详情**：任务 ID、容器名、镜像、创建/entrypoint 启动/结束时间、运行时长、失败原因；节点表（序号与 head 标记、主机、网卡 IP、GPU 数、当前阶段）；「实时日志」面板（输入 head 容器内的目录或文件路径，默认 `/logs`，列出其中的文件，点文件名每 2 秒增量追加显示，类似 `tail -f`，首次只读最后 64KB）；可展开的「配置」（含实际执行的完整 `docker run` 参数，不含 `--name` 和镜像）；「entrypoint 输出」与「启动日志」两个页签，默认从开头加载、超过 1MB 只显示开头部分，可点「跳到末尾并跟随」改看最后 1MB 并持续追加；任务进行中每 2 秒刷新
  - 失败状态分两种颜色：容器还在的显示红色（可进容器查现场），容器已清理的显示灰色（同已停止）
  - **停止**：在所有主机上 `docker rm -f` 删除容器，entrypoint 和容器内未保存的数据都会丢失；部分主机删除失败会提示，可再次点停止重试。**删除**：仅在任务已结束且容器已删除后可用，删除该任务的配置和日志
  - **设置**：顶栏「设置」修改 Docker 容器名前缀（默认 `gpumon`，只能含字母、数字、`_ . -`，以字母或数字开头，最长 40 字符），容器名为「前缀-任务ID」；保存在 `hosts.json` 的 `settings.docker_prefix`，只影响之后新建的任务

## 前提条件

- 仅依赖 Python 3 标准库，无需 `pip install`。
- 目标主机需可**免密 ssh 登录**（`ssh <主机>` 不提示输密码，密钥或 ssh 别名均可），且装有 `nvidia-smi`。
- 显示 Docker 容器名需 SSH 用户能执行 `docker ps`、读取进程的 `/proc/<pid>/cgroup`，并有 Linux 常见的 `timeout` 命令。无权限、Docker 不可用或无法匹配时显示原进程名。
- 同一台主机可以同时属于多个分组（只会查询一次）。
- 清空需目标服务器有 Python 3.9+ 和 Linux pidfd 支持，SSH 用户有终止目标进程（及 `docker stop` 占卡容器）的权限；不会自动使用 sudo。仅使用默认的本机监听或可信网络访问，本工具没有用户认证。监听本机（默认）时只接受 Host 头为 `127.0.0.1`/`localhost`/`[::1]` 加端口的请求，防止恶意网页借 DNS rebinding 读到页面令牌后提交任务；经反向代理访问时用 `--allow-host` 添加代理的 Host。
- 任务：目标主机上 ssh 用户能直接执行 `docker`（不会使用 sudo）且支持 `--gpus all`，有 `ip` 和 `nvidia-smi` 命令；镜像里需有 `bash` 和 `tar`。镜像里没有 sshd 时会用 `apt-get` 安装 `openssh-server`，需要容器能联网（可在任务环境变量里设 `http_proxy`/`https_proxy`）。本机需要 `ssh-keygen`。
- 任务会在目标主机上起特权容器并执行任意命令；写操作带页面令牌防跨站触发，但同样没有用户认证。

## 工作原理

浏览器 → 本机 `server.py` → 并行 `ssh` 到各主机执行：

```
nvidia-smi --query-gpu=index,uuid,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits
nvidia-smi --query-compute-apps=gpu_uuid,pid,process_name,used_memory --format=csv,noheader,nounits
```

同一次 SSH 查询还会读取 `docker ps --no-trunc`（最多等待 3 秒）和 GPU 进程的 cgroup，按容器 ID 匹配 Docker 容器名，支持 cgroup v1/v2。结果按 GPU UUID 关联进程后汇总成 JSON 返回页面渲染；进程的 `name` 保留原命令名，`container` 为匹配到的容器名或 `null`。

进程已运行时长通过 Linux `ps -o pid=,etimes=` 按 GPU 进程 PID 批量查询，API 字段 `elapsed_seconds` 单位为秒；查询不到为 `null`，页面显示 `--`。时长截至本次采集，随刷新更新，表示进程本身的运行时间。

配置保存在同目录 `hosts.json`：

```json
{ "hosts": [ {"host": "lab-gpu-01", "group": "机房1"}, {"host": "lab-gpu-02", "group": "机房1"} ] }
```

`hosts.json` 不纳入 git（含禁用原因等运行时数据）。没有该文件时从空列表开始；想用现成的主机列表可先 `cp example/hosts.json hosts.json`。旧版本的纯主机名列表格式会在读取时自动迁移，无需手动处理。

### 任务

提交后由后台线程按阶段推进，每个阶段所有主机并行执行，任一主机失败即任务失败（已创建的容器不会自动删除，需点「停止」清理）：

1. **检查主机**：确认各挂载源存在（`docker -v` 遇到不存在的源会静默建空目录，所以先查），读取网卡的 IPv4 和 `nvidia-smi -L` 的 GPU 数
2. **拉取镜像**：主机上已有该镜像则跳过，否则 `docker pull`
3. **启动容器**：`docker run -d --name <前缀-任务ID>`，固定带 `--gpus all --network host --ipc private --privileged --cap-add IPC_LOCK --ulimit memlock=-1:-1`，再追加额外参数（`/dev/shm` 大小在这里用 `--shm-size` 指定，不写只有 docker 默认的 64MB）、环境变量（`-e`）和挂载（`-v`），用 `--entrypoint sleep` 覆盖镜像自带的 ENTRYPOINT，实际执行 `sleep infinity`（额外参数里再写 `--entrypoint` 可覆盖，此时镜像名后的参数为 `infinity`）；额外注入 `MLP_TASK_ID=<任务ID>`
4. **配置 ssh**：本机用 `ssh-keygen` 生成一把本任务专用的 ed25519 密钥，连同 `~/.ssh/config`（只对本任务各主机的互连 IP 生效：`User root`、`Port 2222`、不校验 host key，不影响容器里其他 ssh/git）、`/root/mpi_hostfile`（按主机顺序每行 `<ip> slots=<GPU 数>`）和 entrypoint 一起推入每个容器的 `/root`；容器内没有 sshd 时用 apt 安装，然后在 2222 端口起 sshd，只监听互连网卡 IP；并把 `docker exec` 看到的环境变量写入 `~/.ssh/environment`，使 `ssh root@<ip> cmd` 与 `docker exec` 看到同一套环境变量（sshd 关闭 PAM，否则 pam_env 会用镜像的 `/etc/environment` 覆盖 PATH）
5. **互连检查**：每个容器逐个 `ssh root@<ip> true` 所有节点（含自己），N×N 全通才算就绪
6. **运行**：在 head 容器里以 root 后台执行 `bash /root/.gpumon/entrypoint.sh`（工作目录为镜像的 WORKDIR），stdout/stderr 写入容器内 `/root/.gpumon/output.log`，本服务经 ssh 持续拉回本地；结束后按退出码记为已完成（0）或失败。未填 entrypoint 时容器就绪即记为运行中

所有远端操作都经本机 ssh；遇到连接重置、连接被关等 ssh 自身的瞬断（常见于经跳板机并发连接）会自动重试，最多 3 次，超时不重试。启动日志记录每台主机每一步的耗时；勾选「详细」还会显示每条远端命令、它实时输出的 stderr（如 apt 安装进度）和退出码。

容器保留到手动停止，entrypoint 结束后也不会删除；head 容器意外退出时任务记为失败。服务重启后，运行中的任务会从本地已有的字节数续传、重新接上输出；拉起过程中被打断的任务记为失败。

任务数据存在 `tasks/<任务ID>/`（已加入 `.gitignore`）：`task.json` 为配置与状态，`launch.log` 为启动日志，`output.log` 为 entrypoint 输出。任务 ID 形如 `20261027153000-a1b2`。

### 已知限制

- 容器内 sshd 端口固定为 2222（host 网络下宿主机 sshd 已占 22），同一主机同时跑两个任务会冲突；「检查主机」阶段会探测该端口，被占用时直接报错。

## 命令行查询（给 agent / 脚本用）

```bash
python3 server.py query H200   # 只查 H200 分组（忽略大小写），输出缩进 JSON 到 stdout
python3 server.py query        # 查全部主机
python3 server.py query H200 --brief   # 精简输出, HTTP 等价于 /api/status?group=H200&brief=1
```

`brief` 模式每台主机只保留 `host`/`ok`/`error`/`stale`/`data_age_seconds`/`disabled`，每张卡只有 `index`、`mem_used`、`mem_total`（MiB）和 `containers`（占用该卡显存的容器名，去重；不在容器里的进程不列出）。

不需要先启动网页服务。输出 `{"ok", "ts", "group", "results"}`，`results` 与 `/api/status` 相同；分组不存在时输出 `{"ok": false, "error", "groups": [可选分组]}` 并以退出码 1 结束。单台主机连不上不影响退出码，看各自的 `ok`/`error`。

每台主机结果带 `disabled`：`null` 表示可用，被临时禁用时为原因字符串（未填为 `"未注明原因"`），agent 挑机器时应跳过非 `null` 的主机。

每台主机结果带 `stale` 和 `data_age_seconds`：本次查询失败时（`ok: false`，`error` 为原因），若服务进程里有该主机上一次成功的数据，则 `gpus` 返回那份数据，`stale: true`，`data_age_seconds` 为距那次采集的秒数；从没成功过则 `gpus` 为空、`data_age_seconds: null`。旧数据只存在内存里，所以 agent 应调用常驻的 HTTP 服务，命令行单次查询没有可回退的数据。

## API

- `GET /api/hosts` — 主机列表和 `disabled` 禁用表；`POST /api/hosts` `{"host":..,"group":..}` 添加；`DELETE /api/hosts?host=..&group=..` 移除
- `POST /api/hosts/disable` `{"host":..,"disabled":true,"reason":"维修中"}` 临时禁用，`{"host":..,"disabled":false}` 解除；返回最新 `disabled` 表
- `POST /api/hosts/reorder` `{"hosts":[{host,group}..]}` — 按给定顺序整表保存（拖拽排序用）
- `POST /api/groups/rename` `{"from":..,"to":..}` 重命名/合并分组；`DELETE /api/groups?group=..` 删除分组及其主机
- `GET /api/status` — 并行查询所有主机并返回 GPU 状态；`GET /api/status?group=H200` 只查该分组（忽略大小写，中文分组名需 URL 编码），分组不存在返回 404 和 `groups` 可选分组列表。结构同下方命令行查询
- `POST /api/hosts/clear` — JSON `{"host":"lab-gpu-01","confirmation":"lab-gpu-01"}`，页面自动携带 `X-GPUMon-Token` 随机令牌防止跨站触发，兼容 HTTPS/代理访问；服务重启后需刷新页面。服务器需已配置且确认名逐字一致；重新查询 GPU 任务并通过 pidfd 发送 SIGKILL，避免 PID 复用误杀。返回 `ok`、`killed`、`failed`、`remaining` 和 `error`。

任务与设置接口（下列 POST/DELETE 需带 `X-GPUMon-Token` 页面令牌，否则返回 403）：

- `GET /api/tasks` — 任务列表 `{"tasks":[..]}`，按创建时间倒序；`GET /api/tasks?id=..` 单个任务，不存在返回 404。`status` 为 `launching`/`running`/`succeeded`/`failed`/`stopped`，`nodes` 为各节点的 `host`/`ip`/`gpus`/`state`
- `GET /api/tasks/log?id=..&which=output|launch&offset=..` — 从 `offset` 字节起读 entrypoint 输出（`output`）或启动日志（`launch`），每次最多 256KB、按整行切；`offset<0`（省略时默认 -1）表示只读最后 1MB。返回 `text`、下次请求用的 `offset`，以及 `more`（是否还有未读内容）
- `POST /api/tasks` `{"name":..,"note":..,"config":{"image","ifname","hosts":[..],"env","mounts","entrypoint","docker_args"}}` — 校验后立即返回新任务，后台拉起；`hosts` 须为已配置的主机，顺序即 hostfile 顺序
- `GET /api/tasks/files?id=..&path=..` — 列出 head 容器内该目录下的文件（最多 3 层、200 个；path 为文件时只返回它自己），返回 `files: [{name, size, mtime}]`
- `GET /api/tasks/tail?id=..&path=..&offset=..` — 增量读 head 容器内的文件，用法同 `/api/tasks/log`；`offset<0` 读最后 64KB；文件被截断或轮转时返回 `reset: true` 并从头读
- `POST /api/update` — 任务页「更新」按钮：在服务目录执行 `git pull --ff-only`，拉到新代码后服务用 `execv` 重新执行自己（同样的端口/参数），失败时返回 git 输出且不重启
- `POST /api/tasks/rename` `{"id":..,"name":..}` — 修改任务名称（详情页点击名称）
- `POST /api/tasks/note` `{"id":..,"note":..}` — 修改备注（详情页点击备注，空串清除）
- `POST /api/tasks/stop` `{"id":..}` — 删除所有主机上的容器，返回 `{"task":..,"errors":[..]}`
- `DELETE /api/tasks?id=..` — 删除任务记录和日志；任务进行中或容器未删除时返回 400
- `GET /api/settings` 返回 `{"docker_prefix":..}`；`POST /api/settings` `{"docker_prefix":..}` 修改容器名前缀

## 文件

- `server.py` — HTTP 服务 + ssh 采集
- `tasks.py` — 任务的拉起、日志、停止与持久化
- `index.html` — 监控页结构
- `tasks.html` — 任务页结构
- `style.css` — 样式（深色主题）
- `app.js` — 监控页前端逻辑，无构建依赖
- `tasks.js` — 任务页前端逻辑
- `common.js` — 两个页面共用的工具函数和弹窗
- `test_tasks.py` — 任务模块的单元测试
- `hosts.json` — 运行后自动生成的主机/分组配置、禁用记录和设置（已加入 `.gitignore`）
- `example/hosts.json` — 示例主机列表，只有主机和分组
- `tasks/` — 运行后自动生成的任务数据
