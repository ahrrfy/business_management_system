// F4 (تدقيق ٢/٧): كتابة سجلّ تدقيق مدير المنصّة في قاعدة التحكّم (erp_control).
// best-effort: لا يرمي أبداً (فشل التدقيق لا يكسر دخول/خروج/تعطيل) — نفس عقد auditService.logAudit
// لكن على getControlDb() بدل getDb(). بلا CONTROL_DATABASE_URL (نشر أحادي الشركة) ⇒ getControlDb()=null
// ⇒ نتخطّى بصمت (المسار لا يُستعمَل أصلاً في ذلك الوضع).
import type { Request } from "express";
import { getControlDb } from "./controlDb";
import { platformAuditLogs } from "./controlSchema";
import { logger } from "../logger";

export type PlatformAuditData = {
  action: "login" | "logout" | "company.setActive" | "company.requestCreate";
  success: boolean;
  platformAdminId?: number | null;
  actorEmail?: string | null;
  companyId?: number | null;
  details?: unknown;
};

export async function logPlatformAudit(
  ctx: { req?: Pick<Request, "ip" | "headers"> },
  data: PlatformAuditData,
): Promise<void> {
  try {
    const db = getControlDb();
    if (!db) return;
    const fwd = ctx.req?.headers?.["x-forwarded-for"];
    const ip =
      (typeof fwd === "string" ? fwd.split(",")[0]?.trim() : undefined) ?? ctx.req?.ip ?? null;
    await db.insert(platformAuditLogs).values({
      platformAdminId: data.platformAdminId ?? null,
      actorEmail: data.actorEmail ?? null,
      action: data.action,
      success: data.success,
      companyId: data.companyId ?? null,
      details: data.details ?? null,
      ipAddress: ip ? String(ip).slice(0, 64) : null,
    });
  } catch (e) {
    logger.warn({ err: e, action: data.action }, "تعذّر كتابة سجلّ تدقيق مدير المنصّة");
  }
}
