// حُرّاس مشتركة لمسارات التوصيل — تُستدعى من داخل معاملات قائمة (Tx) حصراً.
import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, eq, sql } from "drizzle-orm";
import { deliveryConsignments } from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { money, round2 } from "../money";

/**
 * الحجب يقيس **الواقع الفيزيائيّ** لا حالة الدفتر (٢٢/٨): يُرفض القبض الكاونتريّ فقط
 * ما دام الطرد **بيد المندوب فعلاً** — `parcelStatus` غير نهائية (ليست DELIVERED/RETURNED/
 * CANCELLED). هناك يزدوج التحصيل مع توريد المندوب (paidAmount يتجاوز total، ذمّةٌ سالبة،
 * قيدا PAYMENT_IN لبيعٍ واحد، أو عهدةُ شبحٍ لا تُغلق إلا بشطبٍ يزوّر خسارة).
 *
 * أمّا طردٌ **ثبت تسليمُه** (DELIVERED) بتحصيلٍ جزئيّ أو بلا تحصيل: متبقّيه دينٌ حيّ على
 * العميل لا نقدٌ بيد الجهة — وكان الحجب القديم (على `status` وحدها، وهي لا تُغلق إلا عند
 * التوريد الماليّ) يترك «متبقّياً بلا مدخل نقدي»: الزبون واقفٌ بالكاونتر يريد أن يسدّد
 * والنظام يرفض (السياق الإنتاجيّ: ٧٩/٨٤ طرداً جامداً لأن تقدّم `parcelStatus` حكرٌ على
 * بوّابةٍ لا تملكها أغلب الجهات). القبض بعد الثبوت يُسجَّل على الإرسالية عبر
 * `registerCounterCollectionTx` (counterCollection.ts) فيخفض المتوقَّع توريدُه من الجهة —
 * لا ازدواج. وRETURNED/CANCELLED نهائيتان كذلك: الطرد عاد/أُلغي والتعرّض حُرِّر في مساراتها.
 *
 * يُنفَّذ كـ`preInsertCheck` **داخل** معاملة processPayment بعد قفل الفاتورة `FOR UPDATE`
 * — ونفس الصفّ يقفله `dispatchInvoiceInTx` ⇒ المساران متسلسلان حتماً (لا TOCTOU).
 * كان الحارس في مسار الاستقبال وحده (reception/collect.ts) بينما `sales.pay` — الباب
 * الثاني لنفس الفاتورة — بلا حارس (مراجعة عدائية ٩/٨).
 */
export async function assertNoInTransitConsignment(tx: Tx, invoiceId: number) {
  const cn = (
    await tx
      .select({
        n: deliveryConsignments.consignmentNumber,
        st: deliveryConsignments.status,
        parcel: deliveryConsignments.parcelStatus,
      })
      .from(deliveryConsignments)
      .where(eq(deliveryConsignments.invoiceId, invoiceId))
      .limit(1)
  )[0];
  if (!cn || (cn.st !== "DISPATCHED" && cn.st !== "PARTIAL")) return;
  const parcelFinal =
    cn.parcel === "DELIVERED" || cn.parcel === "RETURNED" || cn.parcel === "CANCELLED";
  if (!parcelFinal) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `الفاتورة بالطريق مع المندوب (إرسالية ${cn.n}) — التحصيل عبر توريد المندوب، أو أعد الإرسالية أولاً`,
    });
  }
}

/**
 * Σ متبقّي إرساليات الجهة المفتوحة (DISPATCHED/PARTIAL) = الجزء من عهدتها **المدعوم بإرساليات**.
 * ما زاد عن هذا الجزء «عهدة سائبة» (عجز توريدٍ سابق، أو تحصيلات متجرٍ بلا إرساليات) — وهي وحدها
 * القابلة للتسوية بمبلغٍ حرّ (settle) أو الشطب المجمّع: تصفيةُ عهدةٍ مدعومةٍ بإرسالية من غير
 * مسار التوريد تترك الفاتورة غير مسدَّدة وذمّة العميل قائمة والإرسالية مفتوحة للأبد.
 *
 * ٢٢/٨ — يُطرح `counterSettledAmount` أيضاً: ما سدّده الزبون بالكاونتر بعد ثبوت التسليم لم
 * يعد متوقَّعاً من الجهة (النقد لم يمرّ بيدها)، فإبقاؤه في «المدعوم» يُضخّمه فيحجب تسويةَ
 * عهدةٍ سائبةٍ حقيقية. المعادلة هنا مرآةُ سقف التوريد في remittance — تتغيّران معاً.
 */
export async function consignmentBackedBalance(tx: Tx, partyId: number): Promise<Decimal> {
  const row = (
    await tx
      .select({
        v: sql<string>`COALESCE(SUM(CAST(${deliveryConsignments.codAmount} AS DECIMAL(15,2)) - CAST(${deliveryConsignments.collectedAmount} AS DECIMAL(15,2)) - CAST(${deliveryConsignments.counterSettledAmount} AS DECIMAL(15,2))), 0)`,
      })
      .from(deliveryConsignments)
      .where(and(eq(deliveryConsignments.partyId, partyId), sql`${deliveryConsignments.moneyStatus} IN ('UNSETTLED','PARTIAL')`))
  )[0];
  return round2(money(row?.v ?? "0"));
}
