'use strict';
// 生成 finance-workbench 的 Windows 图标 (build/icon.ico)
// 不依赖任何外部库：自绘 256x256 32bpp 像素，再按 ICO 格式（BMP 体）封装。
const fs = require('fs');
const path = require('path');

const S = 256;
// BGRA 像素缓冲（自下而上）
const px = Buffer.alloc(S * S * 4);

function setPx(x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  // ICO/BMP 为自下而上存储
  const yy = S - 1 - y;
  const i = (yy * S + x) * 4;
  px[i] = b;
  px[i + 1] = g;
  px[i + 2] = r;
  px[i + 3] = a;
}
function rect(x0, y0, x1, y1, r, g, b, a = 255) {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) setPx(x, y, r, g, b, a);
}
function roundRect(x0, y0, x1, y1, rad, r, g, b, a = 255) {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const cx = Math.min(Math.max(x, x0 + rad), x1 - rad);
      const cy = Math.min(Math.max(y, y0 + rad), y1 - rad);
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= rad * rad) setPx(x, y, r, g, b, a);
    }
  }
}
function disc(cx, cy, rad, r, g, b, a = 255) {
  for (let y = cy - rad; y <= cy + rad; y++)
    for (let x = cx - rad; x <= cx + rad; x++) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= rad * rad) setPx(x, y, r, g, b, a);
    }
}

// 背景：深蓝圆角方块
roundRect(8, 8, S - 9, S - 9, 44, 15, 20, 25);
// 内描边
roundRect(8, 8, S - 9, S - 9, 44, 38, 50, 64);
roundRect(12, 12, S - 13, S - 13, 40, 18, 24, 30);

// 上扬折线（白）
function line(x0, y0, x1, y1, r, g, b, w = 4) {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 2;
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const x = Math.round(x0 + (x1 - x0) * t);
    const y = Math.round(y0 + (y1 - y0) * t);
    rect(x - (w >> 1), y - (w >> 1), x + (w >> 1), y + (w >> 1), r, g, b);
  }
}

// 红涨绿跌（中国习惯）：下方绿色阳线 + 上方红色，配白色趋势线
// 绿色阳烛
rect(70, 150, 96, 186, 46, 194, 126); // 阳线绿
rect(78, 138, 88, 198, 46, 194, 126); // 影线绿
// 红色阴烛
rect(120, 120, 146, 158, 240, 85, 106); // 阴线红
rect(128, 108, 138, 170, 240, 85, 106); // 影线红
// 白色趋势线（上扬）
line(60, 175, 110, 150, 235, 238, 245);
line(110, 150, 165, 120, 235, 238, 245);
line(165, 120, 210, 95, 235, 238, 245);

// 顶部小 ¥ 符号（浅金）
disc(180, 70, 34, 240, 200, 120, 230);
// 简单 ¥ 笔画（深色）
rect(176, 50, 184, 88, 20, 24, 30); // 竖
rect(160, 58, 200, 66, 20, 24, 30); // 横1
rect(162, 72, 198, 80, 20, 24, 30); // 横2
rect(168, 50, 176, 66, 20, 24, 30); // 左撇
rect(184, 50, 192, 66, 20, 24, 30); // 右捺

// ---- 封装为 ICO（含 256x256 / 48 / 32 / 16 通过缩放较麻烦，这里仅放 256） ----
// 为兼容，额外生成 48x48 与 32x32 与 16x16 由 256 下采样
function buildImage(size) {
  const out = Buffer.alloc(size * size * 4);
  const scale = S / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx = Math.floor((x + 0.5) * scale);
      const sy = Math.floor((y + 0.5) * scale);
      const si = (sy * S + sx) * 4;
      const di = (y * size + x) * 4;
      out[di] = px[si];
      out[di + 1] = px[si + 1];
      out[di + 2] = px[si + 2];
      out[di + 3] = px[si + 3];
    }
  }
  return out;
}

function bmpFromPixels(size, buf) {
  // BITMAPINFOHEADER (40) + 像素（自下而上 BGRA）
  const hdr = Buffer.alloc(40);
  hdr.writeUInt32LE(40, 0);
  hdr.writeInt32LE(size, 4);
  hdr.writeInt32LE(size, 8); // 高度（不含AND掩码）
  hdr.writeUInt16LE(1, 12);
  hdr.writeUInt16LE(32, 14);
  hdr.writeUInt32LE(0, 16);
  hdr.writeUInt32LE(size * size * 4, 20);
  // 像素需自下而上：buf 已是自下而上，直接拼接
  return Buffer.concat([hdr, buf]);
}

const sizes = [256, 48, 32, 16];
const images = sizes.map((s) => ({ size: s, data: bmpFromPixels(s, buildImage(s)) }));

// ICONDIR
const icondir = Buffer.alloc(6);
icondir.writeUInt16LE(0, 0); // reserved
icondir.writeUInt16LE(1, 2); // type=icon
icondir.writeUInt16LE(images.length, 4);

const entries = [];
let offset = 6 + images.length * 16;
const imageBuffers = [];
for (const img of images) {
  const entry = Buffer.alloc(16);
  entry.writeUInt8(img.size === 256 ? 0 : img.size, 0); // width (0=256)
  entry.writeUInt8(img.size === 256 ? 0 : img.size, 1); // height
  entry.writeUInt8(0, 2); // colors
  entry.writeUInt8(0, 3); // reserved
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bpp
  entry.writeUInt32LE(img.data.length, 8); // size
  entry.writeUInt32LE(offset, 12); // offset
  entries.push(entry);
  imageBuffers.push(img.data);
  offset += img.data.length;
}

const ico = Buffer.concat([icondir, ...entries, ...imageBuffers]);
const outPath = path.join(__dirname, '..', 'build', 'icon.ico');
fs.writeFileSync(outPath, ico);
console.log('icon written:', outPath, ico.length, 'bytes');
