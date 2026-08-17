'use strict';
/* ETF 动量雷达 */
window.ETFMomentum = (function () {
  const SIGNAL_CLS = { BUY: 'buy', SELL: 'sell', HOLD: 'hold', WATCH: 'watch' };
  const SIGNAL_LABEL = { BUY: '买入', SELL: '卖出', HOLD: '持有', WATCH: '观望' };
  const SIGNAL_ICO = { BUY: '▲', SELL: '▼', HOLD: '◆', WATCH: '◇' };
  const CATEGORY_LABEL = { INDEX: '指数', SECTOR: '行业', COMMODITY: '商品', BOND: '债券' };
  const CATEGORY_ICO = { INDEX: '▦', SECTOR: '▤', COMMODITY: '◈', BOND: '◉' };

  function scoreBadge(score) {
    const cls = score >= 70 ? 'buy' : score >= 50 ? 'hold' : score < 30 ? 'sell' : 'watch';
    return `<span class="score-badge ${cls}">${score.toFixed(0)}</span>`;
  }

  function signalChip(signal, score) {
    if (!signal) return '<span class="faint">—</span>';
    const cls = SIGNAL_CLS[signal] || 'watch';
    return `<span class="sig ${cls}">${SIGNAL_ICO[signal]} ${SIGNAL_LABEL[signal]}</span>`;
  }

  async function render(container) {
    container.innerHTML = `<div class="empty">加载中…</div>`;
    try {
      const [etfs, signals] = await Promise.all([
        FW.call('etf:list').catch(() => []),
        FW.call('etf:signals').catch(() => [])
      ]);

      // 按动量得分排序
      const sorted = [...signals].sort((a, b) => (b.momentum_score || 0) - (a.momentum_score || 0));

      const buyList = sorted.filter((s) => s.signal === 'BUY');
      const sellList = sorted.filter((s) => s.signal === 'SELL');
      const watchList = sorted.filter((s) => s.signal === 'WATCH' || s.signal === 'HOLD');

      container.innerHTML = `
        <div class="etf-panel">
          <div class="etf-header">
            <h2>ETF 动量雷达</h2>
            <button class="btn btn-primary" id="btnCompute">⟳ 计算今日信号</button>
          </div>
          
          <!-- 信号摘要 -->
          <div class="etf-summary">
            <div class="summary-card buy-card">
              <div class="summary-ico">▲</div>
              <div class="summary-num">${buyList.length}</div>
              <div class="summary-label">建议买入</div>
            </div>
            <div class="summary-card hold-card">
              <div class="summary-ico">◆</div>
              <div class="summary-num">${watchList.length}</div>
              <div class="summary-label">持有/观望</div>
            </div>
            <div class="summary-card sell-card">
              <div class="summary-ico">▼</div>
              <div class="summary-num">${sellList.length}</div>
              <div class="summary-label">建议卖出</div>
            </div>
            <div class="summary-card info-card">
              <div class="summary-ico">◈</div>
              <div class="summary-num">${etfs.length}</div>
              <div class="summary-label">监控 ETF</div>
            </div>
          </div>

          <!-- 持仓关联提醒 -->
          <div class="etf-alerts" id="etfAlerts"></div>

          <!-- 全市场排名 -->
          <div class="etf-table-wrap">
            <table class="etf-table">
              <thead>
                <tr>
                  <th>排序</th>
                  <th>代码</th>
                  <th>名称</th>
                  <th>类别</th>
                  <th>动量分</th>
                  <th>ROC(20d)</th>
                  <th>价格位置</th>
                  <th>相对强弱</th>
                  <th>信号</th>
                  <th>历史</th>
                </tr>
              </thead>
              <tbody id="etfTableBody"></tbody>
            </table>
          </div>

          <!-- 持仓对照 -->
          <div class="etf-holdings-ref" id="holdingsRef"></div>
        </div>
      `;

      // 渲染表格
      renderTable(sorted, etfs);

      // 渲染持仓对照
      renderHoldingsRef(sorted);

      // 绑定计算按钮
      document.getElementById('btnCompute').onclick = async () => {
        const btn = document.getElementById('btnCompute');
        btn.disabled = true;
        btn.textContent = '计算中…';
        try {
          const r = await FW.call('etf:momentum:compute');
          UI.toast(`已计算 ${r.saved || 0} 只 ETF 动量`);
          render(container);
        } catch (e) {
          UI.toast('计算失败：' + e.message);
          btn.disabled = false;
          btn.textContent = '⟳ 计算今日信号';
        }
      };

      if (window.App) window.App.markRefresh();
    } catch (e) {
      container.innerHTML = `<div class="empty">加载失败：${UI.esc(e.message)}</div>`;
    }
  }

  function renderTable(sorted, etfs) {
    const tbody = document.getElementById('etfTableBody');
    if (!tbody) return;

    tbody.innerHTML = sorted.map((s, i) => {
      const etf = etfs.find((e) => e.market === s.market && e.code === s.code);
      const cat = etf?.category || 'INDEX';
      const catIco = CATEGORY_ICO[cat] || '▦';
      const catLabel = CATEGORY_LABEL[cat] || cat;
      const score = s.momentum_score ?? 0;
      const roc = s.roc_20d;
      const pct = s.price_percentile;
      const rel = s.relative_return;

      const rocStr = roc != null ? `${roc > 0 ? '+' : ''}${roc.toFixed(2)}%` : '—';
      const rocCls = roc > 0 ? 'buy' : roc < 0 ? 'sell' : '';
      const pctStr = pct != null ? `${pct.toFixed(0)}%` : '—';
      const relStr = rel != null ? `${rel > 0 ? '+' : ''}${rel.toFixed(2)}%` : '—';
      const relCls = rel > 0 ? 'buy' : rel < 0 ? 'sell' : '';

      return `
        <tr class="etf-row ${SIGNAL_CLS[s.signal] || 'watch'}">
          <td class="rank">#${i + 1}</td>
          <td class="code">${UI.esc(s.code)}</td>
          <td>${UI.esc(etf?.name || s.code)}</td>
          <td><span class="cat">${catIco} ${catLabel}</span></td>
          <td>${scoreBadge(score)}</td>
          <td class="${rocCls}">${UI.esc(rocStr)}</td>
          <td>${UI.esc(pctStr)}</td>
          <td class="${relCls}">${UI.esc(relStr)}</td>
          <td>${signalChip(s.signal, score)}</td>
          <td><button class="btn btn-sm btn-ghost hist-btn" data-code="${UI.esc(s.code)}" data-market="${UI.esc(s.market)}">查看</button></td>
        </tr>
      `;
    }).join('');

    // 绑定历史按钮
    tbody.querySelectorAll('.hist-btn').forEach((btn) => {
      btn.onclick = () => showHistory(btn.dataset.code, btn.dataset.market);
    });
  }

  function renderHoldingsRef(signals) {
    const el = document.getElementById('holdingsRef');
    if (!el) return;

    FW.call('holdings:list').then((holdings) => {
      if (!holdings?.length) {
        el.innerHTML = '';
        return;
      }

      const matched = holdings.map((h) => {
        const sig = signals.find((s) => s.code === h.code && s.market === h.market);
        return { ...h, signal: sig };
      }).filter((h) => h.signal);

      if (!matched.length) {
        el.innerHTML = '';
        return;
      }

      el.innerHTML = `
        <div class="etf-holdings-title">持仓 ETF 动量对照</div>
        <div class="holdings-ref-list">
          ${matched.map((h) => {
            const sig = h.signal;
            const score = sig.momentum_score ?? 0;
            const action = sig.signal === 'BUY' ? '可考虑加仓' : sig.signal === 'SELL' ? '建议减仓' : '继续持有';
            return `
              <div class="hold-ref-item ${SIGNAL_CLS[sig.signal] || 'watch'}">
                <span class="ref-code">${UI.esc(h.code)}</span>
                <span class="ref-name">${UI.esc(h.name || h.code)}</span>
                <span class="ref-score">${scoreBadge(score)}</span>
                <span class="ref-action">${SIGNAL_ICO[sig.signal]} ${action}</span>
              </div>
            `;
          }).join('')}
        </div>
      `;
    }).catch(() => { el.innerHTML = ''; });
  }

  async function showHistory(code, market) {
    try {
      const history = await FW.call('etf:history', { code, days: 60 });
      if (!history?.length) {
        UI.toast('暂无历史数据');
        return;
      }

      // 绘制简单文本趋势
      const last20 = history.slice(-20);
      const lines = last20.map((r) => {
        const d = r.date.slice(5);
        const s = r.signal || '—';
        const sc = r.momentum_score?.toFixed(0) || '—';
        return `${d}  ${s.padEnd(4)}  ${sc.padStart(3)}`;
      });

      const latest = history[history.length - 1];
      UI.showModal(`
        <h3>📊 ${UI.esc(code)} 动量历史（近${history.length}日）</h3>
        <div class="history-table-wrap">
          <table class="history-table">
            <thead><tr><th>日期</th><th>信号</th><th>得分</th><th>ROC20</th></tr></thead>
            <tbody>
              ${last20.map((r) => `
                <tr class="${SIGNAL_CLS[r.signal] || 'watch'}">
                  <td>${UI.esc(r.date)}</td>
                  <td>${SIGNAL_ICO[r.signal] || '◇'} ${SIGNAL_LABEL[r.signal] || '—'}</td>
                  <td>${(r.momentum_score ?? '—').toString()}</td>
                  <td>${r.roc_20d != null ? `${r.roc_20d > 0 ? '+' : ''}${r.roc_20d.toFixed(2)}%` : '—'}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
        <div class="note-box">最新：${UI.esc(latest.date)} · ${SIGNAL_LABEL[latest.signal]} · 得分 ${latest.momentum_score?.toFixed(1) ?? '—'}</div>
        <div class="modal-actions">
          <button class="btn" id="histClose">关闭</button>
        </div>
      `);
      document.getElementById('histClose').onclick = () => UI.closeModal();
    } catch (e) {
      UI.toast('加载历史失败：' + e.message);
    }
  }

  return { render };
})();
