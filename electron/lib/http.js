'use strict';
/**
 * 统一 HTTP 客户端
 * - 支持 GBK/UTF-8 解码（腾讯、新浪行情为 GBK）
 * - 统一超时、UA、延迟统计
 * - 绝不返回模拟数据：失败即抛错，由上层记录原因
 */
const iconv = require('iconv-lite');

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function request(url, opts = {}) {
  const {
    timeout = 12000,
    headers = {},
    encoding = 'utf-8',
    method = 'GET',
    body = undefined
  } = opts;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method,
      body,
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        'User-Agent': DEFAULT_UA,
        Accept: '*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        ...headers
      }
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const enc = String(encoding).toLowerCase();
    const text = enc === 'gbk' || enc === 'gb18030' ? iconv.decode(buf, 'gb18030') : buf.toString('utf8');
    return { ok: res.ok, status: res.status, text, latency: Date.now() - started };
  } catch (err) {
    const reason =
      err.name === 'AbortError' ? `请求超时(${timeout}ms)` : `网络错误: ${err.message || err}`;
    const e = new Error(reason);
    e.latency = Date.now() - started;
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function getText(url, opts = {}) {
  const r = await request(url, opts);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r;
}

async function getJSON(url, opts = {}) {
  const r = await request(url, opts);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  let raw = r.text.trim();
  // 兼容 jsonp 包裹
  const jsonp = raw.match(/^[\w.$]+\(([\s\S]*)\)\s*;?$/);
  if (jsonp) raw = jsonp[1];
  try {
    return { data: JSON.parse(raw), latency: r.latency };
  } catch (e) {
    throw new Error(`响应非合法JSON(前80字符): ${raw.slice(0, 80)}`);
  }
}

module.exports = { request, getText, getJSON, DEFAULT_UA };
