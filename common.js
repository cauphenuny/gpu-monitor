/* 监控页与任务页共用 */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clearToken = '__GPUMON_CLEAR_TOKEN__';
// 忙闲口径: 利用率 >=5% 或显存 >=10%
const gpuBusy = g => (g.util || 0) >= 5 || (g.mem_total && g.mem_used != null ? g.mem_used / g.mem_total * 100 : 0) >= 10;
function fmtDuration(seconds){
  if (!Number.isFinite(seconds) || seconds < 0) return '--';
  const s = Math.floor(seconds);
  if (s >= 86400) return Math.floor(s/86400)+'天'+Math.floor(s%86400/3600)+'小时';
  if (s >= 3600) return Math.floor(s/3600)+'小时'+Math.floor(s%3600/60)+'分';
  if (s >= 60) return Math.floor(s/60)+'分'+s%60+'秒';
  return s+'秒';
}

/* ---- 统一弹窗: 原生 <dialog>, 自带遮罩/Esc/焦点管理 ---- */
function modal({title, desc = '', input = false, value = '', ok = '确定', cancel = true, danger = false}){
  if (!document?.createElement)   // 无 DOM 环境 (测试桩/极简宿主) 退回原生对话框
    return Promise.resolve(input ? prompt(title + (desc ? '\n' + desc : ''), value)
      : danger && !confirm(title + (desc ? '\n' + desc : '')) ? false : true);
  return new Promise(resolve => {
    const dlg = document.createElement('dialog');
    dlg.className = 'dlg';
    dlg.innerHTML = `<div class="dlg-t">${esc(title)}</div>
      ${desc ? `<div class="dlg-d">${esc(desc).replace(/\n/g, '<br>')}</div>` : ''}
      ${input ? `<input class="dlg-i" name="value" value="${esc(value)}" spellcheck="false" autocomplete="off">` : ''}
      <div class="dlg-a">${cancel ? '<button type="button" class="ghost" data-no>取消</button>' : ''}
        <button type="button" class="${danger ? 'danger' : 'primary'}" data-yes>${esc(ok)}</button></div>`;
    const done = v => {
      if (!dlg.open) return resolve(v);
      dlg.classList.add('out');
      setTimeout(() => { dlg.close(); resolve(v); }, 180);
    };
    const val = () => input ? dlg.querySelector('.dlg-i').value : true;
    dlg.querySelector('[data-no]')?.addEventListener('click', () => done(input ? null : false));
    dlg.querySelector('[data-yes]').addEventListener('click', () => done(val()));
    dlg.addEventListener('cancel', e => { e.preventDefault(); done(input ? null : false); });
    dlg.addEventListener('close', () => dlg.remove());
    document.body.appendChild(dlg);
    dlg.showModal();
    const i = dlg.querySelector('.dlg-i');
    if (i){ i.focus(); i.select(); i.addEventListener('keydown', e => { if (e.key === 'Enter'){ e.preventDefault(); done(val()); } }); }
    else dlg.querySelector('[data-yes]').focus();
  });
}
// 日志过滤: 空格分隔多个词, 全部命中 (大小写不敏感) 的行才算匹配
function parseFilter(q){
  return q.trim().toLowerCase().split(/\s+/).filter(Boolean);
}
function matchFilter(line, terms){
  return !terms.length || terms.every(t => line.toLowerCase().includes(t));
}

// 每个日志框一套: 输入框防抖改词后整体重画, 平时 emit() 只进匹配的新行; 缓冲约 2MB, 更早的丢弃
function lineFilter(pre, input, cnt, cap = 2e6){
  let filter = '', shown = '', buf = '', total = 0, matched = 0, t;
  const counts = () => cnt.textContent = filter.trim() && total ? `${matched}/${total} 行` : '';
  const draw = lines => {
    pre.insertAdjacentHTML('beforeend', ansiHTML(lines.join('\n') + '\n'));
  };
  const emit = text => {
    const stick = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
    buf += text;
    const lines = buf.split('\n');
    buf = lines.pop();   // 半行留到下次
    shown += lines.map(l => l + '\n').join('');
    if (shown.length > cap) shown = shown.slice(-cap);
    total += lines.length;
    const terms = parseFilter(filter);
    const visible = lines.filter(l => matchFilter(l, terms));
    matched += visible.length;
    if (visible.length) draw(visible);
    if (stick) pre.scrollTop = pre.scrollHeight;
    counts();
  };
  const renderAll = () => {
    const lines = shown.split('\n'); lines.pop();
    total = lines.length;
    const terms = parseFilter(filter);
    const visible = lines.filter(l => matchFilter(l, terms));
    matched = visible.length;
    pre.textContent = '';
    if (visible.length) draw(visible);
    counts();
  };
  input.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => { filter = input.value; renderAll(); }, 250);
  });
  return {emit, reset(){ shown = ''; buf = ''; total = matched = 0; pre.textContent = ''; counts(); }};
}

// ANSI 转义 → 可见的 HTML: 保留常用 8 色+亮色的前景/背景和粗体/斜体/下划线/删除线,
// 其余控制序列 (光标移动等) 丢弃. 在 <pre> 里用, 先 esc() 再过这个.
const ANSI = {
  fg: {30: '#8b95a4', 31: '#f87171', 32: '#4ade80', 33: '#fbbf24', 34: '#7ab3ff', 35: '#c4a5f5', 36: '#67d3e0', 37: '#e6ebf2',
       90: '#6d7788', 91: '#ffb4b4', 92: '#86efac', 93: '#fde68a', 94: '#a5cdff', 95: '#d8bffe', 96: '#9ae4ee', 97: '#ffffff'},
  bg: {40: '#232c3a', 41: '#5c2828', 42: '#274d33', 43: '#544320', 44: '#24466b', 45: '#46326b', 46: '#1f4f56', 47: '#39424f',
       100: '#3a4350', 101: '#7a4040', 102: '#4a7a58', 103: '#7a6a3f', 104: '#42688f', 105: '#5f4a8f', 106: '#3f7278', 107: '#525c6a'},
};
const CSI = /\x1b\[([0-9;:?<=> ]*)?([ -\/]*)([@-~])/g;   // CSI 序列; 字母参数决定含义

function ansiHTML(text){
  // 先按终端语义处理 \r: 同一行里 \r 后的内容从行首覆盖 (tqdm 等进度条靠这个原地刷新;
  // HTML 解析器会把 \r 当换行, 不处理会刷出成百上千行)
  text = text.split('\n').map(line => {
    const segs = line.split('\r');
    const acc = [...segs[0]];
    for (let k = 1; k < segs.length; k++){
      const sg = segs[k];
      for (let j = 0; j < sg.length; j++) acc[j] = sg[j];
    }
    return acc.join('');
  }).join('\n');
  let out = '', i = 0, fg = null, bg = null, bold = false, italic = false, under = false, strike = false;
  const styles = [];
  const open = () => styles.map(s => `<span ${s}>`).join('');
  text.replace(CSI, (m, params, inter, fin, idx) => {
    out += open() + esc(text.slice(i, idx)) + '</span>'.repeat(styles.length);
    i = idx + m.length;
    if (fin === 'm' && !inter){   // SGR; 其他序列 (光标/擦除等) 直接丢弃
      const ps = String(params ?? '').split(';').map(x => parseInt(x || '0', 10));
      for (let k = 0; k < ps.length; k++){
        const p = ps[k];
        if (p === 38 || p === 48){   // 38;5;N / 38;2;R;G;B 扩展色: 不支持, 连参数一起跳过
          k += ps[k + 1] === 5 ? 2 : ps[k + 1] === 2 ? 4 : 0;
          continue;
        }
        if (p === 0) [fg, bg, bold, italic, under, strike] = [null, null, false, false, false, false];
        else if (p === 1) bold = true;
        else if (p === 3) italic = true;
        else if (p === 4) under = true;
        else if (p === 9) strike = true;
        else if (p === 22) bold = false;
        else if (p === 23) italic = false;
        else if (p === 24) under = false;
        else if (p === 29) strike = false;
        else if (p === 39) fg = null;
        else if (p === 49) bg = null;
        else if (ANSI.fg[p]) fg = p;
        else if (ANSI.bg[p]) bg = p;
      }
      styles.length = 0;
      if (bold || italic || under || strike) styles.push(`style="${[bold && 'font-weight:700', italic && 'font-style:italic', under && 'text-decoration:underline', strike && 'text-decoration:line-through'].filter(Boolean).join(';')}"`);
      if (fg) styles.push(`style="color:${ANSI.fg[fg]}"`);
      if (bg) styles.push(`style="background:${ANSI.bg[bg]}"`);
    }
    return '';
  });
  return out + open() + esc(text.slice(i)) + '</span>'.repeat(styles.length);
}

const notify = (title, desc = '') => document?.createElement
  ? modal({title, desc, ok: '知道了', cancel: false})
  : (alert(title + (desc ? '\n' + desc : '')), Promise.resolve());
