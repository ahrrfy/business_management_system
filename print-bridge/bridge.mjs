// جسر الطباعة المحلي للرؤية العربية — يعمل على جهاز الكاشير على 127.0.0.1.
// يكشف طابعات Windows بأسمائها، ويطبع بايتات RAW (ESC/POS) حرفياً عبر winspool ⇒ أي ماركة/موديل،
// جودة بايت-مطابقة (لا تصيير، لا ضغط، لا تحجيم). ناقل نقيّ بلا تأثير على الجودة أو التفاصيل.
//
// التشغيل:  node bridge.mjs
// الإعداد (اختياري عبر متغيّرات البيئة):
//   BRIDGE_PORT   المنفذ (افتراضي 17777؛ يجرّب 17778/17779 عند التعارض)
//   BRIDGE_TOKEN  رمز إلزامي على /printers و/print/raw (افتراضي: بلا رمز — للتطوير/الاختبار)
//   BRIDGE_ORIGINS قائمة أصول مسموحة مفصولة بفواصل (افتراضي: يعكس Origin الطلب)
//   BRIDGE_LOG    مسار ملفّ سجلّ (افتراضي: bridge.log بجوار هذا الملفّ)

import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const VERSION = "1.0.0";
const NAME = "erp-print-bridge";

// إعداد عبر ملفّ bridge.config.json (يُبسّط التثبيت كمهمة مجدولة) — متغيّرات البيئة تتقدّم عليه.
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "bridge.config.json"), "utf8"));
  } catch {
    return {};
  }
}
const CFG = loadConfig();

const PORTS = [Number(process.env.BRIDGE_PORT || CFG.port) || 17777, 17778, 17779];
const TOKEN = String(process.env.BRIDGE_TOKEN || CFG.token || "").trim();
const ALLOW_ORIGINS = String(
  process.env.BRIDGE_ORIGINS || (Array.isArray(CFG.origins) ? CFG.origins.join(",") : CFG.origins) || "",
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const LOG_FILE = process.env.BRIDGE_LOG || CFG.log || path.join(__dirname, "bridge.log");
const MAX_B64 = 14_000_000; // ≈10MB بايتات — مطابق لسقف الخادم.
const IS_WIN = process.platform === "win32";
const PS = "powershell.exe";
const RAW_PS = path.join(__dirname, "scripts", "raw-print.ps1");
const LIST_PS = path.join(__dirname, "scripts", "list-printers.ps1");

function log(line) {
  const ts = new Date().toISOString();
  const msg = `[${ts}] ${line}`;
  // eslint-disable-next-line no-console
  console.log(msg);
  try { fs.appendFileSync(LOG_FILE, msg + "\n"); } catch { /* تجاهل */ }
}

function corsHeaders(req) {
  const origin = req.headers.origin;
  let allow = "*";
  if (origin) {
    allow = ALLOW_ORIGINS.length === 0 || ALLOW_ORIGINS.includes(origin) ? origin : ALLOW_ORIGINS[0];
  }
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Private-Network": "true",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function send(res, req, status, body) {
  const headers = { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(req) };
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

function authorized(req) {
  if (!TOKEN) return true; // بلا رمز مضبوط ⇒ مسموح (تطوير/اختبار)
  const h = req.headers.authorization || "";
  return h === `Bearer ${TOKEN}`;
}

async function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let data = "";
    let aborted = false;
    req.on("data", (c) => {
      if (aborted) return;
      data += c;
      if (data.length > limit) {
        aborted = true;
        reject(new Error("الطلب أكبر من الحدّ المسموح"));
        req.destroy();
      }
    });
    req.on("end", () => { if (!aborted) resolve(data); });
    req.on("error", reject);
  });
}

async function listPrinters() {
  if (!IS_WIN) throw new Error("تعداد الطابعات مدعوم على Windows فقط");
  const { stdout } = await execFileP(PS, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", LIST_PS], {
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  const txt = (stdout || "").trim();
  if (!txt) return [];
  let parsed;
  try { parsed = JSON.parse(txt); } catch { return []; }
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  return arr.filter((p) => p && p.name);
}

/** يستخلص رسالة خطأ نظيفة من فشل PowerShell (بلا تسريب المسار الكامل للأمر). */
function cleanPsError(e) {
  const s = String((e && (e.stderr || e.message)) || e);
  const m = s.match(/argument\(s\):\s*"([^"]+)"/);
  if (m) return m[1];
  const m2 = s.match(/(OpenPrinter|StartDocPrinter|StartPagePrinter|WritePrinter)[^\r\n"]*/);
  if (m2) return m2[0];
  return s.split(/\r?\n/)[0].slice(0, 200);
}

async function printRaw(printer, bytes) {
  if (!IS_WIN) throw new Error("الطباعة مدعومة على Windows فقط");
  const tmp = path.join(os.tmpdir(), `erp-print-${process.pid}-${crypto.randomUUID()}.bin`);
  await fsp.writeFile(tmp, bytes);
  try {
    const { stdout } = await execFileP(
      PS,
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", RAW_PS, "-PrinterName", printer, "-DataFile", tmp],
      { windowsHide: true, maxBuffer: 1024 * 1024 },
    );
    if (!String(stdout).includes("OK")) throw new Error("لم يؤكّد winspool نجاح الطباعة");
  } catch (e) {
    throw new Error(cleanPsError(e));
  } finally {
    fsp.unlink(tmp).catch(() => { /* تجاهل */ });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = (req.url || "/").split("?")[0];

    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders(req));
      res.end();
      return;
    }

    if (url === "/health" && req.method === "GET") {
      send(res, req, 200, { ok: true, name: NAME, version: VERSION, platform: process.platform });
      return;
    }

    if (!authorized(req)) {
      send(res, req, 401, { ok: false, error: "رمز الجسر غير صحيح" });
      return;
    }

    if (url === "/printers" && req.method === "GET") {
      const printers = await listPrinters();
      send(res, req, 200, { ok: true, printers });
      return;
    }

    if (url === "/print/raw" && req.method === "POST") {
      const raw = await readBody(req, MAX_B64 + 4096);
      let payload;
      try { payload = JSON.parse(raw); } catch { send(res, req, 400, { ok: false, error: "JSON غير صالح" }); return; }
      const printer = String(payload?.printer || "").trim();
      const b64 = String(payload?.bytesB64 || "");
      const format = String(payload?.format || "escpos");
      if (!printer) { send(res, req, 400, { ok: false, error: "اسم الطابعة مطلوب" }); return; }
      if (!b64) { send(res, req, 400, { ok: false, error: "لا بيانات للطباعة" }); return; }
      if (b64.length > MAX_B64) { send(res, req, 413, { ok: false, error: "حجم الطباعة أكبر من المسموح" }); return; }
      const bytes = Buffer.from(b64, "base64");
      try {
        await printRaw(printer, bytes);
        log(`print/raw ok printer="${printer}" bytes=${bytes.length} format=${format}`);
        send(res, req, 200, { ok: true, printer, bytes: bytes.length, via: "winspool" });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log(`print/raw FAIL printer="${printer}" err=${msg}`);
        send(res, req, 502, { ok: false, error: `تعذّرت الطباعة: ${msg}` });
      }
      return;
    }

    send(res, req, 404, { ok: false, error: "مسار غير معروف" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`request error: ${msg}`);
    try { send(res, req, 500, { ok: false, error: msg }); } catch { /* تجاهل */ }
  }
});

function listen(idx) {
  const port = PORTS[idx];
  if (port == null) {
    log("تعذّر الاستماع على أي منفذ متاح — توقّف.");
    process.exit(1);
    return;
  }
  server.once("error", (e) => {
    if (e && e.code === "EADDRINUSE") {
      log(`المنفذ ${port} مشغول — تجربة التالي…`);
      listen(idx + 1);
    } else {
      log(`خطأ استماع: ${e?.message || e}`);
      process.exit(1);
    }
  });
  server.listen(port, "127.0.0.1", () => {
    log(`${NAME} v${VERSION} يستمع على http://127.0.0.1:${port} (token=${TOKEN ? "مفعّل" : "بلا"})`);
  });
}

listen(0);
