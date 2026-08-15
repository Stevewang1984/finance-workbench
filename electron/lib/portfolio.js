'use strict';
/**
 * 组合计算引擎
 *
 * 计算规则（严格按约定，全部以「原币」先算，再按汇率折算到基准币种）：
 *   持仓市值   = 数量 × 当前沿用价格
 *   当日盈亏   = 数量 × (当前沿用价格 − 上一次收盘价)
 *   总盈亏     = 数量 × (当前沿用价格 − 成本价)
 *   当日涨跌%  = (当前沿用价格 − 上一次收盘价) ÷ 上一次收盘价 × 100
 *   收益率     = (当前沿用价格 − 成本价) ÷ 成本价 × 100
 *   折算       = 原币金额 × 汇率(原币→基准币)
 *   权重       = 该持仓市值(基准币) ÷ 证券总市值(基准币) × 100
 *
 * 数据不全时的处理原则（不允许用 0 或猜测值冒充）：
 *   - 数量未知但已知投入成本与成本价 → 数量 = 投入成本 ÷ 成本价（精确推导）
 *   - 数量未知且成本价未知           → 数量按现价反推为「估算值」并置 qtyEstimated
 *   - 成本价未知                     → 总盈亏/收益率 置 null 并置 costMissing
 *   - 昨收未知                       → 当日盈亏 置 null 并置 prevCloseMissing
 *   - 汇率缺失                       → 基准币金额 置 null 并置 fxMissing
 */
const fxLib = require('./fx');
const sessions = require('./sessions');

function round(n, d = 4) {
  if (n == null || !isFinite(n)) return null;
  const p = Math.pow(10, d);
  return Math.round(n * p) / p;
}

async function buildSnapshot({ holdings, cash, quotes, fxRows, baseCurrency = 'USD' }) {
  const conv = fxLib.buildConverter(fxRows || [], baseCurrency);
  const rows = [];
  const issues = [];

  for (const h of holdings) {
    const key = `${h.market}:${String(h.code).toUpperCase()}`;
    const q = quotes[key];

    const row = {
      id: h.id,
      market: h.market,
      code: h.code,
      name: h.name || (q && q.name) || h.code,
      sector: h.sector || '未分类',
      assetType: h.asset_type || 'STOCK',
      currency: h.currency,
      note: h.note || null,
      investCost: h.invest_cost == null ? null : Number(h.invest_cost),
      costPrice: h.cost_price == null ? null : Number(h.cost_price),
      quantityInput: h.quantity == null ? null : Number(h.quantity),
      qtyEstimated: false,
      costMissing: false,
      prevCloseMissing: false,
      fxMissing: false,
      quoteOk: !!(q && q.ok)
    };

    /* --- 行情缺失：整行标记不可算，写明原因 --- */
    if (!q || !q.ok) {
      row.quoteError = q ? q.reason : '未请求到该标的行情';
      row.quoteErrorDetail = q ? q.detail || null : null;
      row.quoteSuggestion = q ? q.suggestion || null : null;
      row.price = null;
      row.marketValueBase = null;
      row.dayPnlBase = null;
      row.totalPnlBase = null;
      rows.push(row);
      issues.push({ level: 'ERROR', scope: `${h.market}/${h.code}`, message: row.quoteError });
      continue;
    }

    /* --- 行情快照信息 --- */
    row.price = q.price;
    row.prevClose = q.prevClose;
    row.open = q.open;
    row.high = q.high;
    row.low = q.low;
    row.changePct = q.changePct;
    row.change = q.change;
    row.tradeDate = q.tradeDate;
    row.priceType = q.priceType;
    row.priceTypeText = q.priceTypeText;
    row.isRealtime = q.isRealtime;
    row.phase = q.phase;
    row.phaseText = q.phaseText;
    row.source = q.source;
    row.sourceLabel = q.sourceLabel;
    row.sourceType = q.sourceType;
    row.sourceLimited = q.sourceLimited;
    row.latency = q.latency;
    row.staleWarning = q.staleWarning;
    row.marketLocalTime = q.marketLocalTime;
    row.fetchedAt = q.fetchedAt;
    row.isIndex = q.isIndex;

    /* --- 数量推导 --- */
    let qty = row.quantityInput;
    if (qty == null || !isFinite(qty)) {
      if (row.investCost != null && row.costPrice != null && row.costPrice > 0) {
        qty = row.investCost / row.costPrice; // 精确推导
      } else if (row.investCost != null && q.price > 0) {
        qty = row.investCost / q.price; // 估算：假设现价近似持仓均价
        row.qtyEstimated = true;
        row.qtyEstimateBasis = `按投入成本 ${row.investCost} ÷ 当前价 ${round(q.price, 4)} 反推，成本价录入后自动转为精确值`;
      } else {
        qty = null;
      }
    }
    row.quantity = qty == null ? null : round(qty, 6);

    if (qty == null) {
      row.marketValueBase = null;
      row.dayPnlBase = null;
      row.totalPnlBase = null;
      row.calcBlocked = '数量与投入成本均未录入，无法计算市值';
      rows.push(row);
      issues.push({ level: 'WARN', scope: `${h.market}/${h.code}`, message: row.calcBlocked });
      continue;
    }

    /* --- 原币计算 --- */
    const mvLocal = qty * q.price;
    row.marketValueLocal = round(mvLocal, 2);

    let dayPnlLocal = null;
    if (q.prevClose != null && isFinite(q.prevClose)) {
      dayPnlLocal = qty * (q.price - q.prevClose);
    } else {
      row.prevCloseMissing = true;
      issues.push({ level: 'WARN', scope: `${h.market}/${h.code}`, message: '行情源未提供昨收价，当日盈亏不可算' });
    }
    row.dayPnlLocal = round(dayPnlLocal, 2);

    let totalPnlLocal = null;
    if (row.costPrice != null && row.costPrice > 0) {
      totalPnlLocal = qty * (q.price - row.costPrice);
      row.returnPct = round(((q.price - row.costPrice) / row.costPrice) * 100, 4);
    } else {
      row.costMissing = true;
      row.returnPct = null;
    }
    row.totalPnlLocal = round(totalPnlLocal, 2);
    row.costBasisLocal = row.costPrice != null ? round(qty * row.costPrice, 2) : row.investCost;

    /* --- 折算到基准币种 --- */
    const cMv = conv.toBase(mvLocal, h.currency);
    if (cMv.missing) {
      row.fxMissing = true;
      row.fxMissingReason = cMv.reason;
      issues.push({ level: 'ERROR', scope: `${h.market}/${h.code}`, message: cMv.reason });
    } else {
      row.fxPair = cMv.rateInfo.pair;
      row.fxRate = cMv.rateInfo.rate;
      row.fxSource = cMv.rateInfo.source || cMv.rateInfo.source_type;
      row.fxSourceType = cMv.rateInfo.source_type;
      row.fxQuoteDate = cMv.rateInfo.quote_date || null;
      row.fxUpdateFreq = cMv.rateInfo.update_freq || null;
      row.fxDerived = cMv.rateInfo.derived || null;
    }
    const rate = cMv.missing ? null : cMv.rateInfo.rate;

    row.marketValueBase = rate == null ? null : round(mvLocal * rate, 2);
    row.dayPnlBase = rate == null || dayPnlLocal == null ? null : round(dayPnlLocal * rate, 2);
    row.totalPnlBase = rate == null || totalPnlLocal == null ? null : round(totalPnlLocal * rate, 2);
    row.costBasisBase = rate == null || row.costBasisLocal == null ? null : round(row.costBasisLocal * rate, 2);
    row.prevCloseValueBase =
      rate == null || q.prevClose == null ? null : round(qty * q.prevClose * rate, 2);

    rows.push(row);
  }

  /* ---------- 现金 ---------- */
  const cashRows = [];
  let cashBase = 0;
  let cashMissing = false;
  for (const c of cash || []) {
    const amt = Number(c.amount) || 0;
    if (amt === 0) continue;
    const cc = conv.toBase(amt, c.currency);
    const rec = {
      currency: c.currency,
      amount: amt,
      note: c.note || null,
      amountBase: cc.missing ? null : round(cc.value, 2),
      fxPair: cc.missing ? null : cc.rateInfo.pair,
      fxRate: cc.missing ? null : cc.rateInfo.rate,
      fxSource: cc.missing ? null : cc.rateInfo.source || cc.rateInfo.source_type,
      fxSourceType: cc.missing ? null : cc.rateInfo.source_type,
      fxMissing: cc.missing,
      fxMissingReason: cc.missing ? cc.reason : null
    };
    if (cc.missing) {
      cashMissing = true;
      issues.push({ level: 'ERROR', scope: `现金/${c.currency}`, message: cc.reason });
    } else {
      cashBase += cc.value;
    }
    cashRows.push(rec);
  }

  /* ---------- 汇总 ---------- */
  const computable = rows.filter((r) => r.marketValueBase != null);
  const securities = computable.reduce((a, r) => a + r.marketValueBase, 0);

  for (const r of rows) {
    r.weightPct = r.marketValueBase != null && securities > 0 ? round((r.marketValueBase / securities) * 100, 4) : null;
  }

  const dayRows = rows.filter((r) => r.dayPnlBase != null);
  const dayPnl = dayRows.reduce((a, r) => a + r.dayPnlBase, 0);
  const prevBase = rows.filter((r) => r.prevCloseValueBase != null).reduce((a, r) => a + r.prevCloseValueBase, 0);

  const totalRows = rows.filter((r) => r.totalPnlBase != null);
  const totalPnl = totalRows.reduce((a, r) => a + r.totalPnlBase, 0);
  const totalCost = totalRows.reduce((a, r) => a + (r.costBasisBase || 0), 0);

  const totals = {
    baseCurrency,
    securities: round(securities, 2),
    cash: round(cashBase, 2),
    totalAssets: round(securities + cashBase, 2),
    dayPnl: round(dayPnl, 2),
    dayPnlPct: prevBase > 0 ? round((dayPnl / prevBase) * 100, 4) : null,
    dayPnlCoverage: `${dayRows.length}/${rows.length}`,
    totalPnl: round(totalPnl, 2),
    totalPnlPct: totalCost > 0 ? round((totalPnl / totalCost) * 100, 4) : null,
    totalCost: round(totalCost, 2),
    totalPnlCoverage: `${totalRows.length}/${rows.length}`,
    holdingsCount: rows.length,
    computableCount: computable.length,
    cashMissing,
    incomplete: rows.some((r) => !r.quoteOk || r.fxMissing || r.costMissing || r.qtyEstimated)
  };

  /* ---------- 按市场 / 板块聚合 ---------- */
  const byMarket = {};
  for (const r of rows) {
    const k = r.market;
    if (!byMarket[k]) {
      byMarket[k] = {
        market: k,
        label: sessions.MARKETS[k] ? sessions.MARKETS[k].label : k,
        marketValueBase: 0,
        dayPnlBase: 0,
        totalPnlBase: 0,
        count: 0,
        hasIncomplete: false
      };
    }
    const m = byMarket[k];
    m.count++;
    if (r.marketValueBase != null) m.marketValueBase += r.marketValueBase;
    if (r.dayPnlBase != null) m.dayPnlBase += r.dayPnlBase;
    if (r.totalPnlBase != null) m.totalPnlBase += r.totalPnlBase;
    if (!r.quoteOk || r.fxMissing || r.costMissing) m.hasIncomplete = true;
  }
  for (const m of Object.values(byMarket)) {
    m.marketValueBase = round(m.marketValueBase, 2);
    m.dayPnlBase = round(m.dayPnlBase, 2);
    m.totalPnlBase = round(m.totalPnlBase, 2);
    m.weightPct = securities > 0 ? round((m.marketValueBase / securities) * 100, 2) : null;
  }

  const bySector = {};
  for (const r of rows) {
    const k = r.sector || '未分类';
    if (!bySector[k]) bySector[k] = { sector: k, marketValueBase: 0, count: 0 };
    bySector[k].count++;
    if (r.marketValueBase != null) bySector[k].marketValueBase += r.marketValueBase;
  }
  for (const s of Object.values(bySector)) {
    s.marketValueBase = round(s.marketValueBase, 2);
    s.weightPct = securities > 0 ? round((s.marketValueBase / securities) * 100, 2) : null;
  }

  return {
    baseCurrency,
    generatedAt: sessions.beijingNowStr(),
    rows,
    cashRows,
    totals,
    byMarket: Object.values(byMarket).sort((a, b) => (b.marketValueBase || 0) - (a.marketValueBase || 0)),
    bySector: Object.values(bySector).sort((a, b) => (b.marketValueBase || 0) - (a.marketValueBase || 0)),
    issues
  };
}

module.exports = { buildSnapshot, round };
