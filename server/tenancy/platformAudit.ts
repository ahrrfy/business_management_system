// F4 (تدقيق ٢/٧): كتابة سجلّ تدقيق مدير المنصّة في قاعدة التحكّم (erp_control).
// best-effort: لا يرمي أبداً (فشل التدقيق لا يكسر دخول/خروج/تعطيل) — نفس عقد auditService.logAudit
// لكن على getControlDb() بدل getDb(). بلا CONTROL_DATABASE_URL (نشر أحادي الشركة) ⇒ getControlDb()=null
// ⇒ نتخطّى بصمت (المسار لا يُستعمَل أصلاً في ذلك الوضع).
import type { Request } from "express";
import { desc, sql } from "drizzle-orm";
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
    // Express يحسم البروكسي الموثوق في req.ip؛ لا نقرأ XFF الخام الذي يمكن للعميل حقنه.
    const ip = ctx.req?.ip ?? null;
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

/** سجل المنصّة للعرض في نفس شاشة إدارتها؛ مُرقّم كي يبقى التاريخ كله قابلاً للوصول. */
export async function listPlatformAudit(input: { limit?: number; offset?: number } = {}) {
  const db = getControlDb();
  if (!db) return { rows: [], total: 0 };
  const limit = Math.max(1, Math.min(Math.trunc(input.limit ?? 50), 200));
  const offset = Math.max(0, Math.trunc(input.offset ?? 0));
  const [rows, totalRow] = await Promise.all([
    db
    .select()
    .from(platformAuditLogs)
    .orderBy(desc(platformAuditLogs.id))
      .limit(limit)
      .offset(offset),
    db.select({ n: sql<number>`COUNT(*)` }).from(platformAuditLogs),
  ]);
  return { rows, total: Number(totalRow[0]?.n ?? 0) };
}
