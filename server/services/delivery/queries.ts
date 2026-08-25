// قراءات الشاشة: الجاهز للإرسال، الإرساليات المفتوحة/كاملة، سجل التوريدات، كشف حساب جهة.
//
// عزل الفرع: الجهة المشتركة مرئية للفروع، لكن سند التوريد ونقد الدرج يخصان فرعاً واحداً حتماً؛
// لذلك قائمة «المفتوح للتوريد» تقبل branchId وتعرض فقط طرود ذلك الفرع. أما السجل الإداري العام
// للجهة فيبقى عابراً للفروع لمن يملك صلاحية رؤيتها، وتبقى كل حركة موسومة بفرعها.
import { and, asc, desc, eq, gt, gte, isNull, lt, lte, or, sql } from "drizzle-orm";
import { accountingEntries, customers, deliveryConsignments, deliveryEvents, deliveryLedgerEntries, deliveryParties, deliveryRemittanceLines, deliveryRemittances, invoices, onlineOrders, users, workOrders } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { money } from "../money";
import { getDeliveryFinancialSummary } from "./lifecycle";

/**
 * ⭐ Tier-2 #1 (٢٥/٨): ترقيمُ الصفحات لقوائم التوصيل — كانت الدوال أدناه تُحمّل الصفوف كلّها
 * بلا حدٍّ ⇒ عند ~١٠ آلاف صفٍّ يتجمّد الرأس (Dashboard/شاشة الجهة). الآن كلّ قائمةٍ تُعيد
 * `{ rows, hasMore, nextCursor }` بحدٍّ افتراضيّ ٢٠٠، مع مؤشرِ id لصفحاتٍ لاحقة.
 *
 * الاتّجاه: كل الدوال تُرتِّب DESC (الأحدث أوّلاً) ⇒ cursor = id الأصغر في الصفحة السابقة،
 * و`WHERE id < cursor` يجلب ما هو أقدم. عدّ الصفوف الكامل يُتجاوَز لأنّ hasMore يُشتقّ من
 * limit+1 حين يوجد cursor، ومن جلب دفعة واحدة حين لا يوجد.
 */
export interface DeliveryListPage { limit?: number; cursor?: number }
export interface DeliveryPagedResult<T> { rows: T[]; hasMore: boolean; nextCursor: number | null }

const DEFAULT_DELIVERY_LIST_LIMIT = 200;
const MAX_DELIVERY_LIST_LIMIT = 500;

function resolvePageLimit(limit?: number): number {
  const eff = limit ?? DEFAULT_DELIVERY_LIST_LIMIT;
  return Math.max(1, Math.min(MAX_DELIVERY_LIST_LIMIT, eff));
}

function buildPageResult<T extends { id: number | string }>(
  rows: T[],
  effLimit: number,
): DeliveryPagedResult<T> {
  const hasMore = rows.length > effLimit;
  const page = hasMore ? rows.slice(0, effLimit) : rows;
  const nextCursor = hasMore ? Number(page[page.length - 1]!.id) : null;
  return { rows: page, hasMore, nextCursor };
}

/**
 * هل للجهة بوّابة؟ عضويةٌ نشطة في deliveryPartyMembers أو ربطُ الحساب القديم
 * (deliveryParties.userId). القرار الذي يبنيه: مَن صاحبُ **الفعل التالي** للطرد — الجهةُ عبر
 * بوّابتها أم الموظّفُ عبر كشف الشركة (قلبُ قاموس `deriveConsignmentView` المشترك؛ الخلطُ
 * بينهما هو الذي ترك ٧٩ طرداً «مُسنَداً» جامداً بلا صاحبِ فعلٍ واضح). مرتبطٌ بعمود
 * partyId على الإرسالية فيصلح لكل استعلامٍ جذرُه deliveryConsignments.
 */
const partyHasPortalSql = sql<number>`(
  EXISTS (
    SELECT 1 FROM deliveryPartyMembers dpm
    WHERE dpm.partyId = ${deliveryConsignments.partyId} AND dpm.isActive = 1
  )
  OR EXISTS (
    SELECT 1 FROM deliveryParties dpp
    WHERE dpp.id = ${deliveryConsignments.partyId} AND dpp.userId IS NOT NULL
  )
)`;

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
export async function listOpenConsignments(partyId: number, branchId?: number | null, page: DeliveryListPage = {}) {
  const db = getDb();
  if (!db) return { rows: [], hasMore: false, nextCursor: null };
  const effLimit = resolvePageLimit(page.limit);
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
  // ⚠️ Codex P1 (٢٥/٨): الترتيبُ ASC (الأقدم أوّلاً) للحفاظ على منهج «سدّ الالتزامات المتأخّرة
  // أوّلاً» — الأصل كان `ORDER BY dispatchedAt` ASC. Keyset ASC ⇒ `WHERE id > cursor` + `ORDER BY id ASC`.
  const rows = await db
    .select({
      id: deliveryConsignments.id,
      consignmentNumber: deliveryConsignments.consignmentNumber,
      invoiceId: deliveryConsignments.invoiceId,
      invoiceNumber: invoices.invoiceNumber,
      codAmount: deliveryConsignments.codAmount,
      collectedAmount: deliveryConsignments.collectedAmount,
      /** ما سدّده الزبون بالكاونتر بعد ثبوت التسليم (0249) — الشاشة تعرض به المتبقّي الحيّ. */
      counterSettledAmount: deliveryConsignments.counterSettledAmount,
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
      /** للجهة بوّابة؟ — القاموس المشترك يميّز به «مُسنَد» عن «بانتظار كشف الشركة». */
      partyHasPortal: partyHasPortalSql,
    })
    .from(deliveryConsignments)
    .leftJoin(invoices, eq(deliveryConsignments.invoiceId, invoices.id))
    .leftJoin(customers, eq(deliveryConsignments.endCustomerId, customers.id))
    .where(and(
      eq(deliveryConsignments.partyId, partyId),
      or(remittable, returnable, unpaidFee),
      branchId == null ? undefined : eq(deliveryConsignments.branchId, branchId),
      page.cursor != null ? gt(deliveryConsignments.id, page.cursor) : undefined,
    ))
    .orderBy(asc(deliveryConsignments.id))
    .limit(effLimit + 1);
  return buildPageResult(rows.map((r) => ({ ...r, id: Number(r.id) })), effLimit);
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
export async function listInTransitConsignments(branchId: number | null, partyId?: number | null, page: DeliveryListPage = {}) {
  const db = getDb();
  if (!db) return { rows: [], hasMore: false, nextCursor: null };
  const effLimit = resolvePageLimit(page.limit);
  const conds = [eq(deliveryConsignments.status, "DISPATCHED")];
  if (branchId != null) conds.push(eq(deliveryConsignments.branchId, branchId));
  if (partyId != null) conds.push(eq(deliveryConsignments.partyId, partyId));
  // ⚠️ Codex P1 (٢٥/٨): «قيد التوصيل» ASC (الأقدم أوّلاً) — الأصل كان `ORDER BY dispatchedAt` ASC
  // (تنبيهُ الطرود المتأخّرة قبل الحديثة). Keyset ASC ⇒ cursor بـ`id > cursor`.
  if (page.cursor != null) conds.push(gt(deliveryConsignments.id, page.cursor));
  const rows = await db
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
      /** ما سدّده الزبون بالكاونتر بعد ثبوت التسليم (0249) — يُنقص المتبقّي بلا مساس بالعهدة. */
      counterSettledAmount: deliveryConsignments.counterSettledAmount,
      /** أجرة التوصيل — يستعملها محضر التسليم (Codex P2 #7 — ٢٢/٨). */
      deliveryFee: deliveryConsignments.deliveryFee,
      /** صافي مستند البيع للشاشة (الإجماليّ والمرتجع) — يُشتقّ منهما صافي الفاتورة بلا نداء ثانٍ. */
      invoiceTotal: invoices.total,
      invoiceReturnedTotal: invoices.returnedTotal,
      /**
       * المتبقّي تحصيله على هذا الطرد — التعرّض الفعليّ الظاهر للإدارة لحظةً بلحظة، بالصيغة
       * الحاكمة للمتبقّي الحيّ: codAmount − collectedAmount − counterSettledAmount (ما غطّاه
       * الكاونتر ليس بيد الجهة فلا يُعرَض تعرّضاً عليها).
       *
       * ⚠️ **والمُعلَنُ رجوعُه صفرٌ** (تصويب مراجعة Codex، ٢١/٨): تعرّضُه حُرِّر في الدفتر
       * بـ`COD_RELEASED` لحظةَ الإعلان، فإبقاؤه هنا يُضخّم «تعرّض التحصيل» في الشاشة
       * بمبلغٍ لم يعد مطلوباً — وتناقض الشاشةُ الدفترَ ورسالةَ التأكيد نفسها.
       */
      codDue: sql<string>`CASE WHEN ${deliveryConsignments.returnDeclaredAt} IS NOT NULL THEN 0 ELSE GREATEST(CAST(${deliveryConsignments.codAmount} AS DECIMAL(15,2)) - CAST(${deliveryConsignments.collectedAmount} AS DECIMAL(15,2)) - CAST(${deliveryConsignments.counterSettledAmount} AS DECIMAL(15,2)), 0) END`,
      recipientName: deliveryConsignments.recipientName,
      recipientPhone: deliveryConsignments.recipientPhone,
      // العنوان على الإرسالية أوّلاً (يُلقَط لحظة الإرسال وقد يُعدَّل عليها)، وأمرُ الشغل
      // احتياطٌ للصفوف القديمة التي أُنشئت قبل نسخه — لا العكس: التعليق السابق («لا عمود له
      // على الإرسالية») كان كاذباً منذ أُضيف العمود، فبقيت طرودُ المتجر والفواتير بلا عنوان.
      address: sql<string | null>`COALESCE(${deliveryConsignments.deliveryAddress}, ${workOrders.deliveryAddress})`,
      /** للجهة بوّابة؟ — يقرّر عرضَ الصفّ «مُسنَد» أم «بانتظار كشف الشركة» (فعلُ موظّف). */
      partyHasPortal: partyHasPortalSql,
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
    .orderBy(asc(deliveryConsignments.id))
    .limit(effLimit + 1);
  return buildPageResult(rows.map((r) => ({ ...r, id: Number(r.id) })), effLimit);
}

/** كل إرساليات جهة (تبويب «إرساليات الجهة» في شاشة التفاصيل) — بأرقام فواتيرها وتوريداتها. */
export async function listConsignmentsForParty(partyId: number, openOnly = false, page: DeliveryListPage = {}) {
  const db = getDb();
  if (!db) return { rows: [], hasMore: false, nextCursor: null };
  const effLimit = resolvePageLimit(page.limit);
  const conds = [eq(deliveryConsignments.partyId, partyId)];
  if (openOnly) conds.push(sql`(${deliveryConsignments.parcelStatus} NOT IN ('DELIVERED','RETURNED','CANCELLED') OR ${deliveryConsignments.moneyStatus} IN ('UNSETTLED','PARTIAL'))`);
  if (page.cursor != null) conds.push(lt(deliveryConsignments.id, page.cursor));
  const rows = await db
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
    .orderBy(desc(deliveryConsignments.id))
    .limit(effLimit + 1);
  return buildPageResult(rows.map((r) => ({ ...r, id: Number(r.id) })), effLimit);
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
      .where(and(
        eq(onlineOrders.deliveryPartyId, partyId),
        eq(onlineOrders.status, "SHIPPED"),
        // ازدواجُ التعرّض (٢٢/٨): طلبُ متجرٍ أُسندت فاتورتُه إرساليةً **حيّة** يُعرَض تعرّضُه
        // في قوائم الإرساليات نفسها — فعدُّه هنا ثانيةً يضخّم «مع المندوب» بضعف القيمة.
        // مرآةُ `legacyOnlineScope` في courier.ts مع تقييد الحياة (نمط listReadyForDispatch):
        // الإرسالية الملغاة/المرتجعة تُعيد الطلبَ لهذه العدسة كي لا يسقط من العدّادات كلّها.
        sql`NOT EXISTS (
          SELECT 1 FROM deliveryConsignments dc
          WHERE dc.sourceType = 'ONLINE_ORDER'
            AND dc.sourceId = ${onlineOrders.id}
            AND dc.consignmentStatus NOT IN ('CANCELLED', 'RETURNED')
        )`,
      ))
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

export async function getDeliveryPartyFinancials(partyId: number, pages: { ledger?: DeliveryListPage; allocations?: DeliveryListPage; events?: DeliveryListPage } = {}) {
  const db = getDb();
  if (!db) return null;
  const party = (await db.select({ id: deliveryParties.id, name: deliveryParties.name }).from(deliveryParties).where(eq(deliveryParties.id, partyId)).limit(1))[0];
  if (!party) return null;
  const ledgerLimit = resolvePageLimit(pages.ledger?.limit ?? 300);
  const allocationsLimit = resolvePageLimit(pages.allocations?.limit ?? 300);
  const eventsLimit = resolvePageLimit(pages.events?.limit ?? 300);
  const ledgerCursor = pages.ledger?.cursor;
  const allocationsCursor = pages.allocations?.cursor;
  const eventsCursor = pages.events?.cursor;
  const [summary, ledgerRows, allocationsRows, eventsRows] = await Promise.all([
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
    }).from(deliveryLedgerEntries)
      .where(and(eq(deliveryLedgerEntries.partyId, partyId), ledgerCursor != null ? lt(deliveryLedgerEntries.id, ledgerCursor) : undefined))
      .orderBy(desc(deliveryLedgerEntries.id)).limit(ledgerLimit + 1),
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
      .where(and(eq(deliveryConsignments.partyId, partyId), allocationsCursor != null ? lt(deliveryRemittanceLines.id, allocationsCursor) : undefined))
      .orderBy(desc(deliveryRemittanceLines.id)).limit(allocationsLimit + 1),
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
      .where(and(eq(deliveryConsignments.partyId, partyId), eventsCursor != null ? lt(deliveryEvents.id, eventsCursor) : undefined))
      .orderBy(desc(deliveryEvents.id)).limit(eventsLimit + 1),
  ]);
  const ledger = buildPageResult(ledgerRows.map((r) => ({ ...r, id: Number(r.id) })), ledgerLimit);
  const allocations = buildPageResult(allocationsRows.map((r) => ({ ...r, id: Number(r.id) })), allocationsLimit);
  const events = buildPageResult(eventsRows.map((r) => ({ ...r, id: Number(r.id) })), eventsLimit);
  return { party, summary, ledger, allocations, events };
}

/**
 * **الخطّ الزمنيّ الكامل لإرسالية** (٢٢/٨) — شاشة «قصّة الطرد»: الصفُّ المفصّل + أحداثُه
 * بترتيب وقوعها + قيودُ دفتر التوصيل الخاصّة به، بنداءٍ واحد.
 *
 * لماذا: تشخيصُ طردٍ جامد («مُسنَد منذ ١٢ يوماً — ماذا جرى له؟») كان يتطلّب مطاردة أربعة
 * جداول يدوياً، فلا أحد يفعلها. وكلُّ حدثٍ هنا يحمل اسم فاعله وpayload بمصدر سلطته
 * (بوّابة مندوب / كشف شركة / فعل موظّف) — وهو الأثر الذي يُراجَع عند أيّ خلاف.
 */
export async function getConsignmentTimeline(consignmentId: number) {
  const db = getDb();
  if (!db) return null;
  const consignment = (
    await db
      .select({
        id: deliveryConsignments.id,
        consignmentNumber: deliveryConsignments.consignmentNumber,
        branchId: deliveryConsignments.branchId,
        partyId: deliveryConsignments.partyId,
        partyName: deliveryParties.name,
        partyType: deliveryParties.partyType,
        partyHasPortal: partyHasPortalSql,
        assignedUserId: deliveryConsignments.assignedUserId,
        driverName: users.name,
        // الحالات الثلاث معاً — الإغلاق والطرد والمال مستقلّة ولا يُشتقّ بعضها من بعض.
        status: deliveryConsignments.status,
        parcelStatus: deliveryConsignments.parcelStatus,
        moneyStatus: deliveryConsignments.moneyStatus,
        codAmount: deliveryConsignments.codAmount,
        collectedAmount: deliveryConsignments.collectedAmount,
        counterSettledAmount: deliveryConsignments.counterSettledAmount,
        deliveryFee: deliveryConsignments.deliveryFee,
        feeCollection: deliveryConsignments.feeCollection,
        feeSettledAt: deliveryConsignments.feeSettledAt,
        address: sql<string | null>`COALESCE(${deliveryConsignments.deliveryAddress}, ${workOrders.deliveryAddress})`,
        recipientName: deliveryConsignments.recipientName,
        recipientPhone: deliveryConsignments.recipientPhone,
        customerName: customers.name,
        dispatchedAt: deliveryConsignments.dispatchedAt,
        courierDeliveredAt: deliveryConsignments.courierDeliveredAt,
        settledAt: deliveryConsignments.settledAt,
        sourceType: deliveryConsignments.sourceType,
        sourceId: deliveryConsignments.sourceId,
        invoiceId: deliveryConsignments.invoiceId,
        invoiceNumber: invoices.invoiceNumber,
        workOrderId: deliveryConsignments.workOrderId,
        orderNumber: workOrders.orderNumber,
        failureReason: deliveryConsignments.failureReason,
        returnDeclaredAt: deliveryConsignments.returnDeclaredAt,
        returnDeclaredBy: deliveryConsignments.returnDeclaredBy,
        returnDeclaredReason: deliveryConsignments.returnDeclaredReason,
        remittanceId: deliveryConsignments.remittanceId,
        remittanceNumber: deliveryRemittances.remittanceNumber,
      })
      .from(deliveryConsignments)
      .leftJoin(deliveryParties, eq(deliveryParties.id, deliveryConsignments.partyId))
      .leftJoin(users, eq(users.id, deliveryConsignments.assignedUserId))
      .leftJoin(invoices, eq(invoices.id, deliveryConsignments.invoiceId))
      .leftJoin(workOrders, eq(workOrders.id, deliveryConsignments.workOrderId))
      .leftJoin(customers, eq(customers.id, deliveryConsignments.endCustomerId))
      .leftJoin(deliveryRemittances, eq(deliveryRemittances.id, deliveryConsignments.remittanceId))
      .where(eq(deliveryConsignments.id, consignmentId))
      .limit(1)
  )[0];
  if (!consignment) return null;
  const [events, ledger] = await Promise.all([
    db
      .select({
        id: deliveryEvents.id,
        eventType: deliveryEvents.eventType,
        fromParcelStatus: deliveryEvents.fromParcelStatus,
        toParcelStatus: deliveryEvents.toParcelStatus,
        fromMoneyStatus: deliveryEvents.fromMoneyStatus,
        toMoneyStatus: deliveryEvents.toMoneyStatus,
        payload: deliveryEvents.payload,
        actorUserId: deliveryEvents.actorUserId,
        actorName: users.name,
        occurredAt: deliveryEvents.occurredAt,
      })
      .from(deliveryEvents)
      .leftJoin(users, eq(users.id, deliveryEvents.actorUserId))
      .where(eq(deliveryEvents.consignmentId, consignmentId))
      // تصاعدياً بوقت الوقوع (والمعرّف يفصل التعادل داخل الثانية الواحدة) — قراءة قصّةٍ لا سجلّ.
      .orderBy(deliveryEvents.occurredAt, deliveryEvents.id),
    db
      .select({
        id: deliveryLedgerEntries.id,
        eventKey: deliveryLedgerEntries.eventKey,
        entryType: deliveryLedgerEntries.entryType,
        amount: deliveryLedgerEntries.amount,
        remittanceId: deliveryLedgerEntries.remittanceId,
        branchId: deliveryLedgerEntries.branchId,
        notes: deliveryLedgerEntries.notes,
        occurredAt: deliveryLedgerEntries.occurredAt,
      })
      .from(deliveryLedgerEntries)
      .where(eq(deliveryLedgerEntries.consignmentId, consignmentId))
      .orderBy(deliveryLedgerEntries.occurredAt, deliveryLedgerEntries.id),
  ]);
  return { consignment, events, ledger };
}

/**
 * **كشف التزامات الجهات** (٢٢/٨) — صفٌّ لكل جهةٍ نشطة عليها التزامٌ قائم: إرساليات مفتوحة،
 * أو تعرّض تحصيلٍ حيّ، أو أجور مستحقّة، أو عهدة نقدية لم تُورَّد.
 *
 * لماذا: المتابعة كانت تتطلّب فتح كل جهةٍ على حدة، فلا أحد يرى أنّ جهةً بعينها تراكم عليها
 * ٧٩ طرداً منذ أسبوعين. هنا لوحة المطاردة: الأقدمُ التزاماً أولاً، وhasPortal يحدّد أسلوب
 * المطالبة (ننتظر بوّابتها أم ندخل كشفها بأنفسنا).
 *
 * عزل الفرع على **الإرساليات والتوريدات** (الجهة المشتركة branchId=NULL تظهر لكل فرعٍ
 * بالتزامات فرعه وحدها)؛ أمّا `currentBalance` فرصيدُ الجهة الكلّي — عهدةُ النقد لا تتجزّأ
 * فرعياً في العمود المخزَّن، وقصُّها هنا كان سيُخفي عهدةً حقيقية عن كل الشاشات الفرعية.
 */
export async function listPartyObligations(branchId: number | null) {
  const db = getDb();
  if (!db) return [];
  const cnBranch = branchId == null ? sql`` : sql` AND dc.branchId = ${branchId}`;
  const rmBranch = branchId == null ? sql`` : sql` AND dr.branchId = ${branchId}`;
  const openScope = sql`FROM deliveryConsignments dc
    WHERE dc.partyId = ${deliveryParties.id}
      AND dc.consignmentStatus IN ('DISPATCHED', 'PARTIAL')${cnBranch}`;
  /**
   * ⚠️ فخّ Drizzle حاسم (اكتُشف ٢٣/٨): `${deliveryParties.id}` **داخل قالبٍ خامّ يُبنى
   * مباشرةً في `.select({...})`** يُترجَم إلى `` `id` `` بلا تأهيلٍ بالجدول. في subquery
   * له عمودٌ اسمه `id` (كل جدولٍ عندنا)، يربطه MySQL بالجدول الداخليّ فيصير المعنى
   * «id الصفّ يساوي id الصفّ» ⇒ صفر مطابقاتٍ دائماً. الحلّ **الوحيد المُثبَت**: بناء
   * القالب كـ`sql\`\`` مستقلّ (كـ`openScope`) ثمّ إسنادُه بـ`${scope}` في التعبير الأمّ —
   * عندئذٍ يُترجَم المرجع إلى `` `deliveryParties`.`id` `` (مؤهَّلاً). أُثبت الفرق بمخرج
   * SQL في نفس الجلسة: openScope مؤهَّل، وقالبٌ مباشرٌ بنفس المرجع غير مؤهَّل.
   */
  const awaitingCustodyScope = sql`FROM deliveryConsignments dc
    WHERE dc.partyId = ${deliveryParties.id}${cnBranch}
      AND (SELECT COALESCE(SUM(CASE
          WHEN dle.entryType = 'COD_COLLECTED' THEN dle.amount
          WHEN dle.entryType IN ('COD_REMITTED','COD_WRITTEN_OFF','COD_RELEASED') THEN -dle.amount
          ELSE 0 END), 0)
        FROM deliveryLedgerEntries dle
        WHERE dle.consignmentId = dc.id
          AND dle.entryType IN ('COD_COLLECTED','COD_REMITTED','COD_WRITTEN_OFF','COD_RELEASED')
      ) > 0`;
  const rows = await db
    .select({
      partyId: deliveryParties.id,
      name: deliveryParties.name,
      partyType: deliveryParties.partyType,
      currentBalance: deliveryParties.currentBalance,
      /** إرساليات الإغلاق المفتوح (DISPATCHED/PARTIAL) — عدّاد المطاردة الرئيس. */
      openCount: sql<number>`(SELECT COUNT(*) ${openScope})`,
      /**
       * ٢٣/٨ — **سُلِّم — نقدٌ بيد الجهة بانتظار التوريد** (تصويب Codex P1 #2):
       * عدّاد الجسر بين «تم التسليم» و«التسوية». المصدر الحاكم **دفترُ التوصيل**، لا حالةُ
       * الطرد: تسليمٌ بلا تحصيل (staffConfirm بدلياً=0، أو تسليمٌ جزئيّ مورَّد كاملاً)
       * يُبقي `parcelStatus=DELIVERED` بلا أيّ عهدةٍ بيد الجهة — عدّه «بيد الجهة» كذبٌ
       * يُوجِّه التسويةَ نحو تحصيلٍ غير موجود.
       *
       * الصيغة: للإرسالية عهدةٌ حيّةٌ إن كان
       *   `SUM(COD_COLLECTED) − SUM(COD_REMITTED + COD_WRITTEN_OFF + COD_RELEASED) > 0`.
       * لتفصيل فخّ Drizzle الذي يحتّم إسناد الـscope عبر `${awaitingCustodyScope}` بدل بنائه
       * مباشرةً هنا: راجع التعليق فوق `awaitingCustodyScope` أعلاه.
       */
      deliveredAwaitingRemitCount: sql<number>`(SELECT COUNT(*) ${awaitingCustodyScope})`,
      /**
       * Σ المتبقّي الحيّ (codAmount − collectedAmount − counterSettledAmount مقصوصاً عند
       * صفر)، مستثنىً منه المُعلَنُ رجوعُه — نفس صيغة codDue في «قيد التوصيل» صفّاً صفّاً،
       * كي لا تتناقض اللوحتان على نفس الطرد.
       */
      codDueTotal: sql<string>`(SELECT COALESCE(SUM(CASE WHEN dc.returnDeclaredAt IS NOT NULL THEN 0
        ELSE GREATEST(CAST(dc.codAmount AS DECIMAL(15,2))
          - CAST(dc.collectedAmount AS DECIMAL(15,2))
          - CAST(dc.counterSettledAmount AS DECIMAL(15,2)), 0) END), 0) ${openScope})`,
      /** عمر أقدم إرسالية مفتوحة بالساعات — محور «الأقدم أولاً». NULL = لا مفتوح. */
      oldestOpenAgeHours: sql<number | null>`(SELECT TIMESTAMPDIFF(HOUR, MIN(dc.dispatchedAt), NOW()) ${openScope})`,
      /**
       * Σ الأجور المستحقّة من دفتر التوصيل — نفس صيغة `feeDue` في listOpenConsignments
       * (FEE_EARNED − FEE_REFUNDED − FEE_PAID − FEE_OFFSET، مقصوصةً عند صفر لكل إرسالية
       * DELIVERED) كي يطابق المجموعُ هنا مجموعَ الصفوف هناك.
       */
      feeDueTotal: sql<string>`(SELECT COALESCE(SUM(GREATEST((
          SELECT COALESCE(SUM(CASE
            WHEN dle.entryType = 'FEE_EARNED' THEN dle.amount
            WHEN dle.entryType = 'FEE_REFUNDED' THEN -dle.amount
            WHEN dle.entryType IN ('FEE_PAID', 'FEE_OFFSET') THEN -dle.amount
            ELSE 0 END), 0)
          FROM deliveryLedgerEntries dle WHERE dle.consignmentId = dc.id
        ), 0)), 0)
        FROM deliveryConsignments dc
        WHERE dc.partyId = ${deliveryParties.id}
          AND dc.parcelStatus = 'DELIVERED'${cnBranch})`,
      lastRemittanceAt: sql<Date | null>`(SELECT MAX(dr.receivedAt) FROM deliveryRemittances dr
        WHERE dr.partyId = ${deliveryParties.id}${rmBranch})`,
      hasPortal: sql<number>`(
        EXISTS (SELECT 1 FROM deliveryPartyMembers dpm
          WHERE dpm.partyId = ${deliveryParties.id} AND dpm.isActive = 1)
        OR ${deliveryParties.userId} IS NOT NULL
      )`,
    })
    .from(deliveryParties)
    .where(and(
      // ٢٢/٨ (Codex P2 #5): جهةٌ عُطِّلت وعليها التزامٌ ماليّ حيّ (أجور مستحقة/عهدة/طرود مفتوحة)
      // كانت تختفي من هذه القائمة — وهي **الواجهة الوحيدة** لصرف الأجور المجمّع والتسوية،
      // فالالتزامُ يبقى بلا مسارٍ للأداء. نُبقيها إن كان `isActive=1` **أو** عليها التزامٌ حيّ.
      // (الحارس التشغيليّ يمنع الإسناد لجهةٍ معطَّلة أصلاً، فلا خطرَ نمو الالتزامات هنا.)
      or(
        eq(deliveryParties.isActive, true),
        sql`EXISTS (SELECT 1 FROM deliveryConsignments dc
          WHERE dc.partyId = ${deliveryParties.id}
            AND dc.consignmentStatus IN ('DISPATCHED', 'PARTIAL'))`,
        sql`CAST(${deliveryParties.currentBalance} AS DECIMAL(15,2)) > 0`,
      ),
      // رؤية الجهة نفسها كرؤية بقية الوحدة: المملوكة لفرعٍ تظهر في فرعها وحده، والمشتركة
      // (branchId=NULL) تظهر لكل فرعٍ — بالتزامات ذلك الفرع (الشروط المترابطة أعلاه).
      branchId == null
        ? undefined
        : or(isNull(deliveryParties.branchId), eq(deliveryParties.branchId, branchId)),
    ));
  // «عليها التزام» = إرسالية مفتوحة أو أجرة مستحقّة أو عهدة قائمة. الفلترة والفرز في الذاكرة
  // عمداً: جهات التوصيل بالعشرات، وHAVING كان سيكرّر الاستعلامات المترابطة الثلاثة حرفياً.
  return rows
    .filter((r) =>
      Number(r.openCount) > 0
      || money(r.feeDueTotal ?? "0").gt(0)
      || money(r.currentBalance ?? "0").gt(0),
    )
    .sort((a, b) => Number(b.oldestOpenAgeHours ?? -1) - Number(a.oldestOpenAgeHours ?? -1))
    .map((r) => ({
      partyId: Number(r.partyId),
      name: r.name,
      partyType: r.partyType,
      currentBalance: String(r.currentBalance ?? "0.00"),
      openCount: Number(r.openCount ?? 0),
      deliveredAwaitingRemitCount: Number(r.deliveredAwaitingRemitCount ?? 0),
      codDueTotal: String(r.codDueTotal ?? "0.00"),
      oldestOpenAgeHours: r.oldestOpenAgeHours == null ? null : Number(r.oldestOpenAgeHours),
      feeDueTotal: String(r.feeDueTotal ?? "0.00"),
      lastRemittanceAt: r.lastRemittanceAt ?? null,
      hasPortal: Number(r.hasPortal ?? 0) > 0,
    }));
}

// ش١ (٥/٨): listReceptionInvoiceQueue انتقلت إلى server/services/reception/queries.ts
// (بترقيم keyset وفلاتر) — حُذفت هنا مع نقطة نهايتها (حارس check:orphans).
