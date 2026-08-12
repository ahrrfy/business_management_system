// أدوات مشتركة خاصة بحزمة الشراء (يستهلكها order/receive) — غير مُصدَّرة من البرميل purchaseService.ts.
import { TRPCError } from "@trpc/server";
import type { Actor } from "../tx";

/** عزل الفرع (قرار المالك ١٢/٨: عزل مدير الفرع): المالك/الأدمن فقط يعبُران (owner مُطبَّع ⇒ admin)؛
 *  المدير مقيَّدٌ بفرعه على أوامر الشراء. */
export function assertPurchaseBranch(po: { branchId: number | string }, actor: Actor & { role?: string }) {
  const elevated = actor.role === "admin";
  if (elevated) return;
  if (Number(po.branchId) !== actor.branchId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "لا تستطيع التعديل على فرع آخر" });
  }
}
