'use strict';
/**
 * 每日仓位复盘引擎（A股 / 港股 / 美股）
 *
 * 设计原则（严格按需求）：
 *   - 所有「客观数据」均来自真实行情快照，可溯源到具体数字，绝不臆造。
 *   - 「AI 推测」一律以「推测:」前缀、条件句式呈现，明确区分于客观数据，
 *     且只基于当日已发生的真实涨跌/指数/事件做机制性推演，不编造未发生的"事实"。
 *   - 风险提示必须点明数据缺失项（如汇率/成本未录入）与跨币种折算风险。
 *
 * 依赖：snapshot（portfolio.buildSnapshot 的输出）、indexQuotes、news、events、fxRows。
 */
const sessions = require('./sessions');

function fmtMoney(v, cur) {
  if (v == null || !isFinite(v)) return '—';
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  let s;
  if (abs >= 1e8) s = (abs / 1e8).toFixed(2) + '亿';
  else if (abs >= 1e4) s = (abs / 1e4).toFixed(2) + '万';
  else s = abs.toFixed(2);
  return `${sign}${s} ${cur || ''}`.trim();
}
function pct(v) {
  if (v == null || !isFinite(v)) return '—';
  return (v > 0 ? '+' : '') + v.toFixed(2) + '%';
}
function fmtNum(v, d = 2) {
  if (v == null || !isFinite(v)) return '—';
  return (v > 0 ? '+' : '') + v.toFixed(d);
}

const MARKET_LABEL = { CN: 'A股', HK: '港股', US: '美股' };

function genMarketBlock(marketKey, snapshot, indexQuotes, fxRows, baseCurrency, holdings) {
  const rows = (snapshot.rows || []).filter((r) => r.market === marketKey && r.quoteOk);
  const label = MARKET_LABEL[marketKey] || marketKey;
  const idxKey = ({ CN: 'CN:000001', HK: 'HK:HSTECH', US: 'US:INX' })[marketKey];
  const idx = indexQuotes && indexQuotes[idxKey] && indexQuotes[idxKey].ok ? indexQuotes[idxKey] : null;

  if (!rows.length) {
    return {
      market: marketKey,
      label,
      hasData: false,
      objective: [`当前无 ${label} 持仓或行情暂未取回，无法生成该市场复盘。`],
      inference: [],
      risk: []
    };
  }

  const mv = rows.reduce((a, r) => a + (r.marketValueBase || 0), 0);
  const day = rows.reduce((a, r) => a + (r.dayPnlBase || 0), 0);
  const prev = rows.reduce((a, r) => a + (r.prevCloseValueBase || 0), 0);
  const total = rows.reduce((a, r) => a + (r.totalPnlBase || 0), 0);
  const cost = rows.reduce((a, r) => a + (r.costBasisBase || 0), 0);

  const dayPct = prev > 0 ? (day / prev) * 100 : null;
  const totalPct = cost > 0 ? (total / cost) * 100 : null;

  const movers = rows
    .map((r) => ({
      name: r.name,
      code: `${r.market}/${r.code}`,
      changePct: r.changePct,
      dayPnlBase: r.dayPnlBase,
      totalPnlBase: r.totalPnlBase,
      returnPct: r.returnPct,
      qtyEstimated: !!r.qtyEstimated,
      costMissing: !!r.costMissing,
      priceTypeText: r.priceTypeText,
      isRealtime: r.isRealtime
    }))
    .sort((a, b) => (b.changePct || -1e9) - (a.changePct || -1e9));

  const up = movers.filter((m) => (m.changePct || 0) > 0);
  const down = movers.filter((m) => (m.changePct || 0) < 0);
  const top = movers[0];
  const bottom = movers[movers.length - 1];

  const objective = [];
  objective.push(
    `${label}持仓 ${rows.length} 只，证券市值 ${fmtMoney(mv, baseCurrency)}（基准币 ${baseCurrency}）。`
  );
  objective.push(
    `当日盈亏 ${fmtMoney(day, baseCurrency)}（占上日市值 ${pct(dayPct)}），` +
      `总盈亏 ${fmtMoney(total, baseCurrency)}（收益率 ${pct(totalPct)}）。`
  );
  if (idx) {
    objective.push(
      `对标指数：${idx.name} 当日 ${pct(idx.changePct)}（价格类型：${idx.priceTypeText}）。`
    );
  } else {
    objective.push(`对标指数行情未取回，无法与指数做横向对比。`);
  }
  if (top && bottom && up.length && down.length) {
    objective.push(
      `个股层面：领涨 ${top.name}（${pct(top.changePct)}，当日盈亏 ${fmtMoney(top.dayPnlBase, baseCurrency)}），` +
        `领跌 ${bottom.name}（${pct(bottom.changePct)}，当日盈亏 ${fmtMoney(bottom.dayPnlBase, baseCurrency)}）。`
    );
  }

  // 当日盈亏归因（客观）：与指数同向/背离
  const inference = [];
  if (idx && idx.changePct != null && dayPct != null) {
    if ((dayPct > 0) === (idx.changePct > 0)) {
      inference.push(
        `推测：当日 ${label} 组合盈亏方向与 ${idx.name} 一致（组合 ${pct(dayPct)} vs 指数 ${pct(idx.changePct)}），` +
          `说明组合整体受该市场系统性因素影响为主；若指数后续延续趋势，组合短期或同向波动。`
      );
    } else {
      inference.push(
        `推测：当日 ${label} 组合盈亏方向与 ${idx.name} 背离（组合 ${pct(dayPct)} vs 指数 ${pct(idx.changePct)}），` +
          `说明个股选择或权重结构对组合贡献明显，需关注持仓结构是否过度集中。`
      );
    }
  }
  if (top && top.changePct != null) {
    inference.push(
      `推测：${top.name} 单日 ${pct(top.changePct)} 对组合当日盈亏贡献最大，` +
        `若其波动主要由事件或流动性驱动，短期仍可能放大组合波动，建议结合基本面与公告研判持续性。`
    );
  }
  if (!inference.length) {
    inference.push(`当日数据不足以做可靠归因推测，建议待更多交易日样本累积后再行判断。`);
  }

  // 风险
  const risk = [];
  const missingCost = rows.filter((r) => r.costMissing);
  const qtyEst = rows.filter((r) => r.qtyEstimated);
  const fxMiss = rows.filter((r) => r.fxMissing);
  const noRealtime = rows.filter((r) => !r.isRealtime);
  if (missingCost.length) {
    risk.push(
      `数据缺口：${missingCost.map((r) => r.name).join('、')} 未录入成本价，总盈亏/收益率暂不可算，已在明细中标注「待录入成本」。` +
        `补全成本价后系统将自动计算。`
    );
  }
  if (qtyEst.length) {
    risk.push(
      `${qtyEst.map((r) => r.name).join('、')} 数量按「投入成本÷现价」估算，成本价录入后将转为精确值，当前市值/盈亏为估算口径。`
    );
  }
  if (noRealtime.length) {
    risk.push(
      `${noRealtime.map((r) => r.name).join('、')} 当前为「${noRealtime[0].priceTypeText}」，非实时成交价，复盘结论仅反映最近收盘价口径。`
    );
  }
  // 跨币种折算风险
  const foreignHoldings = rows.filter((r) => r.currency !== baseCurrency);
  if (foreignHoldings.length) {
    const pair = `${foreignHoldings[0].currency}/${baseCurrency}`;
    const fr = (fxRows || []).find((f) => f.pair === pair);
    if (fr) {
      risk.push(
        `跨币种折算：以 ${fr.rate}（来源 ${fr.source || fr.source_type}，更新频率 ${fr.update_freq || '—'}）将 ${foreignHoldings[0].currency} 折算为 ${baseCurrency}；` +
          `汇率波动会直接改变基准币口径下的市值与盈亏，建议关注汇率来源更新频率。`
      );
    } else {
      risk.push(`跨币种折算：缺少 ${pair} 汇率，相关持仓基准币金额不可算，请刷新或手动录入汇率。`);
    }
  }
  if (!risk.length) risk.push(`当前各持仓数据完整，未见明显数据缺口风险。`);

  return {
    market: marketKey,
    label,
    hasData: true,
    marketValueBase: mv,
    dayPnlBase: day,
    dayPnlPct: dayPct,
    totalPnlBase: total,
    totalPnlPct: totalPct,
    holdingsCount: rows.length,
    movers,
    index: idx
      ? { name: idx.name, changePct: idx.changePct, priceTypeText: idx.priceTypeText, isRealtime: idx.isRealtime }
      : null,
    objective,
    inference,
    risk
  };
}

/**
 * 生成当日完整复盘
 * @param {object} inp { snapshot, indexQuotes, news, events, fxRows, baseCurrency }
 */
function generate(inp = {}) {
  const snapshot = inp.snapshot || { rows: [], totals: {} };
  const baseCurrency = inp.baseCurrency || 'USD';
  const fxRows = inp.fxRows || [];
  const news = inp.news || [];
  const events = inp.events || [];

  const blocks = {
    CN: genMarketBlock('CN', snapshot, inp.indexQuotes, fxRows, baseCurrency),
    HK: genMarketBlock('HK', snapshot, inp.indexQuotes, fxRows, baseCurrency),
    US: genMarketBlock('US', snapshot, inp.indexQuotes, fxRows, baseCurrency)
  };

  // 头条：当日对组合影响最大的市场
  const ordered = ['CN', 'HK', 'US']
    .map((k) => blocks[k])
    .filter((b) => b.hasData)
    .sort((a, b) => Math.abs(b.dayPnlBase || 0) - Math.abs(a.dayPnlBase || 0));

  const headlines = [];
  const t = snapshot.totals || {};
  headlines.push(
    `今日组合（基准币 ${baseCurrency}）：证券市值 ${fmtMoney(t.securities, baseCurrency)}，现金 ${fmtMoney(t.cash, baseCurrency)}，` +
      `总资产 ${fmtMoney(t.totalAssets, baseCurrency)}；当日盈亏 ${fmtMoney(t.dayPnl, baseCurrency)}（${pct(t.dayPnlPct)}），` +
      `总盈亏 ${fmtMoney(t.totalPnl, baseCurrency)}（${pct(t.totalPnlPct)}）。`
  );
  if (ordered.length) {
    const top = ordered[0];
    headlines.push(
      `影响最大的市场为${top.label}：当日 ${fmtMoney(top.dayPnlBase, baseCurrency)}（${pct(top.dayPnlPct)}）。`
    );
  }

  // 与持仓相关的新闻（客观提示）
  const directNews = news.filter((n) => n.relevance && n.relevance.level === 'DIRECT');
  const newsNote = directNews.length
    ? `检索到 ${directNews.length} 条与持仓直接相关的新闻，详见「财经资讯」页，建议结合复盘交叉验证。`
    : `未检索到与持仓直接相关的新闻（仅一般财经与市场类资讯）。`;

  // 近一周未确认的关键事件（客观提示）
  const nowBj = sessions.beijingNowStr();
  const wk = sessions.wallClock('Asia/Shanghai');
  const weekLater = new Date(Date.UTC(wk.y, wk.m - 1, wk.d + 7)).toISOString().slice(0, 10);
  const upcoming = events
    .filter((e) => e.event_time_bj && e.event_time_bj.slice(0, 10) >= nowBj.slice(0, 10) && e.event_time_bj.slice(0, 10) <= weekLater)
    .map((e) => `${e.title}（${e.event_time_bj}，${e.confirmed ? '已确认' : '未确认'}）`);
  const eventNote = upcoming.length ? `未来一周关键事件：${upcoming.slice(0, 5).join('；')}。` : `未来一周暂无已收录的关键事件。`;

  return {
    date: nowBj.slice(0, 10),
    generatedAt: nowBj,
    baseCurrency,
    headlines,
    markets: blocks,
    newsNote,
    eventNote,
    dataSourceNote:
      '本复盘由系统基于实时行情、公开数据源与持仓记录自动生成；其中「AI 推测」为条件性机制推演，仅供参考，不构成任何投资建议。所有客观数据均可溯源至当日行情快照。',
    coverage: snapshot.totals
      ? {
          holdingsCount: snapshot.totals.holdingsCount,
          computableCount: snapshot.totals.computableCount,
          dayPnlCoverage: snapshot.totals.dayPnlCoverage,
          totalPnlCoverage: snapshot.totals.totalPnlCoverage,
          incomplete: snapshot.totals.incomplete
        }
      : null
  };
}

module.exports = { generate, fmtMoney, pct };
