// Build a multi-image .ico file from existing PNG assets.
// No native dependencies — pure Node + Buffer arithmetic.
//
// ICO container format (Windows Vista+):
//   ICONDIR  (6 bytes)         { reserved=0, type=1, count }
//   ICONDIRENTRY × N (16 each) { w, h, colors=0, _, planes=1, bpp=32, sizeBytes, offset }
//   imageData × N              raw PNG bytes (Vista+ supports PNG embedded in ICO)
// width/height fields are u8; 0 means 256.
//
// We embed the existing 192- and 512-pixel PNGs from client/public/.
// Windows scales them down for taskbar/desktop while preserving sharpness.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");

const SOURCES = [
  { path: path.join(ROOT, "client", "public", "icon-192.png"), declaredSize: 192 },
  { path: path.join(ROOT, "client", "public", "icon-512.png"), declaredSize: 256 }, // store as 256 (ICO max u8 idx)
];

const OUT_PATH = path.join(__dirname, "الرؤية.ico");

function readPngSize(buf) {
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A then IHDR chunk
  if (buf.length < 24 || buf[0] !== 0x89 || buf[1] !== 0x50) {
    throw new Error("not a PNG");
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return { width, height };
}

function build() {
  const images = SOURCES.map((s) => {
    if (!fs.existsSync(s.path)) {
      throw new Error(`missing source PNG: ${s.path}`);
    }
    const data = fs.readFileSync(s.path);
    const png = readPngSize(data);
    return { data, declaredSize: s.declaredSize, actual: png };
  });

  const count = images.length;
  const headerSize = 6;
  const entrySize = 16;
  const dirSize = headerSize + entrySize * count;

  // Compute offsets
  let cursor = dirSize;
  for (const img of images) {
    img.offset = cursor;
    cursor += img.data.length;
  }
  const total = cursor;

  const out = Buffer.alloc(total);

  // ICONDIR
  out.writeUInt16LE(0, 0);     // reserved
  out.writeUInt16LE(1, 2);     // type: icon
  out.writeUInt16LE(count, 4); // count

  // ICONDIRENTRY × N
  for (let i = 0; i < count; i++) {
    const img = images[i];
    const off = headerSize + i * entrySize;
    const sz = img.declaredSize >= 256 ? 0 : img.declaredSize; // 0 means 256
    out.writeUInt8(sz, off + 0);          // width
    out.writeUInt8(sz, off + 1);          // height
    out.writeUInt8(0, off + 2);           // colors (0 = no palette)
    out.writeUInt8(0, off + 3);           // reserved
    out.writeUInt16LE(1, off + 4);        // color planes
    out.writeUInt16LE(32, off + 6);       // bits per pixel
    out.writeUInt32LE(img.data.length, off + 8);  // image data size
    out.writeUInt32LE(img.offset, off + 12);      // image data offset
  }

  // image data
  for (const img of images) {
    img.data.copy(out, img.offset);
  }

  fs.writeFileSync(OUT_PATH, out);
  console.log(`✓ wrote ${OUT_PATH} (${out.length.toLocaleString()} bytes, ${count} sizes: ${images.map(i => i.declaredSize >= 256 ? 256 : i.declaredSize).join("/")})`);
}

build();
