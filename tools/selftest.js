'use strict';
/**
 * 核心链路自检（纯 Node 运行，不依赖 Electron）
 * 用途：在打包前验证「真实行情解析 / 汇率 / 数据库读写 / 盈亏计算 / 时段判定」全部正确。
 * 运行：node tools/selftest.js
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

const store = require('../electron/lib/store');
const market = require('../electron/lib/market');
const fx = require('../electron/lib/fx');
const sessions = require('../electron/lib/sessions');
const portfolio = require('../electron/lib/portfolio');

const pass = [];
const fail = [];
function check(name, cond, extra) {
  if (cond) {
    pass.push(name);
    console.log(`  [PASS] ${name}${extra ? ' → ' + extra : ''}`);
  } else {
    fail.push(name);
    console.log(`  [FAIL] ${name}${extra ? ' → ' + extra : ''}`);
  }
}
const fmt = (n, d = 2) => (n == null || !isFinite(n) ? 'null' : Number(n).toFixed(d));

async function main() {
  console.log('='.repeat(74));
  console.log('个人理财工作台 — 核心链路自检');
  console.log('北京时间:', sessions.beijingNowStr());
  console.log('='.repeat(74));

  /* ---------- 1. 交易时段判定 ---------- */
  console.log('\n[1] 交易时段判定（三市场独立时区，自动处理美国夏令时）');
  const phases = sessions.allPhases();
  for (const [k, p] of Object.entries(phases)) {
    console.log(`  ${p.label.padEnd(4)} 本地时间 ${p.local.dateStr} ${String(p.local.hh).padStart(2, '0')}:${String(p.local.mm).padStart(2, '0')} (${p.local.weekday})  状态=${p.phaseText}`);
  }
  check('三市场时段均已判定', Object.keys(phases).length === 3);
  check('美股时区为 America/New_York', phases.US.tz === 'America/New_York');
  check('A股时区为 Asia/Shanghai', phases.CN.tz === 'Asia/Shanghai');

  /* ---------- 2. 数据库 ---------- */
  console.log('\n[2] 数据库读写（真实 SQLite 文件）');
  const testDir = path.join(os.tmpdir(), 'fw-selftest-' + Date.now());
  const dbPath = await store.open(testDir);
  check('数据库文件已创建', fs.existsSync(dbPath), dbPath);
  const info = store.dbInfo();
  check('数据表已建立(>=9张)', info.tables.length >= 9, info.tables.join(','));

  const hid = store.upsertHolding({
    market: 'US', code: 'AAPL', name: '苹果', sector: '科技-消费电子',
    currency: 'USD', quantity: 100, cost_price: 250, invest_cost: 25000, asset_type: 'STOCK'
  });
  check('持仓写入成功', !!hid, 'id=' + hid);
  store.upsertHolding({ market: 'US', code: 'SPY', name: 'SPDR标普500ETF', sector: '宽基ETF', currency: 'USD', invest_cost: 50000, qty_estimated: 1, cost_estimated: 1, asset_type: 'ETF' });
  store.upsertHolding({ market: 'CN', code: '600519', name: '贵州茅台', sector: '白酒', currency: 'CNY', quantity: 200, cost_price: 1500, invest_cost: 300000 });
  store.upsertHolding({ market: 'HK', code: '00700', name: '腾讯控股', sector: '互联网', currency: 'HKD', quantity: 500, cost_price: 400, invest_cost: 200000 });
  check('持仓总数为4', store.listHoldings().length === 4);

  store.flushNow();
  store.close();
  await store.open(testDir);
  check('重启后持仓可恢复', store.listHoldings().length === 4, '重新打开数据库后仍为4条');

  /* ---------- 3. 真实行情 ---------- */
  console.log('\n[3] 真实行情抓取（多市场 + 指数）');
  const symbols = [
    { market: 'CN', code: '600519', name: '贵州茅台' },
    { market: 'HK', code: '00700', name: '腾讯控股' },
    { market: 'US', code: 'AAPL', name: '苹果' },
    { market: 'US', code: 'SPY', name: 'SPDR标普500ETF' },
    { market: 'CN', code: '000001', name: '上证指数' },
    { market: 'HK', code: 'HSTECH', name: '恒生科技指数' }
  ];
  const { quotes, attempts } = await market.fetchQuotes(symbols, { priority: ['tencent', 'sina', 'eastmoney'], keys: {} });
  console.log('  源尝试记录:');
  for (const a of attempts) {
    console.log(`    ${a.label.padEnd(10)} ok=${a.ok} 命中${a.hit ?? 0}/${a.requested ?? 0} 延迟${a.latency ?? '-'}ms ${a.reason || ''}`);
  }
  console.log('  行情明细:');
  let okCount = 0;
  for (const s of symbols) {
    const q = quotes[market.symKey(s.market, s.code)];
    if (q && q.ok) {
      okCount++;
      console.log(
        `    ${q.market}/${q.code} ${String(q.name).padEnd(12)} ${fmt(q.price, 3).padStart(10)} ${q.currency}` +
        ` 昨收${fmt(q.prevClose, 3).padStart(10)} 涨跌${fmt(q.changePct, 2).padStart(7)}%` +
        ` | ${q.priceTypeText} | ${q.sourceLabel}${q.sourceLimited ? '(可能限流)' : ''} | 交易日${q.tradeDate}`
      );
    } else {
      console.log(`    ${s.market}/${s.code} 获取失败: ${q ? q.reason : '无返回'}`);
    }
  }
  check('至少获取到5个标的的真实行情', okCount >= 5, `实际 ${okCount}/6`);
  const aapl = quotes['US:AAPL'];
  check('美股价格为正数且非模拟', aapl && aapl.ok && aapl.price > 0, aapl && aapl.ok ? `AAPL=${aapl.price}` : 'N/A');
  check('美股已标注价格类型', aapl && aapl.ok && !!aapl.priceTypeText, aapl && aapl.priceTypeText);
  check('A股与美股币种正确区分', quotes['CN:600519'] && quotes['CN:600519'].currency === 'CNY' && aapl.currency === 'USD');
  const hstech = quotes['HK:HSTECH'];
  check('指数已识别为 isIndex', hstech && hstech.ok && hstech.isIndex === true);

  // 落库收盘价
  for (const k of Object.keys(quotes)) {
    const q = quotes[k];
    if (q.ok && q.tradeDate && q.prevClose) store.saveClose(q.market, q.code, q.tradeDate, q.price, q.source);
  }
  check('收盘价可留存到数据库', store.recentCloses('US', 'AAPL', 5).length >= 1);

  /* ---------- 4. 汇率 ---------- */
  console.log('\n[4] 汇率抓取');
  const fxRes = await fx.fetchRates(['CNY', 'HKD']);
  for (const a of fxRes.attempts) {
    console.log(`    ${a.label.padEnd(32)} ok=${a.ok} 延迟${a.latency ?? '-'}ms ${a.reason || ''}`);
  }
  const usdcny = fxRes.pairs['USD/CNY'];
  const usdhkd = fxRes.pairs['USD/HKD'];
  if (usdcny) console.log(`    USD/CNY = ${usdcny.rate}  来源:${usdcny.source}  报价日:${usdcny.quote_date}  频率:${usdcny.update_freq}`);
  if (usdhkd) console.log(`    USD/HKD = ${usdhkd.rate}  来源:${usdhkd.source}`);
  check('取到 USD/CNY 汇率且在合理区间(5~9)', !!usdcny && usdcny.rate > 5 && usdcny.rate < 9, usdcny && String(usdcny.rate));
  check('取到 USD/HKD 汇率且在合理区间(7~8.5)', !!usdhkd && usdhkd.rate > 7 && usdhkd.rate < 8.5, usdhkd && String(usdhkd.rate));
  check('汇率标注了来源类型', !!usdcny && usdcny.source_type === 'AUTO');
  for (const p of Object.values(fxRes.pairs)) store.saveFxRate(p);
  check('汇率已入库', store.listFxRates().length >= 2, `${store.listFxRates().length} 个货币对`);

  /* ---------- 5. 盈亏计算 ---------- */
  console.log('\n[5] 组合盈亏计算（含跨币种换算）');
  const snap = await portfolio.buildSnapshot({
    holdings: store.listHoldings(),
    cash: store.listCash(),
    quotes,
    fxRows: store.listFxRates(),
    baseCurrency: 'USD'
  });
  console.log(`    基准币种: ${snap.baseCurrency}`);
  console.log(`    总资产   : ${fmt(snap.totals.totalAssets)}  证券:${fmt(snap.totals.securities)}  现金:${fmt(snap.totals.cash)}`);
  console.log(`    当日盈亏 : ${fmt(snap.totals.dayPnl)} (${fmt(snap.totals.dayPnlPct)}%)`);
  console.log(`    总盈亏   : ${fmt(snap.totals.totalPnl)} (${fmt(snap.totals.totalPnlPct)}%)  可算标的${snap.totals.totalPnlCoverage}`);
  for (const r of snap.rows) {
    console.log(
      `    ${r.market}/${r.code} ${String(r.name).padEnd(12)} 权重${fmt(r.weightPct, 2).padStart(6)}%` +
      ` 市值${fmt(r.marketValueBase).padStart(12)} 当日${fmt(r.dayPnlBase).padStart(10)} 总${r.totalPnlBase == null ? '待录入成本'.padStart(10) : fmt(r.totalPnlBase).padStart(10)}` +
      ` ${r.qtyEstimated ? '[数量暂待估]' : ''}${r.costMissing ? '[成本价待录入]' : ''}`
    );
  }
  check('总资产为正', snap.totals.totalAssets > 0, fmt(snap.totals.totalAssets));
  check('权重合计约等于100%', Math.abs(snap.rows.reduce((a, r) => a + (r.weightPct || 0), 0) - 100) < 0.5);
  const spyRow = snap.rows.find((r) => r.code === 'SPY');
  check('未录成本价的标的：总盈亏标记为不可算而非0', spyRow && spyRow.totalPnlBase == null && spyRow.costMissing === true);
  check('已录成本价的标的：总盈亏可算', snap.rows.find((r) => r.code === 'AAPL').totalPnlBase != null);

  // 手工复核一笔计算
  const a = snap.rows.find((r) => r.code === 'AAPL');
  const expectDay = 100 * (aapl.price - aapl.prevClose);
  check('AAPL当日盈亏公式复核(数量×(现价-昨收))', Math.abs(a.dayPnlBase - expectDay) < 0.01, `计算${fmt(a.dayPnlBase)} 预期${fmt(expectDay)}`);
  const expectTotal = 100 * (aapl.price - 250);
  check('AAPL总盈亏公式复核(数量×(现价-成本价))', Math.abs(a.totalPnlBase - expectTotal) < 0.01, `计算${fmt(a.totalPnlBase)} 预期${fmt(expectTotal)}`);

  // 跨币种复核：茅台以 USD 计价
  const mt = snap.rows.find((r) => r.code === '600519');
  const cnyUsd = store.listFxRates().find((r) => r.pair === 'CNY/USD');
  if (mt && cnyUsd) {
    const expectMv = 200 * quotes['CN:600519'].price * cnyUsd.rate;
    check('茅台市值跨币种换算复核(CNY→USD)', Math.abs(mt.marketValueBase - expectMv) < 0.5, `计算${fmt(mt.marketValueBase)} 预期${fmt(expectMv)}`);
    console.log(`      换算依据: ${mt.fxPair} = ${mt.fxRate} (${mt.fxSource})`);
  }

  /* ---------- 6. 富途 OpenD ---------- */
  console.log('\n[6] 富途 OpenD 本地网关探测');
  const futu = await market.checkFutuOpenD({ host: '127.0.0.1', port: 11111 });
  console.log(`    可达=${futu.reachable} ${futu.reason || ''}`);
  check('OpenD 探测返回明确状态', typeof futu.reachable === 'boolean');

  /* ---------- 7. 缺失数据处理 ---------- */
  console.log('\n[7] 不存在的标的：必须报错不得编造');
  const bogus = await market.fetchQuotes([{ market: 'US', code: 'ZZZZQQQQ9' }], { priority: ['tencent', 'sina'], keys: {} });
  const bq = bogus.quotes['US:ZZZZQQQQ9'];
  console.log(`    ok=${bq.ok} 原因=${bq.reason}`);
  check('无效标的返回 ok:false', bq && bq.ok === false);
  check('无效标的给出失败原因', !!(bq && bq.reason));
  check('无效标的不含任何价格字段', bq && bq.price === undefined);

  store.close();
  try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}

  console.log('\n' + '='.repeat(74));
  console.log(`自检结果: 通过 ${pass.length} / 失败 ${fail.length}`);
  if (fail.length) {
    console.log('失败项:');
    fail.forEach((f) => console.log('  - ' + f));
    process.exitCode = 1;
  } else {
    console.log('全部通过。核心链路可用。');
  }
  console.log('='.repeat(74));
}

main().catch((e) => {
  console.error('\n自检异常终止:', e);
  process.exitCode = 1;
});
