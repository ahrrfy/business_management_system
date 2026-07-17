/**
 * اختبارات إصلاحات تدقيق ١٧/٧ (المرحلة ١ — وقف النزيف). كل حالة تُثبّت حارساً ماليّاً/أمنيّاً جديداً:
 *  - قفل الفترة على السندات والمصروفات: منع القيد/الإلغاء بتاريخ رجعيّ داخل فترة مُقفَلة.
 *  - صمّام إهلاك الأصول: منع ترحيل شهرٍ مستقبليّ (كان يصرف كامل المتبقّي دفعةً).
 *  - أمر الشغل: رفض عربونٍ يتجاوز سعر البيع الإجمالي (كان يجعل الأمر غير قابل للتسليم).
 */
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../../../drizzle/schema";
import { getDb } from "../../db";
import { withTx } from "../tx";
import { createVoucher } from "../voucherService";
import { cancelVoucher } from "../voucher/cancel";
import { createExpense, cancelExpense } from "../expenseService";
import { lockPeriod } from "../periodLockService";
import { postMonthlyDepreciation } from "../assets/monthlyDepreciation";
import { createWorkOrder } from "../workOrder/create";

const admin = { userId: 1, branchId: 1, role: "admin" };
const admin2 = { userId: 2, branchId: 1, role: "admin" };

const TABLES = [
  "idempotencyKeys", "accountingEntries", "financialPeriods", "receipts", "expenseStockItems", "expenses",
  "inventoryMovements", "workOrderMaterials", "workOrders", "shifts", "customers", "suppliers", "branches", "users",
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
  await d.insert(s.users).values([
    { id: 1, openId: "admin", name: "admin", role: "admin", loginMethod: "local" },
    { id: 2, openId: "admin2", name: "admin2", role: "admin", loginMethod: "local" },
  ]);
  await d.insert(s.customers).values({ id: 1, name: "تاجر", defaultPriceTier: "RETAIL", currentBalance: "0.00" });
}

async function openShift(branchId = 1, userId = 1): Promise<number> {
  const r = await db().insert(s.shifts).values({ branchId, userId, openingBalance: "0", status: "OPEN" });
  return insertId(r);
}

async function lock(cutoffDate: string) {
  await withTx((tx) => lockPeriod(tx, { cutoffDate, lockedBy: 1 }));
}

beforeEach(async () => {
  await reset();
  await seedBase();
});

describe("قفل الفترة — السندات (تدقيق ١٧/٧)", () => {
  it("إنشاء سند بتاريخ رجعيّ داخل فترة مُقفَلة يُرفض FORBIDDEN", async () => {
    await openShift();
    await lock("2020-12-31");
    await expect(
      createVoucher(
        {
          voucherType: "RECEIPT", branchId: 1, amount: "30.00", paymentMethod: "CASH",
          partyType: "CUSTOMER", partyId: 1, description: "سند رجعيّ", voucherDate: "2020-06-01",
        },
        admin,
      ),
    ).rejects.toThrow(/مُقفَلة|الفترة/);
  });

  it("سند بتاريخ اليوم (فترة مفتوحة) يمرّ رغم قفلٍ قديم — الإصلاح موجَّه لا يكسر التشغيل", async () => {
    await openShift();
    await lock("2020-12-31");
    const r = await createVoucher(
      {
        voucherType: "RECEIPT", branchId: 1, amount: "30.00", paymentMethod: "CASH",
        partyType: "CUSTOMER", partyId: 1, description: "سند اليوم",
      },
      admin,
    );
    expect(r.receiptId).toBeGreaterThan(0);
  });

  it("إلغاء سند مؤرَّخ داخل فترة مُقفَلة يُرفض (لا يُغيّر أرقام الشهر المُقفَل بأثر رجعي)", async () => {
    await openShift();
    // أُنشئ قبل القفل (فترة مفتوحة) بتاريخ ٢٠٢٠، ثم أقفل، ثم حاول الإلغاء.
    const v = await createVoucher(
      {
        voucherType: "RECEIPT", branchId: 1, amount: "30.00", paymentMethod: "CASH",
        partyType: "CUSTOMER", partyId: 1, description: "سند ٢٠٢٠", voucherDate: "2020-06-01",
      },
      admin,
    );
    await lock("2020-12-31");
    // مُعتمِد مختلف (SOD) — كلاهما admin لتجاوز شرط الفرع.
    await expect(cancelVoucher(v.receiptId, admin2)).rejects.toThrow(/مُقفَلة|الفترة/);
  });
});

describe("قفل الفترة — المصروفات (تدقيق ١٧/٧)", () => {
  it("إلغاء مصروف مؤرَّخ داخل فترة مُقفَلة يُرفض", async () => {
    await openShift();
    const exp = await createExpense(
      {
        branchId: 1, category: "OTHER", amount: "20.00", paymentMethod: "CASH",
        description: "مصروف ٢٠٢٠", expenseDate: "2020-06-01",
      },
      admin,
    );
    await lock("2020-12-31");
    await expect(cancelExpense((exp as any).expenseId ?? (exp as any).id, admin2)).rejects.toThrow(/مُقفَلة|الفترة/);
  });
});

describe("إهلاك الأصول — صمّام الشهر المستقبليّ (تدقيق ١٧/٧)", () => {
  it("ترحيل إهلاك شهرٍ مستقبليّ بعيد يُرفض BAD_REQUEST", async () => {
    await expect(postMonthlyDepreciation(2999, 1, admin)).rejects.toThrow(/لم يبدأ بعد|الشهر الجاري/);
  });
});

describe("أمر الشغل — العربون لا يتجاوز سعر البيع (تدقيق ١٧/٧)", () => {
  it("عربون أكبر من سعر البيع الإجمالي يُرفض عند الإنشاء", async () => {
    await openShift();
    await expect(
      createWorkOrder(
        { branchId: 1, title: "طباعة", quantity: 1, salePrice: "100.00", deposit: "150.00", paymentMethod: "CASH" } as any,
        admin,
      ),
    ).rejects.toThrow(/العربون|سعر البيع/);
  });

  it("عربون ضمن سعر البيع يُقبل", async () => {
    await openShift();
    const r = await createWorkOrder(
      { branchId: 1, title: "طباعة", quantity: 1, salePrice: "100.00", deposit: "40.00", paymentMethod: "CASH" } as any,
      admin,
    );
    expect(r.workOrderId).toBeGreaterThan(0);
  });
});
