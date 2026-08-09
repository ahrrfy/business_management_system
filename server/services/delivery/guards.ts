// حُرّاس مشتركة لمسارات التوصيل — تُستدعى من داخل معاملات قائمة (Tx) حصراً.
import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, eq, sql } from "drizzle-orm";
import { deliveryConsignments } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { money, round2 } from "../money";

/**
 * فاتورةٌ إرساليتها **بالطريق** مع المندوب لا تُحصَّل في الكاونتر: يزدوج التحصيل مع توريد
 * المندوب (paidAmount يتجاوز total، ذمّةٌ سالبة، قيدا PAYMENT_IN لبيعٍ واحد، أو عهدةُ شبحٍ
 * لا تُغلق إلا بشطبٍ يزوّر خسارة). التحصيل مسارُه التوريد؛ ولو عاد الزبون للكاونتر تُعاد
 * الإرسالية أولاً.
 *
 * يُنفَّذ كـ`preInsertCheck` **داخل** معاملة processPayment بعد قفل الفاتورة `FOR UPDATE`
 * — ونفس الصفّ يقفله `dispatchInvoiceInTx` ⇒ المساران متسلسلان حتماً (لا TOCTOU).
 * كان الحارس في مسار الاستقبال وحده (reception/collect.ts) بينما `sales.pay` — الباب
 * الثاني لنفس الفاتورة — بلا حارس (مراجعة عدائية ٩/٨).
 */
export async function assertNoInTransitConsignment(tx: Tx, invoiceId: number) {
  const inTransit = (
    await tx
      .select({ n: deliveryConsignments.consignmentNumber, st: deliveryConsignments.status })
      .from(deliveryConsignments)
      .where(eq(deliveryConsignments.invoiceId, invoiceId))
      .limit(1)
  )[0];
  if (inTransit && (inTransit.st === "DISPATCHED" || inTransit.st === "PARTIAL")) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `الفاتورة بالطريق مع المندوب (إرسالية ${inTransit.n}) — التحصيل عبر توريد المندوب، أو أعد الإرسالية أولاً`,
    });
  }
}

/**
 * Σ متبقّي إرساليات الجهة المفتوحة (DISPATCHED/PARTIAL) = الجزء من عهدتها **المدعوم بإرساليات**.
 * ما زاد عن هذا الجزء «عهدة سائبة» (عجز توريدٍ سابق، أو تحصيلات متجرٍ بلا إرساليات) — وهي وحدها
 * القابلة للتسوية بمبلغٍ حرّ (settle) أو الشطب المجمّع: تصفيةُ عهدةٍ مدعومةٍ بإرسالية من غير
 * مسار التوريد تترك الفاتورة غير مسدَّدة وذمّة العميل قائمة والإرسالية مفتوحة للأبد.
 */
export async function consignmentBackedBalance(tx: Tx, partyId: number): Promise<Decimal> {
  const row = (
    await tx
      .select({
        v: sql<string>`COALESCE(SUM(CAST(${deliveryConsignments.codAmount} AS DECIMAL(15,2)) - CAST(${deliveryConsignments.collectedAmount} AS DECIMAL(15,2))), 0)`,
      })
      .from(deliveryConsignments)
      .where(and(eq(deliveryConsignments.partyId, partyId), sql`${deliveryConsignments.status} IN ('DISPATCHED','PARTIAL')`))
  )[0];
  return round2(money(row?.v ?? "0"));
}
