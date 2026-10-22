# gpu-monitor

一个本地网页，集中查看多台 Linux 主机上 NVIDIA GPU 的**利用率 / 显存占用 / 温度 / 功耗 / 占卡进程**。支持主机分组、分组折叠/重命名，紧凑视图一屏可见更多服务器。

## 使用

```bash
cd gpu-monitor
python3 server.py            # 默认监听 http://127.0.0.1:8799
# python3 server.py --port 9000 --bind 0.0.0.0   # 可选: 换端口 / 局域网可访问
```

浏览器打开 <http://127.0.0.1:8799>，在右上角输入主机名（如 `lab-gpu-01`、`user@10.0.0.5`，或 `~/.ssh/config` 里的别名），可选填分组，点添加即可。页面默认每 10 秒自动刷新，可切换 5/10/30/60 秒或手动。

## 界面

- **紧凑卡片**：每张 GPU 两行（型号/温度/功耗 + 利用率/显存双进度条），点击 GPU 行展开该卡上的进程（第一行 Docker 容器名、第二行命令名，右侧显示 PID、占用显存和已运行时长；无容器名时只显示命令名，长名称悬停查看完整内容）
- **分组**：添加主机时填写分组即可归组；分组栏支持折叠（状态记忆在浏览器里）、重命名（重名自动合并）、整组删除，并显示该组的在线/忙闲汇总
- **排序**：顶栏分段按钮切换 手动 / 名称 / 空闲优先 / 忙碌优先（选择记忆在浏览器里）；手动模式下可拖拽卡片调整顺序、拖到别的分组即移动分组，顺序持久化到 `hosts.json`
- **总览**：顶栏全局汇总"几台在线 · 共几张卡 · 几忙几闲"，方便找空闲卡
- 每台主机显示 ssh 延迟；连不上的直接在卡片上显示 ssh 的错误原因
- **临时禁用**：卡片上的「禁用」按钮把机器标注为现在不准使用（可填原因），卡片显示红色斜纹和原因，该机的卡不计入忙闲、空闲/忙碌排序时垫底；仍照常监控。按机器记录（同一主机在多个分组都生效），保存在 `hosts.json` 的 `disabled`，其他人打开的页面下次刷新即同步。点「启用」解除
- **一键清空**：服务器卡片上的按钮要求输入完全一致的服务器名，确认后重新查询并强制终止该服务器所有 NVIDIA GPU 进程（包括计算/图形任务），每 5 秒复查一次，最多等待 3 分钟确认清空，提前清空即返回；返回终止失败和仍在占卡的 PID。未保存的进度会丢失，自动拉起的任务可能再次占卡。

## 前提条件

- 仅依赖 Python 3 标准库，无需 `pip install`。
- 目标主机需可**免密 ssh 登录**（`ssh <主机>` 不提示输密码，密钥或 ssh 别名均可），且装有 `nvidia-smi`。
- 显示 Docker 容器名需 SSH 用户能执行 `docker ps`、读取进程的 `/proc/<pid>/cgroup`，并有 Linux 常见的 `timeout` 命令。无权限、Docker 不可用或无法匹配时显示原进程名。
- 同一台主机可以同时属于多个分组（只会查询一次）。
- 清空需目标服务器有 Python 3.9+ 和 Linux pidfd 支持，SSH 用户有终止目标进程的权限；不会自动使用 sudo。仅使用默认的本机监听或可信网络访问，本工具没有用户认证。

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

旧版本的纯主机名列表格式会在读取时自动迁移，无需手动处理。

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

## 文件

- `server.py` — HTTP 服务 + ssh 采集
- `index.html` — 单文件前端，无构建依赖
- `hosts.json` — 运行后自动生成的主机/分组配置
