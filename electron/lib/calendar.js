'use strict';
/**
 * 事件日历
 *
 * 数据来源分级（严格区分「官方确认」与「规律推算」）：
 *   [已确认·官方]  美联储 FOMC 会议    federalreserve.gov 官网
 *   [已确认·交易所] A股新股申购/打新    东方财富数据中心（交易所发行数据）
 *   [已确认·交易所] A股财报预约披露日   东方财富数据中心（交易所预约披露）
 *   [未确认·推算]  美国 CPI / 非农     依据 BLS 官方固定发布规律推算，标注未确认并附官网链接
 *   [用户手动]     自定义事件          用户自行录入，标记来源为「手动录入」
 *
 * 统一规则：
 *   - 所有时间统一换算为北京时间展示，同时保留原始时区与当地时间
 *   - 一周内且未确认的事件强制标注「未确认」
 *   - 过期事件自动归档
 */
const crypto = require('crypto');
const http = require('./http');
const sessions = require('./sessions');

const idOf = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 20);

/** 把美东墙上时间精确换算为 UTC（自动判定 EDT/EST） */
function etToUtc(y, m, d, hh, mm) {
  for (const off of [4, 5]) {
    const utc = Date.UTC(y, m - 1, d, hh + off, mm);
    const back = sessions.wallClock('America/New_York', new Date(utc));
    if (back.y === y && back.m === m && back.d === d && back.hh === hh && back.mm === mm) {
      return { date: new Date(utc), tzLabel: off === 4 ? 'EDT (UTC-4)' : 'EST (UTC-5)' };
    }
  }
  return { date: new Date(Date.UTC(y, m - 1, d, hh + 5, mm)), tzLabel: 'EST (UTC-5)' };
}

function bjFromEt(y, m, d, hh, mm) {
  const { date, tzLabel } = etToUtc(y, m, d, hh, mm);
  return {
    event_time_bj: sessions.toBeijing(date),
    origin_tz: `America/New_York ${tzLabel}`,
    origin_time: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')} ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
  };
}

/* ------------------------------------------------------------------ */
/* 1. 美联储 FOMC（官网）                                              */
/* ------------------------------------------------------------------ */
const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12
};

async function fetchFOMC() {
  const url = 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm';
  const res = await http.getText(url, { timeout: 20000 });
  const html = res.text;
  const events = [];

  // 按年份分块：<h4>2026 FOMC Meetings</h4> ... 或 panel-heading 内含年份
  const yearBlocks = [];
  const yearRe = /(\d{4})\s+FOMC\s+Meetings/gi;
  let ym;
  while ((ym = yearRe.exec(html)) !== null) {
    yearBlocks.push({ year: Number(ym[1]), start: ym.index });
  }
  for (let i = 0; i < yearBlocks.length; i++) {
    yearBlocks[i].end = i + 1 < yearBlocks.length ? yearBlocks[i + 1].start : html.length;
  }
  if (!yearBlocks.length) throw new Error('未能在页面中定位 FOMC 年份区块，页面结构可能已变更');

  const meetingRe =
    /fomc-meeting__month[^>]*>\s*(?:<strong>)?\s*([A-Za-z]+)(?:\/([A-Za-z]+))?\s*(?:<\/strong>)?\s*<\/div>\s*<div[^>]*fomc-meeting__date[^>]*>\s*([^<]*?)\s*<\/div>/gi;

  for (const blk of yearBlocks) {
    const seg = html.slice(blk.start, blk.end);
    let m;
    meetingRe.lastIndex = 0;
    while ((m = meetingRe.exec(seg)) !== null) {
      const monthName = String(m[1] || '').toLowerCase();
      const month2 = String(m[2] || '').toLowerCase();
      const mon = MONTHS[monthName];
      if (!mon) continue;
      const dateTxt = String(m[3] || '').replace(/\*/g, '').trim();
      // 形如 "27-28" / "16-17" / "9-10"；跨月形如 April/May "29-1"
      const dm = dateTxt.match(/(\d{1,2})\s*[-–]\s*(\d{1,2})/) || dateTxt.match(/(\d{1,2})/);
      if (!dm) continue;
      const startDay = Number(dm[1]);
      const endDay = dm[2] ? Number(dm[2]) : startDay;
      // 决议在最后一天美东 14:00 公布
      const endMonth = month2 && MONTHS[month2] && endDay < startDay ? MONTHS[month2] : mon;
      const endYear = endMonth < mon ? blk.year + 1 : blk.year;
      const t = bjFromEt(endYear, endMonth, endDay, 14, 0);
      const label = `${blk.year}年${mon}月FOMC会议决议`;
      events.push({
        id: idOf(`fomc:${endYear}-${endMonth}-${endDay}`),
        title: `美联储FOMC议息决议（${blk.year}年${mon}月${startDay}${endDay !== startDay ? '-' + endDay : ''}日会议）`,
        category: 'FED',
        ...t,
        source: '美联储官网 federalreserve.gov',
        source_url: url,
        confirmed: 1,
        importance: 'HIGH',
        detail: `会议日期 ${mon}/${startDay}${endDay !== startDay ? `-${endDay}` : ''}，利率决议与声明于会议最后一日美东 14:00 发布（官方日程，已确认）。${label}`
      });
    }
  }
  if (!events.length) throw new Error('FOMC 页面解析到 0 条会议，解析规则需更新');
  return { events, latency: res.latency };
}

/* ------------------------------------------------------------------ */
/* 2. A股新股申购（打新）                                              */
/* ------------------------------------------------------------------ */
async function fetchIPO() {
  const url =
    'https://datacenter-web.eastmoney.com/api/data/v1/get?sortColumns=APPLY_DATE&sortTypes=-1&pageSize=50&pageNumber=1&reportName=RPTA_APP_IPOAPPLY&columns=ALL&source=WEB&client=WEB';
  const { data, latency } = await http.getJSON(url, {
    timeout: 15000,
    headers: { Referer: 'https://data.eastmoney.com/xg/xg/default.html' }
  });
  if (!data || !data.result || !Array.isArray(data.result.data)) throw new Error('返回结构异常');
  const events = [];
  const todayBj = sessions.wallClock('Asia/Shanghai').dateStr;

  for (const r of data.result.data) {
    const applyDate = (r.APPLY_DATE || '').slice(0, 10);
    if (!applyDate) continue;
    // 只保留今天及未来 + 最近过去 30 天
    if (applyDate < shiftDate(todayBj, -30)) continue;

    const name = r.SECURITY_NAME_ABBR || r.SECURITY_NAME || r.SECURITY_CODE;
    const price = r.ISSUE_PRICE != null ? r.ISSUE_PRICE : r.PREDICT_ISSUE_PRICE || null;
    events.push({
      id: idOf(`ipo:${r.SECURITY_CODE}:${applyDate}`),
      title: `新股申购 ${name}（申购代码 ${r.APPLY_CODE || '-'}）`,
      category: 'IPO',
      event_time_bj: `${applyDate} 09:30`,
      origin_tz: 'Asia/Shanghai CST (UTC+8)',
      origin_time: `${applyDate} 09:30`,
      source: `${r.TRADE_MARKET || '交易所'}（东方财富数据中心）`,
      source_url: `https://data.eastmoney.com/xg/xg/detail/${r.SECURITY_CODE}.html`,
      confirmed: 1,
      importance: 'MEDIUM',
      detail: [
        `证券代码 ${r.SECUCODE || r.SECURITY_CODE}`,
        `申购代码 ${r.APPLY_CODE || '-'}`,
        price ? `发行价 ${price} 元` : '发行价待定',
        r.ONLINE_APPLY_UPPER ? `网上申购上限 ${r.ONLINE_APPLY_UPPER} 股` : null,
        r.ASSIGN_DATE ? `配号日 ${String(r.ASSIGN_DATE).slice(0, 10)}` : null,
        r.BALLOT_NUM_DATE ? `中签号公布 ${String(r.BALLOT_NUM_DATE).slice(0, 10)}` : null,
        r.BALLOT_PAY_DATE ? `中签缴款 ${String(r.BALLOT_PAY_DATE).slice(0, 10)}` : null,
        r.LISTING_DATE ? `上市日 ${String(r.LISTING_DATE).slice(0, 10)}` : null
      ]
        .filter(Boolean)
        .join(' | ')
    });

    // 中签缴款日单列提醒（打新关键节点，容易错过）
    const payDate = (r.BALLOT_PAY_DATE || '').slice(0, 10);
    if (payDate && payDate >= shiftDate(todayBj, -30)) {
      events.push({
        id: idOf(`ipopay:${r.SECURITY_CODE}:${payDate}`),
        title: `中签缴款截止 ${name}`,
        category: 'IPO',
        event_time_bj: `${payDate} 16:00`,
        origin_tz: 'Asia/Shanghai CST (UTC+8)',
        origin_time: `${payDate} 16:00`,
        source: `${r.TRADE_MARKET || '交易所'}（东方财富数据中心）`,
        source_url: `https://data.eastmoney.com/xg/xg/detail/${r.SECURITY_CODE}.html`,
        confirmed: 1,
        importance: 'HIGH',
        detail: `若中签需在 ${payDate} 日终前确保资金到账，否则视为放弃。申购代码 ${r.APPLY_CODE || '-'}。`
      });
    }
  }
  return { events, latency };
}

/* ------------------------------------------------------------------ */
/* 3. A股财报预约披露                                                  */
/* ------------------------------------------------------------------ */
async function fetchCnEarnings(holdings) {
  const cnCodes = (holdings || []).filter((h) => h.market === 'CN').map((h) => String(h.code).replace(/\D/g, ''));
  if (!cnCodes.length) return { events: [], latency: 0, skipped: '无A股持仓，跳过财报日历' };

  const reportDate = latestReportPeriod();
  const filter = encodeURIComponent(`(REPORT_DATE='${reportDate}')(SECURITY_CODE in (${cnCodes.map((c) => `"${c}"`).join(',')}))`);
  const url =
    `https://datacenter-web.eastmoney.com/api/data/v1/get?sortColumns=FIRST_APPOINT_DATE&sortTypes=1&pageSize=100&pageNumber=1` +
    `&reportName=RPT_PUBLIC_BS_APPOIN&columns=ALL&source=WEB&client=WEB&filter=${filter}`;

  const { data, latency } = await http.getJSON(url, {
    timeout: 15000,
    headers: { Referer: 'https://data.eastmoney.com/bbsj/' }
  });
  if (!data || !data.result || !Array.isArray(data.result.data)) return { events: [], latency, skipped: '该报告期暂无预约数据' };

  const events = [];
  for (const r of data.result.data) {
    const d =
      (r.ACTUAL_PUBLISH_DATE || r.THIRD_CHANGE_DATE || r.SECOND_CHANGE_DATE || r.FIRST_CHANGE_DATE || r.FIRST_APPOINT_DATE || '').slice(0, 10);
    if (!d) continue;
    const actual = !!r.ACTUAL_PUBLISH_DATE;
    events.push({
      id: idOf(`cnearn:${r.SECURITY_CODE}:${reportDate}`),
      title: `${r.SECURITY_NAME_ABBR || r.SECURITY_CODE} ${reportDate.slice(0, 4)}年${reportPeriodLabel(reportDate)}财报${actual ? '已披露' : '预约披露'}`,
      category: 'EARNINGS',
      event_time_bj: `${d} 08:00`,
      origin_tz: 'Asia/Shanghai CST (UTC+8)',
      origin_time: `${d} 08:00`,
      source: '交易所预约披露（东方财富数据中心）',
      source_url: `https://data.eastmoney.com/bbsj/${r.SECURITY_CODE}.html`,
      confirmed: actual ? 1 : 0,
      importance: 'HIGH',
      detail: actual
        ? `实际披露日 ${d}（已确认）`
        : `交易所预约披露日 ${d}；公司可申请变更，披露前请以最新公告为准（尚未实际披露，标记未确认）`
    });
  }
  return { events, latency };
}

function latestReportPeriod() {
  const wc = sessions.wallClock('Asia/Shanghai');
  const y = wc.y;
  const m = wc.m;
  if (m >= 10) return `${y}-09-30`;
  if (m >= 7) return `${y}-06-30`;
  if (m >= 4) return `${y}-03-31`;
  return `${y - 1}-12-31`;
}
function reportPeriodLabel(rd) {
  const md = rd.slice(5);
  return md === '03-31' ? '一季报' : md === '06-30' ? '半年报' : md === '09-30' ? '三季报' : '年报';
}

/* ------------------------------------------------------------------ */
/* 4. 美国 CPI / 非农（依据 BLS 官方发布规律推算，标注未确认）            */
/* ------------------------------------------------------------------ */
/**
 * BLS 官方规律：
 *   非农就业(Employment Situation)：每月第一个周五 08:30 ET
 *   CPI：每月中旬（通常 10-15 日之间的工作日）08:30 ET
 * BLS 官网对非浏览器请求返回 403，无法直接抓取确认，因此：
 *   - 全部标记 confirmed=0（未确认）
 *   - detail 明确写出「推算依据」，并给出官方日程页链接供人工确认
 */
function computeUsMacroEvents(monthsAhead = 3) {
  const events = [];
  const wc = sessions.wallClock('America/New_York');
  let y = wc.y;
  let m = wc.m;

  for (let i = 0; i < monthsAhead; i++) {
    // --- 非农：第一个周五 ---
    const firstFri = nthWeekdayOfMonth(y, m, 5, 1);
    if (firstFri) {
      const t = bjFromEt(y, m, firstFri, 8, 30);
      events.push({
        id: idOf(`nfp:${y}-${m}`),
        title: `美国非农就业数据（${m}月发布）`,
        category: 'MACRO',
        ...t,
        source: 'BLS 美国劳工统计局（发布规律推算）',
        source_url: 'https://www.bls.gov/schedule/news_release/empsit.htm',
        confirmed: 0,
        importance: 'HIGH',
        detail:
          `【推算，非官方抓取】依据 BLS 惯例：Employment Situation 于每月第一个周五 08:30 ET 发布。` +
          `本条为按规律推算的 ${y}-${String(m).padStart(2, '0')}-${String(firstFri).padStart(2, '0')}，请点击来源链接核对官方日程后手动确认。`
      });
    }
    // --- CPI：每月 10-15 日间的工作日（取第一个工作日） ---
    const cpiDay = firstWorkdayInRange(y, m, 10, 15);
    if (cpiDay) {
      const t = bjFromEt(y, m, cpiDay, 8, 30);
      events.push({
        id: idOf(`cpi:${y}-${m}`),
        title: `美国CPI通胀数据（${m}月发布）`,
        category: 'MACRO',
        ...t,
        source: 'BLS 美国劳工统计局（发布规律推算）',
        source_url: 'https://www.bls.gov/schedule/news_release/cpi.htm',
        confirmed: 0,
        importance: 'HIGH',
        detail:
          `【推算，非官方抓取】依据 BLS 惯例：CPI 于每月中旬工作日 08:30 ET 发布。` +
          `本条为按规律推算的 ${y}-${String(m).padStart(2, '0')}-${String(cpiDay).padStart(2, '0')}，实际日期可能相差 1-3 天，请点击来源链接核对官方日程后手动确认。`
      });
    }
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return events;
}

/** 求某年月第 n 个星期 wd（0=周日..6=周六）的日期 */
function nthWeekdayOfMonth(y, m, wd, n) {
  const first = new Date(Date.UTC(y, m - 1, 1));
  const firstWd = first.getUTCDay();
  let day = 1 + ((wd - firstWd + 7) % 7) + (n - 1) * 7;
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return day <= dim ? day : null;
}
function firstWorkdayInRange(y, m, from, to) {
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  for (let d = from; d <= Math.min(to, dim); d++) {
    const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    if (wd !== 0 && wd !== 6) return d;
  }
  return null;
}

function shiftDate(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ */
/* 聚合                                                               */
/* ------------------------------------------------------------------ */
async function fetchAll(holdings, onHealth) {
  const attempts = [];
  const events = [];

  const tasks = [
    ['fomc', '美联储FOMC(官网)', fetchFOMC],
    ['ipo', 'A股新股申购(交易所)', fetchIPO],
    ['cn_earnings', 'A股财报预约(交易所)', () => fetchCnEarnings(holdings)]
  ];

  const results = await Promise.allSettled(
    tasks.map(async ([id, label, fn]) => {
      const started = Date.now();
      try {
        const r = await fn();
        attempts.push({ source: id, label, ok: true, count: r.events.length, latency: r.latency, note: r.skipped || null });
        if (onHealth) onHealth(`cal:${id}`, true, r.latency, null);
        return r.events;
      } catch (e) {
        const latency = Date.now() - started;
        attempts.push({ source: id, label, ok: false, latency, reason: e.message || String(e) });
        if (onHealth) onHealth(`cal:${id}`, false, latency, e.message);
        return [];
      }
    })
  );
  for (const r of results) if (r.status === 'fulfilled') events.push(...r.value);

  // 宏观事件为本地推算，不涉及网络
  const macro = computeUsMacroEvents(3);
  events.push(...macro);
  attempts.push({ source: 'us_macro', label: 'CPI/非农(规律推算)', ok: true, count: macro.length, latency: 0, note: '本地推算，全部标记未确认' });

  return { events, attempts };
}

/** 一周内且未确认 → 需要提醒用户核对 */
function annotateUrgency(events, nowBj) {
  const now = nowBj || sessions.beijingNowStr();
  const weekLater = shiftDate(now.slice(0, 10), 7);
  for (const e of events) {
    const d = (e.event_time_bj || '').slice(0, 10);
    e.isPast = !!(e.event_time_bj && e.event_time_bj < now);
    e.withinWeek = !!(d && d >= now.slice(0, 10) && d <= weekLater);
    e.needsConfirm = !!(e.withinWeek && !e.confirmed);
    e.daysUntil = d ? Math.round((new Date(d + 'T00:00:00Z') - new Date(now.slice(0, 10) + 'T00:00:00Z')) / 86400000) : null;
  }
  return events;
}

module.exports = { fetchAll, annotateUrgency, computeUsMacroEvents, fetchFOMC, fetchIPO, shiftDate };
