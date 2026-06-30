import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { closeShift } from "../shiftService";
import { createVoucher, listVouchers } from "../voucherService";

const actor = { userId: 1, branchId: 1, role: "admin" };

const TABLES = [
  "idempotencyKeys", "accountingEntries", "receipts", "inventoryMovements", "invoiceItems", "invoices",
  "purchaseOrderItems", "purchaseOrders",
  "branchStock", "productPrices", "productUnits", "productVariants", "products",
  "shifts", "workOrderMaterials", "workOrders", "customers", "suppliers", "branches", "users",
  "auditLogs",
];

function db() {
  const d = getDb();
  if (!d) throw new Error("DATABASE_URL not set");
  return d;
}
const insertId = (res: any): number => Number(res?.[0]?.insertId ?? res?.insertId);

async function reset() {
  const d = db();
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of TABLES) await d.execute(sql.raw(`TRUNCATE TABLE \`${t}\``));
  await d.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

async function seedBase() {
  const d = db();
  await d.insert(s.branches).values([{ id: 1, name: "MAIN", code: "MAIN", type: "MAIN" }]);
  await d.insert(s.users).values({ id: 1, openId: "admin", name: "admin", role: "admin", loginMethod: "local" });
  await d.insert(s.customers).values({ id: 1, name: "تاجر", defaultPriceTier: "RETAIL", currentBalance: "100.00" });
  await d.insert(s.suppliers).values({ id: 1, name: "مورّد", currentBalance: "50.00" });
}

async function openShift(branchId = 1, userId = 1): Promise<number> {
  const r = await db().insert(s.shifts).values({ branchId, userId, openingBalance: "0", status: "OPEN" });
  return insertId(r);
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("سند قبض (RECEIPT) — IN", () => {
  it("قبض من عميل يَكتب receipt + قيد PAYMENT_IN + AR ينقص", async () => {
    await openShift(1, 1); // shift-gate: السندات النقدية تتطلّب وردية مفتوحة (إنفاذ shift-gate-cash).
    const r = await createVoucher(
      {
        voucherType: "RECEIPT",
        branchId: 1,
        amount: "30.00",
        paymentMethod: "CASH",
        partyType: "CUSTOMER",
        partyId: 1,
        description: "دفعة جزئية من تاجر",
      },
      actor,
    );
    expect(r.voucherNumber).toMatch(/^RV-1-\d{8}-00001$/);
    expect(r.direction).toBe("IN");

    const rc = (await db().select().from(s.receipts).where(eq(s.receipts.id, r.receiptId)))[0];
    expect(rc.direction).toBe("IN");
    expect(rc.amount).toBe("30.00");
    expect(rc.partyType).toBe("CUSTOMER");

    const ent = await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "PAYMENT_IN"));
    expect(ent).toHaveLength(1);
    expect(ent[0].amount).toBe("30.00");

    const cust = (await db().select().from(s.customers).where(eq(s.customers.id, 1)))[0];
    expect(cust.currentBalance).toBe("70.00"); // 100 − 30
  });

  it("قبض من OTHER (إيرادات متفرّقة): receipt + قيد، لا تأثير على ذمم", async () => {
    await openShift(1, 1); // shift-gate
    const r = await createVoucher(
      {
        voucherType: "RECEIPT",
        branchId: 1,
        amount: "200.00",
        paymentMethod: "CASH",
        partyType: "OTHER",
        partyId: null,
        description: "إيرادات بيع مخلفات",
      },
      actor,
    );
    expect(r.voucherNumber).toMatch(/^RV-/);
    const cust = (await db().select().from(s.customers).where(eq(s.customers.id, 1)))[0];
    expect(cust.currentBalance).toBe("100.00"); // لم يتغيّر
  });
});

describe("سند صرف (PAYMENT) — OUT", () => {
  it("صرف لمورّد يَكتب receipt + قيد PAYMENT_OUT + AP ينقص", async () => {
    await openShift(1, 1); // shift-gate
    const r = await createVoucher(
      {
        voucherType: "PAYMENT",
        branchId: 1,
        amount: "25.00",
        paymentMethod: "CASH",
        partyType: "SUPPLIER",
        partyId: 1,
        description: "دفعة لمورّد",
      },
      actor,
    );
    expect(r.voucherNumber).toMatch(/^PV-1-/);
    expect(r.direction).toBe("OUT");

    const ent = await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "PAYMENT_OUT"));
    expect(ent).toHaveLength(1);
    expect(ent[0].amount).toBe("25.00");

    const sup = (await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0];
    expect(sup.currentBalance).toBe("25.00"); // 50 − 25
  });

  it("صرف لـOTHER (راتب موظف): receipt + قيد، لا تأثير على ذمم", async () => {
    await openShift(1, 1); // shift-gate
    const r = await createVoucher(
      {
        voucherType: "PAYMENT",
        branchId: 1,
        amount: "500.00",
        paymentMethod: "CASH",
        partyType: "OTHER",
        partyId: null,
        description: "راتب الموظف أحمد لشهر يونيو",
      },
      actor,
    );
    expect(r.voucherNumber).toMatch(/^PV-/);
    const sup = (await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0];
    expect(sup.currentBalance).toBe("50.00"); // لم يتغيّر
  });
});

describe("تسوية الصندوق — السند يُنسب للوردية المفتوحة", () => {
  it("سند نقدي ضمن الوردية يَدخل expectedCash، الـZ-report متوازن", async () => {
    const shiftId = await openShift(1, 1);
    await createVoucher(
      {
        voucherType: "RECEIPT",
        branchId: 1,
        amount: "100.00",
        paymentMethod: "CASH",
        partyType: "OTHER",
        partyId: null,
        description: "إيرادات",
      },
      actor,
    );
    await createVoucher(
      {
        voucherType: "PAYMENT",
        branchId: 1,
        amount: "30.00",
        paymentMethod: "CASH",
        partyType: "OTHER",
        partyId: null,
        description: "مصاريف نظافة",
      },
      actor,
    );
    const close = await closeShift({ shiftId, countedCash: "70.00" }, actor);
    expect(close.expectedCash).toBe("70.00");
    expect(close.variance).toBe("0.00");
  });
});

describe("تكرار/إجبار", () => {
  it("مبلغ صفر/سالب يُرفض", async () => {
    await expect(
      createVoucher(
        { voucherType: "RECEIPT", branchId: 1, amount: "0", paymentMethod: "CASH", partyType: "OTHER", description: "x" },
        actor,
      ),
    ).rejects.toThrow();
  });
  it("CUSTOMER بلا partyId يُرفض", async () => {
    await expect(
      createVoucher(
        { voucherType: "RECEIPT", branchId: 1, amount: "10", paymentMethod: "CASH", partyType: "CUSTOMER", description: "x" },
        actor,
      ),
    ).rejects.toThrow();
  });
  it("وصف فارغ يُرفض", async () => {
    await expect(
      createVoucher(
        { voucherType: "RECEIPT", branchId: 1, amount: "10", paymentMethod: "CASH", partyType: "OTHER", description: "  " },
        actor,
      ),
    ).rejects.toThrow();
  });
});

describe("listVouchers", () => {
  it("يُعيد السندات المستقلّة فقط (يَستثني receipts الفواتير)", async () => {
    await openShift(1, 1); // shift-gate: السندات النقدية تتطلّب وردية مفتوحة.
    await createVoucher(
      { voucherType: "RECEIPT", branchId: 1, amount: "10", paymentMethod: "CASH", partyType: "OTHER", description: "a" },
      actor,
    );
    await createVoucher(
      { voucherType: "PAYMENT", branchId: 1, amount: "5", paymentMethod: "CASH", partyType: "OTHER", description: "b" },
      actor,
    );
    // أضِف receipt مرتبط بفاتورة (بدون voucherNumber)
    await db().insert(s.invoices).values({
      invoiceNumber: "INV-TEST",
      sourceType: "POS",
      branchId: 1,
      subtotal: "10",
      total: "10",
    });
    const inv = (await db().select().from(s.invoices))[0];
    await db().insert(s.receipts).values({
      branchId: 1,
      invoiceId: Number(inv.id),
      direction: "IN",
      amount: "10",
      paymentMethod: "CASH",
      status: "COMPLETED",
    });

    const all = await listVouchers({});
    expect(all).toHaveLength(2);
    expect(all.every((v) => v.voucherNumber != null)).toBe(true);

    const receiptOnly = await listVouchers({ voucherType: "RECEIPT" });
    expect(receiptOnly).toHaveLength(1);
    const paymentOnly = await listVouchers({ voucherType: "PAYMENT" });
    expect(paymentOnly).toHaveLength(1);
  });
});

/**
 * shift-gate-cash slice: السندات النقدية تَمسّ صندوق الوردية ⇒ تتطلّب وردية مفتوحة وإلّا
 * تختفي من Z-report (computeExpectedCash يفلتر بـeq(receipts.shiftId, shiftId)).
 * السندات غير النقدية لا تَلمس الصندوق فتبقى مسموحة بـshiftId=null.
 */
describe("إنفاذ الوردية النقدية (shift-gate)", () => {
  it("سند نقدي للكاشير بلا وردية مفتوحة ⇒ يُرفض بـPRECONDITION_FAILED", async () => {
    // cash-treasury-mode: admin/manager مُعفَون ⇒ نَختبر cashier صراحةً للحارس الصارم.
    await db().insert(s.users).values({ id: 2, openId: "csh", name: "كاشير", role: "cashier", loginMethod: "local", branchId: 1 });
    await expect(
      createVoucher(
        {
          voucherType: "RECEIPT",
          branchId: 1,
          amount: "50.00",
          paymentMethod: "CASH",
          partyType: "OTHER",
          partyId: null,
          description: "إيرادات نقدية بدون وردية",
        },
        { userId: 2, branchId: 1, role: "cashier" },
      ),
    ).rejects.toThrow(/افتح وردية/);

    // لا receipt ولا قيد كُتب (rollback ذرّي).
    const recs = await db().select().from(s.receipts);
    expect(recs).toHaveLength(0);
    const ents = await db().select().from(s.accountingEntries);
    expect(ents).toHaveLength(0);
  });

  it("سند نقدي مع وردية مفتوحة ⇒ يُملأ shiftId تلقائياً", async () => {
    const shiftId = await openShift(1, 1);
    const r = await createVoucher(
      {
        voucherType: "RECEIPT",
        branchId: 1,
        amount: "100.00",
        paymentMethod: "CASH",
        partyType: "OTHER",
        partyId: null,
        description: "إيرادات نقدية",
      },
      actor,
    );
    const rc = (await db().select().from(s.receipts).where(eq(s.receipts.id, r.receiptId)))[0];
    expect(Number(rc.shiftId)).toBe(shiftId);
  });

  it("سند غير نقدي (تحويل) بلا وردية ⇒ يَنجح بـshiftId=null (لا يَلمس الصندوق)", async () => {
    const r = await createVoucher(
      {
        voucherType: "PAYMENT",
        branchId: 1,
        amount: "300.00",
        paymentMethod: "TRANSFER",
        partyType: "SUPPLIER",
        partyId: 1,
        description: "حوالة بنكية لمورّد",
        referenceNumber: "TRF-2026-001", // vouchers-pro: إلزامي لـTRANSFER
      },
      actor,
    );
    const rc = (await db().select().from(s.receipts).where(eq(s.receipts.id, r.receiptId)))[0];
    expect(rc.shiftId).toBeNull();
    expect(rc.paymentMethod).toBe("TRANSFER");
    // الدفتر سُجِّل: تحويل للمورد ⇒ AP ينقص
    const ent = await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "PAYMENT_OUT"));
    expect(ent).toHaveLength(1);
  });

  it("سند بطاقة بلا وردية ⇒ يَنجح بـshiftId=null + Z-report نقدي لا يتأثّر", async () => {
    // سند بطاقة بلا وردية مفتوحة (مشروع).
    await createVoucher(
      {
        voucherType: "RECEIPT",
        branchId: 1,
        amount: "1000.00",
        paymentMethod: "CARD",
        partyType: "CUSTOMER",
        partyId: 1,
        description: "دفعة بطاقة",
        cardLastFour: "1234", // vouchers-pro: إلزامي لـCARD
      },
      actor,
    );
    // افتح وردية ثم أضف سند نقدي ضمنها ⇒ تسوية الصندوق يجب أن تُظهر النقد فقط (100)، لا الـ1000 بطاقة.
    const shiftId = await openShift(1, 1);
    await createVoucher(
      {
        voucherType: "RECEIPT",
        branchId: 1,
        amount: "100.00",
        paymentMethod: "CASH",
        partyType: "OTHER",
        partyId: null,
        description: "إيرادات نقدية",
      },
      actor,
    );
    const close = await closeShift({ shiftId, countedCash: "100.00" }, { ...actor, role: "admin" });
    expect(close.expectedCash).toBe("100.00");
    expect(close.variance).toBe("0.00");
  });
});

/**
 * cash-treasury-mode (تدقيق ١٧/٦): إعفاء admin/manager من شرط الوردية النقدي.
 *  - admin بلا وردية ⇒ shiftId=null + cashBucket=TREASURY (مشروع، يَدخل تَسوية الخزينة).
 *  - cashier/warehouse بلا وردية ⇒ يُرفض (محفوظ).
 *  - غير النقدي ⇒ cashBucket=NULL.
 */
describe("إعفاء الخزينة الإدارية (admin/manager) للسندات", () => {
  it("admin RECEIPT نقدي بلا وردية ⇒ shiftId=null + cashBucket=TREASURY + قيد PAYMENT_IN", async () => {
    // actor = admin (افتراض seedBase)
    const r = await createVoucher(
      {
        voucherType: "RECEIPT",
        branchId: 1,
        amount: "75.00",
        paymentMethod: "CASH",
        partyType: "OTHER",
        partyId: null,
        description: "تَحصيل ميداني من تاجر",
      },
      actor,
    );
    const rc = (await db().select().from(s.receipts).where(eq(s.receipts.id, r.receiptId)))[0];
    expect(rc.shiftId).toBeNull();
    expect(rc.cashBucket).toBe("TREASURY");
    const ent = await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "PAYMENT_IN"));
    expect(ent).toHaveLength(1); // الدفتر يَكتب
  });

  it("admin PAYMENT نقدي بلا وردية ⇒ shiftId=null + cashBucket=TREASURY", async () => {
    const r = await createVoucher(
      {
        voucherType: "PAYMENT",
        branchId: 1,
        amount: "100.00",
        paymentMethod: "CASH",
        partyType: "OTHER",
        partyId: null,
        description: "راتب استثنائي",
      },
      actor,
    );
    const rc = (await db().select().from(s.receipts).where(eq(s.receipts.id, r.receiptId)))[0];
    expect(rc.shiftId).toBeNull();
    expect(rc.cashBucket).toBe("TREASURY");
  });

  it("warehouse نقدي بلا وردية ⇒ يُرفض (لا إعفاء)", async () => {
    await db().insert(s.users).values({ id: 3, openId: "wh", name: "مستودع", role: "warehouse", loginMethod: "local", branchId: 1 });
    await expect(
      createVoucher(
        {
          voucherType: "PAYMENT",
          branchId: 1,
          amount: "200.00",
          paymentMethod: "CASH",
          partyType: "OTHER",
          partyId: null,
          description: "شحنة",
        },
        { userId: 3, branchId: 1, role: "warehouse" },
      ),
    ).rejects.toThrow(/افتح وردية/);
  });

  it("سند CARD لـadmin يَكتب cashBucket=NULL (غير نقدي ⇒ لا دلوَ)", async () => {
    const r = await createVoucher(
      {
        voucherType: "RECEIPT",
        branchId: 1,
        amount: "1000.00",
        paymentMethod: "CARD",
        partyType: "CUSTOMER",
        partyId: 1,
        description: "دفعة بطاقة",
        cardLastFour: "5678", // vouchers-pro: إلزامي لـCARD
      },
      actor,
    );
    const rc = (await db().select().from(s.receipts).where(eq(s.receipts.id, r.receiptId)))[0];
    expect(rc.cashBucket).toBeNull();
  });
});
