'use strict';
/* 应用编排：导航、自动刷新、顶栏市场状态、收盘复盘事件 */
window.App = (function () {
  const views = {
    dashboard: window.Dashboard,
    holdings: window.Holdings,
    news: window.News,
    review: window.Review,
    calendar: window.Calendar,
    etf_momentum: window.ETFMomentum,
    settings: window.Settings
  };
  let current = 'dashboard';
  let refreshTimer = null;

  async function navigate(view) {
    if (!views[view]) return;
    current = view;
    document.querySelectorAll('.nav-item').forEach((n) => n.classList.toggle('active', n.getAttribute('data-view') === view));
    const c = document.getElementById('content');
    try {
      await views[view].render(c);
    } catch (e) {
      c.innerHTML = `<div class="empty">渲染失败：${UI.esc(e.message)}</div>`;
    }
    // 同步设置缓存供各视图使用
    FW.call('settings:get')
      .then((s) => (window.__settings = s))
      .catch(() => {});
  }

  function markRefresh() {
    const el = document.getElementById('refreshInfo');
    if (el) el.textContent = '更新于 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
  }

  async function updateMarketStatus() {
    try {
      const phases = await FW.call('market:phases');
      const el = document.getElementById('marketStatus');
      if (!el || !phases) return;
      const order = [
        ['CN', 'A股'],
        ['HK', '港股'],
        ['US', '美股']
      ];
      el.innerHTML = order
        .map(([k, label]) => {
          const p = phases[k];
          let cls = 'closed';
          if (p.phase === 'REGULAR' || p.phase === 'PRE' || p.phase === 'POST' || p.phase === 'PRE_AUCTION' || p.phase === 'MIDDAY') cls = 'open';
          else if (p.phase === 'LUNCH_BREAK') cls = 'break';
          return `<span class="ms-item"><span class="ms-dot ${cls}"></span>${label} ${p.phaseText}</span>`;
        })
        .join('');
    } catch {}
  }

  async function refresh() {
    markRefresh();
    await updateMarketStatus();
    // 仅对数据视图自动重渲染，避免打断设置/表单
    if ((current === 'dashboard' || current === 'holdings') && views[current]) {
      const c = document.getElementById('content');
      try { await views[current].render(c); } catch {}
    }
  }

  function startAutoRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    const sec = (window.__settings && window.__settings.refreshSeconds) || 30;
    refreshTimer = setInterval(refresh, Math.max(10, sec) * 1000);
  }

  function setupEvents() {
    window.api.onEvent((data) => {
      if (data && data.type === 'review-ready') {
        showReviewReady(data);
      }
    });
  }

  function showReviewReady(data) {
    const r = data.review || {};
    const headlines = (r.headlines || []).map((h) => `<li>${UI.esc(h)}</li>`).join('');
    UI.showModal(`
      <h3>📝 收盘复盘已生成（${UI.esc(data.date || '')}）</h3>
      <ul class="rv-list">${headlines || '<li>无</li>'}</ul>
      <div class="note-box">${UI.esc(r.dataSourceNote || '')}</div>
      <div class="modal-actions">
        <button class="btn" id="rvLater">稍后查看</button>
        <button class="btn btn-primary" id="rvNow">查看复盘</button>
      </div>
    `);
    document.getElementById('rvLater').onclick = () => UI.closeModal();
    document.getElementById('rvNow').onclick = () => {
      UI.closeModal();
      navigate('review');
    };
  }

  function init() {
    document.querySelectorAll('.nav-item').forEach((n) => {
      n.onclick = () => navigate(n.getAttribute('data-view'));
    });
    document.getElementById('btnRefresh').onclick = () => {
      // 强制刷新行情
      FW.call('snapshot')
        .then(() => refresh())
        .catch((e) => UI.toast('刷新失败：' + e.message));
    };
    document.getElementById('btnReview').onclick = () => navigate('review');

    setupEvents();
    navigate('dashboard').then(() => {
      updateMarketStatus();
      startAutoRefresh();
    });
  }

  return { init, navigate, refresh, markRefresh };
})();

document.addEventListener('DOMContentLoaded', () => window.App.init());
