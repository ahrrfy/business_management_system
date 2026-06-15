import { TRPCError } from "@trpc/server";
import { getDb, type DB, type Tx } from "../db";

/** Resolve the DB or throw a uniform tRPC error when DATABASE_URL is unset. */
export function requireDb(): DB {
  const db = getDb();
  if (!db) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" });
  }
  return db;
}

/** Wrap a unit of work in an atomic transaction. Any throw ⇒ full ROLLBACK. */
export async function withTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return requireDb().transaction(fn);
}

/**
 * Actor يُمثّل المستخدم المُنفِّذ للعملية. يُمرَّر إلى كل خدمة كتابة:
 * - userId: معرّف المستخدم (users.id) — للتدقيق + ملكية الوردية.
 * - branchId: معرّف الفرع الذي يَنتمي إليه المستخدم (users.branchId) — لعزل الفروع.
 * - role: دور المستخدم (admin/manager/cashier/warehouse) — للـRBAC على cross-branch وكشف التكلفة.
 * تأكَّد من تَمرير role من ctx.user.role في كل الراوترات.
 *
 * ملاحظة: role اختياري حفاظاً على التوافق الخلفي، لكن الخدمات التي تَفحص الصلاحية
 * على مستوى الخدمة (مثل productionService.assertProductionBranch، عزل الفروع لغير
 * admin، حجب التكلفة عن الكاشير) تَعتمد عليه — تَمريره من ctx.user.role إلزامي عملياً.
 */
export type Actor = { userId: number; branchId: number; role?: string };
