/**
 * اختبارات تحقق صلاحيات الكاشير بمختلف أدواره (استقبال، تجزئة، طباعة)
 * والربط الذري للاسترداد المالي من الورديات عند المرتجع أو الإلغاء
 * مع دعم العربون الجزئي وتعدد طرق الدفع والاسترداد.
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { TrpcContext } from "../../context";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { returnRouter } from "../returnRouter";
import { printPosRouter } from "../printPosRouter";
import { createSale } from "../../services/saleService";

const TABLES = [
  "idempotencyKeys",
  "accountingEntries",
  "receipts",
  "inventoryMovements",
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

  // مستخدم كاشير استقبال (workorders: FULL بالقالب دون operationalCaps صريحة — يرث سقف reception_clerk)
  await d.insert(s.users).values({
    id: 10,
    openId: "reception-user",
    name: "مشغل الاستقبال",
    role: "print_operator", // له workorders: "FULL" بالقالب
    branchId: 1,
    loginMethod: "local",
    isOwner: false,
  });

  // مستخدم كاشير طباعة (pos: FULL دون operationalCaps صريحة — يرث سقف cashier)
  await d.insert(s.users).values({
    id: 11,
    openId: "print-user",
    name: "كاشير الطباعة",
    role: "user",
    permissionsOverride: { pos: "FULL" },
    branchId: 1,
    loginMethod: "local",
    isOwner: false,
  });

  // مستخدم كاشير تجزئة (sales: FULL)
  await d.insert(s.users).values({
    id: 12,
    openId: "retail-user",
    name: "كاشير التجزئة",
    role: "cashier", // له sales: "FULL", pos: "FULL", workorders: "FULL"
    branchId: 1,
    loginMethod: "local",
    isOwner: false,
  });

  // مستخدم عام غير مصرح (بلا صلاحيات نقاط بيع)
  await d.insert(s.users).values({
    id: 13,
    openId: "no-access-user",
    name: "مستخدم بلا صلاحية",
    role: "user",
    branchId: 1,
    loginMethod: "local",
    isOwner: false,
  });

  await d.insert(s.products).values({ id: 1, name: "كارت شخصي" });
  await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "CARD-1", costPrice: "5.00" });
  await d.insert(s.productUnits).values({
    id: 1,
    variantId: 1,
    unitName: "علبة",
    barcode: "BC-CARD-1",
    conversionFactor: "1",
    isBaseUnit: true,
  });
  await d.insert(s.productPrices).values({ productUnitId: 1, priceTier: "RETAIL", price: "25.00" });
  await d.insert(s.customers).values({ id: 1, name: "زبون معتمد", currentBalance: "0.00" });
  await d.insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 200 });
}

function createContextFor(user: { id: number; name: string; role: string; permissionsOverride?: any }): TrpcContext {
  return {
    req: { headers: {} } as TrpcContext["req"],
    res: { cookie() {}, clearCookie() {} } as unknown as TrpcContext["res"],
    user: {
      id: user.id,
      role: user.role,
      permissionsOverride: user.permissionsOverride ?? null,
      branchId: 1,
      name: user.name,
      email: `${user.name}@test.local`,
      isActive: true,
      isOwner: false,
    } as TrpcContext["user"],
  };
}

async function openShiftFor(userId: number, shiftType: "RECEPTION" | "PRINT_SERVICES" | "RETAIL" = "RETAIL"): Promise<number> {
  const r = await db().insert(s.shifts).values({
    branchId: 1,
    userId,
    openingBalance: "100.00",
    status: "OPEN",
    shiftType,
    openGuard: `1:${userId}:${shiftType}`,
  });
  return Number((r as unknown as { insertId?: number }[])[0]?.insertId ?? 1);
}

describe("صلاحيات الكاشير والاسترداد المالي من الورديات للبيع المعلق والمرتجع", () => {
  beforeEach(async () => {
    await reset();
    await seed();
  });

  it("١. كاشير الاستقبال (workorders: FULL) يستطيع استعلام المرتجعات وصرف المسترد النقدي من ورديته", async () => {
    const receptionCtx = createContextFor({ id: 10, name: "مشغل الاستقبال", role: "print_operator" });
    const shiftId = await openShiftFor(10, "RECEPTION");

    // إنشاء فاتورة أصلية
    const sale = await createSale(
      {
        branchId: 1,
        shiftId,
        customerId: 1,
        sourceType: "POS",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "2" }], // إجمالي 50.00
        payment: { amount: "50.00", method: "CASH" },
      },
      { userId: 10, branchId: 1, role: "print_operator" },
    );

    const caller = returnRouter.createCaller(receptionCtx);

    // فحص الفاتورة للإرجاع
    const inspected = await caller.inspectInvoiceForReturn({
      invoiceNumber: sale.invoiceNumber,
    });
    expect(inspected.invoiceNumber).toBe(sale.invoiceNumber);
    expect(inspected?.items?.length).toBe(1);

    // فحص قائمة الأدراج المتاحة
    const drawers = await caller.getOpenRefundDrawers();
    expect(drawers.length).toBeGreaterThanOrEqual(1);
    expect(drawers.some((d) => d.shiftId === shiftId && d.isMine)).toBe(true);

    // تنفيذ المرتجع النقدي بالسلة
    const returnRes = await caller.executeSalesReturnCart({
      invoiceNumber: sale.invoiceNumber,
      customer: { customerId: 1 },
      items: [
        {
          variantId: 1,
          productName: "كارت شخصي",
          quantity: 1,
          unitPrice: "25.00",
        },
      ],
      settlement: {
        method: "CASH",
        totalAmount: "25.00",
        shiftId,
      },
    });

    expect(returnRes.ok).toBe(true);
    expect(returnRes.totalAmount).toBe("25.00");

    // التحقق من سند الصرف (DRAWER OUT) المرتبط بالوردية
    const refundReceipt = (
      await db()
        .select()
        .from(s.receipts)
        .where(
          and(
            eq(s.receipts.invoiceId, sale.invoiceId),
            eq(s.receipts.direction, "OUT"),
          ),
        )
    )[0];

    expect(refundReceipt).toBeDefined();
    expect(refundReceipt.cashBucket).toBe("DRAWER");
    expect(refundReceipt.shiftId).toBe(shiftId);
    expect(refundReceipt.paymentMethod).toBe("CASH");
    expect(Number(refundReceipt.amount)).toBe(25.0);

    // التحقق من القيد المحاسبي PAYMENT_OUT
    const acctEntry = (
      await db()
        .select()
        .from(s.accountingEntries)
        .where(eq(s.accountingEntries.receiptId, refundReceipt.id))
    )[0];
    expect(acctEntry).toBeDefined();
    expect(acctEntry.entryType).toContain("PAYMENT_OUT");
  });

  it("٢. كاشير الطباعة (pos: FULL) يستطيع استرجاع ببطاقة الدفع بمرجع جهاز نقاط البيع", async () => {
    const printCtx = createContextFor({
      id: 11,
      name: "كاشير الطباعة",
      role: "user",
      permissionsOverride: { pos: "FULL" },
    });
    const shiftId = await openShiftFor(11, "PRINT_SERVICES");

    const sale = await createSale(
      {
        branchId: 1,
        shiftId,
        customerId: 1,
        sourceType: "POS",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }], // 25.00
        payment: { amount: "25.00", method: "CARD", reference: "POS-SWIPE-101" },
      },
      { userId: 11, branchId: 1, role: "user" },
    );

    const caller = returnRouter.createCaller(printCtx);

    const returnRes = await caller.executeSalesReturnCart({
      invoiceNumber: sale.invoiceNumber,
      customer: { customerId: 1 },
      items: [
        {
          variantId: 1,
          productName: "كارت شخصي",
          quantity: 1,
          unitPrice: "25.00",
        },
      ],
      settlement: {
        method: "CARD",
        totalAmount: "25.00",
        reference: "POS-REF-987654",
      },
    });

    expect(returnRes.ok).toBe(true);
    expect(returnRes.totalAmount).toBe("25.00");

    const refundReceipt = (
      await db()
        .select()
        .from(s.receipts)
        .where(
          and(
            eq(s.receipts.invoiceId, sale.invoiceId),
            eq(s.receipts.direction, "OUT"),
          ),
        )
    )[0];

    expect(refundReceipt).toBeDefined();
    expect(refundReceipt.paymentMethod).toBe("CARD");
    expect(refundReceipt.referenceNumber).toBe("POS-REF-987654");
  });

  it("٢ب. الرد النقدي لا يختار وردية جديدة عند إغفال وردية الفاتورة الأصلية", async () => {
    const originalShiftId = await openShiftFor(12, "RETAIL");
    const sale = await createSale({
      branchId: 1,
      shiftId: originalShiftId,
      customerId: 1,
      sourceType: "POS",
      lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
      payment: { amount: "25.00", method: "CASH" },
    }, { userId: 12, branchId: 1, role: "cashier" });
    await db().update(s.shifts).set({ status: "CLOSED", closedAt: new Date(), openGuard: null })
      .where(eq(s.shifts.id, originalShiftId));
    await openShiftFor(12, "RETAIL");

    const caller = returnRouter.createCaller(createContextFor({ id: 12, name: "كاشير التجزئة", role: "cashier" }));
    await expect(caller.executeSalesReturnCart({
      invoiceNumber: sale.invoiceNumber,
      customer: { customerId: 1 },
      items: [{ variantId: 1, productName: "كارت شخصي", quantity: 1, unitPrice: "25.00" }],
      settlement: { method: "CASH", totalAmount: "25.00" },
    })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("٢ج. المرتجع المباشر يرفض فاتورة يوم سابق قبل أي صرف أو حركة", async () => {
    const shiftId = await openShiftFor(12, "RETAIL");
    const sale = await createSale({
      branchId: 1,
      shiftId,
      customerId: 1,
      sourceType: "POS",
      lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
      payment: { amount: "25.00", method: "CASH" },
    }, { userId: 12, branchId: 1, role: "cashier" });
    await db().update(s.invoices)
      .set({ invoiceDate: new Date(Date.now() - 24 * 60 * 60 * 1000) })
      .where(eq(s.invoices.id, sale.invoiceId));

    const caller = returnRouter.createCaller(createContextFor({ id: 12, name: "كاشير التجزئة", role: "cashier" }));
    await expect(caller.executeSalesReturnCart({
      invoiceNumber: sale.invoiceNumber,
      customer: { customerId: 1 },
      items: [{ variantId: 1, productName: "كارت شخصي", quantity: 1, unitPrice: "25.00" }],
      settlement: { method: "CASH", totalAmount: "25.00", shiftId },
    })).rejects.toThrow(/ليس من يوم العمل الحالي/);
    expect(await db().select().from(s.returnRequests)).toHaveLength(0);
    expect((await db().select().from(s.receipts).where(and(eq(s.receipts.invoiceId, sale.invoiceId), eq(s.receipts.direction, "OUT"))))).toHaveLength(0);
  });

  it("٢د. المرتجع المباشر يرفض تحويل دفعة البطاقة إلى نقد", async () => {
    const shiftId = await openShiftFor(12, "RETAIL");
    const sale = await createSale({
      branchId: 1,
      shiftId,
      customerId: 1,
      sourceType: "POS",
      lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
      payment: { amount: "25.00", method: "CARD", reference: "CARD-IN-RAIL" },
    }, { userId: 12, branchId: 1, role: "cashier" });

    const caller = returnRouter.createCaller(createContextFor({ id: 12, name: "كاشير التجزئة", role: "cashier" }));
    await expect(caller.executeSalesReturnCart({
      invoiceNumber: sale.invoiceNumber,
      customer: { customerId: 1 },
      items: [{ variantId: 1, productName: "كارت شخصي", quantity: 1, unitPrice: "25.00" }],
      settlement: { method: "CASH", totalAmount: "25.00", shiftId },
    })).rejects.toThrow(/طريقة الرد لا تطابق طريقة الدفع الأصلية/);
    expect((await db().select().from(s.receipts).where(and(eq(s.receipts.invoiceId, sale.invoiceId), eq(s.receipts.direction, "OUT"))))).toHaveLength(0);
  });

  it("٣. إلغاء طلب محجوز بعربون جزئي في كاشير الطباعة (cancelHeldSale) مع استرداد العربون نقداً من الوردية", async () => {
    const printCtx = createContextFor({
      id: 11,
      name: "كاشير الطباعة",
      role: "user",
      permissionsOverride: { pos: "FULL" },
    });
    const shiftId = await openShiftFor(11, "PRINT_SERVICES");

    // إنشاء طلب محجوز في POS بعربون جزئي (10.00 من إجمالي 25.00)
    const heldSale = await createSale(
      {
        branchId: 1,
        shiftId,
        customerId: 1,
        sourceType: "POS",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
        payment: { amount: "10.00", method: "CASH" },
      },
      { userId: 11, branchId: 1, role: "user" },
    );

    // التأكد من أن الفاتورة PARTIALLY_PAID
    const [invBefore] = await db()
      .select()
      .from(s.invoices)
      .where(eq(s.invoices.id, heldSale.invoiceId));
    expect(invBefore.status).toBe("PARTIALLY_PAID");
    expect(Number(invBefore.paidAmount)).toBe(10.0);

    const posCaller = printPosRouter.createCaller(printCtx);

    // إلغاء الطلب المحجوز مع رد العربون نقداً
    const cancelRes = await posCaller.cancelHeldSale({
      invoiceId: heldSale.invoiceId,
      reason: "الزبون ألغى الطلب عند الكاشير واسترد العربون",
      refundPaymentMethod: "CASH",
    });

    expect(cancelRes.refundAmount).toBe("10.00");

    // التحقق من أن حالة الفاتورة تحولت إلى CANCELLED
    const [invAfter] = await db()
      .select()
      .from(s.invoices)
      .where(eq(s.invoices.id, heldSale.invoiceId));
    expect(invAfter.status).toBe("CANCELLED");

    // التحقق من صدور إيصال استرداد نقدي مرتبط بوردية الكاشير
    const cancelReceipt = (
      await db()
        .select()
        .from(s.receipts)
        .where(
          and(
            eq(s.receipts.invoiceId, heldSale.invoiceId),
            eq(s.receipts.direction, "OUT"),
          ),
        )
    )[0];

    expect(cancelReceipt).toBeDefined();
    expect(cancelReceipt.cashBucket).toBe("DRAWER");
    expect(cancelReceipt.shiftId).toBe(shiftId);
    expect(Number(cancelReceipt.amount)).toBe(10.0);
  });

  it("٤. إلغاء طلب محجوز بعربون بطاقة في كاشير الطباعة مع إلزامية رقم المرجع", async () => {
    const printCtx = createContextFor({
      id: 11,
      name: "كاشير الطباعة",
      role: "user",
      permissionsOverride: { pos: "FULL" },
    });
    const shiftId = await openShiftFor(11, "PRINT_SERVICES");

    const heldSale = await createSale(
      {
        branchId: 1,
        shiftId,
        customerId: 1,
        sourceType: "POS",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
        payment: { amount: "15.00", method: "CARD", reference: "POS-SWIPE-102" },
      },
      { userId: 11, branchId: 1, role: "user" },
    );

    const posCaller = printPosRouter.createCaller(printCtx);

    // محاولة الإلغاء بدون مرجع جهاز الدفع يجب أن تُرفض
    await expect(
      posCaller.cancelHeldSale({
        invoiceId: heldSale.invoiceId,
        reason: "إلغاء واسترداد للبطاقة",
        refundPaymentMethod: "CARD",
      }),
    ).rejects.toThrow(/مرجع عملية الاسترداد من جهاز الدفع لم يصل/);

    // مع تزويد المرجع تنجح العملية
    const res = await posCaller.cancelHeldSale({
      invoiceId: heldSale.invoiceId,
      reason: "إلغاء واسترداد للبطاقة مع إيصال الجهاز",
      refundPaymentMethod: "CARD",
      reference: "POS-REF-CARD-CANCEL-1",
    });

    expect(res.refundAmount).toBe("15.00");

    const refundReceipt = (
      await db()
        .select()
        .from(s.receipts)
        .where(
          and(
            eq(s.receipts.invoiceId, heldSale.invoiceId),
            eq(s.receipts.direction, "OUT"),
          ),
        )
    )[0];
    expect(refundReceipt.paymentMethod).toBe("CARD");
    expect(refundReceipt.referenceNumber).toBe("POS-REF-CARD-CANCEL-1");
  });

  it("٥. المستخدم غير المصرح له (بلا صلاحية sales أو workorders أو pos) يُحجب برمز FORBIDDEN", async () => {
    const unauthorizedCtx = createContextFor({
      id: 13,
      name: "مستخدم بلا صلاحية",
      role: "user",
    });

    const caller = returnRouter.createCaller(unauthorizedCtx);

    await expect(caller.getOpenRefundDrawers()).rejects.toThrow(
      /يتطلب صلاحية كاشير المبيعات أو مشغّل الاستقبال أو كاشير الطباعة/,
    );
  });

  it("٦. كاشير التجزئة وكاشير الاستقبال يفحصان الأصناف والورديات وينفذان مرتجع السلة ضمن الضوابط", async () => {
    const retailCtx = createContextFor({
      id: 12,
      name: "كاشير التجزئة",
      role: "cashier",
    });
    const receptionCtx = createContextFor({
      id: 10,
      name: "موظف الاستقبال",
      role: "print_operator",
      permissionsOverride: { workorders: "FULL" },
    });

    const retailShiftId = await openShiftFor(12, "RETAIL");
    const receptionShiftId = await openShiftFor(10, "RECEPTION");

    const retailCaller = returnRouter.createCaller(retailCtx);
    const receptionCaller = returnRouter.createCaller(receptionCtx);

    const retailLookup = await retailCaller.lookupItemForReturn({
      barcode: "BC-CARD-1",
    });
    expect(retailLookup.variantId).toBe(1);

    const receptionLookup = await receptionCaller.lookupItemForReturn({
      barcode: "BC-CARD-1",
    });
    expect(receptionLookup.variantId).toBe(1);

    const receptionShifts = await receptionCaller.shifts();
    expect(receptionShifts.some((s) => s.shiftId === receptionShiftId && s.isMine)).toBe(true);

    // مرتجع سلة نقدي عابر ضمن سقف الكاشير ومن درج ورديته المفتوحة المموّلة
    const retailWalkIn = await retailCaller.executeSalesReturnCart({
      items: [
        {
          variantId: 1,
          productName: "كارت شخصي",
          quantity: 1,
          unitPrice: "25.00",
        },
      ],
      settlement: {
        method: "CASH",
        totalAmount: "25.00",
        shiftId: retailShiftId,
      },
    });
    expect(retailWalkIn.ok).toBe(true);

    const receptionWalkIn = await receptionCaller.executeSalesReturnCart({
      items: [
        {
          variantId: 1,
          productName: "كارت شخصي",
          quantity: 1,
          unitPrice: "25.00",
        },
      ],
      settlement: {
        method: "CASH",
        totalAmount: "25.00",
        shiftId: receptionShiftId,
      },
    });
    expect(receptionWalkIn.ok).toBe(true);

    // فواتير أوامر الشغل (WORKORDER) تُرفض في inspectInvoiceForReturn و executeSalesReturnCart
    await db().insert(s.invoices).values({
      id: 901,
      invoiceNumber: "INV-WO-901",
      branchId: 1,
      sourceType: "WORKORDER",
      sourceId: "WO-901",
      subtotal: "25.00",
      discountAmount: "0.00",
      taxAmount: "0.00",
      total: "25.00",
      paidAmount: "25.00",
      returnedTotal: "0.00",
      status: "PAID",
      paymentMethod: "CASH",
      createdBy: 10,
      shiftId: receptionShiftId,
    });

    await expect(
      receptionCaller.inspectInvoiceForReturn({ invoiceNumber: "INV-WO-901" }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    await expect(
      receptionCaller.executeSalesReturnCart({
        invoiceNumber: "INV-WO-901",
        items: [
          {
            variantId: 1,
            productName: "كارت شخصي",
            quantity: 1,
            unitPrice: "25.00",
          },
        ],
        settlement: {
          method: "CASH",
          totalAmount: "25.00",
          shiftId: receptionShiftId,
        },
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    // عزل الأدراج لحسابات الترحيل التوافقي (role="user" مع pos:FULL أو workorders:FULL)
    const printShiftId = await openShiftFor(11, "PRINT_SERVICES");
    const printCaller = returnRouter.createCaller(
      createContextFor({
        id: 11,
        name: "كاشير الطباعة",
        role: "user",
        permissionsOverride: { pos: "FULL" },
      }),
    );
    const printShifts = await printCaller.shifts();
    expect(printShifts.map((s) => s.shiftId)).toEqual([printShiftId]);
    const printDrawers = await printCaller.getOpenRefundDrawers();
    expect(printDrawers.map((d) => d.shiftId)).toEqual([printShiftId]);

    // عزل قنوات التحري (forensicTrace) والمسح الكوني (universalScan) حسب قناة الكاشير
    const retailSale = await createSale(
      {
        branchId: 1,
        shiftId: retailShiftId,
        customerId: 1,
        sourceType: "POS",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
        payment: { amount: "25.00", method: "CASH" },
      },
      { userId: 12, branchId: 1, role: "cashier" },
    );
    const receptionSale = await createSale(
      {
        branchId: 1,
        shiftId: receptionShiftId,
        customerId: 1,
        sourceType: "POS",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
        payment: { amount: "25.00", method: "CASH" },
      },
      { userId: 10, branchId: 1, role: "print_operator" },
    );
    const printSale = await createSale(
      {
        branchId: 1,
        shiftId: printShiftId,
        customerId: 1,
        sourceType: "POS",
        lines: [{ variantId: 1, productUnitId: 1, quantity: "1" }],
        payment: { amount: "25.00", method: "CASH" },
      },
      { userId: 11, branchId: 1, role: "user" },
    );

    const receptionTrace = await receptionCaller.forensicTrace({
      mode: "DATE_SHIFT",
      query: "ALL",
    });
    const receptionTracedIds = receptionTrace.results.map((r) => r.invoiceId);
    expect(receptionTracedIds).toContain(receptionSale.invoiceId);
    expect(receptionTracedIds).not.toContain(retailSale.invoiceId);
    expect(receptionTracedIds).not.toContain(printSale.invoiceId);

    const printTrace = await printCaller.forensicTrace({
      mode: "DATE_SHIFT",
      query: "ALL",
    });
    const printTracedIds = printTrace.results.map((r) => r.invoiceId);
    expect(printTracedIds).toContain(printSale.invoiceId);
    expect(printTracedIds).not.toContain(retailSale.invoiceId);
    expect(printTracedIds).not.toContain(receptionSale.invoiceId);

    const retailScanByReception = await receptionCaller.universalScan({
      barcode: retailSale.invoiceNumber,
    });
    expect(retailScanByReception.recognized).toBe(false);

    const retailInspectByReception = await receptionCaller.inspectInvoiceForReturn({
      invoiceNumber: retailSale.invoiceNumber,
    });
    expect(retailInspectByReception).toBeNull();
    const printInspectByReception = await receptionCaller.inspectInvoiceForReturn({
      invoiceNumber: printSale.invoiceNumber,
    });
    expect(printInspectByReception).toBeNull();
    const receptionInspectByPrint = await printCaller.inspectInvoiceForReturn({
      invoiceNumber: receptionSale.invoiceNumber,
    });
    expect(receptionInspectByPrint).toBeNull();

    await expect(
      receptionCaller.executeSalesReturnCart({
        invoiceNumber: retailSale.invoiceNumber,
        items: [
          {
            variantId: 1,
            productName: "كارت شخصي",
            quantity: 1,
            unitPrice: "25.00",
          },
        ],
        settlement: {
          method: "CASH",
          totalAmount: "25.00",
          shiftId: receptionShiftId,
        },
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // عزل المسح الكوني عن وحدات المستندات غير المفوضة (أوامر الشغل ومرتجعات الشراء)
    await db().insert(s.workOrders).values({
      id: 950,
      orderNumber: "WO-SCAN-950",
      branchId: 1,
      customerId: 1,
      title: "أمر شغل سري",
      quantity: 1,
      salePrice: "100.00",
      deposit: "50.00",
      status: "NEW",
      createdBy: 10,
    } as never);
    const woScanByPrint = await printCaller.universalScan({
      barcode: "WO-SCAN-950",
    });
    expect(woScanByPrint.recognized).toBe(false);
    const woScanByReception = await receptionCaller.universalScan({
      barcode: "WO-SCAN-950",
    });
    expect(woScanByReception.recognized).toBe(true);
    expect(woScanByReception.kind).toBe("WORK_ORDER");

    // رفض تعديل سعر البند أو إجمالي التسوية في المرتجع المرتبط بفاتورة
    await expect(
      receptionCaller.executeSalesReturnCart({
        invoiceNumber: receptionSale.invoiceNumber,
        items: [
          {
            variantId: 1,
            productName: "كارت شخصي",
            quantity: 1,
            unitPrice: "1.00",
          },
        ],
        settlement: {
          method: "CASH",
          totalAmount: "1.00",
          shiftId: receptionShiftId,
        },
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // رفض المرتجع العابر بلا فاتورة لصنف لا يملك سعر بيع تجزئة معتمداً في الكتالوج
    await db().delete(s.productPrices).where(eq(s.productPrices.productUnitId, 1));
    await expect(
      retailCaller.executeSalesReturnCart({
        items: [
          {
            variantId: 1,
            productName: "كارت شخصي",
            quantity: 1,
            unitPrice: "25.00",
          },
        ],
        settlement: {
          method: "CASH",
          totalAmount: "25.00",
          shiftId: retailShiftId,
        },
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });
});
