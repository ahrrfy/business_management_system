// إلغاء سند قبض/صرف — المرآة الدقيقة لـcreateVoucher:
//   الأصل REVERSED + إيصال تعويضي معاكس على نفس الوردية + قيد PAYMENT_OUT/IN موجب (لا ADJUST)
//   + عكس رصيد الطرف. يُمنع على وردية مغلقة، ويُمنع الإلغاء المزدوج.
import { and, eq, isNull, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { money } from "../money";
import { reconcileSupplierBalances } from "../reconcileService";
import { closeShift } from "../shiftService";
import { cancelVoucher, createVoucher, listVouchers } from "../voucherService";

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
  // المورد برصيد افتتاحي 50 + قيد OPENING مطابق (كما يكتبه importService) ⇒ صيغة reconcile متّسقة.
  await d.insert(s.suppliers).values({ id: 1, name: "مورّد", currentBalance: "50.00" });
  await d.insert(s.accountingEntries).values({
    entryType: "OPENING",
    supplierId: 1,
    amount: "50.00",
    entryDate: new Date(),
    dedupeKey: "OPENING:SUPPLIER:1",
  });
}

async function openShift(branchId = 1, userId = 1): Promise<number> {
  const r = await db().insert(s.shifts).values({ branchId, userId, openingBalance: "0", status: "OPEN" });
  return insertId(r);
}

/** نقد الوردية المتوقّع = Σ receipts (CASH IN) − Σ receipts (CASH OUT) — يجمع الكل بغضّ النظر عن status. */
async function shiftCashNet(shiftId: number): Promise<string> {
  const rows = await db()
    .select({
      net: sql<string>`COALESCE(SUM(CASE
        WHEN ${s.receipts.direction} = 'IN'  AND ${s.receipts.paymentMethod} = 'CASH' THEN ${s.receipts.amount}
        WHEN ${s.receipts.direction} = 'OUT' AND ${s.receipts.paymentMethod} = 'CASH' THEN -${s.receipts.amount}
        ELSE 0 END), 0)`,
    })
    .from(s.receipts)
    .where(eq(s.receipts.shiftId, shiftId));
  return String(rows[0]?.net ?? "0");
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("إلغاء سند قبض من عميل (RV) — وردية مفتوحة", () => {
  it("الأصل REVERSED + تعويضي OUT على نفس الوردية + رصيد العميل يعود + قيد PAYMENT_OUT موجب + نقد الوردية يتصافر", async () => {
    const shiftId = await openShift();
    const cashBefore = await shiftCashNet(shiftId); // قبل السند

    const v = await createVoucher(
      { voucherType: "RECEIPT", branchId: 1, amount: "30.00", paymentMethod: "CASH", partyType: "CUSTOMER", partyId: 1, description: "دفعة من تاجر" },
      actor,
    );
    const afterCreate = (await db().select().from(s.customers).where(eq(s.customers.id, 1)))[0];
    expect(afterCreate.currentBalance).toBe("70.00"); // 100 − 30

    const res = await cancelVoucher(v.receiptId, actor);
    expect(res.status).toBe("REVERSED");
    expect(res.voucherNumber).toBe(v.voucherNumber);

    // الأصل صار REVERSED.
    const orig = (await db().select().from(s.receipts).where(eq(s.receipts.id, v.receiptId)))[0];
    expect(orig.status).toBe("REVERSED");

    // التعويضي: OUT، نفس الوردية والمبلغ والطريقة، بلا voucherNumber، مرجعه CANCEL-VCH.
    const comp = (
      await db().select().from(s.receipts).where(eq(s.receipts.referenceNumber, `CANCEL-VCH-${v.receiptId}`))
    )[0];
    expect(comp).toBeTruthy();
    expect(comp.direction).toBe("OUT");
    expect(Number(comp.shiftId)).toBe(shiftId);
    expect(comp.amount).toBe("30.00");
    expect(comp.paymentMethod).toBe("CASH");
    expect(comp.voucherNumber).toBeNull();
    expect(comp.status).toBe("COMPLETED");

    // رصيد العميل عاد تماماً (مقارنة Decimal).
    const cust = (await db().select().from(s.customers).where(eq(s.customers.id, 1)))[0];
    expect(money(cust.currentBalance).eq(money("100.00"))).toBe(true);

    // قيد PAYMENT_OUT موجب مربوط بالتعويضي وبالعميل (لا ADJUST).
    const outs = await db()
      .select()
      .from(s.accountingEntries)
      .where(and(eq(s.accountingEntries.entryType, "PAYMENT_OUT"), eq(s.accountingEntries.receiptId, Number(comp.id))));
    expect(outs).toHaveLength(1);
    expect(outs[0].amount).toBe("30.00");
    expect(Number(outs[0].customerId)).toBe(1);
    const adjusts = await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "ADJUST"));
    expect(adjusts).toHaveLength(0);

    // نقد الوردية عاد لقيمته قبل السند (IN 30 يقابله OUT 30).
    expect(money(await shiftCashNet(shiftId)).eq(money(cashBefore))).toBe(true);

    // listVouchers: السند الملغى يبقى ظاهراً بحالته، والتعويضي لا يظهر.
    const all = await listVouchers({});
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe("REVERSED");
    const reversedOnly = await listVouchers({ status: "REVERSED" });
    expect(reversedOnly).toHaveLength(1);
    const completedOnly = await listVouchers({ status: "COMPLETED" });
    expect(completedOnly).toHaveLength(0);
  });
});

describe("إلغاء سند صرف لمورّد (PV)", () => {
  it("رصيد المورد يعود + reconcileSupplierBalances بلا انحراف", async () => {
    await openShift(); // shift-gate-cash: السند النقدي يتطلّب وردية مفتوحة.
    const v = await createVoucher(
      { voucherType: "PAYMENT", branchId: 1, amount: "25.00", paymentMethod: "CASH", partyType: "SUPPLIER", partyId: 1, description: "دفعة لمورّد" },
      actor,
    );
    const afterCreate = (await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0];
    expect(afterCreate.currentBalance).toBe("25.00"); // 50 − 25

    await cancelVoucher(v.receiptId, actor);

    const sup = (await db().select().from(s.suppliers).where(eq(s.suppliers.id, 1)))[0];
    expect(money(sup.currentBalance).eq(money("50.00"))).toBe(true);

    // القيد المعاكس لإلغاء صرف = PAYMENT_IN موجب باسم المورد.
    const ins = await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "PAYMENT_IN"));
    expect(ins).toHaveLength(1);
    expect(ins[0].amount).toBe("25.00");
    expect(Number(ins[0].supplierId)).toBe(1);

    // الدفتر متّسق: OPENING(+50) + PAYMENT_OUT(−25) + PAYMENT_IN(+25) = 50 = actual ⇒ صفر انحراف.
    const drift = (await reconcileSupplierBalances()).filter((i) => i.id === 1);
    expect(drift).toHaveLength(0);
  });
});

describe("حواجز الإلغاء", () => {
  it("إلغاء مزدوج يُرفض BAD_REQUEST ولا يُنشئ تعويضياً ثانياً", async () => {
    await openShift(); // shift-gate-cash
    const v = await createVoucher(
      { voucherType: "RECEIPT", branchId: 1, amount: "10.00", paymentMethod: "CASH", partyType: "CUSTOMER", partyId: 1, description: "دفعة" },
      actor,
    );
    await cancelVoucher(v.receiptId, actor);
    await expect(cancelVoucher(v.receiptId, actor)).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // تعويضي واحد فقط، والرصيد لم يتحرّك مرة ثانية.
    const comps = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.referenceNumber, `CANCEL-VCH-${v.receiptId}`));
    expect(comps).toHaveLength(1);
    const cust = (await db().select().from(s.customers).where(eq(s.customers.id, 1)))[0];
    expect(money(cust.currentBalance).eq(money("100.00"))).toBe(true);
  });

  it("سند على وردية مغلقة يُرفض ولا يتغيّر شيء", async () => {
    const shiftId = await openShift();
    const v = await createVoucher(
      { voucherType: "RECEIPT", branchId: 1, amount: "40.00", paymentMethod: "CASH", partyType: "CUSTOMER", partyId: 1, description: "دفعة قبل الإغلاق" },
      actor,
    );
    await closeShift({ shiftId, countedCash: "40.00" }, actor);

    await expect(cancelVoucher(v.receiptId, actor)).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // لا شيء تغيّر: الأصل COMPLETED، الرصيد كما بعد السند، لا تعويضي ولا قيد عكسي.
    const orig = (await db().select().from(s.receipts).where(eq(s.receipts.id, v.receiptId)))[0];
    expect(orig.status).toBe("COMPLETED");
    const cust = (await db().select().from(s.customers).where(eq(s.customers.id, 1)))[0];
    expect(money(cust.currentBalance).eq(money("60.00"))).toBe(true); // 100 − 40
    const comps = await db()
      .select()
      .from(s.receipts)
      .where(eq(s.receipts.referenceNumber, `CANCEL-VCH-${v.receiptId}`));
    expect(comps).toHaveLength(0);
    const outs = await db().select().from(s.accountingEntries).where(eq(s.accountingEntries.entryType, "PAYMENT_OUT"));
    expect(outs).toHaveLength(0);
  });

  it("سند مستقل مربوط بفاتورة بيع (invoiceId) يُلغى بأمان — تدقيق ١٧/٧ (كان الحارس يمنع كلّ سندٍ مربوط)", async () => {
    await openShift();
    const invRes = await db().insert(s.invoices).values({
      invoiceNumber: "INV-VL", sourceType: "POS", sourceId: "t-vl", branchId: 1, customerId: 1,
      priceTier: "RETAIL", subtotal: "30.00", total: "30.00", costTotal: "0.00", paidAmount: "0.00",
      status: "PENDING", invoiceDate: new Date(),
    });
    const invoiceId = insertId(invRes);
    const v = await createVoucher(
      { voucherType: "RECEIPT", branchId: 1, amount: "30.00", paymentMethod: "CASH", partyType: "CUSTOMER", partyId: 1, invoiceId, description: "دفعة مربوطة بفاتورة" },
      actor,
    );
    // السند مربوط بالفاتورة توثيقياً فعلاً.
    const rv = (await db().select().from(s.receipts).where(eq(s.receipts.id, v.receiptId)))[0];
    expect(Number(rv.invoiceId)).toBe(invoiceId);

    // الإلغاء يمرّ الآن (الحارس القديم كان يرفض كلّ سندٍ يحمل invoiceId ⇒ يستحيل عكسه إطلاقاً).
    const res = await cancelVoucher(v.receiptId, actor);
    expect(res.status).toBe("REVERSED");
    const cust = (await db().select().from(s.customers).where(eq(s.customers.id, 1)))[0];
    expect(money(cust.currentBalance).eq(money("100.00"))).toBe(true); // عاد الرصيد كاملاً
  });

  it("إيصال غير سند (voucherNumber=null) يُرفض NOT_FOUND", async () => {
    const r = await db().insert(s.receipts).values({
      branchId: 1, direction: "IN", amount: "15.00", paymentMethod: "CASH", status: "COMPLETED",
    });
    const id = insertId(r);
    await expect(cancelVoucher(id, actor)).rejects.toMatchObject({ code: "NOT_FOUND" });
    // الإيصال لم يُمسّ.
    const row = (await db().select().from(s.receipts).where(eq(s.receipts.id, id)))[0];
    expect(row.status).toBe("COMPLETED");
    const comps = await db().select().from(s.receipts).where(isNull(s.receipts.referenceNumber));
    expect(comps).toHaveLength(1); // الإيصال نفسه فقط — لا تعويضي.
  });
});
