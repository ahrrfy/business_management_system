import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import {
  deliveryCustodyItems,
  fulfillmentRequestItems,
} from "../../../drizzle/fulfillmentSchema";
import { getDb } from "../../db";
import { appRouter } from "../../routers";
import type { TrpcContext } from "../../context";
import { truncateTables } from "./__testUtils__";
import { createWorkOrder } from "../workOrder/create";
import { deliverWorkOrder } from "../workOrder/deliver";
import { updateWorkOrderDeliveryMethod } from "../workOrder/fulfillment";
import { markWorkOrderReady, startWorkOrder } from "../workOrder/lifecycle";
import { shelfAuditDeliverWorkOrders } from "../workOrder/shelfAudit";
import {
  approveWorkOrderControlRequest,
  requestWorkOrderControl,
} from "../workOrder/controlRequests";
import { getWorkOrderReverseDeliveryPreflight } from "../workOrder/reverseDelivery";
import {
  decideWorkOrderDesignApproval,
  requestWorkOrderDesignApproval,
} from "../workOrder/designApproval";
import {
  createFulfillmentRequest,
  readyFulfillmentRequest,
  reassignFulfillmentRequest,
  releaseFulfillmentRequest,
} from "../fulfillment/requests";
import { dispatchToDelivery } from "../delivery/dispatch";
import { cancelShipmentAssignment } from "../delivery/shipmentOperations";
import { consignmentFeeDueSql } from "../delivery/fees";
import { verifiedConsignmentLedgerRows } from "../delivery/legacyLedger";
import {
  getDeliveryLegacyFindings,
  repairDeliveryLegacyRow,
} from "../deliveryLegacyRepairService";
import { getWIPReport } from "../reports/wip";
import {
  confirmExternalPaymentAttempt,
  initiateExternalPaymentAttempt,
} from "../posExternalPayment";
import { withTx } from "../tx";

const TABLES = [
  "deliveryCustodyEvents",
  "deliveryCustodyItems",
  "fulfillmentRequestEvents",
  "fulfillmentRequestItems",
  "fulfillmentRequests",
  "deliveryShipmentMembers",
  "documentEffects",
  "deliveryOutbox",
  "deliveryEvents",
  "deliveryLedgerEntries",
  "deliveryRemittanceLines",
  "deliveryRemittances",
  "deliveryConsignments",
  "deliveryParties",
  "externalPaymentAttempts",
  "customerReceiptAllocations",
  "customerReceiptSettlements",
  "workOrderControlRequests",
  "workOrderDesignApprovals",
  "workOrderDesignRevisions",
  "workOrderEvents",
  "idempotencyKeys",
  "auditLogs",
  "accountingEntries",
  "receipts",
  "inventoryMovements",
  "workOrderMaterials",
  "workOrderImages",
  "workOrders",
  "invoiceItems",
  "invoices",
  "branchStock",
  "productPrices",
  "productUnits",
  "productVariants",
  "products",
  "serviceTypes",
  "shifts",
  "customers",
  "branches",
  "users",
];

function db() {
  const database = getDb();
  if (!database) throw new Error("DATABASE_URL not set");
  return database;
}

const CASHIER = { userId: 2, branchId: 1, role: "cashier" as const };
const MANAGER = { userId: 1, branchId: 1, role: "manager" as const };
const ADMIN = { userId: 4, branchId: 1, role: "admin" as const, isOwner: true };

function makeCaller(user: {
  id: number;
  branchId: number | null;
  role: "admin" | "manager" | "cashier";
  isOwner?: boolean;
}) {
  const ctx: TrpcContext = {
    req: { headers: {} } as unknown as TrpcContext["req"],
    res: {} as unknown as TrpcContext["res"],
    sessionId: null,
    nativeClientId: null,
    user: {
      id: user.id,
      openId: `u-${user.id}`,
      name: `User ${user.id}`,
      email: `u${user.id}@t.test`,
      role: user.role,
      branchId: user.branchId,
      isOwner: Boolean(user.isOwner),
      isActive: true,
      permissionsOverride: null,
    } as unknown as TrpcContext["user"],
  };
  return appRouter.createCaller(ctx);
}

async function approveAndReadyWorkOrder(workOrderId: number, key: string) {
  const approval = await requestWorkOrderDesignApproval(
    {
      workOrderId,
      requestKey: `${key}-design-req-${randomUUID()}`,
      note: "اعتماد التصميم",
    },
    CASHIER,
  );
  await decideWorkOrderDesignApproval(
    {
      approvalId: Number(approval.approval.id),
      decisionKey: `${key}-design-ok-${randomUUID()}`,
      decision: "APPROVED",
      reason: "تم اعتماد التصميم",
      evidence: {
        type: "WHATSAPP_MESSAGE",
        reference: `wamid.${randomUUID()}`,
      },
    },
    MANAGER,
  );
  await startWorkOrder(workOrderId, CASHIER);
  await markWorkOrderReady(workOrderId, CASHIER);
}

beforeEach(async () => {
  await truncateTables(TABLES);
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
  ]);
  await d.insert(s.users).values([
    {
      id: 1,
      openId: "mgr-1",
      name: "مدير الفرع",
      email: "mgr@t.test",
      role: "manager",
      loginMethod: "local",
      branchId: 1,
    },
    {
      id: 2,
      openId: "cashier-2",
      name: "موظف الاستقبال",
      email: "cashier@t.test",
      role: "cashier",
      loginMethod: "local",
      branchId: 1,
    },
    {
      id: 3,
      openId: "mgr-3",
      name: "مدير مراجع",
      email: "rev@t.test",
      role: "manager",
      loginMethod: "local",
      branchId: 1,
    },
    {
      id: 4,
      openId: "owner-4",
      name: "المالك",
      email: "owner@t.test",
      role: "admin",
      loginMethod: "local",
      branchId: 1,
      isOwner: true,
    },
  ]);
  await d.insert(s.serviceTypes).values({
    name: "موافقة تصميم",
    defaultKind: "SERVICE_REQUEST",
    defaultPriority: "HIGH",
    slaHours: 24,
    blocksExecution: true,
    isActive: true,
  });
  await d.insert(s.customers).values([
    {
      id: 1,
      name: "عميل المطبعة",
      phone: "+9647701112233",
      currentBalance: "0.00",
      creditLimit: null,
    },
  ]);
  await d.insert(s.deliveryParties).values([
    {
      id: 1,
      name: "شركة التوصيل الأولى",
      partyType: "COMPANY",
      currentBalance: "0.00",
      defaultFee: "5000.00",
      isActive: true,
    },
    {
      id: 2,
      name: "مندوب داخلي",
      partyType: "INDIVIDUAL",
      currentBalance: "0.00",
      defaultFee: "4000.00",
      isActive: true,
    },
  ]);
  await d.insert(s.products).values([{ id: 1, name: "ورق كوشيه" }]);
  await d.insert(s.productVariants).values([
    { id: 1, productId: 1, sku: "MAT-1", costPrice: "1000.00" },
  ]);
  await d.insert(s.productUnits).values([
    {
      id: 1,
      variantId: 1,
      unitName: "قطعة",
      conversionFactor: "1",
      isBaseUnit: true,
    },
  ]);
  await d.insert(s.branchStock).values([
    { variantId: 1, branchId: 1, quantity: 200 },
  ]);
  await d.insert(s.shifts).values([
    {
      id: 1,
      branchId: 1,
      userId: 2,
      shiftType: "RECEPTION",
      status: "OPEN",
      openingCash: "500000.00",
    },
  ] as never);
});

describe("Work Order READY Lifecycle & Fulfillment Surgical Remediation", () => {
  it("heals cnId=58 hybrid prepaid fee balance via EARN_ONLY, blocks duplicate EARN_AND_DIRECT_PAID, and suppresses BACKFILL FEE_PAID when FEE_OFFSET exists", async () => {
    const d = db();
    await d.insert(s.invoices).values({
      id: 58,
      invoiceNumber: "INV-LEGACY-58",
      branchId: 1,
      customerId: 1,
      sourceType: "WORKORDER",
      subtotal: "25000.00",
      total: "25000.00",
      paidAmount: "25000.00",
      status: "PAID",
      createdBy: 2,
    } as never);
    await d.insert(s.workOrders).values({
      id: 58,
      orderNumber: "WO-LEGACY-58",
      branchId: 1,
      customerId: 1,
      invoiceId: 58,
      title: "مطبوعات مدفوعة",
      quantity: 1,
      salePrice: "25000.00",
      deposit: "25000.00",
      hasDelivery: true,
      deliveryCost: "5000.00",
      deliveryFeeCollection: "COURIER",
      status: "READY",
      createdBy: 2,
    } as never);
    const settledAt = new Date("2026-08-20T10:00:00Z");
    await d.insert(s.deliveryConsignments).values({
      id: 58,
      consignmentNumber: "CN-LEGACY-58",
      branchId: 1,
      partyId: 1,
      invoiceId: 58,
      workOrderId: 58,
      sourceType: "WORK_ORDER",
      sourceId: 58,
      codAmount: "0.00",
      collectedAmount: "0.00",
      deliveryFee: "5000.00",
      feeCollection: "COURIER",
      externalTrackingRef: "TRK-58",
      parcelStatus: "OUT_FOR_DELIVERY",
      moneyStatus: "NOT_APPLICABLE",
      status: "DELIVERED",
      settledAt,
      feeSettledAt: settledAt,
    } as never);
    await d.insert(s.deliveryLedgerEntries).values({
      eventKey: "BACKFILL:CN:58:FEE_PAID",
      partyId: 1,
      consignmentId: 58,
      branchId: 1,
      entryType: "FEE_PAID",
      amount: "5000.00",
      notes: "0178 backfill",
      occurredAt: settledAt,
    } as never);

    const findings = await getDeliveryLegacyFindings({ branchId: 1 });
    expect(
      findings.prepaidClosedWithoutProof.some((r) => Number(r.id) === 58),
    ).toBe(true);

    const auditCtx = {
      req: { headers: {} } as unknown as TrpcContext["req"],
      user: { id: 4, role: "admin", branchId: 1 } as unknown as TrpcContext["user"],
    };
    await expect(
      repairDeliveryLegacyRow(
        {
          action: "RECORD_PREPAID_DELIVERY_PROOF",
          targetId: 58,
          confirmation: "CN-LEGACY-58",
          note: "محاولة مضاعفة خاطئة",
          deliveredAt: "2026-08-21T12:00:00Z",
          evidenceRef: "RCPT-58",
          feeSettlementAction: "EARN_AND_DIRECT_PAID",
        },
        auditCtx,
      ),
    ).rejects.toThrow(/مسدّدة أو مسوّاة مسبقاً/);

    await repairDeliveryLegacyRow(
      {
        action: "RECORD_PREPAID_DELIVERY_PROOF",
        targetId: 58,
        confirmation: "CN-LEGACY-58",
        note: "إثبات تسليم فعلي وموازنة استحقاق الأجرة",
        deliveredAt: "2026-08-21T12:00:00Z",
        evidenceRef: "RCPT-58",
        feeSettlementAction: "EARN_ONLY",
      },
      auditCtx,
    );

    const [feeCheck] = await d
      .select({ feeDue: consignmentFeeDueSql() })
      .from(s.deliveryConsignments)
      .where(eq(s.deliveryConsignments.id, 58));
    expect(Number(feeCheck?.feeDue ?? -1)).toBe(0);

    const [healedWo] = await d
      .select({ status: s.workOrders.status })
      .from(s.workOrders)
      .where(eq(s.workOrders.id, 58));
    expect(healedWo?.status).toBe("DELIVERED");

    // Verify FEE_OFFSET suppresses BACKFILL:CN:<id>:FEE_PAID (#588/#780/#821/#1907 pattern)
    await d.insert(s.deliveryConsignments).values({
      id: 1907,
      consignmentNumber: "CN-1907",
      branchId: 1,
      partyId: 1,
      sourceType: "INVOICE",
      sourceId: 58,
      codAmount: "0.00",
      collectedAmount: "0.00",
      deliveryFee: "5000.00",
      feeCollection: "SHOP",
      externalTrackingRef: "TRK-1907",
      parcelStatus: "DELIVERED",
      moneyStatus: "NOT_APPLICABLE",
      status: "DELIVERED",
      courierDeliveredAt: settledAt,
      feeSettledAt: settledAt,
    } as never);
    await d.insert(s.deliveryLedgerEntries).values([
      {
        eventKey: "CN:1907:SHOP_FEE_EARNED",
        partyId: 1,
        consignmentId: 1907,
        branchId: 1,
        entryType: "FEE_EARNED",
        amount: "5000.00",
        occurredAt: settledAt,
      },
      {
        eventKey: "CN:1907:SHOP_FEE_OFFSET",
        partyId: 1,
        consignmentId: 1907,
        branchId: 1,
        entryType: "FEE_OFFSET",
        amount: "5000.00",
        occurredAt: settledAt,
      },
      {
        eventKey: "BACKFILL:CN:1907:FEE_PAID",
        partyId: 1,
        consignmentId: 1907,
        branchId: 1,
        entryType: "FEE_PAID",
        amount: "5000.00",
        occurredAt: settledAt,
      },
    ] as never);

    const raw1907 = await d
      .select()
      .from(s.deliveryLedgerEntries)
      .where(eq(s.deliveryLedgerEntries.consignmentId, 1907));
    const effective1907 = verifiedConsignmentLedgerRows(
      { id: 1907, partyId: 1, branchId: 1 },
      raw1907,
      "فحص الدفتر",
    );
    expect(effective1907.map((r) => r.eventKey)).toEqual([
      "CN:1907:SHOP_FEE_EARNED",
      "CN:1907:SHOP_FEE_OFFSET",
    ]);
    const [due1907] = await d
      .select({ feeDue: consignmentFeeDueSql() })
      .from(s.deliveryConsignments)
      .where(eq(s.deliveryConsignments.id, 1907));
    expect(Number(due1907?.feeDue ?? -1)).toBe(0);
  });

  it("tracks WORK_ORDER_OUTPUT custody, preserves reassign on active request, and releases fulfillmentRequestItems on standalone cancel for direct pickup (#115147)", async () => {
    const d = db();
    const created = await createWorkOrder(
      {
        branchId: 1,
        customerId: 1,
        baseVariantId: 1,
        title: "بروشورات ملونة",
        quantity: 2,
        salePrice: "40000.00",
        deposit: "10000.00",
        paymentMethod: "CASH",
        shiftId: 1,
        hasDelivery: true,
        deliveryAddress: "بغداد - الكرادة",
        deliveryPhone: "07701112233",
        deliveryCost: "4000.00",
        deliveryFeeCollection: "COURIER",
        materials: [{ variantId: 1, baseQuantity: 2 }],
        clientRequestId: "wo-115147-create",
      } as never,
      { ...CASHIER, shiftId: 1 } as never,
    );
    const woId = Number((created as { workOrderId: number }).workOrderId);
    await approveAndReadyWorkOrder(woId, "wo-115147");

    const fr = await createFulfillmentRequest(
      {
        branchId: 1,
        customerId: 1,
        recipientName: "عميل المطبعة",
        recipientPhone: "07701112233",
        deliveryAddress: "بغداد - الكرادة",
        partyId: 2,
        deliveryFee: "4000.00",
        feeCollection: "COURIER",
        sources: [{ workOrderId: woId }],
        clientRequestId: "fr-115147-create",
      },
      ADMIN,
    );
    const readyFr = await readyFulfillmentRequest(
      {
        id: fr.id,
        expectedVersion: fr.version,
        clientRequestId: "fr-115147-ready",
      },
      ADMIN,
    );
    const released = await releaseFulfillmentRequest(
      {
        id: fr.id,
        expectedVersion: readyFr.version,
        clientRequestId: "fr-115147-release",
      },
      ADMIN,
    );
    const cnId = Number(released.consignmentId);

    // Custody must be WORK_ORDER_OUTPUT (NOT STOCKED_ITEM / REVIEW_REQUIRED)
    const custodyAfterRelease = await d
      .select()
      .from(deliveryCustodyItems)
      .where(eq(deliveryCustodyItems.consignmentId, cnId));
    expect(custodyAfterRelease).toHaveLength(1);
    expect(custodyAfterRelease[0]!.itemKind).toBe("WORK_ORDER_OUTPUT");
    expect(custodyAfterRelease[0]!.reviewStatus).toBe("NOT_REQUIRED");

    // Reassigning fulfillment request to another party must keep item active and succeed
    const currentFr = (
      await d
        .select()
        .from(s.workOrders)
        .where(eq(s.workOrders.id, woId))
    )[0]!;
    expect(currentFr.status).toBe("READY");
    expect(currentFr.invoiceId).not.toBeNull();

    // WIP report must exclude invoiced READY work orders (already moved WIP -> COGS)
    const wipDuringDelivery = await getWIPReport({ branchId: 1 });
    expect(
      wipDuringDelivery.rows.some((r) => r.workOrderId === woId),
    ).toBe(false);

    // Standalone cancelShipmentAssignment frees fulfillmentRequestItems.isActive = false
    await cancelShipmentAssignment(
      {
        consignmentId: cnId,
        reason: "الزبون يستلم الطلب حضورياً من الفرع",
        physicalHeldConfirmed: true,
        clientRequestId: "cancel-cn-115147",
      },
      ADMIN,
    );
    const [friAfterCancel] = await d
      .select()
      .from(fulfillmentRequestItems)
      .where(eq(fulfillmentRequestItems.workOrderId, woId));
    expect(friAfterCancel?.isActive).toBe(false);

    // Convert to direct pickup & deliver over the counter without double-invoicing
    const originalInvoiceId = Number(currentFr.invoiceId);
    await updateWorkOrderDeliveryMethod(
      {
        workOrderId: woId,
        hasDelivery: false,
      },
      CASHIER,
    );
    const delivered = await deliverWorkOrder(
      {
        workOrderId: woId,
        payment: { amount: "30000.00", method: "CASH" },
        clientRequestId: "wo-115147-counter-deliver",
      },
      { ...CASHIER, shiftId: 1 } as never,
    );
    expect(delivered.invoiceId).toBe(originalInvoiceId);

    const [finalWo] = await d
      .select()
      .from(s.workOrders)
      .where(eq(s.workOrders.id, woId));
    expect(finalWo?.status).toBe("DELIVERED");

    const [custodyAfterCounter] = await d
      .select()
      .from(deliveryCustodyItems)
      .where(eq(deliveryCustodyItems.consignmentId, cnId));
    expect(custodyAfterCounter?.customerDeliveredBaseQuantity).toBe(
      custodyAfterCounter?.baseQuantity,
    );
    expect(custodyAfterCounter?.preparedHeldBaseQuantity).toBe(0);
  });

  it("allows reverseWorkOrderDelivery on invoiced READY orders without duplicating COD_RELEASED and releases customerReceiptAllocations", async () => {
    const d = db();
    const created = await createWorkOrder(
      {
        branchId: 1,
        customerId: 1,
        title: "دفاتر وصولات",
        quantity: 5,
        salePrice: "50000.00",
        deposit: "0",
        hasDelivery: true,
        deliveryAddress: "بغداد - المنصور",
        deliveryPhone: "07701112233",
        deliveryCost: "5000.00",
        deliveryFeeCollection: "COURIER",
        materials: [{ variantId: 1, baseQuantity: 3 }],
        clientRequestId: "wo-ready-rev-create",
      } as never,
      CASHIER as never,
    );
    const woId = Number((created as { workOrderId: number }).workOrderId);
    await approveAndReadyWorkOrder(woId, "wo-ready-rev");

    const dispatched = await dispatchToDelivery(
      {
        workOrderId: woId,
        partyId: 2,
        deliveryFee: "5000.00",
        clientRequestId: "wo-ready-rev-dispatch",
      },
      ADMIN,
    );
    await cancelShipmentAssignment(
      {
        consignmentId: dispatched.consignmentId,
        reason: "إلغاء الإسناد بطلب الزبون",
        physicalHeldConfirmed: true,
        clientRequestId: "cancel-cn-ready-rev",
      },
      ADMIN,
    );

    // Attach a general customer receipt allocation to the invoice to verify release on reverse
    const [rcptRes] = await d.insert(s.receipts).values({
      voucherNumber: "RCV-ALLOC-1",
      branchId: 1,
      customerId: 1,
      invoiceId: dispatched.invoiceId,
      direction: "IN",
      paymentMethod: "CASH",
      amount: "15000.00",
      status: "COMPLETED",
      shiftId: 1,
      createdBy: 2,
    } as never);
    const receiptId = Number((rcptRes as unknown as { insertId: number }).insertId);
    const [stlRes] = await d.insert(s.customerReceiptSettlements).values({
      receiptId,
      customerId: 1,
      branchId: 1,
      amount: "15000.00",
      accountAmount: "15000.00",
      unallocatedAmount: "0.00",
      initialUnallocatedAmount: "0.00",
      refundedAmount: "0.00",
      sourceHash: "0".repeat(64),
      createdBy: 2,
    });
    const settlementId = Number((stlRes as unknown as { insertId: number }).insertId);
    await d.insert(s.customerReceiptAllocations).values({
      settlementId,
      invoiceId: dispatched.invoiceId,
      originalInvoiceId: dispatched.invoiceId,
      originalAmount: "15000.00",
      amount: "15000.00",
    });
    await d
      .update(s.invoices)
      .set({ paidAmount: "15000.00", status: "PARTIALLY_PAID" })
      .where(eq(s.invoices.id, dispatched.invoiceId));
    await d
      .update(s.customers)
      .set({ currentBalance: "35000.00" })
      .where(eq(s.customers.id, 1));

    const preflight = await getWorkOrderReverseDeliveryPreflight(woId, MANAGER);
    expect(preflight.eligible).toBe(true);
    if (!preflight.eligible) throw new Error("Expected eligible preflight");
    expect(preflight.status).toBe("READY");

    const reqRes = await requestWorkOrderControl(
      {
        requestType: "REVERSE_DELIVERY",
        requestKey: "wo-ready-rev-ctrl",
        workOrderId: woId,
        baseVersion: preflight.version,
        reason: "إلغاء الفاتورة وإرجاع العربون بعد إلغاء التوصيل",
        payload: {
          expectedVersion: preflight.version,
          reopen: false,
          refundShiftId: 1,
          refundSources: preflight.refundSources,
        },
      },
      MANAGER,
    );
    if (reqRes.status === "PENDING") {
      await approveWorkOrderControlRequest(
        Number(reqRes.id),
        { userId: 3, branchId: 1, role: "manager" },
        "موافقة",
      );
    }

    const [woAfter] = await d
      .select()
      .from(s.workOrders)
      .where(eq(s.workOrders.id, woId));
    expect(woAfter?.status).toBe("CANCELLED");
    expect(woAfter?.invoiceId).toBeNull();

    const codReleasedRows = await d
      .select()
      .from(s.deliveryLedgerEntries)
      .where(
        and(
          eq(s.deliveryLedgerEntries.consignmentId, dispatched.consignmentId),
          eq(s.deliveryLedgerEntries.entryType, "COD_RELEASED"),
        ),
      );
    expect(codReleasedRows).toHaveLength(1);

    const [allocAfter] = await d
      .select()
      .from(s.customerReceiptAllocations)
      .where(eq(s.customerReceiptAllocations.settlementId, settlementId));
    expect(Number(allocAfter?.amount ?? 0)).toBe(0);
  });

  it("isolates Z-Report shiftId during shelfAuditDeliverWorkOrders, consumes externalPaymentAttemptId once, enforces baseCode siblings, and routes unique INV- barcodes", async () => {
    const d = db();

    // 1) Shelf audit must keep invoices.shiftId = NULL even when manager has an open shift
    await d.insert(s.shifts).values({
      id: 9,
      branchId: 1,
      userId: 1,
      shiftType: "RECEPTION",
      status: "OPEN",
      openingCash: "100000.00",
    } as never);
    const shelfCreated = await createWorkOrder(
      {
        branchId: 1,
        customerId: 1,
        title: "كروت شخصية مدفوعة",
        quantity: 1,
        salePrice: "15000.00",
        deposit: "15000.00",
        paymentMethod: "CASH",
        shiftId: 1,
        hasDelivery: false,
        clientRequestId: "wo-shelf-1",
      } as never,
      { ...CASHIER, shiftId: 1 } as never,
    );
    const shelfWoId = Number(
      (shelfCreated as { workOrderId: number }).workOrderId,
    );
    await approveAndReadyWorkOrder(shelfWoId, "wo-shelf");

    const shelfRes = await shelfAuditDeliverWorkOrders(
      {
        workOrderIds: [shelfWoId],
        confirmationPhrase: "جرد وتسليم",
        branchId: 1,
      },
      MANAGER,
    );
    expect(shelfRes.deliveredCount).toBe(1);
    const [shelfWo] = await d
      .select()
      .from(s.workOrders)
      .where(eq(s.workOrders.id, shelfWoId));
    const [shelfInv] = await d
      .select()
      .from(s.invoices)
      .where(eq(s.invoices.id, Number(shelfWo!.invoiceId)));
    expect(shelfInv?.shiftId).toBeNull();

    // 2) externalPaymentAttemptId must be consumed atomically on deliverWorkOrder
    const cardWoCreated = await createWorkOrder(
      {
        branchId: 1,
        customerId: 1,
        title: "فلايرات دفع إلكتروني",
        quantity: 1,
        salePrice: "20000.00",
        deposit: "0",
        hasDelivery: false,
        clientRequestId: "wo-card-1",
      } as never,
      CASHIER as never,
    );
    const cardWoId = Number(
      (cardWoCreated as { workOrderId: number }).workOrderId,
    );
    await approveAndReadyWorkOrder(cardWoId, "wo-card");

    const initiated = await initiateExternalPaymentAttempt(
      {
        branchId: 1,
        channel: "SALES_COLLECTION",
        method: "CARD",
        amount: "20000.00",
        reference: "POS-REF-9911",
        requestId: "ext-init-1",
        deviceId: "dev-reception-1",
      },
      CASHIER,
    );
    await confirmExternalPaymentAttempt(
      {
        attemptId: Number(initiated.attemptId),
        branchId: 1,
        channel: "SALES_COLLECTION",
        deviceId: "dev-reception-1",
      },
      CASHIER,
    );
    await deliverWorkOrder(
      {
        workOrderId: cardWoId,
        payment: {
          amount: "20000.00",
          method: "CARD",
          reference: "POS-REF-9911",
          externalPaymentAttemptId: Number(initiated.attemptId),
          externalPaymentDeviceId: "dev-reception-1",
        },
        clientRequestId: "wo-card-deliver-1",
      },
      CASHIER,
    );
    const [consumedAttempt] = await d
      .select()
      .from(s.externalPaymentAttempts)
      .where(eq(s.externalPaymentAttempts.id, Number(initiated.attemptId)));
    expect(consumedAttempt?.consumedAt).not.toBeNull();
    expect(consumedAttempt?.invoiceId).toBeGreaterThan(0);

    // 3) Split siblings by baseCode (draftId = null) block partial delivery unless confirmed
    await d.insert(s.workOrders).values([
      {
        id: 701,
        orderNumber: "110999-1",
        branchId: 1,
        customerId: 1,
        draftId: null,
        title: "بند شقيق ١",
        quantity: 1,
        salePrice: "10000.00",
        deposit: "10000.00",
        hasDelivery: false,
        status: "READY",
        createdBy: 2,
      },
      {
        id: 702,
        orderNumber: "110999-2",
        branchId: 1,
        customerId: 1,
        draftId: null,
        title: "بند شقيق ٢",
        quantity: 1,
        salePrice: "10000.00",
        deposit: "10000.00",
        hasDelivery: false,
        status: "IN_PROGRESS",
        createdBy: 2,
      },
    ] as never);
    await d.insert(s.receipts).values({
      voucherNumber: "RCV-701",
      branchId: 1,
      customerId: 1,
      workOrderId: 701,
      direction: "IN",
      paymentMethod: "CASH",
      amount: "10000.00",
      status: "COMPLETED",
      shiftId: 1,
      createdBy: 2,
    } as never);

    await expect(
      deliverWorkOrder(
        { workOrderId: 701, clientRequestId: "sib-unconfirmed" },
        CASHIER,
      ),
    ).rejects.toThrow(/110999-2/);

    const confirmedPartial = await deliverWorkOrder(
      {
        workOrderId: 701,
        partialDispatchConfirmed: true,
        clientRequestId: "sib-confirmed",
      },
      CASHIER,
    );
    expect(confirmedPartial.invoiceId).toBeGreaterThan(0);

    // 4) INV-... barcode routes to unique owning workOrder in getByNumber
    await d.insert(s.invoices).values({
      id: 880,
      invoiceNumber: "INV-88001",
      branchId: 1,
      customerId: 1,
      sourceType: "WORKORDER",
      subtotal: "12000.00",
      total: "12000.00",
      paidAmount: "0.00",
      status: "UNPAID",
      createdBy: 2,
    } as never);
    await d.insert(s.workOrders).values({
      id: 881,
      orderNumber: "WO-88001",
      branchId: 1,
      customerId: 1,
      invoiceId: 880,
      title: "ختم حراري",
      quantity: 1,
      salePrice: "12000.00",
      deposit: "0.00",
      hasDelivery: false,
      status: "READY",
      createdBy: 2,
    } as never);
    const caller = makeCaller({ id: 2, branchId: 1, role: "cashier" });
    const lookedUp = await caller.workOrders.getByNumber({
      orderNumber: "INV-88001",
    });
    expect(lookedUp?.kind).toBe("workOrder");
    expect(lookedUp?.id).toBe(881);
  });
});
