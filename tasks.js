const STATUS = {launching: ['启动中', 'warn'], running: ['运行中', 'ok'], succeeded: ['已完成', 'done'],
  failed: ['失败', 'hot'], stopped: ['已停止', 'muted']};
const ACTIVE = ['launching', 'running'];
const LOG_HEAD = 1024 * 1024;   // 默认只看日志开头这么多字节, 超出的点「跳到末尾」再看
const JSON_KEYS = ['name', 'note', 'image', 'ifname', 'nodes', 'env', 'mounts', 'entrypoint', 'docker_args', 'proxy', 'ports_head', 'ports_nodes'];   // 导入/导出剪贴板的字段, 不含主机
const DEFAULTS = {image: '', ifname: 'bond0', hosts: [], nodes: 2, env: '', mounts: '', entrypoint: '', proxy: '',
  docker_args: '--shm-size 1500g --memory 1780g --ulimit stack=67108864:67108864', ports_head: '', ports_nodes: ''};
let pollTimer = null;
let clusterFilter = null;   // 顶栏集群筛选下拉, 跨轮询复用
const seenTasks = new Set();   // 首次出现的任务行才播入场动画, 轮询重绘不动 (同监控页 seenCards)
let reanimList = false;   // 从详情/表单返回列表时整体重播一次
let lastRoute = '';
const animIn = (el, i) => { el.classList.add('in'); el.style.setProperty('--i', Math.min(i, 12)); };

async function api(url, opts = {}){
  const r = await fetch(url, {...opts, headers: {'Content-Type': 'application/json', 'X-GPUMon-Token': clearToken}});
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || r.statusText);
  return d;
}
const post = (url, body) => api(url, {method: 'POST', body: JSON.stringify(body)});

// 横向分段选择 (同监控页 .seg 风格): items 为 [{value,label}]
function segControl(wrap, items, {value, onChange, title = ''} = {}){
  let val = value ?? items[0]?.value ?? '';
  const render = () => {
    wrap.classList.add('seg');
    wrap.title = title;
    wrap.innerHTML = items.map(i => `<button type="button" data-v="${esc(i.value)}" class="${i.value === val ? 'on' : ''}">${esc(i.label)}</button>`).join('');
  };
  const api = {
    get value(){ return val; },
    set value(v){ api.set(v); },
    set(v, silent = false){
      if (v === val) return;
      val = v; render();
      if (!silent) onChange?.(val);
    },
    setOptions(next){ items = next; if (!items.some(i => i.value === val)) val = items[0]?.value ?? ''; render(); },
  };
  wrap.addEventListener('click', e => { const b = e.target.closest('[data-v]'); if (b) api.set(b.dataset.v); });
  render();
  return api;
}

const getTask = id => api('/api/tasks?id=' + encodeURIComponent(id));
const fmtBytes = n => n >= 1 << 30 ? (n / (1 << 30)).toFixed(1) + ' GB' : n >= 1 << 20 ? (n / (1 << 20)).toFixed(1) + ' MB' : n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B';
const fmtTime = ts => ts ? new Date(ts * 1000).toLocaleString('zh-CN', {hour12: false}) : '--';
// 终态分两种: 容器还在的 (成功=蓝 失败=红, 现场可查) 和容器已清理的 (只剩记录, 用已停止的灰色)
const badge = t => {
  const s = typeof t === 'string' ? t : t.status;
  const cls = (s === 'failed' || s === 'succeeded') && t?.containers_up === false ? '' : STATUS[s]?.[1] || '';
  return `<span class="badge ${cls}">${STATUS[s]?.[0] || esc(s)}</span>`;
};
const runFor = t => t.started ? fmtDuration((t.ended || Date.now() / 1000) - t.started) : '--';

// 全屏: 任何 .fs-wrap 里放一个 fsBtn, 点一下铺满窗口, 再点或 Esc 退回
const fsBtn = '<button type="button" class="fs-btn" data-fs title="全屏 (Esc 退出)" aria-label="全屏"><svg viewBox="0 0 16 16" aria-hidden="true"><path class="on" d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4"/><path class="off" d="M6 2v4H2M14 6h-4V2M10 14v-4h4M2 10h4v4"/></svg></button>';
const fsWrap = (inner, attrs = '') => `<div class="fs-wrap"${attrs}>${inner}${fsBtn}</div>`;
function setFs(wrap, on){
  wrap.classList.toggle('fs', on);
  (wrap.querySelector('textarea') || wrap.querySelector('[data-fs]')).focus();
}
document.addEventListener('click', e => {
  const wrap = e.target.closest('[data-fs]')?.closest('.fs-wrap');
  if (wrap) setFs(wrap, !wrap.classList.contains('fs'));
});
document.addEventListener('keydown', e => {
  const wrap = document.querySelector('.fs-wrap.fs');
  if (e.key === 'Escape' && wrap && !document.querySelector('dialog[open]')){ e.preventDefault(); setFs(wrap, false); }
});

async function route(){
  clearTimeout(pollTimer);
  const h = decodeURIComponent(location.hash.slice(1));
  if (!h && lastRoute) reanimList = true;   // 返回列表: 行重新入场一次
  lastRoute = h;
  try{
    if (!h) await showList();
    else if (h === 'new' || h.startsWith('new/')) await showForm(h.slice(4));
    else await showTask(h);
  }catch(e){
    $('#view').innerHTML = `<div class="hint">${esc(e.message)}<br><a href="#">返回任务列表</a></div>`;
  }
}

async function showList(){
  const [{tasks}, {hosts: entries}] = await Promise.all([api('/api/tasks'), api('/api/hosts')]);
  if (location.hash.slice(1)) return;
  const clusters = [...new Set([...entries.map(e => e.group), ...tasks.map(t => t.config.cluster)])].filter(c => c).sort();
  const items = [{value: '__all', label: '全部集群'}, ...clusters.map(c => ({value: c, label: c}))];
  const sel = clusterFilter ??= segControl($('#clusterSel'), items, {
    title: '按集群（主机分组）筛选任务列表',
    onChange: v => { localStorage.setItem('gpumon.clusterFilter', v); reanimList = true; showList(); },
  });
  const cur = localStorage.getItem('gpumon.clusterFilter') ?? '__all';
  sel.setOptions(items);
  sel.set(items.some(i => i.value === cur) ? cur : '__all', true);   // 轮询刷新不重新触发筛选
  const shown = sel.value === '__all' ? tasks : tasks.filter(t => t.config.cluster === sel.value);
  const y = window.scrollY;   // innerHTML 整体替换会让文档高度瞬间塌掉, 浏览器把滚动钳到顶; 重绘后恢复
  $('#view').innerHTML = shown.length ? `<table class="tbl panel"><thead><tr><th>名称</th><th>状态</th><th>主机</th>
    <th>创建时间</th><th>运行时长</th><th></th></tr></thead><tbody>${shown.map((t, i) => `<tr${seenTasks.has(t.id) && !reanimList ? '' : ` class="in" style="--i:${Math.min(i, 12)}"`}>
      <td><a href="#${t.id}">${esc(t.name)}</a><div class="sub">${t.id}${t.creator ? ' · ' + esc(t.creator) : ''}${t.note ? ' · ' + esc(t.note) : ''}</div></td>
      <td>${badge(t)}</td><td class="hosts">${t.config.hosts.map(esc).join('<br>')}</td>
      <td>${fmtTime(t.created)}</td><td>${runFor(t)}</td>
      <td class="acts"><a class="btn sm" href="#new/${t.id}">复制</a></td></tr>`).join('')}</tbody></table>`
    : `<div class="hint">还没有任务${sel.value === '__all' ? '' : `（集群 ${esc(sel.value)}）`}，点右上角「新建任务」</div>`;
  shown.forEach(t => seenTasks.add(t.id));
  reanimList = false;
  window.scrollTo(0, y);
  if (tasks.some(t => ACTIVE.includes(t.status))) pollTimer = setTimeout(route, 5000);
}

async function showForm(fromId){
  const [{hosts: entries, disabled}, src] = await Promise.all([api('/api/hosts'), fromId ? getTask(fromId) : null]);
  const cfg = {...DEFAULTS, ...src?.config};
  const groups = new Map();
  for (const e of entries){
    if (!groups.has(e.group)) groups.set(e.group, []);
    if (!groups.get(e.group).includes(e.host)) groups.get(e.group).push(e.host);
  }
  let picked = cfg.hosts.filter(h => entries.some(e => e.host === h));   // 勾选顺序即 hostfile 顺序
  let load = new Map();   // host → /api/status 结果; 查询要几秒, 先画名字, 到了再补负载
  const groupsOf = h => new Set(entries.filter(e => e.host === h).map(e => e.group));
  const clusterSel = () => $('#taskForm').elements.cluster.value;   // 表单渲染完才会被调用
  const field = (label, hint, input) => `<label class="field"><span>${label}${hint ? ` <small>${hint}</small>` : ''}</span>${input}</label>`;
  const area = (name, rows, mono = true) => `<textarea name="${name}" rows="${rows}" spellcheck="false"${mono ? ' class="mono"' : ''}>${esc(cfg[name])}</textarea>`;
  $('#view').innerHTML = `<form id="taskForm" class="form panel">
    <div class="form-h"><a href="#" class="back">‹ 任务</a><h2>${src ? '复制任务' : '新建任务'}</h2><span class="gspace"></span>
      <button type="button" class="btn" data-json="import" title="从剪贴板读取 JSON 填入表单（不含主机）">导入 JSON</button>
      <button type="button" class="btn" data-json="export" title="把除主机以外的配置以 JSON 复制到剪贴板">导出 JSON</button></div>
    ${field('名称', '', `<input name="name" required maxlength="100" value="${esc(src?.name || '')}">`)}
    ${field('备注', '', `<textarea name="note" rows="2">${esc(src?.note || '')}</textarea>`)}
    ${field('镜像', '', `<input name="image" required class="mono" spellcheck="false" value="${esc(cfg.image)}">`)}
    ${field('集群', '选某个分组后只能选该分组的主机；「自动」时点第一台主机自动锁定其所在集群', `<input type="hidden" name="cluster" value="${esc(cfg.cluster || '')}"><div id="clusterDD"></div>`)}
    ${field('节点数量', '', `<input name="nodes" type="number" min="1" max="64" required value="${src?.config.nodes || src?.config.hosts?.length || cfg.nodes}">`)}
    <div class="field"><span>主机 <small>按点选顺序写入 /root/mpi_hostfile，第 1 台为主节点，入口脚本在主节点上执行 · <b id="pickCnt"></b></small></span><div id="hostPick"></div></div>
    ${field('网卡', '取该网卡的 IPv4 作为容器互连与 hostfile 地址', `<input name="ifname" required class="mono" value="${esc(cfg.ifname)}">`)}
    ${field('端口占用 · 主节点', '逗号/空格分隔；启动前检查主节点上这些端口是否空闲，被占用则报错并指出占用者', `<input name="ports_head" class="mono" spellcheck="false" placeholder="如 30000,29000" value="${esc(cfg.ports_head || '')}">`)}
    ${field('端口占用 · 普通节点', '逗号/空格分隔；检查除主节点外每个节点上的这些端口', `<input name="ports_nodes" class="mono" spellcheck="false" placeholder="如 8080" value="${esc(cfg.ports_nodes || '')}">`)}
    ${field('环境变量', '每行 [export ]KEY=VALUE，# 开头为注释；不做 shell 展开', fsWrap(area('env', 8)))}
    ${field('挂载', '每行 src[:dst[:ro]]，dst 省略时同 src；src 须在每台主机上存在', area('mounts', 4))}
    ${field('入口脚本', '全部容器就绪后在主节点上用 bash 执行，stdout/stderr 记录到任务输出；留空则只拉起容器', fsWrap(area('entrypoint', 16)))}
    ${field('安装 sshd 用的代理', '可选，如 http://proxy:8888；镜像里没有 sshd 时 apt 走这个代理，只在安装时生效，不进容器环境变量', `<input name="proxy" class="mono" spellcheck="false" placeholder="不填则直连" value="${esc(cfg.proxy || '')}">`)}
    ${field('docker run 额外参数', '已固定 --gpus all --network host --ipc private --privileged；/dev/shm 大小用 --shm-size 指定，不写则只有 docker 默认的 64MB', `<input name="docker_args" class="mono" spellcheck="false" value="${esc(cfg.docker_args)}">`)}
    <div class="form-a"><a class="btn ghost" href="#">取消</a><button class="primary" type="submit">提交</button></div>
  </form>`;
  const drawPick = () => {
    const c = clusterSel();
    $('#pickCnt').textContent = `已选 ${picked.length} / 需 ${$('#taskForm').elements.nodes.value || '?'}`;
    $('#hostPick').innerHTML = [...groups].map(([g, hs]) => {
      const vis = hs.filter(h => !c || groupsOf(h).has(c));
      if (!vis.length) return '';   // 该集群没有可选主机时整行不渲染, 不留孤零零的分组名
      return `<div class="pick-g"><span class="pick-gn">${esc(g || '未分组')}</span>${vis.map(h => {
      const i = picked.indexOf(h);
      return `<button type="button" class="chip${i >= 0 ? ' on' : ''}${i === 0 ? ' head' : ''}" data-h="${esc(h)}" aria-pressed="${i >= 0}"${disabled[h] ? ` title="已禁用：${esc(disabled[h])}"` : ''}>
        ${i >= 0 ? `<b>${i + 1}</b>` : ''}${esc(h)}${i === 0 ? '<span class="badge ok">主节点</span>' : ''}${loadHTML(load.get(h))}${disabled[h] ? '<span class="badge hot">禁用</span>' : ''}</button>`;
      }).join('')}</div>`;
    }).join('') || '<div class="sub">还没有主机，先在监控页添加</div>';
  };
  const form = $('#taskForm');
  const listCluster = clusterFilter?.value;   // 列表筛选的集群作为新建默认值; 复制任务时用原任务自己的
  const clusterDD = segControl($('#clusterDD'), [{value: '', label: '自动'},
    ...[...groups.keys()].filter(g => g).map(g => ({value: g, label: g}))],
    {value: cfg.cluster || (listCluster && listCluster !== '__all' ? listCluster : ''), title: '选某个分组后只能选该分组的主机',
     onChange: v => { form.elements.cluster.value = v; form.elements.cluster.dispatchEvent(new Event('change')); }});   // 隐藏 input 同步并触发过滤
  form.elements.cluster.value = clusterDD.value;   // 初始默认值 (列表联动/复制) 也要写进隐藏 input 并过滤
  [...form.children].forEach(animIn);   // 字段依次入场, 只在建表单时播一次
  drawPick();
  form.elements.nodes.addEventListener('input', drawPick);
  form.elements.cluster.addEventListener('change', () => {   // 换集群 (下拉或自动锁定触发): 留下还属于它的已选主机
    const c = clusterSel();
    picked = picked.filter(h => !c || groupsOf(h).has(c));
    drawPick();
  });
  api('/api/status').then(d => {
    load = new Map(d.results.map(r => [r.host, r]));
    if ($('#hostPick')) drawPick();
  }).catch(() => {});
  $('#hostPick').addEventListener('click', e => {
    const h = e.target.closest('[data-h]')?.dataset.h;
    if (!h) return;
    picked = picked.includes(h) ? picked.filter(x => x !== h) : [...picked, h];
    if (!clusterSel()){   // 自动模式: 点第一台主机时锁定它所在的集群
      const gs = [...groupsOf(h)];
      if (gs.length === 1 && gs[0]) clusterDD.value = gs[0];
    }
    drawPick();
  });
  form.querySelector('.form-h').addEventListener('click', async e => {
    const act = e.target.closest('[data-json]')?.dataset.json;
    if (!act) return;
    try{
      if (act === 'export'){
        await navigator.clipboard.writeText(JSON.stringify(Object.fromEntries(JSON_KEYS.map(k => [k, form.elements[k].value])), null, 2));
        return notify('已复制到剪贴板', '包含除主机以外的全部配置。');
      }
      const d = JSON.parse(await navigator.clipboard.readText());
      if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('剪贴板里不是 JSON 对象');
      const got = JSON_KEYS.filter(k => typeof d[k] === 'string');
      if (!got.length) throw new Error('没有可导入的字段（' + JSON_KEYS.join(', ') + '）');
      for (const k of got) form.elements[k].value = d[k];
      notify('已导入', got.join(', ') + (got.length < JSON_KEYS.length ? '\n未包含的字段保持不变。' : '') + '\n主机不随 JSON 导入，请在表单里选择。');
    }catch(err){
      notify(act === 'export' ? '复制失败' : '导入失败', err.message);
    }
  });
  $('#taskForm').addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(e.target), btn = e.target.querySelector('[type=submit]');
    const nodes = parseInt(f.get('nodes'), 10);
    if (!Number.isInteger(nodes) || nodes < 1) return notify('节点数量需为正整数');
    if (picked.length !== nodes) return notify(`需选择 ${nodes} 台主机，当前 ${picked.length} 台`);
    if (!picked.length) return notify('请至少选择一台主机');
    btn.disabled = true;
    try{
      const config = {nodes, cluster: f.get('cluster'), ...Object.fromEntries(['image', 'ifname', 'env', 'mounts', 'entrypoint', 'docker_args', 'proxy', 'ports_head', 'ports_nodes'].map(k => [k, f.get(k)]))};
      const t = await post('/api/tasks', {name: f.get('name'), note: f.get('note'), ...gpSettings(), config: {...config, hosts: picked}});
      location.hash = t.id;
    }catch(err){
      btn.disabled = false;
      notify('提交失败', err.message);
    }
  });
}

// 主机 chip 上的简略负载: 每张卡一个小方块, 黄=忙 绿=闲; 悬停看每卡利用率/显存
function loadHTML(r){
  if (!r) return '';
  if (!r.ok) return '<span class="load off" title="' + esc(r.error || '离线') + '">离线</span>';
  const tip = r.gpus.map(g => `GPU${g.index} ${g.util ?? '--'}% ${g.mem_used == null ? '--' : (g.mem_used / 1024).toFixed(0)}/${g.mem_total == null ? '--' : (g.mem_total / 1024).toFixed(0)}G`).join('\n');
  const idle = r.gpus.filter(g => !gpuBusy(g)).length;
  return `<span class="load" title="${esc(tip)}">${r.gpus.map(g => `<s class="${gpuBusy(g) ? 'busy' : ''}"></s>`).join('')}<small>${idle}/${r.gpus.length} 闲</small></span>`;
}

// 与 tasks.parse_env / parse_mounts 同口径, 只用于展示 (提交时已在服务端校验过)
const cfgLines = text => String(text || '').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
function envRows(text){
  return cfgLines(text).map(l => {
    l = l.replace(/^export\s+/, '');
    const i = l.indexOf('=');
    let v = l.slice(i + 1);
    if (v.length >= 2 && v[0] === v.at(-1) && `'"`.includes(v[0])) v = v.slice(1, -1);
    return [l.slice(0, i), v];
  });
}
const mountRows = text => cfgLines(text).map(l => { const [src, dst, ro] = l.split(':'); return [src, dst || src, ro === 'ro' ? '只读' : '']; });
const miniTable = (head, rows) => `<table class="mini-tbl"><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead>
  <tbody>${rows.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;

// kv 行里的小复制按钮; data-copy 指向 showTask 点击处理里取值的键
const copyBtn = key => `<button type="button" class="copy" data-copy="${key}" title="复制到剪贴板" aria-label="复制">⧉</button>`;
function taskHead(t, cfgOpen){
  const live = t.containers_up || ACTIVE.includes(t.status);
  const pre = (label, text) => text.trim() ? `<div class="cfg-l">${label}</div><pre>${esc(text)}</pre>` : '';
  const env = envRows(t.config.env), mounts = mountRows(t.config.mounts);
  return `<div class="form-h"><a href="#" class="back">‹ 任务</a><h2 class="rename" data-act="rename" title="点击修改名称">${esc(t.name)}</h2>${badge(t)}<span class="gspace"></span>
      <a class="btn" href="#new/${t.id}">复制</a>
      ${live ? '<button type="button" class="btn danger" data-act="stop">停止</button>' : '<button type="button" class="btn" data-act="restart" title="删除此任务并以相同配置重新创建启动">重新启动</button><button type="button" class="btn" data-act="del">删除</button>'}</div>
    ${t.error ? `<div class="ban">${esc(t.error)}</div>` : ''}
    <div class="kv panel">
      <div><span>任务 ID</span><b>${t.id}${copyBtn('id')}</b></div>
      <div><span>创建者</span><b>${esc(t.creator || '—')}</b></div>
      <div><span>集群</span><b>${esc(t.config.cluster || '未分组')}</b></div>
      <div><span>节点数量</span><b>${t.config.nodes ?? t.config.hosts.length}</b></div>
      <div class="wide"><span>容器名</span><b>${esc(t.container)}${t.containers_up ? '' : ' <small>(已清理)</small>'}${copyBtn('container')}</b></div>
      <div class="wide"><span>镜像</span><b>${esc(t.config.image)}${copyBtn('image')}</b></div>
      <div><span>创建</span><b>${fmtTime(t.created)}</b></div><div><span>入口脚本启动</span><b>${fmtTime(t.started)}</b></div>
      <div><span>结束</span><b>${fmtTime(t.ended)}</b></div><div><span>运行时长</span><b id="runFor"></b></div>
      <div class="wide"><span>备注</span><b class="edit" data-act="note" title="点击修改备注">${t.note ? esc(t.note) : '—'}</b></div>
    </div>
    <table class="tbl panel nodes"><thead><tr><th>#</th><th>主机</th><th>${esc(t.config.ifname)} IP</th><th>GPU</th><th>状态</th></tr></thead><tbody>
      ${t.nodes.map((n, i) => `<tr><td>${i + 1}${i === 0 ? ' <span class="badge ok">主节点</span>' : ''}</td><td>${esc(n.host)}</td>
        <td class="mono">${esc(n.ip || '--')}</td><td>${n.gpus ?? '--'}</td><td>${esc(n.state)}</td></tr>`).join('')}
    </tbody></table>
    <details id="cfg" class="panel"${cfgOpen ? ' open' : ''}><summary>配置</summary>
      ${env.length ? `<div class="cfg-l">环境变量</div>${miniTable(['KEY', 'VALUE'], env)}` : ''}
      ${mounts.length ? `<div class="cfg-l">挂载</div>${miniTable(['主机路径', '容器路径', ''], mounts)}` : ''}
      ${pre('docker run 参数', t.docker_run || t.config.docker_args)}${pre('安装 sshd 用的代理', t.config.proxy || '')}${pre('端口占用 · 主节点', t.config.ports_head || '')}${pre('端口占用 · 普通节点', t.config.ports_nodes || '')}${t.config.entrypoint.trim() ? `<div class="cfg-l">入口脚本 ${copyBtn('entrypoint')}</div>${fsWrap(`<pre>${esc(t.config.entrypoint)}</pre>`, ' id="epWrap"')}` : ''}
    </details>`;
}

async function showTask(id){
  let t = await getTask(id);
  let which = t.status === 'launching' || !t.config.entrypoint.trim() ? 'launch' : 'output';
  let offset = 0, tailMode = false, gen = 0, autoWhich = true;   // 自动选的页签在 entrypoint 起来后切到输出, 手动点过就不再切
  $('#view').innerHTML = `<div id="taskHead"></div>
    <div class="logbox"><div class="log-h"><div class="seg" id="logSeg">
      <button type="button" data-w="output">入口脚本输出</button><button type="button" data-w="launch">启动日志</button></div>
      <div class="seg" id="logLvl" title="详细：额外显示每条远端命令、实时 stderr、退出码与耗时">
        <button type="button" data-l="info" class="on">简要</button><button type="button" data-l="debug">详细</button></div>
      <span id="logCap" class="log-cap" hidden>日志超过 1 MB，只显示开头部分 <button type="button" class="btn">跳到末尾并跟随</button></span>
      <span class="log-filter"><input id="logFilter" class="inp mono" spellcheck="false" autocomplete="off" placeholder="过滤，子串匹配" title="文本：子串匹配（可含空格，忽略大小写）；正则：JavaScript 正则（大小写敏感）"><span class="sub" id="logCnt"></span><span class="seg mini" id="logFseg"><button type="button" data-m="text" class="on">文本</button><button type="button" data-m="regex">正则</button></span></span></div>
      ${fsWrap('<pre id="log" class="log panel"></pre>')}</div>
    <div class="logbox" id="rbox"><div class="log-h"><span class="sec-t">实时日志</span>
      <form id="rForm" class="rpath"><input class="inp mono" name="p" spellcheck="false" placeholder="路径，目录或文件" title="在所选视角（容器或主节点宿主机）里列出该目录下的文件，点文件名实时跟随（类似 tail -f）">
      <button class="btn" type="submit">列出</button></form><span class="sub" id="rInfo"></span></div>
      <div id="rFiles" class="rfiles"></div>
      <div class="log-h rctl" id="rCtl" hidden>
        <span class="seg mini" id="rWhere" title="容器：主节点容器内的文件（需容器还在）；主机：主节点宿主机上的文件（容器清理后也可看，如共享存储上的日志）"><button type="button" data-m="container" class="on">容器</button><button type="button" data-m="host">主机</button></span>
        <span class="seg mini" id="rMode" title="末尾：只加载最后 64KB 并跟随；全量：从文件开头加载整个文件后继续跟随，适合搜索启动早期的日志"><button type="button" data-m="tail" class="on">末尾</button><button type="button" data-m="full">全量</button></span>
        <span class="log-filter"><input id="rFilter" class="inp mono" spellcheck="false" autocomplete="off" placeholder="过滤，子串匹配" title="文本：子串匹配（可含空格，忽略大小写）；正则：JavaScript 正则（大小写敏感）"><span class="sub" id="rCnt"></span><span class="seg mini" id="rFseg"><button type="button" data-m="text" class="on">文本</button><button type="button" data-m="regex">正则</button></span></span>
      </div>
      ${fsWrap('<pre id="rLog" class="log panel"></pre>', ' id="rWrap" hidden')}</div>`;
  const pre = $('#log'), head = $('#taskHead'), cap = $('#logCap'), lvl = $('#logLvl'),
        fq = $('#logFilter'), cnt = $('#logCnt');
  let debug = false;
  const lf = lineFilter(pre, fq, cnt, $('#logFseg'));
  const resetLog = (w, tail = false) => { which = w; offset = tail ? -1 : 0; tailMode = tail; cap.hidden = true; lf.reset(); };
  let drawn = '';
  const draw = () => {
    const html = taskHead(t, $('#cfg')?.open);
    if (html !== drawn){   // 内容没变不重建, 免得按钮在点击途中被换掉
      const fs = !!$('#epWrap.fs');
      const first = drawn === '';
      head.innerHTML = drawn = html;
      if (fs) $('#epWrap')?.classList.add('fs');   // 重建时保住 entrypoint 的全屏状态
      if (first){
        [...head.children].forEach(animIn);   // 只有第一次进详情播入场, 之后内容变化不重播
        document.querySelectorAll('#view > .logbox').forEach((el, i) => animIn(el, head.children.length + i));   // 日志面板接着入场
      }
    }
    $('#runFor').textContent = runFor(t);
    document.querySelectorAll('#logSeg button').forEach(b => b.classList.toggle('on', b.dataset.w === which));
    lvl.hidden = which !== 'launch';
  };
  async function tick(){
    clearTimeout(pollTimer);
    const my = gen;
    try{
      t = await getTask(id);
      if (my !== gen || location.hash.slice(1) !== id) return;
      if (autoWhich && which === 'launch' && t.status !== 'launching' && t.config.entrypoint.trim()){
        resetLog('output');
      }
      draw();
      for (let more = true; more && (tailMode || offset < LOG_HEAD);){
        const r = await api(`/api/tasks/log?id=${id}&which=${which}&offset=${offset}${debug ? '&level=debug' : ''}`);
        if (my !== gen) return;
        if (r.text) lf.emit(r.text);
        offset = r.offset;
        more = r.more;
      }
      const capped = !tailMode && offset >= LOG_HEAD;
      if (capped && cap.hidden) pre.scrollTop = 0;   // 刚截断: 只保留开头, 就停在开头
      cap.hidden = !capped;
    }catch(e){
      if (my !== gen) return;
    }
    if (ACTIVE.includes(t.status) && location.hash.slice(1) === id) pollTimer = setTimeout(tick, 2000);
  }
  $('#logSeg').addEventListener('click', e => {
    const w = e.target.closest('[data-w]')?.dataset.w;
    if (!w || w === which) return;
    autoWhich = false;
    resetLog(w); gen++;
    draw();
    tick();
  });
  lvl.addEventListener('click', e => {
    const l = e.target.closest('[data-l]')?.dataset.l;
    if (!l || (l === 'debug') === debug) return;
    debug = l === 'debug';
    lvl.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === e.target.closest('[data-l]')));
    resetLog(which, tailMode); gen++;
    tick();
  });
  cap.querySelector('button').addEventListener('click', () => {
    resetLog(which, true); gen++;
    tick();
  });
  head.addEventListener('click', async e => {
    const b = e.target.closest('[data-copy]');
    if (b){
      const val = {id, container: t.container, image: t.config.image, entrypoint: t.config.entrypoint}[b.dataset.copy];
      try{
        await navigator.clipboard.writeText(val);
        b.textContent = '✓';
        setTimeout(() => { b.textContent = '⧉'; }, 900);
      }catch(err){ notify('复制失败', err.message); }
      return;
    }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'rename'){
      const name = await modal({title: '修改任务名称', input: true, value: t.name, ok: '保存'});
      if (name == null || name.trim() === t.name) return;
      try{ await post('/api/tasks/rename', {id, name}); }
      catch(err){ return notify('修改失败', err.message); }
      tick();
    } else if (act === 'note'){
      const note = await modal({title: '修改备注', input: true, value: t.note || '', ok: '保存'});
      if (note == null || note === (t.note || '')) return;
      try{ await post('/api/tasks/note', {id, note}); }
      catch(err){ return notify('修改失败', err.message); }
      tick();
    } else if (act === 'stop'){
      if (!await modal({title: '停止任务？', desc: `将在所有主机上删除容器 ${t.container}，entrypoint 与容器内未保存的数据都会丢失。`, ok: '停止', danger: true})) return;
      try{
        const r = await post('/api/tasks/stop', {id});
        if (r.errors.length) notify('部分容器删除失败', r.errors.join('\n'));
      }catch(err){ notify('停止失败', err.message); }
      tick();
    } else if (act === 'restart'){
      if (!await modal({title: '重新启动任务？', desc: '将删除此任务（含记录和日志），并以相同的主机顺序与配置立即重新创建并启动。'
        + (t.containers_up ? '\n现有容器会先停止清理。' : '') + '\n创建者/容器名前缀取当前浏览器的设置。', ok: '重启', danger: true})) return;
      try{
        if (t.containers_up) await post('/api/tasks/stop', {id});
        await api('/api/tasks?id=' + encodeURIComponent(id), {method: 'DELETE'});
        const nt = await post('/api/tasks', {name: t.name, note: t.note, ...gpSettings(), config: t.config});
        location.hash = nt.id;
      }catch(err){
        notify('重启失败', err.message + '\n旧任务可能已删除，请刷新查看。');
      }
    } else if (act === 'del'){
      if (!await modal({title: '删除任务记录？', desc: '配置和日志都会删除，无法恢复。', ok: '删除', danger: true})) return;
      try{
        await api('/api/tasks?id=' + encodeURIComponent(id), {method: 'DELETE'});
        location.hash = '';
      }catch(err){ notify('删除失败', err.message); }
    }
  });
  draw();
  tick();
  remoteLog(id, () => t);
}

// 实时日志面板: 列出主节点容器里某目录的文件, 点一个就每 2 秒增量读一次, 类似 tail -f
function remoteLog(id, task){
  const form = $('#rForm'), info = $('#rInfo'), list = $('#rFiles'), out = $('#rLog');
  const lf = lineFilter(out, $('#rFilter'), $('#rCnt'), $('#rFseg'), Infinity);   // 全量加载, 重画过滤时不丢前文
  // 视角 (容器/主节点宿主机) 和目录都存浏览器, 全局共享, 不按任务分
  let where = localStorage.getItem('gpumon.rwhere') || 'container';
  form.p.value = localStorage.getItem('gpumon.rpath') || (where === 'host' ? '/mnt/ceph/workspace/ycp/logs' : '/logs');
  const whereDD = segControl($('#rWhere'), [{value: 'container', label: '容器'}, {value: 'host', label: '主机'}],
    {value: where, title: '容器：主节点容器内的文件；主机：主节点宿主机上的文件',
     onChange: v => { where = v; localStorage.setItem('gpumon.rwhere', v); form.requestSubmit(); }});
  whereDD.set(where, true);
  let gen = 0, timer = null;
  const alive = my => my === gen && location.hash.slice(1) === id;
  const join = (dir, name) => name ? dir.replace(/\/+$/, '') + '/' + name : dir;
  let cur = null;   // 当前跟随的文件与模式; fromStart=true 从头全量加载后继续跟随, 默认从末尾 64KB 跟随
  async function follow(path, my, offset = -1, fromStart = false){
    clearTimeout(timer);
    try{
      for (let more = true; more;){
        const r = await api(`/api/tasks/tail?id=${id}&path=${encodeURIComponent(path)}&offset=${offset}&where=${where}`);
        if (!alive(my)) return;
        if (r.reset) lf.reset();
        if (r.text) lf.emit(r.text);
        offset = r.offset; more = r.more;
        info.textContent = `${where === 'host' ? '主机' : '容器'}:${path} · ${fmtBytes(r.size)} · ${new Date().toLocaleTimeString('zh-CN', {hour12: false})} 更新`;
      }
    }catch(e){
      if (!alive(my)) return;
      info.textContent = '读取失败：' + e.message;
    }
    if (alive(my) && task().containers_up) timer = setTimeout(() => follow(path, my, offset), 2000);
  }
  function open(path, fromStart = false){
    const my = ++gen;
    cur = {path, fromStart};
    info.textContent = fromStart ? '全量加载中…' : '';
    $('#rMode').querySelectorAll('button').forEach(b => b.classList.toggle('on', (b.dataset.m === 'full') === fromStart));
    $('#rWrap').hidden = false; $('#rCtl').hidden = false; lf.reset();
    list.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', join(form.p.value.trim(), c.dataset.f) === path));
    follow(path, my, fromStart ? 0 : -1, fromStart);
  }
  $('#rMode').addEventListener('click', e => {
    const m = e.target.closest('[data-m]')?.dataset.m;
    if (!m || !cur || (m === 'full') === cur.fromStart) return;
    open(cur.path, m === 'full');
  });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const dir = form.p.value.trim();
    localStorage.setItem('gpumon.rpath', dir);
    gen++; clearTimeout(timer);
    info.textContent = '列出中…'; list.innerHTML = ''; $('#rWrap').hidden = true; $('#rCtl').hidden = true; lf.reset();
    try{
      const r = await api(`/api/tasks/files?id=${id}&path=${encodeURIComponent(dir)}&where=${where}`);
      if (r.files.length === 1 && !r.files[0].name) return open(dir);   // 输入的就是文件
      info.textContent = r.files.length ? `${r.files.length} 个文件` : '目录下没有文件';
      list.innerHTML = r.files.map((f, i) => `<button type="button" class="chip in" data-f="${esc(f.name)}" style="--i:${Math.min(i, 12)}" title="${fmtTime(f.mtime)} 修改">
        ${esc(f.name)}<small>${fmtBytes(f.size)}</small></button>`).join('');
    }catch(err){
      info.textContent = err.message;
    }
  });
  list.addEventListener('click', e => {
    const f = e.target.closest('[data-f]')?.dataset.f;
    if (f != null) open(join(form.p.value.trim(), f));
  });
  const sync = () => {   // 容器视角下容器清理则不可用 (切到主机视角仍可看); 已切走别的页面就停
    const box = $('#rbox');
    if (!box || location.hash.slice(1) !== id) return;
    const off = where === 'container' && !task().containers_up;
    box.classList.toggle('off', off);
    form.querySelectorAll('input,button').forEach(x => x.disabled = off);
    if (off && !info.textContent) info.textContent = '容器已清理，可切到「主机」视角查看宿主机文件';
    setTimeout(sync, 2000);
  };
  sync();
  if (task().containers_up || where === 'host') form.requestSubmit();
}

// 容器名前缀和创建者保存在本浏览器 (多人共用服务时各自独立), 创建任务时随请求带给服务端
const gpSettings = () => ({prefix: localStorage.getItem('gpumon.docker_prefix') || 'gpumon',
                           creator: localStorage.getItem('gpumon.creator') || ''});
const saveSettings = s => { localStorage.setItem('gpumon.docker_prefix', s.prefix); localStorage.setItem('gpumon.creator', s.creator); };
function settingsDialog(prompt = false){
  const cur = gpSettings();
  return new Promise(resolve => {
    const dlg = document.createElement('dialog');
    dlg.className = 'dlg';
    dlg.innerHTML = `<div class="dlg-t">设置</div>
      <div class="dlg-d">保存在本浏览器，不影响其他用户；创建任务时会带上。${prompt ? '<br>多人共用此服务，建议先设置你的创建者和容器名前缀。' : ''}</div>
      <label class="dlg-f">创建者<input class="dlg-i" name="creator" maxlength="40" placeholder="你的名字，显示在任务上" value="${esc(cur.creator)}" spellcheck="false"></label>
      <label class="dlg-f">容器名前缀<input class="dlg-i mono" name="prefix" value="${esc(cur.prefix)}" spellcheck="false"></label>
      <div class="dlg-a"><button type="button" class="ghost" data-no>取消</button><button type="button" class="primary" data-yes>保存</button></div>`;
    const done = v => { if (!dlg.open) return resolve(v); dlg.close(); resolve(v); };
    const val = () => { const p = dlg.querySelector('[name=prefix]').value.trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/.test(p)){ dlg.querySelector('[name=prefix]').focus(); return null; }
      return {prefix: p, creator: dlg.querySelector('[name=creator]').value.trim().slice(0, 40)}; };
    dlg.querySelector('[data-no]').addEventListener('click', () => done(null));
    dlg.querySelector('[data-yes]').addEventListener('click', () => { const v = val(); if (v) done(v); });
    dlg.addEventListener('cancel', e => { e.preventDefault(); done(null); });
    dlg.addEventListener('close', () => dlg.remove());
    document.body.appendChild(dlg);
    dlg.showModal();
    dlg.querySelector('[name=creator]').focus();
  });
}
$('#settingsBtn').addEventListener('click', async () => {
  const s = await settingsDialog();
  if (s) saveSettings(s);
});
// 进任务页时若两项还是默认值, 提示一次设置 (每个标签页会话只提示一次)
setTimeout(async () => {
  if (!location.pathname.startsWith('/tasks') || sessionStorage.getItem('gpumon.settingsPrompted')) return;
  const {prefix, creator} = gpSettings();
  if (prefix !== 'gpumon' || creator) return;
  sessionStorage.setItem('gpumon.settingsPrompted', '1');
  const s = await settingsDialog(true);
  if (s) saveSettings(s);
}, 600);
window.addEventListener('hashchange', () => { scrollTo(0, 0); route(); });   // 只有真切换页面才回顶; 列表轮询也走 route, 不能动滚动
route();
