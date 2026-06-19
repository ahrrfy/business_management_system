import express, { type Request, type Response, type NextFunction } from "express";
import crypto from "node:crypto";
import { loadConfig, getConfigPath } from "./config.js";
import { verify as verifyHmac } from "./hmac.js";
import { log } from "./logger.js";
import { printSpooler, pingSpoolerPrinter } from "./printers/spooler.js";
import { printNetwork, pingNetworkPrinter } from "./printers/network.js";
import { openCashDrawer } from "./printers/cashDrawer.js";
import type { BridgeConfig, PrinterConfig, PrinterMode, PrintRequest, PrintResponse, HealthResponse } from "./types.js";

const BRIDGE_VERSION = process.env.ALROYA_BRIDGE_VERSION || "1.0.0";
const MAX_BODY = 2 * 1024 * 1024; // 2 MB ceiling (raster receipts are ~20-50 KB; this is plenty)

let cfg: BridgeConfig;
let configError: string | null = null;
try {
  cfg = loadConfig();
} catch (e) {
  // الإعدادات مفقودة/تالفة ⇒ الجسر بلا hmacSecret لا يستطيع فحص HMAC، وأي endpoint
  // محمي يردّ 500 بدل auth failure ⇒ تجربة مرتبكة + أمان مشكوك. fail-fast بدل ذلك ⇒
  // Task Scheduler يكتشف الإخفاق ويعيد التشغيل، والمالك يرى log واضحاً.
  configError = (e as Error).message;
  log("error", "config load failed — refusing to start", {
    error: configError,
    path: getConfigPath(),
  });
  if (process.env.BRIDGE_STDOUT === "1") {
    process.stderr.write(`alroya-bridge: config load failed (${configError}). aborting.\n`);
  }
  process.exit(1);
}

const app = express();

// Tight CORS: only the configured cloud origin may call us; OPTIONS handled inline.
app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.header("origin") || "";
  const allowed = cfg.cloudUrl;
  if (allowed && origin === allowed) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Alroya-Sig");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Max-Age", "600");
  }
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

// Capture raw body for HMAC verification BEFORE JSON parsing.
app.use(express.json({
  limit: MAX_BODY,
  verify: (req, _res, buf) => {
    (req as Request & { rawBody?: string }).rawBody = buf.toString("utf8");
  },
}));

// Tag every request with an id for log correlation.
app.use((req: Request, _res: Response, next: NextFunction) => {
  (req as Request & { reqId?: string }).reqId = crypto.randomBytes(6).toString("hex");
  next();
});

function requireHmac(req: Request, res: Response, next: NextFunction): void {
  if (!cfg.hmacSecret) {
    res.status(500).json({ ok: false, error: "الجسر بلا إعدادات: cfg/hmacSecret مفقود." });
    return;
  }
  const raw = (req as Request & { rawBody?: string }).rawBody ?? "";
  const sig = req.header("X-Alroya-Sig");
  if (!verifyHmac(raw, sig, cfg.hmacSecret)) {
    log("warn", "hmac reject", { reqId: (req as Request & { reqId?: string }).reqId, path: req.path });
    res.status(401).json({ ok: false, error: "توقيع HMAC غير صحيح." });
    return;
  }
  next();
}

function selectPrinter(kind: PrintRequest["kind"]): { printer: PrinterConfig | undefined; mode: PrinterMode } {
  if (kind === "label") {
    const p = cfg.labelPrinter;
    return { printer: p, mode: (p?.mode as PrinterMode) ?? "spooler" };
  }
  // receipt + raw default to receipt printer
  const p = cfg.receiptPrinter;
  return { printer: p, mode: (p?.mode as PrinterMode) ?? "spooler" };
}

async function sendToPrinter(printer: PrinterConfig, bytes: Buffer, jobName: string): Promise<void> {
  switch (printer.mode) {
    case "spooler":
      await printSpooler(printer.spoolerName, bytes, jobName);
      return;
    case "network":
      await printNetwork(printer.host, printer.port, bytes);
      return;
    default:
      throw new Error("نمط طابعة غير معروف");
  }
}

// ─── routes ──────────────────────────────────────────────────────────────

app.get("/health", async (_req, res) => {
  const out: HealthResponse = {
    status: "ok",
    version: BRIDGE_VERSION,
    receiptConfigured: !!cfg.receiptPrinter,
    labelConfigured: !!cfg.labelPrinter,
  };
  try {
    if (cfg.receiptPrinter?.mode === "spooler") {
      out.receiptOnline = await pingSpoolerPrinter(cfg.receiptPrinter.spoolerName);
    } else if (cfg.receiptPrinter?.mode === "network") {
      out.receiptOnline = await pingNetworkPrinter(cfg.receiptPrinter.host, cfg.receiptPrinter.port);
    }
    if (cfg.labelPrinter?.mode === "spooler") {
      out.labelOnline = await pingSpoolerPrinter(cfg.labelPrinter.spoolerName);
    } else if (cfg.labelPrinter?.mode === "network") {
      out.labelOnline = await pingNetworkPrinter(cfg.labelPrinter.host, cfg.labelPrinter.port);
    }
  } catch {
    /* health is best-effort */
  }
  res.json(out);
});

app.get("/version", (_req, res) => {
  res.json({ version: BRIDGE_VERSION, channel: "stable" });
});

app.post("/print", requireHmac, async (req, res) => {
  const reqId = (req as Request & { reqId?: string }).reqId ?? "";
  const body = req.body as Partial<PrintRequest> | undefined;
  if (!body || typeof body !== "object" || typeof body.bytesB64 !== "string" || !body.bytesB64) {
    res.status(400).json({ ok: false, error: "حقول الطلب ناقصة (bytesB64)." });
    return;
  }
  const kind: PrintRequest["kind"] = body.kind === "label" || body.kind === "raw" ? body.kind : "receipt";
  const { printer } = selectPrinter(kind);
  if (!printer) {
    log("warn", "no printer configured", { reqId, kind });
    res.status(503).json({ ok: false, error: `لا توجد طابعة مُكوَّنة من نوع ${kind === "label" ? "الملصقات" : "الإيصالات"}.` });
    return;
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(body.bytesB64, "base64");
    if (bytes.length === 0) throw new Error("empty");
  } catch {
    res.status(400).json({ ok: false, error: "bytesB64 ليس Base64 صالحاً." });
    return;
  }
  const jobId = crypto.randomBytes(8).toString("hex");
  const jobName = body.jobName || `AlroyaERP-${kind}-${jobId}`;
  try {
    await sendToPrinter(printer, bytes, jobName);
    log("info", "print ok", { reqId, jobId, kind, mode: printer.mode, bytes: bytes.length });
    const resp: PrintResponse = { ok: true, jobId, mode: printer.mode };
    res.json(resp);
  } catch (e) {
    const msg = (e as Error).message || "خطأ غير معروف أثناء الطباعة";
    log("error", "print fail", { reqId, jobId, kind, mode: printer.mode, error: msg });
    res.status(503).json({ ok: false, jobId, mode: printer.mode, error: msg } satisfies PrintResponse);
  }
});

app.post("/open-drawer", requireHmac, async (_req, res) => {
  try {
    const result = await openCashDrawer(cfg.cashDrawer, cfg.receiptPrinter);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(503).json({ ok: false, error: (e as Error).message });
  }
});

app.post("/test-print", requireHmac, async (req, res) => {
  // Minimal "Hello" raw bytes — useful for installer self-test.
  const body = req.body as { kind?: PrintRequest["kind"] } | undefined;
  const kind = body?.kind === "label" ? "label" : "receipt";
  const { printer } = selectPrinter(kind);
  if (!printer) {
    res.status(503).json({ ok: false, error: "لا توجد طابعة مُكوَّنة." });
    return;
  }
  // ESC @ (init) + text + LF + GS V 0 (full cut) — universal ESC/POS
  const init = Buffer.from([0x1b, 0x40]);
  const text = Buffer.from("Al-Ru'ya ERP test print\n\n\n", "utf8");
  const cut = Buffer.from([0x1d, 0x56, 0x00]);
  try {
    await sendToPrinter(printer, Buffer.concat([init, text, cut]), "AlroyaERP-Test");
    res.json({ ok: true });
  } catch (e) {
    res.status(503).json({ ok: false, error: (e as Error).message });
  }
});

// ─── start ───────────────────────────────────────────────────────────────

const port = cfg.port || 9101;
const listener = app.listen(port, "127.0.0.1", () => {
  log("info", "bridge started", {
    version: BRIDGE_VERSION,
    port,
    cloudUrl: cfg.cloudUrl || "(missing)",
    deviceRole: cfg.deviceRole,
    receipt: cfg.receiptPrinter?.mode || "(none)",
    label: cfg.labelPrinter?.mode || "(none)",
  });
  if (process.env.BRIDGE_STDOUT === "1") {
    process.stderr.write(`alroya-bridge ${BRIDGE_VERSION} listening on 127.0.0.1:${port}\n`);
  }
});

// EADDRINUSE (نسخة أخرى من الجسر تعمل، أو منفذ مشغول من برنامج آخر) أو خطأ آخر ⇒
// fail-fast فيكتشفه Task Scheduler ويعيد المحاولة (أو ينبه المالك في سجل المهام).
listener.on("error", (err: NodeJS.ErrnoException) => {
  log("error", "listen failed", { code: err.code, error: err.message, port });
  if (process.env.BRIDGE_STDOUT === "1") {
    process.stderr.write(`alroya-bridge: listen ${err.code || "error"} on :${port}\n`);
  }
  process.exit(1);
});

// uncaught ⇒ العملية في حالة غير محددة، أنهِها وليُعيدها Task Scheduler.
process.on("uncaughtException", (err) => {
  log("error", "uncaught", { error: err.message, stack: err.stack });
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  log("error", "unhandled rejection", { error: String(err) });
  process.exit(1);
});
