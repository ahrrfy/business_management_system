import type { NextFunction, Request, Response } from "express";

/**
 * Origin check CSRF guard (defense-in-depth on top of sameSite:"strict").
 * بناءً على: https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html
 *
 * يتحقّق من أنّ Origin/Referer يطابق مضيف الخادم لكل طلب غير آمن.
 * المستثنيات: GET, HEAD, OPTIONS, healthz, WebSocket upgrades.
 */
export function csrfGuard(req: Request, res: Response, next: NextFunction): void {
  const safe = ["GET", "HEAD", "OPTIONS"];
  if (safe.includes(req.method)) {
    next();
    return;
  }

  const origin = req.headers["origin"];
  const referer = req.headers["referer"];
  const source = origin ?? referer ?? "";

  if (!source) {
    // في بيئة المطبعة المحلية (شبكة داخلية)، بعض العملاء لا يُرسلون Origin.
    // نمرّرهم بدلاً من رفضهم لأنّ sameSite:"strict" يوفّر الحماية الأساسية.
    next();
    return;
  }

  const host = `${req.protocol}://${req.get("host")}`;
  if (!source.startsWith(host)) {
    res.status(403).json({ error: "CSRF: مصدر الطلب غير مصرَّح" });
    return;
  }

  next();
}
