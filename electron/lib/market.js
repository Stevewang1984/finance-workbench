'use strict';
/**
 * 行情引擎
 *
 * 数据源优先级（可在设置中调整）：
 *   1. tencent    腾讯财经  qt.gtimg.cn        公开源，无需 Key，可能限流/延迟
 *   2. sina       新浪财经  hq.sinajs.cn       公开源，无需 Key，可能限流/延迟
 *   3. eastmoney  东方财富  push2.eastmoney.com 公开源，无需 Key，可能限流/延迟
 *   -- 以下需用户在「设置」中填入 Key 后自动启用，优先级高于公开源 --
 *   P. tushare    A股日线（需 token）
 *   P. finnhub    美股实时（需 key）
 *   P. twelvedata 美股/全球（需 key）
 *   P. futu       富途 OpenD（本地网关，用于打新/权限校验）
 *
 * 铁律：任何源失败都不得伪造价格。全部失败时返回 ok:false + 具体原因 + 已尝试的源。
 */
const net = require('net');
const http = require('./http');
const sessions = require('./sessions');

/* ------------------------------------------------------------------ */
/* 代码归一化                                                          */
/* ------------------------------------------------------------------ */

/** A股交易所前缀判定 */
function cnExchange(code) {
  const c = String(code).replace(/\D/g, '');
  if (/^(6|9)/.test(c)) return 'sh';
  if (/^(0|2|3)/.test(c)) return 'sz';
  if (/^(4|8)/.test(c)) return 'bj';
  return 'sh';
}

/** 内置指数：显式指定各源代码，避免与个股代码冲突（如 000001） */
const INDEX_MAP = {
  'CN:000001': { name: '上证指数', tencent: 'sh000001', sina: 'sh000001', em: '1.000001', currency: 'CNY' },
  'CN:399001': { name: '深证成指', tencent: 'sz399001', sina: 'sz399001', em: '0.399001', currency: 'CNY' },
  'CN:399006': { name: '创业板指', tencent: 'sz399006', sina: 'sz399006', em: '0.399006', currency: 'CNY' },
  'CN:000300': { name: '沪深300', tencent: 'sh000300', sina: 'sh000300', em: '1.000300', currency: 'CNY' },
  'HK:HSTECH': { name: '恒生科技指数', tencent: 'hkHSTECH', sina: 'hkHSTECH', em: '124.HSTECH', currency: 'HKD' },
  'HK:HSI': { name: '恒生指数', tencent: 'hkHSI', sina: 'hkHSI', em: '124.HSI', currency: 'HKD' },
  'US:IXIC': { name: '纳斯达克指数', tencent: 'usIXIC', sina: 'gb_ixic', em: '100.NDX', currency: 'USD' },
  'US:DJI': { name: '道琼斯指数', tencent: 'usDJI', sina: 'gb_dji', em: '100.DJIA', currency: 'USD' },
  'US:INX': { name: '标普500', tencent: 'usINX', sina: 'gb_inx', em: '100.SPX', currency: 'USD' }
};

const CURRENCY_BY_MARKET = { CN: 'CNY', HK: 'HKD', US: 'USD' };

function symKey(market, code) {
  return `${market}:${String(code).toUpperCase()}`;
}

function isIndex(market, code) {
  return !!INDEX_MAP[symKey(market, code)];
}

function tencentCode(market, code) {
  const k = symKey(market, code);
  if (INDEX_MAP[k]) return INDEX_MAP[k].tencent;
  if (market === 'CN') return cnExchange(code) + String(code).replace(/\D/g, '');
  if (market === 'HK') return 'hk' + String(code).replace(/\D/g, '').padStart(5, '0');
  if (market === 'US') return 'us' + String(code).toUpperCase();
  throw new Error(`未知市场 ${market}`);
}

function sinaCode(market, code) {
  const k = symKey(market, code);
  if (INDEX_MAP[k]) return INDEX_MAP[k].sina;
  if (market === 'CN') return cnExchange(code) + String(code).replace(/\D/g, '');
  if (market === 'HK') return 'hk' + String(code).replace(/\D/g, '').padStart(5, '0');
  if (market === 'US') return 'gb_' + String(code).toLowerCase();
  throw new Error(`未知市场 ${market}`);
}

function emSecids(market, code) {
  const k = symKey(market, code);
  if (INDEX_MAP[k]) return [INDEX_MAP[k].em];
  if (market === 'CN') {
    const c = String(code).replace(/\D/g, '');
    return [(cnExchange(c) === 'sh' ? '1.' : '0.') + c];
  }
  if (market === 'HK') return ['116.' + String(code).replace(/\D/g, '').padStart(5, '0')];
  if (market === 'US') {
    const t = String(code).toUpperCase();
    return ['105.' + t, '106.' + t, '107.' + t]; // NASDAQ / NYSE / AMEX 依次尝试
  }
  throw new Error(`未知市场 ${market}`);
}

/* ------------------------------------------------------------------ */
/* 通用解析辅助                                                        */
/* ------------------------------------------------------------------ */

const DATETIME_RE = /^(\d{14}|\d{4}[-/]\d{2}[-/]\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?)$/;

function parseTradeDateToken(tok) {
  if (!tok) return null;
  const t = String(tok).trim();
  if (/^\d{14}$/.test(t)) return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`;
  const m = t.match(/^(\d{4})[-/](\d{2})[-/](\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

const num = (v) => {
  const n = Number(v);
  return isFinite(n) ? n : null;
};

/** 用于把「北京时间字符串」转成指定市场时区的日期（美股必需） */
function beijingStrToMarketDate(bjStr, tz) {
  const m = String(bjStr).match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  // 北京时间 = UTC+8，构造对应的绝对时刻
  const utcMs = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 8, +m[5], +(m[6] || 0));
  return sessions.wallClock(tz, new Date(utcMs)).dateStr;
}

/* ------------------------------------------------------------------ */
/* 源 1：腾讯财经                                                      */
/* ------------------------------------------------------------------ */
async function fetchTencent(symbols) {
  const codes = symbols.map((s) => tencentCode(s.market, s.code));
  const url = `http://qt.gtimg.cn/q=${codes.join(',')}`;
  const res = await http.getText(url, { encoding: 'gbk', timeout: 12000 });
  const out = {};
  const lines = res.text.split(';');
  for (const line of lines) {
    const m = line.match(/v_([a-zA-Z0-9_]+)="([^"]*)"/);
    if (!m) continue;
    const provCode = m[1];
    const f = m[2].split('~');
    if (f.length < 6) continue;

    const sym = symbols.find((s) => tencentCode(s.market, s.code).toLowerCase() === provCode.toLowerCase());
    if (!sym) continue;

    // 定位时间字段，其后依次为 涨跌额、涨跌幅、最高、最低
    let ti = -1;
    for (let i = 6; i < f.length; i++) {
      if (DATETIME_RE.test(String(f[i]).trim())) {
        ti = i;
        break;
      }
    }
    const price = num(f[3]);
    const prevClose = num(f[4]);
    const open = num(f[5]);
    if (price == null || price === 0) continue;

    const change = ti >= 0 ? num(f[ti + 1]) : null;
    const changePct = ti >= 0 ? num(f[ti + 2]) : null;
    const high = ti >= 0 ? num(f[ti + 3]) : null;
    const low = ti >= 0 ? num(f[ti + 4]) : null;
    const tradeDate = ti >= 0 ? parseTradeDateToken(f[ti]) : null;

    out[symKey(sym.market, sym.code)] = {
      name: (f[1] || '').trim(),
      providerCode: provCode,
      price,
      prevClose,
      open,
      high,
      low,
      change: change != null ? change : prevClose != null ? +(price - prevClose).toFixed(6) : null,
      changePct:
        changePct != null ? changePct : prevClose ? +(((price - prevClose) / prevClose) * 100).toFixed(4) : null,
      tradeDate,
      sourceTime: ti >= 0 ? String(f[ti]).trim() : null,
      latency: res.latency
    };
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 源 2：新浪财经                                                      */
/* ------------------------------------------------------------------ */
async function fetchSina(symbols) {
  const codes = symbols.map((s) => sinaCode(s.market, s.code));
  const url = `https://hq.sinajs.cn/list=${codes.join(',')}`;
  const res = await http.getText(url, {
    encoding: 'gbk',
    timeout: 12000,
    headers: { Referer: 'https://finance.sina.com.cn/' }
  });
  const out = {};
  for (const line of res.text.split(';')) {
    const m = line.match(/hq_str_([a-zA-Z0-9_]+)="([^"]*)"/);
    if (!m) continue;
    const provCode = m[1];
    const f = m[2].split(',');
    if (f.length < 4) continue;
    const sym = symbols.find((s) => sinaCode(s.market, s.code).toLowerCase() === provCode.toLowerCase());
    if (!sym) continue;

    let rec = null;
    if (sym.market === 'CN') {
      // name,open,prevClose,price,high,low,...,date(30),time(31)
      const price = num(f[3]);
      const prevClose = num(f[2]);
      if (price == null || price === 0) continue;
      rec = {
        name: f[0],
        price,
        prevClose,
        open: num(f[1]),
        high: num(f[4]),
        low: num(f[5]),
        tradeDate: parseTradeDateToken(f[30]),
        sourceTime: `${f[30] || ''} ${f[31] || ''}`.trim()
      };
    } else if (sym.market === 'HK') {
      // engName,cnName,open,prevClose,high,low,price,change,pct,...,date(17),time(18)
      const price = num(f[6]);
      const prevClose = num(f[3]);
      if (price == null || price === 0) continue;
      rec = {
        name: f[1] || f[0],
        price,
        prevClose,
        open: num(f[2]),
        high: num(f[4]),
        low: num(f[5]),
        change: num(f[7]),
        changePct: num(f[8]),
        tradeDate: parseTradeDateToken(f[17]),
        sourceTime: `${f[17] || ''} ${f[18] || ''}`.trim()
      };
    } else {
      // 美股：name,price,pct,bjDateTime,change,open,high,low,...,prevClose(26)
      const price = num(f[1]);
      if (price == null || price === 0) continue;
      rec = {
        name: f[0],
        price,
        prevClose: num(f[26]),
        open: num(f[5]),
        high: num(f[6]),
        low: num(f[7]),
        change: num(f[4]),
        changePct: num(f[2]),
        // 新浪美股给的是北京时间，需换算成美东日期
        tradeDate: beijingStrToMarketDate(f[3], 'America/New_York'),
        sourceTime: f[3]
      };
    }

    if (!rec) continue;
    if (rec.change == null && rec.prevClose != null) rec.change = +(rec.price - rec.prevClose).toFixed(6);
    if (rec.changePct == null && rec.prevClose) {
      rec.changePct = +(((rec.price - rec.prevClose) / rec.prevClose) * 100).toFixed(4);
    }
    rec.providerCode = provCode;
    rec.latency = res.latency;
    out[symKey(sym.market, sym.code)] = rec;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 源 3：东方财富                                                      */
/* ------------------------------------------------------------------ */
async function fetchEastmoney(symbols) {
  const out = {};
  const FIELDS = 'f43,f44,f45,f46,f57,f58,f59,f60,f86,f107,f169,f170';
  for (const s of symbols) {
    let done = false;
    for (const secid of emSecids(s.market, s.code)) {
      if (done) break;
      try {
        const { data, latency } = await http.getJSON(
          `https://push2.eastmoney.com/api/qt/stock/get?secid=${encodeURIComponent(secid)}&fields=${FIELDS}&invt=2&fltt=1`,
          { timeout: 10000, headers: { Referer: 'https://quote.eastmoney.com/' } }
        );
        const d = data && data.data;
        if (!d || d.f43 == null || d.f43 === '-') continue;
        const dec = Number(d.f59);
        const div = isFinite(dec) && dec >= 0 ? Math.pow(10, dec) : 100;
        const price = num(d.f43) / div;
        if (!price) continue;
        const tz = sessions.MARKETS[s.market].tz;
        const tradeDate = d.f86 ? sessions.wallClock(tz, new Date(Number(d.f86) * 1000)).dateStr : null;
        out[symKey(s.market, s.code)] = {
          name: d.f58,
          providerCode: secid,
          price,
          prevClose: d.f60 != null ? num(d.f60) / div : null,
          open: d.f46 != null ? num(d.f46) / div : null,
          high: d.f44 != null ? num(d.f44) / div : null,
          low: d.f45 != null ? num(d.f45) / div : null,
          change: d.f169 != null ? num(d.f169) / div : null,
          changePct: d.f170 != null ? num(d.f170) / 100 : null,
          tradeDate,
          sourceTime: d.f86 ? new Date(Number(d.f86) * 1000).toISOString() : null,
          latency
        };
        done = true;
      } catch {
        /* 尝试下一个 secid */
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 付费/Key 源                                                         */
/* ------------------------------------------------------------------ */
async function fetchFinnhub(symbols, key) {
  const out = {};
  for (const s of symbols.filter((x) => x.market === 'US')) {
    const { data, latency } = await http.getJSON(
      `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(String(s.code).toUpperCase())}&token=${encodeURIComponent(key)}`,
      { timeout: 10000 }
    );
    if (!data || !data.c) continue;
    const tradeDate = data.t
      ? sessions.wallClock('America/New_York', new Date(Number(data.t) * 1000)).dateStr
      : null;
    out[symKey(s.market, s.code)] = {
      name: String(s.code).toUpperCase(),
      providerCode: String(s.code).toUpperCase(),
      price: num(data.c),
      prevClose: num(data.pc),
      open: num(data.o),
      high: num(data.h),
      low: num(data.l),
      change: num(data.d),
      changePct: num(data.dp),
      tradeDate,
      sourceTime: data.t ? new Date(Number(data.t) * 1000).toISOString() : null,
      latency
    };
  }
  return out;
}

async function fetchTwelveData(symbols, key) {
  const out = {};
  const list = symbols.filter((x) => x.market === 'US');
  if (!list.length) return out;
  const syms = list.map((s) => String(s.code).toUpperCase()).join(',');
  const { data, latency } = await http.getJSON(
    `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(syms)}&apikey=${encodeURIComponent(key)}`,
    { timeout: 12000 }
  );
  const records = data && data.symbol ? { [data.symbol]: data } : data || {};
  for (const s of list) {
    const t = String(s.code).toUpperCase();
    const d = records[t];
    if (!d || d.status === 'error' || d.close == null) continue;
    out[symKey(s.market, s.code)] = {
      name: d.name || t,
      providerCode: t,
      price: num(d.close),
      prevClose: num(d.previous_close),
      open: num(d.open),
      high: num(d.high),
      low: num(d.low),
      change: num(d.change),
      changePct: num(d.percent_change),
      tradeDate: d.datetime ? String(d.datetime).slice(0, 10) : null,
      sourceTime: d.datetime || null,
      latency
    };
  }
  return out;
}

async function fetchTushare(symbols, token) {
  const out = {};
  const list = symbols.filter((x) => x.market === 'CN');
  if (!list.length) return out;
  for (const s of list) {
    const c = String(s.code).replace(/\D/g, '');
    const ts = `${c}.${cnExchange(c) === 'sh' ? 'SH' : cnExchange(c) === 'sz' ? 'SZ' : 'BJ'}`;
    const { data, latency } = await http.getJSON('https://api.tushare.pro', {
      method: 'POST',
      timeout: 15000,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_name: 'daily',
        token,
        params: { ts_code: ts },
        fields: 'trade_date,open,high,low,close,pre_close,change,pct_chg'
      })
    });
    if (!data || data.code !== 0 || !data.data || !data.data.items || !data.data.items.length) continue;
    const cols = data.data.fields;
    const row = data.data.items[0];
    const pick = (n) => row[cols.indexOf(n)];
    const td = String(pick('trade_date'));
    out[symKey(s.market, s.code)] = {
      name: s.name || c,
      providerCode: ts,
      price: num(pick('close')),
      prevClose: num(pick('pre_close')),
      open: num(pick('open')),
      high: num(pick('high')),
      low: num(pick('low')),
      change: num(pick('change')),
      changePct: num(pick('pct_chg')),
      tradeDate: `${td.slice(0, 4)}-${td.slice(4, 6)}-${td.slice(6, 8)}`,
      sourceTime: td,
      latency,
      dailyOnly: true
    };
  }
  return out;
}

/** 富途 OpenD 本地网关连通性检测（OpenD 使用私有 protobuf 协议，此处仅做可达性与状态判定） */
function checkFutuOpenD({ host = '127.0.0.1', port = 11111 } = {}, timeout = 2500) {
  return new Promise((resolve) => {
    const started = Date.now();
    const sock = new net.Socket();
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {}
      resolve(r);
    };
    sock.setTimeout(timeout);
    sock.once('connect', () => finish({ reachable: true, host, port, latency: Date.now() - started }));
    sock.once('timeout', () => finish({ reachable: false, host, port, reason: `连接超时(${timeout}ms)` }));
    sock.once('error', (e) => finish({ reachable: false, host, port, reason: e.code || e.message }));
    sock.connect(port, host);
  });
}

/* ------------------------------------------------------------------ */
/* 源注册表                                                            */
/* ------------------------------------------------------------------ */
const SOURCES = {
  tencent: { id: 'tencent', label: '腾讯财经', type: 'PUBLIC', limited: true, markets: ['CN', 'HK', 'US'], fn: fetchTencent },
  sina: { id: 'sina', label: '新浪财经', type: 'PUBLIC', limited: true, markets: ['CN', 'HK', 'US'], fn: fetchSina },
  eastmoney: { id: 'eastmoney', label: '东方财富', type: 'PUBLIC', limited: true, markets: ['CN', 'HK', 'US'], fn: fetchEastmoney },
  finnhub: { id: 'finnhub', label: 'Finnhub', type: 'PREMIUM', limited: false, markets: ['US'], needKey: 'finnhub', fn: fetchFinnhub },
  twelvedata: { id: 'twelvedata', label: 'Twelve Data', type: 'PREMIUM', limited: false, markets: ['US'], needKey: 'twelvedata', fn: fetchTwelveData },
  tushare: { id: 'tushare', label: 'Tushare', type: 'PREMIUM', limited: false, markets: ['CN'], needKey: 'tushare', fn: fetchTushare }
};

function sourceMeta(id) {
  const s = SOURCES[id];
  if (!s) return { id, label: id, type: 'UNKNOWN', limited: true };
  return { id: s.id, label: s.label, type: s.type, limited: s.limited };
}

/**
 * 拉取行情主入口
 * @param symbols [{market, code, name?, assetType?}]
 * @param ctx { priority:[], keys:{finnhub,twelvedata,tushare}, onHealth(fn) }
 */
async function fetchQuotes(symbols, ctx = {}) {
  const priority = (ctx.priority && ctx.priority.length ? ctx.priority : ['tencent', 'sina', 'eastmoney']).slice();
  const keys = ctx.keys || {};

  // 有 Key 的付费源插到最前（用户要求：付费/授权源优先级高于公开源）
  const premium = ['tushare', 'finnhub', 'twelvedata'].filter((id) => keys[id]);
  const chain = [...premium, ...priority.filter((p) => !premium.includes(p))];

  const results = {};
  const attempts = [];
  let pending = symbols.slice();

  for (const sid of chain) {
    if (!pending.length) break;
    const src = SOURCES[sid];
    if (!src) continue;
    const applicable = pending.filter((s) => src.markets.includes(s.market));
    if (!applicable.length) continue;
    if (src.needKey && !keys[src.needKey]) {
      attempts.push({ source: sid, label: src.label, ok: false, reason: '未配置 Key，已跳过', skipped: true });
      continue;
    }

    const started = Date.now();
    try {
      const got = await src.fn(applicable, keys[src.needKey]);
      const hitKeys = Object.keys(got);
      const latency = Date.now() - started;
      attempts.push({
        source: sid,
        label: src.label,
        ok: hitKeys.length > 0,
        hit: hitKeys.length,
        requested: applicable.length,
        latency,
        reason: hitKeys.length ? null : '该源未返回任何有效标的'
      });
      if (ctx.onHealth) ctx.onHealth(sid, hitKeys.length > 0, latency, hitKeys.length ? null : '无有效返回');

      for (const [k, raw] of Object.entries(got)) {
        const sym = applicable.find((s) => symKey(s.market, s.code) === k);
        if (!sym) continue;
        results[k] = buildQuote(sym, raw, src);
      }
      pending = pending.filter((s) => !results[symKey(s.market, s.code)]);
    } catch (e) {
      const latency = Date.now() - started;
      attempts.push({ source: sid, label: src.label, ok: false, latency, reason: e.message || String(e) });
      if (ctx.onHealth) ctx.onHealth(sid, false, latency, e.message);
    }
  }

  // 仍未取到的标的：给出明确失败原因，绝不填充模拟数据
  for (const s of pending) {
    const k = symKey(s.market, s.code);
    const triedReal = attempts.filter((a) => !a.skipped);
    results[k] = {
      ok: false,
      market: s.market,
      code: s.code,
      name: s.name || s.code,
      currency: s.currency || CURRENCY_BY_MARKET[s.market],
      reason:
        triedReal.length === 0
          ? '没有可用的行情源（请在设置中检查行情源配置）'
          : `已尝试 ${triedReal.map((a) => a.label).join('、')}，均未获取到该标的数据`,
      detail: triedReal.map((a) => `${a.label}: ${a.reason || (a.ok ? '成功但不含此标的' : '失败')}`),
      suggestion: '请核对市场与代码是否匹配（A股6位数字 / 港股5位数字 / 美股字母代码），或稍后重试、切换行情源',
      checkedAt: sessions.beijingNowStr()
    };
  }

  return { quotes: results, attempts };
}

function buildQuote(sym, raw, src) {
  const market = sym.market;
  const currency = sym.currency || CURRENCY_BY_MARKET[market];
  const ctxPrice = sessions.resolvePriceType(market, raw.tradeDate);
  const idxName = INDEX_MAP[symKey(market, sym.code)];

  return {
    ok: true,
    market,
    code: sym.code,
    key: symKey(market, sym.code),
    name: sym.name || (idxName && idxName.name) || raw.name || sym.code,
    isIndex: isIndex(market, sym.code),
    currency,
    price: raw.price,
    prevClose: raw.prevClose,
    open: raw.open,
    high: raw.high,
    low: raw.low,
    change: raw.change,
    changePct: raw.changePct,
    tradeDate: raw.tradeDate,
    sourceTime: raw.sourceTime,
    // 源信息
    source: src.id,
    sourceLabel: src.label,
    sourceType: src.type,
    sourceLimited: src.limited,
    sourceNote: src.limited ? '公开行情源，可能限流或存在延迟' : '授权行情源',
    dailyOnly: !!raw.dailyOnly,
    latency: raw.latency || null,
    providerCode: raw.providerCode,
    // 时段与价格类型
    phase: ctxPrice.phase,
    phaseText: ctxPrice.phaseText,
    priceType: ctxPrice.priceType,
    priceTypeText: ctxPrice.priceTypeText,
    isRealtime: ctxPrice.isRealtime,
    staleWarning: ctxPrice.staleWarning || null,
    marketLocalTime: `${ctxPrice.local.dateStr} ${String(ctxPrice.local.hh).padStart(2, '0')}:${String(ctxPrice.local.mm).padStart(2, '0')}`,
    fetchedAt: sessions.beijingNowStr()
  };
}

module.exports = {
  fetchQuotes,
  checkFutuOpenD,
  SOURCES,
  sourceMeta,
  INDEX_MAP,
  CURRENCY_BY_MARKET,
  symKey,
  isIndex,
  cnExchange,
  tencentCode,
  sinaCode,
  emSecids
};
