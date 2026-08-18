// PWAアイコン（PNG）を依存ライブラリなしで生成するスクリプト。
// 既存のfavicon（黒地に赤丸）と同じ意匠を、必要な各サイズで書き出す。
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, '..', 'public', 'icons');
mkdirSync(outDir, { recursive: true });

const BG = [0x11, 0x11, 0x11, 255];
const FG = [0xe6, 0x39, 0x46, 255];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

// size: 出力の一辺(px)。circleRatio: 一辺に対する赤丸の半径比。
function buildPng(size, circleRatio) {
  const cx = size / 2;
  const cy = size / 2;
  const r = size * circleRatio;
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    row[0] = 0; // フィルタなし
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const inside = dx * dx + dy * dy <= r * r;
      const px = inside ? FG : BG;
      const o = 1 + x * 4;
      row[o] = px[0];
      row[o + 1] = px[1];
      row[o + 2] = px[2];
      row[o + 3] = px[3];
    }
    rows.push(row);
  }
  const raw = Buffer.concat(rows);
  const idatData = deflateSync(raw);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idatData),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const targets = [
  { file: 'icon-192.png', size: 192, ratio: 0.375 },
  { file: 'icon-512.png', size: 512, ratio: 0.375 },
  // maskable: OSが円形等でマスクしても意匠が切れないよう、中心寄りに小さく描く
  { file: 'icon-maskable-512.png', size: 512, ratio: 0.28 },
  { file: 'apple-touch-icon.png', size: 180, ratio: 0.375 },
];

for (const t of targets) {
  writeFileSync(join(outDir, t.file), buildPng(t.size, t.ratio));
  console.log(`wrote ${t.file}`);
}
