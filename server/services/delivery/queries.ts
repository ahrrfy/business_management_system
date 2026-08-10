// قراءات الشاشة: الجاهز للإرسال، الإرساليات المفتوحة/كاملة، سجل التوريدات، كشف حساب جهة.
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { accountingEntries, customers, deliveryConsignments, deliveryParties, deliveryRemittances, invoices, onlineOrders, users, workOrders } from "../../../drizzle/schema";
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
      customerPhone: sql<string | null>`COALESCE(NULLIF(${customers.whatsapp}, ''), NULLIF(${workOrders.deliveryPhone}, ''), NULLIF(${customers.phone}, ''), NULLIF(${customers.phone2}, ''), NULLIF(${customers.phone3}, ''))`,
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

/** الإرساليات المفتوحة (DISPATCHED/PARTIAL) لجهة — لشاشة التسوية.
 *  ٩/٨: + feeCollection/feeSettledAt (الشاشة كانت تخصم كل الأجور فتحسب صافياً يخالف الخادم
 *  فتستحيل تسوية إرساليات COURIER/المصروفة سلفاً — طريق مسدود) + ختم تأكيد المندوب. */
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
      feeCollection: deliveryConsignments.feeCollection,
      feeSettledAt: deliveryConsignments.feeSettledAt,
      courierDeliveredAt: deliveryConsignments.courierDeliveredAt,
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

/** كل إرساليات جهة (تبويب «إرساليات الجهة» في شاشة التفاصيل) — بأرقام فواتيرها وتوريداتها. */
export async function listConsignmentsForParty(partyId: number, openOnly = false) {
  const db = getDb();
  if (!db) return [];
  const conds = [eq(deliveryConsignments.partyId, partyId)];
  if (openOnly) conds.push(sql`${deliveryConsignments.status} IN ('DISPATCHED','PARTIAL')`);
  return db
    .select({
      id: deliveryConsignments.id,
      consignmentNumber: deliveryConsignments.consignmentNumber,
      invoiceId: deliveryConsignments.invoiceId,
      invoiceNumber: invoices.invoiceNumber,
      invoiceStatus: invoices.status,
      codAmount: deliveryConsignments.codAmount,
      collectedAmount: deliveryConsignments.collectedAmount,
      deliveryFee: deliveryConsignments.deliveryFee,
      feeCollection: deliveryConsignments.feeCollection,
      status: deliveryConsignments.status,
      customerName: customers.name,
      recipientName: deliveryConsignments.recipientName,
      recipientPhone: deliveryConsignments.recipientPhone,
      dispatchedAt: deliveryConsignments.dispatchedAt,
      courierDeliveredAt: deliveryConsignments.courierDeliveredAt,
      settledAt: deliveryConsignments.settledAt,
      remittanceId: deliveryConsignments.remittanceId,
      remittanceNumber: deliveryRemittances.remittanceNumber,
    })
    .from(deliveryConsignments)
    .leftJoin(invoices, eq(deliveryConsignments.invoiceId, invoices.id))
    .leftJoin(customers, eq(deliveryConsignments.endCustomerId, customers.id))
    .leftJoin(deliveryRemittances, eq(deliveryConsignments.remittanceId, deliveryRemittances.id))
    .where(and(...conds))
    .orderBy(desc(deliveryConsignments.id))
    .limit(300);
}

/** سجل توريدات جهة (٩/٨): كان أثر التوريد الوحيد إيصالاً حرارياً يُطبع مرة واحدة — سلسلة
 *  invoice⇒consignment⇒remittance⇒receipt كاملة في القاعدة ومقطوعة في الشاشات. */
export async function listPartyRemittances(partyId: number, opts?: { from?: string; to?: string; limit?: number }) {
  const db = getDb();
  if (!db) return [];
  const conds = [eq(deliveryRemittances.partyId, partyId)];
  if (opts?.from) conds.push(gte(deliveryRemittances.receivedAt, new Date(`${opts.from}T00:00:00Z`)));
  if (opts?.to) conds.push(lte(deliveryRemittances.receivedAt, new Date(`${opts.to}T23:59:59Z`)));
  return db
    .select({
      id: deliveryRemittances.id,
      remittanceNumber: deliveryRemittances.remittanceNumber,
      branchId: deliveryRemittances.branchId,
      collectedTotal: deliveryRemittances.collectedTotal,
      feesTotal: deliveryRemittances.feesTotal,
      netRemitted: deliveryRemittances.netRemitted,
      shortfallTotal: deliveryRemittances.shortfallTotal,
      status: deliveryRemittances.status,
      receivedAt: deliveryRemittances.receivedAt,
      receivedByName: users.name,
      shiftId: deliveryRemittances.shiftId,
    })
    .from(deliveryRemittances)
    .leftJoin(users, eq(deliveryRemittances.receivedBy, users.id))
    .where(and(...conds))
    .orderBy(desc(deliveryRemittances.id))
    .limit(Math.min(opts?.limit ?? 100, 300));
}

/** طرود متجر «مع المندوب» (SHIPPED) لجهة — فجوة الرؤية بين القناتين (١٠/٨): عهدة المتجر
 *  تُرفَع عند تأكيد المندوب لا عند الإرسال، فما بيده من طرودٍ لم تُؤكَّد كان غير ظاهر في
 *  أي عهدة أو كشف. القيمة = متبقّي الفاتورة (البضاعة — بعد التمرير الكامل لا تشمل الأجرة). */
export async function getPartyStoreInTransit(partyId: number) {
  const db = getDb();
  if (!db) return { count: 0, value: "0.00" };
  const row = (
    await db
      .select({
        count: sql<number>`COUNT(*)`,
        value: sql<string>`COALESCE(SUM(GREATEST(CAST(${invoices.total} AS DECIMAL(15,2)) - CAST(${invoices.returnedTotal} AS DECIMAL(15,2)) - CAST(${invoices.paidAmount} AS DECIMAL(15,2)), 0)), 0)`,
      })
      .from(onlineOrders)
      .leftJoin(invoices, eq(onlineOrders.invoiceId, invoices.id))
      .where(and(eq(onlineOrders.deliveryPartyId, partyId), eq(onlineOrders.status, "SHIPPED")))
  )[0];
  return { count: Number(row?.count ?? 0), value: String(row?.value ?? "0.00") };
}

/** كشف حساب جهة توصيل: قيود العهدة (DISPATCH مدين، REMIT/WRITEOFF دائن) + أجور (FEE/FEE_HELD).
 *  ٩/٨: + رقم الفاتورة (كان المرجع يُستخرج من نص الملاحظات بـregex هشّ في الواجهة). */
export async function getDeliveryPartyStatement(partyId: number, from?: string, to?: string) {
  const db = getDb();
  if (!db) return null;
  const party = (await db.select().from(deliveryParties).where(eq(deliveryParties.id, partyId)).limit(1))[0];
  if (!party) return null;
  // ساقا أمانة الأجرة (مراجعة عدائية ٩/٨): قيدُ **القبض** يُكتب لحظة البيع قبل معرفة الجهة
  // (بلا deliveryPartyId) وقيدُ الصرف بعد الإسناد (به) — فلترةُ الجهة وحدها كانت تعرض الصرف
  // بلا قبضه ⇒ «أمانات معلّقة Σ» سالبةٌ متراكمة كاذبة. نضمّ قيود FEE_HELD لفواتير إرساليات
  // الجهة أيضاً (uq_consignment_invoice ⇒ الفاتورة لجهةٍ واحدة، لا ازدواج عبر الجهات).
  const conds = [
    sql`(
      (${accountingEntries.deliveryPartyId} = ${partyId}
        AND ${accountingEntries.entryType} IN ('DELIVERY_DISPATCH','DELIVERY_REMIT','DELIVERY_WRITEOFF','DELIVERY_FEE','DELIVERY_FEE_HELD'))
      OR (${accountingEntries.entryType} = 'DELIVERY_FEE_HELD'
        AND ${accountingEntries.deliveryPartyId} IS NULL
        AND ${accountingEntries.invoiceId} IN (SELECT dc.invoiceId FROM deliveryConsignments dc WHERE dc.partyId = ${partyId}))
    )`,
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
      invoiceId: accountingEntries.invoiceId,
      invoiceNumber: invoices.invoiceNumber,
      receiptId: accountingEntries.receiptId,
    })
    .from(accountingEntries)
    .leftJoin(invoices, eq(accountingEntries.invoiceId, invoices.id))
    .where(and(...conds))
    .orderBy(accountingEntries.id);
  return {
    party: { name: party.name, partyType: party.partyType, phone: party.phone },
    currentBalance: party.currentBalance,
    entries,
  };
}

// ش١ (٥/٨): listReceptionInvoiceQueue انتقلت إلى server/services/reception/queries.ts
// (بترقيم keyset وفلاتر) — حُذفت هنا مع نقطة نهايتها (حارس check:orphans).
