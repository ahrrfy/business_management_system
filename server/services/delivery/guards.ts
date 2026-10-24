// حُرّاس مشتركة لمسارات التوصيل — تُستدعى من داخل معاملات قائمة (Tx) حصراً.
import { TRPCError } from "@trpc/server";
import Decimal from "decimal.js";
import { and, eq, inArray, sql, asc } from "drizzle-orm";
import {
  deliveryConsignments,
  deliveryParties,
  invoices,
  deliveryShipmentMembers,
} from "../../../drizzle/schema";
import { fulfillmentRequests } from "../../../drizzle/fulfillmentSchema";
import { appErrorMessage } from "@shared/errors";
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
 * الطلب التشغيلي الموثق وحده يسمح بالقبض أثناء الطريق: processPayment يقفل
 * الجهة والإرسالية قبل الفاتورة، ثم يثبت الإيصال ويخفض مطالبة الناقل ذرياً مع نسخة ACK جديدة.
 * يبقى الحظر الافتراضي سارياً على المسارات القديمة وعلى أي مستدعٍ لا يحمل الأقفال المطلوبة.
 * كان الحارس في مسار الاستقبال وحده (reception/collect.ts) بينما `sales.pay` — الباب
 * الثاني لنفس الفاتورة — بلا حارس (مراجعة عدائية ٩/٨).
 */
const counterLocks = new WeakMap<
  Tx,
  Map<number, { id: number; partyId: number } | null>
>();

/** Cash/proof source -> party -> CN -> invoice, shared with courier collection. */
export async function prelockInvoiceCounterCollectionTx(
  tx: Tx,
  invoiceId: number,
) {
  const [preview] = await tx
    .select({
      id: deliveryConsignments.id,
      partyId: deliveryConsignments.partyId,
    })
    .from(deliveryConsignments)
    .where(eq(deliveryConsignments.invoiceId, invoiceId))
    .limit(1);
  const records = counterLocks.get(tx) ?? new Map();
  counterLocks.set(tx, records);
  if (!preview) {
    records.set(invoiceId, null);
    return;
  }
  await tx
    .select({ id: deliveryParties.id })
    .from(deliveryParties)
    .where(eq(deliveryParties.id, preview.partyId))
    .for("update")
    .limit(1);
  const [membership] = await tx
    .select({ leaderId: deliveryShipmentMembers.leaderConsignmentId })
    .from(deliveryShipmentMembers)
    .where(eq(deliveryShipmentMembers.consignmentId, preview.id))
    .for("share")
    .limit(1);
  const memberIds = membership
    ? (
        await tx
          .select({ id: deliveryShipmentMembers.consignmentId })
          .from(deliveryShipmentMembers)
          .where(
            eq(
              deliveryShipmentMembers.leaderConsignmentId,
              membership.leaderId,
            ),
          )
          .for("share")
      ).map((r) => r.id)
    : [preview.id];
  await tx
    .select({ id: deliveryConsignments.id })
    .from(deliveryConsignments)
    .where(inArray(deliveryConsignments.id, memberIds))
    .orderBy(asc(deliveryConsignments.id))
    .for("update");
  const [current] = await tx
    .select({
      id: deliveryConsignments.id,
      partyId: deliveryConsignments.partyId,
    })
    .from(deliveryConsignments)
    .where(eq(deliveryConsignments.invoiceId, invoiceId))
    .for("update")
    .limit(1);
  if (
    !current ||
    current.id !== preview.id ||
    current.partyId !== preview.partyId
  )
    throw counterClaimRace();
  records.set(invoiceId, current);
}
function counterClaimRace() {
  return new TRPCError({
    code: "CONFLICT",
    message: appErrorMessage({
      what: "تغيرت إرسالية الفاتورة أثناء التحصيل",
      why: "الجهة أو الإسناد الحالي لا يطابق الأقفال التي بدأت بها العملية",
      doThis:
        "حدّث الفاتورة وراجع مطالبة الناقل ثم أعد المحاولة بنفس إثبات الدفع؛ لا تنفذ قبضاً جديداً",
    }),
  });
}
export function assertCounterCollectionPrelocked(
  tx: Tx,
  invoiceId: number,
  cn: { id: number; partyId: number },
) {
  const locked = counterLocks.get(tx)?.get(invoiceId);
  if (!locked || locked.id !== cn.id || locked.partyId !== cn.partyId)
    throw counterClaimRace();
}
/** Source identity supplements existing invoice payment permissions, never grants them. */
export async function hasFulfillmentCounterContractTx(
  tx: Tx,
  cn: {
    fulfillmentRequestId: number | null;
    branchId: number;
    invoiceId: number | null;
  },
) {
  if (cn.fulfillmentRequestId == null || cn.invoiceId == null) return false;
  const [row] = await tx
    .select({
      requestBranch: fulfillmentRequests.branchId,
      requestCustomer: fulfillmentRequests.customerId,
      invoiceBranch: invoices.branchId,
      invoiceCustomer: invoices.customerId,
    })
    .from(fulfillmentRequests)
    .innerJoin(invoices, eq(invoices.id, cn.invoiceId))
    .where(eq(fulfillmentRequests.id, cn.fulfillmentRequestId))
    .limit(1);
  return (
    !!row &&
    row.requestBranch === cn.branchId &&
    row.invoiceBranch === cn.branchId &&
    (row.requestCustomer ?? null) === (row.invoiceCustomer ?? null)
  );
}

export async function assertNoInTransitConsignment(
  tx: Tx,
  invoiceId: number,
  options: { allowFulfillmentCounter?: boolean } = {},
) {
  const cn = (
    await tx
      .select()
      .from(deliveryConsignments)
      .where(eq(deliveryConsignments.invoiceId, invoiceId))
      .for("share")
      .limit(1)
  )[0];
  if (!cn || (cn.status !== "DISPATCHED" && cn.status !== "PARTIAL")) return;
  const parcelFinal =
    cn.parcelStatus === "DELIVERED" ||
    cn.parcelStatus === "RETURNED" ||
    cn.parcelStatus === "CANCELLED";
  if (!parcelFinal) {
    if (
      options.allowFulfillmentCounter &&
      (await hasFulfillmentCounterContractTx(tx, cn))
    ) {
      assertCounterCollectionPrelocked(tx, invoiceId, cn);
      return;
    }
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `الفاتورة بالطريق مع المندوب (إرسالية ${cn.consignmentNumber}) — التحصيل عبر توريد المندوب، أو أعد الإرسالية أولاً`,
    });
  }
}

/** Generic account settlement cannot release courier exposure: its inverse owns
 * only receipt portions. Native delivery collection owns active consignments,
 * even when the parcel is delivered but money remains with the courier. */
export async function activeDeliveryInvoiceIdsTx(
  tx: Tx,
  invoiceIds: number[],
): Promise<Set<number>> {
  if (!invoiceIds.length) return new Set();
  const rows = await tx
    .select({ invoiceId: deliveryConsignments.invoiceId })
    .from(deliveryConsignments)
    .where(
      and(
        inArray(deliveryConsignments.invoiceId, invoiceIds),
        inArray(deliveryConsignments.status, ["DISPATCHED", "PARTIAL"]),
      ),
    );
  return new Set(rows.map((row) => Number(row.invoiceId)));
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
export async function consignmentBackedBalance(
  tx: Tx,
  partyId: number,
): Promise<Decimal> {
  const row = (
    await tx
      .select({
        v: sql<string>`COALESCE(SUM(CAST(${deliveryConsignments.codAmount} AS DECIMAL(15,2)) - CAST(${deliveryConsignments.collectedAmount} AS DECIMAL(15,2)) - CAST(${deliveryConsignments.counterSettledAmount} AS DECIMAL(15,2))), 0)`,
      })
      .from(deliveryConsignments)
      .where(
        and(
          eq(deliveryConsignments.partyId, partyId),
          sql`${deliveryConsignments.moneyStatus} IN ('UNSETTLED','PARTIAL')`,
        ),
      )
  )[0];
  return round2(money(row?.v ?? "0"));
}
