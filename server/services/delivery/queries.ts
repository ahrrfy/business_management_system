// قراءات الشاشة: الجاهز للإرسال، الإرساليات المفتوحة/كاملة، كشف حساب جهة.
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { accountingEntries, customers, deliveryConsignments, deliveryParties, invoices, shifts, workOrders } from "../../../drizzle/schema";
import { getDb } from "../../db";

/** أوامر الشغل الجاهزة (READY) القابلة للإرسال عبر مندوب — تبويب «جاهز للإرسال». */
export async function listReadyForDispatch(branchId: number | null) {
  const db = getDb();
  if (!db) return [];
  // هذه شاشة «الإرسال للتوصيل» فقط؛ الاستلام المباشر يبقى في طابور خدمة العملاء
  // ولا يجوز أن يظهر هنا كأنه شحنة قابلة للإسناد.
  const conds = [eq(workOrders.status, "READY"), eq(workOrders.hasDelivery, true)];
  if (branchId != null) conds.push(eq(workOrders.branchId, branchId));
  return db
    .select({
      id: workOrders.id,
      orderNumber: workOrders.orderNumber,
      title: workOrders.title,
      quantity: workOrders.quantity,
      salePrice: workOrders.salePrice,
      deposit: workOrders.deposit,
      branchId: workOrders.branchId,
      customerId: workOrders.customerId,
      customerName: customers.name,
      customerPhone: customers.phone,
      deliveryAddress: workOrders.deliveryAddress,
      deliveryPhone: workOrders.deliveryPhone,
      hasDelivery: workOrders.hasDelivery,
      dueDate: workOrders.dueDate,
    })
    .from(workOrders)
    .leftJoin(customers, eq(workOrders.customerId, customers.id))
    .where(and(...conds))
    .orderBy(desc(workOrders.id))
    .limit(200);
}

/** الإرساليات المفتوحة (DISPATCHED/PARTIAL) لجهة — لشاشة التسوية. */
export async function listOpenConsignments(partyId: number) {
  const db = getDb();
  if (!db) return [];
  return db
    .select({
      id: deliveryConsignments.id,
      consignmentNumber: deliveryConsignments.consignmentNumber,
      invoiceId: deliveryConsignments.invoiceId,
      invoiceNumber: invoices.invoiceNumber,
      codAmount: deliveryConsignments.codAmount,
      collectedAmount: deliveryConsignments.collectedAmount,
      deliveryFee: deliveryConsignments.deliveryFee,
      status: deliveryConsignments.status,
      endCustomerId: deliveryConsignments.endCustomerId,
      customerName: customers.name,
      recipientName: deliveryConsignments.recipientName,
      dispatchedAt: deliveryConsignments.dispatchedAt,
    })
    .from(deliveryConsignments)
    .leftJoin(invoices, eq(deliveryConsignments.invoiceId, invoices.id))
    .leftJoin(customers, eq(deliveryConsignments.endCustomerId, customers.id))
    .where(and(eq(deliveryConsignments.partyId, partyId), sql`${deliveryConsignments.status} IN ('DISPATCHED','PARTIAL')`))
    .orderBy(deliveryConsignments.dispatchedAt);
}

/** كل إرساليات جهة (تبويب «قيد التوصيل» / تفاصيل الجهة). */
export async function listConsignmentsForParty(partyId: number, openOnly = false) {
  const db = getDb();
  if (!db) return [];
  const conds = [eq(deliveryConsignments.partyId, partyId)];
  if (openOnly) conds.push(sql`${deliveryConsignments.status} IN ('DISPATCHED','PARTIAL')`);
  return db.select().from(deliveryConsignments).where(and(...conds)).orderBy(desc(deliveryConsignments.id)).limit(300);
}

/** كشف حساب جهة توصيل: قيود العهدة (DISPATCH مدين، REMIT/WRITEOFF دائن) + أجور (FEE). */
export async function getDeliveryPartyStatement(partyId: number, from?: string, to?: string) {
  const db = getDb();
  if (!db) return null;
  const party = (await db.select().from(deliveryParties).where(eq(deliveryParties.id, partyId)).limit(1))[0];
  if (!party) return null;
  const conds = [
    eq(accountingEntries.deliveryPartyId, partyId),
    sql`${accountingEntries.entryType} IN ('DELIVERY_DISPATCH','DELIVERY_REMIT','DELIVERY_WRITEOFF','DELIVERY_FEE')`,
  ];
  if (from) conds.push(sql`${accountingEntries.entryDate} >= ${from}`);
  if (to) conds.push(sql`${accountingEntries.entryDate} <= ${to}`);
  const entries = await db
    .select({
      id: accountingEntries.id,
      type: accountingEntries.entryType,
      amount: accountingEntries.amount,
      entryDate: accountingEntries.entryDate,
      notes: accountingEntries.notes,
    })
    .from(accountingEntries)
    .where(and(...conds))
    .orderBy(accountingEntries.id);
  return {
    party: { name: party.name, partyType: party.partyType, phone: party.phone },
    currentBalance: party.currentBalance,
    entries,
  };
}

/**
 * ٥/٨ — طابور فواتير الاستقبال: **كل** فاتورةٍ أنشأها الموظّف في وردية استقبالٍ مفتوحة/اليوم،
 * لا أوامر الشغل وحدها. كان الطابور مصدرُه جدول `workOrders` حصراً، فالبيع المباشر (منتجات
 * جاهزة/خدمات طباعة بلا تخصيص) لا يُنتج صفّاً فيه إطلاقاً ⇒ لا سبيل لإسناده للتوصيل بعد إتمامه.
 *
 * المصدر: `invoices` مقيَّدةً بورديات RECEPTION، مع LEFT JOIN على الإرسالية (فريدة لكل فاتورة
 * بقيد uq_consignment_invoice) وعلى أمر الشغل (إن كانت الفاتورة صادرةً عن أمر شغل) ⇒ صفٌّ واحد
 * لكل فاتورة يحمل حالتها التسليمية. الفلترة على invoices.shiftId (مفهرَس) ثم على نوع الوردية.
 */
export async function listReceptionInvoiceQueue(input: {
  branchId: number;
  /** ورديات بعينها (الوردية المفتوحة عادةً). فارغة ⇒ كل ورديات الاستقبال منذ `since`. */
  shiftIds?: number[];
  since?: Date;
  limit?: number;
}) {
  const db = getDb();
  if (!db) return [];
  const conds = [eq(invoices.branchId, input.branchId), eq(shifts.shiftType, "RECEPTION")];
  if (input.shiftIds && input.shiftIds.length > 0) {
    conds.push(inArray(invoices.shiftId, input.shiftIds));
  } else if (input.since) {
    conds.push(gte(invoices.invoiceDate, input.since));
  }
  return db
    .select({
      invoiceId: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      invoiceDate: invoices.invoiceDate,
      total: invoices.total,
      paidAmount: invoices.paidAmount,
      status: invoices.status,
      customerId: invoices.customerId,
      customerName: customers.name,
      customerPhone: customers.phone,
      // مرجع الزبون العابر (بلا سجلّ عميل) — يُستعمل مستلِماً عند الإسناد للتوصيل.
      contactName: invoices.contactName,
      contactPhone: invoices.contactPhone,
      createdBy: invoices.createdBy,
      shiftId: invoices.shiftId,
      workOrderId: workOrders.id,
      workOrderNumber: workOrders.orderNumber,
      workOrderStatus: workOrders.status,
      hasDelivery: workOrders.hasDelivery,
      deliveryAddress: workOrders.deliveryAddress,
      deliveryPhone: workOrders.deliveryPhone,
      consignmentId: deliveryConsignments.id,
      consignmentNumber: deliveryConsignments.consignmentNumber,
      consignmentStatus: deliveryConsignments.status,
      consignmentCod: deliveryConsignments.codAmount,
      partyName: deliveryParties.name,
    })
    .from(invoices)
    .innerJoin(shifts, eq(shifts.id, invoices.shiftId))
    .leftJoin(customers, eq(customers.id, invoices.customerId))
    .leftJoin(workOrders, eq(workOrders.invoiceId, invoices.id))
    .leftJoin(deliveryConsignments, eq(deliveryConsignments.invoiceId, invoices.id))
    .leftJoin(deliveryParties, eq(deliveryParties.id, deliveryConsignments.partyId))
    .where(and(...conds))
    .orderBy(desc(invoices.id))
    .limit(input.limit ?? 200);
}
