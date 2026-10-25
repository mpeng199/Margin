// Draws Margin's icons without external tools: supersampled shapes → PNG (zlib) → .icns via iconutil.
// The mark is the product's signature: a horizon with the sun half-set, day above, dusk below.
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function png(w, h, rgba) {
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

/** Render with `ss`×`ss` supersampling; shade(x,y) in unit coords returns [r,g,b,a] or null. */
function render(size, shade, ss = 4) {
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
      const c = shade((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size);
      if (c) { const al = c[3] / 255; r += c[0] * al; g += c[1] * al; b += c[2] * al; a += al; }
    }
    const n = ss * ss, i = (y * size + x) * 4;
    out[i] = a ? r / a : 0; out[i + 1] = a ? g / a : 0; out[i + 2] = a ? b / a : 0; out[i + 3] = (a / n) * 255;
  }
  return out;
}

function inSquircle(x, y) { // macOS-style rounded rect: inset 10%, radius 22.5% of the tile
  const m = 0.1, r = 0.225 * (1 - 2 * m);
  const cx = Math.min(Math.max(x, m + r), 1 - m - r), cy = Math.min(Math.max(y, m + r), 1 - m - r);
  return x >= m && x <= 1 - m && y >= m && y <= 1 - m && (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}
const HZ = 0.585;
function appShade(x, y) {
  if (!inSquircle(x, y)) return null;
  const t = (y - 0.1) / 0.8;
  let c = y < HZ ? mix(hex('#f8dc9a'), hex('#eda26c'), (y - 0.1) / (HZ - 0.1)) : mix(hex('#4f5a8e'), hex('#232846'), (y - HZ) / (0.9 - HZ));
  const dx = x - 0.5, dy = y - HZ, d = Math.hypot(dx, dy);
  if (y < HZ && d < 0.17) c = mix(c, hex('#fff6dc'), Math.min(1, (0.17 - d) / 0.01));
  if (y >= HZ && d < 0.17) c = mix(c, hex('#6b6a9a'), 0.35 * Math.min(1, (0.17 - d) / 0.02)); // faint reflection
  if (Math.abs(y - HZ) < 0.008 && x > 0.17 && x < 0.83) c = mix(c, [255, 255, 255], 0.92);
  return [...c, 255 * (t > -1 ? 1 : 0)];
}
function trayShade(x, y) { // template image: black + alpha
  const hz = 0.7, w = 0.085;
  if (Math.abs(y - hz) < w / 2 && x > 0.06 && x < 0.94) return [0, 0, 0, 255];
  const d = Math.hypot(x - 0.5, y - hz);
  if (y < hz - w / 2 && Math.abs(d - 0.26) < w / 2) return [0, 0, 0, 255];
  return null;
}

const shellAssets = path.resolve('shell/assets');
fs.mkdirSync(shellAssets, { recursive: true });
fs.writeFileSync(path.join(shellAssets, 'trayTemplate.png'), png(16, 16, render(16, trayShade, 8)));
fs.writeFileSync(path.join(shellAssets, 'trayTemplate@2x.png'), png(32, 32, render(32, trayShade, 8)));
const iconset = path.join(shellAssets, 'Margin.iconset');
fs.mkdirSync(iconset, { recursive: true });
for (const s of [16, 32, 128, 256, 512]) {
  fs.writeFileSync(path.join(iconset, `icon_${s}x${s}.png`), png(s, s, render(s, appShade, s < 64 ? 8 : 3)));
  fs.writeFileSync(path.join(iconset, `icon_${s}x${s}@2x.png`), png(s * 2, s * 2, render(s * 2, appShade, s * 2 < 64 ? 8 : 2)));
}
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(shellAssets, 'Margin.icns')]);
fs.copyFileSync(path.join(iconset, 'icon_256x256.png'), path.resolve('web/public/icon.png'));
fs.rmSync(iconset, { recursive: true });
console.log('icons written to shell/assets');
