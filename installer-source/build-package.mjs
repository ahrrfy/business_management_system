// build-package.mjs — Build alroya-installer.zip ready for distribution.
//
// Pipeline:
//   1. Run build-ico.mjs to generate icons/الرؤية.ico from client/public/*.png
//   2. Ensure the bridge .exe exists (build it if missing and dependencies are present)
//   3. Stage everything into dist/alroya-installer/
//   4. ZIP it to dist/alroya-installer.zip
//
// The output ZIP contains:
//   تثبيت-الرؤية.bat        — entrypoint
//   حذف-الرؤية.bat          — uninstaller wrapper
//   README.txt              — Arabic quick-start
//   scripts/                — install.ps1, uninstall.ps1, detect-printers.ps1, etc.
//   resources/
//     bridge/alroya-bridge.exe
//     icons/الرؤية.ico
//     drivers/             — staged Zadig/libwdi if available, else placeholder
//
// Pure Node 22 — no zip dependency. Uses node:zlib + manual ZIP central directory.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { execSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const REPO = path.resolve(ROOT, "..");
const DIST = path.join(ROOT, "dist");
const STAGE = path.join(DIST, "alroya-installer");
const ZIP_OUT = path.join(DIST, "alroya-installer.zip");

function header(msg) { console.log(`\n=== ${msg} ===`); }
function info(msg) { console.log(`  ${msg}`); }
function ok(msg) { console.log(`  ✓ ${msg}`); }
function warn(msg) { console.log(`  ⚠ ${msg}`); }
function bail(msg) { console.error(`  ✗ ${msg}`); process.exit(1); }

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function ensure(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function copyDir(src, dst) {
  ensure(dst);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const sp = path.join(src, entry.name);
    const dp = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(sp, dp);
    else fs.copyFileSync(sp, dp);
  }
}

function copyFile(src, dst) {
  ensure(path.dirname(dst));
  fs.copyFileSync(src, dst);
}

// ─── Step 1: icon ──────────────────────────────────────────────────────
function buildIcon() {
  header("1/4 building icons/الرؤية.ico");
  const ico = path.join(ROOT, "icons", "الرؤية.ico");
  if (fs.existsSync(ico)) {
    info("icon already exists, rebuilding for freshness");
  }
  const rc = spawnSync(process.execPath, [path.join(ROOT, "icons", "build-ico.mjs")], {
    stdio: "inherit",
  });
  if (rc.status !== 0) bail("icon build failed");
  if (!fs.existsSync(ico)) bail("icon not generated");
  ok(`${ico} (${(fs.statSync(ico).size / 1024).toFixed(1)} KB)`);
  return ico;
}

// ─── Step 2: bridge .exe ───────────────────────────────────────────────
function buildBridgeIfNeeded() {
  header("2/4 ensuring bridge/alroya-bridge.exe");
  const bridgeExe = path.join(ROOT, "bridge", "dist", "alroya-bridge.exe");
  if (fs.existsSync(bridgeExe)) {
    ok(`already built (${(fs.statSync(bridgeExe).size / (1024*1024)).toFixed(1)} MB)`);
    return bridgeExe;
  }
  info("bridge exe missing — attempting build");
  const bridgeDir = path.join(ROOT, "bridge");
  const nm = path.join(bridgeDir, "node_modules");
  if (!fs.existsSync(nm)) {
    warn("bridge node_modules missing");
    info("run:  cd installer-source/bridge && pnpm install --ignore-workspace");
    info("then re-run this script");
    bail("aborted — install bridge dependencies first");
  }
  const rc = spawnSync(process.execPath, [path.join(bridgeDir, "build-sea.mjs")], {
    stdio: "inherit",
    cwd: bridgeDir,
  });
  if (rc.status !== 0) bail("bridge build failed");
  if (!fs.existsSync(bridgeExe)) bail("bridge exe not produced");
  ok(`built (${(fs.statSync(bridgeExe).size / (1024*1024)).toFixed(1)} MB)`);
  return bridgeExe;
}

// ─── Step 3: stage ─────────────────────────────────────────────────────
function stage(iconPath, bridgeExe) {
  header("3/4 staging dist/alroya-installer/");
  rmrf(STAGE);
  ensure(STAGE);

  // Entrypoint wrappers
  copyFile(path.join(ROOT, "تثبيت-الرؤية.bat"), path.join(STAGE, "تثبيت-الرؤية.bat"));
  copyFile(path.join(ROOT, "حذف-الرؤية.bat"), path.join(STAGE, "حذف-الرؤية.bat"));
  copyFile(path.join(ROOT, "README.txt"), path.join(STAGE, "README.txt"));

  // Scripts
  copyDir(path.join(ROOT, "scripts"), path.join(STAGE, "scripts"));

  // Resources
  copyFile(iconPath, path.join(STAGE, "resources", "icons", "الرؤية.ico"));
  copyFile(bridgeExe, path.join(STAGE, "resources", "bridge", "alroya-bridge.exe"));
  // Optional bridge version metadata
  const bridgeVersion = path.join(ROOT, "bridge", "dist", "version.json");
  if (fs.existsSync(bridgeVersion)) {
    copyFile(bridgeVersion, path.join(STAGE, "resources", "bridge", "version.json"));
  }

  // Drivers — optional staging directory for Zadig portable + libwdi-cli
  const driverStage = path.join(STAGE, "resources", "drivers");
  ensure(driverStage);
  const driverSrc = path.join(ROOT, "resources", "drivers");
  if (fs.existsSync(driverSrc)) {
    copyDir(driverSrc, driverStage);
    ok(`drivers staged from ${driverSrc}`);
  } else {
    fs.writeFileSync(
      path.join(driverStage, "README.txt"),
      [
        "ضع هنا الأدوات الاختيارية لتعريف WinUSB (نادراً ما تُحتاج):",
        "  - zadig.exe  (https://zadig.akeo.ie/)",
        "  - libwdi-cli.exe  (إن أردت تعريفاً صامتاً تلقائياً)",
        "",
        "الوضع الافتراضي (طابعة بتعريف Windows) يعمل بدون أي من هذه الأدوات.",
      ].join("\r\n"),
      "utf8",
    );
    warn("drivers/ ليست موجودة — تم وضع README فقط (الوضع spooler لا يحتاجها)");
  }

  ok(`staged at ${STAGE}`);
}

// ─── Step 4: ZIP ───────────────────────────────────────────────────────
// Minimal ZIP writer (store + deflate). Sufficient for our needs (<100 files).
function buildZip(stageDir, outPath) {
  header(`4/4 zipping → ${path.relative(REPO, outPath)}`);
  const files = [];
  function walk(dir, prefix) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(full, rel);
      else files.push({ full, rel });
    }
  }
  walk(stageDir, "");
  info(`packaging ${files.length} files`);

  const localRecords = [];
  let offset = 0;

  for (const f of files) {
    const data = fs.readFileSync(f.full);
    const compressed = zlib.deflateRawSync(data, { level: 6 });
    const useDeflate = compressed.length < data.length;
    const stored = useDeflate ? compressed : data;

    const crc = crc32(data);
    const nameBuf = Buffer.from(f.rel.replace(/\\/g, "/"), "utf8");

    // Local file header
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);   // signature
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0x0800, 6);       // flags (utf-8 filename)
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);  // method
    local.writeUInt16LE(0, 10);           // mtime
    local.writeUInt16LE(0, 12);           // mdate
    local.writeUInt32LE(crc, 14);         // crc32
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);           // extra length

    localRecords.push({ local, nameBuf, stored, crc, compSize: stored.length, rawSize: data.length, method: useDeflate ? 8 : 0, offset });
    offset += local.length + nameBuf.length + stored.length;
  }

  // Central directory
  const centralChunks = [];
  let centralSize = 0;
  for (const r of localRecords) {
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // signature
    central.writeUInt16LE(20, 4);          // version made by
    central.writeUInt16LE(20, 6);          // version needed
    central.writeUInt16LE(0x0800, 8);      // flags
    central.writeUInt16LE(r.method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(r.crc, 16);
    central.writeUInt32LE(r.compSize, 20);
    central.writeUInt32LE(r.rawSize, 24);
    central.writeUInt16LE(r.nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(r.offset, 42);
    centralChunks.push(central, r.nameBuf);
    centralSize += central.length + r.nameBuf.length;
  }

  const centralOffset = offset;

  // EOCD
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(localRecords.length, 8);
  eocd.writeUInt16LE(localRecords.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);

  const fd = fs.openSync(outPath, "w");
  try {
    for (const r of localRecords) {
      fs.writeSync(fd, r.local);
      fs.writeSync(fd, r.nameBuf);
      fs.writeSync(fd, r.stored);
    }
    for (const c of centralChunks) fs.writeSync(fd, c);
    fs.writeSync(fd, eocd);
  } finally {
    fs.closeSync(fd);
  }
  const sz = fs.statSync(outPath).size;
  ok(`wrote ${outPath} (${(sz / (1024*1024)).toFixed(1)} MB, ${files.length} files)`);
}

// CRC32 table (lazy init)
let crcTable;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ─── main ──────────────────────────────────────────────────────────────
async function main() {
  ensure(DIST);
  const iconPath = buildIcon();
  const bridgeExe = buildBridgeIfNeeded();
  stage(iconPath, bridgeExe);
  buildZip(STAGE, ZIP_OUT);
  console.log(`\n✓ Package ready: ${ZIP_OUT}`);
}

main().catch((e) => bail(e?.message ?? String(e)));
