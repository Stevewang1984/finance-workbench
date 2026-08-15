'use strict';
/**
 * 交易时段判定（严格区分 A股 / 港股 / 美股）
 * 使用 IANA 时区计算各市场本地墙上时钟，自动处理美国夏令时(EDT/EST)。
 * 非交易日不靠硬编码节假日表，而是用「行情返回的最后成交日 vs 市场当日」比对判定，
 * 因此不会因节假日表过期而误判。
 */

const MARKETS = {
  CN: {
    key: 'CN',
    label: 'A股',
    tz: 'Asia/Shanghai',
    currency: 'CNY',
    // 分钟数（自 00:00 起）
    preAuction: [[9 * 60 + 15, 9 * 60 + 25]],
    regular: [
      [9 * 60 + 30, 11 * 60 + 30],
      [13 * 60, 15 * 60]
    ],
    pre: [],
    post: [],
    closeMinute: 15 * 60
  },
  HK: {
    key: 'HK',
    label: '港股',
    tz: 'Asia/Hong_Kong',
    currency: 'HKD',
    preAuction: [[9 * 60, 9 * 60 + 20]],
    regular: [
      [9 * 60 + 30, 12 * 60],
      [13 * 60, 16 * 60]
    ],
    pre: [],
    post: [],
    closeMinute: 16 * 60
  },
  US: {
    key: 'US',
    label: '美股',
    tz: 'America/New_York',
    currency: 'USD',
    preAuction: [],
    regular: [[9 * 60 + 30, 16 * 60]],
    pre: [[4 * 60, 9 * 60 + 30]],
    post: [[16 * 60, 20 * 60]],
    closeMinute: 16 * 60
  }
};

const WEEKEND = new Set(['Sat', 'Sun']);

function wallClock(tz, date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short'
  });
  const p = {};
  for (const part of fmt.formatToParts(date)) p[part.type] = part.value;
  const hh = Number(p.hour) % 24;
  const mm = Number(p.minute);
  return {
    dateStr: `${p.year}-${p.month}-${p.day}`,
    y: Number(p.year),
    m: Number(p.month),
    d: Number(p.day),
    hh,
    mm,
    ss: Number(p.second),
    weekday: p.weekday,
    minutes: hh * 60 + mm,
    isWeekend: WEEKEND.has(p.weekday)
  };
}

function inAny(ranges, minutes) {
  return ranges.some(([a, b]) => minutes >= a && minutes < b);
}

/**
 * 返回市场当前时段状态
 * phase: WEEKEND | PRE_AUCTION | PRE | REGULAR | LUNCH_BREAK | POST | CLOSED
 */
function marketPhase(marketKey, now = new Date()) {
  const m = MARKETS[marketKey];
  if (!m) throw new Error(`未知市场: ${marketKey}`);
  const wc = wallClock(m.tz, now);

  if (wc.isWeekend) {
    return { market: marketKey, label: m.label, tz: m.tz, phase: 'WEEKEND', phaseText: '周末休市', local: wc };
  }
  if (inAny(m.preAuction, wc.minutes)) {
    return { market: marketKey, label: m.label, tz: m.tz, phase: 'PRE_AUCTION', phaseText: '集合竞价', local: wc };
  }
  if (inAny(m.regular, wc.minutes)) {
    return { market: marketKey, label: m.label, tz: m.tz, phase: 'REGULAR', phaseText: '盘中交易', local: wc };
  }
  if (inAny(m.pre, wc.minutes)) {
    return { market: marketKey, label: m.label, tz: m.tz, phase: 'PRE', phaseText: '盘前交易', local: wc };
  }
  if (inAny(m.post, wc.minutes)) {
    return { market: marketKey, label: m.label, tz: m.tz, phase: 'POST', phaseText: '盘后交易', local: wc };
  }
  // A股/港股 午间休市
  if (m.regular.length === 2 && wc.minutes >= m.regular[0][1] && wc.minutes < m.regular[1][0]) {
    return { market: marketKey, label: m.label, tz: m.tz, phase: 'LUNCH_BREAK', phaseText: '午间休市', local: wc };
  }
  const afterClose = wc.minutes >= m.closeMinute;
  return {
    market: marketKey,
    label: m.label,
    tz: m.tz,
    phase: 'CLOSED',
    phaseText: afterClose ? '已收盘' : '未开盘',
    local: wc
  };
}

/**
 * 结合行情返回的成交日期，判定「价格类型」。
 * 这是防止把昨日收盘价当成实时价的关键环节。
 */
function resolvePriceType(marketKey, quoteTradeDate, now = new Date()) {
  const m = MARKETS[marketKey];
  const phase = marketPhase(marketKey, now);
  const marketToday = wallClock(m.tz, now).dateStr;
  const sameDay = quoteTradeDate && quoteTradeDate === marketToday;

  if (!quoteTradeDate) {
    return {
      ...phase,
      priceType: 'UNKNOWN',
      priceTypeText: '价格日期未知',
      isRealtime: false,
      staleWarning: '行情源未提供成交日期，无法确认价格新鲜度'
    };
  }

  if (sameDay) {
    switch (phase.phase) {
      case 'REGULAR':
        return { ...phase, priceType: 'REALTIME', priceTypeText: '实时价(盘中)', isRealtime: true, tradeDate: quoteTradeDate };
      case 'PRE_AUCTION':
        return { ...phase, priceType: 'AUCTION', priceTypeText: '集合竞价参考价', isRealtime: true, tradeDate: quoteTradeDate };
      case 'PRE':
        return { ...phase, priceType: 'PRE', priceTypeText: '盘前价', isRealtime: true, tradeDate: quoteTradeDate };
      case 'POST':
        return { ...phase, priceType: 'POST', priceTypeText: '盘后价', isRealtime: true, tradeDate: quoteTradeDate };
      case 'LUNCH_BREAK':
        return { ...phase, priceType: 'MIDDAY', priceTypeText: '午休暂停价(上午收盘)', isRealtime: false, tradeDate: quoteTradeDate };
      default:
        return { ...phase, priceType: 'TODAY_CLOSE', priceTypeText: '今日收盘价', isRealtime: false, tradeDate: quoteTradeDate };
    }
  }

  // 行情日期 != 市场当日 → 最近收盘价（节假日 / 尚未开盘 / 数据滞后）
  return {
    ...phase,
    priceType: 'LAST_CLOSE',
    priceTypeText: `最近收盘价(${quoteTradeDate})`,
    isRealtime: false,
    tradeDate: quoteTradeDate,
    staleWarning: `行情日期 ${quoteTradeDate} 与市场当日 ${marketToday} 不一致：今日可能为非交易日或行情源尚未更新`
  };
}

function beijingNowStr(now = new Date()) {
  const wc = wallClock('Asia/Shanghai', now);
  const p = (n) => String(n).padStart(2, '0');
  return `${wc.dateStr} ${p(wc.hh)}:${p(wc.mm)}:${p(wc.ss)}`;
}

function toBeijing(date) {
  const wc = wallClock('Asia/Shanghai', date);
  const p = (n) => String(n).padStart(2, '0');
  return `${wc.dateStr} ${p(wc.hh)}:${p(wc.mm)}`;
}

function allPhases(now = new Date()) {
  return {
    CN: marketPhase('CN', now),
    HK: marketPhase('HK', now),
    US: marketPhase('US', now)
  };
}

module.exports = { MARKETS, wallClock, marketPhase, resolvePriceType, beijingNowStr, toBeijing, allPhases };
