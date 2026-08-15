'use strict';
/**
 * 财经资讯聚合
 * 源：华尔街见闻 / 金十数据 / 新浪财经7x24 / 东方财富交易所公告 / 同花顺
 * 每条必须携带：来源、发布时间(北京时间)、抓取时间、摘要、原文链接
 * 具备：跨源去重（标题+正文指纹 + 近似判重）、与持仓的相关性标注
 */
const crypto = require('crypto');
const http = require('./http');
const sessions = require('./sessions');

const stripHtml = (s) =>
  String(s || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

function tsToBeijing(input) {
  if (input == null) return null;
  let d;
  if (typeof input === 'number') {
    d = new Date(input < 1e12 ? input * 1000 : input);
  } else if (/^\d{10}$/.test(String(input))) {
    d = new Date(Number(input) * 1000);
  } else if (/^\d{13}$/.test(String(input))) {
    d = new Date(Number(input));
  } else {
    const s = String(input).replace(/\//g, '-').trim();
    // 形如 2026-08-15 18:10:33 的字符串，来源本身即北京时间
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s)) return s.replace('T', ' ').slice(0, 19);
    d = new Date(s);
  }
  if (isNaN(d.getTime())) return null;
  return sessions.toBeijing(d) + ':00'.slice(0, 0) || sessions.toBeijing(d);
}

function hashOf(text) {
  const norm = String(text || '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。！？、；："""''（）【】《》,.!?;:()\[\]<>%-]/g, '')
    .toLowerCase();
  return crypto.createHash('sha1').update(norm).digest('hex');
}

/* ---------------- 各源实现 ---------------- */

const SOURCES = {
  wallstreetcn: {
    id: 'wallstreetcn',
    label: '华尔街见闻',
    async fetch(limit = 30) {
      const { data, latency } = await http.getJSON(
        `https://api-one.wallstcn.com/apiv1/content/lives?channel=global-channel&client=pc&limit=${limit}`,
        { timeout: 12000 }
      );
      if (!data || data.code !== 20000 || !data.data || !Array.isArray(data.data.items)) {
        throw new Error('返回结构异常');
      }
      return {
        latency,
        items: data.data.items.map((it) => {
          const text = stripHtml(it.content_text || it.content || '');
          const title = stripHtml(it.title || '') || text.slice(0, 40);
          return {
            source: '华尔街见闻',
            sourceId: 'wallstreetcn',
            externalId: String(it.id),
            title,
            summary: text.slice(0, 200),
            content: text,
            url: it.uri || `https://wallstreetcn.com/livenews/${it.id}`,
            published_at: tsToBeijing(it.display_time),
            channels: it.channels || []
          };
        })
      };
    }
  },

  jin10: {
    id: 'jin10',
    label: '金十数据',
    async fetch(limit = 30) {
      const { data, latency } = await http.getJSON(
        'https://flash-api.jin10.com/get_flash_list?channel=-8200&vip=1&max_time=',
        {
          timeout: 12000,
          headers: {
            'x-app-id': 'bVBF4FyRTn5NJF5n',
            'x-version': '1.0.0',
            Referer: 'https://www.jin10.com/'
          }
        }
      );
      if (!data || data.status !== 200 || !Array.isArray(data.data)) throw new Error('返回结构异常');
      const items = [];
      for (const it of data.data.slice(0, limit)) {
        const d = it.data || {};
        const title = stripHtml(d.title || d.vip_title || '');
        const content = stripHtml(d.content || d.vip_desc || '');
        const text = content || title;
        if (!text) continue;
        items.push({
          source: '金十数据',
          sourceId: 'jin10',
          externalId: String(it.id),
          title: title || text.slice(0, 40),
          summary: text.slice(0, 200),
          content: text,
          url: `https://flash.jin10.com/detail/${it.id}`,
          published_at: tsToBeijing(it.time),
          important: it.important === 1
        });
      }
      return { latency, items };
    }
  },

  sina7x24: {
    id: 'sina7x24',
    label: '新浪财经7x24',
    async fetch(limit = 30) {
      const { data, latency } = await http.getJSON(
        `https://zhibo.sina.com.cn/api/zhibo/feed?page=1&page_size=${limit}&zhibo_id=152&tag_id=0&dire=f&dpc=1`,
        { timeout: 12000, headers: { Referer: 'https://finance.sina.com.cn/7x24/' } }
      );
      const list =
        data && data.result && data.result.data && data.result.data.feed && Array.isArray(data.result.data.feed.list)
          ? data.result.data.feed.list
          : null;
      if (!list) throw new Error('返回结构异常');
      return {
        latency,
        items: list.map((it) => {
          const text = stripHtml(it.rich_text || it.text || '');
          const tMatch = text.match(/^【([^】]+)】/);
          return {
            source: '新浪财经7x24',
            sourceId: 'sina7x24',
            externalId: String(it.id),
            title: tMatch ? tMatch[1] : text.slice(0, 40),
            summary: text.slice(0, 200),
            content: text,
            url: it.docurl || `https://finance.sina.com.cn/7x24/?id=${it.id}`,
            published_at: tsToBeijing(it.create_time)
          };
        })
      };
    }
  },

  em_announce: {
    id: 'em_announce',
    label: '交易所公告(东方财富)',
    async fetch(limit = 30) {
      const { data, latency } = await http.getJSON(
        `https://np-anotice-stock.eastmoney.com/api/security/ann?page_size=${limit}&page_index=1&ann_type=A&client_source=web&f_node=0`,
        { timeout: 12000, headers: { Referer: 'https://data.eastmoney.com/notices/' } }
      );
      const list = data && data.data && Array.isArray(data.data.list) ? data.data.list : null;
      if (!list) throw new Error('返回结构异常');
      return {
        latency,
        items: list.map((it) => {
          const codes = Array.isArray(it.codes) ? it.codes : [];
          const stock = codes[0] || {};
          const cols = Array.isArray(it.columns) ? it.columns.map((c) => c.column_name).join('/') : '';
          const title = stripHtml(it.title || '');
          return {
            source: '交易所公告',
            sourceId: 'em_announce',
            externalId: String(it.art_code),
            title,
            summary: `${stock.short_name || ''}${stock.stock_code ? '(' + stock.stock_code + ')' : ''} ${cols} ${title}`.trim().slice(0, 200),
            content: title,
            url: stock.stock_code
              ? `https://data.eastmoney.com/notices/detail/${stock.stock_code}/${it.art_code}.html`
              : `https://data.eastmoney.com/notices/`,
            published_at: (it.notice_date || it.display_time || '').slice(0, 19).replace('T', ' ') || null,
            relatedCodes: codes.map((c) => ({ market: 'CN', code: c.stock_code, name: c.short_name }))
          };
        })
      };
    }
  },

  ths: {
    id: 'ths',
    label: '同花顺',
    async fetch(limit = 30) {
      const { data, latency } = await http.getJSON(
        `https://news.10jqka.com.cn/tapp/news/push/stock/?page=1&tag=&track=website&pagesize=${limit}`,
        { timeout: 12000, headers: { Referer: 'https://news.10jqka.com.cn/' } }
      );
      const list = data && data.data && Array.isArray(data.data.list) ? data.data.list : null;
      if (!list) throw new Error('返回结构异常');
      return {
        latency,
        items: list.map((it) => {
          const text = stripHtml(it.digest || it.title || '');
          return {
            source: '同花顺',
            sourceId: 'ths',
            externalId: String(it.id || it.seq),
            title: stripHtml(it.title || '').slice(0, 120),
            summary: text.slice(0, 200),
            content: text,
            url: it.url || it.appUrl || 'https://news.10jqka.com.cn/',
            published_at: tsToBeijing(it.ctime)
          };
        })
      };
    }
  }
};

/* ---------------- 去重 + 相关性 ---------------- */

/** 3-gram Jaccard 相似度，用于跨源近似判重 */
function similarity(a, b) {
  const g = (s) => {
    const t = String(s || '').replace(/\s+/g, '');
    const set = new Set();
    for (let i = 0; i < t.length - 2; i++) set.add(t.slice(i, i + 3));
    return set;
  };
  const A = g(a);
  const B = g(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

function dedupe(items) {
  const kept = [];
  const seenHash = new Set();
  let exact = 0;
  let fuzzy = 0;

  const sorted = items.slice().sort((a, b) => String(b.published_at || '').localeCompare(String(a.published_at || '')));

  for (const it of sorted) {
    const h = hashOf(it.title + '|' + (it.summary || '').slice(0, 60));
    if (seenHash.has(h)) {
      exact++;
      continue;
    }
    // 与最近 40 条比较，标题相似度 > 0.72 视为同一事件的不同来源
    let dup = null;
    for (const k of kept.slice(0, 40)) {
      if (similarity(it.title, k.title) > 0.72) {
        dup = k;
        break;
      }
    }
    if (dup) {
      fuzzy++;
      dup.alsoReportedBy = dup.alsoReportedBy || [];
      if (!dup.alsoReportedBy.some((x) => x.source === it.source)) {
        dup.alsoReportedBy.push({ source: it.source, url: it.url, published_at: it.published_at });
      }
      continue;
    }
    seenHash.add(h);
    it.dedup_hash = h;
    kept.push(it);
  }
  return { items: kept, exactDuplicates: exact, fuzzyDuplicates: fuzzy };
}

const MARKET_KEYWORDS = {
  CN: ['A股', '上证', '深证', '创业板', '科创板', '沪深', '央行', '证监会', '人民币', '国常会', '发改委'],
  HK: ['港股', '恒生', '恒指', '港交所', '南向', '港元', '中国香港'],
  US: ['美股', '纳斯达克', '道琼斯', '标普', '美联储', '非农', 'CPI', '鲍威尔', '美元', '国债收益率']
};

/** 与持仓的相关性标注：命中标的名称/代码 或 市场关键词 */
function annotateRelevance(items, holdings) {
  const hs = (holdings || []).map((h) => ({
    market: h.market,
    code: String(h.code).toUpperCase(),
    name: h.name || '',
    sector: h.sector || ''
  }));

  for (const it of items) {
    const text = `${it.title} ${it.summary || ''}`;
    const upper = text.toUpperCase();
    const hitHoldings = [];

    for (const h of hs) {
      let hit = false;
      if (h.name && h.name.length >= 2 && text.includes(h.name)) hit = true;
      // 代码匹配：A股/港股数字代码用词边界，美股字母代码需独立单词
      if (!hit && h.code) {
        if (/^\d+$/.test(h.code)) {
          if (text.includes(h.code)) hit = true;
        } else if (new RegExp(`\\b${h.code}\\b`).test(upper)) {
          hit = true;
        }
      }
      if (!hit && h.sector && h.sector.length >= 2 && text.includes(h.sector)) hit = true;
      if (hit) hitHoldings.push({ market: h.market, code: h.code, name: h.name });
    }

    const hitMarkets = [];
    for (const [mk, kws] of Object.entries(MARKET_KEYWORDS)) {
      if (kws.some((k) => (k === k.toUpperCase() ? upper.includes(k) : text.includes(k)))) hitMarkets.push(mk);
    }

    it.relevance = {
      holdings: hitHoldings,
      markets: hitMarkets,
      level: hitHoldings.length ? 'DIRECT' : hitMarkets.length ? 'MARKET' : 'GENERAL',
      levelText: hitHoldings.length ? '直接相关(命中持仓)' : hitMarkets.length ? '市场相关' : '一般财经'
    };
  }
  return items;
}

/**
 * 聚合抓取
 * @param enabled 源 id 数组
 * @param holdings 持仓（用于相关性标注）
 */
async function fetchAll(enabled, holdings, onHealth) {
  const ids = (enabled && enabled.length ? enabled : ['wallstreetcn', 'jin10', 'sina7x24', 'em_announce']).filter(
    (i) => SOURCES[i]
  );
  const attempts = [];
  const raw = [];
  const fetchedAt = sessions.beijingNowStr();

  const results = await Promise.allSettled(
    ids.map(async (id) => {
      const src = SOURCES[id];
      const started = Date.now();
      try {
        const r = await src.fetch(30);
        attempts.push({ source: id, label: src.label, ok: true, count: r.items.length, latency: r.latency });
        if (onHealth) onHealth(`news:${id}`, true, r.latency, null);
        return r.items;
      } catch (e) {
        const latency = Date.now() - started;
        attempts.push({ source: id, label: src.label, ok: false, latency, reason: e.message || String(e) });
        if (onHealth) onHealth(`news:${id}`, false, latency, e.message);
        return [];
      }
    })
  );

  for (const r of results) if (r.status === 'fulfilled') raw.push(...r.value);

  for (const it of raw) {
    it.fetched_at = fetchedAt;
    it.id = `${it.sourceId}:${it.externalId}`;
  }

  const { items, exactDuplicates, fuzzyDuplicates } = dedupe(raw);
  annotateRelevance(items, holdings);

  return {
    items,
    attempts,
    stats: {
      rawCount: raw.length,
      keptCount: items.length,
      exactDuplicates,
      fuzzyDuplicates,
      directRelated: items.filter((i) => i.relevance.level === 'DIRECT').length,
      fetchedAt
    }
  };
}

module.exports = { fetchAll, SOURCES, dedupe, annotateRelevance, similarity, stripHtml };
