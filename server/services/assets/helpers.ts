// تحميل الأصل تحت قفل صفّ (FOR UPDATE) — يمنع سباق TOCTOU. داخلية للحزمة فقط.
import { eq } from "drizzle-orm";
import { fixedAssets } from "../../../drizzle/schema";
import type { Tx } from "../../db";

/** يحمّل الأصل داخل المعاملة تحت قفل صفّ (FOR UPDATE) — يمنع سباق TOCTOU بين فحص الحالة والكتابة.
 *  تصدير داخلي للحزمة فقط (يستهلكه update/lifecycle/dispose/monthlyDepreciation) — لا يُعاد
 *  تصديره من البرميل assetsService.ts. */
export async function loadForUpdate(tx: Tx, assetId: number) {
  const [a] = await tx.select().from(fixedAssets).where(eq(fixedAssets.id, assetId)).for("update").limit(1);
  if (!a) throw new Error("الأصل غير موجود");
  return a;
}
