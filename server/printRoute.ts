// مسار Express لجسر الطباعة (خارج tRPC). يستقبل بايتات ESC/POS جاهزة من العميل ويرسلها للطابعة محلياً.
// محمي بالمصادقة (نفس كوكي الجلسة) ⇒ لا تطبع إلا من جلسة مسجَّلة الدخول. صامت تماماً.
//   GET  /api/print/status  → { enabled, description }   (هل الجسر مفعّل؟ لاختيار العميل للمسار)
//   POST /api/print/raw     { bytesB64 }  → يطبع بايتات ESC/POS مرسَلة base64
//   POST /api/print/test    → يطبع تذكرة اختبار ASCII من الخادم مباشرة
import { Router, type Request, type Response } from "express";
import { getUserFromRequest } from "./auth/session";
import {
  getConfiguredTarget, describeTarget, isBridgeEnabled, sendToPrinter, buildTestTicket,
} from "./services/printService";
import { logger } from "./logger";

async function requireAuth(req: Request, res: Response): Promise<boolean> {
  try {
    const user = await getUserFromRequest(req);
    if (user) return true;
  } catch { /* يسقط للرفض */ }
  res.status(401).json({ ok: false, error: "يلزم تسجيل الدخول." });
  return false;
}

export function printRouter(): Router {
  const r = Router();

  // حالة الجسر — يستعملها العميل ليقرّر: جسر الخادم أم WebUSB أم حوار المتصفّح.
  r.get("/status", async (req, res) => {
    if (!(await requireAuth(req, res))) return;
    const target = getConfiguredTarget();
    res.json({ ok: true, enabled: target != null, description: describeTarget(target) });
  });

  // طباعة بايتات ESC/POS خام (base64). العميل يولّد النقطية (raster) فالعربية تُرسَّم على Canvas لديه.
  r.post("/raw", async (req, res) => {
    if (!(await requireAuth(req, res))) return;
    if (!isBridgeEnabled()) {
      return res.status(501).json({ ok: false, error: "جسر الطباعة غير مفعّل على الخادم (PRINT_TARGET غير مضبوط)." });
    }
    const b64 = (req.body?.bytesB64 ?? "") as string;
    if (typeof b64 !== "string" || b64.length === 0) {
      return res.status(400).json({ ok: false, error: "حقل bytesB64 مطلوب (base64)." });
    }
    let bytes: Buffer;
    try {
      bytes = Buffer.from(b64, "base64");
    } catch {
      return res.status(400).json({ ok: false, error: "تعذّر فكّ ترميز base64." });
    }
    if (bytes.length === 0) {
      return res.status(400).json({ ok: false, error: "بيانات الطباعة فارغة." });
    }
    try {
      const target = await sendToPrinter(bytes);
      res.json({ ok: true, via: "server", target: target.kind, bytes: bytes.length });
    } catch (e) {
      logger.error({ err: e }, "print bridge raw failed");
      res.status(502).json({ ok: false, error: e instanceof Error ? e.message : "فشل إرسال الطباعة للطابعة." });
    }
  });

  // تذكرة اختبار (ASCII) — للتحقق من سلامة المسار والقاطع.
  r.post("/test", async (req, res) => {
    if (!(await requireAuth(req, res))) return;
    if (!isBridgeEnabled()) {
      return res.status(501).json({ ok: false, error: "جسر الطباعة غير مفعّل على الخادم (PRINT_TARGET غير مضبوط)." });
    }
    try {
      const target = await sendToPrinter(buildTestTicket());
      res.json({ ok: true, via: "server", target: target.kind });
    } catch (e) {
      logger.error({ err: e }, "print bridge test failed");
      res.status(502).json({ ok: false, error: e instanceof Error ? e.message : "فشل اختبار الطباعة." });
    }
  });

  return r;
}
