// courier — شاشة المندوب/الشركة الذاتية «توصيلاتي» لكل الإرساليات الموحدة.
//
// الإسناد ينشئ deliveryConsignment لمصدر أمر شغل أو فاتورة أو طلب متجر. هنا ينتقل الطرد
// عبر دورة الاستلام والخروج، ثم يؤكّد المندوب التسليم ويُحصّل النقد:
//   • الفاتورة تُسدَّد (paidAmount↑، حالة، ذمّة العميل↓) — الزبون لم يعُد مديناً.
//   • النقد بيد المندوب ⇒ عهدته ترتفع (deliveryParties.currentBalance += المحصَّل) + قيد DELIVERY_DISPATCH.
// لا نقد يدخل الدرج هنا (المندوب على الهاتف، لا وردية) — التسليم للمتجر لاحقاً عبر delivery.settle
// (موظّف باستلام النقد، SOD) الذي يخفض العهدة ويُدخل الدرج. لا ازدواج: الإيراد اعتُرف مرّة عند الإرسال
// (قيد SALE داخل createSale)، وهذا مجرّد تحصيل + نقل موقع النقد (ذمّة عميل → عهدة مندوب → درج).
//
// الهوية: تُحل العضوية من deliveryPartyMembers مع توافق الربط القديم؛ السائق لا يرى إلا ما
// أُسند إليه أو ما ينتظر ادعاء سائق داخل شركته، والمدير يرى إرساليات الجهة وفق صلاحيات عضويته.
// ⚠️ **قاعدةُ صياغةٍ حاكمة لرسائل هذا الملفّ:** رفضُه يقع **والمندوب واقفٌ على باب الزبون**
// (أو الكاشير على الهاتف معه)، فلا مجال لرسالةٍ تصف الحالة وتقف. كلُّ رفضٍ رقميّ يذكر
// **الرقمين والفرق واتّجاهه**، وكلُّ رفضٍ حالة يذكر **الحالة القائمة والخطوة الناقصة باسم زرّها
// في شاشة «توصيلاتي»** («قبول الطلب» ⇐ «استلمت الطرد» ⇐ «خرج للتوصيل» ⇐ «تم التسليم»).
import { TRPCError } from "@trpc/server";
import { appErrorMessage } from "@shared/errors";
import { assertNotReturnDeclared } from "./declaredReturn";
import {
  assertStandaloneConsignmentTx,
  loadShipmentMembersTx,
  operationalShipmentMembers,
  shipmentCurrentPartyMembers,
} from "./shipments";
import { allocateProportionally } from "./remittance";
import { computeOrderDeliveryOtp } from "../onlineOrderService";
import Decimal from "decimal.js";
import {
  loadAssignedChargeClaimsTx,
  collectAssignedConsignmentClaimsTx,
} from "../fulfillment/chargeDelivery";
import { fulfillmentError } from "../fulfillment/core";
import { routeAftercareDeliveryResultTx } from "../fulfillment/aftercareDelivery";
import { assertAftercareCourierTx } from "../fulfillment/aftercare";
import { loadOperationUserTx } from "../authorization/operationAuthority";
import { openBalanceExpr } from "@shared/predicates/openBalance";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  customers,
  deliveryConsignments,
  deliveryParties,
  deliveryLedgerEntries,
  deliveryShipmentMembers,
  invoiceItems,
  invoices,
  onlineOrders,
  workOrders,
} from "../../../drizzle/schema";
import { getDb, type Tx } from "../../db";
import { money, round2, toDbMoney } from "../money";
import {
  adjustCustomerBalance,
  adjustDeliveryBalance,
  computeInvoiceStatus,
  postEntry,
} from "../ledgerService";
import { returnSale } from "../returnService";
import { awardDeliveredOnlineOrderPoints } from "../storeAdmin/loyaltyService";
import { enqueuePostCommit, withTx } from "../tx";
import {
  checkIdempotency,
  idempotencyHash,
  recordIdempotencyKey,
} from "../idempotency";
import {
  appendDeliveryEvent,
  appendDeliveryLedgerEntry,
  assertConsignmentStatusTransition,
  assertMemberCanUseConsignment,
  assertParcelTransition,
  getDeliveryFinancialSummary,
  memberVisibilityCondition,
  resolveDeliveryMembership,
  resolveStatementWitnessAuthority,
  type ParcelStatus,
} from "./lifecycle";
import {
  deliveryCustomerCollectionIntent,
  deliveryDispatchMemoIntent,
  deliveryFeeAccrualIntent,
} from "./posting";
import { consignmentShortfallAssignedSql } from "./openParcelPredicates";
import {
  isShortfallReason,
  SHORTFALL_REASONS,
  SHORTFALL_REASON_LABEL_AR,
} from "@shared/shortfallReason";
import { enqueueStorefrontOrderStatusPush } from "../storeAdmin/storefrontPushCampaignService";
import { publishRealtimeEvent } from "../../realtime";
import { REALTIME_EVENT_TYPES } from "@shared/realtimeEvents";

/** يحلّ جهة التوصيل المرتبطة بحساب المستخدم (المندوب). null إن لم يُربط الحساب بجهة نشطة. */
export async function resolveCourierPartyId(
  userId: number,
): Promise<number | null> {
  return (await resolveDeliveryMembership(userId))?.partyId ?? null;
}

export interface MyDeliveryRow {
  /** المعرّف الطبيعيّ للصفّ: onlineOrders.id للطلب، deliveryConsignments.id للإرسالية. */
  id: number;
  /** مصدر الصفّ — يحدّد أيّ mutation يستدعيها التأكيد (طلب متجر vs إرسالية استقبال). */
  kind: "online" | "consignment";
  orderNumber: string;
  status: string;
  customerName: string | null;
  customerPhone: string | null;
  governorate: string | null;
  address: string | null;
  latitude: string | null;
  longitude: string | null;
  orderTotal: string;
  /** المبلغ المتبقّي تحصيله (صافي الفاتورة − مسدَّد للمتجر، أو codAmount − collectedAmount للإرسالية). */
  codDue: string;
  /** ١٠/٨ (تمرير كامل): أجرة المندوب — يقبضها من الزبون **فوق** codDue ويحتفظ بها (لا تُورَّد). */
  courierFee: string;
  createdAt: Date;
  acceptedAt?: Date | null;
  pickedUpAt?: Date | null;
  outForDeliveryAt?: Date | null;
  deliveredAt?: Date | null;
  failureReason?: string | null;
  assignedUserId?: number | null;
  /** رقم التتبع أو مرجع إيصال شركة التوصيل (اختياري). */
  externalTrackingRef?: string | null;
  /** المبلغ المُحصَّل فعلياً (إن وُجد). */
  collectedAmount?: string | null;
  /** الحالة المالية للإرسالية. */
  moneyStatus?: string | null;
  /** التوصيل مجاني للعميل (المتجر يتحمل الأجرة). */
  deliveryFree?: boolean;
  /** قيمة أجرة التوصيل الموهوبة للعميل. */
  deliveryWaivedAmount?: string | null;
  /** جهة استحقاق الأجرة: COURIER (يقبضها من الزبون) / SHOP (على المتجر) / COUNTER (مقبوضة مسبقاً). */
  feeCollection?: "COURIER" | "COUNTER" | "SHOP" | null;
  /** أجرة الإرسالية الحقيقية المسجلة. */
  consignmentDeliveryFee?: string | null;
  shipmentMemberCount?: number;
  invoiceReferences?: string[];
  consignmentIds?: number[];
  sourceType?: string;
  sourceId?: number;
  fulfillmentRequestId?: number | null;
  aftercareExecutionId?: number | null;
  codClaimVersion?: number;
  courierAckClaimVersion?: number;
}

export interface MyDeliveriesResult {
  linked: boolean;
  partyName: string | null;
  memberRole?: "DRIVER" | "MANAGER" | "ACCOUNTANT";
  financialSummary?: Awaited<ReturnType<typeof getDeliveryFinancialSummary>>;
  custodyBalance: string; // نقدٌ بذمّة المندوب (مُحصَّل لم يُورَّد بعد)
  toDeliver: MyDeliveryRow[]; // SHIPPED — قابلة للتأكيد
  delivered: MyDeliveryRow[]; // DELIVERED — سُلّمت (سجلّ حديث)
}

/** طلبات المندوب: قيد التوصيل (SHIPPED) + المُسلّمة حديثاً (DELIVERED) + عهدته الحالية. */
export async function listMyDeliveries(
  userId: number,
): Promise<MyDeliveriesResult> {
  const empty: MyDeliveriesResult = {
    linked: false,
    partyName: null,
    custodyBalance: "0",
    toDeliver: [],
    delivered: [],
  };
  const db = getDb();
  if (!db) return empty;
  const membership = await resolveDeliveryMembership(userId);
  if (!membership) return empty;
  const partyId = membership.partyId;
  const financialSummary = await getDeliveryFinancialSummary(
    partyId,
    membership.memberRole === "DRIVER" && membership.partyType === "COMPANY"
      ? membership.userId
      : undefined,
  );

  const onlineSelection = {
    id: onlineOrders.id,
    orderNumber: onlineOrders.orderNumber,
    status: onlineOrders.status,
    governorate: onlineOrders.governorate,
    address: onlineOrders.shippingAddress,
    latitude: onlineOrders.latitude,
    longitude: onlineOrders.longitude,
    orderTotal: onlineOrders.total,
    createdAt: onlineOrders.orderDate,
    customerName: customers.name,
    customerPhone: sql<
      string | null
    >`COALESCE(NULLIF(${customers.whatsapp}, ''), NULLIF(${customers.phone}, ''), NULLIF(${customers.phone2}, ''), NULLIF(${customers.phone3}, ''))`,
    invTotal: invoices.total,
    invPaid: invoices.paidAmount,
    invReturned: invoices.returnedTotal,
    // ١٠/٨ (تمرير كامل): الأجرة للمندوب — للفواتير الجديدة فقط (deliveryFee=0)؛ القديمة
    // شحنُها داخل codDue أصلاً فلا أجرة إضافية فوقه.
    shippingCost: sql<string>`CASE WHEN CAST(${invoices.deliveryFee} AS DECIMAL(15,2)) > 0 THEN '0.00' ELSE COALESCE(${onlineOrders.shippingCost}, '0.00') END`,
    deliveryFree: onlineOrders.deliveryFree,
    deliveryWaivedAmount: onlineOrders.deliveryWaivedAmount,
  };
  const legacyOnlineQuery = () =>
    db
      .select(onlineSelection)
      .from(onlineOrders)
      .leftJoin(customers, eq(onlineOrders.customerId, customers.id))
      .leftJoin(invoices, eq(onlineOrders.invoiceId, invoices.id));
  const legacyOnlineScope = and(
    eq(onlineOrders.deliveryPartyId, partyId),
    sql`NOT EXISTS (SELECT 1 FROM deliveryConsignments dc WHERE dc.branchId = ${onlineOrders.branchId}
      AND (dc.invoiceId = ${onlineOrders.invoiceId}
        OR (${onlineOrders.invoiceId} IS NULL AND dc.sourceType = 'ONLINE_ORDER' AND dc.sourceId = ${onlineOrders.id})))`,
  );
  // لا نقصّ العمل المفتوح أبداً؛ التاريخ وحده محدود حتى لا يكبر حساب الشركة
  // بلا سقف. الطلبات الجديدة تسلك deliveryConsignments، وهذه قراءة توافقية للإرث.
  // deliveredOnlineRows: نحصرها على غير المسدّد فقط كي لا تظهر الطلبات المنتهية تاريخياً.
  const [openOnlineRows, deliveredOnlineRows] = await Promise.all([
    legacyOnlineQuery()
      .where(and(legacyOnlineScope, eq(onlineOrders.status, "SHIPPED")))
      .orderBy(desc(onlineOrders.id)),
    legacyOnlineQuery()
      .where(
        and(
          legacyOnlineScope,
          eq(onlineOrders.status, "DELIVERED"),
          sql`(${invoices.paidAmount} IS NULL OR ${openBalanceExpr({ total: invoices.total, paidAmount: invoices.paidAmount, returnedTotal: invoices.returnedTotal }, "COLLECTIBLE")} > 0)`,
        ),
      )
      .orderBy(desc(onlineOrders.id))
      .limit(100),
  ]);
  const rows = [...openOnlineRows, ...deliveredOnlineRows];

  const toDeliver: MyDeliveryRow[] = [];
  const delivered: MyDeliveryRow[] = [];
  for (const r of rows) {
    // COD المستحقّ = صافي الفاتورة (total − returned) − المسدَّد. للطلب المُرسَل حديثاً = total.
    const net = money(r.invTotal ?? r.orderTotal).minus(
      money(r.invReturned ?? "0"),
    );
    const due = Decimal.max(net.minus(money(r.invPaid ?? "0")), 0);
    const isFree = r.deliveryFree === true;
    const row: MyDeliveryRow = {
      id: Number(r.id),
      kind: "online",
      orderNumber: r.orderNumber,
      status: r.status,
      customerName: r.customerName ?? null,
      customerPhone: r.customerPhone ?? null,
      governorate: r.governorate ?? null,
      address: r.address ?? null,
      latitude: r.latitude ?? null,
      longitude: r.longitude ?? null,
      orderTotal: String(r.orderTotal),
      codDue: toDbMoney(due),
      courierFee: isFree ? "0.00" : toDbMoney(money(r.shippingCost ?? "0")),
      createdAt: r.createdAt,
      collectedAmount: r.invPaid ? String(r.invPaid) : "0",
      moneyStatus: null,
      deliveryFree: isFree,
      deliveryWaivedAmount: r.deliveryWaivedAmount
        ? String(r.deliveryWaivedAmount)
        : null,
      feeCollection: isFree ? "SHOP" : "COURIER",
      consignmentDeliveryFee: isFree
        ? String(r.deliveryWaivedAmount ?? "0")
        : String(r.shippingCost ?? "0"),
    };
    (r.status === "DELIVERED" ? delivered : toDeliver).push(row);
  }

  // إرساليات الاستقبال المُسنَدة لهذه الجهة:
  // - قيد التوصيل (toDeliver): الجديد المستلم والغير مستلم (ASSIGNED/ACCEPTED/PICKED_UP/OUT_FOR_DELIVERY/FAILED).
  // - سُلّمت (delivered): المُسلَّم للزبون فقط والذي لم يتم التحاسب عليه أو توريده بعد (UNSETTLED/PARTIAL أو أجرته معلّقة).
  //   بمجرد التوريد أو التسوية المالية بالكامل (SETTLED) يخرج الطرد تلقائياً ليبقى الحساب نظيفاً للمندوب.
  const consignmentSelection = {
    id: deliveryConsignments.id,
    consignmentNumber: deliveryConsignments.consignmentNumber,
    sourceType: deliveryConsignments.sourceType,
    sourceId: deliveryConsignments.sourceId,
    fulfillmentRequestId: deliveryConsignments.fulfillmentRequestId,
    aftercareExecutionId: deliveryConsignments.aftercareExecutionId,
    codClaimVersion: deliveryConsignments.codClaimVersion,
    courierAckClaimVersion: deliveryConsignments.courierAckClaimVersion,
    status: deliveryConsignments.status,
    codAmount: deliveryConsignments.codAmount,
    collectedAmount: deliveryConsignments.collectedAmount,
    counterSettledAmount: deliveryConsignments.counterSettledAmount,
    courierDeliveredAt: deliveryConsignments.courierDeliveredAt,
    parcelStatus: deliveryConsignments.parcelStatus,
    moneyStatus: deliveryConsignments.moneyStatus,
    assignedUserId: deliveryConsignments.assignedUserId,
    acceptedAt: deliveryConsignments.acceptedAt,
    pickedUpAt: deliveryConsignments.pickedUpAt,
    outForDeliveryAt: deliveryConsignments.outForDeliveryAt,
    failedAt: deliveryConsignments.failedAt,
    failureReason: deliveryConsignments.failureReason,
    createdAt: deliveryConsignments.createdAt,
    recipientName: deliveryConsignments.recipientName,
    recipientPhone: deliveryConsignments.recipientPhone,
    deliveryAddress: deliveryConsignments.deliveryAddress,
    governorate: deliveryConsignments.governorate,
    latitude: deliveryConsignments.latitude,
    longitude: deliveryConsignments.longitude,
    deliveryFee: deliveryConsignments.deliveryFee,
    feeCollection: deliveryConsignments.feeCollection,
    invTotal: invoices.total,
    invPaid: invoices.paidAmount,
    invReturned: invoices.returnedTotal,
    deliveryFree: invoices.deliveryFree,
    deliveryWaivedAmount: invoices.deliveryWaivedAmount,
    custName: customers.name,
    custPhone: sql<
      string | null
    >`COALESCE(NULLIF(${customers.whatsapp}, ''), NULLIF(${customers.phone}, ''), NULLIF(${customers.phone2}, ''), NULLIF(${customers.phone3}, ''))`,
    externalTrackingRef: deliveryConsignments.externalTrackingRef,
    shortfallAssigned: consignmentShortfallAssignedSql,
  };
  const consignmentQuery = () =>
    db
      .select(consignmentSelection)
      .from(deliveryConsignments)
      .leftJoin(invoices, eq(deliveryConsignments.invoiceId, invoices.id))
      .leftJoin(
        customers,
        eq(deliveryConsignments.endCustomerId, customers.id),
      );
  const consignmentScope = and(
    eq(deliveryConsignments.partyId, partyId),
    memberVisibilityCondition(membership),
  );
  const [openConsignmentRows, deliveredConsignmentRows] = await Promise.all([
    consignmentQuery()
      .where(
        and(
          consignmentScope,
          sql`${deliveryConsignments.parcelStatus} NOT IN ('DELIVERED','RETURNED','CANCELLED')`,
          sql`${deliveryConsignments.status} NOT IN ('CANCELLED','RETURNED','WRITTEN_OFF')`,
        ),
      )
      .orderBy(desc(deliveryConsignments.id)),
    consignmentQuery()
      .where(
        and(
          consignmentScope,
          eq(deliveryConsignments.parcelStatus, "DELIVERED"),
          sql`${deliveryConsignments.status} NOT IN ('CANCELLED','RETURNED','WRITTEN_OFF')`,
          sql`(${deliveryConsignments.moneyStatus} IN ('UNSETTLED', 'PARTIAL') OR (${deliveryConsignments.moneyStatus} = 'NOT_APPLICABLE' AND ${deliveryConsignments.feeSettledAt} IS NULL AND ${deliveryConsignments.feeCollection} IN ('SHOP', 'COUNTER') AND CAST(${deliveryConsignments.deliveryFee} AS DECIMAL(15,2)) > 0))`,
        ),
      )
      .orderBy(desc(deliveryConsignments.id)),
  ]);
  const cnRows = [...openConsignmentRows, ...deliveredConsignmentRows];

  for (const r of cnRows) {
    const consignmentDue = Decimal.max(
      money(r.codAmount)
        .minus(money(r.collectedAmount ?? "0"))
        .minus(money(r.counterSettledAmount ?? "0")),
      0,
    );
    // Delivery settles the customer's invoice before the party remits its custody.
    // Delivered rows must retain the party's outstanding amount until remittance.
    const due =
      r.parcelStatus === "DELIVERED" || r.fulfillmentRequestId != null
        ? consignmentDue
        : Decimal.min(
            consignmentDue,
            Decimal.max(
              money(r.invTotal ?? "0")
                .minus(money(r.invReturned ?? "0"))
                .minus(money(r.invPaid ?? "0")),
              0,
            ),
          );
    const isFree = r.deliveryFree === true || r.feeCollection === "SHOP";
    const row: MyDeliveryRow = {
      id: Number(r.id),
      kind: "consignment",
      sourceType: r.sourceType,
      sourceId: r.sourceId,
      fulfillmentRequestId: r.fulfillmentRequestId,
      aftercareExecutionId: r.aftercareExecutionId,
      codClaimVersion: r.codClaimVersion,
      courierAckClaimVersion: r.courierAckClaimVersion,
      orderNumber: r.consignmentNumber,
      status: r.parcelStatus,
      customerName: r.recipientName ?? r.custName ?? null,
      customerPhone: r.recipientPhone ?? r.custPhone ?? null,
      governorate: r.governorate ?? null,
      address: r.deliveryAddress ?? null,
      latitude: r.latitude ?? null,
      longitude: r.longitude ?? null,
      orderTotal: String(r.invTotal ?? toDbMoney(due)),
      codDue: toDbMoney(due),
      // COURIER = يقبض أجرته من الزبون بنفسه فوق COD؛ COUNTER/SHOP لا يقبض من الزبون شيئاً فوقه.
      courierFee: toDbMoney(
        r.feeCollection === "COURIER" ? money(r.deliveryFee ?? "0") : money(0),
      ),
      createdAt: r.createdAt,
      acceptedAt: r.acceptedAt,
      pickedUpAt: r.pickedUpAt,
      outForDeliveryAt: r.outForDeliveryAt,
      deliveredAt: r.courierDeliveredAt,
      failureReason: r.failureReason,
      assignedUserId:
        r.assignedUserId != null ? Number(r.assignedUserId) : null,
      externalTrackingRef: r.externalTrackingRef ?? null,
      collectedAmount: (() => {
        const sf = round2(money(r.shortfallAssigned ?? "0"));
        if (sf.gt(0)) {
          return round2(money(r.codAmount ?? "0").minus(sf)).toFixed(2);
        }
        return r.collectedAmount ?? null;
      })(),
      moneyStatus: round2(money(r.shortfallAssigned ?? "0")).gt(0)
        ? "PARTIAL"
        : (r.moneyStatus ?? null),
      deliveryFree: isFree,
      deliveryWaivedAmount: r.deliveryWaivedAmount
        ? String(r.deliveryWaivedAmount)
        : null,
      feeCollection: (r.feeCollection ?? "COURIER") as
        | "COURIER"
        | "COUNTER"
        | "SHOP",
      consignmentDeliveryFee: r.deliveryFee ? String(r.deliveryFee) : null,
    };
    (r.parcelStatus === "DELIVERED" ? delivered : toDeliver).push(row);
  }

  if (cnRows.length) {
    const mappings = await db
      .select({
        consignmentId: deliveryShipmentMembers.consignmentId,
        leaderId: deliveryShipmentMembers.leaderConsignmentId,
        invoiceNumber: invoices.invoiceNumber,
      })
      .from(deliveryShipmentMembers)
      .innerJoin(
        deliveryConsignments,
        eq(deliveryConsignments.id, deliveryShipmentMembers.consignmentId),
      )
      .innerJoin(invoices, eq(invoices.id, deliveryConsignments.invoiceId))
      .where(
        inArray(
          deliveryShipmentMembers.consignmentId,
          cnRows.map((row) => Number(row.id)),
        ),
      );
    const mappingById = new Map(
      mappings.map((row) => [Number(row.consignmentId), row]),
    );
    const leaderIds = Array.from(
      new Set(mappings.map((row) => Number(row.leaderId))),
    );
    const leaders = leaderIds.length
      ? await db
          .select()
          .from(deliveryConsignments)
          .where(
            and(
              inArray(deliveryConsignments.id, leaderIds),
              eq(deliveryConsignments.partyId, membership.partyId),
            ),
          )
      : [];
    const leaderById = new Map(leaders.map((row) => [Number(row.id), row]));
    for (const list of [toDeliver, delivered]) {
      const groups = new Map<number, MyDeliveryRow[]>();
      for (const row of list) {
        const mapping =
          row.kind === "consignment" ? mappingById.get(row.id) : undefined;
        if (!mapping) continue;
        const leaderId = Number(mapping.leaderId);
        groups.set(leaderId, [...(groups.get(leaderId) ?? []), row]);
      }
      const groupedIds = new Set(
        mappings.map((row) => Number(row.consignmentId)),
      );
      const standalone = list.filter(
        (row) => row.kind !== "consignment" || !groupedIds.has(row.id),
      );
      for (const [leaderId, members] of Array.from(groups.entries())) {
        const leader = members.find((row) => row.id === leaderId) ?? members[0];
        const source = leaderById.get(leaderId);
        const sum = (
          field:
            | "orderTotal"
            | "codDue"
            | "courierFee"
            | "collectedAmount"
            | "consignmentDeliveryFee",
        ) =>
          toDbMoney(
            members.reduce(
              (total, row) => total.plus(money(row[field] ?? "0")),
              money(0),
            ),
          );
        standalone.push({
          ...leader,
          id: leaderId,
          orderNumber: source?.consignmentNumber ?? leader.orderNumber,
          externalTrackingRef:
            source?.externalTrackingRef ?? leader.externalTrackingRef,
          orderTotal: sum("orderTotal"),
          codDue: sum("codDue"),
          courierFee: source
            ? toDbMoney(
                source.feeCollection === "COURIER"
                  ? money(source.deliveryFee)
                  : money(0),
              )
            : sum("courierFee"),
          collectedAmount: sum("collectedAmount"),
          consignmentDeliveryFee:
            source?.deliveryFee ?? sum("consignmentDeliveryFee"),
          feeCollection: source?.feeCollection ?? leader.feeCollection,
          deliveryFree: source?.feeCollection === "SHOP" || leader.deliveryFree,
          shipmentMemberCount: members.length,
          consignmentIds: members.map((row) => row.id).sort((a, b) => a - b),
          invoiceReferences: members.map(
            (row) => mappingById.get(row.id)!.invoiceNumber,
          ),
        });
      }
      list.splice(0, list.length, ...standalone);
    }
  }

  // دمج المصدرين بترتيب زمنيّ نازل (الأحدث أولاً) — كلا القائمتين مبنيّتان أصلاً بترتيب المعرّف
  // النازل لكلٍّ على حدة، والفرز الموحّد يمنع تكتّل مصدرٍ فوق الآخر.
  const byRecent = (a: MyDeliveryRow, b: MyDeliveryRow) =>
    b.createdAt.getTime() - a.createdAt.getTime();
  toDeliver.sort(byRecent);
  delivered.sort(byRecent);
  return {
    linked: true,
    partyName: membership.partyName,
    memberRole: membership.memberRole,
    financialSummary,
    custodyBalance: financialSummary.cashInCustody,
    toDeliver,
    delivered,
  };
}

export interface ConfirmDeliveryResult {
  orderId: number;
  orderNumber: string;
  collected: string;
  custodyAfter: string;
  alreadyDelivered?: boolean;
}

/** تأكيد تسليم طلب متجر + تحصيل COD كاملاً. ذرّي: فاتورة تُسدَّد + ذمّة عميل↓ + عهدة المندوب↑. */
export async function confirmCourierDelivery(
  input: { onlineOrderId: number; handshakeOtp?: string | null },
  actor: { userId: number },
): Promise<ConfirmDeliveryResult> {
  const membership = await resolveDeliveryMembership(actor.userId);
  const partyId = membership?.partyId ?? null;
  if (partyId == null || membership?.memberRole === "ACCOUNTANT") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: "تعذّر تأكيد التسليم والتحصيل",
        why:
          membership?.memberRole === "ACCOUNTANT"
            ? "حسابك محاسبُ جهة التوصيل: يراجع الكشف والتوريد ولا يختم تسليماً في الميدان"
            : "حسابك غير مرتبطٍ بجهة توصيلٍ نشطة، وختمُ التسليم يرفع عهدةً نقديّة فلا يقع بلا جهةٍ تُنسَب إليها",
        doThis:
          "اطلب من المدير ربط حسابك بجهة التوصيل من صفحة «جهات التوصيل»؛ وإلى أن يتمّ ذلك يُثبَّت التسليم من كاشير الاستقبال بمستندٍ قصير",
      }),
    });
  }
  return withTx(async (tx) => {
    // ترتيب القفل يطابق مسار التوصيل (party ثم الفاتورة) لتجنّب تشابك مع settle/remittance.
    const partyRow = (
      await tx
        .select({
          id: deliveryParties.id,
          balance: deliveryParties.currentBalance,
          isActive: deliveryParties.isActive,
        })
        .from(deliveryParties)
        .where(eq(deliveryParties.id, partyId))
        .for("update")
        .limit(1)
    )[0];
    if (!partyRow)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر تأكيد التسليم والتحصيل",
          why: `جهة التوصيل المرتبطة بحسابك (رقم ${partyId}) لم تعد موجودةً في السجلّ — يبدو أنّها حُذفت`,
          doThis:
            "اطلب من المدير إعادة ربط حسابك بجهةٍ قائمة من صفحة «جهات التوصيل»، ولا تسلّم البضاعة قبل ذلك",
        }),
      });
    // إعادة فحص التفعيل تحت القفل (سباق تعطيل متزامن — مراجعة عدائية ١٢/٧): جهة عُطّلت لا تقبض عهدة جديدة.
    if (!partyRow.isActive)
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: "تعذّر تأكيد التسليم والتحصيل",
          why: "جهة التوصيل المرتبطة بحسابك مُعطَّلة الآن، والمعطَّلةُ لا تُحمَّل عهدةً نقديّة جديدة",
          doThis:
            "اطلب من المدير إعادة تفعيل الجهة من صفحة «جهات التوصيل» ثمّ أعِد الختم؛ وسلِّم النقد المقبوض للمتجر في كلّ الأحوال",
        }),
      });

    const order = (
      await tx
        .select()
        .from(onlineOrders)
        .where(eq(onlineOrders.id, input.onlineOrderId))
        .for("update")
        .limit(1)
    )[0];
    if (!order)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر تأكيد التسليم والتحصيل",
          why: `لا طلبَ متجرٍ بالرقم ${input.onlineOrderId} في السجلّ — يبدو أنّ قائمتك قديمة`,
          doThis:
            "اسحب قائمة «توصيلاتي» للتحديث ثمّ أعِد الختم من بطاقة الطلب الصحيحة",
        }),
      });
    // IDOR: المندوب لا يؤكّد إلا طلباته المُسنَدة إليه.
    if (Number(order.deliveryPartyId) !== partyId) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: `تعذّر تأكيد تسليم الطلب ${order.orderNumber}`,
          why: "الطلب مُسنَدٌ إلى جهة توصيلٍ أخرى، والختمُ يرفع عهدةً نقديّة على الجهة المُسنَد إليها لا على من سلّم",
          // إعادةُ الإسناد بوّابتها **مدير** (`deliveryManagerProcedure`)، أمّا إثباتُ التسليم
          // بمستندٍ فبوّابتُه كاشير الاستقبال (`deliveryCashierProcedure`) — لا تخلط الجهتين.
          doThis:
            "اطلب من المدير نقلَ إسناد الطلب إليك قبل الختم؛ وإن كنتَ سلّمتَ فعلاً فسلّم النقد لكاشير الاستقبال ليُثبِت التسليم بمستند",
        }),
      });
    }

    // التحقق من رمز التسليم السري للعميل (Delivery Handshake OTP)
    if (input.handshakeOtp != null && input.handshakeOtp.trim() !== "") {
      const expectedOtp = computeOrderDeliveryOtp(
        order.orderNumber,
        order.createdAt,
      );
      if (input.handshakeOtp.trim() !== expectedOtp) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: appErrorMessage({
            what: `تعذّر إتمام تسليم الطلب ${order.orderNumber}`,
            why: "رمز تسليم العميل (Handshake OTP) غير متطابق مع الرمز الصادر للطلب",
            doThis:
              "تأكد من إدخال رمز التحقق المكون من 4 أرقام من العميل يداً بيد",
          }),
        });
      }
    }
    // يجب أن يكون مُرسَلاً (SHIPPED) أو مُسلَّماً (DELIVERED — استرداد idempotent). غيرهما: لم يُجهَّز بعد.
    if (order.status !== "SHIPPED" && order.status !== "DELIVERED") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: `تعذّر تأكيد تسليم الطلب ${order.orderNumber}`,
          why: `حالة الطلب ${order.status} لا «مُرسَل» — لم يُجهَّز للخروج بعد أو أُلغي`,
          doThis:
            "اطلب من كاشير الاستقبال إخراج الطلب للتوصيل، ثمّ أعِد الختم بعد تحديث قائمة «توصيلاتي»",
        }),
      });
    }
    if (!order.invoiceId)
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: `تعذّر تحصيل الطلب ${order.orderNumber}`,
          why: "لا فاتورة على الطلب، والتحصيلُ يُقاس على متبقّي فاتورةٍ قائمة لا على قيمة الطلب",
          doThis:
            "سلّم البضاعة إن كانت جاهزة ولا تقبض شيئاً، وأبلِغ كاشير الاستقبال ليُصدِر فاتورة الطلب ثمّ يُثبِت التحصيل",
        }),
      });

    const inv = (
      await tx
        .select()
        .from(invoices)
        .where(eq(invoices.id, Number(order.invoiceId)))
        .for("update")
        .limit(1)
    )[0];
    if (!inv)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: `تعذّر تحصيل الطلب ${order.orderNumber}`,
          why: `فاتورة الطلب (رقم ${Number(order.invoiceId)}) مفقودةٌ من السجلّ، ولا يُقيَّد قبضٌ بلا فاتورةٍ يُنسَب إليها`,
          doThis:
            "لا تقبض شيئاً، وأبلِغ كاشير الاستقبال برقم الطلب ليُصلِح ارتباط الفاتورة قبل التسليم",
        }),
      });
    if (inv.status === "CANCELLED" || inv.status === "RETURNED") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: `تعذّر تحصيل الطلب ${order.orderNumber}`,
          why: `فاتورة الطلب حالتها ${inv.status === "CANCELLED" ? "ملغاة" : "مرتجعة"}، فلا ذمّةَ على الزبون تُحصَّل`,
          doThis:
            "لا تقبض من الزبون شيئاً، وأرجِع البضاعة إلى المتجر، وأبلِغ كاشير الاستقبال برقم الطلب ليُعيد إصداره إن كان الإلغاء خطأً",
        }),
      });
    }
    // مراجعة عدائية ٩/٨ — الشقّ الثاني من حارس ازدواج العهدة (نظير رفض ONLINE في dispatchInvoice):
    // لو أُسندت فاتورة الطلب إرساليةً من مسار الاستقبال (بيانات قديمة/التفاف API) فعهدتُها ودورةُ
    // تحصيلها هناك — تأكيدُها هنا يرفع العهدة مرّةً ثانية بمفتاح dedupe مختلف لنقدٍ واحد.
    // المفتوحة فقط (DISPATCHED/PARTIAL): إرسالية مغلقة (وُرِّدت/أُرجعت/شُطبت) لا خطرَ ازدواجٍ
    // منها — التحصيل هنا يُشتقّ من متبقّي الفاتورة فيصير صفراً بعد التوريد؛ ورفضُها كان يقفل
    // ختم DELIVERED على طلبٍ سُلِّم فعلاً إلى الأبد.
    const cnDup = (
      await tx
        .select({ n: deliveryConsignments.consignmentNumber })
        .from(deliveryConsignments)
        .where(
          and(
            eq(deliveryConsignments.invoiceId, Number(inv.id)),
            inArray(deliveryConsignments.status, ["DISPATCHED", "PARTIAL"]),
          ),
        )
        .limit(1)
    )[0];
    if (cnDup) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: `تعذّر تحصيل الطلب ${order.orderNumber} من هنا`,
          why: `فاتورة الطلب مُسنَدةٌ أصلاً إلى إرسالية الاستقبال ${cnDup.n} وهي بالطريق — وختمُها هنا يرفع عهدةً ثانية لنقدٍ واحد`,
          doThis: `اختم التسليم من بطاقة الإرسالية ${cnDup.n} في «توصيلاتي»، ومنها يجري التوريد`,
        }),
      });
    }

    // القيمة المُحصَّلة تُشتقّ من **الفاتورة** (صافي − مسدَّد) لا من حالة الطلب ⇒ التأكيد idempotent
    // وغير قابل للحجب: لو أُقفلت الحالة DELIVERED دون تحصيل (مثلاً مسارٌ آخر)، هذا يُكمل التحصيل؛
    // ولو سبق الدفع كاملاً، collected=0 (لا ازدواج). مراجعة عدائية ١٢/٧ (تعارض مساري DELIVERED).
    const wasDelivered = order.status === "DELIVERED";
    const net = money(inv.total).minus(money(inv.returnedTotal ?? "0"));
    const collected = Decimal.max(net.minus(money(inv.paidAmount ?? "0")), 0);

    if (!wasDelivered) {
      await tx
        .update(onlineOrders)
        .set({ status: "DELIVERED" })
        .where(eq(onlineOrders.id, order.id));
      if (order.customerId != null) {
        await awardDeliveredOnlineOrderPoints(tx, {
          onlineOrderId: Number(order.id),
          customerId: Number(order.customerId),
          total: String(order.total ?? "0"),
        });
      }
    }

    let custodyAfter = money(partyRow.balance ?? "0");
    if (collected.gt(0)) {
      const newPaid = money(inv.paidAmount ?? "0").plus(collected);
      await tx
        .update(invoices)
        .set({
          paidAmount: toDbMoney(newPaid),
          status: computeInvoiceStatus(
            inv.total,
            toDbMoney(newPaid),
            inv.returnedTotal ?? "0",
          ),
          paymentDate: new Date(),
          paymentMethod: sql`COALESCE(${invoices.paymentMethod}, 'CASH')`,
        })
        .where(eq(invoices.id, inv.id));
      // ذمّة العميل↓ (سدّد نقداً للمندوب).
      if (order.customerId != null)
        await adjustCustomerBalance(
          tx,
          Number(order.customerId),
          collected.neg(),
        );
      // عهدة المندوب↑ (يحمل النقد حتى يُورّده للمتجر).
      await adjustDeliveryBalance(tx, partyId, collected);
      await appendDeliveryLedgerEntry(tx, {
        eventKey: `ONLINE:${order.id}:COD_COLLECTED`,
        partyId,
        branchId: Number(inv.branchId),
        entryType: "COD_COLLECTED",
        amount: toDbMoney(collected),
        actorUserId: actor.userId,
        notes: `تحصيل COD متجر قديم — ${order.orderNumber}`,
      });
      // قيد تسوية ذمّة العميل (بلا إيصال درج — النقد بعهدة المندوب لا الدرج).
      // branchId = فرع الفاتورة (نظير dispatchInvoice) — بدونه يسقط القيد من كل تقرير/مطابقة
      // مُقيَّدة بالفرع، فيبدو صافي المبيعات المفرَّع مختلاًّ رغم صحّة الإجمالي (مراجعة عدائية ٩/٨).
      await postEntry(tx, {
        entryType: "PAYMENT_IN",
        postingIntent: deliveryCustomerCollectionIntent(collected),
        branchId: Number(inv.branchId),
        invoiceId: inv.id,
        customerId: order.customerId != null ? Number(order.customerId) : null,
        deliveryPartyId: partyId,
        amount: collected,
        dedupeKey: `ONLINE_COD_PAY:${inv.id}`,
        notes: `تحصيل COD متجر — ${order.orderNumber}`,
      });
      // قيد عهدة المندوب (نظير DELIVERY_DISPATCH لمسار أوامر الشغل — يظهر في كشف عهدة المندوب).
      await postEntry(tx, {
        entryType: "DELIVERY_DISPATCH",
        postingIntent: deliveryDispatchMemoIntent(),
        branchId: Number(inv.branchId),
        invoiceId: inv.id,
        deliveryPartyId: partyId,
        amount: collected,
        dedupeKey: `ONLINE_COD_CUSTODY:${inv.id}`,
        notes: `عهدة COD متجر — ${order.orderNumber}`,
      });
      custodyAfter = custodyAfter.plus(collected);
    }

    await enqueueStorefrontOrderStatusPush(tx, {
      orderId: Number(order.id),
      orderNumber: order.orderNumber,
      customerId: order.customerId == null ? null : Number(order.customerId),
      status: "DELIVERED",
    });

    const ret = {
      orderId: order.id,
      orderNumber: order.orderNumber,
      collected: toDbMoney(collected),
      custodyAfter: toDbMoney(custodyAfter),
      alreadyDelivered: wasDelivered && collected.isZero(),
    };
    publishRealtimeEvent(
      REALTIME_EVENT_TYPES.DELIVERY_COMPLETED,
      {
        deliveryId: order.id,
        invoiceId: Number(inv.id),
        driverId: Number(partyId),
        branchId: Number(inv.branchId),
        collectedAmount: toDbMoney(collected),
      },
      { branchId: Number(inv.branchId) },
    );
    return ret;
  });
}

export async function acknowledgeConsignmentClaim(
  input: {
    consignmentId: number;
    expectedClaimVersion: number;
    clientRequestId: string;
  },
  actor: { userId: number },
) {
  const membership = await resolveDeliveryMembership(actor.userId);
  if (!membership || membership.memberRole === "ACCOUNTANT")
    throw fulfillmentError(
      "إقرار مطالبة التحصيل متاح للمندوب أو مدير جهته فقط",
      "FORBIDDEN",
    );
  return withTx(async (tx) => {
    await tx
      .select({ id: deliveryParties.id })
      .from(deliveryParties)
      .where(eq(deliveryParties.id, membership.partyId))
      .for("update")
      .limit(1);
    const [cn] = await tx
      .select()
      .from(deliveryConsignments)
      .where(eq(deliveryConsignments.id, input.consignmentId))
      .for("update")
      .limit(1);
    if (!cn) throw fulfillmentError("الإرسالية غير موجودة", "NOT_FOUND");
    await loadOperationUserTx(tx, actor.userId);
    await assertAftercareCourierTx(tx, cn, actor.userId);
    assertMemberCanUseConsignment(membership, cn);
    const hash = idempotencyHash({ ...input, actorId: actor.userId });
    const replay = await checkIdempotency(
      tx,
      "courier.ackClaim",
      input.clientRequestId,
      hash,
      { requireStoredHash: true, forUpdate: true },
    );
    if (replay != null)
      return {
        consignmentId: cn.id,
        claimVersion: cn.courierAckClaimVersion,
        acknowledgedAt: cn.courierAckAt,
      };
    if (input.expectedClaimVersion !== cn.codClaimVersion)
      throw fulfillmentError(
        "تغيرت المطالبة قبل الإقرار؛ حدّث تفاصيل الإرسالية ثم أقر النسخة الحالية",
        "CONFLICT",
      );
    if (cn.courierAckClaimVersion === cn.codClaimVersion) {
      await recordIdempotencyKey(
        tx,
        "courier.ackClaim",
        input.clientRequestId,
        cn.id,
        hash,
      );
      return {
        consignmentId: cn.id,
        claimVersion: cn.codClaimVersion,
        acknowledgedAt: cn.courierAckAt,
      };
    }
    const acknowledgedAt = new Date();
    await tx
      .update(deliveryConsignments)
      .set({
        courierAckClaimVersion: cn.codClaimVersion,
        courierAckAt: acknowledgedAt,
      })
      .where(eq(deliveryConsignments.id, cn.id));
    await appendDeliveryEvent(tx, {
      eventKey: `CN:${cn.id}:CLAIM_ACK:${cn.codClaimVersion}:${actor.userId}`,
      consignmentId: cn.id,
      eventType: "COD_CLAIM_ACKNOWLEDGED",
      actorUserId: actor.userId,
      payload: { claimVersion: cn.codClaimVersion },
    });
    await recordIdempotencyKey(
      tx,
      "courier.ackClaim",
      input.clientRequestId,
      cn.id,
      hash,
    );
    return {
      consignmentId: cn.id,
      claimVersion: cn.codClaimVersion,
      acknowledgedAt,
    };
  });
}

export interface ConfirmConsignmentResult {
  consignmentId: number;
  consignmentNumber: string;
  deliveredAt: Date;
  alreadyDelivered?: boolean;
  collectedAmount?: string;
}

/** Recognize one physical shipment fee on its original invoice and receipt source. */
async function recognizeDeliveredShipmentFeeTx(
  tx: Tx,
  consignmentId: number,
  actor: { userId: number },
  deliveredAt: Date,
) {
  const members = await loadShipmentMembersTx(tx, consignmentId, {
    currentRead: true,
  });
  const delivered = members.find((row) => Number(row.id) === consignmentId)!;
  if (
    members.some(
      (row) => Number(row.branchId) !== Number(delivered.branchId),
    ) ||
    shipmentCurrentPartyMembers(members).some(
      (row) => Number(row.partyId) !== Number(delivered.partyId),
    )
  ) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: appErrorMessage({
        what: "تعذر إثبات أجرة الشحنة",
        why: "روابط الشحنة تتضمن جهة أو فرعاً مختلفاً",
        doThis: "أبلغ المدير لمراجعة روابط الشحنة",
      }),
    });
  }
  for (const cn of members.filter((row) => money(row.deliveryFee).gt(0))) {
    const [earned] = await tx
      .select({ id: deliveryLedgerEntries.id })
      .from(deliveryLedgerEntries)
      .where(eq(deliveryLedgerEntries.eventKey, `CN:${cn.id}:FEE_EARNED`))
      .for("share")
      .limit(1);
    if (earned) continue;
    const fee = round2(money(cn.deliveryFee));
    if (fee.gt(0)) {
      await appendDeliveryLedgerEntry(tx, {
        eventKey: `CN:${cn.id}:FEE_EARNED`,
        partyId: Number(cn.partyId),
        consignmentId: Number(cn.id),
        branchId: Number(cn.branchId),
        entryType: "FEE_EARNED",
        amount: toDbMoney(fee),
        actorUserId: actor.userId,
      });
      if (cn.feeCollection === "SHOP") {
        await postEntry(tx, {
          entryType: "DELIVERY_FEE",
          postingIntent: deliveryFeeAccrualIntent(fee),
          dedupeKey: `DELIVERY_FEE_ACCRUAL:${cn.id}`,
          branchId: Number(cn.branchId),
          invoiceId: cn.invoiceId == null ? null : Number(cn.invoiceId),
          deliveryPartyId: Number(cn.partyId),
          amount: fee,
          cost: fee,
          profit: fee.neg(),
          notes: `استحقاق أجرة توصيل ${cn.consignmentNumber}`,
        });
      }
      if (cn.feeCollection === "COURIER") {
        await appendDeliveryLedgerEntry(tx, {
          eventKey: `CN:${cn.id}:FEE_PAID_DIRECT`,
          partyId: Number(cn.partyId),
          consignmentId: Number(cn.id),
          branchId: Number(cn.branchId),
          entryType: "FEE_PAID",
          amount: toDbMoney(fee),
          notes: "Paid directly by end customer",
          actorUserId: actor.userId,
        });
        await tx
          .update(deliveryConsignments)
          .set({ feeSettledAt: deliveredAt })
          .where(eq(deliveryConsignments.id, Number(cn.id)));
      }
    }
  }
}

/**
 * تأكيد المندوب تسليمَ إرسالية موحّدة من شاشة «توصيلاتي».
 *
 * الختم هو لحظة التسليم والتحصيل الفيزيائية: ينتقل الطرد إلى DELIVERED، تُغلق ذمّة العميل،
 * ويصبح COD المحصّل عهدةً على الجهة بلا إيصال درج. التوريد اللاحق ينقل هذه العهدة إلى الدرج
 * بأسطر مستقلة ولا يسدّد العميل مرةً ثانية. COD=0 يغيّر الحالة التشغيلية وحدها. الصفوف
 * المرحّلة الموسومة custodyRecognizedAt لا تضاعف العهدة القديمة. العملية idempotent بمفتاح إلزامي.
 */
export async function confirmConsignmentDelivery(
  input: {
    consignmentId: number;
    collectionEvidence?: string;
    clientRequestId?: string;
    /**
     * **إثباتُ كشف شركة التوصيل** (١٩/٨) — تفويضٌ داخليّ تضبطه `recordCompanyStatement`
     * حصراً؛ لا يقبله أيّ راوتر (نمط `receptionDeferredAuthorized` في سلّة الاستقبال).
     *
     * لماذا وُجد: ختمُ التسليم كان حصريّاً ببوّابة المندوب (عضوية جهةٍ نشطة)، وأغلب جهات
     * التوصيل كيانُ بياناتٍ **بلا حساب نظام** ⇒ لا سطر يُختَم مُسلَّماً، فلا توريد ولا أجرة،
     * والمال يعلق بلا مخرج. كشفُ الشركة هو الدليل البديل الذي أقرّه المالك.
     *
     * والمسار الماليّ **واحدٌ لا اثنان**: نفس الجسم أدناه ينفّذ الحالتين بالحرف — لا نسخة
     * ثانية تنجرف عن الأولى. الفارق كلّه في مصدر السلطة وحدَه، ويُدوَّن في حدث التسليم.
     */
    statementWitness?: {
      partyId: number;
      statementNumber: string;
      /** ما تُعلن الشركةُ أنّها حصّلته على هذا الطرد — قد يقلّ عن COD (تحصيلٌ جزئيّ). */
      collectedAmount?: string;
      /**
       * نوعُ الدليل (٢١/٨، مُوسَّع ٢٣/٨): `COMPANY_STATEMENT` (الافتراضيّ) = كشفُ الشركة المستنديّ؛
       * `MANUAL_PROOF` = إثباتٌ استثنائيٌّ بموافقة **مدير** بدليلٍ مكتوب (نصّ المالك: «يحتاج
       * دليلاً وموافقة مدير»)؛ `STAFF_CONFIRMED` = تأكيدٌ من كاشير الاستقبال بمستندٍ قصير
       * (اتصال المندوب/واتساب/شهادة) — الأدنى سلطةً للحالة اليوميّة الشائعة (المندوب يتّصل
       * بعد التسليم). أثرُ الاختلاف **توثيقيٌّ فقط في `payload.source`**: المسار الماليّ
       * واحدٌ بالحرف (`confirmConsignmentDelivery`) كي لا تنجرف نسخةٌ ثانية عن الأولى.
       */
      kind?: "COMPANY_STATEMENT" | "MANUAL_PROOF" | "STAFF_CONFIRMED";
      /**
       * Slice DFP1 (٣٠/٨/٢٦): سببُ العجز حين `collectedAmount < invoiceRemaining`. قيمةٌ من
       * enum `shared/shortfallReason.ts` (٦ قيم مغلقة، لا نصّ حرّ). لزوماً يُقدَّم لكلّ عجز
       * — بدونه ترفض الخدمة الحفظ برسالةٍ صريحة تحيل الكاشير إلى قائمة الأسباب.
       * سلوك بلا عجز: الحقل يُتجاهَل تماماً (لا قيدَ SHORTFALL_ASSIGNED يُكتَب).
       */
      shortfallReason?: string;
    };
    /**
     * م١ (PR-4، العيب ج) — **بوّابةُ المندوب**: ما قبضه فعلاً إن قلّ عن المتبقّي (غيابُه = المتبقّي
     * كاملاً كما كان الختم دائماً). كان الختمُ من البوّابة يشترط التطابق التامّ فلا مسارَ للعجز
     * من الميدان أصلاً — والمندوبُ الذي قبض أقلّ يقف بلا زرّ. أيُّ عجزٍ يلزمه `shortfallReason`
     * من القائمة المغلقة ويُقيَّد `SHORTFALL_ASSIGNED` ذمّةً فوريّة على الجهة (نفس المسار الماليّ
     * لمسارَي الكاشير — لا نسخةَ ثانية). يُتجاهَلان مع `statementWitness` (له حقولُه الخاصّة).
     */
    collectedAmount?: string;
    shortfallReason?: string;
  },
  actor: { userId: number },
  existingTx?: Tx,
  options: { shipmentMember?: boolean } = {},
): Promise<ConfirmConsignmentResult> {
  const membership = input.statementWitness
    ? await resolveStatementWitnessAuthority(input.statementWitness.partyId)
    : await resolveDeliveryMembership(actor.userId);
  if (!membership) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: "تعذّر ختم تسليم الإرسالية",
        why: input.statementWitness
          ? `الجهة رقم ${input.statementWitness.partyId} غير موجودةٍ أو غير نشطة، وكشفُها لا يُثبِت تسليماً على جهةٍ معطَّلة`
          : "حسابك غير مرتبطٍ بجهة توصيلٍ نشطة، وختمُ التسليم يرفع عهدةً نقديّة فلا يقع بلا جهةٍ تُنسَب إليها",
        doThis:
          "اطلب من المدير ربط حسابك بجهة توصيلٍ نشطة من صفحة «جهات التوصيل»؛ وإلى أن يتمّ ذلك يُثبِت كاشير الاستقبال التسليم بمستندٍ قصير",
      }),
    });
  }
  if (membership.memberRole === "ACCOUNTANT") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: "تعذّر ختم تسليم الإرسالية بحسابك",
        why: "دورك في الجهة «محاسب»: تراجع الكشف والتوريد ولا تختم تسليماً ميدانياً",
        doThis:
          "اطلب من المندوب أو مدير الجهة ختمَ التسليم؛ ولك بعدها تسجيل التحصيل المتمِّم من كشف الشركة",
      }),
    });
  }

  const clientRequestId =
    input.clientRequestId ?? `confirm-consignment-${input.consignmentId}`;
  const payloadHash = idempotencyHash({ ...input, actorId: actor.userId });
  const run = async (tx: Tx): Promise<ConfirmConsignmentResult> => {
    // Every money-bearing delivery flow locks party → consignment → invoice.
    // Keeping one order prevents confirm/remittance deadlocks under load.
    const lockedParty = (
      await tx
        .select({ id: deliveryParties.id })
        .from(deliveryParties)
        .where(eq(deliveryParties.id, membership.partyId))
        .for("update")
        .limit(1)
    )[0];
    if (!lockedParty)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر ختم تسليم الإرسالية",
          why: `جهة التوصيل رقم ${membership.partyId} لم تعد موجودةً في السجلّ — يبدو أنّها حُذفت بعد الإسناد`,
          doThis:
            "أبلِغ المدير برقم الإرسالية ليُعيد إسنادها إلى جهةٍ قائمة قبل تسجيل التحصيل",
        }),
      });
    if (!options.shipmentMember) {
      const allMembers = await loadShipmentMembersTx(tx, input.consignmentId, {
        currentRead: true,
      });
      if (allMembers.length > 1 && !input.statementWitness) {
        const members = operationalShipmentMembers(allMembers);
        if (!members.length)
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: appErrorMessage({
              what: "تعذر تسليم الشحنة",
              why: "كل فواتير الشحنة أغلقت أو أرجعت",
              doThis: "راجع سجل الفواتير والشحنة",
            }),
          });
        for (const member of members)
          assertMemberCanUseConsignment(membership, member);
        const [mapping] = await tx
          .select()
          .from(deliveryShipmentMembers)
          .where(eq(deliveryShipmentMembers.consignmentId, input.consignmentId))
          .for("share")
          .limit(1);
        const leaderId = Number(mapping?.leaderConsignmentId ?? members[0].id);
        const groupHash = idempotencyHash({
          ...input,
          consignmentId: leaderId,
        });
        const replay = await checkIdempotency(
          tx,
          "courier.confirmShipment",
          clientRequestId,
          groupHash,
        );
        const leader = allMembers.find(
          (member) => Number(member.id) === leaderId,
        )!;
        if (replay != null) {
          const deliveredAt = members.find(
            (member) => member.courierDeliveredAt != null,
          )?.courierDeliveredAt;
          if (!deliveredAt)
            throw new TRPCError({
              code: "CONFLICT",
              message: appErrorMessage({
                what: "تعذر إعادة نتيجة تسليم الشحنة",
                why: "سجل التسليم غير مكتمل",
                doThis: "حدّث شاشة توصيلاتي وراجع تفاصيل الشحنة",
              }),
            });
          return {
            consignmentId: leaderId,
            consignmentNumber: leader.consignmentNumber,
            deliveredAt,
            alreadyDelivered: true,
          };
        }
        const invoiceRows = await tx
          .select()
          .from(invoices)
          .where(
            inArray(
              invoices.id,
              members.map((member) => Number(member.invoiceId)),
            ),
          )
          .orderBy(asc(invoices.id))
          .for("update");
        const invoiceById = new Map(
          invoiceRows.map((invoice) => [Number(invoice.id), invoice]),
        );
        const chargeRemainingByCn = new Map<number, Decimal>();
        for (const member of members)
          chargeRemainingByCn.set(
            Number(member.id),
            (await loadAssignedChargeClaimsTx(tx, Number(member.id))).remaining,
          );
        const weights = members.map((member) => {
          const invoice = invoiceById.get(Number(member.invoiceId));
          if (!invoice)
            throw new TRPCError({
              code: "NOT_FOUND",
              message: appErrorMessage({
                what: "تعذر تسليم الشحنة",
                why: "إحدى فواتيرها غير موجودة",
                doThis: "أبلغ الاستقبال برقم الشحنة لتصحيح الارتباط",
              }),
            });
          return Decimal.min(
            Decimal.max(
              money(invoice.total)
                .minus(money(invoice.returnedTotal ?? "0"))
                .minus(money(invoice.paidAmount))
                .plus(chargeRemainingByCn.get(Number(member.id)) ?? 0),
              0,
            ),
            Decimal.max(
              money(member.codAmount)
                .minus(money(member.collectedAmount))
                .minus(money(member.counterSettledAmount)),
              0,
            ),
          );
        });
        const totalDue = round2(
          weights.reduce((sum, value) => sum.plus(value), money(0)),
        );
        const amount =
          input.collectedAmount == null
            ? totalDue
            : round2(money(input.collectedAmount));
        if (
          input.collectedAmount == null &&
          leader.codClaimVersion > 1 &&
          leader.courierAckClaimVersion !== leader.codClaimVersion
        )
          throw fulfillmentError(
            "أقر نسخة مطالبة الشحنة الحالية قبل التسليم العادي",
            "CONFLICT",
          );
        if (
          !amount.isFinite() ||
          amount.lt(0) ||
          (amount.gt(totalDue) && leader.fulfillmentRequestId == null)
        )
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: appErrorMessage({
              what: "تعذر تسجيل تحصيل الشحنة",
              why: `المقبوض ${amount.toFixed(2)} خارج المبلغ المتبقي ${totalDue.toFixed(2)}`,
              doThis: "أدخل ما قبضته فعلاً ضمن المبلغ المتبقي الظاهر",
            }),
          });
        const allocated = allocateProportionally(
          Decimal.min(amount, totalDue),
          weights,
        );
        if (amount.gt(totalDue)) {
          const index = members.findIndex((m) => Number(m.id) === leaderId);
          allocated[index < 0 ? 0 : index] = allocated[
            index < 0 ? 0 : index
          ].plus(amount.minus(totalDue));
        }
        let leaderResult: ConfirmConsignmentResult | undefined;
        for (let index = 0; index < members.length; index += 1) {
          const member = members[index];
          const result = await confirmConsignmentDelivery(
            {
              ...input,
              consignmentId: Number(member.id),
              clientRequestId: `shipment:${leaderId}:${groupHash.slice(0, 40)}:${member.id}`,
              collectedAmount: toDbMoney(allocated[index]),
            },
            actor,
            tx,
            { shipmentMember: true },
          );
          leaderResult ??= result;
        }
        await recordIdempotencyKey(
          tx,
          "courier.confirmShipment",
          clientRequestId,
          leaderId,
          groupHash,
        );
        return {
          ...leaderResult!,
          consignmentId: leaderId,
          consignmentNumber: leader.consignmentNumber,
          collectedAmount: toDbMoney(amount),
        };
      }
      await assertStandaloneConsignmentTx(
        tx,
        input.consignmentId,
        "تأكيد التسليم",
        { currentRead: true },
      );
    }
    const cn = (
      await tx
        .select()
        .from(deliveryConsignments)
        .where(eq(deliveryConsignments.id, input.consignmentId))
        .for("update")
        .limit(1)
    )[0];
    if (!cn)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر ختم التسليم",
          why: `لا إرساليةَ بالرقم ${input.consignmentId} في السجلّ — يبدو أنّ قائمتك قديمة أو أنّ الإرسالية حُذفت`,
          doThis:
            "اسحب قائمة «توصيلاتي» للتحديث ثمّ اختم من بطاقة الإرسالية الصحيحة",
        }),
      });
    assertMemberCanUseConsignment(membership, cn);
    if (cn.sourceType === "AFTERCARE_EXECUTION") {
      const operationPath =
        input.statementWitness?.kind === "MANUAL_PROOF"
          ? "delivery.manualProof"
          : input.statementWitness?.kind === "STAFF_CONFIRMED"
            ? "delivery.staffConfirm"
            : "delivery.recordCompanyStatement";
      const aftercare = await routeAftercareDeliveryResultTx(
        tx,
        {
          consignmentId: cn.id,
          result: "DELIVERED",
          proof:
            input.collectionEvidence ??
            input.statementWitness?.statementNumber ??
            "تأكيد التسليم من بوابة المندوب",
          clientRequestId,
          customerCollectedAmount:
            input.statementWitness?.collectedAmount ??
            input.collectedAmount ??
            "0",
          authorization: input.statementWitness
            ? { kind: "STAFF", operationPath }
            : { kind: "COURIER" },
        },
        { userId: actor.userId, branchId: cn.branchId },
      );
      if (aftercare.handled) {
        const [completed] = await tx
          .select({ deliveredAt: deliveryConsignments.courierDeliveredAt })
          .from(deliveryConsignments)
          .where(eq(deliveryConsignments.id, cn.id))
          .limit(1);
        return {
          consignmentId: cn.id,
          consignmentNumber: cn.consignmentNumber,
          deliveredAt: completed?.deliveredAt ?? new Date(),
          alreadyDelivered: aftercare.replay,
          collectedAmount: "0.00",
        };
      }
    }
    const replayAfterLock = await checkIdempotency(
      tx,
      "courier.confirmConsignment",
      clientRequestId,
      payloadHash,
    );
    if (replayAfterLock != null) {
      if (Number(replayAfterLock) !== Number(cn.id) || !cn.courierDeliveredAt) {
        throw new TRPCError({
          code: "CONFLICT",
          message: appErrorMessage({
            what: `تعذّر ختم تسليم الإرسالية ${cn.consignmentNumber}`,
            why: `مفتاح هذه العملية مسجَّلٌ على إرساليةٍ أخرى (رقم ${Number(replayAfterLock)}) أو على تسليمٍ لم يكتمل`,
            doThis:
              "اسحب قائمة «توصيلاتي» للتحديث ثمّ اختم من بطاقة الإرسالية من جديد — مفتاحٌ واحد لا يخدم طردين",
          }),
        });
      }
      return {
        consignmentId: Number(cn.id),
        consignmentNumber: cn.consignmentNumber,
        deliveredAt: cn.courierDeliveredAt,
        alreadyDelivered: true,
      };
    }
    if (cn.parcelStatus === "DELIVERED" && cn.courierDeliveredAt) {
      return {
        consignmentId: Number(cn.id),
        consignmentNumber: cn.consignmentNumber,
        deliveredAt: cn.courierDeliveredAt,
        alreadyDelivered: true,
      };
    }
    // تدرّجُ الحالات انضباطٌ تشغيليّ **لبوّابة المندوب**: من يستعملها يقبل الطرد ويستلمه
    // ويخرج به ثمّ يختم. أمّا كشفُ الشركة (١٩/٨) فيصل بعد وقوع التسليم فعلاً وقد لا تكون
    // الشركة سجّلت أيّ خطوةٍ وسيطة في نظامنا أصلاً — فاشتراطُ `OUT_FOR_DELIVERY` عليه يعني
    // رفض الدليل المستنديّ الذي أقرّه المالك. يبقى الحارس الحقيقيّ قائماً: الطرد **خارجٌ
    // فعلاً** (الحالة نهائيةٌ ⇒ مردودةٌ أعلاه، والملغاة/المرتجعة خارج نطاق الكشف).
    // رجوعٌ مُعلَن: الطردُ راجعٌ إلينا وتعرّضُه حُرِّر — ختمُ تسليمِه (من البوّابة أو من
    // كشف الشركة) يُسجّل تحصيلاً عليه ⇒ متبقٍّ سالب، ويصير استرجاعُه الفعليّ متعذّراً لأنّ
    // مالاً قُبض. يشمل هذا الحارسُ **مسار الكشف** أيضاً (`statementWitness`) عمداً.
    assertNotReturnDeclared(cn, "deliver");
    const parcelOut =
      cn.parcelStatus === "ASSIGNED" ||
      cn.parcelStatus === "ACCEPTED" ||
      cn.parcelStatus === "PICKED_UP" ||
      cn.parcelStatus === "OUT_FOR_DELIVERY";
    if (!parcelOut) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: `تعذّر ختم تسليم الإرسالية ${cn.consignmentNumber}`,
          why: `الطرد بلغ حالةً نهائية (${cn.parcelStatus}) فخرج من دورة التوصيل — ولا يُختم تسليمُ طردٍ أُغلق ملفُّه`,
          doThis:
            "افتح بطاقة الطرد في صفحة الإرساليات وراجع سجلّه: إن كان أُغلق خطأً فأعِد إسناده من جديد؛ وإن كان قد سُلّم فعلاً فلا حاجة إلى ختمٍ ثانٍ",
        }),
      });
    }

    const deliveredAt = new Date();
    const classifiedClaims = await loadAssignedChargeClaimsTx(
      tx,
      Number(cn.id),
    );
    const classified = cn.fulfillmentRequestId != null;
    const [classifiedInvoice] =
      classified && cn.invoiceId != null
        ? await tx
            .select({
              total: invoices.total,
              paidAmount: invoices.paidAmount,
              returnedTotal: invoices.returnedTotal,
            })
            .from(invoices)
            .where(eq(invoices.id, cn.invoiceId))
            .for("update")
            .limit(1)
        : [];
    const classifiedDue = classifiedClaims.remaining.plus(
      classifiedInvoice
        ? Decimal.max(
            0,
            money(classifiedInvoice.total)
              .minus(classifiedInvoice.returnedTotal)
              .minus(classifiedInvoice.paidAmount),
          )
        : 0,
    );
    if (
      classified &&
      input.collectedAmount != null &&
      money(input.collectedAmount).gt(classifiedDue) &&
      !input.statementWitness &&
      (input.collectionEvidence?.trim().length ?? 0) < 5
    )
      throw fulfillmentError(
        "القبض الفعلي يتجاوز المطالبة الحالية؛ أرفق بيان إثبات القبض القديم كي يسجل الفائض أمانة قابلة للرد",
      );
    if (
      !input.statementWitness &&
      input.collectedAmount == null &&
      cn.codClaimVersion > 1 &&
      cn.courierAckClaimVersion !== cn.codClaimVersion
    )
      throw fulfillmentError(
        "تغيرت مطالبة التحصيل؛ افتح تفاصيل الإرسالية وأقر النسخة الحالية قبل التسليم العادي. إن قبضت فعلياً فسجل المبلغ المقبوض بدليله",
        "CONFLICT",
      );
    let recordedShortfallReason: string | null = null;
    let recordedShortageAmount: string | null = null;
    const codRemaining = round2(
      money(cn.codAmount).minus(money(cn.collectedAmount ?? "0")),
    );
    if (codRemaining.lt(0))
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: `تعذّر ختم تسليم الإرسالية ${cn.consignmentNumber}`,
          why: `المُحصَّل المسجَّل عليها ${round2(money(cn.collectedAmount ?? "0")).toFixed(2)} يتجاوز مبلغ التحصيل الأصليّ ${round2(money(cn.codAmount)).toFixed(2)} بفارق ${codRemaining.abs().toFixed(2)}`,
          doThis:
            "لا تقبض من الزبون شيئاً، وأبلِغ كاشير الاستقبال برقم الإرسالية ليُصحّح التحصيل المسجَّل قبل الختم",
        }),
      });
    /**
     * **التحصيل الجزئيّ من الكشف** (١٩/٨): بوّابة المندوب تفترض أنّ الختم يعني قبض COD
     * كاملاً (وهو صحيحٌ لمن يختم بيده لحظة التسليم). أمّا كشف الشركة فقد يقول صراحةً
     * «حُصِّل ١٢٬٠٠٠ من ٢٠٬٠٠٠» — فلو سجّلنا الكامل لأسقطنا ذمّةً لم تُدفع وأثقلنا الشركة
     * بنقدٍ لم تقبضه. نسجّل **ما وقع فعلاً**، ويبقى المتبقّي مطالَباً به على العميل
     * (قرار المالك: «التحصيل الجزئي يُترك متبقّيه على العميل»).
     */
    // م١ (PR-4): البوّابةُ تُعلن المقبوض اختيارياً؛ إعلانُه يحوّل حارس الفاتورة من تطابقٍ إلى سقف.
    const portalDeclared =
      !input.statementWitness && input.collectedAmount != null;
    const declared = input.statementWitness
      ? input.statementWitness.collectedAmount
      : input.collectedAmount;
    const cod =
      declared != null
        ? round2(money(declared))
        : classified
          ? classifiedDue
          : codRemaining;
    if (cod.gt(codRemaining) && !classified) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          // «أكثر من المتبقّي» عبارةٌ مقصودة: هي ما يفهمه الكاشير، والفرقُ مذكورٌ بعدها.
          what: `تعذّر تسجيل تحصيل الإرسالية ${cn.consignmentNumber}`,
          why: `الكشف يعلن تحصيل ${cod.toFixed(2)} وهو أكثر من المتبقّي على الطرد (${codRemaining.toFixed(2)}) بفارق ${cod.minus(codRemaining).toFixed(2)} — والزائدُ لا مستندَ له على هذا الطرد`,
          doThis: `سجّل ${codRemaining.toFixed(2)} على هذا الطرد، وراجع مع الشركة أيَّ طردٍ آخر يخصّه الفارق فسجّله عليه`,
        }),
      });
    }
    if (cod.lt(0)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: `تعذّر تسجيل تحصيل الإرسالية ${cn.consignmentNumber}`,
          why: `المبلغ المُعلَن على الكشف ${cod.toFixed(2)} سالب، والتحصيلُ لا يكون سالباً`,
          doThis:
            "أدخِل ما حصّلته الشركة فعلاً (صفراً إن لم تُحصّل شيئاً)؛ ولردّ مبلغٍ للزبون استعمل مسار المرتجع لا الكشف",
        }),
      });
    }
    // **إغلاق `status`** (Codex P1 #4 — ٢٢/٨): كان `cod.isZero()` يُغلق الطرد لكلا الحالتَين
    // متسويةً بين «مدفوعٌ سلفاً» (codAmount=0 ⇒ لا ذمّة أصلاً) و«إثباتٌ بلا تحصيل» (COD>0
    // وdeclared=0 ⇒ ذمّةٌ حيّة على العميل). الأولى فقط تُغلق: الثانية تحتاج قبضاً كاونترياً
    // لاحقاً — والذي يشترط `status ∈ {DISPATCHED, PARTIAL}` (guards)، فإغلاقُه هنا كان يجعل
    // الذمّة غيرَ قابلةٍ للاستيفاء صامتاً.
    const originalCodIsZero = round2(money(cn.codAmount)).isZero();
    if (originalCodIsZero)
      assertConsignmentStatusTransition(cn.status, "DELIVERED");
    await tx
      .update(deliveryConsignments)
      .set({
        courierDeliveredAt: deliveredAt,
        parcelStatus: "DELIVERED",
        ...(cod.gt(0) && cn.custodyRecognizedAt == null
          ? { custodyRecognizedAt: deliveredAt }
          : {}),
        ...(originalCodIsZero ? { status: "DELIVERED" as const } : {}),
      })
      .where(eq(deliveryConsignments.id, Number(cn.id)));

    await appendDeliveryEvent(tx, {
      eventKey: `CN:${cn.id}:DELIVERED`,
      consignmentId: Number(cn.id),
      eventType: "DELIVERED",
      fromParcelStatus: cn.parcelStatus,
      toParcelStatus: "DELIVERED",
      fromMoneyStatus: cn.moneyStatus,
      toMoneyStatus: cn.moneyStatus,
      actorUserId: actor.userId,
      // مصدر السلطة يُدوَّن دائماً: بوّابةُ المندوب أم كشفُ الشركة (وبأيّ رقم كشف) أم
      // إثباتٌ يدويّ استثنائيّ — هو الأثر الذي يُراجَع عند أيّ خلافٍ على تسليمٍ لم
      // يعترف به الزبون.
      payload: input.statementWitness
        ? {
            source: input.statementWitness.kind ?? "COMPANY_STATEMENT",
            statementNumber: input.statementWitness.statementNumber,
          }
        : {
            source: "COURIER_PORTAL",
            collectionEvidence: input.collectionEvidence ?? null,
          },
    });

    // A classified shortfall can cover the entire COD, including zero cash collected.
    // Company proof without a reason still leaves the unpaid amount with the customer.
    if (classified) {
      const reason =
        input.statementWitness?.shortfallReason ?? input.shortfallReason;
      if (reason && !isShortfallReason(reason))
        throw fulfillmentError("سبب عجز التحصيل ليس من القائمة المعتمدة");
      const result = await collectAssignedConsignmentClaimsTx(
        tx,
        {
          consignmentId: Number(cn.id),
          actualAmount: toDbMoney(cod),
          eventKey: clientRequestId,
          shortfallReason: reason,
          leaveRemainderOnCustomer:
            input.statementWitness != null &&
            (input.statementWitness.kind ?? "COMPANY_STATEMENT") ===
              "COMPANY_STATEMENT" &&
            !reason,
        },
        { userId: actor.userId, branchId: Number(cn.branchId) },
      );
      if (result && money(result.shortfallAmount).gt(0)) {
        recordedShortfallReason = reason ?? null;
        recordedShortageAmount = result.shortfallAmount;
      }
      if (
        cod.isZero() &&
        money(cn.codAmount)
          .minus(cn.collectedAmount)
          .minus(cn.counterSettledAmount)
          .minus(result?.shortfallAmount ?? "0")
          .lte(0)
      ) {
        assertConsignmentStatusTransition(cn.status, "DELIVERED");
        await tx
          .update(deliveryConsignments)
          .set({
            status: "DELIVERED",
            moneyStatus: "SETTLED",
            settledAt: deliveredAt,
          })
          .where(eq(deliveryConsignments.id, cn.id));
      }
    } else if (!originalCodIsZero) {
      const inv = (
        await tx
          .select()
          .from(invoices)
          .where(eq(invoices.id, Number(cn.invoiceId)))
          .for("update")
          .limit(1)
      )[0];
      if (!inv)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: appErrorMessage({
            what: `تعذّر تسجيل تحصيل الإرسالية ${cn.consignmentNumber}`,
            why: `فاتورة الإرسالية (رقم ${Number(cn.invoiceId)}) مفقودةٌ من السجلّ، ولا يُقيَّد قبضٌ بلا فاتورةٍ يُنسَب إليها`,
            doThis:
              "لا تقبض من الزبون شيئاً، وأبلِغ كاشير الاستقبال برقم الإرسالية ليُصلِح ارتباط الفاتورة قبل التسليم",
          }),
        });
      const invoiceRemaining = round2(
        money(inv.total)
          .minus(money(inv.returnedTotal ?? "0"))
          .minus(money(inv.paidAmount)),
      );
      // بوّابة المندوب: الختمُ يعني قبض المتبقّي **كاملاً** ⇒ تطابقٌ تامّ يمسك أيّ انحراف.
      // كشفُ الشركة: قد يُعلن تحصيلاً **جزئياً** — سقفٌ لا تطابق. لا يجوز بحال تجاوزُ متبقّي الفاتورة.
      const collectionMismatch =
        input.statementWitness || portalDeclared
          ? cod.gt(invoiceRemaining)
          : !invoiceRemaining.eq(cod);
      if (collectionMismatch) {
        const gap = cod.minus(invoiceRemaining);
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: input.statementWitness
            ? appErrorMessage({
                what: `تعذّر تسجيل تحصيل الإرسالية ${cn.consignmentNumber}`,
                why: `الكشف يعلن تحصيل ${cod.toFixed(2)} وهو أكثر من متبقّي الفاتورة (${invoiceRemaining.toFixed(2)}) بفارق ${gap.toFixed(2)} — والفاتورة قُبض عليها شيءٌ سلفاً أو أُرجع منها`,
                doThis: `سجّل ${invoiceRemaining.toFixed(2)} على هذه الفاتورة، وراجع مع الشركة أيَّ فاتورةٍ أخرى يخصّها الفارق`,
              })
            : appErrorMessage({
                what: `تعذّر ختم تسليم الإرسالية ${cn.consignmentNumber}`,
                why: `متبقّي الفاتورة ${invoiceRemaining.toFixed(2)} والمطلوب على الطرد ${cod.toFixed(2)} — الفرق ${gap.abs().toFixed(2)} ${gap.gt(0) ? "زيادةً على الفاتورة" : "نقصاً عنها"}؛ غالباً لأنّ دفعةً أو مرتجعاً سُجِّل على الفاتورة بعد إخراج الطرد`,
                doThis:
                  "لا تقبض من الزبون غير ما على الفاتورة، واطلب من كاشير الاستقبال تصحيح دفعات الفاتورة أو مبلغ الطرد ثمّ أعِد الختم",
              }),
        });
      }
      /**
       * Slice DFP1 (٣٠/٨/٢٦) — عجزُ التحصيل ذمّةٌ فوريّة على المندوب (قرار المالك ٣٠/٨):
       *
       * حين `cod < invoiceRemaining` تحت مصادقةِ شاهد (statementWitness = STAFF_CONFIRMED /
       * MANUAL_PROOF / COMPANY_STATEMENT) — قبلَ اليوم كانت الفاتورة تُقبَض جزئياً ويُترك المتبقّي
       * ذمّةً على العميل صامتاً. مخالفةٌ صريحة لمبدأ «لا دينار يضيع بصمت»: العميل استلم البضاعة
       * كاملةً، والتاجر/المندوب هو من قبض ناقصاً. المسؤوليّة على المندوب لا على العميل.
       *
       * التطبيق:
       *   ١) shortage = invoiceRemaining − cod (> 0)
       *   ٢) `shortfallReason` إلزاميّ (enum من `shared/shortfallReason.ts`) — بدونه رفضٌ صريح.
       *   ٣) قيدُ SHORTFALL_ASSIGNED يرفع عهدة المندوب بمبلغ العجز (يُضاف إلى `currentBalance`).
       *   ٤) الفاتورة تُقفَل مسدَّدة كاملاً (`newPaid = invoiceRemaining`) — لا AR للعميل.
       *   ٥) ذمّة العميل تُصفَّى كاملاً (`adjustCustomerBalance` بـinvoiceRemaining كاملاً).
       *
       * البوّابة النظيرة في `manualProof` تحمل نفس السلوك (نفس المسار الماليّ)، وكذلك **بوّابةُ
       * المندوب** منذ م١ PR-4 (`collectedAmount` أعلى الدالّة). أمّا **كشفُ الشركة الرسميّ** فيبقى
       * على قرار المالك (٢١/٨): سطرٌ بلا سبب = «المتبقّي يبقى على العميل» ذمّةً حيّة تُقبض كاونترياً
       * (سطرُ الإثبات الصفريّ نموذجُه)؛ وسطرٌ يحمل `shortfallReason` يقيّد عجزَه على الجهة كالمسارَين
       * الآخرَين تماماً — الاختيارُ في السطر لا في الشيفرة.
       */
      const shortage = round2(invoiceRemaining.minus(cod));
      const witnessKind = input.statementWitness
        ? (input.statementWitness.kind ?? "COMPANY_STATEMENT")
        : "COURIER_PORTAL";
      const declaredReason = input.statementWitness
        ? input.statementWitness.shortfallReason
        : input.shortfallReason;
      const shortfallOptional = witnessKind === "COMPANY_STATEMENT";
      const booksShortfall =
        shortage.gt(0) && (!shortfallOptional || declaredReason != null);
      if (booksShortfall) {
        const reason = declaredReason;
        if (!reason || !isShortfallReason(reason)) {
          // ⚠️ «سبب مصنَّف» يبقى في النصّ: يُطابقه `deliveryProof` بالتعبير النمطيّ.
          // والقائمة تُشتقّ من `@shared/shortfallReason` لا تُكتب هنا — فلا تنجرف عن المُنتقي.
          const choices = SHORTFALL_REASONS.map(
            (r) => SHORTFALL_REASON_LABEL_AR[r],
          ).join(" · ");
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: appErrorMessage({
              what: `تعذّر تسجيل تسليم الإرسالية ${cn.consignmentNumber}`,
              why: `المقبوض ${cod.toFixed(2)} والمطلوب ${invoiceRemaining.toFixed(2)} — عجزٌ قدره ${shortage.toFixed(2)} د.ع ${reason ? "بسببٍ غير معروف في القائمة" : "بلا سبب مصنَّف"}، والعجزُ يُقيَّد ذمّةً على المندوب فلا يُقبَل بلا تصنيف`,
              doThis: `اختر سبب العجز من القائمة (${choices}) ثمّ احفظ`,
            }),
          });
        }
      }
      const shortfallReason = booksShortfall ? declaredReason! : null;
      if (shortfallReason) {
        recordedShortfallReason = shortfallReason;
        recordedShortageAmount = toDbMoney(shortage);
      }

      if (cod.gt(0) || (shortfallReason != null && shortage.gt(0))) {
        if (cn.custodyRecognizedAt == null) {
          // نُصعِّد عهدةَ المندوب بـ**مجموع** ما يتحمّله (نقدٌ قبضه + عجزٌ يتحمّله):
          //   COD_COLLECTED رفعُ عهدةٍ نقديّة (قبضٌ فعليّ)،
          //   SHORTFALL_ASSIGNED رفعُ عهدةٍ غير نقديّة (ديْنٌ نيابةً عن العميل الذي أُفرِج عنه).
          const custodyRise = round2(
            cod.plus(shortfallReason ? shortage : money(0)),
          );
          if (cod.isZero()) {
            await tx
              .update(deliveryConsignments)
              .set({ custodyRecognizedAt: deliveredAt })
              .where(eq(deliveryConsignments.id, Number(cn.id)));
          }
          await adjustDeliveryBalance(tx, membership.partyId, custodyRise);
          if (cod.gt(0)) {
            await appendDeliveryLedgerEntry(tx, {
              eventKey: `CN:${cn.id}:COD_COLLECTED`,
              partyId: membership.partyId,
              consignmentId: Number(cn.id),
              branchId: Number(cn.branchId),
              entryType: "COD_COLLECTED",
              amount: toDbMoney(cod),
              actorUserId: actor.userId,
            });
          }
          if (shortfallReason) {
            await appendDeliveryLedgerEntry(tx, {
              eventKey: `CN:${cn.id}:SHORTFALL_ASSIGNED`,
              partyId: membership.partyId,
              consignmentId: Number(cn.id),
              branchId: Number(cn.branchId),
              entryType: "SHORTFALL_ASSIGNED",
              amount: toDbMoney(shortage),
              notes: `عجزُ تحصيل — ${shortfallReason}`,
              shortfallReason,
              actorUserId: actor.userId,
            });
          }
          await postEntry(tx, {
            entryType: "DELIVERY_DISPATCH",
            postingIntent: deliveryDispatchMemoIntent(),
            dedupeKey: `DELIVERY_CUSTODY:${cn.id}`,
            branchId: Number(cn.branchId),
            invoiceId: Number(cn.invoiceId),
            deliveryPartyId: membership.partyId,
            amount: custodyRise,
            notes: `تحصيل بعد التسليم ${cn.consignmentNumber}${shortfallReason ? ` (نقد ${cod.toFixed(2)} + عجز ${shortage.toFixed(2)} على المندوب)` : ""}`,
          });
        }
        // Customer AR moves to courier custody at the physical hand-over; no
        // drawer receipt exists yet.  The later remittance only moves custody to
        // cash and must not settle the customer a second time.
        // Slice DFP1: `customerSettleAmount` = مجموع ما يُفرَج عنه من ذمّة العميل — يشمل العجز
        // المُقيَّد على المندوب (لأنّ المندوب صار «المدين البديل» عن العميل بمقداره).
        const customerSettleAmount = shortfallReason
          ? round2(cod.plus(shortage))
          : cod;
        await postEntry(tx, {
          entryType: "PAYMENT_IN",
          postingIntent: deliveryCustomerCollectionIntent(customerSettleAmount),
          dedupeKey: `PAYMENT_IN:COURIER_DELIVERY:${cn.id}`,
          branchId: Number(cn.branchId),
          invoiceId: Number(cn.invoiceId),
          customerId: inv.customerId != null ? Number(inv.customerId) : null,
          deliveryPartyId: membership.partyId,
          amount: customerSettleAmount,
          notes: `تحصيل العميل لدى جهة التوصيل ${cn.consignmentNumber}${shortfallReason ? ` (بضمنه عجزٌ على المندوب ${shortage.toFixed(2)})` : ""}`,
        });
        const newPaid = round2(
          money(inv.paidAmount).plus(customerSettleAmount),
        );
        await tx
          .update(invoices)
          .set({
            paidAmount: toDbMoney(newPaid),
            status: computeInvoiceStatus(
              String(inv.total),
              toDbMoney(newPaid),
              String(inv.returnedTotal ?? "0"),
            ),
            paymentDate: deliveredAt,
            paymentMethod: sql`COALESCE(${invoices.paymentMethod}, 'CASH')`,
          })
          .where(eq(invoices.id, Number(inv.id)));
        if (inv.customerId != null) {
          await adjustCustomerBalance(
            tx,
            Number(inv.customerId),
            customerSettleAmount.neg(),
          );
        }
        // No customer cash remains to remit when the whole obligation moved to
        // a classified party shortfall. Close the parcel's cash allocation so
        // the party can repay that debt through the existing custody settlement.
        const cashRemaining = round2(
          money(cn.codAmount)
            .minus(money(cn.collectedAmount ?? "0"))
            .minus(money(cn.counterSettledAmount ?? "0"))
            .minus(shortfallReason ? shortage : money(0)),
        );
        if (cod.isZero() && shortfallReason && cashRemaining.lte(0)) {
          assertConsignmentStatusTransition(cn.status, "DELIVERED");
          await tx
            .update(deliveryConsignments)
            .set({
              status: "DELIVERED",
              moneyStatus: "SETTLED",
              settledAt: deliveredAt,
            })
            .where(eq(deliveryConsignments.id, Number(cn.id)));
          await appendDeliveryEvent(tx, {
            eventKey: `CN:${cn.id}:MONEY:SHORTFALL_ASSIGNED`,
            consignmentId: Number(cn.id),
            eventType: "MONEY_SETTLED",
            fromMoneyStatus: cn.moneyStatus,
            toMoneyStatus: "SETTLED",
            actorUserId: actor.userId,
            payload: {
              shortfallAssigned: toDbMoney(shortage),
              cashExpected: "0.00",
            },
          });
        }
      }
    }

    await recognizeDeliveredShipmentFeeTx(
      tx,
      Number(cn.id),
      actor,
      deliveredAt,
    );

    if (cn.workOrderId != null) {
      await tx
        .update(workOrders)
        .set({
          status: "DELIVERED",
          deliveredAt,
          invoiceId: Number(cn.invoiceId),
        })
        .where(eq(workOrders.id, Number(cn.workOrderId)));
    }
    if (cn.sourceType === "ONLINE_ORDER" || cn.sourceType === "INVOICE") {
      const prevOnline = (
        await tx
          .select({
            id: onlineOrders.id,
            orderNumber: onlineOrders.orderNumber,
            customerId: onlineOrders.customerId,
            total: onlineOrders.total,
            status: onlineOrders.status,
          })
          .from(onlineOrders)
          .where(
            and(
              eq(onlineOrders.branchId, Number(cn.branchId)),
              cn.sourceType === "ONLINE_ORDER"
                ? eq(onlineOrders.id, Number(cn.sourceId))
                : eq(onlineOrders.invoiceId, Number(cn.invoiceId)),
              inArray(onlineOrders.status, ["SHIPPED", "DELIVERED"]),
            ),
          )
          .for("update")
          .limit(1)
      )[0];
      if (prevOnline) {
        await tx
          .update(onlineOrders)
          .set({ status: "DELIVERED" })
          .where(eq(onlineOrders.id, Number(prevOnline.id)));
      }
      if (prevOnline && prevOnline.status !== "DELIVERED") {
        if (prevOnline.customerId != null) {
          await awardDeliveredOnlineOrderPoints(tx, {
            onlineOrderId: Number(prevOnline.id),
            customerId: Number(prevOnline.customerId),
            total: String(prevOnline.total ?? "0"),
          });
        }
        await enqueueStorefrontOrderStatusPush(tx, {
          orderId: Number(prevOnline.id),
          orderNumber: prevOnline.orderNumber,
          customerId:
            prevOnline.customerId == null
              ? null
              : Number(prevOnline.customerId),
          status: "DELIVERED",
        });
      }
    }

    await recordIdempotencyKey(
      tx,
      "courier.confirmConsignment",
      clientRequestId,
      Number(cn.id),
      payloadHash,
    );

    enqueuePostCommit(tx, () => {
      if (recordedShortfallReason && recordedShortageAmount) {
        publishRealtimeEvent(
          REALTIME_EVENT_TYPES.SHORTFALL_ASSIGNED,
          {
            deliveryId: Number(cn.id),
            driverId: Number(cn.assignedUserId ?? membership.partyId),
            amount: recordedShortageAmount,
            reason: recordedShortfallReason,
            branchId: Number(cn.branchId),
          },
          { branchId: Number(cn.branchId) },
        );
      }
      publishRealtimeEvent(
        REALTIME_EVENT_TYPES.DELIVERY_COMPLETED,
        {
          deliveryId: Number(cn.id),
          invoiceId: cn.invoiceId == null ? null : Number(cn.invoiceId),
          driverId: Number(cn.assignedUserId ?? membership.partyId),
          branchId: Number(cn.branchId),
          collectedAmount: toDbMoney(cod),
        },
        { branchId: Number(cn.branchId) },
      );
    });

    return {
      consignmentId: Number(cn.id),
      consignmentNumber: cn.consignmentNumber,
      deliveredAt,
    };
  };
  return existingTx ? run(existingTx) : withTx(run);
}

export async function transitionConsignmentParcel(
  input: {
    consignmentId: number;
    toStatus: Exclude<ParcelStatus, "DELIVERED" | "CANCELLED" | "RETURNED">;
    reason?: string | null;
    clientRequestId: string;
  },
  actor: { userId: number },
  existingTx?: Tx,
  options: { shipmentMember?: boolean } = {},
) {
  const membership = await resolveDeliveryMembership(actor.userId);
  if (!membership || membership.memberRole === "ACCOUNTANT") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: "تعذّر تحديث حالة الطرد",
        why: membership
          ? "دورك في الجهة «محاسب»: تراجع الكشف والتوريد ولا تُحرّك الطرود في الميدان"
          : "حسابك غير مرتبطٍ بجهة توصيلٍ نشطة، وحركةُ الطرد تُنسَب إلى جهةٍ ومندوب",
        doThis: membership
          ? "اطلب من المندوب أو مدير الجهة تحريك الطرد من شاشة «توصيلاتي»"
          : "اطلب من المدير ربط حسابك بجهة التوصيل من صفحة «جهات التوصيل» ثمّ أعِد المحاولة",
      }),
    });
  }
  const payloadHash = idempotencyHash(input);
  const run = async (
    tx: Tx,
  ): Promise<{ consignmentId: number; status?: string; replay: boolean }> => {
    await tx
      .select({ id: deliveryParties.id })
      .from(deliveryParties)
      .where(eq(deliveryParties.id, membership.partyId))
      .for("update")
      .limit(1);
    if (!options.shipmentMember) {
      const allMembers = await loadShipmentMembersTx(tx, input.consignmentId, {
        currentRead: true,
      });
      if (allMembers.length > 1) {
        const members = operationalShipmentMembers(allMembers);
        if (!members.length)
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: appErrorMessage({
              what: "تعذر تحديث الشحنة",
              why: "كل فواتير الشحنة أغلقت أو أرجعت",
              doThis: "راجع سجل الفواتير والشحنة",
            }),
          });
        for (const member of members)
          assertMemberCanUseConsignment(membership, member);
        const [mapping] = await tx
          .select()
          .from(deliveryShipmentMembers)
          .where(eq(deliveryShipmentMembers.consignmentId, input.consignmentId))
          .for("share")
          .limit(1);
        let replay = true;
        for (const member of members) {
          const result = await transitionConsignmentParcel(
            {
              ...input,
              consignmentId: Number(member.id),
              clientRequestId: `shipment:${idempotencyHash({ clientRequestId: input.clientRequestId, consignmentId: Number(member.id) })}`,
            },
            actor,
            tx,
            { shipmentMember: true },
          );
          replay = replay && result.replay;
        }
        return {
          consignmentId: Number(mapping?.leaderConsignmentId ?? members[0].id),
          status: input.toStatus,
          replay,
        };
      }
    }
    const cn = (
      await tx
        .select()
        .from(deliveryConsignments)
        .where(eq(deliveryConsignments.id, input.consignmentId))
        .for("update")
        .limit(1)
    )[0];
    if (!cn)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر تحديث حالة الطرد",
          why: `لا إرساليةَ بالرقم ${input.consignmentId} في السجلّ — يبدو أنّ قائمتك قديمة`,
          doThis:
            "اسحب قائمة «توصيلاتي» للتحديث ثمّ أعِد الحركة من بطاقة الطرد الصحيحة",
        }),
      });
    assertMemberCanUseConsignment(membership, cn);
    const replayAfterLock = await checkIdempotency(
      tx,
      "courier.parcelTransition",
      input.clientRequestId,
      payloadHash,
    );
    if (replayAfterLock != null)
      return { consignmentId: replayAfterLock, replay: true };
    assertParcelTransition(cn.parcelStatus, input.toStatus);
    const now = new Date();
    const reason = input.reason?.trim() || null;
    if (input.toStatus === "FAILED" && (!reason || reason.length < 2)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: `تعذّر وسم الطرد ${cn.consignmentNumber} بأنّ توصيله تعذّر`,
          why: "سببُ التعذّر فارغٌ أو أقصر من حرفين، وهو ما يقرؤه المتجر ليقرّر إعادة المحاولة أو إرجاع البضاعة",
          doThis:
            "اكتب سبباً قصيراً وواضحاً (رفض العميل الاستلام · العميل غير متوفّر · عنوان خاطئ · تعذّر التواصل) ثمّ احفظ",
        }),
      });
    }
    if (
      cn.sourceType === "AFTERCARE_EXECUTION" &&
      input.toStatus === "FAILED"
    ) {
      const handled = await routeAftercareDeliveryResultTx(
        tx,
        {
          consignmentId: cn.id,
          result: "FAILED",
          proof: reason ?? "تعذر إتمام التسليم",
          clientRequestId: input.clientRequestId,
          authorization: { kind: "COURIER" },
        },
        { userId: actor.userId, branchId: cn.branchId },
      );
      if (handled.handled) {
        await recordIdempotencyKey(
          tx,
          "courier.parcelTransition",
          input.clientRequestId,
          cn.id,
          payloadHash,
        );
        return {
          consignmentId: cn.id,
          status: input.toStatus,
          replay: handled.replay,
        };
      }
    }
    const statusTimestamps: Record<string, object> = {
      ACCEPTED: { acceptedAt: now },
      PICKED_UP: { pickedUpAt: now },
      OUT_FOR_DELIVERY: { outForDeliveryAt: now },
      FAILED: { failedAt: now, failureReason: reason },
      ASSIGNED: { failedAt: null, failureReason: null },
    };
    await tx
      .update(deliveryConsignments)
      .set({
        parcelStatus: input.toStatus,
        ...(input.toStatus === "ACCEPTED" &&
        membership.memberRole === "DRIVER" &&
        cn.assignedUserId == null
          ? { assignedUserId: membership.userId }
          : {}),
        ...(statusTimestamps[input.toStatus] ?? {}),
      })
      .where(eq(deliveryConsignments.id, Number(cn.id)));
    await appendDeliveryEvent(tx, {
      eventKey: `CN:${cn.id}:${input.toStatus}:${input.clientRequestId}`,
      consignmentId: Number(cn.id),
      eventType: input.toStatus,
      fromParcelStatus: cn.parcelStatus,
      toParcelStatus: input.toStatus,
      fromMoneyStatus: cn.moneyStatus,
      toMoneyStatus: cn.moneyStatus,
      actorUserId: actor.userId,
      payload: reason ? { reason } : {},
    });
    await recordIdempotencyKey(
      tx,
      "courier.parcelTransition",
      input.clientRequestId,
      Number(cn.id),
      payloadHash,
    );
    return {
      consignmentId: Number(cn.id),
      status: input.toStatus,
      replay: false,
    };
  };
  return existingTx ? run(existingTx) : withTx(run);
}

export interface FailDeliveryResult {
  orderId: number;
  orderNumber: string;
  reversed: boolean;
  alreadyCancelled?: boolean;
}

/**
 * تعذّر التسليم (رفض الزبون/عنوان خاطئ): يعكس بيع الطلب المرفوض ذرّياً ويُلغيه.
 * البضاعة تعود للمخزون + قيد RETURN عاكس + تُصفّى ذمّة العميل عن الفاتورة + الفاتورة RETURNED + الطلب
 * CANCELLED (بسبب). بلا عهدة (لم يُحصَّل شيء). يُعاد استخدام returnSale المُختبَر (idempotent بمفتاح
 * `courier-fail:<order>` ⇒ استرداد آمن لو فشل تحديث الطلب بعد نجاح العكس). محصورٌ بطلبٍ **غير محصَّل**
 * (paidAmount=0): بعد التحصيل يكون إرجاعاً بعد التسليم (مدير)، لا «تعذّر تسليم».
 */
export async function failCourierDelivery(
  input: { onlineOrderId: number; reason: string },
  actor: { userId: number },
): Promise<FailDeliveryResult> {
  const membership = await resolveDeliveryMembership(actor.userId);
  const partyId = membership?.partyId ?? null;
  if (partyId == null || membership?.memberRole === "ACCOUNTANT")
    throw new TRPCError({
      code: "FORBIDDEN",
      message: appErrorMessage({
        what: "تعذّر تسجيل «تعذّر التسليم»",
        why:
          partyId == null
            ? "حسابك غير مرتبطٍ بجهة توصيلٍ نشطة، وهذه الحركة تعكس البيع وتُعيد البضاعة للمخزون فلا تقع بلا جهةٍ تُنسَب إليها"
            : "دورك في الجهة «محاسب»: تراجع الكشف والتوريد ولا تُحرّك الطرود في الميدان",
        doThis:
          partyId == null
            ? "اطلب من المدير ربط حسابك بجهة التوصيل من صفحة «جهات التوصيل»، وأعِد البضاعة إلى المتجر بكلّ حال"
            : "اطلب من المندوب أو مدير الجهة تسجيل تعذّر التسليم من شاشة «توصيلاتي»",
      }),
    });
  const reason = (input.reason ?? "").trim();
  if (reason.length < 2)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر تسجيل «تعذّر التسليم»",
        why: "السبب فارغٌ أو أقصر من حرفين، وهذه الحركة تعكس البيع وتُعيد البضاعة للمخزون فلا تُسجَّل بلا سببٍ موثَّق",
        doThis:
          "اكتب سبباً قصيراً وواضحاً (رفض العميل الاستلام · العميل غير متوفّر · عنوان خاطئ · تعذّر التواصل) ثمّ احفظ",
      }),
    });
  const db = getDb();
  if (!db)
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: appErrorMessage({
        what: "تعذّر تسجيل «تعذّر التسليم»",
        why: "الاتصال بقاعدة البيانات منقطعٌ الآن، فلا يمكن عكس البيع ولا إعادة البضاعة للمخزون",
        doThis:
          "أعِد البضاعة إلى المتجر وأبلِغ كاشير الاستقبال برقم الطلب، وأعِد التسجيل بعد عودة الاتصال",
      }),
    });

  // المرحلة ①: **مطالبة ذرّية** بالطلب تحت قفل الصفّ (SHIPPED→CANCELLED). تُسلسِل ضدّ التحصيل المتزامن
  // (confirmCourierDelivery يقفل نفس الصفّ ويشترط SHIPPED/DELIVERED) ⇒ لا يعكس هذا فاتورةً حُصِّلت
  // للتوّ (مراجعة عدائية ١٢/٧): إمّا هذا يُطالِب أولاً فيرى confirm الحالة CANCELLED فيُرفَض، أو confirm
  // يُطالِب فيرى هذا DELIVERED فيُرفَض. فحص paidAmount يجري **تحت القفل** بعد المطالبة.
  const claim = await withTx(async (tx) => {
    const order = (
      await tx
        .select()
        .from(onlineOrders)
        .where(eq(onlineOrders.id, input.onlineOrderId))
        .for("update")
        .limit(1)
    )[0];
    if (!order)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر تسجيل «تعذّر التسليم»",
          why: `لا طلبَ متجرٍ بالرقم ${input.onlineOrderId} في السجلّ — يبدو أنّ قائمتك قديمة`,
          doThis:
            "اسحب قائمة «توصيلاتي» للتحديث ثمّ أعِد التسجيل من بطاقة الطلب الصحيحة",
        }),
      });
    if (Number(order.deliveryPartyId) !== partyId)
      throw new TRPCError({
        code: "FORBIDDEN",
        message: appErrorMessage({
          what: `تعذّر تسجيل «تعذّر التسليم» للطلب ${order.orderNumber}`,
          why: "الطلب مُسنَدٌ إلى جهة توصيلٍ أخرى، وعكسُ بيعه يخصّ الجهة المُسنَد إليها",
          doThis:
            "أعِد البضاعة إلى المتجر وأبلِغ كاشير الاستقبال برقم الطلب ليُسجّل التعذّر بنفسه، أو المدير إن لزم نقلُ الإسناد",
        }),
      });
    if (!order.invoiceId)
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: `تعذّر تسجيل «تعذّر التسليم» للطلب ${order.orderNumber}`,
          why: "لا فاتورة على الطلب، وهذه الحركة تعكس فاتورةً وتُعيد بنودها للمخزون",
          doThis:
            "أعِد البضاعة إلى المتجر وأبلِغ كاشير الاستقبال برقم الطلب ليُغلقه من صفحة الطلبات",
        }),
      });
    const inv = (
      await tx
        .select({
          status: invoices.status,
          paidAmount: invoices.paidAmount,
          branchId: invoices.branchId,
        })
        .from(invoices)
        .where(eq(invoices.id, Number(order.invoiceId)))
        .for("update")
        .limit(1)
    )[0];
    if (!inv)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: `تعذّر تسجيل «تعذّر التسليم» للطلب ${order.orderNumber}`,
          why: `فاتورة الطلب (رقم ${Number(order.invoiceId)}) مفقودةٌ من السجلّ، ولا يُعكَس بيعٌ بلا فاتورةٍ تُعكَس`,
          doThis:
            "أعِد البضاعة إلى المتجر وأبلِغ كاشير الاستقبال برقم الطلب ليُصلِح ارتباط الفاتورة",
        }),
      });
    if (order.status === "CANCELLED") {
      // استرداد idempotent: مُطالَبٌ سابقاً — أكمِل العكس إن لم تُرجَع الفاتورة بعد (فشلٌ بين المطالبة والعكس).
      const done = inv.status === "CANCELLED" || inv.status === "RETURNED";
      await enqueueStorefrontOrderStatusPush(tx, {
        orderId: Number(order.id),
        orderNumber: order.orderNumber,
        customerId: order.customerId == null ? null : Number(order.customerId),
        status: "CANCELLED",
      });
      return {
        orderNumber: order.orderNumber,
        invoiceId: Number(order.invoiceId),
        branchId: Number(inv.branchId),
        needsReverse: !done,
        alreadyDone: done,
      };
    }
    if (order.status !== "SHIPPED")
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: `تعذّر تسجيل «تعذّر التسليم» للطلب ${order.orderNumber}`,
          why: `حالة الطلب ${order.status} لا «مُرسَل» — و«تعذّر التسليم» لا يقع إلّا على طردٍ خرج ولم يُسلَّم`,
          doThis:
            "اسحب قائمة «توصيلاتي» للتحديث؛ فإن كان الطلب مُسلَّماً فالإرجاع بعد التسليم يُنفّذه المدير من صفحة المرتجعات",
        }),
      });
    if (money(inv.paidAmount ?? "0").gt(0)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: `تعذّر تسجيل «تعذّر التسليم» للطلب ${order.orderNumber}`,
          why: `الفاتورة قُبض عليها ${money(inv.paidAmount ?? "0").toFixed(2)} سلفاً — وما قُبض يلزمه ردٌّ موثَّق لا عكسٌ صامت من الميدان`,
          doThis:
            "أعِد البضاعة إلى المتجر، وأبلِغ المدير برقم الطلب ليُنفّذ إرجاعاً بعد التسليم مع ردّ المبلغ للزبون",
        }),
      });
    }
    await tx
      .update(onlineOrders)
      .set({ status: "CANCELLED", cancelReason: reason })
      .where(eq(onlineOrders.id, order.id));
    await enqueueStorefrontOrderStatusPush(tx, {
      orderId: Number(order.id),
      orderNumber: order.orderNumber,
      customerId: order.customerId == null ? null : Number(order.customerId),
      status: "CANCELLED",
    });
    return {
      orderNumber: order.orderNumber,
      invoiceId: Number(order.invoiceId),
      branchId: Number(inv.branchId),
      needsReverse: true,
      alreadyDone: false,
    };
  });
  if (claim.alreadyDone) {
    return {
      orderId: input.onlineOrderId,
      orderNumber: claim.orderNumber,
      reversed: false,
      alreadyCancelled: true,
    };
  }

  // المرحلة ②: عكس البيع (returnSale ذرّي، idempotent). الطلب مُطالَبٌ CANCELLED ⇒ لا يتدخّل confirm.
  let reversed = false;
  if (claim.needsReverse) {
    const items = await db
      .select({
        id: invoiceItems.id,
        baseQuantity: invoiceItems.baseQuantity,
        returnedBaseQuantity: invoiceItems.returnedBaseQuantity,
      })
      .from(invoiceItems)
      .where(eq(invoiceItems.invoiceId, claim.invoiceId));
    const lines = items
      .map((i) => ({
        invoiceItemId: Number(i.id),
        baseQuantity:
          Number(i.baseQuantity) - Number(i.returnedBaseQuantity ?? 0),
      }))
      .filter((l) => l.baseQuantity > 0);
    if (lines.length > 0) {
      // إعادة مخزون + عكس SALE + تصفير ذمّة العميل + الفاتورة RETURNED. actor.branchId=فرع الفاتورة
      // (المندوب عابرٌ للفروع). لا استرداد نقدي (paidAmount=0 مُتحقَّقٌ تحت القفل).
      await returnSale(
        {
          invoiceId: claim.invoiceId,
          lines,
          refund: null,
          restock: true,
          clientRequestId: `courier-fail:${input.onlineOrderId}`,
        },
        { userId: actor.userId, branchId: claim.branchId, role: "courier" },
      );
      reversed = true;
    }
  }
  return {
    orderId: input.onlineOrderId,
    orderNumber: claim.orderNumber,
    reversed,
  };
}

export interface SupplementaryCollectionInput {
  consignmentId: number;
  /** المبلغ الإضافي الذي حصّله هذا الكشف وحده — لا الإجماليّ التراكميّ للإرسالية. */
  additionalCollectedAmount: string;
  statementNumber: string;
  clientRequestId: string;
}

export interface SupplementaryCollectionResult {
  consignmentId: number;
  delta: string;
  /** لم يقع أي تحصيل جديد (إعادة طلبٍ أو مبلغٌ صفريّ) — عملية no-op idempotent. */
  noChange?: boolean;
  alreadyDelivered: true;
}

/**
 * **تحصيلٌ متمِّم بعد ثبوت التسليم** (Codex P1 #3 — ٢٢/٨): كشفٌ لاحقٌ يقول «حُصِّل الباقي»
 * على طردٍ سبق ختمُه في كشفٍ سابق. `confirmConsignmentDelivery` idempotent بالتصميم — يعود
 * `alreadyDelivered` بلا مساسٍ ماليّ. هذه الدالّة تسدّ الثغرة: تُدوّن **دلتا** التحصيل
 * (COD_COLLECTED مضاف + قيد PAYMENT_IN بمفتاحٍ فريد للكشف + تسديد الفاتورة بالدلتا + خصم
 * ذمّة العميل). ⚠️ لا تُغيّر `parcelStatus`/`custodyRecognizedAt` (ثابتان منذ التسليم الأصليّ).
 * وهي مرحلةٌ أولى داخل `recordCompanyStatement`: لا تغيّر `collectedAmount` بنفسها؛ يجب أن
 * تتبعها `recordDeliveryRemittanceInTx` على المعاملة نفسها كي تضيف الدلتا إلى الإرسالية وتبرئ
 * عهدة الجهة ذرّياً. المستدعي الحالي الوحيد يمرّر تلك المعاملة المشتركة.
 *
 * الأمان: عزل الفرع مقيَّس داخل المعاملة (نمط `confirmConsignmentDelivery`)، والقفلُ يتّبع
 * الترتيبَ نفسه (جهة ← إرسالية ← فاتورة) لمنع الجمود، وidempotency بمفتاحين: `clientRequestId`
 * الذي يمرّره الراوتر + `dedupeKey` مشتقّ من رقم الكشف يمنع تسجيل التوريد نفسه مرّتين.
 */
export async function recordSupplementaryStatementCollection(
  input: SupplementaryCollectionInput,
  actor: { userId: number },
  existingTx?: Tx,
): Promise<SupplementaryCollectionResult> {
  const clientRequestId = input.clientRequestId;
  if (!clientRequestId || clientRequestId.length < 8) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: appErrorMessage({
        what: "تعذّر تسجيل التحصيل المتمِّم",
        why: `الطلب وصل بمعرّف عمليةٍ غير صالحٍ لمنع التكرار (طوله ${clientRequestId?.length ?? 0} والحدّ الأدنى 8) — وهو ما يمنع تسجيل التحصيل نفسه مرّتين`,
        doThis:
          "أعِد تحميل شاشة كشف الشركة ثمّ أعِد الحفظ؛ فإن تكرّر الرفض فأبلِغ مسؤول النظام برقم الكشف",
      }),
    });
  }
  const payloadHash = idempotencyHash(input);
  const run = async (tx: Tx): Promise<SupplementaryCollectionResult> => {
    const replay = await checkIdempotency(
      tx,
      "courier.supplementaryCollection",
      clientRequestId,
      payloadHash,
    );
    if (replay != null) {
      return {
        consignmentId: replay,
        delta: "0.00",
        noChange: true,
        alreadyDelivered: true,
      };
    }
    const preview = (
      await tx
        .select({ partyId: deliveryConsignments.partyId })
        .from(deliveryConsignments)
        .where(eq(deliveryConsignments.id, Number(input.consignmentId)))
        .limit(1)
    )[0];
    if (!preview)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر تسجيل التحصيل المتمِّم",
          why: `لا إرساليةَ بالرقم ${input.consignmentId} في السجلّ`,
          doThis: `راجع رقم الطرد في كشف الشركة ${input.statementNumber} وأعِد إدخاله من صفحة الإرساليات`,
        }),
      });
    // ترتيب الأقفال الموحّد: الجهة أولاً، ثم الإرسالية، ثم الفاتورة.
    const party = (
      await tx
        .select({ id: deliveryParties.id })
        .from(deliveryParties)
        .where(eq(deliveryParties.id, Number(preview.partyId)))
        .for("update")
        .limit(1)
    )[0];
    if (!party)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر تسجيل التحصيل المتمِّم",
          why: `جهة التوصيل رقم ${Number(preview.partyId)} لم تعد موجودةً في السجلّ، ولا تُرفَع عهدةٌ لجهةٍ محذوفة`,
          doThis:
            "أبلِغ المدير برقم الإرسالية ليُعيد إنشاء الجهة أو يُصحّح إسناد الطرد قبل تسجيل الكشف",
        }),
      });
    const cn = (
      await tx
        .select()
        .from(deliveryConsignments)
        .where(eq(deliveryConsignments.id, Number(input.consignmentId)))
        .for("update")
        .limit(1)
    )[0];
    if (!cn)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: "تعذّر تسجيل التحصيل المتمِّم",
          why: `لا إرساليةَ بالرقم ${input.consignmentId} في السجلّ`,
          doThis: `راجع رقم الطرد في كشف الشركة ${input.statementNumber} وأعِد إدخاله من صفحة الإرساليات`,
        }),
      });
    if (Number(cn.partyId) !== Number(party.id)) {
      throw new TRPCError({
        code: "CONFLICT",
        message: appErrorMessage({
          what: `تعذّر تسجيل التحصيل المتمِّم على الإرسالية ${cn.consignmentNumber}`,
          why: "تغيّرت جهة التوصيل المرتبطة بالإرسالية أثناء تسجيل الكشف",
          doThis:
            "حدّث شاشة الكشف ثم أعد مسح بوليصة الإرسالية على الشركة الحالية",
        }),
      });
    }
    if (cn.parcelStatus !== "DELIVERED") {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: `تعذّر تسجيل التحصيل المتمِّم على الإرسالية ${cn.consignmentNumber}`,
          why: `حالة الطرد ${cn.parcelStatus} لا «مُسلَّم» — والتحصيلُ المتمِّم يُدوَّن على طردٍ ثبت تسليمه سلفاً في كشفٍ سابق`,
          doThis:
            "سجّل التسليم أوّلاً من مسار تسليم الإرسالية بالكشف، ثمّ سجّل ما تبقّى تحصيلاً متمِّماً",
        }),
      });
    }
    assertNotReturnDeclared(cn, "collect");
    const delta = round2(money(input.additionalCollectedAmount));
    const currentCollected = round2(money(cn.collectedAmount ?? "0"));
    const codAmount = round2(money(cn.codAmount));
    if (delta.lt(0)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: `تعذّر تسجيل التحصيل المتمِّم على الإرسالية ${cn.consignmentNumber}`,
          why: `مبلغ الكشف ${input.statementNumber} الإضافي سالب (${delta.toFixed(2)})، والتحصيل السابق لا يُلغى بكشفٍ لاحق`,
          doThis:
            "صحّح مبلغ سطر الكشف إلى ما قبضته الشركة في هذا الكشف فقط، أو استخدم مسار التصحيح المالي الموثّق",
        }),
      });
    }
    if (delta.isZero()) {
      await recordIdempotencyKey(
        tx,
        "courier.supplementaryCollection",
        clientRequestId,
        Number(cn.id),
        payloadHash,
      );
      return {
        consignmentId: Number(cn.id),
        delta: "0.00",
        noChange: true,
        alreadyDelivered: true,
      };
    }
    if (cn.sourceType === "AFTERCARE_EXECUTION")
      throw fulfillmentError(
        "إرسالية المعالجة لا تحمل مطالبة على العميل؛ لا تقبل تحصيلاً متمماً",
      );
    const assigned = await loadAssignedChargeClaimsTx(tx, Number(cn.id));
    if (cn.fulfillmentRequestId != null) {
      const replay = await checkIdempotency(
        tx,
        "courier.supplementaryCollection",
        clientRequestId,
        payloadHash,
        { requireStoredHash: true, forUpdate: true },
      );
      if (replay != null)
        return {
          consignmentId: cn.id,
          delta: "0.00",
          noChange: true,
          alreadyDelivered: true,
        };
      await collectAssignedConsignmentClaimsTx(
        tx,
        {
          consignmentId: cn.id,
          actualAmount: toDbMoney(delta),
          eventKey: clientRequestId,
          leaveRemainderOnCustomer: true,
          supplementary: true,
        },
        { userId: actor.userId, branchId: cn.branchId },
      );
      await recordIdempotencyKey(
        tx,
        "courier.supplementaryCollection",
        clientRequestId,
        cn.id,
        payloadHash,
      );
      return {
        consignmentId: cn.id,
        delta: toDbMoney(delta),
        alreadyDelivered: true,
      };
    }
    const newTotal = round2(currentCollected.plus(delta));
    if (newTotal.gt(codAmount)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: appErrorMessage({
          what: `تعذّر تسجيل التحصيل المتمِّم على الإرسالية ${cn.consignmentNumber}`,
          why: `الكشف ${input.statementNumber} يضيف ${delta.toFixed(2)} إلى ${currentCollected.toFixed(2)} محصّلةً سلفاً، فيصبح الإجمالي ${newTotal.toFixed(2)} وهو أكثر من COD (${codAmount.toFixed(2)}) بفارق ${newTotal.minus(codAmount).toFixed(2)}`,
          doThis: `أدخِل ما قبضته الشركة في هذا الكشف فقط، وبحدّ ${Decimal.max(codAmount.minus(currentCollected), 0).toFixed(2)} المتبقّي على الطرد`,
        }),
      });
    }
    // الفاتورة — للتسديد بالدلتا.
    const inv = (
      await tx
        .select()
        .from(invoices)
        .where(eq(invoices.id, Number(cn.invoiceId)))
        .for("update")
        .limit(1)
    )[0];
    if (!inv)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: appErrorMessage({
          what: `تعذّر تسجيل التحصيل المتمِّم على الإرسالية ${cn.consignmentNumber}`,
          why: `فاتورة الإرسالية (رقم ${Number(cn.invoiceId)}) مفقودةٌ من السجلّ، ولا يُقيَّد قبضٌ بلا فاتورةٍ يُنسَب إليها`,
          doThis:
            "أبلِغ كاشير الاستقبال برقم الإرسالية ليُصلِح ارتباط الفاتورة، ثمّ أعِد تسجيل الكشف",
        }),
      });
    const invoiceRemaining = round2(
      money(inv.total)
        .minus(money(inv.returnedTotal ?? "0"))
        .minus(money(inv.paidAmount)),
    );
    if (delta.gt(invoiceRemaining)) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: appErrorMessage({
          what: `تعذّر تسجيل التحصيل المتمِّم على الإرسالية ${cn.consignmentNumber}`,
          why: `المبلغ الإضافي في الكشف ${input.statementNumber} هو ${delta.toFixed(2)}، وهو يتجاوز متبقّي الفاتورة ${invoiceRemaining.toFixed(2)} بفارق ${delta.minus(invoiceRemaining).toFixed(2)}`,
          doThis: `سجّل ${invoiceRemaining.toFixed(2)} على هذه الفاتورة، وراجع مع الشركة أيَّ فاتورةٍ أخرى يخصّها الفارق قبل قيده`,
        }),
      });
    }
    // ارتفاعُ العهدة + قيد التحصيل بمفتاحٍ خاصّ لهذا الكشف (idempotent إن أُعيد).
    await adjustDeliveryBalance(tx, Number(cn.partyId), delta);
    await appendDeliveryLedgerEntry(tx, {
      eventKey: `CN:${cn.id}:COD_COLLECTED_SUPP:${input.statementNumber}`,
      partyId: Number(cn.partyId),
      consignmentId: Number(cn.id),
      branchId: Number(cn.branchId),
      entryType: "COD_COLLECTED",
      amount: toDbMoney(delta),
      actorUserId: actor.userId,
      notes: `تحصيل متمِّم — كشف ${input.statementNumber}`,
    });
    await postEntry(tx, {
      entryType: "DELIVERY_DISPATCH",
      postingIntent: deliveryDispatchMemoIntent(),
      dedupeKey: `DELIVERY_CUSTODY_SUPP:${cn.id}:${input.statementNumber}`,
      branchId: Number(cn.branchId),
      invoiceId: Number(cn.invoiceId),
      deliveryPartyId: Number(cn.partyId),
      amount: delta,
      notes: `تحصيل متمِّم على ${cn.consignmentNumber}`,
    });
    await postEntry(tx, {
      entryType: "PAYMENT_IN",
      postingIntent: deliveryCustomerCollectionIntent(delta),
      dedupeKey: `PAYMENT_IN:COURIER_DELIVERY_SUPP:${cn.id}:${input.statementNumber}`,
      branchId: Number(cn.branchId),
      invoiceId: Number(cn.invoiceId),
      customerId: inv.customerId != null ? Number(inv.customerId) : null,
      deliveryPartyId: Number(cn.partyId),
      amount: delta,
      notes: `تحصيل متمِّم عبر كشف ${input.statementNumber} — ${cn.consignmentNumber}`,
    });
    const newPaid = round2(money(inv.paidAmount).plus(delta));
    await tx
      .update(invoices)
      .set({
        paidAmount: toDbMoney(newPaid),
        status: computeInvoiceStatus(
          String(inv.total),
          toDbMoney(newPaid),
          String(inv.returnedTotal ?? "0"),
        ),
      })
      .where(eq(invoices.id, Number(inv.id)));
    if (inv.customerId != null) {
      await adjustCustomerBalance(tx, Number(inv.customerId), delta.neg());
    }
    // لا نحدّث `collectedAmount` هنا: آلةُ التوريد التالية في **المعاملة نفسها** تضيف الدلتا
    // وتختم الحالة. تحديثُه هنا كان يجعلها ترى المتبقّي صفراً فترفض توريد الكشف المتمِّم.
    await appendDeliveryEvent(tx, {
      eventKey: `CN:${cn.id}:COD_COLLECTED_SUPP:${input.statementNumber}`,
      consignmentId: Number(cn.id),
      eventType: "SUPPLEMENTARY_COLLECTION",
      actorUserId: actor.userId,
      payload: {
        source: "COMPANY_STATEMENT",
        statementNumber: input.statementNumber,
        additionalCollectedAmount: delta.toFixed(2),
        newCollectedTotal: newTotal.toFixed(2),
      },
    });
    await recordIdempotencyKey(
      tx,
      "courier.supplementaryCollection",
      clientRequestId,
      Number(cn.id),
      payloadHash,
    );
    return {
      consignmentId: Number(cn.id),
      delta: delta.toFixed(2),
      alreadyDelivered: true,
    };
  };
  return existingTx ? run(existingTx) : withTx(run);
}
