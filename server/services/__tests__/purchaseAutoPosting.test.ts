import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { confirmPurchaseOrder, createPurchaseInvoice, createPurchaseOrder } from "../purchaseService";
import { truncateTables } from "./__testUtils__";

const actor = { userId: 1, branchId: 1, role: "manager" as const };

const TABLES = [
  "idempotencyKeys",
  "journalLines",
  "journalEntries",
  "doubleEntrySettings",
  "accountingEntries",
  "accrualCorrectionRequests",
  "accrualObligationEvents",
  "accrualObligations",
  "expenses",
  "receipts",
  "inventoryMovements",
  "purchaseOrderItems",
  "purchaseOrders",
  "branchStock",
  "productUnits",
  "productVariants",
  "products",
  "suppliers",
  "branches",
  "users",
] as const;

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set");
  return value;
}

async function seed() {
  await db().insert(s.branches).values({ id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" });
  await db().insert(s.users).values({
    id: 1,
    openId: "purchase-auto-poster",
    name: "مدير المشتريات",
    role: "manager",
    loginMethod: "local",
    branchId: 1,
  });
  await db().insert(s.suppliers).values({ id: 1, name: "مورد", currentBalance: "0.00" });
  await db().insert(s.products).values({ id: 1, name: "ورق" });
  await db().insert(s.productVariants).values({ id: 1, productId: 1, sku: "PAPER-AUTO", costPrice: "4.00" });
  await db().insert(s.productUnits).values({
    id: 1,
    variantId: 1,
    unitName: "قطعة",
    conversionFactor: "1",
    isBaseUnit: true,
  });
}

beforeEach(async () => {
  await truncateTables(TABLES);
  await seed();
});

describe("اعتماد فاتورة الشراء يرحّل المخزون والذمة آلياً", () => {
  it("الحفظ المعتمد ينشئ فاتورة مستلمة بالكامل وحركة وقيداً واحداً", async () => {
    const created = await createPurchaseInvoice({
      supplierId: 1,
      branchId: 1,
      settlementType: "CREDIT",
      clientRequestId: "purchase-auto-create-1",
      items: [{ variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "5.00" }],
    }, actor);

    expect(created.status).toBe("RECEIVED");
    expect(created.posting).toMatchObject({ fullyReceived: true, receivedTotal: "50.00" });

    const [order] = await db().select().from(s.purchaseOrders)
      .where(eq(s.purchaseOrders.id, created.purchaseOrderId));
    const [item] = await db().select().from(s.purchaseOrderItems)
      .where(eq(s.purchaseOrderItems.purchaseOrderId, created.purchaseOrderId));
    const [stock] = await db().select().from(s.branchStock)
      .where(eq(s.branchStock.variantId, 1));
    const movements = await db().select().from(s.inventoryMovements)
      .where(eq(s.inventoryMovements.referenceId, created.purchaseOrderId));
    const entries = await db().select().from(s.accountingEntries)
      .where(eq(s.accountingEntries.purchaseOrderId, created.purchaseOrderId));

    expect(order.status).toBe("RECEIVED");
    expect(item.receivedBaseQuantity).toBe(10);
    expect(stock.quantity).toBe(10);
    expect(movements).toHaveLength(1);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ entryType: "PURCHASE", amount: "50.00" });
    expect((await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0].currentBalance).toBe("50.00");
  });

  it("المسودة بلا أثر، واعتمادها لاحقاً يرحّل كاملها مرة واحدة", async () => {
    const draft = await createPurchaseOrder({
      supplierId: 1,
      branchId: 1,
      status: "DRAFT",
      settlementType: "CREDIT",
      clientRequestId: "purchase-auto-draft-1",
      items: [{ variantId: 1, productUnitId: 1, quantity: "3", unitPrice: "7.00" }],
    }, actor);

    expect(await db().select().from(s.branchStock)).toHaveLength(0);
    expect(await db().select().from(s.inventoryMovements)).toHaveLength(0);
    expect(await db().select().from(s.accountingEntries)).toHaveLength(0);

    const first = await confirmPurchaseOrder(draft.purchaseOrderId, actor);
    const replay = await confirmPurchaseOrder(draft.purchaseOrderId, actor);

    expect(first.status).toBe("RECEIVED");
    expect(first.posting).toMatchObject({ fullyReceived: true, receivedTotal: "21.00" });
    expect(replay.posting).toMatchObject({ idempotentReplay: true, receivedTotal: "21.00" });
    expect(await db().select().from(s.inventoryMovements)).toHaveLength(1);
    expect(await db().select().from(s.accountingEntries)).toHaveLength(1);
    expect((await db().select().from(s.branchStock))[0].quantity).toBe(3);
    expect((await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0].currentBalance).toBe("21.00");
  });

  it("اعتمادان متزامنان ينجحان بنتيجة واحدة بلا مضاعفة المخزون أو الذمة", async () => {
    const draft = await createPurchaseOrder({
      supplierId: 1,
      branchId: 1,
      status: "DRAFT",
      settlementType: "CREDIT",
      clientRequestId: "purchase-auto-concurrent-draft",
      items: [{ variantId: 1, productUnitId: 1, quantity: "4", unitPrice: "6.00" }],
    }, actor);

    const [first, second] = await Promise.all([
      confirmPurchaseOrder(draft.purchaseOrderId, actor),
      confirmPurchaseOrder(draft.purchaseOrderId, actor),
    ]);

    expect([first.posting, second.posting].some((posting) => posting.idempotentReplay === true)).toBe(true);
    expect(await db().select().from(s.inventoryMovements)).toHaveLength(1);
    expect(await db().select().from(s.accountingEntries)).toHaveLength(1);
    expect((await db().select().from(s.branchStock))[0].quantity).toBe(4);
    expect((await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0].currentBalance).toBe("24.00");
  });

  it("يحمل أداة تسوية الشحن ودليلها من الفاتورة نفسها إلى طلب الصرف المعلق", async () => {
    const input: Parameters<typeof createPurchaseInvoice>[0] = {
      supplierId: 1,
      branchId: 1,
      settlementType: "CREDIT",
      clientRequestId: "purchase-auto-shipping-card",
      shippingCost: "8.00",
      shippingPaymentMethod: "CARD",
      shippingCardLastFour: "4242",
      shippingBeneficiaryName: "شركة النقل",
      shippingEvidenceReference: "SHIP-INVOICE-88",
      items: [{ variantId: 1, productUnitId: 1, quantity: "2", unitPrice: "5.00" }],
    };
    const created = await createPurchaseInvoice(input, actor);

    const receiptId = Number(created.posting?.shippingPaymentRequestReceiptId);
    const [receipt] = await db().select().from(s.receipts).where(eq(s.receipts.id, receiptId));
    const [expense] = await db().select().from(s.expenses);
    const [obligation] = await db().select().from(s.accrualObligations);

    expect(receipt).toMatchObject({
      paymentMethod: "CARD",
      cardLastFour: "4242",
      counterpartyName: "شركة النقل",
      status: "PENDING",
      approvalStatus: "PENDING_APPROVAL",
    });
    expect(expense).toMatchObject({ source: "ACCRUAL", payee: "شركة النقل", amount: "8.00" });
    expect(obligation).toMatchObject({
      kind: "PURCHASE_SHIPPING",
      status: "PAYMENT_PENDING",
      evidenceReference: "SHIP-INVOICE-88",
      plannedPaymentMethod: "CARD",
    });

    const replay = await createPurchaseInvoice(input, actor);
    expect(replay).toMatchObject({
      purchaseOrderId: created.purchaseOrderId,
      status: "RECEIVED",
      idempotent: true,
      posting: {
        idempotentReplay: true,
        shippingPaymentRequestReceiptId: receiptId,
      },
    });
  });
});
