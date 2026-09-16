import { and, eq, or, sql } from "drizzle-orm";
import { stripDocPrefix } from "@shared/documentNumber";
import {
  customers,
  deliveryConsignments,
  digitalSaleDetails,
  installmentPlans,
  invoiceItems,
  invoices,
  onlineOrders,
  shifts,
  users,
} from "../../../drizzle/schema";
import { getDb } from "../../db";
import type { Tx } from "../../db";
import type { Actor } from "../tx";

export interface CorrectionLookupFacts {
  status: string;
  sourceType: string;
  returnedTotal: string | number | null;
  correctedByInvoiceId: number | null;
  itemCount: number;
  hasDigitalCards: boolean;
  hasActiveInstallmentPlan: boolean;
  consignmentStatus: string | null;
  consignmentParcelStatus: string | null;
  consignmentMoneyStatus: string | null;
  onlineOrderStatus: string | null;
}

/** تحذير تمهيدي فقط؛ محرك التصحيح يعيد جميع الحراس تحت الأقفال وقت الاعتماد. */
export function correctionLookupBlockReason(facts: CorrectionLookupFacts): string | null {
  if (["CANCELLED", "RETURNED", "SUPERSEDED"].includes(facts.status)) {
    return "الفاتورة ملغاة أو مرتجعة أو استُبدلت بتعديل سابق";
  }
  if (facts.correctedByInvoiceId != null) return "لهذه الفاتورة نسخة معدلة بالفعل";
  if (facts.sourceType === "WORKORDER") return "فاتورة أمر الشغل تُعدّل من مسار أمر الشغل";
  if (Number(facts.returnedTotal ?? 0) > 0) return "على الفاتورة مرتجع سابق؛ عالجها من شاشة المرتجعات";
  if (facts.itemCount < 1) return "الفاتورة بلا بنود قابلة للتعديل";
  if (facts.hasDigitalCards) return "الفاتورة تحتوي بطاقات رقمية؛ استخدم مسار عكس البطاقات";
  if (facts.hasActiveInstallmentPlan) return "الفاتورة مرتبطة بخطة أقساط نشطة";
  if (facts.consignmentStatus != null) {
    const cancelledSafely = facts.consignmentStatus === "CANCELLED"
      && facts.consignmentParcelStatus === "CANCELLED"
      && facts.consignmentMoneyStatus === "CANCELLED";
    if (!cancelledSafely) return "ألغِ إسناد التوصيل وسوِّ عهدته قبل تعديل الفاتورة";
  }
  if (facts.onlineOrderStatus != null && facts.onlineOrderStatus !== "CANCELLED") {
    return "ألغِ طلب المتجر المرتبط قبل تعديل الفاتورة";
  }
  return null;
}

/**
 * يعيد تطبيق بوابة الأهلية نفسها داخل معاملة إنشاء طلب الاعتماد. شاشة المسح تمهيدية، أما
 * هذه القراءة فهي التي تمنع حجز activeInvoiceId بطلبٍ سيسقط حتماً عند الاعتماد.
 */
export async function correctionRequestBlockReasonTx(
  tx: Tx,
  invoice: Pick<
    typeof invoices.$inferSelect,
    "id" | "status" | "sourceType" | "returnedTotal" | "correctedByInvoiceId"
  >,
): Promise<string | null> {
  const related = (
    await tx
      .select({
        itemCount: sql<number>`(SELECT COUNT(*) FROM ${invoiceItems} ii WHERE ii.invoiceId = ${invoices.id})`,
        hasDigitalCards: sql<number>`EXISTS(SELECT 1 FROM ${digitalSaleDetails} dsd WHERE dsd.invoiceId = ${invoices.id})`,
        hasActiveInstallmentPlan: sql<number>`EXISTS(SELECT 1 FROM ${installmentPlans} ip WHERE ip.invoiceId = ${invoices.id} AND ip.planStatus = 'ACTIVE')`,
        consignmentStatus: deliveryConsignments.status,
        consignmentParcelStatus: deliveryConsignments.parcelStatus,
        consignmentMoneyStatus: deliveryConsignments.moneyStatus,
        onlineOrderStatus: onlineOrders.status,
      })
      .from(invoices)
      .leftJoin(deliveryConsignments, eq(deliveryConsignments.invoiceId, invoices.id))
      .leftJoin(onlineOrders, eq(onlineOrders.invoiceId, invoices.id))
      .where(eq(invoices.id, Number(invoice.id)))
      .limit(1)
  )[0];

  return correctionLookupBlockReason({
    status: invoice.status,
    sourceType: invoice.sourceType,
    returnedTotal: invoice.returnedTotal,
    correctedByInvoiceId: invoice.correctedByInvoiceId == null
      ? null
      : Number(invoice.correctedByInvoiceId),
    itemCount: Number(related?.itemCount ?? 0),
    hasDigitalCards: Number(related?.hasDigitalCards ?? 0) === 1,
    hasActiveInstallmentPlan: Number(related?.hasActiveInstallmentPlan ?? 0) === 1,
    consignmentStatus: related?.consignmentStatus ?? null,
    consignmentParcelStatus: related?.consignmentParcelStatus ?? null,
    consignmentMoneyStatus: related?.consignmentMoneyStatus ?? null,
    onlineOrderStatus: related?.onlineOrderStatus ?? null,
  });
}

/** مطابقة تامة للرقم الممسوح؛ لا تستعمل بحث الطلبات الغامض ولا تكشف فروعاً أخرى. */
export async function lookupInvoiceForCorrection(
  rawNumber: string,
  actor: Actor & {
    role?: string;
    scopedOwnerId?: number | null;
    invoiceScope?: "sales" | "reception";
  },
) {
  const db = getDb();
  if (!db) return null;
  const raw = rawNumber.trim();
  const number = stripDocPrefix(raw);
  const row = (
    await db
      .select({
        id: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        invoiceDate: invoices.invoiceDate,
        updatedAt: invoices.updatedAt,
        branchId: invoices.branchId,
        sourceType: invoices.sourceType,
        status: invoices.status,
        total: invoices.total,
        paidAmount: invoices.paidAmount,
        returnedTotal: invoices.returnedTotal,
        paymentMethod: invoices.paymentMethod,
        customerName: sql<string | null>`COALESCE(${customers.name}, NULLIF(${invoices.contactName}, ''), NULLIF(${deliveryConsignments.recipientName}, ''))`,
        customerPhone: sql<string | null>`COALESCE(NULLIF(${customers.whatsapp}, ''), NULLIF(${customers.phone}, ''), NULLIF(${invoices.contactPhone}, ''), NULLIF(${deliveryConsignments.recipientPhone}, ''))`,
        salespersonName: sql<string | null>`COALESCE(${invoices.salespersonNameSnapshot}, ${users.name})`,
        shiftType: shifts.shiftType,
        correctedByInvoiceId: invoices.correctedByInvoiceId,
        itemCount: sql<number>`(SELECT COUNT(*) FROM ${invoiceItems} ii WHERE ii.invoiceId = ${invoices.id})`,
        consignmentNumber: deliveryConsignments.consignmentNumber,
        consignmentStatus: deliveryConsignments.status,
        consignmentParcelStatus: deliveryConsignments.parcelStatus,
        consignmentMoneyStatus: deliveryConsignments.moneyStatus,
        onlineOrderStatus: onlineOrders.status,
      })
      .from(invoices)
      .leftJoin(customers, eq(customers.id, invoices.customerId))
      .leftJoin(users, eq(users.id, invoices.createdBy))
      .leftJoin(shifts, eq(shifts.id, invoices.shiftId))
      .leftJoin(deliveryConsignments, eq(deliveryConsignments.invoiceId, invoices.id))
      .leftJoin(onlineOrders, eq(onlineOrders.invoiceId, invoices.id))
      .where(and(
        actor.role === "admin" ? undefined : eq(invoices.branchId, actor.branchId),
        actor.scopedOwnerId == null ? undefined : eq(invoices.createdBy, actor.scopedOwnerId),
        actor.invoiceScope === "reception" ? eq(shifts.shiftType, "RECEPTION") : undefined,
        or(
          eq(invoices.invoiceNumber, number),
          eq(invoices.invoiceNumber, raw),
          eq(invoices.offlineReceiptNumber, raw),
        ),
      ))
      .limit(1)
  )[0];
  if (!row) return null;

  const [digital, activePlan] = await Promise.all([
    db.select({ id: digitalSaleDetails.id }).from(digitalSaleDetails)
      .where(eq(digitalSaleDetails.invoiceId, Number(row.id))).limit(1),
    db.select({ id: installmentPlans.id }).from(installmentPlans)
      .where(and(
        eq(installmentPlans.invoiceId, Number(row.id)),
        eq(installmentPlans.status, "ACTIVE"),
      )).limit(1),
  ]);
  const blockReason = correctionLookupBlockReason({
    status: row.status,
    sourceType: row.sourceType,
    returnedTotal: row.returnedTotal,
    correctedByInvoiceId: row.correctedByInvoiceId == null ? null : Number(row.correctedByInvoiceId),
    itemCount: Number(row.itemCount),
    hasDigitalCards: digital.length > 0,
    hasActiveInstallmentPlan: activePlan.length > 0,
    consignmentStatus: row.consignmentStatus,
    consignmentParcelStatus: row.consignmentParcelStatus,
    consignmentMoneyStatus: row.consignmentMoneyStatus,
    onlineOrderStatus: row.onlineOrderStatus,
  });
  return { ...row, itemCount: Number(row.itemCount), canCorrect: blockReason == null, blockReason };
}
