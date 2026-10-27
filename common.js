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
const notify = (title, desc = '') => document?.createElement
  ? modal({title, desc, ok: '知道了', cancel: false})
  : (alert(title + (desc ? '\n' + desc : '')), Promise.resolve());
