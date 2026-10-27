let entries = [], results = new Map(), lastUpdate = null, inFlight = false, timer = null;
let disabled = new Map();   // host → 禁用原因
let collapsedGroups = new Set(JSON.parse(localStorage.getItem('gpumon.collapsed') || '[]'));
let openGpus = new Set();   // "host|uuid" → 展开该 GPU 的进程列表
let dragInfo = null, isDragging = false;   // 手动排序模式的拖拽状态
const clearingHosts = new Set();
const seenCards = new Set();     // 首次出现的卡片才做入场动画, 刷新重绘不动
const revealedSparks = new Set();  // 曲线只淡入一次, 重绘不重播
const justOpenedGroups = new Set(); // 分组刚展开时才播高度动画, 重绘不重播
const justOpened = new Set();    // 只在刚展开的那一刻播高度动画, 之后的重绘不再重播
let refreshAfterClear = false;

const midTrunc = (s, n = 46) => {
  s = String(s ?? '');
  if (s.length <= n) return s;
  const keep = n - 1, head = Math.ceil(keep * .55), tail = keep - head;
  return s.slice(0, head) + '…' + s.slice(s.length - tail);
};
const fmtMiB = v => v == null ? '--' : v >= 1024 ? (v/1024).toFixed(1)+' GB' : Math.round(v)+' MB';
const fmtG = v => v == null ? '--' : (v/1024).toFixed(1);
const fpct = v => v == null ? '--' : Math.round(v)+'%';
const cls = p => p == null ? 'na' : p < 50 ? 'ok' : p < 80 ? 'warn' : 'hot';
const sortMode = () => document.querySelector('#sortSeg .on')?.dataset.sort || 'manual';
function bar(p){
  const q = p == null ? null : Math.max(0, Math.min(100, p));
  return `<div class="track"><div class="fill ${cls(q)}" style="width:${q == null ? 0 : q.toFixed(1)}%"></div></div>`;
}



function gpuRow(host, g){
  const key = host + '|' + (g.uuid || g.index);
  const open = openGpus.has(key);
  const memPct = (g.mem_total && g.mem_used != null) ? g.mem_used / g.mem_total * 100 : null;
  const n = (g.procs || []).length;
  const reveal = open && !revealedSparks.has(key);
  const spark = open ? `<div class="spark${reveal ? ' reveal' : ''}" data-spark="${esc(key)}"><div class="empty">加载历史…</div></div>` : '';
  const procs = (open && n) ? `<div class="procs">${g.procs.map(p =>
    `<div class="proc"><div class="pname">${p.container ? `<span class="pcontainer" title="${esc(p.container)}">${esc(p.container)}</span>` : ''}<span title="${esc(p.name)}">${esc(midTrunc(p.name))}</span></div><div class="pmeta"><div><span class="pid">#${esc(p.pid)}</span><span class="pmem">${p.mem != null ? fmtMiB(p.mem) : ''}</span></div><div class="ptime" title="进程已运行时长（截至本次采集）">已运行 ${fmtDuration(p.elapsed_seconds)}</div></div></div>`).join('')}</div>` : '';
  return `<div class="gpu${open ? ' open' : ''}" data-gpu="${esc(key)}" title="点击展开/收起进程">
    <div class="l1"><span class="gpu-tag">${esc(g.index)}</span><span class="gpu-name">${esc(g.name)}</span>
      ${n ? `<span class="pcount">${n} 进程</span>` : ''}
      <span class="gpu-side">${g.temp != null ? Math.round(g.temp)+'°C' : ''}${g.temp != null && g.power != null ? ' · ' : ''}${g.power != null ? Math.round(g.power)+'W' : ''}</span></div>
    <div class="l2"><span class="mini">利用率</span>${bar(g.util)}<span class="val ${cls(g.util)}">${fpct(g.util)}</span>
      <span class="mini">显存</span>${bar(memPct)}<span class="val wide ${cls(memPct)}">${fmtG(g.mem_used)}/${fmtG(g.mem_total)} GB</span></div>
    <div class="gpu-body${open ? ' open' : ''}${justOpened.has(key) ? ' just' : ''}"><div class="gpu-inner">${spark}${procs}</div></div>
  </div>`;
}

const FAIL_LIMIT = 10;   // 连续失败这么多次才判定离线; 单次 ssh 抖动只标黄点

function fmtAgo(ts){
  if (!ts) return '';
  const s = Math.max(0, Date.now()/1000 - ts);
  if (s < 60) return Math.round(s) + ' 秒前';
  if (s < 3600) return Math.floor(s/60) + ' 分前';
  if (s < 86400) return Math.floor(s/3600) + ' 小时前';
  return Math.floor(s/86400) + ' 天前';
}

function card(host, group){
  const r = results.get(host);
  const fails = r?.fails || 0;
  const online = !!r && (r.ok || fails < FAIL_LIMIT);
  let dot = '<span class="dot"></span>', ts = '', ic = '', body = '<div class="waiting">等待数据…</div>';
  if (r){
    dot = `<span class="dot ${r.ok ? 'on' : online ? 'warn' : 'off'}"></span>`;
    if (r.error) ic = `<span class="err-ic" title="${esc(r.error)}${fails ? ' · 连续失败 ' + fails + ' 次' : ''}">⚠</span>`;
    body = r.gpus.length ? r.gpus.map(g => gpuRow(host, g)).join('')
      : `<div class="waiting">${r.ok ? '未检测到 GPU' : '暂无数据'}</div>`;
    ts = `<span class="lat" title="该主机数据最后一次采集成功的时间${fails ? '，已连续失败 ' + fails + ' 次' : ''}">${fmtAgo(r.ts)}</span>`;
  }
  const manual = sortMode() === 'manual';
  const ban = disabled.get(host);
  const fresh = !seenCards.has(host + '|' + group);
  if (fresh) seenCards.add(host + '|' + group);
  return `<section class="card${fresh ? ' new' : ''}${!online ? ' stale' : ''}${ban != null ? ' disabled' : ''}" draggable="${manual}" data-host="${esc(host)}" data-group="${esc(group)}">
    <div class="card-h">${dot}<span class="host">${esc(host)}</span>${ic}${ts}
      <button type="button" class="toggle" data-toggle-host="${esc(host)}" title="${ban != null ? '解除禁用' : '临时标记为不准使用'}">${ban != null ? '启用' : '禁用'}</button>
      <button type="button" class="clear" data-clear-host="${esc(host)}" ${!r?.ok || clearingHosts.has(host) ? 'disabled' : ''} title="强制结束此服务器所有 GPU 任务，最多等待 3 分钟确认清空">${clearingHosts.has(host) ? '清空中…' : '清空'}</button>
      <button class="del" data-del-host="${esc(host)}" data-del-group="${esc(group)}" title="移除">✕</button></div>
    ${ban != null ? `<div class="ban" title="${esc(ban)}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5 15 14H1z"/><path d="M8 6v3.6M8 11.8v.2" stroke="#151a20" stroke-width="1.4" fill="none" stroke-linecap="round"/></svg>暂停使用：${esc(ban)}</div>` : ''}
    ${body}</section>`;
}

/* ---- 历史曲线: 服务端内存里保留最近 12 小时, 展开某张卡时按主机拉取 ---- */
const histCache = new Map();   // host → {ts, gpus: {gpuKey: [[ts, util%, mem%], …]}}
const histPending = new Set();
const HIST_TTL = 15000;
const SPARK = {util: '#5ec8f0', mem: '#a78bfa'};
let sparkSeq = 0;

function sparkSVG(pts, idx, color){
  const W = 100, H = 26, pad = 3;
  const t0 = pts[0][0], t1 = pts[pts.length - 1][0], span = t1 - t0 || 1;
  const x = t => (t - t0) / span * (W - pad * 2) + pad;
  const y = v => H - pad - (v / 100) * (H - pad * 2);
  const segs = []; let cur = [];
  for (const p of pts){
    const v = p[idx];
    if (v == null){ if (cur.length > 1) segs.push(cur); cur = []; continue; }
    cur.push([x(p[0]), Math.min(H - pad, Math.max(pad, y(v)))]);
  }
  if (cur.length > 1) segs.push(cur);
  const str = r => r.map(([px, py]) => px.toFixed(1) + ',' + py.toFixed(1)).join(' ');
  const gid = 'sg' + (++sparkSeq);
  const line = segs.map(r => `<polyline points="${str(r)}"/>`).join('');
  const area = segs.map(r => `<polygon points="${str(r)} ${r[r.length-1][0].toFixed(1)},${H} ${r[0][0].toFixed(1)},${H}"/>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
    <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${color}" stop-opacity=".3"/><stop offset="1" stop-color="${color}" stop-opacity=".02"/>
    </linearGradient></defs>
    <g fill="url(#${gid})">${area}</g>
    <g fill="none" stroke="${color}" stroke-width="0.8" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round">${line}</g></svg>`;
}

function sparkHTML(pts, key){
  if (!pts || pts.length < 2) return `<div class="spark" data-spark="${esc(key)}"><div class="empty">历史点过少，稍后再看</div></div>`;
  const last = i => { for (let k = pts.length - 1; k >= 0; k--) if (pts[k][i] != null) return pts[k][i]; return null; };
  const pct = v => v == null ? '--' : Math.round(v) + '%';
  return `<div class="spark" data-spark="${esc(key)}" title="近 ${histSpan(pts)}">
    <span class="sage">近 ${histSpan(pts)}</span>
    <div class="sp sp1">${sparkSVG(pts, 1, SPARK.util)}</div>
    <div class="sp sp2">${sparkSVG(pts, 2, SPARK.mem)}</div></div>`;
}
function histSpan(pts){
  const m = (pts[pts.length - 1][0] - pts[0][0]) / 60;
  return m >= 60 ? Math.round(m / 60) + ' 小时' : Math.max(1, Math.round(m)) + ' 分钟';
}
function drawSparks(host){
  const c = histCache.get(host);
  if (!c) return;
  for (const el of document.querySelectorAll('.spark')){
    if (!el.dataset.spark.startsWith(host + '|')) continue;
    const key = el.dataset.spark;
    const pts = c.gpus[key.slice(host.length + 1)];
    const html = sparkHTML(pts, key);
    if (!el.querySelector('.empty')){   // 已画过曲线: 直接换内容, 保留元素本身以免动画重播
      el.querySelectorAll('.sage,.sp').forEach(x => x.remove());
      el.insertAdjacentHTML('beforeend', html.replace(/^<div class="spark"[^>]*>|</div>$/g, ''));
      continue;
    }
    const fresh = !revealedSparks.has(key);
    el.innerHTML = html.slice(html.indexOf('>') + 1, html.lastIndexOf('</div>'));
    if (fresh){ revealedSparks.add(key); el.classList.add('reveal'); }
  }
}
async function hydrateSparks(){
  const hosts = new Set();
  for (const k of openGpus) hosts.add(k.slice(0, k.lastIndexOf('|')));
  for (const host of hosts){
    const c = histCache.get(host);
    if (c && Date.now() - c.ts < HIST_TTL) drawSparks(host);
    else if (!histPending.has(host)){
      histPending.add(host);
      fetch('/api/history?host=' + encodeURIComponent(host))
        .then(r => r.json())
        .then(d => { histCache.set(host, {ts: Date.now(), gpus: d.gpus || {}}); drawSparks(host); })
        .catch(() => {})
        .finally(() => histPending.delete(host));
    }
  }
}

function tally(hostList){
  let online = 0, total = 0, busy = 0;
  for (const h of hostList){
    const r = results.get(h);
    if (!r || !r.ok) continue;
    online++;
    if (disabled.has(h)) continue;   // 禁用机器的卡不计入忙闲, 免得被当成空闲卡
    for (const g of r.gpus){
      total++;
      if (gpuBusy(g)) busy++;
    }
  }
  return {online, total, busy, idle: total - busy};
}

function hostStat(h){
  const r = results.get(h);
  if (!r || !r.ok) return null;   // 未知/离线
  let busy = 0, idle = 0, maxUtil = 0;
  for (const g of r.gpus){
    const b = gpuBusy(g);
    busy += b; idle += !b; maxUtil = Math.max(maxUtil, g.util || 0);
  }
  return {busy, idle, maxUtil};
}

function sortedHosts(list){
  const mode = sortMode();
  if (mode === 'manual') return list;
  const arr = [...list];
  const st = h => (!disabled.has(h) && hostStat(h)) || {busy: 0, idle: -1, maxUtil: 0};   // 离线/未知/禁用统一垫底
  const byName = (a, b) => a.localeCompare(b, undefined, {numeric: true});
  if (mode === 'name')
    arr.sort(byName);
  else if (mode === 'idle')
    arr.sort((a, b) => st(b).idle - st(a).idle || st(a).maxUtil - st(b).maxUtil || byName(a, b));
  else if (mode === 'busy')
    arr.sort((a, b) => st(b).busy - st(a).busy || st(b).maxUtil - st(a).maxUtil || byName(a, b));
  return arr;
}

function render(){
  const groups = [...new Set(entries.map(e => e.group).filter(Boolean))];
  $('#groupSel').classList.toggle('empty', !groups.length);
  $('#groupSel .sel-menu').innerHTML = groups.map(g => `<button type="button" data-v="${esc(g)}">${esc(g)}</button>`).join('');
  const root = $('#root');
  if (!entries.length){
    root.innerHTML = `<div class="hint">还没有主机。在右上角输入主机名添加，例如 <code>lab-gpu-01</code> 或 <code>user@10.0.0.5</code>，可填写分组；<br>
      连接使用本机 <code>ssh</code>（<code>~/.ssh/config</code> 别名与密钥均可），请确保 <code>ssh &lt;主机&gt;</code> 可免密登录且装有 nvidia-smi。</div>`;
    $('#summary').textContent = '';
    return;
  }
  const order = [], byGroup = new Map();
  for (const e of entries){
    const g = e.group || '';
    if (!byGroup.has(g)){ byGroup.set(g, []); order.push(g); }
    byGroup.get(g).push(e.host);
  }
  if (order.includes('')){ order.splice(order.indexOf(''), 1); order.push(''); }  // 未分组放最后
  root.innerHTML = order.map(g => {
    const list = byGroup.get(g);
    const t = tally(list);
    const col = collapsedGroups.has(g);
    return `<section class="group${col ? ' collapsed' : ''}" data-group="${esc(g)}">
      <div class="group-h" data-group="${esc(g)}">
        <button class="gcollapse" data-gcol="${esc(g)}" title="折叠/展开" aria-expanded="${!col}"><svg class="chev" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.8 6 7.8l3-3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        <span class="gname">${g === '' ? '未分组' : esc(g)}</span>
        <span class="gsum">${t.online}/${list.length} 在线 · GPU ${t.busy} 忙 / ${t.idle} 闲</span>
        <span class="gspace"></span>
        <button class="gact rename" data-grename="${esc(g)}" title="重命名分组">✎</button>
        <button class="gact del" data-gdel="${esc(g)}" title="删除分组及其主机">✕</button>
      </div>
      <div class="gbody${col ? '' : ' open'}${justOpenedGroups.has(g) ? ' just' : ''}"><div class="grid">${sortedHosts(list).map(h => card(h, g)).join('')}</div></div>
    </section>`;
  }).join('');
  hydrateSparks();
  const all = [...new Set(entries.map(e => e.host))];
  const t = tally(all);
  $('#summary').textContent = `${t.online}/${all.length} 主机在线 · ${t.total} GPU · ${t.busy} 忙 · ${t.idle} 闲`;
}

async function loadHosts(){
  const d = await (await fetch('/api/hosts')).json();
  entries = d.hosts || [];
  disabled = new Map(Object.entries(d.disabled || {}));
}

async function refresh(){
  if (inFlight) return;
  if (!entries.length){ results = new Map(); lastUpdate = Date.now(); if (!isDragging) render(); upd(); return; }
  inFlight = true;
  $('#refreshBtn').classList.add('spin');
  try{
    const d = await (await fetch('/api/status')).json();
    const prev = results;   // 本轮失败的主机沿用上一轮 GPU 数据, 只标记错误
    results = new Map((d.results || []).map(x => {
      const p = prev.get(x.host);
      return [x.host, (!x.ok && p?.gpus?.length) ? {...p, ok: false, error: x.error} : x];
    }));
    disabled = new Map((d.results || []).filter(x => x.disabled != null).map(x => [x.host, x.disabled]));   // 同步别人在其他页面做的禁用
    lastUpdate = Date.now();
    if (!isDragging) render();   // 拖拽中不重建 DOM, 拖完再渲染
    upd();
    try{ sessionStorage.setItem('gpumon.status', JSON.stringify({results: [...results], lastUpdate})); }catch{}   // 从任务页切回时先显示这份
  }catch(e){
    $('#updated').textContent = '刷新失败';
  }finally{
    inFlight = false;
    $('#refreshBtn').classList.remove('spin');
    if (refreshAfterClear){ refreshAfterClear = false; refresh(); }
  }
}

function upd(){
  $('#updated').textContent = lastUpdate ? '更新于 ' + Math.round((Date.now() - lastUpdate)/1000) + ' 秒前' : '';
}

$('#addForm').addEventListener('submit', async e => {
  e.preventDefault();
  const host = $('#hostInput').value.trim();
  if (!host) return;
  const group = $('#groupInput').value.trim();
  const d = await (await fetch('/api/hosts', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({host, group})})).json();
  entries = d.hosts || [];
  $('#hostInput').value = '';
  render(); refresh();
});

$('#root').addEventListener('click', async e => {
  const toggle = e.target.closest('[data-toggle-host]');
  if (toggle){
    const host = toggle.dataset.toggleHost;
    let body;
    if (disabled.has(host)){
      if (!await modal({title: `解除 ${host} 的禁用？`, ok: '解除'})) return;
      body = {host, disabled: false};
    } else {
      const reason = await modal({title: `临时禁用 ${host}`, desc: '该机器会标注为现在不准使用，卡数不计入忙闲。', input: true, ok: '禁用', danger: true});
      if (reason == null) return;
      body = {host, disabled: true, reason};
    }
    const d = await (await fetch('/api/hosts/disable', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)})).json();
    disabled = new Map(Object.entries(d.disabled || {}));
    render();
    if (inFlight) refreshAfterClear = true;   // 进行中的刷新带的是旧状态, 结束后再刷一次
    return;
  }
  const clear = e.target.closest('[data-clear-host]');
  if (clear){
    const host = clear.dataset.clearHost;
    if (clear.disabled || clearingHosts.has(host)) return;
    const confirmation = await modal({title: '强制清空 GPU 任务', desc: `将结束 ${host} 上所有 GPU 任务，未保存的进度会丢失。\n请输入服务器名确认：${host}`, input: true, ok: '清空', danger: true});
    if (confirmation == null) return;
    if (confirmation !== host){ await notify('服务器名不匹配', '未执行清空'); return; }
    clearingHosts.add(host);
    render();
    try{
      const response = await fetch('/api/hosts/clear', {method:'POST', headers:{'Content-Type':'application/json', 'X-GPUMon-Token':clearToken}, body:JSON.stringify({host, confirmation})});
      const d = await response.json();
      const messages = [`${host}：${d.ok ? '已清空' : '未完全清空'}`];
      if (d.killed) messages.push(`已发送强制终止：${d.killed.length} 个进程`);
      if (d.failed?.length) messages.push('终止失败：' + d.failed.map(p => `PID ${p.pid}: ${p.error}`).join('；'));
      if (d.remaining?.length) messages.push('仍在占卡：PID ' + d.remaining.join(', '));
      if (d.error) messages.push(d.error);
      await notify(messages.shift(), messages.join('\n'));
    }catch(e){
      await notify(`${host}：清空请求失败`, '部分任务可能已终止，请刷新确认');
    }finally{
      clearingHosts.delete(host);
      render();
      if (inFlight) refreshAfterClear = true;
      else refresh();
    }
    return;
  }
  const del = e.target.closest('[data-del-host]');
  if (del){
    await fetch('/api/hosts?host=' + encodeURIComponent(del.dataset.delHost) + '&group=' + encodeURIComponent(del.dataset.delGroup || ''), {method:'DELETE'});
    await loadHosts(); render();
    return;
  }
  const gcol = e.target.closest('[data-gcol]');
  if (gcol){
    const g = gcol.dataset.gcol;
    collapsedGroups.has(g) ? collapsedGroups.delete(g) : collapsedGroups.add(g);
    localStorage.setItem('gpumon.collapsed', JSON.stringify([...collapsedGroups]));
    const grp = gcol.closest('.group');
    const body = grp?.querySelector('.gbody');
    if (!collapsedGroups.has(g)){          // 展开: 直接重绘, 新节点带 open
      justOpenedGroups.add(g);
      render();
      setTimeout(() => justOpenedGroups.delete(g), 400);
    } else {                               // 收起: 先播收起动画再重绘
      grp?.classList.add('collapsed');     // 箭头立刻转过去
      if (body && body.scrollHeight > 0){
        body.classList.remove('open');
        setTimeout(render, 340);
      } else render();
    }
    return;
  }
  const gren = e.target.closest('[data-grename]');
  if (gren){
    const from = gren.dataset.grename;
    const to = await modal({title: '重命名分组', input: true, value: from === '' ? '' : from, ok: '重命名'});
    if (to == null) return;
    const t = to.trim();
    if (!t || t === from) return;
    const d = await (await fetch('/api/groups/rename', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({from, to: t})})).json();
    entries = d.hosts || [];
    render(); refresh();
    return;
  }
  const gdel = e.target.closest('[data-gdel]');
  if (gdel){
    const g = gdel.dataset.gdel;
    if (!await modal({title: '删除分组', desc: `删除分组「${g === '' ? '未分组' : g}」及其中所有主机？`, ok: '删除', danger: true})) return;
    await fetch('/api/groups?group=' + encodeURIComponent(g), {method:'DELETE'});
    await loadHosts(); render();
    return;
  }
  const gpu = e.target.closest('.gpu');
  if (gpu){
    const k = gpu.dataset.gpu;
    if (!openGpus.has(k)){
      openGpus.add(k); justOpened.add(k);
      render();
      setTimeout(() => justOpened.delete(k), 400);
      return;
    }
    const body = gpu.querySelector('.gpu-body');
    openGpus.delete(k);
    if (!body || body.scrollHeight === 0){ render(); return; }
    revealedSparks.delete(k);                 // 收起后再次展开时重播淡入
    body.classList.remove('open');            // 先收起, 动画结束再重绘
    setTimeout(render, 300);
  }
});

$('#refreshBtn').addEventListener('click', refresh);

/* ---- 手动排序: 拖拽卡片. 拖到同组卡片前 = 调整顺序; 拖到另一组 = 移动分组 ---- */
function clearDragMarks(){
  document.querySelectorAll('.drag-over,.dragging').forEach(el => el.classList.remove('drag-over', 'dragging'));
}

function moveEntry(src, dst, dstGroup){
  // 从 entries 中取下 src, 插到 dst (host+group 定位) 之前; 跨组拖拽时 group 改为 dstGroup
  const srcIdx = entries.findIndex(e => e.host === src.host && e.group === src.group);
  const dstIdx = entries.findIndex(e => e.host === dst.host && e.group === dst.group);
  if (srcIdx < 0 || dstIdx < 0) return null;
  const out = entries.filter((_, i) => i !== srcIdx);
  const at = out.findIndex(e => e.host === dst.host && e.group === dst.group);
  if (at < 0) return null;
  out.splice(at, 0, {host: src.host, group: dstGroup});
  return out;
}

function appendToGroup(src, group){
  // 取下 src, 插到该组最后一条之后 (拖到分组标题栏上)
  const srcIdx = entries.findIndex(e => e.host === src.host && e.group === src.group);
  if (srcIdx < 0) return null;
  const out = entries.filter((_, i) => i !== srcIdx);
  let at = 0;
  out.forEach((e, i) => { if ((e.group || '') === group) at = i + 1; });
  out.splice(at, 0, {host: src.host, group});
  return out;
}

async function persistOrder(list){
  const d = await (await fetch('/api/hosts/reorder', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({hosts: list})})).json();
  entries = d.hosts || list;
  render();
}

$('#root').addEventListener('dragstart', e => {
  const card = e.target.closest('.card');
  if (!card || card.draggable !== true) return;
  dragInfo = {host: card.dataset.host, group: card.dataset.group || ''};
  isDragging = true;
  card.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dragInfo.host);
});

$('#root').addEventListener('dragover', e => {
  if (!dragInfo) return;
  const card = e.target.closest('.card');
  const gh = e.target.closest('.group-h');
  clearDragMarks();
  if (card && !(card.dataset.host === dragInfo.host && (card.dataset.group || '') === dragInfo.group)){
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    card.classList.add('drag-over');
  } else if (gh){
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    gh.classList.add('drag-over');
  }
});

$('#root').addEventListener('drop', e => {
  if (!dragInfo) return;
  e.preventDefault();
  const src = dragInfo;
  const card = e.target.closest('.card');
  const gh = e.target.closest('.group-h');
  clearDragMarks();
  let list = null;
  if (card){
    list = moveEntry(src, {host: card.dataset.host, group: card.dataset.group || ''}, card.dataset.group || '');
  } else if (gh){
    list = appendToGroup(src, gh.dataset.group || '');
  }
  if (list) persistOrder(list);
  dragInfo = null; isDragging = false;
});

$('#root').addEventListener('dragend', () => {
  dragInfo = null; isDragging = false;
  clearDragMarks();
  render();   // 补渲染拖拽期间推迟的刷新
});

$('#sortSeg').addEventListener('click', e => {
  const b = e.target.closest('[data-sort]');
  if (!b || b.classList.contains('on')) return;
  document.querySelectorAll('#sortSeg [data-sort]').forEach(x => x.classList.toggle('on', x === b));
  localStorage.setItem('gpumon.sort', b.dataset.sort);
  render();
});

function setTimer(sec){
  if (timer) clearInterval(timer);
  timer = null;
  if (sec > 0) timer = setInterval(refresh, sec*1000);
}
/* 自绘下拉: 原生 select 无法跟随主题 */
const sel = $('#intervalSel');
const selVal = () => +sel.querySelector('.sel-menu .on').dataset.v;
function setSel(v){
  const b = [...sel.querySelectorAll('[data-v]')].find(x => x.dataset.v === String(v));
  if (!b) return false;
  sel.querySelectorAll('[data-v]').forEach(x => x.classList.toggle('on', x === b));
  sel.querySelector('.sel-btn span').textContent = b.textContent;
  return true;
}
function closeSel(){ sel.classList.remove('open'); sel.querySelector('.sel-btn').setAttribute('aria-expanded', 'false'); }
sel.querySelector('.sel-btn').addEventListener('click', () => {
  const open = sel.classList.toggle('open');
  sel.querySelector('.sel-btn').setAttribute('aria-expanded', String(open));
});
sel.querySelector('.sel-menu').addEventListener('click', e => {
  const b = e.target.closest('[data-v]');
  if (!b) return;
  setSel(b.dataset.v);
  localStorage.setItem('gpumon.interval', b.dataset.v);
  setTimer(selVal());
  closeSel();
});
const gsel = $('#groupSel');
const closeGsel = () => { gsel.classList.remove('open'); gsel.querySelector('.grp-btn').setAttribute('aria-expanded', 'false'); };
gsel.querySelector('.grp-btn').addEventListener('click', () => {
  const open = gsel.classList.toggle('open');
  gsel.querySelector('.grp-btn').setAttribute('aria-expanded', String(open));
});
gsel.querySelector('.sel-menu').addEventListener('click', e => {
  const b = e.target.closest('[data-v]');
  if (!b) return;
  $('#groupInput').value = b.dataset.v;
  closeGsel();
  $('#hostInput').focus();
});
document.addEventListener('click', e => { if (!sel.contains(e.target)) closeSel(); if (!gsel.contains(e.target)) closeGsel(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape'){ closeSel(); closeGsel(); } });
setInterval(upd, 1000);

(async () => {
  const savedInterval = localStorage.getItem('gpumon.interval');
  if (savedInterval != null) setSel(savedInterval);
  const savedSort = localStorage.getItem('gpumon.sort');
  if (savedSort && document.querySelector(`#sortSeg [data-sort="${savedSort}"]`)){
    document.querySelectorAll('#sortSeg [data-sort]').forEach(b => b.classList.toggle('on', b.dataset.sort === savedSort));
  }
  await loadHosts();
  try{   // 本标签页上次的结果 (Map 存为 [host, r] 数组), 先显示旧数据再后台刷新; 坏缓存忽略
    const c = JSON.parse(sessionStorage.getItem('gpumon.status'));
    if (Array.isArray(c?.results) && Number.isFinite(c.lastUpdate) && c.results.every(x => Array.isArray(x) && typeof x[0] === 'string' && x[1] && typeof x[1] === 'object')){
      results = new Map(c.results); lastUpdate = c.lastUpdate;
    }
  }catch{}
  render(); upd();
  refresh();
  setTimer(selVal());
})();
