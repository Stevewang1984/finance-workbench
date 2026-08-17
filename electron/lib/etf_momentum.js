'use strict';
/**
 * ETF 动量引擎
 * 
 * 指标计算：
 *   - 趋势强度：ROC(20d) 线性回归斜率（归一化到 -1..1）权重 40%
 *   - 价格位置：当前价在 120d 窗口的百分位权重 30%
 *   - 相对强弱：ETF ROC(20d) 相对基准的超额权重 30%
 * 
 * 信号规则（默认阈值可配置）：
 *   momentum_score >= 70 → BUY / HOLD
 *   momentum_score < 30  → SELL
 *   30 <= score < 70     → WATCH
 */
const { get, all, run, saveEtfMomentum, latestEtfMomentum } = require('./store');
const market = require('./market');
const sessions = require('./sessions');

/* ------------------------------------------------------------------ */
/* 工具函数                                                            */
/* ------------------------------------------------------------------ */

function todayBj() {
  return sessions.beijingNowStr().slice(0, 10);
}

/** 线性回归斜率（最小二乘法），返回 slope / intercept */
function linearRegression(points) {
  const n = points.length;
  if (n < 2) return { slope: 0, intercept: points[0] ? points[0].y : 0 };
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (const p of points) {
    sumX += p.x; sumY += p.y; sumXY += p.x * p.y; sumX2 += p.x * p.x;
  }
  const denom = n * sumX2 - sumX * sumX;
  if (Math.abs(denom) < 1e-12) return { slope: 0, intercept: sumY / n };
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}

/** 标准化斜率：把 ROC 回归斜率映射到 -1..1 */
function normalizeSlope(slope, price) {
  if (!price || price <= 0) return 0;
  // 用价格水平的 1% 作为归一化基准
  const scale = price * 0.01;
  const norm = slope / scale;
  return Math.max(-1, Math.min(1, norm));
}

/** 百分位排名 */
function percentileRank(values, target) {
  if (!values || values.length === 0) return 50;
  let count = 0;
  for (const v of values) { if (v < target) count++; }
  return (count / values.length) * 100;
}

/* ------------------------------------------------------------------ */
/* 获取历史收盘价（从本地 DB 或行情源）                                */
/* ------------------------------------------------------------------ */

async function fetchHistory(marketCode, code, lookback = 150) {
  // 优先从 price_closes 取
  const rows = all(
    'SELECT trade_date, close FROM price_closes WHERE market=? AND code=? ORDER BY trade_date DESC LIMIT ?',
    [marketCode, String(code).toUpperCase(), lookback]
  ).reverse();

  if (rows.length >= 30) return rows.map((r) => ({ date: r.trade_date, close: r.close }));

  // 数据不足时，尝试从行情源拉取（仅当日，回退用）
  try {
    const symbols = [{ market: marketCode, code: String(code).toUpperCase() }];
    const result = await market.fetchQuotes(symbols, {
      priority: ['tencent', 'sina'],
      keys: {}
    });
    const q = result.quotes[market.symKey(marketCode, String(code).toUpperCase())];
    if (q && q.ok && q.prevClose) {
      rows.unshift({ date: todayBj(), close: q.price });
    }
  } catch {}
  return rows;
}

/* ------------------------------------------------------------------ */
/* 动量计算核心                                                        */
/* ------------------------------------------------------------------ */

function computeMomentum(history, benchmarkHistory, config = {}) {
  const { window20 = 20, window60 = 60, window120 = 120 } = config;

  if (history.length < 10) return null;

  const prices = history.map((r) => r.close);
  const dates = history.map((r) => r.date);
  const n = prices.length;

  // ROC 计算
  function roc(days) {
    if (n < days + 1) return null;
    const old = prices[n - days - 1];
    const now = prices[n - 1];
    if (!old || old <= 0) return null;
    return ((now - old) / old) * 100;
  }

  const roc5 = roc(5);
  const roc20 = roc(20);
  const roc60 = roc(60);

  // 趋势强度：ROC(20d) 线性回归斜率
  const recent20 = prices.slice(-window20);
  const { slope: trendSlope } = linearRegression(
    recent20.map((p, i) => ({ x: i, y: p }))
  );
  const trendScore = normalizeSlope(trendSlope, prices[n - 1]);

  // 价格位置：当前价在 120d 窗口的百分位
  const lookback120 = Math.min(window120, n - 1);
  const windowPrices = prices.slice(-lookback120);
  const pricePercentile = percentileRank(windowPrices, prices[n - 1]);
  const positionScore = pricePercentile / 100; // 0..1

  // 相对强弱：ETF ROC 相对基准 ROC
  let relativeScore = 0.5;
  let benchmarkReturn = null;
  let relativeReturn = null;
  if (benchmarkHistory && benchmarkHistory.length >= window20) {
    const bmPrices = benchmarkHistory.map((r) => r.close);
    const bmN = bmPrices.length;
    const bmRoc20 = roc20ForPrices(bmPrices, window20);
    if (roc20 != null && bmRoc20 != null && Math.abs(bmRoc20) > 0.001) {
      relativeReturn = roc20 - bmRoc20;
      // 超额收益归一化
      relativeScore = Math.max(0, Math.min(1, 0.5 + relativeReturn / 10));
    }
    benchmarkReturn = bmRoc20;
  }

  // 加权综合得分
  const momentumScore =
    trendScore * 0.4 * 100 +
    positionScore * 0.3 * 100 +
    relativeScore * 0.3 * 100;

  // 信号判定
  let signal = 'WATCH';
  if (momentumScore >= 70) signal = 'BUY';
  else if (momentumScore >= 50) signal = 'HOLD';
  else if (momentumScore < 30) signal = 'SELL';

  return {
    roc_5d: roc5,
    roc_20d: roc20,
    roc_60d: roc60,
    price_percentile: parseFloat(pricePercentile.toFixed(1)),
    trend_score: parseFloat(trendScore.toFixed(3)),
    position_score: parseFloat(positionScore.toFixed(3)),
    relative_score: parseFloat(relativeScore.toFixed(3)),
    momentum_score: parseFloat(momentumScore.toFixed(1)),
    signal,
    benchmark_return: benchmarkReturn,
    relative_return: relativeReturn,
    price: prices[n - 1],
    date: dates[dates.length - 1]
  };
}

function roc20ForPrices(prices, days = 20) {
  const n = prices.length;
  if (n < days + 1) return null;
  const old = prices[n - days - 1];
  const now = prices[n - 1];
  if (!old || old <= 0) return null;
  return ((now - old) / old) * 100;
}

/* ------------------------------------------------------------------ */
/* 回测引擎                                                            */
/* ------------------------------------------------------------------ */

function runBacktest(params) {
  // params: { code, start_date, end_date, threshold_buy, threshold_sell }
  const { code, threshold_buy = 70, threshold_sell = 30, lookback = 252 } = params;
  
  // 获取历史动量数据
  const history = all(
    'SELECT * FROM etf_momentum WHERE code=? ORDER BY date ASC',
    [String(code).toUpperCase()]
  );
  
  if (history.length < lookback) {
    return { error: `历史动量数据不足（需要 ${lookback} 条，现有 ${history.length} 条）` };
  }

  // 模拟交易
  let cash = 100000;
  let shares = 0;
  let entryPrice = 0;
  let trades = 0;
  let wins = 0;
  const equityCurve = [];
  
  for (let i = lookback; i < history.length; i++) {
    const row = history[i];
    const prev = history[i - 1];
    const price = row.price;
    
    if (!price || !prev?.price) continue;
    
    // 买入信号
    if (row.signal === 'BUY' && shares === 0) {
      shares = Math.floor(cash / price);
      entryPrice = price;
      cash -= shares * price;
      trades++;
    }
    // 卖出信号
    else if (row.signal === 'SELL' && shares > 0) {
      cash += shares * price;
      const pnl = (price - entryPrice) * shares;
      if (pnl > 0) wins++;
      shares = 0;
      entryPrice = 0;
      trades++;
    }
    
    // 记录权益
    equityCurve.push({ date: row.date, value: cash + shares * price });
  }
  
  // 最终平仓
  const finalPrice = history[history.length - 1].price;
  if (shares > 0) {
    cash += shares * finalPrice;
    trades++;
  }
  
  const totalReturn = ((cash - 100000) / 100000) * 100;
  const days = history.length;
  const annualReturn = totalReturn * (252 / days);
  
  // 计算夏普比率（简化版，假设无风险利率 2%）
  const returns = equityCurve.map((e, i) => 
    i > 0 ? (e.value - equityCurve[i - 1].value) / equityCurve[i - 1].value : 0
  );
  const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const stdReturn = Math.sqrt(
    returns.reduce((acc, r) => acc + Math.pow(r - avgReturn, 2), 0) / returns.length
  );
  const sharpe = stdReturn > 0 ? (avgReturn * 252 - 0.02) / (stdReturn * Math.sqrt(252)) : 0;
  
  // 最大回撤
  let peak = 0;
  let maxDrawdown = 0;
  for (const e of equityCurve) {
    if (e.value > peak) peak = e.value;
    const dd = (peak - e.value) / peak;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }
  
  const winRate = trades > 0 ? (wins / trades) * 100 : 0;
  
  return {
    etf_code: code,
    start_date: history[lookback]?.date,
    end_date: history[history.length - 1]?.date,
    total_return: parseFloat(totalReturn.toFixed(2)),
    annual_return: parseFloat(annualReturn.toFixed(2)),
    sharpe: parseFloat(sharpe.toFixed(2)),
    max_drawdown: parseFloat((maxDrawdown * 100).toFixed(2)),
    win_rate: parseFloat(winRate.toFixed(1)),
    trades,
    final_equity: cash
  };
}

/* ------------------------------------------------------------------ */
/* 主入口：计算并保存当日动量                                          */
/* ------------------------------------------------------------------ */

async function computeAndSave(settings) {
  const etfs = all('SELECT * FROM etf_list WHERE enabled = 1');
  if (etfs.length === 0) return { saved: 0 };
  
  const results = [];
  const today = todayBj();
  
  for (const etf of etfs) {
    try {
      // 获取 ETF 历史价格
      const history = await fetchHistory(etf.market, etf.code, 150);
      
      // 获取基准历史价格
      let benchmarkHistory = null;
      if (etf.benchmark) {
        const [bmMarket, bmCode] = etf.benchmark.split(':');
        benchmarkHistory = await fetchHistory(bmMarket, bmCode, 150);
      }
      
      const m = computeMomentum(history, benchmarkHistory, {
        window20: settings.etfWindow20 || 20,
        window60: settings.etfWindow60 || 60,
        window120: settings.etfWindow120 || 120
      });
      
      if (!m) continue;
      
      m.code = etf.code;
      m.market = etf.market;
      saveEtfMomentum(m);
      results.push({ code: etf.code, market: etf.market, signal: m.signal, score: m.momentum_score });
    } catch (e) {
      console.error(`[etf_momentum] 计算失败 ${etf.code}:`, e.message);
    }
  }
  
  return { saved: results.length, results };
}

/* ------------------------------------------------------------------ */
/* 导出                                                                */
/* ------------------------------------------------------------------ */

module.exports = {
  computeMomentum,
  computeAndSave,
  runBacktest,
  fetchHistory,
  linearRegression,
  normalizeSlope,
  percentileRank
};
