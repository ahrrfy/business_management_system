import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  createPurchaseOrder,
  createPurchaseRequisition,
  decidePurchaseOrderControl,
  decidePurchaseRequisitionControl,
  requestPurchaseOrderControl,
  submitPurchaseOrderForApproval,
  submitPurchaseRequisition,
  updatePurchaseControlSettings,
  updatePurchaseOrder,
} from "../purchaseService";

const creator = { userId: 1, branchId: 1, role: "manager" as const };
const firstApprover = { userId: 2, branchId: 1, role: "manager" as const };
const secondApprover = { userId: 3, branchId: 1, role: "manager" as const };

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

async function reset() {
  await db().execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of [
    "idempotencyKeys",
    "purchaseOrderEvents",
    "purchaseOrderControlRequests",
    "purchaseOrderRequisitionAllocations",
    "purchaseOrderRevisionItems",
    "purchaseOrderRevisions",
    "purchaseRequisitionControlRequests",
    "purchaseRequisitionItems",
    "purchaseRequisitions",
    "purchaseControlSettings",
    "purchaseOrderItems",
    "purchaseOrders",
    "productUnits",
    "productVariants",
    "products",
    "suppliers",
    "branches",
    "users",
  ]) {
    await db().execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
  }
  await db().execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seed() {
  await db()
    .insert(schema.branches)
    .values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await db()
    .insert(schema.users)
    .values([
      {
        id: 1,
        openId: "po-gov-creator",
        name: "المنشئ",
        role: "manager",
        loginMethod: "local",
        branchId: 1,
      },
      {
        id: 2,
        openId: "po-gov-a1",
        name: "المعتمد الأول",
        role: "manager",
        loginMethod: "local",
        branchId: 1,
      },
      {
        id: 3,
        openId: "po-gov-a2",
        name: "المعتمد الثاني",
        role: "manager",
        loginMethod: "local",
        branchId: 1,
      },
    ]);
  await db()
    .insert(schema.suppliers)
    .values({ id: 1, name: "مورد الاختبار", currentBalance: "0" });
  await db().insert(schema.products).values({ id: 1, name: "ورق" });
  await db()
    .insert(schema.productVariants)
    .values({ id: 1, productId: 1, sku: "PAPER", costPrice: "0" });
  await db().insert(schema.productUnits).values({
    id: 1,
    variantId: 1,
    unitName: "قطعة",
    conversionFactor: "1",
    isBaseUnit: true,
  });
}

async function createDraft(
  key: string,
  allocations?: Array<{
    lineNo: number;
    requisitionItemId: number;
    allocatedBaseQuantity: number;
  }>,
) {
  return createPurchaseOrder(
    {
      supplierId: 1,
      branchId: 1,
      clientRequestId: key,
      revisionReason: "إنشاء أمر شراء للاختبار",
      requisitionAllocations: allocations,
      items: [
        { variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "100.00" },
      ],
    },
    creator,
  );
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe("S1 — مراجعات وقرارات أمر الشراء", () => {
  it("ينشئ مراجعة ثابتة ويرفض التعديل بنسخة قديمة", async () => {
    const created = await createDraft("po-revision-create");
    const revisions = await db()
      .select()
      .from(schema.purchaseOrderRevisions)
      .where(
        eq(
          schema.purchaseOrderRevisions.purchaseOrderId,
          created.purchaseOrderId,
        ),
      );
    expect(revisions).toHaveLength(1);
    expect(created.revisionId).toBe(Number(revisions[0].id));

    await expect(
      updatePurchaseOrder(
        {
          purchaseOrderId: created.purchaseOrderId,
          expectedVersion: created.version - 1,
          revisionReason: "تعديل متعارض",
          supplierId: 1,
          items: [
            {
              variantId: 1,
              productUnitId: 1,
              quantity: "11",
              unitPrice: "100.00",
            },
          ],
        },
        creator,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const updated = await updatePurchaseOrder(
      {
        purchaseOrderId: created.purchaseOrderId,
        expectedVersion: created.version,
        revisionReason: "زيادة الكمية المطلوبة",
        supplierId: 1,
        items: [
          {
            variantId: 1,
            productUnitId: 1,
            quantity: "11",
            unitPrice: "100.00",
          },
        ],
      },
      creator,
    );
    expect(updated.revisionNo).toBe(2);
    expect(updated.version).toBeGreaterThan(created.version);
  });

  it("إنشاء طلب الاعتماد لا يعتمد الأمر، والقرار يفرض maker-checker وexact replay", async () => {
    const created = await createDraft("po-control-create");
    const submitted = await submitPurchaseOrderForApproval(
      {
        purchaseOrderId: created.purchaseOrderId,
        expectedVersion: created.version,
        requestKey: "po-submit-1",
        reason: "إرسال الأسعار والكميات للمراجعة",
      },
      creator,
    );
    const [before] = await db()
      .select()
      .from(schema.purchaseOrders)
      .where(eq(schema.purchaseOrders.id, created.purchaseOrderId));
    expect(before.status).toBe("SENT");
    expect(before.approvedRevisionId).toBeNull();

    await expect(
      decidePurchaseOrderControl(
        {
          requestId: submitted.requestId,
          decisionKey: "po-self-decision",
          approve: true,
          reason: "اعتماد ذاتي",
        },
        creator,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const decision = {
      requestId: submitted.requestId,
      decisionKey: "po-independent-decision",
      approve: true,
      reason: "راجعت الكميات والأسعار والمورّد",
    };
    await expect(
      decidePurchaseOrderControl(decision, firstApprover, {
        legacyConfirmOnly: true,
      }),
    ).resolves.toMatchObject({
      status: "APPROVED",
      orderStatus: "CONFIRMED",
      idempotent: false,
    });
    await expect(
      decidePurchaseOrderControl(decision, firstApprover, {
        legacyConfirmOnly: true,
      }),
    ).resolves.toMatchObject({ idempotent: true });
    await expect(
      decidePurchaseOrderControl(
        { ...decision, reason: "قرار مختلف" },
        firstApprover,
        { legacyConfirmOnly: true },
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("الطلب الطارئ يحتاج اعتماداً أول ثم معتمداً ثانياً مستقلاً للأمر", async () => {
    await updatePurchaseControlSettings(
      {
        branchId: 1,
        expectedVersion: 0,
        requireRequisition: true,
        allowEmergencyOrder: true,
        requireEmergencyApproval: true,
        priceTolerancePercent: "0",
        totalToleranceAmount: "0",
        blockUninvoicedReceiptsAtClose: true,
      },
      creator,
    );
    const created = await createDraft("po-emergency-create");
    const emergency = await requestPurchaseOrderControl(
      {
        purchaseOrderId: created.purchaseOrderId,
        revisionId: created.revisionId,
        expectedVersion: created.version,
        kind: "EMERGENCY_ORDER",
        requestKey: "po-emergency-request",
        reason: "شراء طارئ لانقطاع المخزون",
      },
      creator,
    );
    await decidePurchaseOrderControl(
      {
        requestId: emergency.requestId,
        decisionKey: "po-emergency-approve",
        approve: true,
        reason: "تحققت حالة الانقطاع",
      },
      firstApprover,
    );
    const submitted = await submitPurchaseOrderForApproval(
      {
        purchaseOrderId: created.purchaseOrderId,
        expectedVersion: created.version,
        requestKey: "po-emergency-submit",
        reason: "إرسال الأمر الطارئ للاعتماد النهائي",
      },
      creator,
    );
    await expect(
      decidePurchaseOrderControl(
        {
          requestId: submitted.requestId,
          decisionKey: "po-emergency-same-approver",
          approve: true,
          reason: "اعتماد نهائي",
        },
        firstApprover,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      decidePurchaseOrderControl(
        {
          requestId: submitted.requestId,
          decisionKey: "po-emergency-second-approver",
          approve: true,
          reason: "اعتماد ثان مستقل",
        },
        secondApprover,
        { legacyConfirmOnly: true },
      ),
    ).resolves.toMatchObject({ orderStatus: "CONFIRMED" });
  });

  it("الإلغاء طلب صفري الأثر ولا يطبّق إلا بقرار مستقل", async () => {
    const created = await createDraft("po-cancel-create");
    const request = await requestPurchaseOrderControl(
      {
        purchaseOrderId: created.purchaseOrderId,
        revisionId: created.revisionId,
        expectedVersion: created.version,
        kind: "CANCEL_ORDER",
        requestKey: "po-cancel-request",
        reason: "المورّد ألغى العرض",
      },
      creator,
    );
    expect(
      (
        await db()
          .select()
          .from(schema.purchaseOrders)
          .where(eq(schema.purchaseOrders.id, created.purchaseOrderId))
      )[0].status,
    ).toBe("DRAFT");
    await decidePurchaseOrderControl(
      {
        requestId: request.requestId,
        decisionKey: "po-cancel-decision",
        approve: true,
        reason: "تحققت من إلغاء العرض",
      },
      firstApprover,
    );
    expect(
      (
        await db()
          .select()
          .from(schema.purchaseOrders)
          .where(eq(schema.purchaseOrders.id, created.purchaseOrderId))
      )[0].status,
    ).toBe("CANCELLED");
  });
});

describe("S2 — طلبات الشراء والتخصيص", () => {
  it("يعتمد الطلب بفصل مهام ويمنع تجاوز الكمية عند ربط أمر الشراء", async () => {
    const requisition = await createPurchaseRequisition(
      {
        branchId: 1,
        purpose: "تغطية احتياج الورق اليومي",
        clientRequestId: "req-create-1",
        items: [
          {
            variantId: 1,
            productUnitId: 1,
            requestedBaseQuantity: 10,
            justification: "الرصيد أقل من الحد",
          },
        ],
      },
      creator,
    );
    const submitted = await submitPurchaseRequisition(
      {
        requisitionId: requisition.requisitionId,
        expectedVersion: 1,
        requestKey: "req-submit-1",
        reason: "إرسال الاحتياج للمراجعة",
      },
      creator,
    );
    await expect(
      decidePurchaseRequisitionControl(
        {
          requestId: submitted.requestId,
          decisionKey: "req-self",
          approve: true,
          reason: "اعتماد ذاتي",
        },
        creator,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await decidePurchaseRequisitionControl(
      {
        requestId: submitted.requestId,
        decisionKey: "req-approve",
        approve: true,
        reason: "الاحتياج مؤيد",
      },
      firstApprover,
    );
    const [item] = await db()
      .select()
      .from(schema.purchaseRequisitionItems)
      .where(
        eq(
          schema.purchaseRequisitionItems.requisitionId,
          requisition.requisitionId,
        ),
      );
    await expect(
      createDraft("po-over-allocation", [
        {
          lineNo: 1,
          requisitionItemId: Number(item.id),
          allocatedBaseQuantity: 11,
        },
      ]),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      createDraft("po-valid-allocation", [
        {
          lineNo: 1,
          requisitionItemId: Number(item.id),
          allocatedBaseQuantity: 10,
        },
      ]),
    ).resolves.toMatchObject({ status: "DRAFT" });
    const [after] = await db()
      .select()
      .from(schema.purchaseRequisitionItems)
      .where(eq(schema.purchaseRequisitionItems.id, item.id));
    expect(Number(after.orderedBaseQuantity)).toBe(10);
  });
});
