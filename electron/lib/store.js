'use strict';
/**
 * 本地数据库层（真实 SQLite 文件，基于 sql.js / WASM，无原生编译依赖）
 * 数据文件：<userData>/finance-workbench.sqlite
 * 变更后 400ms 防抖落盘 + 退出前强制落盘，保证重启可恢复。
 */
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

let SQL = null;
let db = null;
let dbPath = null;
let flushTimer = null;
let dirty = false;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS holdings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market TEXT NOT NULL,
  code TEXT NOT NULL,
  name TEXT,
  sector TEXT,
  currency TEXT NOT NULL,
  quantity REAL,
  cost_price REAL,
  invest_cost REAL,
  qty_estimated INTEGER DEFAULT 0,
  cost_estimated INTEGER DEFAULT 0,
  asset_type TEXT DEFAULT 'STOCK',
  note TEXT,
  created_at TEXT,
  updated_at TEXT,
  UNIQUE(market, code)
);

CREATE TABLE IF NOT EXISTS cash_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  currency TEXT NOT NULL UNIQUE,
  amount REAL NOT NULL DEFAULT 0,
  note TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS fx_rates (
  pair TEXT PRIMARY KEY,
  rate REAL NOT NULL,
  source TEXT,
  source_type TEXT DEFAULT 'AUTO',
  quote_date TEXT,
  fetched_at TEXT,
  update_freq TEXT
);

CREATE TABLE IF NOT EXISTS price_closes (
  market TEXT NOT NULL,
  code TEXT NOT NULL,
  trade_date TEXT NOT NULL,
  close REAL NOT NULL,
  source TEXT,
  saved_at TEXT,
  PRIMARY KEY (market, code, trade_date)
);

CREATE TABLE IF NOT EXISTS daily_snapshots (
  snap_date TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS reviews (
  review_date TEXT NOT NULL,
  market TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT,
  PRIMARY KEY (review_date, market)
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT,
  event_time_bj TEXT,
  origin_tz TEXT,
  origin_time TEXT,
  source TEXT,
  source_url TEXT,
  confirmed INTEGER DEFAULT 0,
  archived INTEGER DEFAULT 0,
  importance TEXT,
  detail TEXT,
  fetched_at TEXT
);

CREATE TABLE IF NOT EXISTS news_items (
  id TEXT PRIMARY KEY,
  source TEXT,
  title TEXT,
  summary TEXT,
  content TEXT,
  url TEXT,
  published_at TEXT,
  fetched_at TEXT,
  dedup_hash TEXT,
  relevance TEXT
);
CREATE INDEX IF NOT EXISTS idx_news_pub ON news_items(published_at DESC);

CREATE TABLE IF NOT EXISTS source_health (
  source TEXT PRIMARY KEY,
  last_ok TEXT,
  last_error TEXT,
  last_latency INTEGER,
  ok_count INTEGER DEFAULT 0,
  err_count INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS etf_list (
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  market TEXT NOT NULL,
  currency TEXT NOT NULL,
  benchmark TEXT,
  category TEXT DEFAULT 'INDEX',
  enabled INTEGER DEFAULT 1,
  added_at TEXT,
  updated_at TEXT,
  PRIMARY KEY (market, code)
);

CREATE TABLE IF NOT EXISTS etf_momentum (
  code TEXT NOT NULL,
  date TEXT NOT NULL,
  price REAL,
  roc_5d REAL,
  roc_20d REAL,
  roc_60d REAL,
  price_percentile REAL,
  trend_score REAL,
  position_score REAL,
  relative_score REAL,
  momentum_score REAL,
  signal TEXT,
  benchmark_return REAL,
  relative_return REAL,
  updated_at TEXT,
  PRIMARY KEY (code, date)
);

CREATE TABLE IF NOT EXISTS etf_backtest (
  id TEXT PRIMARY KEY,
  etf_code TEXT NOT NULL,
  params TEXT NOT NULL,
  start_date TEXT,
  end_date TEXT,
  total_return REAL,
  annual_return REAL,
  sharpe REAL,
  max_drawdown REAL,
  win_rate REAL,
  trades INTEGER,
  created_at TEXT
);
`;

async function open(userDataDir) {
  const wasmPath = resolveWasm();
  SQL = await initSqlJs({ wasmBinary: fs.readFileSync(wasmPath) });
  if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });
  dbPath = path.join(userDataDir, 'finance-workbench.sqlite');
  if (fs.existsSync(dbPath)) {
    db = new SQL.Database(fs.readFileSync(dbPath));
  } else {
    db = new SQL.Database();
  }
  db.run('PRAGMA foreign_keys=ON;');
  db.exec(SCHEMA);
  seedDefaults();
  if (!flushNow()) {
    throw new Error('无法写入数据文件: ' + dbPath);
  }
  return dbPath;
}

function resolveWasm() {
  const candidates = [
    path.join(process.resourcesPath || '', 'sql-wasm.wasm'),
    path.join(__dirname, '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
    path.join(process.cwd(), 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm')
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  throw new Error('未找到 sql-wasm.wasm，无法初始化数据库。请确认依赖安装完整。');
}

function markDirty() {
  dirty = true;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(flushNow, 400);
}

function flushNow() {
  if (!db || !dbPath) return false;
  try {
    const data = db.export();
    fs.writeFileSync(dbPath, Buffer.from(data));
    dirty = false;
    return true;
  } catch (e) {
    console.error('[store] 落盘失败:', e.message);
    return false;
  }
}

function close() {
  if (dirty) flushNow();
  if (db) {
    db.close();
    db = null;
  }
}

/* ---------- 基础查询封装 ---------- */
function all(sql, params = []) {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    return rows;
  } finally {
    stmt.free();
  }
}

function get(sql, params = []) {
  const rows = all(sql, params);
  return rows.length ? rows[0] : null;
}

function run(sql, params = []) {
  db.run(sql, params);
  markDirty();
}

const nowISO = () => new Date().toISOString();

/* ---------- 设置项 ---------- */
function setSetting(key, value) {
  run(
    `INSERT INTO settings(key,value,updated_at) VALUES(?,?,?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    [key, JSON.stringify(value), nowISO()]
  );
}
function getSetting(key, fallback = null) {
  const row = get('SELECT value FROM settings WHERE key=?', [key]);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return fallback;
  }
}
function allSettings() {
  const out = {};
  for (const r of all('SELECT key,value FROM settings')) {
    try {
      out[r.key] = JSON.parse(r.value);
    } catch {
      out[r.key] = r.value;
    }
  }
  return out;
}

const DEFAULT_SETTINGS = {
  baseCurrency: 'USD',
  refreshSeconds: 30,
  quoteSourcePriority: ['tencent', 'sina', 'eastmoney'],
  indices: ['HK:HSTECH', 'CN:000001'],
  premiumEnabled: { tushare: false, finnhub: false, twelvedata: false, futu: false },
  futuOpenD: { host: '127.0.0.1', port: 11111 },
  newsSources: ['wallstreetcn', 'jin10', 'sina7x24', 'em_announce'],
  colorScheme: 'CN_RED_UP',
  autoReviewAfterClose: true,
  tradingEnabled: false,
  firstRunDone: false
};

const DEFAULT_ETFS = [
  { market: 'US', code: 'SPY', name: '标普500ETF', currency: 'USD', benchmark: 'US:INX', category: 'INDEX' },
  { market: 'US', code: 'QQQ', name: '纳指100ETF', currency: 'USD', benchmark: 'US:IXIC', category: 'INDEX' },
  { market: 'HK', code: '3088', name: '恒生科技ETF', currency: 'HKD', benchmark: 'HK:HSTECH', category: 'INDEX' },
  { market: 'CN', code: '513050', name: '中概互联ETF', currency: 'CNY', benchmark: 'CN:000001', category: 'SECTOR' },
  { market: 'US', code: 'GLD', name: '黄金ETF', currency: 'USD', benchmark: null, category: 'COMMODITY' },
  { market: 'US', code: 'SLV', name: '白银ETF', currency: 'USD', benchmark: null, category: 'COMMODITY' },
  { market: 'CN', code: '510300', name: '沪深300ETF', currency: 'CNY', benchmark: 'CN:000300', category: 'INDEX' },
  { market: 'CN', code: '588000', name: '科创50ETF', currency: 'CNY', benchmark: 'CN:000300', category: 'SECTOR' },
  { market: 'CN', code: '159915', name: '创业板ETF', currency: 'CNY', benchmark: 'CN:399006', category: 'SECTOR' },
  { market: 'US', code: 'TLT', name: '美国长期国债ETF', currency: 'USD', benchmark: null, category: 'BOND' }
];

function seedDefaults() {
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    const exist = get('SELECT key FROM settings WHERE key=?', [k]);
    if (!exist) setSetting(k, v);
  }
  // 现金账户：用户申报 10 万美元
  if (!get('SELECT id FROM cash_accounts WHERE currency=?', ['USD'])) {
    run('INSERT INTO cash_accounts(currency,amount,note,updated_at) VALUES(?,?,?,?)', [
      'USD',
      100000,
      '初始录入',
      nowISO()
    ]);
  }
  if (!get('SELECT id FROM cash_accounts WHERE currency=?', ['CNY'])) {
    run('INSERT INTO cash_accounts(currency,amount,note,updated_at) VALUES(?,?,?,?)', ['CNY', 0, '', nowISO()]);
  }
  if (!get('SELECT id FROM cash_accounts WHERE currency=?', ['HKD'])) {
    run('INSERT INTO cash_accounts(currency,amount,note,updated_at) VALUES(?,?,?,?)', ['HKD', 0, '', nowISO()]);
  }
}

/* ---------- 持仓 ---------- */
function listHoldings() {
  return all('SELECT * FROM holdings ORDER BY market, code');
}

function upsertHolding(h) {
  const ts = nowISO();
  if (h.id) {
    run(
      `UPDATE holdings SET market=?,code=?,name=?,sector=?,currency=?,quantity=?,cost_price=?,invest_cost=?,
        qty_estimated=?,cost_estimated=?,asset_type=?,note=?,updated_at=? WHERE id=?`,
      [
        h.market,
        h.code,
        h.name || null,
        h.sector || null,
        h.currency,
        h.quantity == null ? null : Number(h.quantity),
        h.cost_price == null ? null : Number(h.cost_price),
        h.invest_cost == null ? null : Number(h.invest_cost),
        h.qty_estimated ? 1 : 0,
        h.cost_estimated ? 1 : 0,
        h.asset_type || 'STOCK',
        h.note || null,
        ts,
        h.id
      ]
    );
    return h.id;
  }
  run(
    `INSERT INTO holdings(market,code,name,sector,currency,quantity,cost_price,invest_cost,
      qty_estimated,cost_estimated,asset_type,note,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(market,code) DO UPDATE SET
       name=excluded.name, sector=excluded.sector, currency=excluded.currency,
       quantity=excluded.quantity, cost_price=excluded.cost_price, invest_cost=excluded.invest_cost,
       qty_estimated=excluded.qty_estimated, cost_estimated=excluded.cost_estimated,
       asset_type=excluded.asset_type, note=excluded.note, updated_at=excluded.updated_at`,
    [
      h.market,
      h.code,
      h.name || null,
      h.sector || null,
      h.currency,
      h.quantity == null ? null : Number(h.quantity),
      h.cost_price == null ? null : Number(h.cost_price),
      h.invest_cost == null ? null : Number(h.invest_cost),
      h.qty_estimated ? 1 : 0,
      h.cost_estimated ? 1 : 0,
      h.asset_type || 'STOCK',
      h.note || null,
      ts,
      ts
    ]
  );
  const row = get('SELECT id FROM holdings WHERE market=? AND code=?', [h.market, h.code]);
  return row ? row.id : null;
}

function deleteHolding(id) {
  run('DELETE FROM holdings WHERE id=?', [id]);
}

/* ---------- 现金 ---------- */
function listCash() {
  return all('SELECT * FROM cash_accounts ORDER BY currency');
}
function setCash(currency, amount, note) {
  run(
    `INSERT INTO cash_accounts(currency,amount,note,updated_at) VALUES(?,?,?,?)
     ON CONFLICT(currency) DO UPDATE SET amount=excluded.amount, note=excluded.note, updated_at=excluded.updated_at`,
    [currency, Number(amount) || 0, note || null, nowISO()]
  );
}

/* ---------- 汇率 ---------- */
function saveFxRate(rec) {
  run(
    `INSERT INTO fx_rates(pair,rate,source,source_type,quote_date,fetched_at,update_freq)
     VALUES(?,?,?,?,?,?,?)
     ON CONFLICT(pair) DO UPDATE SET rate=excluded.rate, source=excluded.source,
       source_type=excluded.source_type, quote_date=excluded.quote_date,
       fetched_at=excluded.fetched_at, update_freq=excluded.update_freq`,
    [rec.pair, rec.rate, rec.source, rec.source_type || 'AUTO', rec.quote_date || null, nowISO(), rec.update_freq || null]
  );
}
function listFxRates() {
  return all('SELECT * FROM fx_rates');
}

/* ---------- 收盘价留存（用于当日盈亏基准 & 复盘） ---------- */
function saveClose(market, code, tradeDate, close, source) {
  if (!tradeDate || close == null || !isFinite(close)) return;
  run(
    `INSERT INTO price_closes(market,code,trade_date,close,source,saved_at) VALUES(?,?,?,?,?,?)
     ON CONFLICT(market,code,trade_date) DO UPDATE SET close=excluded.close, source=excluded.source`,
    [market, code, tradeDate, Number(close), source || null, nowISO()]
  );
}
function recentCloses(market, code, limit = 10) {
  return all('SELECT * FROM price_closes WHERE market=? AND code=? ORDER BY trade_date DESC LIMIT ?', [
    market,
    code,
    limit
  ]);
}

/* ---------- 快照 / 复盘 ---------- */
function saveSnapshot(dateStr, payload) {
  run(
    `INSERT INTO daily_snapshots(snap_date,payload,created_at) VALUES(?,?,?)
     ON CONFLICT(snap_date) DO UPDATE SET payload=excluded.payload, created_at=excluded.created_at`,
    [dateStr, JSON.stringify(payload), nowISO()]
  );
}
function getSnapshot(dateStr) {
  const r = get('SELECT payload FROM daily_snapshots WHERE snap_date=?', [dateStr]);
  return r ? JSON.parse(r.payload) : null;
}
function listSnapshotDates(limit = 30) {
  return all('SELECT snap_date FROM daily_snapshots ORDER BY snap_date DESC LIMIT ?', [limit]).map((r) => r.snap_date);
}

function saveReview(dateStr, market, payload) {
  run(
    `INSERT INTO reviews(review_date,market,payload,created_at) VALUES(?,?,?,?)
     ON CONFLICT(review_date,market) DO UPDATE SET payload=excluded.payload, created_at=excluded.created_at`,
    [dateStr, market, JSON.stringify(payload), nowISO()]
  );
}
function getReviews(dateStr) {
  return all('SELECT * FROM reviews WHERE review_date=?', [dateStr]).map((r) => ({
    market: r.market,
    created_at: r.created_at,
    ...JSON.parse(r.payload)
  }));
}
function listReviewDates(limit = 60) {
  return all('SELECT DISTINCT review_date FROM reviews ORDER BY review_date DESC LIMIT ?', [limit]).map(
    (r) => r.review_date
  );
}

/* ---------- 事件日历 ---------- */
function upsertEvent(e) {
  run(
    `INSERT INTO events(id,title,category,event_time_bj,origin_tz,origin_time,source,source_url,confirmed,archived,importance,detail,fetched_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET title=excluded.title, category=excluded.category,
       event_time_bj=excluded.event_time_bj, origin_tz=excluded.origin_tz, origin_time=excluded.origin_time,
       source=excluded.source, source_url=excluded.source_url, confirmed=excluded.confirmed,
       importance=excluded.importance, detail=excluded.detail, fetched_at=excluded.fetched_at`,
    [
      e.id,
      e.title,
      e.category || null,
      e.event_time_bj || null,
      e.origin_tz || null,
      e.origin_time || null,
      e.source || null,
      e.source_url || null,
      e.confirmed ? 1 : 0,
      e.archived ? 1 : 0,
      e.importance || null,
      e.detail || null,
      nowISO()
    ]
  );
}
function listEvents({ includeArchived = false } = {}) {
  const sql = includeArchived
    ? 'SELECT * FROM events ORDER BY event_time_bj'
    : 'SELECT * FROM events WHERE archived=0 ORDER BY event_time_bj';
  return all(sql);
}
function archivePastEvents(nowBjStr) {
  run('UPDATE events SET archived=1 WHERE event_time_bj IS NOT NULL AND event_time_bj < ? AND archived=0', [nowBjStr]);
}
function setEventConfirmed(id, confirmed) {
  run('UPDATE events SET confirmed=? WHERE id=?', [confirmed ? 1 : 0, id]);
}
function deleteEvent(id) {
  run('DELETE FROM events WHERE id=?', [id]);
}

/* ---------- 新闻 ---------- */
function upsertNews(items) {
  for (const n of items) {
    run(
      `INSERT INTO news_items(id,source,title,summary,content,url,published_at,fetched_at,dedup_hash,relevance)
       VALUES(?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET fetched_at=excluded.fetched_at, relevance=excluded.relevance`,
      [
        n.id,
        n.source,
        n.title,
        n.summary || null,
        n.content || null,
        n.url || null,
        n.published_at || null,
        n.fetched_at || nowISO(),
        n.dedup_hash || null,
        n.relevance ? JSON.stringify(n.relevance) : null
      ]
    );
  }
}
function listNews(limit = 120) {
  return all('SELECT * FROM news_items ORDER BY published_at DESC LIMIT ?', [limit]).map((r) => ({
    ...r,
    relevance: r.relevance ? JSON.parse(r.relevance) : null
  }));
}
function pruneNews(keep = 600) {
  run(
    `DELETE FROM news_items WHERE id NOT IN (SELECT id FROM news_items ORDER BY published_at DESC LIMIT ?)`,
    [keep]
  );
}

/* ---------- 数据源健康度 ---------- */
function recordSourceHealth(source, ok, latency, errMsg) {
  const exist = get('SELECT source FROM source_health WHERE source=?', [source]);
  if (!exist) {
    run('INSERT INTO source_health(source,ok_count,err_count) VALUES(?,0,0)', [source]);
  }
  if (ok) {
    run('UPDATE source_health SET last_ok=?, last_latency=?, ok_count=ok_count+1 WHERE source=?', [
      nowISO(),
      latency || null,
      source
    ]);
  } else {
    run('UPDATE source_health SET last_error=?, err_count=err_count+1 WHERE source=?', [
      `${nowISO()} ${errMsg || ''}`.slice(0, 300),
      source
    ]);
  }
}
function listSourceHealth() {
  return all('SELECT * FROM source_health');
}

/* ---------- ETF 动量相关 ---------- */
function upsertEtf(etf) {
  const ts = nowISO();
  run(
    `INSERT INTO etf_list(market,code,name,currency,benchmark,category,added_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?)
     ON CONFLICT(market,code) DO UPDATE SET
       name=excluded.name, currency=excluded.currency, benchmark=excluded.benchmark,
       category=excluded.category, updated_at=excluded.updated_at`,
    [etf.market, etf.code, etf.name, etf.currency, etf.benchmark || null, etf.category || 'INDEX', ts, ts]
  );
}
function seedEtfDefaults() {
  for (const etf of DEFAULT_ETFS) {
    const exist = get('SELECT market FROM etf_list WHERE market=? AND code=?', [etf.market, etf.code]);
    if (!exist) upsertEtf({ ...etf, added_at: nowISO(), updated_at: nowISO() });
  }
}
function listEtf() {
  return all('SELECT * FROM etf_list ORDER BY market, code');
}
function deleteEtf(market, code) {
  run('DELETE FROM etf_list WHERE market=? AND code=?', [market, code]);
}
function setEtfEnabled(market, code, enabled) {
  run('UPDATE etf_list SET enabled=?, updated_at=? WHERE market=? AND code=?', [enabled ? 1 : 0, nowISO(), market, code]);
}

function saveEtfMomentum(row) {
  run(
    `INSERT INTO etf_momentum(code,date,price,roc_5d,roc_20d,roc_60d,price_percentile,
     trend_score,position_score,relative_score,momentum_score,signal,benchmark_return,relative_return,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(code,date) DO UPDATE SET
       price=excluded.price, roc_5d=excluded.roc_5d, roc_20d=excluded.roc_20d, roc_60d=excluded.roc_60d,
       price_percentile=excluded.price_percentile, trend_score=excluded.trend_score,
       position_score=excluded.position_score, relative_score=excluded.relative_score,
       momentum_score=excluded.momentum_score, signal=excluded.signal,
       benchmark_return=excluded.benchmark_return, relative_return=excluded.relative_return,
       updated_at=excluded.updated_at`,
    [row.code, row.date, row.price, row.roc_5d, row.roc_20d, row.roc_60d, row.price_percentile,
     row.trend_score, row.position_score, row.relative_score, row.momentum_score, row.signal,
     row.benchmark_return, row.relative_return, nowISO()]
  );
}
function listEtfMomentum(code, limit = 120) {
  return all('SELECT * FROM etf_momentum WHERE code=? ORDER BY date DESC LIMIT ?', [code, limit]).reverse();
}
function latestEtfMomentum(market, code) {
  return get('SELECT * FROM etf_momentum WHERE code=? ORDER BY date DESC LIMIT 1', [code]);
}
function listEtfSignals(dateStr) {
  const d = dateStr || sessions.beijingNowStr().slice(0, 10);
  return all(
    `SELECT e.*, m.momentum_score, m.signal, m.roc_20d, m.price_percentile, m.relative_return
     FROM etf_list e
     LEFT JOIN etf_momentum m ON e.code = m.code AND m.date = ?
     WHERE e.enabled = 1
     ORDER BY m.momentum_score DESC NULLS LAST`,
    [d]
  );
}
function listEtfSignalHistory(code, days = 60) {
  return all('SELECT * FROM etf_momentum WHERE code=? ORDER BY date DESC LIMIT ?', [code, days]).reverse();
}

function saveBacktest(bt) {
  run(
    `INSERT INTO etf_backtest(id,etf_code,params,start_date,end_date,total_return,annual_return,sharpe,max_drawdown,win_rate,trades,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [bt.id, bt.etfCode, bt.params, bt.startDate, bt.endDate, bt.totalReturn, bt.annualReturn,
     bt.sharpe, bt.maxDrawdown, bt.winRate, bt.trades, nowISO()]
  );
}
function listBacktests(code, limit = 10) {
  return all('SELECT * FROM etf_backtest WHERE etf_code=? ORDER BY created_at DESC LIMIT ?', [code, limit]);
}

function dbInfo() {
  const size = dbPath && fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;
  return {
    path: dbPath,
    sizeBytes: size,
    tables: all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").map((r) => r.name)
  };
}

module.exports = {
  open,
  close,
  flushNow,
  all,
  get,
  run,
  setSetting,
  getSetting,
  allSettings,
  DEFAULT_SETTINGS,
  listHoldings,
  upsertHolding,
  deleteHolding,
  listCash,
  setCash,
  saveFxRate,
  listFxRates,
  saveClose,
  recentCloses,
  saveSnapshot,
  getSnapshot,
  listSnapshotDates,
  saveReview,
  getReviews,
  listReviewDates,
  upsertEvent,
  listEvents,
  archivePastEvents,
  setEventConfirmed,
  deleteEvent,
  upsertNews,
  listNews,
  pruneNews,
  recordSourceHealth,
  listSourceHealth,
  dbInfo,
  DEFAULT_ETFS,
  seedEtfDefaults,
  listEtf,
  upsertEtf,
  deleteEtf,
  setEtfEnabled,
  saveEtfMomentum,
  listEtfMomentum,
  latestEtfMomentum,
  listEtfSignals,
  listEtfSignalHistory,
  saveBacktest,
  listBacktests
};
