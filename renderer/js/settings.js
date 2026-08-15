'use strict';
/* 设置：基准币 / 刷新 / 行情源 / 新闻源 / 指数 / 复盘 / 汇率 / API Key / 安全 */
window.Settings = (function () {
  const INDICES = [
    { key: 'HK:HSTECH', name: '恒生科技指数' }, { key: 'HK:HSI', name: '恒生指数' },
    { key: 'CN:000001', name: '上证指数' }, { key: 'CN:399001', name: '深证成指' },
    { key: 'CN:399006', name: '创业板指' }, { key: 'CN:000300', name: '沪深300' },
    { key: 'US:IXIC', name: '纳斯达克' }, { key: 'US:DJI', name: '道琼斯' }, { key: 'US:INX', name: '标普500' }
  ];
  const NEWS = [
    { id: 'wallstreetcn', name: '华尔街见闻' }, { id: 'jin10', name: '金十数据' },
    { id: 'sina7x24', name: '新浪财经7x24' }, { id: 'em_announce', name: '交易所公告(东方财富)' }, { id: 'ths', name: '同花顺' }
  ];
  const QUOTE = [
    { id: 'tencent', name: '腾讯财经' }, { id: 'sina', name: '新浪财经' }, { id: 'eastmoney', name: '东方财富' }
  ];
  const KEYS = [
    { name: 'tushare', label: 'Tushare（A股日线，需 token）' },
    { name: 'finnhub', label: 'Finnhub（美股实时，需 key）' },
    { name: 'twelvedata', label: 'Twelve Data（美股/全球，需 key）' }
  ];

  function render(container) {
    container.innerHTML = `<div class="empty">加载中…</div>`;
    Promise.all([FW.call('settings:get'), FW.call('keys:status'), FW.call('fx:list'), FW.call('app:info')])
      .then(([s, keyStatus, fx, info]) => {
        window.__settings = s;
        const base = s.baseCurrency || 'USD';

        const quoteList = (s.quoteSourcePriority || []).slice();
        const prioritiesHtml = quoteList
          .map(
            (id, i) => `<div class="row-gap" style="margin:4px 0">
              <span class="tag">${i + 1}</span>
              <span style="min-width:90px">${QUOTE.find((q) => q.id === id) ? QUOTE.find((q) => q.id === id).name : id}</span>
              <span class="faint" style="font-size:11px">${id === 'tencent' || id === 'sina' || id === 'eastmoney' ? '公开源·可能限流' : '授权源'}</span>
              <div class="spacer"></div>
              <button class="btn btn-sm" data-up="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
              <button class="btn btn-sm" data-down="${i}" ${i === quoteList.length - 1 ? 'disabled' : ''}>↓</button>
            </div>`
          )
          .join('');

        const newsHtml = NEWS.map(
          (n) => `<label class="row-gap" style="margin:5px 14px 5px 0"><input type="checkbox" data-news="${n.id}" ${ (s.newsSources || []).includes(n.id) ? 'checked' : '' }/> ${n.name}</label>`
        ).join('');

        const idxHtml = INDICES.map(
          (n) => `<label class="row-gap" style="margin:5px 14px 5px 0"><input type="checkbox" data-idx="${n.key}" ${ (s.indices || []).includes(n.key) ? 'checked' : '' }/> ${n.name}</label>`
        ).join('');

        const fxHtml = (fx || [])
          .map(
            (r) => `<tr>
              <td>${UI.esc(r.pair)}</td>
              <td class="${UI.cls(0)}">${Number(r.rate).toFixed(4)}</td>
              <td class="faint" style="font-size:12px">${UI.esc(r.source || '')}${r.source_type === 'MANUAL' ? ' [手动]' : ''}</td>
              <td class="faint" style="font-size:12px">${UI.esc(r.update_freq || '—')}</td>
              <td class="faint" style="font-size:12px">${UI.esc(r.quote_date || '—')}</td>
            </tr>`
          )
          .join('');

        const keyHtml = KEYS.map(
          (k) => {
            const st = keyStatus[k.name] || { configured: false, masked: '' };
            return `<div class="field"><label>${k.label}</label>
              <div class="row-gap">
                <input type="password" id="key_${k.name}" placeholder="${st.configured ? '已配置（' + st.masked + '），留空不改' : '填入 Key'}" />
                <button class="btn btn-sm btn-danger" data-clearkey="${k.name}">清除</button>
              </div>
            </div>`;
          }
        ).join('');

        const futu = s.futuOpenD || { host: '127.0.0.1', port: 11111 };

        container.innerHTML = `
          <h2 class="section-title">设置</h2>

          <div class="grid" style="grid-template-columns:1fr 1fr;gap:16px">
            <div class="card">
              <h4 class="section-title" style="font-size:13px">基础</h4>
              <div class="field"><label>基准币种（组合折算货币）</label>
                <select id="sBase"><option value="USD" ${base === 'USD' ? 'selected' : ''}>USD 美元</option><option value="CNY" ${base === 'CNY' ? 'selected' : ''}>CNY 人民币</option><option value="HKD" ${base === 'HKD' ? 'selected' : ''}>HKD 港币</option></select>
              </div>
              <div class="field"><label>行情自动刷新间隔（秒）</label><input id="sRefresh" type="number" min="10" value="${s.refreshSeconds || 30}" /></div>
              <div class="field"><label class="row-gap"><input type="checkbox" id="sAutoReview" ${s.autoReviewAfterClose ? 'checked' : ''}/> 收盘后自动生成每日复盘日报</label></div>
            </div>

            <div class="card">
              <h4 class="section-title" style="font-size:13px">行情源优先级（高→低，付费源置顶自动生效）</h4>
              ${prioritiesHtml || '<div class="faint">无</div>'}
              <div class="faint" style="font-size:11.5px;margin-top:6px">已配置 Key 的付费源（Tushare/Finnhub/Twelve Data）会自动插入到公开源之前。</div>
            </div>
          </div>

          <div class="grid" style="grid-template-columns:1fr 1fr;gap:16px;margin-top:16px">
            <div class="card"><h4 class="section-title" style="font-size:13px">财经资讯源</h4><div>${newsHtml}</div></div>
            <div class="card"><h4 class="section-title" style="font-size:13px">首页关注指数</h4><div>${idxHtml}</div></div>
          </div>

          <div class="card" style="margin-top:16px">
            <div class="toolbar" style="margin-bottom:10px">
              <h4 class="section-title" style="margin:0;font-size:13px">汇率（多币种折算）</h4>
              <div class="spacer"></div>
              <button class="btn btn-sm" id="btnFxManual">手动录入</button>
              <button class="btn btn-sm btn-primary" id="btnFxRefresh">⟳ 刷新汇率</button>
            </div>
            <table><thead><tr><th>货币对</th><th>汇率</th><th>来源</th><th>更新频率</th><th>报价日</th></tr></thead>
              <tbody>${fxHtml || '<tr><td colspan="5" class="faint">暂无汇率，点击刷新</td></tr>'}</tbody></table>
            <div class="faint" style="font-size:11.5px;margin-top:6px">自动源：Frankfurter(ECB 欧央行) / open.er-api；手动录入的汇率标注「[手动]」并保留录入时间。</div>
          </div>

          <div class="card" style="margin-top:16px">
            <h4 class="section-title" style="font-size:13px">API Key（本地加密存储，绝不出现在日志/源码）</h4>
            <div class="grid" style="grid-template-columns:1fr 1fr 1fr;gap:14px">${keyHtml}</div>
            <div class="field" style="margin-top:12px"><label>富途 OpenD 网关（打新/权限校验，本地网关）</label>
              <div class="row-gap">
                <input id="futuHost" value="${UI.esc(futu.host)}" style="width:180px" placeholder="127.0.0.1" />
                <input id="futuPort" type="number" value="${futu.port}" style="width:100px" placeholder="11111" />
                <button class="btn btn-sm" id="btnFutuCheck">连通性检测</button>
                <span id="futuResult" class="faint" style="font-size:12px"></span>
              </div>
            </div>
            <div class="faint" style="font-size:11.5px;margin-top:8px">存储方式：${UI.esc((info && info.storage && info.storage.mode) || '—')}。Key 仅以密文保存于用户数据目录，渲染进程只拿到掩码。</div>
          </div>

          <div class="card" style="margin-top:16px">
            <h4 class="section-title" style="font-size:13px">数据与存储</h4>
            <div class="sub">数据库路径：${UI.esc((info && info.db && info.db.path) || '—')}</div>
            <div class="sub" style="margin-top:4px">数据随应用关闭自动落盘，重开自动恢复；请勿手动编辑该 SQLite 文件。</div>
          </div>

          <div class="toolbar" style="margin-top:18px">
            <div class="spacer"></div>
            <button class="btn btn-primary" id="btnSaveSettings">保存设置</button>
          </div>
        `;

        // 行情源排序
        container.querySelectorAll('[data-up]').forEach((b) => {
          b.onclick = () => { move(quoteList, +b.getAttribute('data-up'), -1); syncQuote(s, quoteList); render(container); };
        });
        container.querySelectorAll('[data-down]').forEach((b) => {
          b.onclick = () => { move(quoteList, +b.getAttribute('data-down'), 1); syncQuote(s, quoteList); render(container); };
        });

        // 清除 key
        container.querySelectorAll('[data-clearkey]').forEach((b) => {
          b.onclick = async () => {
            await FW.call('keys:set', { name: b.getAttribute('data-clearkey'), value: '' });
            UI.toast('已清除');
            render(container);
          };
        });

        document.getElementById('btnFxRefresh').onclick = async () => {
          const b = document.getElementById('btnFxRefresh'); b.disabled = true; b.textContent = '刷新中…';
          await FW.call('fx:refresh');
          render(container);
        };
        document.getElementById('btnFxManual').onclick = () => openFxManual(container);
        document.getElementById('btnFutuCheck').onclick = async () => {
          const r = await FW.call('futu:check');
          const el = document.getElementById('futuResult');
          el.textContent = r.reachable ? `可达 (${r.latency}ms)` : `不可达：${r.reason || ''}`;
          el.className = r.reachable ? 'up' : 'down';
        };

        document.getElementById('btnSaveSettings').onclick = async () => {
          const patch = {
            baseCurrency: document.getElementById('sBase').value,
            refreshSeconds: Math.max(10, Number(document.getElementById('sRefresh').value) || 30),
            autoReviewAfterClose: document.getElementById('sAutoReview').checked,
            quoteSourcePriority: quoteList,
            newsSources: NEWS.filter((n) => container.querySelector(`[data-news="${n.id}"]`).checked).map((n) => n.id),
            indices: INDICES.filter((n) => container.querySelector(`[data-idx="${n.key}"]`).checked).map((n) => n.key),
            futuOpenD: {
              host: document.getElementById('futuHost').value || '127.0.0.1',
              port: Number(document.getElementById('futuPort').value) || 11111
            }
          };
          // API keys
          for (const k of KEYS) {
            const v = document.getElementById('key_' + k.name).value;
            if (v) await FW.call('keys:set', { name: k.name, value: v });
          }
          await FW.call('settings:save', patch);
          window.__settings = await FW.call('settings:get');
          UI.toast('设置已保存');
          if (window.App) App.refresh();
        };
      })
      .catch((e) => {
        container.innerHTML = `<div class="empty">加载失败：${UI.esc(e.message)}</div>`;
      });
  }

  function move(arr, i, d) {
    const j = i + d;
    if (j < 0 || j >= arr.length) return;
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  function syncQuote(s, list) {
    // 暂存到 s 以便重渲染后保留（渲染时从 s 读取）
    s.quoteSourcePriority = list.slice();
  }
  function openFxManual(container) {
    const pairs = ['USD/CNY', 'USD/HKD', 'CNY/USD', 'HKD/USD', 'CNY/HKD', 'HKD/CNY'];
    UI.showModal(`
      <h3>手动录入汇率</h3>
      <div class="field"><label>货币对（1 from = rate to）</label>
        <select id="fxPair">${pairs.map((p) => `<option>${p}</option>`).join('')}</select></div>
      <div class="field"><label>汇率</label><input id="fxRate" type="number" step="any" placeholder="如 7.18" /></div>
      <div class="hint" style="color:var(--text-faint);font-size:11.5px">手动录入的汇率将标注「[手动]」，并在首页/持仓中以「手动录入[讯]」来源显示，优先级高于自动源。</div>
      <div class="modal-actions">
        <button class="btn" id="fxCancel">取消</button>
        <button class="btn btn-primary" id="fxSave">保存</button>
      </div>
    `);
    document.getElementById('fxCancel').onclick = () => UI.closeModal();
    document.getElementById('fxSave').onclick = async () => {
      const pair = document.getElementById('fxPair').value;
      const rate = Number(document.getElementById('fxRate').value);
      if (!rate) { UI.toast('请填写汇率'); return; }
      await FW.call('fx:setManual', { pair, rate });
      UI.closeModal();
      UI.toast('已录入手动汇率');
      render(container);
    };
  }

  return { render };
})();
