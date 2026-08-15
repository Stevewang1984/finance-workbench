'use strict';
/* 事件日历：IPO / 美联储 / 财报 / CPI / 非农 / 自定义 */
window.Calendar = (function () {
  const CAT = { FED: '美联储', IPO: '打新', EARNINGS: '财报', MACRO: '宏观', CUSTOM: '自定义' };

  function needsConfirm(e, today) {
    if (e.confirmed) return false;
    const d = (e.event_time_bj || '').slice(0, 10);
    if (!d || d < today) return false;
    const wk = new Date(new Date(today + 'T00:00:00Z').getTime() + 7 * 86400000).toISOString().slice(0, 10);
    return d <= wk;
  }

  function render(container) {
    container.innerHTML = `<div class="empty">加载中…</div>`;
    FW.call('calendar:list')
      .then((events) => {
        const today = new Date().toISOString().slice(0, 10);
        const sorted = (events || []).slice().sort((a, b) => String(a.event_time_bj).localeCompare(String(b.event_time_bj)));
        const rows = sorted
          .map((e) => {
            const nc = needsConfirm(e, today);
            const conf = e.confirmed
              ? '<span class="tag ok">已确认</span>'
              : `<span class="tag ${nc ? 'warn' : ''}">${nc ? '未确认·待核对' : '未确认'}</span>`;
            return `<tr>
              <td>${UI.esc(e.event_time_bj || '—')}<div class="faint" style="font-size:11px">${UI.esc(e.origin_tz || '')}</div></td>
              <td>${UI.esc(e.title)}${e.detail ? `<div class="faint" style="font-size:11px;margin-top:3px;max-width:360px">${UI.esc(e.detail)}</div>` : ''}</td>
              <td><span class="tag">${CAT[e.category] || e.category || '其他'}</span></td>
              <td class="faint" style="font-size:12px">${UI.esc(e.source || '—')}</td>
              <td>${conf}</td>
              <td>
                <button class="btn btn-sm" data-confirm="${e.id}" data-val="${e.confirmed ? 0 : 1}">${e.confirmed ? '取消确认' : '确认'}</button>
                <button class="btn btn-sm btn-danger" data-del="${e.id}">删除</button>
              </td>
            </tr>`;
          })
          .join('');

        container.innerHTML = `
          <div class="toolbar">
            <h2 class="section-title" style="margin:0">事件日历</h2>
            <div class="spacer"></div>
            <span class="sub">全部时间换算为北京时间 · 一周内未确认事件已标注「待核对」</span>
            <button class="btn" id="btnAddEv">+ 手动添加</button>
            <button class="btn btn-primary" id="btnCalRefresh">⟳ 刷新日历</button>
          </div>
          <div class="card" style="padding:0">
            <table>
              <thead><tr><th>北京时间</th><th>事件</th><th>类别</th><th>来源</th><th>确认状态</th><th>操作</th></tr></thead>
              <tbody>${rows || '<tr><td colspan="6" class="faint">暂无事件，点击刷新或手动添加</td></tr>'}</tbody>
            </table>
          </div>
          <div class="note-box">
            数据来源分级：美联储 FOMC 会议（federalreserve.gov 官网，已确认）；A股新股申购 / 财报预约（交易所/东方财富数据中心，已确认或交易所预约）；
            CPI / 非农（按 BLS 官方发布规律推算，<b>全部标注未确认</b>并附官网链接供核对）。过期事件已自动归档。
          </div>
        `;

        const refresh = () => {
          const b = document.getElementById('btnCalRefresh');
          b.disabled = true; b.textContent = '刷新中…';
          FW.call('calendar:refresh')
            .then(() => render(container))
            .catch((e) => { UI.toast('刷新失败：' + e.message); b.disabled = false; b.textContent = '⟳ 刷新日历'; });
        };
        document.getElementById('btnCalRefresh').onclick = refresh;
        document.getElementById('btnAddEv').onclick = () => openAdd(container);

        container.querySelectorAll('[data-confirm]').forEach((b) => {
          b.onclick = async () => {
            await FW.call('calendar:confirm', { id: b.getAttribute('data-confirm'), confirmed: Number(b.getAttribute('data-val')) === 1 });
            render(container);
          };
        });
        container.querySelectorAll('[data-del]').forEach((b) => {
          b.onclick = async () => {
            if (!(await UI.confirmBox('删除事件', '确认删除该事件？'))) return;
            await FW.call('calendar:delete', { id: b.getAttribute('data-del') });
            render(container);
          };
        });
      })
      .catch((e) => {
        container.innerHTML = `<div class="empty">加载失败：${UI.esc(e.message)}</div>`;
      });
  }

  function openAdd(container) {
    const today = new Date().toISOString().slice(0, 16);
    UI.showModal(`
      <h3>手动添加事件</h3>
      <div class="field"><label>标题</label><input id="eTitle" placeholder="如 某财报发布 / 某IPO申购" /></div>
      <div class="field"><label>北京时间</label><input id="eTime" type="datetime-local" value="${today}" /></div>
      <div class="field"><label>类别</label>
        <select id="eCat"><option value="CUSTOM">自定义</option><option value="IPO">打新</option><option value="EARNINGS">财报</option><option value="MACRO">宏观</option><option value="FED">美联储</option></select>
      </div>
      <div class="field"><label>重要性</label>
        <select id="eImp"><option value="LOW">低</option><option value="MEDIUM">中</option><option value="HIGH">高</option></select>
      </div>
      <div class="field"><label>来源链接（可选）</label><input id="eUrl" placeholder="https://..." /></div>
      <div class="field"><label>备注</label><textarea id="eDetail" rows="2"></textarea></div>
      <div class="modal-actions">
        <button class="btn" id="eCancel">取消</button>
        <button class="btn btn-primary" id="eSave">添加</button>
      </div>
    `);
    document.getElementById('eCancel').onclick = () => UI.closeModal();
    document.getElementById('eSave').onclick = async () => {
      const title = document.getElementById('eTitle').value.trim();
      const time = document.getElementById('eTime').value.replace('T', ' ');
      if (!title || !time) { UI.toast('请填写标题与时间'); return; }
      try {
        await FW.call('calendar:add', {
          title,
          event_time_bj: time,
          origin_tz: '手动录入',
          origin_time: time,
          category: document.getElementById('eCat').value,
          importance: document.getElementById('eImp').value,
          source_url: document.getElementById('eUrl').value.trim() || null,
          detail: document.getElementById('eDetail').value.trim(),
          confirmed: 1
        });
        UI.closeModal();
        UI.toast('已添加');
        render(container);
      } catch (e) {
        UI.toast('添加失败：' + e.message);
      }
    };
  }

  return { render };
})();
