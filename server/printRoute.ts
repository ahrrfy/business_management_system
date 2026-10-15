// مسار Express لجسر الطباعة (خارج tRPC). يستقبل بايتات ESC/POS جاهزة من العميل ويرسلها للطابعة محلياً.
// محمي بالمصادقة (نفس كوكي الجلسة) ⇒ لا تطبع إلا من جلسة مسجَّلة الدخول. صامت تماماً.
//   GET  /api/print/status  → { enabled, description }   (هل الجسر مفعّل؟ لاختيار العميل للمسار)
//   POST /api/print/raw     { bytesB64 }  → يطبع بايتات ESC/POS مرسَلة base64
//   POST /api/print/test    → يطبع تذكرة اختبار ASCII من الخادم مباشرة
import { Router, type Request, type Response } from "express";
import { createContext, type AuthUser } from "./context";
import { twoFactorEnrollmentRequired } from "./trpc";
import { hasOperationPolicy } from "../shared/operationPermissions";
import {
  getConfiguredTarget,
  describeTarget,
  isBridgeEnabled,
  sendToPrinter,
  buildTestTicket,
} from "./services/printService";
import { assertDirectPrintBridgeAuthorized } from "./services/invoicePrintAuthorization";
import { logAudit } from "./services/auditService";
import { logger } from "./logger";

// حدّ base64 لطلب الطباعة الخام: ١٤M حرف ≈ ١٠MB ثنائي (base64 يضخّم ~4/3).
// متّسق مع حدّ /api/print/raw في server/index.ts ⇒ يُرفض كلاهما قبل تشكيل Buffer.
const MAX_PRINT_B64_CHARS = 14_000_000;

const ALLOWED_PRINT_ROLES = new Set([
  "admin",
  "manager",
  "cashier",
  "sales_rep",
  "print_operator",
  "warehouse",
  "accountant",
  "purchasing",
]);

// يسمح بالطباعة لكوادر النظام الفعلية المسجّلين (كاشير، محاسب، أمين مخزن، مسؤول مشتريات، فني، مندوب مبيعات، مدير)
// بعد حلّ الأدوار المخصّصة وتطبيع المالك وفحص سياسة العمليات، مع حظر المندوب الميداني (courier) والمدقّق (auditor) والدور العامّ/المعطَّل (user).
export async function resolveAuthorizedPrintUser(
  req: Request,
  res: Response,
): Promise<AuthUser | null> {
  let rawUser: AuthUser | null = null;
  try {
    const ctx = await createContext({ req, res } as Parameters<
      typeof createContext
    >[0]);
    rawUser = ctx.user;
  } catch {
    rawUser = null;
  }
  if (!rawUser) {
    res.status(401).json({ ok: false, error: "يلزم تسجيل الدخول." });
    return null;
  }

  const user = rawUser;
  const hadCustomRoleId = Boolean(user.customRoleId);
  if (twoFactorEnrollmentRequired(user)) {
    await logAudit(
      { user, req },
      {
        action: "print.authorization",
        entityType: "printer",
        outcome: "FAILURE",
        newValue: { operation: "invoicePrinting.authorizeBridge" },
      },
    );
    res.status(403).json({
      ok: false,
      error: "يجب تفعيل المصادقة الثنائية (2FA) لحسابك قبل استخدام النظام.",
    });
    return null;
  }

  if (user.isOwner) {
    return user;
  }

  if (
    user.roleLockedByInactiveCustomRole ||
    (hadCustomRoleId && !user.customRoleKey)
  ) {
    await logAudit(
      { user, req },
      {
        action: "print.authorization",
        entityType: "printer",
        outcome: "FAILURE",
        newValue: { operation: "invoicePrinting.authorizeBridge" },
      },
    );
    res.status(403).json({ ok: false, error: "غير مخوّل بالطباعة المباشرة على طابعة المتجر." });
    return null;
  }

  try {
    assertDirectPrintBridgeAuthorized(user);
  } catch (error) {
    await logAudit(
      { user, req },
      {
        action: "print.authorization",
        entityType: "printer",
        outcome: "FAILURE",
        newValue: { operation: "invoicePrinting.authorizeBridge" },
      },
    );
    res.status(403).json({
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "غير مخوّل بالطباعة المباشرة على طابعة المتجر.",
    });
    return null;
  }

  if (
    !hasOperationPolicy(user) &&
    (user.role === "courier" ||
      user.role === "auditor" ||
      user.role === "user" ||
      !ALLOWED_PRINT_ROLES.has(user.role))
  ) {
    await logAudit(
      { user, req },
      {
        action: "print.authorization",
        entityType: "printer",
        outcome: "FAILURE",
        newValue: { operation: "invoicePrinting.authorizeBridge" },
      },
    );
    res.status(403).json({ ok: false, error: "غير مخوّل بالطباعة المباشرة على طابعة المتجر." });
    return null;
  }

  return user;
}

export function printRouter(): Router {
  const r = Router();

  // حالة الجسر — يستعملها العميل ليقرّر: جسر الخادم أم WebUSB أم حوار المتصفّح.
  r.get("/status", async (req, res) => {
    const user = await resolveAuthorizedPrintUser(req, res);
    if (!user) return;
    const target = getConfiguredTarget();
    res.json({
      ok: true,
      enabled: target != null,
      description: describeTarget(target),
    });
  });

  // طباعة بايتات ESC/POS خام (base64). العميل يولّد النقطية (raster) فالعربية تُرسَّم على Canvas لديه.
  r.post("/raw", async (req, res) => {
    const user = await resolveAuthorizedPrintUser(req, res);
    if (!user) return;
    if (!isBridgeEnabled()) {
      return res.status(501).json({
        ok: false,
        error: "جسر الطباعة غير مفعّل على الخادم (PRINT_TARGET غير مضبوط).",
      });
    }
    const b64 = (req.body?.bytesB64 ?? "") as string;
    if (typeof b64 !== "string" || b64.length === 0) {
      return res
        .status(400)
        .json({ ok: false, error: "حقل bytesB64 مطلوب (base64)." });
    }
    // سقف صريح قبل تشكيل Buffer (طبقة دفاع فوق حدّ ١٠mb على مستوى Express).
    if (b64.length > MAX_PRINT_B64_CHARS) {
      return res
        .status(413)
        .json({ ok: false, error: "حجم بيانات الطباعة يتجاوز الحدّ المسموح." });
    }
    let bytes: Buffer;
    try {
      bytes = Buffer.from(b64, "base64");
    } catch {
      return res
        .status(400)
        .json({ ok: false, error: "تعذّر فكّ ترميز base64." });
    }
    if (bytes.length === 0) {
      return res
        .status(400)
        .json({ ok: false, error: "بيانات الطباعة فارغة." });
    }
    try {
      const target = await sendToPrinter(bytes);
      await logAudit(
        { user, req },
        {
          action: "print.raw",
          entityType: "printer",
          entityId: target.kind,
          newValue: { bytes: bytes.length },
        },
      );
      res.json({
        ok: true,
        via: "server",
        target: target.kind,
        bytes: bytes.length,
      });
    } catch (e) {
      await logAudit(
        { user, req },
        {
          action: "print.raw",
          entityType: "printer",
          outcome: "FAILURE",
          newValue: { bytes: bytes.length },
        },
      );
      // تدقيق ٣/٨: رسالة عامّة للعميل + التفصيل في السجلّ فقط — كان `e.message` الخام قد يكشف
      // عنوان/منفذ الطابعة أو تفاصيل شبكة داخلية (نمط imageRoute/waMedia).
      logger.error({ err: e }, "print bridge raw failed");
      res.status(502).json({ ok: false, error: "فشل إرسال الطباعة للطابعة." });
    }
  });

  // تذكرة اختبار (ASCII) — للتحقق من سلامة المسار والقاطع.
  r.post("/test", async (req, res) => {
    const user = await resolveAuthorizedPrintUser(req, res);
    if (!user) return;
    if (!isBridgeEnabled()) {
      return res.status(501).json({
        ok: false,
        error: "جسر الطباعة غير مفعّل على الخادم (PRINT_TARGET غير مضبوط).",
      });
    }
    try {
      const target = await sendToPrinter(buildTestTicket());
      await logAudit(
        { user, req },
        { action: "print.test", entityType: "printer", entityId: target.kind },
      );
      res.json({ ok: true, via: "server", target: target.kind });
    } catch (e) {
      await logAudit(
        { user, req },
        { action: "print.test", entityType: "printer", outcome: "FAILURE" },
      );
      // تدقيق ٣/٨: رسالة عامّة للعميل + التفصيل في السجلّ فقط (كأعلاه).
      logger.error({ err: e }, "print bridge test failed");
      res.status(502).json({ ok: false, error: "فشل اختبار الطباعة." });
    }
  });

  return r;
}
