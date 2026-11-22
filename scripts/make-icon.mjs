// Renders the Board as a Service logo (the favicon SVG: a blue rounded square, three
// white heads and a white table) to public/icon.png at 256 px, with no image library:
// a 4x supersampled rasterizer and a hand-built PNG. Run: node scripts/make-icon.mjs [size] [file], e.g. 512 icon.png, 400 icon-400.png
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const N = Number(process.argv[2]) || 512;
const OUT = process.argv[3] || 'icon.png';
const S = N / 32; // the SVG is drawn on a 32 unit grid
const SS = 4;
const BLUE = [0x2f, 0x5b, 0xd3];

function roundRect(x, y, x0, y0, w, h, r) {
  const cx = Math.min(Math.max(x, x0 + r), x0 + w - r);
  const cy = Math.min(Math.max(y, y0 + r), y0 + h - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r && x >= x0 && x <= x0 + w && y >= y0 && y <= y0 + h;
}
const circle = (x, y, cx, cy, r) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;

function sample(x, y) {
  if (!roundRect(x, y, 0, 0, 32, 32, 7)) return null;
  const white = circle(x, y, 9, 12, 3) || circle(x, y, 16, 10, 3) || circle(x, y, 23, 12, 3) || roundRect(x, y, 6, 18, 20, 5, 2);
  return white ? [255, 255, 255] : BLUE;
}

const raw = Buffer.alloc(N * (N * 4 + 1));
for (let py = 0; py < N; py++) {
  raw[py * (N * 4 + 1)] = 0; // filter: none
  for (let px = 0; px < N; px++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const c = sample((px + (sx + 0.5) / SS) / S, (py + (sy + 0.5) / SS) / S);
        if (c) {
          r += c[0]; g += c[1]; b += c[2]; a++;
        }
      }
    }
    const o = py * (N * 4 + 1) + 1 + px * 4;
    raw[o] = a ? Math.round(r / a) : 0;
    raw[o + 1] = a ? Math.round(g / a) : 0;
    raw[o + 2] = a ? Math.round(b / a) : 0;
    raw[o + 3] = Math.round((a / (SS * SS)) * 255);
  }
}

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0);
ihdr.writeUInt32BE(N, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
writeFileSync(new URL(`../public/${OUT}`, import.meta.url), png);
console.log(`public/${OUT} ${N}px ${png.length} bytes`);
