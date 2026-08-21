// قراءات الشاشة: الجاهز للإرسال، الإرساليات المفتوحة/كاملة، سجل التوريدات، كشف حساب جهة.
//
// عزل الفرع: الجهة المشتركة مرئية للفروع، لكن سند التوريد ونقد الدرج يخصان فرعاً واحداً حتماً؛
// لذلك قائمة «المفتوح للتوريد» تقبل branchId وتعرض فقط طرود ذلك الفرع. أما السجل الإداري العام
// للجهة فيبقى عابراً للفروع لمن يملك صلاحية رؤيتها، وتبقى كل حركة موسومة بفرعها.
import { and, desc, eq, gte, lte, or, sql } from "drizzle-orm";
import { accountingEntries, customers, deliveryConsignments, deliveryEvents, deliveryLedgerEntries, deliveryParties, deliveryRemittanceLines, deliveryRemittances, invoices, onlineOrders, users, workOrders } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { getDeliveryFinancialSummary } from "./lifecycle";

/** أوامر الشغل الجاهزة (READY) القابلة للإرسال عبر مندوب — تبويب «جاهز للإرسال». */
export async function listReadyForDispatch(branchId: number | null) {
  const db = getDb();
  if (!db) return [];
  // هذه شاشة «الإرسال للتوصيل» فقط؛ الاستلام المباشر يبقى في طابور خدمة العملاء
  // ولا يجوز أن يظهر هنا كأنه شحنة قابلة للإسناد.
  const conds = [
    eq(workOrders.status, "READY"),
    eq(workOrders.hasDelivery, true),
    // ١٨/٨ (بلاغ المالك): الاستبعاد يخصّ الإرسالية **الحيّة** وحدها. كان `NOT EXISTS` غير
    // مقيَّد بالحالة ⇒ إرساليةٌ ألغاها المدير (أو أُرجعت) تُسقط الأمر من هذا الطابور **إلى
    // الأبد**: لا يظهر للإسناد ثانيةً ولا يُغلق — يعلق `READY` بلا مخرج.
    sql`NOT EXISTS (
      SELECT 1 FROM deliveryConsignments dc
      WHERE dc.workOrderId = ${workOrders.id}
        AND dc.consignmentStatus NOT IN ('CANCELLED', 'RETURNED')
    )`,
  ];
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
    .orderBy(desc(workOrders.id));
}

/** التزامات الجهة القابلة لإجراء موظف: COD مُسلّم للتوريد، طرد غير محصّل للإرجاع، أو أجرة مستحقة للدفع.
 * أهلية كل إجراء مستقلة؛ ظهور الطرد هنا لا يجعله قابلاً للتوريد قبل DELIVERED. */
export async function listOpenConsignments(partyId: number, branchId?: number | null) {
  const db = getDb();
  if (!db) return [];
  const feeDue = sql<string>`GREATEST(COALESCE((
    SELECT SUM(CASE
      WHEN ${deliveryLedgerEntries.entryType} = 'FEE_EARNED' THEN ${deliveryLedgerEntries.amount}
      WHEN ${deliveryLedgerEntries.entryType} = 'FEE_REFUNDED' THEN -${deliveryLedgerEntries.amount}
      WHEN ${deliveryLedgerEntries.entryType} IN ('FEE_PAID','FEE_OFFSET') THEN -${deliveryLedgerEntries.amount}
      ELSE 0 END)
    FROM ${deliveryLedgerEntries}
    WHERE ${deliveryLedgerEntries.consignmentId} = ${deliveryConsignments.id}
  ),0),0)`;
  const remittable = and(
    eq(deliveryConsignments.parcelStatus, "DELIVERED"),
    sql`${deliveryConsignments.moneyStatus} IN ('UNSETTLED','PARTIAL')`,
  );
  const returnable = and(
    eq(deliveryConsignments.status, "DISPATCHED"),
    sql`${deliveryConsignments.parcelStatus} IN ('ASSIGNED','FAILED')`,
    sql`${deliveryConsignments.moneyStatus} IN ('NOT_APPLICABLE','UNSETTLED')`,
    sql`CAST(${deliveryConsignments.collectedAmount} AS DECIMAL(15,2)) = 0`,
  );
  const unpaidFee = and(
    eq(deliveryConsignments.parcelStatus, "DELIVERED"),
    sql`${feeDue} > 0`,
  );
  return db
    .select({
      id: deliveryConsignments.id,
      consignmentNumber: deliveryConsignments.consignmentNumber,
      invoiceId: deliveryConsignments.invoiceId,
      invoiceNumber: invoices.invoiceNumber,
      codAmount: deliveryConsignments.codAmount,
      collectedAmount: deliveryConsignments.collectedAmount,
      deliveryFee: deliveryConsignments.deliveryFee,
      feeDue,
      feeCollection: deliveryConsignments.feeCollection,
      feeSettledAt: deliveryConsignments.feeSettledAt,
      courierDeliveredAt: deliveryConsignments.courierDeliveredAt,
      parcelStatus: deliveryConsignments.parcelStatus,
      moneyStatus: deliveryConsignments.moneyStatus,
      status: deliveryConsignments.status,
      endCustomerId: deliveryConsignments.endCustomerId,
      customerName: customers.name,
      recipientName: deliveryConsignments.recipientName,
      dispatchedAt: deliveryConsignments.dispatchedAt,
    })
    .from(deliveryConsignments)
    .leftJoin(invoices, eq(deliveryConsignments.invoiceId, invoices.id))
    .leftJoin(customers, eq(deliveryConsignments.endCustomerId, customers.id))
    .where(and(
      eq(deliveryConsignments.partyId, partyId),
      or(remittable, returnable, unpaidFee),
      branchId == null ? undefined : eq(deliveryConsignments.branchId, branchId),
    ))
    .orderBy(deliveryConsignments.dispatchedAt);
}

/**
 * **الطرود بالطريق** — تبويب «قيد التوصيل» (بلاغ المالك ١٨/٨: «الطلبات المُسنَدة للمندوب لا
 * تظهر في شاشة التوصيل ولا أيّ شاشة أخرى»).
 *
 * الثقب الذي تسدّه: بين لحظة الإسناد ولحظة إثبات التسليم، الطرد يعيش في
 * `parcelStatus ∈ (ASSIGNED, ACCEPTED, PICKED_UP, OUT_FOR_DELIVERY, FAILED)` — وهي حالةٌ **لا
 * تطابقها أيّ قائمة تشغيلية**: خرج من «جاهز للإرسال» (له إرسالية)، وليس في «تسوية المناديب»
 * (فروعها الثلاثة تشترط DELIVERED أو صفر تحصيل)، ولا وسمَ له في الكانبان (الأمر ما زال READY).
 *
 * الشرط هنا **حالة الإغلاق وحدها** (`consignmentStatus = 'DISPATCHED'`) لا أهليّةُ إجراءٍ ماليّ:
 * هذه شاشة «أين طردي» لا شاشة «ماذا أستطيع أن أفعل به».
 */
export async function listInTransitConsignments(branchId: number | null, partyId?: number | null) {
  const db = getDb();
  if (!db) return [];
  const conds = [eq(deliveryConsignments.status, "DISPATCHED")];
  if (branchId != null) conds.push(eq(deliveryConsignments.branchId, branchId));
  if (partyId != null) conds.push(eq(deliveryConsignments.partyId, partyId));
  return db
    .select({
      id: deliveryConsignments.id,
      consignmentNumber: deliveryConsignments.consignmentNumber,
      invoiceId: deliveryConsignments.invoiceId,
      invoiceNumber: invoices.invoiceNumber,
      workOrderId: deliveryConsignments.workOrderId,
      orderNumber: workOrders.orderNumber,
      /**
       * مصدر الطرد (١٩/٨، طلب المالك) — الاستعلام محايدُ المصدر أصلاً (كل إرسالية
       * `DISPATCHED`)، فطلبُ المتجر المُسنَد لشركةٍ يظهر هنا كما يظهر أمرُ الشغل. لكنّ الصفّ
       * كان **لا يقول أيَّهما**: `orderNumber` يبقى NULL لطلب المتجر فيبدو الطرد بلا هويّة.
       * والعمود موجودٌ على الجدول ولم يكن يُسقَط.
       */
      sourceType: deliveryConsignments.sourceType,
      sourceId: deliveryConsignments.sourceId,
      partyId: deliveryConsignments.partyId,
      partyName: deliveryParties.name,
      assignedUserId: deliveryConsignments.assignedUserId,
      driverName: users.name,
      parcelStatus: deliveryConsignments.parcelStatus,
      moneyStatus: deliveryConsignments.moneyStatus,
      codAmount: deliveryConsignments.codAmount,
      collectedAmount: deliveryConsignments.collectedAmount,
      /** المتبقّي تحصيله على هذا الطرد — التعرّض الفعليّ الظاهر للإدارة لحظةً بلحظة. */
      codDue: sql<string>`GREATEST(CAST(${deliveryConsignments.codAmount} AS DECIMAL(15,2)) - CAST(${deliveryConsignments.collectedAmount} AS DECIMAL(15,2)), 0)`,
      recipientName: deliveryConsignments.recipientName,
      recipientPhone: deliveryConsignments.recipientPhone,
      // عنوان التسليم يعيش على أمر الشغل (لا عمود له على الإرسالية).
      address: workOrders.deliveryAddress,
      customerName: customers.name,
      dispatchedAt: deliveryConsignments.dispatchedAt,
      failureReason: deliveryConsignments.failureReason,
      /**
       * **رجوعٌ مُعلَن** (0246): الشركةُ أعلنت أنّ الطرد راجعٌ ولم يصل بعد. تعرّضُه حُرِّر
       * سلفاً، وينتظر الاستلامَ والفحص — فيُميَّز في الطابور عن الطرد الذي ما زال يُحاوَل.
       */
      returnDeclaredAt: deliveryConsignments.returnDeclaredAt,
      returnDeclaredReason: deliveryConsignments.returnDeclaredReason,
      /** عمر الطرد بالساعات — أساس «أعمار الطرود» وتحديد المتعثّر بلا تقريرٍ منفصل. */
      ageHours: sql<number>`TIMESTAMPDIFF(HOUR, ${deliveryConsignments.dispatchedAt}, NOW())`,
    })
    .from(deliveryConsignments)
    .leftJoin(invoices, eq(deliveryConsignments.invoiceId, invoices.id))
    .leftJoin(workOrders, eq(deliveryConsignments.workOrderId, workOrders.id))
    .leftJoin(deliveryParties, eq(deliveryParties.id, deliveryConsignments.partyId))
    .leftJoin(users, eq(users.id, deliveryConsignments.assignedUserId))
    .leftJoin(customers, eq(deliveryConsignments.endCustomerId, customers.id))
    .where(and(...conds))
    .orderBy(deliveryConsignments.dispatchedAt);
}

/** كل إرساليات جهة (تبويب «إرساليات الجهة» في شاشة التفاصيل) — بأرقام فواتيرها وتوريداتها. */
export async function listConsignmentsForParty(partyId: number, openOnly = false) {
  const db = getDb();
  if (!db) return [];
  const conds = [eq(deliveryConsignments.partyId, partyId)];
  if (openOnly) conds.push(sql`${deliveryConsignments.parcelStatus} NOT IN ('DELIVERED','RETURNED','CANCELLED') OR ${deliveryConsignments.moneyStatus} IN ('UNSETTLED','PARTIAL')`);
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
      parcelStatus: deliveryConsignments.parcelStatus,
      moneyStatus: deliveryConsignments.moneyStatus,
      assignedUserId: deliveryConsignments.assignedUserId,
      assignedUserName: users.name,
      failureReason: deliveryConsignments.failureReason,
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
    .leftJoin(users, eq(deliveryConsignments.assignedUserId, users.id))
    .where(and(...conds))
    .orderBy(desc(deliveryConsignments.id));
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

export async function getDeliveryPartyFinancials(partyId: number) {
  const db = getDb();
  if (!db) return null;
  const party = (await db.select({ id: deliveryParties.id, name: deliveryParties.name }).from(deliveryParties).where(eq(deliveryParties.id, partyId)).limit(1))[0];
  if (!party) return null;
  const [summary, ledger, allocations, events] = await Promise.all([
    getDeliveryFinancialSummary(partyId),
    db.select({
      id: deliveryLedgerEntries.id,
      eventKey: deliveryLedgerEntries.eventKey,
      consignmentId: deliveryLedgerEntries.consignmentId,
      remittanceId: deliveryLedgerEntries.remittanceId,
      branchId: deliveryLedgerEntries.branchId,
      entryType: deliveryLedgerEntries.entryType,
      amount: deliveryLedgerEntries.amount,
      notes: deliveryLedgerEntries.notes,
      occurredAt: deliveryLedgerEntries.occurredAt,
    }).from(deliveryLedgerEntries).where(eq(deliveryLedgerEntries.partyId, partyId)).orderBy(desc(deliveryLedgerEntries.id)).limit(300),
    db.select({
      id: deliveryRemittanceLines.id,
      remittanceId: deliveryRemittanceLines.remittanceId,
      remittanceNumber: deliveryRemittances.remittanceNumber,
      consignmentId: deliveryRemittanceLines.consignmentId,
      consignmentNumber: deliveryConsignments.consignmentNumber,
      grossApplied: deliveryRemittanceLines.grossApplied,
      feeOffset: deliveryRemittanceLines.feeOffset,
      cashReceived: deliveryRemittanceLines.cashReceived,
      writtenOffAmount: deliveryRemittanceLines.writtenOffAmount,
      createdAt: deliveryRemittanceLines.createdAt,
    }).from(deliveryRemittanceLines)
      .innerJoin(deliveryConsignments, eq(deliveryConsignments.id, deliveryRemittanceLines.consignmentId))
      .innerJoin(deliveryRemittances, eq(deliveryRemittances.id, deliveryRemittanceLines.remittanceId))
      .where(eq(deliveryConsignments.partyId, partyId))
      .orderBy(desc(deliveryRemittanceLines.id)).limit(300),
    db.select({
      id: deliveryEvents.id,
      consignmentId: deliveryEvents.consignmentId,
      eventType: deliveryEvents.eventType,
      fromParcelStatus: deliveryEvents.fromParcelStatus,
      toParcelStatus: deliveryEvents.toParcelStatus,
      fromMoneyStatus: deliveryEvents.fromMoneyStatus,
      toMoneyStatus: deliveryEvents.toMoneyStatus,
      occurredAt: deliveryEvents.occurredAt,
    }).from(deliveryEvents)
      .innerJoin(deliveryConsignments, eq(deliveryConsignments.id, deliveryEvents.consignmentId))
      .where(eq(deliveryConsignments.partyId, partyId))
      .orderBy(desc(deliveryEvents.id)).limit(300),
  ]);
  return { party, summary, ledger, allocations, events };
}

// ش١ (٥/٨): listReceptionInvoiceQueue انتقلت إلى server/services/reception/queries.ts
// (بترقيم keyset وفلاتر) — حُذفت هنا مع نقطة نهايتها (حارس check:orphans).
