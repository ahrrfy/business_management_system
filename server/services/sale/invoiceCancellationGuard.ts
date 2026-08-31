import { TRPCError } from "@trpc/server";
import { and, eq, inArray, isNotNull, like, sql } from "drizzle-orm";
import {
  accountingEntries,
  deliveryConsignments,
  deliveryLedgerEntries,
  deliveryParties,
  onlineOrders,
} from "../../../drizzle/schema";
import type { Tx } from "../../db";
import { money, round2 } from "../money";

export interface InvoiceCancellationGuardInput {
  invoiceId: number;
  expectedBranchId: number;
}

export interface InvoiceCancellationGuardResult {
  consignmentId: number | null;
  onlineOrderId: number | null;
}

const PARCEL_STATUS_AR: Record<string, string> = {
  ASSIGNED: "مُسنَد",
  ACCEPTED: "مقبول لدى المندوب",
  PICKED_UP: "مستلم من المندوب",
  OUT_FOR_DELIVERY: "خارج للتسليم",
  DELIVERED: "مُسلَّم",
  FAILED: "متعذّر",
  CANCELLED: "ملغى",
  RETURNED: "مُرجَع",
};

/**
 * يقفل روابط التوصيل قبل قفل الفاتورة ويمنع عكس البيع ما دام للطرد حيازة أو أثر مالي.
 *
 * ترتيب الأقفال موحّد مع مسارات التوصيل/المرتجع:
 *   مصدر النقد (في المستدعي) → جهة التوصيل → الإرسالية → الطلب الإلكتروني القديم → الفاتورة.
 *
 * السماح ضيق عمداً:
 * - الإرسالية الحديثة: CANCELLED/CANCELLED/CANCELLED فقط، بلا تحصيل/توريد/عهدة وبصافي دفتر صفر.
 * - طلب متجر قديم بلا إرسالية: CANCELLED فقط، وبلا أي دليل تحصيل COD أو قيد عهدة مندوب.
 * - طلب متجر حديث مرتبط بإرسالية ملغاة بأمان قد يبقى SHIPPED حتى يغلقه sale.cancel ذرّياً.
 */
export async function assertInvoiceCancellationDeliverySafeTx(
  tx: Tx,
  input: InvoiceCancellationGuardInput,
): Promise<InvoiceCancellationGuardResult> {
  const consignmentPreview = (
    await tx
      .select({
        id: deliveryConsignments.id,
        partyId: deliveryConsignments.partyId,
      })
      .from(deliveryConsignments)
      .where(eq(deliveryConsignments.invoiceId, input.invoiceId))
      .limit(1)
  )[0] ?? null;
  const onlineOrderPreview = (
    await tx
      .select({
        id: onlineOrders.id,
        deliveryPartyId: onlineOrders.deliveryPartyId,
      })
      .from(onlineOrders)
      .where(eq(onlineOrders.invoiceId, input.invoiceId))
      .limit(1)
  )[0] ?? null;

  // اقفل الجهات أولاً وبترتيب رقمي ثابت؛ أي حركة عهدة صحيحة تبدأ من صف الجهة نفسه.
  const previewPartyIds = Array.from(new Set([
    consignmentPreview?.partyId == null ? null : Number(consignmentPreview.partyId),
    onlineOrderPreview?.deliveryPartyId == null ? null : Number(onlineOrderPreview.deliveryPartyId),
  ].filter((id): id is number => id != null))).sort((a, b) => a - b);
  for (const partyId of previewPartyIds) {
    const party = (
      await tx
        .select({ id: deliveryParties.id })
        .from(deliveryParties)
        .where(eq(deliveryParties.id, partyId))
        .for("update")
        .limit(1)
    )[0];
    if (!party) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "رابط جهة توصيل الفاتورة غير متسق — أصلح الإرسالية قبل إلغاء الفاتورة",
      });
    }
  }

  // قفل الصف أو فجوة uq_consignment_invoice يمنع إسناداً جديداً بين الفحص وقفل الفاتورة.
  const lockedConsignments = await tx
    .select()
    .from(deliveryConsignments)
    .where(eq(deliveryConsignments.invoiceId, input.invoiceId))
    .for("update");
  if (lockedConsignments.length > 1) {
    throw new TRPCError({ code: "CONFLICT", message: "الفاتورة مرتبطة بأكثر من إرسالية — يلزم تصحيح البيانات قبل الإلغاء" });
  }
  const consignment = lockedConsignments[0] ?? null;
  if (
    (consignmentPreview == null) !== (consignment == null)
    || (consignmentPreview && consignment && Number(consignmentPreview.id) !== Number(consignment.id))
    || (consignment && !previewPartyIds.includes(Number(consignment.partyId)))
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "تغيّرت إرسالية الفاتورة أثناء الإلغاء؛ أعد المحاولة",
    });
  }

  // الطلب القديم يُقفل قبل الفاتورة مثل confirmCourierDelivery (party→order→invoice).
  const lockedOnlineOrders = await tx
    .select()
    .from(onlineOrders)
    .where(eq(onlineOrders.invoiceId, input.invoiceId))
    .for("update");
  if (lockedOnlineOrders.length > 1) {
    throw new TRPCError({ code: "CONFLICT", message: "الفاتورة مرتبطة بأكثر من طلب متجر — يلزم تصحيح البيانات قبل الإلغاء" });
  }
  const onlineOrder = lockedOnlineOrders[0] ?? null;
  if (
    (onlineOrderPreview == null) !== (onlineOrder == null)
    || (onlineOrderPreview && onlineOrder && Number(onlineOrderPreview.id) !== Number(onlineOrder.id))
    || (onlineOrder?.deliveryPartyId != null && !previewPartyIds.includes(Number(onlineOrder.deliveryPartyId)))
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "تغيّر طلب المتجر المرتبط أثناء إلغاء الفاتورة؛ أعد المحاولة",
    });
  }

  if (consignment) {
    if (Number(consignment.branchId) !== Number(input.expectedBranchId)) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "فرع الإرسالية لا يطابق فرع الفاتورة — أصلح الربط قبل الإلغاء",
      });
    }

    const terminalCancellation =
      consignment.status === "CANCELLED"
      && consignment.parcelStatus === "CANCELLED"
      && consignment.moneyStatus === "CANCELLED";
    if (!terminalCancellation) {
      const parcelLabel = PARCEL_STATUS_AR[consignment.parcelStatus] ?? consignment.parcelStatus;
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `لا يمكن إلغاء الفاتورة: الإرسالية ${consignment.consignmentNumber} غير ملغاة نهائياً (${parcelLabel}). ألغِ إسناد التوصيل أولاً، أو أعد الطرد وسوِّ عهدته من مركز التوصيل.`,
      });
    }

    const ledger = (
      await tx
        .select({
          assigned: sql<string>`COALESCE(SUM(CASE WHEN ${deliveryLedgerEntries.entryType} = 'COD_ASSIGNED' THEN ${deliveryLedgerEntries.amount} ELSE 0 END), 0)`,
          collected: sql<string>`COALESCE(SUM(CASE WHEN ${deliveryLedgerEntries.entryType} = 'COD_COLLECTED' THEN ${deliveryLedgerEntries.amount} ELSE 0 END), 0)`,
          remitted: sql<string>`COALESCE(SUM(CASE WHEN ${deliveryLedgerEntries.entryType} = 'COD_REMITTED' THEN ${deliveryLedgerEntries.amount} ELSE 0 END), 0)`,
          released: sql<string>`COALESCE(SUM(CASE WHEN ${deliveryLedgerEntries.entryType} = 'COD_RELEASED' THEN ${deliveryLedgerEntries.amount} ELSE 0 END), 0)`,
          writtenOff: sql<string>`COALESCE(SUM(CASE WHEN ${deliveryLedgerEntries.entryType} = 'COD_WRITTEN_OFF' THEN ${deliveryLedgerEntries.amount} ELSE 0 END), 0)`,
          feeEarned: sql<string>`COALESCE(SUM(CASE WHEN ${deliveryLedgerEntries.entryType} = 'FEE_EARNED' THEN ${deliveryLedgerEntries.amount} WHEN ${deliveryLedgerEntries.entryType} = 'FEE_REFUNDED' THEN -${deliveryLedgerEntries.amount} ELSE 0 END), 0)`,
          feePaid: sql<string>`COALESCE(SUM(CASE WHEN ${deliveryLedgerEntries.entryType} IN ('FEE_PAID','FEE_OFFSET') THEN ${deliveryLedgerEntries.amount} ELSE 0 END), 0)`,
        })
        .from(deliveryLedgerEntries)
        .where(eq(deliveryLedgerEntries.consignmentId, Number(consignment.id)))
    )[0];
    const assigned = round2(money(ledger?.assigned ?? "0"));
    const collected = round2(money(ledger?.collected ?? "0"));
    const codOutstanding = round2(assigned.minus(collected).minus(money(ledger?.released ?? "0")));
    const cashInCustody = round2(collected.minus(money(ledger?.remitted ?? "0")).minus(money(ledger?.writtenOff ?? "0")));
    const feeOpen = round2(money(ledger?.feeEarned ?? "0").minus(money(ledger?.feePaid ?? "0")));
    const codAmount = round2(money(consignment.codAmount ?? "0"));
    const unsafeFinancialState =
      !round2(money(consignment.collectedAmount ?? "0")).isZero()
      || !round2(money(consignment.counterSettledAmount ?? "0")).isZero()
      || consignment.remittanceId != null
      || consignment.custodyRecognizedAt != null
      || consignment.returnDeclaredAt != null
      || consignment.feeSettledAt != null
      || !codOutstanding.isZero()
      || !cashInCustody.isZero()
      || !feeOpen.isZero()
      || (codAmount.gt(0) && assigned.lt(codAmount));
    if (unsafeFinancialState) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `الإرسالية ${consignment.consignmentNumber} ملغاة تشغيلياً، لكن عليها تحصيل أو عهدة أو أثر مالي مفتوح. سوِّ COD/التوريد من مركز التوصيل قبل إلغاء الفاتورة.`,
      });
    }
  }

  if (onlineOrder) {
    if (onlineOrder.branchId != null && Number(onlineOrder.branchId) !== Number(input.expectedBranchId)) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "فرع طلب المتجر لا يطابق فرع الفاتورة — أصلح الربط قبل الإلغاء",
      });
    }

    const linkedToSafeConsignment = consignment != null
      && consignment.sourceType === "ONLINE_ORDER"
      && Number(consignment.sourceId) === Number(onlineOrder.id);
    const safeOrderStatus = onlineOrder.status === "CANCELLED"
      || (linkedToSafeConsignment && onlineOrder.status === "SHIPPED");
    if (!safeOrderStatus) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: onlineOrder.status === "SHIPPED"
          ? `طلب المتجر ${onlineOrder.orderNumber} ما زال قيد التوصيل. استعمل «تعذّر التسليم» أو ألغِ الإرسالية من مركز التوصيل أولاً.`
          : `طلب المتجر ${onlineOrder.orderNumber} ليس في حالة إلغاء توصيل نهائية آمنة (${onlineOrder.status}). أغلق مسار الطلب أولاً.`,
      });
    }

    // توافق الإرث: تحصيل المتجر القديم بلا consignmentId؛ وجوده يعني أن النقد مرّ بعهدة مندوب
    // حتى لو عُدّلت حالة الطلب لاحقاً إلى CANCELLED يدوياً.
    const legacyCod = (
      await tx
        .select({ n: sql<number>`COUNT(*)` })
        .from(deliveryLedgerEntries)
        .where(and(
          like(deliveryLedgerEntries.eventKey, `ONLINE:${Number(onlineOrder.id)}:%`),
          inArray(deliveryLedgerEntries.entryType, ["COD_COLLECTED", "COD_REMITTED", "COD_WRITTEN_OFF", "COD_RECOVERED"]),
        ))
    )[0];
    const legacyCustodyPosting = (
      await tx
        .select({ n: sql<number>`COUNT(*)` })
        .from(accountingEntries)
        .where(and(
          eq(accountingEntries.invoiceId, input.invoiceId),
          eq(accountingEntries.entryType, "DELIVERY_DISPATCH"),
          isNotNull(accountingEntries.deliveryPartyId),
        ))
    )[0];
    if (Number(legacyCod?.n ?? 0) > 0 || Number(legacyCustodyPosting?.n ?? 0) > 0) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `طلب المتجر ${onlineOrder.orderNumber} ملغى، لكنه يحمل تحصيل COD أو عهدة مندوب سابقة. سوِّ العهدة من مركز التوصيل واستعمل مسار الإرجاع الموثق.`,
      });
    }
  }

  return {
    consignmentId: consignment == null ? null : Number(consignment.id),
    onlineOrderId: onlineOrder == null ? null : Number(onlineOrder.id),
  };
}
