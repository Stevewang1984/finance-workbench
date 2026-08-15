'use strict';
/**
 * 个人理财工作台 - Electron 主进程
 * 职责：窗口管理、IPC 桥接所有 lib 模块、自动刷新、收盘后自动复盘触发、API Key 安全初始化。
 */
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const store = require('./lib/store');
const secure = require('./lib/secure');
const market = require('./lib/market');
const fx = require('./lib/fx');
const portfolio = require('./lib/portfolio');
const newsLib = require('./lib/news');
const calendarLib = require('./lib/calendar');
const reviewLib = require('./lib/review');
const sessions = require('./lib/sessions');

let mainWindow = null;
let settings = {};
const KEY_NAMES = ['tushare', 'finnhub', 'twelvedata', 'futu'];

/* ---------------- 工具 ---------------- */
function todayBj() {
  return sessions.beijingNowStr().slice(0, 10);
}
function loadSettings() {
  settings = store.allSettings();
  if (!settings.indices || !settings.indices.length) settings.indices = ['HK:HSTECH', 'CN:000001'];
  if (!settings.baseCurrency) settings.baseCurrency = 'USD';
  if (!settings.quoteSourcePriority || !settings.quoteSourcePriority.length)
    settings.quoteSourcePriority = ['tencent', 'sina', 'eastmoney'];
}
function getKeys() {
  return {
    tushare: secure.getKey('tushare'),
    finnhub: secure.getKey('finnhub'),
    twelvedata: secure.getKey('twelvedata')
  };
}
function onHealth(s, ok, lat, err) {
  try {
    store.recordSourceHealth(s, ok, lat, err);
  } catch {}
}

/* ---------------- 首次运行种子数据 ---------------- */
function firstRunSeed() {
  if (store.getSetting('firstRunDone')) return;
  // 用户持仓：美股 ETF ABCD 2000 股，50 万美元成本
  const exists = store.listHoldings().some((h) => h.market === 'US' && String(h.code).toUpperCase() === 'ABCD');
  if (!exists) {
    store.upsertHolding({
      market: 'US',
      code: 'ABCD',
      name: 'ABCD ETF',
      sector: '跨境宽基ETF',
      currency: 'USD',
      quantity: 2000,
      cost_price: 250,
      invest_cost: 500000,
      asset_type: 'ETF'
    });
  }
  store.setSetting('firstRunDone', true);
}

/* ---------------- 行情 / 汇率 ---------------- */
async function ensureFx(force) {
  const rows = store.listFxRates();
  const now = Date.now();
  const stale =
    force ||
    rows.length === 0 ||
    rows.some((r) => !r.fetched_at || now - new Date(r.fetched_at.replace(' ', 'T') + 'Z').getTime() > 6 * 3600 * 1000);
  if (stale) {
    try {
      const r = await fx.fetchRates(['CNY', 'HKD'], onHealth);
      for (const p of Object.values(r.pairs)) store.saveFxRate(p);
    } catch (e) {
      /* 保留旧汇率或缺失，由上层提示 */
    }
  }
  return store.listFxRates();
}

async function buildSymbols() {
  const holdings = store.listHoldings();
  const wl = settings.indices || ['HK:HSTECH', 'CN:000001'];
  const syms = holdings.map((h) => ({
    market: h.market,
    code: h.code,
    name: h.name,
    currency: h.currency,
    assetType: h.asset_type
  }));
  for (const k of wl) {
    const [m, c] = k.split(':');
    if (m && c) syms.push({ market: m, code: c, isIndex: true });
  }
  return { syms, wl, holdings };
}

async function doQuotes() {
  const { syms, wl, holdings } = await buildSymbols();
  const keys = getKeys();
  const r = await market.fetchQuotes(syms, {
    priority: settings.quoteSourcePriority,
    keys,
    onHealth
  });
  // 留存收盘价（用于当日盈亏基准 & 复盘）
  for (const q of Object.values(r.quotes)) {
    if (q.ok && q.prevClose != null && q.tradeDate) {
      store.saveClose(q.market, q.code, q.tradeDate, q.price, q.source);
    }
  }
  const indexQuotes = {};
  for (const k of wl) {
    if (r.quotes[k]) indexQuotes[k] = r.quotes[k];
  }
  const fxRows = await ensureFx(false);
  const snapshot = await portfolio.buildSnapshot({
    holdings,
    cash: store.listCash(),
    quotes: r.quotes,
    fxRows,
    baseCurrency: settings.baseCurrency
  });
  return { snapshot, quotes: r.quotes, attempts: r.attempts, indexQuotes, fxRows };
}

/* ---------------- 复盘 ---------------- */
async function runReview(dateStr) {
  const data = await doQuotes();
  const rev = reviewLib.generate({
    snapshot: data.snapshot,
    indexQuotes: data.indexQuotes,
    news: store.listNews(300),
    events: store.listEvents(),
    fxRows: data.fxRows,
    baseCurrency: settings.baseCurrency
  });
  store.saveReview(dateStr, 'ALL', rev);
  return rev;
}

/* ---------------- 收盘自动复盘 ---------------- */
let marketClosedToday = { CN: false, HK: false, US: false };
let lastReviewDate = null;
let lastDate = todayBj();

function checkAutoReview() {
  const now = todayBj();
  if (now !== lastDate) {
    lastDate = now;
    marketClosedToday = { CN: false, HK: false, US: false };
    lastReviewDate = null;
  }
  if (!settings.autoReviewAfterClose) return;
  const phases = sessions.allPhases();
  let allClosed = true;
  for (const mk of ['CN', 'HK', 'US']) {
    const phase = phases[mk].phase;
    if (phase === 'CLOSED' || phase === 'WEEKEND') marketClosedToday[mk] = true;
    if (!marketClosedToday[mk]) allClosed = false;
  }
  if (allClosed && lastReviewDate !== now) {
    lastReviewDate = now;
    runReview(now)
      .then((rev) => {
        if (mainWindow) mainWindow.webContents.send('fw:event', { type: 'review-ready', review: rev, date: now });
      })
      .catch(() => {});
  }
}

/* ---------------- 窗口 ---------------- */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1100,
    minHeight: 680,
    backgroundColor: '#0f1419',
    title: '个人理财工作台',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/* ---------------- IPC ---------------- */
function registerIpc() {
  ipcMain.on('fw:open-external', (event, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      try {
        shell.openExternal(url);
      } catch {}
    }
  });

  ipcMain.handle('fw', async (event, { op, payload }) => {
    try {
      switch (op) {
        case 'app:info': {
          return {
            db: store.dbInfo(),
            storage: secure.storageMode(),
            settings,
            version: app.getVersion()
          };
        }

        case 'market:phases':
          return sessions.allPhases();

        case 'settings:get':
          return settings;
        case 'settings:save': {
          const patch = payload || {};
          for (const [k, v] of Object.entries(patch)) store.setSetting(k, v);
          loadSettings();
          return settings;
        }

        /* 持仓 */
        case 'holdings:list':
          return store.listHoldings();
        case 'holdings:upsert': {
          const id = store.upsertHolding(payload);
          return { id };
        }
        case 'holdings:delete':
          store.deleteHolding(payload.id);
          return { ok: true };

        /* 现金 */
        case 'cash:list':
          return store.listCash();
        case 'cash:set':
          store.setCash(payload.currency, payload.amount, payload.note);
          return { ok: true };

        /* 汇率 */
        case 'fx:list':
          return store.listFxRates();
        case 'fx:refresh': {
          const rows = await ensureFx(true);
          return rows;
        }
        case 'fx:setManual': {
          const m = payload || {};
          if (!m.pair || m.rate == null) throw new Error('缺少货币对或汇率');
          store.saveFxRate({
            pair: m.pair,
            rate: Number(m.rate),
            source: '手动录入[讯]',
            source_type: 'MANUAL',
            quote_date: todayBj(),
            update_freq: '手动录入',
            fetched_at: sessions.beijingNowStr()
          });
          return { ok: true };
        }

        /* 行情 / 快照 */
        case 'snapshot': {
          return await doQuotes();
        }
        case 'quotes:refresh': {
          const r = await doQuotes();
          return { quotes: r.quotes, attempts: r.attempts, indexQuotes: r.indexQuotes };
        }

        /* 新闻 */
        case 'news:refresh': {
          const r = await newsLib.fetchAll(settings.newsSources, store.listHoldings(), onHealth);
          store.upsertNews(r.items.map((it) => ({ ...it, relevance: it.relevance })));
          store.pruneNews(600);
          return { items: store.listNews(150), stats: r.stats, attempts: r.attempts };
        }
        case 'news:list':
          return store.listNews(150);

        /* 事件日历 */
        case 'calendar:refresh': {
          const r = await calendarLib.fetchAll(store.listHoldings(), onHealth);
          for (const e of r.events) store.upsertEvent(e);
          store.archivePastEvents(sessions.beijingNowStr());
          return { events: store.listEvents(), attempts: r.attempts };
        }
        case 'calendar:list':
          return store.listEvents();
        case 'calendar:confirm':
          store.setEventConfirmed(payload.id, payload.confirmed);
          return { ok: true };
        case 'calendar:delete':
          store.deleteEvent(payload.id);
          return { ok: true };
        case 'calendar:add': {
          const e = payload || {};
          if (!e.title || !e.event_time_bj) throw new Error('缺少标题或北京时间');
          store.upsertEvent({
            id: 'manual:' + Date.now(),
            title: e.title,
            category: e.category || 'CUSTOM',
            event_time_bj: e.event_time_bj,
            origin_tz: e.origin_tz || '手动录入',
            origin_time: e.origin_time || e.event_time_bj,
            source: '手动录入',
            source_url: e.source_url || null,
            confirmed: e.confirmed ? 1 : 0,
            importance: e.importance || 'LOW',
            detail: e.detail || ''
          });
          return { ok: true };
        }

        /* 复盘 */
        case 'review:run': {
          return await runReview(todayBj());
        }
        case 'review:get': {
          const d = payload && payload.date ? payload.date : todayBj();
          return store.getReviews(d);
        }
        case 'review:history': {
          return store.listReviewDates(60);
        }

        /* 数据源健康 */
        case 'health:list':
          return store.listSourceHealth();

        /* API Key */
        case 'keys:status':
          return secure.listKeyStatus(KEY_NAMES);
        case 'keys:set': {
          secure.setKey(payload.name, payload.value);
          loadSettings();
          return secure.listKeyStatus(KEY_NAMES);
        }
        case 'futu:check': {
          const cfg = settings.futuOpenD || { host: '127.0.0.1', port: 11111 };
          return await market.checkFutuOpenD(cfg);
        }

        /* 导出 / 备份 */
        case 'db:path':
          return store.dbInfo();

        default:
          throw new Error(`未知操作: ${op}`);
      }
    } catch (e) {
      return { __error: true, message: e.message || String(e) };
    }
  });
}

/* ---------------- 生命周期 ---------------- */
app.whenReady().then(async () => {
  const userData = app.getPath('userData');
  try {
    store.open(userData);
    secure.init(userData, process.type === 'renderer' ? null : (app.isReady() && require('electron').safeStorage));
  } catch (e) {
    dialog.showErrorBox('初始化失败', '数据库或安全存储初始化失败：' + (e.message || e));
  }
  loadSettings();
  firstRunSeed();
  registerIpc();
  createWindow();
  setInterval(checkAutoReview, 60 * 1000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  try {
    store.flushNow();
    store.close();
  } catch {}
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  try {
    store.flushNow();
    store.close();
  } catch {}
});
