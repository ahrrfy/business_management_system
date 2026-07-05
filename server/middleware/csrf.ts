import type { NextFunction, Request, Response } from "express";
import { sendTrpcError } from "./trpcError";

/**
 * Origin check CSRF guard (defense-in-depth on top of sameSite:"strict").
 * بناءً على: https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html
 *
 * يتحقّق من أنّ Origin/Referer يطابق مضيف الخادم لكل طلب غير آمن، وعند غيابهما معاً
 * يقبل شهادة `Sec-Fetch-Site` (يحقنها المتصفح نفسه ولا تستطيع صفحة مهاجمة تزويرها).
 * المستثنيات: GET, HEAD, OPTIONS, healthz, WebSocket upgrades.
 */
function deny(req: Request, res: Response, message: string): void {
  // على سطح tRPC نرسل غلاف tRPC الصحيح كي تعرض الواجهة الرسالة العربية بدل
  // «Unable to transform response from server» (علّة دخول اللوحي ٤/٧). بقية الأسطح
  // (/api/print، /api/backups) تقرأ `{error}` العارية كما كانت.
  if (req.baseUrl.startsWith("/api/trpc")) {
    sendTrpcError(res, { httpStatus: 403, code: "FORBIDDEN", message });
  } else {
    res.status(403).json({ error: message });
  }
}

export function csrfGuard(req: Request, res: Response, next: NextFunction): void {
  const safe = ["GET", "HEAD", "OPTIONS"];
  if (safe.includes(req.method)) {
    next();
    return;
  }

  const origin = req.headers["origin"];
  const referer = req.headers["referer"];
  // «null» الحرفية (أصل مبهم: webview/sandbox/أوضاع خصوصية) تعامَل كغياب الترويسة —
  // كانت تسقط في new URL("null") فتُرفض برسالة «غير صالح» دون استشارة Sec-Fetch-Site.
  // آمن: صفحة مهاجمة بأصل مبهم تحمل sec-fetch-site: cross-site فتُرفض هناك.
  const raw = origin ?? referer ?? "";
  const source = raw === "null" ? "" : raw;

  if (!source) {
    // بعض متصفحات اللوحي/الجوال (أوضاع الخصوصية/توفير البيانات) تحجب Origin وReferer
    // معاً (helmet يضبط Referrer-Policy: no-referrer أصلاً فلا Referer إطلاقاً).
    // Sec-Fetch-Site ترويسة محظورة يكتبها المتصفح وحده: same-origin = الطلب من صفحات
    // موقعنا نفسه، وnone = تفاعل مباشر من المستخدم — كلاهما ليس CSRF عابر مواقع.
    const fetchSite = String(req.headers["sec-fetch-site"] ?? "").toLowerCase();
    if (fetchSite === "same-origin" || fetchSite === "none") {
      next();
      return;
    }
    deny(
      req,
      res,
      "تعذّر التحقق من مصدر الطلب: متصفحك يحجب ترويسة المصدر (Origin). عطّل وضع توفير البيانات/الخصوصية لهذا الموقع أو جرّب متصفحاً آخر."
    );
    return;
  }

  // مطابقة origin تامّة (لا startsWith) — يمنع نطاقات lookalike مثل example.com.evil.com
  // التي كانت تمرّ تحت startsWith. نستخرج origin الفعلي من Origin/Referer.
  const host = `${req.protocol}://${req.get("host")}`;
  let sourceOrigin: string;
  try {
    sourceOrigin = new URL(source).origin;
  } catch {
    deny(req, res, "CSRF: مصدر الطلب غير صالح");
    return;
  }
  if (sourceOrigin !== host) {
    deny(req, res, "CSRF: مصدر الطلب غير مصرَّح");
    return;
  }

  next();
}
