'use strict';
/* 财经资讯：聚合 + 去重 + 相关性标注 */
window.News = (function () {
  function relBadge(level) {
    if (level === 'DIRECT') return '<span class="tag direct">直接相关</span>';
    if (level === 'MARKET') return '<span class="tag market">市场相关</span>';
    return '<span class="tag">一般财经</span>';
  }

  function render(container) {
    container.innerHTML = `<div class="empty">加载中…</div>`;
    FW.call('news:list')
      .then((items) => {
        const total = items.length;
        const direct = items.filter((n) => n.relevance && n.relevance.level === 'DIRECT').length;
        const list = items
          .map((n, i) => {
            const rel = n.relevance || { level: 'GENERAL', levelText: '一般财经' };
            const also = (n.alsoReportedBy && n.alsoReportedBy.length)
              ? `<span class="faint" style="font-size:11px"> · 同源重复 ${n.alsoReportedBy.length} 条已合并</span>` : '';
            return `
              <div class="card" style="padding:13px 15px">
                <div class="row-gap" style="margin-bottom:6px">
                  <span class="tag">${UI.esc(n.source || '未知')}</span>
                  ${relBadge(rel.level)}
                  <span class="faint" style="font-size:11.5px">发布 ${UI.esc(n.published_at || '—')} · 抓取 ${UI.esc(n.fetched_at || '—')}${also}</span>
                  <div class="spacer"></div>
                  ${n.url ? `<a class="btn btn-sm btn-ghost" href="#" data-url="${UI.esc(n.url)}">原文 ↗</a>` : ''}
                </div>
                <div style="font-weight:600;line-height:1.5">${UI.esc(n.title)}</div>
                <div class="sub" style="margin-top:5px;line-height:1.6">${UI.esc(n.summary || '')}</div>
                <div class="sub" id="newsContent${i}" style="display:none;margin-top:8px;line-height:1.7;white-space:pre-wrap;border-top:1px solid var(--border);padding-top:8px">${UI.esc(n.content || n.summary || '（无正文）')}</div>
                <div class="row-gap" style="margin-top:8px">
                  <button class="btn btn-sm btn-ghost" data-expand="${i}">展开正文</button>
                  ${rel.holdings && rel.holdings.length ? `<span class="faint" style="font-size:11.5px">命中持仓：${rel.holdings.map((h) => UI.esc(h.name || h.code)).join('、')}</span>` : ''}
                </div>
              </div>`;
          })
          .join('');

        container.innerHTML = `
          <div class="toolbar">
            <h2 class="section-title" style="margin:0">财经资讯</h2>
            <div class="spacer"></div>
            <span class="sub">共 ${total} 条 · 直接相关 ${direct} 条（已跨源去重）</span>
            <button class="btn btn-primary" id="btnNewsRefresh">⟳ 刷新资讯</button>
          </div>
          ${list || '<div class="empty">暂无资讯，点击刷新</div>'}
          <div class="note-box">来源：华尔街见闻 / 金十数据 / 新浪财经7x24 / 交易所公告（东方财富）/ 同花顺。每条均标注来源、发布时间(北京时间)、抓取时间、摘要与原文链接；跨源相同事件已合并并标注"同源重复"。</div>
        `;

        const refresh = () => {
          const b = document.getElementById('btnNewsRefresh');
          b.disabled = true; b.textContent = '刷新中…';
          FW.call('news:refresh')
            .then(() => render(container))
            .catch((e) => { UI.toast('刷新失败：' + e.message); b.disabled = false; b.textContent = '⟳ 刷新资讯'; });
        };
        document.getElementById('btnNewsRefresh').onclick = refresh;

        container.querySelectorAll('[data-expand]').forEach((b) => {
          b.onclick = () => {
            const c = document.getElementById('newsContent' + b.getAttribute('data-expand'));
            const open = c.style.display !== 'none';
            c.style.display = open ? 'none' : 'block';
            b.textContent = open ? '展开正文' : '收起';
          };
        });
        container.querySelectorAll('[data-url]').forEach((a) => {
          a.onclick = (e) => { e.preventDefault(); window.api.openExternal(a.getAttribute('data-url')); };
        });
      })
      .catch((e) => {
        container.innerHTML = `<div class="empty">加载失败：${UI.esc(e.message)}</div>`;
      });
  }

  return { render };
})();
