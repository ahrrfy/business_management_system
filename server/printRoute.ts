// مسار Express لجسر الطباعة (خارج tRPC). يستقبل بايتات ESC/POS جاهزة من العميل ويرسلها للطابعة محلياً.
// محمي بالمصادقة (نفس كوكي الجلسة) ⇒ لا تطبع إلا من جلسة مسجَّلة الدخول. صامت تماماً.
//   GET  /api/print/status  → { enabled, description }   (هل الجسر مفعّل؟ لاختيار العميل للمسار)
//   POST /api/print/raw     { bytesB64 }  → يطبع بايتات ESC/POS مرسَلة base64
//   POST /api/print/test    → يطبع تذكرة اختبار ASCII من الخادم مباشرة
import { Router, type Request, type Response } from "express";
import type { User } from "../drizzle/schema";
import { getUserFromRequest } from "./auth/session";
import {
  getConfiguredTarget, describeTarget, isBridgeEnabled, sendToPrinter, buildTestTicket,
} from "./services/printService";
import { getOpenShift } from "./services/shiftService";
import { logger } from "./logger";

// حدّ base64 لطلب الطباعة الخام: ١٤M حرف ≈ ١٠MB ثنائي (base64 يضخّم ~4/3).
// متّسق مع حدّ /api/print/raw في server/index.ts ⇒ يُرفض كلاهما قبل تشكيل Buffer.
const MAX_PRINT_B64_CHARS = 14_000_000;

async function requireAuth(req: Request, res: Response): Promise<User | null> {
  try {
    const user = await getUserFromRequest(req);
    if (user) return user;
  } catch { /* يسقط للرفض */ }
  res.status(401).json({ ok: false, error: "يلزم تسجيل الدخول." });
  return null;
}

// يسمح بالطباعة لمدير/أدمن دون شرط، ولكاشير/مستودع فقط إن كان عنده وردية مفتوحة.
// السبب: جسر الطباعة الخام مكلف (شبكة + I/O فعلي على الطابعة) ⇒ نقصره على من له
// مهمة بيع جارية، فلا يبقى مفتوحاً سطحاً لأي حساب عادي.
async function requirePrintAuthorized(user: User, res: Response): Promise<boolean> {
  if (user.role === "admin" || user.role === "manager") return true;
  const branchId = user.branchId;
  if (branchId == null) {
    res.status(403).json({ ok: false, error: "غير مخوّل بالطباعة (لا فرع مرتبط بالحساب)." });
    return false;
  }
  const open = await getOpenShift(user.id, branchId);
  if (!open) {
    res.status(403).json({ ok: false, error: "غير مخوّل بالطباعة بلا وردية مفتوحة." });
    return false;
  }
  return true;
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
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!(await requirePrintAuthorized(user, res))) return;
    if (!isBridgeEnabled()) {
      return res.status(501).json({ ok: false, error: "جسر الطباعة غير مفعّل على الخادم (PRINT_TARGET غير مضبوط)." });
    }
    const b64 = (req.body?.bytesB64 ?? "") as string;
    if (typeof b64 !== "string" || b64.length === 0) {
      return res.status(400).json({ ok: false, error: "حقل bytesB64 مطلوب (base64)." });
    }
    // سقف صريح قبل تشكيل Buffer (طبقة دفاع فوق حدّ ١٠mb على مستوى Express).
    if (b64.length > MAX_PRINT_B64_CHARS) {
      return res.status(413).json({ ok: false, error: "حجم بيانات الطباعة يتجاوز الحدّ المسموح." });
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
    const user = await requireAuth(req, res);
    if (!user) return;
    if (!(await requirePrintAuthorized(user, res))) return;
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
