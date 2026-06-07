// تسجيل التدقيق (auditLogs) — يكتب «من فعل ماذا، متى، من أين» لكل عملية حسّاسة.
// السبب (مراجعة ٧/٦): الجدول معرَّف في المخطّط ولا يُكتب فيه سطر ⇒ صفر مساءلة.
//
// التصميم: best-effort على مستوى الراوتر (لا يُلَفّ في tx العملية لتجنّب تمرير ctx
// عبر كل الخدمات). فشل التسجيل لا يكسر العملية إطلاقاً (يُسجَّل تحذيراً فقط).
import { auditLogs } from "../../drizzle/schema";
import type { TrpcContext } from "../context";
import { getDb } from "../db";
import { logger } from "../logger";

export type AuditData = {
  action: string; // مثل "sale.create" / "product.update" / "inventory.transfer"
  entityType: string; // مثل "invoice" / "product" / "stock"
  entityId?: string | number | null;
  oldValue?: unknown;
  newValue?: unknown;
};

/** يكتب سطر تدقيق. لا يرمي أبداً — السجلّ لا يجب أن يُسقط عمليةً ناجحة. */
export async function logAudit(ctx: Pick<TrpcContext, "user" | "req">, data: AuditData): Promise<void> {
  try {
    const db = getDb();
    if (!db) return;
    const ip =
      (ctx.req?.headers?.["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ??
      ctx.req?.ip ??
      null;
    await db.insert(auditLogs).values({
      userId: ctx.user?.id ?? null,
      branchId: ctx.user?.branchId ?? null,
      action: data.action,
      entityType: data.entityType,
      entityId: data.entityId != null ? String(data.entityId) : null,
      oldValue: data.oldValue ?? null,
      newValue: data.newValue ?? null,
      ipAddress: ip,
    });
  } catch (e) {
    logger.warn({ err: e, action: data.action }, "تعذّر كتابة سجلّ التدقيق");
  }
}
