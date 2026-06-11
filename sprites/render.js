// render.js — renders sprite-data.js to a PNG, zero dependencies.
// PNG encoder: RGBA, filter 0 scanlines, zlib deflate, hand-rolled CRC32.
// Usage: node render.js [scale]  → writes out.png (scaled, on light bg + raw transparent 1x as out-1x.png)
const fs = require('fs');
const zlib = require('zlib');
const { PALETTE, ROWS } = require('./sprite-data.js');

// ---- validate grid ----
const W = ROWS[0].length, H = ROWS.length;
ROWS.forEach((r, i) => {
  if (r.length !== W) throw new Error(`row ${i} length ${r.length} != ${W}`);
  for (const ch of r) if (!(ch in PALETTE) && ch !== '.') throw new Error(`row ${i}: unknown char "${ch}"`);
});
console.log(`grid ${W}x${H} ok`);

// ---- crc32 ----
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function writePng(path, w, h, getPixel /* (x,y)=>[r,g,b,a] */) {
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    const off = y * (1 + w * 4);
    raw[off] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = getPixel(x, y);
      const p = off + 1 + x * 4;
      raw[p] = r; raw[p + 1] = g; raw[p + 2] = b; raw[p + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(path, png);
  console.log(`wrote ${path} (${w}x${h})`);
}

const px = (x, y) => {
  const ch = ROWS[y][x];
  return ch === '.' ? null : PALETTE[ch];
};

// raw 1x with transparency
writePng('out-1x.png', W, H, (x, y) => px(x, y) || [0, 0, 0, 0]);

// scaled view on a light background, with margin
const SCALE = parseInt(process.argv[2] || '12', 10);
const M = 2; // margin in sprite pixels
const BG = [240, 238, 232, 255];
writePng('out.png', (W + M * 2) * SCALE, (H + M * 2) * SCALE, (X, Y) => {
  const x = Math.floor(X / SCALE) - M, y = Math.floor(Y / SCALE) - M;
  if (x < 0 || y < 0 || x >= W || y >= H) return BG;
  return px(x, y) || BG;
});
