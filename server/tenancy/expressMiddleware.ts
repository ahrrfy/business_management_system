import { COOKIE_NAME } from "@shared/const";
import { parse as parseCookie } from "cookie";
import type { NextFunction, Request, Response } from "express";
import { verifySession } from "../auth/session";
import { ensureTenantDb, isMultiTenantModeActive } from "../db";
import { logger } from "../logger";
import { runWithCompany } from "./context";
import { resolveCompanyByCode } from "./registry";

/**
 * وسيط Express يحدّد الشركة الحالية من كوكي جلسة المستخدم (`app_session_id`) قبل أي
 * معالجة، ويُغلّف بقية سلسلة الوسائط بسياق تلك الشركة (runWithCompany) — فيُوجَّه كل
 * `getDb()` لاحق (بما فيه داخل createContext/الخدمات) تلقائياً لقاعدتها الصحيحة.
 *
 * مُشترَك بين `/api/trpc` و`/api/print` و`/api/backups` (كل الأسطح المصادَق عليها بنفس
 * كوكي جلسة الشركة) — استُخرج هنا بدل تكراره في server/index.ts. **لا** يُستعمَل لِـ
 * `/api/webhooks` (لا كوكي جلسة هناك إطلاقاً — راجع server/routes/channelWebhooks.ts
 * لآلية تحديد الشركة الخاصة بها عبر رمز في مسار الرابط).
 *
 * بلا `CONTROL_DATABASE_URL` (نشر أحادي الشركة): تمريرة شفّافة تماماً — سلوك المشروع
 * كما كان قبل تعدد الشركات، بلا أي تغيير.
 */
export function tenancyMiddleware() {
  return async (req: Request, _res: Response, next: NextFunction) => {
    if (!isMultiTenantModeActive()) return next();
    const cookies = parseCookie(req.headers.cookie ?? "");
    const session = await verifySession(cookies[COOKIE_NAME]).catch(() => null);
    if (!session?.companyId) return next();
    try {
      const db = await ensureTenantDb(session.companyId);
      runWithCompany(session.companyId, db, () => next());
    } catch (e) {
      // شركة غير موجودة/معطّلة بعد إصدار التوكن ⇒ تابع بلا سياق؛ createContext (أو
      // requireAuth في printRoute/backupRoutes) يمتصّ فشل getDb() اللاحق فيصبح "غير
      // مسجَّل دخول" — لا 500 خام، لا تسريباً صامتاً على قاعدة خاطئة.
      logger.warn({ err: e, companyId: session.companyId }, "tenancy.middleware.company_unavailable");
      next();
    }
  };
}

/**
 * وسيط Express لِمَسارات webhooks لكل شركة — بَديل `tenancyMiddleware()` حَصراً لِهذا
 * السَطح، لأن مُزوّدي webhooks الخارِجيين (Meta، مَتاجر) لا يُرسِلون كوكي جلسة إطلاقاً؛
 * الشركة تُحدَّد صَراحةً مِن **رَمز الشركة في مَسار الرابط نَفسه** (`:companyCode`)، لا مِن
 * كوكي. راجِع server/routes/channelWebhooks.ts لِبِناء رابط webhook خاص بِكل شَركة
 * (`/api/webhooks/company/<رمز>/whatsapp` مَثلاً) يُسجَّل لَدى المُزوّد.
 *
 * بلا `CONTROL_DATABASE_URL` (نَشر أُحادي الشركة): هذا المَسار **غَير مُتاح** (404) — يبقى
 * `/api/webhooks/...` غَير المُقيَّد بِرمز الشركة هو المَسار الوَحيد، تَماماً كَما كان قَبل
 * تَعدّد الشركات، بَلا أَي تَغيير سُلوكي.
 */
export function companyCodeTenancyMiddleware() {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!isMultiTenantModeActive()) return res.status(404).send("not found");
    const code = String(req.params.companyCode ?? "");
    const company = code ? await resolveCompanyByCode(code).catch(() => null) : null;
    if (!company) return res.status(404).send("not found");
    try {
      const db = await ensureTenantDb(company.id);
      runWithCompany(company.id, db, () => next());
    } catch (e) {
      logger.warn({ err: e, companyCode: code }, "tenancy.webhookMiddleware.company_unavailable");
      res.status(503).send("company unavailable");
    }
  };
}
