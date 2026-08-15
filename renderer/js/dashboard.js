'use strict';
/* 今日总览（首页） */
window.Dashboard = (function () {
  const MKT_CUR = { CN: 'CNY', HK: 'HKD', US: 'USD' };
  const IDX_NAME = { 'HK:HSTECH': '恒生科技指数', 'CN:000001': '上证指数', 'CN:399001': '深证成指', 'HK:HSI': '恒生指数', 'US:IXIC': '纳斯达克', 'US:DJI': '道琼斯', 'US:INX': '标普500' };

  function kpiCard(label, value, sub, subCls) {
    return `
      <div class="kpi">
        <div class="label">${UI.esc(label)}</div>
        <div class="value">${value}</div>
        ${sub ? `<div class="sub2 ${subCls || ''}">${sub}</div>` : ''}
      </div>`;
  }

  function indexChip(key, q, cur) {
    if (!q) return `<div class="index-chip"><div class="nm">${UI.esc(IDX_NAME[key] || key)}</div><div class="px faint">行情暂缺</div></div>`;
    if (!q.ok) return `<div class="index-chip"><div class="nm">${UI.esc(q.name || IDX_NAME[key] || key)}</div><div class="px faint">${UI.esc(q.reason || '暂无数据')}</div></div>`;
    const c = UI.cls(q.changePct);
    return `
      <div class="index-chip">
        <div class="nm">${UI.esc(q.name)}</div>
        <div class="px ${c}">${UI.money(q.price, cur)} <span class="${c}">${UI.pct(q.changePct)}</span></div>
        <div class="pt">${UI.esc(q.priceTypeText || '')} · ${q.isRealtime ? '实时' : '非实时'}</div>
      </div>`;
  }

  function render(container) {
    container.innerHTML = `<div class="empty">加载中…</div>`;
    Promise.all([
      FW.call('snapshot'),
      FW.call('news:list').catch(() => []),
      FW.call('calendar:list').catch(() => []),
      FW.call('review:get').catch(() => [])
    ])
      .then(([data, news, events, reviews]) => {
        if (window.App) App.markRefresh();
        const base = data.snapshot.baseCurrency;
        const t = data.snapshot.totals;
        const rows = data.snapshot.rows || [];

        // 统一红绿涨跌率
        let up = 0, down = 0, flat = 0;
        for (const r of rows) {
          if (r.changePct == null) continue;
          if (r.changePct > 0) up++; else if (r.changePct < 0) down++; else flat++;
        }
        const total = up + down + flat || 1;
        const udbar = `
          <div class="udbar">
            <div class="u" style="width:${(up / total) * 100}%"></div>
            <div class="d" style="width:${(down / total) * 100}%"></div>
            <div class="n" style="width:${(flat / total) * 100}%"></div>
          </div>
          <div class="sub" style="margin-top:6px">上涨 <span class="up">${up}</span> · 下跌 <span class="down">${down}</span> · 平 <span class="flat">${flat}</span>（按当日涨跌幅）</div>`;

        // 持仓紧凑表
        const holdingsRows = rows
          .map(
            (r) => `<tr>
              <td>${UI.esc(r.name)} <span class="faint">${r.market}/${r.code}</span></td>
              <td>${r.marketValueBase == null ? '<span class="faint">—</span>' : UI.money(r.marketValueBase, base)}</td>
              <td class="${UI.cls(r.dayPnlBase)}">${r.dayPnlBase == null ? '<span class="faint">—</span>' : UI.money(r.dayPnlBase, base)}</td>
              <td class="${UI.cls(r.totalPnlBase)}">${r.totalPnlBase == null ? (r.costMissing ? '<span class="faint">待录入成本</span>' : '<span class="faint">—</span>') : UI.money(r.totalPnlBase, base)}</td>
              <td class="${UI.cls(r.changePct)}">${r.changePct == null ? '—' : UI.pct(r.changePct)}</td>
            </tr>`
          )
          .join('');

        // 右栏今日总览
        const directNews = (news || []).filter((n) => n.relevance && n.relevance.level === 'DIRECT').length;
        const todayStr = new Date().toISOString().slice(0, 10);
        const weekLater = new Date(new Date(todayStr + 'T00:00:00Z').getTime() + 7 * 86400000).toISOString().slice(0, 10);
        const upcoming = (events || []).filter(
          (e) => !e.archived && e.event_time_bj && e.event_time_bj.slice(0, 10) >= todayStr && e.event_time_bj.slice(0, 10) <= weekLater
        ).length;
        const todayReview = (reviews || []).length > 0;

        const rail = `
          <div class="rail-card" data-goto="news">
            <div class="rc-title">财经资讯 <span class="tag">${(news || []).length} 条</span></div>
            <div class="rc-sub">其中 ${directNews} 条与持仓直接相关 · 点击查看</div>
          </div>
          <div class="rail-card" data-goto="review" style="margin-top:12px">
            <div class="rc-title">仓位复盘 <span class="tag ${todayReview ? 'ok' : 'warn'}">${todayReview ? '今日已生成' : '尚未生成'}</span></div>
            <div class="rc-sub">A股 / 港股 / 美股 三市场每日复盘 · 点击查看</div>
          </div>
          <div class="rail-card" data-goto="holdings" style="margin-top:12px">
            <div class="rc-title">我的持仓 <span class="tag">${rows.length} 只</span></div>
            <div class="rc-sub">证券市值 ${UI.money(t.securities, base)} · 点击管理</div>
          </div>
          <div class="rail-card" data-goto="calendar" style="margin-top:12px">
            <div class="rc-title">事件日历 <span class="tag ${upcoming ? 'warn' : ''}">${upcoming} 个待关注</span></div>
            <div class="rc-sub">IPO / 美联储 / 财报 / CPI / 非农 · 点击查看</div>
          </div>
          <div class="rail-card" data-goto="settings" style="margin-top:12px">
            <div class="rc-title">设置 <span class="tag">⚙</span></div>
            <div class="rc-sub">行情源 / 汇率 / API Key / 复盘开关</div>
          </div>`;

        container.innerHTML = `
          <h2 class="section-title">今日总览</h2>
          <div class="grid kpi-row">
            ${kpiCard('总资产', UI.money(t.totalAssets, base), `基准币 ${base}`, '')}
            ${kpiCard('证券资产', UI.money(t.securities, base), `持仓 ${rows.length} 只`, '')}
            ${kpiCard('现金', UI.money(t.cash, base), t.cashMissing ? '<span class="down">汇率缺失</span>' : '可投资金', t.cashMissing ? 'down' : '')}
            ${kpiCard('当日盈亏', UI.money(t.dayPnl, base), `当日 ${UI.pct(t.dayPnlPct)}`, UI.cls(t.dayPnl))}
            ${kpiCard('总盈亏', UI.money(t.totalPnl, base), `收益率 ${UI.pct(t.totalPnlPct)}`, UI.cls(t.totalPnl))}
            ${kpiCard('收益率', UI.pct(t.totalPnlPct), `成本 ${UI.money(t.totalCost, base)}`, UI.cls(t.totalPnlPct))}
          </div>

          <div style="height:14px"></div>
          <h3 class="section-title" style="font-size:14px">关注指数</h3>
          <div class="index-strip">
            ${Object.keys(data.indexQuotes || {}).map((k) => indexChip(k, data.indexQuotes[k], MKT_CUR[k.split(':')[0]])).join('') || '<span class="faint">未配置关注指数</span>'}
          </div>

          <div style="height:18px"></div>
          <div class="two-col">
            <div>
              <div class="card">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
                  <h3 class="section-title" style="margin:0;font-size:14px">我的持仓</h3>
                  <span class="sub">统一红绿涨跌率</span>
                </div>
                ${udbar}
              </div>
              <div class="card" style="margin-top:14px">
                <table>
                  <thead><tr><th>名称</th><th>市值(${base})</th><th>当日盈亏</th><th>总盈亏</th><th>涨跌幅</th></tr></thead>
                  <tbody>${holdingsRows || '<tr><td colspan="5" class="faint">暂无持仓</td></tr>'}</tbody>
                </table>
              </div>
            </div>
            <div>${rail}</div>
          </div>

          <div class="note-box">
            数据口径：市值/盈亏以基准币 ${base} 折算；价格类型与交易时段由行情源成交日期与 IANA 时区实时判定。
            当日盈亏 = 数量 ×（当前沿用价格 − 昨收）；总盈亏 = 数量 ×（当前沿用价格 − 成本价）。缺失数据将在对应位置明确标注，绝不填充模拟值。
          </div>
        `;

        // 绑定右栏跳转
        container.querySelectorAll('.rail-card').forEach((c) => {
          c.onclick = () => window.App.navigate(c.getAttribute('data-goto'));
        });
      })
      .catch((e) => {
        container.innerHTML = `<div class="empty">加载失败：${UI.esc(e.message)}</div>`;
      });
  }

  function settings_indices(data) {
    // 优先用 settings 中的 indices；兜底内置两个
    return (window.__settings && window.__settings.indices && window.__settings.indices.length)
      ? window.__settings.indices
      : ['HK:HSTECH', 'CN:000001'];
  }

  return { render };
})();
