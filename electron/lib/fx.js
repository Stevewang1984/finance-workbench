'use strict';
/**
 * 汇率模块
 * 自动源：
 *   1. frankfurter (ECB 欧洲央行官方参考汇率，工作日每日更新一次)
 *   2. open.er-api  (exchangerate-api 免费端点，每日更新)
 * 手动源：用户在设置中覆盖，必须标注「手动录入」并记录时间。
 * 汇率定义统一为：1 单位 from 货币 = rate 单位 to 货币。
 */
const http = require('./http');
const sessions = require('./sessions');

const SUPPORTED = ['CNY', 'USD', 'HKD'];

const AUTO_SOURCES = [
  {
    id: 'frankfurter',
    label: 'Frankfurter (ECB 欧央行)',
    freq: '工作日每日一次',
    async fetch(base, targets) {
      const { data, latency } = await http.getJSON(
        `https://api.frankfurter.dev/v1/latest?base=${base}&symbols=${targets.join(',')}`,
        { timeout: 12000 }
      );
      if (!data || !data.rates) throw new Error('返回缺少 rates 字段');
      return { rates: data.rates, quoteDate: data.date || null, latency };
    }
  },
  {
    id: 'erapi',
    label: 'open.er-api (ExchangeRate-API)',
    freq: '每日一次',
    async fetch(base, targets) {
      const { data, latency } = await http.getJSON(`https://open.er-api.com/v6/latest/${base}`, { timeout: 12000 });
      if (!data || data.result !== 'success' || !data.rates) throw new Error('返回 result 非 success');
      const rates = {};
      for (const t of targets) if (data.rates[t] != null) rates[t] = data.rates[t];
      const quoteDate = data.time_last_update_utc
        ? new Date(data.time_last_update_utc).toISOString().slice(0, 10)
        : null;
      return { rates, quoteDate, latency };
    }
  }
];

/**
 * 抓取所有需要的货币对（相对 USD 拉取后交叉换算，减少请求次数）
 * 返回 { pairs: {'USD/CNY': {...}}, attempts: [...] }
 */
async function fetchRates(needed = ['CNY', 'HKD'], onHealth) {
  const targets = needed.filter((c) => c !== 'USD');
  const attempts = [];
  let base = null;

  for (const src of AUTO_SOURCES) {
    const started = Date.now();
    try {
      const r = await src.fetch('USD', targets.length ? targets : ['CNY']);
      const hit = Object.keys(r.rates || {});
      if (!hit.length) throw new Error('未返回任何目标货币');
      attempts.push({ source: src.id, label: src.label, ok: true, latency: r.latency, hit });
      if (onHealth) onHealth(`fx:${src.id}`, true, r.latency, null);
      base = { src, ...r };
      break;
    } catch (e) {
      const latency = Date.now() - started;
      attempts.push({ source: src.id, label: src.label, ok: false, latency, reason: e.message || String(e) });
      if (onHealth) onHealth(`fx:${src.id}`, false, latency, e.message);
    }
  }

  if (!base) return { pairs: {}, attempts, error: '全部自动汇率源均不可用' };

  const usdTo = { USD: 1, ...base.rates };
  const pairs = {};
  const fetchedAt = sessions.beijingNowStr();

  for (const from of SUPPORTED) {
    for (const to of SUPPORTED) {
      if (from === to) continue;
      if (usdTo[from] == null || usdTo[to] == null) continue;
      // 1 from = (usdTo[to] / usdTo[from]) to
      const rate = usdTo[to] / usdTo[from];
      pairs[`${from}/${to}`] = {
        pair: `${from}/${to}`,
        rate: +rate.toFixed(6),
        source: base.src.label,
        source_id: base.src.id,
        source_type: 'AUTO',
        quote_date: base.quoteDate,
        update_freq: base.src.freq,
        fetched_at: fetchedAt,
        derived: from !== 'USD' && to !== 'USD' ? '由 USD 中间价交叉换算' : null
      };
    }
  }
  return { pairs, attempts };
}

/** 从已保存的汇率表构造换算器 */
function buildConverter(fxRows, baseCurrency) {
  const map = {};
  for (const r of fxRows) map[r.pair] = r;

  function rate(from, to) {
    if (from === to) return { rate: 1, source: '同币种', source_type: 'IDENTITY', pair: `${from}/${to}` };
    const direct = map[`${from}/${to}`];
    if (direct) return direct;
    const inv = map[`${to}/${from}`];
    if (inv && inv.rate) {
      return {
        ...inv,
        pair: `${from}/${to}`,
        rate: +(1 / inv.rate).toFixed(8),
        derived: `由 ${to}/${from} 取倒数`
      };
    }
    return null;
  }

  return {
    /** 把 amount 从 from 币种换算到 baseCurrency；缺汇率时返回 null，不做任何猜测 */
    toBase(amount, from) {
      if (amount == null) return { value: null, rateInfo: null, missing: true };
      const r = rate(from, baseCurrency);
      if (!r) {
        return {
          value: null,
          rateInfo: null,
          missing: true,
          reason: `缺少 ${from}→${baseCurrency} 汇率`
        };
      }
      return { value: amount * r.rate, rateInfo: r, missing: false };
    },
    rate,
    baseCurrency
  };
}

module.exports = { fetchRates, buildConverter, SUPPORTED, AUTO_SOURCES };
