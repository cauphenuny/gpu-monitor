const STATUS = {launching: ['启动中', 'warn'], running: ['运行中', 'ok'], succeeded: ['已完成', 'done'],
  failed: ['失败', 'hot'], stopped: ['已停止', 'muted']};
const ACTIVE = ['launching', 'running'];
const LOG_HEAD = 1024 * 1024;   // 默认只看日志开头这么多字节, 超出的点「跳到末尾」再看
const JSON_KEYS = ['name', 'note', 'image', 'ifname', 'nodes', 'env', 'mounts', 'entrypoint', 'docker_args', 'proxy'];   // 导入/导出剪贴板的字段, 不含主机
const DEFAULTS = {image: '', ifname: 'bond0', hosts: [], nodes: 2, env: '', mounts: '', entrypoint: '', proxy: '',
  docker_args: '--shm-size 1500g --memory 1780g --ulimit stack=67108864:67108864'};
let pollTimer = null;

async function api(url, opts = {}){
  const r = await fetch(url, {...opts, headers: {'Content-Type': 'application/json', 'X-GPUMon-Token': clearToken}});
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || r.statusText);
  return d;
}
const post = (url, body) => api(url, {method: 'POST', body: JSON.stringify(body)});
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
  try{
    if (!h) await showList();
    else if (h === 'new' || h.startsWith('new/')) await showForm(h.slice(4));
    else await showTask(h);
  }catch(e){
    $('#view').innerHTML = `<div class="hint">${esc(e.message)}<br><a href="#">返回任务列表</a></div>`;
  }
}

async function showList(){
  const {tasks} = await api('/api/tasks');
  if (location.hash.slice(1)) return;
  const y = window.scrollY;   // innerHTML 整体替换会让文档高度瞬间塌掉, 浏览器把滚动钳到顶; 重绘后恢复
  $('#view').innerHTML = tasks.length ? `<table class="tbl panel"><thead><tr><th>名称</th><th>状态</th><th>主机</th>
    <th>创建时间</th><th>运行时长</th><th></th></tr></thead><tbody>${tasks.map(t => `<tr>
      <td><a href="#${t.id}">${esc(t.name)}</a><div class="sub">${t.id}${t.note ? ' · ' + esc(t.note) : ''}</div></td>
      <td>${badge(t)}</td><td class="hosts">${t.config.hosts.map(esc).join('<br>')}</td>
      <td>${fmtTime(t.created)}</td><td>${runFor(t)}</td>
      <td class="acts"><a class="btn sm" href="#new/${t.id}">复制</a></td></tr>`).join('')}</tbody></table>`
    : '<div class="hint">还没有任务，点右上角「新建任务」</div>';
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
  const field = (label, hint, input) => `<label class="field"><span>${label}${hint ? ` <small>${hint}</small>` : ''}</span>${input}</label>`;
  const area = (name, rows, mono = true) => `<textarea name="${name}" rows="${rows}" spellcheck="false"${mono ? ' class="mono"' : ''}>${esc(cfg[name])}</textarea>`;
  $('#view').innerHTML = `<form id="taskForm" class="form panel">
    <div class="form-h"><a href="#" class="back">‹ 任务</a><h2>${src ? '复制任务' : '新建任务'}</h2><span class="gspace"></span>
      <button type="button" class="btn" data-json="import" title="从剪贴板读取 JSON 填入表单（不含主机）">导入 JSON</button>
      <button type="button" class="btn" data-json="export" title="把除主机以外的配置以 JSON 复制到剪贴板">导出 JSON</button></div>
    ${field('名称', '', `<input name="name" required maxlength="100" value="${esc(src?.name || '')}">`)}
    ${field('备注', '', `<textarea name="note" rows="2">${esc(src?.note || '')}</textarea>`)}
    ${field('镜像', '', `<input name="image" required class="mono" spellcheck="false" value="${esc(cfg.image)}">`)}
    ${field('节点数量', '', `<input name="nodes" type="number" min="1" max="64" required value="${src?.config.nodes || src?.config.hosts?.length || cfg.nodes}">`)}
    <div class="field"><span>主机 <small>按点选顺序写入 /root/mpi_hostfile，第 1 台为 head，entrypoint 在 head 上执行 · <b id="pickCnt"></b></small></span><div id="hostPick"></div></div>
    ${field('网卡', '取该网卡的 IPv4 作为容器互连与 hostfile 地址', `<input name="ifname" required class="mono" value="${esc(cfg.ifname)}">`)}
    ${field('环境变量', '每行 [export ]KEY=VALUE，# 开头为注释；不做 shell 展开', area('env', 8))}
    ${field('挂载', '每行 src[:dst[:ro]]，dst 省略时同 src；src 须在每台主机上存在', area('mounts', 4))}
    ${field('Entrypoint', '全部容器就绪后在 head 上用 bash 执行，stdout/stderr 记录到任务输出；留空则只拉起容器', fsWrap(area('entrypoint', 16)))}
    ${field('安装 sshd 用的代理', '可选，如 http://proxy:8888；镜像里没有 sshd 时 apt 走这个代理，只在安装时生效，不进容器环境变量', `<input name="proxy" class="mono" spellcheck="false" placeholder="不填则直连" value="${esc(cfg.proxy || '')}">`)}
    ${field('docker run 额外参数', '已固定 --gpus all --network host --ipc private --privileged；/dev/shm 大小用 --shm-size 指定，不写则只有 docker 默认的 64MB', `<input name="docker_args" class="mono" spellcheck="false" value="${esc(cfg.docker_args)}">`)}
    <div class="form-a"><a class="btn ghost" href="#">取消</a><button class="primary" type="submit">提交</button></div>
  </form>`;
  const drawPick = () => {
    $('#pickCnt').textContent = `已选 ${picked.length} / 需 ${$('#taskForm').elements.nodes.value || '?'}`;
    $('#hostPick').innerHTML = [...groups].map(([g, hs]) => `<div class="pick-g"><span class="pick-gn">${esc(g || '未分组')}</span>${hs.map(h => {
      const i = picked.indexOf(h);
      return `<button type="button" class="chip${i >= 0 ? ' on' : ''}${i === 0 ? ' head' : ''}" data-h="${esc(h)}" aria-pressed="${i >= 0}"${disabled[h] ? ` title="已禁用：${esc(disabled[h])}"` : ''}>
        ${i >= 0 ? `<b>${i + 1}</b>` : ''}${esc(h)}${i === 0 ? '<span class="badge ok">head</span>' : ''}${loadHTML(load.get(h))}${disabled[h] ? '<span class="badge hot">禁用</span>' : ''}</button>`;
    }).join('')}</div>`).join('') || '<div class="sub">还没有主机，先在监控页添加</div>';
  };
  drawPick();
  $('#taskForm').elements.nodes.addEventListener('input', drawPick);
  api('/api/status').then(d => {
    load = new Map(d.results.map(r => [r.host, r]));
    if ($('#hostPick')) drawPick();
  }).catch(() => {});
  $('#hostPick').addEventListener('click', e => {
    const h = e.target.closest('[data-h]')?.dataset.h;
    if (!h) return;
    picked = picked.includes(h) ? picked.filter(x => x !== h) : [...picked, h];
    drawPick();
  });
  const form = $('#taskForm');
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
      const config = {nodes, ...Object.fromEntries(['image', 'ifname', 'env', 'mounts', 'entrypoint', 'docker_args', 'proxy'].map(k => [k, f.get(k)]))};
      const t = await post('/api/tasks', {name: f.get('name'), note: f.get('note'), config: {...config, hosts: picked}});
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

function taskHead(t, cfgOpen){
  const live = t.containers_up || ACTIVE.includes(t.status);
  const pre = (label, text) => text.trim() ? `<div class="cfg-l">${label}</div><pre>${esc(text)}</pre>` : '';
  const env = envRows(t.config.env), mounts = mountRows(t.config.mounts);
  return `<div class="form-h"><a href="#" class="back">‹ 任务</a><h2 class="rename" data-act="rename" title="点击修改名称">${esc(t.name)}</h2>${badge(t)}<span class="gspace"></span>
      <a class="btn" href="#new/${t.id}">复制</a>
      ${live ? '<button type="button" class="btn danger" data-act="stop">停止</button>' : '<button type="button" class="btn" data-act="del">删除</button>'}</div>
    ${t.error ? `<div class="ban">${esc(t.error)}</div>` : ''}
    <div class="kv panel">
      <div><span>任务 ID</span><b>${t.id}</b></div>
      <div><span>节点数量</span><b>${t.config.nodes ?? t.config.hosts.length}</b></div>
      <div class="wide"><span>容器名</span><b>${esc(t.container)}${t.containers_up ? '' : ' <small>(已清理)</small>'}</b></div>
      <div class="wide"><span>镜像</span><b>${esc(t.config.image)}</b></div>
      <div><span>创建</span><b>${fmtTime(t.created)}</b></div><div><span>entrypoint 启动</span><b>${fmtTime(t.started)}</b></div>
      <div><span>结束</span><b>${fmtTime(t.ended)}</b></div><div><span>运行时长</span><b id="runFor"></b></div>
      <div class="wide"><span>备注</span><b class="edit" data-act="note" title="点击修改备注">${t.note ? esc(t.note) : '—'}</b></div>
    </div>
    <table class="tbl panel nodes"><thead><tr><th>#</th><th>主机</th><th>${esc(t.config.ifname)} IP</th><th>GPU</th><th>状态</th></tr></thead><tbody>
      ${t.nodes.map((n, i) => `<tr><td>${i + 1}${i === 0 ? ' <span class="badge ok">head</span>' : ''}</td><td>${esc(n.host)}</td>
        <td class="mono">${esc(n.ip || '--')}</td><td>${n.gpus ?? '--'}</td><td>${esc(n.state)}</td></tr>`).join('')}
    </tbody></table>
    <details id="cfg" class="panel"${cfgOpen ? ' open' : ''}><summary>配置</summary>
      ${env.length ? `<div class="cfg-l">环境变量</div>${miniTable(['KEY', 'VALUE'], env)}` : ''}
      ${mounts.length ? `<div class="cfg-l">挂载</div>${miniTable(['主机路径', '容器路径', ''], mounts)}` : ''}
      ${pre('docker run 参数', t.docker_run || t.config.docker_args)}${pre('安装 sshd 用的代理', t.config.proxy || '')}${t.config.entrypoint.trim() ? `<div class="cfg-l">Entrypoint</div>${fsWrap(`<pre>${esc(t.config.entrypoint)}</pre>`, ' id="epWrap"')}` : ''}
    </details>`;
}

async function showTask(id){
  let t = await getTask(id);
  let which = t.status === 'launching' || !t.config.entrypoint.trim() ? 'launch' : 'output';
  let offset = 0, tailMode = false, gen = 0, autoWhich = true;   // 自动选的页签在 entrypoint 起来后切到输出, 手动点过就不再切
  $('#view').innerHTML = `<div id="taskHead"></div>
    <div class="logbox"><div class="log-h"><div class="seg" id="logSeg">
      <button type="button" data-w="output">entrypoint 输出</button><button type="button" data-w="launch">启动日志</button></div>
      <div class="seg" id="logLvl" title="详细：额外显示每条远端命令、实时 stderr、退出码与耗时">
        <button type="button" data-l="info" class="on">简要</button><button type="button" data-l="debug">详细</button></div>
      <span id="logCap" class="log-cap" hidden>日志超过 1 MB，只显示开头部分 <button type="button" class="btn">跳到末尾并跟随</button></span>
      <span class="log-filter"><input id="logFilter" class="inp mono" spellcheck="false" autocomplete="off" placeholder="过滤，文本可含空格" title="文本：整段子串匹配（可含空格，忽略大小写）；正则：JavaScript 正则（大小写敏感）"><span class="sub" id="logCnt"></span><span class="seg mini" id="logFseg"><button type="button" data-m="text" class="on">文本</button><button type="button" data-m="regex">正则</button></span></span></div>
      ${fsWrap('<pre id="log" class="log panel"></pre>')}</div>
    <div class="logbox" id="rbox"><div class="log-h"><span class="sec-t">实时日志</span>
      <form id="rForm" class="rpath"><input class="inp mono" name="p" spellcheck="false" placeholder="head 容器内的路径，目录或文件" title="在 head 容器里列出该目录下的文件，点文件名实时跟随（类似 tail -f）">
      <button class="btn" type="submit">列出</button><button class="btn" type="button" id="rHead" title="从文件开头全量加载，适合搜索启动早期的日志；加载完继续跟随新内容">从头</button><button class="btn" type="button" id="rBack" hidden title="回到末尾跟随，只保留新内容">回末尾</button></form><span class="sub" id="rInfo"></span>
      <span class="log-filter"><input id="rFilter" class="inp mono" spellcheck="false" autocomplete="off" placeholder="过滤，文本可含空格" title="文本：整段子串匹配（可含空格，忽略大小写）；正则：JavaScript 正则（大小写敏感）"><span class="sub" id="rCnt"></span><span class="seg mini" id="rFseg"><button type="button" data-m="text" class="on">文本</button><button type="button" data-m="regex">正则</button></span></span></div>
      <div id="rFiles" class="rfiles"></div>
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
      head.innerHTML = drawn = html;
      if (fs) $('#epWrap')?.classList.add('fs');   // 重建时保住 entrypoint 的全屏状态
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

// 实时日志面板: 列出 head 容器里某目录的文件, 点一个就每 2 秒增量读一次, 类似 tail -f
function remoteLog(id, task){
  const form = $('#rForm'), info = $('#rInfo'), list = $('#rFiles'), out = $('#rLog');
  const lf = lineFilter(out, $('#rFilter'), $('#rCnt'), $('#rFseg'), Infinity);   // 全量加载, 重画过滤时不丢前文
  const key = 'gpumon.rpath.' + id;
  form.p.value = localStorage.getItem(key) || '/logs';   // platform 启动脚本把本次日志目录软链到 /logs
  let gen = 0, timer = null;
  const alive = my => my === gen && location.hash.slice(1) === id;
  const join = (dir, name) => name ? dir.replace(/\/+$/, '') + '/' + name : dir;
  let cur = null;   // 当前跟随的文件与模式; fromStart=true 从头全量加载后继续跟随, 默认从末尾 64KB 跟随
  async function follow(path, my, offset = -1, fromStart = false){
    clearTimeout(timer);
    try{
      for (let more = true; more;){
        const r = await api(`/api/tasks/tail?id=${id}&path=${encodeURIComponent(path)}&offset=${offset}`);
        if (!alive(my)) return;
        if (r.reset) lf.reset();
        if (r.text) lf.emit(r.text);
        offset = r.offset; more = r.more;
        info.textContent = `${path} · ${fmtBytes(r.size)} · ${fromStart ? '从头全量' : '末尾'} · ${new Date().toLocaleTimeString('zh-CN', {hour12: false})} 更新`;
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
    info.textContent = fromStart ? '从头加载中…' : '';
    $('#rBack').hidden = !fromStart;
    $('#rWrap').hidden = false; lf.reset();
    list.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', join(form.p.value.trim(), c.dataset.f) === path));
    follow(path, my, fromStart ? 0 : -1, fromStart);
  }
  $('#rHead').addEventListener('click', () => cur && open(cur.path, true));
  $('#rBack').addEventListener('click', () => cur && open(cur.path, false));
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const dir = form.p.value.trim();
    localStorage.setItem(key, dir);
    gen++; clearTimeout(timer);
    info.textContent = '列出中…'; list.innerHTML = ''; $('#rWrap').hidden = true; lf.reset();
    try{
      const r = await api(`/api/tasks/files?id=${id}&path=${encodeURIComponent(dir)}`);
      if (r.files.length === 1 && !r.files[0].name) return open(dir);   // 输入的就是文件
      info.textContent = r.files.length ? `${r.files.length} 个文件` : '目录下没有文件';
      list.innerHTML = r.files.map(f => `<button type="button" class="chip" data-f="${esc(f.name)}" title="${fmtTime(f.mtime)} 修改">
        ${esc(f.name)}<small>${fmtBytes(f.size)}</small></button>`).join('');
    }catch(err){
      info.textContent = err.message;
    }
  });
  list.addEventListener('click', e => {
    const f = e.target.closest('[data-f]')?.dataset.f;
    if (f != null) open(join(form.p.value.trim(), f));
  });
  const sync = () => {   // 容器清理后面板不可用
    const up = task().containers_up;
    $('#rbox').classList.toggle('off', !up);
    form.querySelectorAll('input,button').forEach(x => x.disabled = !up);
    if (!up && !info.textContent) info.textContent = '容器已清理，无法查看';
    if (location.hash.slice(1) === id) setTimeout(sync, 2000);
  };
  sync();
  if (task().containers_up) form.requestSubmit();
}

$('#settingsBtn').addEventListener('click', async () => {
  try{
    const s = await api('/api/settings');
    const v = await modal({title: '设置', desc: 'Docker 容器名前缀：新任务的容器名为「前缀-任务ID」', input: true, value: s.docker_prefix, ok: '保存'});
    if (v != null) await post('/api/settings', {docker_prefix: v.trim()});
  }catch(e){
    notify('保存失败', e.message);
  }
});
window.addEventListener('hashchange', () => { scrollTo(0, 0); route(); });   // 只有真切换页面才回顶; 列表轮询也走 route, 不能动滚动
route();
