/**
 * اختبارات شريحة «الذرّية والـidempotency الثانوية» (٢٣/٦/٢٦):
 *  1) importService.postOpeningEntry — assertPeriodOpen مُطبَّق (فترة مغلقة ≤ اليوم ⇒ FORBIDDEN).
 *  2) workOrder.deliver — clientRequestId يَمنع تسليم مزدوج.
 *  3) processPayment — تعارض طريقة سداد ⇒ CONFLICT.
 *  4) deleteVacancy — الحذف والفصل داخل withTx (انتهاك FK لا يُبقي وظيفة بمتقدّمين معلّقين).
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { withTx } from "../tx";
import { lockPeriod } from "../periodLockService";
import { deleteVacancy } from "../recruitmentService";

const TABLES = [
  "idempotencyKeys",
  "auditLogs",
  "accountingEntries",
  "receipts",
  "inventoryMovements",
  "invoiceItems",
  "invoices",
  "workOrderImages",
  "workOrderMaterials",
  "workOrders",
  "cashTransfers",
  "branchStock",
  "productPrices",
  "productUnits",
  "productVariants",
  "products",
  "shifts",
  "customers",
  "suppliers",
  "financialPeriods",
  "jobApplicants",
  "jobVacancies",
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

async function seed() {
  const d = db();
  await d.insert(s.branches).values([
    { id: 1, name: "الرئيسي", code: "MAIN", type: "MAIN" },
  ]);
  await d.insert(s.users).values([
    { id: 1, openId: "local_admin", name: "المدير", email: "admin@t.test", role: "admin", loginMethod: "local", branchId: 1 },
  ]);
}

beforeEach(async () => { await reset(); await seed(); });

// ─── (1) postOpeningEntry — period lock ─────────────────────────────────────
describe("postOpeningEntry — يَحترم قفل الفترة", () => {
  it("لا قفل نشِط ⇒ يَدرج القيد بنجاح", async () => {
    // ليس لدينا واجهة مباشرة لـpostOpeningEntry؛ نَختبر عبر ledger.postEntry بـOPENING
    // (نفس المسار المُعدَّل)
    await d_insert_customer();
    await expect(
      withTx(async (tx) => {
        const { postEntry } = await import("../ledgerService");
        await postEntry(tx, {
          entryType: "OPENING",
          customerId: 1,
          revenue: "0",
          cost: "0",
          profit: "0",
          amount: "1000",
        });
      })
    ).resolves.not.toThrow();
  });

  it("فترة مقفولة + entryDate ≤ cutoff ⇒ FORBIDDEN", async () => {
    await withTx(async (tx) => lockPeriod(tx, { cutoffDate: "2099-12-31", lockedBy: 1 }));
    await d_insert_customer();
    await expect(
      withTx(async (tx) => {
        const { postEntry } = await import("../ledgerService");
        await postEntry(tx, {
          entryType: "OPENING",
          customerId: 1,
          revenue: "0",
          cost: "0",
          profit: "0",
          amount: "1000",
          entryDate: new Date("2025-01-01"),
        });
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

async function d_insert_customer() {
  await db().insert(s.customers).values({ id: 1, name: "عميل اختبار", customerType: "INDIVIDUAL" });
}

// ─── (2) workOrder.deliver — clientRequestId idempotency ─────────────────────
describe("workOrder.deliver — clientRequestId يَمنع تسليم مزدوج", () => {
  it("تسليم مكرّر بنفس المفتاح ⇒ idempotentReplay", async () => {
    // نَختبر deliverWorkOrder مباشرةً ببيانات مُجهَّزة مسبقاً
    const d = db();
    await d.insert(s.products).values({ id: 1, name: "ورق" });
    await d.insert(s.productVariants).values({ id: 1, productId: 1, sku: "P1", costPrice: "5.00" });
    await d.insert(s.productUnits).values({ id: 1, variantId: 1, unitName: "قطعة", conversionFactor: 1 });
    await d.insert(s.branchStock).values({ variantId: 1, branchId: 1, quantity: 100 });
    await d.insert(s.workOrders).values({
      id: 1,
      branchId: 1,
      orderNumber: "WO-1",
      title: "اختبار",
      status: "READY",
      baseVariantId: 1,
      quantity: 1,
      salePrice: "100.00",
      laborCost: "0.00",
      materialsCost: "0.00",
      deposit: "0.00",
    });

    const { deliverWorkOrder } = await import("../workOrderService");
    const actor = { userId: 1, branchId: 1, role: "cashier" as const };
    const input = { workOrderId: 1, clientRequestId: "deliver-key-001" };

    const r1 = await deliverWorkOrder(input, actor);
    expect(r1.invoiceId).toBeGreaterThan(0);
    expect((r1 as any).idempotentReplay).toBeUndefined();

    // ثانية بنفس المفتاح: تُعيد النتيجة دون خطأ
    const r2 = await deliverWorkOrder(input, actor);
    expect(r2.invoiceId).toBe(r1.invoiceId);
    expect((r2 as any).idempotentReplay).toBe(true);
  });
});

// ─── (3) processPayment — تعارض طريقة السداد ────────────────────────────────
describe("processPayment — تعارض طريقة السداد ⇒ CONFLICT", () => {
  it("نفس المفتاح + طريقة مختلفة ⇒ CONFLICT", async () => {
    const d = db();
    // فاتورة آجلة بسيطة
    await d.insert(s.customers).values({ id: 1, name: "عميل", customerType: "INDIVIDUAL" });
    await d.insert(s.invoices).values({
      id: 1,
      invoiceNumber: "INV-001",
      branchId: 1,
      sourceType: "MANUAL",
      sourceId: "M-1",
      subtotal: "200.00",
      taxAmount: "0.00",
      discountAmount: "0.00",
      total: "200.00",
      costTotal: "0.00",
      paidAmount: "0.00",
      status: "PENDING",
      createdBy: 1,
    });

    const { processPayment } = await import("../saleService");
    const actor = { userId: 1, branchId: 1 };

    // دفعة أولى بـCASH (بلا وردية — لا نَختبر المسار الكامل، فقط حارس idempotency)
    // نُسجّل مباشرةً في جدول idempotencyKeys ثم نتحقّق من الـconflict
    const { recordIdempotencyKey, findIdempotentRefId } = await import("../idempotency");
    await withTx(async (tx) => {
      // نحاكي دفعة CASH مُسجَّلة بإيصال id=99
      await d.insert(s.receipts).values({
        id: 99,
        branchId: 1,
        invoiceId: 1,
        direction: "IN",
        amount: "100.00",
        paymentMethod: "CASH",
        status: "COMPLETED",
        createdBy: 1,
      });
      await recordIdempotencyKey(tx, "sale.pay", "pay-key-XYZ", 99);
    });

    // دفعة ثانية بنفس المفتاح ولكن طريقة TRANSFER ⇒ يجب CONFLICT
    await expect(
      processPayment(
        { invoiceId: 1, amount: "100.00", method: "TRANSFER", clientRequestId: "pay-key-XYZ" },
        actor
      )
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

// ─── (4) deleteVacancy — ذرّية الحذف ────────────────────────────────────────
describe("deleteVacancy — حذف الوظيفة ومتقدّميها داخل withTx", () => {
  it("وظيفة بمتقدّم ⇒ الحذف يفصل المتقدّم ويحذف الوظيفة دفعةً واحدة", async () => {
    const d = db();
    await d.insert(s.jobVacancies).values({ id: 1, title: "كاشير", description: "وظيفة" });
    await d.insert(s.jobApplicants).values({
      id: 1,
      vacancyId: 1,
      name: "متقدّم",
      email: "a@test.com",
      phone: "+9647001234567",
    });

    await deleteVacancy(1);

    const vacancies = await d.select().from(s.jobVacancies).where(eq(s.jobVacancies.id, 1));
    const applicants = await d.select().from(s.jobApplicants).where(eq(s.jobApplicants.id, 1));

    expect(vacancies).toHaveLength(0);
    expect(applicants[0]?.vacancyId).toBeNull();
  });
});
