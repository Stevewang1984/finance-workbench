'use strict';
/* 我的持仓：增删改 + 完整明细 */
window.Holdings = (function () {
  const MKT_CUR = { CN: 'CNY', HK: 'HKD', US: 'USD' };
  const MKT_LABEL = { CN: 'A股', HK: '港股', US: '美股' };

  function statusBadge(r) {
    if (!r.quoteOk) return `<span class="pos-status err">无行情</span>`;
    if (r.isRealtime) return `<span class="pos-status real">${UI.esc(r.phaseText || '交易中')}</span>`;
    return `<span class="pos-status stale">${UI.esc(r.priceTypeText || '非实时')}</span>`;
  }

  function render(container) {
    container.innerHTML = `<div class="empty">加载中…</div>`;
    Promise.all([FW.call('snapshot'), FW.call('holdings:list').catch(() => [])])
      .then(([data, raw]) => {
        const base = data.snapshot.baseCurrency;
        const rows = data.snapshot.rows || [];
        const rawMap = {};
        raw.forEach((h) => (rawMap[h.id] = h));

        const body = rows
          .map((r) => {
            const rh = rawMap[r.id] || {};
            return `<tr>
              <td>${UI.esc(r.name)} <div class="faint" style="font-size:11px">${r.market}/${r.code} · ${UI.esc(r.sector || '未分类')}</div></td>
              <td>${r.weightPct == null ? '—' : UI.num(r.weightPct, 2) + '%'}</td>
              <td>${r.marketValueBase == null ? '<span class="faint">—</span>' : UI.money(r.marketValueBase, base)}</td>
              <td class="${UI.cls(r.dayPnlBase)}">${r.dayPnlBase == null ? (r.prevCloseMissing ? '<span class="faint">缺昨收</span>' : '<span class="faint">—</span>') : UI.money(r.dayPnlBase, base)}</td>
              <td class="${UI.cls(r.totalPnlBase)}">${r.totalPnlBase == null ? (r.costMissing ? '<span class="faint">待录入成本</span>' : '<span class="faint">—</span>') : UI.money(r.totalPnlBase, base)}</td>
              <td>${r.costPrice == null ? '<span class="faint">—</span>' : UI.money(r.costPrice, r.currency)} ${r.qtyEstimated ? '<span class="faint">·量估算</span>' : ''}</td>
              <td class="${UI.cls(r.changePct)}">${r.changePct == null ? '—' : UI.pct(r.changePct)}</td>
              <td class="${UI.cls(r.returnPct)}">${r.returnPct == null ? '—' : UI.pct(r.returnPct)}</td>
              <td>${statusBadge(r)}</td>
              <td>
                <button class="btn btn-sm" data-edit="${r.id}">编辑</button>
                <button class="btn btn-sm btn-danger" data-del="${r.id}">删除</button>
              </td>
            </tr>`;
          })
          .join('');

        container.innerHTML = `
          <div class="toolbar">
            <h2 class="section-title" style="margin:0">我的持仓</h2>
            <div class="spacer"></div>
            <span class="sub">基准币 ${base} · 权重按证券市值占比</span>
            <button class="btn btn-primary" id="btnNewH">+ 新建持仓</button>
          </div>
          <div class="card" style="padding:0">
            <table>
              <thead><tr>
                <th>名称 / 板块</th><th>权重</th><th>市值</th><th>当日盈亏</th><th>总盈亏</th>
                <th>成本价</th><th>涨跌幅</th><th>收益率</th><th>市场 / 交易状态</th><th>操作</th>
              </tr></thead>
              <tbody>${body || '<tr><td colspan="10" class="faint">暂无持仓，点击右上角新建</td></tr>'}</tbody>
            </table>
          </div>
          <div class="note-box">
            数量推导规则：填写「数量 + 成本价」为精确口径；仅填「投入成本 + 成本价」可反推精确数量；仅填「投入成本」（无成本价）则按现价估算数量并标注「量估算」，录入成本价后自动转为精确值。
          </div>
        `;

        container.querySelector('#btnNewH').onclick = () => openForm(container, null);
        container.querySelectorAll('[data-edit]').forEach((b) => {
          b.onclick = () => openForm(container, rawMap[b.getAttribute('data-edit')]);
        });
        container.querySelectorAll('[data-del]').forEach((b) => {
          b.onclick = async () => {
            const id = Number(b.getAttribute('data-del'));
            const ok = await UI.confirmBox('删除持仓', '确认删除该持仓记录？此操作不可撤销。');
            if (!ok) return;
            await FW.call('holdings:delete', { id });
            UI.toast('已删除');
            render(container);
          };
        });
      })
      .catch((e) => {
        container.innerHTML = `<div class="empty">加载失败：${UI.esc(e.message)}</div>`;
      });
  }

  function openForm(container, h) {
    h = h || {};
    const market = h.market || 'CN';
    const currency = h.currency || MKT_CUR[market];
    const isEdit = !!h.id;
    UI.showModal(`
      <h3>${isEdit ? '编辑持仓' : '新建持仓'}</h3>
      <div class="grid" style="grid-template-columns:1fr 1fr">
        <div class="field"><label>市场</label>
          <select id="fMarket">
            <option value="CN" ${market === 'CN' ? 'selected' : ''}>A股 (CN)</option>
            <option value="HK" ${market === 'HK' ? 'selected' : ''}>港股 (HK)</option>
            <option value="US" ${market === 'US' ? 'selected' : ''}>美股 (US)</option>
          </select>
        </div>
        <div class="field"><label>代码</label><input id="fCode" value="${UI.esc(h.code || '')}" placeholder="如 600519 / 00700 / ABCD" /></div>
        <div class="field"><label>名称</label><input id="fName" value="${UI.esc(h.name || '')}" placeholder="如 贵州茅台" /></div>
        <div class="field"><label>板块</label><input id="fSector" value="${UI.esc(h.sector || '')}" placeholder="如 白酒 / 科技" /></div>
        <div class="field"><label>币种</label>
          <select id="fCur">
            <option value="CNY" ${currency === 'CNY' ? 'selected' : ''}>CNY 人民币</option>
            <option value="HKD" ${currency === 'HKD' ? 'selected' : ''}>HKD 港币</option>
            <option value="USD" ${currency === 'USD' ? 'selected' : ''}>USD 美元</option>
          </select>
        </div>
        <div class="field"><label>资产类型</label>
          <select id="fType"><option value="STOCK" ${(h.asset_type || 'STOCK') === 'STOCK' ? 'selected' : ''}>股票</option><option value="ETF" ${(h.asset_type || '') === 'ETF' ? 'selected' : ''}>ETF</option></select>
        </div>
        <div class="field"><label>数量（股/份，可空）</label><input id="fQty" type="number" step="any" value="${h.quantity == null ? '' : h.quantity}" placeholder="如 2000" /></div>
        <div class="field"><label>成本价（可空）</label><input id="fCost" type="number" step="any" value="${h.cost_price == null ? '' : h.cost_price}" placeholder="如 250" /></div>
        <div class="field" style="grid-column:1/3"><label>投入成本（可空，用于推导/估算数量）</label><input id="fInvest" type="number" step="any" value="${h.invest_cost == null ? '' : h.invest_cost}" placeholder="如 500000" /></div>
        <div class="field" style="grid-column:1/3"><label>备注</label><textarea id="fNote" rows="2">${UI.esc(h.note || '')}</textarea></div>
      </div>
      <div class="hint" style="color:var(--text-faint);font-size:11.5px;margin-top:4px">
        规则：数量与成本价至少其一；仅填投入成本+成本价可反推精确数量；仅填投入成本则按现价估算数量并标注。
      </div>
      <div class="modal-actions">
        <button class="btn" id="fCancel">取消</button>
        <button class="btn btn-primary" id="fSave">保存</button>
      </div>
    `);
    const fMarket = document.getElementById('fMarket');
    fMarket.onchange = () => {
      document.getElementById('fCur').value = MKT_CUR[fMarket.value];
    };
    document.getElementById('fCancel').onclick = () => UI.closeModal();
    document.getElementById('fSave').onclick = async () => {
      const payload = {
        id: h.id || undefined,
        market: fMarket.value,
        code: document.getElementById('fCode').value.trim().toUpperCase(),
        name: document.getElementById('fName').value.trim(),
        sector: document.getElementById('fSector').value.trim(),
        currency: document.getElementById('fCur').value,
        asset_type: document.getElementById('fType').value,
        quantity: document.getElementById('fQty').value === '' ? null : Number(document.getElementById('fQty').value),
        cost_price: document.getElementById('fCost').value === '' ? null : Number(document.getElementById('fCost').value),
        invest_cost: document.getElementById('fInvest').value === '' ? null : Number(document.getElementById('fInvest').value),
        note: document.getElementById('fNote').value.trim()
      };
      if (!payload.code) { UI.toast('请填写代码'); return; }
      try {
        await FW.call('holdings:upsert', payload);
        UI.closeModal();
        UI.toast('已保存');
        render(container);
      } catch (e) {
        UI.toast('保存失败：' + e.message);
      }
    };
  }

  return { render };
})();
