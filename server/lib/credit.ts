import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { customers } from "../../drizzle/schema";
import { money, type DecimalInput } from "../services/money";

/** يَتحقّق من حدّ الائتمان للعميل قبل بيع آجل/زيادة على الذمم.
 *
 *  دلالة creditLimit (إصلاح H4):
 *  - `null` ⇒ بلا حدّ مفروض (سماح كامل بالبيع الآجل).
 *  - `'0'` أو 0 ⇒ حظر كامل للبيع الآجل (لا ائتمان لهذا العميل).
 *  - موجب (> 0) ⇒ يُفحص: `currentBalance + addAmount ≤ creditLimit`.
 *
 *  يَقرأ صفّ العميل بـ`.for("update")` لتسلسل البيوع المتزامنة.
 *  يَرمي TRPCError code='FORBIDDEN' عند تجاوز الحدّ أو حظر الائتمان.
 *
 *  ملاحظة: `branchId` مُمرَّر للسجلّ والمراقبة (auditService) لكنه لا يُغيّر القرار
 *  حالياً — حدّ الائتمان عالمي عبر الفروع (الرصيد مُجمَّع على العميل).
 */
export async function assertCreditLimit(
  tx: any,
  customerId: number,
  addAmount: DecimalInput,
  _branchId: number,
): Promise<void> {
  const add = money(addAmount);
  if (add.lte(0)) return; // لا زيادة على الذمم ⇒ لا فحص (نقدي بحت أو دفعة).

  const rows = await tx
    .select({
      creditLimit: customers.creditLimit,
      currentBalance: customers.currentBalance,
    })
    .from(customers)
    .where(eq(customers.id, customerId))
    .for("update")
    .limit(1);

  if (!rows[0]) {
    throw new TRPCError({ code: "NOT_FOUND", message: "العميل غير موجود" });
  }

  const rawLimit = rows[0].creditLimit;

  // null ⇒ بلا حدّ مفروض (سماح كامل).
  if (rawLimit === null || rawLimit === undefined) return;

  const limit = money(rawLimit);

  // 0 صريح ⇒ حظر كامل للبيع الآجل لهذا العميل.
  if (limit.isZero()) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "تجاوز حدّ الائتمان",
    });
  }

  // موجب ⇒ فحص الإسقاط.
  const balance = money(rows[0].currentBalance ?? "0");
  const projected = balance.plus(add);
  if (projected.gt(limit)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "تجاوز حدّ الائتمان",
    });
  }
}
