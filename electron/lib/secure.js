'use strict';
/**
 * API Key 安全存储
 * 优先使用 Electron safeStorage（Windows 下走 DPAPI，绑定当前用户账户）。
 * safeStorage 不可用时回退到 AES-256-GCM，密钥由机器信息 + 本地随机盐派生。
 * 密文文件独立于数据库存放，不进入源码、不进入日志。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

let _dir = null;
let _safeStorage = null;

function init(userDataDir, safeStorage) {
  _dir = userDataDir;
  _safeStorage = safeStorage || null;
  if (!fs.existsSync(_dir)) fs.mkdirSync(_dir, { recursive: true });
}

function secretsPath() {
  return path.join(_dir, 'credentials.enc');
}
function saltPath() {
  return path.join(_dir, '.keysalt');
}

function getSalt() {
  const p = saltPath();
  if (fs.existsSync(p)) return fs.readFileSync(p);
  const salt = crypto.randomBytes(32);
  fs.writeFileSync(p, salt, { mode: 0o600 });
  return salt;
}

function fallbackKey() {
  const material = [os.hostname(), os.userInfo().username, os.platform(), os.arch()].join('|');
  return crypto.pbkdf2Sync(material, getSalt(), 120000, 32, 'sha512');
}

function encryptString(plain) {
  if (_safeStorage && _safeStorage.isEncryptionAvailable && _safeStorage.isEncryptionAvailable()) {
    return { mode: 'safeStorage', blob: _safeStorage.encryptString(plain).toString('base64') };
  }
  const key = fallbackKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { mode: 'aes-256-gcm', blob: Buffer.concat([iv, tag, enc]).toString('base64') };
}

function decryptString(rec) {
  if (!rec || !rec.blob) return null;
  if (rec.mode === 'safeStorage') {
    if (!(_safeStorage && _safeStorage.isEncryptionAvailable && _safeStorage.isEncryptionAvailable())) return null;
    return _safeStorage.decryptString(Buffer.from(rec.blob, 'base64'));
  }
  const raw = Buffer.from(rec.blob, 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const enc = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', fallbackKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

function readAll() {
  const p = secretsPath();
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

function writeAll(obj) {
  fs.writeFileSync(secretsPath(), JSON.stringify(obj, null, 2), { mode: 0o600 });
}

/** 保存一个凭据；value 为空字符串表示删除 */
function setKey(name, value) {
  const all = readAll();
  if (!value) delete all[name];
  else all[name] = encryptString(String(value));
  writeAll(all);
  return true;
}

function getKey(name) {
  const all = readAll();
  if (!all[name]) return null;
  try {
    return decryptString(all[name]);
  } catch {
    return null;
  }
}

/** 只回传是否已配置与掩码，绝不把明文送到渲染进程 */
function listKeyStatus(names) {
  const all = readAll();
  const out = {};
  for (const n of names) {
    if (!all[n]) {
      out[n] = { configured: false, masked: '', mode: null };
      continue;
    }
    let masked = '';
    try {
      const v = decryptString(all[n]) || '';
      masked = v.length <= 8 ? '*'.repeat(v.length) : `${v.slice(0, 4)}${'*'.repeat(Math.max(4, v.length - 8))}${v.slice(-4)}`;
    } catch {
      masked = '(解密失败)';
    }
    out[n] = { configured: true, masked, mode: all[n].mode };
  }
  return out;
}

function storageMode() {
  const avail = !!(_safeStorage && _safeStorage.isEncryptionAvailable && _safeStorage.isEncryptionAvailable());
  return {
    mode: avail ? 'safeStorage(DPAPI)' : 'AES-256-GCM(本地派生密钥)',
    available: avail,
    file: _dir ? secretsPath() : null
  };
}

module.exports = { init, setKey, getKey, listKeyStatus, storageMode };
