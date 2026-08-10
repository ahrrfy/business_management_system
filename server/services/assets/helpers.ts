// تحميل الأصل تحت قفل صفّ (FOR UPDATE) — يمنع سباق TOCTOU. داخلية للحزمة فقط.
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { fixedAssets } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import type { CompanyBranchScope } from "../companyBranchScope";

/** يحمّل الأصل داخل المعاملة تحت قفل صفّ (FOR UPDATE) — يمنع سباق TOCTOU بين فحص الحالة والكتابة.
 *  تصدير داخلي للحزمة فقط (يستهلكه update/lifecycle/dispose/monthlyDepreciation) — لا يُعاد
 *  تصديره من البرميل assetsService.ts. */
export async function loadForUpdate(tx: Tx, assetId: number, scope: CompanyBranchScope) {
  const conds = [eq(fixedAssets.id, assetId)];
  if (scope.branchId != null) conds.push(eq(fixedAssets.branchId, scope.branchId));
  const [a] = await tx.select().from(fixedAssets).where(and(...conds)).for("update").limit(1);
  // Deliberately mask cross-branch IDs as not found.
  if (!a) throw new TRPCError({ code: "NOT_FOUND", message: "الأصل غير موجود" });
  return a;
}
