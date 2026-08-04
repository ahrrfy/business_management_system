// أدوات مشتركة خاصة بحزمة الشراء (يستهلكها order/receive) — غير مُصدَّرة من البرميل purchaseService.ts.
import { TRPCError } from "@trpc/server";
import type { Actor } from "../tx";

/** عزل الفرع: غير المدير/الأدمن يُجبر فرعه على أوامر الشراء (نمط productionService.assertProductionBranch). */
export function assertPurchaseBranch(po: { branchId: number | string }, actor: Actor & { role?: string }) {
  const elevated = actor.role === "admin" || actor.role === "manager";
  if (elevated) return;
  if (Number(po.branchId) !== actor.branchId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "لا تستطيع التعديل على فرع آخر" });
  }
}
