import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import {
  confirmPurchaseOrder,
  createPurchaseOrder,
  updatePurchaseOrder,
} from "../purchaseService";
import { decidePurchaseOrderControl } from "../purchase/controls";

const creator = { userId: 1, branchId: 1, role: "admin" as const };
const approver = { userId: 2, branchId: 1, role: "manager" as const };
const editor = { userId: 3, branchId: 1, role: "manager" as const };
const otherBranch = { userId: 4, branchId: 2, role: "manager" as const };

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

async function reset() {
  await db().execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of [
    "idempotencyKeys",
    "auditLogs",
    "purchaseOrderEvents",
    "purchaseOrderControlRequests",
    "purchaseOrderRequisitionAllocations",
    "purchaseOrderRevisionItems",
    "purchaseOrderRevisions",
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
  await db().insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
    { id: 2, name: "الفرع الثاني", code: "B2", type: "SALES" },
  ]);
  await db().insert(s.users).values([
    { id: 1, openId: "po-creator", name: "المنشئ", role: "admin", loginMethod: "local", branchId: 1 },
    { id: 2, openId: "po-approver", name: "المعتمد", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 3, openId: "po-editor", name: "المحرر", role: "manager", loginMethod: "local", branchId: 1 },
    { id: 4, openId: "po-other-branch", name: "فرع آخر", role: "manager", loginMethod: "local", branchId: 2 },
  ]);
  await db().insert(s.suppliers).values({ id: 1, name: "مورد الاختبار", currentBalance: "0" });
  await db().insert(s.products).values({ id: 1, name: "ورق" });
  await db().insert(s.productVariants).values({ id: 1, productId: 1, sku: "PAPER-1", costPrice: "0.00" });
  await db().insert(s.productUnits).values({
    id: 1,
    variantId: 1,
    unitName: "قطعة",
    conversionFactor: "1",
    isBaseUnit: true,
  });
}

async function createDraft(clientRequestId: string) {
  return createPurchaseOrder(
    {
      supplierId: 1,
      branchId: 1,
      status: "DRAFT",
      clientRequestId,
      items: [{ variantId: 1, productUnitId: 1, quantity: "1", unitPrice: "10.00" }],
    },
    creator,
  );
}

const approval = (
  purchaseOrderId: number,
  expectedVersion: number,
  clientRequestId: string,
  reason = "مراجعة البنود والأسعار",
) => ({
  purchaseOrderId,
  expectedVersion,
  clientRequestId,
  reason,
});

async function currentVersion(purchaseOrderId: number) {
  const [row] = await db().select({ version: s.purchaseOrders.version })
    .from(s.purchaseOrders).where(eq(s.purchaseOrders.id, purchaseOrderId));
  return Number(row.version);
}

const decide = (requestId: number, key: string, reviewer = approver) =>
  decidePurchaseOrderControl({
    requestId,
    decisionKey: key,
    approve: true,
    reason: "راجعت المورد والكميات والأسعار واعتمدت الأمر",
  }, reviewer);

beforeEach(async () => {
  await reset();
  await seed();
});

describe("S0 — دورة اعتماد أمر الشراء", () => {
  it("يحفظ الإنشاء مسودة فقط ويرفض محاولة إنشاء أمر معتمد", async () => {
    await expect(
      createPurchaseOrder(
        {
          supplierId: 1,
          branchId: 1,
          status: "CONFIRMED",
          clientRequestId: "create-confirmed-rejected",
          items: [{ variantId: 1, productUnitId: 1, quantity: "1", unitPrice: "10.00" }],
        } as never,
        creator,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const po = await createPurchaseOrder(
      {
        supplierId: 1,
        branchId: 1,
        clientRequestId: "create-default-draft",
        items: [{ variantId: 1, productUnitId: 1, quantity: "1", unitPrice: "10.00" }],
      },
      creator,
    );
    const [row] = await db().select().from(s.purchaseOrders).where(eq(s.purchaseOrders.id, po.purchaseOrderId));
    expect(row.status).toBe("DRAFT");
  });

  it("يفرض maker-checker على المنشئ وآخر محرر ثم يسمح لمستخدم مستقل", async () => {
    const first = await createDraft("maker-created");
    const firstRequest = await confirmPurchaseOrder(
      approval(first.purchaseOrderId, first.version, "maker-created-confirm"), creator,
    );
    await expect(
      decide(firstRequest.requestId, "maker-created-decision", creator),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const second = await createDraft("maker-edited");
    await updatePurchaseOrder(
      {
        purchaseOrderId: second.purchaseOrderId,
        expectedVersion: second.version,
        supplierId: 1,
        revisionReason: "تعديل الكمية قبل الإرسال للاعتماد",
        items: [{ variantId: 1, productUnitId: 1, quantity: "2", unitPrice: "10.00" }],
      },
      editor,
    );
    const secondRequest = await confirmPurchaseOrder(
      approval(second.purchaseOrderId, await currentVersion(second.purchaseOrderId), "maker-edited-confirm"),
      editor,
    );
    await expect(decide(secondRequest.requestId, "maker-edited-decision", editor))
      .rejects.toMatchObject({ code: "FORBIDDEN" });

    await expect(decide(secondRequest.requestId, "independent-approval"))
      .resolves.toMatchObject({ orderStatus: "CONFIRMED", idempotent: false });
  });

  it("يعيد replay مطابقاً ويمنع تغيير الحمولة أو عبور الفرع", async () => {
    const po = await createDraft("replay-create");
    const input = approval(po.purchaseOrderId, po.version, "replay-confirm");
    await expect(confirmPurchaseOrder(input, approver)).resolves.toMatchObject({ idempotent: false });
    await expect(confirmPurchaseOrder(input, approver)).resolves.toMatchObject({ idempotent: true });
    await expect(
      confirmPurchaseOrder({ ...input, reason: "سبب مختلف" }, approver),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(confirmPurchaseOrder(input, otherBranch)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("يجعل المعتمد غير قابل للتعديل ويحسم سباق update/confirm بلا بنود وسطية", async () => {
    const immutable = await createDraft("immutable-create");
    const immutableRequest = await confirmPurchaseOrder(
      approval(immutable.purchaseOrderId, immutable.version, "immutable-confirm"),
      creator,
    );
    await decide(immutableRequest.requestId, "immutable-decision");
    await expect(
      updatePurchaseOrder(
        {
          purchaseOrderId: immutable.purchaseOrderId,
          expectedVersion: await currentVersion(immutable.purchaseOrderId),
          supplierId: 1,
          revisionReason: "محاولة تعديل أمر معتمد يجب رفضها",
          items: [{ variantId: 1, productUnitId: 1, quantity: "9", unitPrice: "9.00" }],
        },
        editor,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const raced = await createDraft("race-create");
    const [updateResult, confirmResult] = await Promise.allSettled([
      updatePurchaseOrder(
        {
          purchaseOrderId: raced.purchaseOrderId,
          expectedVersion: raced.version,
          supplierId: 1,
          revisionReason: "تعديل متزامن مع طلب الاعتماد",
          items: [{ variantId: 1, productUnitId: 1, quantity: "2", unitPrice: "20.00" }],
        },
        editor,
      ),
      confirmPurchaseOrder(approval(raced.purchaseOrderId, raced.version, "race-confirm"), approver),
    ]);
    expect(["fulfilled", "rejected"]).toContain(confirmResult.status);
    expect(["fulfilled", "rejected"]).toContain(updateResult.status);

    if (confirmResult.status === "fulfilled") {
      await decide(confirmResult.value.requestId, "race-first-decision", editor);
    }
    let [row] = await db().select().from(s.purchaseOrders).where(eq(s.purchaseOrders.id, raced.purchaseOrderId));
    if (row.status !== "CONFIRMED") {
      const latest = await confirmPurchaseOrder(
        approval(raced.purchaseOrderId, Number(row.version), "race-final-confirm"),
        editor,
      );
      await decide(latest.requestId, "race-final-decision");
    }

    [row] = await db().select().from(s.purchaseOrders).where(eq(s.purchaseOrders.id, raced.purchaseOrderId));
    const items = await db().select().from(s.purchaseOrderItems).where(eq(s.purchaseOrderItems.purchaseOrderId, raced.purchaseOrderId));
    expect(row.status).toBe("CONFIRMED");
    expect(items).toHaveLength(1);
    expect([
      ["10.00", "1.000"],
      ["40.00", "2.000"],
    ]).toContainEqual([items[0].total, items[0].quantity]);
  });
});
