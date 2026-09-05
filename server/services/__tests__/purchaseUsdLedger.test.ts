import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { settleSupplierViaExchange } from "../exchange/settleSupplier";
import { getArApAgingDetail } from "../reportsAgingDetailService";
import {
  createPurchaseOrder,
  receivePurchase,
  settlePurchaseUsdDirect,
} from "../purchaseService";
import { approveVoucher } from "../voucher/approval";
import {
  decidePurchaseOrderControl,
  submitPurchaseOrderForApproval,
} from "../purchase/controls";

const creator = { userId: 1, branchId: 1, role: "manager" } as const;
const receiver = { userId: 2, branchId: 1, role: "manager" } as const;
const checker = {
  userId: 3,
  branchId: 1,
  role: "admin",
  isOwner: true,
} as const;

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set");
  return d;
}

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of [
    "idempotencyKeys",
    "journalLines",
    "journalEntries",
    "accountingEntries",
    "exchangeTransactions",
    "exchangeHouses",
    "receipts",
    "inventoryMovements",
    "purchaseOrderEvents",
    "purchaseOrderControlRequests",
    "purchaseOrderRequisitionAllocations",
    "purchaseOrderRevisionItems",
    "purchaseOrderRevisions",
    "purchaseOrderItems",
    "purchaseOrders",
    "branchStock",
    "productPrices",
    "productUnits",
    "productVariants",
    "products",
    "suppliers",
    "branches",
    "users",
  ])
    await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seed() {
  const d = db();
  await d
    .insert(s.branches)
    .values({ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values([
    {
      id: 1,
      openId: "usd-creator",
      name: "منشئ",
      role: "manager",
      loginMethod: "local",
      branchId: 1,
    },
    {
      id: 2,
      openId: "usd-receiver",
      name: "مستلم",
      role: "manager",
      loginMethod: "local",
      branchId: 1,
    },
    {
      id: 3,
      openId: "usd-checker-ledger",
      name: "مالك معتمد",
      role: "admin",
      loginMethod: "local",
      branchId: 1,
      isOwner: true,
    },
  ]);
  await d.insert(s.suppliers).values({ id: 1, name: "مورد دولاري" });
  await d.insert(s.receipts).values({
    branchId: 1,
    cashBucket: "TREASURY",
    direction: "IN",
    amount: "10000000.00",
    paymentMethod: "CASH",
    status: "COMPLETED",
    referenceNumber: "TEST-TREASURY-FUND",
    createdBy: 1,
  });
  await d.insert(s.products).values({ id: 1, name: "ورق" });
  await d
    .insert(s.productVariants)
    .values({ id: 1, productId: 1, sku: "USD-1", costPrice: "0.00" });
  await d.insert(s.productUnits).values({
    id: 1,
    variantId: 1,
    unitName: "قطعة",
    conversionFactor: "1",
    isBaseUnit: true,
  });
  await d.insert(s.exchangeHouses).values({
    id: 1,
    name: "صيرفة الرشيد",
    balanceIqd: "500000.00",
    balanceUsd: "0.00",
    usdCostRate: "0.0000",
  });
}

beforeEach(async () => {
  await reset();
  await seed();
});

describe("فاتورة المورد الدولارية — التكلفة والذمة والتسديد", () => {
  it("يثبت أسعار البنود بالدولار، يُبقي الشحن خارج الذمّة والتكلفة، ويطفئ الدفعة بسعرها الفعلي", async () => {
    const created = await createPurchaseOrder(
      {
        supplierId: 1,
        branchId: 1,
        agreedCurrency: "USD",
        agreedRate: "1450",
        usdTotal: "200",
        shippingCost: "100000",
        items: [
          { variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "20" },
        ],
      },
      creator,
    );

    const po = (
      await db()
        .select()
        .from(s.purchaseOrders)
        .where(eq(s.purchaseOrders.id, created.purchaseOrderId))
    )[0];
    const item = (
      await db()
        .select()
        .from(s.purchaseOrderItems)
        .where(
          eq(s.purchaseOrderItems.purchaseOrderId, created.purchaseOrderId),
        )
    )[0];
    expect(po.usdTotal).toBe("200.00");
    expect(po.agreedRate).toBe("1450.0000");
    expect(po.subtotal).toBe("290000.00");
    // قرار المالك (٥/٨/٢٦): الإجمالي = البضاعة فقط (٢٩٠٬٠٠٠) — الشحن (١٠٠٬٠٠٠) خرج منه
    // ومن ذمّة المورّد، ويُسجَّل مصروف نقلٍ لحظة الاستلام. كان ٣٩٠٬٠٠٠ في السياسة الملغاة.
    expect(po.total).toBe("290000.00");
    expect(item.usdUnitPrice).toBe("20.0000");
    expect(item.usdTotal).toBe("200.00");
    expect(item.unitPrice).toBe("29000.00");

    const submitted = await submitPurchaseOrderForApproval(
      {
        purchaseOrderId: created.purchaseOrderId,
        expectedVersion: created.version,
        reason: "إرسال أمر الشراء الدولاري للمراجعة المستقلة",
        requestKey: `purchase-usd-submit:${randomUUID()}`,
      },
      creator,
    );
    await decidePurchaseOrderControl(
      {
        requestId: submitted.requestId,
        decisionKey: `purchase-usd-approve:${randomUUID()}`,
        approve: true,
        reason: "راجعت سعر الصرف وقيمة المورد والشحن واعتمدت الأمر",
      },
      checker,
      { legacyConfirmOnly: true },
    );

    await receivePurchase(
      {
        purchaseOrderId: created.purchaseOrderId,
        lines: [
          { purchaseOrderItemId: Number(item.id), receivedBaseQuantity: 10 },
        ],
        shippingEvidenceReference: `SHIP-USD-${created.purchaseOrderId}`,
        shippingBeneficiaryName: "شركة الرافدين للنقل الاختبارية",
      },
      receiver,
    );

    const supplierAfterReceipt = (
      await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1))
    )[0];
    const variant = (
      await db()
        .select()
        .from(s.productVariants)
        .where(eq(s.productVariants.id, 1))
    )[0];
    expect(supplierAfterReceipt.currentBalance).toBe("290000.00");
    expect(supplierAfterReceipt.currentBalanceUsd).toBe("200.00");
    // تكلفة الصنف = سعر المورّد بالدينار وحده (٢٩٬٠٠٠) — بلا حصّة الشحن (كانت ٣٩٬٠٠٠ برسملتها).
    expect(variant.costPrice).toBe("29000.00");

    const settled = await settleSupplierViaExchange(
      {
        exchangeHouseId: 1,
        branchId: 1,
        supplierId: 1,
        purchaseOrderId: created.purchaseOrderId,
        currency: "IQD",
        walletAmount: "148000",
        settledUsd: "100",
        settledIqd: "145000",
        commission: "0",
        clientRequestId: "usd-settle-1",
      },
      receiver,
    );
    expect(settled.fxDiff).toBe("-3000.00");

    const [supplier, settledPo, house, txn] = await Promise.all([
      db()
        .select()
        .from(s.suppliers)
        .where(eq(s.suppliers.id, 1))
        .then((r) => r[0]),
      db()
        .select()
        .from(s.purchaseOrders)
        .where(eq(s.purchaseOrders.id, created.purchaseOrderId))
        .then((r) => r[0]),
      db()
        .select()
        .from(s.exchangeHouses)
        .where(eq(s.exchangeHouses.id, 1))
        .then((r) => r[0]),
      db()
        .select()
        .from(s.exchangeTransactions)
        .where(
          eq(s.exchangeTransactions.purchaseOrderId, created.purchaseOrderId),
        )
        .then((r) => r[0]),
    ]);
    expect(supplier.currentBalance).toBe("145000.00");
    expect(supplier.currentBalanceUsd).toBe("100.00");
    expect(settledPo.paidAmount).toBe("145000.00");
    expect(settledPo.paidUsd).toBe("100.00");
    expect(house.balanceIqd).toBe("352000.00");
    expect(txn.iqdAmount).toBe("148000.00");
    expect(txn.settledIqd).toBe("145000.00");
    expect(txn.settledUsd).toBe("100.00");

    const direct = await settlePurchaseUsdDirect(
      {
        purchaseOrderId: created.purchaseOrderId,
        settledUsd: "100",
        chargedIqd: "147000",
        feeIqd: "1000",
        method: "CARD",
        referenceNumber: "CARD-USD-100",
        cardLastFour: "4242",
        clientRequestId: "usd-card-1",
      },
      receiver,
    );
    expect(direct.carryingIqd).toBe("145000.00");
    expect(direct.fxDiff).toBe("-2000.00");
    expect(direct.approvalStatus).toBe("PENDING_APPROVAL");

    const [
      supplierBeforeApproval,
      poBeforeApproval,
      pendingReceipt,
      pendingEntries,
    ] = await Promise.all([
      db()
        .select()
        .from(s.suppliers)
        .where(eq(s.suppliers.id, 1))
        .then((r) => r[0]),
      db()
        .select()
        .from(s.purchaseOrders)
        .where(eq(s.purchaseOrders.id, created.purchaseOrderId))
        .then((r) => r[0]),
      db()
        .select()
        .from(s.receipts)
        .where(eq(s.receipts.id, direct.receiptId))
        .then((r) => r[0]),
      db()
        .select()
        .from(s.accountingEntries)
        .where(eq(s.accountingEntries.receiptId, direct.receiptId)),
    ]);
    expect(supplierBeforeApproval.currentBalance).toBe("145000.00");
    expect(supplierBeforeApproval.currentBalanceUsd).toBe("100.00");
    expect(poBeforeApproval.paidAmount).toBe("145000.00");
    expect(poBeforeApproval.paidUsd).toBe("100.00");
    expect(pendingReceipt.status).toBe("PENDING");
    expect(pendingEntries).toHaveLength(0);

    await approveVoucher(direct.receiptId, checker);

    const [supplierAfterCard, poAfterCard, receipt, entries] =
      await Promise.all([
        db()
          .select()
          .from(s.suppliers)
          .where(eq(s.suppliers.id, 1))
          .then((r) => r[0]),
        db()
          .select()
          .from(s.purchaseOrders)
          .where(eq(s.purchaseOrders.id, created.purchaseOrderId))
          .then((r) => r[0]),
        db()
          .select()
          .from(s.receipts)
          .where(eq(s.receipts.id, direct.receiptId))
          .then((r) => r[0]),
        db()
          .select()
          .from(s.accountingEntries)
          .where(eq(s.accountingEntries.receiptId, direct.receiptId)),
      ]);
    expect(supplierAfterCard.currentBalance).toBe("0.00");
    expect(supplierAfterCard.currentBalanceUsd).toBe("0.00");
    expect(poAfterCard.paidAmount).toBe("290000.00");
    expect(poAfterCard.paidUsd).toBe("200.00");
    expect(receipt.amount).toBe("148000.00");
    expect(receipt.paymentMethod).toBe("CARD");
    expect(entries.map((e) => e.entryType).sort()).toEqual([
      "EXCHANGE_FEE",
      "EXCHANGE_FX_DIFF",
      "PAYMENT_OUT",
    ]);
    const aging = await getArApAgingDetail({ side: "AP", branchId: 1 });
    expect(aging.rows).toHaveLength(0);
  });
});
