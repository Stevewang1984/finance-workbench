'use strict';
/* 仓位复盘：A股 / 港股 / 美股 每日复盘 */
window.Review = (function () {
  function marketBlock(b) {
    if (!b || !b.hasData) {
      return `<div class="review-block card">
        <div class="block-head"><span class="mk">${UI.esc((b && b.label) || '')}</span><span class="pill pill-none">无持仓数据</span></div>
        <div class="sub">${UI.esc((b && b.objective && b.objective[0]) || '当前无该市场持仓。')}</div>
      </div>`;
    }
    const obj = (b.objective || []).map((x) => `<li>${UI.esc(x)}</li>`).join('');
    const inf = (b.inference || []).map((x) => `<li><span class="infer-flag">推测：</span>${UI.esc(x.replace(/^推测[:：]?/, ''))}</li>`).join('');
    const risk = (b.risk || []).map((x) => `<li>${UI.esc(x)}</li>`).join('');
    return `<div class="review-block card">
      <div class="block-head">
        <span class="mk">${UI.esc(b.label)}</span>
        <span class="pill pill-has">${b.holdingsCount} 持仓</span>
        <span class="spacer"></span>
        <span class="${UI.cls(b.dayPnlBase)}">当日 ${UI.money(b.dayPnlBase, '')} (${UI.pct(b.dayPnlPct)})</span>
        <span class="${UI.cls(b.totalPnlBase)}">总 ${UI.money(b.totalPnlBase, '')} (${UI.pct(b.totalPnlPct)})</span>
      </div>
      <div class="rv-section rv-objective"><h4>客观数据（真实行情）</h4><ul class="rv-list">${obj}</ul></div>
      <div class="rv-section rv-infer"><h4>AI 推测（条件性，仅供参考）</h4><ul class="rv-list">${inf}</ul></div>
      <div class="rv-section rv-risk"><h4>风险提示</h4><ul class="rv-list">${risk}</ul></div>
    </div>`;
  }

  function render(container) {
    container.innerHTML = `<div class="empty">加载中…</div>`;
    const today = new Date().toISOString().slice(0, 10);
    Promise.all([FW.call('review:get', { date: today }).catch(() => []), FW.call('review:history').catch(() => [])])
      .then(([reviews, history]) => {
        const rev = reviews && reviews.length ? reviews[0] : null;
        const base = rev ? rev.baseCurrency : 'USD';

        let body;
        if (!rev) {
          body = `<div class="empty">今日复盘尚未生成。<button class="btn btn-primary" id="btnGen" style="margin-left:10px">生成今日复盘</button></div>`;
        } else {
          const headlines = (rev.headlines || []).map((h) => `<li>${UI.esc(h)}</li>`).join('');
          body = `
            <div class="card" style="margin-bottom:16px">
              <div class="row-gap" style="margin-bottom:8px">
                <h3 class="section-title" style="margin:0">今日复盘 · ${UI.esc(rev.date)}</h3>
                <div class="spacer"></div>
                <span class="faint" style="font-size:12px">生成于 ${UI.esc(rev.generatedAt)} · 基准币 ${base}</span>
                <button class="btn btn-sm" id="btnGen">重新生成</button>
              </div>
              <ul class="rv-list">${headlines}</ul>
            </div>
            ${marketBlock(rev.markets && rev.markets.CN)}
            ${marketBlock(rev.markets && rev.markets.HK)}
            ${marketBlock(rev.markets && rev.markets.US)}
            <div class="note-box">
              ${UI.esc(rev.newsNote || '')}<br/>${UI.esc(rev.eventNote || '')}<br/><br/>${UI.esc(rev.dataSourceNote || '')}
            </div>`;
        }

        const hist = (history || []).slice(0, 20)
          .map((d) => `<span class="tag" style="cursor:pointer" data-date="${UI.esc(d)}">${UI.esc(d)}</span>`)
          .join(' ');

        container.innerHTML = `
          <div class="toolbar">
            <h2 class="section-title" style="margin:0">仓位复盘</h2>
            <div class="spacer"></div>
            <button class="btn btn-primary" id="btnGenTop">生成今日复盘</button>
          </div>
          ${body}
          ${hist ? `<div class="card"><h4 class="section-title" style="font-size:13px">历史复盘（点击查看）</h4><div class="row-gap">${hist}</div></div>` : ''}
        `;

        const gen = () => {
          const btn = container.querySelector('#btnGen');
          if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }
          FW.call('review:run')
            .then(() => render(container))
            .catch((e) => { UI.toast('生成失败：' + e.message); if (btn) { btn.disabled = false; btn.textContent = '重新生成'; } });
        };
        const b1 = container.querySelector('#btnGen');
        const b2 = container.querySelector('#btnGenTop');
        if (b1) b1.onclick = gen;
        if (b2) b2.onclick = gen;

        container.querySelectorAll('[data-date]').forEach((s) => {
          s.onclick = () => {
            FW.call('review:get', { date: s.getAttribute('data-date') })
              .then((rs) => {
                if (rs && rs.length) {
                  // 临时渲染历史：复用当前结构，把 rev 换成历史
                  const old = rev;
                  rev = rs[0];
                  const headlines = (rev.headlines || []).map((h) => `<li>${UI.esc(h)}</li>`).join('');
                  const block = `
                    <div class="card" style="margin-bottom:16px">
                      <h3 class="section-title" style="margin:0">复盘 · ${UI.esc(rev.date)}（历史）</h3>
                      <ul class="rv-list">${headlines}</ul>
                    </div>
                    ${marketBlock(rev.markets && rev.markets.CN)}
                    ${marketBlock(rev.markets && rev.markets.HK)}
                    ${marketBlock(rev.markets && rev.markets.US)}`;
                  const wrap = container.querySelector('.toolbar');
                  wrap.insertAdjacentHTML('afterend', block);
                  UI.toast('已插入历史复盘（滚动查看）');
                  rev = old;
                } else UI.toast('该日期无复盘记录');
              })
              .catch((e) => UI.toast('读取失败：' + e.message));
          };
        });
      })
      .catch((e) => {
        container.innerHTML = `<div class="empty">加载失败：${UI.esc(e.message)}</div>`;
      });
  }

  return { render };
})();
