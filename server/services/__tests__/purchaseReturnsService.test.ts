import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import type { TrpcContext } from "../../context";
import { getDb } from "../../db";
import { purchaseReturnsRouter } from "../../routers/purchaseReturns";
import { createPurchaseOrder, receivePurchase } from "../purchaseService";
import { createPurchaseReturn } from "../purchaseReturnsService";
import { createVoucher } from "../voucher/create";
import { approveVoucher } from "../voucher/approval";

const actor = { userId: 1, branchId: 1, role: "admin" as const };

const TABLES = [
  "accountingEntries",
  "receipts",
  "idempotencyKeys",
  "inventoryMovements",
  "branchStock",
  "purchaseOrderItems",
  "purchaseOrders",
  "productPrices",
  "productUnits",
  "productVariants",
  "products",
  "auditLogs",
  "suppliers",
  "branches",
  "users",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set for tests");
  return d;
}

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seedBase() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values([
    { id: 1, openId: "local_test", name: "admin", role: "admin", loginMethod: "local", isOwner: false },
    { id: 2, openId: "local_owner", name: "owner", role: "manager", loginMethod: "local", branchId: 1, isOwner: true, isActive: true },
  ]);
  await d.insert(s.products).values({ id: 1, name: "قلم" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "PEN-1", costPrice: "0.00" });
  await d.insert(s.productUnits).values([
    { id: 1, variantId: 1, unitName: "قطعة", conversionFactor: "1", isBaseUnit: true },
    { id: 2, variantId: 1, unitName: "درزن", conversionFactor: "12", isBaseUnit: false },
  ]);
  await d.insert(s.suppliers).values({ id: 1, name: "مورد", currentBalance: "0" });
}

async function fundTreasury(amount = "5000.00") {
  await db().insert(s.receipts).values({
    branchId: 1,
    shiftId: null,
    cashBucket: "TREASURY",
    direction: "IN",
    amount,
    paymentMethod: "CASH",
    status: "COMPLETED",
    approvalStatus: "APPROVED",
    referenceNumber: `PURCHASE-RETURN-FUND-${crypto.randomUUID()}`,
    createdBy: 1,
  });
}

async function stockOf(variantId: number, branchId: number): Promise<number> {
  const rows = await db()
    .select({ q: s.branchStock.quantity })
    .from(s.branchStock)
    .where(and(eq(s.branchStock.variantId, variantId), eq(s.branchStock.branchId, branchId)));
  return rows[0]?.q ?? 0;
}

async function seedOwnedStock(quantity = 100, costPrice = "5.00") {
  await db().update(s.productVariants).set({ costPrice }).where(eq(s.productVariants.id, 1));
  await db().insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity });
}

async function receivePurchaseOf100(paymentAmount?: string, taxRatePercent = "0") {
  const po = await createPurchaseOrder(
    {
      supplierId: 1,
      branchId: 1,
      taxRatePercent,
      status: "CONFIRMED",
      items: [{ variantId: 1, productUnitId: 1, quantity: "100", unitPrice: "5.00" }],
    },
    actor
  );
  const poItem = (
    await db().select().from(s.purchaseOrderItems).where(eq(s.purchaseOrderItems.purchaseOrderId, po.purchaseOrderId))
  )[0];
  const received = await receivePurchase(
    {
      purchaseOrderId: po.purchaseOrderId,
      lines: [{ purchaseOrderItemId: Number(poItem.id), receivedBaseQuantity: 100 }],
      payment: paymentAmount ? { amount: paymentAmount, method: "CASH" as const } : undefined,
    },
    actor
  );
  if (received.supplierPaymentRequestReceiptId) {
    await approveVoucher(Number(received.supplierPaymentRequestReceiptId), {
      userId: 2,
      branchId: 1,
      role: "manager",
    });
  }
  return po.purchaseOrderId;
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("مرتجع المشتريات", () => {
  it("المرتجع المرجعي يرث ضريبة أمر الشراء ويعكس صافي المخزون والضريبة كلّاً على حدة", async () => {
    const poId = await receivePurchaseOf100(undefined, "10");
    const result = await createPurchaseReturn(
      {
        supplierId: 1,
        branchId: 1,
        purchaseOrderRefId: poId,
        items: [{ variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "5.00" }],
        settlement: "CREDIT",
      },
      actor,
    );

    expect(result.returnedTotal).toBe("55.00");
    const entry = (
      await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "RETURN"))
    )[0];
    expect(entry.cost).toBe("-50.00");
    expect(entry.taxAmount).toBe("-5.00");
    expect(entry.amount).toBe("-55.00");
    const supplier = (await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0];
    expect(supplier.currentBalance).toBe("495.00");
  });

  it("إرجاع جزئي (CREDIT): المخزون ينقص + قيد RETURN سالب + AP تنخفض، بلا receipt", async () => {
    await receivePurchaseOf100();
    expect(await stockOf(1, 1)).toBe(100);
    const supBefore = (await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0];
    expect(supBefore.currentBalance).toBe("500.00");

    const res = await createPurchaseReturn(
      {
        supplierId: 1,
        branchId: 1,
        items: [{ variantId: 1, productUnitId: 1, quantity: "10", unitPrice: "5.00" }],
        settlement: "CREDIT",
      },
      actor
    );
    expect(res.returnedTotal).toBe("50.00");

    // المخزون
    expect(await stockOf(1, 1)).toBe(90);
    const mvs = await db().select().from(s.inventoryMovements);
    const outMv = mvs.find((m) => m.movementType === "OUT");
    expect(outMv).toBeTruthy();
    expect(outMv!.quantity).toBe(10);
    expect(outMv!.referenceType).toBe("PURCHASE_RETURN");

    // قيد RETURN سالب
    const ret = (
      await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "RETURN"))
    )[0];
    expect(ret.supplierId).toBe(1);
    expect(ret.amount).toBe("-50.00");
    expect(ret.cost).toBe("-50.00");

    // AP تنخفض
    const sup = (await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0];
    expect(sup.currentBalance).toBe("450.00");

    // لا receipt في حالة CREDIT
    expect(await db().select().from(s.receipts)).toHaveLength(0);
  });

  it("إرجاع نقدي (CASH): receipt IN + قيد PAYMENT_IN + الذمم تظل ثابتة صافياً (الصندوق ارتفع بدلها)", async () => {
    await fundTreasury();
    const poId = await receivePurchaseOf100("500.00");
    const supBefore = (await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0];
    expect(supBefore.currentBalance).toBe("0.00");

    await createPurchaseReturn(
      {
        supplierId: 1,
        branchId: 1,
        purchaseOrderRefId: poId,
        items: [{ variantId: 1, productUnitId: 1, quantity: "20", unitPrice: "5.00" }],
        settlement: "CASH",
        paymentMethod: "CASH",
      },
      actor
    );

    // receipt IN بالقيمة الكاملة (المورد ردّ النقد)
    const rcs = (await db().select().from(s.receipts)).filter((r) => r.direction === "IN" && r.referenceNumber == null);
    expect(rcs).toHaveLength(1);
    expect(rcs[0].amount).toBe("100.00");

    // قيدا RETURN و PAYMENT_IN موجودان
    const ret = (await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "RETURN")))[0];
    expect(ret.amount).toBe("-100.00");
    const pin = (await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "PAYMENT_IN")))[0];
    expect(pin.amount).toBe("100.00");

    // صافي AP يبقى صفراً: الشراء دُفع سابقاً، والنقد المسترد لا ينشئ ذمّة.
    const sup = (await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0];
    expect(sup.currentBalance).toBe("0.00");
  });

  it("استرداد نقدي واستلام نقدي لنفس أمر الشراء يتسلسلان source→PO بلا deadlock", async () => {
    await fundTreasury("2000.00");
    const po = await createPurchaseOrder({
      supplierId: 1,
      branchId: 1,
      status: "CONFIRMED",
      items: [{ variantId: 1, productUnitId: 1, quantity: "200", unitPrice: "5.00" }],
    }, actor);
    const item = (await db().select().from(s.purchaseOrderItems)
      .where(eq(s.purchaseOrderItems.purchaseOrderId, po.purchaseOrderId)))[0];
    const firstReceipt = await receivePurchase({
      purchaseOrderId: po.purchaseOrderId,
      lines: [{ purchaseOrderItemId: Number(item.id), receivedBaseQuantity: 100 }],
      payment: { amount: "500.00", method: "CASH" },
    }, actor);
    await approveVoucher(Number(firstReceipt.supplierPaymentRequestReceiptId), {
      userId: 2,
      branchId: 1,
      role: "manager",
    });

    const results = await Promise.allSettled([
      createPurchaseReturn({
        clientRequestId: "purchase-return-vs-receive",
        supplierId: 1,
        branchId: 1,
        purchaseOrderRefId: po.purchaseOrderId,
        items: [{ variantId: 1, productUnitId: 1, quantity: "20", unitPrice: "5.00" }],
        settlement: "CASH",
        paymentMethod: "CASH",
      }, actor),
      receivePurchase({
        purchaseOrderId: po.purchaseOrderId,
        lines: [{ purchaseOrderItemId: Number(item.id), receivedBaseQuantity: 100 }],
        payment: { amount: "500.00", method: "CASH" },
      }, actor),
    ]);

    expect(results.filter((result) => result.status === "rejected")).toEqual([]);
    expect(await stockOf(1, 1)).toBe(180);
  }, 15_000);

  it("استرداد نقدي واعتماد سند للمورد نفسه يتسلسلان source→supplier بلا deadlock", async () => {
    await fundTreasury("2000.00");
    const poId = await receivePurchaseOf100("500.00");
    await db().update(s.suppliers).set({ currentBalance: "500.00" }).where(eq(s.suppliers.id, 1));
    const voucher = await createVoucher({
      voucherType: "PAYMENT",
      branchId: 1,
      amount: "100.00",
      paymentMethod: "CASH",
      partyType: "SUPPLIER",
      partyId: 1,
      description: "سند متزامن مع مرتجع شراء نقدي",
      clientRequestId: "purchase-return-voucher",
    }, actor);

    const results = await Promise.allSettled([
      createPurchaseReturn({
        clientRequestId: "purchase-return-vs-voucher",
        supplierId: 1,
        branchId: 1,
        purchaseOrderRefId: poId,
        items: [{ variantId: 1, productUnitId: 1, quantity: "20", unitPrice: "5.00" }],
        settlement: "CASH",
        paymentMethod: "CASH",
      }, actor),
      approveVoucher(voucher.receiptId, { userId: 2, branchId: 1, role: "manager" }),
    ]);

    expect(results.filter((result) => result.status === "rejected")).toEqual([]);
    expect((await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0].currentBalance).toBe("400.00");
  }, 15_000);

  it("إرجاع CASH بلا أمر شراء ودفعة موثقة ⇒ يُرفض ولا يترك أثراً", async () => {
    await receivePurchaseOf100();
    const stockBefore = await stockOf(1, 1);
    const supBefore = (await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0];

    await expect(
      createPurchaseReturn(
        {
          supplierId: 1,
          branchId: 1,
          items: [{ variantId: 1, productUnitId: 1, quantity: "20", unitPrice: "5.00" }],
          settlement: "CASH",
          paymentMethod: "CASH",
        },
        actor,
      ),
    ).rejects.toThrow(/أمر شراء مرجعياً/);

    expect(await stockOf(1, 1)).toBe(stockBefore);
    const supAfter = (await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0];
    expect(supAfter.currentBalance).toBe(supBefore.currentBalance);
    expect((await db().select().from(s.receipts)).filter((r) => r.direction === "IN")).toHaveLength(0);
  });

  it("ذرّية: مخزون غير كافٍ ⇒ ROLLBACK كامل (لا حركة ولا قيد ولا تغيير ذمم)", async () => {
    await receivePurchaseOf100();
    expect(await stockOf(1, 1)).toBe(100);
    const supBefore = (await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0];

    await expect(
      createPurchaseReturn(
        {
          supplierId: 1,
          branchId: 1,
          items: [{ variantId: 1, productUnitId: 1, quantity: "999", unitPrice: "5.00" }],
        },
        actor
      )
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // كل شيء ثابت
    expect(await stockOf(1, 1)).toBe(100);
    const rets = await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "RETURN"));
    expect(rets).toHaveLength(0);
    const sup = (await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0];
    expect(sup.currentBalance).toBe(supBefore.currentBalance);
    expect(await db().select().from(s.receipts)).toHaveLength(0);
  });

  it("idempotency: نفس clientRequestId مرّتين ⇒ القيد واحد فقط ومُعلَّم idempotent", async () => {
    await receivePurchaseOf100();
    const first = await createPurchaseReturn(
      {
        clientRequestId: "req-abc-123",
        supplierId: 1,
        branchId: 1,
        items: [{ variantId: 1, productUnitId: 1, quantity: "7", unitPrice: "5.00" }],
      },
      actor
    );
    expect(first.idempotent).toBe(false);

    const second = await createPurchaseReturn(
      {
        clientRequestId: "req-abc-123",
        supplierId: 1,
        branchId: 1,
        items: [{ variantId: 1, productUnitId: 1, quantity: "7", unitPrice: "5.00" }],
      },
      actor
    );
    expect(second.idempotent).toBe(true);
    expect(second.returnedTotal).toBe(first.returnedTotal);

    // قيد واحد فقط، وحركة OUT واحدة فقط
    const rets = await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "RETURN"));
    expect(rets).toHaveLength(1);
    const outMvs = (await db().select().from(s.inventoryMovements)).filter((m) => m.movementType === "OUT");
    expect(outMvs).toHaveLength(1);
    // الذمم: انخفضت مرة واحدة فقط (500 - 35 = 465)
    const sup = (await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0];
    expect(sup.currentBalance).toBe("465.00");
    expect(await stockOf(1, 1)).toBe(93);
  });

  it("سقف الكميّات حسب أمر شراء مرجعي: تجاوز المستلَم يُرفض", async () => {
    const poId = await receivePurchaseOf100();
    // أرجِع 60 (مسموح)
    await createPurchaseReturn(
      {
        supplierId: 1,
        branchId: 1,
        purchaseOrderRefId: poId,
        items: [{ variantId: 1, productUnitId: 1, quantity: "60", unitPrice: "5.00" }],
      },
      actor
    );
    expect(await stockOf(1, 1)).toBe(40);

    // ثم 50 — يتجاوز المتبقّي (40) ⇒ يُرفض
    await expect(
      createPurchaseReturn(
        {
          supplierId: 1,
          branchId: 1,
          purchaseOrderRefId: poId,
          items: [{ variantId: 1, productUnitId: 1, quantity: "50", unitPrice: "5.00" }],
        },
        actor
      )
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("أمر شراء مرجعي بمورد مختلف ⇒ يُرفض", async () => {
    const poId = await receivePurchaseOf100();
    await db().insert(s.suppliers).values({ id: 2, name: "مورد آخر", currentBalance: "0" });
    await expect(
      createPurchaseReturn(
        {
          supplierId: 2,
          branchId: 1,
          purchaseOrderRefId: poId,
          items: [{ variantId: 1, productUnitId: 1, quantity: "1", unitPrice: "5.00" }],
        },
        actor
      )
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("بنود فارغة ⇒ يُرفض قبل أي عمل", async () => {
    await expect(
      createPurchaseReturn({ supplierId: 1, branchId: 1, items: [] }, actor)
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

// RBAC: تمنع البوّابة الكاشير وأمين المخزن من إنشاء مرتجع شراء.
describe("purchase return hardening", () => {
  it("rejects a no-PO return from a consignor without changing stock or AP", async () => {
    await seedOwnedStock();
    await db().update(s.suppliers).set({ supplierKind: "CONSIGNOR" }).where(eq(s.suppliers.id, 1));
    const stockBefore = await stockOf(1, 1);
    const balanceBefore = (await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0].currentBalance;

    await expect(
      createPurchaseReturn({
        supplierId: 1,
        branchId: 1,
        items: [{ variantId: 1, productUnitId: 1, quantity: "1", unitPrice: "5.00" }],
        settlement: "CREDIT",
      }, actor),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(await stockOf(1, 1)).toBe(stockBefore);
    expect((await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0].currentBalance).toBe(balanceBefore);
    expect(await db().select({ id: s.accountingEntries.id }).from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "RETURN"))).toHaveLength(0);
  });

  it.each([
    ["consignment", { isConsignment: true, consignorId: 1 }],
    ["service", { isService: true }],
    ["bundle/non-owned", { isBundle: true }],
  ] as const)("rejects a no-PO return for a %s product", async (_kind, productUpdate) => {
    await seedOwnedStock();
    await db().update(s.products).set(productUpdate).where(eq(s.products.id, 1));

    await expect(
      createPurchaseReturn({
        supplierId: 1,
        branchId: 1,
        items: [{ variantId: 1, productUnitId: 1, quantity: "1", unitPrice: "5.00" }],
        settlement: "CREDIT",
      }, actor),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(await stockOf(1, 1)).toBe(100);
    expect(await db().select({ id: s.accountingEntries.id }).from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "RETURN"))).toHaveLength(0);
  });

  it("binds an idempotency key to the exact item fingerprint", async () => {
    await receivePurchaseOf100();
    await createPurchaseReturn({
      clientRequestId: "purchase-return-item-fingerprint",
      supplierId: 1,
      branchId: 1,
      items: [{ variantId: 1, productUnitId: 1, quantity: "2", unitPrice: "5.00" }],
      settlement: "CREDIT",
    }, actor);

    await expect(
      createPurchaseReturn({
        clientRequestId: "purchase-return-item-fingerprint",
        supplierId: 1,
        branchId: 1,
        items: [{ variantId: 1, productUnitId: 1, quantity: "3", unitPrice: "5.00" }],
        settlement: "CREDIT",
      }, actor),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(await stockOf(1, 1)).toBe(98);
    expect(await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "RETURN"))).toHaveLength(1);
  });

  it("binds an idempotency key to the referenced purchase-order source", async () => {
    const firstPoId = await receivePurchaseOf100();
    const secondPoId = await receivePurchaseOf100();
    await createPurchaseReturn({
      clientRequestId: "purchase-return-source-fingerprint",
      supplierId: 1,
      branchId: 1,
      purchaseOrderRefId: firstPoId,
      items: [{ variantId: 1, productUnitId: 1, quantity: "2", unitPrice: "5.00" }],
      settlement: "CREDIT",
    }, actor);

    await expect(
      createPurchaseReturn({
        clientRequestId: "purchase-return-source-fingerprint",
        supplierId: 1,
        branchId: 1,
        purchaseOrderRefId: secondPoId,
        items: [{ variantId: 1, productUnitId: 1, quantity: "2", unitPrice: "5.00" }],
        settlement: "CREDIT",
      }, actor),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(await stockOf(1, 1)).toBe(198);
    expect(await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "RETURN"))).toHaveLength(1);
  });

  it("requires completed APPROVED cash-payment evidence before a cash refund", async () => {
    await fundTreasury();
    const purchaseOrderId = await receivePurchaseOf100("500.00");
    const paymentEntry = (
      await db()
        .select({ receiptId: s.accountingEntries.receiptId })
        .from(s.accountingEntries)
        .where(and(
          eq(s.accountingEntries.entryType, "PAYMENT_OUT"),
          eq(s.accountingEntries.purchaseOrderId, purchaseOrderId),
        ))
    )[0];
    expect(paymentEntry?.receiptId).toBeTruthy();
    await db()
      .update(s.receipts)
      .set({ status: "FAILED", approvalStatus: "REJECTED" })
      .where(eq(s.receipts.id, Number(paymentEntry.receiptId)));

    await expect(
      createPurchaseReturn({
        supplierId: 1,
        branchId: 1,
        purchaseOrderRefId: purchaseOrderId,
        items: [{ variantId: 1, productUnitId: 1, quantity: "20", unitPrice: "5.00" }],
        settlement: "CASH",
        paymentMethod: "CASH",
      }, actor),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(await stockOf(1, 1)).toBe(100);
    expect(await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "RETURN"))).toHaveLength(0);
    expect((await db().select().from(s.receipts)).filter((receipt) => receipt.direction === "IN" && receipt.referenceNumber == null)).toHaveLength(0);
  });
});

function ctxWith(role: string, branchId: number | null = 1): TrpcContext {
  return {
    req: { headers: {} } as unknown as TrpcContext["req"],
    res: {} as unknown as TrpcContext["res"],
    user: { id: 1, role, branchId, name: "t", email: "t@t", isActive: true } as unknown as TrpcContext["user"],
  };
}

describe("RBAC — مرتجع المشتريات (managerProcedure)", () => {
  it("الكاشير لا يستطيع إنشاء مرتجع شراء", async () => {
    const caller = purchaseReturnsRouter.createCaller(ctxWith("cashier"));
    await expect(
      caller.create({
        supplierId: 1,
        branchId: 1,
        items: [{ variantId: 1, productUnitId: 1, quantity: "1", unitPrice: "1.00" }],
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("أمين المخزن لا يستطيع إنشاء مرتجع شراء (يحمل تكلفة وذمم)", async () => {
    const caller = purchaseReturnsRouter.createCaller(ctxWith("warehouse"));
    await expect(
      caller.create({
        supplierId: 1,
        branchId: 1,
        items: [{ variantId: 1, productUnitId: 1, quantity: "1", unitPrice: "1.00" }],
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("الكاشير لا يطّلع على قائمة مرتجعات الشراء", async () => {
    const caller = purchaseReturnsRouter.createCaller(ctxWith("cashier"));
    await expect(caller.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
