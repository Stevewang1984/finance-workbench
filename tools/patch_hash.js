const fs = require('fs');
const OLD = '6LQI2d9BPC3Xs0ZoTQe1o3tPiA28c7+PY69Q9i/pD8lY45psMtHuLwv3vRckiVr3Zx1cbNyLlBR8STwCdcHwtA==';
const NEW = 'kvOctqybezuQkcnbAIVaMm4x019Bw7KYcD4k6h7bgnU1VvNNoButpILqinUAz+kw0hsAuAOpY84FguREOnStIQ==';
const files = [
  'node_modules/app-builder-bin/win/x64/app-builder.exe',
  'node_modules/app-builder-bin/win/ia32/app-builder.exe',
  'node_modules/app-builder-bin/win/arm64/app-builder.exe',
];
const ob = Buffer.from(OLD, 'utf8');
const nb = Buffer.from(NEW, 'utf8');
if (ob.length !== nb.length) { console.error('LENGTH MISMATCH', ob.length, nb.length); process.exit(1); }
for (const f of files) {
  let buf;
  try { buf = fs.readFileSync(f); } catch (e) { console.log('skip', f, e.code); continue; }
  let count = 0, i = 0;
  while ((i = buf.indexOf(ob, i)) !== -1) { buf.fill(nb, i, i + ob.length); count++; i += ob.length; }
  if (count > 0) { fs.writeFileSync(f, buf); console.log('PATCHED', f, 'occurrences=', count); }
  else console.log('no match in', f);
}
console.log('done');
