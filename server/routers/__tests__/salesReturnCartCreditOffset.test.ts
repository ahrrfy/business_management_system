/**
 * مرتجع المبيعات بالسلة (`returns.executeSalesReturnCart`) — الحوكمة المحاسبية لمعادلة الذمم (CREDIT_OFFSET)
 *
 * يعالج الثغرة المالية والتشغيلية:
 *  - استرجاع فواتير البيع الآجلة (غير المدفوعة كلياً أو جزئياً) عبر معادلة الذمم دون صرف نقد من الدرج.
 *  - حظر الصرف النقدي (CASH/CARD) على الفواتير الآجلة غير المدفوعة منعاً لاختلاس أو تسريب نقد من الصناديق.
 *  - إنقاص ذمة العميل (AR) ذرياً ومطابقة الدفاتر مع `reconcileCustomerBalances() = []` بصفر انحراف.
 *  - تسوية إرساليات التوصيل تلقائياً لمنع إلزام المناديب بتحصيل أموال بضائع تم إرجاعها (reconcileDeliveryOnReturnTx).
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { TrpcContext } from "../../context";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { returnRouter } from "../returnRouter";
import { createSale } from "../../services/saleService";
import { reconcileCustomerBalances } from "../../services/reconcileService";

const TABLES = [
  "idempotencyKeys",
  "accountingEntries",
  "receipts",
  "inventoryMovements",
  "deliveryEvents",
  "deliveryLedgerEntries",
  "deliveryConsignments",
  "deliveryParties",
  "invoiceItems",
  "invoices",
  "branchStock",
  "productPrices",
  "productUnits",
  "productVariants",
  "products",
  "shifts",
  "customers",
  "suppliers",
  "branches",
  "roles",
  "users",
  "salesControlRequests",
  "returnRequests",
  "auditLogs",
];

function db() {
  const value = getDb();
  if (!value) throw new Error("DATABASE_URL not set for tests");
  return value;
}

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const table of TABLES) await d.execute(sql.raw(`DELETE FROM \`${table}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seed() {
  const d = db();
  await d.insert(s.branches).values({ id: 1, name: "الفرع الرئيسي", code: "MAIN", type: "MAIN" });
  await d.insert(s.users).values({
    id: 2,
    openId: "credit-return-cashier",
    name: "كاشير المرتجعات",
    role: "cashier",
    branchId: 1,
    loginMethod: "local",
    isOwner: false,
  });
  await d.insert(s.products).values({ id: 1, name: "دفتر تجاري" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "NOTE-1", costPrice: "5.00" });
  await d.insert(s.productUnits).values({
    id: 1,
    variantId: 1,
    unitName: "قطعة",
    conversionFactor: "1",
    isBaseUnit: true,
  });
  await d.insert(s.productPrices).values({ productUnitId: 1, priceTier: "RETAIL", price: "10.00" });
  await d.insert(s.customers).values({ id: 1, name: "عميل آجل", currentBalance: "0.00" });
  await d.insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 100 });
}

const cashier = { userId: 2, branchId: 1, role: "cashier" as const };

function context(): TrpcContext {
  return {
    req: { headers: {} } as TrpcContext["req"],
    res: { cookie() {}, clearCookie() {} } as unknown as TrpcContext["res"],
    user: {
      id: 2,
      role: "cashier",
      branchId: 1,
      name: "كاشير المرتجعات",
      email: "credit-cashier@test.local",
      isActive: true,
      isOwner: false,
    } as TrpcContext["user"],
  };
}

async function openShift(): Promise<number> {
  const r = await db().insert(s.shifts).values({
    id: 1,
    branchId: 1,
    userId: 2,
    openingBalance: "1000.00",
    status: "OPEN",
    shiftType: "RETAIL",
    openGuard: "1:2:RETAIL",
  });
  return Number((r as unknown as { insertId?: number }[])[0]?.insertId ?? 1);
}

async function customerBalance(id: number): Promise<string> {
  const rows = await db()
    .select({ b: s.customers.currentBalance })
    .from(s.customers)
    .where(eq(s.customers.id, id));
  return String(rows[0]?.b ?? "0.00");
}

describe.sequential("returns.executeSalesReturnCart — الحوكمة المحاسبية لمعادلة الذمم (CREDIT_OFFSET)", () => {
  beforeEach(async () => {
    await reset();
    await seed();
  });

  it("١) فحص الفاتورة الآجلة: inspectInvoiceForReturn يعيد سقف استرداد نقدي 0 والمدفوع 0 مع كشف الذمة والآجل", async () => {
    const shiftId = await openShift();
    // إنشاء فاتورة آجلة بالكامل (3 قطع × 10 = 30 د.ع، بلا دفع نقد)
    const sale = await createSale(
      {
        branchId: 1,
        shiftId,
        customerId: 1,
        sourceType: "POS",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "3" }],
        payment: null,
      },
      cashier,
    );

    expect(await customerBalance(1)).toBe("30.00");

    const caller = returnRouter.createCaller(context());
    const inspected = await caller.inspectInvoiceForReturn({
      invoiceNumber: sale.invoiceNumber,
    });

    expect(inspected).not.toBeNull();
    expect(inspected?.invoiceNumber).toBe(sale.invoiceNumber);
    expect(inspected?.total).toBe("30.00");
    expect(inspected?.paidAmount).toBe("0.00");
    expect(inspected?.maxRefundable).toBe("0.00");
    expect(inspected?.remainingInvoiceTotal).toBe("30.00");
    expect(inspected?.unpaidAmount).toBe("30.00");
    expect(inspected?.customerBalance).toBe("30.00");
  });

  it("٢) منع الصرف النقدي على فاتورة آجلة لم يُدفع منها نقد (منع التسريب المالي)", async () => {
    const shiftId = await openShift();
    const sale = await createSale(
      {
        branchId: 1,
        shiftId,
        customerId: 1,
        sourceType: "POS",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "3" }],
        payment: null,
      },
      cashier,
    );

    const caller = returnRouter.createCaller(context());
    const inspected = await caller.inspectInvoiceForReturn({
      invoiceNumber: sale.invoiceNumber,
    });

    const item = inspected!.items[0];

    // محاولة استرداد نقدي (CASH) لفاتورة آجلة غير مدفوعة
    await expect(
      caller.executeSalesReturnCart({
        invoiceNumber: sale.invoiceNumber,
        customer: { customerId: 1, name: "عميل آجل" },
        disposition: "RESTOCK",
        items: [
          {
            variantId: item.variantId,
            productUnitId: item.productUnitId,
            invoiceItemId: item.invoiceItemId,
            productName: item.productName,
            quantity: 3,
            unitPrice: item.unitPrice,
          },
        ],
        settlement: {
          method: "CASH",
          totalAmount: "30.00",
          shiftId,
        },
        clientRequestId: "test-block-cash-on-credit",
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });

    // صفر أثر: الذمة لم تتغير، لا إيصالات صرف، والدرج سليم
    expect(await customerBalance(1)).toBe("30.00");
    const outReceipts = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.direction, "OUT"));
    expect(outReceipts).toHaveLength(0);
  });

  it("٣) تنفيذ معادلة الذمم CREDIT_OFFSET لفاتورة آجلة بالكامل: إنقاص الذمة ذرياً + صفر نقد + سلامة الدفاتر", async () => {
    const shiftId = await openShift();
    const sale = await createSale(
      {
        branchId: 1,
        shiftId,
        customerId: 1,
        sourceType: "POS",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "3" }],
        payment: null,
      },
      cashier,
    );

    expect(await customerBalance(1)).toBe("30.00");

    const caller = returnRouter.createCaller(context());
    const inspected = await caller.inspectInvoiceForReturn({
      invoiceNumber: sale.invoiceNumber,
    });
    const item = inspected!.items[0];

    const result = await caller.executeSalesReturnCart({
      invoiceNumber: sale.invoiceNumber,
      customer: { customerId: 1, name: "عميل آجل" },
      disposition: "RESTOCK",
      items: [
        {
          variantId: item.variantId,
          productUnitId: item.productUnitId,
          invoiceItemId: item.invoiceItemId,
          productName: item.productName,
          quantity: 3,
          unitPrice: item.unitPrice,
        },
      ],
      settlement: {
        method: "CREDIT_OFFSET",
        totalAmount: "30.00",
      },
      clientRequestId: "test-credit-offset-success",
    });

    expect(result.returnNumber).toMatch(/^SR-/);
    expect(result.method).toBe("CREDIT_OFFSET");
    expect(result.totalAmount).toBe("30.00");

    // ١) رصيد ذمة العميل انخفض بمقدار 30.00 ليصبح 0.00
    expect(await customerBalance(1)).toBe("0.00");

    // ٢) الفاتورة أصبحت مسترجعة بالكامل
    const [updatedInv] = await db()
      .select()
      .from(s.invoices)
      .where(eq(s.invoices.id, sale.invoiceId));
    expect(updatedInv.status).toBe("RETURNED");
    expect(updatedInv.returnedTotal).toBe("30.00");

    // ٣) لم يُنشأ أي إيصال صرف نقدي (صفر تسريب نقد من الدرج)
    const outReceipts = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.direction, "OUT"));
    expect(outReceipts).toHaveLength(0);

    // ٤) مطابقة الذمم في الدفتر: صفر انحراف محاسبي
    const drifts = await reconcileCustomerBalances();
    expect(drifts).toEqual([]);
  });

  it("٤) فاتورة مدفوعة جزئياً: معادلة الذمم تخفض المتبقي الآجل ولا تتجاوز سقف الفاتورة", async () => {
    const shiftId = await openShift();
    // إجمالي 50 د.ع (5 قطع × 10)، دُفع منها 20 د.ع نقداً والباقي 30 د.ع آجل
    const sale = await createSale(
      {
        branchId: 1,
        shiftId,
        customerId: 1,
        sourceType: "POS",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "5" }],
        payment: { amount: "20.00", method: "CASH" },
      },
      cashier,
    );

    // رصيد ذمة العميل أصبح 30.00 د.ع
    expect(await customerBalance(1)).toBe("30.00");

    const caller = returnRouter.createCaller(context());
    const inspected = await caller.inspectInvoiceForReturn({
      invoiceNumber: sale.invoiceNumber,
    });
    expect(inspected?.paidAmount).toBe("20.00");
    expect(inspected?.maxRefundable).toBe("20.00"); // السقف النقدي هو المدفوع فقط
    expect(inspected?.unpaidAmount).toBe("30.00");
    expect(inspected?.remainingInvoiceTotal).toBe("50.00");

    const item = inspected!.items[0];

    // إرجاع 3 قطع (30 د.ع) بمعادلة الذمم
    await caller.executeSalesReturnCart({
      invoiceNumber: sale.invoiceNumber,
      customer: { customerId: 1, name: "عميل آجل" },
      disposition: "RESTOCK",
      items: [
        {
          variantId: item.variantId,
          productUnitId: item.productUnitId,
          invoiceItemId: item.invoiceItemId,
          productName: item.productName,
          quantity: 3,
          unitPrice: item.unitPrice,
        },
      ],
      settlement: {
        method: "CREDIT_OFFSET",
        totalAmount: "30.00",
      },
      clientRequestId: "test-partial-credit-offset",
    });

    // ذمة العميل انخفضت من 30.00 إلى 0.00
    expect(await customerBalance(1)).toBe("0.00");

    // الفاتورة متبقي إجماليها 20 د.ع وهو نفس المدفوع
    const [invAfter] = await db()
      .select()
      .from(s.invoices)
      .where(eq(s.invoices.id, sale.invoiceId));
    expect(invAfter.returnedTotal).toBe("30.00");

    // لا انحراف في الدفاتر
    expect(await reconcileCustomerBalances()).toEqual([]);
  });

  it("٥) معادلة الذمم تتطلب وجود عميل مسجل: رفض المرتجع العابر بدون عميل بطريقة CREDIT_OFFSET", async () => {
    const caller = returnRouter.createCaller(context());
    await expect(
      caller.executeSalesReturnCart({
        customer: undefined,
        disposition: "RESTOCK",
        items: [
          {
            variantId: 1,
            productUnitId: 1,
            productName: "دفتر تجاري",
            quantity: 1,
            unitPrice: "10.00",
          },
        ],
        settlement: {
          method: "CREDIT_OFFSET",
          totalAmount: "10.00",
        },
        clientRequestId: "test-credit-offset-no-customer",
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("٦) تسوية إرسالية التوصيل عند إرجاع الفاتورة: إعفاء المندوب من تحصيل المبلغ تلقائياً", async () => {
    const shiftId = await openShift();
    // إنشاء شركة/مندوب توصيل
    await db().insert(s.deliveryParties).values({
      id: 1,
      name: "شركة التوصيل السريع",
      partyType: "COMPANY",
      currentBalance: "0.00",
      branchId: 1,
    });

    // إنشاء بيع مع توصيل
    const sale = await createSale(
      {
        branchId: 1,
        shiftId,
        customerId: 1,
        sourceType: "POS",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "3" }],
        payment: null, // بيع آجل / COD
      },
      cashier,
    );

    // تسجيل إرسالية توصيل نشطة
    await db().insert(s.deliveryConsignments).values({
      id: 1,
      consignmentNumber: "CN-TEST-001",
      branchId: 1,
      invoiceId: sale.invoiceId,
      sourceType: "INVOICE",
      sourceId: sale.invoiceId,
      partyId: 1,
      recipientName: "العميل",
      recipientPhone: "07700000000",
      status: "DISPATCHED",
      parcelStatus: "OUT_FOR_DELIVERY",
      moneyStatus: "UNSETTLED",
      codAmount: "30.00",
      deliveryFee: "5.00",
      feeCollection: "COURIER",
    });

    const caller = returnRouter.createCaller(context());
    const inspected = await caller.inspectInvoiceForReturn({
      invoiceNumber: sale.invoiceNumber,
    });
    const item = inspected!.items[0];

    // إرجاع الفاتورة (امتناع العميل عن الاستلام) بمعادلة الذمم
    await caller.executeSalesReturnCart({
      invoiceNumber: sale.invoiceNumber,
      customer: { customerId: 1, name: "عميل آجل" },
      disposition: "RESTOCK",
      items: [
        {
          variantId: item.variantId,
          productUnitId: item.productUnitId,
          invoiceItemId: item.invoiceItemId,
          productName: item.productName,
          quantity: 3,
          unitPrice: item.unitPrice,
        },
      ],
      settlement: {
        method: "CREDIT_OFFSET",
        totalAmount: "30.00",
      },
      clientRequestId: "test-return-with-delivery",
    });

    // الإرسالية أصبحت RECONCILED أو RETURNED وتفرغ ذمة المندوب
    const [consignment] = await db()
      .select()
      .from(s.deliveryConsignments)
      .where(eq(s.deliveryConsignments.id, 1));
    expect(["RECONCILED", "RETURNED"]).toContain(consignment.status);
    expect(await customerBalance(1)).toBe("0.00");
    expect(await reconcileCustomerBalances()).toEqual([]);
  });

  it("٧) إرسالية توصيل مسلّمة وعليها عهدة نقدية غير مورّدة: عكس عهدة التوصيل وصون مسار التوريد", async () => {
    const shiftId = await openShift();
    await db().insert(s.deliveryParties).values({
      id: 1,
      name: "شركة التوصيل السريع",
      partyType: "COMPANY",
      currentBalance: "30.00",
      branchId: 1,
    });

    const sale = await createSale(
      {
        branchId: 1,
        shiftId,
        customerId: 1,
        sourceType: "POS",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "3" }],
        payment: null,
      },
      cashier,
    );

    // تسجيل إرسالية مسلّمة وقبض المندوب النقد لكن لم يورّده بعد (عهدة حية)
    await db().insert(s.deliveryConsignments).values({
      id: 1,
      consignmentNumber: "CN-TEST-002",
      branchId: 1,
      invoiceId: sale.invoiceId,
      sourceType: "INVOICE",
      sourceId: sale.invoiceId,
      partyId: 1,
      recipientName: "العميل",
      recipientPhone: "07700000000",
      status: "DELIVERED",
      parcelStatus: "DELIVERED",
      moneyStatus: "UNSETTLED",
      codAmount: "30.00",
      collectedAmount: "30.00",
      deliveryFee: "5.00",
      feeCollection: "COURIER",
    });

    // تسجيل قيد تحصيل COD في دفتر التوصيل كعهدة غير مورّدة وتحديث الفاتورة إلى مسددة وسداد ذمة العميل
    await db().update(s.invoices).set({
      paidAmount: "30.00",
      status: "PAID",
    }).where(eq(s.invoices.id, sale.invoiceId));

    await db().update(s.customers).set({
      currentBalance: "0.00",
    }).where(eq(s.customers.id, 1));

    await db().insert(s.deliveryLedgerEntries).values({
      id: 1,
      eventKey: "CN:1:COD_COLLECTED:TEST",
      partyId: 1,
      consignmentId: 1,
      branchId: 1,
      entryType: "COD_COLLECTED",
      amount: "30.00",
      actorUserId: 2,
      notes: "تحصيل كاش",
    });

    const caller = returnRouter.createCaller(context());
    const inspected = await caller.inspectInvoiceForReturn({
      invoiceNumber: sale.invoiceNumber,
    });
    const item = inspected!.items[0];

    // إرجاع الفاتورة عبر سلة المرتجعات
    await caller.executeSalesReturnCart({
      invoiceNumber: sale.invoiceNumber,
      customer: { customerId: 1, name: "عميل آجل" },
      disposition: "RESTOCK",
      items: [
        {
          variantId: item.variantId,
          productUnitId: item.productUnitId,
          invoiceItemId: item.invoiceItemId,
          productName: item.productName,
          quantity: 3,
          unitPrice: item.unitPrice,
        },
      ],
      settlement: {
        method: "CREDIT_OFFSET",
        totalAmount: "30.00",
      },
      clientRequestId: "test-return-with-unremitted-custody",
    });

    // التحقق من تسجيل قيد COD_RETURNED وعكس عهدة التوصيل دون فقدان المسار
    const [revEntry] = await db()
      .select()
      .from(s.deliveryLedgerEntries)
      .where(
        and(
          eq(s.deliveryLedgerEntries.consignmentId, 1),
          eq(s.deliveryLedgerEntries.entryType, "COD_RETURNED"),
        ),
      );
    expect(revEntry).toBeDefined();
    expect(revEntry.amount).toBe("30.00");
    expect(await customerBalance(1)).toBe("0.00");
    expect(await reconcileCustomerBalances()).toEqual([]);
  });
});
